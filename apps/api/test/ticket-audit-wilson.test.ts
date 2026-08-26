import { describe, expect, it } from 'vitest';
import { accuracyDenominator, accuracyRight, wilsonInterval } from '@technic/contracts';

/**
 * Доверительный интервал и знаменатель точности (план §3).
 *
 * Проверяется не «функция что-то вернула», а совпадение с числом из плана: макет §5.5 напечатан
 * как «49 / 52 94 % (интервал Уилсона 84–98 %)», и это же число сверяет
 * `docs/waste-ticket-audit-plan.check.py`. Разойдись портал с планом — на экране стояло бы одно, в
 * согласованном документе другое, и спорить было бы нечем. На редакции 2.1 интервал был посчитан
 * на глаз и разошёлся на два пункта; тест закрывает ровно эту дыру.
 */
describe('точность: интервал и знаменатель', () => {
  it('совпадает с числом из плана: 49 из 52 дают 84–98 %', () => {
    const { low, high } = wilsonInterval(49, 52);
    expect(Math.round(low * 100)).toBe(84);
    expect(Math.round(high * 100)).toBe(98);
  });

  it('на пустой выборке не делит на ноль', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it('интервал не выходит за границы доли', () => {
    // При полном согласии верхняя граница не может быть больше единицы, а при нуле верных нижняя
    // не может уйти ниже нуля: доля — не любое число, и интервал обязан жить в её границах.
    expect(wilsonInterval(5, 5).high).toBeLessThanOrEqual(1);
    expect(wilsonInterval(0, 5).low).toBeGreaterThanOrEqual(0);
  });

  it('знаменатель считает совпадения и разобранные расхождения, а не выданные проверки', () => {
    const row = {
      field: 'volumeM3' as const,
      matched: 14,
      diverged: 4,
      arbitrated: 2,
      machineRight: 0,
      checkerRight: 1,
      bothWrong: 1,
    };
    // Два расхождения ждут арбитра: они не верны и не неверны — их просто ещё не разобрали, и в
    // знаменатель им нельзя ни в каком виде.
    expect(accuracyDenominator(row)).toBe(16);
    expect(accuracyRight(row)).toBe(14);
  });
});
