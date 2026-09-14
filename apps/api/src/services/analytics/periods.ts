import type { AnalyticsPeriodRef, AnalyticsStep } from '@technic/contracts';
import type { AnalyticsRange } from './types';

/**
 * Нарезка периода на отрезки шага (план `docs/analytics-summary-export-plan.md`, Р12).
 *
 * Здесь живёт **единственное** правило «в каком отрезке лежит день»: `periodKeyOf` отвечает на
 * него для группировки атомов, а `splitPeriods` — для оси листа «Инфографика», и вторая функция
 * спрашивает первую. Два правила разошлись бы на границах (последняя неделя декабря, день перед
 * концом квартала), и тогда сумма по строкам динамики перестала бы сходиться со сводом, который
 * считан из того же набора атомов (Р13).
 *
 * День всюду календарный московский `YYYY-MM-DD` без времени — как во всём портале. Считаем на
 * `Date` в UTC: смещение в вычислениях не участвует, часы не переводятся, и сутки остаются
 * сутками.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Римские номера кварталов и полугодий: «III кв.» — общепринятая подпись, «3 кв.» — нет. */
const ROMAN = ['I', 'II', 'III', 'IV'] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function utcOf(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Дата плюс дни календарём, без часовых поясов. */
function addDays(dateOnly: string, days: number): string {
  return dayOf(new Date(utcOf(dateOnly).getTime() + days * DAY_MS));
}

/** Номер дня недели от понедельника: 0 — понедельник, 6 — воскресенье. */
function weekdayIndex(dateOnly: string): number {
  return (utcOf(dateOnly).getUTCDay() + 6) % 7;
}

/**
 * ISO-неделя дня: год недели и её номер.
 *
 * Год берётся у **четверга** этой недели, а не у самого дня: неделя принадлежит тому году, в
 * котором лежит её четверг. Иначе 31.12.2026 (четверг) и 01.01.2027 (пятница) оказались бы в
 * разных неделях, хотя это одна и та же неделя `2026-W53`, а 01.01 какого-нибудь года попадал бы
 * в «неделю 1» своего года, будучи концом 52-й недели предыдущего.
 */
function isoWeek(dateOnly: string): { year: number; week: number } {
  const thursday = new Date(utcOf(dateOnly).getTime() + (3 - weekdayIndex(dateOnly)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  return { year, week: Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1 };
}

function monthStart(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`;
}

/** Последний день месяца: нулевой день следующего и есть он, високосный год считается сам. */
function monthEnd(year: number, month: number): string {
  return dayOf(new Date(Date.UTC(year, month, 0)));
}

/**
 * Ключ отрезка, в котором лежит день. По нему группируются атомы, и он же стоит в
 * `AnalyticsPeriodRef.key` — сопоставление строк динамики с атомами идёт сравнением ключей, а не
 * попаданием даты в границы: границы крайних отрезков обрезаны периодом, и день, обрезанием
 * выпавший наружу, потерял бы свою строку.
 */
export function periodKeyOf(date: string, step: AnalyticsStep): string {
  const [year, month] = date.split('-').map(Number);
  const y = year ?? 0;
  const m = month ?? 1;
  switch (step) {
    case 'week': {
      const iso = isoWeek(date);
      return `${iso.year}-W${pad2(iso.week)}`;
    }
    case 'month':
      return `${y}-${pad2(m)}`;
    case 'quarter':
      return `${y}-Q${Math.ceil(m / 3)}`;
    case 'half':
      return `${y}-H${m <= 6 ? 1 : 2}`;
    case 'year':
      return String(y);
  }
}

/** «03.08» — день и месяц для подписи недели; год в ней стоит один раз, в ключе. */
function dayMonth(dateOnly: string): string {
  const [, month, day] = dateOnly.split('-');
  return `${day}.${month}`;
}

/** Календарные границы и подпись отрезка, в котором лежит день. Периодом запроса ещё не обрезаны. */
function segmentOf(date: string, step: AnalyticsStep): AnalyticsPeriodRef {
  const key = periodKeyOf(date, step);
  const [year, month] = date.split('-').map(Number);
  const y = year ?? 0;
  const m = month ?? 1;
  switch (step) {
    case 'week': {
      const from = addDays(date, -weekdayIndex(date));
      const to = addDays(from, 6);
      const iso = isoWeek(date);
      // Год стоит рядом с номером, а не в конце подписи: период до 366 дней законно пересекает
      // Новый год, и две «нед. 1» в колонках инфографики различались бы только ключом, которого
      // читатель не видит. Ось категорий графика читает эту же строку — там места ещё меньше.
      return {
        key,
        label: `нед. ${iso.week} · ${iso.year} (${dayMonth(from)} – ${dayMonth(to)})`,
        from,
        to,
      };
    }
    case 'month':
      return { key, label: `${pad2(m)}.${y}`, from: monthStart(y, m), to: monthEnd(y, m) };
    case 'quarter': {
      const quarter = Math.ceil(m / 3);
      return {
        key,
        label: `${ROMAN[quarter - 1]} кв. ${y}`,
        from: monthStart(y, quarter * 3 - 2),
        to: monthEnd(y, quarter * 3),
      };
    }
    case 'half': {
      const half = m <= 6 ? 1 : 2;
      return {
        key,
        label: `${ROMAN[half - 1]} полугодие ${y}`,
        from: monthStart(y, half * 6 - 5),
        to: monthEnd(y, half * 6),
      };
    }
    case 'year':
      return { key, label: String(y), from: monthStart(y, 1), to: monthEnd(y, 12) };
  }
}

/**
 * Отрезки шага внутри периода, по порядку.
 *
 * Крайние отрезки обрезаются границами периода — иначе отбор по ним захватил бы дни за пределами
 * запроса, — но `key` и `label` остаются **календарными**: половина недели, подписанная «нед. 32
 * (03.08 – 09.08)», честно говорит читателю, что это неполная неделя, а подпись «нед. 32 (05.08 –
 * 09.08)» выглядела бы полной неделей с непонятно чьими границами.
 */
export function splitPeriods(range: AnalyticsRange, step: AnalyticsStep): AnalyticsPeriodRef[] {
  if (range.to < range.from) return [];
  const periods: AnalyticsPeriodRef[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    const segment = segmentOf(cursor, step);
    periods.push({
      key: segment.key,
      label: segment.label,
      from: segment.from < range.from ? range.from : segment.from,
      to: segment.to > range.to ? range.to : segment.to,
    });
    cursor = addDays(segment.to, 1);
  }
  return periods;
}

/**
 * Сколько отрезков даст период — число для формы и для потолка `MAX_ANALYTICS_STEPS`.
 *
 * Считается той же нарезкой, а не формулой по номерам месяцев: формула разошлась бы с нарезкой на
 * неделях (год по ISO-неделям бывает и 52, и 53), и форма гасила бы кнопку не на том сочетании, на
 * котором сервер отвечает отказом.
 */
export function periodCount(range: AnalyticsRange, step: AnalyticsStep): number {
  return splitPeriods(range, step).length;
}
