/**
 * Перенос истории путевых листов в рейсы (план `docs/vehicle-routes-plan.md`, §3.4).
 *
 * Здесь только правила выбора — без обращений к базе: их зовёт скрипт `backfill:routes` и
 * проверяет тест на фикстурах. Правила эти нельзя «примерно угадать»: один неверный выбор рвёт
 * либо уникальность талонов, либо связь заявки с бланком, который водитель уже возит с собой.
 */

/** Лист глазами переноса: этого хватает и для выбора канонического, и для разрешения конфликтов. */
export interface BackfillWaybill {
  id: string;
  vehicleId: string;
  issuedForDate: string;
  number: number;
  cancelled: boolean;
  /** Талоны листа: заявка и её позиция в бланке. */
  requests: { requestId: string; slot: number }[];
}

/** Ключ пары «машина + дата»: до маршрутов именно он и означал рейс. */
export function pairKey(w: { vehicleId: string; issuedForDate: string }): string {
  return `${w.vehicleId}|${w.issuedForDate}`;
}

/**
 * Канонический лист пары — тот, чей состав становится составом рейса.
 *
 * Действующий побеждает всегда: по нему машина вышла, и его талоны напечатаны на бумаге. Если
 * действующего нет, берётся последний аннулированный — по дате и номеру, а не «какой найдётся»:
 * состав рейса не должен зависеть от порядка строк в выборке.
 *
 * Состав неканонических листов в рейс не попадает: аннулированный лист с заявкой A на первом
 * талоне и действующий с заявкой B на первом дали бы в одном рейсе две первые позиции — и
 * уникальность талонов упала бы даже на составе из двух заявок.
 */
export function pickCanonicalWaybill<T extends BackfillWaybill>(waybills: readonly T[]): T | null {
  if (waybills.length === 0) return null;
  const active = waybills.filter((w) => !w.cancelled);
  const pool = active.length > 0 ? active : waybills;
  return [...pool].sort(byDateAndNumberDesc)[0]!;
}

function byDateAndNumberDesc(a: BackfillWaybill, b: BackfillWaybill): number {
  if (a.issuedForDate !== b.issuedForDate) return a.issuedForDate < b.issuedForDate ? 1 : -1;
  return b.number - a.number;
}

export interface PlannedRoute {
  /** Ключ пары, на которую заводится рейс. */
  key: string;
  vehicleId: string;
  routeDate: string;
  /** Лист, из которого берутся водитель, реквизиты выезда и состав. */
  canonical: BackfillWaybill;
  /** Все листы пары: каждому проставляется `route_id` — документ остаётся при своём рейсе. */
  waybillIds: string[];
  /** Состав рейса в порядке талонов, уже уплотнённый в 1…N. */
  requests: { requestId: string; position: number }[];
}

export interface BackfillPlan {
  routes: PlannedRoute[];
  /**
   * Заявки, которые попали в канонические листы разных пар: в рейс их кладёт только один, из
   * остальных они выбывают — связь там остаётся историей в `waybill_requests`.
   */
  droppedLinks: { requestId: string; keptIn: string; droppedFrom: string[] }[];
  /** Состав канонического листа сверх четырёх талонов: в бланке их столько не бывает. */
  overflow: { key: string; requestIds: string[] }[];
}

const MAX_SLOTS = 4;

/**
 * План переноса: какие рейсы завести, с каким составом и что из состава выпало.
 *
 * `alreadyPlaced` — заявки, уже стоящие в рейсах нового API: их перенос не трогает вовсе.
 * Скрипт работает на живой базе после релиза 1, и заявка, которую диспетчер только что положил
 * в свежий рейс, не должна переезжать в рейс, восстановленный из старого бланка.
 */
export function planBackfill(
  waybills: readonly BackfillWaybill[],
  alreadyPlaced: ReadonlySet<string> = new Set(),
): BackfillPlan {
  const byPair = new Map<string, BackfillWaybill[]>();
  for (const w of waybills) {
    const key = pairKey(w);
    byPair.set(key, [...(byPair.get(key) ?? []), w]);
  }

  // Кто выигрывает заявку, если она стоит в канонических листах разных пар. Статус решает раньше
  // даты: более свежий аннулированный бланк не должен отбирать заявку у рейса, по которому
  // машина вышла и чей лист водитель везёт с собой.
  const owner = new Map<string, { key: string; waybill: BackfillWaybill }>();
  const contenders = new Map<string, string[]>();
  const canonicals: { key: string; canonical: BackfillWaybill; all: BackfillWaybill[] }[] = [];

  for (const [key, list] of byPair) {
    const canonical = pickCanonicalWaybill(list);
    if (!canonical) continue;
    canonicals.push({ key, canonical, all: list });
    for (const link of canonical.requests) {
      if (alreadyPlaced.has(link.requestId)) continue;
      const previous = owner.get(link.requestId);
      if (!previous) {
        owner.set(link.requestId, { key, waybill: canonical });
        continue;
      }
      const winner = betterOwner(previous.waybill, canonical) === canonical ? key : previous.key;
      const loser = winner === key ? previous.key : key;
      owner.set(link.requestId, {
        key: winner,
        waybill: winner === key ? canonical : previous.waybill,
      });
      contenders.set(link.requestId, [...(contenders.get(link.requestId) ?? []), loser]);
    }
  }

  const routes: PlannedRoute[] = [];
  const overflow: BackfillPlan['overflow'] = [];

  for (const { key, canonical, all } of canonicals) {
    // Уплотнение в 1…N: заявка могла выбыть (конфликт пар или новый рейс), а `slot` легаси-листа
    // мог начинаться не с единицы — дыра в талонах означала бы пустую графу в бланке.
    const kept = [...canonical.requests]
      .sort((a, b) => a.slot - b.slot)
      .filter((link) => owner.get(link.requestId)?.key === key);
    const fit = kept.slice(0, MAX_SLOTS);
    if (kept.length > fit.length) {
      overflow.push({ key, requestIds: kept.slice(MAX_SLOTS).map((l) => l.requestId) });
      for (const extra of kept.slice(MAX_SLOTS)) owner.delete(extra.requestId);
    }
    routes.push({
      key,
      vehicleId: canonical.vehicleId,
      routeDate: canonical.issuedForDate,
      canonical,
      waybillIds: all.map((w) => w.id),
      requests: fit.map((link, index) => ({ requestId: link.requestId, position: index + 1 })),
    });
  }

  const droppedLinks = [...contenders.entries()].map(([requestId, from]) => ({
    requestId,
    keptIn: owner.get(requestId)?.key ?? '',
    droppedFrom: from,
  }));

  return { routes, droppedLinks, overflow };
}

/** Из двух канонических листов заявку забирает действующий, а при равенстве — более поздний. */
function betterOwner(a: BackfillWaybill, b: BackfillWaybill): BackfillWaybill {
  if (a.cancelled !== b.cancelled) return a.cancelled ? b : a;
  return byDateAndNumberDesc(a, b) <= 0 ? a : b;
}
