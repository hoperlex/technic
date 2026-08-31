import { Tag } from 'antd';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
import type { CardConfig } from '@shared/ui';
import { formatDateTime } from '../../../utils/format';
import type { OfficeEquipmentConsumableGridActions } from './officeEquipmentConsumableGrid';

/**
 * Та же строка перечня расходников на телефоне (ADR 0030): та же запись, другой способ показать.
 *
 * Отдельным файлом от колонок только ради порога в 400 строк — не потому, что это другое
 * описание: набор действий у карточки и у таблицы один и тот же тип
 * (`OfficeEquipmentConsumableGridActions`), и обе фабрики зовутся из одного места с одним и тем же
 * объектом. Разъехаться им нечем: отсутствующий обработчик убирает действие и там, и там.
 */
export function officeEquipmentConsumableCard({
  canManage,
  onOpen,
  onStock,
  onRequired,
  onHistory,
  onDelete,
}: OfficeEquipmentConsumableGridActions): CardConfig<OfficeEquipmentConsumableDto> {
  return {
    title: (r) => r.name,
    badge: (r) => (
      <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? 'Активен' : 'Погашен'}</Tag>
    ),
    primary: (r) => (r.color ? `${r.code} · ${r.color}` : r.code),
    lines: [
      (r) => `В наличии: ${r.quantity}`,
      /*
       * Три числа заказа одной строкой и словами (Р13, Р15): подсказок заголовка на телефоне нет,
       * а «0 · 0 · 0» без подписей не читается вовсе. «Не следим» стоит вместо нулевой
       * потребности по той же причине, по какой в таблице у неё прочерк: ноль здесь ответ, а не
       * пустая ячейка.
       */
      (r) =>
        r.requiredQuantity === 0
          ? 'Потребность не задана: за позицией не следим'
          : `Потребность: ${r.requiredQuantity} · уже заказано: ${r.alreadyOrdered} · к закупке: ${r.deficit}`,
      (r) => (r.models.length === 0 ? 'Модели не указаны' : `Подходит к: ${r.models.length}`),
      // Подпись целиком, а не одно число: в карточке телефона подсказке по наведению взяться
      // неоткуда, а число без области читается как масштаб всего парка (Р12).
      (r) => `В парке: ${r.equipmentCount} (в вашей области, активных)`,
      /*
       * Тот же столбец, что и в таблице (Р3), и тем же приёмом развёрнут словами: подсказки
       * заголовка на телефоне нет, а «Правка остатка: 20.08» без оговорки читалось бы как «когда
       * остаток вообще менялся» — то есть отвечало бы про выдачи по заявкам, которых здесь нет.
       *
       * Прочерк рисует сам `formatDateTime`: у позиции, заведённой с нулём, ручных событий не
       * бывает по построению, и это ответ, а не недогруженные данные.
       */
      (r) => `Правили руками: ${formatDateTime(r.lastManualStockAt)} (без выдач по заявкам)`,
    ],
    // Касание по карточке ведёт туда, где человек и так работает, — в саму карточку: у ведущего
    // номенклатуру на правку, у прочих на чтение. Там, где карточки нет вовсе (вкладка), касание
    // не делает ничего: обещать открытие нечем.
    onOpen,
    actions: (r) => [
      ...(onOpen
        ? [
            {
              key: 'open',
              label: canManage ? 'Редактировать' : 'Открыть карточку',
              onClick: () => onOpen(r),
            },
          ]
        : []),
      ...(onStock ? [{ key: 'stock', label: 'Изменить остаток', onClick: () => onStock(r) }] : []),
      ...(onRequired
        ? [{ key: 'required', label: 'Потребность', onClick: () => onRequired(r) }]
        : []),
      // Без права рядом: журнал открыт всякому, кому открыт перечень (Р4).
      { key: 'history', label: 'История остатка', onClick: () => onHistory(r) },
      ...(onDelete
        ? [
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              // Тот же признак, что и у кнопки в таблице: движение остатка запирает удаление (Р11).
              disabled: r.hasStockHistory,
              onClick: () => onDelete(r),
            },
          ]
        : []),
    ],
  };
}
