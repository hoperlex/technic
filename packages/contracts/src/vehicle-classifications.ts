import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import type { WaybillFormCode } from './waybills';

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
   * Бланк путевого листа типа (`vehicle_types.waybill_form_code`). Форме заявки он нужен не ради
   * документа: бланком тип отличается по существу — у формы № 3 (легковой автомобиль) не
   * спрашивают груз, потому что его не бывает (`isCargoAmountRequired`).
   *
   * Пустым не бывает с ADR 0065: у собственной техники лист есть всегда, и тип отвечает только на
   * вопрос, каким бланком.
   */
  waybillFormCode: WaybillFormCode;
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

// ── Ключ фильтра: набор позиций одной строкой запроса ──
//
// Фильтр списка спрашивает не то же, что форма заявки: заказывают одну позицию, а показать просят
// несколько сразу («автокраны и самосвалы» одним списком). Отсюда второй ключ, самодостаточный:
// `t<uuid>` — тип целиком со всеми категориями, `c<uuid>` — одна категория. Пара `тип:категория`
// на провод не выходит намеренно: категория принадлежит своему типу по составному ключу, а пара
// позволяла бы прислать несуществующее сочетание `типA:категорияB` и получить молча переосмысленный
// ответ вместо отказа.

/**
 * Потолок набора. Посчитан от строки запроса: ключ занимает 37 байт плюс закодированный
 * разделитель, 60 позиций ≈ 2,4 КБ, и весь адрес списка с остальными фильтрами укладывается в
 * дефолтные 8 КБ nginx с запасом. Второй довод тот же, что у любого списочного фильтра: «выбрано
 * всё» и «фильтр не задан» — один и тот же вопрос к списку.
 *
 * Константа одна на схему, портал и подпись фильтра: разойдись они, человек упирался бы в 400 там,
 * где интерфейс ещё разрешает выбирать.
 */
export const CLASSIFICATION_FILTER_MAX = 60;

/** Префикс плюс UUID — длина ключа фиксирована, и от неё считается предел длины всей строки. */
const CLASSIFICATION_FILTER_KEY_LENGTH = 37;

/** Ключ фильтра: категория задана — отбирают по ней, нет — по типу целиком. */
export function classificationFilterKey(
  vehicleTypeId: string,
  vehicleCategoryId: string | null | undefined,
): string {
  return vehicleCategoryId ? `c${vehicleCategoryId}` : `t${vehicleTypeId}`;
}

/**
 * Разбор ключа фильтра. UUID проверяется здесь, а не только в схеме: ключ приходит из строки
 * запроса, и «разобрался» обязано означать «этим можно отбирать», иначе мусор доехал бы до SQL.
 */
export function parseClassificationFilterKey(
  key: string | null | undefined,
): { kind: 'type' | 'category'; id: string } | null {
  if (!key) return null;
  const kind = key[0] === 't' ? 'type' : key[0] === 'c' ? 'category' : null;
  if (kind === null) return null;
  const id = key.slice(1);
  return uuidSchema.safeParse(id).success ? { kind, id } : null;
}

/**
 * Канонический вид набора для строки запроса: дедупликация, сортировка по самому ключу, запятая.
 *
 * Сортировка именно по ключу, а не по порядку вариантов в списке: справочника в памяти может ещё
 * не быть, и один и тот же выбор давал бы две разные строки — два ключа кэша и два запроса там,
 * где вопрос один. Пустой набор даёт `undefined`, чтобы параметр не уезжал вовсе: пустая строка и
 * отсутствие параметра означают одно, а лишний параметр — третий ключ кэша.
 */
export function serializeClassificationFilter(keys: string[]): string | undefined {
  const unique = [...new Set(keys)].sort();
  return unique.length === 0 ? undefined : unique.join(',');
}

/** Разобранный набор: две ветки отбора — «весь тип» и «одна категория», объединяемые по ИЛИ. */
export interface ClassificationFilter {
  typeIds: string[];
  categoryIds: string[];
}

/**
 * Набор в query-строке — через запятую, тем же приёмом, что действия аудита (`auditActionsSchema`):
 * повторённый параметр `classifications=a&classifications=b` Fastify разбирает в массив только
 * пока значений больше одного, и на единственной выбранной позиции схема получила бы строку — тип
 * фильтра зависел бы от того, сколько галочек поставил человек.
 *
 * Пустая строка означает «фильтра нет», а не ошибку: снятые галочки — обычное состояние формы, и
 * отвечать на них 400-й значило бы заставлять портал вычищать параметр. Мусорный ключ, наоборот,
 * отвергается: набор собирается из справочника, и опечатка в ключе должна быть видна отказом, а не
 * молча суженным списком.
 */
export const classificationFilterSchema = z
  .string()
  // Предел длины — от потолка набора: 60 ключей с разделителями плюс запас. Строка длиннее этого
  // не бывает у портала вовсе, и разбирать её по запятым уже незачем.
  .max(CLASSIFICATION_FILTER_MAX * (CLASSIFICATION_FILTER_KEY_LENGTH + 1) + 20)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(
    z
      .array(z.string())
      .max(CLASSIFICATION_FILTER_MAX, `Не больше ${CLASSIFICATION_FILTER_MAX} позиций в фильтре`),
  )
  .transform((keys, ctx): ClassificationFilter => {
    const typeIds: string[] = [];
    const categoryIds: string[] = [];
    for (const key of keys) {
      const parsed = parseClassificationFilterKey(key);
      if (parsed === null) {
        ctx.addIssue({ code: 'custom', message: `Неизвестный ключ фильтра: ${key}` });
        continue;
      }
      if (parsed.kind === 'type') typeIds.push(parsed.id);
      else categoryIds.push(parsed.id);
    }
    return { typeIds, categoryIds };
  });

/** Пустой набор — это «фильтра нет»: в условие выборки он не превращается вовсе. */
export function isClassificationFilterEmpty(f: ClassificationFilter | undefined): boolean {
  return f === undefined || (f.typeIds.length === 0 && f.categoryIds.length === 0);
}

/** Что нужно проверке «две формы сразу»; остальные поля списочного запроса ей безразличны. */
interface ClassificationFormQuery {
  classifications?: ClassificationFilter | undefined;
  vehicleTypeId?: string | undefined;
  vehicleCategoryId?: string | null | undefined;
}

/**
 * Запрет задавать технику двумя формами сразу — набором и старой парой `vehicleTypeId` /
 * `vehicleCategoryId`. Обе формы приняты одновременно означали бы выбор приоритета за клиента, а
 * молча выигравшая форма — это ровно тот дефект, ради которого набор и заводился.
 *
 * Вешается на **итоговые** схемы, уже после всех `.extend()`: zod переносит проверки в
 * расширенную схему, и наследованная от списочной проверка сработала бы у ленты и журнала вторым
 * разом. Поэтому производные схемы расширяют базу без проверки, а проверку ставят себе сами.
 */
export function withSingleClassificationForm<T extends z.ZodType<ClassificationFormQuery>>(
  schema: T,
): T {
  return schema.superRefine((q, ctx) => {
    const filter = q.classifications;
    // Проверки объекта zod выполняет и тогда, когда само поле не разобралось: на месте набора в
    // этот момент лежит промежуточное значение, а отказ по нему уже собран — второй жалобы на ту
    // же строку человеку не нужно.
    if (filter === undefined || !Array.isArray(filter.typeIds)) return;
    if (isClassificationFilterEmpty(filter)) return;
    // Старая пара задана любой своей половиной: и «только тип», и «только категория» — это уже
    // ответ на тот же вопрос, что и набор.
    const legacyPair = q.vehicleTypeId ?? q.vehicleCategoryId ?? undefined;
    if (legacyPair === undefined) return;
    ctx.addIssue({
      code: 'custom',
      path: ['classifications'],
      message: 'Фильтр по технике задан дважды',
    });
  });
}
