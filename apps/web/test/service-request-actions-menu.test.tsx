import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  serviceCustomer,
  serviceExecutor,
  serviceGlobalRequester,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { objectDto } from './factories/waste';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Состав меню действий заявки на обслуживание по МЕСТАМ ПОКАЗА (план
 * `docs/office-equipment-request-actions-menu-plan.md`, §7.1).
 *
 * Мест четыре, и это главное в файле. Один и тот же набор действий портал показывает строкой
 * списка на десктопе (М1), карточкой списка на телефоне (М2), меню карточки заявки (М3) и тем же
 * меню шитом снизу (М4) — а фильтры места у списка и у карточки РАЗНЫЕ. Проверь мы один экран,
 * снятый пункт остался бы на трёх остальных, и обнаружили бы это люди: на телефоне карточка списка
 * и есть единственный экран, с которого работают в поле.
 *
 * Проверяется здесь именно ПОКАЗ, а не доступность: кому какое действие положено, решают предикаты
 * контрактов, и второй карты правил в портале нет. Реестр «действие → где живёт вход» держит
 * караул `service-request-entries.test.tsx` (§7.4); этот файл смотрит на готовую разметку — то, что
 * человек и увидит.
 *
 * Отдельный приём против пустого зелёного: у каждого «пункта нет» рядом стоит «а этот пункт есть».
 * Меню, не открывшееся вовсе, отдаёт пустой список, и проверка «в нём нет повтора письма» была бы
 * зелёной на сломанном портале — якорь и отличает снятый пункт от неоткрывшегося меню.
 */

const OPERATOR: AuthUser = serviceOperator();
/** Исполнитель: назначен на заявку контрагентом-сервисом — свой шаг по циклу у него есть. */
const EXECUTOR: AuthUser = serviceExecutor();
/** Заказчик: тот же штаб, но без надстройки — решений по заявке не принимает (Р102). */
const CUSTOMER: AuthUser = serviceCustomer();

/** Снятый пункт (Э2): вертикаль повтора письма ушла целиком, вместе с мутацией и методом API. */
const NOTIFY = 'Отправить письмо службе ещё раз';
/** Уехавший в карточку пункт (Э4): в меню его нет нигде, а вход остался — кнопкой у реквизитов. */
const MOVE_ITEM = 'Записать перемещение техники';
/** Та самая кнопка в карточке: подпись короче — поле само отвечает, чего именно перемещение. */
const MOVE_BUTTON = 'Записать перемещение';

function renderTab(
  user: AuthUser,
  items: ServiceRequestDto[],
  viewport?: Viewport,
  over: RouteMap = {},
): void {
  mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Кандидаты в поимённые исполнители: их спрашивает окно назначения. Маршрут описан раньше
    // `:id` — иначе шаблон с параметром перехватил бы и его.
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    // Карточка спрашивает заявку сама, а строкой списка лишь рисуется, пока едет свежая: без
    // маршрута окно осталось бы без данных — и сценарий, ничего не проверив, был бы зелёным.
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user, viewport });
}

/**
 * Последнее открытое выпадающее меню.
 *
 * Именно последнее непрятанное, а не первое попавшееся: закрытые меню antd оставляет в разметке, а
 * рисует их в конце `body`. Когда карточка открыта, на экране два одноимённых меню — строки списка
 * и самой карточки, — и `querySelector('.ant-dropdown-menu')` брал бы то, которое старше.
 */
async function lastOpenMenu(): Promise<HTMLElement> {
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

const dropdownLabels = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map((el) => el.textContent ?? '');

/**
 * Подписи пунктов открытого шита действий (ADR 0030).
 *
 * Шит ищется по СОДЕРЖИМОМУ, а не по заголовку: заголовки у двух шитов разные и меняются от правок
 * доступности, а пункты действий у обоих нарисованы одним и тем же `ActionSheet`. Берётся последний
 * подходящий — открытых ящиков на телефоне бывает два (карточка заявки и шит поверх неё), и шит
 * всегда позже в разметке.
 */
async function openSheetLabels(): Promise<string[]> {
  return await waitFor(() => {
    const drawer = [...document.querySelectorAll<HTMLElement>('.ant-drawer-open')]
      .filter((el) => el.querySelector('.action-sheet__item'))
      .at(-1);
    if (!drawer) throw new Error('шит действий не открылся');
    return [...drawer.querySelectorAll('.action-sheet__item')].map((el) => el.textContent ?? '');
  });
}

/** М1: меню строки списка на десктопе — за кнопкой «Действия» в колонке действий. */
async function rowMenuLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  return dropdownLabels(await lastOpenMenu());
}

/**
 * М2: шит карточки списка на телефоне.
 *
 * Первым пунктом здесь стоит «Открыть карточку» — его дописывает сама сетка, и в меню строки на
 * десктопе его нет: там карточку открывают нажатием на строку. Список поэтому возвращается как
 * есть, а не «очищенным»: сценарии сверяют наличие и отсутствие пунктов, а не длину.
 */
async function listSheetLabels(): Promise<string[]> {
  fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
  return await openSheetLabels();
}

/** Открыть карточку так, как её открывает человек: нажатием на строку (на телефоне — на карточку). */
async function openCard(): Promise<void> {
  fireEvent.click(await screen.findByText('СО-14'));
  await screen.findByText('Заявка СО-14');
}

/**
 * Кнопка «Действия» в подвале открытой карточки — либо `null`, если её там нет вовсе.
 *
 * `null` — законный ответ, а не сбой: подвал рисует кнопку только под непустой набор, и у заявки,
 * у которой в меню карточки не осталось ни одного пункта, нажимать нечего. Поиском по разметке, а
 * не по доступному имени: на телефоне так же подписана «⋯» карточки списка под шитом, и `*ByRole`
 * не различил бы их.
 */
function cardActionsTrigger(): HTMLElement | null {
  const card =
    [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
      .filter((el) => el.style.display !== 'none')
      .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14') ??
    document.querySelector<HTMLElement>('.sheet-footer');
  if (!card) throw new Error('карточка заявки не открыта');
  return [...card.querySelectorAll('button')].find((el) => el.textContent === 'Действия') ?? null;
}

/** М3: меню карточки на десктопе. */
async function cardMenuLabels(): Promise<string[]> {
  await openCard();
  const trigger = cardActionsTrigger();
  if (!trigger) throw new Error('в подвале карточки нет кнопки «Действия»');
  fireEvent.click(trigger);
  return dropdownLabels(await lastOpenMenu());
}

/** М4: то же меню на телефоне — шитом снизу (ADR 0030). */
async function cardSheetLabels(): Promise<string[]> {
  await openCard();
  const trigger = cardActionsTrigger();
  if (!trigger) throw new Error('в подвале карточки нет кнопки «Действия»');
  fireEvent.click(trigger);
  return await openSheetLabels();
}

/**
 * Четыре места показа одним перечнем: сценарий пишется один раз и прогоняется по всем четырём.
 *
 * `kind` различает не экран, а НАБОР: списочные меню строит один фильтр места, карточкины — другой,
 * и расходятся они именно по этой границе. Отдельными сценариями, а не циклом внутри одного:
 * упавший скажет, на каком из четырёх экранов пункт остался.
 */
interface MenuPlace {
  name: string;
  kind: 'list' | 'card';
  viewport?: Viewport;
  labels: () => Promise<string[]>;
}

const PLACES: MenuPlace[] = [
  { name: 'М1 строка списка на десктопе', kind: 'list', labels: rowMenuLabels },
  {
    name: 'М2 карточка списка на телефоне',
    kind: 'list',
    viewport: MOBILE_VIEWPORT,
    labels: listSheetLabels,
  },
  { name: 'М3 меню карточки на десктопе', kind: 'card', labels: cardMenuLabels },
  {
    name: 'М4 меню карточки на телефоне',
    kind: 'card',
    viewport: MOBILE_VIEWPORT,
    labels: cardSheetLabels,
  },
];

const LIST_PLACES = PLACES.filter((place) => place.kind === 'list');
const CARD_PLACES = PLACES.filter((place) => place.kind === 'card');

/** Меню места по готовой заявке: рендер, ожидание строки, открытие нужного меню. */
async function labelsAt(
  place: MenuPlace,
  user: AuthUser,
  request: ServiceRequestDto,
): Promise<string[]> {
  renderTab(user, [request], place.viewport);
  await screen.findByText('СО-14');
  return await place.labels();
}

/**
 * Э2: повтор письма службе снят вертикалью — от пункта меню до метода API.
 *
 * Пункт жил ровно в двух статусах, «Новая» и «Отменена» (`serviceMailRepeatable`): письмо уходит на
 * входе в статус, и повторять его там, где события нет, сервер отказывался. Проверяются оба — и
 * каждый на всех четырёх экранах: фильтр места у списка и у карточки свой, и «сняли» на одном из
 * них ничего не говорит про остальные.
 */
describe('«Отправить письмо службе ещё раз» снято из всех четырёх мест (Э2)', () => {
  for (const place of PLACES) {
    it(`у «Новой» без исполнителей пункта нет: ${place.name}`, async () => {
      const labels = await labelsAt(place, OPERATOR, serviceRequest());

      expect(labels).not.toContain(NOTIFY);
      /*
       * Якорь: у нераспределённой «Новой» оператору положена отмена — она есть в обоих наборах, и
       * списочном, и карточкином. Без него сценарий остался бы зелёным на неоткрывшемся меню, то
       * есть проверял бы собственную поломку вместо снятого пункта.
       */
      expect(labels).toContain('Отменить заявку');
    });
  }

  for (const place of LIST_PLACES) {
    it(`у «Отменена» пункта нет: ${place.name}`, async () => {
      const labels = await labelsAt(place, OPERATOR, serviceRequest({ status: 'cancelled' }));

      expect(labels).not.toContain(NOTIFY);
      // Якорь второго статуса — обсуждение: лента доступна во всех статусах и у обеих сторон
      // (ADR 0141), и в меню списка она единственное, что у отменённой заявки осталось.
      expect(labels).toContain('Обсуждение');
    });
  }

  for (const place of CARD_PLACES) {
    it(`у «Отменена» меню карточки не осталось вовсе: ${place.name}`, async () => {
      /*
       * Здесь проверяется не отсутствие строки в списке, а видимое следствие снятия. Обсуждение из
       * меню карточки вычеркнуто (у него своя кнопка со счётчиком в подвале), перемещение уехало к
       * реквизитам, ходов по циклу у отменённой заявки нет, править и сносить её площадочной роли
       * тоже нечего — и повтор письма был у неё ПОСЛЕДНИМ пунктом меню. Сняли его — и кнопка
       * «Действия» в подвале исчезла: подвал рисует её только под непустой набор.
       *
       * Такая проверка сильнее, чем `not.toContain`: она падёт и в том случае, если пункт вернут
       * под другой подписью.
       */
      renderTab(OPERATOR, [serviceRequest({ status: 'cancelled' })], place.viewport);
      await openCard();

      expect(cardActionsTrigger()).toBeNull();
      // А сама карточка при этом жива и показывает заявку: пустое меню — не пустое окно.
      expect(screen.getAllByText('Kyocera M3145').length).toBeGreaterThan(0);
    });
  }
});

/**
 * Э4: перемещение техники ушло из меню в карточку.
 *
 * Пункт из набора действий НЕ ИСЧЕЗ — он скрыт по месту: карточка берёт его готовым и вешает на
 * кнопку у поля «Какой аппарат». Поэтому проверяются обе стороны переезда сразу: в меню его нет ни
 * на одном из четырёх экранов, а вход у действия появился там, где читают реквизиты.
 */
describe('«Записать перемещение техники» ушло из меню в карточку (Э4)', () => {
  for (const place of PLACES) {
    it(`пункта нет: ${place.name}`, async () => {
      // Держатель `officeEquipment.write` и заявка с аппаратом — то самое сочетание, при котором
      // пункт и показывался; без него сценарий проверял бы отсутствие того, чего не бывает.
      const labels = await labelsAt(place, OPERATOR, serviceRequest());

      expect(labels).not.toContain(MOVE_ITEM);
      expect(labels).toContain('Отменить заявку');
    });
  }

  /**
   * Кнопка стоит В ЗНАЧЕНИИ поля «Какой аппарат», а не где-то в карточке: переезд записывают,
   * глядя на реквизиты, и ячейка значения — единственное место, где это утверждение проверяемо.
   * Кнопка «где-то в окне» удовлетворила бы поиску по всей карточке и ничего бы не сказала.
   */
  const moveButtonInEquipmentField = (): HTMLElement | null => {
    const cell = [...document.querySelectorAll<HTMLElement>('.ant-descriptions-item-content')].find(
      (el) => el.textContent?.includes('Kyocera M3145'),
    );
    if (!cell) throw new Error('в карточке нет поля с реквизитами аппарата');
    return (
      [...cell.querySelectorAll('button')].find((el) => el.textContent === MOVE_BUTTON) ?? null
    );
  };

  it('в карточке на десктопе кнопка стоит у поля «Какой аппарат»', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openCard();

    expect(screen.getByText('Какой аппарат')).toBeDefined();
    expect(moveButtonInEquipmentField()).not.toBeNull();
  });

  it('на телефоне она там же: поле одно на оба режима', async () => {
    // На телефоне поля идут подписью над значением, и кнопка могла бы отстать от своего поля —
    // раскладку задаёт `ViewFields`, а не сама строка.
    renderTab(OPERATOR, [serviceRequest()], MOBILE_VIEWPORT);
    await openCard();

    expect(moveButtonInEquipmentField()).not.toBeNull();
  });

  it('без права ведения справочника кнопки нет: она берёт готовый пункт, а не рисуется всегда', async () => {
    /*
     * Заказчику справочник закрыт (`officeEquipment.read` без `.write`), и пункта перемещения в
     * наборе действий у него не появляется. Кнопка своего правила не держит — не будь этой пары
     * сценариев, поле рисовало бы её всем, и проверка «кнопка есть» ничего не значила бы.
     */
    renderTab(CUSTOMER, [serviceRequest()]);
    await openCard();

    expect(moveButtonInEquipmentField()).toBeNull();
  });
});

/** Строка объёма работ: без неё вкладка отвечает «объёма работ пока нет» и решений не предлагает. */
const ESTIMATE_ITEM: ServiceRequestItemDto = {
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
};

/** Заявка с непогашенным предъявлением: решение по объёму работ ждут именно от оператора. */
const pendingEstimate = () =>
  estimatePendingServiceRequest({ items: [ESTIMATE_ITEM], estimatedTotalAmount: 1800 });

/**
 * Согласование объёма работ: из меню карточки снято, в меню списка осталось.
 *
 * Оба решения стоят кнопками под самой таблицей объёма работ — просьба заказчика дословно, — и
 * второй ручки к ним в том же окне быть не должно. В списке же ни таблицы, ни вкладок не видно, и
 * меню там единственный адрес: снимать пункт оттуда значило бы отнимать работу, а не убирать дубль.
 */
/**
 * Э5: назначение получило быстрый вход в строке — и пункт ушёл из меню ТОЛЬКО там.
 *
 * Разделение по видам списка выглядит непоследовательным, пока не спросить «где человек нажмёт»:
 * на десктопе рядом с меню помещается кнопка, а в карточке списка на телефоне кнопок нет ни у
 * чего — там шит и есть единственный адрес действия. Снятый и там пункт означал бы отнятое
 * переназначение, то есть ровно ту находку Н3, из-за которой Э5 и ждал своего входа.
 */
describe('назначение: кнопка в строке, пункт — на телефоне (Э5)', () => {
  const ASSIGN_ITEM = 'Изменить исполнителей';

  /** Кнопка берёт подпись у готового пункта, поэтому ищется по доступному имени, а не по иконке. */
  const assignButtonInRow = (): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (el) => el.getAttribute('aria-label') === ASSIGN_ITEM,
    );

  it('в меню строки пункта нет, а кнопка рядом — есть', async () => {
    // Заявка уже назначена: у первого назначения подпись другая («Назначить исполнителей»), и
    // проверять надо именно переназначение — то, что до Э5 быстрого входа не имело вовсе.
    const labels = await labelsAt(PLACES[0]!, OPERATOR, assignedServiceRequest());

    expect(labels).not.toContain(ASSIGN_ITEM);
    expect(assignButtonInRow()).toBeDefined();
  });

  it('кнопка открывает то же окно, что и пункт меню', async () => {
    renderTab(OPERATOR, [assignedServiceRequest()]);
    await screen.findByText('СО-14');

    fireEvent.click(assignButtonInRow()!);
    // Окно назначения — то же самое, что открывал пункт: проверяется по заголовку, а не по вызову
    // обработчика, иначе тест подтверждал бы сам себя.
    // Заголовок окна назначения меняется вместе с составом: у назначенной заявки он такой же,
    // как подпись пункта, — «Изменить исполнителей» (`AssignServiceModal`).
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(document.querySelector('.ant-modal-title')?.textContent).toBe(ASSIGN_ITEM);
  });

  it('на телефоне пункт остаётся: кнопок в карточке списка нет', async () => {
    const labels = await labelsAt(PLACES[1]!, OPERATOR, assignedServiceRequest());

    expect(labels).toContain(ASSIGN_ITEM);
  });
});

describe('решения по объёму работ: в списке пунктами, в карточке кнопками', () => {
  /** Кнопка решения под таблицей объёма работ по её видимой подписи. */
  const decisionButton = (label: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('button')].find((el) => el.textContent === label);

  for (const place of LIST_PLACES) {
    it(`оба решения на месте: ${place.name}`, async () => {
      const labels = await labelsAt(place, OPERATOR, pendingEstimate());

      expect(labels).toContain('Согласовать объём работ');
      expect(labels).toContain('Не согласовать объём работ');
    });
  }

  for (const place of CARD_PLACES) {
    it(`решений в меню нет: ${place.name}`, async () => {
      const labels = await labelsAt(place, OPERATOR, pendingEstimate());

      expect(labels).not.toContain('Согласовать объём работ');
      expect(labels).not.toContain('Не согласовать объём работ');
      // Якорь: меню карточки не опустело заодно — отмена и заморозка из него не вычёркивались.
      expect(labels).toContain('Отменить заявку');
    });
  }

  it('под таблицей объёма работ обе кнопки на месте: действие не отняли, а перенесли', async () => {
    renderTab(OPERATOR, [pendingEstimate()]);
    await openCard();

    fireEvent.click(screen.getByRole('tab', { name: 'Объём работ' }));

    /*
     * Подписи под таблицей короче меню («Согласовать» вместо «Согласовать объём работ»): рядом
     * стоит сама таблица, и повторять её название кнопке незачем. Проверяются они именно потому,
     * что это ЕДИНСТВЕННЫЙ оставшийся в карточке вход: пропади кнопки вместе с пунктами — заявку
     * стало бы нечем согласовать, не выходя из окна.
     *
     * Поиском по видимой подписи, а не по доступному имени: у обеих кнопок есть иконка, и antd
     * подмешивает её имя в имя кнопки («audit Согласовать»).
     */
    await waitFor(() => expect(decisionButton('Согласовать')).toBeDefined());
    expect(decisionButton('Не согласовано')).toBeDefined();
  });
});

/**
 * Регресс оставленных пунктов (§1 плана: «оставить доступные по правам»).
 *
 * Уборка меню опасна не тем, что снимет лишнее по недосмотру автора, а тем, что снятое никто не
 * хватится: пункт, которым пользовались раз в неделю, пропадает молча. Поэтому у каждой стороны
 * проверяется её собственный набор, а не общий список.
 */
describe('оставленные пункты живы', () => {
  it('исполнителю по «В работе» меню строки предлагает «Объём работ»', async () => {
    const labels = await labelsAt(
      LIST_PLACES[0]!,
      EXECUTOR,
      assignedServiceRequest({ status: 'in_work' }),
    );

    expect(labels).toContain('Объём работ');
  });

  it('и то же самое — из карточки: набор один, различается только место', async () => {
    const labels = await labelsAt(
      CARD_PLACES[0]!,
      EXECUTOR,
      assignedServiceRequest({ status: 'in_work' }),
    );

    expect(labels).toContain('Объём работ');
  });

  it('оператору по «В работе» — заморозка, срочность, обсуждение и отмена', async () => {
    // Четыре пункта одним сценарием намеренно: это набор «всё, что заказчик просил оставить», и
    // проверять его по одному значило бы разрешить пропажу трёх из четырёх незамеченной.
    const labels = await labelsAt(
      LIST_PLACES[0]!,
      OPERATOR,
      assignedServiceRequest({ status: 'in_work' }),
    );

    expect(labels).toContain('Отложить');
    expect(labels).toContain('Отметить срочной');
    expect(labels).toContain('Обсуждение');
    expect(labels).toContain('Отменить заявку');
  });

  it('автору правимой «Новой» — «Удалить»', async () => {
    // Снос в архив держит то же условие, что и сервер: площадочной роли он открыт, пока заявку
    // правят, — то есть пока она «Новая» и за ней никто не стоит.
    const labels = await labelsAt(LIST_PLACES[0]!, CUSTOMER, serviceRequest());

    expect(labels).toContain('Удалить');
  });
});

/**
 * Страж стороны заказчика на кнопках карточки (план профилей оргтехники, Р6; §11, условие 3).
 *
 * Сервер отвечает 403 держателю набора «Заявитель» у роли без оси на ЧУЖОЙ строке, а карточка
 * пункты «Редактировать» и «Удалить» на ней показывала — это дефект строки матрицы, а не отдельная
 * задача: портал не должен обещать того, чего сервер не даст.
 *
 * Авторство портал берёт из сводки обсуждения: `ServiceRequestDto` не отдаёт `createdBy`, а
 * `participantSides` содержит `customer` ровно у автора — так его посчитал сервер по той же
 * строке, по которой судит страж. Поэтому фикстуры различаются ровно этим полем: всё остальное у
 * двух заявок одинаково, и разницу в меню создаёт только авторство.
 */
const REQUESTER_USER: AuthUser = serviceGlobalRequester();

/** Чужая «Новая»: видна глобально (у роли нет оси), но заведена не им. */
const FOREIGN: ServiceRequestDto = serviceRequest({ audience: 'requester' });

/** Та же заявка, заведённая им самим: `customer` в сводке обсуждения — и есть факт авторства. */
const OWN: ServiceRequestDto = serviceRequest({
  audience: 'requester',
  chat: { ...FOREIGN.chat, canWrite: true, participantSides: ['customer'] },
});

describe('«Редактировать» и «Удалить» сужены стороной заказчика (Р6)', () => {
  for (const place of LIST_PLACES) {
    it(`на чужой строке пунктов нет: ${place.name}`, async () => {
      const labels = await labelsAt(place, REQUESTER_USER, FOREIGN);

      expect(labels).not.toContain('Редактировать');
      expect(labels).not.toContain('Удалить');
      // Якорь: обсуждение стоит у всех и во всех статусах (ADR 0141) — без него сценарий был бы
      // зелёным и на неоткрывшемся меню, то есть проверял бы собственную поломку.
      expect(labels).toContain('Обсуждение');
    });

    it(`на своей — оба пункта на месте: ${place.name}`, async () => {
      // Вторая половина проверки: правило сужает субъекта до СВОИХ строк, а не отбирает у него
      // работу. Заявка та же самая, различие ровно одно — авторство в сводке обсуждения.
      const labels = await labelsAt(place, REQUESTER_USER, OWN);

      expect(labels).toContain('Редактировать');
      expect(labels).toContain('Удалить');
    });
  }

  it('на чужой строке правки нет и у кнопки подвала карточки', async () => {
    // В карточке «Редактировать» — не пункт меню, а главная кнопка подвала, и берётся она из того
    // же набора действий: не подведи мы набор под стража, кнопка осталась бы там, где меню уже
    // чисто.
    renderTab(REQUESTER_USER, [FOREIGN]);
    await openCard();

    expect(screen.queryByRole('button', { name: 'Редактировать' })).toBeNull();
  });

  it('на своей строке кнопка правки в подвале карточки есть', async () => {
    renderTab(REQUESTER_USER, [OWN]);
    await openCard();

    expect(await screen.findByRole('button', { name: 'Редактировать' })).toBeTruthy();
  });

  it('прочих субъектов правило не касается: у «Ведения» пункты на месте', async () => {
    // Предикат отвечает «да» всем, кого правило не сужает, и это его главное свойство: одна и та же
    // чужая (для оператора — обычная) строка обязана остаться такой же, какой была до Э8.
    const labels = await labelsAt(PLACES[0]!, OPERATOR, FOREIGN);

    expect(labels).toContain('Редактировать');
    expect(labels).toContain('Удалить');
  });
});
