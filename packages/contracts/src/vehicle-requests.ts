import { z } from 'zod';
import {
  requestStatusLabels,
  requestStatusSchema,
  statusChangeRequiresReason,
  vehicleRequestTypeSchema,
  type VehicleRequestType,
} from './enums';
import type { RequestStatus } from './enums';
import { allowedStatusTransitions, type AccessSubject } from './permissions';
import {
  baseListQuery,
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  uuidSchema,
} from './common';
import type { FileDto } from './files';
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
  type VehicleRequestRouteDto,
} from './vehicle-routes';
import type { WaybillFormCode } from './waybills';
import {
  MIN_REQUEST_DATE_MESSAGE,
  WORK_TIME_MESSAGE,
  isAllowedRequestDate,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
  shiftDateKey,
} from './time';
import type { VehicleRequestShiftsSummaryDto } from './vehicle-request-shifts';

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
    /** Заказчик: переданный объект снимает отдел и наоборот — их всегда ровно один (ADR 0040). */
    objectId: uuidSchema.optional(),
    departmentId: uuidSchema.optional(),
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
      // Переданный заказчик заменяет прежнего целиком; двое сразу невозможны (ADR 0040).
      if (v.objectId != null && v.departmentId != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectId'],
          message: 'Заказчик один: объект либо отдел',
        });
      }
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
 * Статусы, доступные субъекту из текущего — с поправкой на визу. Правило одно на портал и API:
 * список переходов в интерфейсе не должен предлагать то, что сервер отклонит.
 */
export function allowedVehicleRequestTransitions(
  from: RequestStatus,
  subject: AccessSubject,
  approved: boolean,
): RequestStatus[] {
  const transitions = allowedStatusTransitions(from, subject);
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
     */
    delivery: createRelocationRouteSchema.omit({ purpose: true }).optional(),
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
  if (request.status !== 'confirmed' || !request.assignment || request.deletedAt) return false;
  // Подтверждённая смена запирает машину: за подписью объекта стоит работа конкретной техники,
  // и подмена задним числом превратила бы её в подпись под чужими часами (`approvedShiftsBlocker`).
  return (request.shifts?.approvedDays ?? 0) === 0;
}

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
  })
  .strict();
export type ChangeVehicleAssignmentInput = z.infer<typeof changeVehicleAssignmentSchema>;
export type ChangeVehicleAssignmentBody = z.input<typeof changeVehicleAssignmentSchema>;

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
  /** Заказчик со стороны офиса (ADR 0040): фильтр «заявки этого отдела». */
  departmentId: uuidSchema.optional(),
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
  /**
   * Сколько машин ждёт визы на досрочный отъезд (ADR 0044). Пятая цифра здесь по той же причине,
   * что и две предыдущие: площадку освобождают по ней, а по статусу заявки это не видно — она
   * всё ещё «В работе» на весь заказанный срок.
   */
  earlyEndPending: number;
  /**
   * Сколько заявок среза ждёт согласования смен — то есть по скольким работа ещё не принята
   * объектом. Цифра долга, а не сегодняшнего дня: пока она не ноль, эти заявки не закроются, и
   * часть из них уже отработала свой срок.
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
  // решения, а долг, из-за которого заявка не закроется.
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
 */
export function requestCustomerName(r: {
  objectName: string | null;
  departmentName: string | null;
}): string {
  return r.objectName ?? r.departmentName ?? '—';
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
}

export interface SpecialEquipmentRequestDto extends VehicleRequestBaseDto {
  requestType: 'special_equipment';
  dateFrom: string;
  dateTo: string | null;
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
  // Досрочное завершение (ADR 0044). Запрошенный срок — отдельным ключом от `dateTo`: пока визы
  // нет, срок заявки не менялся, и «Дата окончания: 28.07 → 24.07» в событии запроса читалось бы
  // как состоявшееся сокращение. Согласование меняет сам `dateTo` и пишется уже им.
  earlyEndDate: 'Досрочно до',
  // Одна подпись на три события: причину называют и в запросе, и в отказе, и при снятии — а что
  // именно произошло, сказано названием самого события.
  earlyEndReason: 'Причина',
  // Подтверждение смен: событие несёт день и то, что за него приняли, — одной строкой
  // («12.08 · 08:00–20:00 · 11,5 ч»). Заполнение часов события не пишет: это черновик данных,
  // который правят по нескольку раз в день, а решение здесь — подпись объекта.
  shift: 'Смена',
};
