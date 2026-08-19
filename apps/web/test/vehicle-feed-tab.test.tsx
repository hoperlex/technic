import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { VehicleDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  classification,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
  weeklyItem,
  weeklyRequest,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { PageTabs } from '../src/components/PageTabs';
import { VehicleRequestsPage } from '../src/pages/VehicleRequestsPage';

/**
 * Недельная заявка строкой общего списка «Заказ автотехники» (ADR 0085).
 *
 * Своей вкладки у документа больше нет: он основание над заказами, и человек решает им одну
 * задачу — «что у нас с техникой», — вместе с самими заказами. Проверяется поэтому не «строка
 * рисуется», а границы объединения: где недельная строка отвечает своим (состав, неделя, виза), а
 * где честно пуста (тип ТС, маршрут, файлы); куда ведёт клик по ней; и что уезжает на сервер, когда
 * фильтр и поиск спрашивают вид документа. Ошибка в любой из этих границ не падает тестом — она
 * показывает человеку заказ вместо недели или недельный документ в форме подбора заявок в рейс.
 */

const ORDER = vehicleRequest({ id: 'vr-1' });
const WEEKLY = weeklyRequest({
  items: [weeklyItem(), weeklyItem({ id: 'wi-2', kind: 'leave', sourceDisplayNumber: 'ТС-77' })],
});

/** Кто смотрит: штаб площадки — он и заводит недельную заявку, и читает список заказов. */
const SHTAB = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

/**
 * Справочник техники для фильтра «Вся техника» (ADR 0098): своя машина и арендная. Обе намеренно —
 * заявку закрывают и арендной, и искать по ней надо тем же полем.
 */
const OWN_VEHICLE = {
  id: 'v-own',
  ownership: 'own',
  description: '',
  registrationNumber: 'Е646СК799',
  modelName: 'КамАЗ 65115',
  typeName: 'Самосвалы',
  categoryName: null,
  lessorName: null,
} as VehicleDto;

const RENTAL_VEHICLE = {
  id: 'v-rent',
  ownership: 'rental',
  description: 'Автокран 70 тн',
  registrationNumber: null,
  modelName: null,
  typeName: 'Автокраны',
  categoryName: null,
  lessorName: 'ООО «Ромашка»',
} as VehicleDto;

/**
 * Две позиции классификатора для набора: категория одного типа и тип без категорий вовсе. Взяты
 * разные уровни намеренно — набор объединяет их по ИЛИ, и обе ветки отбора обязаны уехать одной
 * строкой.
 */
const CRANE = classification({
  key: 'vt-1:vc-1',
  vehicleTypeId: 'vt-1',
  vehicleCategoryId: 'vc-1',
  typeName: 'Автокраны',
  kindCode: 'special',
  kindName: 'Спецтехника',
  label: 'Автокраны, г/п 25 т',
});
const TIPPER = classification({
  key: 'vt-2:',
  vehicleTypeId: 'vt-2',
  vehicleCategoryId: null,
  typeName: 'Самосвалы',
  kindCode: 'freight',
  kindName: 'Грузовая техника',
  label: 'Самосвалы',
});

/** Справочник для тестов набора: по умолчанию лента отвечает одной безымянной позицией. */
const CLASSIFICATIONS: RouteMap = {
  'GET /vehicle-classifications': () => json(list([CRANE, TIPPER])),
};

/** Адрес после перехода: недельная строка обязана уводить со списка на страницу недели. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="path">{location.pathname}</div>;
}

function renderTab(over: RouteMap = {}, user = SHTAB, route = '/vehicle-requests'): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([ORDER], [WEEKLY])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1 })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    'GET /vehicles': () => json(list([OWN_VEHICLE, RENTAL_VEHICLE])),
    ...over,
  });
  // Вкладка рисуется внутри `PageTabs`: сводка живёт на их уровне (`TabsExtra`), и без обёртки
  // экран остался бы без единственной цифры, ради которой у недельных заявок была своя вкладка.
  renderWithUser(
    <>
      <PageTabs
        activeKey="requests"
        items={[{ key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> }]}
      />
      <LocationProbe />
    </>,
    { user, route },
  );
  return http;
}

/** Строка таблицы по номеру документа — искать её по индексу значило бы держаться за порядок. */
function rowOf(displayNumber: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('.ant-table-tbody tr.ant-table-row')];
  const found = rows.find((r) => r.textContent?.includes(displayNumber));
  expect(found, `строка ${displayNumber}`).toBeTruthy();
  return found!;
}

/** Ячейки строки по порядку колонок: №, заказчик, тип ТС, срок, техника, маршрут, статус, виза… */
function cells(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('td')];
}

/** Поле панели фильтров опознаётся подсказкой: подписи у фильтров нет, её место занимает placeholder. */
async function openFilter(placeholder: string) {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === placeholder,
    );
    if (!found) throw new Error(`фильтра «${placeholder}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

async function pickFilter(placeholder: string, option: string) {
  await openFilter(placeholder);
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(option),
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

/**
 * Отметить или снять вариант набора в уже открытом списке. В режиме `multiple` выпадашка после
 * выбора не закрывается, а поле перестаёт показывать подсказку — искать его по ней во второй раз
 * уже нечем; и снимают отметку тем же кликом по варианту, каким её ставили.
 */
async function toggleOption(option: string) {
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(option),
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

/**
 * Ввод в строку поиска и Enter. Отпускание клавиши обязательно: поле держит замок повторного
 * нажатия до `keyup` (`keyLockRef` в rc-input), и без него второй поиск подряд не случился бы —
 * ровно то, что делает человек, набирая номер за номером.
 */
function search(value: string) {
  const input = screen.getByPlaceholderText('Поиск по № (ТС-123, НЗ-12)');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  fireEvent.keyUp(input, { key: 'Enter', code: 'Enter', charCode: 13 });
}

describe('лента «Заказ автотехники»: недельная заявка строкой списка', () => {
  it('заказы и недельные заявки приходят одним запросом и стоят в одной таблице', async () => {
    const http = renderTab();

    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(screen.getByText('НЗ-12')).toBeDefined();
    // Один запрос, а не два склеенных на клиенте: страница и порядок ленты выбраны сервером.
    expect(http.countOf('GET /vehicle-requests/feed')).toBe(1);
    expect(http.countOf('GET /vehicle-requests')).toBe(0);
  });

  it('недельная строка отвечает своим, а колонки без соответствия оставляет пустыми', async () => {
    renderTab();
    await screen.findByText('НЗ-12');
    const row = cells(rowOf('НЗ-12'));

    // Автор документа стоит второй строкой к номеру — так же, как у заказа.
    expect(row[0]!.textContent).toContain('Штабов Ш. Ш.');
    expect(row[1]!.textContent).toContain('ЖК Северный');
    // Тип ТС — прочерк: позиции классификатора у недельного документа не бывает вовсе, и тега
    // вида здесь тоже нет — вид называет сам номер.
    expect(row[2]!.textContent).toBe('—');
    // Срок — подпись недели с сервера: второго понятия недели в портале нет.
    expect(row[3]!.textContent).toBe('17–23 августа 2026');
    // Техника — состав документа: строка на единицу, с решением по ней.
    expect(row[4]!.textContent).toContain('ТС-42');
    expect(row[4]!.textContent).toContain('Остаётся до 23.08.2026');
    expect(row[4]!.textContent).toContain('ТС-77');
    expect(row[4]!.textContent).toContain('Уезжает');
    // Маршрут — прочерк: рейсы заводятся по заказам, а не по документу-основанию.
    expect(row[5]!.textContent).toBe('—');
    expect(row[6]!.textContent).toBe('Ждёт визы');
    expect(row[7]!.textContent).toBe('Ждёт визы');
    // Файлы — прочерк: вложения носит заказ, а не решение по срокам.
    expect(row[10]!.textContent).toBe('—');
  });

  it('визой недельной заявки из строки не распоряжаются — кнопки в ячейке нет', async () => {
    // Виза недели той же транзакцией двигает сроки заказов: ставить её, не увидев состава,
    // нельзя. У заказа кнопка в этой же колонке есть — и это единственное отличие двух ячеек.
    renderTab({}, authUser({ role: 'rukstroy', constructionObjectIds: ['obj-1'] }));
    await screen.findByText('НЗ-12');

    expect(within(cells(rowOf('НЗ-12'))[7]!).queryByRole('button')).toBeNull();
    expect(within(cells(rowOf('Т-42'))[7]!).getByText('Согласовать')).toBeDefined();
  });

  it('клик по недельной строке уводит на страницу недели, а не открывает карточку заявки', async () => {
    renderTab();
    await screen.findByText('НЗ-12');

    fireEvent.click(within(rowOf('НЗ-12')).getByText('17–23 августа 2026'));

    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/vehicle-requests/weekly/wr-1'),
    );
    // Карточки заявки при этом не появилось: у недельного документа её нет — сборка живёт
    // отдельной страницей, и окно поверх списка означало бы второе место для того же документа.
    expect(document.querySelector('.ant-modal')).toBeNull();
  });

  it('«Тип заявки» третьим значением спрашивает вид документа, а не тип заявки', async () => {
    const http = renderTab();
    await screen.findByText('НЗ-12');

    await pickFilter('Все типы заявок', 'Недельная заявка');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      // Вид уходит своим параметром: `requestType` едет ещё и в тело заявки, где третьего
      // значения не существует.
      expect(call.query.get('kind')).toBe('weekly');
      expect(call.query.get('requestType')).toBeNull();
    });
  });

  it('фильтр «Неделя» показывается только при выбранном виде документа', async () => {
    const http = renderTab();
    await screen.findByText('НЗ-12');
    // До выбора вида недели в панели нет: у заказа её не бывает, и заданный фильтр отсекал бы
    // заказы целиком.
    expect(screen.queryByText('Все недели')).toBeNull();

    await pickFilter('Все типы заявок', 'Недельная заявка');
    await waitFor(() => expect(screen.getByText('Все недели')).toBeDefined());

    // Возврат к обычному типу снимает и неделю: невидимый фильтр продолжал бы сужать выдачу.
    await pickFilter('Недельная заявка', 'Техника');
    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('kind')).toBeNull();
      expect(call.query.get('weekStart')).toBeNull();
    });
    expect(screen.queryByText('Все недели')).toBeNull();
  });

  it('поиск по номеру уходит парой «вид документа + номер»', async () => {
    const http = renderTab();
    await screen.findByText('НЗ-12');

    search('НЗ-12');
    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('num')).toBe('12');
      expect(call.query.get('kind')).toBe('weekly');
    });

    // «ТС-341» ищет заказ и с недельного вида уводит: номер заказа сам говорит, что показать.
    search('ТС-341');
    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('num')).toBe('341');
      expect(call.query.get('kind')).toBeNull();
    });

    // Пустой ввод снимает только номер: «не ищу конкретный документ» — не «покажи всё подряд».
    search('');
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('num')).toBeNull(),
    );
  });

  it('старый адрес вкладки недельных открывает список уже суженным до них', async () => {
    // `?tab=weekly` переведён страницей раздела на `?tab=requests&kind=weekly`: закладка на
    // исчезнувшую вкладку обязана вести к тому же, что показывала она.
    const http = renderTab({}, SHTAB, '/vehicle-requests?tab=requests&kind=weekly');

    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('kind')).toBe('weekly'),
    );
  });

  it('раздел уводит с исчезнувшей вкладки на список, а не сбрасывает вид документа', async () => {
    // Вся цепочка целиком: адрес `?tab=weekly` — переход раздела — первый запрос ленты. Сделай
    // раздел этот переход эффектом после отрисовки, и список успел бы запомнить «все виды»: вид
    // читается из адреса ровно один раз, при первом состоянии фильтров.
    const http = mockHttp({
      'GET /vehicle-requests/feed': () => json(vehicleFeed([ORDER], [WEEKLY])),
      'GET /vehicle-requests/summary': () => json(vehicleSummary()),
      'GET /vehicle-requests/history': () => json(emptyList()),
      'GET /vehicle-requests/history/summary': () =>
        json({ total: 0, done: 0, cancelled: 0, totalCost: 0, withoutCost: 0 }),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(list([classification()])),
      'GET /vehicles': () => json(list([OWN_VEHICLE, RENTAL_VEHICLE])),
      'GET /counterparties': () => json(emptyList()),
    });
    renderWithUser(<VehicleRequestsPage />, {
      user: SHTAB,
      route: '/vehicle-requests?tab=weekly',
    });

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed');
      expect(call, 'запрос ленты').toBeTruthy();
      expect(call!.query.get('kind')).toBe('weekly');
    });
    // Вкладки «Недельные заявки» на экране больше нет: документ живёт строкой общего списка.
    expect(screen.queryByText('Недельные заявки')).toBeNull();
  });

  it('в сводке появляется очередь визы недельных — цифра бывшей вкладки', async () => {
    renderTab();
    await screen.findByText('НЗ-12');

    // Подпись и число — соседние узлы одной строки сводки, поэтому читается их общий родитель.
    const counter = screen.getByText('Недельных ждут визы:').parentElement;
    await waitFor(() => expect(counter?.textContent?.trim()).toBe('Недельных ждут визы: 1'));
  });

  it('фильтр техники спрашивает машину: выбор уходит параметром vehicleId и в список, и в сводку', async () => {
    // Жалоба, с которой начался ADR 0098: подсказка «Вся техника» отбирала по типам, а в соседних
    // списках раздела та же подсказка означает конкретную машину.
    const http = renderTab();
    await screen.findByText('Т-42');
    expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('vehicleId')).toBeNull();

    await pickFilter('Вся техника', 'Е646СК799 — КамАЗ 65115');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('vehicleId')).toBe('v-own');
      // Отбор по машине — не отбор по типу: классификатор своим параметром не уезжает.
      expect(call.query.get('vehicleTypeId')).toBeNull();
      // Список возвращается на первую страницу: та же страница при другом отборе — другие заявки.
      expect(call.query.get('page')).toBe('1');
    });
    // Сводка считает по тому же отбору, что видно в таблице: цифры про другой список сбивают вернее,
    // чем их отсутствие.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/summary')!.query.get('vehicleId')).toBe('v-own'),
    );
  });

  it('машина в списке подбора названа парой примет — как она представлена в справочнике техники', async () => {
    renderTab();
    await screen.findByText('Т-42');

    await openFilter('Вся техника');

    // У своей машины пара — «Госномер» и «Марка/модель», у аренды госномера не бывает вовсе
    // (ADR 0018) и на его месте стоит арендодатель, с которым и договаривались.
    expect(await screen.findByText('Е646СК799 — КамАЗ 65115')).toBeDefined();
    expect(screen.getByText('Автокран 70 тн — ООО «Ромашка»')).toBeDefined();
  });

  it('подсказки двух фильтров техники не спорят: тип называется типом, машина — техникой', async () => {
    renderTab();
    await screen.findByText('Т-42');

    // Фильтр классификатора больше не обещает «Всю технику»: этими словами в разделе называют
    // единицу парка, и одна подсказка на два разных вопроса читалась бы как поломка (ADR 0098).
    expect(screen.getByText('Любой тип ТС')).toBeDefined();
    expect(screen.getByText('Вся техника')).toBeDefined();
  });

  it('кнопка «Заявка на неделю» стоит по праву заведения, а не по показу недельных строк', async () => {
    renderTab();
    expect(await screen.findByText('НЗ-12')).toBeDefined();
    expect(screen.getByRole('button', { name: /Заявка на неделю/ })).toBeDefined();

    // Наблюдатель недельные заявки видит (сквозной просмотр), но не заводит ни одной — кнопки у
    // него нет вовсе: выключенная читалась бы как «сейчас нельзя», а нельзя ему всегда.
    document.body.innerHTML = '';
    renderTab({}, authUser({ role: 'observer' }));
    expect(await screen.findByText('НЗ-12')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Заявка на неделю/ })).toBeNull();
  });
});

/**
 * Набор позиций в фильтре техники (план `docs/vehicle-type-multi-filter-plan.md`).
 *
 * Проверяется не «поле стало множественным», а то, чем набор отличается от прежнего одиночного
 * выбора на проводе: несколько позиций уезжают одним параметром и одной канонической строкой,
 * снятая позиция не уносит с собой соседнюю, пустой набор не оставляет параметра вовсе, а сводка
 * над лентой считает по тому же набору, что показывает таблица. Разойдись любое из этого —
 * человек видит цифры про один список над строками другого либо получает два запроса за один
 * и тот же вопрос.
 */
describe('лента «Заказ автотехники»: набор позиций в фильтре техники', () => {
  it('две выбранные позиции уезжают одним параметром — и в ленту, и в сводку', async () => {
    const http = renderTab(CLASSIFICATIONS);
    await screen.findByText('Т-42');
    expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('classifications')).toBeNull();

    await openFilter('Любой тип ТС');
    await toggleOption('Автокраны, г/п 25 т');
    await toggleOption('Самосвалы');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      // Ключи самодостаточны: `c` — категория, `t` — тип целиком; обе ветки в одной строке.
      expect(call.query.get('classifications')).toBe('cvc-1,tvt-2');
      // Старая пара полей на провод не выходит: технику задаёт один параметр, а не два способа.
      expect(call.query.get('vehicleTypeId')).toBeNull();
      expect(call.query.get('vehicleCategoryId')).toBeNull();
      // Другой отбор — другие заявки: список возвращается на первую страницу.
      expect(call.query.get('page')).toBe('1');
    });
    // Сводка считается по той же выборке, что видно в таблице.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/summary')!.query.get('classifications')).toBe(
        'cvc-1,tvt-2',
      ),
    );
  });

  it('снятая позиция оставляет вторую, а снятые обе убирают параметр из запроса', async () => {
    const http = renderTab(CLASSIFICATIONS);
    await screen.findByText('Т-42');

    await openFilter('Любой тип ТС');
    await toggleOption('Автокраны, г/п 25 т');
    await toggleOption('Самосвалы');
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('classifications')).toBe(
        'cvc-1,tvt-2',
      ),
    );

    await toggleOption('Самосвалы');
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('classifications')).toBe(
        'cvc-1',
      ),
    );

    await toggleOption('Автокраны, г/п 25 т');
    // Пустой набор — это «фильтра нет»: пустая строка означала бы то же самое, но уехала бы
    // третьим ключом кэша за тем же списком.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('classifications')).toBeNull(),
    );
  });

  it('порядок кликов не меняет строку запроса', async () => {
    const http = renderTab(CLASSIFICATIONS);
    await screen.findByText('Т-42');

    await openFilter('Любой тип ТС');
    await toggleOption('Самосвалы');
    await toggleOption('Автокраны, г/п 25 т');

    // Та же строка, что и при обратном порядке выше: сортируется сам ключ, а не порядок кликов и
    // не порядок вариантов справочника, — иначе один вопрос давал бы два ключа кэша и два запроса.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('classifications')).toBe(
        'cvc-1,tvt-2',
      ),
    );
  });
});
