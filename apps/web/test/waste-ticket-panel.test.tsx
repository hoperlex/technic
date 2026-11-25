import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
      contentType: 'image/jpeg',
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
  badge: { errors: 0, warnings: 0, pendingConfirmation: 0, failures: 0, unreviewedPaper: 0 },
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
    await waitFor(() =>
      expect(screen.getAllByText(/в разбор не поступал/i).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/распознавание было выключено/i)).toBeDefined();
  });

  it('баннер называет выключенный модуль выключенным', async () => {
    mockHttp({
      'GET /waste-requests/ticket-recognition/health': () => json(DISABLED_HEALTH),
    });
    renderWithUser(<TicketRecognitionBanner enabled />);

    await waitFor(() => expect(screen.getByText(/Распознавание талонов выключено/i)).toBeDefined());
    // It says what to do: unread scans wait for recognition and are reread once it is on; a
    // manual ticket settles only a read scan (snow-removal plan, §3.2), so it is not the way out.
    expect(screen.getByText(/«Перераспознать» у непрочитанных файлов/)).toBeDefined();
    expect(screen.getByText(/только для прочитанного скана/)).toBeDefined();
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
  files: [
    {
      fileId: 'f-1',
      filename: 'talon.jpg',
      contentType: 'image/jpeg',
      status: 'done',
      reason: '',
      errorClass: null,
      errorScope: null,
      totalPages: 1,
      processedPages: 1,
      activeJob: null,
      pages: [{ id: 'p-1', fileId: 'f-1', pageNo: 1, status: 'done', ticketsFound: 2 }],
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
  ],
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
    // Дата — по-русски: человек сверяет с бланком, где написано «17.08.2026», а не «2026-08-17».
    expect(screen.getByText('17.08.2026')).toBeDefined();
    expect(screen.queryByText('2026-08-17')).toBeNull();
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

describe('приложенные сканы показаны с номерами найденных талонов', () => {
  it('рядом с именем файла стоят номера, найденные именно в нём', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(TWO_ON_ONE_PAGE),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Имя файла само по себе не отвечает, разобрана ли бумага; рядом с номерами — отвечает.
    await waitFor(() => expect(screen.getByRole('button', { name: 'talon.jpg' })).toBeDefined());
    expect(screen.getByText('30476, 30477')).toBeDefined();
  });

  it('прочитанный файл без единого талона говорит об этом словами', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () =>
        json({
          ...EMPTY_TICKETS,
          files: [{ ...EMPTY_TICKETS.files[0], status: 'done', reason: '' }],
        }),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'talon.jpg' })).toBeDefined());
    expect(screen.getByText('талоны не найдены')).toBeDefined();
    // A read file is settled by a manual ticket: no rerun is pushed at it.
    expect(screen.queryByRole('button', { name: 'Перераспознать' })).toBeNull();
  });

  it('файл с нечитаемой страницей не выдаётся за прочитанный и предлагает перераспознать', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () =>
        json({
          ...EMPTY_TICKETS,
          // The worker ends a partly failed scan as `done`; the review counts it as failed.
          files: [
            {
              ...EMPTY_TICKETS.files[0],
              status: 'done',
              reason: '',
              pages: [
                { id: 'p-1', fileId: 'f-1', pageNo: 1, status: 'done', ticketsFound: 0 },
                { id: 'p-2', fileId: 'f-1', pageNo: 2, status: 'failed', ticketsFound: 0 },
              ],
            },
          ],
        }),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'talon.jpg' })).toBeDefined());
    expect(screen.getByText('не прочитан: не распознана страница')).toBeDefined();
    expect(screen.queryByText('талоны не найдены')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Перераспознать' }).length).toBeGreaterThan(0);
  });

  it('непрочитанный файл не выдаётся за «талоны не найдены» и предлагает перераспознать', async () => {
    const http = mockHttp({
      'GET /waste-requests/wr-1/tickets': () => json(EMPTY_TICKETS),
      'GET /waste-requests/ticket-recognition/health': () => json(DISABLED_HEALTH),
      'POST /waste-requests/:id/ticket-files/:fileId/recognize': () =>
        json({ ok: true, reused: true }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'talon.jpg' })).toBeDefined());
    // The file never reached recognition: a manual ticket would not settle it (§3.2).
    expect(screen.getByText('не распознавался')).toBeDefined();
    expect(screen.queryByText('талоны не найдены')).toBeNull();
    expect(screen.getByText(/ручной талон не закрывает/)).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'Перераспознать' })[0]!);
    await waitFor(() =>
      expect(http.countOf('POST /waste-requests/:id/ticket-files/:fileId/recognize')).toBe(1),
    );
    // The server joined a job already queued for the file instead of queueing a duplicate.
    expect(await screen.findByText('Распознавание файла уже идёт')).toBeDefined();
  });

  it('оборванная попытка и неудачный файл зовут перераспознать, а не ручной ввод', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/tickets': () =>
        json({
          ...EMPTY_TICKETS,
          files: [
            { ...EMPTY_TICKETS.files[0], fileId: 'f-1', filename: 'dead.jpg', status: 'pending' },
            {
              ...EMPTY_TICKETS.files[0],
              fileId: 'f-2',
              filename: 'bad.jpg',
              status: 'failed',
              reason: 'Скан не читается',
              errorClass: 'terminal',
              errorScope: 'file',
            },
          ],
        }),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ ...DISABLED_HEALTH, state: 'ok' }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    await waitFor(() =>
      expect(screen.getAllByText(/попытка оборвалась без результата/).length).toBeGreaterThan(0),
    );
    expect(
      screen.getByText(/Этот файл прочитать не удалось: нажмите «Перераспознать»/),
    ).toBeDefined();
    expect(screen.queryByText(/заведите талон вручную/)).toBeNull();
    expect(screen.getAllByText('не прочитан')).toHaveLength(2);
  });
});
