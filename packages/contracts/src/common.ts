import { z } from 'zod';

export const PAGE_SIZES = [50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 100;

export const uuidSchema = z.string().uuid();

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/**
 * Дата без времени, строго YYYY-MM-DD. Через JS `Date` не преобразуется намеренно: срок действия
 * документа и дата подачи — это календарные сутки, а не момент времени, и часовой пояс смещал бы
 * их на день. Дополнительная проверка отсеивает «2026-02-31» — регулярное выражение его пропускает.
 */
export const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
  .refine((s) => {
    const parts = s.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Некорректная дата');

/**
 * Базовая схема списочного запроса. `sortFields` — allowlist сортируемых полей
 * (клиент не передаёт произвольные SQL-идентификаторы).
 */
export function baseListQuery(sortFields: readonly string[]) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .default(DEFAULT_PAGE_SIZE)
      .refine((v) => (PAGE_SIZES as readonly number[]).includes(v), {
        message: 'pageSize должен быть одним из: 50, 100, 200, 500',
      }),
    sortBy: z
      .string()
      .optional()
      .refine((v) => v === undefined || sortFields.includes(v), {
        message: 'Недопустимое поле сортировки',
      }),
    sortOrder: sortOrderSchema.default('desc'),
    search: z.string().trim().max(200).optional(),
  });
}

// ── Контакт ответственного по заявке ──
// Пара «кто отвечает + по какому телефону» нужна каждому модулю заявок, поэтому подсхемы общие:
// правило одно, а мест, где контакт заводят, три (спецтехника, грузоперевозка, вывоз мусора).

/** ФИО ответственного — свободный текст: им бывает и человек заказчика, которого нет в справочнике. */
export const contactNameSchema = z.string().trim().min(1, 'Укажите ответственного').max(200);

/**
 * Единственное, что делает телефон телефоном: цифр в нём столько, чтобы по нему дозвонились.
 * Формат при этом намеренно свободный — см. `contactPhoneSchema`.
 */
const hasEnoughDigits = (v: string) => (v.match(/\d/g) ?? []).length >= 5;

/**
 * Контактный телефон. Формат намеренно свободный: в заявку пишут и «+7 926 123-45-67», и
 * «8(495)123-45-67 доб. 12», и требовать единый вид значило бы заставлять человека править
 * то, что он только что прочитал в переписке.
 */
export const contactPhoneSchema = z
  .string()
  .trim()
  .min(1, 'Укажите контактный телефон')
  .max(50)
  .refine(hasEnoughDigits, 'Некорректный телефон');

/**
 * Тот же телефон там, где его вправе не оставить: пустая строка — «не указан» (телефон учётки,
 * ADR 0043). Правило проверки одно и то же — необязательность не означает, что вместо номера
 * годится «-» или «нет»: такое поле хуже пустого, потому что выглядит заполненным.
 */
export const optionalPhoneSchema = z
  .string()
  .trim()
  .max(50)
  .refine((v) => v === '' || hasEnoughDigits(v), 'Некорректный телефон');

const contactSchemas = {
  name: contactNameSchema,
  phone: contactPhoneSchema,
  optionalPhone: optionalPhoneSchema,
};

/**
 * Цифры номера для поиска. Хранится телефон так, как его ввели (см. `contactPhoneSchema`),
 * поэтому «+7 (926) 123-45-67», «8 926 123 45 67» и «9261234567» — одна и та же запись, и найти
 * её обязано любое из написаний: сравниваются одни цифры, подстрокой.
 *
 * Ведущая `7`/`8` одиннадцатизначного номера отбрасывается — ровно этим два российских написания
 * и различаются, а оставшиеся десять цифр входят в любое из них. Обратное преобразование не
 * нужно: цифры колонки сравниваются с этой подстрокой, и «79261234567» содержит «9261234567»
 * так же, как «89261234567».
 *
 * Пустая строка — искать по номеру нечего: в запросе меньше трёх цифр. Порог существеннее, чем
 * кажется, — без него «Иванов 7» отобрал бы каждого, у кого в номере есть семёрка, то есть
 * почти всех.
 */
export function phoneSearchDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  const local =
    digits.length === 11 && (digits[0] === '7' || digits[0] === '8') ? digits.slice(1) : digits;
  return local.length >= 3 ? local : '';
}

/**
 * Что не так с введённым контактом; `null` — годится. Форма проверяет теми же схемами, что и
 * сервер, но zod в неё не тащится: правило одно, а зависимость лишняя (тем же приёмом, что и
 * `namePartIssue`).
 */
export function contactIssue(value: string, kind: keyof typeof contactSchemas): string | null {
  const parsed = contactSchemas[kind].safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Некорректное значение');
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
}
