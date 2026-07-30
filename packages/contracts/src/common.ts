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
