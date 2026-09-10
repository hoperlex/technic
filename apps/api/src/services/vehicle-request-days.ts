import { and, asc, eq, isNotNull } from 'drizzle-orm';
import {
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRouteEditable,
  isShiftDayInTerm,
  linearDaysBlocker,
  linearDaysOf,
  type LinearDayRef,
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
import { requestIsLinearSql } from '../db/linear-mode';
import { writeAudit, type AuditEntry } from '../lib/audit';
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
 * Сама сверка расщеплена надвое: `planLinearRouteDays` считает и **ничего не пишет**,
 * `applyLinearRouteDaysPlan` исполняет уже посчитанное. Разрез не украшение и не вкусовщина: он
 * единственный способ ответить «какие дни удержит выданная бумага», **не отцепив** ничего, — а
 * значит и до первой записи. Без этого ответа дверь не может ни показать человеку последствия
 * команды, ни связать показанное отпечатком, ни отказаться от команды целиком. Прежняя
 * `syncLinearRouteDays` осталась той же дверью для тех же пяти мест и складывается из этой пары.
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
 * Признак линейности читается у **заказанного** типа (ADR 0100 §1): заказ решает, как заявка
 * ведётся, ещё до того, как под неё нашли единицу, и менять этот ответ подбором машины нельзя.
 * Тем же выражением его читает сверка листов ЭСМ-2.
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
      // Режим заявки, а не признак справочника: заявку могло застать переключение (миграция 0137).
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
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

/*
 * Проекция дня наружу (`LinearDayRef`) переехала в контракты и здесь только перевыставлена: её
 * показывает окно закрытия фактической датой, а форма ответа обязана быть одна на сервер и портал.
 * Импортёры сервиса при этом не меняются — тип виден там же, где был.
 */
export type { LinearDayRef };

/**
 * Строка исполнимого плана: всё, чем день **отцепляют**, — а не то, чем его называют человеку.
 *
 * Второй тип рядом с `LinearDayRef` заведён не ради симметрии. В `LinearDayRef` лежат дата и
 * напечатанный номер рейса: этого хватает ответу и журналу, но не хватает исполнителю — рейс
 * блокируется, чистится и версионируется по `id`, а номер для этого не годится вовсе. Обратное
 * тоже верно: `routeId` человеку не объясняет ничего. Поэтому наружу идёт проекция
 * (`linearDayRefOf`), а `routeId` с версией остаются внутри модуля.
 */
export interface LinearDayPlanItem {
  date: string;
  /** По нему рейс берётся под блокировку, из него удаляется связь и по нему растёт версия. */
  routeId: string;
  /** Номер рейса: им план и называется человеку — второй раз за ним в базу не ходят. */
  routeNum: number;
  /**
   * Версия рейса на момент расчёта: под ней он и был прочитан. Сам исполнитель её не сверяет —
   * рукопожатие ведёт дверь: она хеширует показанный человеку план вместе с версиями и сравнивает
   * отпечаток при подтверждении. Внутри исполнения решает не версия, а блокировка рейса.
   */
  routeVersion: number;
  /**
   * Держит ли день выданный лист — считается там же, где читается рейс, и означает ровно «так было
   * на момент чтения». Что делать с такими днями, решает дверь, а не расчёт (ADR 0100 §11): правка
   * срока оставляет их предупреждением, коррекция задним числом отказывает.
   */
  frozen: boolean;
}

/** Чем кончилось чтение: дни, которые рейс отдаст, и дни, которых он не отдаст. */
export interface LinearDaysPlan {
  detachable: LinearDayPlanItem[];
  frozen: LinearDayPlanItem[];
}

/** Чем кончилась сверка дней: что снялось с рейсов и что осталось в выданной бумаге. */
export interface LinearDaysSyncResult {
  detached: LinearDayRef[];
  /** Дни, которые сняться должны были, но рейс их не отдал: по нему выписан действующий лист. */
  frozen: LinearDayRef[];
}

const EMPTY: LinearDaysSyncResult = { detached: [], frozen: [] };

/** Проекция плана наружу: дата и номер рейса — ими день и называют человеку и журналу. */
export function linearDayRefOf(item: LinearDayPlanItem): LinearDayRef {
  return { date: item.date, routeNumber: formatVehicleRouteNumber(item.routeNum) };
}

/**
 * Какие дни заказа обречены и какие из них держит выданная бумага — **чистым чтением**, без единой
 * записи.
 *
 * Зачем отдельно от исполнения. Сверка зовётся уже после записи нового срока и читает заявку из
 * базы — другого состояния она не знает. Значит вопрос «какие дни удержит выданный лист, если срок
 * сократить вот так» до первой записи задать было нечем: ответ узнавался только вместе с самим
 * отцеплением. Дверь, обязанная показать человеку последствия **до** команды и связать показанное
 * отпечатком, с таким устройством невозможна.
 *
 * Отсюда два параметра, и оба стоят вместо чтения из базы.
 *
 * `eligibilitySubject` — субъект, по которому решается **допустимость дня**. Обречённость считают
 * два правила: общий запрет `linearDaysBlocker` (тип заявки, линейность, архив, статус,
 * принадлежность машины, наличие срока) и подённая граница `isShiftDayInTerm`. Поэтому передаётся
 * весь субъект, а не одна дата: команда меняет срок и статус разом, и подстановка одного срока
 * дала бы план по состоянию, которого не будет.
 *
 * Имя — «субъект допустимости», а не «состояние после команды», и это часть решения, а не
 * вкусовщина. Дверь закрытия намеренно подставляет сюда прежний статус «В работе», хотя после
 * команды заявка станет «Выполненной»: назови параметр «состоянием после» — и первый же честный
 * рефакторинг подставил бы настоящий статус, а общий запрет тут же обрёк бы **все** дни заказа,
 * включая отработанные.
 *
 * `retainCompletedDays` — политика открыто, флагом, который видно в вызове. Общий запрет снимает
 * весь план целиком, и это верно, когда дней у заявки не стало вовсе: отменили, вернули в «Новую»,
 * поставили арендную машину. Закрытие заказа — не тот случай: рейс отработанного дня это след
 * состоявшейся работы, и «чей был выезд» обязано читаться и после закрытия. Флаг говорит,
 * распространяется ли общий запрет на дни **внутри срока**; день за сроком обречён при любой
 * политике — его у заказа больше нет.
 *
 * Заморозка читается без блокировки, и это верный ответ на верный вопрос: «что показать человеку и
 * на чём сойтись отпечатку». Решение «что можно снять прямо сейчас» принимает исполнитель и только
 * под блокировкой рейса.
 *
 * Транзакция чтению не нужна (`Reader`) — тем же правилом устроен весь читающий край модуля:
 * предпросмотр двери спрашивают вне транзакции, а сверка зовёт то же чтение своей.
 */
export async function planLinearRouteDays(
  reader: Reader,
  params: {
    requestId: string;
    eligibilitySubject: LinearDaySubject;
    retainCompletedDays: boolean;
  },
): Promise<LinearDaysPlan> {
  const rows = await plannedDayRows(reader, params.requestId);
  if (rows.length === 0) return { detachable: [], frozen: [] };

  const subject = params.eligibilitySubject;
  /*
   * Общий запрет («дней у этой заявки больше нет») сильнее подённого: он снимает весь план — но
   * ровно настолько, насколько это позволила дверь. С `retainCompletedDays` он не достаёт до дней
   * внутри срока, и от плана остаётся только хвост за границей.
   */
  const sweepsTerm = linearDaysBlocker(subject) !== null && !params.retainCompletedDays;
  const doomed = rows.filter((row) => sweepsTerm || !isShiftDayInTerm(subject, row.workDate!));
  if (doomed.length === 0) return { detachable: [], frozen: [] };

  // Листы обречённых рейсов — одной пачкой и по одному разу на рейс: день заказа не единственный
  // в рейсе, и спрашивать бумагу заново на каждый его день значило бы читать одно и то же.
  const waybills = await waybillsOfRoutes(
    reader,
    doomed.map((row) => row.routeId),
  );

  const detachable: LinearDayPlanItem[] = [];
  const frozen: LinearDayPlanItem[] = [];
  // Порядок — по дням (`plannedDayRows` читает их по возрастанию даты): план читают глазами, и
  // календарный порядок здесь единственный осмысленный. Свой порядок блокировок исполнитель
  // наводит сам — это его забота, а не читателя.
  for (const row of doomed) {
    const item: LinearDayPlanItem = {
      date: row.workDate!,
      routeId: row.routeId,
      routeNum: row.routeNum,
      routeVersion: row.routeVersion,
      frozen: !isRouteEditable(waybills.get(row.routeId)?.status ?? null),
    };
    (item.frozen ? frozen : detachable).push(item);
  }
  return { detachable, frozen };
}

/**
 * Исполнить посчитанное: снять названные планом дни с их рейсов (ADR 0100 §11).
 *
 * Заморозку исполнитель перечитывает **сам и под блокировкой**, а флаг `frozen` в строке плана на
 * веру не принимает. Между расчётом и исполнением лист успевают выписать, и день, снятый по
 * устаревшему ответу, исчез бы из бланка, который уже у водителя. Бывает и обратное: лист
 * аннулировали, и рейс отдаёт день, который расчёт считал замороженным. Поэтому в `frozen`
 * результата попадает то, чего не отдали **сейчас**, а не то, чего не отдавали при расчёте.
 *
 * Дверь вправе не передавать сюда дни, которые она разобрала сама: закрытие, например, отказывает
 * от команды целиком, если выданная бумага держит хоть один обречённый день, и до исполнения дело
 * не доходит вовсе. А правка срока отдаёт весь обречённый план — она снимает что снимается и
 * рассказывает про остальное.
 */
export async function applyLinearRouteDaysPlan(
  tx: Tx,
  plan: LinearDayPlanItem[],
  params: { requestId: string; actor: { id: string } },
): Promise<LinearDaysSyncResult> {
  if (plan.length === 0) return EMPTY;

  const detached: LinearDayRef[] = [];
  const frozen: LinearDayRef[] = [];
  // Порядок блокировок один на модуль: рейсы берутся по возрастанию `id`, иначе две встречные
  // сверки встанут во взаимную блокировку (тем же порядком работает `lockRoutePair`).
  for (const item of [...plan].sort((a, b) => a.routeId.localeCompare(b.routeId))) {
    const ref = linearDayRefOf(item);
    await lockRoute(tx, item.routeId);
    const waybill = await routeWaybill(tx, item.routeId);
    if (!isRouteEditable(waybill?.status ?? null)) {
      frozen.push(ref);
      continue;
    }
    await detachRequest(tx, item.routeId, params.requestId);
    await bumpRouteVersion(tx, item.routeId, params.actor.id);
    detached.push(ref);
  }
  return { detached, frozen };
}

/**
 * Есть ли у заявки распланированные дни вовсе — один дешёвый запрос вместо двух.
 *
 * Нужен ради холостого хода сверки: она зовётся пятью местами, и у нелинейной заявки обязана
 * кончаться первым же запросом. Читать ради этого субъект допустимости (пять join'ов по заявке)
 * значило бы платить за него на каждом переводе статуса любой заявки портала.
 */
async function hasPlannedDays(reader: Reader, requestId: string): Promise<boolean> {
  const [row] = await reader
    .select({ requestId: vehicleRouteRequests.requestId })
    .from(vehicleRouteRequests)
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), isNotNull(vehicleRouteRequests.workDate)),
    )
    .limit(1);
  return !!row;
}

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
 *
 * Сама сверка складывается из пары «чтение и исполнение» прежним порядком, и каждое слагаемое
 * говорит здесь ровно то, что говорило до расщепления:
 *
 * - субъект допустимости читается из базы — сверку зовут уже после записи нового срока, и другого
 *   состояния у неё нет и не было;
 * - политика прежняя: общий запрет снимает весь план, включая отработанные дни. Оставлять их в
 *   рейсах будет новая дверь закрытия, и это её решение, а не общего расчёта;
 * - исполнителю отдаётся **весь** обречённый план, вместе с тем, что чтение сочло замороженным.
 *   Так эта дверь и вела себя всегда: замороженное она узнаёт из-под блокировки рейса, а не из
 *   предварительного чтения, — и разбирать бумагу до записи ей незачем, она уже записала.
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
  if (!(await hasPlannedDays(tx, params.requestId))) return EMPTY;

  const request = await loadLinearRequest(tx, params.requestId);
  if (!request) return EMPTY;

  const plan = await planLinearRouteDays(tx, {
    requestId: params.requestId,
    eligibilitySubject: request,
    retainCompletedDays: false,
  });
  return applyLinearRouteDaysPlan(tx, [...plan.detachable, ...plan.frozen], {
    requestId: params.requestId,
    actor: params.actor,
  });
}

/**
 * Событие о снятых днях — **данными**, а не записью.
 *
 * Двум вызывающим нужно разное: статусная ручка пишет его после транзакции своим `writeAudit`, а
 * дверь канона возвращает события скелету и пишет их **в** транзакции (§8, шаг 13). Общее у них —
 * имя события, причина и состав перечней, и вторая их редакция разошлась бы ровно там, где журнал
 * читают глазами: одна и та же сверка выглядела бы по-разному в зависимости от двери.
 *
 * `null` — сверка ничего не изменила: молчаливая сверка событием не является, и запись «сняли
 * ноль дней» отличалась бы от отсутствия записи только длиной журнала.
 *
 * Дни, которых рейс не отдал, попадают в то же событие: по журналу должно быть видно не только
 * что сняли, но и что осталось в выданной бумаге вопреки сокращённому сроку.
 */
export function linearDaysSyncAudit(params: {
  reason: string;
  result: LinearDaysSyncResult;
}): AuditEntry | null {
  const { detached, frozen } = params.result;
  if (detached.length === 0 && frozen.length === 0) return null;
  return {
    action: 'vehicle_request.days_sync',
    metadata: {
      reason: params.reason,
      detached: detached.map((d) => `${d.date} (${d.routeNumber})`),
      frozen: frozen.map((d) => `${d.date} (${d.routeNumber})`),
    },
  };
}

/**
 * То же событие записью — вход тех вызывающих, у которых транзакция уже закрыта (статусная ручка,
 * досрочное завершение, отмена). Пишется после транзакции, как и все прочие события заявки.
 */
export async function auditLinearDaysSync(params: {
  actorUserId: string;
  requestId: string;
  reason: string;
  result: LinearDaysSyncResult;
}): Promise<void> {
  const entry = linearDaysSyncAudit(params);
  if (!entry) return;
  await writeAudit({
    ...entry,
    actorUserId: params.actorUserId,
    entityType: 'vehicle_request',
    entityId: params.requestId,
  });
}

/** «ТС-123» заявки — им отказы и события называют заказ, чьи дни трогают. */
export function requestNumberOf(request: LinearRequestState): string {
  return formatVehicleRequestNumber(request.num);
}
