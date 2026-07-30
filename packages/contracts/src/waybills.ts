import { z } from 'zod';

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
