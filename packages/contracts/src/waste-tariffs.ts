import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import { containerKindSchema, type ContainerKind, type RequestType } from './enums';

/**
 * Операции, в которых мусор фактически вывозится, — только они тарифицируются.
 * Установка нового контейнера вывоза не содержит, поэтому цены у неё нет.
 */
export const PRICED_REQUEST_TYPES = [
  'container_replace',
  'container_removal',
  'waste_removal',
] as const satisfies readonly RequestType[];

export function isPricedRequestType(t: RequestType): boolean {
  return (PRICED_REQUEST_TYPES as readonly RequestType[]).includes(t);
}

// ── Типы мусора ──

export const WASTE_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const wasteTypeListQuerySchema = baseListQuery(WASTE_TYPE_SORT_FIELDS).extend({
  isActive: boolFromQuery,
});

/** «Что вывозим»: строительные отходы, бетонный бой, грунт, ОССиГ, древесные отходы. */
export interface WasteTypeDto {
  id: string;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Код — стабильный системный идентификатор; формат повторяет CHECK `waste_types_code_format`. */
export const WASTE_TYPE_CODE_RE = /^[a-z][a-z0-9_]*$/;

export const createWasteTypeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(WASTE_TYPE_CODE_RE, 'Код: латиница в нижнем регистре, цифры и «_», начиная с буквы'),
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).default(''),
    sortOrder: z.coerce.number().int().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateWasteTypeInput = z.infer<typeof createWasteTypeSchema>;

// `code` неизменяем после создания, удаления нет — деактивация через isActive
// (единый принцип со справочником типов контейнеров).
export const updateWasteTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateWasteTypeInput = z.infer<typeof updateWasteTypeSchema>;

// ── Тарифы ──

export const WASTE_TARIFF_SORT_FIELDS = ['wasteTypeName', 'pricePerM3', 'isActive'] as const;

export const wasteTariffListQuerySchema = baseListQuery(WASTE_TARIFF_SORT_FIELDS).extend({
  wasteTypeId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  isActive: boolFromQuery,
});

/**
 * Позиция прайса. Цена всегда за 1 м³; `isPerContainer` означает, что в исходном прайсе она
 * объявлена за контейнер целиком (`pricePerContainer`), поэтому объём заявки обязан быть кратен
 * вместимости этого контейнера.
 */
export interface WasteTariffDto {
  id: string;
  wasteTypeId: string;
  wasteTypeName: string;
  /** Тариф для конкретного типа контейнера/машины; иначе null — тариф на вид техники. */
  containerTypeId: string | null;
  containerTypeName: string | null;
  /** Вместимость типа контейнера (м³) — база кратности объёма у тарифа «за контейнер». */
  containerVolumeM3: number | null;
  containerKind: ContainerKind | null;
  pricePerM3: number;
  pricePerContainer: number | null;
  isPerContainer: boolean;
  note: string;
  isActive: boolean;
}

const priceSchema = z.coerce
  .number()
  .positive('Цена должна быть больше нуля')
  .max(100_000_000)
  // Цены хранятся с точностью до копейки (numeric(12,2)) — округляем на входе, а не в БД,
  // чтобы предпросмотр в форме совпал с сохранённым значением.
  .transform((v) => Math.round(v * 100) / 100);

/**
 * Позиция прайса на входе. Цена за 1 м³ у позиции «за контейнер» не передаётся: её выводит
 * сервер из вместимости типа контейнера (`pricePerM3FromContainer`) — иначе множители разошлись бы
 * с прайсом при первой же правке одной из двух цен.
 */
export const createWasteTariffSchema = z
  .object({
    wasteTypeId: uuidSchema,
    /** Точный тариф на тип контейнера/машины — либо он, либо `containerKind`. */
    containerTypeId: uuidSchema.nullish(),
    /** Тариф на вид техники целиком (контейнер | самосвал). */
    containerKind: containerKindSchema.nullish(),
    pricePerM3: priceSchema.nullish(),
    pricePerContainer: priceSchema.nullish(),
    isPerContainer: z.boolean().default(false),
    note: z.string().trim().max(500).default(''),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateWasteTariffInput = z.infer<typeof createWasteTariffSchema>;

/**
 * Правка позиции. Кросс-полевые инварианты здесь не проверить (переданы могут быть не все поля) —
 * сервер накладывает патч на сохранённую строку и проверяет результат `validateWasteTariff`.
 */
export const updateWasteTariffSchema = z
  .object({
    wasteTypeId: uuidSchema.optional(),
    containerTypeId: uuidSchema.nullish(),
    containerKind: containerKindSchema.nullish(),
    pricePerM3: priceSchema.nullish(),
    pricePerContainer: priceSchema.nullish(),
    isPerContainer: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateWasteTariffInput = z.infer<typeof updateWasteTariffSchema>;

/** Позиция прайса без служебных полей — то, что проверяется на согласованность. */
export interface WasteTariffDefinition {
  containerTypeId: string | null;
  containerKind: ContainerKind | null;
  pricePerM3: number | null;
  pricePerContainer: number | null;
  isPerContainer: boolean;
}

/**
 * Проверка позиции прайса — те же инварианты, что держат CHECK-и `waste_tariffs` (ADR 0009),
 * но с сообщениями по полям формы. Пустая карта — позиция корректна.
 */
export function validateWasteTariff(d: WasteTariffDefinition): Record<string, string> {
  const fields: Record<string, string> = {};
  if (d.containerTypeId && d.containerKind) {
    fields.containerTypeId = 'Тариф задаётся либо на тип контейнера, либо на вид техники';
  } else if (!d.containerTypeId && !d.containerKind) {
    fields.containerTypeId = 'Выберите тип контейнера/машины или вид техники';
  }
  if (d.isPerContainer) {
    if (!d.containerTypeId) {
      fields.containerTypeId = 'Цена за контейнер задаётся только для конкретного типа контейнера';
    }
    if (d.pricePerContainer == null || d.pricePerContainer <= 0) {
      fields.pricePerContainer = 'Укажите цену за контейнер';
    }
  } else if (d.pricePerM3 == null || d.pricePerM3 <= 0) {
    fields.pricePerM3 = 'Укажите цену за м³';
  }
  return fields;
}

export const resolveWasteTariffQuerySchema = z.object({
  wasteTypeId: uuidSchema,
  containerTypeId: uuidSchema,
});
export type ResolveWasteTariffQuery = z.infer<typeof resolveWasteTariffQuerySchema>;

/** Тариф, подобранный под пару «тип мусора × тип машины/контейнера», и правила расчёта по нему. */
export interface ResolvedWasteTariffDto {
  tariffId: string;
  wasteTypeId: string;
  containerTypeId: string;
  pricePerM3: number;
  isPerContainer: boolean;
  /** Вместимость выбранного типа (м³), если задана в справочнике. */
  containerVolumeM3: number | null;
  /** Шаг объёма: задан только для тарифов «за контейнер», иначе null (любой объём). */
  volumeStepM3: number | null;
  /** Чем подобран тариф: точным типом контейнера или видом техники. */
  matchedBy: 'container_type' | 'container_kind';
}

// ── Расчёт (одна формула для сервера и формы) ──

/**
 * Цена за 1 м³ для позиции прайса «за контейнер»: 15 000 ₽ за контейнер 8 м³ → 1875 ₽/м³.
 * Одна формула на обе стороны: сервер сохраняет результат, форма показывает его до сохранения.
 */
export function pricePerM3FromContainer(pricePerContainer: number, volumeM3: number): number {
  return Math.round((pricePerContainer / volumeM3) * 100) / 100;
}

/** Сумма заявки: объём × цена за м³, округление до копеек. */
export function calcWasteAmount(volumeM3: number, pricePerM3: number): number {
  return Math.round(volumeM3 * pricePerM3 * 100) / 100;
}

/** Объём допустим, если шаг не задан (цена за м³) либо объём кратен шагу (цена за контейнер). */
export function isVolumeAllowed(volumeM3: number, volumeStepM3: number | null): boolean {
  if (volumeStepM3 == null || volumeStepM3 <= 0) return true;
  return Number.isInteger(volumeM3 / volumeStepM3);
}

export function volumeStepMessage(volumeStepM3: number): string {
  return `Тариф задан за контейнер ${volumeStepM3} м³ — объём должен быть кратен ${volumeStepM3}`;
}
