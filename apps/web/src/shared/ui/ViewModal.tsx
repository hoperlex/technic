import type { CSSProperties, ReactNode } from 'react';
import { Drawer, Modal } from 'antd';
import { useIsMobile } from '@shared/lib';

interface Props {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  width?: number | string;
  /** Кнопки внизу; на телефоне делят ширину поровну. `null` — окно закрывается только крестиком. */
  footer?: ReactNode;
  /** Содержимое пересобирается при каждом открытии: окно переоткрывают на соседней записи. */
  destroyOnHidden?: boolean;
  /** Для окон с собственной раскладкой тела (просмотр файла центрирует содержимое). */
  bodyStyle?: CSSProperties;
  children: ReactNode;
}

/**
 * Оболочка окна просмотра: шапка и кнопки закреплены, скроллится только тело. На телефоне
 * открывается снизу во весь экран (ADR 0030) — карточка заявки с историей и файлами в окне
 * 760 px на экране 360 px читается хуже всего.
 *
 * От FormModal отличается тем, что внутри нет формы: содержимое можно пересобирать при каждом
 * открытии, и вид оболочки не нужно удерживать до закрытия.
 */
export function ViewModal({
  title,
  open,
  onClose,
  width = 760,
  footer,
  destroyOnHidden,
  bodyStyle,
  children,
}: Props) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer
        title={title}
        open={open}
        onClose={onClose}
        placement="bottom"
        size="100%"
        mask={{ closable: false }}
        /* Вложенное окно карточку не толкает (ADR 0140). По умолчанию открытый внутри Drawer
           сдвигает родителя на 180 px — приём для боковых панелей, где так видно, что окон два.
           Здесь оба развёрнуты во весь экран, и сдвиг заметен только рывком содержимого и полосой
           подложки снизу на время анимации. Тем же путём ходит и шит действий карточки. */
        push={false}
        destroyOnHidden={destroyOnHidden}
        styles={bodyStyle ? { body: bodyStyle } : undefined}
        footer={footer ? <div className="sheet-footer">{footer}</div> : undefined}
      >
        {children}
      </Drawer>
    );
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      width={width}
      centered
      mask={{ closable: false }}
      destroyOnHidden={destroyOnHidden}
      footer={footer}
      styles={{
        container: {
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100dvh - 48px)',
          overflow: 'hidden',
        },
        body: bodyStyle ?? { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      }}
    >
      {children}
    </Modal>
  );
}
