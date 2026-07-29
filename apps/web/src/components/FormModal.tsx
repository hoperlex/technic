import { useEffect, useState, type ReactNode } from 'react';
import { Button, Drawer, Modal } from 'antd';
import { useIsMobile } from '../hooks/useIsMobile';

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
 *
 * На телефоне то же окно открывается снизу во весь экран (ADR 0030): модалка в 480–760 px на
 * экране 360 px оставляет полям полоску, а кнопки внизу оказываются там, где их и ждут.
 * Форма внутри об этом не знает — набор пропсов у окна один на оба вида.
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
  const isMobile = useIsMobile();
  /**
   * Вид оболочки держится, пока окно открыто: замена Modal на Drawer — это смена типа элемента,
   * и React размонтировал бы вложенную форму вместе с введёнными значениями. Поворот планшета
   * не должен стирать заполненное, поэтому переключение откладывается до закрытия.
   */
  const [sheet, setSheet] = useState(isMobile);
  useEffect(() => {
    if (!open) setSheet(isMobile);
  }, [open, isMobile]);

  if (sheet) {
    return (
      <Drawer
        title={title}
        open={open}
        onClose={onCancel}
        placement="bottom"
        size="100%"
        mask={{ closable: false }}
        footer={
          // Кнопки во всю ширину и в порядке «отказ слева, действие справа» — тем же, что в
          // модалке на десктопе. Отступ снизу — под «домашнюю полоску».
          <div className="sheet-footer">
            <Button size="large" block onClick={onCancel}>
              {cancelText}
            </Button>
            <Button size="large" block type="primary" loading={confirmLoading} onClick={onSubmit}>
              {okText}
            </Button>
          </div>
        }
      >
        {children}
      </Drawer>
    );
  }

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
