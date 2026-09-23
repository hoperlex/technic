import { and, asc, eq } from 'drizzle-orm';
import {
  BACKDATE_REASON_MESSAGE,
  DAY_BATCH_LIMIT,
  DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
  DAY_BATCH_SKIP_BACKDATED,
  DAY_BATCH_SKIP_BEYOND_LIMIT,
  DAY_BATCH_SKIP_FROZEN,
  DAY_BATCH_SKIP_NO_ROOM,
  DAY_BATCH_SKIP_PLANNED,
  canIssueWaybill,
  canJoinRoute,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRelocationPurpose,
  isRouteEditable,
  linearDaysBlocker,
  linearRouteJoinDay,
  moscowDateKeyOf,
  planDayBlocker,
  routeRequestCapacity,
  shiftDaysOf,
  type BackdateVerdict,
  type DayBatchApplyInput,
  type VehicleRequestDayBatchResultDto,
  type VehicleRequestDayBatchRowDto,
  type VehicleRequestDaysDto,
  type WaybillFormCode,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  constructionObjects,
  persons,
  vehicleRequests,
  vehicleRouteRequests,
  vehicleRoutes,
} from '../db/schema';
import { writeAudit } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import { logger } from '../logger';
import { assignmentStateOn } from './assignment-history';
import { readActualChanges, readHistoryIsAuthoritative } from './assignment-read';
import { assertRoutePlacement, placeLinearDay } from './route-points';
import {
  asDayRaceConflict,
  assertDayRouteVehicle,
  loadLinearRequest,
  loadRequestDays,
  lockLinearRequest,
  openDayRoute,
  type LinearRequestState,
} from './vehicle-request-days';
import { markCorrectionWaybill } from './vehicle-route-correction';
import {
  attachRequest,
  bumpRouteVersion,
  lockRoute,
  plannedDaysOfRequest,
  routeRequestCount,
  routeWaybill,
  type RouteRow,
} from './vehicle-routes';
import {
  CORRECTION_OPERATION_ID_REQUIRED,
  checkBackdate,
  correctionFingerprint,
  findCorrection,
  insertCorrection,
  linkCorrectionRequests,
  sameCorrectionOrThrow,
  saveCorrectionPayload,
  type CorrectionRecord,
} from './waybill-correction';
import {
  issueWarningsOf,
  issueWaybillForRoute,
  loadWaybillIssueContext,
  routeWaybillFormFor,
  warningsFingerprint,
  type RouteWaybillContext,
} from './waybill-issue';

/**
 * Пачка дней заказа техники на объект: «выписать 4-П на весь период»
 * ([ADR 0207](../../../../docs/adr/0207-vehicle-request-day-batch.md), план
 * [docs/vehicle-request-day-batch-plan.md](../../../../docs/vehicle-request-day-batch-plan.md)).
 *
 * СВОИХ ПРАВИЛ У ПАЧКИ НЕТ НИ ОДНОГО. Она проходит срок подряд и на каждом дне делает ровно то же,
 * что делает подённая дверь (`POST /vehicle-requests/:id/days/:date/route`) и выписка листа по
 * рейсу: те же предикаты (`planDayBlocker`, `canJoinRoute`, `canIssueWaybill`), тот же порядок
 * блокировок (сначала рейс, потом заявка), та же общая точка выпуска листа. Второй набор правил
 * разошёлся бы с первым молча, и один и тот же день оказался бы то доступен, то нет в зависимости
 * от того, какой кнопкой его тронули.
 *
 * ОДНО ИСКЛЮЧЕНИЕ НАЗВАНО ВСЛУХ — рукопожатие предупреждений (§10): его пачка считает сама
 * (`issueDayWaybill`), и человек в нём не участвует. Предупреждения он читает уже в построчном
 * отчёте, после выписки.
 *
 * ЧТО У ПАЧКИ СВОЁ — ровно четыре вещи, и каждая названа решением ADR:
 *
 * 1. **Порция, а не весь срок** (§11). За нажатие берутся первые `DAY_BATCH_LIMIT` дней срока,
 *    которые ещё не стоят в рейсах; остаток добирается повторным нажатием — своим ключом операции
 *    и своей строкой журнала коррекций (`portionOf`).
 * 2. **Транзакция на день, а не на пачку** (§8). `takeNextNumber` держит строку серии под
 *    `FOR UPDATE` до конца транзакции, а серия `main` общая для всех 4-П портала: одна транзакция
 *    на пятьдесят листов остановила бы выписку бумаги во всём портале на всё время пачки. Платой
 *    стала неатомарность — оборвавшаяся посередине пачка оставляет сделанное сделанным, и это
 *    правильнее, чем откатывать уже выданную бумагу.
 * 3. **Отказ дня не роняет пачку** (§7). Ожидаемая помеха (день уже в рейсе, рейс заморожен, два
 *    рейса у машины, нет строк задания, прошлое без права) уходит строкой отчёта с готовым текстом
 *    контракта; всё прочее — `failed` с текстом отказа. Цикл идёт дальше.
 * 4. **Строка операции коррекции — ленивая, одна на пачку** (§9). Заводится в транзакции первого
 *    прошедшего дня, ДОШЕДШЕГО ДО ВЫПИСКИ: операция без единого листа засоряла бы журнал
 *    коррекций тем же способом, каким его засорила бы подённая дверь, если бы заводила операцию на
 *    каждую постановку дня.
 *
 * МАШИНА БЕРЁТСЯ ИЗ НАЗНАЧЕНИЯ, А НЕ ИЗ ТЕЛА (§5) — и на каждый день своя: заказ мог сменить
 * машину внутри срока (`docs/assignment-periods-plan.md`, Р3), и день обязан лечь на ту единицу,
 * которая работала именно в этот день. Свободный выбор в пачке развёл бы бумагу по двум машинам
 * так, что ни один экран этого не показал бы.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ожидаемая помеха дня — исключением, а не возвращённым значением.
 *
 * Причина в том, что помеха бывает найдена и ПОСЛЕ первой записи: рейс дня мог быть заведён, а
 * заявка под блокировкой сказать «этот день только что поставили в другой рейс». Возврат значения
 * оставил бы такой рейс в базе пустым и нигде не названным; брошенное исключение откатывает
 * транзакцию дня целиком, и в базе не остаётся ничего, кроме дырки в последовательности «Р-»
 * (ADR 0207, последствия: identity с транзакцией не откатывается).
 */
class DaySkip extends Error {
  constructor(
    readonly skipReason: string,
    /** Рейс, который день не принял: в отчёте он называется человеку. */
    readonly routeNumber?: string,
  ) {
    super(skipReason);
    this.name = 'DaySkip';
  }
}

/** Чем кончился день, дошедший до коммита. */
interface DayDone {
  routeId: string;
  routeNumber: string;
  /** Лист дня; `null` — пачку звали без выписки (`issueWaybills: false`). */
  waybill: { id: string; number: string } | null;
  /** Строка операции, если этот день её завёл или нашёл: наружу она уезжает одна на пачку. */
  correction: CorrectionRecord | null;
  backdated: boolean;
}

export interface DayBatchParams {
  requestId: string;
  /** Субъект: им спрашиваются права заднего числа и им же подписаны события журнала. */
  actor: Principal;
  input: DayBatchApplyInput;
}

/**
 * Выписать 4-П на весь период заказа.
 *
 * Возвращает построчный отчёт и новую таблицу дней: карточка обязана показать новую картину сразу,
 * а сходив за ней вторым запросом, она рискует показать уже не ту, по которой составлен отчёт.
 */
export async function runVehicleRequestDayBatch(
  params: DayBatchParams,
): Promise<VehicleRequestDayBatchResultDto> {
  const { requestId, actor, input } = params;
  const reason = input.reason?.trim() ?? '';
  /*
   * Сегодня по Москве — ОДИН раз на всю пачку и дальше параметром.
   *
   * Пятьдесят дней проходят не мгновенно, и пачка, начатая в 23:59, посчитала бы первую половину
   * дней по одной границе прошлого, а вторую — по другой: день «сегодня» стал бы прошедшим прямо
   * посреди работы, потребовал бы права коррекции и ушёл бы в пропуск. Граница заднего числа у
   * одного нажатия обязана быть одна.
   */
  const today = moscowDateKeyOf(new Date());

  // ── Предпроверка: всё, что способно отказать, спрашивается ДО первой записи ──

  const request = await loadLinearRequest(db, requestId);
  if (!request) throw err.notFound('Заявка не найдена');
  const blocker = linearDaysBlocker(request);
  if (blocker) throw err.unprocessable(blocker, { requestId: 'Дни недоступны' });

  const termDays = shiftDaysOf(request);
  /*
   * Порция нажатия считается ДО первой записи и по одному чтению уже распланированных дней.
   *
   * Чтение вне цикла и без блокировки — намеренно: как ЗАПРЕТ эти дни всё равно перечитывает
   * каждая транзакция дня под блокировкой заявки (`assertDayPlannable`), а здесь они нужны как
   * МЕРА порции, и мера считается один раз на нажатие. Разойдись картина за время пачки — день
   * уйдёт в отчёт пропуском, а не в чужой рейс.
   *
   * Транзакция здесь только ради сигнатуры `plannedDaysOfRequest` — записей в ней нет ни одной.
   */
  const { days, remaining } = portionOf(
    termDays,
    new Set(await db.transaction((tx) => plannedDaysOfRequest(tx, requestId))),
  );

  await assertObjectAddressable(requestId);
  await assertDriverAlive(input.driverPersonId);

  const vehicleByDay = await dayVehiclesOf(request, days);
  /*
   * Машина проверяется ОДИН раз на каждую свою единицу и до цикла (`assertDayRouteVehicle`).
   * Внутри цикла это значило бы читать одну и ту же строку полсотни раз, а отказать — посреди уже
   * заведённых рейсов, каждый из которых успел сжечь свой номер «Р-» из последовательности.
   *
   * Единиц бывает больше одной: заказ, сменивший машину внутри срока, работает первую половину
   * периода одной, вторую другой, и обе обязаны быть собственными и живыми до того, как пачка
   * заведёт первый рейс. Транзакция здесь только ради сигнатуры — записей в ней нет ни одной.
   */
  const vehicleIds = [...new Set(vehicleByDay.values())];
  await db.transaction(async (tx) => {
    for (const vehicleId of vehicleIds) await assertDayRouteVehicle(tx, vehicleId);
  });

  const verdicts = new Map<string, BackdateVerdict>(
    days.map((date) => [
      date,
      checkBackdate({ effectiveDate: date, today, subject: actor, hasReason: reason !== '' }),
    ]),
  );
  /*
   * Причина — одна на пачку и спрашивается ДО первой записи: объясняют не каждый день по
   * отдельности, а само решение оформить прошедший период. Отказ приходит только там, где причина
   * и есть единственное недостающее (`code === 'reason'`): нет права или слишком глубоко — это
   * помеха конкретных дней, а не всей пачки, и такие дни пропускаются, пока остальные идут.
   */
  if ([...verdicts.values()].some((v) => !v.ok && v.code === 'reason')) {
    throw err.unprocessable(BACKDATE_REASON_MESSAGE, { reason: 'Нужна причина' });
  }
  /*
   * Ключ операции обязателен ровно там, где пачка заведёт строку журнала коррекций и сожжёт
   * номера бланков задним числом: повтор после обрыва связи обязан продолжить прежнюю работу, а не
   * выписать вторую стопку. Сегодняшняя и будущая бумага операцией не является и ключа не требует.
   */
  const willBackdate =
    input.issueWaybills && [...verdicts.values()].some((v) => v.ok && v.backdated);
  if (willBackdate && !input.operationId) {
    throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
      operationId: 'Не передан ключ операции',
    });
  }

  // ── Цикл: своя транзакция на каждый день ──

  const fingerprint = correctionFingerprint({ kind: 'day_batch', target: requestId, body: input });
  const rows: VehicleRequestDayBatchRowDto[] = [];
  /** Строка операции — одна на пачку; заводит её первый прошедший день, дошедший до выписки. */
  let correction: CorrectionRecord | null = null;
  /** Листы, рождённые прошлым числом: ими объясняется операция в журнале коррекций. */
  const backdatedWaybills: { date: string; number: string; routeNumber: string }[] = [];

  for (const date of days) {
    const verdict = verdicts.get(date)!;
    if (!verdict.ok) {
      /*
       * Право и глубина — помеха этого дня, а не пачки (ADR 0207 §7): остальные дни срока к
       * прошлому отношения не имеют и выписываются как обычно.
       *
       * Два отказа, а не один: нет права — его выдают обычным порядком и человеку идти к
       * администратору за назначением; слишком давно — право у него есть, а глубину снимает
       * `waybills.correctBeyondLimit`, которое не назначается никому. Один текст на оба случая
       * отправил бы половину людей не туда. Отказ `reason` сюда не доходит: причина спрошена до
       * цикла, одна на пачку.
       */
      rows.push({
        date,
        outcome: 'skipped',
        reason: verdict.code === 'limit' ? DAY_BATCH_SKIP_BEYOND_LIMIT : DAY_BATCH_SKIP_BACKDATED,
      });
      continue;
    }
    const vehicleId = vehicleByDay.get(date)!;
    try {
      const done = await db.transaction((tx) =>
        runDay(tx, {
          request,
          date,
          vehicleId,
          actor,
          input,
          reason,
          backdated: verdict.backdated,
          fingerprint,
          // Найденная прежним днём операция едет вниз: искать её заново каждый день значило бы
          // читать журнал коррекций полсотни раз ради одной и той же строки.
          correction,
        }),
      );
      if (done.correction) correction = done.correction;
      if (done.waybill) {
        rows.push({
          date,
          outcome: 'issued',
          routeNumber: done.routeNumber,
          waybillNumber: done.waybill.number,
        });
        if (done.backdated) {
          backdatedWaybills.push({
            date,
            number: done.waybill.number,
            routeNumber: done.routeNumber,
          });
        }
      } else {
        rows.push({ date, outcome: 'planned', routeNumber: done.routeNumber });
      }
      await auditDay(actor, requestId, date, done, reason);
    } catch (e) {
      if (e instanceof DaySkip) {
        rows.push({
          date,
          outcome: 'skipped',
          reason: e.skipReason,
          ...(e.routeNumber ? { routeNumber: e.routeNumber } : {}),
        });
        continue;
      }
      /*
       * `failed` — всё, что не разобрано как ожидаемая помеха. Текст доменного отказа (422/409/404)
       * написан для человека и уходит в отчёт как есть; непредвиденный сбой отчёт называет общими
       * словами, а разбор оставляет логу — иначе в отчёт уехало бы содержимое исключения.
       */
      rows.push({ date, outcome: 'failed', reason: failureReasonOf(e) });
      logger.error(
        { requestId, date, operationId: input.operationId, err: e },
        'пачка дней заказа: сбой дня',
      );
    }
  }

  /*
   * Снимок операции и её связь с заявкой — ПОСЛЕ цикла и своей короткой транзакцией.
   *
   * После — потому что «что именно сделано задним числом» становится известно только когда сделано
   * всё; своей транзакцией — потому что транзакции дня к этому моменту уже закоммичены, а `db` в
   * эти функции не передаётся: строка журнала коррекций правится только из транзакции.
   */
  if (correction) {
    const id = correction.id;
    await db.transaction(async (tx) => {
      await saveCorrectionPayload(tx, id, {
        request: { id: requestId, number: formatVehicleRequestNumber(request.num) },
        term: {
          dateFrom: request.dateFrom ?? null,
          dateTo: request.dateTo ?? null,
          // Длина СРОКА, а не порции: снимок объясняет, какой период оформлен задним числом, и
          // «50» вместо «90» у квартального заказа читалось бы как урезанный срок заявки. Что
          // сделано именно этим нажатием, перечислено ниже поимённо — листами.
          days: termDays.length,
        },
        waybills: backdatedWaybills,
      });
      // Заявка у пачки одна, зато листов под операцией до пятидесяти: связь ведётся с заявкой, по
      // ней операцию и находит карточка разбирательства.
      await linkCorrectionRequests(tx, id, [requestId]);
    });
  }

  return {
    days: await daysResponse(requestId, request, today),
    rows,
    planned: rows.filter((row) => row.outcome === 'planned').length,
    issued: rows.filter((row) => row.outcome === 'issued').length,
    skipped: rows.filter((row) => row.outcome === 'skipped').length,
    failed: rows.filter((row) => row.outcome === 'failed').length,
    // Остаток считается по картине ДО нажатия и означает ровно «дни, которые в это нажатие не
    // вошли»: пересчитывать его после цикла значило бы вернуть в остаток и те дни порции, которые
    // пачка пропустила, — повтор с ними ничего не сделает, и «нажмите ещё раз» стало бы неправдой.
    remaining,
  };
}

/**
 * ПОРЦИЯ ОДНОГО НАЖАТИЯ (ADR 0207 решение 11): первые `DAY_BATCH_LIMIT` дней срока, которые ещё не
 * стоят в рейсах заявки, плюс остаток — сколько нераспланированных дней осталось за окном.
 *
 * Предел стоит на порции, а не на сроке. Отказ всему сроку отрезал бы от кнопки ровно тот случай,
 * ради которого её просили, — квартальный заказ: девяносто дней не прошли бы ни одним нажатием, и
 * диспетчер остался бы с таблицей «Дни работ» и девяноста заходами по три нажатия.
 *
 * МЕСТО В ПОРЦИИ ЗАНИМАЮТ ТОЛЬКО НЕРАСПЛАНИРОВАННЫЕ ДНИ. Уже стоящий в рейсе день пачка всё равно
 * пропустит (`DAY_BATCH_SKIP_PLANNED`), и, считай он за взятый, второе нажатие первым делом
 * упёрлось бы в полсотни своих же вчерашних дней и до хвоста срока не добралось бы никогда —
 * кнопку жали бы до бесконечности, а бумага не двигалась.
 *
 * В ОКНО такой день при этом попадает и строку отчёта получает: пачка прошла его и не сделала
 * ничего — промолчи она, это читалось бы как «сделала». Ради того же и окно не обрезается по
 * первому нераспланированному дню: когда распланировано уже всё, отчёт обязан объяснить пустую
 * работу, а не приехать пустым.
 */
function portionOf(
  termDays: readonly string[],
  planned: ReadonlySet<string>,
): { days: string[]; remaining: number } {
  const days: string[] = [];
  let taken = 0;
  let remaining = 0;
  for (const date of termDays) {
    const pending = !planned.has(date);
    if (taken >= DAY_BATCH_LIMIT) {
      if (pending) remaining += 1;
      continue;
    }
    if (pending) taken += 1;
    days.push(date);
  }
  return { days, remaining };
}

// ── Один день ──

interface DayContext {
  request: LinearRequestState;
  date: string;
  vehicleId: string;
  actor: Principal;
  input: DayBatchApplyInput;
  reason: string;
  /**
   * Идёт ли этот день задним числом — вердикт, посчитанный до цикла от общего «сегодня»
   * (`checkBackdate`). Пересчитывать его внутри транзакции нечем и незачем: второго «сегодня» у
   * одного нажатия не бывает, а календарь за время пачки успевает перевалить за полночь.
   */
  backdated: boolean;
  fingerprint: string;
  correction: CorrectionRecord | null;
}

/**
 * Один день пачки — в своей транзакции и тем же порядком, каким его проходит подённая дверь:
 * выбрать рейс → положить день в состав → разложить точку → проверить бланк → поднять версию →
 * (если просили) выписать лист.
 *
 * Порядок блокировок общий для модуля: сначала рейс, потом заявка. Обратный порядок здесь и был бы
 * клинчем со сменой статуса заявки, которая берёт те же строки в обратную сторону.
 */
async function runDay(tx: Tx, ctx: DayContext): Promise<DayDone> {
  const { date, request, actor } = ctx;

  /*
   * Дешёвая проверка правилом — ДО того, как заведётся рейс: у нового маршрута номер берётся из
   * последовательности, и отказ по сроку после его заведения сжёг бы «Р-» ни на что. Под
   * блокировкой она повторится теми же словами — здесь она про порядок, а не про правильность.
   */
  await assertDayPlannable(tx, request, date, await plannedDaysOfRequest(tx, request.id));

  const route = await pickDayRoute(tx, ctx);
  // Заявка — после рейса: порядок блокировок в модуле общий.
  const state = await lockLinearRequest(tx, request.id);
  if (!state) throw err.notFound('Заявка не найдена');
  const plannedDays = await plannedDaysOfRequest(tx, request.id);
  await assertDayPlannable(tx, state, date, plannedDays);

  const routeNumber = formatVehicleRouteNumber(route.num);
  const waybill = await routeWaybill(tx, route.id);
  if (!isRouteEditable(waybill?.status ?? null))
    throw new DaySkip(DAY_BATCH_SKIP_FROZEN, routeNumber);
  if (route.routeDate !== date) {
    // Составной FK (миграция 0127) день строки состава и день рейса держит равными: рейс соседнего
    // дня база просто не примет, и объяснять это отказом целостности нельзя.
    throw err.unprocessable(
      `Маршрут ${routeNumber} заведён на ${route.routeDate}, а планируется день ${date}`,
      { routeId: 'Рейс другого дня' },
    );
  }

  /*
   * Бланк рейса читается один раз: он задаёт и вместимость состава (`canJoinRoute`), и ёмкость
   * строк задания (`assertRoutePlacement`). Внутри одной транзакции справочник под нами не
   * меняется, а два чтения одного и того же — лишний запрос на каждый из пятидесяти дней.
   */
  const formCode = (
    await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId })
  ).formCode;

  const check = canJoinRoute(
    {
      requestType: state.requestType,
      isLinear: state.isLinear,
      status: state.status,
      deletedAt: state.deletedAt,
      day: linearRouteJoinDay(state, plannedDays),
      ownership: state.ownership,
    },
    {
      routeDate: route.routeDate,
      requestCount: await routeRequestCount(tx, route.id),
      purpose: route.purpose,
      formCode,
    },
  );
  if (!check.ok) throw err.unprocessable(check.reason, { routeId: check.reason });

  try {
    await attachRequest(tx, route.id, request.id, date);
  } catch (e) {
    // Гонка двух диспетчеров: ловит её уникальный индекс, а не проверка выше.
    throw asDayRaceConflict(e, date);
  }
  /*
   * Точка задания — той же транзакцией, что и строка состава: без неё день стоял бы в рейсе, но не
   * печатался — задание листа собирается из точек, а не из состава.
   */
  await placeLinearDay(tx, route.id, request.id, date);
  // Ёмкость проверяется после раскладки: считать надо строки задания (ездки плюс линейные дни), а
  // до постановки дня их на одну меньше.
  await assertRoutePlacement(tx, { routeId: route.id, formCode });
  await bumpRouteVersion(tx, route.id, actor.id);

  if (!ctx.input.issueWaybills) {
    /*
     * Бумаги не просили — день только встал в рейс. Задний ход при этом не исчезает: постановка
     * прошедшего дня прошла тот же `backdateGuard`, и событие журнала обязано это сказать. Своей
     * строки в журнале коррекций у такого дня нет по тому же правилу, что и у подённой двери:
     * номера строгой отчётности он не расходует, и операция без единого листа засоряла бы журнал.
     */
    return {
      routeId: route.id,
      routeNumber,
      waybill: null,
      correction: null,
      backdated: ctx.backdated,
    };
  }
  return issueDayWaybill(tx, ctx, route, routeNumber, formCode);
}

/**
 * Почему этот день не планируется — с разделением «ожидаемая помеха» и «сбой».
 *
 * Занятый день это ровно то, ради чего повтор пачки безопасен: он отсекается своим UNIQUE и здесь
 * называется готовым текстом контракта. Всё остальное, что вернул бы `planDayBlocker` (заявку
 * увели из работы, сняли технику, подвинули срок посреди пачки), помехой дня не является — это
 * смена состояния заказа, и молчаливым пропуском её объявлять нельзя.
 */
async function assertDayPlannable(
  tx: Tx,
  subject: LinearRequestState,
  date: string,
  plannedDays: readonly string[],
): Promise<void> {
  if (plannedDays.includes(date)) {
    // Рейс называется по имени: в отчёте на полсотни строк «день уже стоит в рейсе» без номера
    // не говорит, в каком именно, а диспетчер идёт разбираться именно туда. Запрос уходит только
    // на этой ветке — она и есть пропуск, — а не на каждом дне пачки.
    throw new DaySkip(DAY_BATCH_SKIP_PLANNED, await plannedDayRouteNumber(tx, subject.id, date));
  }
  const blocker = planDayBlocker(subject, date, plannedDays);
  if (blocker) throw err.unprocessable(blocker, { date: 'День недоступен' });
}

/**
 * Рейс, в котором день уже стоит. Строка состава ведёт в рейс составным ключом (миграция 0127), и
 * день без рейса тут не бывает по устройству — «Р-» у такого дня известен всегда.
 *
 * Почти всегда: `undefined` остаётся законным ответом на гонку. Первый заход `assertDayPlannable`
 * идёт до блокировки заявки, и между чтением распланированных дней и этим запросом чужая
 * транзакция успевает снять день с рейса. Ронять из-за этого пачку нечем и незачем: пропуск от
 * такого дня всё равно правильный, просто без имени рейса.
 */
async function plannedDayRouteNumber(
  tx: Tx,
  requestId: string,
  date: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ num: vehicleRoutes.num })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRoutes, eq(vehicleRoutes.id, vehicleRouteRequests.routeId))
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), eq(vehicleRouteRequests.workDate, date)),
    );
  return row ? formatVehicleRouteNumber(row.num) : undefined;
}

/**
 * ПРАВИЛО ВЫБОРА РЕЙСА ДНЯ — своё, потому что готового запроса под него нет.
 *
 * `GET /vehicle-routes/suggest` не годится: он отдаёт диспетчеру всё, что есть у машины на дату, и
 * выбирает человек — глазами и без блокировки. Пачке выбирать некому, а между чтением и вставкой
 * лежит чужая транзакция, поэтому кандидаты берутся под `FOR UPDATE` и решение принимается по уже
 * заблокированным строкам.
 *
 * Кандидаты — грузовые рейсы этой машины на эту дату. Перегон отсеивается раньше всего и не
 * считается кандидатом вовсе: состава у него нет по устройству (он едет по своей
 * заявке-основанию), и «у машины два рейса» про него было бы неправдой.
 *
 * Дальше решают три числа, и порядок между ними именно такой:
 *
 *   нет ни одного грузового рейса   → пачка заводит свой (`openDayRoute`);
 *   годных больше одного            → день пропускается (`DAY_BATCH_SKIP_AMBIGUOUS_ROUTE`);
 *   годен ровно один                → день едет в него;
 *   есть рейсы, но ни один не годен → называется причина первого: заморожен либо нет места.
 *
 * Последняя строка — не мелочь. Заведи пачка второй рейс рядом с замороженным, и у машины на день
 * оказалось бы два бланка на одну работу; ответь она «ноль кандидатов» там, где в бланке кончились
 * строки, — диспетчер не узнал бы, что уплотнять день больше нечем. Выбор между двумя годными
 * рейсами (утро и вечер — законное состояние) пачка на себя не берёт: ошибись она, день уехал бы в
 * чужое задание, а заметили бы это у принтера.
 */
async function pickDayRoute(tx: Tx, ctx: DayContext): Promise<RouteRow> {
  const ids = await tx
    .select({ id: vehicleRoutes.id, purpose: vehicleRoutes.purpose })
    .from(vehicleRoutes)
    .where(and(eq(vehicleRoutes.vehicleId, ctx.vehicleId), eq(vehicleRoutes.routeDate, ctx.date)))
    .orderBy(asc(vehicleRoutes.id));

  const candidates: RouteRow[] = [];
  // Порядок блокировок один на модуль: рейсы берутся по возрастанию `id`, иначе две встречные
  // команды на тех же рейсах встанут во взаимную блокировку.
  for (const row of ids) {
    if (isRelocationPurpose(row.purpose)) continue;
    candidates.push(await lockRoute(tx, row.id));
  }
  if (candidates.length === 0) {
    return openDayRoute(tx, {
      body: {
        // Машина — из назначения на этот день (ADR 0207 §5), водитель — один на весь период
        // (§6): поля машины в окне нет вовсе, а человека без ответа не подставляют (ADR 0083).
        newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.input.driverPersonId },
      },
      date: ctx.date,
      actorId: ctx.actor.id,
    });
  }

  const eligible: RouteRow[] = [];
  let refusal: DaySkip | null = null;
  for (const candidate of candidates) {
    const number = formatVehicleRouteNumber(candidate.num);
    const waybill = await routeWaybill(tx, candidate.id);
    if (!isRouteEditable(waybill?.status ?? null)) {
      refusal ??= new DaySkip(DAY_BATCH_SKIP_FROZEN, number);
      continue;
    }
    const formCode = (
      await routeWaybillFormFor(tx, { purpose: candidate.purpose, vehicleId: candidate.vehicleId })
    ).formCode;
    if ((await routeRequestCount(tx, candidate.id)) >= routeRequestCapacity(formCode)) {
      refusal ??= new DaySkip(DAY_BATCH_SKIP_NO_ROOM, number);
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length > 1) {
    throw new DaySkip(DAY_BATCH_SKIP_AMBIGUOUS_ROUTE, formatVehicleRouteNumber(eligible[0]!.num));
  }
  if (eligible.length === 0) throw refusal ?? new DaySkip(DAY_BATCH_SKIP_NO_ROOM);
  return eligible[0]!;
}

/**
 * Лист дня: `lockRoute` → `canIssueWaybill` → `issueWaybillForRoute`.
 *
 * РУКОПОЖАТИЕ ПАЧКА СЧИТАЕТ САМА (ADR 0207 §10). У одиночной выписки отпечаток набора
 * предупреждений приносит человек — он их прочитал в окне; пачке приносить его неоткуда: наборов
 * до пятидесяти, и каждый известен только под уже взятыми блокировками. Поэтому сервер собирает
 * контекст, считает набор и подставляет его отпечаток в `acknowledge` сам.
 *
 * ЦЕНА НАЗВАНА ПРЯМО: у пачки рукопожатия человека нет вовсе. Он не подтверждает ни сводку (её не
 * показывают: двери предпросмотра у пачки не существует), ни набор по каждому листу — и узнаёт о
 * предупреждениях из построчного отчёта, когда бумага уже выписана. `acknowledge` здесь означает
 * не «человек прочитал», а «набор посчитан при выпуске», и в листе остаётся ровно тем, чем был
 * при рождении. У одиночной выписки правило (ADR 0108 п. 21) не меняется ничем.
 *
 * Контекст читается дважды — здесь и внутри `issueWaybillForRoute`. Это чтение, а не запись, и
 * альтернатива ему — поле «уже посчитанный набор» в сигнатуре общей точки выпуска, то есть ровно
 * та дыра, ради закрытия которой рукопожатие и живёт внутри неё (`waybill-issue.ts`, Р21а).
 */
async function issueDayWaybill(
  tx: Tx,
  ctx: DayContext,
  locked: RouteRow,
  routeNumber: string,
  formCode: WaybillFormCode | null,
): Promise<DayDone> {
  // Рейс перечитывается под той же блокировкой: версия выросла раскладкой дня, а в контекст листа
  // уезжают реквизиты рейса — брать их из строки, прочитанной до правки, значило бы печатать не то.
  const route = await lockRoute(tx, locked.id);
  const backdated = ctx.backdated;

  /*
   * Состав берётся под `FOR UPDATE` строк заявок и по возрастанию их `id` — тем же порядком, каким
   * их берёт аннулирование листа (`waybill-locks.ts`). Два порядка на одних строках это клинч на
   * первом же рейсе, где номера талонов идут не в порядке идентификаторов; позиция талона важна
   * бумаге и поэтому сортируется уже в памяти.
   */
  const composition = await tx
    .select({
      requestId: vehicleRouteRequests.requestId,
      position: vehicleRouteRequests.position,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .where(eq(vehicleRouteRequests.routeId, route.id))
    .orderBy(asc(vehicleRequests.id))
    .for('update', { of: vehicleRequests });
  const rows = [...composition].sort((a, b) => a.position - b.position);

  const check = canIssueWaybill({
    purpose: route.purpose,
    driverPersonId: route.driverPersonId,
    // Пустого бланка у пачки не бывает по устройству: день только что встал в состав этого рейса.
    blankAllowed: false,
    formCode,
    requests: rows.map((row) => ({
      displayNumber: formatVehicleRequestNumber(row.num),
      status: row.status,
    })),
    sourceRequest: null,
    waybillStatus: (await routeWaybill(tx, route.id))?.status ?? null,
  });
  if (!check.ok) {
    throw err.unprocessable(
      check.blocking.length > 0 ? `${check.reason}: ${check.blocking.join(', ')}` : check.reason,
    );
  }

  const context: RouteWaybillContext = {
    routeId: route.id,
    routeNumber,
    purpose: route.purpose,
    vehicleId: route.vehicleId,
    routeDate: route.routeDate,
    driverPersonId: route.driverPersonId!,
    trip: {
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      trailer2Model: route.trailer2Model,
      trailer2RegNumber: route.trailer2RegNumber,
      garageNumber: route.garageNumber,
      communicationKind: route.communicationKind,
      transportationKind: route.transportationKind,
    },
    requests: rows.map((row) => ({ requestId: row.requestId, position: row.position })),
    relocation: null,
    acknowledge: null,
    actor: { id: ctx.actor.id },
  };
  const warnings = issueWarningsOf(await loadWaybillIssueContext(tx, context));
  const issued = await issueWaybillForRoute(tx, {
    ...context,
    // Пустой набор рукопожатия не требует вовсе, и подставлять отпечаток пустого списка незачем:
    // общая точка выпуска запишет в лист `clean` — «проверено, предупреждений не было».
    acknowledge: warnings.length > 0 ? { fingerprint: warningsFingerprint(warnings) } : null,
  });

  if (!backdated) {
    return { routeId: route.id, routeNumber, waybill: issued, correction: null, backdated };
  }
  /*
   * ЛЕНИВАЯ СТРОКА ОПЕРАЦИИ (ADR 0207 §9): заводится здесь — в транзакции первого прошедшего дня,
   * дошедшего до выписки, — и ни минутой раньше. Заведи её пачка до цикла, и журнал коррекций
   * пополнялся бы операцией на каждое нажатие, в том числе на то, где все прошедшие дни оказались
   * пропущены и ни одного номера не сгорело. По тому же правилу подённая дверь не заводит операцию
   * вовсе: постановка дня в рейс номера строгой отчётности не расходует.
   *
   * `runCorrection` здесь не годится и не используется: он открывает СВОЮ транзакцию вокруг всей
   * работы, а у пачки транзакция своя на каждый день (§8). Поэтому те же три шага вызываются
   * вручную — но именно те же самые функции: собственный INSERT в журнал коррекций запрещён, там
   * про это написано прямо.
   */
  const correction = ctx.correction ?? (await openCorrection(tx, ctx));
  await markCorrectionWaybill(tx, {
    waybillId: issued.id,
    correctionId: correction.id,
    reason: ctx.reason,
    // Заменять было нечего: лист прошедшего дня рождён не взамен другого, и объяснён причиной при
    // пустой ссылке (`waybills_correction_issue_reason_check`).
    correctsWaybillId: null,
  });
  return { routeId: route.id, routeNumber, waybill: issued, correction, backdated };
}

/**
 * Строка операции по ключу клиента: нашлась — сверяется теми же двумя признаками, что и у всех
 * прочих входов коррекции (автор и отпечаток тела), не нашлась — вставляется.
 *
 * Повтор с ТЕМ ЖЕ телом продолжает работу прежней пачки: дни, уже поставленные в рейсы, отсекутся
 * своим UNIQUE и уйдут в пропуск, а недоделанные доделаются под той же операцией. Повтор с ДРУГИМ
 * телом упирается в `sameCorrectionOrThrow` — и это правильный исход: ключ отвечает лишь на
 * «повтор?», и клиент, переиспользовавший uuid, иначе молча получил бы чужую работу.
 */
async function openCorrection(tx: Tx, ctx: DayContext): Promise<CorrectionRecord> {
  const expected = { actorUserId: ctx.actor.id, fingerprint: ctx.fingerprint };
  const operationId = ctx.input.operationId!;
  const prior = await findCorrection(tx, operationId);
  if (prior) return sameCorrectionOrThrow(prior, expected);
  return insertCorrection(tx, {
    operationId,
    fingerprint: ctx.fingerprint,
    kind: 'day_batch',
    reason: ctx.reason,
    actorUserId: ctx.actor.id,
  });
}

// ── Предпроверки ──

/**
 * Объект заявки и его адрес — до первой записи.
 *
 * `placeLinearDay` откажет без адреса площадки (точка без адреса не заводится, CHECK
 * `location_not_blank`), и отказ этот пришёл бы на середине пачки — после того, как рейс дня уже
 * заведён и его номер сожжён. Правило от этого не раздвоилось: решает по-прежнему `placeLinearDay`,
 * здесь только вопрос «есть ли чему быть адресом», заданный заранее.
 */
async function assertObjectAddressable(requestId: string): Promise<void> {
  const [row] = await db
    .select({
      objectId: vehicleRequests.objectId,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  if (
    !row.objectId ||
    [row.objectName, row.objectAddress].filter(Boolean).join(', ').trim() === ''
  ) {
    throw err.unprocessable(
      'У заявки не выбран объект — дням заказа неоткуда взять адрес площадки',
      { objectId: 'Нет объекта заявки' },
    );
  }
}

/**
 * Водитель существует и не снят.
 *
 * Существование, а не допуск: допуск спрашивается отбором при выписке листа (ADR 0037 п. 6) — там
 * же, где он и проверяется у одиночной выписки. Здесь важно другое: человек один на весь период, и
 * «такого нет» обязано прозвучать до того, как пачка заведёт полсотни рейсов с ссылкой на него.
 */
async function assertDriverAlive(driverPersonId: string): Promise<void> {
  const [driver] = await db
    .select({ deletedAt: persons.deletedAt })
    .from(persons)
    .where(eq(persons.id, driverPersonId));
  if (!driver || driver.deletedAt) throw err.badRequest('Водитель не найден');
}

/**
 * Машина каждого дня срока — тем же правилом, каким её читают соседи (`requestDayVehicleSql`,
 * [assignment-read.ts](./assignment-read.ts)): в режиме `history` отвечает последнее действующее
 * изменение шкалы машины не позже дня, а где истории нет — назначение, ровно как в `legacy`.
 *
 * TS-формой того же правила, а не SQL-выражением, и по двум причинам. Первая: дней до пятидесяти, а
 * вопрос к истории один — прочитать её строки один раз и свернуть в памяти дешевле полусотни
 * коррелированных подзапросов. Вторая: `requestDayVehicleSql` живёт в `WHERE` и в условиях
 * соединения, а в списке столбцов односоставного запроса drizzle теряет квалификацию колонок
 * (`office-equipment-sql-correlation.test.ts`). Настоящая свёртка (`assignmentStateOn`) — тот же
 * единственный носитель правила, к которому SQL-форма и отсылает.
 */
async function dayVehiclesOf(
  request: LinearRequestState,
  days: readonly string[],
): Promise<Map<string, string>> {
  // Назначение непусто: без него `linearDaysBlocker` не пустил бы пачку дальше («на заявку не
  // назначена техника»), — но ответ на вопрос «чем работали» это всё равно запасной.
  const assigned = request.vehicleId;
  if (!assigned) throw err.unprocessable('На заявку не назначена техника — дни планировать нечем');

  const map = new Map(days.map((date) => [date, assigned]));
  if (!(await readHistoryIsAuthoritative())) return map;
  const changes = (await readActualChanges([request.id])).get(request.id) ?? [];
  if (changes.length === 0) return map;
  for (const date of days) {
    const state = assignmentStateOn(changes, date);
    if (state.vehicle) map.set(date, state.vehicle.vehicleId);
  }
  return map;
}

// ── Ответ и журнал ──

/** Таблица дней после пачки — тем же составом, каким её отдаёт чтение карточки. */
async function daysResponse(
  requestId: string,
  fallback: LinearRequestState,
  today: string,
): Promise<VehicleRequestDaysDto> {
  // Состояние перечитывается: пачка шла полсотни транзакций, и отвечать таблицей, построенной по
  // состоянию до неё, значило бы показать не то, о чём только что составлен отчёт.
  const request = (await loadLinearRequest(db, requestId)) ?? fallback;
  return {
    items: await loadRequestDays(db, request),
    onDate: today,
    blocker: linearDaysBlocker(request),
  };
}

/**
 * События дня — теми же именами, что у одиночных дверей, и ПОСЛЕ коммита дня.
 *
 * Имена общие намеренно: состав рейса изменился и номер бланка выдан — в журнале это обязано
 * читаться одинаково, откуда бы ни пришли. Задний ход объясняется прямо в событии: у постановки дня
 * своей строки в журнале коррекций нет, и «почему день поставлен прошедшим числом» рассказывается
 * здесь.
 */
async function auditDay(
  actor: Principal,
  requestId: string,
  date: string,
  done: DayDone,
  reason: string,
): Promise<void> {
  await writeAudit({
    actorUserId: actor.id,
    action: 'vehicle_route.attach',
    entityType: 'vehicle_route',
    entityId: done.routeId,
    metadata: { requestId, workDate: date, backdated: done.backdated, reason },
  });
  if (!done.waybill) return;
  await writeAudit({
    actorUserId: actor.id,
    action: 'waybill.issue',
    entityType: 'waybill',
    entityId: done.waybill.id,
    metadata: {
      number: done.waybill.number,
      routeId: done.routeId,
      blank: false,
      backdated: done.backdated,
      reason,
      correctionId: done.correction?.id ?? null,
    },
  });
}

/**
 * Чем отчёт объясняет сорвавшийся день.
 *
 * Доменный отказ (422, 409, 404) написан для человека и ничего лишнего не раскрывает — он уходит в
 * отчёт как есть. Всё прочее называется общими словами: содержимое непредвиденного исключения в
 * отчёте не помогает никому, а разбор лежит в логе по заявке и дате.
 */
function failureReasonOf(e: unknown): string {
  if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500) {
    return e.message || 'День не проведён';
  }
  return 'Сбой при обработке дня — попробуйте повторить пачку';
}
