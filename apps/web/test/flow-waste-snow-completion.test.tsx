import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { WasteRequestCompletionDto, WasteRequestDto } from '@technic/contracts';
import { list } from './factories/common';
import { objectDto, wasteRequest, wasteSummary } from './factories/waste';
import { apiError, json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { WasteRequestsPage } from '../src/pages/waste';

/**
 * Closing a snow request (snow-removal plan, §1, §3.3): the actual volume, an optional invoice
 * amount and the removal day. No price list stands behind snow, so the window neither asks for a
 * tariff nor recomputes the cost from the volume, a cleared amount goes as null and a typed zero
 * as zero. The window starts clean for every target and opening, and a correction opens on the
 * saved fact. A 409 reloads the saved fact before the person retries or discards their uploads.
 */

const SNOW = wasteRequest({
  id: 'wr-s1',
  displayNumber: 'М-201',
  requestType: 'snow_removal',
  wasteTypeId: '29cd9e92-0d72-4666-8ff1-76e0d6aad553',
  wasteTypeName: 'Снег',
  volumeM3: 16,
  pricePerM3: null,
  amount: null,
  status: 'confirmed',
  operatorCounterpartyId: 'cp-1',
  operatorName: 'ООО «Чистый двор»',
  tickets: [
    {
      id: 'f-old',
      filename: 'old.jpg',
      contentType: 'image/jpeg',
      size: 1,
      status: 'active',
      createdAt: '2026-12-01T09:00:00.000Z',
    } as WasteRequestDto['tickets'][number],
  ],
  version: 4,
});

function completion(over: Partial<WasteRequestCompletionDto>): WasteRequestCompletionDto {
  return {
    unit: 'volume_m3',
    volumeM3: 30,
    weightTons: null,
    pricePerM3: null,
    totalCost: 0,
    removedOn: '2026-12-01',
    completedBy: 'user-1',
    completedByName: 'Диспетчеров Д. П.',
    completedAt: '2026-12-02T10:00:00.000Z',
    ...over,
  } as WasteRequestCompletionDto;
}

function setup(rows: WasteRequestDto[], over: RouteMap = {}) {
  const http = mockHttp({
    'GET /waste-requests': () => json(list(rows)),
    'GET /waste-requests/summary': () => json(wasteSummary({ confirmed: rows.length })),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([])),
    'GET /counterparties': () => json(list([])),
    'GET /waste-tariffs/resolve': () => json({ tariff: null }),
    'PATCH /waste-requests/:id/status': ({ params }) =>
      json(wasteRequest({ ...SNOW, id: params.id, status: 'done', version: 5 })),
    'DELETE /files/:id': () => json({ ok: true }),
    ...over,
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

async function openCompletion(displayNumber: string) {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('[aria-label="Изменить статус"]')!);
  const item = await waitFor(() => {
    // Menus of other rows stay in the DOM, hidden or still leaving (jsdom runs no animations):
    // the item is taken from the menu that is opening.
    const found = [
      ...document.querySelectorAll(
        '.ant-dropdown:not(.ant-dropdown-hidden):not([class*="-leave"])',
      ),
    ]
      .flatMap((menu) => [...menu.querySelectorAll('.ant-dropdown-menu-item')])
      .find((el) => el.textContent === 'Выполнена');
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
  await screen.findAllByText('Выполнение заявки');
  await screen.findByText(new RegExp(`Заявка № ${displayNumber}`));
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function cancelWindow() {
  const cancel = [...document.querySelectorAll('.ant-modal-footer button')]
    .filter((b) => b.textContent === 'Отмена')
    .at(-1);
  fireEvent.click(cancel!);
}

function submitWindow() {
  const ok = [...document.querySelectorAll('.ant-modal-footer button')]
    .filter((b) => b.textContent === 'Выполнена')
    .at(-1);
  fireEvent.click(ok!);
}

function setDate(label: string, value: string) {
  const input = field(label);
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
}

function statusBody(http: ReturnType<typeof setup>) {
  return http.lastCall('PATCH /waste-requests/:id/status')!.body as {
    completion: Record<string, unknown>;
    version: number;
    ticketFileIds: string[];
  };
}

/** Picks a file in the window's ticket upload, the way the browser hands it to antd Upload. */
function pickTicket(name: string) {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('.ant-modal input[type=file]')];
  fireEvent.change(inputs.at(-1)!, {
    target: { files: [new File(['scan'], name, { type: 'image/jpeg' })] },
  });
}

function uploadRoutes(complete: () => MockResponse | Promise<MockResponse>): RouteMap {
  return {
    'POST /files/upload-session': () =>
      json({
        fileId: 'f-late',
        uploadUrl: 'https://storage.test/put/f-late',
        objectKey: 'tickets/f-late.jpg',
        expiresIn: 900,
      }),
    'POST /files/:id/complete': complete,
  };
}

describe('закрытие заявки на вывоз снега', () => {
  it('без прайса: пустая стоимость, без пересчёта, очищенная сумма уходит null', async () => {
    const http = setup([SNOW]);
    await openCompletion('М-201');

    // The planned volume is offered for confirmation; the cost starts blank, not as an estimate.
    expect(field('Вывезено, м³').value).toBe('16');
    expect(field('Стоимость, ₽').value).toBe('');
    expect(screen.getByText(/Необязательно: без счёта оставьте пустым/)).toBeDefined();
    expect(screen.queryByText(/по прайсу/)).toBeNull();
    fireEvent.change(field('Вывезено, м³'), { target: { value: '18' } });
    expect(field('Стоимость, ₽').value).toBe('');
    expect(http.countOf('GET /waste-tariffs/resolve')).toBe(0);

    submitWindow();
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));
    expect(statusBody(http).completion).toEqual({
      volumeM3: 18,
      totalCost: null,
      removedOn: null,
    });
  });

  it('явный ноль — известная сумма: уходит 0, а не null', async () => {
    const http = setup([SNOW]);
    await openCompletion('М-201');
    fireEvent.change(field('Стоимость, ₽'), { target: { value: '0' } });
    submitWindow();
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));
    expect(statusBody(http).completion.totalCost).toBe(0);
  });

  it('повторное закрытие открывается сохранённым фактом: объём, ноль и дата вывоза', async () => {
    const reclose = { ...SNOW, completion: completion({ volumeM3: 30, totalCost: 0 }) };
    const http = setup([reclose]);
    await openCompletion('М-201');
    expect(field('Вывезено, м³').value).toBe('30');
    expect(field('Стоимость, ₽').value).toBe('0.00');
    expect(field('Дата вывоза').value).toBe('01.12.2026');

    submitWindow();
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));
    expect(statusBody(http).completion).toEqual({
      volumeM3: 30,
      totalCost: 0,
      removedOn: '2026-12-01',
    });
  });

  it('новое открытие начинается чистым: ни объём, ни сумма, ни дата не переносятся', async () => {
    const other = { ...SNOW, id: 'wr-s2', num: 202, displayNumber: 'М-202', volumeM3: 9 };
    setup([SNOW, other]);
    await openCompletion('М-201');
    fireEvent.change(field('Вывезено, м³'), { target: { value: '40' } });
    fireEvent.change(field('Стоимость, ₽'), { target: { value: '15000' } });
    setDate('Дата вывоза', '02.12.2026');
    cancelWindow();

    await openCompletion('М-202');
    expect(field('Вывезено, м³').value).toBe('9');
    expect(field('Стоимость, ₽').value).toBe('');
    expect(field('Дата вывоза').value).toBe('');
    cancelWindow();

    // The same request reopened is a new opening too.
    await openCompletion('М-201');
    expect(field('Вывезено, м³').value).toBe('16');
    expect(field('Стоимость, ₽').value).toBe('');
    expect(field('Дата вывоза').value).toBe('');
  });

  it('409: перечитывает сохранённый факт и талоны, повтор уже закрытой заявки запрещён', async () => {
    const closedMeanwhile = {
      ...SNOW,
      status: 'done' as const,
      version: 6,
      completion: completion({ volumeM3: 22, totalCost: 7000, removedOn: '2026-12-03' }),
    };
    const http = setup([SNOW], {
      'PATCH /waste-requests/:id/status': () =>
        apiError(409, { code: 'conflict', message: 'Заявка уже выполнена' }),
      'GET /waste-requests/:id': () => json(closedMeanwhile),
    });
    await openCompletion('М-201');
    submitWindow();

    await waitFor(() => expect(http.countOf('GET /waste-requests/:id')).toBe(1));
    expect(await screen.findByText('Заявку уже закрыли — повторно её не выполнить')).toBeDefined();
    expect(
      screen.getByText(/Сейчас сохранено: вывезено 22 м³ · 7 000,00 ₽ · дата вывоза 03\.12\.2026/),
    ).toBeDefined();
    const ok = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')]
      .filter((b) => b.textContent === 'Выполнена')
      .at(-1)!;
    expect(ok.disabled).toBe(true);
  });

  it('409 с прежним статусом: повтор уходит с версией перечитанной заявки', async () => {
    let refuse = true;
    const http = setup([SNOW], {
      'PATCH /waste-requests/:id/status': () =>
        refuse
          ? apiError(409, { code: 'conflict', message: 'Заявка изменилась' })
          : json(wasteRequest({ ...SNOW, status: 'done', version: 9 })),
      'GET /waste-requests/:id': () => json({ ...SNOW, version: 8 }),
    });
    await openCompletion('М-201');
    fireEvent.change(field('Стоимость, ₽'), { target: { value: '5000' } });
    submitWindow();
    expect(await screen.findByText('Заявку изменили, пока окно было открыто')).toBeDefined();
    // The typed amount survives the reload: the person retries, not retypes.
    expect(field('Стоимость, ₽').value).toBe('5000.00');

    refuse = false;
    submitWindow();
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(2));
    expect(statusBody(http).version).toBe(8);
  });

  it('загрузка, закончившаяся после закрытия, не попадает в новое окно той же заявки', async () => {
    let finish!: (response: MockResponse) => void;
    const http = setup(
      [SNOW],
      uploadRoutes(
        () =>
          new Promise<MockResponse>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await openCompletion('М-201');
    pickTicket('late.jpg');
    await waitFor(() => expect(http.countOf('POST /files/:id/complete')).toBe(1));
    cancelWindow();
    await openCompletion('М-201');

    finish(
      json({
        id: 'f-late',
        filename: 'late.jpg',
        contentType: 'image/jpeg',
        size: 4,
        status: 'active',
        createdAt: '2026-12-02T10:00:00.000Z',
      }),
    );
    // The orphaned upload is deleted, and the reopened window does not list it as its ticket.
    await waitFor(() => expect(http.countOf('DELETE /files/:id')).toBe(1));
    expect(http.lastCall('DELETE /files/:id')!.path).toBe('/files/f-late');
    expect(screen.queryByText('late.jpg')).toBeNull();
  });

  it('закрытие окна во время отправки не удаляет отправленный талон', async () => {
    let answer!: (response: MockResponse) => void;
    const http = setup([{ ...SNOW, tickets: [] }], {
      ...uploadRoutes(() =>
        json({
          id: 'f-late',
          filename: 'late.jpg',
          contentType: 'image/jpeg',
          size: 4,
          status: 'active',
          createdAt: '2026-12-02T10:00:00.000Z',
        }),
      ),
      'PATCH /waste-requests/:id/status': () =>
        new Promise<MockResponse>((resolve) => {
          answer = resolve;
        }),
    });
    await openCompletion('М-201');
    pickTicket('late.jpg');
    expect(await screen.findByText('late.jpg')).toBeDefined();
    submitWindow();
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));
    expect(statusBody(http).ticketFileIds).toEqual(['f-late']);
    cancelWindow();
    expect(http.countOf('DELETE /files/:id')).toBe(0);

    // A lost answer may hide a committed completion: the file still stays.
    answer(apiError(502, { code: 'error', message: 'Bad gateway' }));
    await waitFor(() => expect(screen.getAllByText('Bad gateway').length).toBeGreaterThan(0));
    expect(http.countOf('DELETE /files/:id')).toBe(0);
  });
});
