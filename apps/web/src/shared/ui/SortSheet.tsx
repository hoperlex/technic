import { Button, Drawer, Radio, Segmented, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { SortOption } from './listControls';

interface Props {
  open: boolean;
  onClose: () => void;
  options: SortOption[];
  sortBy: string | undefined;
  sortOrder: 'asc' | 'desc';
  onApply: (sortBy: string | undefined, sortOrder: 'asc' | 'desc') => void;
}

/**
 * Выбор сортировки на телефоне (ADR 0030). На десктопе сортируют щелчком по заголовку колонки —
 * в карточном списке заголовков нет, и без этого шита список остался бы только в порядке по
 * умолчанию. Поля берутся из колонок таблицы, поэтому набор здесь тот же, что и на десктопе.
 */
export function SortSheet({ open, onClose, options, sortBy, sortOrder, onApply }: Props) {
  const [field, setField] = useState(sortBy);
  const [order, setOrder] = useState(sortOrder);

  // Шит открывают, чтобы поменять текущую сортировку, — значит начинает он с неё, а не с того,
  // что выбирали в прошлый раз и отменили.
  useEffect(() => {
    if (open) {
      setField(sortBy);
      setOrder(sortOrder);
    }
  }, [open, sortBy, sortOrder]);

  return (
    <Drawer
      title="Сортировка"
      open={open}
      onClose={onClose}
      placement="bottom"
      size="auto"
      footer={
        <div className="sheet-footer">
          <Button size="large" block onClick={onClose}>
            Отмена
          </Button>
          <Button
            size="large"
            block
            type="primary"
            onClick={() => {
              onApply(field, order);
              onClose();
            }}
          >
            Применить
          </Button>
        </div>
      }
    >
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        <Segmented<'asc' | 'desc'>
          block
          value={order}
          onChange={setOrder}
          options={[
            { value: 'desc', label: 'По убыванию' },
            { value: 'asc', label: 'По возрастанию' },
          ]}
        />
        {options.length > 0 ? (
          <Radio.Group
            value={field}
            onChange={(e) => setField(e.target.value as string)}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {options.map((option) => (
              <Radio key={option.key} value={option.key} className="sort-sheet__option">
                {option.label}
              </Radio>
            ))}
          </Radio.Group>
        ) : (
          <Typography.Text type="secondary">Этот список не сортируется</Typography.Text>
        )}
      </Space>
    </Drawer>
  );
}
