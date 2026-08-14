import type { OfficeEquipmentDto, RequestChangeDto } from '@technic/contracts';
import { changeSet, EMPTY } from './request-diff';

/**
 * Что изменила правка карточки оргтехники — для ленты истории единицы (план
 * `office-equipment-mail-and-history-plan.md`, Р76).
 *
 * До этого аудит правки писался вовсе без метаданных, и «что именно поменяли» восстановить было
 * нечем: в ленте стояла бы строка «карточку правили» без ответа на вопрос, что стало с моделью,
 * номерами и владельцем. Механика общая с историями заявок (`request-diff`), здесь — перечень
 * полей этого справочника.
 *
 * **Гарантия поставщика в `changes` не входит.** Её изменение показывается событием гарантии
 * (Р77), и попади оно ещё и сюда, одно действие дало бы две строки ленты: «Гарантия: 01.02.2027 →
 * 01.02.2028» и «гарантия продлена». Правило выражено формой результата, а не соглашением: поле
 * возвращается отдельно, и «забыть исключить» его из списка попросту негде.
 */

/** Дата без времени (`YYYY-MM-DD`) в человеческом виде; через JS Date она бы поехала на день. */
function dateOnly(value: string | null): string {
  if (!value) return EMPTY;
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

/** Изменение срока гарантии поставщика: отдельным полем метаданных, а не строкой диффа. */
export interface WarrantyChange {
  from: string | null;
  until: string | null;
}

export interface OfficeEquipmentDiff {
  changes: RequestChangeDto[];
  /** Отсутствует, если срок не менялся: пустое поле в аудите значило бы «сняли гарантию». */
  warrantyChange?: WarrantyChange;
}

/**
 * Сравнивает карточку до и после правки. Объект здесь не сравнивается намеренно: правка его больше
 * не меняет — переезд это событие со своей ручкой (Р59), и строка «Объект: СУ-10 → СУ-14» в
 * истории означала бы перемещение, которого не было.
 */
export function officeEquipmentDiff(
  before: OfficeEquipmentDto,
  after: OfficeEquipmentDto,
): OfficeEquipmentDiff {
  const set = changeSet();
  set.changed('type', before.type.name, after.type.name);
  set.changed('name', before.name, after.name);
  set.changed('serialNumber', before.serialNumber || EMPTY, after.serialNumber || EMPTY);
  set.changed('inventoryNumber', before.inventoryNumber || EMPTY, after.inventoryNumber || EMPTY);
  set.changed(
    'department',
    before.department?.name ?? 'не закреплена',
    after.department?.name ?? 'не закреплена',
  );
  set.changed('location', before.location || EMPTY, after.location || EMPTY);
  set.changed('purchasedOn', dateOnly(before.purchasedOn), dateOnly(after.purchasedOn));
  set.changed('comment', before.comment || EMPTY, after.comment || EMPTY);
  set.changed('isActive', before.isActive ? 'Да' : 'Нет', after.isActive ? 'Да' : 'Нет');

  return {
    changes: set.changes,
    ...(before.warrantyUntil !== after.warrantyUntil
      ? { warrantyChange: { from: before.warrantyUntil, until: after.warrantyUntil } }
      : {}),
  };
}

/** Подписи полей: их читает лента, и они же должны совпадать с названиями в форме карточки. */
export const officeEquipmentFieldLabels: Record<string, string> = {
  type: 'Тип',
  name: 'Модель',
  serialNumber: 'Серийный номер',
  inventoryNumber: 'Инвентарный номер',
  department: 'Отдел-владелец',
  location: 'Место',
  purchasedOn: 'Дата покупки',
  comment: 'Комментарий',
  isActive: 'Активна',
};
