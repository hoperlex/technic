import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  maintenanceState,
  vehicleLabel,
  type AttachedFileDto,
  type MaintenanceBasis,
  type MaintenanceInput,
  type VehicleMaintenanceDto,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  driverDailyReports,
  files,
  users,
  vehicleCategories,
  vehicleMaintenance,
  vehicleMaintenanceFiles,
  vehicleModels,
  vehicleReadings,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { loadLastExpectedShiftDays, loadLastOdometers } from './readings-aggregate';
import { assertFilesAttachable, markFilesActive, scheduleFilesDeletion } from './request-files';

/**
 * Техобслуживание по пробегу (план «Показания техники», решения Р10—Р13, Р16, Р30): журнал актов и
 * «пробег с последнего ТО» — числом, которое портал не пересчитывает.
 *
 * Модуль держится на четырёх утверждениях, и каждое из них — ответ на конкретный способ соврать.
 *
 * 1. **`kmSince` — сумма дельт цепочки показаний с граничным якорем из акта** (Р11). Вычитание
 *    «последний одометр − одометр акта» отпадает: при замене счётчика оно даёт отрицательное число.
 *    Буквальный агрегат за период `[performed_on, on]` отпадает тоже — правило «обе точки пары
 *    внутри периода» (Р4) съедает первый участок, и на данных «09.08 — 100 000, ТО 10.08 с
 *    одометром 100 000, 11.08 — 100 300» пробег вышел бы нулевым вместо 300 км.
 * 2. **Одометр акта участвует ровно один раз — началом первого участка** (Р11а). Он реквизит
 *    документа: показания правят задним числом (ADR 0101), а число из акта обязано остаться тем,
 *    что записал механик.
 * 3. **Снимки дня ТО в сумму не идут, но их аномалии спрашиваются** (Р11б, Р11г). У акта есть дата
 *    и нет времени; зато замена счётчика в день обслуживания обязана быть замечена, иначе якорь
 *    остался бы от прибора, которого уже нет.
 * 4. **Незнание бывает двух видов, и флага поэтому два** (Р11в). `chainBroken` — в интервале был
 *    сброс: переход через него неизвестен и может быть большим. `lowerBound` — известного меньше,
 *    чем проехано: акт без одометра либо незакрытый хвост ожиданий. Состояние из этих трёх чисел
 *    собирает `maintenanceState` в контрактах, и собирает асимметрично: превышение норматива
 *    достоверно при любых флагах, а «ещё не пора» при поднятом флаге — уже нет.
 *
 * Второго ответа на «что показывал счётчик» здесь нет: последние показания и набор ожидаемых смен
 * спрашиваются у агрегата (`readings-aggregate.ts`), а цепочку строит модуль показаний при записи.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающей половине транзакция не нужна, пишущей — обязательна: DTO собирается до коммита. */
type Reader = Tx | typeof db;

// ── Что приходит снаружи ──

// Поля акта, которыми распоряжается форма, берутся типом `MaintenanceInput` из контрактов, а не
// описываются здесь вторично: состав полей уже задан схемой ручки, и двойник разошёлся бы с ней при
// первой же правке. `vehicleId` в них не входит намеренно — акт заводится на машину и на ней
// остаётся: «перенести ТО на другую единицу» означало бы переписать историю обеих.

/** Акт глазами расчёта: из всей записи ему нужны ровно дата и якорь (Р11, Р11а). */
export interface MaintenanceAnchor {
  performedOn: string;
  odometerKm: number | null;
}

/** Пробег с ТО и то, насколько ему можно верить (Р11в). */
export interface KmSinceResult {
  kmSince: number | null;
  chainBroken: boolean;
  lowerBound: boolean;
}

// ── Запись ТО и её подпись ──

const createdByUser = alias(users, 'maintenance_created_by');
const updatedByUser = alias(users, 'maintenance_updated_by');

const RECORD_COLUMNS = {
  id: vehicleMaintenance.id,
  vehicleId: vehicleMaintenance.vehicleId,
  performedOn: vehicleMaintenance.performedOn,
  odometerKm: vehicleMaintenance.odometerKm,
  documentNumber: vehicleMaintenance.documentNumber,
  note: vehicleMaintenance.note,
  version: vehicleMaintenance.version,
  createdAt: vehicleMaintenance.createdAt,
  createdByName: createdByUser.fullName,
  updatedAt: vehicleMaintenance.updatedAt,
  updatedByName: updatedByUser.fullName,
};

/** Строка записи с подписями. `updatedByName` пуст в базе, пока запись не правили. */
interface RecordRow {
  id: string;
  vehicleId: string;
  performedOn: string;
  odometerKm: number | null;
  documentNumber: string;
  note: string;
  version: number;
  createdAt: Date;
  createdByName: string;
  updatedAt: Date;
  updatedByName: string | null;
}

/** Автор обязателен, правивший — нет: `leftJoin` у второго, и пустая подпись означает «не правили». */
function recordsQuery(reader: Reader) {
  return reader
    .select(RECORD_COLUMNS)
    .from(vehicleMaintenance)
    .innerJoin(createdByUser, eq(createdByUser.id, vehicleMaintenance.createdBy))
    .leftJoin(updatedByUser, eq(updatedByUser.id, vehicleMaintenance.updatedBy));
}

/**
 * Сканы записей — одной выборкой на набор: запрос на строку означал бы запрос на строку истории.
 *
 * Отдаются они именем, типом и размером, а не одними идентификаторами, и это не удобство ответа:
 * форма ТО подписывала подшитое «Скан 1», потому что больше ей взять было неоткуда, — а по такой
 * подписи не видно ни что за документ, ни откроется ли он вообще. Тем же соединением с `files`
 * собирает свои фотографии журнал показаний (`loadReadingFiles`).
 *
 * `innerJoin`, а не `leftJoin`: строка связи без файла невозможна — её держит внешний ключ.
 */
async function loadFiles(
  reader: Reader,
  maintenanceIds: readonly string[],
): Promise<Map<string, AttachedFileDto[]>> {
  const found = new Map<string, AttachedFileDto[]>();
  const ids = [...new Set(maintenanceIds)];
  if (ids.length === 0) return found;
  const rows = await reader
    .select({
      maintenanceId: vehicleMaintenanceFiles.maintenanceId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
    })
    .from(vehicleMaintenanceFiles)
    .innerJoin(files, eq(files.id, vehicleMaintenanceFiles.fileId))
    .where(inArray(vehicleMaintenanceFiles.maintenanceId, ids))
    .orderBy(asc(vehicleMaintenanceFiles.addedAt));
  for (const row of rows) {
    const list = found.get(row.maintenanceId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
    });
    found.set(row.maintenanceId, list);
  }
  return found;
}

/**
 * `updatedByName` — пустая строка, пока запись не правили, как `acceptedByName` у отчёта дня:
 * портал показывает подпись, а не решает по ней, и `null` в этом поле ему пришлось бы разбирать.
 */
function toDto(row: RecordRow, scans: readonly AttachedFileDto[]): VehicleMaintenanceDto {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    performedOn: row.performedOn,
    odometerKm: row.odometerKm,
    documentNumber: row.documentNumber,
    note: row.note,
    files: [...scans],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedByName ?? '',
  };
}

async function loadRecordDto(reader: Reader, id: string): Promise<VehicleMaintenanceDto> {
  const [row] = await recordsQuery(reader).where(eq(vehicleMaintenance.id, id));
  if (!row) throw err.notFound('Запись обслуживания не найдена');
  const scans = await loadFiles(reader, [id]);
  return toDto(row, scans.get(id) ?? []);
}

// ── Расчёт пробега с ТО (Р11) ──

/** Точка цепочки: числовой снимок одометра со своим признаком сброса. */
interface ChainPoint {
  reportDate: string;
  odometerKm: number;
  reset: boolean;
}

/**
 * Числовые снимки одометра машин **начиная с дня ТО каждой из них** и по день среза.
 *
 * День ТО включён в выборку, хотя в сумму его снимки не идут (Р11б): их спрашивает правило Р11г —
 * сброс счётчика в день обслуживания обязан обнулить якорь. Отбирать его вторым запросом значило бы
 * дважды описать одно и то же условие «снимок этой машины, неаннулированный, с числом».
 *
 * Нижняя граница у каждой машины своя, поэтому условие — дизъюнкция пар, а не `IN` плюс общий
 * `report_date >= min(…)`: у машины с прошлогодним ТО общая граница притащила бы год чужих снимков
 * на каждую строку страницы гаража. Индекс `vehicle_readings_chain_idx` разбирает такую дизъюнкцию
 * BitmapOr'ом по паре (машина, день).
 *
 * Аннулированные отчёты пропускаются (Р27) — их показания уехали вместе со строками в другой отчёт
 * и считаются там.
 */
async function loadChainPoints(
  anchors: ReadonlyMap<string, MaintenanceAnchor>,
  onDate: string,
): Promise<Map<string, ChainPoint[]>> {
  const found = new Map<string, ChainPoint[]>();
  const pairs = [...anchors].map(([vehicleId, anchor]) =>
    and(
      eq(vehicleReadings.vehicleId, vehicleId),
      gte(vehicleReadings.reportDate, anchor.performedOn),
    ),
  );
  if (pairs.length === 0) return found;

  const rows = await db
    .select({
      vehicleId: vehicleReadings.vehicleId,
      reportDate: vehicleReadings.reportDate,
      odometerKm: vehicleReadings.odometerKm,
      anomaly: vehicleReadings.odometerAnomaly,
    })
    .from(vehicleReadings)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, vehicleReadings.reportId))
    .where(
      and(
        or(...pairs),
        lte(vehicleReadings.reportDate, onDate),
        eq(vehicleReadings.kind, 'values'),
        // Показание своего счётчика: смена с одними моточасами про пробег не говорит ничего, и
        // точкой цепочки одометра она не является.
        isNotNull(vehicleReadings.odometerKm),
        ne(driverDailyReports.state, 'voided'),
      ),
    )
    // Порядок цепочки — тот же, каким её строит модуль показаний: день без позиции смены не
    // различает две смены одной машины, и дельты сложились бы задом наперёд.
    .orderBy(
      asc(vehicleReadings.vehicleId),
      asc(vehicleReadings.reportDate),
      asc(vehicleReadings.shiftOrder),
    );

  for (const row of rows) {
    const list = found.get(row.vehicleId) ?? [];
    list.push({
      reportDate: row.reportDate,
      odometerKm: Number(row.odometerKm),
      reset: row.anomaly === 'counter_reset',
    });
    found.set(row.vehicleId, list);
  }
  return found;
}

/** Свёрнутая цепочка одной машины: числа плюс день, до которого пробег известен наверняка. */
interface FoldedChain extends KmSinceResult {
  kmSince: number;
  /**
   * День последнего числового снимка (либо сам день ТО, если снимков после него нет). Правее него
   * чисел нет по построению, и ровно по нему проверяется хвост ожиданий.
   */
  coveredTo: string;
}

/**
 * Сумма дельт цепочки с граничным якорем из акта (Р11) — ровно псевдокод плана, шаг в шаг.
 *
 * Разбор случаев здесь и есть весь модуль:
 *
 *   * **снимки дня ТО в расчёт не идут** (Р11б): у акта есть дата, но нет времени, и показание того
 *     же дня могло быть снято до обслуживания. Ничего при этом не теряется — якорь взят из акта, и
 *     первая же дельта после дня ТО накрывает остаток самого дня;
 *   * **но аномалии дня ТО спрашиваются** (Р11г): иначе замена счётчика в день обслуживания
 *     проходит мимо — снимок со сбросом отфильтрован правилом Р11б, якорь остаётся от старого
 *     прибора, и первый же снимок следующего дня даёт отрицательную дельту без единой пометки;
 *   * **сброс открывает новый участок**: его собственное значение становится якорем, а переход
 *     через сброс неизвестен и уходит в `chainBroken`;
 *   * **отрицательная дельта считается разрывом, а не вычитается** (Р11г): минус в пробеге — всегда
 *     чья-то потерянная пометка, и молча уменьшать наработку с ТО на этом основании нельзя;
 *   * **пропущенная смена сама по себе ничего не поднимает** (Р11в): цепочка назначает такой строке
 *     предшественником последний снимок с числом, и следующее числовое показание накрывает пропуск
 *     целиком — поэтому в цикле нет ни одной ветки про `no_data` и несданные строки.
 */
function foldChain(record: MaintenanceAnchor, points: readonly ChainPoint[]): FoldedChain {
  /** Граничная точка первого участка (Р11а): в формуле она участвует ровно один раз. */
  let anchor = record.odometerKm;
  /**
   * Акт без одометра — якоря нет вовсе, и известного заведомо меньше, чем проехано (Р11в). Флаг
   * считается один раз и по самому акту: обнуление якоря сбросом дня ТО поднимает `chainBroken`, а
   * не эту границу — там неизвестен переход, а не начало отсчёта.
   */
  const lowerBound = record.odometerKm === null;
  let chainBroken = false;
  let sum = 0;
  let coveredTo = record.performedOn;

  for (const point of points) {
    coveredTo = point.reportDate;
    if (point.reportDate <= record.performedOn) {
      // День ТО: в сумму не идёт (Р11б), но про сброс спрашивается (Р11г) — акт описывает прибор,
      // которого с этого момента уже нет, и якорь из него негоден.
      if (point.reset) {
        chainBroken = true;
        anchor = null;
      }
      continue;
    }
    if (point.reset) {
      chainBroken = true;
      anchor = point.odometerKm;
      continue;
    }
    if (anchor !== null) {
      if (point.odometerKm < anchor) chainBroken = true;
      else sum += point.odometerKm - anchor;
    }
    anchor = point.odometerKm;
  }

  return { kmSince: sum, chainBroken, lowerBound, coveredTo };
}

/**
 * Пробег с ТО по списку машин сразу — две выборки на страницу гаража, а не две на строку.
 *
 * Хвост ожиданий (Р11) спрашивается одним числом на машину: `loadLastExpectedShiftDays` отдаёт
 * последний день, на который машину ждали с показаниями, и сравнивается он с днём последнего
 * числового снимка. Сведение точное — правее последнего снимка чисел по определению нет, поэтому
 * любая ожидаемая смена там и есть «ожидаемая смена без чисел».
 *
 * Нижняя граница окна ожиданий — самый ранний из этих дней по набору: смены левее него ни одной
 * машине хвостом не станут, а спрашивать их пришлось бы у того же запроса.
 */
async function loadKmSinceBatch(
  anchors: ReadonlyMap<string, MaintenanceAnchor>,
  onDate: string,
): Promise<Map<string, KmSinceResult>> {
  const result = new Map<string, KmSinceResult>();
  if (anchors.size === 0) return result;

  const points = await loadChainPoints(anchors, onDate);
  const folded = new Map<string, FoldedChain>();
  let windowFrom: string | null = null;
  for (const [vehicleId, anchor] of anchors) {
    const chain = foldChain(anchor, points.get(vehicleId) ?? []);
    folded.set(vehicleId, chain);
    if (windowFrom === null || chain.coveredTo < windowFrom) windowFrom = chain.coveredTo;
  }

  const expected = await loadLastExpectedShiftDays([...anchors.keys()], windowFrom!, onDate);
  for (const [vehicleId, chain] of folded) {
    const lastExpected = expected.get(vehicleId);
    const openTail = lastExpected !== undefined && lastExpected > chain.coveredTo;
    result.set(vehicleId, {
      kmSince: chain.kmSince,
      chainBroken: chain.chainBroken,
      lowerBound: chain.lowerBound || openTail,
    });
  }
  return result;
}

/**
 * Пробег с одного конкретного акта на день среза (§5 плана).
 *
 * Дата среза приходит параметром, а не подразумевается «сегодня» (Р16): гараж спрашивает состояние
 * на выбранный день, и срез марта не должен считать майский пробег.
 */
export async function loadKmSince(
  vehicleId: string,
  maintenance: MaintenanceAnchor,
  onDate: string,
): Promise<KmSinceResult> {
  const batch = await loadKmSinceBatch(new Map([[vehicleId, maintenance]]), onDate);
  return batch.get(vehicleId) ?? { kmSince: null, chainBroken: false, lowerBound: false };
}

// ── Сводка ТО ──

interface VehicleHead {
  label: string;
  basis: MaintenanceBasis;
}

async function loadHeads(vehicleIds: readonly string[]): Promise<Map<string, VehicleHead>> {
  const rows = await db
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      modelName: vehicleModels.name,
      basis: vehicleTypes.maintenanceBasis,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(inArray(vehicles.id, [...vehicleIds]));
  return new Map(rows.map((row) => [row.id, { label: vehicleLabel(row), basis: row.basis }]));
}

/**
 * Последняя запись ТО каждой машины **не позже дня среза** (Р16): срез на 10.03 не показывает ТО,
 * проведённое 20.03, — иначе колонка гаража отвечала бы не про тот день, который у неё выбран.
 *
 * `DISTINCT ON` по индексу `vehicle_maintenance_vehicle_idx`, порядок — Р30: двух ТО в один день
 * ключ `performed_on` не различает, и «последнее» без `created_at` и `id` зависело бы от порядка
 * чтения строк.
 */
async function loadLastRecords(
  vehicleIds: readonly string[],
  onDate: string,
): Promise<Map<string, RecordRow>> {
  const rows = await db
    .selectDistinctOn([vehicleMaintenance.vehicleId], RECORD_COLUMNS)
    .from(vehicleMaintenance)
    .innerJoin(createdByUser, eq(createdByUser.id, vehicleMaintenance.createdBy))
    .leftJoin(updatedByUser, eq(updatedByUser.id, vehicleMaintenance.updatedBy))
    .where(
      and(
        inArray(vehicleMaintenance.vehicleId, [...vehicleIds]),
        lte(vehicleMaintenance.performedOn, onDate),
      ),
    )
    .orderBy(
      asc(vehicleMaintenance.vehicleId),
      desc(vehicleMaintenance.performedOn),
      desc(vehicleMaintenance.createdAt),
      desc(vehicleMaintenance.id),
    );
  return new Map(rows.map((row) => [row.vehicleId, row]));
}

/**
 * Сводка ТО по списку машин — для колонки гаража (§5).
 *
 * Машины без записи ТО в ответе есть и обязаны быть: «обслуживания не было» — это состояние
 * (`unknown` либо `not_tracked`), а не отсутствие ответа. Нет в ответе только тех, кого нет в базе.
 *
 * Цепочка считается лишь там, где ТО ведут и есть от чего считать: у типа с `basis = 'none'`
 * состояние `not_tracked` при любых числах (Р13), и платить за него выборкой показаний незачем.
 */
export async function loadMaintenanceSnapshot(
  vehicleIds: string[],
  onDate: string,
): Promise<Map<string, VehicleMaintenanceSummaryDto>> {
  const summaries = new Map<string, VehicleMaintenanceSummaryDto>();
  const ids = [...new Set(vehicleIds)];
  if (ids.length === 0) return summaries;

  const heads = await loadHeads(ids);
  const known = [...heads.keys()];
  if (known.length === 0) return summaries;

  const [lastRecords, odometers] = await Promise.all([
    loadLastRecords(known, onDate),
    // Последний одометр — единственное показание, видимое под правом ТО (Р14б): без него состояние
    // нечитаемо, «8 340 км с ТО» нечем проверить. Считает его тот же агрегат, что и колонку гаража.
    loadLastOdometers(known, onDate),
  ]);

  const anchors = new Map<string, MaintenanceAnchor>();
  for (const [vehicleId, head] of heads) {
    const record = lastRecords.get(vehicleId);
    if (head.basis !== 'none' && record) anchors.set(vehicleId, record);
  }
  const [distances, scans] = await Promise.all([
    loadKmSinceBatch(anchors, onDate),
    loadFiles(
      db,
      [...lastRecords.values()].map((row) => row.id),
    ),
  ]);

  for (const [vehicleId, head] of heads) {
    const record = lastRecords.get(vehicleId) ?? null;
    const odometer = odometers.get(vehicleId) ?? null;
    const distance = distances.get(vehicleId) ?? {
      kmSince: null,
      chainBroken: false,
      lowerBound: false,
    };
    summaries.set(vehicleId, {
      vehicleId,
      vehicleLabel: head.label,
      maintenanceBasis: head.basis,
      lastOdometer: odometer,
      lastMaintenance: record === null ? null : toDto(record, scans.get(record.id) ?? []),
      kmSince: distance.kmSince,
      chainBroken: distance.chainBroken,
      lowerBound: distance.lowerBound,
      // Состояние — ровно `maintenanceState` от полей выше: портал его не пересчитывает, и второго
      // места, где записано правило «просрочено», в системе нет.
      state: maintenanceState({ basis: head.basis, ...distance }),
    });
  }
  return summaries;
}

/**
 * Сводка ТО одной машины. `null` — машины нет вовсе; машина без единого акта — это законная сводка
 * с пустым `lastMaintenance`, а не отсутствие ответа.
 *
 * Считается тем же снапшотом, что и колонка списка: два ответа на «когда обслуживали» расходятся
 * при первой же правке одного из них.
 */
export async function loadMaintenanceSummary(
  vehicleId: string,
  onDate: string,
): Promise<VehicleMaintenanceSummaryDto | null> {
  const snapshot = await loadMaintenanceSnapshot([vehicleId], onDate);
  return snapshot.get(vehicleId) ?? null;
}

/**
 * История обслуживания машины целиком (Р10) в порядке Р30: `performed_on desc, created_at desc,
 * id desc`. Верхней границы по дате здесь нет намеренно — история это история, а срез дня
 * относится к сводке (Р16).
 */
export async function loadMaintenanceHistory(vehicleId: string): Promise<VehicleMaintenanceDto[]> {
  const rows = await recordsQuery(db)
    .where(eq(vehicleMaintenance.vehicleId, vehicleId))
    .orderBy(
      desc(vehicleMaintenance.performedOn),
      desc(vehicleMaintenance.createdAt),
      desc(vehicleMaintenance.id),
    );
  const scans = await loadFiles(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toDto(row, scans.get(row.id) ?? []));
}

/**
 * Подсказка ввода (Р15): последний известный одометр машины на день среза. Форма ТО показывает его
 * рядом с полем «пробег на момент обслуживания» — механик переписывает число с прибора, а портал
 * даёт ему сверить порядок величины.
 *
 * Своего расчёта здесь нет: это тот же `loadLastOdometers`, которым отвечают карточка и гараж.
 */
export async function loadOdometerHint(
  vehicleId: string,
  onDate: string,
): Promise<{ km: number; measuredOn: string } | null> {
  const odometers = await loadLastOdometers([vehicleId], onDate);
  return odometers.get(vehicleId) ?? null;
}

// ── Правка журнала ──

/**
 * Строка машины под `FOR UPDATE` (Р30) — первым шагом каждой транзакции модуля.
 *
 * Блокируется машина, а не запись: писатели встречаются на истории одной единицы (заведение,
 * правка, удаление соседней записи), и договориться о встрече они могут только на её строке. Запись
 * не годится по существу — той, которую заводят прямо сейчас, ещё нет.
 */
async function lockVehicle(tx: Tx, vehicleId: string): Promise<void> {
  const [row] = await tx
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .for('update');
  if (!row) throw err.notFound('Машина не найдена');
}

/**
 * Сканы записи: подшить новые, отвязать снятые. Владельца, живость и отсутствие чужих связей
 * проверяет общий файловый сервис, `file_is_linked` знает про `vehicle_maintenance_files` с той же
 * миграции 0147 — поэтому уже подшитое отсеивается первым: форма присылает `fileIds` целиком, и на
 * второй отправке общая проверка отвергла бы собственные же файлы записи.
 *
 * `requireActive` — как у показаний (Р18): `pending` это незавершённая загрузка, и ссылка на объект,
 * которого в хранилище может не быть вовсе, в учётном документе недопустима.
 */
async function syncFiles(
  tx: Tx,
  maintenanceId: string,
  fileIds: readonly string[],
  actorUserId: string,
): Promise<void> {
  const wanted = new Set(fileIds);
  const current = await tx
    .select({ fileId: vehicleMaintenanceFiles.fileId })
    .from(vehicleMaintenanceFiles)
    .where(eq(vehicleMaintenanceFiles.maintenanceId, maintenanceId));
  const mine = new Set(current.map((row) => row.fileId));

  const fresh = [...wanted].filter((id) => !mine.has(id));
  if (fresh.length > 0) {
    await assertFilesAttachable(tx, fresh, actorUserId, { requireActive: true });
    await markFilesActive(tx, fresh);
    await tx
      .insert(vehicleMaintenanceFiles)
      .values(fresh.map((fileId) => ({ maintenanceId, fileId })));
  }

  const dropped = [...mine].filter((id) => !wanted.has(id));
  if (dropped.length > 0) {
    const linked = await tx
      .select({ id: files.id, objectKey: files.objectKey })
      .from(vehicleMaintenanceFiles)
      .innerJoin(files, eq(files.id, vehicleMaintenanceFiles.fileId))
      .where(
        and(
          eq(vehicleMaintenanceFiles.maintenanceId, maintenanceId),
          inArray(vehicleMaintenanceFiles.fileId, dropped),
        ),
      );
    await tx
      .delete(vehicleMaintenanceFiles)
      .where(
        and(
          eq(vehicleMaintenanceFiles.maintenanceId, maintenanceId),
          inArray(vehicleMaintenanceFiles.fileId, dropped),
        ),
      );
    // Отложенно (+30 дней), как отвязка вложений во всех модулях: снятый по ошибке скан акта
    // выполненных работ обязан пережить эту ошибку.
    await scheduleFilesDeletion(tx, linked, false);
  }
}

/** Поля акта из формы. Пробелы срезаются здесь же: «  » и «» — это одно и то же пустое поле. */
function recordValues(input: MaintenanceInput) {
  if (input.odometerKm !== null && input.odometerKm < 0) {
    throw err.badRequest('Пробег в акте не может быть отрицательным');
  }
  return {
    performedOn: input.performedOn,
    odometerKm: input.odometerKm,
    documentNumber: input.documentNumber.trim(),
    note: input.note.trim(),
  };
}

/**
 * Завести акт обслуживания.
 *
 * Ни монотонности одометра, ни уникальности дня здесь не проверяется, и это решение, а не пропуск
 * (Р11а): ТО с пробегом меньше предыдущего — это замена прибора, а два ТО в один день — редкость,
 * запрет которой означал бы, что ошибку ввода исправляют только удалением записи. Предупреждение
 * про смену прибора показывает портал, отказывать база будет только отрицательному числу.
 */
export async function createMaintenance(
  vehicleId: string,
  input: MaintenanceInput,
  actorUserId: string,
): Promise<VehicleMaintenanceDto> {
  const values = recordValues(input);
  return db.transaction(async (tx) => {
    await lockVehicle(tx, vehicleId);
    const [created] = await tx
      .insert(vehicleMaintenance)
      .values({ vehicleId, ...values, createdBy: actorUserId })
      .returning({ id: vehicleMaintenance.id });
    await syncFiles(tx, created!.id, input.fileIds, actorUserId);
    return loadRecordDto(tx, created!.id);
  });
}

/**
 * Правка акта — с версией (Р30) и под блокировкой машины.
 *
 * **Правка записи в середине истории меняет интервалы соседей, и пересчитывать при этом нечего.**
 * Ни одно производное число не хранится: `kmSince`, флаги и состояние собираются на чтении из
 * цепочки показаний и якоря акта — и собираются заново при каждом запросе сводки. Это не экономия
 * кода, а единственный способ остаться правдой: показания правят задним числом (ADR 0101), и
 * сохранённый вчера «пробег с ТО» разошёлся бы с журналом молча, не тронув ни одной версии.
 *
 * Меняются от правки, стало быть, три вещи, и все — на следующем чтении: интервал самой записи,
 * интервал следующей записи (её первый участок начинается от нашего якоря) и предупреждение
 * предыдущей про смену прибора. Версия при этом поднимается только у правленой записи — намеренно:
 * `version` стережёт поля документа от потерянной правки, а не производный интервал, и подними мы
 * версии соседям, открытая рядом форма соседнего акта отказала бы человеку, который ничего не делал.
 *
 * Сверка версии — условием того же `UPDATE`, что и правит: отдельным `SELECT` она стерегла бы
 * прошлое. Блокировка машины взята раньше и держит второго писателя истории этой же единицы.
 */
export async function updateMaintenance(
  id: string,
  input: MaintenanceInput,
  version: number,
  actorUserId: string,
): Promise<VehicleMaintenanceDto> {
  const values = recordValues(input);
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({ vehicleId: vehicleMaintenance.vehicleId })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    if (!head) throw err.notFound('Запись обслуживания не найдена');
    await lockVehicle(tx, head.vehicleId);

    const [updated] = await tx
      .update(vehicleMaintenance)
      .set({
        ...values,
        version: sql`${vehicleMaintenance.version} + 1`,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(vehicleMaintenance.id, id), eq(vehicleMaintenance.version, version)))
      .returning({ id: vehicleMaintenance.id });
    if (!updated) throw err.conflict();

    await syncFiles(tx, id, input.fileIds, actorUserId);
    return loadRecordDto(tx, id);
  });
}

/**
 * Удалить акт — с версией (Р30) и под той же блокировкой машины.
 *
 * Сканы отвязываются явно и уходят на отложенное удаление из S3: каскад унёс бы строки связи молча,
 * и файл остался бы в хранилище сиротой — до уборки, которая заберёт его без следа в журнале.
 *
 * `actorUserId` принимается, но не пишется никуда: журнала удалений у ТО нет (плана на него тоже),
 * а расходиться подписью с `create`/`update` ручке нельзя — появись такой журнал, менять пришлось бы
 * его одного.
 */
export async function deleteMaintenance(
  id: string,
  version: number,
  _actorUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [head] = await tx
      .select({ vehicleId: vehicleMaintenance.vehicleId })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    if (!head) throw err.notFound('Запись обслуживания не найдена');
    await lockVehicle(tx, head.vehicleId);

    const linked = await tx
      .select({ id: files.id, objectKey: files.objectKey })
      .from(vehicleMaintenanceFiles)
      .innerJoin(files, eq(files.id, vehicleMaintenanceFiles.fileId))
      .where(eq(vehicleMaintenanceFiles.maintenanceId, id));

    const [removed] = await tx
      .delete(vehicleMaintenance)
      .where(and(eq(vehicleMaintenance.id, id), eq(vehicleMaintenance.version, version)))
      .returning({ id: vehicleMaintenance.id });
    if (!removed) throw err.conflict();

    await scheduleFilesDeletion(tx, linked, false);
  });
}
