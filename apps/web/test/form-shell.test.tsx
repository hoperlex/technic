import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form, Input } from 'antd';
import { FormGrid } from '../src/components/FormGrid';
import { FormModal } from '../src/components/FormModal';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport, type Viewport } from './viewport';

/**
 * Оболочка формы у портала одна на оба режима (ADR 0030): на десктопе модальное окно, на телефоне
 * шит снизу. Проверяется не вид, а то, ради чего ветвление и делалось: обе кнопки работают
 * одинаково, а поворот устройства при открытой форме не стирает введённое.
 */

function Harness({ open = true, onSubmit = () => {} }: { open?: boolean; onSubmit?: () => void }) {
  return (
    <FormModal title="Форма" open={open} onCancel={() => {}} onSubmit={onSubmit}>
      <Form layout="vertical">
        <Form.Item name="comment" label="Комментарий">
          <Input aria-label="Комментарий" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

function renderAt(viewport: Viewport, ui: React.ReactElement) {
  setViewport(viewport);
  return render(ui);
}

/** Шит рисуется Drawer'ом, модалка — Modal: по классу оболочки видно, какая ветка сработала. */
function shell(): 'sheet' | 'modal' | 'none' {
  if (document.querySelector('.ant-drawer')) return 'sheet';
  if (document.querySelector('.ant-modal')) return 'modal';
  return 'none';
}

describe('оболочка формы', () => {
  it('на десктопе — модальное окно', () => {
    renderAt(DESKTOP_VIEWPORT, <Harness />);
    expect(shell()).toBe('modal');
  });

  it('на телефоне — шит снизу', () => {
    renderAt(MOBILE_VIEWPORT, <Harness />);
    expect(shell()).toBe('sheet');
  });

  it('кнопка сохранения в шите вызывает то же действие, что и в модалке', () => {
    const onSubmit = vi.fn();
    renderAt(MOBILE_VIEWPORT, <Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('поворот при открытой форме не сбрасывает введённое', () => {
    renderAt(MOBILE_VIEWPORT, <Harness />);
    const field = screen.getByLabelText('Комментарий');
    fireEvent.change(field, { target: { value: 'подъезд со двора' } });

    // Планшет в ландшафте уходит из мобильного режима: если бы оболочка сменилась на месте,
    // React размонтировал бы форму вместе с текстом.
    act(() => setViewport(DESKTOP_VIEWPORT));

    expect(shell()).toBe('sheet');
    expect(screen.getByLabelText('Комментарий')).toHaveProperty('value', 'подъезд со двора');
  });

  it('после закрытия оболочка переключается на вид текущего режима', () => {
    setViewport(MOBILE_VIEWPORT);
    const { rerender } = render(<Harness open />);
    expect(shell()).toBe('sheet');

    act(() => setViewport(DESKTOP_VIEWPORT));
    rerender(<Harness open={false} />);
    rerender(<Harness open />);

    expect(shell()).toBe('modal');
  });
});

/**
 * Двухколоночная раскладка полей: длинная форма в узком окне прятала половину полей под
 * прокрутку. Число колонок задают стили (`.form-grid`, на телефоне — одна), поэтому проверяется
 * то, что от разметки зависит: обёртка не ломает форму и помечает поля полной ширины.
 */
describe('раскладка полей формы', () => {
  function GridHarness({ onFinish }: { onFinish: (v: unknown) => void }) {
    return (
      <FormModal title="Форма" open onCancel={() => {}} onSubmit={() => {}}>
        <Form layout="vertical" onFinish={onFinish}>
          <FormGrid>
            <Form.Item name="code" label="Код">
              <Input aria-label="Код" />
            </Form.Item>
            <Form.Item name="name" label="Название">
              <Input aria-label="Название" />
            </Form.Item>
            <FormGrid.Full>
              <Form.Item name="comment" label="Комментарий">
                <Input aria-label="Комментарий" />
              </Form.Item>
            </FormGrid.Full>
          </FormGrid>
          <button type="submit">Отправить</button>
        </Form>
      </FormModal>
    );
  }

  it('поля внутри сетки остаются полями формы: значения доходят до отправки', async () => {
    const onFinish = vi.fn();
    renderAt(DESKTOP_VIEWPORT, <GridHarness onFinish={onFinish} />);

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'OBJ-A' } });
    fireEvent.change(screen.getByLabelText('Комментарий'), { target: { value: 'со двора' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(onFinish.mock.calls[0]![0]).toMatchObject({ code: 'OBJ-A', comment: 'со двора' });
  });

  it('поле полной ширины помечено — по этой метке стили и растягивают его на строку', () => {
    renderAt(DESKTOP_VIEWPORT, <GridHarness onFinish={() => {}} />);
    const grid = document.querySelector('.form-grid');
    expect(grid).not.toBeNull();
    // Полной ширины — только комментарий: код и название делят строку между собой.
    expect(grid!.querySelectorAll('.form-grid__full')).toHaveLength(1);
    expect(grid!.querySelector('.form-grid__full')!.textContent).toContain('Комментарий');
  });
});
