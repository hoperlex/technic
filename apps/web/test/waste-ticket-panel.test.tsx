import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { WasteTicketsPanel, TicketRecognitionBanner } from '../src/features/waste-ticket-review';

/**
 * Панель разбора талонов, когда распознавания нет (ADR 0114, Р29).
 *
 * Самая дорогая ошибка модуля — не сбой, а тишина: заявка с приложенной, но не прочитанной бумагой
 * не должна выглядеть проверенной. На dev-стенде это вскрылось буквально: над талоном, которого
 * машина не видела, стояло зелёное «Расхождений нет».
 *
 * Проверяется именно вёрстка, а не ручка: сервер к этому моменту отвечает правильно (`disabled`,
 * файл `not_queued`), и вопрос только в том, скажет ли об этом экран.
 */
const EMPTY_TICKETS = {
  tickets: [],
  pages: [],
  files: [
    {
      fileId: 'f-1',
      filename: 'talon.jpg',
      status: 'not_queued',
      reason: 'Талон приложен, но в разбор не поступал: распознавание было выключено.',
      errorClass: null,
      errorScope: null,
      totalPages: 0,
      processedPages: 0,
      activeJob: null,
      pages: [],
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
  ],
  checks: [],
  attempts: [],
  blindChecks: [],
  ticketsVolumeM3: 0,
  preliminary: false,
  acceptanceAllowed: true,
  badge: { errors: 0, warnings: 0, pendingConfirmation: 0, failures: 0 },
};

const DISABLED_HEALTH = {
  state: 'disabled',
  since: null,
  code: '',
  attempts: 0,
  failed: 0,
  waiting: 0,
};

describe('разбор талонов при выключенном распознавании', () => {
  it('вместо «расхождений нет» говорит, что сверять нечего', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(EMPTY_TICKETS),
      'GET /waste-requests/ticket-recognition/health': () => json(DISABLED_HEALTH),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Зелёное «Расхождений нет» здесь означало бы, что объём, дата и номер проверены. Они не
    // проверены: талонов нет ни машинных, ни ручных.
    await waitFor(() => expect(screen.getByText(/сверять нечего/i)).toBeDefined());
    expect(screen.queryByText(/Расхождений нет/i)).toBeNull();
  });

  it('приложенный талон виден строкой «в разбор не поступал»', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(EMPTY_TICKETS),
      'GET /waste-requests/ticket-recognition/health': () => json(DISABLED_HEALTH),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Раньше такой файл не попадал в ответ вовсе, и экран показывал пустоту там, где бумага лежит.
    await waitFor(() => expect(screen.getAllByText(/в разбор не поступал/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/распознавание было выключено/i)).toBeDefined();
  });

  it('баннер называет выключенный модуль выключенным', async () => {
    mockHttp({
      'GET /waste-requests/ticket-recognition/health': () => json(DISABLED_HEALTH),
    });
    renderWithUser(<TicketRecognitionBanner enabled />);

    await waitFor(() => expect(screen.getByText(/Распознавание талонов выключено/i)).toBeDefined());
    // И сразу говорит, что делать: ждать нечего, талон заводится руками.
    expect(screen.getByText(/вручную/i)).toBeDefined();
  });

  it('исправная подсистема баннера не рисует', async () => {
    mockHttp({
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    const { container } = renderWithUser(<TicketRecognitionBanner enabled />);

    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
