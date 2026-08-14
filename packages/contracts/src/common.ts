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
 * Что список делает с архивными (удалёнными) строками — ADR 0070.
 *
 * Три состояния, а не два флага: «показать вместе с живыми» и «показать только их» отвечают на
 * разные вопросы, а парой булевых они дают четвёртое сочетание («и только архив, и без архива»),
 * на которое ответа нет. Значение по умолчанию — `exclude`: список без архива, каким его видит
 * тот, у кого права на архив нет вовсе.
 */
export const ARCHIVE_FILTERS = ['exclude', 'include', 'only'] as const;
export type ArchiveFilter = (typeof ARCHIVE_FILTERS)[number];
export const archiveFilterSchema = z.enum(ARCHIVE_FILTERS).default('exclude');

/**
 * Булев фильтр в query-строке: `'true'` / `'false'` и «параметра нет» — три разных состояния.
 * Отсутствие значит «не фильтровать», а не `false`: снятый переключатель и выбранное «нет» —
 * разные вопросы к списку.
 */
export const booleanFlagSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

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

// ── Телефон (ADR 0066) ──
// Номер хранится одним видом — десять цифр без кода страны, — а печатается и показывается другим:
// «+7 (900) 000-00-00». Между ними ровно две функции: `normalizePhone` на входе и `formatPhone`
// на выходе. Ни та, ни другая не знает, чей это номер: правило одно на учётку, водителя,
// организацию, склад и контакт по заявке.

/** Столько цифр в номере без кода страны: три кода региона плюс семь своих. */
export const PHONE_DIGITS = 10;

/** Что показать человеку, когда номер не сходится: не «некорректный», а какой ждут. */
export const PHONE_FORMAT_MESSAGE = 'Телефон в формате +7 (900) 000 00 00';

/** Пустая маска — ею подписано поле ввода и по ней же читается вид номера. */
export const PHONE_PLACEHOLDER = '+7 (___) ___ __ __';

/**
 * Номер к виду хранения: десять цифр без кода страны, `null` — не номер.
 *
 * Регион в портале всегда +7, поэтому ведущая `7` или `8` одиннадцатизначного номера снимается:
 * этим два российских написания и различаются, а десять оставшихся цифр у них общие. Всё
 * остальное — скобки, пробелы, дефисы, `+` — разделители, которые несёт написание, а не номер.
 *
 * Строже, чем прежняя проверка «цифр хотя бы пять» (ADR 0043): городской с добавочным и
 * пятизначный внутренний номер больше не проходят. Так и задумано — иначе единого вида не
 * получается ни в списке, ни в путевом листе, — но это и цена решения: такой контакт придётся
 * записать по-другому.
 */
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const local =
    digits.length === PHONE_DIGITS + 1 && (digits[0] === '7' || digits[0] === '8')
      ? digits.slice(1)
      : digits;
  return local.length === PHONE_DIGITS ? local : null;
}

/**
 * Номер к виду для человека: «+7 (900) 000 00 00». Работает и от хранимых десяти цифр, и от
 * любого написания того же номера — вывод от этого не зависит.
 *
 * Что не сводится к номеру, возвращается как есть, а не прячется: в базе остались записи,
 * заведённые до нормализации (миграция `0095` их не трогала), и показать «8 (495) 123-45-67
 * доб. 12» как есть — единственный способ по нему дозвониться. Пустая строка — «не указан».
 */
export function formatPhone(value: string): string {
  const local = normalizePhone(value);
  if (local === null) return value;
  return `+7 (${local.slice(0, 3)}) ${local.slice(3, 6)} ${local.slice(6, 8)} ${local.slice(8)}`;
}

/**
 * Контактный телефон: принимается любое написание, наружу выходят десять цифр. Нормализация
 * стоит в схеме, а не в обработчике ручки, — тогда мимо неё не пройдёт ни форма, ни импорт, ни
 * прямой запрос к API, и в колонке не заводится второй формат.
 */
export const contactPhoneSchema = z
  .string()
  .trim()
  .min(1, 'Укажите контактный телефон')
  .max(50)
  .transform((v) => normalizePhone(v) ?? v)
  .pipe(z.string().regex(/^\d{10}$/, PHONE_FORMAT_MESSAGE));

/**
 * Тот же телефон там, где его вправе не оставить: пустая строка — «не указан» (телефон учётки,
 * ADR 0043). Правило то же самое — необязательность не означает, что вместо номера годится «-»
 * или «нет»: такое поле хуже пустого, потому что выглядит заполненным.
 */
export const optionalPhoneSchema = z
  .string()
  .trim()
  .max(50)
  .transform((v) => (v === '' ? '' : (normalizePhone(v) ?? v)))
  .pipe(z.string().refine((v) => v === '' || /^\d{10}$/.test(v), PHONE_FORMAT_MESSAGE));

const contactSchemas = {
  name: contactNameSchema,
  phone: contactPhoneSchema,
  optionalPhone: optionalPhoneSchema,
};

/**
 * Цифры номера для поиска. Ищут по номеру так, как его помнят или видят на экране — «+7 (926)
 * 123-45-67», «8 926 123 45 67», «9261234567» или один хвост «123-45-67», — и найти запись
 * обязано любое из написаний: сравниваются одни цифры, подстрокой.
 *
 * Очистку цифр не заменить на `normalizePhone`: тот берёт номер целиком, а здесь на входе чаще
 * кусок. Ведущая `7`/`8` одиннадцатизначного запроса отбрасывается — ровно этим два российских
 * написания и различаются; у восьмизначного «8 (495) 12-34» первая цифра часть номера, и терять
 * её нельзя. Колонка после нормализации (миграция `0095`) хранит десять цифр, но записи старше
 * неё остались свободным текстом — поиск подстрокой находит и их.
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
