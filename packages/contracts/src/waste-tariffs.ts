import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import type { ContainerKind, RequestType } from './enums';

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
  containerKind: ContainerKind | null;
  pricePerM3: number;
  pricePerContainer: number | null;
  isPerContainer: boolean;
  note: string;
  isActive: boolean;
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
