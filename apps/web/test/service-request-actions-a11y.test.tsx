import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  serviceExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
  SERVICE_COUNTERPARTY,
} from './factories/service';
import { objectDto, operator } from './factories/waste';
import { MOBILE_VIEWPORT } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Доступность меню действий заявки на обслуживание (§7.2 плана «одно действие — один основной
 * вход»).
 *
 * Проверяется то, чего не видно глазами на исправном с виду экране. Меню действий у заявки два —
 * в строке списка и в подвале карточки, — и собирает их один перевод (`actionMenuItems`) ровно
 * потому, что до него они разошлись молча: строка передавала `disabled`, карточка нет, и
 * выключенное «Закрыть работы» из карточки нажималось, открывало окно и упиралось в отказ сервера.
 * Человек при этом видел дверь, за которой отказ, а сборка оставалась зелёной.
 *
 * Ролями, доступными именами и клавиатурой, без внешнего аудитора (`axe-core`/`vitest-axe` не
 * подключаются — развилка В2 плана). Аудитор ответил бы на вопрос «нет ли нарушений разметки», а
 * спрашивается здесь другое: доберётся ли человек до действия и узнает ли, почему оно закрыто.
 * Причина запрета живёт двумя дорогами (`shared/ui/actionMenu.tsx`) — нативной подсказкой для мыши
 * и спрятанным текстом внутри подписи для озвучивания, — и вторую видно только таким тестом:
 * подсказка на выключенном пункте не открывается вовсе, а `title` читают не все программы чтения.
 *
 * Оба меню проверяются одними и теми же случаями намеренно: общий перевод — единственное, что
 * держит их вместе, и «карточка снова потеряла выключенность» обязано падать здесь, а не
 * обнаруживаться отказом сервера.
 */

/** «Ведение»: распределяет, согласует и принимает — у него и живут пункты назначения. */
const OPERATOR: AuthUser = serviceOperator();
/** Подрядчик: закрытие работ — его ход, и планка закрывающего документа стоит именно ему. */
const EXECUTOR: AuthUser = serviceExecutor();

/** Текст, которым портал объясняет закрытую дверь «Закрыть работы» (Н8, `serviceRequestMenu`). */
const CLOSING_DOCUMENT_REASON = /Сначала подшейте акт/;

function renderTab(
  user: AuthUser,
  items: ServiceRequestDto[],
  options: { mobile?: boolean; routes?: RouteMap } = {},
): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Карточка спрашивает заявку сама, а строкой списка лишь рисуется, пока едет свежая: без этого
    // маршрута окно осталось бы без данных, а тест — зелёным и бессмысленным.
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () =>
      json(
        list([
          operator({
            id: SERVICE_COUNTERPARTY.id,
            name: SERVICE_COUNTERPARTY.name,
            type: 'service',
          }),
        ]),
      ),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...options.routes,
  });
  renderWithUser(<RequestsTab />, {
    user,
    viewport: options.mobile ? MOBILE_VIEWPORT : undefined,
  });
  return http;
}

/**
 * Заявка сервисного ремонта в работе, закрывающего документа нет.
 *
 * Опорное состояние всего файла: ровно на нём «Закрыть работы» остаётся видимым и выключенным
 * (Н8) — планка стоит только внешнему сервису и только у ремонта, поэтому компания-исполнитель в
 * фикстуре обязательна, а `files` пусты не по недосмотру.
 */
const inWorkWithoutDocument = (over: Partial<ServiceRequestDto> = {}) =>
  serviceRequest({
    status: 'in_work',
    kind: 'repair',
    service: { ...SERVICE_COUNTERPARTY },
    files: [],
    ...over,
  });

/** Та же заявка с подшитым актом: планка снята, и дверь обязана открыться. */
const inWorkWithDocument = () => inWorkWithoutDocument({ files: [serviceRequestFile('act')] });

/** Заявка с исполнителями и без висящего предъявления: у «Ведения» доступно переназначение. */
const assignedInWork = () =>
  inWorkWithoutDocument({
    executors: [
      { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
    ],
  });

/**
 * Заявка с предъявленным объёмом работ и непустой сметой: у «Ведения» появляется согласование, а
 * вкладка «Объём работ» рисует его кнопкой под таблицей. Строка сметы нужна именно для кнопок —
 * без единой позиции вкладка честно отвечает «объёма работ пока нет» и решений не показывает.
 */
const estimatePending = () =>
  inWorkWithoutDocument({
    executors: [
      { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
    ],
    estimateRevision: 1,
    estimatePendingRevision: 1,
    estimateSubmittedAt: '2026-08-06T09:00:00.000Z',
    estimatedTotalAmount: 1800,
    items: [
      {
        id: 'sri-1',
        kind: 'part',
        name: 'Ролик подачи',
        quantity: 1,
        unitPrice: 1800,
        amount: 1800,
        performed: null,
        actualQuantity: null,
        actualAmount: null,
        warrantyMonths: null,
        warrantyUntil: null,
        warrantyUntilManual: false,
      },
    ],
  });

/**
 * Нажатие клавиши на кнопке — так, как его видит портал.
 *
 * jsdom не выполняет действие по умолчанию: браузер сам шлёт нативной `<button>` событие `click`
 * по Enter и по отпущенному пробелу, а здесь его приходится послать явно. Поэтому первым делом
 * проверяется то, за что отвечает портал и что только и делает клавиатуру рабочей: триггер —
 * настоящая кнопка, а не `div` с обработчиком, и она не выключена. Останься на её месте `div`,
 * этот тест упал бы на первой строке, а не сделал бы вид, что всё открылось.
 */
function pressKey(element: HTMLElement, key: 'Enter' | ' '): void {
  expect(element.tagName).toBe('BUTTON');
  expect((element as HTMLButtonElement).disabled).toBe(false);
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const keyCode = key === 'Enter' ? 13 : 32;
  fireEvent.keyDown(element, { key, code, keyCode });
  fireEvent.keyUp(element, { key, code, keyCode });
  fireEvent.click(element);
}

/**
 * Открытое меню antd. Закрытые меню остаются в разметке и рисуются в конце `body`, поэтому берётся
 * последнее непрятанное, а не первое попавшееся: в карточке на экране их бывает два — меню строки
 * под окном и меню самого окна.
 */
async function openedMenu(): Promise<HTMLElement> {
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

/** Меню ушло с экрана: в jsdom анимации сами не идут, их конец объявляется событием. */
async function expectMenuClosed(): Promise<void> {
  await waitFor(() => {
    const menus = [...document.querySelectorAll<HTMLElement>('.ant-dropdown')];
    for (const menu of menus) {
      fireEvent.animationEnd(menu);
      fireEvent.transitionEnd(menu);
    }
    expect(menus.every((menu) => menu.classList.contains('ant-dropdown-hidden'))).toBe(true);
  });
  // И пункты действительно ушли из дерева доступности, а не просто перестали быть видимыми: до
  // человека с программой чтения экрана закрытое меню доходить не должно.
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
}

/** Окно карточки заявки. Заголовок — единственное, чем окна на экране различаются. */
function cardWrap(): HTMLElement {
  const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((el) => el.style.display !== 'none')
    .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14');
  if (!wrap) throw new Error('карточки «Заявка СО-14» на экране нет');
  return wrap;
}

/** Открыть карточку так, как её открывает человек: нажатием на номер в списке. */
async function openCard(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText('СО-14'));
  return await waitFor(() => cardWrap());
}

/**
 * Меню карточки. Кнопка ищется по разметке подвала, а не по доступному имени: одноимённая кнопка
 * есть и в строке списка под окном, и поиск по всему документу вернул бы обе.
 */
async function openCardMenu(wrap: HTMLElement): Promise<HTMLElement> {
  const button = [...wrap.querySelectorAll<HTMLElement>('.ant-modal-footer button')].find(
    (el) => el.textContent === 'Действия',
  );
  if (!button) throw new Error('в подвале карточки нет кнопки «Действия»');
  fireEvent.click(button);
  return await openedMenu();
}

/**
 * Сколько на экране входов в одно действие. Считаются кнопки самого окна и пункты открытого меню —
 * то есть оба места, где действие вообще может стоять; ответ «1» и есть машинная формулировка
 * критерия «одно действие — один основной вход».
 *
 * Имя действия задаётся выражением, а не строкой, и это не придирка к записи: меню называет
 * действие полностью («Изменить исполнителей»), а вынесенная кнопка — коротко («Изменить»), и
 * считать надо ОБА написания, иначе «ровно один» получится из двух нулей. К имени кнопки antd
 * подмешивает имя иконки («user-switch Изменить»), поэтому выражения привязаны к концу строки.
 */
function entryCount(wrap: HTMLElement, menu: HTMLElement, name: RegExp): number {
  return (
    within(wrap).queryAllByRole('button', { name }).length +
    within(menu).queryAllByRole('menuitem', { name }).length
  );
}

/** Назначение исполнителей: «Назначить исполнителей»/«Изменить исполнителей» в меню, «Изменить» на кнопке. */
const ASSIGN_ENTRY = /(^|\s)(Назначить|Изменить)( исполнителей)?$/;
/** Обсуждение: у кнопки подвала к подписи прирастает счётчик реплик. */
const CHAT_ENTRY = /(^|\s)Обсуждение( · \d+)?$/;
/** Согласование объёма работ: «Согласовать объём работ» в меню, «Согласовать» кнопкой под таблицей. */
const APPROVE_ENTRY = /(^|\s)Согласовать( объём работ)?$/;

describe('у каждого входа в действия есть доступное имя', () => {
  it('в строке списка названы обе кнопки: чтение карточки и меню действий', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    await screen.findByText('СО-14');

    /*
     * Обе кнопки безымянны на вид — в них одни иконки, глаз и многоточие. Имя живёт в `aria-label`,
     * и без него человек с программой чтения экрана слышал бы «кнопка», не понимая, какая из двух
     * открывает запись, а какая — список действий.
     */
    expect(screen.getByRole('button', { name: 'Открыть карточку' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Действия' })).toBeDefined();
  });

  it('в карточке кнопка действий подписана словом, а не иконкой', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    const wrap = await openCard();

    // Подпись здесь видимая, и доступное имя берётся из неё же: отдельного `aria-label` кнопке
    // подвала не нужно — нужно, чтобы имя было.
    expect(within(wrap).getByRole('button', { name: 'Действия' })).toBeDefined();
  });
});

describe('до меню действий добираются с клавиатуры', () => {
  it('меню строки открывается нажатием на кнопке и закрывается Escape', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    await screen.findByText('СО-14');

    const trigger = screen.getByRole('button', { name: 'Действия' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    pressKey(trigger, 'Enter');
    const menu = await openedMenu();

    // Пункты доступны как пункты меню и по своим именам, а не «по третьему `div` сверху».
    expect(within(menu).getByRole('menuitem', { name: 'Объём работ' })).toBeDefined();
    expect(within(menu).getByRole('menuitem', { name: 'Обсуждение' })).toBeDefined();

    /*
     * Tab уводит фокус внутрь меню — так его отдаёт сама библиотека, и без этого шага список
     * действий с клавиатуры был бы недостижим: открылся бы и остался за спиной.
     */
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await expectMenuClosed();
    // Триггер остался на месте и по-прежнему доступен: закрытие меню не уносит с экрана вход в него.
    expect(screen.getByRole('button', { name: 'Действия' })).toBe(trigger);

    /*
     * ВОЗВРАТ ФОКУСА НА ТРИГГЕР ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ, И ЭТО НЕ ЗАБЫВЧИВОСТЬ. Обещает его сама
     * библиотека (`useAccessibility` в `@rc-component/dropdown`: закрывая меню по Escape, она зовёт
     * `triggerRef.current?.focus?.()`), но на связке antd 6.5.1 + React 19 ссылка на триггер пуста,
     * и `focus()` не вызывается ни разу — проверено отдельным опытом на голом `Dropdown`. Ушедший в
     * меню фокус после Escape остаётся на спрятанном пункте: меню закрылось, а человек с
     * клавиатурой стоит в пустоте. Чинится это не здесь и не тестом — своим `ref` на кнопке и
     * возвратом фокуса в `onOpenChange(false)` у обоих меню сразу; пока починки нет, зелёная
     * проверка возврата означала бы, что его кто-то сделал.
     */
  });

  it('пробел на кнопке открывает то же меню', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    await screen.findByText('СО-14');

    // Второй клавишей, а не вместо первой: браузер активирует кнопку обеими, и порталу нельзя
    // держать вход, работающий только по одной из них.
    const trigger = screen.getByRole('button', { name: 'Действия' });
    trigger.focus();
    pressKey(trigger, ' ');

    const menu = await openedMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Объём работ' })).toBeDefined();
  });

  it('меню карточки открывается с клавиатуры и закрывается Escape', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    const wrap = await openCard();

    const trigger = within(wrap).getByRole('button', { name: 'Действия' });
    trigger.focus();
    pressKey(trigger, 'Enter');

    const menu = await openedMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Объём работ' })).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await expectMenuClosed();
    // Само окно при этом никуда не делось: Escape закрыл меню, а не разговор о заявке.
    expect(cardWrap()).toBe(wrap);
  });
});

/**
 * Выключенный пункт (Н2 плана) — главный случай файла.
 *
 * Спрятанный пункт читался бы как «мне это не положено», поэтому «Закрыть работы» у ремонта без
 * закрывающего документа остаётся видимым и выключенным. Но выключенность без причины — это
 * поломка портала в глазах человека, а причина, отданная одной подсказкой по наведению, не
 * достаётся ни клавиатуре, ни озвучиванию: выключенный пункт событий указателя не отдаёт, и
 * `Tooltip` на нём не открылся бы вовсе.
 */
describe('выключенный пункт объявлен выключенным и объясняет себя', () => {
  /** Один и тот же разбор для обоих меню: расходиться им нечем, кроме недосмотра. */
  function expectDisabledCompleteItem(menu: HTMLElement): void {
    const item = within(menu).getByRole('menuitem', { name: /^Закрыть работы/ });

    // Выключенность объявлена, а не нарисована серым: `aria-disabled` — единственное, по чему её
    // узнаёт всё, кроме глаза.
    expect(item.getAttribute('aria-disabled')).toBe('true');

    /*
     * Причина входит в доступное имя пункта — то есть её услышат, а не только увидят при
     * наведении. Проверяется именно имя целиком: спрятанный текст живёт внутри подписи, и
     * вычеркни его кто-нибудь, имя снова стало бы «Закрыть работы» без единого слова о том,
     * почему дверь закрыта.
     */
    expect(within(menu).getByRole('menuitem', { name: CLOSING_DOCUMENT_REASON })).toBe(item);

    // Видимая подпись при этом остаётся отдельным узлом: поиск по ней — глазами, тестом или
    // автоматизацией — не должен ломаться о приклеенную причину.
    expect(within(item).getByText('Закрыть работы')).toBeDefined();
    expect(item.querySelector('.visually-hidden')?.textContent).toMatch(CLOSING_DOCUMENT_REASON);

    // Вторая дорога причины — нативная подсказка: она и достаётся мыши, которой доступное имя
    // пункта не читает никто.
    expect(item.getAttribute('title')).toMatch(CLOSING_DOCUMENT_REASON);
  }

  it('в меню строки списка', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByRole('button', { name: 'Действия' }));
    expectDisabledCompleteItem(await openedMenu());
  });

  it('в меню карточки — том самом, которое теряло выключенность', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()]);
    const wrap = await openCard();

    expectDisabledCompleteItem(await openCardMenu(wrap));
  });

  it('подшитый акт снимает и запрет, и причину: серым пункт не остаётся навсегда', async () => {
    renderTab(EXECUTOR, [inWorkWithDocument()]);
    const wrap = await openCard();

    const item = within(await openCardMenu(wrap)).getByRole('menuitem', {
      name: 'Закрыть работы',
    });
    // Ни объявленной выключенности, ни приклеенной причины: доступное имя снова равно подписи —
    // иначе озвучивание читало бы объяснение запрета у открытой двери.
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(item.getAttribute('title')).toBeNull();
    expect(item.querySelector('.visually-hidden')).toBeNull();
  });
});

/**
 * «Одно действие — один основной вход» (критерий М3/М4 плана), проверенный по доступным именам.
 *
 * Три действия ушли из меню карточки туда, где их предмет читают: назначение — к полю
 * «Исполнители», обсуждение — кнопкой со счётчиком, согласование — под таблицу объёма работ.
 * Вторая ручка к тому же действию в том же окне заставляла бы искать разницу, которой нет, — и
 * тест считает ручки, а не проверяет расположение: пункт, вернувшийся в меню, обязан падать здесь.
 */
describe('в открытой карточке действие встречается ровно один раз', () => {
  it('назначение живёт кнопкой у поля «Исполнители», а не пунктом меню', async () => {
    renderTab(OPERATOR, [assignedInWork()]);
    const wrap = await openCard();
    const menu = await openCardMenu(wrap);

    expect(within(menu).queryByRole('menuitem', { name: /Изменить исполнителей/ })).toBeNull();
    expect(entryCount(wrap, menu, ASSIGN_ENTRY)).toBe(1);
  });

  it('обсуждение живёт кнопкой подвала со счётчиком', async () => {
    renderTab(OPERATOR, [assignedInWork()]);
    const wrap = await openCard();
    const menu = await openCardMenu(wrap);

    // Счётчик — то, ради чего обсуждение и вынесено: меню чисел не показывает, а «есть ли там
    // что-то новое» человек обязан видеть, не открывая список действий.
    expect(within(menu).queryByRole('menuitem', { name: /Обсуждение/ })).toBeNull();
    expect(entryCount(wrap, menu, CHAT_ENTRY)).toBe(1);
  });

  it('согласование живёт кнопкой под таблицей объёма работ', async () => {
    renderTab(OPERATOR, [estimatePending()]);
    const wrap = await openCard();

    // Кнопки решений рисует сама вкладка, поэтому до счёта на неё надо перейти: иначе «ровно один»
    // сложился бы из нулей — ни пункта в меню, ни кнопки на неоткрытой вкладке.
    fireEvent.click(within(wrap).getByRole('tab', { name: 'Объём работ' }));
    await waitFor(() =>
      expect(within(wrap).getByRole('button', { name: /Согласовать$/ })).toBeDefined(),
    );

    const menu = await openCardMenu(wrap);
    expect(within(menu).queryByRole('menuitem', { name: /Согласовать объём работ/ })).toBeNull();
    expect(entryCount(wrap, menu, APPROVE_ENTRY)).toBe(1);
  });

  /*
   * Обратная половина того же правила, и без неё три случая выше доказывали бы лишь, что действия
   * исчезли отовсюду. В строке списка ни поля «Исполнители», ни таблицы объёма работ не видно, и
   * меню — единственный адрес каждого из них; вычеркни его кто-нибудь заодно с карточкой,
   * назначение и согласование пропали бы из портала целиком.
   *
   * Заявки здесь две, потому что состояния взаимоисключающие: пока предъявление объёма работ висит
   * неотвеченным, переназначать исполнителей запрещено (иначе снимок суммы подменили бы под уже
   * открытым окном согласования), а без предъявления согласовывать нечего.
   */
  it('в строке списка назначение доступно кнопкой, а не пунктом меню', async () => {
    renderTab(OPERATOR, [assignedInWork()]);
    await screen.findByText('СО-14');

    // Э5: у кнопки строки доступное имя — та же подпись, что была у пункта; в меню его больше нет,
    // и это единственное место, где назначение вычеркнуто вместе с наличием кнопки рядом.
    expect(screen.getByRole('button', { name: 'Изменить исполнителей' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Действия' }));
    const menu = await openedMenu();
    expect(within(menu).queryByRole('menuitem', { name: 'Изменить исполнителей' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Обсуждение' })).toBeDefined();
  });

  it('в меню строки списка остаётся и согласование объёма работ', async () => {
    renderTab(OPERATOR, [estimatePending()]);
    await screen.findByText('СО-14');

    fireEvent.click(screen.getByRole('button', { name: 'Действия' }));
    const menu = await openedMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Согласовать объём работ' })).toBeDefined();
  });
});

/**
 * Телефон (ADR 0030): выпадающего меню там нет, действия открываются шитом снизу.
 *
 * Подписи в шите обязаны быть словами: подсказка на иконке по касанию не открывается, и набор
 * иконок остался бы загадкой. А нажатие пункта не должно всплывать до карточки списка — иначе
 * выбор действия заодно открывал бы саму заявку поверх начатого.
 *
 * Двух вещей эти случаи НЕ утверждают, потому что их сегодня нет. Шит КАРТОЧКИ подписан
 * («Действия по заявке»), а шит карточки СПИСКА открывается вовсе без заголовка — `DataTable`
 * рисует `ActionSheet` без `title`, и ящик приезжает с одной крестовиной в шапке. И причина
 * запрета в шите не достаётся никому, кроме мыши: выключенный пункт объясняет себя подсказкой на
 * обёртке, а подсказки по наведению на телефоне не открываются — спрятанного текста подписи,
 * которым живёт десктопное меню, здесь нет. Оба места чинятся строкой в прод-коде, и до починки
 * зелёная проверка на них была бы неправдой.
 */
describe('на телефоне действия открываются шитом', () => {
  it('шит карточки назван заголовком, а пункты — словами', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()], { mobile: true });

    // На телефоне карточка сама рисуется шитом, поэтому окна ищутся по заголовкам ящиков.
    fireEvent.click(await screen.findByText('СО-14'));
    const card = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.ant-drawer')].find(
        (el) => el.querySelector('.ant-drawer-title')?.textContent === 'Заявка СО-14',
      );
      if (!found) throw new Error('карточка на телефоне не открылась');
      return found;
    });

    const actions = [...card.querySelectorAll<HTMLElement>('button')].find(
      (el) => el.textContent === 'Действия',
    )!;
    fireEvent.click(actions);

    const sheet = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.ant-drawer')].find(
        (el) => el.querySelector('.ant-drawer-title')?.textContent === 'Действия по заявке',
      );
      if (!found) throw new Error('шит действий не открылся');
      return found;
    });

    // Заголовок отвечает на «что это открылось»: шит приходит снизу поверх карточки, и без
    // подписи список кнопок читался бы как часть самой заявки.
    expect(sheet.querySelector('.ant-drawer-title')?.textContent).toBe('Действия по заявке');
    const labels = [...sheet.querySelectorAll<HTMLElement>('.action-sheet button')].map(
      (el) => el.textContent,
    );
    expect(labels).toContain('Объём работ');
    // «Закрыть работы» здесь выключено: у заявки нет закрывающего документа. Подпись поэтому не
    // равна названию — в доступное имя кнопки входит ещё и причина запрета, спрятанная от глаз
    // (иначе на телефоне она доставалась бы только подсказке, которая по касанию не открывается).
    const complete = labels.find((label) => label?.startsWith('Закрыть работы'));
    expect(complete).toBeDefined();
    expect(complete).toContain('Сначала подшейте акт');
    // Каждая кнопка названа словом, а не одной иконкой: пустая подпись здесь и есть та самая
    // загадка, ради которой шит отличается от десктопного меню.
    expect(labels.every((label) => (label ?? '').trim().length > 0)).toBe(true);
  });

  it('нажатие пункта в шите строки не открывает заодно карточку заявки', async () => {
    renderTab(EXECUTOR, [inWorkWithoutDocument()], { mobile: true });
    await screen.findByText('СО-14');

    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    const sheet = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ant-drawer .action-sheet');
      if (!found) throw new Error('шит действий не открылся');
      return found;
    });

    const item = [...sheet.querySelectorAll<HTMLElement>('button')].find(
      (el) => el.textContent === 'Объём работ',
    )!;
    fireEvent.click(item);

    // Окно действия открылось — то самое, которое просили.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.ant-drawer-title')].map((el) => el.textContent),
      ).toContain('Объём работ заявки СО-14'),
    );
    /*
     * А карточка заявки — нет. Шит рисуется порталом, но событие идёт по дереву React, то есть
     * через карточку списка, из которой шит открыли: не останови его кто-то, выбор действия
     * открывал бы заявку поверх начатого действия — и человек видел бы два окна вместо одного.
     */
    expect(
      [...document.querySelectorAll('.ant-drawer-title')].map((el) => el.textContent),
    ).not.toContain('Заявка СО-14');
  });
});
