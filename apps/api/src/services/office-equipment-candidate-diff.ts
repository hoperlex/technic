import type { OfficeEquipmentCandidateDto, RequestChangeDto } from '@technic/contracts';
import { changeSet, EMPTY } from './request-diff';

/**
 * Что изменила правка сообщения о технике — метаданные аудита `officeEquipmentCandidate.update`
 * (план `docs/office-equipment-candidate-plan.md`, Р12, §11).
 *
 * Приём тот же, что у правки карточки парка (`officeEquipmentDiff`), и это не подражание форме:
 * правка кандидата ровно за тем и заведена, чтобы поправить НОМЕР («заявитель списал `O` вместо
 * `0`»), а запись «сообщение правили» без пары «было → стало» не отвечает на единственный вопрос,
 * ради которого журнал по этому событию и читают — «чей номер в заведённой карточке, автора или
 * проверяющего».
 *
 * СРАВНИВАЮТСЯ DTO, А НЕ КОЛОНКИ, и это здесь важнее, чем у соседей. Тип и площадка лежат в строке
 * ссылками, и дифф по ним дал бы «Тип: 3f1c… → 9a2e…» — строку, которую невозможно прочесть ни в
 * журнале, ни в разборе через полгода. DTO несёт названия, и берутся они тем же запросом, что и
 * ответ ручки, — то есть в точности те, которые проверяющий видел на экране.
 *
 * ШЕСТЬ ПОЛЕЙ И НИ ОДНОГО ИЗ УЧЁТА (Р7): отдела-владельца, даты покупки, гарантии и ссылки на
 * модель у кандидата нет вовсе — их проставляет форма подтверждения, и правкой сообщения они не
 * меняются. Отдельного поля «версия» в диффе тоже нет: она растёт при каждой правке всегда, и
 * строка «Версия: 2 → 3» стояла бы в каждой записи журнала, ничего не объясняя; версию несёт
 * отдельное поле метаданных.
 */
export interface OfficeEquipmentCandidateDiff {
  changes: RequestChangeDto[];
}

export function officeEquipmentCandidateDiff(
  before: OfficeEquipmentCandidateDto,
  after: OfficeEquipmentCandidateDto,
): OfficeEquipmentCandidateDiff {
  const set = changeSet();
  set.changed('equipmentType', before.equipmentType.name, after.equipmentType.name);
  set.changed('declaredModel', before.declaredModel, after.declaredModel);
  set.changed('serialNumber', before.serialNumber || EMPTY, after.serialNumber || EMPTY);
  set.changed('inventoryNumber', before.inventoryNumber || EMPTY, after.inventoryNumber || EMPTY);
  // Площадка — с кодом: названия объектов повторяются («Склад»), а по коду строку журнала
  // сопоставляют с заявкой и с карточкой парка.
  set.changed('object', objectLabel(before), objectLabel(after));
  set.changed('location', before.location, after.location);
  set.changed('comment', before.comment || EMPTY, after.comment || EMPTY);
  return { changes: set.changes };
}

function objectLabel(dto: OfficeEquipmentCandidateDto): string {
  return `${dto.object.code} · ${dto.object.name}`;
}

/** Подписи полей: их читает журнал, и они же должны совпадать с названиями в форме проверки. */
export const officeEquipmentCandidateFieldLabels: Record<string, string> = {
  equipmentType: 'Тип',
  declaredModel: 'Заявленная модель',
  serialNumber: 'Серийный номер',
  inventoryNumber: 'Инвентарный номер',
  object: 'Площадка',
  location: 'Место',
  comment: 'Комментарий',
};
