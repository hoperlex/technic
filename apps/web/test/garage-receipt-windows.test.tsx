import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AutoPartReceiptDto,
  AutoPartReceiptsSummaryDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Окна чека на автозапчасти: карточка `?receipt=` и форма «Принять чек» (план
 * `docs/auto-part-receipts-plan.md`, §8, Р6, Р8, Р11, Р12).
 *
 * Пришпилено ровно то, за что окна отвечают и что легко потерять правкой разметки.
 *
 * **Итогов в карточке три** (Р8, Р11): сумма чека, сумма по машинам и «не отнесено». Строка без
 * машины — законное состояние, и разницу между первыми двумя числами объясняет карточка, а не
 * читатель; ни одно из чисел портал по строкам не пересчитывает.
 *
 * **Кнопки зависят от права** (Р12): держатель ведения правит чек и снимает пометку, «Удалить»
 * видит только администратор — удаление разведено на два действия и два права намеренно.
 *
 * **Отказ формы называет поле** (ADR 0094, Р6): «Прикрепите скан чека» и «Номер чека обязателен»
 * приходят **одним** нажатием, хотя живут по разные стороны от правил формы — скан лежит вне её
 * полей, и вторым нажатием про него узнавать нельзя.
 */

const ON_DATE = '2026-07-24';

const SUMMARY: AutoPartReceiptsSummaryDto = {
  receiptsCount: 1,
  total: 12300,
  unassignedTotal: 300,
  deletionMarkedCount: 1,
};

const RECEIPT: AutoPartReceiptDto = {
  id: 'r-1',
  purchasedOn: '2026-07-18',
  sellerName: 'ООО «Автодеталь»',
  documentNumber: '214',
  note: 'по заявке механика',
  lines: [
    {
      id: 'l-1',
      seq: 1,
      vehicleId: 'v1',
      vehicleLabel: 'Е646СК799',
      name: 'Фильтр масляный',
      quantity: 2,
      unit: 'шт',
      amount: 12000,
      unitPrice: 6000,
      note: '',
    },
    {
      id: 'l-2',
      seq: 2,
      vehicleId: null,
      vehicleLabel: '',
      name: 'Перчатки',
      quantity: 1,
      unit: 'уп',
      amount: 300,
      unitPrice: 300,
      note: '',
    },
  ],
  files: [{ id: 'f-1', filename: 'chek.pdf', contentType: 'application/pdf', size: 1024 }],
  total: 12300,
  unassignedTotal: 300,
  deletion: {
    requestedAt: '2026-07-20T09:00:00.000Z',
    requestedByName: 'Иванов И.И.',
    reason: 'задвоили с чеком № 214',
  },
  version: 3,
  createdAt: '2026-07-19T09:00:00.000Z',
  createdByName: 'Механиков М.М.',
  updatedAt: '2026-07-19T09:00:00.000Z',
  updatedByName: '',
};

const GARAGE_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

function renderParts(route: string, role: 'mechanic' | 'admin' = 'mechanic'): HttpMock {
  const http = mockHttp({
    'GET /garage/vehicles': () => json({ ...emptyList(), onDate: ON_DATE }),
    'GET /garage/vehicles/summary': () => json(GARAGE_SUMMARY),
    'GET /garage/drivers': () => json(emptyList()),
    'GET /garage/drivers/summary': () =>
      json({ ...GARAGE_SUMMARY, assigned: 0, documentsIncomplete: 0 }),
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /objects': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    'GET /vehicle-maintenance/snapshot': () => json({ on: ON_DATE, items: [] }),
    'GET /auto-part-receipts/vehicles/snapshot': () => json({ to: ON_DATE, items: [] }),
    'GET /auto-part-receipts': () => json({ items: [], total: 0, page: 1, pageSize: 50 }),
    'GET /auto-part-receipts/summary': () => json(SUMMARY),
    'GET /auto-part-receipts/r-1': () => json(RECEIPT),
  });
  renderWithUser(<GaragePage />, {
    user: authUser({ role }),
    route,
  });
  return http;
}

describe('карточка чека', () => {
  it('показывает реквизиты, строки, три итога и полосу пометки', async () => {
    renderParts(`/garage?tab=parts&receipt=r-1&date=${ON_DATE}`);

    expect(await screen.findByText('Чек № 214')).toBeDefined();
    expect(screen.getByText('18.07.2026')).toBeDefined();
    expect(screen.getByText('ООО «Автодеталь»')).toBeDefined();
    expect(screen.getByText('Фильтр масляный')).toBeDefined();
    expect(screen.getByText('не отнесено')).toBeDefined();
    expect(screen.getByText(/Всего по чеку: 12 300,00 ₽/)).toBeDefined();
    expect(screen.getByText(/По машинам: 12 000,00 ₽/)).toBeDefined();
    expect(screen.getByText(/Не отнесено: 300,00 ₽/)).toBeDefined();
    expect(screen.getByText(/Помечен к удалению 20.07.2026 — Иванов И.И./)).toBeDefined();
    expect(screen.getByText('«задвоили с чеком № 214»')).toBeDefined();
    // Механику — правка и снятие пометки; удаление это право администратора (Р12).
    expect(screen.getByText('Изменить')).toBeDefined();
    expect(screen.getByText('Снять пометку')).toBeDefined();
    expect(screen.queryByText('Удалить')).toBeNull();
  });

  it('администратору даёт удаление; техника строки ведёт в окно машины', async () => {
    renderParts(`/garage?tab=parts&receipt=r-1&date=${ON_DATE}`, 'admin');

    expect(await screen.findByText('Чек № 214')).toBeDefined();
    expect(screen.getByText('Удалить')).toBeDefined();
    const link = screen.getByText('Е646СК799').closest('a') as HTMLElement;
    expect(link.getAttribute('href')).toContain('spend=v1');
  });
});

describe('окно «Принять чек»', () => {
  it('не отпускает без скана, номера и строк — и называет поле', async () => {
    renderParts(`/garage?tab=parts&newReceipt=1&date=${ON_DATE}`);

    await waitFor(() => expect(document.querySelector('.ant-modal')).not.toBeNull());
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    fireEvent.click(within(modal).getByText('Сохранить'));

    await waitFor(() => expect(within(modal).getByText('Прикрепите скан чека')).toBeDefined());
    await waitFor(() => expect(within(modal).getByText('Номер чека обязателен')).toBeDefined());
    // Строка при открытии уже одна, поэтому отказ по строкам — про её незаполненные поля.
    expect(within(modal).getByText('Укажите наименование')).toBeDefined();
    expect(within(modal).getByText('Укажите сумму')).toBeDefined();
    // Поля «итог с бумаги» в форме нет вовсе (Р11) — есть предпросмотр суммы строк.
    expect(within(modal).getByText(/Всего по чеку: 0,00 ₽/)).toBeDefined();
  });
});
