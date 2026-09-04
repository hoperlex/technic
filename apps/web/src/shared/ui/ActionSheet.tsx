import type { ReactNode } from 'react';
import { Button, Drawer, Tooltip } from 'antd';

export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /**
   * Почему пункт выключен. Неактивная кнопка без объяснения читается как поломка портала, поэтому
   * причина обязана быть видна там же — подсказкой на обёртке: сама выключенная кнопка событий
   * указателя не отдаёт, и `Tooltip` на ней не открылся бы (тот же приём, что у выключенного
   * чекбокса в `DataTable`).
   */
  disabledReason?: string;
  /**
   * Главный шаг текущего состояния записи: то самое действие, к которому зовёт подпись «Вам: …» в
   * списке (Р117). Признак живёт у пункта меню, а не во второй карте «статус → окно»: карта
   * разошлась бы с набором действий на первом же новом статусе — подпись звала бы к тому, чего в
   * меню уже нет. Сам список пунктов от него не меняется: признак читает тот, кто строит строку.
   */
  primary?: boolean;
  onClick: () => void;
}

interface Props {
  /**
   * Чем назван ящик. Умолчание не косметика: без заголовка шит приезжает с одной крестовиной, и
   * тому, кто слушает экран, непонятно, что ему открыли. Своё название передают там, где оно
   * точнее общего, — «Действия по заявке», «Изменить статус».
   */
  title?: string;
  open: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
}

/**
 * Список действий снизу экрана (ADR 0030) — мобильная замена выпадающему меню и колонке кнопок
 * с иконками. Подписи здесь обязательны: подсказка на иконке по касанию не открывается, и без
 * текста действие остаётся загадкой.
 *
 * Используется и для действий записи, и для смены статуса: набор пунктов разный, поведение одно.
 */
export function ActionSheet({ title = 'Действия', open, onClose, items }: Props) {
  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      placement="bottom"
      size="auto"
      styles={{ body: { padding: 8, paddingBottom: 'calc(8px + var(--safe-bottom))' } }}
    >
      <div className="action-sheet">
        {items.map((item) => {
          const button = (
            <Button
              key={item.key}
              type="text"
              size="large"
              block
              danger={item.danger}
              disabled={item.disabled}
              icon={item.icon}
              className="action-sheet__item"
              onClick={(e) => {
                // Список рисуется порталом, но событие идёт по дереву React — то есть через ту
                // самую карточку списка, из которой список открыли. Не остановив его, выбор
                // статуса с телефона заодно открывал бы карточку заявки поверх начатого действия.
                e.stopPropagation();
                // Окно закрывается до действия: половина пунктов открывает своё окно поверх.
                onClose();
                item.onClick();
              }}
            >
              {item.label}
              {/* Причина запрета — второй строкой в доступном имени кнопки. Подсказка на обёртке
                  ниже остаётся, но по касанию она не открывается вовсе, и без этого текста
                  человек с озвучиванием слышал бы «Закрыть работы, недоступно» без объяснения. */}
              {item.disabledReason && (
                <span className="visually-hidden">. {item.disabledReason}</span>
              )}
            </Button>
          );
          // Выключенная кнопка событий указателя не отдаёт — подсказку держит обёртка.
          return item.disabledReason ? (
            <Tooltip key={item.key} title={item.disabledReason}>
              <span>{button}</span>
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
    </Drawer>
  );
}
