import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

// ── Справочник «Техника»: конкретные ТС (ADR 0007) ──
// Тип обязателен, марка/модель опциональна (в источнике есть машины без марки). Согласованность
// «тип ТС = тип модели» гарантирует составной FK в БД. Госномер нормализуется и уникален среди живых.

export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired'] as const;
export const vehicleStatusSchema = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const vehicleStatusLabels: Record<VehicleStatus, string> = {
  active: 'Активна',
  inactive: 'Неактивна',
  maintenance: 'Обслуживание',
  retired: 'Списана',
};
export const vehicleStatusColors: Record<VehicleStatus, string> = {
  active: 'green',
  inactive: 'default',
  maintenance: 'gold',
  retired: 'red',
};

// ── Принадлежность: собственная техника и аренда (ADR 0018) ──
// Ветки не пересекаются ни одним содержательным реквизитом: у своей машины — марка/модель,
// госномер и ПТС, у аренды — арендодатель, цены и короткий срез-идентификатор.

export const VEHICLE_OWNERSHIPS = ['own', 'rental'] as const;
export const vehicleOwnershipSchema = z.enum(VEHICLE_OWNERSHIPS);
export type VehicleOwnership = (typeof VEHICLE_OWNERSHIPS)[number];

export const vehicleOwnershipLabels: Record<VehicleOwnership, string> = {
  own: 'Собственная',
  rental: 'Аренда',
};
export const vehicleOwnershipColors: Record<VehicleOwnership, string> = {
  own: 'blue',
  rental: 'purple',
};

/** У предложения аренды нет состояний машины: «Обслуживание» и «Списана» к нему не применимы. */
export const RENTAL_STATUSES = ['active', 'inactive'] as const satisfies readonly VehicleStatus[];

export function isRentalStatus(s: VehicleStatus): boolean {
  return (RENTAL_STATUSES as readonly VehicleStatus[]).includes(s);
}

/** Цена в рублях: две цифры после запятой (numeric(12,2) в БД), строго положительная. */
export const vehiclePriceSchema = z.coerce.number().positive().max(9_999_999_99).multipleOf(0.01);

// Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки.
export const VEHICLE_SORT_FIELDS = [
  'ownership',
  'registrationNumber',
  'typeName',
  'categoryName',
  'modelName',
  'lessorName',
  'description',
  'pricePerHour',
  'pricePerShift',
  'status',
  'createdAt',
] as const;

export const vehicleListQuerySchema = baseListQuery(VEHICLE_SORT_FIELDS).extend({
  ownership: vehicleOwnershipSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  vehicleCategoryId: uuidSchema.optional(),
  lessorId: uuidSchema.optional(),
  status: vehicleStatusSchema.optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** Общее у веток: классификация, статус, комментарий. Тип обязателен всегда, категория — нет. */
const vehicleCommonFields = {
  vehicleTypeId: uuidSchema,
  vehicleCategoryId: uuidSchema.nullish(),
  status: vehicleStatusSchema.optional().default('active'),
  note: z.string().trim().max(2000).optional().default(''),
};

const createOwnVehicleSchema = z
  .object({
    ownership: z.literal('own'),
    ...vehicleCommonFields,
    vehicleModelId: uuidSchema.nullish(),
    registrationNumber: z.string().trim().max(50).nullish(),
    passportNumber: z.string().trim().max(100).nullish(),
  })
  .strict();

const createRentalVehicleSchema = z
  .object({
    ownership: z.literal('rental'),
    ...vehicleCommonFields,
    status: z.enum(RENTAL_STATUSES).optional().default('active'),
    lessorId: uuidSchema,
    /** Короткий срез вида «Автокран 70 тн»; входит в ключ уникальности предложения. */
    description: z.string().trim().max(120).optional().default(''),
    pricePerHour: vehiclePriceSchema.nullish(),
    pricePerShift: vehiclePriceSchema.nullish(),
    shiftHours: z.coerce.number().int().min(1).max(24).nullish(),
  })
  .strict()
  .refine((v) => v.pricePerHour != null || v.pricePerShift != null, {
    message: 'Укажите хотя бы одну цену — за час или за смену',
    path: ['pricePerHour'],
  });

// Строгие ветки союза физически отсекают «госномер у аренды» и «цену у своей машины» ещё
// на валидации: чужое поле не пройдёт `.strict()`.
export const createVehicleSchema = z.discriminatedUnion('ownership', [
  createOwnVehicleSchema,
  createRentalVehicleSchema,
]);
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type CreateOwnVehicleInput = z.infer<typeof createOwnVehicleSchema>;
export type CreateRentalVehicleInput = z.infer<typeof createRentalVehicleSchema>;

// `ownership` в PATCH не принимается: смена принадлежности — другая сущность, а не правка.
// `.partial()` не снимает `.default()`, поэтому поля с дефолтом переобъявлены без него — иначе
// PATCH со сменой одного статуса затирал бы note пустой строкой.
const updateOwnVehicleSchema = z
  .object({
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    vehicleModelId: uuidSchema.nullish(),
    registrationNumber: z.string().trim().max(50).nullish(),
    passportNumber: z.string().trim().max(100).nullish(),
    status: vehicleStatusSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const updateRentalVehicleSchema = z
  .object({
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.nullish(),
    lessorId: uuidSchema.optional(),
    description: z.string().trim().max(120).optional(),
    pricePerHour: vehiclePriceSchema.nullish(),
    pricePerShift: vehiclePriceSchema.nullish(),
    shiftHours: z.coerce.number().int().min(1).max(24).nullish(),
    status: z.enum(RENTAL_STATUSES).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Ветку PATCH определяет не тело, а сама запись: клиент не должен сообщать принадлежность,
 * чтобы не было соблазна её «поправить». Маршрут выбирает схему по существующей строке.
 */
export const updateVehicleSchema = z.union([updateOwnVehicleSchema, updateRentalVehicleSchema]);
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export const updateVehicleSchemaByOwnership: Record<
  VehicleOwnership,
  typeof updateOwnVehicleSchema | typeof updateRentalVehicleSchema
> = {
  own: updateOwnVehicleSchema,
  rental: updateRentalVehicleSchema,
};
export type UpdateOwnVehicleInput = z.infer<typeof updateOwnVehicleSchema>;
export type UpdateRentalVehicleInput = z.infer<typeof updateRentalVehicleSchema>;

// Поля чужой ветки приходят как null, а не отсутствуют: справочник — один список с одним набором
// колонок, и клиенту не нужно ветвиться при отрисовке строки.
export interface VehicleDto {
  id: string;
  ownership: VehicleOwnership;
  vehicleTypeId: string;
  typeName: string;
  vehicleCategoryId: string | null;
  categoryName: string | null;
  vehicleModelId: string | null;
  modelName: string | null;
  registrationNumber: string | null;
  passportNumber: string | null;
  lessorId: string | null;
  lessorName: string | null;
  /**
   * Активен ли арендодатель. У неактивного не может быть активных предложений (ADR 0018 §15):
   * интерфейс по этому полю блокирует включение и объясняет причину, не дожидаясь отказа сервера.
   */
  lessorIsActive: boolean | null;
  /**
   * Выключено каскадом от арендодателя, а не отдельным решением. Такие позиции вернутся сами,
   * когда арендодателя активируют; выключенные вручную — нет (ADR 0018 §14).
   */
  deactivatedWithLessor: boolean;
  description: string;
  pricePerHour: number | null;
  pricePerShift: number | null;
  shiftHours: number | null;
  status: VehicleStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Почему предложение аренды нельзя включить, или null — если можно. Текст один и тот же в
 * подсказке у переключателя и в отказе сервера, чтобы человек не гадал, что именно не так.
 */
export function rentalActivationBlockReason(v: {
  ownership: VehicleOwnership;
  lessorIsActive: boolean | null;
  lessorName: string | null;
  deactivatedWithLessor?: boolean;
}): string | null {
  if (v.ownership !== 'rental' || v.lessorIsActive !== false) return null;
  const who = `Арендодатель${v.lessorName ? ` «${v.lessorName}»` : ''} неактивен`;
  // Выключенным вместе с арендодателем возвращаться не нужно вручную — они поднимутся сами.
  return v.deactivatedWithLessor
    ? `${who} — техника включится обратно вместе с ним`
    : `${who} — активируйте его в справочнике контрагентов`;
}

/** Как строка техники называется в списках и подтверждениях. */
export function vehicleTitle(v: VehicleDto): string {
  if (v.ownership === 'rental') {
    return v.description || v.categoryName || v.typeName;
  }
  return v.registrationNumber || v.modelName || v.categoryName || v.typeName;
}

// ── Марки/модели: read-only список для выбора в форме техники (не отдельный справочник) ──
export const VEHICLE_MODEL_SORT_FIELDS = ['name', 'createdAt'] as const;

export const vehicleModelListQuerySchema = baseListQuery(VEHICLE_MODEL_SORT_FIELDS).extend({
  vehicleTypeId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export interface VehicleModelDto {
  id: string;
  vehicleTypeId: string;
  name: string;
  manufacturerName: string;
  isActive: boolean;
}
