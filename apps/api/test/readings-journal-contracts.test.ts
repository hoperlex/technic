import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, readingJournalQuerySchema } from '@technic/contracts';

/**
 * Запрос журнала показаний (план «Показания техники», Р25): период плюс страница.
 *
 * Проверяется договор ручки, а не разбор zod: журнал листается теми же параметрами, что и любой
 * список портала, — и параметра, которого сервер не слышит, в нём быть не должно. Строка запроса
 * приходит текстом, поэтому числа обязаны приводиться сами: иначе первое же листание уехало бы в
 * отказ разбора.
 */

const PERIOD = { from: '2026-07-01', to: '2026-07-31' };

describe('контракт запроса журнала показаний', () => {
  it('без страницы спрашивается первая, обычного для портала размера', () => {
    expect(readingJournalQuerySchema.parse(PERIOD)).toEqual({
      ...PERIOD,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it('числа страницы приходят строкой и приводятся сами', () => {
    expect(
      readingJournalQuerySchema.parse({ ...PERIOD, page: '3', pageSize: '200' }),
    ).toMatchObject({ page: 3, pageSize: 200 });
  });

  it('размер страницы — из общего списка портала, а нумерация начинается с единицы', () => {
    expect(() => readingJournalQuerySchema.parse({ ...PERIOD, pageSize: 37 })).toThrow();
    expect(() => readingJournalQuerySchema.parse({ ...PERIOD, page: 0 })).toThrow();
  });

  it('порядок дат проверяется, как и у сводки: пустой отрезок — опечатка, а не фильтр', () => {
    expect(() =>
      readingJournalQuerySchema.parse({ from: '2026-07-31', to: '2026-07-01' }),
    ).toThrow();
  });

  it('сортировки у журнала нет: лишний параметр отклоняется, а не молча пропадает', () => {
    // Порядок строк задан сервером (свежее сверху). Принятый и забытый `sortBy` обещал бы порядок,
    // которого не будет, — и разбираться с этим пришлось бы на экране, а не на границе ручки.
    expect(() =>
      readingJournalQuerySchema.parse({ ...PERIOD, sortBy: 'reportDate', sortOrder: 'asc' }),
    ).toThrow();
  });
});
