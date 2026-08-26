import { eq, inArray } from 'drizzle-orm';
import type { db } from '../db/client';
import { vehicleTrailers, vehicles } from '../db/schema';
import { err } from '../lib/errors';

/**
 * Привязка прицепа к тягачу: порядок блокировок, общий на всех, кто её ставит или снимает
 * (план `docs/vehicle-trailers-plan.md`, §4.2.1, §4.2.3).
 *
 * ПОЧЕМУ ЭТО СЕРВИС, А НЕ ЧАСТЬ `routes/vehicle-trailers.ts`. Привязку меняют ручки **трёх**
 * модулей: команды прицепа (`hitch`, `unhitch`, удаление, списание), смена состояния машины
 * (списание, мягкое удаление, перевод машины на тип «формы № 3» — `routes/vehicles.ts`) и смена
 * бланка у самого типа (`routes/vehicle-types.ts` — четвёртая дверь §4.2.3). Строки они
 * трогают одни и те же — тягача в `vehicles` и прицепа в `vehicle_trailers`, — и всякий второй
 * порядок захвата на этой паре даёт ровно ту взаимоблокировку, ради которой порядок и объявлен:
 * встречная пара «списываю машину / переставляю прицеп» встанет насмерть на первом же совпадении.
 * Поэтому порядок живёт **одним объявлением**, а не копией в каждом модуле: копия расходится с
 * оригиналом молча и проявляется пятисоткой на кнопке раз в несколько недель.
 *
 * Порядок: сначала строки `vehicles` по возрастанию `id`, затем строки `vehicle_trailers` — так
 * же. Между таблицами порядок задан («сначала машины, потом прицепы»), внутри — по `id`.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Сколько раз набор затронутых строк перечитывается, прежде чем портал признаёт: их правят сейчас. */
const HITCH_LOCK_ATTEMPTS = 3;

/** Что операция собирается тронуть и что она при этом прочитала. */
export interface HitchScope<T> {
  /**
   * Тягачи: у команды привязки — целевой и прежний, у перевода типа на «форму № 3» — весь его
   * парк. Строка машины здесь не только участник правки, но и замок её слотов, поэтому в набор
   * она попадает и тогда, когда за ней ничего не стоит.
   */
  vehicleIds: readonly string[];
  /** Прицепы: перемещаемый и вытесняемый, а у снятия — все, кого оно снимает. */
  trailerIds: readonly string[];
  value: T;
}

/** Снятие привязки одной строкой: и отцепление, и списание, и уход в архив пишут ровно это. */
export const UNHITCHED = { hitchedVehicleId: null, hitchPosition: null } as const;

const uniqSorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Шаг 3 порядка: захват в фиксированной последовательности — **сначала `vehicles`**, затем
 * `vehicle_trailers`, внутри каждой таблицы по возрастанию `id`.
 *
 * По одной строке в цикле, а не одним `WHERE id = ANY(…) ORDER BY id FOR UPDATE`: план запроса
 * вправе брать строки в своём порядке, и обещания `ORDER BY` на порядок наложения блокировок не
 * распространяются — то есть единственное, ради чего порядок объявлен, одним запросом как раз и не
 * гарантируется. Тем же приёмом и по той же причине берутся учётки в `grant-catalog.ts`
 * (`lockUsers`) и рейсы в `vehicle-routes.ts` (`lockRouteIds`).
 *
 * Строка тягача здесь — не только участник правки, но и замок слота: любые две команды, спорящие
 * за «прицеп 1» одной машины, обязаны сперва встретиться на ней.
 */
export async function lockHitchRows(
  tx: Tx,
  vehicleIds: readonly string[],
  trailerIds: readonly string[],
): Promise<void> {
  for (const id of uniqSorted(vehicleIds)) {
    await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, id)).for('update');
  }
  for (const id of uniqSorted(trailerIds)) {
    await tx
      .select({ id: vehicleTrailers.id })
      .from(vehicleTrailers)
      .where(eq(vehicleTrailers.id, id))
      .for('update');
  }
}

/**
 * Порядок целиком — «прочитать грязно → захватить → перечитать и сверить» (шаги 1–4).
 *
 * Шаг 4 не перестраховка: набор блокируемых строк вычисляется из **грязного** чтения — где стоит
 * перемещаемый прицеп и кто занимает целевой слот, — и без сверки транзакция уверенно захватила бы
 * устаревший набор: прицеп успели переставить, его прежний тягач уже не тот, а команда правила бы
 * не те строки. Разошлось — повторяем с шага 1 расширенным множеством (взятые блокировки живут до
 * конца транзакции, поэтому повтор только добирает новое).
 *
 * Попыток три: набор, изменившийся дважды подряд, означает, что привязку перекладывают прямо
 * сейчас, и третий заход услышал бы то же самое. Честнее сказать словами, чем крутиться в цикле,
 * который под непрерывной правкой не кончится.
 *
 * Возвращается значение **второго** чтения: оно сделано под блокировкой и потому настоящее, а
 * первое было лишь догадкой о том, какие строки брать.
 */
export async function withHitchLocks<T>(tx: Tx, scan: () => Promise<HitchScope<T>>): Promise<T> {
  for (let attempt = 0; attempt < HITCH_LOCK_ATTEMPTS; attempt += 1) {
    const before = await scan();
    await lockHitchRows(tx, before.vehicleIds, before.trailerIds);
    const after = await scan();
    if (
      sameIds(uniqSorted(before.vehicleIds), uniqSorted(after.vehicleIds)) &&
      sameIds(uniqSorted(before.trailerIds), uniqSorted(after.trailerIds))
    ) {
      return after.value;
    }
  }
  throw err.conflict('Привязку в этот момент меняли, повторите');
}

/**
 * Снять все привязки машины и сказать, сколько сняла, — сторона тягача из таблицы §4.2.3.
 *
 * Зовут её три события `routes/vehicles.ts`: списание (`retired`), мягкое удаление и смена типа на
 * бланк «форма № 3», у которого граф прицепа нет вовсе (ADR 0071). Снятие, а не запрет: закрепление
 * — удобство подстановки, а не учётный факт, и держать списание машины заложником у него не за что.
 *
 * Зовётся **в той же транзакции**, что и само действие, и обязательно после того, как строка машины
 * уже взята правкой: `UPDATE vehicles` — это и есть первая блокировка объявленного порядка, а
 * `lockHitchRows` ниже её лишь повторяет (взятая строка второй раз не ждёт). Обратный порядок —
 * сначала прицепы, потом машина — был бы вторым порядком захвата на тех же строках.
 *
 * Прицепов у машины до двух (слоты бланка), но запрос не сужен до двух и не сужен по живости:
 * снимается **всё**, что ссылается на эту машину. Ссылка объявлена `ON DELETE RESTRICT`, и
 * оставленная строка — не мелочь показа, а то, что потом не даст снести машину насовсем.
 *
 * Возвращается число снятых, а не строки: и журналу, и человеку нужно ровно оно (§7 — «портал
 * говорит, сколько сняло»), а называть каждый прицеп поимённо в ответе про машину значило бы
 * пересказывать реестр прицепов в справочнике техники.
 */
export async function releaseHitchesOfVehicle(tx: Tx, vehicleId: string): Promise<number> {
  const scan = async (): Promise<HitchScope<string[]>> => {
    const rows = await tx
      .select({ id: vehicleTrailers.id })
      .from(vehicleTrailers)
      .where(eq(vehicleTrailers.hitchedVehicleId, vehicleId));
    const ids = rows.map((r) => r.id);
    // Машина в наборе всегда, даже когда за ней ничего не стоит: она — замок обоих слотов, и без
    // неё команда `hitch`, идущая навстречу, успела бы прицепить прицеп к уже списанной.
    return { vehicleIds: [vehicleId], trailerIds: ids, value: ids };
  };
  const ids = await withHitchLocks(tx, scan);
  if (ids.length === 0) return 0;
  await tx
    .update(vehicleTrailers)
    .set({ ...UNHITCHED, updatedAt: new Date() })
    .where(inArray(vehicleTrailers.id, ids));
  return ids.length;
}

/**
 * Снять привязки у всех машин типа и сказать, сколько сняла и у скольких машин, — **четвёртая
 * дверь** §4.2.3, которой план до шестой редакции не знал: её нашли тесты.
 *
 * Бланк правится не только у машины, но и у самого типа (`PATCH /vehicle-types/:id`), и перевод
 * существующего типа на «форму № 3» осиротит привязки у **всех машин этого типа разом**: графы, из
 * которых привязка жила, исчезли, а сама она осталась. Дальше её достанет подстановка в рейс — и
 * подставит туда, где её негде напечатать.
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ `releaseHitchesOfVehicle`. Не порядком — он тот же и другим быть не может, —
 * а тем, откуда берётся множество. Там машина одна и названа адресом ручки; здесь машины
 * **читаются** запросом, то есть набор блокируемых строк вычисляется из грязного чтения целиком.
 * Поэтому шаг 4 порядка (перечитать под блокировкой и сверить) здесь не перестраховка, а
 * единственное, что отличает «снял у всех» от «снял у тех, кого успел увидеть».
 *
 * ПОЧЕМУ БЕРУТСЯ ВСЕ МАШИНЫ ТИПА, А НЕ ТОЛЬКО ТЕ, ЗА КОТОРЫМИ ЧТО-ТО СТОИТ. По той же причине, по
 * которой одиночное снятие берёт машину даже с пустыми слотами: строка машины — замок обоих слотов.
 * Встречный `hitch` проверяет бланк (`assertTractorUsable`) уже **после** захвата строки машины —
 * значит, взяв её здесь, перевод типа заставляет команду привязки либо дождаться и прочитать уже
 * «форму № 3» (и отказать), либо лечь раньше и попасть во второе чтение (и быть снятой). Возьми мы
 * только машины с прицепами — пустая машина осталась бы незапертой, и привязка, легшая на неё
 * между чтением и коммитом, пережила бы перевод. Цена — по одному `FOR UPDATE` на машину типа
 * (в парке это десятки строк), и платится она за действие, которое делают раз в год.
 *
 * Плата за ту же полноту — отказ `409` там, где в тип прямо сейчас заводят машины: набор строк
 * меняется, и три захода подряд его не застанут. Это честнее молчаливого «снял у части».
 *
 * Машины берутся все — и списанные, и мягко удалённые: строка привязки живёт в `vehicle_trailers`
 * и ссылается `ON DELETE RESTRICT`, поэтому оставленная за невидимой машиной привязка — не мелочь
 * показа, а то, что потом не даст снести запись насовсем.
 *
 * Возвращаются два числа, а не одно: операция на множество, и «снято N привязок у M машин» — это
 * ровно то, что человек и журнал должны о ней узнать.
 */
export async function releaseHitchesOfVehicleType(
  tx: Tx,
  vehicleTypeId: string,
): Promise<{ trailers: number; vehicles: number }> {
  const scan = async (): Promise<HitchScope<{ trailerIds: string[]; ownerIds: string[] }>> => {
    const fleet = await tx
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(eq(vehicles.vehicleTypeId, vehicleTypeId));
    const hitched = await tx
      .select({ trailerId: vehicleTrailers.id, vehicleId: vehicles.id })
      .from(vehicleTrailers)
      .innerJoin(vehicles, eq(vehicles.id, vehicleTrailers.hitchedVehicleId))
      .where(eq(vehicles.vehicleTypeId, vehicleTypeId));
    const trailerIds = hitched.map((r) => r.trailerId);
    // Машины ответа — только те, у кого привязку и правда сняли: парк типа считает `fleet`, и
    // сказать человеку «снято 3 привязки у 33 машин» значило бы назвать не то число.
    const ownerIds = [...new Set(hitched.map((r) => r.vehicleId))];
    return { vehicleIds: fleet.map((v) => v.id), trailerIds, value: { trailerIds, ownerIds } };
  };
  const { trailerIds, ownerIds } = await withHitchLocks(tx, scan);
  if (trailerIds.length === 0) return { trailers: 0, vehicles: 0 };
  await tx
    .update(vehicleTrailers)
    .set({ ...UNHITCHED, updatedAt: new Date() })
    .where(inArray(vehicleTrailers.id, trailerIds));
  return { trailers: trailerIds.length, vehicles: ownerIds.length };
}
