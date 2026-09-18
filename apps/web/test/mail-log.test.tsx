import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MailLogItemDto, MailLogMessageDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { MailLogBlock } from '../src/pages/admin/MailLogBlock';

/**
 * Журнал отправки писем (ADR 0199).
 *
 * Проверяется то, чего не видно ни в контрактах, ни на сервере: что **канал уходит в запрос** и
 * вкладка открывается ящиком службы ремонта — ради него её и просили, — и что тело письма
 * запрашивается только по клику, а не вместе со списком.
 *
 * Отказ SMTP проверяется отдельно: ради него журнал чаще всего и открывают, и текст отказа обязан
 * читаться прямо в строке, без открытия письма.
 */

const LIST = 'GET /admin/mail/log';
const MESSAGE = 'GET /admin/mail/log/:id';

const SENT: MailLogItemDto = {
  id: 'm-1',
  createdAt: '2026-09-17T07:40:00.000Z',
  kind: 'service_request_assigned',
  toEmail: 'info@copylight.test',
  subject: 'СО-94 · Заявка назначена исполнителю',
  status: 'sent',
  sentAt: '2026-09-17T07:41:00.000Z',
  lastError: '',
  isTest: false,
};

const FAILED: MailLogItemDto = {
  id: 'm-2',
  createdAt: '2026-09-17T08:10:00.000Z',
  kind: 'service_request_comment',
  toEmail: 'info@copylight.test',
  subject: 'СО-94 · Реплика в обсуждении',
  status: 'failed',
  sentAt: null,
  lastError: '550 mailbox unavailable',
  isTest: false,
};

const BODY: MailLogMessageDto = {
  ...SENT,
  account: 'repair',
  replyTo: 'repair@example.test',
  bodyText: 'СО-94 — заявка назначена исполнителю',
  bodyHtml: '<p>СО-94 — заявка назначена исполнителю</p>',
  providerId: 'smtp-1',
  dedupeKey: 'service_request_assigned:hist-1:user-1',
  entityType: 'serviceRequest',
  entityId: 'req-1',
};

function renderBlock(items: MailLogItemDto[] = [SENT, FAILED]): HttpMock {
  const http = mockHttp({
    [LIST]: () => json({ items, total: items.length, page: 1, pageSize: 50 }),
    [MESSAGE]: () => json(BODY),
  });
  renderWithUser(<MailLogBlock />, { user: authUser({ role: 'admin' }) });
  return http;
}

describe('журнал отправки писем', () => {
  it('открывается ящиком службы ремонта и показывает причину, получателя и исход', async () => {
    const http = renderBlock();

    expect(await screen.findByText('Оргтехника: заявка назначена исполнителю')).toBeTruthy();
    expect(screen.getAllByText('info@copylight.test').length).toBeGreaterThan(0);
    expect(screen.getByText('Отправлено')).toBeTruthy();
    // Отказ читается прямо в строке: за ним в письмо ходить не надо.
    expect(screen.getByText('550 mailbox unavailable')).toBeTruthy();

    // Канал — в запросе, и он именно `repair`: без него список смешал бы задания водителям с
    // письмами подрядчику.
    const first = http.calls.find((c) => c.path === '/admin/mail/log')!;
    expect(first.query.get('account')).toBe('repair');
  });

  it('переключатель канала перезапрашивает список другим контуром', async () => {
    const http = renderBlock();
    await screen.findByText('Оргтехника: заявка назначена исполнителю');

    fireEvent.click(screen.getByText('Основной канал портала'));

    await waitFor(() => {
      expect(
        http.calls.some(
          (c) => c.path === '/admin/mail/log' && c.query.get('account') === 'default',
        ),
      ).toBe(true);
    });
  });

  it('тело письма приезжает только по клику на строке', async () => {
    const http = renderBlock();
    const cell = await screen.findByText('Оргтехника: заявка назначена исполнителю');

    // До клика тела никто не спрашивал: в списке его нет намеренно.
    expect(http.calls.some((c) => c.path.startsWith('/admin/mail/log/'))).toBe(false);

    fireEvent.click(cell);

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('СО-94 — заявка назначена исполнителю')).toBeTruthy();
    expect(within(dialog).getByText('repair@example.test')).toBeTruthy();
    expect(http.calls.some((c) => c.path === '/admin/mail/log/m-1')).toBe(true);
  });

  it('состояние сужает список отбором, а не вручную на клиенте', async () => {
    const http = renderBlock();
    await screen.findByText('Оргтехника: заявка назначена исполнителю');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Состояние' }));
    // Именно пункт списка, а не тег в строке таблицы: подпись у них одна и та же.
    fireEvent.click(await screen.findByTitle('Не отправлено'));

    await waitFor(() => {
      expect(
        http.calls.some((c) => c.path === '/admin/mail/log' && c.query.get('status') === 'failed'),
      ).toBe(true);
    });
  });
});
