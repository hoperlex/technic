import { officeEquipmentStateLabels, type OfficeEquipmentState } from '@technic/contracts';

/** Куда переехала техника: место и состояние одной строкой — по ней её и ищут. */
export function placeOf(objectCode: string, location: string, state: string): string {
  return [objectCode, location, state].filter(Boolean).join(' · ');
}

/**
 * Состояние стороны перемещения с уточнением (план п. 12, Р5): «у сотрудника (Иванов)».
 *
 * «На месте» словом не называется вовсе: место уже названо объектом и кабинетом, и тег «на месте»
 * рядом с ними ничего не добавляет. Уточнение показывается ровно там, где без него журнал
 * отвечает «была у сотрудника», не отвечая, у какого.
 */
export function stateOf(state: OfficeEquipmentState, note: string): string {
  if (state === 'on_site') return '';
  const label = officeEquipmentStateLabels[state];
  return note ? `${label} (${note})` : label;
}
