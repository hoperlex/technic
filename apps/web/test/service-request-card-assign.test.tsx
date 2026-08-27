import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceExecutor, serviceOperator, serviceRequest } from './factories/service';
import { objectDto, operator } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Назначение исполнителей из карточки заявки (ADR 0140).
 *
 * Проверяется не расположение кнопки, а её слой. Прежде окно назначения было **соседом** карточки
 * по странице: у корневых модалок antd один и тот же z-index, и спор решает порядок узлов в
 * `body`. Карточка пересоздаёт свой узел при каждом открытии (`destroyOnHidden`), поэтому после
 * «закрыл — открыл снова» она оказывалась последней и накрывала окно назначения собой: человек
 * жал пункт меню и видел, что «ничего не произошло», — ни ошибки, ни окна, ни объяснения.
 *
 * Вложенная в карточку модалка получает от antd собственный слой (`ZIndexContext` проставляет ей
 * z-index inline), и он уже не зависит ни от порядка узлов в `body`, ни от того, в который раз
 * карточку открыли. Отсюда и главный сценарий файла — переоткрытие: именно на нём ошибка и
 * воспроизводилась, а с первого открытия портал выглядел исправным.
 */

const OPERATOR: AuthUser = serviceOperator();
/** Исполнитель: перехода `assigned` в его коридоре нет — назначать он не вправе (Р17). */
const EXECUTOR: AuthUser = serviceExecutor();

/** Уже назначенная заявка: и свой сотрудник поимённо, и сервисная компания строкой (Н5). */
const assignedRequest = (overrides: Partial<ServiceRequestDto> = {}) =>
  serviceRequest({
    status: 'assigned',
    executors: [
      { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
    ],
    service: { id: 'cp-1', name: 'КопиЛайт' },
    ...overrides,
  });

function renderTab(user: AuthUser, items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Кандидаты в поимённые исполнители: окно назначения спрашивает их там, где перечень учёток
    // разрешён. Маршрут описан раньше `:id` — иначе шаблон с параметром перехватил бы и его.
    'GET /service-requests/executor-candidates': () => json({ items: [] }),
    /*
     * Карточка спрашивает заявку сама, а строкой списка лишь рисуется, пока едет свежая: без обоих
     * маршрутов окно осталось бы без данных — и тест, ничего не проверив, остался бы зелёным.
     */
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    // Сервисные компании нужны и фильтру списка, и самому окну назначения.
    'GET /counterparties': () =>
      json(list([operator({ id: 'cp-1', name: 'КопиЛайт', type: 'service' })])),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Заголовки открытых окон: закрытые antd какое-то время держит в разметке, лишь пряча их. */
function openModalTitles(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((wrap) => wrap.style.display !== 'none')
    .map((wrap) => wrap.querySelector('.ant-modal-title')?.textContent ?? '');
}

/** Обёртка открытого окна по заголовку: слой antd проставляет именно ей. */
function wrapOf(title: string): HTMLElement {
  const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((el) => el.style.display !== 'none')
    .find((el) => el.querySelector('.ant-modal-title')?.textContent === title);
  if (!wrap) throw new Error(`окна «${title}» на экране нет`);
  return wrap;
}

/**
 * Слой окна числом.
 *
 * Пустое inline-значение — не «слой не задан», а базовый слой темы: корневой модалке antd ничего
 * не проставляет, и лежит она на 1000 из токенов. Поэтому сравниваются числа, а не строки: «»
 * против «1200» читалось бы как «у обоих ничего не задано», и главный вопрос теста остался бы без
 * ответа.
 */
function layerOf(title: string): number {
  return Number(wrapOf(title).style.zIndex || '1000');
}

/**
 * Кнопка у поля «Исполнители». По части подписи, а не по точному имени: рядом с текстом стоит
 * иконка, и её имя antd подмешивает в доступное имя кнопки («user-switch Назначить»).
 */
function assignButton(): HTMLElement | null {
  const card = within(wrapOf('Заявка СО-14'));
  return (
    card.queryByRole('button', { name: /Назначить$/ }) ??
    card.queryByRole('button', { name: /Изменить$/ })
  );
}

/** Открыть карточку так, как её открывает человек: кликом по строке списка. */
async function openCard(): Promise<void> {
  fireEvent.click(await screen.findByText('СО-14'));
  await waitFor(() => expect(openModalTitles()).toContain('Заявка СО-14'));
}

/**
 * Кнопка подвала карточки по подписи.
 *
 * Поиском по разметке, а не по доступному имени: пока поверх карточки стоит вложенное окно, antd
 * прячет её содержимое от дерева доступности целиком — и `getByRole` не нашёл бы там ничего
 * именно в том сценарии, ради которого тест и написан.
 */
function cardFooterButton(label: string): HTMLElement {
  const found = [...wrapOf('Заявка СО-14').querySelectorAll('button')].find(
    (el) => el.textContent === label,
  );
  if (!found) throw new Error(`в подвале карточки нет кнопки «${label}»`);
  return found;
}

/**
 * Закрыть карточку кнопкой подвала и дождаться, пока с экрана уйдут **все** окна: её узел уходит
 * из `body` целиком (`destroyOnHidden`), и вместе с ним уезжают её вложенные окна.
 *
 * Событие конца анимации шлётся на каждой попытке: в jsdom анимации сами не идут, их конец
 * объявляется событием, а уход окна начинается не в тот же миг, что нажатие, — посланное слишком
 * рано никто не услышит.
 */
async function closeCard(): Promise<void> {
  const wrap = wrapOf('Заявка СО-14');
  fireEvent.click(cardFooterButton('Закрыть'));
  await waitFor(() => {
    for (const el of document.querySelectorAll('.ant-modal')) {
      fireEvent.animationEnd(el);
      fireEvent.transitionEnd(el);
    }
    expect(openModalTitles()).toEqual([]);
  });
  // Узел действительно ушёл из `body`, а не просто спрятался: следующее открытие заведёт новый —
  // на этом и держался прежний спор слоёв.
  expect(wrap.isConnected).toBe(false);
}

/**
 * Открыть меню «Действия» и вернуть его. Закрытые меню antd оставляет в разметке, а рисует их в
 * конце `body`, поэтому берётся последнее непрятанное, а не первое попавшееся.
 */
async function openActions(button: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(button);
  return await waitFor(() => {
    const menu = [...document.querySelectorAll<HTMLElement>('.ant-dropdown')]
      .filter((el) => !el.classList.contains('ant-dropdown-hidden'))
      .map((el) => el.querySelector<HTMLElement>('.ant-dropdown-menu'))
      .filter((el): el is HTMLElement => !!el)
      .at(-1);
    if (!menu) throw new Error('меню действий не открылось');
    return menu;
  });
}

/** Нажать пункт открытого меню. */
function clickMenuItem(menu: HTMLElement, label: string): void {
  const item = [...menu.querySelectorAll<HTMLElement>('.ant-dropdown-menu-title-content')].find(
    (el) => el.textContent === label,
  );
  if (!item) throw new Error(`в меню нет пункта «${label}»`);
  fireEvent.click(item);
}

/** Подписи пунктов меню «Действия» самой карточки — не одноимённого меню строки списка. */
async function cardActionLabels(): Promise<string[]> {
  const menu = await openActions(cardFooterButton('Действия'));
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

describe('кнопка назначения у поля «Исполнители» карточки', () => {
  it('у «Новой» зовёт назначить, и второй ручки к тому же действию в карточке нет', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openCard();

    const card = within(wrapOf('Заявка СО-14'));
    // Глагол — от видимого состава, а не от статуса: рядом с «не назначены» «Изменить» звало бы
    // менять то, чего нет.
    expect(card.getByText('не назначены')).toBeDefined();
    expect(card.getByRole('button', { name: /Назначить$/ })).toBeDefined();

    /*
     * Из меню карточки пункт вычеркнут: две ручки к одному действию в одном окне задавали бы
     * вопрос «а они делают одно и то же?» при каждом открытии. В меню **строки** списка он при
     * этом остаётся — там карточка не открыта, и прятать назначение некуда; это проверено соседним
     * файлом (`service-requests-list.test.tsx`).
     */
    expect(await cardActionLabels()).not.toContain('Назначить исполнителей');
  });

  it('у назначенной заявки подпись меняется на «Изменить»', async () => {
    renderTab(OPERATOR, [assignedRequest()]);
    await openCard();

    const card = within(wrapOf('Заявка СО-14'));
    // Состав виден рядом с кнопкой: исполнителей правят, глядя на то, кто ведёт заявку, — прежде
    // за этим шли в меню внизу карточки, то есть отводили глаза от самого ответа.
    expect(card.getByText('Сисадминов С. С.')).toBeDefined();
    expect(card.getByRole('button', { name: /Изменить$/ })).toBeDefined();
    expect(card.queryByRole('button', { name: /Назначить$/ })).toBeNull();
  });

  it('исполнителю кнопки нет вовсе: назначение — не его ход', async () => {
    /*
     * Право у поля не спрашивается дважды: обработчик приходит готовым пунктом коридора переходов,
     * и его отсутствие — единственная причина, по которой кнопка не рисуется. Спроси поле само,
     * кому назначать можно, — и это была бы вторая карта прав, расходящаяся с коридором на первом
     * же изменении цикла.
     */
    renderTab(EXECUTOR, [assignedRequest()]);
    await openCard();

    const card = within(wrapOf('Заявка СО-14'));
    // Поле на месте и состав показывает — пропала ровно ручка к нему.
    expect(card.getAllByText('Исполнители').length).toBeGreaterThan(0);
    expect(card.getByText('КопиЛайт')).toBeDefined();
    expect(assignButton()).toBeNull();
    // Свой ход у исполнителя при этом есть: кнопка исчезла не заодно со всеми действиями карточки.
    expect(await cardActionLabels()).toContain('Принять в работу');
  });
});

describe('окно назначения лежит поверх карточки, из которой его позвали', () => {
  it('с первого открытия: карточка остаётся под ним, а не закрывается', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openCard();

    fireEvent.click(within(wrapOf('Заявка СО-14')).getByRole('button', { name: /Назначить$/ }));

    // Открыты оба: назначение — шаг внутри разговора о заявке, и карточка за ним видна.
    await waitFor(() =>
      expect(openModalTitles().sort()).toEqual(['Заявка СО-14', 'Назначить исполнителей']),
    );
    // Числа сегодня — 1000 у карточки (базовый слой темы) и 1200 у вложенного окна. Сравнением, а
    // не равенством: обещание antd — «вложенному слой выше родительского», а не конкретный шаг.
    expect(layerOf('Назначить исполнителей')).toBeGreaterThan(layerOf('Заявка СО-14'));
  });

  /**
   * Тот самый регресс.
   *
   * Карточка рисуется с `destroyOnHidden`: при закрытии её узел уходит из `body` целиком, а
   * следующее открытие заводит новый — и он оказывается последним. Пока окно назначения было
   * соседом карточки по странице, оба лежали на одном слое, и спор решал именно порядок узлов: с
   * первого открытия окно ещё всплывало, а после «закрыл — открыл снова» уходило под карточку.
   * Отсюда и три шага сценария: с одним открытием он был бы зелёным и на сломанном портале.
   */
  it('после переоткрытия карточки — тоже: слой считает antd, а не порядок узлов в body', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openCard();
    await closeCard();
    await openCard();

    fireEvent.click(within(wrapOf('Заявка СО-14')).getByRole('button', { name: /Назначить$/ }));
    await waitFor(() => expect(openModalTitles()).toContain('Назначить исполнителей'));

    // Карточка под окном, а не над ним: человек видит форму назначения, а не «ничего не произошло».
    expect(layerOf('Назначить исполнителей')).toBeGreaterThan(layerOf('Заявка СО-14'));
    // И окно живое, а не просто присутствует в разметке под чужим слоем: поле состава заполнено
    // тем, что и правят, а кнопка отправки на месте.
    const assign = within(wrapOf('Назначить исполнителей'));
    expect(assign.getByRole('button', { name: 'Назначить' })).toBeDefined();
    expect(assign.getByLabelText('Исполнители')).toBeDefined();
  });
});

/**
 * Окна карточки гаснут вместе с ней (ADR 0140, находка ревью).
 *
 * Состояние окон живёт в наборе на **уровне страницы**, а сами элементы окон рисуются внутри
 * карточки и уезжают вместе с её детьми (`destroyOnHidden`). Карточку же закрывают и мимо её
 * кнопок: «Назад» браузера снимает `?open=<id>`, тот же жест закрывает полноэкранный шит на
 * телефоне. Окно тогда исчезало молча, а взведённая цель оставалась в наборе — и следующее
 * открытие той же карточки выкидывало окно назначения само, без единого нажатия, да ещё с
 * ревизией заявки, снятой в прошлый раз: сохранение упёрлось бы в 409 «заявку уже подвинули».
 *
 * Клик по «Закрыть» в подвале карточки — честная замена «Назад» в jsdom: перекрытия маской он не
 * учитывает, а до карточки в обоих случаях дотягиваются мимо открытого поверх неё окна.
 */
describe('окна карточки гаснут вместе с ней', () => {
  it('карточку закрыли поверх открытого окна — ушли оба, и назад окно само не вернулось', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openCard();
    fireEvent.click(within(wrapOf('Заявка СО-14')).getByRole('button', { name: /Назначить$/ }));
    await waitFor(() => expect(openModalTitles()).toContain('Назначить исполнителей'));

    // Закрываем саму карточку, окна назначения не трогая: цель в наборе сейчас взведена.
    await closeCard();

    // Открываем ту же карточку снова — и на экране только она.
    await openCard();
    expect(openModalTitles()).toEqual(['Заявка СО-14']);
    // Не по одному лишь заголовку: форма назначения не смонтирована вовсе, а не спрятана.
    expect(screen.queryByPlaceholderText('Кому передать заявку')).toBeNull();
  });
});

/**
 * Повторное письмо службе (Р70) — ключ идемпотентности общий на оба набора действий.
 *
 * Наборов у заявки теперь два: окна списка живут на странице, окна карточки — внутри карточки.
 * Ключ хранится по заявке и переживает оба: держи каждый набор свой, и повтор, оборвавшийся
 * ошибкой в меню карточки, ушёл бы из меню строки под новым ключом — то есть **вторым** письмом
 * службе, ради предотвращения которого ключ и заведён. Успех ключ снимает, поэтому нажатия здесь
 * оба неудачные: проверяется именно поведение до ответа.
 */
describe('повтор письма службе не двоится между наборами действий', () => {
  it('повтор из карточки и из строки списка уходит одним ключом идемпотентности', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()], {
      'POST /service-requests/:id/notify': () =>
        apiError(503, { code: 'MAIL_UNAVAILABLE', message: 'Почтовый сервер недоступен' }),
    });

    await openCard();
    clickMenuItem(
      await openActions(cardFooterButton('Действия')),
      'Отправить письмо службе ещё раз',
    );
    await waitFor(() => expect(http.countOf('POST /service-requests/:id/notify')).toBe(1));

    await closeCard();
    clickMenuItem(
      await openActions(await screen.findByRole('button', { name: 'Действия' })),
      'Отправить письмо службе ещё раз',
    );
    await waitFor(() => expect(http.countOf('POST /service-requests/:id/notify')).toBe(2));

    const keys = http.calls
      .filter((call) => call.method === 'POST' && call.path.endsWith('/notify'))
      .map((call) => (call.body as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
