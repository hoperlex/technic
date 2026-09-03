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
import { ServiceRequestConsumablesModal } from '../src/pages/service/ServiceRequestConsumables';

/**
 * Заявка на расходники (выпуск 3 плана `docs/office-equipment-requests-rework-plan.md`, §6.2).
 *
 * Проверяется то, что молча расходится с сервером и со складом:
 *
 * 1. **подстановка позиций по модели аппарата** (Н10) — то, ради чего заводился справочник
 *    моделей: картридж подставляется сам. Спроси портал позиции не по модели, а «все», и человек
 *    выбирал бы тонер, который в этот аппарат не встаёт. Спрашивают их теперь в редакторе состава,
 *    а не в форме заведения (Р15): заявитель говорит словами, состав пишет исполнитель;
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

function consumable(
  over: Partial<OfficeEquipmentConsumableDto> = {},
): OfficeEquipmentConsumableDto {
  return {
    id: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201',
    quantity: 4,
    /*
     * Потребность, «уже заказано» и дефицит (Р13, Р15 плана расходников и закупки). У фикстуры они
     * нулевые: экран подбирает позицию по коду и наименованию, а проверять на нём формулу
     * `max(0, потребность − остаток − уже заказано)` нечем — считает её сервер одним местом, и
     * второе число, посчитанное здесь, разошлось бы с ним при первой же правке правила.
     */
    requiredQuantity: 0,
    alreadyOrdered: 0,
    deficit: 0,
    isActive: true,
    color: null,
    comment: '',
    models: [{ id: MODEL.id, name: MODEL.name }],
    equipmentCount: 1,
    hasStockHistory: false,
    // Ручных правок остатка у позиции не было (Р3): движения по ней шли только заявками, а их
    // столбец «Правка остатка» не считает вовсе — здесь это и означает `null`, а не «не знаем».
    lastManualStockAt: null,
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

/**
 * Плейсхолдер поля описания. Подпись у поля одна на оба вида (Р2), а вот подсказка внутри
 * по-прежнему ветвится — она и служит признаком «переключение вида доехало до поля»: по подписи
 * этого больше не увидеть.
 */
function descriptionPlaceholder(): string {
  return screen.getByLabelText('Описание').getAttribute('placeholder') ?? '';
}

/**
 * Заведение после Р15. Прежние три сценария проверяли выбор позиций **в форме заведения** —
 * подстановку по модели, отказ пустого списка и отсутствие блока у ремонта. Блока в форме больше
 * нет ни у одного вида: заявитель номенклатуры не знает, и его дело — сказать словами, чего не
 * хватает. Подстановка и запрет пустого списка никуда не делись, но переехали в редактор состава
 * (`ServiceRequestConsumablesModal`) — там они и проверяются ниже, у своего окна.
 */
describe('заведение заявки на расходники (Н1, Р15, Р2)', () => {
  const create = {
    'POST /service-requests': () =>
      json({ request: consumableRequest('new', [line()]), mail: 'queued' }, 201),
  };

  it('номенклатуры форма не спрашивает: заявитель отвечает словами в «Описании»', async () => {
    const http = renderForm(create);
    await screen.findByLabelText('Описание');
    chooseKind('Расходники');

    // Ждём не подписи — она у обоих видов одна, — а плейсхолдера: только он и говорит, что
    // переключение вида доехало, а проверки ниже ищут отсутствие блока уже у расходников.
    await waitFor(() => expect(descriptionPlaceholder()).toContain('чёрный тонер'));
    // Блока позиций нет вовсе — ни кнопки, ни полей строки: спрашивать нечего.
    expect(screen.queryByRole('button', { name: /Добавить позицию/ })).toBeNull();
    expect(screen.queryByLabelText('Позиция номенклатуры')).toBeNull();
    // И справочник расходников формой не тревожится: подбирать позиции ей не для чего.
    expect(http.countOf('GET /office-equipment-consumables')).toBe(0);

    fireEvent.change(screen.getByLabelText('Описание'), {
      target: { value: 'Закончился чёрный тонер, печатать нечем' },
    });
    // Заказчика форма подставляет сама — площадкой единственной единицы, — но лишь когда справочник
    // приехал и единица встала в поле. Нажатие до этого момента упёрлось бы в обязательный подбор
    // «Для кого заявка», и проверка про строки номенклатуры не состоялась бы вовсе.
    await waitFor(() =>
      expect(document.getElementById('customer')?.closest('.ant-select')?.textContent).toContain(
        NORTH.name,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    const body = bodyOf(http, 'POST /service-requests');
    expect(body.kind).toBe('consumable');
    // Заявка ушла БЕЗ строк — и это главное отличие от прежней модели: пустой состав здесь
    // законен, его заполнит исполнитель своей ручкой.
    expect(body.consumables).toBeUndefined();
    expect(body.description).toBe('Закончился чёрный тонер, печатать нечем');
  });

  it('подпись описания одна на оба вида, ветвится только подсказка, и строк нет ни у одного', async () => {
    renderForm(create);
    // Умолчание вида — обслуживание: описание на месте, позиций нет (Р15).
    expect(await screen.findByLabelText('Описание')).toBeDefined();
    expect(descriptionPlaceholder()).toContain('мнёт бумагу');
    expect(screen.queryByRole('button', { name: /Добавить позицию/ })).toBeNull();

    chooseKind('Расходники');

    // Предмет проверки: смена вида подписи не трогает (Р2). Кинд-зависимые «Что случилось / Что
    // нужно» из Р17 ADR 0145 отменены — поле одно, и спрашивает оно обоими видами одинаково.
    // Плейсхолдер при этом сменился, и это не недоделка: он подсказывает, а не называет.
    await waitFor(() => expect(descriptionPlaceholder()).toContain('чёрный тонер'));
    expect(screen.getByLabelText('Описание')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Добавить позицию/ })).toBeNull();
  });
});

// ── Состав номенклатуры: окно исполнителя ──────────────────────────────────

function renderConsumablesModal(request: ServiceRequestDto, routes: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([UNIT])),
    // Отбор по модели — на стороне сервера: портал шлёт `modelId`, и проверяется именно это.
    'GET /office-equipment-consumables': ({ query }) =>
      json(list(query.get('modelId') === MODEL.id ? [FITTING] : [FITTING, FOREIGN])),
    ...routes,
  });
  renderWithUser(<ServiceRequestConsumablesModal request={request} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

describe('редактор состава номенклатуры (Н10, Р15)', () => {
  const saved = {
    'PUT /service-requests/:id/consumables': () => json(consumableRequest('in_work', [line()])),
  };

  it('позиции подбираются по модели аппарата заявки, а единственная подставляется сама', async () => {
    const http = renderConsumablesModal(consumableRequest('in_work', []), saved);

    // Модель берётся у аппарата ЗАЯВКИ, а не спрашивается человеком: запрос ушёл с её `modelId`.
    await waitFor(() =>
      expect(http.lastCall('GET /office-equipment-consumables')?.query.get('modelId')).toBe(
        MODEL.id,
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Добавить позицию/ }));
    // Та самая подстановка: к модели подходит одна позиция, и выбирать её не из чего.
    await waitFor(() => expect(chosenConsumable()).toContain('Тонер Ricoh 201'));
    // Код и остаток стоят в подписи: заказывая четыре тонера, человек видит, что на складе их
    // четыре, а сверять со счётом будут по коду.
    expect(chosenConsumable()).toContain('Д0000093569');
    expect(chosenConsumable()).toContain('на складе 4');

    fireEvent.change(screen.getByLabelText('Сколько нужно'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/consumables')).toBe(1));
    const body = bodyOf(http, 'PUT /service-requests/:id/consumables');
    // Состав уходит списком целиком и с версией: ручка принимает предмет заявки, а не приращение.
    expect(body.items).toEqual([{ consumableId: 'oec-1', requestedQuantity: 2 }]);
    expect(body.version).toBe(3);
  });

  it('пустой список редактор не отпускает — в отличие от формы заведения (Р15)', async () => {
    const http = renderConsumablesModal(consumableRequest('in_work', []), saved);
    await screen.findByRole('button', { name: /Добавить позицию/ });

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Правило то же, что на сервере (`putServiceConsumablesSchema` держит `.min(1)`): сохранённый
    // пустой состав оставил бы заявку на расходники без предмета.
    expect(await screen.findByText('Добавьте хотя бы одну позицию')).toBeDefined();
    expect(http.countOf('PUT /service-requests/:id/consumables')).toBe(0);
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
      line({
        id: 'src-2',
        consumableId: FOREIGN.id,
        code: FOREIGN.code,
        name: FOREIGN.name,
        color: 'голубой',
        requestedQuantity: 1,
      }),
    ]);
    mockHttp({
      'GET /service-requests/:id': () => json(request),
      'GET /service-requests/:id/history': () => json([]),
    });
    renderWithUser(<ServiceRequestViewModal request={request} onClose={() => {}} />, {
      user: OPERATOR,
    });

    // У расходников вкладки «Объём работ» нет вовсе (Р17 переименовал «Смету»): предмет заявки —
    // либо объём работ, либо номенклатура, и двух списков предмета у одной заявки не бывает.
    fireEvent.click(await screen.findByRole('tab', { name: 'Номенклатура' }));
    expect(screen.queryByRole('tab', { name: 'Объём работ' })).toBeNull();

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
    // Объёма работ у расходников нет вовсе: согласовывать картридж со своего склада не с кем.
    expect(labels).not.toContain('Объём работ');
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
