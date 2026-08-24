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

/** Кадр с двумя талонами: ровно тот случай, ради которого разбивка и нужна. */
const TWO_ON_ONE_PAGE = {
  ...EMPTY_TICKETS,
  tickets: [
    {
      id: 't-1',
      requestId: 'wr-1',
      pageId: 'p-1',
      seq: 1,
      origin: 'ocr',
      status: 'unconfirmed',
      number: '30476',
      issuedOn: '2026-08-17',
      volumeM3: 20,
      workKind: 'removal',
      addressRaw: 'Волоколамское ш., 71к14',
      needsReviewFields: [],
      candidates: [],
      operatorCounterpartyId: null,
      operatorName: null,
      editedAt: null,
      editedByName: null,
      confirmedAt: null,
      confirmedByName: null,
      duplicateOverride: null,
      proposal: null,
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
    {
      id: 't-2',
      requestId: 'wr-1',
      pageId: 'p-1',
      seq: 2,
      origin: 'ocr',
      status: 'unconfirmed',
      number: '30477',
      issuedOn: null,
      volumeM3: null,
      workKind: 'idle',
      addressRaw: '',
      needsReviewFields: [],
      candidates: [],
      operatorCounterpartyId: null,
      operatorName: null,
      editedAt: null,
      editedByName: null,
      confirmedAt: null,
      confirmedByName: null,
      duplicateOverride: null,
      proposal: null,
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
  ],
  pages: [{ id: 'p-1', fileId: 'f-1', pageNo: 1, status: 'done', ticketsFound: 2 }],
  files: [],
};

describe('карточка талона: четыре поля и разбивка кадра', () => {
  it('поля показаны по одному в строке, включая пустые', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(TWO_ON_ONE_PAGE),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Четыре подписи на каждый талон: сверяют с бумагой поле за полем, а не строкой таблицы.
    await waitFor(() => expect(screen.getAllByText('№ талона')).toHaveLength(2));
    expect(screen.getAllByText('Дата')).toHaveLength(2);
    expect(screen.getAllByText('Объём')).toHaveLength(2);
    expect(screen.getAllByText('Адрес')).toHaveLength(2);

    expect(screen.getByText('30476')).toBeDefined();
    expect(screen.getByText('20 м³')).toBeDefined();
    expect(screen.getByText('Волоколамское ш., 71к14')).toBeDefined();
    // У простоя объёма нет законно, и это сказано словами, а не прочерком (Р2).
    expect(screen.getByText(/простой — объёма нет/i)).toBeDefined();
  });

  it('говорит, который из двух талонов кадра перед тобой', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(TWO_ON_ONE_PAGE),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Без этой подписи две карточки с одной страницы выглядят как два разных скана.
    await waitFor(() => expect(screen.getByText(/талон 1 из 2/i)).toBeDefined());
    expect(screen.getByText(/талон 2 из 2/i)).toBeDefined();
    // Открыть тот самый лист можно не уходя из карточки.
    expect(screen.getAllByRole('button', { name: 'Скан' })).toHaveLength(2);
  });
});
