import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';

// ── Путевой лист (ADR 0037) ──
// Лист — документ строгой отчётности: серия, номер, журнал учёта. Черновика у него нет: он
// рождается переводом заявки в работу сразу выданным, а испорченный бланк аннулируют с причиной.

export const WAYBILL_STATUSES = ['issued', 'cancelled'] as const;
export const waybillStatusSchema = z.enum(WAYBILL_STATUSES);
export type WaybillStatus = (typeof WAYBILL_STATUSES)[number];

export const waybillStatusLabels: Record<WaybillStatus, string> = {
  issued: 'Выдан',
  cancelled: 'Аннулирован',
};

export const waybillStatusColors: Record<WaybillStatus, string> = {
  issued: 'green',
  cancelled: 'red',
};

/**
 * Бланки. Сейчас выписывается один — 4-П на грузоперевозки; остальные объявлены, потому что
 * расширение области должно быть значением в справочнике, а не второй схемой (ADR 0037).
 */
export const WAYBILL_FORM_CODES = ['4p', 'leg3', 'esm2'] as const;
export const waybillFormCodeSchema = z.enum(WAYBILL_FORM_CODES);
export type WaybillFormCode = (typeof WAYBILL_FORM_CODES)[number];

export const waybillFormLabels: Record<WaybillFormCode, string> = {
  '4p': 'Форма 4-П (грузовой автомобиль)',
  leg3: 'Форма № 3 (легковой автомобиль)',
  esm2: 'Форма ЭСМ-2 (строительная машина)',
};

/** Номер бланка с ведущими нулями: «00000004897» при ширине 8 и больше. */
export function formatWaybillNumber(num: number, width: number): string {
  return String(num).padStart(width, '0');
}

/**
 * Как лист называют в журнале и в разговоре: «260604-646-00000004897». Без серии остаётся один
 * номер — префикс печатается в своей графе бланка и у новых серий пуст, пока его не задали.
 */
export function waybillDisplayNumber(prefix: string, num: number, width: number): string {
  return `${prefix}${formatWaybillNumber(num, width)}`;
}

/**
 * Ключи снимка — они же плейсхолдеры бланка. Объявлены списком, а не выводятся из кода сборки:
 * по нему тест сверяет шаблон, и графа, которой в снимке нет, не доедет до бумаги молча
 * (ADR 0037 п. 10).
 */
export const WAYBILL_SNAPSHOT_KEYS = [
  'org_name',
  'org_address',
  'org_phone',
  'org_okpo',
  'org_ogrn',
  'waybill_series',
  'waybill_number',
  'waybill_date',
  'vehicle_brand',
  'vehicle_reg_number',
  'vehicle_garage_number',
  'vehicle_inventory_number',
  'trailer1_brand',
  'trailer1_reg_number',
  'trailer2_brand',
  'trailer2_reg_number',
  'driver_fio',
  'driver_snils',
  'driver_personnel_no',
  'driver_license_number',
  'driver_license_issued_on',
  'communication_kind',
  'transportation_kind',
  'customer_name',
  'customer_address',
  'task_from',
  'task_to',
  'task_cargo',
  'task_departure_time',
  'dispatcher_fio',
] as const;

export type WaybillSnapshotKey = (typeof WAYBILL_SNAPSHOT_KEYS)[number];

// ── Журнал учёта (ADR 0037) ──
// Лист — бланк строгой отчётности: журнал отвечает, какие номера выданы, на какие машины и что
// с ними стало. Аннулированные из него не исчезают — пропуск в нумерации означал бы утраченный
// бланк, а не отменённый рейс.

export interface WaybillRequestLinkDto {
  requestId: string;
  /** «ТС-501» — номер заявки, как его читают в портале. */
  displayNumber: string;
  /** Талон заказчика, 1–4: столько их держит бланк 4-П. */
  slot: number;
  objectName: string;
}

export interface WaybillDto {
  id: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  formCode: WaybillFormCode;
  status: WaybillStatus;
  /** День, на который выписан лист, и граница его правки. */
  issuedForDate: string;
  organizationName: string;
  vehicleId: string;
  /** «КамАЗ 65201 · Е646СК799» — чем именно ехали. */
  vehicleLabel: string;
  driverPersonId: string;
  driverName: string;
  withTrailer: boolean;
  trailerLabel: string;
  issuedByName: string;
  issuedAt: string;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string;
  /** Заявки, которые машина выполняет по этому листу — талоны заказчиков. */
  requests: WaybillRequestLinkDto[];
}

export const WAYBILL_SORT_FIELDS = ['issuedForDate', 'number', 'issuedAt'] as const;

export const waybillListQuerySchema = baseListQuery(WAYBILL_SORT_FIELDS).extend({
  /** Период выдачи: журнал читают по дням, а не по всей истории сразу. */
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  vehicleId: uuidSchema.optional(),
  driverPersonId: uuidSchema.optional(),
  status: waybillStatusSchema.optional(),
});
export type WaybillListQuery = z.infer<typeof waybillListQuerySchema>;

/**
 * Аннулирование листа. Причина обязательна: испорченный бланк списывают, и в журнале должно быть
 * видно, почему номер не ушёл в рейс.
 */
export const cancelWaybillSchema = z
  .object({ reason: z.string().trim().min(1, 'Укажите причину').max(2000) })
  .strict();
export type CancelWaybillInput = z.infer<typeof cancelWaybillSchema>;

/**
 * Можно ли ещё аннулировать лист (ADR 0037 п. 9). До даты выезда — да; в день выезда и позже —
 * нет: бланк уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи.
 */
export function isWaybillEditable(issuedForDate: string, today: string): boolean {
  return today < issuedForDate;
}

export const WAYBILL_LOCKED_MESSAGE =
  'Лист выписан на сегодня или прошедший день — бланк уже у водителя, и аннулировать его нельзя';
