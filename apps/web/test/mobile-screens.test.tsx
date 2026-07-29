import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RequestHistoryTable, type HistoryRow } from '../src/components/RequestHistory';
import { WasteVehiclesEditor, type VehicleDraft } from '../src/components/WasteVehiclesEditor';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Экраны, у которых на телефоне своя раскладка (ADR 0030): история заявки и строки факта вывоза.
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
});

describe('строки факта вывоза', () => {
  const typeOptions = [
    { value: 't1', label: 'Самосвал 25 м³', volumeM3: 25, kind: 'truck' as const },
  ];
  const draft: VehicleDraft = { key: 'v1', containerTypeId: 't1', count: 2 };

  it('на телефоне количество меняется степпером', () => {
    setViewport(MOBILE_VIEWPORT);
    const onChange = vi.fn<(next: VehicleDraft[]) => void>();
    render(<WasteVehiclesEditor value={[draft]} onChange={onChange} typeOptions={typeOptions} />);

    fireEvent.click(screen.getByLabelText('Больше на одну'));
    expect(onChange).toHaveBeenCalledWith([{ ...draft, count: 3 }]);

    fireEvent.click(screen.getByLabelText('Меньше на одну'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...draft, count: 1 }]);
  });

  it('объём строки считается так же, как и на десктопе', () => {
    setViewport(MOBILE_VIEWPORT);
    render(<WasteVehiclesEditor value={[draft]} onChange={vi.fn()} typeOptions={typeOptions} />);
    expect(screen.getByText(/50 м³/)).toBeDefined();
  });

  it('на десктопе степпера нет — количество набирают полем', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(<WasteVehiclesEditor value={[draft]} onChange={vi.fn()} typeOptions={typeOptions} />);
    expect(screen.queryByLabelText('Больше на одну')).toBeNull();
    expect(screen.getByLabelText('Количество машин')).toBeDefined();
  });
});
