import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CounterpartyDto, ObjectDto } from '@technic/contracts';
import { CounterpartiesTab } from '../src/pages/directories/CounterpartiesTab';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';

const NOW = '2026-01-01T00:00:00.000Z';

const site: ObjectDto = {
  id: 'object-north',
  code: 'СЕВ',
  name: 'Северная площадка',
  address: 'Северная улица, 1',
  isActive: true,
  operators: [],
  createdAt: NOW,
  updatedAt: NOW,
};

function counterparty(overrides: Partial<CounterpartyDto> = {}): CounterpartyDto {
  return {
    id: 'counterparty-operator',
    type: 'operator',
    name: 'Транс Инвест',
    inn: '7707083893',
    email: '',
    comment: 'Основной оператор',
    synonyms: ['ТрансИнвест'],
    objects: [{ id: site.id, code: site.code, name: site.name }],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function renderTab(record = counterparty()): HttpMock {
  const http = mockHttp({
    'GET /counterparties': () => json(list([record])),
    'GET /objects': () => json(list([site])),
    'PATCH /counterparties/:id': ({ body }) =>
      json({ ...record, ...(body as Partial<CounterpartyDto>) }),
    'DELETE /counterparties/:id': () => json({ ok: true }),
    'POST /counterparties/:id/restore': () => json({ ...record, deletedAt: null }),
  });
  renderWithUser(<CounterpartiesTab />, {
    user: authUser({ id: 'user-admin', role: 'admin' }),
  });
  return http;
}

async function waitForRegistry(http: HttpMock): Promise<void> {
  await screen.findByText('Транс Инвест');
  await waitFor(() => {
    expect(http.countOf('GET /counterparties')).toBe(1);
    expect(http.countOf('GET /objects')).toBe(1);
  });
}

function row(): HTMLElement {
  const result = screen.getByText('Транс Инвест').closest('tr');
  if (!result) throw new Error('counterparty row is missing');
  return result;
}

function saveButton(): HTMLElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
    (candidate) => candidate.textContent === 'Сохранить',
  );
  if (!button) throw new Error('save button is missing');
  return button;
}

describe('counterparty directory', () => {
  it('renders identity, aliases and operator objects in one registry row', async () => {
    const http = renderTab();

    await waitForRegistry(http);
    expect(within(row()).getByText('ТрансИнвест')).toBeTruthy();
    expect(within(row()).getByText('Оператор (вывоз мусора)')).toBeTruthy();
    expect(within(row()).getByText(site.code)).toBeTruthy();
    expect(within(row()).getByText('Да')).toBeTruthy();
  });

  it('edits a counterparty and refreshes both the registry and object bindings', async () => {
    const http = renderTab();
    await waitForRegistry(http);

    fireEvent.click(within(row()).getAllByRole('button')[0]!);
    const modal = document.querySelector('.ant-modal');
    if (!modal) throw new Error('counterparty modal is missing');
    fireEvent.change(within(modal as HTMLElement).getByLabelText('Комментарий'), {
      target: { value: 'Проверенный оператор' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('PATCH /counterparties/:id')).toBe(1));
    expect(http.lastCall('PATCH /counterparties/:id')!.body).toMatchObject({
      type: 'operator',
      name: 'Транс Инвест',
      objectIds: [site.id],
      comment: 'Проверенный оператор',
      isActive: true,
    });
    await waitFor(() => {
      expect(http.countOf('GET /counterparties')).toBeGreaterThan(1);
      expect(http.countOf('GET /objects')).toBeGreaterThan(1);
    });
  });

  it('confirms archival removal and refreshes the registry', async () => {
    const http = renderTab();
    await waitForRegistry(http);

    fireEvent.click(within(row()).getAllByRole('button')[1]!);
    expect(http.countOf('DELETE /counterparties/:id')).toBe(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(http.countOf('DELETE /counterparties/:id')).toBe(1));
    expect(http.lastCall('DELETE /counterparties/:id')!.path).toContain('counterparty-operator');
    await waitFor(() => expect(http.countOf('GET /counterparties')).toBeGreaterThan(1));
  });

  it('requests archived rows explicitly and restores one from its row action', async () => {
    const http = renderTab(counterparty({ deletedAt: '2026-02-01T00:00:00.000Z' }));
    await waitForRegistry(http);

    const archiveToggle = screen.getByText('Показать архив').closest('label');
    if (!archiveToggle) throw new Error('archive toggle is missing');
    fireEvent.click(archiveToggle.querySelector('input')!);
    await waitFor(() => expect(http.countOf('GET /counterparties')).toBe(2));
    expect(http.lastCall('GET /counterparties')!.query.get('includeDeleted')).toBe('true');
    await screen.findByText('Транс Инвест');

    fireEvent.click(within(row()).getByTitle('Восстановить'));

    await waitFor(() => expect(http.countOf('POST /counterparties/:id/restore')).toBe(1));
    expect(http.lastCall('POST /counterparties/:id/restore')!.path).toContain(
      'counterparty-operator',
    );
    await waitFor(() => expect(http.countOf('GET /counterparties')).toBeGreaterThan(2));
  });
});
