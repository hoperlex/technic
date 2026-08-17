import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_DUE_SOON_KM,
  MAINTENANCE_INTERVAL_KM,
  maintenanceState,
  type MaintenanceBasis,
} from '@technic/contracts';

/**
 * Состояние ТО (план «Показания техники», Р11в, Р12, Р13, Р24).
 *
 * Проверяется правило, а не арифметика: оно **асимметрично** — оба флага незнания могут только
 * увеличить фактический пробег, поэтому превышение норматива достоверно при любых флагах, а вот
 * «ещё не пора» при поднятом флаге недостоверно и обязано читаться как «неизвестно». Ошибка в эту
 * сторону тихая: машина с разорванной цепочкой показывала бы зелёное «ок» ровно до того дня, когда
 * её привезут на эвакуаторе.
 */

/** Полный ввод: каждое поле называется в кейсе явно — умолчание здесь пряталo бы половину правила. */
function state(input: {
  basis?: MaintenanceBasis;
  kmSince: number | null;
  chainBroken?: boolean;
  lowerBound?: boolean;
  intervalKm?: number;
}) {
  return maintenanceState({
    basis: input.basis ?? 'odometer',
    kmSince: input.kmSince,
    chainBroken: input.chainBroken ?? false,
    lowerBound: input.lowerBound ?? false,
    ...(input.intervalKm === undefined ? {} : { intervalKm: input.intervalKm }),
  });
}

const DUE_SOON_FROM = MAINTENANCE_INTERVAL_KM - MAINTENANCE_DUE_SOON_KM;

describe('состояние ТО: чистые ветки', () => {
  it('тип техники без ТО не спрашивают ни о чём: not_tracked при любых числах и флагах', () => {
    // Умолчание справочника — `none` (Р13), и оно безопасное: пока типы не размечены, портал не
    // требует обслуживания ни с кого. Поэтому проверка идёт первой и перекрывает даже просрочку:
    // «не ведём» — это ответ, а не отсутствие ответа.
    expect(state({ basis: 'none', kmSince: null })).toBe('not_tracked');
    expect(state({ basis: 'none', kmSince: 0 })).toBe('not_tracked');
    expect(state({ basis: 'none', kmSince: 99_000, chainBroken: true, lowerBound: true })).toBe(
      'not_tracked',
    );
  });

  it('нет числа — unknown: записи ТО нет либо цепочку не из чего построить', () => {
    expect(state({ kmSince: null })).toBe('unknown');
    expect(state({ kmSince: null, chainBroken: true })).toBe('unknown');
    expect(state({ kmSince: null, lowerBound: true })).toBe('unknown');
  });

  it('свежее ТО — ok, приближение к нормативу — due_soon', () => {
    expect(state({ kmSince: 0 })).toBe('ok');
    expect(state({ kmSince: 4_200 })).toBe('ok');
    expect(state({ kmSince: DUE_SOON_FROM + 500 })).toBe('due_soon');
  });

  it('превышение норматива — overdue', () => {
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM + 1 })).toBe('overdue');
    expect(state({ kmSince: 25_000 })).toBe('overdue');
  });
});

describe('состояние ТО: границы', () => {
  /**
   * Обе границы включающие, и обе — там, где ошибка на единицу меняет ответ. `due_soon` начинается
   * ровно за `MAINTENANCE_DUE_SOON_KM` до норматива, `overdue` — ровно на нормативе: «10 000 из
   * 10 000» это уже пора, а не «скоро».
   */
  it('9 000 — уже due_soon, 8 999 — ещё ok', () => {
    expect(state({ kmSince: DUE_SOON_FROM })).toBe('due_soon');
    expect(state({ kmSince: DUE_SOON_FROM - 1 })).toBe('ok');
  });

  it('ровно норматив — уже overdue, на километр меньше — ещё due_soon', () => {
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM })).toBe('overdue');
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM - 1 })).toBe('due_soon');
  });
});

describe('состояние ТО: асимметрия незнания (Р11в)', () => {
  /**
   * Главное свойство правила. Флаг говорит «известного меньше, чем проехано», то есть смещает
   * оценку только вверх, — и что из этого следует, зависит от стороны норматива.
   */
  it('ниже норматива с флагом — unknown, а не ok: «не меньше 8 340 км» это не «ещё рано»', () => {
    expect(state({ kmSince: 8_340, chainBroken: true })).toBe('unknown');
    expect(state({ kmSince: 8_340, lowerBound: true })).toBe('unknown');
    expect(state({ kmSince: 0, chainBroken: true })).toBe('unknown');
  });

  it('флаг съедает и due_soon: приближение с разорванной цепочкой — тоже unknown', () => {
    expect(state({ kmSince: DUE_SOON_FROM, lowerBound: true })).toBe('unknown');
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM - 1, chainBroken: true })).toBe('unknown');
  });

  it('от норматива и выше — overdue достоверно, при любых флагах', () => {
    // Проехать БОЛЬШЕ известного машина могла, меньше — нет: превышение флагами не отменяется.
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM, chainBroken: true })).toBe('overdue');
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM, lowerBound: true })).toBe('overdue');
    expect(state({ kmSince: 14_000, chainBroken: true, lowerBound: true })).toBe('overdue');
  });
});

describe('норматив приходит числом, а не выводится из машины (Р24)', () => {
  /**
   * Переезд «константа кода → поле у типа техники» обязан быть заполнением `intervalKm`, а не
   * правкой расчёта. Поэтому проверяется, что все три границы едут вместе с нормативом, а порог
   * «скоро» остаётся своим числом километров — долей норматива он никогда не был.
   */
  it('свой интервал сдвигает и просрочку, и приближение', () => {
    expect(state({ kmSince: 5_000, intervalKm: 5_000 })).toBe('overdue');
    expect(state({ kmSince: 4_100, intervalKm: 5_000 })).toBe('due_soon');
    expect(state({ kmSince: 3_900, intervalKm: 5_000 })).toBe('ok');
  });

  it('без своего интервала берётся константа парка — 10 000 км (Р12)', () => {
    expect(MAINTENANCE_INTERVAL_KM).toBe(10_000);
    expect(MAINTENANCE_DUE_SOON_KM).toBe(1_000);
    expect(state({ kmSince: MAINTENANCE_INTERVAL_KM, intervalKm: MAINTENANCE_INTERVAL_KM })).toBe(
      state({ kmSince: MAINTENANCE_INTERVAL_KM }),
    );
  });
});
