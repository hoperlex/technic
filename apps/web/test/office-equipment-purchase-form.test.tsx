import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { permissionsFor, type AuthUser } from '@technic/contracts';
import { json, mockHttp, type MockResponse, type RouteHandler, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { OfficeEquipmentPurchaseFormModal } from '../src/pages/service/OfficeEquipmentPurchaseFormModal';
import {
  consumableDto,
  detailDto,
  prefillRow,
  PURCHASES,
} from './factories/officeEquipmentPurchase';

/**
 * Форма плановой закупки (план `docs/office-equipment-consumables-and-purchase-plan.md`, Р16, Р17).
 *
 * Проверяется то, ради чего протокол и заведён, — а happy path этого не ловит.
 *
 * КЛЮЧ ОТПРАВКИ ЖИВЁТ ОТ ОТКРЫТИЯ ФОРМЫ, а не рождается на каждое нажатие. Смысл ключа — «та же
 * попытка»: человек нажал «Завести», ответ потерялся, он нажал ещё раз — и второй запрос обязан
 * попасть в тот же ключ, чтобы сервер вернул уже созданную закупку, а не завёл вторую. Ключ на
 * нажатие означал бы, что защиты нет вовсе, и увидеть это можно только по заголовкам двух запросов.
 *
 * ТРИ 409 РАЗЛИЧАЮТСЯ ПО КОДУ, и исходы у них разные: устаревший снимок лечится повторной
 * отправкой со свежими числами, занятый ключ — только новой попыткой. Общий тост «конфликт версий»
 * на первом предложил бы переспросить ровно то же самое, а на втором — отправить второй раз то, что
 * уже отправлено.
 */

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  permissions: [
    ...permissionsFor({ role: 'shtab', counterpartyType: null, addons: [] }),
    'officeEquipment.read',
    'officeEquipmentPurchases.manage',
  ],
});

const PREFILL = 'GET /office-equipment-purchases/prefill';
const CONSUMABLES = 'GET /office-equipment-consumables';

interface SentRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Заголовки `mockHttp` не журналирует — ему хватает метода, пути и тела. Ключ идемпотентности живёт
 * именно заголовком (Р17: он свойство попытки, а не её тела), поэтому запросы подсматриваются
 * поверх мока — тем же приёмом, что в кабинете водителя. Снимать подмену не нужно: общий хук
 * возвращает настоящий `fetch` после каждого теста.
 */
function renderForm(over: RouteMap = {}) {
  const http = mockHttp({
    [PREFILL]: () => json({ rows: [prefillRow()] }),
    [CONSUMABLES]: () => json(list([consumableDto()])),
    ...over,
  });
  const sent: SentRequest[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      path: new URL(raw, window.location.origin).pathname,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;

  renderWithUser(<OfficeEquipmentPurchaseFormModal open purchase={null} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return { http, sent };
}

/** Ключи отправки всех `POST` закупки в порядке ухода. */
function keysOf(sent: SentRequest[]): string[] {
  return sent
    .filter((r) => r.method === 'POST' && r.path.endsWith('/office-equipment-purchases'))
    .map((r) => r.headers['Idempotency-Key'] ?? '');
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Завести закупку' }));

describe('форма плановой закупки', () => {
  it('приходит предзаполненной и показывает, из чего сложилось количество', async () => {
    renderForm();
    await screen.findByText('Тонер Ricoh 201 (шт)');

    // Количество равно «к закупке», а не единице: форма предлагает то, что посчитал сервер.
    const quantity = document.querySelector<HTMLInputElement>('table input[role="spinbutton"]');
    expect(quantity!.value).toBe('12');
    // И рядом — три числа, из которых оно вышло: без них «12» пришлось бы принимать на веру.
    expect(screen.getByText(/потребность 20 · на складе 5 · уже заказано 3/)).toBeTruthy();
  });

  it('пустую закупку не заводит и говорит об этом словами', async () => {
    mockHttp({
      [PREFILL]: () => json({ rows: [] }),
      [CONSUMABLES]: () => json(list([consumableDto()])),
    });
    renderWithUser(<OfficeEquipmentPurchaseFormModal open purchase={null} onClose={() => {}} />, {
      user: OPERATOR,
    });

    await screen.findByText('Заказывать нечего');
    /*
     * Кнопка выключена, а не отвечает отказом: пустая закупка — это отсутствие закупки, и схема
     * такого тела не примет. Звать человека на 422 незачем.
     */
    const button = screen.getByRole('button', { name: 'Завести закупку' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('повтор того же нажатия несёт тот же ключ отправки', async () => {
    let attempt = 0;
    const { sent, http } = renderForm({
      [PURCHASES.create]: (): MockResponse => {
        attempt += 1;
        // Первый ответ «потерялся» пятисоткой: ровно тот случай, ради которого ключ и заведён —
        // человек не знает, дошла ли закупка, и нажимает ещё раз.
        return attempt === 1
          ? { status: 500, body: { code: 'internal', message: 'Сервер недоступен' } }
          : json(detailDto());
      },
    });
    await screen.findByText('Тонер Ricoh 201 (шт)');

    submit();
    await waitFor(() => expect(http.countOf(PURCHASES.create)).toBe(1));
    submit();
    await waitFor(() => expect(http.countOf(PURCHASES.create)).toBe(2));

    const keys = keysOf(sent);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    // Тот же ключ — значит сервер узнает повтор и вернёт уже созданную закупку, а не заведёт вторую.
    expect(keys[1]).toBe(keys[0]);
  });

  it('устаревший снимок показывает новые числа и уходит повторной отправкой', async () => {
    let attempt = 0;
    const create: RouteHandler = () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          status: 409,
          body: {
            code: 'office_equipment_purchase_snapshot',
            message: 'Числа по складу изменились — проверьте новые и повторите',
            details: {
              kind: 'snapshot',
              rows: [
                {
                  consumableId: 'oec-1',
                  code: 'Д0000093569',
                  name: 'Тонер Ricoh 201 (шт)',
                  expectedRequired: 20,
                  expectedStock: 5,
                  expectedAlreadyOrdered: 3,
                  actualRequired: 20,
                  actualStock: 9,
                  actualAlreadyOrdered: 3,
                  actualSuggested: 8,
                },
              ],
            },
          },
        };
      }
      return json(detailDto());
    };
    const { http } = renderForm({ [PURCHASES.create]: create });
    await screen.findByText('Тонер Ricoh 201 (шт)');

    submit();
    await screen.findByText('Числа по складу изменились, пока форма была открыта');
    // Новые числа встали прямо в строку, а прежние остались рядом: иначе свежие читались бы как
    // первые, и человек не понял бы, что именно уехало.
    expect(screen.getByText(/потребность 20 · на складе 9 · уже заказано 3/)).toBeTruthy();
    expect(screen.getByText(/было: потребность 20 · на складе 5/)).toBeTruthy();

    /*
     * Отдельной галочки «подтверждаю» нет: повторная отправка со свежим снимком и есть
     * подтверждение (Р17). Количество при этом портал не трогал — решение «заказать 12» осталось
     * за человеком, и осознанное превышение разрешено.
     */
    submit();
    await waitFor(() => expect(http.countOf(PURCHASES.create)).toBe(2));
    const body = http.lastCall(PURCHASES.create)!.body as {
      items: { quantity: number; expectedStock: number }[];
    };
    expect(body.items[0]!.expectedStock).toBe(9);
    expect(body.items[0]!.quantity).toBe(12);
  });

  it('занятый ключ отправки объясняется словами и не зовёт нажать ещё раз', async () => {
    renderForm({
      [PURCHASES.create]: (): MockResponse => ({
        status: 409,
        body: {
          code: 'office_equipment_purchase_idempotency',
          message: 'Под этим ключом отправки уже принята другая закупка',
        },
      }),
    });
    await screen.findByText('Тонер Ricoh 201 (шт)');

    submit();
    /*
     * Единственный из трёх отказов, который повторной отправкой не лечится: ключ описывает попытку,
     * и если под ним принято другое тело, нужна новая попытка, а не то же нажатие. Поэтому текст
     * зовёт закрыть окно и проверить список — вдруг предыдущая отправка уже дошла.
     */
    await screen.findByText('Ключ этой отправки уже занят другой командой');
    expect(screen.getByText(/Закройте окно и откройте форму заново/)).toBeTruthy();
  });
});
