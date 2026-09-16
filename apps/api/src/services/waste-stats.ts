import {
  monthRange,
  REQUEST_TYPES,
  type RequestType,
  roleScopeAxis,
  roleScopeAxisLabels,
  placeObjectScopeIds,
  wasteFactUnit,
  type WasteStatsFigures,
  type WasteStatsDto,
  type WasteStatsPositionDto,
  type WasteStatsRowDto,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from '../lib/errors';
import { loadWasteFacts } from './analytics/facts-waste';
import { ANALYTICS_ATOM_LIMIT, type AnalyticsAtom } from './analytics/types';

/**
 * Статистика вывоза мусора за отчётный месяц (план `docs/waste-stats-tab-plan.md`).
 *
 * СВОИХ ЧИСЕЛ ЗДЕСЬ НЕТ (Р1). Слой берёт атомы `loadWasteFacts` — те же, из которых собирается
 * книга Excel, — и только группирует их по площадке и виду отходов. Собственный `SELECT sum(...)`
 * «специально для вкладки» завёл бы второй ответ на «сколько вывезли за август»: день отнесения,
 * правило факта и правило денег разошлись бы с книгой молча, а заметить это можно было бы только
 * сличив два экрана глазами. Сторож этого решения — тест сверки вкладки со сводом книги.
 *
 * Разница со сводом ровно в трёх вещах, и каждая — решение постановки:
 *
 * 1. **Область обычная, площадочная** (Р7): свод отказывает узкой области целиком, а вкладка живёт
 *    внутри модуля, и площадка видит в ней свои объекты. Роли от контрагента и кабинету работника
 *    вкладка не открывается вовсе — см. `assertWasteStatsAudience`.
 * 2. **Только вывоз мусора кубами** (Р6): лом (тонны, денег нет вовсе) и контейнерные операции (не
 *    тарифицируются) не попадают в выборку, а не отсеиваются после неё.
 * 3. **Объём и деньги складывают состоявшееся с заказанным** (Р3): у свода это разные колонки, у
 *    вкладки — одна с подписанной долей. Складывает их эта функция, и потому обе доли остаются в
 *    ответе отдельными полями: число, у которого нельзя спросить «сколько здесь ещё не вывезено»,
 *    предъявить площадке нечем.
 */

/**
 * Типы заявок вкладки: те, чей факт меряется кубами. Спрашивается контракт, а не переписывается
 * список — появившийся завтра объёмный тип иначе пришлось бы вспоминать и здесь, и в `wasteFactUnit`.
 */
const VOLUME_REQUEST_TYPES: RequestType[] = REQUEST_TYPES.filter(
  (t) => wasteFactUnit(t) === 'volume_m3',
);

/**
 * Кому вкладка не отвечает вовсе (Р7).
 *
 * Исполнителю вывоза право `wasteRequests.read` выдано (`COUNTERPARTY_TYPE_PERMISSIONS`), и без
 * этой проверки он получил бы таблицу «площадка → объём → стоимость», собранную из своих заявок:
 * свод чужих площадок по своим рейсам — не его сведения, а о деньгах с ним говорят актами, а не
 * экраном портала. Кабинет работника закрыт той же строкой и по той же причине.
 *
 * Спрашивается ОСЬ роли, а не имя роли и не тип контрагента: осей области в портале четыре, и
 * перечисление их по одной означало бы забыть очередную при её появлении.
 */
export function assertWasteStatsAudience(p: Principal): void {
  const axis = roleScopeAxis(p.role);
  if (axis !== 'counterparty' && axis !== 'person') return;
  throw err.forbidden(
    `Статистика сводит площадки; у вашей учётки область ограничена (${roleScopeAxisLabels[axis]})`,
  );
}

/** Накопитель клетки: складывается всё, что складывается, остальное — множества заявок. */
interface Acc {
  volumeFact: number;
  volumeOrdered: number;
  moneyFact: number;
  moneyEstimate: number;
  confirmedVolume: number;
  confirmedUnpriced: number;
  moneyConfirmed: number;
  ticketsWithoutVolume: number;
  removals: number;
  requests: Set<string>;
  unpriced: Set<string>;
}

function emptyAcc(): Acc {
  return {
    volumeFact: 0,
    volumeOrdered: 0,
    moneyFact: 0,
    moneyEstimate: 0,
    confirmedVolume: 0,
    confirmedUnpriced: 0,
    moneyConfirmed: 0,
    ticketsWithoutVolume: 0,
    removals: 0,
    requests: new Set(),
    unpriced: new Set(),
  };
}

function add(acc: Acc, atom: AnalyticsAtom): void {
  acc.volumeFact += atom.volumeM3;
  acc.volumeOrdered += atom.volumeOrderedM3;
  acc.moneyFact += atom.moneyFact;
  // Оценка у вывоза одна, нижняя и верхняя совпадают (Р9 аналитики) — берём одну сторону вилки.
  acc.moneyEstimate += atom.moneyLow;
  acc.confirmedVolume += atom.volumeConfirmedM3;
  acc.confirmedUnpriced += atom.volumeConfirmedUnpricedM3;
  acc.moneyConfirmed += atom.moneyConfirmed;
  acc.ticketsWithoutVolume += atom.ticketsWithoutVolume;
  acc.removals += atom.removals;
  acc.requests.add(atom.requestId);
  /*
   * «Без цены» считается ПО ЗАЯВКАМ, а не по атомам: у вывоза атом на заявку один, но правило
   * повторяет счётчик книги намеренно — разойдись зерно атома завтра, вкладка не начала бы
   * объявлять одну неоценённую заявку десятью.
   */
  if (!atom.priced) acc.unpriced.add(atom.requestId);
}

/**
 * Округление **один раз, в конце** (правило `rollup.ts`): слагаемые не округляются, иначе копейка,
 * потерянная на каждой заявке, уводит итог площадки, и сумма позиций перестаёт сходиться со
 * строкой.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function figuresOf(acc: Acc): WasteStatsFigures {
  const confirmedVolumeM3 = round(acc.confirmedVolume, 3);
  const confirmedVolumeUnpricedM3 = round(acc.confirmedUnpriced, 3);
  const moneyConfirmed = round(acc.moneyConfirmed, 2);
  return {
    // Вывезенное и заказанное одним числом (Р3), доля — соседним полем.
    volumeM3: round(acc.volumeFact + acc.volumeOrdered, 3),
    volumeOrderedM3: round(acc.volumeOrdered, 3),
    totalCost: round(acc.moneyFact + acc.moneyEstimate, 2),
    costEstimated: round(acc.moneyEstimate, 2),
    confirmedVolumeM3,
    confirmedVolumeUnpricedM3,
    /*
     * ПРОЧЕРК, А НЕ НОЛЬ (Р5) — и спрашивается он у ОБЪЁМА, а не у денег. Ноль в деньгах означает
     * разом два разных случая: «цены не было» и «подтверждать было нечего», а после сложения
     * атомов они уже неразличимы. Поэтому правило читается по двум числам:
     *
     * - подтверждать нечего — ноль, клетка пуста и честна;
     * - весь подтверждённый объём без цены — прочерк: умножать не на что;
     * - часть без цены — ЧИСЛО, а рядом подпись «без цены 12,5 м³»: сумма занижена, и молчать об
     *   этом нельзя, заниженная стоимость без пометки выглядит посчитанной.
     */
    confirmedCost:
      confirmedVolumeM3 > 0 && confirmedVolumeUnpricedM3 === confirmedVolumeM3
        ? null
        : moneyConfirmed,
    ticketsWithoutVolume: acc.ticketsWithoutVolume,
    unpricedRequests: acc.unpriced.size,
    removals: acc.removals,
    requests: acc.requests.size,
  };
}

/** Порядок строк и позиций — как во всех перечнях портала: по-русски, с числами по-человечески. */
const COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export async function loadWasteStats(p: Principal, month: string): Promise<WasteStatsDto> {
  const range = monthRange(month);
  const { atoms, quality } = await loadWasteFacts(range, {
    // `null` — ограничения нет; пустой список — видимых объектов нет вовсе, и ответ пуст.
    objectIds: placeObjectScopeIds(p),
    requestTypes: VOLUME_REQUEST_TYPES,
  });

  /*
   * ПОТОЛОК АТОМОВ (Р15 аналитики) — здесь, а не в загрузчике: он стоит в `loadAnalyticsAtoms`,
   * которую вкладка не зовёт, и без этой строки единственная ручка слоя осталась бы без предела.
   * Месяц вывоза в него не упирается ни на одной сегодняшней площадке — ставится он ровно поэтому:
   * предел, который никого не задевает, и обязан стоять до того, как задел.
   */
  if (atoms.length > ANALYTICS_ATOM_LIMIT) {
    throw err.badRequest(
      `В статистику попадает ${atoms.length} строк, предел — ${ANALYTICS_ATOM_LIMIT}: выберите месяц с меньшим числом заявок`,
      { month: 'Слишком много заявок за месяц' },
    );
  }

  const rows = new Map<string, { atom: AnalyticsAtom; acc: Acc; positions: Map<string, Acc> }>();
  const totals = emptyAcc();
  for (const atom of atoms) {
    add(totals, atom);
    let row = rows.get(atom.customerId);
    if (!row) {
      row = { atom, acc: emptyAcc(), positions: new Map() };
      rows.set(atom.customerId, row);
    }
    add(row.acc, atom);
    let position = row.positions.get(atom.positionKey);
    if (!position) {
      position = emptyAcc();
      row.positions.set(atom.positionKey, position);
    }
    add(position, atom);
  }

  const positionLabels = new Map<string, string>();
  for (const atom of atoms) positionLabels.set(atom.positionKey, atom.positionLabel);

  const items: WasteStatsRowDto[] = [...rows.values()]
    .map(({ atom, acc, positions }) => ({
      objectId: atom.customerId,
      code: atom.customerCode,
      name: atom.customerName,
      isActive: atom.customerIsActive,
      ...figuresOf(acc),
      positions: [...positions.entries()]
        .map(([key, cell]): WasteStatsPositionDto => ({
          key,
          label: positionLabels.get(key) ?? key,
          ...figuresOf(cell),
        }))
        .sort((a, b) => COLLATOR.compare(a.label, b.label)),
    }))
    .sort((a, b) => COLLATOR.compare(a.code, b.code));

  return {
    month,
    from: range.from,
    to: range.to,
    rows: items,
    /*
     * Итог собран из ТЕХ ЖЕ атомов, а не сложением уже собранных строк: сложение строк — второй
     * путь к тому же числу, и расхождение на нём не ловится ничем (правило `rollup.ts`).
     */
    totals: figuresOf(totals),
    quality,
  };
}
