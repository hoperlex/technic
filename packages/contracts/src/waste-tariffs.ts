import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import { containerKindSchema, type ContainerKind, type RequestType } from './enums';

/**
 * Тарифицируется только вывоз мусора самосвалами (ADR 0019): там объём заказывают заявкой, и он
 * же вместе с прайсом даёт сумму. Контейнерные операции (установка, замена, снятие) заявкой не
 * считаются: ни типа мусора, ни объёма, ни цены у них нет.
 */
export const PRICED_REQUEST_TYPES = ['waste_removal'] as const satisfies readonly RequestType[];

export function isPricedRequestType(t: RequestType): boolean {
  return (PRICED_REQUEST_TYPES as readonly RequestType[]).includes(t);
}

// ── Типы мусора ──
// Отдельного справочника типов нет (ADR 0017): тип существует ради цены и заводится вместе с
// первой позицией прайса, а правится в строке тарифа. Наружу тип остаётся списком для выбора.

export const WASTE_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const wasteTypeListQuerySchema = baseListQuery(WASTE_TYPE_SORT_FIELDS).extend({
  isActive: boolFromQuery,
  /**
   * Только типы с действующим тарифом. Форма заявки спрашивает именно так: тип без цены
   * выбрать можно, а сохранить заявку — нет («тариф не найден»).
   */
  hasActiveTariff: boolFromQuery,
});

/** «Что вывозим»: строительные отходы, бетонный бой, грунт, ОССиГ, древесные отходы. */
export interface WasteTypeDto {
  id: string;
  /** Стабильный системный идентификатор; выводится из названия сервером при заведении типа. */
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Нормализованный ключ названия — повторяет SQL-функцию `waste_type_name_key` (миграция 0036):
 * регистр, «ё» и любые разделители значения не имеют. Одинаковый ключ = один и тот же тип.
 */
export function wasteTypeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/g, '');
}

export const wasteTypeNameSchema = z
  .string()
  .trim()
  .min(2, 'Название слишком короткое')
  .max(255)
  .refine((n) => wasteTypeNameKey(n) !== '', 'Название должно содержать буквы или цифры');

// `code` неизменяем после создания, удаления нет — деактивация через isActive
// (единый принцип со справочником типов контейнеров).
export const updateWasteTypeSchema = z
  .object({
    name: wasteTypeNameSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateWasteTypeInput = z.infer<typeof updateWasteTypeSchema>;

// ── Дубли и похожие названия ──
// Две разные проверки с разной силой. Совпадение ключа — запрет: это то же самое, написанное
// иначе, и вторая строка развалила бы пару «тип × техника» на две цены. Похожесть — только
// предупреждение: «Грунт» рядом с «Чистый грунт» бывает и опечаткой, и новой позицией прайса,
// и решать это человеку, а не порогу расстояния между строками.

/** Порог похожести: доля совпадения ключей, при которой название показывается как близкое. */
export const WASTE_TYPE_SIMILARITY_THRESHOLD = 0.75;

/** Ключ короче этого не сравнивается: на 1–2 символах любое расстояние даёт ложные срабатывания. */
const MIN_COMPARED_KEY_LENGTH = 3;

export interface WasteTypeNameLike {
  id: string;
  name: string;
}

function levenshtein(a: string, b: string): number {
  // Одна строка матрицы: длины названий малы, но функция зовётся на каждый ввод символа в форме.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Похожесть двух названий: 0 — ничего общего, 1 — один и тот же ключ. */
export function wasteTypeNameSimilarity(a: string, b: string): number {
  const ka = wasteTypeNameKey(a);
  const kb = wasteTypeNameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const max = Math.max(ka.length, kb.length);
  return (max - levenshtein(ka, kb)) / max;
}

/** Существующий тип с тем же ключом — блокирующий дубль (его же ловит UNIQUE в БД). */
export function findWasteTypeByName<T extends WasteTypeNameLike>(
  name: string,
  types: readonly T[],
): T | undefined {
  const key = wasteTypeNameKey(name);
  if (!key) return undefined;
  return types.find((t) => wasteTypeNameKey(t.name) === key);
}

/**
 * Близкие названия — предупреждение, не запрет. Кроме расстояния учитывается вхождение целиком:
 * «Грунт» и «Чистый грунт» далеки по буквам, но почти наверняка про одно и то же.
 */
export function findSimilarWasteTypes<T extends WasteTypeNameLike>(
  name: string,
  types: readonly T[],
  limit = 5,
): T[] {
  const key = wasteTypeNameKey(name);
  if (key.length < MIN_COMPARED_KEY_LENGTH) return [];
  const scored: { type: T; score: number }[] = [];
  for (const type of types) {
    const other = wasteTypeNameKey(type.name);
    if (other === key || other.length < MIN_COMPARED_KEY_LENGTH) continue;
    const ratio = wasteTypeNameSimilarity(name, type.name);
    const score =
      other.includes(key) || key.includes(other)
        ? Math.max(WASTE_TYPE_SIMILARITY_THRESHOLD, ratio)
        : ratio;
    if (score >= WASTE_TYPE_SIMILARITY_THRESHOLD) scored.push({ type, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.type);
}

/** Текст отказа один на форму и сервер: человек видит одно и то же до и после отправки. */
export function wasteTypeDuplicateMessage(existingName: string): string {
  return `Такой тип уже есть — «${existingName}»; выберите его в списке`;
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
    /** Существующий тип мусора — либо он, либо название нового в `wasteTypeName`. */
    wasteTypeId: uuidSchema.nullish(),
    /**
     * Новый тип мусора: заводится той же транзакцией, что и цена (ADR 0017). Отдельного шага
     * «сначала тип» нет намеренно — иначе брошенная на полпути форма оставляла бы тип без цены,
     * а править и отключать такой тип негде: интерфейс типа живёт в строке тарифа.
     */
    wasteTypeName: wasteTypeNameSchema.nullish(),
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

/**
 * Выбор типа мусора у новой позиции: ровно одно из двух — существующий тип или название нового.
 * Схема этого не выражает (оба поля необязательны по отдельности), поэтому проверка отдельная —
 * тем же приёмом, что и цель тарифа в `validateWasteTariff`.
 */
export function validateWasteTypeChoice(c: {
  wasteTypeId?: string | null;
  wasteTypeName?: string | null;
}): Record<string, string> {
  if (c.wasteTypeId && c.wasteTypeName) {
    return { wasteTypeId: 'Либо существующий тип мусора, либо новый — не оба сразу' };
  }
  if (!c.wasteTypeId && !c.wasteTypeName) return { wasteTypeId: 'Выберите тип мусора' };
  return {};
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
