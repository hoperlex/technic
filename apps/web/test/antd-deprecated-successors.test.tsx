import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Button, Form } from 'antd';
import { AddonInputNumber, ItemList, ItemListMeta } from '../src/shared/ui';

/**
 * The portal's stand-ins for antd props and components deprecated in antd 6 (roadmap Q8). Each one
 * repeats what antd 6.5 itself did for the old API, and what is checked here is the part that is
 * easy to lose silently when the composition is rewritten by hand:
 *
 * 1. `AddonInputNumber` under a `Form.Item`: the value reaches the form, and the addon turns red
 *    together with the field. `Space.Addon` reads no form context, so without the status handed to
 *    it the cell would stay grey next to a red field.
 * 2. `ItemList`: actions are divided by a rule between them, not after the last one; a missing
 *    list shows the given text or antd's empty picture; while loading with no rows yet, no empty
 *    text flashes before the rows; the rows stay inside the polite live region `Spin` gives.
 */
describe('AddonInputNumber', () => {
  function PriceForm({ onFinish }: { onFinish: (values: { price: number }) => void }) {
    return (
      <Form onFinish={onFinish}>
        <Form.Item name="price" label="Цена" rules={[{ required: true, message: 'Укажите цену' }]}>
          <AddonInputNumber min={0.01} after="₽" />
        </Form.Item>
        <Button htmlType="submit">Сохранить</Button>
      </Form>
    );
  }

  it('turns the addon red with a failed field and passes the value to the form', async () => {
    const values: { price: number }[] = [];
    const { container } = render(<PriceForm onFinish={(v) => values.push(v)} />);
    const addon = () => screen.getByText('₽');

    expect(addon().className).not.toContain('ant-space-addon-status-error');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    });
    expect(await screen.findByText('Укажите цену')).toBeDefined();
    expect(addon().className).toContain('ant-space-addon-status-error');

    // The label points at the input itself: `Form.Item` handed the field id to the component.
    const input = screen.getByLabelText('Цена');
    expect(container.querySelector('.ant-input-number input')).toBe(input);
    fireEvent.change(input, { target: { value: '120' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    });
    expect(values).toEqual([{ price: 120 }]);
    expect(addon().className).not.toContain('ant-space-addon-status-error');
  });
});

describe('ItemList', () => {
  const rows = [
    { id: 'a', name: 'Первый' },
    { id: 'b', name: 'Второй' },
  ];

  it('divides the actions between themselves, not after the last one', () => {
    const { container } = render(
      <ItemList
        items={rows}
        rowKey={(r) => r.id}
        actions={(r) => [
          <Button key="e">{`Править ${r.name}`}</Button>,
          <Button key="d">Удалить</Button>,
        ]}
        renderItem={(r) => <ItemListMeta title={r.name} description={r.id} />}
      />,
    );
    const items = container.querySelectorAll('.item-list__item');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelectorAll('.item-list__actions > li')).toHaveLength(2);
    expect(items[0]!.querySelectorAll('.item-list__split')).toHaveLength(1);
    expect(items[0]!.querySelector('.item-list__meta-title')?.textContent).toBe('Первый');
    expect(container.querySelector('[aria-live="polite"] .item-list__items')).not.toBeNull();
  });

  it('shows the given empty text, or the empty picture without one', () => {
    const { rerender } = render(
      <ItemList items={[]} rowKey={() => 'x'} renderItem={() => null} emptyText="Файлов нет" />,
    );
    expect(screen.getByText('Файлов нет')).toBeDefined();
    rerender(<ItemList items={[]} rowKey={() => 'x'} renderItem={() => null} />);
    expect(document.querySelector('.item-list__empty .ant-empty')).not.toBeNull();
  });

  it('keeps the empty text away while the first rows are loading', () => {
    render(
      <ItemList
        items={[]}
        rowKey={() => 'x'}
        renderItem={() => null}
        loading
        emptyText="Типов пока нет"
      />,
    );
    expect(screen.queryByText('Типов пока нет')).toBeNull();
  });
});
