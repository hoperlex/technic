import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  maintenanceState,
  vehicleLabel,
  type AttachedFileDto,
  type MaintenanceBasis,
  type MaintenanceInput,
  type MaintenancePartInput,
  type MaintenanceUpdateInput,
  type MaintenanceVoidInput,
  type VehicleMaintenanceDto,
  type VehicleMaintenancePartDto,
  type VehicleMaintenanceRecordDto,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  autoPartStockEntries,
  autoParts,
  driverDailyReports,
  files,
  users,
  vehicleCategories,
  vehicleMaintenance,
  vehicleMaintenanceFiles,
  vehicleMaintenanceParts,
  vehicleModels,
  vehicleReadings,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { assertCan } from '../lib/access';
import { writeAuditTx } from '../lib/audit';
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
 *
 * С выпуском автозапчастей (план `docs/auto-parts-plan.md`) к четырём утверждениям добавляются ещё
 * три — и все три про то, что акт стал **основанием складского расхода**:
 *
 * 5. **Склад двигает разница, а не форма** (Р5). Строки приходят полным набором, сервер под
 *    блокировкой сравнивает их с текущими и сам пишет движения: рост строки — `issue`, снижение и
 *    снятие — `return`. Клиенту не приходится знать, что его правка «3 → 1» это возврат двух штук,
 *    а базе — верить на слово: инвариант «количество строки = Σ issue − Σ return по паре (акт,
 *    позиция)» держат два отложенных constraint-триггера миграции `0188`.
 * 6. **Право спрашивается по эффекту, а не по полю тела** (Р19). `vehicleMaintenance.write` есть у
 *    пяти ролей, включая менеджера и диспетчера; движение склада требует `autoParts.stock` сверх
 *    него. Условие считается по фактической разнице под блокировкой — PATCH с теми же строками
 *    склад не двигает и второго права не требует, иначе диспетчер не смог бы поправить опечатку в
 *    номере документа у акта с расходом.
 * 7. **Ошибочный акт аннулируется, а не пустеет** (Р6). Акт с движением неудаляем — держит
 *    `RESTRICT` журнала, — а оставленный пустым он был бы последним обслуживанием машины и сдвигал
 *    бы «пробег с ТО» на ложный якорь. Поэтому расчёт (`последнее ТО`, `kmSince`, сводка, снапшот)
 *    читает только действующие акты — `voided_at IS NULL`, частичный индекс
 *    `vehicle_maintenance_active_idx`, — а история показывает аннулированный с причиной и автором.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающей половине транзакция не нужна, пишущей — обязательна: DTO собирается до коммита. */
type Reader = Tx | typeof db;

// ── Что приходит снаружи ──

// Поля акта, которыми распоряжается форма, берутся типом `MaintenanceInput` из контрактов, а не
// описываются здесь вторично: состав полей уже задан схемой ручки, и двойник разошёлся бы с ней при
// первой же правке. `vehicleId` в них не входит намеренно — акт заводится на машину и на ней
// остаётся: «перенести ТО на другую единицу» означало бы переписать историю обеих.

/**
 * Реквизиты акта — то общее, что есть и в теле заведения, и в теле правки. Строк расхода в них нет
 * намеренно: у двух ручек они означают РАЗНОЕ (Р18), и общий тип склеил бы это различие.
 */
type MaintenanceFields = Omit<MaintenanceInput, 'parts'>;

/**
 * Тело правки без версии — ровно то, что маршрут отдаёт сервису.
 *
 * `parts` здесь **необязателен, и это ключевое различие двух ручек** (Р18): «поля нет» означает
 * «строки не менять», а снять все можно только явным `parts: []`. У заведения то же отсутствие
 * означает пустой набор — у нового акта строк ещё нет. Склеены эти два случая быть не могут:
 * старая вкладка портала, открытая до выката и присылающая PATCH без нового поля, вернула бы на
 * склад весь расход акта молча — и механик увидел бы это в журнале задним числом.
 */
export type MaintenanceUpdateFields = Omit<MaintenanceUpdateInput, 'version'>;

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
const voidedByUser = alias(users, 'maintenance_voided_by');

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
  voidedAt: vehicleMaintenance.voidedAt,
  voidedByName: voidedByUser.fullName,
  voidReason: vehicleMaintenance.voidReason,
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
  /** `null` — акт действующий; тогда пусты и подпись, и причина (Р6, `CHECK`и пары и причины). */
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string;
}

/**
 * Автор обязателен, правивший — нет: `leftJoin` у второго, и пустая подпись означает «не правили».
 * Аннулировавший — третий такой же `leftJoin`: у действующего акта его нет по построению.
 */
function recordsQuery(reader: Reader) {
  return reader
    .select(RECORD_COLUMNS)
    .from(vehicleMaintenance)
    .innerJoin(createdByUser, eq(createdByUser.id, vehicleMaintenance.createdBy))
    .leftJoin(updatedByUser, eq(updatedByUser.id, vehicleMaintenance.updatedBy))
    .leftJoin(voidedByUser, eq(voidedByUser.id, vehicleMaintenance.voidedBy));
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
 * Реквизиты акта БЕЗ строк расхода (Р23) — то, что отдают сводка гаража и снапшот: они приходят
 * пакетом на всю видимую страницу парка, и позиции последнего акта там никому не нужны.
 *
 * `updatedByName` — пустая строка, пока запись не правили, как `acceptedByName` у отчёта дня:
 * портал показывает подпись, а не решает по ней, и `null` в этом поле ему пришлось бы разбирать.
 * Подпись аннулировавшего устроена так же, а вот `voidedAt` остаётся `null` — по нему портал
 * РЕШАЕТ (пометка, запрет правки, «Аннулировать» вместо «Удалить»), и пустая строка здесь означала
 * бы дату.
 */
function toRecordDto(
  row: RecordRow,
  scans: readonly AttachedFileDto[],
): VehicleMaintenanceRecordDto {
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
    voidedAt: row.voidedAt === null ? null : row.voidedAt.toISOString(),
    voidedByName: row.voidedByName ?? '',
    voidReason: row.voidReason,
  };
}

/**
 * Строки расхода набора актов — одной выборкой, как и сканы: запрос на акт означал бы запрос на
 * строку истории.
 *
 * Наименование, код и единица берутся соединением с **текущей** карточкой позиции, а не снимком
 * момента списания: позицию переименовывают и уточняют её артикул, и старый акт обязан называть
 * деталь так же, как её называет справочник, — иначе на один вопрос «что ставили» портал давал бы
 * два разных ответа. `innerJoin`: строка без позиции невозможна, её держит внешний ключ.
 */
async function loadParts(
  reader: Reader,
  maintenanceIds: readonly string[],
): Promise<Map<string, VehicleMaintenancePartDto[]>> {
  const found = new Map<string, VehicleMaintenancePartDto[]>();
  const ids = [...new Set(maintenanceIds)];
  if (ids.length === 0) return found;
  const rows = await reader
    .select({
      id: vehicleMaintenanceParts.id,
      maintenanceId: vehicleMaintenanceParts.maintenanceId,
      autoPartId: vehicleMaintenanceParts.autoPartId,
      name: autoParts.name,
      code: autoParts.code,
      unit: autoParts.unit,
      quantity: vehicleMaintenanceParts.quantity,
      note: vehicleMaintenanceParts.note,
    })
    .from(vehicleMaintenanceParts)
    .innerJoin(autoParts, eq(autoParts.id, vehicleMaintenanceParts.autoPartId))
    .where(inArray(vehicleMaintenanceParts.maintenanceId, ids))
    // Порядок — по наименованию: акт читают глазами, и порядок вставки строк формы для чтения
    // ничего не значит. `id` замыкает его, чтобы две одноимённых позиции не менялись местами.
    .orderBy(asc(autoParts.name), asc(vehicleMaintenanceParts.id));
  for (const row of rows) {
    const list = found.get(row.maintenanceId) ?? [];
    list.push({
      id: row.id,
      autoPartId: row.autoPartId,
      name: row.name,
      code: row.code,
      unit: row.unit,
      quantity: row.quantity,
      note: row.note,
    });
    found.set(row.maintenanceId, list);
  }
  return found;
}

/**
 * По каким актам склад уже двигали (Р6). Это НЕ «есть строки»: строки снимают правкой, а движения
 * по ним остаются навсегда — и именно они делают акт неудаляемым (`RESTRICT` журнала). Портал по
 * этому флагу заранее показывает «Аннулировать» вместо «Удалить», а не узнаёт правило из 409 после
 * нажатия.
 */
async function loadPartMovements(
  reader: Reader,
  maintenanceIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(maintenanceIds)];
  if (ids.length === 0) return new Set();
  const rows = await reader
    .selectDistinct({ maintenanceId: autoPartStockEntries.maintenanceId })
    .from(autoPartStockEntries)
    .where(inArray(autoPartStockEntries.maintenanceId, ids));
  return new Set(rows.flatMap((row) => (row.maintenanceId === null ? [] : [row.maintenanceId])));
}

/**
 * Акт целиком: реквизиты, сканы, строки расхода и признак движений (Р23). Три выборки на набор, а
 * не на строку, — и подряд, а не `Promise.all`: у транзакции одно соединение, и параллелить по нему
 * нечего.
 */
async function toFullDtos(
  reader: Reader,
  rows: readonly RecordRow[],
): Promise<VehicleMaintenanceDto[]> {
  const ids = rows.map((row) => row.id);
  const scans = await loadFiles(reader, ids);
  const parts = await loadParts(reader, ids);
  const moved = await loadPartMovements(reader, ids);
  return rows.map((row) => ({
    ...toRecordDto(row, scans.get(row.id) ?? []),
    parts: parts.get(row.id) ?? [],
    hasPartMovements: moved.has(row.id),
  }));
}

async function loadRecordDto(reader: Reader, id: string): Promise<VehicleMaintenanceDto> {
  const [row] = await recordsQuery(reader).where(eq(vehicleMaintenance.id, id));
  if (!row) throw err.notFound('Запись обслуживания не найдена');
  const [dto] = await toFullDtos(reader, [row]);
  return dto!;
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
 * Последняя **действующая** запись ТО каждой машины **не позже дня среза** (Р16): срез на 10.03 не
 * показывает ТО, проведённое 20.03, — иначе колонка гаража отвечала бы не про тот день, который у
 * неё выбран.
 *
 * `voided_at IS NULL` — половина решения Р6, и половина существенная: аннулированный акт остаётся
 * в истории, но последним обслуживанием быть перестаёт. Оставь его здесь — и ошибка ввода, которую
 * нельзя удалить (по акту прошло движение склада), молча сдвигала бы «пробег с ТО» на ложный
 * якорь: машина, которую пора обслуживать, показывала бы «в норме». Под это условие в схеме стоит
 * частичный индекс `vehicle_maintenance_active_idx`.
 *
 * `DISTINCT ON` по нему же, порядок — Р30: двух ТО в один день ключ `performed_on` не различает, и
 * «последнее» без `created_at` и `id` зависело бы от порядка чтения строк.
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
    .leftJoin(voidedByUser, eq(voidedByUser.id, vehicleMaintenance.voidedBy))
    .where(
      and(
        inArray(vehicleMaintenance.vehicleId, [...vehicleIds]),
        lte(vehicleMaintenance.performedOn, onDate),
        isNull(vehicleMaintenance.voidedAt),
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
      // Краткий DTO, без строк расхода (Р23): сводки приходят пакетом на всю видимую страницу
      // гаража, и загрузка позиций последнего акта для полусотни машин была бы платой за колонку,
      // которой нужны только дата и состояние.
      lastMaintenance: record === null ? null : toRecordDto(record, scans.get(record.id) ?? []),
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
 *
 * **Аннулированные акты здесь есть, и это не недосмотр фильтра** (Р6). Из расчёта они выпали —
 * `loadLastRecords` их не видит, — но документ никуда не делся: на него ссылается журнал склада, и
 * спрятать основание движения значило бы оставить в журнале запись, которую нечем прочитать.
 * История отдаёт его с пометкой, причиной и подписью аннулировавшего.
 *
 * Строки расхода и признак движений отдаются здесь, а не в сводке (Р23): историю открывают по одной
 * машине и читают глазами, сводка приходит пакетом на страницу.
 */
export async function loadMaintenanceHistory(vehicleId: string): Promise<VehicleMaintenanceDto[]> {
  const rows = await recordsQuery(db)
    .where(eq(vehicleMaintenance.vehicleId, vehicleId))
    .orderBy(
      desc(vehicleMaintenance.performedOn),
      desc(vehicleMaintenance.createdAt),
      desc(vehicleMaintenance.id),
    );
  return toFullDtos(db, rows);
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
): Promise<{ added: string[]; removed: string[] }> {
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

  // Что подшили и что сняли — не для ответа, а для аудита (Р22): сканы акта, ставшего основанием
  // списания, правятся свободно, и защита здесь не запрет, а след.
  return { added: fresh, removed: dropped };
}

// ── Расход автозапчастей: диффер строк и движения склада (Р5, Р7, Р19, Р24) ──

/**
 * Причины движений — НЕЙТРАЛЬНЫЕ и постоянные (Р5). Реквизиты акта в текст не вписываются
 * намеренно: дату, номер и машину акта правят после движения, и снимок «Обслуживание 12.08.2026,
 * В613ВУ197» разошёлся бы с документом, на который сам же и ссылается. Текущие реквизиты портал
 * показывает ссылкой (`auto_part_stock_entries.maintenance_id`), а их правку фиксирует аудит (Р22).
 *
 * Ручная корректировка остатка по-прежнему требует причины от человека — там снимка нет вовсе, и
 * объяснить «12 → 4» больше нечем.
 */
const ISSUE_REASON = 'Списание по акту обслуживания';
const RETURN_REASON = 'Возврат по акту обслуживания';
const VOID_RETURN_REASON = 'Возврат при аннулировании акта';

/**
 * Отказ по праву на движение склада (Р19). Говорит про право и про то, что остаётся доступным:
 * держатель `vehicleMaintenance.write` без `autoParts.stock` — это менеджер и диспетчер, и им надо
 * прочитать не «нельзя», а «реквизиты правьте, строки не ваши».
 */
const STOCK_DENIED =
  'Строки расхода двигают склад автозапчастей — на это нужно право «Правит остаток автозапчасти». ' +
  'Реквизиты акта правятся и без него.';

/** Карточка позиции под блокировкой: всё, что нужно проверке, событию и подписи аудита. */
interface LockedPart {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  isActive: boolean;
}

/** Строка расхода снимком — «было → стало» аудита правки (Р22). */
interface PartSnapshot {
  autoPartId: string;
  name: string;
  quantity: number;
  note: string;
}

/** Строки акта до и после правки — «было → стало» для аудита (Р22). */
interface PartsDiff {
  before: PartSnapshot[];
  after: PartSnapshot[];
}

/**
 * Позиции обеих сторон разницы под `FOR UPDATE` — **в порядке возрастания идентификатора** (Р5).
 *
 * Порядок здесь и есть смысл функции. Два акта, правящиеся одновременно и делящие две одинаковые
 * позиции, при произвольном порядке захвата дают взаимную блокировку (`40P01`), — и стоит защита от
 * неё ровно одной строчки `ORDER BY`: узел `LockRows` в PostgreSQL стоит НАД сортировкой, то есть
 * строки блокируются в том порядке, в каком их отдал `ORDER BY`, а не в том, в каком их нашёл
 * индекс. Тот же приём, что у `lockVehicles` цепочки показаний (Р24 плана показаний).
 *
 * Читаются позиции обеих сторон, включая неизменившиеся: их карточки нужны и проверке «позиция
 * погашена» (Р24), и подписям аудита, а вторая выборка ради строк, которых разница не коснулась,
 * прочитала бы то же самое дважды.
 */
async function lockAutoParts(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedPart>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: autoParts.id,
      name: autoParts.name,
      unit: autoParts.unit,
      quantity: autoParts.quantity,
      isActive: autoParts.isActive,
    })
    .from(autoParts)
    .where(inArray(autoParts.id, [...ids]))
    .orderBy(asc(autoParts.id))
    .for('update');
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Привести строки акта к присланному набору и записать разницу на склад (Р5).
 *
 * **Диффер, а не пара ручек «добавить/снять».** Форма правится целиком, строки приходят полным
 * набором, и сервер сам считает «стало − было» по каждой позиции: рост — `issue`, снижение и
 * снятие — `return`. Клиенту не приходится знать, что его правка «3 → 1» это возврат двух штук.
 *
 * **Порядок внутри транзакции жёсткий, и каждый шаг в нём — требование схемы:**
 *
 * 1. текущие строки и присланные объединяются, позиции берутся `FOR UPDATE` по возрастанию `id`
 *    (`lockAutoParts` выше) — иначе `40P01` на пересекающихся наборах;
 * 2. считается разница; **все нули — движения нет**, второго права не спрашиваем (Р19) и до склада
 *    не доходим вовсе. Правка одной пометки строки склад не двигает и потому проходит под правом
 *    на акт: разница считается по количеству, как и сказано в Р19;
 * 3. ненулевая разница → `assertCan('autoParts.stock')`; увеличение по погашенной позиции → 409
 *    (Р24); нехватка остатка → 409 словами «на складе N» ДО того, как сработает `CHECK` (Р7);
 * 4. на каждую разницу: `UPDATE auto_parts` → вставка события журнала. Порядок «карточка →
 *    событие» требует триггер цепочки `0187`: он сверяет «стало» события с фактическим остатком
 *    карточки, и обратный порядок отбил бы законное движение;
 * 5. и только потом строки акта приводятся к набору. Инвариант «количество строки = Σ issue −
 *    Σ return по паре» держат ОТЛОЖЕННЫЕ constraint-триггеры `0188` — внутри транзакции строка и
 *    движение законно расходятся, сойтись они обязаны к коммиту.
 *
 * `returnReason` параметром, потому что возврат бывает двух родов и человек обязан различать их в
 * ленте: правка акта — «Возврат по акту обслуживания», аннулирование — «Возврат при аннулировании
 * акта». Списание одно, и причина у него одна.
 */
async function syncParts(
  tx: Tx,
  maintenanceId: string,
  wanted: readonly MaintenancePartInput[],
  actor: Principal,
  returnReason: string,
): Promise<PartsDiff> {
  const current = await tx
    .select({
      autoPartId: vehicleMaintenanceParts.autoPartId,
      quantity: vehicleMaintenanceParts.quantity,
      note: vehicleMaintenanceParts.note,
    })
    .from(vehicleMaintenanceParts)
    .where(eq(vehicleMaintenanceParts.maintenanceId, maintenanceId));

  const was = new Map(current.map((row) => [row.autoPartId, row]));
  const now = new Map(wanted.map((row) => [row.autoPartId, row]));
  // Сортировка здесь ради определённости порядка ПРИМЕНЕНИЯ; порядок захвата держит `ORDER BY`
  // самого `SELECT … FOR UPDATE` — сортировать набор в приложении для этого недостаточно.
  const ids = [...new Set([...was.keys(), ...now.keys()])].sort();
  const cards = await lockAutoParts(tx, ids);
  const nameOf = (id: string): string => cards.get(id)?.name ?? id;

  const deltas = ids
    .map((autoPartId) => ({
      autoPartId,
      before: was.get(autoPartId)?.quantity ?? 0,
      after: now.get(autoPartId)?.quantity ?? 0,
    }))
    .filter((row) => row.before !== row.after);

  // Право по ЭФФЕКТУ, а не по полю тела (Р19): спрашивается после подсчёта разницы и под уже взятой
  // блокировкой позиций — до чтения строк разницы ещё не существует, и вынести проверку на страж
  // маршрута нечем. Манифест доступа называет это условие отдельным видом
  // (`effectConditionalPermissions`), а базовую половину — `vehicleMaintenance.write` — по-прежнему
  // объявляет страж.
  if (deltas.length > 0) assertCan(actor, 'autoParts.stock', STOCK_DENIED);

  for (const row of deltas) {
    const card = cards.get(row.autoPartId);
    // Позиции нет в справочнике: строка `wanted` ссылается в пустоту. Внешний ключ поймал бы это
    // позже и словами про ограничение, а списывать с несуществующей карточки мы начали бы раньше.
    if (!card) throw err.badRequest('Автозапчасть не найдена — обновите справочник и повторите');
    const delta = row.after - row.before;
    // Погашенная позиция: увеличить нельзя, уменьшить и снять можно (Р24). Проверка по РАЗНИЦЕ, а
    // не по наличию строки: иначе правка номера документа у старого акта с погашенной позицией
    // стала бы невозможной.
    if (delta > 0 && !card.isActive) {
      throw err.conflict(`Позиция «${card.name}» погашена — новое списание невозможно`, {
        code: 'auto_part_inactive',
      });
    }
    // Выдать больше, чем есть, нельзя (Р7) — и отвечает на это маршрут словами, а не `CHECK`
    // пятисоткой. Правило действует и для актов задним числом: нет детали сейчас — списать её
    // прошлым актом нельзя, законный обход виден и называется ручной корректировкой остатка.
    if (delta > 0 && card.quantity < delta) {
      // Два оборота, потому что случая два и путать их нельзя: новая строка списывает всё своё
      // количество, а увеличенная — только разницу («было 1, стало 6» берёт со склада пять, а не
      // шесть). Одна формулировка на оба врала бы в одном из них.
      const need =
        row.before === 0 ? `списываете ${delta}` : `строка требует ещё ${delta} сверх списанного`;
      throw err.conflict(`На складе «${card.name}»: ${card.quantity} ${card.unit}, ${need}`, {
        code: 'auto_part_shortage',
      });
    }
  }

  for (const row of deltas) {
    const card = cards.get(row.autoPartId)!;
    const delta = row.after - row.before;
    const quantityAfter = card.quantity - delta;
    // Сначала карточка (см. шаг 4 в подписи функции), потом событие.
    await tx
      .update(autoParts)
      .set({ quantity: quantityAfter, updatedAt: new Date() })
      .where(eq(autoParts.id, card.id));
    await tx.insert(autoPartStockEntries).values({
      autoPartId: card.id,
      // Вид события проставляет сервер: клиент его не выбирает и выдать расход за корректировку
      // (или наоборот) не может даже подделанным телом.
      entryKind: delta > 0 ? 'issue' : 'return',
      quantityBefore: card.quantity,
      quantityAfter,
      reason: delta > 0 ? ISSUE_REASON : returnReason,
      maintenanceId,
      changedBy: actor.id,
    });
  }

  const dropped = [...was.keys()].filter((id) => !now.has(id));
  if (dropped.length > 0) {
    await tx
      .delete(vehicleMaintenanceParts)
      .where(
        and(
          eq(vehicleMaintenanceParts.maintenanceId, maintenanceId),
          inArray(vehicleMaintenanceParts.autoPartId, dropped),
        ),
      );
  }
  for (const [autoPartId, line] of now) {
    const before = was.get(autoPartId);
    if (!before) {
      await tx
        .insert(vehicleMaintenanceParts)
        .values({ maintenanceId, autoPartId, quantity: line.quantity, note: line.note });
      continue;
    }
    // Строка, не изменившаяся ни количеством, ни пометкой, не переписывается: `updated_at` строки
    // отвечает на вопрос «когда её правили», и трогать его на каждом сохранении акта значило бы
    // стереть этот ответ.
    if (before.quantity === line.quantity && before.note === line.note) continue;
    await tx
      .update(vehicleMaintenanceParts)
      .set({ quantity: line.quantity, note: line.note, updatedAt: new Date() })
      .where(
        and(
          eq(vehicleMaintenanceParts.maintenanceId, maintenanceId),
          eq(vehicleMaintenanceParts.autoPartId, autoPartId),
        ),
      );
  }

  return {
    before: [...was].map(([autoPartId, line]) => ({
      autoPartId,
      name: nameOf(autoPartId),
      quantity: line.quantity,
      note: line.note,
    })),
    after: [...now].map(([autoPartId, line]) => ({
      autoPartId,
      name: nameOf(autoPartId),
      quantity: line.quantity,
      note: line.note,
    })),
  };
}

/** Строки акта словами журнала: «Фильтр масляный × 2». Пустой набор — «строк нет». */
function partsWords(rows: readonly PartSnapshot[]): string {
  if (rows.length === 0) return '';
  return rows.map((row) => `${row.name} × ${row.quantity}`).join(', ');
}

/** Поля акта из формы. Пробелы срезаются здесь же: «  » и «» — это одно и то же пустое поле. */
function recordValues(input: MaintenanceFields) {
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
 * Действующий акт или отказ (Р6). Аннулированный не правится и повторно не аннулируется: прошлое
 * не подчищают, его объясняют — исправление это новый акт. Свой код отказа, а не `version_conflict`:
 * исход у него другой — «откройте заново» здесь не поможет, документ закрыт навсегда.
 */
function assertActive(voidedAt: Date | null, refusal: string): void {
  if (voidedAt === null) return;
  throw err.conflict(`Акт аннулирован — ${refusal}. Исправление вводится новым актом`, {
    code: 'maintenance_voided',
  });
}

/**
 * Движений по акту не было — иначе удалять нельзя (Р6).
 *
 * Держит правило `RESTRICT` журнала, и проверка здесь стоит не вместо него, а ПЕРЕД ним: без неё
 * человек прочитал бы имя ограничения вместо того, что ему надо сделать. Ответ говорит и про
 * причину, и про выход — аннулирование.
 */
async function assertNoStockMovements(tx: Tx, maintenanceId: string): Promise<void> {
  const [movement] = await tx
    .select({ id: autoPartStockEntries.id })
    .from(autoPartStockEntries)
    .where(eq(autoPartStockEntries.maintenanceId, maintenanceId))
    .limit(1);
  if (!movement) return;
  throw err.conflict(
    'По акту прошёл расход автозапчастей — такой акт не удаляют, а аннулируют с причиной',
    { code: 'maintenance_has_stock_movements' },
  );
}

/** «Было → стало» по реквизитам акта (Р22): в журнал идут только те поля, которые изменились. */
function fieldChanges(
  fields: ReadonlyArray<readonly [string, string | number | null, string | number | null]>,
  extra: ReadonlyArray<readonly [string, string, string]>,
): Array<{ field: string; from: string; to: string }> {
  return [...fields, ...extra]
    .filter(([, from, to]) => from !== to)
    .map(([field, from, to]) => ({
      field,
      from: from === null ? '' : String(from),
      to: to === null ? '' : String(to),
    }));
}

/**
 * Завести акт обслуживания — вместе со строками расхода и движениями склада (Р5).
 *
 * Ни монотонности одометра, ни уникальности дня здесь не проверяется, и это решение, а не пропуск
 * (Р11а): ТО с пробегом меньше предыдущего — это замена прибора, а два ТО в один день — редкость,
 * запрет которой означал бы, что ошибку ввода исправляют только удалением записи. Предупреждение
 * про смену прибора показывает портал, отказывать база будет только отрицательному числу.
 *
 * `parts` у нового акта означает пустой набор, когда поля нет: строк у него ещё не было, снимать
 * нечего (Р18). Порядок шагов — акт, потом строки: у движения журнала ссылка на акт обязательна
 * (`auto_part_stock_links_check`), и записать её раньше, чем акт существует, нельзя.
 *
 * `actor` — принципал целиком, а не его идентификатор: движение склада требует `autoParts.stock`
 * сверх права на акт, а спросить это право можно только после подсчёта разницы под блокировкой
 * (Р19). Проверка живёт в `syncParts`.
 */
export async function createMaintenance(
  vehicleId: string,
  input: MaintenanceInput,
  actor: Principal,
): Promise<VehicleMaintenanceDto> {
  const values = recordValues(input);
  return db.transaction(async (tx) => {
    await lockVehicle(tx, vehicleId);
    const [created] = await tx
      .insert(vehicleMaintenance)
      .values({ vehicleId, ...values, createdBy: actor.id })
      .returning({ id: vehicleMaintenance.id });
    const maintenanceId = created!.id;
    const parts = await syncParts(tx, maintenanceId, input.parts, actor, RETURN_REASON);
    await syncFiles(tx, maintenanceId, input.fileIds, actor.id);
    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'vehicleMaintenance.create',
      entityType: 'vehicleMaintenance',
      entityId: maintenanceId,
      metadata: {
        vehicleId,
        performedOn: values.performedOn,
        odometerKm: values.odometerKm,
        documentNumber: values.documentNumber,
        files: input.fileIds.length,
        parts: partsWords(parts.after),
      },
    });
    return loadRecordDto(tx, maintenanceId);
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
 * прошлое. Блокировка машины взята раньше и держит второго писателя истории этой же единицы. Правка
 * реквизитов идёт ДО склада намеренно: разошедшаяся версия обязана отбить запрос раньше, чем он
 * тронет остаток, — иначе устаревшая форма списывала бы детали и только потом узнавала об отказе.
 *
 * **Отсутствие `parts` в теле означает «строки не менять»** (Р18) — тогда сюда приходит
 * `undefined`, диффер не зовётся вовсе, и ни склад, ни строки не шевелятся. Явный пустой массив
 * означает «снять все» и возвращает весь расход акта на склад. Аннулированный акт не правится
 * (Р6): исправление — новый акт.
 */
export async function updateMaintenance(
  id: string,
  input: MaintenanceUpdateFields,
  version: number,
  actor: Principal,
): Promise<VehicleMaintenanceDto> {
  const values = recordValues(input);
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({
        vehicleId: vehicleMaintenance.vehicleId,
        performedOn: vehicleMaintenance.performedOn,
        odometerKm: vehicleMaintenance.odometerKm,
        documentNumber: vehicleMaintenance.documentNumber,
        note: vehicleMaintenance.note,
        voidedAt: vehicleMaintenance.voidedAt,
      })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    if (!head) throw err.notFound('Запись обслуживания не найдена');
    await lockVehicle(tx, head.vehicleId);
    // Состояние прочитано до блокировки, и аннулирование, успевшее пройти между чтением и
    // захватом, эту проверку минует — но не пройдёт дальше: аннулирование поднимает версию, и
    // условие `UPDATE` ниже отобьёт правку конфликтом версий. Разница только в словах отказа.
    assertActive(head.voidedAt, 'правка невозможна');

    const [updated] = await tx
      .update(vehicleMaintenance)
      .set({
        ...values,
        version: sql`${vehicleMaintenance.version} + 1`,
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(vehicleMaintenance.id, id), eq(vehicleMaintenance.version, version)))
      .returning({ id: vehicleMaintenance.id });
    if (!updated) throw err.conflict();

    // `undefined` — поля в теле не было: строки не трогаем (Р18). Пустой массив — «снять все».
    const parts =
      input.parts === undefined
        ? null
        : await syncParts(tx, id, input.parts, actor, RETURN_REASON);
    const scans = await syncFiles(tx, id, input.fileIds, actor.id);

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'vehicleMaintenance.update',
      entityType: 'vehicleMaintenance',
      entityId: id,
      metadata: {
        vehicleId: head.vehicleId,
        changes: [
          ...fieldChanges(
            [
              ['performedOn', head.performedOn, values.performedOn],
              ['odometerKm', head.odometerKm, values.odometerKm],
              ['documentNumber', head.documentNumber, values.documentNumber],
              ['note', head.note, values.note],
            ],
            // Строки акта — такая же строка «было → стало», а не отдельный раздел: аудит читают
            // сверху вниз, и вынесенный расход пришлось бы искать глазами.
            parts === null
              ? []
              : [['parts', partsWords(parts.before), partsWords(parts.after)]],
          ),
        ],
        // Сканы правятся свободно, но под аудит (Р22): требования «после списания акт обязан иметь
        // скан» нет — акт и сегодня законно бывает бумажным, — а вот след правки есть всегда.
        ...(scans.added.length > 0 || scans.removed.length > 0
          ? { files: { added: scans.added, removed: scans.removed } }
          : {}),
      },
    });
    return loadRecordDto(tx, id);
  });
}

/**
 * Аннулировать акт — с версией, причиной и возвратом всего расхода на склад (Р6).
 *
 * **Зачем аннулирование вообще есть.** Акт, по которому прошло движение склада, неудаляем: держит
 * `RESTRICT` журнала, и это правило схемы, а не вежливость маршрута. Оставь такой ошибочный акт
 * пустым — и он останется последним обслуживанием машины, а «пробег с ТО» начнёт считаться от
 * ложного якоря: машина, которую пора обслуживать, покажет «в норме». Ошибка ввода не должна молча
 * ломать нормативный контроль, и ответ на неё — вывести документ из расчёта, а не подчистить.
 *
 * Одна транзакция и строгий порядок: блокировка машины → сверка версии и состояния → строки
 * `FOR UPDATE` в том же порядке, что и у правки → `autoParts.stock`, если строки есть (Р19) → по
 * каждой строке `return` с причиной «Возврат при аннулировании акта» и снятие строки → три поля
 * аннулирования → аудит. Возврат идёт тем же диффером, что и правка «снять все строки»: второго
 * места, где склад узнаёт про акт, в модуле нет.
 *
 * Аннулированный акт **остаётся в истории** — на него ссылается журнал склада, и спрятать основание
 * движения значило бы оставить в журнале запись, которую нечем прочитать. Повторное аннулирование и
 * правка отбиваются 409: прошлое не подчищают, его объясняют.
 */
export async function voidMaintenance(
  id: string,
  input: MaintenanceVoidInput,
  actor: Principal,
): Promise<VehicleMaintenanceDto> {
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({ vehicleId: vehicleMaintenance.vehicleId })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    if (!head) throw err.notFound('Запись обслуживания не найдена');
    await lockVehicle(tx, head.vehicleId);

    // Состояние перечитывается ПОД блокировкой: «уже аннулирован» и «версия разошлась» — разные
    // отказы с разными словами, и различить их условием одного `UPDATE` нечем.
    const [state] = await tx
      .select({ version: vehicleMaintenance.version, voidedAt: vehicleMaintenance.voidedAt })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    assertActive(state!.voidedAt, 'повторное аннулирование невозможно');
    if (state!.version !== input.version) throw err.conflict();

    const parts = await syncParts(tx, id, [], actor, VOID_RETURN_REASON);

    const [voided] = await tx
      .update(vehicleMaintenance)
      .set({
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: input.reason,
        // Версия поднимается: у аннулированного акта форма больше не откроется на правку, а вот
        // удаление и повторный запрос обязаны увидеть, что документ изменился.
        version: sql`${vehicleMaintenance.version} + 1`,
      })
      .where(and(eq(vehicleMaintenance.id, id), eq(vehicleMaintenance.version, input.version)))
      .returning({ id: vehicleMaintenance.id });
    if (!voided) throw err.conflict();

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'vehicleMaintenance.void',
      entityType: 'vehicleMaintenance',
      entityId: id,
      metadata: {
        vehicleId: head.vehicleId,
        reason: input.reason,
        // Что вернулось на склад — словами: по журналу разбирают «почему остаток вырос», и число
        // строк на этот вопрос не отвечает.
        returned: partsWords(parts.before),
      },
    });
    return loadRecordDto(tx, id);
  });
}

/**
 * Удалить акт — с версией (Р30) и под той же блокировкой машины.
 *
 * **Удаление остаётся ровно для акта, по которому движений склада не было** (Р6): опечатку первого
 * дня убирают как раньше. Акт с движениями удалить нельзя — это держит `RESTRICT` журнала, — и
 * отвечает на попытку маршрут словами про автозапчасти, а не именем ограничения: человек обязан
 * прочитать, что делать вместо (аннулировать), а не что сломалось.
 *
 * Строки акта при удалении уносит каскад, и уносить ему нечего: строка без движения не проходит
 * инвариант `0188`, то есть у акта без движений строк не бывает вовсе.
 *
 * Сканы отвязываются явно и уходят на отложенное удаление из S3: каскад унёс бы строки связи молча,
 * и файл остался бы в хранилище сиротой — до уборки, которая заберёт его без следа в журнале.
 */
export async function deleteMaintenance(
  id: string,
  version: number,
  actor: Principal,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [head] = await tx
      .select({
        vehicleId: vehicleMaintenance.vehicleId,
        performedOn: vehicleMaintenance.performedOn,
        documentNumber: vehicleMaintenance.documentNumber,
      })
      .from(vehicleMaintenance)
      .where(eq(vehicleMaintenance.id, id));
    if (!head) throw err.notFound('Запись обслуживания не найдена');
    await lockVehicle(tx, head.vehicleId);
    await assertNoStockMovements(tx, id);

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
    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'vehicleMaintenance.delete',
      entityType: 'vehicleMaintenance',
      entityId: id,
      metadata: {
        vehicleId: head.vehicleId,
        performedOn: head.performedOn,
        documentNumber: head.documentNumber,
      },
    });
  });
}
