import { describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { wasteRequestKeys } from '@entities/waste-request';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import {
  minRequestDateKey,
  permissionsFor,
  SNOW_TYPE_CHANGE_MESSAGE,
  type AuthUser,
  type WasteRequestDto,
} from '@technic/contracts';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { WasteRequestsPage } from '../src/pages/waste';

/**
 * The snow request in the waste editor (snow-removal plan, §1, §3.3).
 *
 * Snow orders a volume like garbage but the waste type is the server's and there is no price list:
 * the form asks the volume, never the waste type, never queries a tariff, and says the cost comes
 * at completion. The type itself is offered only after the API confirmed snow, and a filed request
 * keeps its type corridor (S12).
 */

const DELIVERY_DAY = dayjs(minRequestDateKey()).add(3, 'day').format('YYYY-MM-DD');
const SNOW_OK = { capabilities: ['snow-removal-v1'] };

function setup(over: RouteMap = {}, user?: AuthUser, rows: WasteRequestDto[] = []) {
  const http = mockHttp({
    'GET /waste-requests/capabilities': () => json(SNOW_OK),
    'GET /waste-requests': () => json(list(rows)),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () =>
      json(
        list([
          objectDto(),
          objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный', operators: [] }),
          objectDto({
            id: 'obj-3',
            code: 'ОБ-3',
            name: 'ЖК Западный',
            // The only link is an operator other than the creator's: the site is configured.
            operators: [{ id: 'cp-9', name: 'ООО «Другой»' }],
          }),
        ]),
      ),
    'GET /container-types': () =>
      json(list([{ id: 'ct-1', name: 'Контейнер 8 м³', type: 'cont', isActive: true }])),
    'GET /waste-types': () =>
      json(list([wasteType(), wasteType({ id: 'wt-2', name: 'Грунт', sortOrder: 2 })])),
    'GET /counterparties': () => json(list([operator()])),
    'GET /waste-tariffs/resolve': () => json({ tariff: null }),
    'POST /waste-requests/_create-with-receipt': ({ body }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
    'PATCH /waste-requests/:id': ({ body, params }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: params.id })),
    ...over,
  });
  client = renderWithUser(<WasteRequestsPage />, user ? { user } : {}).queryClient;
  return http;
}

/** The query client of the last render: a scenario uses it to recheck snow support mid-form. */
let client: QueryClient;

/** Opens the field's own dropdown once; a repeated mouse-down would close it again. */
async function openDropdown(fieldId: string): Promise<() => HTMLElement[]> {
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(`#${fieldId}`);
    expect(el?.disabled).toBe(false);
    return el!;
  });
  const field = input.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  return () => {
    const dropdown = document.querySelector(`#${fieldId}_list`)?.closest('.ant-select-dropdown');
    return [...(dropdown?.querySelectorAll<HTMLElement>('.ant-select-item-option') ?? [])];
  };
}

async function optionLabels(fieldId: string): Promise<(string | null)[]> {
  const options = await openDropdown(fieldId);
  return waitFor(() => {
    const found = options();
    expect(found.length).toBeGreaterThan(0);
    return found.map((o) => o.textContent);
  });
}

/**
 * Picks an option and waits until the field shows it. The type list changes when the capability
 * answer arrives (snow joins it), and an option element found just before that re-render is
 * detached: the click would land nowhere, so the pick is repeated until the field holds the value.
 */
async function pickOption(fieldId: string, text: string) {
  const selected = () =>
    document
      .querySelector(`#${fieldId}`)
      ?.closest('.ant-select')
      ?.querySelector('.ant-select-content')
      ?.getAttribute('title')
      ?.includes(text);
  for (let attempt = 0; attempt < 3 && !selected(); attempt += 1) {
    const options = await openDropdown(fieldId);
    const option = await waitFor(() => {
      const found = options().find((o) => o.textContent?.includes(text));
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(option);
    await waitFor(() => expect(selected()).toBe(true)).catch(() => undefined);
  }
  expect(selected()).toBe(true);
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function openCreate(http: ReturnType<typeof setup>) {
  await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
  fireEvent.click(screen.getByText('Создать заявку'));
  expect(await screen.findByText('Новая заявка')).toBeDefined();
}

function fillSchedule() {
  const date = screen.getByLabelText('Дата доставки');
  fireEvent.change(date, { target: { value: dayjs(DELIVERY_DAY).format('DD.MM.YYYY') } });
  fireEvent.keyDown(date, { key: 'Enter', keyCode: 13 });
  fill('Ответственный на площадке', 'Петров Пётр');
  fill('Контактный телефон', '+7 926 123-45-67');
}

function createBody(http: ReturnType<typeof setup>): Record<string, unknown> {
  return http.lastCall('POST /waste-requests/_create-with-receipt')!.body as Record<
    string,
    unknown
  >;
}

describe('вывоз снега в форме заявки', () => {
  it('тип стоит сразу после вывоза мусора, когда сервер подтвердил снег', async () => {
    const http = setup();
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    const labels = await optionLabels('requestType');
    const garbage = labels.indexOf('Вывоз мусора (разовый объём)');
    expect(garbage).toBeGreaterThanOrEqual(0);
    expect(labels[garbage + 1]).toBe('Вывоз снега');
    // The check is asked again on every opening of the editor, not trusted from the last one.
    expect(http.countOf('GET /waste-requests/capabilities')).toBeGreaterThanOrEqual(1);
  });

  it('без подтверждения сервера снег не предлагается', async () => {
    // An API from before snow routes the path into the request card and refuses it.
    const http = setup({
      'GET /waste-requests/capabilities': () =>
        apiError(400, { code: 'validation_error', message: 'Некорректный идентификатор' }),
    });
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    const labels = await optionLabels('requestType');
    expect(labels).toContain('Вывоз мусора (разовый объём)');
    expect(labels).not.toContain('Вывоз снега');
  });

  it('спрашивает объём от 8 м³, без типа мусора и прайса, со словами о стоимости', async () => {
    const http = setup();
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз снега');

    expect(await screen.findByText('Стоимость вносится при закрытии заявки')).toBeDefined();
    expect(document.querySelector('#wasteTypeId')).toBeNull();
    // Below the minimum the field holds no volume, and the form refuses before any request.
    fill('Объём, м³', '7');
    fillSchedule();
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() =>
      expect(document.querySelector('#volumeM3')?.closest('.ant-form-item-has-error')).toBeTruthy(),
    );
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(0);

    fill('Объём, м³', '8');
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    const body = createBody(http);
    expect(body).toMatchObject({ objectId: 'obj-2', requestType: 'snow_removal', volumeM3: 8 });
    // The server sets the service type «Снег»; the portal never names one.
    expect(body).not.toHaveProperty('wasteTypeId');
    expect(body).not.toHaveProperty('containerTypeId');
    expect(body).not.toHaveProperty('operatorCounterpartyId');
    // No price list for snow: the tariff preview is never asked.
    expect(http.countOf('GET /waste-tariffs/resolve')).toBe(0);
  });

  it('смена типа отбрасывает поля прежнего: ни тип мусора, ни контейнер не уезжают со снегом', async () => {
    const http = setup();
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз мусора (разовый объём)');
    await pickOption('wasteTypeId', 'Грунт');
    fill('Объём, м³', '20');
    await pickOption('requestType', 'Установка');
    await pickOption('containerTypeId', 'Контейнер 8 м³');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '12');
    fillSchedule();
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    const body = createBody(http);
    expect(body).toMatchObject({ requestType: 'snow_removal', volumeM3: 12 });
    expect(body).not.toHaveProperty('wasteTypeId');
    expect(body).not.toHaveProperty('containerTypeId');
  });

  it('черновик хранит видимые поля снега и восстанавливается тем же видом', async () => {
    const http = setup();
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз мусора (разовый объём)');
    await pickOption('wasteTypeId', 'Грунт');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '15');
    fireEvent.click(screen.getByText('Отмена'));

    const stored = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .find((value) => value.includes('snow_removal'));
    expect(stored).toBeDefined();
    const payload = (JSON.parse(stored!) as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ requestType: 'snow_removal', volumeM3: 15 });
    expect(payload).not.toHaveProperty('wasteTypeId');

    fireEvent.click(screen.getByText('Создать заявку'));
    fireEvent.click(await screen.findByText('Восстановить'));
    await waitFor(() =>
      expect((screen.getByLabelText('Объём, м³') as HTMLInputElement).value).toBe('15'),
    );
    expect(document.querySelector('#wasteTypeId')).toBeNull();
    expect(screen.getByText('Стоимость вносится при закрытии заявки')).toBeDefined();
  });

  it('новую попытку снега без подтверждения не замораживает и не отправляет', async () => {
    let supported = true;
    const http = setup({
      'GET /waste-requests/capabilities': () =>
        supported ? json(SNOW_OK) : apiError(503, { code: 'error', message: 'Недоступно' }),
    });
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '10');
    fillSchedule();
    fireEvent.click(screen.getByText('Отмена'));

    // The server stops confirming snow; the restored snow draft must not freeze a new attempt.
    supported = false;
    fireEvent.click(screen.getByText('Создать заявку'));
    fireEvent.click(await screen.findByText('Восстановить'));
    await waitFor(() => expect(http.countOf('GET /waste-requests/capabilities')).toBe(2));
    fillSchedule();
    fireEvent.click(screen.getByText('Сохранить'));
    expect(await screen.findByText(/Вывоз снега пока недоступен/)).toBeDefined();
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(0);
    const frozen = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .some((value) => value.includes('createAttempt'));
    expect(frozen).toBe(false);
  });
});

describe('замороженная попытка снега переживает потерю подтверждения', () => {
  it('повтор уходит тем же телом и ключом, хотя новый снег уже не предлагается', async () => {
    let supported = true;
    let fail = true;
    const http = setup({
      'GET /waste-requests/capabilities': () =>
        supported ? json(SNOW_OK) : apiError(503, { code: 'error', message: 'Недоступно' }),
      'POST /waste-requests/_create-with-receipt': ({ body }) =>
        fail
          ? apiError(502, { code: 'error', message: 'Bad gateway' })
          : json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
    });
    await openCreate(http);
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '11');
    fillSchedule();
    fireEvent.click(screen.getByText('Сохранить'));
    // The first send froze the attempt; its answer is lost.
    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    expect((await screen.findAllByText('Bad gateway')).length).toBeGreaterThan(0);

    // Support is rechecked while the form stays open and is no longer confirmed.
    supported = false;
    fail = false;
    const checks = http.countOf('GET /waste-requests/capabilities');
    await client.invalidateQueries({ queryKey: wasteRequestKeys.capabilities() });
    await waitFor(() => expect(http.countOf('GET /waste-requests/capabilities')).toBe(checks + 1));
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(2));
    const sends = http.calls.filter((c) => c.path === '/waste-requests/_create-with-receipt');
    expect(sends[1]!.body).toEqual(sends[0]!.body);
    expect(sends[1]!.body).toMatchObject({ requestType: 'snow_removal', volumeM3: 11 });
  });
});

describe('правка поданной заявки и тип снега', () => {
  const snowRow = wasteRequest({
    id: 'wr-snow',
    requestType: 'snow_removal',
    wasteTypeId: '29cd9e92-0d72-4666-8ff1-76e0d6aad553',
    wasteTypeName: 'Снег',
    volumeM3: 16,
    pricePerM3: null,
    amount: null,
    version: 3,
  });

  async function openEdit() {
    const icon = await waitFor(() => {
      const found = document.querySelector('tbody .anticon-edit');
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(icon.closest('button')!);
    expect(await screen.findByText('Редактирование заявки')).toBeDefined();
  }

  it('снег остаётся снегом: другой тип не предлагается, объём уходит без типа мусора', async () => {
    const http = setup({}, undefined, [snowRow]);
    await openEdit();
    const labels = await optionLabels('requestType');
    expect(labels).toEqual(['Вывоз снега']);
    expect(screen.getByText(SNOW_TYPE_CHANGE_MESSAGE)).toBeDefined();
    fireEvent.keyDown(document.querySelector('#requestType')!, { key: 'Escape' });

    fill('Объём, м³', '24');
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id')).toBe(1));
    const body = http.lastCall('PATCH /waste-requests/:id')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ requestType: 'snow_removal', volumeM3: 24, version: 3 });
    expect(body).not.toHaveProperty('wasteTypeId');
  });

  it('другому типу снег не предлагается', async () => {
    setup({}, undefined, [wasteRequest({ id: 'wr-g' })]);
    await openEdit();
    const labels = await optionLabels('requestType');
    expect(labels).toContain('Вывоз мусора (разовый объём)');
    expect(labels).toContain('Установка нового контейнера');
    expect(labels).not.toContain('Вывоз снега');
  });
});

describe('заявитель от организации-оператора', () => {
  const own = authUser({
    id: 'user-op',
    role: 'operator',
    counterpartyType: 'operator',
    counterpartyId: 'cp-1',
    permissions: [
      ...permissionsFor({ role: 'operator', counterpartyType: 'operator', addons: [] }),
      'wasteRequests.create',
      'wasteRequests.assignOperator',
    ],
  });

  it('заводит заявку только на свою организацию и только на обслуживаемый объект', async () => {
    const http = setup({}, own);
    await openCreate(http);
    await pickOption('objectId', 'ЖК Западный');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '10');
    fillSchedule();
    fireEvent.click(screen.getByText('Сохранить'));
    expect(
      await screen.findByText(
        'Ваша организация не обслуживает этот объект — заявку на него завести нельзя',
      ),
    ).toBeDefined();
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(0);

    // A site without any operator link accepts any operator, the creator's own included.
    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз снега');
    fill('Объём, м³', '10');
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    expect(createBody(http)).toMatchObject({ operatorCounterpartyId: 'cp-1', objectId: 'obj-2' });
  });

  it('без права назначать оператора кнопки заведения нет', async () => {
    const http = setup(
      {},
      {
        ...own,
        permissions: own.permissions.filter((p) => p !== 'wasteRequests.assignOperator'),
      },
    );
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    expect(screen.queryByText('Создать заявку')).toBeNull();
  });
});
