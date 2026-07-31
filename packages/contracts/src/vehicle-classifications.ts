import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

// ── Классификатор ТС: тип и его категории одним списком ──
//
// Тип (ADR 0005) и категория (ADR 0016) — два уровня одной классификации, но выбирают всегда
// одно: «Автокран, г/п 130 т» либо «Ямобур» — если у типа нет ТТХ и категорий быть не может.
// Тип с категориями отдельной позицией не выводится: заказать «просто автокран» нельзя, у него
// есть грузоподъёмность, и заявка без неё не адресна. Тип без категорий — сам себе конечная
// позиция, как будто у него одна нулевая категория.
//
// Правило одно на портал: список типов и список категорий сводит сервер, а не каждый экран
// по-своему — иначе «что можно выбрать» отвечалось бы по-разному в заявке, в справочнике
// техники и в самом справочнике типов.

export const VEHICLE_CLASSIFICATION_SORT_FIELDS = [
  'kindName',
  'label',
  'sortOrder',
  'isActive',
] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const vehicleClassificationListQuerySchema = baseListQuery(
  VEHICLE_CLASSIFICATION_SORT_FIELDS,
).extend({
  kindId: uuidSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  /**
   * Активность позиции целиком: у категории она складывается из активности типа и своей
   * собственной. Неактивный тип не даёт активных позиций — заказать его категорию нельзя.
   */
  isActive: boolFromQuery,
});

/** Позиция классификатора: либо тип с категорией, либо тип без категорий. */
export interface VehicleClassificationDto {
  /** Ключ позиции для списков выбора: `${vehicleTypeId}:${vehicleCategoryId ?? ''}`. */
  key: string;
  vehicleTypeId: string;
  /** null — у типа нет категорий, и он сам конечная позиция. */
  vehicleCategoryId: string | null;
  kindId: string;
  kindCode: string;
  kindName: string;
  typeCode: string;
  typeName: string;
  categoryName: string | null;
  /** Что показывать человеку: наименование категории, а без неё — наименование типа. */
  label: string;
  /** ТТХ у типа (ADR 0016): 0 — категорий у типа нет и быть не может. */
  specCount: number;
  /**
   * Порядок цены этой позиции: средняя ставка активной техники, у которой она заполнена. Считается
   * по всему парку — и по аренде, и по своим машинам: заказчику отвечают на «во сколько обойдётся»,
   * а чьей машиной заявку закроют, на момент заказа неизвестно.
   *
   * `null` — ставки нет ни у одной машины позиции. Это не «бесплатно»: показывать в таком случае
   * нечего, и место остаётся пустым.
   */
  avgPricePerHour: number | null;
  avgPricePerShift: number | null;
  /** Активность позиции целиком: тип активен и (категории нет либо она активна). */
  isActive: boolean;
  typeIsActive: boolean;
  /** null — позиция без категории. */
  categoryIsActive: boolean | null;
  sortOrder: number;
  categorySortOrder: number | null;
}

/** Ключ позиции: им список выбора отдаёт одним значением и тип, и категорию. */
export function vehicleClassificationKey(
  vehicleTypeId: string,
  vehicleCategoryId: string | null | undefined,
): string {
  return `${vehicleTypeId}:${vehicleCategoryId ?? ''}`;
}

/** Разбор ключа позиции обратно в пару идентификаторов; неразобранный ключ даёт null. */
export function parseVehicleClassificationKey(
  key: string | null | undefined,
): { vehicleTypeId: string; vehicleCategoryId: string | null } | null {
  if (!key) return null;
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  const vehicleTypeId = key.slice(0, sep);
  const vehicleCategoryId = key.slice(sep + 1);
  return { vehicleTypeId, vehicleCategoryId: vehicleCategoryId || null };
}

/**
 * Как заказанная классификация называется в списках, карточках и истории. Наименование
 * категории уже содержит тип («Автокраны, г/п 25 т» — ADR 0016 §11), поэтому тип рядом с
 * категорией не повторяется.
 */
export function vehicleClassificationLabel(v: {
  typeName: string;
  categoryName?: string | null;
}): string {
  return v.categoryName || v.typeName;
}

/**
 * Порядок цены позиции одной строкой: «~ 2 400 ₽/час». Тильда здесь не украшение — цифра средняя,
 * и заказ по ней не считают: у конкретной машины ставка своя, а окончательную согласуют при
 * переводе заявки в работу (ADR 0027).
 *
 * Час важнее смены: им заказывают чаще, и сравнивать позиции между собой в одних единицах честнее.
 * Ставка за смену показывается, только когда почасовой нет ни у одной машины позиции, — иначе
 * соседние строки списка отвечали бы разными единицами при живой почасовой.
 */
export function classificationPriceHint(v: {
  avgPricePerHour: number | null;
  avgPricePerShift: number | null;
}): string | null {
  const money = (n: number): string => Math.round(n).toLocaleString('ru-RU');
  if (v.avgPricePerHour != null) return `~ ${money(v.avgPricePerHour)} ₽/час`;
  if (v.avgPricePerShift != null) return `~ ${money(v.avgPricePerShift)} ₽/смена`;
  return null;
}
