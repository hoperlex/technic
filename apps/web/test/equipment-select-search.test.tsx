import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Поиск техники в форме заявки на обслуживание идёт НА СЕРВЕРЕ (план кандидата, Ф1).
 *
 * До перевода поле забирало одну страницу справочника и резало её на клиенте по подписи — и оба
 * следствия были дефектами, которые ловятся только отсюда. Подпись печатает один номер из двух
 * (`officeEquipmentTitle`), поэтому серийный номер карточки с инвентарным не находился вовсе:
 * человек видел «ничего не нашлось» про технику, которая в справочнике стоит. А парк больше
 * страницы в неё просто не помещался, и та же надпись означала «не поместилось».
 *
 * Проверяется здесь именно механизм, а не текст: набранное обязано уйти параметром запроса
 * (мок отбирает так же, как сервер, — по модели, обоим номерам и месту), выбранная единица —
 * остаться подписанной после следующего запроса, а «единственный найденный» — не подставляться в
 * поле за человека, пока он ещё набирает номер.
 */

function equipmentDto(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'oet-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: 'SN-7770001',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
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
    ...over,
  };
}

/**
 * Парк из трёх единиц. Три, а не одна: с единственным вариантом поле заполнило бы себя само
 * (`AutoSelect`), и проверки «набранное ушло на сервер» и «единственный найденный не
 * подставляется» проходили бы независимо от того, работает механизм или нет.
 *
 * У всех трёх заполнен инвентарный номер — именно он и печатается в подписи. Серийный в подпись не
 * попадает, и клиентский фильтр по подписи не нашёл бы по нему ничего: на этом и держится первая
 * проверка.
 */
const KYOCERA = equipmentDto();
const BROTHER = equipmentDto({
  id: 'oe-2',
  name: 'Brother HL-1110R',
  serialNumber: 'SN-8880002',
  inventoryNumber: '0012346',
  location: 'Корпус 1, каб. 105',
});
const CANON = equipmentDto({
  id: 'oe-3',
  name: 'Canon i-SENSYS',
  serialNumber: 'SN-9990003',
  inventoryNumber: '0012347',
  location: '',
});

/** Подпись портала — та же, что собирает `officeEquipmentTitle`: по ней единицу и ищут глазами. */
const KYOCERA_TITLE = 'Kyocera M3145 · инв. 0012345';
const BROTHER_TITLE = 'Brother HL-1110R · инв. 0012346';

/**
 * Отбор — как на сервере (`searchCondition`): по модели, обоим номерам и месту разом. Мок обязан
 * искать именно так, иначе тест проверял бы не перевод поиска на сервер, а собственную выдумку.
 */
function search(units: OfficeEquipmentDto[], term: string | null): OfficeEquipmentDto[] {
  if (!term) return units;
  const needle = term.toLocaleLowerCase('ru');
  return units.filter((u) =>
    [u.name, u.serialNumber, u.inventoryNumber, u.location].some((field) =>
      field.toLocaleLowerCase('ru').includes(needle),
    ),
  );
}

/** Заявитель со своей площадкой: справочник ему открыт, технику он и выбирает. */
const CUSTOMER: AuthUser = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

function renderForm(units: OfficeEquipmentDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': ({ query }) => json(list(search(units, query.get('search')))),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<ServiceRequestForm open request={null} onClose={() => {}} />, { user: CUSTOMER });
  return http;
}

/** Поле «Какой аппарат» целиком: у формы селектов несколько, и искать надо в своём. */
const equipmentField = (): HTMLElement =>
  document.getElementById('officeEquipmentId')!.closest('.ant-select') as HTMLElement;

/** Что стоит В ПОЛЕ (не в списке): подпись выбранного варианта. `null` — поле пусто. */
const chosenEquipment = (): string | null =>
  equipmentField().querySelector('.ant-select-content')?.getAttribute('title') ?? null;

/** Набрать в поле техники — так же, как это делает человек: открыть список и печатать. */
function typeEquipment(text: string): void {
  const input = document.getElementById('officeEquipmentId') as HTMLInputElement;
  fireEvent.mouseDown(equipmentField().querySelector('.ant-select-selector') ?? equipmentField());
  fireEvent.change(input, { target: { value: text } });
}

/** Выпадашка поля техники: закрытые списки соседних полей остаются в разметке. */
const equipmentDropdown = (): HTMLElement => {
  const options = document.getElementById('officeEquipmentId_list')!;
  return (options.closest('.ant-select-dropdown') ?? options.parentElement!) as HTMLElement;
};

/** Что предлагает список поля техники — подписями вариантов. */
const offered = (): string[] =>
  [...equipmentDropdown().querySelectorAll('.ant-select-item-option-content')].map(
    (el) => el.textContent ?? '',
  );

/** Параметры последнего обращения к справочнику: ими и проверяется, что искал сервер. */
const lastQuery = (http: HttpMock): URLSearchParams =>
  http.lastCall('GET /office-equipment')!.query;

describe('поиск техники в заявке идёт на сервере (Ф1)', () => {
  it('серийный номер уходит параметром запроса и находит карточку с инвентарным', async () => {
    const http = renderForm([KYOCERA, BROTHER, CANON]);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));
    // Страница выдачи — полсотни строк, а не весь справочник: длинный список человек всё равно
    // доуточняет набором, а «не поместилось» читалось бы как «в справочнике нет».
    expect(lastQuery(http).get('pageSize')).toBe('50');
    // Только действующие: списанную единицу в заявку не выбирают.
    expect(lastQuery(http).get('isActive')).toBe('true');

    typeEquipment('SN-7770001');

    // Главное: набранное ушло ВОПРОСОМ К СЕРВЕРУ. Останься отбор на клиенте, запроса бы не было
    // вовсе — и поиск разбирал бы одну загруженную страницу.
    await waitFor(() => expect(lastQuery(http).get('search')).toBe('SN-7770001'));
    await waitFor(() => expect(offered()).toEqual([KYOCERA_TITLE]));
    // И это ровно тот случай, которого клиентский фильтр не умел: серийного номера в подписи нет,
    // а искали именно по нему.
    expect(KYOCERA_TITLE).not.toContain('SN-7770001');
  });

  it('ищет и по месту: «принтер в 105-м» — законный способ назвать аппарат', async () => {
    const http = renderForm([KYOCERA, BROTHER, CANON]);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));

    typeEquipment('каб. 105');

    await waitFor(() => expect(lastQuery(http).get('search')).toBe('каб. 105'));
    await waitFor(() => expect(offered()).toEqual([BROTHER_TITLE]));
  });
});

describe('выбранная единица переживает следующий запрос', () => {
  it('остаётся подписанной и с реквизитами, когда новая выдача её не содержит', async () => {
    const http = renderForm([KYOCERA, BROTHER, CANON]);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));

    typeEquipment('SN-7770001');
    await waitFor(() => expect(offered()).toEqual([KYOCERA_TITLE]));
    fireEvent.click(await within(equipmentDropdown()).findByText(KYOCERA_TITLE));
    expect(chosenEquipment()).toBe(KYOCERA_TITLE);
    // Реквизиты предмета (Р48) — то, что уйдёт в заявку снимком.
    expect(await screen.findByText('сер. № SN-7770001')).toBeDefined();

    // Человек ищет дальше — и выдача сменилась на чужую единицу.
    typeEquipment('0012346');
    await waitFor(() => expect(lastQuery(http).get('search')).toBe('0012346'));
    await waitFor(() => expect(offered()).toContain(BROTHER_TITLE));

    // Выбранное осталось выбранным и подписанным: без памяти выбранного в поле стояла бы строка
    // идентификатора, а реквизиты под ним пропали бы — на глазах у человека, который ничего не
    // менял.
    expect(chosenEquipment()).toBe(KYOCERA_TITLE);
    expect(screen.getByText('сер. № SN-7770001')).toBeDefined();
    // Выбранная дописана и к самому списку: `Select` подписывает значение только вариантом.
    expect(offered()).toContain(KYOCERA_TITLE);
  });
});

describe('автоподстановка единственного варианта', () => {
  it('на выдаче поиска не срабатывает: «единственный найденный» — не «единственный в парке»', async () => {
    const http = renderForm([KYOCERA, BROTHER, CANON]);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));
    expect(chosenEquipment()).toBeNull();

    // Две цифры инвентарного, по которым нашлась ровно одна единица, — обычная середина набора.
    typeEquipment('0012346');
    await waitFor(() => expect(lastQuery(http).get('search')).toBe('0012346'));
    await waitFor(() => expect(offered()).toEqual([BROTHER_TITLE]));

    // Поле молчит: подставь оно найденное, человек дописал бы номер до конца уже с выбранным
    // чужим аппаратом — и заметил бы это в лучшем случае при отправке.
    expect(chosenEquipment()).toBeNull();
  });

  it('на нетронутой выдаче остаётся: единственная единица парка выбирается сама', async () => {
    // Различие содержательное, и держится оно тестом. Пока ничего не набрано, единственный
    // вариант означает единственную единицу справочника — за такой подстановкой `AutoSelect` и
    // заведён, и снимать её вместе с ловушкой поиска значило бы чинить не то.
    const http = renderForm([KYOCERA]);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));

    await waitFor(() => expect(chosenEquipment()).toBe(KYOCERA_TITLE));
  });
});
