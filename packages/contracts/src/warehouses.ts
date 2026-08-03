import { z } from 'zod';
import { baseListQuery, optionalPhoneSchema, uuidSchema } from './common';

/**
 * Справочник складов поставщиков (ADR 0051). Склад — адрес, по которому работают с поставщиком:
 * забирают материалы или привозят их ему. Складов у одного поставщика много, поэтому склад —
 * своя сущность, а не поле контрагента.
 *
 * Опознаётся склад адресом, поэтому и сортировка по умолчанию идёт по нему, а не по метке:
 * метка (`name`) необязательна и заполнена не у всех.
 */
export const WAREHOUSE_SORT_FIELDS = ['address', 'supplier', 'isActive', 'createdAt'] as const;

/** Адрес — обязателен: без него склад ничего не называет. Длина — как у адреса объекта. */
const addressSchema = z.string().trim().min(3, 'Укажите адрес склада').max(500);

/**
 * Метка склада («Основной», «Склад №2») — то, как склад называют между собой. Пустая строка
 * означает «не задана»: узнают склад по адресу, и требовать метку не за что.
 */
const warehouseNameSchema = z.string().trim().max(255);

/**
 * Контактное лицо склада — кто принимает машину. Свободный текст и **необязательный**: контакт
 * знают не всегда, и требовать его за возможность записать адрес не за что. Правило то же, что у
 * телефона учётки (ADR 0043): необязательность не означает, что вместо имени годится «-».
 */
const contactPersonSchema = z.string().trim().max(200);

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const warehouseListQuerySchema = baseListQuery(WAREHOUSE_SORT_FIELDS).extend({
  /** Фильтр справочника: чьи склады показывать. */
  supplierId: uuidSchema.optional(),
  isActive: boolFromQuery,
});

export const createWarehouseSchema = z.object({
  supplierId: uuidSchema,
  address: addressSchema,
  name: warehouseNameSchema.optional().default(''),
  contactPerson: contactPersonSchema.optional().default(''),
  contactPhone: optionalPhoneSchema.optional().default(''),
  comment: z.string().trim().max(2000).optional().default(''),
  isActive: z.boolean().optional().default(true),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

/**
 * `.partial()` снимает обязательность, но не `.default()` (тот же подвох, что в
 * `updateDepartmentSchema`), поэтому поля со значением по умолчанию объявлены заново: PATCH без
 * `contactPerson` иначе стирал бы контакт склада.
 */
export const updateWarehouseSchema = createWarehouseSchema.partial().extend({
  name: warehouseNameSchema.optional(),
  contactPerson: contactPersonSchema.optional(),
  contactPhone: optionalPhoneSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

/**
 * Поставщик в строке склада: столько, сколько нужно для показа и повторного выбора. Активность
 * входит в набор — по ней в списке видно, что склад принадлежит приостановленному контрагенту,
 * хотя сам склад активен (деактивация поставщика склады не гасит).
 */
export interface WarehouseSupplierRefDto {
  id: string;
  name: string;
  inn: string;
  isActive: boolean;
}

export interface WarehouseDto {
  id: string;
  supplier: WarehouseSupplierRefDto;
  address: string;
  /** Метка склада; пустая строка — не задана. */
  name: string;
  /** Контакт склада; пустые строки — не указан. */
  contactPerson: string;
  contactPhone: string;
  comment: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Как склад называется в строке списка и в выборе: адрес плюс метка, если она задана. */
export function warehouseTitle(w: Pick<WarehouseDto, 'address' | 'name'>): string {
  return w.name ? `${w.address} (${w.name})` : w.address;
}
