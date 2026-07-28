import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const VEHICLE_TYPE_SORT_FIELDS = [
  'code',
  'kindName',
  'name',
  'sortOrder',
  'isActive',
] as const;

/** Системный код: строчные латинские, цифры и `_`; первый символ — буква. Неизменяем после создания. */
export const vehicleTypeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'Код: только строчные латинские, цифры и _, первый символ — буква');

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const vehicleTypeListQuerySchema = baseListQuery(VEHICLE_TYPE_SORT_FIELDS).extend({
  kindId: uuidSchema.optional(),
  isActive: boolFromQuery,
});

// ── Создание (плоская модель, ADR 0005) ──
// Клиент шлёт kindId и описательные поля; структурные ключи (code/kindId) неизменяемы после создания.
export const createVehicleTypeSchema = z
  .object({
    kindId: uuidSchema,
    code: vehicleTypeCodeSchema,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).optional().default(''),
    sortOrder: z.coerce.number().int().optional().default(100),
    isActive: z.boolean().optional().default(true),
  })
  .strict();
export type CreateVehicleTypeInput = z.infer<typeof createVehicleTypeSchema>;

// ── Обновление: описательные поля + активность. code/kindId менять нельзя (strict отклоняет). ──
export const updateVehicleTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateVehicleTypeInput = z.infer<typeof updateVehicleTypeSchema>;

/** Плоский тип ТС (ADR 0005): один уровень, ссылается на вид (kind). */
export interface VehicleTypeDto {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  /** Сколько ТТХ привязано к типу (ADR 0016): 0 — у типа нет и не может быть категорий. */
  specCount: number;
  /** Сколько категорий (комбинаций значений ТТХ) заведено у типа. */
  categoryCount: number;
  createdAt: string;
  updatedAt: string;
}
