import {
  MAX_ANALYTICS_PERIOD_DAYS,
  MAX_ANALYTICS_STEPS,
  type AnalyticsQualityEntry,
  type AnalyticsStep,
  type AnalyticsSummaryDto,
  type AnalyticsSummaryQuery,
} from '@technic/contracts';
import { err } from '../../lib/errors';
import { loadMechFacts } from './facts-mech';
import { loadVehicleFacts } from './facts-vehicle';
import { loadWasteFacts } from './facts-waste';
import { periodCount, splitPeriods } from './periods';
import { moneyOf, rollupByCustomer, rollupByPeriod, totalsByModule } from './rollup';
import { ANALYTICS_ATOM_LIMIT, type AnalyticsAtom, type AnalyticsRange } from './types';

/**
 * Сборка свода из атомов трёх модулей (план `docs/analytics-summary-export-plan.md`, Р13, Р14).
 *
 * Слой переживёт книгу: тем же `loadAnalyticsAtoms` собирается и лист книги, и ответ ручки
 * `GET /analytics/summary`, и будущий экран аналитики. Второго места, где атомы грузятся своим
 * порядком, быть не должно — иначе книга и экран начнут отвечать по-разному на «сколько вывезли
 * за август», а заметить это можно будет только сличив два файла глазами.
 *
 * Здесь же стоят все три потолка — период, шаги и атомы, — и стоят они **до** сборки листов
 * (Р15): отказ после десяти секунд работы над книгой, которую всё равно не отдадут, — худший из
 * возможных ответов.
 */

/** Дней в периоде включительно: 1–1 это один день, а не ноль. */
function periodDays(range: AnalyticsRange): number {
  const ms = Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`);
  return ms / 86_400_000 + 1;
}

/**
 * Потолки периода и шага — теми же числами, которыми их проверяет форма (Р12).
 *
 * Проверка стоит ДО обращения в базу: запрос «с 2000 года по неделям» обязан упереться в отказ, а
 * не в три выборки по всей жизни портала. Числа берутся из контрактов, а не повторяются здесь:
 * разойдясь, форма гасила бы кнопку не на том сочетании, на котором сервер отвечает отказом.
 */
export function assertAnalyticsQuery(range: AnalyticsRange, step: AnalyticsStep): void {
  if (periodDays(range) > MAX_ANALYTICS_PERIOD_DAYS) {
    throw err.badRequest('Период больше года: выберите отрезок покороче', {
      to: 'Не больше года от начала периода',
    });
  }
  const steps = periodCount(range, step);
  if (steps > MAX_ANALYTICS_STEPS) {
    throw err.badRequest(
      `Шагов в периоде ${steps}, предел — ${MAX_ANALYTICS_STEPS}: выберите шаг покрупнее`,
      { step: 'Шаг слишком мелкий для такого периода' },
    );
  }
}

/**
 * Атомы всех модулей за период и строки листа «Качество данных» (Р15).
 *
 * Три запроса, не тридцать: по одному на модуль, все условия внутри, никаких запросов в цикле по
 * объектам. Идут они разом (`Promise.all`) — модули друг о друге ничего не знают, и очередь из
 * трёх выборок удлинила бы ответ втрое без единой причины.
 *
 * Качество склеивается **в порядке модулей** (перевозки и работа на объекте, вывоз, механизация),
 * а не в порядке, в котором ответили запросы: лист книги читают сверху вниз, и строки в нём не
 * должны переставляться от того, какая выборка сегодня оказалась быстрее.
 */
export async function loadAnalyticsAtoms(
  range: AnalyticsRange,
): Promise<{ atoms: AnalyticsAtom[]; quality: AnalyticsQualityEntry[] }> {
  const [vehicle, waste, mech] = await Promise.all([
    loadVehicleFacts(range),
    loadWasteFacts(range),
    loadMechFacts(range),
  ]);
  const atoms = [...vehicle.atoms, ...waste.atoms, ...mech.atoms];
  /*
   * Предел атомов (Р15) — здесь, а не в сборщике книги: слой один на книгу и на ручку, и потолок,
   * положенный в книгу, оставил бы ручку без него. Считается он по уже загруженному набору, потому
   * что счётный запрос был бы вторым правилом «что попадает в свод»: разойдись он с выборкой —
   * отказ приходил бы не на том периоде, на котором собирается тяжёлый ответ.
   */
  if (atoms.length > ANALYTICS_ATOM_LIMIT) {
    throw err.badRequest(
      `В выгрузку попадает ${atoms.length} строк, предел — ${ANALYTICS_ATOM_LIMIT}: сузьте период`,
      { to: 'Сузьте период' },
    );
  }
  return { atoms, quality: [...vehicle.quality, ...waste.quality, ...mech.quality] };
}

/**
 * Свод целиком: строки заказчиков, итог, деньги, качество и динамика по шагам.
 *
 * Итог считается `totalsByModule` по **всему** набору атомов, а не сложением уже собранных строк
 * (Р13): сложение строк — второй путь к тому же числу, и расхождение на нём не ловится ничем.
 * По той же причине динамика собирается из тех же атомов: суммы листов «Свод» и «Инфографика»
 * обязаны сходиться до копейки, потому что это один и тот же набор строк.
 */
export async function buildAnalyticsSummary(
  query: AnalyticsSummaryQuery,
): Promise<AnalyticsSummaryDto> {
  const range: AnalyticsRange = { from: query.from, to: query.to };
  assertAnalyticsQuery(range, query.step);

  const { atoms, quality } = await loadAnalyticsAtoms(range);
  const periods = splitPeriods(range, query.step);

  return {
    from: query.from,
    to: query.to,
    step: query.step,
    periods,
    rows: rollupByCustomer(atoms),
    totals: totalsByModule(atoms),
    money: moneyOf(atoms),
    quality,
    // Строка на каждый отрезок, включая пустой: потолок шагов проверен выше, и молчаливо пустой
    // динамики (контракт допускает её при переполнении) отсюда не выходит никогда.
    periodRows: rollupByPeriod(atoms, periods, query.step),
  };
}
