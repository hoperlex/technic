import type { ReactNode } from 'react';
import { Button, Drawer } from 'antd';

export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface Props {
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
export function ActionSheet({ title, open, onClose, items }: Props) {
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
        {items.map((item) => (
          <Button
            key={item.key}
            type="text"
            size="large"
            block
            danger={item.danger}
            disabled={item.disabled}
            icon={item.icon}
            className="action-sheet__item"
            onClick={() => {
              // Окно закрывается до действия: половина пунктов открывает своё окно поверх.
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
    </Drawer>
  );
}
