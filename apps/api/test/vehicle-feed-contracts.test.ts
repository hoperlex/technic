import { describe, expect, it } from 'vitest';
import {
  FEED_COMMON_SORT_FIELDS,
  feedKindLabels,
  onlyWeeklyRows,
  parseFeedNumberSearch,
  vehicleFeedQuerySchema,
  weeklyRowsExcludedBy,
  type VehicleFeedQuery,
} from '@technic/contracts';

/**
 * Контракты ленты «Заказ автотехники»: заказы ТС и недельные заявки одним списком.
 *
 * Проверяется ровно то, что разъедется первым, если правило переписать в одном месте из двух:
 * разбор номера (две независимые последовательности, «12» означает и ТС-12, и НЗ-12) и правило
 * «фильтр без соответствия у недельной заявки исключает её строки целиком». Второе — не
 * оптимизация выборки, а ответ человеку: список под фильтром «В работе» не должен возвращать
 * документы, у которых такого статуса не бывает вовсе.
 */

/** Минимальный запрос ленты: только то, что схема требует сама. */
function query(patch: Partial<VehicleFeedQuery> = {}): VehicleFeedQuery {
  return { ...vehicleFeedQuerySchema.parse({}), ...patch } as VehicleFeedQuery;
}

describe('лента заказов и недельных заявок', () => {
  describe('поиск по номеру', () => {
    it('«НЗ-12» ищет неделю, «ТС-341» и голое число — заказ', () => {
      expect(parseFeedNumberSearch('НЗ-12')).toEqual({ kind: 'weekly', num: 12 });
      expect(parseFeedNumberSearch('нз 12')).toEqual({ kind: 'weekly', num: 12 });
      expect(parseFeedNumberSearch('ТС-341')).toEqual({ kind: 'order', num: 341 });
      // Без префикса — заказ: так набирают в девяти случаях из десяти, а недельную заявку и в
      // разговоре называют по префиксу.
      expect(parseFeedNumberSearch('341')).toEqual({ kind: 'order', num: 341 });
    });

    it('пустой и бессмысленный ввод номером не считается', () => {
      expect(parseFeedNumberSearch('')).toBeUndefined();
      expect(parseFeedNumberSearch('НЗ-')).toBeUndefined();
      expect(parseFeedNumberSearch('—')).toBeUndefined();
    });
  });

  describe('какие фильтры исключают недельные строки', () => {
    it('фильтры, которых у недельного документа нет, убирают его из выдачи', () => {
      // Каждый по отдельности: сработать должен любой, а не только их сочетание.
      expect(weeklyRowsExcludedBy(query({ status: 'confirmed' }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ requestType: 'special_equipment' }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ vehicleTypeId: crypto.randomUUID() }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ vehicleCategoryId: crypto.randomUUID() }))).toBe(true);
      // Набор позиций спрашивает о том же, чего у недельного документа нет вовсе: сколько бы
      // позиций в вопросе ни стояло, его строки уходят из выдачи целиком.
      expect(
        weeklyRowsExcludedBy(
          query({ classifications: { typeIds: [crypto.randomUUID()], categoryIds: [] } }),
        ),
      ).toBe(true);
      expect(
        weeklyRowsExcludedBy(
          query({ classifications: { typeIds: [], categoryIds: [crypto.randomUUID()] } }),
        ),
      ).toBe(true);
      // Назначенная машина (ADR 0098): технику ставят на заказы, созданные из состава недели, а
      // сам документ остаётся планом — назначения у него не бывает вовсе.
      expect(weeklyRowsExcludedBy(query({ vehicleId: crypto.randomUUID() }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ departmentId: crypto.randomUUID() }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ num: 341 }))).toBe(true);
      // Архив (ADR 0070) — вкладка удалённых заказов; недельная заявка не удаляется вовсе.
      expect(weeklyRowsExcludedBy(query({ archive: 'only' }))).toBe(true);
      expect(weeklyRowsExcludedBy(query({ kind: 'order' }))).toBe(true);
    });

    it('фильтры, у которых соответствие есть, недельные строки оставляют', () => {
      expect(weeklyRowsExcludedBy(query())).toBe(false);
      // Пустой набор — это «фильтра нет»: снятые галочки недельные строки не выгоняют.
      expect(
        weeklyRowsExcludedBy(query({ classifications: { typeIds: [], categoryIds: [] } })),
      ).toBe(false);
      expect(weeklyRowsExcludedBy(query({ objectId: crypto.randomUUID() }))).toBe(false);
      expect(weeklyRowsExcludedBy(query({ search: 'экскаватор' }))).toBe(false);
      expect(weeklyRowsExcludedBy(query({ approved: true }))).toBe(false);
      expect(weeklyRowsExcludedBy(query({ dateFrom: '2026-08-17', dateTo: '2026-08-23' }))).toBe(
        false,
      );
    });

    it('вид документа и неделя оставляют в ленте только недельные строки', () => {
      expect(onlyWeeklyRows(query({ kind: 'weekly' }))).toBe(true);
      expect(onlyWeeklyRows(query({ weekStart: '2026-08-17' }))).toBe(true);
      expect(onlyWeeklyRows(query())).toBe(false);
      expect(onlyWeeklyRows(query({ objectId: crypto.randomUUID() }))).toBe(false);
    });
  });

  it('неделя задаётся календарным днём, вид документа — из двух значений', () => {
    expect(() => vehicleFeedQuerySchema.parse({ weekStart: '17.08.2026' })).toThrow();
    expect(() => vehicleFeedQuerySchema.parse({ kind: 'weekly_request' })).toThrow();
    expect(vehicleFeedQuerySchema.parse({ kind: 'weekly', weekStart: '2026-08-17' })).toMatchObject(
      {
        kind: 'weekly',
        weekStart: '2026-08-17',
      },
    );
  });

  /**
   * Набор позиций лента получает расширением списочной схемы — и вместе с ним обязана получить
   * запрет задавать технику двумя формами сразу. Разъедься это, лента осталась бы единственным
   * списком, где старая пара и набор молча уживаются в одном запросе.
   */
  it('лента принимает набор позиций и отвергает его вместе со старой парой', () => {
    const TYPE = '33333333-3333-4333-8333-333333333333';
    const CATEGORY = '44444444-4444-4444-8444-444444444444';
    expect(
      vehicleFeedQuerySchema.parse({ classifications: `t${TYPE},c${CATEGORY}` }),
    ).toMatchObject({ classifications: { typeIds: [TYPE], categoryIds: [CATEGORY] } });
    expect(
      vehicleFeedQuerySchema.safeParse({ classifications: `t${TYPE}`, vehicleTypeId: TYPE })
        .success,
    ).toBe(false);
    expect(vehicleFeedQuerySchema.safeParse({ vehicleTypeId: TYPE }).success).toBe(true);
  });

  it('подписи видов документа заданы обеим строкам ленты', () => {
    expect(feedKindLabels.order).toBeTruthy();
    expect(feedKindLabels.weekly).toBeTruthy();
  });

  /**
   * Номера в общих ключах сортировки нет намеренно: «НЗ-12» и «ТС-12» не лежат на одной числовой
   * оси, и лента сортирует по номеру парой «вид, номер». Появись `num` здесь — список выдал бы
   * недельную заявку за заказ с тем же числом.
   */
  it('общие ключи сортировки не включают номер', () => {
    expect(FEED_COMMON_SORT_FIELDS).not.toContain('num');
    expect(FEED_COMMON_SORT_FIELDS).toContain('createdAt');
  });
});
