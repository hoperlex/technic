import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  OfficeEquipmentConsumableDto,
  OfficeEquipmentDto,
  ServiceRequestConsumableDto,
  ServiceRequestDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { serviceRequest } from './factories/service';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';
import { ServiceRequestViewModal } from '../src/pages/service/ServiceRequestViewModal';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceCompleteModal } from '../src/features/service-complete/ui/ServiceCompleteModal';
import { ServiceConsumablesIssueModal } from '../src/features/service-consumables-issue/ui/ServiceConsumablesIssueModal';

/**
 * Заявка на расходники (выпуск 3 плана `docs/office-equipment-requests-rework-plan.md`, §6.2).
 *
 * Проверяется то, что молча расходится с сервером и со складом:
 *
 * 1. **подстановка позиций по модели аппарата** (Н10) — то, ради чего заводился справочник
 *    моделей: сотрудник выбирает МФУ, а картридж подставляется сам. Спроси портал позиции не по
 *    модели, а «все», и человек выбирал бы тонер, который в этот аппарат не встаёт;
 * 2. **умолчание факта подставляет форма, а не сервер** (Р3): по молчанию клиента сервер со склада
 *    не списывает и отвечает 422 «нет отметки о выдаче». Уйди закрытие без строк — работы не
 *    закрылись бы вовсе;
 * 3. **расхождение объясняется причиной** — правилом контрактов, а не своей копией: разойдись они,
 *    человек узнавал бы об обязательной причине из отказа после нажатия;
 * 4. **правка факта двигает разницу, а не всё количество** (Р6): было 2, стало 3 — со склада уйдёт
 *    одна штука. Уйди туда «3», склад разошёлся бы с полкой на первой же правке;
 * 5. **нехватка остатка показывается текстом сервера** (Р7): в нём названы позиция, остаток и оба
 *    законных выхода, и подменять его общим «не удалось сохранить» значит отобрать у человека всё,
 *    ради чего сервер это писал.
 */

const NORTH = { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' };
const MODEL = { id: 'oem-1', name: 'Ricoh IM 350' };

/** Аппарат один: `AutoSelect` подставит его сам — проверяется не выбор техники, а что за ним. */
const UNIT: OfficeEquipmentDto = {
  id: 'oe-1',
  type: { id: 'oet-1', name: 'МФУ', isActive: true },
  model: MODEL,
  name: 'Ricoh IM 350',
  serialNumber: '',
  inventoryNumber: '0012345',
  object: NORTH,
  department: null,
  location: 'Корпус 3, каб. 214',
  state: 'on_site',
  stateNote: '',
  purchasedOn: null,
  warrantyUntil: null,
  comment: '',
  isActive: true,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  deletedAt: null,
};

function consumable(over: Partial<OfficeEquipmentConsumableDto> = {}): OfficeEquipmentConsumableDto {
  return {
    id: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201',
    quantity: 4,
    isActive: true,
    color: null,
    comment: '',
    models: [{ id: MODEL.id, name: MODEL.name }],
    equipmentCount: 1,
    hasStockHistory: false,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...over,
  };
}

/** Подходит модели ровно одна позиция: её и подставляет форма сама (Н10). */
const FITTING = consumable();
/**
 * Чужая позиция — от другого аппарата. Цвет у неё свой (Р9): цвета это разные позиции с разными
 * кодами и остатками, а не пометка в строке заявки, и в списке выбора они так и выглядят.
 */
const FOREIGN = consumable({
  id: 'oec-2',
  code: 'Д0000093570',
  name: 'Тонер Kyocera TK-1170',
  color: 'голубой',
  models: [],
});

const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
  phone: '9001234567',
});

/** Строка заявки: что просили, что выдали и почему разошлось. */
function line(over: Partial<ServiceRequestConsumableDto> = {}): ServiceRequestConsumableDto {
  return {
    id: 'src-1',
    consumableId: FITTING.id,
    code: FITTING.code,
    name: FITTING.name,
    color: null,
    requestedQuantity: 2,
    issuedQuantity: null,
    issueNote: '',
    ...over,
  };
}

/** Заявка на расходники: вид, строки и статус — три факта, которые не бывают порознь. */
function consumableRequest(
  status: ServiceRequestDto['status'],
  lines: ServiceRequestConsumableDto[],
): ServiceRequestDto {
  return serviceRequest({ kind: 'consumable', status, consumables: lines });
}

// ── Заведение ──────────────────────────────────────────────────────────────

function renderForm(routes: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([UNIT])),
    'GET /departments': () => json(emptyList()),
    'GET /objects': () => json(emptyList()),
    // Отбор по модели — на стороне сервера: портал шлёт `modelId`, и проверяется именно это.
    'GET /office-equipment-consumables': ({ query }) =>
      json(list(query.get('modelId') === MODEL.id ? [FITTING] : [FITTING, FOREIGN])),
    ...routes,
  });
  renderWithUser(<ServiceRequestForm open request={null} onClose={() => {}} />, { user: OPERATOR });
  return http;
}

/** Переключатель вида: antd рисует его радиокнопками, и человек нажимает на подпись. */
function chooseKind(label: string): void {
  const item = [...document.querySelectorAll('.ant-segmented-item')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!item) throw new Error(`вида «${label}» в переключателе нет`);
  fireEvent.click(item.querySelector('input') ?? item);
}

/** Что стоит в поле позиции строки: подпись выбранного варианта. */
function chosenConsumable(index = 0): string {
  const field = document
    .getElementById(`consumables_${index}_consumableId`)
    ?.closest('.ant-select');
  const content = field?.querySelector('.ant-select-content');
  return content?.getAttribute('title') ?? content?.textContent ?? '';
}

function bodyOf(http: HttpMock, route: string): Record<string, unknown> {
  return http.lastCall(route)?.body as Record<string, unknown>;
}

describe('заведение заявки на расходники (Н1, Н9, Н10)', () => {
  const create = {
    'POST /service-requests': () =>
      json({ request: consumableRequest('new', [line()]), mail: 'queued' }, 201),
  };

  it('позиции подбираются по модели аппарата, а единственная подставляется сама', async () => {
    const http = renderForm(create);
    chooseKind('Расходники');

    // Аппарат выбран (он единственный), и вслед за ним ушёл запрос позиций **его модели**.
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-consumables')?.query.get('modelId')).toBe(
        MODEL.id,
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Добавить позицию/ }));
    // Та самая подстановка: к модели подходит одна позиция, и человеку её выбирать не из чего.
    await waitFor(() => expect(chosenConsumable()).toContain('Тонер Ricoh 201'));
    // Код и остаток стоят в подписи: заказывая четыре тонера, человек видит, что на складе их
    // четыре, а сверять со счётом будут по коду.
    expect(chosenConsumable()).toContain('Д0000093569');
    expect(chosenConsumable()).toContain('на складе 4');

    fireEvent.change(screen.getByLabelText('Сколько нужно'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Зачем нужно'), {
      target: { value: 'Закончился чёрный тонер' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    const body = bodyOf(http, 'POST /service-requests');
    expect(body.kind).toBe('consumable');
    // Строки уходят заведением, а не отдельным PUT следом: заявка без них запрещена постановкой.
    expect(body.consumables).toEqual([{ consumableId: 'oec-1', requestedQuantity: 2 }]);
  });

  it('без строк форма не отпускает: заявка на расходники без них не заводится', async () => {
    const http = renderForm(create);
    chooseKind('Расходники');
    fireEvent.change(await screen.findByLabelText('Зачем нужно'), {
      target: { value: 'Закончился чёрный тонер' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(
      await screen.findByText('Добавьте хотя бы одну позицию: без них заявка не заводится'),
    ).toBeDefined();
    expect(http.countOf('POST /service-requests')).toBe(0);
  });

  it('у ремонта строк номенклатуры нет вовсе — их и не спрашивают', async () => {
    renderForm(create);
    // Умолчание вида — ремонт: поле неисправности на месте, строк нет.
    expect(await screen.findByLabelText('Неисправность')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Добавить позицию/ })).toBeNull();
  });
});

// ── Закрытие работ ─────────────────────────────────────────────────────────

function renderComplete(request: ServiceRequestDto, routes: RouteMap = {}): HttpMock {
  const http = mockHttp(routes);
  renderWithUser(<ServiceCompleteModal request={request} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

/** Поля факта по строкам: их столько же, сколько строк, и порядок тот же. */
const issuedFields = () => screen.getAllByLabelText(/^Выдано: /) as HTMLInputElement[];
const noteFields = () => screen.getAllByLabelText(/^Причина расхождения: /) as HTMLInputElement[];

describe('закрытие работ у расходников (Р3, §6.2)', () => {
  const done = {
    'PATCH /service-requests/:id/complete': () =>
      json(consumableRequest('done', [line({ issuedQuantity: 2 })])),
  };

  it('умолчание факта — «сколько просили», и подставляет его форма', async () => {
    const http = renderComplete(
      consumableRequest('in_work', [line(), line({ id: 'src-2', requestedQuantity: 1 })]),
      done,
    );

    await screen.findByText('Отметьте, сколько выдали');
    // Сметы у расходников нет вовсе: ни итога по акту, ни скидки в окне быть не может.
    expect(screen.queryByLabelText('Скидка по акту')).toBeNull();
    expect(issuedFields().map((input) => input.value)).toEqual(['2', '1']);

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(1));

    const body = bodyOf(http, 'PATCH /service-requests/:id/complete');
    // Факт уходит по каждой строке: сервер отвечает 422 «нет отметки о выдаче» на любую пропущенную.
    expect(body.consumables).toEqual([
      { id: 'src-1', issuedQuantity: 2, issueNote: '' },
      { id: 'src-2', issuedQuantity: 1, issueNote: '' },
    ]);
    // Строки сметы и строки номенклатуры не бывают у одной заявки: смета уходит пустой.
    expect(body.items).toEqual([]);
  });

  it('расхождение без причины не отправляется, а с причиной уходит вместе с ней', async () => {
    const http = renderComplete(consumableRequest('in_work', [line()]), done);
    await screen.findByText('Отметьте, сколько выдали');

    fireEvent.change(issuedFields()[0]!, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));

    // Текст правила — из контрактов (`serviceConsumableIssueIssue`), а не своя копия портала.
    // Их двое: строка под таблицей и тост — окно закрытия отвечает обоими.
    expect(
      (await screen.findAllByText(/Объясните, почему выдали меньше, чем просили/)).length,
    ).toBeGreaterThan(0);
    expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(0);

    fireEvent.change(noteFields()[0]!, { target: { value: 'на складе был один' } });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(1));
    expect(bodyOf(http, 'PATCH /service-requests/:id/complete').consumables).toEqual([
      { id: 'src-1', issuedQuantity: 1, issueNote: 'на складе был один' },
    ]);
  });
});

// ── Правка факта выдачи ────────────────────────────────────────────────────

function renderIssue(request: ServiceRequestDto, routes: RouteMap = {}): HttpMock {
  const http = mockHttp(routes);
  renderWithUser(<ServiceConsumablesIssueModal request={request} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

const issueButton = () =>
  screen.getByRole('button', { name: 'Записать выдачу' }) as HTMLButtonElement;

describe('правка факта выдачи (Р6)', () => {
  const patched = {
    'PATCH /service-requests/:id/consumables/issued': () =>
      json(consumableRequest('done', [line({ requestedQuantity: 3, issuedQuantity: 3 })])),
  };

  it('со склада уходит разница, и уходят только тронутые строки', async () => {
    const http = renderIssue(
      consumableRequest('done', [
        line({ requestedQuantity: 3, issuedQuantity: 2 }),
        line({ id: 'src-2', requestedQuantity: 1, issuedQuantity: 1 }),
      ]),
      patched,
    );

    await screen.findByText('Со склада уйдёт разница, а не всё количество');
    // Пока ничего не изменилось, отправлять нечего: событий журнала такая правка не породит.
    expect(issueButton().disabled).toBe(true);

    fireEvent.change(issuedFields()[0]!, { target: { value: '3' } });
    // Разница — вот она, у самой строки: спишется одна штука, а не три.
    expect(await screen.findByText(/спишется со склада 1/)).toBeDefined();

    fireEvent.click(issueButton());
    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/consumables/issued')).toBe(1),
    );
    const body = bodyOf(http, 'PATCH /service-requests/:id/consumables/issued');
    // Нетронутая строка не уходит вовсе: её факт не менялся, и второй раз с неё ничего не спишется.
    expect(body.items).toEqual([{ id: 'src-1', issuedQuantity: 3, issueNote: '' }]);
  });

  it('возврат вниз — событие на разницу и обязательная причина', async () => {
    const http = renderIssue(
      consumableRequest('done', [line({ requestedQuantity: 2, issuedQuantity: 2 })]),
      patched,
    );
    await screen.findByText('Со склада уйдёт разница, а не всё количество');

    fireEvent.change(issuedFields()[0]!, { target: { value: '0' } });
    expect(await screen.findByText(/вернётся на склад 2/)).toBeDefined();
    // Ноль — законный исход («съездили, тонер оказался цел»), но объяснённый.
    expect(await screen.findByText(/Объясните, почему ничего не выдали/)).toBeDefined();
    expect(issueButton().disabled).toBe(true);

    fireEvent.change(noteFields()[0]!, { target: { value: 'вернули на склад' } });
    await waitFor(() => expect(issueButton().disabled).toBe(false));
    fireEvent.click(issueButton());

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/consumables/issued')).toBe(1),
    );
    expect(bodyOf(http, 'PATCH /service-requests/:id/consumables/issued').items).toEqual([
      { id: 'src-1', issuedQuantity: 0, issueNote: 'вернули на склад' },
    ]);
  });

  it('нехватка остатка показывается текстом сервера, а не общим отказом (Р7)', async () => {
    const refusal =
      'Тонер Ricoh 201 (Д0000093569): на складе 1, выдаётся 2. Исправьте выданное количество или пополните остаток';
    renderIssue(consumableRequest('done', [line({ requestedQuantity: 3, issuedQuantity: 1 })]), {
      'PATCH /service-requests/:id/consumables/issued': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message: refusal,
          fields: { consumables: 'Не хватает остатка' },
        }),
    });
    await screen.findByText('Со склада уйдёт разница, а не всё количество');

    fireEvent.change(issuedFields()[0]!, { target: { value: '3' } });
    fireEvent.click(issueButton());

    // Текст приходит готовым предложением: позиция, остаток и оба выхода. Хвоста из имени поля
    // («: consumables») в нём быть не должно — общий сборщик сообщения его дописал бы.
    const shown = await screen.findAllByText(refusal);
    expect(shown.length).toBeGreaterThan(0);
    expect(screen.queryByText(/consumables/)).toBeNull();
  });
});

// ── Строки в карточке ──────────────────────────────────────────────────────

describe('строки расходников в карточке заявки (Р10)', () => {
  it('показывают, что просили, что выдали и почему разошлось — и только на чтение', async () => {
    const request = consumableRequest('accepted', [
      line({ requestedQuantity: 2, issuedQuantity: 1, issueNote: 'на складе был один' }),
      line({ id: 'src-2', consumableId: FOREIGN.id, code: FOREIGN.code, name: FOREIGN.name, color: 'голубой', requestedQuantity: 1 }),
    ]);
    mockHttp({
      'GET /service-requests/:id': () => json(request),
      'GET /service-requests/:id/history': () => json([]),
    });
    renderWithUser(<ServiceRequestViewModal request={request} onClose={() => {}} />, {
      user: OPERATOR,
    });

    // У расходников вкладки «Смета» нет вовсе: предмет заявки — либо смета, либо номенклатура.
    fireEvent.click(await screen.findByRole('tab', { name: 'Номенклатура' }));
    expect(screen.queryByRole('tab', { name: 'Смета' })).toBeNull();

    expect(await screen.findByText('Тонер Ricoh 201')).toBeDefined();
    expect(screen.getByText('на складе был один')).toBeDefined();
    // Цвет — свойство позиции (Р9): у цветной серии он различает строки, а не пишется в заявке.
    expect(screen.getByText('голубой')).toBeDefined();
    // «Нет отметки» и «выдали ноль» — разные состояния, и вторая строка стоит первым из них.
    expect(screen.getByText('не отмечено')).toBeDefined();
    // Закрытая заявка правится только чтением: полей факта в карточке нет ни одного.
    expect(screen.queryAllByLabelText(/^Выдано: /)).toHaveLength(0);
  });
});

// ── Пункт меню ─────────────────────────────────────────────────────────────

/** Список заявок: из него и открывают окна — меню строки строит коридор переходов. */
function renderTab(items: ServiceRequestDto[]): void {
  mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR });
}

/** Подписи пунктов меню строки — по ним и видно, что заявке разрешено. */
async function rowActionLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  const menu = await waitFor(() => {
    const found = document.querySelector('.ant-dropdown-menu');
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

describe('отметка о выдаче в меню заявки (§6.2, Р6)', () => {
  it('в «В работе» предлагает отметить выдачу и не предлагает смету', async () => {
    renderTab([consumableRequest('in_work', [line()])]);

    const labels = await rowActionLabels();
    expect(labels).toContain('Отметить выдачу');
    // Сметы у расходников нет вовсе: согласовывать картридж со своего склада не с кем.
    expect(labels).not.toContain('Смета');
  });

  it('у закрытой заявки пункта нет: строки замерли, остаток правят вручную (Р8)', async () => {
    renderTab([consumableRequest('accepted', [line({ issuedQuantity: 2 })])]);
    await screen.findByText('СО-14');

    // У закрытой заявки ходов может не остаться вовсе — тогда нет и самой кнопки «Действия».
    // Проверяется одно: правки факта среди доступного нет ни под каким именем.
    const labels = screen.queryByRole('button', { name: 'Действия' })
      ? await rowActionLabels()
      : [];
    expect(labels).not.toContain('Отметить выдачу');
    expect(labels).not.toContain('Изменить выданное');
  });
});
