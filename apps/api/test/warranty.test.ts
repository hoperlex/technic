import { describe, expect, it } from 'vitest';
import {
  isWarrantyActive,
  WARRANTY_EXPIRING_DAYS,
  WARRANTY_STATES,
  warrantyDaysLeft,
  warrantyLabel,
  warrantyState,
  warrantyStateColors,
  warrantyToday,
} from '@technic/contracts';

/**
 * Гарантия (ADR 0085). Состояние считает одна функция на весь портал — справочник, карточку,
 * форму заявки и реестр гарантий, — и цена ошибки здесь не в исключении, а в расхождении: порог
 * «истекает скоро», разъехавшийся между экранами, показывает одну и ту же гарантию жёлтой в списке
 * и зелёной в карточке.
 *
 * Проверяются границы, потому что вся функция из них и состоит. «Сегодня» передаётся аргументом:
 * функции чистые, часы не подменяются — тест, который зависел бы от текущей даты, к тому же начал
 * бы падать через месяц.
 */

const TODAY = '2026-08-07';
/** Ровно порог: последний день, когда гарантия ещё «истекает скоро». */
const IN_30_DAYS = '2026-09-06';
/** На день дальше порога — уже спокойное «действует». */
const IN_31_DAYS = '2026-09-07';
const YESTERDAY = '2026-08-06';

describe('состояние гарантии', () => {
  it('день окончания входит в гарантию: сегодня — ещё «истекает», а не «истекла»', () => {
    expect(warrantyState(TODAY, TODAY)).toBe('expiring');
    expect(warrantyDaysLeft(TODAY, TODAY)).toBe(0);
    expect(isWarrantyActive(TODAY, TODAY)).toBe(true);
  });

  it('порог «истекает скоро» — ровно 30 дней, тридцать первый день ещё спокойный', () => {
    // Порог объявлен константой и совпадает с фильтром списка: даты ниже посчитаны от неё.
    expect(WARRANTY_EXPIRING_DAYS).toBe(30);
    expect(warrantyDaysLeft(IN_30_DAYS, TODAY)).toBe(WARRANTY_EXPIRING_DAYS);
    expect(warrantyState(IN_30_DAYS, TODAY)).toBe('expiring');
    expect(warrantyDaysLeft(IN_31_DAYS, TODAY)).toBe(WARRANTY_EXPIRING_DAYS + 1);
    expect(warrantyState(IN_31_DAYS, TODAY)).toBe('active');
    // Обе «живые»: «истекает» — это предупреждение, а не отказ в гарантийном обращении.
    expect(isWarrantyActive(IN_30_DAYS, TODAY)).toBe(true);
    expect(isWarrantyActive(IN_31_DAYS, TODAY)).toBe(true);
  });

  it('вчерашняя гарантия истекла, и остаток у неё отрицательный', () => {
    expect(warrantyState(YESTERDAY, TODAY)).toBe('expired');
    expect(warrantyDaysLeft(YESTERDAY, TODAY)).toBe(-1);
    expect(isWarrantyActive(YESTERDAY, TODAY)).toBe(false);
    // Давно истёкшая — то же состояние: «насколько давно» отвечает остаток, а не состояние.
    expect(warrantyState('2026-05-31', TODAY)).toBe('expired');
    expect(warrantyDaysLeft('2026-05-31', TODAY)).toBe(-68);
  });

  /**
   * «Срок не заведён» — не то же самое, что «гарантии нет»: портал не знает, была ли она вообще, и
   * показывать «истекла» вместо «неизвестно» значило бы утверждать то, чего он не знает.
   */
  it('пустой срок — «нет данных», а не истёкшая гарантия', () => {
    for (const until of [null, undefined, '']) {
      expect(warrantyState(until, TODAY), String(until)).toBe('none');
      expect(warrantyDaysLeft(until, TODAY), String(until)).toBeNull();
      expect(isWarrantyActive(until, TODAY), String(until)).toBe(false);
      expect(warrantyLabel(until, TODAY), String(until)).toBe('');
    }
  });

  it('нечитаемая дата тоже «нет данных», а не сегодняшний день', () => {
    // Неразобранная дата отвечает `none`, а не «1970-01-01», — иначе на пустом месте появлялась бы
    // истёкшая гарантия. Формат сюда доходит уже проверенным (`dateOnlySchema`), но функция общая
    // для портала и писем, и на чужой строке она не должна врать.
    for (const until of ['не дата', '07.08.2026', '2026-13-45']) {
      expect(warrantyState(until, TODAY), until).toBe('none');
      expect(warrantyDaysLeft(until, TODAY), until).toBeNull();
      expect(isWarrantyActive(until, TODAY), until).toBe(false);
    }
  });

  it('считаются календарные сутки — через границу месяца, года и високосный февраль', () => {
    expect(warrantyDaysLeft('2026-01-30', '2025-12-31')).toBe(30);
    expect(warrantyState('2026-01-30', '2025-12-31')).toBe('expiring');
    expect(warrantyDaysLeft('2028-03-01', '2028-02-28')).toBe(2);
    expect(warrantyState('2028-03-01', '2028-02-28')).toBe('expiring');
  });
});

describe('подпись и цвет гарантии', () => {
  it('подпись называет дату в привычном виде и подбирает слово под состояние', () => {
    expect(warrantyLabel(IN_31_DAYS, TODAY)).toBe('до 07.09.2026');
    expect(warrantyLabel(IN_30_DAYS, TODAY)).toBe('истекает 06.09.2026');
    expect(warrantyLabel(TODAY, TODAY)).toBe('истекает 07.08.2026');
    expect(warrantyLabel(YESTERDAY, TODAY)).toBe('истекла 06.08.2026');
  });

  /** Прочерк вместо пустого места ставит список: подпись не выдумывает «гарантии нет». */
  it('у «нет данных» подписи нет вовсе', () => {
    expect(warrantyLabel(null, TODAY)).toBe('');
    expect(warrantyLabel('мусор', TODAY)).toBe('');
  });

  it('цвет объявлен на каждое состояние, и «истекает» отличается от «действует»', () => {
    for (const state of WARRANTY_STATES) {
      expect(warrantyStateColors[state], state).toBeTruthy();
    }
    expect(warrantyStateColors.active).toBe('green');
    expect(warrantyStateColors.expiring).toBe('gold');
    // Истёкшая и незаполненная не кричат цветом: это не событие, а состояние строки.
    expect(warrantyStateColors.expired).toBe('default');
    expect(warrantyStateColors.none).toBe('default');
  });
});

describe('«сегодня» для гарантии', () => {
  /**
   * Сутки считаются по Москве, а не по часовому поясу сервера: гарантия действует «по такое-то
   * число», и в 00:30 МСК срок вчерашнего дня уже кончился, хотя по UTC ещё идёт вчера.
   */
  it('день берётся по московскому календарю', () => {
    expect(warrantyToday(new Date('2026-08-07T20:59:59Z'))).toBe('2026-08-07');
    expect(warrantyToday(new Date('2026-08-07T21:30:00Z'))).toBe('2026-08-08');
    expect(warrantyState('2026-08-07', warrantyToday(new Date('2026-08-07T21:30:00Z')))).toBe(
      'expired',
    );
    expect(warrantyState('2026-08-07', warrantyToday(new Date('2026-08-07T20:59:59Z')))).toBe(
      'expiring',
    );
  });
});
