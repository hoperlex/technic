import dayjs from 'dayjs';
import { wasteFactLabel, type WasteRequestDto } from '@technic/contracts';
import { formatMoney } from '@shared/lib';

/**
 * What the request holds now, said after a 409 reload (snow-removal plan, §3.2): the person decides
 * to retry or to discard their uploads, and needs the saved fact and paper to decide it.
 */
export function savedFactLine(request: WasteRequestDto): string {
  const fact = request.completion;
  const parts = fact
    ? [
        `вывезено ${wasteFactLabel(fact)}`,
        fact.totalCost != null ? formatMoney(fact.totalCost) : 'без стоимости',
        // A calendar day, not an instant: formatted as is, with no time zone to shift it.
        fact.removedOn ? `дата вывоза ${dayjs(fact.removedOn).format('DD.MM.YYYY')}` : null,
      ].filter(Boolean)
    : ['факта выполнения нет'];
  return `Сейчас сохранено: ${parts.join(' · ')}; талонов приложено: ${request.tickets.length}.`;
}
