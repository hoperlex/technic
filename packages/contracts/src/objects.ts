import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const OBJECT_SORT_FIELDS = ['code', 'name', 'address', 'isActive', 'createdAt'] as const;

/**
 * Операторы вывоза, обслуживающие объект (ADR 0010) — многие-ко-многим. Передаются полным
 * списком: сервер синхронизирует набор (лишние привязки снимает, новые заводит). Тот же приём,
 * что и с синонимами контрагента.
 */
export const operatorIdsSchema = z.array(uuidSchema).max(50);

export const objectListQuerySchema = baseListQuery(OBJECT_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createObjectSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().max(500).optional().default(''),
  isActive: z.boolean().default(true),
  operatorIds: operatorIdsSchema.optional().default([]),
});
export type CreateObjectInput = z.infer<typeof createObjectSchema>;

// `.partial()` делает поля необязательными, но НЕ снимает `.default()` (тот же подвох, что и в
// updateVehicleSchema), поэтому поля со значением по умолчанию объявлены заново, без дефолта:
// PATCH без `operatorIds` иначе снимал бы все привязки объекта, а без `address` — затирал адрес.
export const updateObjectSchema = createObjectSchema.partial().extend({
  address: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
  /** Полный список операторов; отсутствие поля — не трогать привязки. */
  operatorIds: operatorIdsSchema.optional(),
});
export type UpdateObjectInput = z.infer<typeof updateObjectSchema>;

/** Оператор вывоза в карточке объекта: столько, сколько нужно для показа и повторного выбора. */
export interface ObjectOperatorRefDto {
  id: string;
  name: string;
}

export interface ObjectDto {
  id: string;
  code: string;
  name: string;
  address: string;
  isActive: boolean;
  /** Операторы вывоза, обслуживающие объект (ADR 0010); порядок — по наименованию. */
  operators: ObjectOperatorRefDto[];
  createdAt: string;
  updatedAt: string;
}
