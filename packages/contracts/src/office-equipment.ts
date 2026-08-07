import { z } from 'zod';
import { archiveFilterSchema, baseListQuery, dateOnlySchema, uuidSchema } from './common';

// ── Справочник оргтехники (ADR 0085) ──
// Единица: тип, модель, номера, место (объект и уточнение внутри него), отдел-владелец, гарантия
// поставщика. Заявки на обслуживание ссылаются на единицу и хранят снимок её реквизитов, поэтому
// правка карточки прошлое не переписывает.

// ── Тип оргтехники ──
// Перечень, как типы контейнеров: код, название, порядок. Ведётся в окне из вкладки справочника —
// сам по себе тип ничего не значит, и отдельная вкладка ради десяти строк не заводится.

export const OFFICE_EQUIPMENT_TYPE_SORT_FIELDS = ['name', 'code', 'sortOrder', 'isActive'] as const;

const typeCodeSchema = z
  .string()
  .trim()
  .min(2, 'Код типа — минимум 2 символа')
  .max(50)
  .regex(/^[a-z0-9_]+$/, 'Код типа — латиница, цифры и подчёркивание');

const typeNameSchema = z.string().trim().min(2, 'Укажите название типа').max(255);

export const officeEquipmentTypeListQuerySchema = baseListQuery(
  OFFICE_EQUIPMENT_TYPE_SORT_FIELDS,
).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createOfficeEquipmentTypeSchema = z.object({
  code: typeCodeSchema,
  name: typeNameSchema,
  sortOrder: z.number().int().min(0).max(9999).optional().default(100),
  isActive: z.boolean().optional().default(true),
});
export type CreateOfficeEquipmentTypeInput = z.infer<typeof createOfficeEquipmentTypeSchema>;

// `.partial()` снимает обязательность, но не `.default()` — поля со значением по умолчанию
// объявляются заново, иначе PATCH без поля затирал бы значение (тот же подвох, что у складов).
export const updateOfficeEquipmentTypeSchema = createOfficeEquipmentTypeSchema.partial().extend({
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateOfficeEquipmentTypeInput = z.infer<typeof updateOfficeEquipmentTypeSchema>;

export interface OfficeEquipmentTypeDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Единица оргтехники ──

export const OFFICE_EQUIPMENT_SORT_FIELDS = [
  'name',
  'type',
  'object',
  'inventoryNumber',
  'serialNumber',
  'warrantyUntil',
  'isActive',
  'createdAt',
] as const;

const nameSchema = z.string().trim().min(2, 'Укажите модель').max(255);
/** Номера свободного вида: их печатает производитель и клеит бухгалтерия, формата у них нет. */
const numberSchema = z.string().trim().max(100);
const locationSchema = z.string().trim().max(255);
const commentSchema = z.string().trim().max(2000);

/**
 * Фильтр по гарантии: три вопроса, которые задают этому справочнику. `expiring` — «что продлевать в
 * ближайший месяц», и порог у него общий с подсветкой (`WARRANTY_EXPIRING_DAYS`).
 */
export const OFFICE_EQUIPMENT_WARRANTY_FILTERS = ['active', 'expiring', 'expired'] as const;
export type OfficeEquipmentWarrantyFilter = (typeof OFFICE_EQUIPMENT_WARRANTY_FILTERS)[number];

export const officeEquipmentListQuerySchema = baseListQuery(OFFICE_EQUIPMENT_SORT_FIELDS).extend({
  objectId: uuidSchema.optional(),
  equipmentTypeId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  /** «Не закреплена ни за кем» — срез для разметки парка; с `departmentId` не сочетается. */
  unassignedDepartment: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  warranty: z.enum(OFFICE_EQUIPMENT_WARRANTY_FILTERS).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  archive: archiveFilterSchema,
});

const equipmentFields = {
  equipmentTypeId: uuidSchema,
  name: nameSchema,
  serialNumber: numberSchema.optional().default(''),
  inventoryNumber: numberSchema.optional().default(''),
  objectId: uuidSchema,
  departmentId: uuidSchema.nullish(),
  location: locationSchema.optional().default(''),
  purchasedOn: dateOnlySchema.nullish(),
  warrantyUntil: dateOnlySchema.nullish(),
  comment: commentSchema.optional().default(''),
  isActive: z.boolean().optional().default(true),
};

/**
 * Хотя бы один номер обязателен (тот же CHECK держит и БД): единицу опознают при приёмке из
 * ремонта, и «МФУ без номеров» в акте ничем не отличается от соседнего такого же.
 */
const IDENTITY_MESSAGE = 'Укажите серийный или инвентарный номер';

export const createOfficeEquipmentSchema = z
  .object(equipmentFields)
  .refine((v) => !!v.serialNumber || !!v.inventoryNumber, {
    message: IDENTITY_MESSAGE,
    path: ['inventoryNumber'],
  });
export type CreateOfficeEquipmentInput = z.infer<typeof createOfficeEquipmentSchema>;

export const updateOfficeEquipmentSchema = z
  .object({
    ...equipmentFields,
    serialNumber: numberSchema.optional(),
    inventoryNumber: numberSchema.optional(),
    location: locationSchema.optional(),
    comment: commentSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .partial()
  // Правку в «оба номера пусты» ловит сервер: в PATCH приходит только изменённое, и схема одна из
  // двух колонок не видит. Здесь отсекается лишь явная попытка стереть оба разом.
  .refine((v) => v.serialNumber !== '' || v.inventoryNumber !== '', {
    message: IDENTITY_MESSAGE,
    path: ['inventoryNumber'],
  });
export type UpdateOfficeEquipmentInput = z.infer<typeof updateOfficeEquipmentSchema>;

/** Тип в строке единицы: столько, сколько нужно для показа и повторного выбора. */
export interface OfficeEquipmentTypeRefDto {
  id: string;
  name: string;
  isActive: boolean;
}

/** Объект в строке единицы: код различает одноимённые корпуса. */
export interface OfficeEquipmentObjectRefDto {
  id: string;
  code: string;
  name: string;
}

export interface OfficeEquipmentDepartmentRefDto {
  id: string;
  code: string;
  name: string;
}

export interface OfficeEquipmentDto {
  id: string;
  type: OfficeEquipmentTypeRefDto;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  object: OfficeEquipmentObjectRefDto;
  /** Отдел-владелец; `null` — не закреплена (такую единицу и надо разметить). */
  department: OfficeEquipmentDepartmentRefDto | null;
  location: string;
  purchasedOn: string | null;
  warrantyUntil: string | null;
  comment: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Как единица называется в списке и в подсказках: модель плюс номер, которым её опознают. Функция
 * общая для портала и писем — «Kyocera M3145 · инв. 0012345» должно читаться одинаково везде.
 */
export function officeEquipmentTitle(
  item: Pick<OfficeEquipmentDto, 'name' | 'inventoryNumber' | 'serialNumber'>,
): string {
  const num = item.inventoryNumber
    ? `инв. ${item.inventoryNumber}`
    : item.serialNumber
      ? `SN ${item.serialNumber}`
      : '';
  return num ? `${item.name} · ${num}` : item.name;
}
