import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { WasteTicketsPanel } from '../src/features/waste-ticket-review';

/**
 * Год в дате талона: подпись с транскрипцией и кнопка «Исправить год» (ADR 0166, п. 6 и п. 7,
 * решения Р11 и Р12 плана `docs/waste-ticket-date-escalation-plan.md`).
 *
 * Проверяется не «нарисовалось ли», а три границы, каждая из которых обещает человеку разное:
 *
 * 1. подпись «OCR в графе» стоит только там, где транскрипция есть и дата не спорна: у спорной
 *    рядом уже два кандидата, и третий текст без объяснения, к какому из них он относится, только
 *    запутает (п. 7);
 * 2. кнопка уходит в существующую правку талона одним предметным полем и служебным маркером —
 *    новой ручки под клик не заводилось, а маркером сервер отличает его от ручного ввода (п. 6);
 * 3. кнопки нет у отклонённого талона, у спорной даты и у принятого замечания: в первых двух
 *    случаях править нечего, в третьем человек уже решил, что расхождение законное.
 */

/** Талон с датой на год раньше якоря: ровно тот случай, ради которого подсказка и заведена. */
const TICKET = {
  id: 't-1',
  requestId: 'wr-1',
  pageId: 'p-1',
  seq: 1,
  origin: 'ocr',
  status: 'unconfirmed',
  number: '30476',
  issuedOn: '2025-08-17',
  issuedOnRaw: '17.08.25',
  volumeM3: 20,
  workKind: 'removal',
  addressRaw: 'Волоколамское ш., 71к14',
  needsReviewFields: [] as string[],
  candidates: [],
  operatorCounterpartyId: null,
  operatorName: null,
  editedAt: null,
  editedByName: null,
  confirmedAt: null,
  confirmedByName: null,
  duplicateOverride: null,
  proposal: null,
  createdAt: '2026-09-07T09:00:00.000Z',
  updatedAt: '2026-09-07T09:00:00.000Z',
};

const MESSAGE = 'Дата талона разошлась с днём вывоза — вероятно, неверно распознан год';

/** Замечание с проверяемой заменой года: строит её сервер, портал только предлагает клик. */
const CHECK = {
  code: 'date_mismatch',
  severity: 'warning',
  subjectKey: 't-1',
  message: MESSAGE,
  preliminary: false,
  suggestedIssuedOn: '2026-08-17',
  resolution: null,
};

const TICKETS = 'GET /waste-requests/wr-1/tickets';
const UPDATE = 'PATCH /waste-requests/wr-1/tickets/t-1';

const listing = (
  tickets: Record<string, unknown>[] = [TICKET],
  check: Record<string, unknown> = {},
) =>
  json({
    tickets,
    pages: [{ id: 'p-1', fileId: 'f-1', pageNo: 1, status: 'done', ticketsFound: 1 }],
    files: [],
    checks: [{ ...CHECK, ...check }],
    attempts: [],
    blindChecks: [],
    ticketsVolumeM3: 20,
    preliminary: false,
    acceptanceAllowed: true,
    badge: { errors: 0, warnings: 1, pendingConfirmation: 1, failures: 0, unreviewedPaper: 0 },
  });

describe('транскрипция под датой талона', () => {
  it('стоит подписью «OCR в графе», а не «на бланке»', async () => {
    mockHttp({ [TICKETS]: () => listing() });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Формулировка — часть обещания: `issuedOnRaw` такой же ответ модели, как и сама дата, и
    // «на бланке» выдавало бы её за гарантированное содержимое бумаги.
    await waitFor(() => expect(screen.getByText('OCR в графе: 17.08.25')).toBeDefined());
  });

  it('не рисуется ни у спорной даты, ни без самой транскрипции', async () => {
    mockHttp({
      [TICKETS]: () =>
        listing([
          { ...TICKET, issuedOn: null, needsReviewFields: ['issuedOn'] },
          { ...TICKET, id: 't-2', seq: 2, number: '30477', issuedOnRaw: '' },
        ]),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Спорная дата уже показывает двух кандидатов, а у ручных и старых машинных талонов
    // транскрипции нет вовсе — строки в обоих случаях нет.
    await waitFor(() => expect(screen.getAllByText('Дата')).toHaveLength(2));
    expect(screen.queryByText(/OCR в графе/)).toBeNull();
  });
});

describe('кнопка «Исправить год» в полосе замечаний', () => {
  it('называет год из подсказки и правит талон существующей ручкой', async () => {
    const http = mockHttp({
      [TICKETS]: () => listing(),
      [UPDATE]: () => json({ ok: true }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    const button = await screen.findByRole('button', { name: 'Исправить год на 2026' });
    // Два клика подряд — один запрос: сервер строит подсказку заново под замком заявки, и повтор
    // по уже исправленной дате получил бы конфликт там, где всё сделано.
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    // Предметное поле ровно одно, рядом служебный маркер: по нему сервер знает, что подсказку
    // нужно перестроить и сверить, а аудит — что писать `metadata.source`.
    expect(http.lastCall(UPDATE)!.body).toEqual({
      issuedOn: '2026-08-17',
      editSource: 'year_suggestion',
    });
  });

  it('на конфликт показывает ответ сервера и перечитывает карточку', async () => {
    const http = mockHttp({
      [TICKETS]: () => listing(),
      [UPDATE]: () =>
        json({ code: 'conflict', message: 'Подсказка года изменилась — обновите карточку' }, 409),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Исправить год на 2026' }));

    // Отказ здесь — нормальный ход событий: карточка была открыта, пока правили заявку. Список
    // гасится и на нём, иначе человек жал бы ту же кнопку снова.
    await waitFor(() => expect(screen.getByText(/Подсказка года изменилась/)).toBeDefined());
    await waitFor(() => expect(http.countOf(TICKETS)).toBeGreaterThan(1));
  });

  it('не появляется у принятого замечания', async () => {
    mockHttp({
      [TICKETS]: () =>
        listing([TICKET], {
          resolution: {
            acceptedByName: 'Петров П.',
            acceptedAt: '2026-09-07T10:00:00.000Z',
            comment: 'вывоз был позже плановой даты',
          },
        }),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Человек уже решил, что расхождение законное; кнопка звала бы исправлять верную дату.
    await waitFor(() => expect(screen.getByText(/Принято: Петров П./)).toBeDefined());
    expect(screen.queryByRole('button', { name: /Исправить год/ })).toBeNull();
  });

  it('не появляется у спорной даты', async () => {
    mockHttp({
      [TICKETS]: () => listing([{ ...TICKET, issuedOn: null, needsReviewFields: ['issuedOn'] }]),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    // Значения у талона нет вовсе, и менять «только год» не в чем: спор разбирают вручную.
    await waitFor(() => expect(screen.getByText(MESSAGE)).toBeDefined());
    expect(screen.queryByRole('button', { name: /Исправить год/ })).toBeNull();
  });

  it('не появляется у отклонённого талона', async () => {
    mockHttp({
      [TICKETS]: () =>
        listing([
          { ...TICKET, status: 'dismissed' },
          // Живой сосед оставлен нарочно: без него полоса сказала бы «сверять нечего» и
          // замечания не нарисовала вовсе — кнопки не было бы совсем по другой причине.
          { ...TICKET, id: 't-2', seq: 2, number: '30477' },
        ]),
    });
    renderWithUser(<WasteTicketsPanel requestId="wr-1" />);

    await waitFor(() => expect(screen.getByText(MESSAGE)).toBeDefined());
    expect(screen.queryByRole('button', { name: /Исправить год/ })).toBeNull();
  });
});
