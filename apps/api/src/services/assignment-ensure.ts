import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  canCancelWaybill,
  dateKeysBetween,
  moscowDateKeyOf,
  shiftDateKey,
  type AssignmentChangeTarget,
  type AssignmentHistoryState,
  type DriverState,
  type Esm2Sheet,
  type VehicleOwnership,
} from '@technic/contracts';
import { requestIsLinearSql } from '../db/linear-mode';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleTypes,
  vehicles,
  waybills,
} from '../db/schema';
import { AppError, err } from '../lib/errors';
import {
  assignmentSegments,
  assignmentStateOn,
  sameDriverState,
  type AssignmentChangeRow,
  type AssignmentTerm,
} from './assignment-history';
import {
  applyAssignmentMutations,
  assertAssignmentDenormalization,
  readAssignmentChanges,
  type AssignmentChangeRecord,
  type AssignmentWriteMutation,
  type AssignmentWriteTx,
} from './assignment-write';
import { esm2PaperSegments } from './esm2-plan';

/**
 * Готовность истории назначения: ленивый бэкфилл заявки и три её состояния
 * (`docs/assignment-periods-plan.md`, Р19, Р20, Р25–Р27, Р30, §6 «Бэкфилл»; миграции `0166`/`0167`).
 *
 * ЗАЧЕМ ОН. У заявки, заведённой до модуля, истории назначения нет вовсе: чем и с кем она работала,
 * записано в денормализации («машина одна на весь срок») и в уже выписанных недельных листах ЭСМ-2.
 * Прежде чем менять что-нибудь **внутри** срока, историю надо восстановить из того, что есть, —
 * иначе первая же команда либо перепишет весь срок одним составом, либо упрётся в инвариант Р16 на
 * январе, которого никто не трогал. Восстановление это и есть бэкфилл, и здесь он **ленивый**:
 * срабатывает при первом обращении к заявке, под уже взятой блокировкой. Массовый прогон по всей
 * базе — этап 4 и другой код; этот модуль — его же правила, приложенные к одной заявке.
 *
 * ДВЕ ПОЛОВИНЫ, И ЭТО ГЛАВНОЕ РЕШЕНИЕ МОДУЛЯ (Р20). Расчёт (`readAssignmentHistorySnapshot` +
 * `computeAssignmentHistory`, они же вместе — `planAssignmentHistory`) не пишет ничего и годится
 * предпросмотру, который вызывается дважды подряд и записывающим быть не вправе. Запись
 * (`ensureAssignmentHistory`) — вторая половина, и звать её можно только там, где команда уже
 * решила исполняться. Нарушить это не выйдет молча: `ensureAssignmentHistory` первым делом
 * спрашивает транзакцию, умеет ли она писать, и на читающем прокси фазы расчёта
 * (`readOnlyTx`, [assignment-command.ts](./assignment-command.ts)) отказывает с указанием правила —
 * даже в том случае, когда писать ей в итоге было бы нечего.
 *
 * ПОЧЕМУ `ensure` — НЕ ШАГ КАРКАСА. Канон §8 держит `runAssignmentCommand`, и материализация стоит
 * в нём шагом 5 — то есть **в фазе расчёта**, где транзакция читающая. Так и задумано: Р20 требует
 * порядка «построить историю в памяти → наложить якоря → проверить инвариант и бумагу → и только
 * тогда записать», а значит шаг 5 это `planAssignmentHistory`, а запись — часть шага 11. Сверх
 * этого у `ensure` есть два вызывающих, которые командами не являются вовсе: восстановление из
 * архива (Р28 — ни отпечатка, ни версии, ни якорей) и maintenance-скрипт массового прогона (этап 4
 * — ни тела запроса, ни автора). Оба обязаны получить ту же материализацию, что и дверь, поэтому
 * функция живёт отдельно и требует от вызывающего одного: `lockRequestRow` уже взят. Сама она
 * блокировок не берёт по той же причине, что и ядро записи, — взяв их вторым местом, она
 * перевернула бы канонический порядок захвата у двери, которая уже держит рейсы.
 *
 * КТО ЗОВЁТ ЭТО СЕГОДНЯ. Обе половины разведены по своим шагам у всех трёх дверей истории — команда
 * машиниста ([assignment-crew.ts](./assignment-crew.ts)), периодная коррекция
 * ([assignment-correction.ts](./assignment-correction.ts)) и ремонт
 * ([vehicle-request-assignment-repair.ts](../routes/vehicle-request-assignment-repair.ts)) считают
 * шагом 5 и записывают шагом 11 (`ensureCommandHistory`), — плюс восстановление из архива (Р28,
 * `POST /vehicle-requests/:id/restore`), которое зовёт `ensure` напрямую: отпечатка и якорей у него
 * нет, и предметной команды тоже. Массовый прогон этапа 4 придёт четвёртым и тем же входом.
 *
 * ЗАЧЕМ ЭТО ВАЖНО ЗНАТЬ. Пока `ensure` не звал никто, метка `assignment_history_dirty` только
 * поднималась: ставят её четыре ручки смен и ручная выписка `on_demand`
 * ([assignment-dirty.ts](./assignment-dirty.ts)), а снимает — единственная revalidation, и она
 * живёт здесь. Отдельной функции у неё нет намеренно: снять метку вправе лишь тот, кто пересчитал
 * состояние, а пересчитывает его только этот модуль, и вторая дверь к той же колонке дала бы второй
 * ответ на вопрос «когда заявка стала `ready`».
 *
 * ЧТО МОДУЛЬ ВОССТАНАВЛИВАЕТ ЧЕСТНО, А ЧТО — НЕ БЕРЁТСЯ ВОССТАНАВЛИВАТЬ. Правила §6 «Бэкфилл»
 * выписаны ниже дословно, и два из них важнее прочих. Первое: человек **назад не тянется** —
 * начало срока раньше первого листа получает `driver_state = 'unknown'`, потому что о тех днях
 * бумага молчит, а приписать им того, кто нашёлся в первом листе, значило бы уверенно утверждать
 * неизвестное (Р19). Второе: заявка, историю которой из бумаги однозначно не построить —
 * неоднозначные листы, пересечения периодов, отсутствующее назначение, — **не восстанавливается
 * вовсе**: ни строки, ни состояния, и вызывающий получает причину. «Как получится» здесь хуже, чем
 * ничего: заявку без истории видно, а заявку с выдуманной историей — нет.
 *
 * ИЗВЕСТНАЯ ГРАНИЦА (Ф-узкое плана). Аренда бумаги не оставляет, поэтому **голова и середина**
 * срока, отработанные арендной техникой, восстановлению не поддаются: они достанутся машине из
 * назначения, и история будет утверждать неверное вместо честного `unknown`. Здесь этого не
 * чинится и эвристик не заводится — граница записана в плане и сохраняется такой, какая есть;
 * расширение двери ремонта до правки машины внутри срока названо кандидатом следующей волны.
 */

// ── Состояния, блокеры и предупреждения ──

/**
 * Блокер валидности — пара «дата и вид» (Р27).
 *
 * Единица именно пара, а не день: видов два, и подмена одного другим на том же дне («история не
 * знает» вместо «машинист снят») формально сошла бы за частичный ремонт, а по существу это другой
 * дефект. Дни — проекция для карточки и отчёта, считать по ним сравнение множеств нельзя.
 *
 * Незаданная шкала машиниста (`driver: null` у `portal`-отрезка) считается видом `unknown`: для
 * бумаги это то же самое признание неполноты, а третий вид блокера сделал бы сравнение Р27
 * несопоставимым с историей, восстановленной бэкфиллом.
 */
export interface AssignmentHistoryBlocker {
  date: string;
  kind: 'unknown' | 'cleared';
}

/**
 * Расхождение хвоста (Р30): машина назначения не та, что стоит в последнем активном
 * vehicle-изменении истории.
 *
 * Это **предупреждение, а не блокер**: история с бумагой сходится, расходится лишь денормализация.
 * Заявка получает `ready`, а расхождение уходит в отчёт и в карточку — с обеими машинами поимённо.
 * Считается по хвосту истории, а не по последнему листу: после решения `assignment_wins` лист
 * остаётся на прежней машине, и признак, привязанный к бумаге, висел бы вечно.
 */
export interface AssignmentHistoryWarning {
  kind: 'tail_vehicle_mismatch';
  historyVehicleId: string;
  assignmentVehicleId: string;
}

/**
 * Почему история не восстановлена. Каждая причина означает одно и то же последствие: не записано
 * ничего, состояние осталось `empty`, заявка видна и разбирается человеком.
 *
 * - `no_assignment` — назначения у заявки нет, а из него берётся машина начала срока и хвоста:
 *   восстанавливать нечем и не от чего (§13, «неудачный ленивый бэкфилл не оставляет ни строк, ни
 *   состояния»);
 * - `ambiguous_sheets` — у нелинейной заявки два действующих листа с одним `period_from` и разными
 *   машинами. База это разрешает (`waybills_source_request_period_unique` ведёт по машине тоже), а
 *   одной временной шкалы из них не построить;
 * - `overlapping_sheets` — периоды действующих листов нелинейной заявки пересекаются: та же
 *   неоднозначность, только без совпадения начал.
 */
export type AssignmentHistoryUnrestorable =
  | { kind: 'no_assignment' }
  | { kind: 'ambiguous_sheets'; periodFrom: string; waybillIds: string[] }
  | { kind: 'overlapping_sheets'; waybillIds: string[] };

// ── Снимок заявки, по которому считается всё ──

/** Лист заявки, как его читает бэкфилл: действующий, с обеими границами периода. */
export type AssignmentHistorySheet = Esm2Sheet;

/**
 * Всё, от чего зависит расчёт готовности, — прочитанное один раз и под блокировкой.
 *
 * Снимок отделён от расчёта не ради стиля: тем же расчётом считает предпросмотр (которому нельзя
 * писать) и будет считать теневое сравнение (которое гоняет его на состояниях, никогда в базе не
 * существовавших). Чистая функция от снимка — единственная форма, годная всем троим.
 */
export interface AssignmentHistorySnapshot {
  requestId: string;
  term: AssignmentTerm;
  /** Режим заказа (ADR 0100): линейная заявка из листов не восстанавливается вовсе. */
  isLinear: boolean;
  state: AssignmentHistoryState;
  validatedOn: string | null;
  dirty: boolean;
  /** Машина денормализации — «чем заявка закрыта сейчас»; `null` — назначения нет. */
  assignmentVehicleId: string | null;
  /** Действующие строки истории. Пусто — восстанавливать с нуля. */
  changes: AssignmentChangeRecord[];
  /** Действующие листы по `(period_from, id)`; аннулированные — не доказательство (§6). */
  sheets: AssignmentHistorySheet[];
  /** Принадлежность каждой машины, встреченной в назначении и в листах (Р4). */
  ownershipByVehicle: Map<string, VehicleOwnership>;
}

/**
 * Результат расчёта: во что превратится история и каким станет состояние — до единой записи.
 *
 * `state: 'empty'` здесь означает не «строк нет», а «строк не появится»: восстановить нечем, и
 * причина названа в `unrestorable`.
 */
export interface AssignmentHistoryComputation {
  /**
   * История, по которой посчитаны блокеры: существующая либо восстановленная в памяти.
   *
   * Строками **ядра записи**, а не свёртки: этой же историей считает дверь фазы расчёта, а ей нужны
   * `origin`, группа и провенанс — без них не разобрать ни цель команды (Р10), ни запрет правки
   * заполнения прошлого. У восстановленных в памяти строк идентификатора нет и быть не может
   * (см. `plannedRow`), поэтому адресовать их командой следует логическим ключом —
   * {@link assignmentChangeTargetOf}.
   */
  changes: readonly AssignmentChangeRecord[];
  /** Чем материализуется пустая история. Пусто — история уже есть либо восстанавливать нечем. */
  mutations: readonly AssignmentWriteMutation[];
  state: AssignmentHistoryState;
  blockers: readonly AssignmentHistoryBlocker[];
  warnings: readonly AssignmentHistoryWarning[];
  unrestorable: readonly AssignmentHistoryUnrestorable[];
}

// ── Чтение снимка ──

/**
 * Снимок заявки для расчёта готовности — четыре запроса и ни одной записи.
 *
 * Годится и под читающей транзакцией фазы расчёта: предпросмотр обязан строить историю в памяти
 * теми же входами, какими её потом запишет боевая ручка (Р20).
 */
export async function readAssignmentHistorySnapshot(
  tx: AssignmentWriteTx,
  requestId: string,
): Promise<AssignmentHistorySnapshot> {
  const [row] = await tx
    .select({
      requestType: vehicleRequests.requestType,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      // Режим заявки, а не признак справочника: заявку могло застать переключение, и до конца
      // работы она ведётся снимком (`is_linear_frozen`, ADR 0107).
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
      state: vehicleRequests.assignmentHistoryState,
      validatedOn: vehicleRequests.assignmentHistoryValidatedOn,
      dirty: vehicleRequests.assignmentHistoryDirty,
      assignmentVehicleId: vehicleRequestAssignments.vehicleId,
    })
    .from(vehicleRequests)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  // Та же граница, что у каркаса команд: грузоперевозке история не нужна вовсе (Р20), и срока с
  // рабочими днями у неё нет — считать по ней отрезки было бы нечем.
  if (row.requestType !== 'special_equipment' || row.dateFrom === null) {
    throw err.unprocessable('История назначения ведётся только у заказа спецтехники');
  }

  const changes = await readAssignmentChanges(tx, requestId, { actualOnly: true });
  const sheets = await tx
    .select({
      id: waybills.id,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      driverPersonId: waybills.driverPersonId,
    })
    .from(waybills)
    // Отбор дословно тот же, что у сегодняшней сверки (`activeSheets`): лист заказа, не
    // аннулированный, с заполненным периодом. Разойтись им нельзя — бэкфилл восстанавливает
    // историю ровно по той бумаге, с которой сверка её потом и сличит.
    .where(
      and(
        eq(waybills.sourceRequestId, requestId),
        ne(waybills.status, 'cancelled'),
        isNotNull(waybills.periodFrom),
        isNotNull(waybills.periodTo),
      ),
    )
    // Второй ключ порядка обязателен: у линейного заказа неделю законно закрывают два листа разных
    // машин, и порядок между ними без `id` не определён.
    .orderBy(waybills.periodFrom, waybills.id);

  const vehicleIds = [
    ...new Set(
      [
        row.assignmentVehicleId,
        ...sheets.map((sheet) => sheet.vehicleId),
        ...changes.map((change) => change.vehicleId),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const ownershipByVehicle = new Map<string, VehicleOwnership>();
  if (vehicleIds.length > 0) {
    for (const vehicle of await tx
      .select({ id: vehicles.id, ownership: vehicles.ownership })
      .from(vehicles)
      .where(inArray(vehicles.id, vehicleIds))) {
      ownershipByVehicle.set(vehicle.id, vehicle.ownership);
    }
  }

  return {
    requestId,
    term: { dateFrom: row.dateFrom, dateTo: row.dateTo },
    isLinear: row.isLinear,
    state: row.state,
    validatedOn: row.validatedOn,
    dirty: row.dirty,
    assignmentVehicleId: row.assignmentVehicleId,
    changes,
    sheets: sheets.map((sheet) => ({
      id: sheet.id,
      periodFrom: sheet.periodFrom!,
      periodTo: sheet.periodTo!,
      vehicleId: sheet.vehicleId,
      driverPersonId: sheet.driverPersonId,
    })),
    ownershipByVehicle,
  };
}

// ── Расчёт ──

/**
 * Каким станет состояние истории — и что для этого надо записать. Чистая функция от снимка.
 *
 * Порядок работы Р26 здесь виден целиком:
 *
 * - строк нет и состояние `empty` — история строится по правилам §6 «Бэкфилл»;
 * - строки есть — они **читаются и не пересобираются**: идентификаторы и происхождение стабильны
 *   с первой материализации, а ремонт правит историю обычными командами. Пересборка потеряла бы и
 *   `changeId`, и отмену, которую человек записал прямо на backfill-строке (Д3 плана);
 * - валидность считается по получившейся истории и **на изменяемой части** (Р16, Р21): блокеров
 *   нет — `ready`, есть — `materialized`. Расхождение машины блокером не считается (Р30).
 */
export function computeAssignmentHistory(
  snapshot: AssignmentHistorySnapshot,
  asOf: string,
): AssignmentHistoryComputation {
  /*
   * Пересобирать разрешено ровно одно состояние — `empty` со строками, которых нет. Условие двойное
   * не для страховки: заявка, у которой человек отменил все backfill-строки, строк не имеет, а
   * состояние у неё `materialized`, и повторный бэкфилл воскресил бы отменённое им решение.
   */
  const rebuild = snapshot.state === 'empty' && snapshot.changes.length === 0;
  const built = rebuild ? buildBackfill(snapshot) : null;
  if (built && built.unrestorable.length > 0) {
    return {
      changes: [],
      mutations: [],
      state: 'empty',
      blockers: [],
      warnings: [],
      unrestorable: built.unrestorable,
    };
  }

  const changes: readonly AssignmentChangeRecord[] = built ? built.rows : snapshot.changes;
  const mutations = built ? built.mutations : [];
  const blockers = blockersOf(snapshot, changes, asOf);
  return {
    changes,
    mutations,
    state: blockers.length > 0 ? 'materialized' : 'ready',
    blockers,
    warnings: warningsOf(snapshot, changes),
    unrestorable: [],
  };
}

/**
 * Расчёт готовности по живой заявке — тот же, что у `ensureAssignmentHistory`, но без записи.
 *
 * Это и есть «режим расчёта» Р20: предпросмотр зовёт его, строит историю в памяти и считает по ней
 * план, а в базе после него не появляется ничего. Вызывается он к тому же дважды подряд
 * (двухфазность Р16), и записывающий предпросмотр означал бы две записи на одно человеческое
 * действие.
 */
export async function planAssignmentHistory(
  tx: AssignmentWriteTx,
  params: { requestId: string; asOf?: string },
): Promise<AssignmentHistoryComputation> {
  const snapshot = await readAssignmentHistorySnapshot(tx, params.requestId);
  return computeAssignmentHistory(snapshot, params.asOf ?? moscowDateKeyOf(new Date()));
}

/**
 * Почему история не восстановилась — человеческими словами, одними на все двери.
 *
 * Отказ читает диспетчер, а не разработчик, и «состояние `empty`» ему не говорит ничего: чинить
 * такую заявку он пойдёт разными путями в зависимости от причины — назначить технику, разобраться с
 * задвоенным бланком, аннулировать лишний лист. Вторая копия этих слов в каждой двери разошлась бы
 * с первой ровно тогда, когда человек читает отказ.
 */
export function assignmentHistoryUnrestorableReason(
  reasons: readonly AssignmentHistoryUnrestorable[],
): string {
  const words = reasons.map((reason) => {
    switch (reason.kind) {
      case 'no_assignment':
        return 'заявке не назначена техника — восстанавливать историю не от чего';
      case 'ambiguous_sheets':
        return `на ${reason.periodFrom} действуют два путевых листа разных машин (${reason.waybillIds.length} шт.) — какая из них работала, из бумаги не следует`;
      case 'overlapping_sheets':
        return 'периоды действующих путевых листов пересекаются — одной шкалы из них не построить';
    }
  });
  return words.length > 0 ? words.join('; ') : 'причина не названа';
}

// ── Адресация расчётной истории ──

/**
 * Приставка идентификатора расчётной строки. Ей же он и опознаётся: в базе такого `id` нет и быть
 * не может — колонка `uuid`, — а разойтись эти два мира не вправе.
 */
const PLANNED_ID_PREFIX = 'planned:';

/** Отметка времени расчётной строки: её не существует, и сравнивать её не с чем. */
const PLANNED_CREATED_AT = new Date(0);

/** Строка, которой в базе ещё нет: она восстановлена в памяти и получит `id` только на записи. */
export function isPlannedAssignmentChange(row: { id: string }): boolean {
  return row.id.startsWith(PLANNED_ID_PREFIX);
}

/**
 * Как дверь адресует строку истории, по которой она посчитала команду (Р10).
 *
 * Адресов у изменения два, и второй заведён ровно для этого случая: у заявки, историю которой
 * материализует **эта же** транзакция, `changeId` появится только на шаге 11, а команда считалась
 * шагом 5 — то есть по строкам, которых в базе ещё нет. Логический ключ `{ dimension,
 * effectiveDate }` однозначен по частичному UNIQUE актуальных строк и одинаково разрешается и в
 * предпросмотре (`simulateChanges`), и в ядре записи (`resolveChangeTarget`), поэтому дверь,
 * называющая цель через эту функцию, работает по восстановленной истории так же, как по живой.
 */
export function assignmentChangeTargetOf(row: {
  id: string;
  dimension: 'vehicle' | 'driver';
  effectiveDate: string;
}): AssignmentChangeTarget {
  return isPlannedAssignmentChange(row)
    ? { dimension: row.dimension, effectiveDate: row.effectiveDate }
    : { changeId: row.id };
}

// ── Запись ──

/** Готовность заявки после `ensureAssignmentHistory` — состоянием Р26 наружу. */
export type EnsuredAssignmentHistory =
  | {
      /** История не восстановлена: ни строки, ни состояния. Причины — в `unrestorable`. */
      state: 'empty';
      unrestorable: readonly AssignmentHistoryUnrestorable[];
    }
  | {
      state: 'materialized' | 'ready';
      /** Действующая история после вызова — вход свёртки для команды, которая идёт следом. */
      changes: readonly AssignmentChangeRecord[];
      blockers: readonly AssignmentHistoryBlocker[];
      warnings: readonly AssignmentHistoryWarning[];
      /** Строки, вписанные бэкфиллом **этим** вызовом; пусто — история уже была. */
      materialized: readonly AssignmentChangeRecord[];
      /** Записана ли колонка состояния: `false` — валидность была свежей и совпала. */
      revalidated: boolean;
    };

/**
 * Привести историю заявки к состоянию Р26 — единственная дверь готовности.
 *
 * ЧТО ОБЯЗАН ДЕРЖАТЬ ВЫЗЫВАЮЩИЙ: строку заявки под `lockRequestRow`. Без неё две команды по одной
 * неготовой заявке материализуют историю дважды и разойдутся на частичном UNIQUE.
 *
 * ЛЕНИВАЯ РЕВАЛИДАЦИЯ (Р26, З1, К4). Состояние — поддерживаемый инвариант, а не отметка бэкфилла:
 * границу изменяемого двигает календарь сам, без всякой двери, поэтому `unknown` в заблокированном
 * прошлом со временем перестаёт мешать, а продление срока, наоборот, делает те же дни изменяемыми.
 * Колонка пересчитывается, когда сменился день (`validated_on <> asOf`) или поднята метка
 * `assignment_history_dirty` — и записывается **одной операцией**: состояние, дата и снятие метки
 * атомарно. Переход `ready → materialized` при этом такой же законный, как обратный.
 *
 * Третий повод записать — **расхождение расчёта с колонкой** внутри того же дня. Он не лишний:
 * дверь, расширившая область валидности (срок, статус, архивность — Ж1), зовёт `ensure` именно
 * ради пересчёта, и «сегодня уже считали» оставило бы ей верный ответ в руках и прежнее значение
 * в базе. Расчёт поэтому идёт всегда — он стоит трёх выборок, — а лениво здесь то, что **не
 * переписывается**: ни строки истории, ни строка заявки, когда менять в них нечего.
 */
export async function ensureAssignmentHistory(
  tx: AssignmentWriteTx,
  params: { requestId: string; asOf?: string },
): Promise<EnsuredAssignmentHistory> {
  assertWritableTx(tx);
  const asOf = params.asOf ?? moscowDateKeyOf(new Date());
  const snapshot = await readAssignmentHistorySnapshot(tx, params.requestId);
  const computed = computeAssignmentHistory(snapshot, asOf);
  if (computed.state === 'empty') {
    return { state: 'empty', unrestorable: computed.unrestorable };
  }

  let materialized: AssignmentChangeRecord[] = [];
  let changes: readonly AssignmentChangeRecord[] = snapshot.changes;
  if (computed.mutations.length > 0) {
    const write = await applyAssignmentMutations(tx, {
      requestId: snapshot.requestId,
      // Автора у восстановленной истории нет: приписывать её запустившему команду значило бы
      // назвать автором решения того, кто его не принимал (§6, `created_by = null`).
      actorUserId: null,
      correctionId: null,
      mutations: [...computed.mutations],
      // История догоняет назначение, а не наоборот, и хвост её законно расходится с ним (Р30).
      denormalization: { kind: 'materialize' },
    });
    // Проверка Р17 зовётся здесь, а не оставляется каркасу: у `ensure` есть вызывающие, которые
    // командами не являются вовсе (восстановление из архива, массовый прогон), и обещание
    // «назначение не тронуто» должно проверяться там же, где даётся.
    await assertAssignmentDenormalization(tx, write.denormalization);
    materialized = write.inserted;
    changes = write.changesAfter;
  }

  const revalidated =
    snapshot.state !== computed.state || snapshot.validatedOn !== asOf || snapshot.dirty;
  if (revalidated) {
    await tx
      .update(vehicleRequests)
      .set({
        assignmentHistoryState: computed.state,
        assignmentHistoryValidatedOn: asOf,
        assignmentHistoryDirty: false,
      })
      .where(eq(vehicleRequests.id, snapshot.requestId));
  }

  return {
    state: computed.state,
    changes,
    blockers: computed.blockers,
    warnings: computed.warnings,
    materialized,
    revalidated,
  };
}

/**
 * Шаг 11 канона у дверей истории: материализовать историю **до** предметных мутаций команды.
 *
 * Порядок обязателен, и он же объясняет, почему у этой обёртки есть собственное имя. Дверь считала
 * команду шагом 5 по истории, восстановленной в памяти (`planAssignmentHistory`), и её замена или
 * отмена адресуется строке, которой в базе ещё нет; вписывает эту строку именно этот вызов, и
 * сделать его после `applyAssignmentMutations` значило бы разрешать цель по пустой таблице.
 *
 * Ответ `empty` здесь — не пользовательский отказ, а нарушение канона: шаг 5 той же транзакции
 * восстановимость уже проверил и команду по невосстановимой истории не пропустил бы. Если состояние
 * всё-таки пришло пустым, между расчётом и записью изменилось то, что меняться под `lockRequestRow`
 * не может, — и внятная 500 дешевле молчаливой команды по пустой истории.
 */
export async function ensureCommandHistory(
  tx: AssignmentWriteTx,
  params: { requestId: string; asOf: string },
): Promise<EnsuredAssignmentHistory> {
  const ensured = await ensureAssignmentHistory(tx, params);
  if (ensured.state === 'empty') {
    throw new AppError(
      500,
      'assignment_ensure_invariant',
      `История назначения: расчёт команды прошёл, а материализация вернула «не восстановлено» (${assignmentHistoryUnrestorableReason(ensured.unrestorable)})`,
    );
  }
  return ensured;
}

// ── Бэкфилл: восстановление истории по листам и назначению (§6) ──

interface BuiltHistory {
  mutations: AssignmentWriteMutation[];
  rows: AssignmentChangeRecord[];
  unrestorable: AssignmentHistoryUnrestorable[];
}

/** Точка восстановленной шкалы: что менялось в этот день. Обе шкалы одной даты — одно решение. */
interface BackfillPoint {
  date: string;
  vehicleId?: string;
  driver?: DriverState;
}

/**
 * Правила §6 «Бэкфилл» — по порядку и дословно.
 *
 * 0. **Preflight на неоднозначность**: два действующих листа с одним `period_from` и разными
 *    машинами (база это разрешает) либо пересечение периодов — история однозначно не строится, и
 *    «восстановить как получится» здесь недопустимо.
 * 1. **Линейная заявка из листов не восстанавливается** (в неделе законно два листа разных машин,
 *    ADR 0100 §7): ей пишется одно vehicle-изменение из назначения на начало срока. Машиниста у
 *    линейного заказа не существует вовсе (Р16, «Область — режим `auto`»), поэтому парной строки
 *    человека у неё нет.
 * 2. **Прочие**: листы по `(period_from, id)`, изменение шкалы — там, где меняется её значение,
 *    `effective_date` = `period_from` первого листа нового значения.
 * 3. **Начало срока раньше первого листа**: машина — из назначения (лучшее доказательство того,
 *    чем работали), а машинист назад **не протягивается**: на начало срока пишется `unknown`, и
 *    `set` начинается с даты первого листа.
 * 4. **Заявка без листов** — vehicle-изменение из назначения на начало срока.
 * 5. **Хвост**: машина назначения не совпала с машиной последнего листа — изменение на
 *    `period_to + 1`; за концом срока оно не вставляется вовсе, а расхождение уходит
 *    предупреждением (Р30).
 * 6. **Парная строка машиниста** (Р16): арендный отрезок получает `cleared` — бланк ведёт
 *    арендодатель; собственный, о котором бумага молчит, — `unknown`.
 * 7. `origin = 'backfill'`, `created_by = null`.
 */
function buildBackfill(snapshot: AssignmentHistorySnapshot): BuiltHistory {
  const empty = (unrestorable: AssignmentHistoryUnrestorable[]): BuiltHistory => ({
    mutations: [],
    rows: [],
    unrestorable,
  });
  const { term, assignmentVehicleId } = snapshot;
  const last = termLastDay(term);
  // Назначение — опора всех четырёх правил: из него берётся машина начала срока, хвоста и заявки
  // без листов. Без него восстанавливать не от чего, и выдумывать здесь нечего.
  if (!assignmentVehicleId) return empty([{ kind: 'no_assignment' }]);

  const points = new Map<string, BackfillPoint>();
  const put = (date: string, patch: Omit<BackfillPoint, 'date'>): void => {
    points.set(date, { ...(points.get(date) ?? { date }), ...patch });
  };
  /** Машинист отрезка по его машине: у арендной его ведёт арендодатель, у своей — бумага. */
  const pairedDriver = (vehicleId: string, fromSheet: string | null): DriverState =>
    snapshot.ownershipByVehicle.get(vehicleId) === 'rental'
      ? { state: 'cleared' }
      : fromSheet
        ? { state: 'set', personId: fromSheet }
        : { state: 'unknown' };

  // 1. Линейная заявка: одна строка из назначения, и ни слова о человеке.
  if (snapshot.isLinear) {
    put(term.dateFrom, { vehicleId: assignmentVehicleId });
    return materialize(snapshot.requestId, points);
  }

  // 0. Preflight: одна временная шкала из неоднозначной бумаги не строится.
  const ambiguity = sheetAmbiguity(snapshot.sheets);
  if (ambiguity.length > 0) return empty(ambiguity);

  const sheets = snapshot.sheets;
  const first = sheets[0];
  const current: { vehicleId?: string; driver?: DriverState } = {};

  // 3 и 4. Голова срока: машина из назначения, человек — `unknown`. Протянуть назад человека из
  // первого листа значило бы приписать ему дни, о которых бумага молчит (Р19).
  if (!first || first.periodFrom > term.dateFrom) {
    const driver = pairedDriver(assignmentVehicleId, null);
    put(term.dateFrom, { vehicleId: assignmentVehicleId, driver });
    current.vehicleId = assignmentVehicleId;
    current.driver = driver;
  }

  // 2. Изменение шкалы — там, где меняется её значение.
  for (const sheet of sheets) {
    // Лист начинается календарной неделей и законно захватывает дни до начала срока: границей
    // истории остаётся срок. Лист целиком за концом срока не восстанавливается вовсе — той же
    // мерой, какой правило 5 отказывается вставлять хвост за `dateTo`.
    const date = sheet.periodFrom > term.dateFrom ? sheet.periodFrom : term.dateFrom;
    if (date > last) continue;
    if (current.vehicleId !== sheet.vehicleId) {
      put(date, { vehicleId: sheet.vehicleId });
      current.vehicleId = sheet.vehicleId;
    }
    const driver = pairedDriver(sheet.vehicleId, sheet.driverPersonId);
    if (!sameDriverState(current.driver ?? null, driver)) {
      put(date, { driver });
      current.driver = driver;
    }
  }

  // 5. Хвост: назначение против машины последнего листа.
  const lastSheet = sheets[sheets.length - 1];
  if (lastSheet && lastSheet.vehicleId !== assignmentVehicleId) {
    const after = shiftDateKey(lastSheet.periodTo, 1);
    const date = after > term.dateFrom ? after : term.dateFrom;
    // Свободного дня внутри срока не осталось — изменение не вставляется, и `ready` это не мешает:
    // история с бумагой сходится, расходится лишь денормализация (Р30). Расхождение посчитается
    // предупреждением по хвосту получившейся истории.
    if (date <= last) {
      // Человека на эти дни бумага не называла — `unknown`, а не машинист последнего листа.
      put(date, {
        vehicleId: assignmentVehicleId,
        driver: pairedDriver(assignmentVehicleId, null),
      });
    }
  }

  return materialize(snapshot.requestId, points);
}

/**
 * Точки — в мутации ядра записи и в строки для свёртки в памяти.
 *
 * Обе шкалы одной даты получают **общую** группу (Г2): vehicle-изменение и рождённая им строка
 * человека гаснут вместе. Выдай бэкфилл им разные группы — сокращение срока и отмена снова
 * разъехались бы, оставив собственный отрезок без машиниста.
 */
function materialize(
  requestId: string,
  points: ReadonlyMap<string, BackfillPoint>,
): BuiltHistory {
  const mutations: AssignmentWriteMutation[] = [];
  const rows: AssignmentChangeRecord[] = [];
  const dates = [...points.keys()].sort();
  for (const date of dates) {
    const point = points.get(date)!;
    if (point.vehicleId) {
      const value = { dimension: 'vehicle', vehicleId: point.vehicleId } as const;
      mutations.push({
        kind: 'insert',
        effectiveDate: date,
        origin: 'backfill',
        group: date,
        value,
      });
      rows.push(plannedRow(requestId, date, value));
    }
    if (point.driver) {
      const value = { dimension: 'driver', driver: point.driver } as const;
      mutations.push({
        kind: 'insert',
        effectiveDate: date,
        origin: 'backfill',
        group: date,
        value,
      });
      rows.push(plannedRow(requestId, date, value));
    }
  }
  return { mutations, rows, unrestorable: [] };
}

/**
 * Строка расчётной истории. Идентификатора у неё нет и быть не может — он появится только на
 * записи, — поэтому ставится вычислимый ключ: свёртке он безразличен, а отпечаток предпросмотра
 * считается по содержанию, а не по идентификаторам (Р20).
 */
function plannedRow(
  requestId: string,
  effectiveDate: string,
  value: { dimension: 'vehicle'; vehicleId: string } | { dimension: 'driver'; driver: DriverState },
): AssignmentChangeRecord {
  const base = {
    id: `${PLANNED_ID_PREFIX}${value.dimension}:${effectiveDate}`,
    requestId,
    effectiveDate,
    origin: 'backfill' as const,
    changeGroupId: `${PLANNED_ID_PREFIX}${effectiveDate}`,
    supersededAt: null,
    // Провенанс расчётной строки пуст, и это не заглушка: автора у восстановленной истории нет
    // (§6, `created_by = null`), операции — тоже, а погасить её сейчас нечем, потому что в базе её
    // ещё не существует.
    correctionId: null,
    createdBy: null,
    createdAt: PLANNED_CREATED_AT,
    supersedesChangeId: null,
    supersededKind: null,
  };
  if (value.dimension === 'vehicle') {
    return {
      ...base,
      dimension: 'vehicle',
      vehicleId: value.vehicleId,
      driverPersonId: null,
      driverState: null,
    };
  }
  return {
    ...base,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: value.driver.state === 'set' ? value.driver.personId : null,
    driverState: value.driver.state,
  };
}

/**
 * Неоднозначность бумаги (§6, п. 0): одинаковые начала периодов и пересечения.
 *
 * Проверяется только у нелинейной заявки: у линейной оба случая законны (ADR 0100 §7), и там
 * бумага в восстановлении не участвует вовсе.
 */
function sheetAmbiguity(
  sheets: readonly AssignmentHistorySheet[],
): AssignmentHistoryUnrestorable[] {
  const found: AssignmentHistoryUnrestorable[] = [];
  const byPeriodFrom = new Map<string, string[]>();
  for (const sheet of sheets) {
    byPeriodFrom.set(sheet.periodFrom, [...(byPeriodFrom.get(sheet.periodFrom) ?? []), sheet.id]);
  }
  for (const [periodFrom, waybillIds] of byPeriodFrom) {
    if (waybillIds.length > 1) found.push({ kind: 'ambiguous_sheets', periodFrom, waybillIds });
  }
  // Пересечение считается по бегущему максимуму конца, а не по соседям: листы отсортированы по
  // началу, и лист, накрывший сразу два следующих, соседством не ловится.
  let covered: { to: string; id: string } | null = null;
  for (const sheet of sheets) {
    if (covered && sheet.periodFrom <= covered.to) {
      found.push({ kind: 'overlapping_sheets', waybillIds: [covered.id, sheet.id] });
    }
    if (!covered || sheet.periodTo > covered.to) covered = { to: sheet.periodTo, id: sheet.id };
  }
  return found;
}

// ── Валидность ──

/**
 * Блокеры валидности: `unknown` и `cleared` у `portal`-отрезка на **изменяемой** части срока
 * (Р16, Р21, Р26).
 *
 * Изменяемое — это дни, где лист ещё можно аннулировать, плюс будущее. Исторический диапазон,
 * который открывает коррекция самой команды, сюда не входит: у готовности команды нет, а
 * расширять область за неё значило бы объявлять невалидным то, что никто не собирается трогать.
 *
 * На заблокированном прошлом инвариант не требуется, и это не поблажка: бумага тех дней выдана,
 * машинист напечатан в ней, а история восстановлена приблизительно. Требуй портал непустого
 * человека на всём сроке — ни одна старая заявка не стала бы `ready` никогда.
 *
 * У линейной заявки машиниста не существует вовсе (Р16, ADR 0100 §6): бумага из истории там не
 * считается, и требовать человека значило бы придумывать решение, которого никто не принимал.
 */
function blockersOf(
  snapshot: AssignmentHistorySnapshot,
  changes: readonly AssignmentChangeRow[],
  asOf: string,
): AssignmentHistoryBlocker[] {
  if (snapshot.isLinear) return [];
  const segments = esm2PaperSegments(
    assignmentSegments(changes, snapshot.term),
    snapshot.term,
    snapshot.ownershipByVehicle,
  );
  const cancellable = snapshot.sheets.filter((sheet) =>
    canCancelWaybill({ issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo }, asOf),
  );
  const mutable = (date: string): boolean =>
    date >= asOf || cancellable.some((sheet) => sheet.periodFrom <= date && date <= sheet.periodTo);

  const blockers: AssignmentHistoryBlocker[] = [];
  for (const segment of segments) {
    if (segment.responsibility !== 'portal') continue;
    if (segment.driver?.state === 'set') continue;
    // «Шкала не задана» и «история не знает» для бумаги — одно и то же признание неполноты, и
    // третий вид блокера сделал бы сравнение Р27 несопоставимым с бэкфиллом.
    const kind = segment.driver?.state === 'cleared' ? 'cleared' : 'unknown';
    for (const date of dateKeysBetween(segment.from, segment.to)) {
      if (mutable(date)) blockers.push({ date, kind });
    }
  }
  return blockers;
}

/**
 * Расхождение хвоста истории с назначением (Р30) — предупреждение, а не блокер.
 *
 * Хвост спрашивается у свёртки «в бесконечности», а не отбором последней строки: конца у изменения
 * нет — его задаёт следующее изменение той же шкалы (Р1), — и состав самого дальнего дня и есть
 * последнее активное vehicle-изменение по `effective_date`. Той же мерой хвост считает Р17.
 */
function warningsOf(
  snapshot: AssignmentHistorySnapshot,
  changes: readonly AssignmentChangeRow[],
): AssignmentHistoryWarning[] {
  const historyVehicleId = assignmentStateOn(changes, FOREVER).vehicle?.vehicleId ?? null;
  const assignmentVehicleId = snapshot.assignmentVehicleId;
  if (!historyVehicleId || !assignmentVehicleId) return [];
  if (historyVehicleId === assignmentVehicleId) return [];
  return [{ kind: 'tail_vehicle_mismatch', historyVehicleId, assignmentVehicleId }];
}

// ── Внутреннее ──

/** Последний день срока: пустой `dateTo` читается как однодневный срок (Р24). */
function termLastDay(term: AssignmentTerm): string {
  return term.dateTo || term.dateFrom;
}

/** День, дальше которого истории не бывает: им спрашивается состав хвоста. */
const FOREVER = '9999-12-31';

/**
 * Транзакция, которой нельзя писать, — отказ, а не молчание (Р20).
 *
 * Фаза расчёта каркаса получает читающий прокси (`readOnlyTx`), где `insert`/`update`/`delete`
 * бросают. Полагаться на это как на единственную защиту нельзя: у готовой заявки со свежей
 * валидностью `ensure` не пишет ни строки — то есть предпросмотр, позвавший её по ошибке, прошёл
 * бы молча и упал бы через неделю на первой же неготовой заявке. Поэтому вопрос задаётся сразу и
 * всем: построитель `insert` ничего не выполняет, а на прокси бросает.
 */
function assertWritableTx(tx: AssignmentWriteTx): void {
  try {
    tx.insert(vehicleRequests);
  } catch {
    throw new AppError(
      500,
      'assignment_ensure_invariant',
      'История назначения: предпросмотр её не пишет (Р20) — для расчёта есть `planAssignmentHistory`',
    );
  }
}
