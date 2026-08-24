import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CounterpartyDto, WasteRequestDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';

/**
 * Перевод заявки на вывоз мусора в работу.
 *
 * Проверяется не разметка окна, а поток: портал делает это двумя запросами подряд — сперва
 * назначает исполнителя (ADR 0010), затем переводит статус. Запросы связаны версией: назначение
 * меняет заявку, и второй запрос обязан уйти с версией из ответа первого. Возьми он версию из
 * строки списка — сервер ответил бы конфликтом версий, и человек увидел бы «заявка изменена
 * другим пользователем» на своё же собственное действие. По разметке такая поломка неотличима
 * от исправной работы, поэтому тест держится за журнал запросов.
 */

/** Заявка, которую переводят в работу: новая, исполнитель ещё не назначен. */
const NEW_REQUEST = wasteRequest({ id: 'wr-1', status: 'new', version: 4 });

/** Она же после назначения: исполнитель проставлен, версия выросла — этим и связаны два запроса. */
const ASSIGNED = wasteRequest({
  ...NEW_REQUEST,
  operatorCounterpartyId: 'cp-2',
  operatorName: 'ООО «Вторресурс»',
  version: 5,
});

/** И она же после перевода статуса — такой список отдаёт сервер на перезапрос. */
const CONFIRMED = wasteRequest({ ...ASSIGNED, status: 'confirmed', version: 6 });

/**
 * Операторов двое: с единственным вариантом `AutoSelect` подставил бы его сам, и тест не показал
 * бы, что в запрос уходит именно выбранный человеком исполнитель.
 */
const OPERATORS: CounterpartyDto[] = [
  operator({ id: 'cp-1', name: 'ООО «Чистый двор»' }),
  operator({ id: 'cp-2', name: 'ООО «Вторресурс»' }),
];

/**
 * Экран заявок целиком, глазами диспетчера: исполнителя назначает он, и ход заявок ведёт он же.
 * Подменяется сеть, а не модули портала, поэтому в журнале видны все запросы экрана — включая
 * перезапросы после мутации, ради которых сценарий и написан.
 */
function renderPage(over: RouteMap = {}): HttpMock {
  let current: WasteRequestDto = NEW_REQUEST;
  let summary = wasteSummary({ new: 1 });

  const http = mockHttp({
    'GET /waste-requests': () => json(list([current])),
    'GET /waste-requests/summary': () => json(summary),
    // Баннер состояния распознавания (ADR 0114, Р29) спрашивает подсистему на каждом экране
    // разбора: молчащее распознавание неотличимо от «талоны в порядке». Здесь оно исправно.
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    // Справочники и присутствие контейнеров сценарию не нужны, но экран их спрашивает: без мока
    // тест падал бы на «Нет мока для ...» вместо проверки самого перевода в работу.
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(emptyList()),
    'GET /waste-types': () => json(emptyList()),
    'GET /counterparties': () => json(list(OPERATORS)),
    'PATCH /waste-requests/:id/operator': () => {
      current = ASSIGNED;
      return json(ASSIGNED);
    },
    'PATCH /waste-requests/:id/status': () => {
      current = CONFIRMED;
      summary = wasteSummary({ confirmed: 1 });
      return json(CONFIRMED);
    },
    ...over,
  });

  renderWithUser(<WasteRequestsPage />);
  return http;
}

/**
 * Переход по статусу из строки списка: тег статуса — кнопка с выпадающим списком переходов.
 * Ищется по `aria-label`, а не ролью: `*ByRole` считает доступные имена всему дереву и на
 * таблице antd уходит в секунды — тест с ней упирается в собственный таймаут.
 */
async function chooseTransition(label: string) {
  fireEvent.click(screen.getByLabelText('Изменить статус'));
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === label,
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/**
 * Выбор исполнителя в окне назначения. Поле ищется по id, а варианты — в выпадашке именно этого
 * поля (`<id>_list`): окно живёт в портале, а закрытые выпадашки остаются в DOM, и общий поиск
 * по документу выбирал бы в чужом списке.
 */
async function pickOperator(name: string) {
  const field = document.querySelector('#operatorCounterpartyId')!.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  const option = await waitFor(() => {
    const dropdown = document
      .querySelector('#operatorCounterpartyId_list')
      ?.closest('.ant-select-dropdown');
    const found = [...(dropdown?.querySelectorAll('.ant-select-item-option') ?? [])].find((o) =>
      o.textContent?.includes(name),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(option);
}

/** Кнопка в подвале модального окна («В работу» — она же подтверждение назначения). */
function clickModalButton(label: string) {
  const button = [...document.querySelectorAll('.ant-modal button')].find(
    (el) => el.textContent === label,
  );
  expect(button, `кнопка «${label}» в окне`).toBeTruthy();
  fireEvent.click(button!);
}

/** Только изменяющие запросы: по ним читается последовательность самого перевода в работу. */
const writes = (http: HttpMock) =>
  http.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

/** Открыть окно назначения и подтвердить его выбранным исполнителем. */
async function startWork(operatorName: string) {
  await chooseTransition('В работе');
  expect(await screen.findByText('Назначение оператора вывоза мусора')).toBeDefined();
  await pickOperator(operatorName);
  clickModalButton('В работу');
}

describe('перевод заявки на вывоз в работу', () => {
  it('идёт двумя запросами: назначение исполнителя, затем статус — с версией из ответа назначения', async () => {
    const http = renderPage();
    expect(await screen.findByText('М-128')).toBeDefined();

    await startWork('ООО «Вторресурс»');
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));

    // Порядок обязателен: статус, переведённый до назначения, оставил бы заявку в работе без
    // исполнителя — в списке оператора она не появится, и выполнять её будет некому (ADR 0010).
    expect(writes(http)).toEqual([
      'PATCH /waste-requests/wr-1/operator',
      'PATCH /waste-requests/wr-1/status',
    ]);

    // Назначение уходит с версией из списка — той, что человек видел перед собой.
    expect(http.lastCall('PATCH /waste-requests/:id/operator')?.body).toEqual({
      operatorCounterpartyId: 'cp-2',
      version: 4,
    });

    // Ради этого сценарий и написан: статус переводится по версии 5 — из ответа назначения, а не
    // по версии 4 из строки списка. Назначение заявку меняет, и старая версия здесь означала бы
    // отказ сервера по конфликту версий на ровном месте.
    expect(http.lastCall('PATCH /waste-requests/:id/status')?.body).toEqual({
      status: 'confirmed',
      version: 5,
      comment: '',
      ticketFileIds: [],
    });
  });

  it('после успеха перезапрашивает список и сводку — и обновлённая строка доходит до экрана', async () => {
    const http = renderPage();
    expect(await screen.findByText('М-128')).toBeDefined();
    // Первый рендер: по одному запросу на список и на сводку — от них и считаются перезапросы.
    expect(http.countOf('GET /waste-requests')).toBe(1);
    expect(http.countOf('GET /waste-requests/summary')).toBe(1);

    await startWork('ООО «Вторресурс»');

    // Сводка спрашивается своим запросом, но общим ключом со списком: перезапроситься должны оба —
    // иначе счётчик «Не обработанных» остался бы прежним при уехавшей из него заявке.
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
    await waitFor(() => expect(http.countOf('GET /waste-requests/summary')).toBe(2));

    // Перезапрос дошёл до разметки: в строке новый статус и назначенный исполнитель. Ищем внутри
    // таблицы — подпись «В работе» стоит ещё и в сводке над списком.
    const rows = document.querySelector<HTMLElement>('.ant-table-tbody')!;
    await waitFor(() => expect(within(rows).getByText('В работе')).toBeDefined());
    expect(within(rows).getByText('ООО «Вторресурс»')).toBeDefined();
  });

  it('назначение не прошло — статус не переводится', async () => {
    // Конфликт версий на первом запросе: заявку успели поправить, пока окно было открыто.
    const http = renderPage({
      'PATCH /waste-requests/:id/operator': () =>
        apiError(409, {
          code: 'version_conflict',
          message: 'Заявка изменена другим пользователем',
        }),
    });
    expect(await screen.findByText('М-128')).toBeDefined();

    await startWork('ООО «Вторресурс»');
    expect(await screen.findByText('Заявка изменена другим пользователем')).toBeDefined();

    // Второй запрос не уходит: заявка в работе без исполнителя — это заявка, которой никто не
    // занимается. Цепочка обрывается на первом отказе.
    expect(writes(http)).toEqual(['PATCH /waste-requests/wr-1/operator']);
    expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(0);

    // Список всё равно перезапрашивается: раз версия разошлась, показанная строка устарела.
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
  });
});
