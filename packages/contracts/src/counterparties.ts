import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

// ── Тип контрагента ──
// Роль организации в проекте. У записи он один: контрагент опознаётся по ИНН, а ИНН уникален,
// поэтому «та же организация в другой роли» — это смена типа записи, а не вторая запись (ADR 0010).
export const COUNTERPARTY_TYPES = ['general_contractor', 'contractor', 'operator'] as const;
export const counterpartyTypeSchema = z.enum(COUNTERPARTY_TYPES);
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];

export const counterpartyTypeLabels: Record<CounterpartyType, string> = {
  general_contractor: 'Генеральный подрядчик',
  contractor: 'Подрядчик',
  operator: 'Оператор (вывоз мусора)',
};

export const counterpartyTypeColors: Record<CounterpartyType, string> = {
  general_contractor: 'purple',
  contractor: 'blue',
  operator: 'green',
};

// ── ИНН ──
/** 10 знаков у организации, 12 — у ИП и физлица. Формат; контрольную сумму см. `isValidInn`. */
export const INN_MESSAGE = 'ИНН — 10 цифр (организация) или 12 (ИП, физлицо)';
export const innSchema = z
  .string()
  .trim()
  .regex(/^(\d{10}|\d{12})$/, INN_MESSAGE);

/**
 * Контрольная сумма ИНН (приказ ФНС): последняя цифра (у 12-значного — две последние) считается
 * по фиксированным весам. Проверка ловит опечатку в одной цифре — то, чего формат не видит.
 */
export function isValidInn(inn: string): boolean {
  if (!/^(\d{10}|\d{12})$/.test(inn)) return false;
  const d = [...inn].map(Number);
  const checksum = (weights: number[]): number =>
    (weights.reduce((sum, w, i) => sum + w * d[i]!, 0) % 11) % 10;
  if (d.length === 10) {
    return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  }
  return (
    checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] &&
    checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11]
  );
}

export const INN_CHECKSUM_MESSAGE = 'ИНН не проходит проверку контрольной суммы';

// ── Наименования ──
const nameSchema = z.string().trim().min(2).max(255);

/**
 * Синонимы — альтернативные наименования того же контрагента («ООО «Ромашка»», «Ромашка ООО»,
 * «РОМАШКА»). Передаются полным списком: сервер синхронизирует набор (лишние удаляет, новые
 * добавляет). Нормализованный синоним уникален глобально — один текст не может указывать на
 * двух контрагентов, иначе сопоставление наименования из документа перестаёт быть однозначным.
 */
export const synonymsSchema = z.array(nameSchema).max(50);

/**
 * Объекты, которые обслуживает оператор вывоза (ADR 0010) — обратная сторона связи
 * «объект ↔ оператор». Передаются полным списком, как и синонимы. Смысл есть только у типа
 * `operator`: у генподрядчика и подрядчика заявки вывоза не исполняются, поэтому непустой
 * список у другого типа сервер отклоняет.
 */
export const counterpartyObjectIdsSchema = z.array(uuidSchema).max(200);

export const COUNTERPARTY_SORT_FIELDS = [
  'name',
  'inn',
  'type',
  'comment',
  'isActive',
  'createdAt',
] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const counterpartyListQuerySchema = baseListQuery(COUNTERPARTY_SORT_FIELDS).extend({
  type: counterpartyTypeSchema.optional(),
  isActive: boolFromQuery,
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const createCounterpartySchema = z.object({
  type: counterpartyTypeSchema,
  name: nameSchema,
  inn: innSchema,
  comment: z.string().trim().max(2000).optional().default(''),
  synonyms: synonymsSchema.optional().default([]),
  objectIds: counterpartyObjectIdsSchema.optional().default([]),
  isActive: z.boolean().optional().default(true),
});
export type CreateCounterpartyInput = z.infer<typeof createCounterpartySchema>;

export const updateCounterpartySchema = z.object({
  type: counterpartyTypeSchema.optional(),
  name: nameSchema.optional(),
  inn: innSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  /** Полный список синонимов; отсутствие поля — не трогать синонимы. */
  synonyms: synonymsSchema.optional(),
  /** Полный список обслуживаемых объектов; отсутствие поля — не трогать привязки. */
  objectIds: counterpartyObjectIdsSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCounterpartyInput = z.infer<typeof updateCounterpartySchema>;

/** Поиск контрагента по наименованию из документа (основное наименование или синоним). */
export const resolveCounterpartyQuerySchema = z.object({
  name: z.string().trim().min(2).max(255),
});

/** Объект в карточке оператора: код нужен, чтобы различать одноимённые корпуса. */
export interface CounterpartyObjectRefDto {
  id: string;
  code: string;
  name: string;
}

export interface CounterpartyDto {
  id: string;
  type: CounterpartyType;
  name: string;
  inn: string;
  comment: string;
  /** Альтернативные наименования; основное в список не входит. */
  synonyms: string[];
  /** Обслуживаемые объекты (ADR 0010); у типов, кроме `operator`, всегда пуст. */
  objects: CounterpartyObjectRefDto[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Результат сопоставления наименования: чем именно оно совпало. */
export interface ResolvedCounterpartyDto {
  counterparty: CounterpartyDto;
  matchedBy: 'name' | 'synonym';
}
