import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import type {
  AuthUser,
  ServiceChatMessageDto,
  ServiceChatPageDto,
  ServiceRequestDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { openSelectOptions } from './antd';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceRequestsPage } from '../src/pages/service/ServiceRequestsPage';
import { AppLayout } from '../src/components/AppLayout';

/**
 * Обсуждение заявки на обслуживание (ADR 0141): лента реплик, адресат-пометка и непрочитанное.
 *
 * Проверяется то, что расходится молча. Главное здесь — **курсор прочтения**: он двигается только
 * после успешного показа ленты и только у видимой вкладки, и обе оговорки не украшение. Отметка,
 * поставленная на открытии, гасит разговор, которого человек не увидел (загрузка упала), а окно,
 * открытое в соседней вкладке, гасило бы метку у того, кто на него не смотрит. Ни то, ни другое не
 * заметно на экране: подсветка просто перестаёт зажигаться, и жалоба приходит через неделю.
 *
 * Второе — два бейджа раздела. Они отвечают на разные вопросы («где меня ждут» и «где мне
 * написали»), и сумма не отвечает ни на один: сложенные, они вели бы в очередь, отобранную не тем
 * фильтром.
 */

const MESSAGES = 'GET /service-requests/:id/messages';
const SEND = 'POST /service-requests/:id/messages';
const READ = 'POST /service-requests/:id/messages/read';
const READ_ALL = 'POST /service-requests/messages/read-all';
const UNREAD = 'GET /service-requests/unread-count';
const WAITING = 'GET /service-requests/waiting-count';

/** Оператор оргтехники: «Ведение» — сторона, которая и пишет, и получает адресованное себе. */
const OPERATOR: AuthUser = serviceOperator();

/** Блок `chat` считает сервер (§3.2): портал правил сторон не воспроизводит, а рисует ответ. */
function chatSummary(
  over: Partial<ServiceRequestDto['chat']> = {},
): ServiceRequestDto['chat'] {
  return {
    canWrite: true,
    participantSides: ['operator'],
    total: 1,
    unreadMine: 0,
    unreadOthers: false,
    lastSeq: 1,
    readThroughSeq: 1,
    ...over,
  };
}

function chatMessage(over: Partial<ServiceChatMessageDto> = {}): ServiceChatMessageDto {
  return {
    id: 'm-1',
    seq: 1,
    authorId: 'u-9',
    authorName: 'Сервисов С. С.',
    origin: 'chat',
    body: 'ждём запчасть от поставщика',
    createdAt: '2026-08-27T10:00:00.000Z',
    addressees: { sides: ['all'], users: [] },
    ...over,
  };
}

function chatPage(
  items: ServiceChatMessageDto[],
  over: Partial<ServiceChatPageDto> = {},
): ServiceChatPageDto {
  return {
    items,
    hasMore: false,
    lastSeq: items.at(-1)?.seq ?? 0,
    readThroughSeq: 0,
    ...over,
  };
}

function renderTab(
  items: ServiceRequestDto[],
  over: RouteMap = {},
  user: AuthUser = OPERATOR,
): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Открыть обсуждение так, как его открывает человек: из меню строки списка. */
async function openChatFromRow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  fireEvent.click(await screen.findByText('Обсуждение'));
}

/** Окно обсуждения: заголовок один на весь файл, и по нему же ищется его содержимое. */
function chatWindow() {
  const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((el) => el.style.display !== 'none')
    .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Обсуждение СО-14');
  if (!wrap) throw new Error('окна обсуждения на экране нет');
  return within(wrap);
}

describe('лента обсуждения', () => {
  it('показывает реплики и подтверждает прочтение — после показа, а не при открытии', async () => {
    const http = renderTab([serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 1, lastSeq: 2 }) })], {
      [MESSAGES]: () => json(chatPage([chatMessage(), chatMessage({ id: 'm-2', seq: 2, body: 'мастер выедет 3-го' })])),
      [READ]: () => json({ readThroughSeq: 2, lastSeq: 2 }),
    });
    await screen.findByText('СО-14');

    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');
    expect(chatWindow().getByText('мастер выедет 3-го')).toBeDefined();

    // Курсор — номер последней реплики ленты, а не время открытия окна: реплика, закоммиченная
    // позже отметки, получила бы больший номер и потеряться не может.
    await waitFor(() => expect(http.countOf(READ)).toBe(1));
    expect(http.lastCall(READ)!.body).toEqual({ throughSeq: 2 });
  });

  it('полоса «Новые» стоит на границе прочитанного и не съезжает от подтверждения', async () => {
    renderTab([serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 2, lastSeq: 3 }) })], {
      [MESSAGES]: () =>
        json(
          chatPage(
            [
              chatMessage(),
              chatMessage({ id: 'm-2', seq: 2, body: 'мастер выедет 3-го' }),
              chatMessage({ id: 'm-3', seq: 3, body: 'аппарат увезли' }),
            ],
            // Дочитано до первой: две следующие и есть «новые».
            { readThroughSeq: 1 },
          ),
        ),
      [READ]: () => json({ readThroughSeq: 3, lastSeq: 3 }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    const read = chatWindow().getByText('ждём запчасть от поставщика');
    const boundary = await chatWindow().findByText('Новые');
    const fresh = chatWindow().getByText('мастер выедет 3-го');
    // Граница снята при ОТКРЫТИИ окна и заморожена: курсор сдвигается сразу после показа, и живое
    // значение утащило бы полосу вниз на глазах у читателя — то есть спрятало бы ровно то, ради
    // чего окно и открыли.
    expect(read.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(boundary.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('подгружается вверх курсором `beforeSeq`, а не номером страницы', async () => {
    const http = renderTab([serviceRequest({ status: 'in_work' })], {
      [MESSAGES]: ({ query }) =>
        query.get('beforeSeq') === '5'
          ? json(chatPage([chatMessage({ id: 'm-4', seq: 4, body: 'заявку приняли в работу' })], { lastSeq: 5 }))
          : json(chatPage([chatMessage({ id: 'm-5', seq: 5 })], { hasMore: true, lastSeq: 5 })),
      [READ]: () => json({ readThroughSeq: 5, lastSeq: 5 }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    fireEvent.click(chatWindow().getByRole('button', { name: 'Показать более ранние' }));
    await screen.findByText('заявку приняли в работу');
    // Смещения у ленты нет и быть не может: она только растёт, и номер страницы съезжал бы на
    // каждую пришедшую реплику.
    expect(http.calls.some((call) => call.query.get('beforeSeq') === '5')).toBe(true);
  });

  it('реплика адаптера подписана автором и точным временем — пометка не отнимает имени', async () => {
    renderTab([serviceRequest({ status: 'in_work' })], {
      [MESSAGES]: () =>
        json(
          chatPage([
            chatMessage({
              // Адаптер `PATCH /:id/service-comment` (§3.10): текст пришёл из поля примечания, но
              // писал его живой человек — сервер пишет и `author_id` принципала, и `now()`.
              origin: 'import',
              authorId: 'u-9',
              authorName: 'Сисадминов И. П.',
              body: 'через старое поле примечания',
            }),
          ]),
        ),
      [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('через старое поле примечания');

    // Пометка о происхождении верна и здесь — текст правда из примечания...
    expect(chatWindow().getByText('перенесено из примечания исполнителя')).toBeDefined();
    // ...но имя и точное время известны, и стирать их нельзя: история той же заявки автора
    // показывает, и два экрана портала разошлись бы об одном событии.
    expect(chatWindow().getByText('Сисадминов И. П.')).toBeDefined();
    expect(chatWindow().queryByText(/дата приблизительная/)).toBeNull();
  });

  it('перенесённая реплика подписана пометкой и БЕЗ имени', async () => {
    renderTab([serviceRequest({ status: 'in_work' })], {
      [MESSAGES]: () =>
        json(
          chatPage([
            chatMessage({
              origin: 'import',
              authorId: null,
              // Имя сервер шлёт пустым: восстанавливать автора переноса нечем (§3.9).
              authorName: '',
              body: 'ждём поставку',
            }),
          ]),
        ),
      [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
    });
    await screen.findByText('СО-14');

    await openChatFromRow();
    // Приблизительная дата под пометкой честнее точной даты под чужим именем: «кем изменено» —
    // общее поле заявки, и через месяц там стоит тот, кто последним двигал статус.
    expect(await screen.findByText('перенесено из примечания исполнителя')).toBeDefined();
    expect(chatWindow().getByText(/дата приблизительная/)).toBeDefined();
  });
});

/**
 * Куда встаёт лента (§3.7): к полосе «Новые» при открытии, вниз после своей отправки и никуда —
 * при подгрузке вверх.
 *
 * **Что здесь проверяемо, а что нет.** jsdom раскладки не считает: `scrollHeight` и `offsetTop`
 * в нём всегда нули, а запись в `scrollTop` молча теряется. Поэтому геометрия подменена простой
 * моделью — реплика ростом в `ROW`, окно высотой `VIEW` — и проверяется ровно то, что в такой
 * модели честно: КУДА лента просит себя увести, получив эти высоты. Настоящие высоты (46vh,
 * переносы строк, шрифты) считает браузер; здесь их нет, и они проверены глазами на живом
 * контуре, а не этим файлом.
 */
describe('куда встаёт лента', () => {
  /** Высота реплики и высота видимой части — в условных пикселях подменённой раскладки. */
  const ROW = 100;
  const VIEW = 250;
  /** Столько прочитанного лента оставляет над полосой «Новые» (`CONTEXT_ABOVE_BOUNDARY`). */
  const CONTEXT = 24;

  const patched: [object, string, PropertyDescriptor | null][] = [];
  function patch(target: object, prop: string, descriptor: PropertyDescriptor) {
    patched.push([target, prop, Object.getOwnPropertyDescriptor(target, prop) ?? null]);
    Object.defineProperty(target, prop, { configurable: true, ...descriptor });
  }

  /** Тела реплик внутри ленты: по ним и считается модельная высота. */
  const bodies = (box: Element) => [...box.querySelectorAll('div[style*="pre-wrap"]')];
  const isFeed = (el: Element) => el.classList.contains('service-chat-feed');

  beforeEach(() => {
    patch(Element.prototype, 'scrollTop', {
      get(this: Element & { приведеноК?: number }) {
        return this.приведеноК ?? 0;
      },
      set(this: Element & { приведеноК?: number }, value: number) {
        this.приведеноК = value;
      },
    });
    patch(Element.prototype, 'scrollHeight', {
      get(this: Element) {
        return isFeed(this) ? bodies(this).length * ROW : 0;
      },
    });
    patch(Element.prototype, 'clientHeight', {
      get(this: Element) {
        return isFeed(this) ? VIEW : 0;
      },
    });
    patch(HTMLElement.prototype, 'offsetTop', {
      get(this: HTMLElement) {
        const box = this.closest('.service-chat-feed');
        if (!box) return 0;
        // Сколько реплик началось ВЫШЕ этого узла — столько «строк» до него и накопилось.
        return (
          bodies(box).filter(
            (body) => this.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_PRECEDING,
          ).length * ROW
        );
      },
    });
  });

  afterEach(() => {
    for (const [target, prop, descriptor] of patched.splice(0).reverse()) {
      if (descriptor) Object.defineProperty(target, prop, descriptor);
      else delete (target as Record<string, unknown>)[prop];
    }
  });

  function feed(): HTMLElement {
    const box = document.querySelector<HTMLElement>('.service-chat-feed');
    if (!box) throw new Error('ленты на экране нет');
    return box;
  }

  const thread = (count: number, from = 1) =>
    Array.from({ length: count }, (_, i) =>
      chatMessage({ id: `m-${from + i}`, seq: from + i, body: `реплика ${from + i}` }),
    );

  it('с непрочитанным — к полосе «Новые», а не на самый верх', async () => {
    renderTab(
      [serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 2, lastSeq: 5 }) })],
      {
        // Дочитано до третьей: полоса встаёт перед четвёртой.
        [MESSAGES]: () => json(chatPage(thread(5), { readThroughSeq: 3 })),
        [READ]: () => json({ readThroughSeq: 5, lastSeq: 5 }),
      },
    );
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('реплика 1');

    // Три реплики до полосы, минус оставленный над ней контекст: реплика-ответ без предыдущей —
    // половина разговора.
    expect(feed().scrollTop).toBe(3 * ROW - CONTEXT);
  });

  it('без непрочитанного — к последней реплике, в самый низ', async () => {
    renderTab([serviceRequest({ status: 'in_work', chat: chatSummary({ lastSeq: 5 }) })], {
      [MESSAGES]: () => json(chatPage(thread(5), { readThroughSeq: 5 })),
      [READ]: () => json({ readThroughSeq: 5, lastSeq: 5 }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('реплика 1');

    // Полосы «Новые» нет вовсе — и лента просится в самый низ. Браузер прижмёт `scrollTop` к
    // `scrollHeight - clientHeight`; jsdom высот не считает и оставляет запрошенное число.
    expect(chatWindow().queryByText('Новые')).toBeNull();
    expect(feed().scrollTop).toBe(5 * ROW);
  });

  it('подгрузка вверх держит место: содержимое не уезжает из-под глаз', async () => {
    renderTab([serviceRequest({ status: 'in_work', chat: chatSummary({ lastSeq: 6 }) })], {
      [MESSAGES]: ({ query }) =>
        query.get('beforeSeq') === '4'
          ? json(chatPage(thread(3), { lastSeq: 6 }))
          : json(chatPage(thread(3, 4), { hasMore: true, readThroughSeq: 6, lastSeq: 6 })),
      [READ]: () => json({ readThroughSeq: 6, lastSeq: 6 }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('реплика 4');

    // Человек ушёл к самому верху — там и стоит кнопка «Показать более ранние».
    feed().scrollTop = 0;
    fireEvent.click(chatWindow().getByRole('button', { name: 'Показать более ранние' }));
    await screen.findByText('реплика 1');

    // Сверху встали три реплики — ровно на их высоту и сдвинулось смещение: то, что человек
    // читал, осталось на месте. Начальная проводка при этом НЕ повторилась: она увела бы ленту
    // вниз (600) или к полосе, а не на 300.
    await waitFor(() => expect(feed().scrollTop).toBe(3 * ROW));
  });

  it('после своей отправки — вниз, к только что сказанному', async () => {
    renderTab([serviceRequest({ status: 'in_work', chat: chatSummary({ lastSeq: 3 }) })], {
      [MESSAGES]: () => json(chatPage(thread(3), { readThroughSeq: 3 })),
      [READ]: () => json({ readThroughSeq: 3, lastSeq: 3 }),
      [SEND]: () =>
        json({
          message: chatMessage({ id: 'm-4', seq: 4, body: 'мастер выедет 3-го' }),
          lastSeq: 4,
        }),
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('реплика 1');

    // Человек ушёл читать начало разговора и оттуда ответил.
    feed().scrollTop = 0;
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: 'мастер выедет 3-го' },
    });
    fireEvent.click(chatWindow().getByRole('button', { name: 'Отправить' }));
    await screen.findByText('мастер выедет 3-го');

    // Своя реплика, уехавшая за нижний край, читается как «не отправилось».
    await waitFor(() => expect(feed().scrollTop).toBe(4 * ROW));
  });
});

describe('отправка реплики', () => {
  it('уходит текст с умолчанием адресата «Всем участникам»', async () => {
    const sent = vi.fn();
    const http = renderTab([serviceRequest({ status: 'in_work', chat: chatSummary() })], {
      [MESSAGES]: () => json(chatPage([chatMessage()])),
      [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      [SEND]: ({ body }) => {
        sent(body);
        return json({
          message: chatMessage({ id: 'm-2', seq: 2, body: 'мастер выедет 3-го', authorName: 'Штабов С. И.' }),
          lastSeq: 2,
        });
      },
    });
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    // Умолчание видно на самом поле: реплика без адресата не бывает вовсе, и спрашивать «кому» у
    // каждого «ждём запчасть» значило бы требовать решения там, где его нет.
    expect(
      chatWindow().getAllByText('Всем участникам', {
        // Именно выбранное значение поля: то же слово стоит и подсказкой поля, и вариантом списка.
        selector: '.ant-select-selection-item-content',
      }),
    ).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: 'мастер выедет 3-го' },
    });
    fireEvent.click(chatWindow().getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(sent).toHaveBeenCalled());
    expect(sent.mock.calls[0]![0]).toEqual({
      body: 'мастер выедет 3-го',
      addressees: { sides: ['all'], users: [] },
    });
    // Своя реплика показывается сразу: ответ несёт её целиком, ждать следующего опроса незачем.
    expect(chatWindow().getByText('мастер выедет 3-го')).toBeDefined();
    expect(http.countOf(SEND)).toBe(1);
  });

  it('«Всем участникам» гасит остальные пункты — зеркало серверной проверки', async () => {
    renderTab(
      [
        serviceRequest({
          status: 'in_work',
          chat: chatSummary(),
          executors: [
            { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
          ],
        }),
      ],
      {
        [MESSAGES]: () => json(chatPage([chatMessage()])),
        [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      },
    );
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    // Умолчание — «Всем участникам», и уже оно гасит остальное: «всем» и «ещё вот этому» —
    // противоречие, на которое сервер отвечает 400, а портал обязан выразить его до нажатия.
    const withAll = await openSelectOptions('Кому');
    const disabled = withAll
      .filter((option) => option.classList.contains('ant-select-item-option-disabled'))
      .map((option) => option.textContent);
    expect(disabled).toContain('Заявителю');
    // «Сервисному центру» стоит в списке и у заявки БЕЗ исполнителя: реплика дождётся назначенного
    // (решение опроса), а спрятанный до назначения адресат терял бы ровно тот вопрос, который и
    // задают, пока исполнителя ищут.
    expect(withAll.map((option) => option.textContent)).toContain('Сервисному центру');
    // Поимённые кандидаты — назначенные исполнители заявки: сервер сверяет их с теми же строками.
    expect(disabled).toContain('Сисадминов С. С.');
    expect(disabled).not.toContain('Всем участникам');

    // Сняли «всем» — остальные ожили; выбрали сторону; вернули «всем» — сторона ушла сама.
    fireEvent.click(withAll.find((o) => o.textContent === 'Всем участникам')!);
    const free = await openSelectOptions('Кому');
    expect(free.every((o) => !o.classList.contains('ant-select-item-option-disabled'))).toBe(true);
    fireEvent.click(free.find((o) => o.textContent === 'Заявителю')!);
    await waitFor(() =>
      expect(
        chatWindow().getAllByText('Заявителю', {
          selector: '.ant-select-selection-item-content',
        }),
      ).toHaveLength(1),
    );

    fireEvent.click((await openSelectOptions('Кому')).find((o) => o.textContent === 'Всем участникам')!);
    await waitFor(() =>
      expect(chatWindow().queryAllByText('Заявителю', { selector: '.ant-select-selection-item-content' })).toHaveLength(0),
    );
  });
});

describe('кому обсуждение открыто только на чтение', () => {
  it('наблюдателю поля ввода нет: пишут стороны заявки и её автор', async () => {
    renderTab(
      [
        serviceRequest({
          status: 'in_work',
          chat: chatSummary({ canWrite: false, participantSides: [] }),
        }),
      ],
      {
        [MESSAGES]: () => json(chatPage([chatMessage()])),
        [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      },
      // Наблюдатель — администратор портала здесь не годится: у него есть все стороны сразу.
      authUser({ role: 'manager', constructionObjectIds: ['obj-1'] }),
    );
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    // Читать — можно: текст реплик видят все, кому видна заявка (решение 2 ADR).
    expect(chatWindow().queryByRole('button', { name: 'Отправить' })).toBeNull();
    expect(chatWindow().getByText(/Писать в обсуждении могут стороны заявки/)).toBeDefined();
  });

  it('в закрытой заявке лента замерзает — и окно объясняет это статусом', async () => {
    renderTab(
      [
        serviceRequest({
          status: 'accepted',
          // Участник он и остался: право писать отняла закрытость заявки, а не роль.
          chat: chatSummary({ canWrite: false, participantSides: ['operator'] }),
        }),
      ],
      {
        [MESSAGES]: () => json(chatPage([chatMessage()])),
        [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      },
    );
    await screen.findByText('СО-14');
    await openChatFromRow();
    await screen.findByText('ждём запчасть от поставщика');

    expect(chatWindow().queryByRole('button', { name: 'Отправить' })).toBeNull();
    expect(chatWindow().getByText(/обсуждение только читается/)).toBeDefined();
  });
});

describe('метки непрочитанного в строке списка', () => {
  it('яркая метка со счётом ведёт прямо в обсуждение', async () => {
    renderTab(
      [serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 2, lastSeq: 5 }) })],
      {
        [MESSAGES]: () => json(chatPage([chatMessage()])),
        [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      },
    );
    const mark = await screen.findByLabelText('Обсуждение: новых 2');
    expect(within(mark).getByText('2')).toBeDefined();

    fireEvent.click(mark);
    // Нажатие не всплывает: клик по строке открывает карточку, и окно ушло бы под неё — на экране
    // обсуждение, а карточки нет вовсе.
    await screen.findByText('ждём запчасть от поставщика');
    expect(chatWindow().getByRole('button', { name: 'Закрыть' })).toBeDefined();
    expect(screen.queryByText('Заявка СО-14')).toBeNull();
  });

  it('блёклая точка — участнику разговора: у него есть чем ответить', async () => {
    renderTab([
      serviceRequest({
        status: 'in_work',
        chat: chatSummary({ unreadMine: 0, unreadOthers: true, participantSides: ['operator'] }),
      }),
    ]);

    expect(await screen.findByLabelText('Обсуждение: есть новое')).toBeDefined();
    // Счёта у неё нет намеренно: «сколько там чужого» — вопрос, на который человеку нечего
    // ответить, а `unreadOthers` и приходит булевым.
    expect(screen.queryByLabelText(/Обсуждение: новых/)).toBeNull();
  });

  it('наблюдателю чужая переписка не мигает вовсе', async () => {
    renderTab(
      [
        serviceRequest({
          status: 'in_work',
          chat: chatSummary({ canWrite: false, participantSides: [], unreadOthers: true }),
        }),
      ],
      {},
      authUser({ role: 'manager', constructionObjectIds: ['obj-1'] }),
    );
    await screen.findByText('СО-14');

    // Серая точка на каждую чужую реплику была бы для него шумом без действия: отвечать он не
    // может, и звать его некуда.
    expect(screen.queryByLabelText('Обсуждение: есть новое')).toBeNull();
  });
});

describe('курсор прочтения не двигается вслепую', () => {
  it('лента не загрузилась — прочтение не подтверждается, метка не гаснет', async () => {
    const http = renderTab(
      [serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 1, lastSeq: 3 }) })],
      { [MESSAGES]: () => apiError(500, { code: 'error', message: 'Сеть недоступна' }) },
    );
    const mark = await screen.findByLabelText('Обсуждение: новых 1');
    fireEvent.click(mark);

    await screen.findByText('Обсуждение не загрузилось');
    // Человек не увидел ни строки — гасить нечего. Именно этот случай терялся у отметки времени:
    // окно ставило её при открытии, и непрочитанное исчезало вместе с неудачной загрузкой.
    expect(http.countOf(READ)).toBe(0);
    expect(screen.getByLabelText('Обсуждение: новых 1')).toBeDefined();
  });

  it('вкладка невидима — лента показана, но прочтение не подтверждается', async () => {
    const hidden = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden' as DocumentVisibilityState);
    try {
      const http = renderTab(
        [serviceRequest({ status: 'in_work', chat: chatSummary({ unreadMine: 1, lastSeq: 1 }) })],
        {
          [MESSAGES]: () => json(chatPage([chatMessage()])),
          [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
        },
      );
      await screen.findByText('СО-14');
      await openChatFromRow();
      await screen.findByText('ждём запчасть от поставщика');

      // Окно, открытое в соседней вкладке, не должно гасить метку у того, кто на него не смотрит.
      await waitFor(() => expect(http.countOf(MESSAGES)).toBe(1));
      expect(http.countOf(READ)).toBe(0);
    } finally {
      hidden.mockRestore();
    }
  });
});

describe('«Отметить все прочитанными»', () => {
  it('шлёт текущий отбор списка, а не «всё подряд»', async () => {
    const http = renderTab([serviceRequest({ status: 'in_work' })], {
      [READ_ALL]: () => json({ count: 3 }),
    });
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByRole('button', { name: /Отметить все прочитанными/ }));
    await waitFor(() => expect(http.countOf(READ_ALL)).toBe(1));

    // Тело — те же параметры, с которыми отобран список: кнопка гасит ровно то, что видно.
    expect(http.lastCall(READ_ALL)!.body).toMatchObject({
      page: 1,
      sortBy: 'statusChangedAt',
      sortOrder: 'asc',
    });
    expect(await screen.findByText('Отмечено прочитанными заявок: 3')).toBeDefined();
  });
});

describe('адрес карточки с обсуждением', () => {
  it('`?open=<id>&chat=1` открывает карточку и раскрывает в ней переписку', async () => {
    const request = serviceRequest({ status: 'in_work' });
    mockHttp({
      'GET /service-requests/warranties': () => json(emptyList()),
      [UNREAD]: () => json({ count: 0 }),
      'GET /service-requests': () => json(list([request])),
      'GET /service-requests/:id': () => json(request),
      'GET /service-requests/:id/history': () => json([]),
      [MESSAGES]: () => json(chatPage([chatMessage()])),
      [READ]: () => json({ readThroughSeq: 1, lastSeq: 1 }),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
    });
    renderWithUser(<ServiceRequestsPage />, {
      user: OPERATOR,
      // Адрес заведён не сегодняшнему порталу, а завтрашнему письму «перейти к обсуждению».
      route: '/office-equipment?tab=requests&open=sr-1&chat=1',
    });

    await screen.findByText('Заявка СО-14');
    await screen.findByText('ждём запчасть от поставщика');
    // Окно живёт ВНУТРИ карточки (ADR 0140): снаружи оно делило бы с ней слой и ушло бы под неё.
    expect(chatWindow().getByRole('button', { name: 'Закрыть' })).toBeDefined();
  });
});

describe('бейджи раздела: «ждут меня» и «мне написали» — числа разные', () => {
  function renderMenu(user: AuthUser, over: RouteMap = {}): HttpMock {
    const http = mockHttp({
      'GET /releases': () => json([]),
      [WAITING]: () => json({ count: 3 }),
      [UNREAD]: () => json({ count: 2 }),
      ...over,
    });
    renderWithUser(
      <Routes>
        <Route path="/" element={<Navigate to="/waste" replace />} />
        <Route element={<AppLayout />}>
          <Route path="/waste" element={<div>Список заявок</div>} />
          <Route path="/office-equipment" element={<div>Орг.техника</div>} />
        </Route>
      </Routes>,
      { user },
    );
    return http;
  }

  it('оба бейджа стоят рядом и не складываются', async () => {
    renderMenu(OPERATOR);

    expect(await screen.findByText('3')).toBeDefined();
    expect(await screen.findByText('2')).toBeDefined();
    // Сумма не отвечает ни на один из двух вопросов — «где меня ждут» и «где мне написали», — и
    // вела бы в очередь, отобранную не тем фильтром.
    expect(screen.queryByText('5')).toBeNull();
  });

  it('счётчик непрочитанного спрашивают только у тех, кому видны заявки', async () => {
    // У менеджера раздел открыт правом на технику (`officeEquipment.read`), а заявок нет вовсе:
    // ручка ответила бы ему отказом на каждый вход.
    const http = renderMenu(authUser({ role: 'manager' }));
    await waitFor(() => expect(http.countOf('GET /releases')).toBe(1));
    expect(http.countOf(UNREAD)).toBe(0);
  });
});
