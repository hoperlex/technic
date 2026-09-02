import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { WasteTicketBadgeDto } from '@technic/contracts';
import { wasteRequestKeys } from '@entities/waste-request';
import { apiError, json, mockHttp } from './http';
import { createTestQueryClient, renderWithUser } from './render';
import { wasteRequest } from './factories/waste';
import { TicketCell } from '../src/features/waste-ticket-review';

/**
 * Кнопка подтверждения талонов прямо из строки списка (план `docs/waste-ticket-auto-confirm-plan.md`,
 * Р26, Р27).
 *
 * Проверяется ровно то, что кнопка обещает, и то, чем она опасна:
 *
 * 1. У сошедшейся заявки в ячейке кнопка, а не разбивка значка, — иначе клик пришлось бы искать в
 *    карточке, ради чего вся работа и затевалась;
 * 2. при любом поводе для разбора (здесь — нечитаемый файл) кнопки нет вовсе: обещать «всё
 *    сошлось» там, где не сошлось, хуже, чем не обещать ничего;
 * 3. клик уходит с отпечатком НАБОРА, который человек видел, а не с числом: между отрисовкой и
 *    кликом набор мог смениться при том же счёте (Р23);
 * 4. на отказ сервера показан его текст И погашен список. Второе — отдельное требование Р27:
 *    сервер отказывает по той же сверке, по которой портал нарисовал кнопку, значит сверка
 *    изменилась, и строка обязана перечитаться — иначе в ней останется кнопка, которой только что
 *    отказали.
 */

const CONFIRM_READY = 'POST /waste-requests/:id/tickets/confirm-ready';

/** Строка кэша списка: корень берётся из фабрики — тот же, что гасит ячейка. */
const LIST_KEY = [...wasteRequestKeys.root, { page: 1 }];

/** Значок сошедшейся заявки: два талона прочитаны, замечаний нет, разбирать нечего. */
const READY: WasteTicketBadgeDto = {
  errors: 0,
  warnings: 0,
  pendingConfirmation: 2,
  failures: 0,
  unreviewedPaper: 0,
  confirmable: 2,
  confirmableFingerprint: 'fp-two-tickets',
};

/** Заявка выполнена — до неё разбор дошёл, и только у такой кнопка вообще возможна (Р17). */
const readyRequest = (badge: WasteTicketBadgeDto = READY) =>
  wasteRequest({ status: 'done', ticketBadge: badge });

describe('сошедшийся талон подтверждается кнопкой из строки списка', () => {
  it('у чистой сверки в ячейке кнопка, а не значки', () => {
    mockHttp({});
    const { container } = renderWithUser(<TicketCell request={readyRequest()} />);

    expect(screen.getByRole('button', { name: 'Подтвердить талоны' })).toBeDefined();
    // Значков рядом с кнопкой нет: два способа сказать одно и то же в узкой колонке — это не
    // подробность, а вопрос «так сошлось или нет?».
    expect(container.textContent).not.toContain('⏳');
  });

  it('число подтверждаемых талонов человек читает в подсказке', async () => {
    mockHttp({});
    renderWithUser(<TicketCell request={readyRequest()} />);

    // На самой кнопке текста нет по требованию заказчика — колонка узкая; сколько именно талонов
    // уйдёт в подтверждение, обязана сказать подсказка, иначе клик вслепую.
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Подтвердить талоны' }));
    expect(await screen.findByText('Подтвердить талоны: 2 — всё сошлось')).toBeDefined();
  });

  it('нечитаемый файл возвращает в ячейку значки, а кнопку убирает', () => {
    mockHttp({});
    // Талоны те же и по-прежнему готовы к подтверждению — мешает файл, который не прочитался:
    // кликом его не починить, и «всё сошлось» про такую заявку сказать нельзя.
    const { container } = renderWithUser(
      <TicketCell request={readyRequest({ ...READY, failures: 1 })} />,
    );

    expect(screen.queryByRole('button', { name: 'Подтвердить талоны' })).toBeNull();
    expect(container.textContent).toContain('🚫');
    expect(container.textContent).toContain('⏳');
  });

  it('клик уходит с отпечатком набора и отвечает числом подтверждённых', async () => {
    const http = mockHttp({ [CONFIRM_READY]: () => json({ ok: true, confirmed: 2 }) });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(LIST_KEY, { items: [], total: 0 });
    renderWithUser(<TicketCell request={readyRequest()} />, { queryClient });

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить талоны' }));

    await waitFor(() => expect(http.countOf(CONFIRM_READY)).toBe(1));
    // Отпечаток, а не счёт: сервер обязан подтвердить ровно тот набор, что был в строке.
    expect(http.lastCall(CONFIRM_READY)?.body).toEqual({ fingerprint: 'fp-two-tickets' });
    expect(http.lastCall(CONFIRM_READY)?.path).toBe('/waste-requests/wr-1/tickets/confirm-ready');
    // Число — из ответа: значок показывал обещание, а сервер считал под замком заявки.
    expect(await screen.findByText('Подтверждено талонов: 2')).toBeDefined();
    await waitFor(() => expect(queryClient.getQueryState(LIST_KEY)?.isInvalidated).toBe(true));
  });

  it('отказ сервера показан словами и всё равно гасит список', async () => {
    mockHttp({
      [CONFIRM_READY]: () =>
        apiError(409, {
          code: 'waste_ticket_auto_confirm_blocked',
          message: 'Разбор изменился — не подтверждено талонов: 1',
        }),
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(LIST_KEY, { items: [], total: 0 });
    renderWithUser(<TicketCell request={readyRequest()} />, { queryClient });

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить талоны' }));

    expect(await screen.findByText(/Разбор изменился/u)).toBeDefined();
    // Главное здесь — не тост, а перечитывание списка: сверка на сервере уже не та, что нарисовала
    // кнопку, и оставленная строка предлагала бы человеку жать её снова и снова.
    await waitFor(() => expect(queryClient.getQueryState(LIST_KEY)?.isInvalidated).toBe(true));
  });
});
