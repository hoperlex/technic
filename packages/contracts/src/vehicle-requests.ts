import { z } from 'zod';
import { requestStatusSchema, statusChangeRequiresReason } from './enums';
import type { RequestStatus, Role } from './enums';
import { allowedStatusTransitions } from './permissions';
import { baseListQuery, contactNameSchema, contactPhoneSchema, uuidSchema } from './common';
import type { FileDto } from './files';
import {
  shiftHoursSchema,
  vehicleLabel,
  type VehicleOwnership,
  vehiclePriceSchema,
} from './vehicles';
import {
  MIN_REQUEST_DATE_MESSAGE,
  WORK_TIME_MESSAGE,
  isAllowedRequestDate,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
} from './time';

// ── Тип заявки на технику ──
export const VEHICLE_REQUEST_TYPES = ['special_equipment', 'freight_transport'] as const;
export const vehicleRequestTypeSchema = z.enum(VEHICLE_REQUEST_TYPES);
export type VehicleRequestType = (typeof VEHICLE_REQUEST_TYPES)[number];

export const vehicleRequestTypeLabels: Record<VehicleRequestType, string> = {
  special_equipment: 'Техника для работы на объекте',
  freight_transport: 'Грузоперевозка',
};

export const vehicleRequestTypeColors: Record<VehicleRequestType, string> = {
  special_equipment: 'geekblue',
  freight_transport: 'green',
};

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

// ── Общие подсхемы ──
const commentSchema = z.string().trim().max(2000);
const locationSchema = z.string().trim().min(1).max(1000);
const fileIdsSchema = z.array(uuidSchema).max(20);

// ── Адрес: метаданные верификации (DaData «Подсказки») ──
// Каноническая строка адреса — в loadingLocation/unloadingLocation; здесь происхождение
// и ФИАС/гео. Жёсткая модель (ADR 0006): адрес погрузки/разгрузки ОБЯЗАТЕЛЕН и должен быть
// верифицирован (resolved+ФИАС либо object); неверифицированный/`manual` ввод на запись НЕ
// принимается. `manual` остаётся в enum только для чтения легаси-строк.
export const ADDRESS_SOURCES = ['resolved', 'manual', 'object'] as const;
export const addressSourceSchema = z.enum(ADDRESS_SOURCES);
export type AddressSource = (typeof ADDRESS_SOURCES)[number];

/** Метаданные адреса. `fiasId` — не строго UUID (DaData отдаёт разные GUID), поэтому просто строка. */
export const addressMetaSchema = z
  .object({
    source: addressSourceSchema,
    fiasId: z.string().trim().min(1).max(64).nullable().optional(),
    fiasLevel: z.number().int().min(-1).max(99).nullable().optional(),
    geoLat: z.number().min(-90).max(90).nullable().optional(),
    geoLon: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict();
export type AddressMeta = z.infer<typeof addressMetaSchema>;

/** Адрес верифицирован: выбран из справочника объектов или из подсказок DaData (с ФИАС). */
export function isAddressVerified(meta: AddressMeta | null | undefined): boolean {
  if (!meta) return false;
  return meta.source === 'object' || (meta.source === 'resolved' && !!meta.fiasId);
}

/**
 * Верифицированный адрес для записи (жёсткая модель, ADR 0006): принимаем только адрес,
 * выбранный из подсказки DaData (resolved + ФИАС) либо из справочника объектов (object).
 */
export const verifiedAddressMetaSchema = addressMetaSchema.refine(isAddressVerified, {
  message: 'Адрес должен быть выбран из подсказок (верифицирован)',
});

/** Дата без времени, строго YYYY-MM-DD (не преобразуется через JS Date). */
const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
  .refine((s) => {
    const parts = s.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Некорректная дата');

/** ISO 8601 с обязательным offset (напр. 2026-07-25T14:30:00+03:00). */
const scheduledAtSchema = z.string().datetime({ offset: true });

/** Положительное значение с не более чем 3 знаками после запятой (numeric(12,3)). */
const amountSchema = z
  .number()
  .positive('Значение должно быть больше 0')
  .max(999_999_999.999, 'Слишком большое значение')
  .refine(
    (v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6,
    'Не более 3 знаков после запятой',
  );

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
  })
  .strict();

export const createFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    objectId: uuidSchema,
    vehicleTypeId: uuidSchema,
    vehicleCategoryId: uuidSchema.nullish(),
    scheduledAt: scheduledAtSchema,
    /**
     * Время подачи не задано: `scheduledAt` несёт только дату (00:00 МСК), рабочее окно
     * не проверяется. Дата и время в БД остаются одним timestamptz.
     */
    scheduledTimeUnspecified: z.boolean().optional().default(false),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema,
    unloadingLocation: locationSchema,
    loadingAddress: verifiedAddressMetaSchema,
    unloadingAddress: verifiedAddressMetaSchema,
    /**
     * Контакт на каждом конце маршрута, а не один на заявку: грузят и принимают разные люди в
     * разных местах, и водителю нужен тот, кто откроет ворота именно здесь. Оба обязательны —
     * рейс без контакта на разгрузке заканчивается простоем у закрытой площадки.
     */
    loadingResponsibleName: contactNameSchema,
    loadingResponsiblePhone: contactPhoneSchema,
    unloadingResponsibleName: contactNameSchema,
    unloadingResponsiblePhone: contactPhoneSchema,
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
  })
  .strict();

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
      // Новую заявку заводят не раньше чем на сегодня (по МСК). Конец периода проверять
      // отдельно не нужно: он не раньше начала.
      if (!isAllowedRequestDate(v.dateFrom)) {
        ctx.addIssue({ code: 'custom', path: ['dateFrom'], message: MIN_REQUEST_DATE_MESSAGE });
      }
    } else {
      if (v.volumeM3 == null && v.weightTons == null) {
        ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём или массу' });
      }
      if (!v.scheduledTimeUnspecified && !isWithinWorkTimeAt(new Date(v.scheduledAt))) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
      if (!isAllowedRequestDateAt(new Date(v.scheduledAt))) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: MIN_REQUEST_DATE_MESSAGE });
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

// ── Обновление (discriminatedUnion; requestType неизменяем — сверяется backend) ──
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
  })
  .strict();

export const updateFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    version: z.number().int().nonnegative(),
    objectId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    scheduledAt: scheduledAtSchema.optional(),
    // Передаётся вместе со `scheduledAt` — рабочее окно проверяется только при заданном времени.
    scheduledTimeUnspecified: z.boolean().optional(),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema.optional(),
    unloadingLocation: locationSchema.optional(),
    loadingAddress: verifiedAddressMetaSchema.optional(),
    unloadingAddress: verifiedAddressMetaSchema.optional(),
    loadingResponsibleName: contactNameSchema.optional(),
    loadingResponsiblePhone: contactPhoneSchema.optional(),
    unloadingResponsibleName: contactNameSchema.optional(),
    unloadingResponsiblePhone: contactPhoneSchema.optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
  })
  .strict();

export const updateVehicleRequestSchema = z
  .discriminatedUnion('requestType', [
    updateSpecialEquipmentRequestSchema,
    updateFreightTransportRequestSchema,
  ])
  .superRefine((v, ctx) => {
    // Жёсткая модель (ADR 0006): строка адреса и его метаданные передаются вместе.
    if (v.requestType === 'freight_transport') {
      if ((v.loadingLocation === undefined) !== (v.loadingAddress === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['loadingAddress'],
          message: 'Адрес и строка погрузки передаются вместе',
        });
      }
      if ((v.unloadingLocation === undefined) !== (v.unloadingAddress === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unloadingAddress'],
          message: 'Адрес и строка разгрузки передаются вместе',
        });
      }
      if (
        v.scheduledAt !== undefined &&
        v.scheduledTimeUnspecified !== true &&
        !isWithinWorkTimeAt(new Date(v.scheduledAt))
      ) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
    }
  });
export type UpdateVehicleRequestInput = z.infer<typeof updateVehicleRequestSchema>;

// ── Виза руководителя строительства (ADR 0025) ──

/**
 * Переход, требующий визы: незавизированную заявку нельзя взять в работу. Отмена визы не
 * требует — заявку, которую не согласовали, закрывают именно отменой.
 */
export function transitionRequiresApproval(to: RequestStatus): boolean {
  return to === 'confirmed';
}

/**
 * Статусы, доступные роли из текущего — с поправкой на визу. Правило одно на портал и API:
 * список переходов в интерфейсе не должен предлагать то, что сервер отклонит.
 */
export function allowedVehicleRequestTransitions(
  from: RequestStatus,
  role: Role,
  approved: boolean,
): RequestStatus[] {
  const transitions = allowedStatusTransitions(from, role);
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
export const assignVehicleSchema = z
  .object({
    vehicleId: uuidSchema,
    pricePerHour: vehiclePriceSchema.nullable().optional(),
    pricePerShift: vehiclePriceSchema.nullable().optional(),
    /** Длительность смены: без неё цена за смену — сумма без единицы измерения. */
    shiftHours: shiftHoursSchema.nullable().optional(),
  })
  .strict();
export type AssignVehicleInput = z.infer<typeof assignVehicleSchema>;

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
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
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

// ── Список ──
/**
 * Поля сортировки списка; ключ столбца таблицы совпадает с именем поля. Полей здесь больше,
 * чем столбцов: `requestType`, `createdByName`, `amount` и адреса в строку списка не вынесены
 * (тип заявки и автор — вторыми строками к типу ТС и номеру, объём/масса и адреса — только в
 * карточке), но сортировка по ним остаётся частью API.
 * `term` и `amount` — общие для обоих типов заявки: срок и «объём/масса» лежат в разных
 * detail-таблицах, поэтому сервер сводит их одним выражением.
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
  // Столбцы журнала закрытых заявок (вкладка «История», ADR 0029): чья машина и во сколько
  // обошлась. В списке заявок этих столбцов нет, но поля сортировки общие — запрос один.
  'lessorName',
  'totalCost',
  'completedAt',
] as const;

export const vehicleRequestListQuerySchema = baseListQuery(VEHICLE_REQUEST_SORT_FIELDS).extend({
  // Необязателен: раздел «Заказ автотехники» — единый список обоих типов.
  // Задан — список сужается до одного типа (фильтр в интерфейсе, вкладка «На объекте»).
  requestType: vehicleRequestTypeSchema.optional(),
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  // Категория задаётся вместе с типом (позиция классификатора выбирается целиком, ADR 0028):
  // одна категория принадлежит одному типу, и фильтр по ней сужает список до неё.
  vehicleCategoryId: uuidSchema.optional(),
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
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * Журнал закрытых заявок (вкладка «История», ADR 0029). Тот же список, суженный до состоявшегося:
 * «Выполнена» и «Отменена». Своё здесь — арендодатель: в журнале читают не только «что заказывали»,
 * но и «у кого брали», а по одному арендодателю сводят и расходы.
 *
 * `status` наследуется от общей схемы и сужает журнал до одного из двух закрытых статусов;
 * остальные сервер отклоняет — открытая заявка историей ещё не стала.
 */
export const vehicleRequestHistoryQuerySchema = vehicleRequestListQuerySchema.extend({
  lessorId: uuidSchema.optional(),
});
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
 * Фильтры вкладки — объект и заказанная позиция классификатора (ADR 0028). Ни статуса, ни типа
 * заявки, ни дат здесь нет: они этот список не сужают, а определяют. Схема своя, а не `pick` от
 * списочной, именно поэтому: от `dateFrom` в общей схеме клиент вправе ждать, что тот сработает,
 * — здесь он не сработает никогда.
 */
export const vehicleRequestOnSiteQuerySchema = baseListQuery(VEHICLE_ON_SITE_SORT_FIELDS).extend({
  objectId: uuidSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  vehicleCategoryId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
});
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
 * Итог среза: сколько единиц техники сейчас на объектах и на скольких объектах, сколько вышло
 * сегодня и сколько уезжает. Последние две цифры — то, ради чего вкладку открывают утром: и
 * приёмка машины, и освобождение площадки планируются именно по ним.
 */
export interface VehicleOnSiteSummaryDto {
  total: number;
  objects: number;
  arrivedToday: number;
  leavingToday: number;
}

/**
 * Как строка стоит в сегодняшнем дне: `single` — заявка на один день (вышла и уедет), `arrives` —
 * первый день периода, `leaves` — последний, `ongoing` — середина срока.
 *
 * Пустая дата окончания — однодневный срок: тем же `coalesce(date_to, date_from)` сервер ищет
 * пересечение периодов, и подпись обязана читать срок так же, как отбор.
 */
export type VehicleOnSitePresence = 'single' | 'arrives' | 'leaves' | 'ongoing';

export function onSitePresence(
  r: { dateFrom: string; dateTo: string | null },
  onDate: string,
): VehicleOnSitePresence {
  const last = r.dateTo || r.dateFrom;
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
};

/** Цвет тега присутствия: выделены дни выхода и отъезда — по ним и планируют площадку. */
export const vehicleOnSitePresenceColors: Record<VehicleOnSitePresence, string> = {
  single: 'purple',
  arrives: 'blue',
  leaves: 'orange',
  ongoing: 'default',
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
 * объект, тип заявки и заказанная техника: цифры относятся к тому же списку, что человек видит
 * перед собой. Фильтр по статусу свёл бы сводку к самой себе, а по номеру — к одной заявке.
 */
export const vehicleRequestSummaryQuerySchema = z.object({
  objectId: uuidSchema.optional(),
  requestType: vehicleRequestTypeSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  vehicleCategoryId: uuidSchema.optional(),
});
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
  /** Тип ТС машины; совпадает с типом заявки — это держит составной FK в БД. */
  typeName: string;
  categoryName: string | null;
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

export interface VehicleRequestBaseDto {
  id: string;
  num: number;
  /** «ТС-123». */
  displayNumber: string;
  requestType: VehicleRequestType;

  objectId: string;
  objectCode: string;
  objectName: string;

  /** Тип ТС (физически vehicle_requests.vehicle_type_id). Плоская модель (ADR 0005). */
  vehicleTypeId: string;
  vehicleTypeName: string;
  /**
   * Категория заказанного типа (ADR 0028). `null` — у типа категорий нет («Ямобур») либо заявка
   * заведена до появления колонки. Показывают одно из двух — см. `vehicleClassificationLabel`.
   */
  vehicleCategoryId: string | null;
  vehicleCategoryName: string | null;

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
  files: FileDto[];
  version: number;

  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SpecialEquipmentRequestDto extends VehicleRequestBaseDto {
  requestType: 'special_equipment';
  dateFrom: string;
  dateTo: string | null;
  /** Кто встречает технику на объекте; пусто — заявка заведена до миграции 0062. */
  responsibleName: string;
  responsiblePhone: string;
}

export interface FreightTransportRequestDto extends VehicleRequestBaseDto {
  requestType: 'freight_transport';
  scheduledAt: string;
  /** Время подачи не задано — в `scheduledAt` значима только дата (00:00 МСК). */
  scheduledTimeUnspecified: boolean;
  volumeM3: number | null;
  weightTons: number | null;
  loadingLocation: string;
  unloadingLocation: string;
  /** Метаданные верификации адреса погрузки (null = не верифицирован / введён вручную). */
  loadingAddress: AddressMeta | null;
  /** Метаданные верификации адреса разгрузки. */
  unloadingAddress: AddressMeta | null;
  /** Контакты на концах маршрута; пусто — заявка заведена до миграции 0062. */
  loadingResponsibleName: string;
  loadingResponsiblePhone: string;
  unloadingResponsibleName: string;
  unloadingResponsiblePhone: string;
}

export type VehicleRequestDto = SpecialEquipmentRequestDto | FreightTransportRequestDto;

// ── История заявки (ADR 0012, ADR 0015) ──
// События описаны в `request-history.ts` — форма у обоих модулей заявок одна. Своё здесь только
// подписи полей: тип заявки неизменяем, поэтому набор полей у правки известен заранее.

/**
 * Подписи полей в истории; ключи проставляет сервер при вычислении изменений. Поля обоих типов
 * заявки лежат в одном словаре: правка не может сменить тип, а читателю истории всё равно, из
 * какой detail-таблицы пришло значение.
 */
export const vehicleRequestChangeLabels: Record<string, string> = {
  object: 'Объект',
  // Заказанная позиция классификатора — одной строкой (ADR 0028): смена категории внутри типа
  // и смена самого типа для читателя истории одно и то же событие — «заказали другое».
  vehicleType: 'Тип/категория',
  dateFrom: 'Дата начала',
  dateTo: 'Дата окончания',
  scheduledAt: 'Подача',
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
};
