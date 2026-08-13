import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  DRIVER_SUBMIT_PAST_DAYS,
  discrepancyKindLabels,
  formatVehicleRouteNumber,
  moscowDateKeyOf,
  STAFF_SUBMIT_PAST_DAYS,
  vehicleLabel,
  waybillDisplayNumber,
  type DiscrepancyKind,
  type DiscrepancyResolveInput,
  type DriverAssignmentEntry,
  type DriverReportDto,
  type ReadingInput,
  type ReadingRebaseInput,
  type ReadingSource,
  type ReadingSourceKind,
  type ReportDiscrepancyDto,
  type ReportItemDto,
  type ReportItemOrderInput,
  type ReportSubmitInput,
  type VehicleReadingDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  driverDailyReportItems,
  driverDailyReports,
  driverReportDiscrepancyResolutions,
  files,
  persons,
  users,
  vehicleCategories,
  vehicleModels,
  vehicleReadingFiles,
  vehicleReadings,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
  type DriverDailyReportItemRow,
  type DriverDailyReportRow,
  type VehicleReadingRow,
} from '../db/schema';
import { sha256hex } from '../lib/crypto';
import { err } from '../lib/errors';
import { assertFilesAttachable, markFilesActive } from './request-files';
// Задание дня собирает общий слой (Р12): кабинет и рассылка обязаны видеть один и тот же день, и
// второй сборки «что у человека сегодня» в портале быть не должно.
import { loadDayEntries } from './driver-assignment';
import {
  applyReportChange,
  confirmAnomalies,
  daysBetween,
  emptyChainContext,
  hasUnconfirmedAnomaly,
  lockReports,
  lockSources,
  lockVehicles,
  nextShiftOrder,
  relinkChains,
  unconfirmedAnomalyLabels,
  writeReadingEvent,
  writeReportEvent,
  type ChainAnchor,
  type SourceRef,
  type Tx,
} from './readings-chain';

/**
 * Показания техники (ADR 0103): отчёт дня работника, строки ожидания и снимки счётчиков.
 *
 * Модель держится на трёх утверждениях, и все правила ниже — их следствия.
 *
 * 1. **Показание принадлежит выезду, а не дню.** Оно привязано к строке ожидания, а та — к рейсу
 *    или недельному листу: только источник отвечает, в каком порядке шли смены и с чем сравнивать
 *    следующий снимок.
 * 2. **Строка ожидания — снимок источника**, а не ссылка на него. Поэтому рейс, переназначенный
 *    после отправки, не переписывает сданное молча: он даёт расхождение (Р21), которое человек
 *    разбирает, а не портал угадывает.
 * 3. **Отчёт замораживается отправкой.** Пока черновик — состав синхронизируется с заданием; после
 *    `submitted` всякое изменение задания живёт расхождением.
 *
 * Сериализация, версии, обе истории и цепочки счётчиков вынесены в `readings-chain.ts`: здесь —
 * предметная область, там — то, чем модуль защищается от встречных операций.
 */

/**
 * Кто пишет. `mode` отвечает сразу на три вопроса: какое окно записи действует (Р11), что попадёт
 * в `source` показания (Р26) и вправе ли этот человек трогать числа принятого отчёта (Р23).
 */
export interface ReadingsActor {
  userId: string;
  mode: ReadingSource;
}

/**
 * Чем ввод персоналом отличается от ввода из кабинета. Параметром, а не отдельной парой функций:
 * различий ровно два — окно записи и подпись под числом, — а весь протокол один и тот же, и вторая
 * копия разошлась бы с первой на первой же правке.
 */
export interface ReadingsWriteOptions {
  /** `staff` — сотрудник вносит за водителя (Р26). По умолчанию пишет сам работник. */
  mode?: ReadingSource;
  /** Обязательна, когда персонал правит уже сданное число (Р19). */
  reason?: string;
}

/** Операции приёмки и разбора — право персонала (`vehicleReadings.write`), и другого ввода нет. */
function staffActor(actorUserId: string): ReadingsActor {
  return { userId: actorUserId, mode: 'staff' };
}

/** Строка задания в том объёме, в каком её читает модуль показаний: источник и ничего больше. */
type DayEntry = Pick<DriverAssignmentEntry, 'sourceKind' | 'sourceId'>;

// ── Окна записи (Р11) ──

/**
 * Чтение задания шире записи, и это не удобство, а граница области: одно окно на оба действия
 * отдавало бы водителю возможность закрыть будущий рейс. Будущее закрыто вовсе — показание
 * счётчика, которого ещё не сняли, это не данные.
 */
function assertWriteWindow(date: string, actor: ReadingsActor): void {
  const today = moscowDateKeyOf(new Date());
  if (date > today) {
    throw err.forbidden('Показания снимают с прибора: день ещё не наступил');
  }
  const pastDays = actor.mode === 'driver' ? DRIVER_SUBMIT_PAST_DAYS : STAFF_SUBMIT_PAST_DAYS;
  if (daysBetween(date, today) > pastDays) {
    throw err.forbidden(
      `Окно записи — ${pastDays + 1} дней, считая сегодняшний; за более ранний день показания вносит персонал`,
    );
  }
}

// ── Живые источники (Р16, Р21) ──

/**
 * Источник глазами модуля: то, с чем сравнивается снимок строки ожидания. Поля названы общо
 * намеренно — расхождение считается одинаково у рейса и у листа, и две ветки на каждое сравнение
 * разошлись бы при первой же правке.
 */
interface LiveSource {
  ref: SourceRef;
  label: string;
  /** Ключ первичной нумерации смен (Р15) — сравнимый строкой, но упорядоченный по числу. */
  orderKey: string;
  vehicleId: string;
  personId: string | null;
  /** День рейса; у недельного листа — `null`, его время задано периодом. */
  date: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  /** Рейс существует, лист не аннулирован. */
  active: boolean;
}

function sourceKey(ref: SourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Число в ключе сортировки дополняется нулями: иначе «Р-10» встало бы раньше «Р-9». */
function orderKeyOf(group: string, num: number): string {
  return `${group}|${String(num).padStart(12, '0')}`;
}

function itemRef(item: DriverDailyReportItemRow): SourceRef {
  return item.sourceKind === 'route'
    ? { kind: 'route', id: item.routeId! }
    : { kind: 'esm2', id: item.waybillId! };
}

/** Накрывает ли источник день строки: у рейса это его дата, у листа — период работы. */
function sourceCoversDate(source: LiveSource, date: string): boolean {
  if (source.date !== null) return source.date === date;
  if (source.periodFrom === null || source.periodTo === null) return false;
  return source.periodFrom <= date && date <= source.periodTo;
}

async function loadLiveSources(
  tx: Tx,
  refs: readonly SourceRef[],
): Promise<Map<string, LiveSource>> {
  const routeIds = [...new Set(refs.filter((r) => r.kind === 'route').map((r) => r.id))];
  const waybillIds = [...new Set(refs.filter((r) => r.kind === 'esm2').map((r) => r.id))];
  const live = new Map<string, LiveSource>();

  if (routeIds.length > 0) {
    const rows = await tx
      .select({
        id: vehicleRoutes.id,
        num: vehicleRoutes.num,
        vehicleId: vehicleRoutes.vehicleId,
        routeDate: vehicleRoutes.routeDate,
        driverPersonId: vehicleRoutes.driverPersonId,
      })
      .from(vehicleRoutes)
      .where(inArray(vehicleRoutes.id, routeIds));
    for (const row of rows) {
      const ref: SourceRef = { kind: 'route', id: row.id };
      live.set(sourceKey(ref), {
        ref,
        label: formatVehicleRouteNumber(row.num),
        orderKey: orderKeyOf('', row.num),
        vehicleId: row.vehicleId,
        personId: row.driverPersonId,
        date: row.routeDate,
        periodFrom: null,
        periodTo: null,
        // Удалённого рейса нет вовсе: строка ожидания держит его `RESTRICT`, и «удалён» узнаётся
        // отсутствием строки, а не колонкой.
        active: true,
      });
    }
  }

  if (waybillIds.length > 0) {
    const rows = await tx
      .select({
        id: waybills.id,
        number: waybills.number,
        formCode: waybills.formCode,
        status: waybills.status,
        vehicleId: waybills.vehicleId,
        driverPersonId: waybills.driverPersonId,
        periodFrom: waybills.periodFrom,
        periodTo: waybills.periodTo,
        seriesId: waybills.seriesId,
        prefix: waybillSeries.prefix,
        numberWidth: waybillSeries.numberWidth,
      })
      .from(waybills)
      .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .where(inArray(waybills.id, waybillIds));
    for (const row of rows) {
      // Канонический источник (Р16): у 4-П и формы № 3 заполнен `route_id`, и их выезд уже
      // представлен рейсом. Лист таких форм источником показаний не бывает — иначе один выезд
      // получил бы две карточки в форме и две точки в цепочке.
      if (row.formCode !== 'esm2') continue;
      const ref: SourceRef = { kind: 'esm2', id: row.id };
      live.set(sourceKey(ref), {
        ref,
        label: `ЭСМ-2 № ${waybillDisplayNumber(row.prefix, row.number, row.numberWidth)}`,
        // Ключ по серии и номеру, а не по подписи: номер бланка уникален только внутри серии.
        orderKey: orderKeyOf(row.seriesId, row.number),
        vehicleId: row.vehicleId,
        personId: row.driverPersonId,
        date: null,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        active: row.status !== 'cancelled',
      });
    }
  }
  return live;
}

/** Подписи машин: правило одно на портал и сервер (`vehicleLabel`), а не своё в каждом модуле. */
async function loadVehicleLabels(
  tx: Tx,
  vehicleIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(vehicleIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(inArray(vehicles.id, ids));
  return new Map(rows.map((row) => [row.id, vehicleLabel(row)]));
}

// ── Открытие отчёта и синхронизация состава (Р17) ──

/**
 * Открытие оверлея: шапка в `draft`, если её нет, и строки ожидания из задания дня.
 *
 * Курица и яйцо, найденные третьим ревью, решаются именно здесь: до первой отправки `item_id` не
 * существует, поэтому строки заводит сервер и возвращает с идентификаторами, а клиент дальше
 * говорит только ими. Отсюда же следует, что операция идемпотентна и вызывается при каждом
 * открытии: состав черновика синхронизируется с заданием, пока отчёт не отправлен.
 */
export async function openReport(
  personId: string,
  date: string,
  actorUserId: string,
  options: ReadingsWriteOptions = {},
): Promise<DriverReportDto> {
  const actor: ReadingsActor = { userId: actorUserId, mode: options.mode ?? 'driver' };
  assertWriteWindow(date, actor);
  // Разведка без блокировок (уровень 0): состав дня и машины, которые придётся блокировать.
  const entries: DayEntry[] = await loadDayEntries(personId, date);

  return db.transaction(async (tx) => {
    const dayRefs: SourceRef[] = entries.map((e) => ({ kind: e.sourceKind, id: e.sourceId }));
    const scouted = await loadLiveSources(tx, dayRefs);
    const existing = await tx
      .select()
      .from(driverDailyReports)
      .where(
        and(eq(driverDailyReports.personId, personId), eq(driverDailyReports.reportDate, date)),
      );
    const scoutedItems = existing[0]
      ? await tx
          .select()
          .from(driverDailyReportItems)
          .where(eq(driverDailyReportItems.reportId, existing[0].id))
      : [];
    // Источники, занятые чужими строками: их отчёты идут во второй уровень вместе с нашим —
    // подниматься за блокировкой отчёта после источников общий порядок запрещает.
    const occupying = await loadOccupyingItems(tx, dayRefs, date);

    const vehicleIds = [
      ...[...scouted.values()].map((s) => s.vehicleId),
      ...scoutedItems.map((i) => i.vehicleId),
      ...occupying.map((i) => i.vehicleId),
    ];
    await lockVehicles(tx, vehicleIds);

    const opened = await ensureReport(tx, personId, date, actor);
    const foreignReportIds = occupying.map((i) => i.reportId).filter((id) => id !== opened.id);
    const locked = await lockReports(tx, [opened.id, ...foreignReportIds]);
    const report = locked.get(opened.id);
    if (!report) throw err.conflict('Отчёт дня исчез, повторите открытие');
    if (opened.created) {
      // История шапки ведётся с открытия (Р23): у правки черновика ещё нет числа, историю
      // которого можно вести, зато перенос источника между черновиками обязан быть виден в обеих.
      await writeReportEvent(tx, {
        reportId: report.id,
        event: 'created',
        contentVersion: report.contentVersion,
        reportVersion: report.version,
        changedBy: actor.userId,
      });
    }

    await lockSources(tx, [...dayRefs, ...scoutedItems.map(itemRef)]);
    const live = await loadLiveSources(tx, [...dayRefs, ...scoutedItems.map(itemRef)]);

    if (report.state === 'draft') {
      await syncDraftItems(tx, {
        report,
        date,
        dayRefs,
        live,
        lockedVehicleIds: new Set(vehicleIds),
        foreignReports: locked,
        actor,
      });
    }
    const fresh = await reloadReport(tx, report.id);
    return buildReportDto(tx, fresh, entries);
  });
}

/** Строки ожидания, уже занявшие источники дня, — вместе с их отчётами (уникальность глобальная). */
async function loadOccupyingItems(
  tx: Tx,
  refs: readonly SourceRef[],
  date: string,
): Promise<DriverDailyReportItemRow[]> {
  const routeIds = refs.filter((r) => r.kind === 'route').map((r) => r.id);
  const waybillIds = refs.filter((r) => r.kind === 'esm2').map((r) => r.id);
  const conditions = [];
  if (routeIds.length > 0) conditions.push(inArray(driverDailyReportItems.routeId, routeIds));
  if (waybillIds.length > 0) {
    conditions.push(
      and(
        inArray(driverDailyReportItems.waybillId, waybillIds),
        eq(driverDailyReportItems.reportDate, date),
      ),
    );
  }
  if (conditions.length === 0) return [];
  return tx
    .select()
    .from(driverDailyReportItems)
    .where(or(...conditions));
}

/**
 * Шапка дня: заводится вставкой с `ON CONFLICT DO NOTHING`, а не проверкой «нет — создам».
 * Уникальный ключ `(person_id, report_date)` — единственное, что здесь по-настоящему сериализует
 * два одновременных открытия одного дня.
 */
async function ensureReport(
  tx: Tx,
  personId: string,
  date: string,
  actor: ReadingsActor,
): Promise<{ id: string; created: boolean }> {
  const [inserted] = await tx
    .insert(driverDailyReports)
    .values({ personId, reportDate: date, state: 'draft', createdBy: actor.userId })
    .onConflictDoNothing({ target: [driverDailyReports.personId, driverDailyReports.reportDate] })
    .returning({ id: driverDailyReports.id });
  if (inserted) return { id: inserted.id, created: true };
  const [row] = await tx
    .select({ id: driverDailyReports.id })
    .from(driverDailyReports)
    .where(and(eq(driverDailyReports.personId, personId), eq(driverDailyReports.reportDate, date)));
  if (!row) throw err.conflict('Отчёт дня исчез, повторите открытие');
  return { id: row.id, created: false };
}

/**
 * Синхронизация состава черновика (Р17 п. 2, 6). Три правила, и каждое названо своим следствием:
 *
 * - появившийся источник добавляется — иначе рейс, заведённый днём, водитель закрыть не смог бы;
 * - исчезнувший удаляется, **если по нему нет показания**, — сданное число молча не пропадает;
 * - источник, занятый чужим **пустым** черновиком, переезжает: уникальность источника глобальная,
 *   и брошенный черновик прежнего водителя иначе держал бы рейс занятым до уборки. Занятый
 *   отправленным отчётом источник не переносится никогда — это уже расхождение (Р21).
 */
async function syncDraftItems(
  tx: Tx,
  params: {
    report: DriverDailyReportRow;
    date: string;
    dayRefs: readonly SourceRef[];
    live: Map<string, LiveSource>;
    lockedVehicleIds: ReadonlySet<string>;
    foreignReports: Map<string, DriverDailyReportRow>;
    actor: ReadingsActor;
  },
): Promise<void> {
  const { report, date, dayRefs, live, lockedVehicleIds, foreignReports, actor } = params;
  const items = await tx
    .select()
    .from(driverDailyReportItems)
    .where(eq(driverDailyReportItems.reportId, report.id));
  const readings = await loadReadingsByItem(
    tx,
    items.map((i) => i.id),
  );

  const dayKeys = new Set(dayRefs.map(sourceKey));
  const removed: string[] = [];
  for (const item of items) {
    if (dayKeys.has(sourceKey(itemRef(item)))) continue;
    // Показание есть — строка остаётся и попадает в расхождения: удалить её значило бы стереть
    // учётное число вместе с исчезнувшим из задания источником.
    if (readings.has(item.id)) continue;
    await tx.delete(driverDailyReportItems).where(eq(driverDailyReportItems.id, item.id));
    removed.push(sourceKey(itemRef(item)));
  }

  const presentKeys = new Set(
    items.filter((i) => !removed.includes(sourceKey(itemRef(i)))).map((i) => sourceKey(itemRef(i))),
  );
  const stolen: string[] = [];
  const added: string[] = [];
  for (const ref of sortSourcesForNumbering(dayRefs, live)) {
    const key = sourceKey(ref);
    if (presentKeys.has(key)) continue;
    const source = live.get(key);
    // Источника нет или он больше не про этот день: добавлять нечего, а расхождение по нему
    // посчитается само.
    if (!source || !source.active || !sourceCoversDate(source, date)) continue;
    // Машина источника сменилась между разведкой и блокировками: её мы не блокировали, а занимать
    // позицию смены незаблокированной машины нельзя. Строка появится следующим открытием — оно
    // идемпотентно и происходит при каждом входе в оверлей.
    if (!lockedVehicleIds.has(source.vehicleId)) continue;

    const taken = await takeOccupiedSource(tx, ref, date, foreignReports, actor);
    if (taken === 'busy') continue;
    if (taken === 'stolen') stolen.push(key);

    await tx.insert(driverDailyReportItems).values({
      reportId: report.id,
      sourceKind: ref.kind,
      routeId: ref.kind === 'route' ? ref.id : null,
      waybillId: ref.kind === 'esm2' ? ref.id : null,
      vehicleId: source.vehicleId,
      reportDate: date,
      shiftOrder: await nextShiftOrder(tx, source.vehicleId, date),
    });
    added.push(key);
  }

  if (removed.length === 0 && added.length === 0) return;
  const changed = await applyReportChange(tx, report, { contentChanged: true }, actor.userId);
  for (const key of removed) {
    await writeReportEvent(tx, {
      reportId: report.id,
      event: 'item_removed',
      payload: { source: key },
      reason: 'источник исчез из задания дня',
      contentVersion: changed.row.contentVersion,
      reportVersion: changed.row.version,
      changedBy: actor.userId,
    });
  }
  for (const key of added) {
    await writeReportEvent(tx, {
      reportId: report.id,
      event: 'item_added',
      payload: { source: key },
      reason: stolen.includes(key) ? 'источник переназначен' : 'источник появился в задании дня',
      contentVersion: changed.row.contentVersion,
      reportVersion: changed.row.version,
      changedBy: actor.userId,
    });
  }
  for (const event of changed.implicit) {
    await writeReportEvent(tx, {
      reportId: report.id,
      event,
      contentVersion: changed.row.contentVersion,
      reportVersion: changed.row.version,
      changedBy: actor.userId,
    });
  }
}

/**
 * Освобождает источник, занятый чужой строкой. Перенос сделан парой «удалить — завести», а не
 * сменой `report_id`: у чужой строки свои день и позиция смены, и переехавшая в другой день строка
 * несла бы позицию, посчитанную не для него. Показания у неё нет по условию, поэтому терять
 * нечего, а обе шапки получают свои события (`item_removed` / `item_added`).
 */
async function takeOccupiedSource(
  tx: Tx,
  ref: SourceRef,
  date: string,
  foreignReports: Map<string, DriverDailyReportRow>,
  actor: ReadingsActor,
): Promise<'free' | 'stolen' | 'busy'> {
  const [item] = await tx
    .select()
    .from(driverDailyReportItems)
    .where(
      ref.kind === 'route'
        ? eq(driverDailyReportItems.routeId, ref.id)
        : and(
            eq(driverDailyReportItems.waybillId, ref.id),
            eq(driverDailyReportItems.reportDate, date),
          ),
    );
  if (!item) return 'free';
  const owner = foreignReports.get(item.reportId);
  // Отчёт владельца не заблокирован (появился после разведки) или уже отправлен: источник занят.
  if (!owner || owner.state !== 'draft') return 'busy';
  const readings = await loadReadingsByItem(tx, [item.id]);
  if (readings.size > 0) return 'busy';

  await tx.delete(driverDailyReportItems).where(eq(driverDailyReportItems.id, item.id));
  const changed = await applyReportChange(tx, owner, { contentChanged: true }, actor.userId);
  foreignReports.set(owner.id, changed.row);
  await writeReportEvent(tx, {
    reportId: owner.id,
    event: 'item_removed',
    payload: { source: sourceKey(ref) },
    reason: 'источник переназначен',
    contentVersion: changed.row.contentVersion,
    reportVersion: changed.row.version,
    changedBy: actor.userId,
  });
  return 'stolen';
}

/**
 * Порядок первичной нумерации смен (Р15): сначала недельные листы, затем рейсы. Ключ сортировки
 * полный — у листов `(series_id, number, id)`, у рейсов `(num, id)`: номер бланка уникален только
 * внутри серии, и без серии два листа разных серий сортировались бы недетерминированно.
 *
 * Это приближение, и модель называет его приближением, а не фактом: `vehicle_routes.num` говорит,
 * когда рейс завели, а не когда машина выехала. Поэтому позицию исправляет человек
 * (`reorderShifts`) — с причиной, историей и перестройкой цепочки.
 */
function sortSourcesForNumbering(
  refs: readonly SourceRef[],
  live: Map<string, LiveSource>,
): SourceRef[] {
  return [...refs].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'esm2' ? -1 : 1;
    const ka = live.get(sourceKey(a))?.orderKey ?? '';
    const kb = live.get(sourceKey(b))?.orderKey ?? '';
    return ka === kb ? a.id.localeCompare(b.id) : ka.localeCompare(kb);
  });
}

// ── Отправка показаний (Р13, Р18, Р25) ──

/**
 * Отпечаток тела отправки. Ключи объектов сортируются: порядок полей в JSON от клиента не
 * гарантирован, а ретрай той же кнопки обязан дать тот же отпечаток.
 */
function submitFingerprint(input: ReportSubmitInput): string {
  return `v1:${sha256hex(JSON.stringify(canonical(input)))}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value ?? null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = canonical(source[key]);
  }
  return out;
}

/** numeric(9,1) и numeric(7,1) пишутся строкой: число с плавающей точкой округляет молча. */
function numeric1(value: number | null): string | null {
  return value === null ? null : value.toFixed(1);
}

function readingColumns(reading: ReadingInput) {
  if (reading.kind === 'no_data') {
    return {
      kind: 'no_data' as const,
      odometerKm: null,
      engineHours: null,
      fuelFilledLiters: null,
      noDataReason: reading.noDataReason,
      comment: reading.comment,
    };
  }
  return {
    kind: 'values' as const,
    odometerKm: reading.odometerKm,
    engineHours: numeric1(reading.engineHours),
    fuelFilledLiters: numeric1(reading.fuelFilledLiters),
    noDataReason: '',
    comment: reading.comment,
  };
}

/**
 * Передача показаний: одна транзакция на весь день работника.
 *
 * Идемпотентность — ключ **плюс** отпечаток тела (Р25): тот же ключ с тем же отпечатком возвращает
 * текущее состояние (повтор потерянного ответа), тот же ключ с другим отпечатком отвечает 409 —
 * это уже другая команда под старым ключом, и молча подтверждать её нельзя.
 *
 * `reason` обязателен, когда персонал правит уже сданное число (Р19): чужое число меняют с
 * объяснением, и история без него — след без причины.
 */
export async function submitReport(
  personId: string,
  date: string,
  input: ReportSubmitInput,
  actorUserId: string,
  idempotencyKey: string | null,
  options: ReadingsWriteOptions = {},
): Promise<DriverReportDto> {
  const actor: ReadingsActor = { userId: actorUserId, mode: options.mode ?? 'driver' };
  const reason = options.reason ?? '';
  assertWriteWindow(date, actor);
  const fingerprint = submitFingerprint(input);
  const entries: DayEntry[] = await loadDayEntries(personId, date);

  return db.transaction(async (tx) => {
    const [scouted] = await tx
      .select()
      .from(driverDailyReports)
      .where(
        and(eq(driverDailyReports.personId, personId), eq(driverDailyReports.reportDate, date)),
      );
    if (!scouted) throw err.notFound('Отчёт дня не открыт — откройте его и повторите');
    const scoutedItems = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.reportId, scouted.id));

    await lockVehicles(
      tx,
      scoutedItems.map((i) => i.vehicleId),
    );
    const report = (await lockReports(tx, [scouted.id])).get(scouted.id);
    if (!report) throw err.conflict('Отчёт дня исчез, повторите открытие');

    // Идемпотентность проверяется до версии: у повтора потерянного ответа версия заведомо
    // устарела, и обычная оптимистическая блокировка отвергла бы законный ретрай.
    if (idempotencyKey && report.submitIdempotencyKey === idempotencyKey) {
      if (report.submitFingerprint !== fingerprint) {
        throw err.conflict('Под этим ключом отправки уже принято другое содержимое');
      }
      return buildReportDto(tx, report, entries);
    }
    if (report.version !== input.version) {
      throw err.conflict('Отчёт изменился, обновите страницу и повторите');
    }
    if (report.state === 'voided') {
      throw err.conflict('Отчёт аннулирован: строки перенесены в другой день');
    }
    if (
      actor.mode === 'driver' &&
      (report.state === 'accepted' || report.state === 'needs_reacceptance')
    ) {
      throw err.forbidden('Отчёт принят: числа правит персонал');
    }

    await lockSources(tx, scoutedItems.map(itemRef));
    const items = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.reportId, report.id))
      .orderBy(asc(driverDailyReportItems.vehicleId), asc(driverDailyReportItems.shiftOrder));
    const byId = new Map(items.map((i) => [i.id, i]));
    const readings = await loadReadingsByItem(
      tx,
      items.map((i) => i.id),
    );

    const chain = emptyChainContext(actor.userId, reason);
    const anchors: ChainAnchor[] = [];
    const confirmations: { readingId: string; odometer: boolean; engineHours: boolean }[] = [];
    let contentChanged = false;

    for (const line of input.items) {
      const item = byId.get(line.itemId);
      // Машины вне задания дня в форме нет ни у кого (Р26): клиент присылает `item_id`, а строки
      // ожидания строятся из задания. Поздний источник добавляет персонал явным действием.
      if (!item) throw err.badRequest('Строка не из этого отчёта — обновите страницу');
      const columns = readingColumns(line.reading);
      const existing = readings.get(item.id);

      if (!existing) {
        const [created] = await tx
          .insert(vehicleReadings)
          .values({
            itemId: item.id,
            reportId: report.id,
            vehicleId: item.vehicleId,
            reportDate: item.reportDate,
            shiftOrder: item.shiftOrder,
            ...columns,
            source: actor.mode,
            createdBy: actor.userId,
          })
          .returning();
        if (!created) throw err.conflict('Показание не сохранилось, повторите');
        await attachFiles(tx, created.id, line.fileIds, actor);
        await writeReadingEvent(tx, {
          readingId: created.id,
          event: 'created',
          after: columns,
          reason,
          version: created.version,
          changedBy: actor.userId,
        });
        chain.createdReadingIds.add(created.id);
        chain.touchedReadingIds.add(created.id);
        chain.changedValueIds.add(created.id);
        anchors.push(anchorOf(item));
        confirmations.push({
          readingId: created.id,
          odometer: line.confirmOdometerAnomaly,
          engineHours: line.confirmEngineHoursAnomaly,
        });
        contentChanged = true;
        continue;
      }

      await attachFiles(tx, existing.id, line.fileIds, actor);
      confirmations.push({
        readingId: existing.id,
        odometer: line.confirmOdometerAnomaly,
        engineHours: line.confirmEngineHoursAnomaly,
      });
      const before = readingSnapshot(existing);
      const same =
        before.kind === columns.kind &&
        before.odometerKm === columns.odometerKm &&
        before.engineHours === columns.engineHours &&
        before.fuelFilledLiters === columns.fuelFilledLiters &&
        before.noDataReason === columns.noDataReason &&
        before.comment === columns.comment;
      // Файл не двигает ни `content_version`, ни состояние отчёта (Р22): приём фиксирует числа, а
      // не вложения, — поэтому повторная отправка с теми же числами и новым фото ничего не
      // переоткрывает.
      if (same) continue;
      if (actor.mode === 'staff' && reason.trim() === '') {
        throw err.badRequest('Правка сданного показания требует причины');
      }

      const version = existing.version + 1;
      await tx
        .update(vehicleReadings)
        .set({ ...columns, version, updatedBy: actor.userId, updatedAt: new Date() })
        .where(eq(vehicleReadings.id, existing.id));
      await writeReadingEvent(tx, {
        readingId: existing.id,
        event: 'updated',
        before,
        after: columns,
        reason,
        version,
        changedBy: actor.userId,
      });
      chain.touchedReadingIds.add(existing.id);
      if (
        before.odometerKm !== columns.odometerKm ||
        before.engineHours !== columns.engineHours ||
        before.kind !== columns.kind
      ) {
        chain.changedValueIds.add(existing.id);
      }
      anchors.push(anchorOf(item));
      contentChanged = true;
    }

    await relinkChains(tx, anchors, chain);
    // Подтверждение аномалии ставится после перестройки: иначе пересчёт той же транзакции снял бы
    // только что поставленную подпись (Р20).
    for (const c of confirmations) {
      await confirmAnomalies(tx, c.readingId, c, actor.userId);
    }

    const change = await applyReportChange(
      tx,
      report,
      {
        contentChanged,
        submit: true,
        idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint } : undefined,
      },
      actor.userId,
    );
    for (const event of change.implicit) {
      await writeReportEvent(tx, {
        reportId: report.id,
        event,
        reason,
        contentVersion: change.row.contentVersion,
        reportVersion: change.row.version,
        changedBy: actor.userId,
      });
    }
    return buildReportDto(tx, change.row, entries);
  });
}

function anchorOf(item: DriverDailyReportItemRow): ChainAnchor {
  return { vehicleId: item.vehicleId, reportDate: item.reportDate, shiftOrder: item.shiftOrder };
}

/**
 * Файлы показания. Владельца, живость и отсутствие чужих связей проверяет общий сервис; сверх него
 * модуль требует **именно `active`** (Р18): `pending` — это незавершённая загрузка, и ссылка на
 * объект, которого в хранилище ещё нет, в учётном документе недопустима.
 */
async function attachFiles(
  tx: Tx,
  readingId: string,
  fileIds: readonly string[],
  actor: ReadingsActor,
): Promise<void> {
  if (fileIds.length === 0) return;
  const ids = [...new Set(fileIds)];
  // Уже подшитое отсеивается первым: черновик оверлея держит `fileIds` вместе с числами и
  // присылает их при каждой отправке, а общая проверка привязываемости знает наши связи наравне с
  // заявками — и на второй отправке отвергла бы собственные же файлы показания.
  const linked = await tx
    .select({ fileId: vehicleReadingFiles.fileId, readingId: vehicleReadingFiles.readingId })
    .from(vehicleReadingFiles)
    .where(inArray(vehicleReadingFiles.fileId, ids));
  if (linked.some((l) => l.readingId !== readingId)) {
    throw err.badRequest('Файл уже прикреплён к другому показанию');
  }
  const mine = new Set(linked.map((l) => l.fileId));
  const fresh = ids.filter((id) => !mine.has(id));
  if (fresh.length === 0) return;

  await assertFilesAttachable(tx, fresh, actor.userId);
  const active = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, fresh), eq(files.status, 'active')));
  if (active.length !== fresh.length) {
    throw err.badRequest('Загрузка файла не завершена — дождитесь её и повторите');
  }
  await markFilesActive(tx, fresh);
  await tx.insert(vehicleReadingFiles).values(fresh.map((fileId) => ({ readingId, fileId })));
}

function readingSnapshot(row: VehicleReadingRow) {
  return {
    kind: row.kind,
    odometerKm: row.odometerKm,
    engineHours: row.engineHours,
    fuelFilledLiters: row.fuelFilledLiters,
    noDataReason: row.noDataReason,
    comment: row.comment,
  };
}

async function loadReadingsByItem(
  tx: Tx,
  itemIds: readonly string[],
): Promise<Map<string, VehicleReadingRow>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(vehicleReadings).where(inArray(vehicleReadings.itemId, ids));
  return new Map(rows.map((row) => [row.itemId, row]));
}

async function reloadReport(tx: Tx, reportId: string): Promise<DriverDailyReportRow> {
  const [row] = await tx
    .select()
    .from(driverDailyReports)
    .where(eq(driverDailyReports.id, reportId));
  if (!row) throw err.notFound('Отчёт дня не найден');
  return row;
}

// ── Приёмка (Р22) ──

/**
 * Приём дня. Четыре условия, и все проверяются **под блокировками**: отчёт `FOR UPDATE`, источники
 * его строк `FOR SHARE`.
 *
 * Граница гарантии названа явно: под блокировками проверяется всё, что описано снимком отчёта.
 * Отсутствие `missing_source` проверяется на момент приёма, но не удерживается после него —
 * источник, у которого строки в отчёте нет, заблокировать нечем, и рейс могут завести этому
 * человеку секундой позже. Это не дыра в протоколе, а свойство предметной области: заведённый
 * после приёма рейс делает день красным, и разбирают его как расхождение, а не как гонку.
 */
export async function acceptReport(
  reportId: string,
  version: number,
  actorUserId: string,
): Promise<DriverReportDto> {
  const actor = staffActor(actorUserId);
  const [head] = await db
    .select({ personId: driverDailyReports.personId, reportDate: driverDailyReports.reportDate })
    .from(driverDailyReports)
    .where(eq(driverDailyReports.id, reportId));
  if (!head) throw err.notFound('Отчёт дня не найден');
  const entries: DayEntry[] = await loadDayEntries(head.personId, head.reportDate);

  return db.transaction(async (tx) => {
    // Машины не блокируются вовсе: приём цепочки не трогает, а брать суффикс протокола разрешено.
    const report = (await lockReports(tx, [reportId])).get(reportId);
    if (!report) throw err.notFound('Отчёт дня не найден');
    if (report.version !== version) {
      throw err.conflict('Отчёт изменился, обновите страницу и повторите');
    }
    const items = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.reportId, reportId));
    await lockSources(tx, items.map(itemRef));

    // Повторная проверка всех условий уже под блокировками: между показом кнопки и приёмом
    // водитель успевает дописать строку, а диспетчер — переназначить рейс.
    const state = await loadReportState(tx, report, entries);
    if (state.blockers.length > 0) {
      throw err.conflict(`Отчёт принять нельзя: ${state.blockers.join('; ')}`);
    }

    const change = await applyReportChange(
      tx,
      report,
      { contentChanged: false, acceptedBy: actor.userId },
      actor.userId,
    );
    for (const event of change.implicit) {
      await writeReportEvent(tx, {
        reportId,
        event,
        payload: { acceptedContentVersion: change.row.acceptedContentVersion },
        contentVersion: change.row.contentVersion,
        reportVersion: change.row.version,
        changedBy: actor.userId,
      });
    }
    return buildReportDto(tx, change.row, entries);
  });
}

/** Состояние отчёта для чтения и для приёмки: один расчёт на оба, чтобы они не разошлись. */
interface ReportState {
  items: DriverDailyReportItemRow[];
  readings: Map<string, VehicleReadingRow>;
  live: Map<string, LiveSource>;
  discrepancies: ReportDiscrepancyDto[];
  blockers: string[];
}

async function loadReportState(
  tx: Tx,
  report: DriverDailyReportRow,
  entries: readonly DayEntry[],
): Promise<ReportState> {
  const items = await tx
    .select()
    .from(driverDailyReportItems)
    .where(eq(driverDailyReportItems.reportId, report.id))
    .orderBy(asc(driverDailyReportItems.vehicleId), asc(driverDailyReportItems.shiftOrder));
  const readings = await loadReadingsByItem(
    tx,
    items.map((i) => i.id),
  );
  const dayRefs: SourceRef[] = entries.map((e) => ({ kind: e.sourceKind, id: e.sourceId }));
  const live = await loadLiveSources(tx, [...items.map(itemRef), ...dayRefs]);
  const discrepancies = await computeDiscrepancies(tx, report, items, dayRefs, live);

  const blockers: string[] = [];
  if (report.state === 'draft') blockers.push('отчёт ещё не передан');
  if (report.state === 'accepted') blockers.push('отчёт уже принят');
  if (report.state === 'voided') blockers.push('отчёт аннулирован');
  // Пустой отчёт формально прошёл бы условие «все строки закрыты», поэтому непустота — своё
  // условие, а не следствие.
  if (items.length === 0) blockers.push('в отчёте нет ни одной строки');
  const pending = items.filter((i) => !readings.has(i.id)).length;
  if (pending > 0) blockers.push(`не закрыто строк: ${pending}`);
  const unconfirmed = [...readings.values()].filter(hasUnconfirmedAnomaly);
  if (unconfirmed.length > 0) {
    const labels = [...new Set(unconfirmed.flatMap(unconfirmedAnomalyLabels))];
    blockers.push(`не подтверждены аномалии (${labels.join(', ')})`);
  }
  const unresolved = discrepancies.filter((d) => !d.resolved).length;
  if (unresolved > 0) blockers.push(`не разобрано расхождений: ${unresolved}`);
  return { items, readings, live, discrepancies, blockers };
}

// ── Расхождения (Р21) ──

/**
 * Расхождения не хранятся — хранятся решения по ним. Живой источник сравнивается со снимком при
 * каждом чтении, а журнал решений отвечает только на вопрос «этот разбор ещё в силе».
 *
 * Отпечаток несёт версию алгоритма (`v1:`): канонизацию однажды придётся поменять, и без версии
 * это молча обесценило бы все прежние решения. Разделитель — управляющий символ, которого в
 * идентификаторах и датах не бывает: со склейкой через пустую строку две разные пары значений
 * дали бы один хеш, и решение по одному расхождению действовало бы на другое.
 */
function discrepancyFingerprint(
  kind: DiscrepancyKind,
  subject: string,
  parts: (string | null)[],
): string {
  return `v1:${sha256hex([kind, subject, ...parts.map((p) => p ?? '')].join('\u0001'))}`;
}

function discrepancySubject(d: {
  kind: DiscrepancyKind;
  itemId: string | null;
  sourceKind: ReadingSourceKind | null;
  sourceId: string | null;
}): string {
  return d.kind === 'missing_source' ? `${d.sourceKind}:${d.sourceId}` : `item:${d.itemId}`;
}

async function computeDiscrepancies(
  tx: Tx,
  report: DriverDailyReportRow,
  items: readonly DriverDailyReportItemRow[],
  dayRefs: readonly SourceRef[],
  live: Map<string, LiveSource>,
): Promise<ReportDiscrepancyDto[]> {
  const found: Omit<ReportDiscrepancyDto, 'resolved' | 'resolvedReason'>[] = [];

  for (const item of items) {
    const ref = itemRef(item);
    const source = live.get(sourceKey(ref));
    const label = source?.label ?? sourceKey(ref);
    if (!source || !source.active) {
      found.push({
        kind: 'source_state',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('source_state', `item:${item.id}`, [
          source ? 'cancelled' : 'deleted',
        ]),
        message: `${label}: ${discrepancyKindLabels.source_state}`,
      });
      continue;
    }
    if (source.personId !== report.personId) {
      found.push({
        kind: 'driver',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('driver', `item:${item.id}`, [
          source.personId,
          report.personId,
        ]),
        message: `${label}: ${discrepancyKindLabels.driver}`,
      });
    }
    if (source.vehicleId !== item.vehicleId) {
      found.push({
        kind: 'vehicle',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('vehicle', `item:${item.id}`, [
          source.vehicleId,
          item.vehicleId,
        ]),
        message: `${label}: ${discrepancyKindLabels.vehicle}`,
      });
    }
    if (!sourceCoversDate(source, item.reportDate)) {
      found.push({
        kind: 'date',
        itemId: item.id,
        sourceKind: ref.kind,
        sourceId: ref.id,
        fingerprint: discrepancyFingerprint('date', `item:${item.id}`, [
          source.date,
          source.periodFrom,
          source.periodTo,
          item.reportDate,
        ]),
        message: `${label}: ${discrepancyKindLabels.date}`,
      });
    }
  }

  // Состав дня: источник, которого в отчёте нет. Отпечаток берёт источник целиком — водителя,
  // машину, дату (у листа период) и состояние: источник, который «решили не включать», после
  // смены машины или водителя это уже другой источник, и прежнее решение к нему отношения не имеет.
  const present = new Set(items.map((i) => sourceKey(itemRef(i))));
  for (const ref of dayRefs) {
    const key = sourceKey(ref);
    if (present.has(key)) continue;
    const source = live.get(key);
    if (!source || !source.active) continue;
    found.push({
      kind: 'missing_source',
      itemId: null,
      sourceKind: ref.kind,
      sourceId: ref.id,
      fingerprint: discrepancyFingerprint('missing_source', key, [
        source.personId,
        source.vehicleId,
        source.date,
        source.periodFrom,
        source.periodTo,
        source.active ? 'active' : 'inactive',
      ]),
      message: `${source.label}: ${discrepancyKindLabels.missing_source}`,
    });
  }

  const decisions = await loadDecisions(tx, report.id);
  return found.map((d) => {
    const last = decisions.get(`${d.kind}|${discrepancySubject(d)}`);
    // Разобрано, если ПОСЛЕДНЕЕ событие журнала по предмету имеет совпадающий отпечаток и
    // разрешающий исход. `revoked` существует ради этого правила: отменить прежнее решение при
    // неизменном отпечатке иначе нечем.
    const resolved =
      last !== undefined && last.fingerprint === d.fingerprint && last.resolution !== 'revoked';
    return { ...d, resolved, resolvedReason: resolved ? last.reason : '' };
  });
}

/**
 * Действующее решение по каждому предмету. Последнее — по `report_version_after`, а не по времени:
 * всякая запись в журнал берёт отчёт `FOR UPDATE` и двигает его версию, поэтому версия строго
 * возрастает и задаёт причинный порядок. `now()` для этого не годится — в PostgreSQL это время
 * начала транзакции, и две записи, начатые одновременно, получили бы одну метку.
 */
async function loadDecisions(
  tx: Tx,
  reportId: string,
): Promise<Map<string, { fingerprint: string; resolution: string; reason: string }>> {
  const rows = await tx
    .select()
    .from(driverReportDiscrepancyResolutions)
    .where(eq(driverReportDiscrepancyResolutions.reportId, reportId))
    .orderBy(asc(driverReportDiscrepancyResolutions.reportVersionAfter));
  const last = new Map<string, { fingerprint: string; resolution: string; reason: string }>();
  for (const row of rows) {
    const subject =
      row.kind === 'missing_source'
        ? `${row.routeId ? 'route' : 'esm2'}:${row.routeId ?? row.waybillId}`
        : `item:${row.itemId}`;
    last.set(`${row.kind}|${subject}`, {
      fingerprint: row.fingerprint,
      resolution: row.resolution,
      reason: row.reason,
    });
  }
  return last;
}

/**
 * Разбор расхождения. Журнал append-only: `accepted_as_is → revoked → source_added` — три строки,
 * действует третья. Уникальности в таблице нет вовсе — диспетчер вправе передумать и на неизменном
 * расхождении, и второй записи UNIQUE не дал бы.
 */
export async function resolveDiscrepancy(
  reportId: string,
  input: DiscrepancyResolveInput,
  actorUserId: string,
): Promise<DriverReportDto> {
  const actor = staffActor(actorUserId);
  if (input.resolution === 'source_added' && input.kind !== 'missing_source') {
    throw err.badRequest('Добавить источник можно только там, где его не хватает');
  }
  const scouted = await db
    .select()
    .from(driverDailyReports)
    .where(eq(driverDailyReports.id, reportId));
  const head = scouted[0];
  if (!head) throw err.notFound('Отчёт дня не найден');
  const entries: DayEntry[] = await loadDayEntries(head.personId, head.reportDate);

  return db.transaction(async (tx) => {
    // Машина блокируется только там, где решение заводит строку: добавление занимает позицию
    // смены, а признание допустимым цепочки не касается.
    if (input.resolution === 'source_added' && input.sourceId && input.sourceKind) {
      const live = await loadLiveSources(tx, [{ kind: input.sourceKind, id: input.sourceId }]);
      const source = live.get(`${input.sourceKind}:${input.sourceId}`);
      if (source) await lockVehicles(tx, [source.vehicleId]);
    }
    const report = (await lockReports(tx, [reportId])).get(reportId);
    if (!report) throw err.notFound('Отчёт дня не найден');
    if (report.version !== input.version) {
      throw err.conflict('Отчёт изменился, обновите страницу и повторите');
    }
    const items = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.reportId, reportId));
    const dayRefs: SourceRef[] = entries.map((e) => ({ kind: e.sourceKind, id: e.sourceId }));
    await lockSources(tx, [...items.map(itemRef), ...dayRefs]);

    // Принадлежность предмета проверяется в момент записи, под уже взятой блокировкой отчёта:
    // ссылка в журнале историческая, и после переноса строки она законно разойдётся с текущей
    // принадлежностью (Р21а п. 9).
    if (input.itemId && !items.some((i) => i.id === input.itemId)) {
      throw err.badRequest('Строка не из этого отчёта — обновите страницу');
    }

    const live = await loadLiveSources(tx, [...items.map(itemRef), ...dayRefs]);
    const discrepancies = await computeDiscrepancies(tx, report, items, dayRefs, live);
    const target = discrepancies.find(
      (d) =>
        d.kind === input.kind &&
        d.itemId === input.itemId &&
        (input.kind !== 'missing_source' || d.sourceId === input.sourceId),
    );
    if (!target) throw err.conflict('Расхождение исчезло — обновите страницу');
    if (target.fingerprint !== input.fingerprint) {
      throw err.conflict('Расхождение изменилось с момента показа — разберите его заново');
    }

    let added: string | null = null;
    if (input.resolution === 'source_added') {
      added = await addLateSource(tx, report, target, live);
    }

    const change = await applyReportChange(
      tx,
      report,
      { contentChanged: added !== null, revive: added !== null },
      actor.userId,
    );
    if (added) {
      await writeReportEvent(tx, {
        reportId,
        event: 'item_added',
        payload: { source: added },
        reason: input.reason,
        contentVersion: change.row.contentVersion,
        reportVersion: change.row.version,
        changedBy: actor.userId,
      });
    }
    for (const event of change.implicit) {
      await writeReportEvent(tx, {
        reportId,
        event,
        reason: input.reason,
        contentVersion: change.row.contentVersion,
        reportVersion: change.row.version,
        changedBy: actor.userId,
      });
    }
    await tx.insert(driverReportDiscrepancyResolutions).values({
      reportId,
      kind: input.kind,
      itemId: input.kind === 'missing_source' ? null : input.itemId,
      routeId:
        input.kind === 'missing_source' && input.sourceKind === 'route' ? input.sourceId : null,
      waybillId:
        input.kind === 'missing_source' && input.sourceKind === 'esm2' ? input.sourceId : null,
      fingerprint: input.fingerprint,
      resolution: input.resolution,
      reason: input.reason,
      reportVersionAfter: change.row.version,
      resolvedBy: actor.userId,
    });
    // Разбор виден там же, где остальная жизнь отчёта, а не только в своей таблице.
    await writeReportEvent(tx, {
      reportId,
      event: 'discrepancy_resolved',
      payload: { kind: input.kind, resolution: input.resolution, fingerprint: input.fingerprint },
      reason: input.reason,
      contentVersion: change.row.contentVersion,
      reportVersion: change.row.version,
      changedBy: actor.userId,
    });
    return buildReportDto(tx, change.row, entries);
  });
}

/** Поздний источник: строка заводится хвостом позиций, ничего не перенумеровывая (Р24). */
async function addLateSource(
  tx: Tx,
  report: DriverDailyReportRow,
  target: ReportDiscrepancyDto,
  live: Map<string, LiveSource>,
): Promise<string> {
  if (!target.sourceKind || !target.sourceId) {
    throw err.badRequest('У расхождения не назван источник');
  }
  const key = `${target.sourceKind}:${target.sourceId}`;
  const source = live.get(key);
  if (!source || !source.active) throw err.conflict('Источник больше не существует');
  const [occupied] = await tx
    .select({ id: driverDailyReportItems.id })
    .from(driverDailyReportItems)
    .where(
      target.sourceKind === 'route'
        ? eq(driverDailyReportItems.routeId, target.sourceId)
        : and(
            eq(driverDailyReportItems.waybillId, target.sourceId),
            eq(driverDailyReportItems.reportDate, report.reportDate),
          ),
    );
  // Источник занят чужой строкой: молча переносить её нельзя — чужие цифры за чужой подписью в
  // чужом отчёте не появляются. Выход из тупика — явный перенос (`rebaseItem`, Р21а).
  if (occupied) {
    throw err.conflict('Источник уже стоит в другом отчёте — приведите строку к источнику');
  }
  await tx.insert(driverDailyReportItems).values({
    reportId: report.id,
    sourceKind: target.sourceKind,
    routeId: target.sourceKind === 'route' ? target.sourceId : null,
    waybillId: target.sourceKind === 'esm2' ? target.sourceId : null,
    vehicleId: source.vehicleId,
    reportDate: report.reportDate,
    shiftOrder: await nextShiftOrder(tx, source.vehicleId, report.reportDate),
  });
  return key;
}

// ── Перестановка позиций смен (Р24) ──

/**
 * Пакетная перестановка позиций машины за день. Не два `UPDATE`: у `report_items_chain_key` иначе
 * нет шанса — оно сработает на первой же строке, — поэтому проверка уникальности откладывается до
 * конца транзакции, и промежуточное состояние `1,1` законно.
 *
 * Ожидаемый прежний порядок и версии всех затронутых отчётов обязательны: без них два диспетчера
 * молча перезаписывают перестановку друг друга.
 */
export async function reorderShifts(
  input: ReportItemOrderInput,
  actorUserId: string,
): Promise<DriverReportDto[]> {
  const actor = staffActor(actorUserId);
  // Разведка без блокировок: задание затронутых отчётов читается заранее — состав дня своей
  // транзакции не касается, а под блокировками ходить во второе соединение незачем.
  const scouted = await db
    .select({
      item: driverDailyReportItems,
      personId: driverDailyReports.personId,
      reportDate: driverDailyReports.reportDate,
    })
    .from(driverDailyReportItems)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .where(
      and(
        eq(driverDailyReportItems.vehicleId, input.vehicleId),
        eq(driverDailyReportItems.reportDate, input.date),
      ),
    );
  const entriesByReport = new Map<string, DayEntry[]>();
  for (const row of scouted) {
    if (entriesByReport.has(row.item.reportId)) continue;
    entriesByReport.set(row.item.reportId, await loadDayEntries(row.personId, row.reportDate));
  }

  return db.transaction(async (tx) => {
    await lockVehicles(tx, [input.vehicleId]);
    if (scouted.length === 0) throw err.notFound('За этот день у машины нет строк ожидания');

    const reports = await lockReports(
      tx,
      scouted.map((s) => s.item.reportId),
    );
    for (const [id, report] of reports) {
      const expected = input.reportVersions[id];
      if (expected === undefined || expected !== report.version) {
        throw err.conflict('Отчёт изменился, обновите страницу и повторите');
      }
    }
    await lockSources(
      tx,
      scouted.map((s) => itemRef(s.item)),
    );
    const items = await tx
      .select()
      .from(driverDailyReportItems)
      .where(
        and(
          eq(driverDailyReportItems.vehicleId, input.vehicleId),
          eq(driverDailyReportItems.reportDate, input.date),
        ),
      )
      .orderBy(asc(driverDailyReportItems.shiftOrder));

    const current = items.map((i) => i.id);
    if (
      current.length !== input.expectedOrder.length ||
      current.some((id, index) => id !== input.expectedOrder[index])
    ) {
      throw err.conflict('Порядок смен уже изменили — обновите страницу и повторите');
    }
    assertPermutation(input, current);

    // Позиции пишутся одним заходом: `DEFERRED` даёт им пройти через промежуточное совпадение.
    await tx.execute(sql`SET CONSTRAINTS report_items_chain_key DEFERRED`);
    const byId = new Map(items.map((i) => [i.id, i]));
    const anchors: ChainAnchor[] = [];
    const movedReadings = await loadReadingsByItem(tx, current);
    const chain = emptyChainContext(actor.userId, input.reason);
    for (const line of input.order) {
      const item = byId.get(line.itemId);
      if (!item) throw err.badRequest('В присланном порядке есть строка не из этого дня');
      if (item.shiftOrder === line.shiftOrder) continue;
      anchors.push(anchorOf(item));
      anchors.push({ ...anchorOf(item), shiftOrder: line.shiftOrder });
      // Показание уезжает следом само: `ON UPDATE CASCADE` составного ключа снимка (Р18).
      await tx
        .update(driverDailyReportItems)
        .set({ shiftOrder: line.shiftOrder, updatedAt: new Date() })
        .where(eq(driverDailyReportItems.id, item.id));
      const reading = movedReadings.get(item.id);
      if (reading) chain.touchedReadingIds.add(reading.id);
    }

    await relinkChains(tx, anchors, chain);

    const result: DriverReportDto[] = [];
    for (const [id, report] of reports) {
      const change = await applyReportChange(tx, report, { contentChanged: true }, actor.userId);
      await writeReportEvent(tx, {
        reportId: id,
        event: 'shift_order_changed',
        payload: {
          vehicleId: input.vehicleId,
          date: input.date,
          order: input.order.filter((o) => byId.get(o.itemId)?.reportId === id),
        },
        reason: input.reason,
        contentVersion: change.row.contentVersion,
        reportVersion: change.row.version,
        changedBy: actor.userId,
      });
      for (const event of change.implicit) {
        await writeReportEvent(tx, {
          reportId: id,
          event,
          reason: input.reason,
          contentVersion: change.row.contentVersion,
          reportVersion: change.row.version,
          changedBy: actor.userId,
        });
      }
      result.push(await buildReportDto(tx, change.row, entriesByReport.get(id) ?? []));
    }
    return result;
  });
}

/** Новый порядок обязан быть перестановкой `1..N` того же множества строк — без дыр и повторов. */
function assertPermutation(input: ReportItemOrderInput, current: readonly string[]): void {
  if (input.order.length !== current.length) {
    throw err.badRequest(
      'Присылается полный порядок машины за день, а не пара переставляемых строк',
    );
  }
  const ids = new Set(input.order.map((o) => o.itemId));
  if (ids.size !== current.length || current.some((id) => !ids.has(id))) {
    throw err.badRequest('В присланном порядке не тот состав строк');
  }
  const positions = new Set(input.order.map((o) => o.shiftOrder));
  if (positions.size !== current.length) {
    throw err.badRequest('Позиции смен повторяются');
  }
  for (let i = 1; i <= current.length; i += 1) {
    if (!positions.has(i)) throw err.badRequest('Позиции смен должны идти подряд с первой');
  }
}

// ── Приведение снимка к источнику (Р21а) ──

/**
 * Явный перенос строки ожидания вслед за источником. Операция существует ради тупика, найденного
 * седьмым ревью: рейс из отправленного отчёта законно переназначили другому водителю, у первого
 * появилось расхождение, у второго — `missing_source`, а добавить источник ему нельзя, потому что
 * глобальный `UNIQUE (route_id)` занят чужой строкой. Без переноса показание навсегда осталось бы
 * у чужого водителя, чужой машины или чужого дня.
 *
 * Фаза разведки предшествует блокировкам намеренно: новую машину и целевой отчёт операция узнаёт
 * только из источника, а блокировать их надо раньше, чем читать под блокировкой.
 */
export async function rebaseItem(
  itemId: string,
  input: ReadingRebaseInput,
  actorUserId: string,
): Promise<DriverReportDto> {
  const actor = staffActor(actorUserId);
  // 1. Разведка без блокировок — своей короткой транзакцией: новую машину и целевой отчёт
  // операция узнаёт только из источника, а блокировать их надо раньше, чем читать под блокировкой.
  const scout = await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.id, itemId));
    if (!item) throw err.notFound('Строка ожидания не найдена');
    const live = await loadLiveSources(tx, [itemRef(item)]);
    const source = live.get(sourceKey(itemRef(item)));
    if (!source || !source.active) {
      throw err.conflict('Источник не существует — приводить снимок не к чему');
    }
    const personId = source.personId;
    if (!personId) throw err.badRequest('У источника нет работника: назначьте его и повторите');
    const date = source.date ?? item.reportDate;
    const [target] = await tx
      .select({ id: driverDailyReports.id })
      .from(driverDailyReports)
      .where(
        and(eq(driverDailyReports.personId, personId), eq(driverDailyReports.reportDate, date)),
      );
    return { item, source, personId, date, targetId: target?.id ?? null };
  });
  const scoutedItem = scout.item;
  const scoutedSource = scout.source;
  const targetDate = scout.date;
  const scoutedTargetId = scout.targetId;
  // Задание целевого дня — тоже разведкой: под блокировками ходить во второе соединение незачем.
  const targetEntries: DayEntry[] = await loadDayEntries(scout.personId, targetDate);

  return db.transaction(async (tx) => {
    // 2. Машины: прежняя и новая, с дедупликацией — у смены одной лишь даты машина одна.
    await lockVehicles(tx, [scoutedItem.vehicleId, scoutedSource.vehicleId]);

    // 3. Уровень отчётов целиком, и создание отсутствующего идёт здесь: подниматься за блокировкой
    // отчёта после источников общий порядок запрещает.
    const hasReading = (await loadReadingsByItem(tx, [itemId])).size > 0;
    let targetId = scoutedTargetId;
    if (!targetId) {
      const [created] = await tx
        .insert(driverDailyReports)
        .values({
          personId: scout.personId,
          reportDate: targetDate,
          // Закрытая строка молча в черновик не прячется: показание уже сдано.
          state: hasReading ? 'submitted' : 'draft',
          submittedAt: hasReading ? new Date() : null,
          createdBy: actor.userId,
        })
        .onConflictDoNothing({
          target: [driverDailyReports.personId, driverDailyReports.reportDate],
        })
        .returning({ id: driverDailyReports.id });
      // Конфликт означает, что отчёт возник между разведкой и вставкой: его версию клиент не
      // присылал, сверить её нечем — и это 409, а не тихое присоединение к чужому отчёту.
      if (!created) throw err.conflict('Отчёт цели появился только что — повторите операцию');
      targetId = created.id;
    }

    const reports = await lockReports(tx, [scoutedItem.reportId, targetId]);
    const sourceReport = reports.get(scoutedItem.reportId);
    const targetReport = reports.get(targetId);
    if (!sourceReport || !targetReport) throw err.conflict('Отчёт исчез, повторите операцию');
    for (const report of new Set([sourceReport, targetReport])) {
      // У только что созданного целевого отчёта версии от клиента не бывает по построению.
      if (report.id === targetId && !scoutedTargetId) continue;
      const expected = input.reportVersions[report.id];
      if (expected === undefined || expected !== report.version) {
        throw err.conflict('Отчёт изменился, обновите страницу и повторите');
      }
    }

    // 4. Источник `FOR SHARE` и перечитывание: вторая попытка вслепую взяла бы другие блокировки,
    // чем те, что уже держим, поэтому изменившийся источник — отказ, а не повтор.
    await lockSources(tx, [itemRef(scoutedItem)]);
    const live = await loadLiveSources(tx, [itemRef(scoutedItem)]);
    const source = live.get(sourceKey(itemRef(scoutedItem)));
    if (
      !source ||
      !source.active ||
      source.vehicleId !== scoutedSource.vehicleId ||
      source.personId !== scoutedSource.personId ||
      (source.date ?? scoutedItem.reportDate) !== targetDate
    ) {
      throw err.conflict('Источник изменился, повторите операцию');
    }

    const [item] = await tx
      .select()
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.id, itemId));
    if (!item) throw err.conflict('Строка ожидания исчезла, повторите операцию');
    if (
      item.reportId === targetId &&
      item.vehicleId === source.vehicleId &&
      item.reportDate === targetDate
    ) {
      throw err.badRequest('Снимок уже соответствует источнику');
    }

    // 5. Перенос: день, машина и отчёт берутся из источника, позиция — свободный хвост.
    const reading = (await loadReadingsByItem(tx, [itemId])).get(itemId);
    const chain = emptyChainContext(actor.userId, input.reason);
    if (reading) chain.touchedReadingIds.add(reading.id);
    const anchors: ChainAnchor[] = [anchorOf(item)];
    const shiftOrder = await nextShiftOrder(tx, source.vehicleId, targetDate);
    await tx
      .update(driverDailyReportItems)
      .set({
        reportId: targetId,
        reportDate: targetDate,
        vehicleId: source.vehicleId,
        shiftOrder,
        updatedAt: new Date(),
      })
      .where(eq(driverDailyReportItems.id, itemId));
    anchors.push({ vehicleId: source.vehicleId, reportDate: targetDate, shiftOrder });

    // 6. Перестройка цепочек обеих машин: у прежней строка ушла, у новой появилась.
    await relinkChains(tx, anchors, chain);

    // 7. Версии и истории обоих отчётов.
    const left = await tx
      .select({ id: driverDailyReportItems.id })
      .from(driverDailyReportItems)
      .where(eq(driverDailyReportItems.reportId, sourceReport.id));
    const sameReport = sourceReport.id === targetReport.id;
    if (!sameReport) {
      const sourceChange = await applyReportChange(
        tx,
        sourceReport,
        // 8. Опустевший исходный отчёт уходит в `voided`: принять пустой отчёт запрещает условие
        // непустоты (Р22), и без этого он висел бы в очереди приёмки навсегда.
        { contentChanged: true, voidReport: left.length === 0 && sourceReport.state !== 'draft' },
        actor.userId,
      );
      await writeReportEvent(tx, {
        reportId: sourceReport.id,
        event: 'item_removed',
        payload: { source: sourceKey(itemRef(item)), movedTo: targetId },
        reason: input.reason,
        contentVersion: sourceChange.row.contentVersion,
        reportVersion: sourceChange.row.version,
        changedBy: actor.userId,
      });
      for (const event of sourceChange.implicit) {
        await writeReportEvent(tx, {
          reportId: sourceReport.id,
          event,
          reason: input.reason,
          contentVersion: sourceChange.row.contentVersion,
          reportVersion: sourceChange.row.version,
          changedBy: actor.userId,
        });
      }
      // Пустой черновик не аннулируется, а убирается: он не хранит ни истории приёмки, ни чисел,
      // зато держал бы источник занятым.
      if (left.length === 0 && sourceChange.row.state === 'draft') {
        await tx.delete(driverDailyReports).where(eq(driverDailyReports.id, sourceReport.id));
      }
    }

    // Целевой отчёт при `sameReport` не менялся ни разу: смена одной лишь машины блокирует и
    // двигает версии однократно.
    const targetChange = await applyReportChange(
      tx,
      targetReport,
      { contentChanged: true, revive: true },
      actor.userId,
    );
    await writeReportEvent(tx, {
      reportId: targetId,
      event: 'item_added',
      payload: { source: sourceKey(itemRef(item)), movedFrom: sourceReport.id },
      reason: input.reason,
      contentVersion: targetChange.row.contentVersion,
      reportVersion: targetChange.row.version,
      changedBy: actor.userId,
    });
    for (const event of targetChange.implicit) {
      await writeReportEvent(tx, {
        reportId: targetId,
        event,
        reason: input.reason,
        contentVersion: targetChange.row.contentVersion,
        reportVersion: targetChange.row.version,
        changedBy: actor.userId,
      });
    }

    // 9. Решения по расхождениям не переносятся: они остались историей разбора в исходном отчёте,
    // а в целевом у расхождения другой предмет и другой отпечаток.
    return buildReportDto(tx, targetChange.row, targetEntries);
  });
}

// ── Чтение (Р13) ──

/** Отчёт дня работника: `null`, если оверлей ещё ни разу не открывали. */
export async function loadReport(personId: string, date: string): Promise<DriverReportDto | null> {
  const entries: DayEntry[] = await loadDayEntries(personId, date);
  return db.transaction(async (tx) => {
    const [report] = await tx
      .select()
      .from(driverDailyReports)
      .where(
        and(eq(driverDailyReports.personId, personId), eq(driverDailyReports.reportDate, date)),
      );
    return report ? buildReportDto(tx, report, entries) : null;
  });
}

/** Тот же отчёт со стороны персонала: очередь приёмки и карточка гаража знают его по номеру. */
export async function loadReportById(reportId: string): Promise<DriverReportDto> {
  const [head] = await db
    .select()
    .from(driverDailyReports)
    .where(eq(driverDailyReports.id, reportId));
  if (!head) throw err.notFound('Отчёт дня не найден');
  const entries: DayEntry[] = await loadDayEntries(head.personId, head.reportDate);
  return db.transaction(async (tx) => {
    const report = await reloadReport(tx, reportId);
    return buildReportDto(tx, report, entries);
  });
}

/**
 * Сборка DTO. Все подписи приходят готовыми (Р13): кабинет не знает ни идентификаторов типов ТС,
 * ни контрагентов — он рисует строки. Разности считает сервер: вычитание на стороне портала это
 * ошибки, которых потом не восстановить.
 */
async function buildReportDto(
  tx: Tx,
  report: DriverDailyReportRow,
  entries: readonly DayEntry[],
): Promise<DriverReportDto> {
  const state = await loadReportState(tx, report, entries);
  const labels = await loadVehicleLabels(
    tx,
    state.items.map((i) => i.vehicleId),
  );
  const readings = [...state.readings.values()];
  const previousIds = readings.flatMap((r) =>
    [r.previousOdometerId, r.previousEngineHoursId].filter((id): id is string => id !== null),
  );
  const previous = new Map<string, VehicleReadingRow>();
  if (previousIds.length > 0) {
    const rows = await tx
      .select()
      .from(vehicleReadings)
      .where(inArray(vehicleReadings.id, [...new Set(previousIds)]));
    for (const row of rows) previous.set(row.id, row);
  }
  const fileIds = new Map<string, string[]>();
  if (readings.length > 0) {
    const rows = await tx
      .select()
      .from(vehicleReadingFiles)
      .where(
        inArray(
          vehicleReadingFiles.readingId,
          readings.map((r) => r.id),
        ),
      )
      .orderBy(asc(vehicleReadingFiles.addedAt));
    for (const row of rows) {
      const list = fileIds.get(row.readingId) ?? [];
      list.push(row.fileId);
      fileIds.set(row.readingId, list);
    }
  }

  const [person] = await tx
    .select({ fullName: persons.fullName })
    .from(persons)
    .where(eq(persons.id, report.personId));
  const acceptedBy = report.acceptedBy
    ? await tx
        .select({ fullName: users.fullName })
        .from(users)
        .where(eq(users.id, report.acceptedBy))
    : [];

  const items: ReportItemDto[] = state.items.map((item) => {
    const ref = itemRef(item);
    const source = state.live.get(sourceKey(ref));
    const reading = state.readings.get(item.id);
    return {
      id: item.id,
      sourceKind: ref.kind,
      sourceId: ref.id,
      sourceLabel: source?.label ?? (ref.kind === 'route' ? 'Рейс удалён' : 'Лист удалён'),
      vehicleId: item.vehicleId,
      vehicleLabel: labels.get(item.vehicleId) ?? '',
      shiftOrder: item.shiftOrder,
      reading: reading ? readingDto(reading, previous, fileIds.get(reading.id) ?? []) : null,
    };
  });

  return {
    id: report.id,
    personId: report.personId,
    personName: person?.fullName ?? '',
    reportDate: report.reportDate,
    state: report.state,
    contentVersion: report.contentVersion,
    version: report.version,
    acceptedContentVersion: report.acceptedContentVersion,
    acceptedAt: report.acceptedAt?.toISOString() ?? null,
    acceptedByName: acceptedBy[0]?.fullName ?? '',
    items,
    discrepancies: state.discrepancies,
    // Приём — не кнопка, а четыре условия: портал показывает те же причины отказа, что проверит
    // сервер под блокировками.
    canAccept: state.blockers.length === 0,
    blockers: state.blockers,
  };
}

function readingDto(
  row: VehicleReadingRow,
  previous: Map<string, VehicleReadingRow>,
  fileIds: string[],
): VehicleReadingDto {
  const prevOdometer = row.previousOdometerId ? previous.get(row.previousOdometerId) : undefined;
  const prevEngineHours = row.previousEngineHoursId
    ? previous.get(row.previousEngineHoursId)
    : undefined;
  const engineHours = row.engineHours === null ? null : Number(row.engineHours);
  const prevEngineHoursValue =
    prevEngineHours?.engineHours == null ? null : Number(prevEngineHours.engineHours);
  return {
    id: row.id,
    itemId: row.itemId,
    kind: row.kind,
    odometerKm: row.odometerKm,
    engineHours,
    fuelFilledLiters: row.fuelFilledLiters === null ? null : Number(row.fuelFilledLiters),
    noDataReason: row.noDataReason,
    comment: row.comment,
    source: row.source,
    recordedAt: row.recordedAt.toISOString(),
    odometerAnomaly: row.odometerAnomaly
      ? {
          kind: row.odometerAnomaly,
          confirmed: row.odometerAnomalyConfirmedAt !== null,
          previousValue: prevOdometer?.odometerKm ?? null,
          previousDate: prevOdometer?.reportDate ?? null,
        }
      : null,
    engineHoursAnomaly: row.engineHoursAnomaly
      ? {
          kind: row.engineHoursAnomaly,
          confirmed: row.engineHoursAnomalyConfirmedAt !== null,
          previousValue: prevEngineHoursValue,
          previousDate: prevEngineHours?.reportDate ?? null,
        }
      : null,
    // Прирост к предшественнику: у начала ряда его нет — это состояние, а не ноль.
    odometerDelta:
      row.odometerKm !== null && prevOdometer?.odometerKm != null
        ? row.odometerKm - prevOdometer.odometerKm
        : null,
    engineHoursDelta:
      engineHours !== null && prevEngineHoursValue !== null
        ? Number((engineHours - prevEngineHoursValue).toFixed(1))
        : null,
    fileIds,
  };
}
