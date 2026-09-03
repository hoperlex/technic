import { z } from 'zod';
import { baseListQuery } from './common';

/**
 * Справочник моделей малой механизации — что можно взять в аренду (план
 * `docs/mechanization-models-directory-plan.md`, этап Э1; таблица — миграция 0249, наполнение —
 * 0250).
 *
 * Устроен как типы контейнеров: код, наименование, порядок, активность, — и по той же причине.
 * Отличие ровно одно и названо ниже: наименование уникально по НОРМАЛИЗОВАННОМУ ключу, потому что
 * «Виброплита реверсивная Wacker DPU 3070Н» и «Виброплита  реверсивная Wacker DPU 3070Н» — одна
 * модель, а не две, и вторую из них в справочнике не отличить глазами.
 *
 * Заявка механизации на справочник пока не ссылается: перевод подбора со свободной строки — этап
 * Э2 отдельным выкатом.
 */

export const MECH_MODEL_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

export const mechModelListQuerySchema = baseListQuery(MECH_MODEL_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/**
 * Формат кода — CHECK `mech_models_code_format_check`: латиница строчными, цифры и дефис только
 * МЕЖДУ частями. Коды порождаются транслитерацией наименования
 * (`vibroplita-reversivnaya-wacker-dpu-3070n`), поэтому kebab, а не snake, как у типов мусора.
 */
export const MECH_MODEL_CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

export const MECH_MODEL_CODE_MESSAGE =
  'Код — латинские строчные буквы и цифры, части через дефис (vibroplita-wacker-dpu-3070n)';

/**
 * Предел длины кода — 100 знаков, а не 50, как у типов контейнеров, и это не небрежность. Код
 * получается транслитерацией ВСЕГО наименования, а модель различает как раз его хвост: обрежь код
 * по длине — и «…-dpu-3060n» с «…-dpu-3070n» превратятся в один и тот же обрубок. Самый длинный
 * код присланного списка — 91 знак («Компрессорная винтовая электрическая стационарная станция
 * ЗИФ-СВЭ-5/0,7 G без кожуха»).
 */
export const MECH_MODEL_CODE_MAX = 100;

/**
 * Нормализованный ключ наименования — повторяет выражение GENERATED-колонки `mech_models.name_key`
 * (миграция 0249): регистр и повторные пробелы написание не различают, всё остальное различает.
 * Знак в знак то же выражение стояло у `mech_requests.kind_key` (0238) — ради переноса заявок на
 * ссылку; парная колонка снята уборкой Э3 (0256), и правило осталось одно, справочника.
 *
 * Копия правила здесь заведена сознательно и стоит одна: по ней сервер отвечает «модель с таким
 * наименованием уже есть» ДО вставки — человеческими словами, а не именем уникального индекса, — и
 * по ней же загрузка файлом отвергает строку, не отменяя весь файл ответом базы. Что копия не
 * разошлась с базой, проверяется на живой базе (`mech-models.db.test.ts`), а не на глаз.
 *
 * КЛАСС ПРОБЕЛЬНЫХ ВЫПИСАН РУКАМИ, И ЭТО НЕ ПЕДАНТИЗМ: `\s` в JavaScript ШИРЕ, чем `\s` в
 * Postgres, — он схлопывает и неразрывный пробел (U+00A0), а Postgres оставляет его как есть.
 * Наименование с неразрывным пробелом приезжает из Word и из почты запросто, и разойдись здесь
 * правило с базой — сервер отвечал бы «свободно», а индекс тут же отвергал вставку кодом 23505,
 * то есть пятисоткой. По той же причине края обрезаются только от пробелов: `btrim` без второго
 * аргумента снимает ровно их, а JS-`trim()` — ещё и неразрывный.
 */
export function mechModelNameKey(name: string): string {
  return name
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .replace(/^ +| +$/g, '')
    .toLowerCase();
}

export const mechModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // Пустой ключ отвергает CHECK `mech_models_name_key_not_blank_check`: наименование из одних
  // пробельных знаков не отличает одну модель от другой.
  .refine((n) => mechModelNameKey(n) !== '', 'Наименование не должно быть пустым');

export const createMechModelSchema = z
  .object({
    code: z.string().trim().min(1).max(MECH_MODEL_CODE_MAX).regex(MECH_MODEL_CODE, {
      message: MECH_MODEL_CODE_MESSAGE,
    }),
    name: mechModelNameSchema,
    sortOrder: z.coerce.number().int().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateMechModelInput = z.infer<typeof createMechModelSchema>;

// `code` — стабильный системный идентификатор, неизменяем после создания (единый принцип со
// справочниками типов контейнеров и типов мусора): по нему строку находит обмен файлом, и правка
// кода означала бы не переименование, а вторую запись рядом с брошенной первой. Удаления нет:
// деактивация через isActive, а насовсем — отдельной ручкой после деактивации (ADR 0060).
export const updateMechModelSchema = z
  .object({
    name: mechModelNameSchema.optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateMechModelInput = z.infer<typeof updateMechModelSchema>;

export interface MechModelDto {
  id: string;
  /** Системный ключ строки; человеку не показывается — он для обмена файлом и для ссылок. */
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
