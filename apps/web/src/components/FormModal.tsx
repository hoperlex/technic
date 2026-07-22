import type { ReactNode } from 'react';
import { Modal } from 'antd';

interface Props {
  title: ReactNode;
  open: boolean;
  /** Закрытие: крестик справа сверху и кнопка «Отмена» (клик по подложке не закрывает). */
  onCancel: () => void;
  /** Основное действие, обычно () => form.submit(). */
  onSubmit: () => void;
  confirmLoading?: boolean;
  width?: number;
  okText?: string;
  cancelText?: string;
  children: ReactNode;
}

/**
 * Единое модальное окно с формой: шапка (заголовок + крестик) и кнопки снизу закреплены,
 * скроллится только тело с полями. Клик по подложке окно не закрывает — только крестик
 * или «Отмена» (Esc остаётся рабочим). Тело — переданный внутрь `<Form>`.
 */
export function FormModal({
  title,
  open,
  onCancel,
  onSubmit,
  confirmLoading,
  width = 480,
  okText = 'Сохранить',
  cancelText = 'Отмена',
  children,
}: Props) {
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={onSubmit}
      okText={okText}
      cancelText={cancelText}
      confirmLoading={confirmLoading}
      width={width}
      centered
      mask={{ closable: false }}
      styles={{
        container: {
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100dvh - 48px)',
          overflow: 'hidden',
        },
        body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      }}
    >
      {children}
    </Modal>
  );
}
