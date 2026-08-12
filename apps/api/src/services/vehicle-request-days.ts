import { and, asc, eq, isNotNull } from 'drizzle-orm';
import {
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRouteEditable,
  isShiftDayInTerm,
  linearDaysBlocker,
  linearDaysOf,
  type LinearDaySubject,
  type PlanVehicleRequestDayInput,
  type PlannedVehicleRequestDay,
  type VehicleRequestDayDto,
  type VehicleOwnership,
  vehicleStatusLabels,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  persons,
  specialEquipmentRequestDetails,
  users,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRequestShifts,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import {
  bumpRouteVersion,
  detachRequest,
  lockRoute,
  type RouteRow,
  routeWaybill,
} from './vehicle-routes';

/**
 * Дни линейного заказа (ADR 0100): чтение плана по дням и сверка его с самой заявкой.
 *
 * Своей таблицы у дней нет — перечень выводится из срока, а материализуется только факт «этот день
 * поставлен в такой-то рейс» (`vehicle_route_requests.work_date`, миграция 0127). Отсюда две
 * работы у этого модуля: собрать таблицу дней для карточки и снять с рейсов дни, которых больше не
 * существует.
 *
 * Сверка (`syncLinearRouteDays`) стоит рядом со сверкой недельных листов (`syncEsm2Waybills`) и
 * зовётся теми же местами: досрочное завершение, правка срока, отмена, возврат в «Новую»,
 * применение недельной заявки. Ни одно из них не решает само, что делать с планом, — как не решает
 * и что делать с бумагой.
 *
 * Правила «можно ли вести дни» и «можно ли распланировать этот день» живут в контрактах
 * (`linearDaysBlocker`, `planDayBlocker`): портал обязан объяснять недоступное теми же словами,
 * которыми откажет сервер.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающим функциям транзакция не нужна: таблицу дней спрашивают вне её. */
type Reader = Tx | typeof db;

/**
 * Заявка глазами дней: правила (`LinearDaySubject`) плюс то, чем заявку называют человеку и с чем
 * сверяется пометка «машина не та».
 */
export interface LinearRequestState extends LinearDaySubject {
  id: string;
  num: number;
  /**
   * Машина назначения — машина дня по умолчанию (ADR 0100 §4). Фактическую машину дня знает рейс,
   * и расхождение с этой законно: ради него признак линейности и заведён.
   */
  vehicleId: string | null;
}

/**
 * Состояние заявки, по которому считаются дни.
 *
 * Признак линейности читается живым join'ом **заказанного** типа (ADR 0100 §1): снимка в заявке
 * нет намеренно — заказ решает, как заявка ведётся, ещё до того, как под неё нашли единицу, и
 * менять этот ответ подбором машины нельзя. Тем же join'ом его читает сверка листов ЭСМ-2.
 */
export async function loadLinearRequest(
  reader: Reader,
  requestId: string,
): Promise<LinearRequestState | null> {
  const [row] = await reader
    .select({
      id: vehicleRequests.id,
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      isLinear: vehicleTypes.isLinear,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      vehicleId: vehicleRequestAssignments.vehicleId,
      ownership: vehicles.ownership,
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
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row) return null;
  return {
    id: row.id,
    num: row.num,
    requestType: row.requestType,
    isLinear: row.isLinear,
    status: row.status,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    // Срок есть только у заказа техники на объект; у грузоперевозки его нет вовсе — там момент
    // подачи, и дней у такой заявки не бывает (`linearDaysBlocker` откажет раньше).
    dateFrom: row.dateFrom ?? undefined,
    dateTo: row.dateTo,
    vehicleId: row.vehicleId,
    ownership: (row.ownership as VehicleOwnership | null) ?? null,
  };
}

/**
 * То же под блокировкой строки заявки: планирование дня читает статус, назначение и срок, а
 * соседний запрос успевает их сменить между чтением и вставкой. Берётся **после** рейсов — порядок
 * блокировок в модуле общий (`loadRequestForRoute`), иначе смена статуса и планирование дня
 * встретятся встречными блокировками.
 */
export async function lockLinearRequest(
  tx: Tx,
  requestId: string,
): Promise<LinearRequestState | null> {
  await tx
    .select({ id: vehicleRequests.id })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId))
    .for('update', { of: vehicleRequests });
  return loadLinearRequest(tx, requestId);
}

/**
 * Гонка планирования (план У12): два диспетчера кладут один день в разные рейсы, и второй доходит
 * до частичного UNIQUE (миграция 0127). Индекс здесь — не подстраховка проверки, а сама проверка:
 * между чтением плана и вставкой строки соседняя транзакция ещё не видна. Человеку 23505 читать
 * нечем, поэтому ошибка переводится в слова; всё прочее пробрасывается как есть.
 */
export function asDayRaceConflict(e: unknown, date: string): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'vehicle_route_requests_request_day_unique') {
    return err.conflict(
      `День ${date} только что поставили в другой рейс — обновите карточку заявки и выберите, где он останется`,
    );
  }
  return e;
}

/**
 * Рейс, в который встанет день: названный человеком либо заведённый тут же.
 *
 * Тем же приёмом заявку кладут в рейс переводом в работу (`attachToRoute`): «в существующий или в
 * новый» — один вопрос, и разные ответы на него у дня и у заявки означали бы разные правила
 * планирования. Отличие ровно одно: машину нового рейса называет человек, потому что у линейного
 * заказа назначение — машина по умолчанию, а на разные дни выходят разные единицы (ADR 0100 §4).
 *
 * Заведённый рейс сразу берётся под блокировку — дальше по нему считают заморозку, ёмкость и
 * позицию строки, и читать это без блокировки означало бы собирать состав по устаревшему ответу.
 */
export async function openDayRoute(
  tx: Tx,
  params: { body: PlanVehicleRequestDayInput; date: string; actorId: string },
): Promise<RouteRow> {
  if ('routeId' in params.body) return lockRoute(tx, params.body.routeId);

  const { vehicleId, driverPersonId, trip } = params.body.newRoute;
  await assertDayRouteVehicle(tx, vehicleId);
  if (driverPersonId) {
    // Существование, а не допуск: допуск спрашивается отбором при выписке листа (ADR 0037 п. 6) —
    // рейс планируют заранее, а удостоверение может быть в работе у кадровика.
    const [driver] = await tx
      .select({ deletedAt: persons.deletedAt })
      .from(persons)
      .where(eq(persons.id, driverPersonId));
    if (!driver || driver.deletedAt) throw err.badRequest('Водитель не найден');
  }

  const [created] = await tx
    .insert(vehicleRoutes)
    .values({
      vehicleId,
      // День рейса и есть планируемый день: расхождению взяться неоткуда (составной FK, 0127).
      routeDate: params.date,
      driverPersonId: driverPersonId ?? null,
      withTrailer: trip?.withTrailer ?? false,
      trailer1Model: trip?.trailer1Model ?? '',
      trailer1RegNumber: trip?.trailer1RegNumber ?? '',
      trailer2Model: trip?.trailer2Model ?? '',
      trailer2RegNumber: trip?.trailer2RegNumber ?? '',
      garageNumber: trip?.garageNumber ?? '',
      communicationKind: trip?.communicationKind ?? '',
      transportationKind: trip?.transportationKind ?? '',
      createdBy: params.actorId,
    })
    .returning({ id: vehicleRoutes.id });
  return lockRoute(tx, created!.id);
}

/**
 * Машина рейса дня: собственная и живая — то же условие, что и у любого другого рейса
 * (`assertRouteVehicle`). Арендную ведёт арендодатель, он же выписывает на неё лист, и линейность
 * заказа здесь ничего не меняет (план У14).
 */
async function assertDayRouteVehicle(tx: Tx, vehicleId: string): Promise<void> {
  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
    })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Техника не найдена');
  if (row.ownership !== 'own') {
    throw err.unprocessable(
      'Маршрут ведётся только для собственной техники: путевой лист на арендную выписывает арендодатель',
      { vehicleId: 'Арендная техника' },
    );
  }
  if (row.status !== 'active') {
    throw err.unprocessable(
      `Техника недоступна: ${vehicleStatusLabels[row.status].toLowerCase()}`,
      {
        vehicleId: 'Техника недоступна',
      },
    );
  }
}

/** Распланированный день как он лежит в базе: строка состава плюс реквизиты своего рейса. */
async function plannedDayRows(reader: Reader, requestId: string) {
  return reader
    .select({
      workDate: vehicleRouteRequests.workDate,
      position: vehicleRouteRequests.position,
      routeId: vehicleRoutes.id,
      routeNum: vehicleRoutes.num,
      routeVersion: vehicleRoutes.version,
      vehicleId: vehicleRoutes.vehicleId,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      driverPersonId: vehicleRoutes.driverPersonId,
      driverName: persons.fullName,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRoutes, eq(vehicleRoutes.id, vehicleRouteRequests.routeId))
    .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), isNotNull(vehicleRouteRequests.workDate)),
    )
    .orderBy(asc(vehicleRouteRequests.workDate));
}

/**
 * Листы рейсов пачкой: действующий, а если его нет — последний аннулированный. Тем же порядком и по
 * той же причине, что и в карточке рейса: по листу день решает, отдаст ли его рейс, и
 * «какой-нибудь» ответ означал бы то замороженный день, то нет.
 */
async function waybillsOfRoutes(
  reader: Reader,
  routeIds: string[],
): Promise<Map<string, { id: string; number: string; status: 'issued' | 'cancelled' }>> {
  const map = new Map<string, { id: string; number: string; status: 'issued' | 'cancelled' }>();
  for (const routeId of new Set(routeIds)) {
    const waybill = await routeWaybill(reader, routeId);
    if (waybill) {
      map.set(routeId, { id: waybill.id, number: waybill.number, status: waybill.status });
    }
  }
  return map;
}

/** Часы дня и подпись объекта: их ведёт таблица смен — своей у дней нет (ADR 0100 §12). */
async function shiftsOfRequest(reader: Reader, requestId: string) {
  const rows = await reader
    .select({
      date: vehicleRequestShifts.shiftDate,
      startedAt: vehicleRequestShifts.startedAt,
      endedAt: vehicleRequestShifts.endedAt,
      machineHours: vehicleRequestShifts.machineHours,
      approvedAt: vehicleRequestShifts.approvedAt,
      approvedByName: users.fullName,
    })
    .from(vehicleRequestShifts)
    // Кто принял день: учётка подписавшего — тем же join'ом её берёт таблица смен.
    .leftJoin(users, eq(users.id, vehicleRequestShifts.approvedBy))
    .where(eq(vehicleRequestShifts.requestId, requestId));
  return new Map(rows.map((row) => [row.date, row]));
}

/** `time` из pg приходит как `08:00:00`; смену читают до минут — так её и вводят. */
function timeOnly(v: string | null): string | null {
  return v ? v.slice(0, 5) : null;
}

/** numeric из pg приходит строкой; нечисло читается нулём — так же, как в таблице смен. */
function hours(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Таблица дней заказа: дни срока целиком, включая те, на которые ещё никого не назначили.
 *
 * Дни считает правило контрактов (`linearDaysOf`) — оно же приклеивает к сроку распланированное и
 * помечает дни, оставшиеся за сроком: их держит замороженный лист, и прятать выданную бумагу
 * нельзя.
 */
export async function loadRequestDays(
  reader: Reader,
  request: LinearRequestState,
): Promise<VehicleRequestDayDto[]> {
  const [rows, shifts] = await Promise.all([
    plannedDayRows(reader, request.id),
    shiftsOfRequest(reader, request.id),
  ]);
  const waybillsByRouteId = await waybillsOfRoutes(
    reader,
    rows.map((row) => row.routeId),
  );

  /*
   * Дни выводятся из срока только у линейного заказа: у прочих заявок дней не бывает вовсе
   * (`linearDaysBlocker`), и рисовать им таблицу по сроку значило бы предлагать действие, которое
   * сервер отклонит. Распланированное при этом показывается всегда — даже у отменённой заявки и у
   * заказа, переведённого на арендную машину: снятые дни исчезнут сами (сверка), а оставшийся в
   * выданном бланке день обязан быть виден.
   */
  const term =
    request.requestType === 'special_equipment' && request.isLinear
      ? request
      : { dateFrom: undefined, dateTo: null };

  const planned: PlannedVehicleRequestDay[] = rows.map((row) => {
    const shift = shifts.get(row.workDate!);
    return {
      date: row.workDate!,
      route: {
        id: row.routeId,
        displayNumber: formatVehicleRouteNumber(row.routeNum),
        position: row.position,
        vehicleId: row.vehicleId,
        vehicleLabel: [row.modelName, row.registrationNumber].filter(Boolean).join(' · '),
        driverPersonId: row.driverPersonId,
        driverName: row.driverName ?? '',
        waybill: waybillsByRouteId.get(row.routeId) ?? null,
        version: row.routeVersion,
      },
      shift: shift
        ? {
            startedAt: timeOnly(shift.startedAt),
            endedAt: timeOnly(shift.endedAt),
            machineHours: hours(shift.machineHours),
            approvedAt: shift.approvedAt ? shift.approvedAt.toISOString() : null,
            approvedByName: shift.approvedByName,
          }
        : null,
      // Машина дня против машины назначения (ADR 0100 §4): расхождение помечается, а не
      // отклоняется — на разные дни выходят разные единицы.
      otherVehicle: !!request.vehicleId && row.vehicleId !== request.vehicleId,
    };
  });
  return linearDaysOf(term, planned);
}

/** День, снятый с рейса или оставшийся в нём: им сверка объясняется человеку и журналу. */
export interface LinearDayRef {
  date: string;
  /** «Р-12» — рейс, из которого день сняли или который его не отдал. */
  routeNumber: string;
}

/** Чем кончилась сверка дней: что снялось с рейсов и что осталось в выданной бумаге. */
export interface LinearDaysSyncResult {
  detached: LinearDayRef[];
  /** Дни, которые сняться должны были, но рейс их не отдал: по нему выписан действующий лист. */
  frozen: LinearDayRef[];
}

const EMPTY: LinearDaysSyncResult = { detached: [], frozen: [] };

/**
 * Привести план по дням в соответствие с самой заявкой (ADR 0100 §11).
 *
 * Работа у сверки одна: снять с рейсов дни, которых больше не существует. Их бывает два вида —
 * день ушёл за срок (его сократило досрочное завершение или правка) и дней у заявки не стало
 * вовсе (отменили, вернули в «Новую», сняли технику, поставили арендную). Оба считает правило
 * контрактов, то же самое, которым портал объясняет неактивную строку таблицы.
 *
 * Идемпотентна и дешева на холостом ходу: сошлось — не делает ничего и не пишет событий. Это не
 * украшение, а условие — её зовут пять мест, включая те, что срока не меняют вовсе. Первый же
 * запрос отвечает пустотой у всех заявок, кроме линейных: `work_date` у остальных NULL.
 *
 * Замороженный выписанным листом рейс день не отдаёт: бланк уже у водителя, и исчезнуть из него
 * день не может — тем же правилом рейс держит заявку при смене статуса (`shouldDetachOnStatus`).
 * Такой день остаётся в плане с пометкой «вне срока» и ждёт, пока лист аннулируют.
 */
export async function syncLinearRouteDays(
  tx: Tx,
  params: {
    requestId: string;
    actor: { id: string };
    /** Почему сверка: попадёт в журнал аудита рядом с перечнем снятых дней. */
    reason: string;
  },
): Promise<LinearDaysSyncResult> {
  const rows = await plannedDayRows(tx, params.requestId);
  if (rows.length === 0) return EMPTY;

  const request = await loadLinearRequest(tx, params.requestId);
  if (!request) return EMPTY;
  // Общий запрет («дней у этой заявки больше нет») сильнее подённого: он снимает весь план.
  const blocker = linearDaysBlocker(request);
  const doomed = rows.filter(
    (row) => blocker !== null || !isShiftDayInTerm(request, row.workDate!),
  );
  if (doomed.length === 0) return EMPTY;

  const detached: LinearDayRef[] = [];
  const frozen: LinearDayRef[] = [];
  // Порядок блокировок один на модуль: рейсы берутся по возрастанию `id`, иначе две встречные
  // сверки встанут во взаимную блокировку (тем же порядком работает `lockRoutePair`).
  for (const row of [...doomed].sort((a, b) => a.routeId.localeCompare(b.routeId))) {
    const ref = { date: row.workDate!, routeNumber: formatVehicleRouteNumber(row.routeNum) };
    await lockRoute(tx, row.routeId);
    const waybill = await routeWaybill(tx, row.routeId);
    if (!isRouteEditable(waybill?.status ?? null)) {
      frozen.push(ref);
      continue;
    }
    await detachRequest(tx, row.routeId, params.requestId);
    await bumpRouteVersion(tx, row.routeId, params.actor.id);
    detached.push(ref);
  }
  return { detached, frozen };
}

/**
 * Событие аудита о снятых днях. Пишется после транзакции — как и все прочие события заявки, — и
 * только если план действительно изменился: молчаливая сверка событием не является.
 *
 * Дни, которых рейс не отдал, попадают в то же событие: по журналу должно быть видно не только
 * что сняли, но и что осталось в выданной бумаге вопреки сокращённому сроку.
 */
export async function auditLinearDaysSync(params: {
  actorUserId: string;
  requestId: string;
  reason: string;
  result: LinearDaysSyncResult;
}): Promise<void> {
  const { detached, frozen } = params.result;
  if (detached.length === 0 && frozen.length === 0) return;
  await writeAudit({
    actorUserId: params.actorUserId,
    action: 'vehicle_request.days_sync',
    entityType: 'vehicle_request',
    entityId: params.requestId,
    metadata: {
      reason: params.reason,
      detached: detached.map((d) => `${d.date} (${d.routeNumber})`),
      frozen: frozen.map((d) => `${d.date} (${d.routeNumber})`),
    },
  });
}

/** «ТС-123» заявки — им отказы и события называют заказ, чьи дни трогают. */
export function requestNumberOf(request: LinearRequestState): string {
  return formatVehicleRequestNumber(request.num);
}
