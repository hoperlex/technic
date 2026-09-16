import type { WasteStatsFigures } from '@technic/contracts';
import { formatMoney } from '../../utils/format';

/**
 * Числа вкладки «Статистика» вывоза (план `docs/waste-stats-tab-plan.md`) — одним местом на
 * таблицу и на окно детализации: одна и та же величина на двух экранах обязана выглядеть
 * одинаково, иначе её начинают сверять глазами.
 */

/**
 * «412,5 м³». Разряды пробелами, дробная часть — до трёх знаков и без хвостовых нулей: объём
 * закрытия хранится с точностью 0,001, но «40 м³» пишут именно так, а не «40,000».
 */
export function volumeText(value: number): string {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} м³`;
}

/**
 * Подписи-доли под числом (Р3, Р4). Пустой список — доли нет вовсе, и подписывать нечего: строка
 * «в т. ч. заказано 0 м³» сообщала бы о наличии того, чего нет.
 *
 * Возвращает строки, а не готовую разметку: их печатают и таблица, и окно, а верстка у них разная.
 */
export function volumeNotes(a: WasteStatsFigures): string[] {
  const notes: string[] = [];
  if (a.volumeOrderedM3 > 0) notes.push(`в т. ч. заказано ${volumeText(a.volumeOrderedM3)}`);
  return notes;
}

export function costNotes(a: WasteStatsFigures): string[] {
  const notes: string[] = [];
  if (a.costEstimated > 0) notes.push(`в т. ч. оценка ${formatMoney(a.costEstimated)}`);
  /*
   * «Без цены» — про заявки, которые не удалось оценить вовсе. Стоит рядом с деньгами намеренно:
   * ноль в денежной клетке обязан означать бесплатную работу, а не незаполненный прайс.
   */
  if (a.unpricedRequests > 0) notes.push(`${a.unpricedRequests} без цены`);
  return notes;
}

/**
 * Подпись к подтверждённому объёму. Талон с непрочитанной графой не ноль, а неизвестность (Р4):
 * без этой строки недостача искалась бы в закрытии, а лежит она в смазанной бумаге.
 */
export function confirmedNotes(a: WasteStatsFigures): string[] {
  const notes: string[] = [];
  const n = a.ticketsWithoutVolume;
  if (n > 0) notes.push(`объём не прочитан у ${n} ${n === 1 ? 'талона' : 'талонов'}`);
  /*
   * Часть подтверждённого объёма оценить нечем — стоимость занижена, и молчать об этом нельзя:
   * заниженная сумма без пометки выглядит посчитанной (Р5). Когда цены нет у ВСЕГО объёма,
   * подписи не будет — там в соседней клетке стоит прочерк, и он говорит сам.
   */
  if (a.confirmedVolumeUnpricedM3 > 0 && a.confirmedVolumeUnpricedM3 < a.confirmedVolumeM3) {
    notes.push(`без цены ${volumeText(a.confirmedVolumeUnpricedM3)}`);
  }
  return notes;
}
