import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

// ── Справочник ТТХ (ADR 0016) ──
// ТТХ — глобальная характеристика (наименование + единица измерения + масштаб), общая для разных
// типов ТС. Привязка ТТХ к типу означает обязательность: каждая категория типа обязана иметь
// значение по каждому привязанному ТТХ.

export const VEHICLE_SPEC_SORT_FIELDS = ['code', 'name', 'unit', 'sortOrder', 'isActive'] as const;

/** Системный код: строчные латинские, цифры и `_`; первый символ — буква. Неизменяем после создания. */
export const VEHICLE_SPEC_CODE_RE = /^[a-z][a-z0-9_]*$/;
export const vehicleSpecCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(VEHICLE_SPEC_CODE_RE, 'Код: только строчные латинские, цифры и _, первый символ — буква');

/** Знаков после запятой у значения: 0..3. Входит в смысл канонизации — после первого значения неизменяем. */
export const VEHICLE_SPEC_MAX_DECIMALS = 3;

/** Границы numeric(14,4) в БД. */
export const VEHICLE_SPEC_VALUE_LIMIT = 1_000_000_000;

export const specValueSchema = z.coerce
  .number()
  .finite()
  .min(-VEHICLE_SPEC_VALUE_LIMIT)
  .max(VEHICLE_SPEC_VALUE_LIMIT);

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const vehicleSpecListQuerySchema = baseListQuery(VEHICLE_SPEC_SORT_FIELDS).extend({
  isActive: boolFromQuery,
});

export const createVehicleSpecSchema = z
  .object({
    code: vehicleSpecCodeSchema,
    name: z.string().trim().min(1).max(255),
    shortName: z.string().trim().max(50).optional().default(''),
    unit: z.string().trim().max(50).optional().default(''),
    decimals: z.coerce.number().int().min(0).max(VEHICLE_SPEC_MAX_DECIMALS).optional().default(0),
    minValue: specValueSchema.nullish(),
    maxValue: specValueSchema.nullish(),
    description: z.string().trim().max(1000).optional().default(''),
    sortOrder: z.coerce.number().int().optional().default(100),
    isActive: z.boolean().optional().default(true),
  })
  .strict()
  .refine((v) => v.minValue == null || v.maxValue == null || v.minValue <= v.maxValue, {
    message: 'Минимум не может быть больше максимума',
    path: ['minValue'],
  });
export type CreateVehicleSpecInput = z.infer<typeof createVehicleSpecSchema>;

// `code` неизменяем всегда; `unit` и `decimals` замораживаются, как только по ТТХ появилось хоть
// одно значение (проверяет сервис): они входят в смысл канонизации, и их смена молча
// переопределила бы уже созданные категории.
export const updateVehicleSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    shortName: z.string().trim().max(50).optional(),
    unit: z.string().trim().max(50).optional(),
    decimals: z.coerce.number().int().min(0).max(VEHICLE_SPEC_MAX_DECIMALS).optional(),
    minValue: specValueSchema.nullish(),
    maxValue: specValueSchema.nullish(),
    description: z.string().trim().max(1000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateVehicleSpecInput = z.infer<typeof updateVehicleSpecSchema>;

export interface VehicleSpecDto {
  id: string;
  code: string;
  name: string;
  shortName: string;
  unit: string;
  decimals: number;
  minValue: number | null;
  maxValue: number | null;
  description: string;
  sortOrder: number;
  isActive: boolean;
  /** К скольким типам ТС привязан: > 0 замораживает unit/decimals и запрещает деактивацию. */
  usedInTypes: number;
  createdAt: string;
  updatedAt: string;
}

// ── Привязка ТТХ к типу ──

export const attachVehicleTypeSpecSchema = z
  .object({
    specId: uuidSchema,
    sortOrder: z.coerce.number().int().optional().default(100),
    /**
     * Значение для уже существующих категорий типа. Обязательно, если категории есть: иначе они
     * мгновенно стали бы неполными. Одинаковая координата, добавленная ко всем кортежам,
     * коллизий не создаёт.
     */
    backfillValue: specValueSchema.optional(),
  })
  .strict();
export type AttachVehicleTypeSpecInput = z.infer<typeof attachVehicleTypeSpecSchema>;

export const updateVehicleTypeSpecSchema = z
  .object({ sortOrder: z.coerce.number().int() })
  .strict();
export type UpdateVehicleTypeSpecInput = z.infer<typeof updateVehicleTypeSpecSchema>;

/** ТТХ в разрезе конкретного типа: справочные поля ТТХ + порядок внутри типа. */
export interface VehicleTypeSpecDto {
  specId: string;
  code: string;
  name: string;
  shortName: string;
  unit: string;
  decimals: number;
  minValue: number | null;
  maxValue: number | null;
  sortOrder: number;
  isActive: boolean;
}

// ── Форматирование значений (общее для API и интерфейса) ──

/**
 * Число значения ТТХ строкой: округление до `decimals`, хвостовые нули убираются — как `trim_scale`
 * в канонизации сигнатуры, чтобы «21» и «21.0» выглядели одинаково.
 */
export function formatSpecNumber(value: number, decimals: number): string {
  const scale = Math.min(Math.max(decimals, 0), VEHICLE_SPEC_MAX_DECIMALS);
  const fixed = value.toFixed(scale);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** Значение с единицей измерения: «25 т», «21 м», «4» (для безразмерных). */
export function formatSpecValue(value: number, spec: { unit: string; decimals: number }): string {
  const n = formatSpecNumber(value, spec.decimals);
  return spec.unit ? `${n} ${spec.unit}` : n;
}

/** Подпись ТТХ в наименовании категории и заголовке колонки: короткое имя, иначе полное. */
export function specLabel(spec: { shortName: string; name: string }): string {
  return spec.shortName || spec.name;
}
