import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const VEHICLE_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

/** Уровень записи в иерархии: тип (parentId=null) или подтип (parentId задан). */
export const VEHICLE_TYPE_LEVELS = ['type', 'subtype'] as const;
export const vehicleTypeLevelSchema = z.enum(VEHICLE_TYPE_LEVELS);
export type VehicleTypeLevel = (typeof VEHICLE_TYPE_LEVELS)[number];

/** Режим выдачи списка: плоский или иерархический (родитель + его подтипы рядом). */
export const VEHICLE_TYPE_VIEWS = ['list', 'hierarchy'] as const;
export const vehicleTypeViewSchema = z.enum(VEHICLE_TYPE_VIEWS);
export type VehicleTypeView = (typeof VEHICLE_TYPE_VIEWS)[number];

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
  parentId: uuidSchema.optional(),
  level: vehicleTypeLevelSchema.optional(),
  isActive: boolFromQuery,
  view: vehicleTypeViewSchema.optional().default('list'),
});

// ── Создание: discriminated union по level ──
// Клиент НЕ передаёт структурные/производные поля: для типа — parentId/isSelectable/isActive;
// для подтипа — kindId/isSelectable (kindId наследуется от родителя на бэкенде).

export const createParentTypeSchema = z
  .object({
    level: z.literal('type'),
    kindId: uuidSchema,
    code: vehicleTypeCodeSchema,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).optional().default(''),
    sortOrder: z.coerce.number().int().optional().default(100),
  })
  .strict();

export const createSubtypeSchema = z
  .object({
    level: z.literal('subtype'),
    parentId: uuidSchema,
    code: vehicleTypeCodeSchema,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).optional().default(''),
    sortOrder: z.coerce.number().int().optional().default(100),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

export const createVehicleTypeSchema = z.discriminatedUnion('level', [
  createParentTypeSchema,
  createSubtypeSchema,
]);
export type CreateParentTypeInput = z.infer<typeof createParentTypeSchema>;
export type CreateSubtypeInput = z.infer<typeof createSubtypeSchema>;
export type CreateVehicleTypeInput = z.infer<typeof createVehicleTypeSchema>;

// ── Обновление: только описательные поля. Структурные ключи неизменяемы. ──
// Не `.partial()` от create: строгие схемы отклоняют code/kindId/parentId/level/isSelectable.

export const updateParentTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .strict();
export type UpdateParentTypeInput = z.infer<typeof updateParentTypeSchema>;

export const updateSubtypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateSubtypeInput = z.infer<typeof updateSubtypeSchema>;

/** Тело PATCH до определения уровня записи (надмножество допустимых полей). */
export const updateVehicleTypeSchema = updateSubtypeSchema;
export type UpdateVehicleTypeInput = z.infer<typeof updateVehicleTypeSchema>;

/**
 * Тип/подтип ТС из иерархического справочника.
 * Родительский тип: parentId=null, isSelectable=false, isActive — производное
 * (есть ли активный подтип). Конечный подтип: isSelectable=true.
 * Конкретное ТС (следующий этап) сможет ссылаться только на selectable-подтип.
 */
export interface VehicleTypeDto {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  parentId: string | null;
  parentName: string | null;
  code: string;
  name: string;
  description: string;
  level: VehicleTypeLevel;
  isSelectable: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Число прямых подтипов (для типа); у подтипа всегда 0. */
  childrenCount: number;
  createdAt: string;
  updatedAt: string;
}
