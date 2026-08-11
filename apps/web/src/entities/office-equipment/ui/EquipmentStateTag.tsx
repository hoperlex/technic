import { Tag, Tooltip } from 'antd';
import {
  officeEquipmentStateColors,
  officeEquipmentStateLabels,
  type OfficeEquipmentState,
} from '@technic/contracts';

/**
 * Где единица находится физически (план модернизации, Р61): на объекте, в ремонте, на складе или у
 * сотрудника.
 *
 * «На объекте» — рабочее состояние, и цветом оно не выделяется: иначе в справочнике горит каждая
 * строка и заметить среди них аппарат, уехавший в сервис полгода назад, невозможно. Уточнение
 * («склад АХО», «у Иванова») живёт подсказкой: в колонке для него места нет, а без него «на
 * складе» не отвечает на вопрос, на каком.
 */
export function EquipmentStateTag({ state, note }: { state: OfficeEquipmentState; note?: string }) {
  const tag = (
    <Tag color={officeEquipmentStateColors[state]} style={{ marginInlineEnd: 0 }}>
      {officeEquipmentStateLabels[state]}
    </Tag>
  );
  return note ? <Tooltip title={note}>{tag}</Tooltip> : tag;
}
