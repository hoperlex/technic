import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { WasteRequestDto } from '@technic/contracts';
import { RequestHistoryTable, type HistoryRow } from '../src/components/RequestHistory';
import { WasteDoneModal } from '../src/pages/waste/WasteDoneModal';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Экраны, у которых на телефоне своя раскладка (ADR 0030): история заявки и окно выполнения.
 * Проверяется, что содержимое никуда не делось — модель осталась прежней, изменилась подача.
 */

const rows: HistoryRow[] = [
  {
    key: 'e1',
    entry: {
      id: 'e1',
      kind: 'status',
      at: '2026-07-20T09:00:00.000Z',
      actorId: 'user-1',
      actorName: 'Иванов И. И.',
      fromStatus: 'new',
      toStatus: 'confirmed',
      comment: '',
      changes: [{ field: 'operator', from: '—', to: 'ООО «Эко»' }],
    },
  },
];

describe('история заявки', () => {
  it('на телефоне — карточки событий, а не таблица', () => {
    setViewport(MOBILE_VIEWPORT);
    render(<RequestHistoryTable rows={rows} labels={{ operator: 'Оператор' }} />);
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(document.querySelectorAll('.history-item')).toHaveLength(1);
    expect(screen.getByText('Иванов И. И.')).toBeDefined();
  });

  it('подробности раскрываются касанием', () => {
    setViewport(MOBILE_VIEWPORT);
    render(<RequestHistoryTable rows={rows} labels={{ operator: 'Оператор' }} />);
    expect(screen.queryByText(/Оператор:/)).toBeNull();

    fireEvent.click(screen.getByText('Подробнее'));
    expect(screen.getByText(/Оператор:/)).toBeDefined();
  });

  it('на десктопе остаётся таблицей', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(<RequestHistoryTable rows={rows} labels={{ operator: 'Оператор' }} />);
    expect(document.querySelector('.ant-table')).not.toBeNull();
  });

  it('на десктопе изменения видны сразу, без кнопки раскрытия', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(<RequestHistoryTable rows={rows} labels={{ operator: 'Оператор' }} />);
    expect(screen.getByText(/Оператор:/)).toBeDefined();
    // Колонка с «плюсом» сдвигала весь список вправо, а прятала эти же две строки.
    expect(document.querySelector('.ant-table-row-expand-icon')).toBeNull();
  });
});

describe('выполнение заявки на вывоз', () => {
  /**
   * Заявка со снимком цены: тариф в этом случае не запрашивается, и окно считает сумму само
   * (ADR 0035). Полей DTO у заявки много, а окну нужны считанные — остальные к делу не относятся.
   */
  const request = {
    id: 'r1',
    num: 42,
    displayNumber: 'М-42',
    requestType: 'waste_removal',
    objectCode: 'OBJ-1',
    objectName: 'Объект',
    wasteTypeId: 'w1',
    volumeM3: 40,
    pricePerM3: 850,
    amount: 34_000,
    operatorCounterpartyId: 'op1',
    completion: null,
    vehicles: [],
    files: [],
    tickets: [
      {
        id: 'f1',
        filename: 'талон.pdf',
        contentType: 'application/pdf',
        size: 1,
        status: 'active',
        createdAt: '2026-07-20T09:00:00.000Z',
      },
    ],
    version: 1,
  } as unknown as WasteRequestDto;

  function renderModal() {
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App>
          <WasteDoneModal
            request={request}
            confirmLoading={false}
            onCancel={vi.fn()}
            onSubmit={onSubmit}
          />
        </App>
      </QueryClientProvider>,
    );
    return onSubmit;
  }

  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it('объём открывается заявленным, стоимость — расчётом по прайсу', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderModal();
    expect(field('Вывезено, м³').value).toBe('40');
    expect(field('Стоимость, ₽').value).toBe('34000.00');
  });

  it('правка объёма пересчитывает стоимость', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderModal();
    fireEvent.change(field('Вывезено, м³'), { target: { value: '48' } });
    expect(field('Стоимость, ₽').value).toBe('40800.00');
  });

  // Ради этого стоимость и сделали полем: цены в прайсе может не быть вовсе, а счёт оператора
  // включает и подачу, и недогруз — сумма обязана сходиться со счётом, а не с формулой.
  it('введённая руками стоимость не переписывается расчётом', async () => {
    setViewport(DESKTOP_VIEWPORT);
    const onSubmit = renderModal();
    fireEvent.change(field('Стоимость, ₽'), { target: { value: '39000' } });
    fireEvent.change(field('Вывезено, м³'), { target: { value: '48' } });
    expect(field('Стоимость, ₽').value).toBe('39000.00');

    // Форма antd проверяет поля асинхронно, поэтому обработчик вызывается не в тот же тик.
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        // Дата вывоза уходит вместе с закрытием (ADR 0114, Р19): здесь её не заполняли, и это
        // `null`, а не отсутствие поля — «не знаем» у закрытия отдельное состояние.
        expect.objectContaining({
          completion: { volumeM3: 48, totalCost: 39_000, removedOn: null },
        }),
      ),
    );
  });

  // Талон подписывают на площадке и фотографируют там же — кнопка камеры нужна только на
  // телефоне (ADR 0030); на десктопе снимать нечем, и в окне её нет.
  it('на телефоне талон можно снять камерой', () => {
    setViewport(MOBILE_VIEWPORT);
    renderModal();
    expect(screen.getByRole('button', { name: /Снять камерой/ })).toBeDefined();
  });

  it('на десктопе кнопки камеры нет', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderModal();
    expect(screen.queryByRole('button', { name: /Снять камерой/ })).toBeNull();
  });
});
