import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { WasteRequestDto } from '@technic/contracts';
import { WasteRequestViewModal } from '../src/pages/waste/WasteRequestViewModal';
import { DESKTOP_VIEWPORT, setViewport } from './viewport';

/**
 * Комментарий заявки на вывоз разведён по сторонам (ADR 0053): площадка и исполнитель говорят
 * своими строками. Проверяется карточка заявки — единственное место, где строку исполнителя не
 * только видно, но и пишут: формы правки у оператора нет вовсе.
 */

vi.mock('../src/api/resources', () => ({
  wasteRequestsApi: { history: () => Promise.resolve([]) },
}));

const request = {
  id: 'r1',
  num: 42,
  displayNumber: 'М-42',
  requestType: 'waste_removal',
  objectId: 'o1',
  objectCode: 'ОБ-1',
  objectName: 'Объект',
  objectAddress: '',
  containerTypeId: null,
  containerTypeName: null,
  wasteTypeId: 'w1',
  wasteTypeName: 'Строительный мусор',
  volumeM3: 40,
  pricePerM3: 850,
  amount: 34_000,
  completion: null,
  operatorCounterpartyId: 'op1',
  operatorName: 'ООО «ЭкоТранс»',
  deliveryAt: '2026-08-01T07:00:00.000Z',
  deliveryTimeUnspecified: false,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
  comment: 'заезд со двора',
  operatorComment: 'будем после 15:00',
  status: 'confirmed',
  cancelReason: null,
  files: [],
  tickets: [],
  vehicles: [],
  version: 3,
  createdBy: 'u1',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
} as unknown as WasteRequestDto;

function renderCard(props: Partial<Parameters<typeof WasteRequestViewModal>[0]> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App>
        <WasteRequestViewModal request={request} onClose={vi.fn()} {...props} />
      </App>
    </QueryClientProvider>,
  );
}

describe('комментарий заявки в карточке', () => {
  it('показывает обе стороны: площадку словом, исполнителя — названием контрагента', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderCard();
    expect(screen.getByText('Площадка:')).toBeDefined();
    expect(screen.getByText('заезд со двора')).toBeDefined();
    expect(screen.getByText('ООО «ЭкоТранс»:')).toBeDefined();
    expect(screen.getByText('будем после 15:00')).toBeDefined();
  });

  // Права нет либо заявка закрыта — страница просто не передаёт обработчик, и поля правки нет.
  it('без права на примечание правка не предлагается', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderCard();
    expect(screen.queryByPlaceholderText('Комментарий исполнителя')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
  });

  it('сохраняет примечание исполнителя обрезанным и только после правки', () => {
    setViewport(DESKTOP_VIEWPORT);
    const onSave = vi.fn();
    renderCard({ onSaveOperatorComment: onSave });
    const field = screen.getByPlaceholderText('Комментарий исполнителя');
    const save = screen.getByRole('button', { name: 'Сохранить' });
    // Текст не трогали — сохранять нечего: кнопка заперта, пока строка та же.
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(field, { target: { value: '  будем к 18:00  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSave).toHaveBeenCalledWith(request, 'будем к 18:00');
  });
});
