import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestBulkResultDto, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { assignedServiceRequest, heldServiceRequest, serviceOperator } from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import {
  clearServiceBulkRun,
  saveServiceBulkRun,
  serviceBulkFingerprint,
} from '../src/pages/service/serviceBulkCommands';

/**
 * Подтверждение, прогресс и отчёт массовой команды (план
 * `docs/office-equipment-bulk-actions-plan.md`, §11.4).
 *
 * Проверяется протокол попытки, а не разметка: ключ идемпотентности уходит заголовком, повторное
 * нажатие во время выполнения второго запроса не шлёт, повтор после обрыва идёт ТЕМ ЖЕ ключом, а
 * «Повторить неудавшиеся» — новой пачкой со свежими версиями. Ошибка здесь стоит чужой работы:
 * второй ключ на ту же команду означает полсотни дважды отменённых заявок.
 */

const OPERATOR: AuthUser = serviceOperator();
const UUID = /^[0-9a-f-]{36}$/u;

/** Заголовки `mockHttp` не журналирует, а ключ идемпотентности живёт именно заголовком. */
interface SentRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const LIVE = assignedServiceRequest({
  id: '11111111-1111-4111-8111-111111111111',
  num: 14,
  displayNumber: 'СО-14',
  version: 3,
});
const HELD = heldServiceRequest('in_work', {
  id: '22222222-2222-4222-8222-222222222222',
  num: 15,
  displayNumber: 'СО-15',
  version: 5,
});

function renderTab(items: ServiceRequestDto[], over: RouteMap = {}) {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    // Состояние пачки: окно спрашивает его ради прогресса и после перезагрузки вкладки.
    'GET /service-requests/bulk/:key': ({ params }) =>
      json({
        operationId: 'op-1',
        state: 'running',
        requested: 2,
        processed: 0,
        result: null,
        key: params.key,
      }),
    ...over,
  });
  const sent: SentRequest[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      method: init?.method ?? 'GET',
      path: new URL(raw, window.location.origin).pathname,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return { http, sent };
}

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr') as HTMLElement;
const boxOf = (text: string): HTMLInputElement =>
  rowOf(text).querySelector('input[type="checkbox"]') as HTMLInputElement;

/** Кнопка полосы по началу подписи: счётчик применимых в ней же. */
function barButton(prefix: string): HTMLButtonElement {
  const bar = document.querySelector('.table-footer__bar') as HTMLElement;
  const found = [...bar.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').startsWith(prefix),
  );
  if (!found) throw new Error(`в полосе нет команды «${prefix}»: ${bar.textContent}`);
  return found as HTMLButtonElement;
}

const dialog = (): HTMLElement => document.querySelector('.ant-modal-wrap') as HTMLElement;
const dialogText = (): string => dialog()?.textContent ?? '';
const modalButton = (name: string): HTMLButtonElement =>
  [...dialog().querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').startsWith(name),
  ) as HTMLButtonElement;

const bulkPosts = (sent: SentRequest[]) =>
  sent.filter((r) => r.method === 'POST' && r.path.endsWith('/service-requests/bulk'));

/** Выбрать обе строки и открыть окно названной команды. */
async function pick(prefix: string): Promise<void> {
  expect(await screen.findByText('СО-14')).toBeDefined();
  fireEvent.click(boxOf('СО-14'));
  fireEvent.click(boxOf('СО-15'));
  await waitFor(() => barButton(prefix));
  fireEvent.click(barButton(prefix));
  await waitFor(() => expect(dialog()).toBeTruthy());
}

const cancelResult = (): ServiceRequestBulkResultDto => ({
  operationId: 'op-1',
  operation: 'cancel',
  done: 1,
  failed: 1,
  rows: [
    {
      index: 0,
      id: '11111111-1111-4111-8111-111111111111',
      displayNumber: 'СО-14',
      outcome: 'done',
    },
    {
      index: 1,
      id: '22222222-2222-4222-8222-222222222222',
      displayNumber: 'СО-15',
      outcome: 'failed',
      code: 'version',
      reason: 'Заявку изменили в другом окне',
    },
  ],
});

beforeEach(() => clearServiceBulkRun());

describe('подтверждение', () => {
  it('называет применимые, перечисляет остальные с причиной и подписывает кнопку числом', async () => {
    renderTab([LIVE, HELD]);
    await pick('Отложить');

    // Число применимых — первым делом: команда собиралась глазами, и «к скольким» человек обязан
    // узнать до нажатия, а не из отчёта.
    expect(dialogText()).toContain('Применится к 1 из 2 выбранных заявок');
    expect(dialogText()).toContain('СО-15 — Действие этой заявке недоступно (статус «Отложена»)');
    expect(modalButton('Отложить: 1 заявку')).toBeTruthy();
  });

  it('пустая обязательная причина не уходит на сервер, а встаёт в окне', async () => {
    const { sent } = renderTab([LIVE, HELD]);
    await pick('Отложить');

    fireEvent.click(modalButton('Отложить: 1 заявку'));

    await waitFor(() => expect(dialogText()).toContain('Укажите причину'));
    expect(bulkPosts(sent)).toHaveLength(0);
  });
});

describe('отправка', () => {
  it('уходит с ключом идемпотентности, а повторное нажатие второго запроса не шлёт', async () => {
    // Ответ придёт по команде теста: пока он в пути, кнопка видна — и её нажимают ещё раз.
    let release: (r: MockResponse) => void = () => {};
    const held = new Promise<MockResponse>((resolve) => {
      release = resolve;
    });
    const { sent } = renderTab([LIVE, HELD], { 'POST /service-requests/bulk': () => held });
    await pick('Отменить');

    fireEvent.change(screen.getByLabelText(/Причина отмены/u), {
      target: { value: 'сервис не выезжает до понедельника' },
    });
    const submit = modalButton('Отменить: 2 заявки');
    fireEvent.click(submit);
    await waitFor(() => expect(bulkPosts(sent)).toHaveLength(1));

    // Пачка идёт секунды, кнопка всё это время видна: второе нажатие обязано ничего не отправить.
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(bulkPosts(sent)).toHaveLength(1);
    expect(bulkPosts(sent)[0]?.headers['Idempotency-Key']).toMatch(UUID);

    release(json(cancelResult()));
    await waitFor(() => expect(dialogText()).toContain('Выполнено: 1'));
  });
});

describe('отчёт', () => {
  it('показывает исход каждой строки, а повтор неудавшихся идёт новой пачкой со свежими версиями', async () => {
    let rows: ServiceRequestDto[] = [LIVE, HELD];
    const { http, sent } = renderTab(rows, {
      'GET /service-requests': () => json(list(rows)),
      'POST /service-requests/bulk': () => json(cancelResult()),
    });
    await pick('Отменить');
    fireEvent.change(screen.getByLabelText(/Причина отмены/u), {
      target: { value: 'площадку закрыли' },
    });
    /*
     * Пачка отработала: первая заявка отменена, а вторая уехала по версии — её и правил тот, из-за
     * кого отказ. Список после операции перечитывается, и повтор обязан взять версии ОТТУДА.
     */
    rows = [
      { ...LIVE, status: 'cancelled', version: 4 },
      { ...HELD, version: 6 },
    ];
    fireEvent.click(modalButton('Отменить: 2 заявки'));

    await waitFor(() => expect(dialogText()).toContain('Выполнено: 1. Не вышло: 1.'));
    expect(dialogText()).toContain('СО-14');
    expect(dialogText()).toContain('Заявку изменили в другом окне');
    // Неудавшаяся строка открывается карточкой — тем же адресом, каким её открывает письмо.
    expect(dialog().querySelector('a[href*="open=22222222"]')).toBeTruthy();

    // Признак того, что перечитанный список доехал до экрана: первая строка уже отменена.
    await waitFor(() => expect(screen.getAllByText(/Отменена/u).length).toBeGreaterThan(0));
    expect(http.countOf('GET /service-requests')).toBeGreaterThan(1);

    fireEvent.click(modalButton('Повторить неудавшиеся'));
    await waitFor(() => expect(bulkPosts(sent)).toHaveLength(2));

    const [first, second] = bulkPosts(sent);
    // Новая пачка — новый ключ: это вторая команда, а не повтор той же попытки.
    expect(second?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
    const body = http.lastCall('POST /service-requests/bulk')?.body as {
      operation: string;
      reason: string;
      rows: { id: string; version: number }[];
    };
    expect(body.operation).toBe('cancel');
    expect(body.reason).toBe('площадку закрыли');
    expect(body.rows).toEqual([{ id: '22222222-2222-4222-8222-222222222222', version: 6 }]);
  });
});

describe('обрыв связи', () => {
  it('«Повторить» шлёт ТОТ ЖЕ ключ: это повтор попытки, а не вторая команда', async () => {
    const { sent } = renderTab([LIVE, HELD], {
      'POST /service-requests/bulk': () => {
        throw new Error('Failed to fetch');
      },
    });
    await pick('Отменить');
    fireEvent.change(screen.getByLabelText(/Причина отмены/u), {
      target: { value: 'сервис не выезжает' },
    });
    fireEvent.click(modalButton('Отменить: 2 заявки'));

    await waitFor(() => expect(modalButton('Повторить')).toBeTruthy());
    fireEvent.click(modalButton('Повторить'));
    await waitFor(() => expect(bulkPosts(sent)).toHaveLength(2));

    const keys = bulkPosts(sent).map((r) => r.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('доступность', () => {
  it('фокус уходит в окно, а Escape закрывает подтверждение', async () => {
    renderTab([LIVE, HELD]);
    await pick('Отменить');

    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(document.querySelector('.ant-modal-wrap')).toBeNull());
    // Набор при этом остался: человек передумал про команду, а не про строки.
    expect(document.querySelector('.table-footer__bar')?.textContent).toContain('Выбрано 2 заявки');
  });

  it('отчёт с неудачами клавишей не закрывается', async () => {
    renderTab([LIVE, HELD], { 'POST /service-requests/bulk': () => json(cancelResult()) });
    await pick('Отменить');
    fireEvent.change(screen.getByLabelText(/Причина отмены/u), {
      target: { value: 'площадку закрыли' },
    });
    fireEvent.click(modalButton('Отменить: 2 заявки'));
    await waitFor(() => expect(dialogText()).toContain('Не вышло: 1'));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    // Отчёт о чужой работе не исчезает сам: его закрывают кнопкой, прочитав.
    expect(dialogText()).toContain('Не вышло: 1');
  });
});

describe('перезагрузка вкладки', () => {
  it('пачка восстанавливается из sessionStorage и показывает свой отчёт', async () => {
    const body = {
      operation: 'cancel' as const,
      rows: [{ id: '22222222-2222-4222-8222-222222222222', version: 5 }],
      reason: 'закрыли',
    };
    saveServiceBulkRun({
      key: '11111111-2222-4333-8444-555555555555',
      operation: 'cancel',
      fingerprint: serviceBulkFingerprint(body),
      body,
    });
    const { http } = renderTab([LIVE, HELD], {
      'GET /service-requests/bulk/:key': () =>
        json({
          operationId: 'op-7',
          state: 'finished',
          requested: 1,
          processed: 1,
          result: {
            operationId: 'op-7',
            operation: 'cancel',
            done: 1,
            failed: 0,
            rows: [
              {
                index: 0,
                id: '22222222-2222-4222-8222-222222222222',
                displayNumber: 'СО-15',
                outcome: 'done',
              },
            ],
          },
        }),
    });

    await waitFor(() => expect(dialogText()).toContain('Выполнено: 1'));
    expect(http.countOf('GET /service-requests/bulk/:key')).toBeGreaterThan(0);
  });
});
