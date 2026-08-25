import { z } from 'zod';
// Периоды назначения (`docs/assignment-periods-plan.md`, Я5): добавляемая часть тела смены техники
// описана там одним объектом, и расширение берёт поле **оттуда**, а не пишет его копию.
// Обратной зависимости нет — `assignment-periods.ts` про заявку не знает вовсе, — значит и цикла
// импортов здесь не возникает.
import { changeVehicleAssignmentExtrasSchema } from './assignment-periods';
import {
  requestStatusLabels,
  requestStatusSchema,
  statusChangeRequiresReason,
  vehicleRequestTypeSchema,
  type VehicleRequestType,
} from './enums';
import type { RequestStatus } from './enums';
import { allowedStatusTransitions, can, type AccessSubject } from './permissions';
import {
  archiveFilterSchema,
  baseListQuery,
  contactIssue,
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  normalizePhone,
  uuidSchema,
} from './common';
import {
  ADDRESS_NOT_VERIFIED_MESSAGE,
  type AddressMeta,
  addressMetaSchema,
  verifiedAddressMetaSchema,
} from './address';
import { type CostTarget, costTargetOf, type CostTargetSource } from './cost-target';
import type { FileDto } from './files';
// Разбор ключа `forms` — общий со срезом гаража: бланк работы дня спрашивают на двух вкладках, и
// перечень значений у обеих один — справочник бланков (`WAYBILL_FORM_CODES`).
import { garageFormFilterSchema } from './garage';
import {
  shiftHoursSchema,
  vehicleLabel,
  type VehicleOwnership,
  vehiclePriceSchema,
  type VehicleSpecValues,
} from './vehicles';
import {
  assignRouteSchema,
  createRelocationRouteSchema,
  MAX_ROUTE_REQUESTS,
  type VehicleRequestRouteDto,
  waybillAcknowledgeSchema,
} from './vehicle-routes';
import type { WaybillWarning } from './waybill-task-rows';
import {
  requestTripSchema,
  requestTripsSchema,
  type VehicleRequestTripDto,
} from './vehicle-request-trips';
import type { Esm2Period, WaybillFormCode } from './waybills';
import {
  WORK_TIME_MESSAGE,
  isAllowedRequestDate,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
  moscowDateKeyOf,
  moscowMinutesOf,
  shiftDateKey,
} from './time';
import type { VehicleRequestShiftsSummaryDto } from './vehicle-request-shifts';
import {
  classificationFilterSchema,
  withSingleClassificationForm,
} from './vehicle-classifications';

/** Код вида ТС (`vehicle_kinds.code`), которым выполняют грузоперевозки. */
export const FREIGHT_VEHICLE_KIND_CODE = 'freight_transport';

/**
 * Технику какого вида можно заказать заявкой этого типа.
 *
 * Тип заявки выбирается в форме явно и из вида ТС не выводится: на объект вызывают технику
 * любого вида (и спецтехнику, и грузовую — самосвал под вывоз грунта работает на объекте),
 * а грузоперевозку выполняют только грузовым видом.
 */
export function isVehicleKindAllowedForRequest(
  requestType: VehicleRequestType,
  kindCode: string,
): boolean {
  return requestType === 'freight_transport' ? kindCode === FREIGHT_VEHICLE_KIND_CODE : true;
}

/**
 * Нужен ли заявке объём или масса груза.
 *
 * Не нужен там, где груза не бывает: легковая машина возит людей, и в её бланке (форма № 3)
 * графа «Груз» заполняется от руки в тех редких рейсах, когда что-то везут. Требовать «объём или
 * массу» у поездки означало бы заставлять заявителя выдумывать число.
 *
 * Правило спрашивает бланк, а не код типа: бланк — это то, чем тип отличается по существу, и
 * заведённый завтра второй легковой тип попадёт под него сам, без правки списка исключений.
 */
export function isCargoAmountRequired(formCode: WaybillFormCode | null): boolean {
  return formCode !== 'leg3';
}

export const CARGO_AMOUNT_MESSAGE = 'Укажите объём или массу';

/** Отображаемый номер заявки ТС: «ТС-123» (в БД хранится только число). */
export function formatVehicleRequestNumber(num: number): string {
  return `ТС-${num}`;
}

/** Разбор пользовательского ввода поиска: «123» / «ТС-123» / «ТС-000123» → 123. */
export function parseVehicleRequestNumberSearch(input: string): number | undefined {
  const digits = input.replace(/\D/g, '');
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ── Заблаговременность заявки на технику (ADR 0104) ──
// Технику заказывают заранее: наряд на завтра диспетчер собирает днём — распределяет машины,
// назначает водителей, выписывает бланки, — и заявка, поданная вечером «на завтра», в этот наряд
// уже не попадает. Поэтому у заявителя ближайший доступный день зависит от часа подачи: до 15:00
// по МСК он заказывает на завтра, с 15:00 — на послезавтра.
//
// Тех, кто заказы **ведёт** (диспетчер, менеджер, администратор), правило не касается вовсе:
// срочная подача день в день — их работа, а запрет отправил бы такую заявку в обход портала
// звонком. Прошлое им открывает отдельное право на коррекцию (ADR 0101) — заблаговременность его
// не двигает и с ним не спорит: она поднимает нижнюю границу только там, где прошлого нет.

/** Отсечка приёма заявок на завтра — 15:00 МСК. Ровно в 15:00 она уже прошла. */
export const VEHICLE_REQUEST_CUTOFF_MINUTES = 15 * 60;

/**
 * Заявитель — тот, кто технику заказывает, но заказ по статусам не ведёт: штаб, руководитель
 * строительства, обе роли отдела.
 *
 * Спрашивается право, а не имя роли: `vehicleRequests.status` — это ровно «ведёт заказ», и
 * следующая роль по любую сторону границы попадёт под правило сама, без правки списка. У
 * арендодателя право есть (он закрывает выполненное), но проверка его не касается: завести заявку
 * он не может вовсе.
 */
export function isVehicleRequestRequester(subject: AccessSubject | null | undefined): boolean {
  return !can(subject, 'vehicleRequests.status');
}

/**
 * Ближайший день, на который субъект вправе назначить заявку (`YYYY-MM-DD`, МСК):
 *
 * - заявитель до 15:00 — завтра, с 15:00 — послезавтра;
 * - тот, кто ведёт заказы, — сегодня, как и прежде.
 *
 * Одна функция на форму и сервер: по ней портал запирает дни в календаре, ею же ручка отвечает
 * отказом — иначе дейтпикер предлагал бы дату, которую сервер не примет.
 */
export function minVehicleRequestDateKey(
  subject: AccessSubject | null | undefined,
  now: Date = new Date(),
): string {
  const today = moscowDateKeyOf(now);
  if (!isVehicleRequestRequester(subject)) return today;
  return shiftDateKey(today, moscowMinutesOf(now) < VEHICLE_REQUEST_CUTOFF_MINUTES ? 1 : 2);
}

/** Сообщение о слишком близкой дате — одинаковое в форме и в ответе API. */
export const VEHICLE_REQUEST_LEAD_TIME_MESSAGE =
  'Технику заказывают заранее: на завтра — до 15:00, после 15:00 — начиная с послезавтра';

/**
 * Почему эта дата заявке недоступна — текстом, либо `null`, если доступна (тот же приём, что у
 * `earlyEndBlocker` и `retypeBlocker`).
 *
 * `effectiveDate` — день, на который заказывают технику: у заказа на объект начало срока, у
 * грузоперевозки день подачи, у правки — он же, если она его двигает (`movedRequestStartKey`).
 * Правку, которая этого дня не трогает, спрашивать не о чем: заявка на завтра, заведённая утром,
 * не должна переставать сохраняться в 15:01 из-за уточнённого телефона.
 *
 * Прошлое сюда не приходит: без объявленной причины его отклоняет схема, с причиной — вердикт
 * `backdateGuard` (право, глубина). Заблаговременность отвечает только за ближний край.
 */
export function vehicleRequestLeadTimeBlocker(
  subject: AccessSubject | null | undefined,
  effectiveDate: string,
  now: Date = new Date(),
): string | null {
  return effectiveDate < minVehicleRequestDateKey(subject, now)
    ? VEHICLE_REQUEST_LEAD_TIME_MESSAGE
    : null;
}

// ── Общие подсхемы ──
// Адреса и количество своих подсхем здесь больше не имеют: их предмет переехал на ездку (Р2), и
// границы полей живут там же, одной записью (`tripLocationSchema`, `tripAmountSchema` в
// `vehicle-request-trips.ts`). Этап 1 держал их в двух местах намеренно и обещал, что копии
// переживут ровно один релиз, — вот он и кончился.
const commentSchema = z.string().trim().max(2000);
const fileIdsSchema = z.array(uuidSchema).max(20);

/** ISO 8601 с обязательным offset (напр. 2026-07-25T14:30:00+03:00). */
const scheduledAtSchema = z.string().datetime({ offset: true });

/**
 * Причина заднего числа (ADR 0101, Р6/Р15): «техника вышла во вторник, а заявку оформили в среду».
 *
 * Поле есть и в заведении, и в правке, и в обоих случаях необязательно **для схемы**: нужна
 * причина или нет, решает дата — а сравнивать её с «сегодня» по-настоящему может только сервер,
 * который знает субъекта и его права (`backdateGuard`). Схема же знает лишь текст, поэтому берёт
 * на себя одно: пустую отговорку («   ») она не примет, а причина уйдёт в запись операции (Р16) и
 * останется единственным объяснением того, почему заявка заведена вчерашним днём.
 */
const backdateReasonSchema = z.string().trim().min(1, 'Укажите причину').max(2000);

/**
 * Отказ схемы на прошлом, о котором не сказали ни слова (ADR 0101, Р15).
 *
 * Называет оба условия сразу, потому что схема не знает, какого из них не хватает: право живёт у
 * субъекта, а из тела видно только причину. Человеку это и нужно — «допишите объяснение» плюс «а
 * если права нет, объяснение не поможет»; сервер, получив причину, ответит уже точным кодом
 * (`backdateGuard`: 403 на право, 422 на глубину).
 */
export const BACKDATE_UNDECLARED_MESSAGE =
  'Дата в прошлом: задним числом заявку заводят с причиной и правом на коррекцию — без объяснения принимается сегодня и позже';

/**
 * Ключ идемпотентности операции задним числом (Р31) — тот же по смыслу, что у списания бланка
 * (`cancelWaybillSchema.operationId`).
 *
 * Необязателен, потому что обычное заведение и обычная правка операцией не являются: требовать
 * ключ под каждую заявку значило бы объявить коррекцией всю дневную работу. Сервер спрашивает его
 * ровно тогда, когда дата операции уже прошла, — и отвечает `CORRECTION_OPERATION_ID_REQUIRED`.
 *
 * Зачем он здесь вообще: правка срока сжигает номера ЭСМ-2 (сверка переоформляет недели), а сеть
 * рвётся. Версия заявки от повтора не спасает — она ответит 409 там, где человек ждёт «уже
 * сохранено», и заставит его открыть карточку и сверять глазами, что именно доехало.
 */
const operationIdSchema = uuidSchema;

/**
 * Своё время ездки лежит в календарном дне заявки (Р18).
 *
 * Не придирка к оформлению: датой рейса, фильтрами списка и рабочим окном заведует `scheduledAt`
 * **заявки** (Р3), а «заявка едет одним маршрутом целиком» (Р7) — инвариант состава. Ездка «на
 * завтра» внутри сегодняшней заявки развалила бы оба: рейс собрался бы на один день, а задание
 * водителю показало бы другой.
 *
 * Сообщение общее у схемы и сервера: схема ловит случай, когда день заявки виден из тела (заведение
 * и правка, двигающая подачу), сервер — все остальные, ему сохранённый день известен всегда.
 */
export const TRIP_DAY_MESSAGE = 'Время ездки должно быть в дне подачи заявки';

/**
 * Ездки, выпавшие из календарного дня заявки, — **номерами строк списка**, а не признаком «что-то
 * не так»: отказ обязан называть ездку, иначе в форме с шестью строками человек ищет ошибку сам.
 *
 * Одна функция на схему и сервер (Р18): схема зовёт её там, где день заявки виден из тела, сервер —
 * там, где день лежит в базе (правка, не двигающая подачу; перенос рейса на другую дату, ADR 0082).
 * Разойдись они — форма приняла бы то, чем ручка ответит 422.
 *
 * Ездка без своего времени не проверяется вовсе: у неё время заявки (Р3), и выпасть из её дня она
 * не может по устройству.
 */
export function tripsOutOfRequestDay(
  /** Момент подачи заявки (ISO с offset) — тот, который сохранится. */
  scheduledAt: string,
  trips: readonly { scheduledAt?: string | null }[],
): number[] {
  const day = moscowDateKeyOf(new Date(scheduledAt));
  return trips.flatMap((t, i) =>
    t.scheduledAt && moscowDateKeyOf(new Date(t.scheduledAt)) !== day ? [i] : [],
  );
}

// ── Создание (discriminatedUnion по requestType, strict) ──
// Заказывается конечная позиция классификатора (ADR 0028): тип ТС (ADR 0005) и — если у типа
// есть категории (ADR 0016) — категория. Пустая категория не значит «не указали»: у типа без
// ТТХ её и не бывает. Требовать выбор там, где категории есть, может только сервер — он один
// видит состав справочника.
export const createSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    objectId: uuidSchema,
    vehicleTypeId: uuidSchema,
    vehicleCategoryId: uuidSchema.nullish(),
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema.nullable().optional(),
    /**
     * Кто встречает технику на объекте и по какому телефону. Обязателен: машина выходит по
     * заявке, а договариваются о заезде, месте работ и допуске с человеком — без контакта это
     * выясняется звонками через диспетчера уже на воротах.
     */
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
    /** Заявка заводится задним числом — объяснение (ADR 0101); проверяет его `backdateGuard`. */
    backdateReason: backdateReasonSchema.optional(),
    /** Ключ повтора заведения задним числом (Р31); у сегодняшней заявки не спрашивается. */
    operationId: operationIdSchema.optional(),
  })
  .strict();

/**
 * Заказчик заявки (ADR 0040): объект строительства **или** отдел, ровно один. Отдел с объектами
 * не пересекается — снабжение везёт материалы на склад, площадки у такой заявки нет вовсе, —
 * поэтому не «отдел вдобавок к объекту», а вместо него.
 *
 * Только у грузоперевозки: спецтехника выходит на площадку, и заказать её отдел не может
 * (CHECK `vehicle_requests_department_freight_check`, миграция 0069).
 */
export const createFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    objectId: uuidSchema.optional(),
    departmentId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema,
    vehicleCategoryId: uuidSchema.nullish(),
    scheduledAt: scheduledAtSchema,
    /**
     * Время подачи не задано: `scheduledAt` несёт только дату (00:00 МСК), рабочее окно
     * не проверяется. Дата и время в БД остаются одним timestamptz.
     */
    scheduledTimeUnspecified: z.boolean().optional().default(false),
    /**
     * Ездки заявки (Р1, Р2): откуда, куда, сколько, кому звонить на каждом конце. Пары адресов,
     * количества и контактов у самой заявки больше нет — у заявки с ездками `A→B` и `A→C` «адрес
     * разгрузки заявки» не существует, и поле, отвечающее на этот вопрос, отвечало бы наугад.
     *
     * Минимум одна (`requestTripsSchema`): заявка без ездки — заказ, в котором не сказано, что
     * везти и куда. Заявка с одной ездкой — обычный сегодняшний случай, и заполняется она так же;
     * список разворачивается только там, где ездок несколько (§4.1).
     *
     * Схема заведения строгая целиком: адрес приходит парой со своими метаданными и обязан быть
     * верифицирован (ADR 0006), контакты непусты. Послабление есть только у **правки** существующей
     * ездки (Р2а, `updateRequestTripSchema`) — и ровно потому, что новое значение здесь всегда
     * новое, а там бывает и прежним.
     */
    trips: requestTripsSchema,
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
    /** Заявка заводится задним числом — объяснение (ADR 0101); проверяет его `backdateGuard`. */
    backdateReason: backdateReasonSchema.optional(),
    /** Ключ повтора заведения задним числом (Р31); у сегодняшней заявки не спрашивается. */
    operationId: operationIdSchema.optional(),
  })
  .strict();

/*
 * Дата в прошлом (ADR 0101, Р15). Схема больше не отвечает на этот вопрос сама: настоящий ответ
 * складывается из права субъекта, глубины и причины (`backdateGuard`), а из тела запроса видно
 * только последнее — кто его прислал, схема не знает вовсе.
 *
 * Поэтому граница осталась, но стала условной: **необъявленное** прошлое отклоняется, как и
 * прежде. Это и есть очевидный мусор — заявка с датой прошлого года, набранная опечаткой в
 * дейтпикере, или заведение вчерашним днём по привычке: тот, кто действительно правит прошлое,
 * пришёл сюда за этим и объяснение написал. Снять проверку совсем значило бы отдать серверу и
 * опечатки тоже — а он на них ответит тем же 422, только на круг позже и без указания поля.
 *
 * Схема при этом ничего не разрешает: `backdateReason` — заявление о намерении, а не авторизация.
 * Право (`waybills.correct`), глубину (`WAYBILL_CORRECTION_DAYS`) и непустоту причины сервер
 * спрашивает **всегда**, даже когда схема пропустила тело молча.
 */
export const createVehicleRequestSchema = z
  .discriminatedUnion('requestType', [
    createSpecialEquipmentRequestSchema,
    createFreightTransportRequestSchema,
  ])
  .superRefine((v, ctx) => {
    if (v.requestType === 'special_equipment') {
      if (v.dateTo && v.dateTo < v.dateFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['dateTo'],
          message: 'Дата окончания раньше даты начала',
        });
      }
      // Начало срока не раньше сегодня — пока прошлое не объявлено причиной. Конец периода
      // проверять отдельно не нужно: он не раньше начала, а `backdateGuard` на сервере считает
      // глубину по той границе, которую двигают (§4 плана).
      //
      // Заявленное прошлое схема пропускает молча и не решает о нём ничего: `backdateReason` —
      // намерение, а не авторизация. Право (`waybills.correct`), глубину и непустоту причины
      // сервер спрашивает всегда и отвечает точным кодом — 403 на право, 422 на глубину.
      if (!v.backdateReason && !isAllowedRequestDate(v.dateFrom)) {
        ctx.addIssue({ code: 'custom', path: ['dateFrom'], message: BACKDATE_UNDECLARED_MESSAGE });
      }
    } else {
      // Заказчик ровно один (ADR 0040): двое дали бы два ответа на «кто визирует», ноль —
      // ничью заявку. То же условие держит CHECK `vehicle_requests_customer_check`.
      if ((v.objectId == null) === (v.departmentId == null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectId'],
          message: 'Укажите объект либо отдел — что-то одно',
        });
      }
      // Объём и масса здесь не проверяются: нужны ли они, зависит от бланка заказанного типа ТС
      // (`isCargoAmountRequired`), а бланк живёт в справочнике — схеме его взять неоткуда.
      // Обязательность условная и решается сервером, как категория ТС и ставки (ADR 0037 п. 4).
      if (!v.scheduledTimeUnspecified && !isWithinWorkTimeAt(new Date(v.scheduledAt))) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
      // День подачи по МСК — тем же правилом, что и срок выше: необъявленное прошлое отклоняется,
      // объявленное уходит серверу, который один знает право и глубину.
      if (!v.backdateReason && !isAllowedRequestDateAt(new Date(v.scheduledAt))) {
        ctx.addIssue({
          code: 'custom',
          path: ['scheduledAt'],
          message: BACKDATE_UNDECLARED_MESSAGE,
        });
      }
      // Своё время ездки — внутри дня заявки (Р18). Здесь схема отвечает целиком: при заведении
      // видны обе стороны сравнения, и день заявки взяться больше неоткуда.
      for (const i of tripsOutOfRequestDay(v.scheduledAt, v.trips)) {
        ctx.addIssue({
          code: 'custom',
          path: ['trips', i, 'scheduledAt'],
          message: TRIP_DAY_MESSAGE,
        });
      }
    }
  });
export type CreateSpecialEquipmentRequestInput = z.infer<
  typeof createSpecialEquipmentRequestSchema
>;
export type CreateFreightTransportRequestInput = z.infer<
  typeof createFreightTransportRequestSchema
>;
export type CreateVehicleRequestInput = z.infer<typeof createVehicleRequestSchema>;

// ── Обновление (discriminatedUnion; правка типа не меняет — сверяется backend, ADR 0091) ──
// Кросс-полевые правила (dateTo>=dateFrom, объём|масса) добьёт backend после мержа + CHECK БД.
export const updateSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    version: z.number().int().nonnegative(),
    objectId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    // Категория передаётся вместе с типом: `null` — заказан тип без категорий.
    vehicleCategoryId: uuidSchema.nullish(),
    dateFrom: dateOnlySchema.optional(),
    dateTo: dateOnlySchema.nullable().optional(),
    // Не переданный контакт — «не трогали», а не «сняли»: пустую строку схема не принимает, а
    // непустоту итогового значения (у заявок старше миграции 0062 контакта нет) добьёт backend.
    responsibleName: contactNameSchema.optional(),
    responsiblePhone: contactPhoneSchema.optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
    /**
     * Причина сдвига срока в прошлое (ADR 0101, Р6). Границы у правки в схеме нет и не было: у
     * заведённой заявки дата остаётся такой, какой была, иначе вчерашнюю нельзя было бы даже
     * открыть на редактирование. Спрашивает право и глубину сервер — и только тогда, когда правка
     * действительно двигает календарь: уточнение телефона у вчерашней заявки под `waybills.correct`
     * не попадает (Р29).
     */
    backdateReason: backdateReasonSchema.optional(),
    /** Ключ повтора правки задним числом (Р31); обычная правка ключа не спрашивает. */
    operationId: operationIdSchema.optional(),
  })
  .strict();

// ── Правка ездок: жёсткая модель встаёт на новое значение (Р2а) ──
//
// Заявку старше ADR 0006 и миграции `0062` править можно и сегодня: адрес и контакты объявлены
// `.optional()`, и нетронутое поле просто **не отправляется**. С переездом на ездки этот приём
// кончается — ездки правятся полным списком (§7), а у списка нет понятия «поле не прислали»:
// строка приезжает целиком, со всеми своими значениями, в том числе с непроверенным адресом и
// пустым контактом, доехавшими бэкфилом (§5.7 — на тестовой базе таких 4 строки деталей из 489).
//
// Потребуй схема жёсткую модель за сам факт отправки списка — и заявка, которую сегодня спокойно
// редактируют, завтра перестала бы сохраняться, пока кто-нибудь не выберет ей адрес из справочника
// и не впишет ответственного, то есть не выдумает данные за прошлое. Ровно от этого бережёт Р24:
// старая заявка — это заявка с одной ездкой, а не заявка второго сорта.
//
// Поэтому решение разделено надвое, и граница проходит по `id` строки:
//
//   - **строка без `id`** — заведение. Её схема проверяет целиком и здесь же: адрес парой с
//     метаданными и верифицирован, контакты непусты. Новое значение тут новое по определению —
//     сравнивать не с чем, откладывать нечего;
//   - **строка с `id`** — перезапись существующей ездки. Схема принимает её как есть. Не потому,
//     что правило ослабло, а потому, что применить его нечем: отличить «оставили как было» от
//     «вписали руками непроверенный адрес» можно только сравнением с прежним значением, а его в
//     теле запроса нет. Оно есть у **сервера**, под блокировкой строки, — там правило и стоит.
//
// Что обязан сделать сервер с каждой строкой, несущей `id`, — без этого Р2а не выполнен:
//
//   1. взять сохранённую ездку **этой** заявки под блокировкой (Р16, Р17); `id` чужой заявки или
//      мягко удалённой ездки (Р13а) — отказ, а не тихое заведение новой;
//   2. сравнить присланное с сохранённым по каждому полю;
//   3. на изменившемся адресе (строка или метаданные) потребовать `verifiedAddressMetaSchema`, на
//      изменившемся контакте — `contactNameSchema` и `contactPhoneSchema`. Не изменившееся принять
//      как есть, каким бы оно ни было;
//   4. ездки, которых в присланном списке не оказалось, мягко удалить (Р13а), а не снести: на них
//      может ссылаться выданный лист.
//
// Отсюда же и то, чего в схеме нет вовсе: `num` не принимается (номер назначает сервер и не
// переиспользует, Р13а), `deletedAt` — тоже: удаление выражено отсутствием строки в списке, а не
// признаком внутри неё.

/**
 * Имя ответственного в том виде, в каком оно уже лежит в базе: пустая строка законна (колонка
 * `NOT NULL DEFAULT ''`, §5.1) — это состояние бэкфила, а не то, что принимается на запись.
 * Верхняя граница та же, что у `contactNameSchema`: от того, кто прислал значение, длина поля не
 * меняется.
 */
const storedContactNameSchema = z.string().trim().max(200);

/**
 * Телефон в том виде, в каком он уже лежит в базе. Нормализация (ADR 0066) стоит здесь же и
 * работает как обычно — присланный «+7 (916) 123-45-67» уйдёт в базу десятью цифрами, — но то, что
 * к десяти цифрам не сводится, проходит **как есть**: миграция `0095` такие значения не трогала
 * (ADR 0066 п. 7), и отклонить их значило бы не дать сохранить заявку, в которой этот номер никто
 * не менял. Годится ли значение как **новое**, решает сервер сравнением с прежним.
 */
const storedContactPhoneSchema = z
  .string()
  .trim()
  .max(50)
  .transform((v) => (v === '' ? '' : (normalizePhone(v) ?? v)));

/**
 * Что не так с адресом для записи (ADR 0006), либо `null`, если он годится.
 *
 * Тем же приёмом, что `contactIssue`: правило одно и лежит в своей схеме, а звать его приходится
 * изнутри `superRefine`, куда чужие issue не пробросить — берётся первое сообщение, как и там.
 */
function verifiedAddressIssue(meta: AddressMeta | null): string | null {
  // `null` разбирается отдельно: схема ответила бы на него служебным «expected object, received
  // null», а человеку нужно ровно то же, что и при свободном вводе, — «выберите из подсказок».
  if (!meta) return ADDRESS_NOT_VERIFIED_MESSAGE;
  const parsed = verifiedAddressMetaSchema.safeParse(meta);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? ADDRESS_NOT_VERIFIED_MESSAGE);
}

/**
 * Ездка в теле правки заявки: та же строка, что при заведении, плюс `id` и послабления Р2а.
 *
 * Расширением `requestTripSchema`, а не своей записью полей: границы длин, точность количества и
 * рабочее окно своего времени обязаны совпадать с заведением значение в значение — разъедься они,
 * и одна и та же ездка проходила бы форму заведения и не проходила форму правки.
 *
 * Послабления ровно три, и все — про то, чего бэкфил принести не мог (§5.7):
 *
 *   - метаданные адреса допускают `manual` и `null` (у заявок старше ADR 0006 их нет вовсе);
 *   - имя ответственного допускает пустоту (у заявок старше миграции `0062` контакта нет);
 *   - телефон допускает несводимое легаси-значение (ADR 0066 п. 7).
 *
 * Строки адресов (`fromLocation`, `toLocation`) остаются непустыми, как и были: пустых в базе нет —
 * их не пускали CHECK `freight_loading_not_blank_check` и его пара, — и послаблять тут нечего.
 *
 * Пара «строка + метаданные» держится самой формой схемы: оба поля обязательны в строке, и
 * отдельная сверка «переданы вместе» (та, что стояла у `updateVehicleRequestSchema`) больше не
 * нужна — она сторожила необязательные поля, которых здесь не осталось.
 */
export const updateRequestTripSchema = requestTripSchema
  .extend({
    /**
     * Идентификатор существующей ездки; нет — заводится новая (Р2а). Это единственное, чем
     * перезапись отличается от заведения: номера в теле не бывает, а порядок строк в списке не
     * значит ничего — ездки упорядочены своим `num`.
     */
    id: uuidSchema.optional(),
    fromAddress: addressMetaSchema.nullable(),
    toAddress: addressMetaSchema.nullable(),
    fromResponsibleName: storedContactNameSchema,
    fromResponsiblePhone: storedContactPhoneSchema,
    toResponsibleName: storedContactNameSchema,
    toResponsiblePhone: storedContactPhoneSchema,
  })
  .superRefine((trip, ctx) => {
    // Существующая ездка: сравнить её с прежним состоянием схеме нечем — этим занят сервер.
    if (trip.id !== undefined) return;
    // Новая ездка — жёсткая модель целиком, теми же схемами, что при заведении заявки. Иначе
    // «добавили ездку в старую заявку» стало бы дырой, через которую непроверенный адрес и пустой
    // контакт возвращаются в базу спустя релиз после того, как их оттуда убрали.
    const issues: [string, string | null][] = [
      ['fromAddress', verifiedAddressIssue(trip.fromAddress)],
      ['toAddress', verifiedAddressIssue(trip.toAddress)],
      ['fromResponsibleName', contactIssue(trip.fromResponsibleName, 'name')],
      ['fromResponsiblePhone', contactIssue(trip.fromResponsiblePhone, 'phone')],
      ['toResponsibleName', contactIssue(trip.toResponsibleName, 'name')],
      ['toResponsiblePhone', contactIssue(trip.toResponsiblePhone, 'phone')],
    ];
    for (const [path, message] of issues) {
      if (message) ctx.addIssue({ code: 'custom', path: [path], message });
    }
  });
export type UpdateRequestTripInput = z.infer<typeof updateRequestTripSchema>;

/**
 * Список ездок в теле правки — полный состав заявки после правки (§7).
 *
 * Границы повторены за `requestTripsSchema` значение в значение, и это не копипаста по недосмотру:
 * элемент здесь другой (строка несёт `id` и послабления Р2а), а подменить элемент у готовой
 * `z.array` zod не умеет. Разъехаться им нельзя — заявка, которую приняло заведение, обязана
 * сохраняться и правкой.
 */
const updateRequestTripsSchema = z
  .array(updateRequestTripSchema)
  .min(1, 'Добавьте хотя бы одну ездку')
  .max(MAX_ROUTE_REQUESTS, `Ездок в заявке не больше ${MAX_ROUTE_REQUESTS}`);

export const updateFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    version: z.number().int().nonnegative(),
    /** Заказчик: переданный объект снимает отдел и наоборот — их всегда ровно один (ADR 0040). */
    objectId: uuidSchema.optional(),
    departmentId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    scheduledAt: scheduledAtSchema.optional(),
    // Передаётся вместе со `scheduledAt` — рабочее окно проверяется только при заданном времени.
    scheduledTimeUnspecified: z.boolean().optional(),
    /**
     * Ездки заявки после правки — **полным списком** (§7): строка с `id` перезаписывает
     * существующую, строка без него заводит новую, а ездка, которой в списке не оказалось, мягко
     * удаляется (Р13а).
     *
     * Поле необязательное, и это не противоречие с «полным списком»: не прислали вовсе — ездок не
     * трогали. Приём «нетронутое не отправляется» исчезает **внутри** списка (у строки нет
     * состояния «поле не прислали»), но сам список остаётся полем, и уточнение телефона у заявки со
     * старыми ездками не обязано тащить их за собой — иначе Р2а пришлось бы выполнять на каждой
     * правке комментария.
     */
    trips: updateRequestTripsSchema.optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
    /** Причина сдвига подачи в прошлое (ADR 0101, Р6) — тем же правилом, что у спецтехники. */
    backdateReason: backdateReasonSchema.optional(),
    /** Ключ повтора правки задним числом (Р31); обычная правка ключа не спрашивает. */
    operationId: operationIdSchema.optional(),
  })
  .strict();

export const updateVehicleRequestSchema = z
  .discriminatedUnion('requestType', [
    updateSpecialEquipmentRequestSchema,
    updateFreightTransportRequestSchema,
  ])
  // Тип заявки правкой не меняется: у неё поля одного типа, и присланный чужой означал бы, что
  // заявку подменили по дороге. Меняют тип отдельным действием — переоформлением (ADR 0091).
  .superRefine((v, ctx) => {
    if (v.requestType === 'freight_transport') {
      // Переданный заказчик заменяет прежнего целиком; двое сразу невозможны (ADR 0040).
      if (v.objectId != null && v.departmentId != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectId'],
          message: 'Заказчик один: объект либо отдел',
        });
      }
      // Сверок «строка адреса и метаданные передаются вместе» здесь больше нет: они сторожили
      // необязательные поля заявки, а у ездки адрес приходит парой в самой строке списка (Р2).
      if (
        v.scheduledAt !== undefined &&
        v.scheduledTimeUnspecified !== true &&
        !isWithinWorkTimeAt(new Date(v.scheduledAt))
      ) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
      // Своё время ездки — внутри дня заявки (Р18). Схема отвечает только за случай, когда обе
      // стороны сравнения видны из тела: правка двигает подачу и присылает ездки. Всё остальное —
      // за сервером, у которого сохранённый день есть всегда: правка одних ездок при прежней
      // подаче, правка одной подачи при прежних ездках и перенос рейса на другую дату (ADR 0082).
      if (v.scheduledAt !== undefined && v.trips) {
        for (const i of tripsOutOfRequestDay(v.scheduledAt, v.trips)) {
          ctx.addIssue({
            code: 'custom',
            path: ['trips', i, 'scheduledAt'],
            message: TRIP_DAY_MESSAGE,
          });
        }
      }
    }
  });
export type UpdateVehicleRequestInput = z.infer<typeof updateVehicleRequestSchema>;

/**
 * Отказ на смену заказчика у заявки, вышедшей из «Новой» (Р7).
 *
 * Почему запрет вообще есть: объект затрат ушёл снимком в строки задания путевого листа, а виза у
 * заявки в работе правкой не снимается намеренно (ADR 0044). Перенос заказчика в этот момент дал
 * бы заявку отдела с визой чужого объекта и лист, в котором затраты отнесены на площадку.
 *
 * Одно сообщение на форму и сервер: портал запирает поле у такой заявки той же причиной, какой
 * ответит ручка, — иначе человек читал бы два разных объяснения одного запрета. И называет оно
 * выход, а не только запрет (тем же приёмом, что `ASSIGNMENT_CORRECTION_CLOSED_MESSAGE`): заказ
 * другому заказчику оформляют заявкой заново, а эту отменяют.
 */
export const REQUEST_CUSTOMER_LOCKED_MESSAGE = `Заказчика меняют, пока заявка в статусе «${requestStatusLabels.new}»: у взятой в работу объект затрат уже ушёл в задание путевого листа. Оформите заказ нужному заказчику новой заявкой, а эту отмените`;

// ── Календарь заявки и задний ход правки (ADR 0101, Р29) ──

/**
 * Календарные поля заявки одним видом: у заказа техники на объект это две границы срока, у
 * грузоперевозки — день подачи. Днями, а не моментами: границу заднего числа портал и сервер
 * считают по МСК (`moscowDateKeyOf`), и час подачи в ней не значит ничего.
 *
 * `undefined` в «после» означает «поле не передали, то есть не трогали», `null` у `dateTo` —
 * «дату окончания сняли», то есть срок стал однодневным. Разница существенная: первое календарь не
 * двигает вовсе, второе двигает его последний день на начало срока.
 */
export interface RequestCalendar {
  /** День подачи грузоперевозки (`YYYY-MM-DD`, МСК); у заказа на объект пусто. */
  scheduledDay?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

/**
 * Эффективная дата правки заявки — та, по которой спрашивается право задним числом (§4 плана
 * ADR 0101). `null` — календарь правка не двигает вовсе, и `backdateGuard` тут не при чём:
 * уточнение телефона у вчерашней заявки под `waybills.correct` не попадает (Р29).
 *
 * Одна функция на портал и сервер, потому что расходиться им здесь нельзя вдвойне: разойдись они в
 * «что считается сдвигом», форма спрашивала бы причину там, где сервер её не ждёт (или наоборот —
 * молча отправляла бы правку, которой ответят 403).
 *
 * Правила ровно два, и оба из таблицы §4:
 *
 * - двигают **новые** значения, а не старые: глубину решает то, куда дату переносят;
 * - двинулись обе границы срока — берётся более ранняя. Она строже по всем трём исходам
 *   `backdateGuard` (право, глубина, причина), поэтому одного вердикта по ней достаточно, а
 *   отказ называет именно её — как и требует §4.
 *
 * Последний день срока читается тем же `coalesce(date_to, date_from)`, каким его читает весь
 * портал: снятая дата окончания — однодневный срок, а не «конца нет».
 */
export function movedRequestDateKey(
  before: RequestCalendar,
  after: RequestCalendar,
): string | null {
  const keep = <T>(next: T | undefined, prev: T | undefined): T | undefined =>
    next === undefined ? prev : next;
  const moved: string[] = [];

  const nextDay = keep(after.scheduledDay, before.scheduledDay);
  if (nextDay && nextDay !== before.scheduledDay) moved.push(nextDay);

  const nextFrom = keep(after.dateFrom, before.dateFrom);
  if (nextFrom && nextFrom !== before.dateFrom) moved.push(nextFrom);
  // Последний день, а не сама колонка `dateTo`: снятая дата окончания переносит конец срока на
  // начало, и правка, которая это делает, двигает календарь ничуть не меньше проставленной даты.
  const nextLast = keep(after.dateTo, before.dateTo) || nextFrom;
  const prevLast = before.dateTo || before.dateFrom;
  if (nextLast && nextLast !== prevLast) moved.push(nextLast);

  return moved.length === 0 ? null : moved.reduce((a, b) => (a < b ? a : b));
}

/**
 * День, **на который заказана техника**, если правка его двигает: у заказа на объект первый день
 * срока, у грузоперевозки день подачи. `null` — этот день правка не трогает.
 *
 * Отдельно от `movedRequestDateKey`, потому что вопросы разные. Тот отвечает «о каком дне правка
 * что-то утверждает» и берёт в расчёт конец срока: сдвинув его, правка переписывает прошедшую
 * неделю ничуть не меньше. Заблаговременность (ADR 0104) спрашивает другое — «на когда заказ», а
 * заказ начинается с первого дня: конец периода не бывает раньше начала, и сокращение срока
 * технику ближе не придвигает. Сложи эти два вопроса в одну функцию — и заявитель, укоротивший
 * срок до однодневного, получил бы отказ «заказывайте заранее» на правке, которая ничего не
 * заказывает.
 */
export function movedRequestStartKey(
  before: RequestCalendar,
  after: RequestCalendar,
): string | null {
  const nextDay = after.scheduledDay === undefined ? before.scheduledDay : after.scheduledDay;
  if (nextDay && nextDay !== before.scheduledDay) return nextDay;
  const nextFrom = after.dateFrom === undefined ? before.dateFrom : after.dateFrom;
  if (nextFrom && nextFrom !== before.dateFrom) return nextFrom;
  return null;
}

// ── Смена типа заявки: переоформление (ADR 0091) ──

/**
 * Почему тип заявки сменить нельзя — текстом, либо `null`, если можно. Одна функция на портал и
 * API, как у досрочного завершения (`earlyEndBlocker`): портал этой строкой объясняет запертое
 * поле, сервер ею же отвечает 422 — иначе человек видел бы выбор, который сервер не примет.
 *
 * Смену допускает **вид заказанной техники**, а не тип заявки: заказ на объект принимает технику
 * любого вида, грузоперевозку выполняет только грузовая (`isVehicleKindAllowedForRequest`), и
 * годной обоим типам позиция бывает ровно одна — грузовая. Самосвал под вывоз грунта заказывают то
 * работой на объекте, то рейсом, и ошибиться в этом выборе при заведении легко; экскаватор
 * грузоперевозкой не станет никогда, и предлагать там смену типа не о чем.
 *
 * Статус — «Новая» и только: у заявки в работе за типом стоят назначенная машина, рейс, бумага и
 * принятые объектом смены, и переоформление сняло бы основание у всего этого разом. То же
 * ограничение, которым живут виза (`isApprovalChangeable`) и правка со стороны заказчика.
 */
export function requestTypeChangeBlocker(
  r: Pick<VehicleRequestBaseDto, 'requestType' | 'status' | 'deletedAt'>,
  /** Код вида заказанного типа ТС (`vehicle_kinds.code`); `null` — вид неизвестен. */
  orderedKindCode: string | null,
  next: VehicleRequestType,
): string | null {
  if (next === r.requestType) return 'Тип заявки уже такой';
  if (r.deletedAt) return 'Заявка в архиве';
  if (r.status !== 'new') {
    return `Тип меняют у заявки в статусе «${requestStatusLabels.new}»`;
  }
  if (orderedKindCode !== FREIGHT_VEHICLE_KIND_CODE) {
    return 'Тип меняют у заказов грузовой техники: технику другого вида грузоперевозкой не заказать';
  }
  return null;
}

/** Можно ли сменить тип заявки — тот же разбор, что и `requestTypeChangeBlocker`. */
export function canChangeRequestType(
  r: Parameters<typeof requestTypeChangeBlocker>[0],
  orderedKindCode: string | null,
  next: VehicleRequestType,
): boolean {
  return requestTypeChangeBlocker(r, orderedKindCode, next) === null;
}

const requestVersionSchema = z.number().int().nonnegative();
const editFilesSchema = {
  addFileIds: fileIdsSchema.optional(),
  removeFileIds: z.array(uuidSchema).optional(),
};

/**
 * Переоформление заявки в другой тип: тело — полный состав целевого типа, как при заведении.
 *
 * Полный, а не частичный, как у правки: у нового типа своя деталь (срок работ против момента
 * подачи, адреса против площадки), и заполнить её нечем — брать значения из детали прежнего типа
 * сервер не вправе, они про другое. Поэтому схемы заведения переиспользуются целиком: заявка
 * переоформляется ровно тем составом, каким её завели бы этим типом сразу.
 *
 * Своё здесь — версия и файлы: переоформляют из той же формы, что и правят, и вложения в ней тем
 * временем добавляют и снимают. Правила «не раньше сегодня» тут нет намеренно — его же нет и у
 * правки: заявку, заведённую вчера, переоформляют сегодня, и требовать сдвинуть срок вперёд
 * значило бы менять заказ ради смены его вида.
 */
export const changeVehicleRequestTypeSchema = z
  .discriminatedUnion('requestType', [
    createSpecialEquipmentRequestSchema.omit({ fileIds: true }).extend({
      version: requestVersionSchema,
      ...editFilesSchema,
    }),
    createFreightTransportRequestSchema.omit({ fileIds: true }).extend({
      version: requestVersionSchema,
      ...editFilesSchema,
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.requestType === 'special_equipment') {
      if (v.dateTo && v.dateTo < v.dateFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['dateTo'],
          message: 'Дата окончания раньше даты начала',
        });
      }
      return;
    }
    // Заказчик ровно один (ADR 0040) — то же условие, что при заведении: у грузоперевозки им
    // бывает и отдел, и площадка, а у заказа на объект отдела не бывает вовсе.
    if ((v.objectId == null) === (v.departmentId == null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['objectId'],
        message: 'Укажите объект либо отдел — что-то одно',
      });
    }
    if (!v.scheduledTimeUnspecified && !isWithinWorkTimeAt(new Date(v.scheduledAt))) {
      ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
    }
  });
export type ChangeVehicleRequestTypeInput = z.infer<typeof changeVehicleRequestTypeSchema>;
export type ChangeVehicleRequestTypeBody = z.input<typeof changeVehicleRequestTypeSchema>;

// ── Виза руководителя строительства (ADR 0025) ──

/**
 * Переход, требующий визы: незавизированную заявку нельзя взять в работу. Отмена визы не
 * требует — заявку, которую не согласовали, закрывают именно отменой.
 */
export function transitionRequiresApproval(to: RequestStatus): boolean {
  return to === 'confirmed';
}

/**
 * Статусы, доступные субъекту из текущего — с поправкой на визу. Правило одно на портал и API:
 * список переходов в интерфейсе не должен предлагать то, что сервер отклонит.
 */
export function allowedVehicleRequestTransitions(
  from: RequestStatus,
  subject: AccessSubject,
  approved: boolean,
): RequestStatus[] {
  const transitions = allowedStatusTransitions(from, subject, 'vehicle');
  return approved ? transitions : transitions.filter((to) => !transitionRequiresApproval(to));
}

/**
 * Визу ставят и снимают, пока заявку не взяли в работу: после «В работе» она уже основание
 * для договорённостей с исполнителем, и отзыв визы задним числом ничего не отменяет.
 */
export function isApprovalChangeable(status: RequestStatus): boolean {
  return status === 'new';
}

/** Виза и её отзыв одним маршрутом: у обоих действий одно право и одна проверка области. */
export const setVehicleRequestApprovalSchema = z
  .object({
    approved: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type SetVehicleRequestApprovalInput = z.infer<typeof setVehicleRequestApprovalSchema>;

// ── Досрочное завершение заказа спецтехники (ADR 0044) ──

/**
 * Состояние запроса на сокращение срока. Сокращение согласуется тем же руководителем
 * строительства, что визировал заказ, — отсюда три состояния вместо флага: между «попросили» и
 * «срок изменился» стоит чужое решение, и оно бывает отрицательным.
 */
export const VEHICLE_EARLY_END_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const vehicleEarlyEndStatusSchema = z.enum(VEHICLE_EARLY_END_STATUSES);
export type VehicleEarlyEndStatus = (typeof VEHICLE_EARLY_END_STATUSES)[number];

export const vehicleEarlyEndStatusLabels: Record<VehicleEarlyEndStatus, string> = {
  pending: 'Ждёт визы',
  approved: 'Согласовано',
  rejected: 'Отклонено',
};

/** Цвета те же, что у визы заявки: ожидание — оранжевое, решение — зелёное или красное. */
export const vehicleEarlyEndStatusColors: Record<VehicleEarlyEndStatus, string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
};

/**
 * Почему заявку нельзя завершить досрочно — текстом, либо `null`, если можно. Одна функция на
 * портал и API: сервер отвечает этой строкой (422), портал ею же объясняет недоступный пункт
 * меню. Разойдись они — человек видел бы кнопку, которая всегда отказывает, или отказ без причины.
 *
 * Досрочное завершение применимо к технике, которая **сейчас стоит на объекте** — то же условие,
 * которым отбирается вкладка «На объекте» (ADR 0036), плюс требование остатка срока: сокращать
 * нечего у заявки, которая и так заканчивается сегодня.
 */
export function earlyEndBlocker(
  r: Pick<VehicleRequestBaseDto, 'requestType' | 'status' | 'deletedAt'> & {
    dateFrom?: string;
    dateTo?: string | null;
  },
  onDate: string,
): string | null {
  if (r.requestType !== 'special_equipment') {
    return 'Досрочно завершают заказ техники на объект: у грузоперевозки срока работ нет';
  }
  if (r.deletedAt) return 'Заявка в архиве';
  if (r.status !== 'confirmed') {
    return `Досрочно завершают заявку в статусе «${requestStatusLabels.confirmed}»`;
  }
  const dateFrom = r.dateFrom!;
  // Пустая дата окончания — однодневный срок: так её читает и отбор среза, и подписи присутствия.
  const last = r.dateTo || dateFrom;
  if (dateFrom > onDate) {
    return 'Работы ещё не начались — на объекте этой техники пока нет';
  }
  if (last <= onDate) {
    return 'Срок заявки заканчивается сегодня — сокращать нечего';
  }
  return null;
}

/** Можно ли запросить досрочное завершение — тот же разбор, что и `earlyEndBlocker`. */
export function canRequestEarlyEnd(
  r: Parameters<typeof earlyEndBlocker>[0],
  onDate: string,
): boolean {
  return earlyEndBlocker(r, onDate) === null;
}

/**
 * Границы новой даты окончания: не раньше сегодня и строго раньше нынешнего последнего дня.
 *
 * Нижняя граница — сегодня, а не начало срока: задним числом период не переписывается, за
 * прошедшие дни техника на объекте стояла и срез это уже показал. Верхняя — предпоследний день:
 * дата, равная нынешней, ничего не сокращает.
 *
 * `null` — заявку сокращать нельзя вовсе (`earlyEndBlocker` объясняет, почему).
 */
export function earlyEndDateBounds(
  r: Parameters<typeof earlyEndBlocker>[0],
  onDate: string,
): { min: string; max: string } | null {
  if (!canRequestEarlyEnd(r, onDate)) return null;
  return { min: onDate, max: shiftDateKey(r.dateTo || r.dateFrom!, -1) };
}

/** Дата попадает в допустимые границы сокращения. */
export function isAllowedEarlyEndDate(
  r: Parameters<typeof earlyEndBlocker>[0],
  onDate: string,
  newDateTo: string,
): boolean {
  const bounds = earlyEndDateBounds(r, onDate);
  return !!bounds && newDateTo >= bounds.min && newDateTo <= bounds.max;
}

/**
 * Сколько дней освобождается: с 20-го до 12-го — восемь (13-е…20-е). Считается разницей
 * календарных ключей, а не длин периодов: сокращение отвечает на «сколько дней техника не
 * простоит», и день, оставшийся последним, в этот счёт не входит.
 */
export function earlyEndDaysSaved(previousDateTo: string, newDateTo: string): number | null {
  const from = Date.parse(`${newDateTo}T00:00:00Z`);
  const to = Date.parse(`${previousDateTo}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Сокращать срок работ обычной правкой можно, пока техника не вышла: у заявки «В работе» это
 * делает досрочное завершение с визой (ADR 0044), и прямая правка обошла бы визу в один шаг.
 * Продление срока правкой остаётся — виза заводилась не ради него.
 *
 * Правило живёт в контрактах, потому что портал обязан не предлагать того, что сервер отклонит:
 * форма правки работающей заявки не даёт выбрать дату окончания раньше нынешней.
 */
export function canShortenWorkPeriodByEdit(status: RequestStatus): boolean {
  return status !== 'confirmed';
}

/**
 * Запрос на досрочное завершение. Причина обязательна: визирующему нечего решать, если ему не
 * сказали, что произошло на объекте, — а решает он не глядя на площадку.
 */
export const requestVehicleEarlyEndSchema = z
  .object({
    newDateTo: dateOnlySchema,
    reason: z.string().trim().min(1, 'Укажите причину').max(2000),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type RequestVehicleEarlyEndInput = z.infer<typeof requestVehicleEarlyEndSchema>;

/**
 * Решение по запросу: виза и отказ — одним маршрутом, как постановка и снятие визы заявки
 * (ADR 0025 п. 6). У них одно право, одна область и один инвариант «пока запрос ждёт визы»;
 * раздельные маршруты разошлись бы в проверках. Отказ объясняется причиной — как отмена заявки.
 */
export const decideVehicleEarlyEndSchema = z
  .object({
    approved: z.boolean(),
    comment: commentSchema.optional().default(''),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.approved && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отказа' });
    }
  });
export type DecideVehicleEarlyEndInput = z.infer<typeof decideVehicleEarlyEndSchema>;

/**
 * Досрочное завершение заявки: запрос и решение по нему. Одна заявка — одна запись: повторный
 * запрос переписывает её, а цепочка решений остаётся событиями истории (ADR 0044).
 */
export interface VehicleRequestEarlyEndDto {
  status: VehicleEarlyEndStatus;
  /** Новый последний день работ. У согласованного совпадает с `dateTo` заявки. */
  newDateTo: string;
  /** Срок, стоявший в заявке на момент запроса, — снимок: по нему считаются освобождённые дни. */
  previousDateTo: string;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  /** Кто и когда решил; пусто ровно у ожидающего визы. */
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** Причина отказа; у согласованного пуста — срок в заявке говорит сам за себя. */
  decisionComment: string;
}

// ── Назначение техники на заявку (ADR 0027) ──

/**
 * Заявку берут в работу не «вообще», а конкретной машиной: с этого момента известно, кто и на
 * чём выходит и по какой ставке. Поэтому назначение — часть перехода «Новая» → «В работе», а не
 * отдельное действие после него.
 */
export function transitionRequiresAssignment(to: RequestStatus): boolean {
  return to === 'confirmed';
}

/**
 * Техника и её ставки. Цены подставляются из справочника (предложение аренды), но приходят от
 * клиента как обычные значения и редактируются свободно: договариваются по конкретной заявке —
 * со скидкой за объём, с наценкой за срочность, — и прайс справочника такой договорённости не
 * начальник. Обе цены необязательны: у собственной машины ставки может не быть вовсе, а у
 * аренды хотя бы одну потребует сервер — он знает, чья это машина.
 */
/**
 * Фактический срок, уточняемый при переводе заявки в работу.
 *
 * Заказанное время — планируемое: заявку заводят заранее, а когда именно машина выйдет,
 * выясняется в разговоре с исполнителем — то есть ровно в тот момент, когда заявку берут в работу.
 * Отдельной пары «план/факт» здесь нет намеренно: в заявке одно время — то, на которое
 * договорились, — а расхождение с первоначальным видно историей («Подача: 03.08 08:00 → 09:30»).
 *
 * Правила те же, что у обычной правки заявки: конец срока не раньше начала, время подачи — в
 * рабочем окне. Проверки «не раньше сегодня» тут нет: в работу заявку берут и задним числом, а
 * заведение новой — единственное место, где такая проверка уместна.
 */
export const confirmSpecialEquipmentScheduleSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema.nullable().optional(),
  })
  .strict();

export const confirmFreightTransportScheduleSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    scheduledAt: scheduledAtSchema,
    /** Время подачи не назначено: в `scheduledAt` значима только дата, рабочее окно не проверяется. */
    scheduledTimeUnspecified: z.boolean().optional().default(false),
  })
  .strict();

export const confirmScheduleSchema = z
  .discriminatedUnion('requestType', [
    confirmSpecialEquipmentScheduleSchema,
    confirmFreightTransportScheduleSchema,
  ])
  .superRefine((v, ctx) => {
    if (v.requestType === 'special_equipment') {
      if (v.dateTo && v.dateTo < v.dateFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['dateTo'],
          message: 'Дата окончания раньше даты начала',
        });
      }
    } else if (!v.scheduledTimeUnspecified && !isWithinWorkTimeAt(new Date(v.scheduledAt))) {
      ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
    }
  });
export type ConfirmScheduleInput = z.infer<typeof confirmScheduleSchema>;
export type ConfirmScheduleBody = z.input<typeof confirmScheduleSchema>;

export const assignVehicleSchema = z
  .object({
    vehicleId: uuidSchema,
    pricePerHour: vehiclePriceSchema.nullable().optional(),
    pricePerShift: vehiclePriceSchema.nullable().optional(),
    /** Длительность смены: без неё цена за смену — сумма без единицы измерения. */
    shiftHours: shiftHoursSchema.nullable().optional(),
    /**
     * Рейс, в который заявка едет: существующий маршрут этой машины на эту дату либо новый — с
     * водителем и реквизитами рейса. Обязателен там, где выписывается путевой лист (грузоперевозка
     * на собственной машине); решает это сервер, потому что состав справочника видит он.
     */
    route: assignRouteSchema.optional(),
    /**
     * Машинист заказа техники на объект: на него выписываются недельные листы ЭСМ-2, и без него
     * бланк недействителен. Обязателен там, где эти листы выписываются (собственная техника на
     * объект); решает это сервер — вид заявки и принадлежность машины видит он.
     *
     * Отбор у машиниста свой и никакой: в бланке нет ни СНИЛС, ни водительского удостоверения —
     * экскаваторщик работает по удостоверению тракториста-машиниста, которого портал не ведёт
     * (ADR 0055). Поэтому годится любой действующий водитель справочника, и `selectDrivers`,
     * отсеивающий людей без документов рейса, здесь не при чём.
     */
    driverPersonId: uuidSchema.optional(),
    /**
     * Перегон техники на объект — по желанию (миграция 0082). Спецтехника доезжает до площадки
     * по городу своим ходом, и на эту поездку выписывается 4-П; повезут её тралом — листа не
     * будет, и портал об этом не спрашивает.
     *
     * Только доставка: вывоз заводят из карточки заявки, когда работы подходят к концу, — в
     * момент перевода в работу его дату ещё не знают.
     *
     * Причина заднего числа (ADR 0101, Р29) лежит **внутри** перегона, а не рядом со статусом:
     * задним числом здесь бывает только его дата — сам перевод в работу происходит сегодня, — и
     * поле у границы отвечает ровно за ту границу, которую двигают. Общая причина у смены статуса
     * означала бы «объясните переход», которого никто не просил.
     */
    delivery: createRelocationRouteSchema
      .omit({ purpose: true })
      // Пустая строка схемой не отбивается — тем же приёмом, что у `createRequestRelocationSchema`:
      // нужна ли причина вообще, знает сервер (дата в прошлом или нет), и его отказ отличает «нет
      // права» от «нет причины». Схема, решившая это за него, дала бы один текст на оба случая.
      .extend({ reason: z.string().trim().max(2000).optional() })
      .optional(),
  })
  .strict();
export type AssignVehicleInput = z.infer<typeof assignVehicleSchema>;
export type AssignVehicleBody = z.input<typeof assignVehicleSchema>;

// ── Смена назначенной техники у заявки в работе (ADR 0048) ──

/**
 * Можно ли сменить машину, не трогая статус. Заявка в работе — и только она: у «Новой» менять
 * нечего (машину назначает сам перевод в работу), а закрытая и отменённая — история, которую
 * правят откатом, а не подменой машины задним числом.
 *
 * Предикат один на портал и API: кнопка не должна предлагать действие, которое сервер отклонит.
 */
export function canReassignVehicle(request: {
  status: RequestStatus;
  assignment: VehicleRequestAssignmentDto | null;
  deletedAt: string | null;
  /** Сводка смен; у грузоперевозки её не бывает — подтверждать там нечего. */
  shifts?: VehicleRequestShiftsSummaryDto | null;
}): boolean {
  if (!canCorrectAssignment(request)) return false;
  // Подтверждённая смена запирает машину: за подписью объекта стоит работа конкретной техники,
  // и подмена задним числом превратила бы её в подпись под чужими часами (`approvedShiftsBlocker`).
  return (request.shifts?.approvedDays ?? 0) === 0;
}

// ── Коррекция назначения задним числом (ADR 0101, Р8) ──

/**
 * Половина запрета `canReassignVehicle`, которую коррекция **не** снимает.
 *
 * Запретов там два, и они разной природы. Подтверждённые дни коррекция снимает сознательно (Р5,
 * ADR 0101 п. 16): подпись объекта стоит под работой конкретной техники, а после правки — под
 * машиной, которой в этот день не было, и снятие подписи — это цель операции, а не помеха ей.
 *
 * Состояние самой заявки остаётся запретом и под правом:
 *
 * - «Новая» — менять нечего, машину назначает сам перевод в работу;
 * - «Выполнена» — заявка ушла в выгрузку бухгалтерии, и правка назначения была бы правкой
 *   предъявленного счёта (ADR 0101 п. 3). Порядок для неё описан прямо (Р38): администратор
 *   возвращает заявку в работу, диспетчер корректирует, закрывают её заново — и «кто снял
 *   закрытие» остаётся вопросом с ответом, а не действием, которого формально никто не делал;
 * - «Отменена» и архивная — предмета правки нет вовсе.
 *
 * Предикат общий с сервером: кнопка коррекции не должна предлагать того, чем ручка ответит отказом.
 */
export function canCorrectAssignment(request: {
  status: RequestStatus;
  assignment: VehicleRequestAssignmentDto | null;
  deletedAt: string | null;
}): boolean {
  return request.status === 'confirmed' && !!request.assignment && !request.deletedAt;
}

/**
 * Отказ закрытой заявке — не «нельзя», а «сделайте вот это» (Р13, Р38): коррекция здесь становится
 * совместной, и человек должен прочесть, чьей помощи просить.
 */
export const ASSIGNMENT_CORRECTION_CLOSED_MESSAGE =
  'Заявка закрыта: смена машины задним числом переписала бы уже предъявленный счёт. Пусть администратор вернёт её в работу — факт выполнения при откате сохраняется, — после коррекции заявку закрывают теми же цифрами';

/**
 * Сколько листов ЭСМ-2 разом называет разблокировка. 53 недели — календарный год: заказ техники на
 * объект длиннее года не встречается, а предел нужен не ради базы, а чтобы ошибка портала не
 * пришла запросом на десять тысяч идентификаторов.
 */
export const ESM2_UNLOCK_LIMIT = 53;

/**
 * Признак коррекции у смены назначения (ADR 0101, Р8) — явным блоком, а не догадкой сервера.
 *
 * Догадаться нельзя ни по одному признаку тела: та же смена машины у той же заявки бывает и
 * обычной дневной работой («заказанная сломалась, поедет другая»), и правкой прошедшего дня
 * («ехала другая, а записана эта»). Первая ничего о прошлом не утверждает и ни права, ни причины
 * не требует; вторая жжёт номера отработанных недель и снимает подписи объекта. Признак поэтому
 * приходит от человека, а не выводится из состояния заявки.
 *
 * Авторизацией этот блок при этом **не является** (Р11). Право `waybills.correct`, глубину
 * (`WAYBILL_CORRECTION_DAYS`) и принадлежность названных листов этой заявке сервер спрашивает сам
 * и всегда: тело запроса перечисляет намерение, а не разрешение.
 */
export const correctAssignmentSchema = z
  .object({
    /** Ключ идемпотентности (Р31): повтор после обрыва связи не жжёт второй номер бланка. */
    operationId: uuidSchema,
    /** Причина операции: она же уходит в оба листа — в старый как причина списания (Р35). */
    reason: backdateReasonSchema,
    /**
     * Листы ЭСМ-2 отработанных недель, которые правят, — идентификаторами, а не понедельниками
     * (Р11): после линейной техники в одной неделе законно живут листы двух машин (ADR 0100 п. 7),
     * и понедельник как ключ разблокировал бы не тот лист или сразу оба.
     *
     * Пусто — прошедшие недели не трогаются вовсе: коррекция тогда лишь переписывает назначение
     * (и, если их не было, выписывает листы за недели, у которых бумаги нет вовсе).
     */
    unlockWaybillIds: z.array(uuidSchema).max(ESM2_UNLOCK_LIMIT).optional().default([]),
  })
  .strict();
export type CorrectAssignmentInput = z.infer<typeof correctAssignmentSchema>;
export type CorrectAssignmentBody = z.input<typeof correctAssignmentSchema>;

/**
 * Смена машины и ставок у заявки, которая уже в работе (ADR 0048).
 *
 * Тело — то же, что у назначения при переводе в работу, плюс версия заявки: подбирают машину тем
 * же окном и по тем же правилам, меняется только момент. Устаревших `driverPersonId` и `waybill`
 * здесь нет: действие заведено после маршрутов, и рейс описывается только `route` (ADR 0037).
 *
 * Статуса в теле нет намеренно: он не меняется. Тем и отличается от повторного перевода в работу
 * (ADR 0027 п. 8), которым машину переписывали до сих пор, — тот требовал сначала откатить заявку.
 */
export const changeVehicleAssignmentSchema = z
  .object({
    vehicleId: uuidSchema,
    pricePerHour: vehiclePriceSchema.nullable().optional(),
    pricePerShift: vehiclePriceSchema.nullable().optional(),
    shiftHours: shiftHoursSchema.nullable().optional(),
    /**
     * Рейс новой машины: существующий маршрут на дату заявки либо новый — с водителем и
     * реквизитами. Обязателен там же, где и при переводе в работу, — решает сервер.
     */
    route: assignRouteSchema.optional(),
    /**
     * Машинист новых листов ЭСМ-2. Не передан — берётся с прежнего листа заявки: меняли машину, а
     * не человека. Требуется только там, где брать его неоткуда — заявку вели арендной техникой,
     * и листов у неё не было вовсе.
     */
    driverPersonId: uuidSchema.optional(),
    version: z.number().int().nonnegative(),
    /**
     * Смена машины задним числом (ADR 0101, Р8): под правом снимает замок подтверждённых дней,
     * переписывает листы ЭСМ-2 названных отработанных недель и заводит запись операции. Блока нет
     * — обычная смена техники, как была: ни права, ни причины, ни следа в журнале коррекций.
     */
    correction: correctAssignmentSchema.optional(),
    /**
     * Отпечаток последствий, показанных предпросмотром
     * (`POST /vehicle-requests/:id/assignment/preview`, план §8, Р32).
     *
     * Необязателен в схеме, и это не мягкость, а фазирование (Ж5, И5). Портал шлёт его начиная с
     * волны 4a, а старые вкладки и кэш живут дольше выката: потребуй схема отпечаток сразу, смена
     * техники перестала бы работать у всех в момент деплоя. Поэтому спрашивает его **сервер** и по
     * режиму чтения: в `legacy` отпечаток сверяется только у того, кто его прислал, в `history`
     * становится обязательным, и старый клиент получает 409 `CLIENT_UPGRADE_REQUIRED` из
     * обработчика, а не 400 от схемы.
     *
     * Остальная часть `changeVehicleAssignmentExtrasSchema` — `anchors`, `unlockFingerprint`,
     * `clearedShiftsFingerprint`, `acknowledgements`, `operation` и коррекционный блок с целью —
     * приезжает вместе с окном волны 4a. Принять их сейчас значило бы принимать и **молча
     * игнорировать**: якорей эта дверь пока не пишет (Р22, бэкстоп), а рукопожатие, которое никто
     * не проверяет, хуже отсутствующего. Коррекционный блок здесь по той же причине остаётся
     * прежним (`correctAssignmentSchema`): его цель и `operation` — это смена тела, а не
     * расширение, и она идёт своей волной.
     */
    previewFingerprint: changeVehicleAssignmentExtrasSchema.shape.previewFingerprint,
  })
  .strict();
export type ChangeVehicleAssignmentInput = z.infer<typeof changeVehicleAssignmentSchema>;
export type ChangeVehicleAssignmentBody = z.input<typeof changeVehicleAssignmentSchema>;

// ── Выписка недельного листа ЭСМ-2 по требованию (ADR 0100 §6) ──

/**
 * Заказ линейной техники ведётся днями, и недельный лист ЭСМ-2 портал сам не выписывает
 * (`esm2Mode` → `on_demand`). Нужен он или нет — решает человек, и это единственный бланк, у
 * которого появилась ручная выдача.
 *
 * Три поля вместо одного «выписать» — потому что ни на один из этих вопросов у заявки нет ответа:
 *
 * - `weekOf` — **день**, а не пара границ: границы недели считает сервер тем же `esm2Periods`,
 *   которым выписывает автомат (пересечение календарной недели со сроком заявки). Присланные
 *   клиентом границы разошлись бы с выпиской на первом же дне срока посреди недели.
 * - `vehicleId` — за неделю на объекте могли отработать две разных единицы, и у каждой свои
 *   моточасы: неделя ЭСМ-2 уникальна на машину, а не на заявку (ADR 0100 §7).
 * - `driverPersonId` — спрашивается **всегда и без умолчания**: графа машиниста в бланке одна на
 *   неделю, а водитель у линейной машины каждый день свой, и наследование напечатало бы в
 *   недельном листе человека, отработавшего один вторник (ADR 0083).
 */
export const issueRequestEsm2Schema = z
  .object({
    /** Любой день недели, на которую нужен лист; чаще всего — понедельник из таблицы портала. */
    weekOf: dateOnlySchema,
    vehicleId: uuidSchema,
    driverPersonId: uuidSchema,
    version: z.number().int().nonnegative(),
    /**
     * Причина выписки задним числом (ADR 0101 п. 4, дыра 3 плана). Ручная выдача — вторая дверь к
     * бланку ЭСМ-2, и до ADR 0101 она про дату не спрашивала вовсе: неделя месячной давности
     * закрывалась номером строгой отчётности молча. Эффективная дата у листа одна на все входы —
     * `periodTo` недели (таблица §4 плана), — и её же спрашивает `backdateGuard`.
     *
     * Необязательна в схеме и обязательна на сервере ровно тогда, когда неделя уже кончилась:
     * решает это guard, который один знает субъекта, его права и глубину. Схема субъекта не знает,
     * и требовать объяснение за лист текущей недели значило бы спрашивать причину у обычной работы.
     *
     * Имя `reason`, а не `backdateReason`, как у правки заявки: ближайший родственник этой ручки —
     * не правка заказа, а выписка листа по рейсу (`issueRouteWaybillSchema`), и у одинакового
     * действия поле обязано называться одинаково.
     */
    reason: z.string().trim().max(2000).optional(),
    /**
     * Ключ идемпотентности операции (Р31). Нужен там же, где причина: выписка задним числом жжёт
     * номер серии и заводит строку в журнале коррекций, и повтор после обрыва связи обязан вернуть
     * прежний лист, а не следующий номер. У листа текущей недели ключа нет — это обычная работа.
     */
    operationId: uuidSchema.optional(),
    /**
     * Подтверждение предупреждений выписки (Р21, Р21а) — тем же полем и той же схемой, что у листа
     * по рейсу (`waybillAcknowledgeSchema` в `issueRouteWaybillSchema`): подтверждают в обоих
     * случаях одно и то же — набор **фактов**, посчитанный сервером и прочитанный человеком, — и
     * вторая форма поля заставила бы портал помнить, какой бланк он подтверждает.
     *
     * Ручная выдача ЭСМ-2 и есть пятый путь выпуска номера, которого Р21а не назвала: рейса у этого
     * листа нет вовсе, а машинист есть — и пробелы в его документах (ADR 0064) это ровно то, о чём
     * человек обязан знать до расхода бланка строгой отчётности. Окно портала проверкой не
     * является: старая вкладка, повтор запроса из истории и `curl` выписали бы лист молча.
     *
     * Необязательно по той же причине, что и там: пустой набор рукопожатия не требует вовсе, и лист
     * машинисту с полным комплектом выписывается одним заходом.
     */
    acknowledge: waybillAcknowledgeSchema.optional(),
  })
  .strict();
export type IssueRequestEsm2Input = z.infer<typeof issueRequestEsm2Schema>;
export type IssueRequestEsm2Body = z.input<typeof issueRequestEsm2Schema>;

/**
 * Тело отказа `waybill_ack_required` у ручной выдачи ЭСМ-2 (Р21а) — то, из чего портал собирает
 * окно подтверждения.
 *
 * Своё, а не `WaybillAckRequiredDetails`: там обязательные `routeId` и `routeNumber`, которых у
 * недельного листа не существует — он выписывается на заявку и неделю, а не на рейс, — и заполнить
 * их было бы нечем, кроме выдумки. Общим у двух тел остаётся ровно то, что читает портал и что
 * возвращается серверу нетронутым: отпечаток и список.
 */
export interface Esm2AckRequiredDetails {
  requestId: string;
  /** Неделя, посчитанная сервером: ею окно называет человеку бумагу, о которой спрашивает. */
  periodFrom: string;
  periodTo: string;
  /** `sha256` от каноникализованных фактов: его же портал возвращает в `acknowledge`. */
  fingerprint: string;
  warnings: WaybillWarning[];
}

// ── Перегон по заявке задним числом (ADR 0101 п. 4) ──

/**
 * Перегон, заводимый из карточки заявки (`POST /vehicle-requests/:id/relocations`).
 *
 * От общей схемы перегона отличается одним полем — причиной заднего числа, — и заведено это
 * расширением, а не правкой самой `createRelocationRouteSchema`: та же схема без `purpose` стоит
 * блоком доставки в переводе заявки в работу, где дату перегона задаёт не она, а форма назначения.
 *
 * Почему у перегона нет ключа операции, хотя дата у него в прошлом бывает ровно так же, как у
 * листа: рейс-перегон — планировочная запись, номера строгой отчётности он не расходует, и строки
 * `waybill_corrections` такая дверь не заводит (§1 плана, уточнение этапа 7). Право и причина
 * спрашиваются, объяснение уходит в аудит события `vehicle_route.create` — тем же правилом, что у
 * заведения обычного рейса. Причина у бумаги появится своя: её спросит выписка листа по этому рейсу.
 */
export const createRequestRelocationSchema = createRelocationRouteSchema.extend({
  reason: z.string().trim().max(2000).optional(),
});
export type CreateRequestRelocationInput = z.infer<typeof createRequestRelocationSchema>;
export type CreateRequestRelocationBody = z.input<typeof createRequestRelocationSchema>;

// ── Факт выполнения заявки (ADR 0029) ──

/**
 * Чем мерят отработанное — теми же единицами, в которых заведены ставки (ADR 0027, ADR 0018).
 * Третьей единицы («по рейсам», «по тоннам») здесь нет намеренно: за что не назначена ставка,
 * то нечем и считать.
 */
export const VEHICLE_WORK_UNITS = ['hours', 'shifts'] as const;
export const vehicleWorkUnitSchema = z.enum(VEHICLE_WORK_UNITS);
export type VehicleWorkUnit = (typeof VEHICLE_WORK_UNITS)[number];

export const vehicleWorkUnitLabels: Record<VehicleWorkUnit, string> = {
  hours: 'Часами',
  shifts: 'Сменами',
};

/** Как называется ставка этой единицы: «ставка за час», «ставка за смену». */
export const vehicleWorkUnitRateLabels: Record<VehicleWorkUnit, string> = {
  hours: 'за час',
  shifts: 'за смену',
};

/** Ставка этой единицы: «часами» считают по цене за час, «сменами» — по цене за смену. */
export function rateForWorkUnit(
  rates: { pricePerHour: number | null; pricePerShift: number | null } | null | undefined,
  unit: VehicleWorkUnit,
): number | null {
  if (!rates) return null;
  return (unit === 'hours' ? rates.pricePerHour : rates.pricePerShift) ?? null;
}

/** Стоимость закрытия: ставка на количество, с округлением до копейки. Нет ставки — нет суммы. */
export function calcVehicleRequestCost(rate: number | null, amount: number): number | null {
  if (rate == null) return null;
  return Math.round(rate * amount * 100) / 100;
}

/** «26 ч», «3 смены», «2,5 смены» — отработанное одной строкой, с русским склонением. */
export function workedAmountLabel(unit: VehicleWorkUnit, amount: number): string {
  const value = amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (unit === 'hours') return `${value} ч`;
  // Дробное количество смен — всегда «смены» («2,5 смены»); целое склоняется по последней цифре.
  if (!Number.isInteger(amount)) return `${value} смены`;
  const tail = amount % 100;
  const last = amount % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'смен'
      : last === 1
        ? 'смена'
        : last >= 2 && last <= 4
          ? 'смены'
          : 'смен';
  return `${value} ${form}`;
}

/** Отработанное количество: numeric(10,2), положительное. Смена дробится до четверти часа. */
const workedAmountSchema = z
  .number()
  .positive('Укажите отработанное время')
  .max(99_999_999.99, 'Слишком большое значение')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Не более 2 знаков после запятой');

/**
 * Заявку закрывают фактом: сколько отработали и во сколько это обошлось. Сумма приходит от
 * клиента — он её и показывал человеку перед нажатием, — но подставляется расчётом по ставке
 * назначения: счёт арендодателя включает и перегон, и простой, и сходиться сумма заявки должна
 * со счётом, а не с формулой. Не прислана — сервер посчитает сам.
 */
export const completeVehicleRequestSchema = z
  .object({
    workedUnit: vehicleWorkUnitSchema,
    workedAmount: workedAmountSchema,
    totalCost: vehiclePriceSchema.nullable().optional(),
  })
  .strict();
export type CompleteVehicleRequestInput = z.infer<typeof completeVehicleRequestSchema>;

/**
 * Переход, требующий факта: «Выполнена» отвечает на «сколько отработали и сколько стоило».
 * Отмена факта не требует — по отменённой заявке никто не выходил.
 */
export function transitionRequiresCompletion(to: RequestStatus): boolean {
  return to === 'done';
}

// Комментарий пишется в историю (vehicle_request_status_history.comment); при отмене
// он обязателен и играет роль причины — как и у заявок на вывоз мусора.
// Техника передаётся вместе с переводом в работу (ADR 0027): отдельным запросом назначение
// прошло бы не атомарно со сменой статуса, и заявка успела бы побыть «в работе» ни на чём.
export const changeVehicleRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: commentSchema.optional().default(''),
    /**
     * Назначаемая техника; обязательность решает сервер — при повторном переводе в работу
     * (после отката) хватает уже назначенной машины.
     */
    assignment: assignVehicleSchema.optional(),
    /**
     * Факт выполнения (ADR 0029): отработанное время и стоимость. Обязательность тоже за
     * сервером — он один знает, была ли у заявки назначена машина и по какой ставке.
     */
    completion: completeVehicleRequestSchema.optional(),
    /**
     * Фактический срок работ или подачи, уточнённый при переводе в работу. Необязателен: если
     * машина выходит на заказанное время, править нечего.
     */
    schedule: confirmScheduleSchema.optional(),
    /**
     * Отпечаток последствий, снятый предпросмотром (`POST /vehicle-requests/:id/status/preview`).
     *
     * Необязателен **в схеме** и спрашивается сервером: обязателен он ровно на одном переходе —
     * откате «Выполнена» → «В работе» у заказа техники на объект, где диалог обещает точный
     * результат сверки ЭСМ-2. Требуй его схема — прочие переходы получали бы `400` на пустом
     * месте; решает по-прежнему сервер, у которого есть и заявка, и её режим.
     *
     * Живёт вместе с предпросмотром: он остаётся и после уборки снимков — обещание «выпишется
     * столько-то листов» обязано быть верным независимо от того, жив ли костыль.
     */
    previewFingerprint: z.string().min(1).optional(),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
    }
    // Срок уточняют там же, где заявку берут в работу: в остальных переходах его правят обычной
    // правкой заявки, и вторая дорога к тем же полям разошлась бы с первой при первом изменении.
    if (v.schedule && !transitionRequiresAssignment(v.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['schedule'],
        message: 'Фактический срок уточняют при переводе заявки в работу',
      });
    }
    if (v.assignment && !transitionRequiresAssignment(v.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignment'],
        message: 'Технику назначают при переводе заявки в работу',
      });
    }
    if (v.completion && !transitionRequiresCompletion(v.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion'],
        message: 'Отработанное время предъявляют при выполнении заявки',
      });
    }
  });
export type ChangeVehicleRequestStatusInput = z.infer<typeof changeVehicleRequestStatusSchema>;

/**
 * Тело предпросмотра последствий перехода — то же самое, что у самой смены статуса.
 *
 * Схема одна намеренно: предпросмотр обязан считать план по тем же входам, по которым его потом
 * исполнит боевая ручка, — машина, машинист, срок и факт приходят из того же окна назначения.
 * Своя схема разошлась бы с боевой на первом же новом поле, и диалог начал бы обещать не то.
 */
export const previewVehicleRequestStatusSchema = changeVehicleRequestStatusSchema;
export type PreviewVehicleRequestStatusInput = ChangeVehicleRequestStatusInput;

/** Аннулируемый лист в предпросмотре: номер человеку, период — чтобы он узнал свою неделю. */
export interface Esm2CancelPreviewDto {
  id: string;
  number: string;
  from: string;
  to: string;
}

/**
 * Что случится с заявкой после перехода — считает сервер, до единой записи.
 *
 * Заведён под откат «Выполнена» → «В работе»: заморозка снимается закрытием, и вернувшаяся в
 * работу заявка пойдёт по актуальному режиму справочника, каким бы он ни стал. Портал при этом
 * ничего не утверждает о прошлом («заявка велась иначе») — угадывать нечем, — а говорит то, что
 * знает точно: каким режимом заказ пойдёт дальше и что сделает сверка ЭСМ-2.
 *
 * Числа берутся из настоящего `esm2SyncPlan` с `correcting = false`, а не из «недель срока минус
 * выписанные»: прошедшая неделя, листа не имевшая, сверкой не выписывается вовсе, и такой расчёт
 * обещал бы лишние листы.
 */
export interface VehicleRequestStatusPreviewDto {
  /** Режим, которым заявка пойдёт после перехода. */
  mode: 'daily' | 'weekly';
  esm2: { issue: Esm2Period[]; cancel: Esm2CancelPreviewDto[] };
  /** Занятость машины после перехода: весь срок заявки или отдельные распланированные дни. */
  busy: 'term' | 'days';
  /**
   * Отпечаток входов плана. Возвращается сюда и предъявляется боевой ручке в
   * `previewFingerprint`: между просмотром и нажатием план меняется, не тронув заявку, — признак
   * типа переключили, лист аннулировали своей ручкой, наступила полночь. `version` заявки ни
   * одного из этих трёх случаев не ловит.
   */
  fingerprint: string;
}

// ── Список ──
/**
 * Поля сортировки списка; ключ столбца таблицы совпадает с именем поля. Полей здесь больше,
 * чем столбцов: `requestType`, `createdByName`, `amount` и адреса в строку списка не вынесены
 * (тип заявки и автор — вторыми строками к типу ТС и номеру, объём/масса и адреса — только в
 * карточке), но сортировка по ним остаётся частью API.
 * `term` и `amount` — общие для обоих типов заявки: срок и «объём/масса» лежат в разных
 * detail-таблицах, поэтому сервер сводит их одним выражением.
 *
 * **Адреса и количество считаются по ездкам (§9), а не по колонкам заявки — их там больше нет.**
 * Поля остались прежними намеренно: сортировка — договор с порталом, и сменить `loadingLocation`
 * на что-то другое значило бы переписать ключи столбцов ради того, что для читателя списка не
 * изменилось. Изменился источник:
 *
 * - `loadingLocation` / `unloadingLocation` — по **первой живой** ездке заявки (наименьший `num`
 *   среди `deleted_at IS NULL`). Не «по любой» и не «по всем»: у заявки с ездками `A→B` и `A→C`
 *   единственного адреса разгрузки не существует (Р2), а список обязан упорядочиваться
 *   однозначно — первая ездка это и есть то, что показано в строке;
 * - `amount` — **сумма** живых ездок тем же правилом, что и подпись количества: объём, а если его
 *   нет ни у одной — масса (`requestCargoTotal`, `tripCargoLabel`).
 *
 * Выражается это SQL, и потому не здесь: сортировочные колонки собраны в `sortColumns`
 * (`apps/api/src/routes/vehicle-requests.ts`) — там, где сегодня стоят
 * `freightTransportRequestDetails.loadingLocation` и `coalesce(volume_m3, weight_tons)`, после
 * миграции `0136` встают подзапросы к `vehicle_request_trips` с отбором живых строк. Мягко
 * удалённую ездку (Р13а) в сортировку пускать нельзя: она никуда не едет, и её адрес в списке
 * означал бы рейс, которого нет.
 */
export const VEHICLE_REQUEST_SORT_FIELDS = [
  'num',
  'requestType',
  'objectName',
  'createdByName',
  'vehicleTypeName',
  'term',
  'amount',
  'loadingLocation',
  'unloadingLocation',
  'status',
  'approval',
  'comment',
  'createdAt',
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили. Порядок по нему там умолчанием —
  // архив открывают вопросом «что снесли последним».
  'deletedAt',
  // Столбцы журнала закрытых заявок (вкладка «История», ADR 0029): чья машина и во сколько
  // обошлась. В списке заявок этих столбцов нет, но поля сортировки общие — запрос один.
  'lessorName',
  'totalCost',
  'completedAt',
] as const;

/**
 * Списочные фильтры **без** проверки «две формы сразу»: её вешают итоговые схемы
 * (`withSingleClassificationForm`), а производные — журнал и лента — расширяют именно эту базу.
 * Расширяй они проверенную схему, проверка приехала бы вместе с ней и сработала бы вторым разом.
 */
export const vehicleRequestListQueryBase = baseListQuery(VEHICLE_REQUEST_SORT_FIELDS).extend({
  // Необязателен: раздел «Заказ автотехники» — единый список обоих типов.
  // Задан — список сужается до одного типа (фильтр в интерфейсе, вкладка «На объекте»).
  requestType: vehicleRequestTypeSchema.optional(),
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  /** Заказчик со стороны офиса (ADR 0040): фильтр «заявки этого отдела». */
  departmentId: uuidSchema.optional(),
  /**
   * Набор заказанных позиций классификатора (`t<uuid>` — тип целиком, `c<uuid>` — категория),
   * объединяемых по ИЛИ: «покажи автокраны и самосвалы» — один список, а не два захода.
   */
  classifications: classificationFilterSchema.optional(),
  // Прежняя форма того же фильтра — одна позиция парой полей. Остаётся принимаемой, пока по ней
  // ходят открытые вкладки со старым JS: сервер расширяется раньше портала, и обе формы живут
  // рядом до тех пор, пока не появится принудительный гейт версии сборки.
  vehicleTypeId: uuidSchema.optional(),
  // Категория задаётся вместе с типом (позиция классификатора выбирается целиком, ADR 0028):
  // одна категория принадлежит одному типу, и фильтр по ней сужает список до неё.
  vehicleCategoryId: uuidSchema.optional(),
  /**
   * Назначенная машина (ADR 0027, ADR 0098) — единица парка, а не позиция классификатора: вопрос
   * «где ходил ТС-341» задают госномером. Заявка без назначения под этот фильтр не попадает
   * никогда, и это верно: машины у неё ещё нет.
   */
  vehicleId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
  // Виза (ADR 0025): «false» — заявки, ждущие согласования; ими и открывают день диспетчер
  // и руководитель строительства.
  approved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // Календарный диапазон (YYYY-MM-DD): для спецтехники — пересечение периодов,
  // для грузоперевозки — день в Europe/Moscow (интерпретирует backend).
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Архив (ADR 0070): `only` — вкладка «Архив», остальное сервер отдаёт только праву `archive.read`. */
  archive: archiveFilterSchema,
});

export const vehicleRequestListQuerySchema = withSingleClassificationForm(
  vehicleRequestListQueryBase,
);
/** Разобранный запрос списка: им же типизируется общее условие выборки, одно на список и ленту. */
export type VehicleRequestListQuery = z.infer<typeof vehicleRequestListQuerySchema>;

/**
 * Журнал закрытых заявок (вкладка «История», ADR 0029). Тот же список, суженный до состоявшегося:
 * «Выполнена» и «Отменена». Своё здесь — арендодатель: в журнале читают не только «что заказывали»,
 * но и «у кого брали», а по одному арендодателю сводят и расходы.
 *
 * `status` наследуется от общей схемы и сужает журнал до одного из двух закрытых статусов;
 * остальные сервер отклоняет — открытая заявка историей ещё не стала.
 */
export const vehicleRequestHistoryQuerySchema = withSingleClassificationForm(
  vehicleRequestListQueryBase.extend({
    lessorId: uuidSchema.optional(),
  }),
);
export type VehicleRequestHistoryQuery = z.infer<typeof vehicleRequestHistoryQuerySchema>;

/** Статусы, попадающие в журнал: заявка, по которой уже нечего решать. */
export const CLOSED_REQUEST_STATUSES = [
  'done',
  'cancelled',
] as const satisfies readonly RequestStatus[];

export function isClosedRequestStatus(status: RequestStatus): boolean {
  return (CLOSED_REQUEST_STATUSES as readonly RequestStatus[]).includes(status);
}

/**
 * Итог журнала за выбранный период и фильтры: сколько заявок закрыто, сколько выполнено и
 * отменено и на какую сумму. Сумма — по выполненным с известной стоимостью: у отменённой её
 * не бывает, а у своей машины без ставки работа в деньгах не считается.
 */
export interface VehicleRequestHistorySummaryDto {
  total: number;
  done: number;
  cancelled: number;
  totalCost: number;
  /** Сколько выполненных заявок не имеет суммы — иначе итог читается как «всё посчитано». */
  withoutCost: number;
}

// ── Техника на объекте: вкладка «На объекте» (ADR 0036) ──

/**
 * Что показывает вкладка — техника, которая работает на объектах прямо сейчас. Отбор ведут сроки
 * заявки: сегодняшний день по Москве должен попадать в её период. Статус в отборе не фильтр, а
 * часть условия — только «В работе»: взятая в работу заявка названа машиной и ставкой (ADR 0027),
 * а по новой на объект ещё никто не выходил.
 *
 * Дата в запросе не передаётся намеренно: «сейчас» обязан считать сервер. Часы клиента бывают
 * сбиты, а браузер восточнее Москвы начинает сутки раньше — и срез разошёлся бы с ответом API.
 */
export const VEHICLE_ON_SITE_SORT_FIELDS = [
  'num',
  'objectName',
  'vehicleTypeName',
  'term',
  'createdAt',
] as const satisfies readonly (typeof VEHICLE_REQUEST_SORT_FIELDS)[number][];

/**
 * Фильтры вкладки — объект, заказанная позиция классификатора (ADR 0028) и бланк работы дня. Ни
 * статуса, ни типа заявки, ни дат здесь нет: они этот список не сужают, а определяют. Схема своя,
 * а не `pick` от списочной, именно поэтому: от `dateFrom` в общей схеме клиент вправе ждать, что
 * тот сработает, — здесь он не сработает никогда.
 *
 * Набором площадок одиночный `objectId` при этом не становится (Р20): расширять фильтр, о котором
 * не просили, — это менять чужой экран заодно.
 */
export const vehicleRequestOnSiteQuerySchema = withSingleClassificationForm(
  baseListQuery(VEHICLE_ON_SITE_SORT_FIELDS).extend({
    objectId: uuidSchema.optional(),
    /** Набор позиций — тот же контрол, что в списке заявок: фильтр один на четыре вкладки. */
    classifications: classificationFilterSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.optional(),
    num: z.coerce.number().int().positive().optional(),
    /**
     * Бланк работы дня набором (Р6, Р21): строка проходит, если пересечение её набора бланков с
     * набором фильтра непусто. Набор с обеих сторон, потому что у дня бывает две работы разных
     * бланков сразу — линейный заказ ведёт рейс дня (4-П) и лист ЭСМ-2 по требованию, — и одно
     * значение соврало бы дважды: спрятало бы такую строку от отбора «ЭСМ-2» и показало бы её же
     * в отборе «4-П» как единственную правду.
     *
     * Схема — та же, что у среза гаража (`garageFormFilterSchema`), а не вторая её копия: ключ
     * `forms=4p,esm2` обязан читаться на обеих вкладках одинаково, и второй разбор той же строки
     * разошёлся бы с первым на первой же правке справочника бланков.
     */
    forms: garageFormFilterSchema.optional(),
  }),
);
export type VehicleRequestOnSiteQuery = z.infer<typeof vehicleRequestOnSiteQuerySchema>;

/**
 * Срез вкладки. `onDate` — день, по которому сервер отбирал строки: подписи вида «день 3 из 5»
 * считаются от него, а не от часов клиента, иначе отбор и подпись отвечали бы про разные дни.
 */
export interface VehicleOnSiteListDto {
  items: SpecialEquipmentRequestDto[];
  total: number;
  page: number;
  pageSize: number;
  /** День среза (`YYYY-MM-DD`) по Москве. */
  onDate: string;
}

/**
 * Машина, которой заказ работает в день среза: машина **этого дня**, а не машина назначения.
 *
 * Источников у ответа два, и оба отвечают на один вопрос — «что сейчас стоит на площадке»:
 *
 * - у линейного заказа (ADR 0100 §4) это машина **рейса этого дня**. Назначение у него всего лишь
 *   машина по умолчанию, а на объект во вторник выходит та, чьим рейсом вторник закрыт;
 * - у обычного заказа — машина, действующая на этот день по истории назначения (план Ф3, этап 5).
 *   Прежде поле у него не заполнялось вовсе, и это опиралось ровно на ту посылку, которую фича
 *   отменяет: «машина стоит весь срок одна». После разреза срока назначение повторяет **последнее**
 *   vehicle-изменение (Р17), то есть на январской дате называет мартовскую машину.
 *
 * Водитель едет вместе с машиной по той же причине, по какой он есть в занятости гаража: «кто
 * сегодня на этой машине» спрашивают ровно тогда же, когда «какая машина сегодня на объекте».
 */
export interface VehicleOnSiteDayVehicleDto {
  /**
   * Рейс, которым машина вышла в этот день; `null` — она стоит на площадке сроком заказа, а не
   * едет рейсом. Пустой рейс бывает только у второго источника (история обычного заказа): у
   * линейного дня рейс и есть то, чем день закрыт.
   */
  routeId: string | null;
  /** «Р-12» — по нему о рейсе говорят по телефону; пусто вместе с самим рейсом. */
  routeDisplayNumber: string | null;
  vehicleId: string;
  /**
   * Как машина названа везде — общим правилом `vehicleLabel`: госномер, а без него модель,
   * категория, тип (Р16). Склейки «модель · госномер» здесь больше нет: из неё вторую строку
   * колонки не построить, не разбирая строку обратно по разделителю.
   */
  vehicleLabel: string;
  /** Марка второй строкой колонки — полем, а не сборкой на портале (Р14): пусто, если не заведена. */
  vehicleModelName: string | null;
  /**
   * Пусто — человека на этот день портал не называет: у рейса его ещё не поставили (рейс собирают
   * заранее, человека ставят утром), у истории он снят осознанно (`cleared`, арендный отрезок) или
   * не восстановлен (`unknown`). Догадка вместо него не подставляется ни в одном из трёх случаев.
   */
  driverPersonId: string | null;
  driverName: string;
}

/**
 * Что стоит в колонке техники у линейного заказа, чей сегодняшний день никуда не поставлен
 * (`dayVehicle: null`). Строка из среза не уходит — заказ идёт, площадка машину ждёт, — но
 * назначение показывать вместо факта нельзя: у линейной заявки это машина по умолчанию, и выдать
 * её за вышедшую сегодня значило бы ответить на вопрос «что на объекте» догадкой (ADR 0100 §12).
 *
 * Слова живут в контрактах, а не в разметке, по общему правилу портала: сервер и экран обязаны
 * объяснять одно и то же одними словами.
 */
export const ON_SITE_DAY_UNPLANNED_MESSAGE = 'на этот день машина не назначена';

/**
 * Итог среза: сколько единиц техники сейчас на объектах и на скольких объектах, сколько вышло
 * сегодня и сколько уезжает. Последние две цифры — то, ради чего вкладку открывают утром: и
 * приёмка машины, и освобождение площадки планируются именно по ним.
 */
export interface VehicleOnSiteSummaryDto {
  total: number;
  objects: number;
  arrivedToday: number;
  leavingToday: number;
  /**
   * Сколько машин ждёт визы на досрочный отъезд (ADR 0044). Пятая цифра здесь по той же причине,
   * что и две предыдущие: площадку освобождают по ней, а по статусу заявки это не видно — она
   * всё ещё «В работе» на весь заказанный срок.
   */
  earlyEndPending: number;
  /**
   * Сколько заявок среза ждёт согласования смен — то есть по скольким работа ещё не принята
   * объектом. Цифра долга, а не сегодняшнего дня: часть этих заявок уже отработала свой срок, и
   * закрыть их можно только с предупреждением, что подписи площадки под днями нет.
   */
  shiftsPending: number;
}

/**
 * Как строка стоит в сегодняшнем дне: `single` — заявка на один день (вышла и уедет), `arrives` —
 * первый день периода, `leaves` — последний, `ongoing` — середина срока.
 *
 * Пустая дата окончания — однодневный срок: тем же `coalesce(date_to, date_from)` сервер ищет
 * пересечение периодов, и подпись обязана читать срок так же, как отбор.
 */
export type VehicleOnSitePresence = 'single' | 'arrives' | 'leaves' | 'ongoing' | 'awaiting';

export function onSitePresence(
  r: { dateFrom: string; dateTo: string | null },
  onDate: string,
): VehicleOnSitePresence {
  const last = r.dateTo || r.dateFrom;
  // Срок кончился, а строка в срезе осталась — держат её неподтверждённые смены: такая заявка не
  // должна исчезать с экрана, на который смотрят каждое утро, и всплывать через месяц при
  // попытке её закрыть. Сам отбор ведёт сервер, здесь только подпись.
  if (last < onDate) return 'awaiting';
  const isFirst = r.dateFrom === onDate;
  if (isFirst && last === onDate) return 'single';
  if (isFirst) return 'arrives';
  return last === onDate ? 'leaves' : 'ongoing';
}

export const vehicleOnSitePresenceLabels: Record<VehicleOnSitePresence, string> = {
  single: 'один день',
  arrives: 'вышла сегодня',
  leaves: 'уезжает сегодня',
  ongoing: 'на объекте',
  awaiting: 'смены не согласованы',
};

/** Цвет тега присутствия: выделены дни выхода и отъезда — по ним и планируют площадку. */
export const vehicleOnSitePresenceColors: Record<VehicleOnSitePresence, string> = {
  single: 'purple',
  arrives: 'blue',
  leaves: 'orange',
  ongoing: 'default',
  // Красный, а не оранжевый: срок прошёл, техника уехала, а работа не принята — это не ожидание
  // решения, а долг, с которым заявку закрывают только через предупреждение.
  awaiting: 'red',
};

/**
 * Который день из заказанных идёт сегодня: «день 3 из 5». Однодневная заявка подписи не получает
 * — «день 1 из 1» не сообщает ничего, чего не сказал бы тег присутствия. `null` и когда период
 * не складывается: считать в нём нечего.
 */
export function onSiteDayLabel(
  r: { dateFrom: string; dateTo: string | null },
  onDate: string,
): string | null {
  const day = dayNumberInPeriod(r.dateFrom, onDate);
  const total = dayNumberInPeriod(r.dateFrom, r.dateTo || r.dateFrom);
  if (day == null || total == null || total < 2) return null;
  return `день ${day} из ${total}`;
}

/** Номер дня `onDate` в периоде, считая от `dateFrom` (включительно); `null` — день раньше начала. */
function dayNumberInPeriod(dateFrom: string, onDate: string): number | null {
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${onDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Сводка по статусам для виджета над списком. Из фильтров таблицы учитываются сужающие область —
 * заказчик, тип заявки, заказанная позиция классификатора и назначенная машина: цифры относятся к
 * тому же списку, что человек видит перед собой. Фильтр по статусу свёл бы сводку к самой себе,
 * а по номеру — к одной заявке.
 */
export const vehicleRequestSummaryQuerySchema = withSingleClassificationForm(
  z.object({
    objectId: uuidSchema.optional(),
    /**
     * Отдел-заказчик (ADR 0040, Р9а) — вторая половина той же пары, что и объект: подбор
     * «Объект/отдел» пишет в один из двух параметров, и сводка обязана сужаться тем же, чем
     * сужается список. Без него фильтр по отделу оставил бы «Не обработанных» и «Ждут визы»
     * посчитанными по всем отделам сразу — цифры над таблицей перестали бы относиться к строкам
     * под ней.
     */
    departmentId: uuidSchema.optional(),
    requestType: vehicleRequestTypeSchema.optional(),
    /** Тот же набор, что у списка: сводка считается по тем строкам, что человек видит. */
    classifications: classificationFilterSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.optional(),
    /** Назначенная машина (ADR 0098): та же единица парка, что и в фильтре списка. */
    vehicleId: uuidSchema.optional(),
  }),
);
export type VehicleRequestSummaryQuery = z.infer<typeof vehicleRequestSummaryQuerySchema>;

/**
 * Количество видимых заявок в каждом статусе (удалённые не считаются) плюс отдельная цифра —
 * сколько новых заявок ждёт визы (ADR 0025): пока её нет, заявка не двинется дальше, и это
 * не видно ни по одному статусу.
 */
export type VehicleRequestSummaryDto = Record<RequestStatus, number> & {
  awaitingApproval: number;
};

// ── DTO ──

/**
 * Назначенная на заявку техника со ставками (ADR 0027). Реквизиты машины — join'ом, а не
 * снимком: в карточке заявки предъявляют ту машину, что стоит в справочнике сейчас (её могли
 * переименовать или уточнить госномер). Снимок здесь только у ставок — о них договорились под
 * эту заявку, и правка прайса их не переписывает.
 */
export interface VehicleRequestAssignmentDto {
  vehicleId: string;
  ownership: VehicleOwnership;
  /**
   * Вид и тип ТС **машины** — они же и записаны в назначении. С заказанными они совпадать не
   * обязаны (ADR 0059, ADR 0064): заявку закрывают тем, что есть в парке, а расхождение
   * показывается пометкой. Заказанное остаётся у самой заявки и назначением не переписывается.
   */
  vehicleKindId: string;
  vehicleTypeId: string;
  typeName: string;
  vehicleCategoryId: string | null;
  categoryName: string | null;
  /** ТТХ категории машины — правая сторона сравнения с заказанным (`compareVehicleSize`). */
  categorySpecs: VehicleSpecValues | null;
  modelName: string | null;
  registrationNumber: string | null;
  /** Короткий срез предложения аренды («Автокран 70 тн»); у своей машины пуст. */
  description: string;
  lessorId: string | null;
  lessorName: string | null;
  pricePerHour: number | null;
  pricePerShift: number | null;
  shiftHours: number | null;
  assignedBy: string;
  assignedByName: string;
  assignedAt: string;
}

/**
 * Водитель или машинист, который сейчас связан с работой по заявке.
 *
 * Виден всем, кто видит заявку (ADR 0122): человека, который приедет на площадку, встречает
 * заказчик, и звонить ему он обязан сам, а не через диспетчера. Раньше контакт был закрыт правом
 * на путевые листы — и заказчик оставался единственным, кому номер не показывали. Закрытыми
 * остались карточка водителя со СНИЛС и удостоверением (`drivers.read`) и сам бланк
 * (`waybills.read`): здесь только имя и телефон, то есть ровно то, чем в работе обмениваются
 * вслух.
 *
 * Отдельным запросом, а не полем `VehicleRequestDto`: у заявки такого поля нет — контакт
 * вычисляется из маршрута либо из недельного листа, и списку заявок этот join не нужен.
 */
export interface VehicleRequestDriverDto {
  personId: string;
  fullName: string;
  /** Пусто — водитель назначен, но телефон в справочнике не заполнен. */
  phone: string;
}

/** Как назначенная машина называется в списке заявок и в карточке. */
export function assignmentTitle(a: VehicleRequestAssignmentDto): string {
  return vehicleLabel(a);
}

/** Ставки одной строкой: «2 500 ₽/час · 18 000 ₽/смена (8 ч)»; пусто — ставок нет. */
export function assignmentRateLabel(a: {
  pricePerHour: number | null;
  pricePerShift: number | null;
  shiftHours: number | null;
}): string {
  const money = (v: number): string =>
    v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts: string[] = [];
  if (a.pricePerHour != null) parts.push(`${money(a.pricePerHour)} ₽/час`);
  if (a.pricePerShift != null) {
    parts.push(`${money(a.pricePerShift)} ₽/смена${a.shiftHours ? ` (${a.shiftHours} ч)` : ''}`);
  }
  return parts.join(' · ');
}

/**
 * Факт выполнения заявки (ADR 0029): сколько отработали и во сколько это обошлось. Ставка —
 * снимок на момент закрытия, а не текущая ставка назначения: сумма обязана объясняться сама.
 */
export interface VehicleRequestCompletionDto {
  workedUnit: VehicleWorkUnit;
  workedAmount: number;
  /** Ставка за единицу на момент закрытия; `null` — своя машина без ставки. */
  rate: number | null;
  /** Итоговая стоимость; `null` — считать было нечем (работу в деньгах не ведут). */
  totalCost: number | null;
  completedBy: string;
  completedByName: string;
  completedAt: string;
}

/** Отработанное и сумма одной строкой: «3 смены × 18 000 ₽»; без ставки — только отработанное. */
export function completionLabel(c: VehicleRequestCompletionDto): string {
  const worked = workedAmountLabel(c.workedUnit, c.workedAmount);
  if (c.rate == null) return worked;
  const rate = c.rate.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${worked} × ${rate} ₽`;
}

/**
 * Подпись заказчика заявки для списка и карточки: объект или отдел (ADR 0040). Одно место на
 * портал и сервер — иначе половина экранов показывала бы «—» там, где заявку завёл отдел.
 *
 * Тонкая обёртка над объектом затрат (Р25): «кто заказчик» и «на кого расходы» — один и тот же
 * вопрос, и двух ответов на него быть не должно. Прежняя реализация (`objectName ?? departmentName
 * ?? '—'`) отвечала на него **именами**, и это оказалось важнее, чем выглядит:
 *
 * - решает теперь **идентификатор**, а не заполненность имени, — как и в CHECK
 *   `vehicle_requests_customer_check`. На заявке, где заказчик один, ответ прежний: у объекта
 *   заполнена пара `objectId`/`objectName`, у отдела — своя, а `null` в чужой стороне пары стоит по
 *   устройству, а не по недосмотру;
 * - строка **обязана** приносить идентификаторы (`CostTargetSource`). Запрос, выбравший одни
 *   наименования, эту подпись больше не соберёт — и правильно: по имени «ПТО» нельзя ни отнести
 *   расходы, ни отличить два справочника. Типом это и ловится, а не молчанием: место, где ids не
 *   выбраны, перестаёт компилироваться, а не начинает показывать «—»;
 * - «—» остаётся ровно там, где был: заказчика нет ни одного (`costTargetOf` вернул `null`).
 *
 * Разойтись с прежним ответом эта пара может в одном-единственном случае: заказчик назван
 * идентификатором, а наименование не выбрано запросом. Раньше выходило «—», теперь — пустая
 * подпись (`costTargetOf` не выдумывает значения за невыбранную колонку). Состояние это
 * ненастоящее — колонки наименований в обоих справочниках `NOT NULL`, — и лечится оно там же, где
 * заводится: в запросе, который взял `id` и забыл про `name`.
 */
export function requestCustomerName(r: CostTargetSource): string {
  return costTargetOf(r)?.name ?? '—';
}

/**
 * Заказчик для колонки списка: что показать и что сказать наведением. Отдел в списке стоит кодом
 * («ПТО», «АХО») — так его называют в работе, и полное наименование отнимало бы у колонки строку,
 * ничего к узнаванию не добавляя. Объект, наоборот, узнают по наименованию: его код в заявках не
 * произносят вовсе.
 *
 * Отдельно от `requestCustomerName`: та подписывает окна и печатные формы, где место есть и
 * подсказки наведением не бывает, — сокращать там нечего.
 */
export function requestCustomerLabel(r: {
  objectName: string | null;
  departmentCode: string | null;
  departmentName: string | null;
}): { text: string; hint: string | null } {
  if (r.objectName) return { text: r.objectName, hint: null };
  // Код у отдела обязателен, но заявка могла прийти без отдела вовсе (объект тоже пуст только у
  // испорченной строки) — тогда показывать нечего, и колонка честно говорит «—».
  if (r.departmentCode) return { text: r.departmentCode, hint: r.departmentName };
  return { text: r.departmentName ?? '—', hint: null };
}

export interface VehicleRequestBaseDto {
  id: string;
  num: number;
  /** «ТС-123». */
  displayNumber: string;
  requestType: VehicleRequestType;

  /**
   * Заказчик заявки (ADR 0040): объект строительства **или** отдел — заполнена ровно одна пара.
   * Спрашивать «чья заявка» одним полем нельзя: у объекта есть код и адрес, у отдела их нет, и
   * общая колонка склеила бы две разные сущности. Подпись для показа даёт `requestCustomerName`.
   */
  objectId: string | null;
  objectCode: string | null;
  objectName: string | null;
  /**
   * Адрес объекта. Пусто — заказчик отдел либо адрес у объекта не заполнен: колонка справочника
   * необязательная. Показывают второй строкой к наименованию — «куда ехать» спрашивают у списка
   * заявок чаще всего, а своей колонки адрес не стоит: у заявок отдела она пустовала бы.
   */
  objectAddress: string | null;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  /**
   * Объект затрат: на кого относятся расходы по заявке (Р25) — разобранная пара выше, а не ещё
   * одно поле про заказчика. Едет в DTO готовым, потому что разбирают эту пару два десятка мест, и
   * каждое вольно решить иначе — где-то по имени, где-то по идентификатору, где-то с кодом; ветвь
   * же читается явно (`costTarget.kind === 'object'`), и ни одно место не забудет, что заказчиков
   * два рода.
   *
   * Колонкой он не хранится и здесь не снимок: сервер выводит его тем же `costTargetOf` из тех же
   * шести полей, которые лежат рядом. Пара остаётся на месте — по ней работают фильтры и ссылки на
   * справочники, — а `costTarget` отвечает на единственный вопрос учёта.
   *
   * `null` — заказчика нет ни одного. По базе такого не бывает (CHECK
   * `vehicle_requests_customer_check`), но DTO собирается запросом, и «строку прочитали до join» от
   * «заявки без заказчика» здесь не отличить; показывают это тем же «—» (`requestCustomerName`).
   *
   * Площадка отдела (ADR 0062) на него не влияет: заявку завёл отдел — затраты на отдел.
   */
  costTarget: CostTarget | null;

  /** Тип ТС (физически vehicle_requests.vehicle_type_id). Плоская модель (ADR 0005). */
  vehicleTypeId: string;
  vehicleTypeName: string;
  /**
   * Вид заказанного типа (ADR 0005) — граница замены (ADR 0059): заявку закрывают и машиной
   * соседнего типа, но чужого вида сервер не примет. Им же окно назначения спрашивает технику.
   */
  vehicleKindId: string;
  /**
   * Категория заказанного типа (ADR 0028). `null` — у типа категорий нет («Ямобур») либо заявка
   * заведена до появления колонки. Показывают одно из двух — см. `vehicleClassificationLabel`.
   */
  vehicleCategoryId: string | null;
  vehicleCategoryName: string | null;
  /**
   * Значения ТТХ заказанной категории (ADR 0016) — левая сторона сравнения «крупнее или меньше
   * заказанного» (`compareVehicleSize`). `null` — категории у заявки нет, сравнивать не с чем.
   */
  vehicleCategorySpecs: VehicleSpecValues | null;

  status: RequestStatus;
  comment: string;
  /** Причина отмены из истории статусов; заполнена только у отменённых заявок. */
  cancelReason: string | null;

  /**
   * Виза руководителя строительства (ADR 0025): кто согласовал заявку и когда. `null` — заявка
   * ждёт согласования, и взять её в работу нельзя. Имя хранится не снимком, а join'ом: виза
   * действует, пока не отозвана, и должна показывать текущее ФИО завизировавшего.
   */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /**
   * Техника, которой заявку взяли в работу (ADR 0027). `null` — заявку ещё не брали: у «Новой»
   * машины нет, а у закрытой и отменённой остаётся та, что была назначена.
   */
  assignment: VehicleRequestAssignmentDto | null;
  /**
   * Факт выполнения (ADR 0029). `null` — заявку не закрывали: у «Новой» и «В работе» его нет,
   * у отменённой не бывает вовсе, а у выполненной до этой версии его не восстановить.
   */
  completion: VehicleRequestCompletionDto | null;
  /**
   * Рейс, в котором заявка едет (маршруты). `null` — маршрута нет: у «Новой» его и не бывает, а
   * у грузоперевозки в работе на собственной машине это состояние, о котором список
   * предупреждает — заявку вынули из рейса или перенесли, и лист по ней не выпишется.
   */
  route: VehicleRequestRouteDto | null;
  files: FileDto[];
  version: number;

  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /**
   * Кто отправил заявку в архив (ADR 0070). Пусто у живой заявки и у архивной, чей автор удаления
   * не сохранился (`deleted_by` объявлен `ON DELETE SET NULL` — учётку могли снести насовсем).
   * Именем, а не только идентификатором: «кто удалил» — первый вопрос к строке архива, и ответ на
   * него не должен требовать второго запроса.
   */
  deletedByName: string | null;
}

/**
 * Строка недельной заявки, породившая заказ (ADR 0085 Р11, Р17). Основание у заказа ровно одно —
 * частичный `UNIQUE (created_request_id)` в базе держит именно это, — поэтому поле одиночное.
 *
 * Одной обратной ссылки на номер мало: форме перевода в работу нужны **значения** — просила ли
 * площадка доставку и откуда везти, — а не повод сходить за ними вторым запросом. Сам 4-П
 * выписывается там же, где и раньше, рейсом: недельная заявка бланков не выписывает.
 */
export interface VehicleRequestWeeklyOriginDto {
  weeklyRequestId: string;
  /** Число, а не «НЗ-12»: подпись собирает `formatWeeklyRequestNumber` — она одна на весь портал. */
  weeklyRequestNum: number;
  /** Строка состава: по ней неделю открывают ровно на том месте, откуда заказ взялся. */
  itemId: string;
  deliveryNeeded: boolean;
  deliveryFrom: string;
}

/**
 * Недельная заявка, которой срок заказа продлевали (ADR 0085 Р17). Списком, а не полем: один и тот
 * же заказ продлевается неделю за неделей, и одно поле «Основание» солгало бы на второй же неделе.
 */
export interface VehicleRequestWeeklyExtensionDto {
  weeklyRequestId: string;
  weeklyRequestNum: number;
  /** Понедельник продлённой недели; им же список и упорядочен — по порядку продлений. */
  weekStart: string;
}

export interface SpecialEquipmentRequestDto extends VehicleRequestBaseDto {
  requestType: 'special_equipment';
  dateFrom: string;
  dateTo: string | null;
  /**
   * Линейный ли заказанный тип (`vehicle_types.is_linear`, миграция 0127, ADR 0100): вечером
   * машина возвращается на базу и за день работает на нескольких объектах. Заказ такого типа
   * ведётся по дням, а недельные листы ЭСМ-2 портал сам не выписывает — их просят по требованию.
   *
   * Признак **заказанного типа**, а не назначенной машины: как заявка ведётся, решает заказ, а не
   * то, какую единицу под него нашли (ADR 0100 §1). Снимка в заявке нет — поле читается живым
   * join'ом, и смену признака у типа с заявками в работе сервер не разрешает.
   *
   * Поля нет у грузоперевозки, и это не экономия: она ездит рейсами при любом признаке типа —
   * ни листов ЭСМ-2, ни дней работы у неё не бывает вовсе, и отвечать там было бы не на что.
   *
   * Едет полем DTO, а не отдельным запросом за справочником: от него зависит, что карточка
   * показывает и чего не обещает форма перевода в работу. Сами выписанные листы карточка берёт
   * там же, где и раньше, — `GET /vehicle-requests/:id/waybills` (ADR 0041 п. 8).
   */
  isLinear: boolean;
  /**
   * Заявка застигнута переключением признака у типа и дорабатывает по прежнему режиму
   * (миграция 0137) — `null` у всех остальных, то есть почти всегда.
   *
   * Поле временное и уходит вместе с колонками снимка, но пока оно есть, его показывают: без
   * метки диспетчер видит две заявки одного типа, ведущие себя по-разному, и ни одного
   * объяснения на экране. Полем `isLinear` тут не обойтись — оно отвечает «как ведётся», а метке
   * нужно ещё «почему» и «с какого числа»:
   *
   * - `isLinear` внутри — режим, записанный переключением: `false` — по неделям, `true` — по дням;
   *   ровно он и лежит в `isLinear` заявки, пока снимок жив;
   * - `at` — когда переключение случилось.
   */
  linearFrozen: { isLinear: boolean; at: string } | null;
  /** Кто встречает технику на объекте; пусто — заявка заведена до миграции 0062. */
  responsibleName: string;
  responsiblePhone: string;
  /**
   * Досрочное завершение (ADR 0044): ожидающий визы запрос либо последнее решение по нему.
   * `null` — срок заявки не сокращали. Поля нет у грузоперевозки: сокращать там нечего — у неё
   * не период, а момент подачи.
   */
  earlyEnd: VehicleRequestEarlyEndDto | null;
  /**
   * Сводка подтверждения смен: сколько дней принято объектом и сколько прошедших дней ещё ждёт
   * подписи. Едет в каждой строке, потому что от неё зависят три правила сразу — закрытие
   * заявки, смена машины и предупреждение в срезе «На объекте». Сами смены отдаёт отдельная
   * ручка: в списке они не нужны, а в карточке их читают целиком.
   */
  shifts: VehicleRequestShiftsSummaryDto;
  /**
   * Откуда заказ появился и что просила недельная заявка (ADR 0085 Р11): `null` — заказ завели
   * обычной формой. Полей нет у грузоперевозки: неделя её не касается вовсе — у грузоперевозки не
   * период работ, а момент подачи, и `sourceItemBlocker` не пускает такой заказ в состав.
   */
  weeklyOrigin: VehicleRequestWeeklyOriginDto | null;
  /**
   * Недельные заявки, которыми срок продлевали (ADR 0085 Р17): у одного заказа их бывает несколько.
   * Пусто — недельной заявкой заказ не продлевали.
   */
  weeklyExtensions: VehicleRequestWeeklyExtensionDto[];
  /**
   * Машина дня у линейного заказа в срезе «На объекте» (ADR 0100 §12). Поля нет вовсе, когда
   * выдача не про конкретный день (список, лента, журнал) либо заказ не линейный: там машина
   * строки — назначенная, и второго ответа на этот вопрос не существует. `null` — линейный заказ,
   * чей день среза не распланирован: показывать нечего, и говорится об этом словами
   * (`ON_SITE_DAY_UNPLANNED_MESSAGE`), а не машиной по умолчанию.
   */
  dayVehicle?: VehicleOnSiteDayVehicleDto | null;
  /**
   * Дни заказа, отработанные машиной из фильтра `vehicleId` (ADR 0100 §12, ADR 0098). Заполняется
   * только при отборе по машине и только у линейного заказа — у прочих заявок дней не бывает
   * вовсе, и отвечать там нечем.
   *
   * Поле есть ради одного: заявка теперь находится по машине, **которой на ней не назначено**, и
   * без этих дней строка выглядит ошибкой отбора — в колонке техники стоит другой госномер. Дни, а
   * не голый признак «совпало по дню»: вопрос к парку звучит «где ходила ТС-341», и ответ «по
   * заказу ТС-15, 12-го и 14-го» отвечает на него целиком, а «да» — только наполовину.
   *
   * Пусто при заданном фильтре — совпало назначение, то самое поведение, что было до ADR 0100.
   */
  matchedDays?: string[];
}

export interface FreightTransportRequestDto extends VehicleRequestBaseDto {
  requestType: 'freight_transport';
  /**
   * Момент **первой** подачи (Р3): им считается дата маршрута, по нему работают фильтры и рабочее
   * окно. У ездки бывает своё время — уточняющее, внутри этого же дня (Р18).
   */
  scheduledAt: string;
  /** Время подачи не задано — в `scheduledAt` значима только дата (00:00 МСК). */
  scheduledTimeUnspecified: boolean;
  /**
   * Ездки заявки (Р1, Р2) — то, что прежде лежало парой адресов, количеством и контактами самой
   * заявки. Их не бывает ноль: заявка заводится хотя бы с одной, а последнюю снять нечем.
   *
   * Мягко удалённые (Р13а) сюда **не приходят вовсе**: карточка показывает то, что едет сейчас, а
   * помнить, что именно напечатано, — дело журнала листов и истории. Поэтому суммировать их можно
   * без оглядки: `requestCargoTotal(r.trips)` даёт «60 м³ · 6 ездок», `tripCargoLabel` подписывает
   * строку тем же правилом, каким её печатает бланк.
   *
   * Порядок — по `num`, то есть по тому, как ездки заводили; первая из них и стоит в колонках
   * списка (§9). Порядок объезда здесь не выражен и выражен быть не может: он принадлежит рейсу, а
   * не заказу, и приходит в ездке раскладкой (`placement`).
   */
  trips: VehicleRequestTripDto[];
}

export type VehicleRequestDto = SpecialEquipmentRequestDto | FreightTransportRequestDto;

// ── История заявки (ADR 0012, ADR 0015) ──
// События описаны в `request-history.ts` — форма у обоих модулей заявок одна. Своё здесь только
// подписи полей.

/**
 * Подписи полей в истории; ключи проставляет сервер при вычислении изменений. Поля обоих типов
 * заявки лежат в одном словаре: у переоформления (ADR 0091) в одном событии стоят поля обеих
 * деталей — одни уходят в прочерк, другие из прочерка появляются, — а читателю истории и вовсе
 * всё равно, из какой detail-таблицы пришло значение.
 */
export const vehicleRequestChangeLabels: Record<string, string> = {
  object: 'Объект',
  // Переоформление в другой тип (ADR 0091). Пара «было → стало» здесь главная строка события:
  // без неё срок работ в истории сменялся бы моментом подачи будто сам собой.
  requestType: 'Тип заявки',
  // Заказанная позиция классификатора — одной строкой (ADR 0028): смена категории внутри типа
  // и смена самого типа для читателя истории одно и то же событие — «заказали другое».
  vehicleType: 'Тип/категория',
  dateFrom: 'Дата начала',
  dateTo: 'Дата окончания',
  scheduledAt: 'Подача',
  // ── Поля, уехавшие с заявки на ездку (Р2, §5.7) ──
  // В новых событиях эти ключи не появляются: адресов, количества и контактов у заявки больше нет.
  // Читаются они у старых — история говорит, что было, и пересчитать её нельзя. Убери их отсюда —
  // и правка заявки, сделанная до миграции `0136`, покажется списком изменений без подписей
  // (`labels[c.field] ?? c.field` в `RequestHistory.tsx` напечатает сырой ключ).
  volumeM3: 'Объём',
  weightTons: 'Масса',
  loadingLocation: 'Место погрузки',
  unloadingLocation: 'Место разгрузки',
  // Контакт ответственного (миграция 0062): у заявки на объект один, у грузоперевозки — по одному
  // на каждом конце маршрута. Ключи разные, потому что и правки это разные события.
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  loadingResponsibleName: 'Ответственный за погрузку',
  loadingResponsiblePhone: 'Телефон ответственного за погрузку',
  unloadingResponsibleName: 'Ответственный за разгрузку',
  unloadingResponsiblePhone: 'Телефон ответственного за разгрузку',
  // ── Правка ездок (Р1, §5.7) ──
  // Ключ один на все ездки заявки, а **номер ездки живёт в значении** («2 · Карьер Сычёво» →
  // «2 · Полигон»). Иначе никак: словарь подписей фиксирован, а ключ вида `trip.2.from` подписи не
  // нашёл бы и встал в историю сырой строкой. Двум строкам с одним ключом это не мешает — события
  // складываются списком, и правка двух ездок читается двумя строками подряд.
  //
  // Точка в имени — «поле ездки»; события самого списка (`tripAdded`, `tripRemoved`) её не несут:
  // они про состав заявки, и по форме это те же события-списки, что `filesAdded`/`filesRemoved`.
  'trip.from': 'Место погрузки ездки',
  'trip.to': 'Место разгрузки ездки',
  // Объём и масса разными ключами, как и у заявки: это разные единицы, а не разные значения одной.
  'trip.volume': 'Объём ездки',
  'trip.weight': 'Масса ездки',
  'trip.fromResponsibleName': 'Ответственный за погрузку ездки',
  'trip.fromResponsiblePhone': 'Телефон ответственного за погрузку ездки',
  'trip.toResponsibleName': 'Ответственный за разгрузку ездки',
  'trip.toResponsiblePhone': 'Телефон ответственного за разгрузку ездки',
  // Своё время подачи ездки (Р3): пустое значение — «как у заявки», и в истории это читается
  // прочерком, а не «время сняли».
  'trip.scheduledAt': 'Подача ездки',
  // Примечание к ездке («песок, звонить за час»): в бланке оно отбрасывается первым (Р11а), но в
  // задании водителю печатается целиком — значит и правка его событие, а не оформление.
  'trip.comment': 'Примечание к ездке',
  tripAdded: 'Добавлены ездки',
  tripRemoved: 'Удалены ездки',
  comment: 'Комментарий',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Откреплены файлы',
  // Назначение техники (ADR 0027): событие не правки, но поля у него те же по форме — «было →
  // стало», и в истории они читаются одним списком.
  vehicle: 'Техника',
  pricePerHour: 'Ставка за час',
  pricePerShift: 'Ставка за смену',
  shiftHours: 'Часов в смене',
  // Факт выполнения (ADR 0029): им заявка и закрывается, поэтому его поля читаются в истории
  // тем же списком «было → стало» — повторное закрытие после отката правит и время, и сумму.
  worked: 'Отработано',
  rate: 'Ставка закрытия',
  totalCost: 'Стоимость',
  // Досрочное завершение (ADR 0044). Запрошенный срок — отдельным ключом от `dateTo`: пока визы
  // нет, срок заявки не менялся, и «Дата окончания: 28.07 → 24.07» в событии запроса читалось бы
  // как состоявшееся сокращение. Согласование меняет сам `dateTo` и пишется уже им.
  // Продление недельной заявкой (ADR 0085): номером пакета читатель истории отвечает на вопрос
  // «чьим решением сдвинулся срок» — сам сдвиг стоит рядом обычной парой «было → стало».
  weeklyRequest: 'Недельная заявка',
  earlyEndDate: 'Досрочно до',
  // Одна подпись на три события: причину называют и в запросе, и в отказе, и при снятии — а что
  // именно произошло, сказано названием самого события.
  earlyEndReason: 'Причина',
  // Подтверждение смен: событие несёт день и то, что за него приняли, — одной строкой
  // («12.08 · 08:00–20:00 · 11,5 ч»). Заполнение часов события не пишет: это черновик данных,
  // который правят по нескольку раз в день, а решение здесь — подпись объекта.
  shift: 'Смена',
  // Заявку закрыли, не дождавшись подписи объекта под всеми прошедшими днями. Пометка у события
  // закрытия, а не отдельное событие: закрытие одно, и «чем закрыли» и «что при этом осталось
  // неподтверждённым» читаются вместе.
  shiftsPending: 'Смены без согласования',
};
