import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehiclePartsSpendDto,
  VehiclePartsSpendSnapshotDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { VehiclePartsSpendBlock } from '../src/features/vehicle-parts-spend';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Запчасти по машине: колонка «Запчасти, ₽» вкладки «Техника», окно «Запчасти машины» и блок
 * карточки машины (план `docs/auto-part-receipts-plan.md`, Р5, Р14—Р16).
 *
 * Проверяется ровно то, за что эти три экрана отвечают.
 *
 * **Запрос один на страницу** (Р14). Приём тот же, что у колонки «ТО»: полсотни запросов из строк
 * открывали бы срез дня заметно дольше — счёт запросов здесь такая же часть поведения, как
 * показанное число.
 *
 * **День среза уходит в `to`** (Р14): срез марта, показавший августовскую покупку, отвечал бы не
 * на тот вопрос, который задали календарём наверху.
 *
 * **Пусто — прочерк, а не «0 ₽»** (Р14, §8): машина, на которую не тратили, и машина, по которой
 * чеков ещё не завели, — одно и то же незнание, а ноль был бы утверждением.
 *
 * **Право — на гараж, а не на показания** (Р5): «сколько вложено в эту машину» спрашивает всякий,
 * кому виден гараж, — и у механика, которому одометр не виден вовсе, колонка стоит ровно такая же.
 *
 * **Обе цифры блока — из одного ответа** (Р16): «за период» и «всего» стоят рядом и читаются как
 * одно утверждение, а вторым запросом они стали бы парой снимков, снятых в разные моменты.
 */

const SNAPSHOT = 'GET /auto-part-receipts/vehicles/snapshot';
const SPEND = 'GET /auto-part-receipts/vehicles/:vehicleId';
/**
 * Тот же ответ, но точным адресом машины: считать вызовы по шаблону `:vehicleId` нельзя — он
 * накрывает и соседний `/vehicles/snapshot`, и «сколько раз спросили окно» вышло бы на единицу
 * больше правды.
 */
const SPEND_V1 = 'GET /auto-part-receipts/vehicles/v1';
const MAINTENANCE_SNAPSHOT = 'GET /vehicle-maintenance/snapshot';

const ON_DATE = '2026-07-24';

/** Строка среза плюс состояние показаний: сервер отдаёт его вместе с колонкой (ADR 0103, Р27). */
type Row = GarageVehicleDto & { readingState: string };

function vehicle(id: string, label: string): Row {
  return {
    id,
    label,
    state: 'free',
    status: 'active',
    registrationNumber: label,
    garageNumber: '',
    modelName: null,
    vehicleTypeId: 'vt-1',
    typeName: 'Самосвалы',
    vehicleCategoryId: null,
    categoryName: null,
    drivers: [],
    busy: [],
    readingState: 'reported',
    lastOdometer: null,
  };
}

const FIRST = vehicle('v1', 'Е646СК799');
const SECOND = vehicle('v2', 'В010ОР799');

const GARAGE_SUMMARY: GarageVehiclesSummaryDto = {
  total: 2,
  free: 2,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

/** Суммы пакетом: машина без покупок в ответе просто не приходит (§6). */
const SPENT: VehiclePartsSpendSnapshotDto = {
  vehicleId: 'v1',
  total: 12300,
  receiptsCount: 2,
  lastPurchasedOn: '2026-07-18',
};

/** Окно машины: реквизиты чека приходят вместе со строкой — добора шапки нет (§6). */
const SPEND_DTO: VehiclePartsSpendDto = {
  vehicleId: 'v1',
  vehicleLabel: 'Е646СК799',
  total: 12300,
  totalAllTime: 90000,
  rows: [
    {
      receiptId: 'r-1',
      purchasedOn: '2026-07-18',
      sellerName: 'ООО «Автодеталь»',
      documentNumber: '214',
      lineId: 'l-1',
      name: 'Фильтр масляный 2101-1012005',
      quantity: 2,
      unit: 'шт',
      amount: 12300,
    },
  ],
};

function renderPage(options: {
  rows?: Row[];
  items?: VehiclePartsSpendSnapshotDto[];
  user?: ReturnType<typeof authUser>;
  viewport?: Viewport;
  route?: string;
}): HttpMock {
  const rows = options.rows ?? [FIRST, SECOND];
  const list: GarageVehicleListDto = {
    items: rows,
    total: rows.length,
    page: 1,
    pageSize: 50,
    onDate: ON_DATE,
  };
  const http = mockHttp({
    'GET /garage/vehicles': () => json(list),
    'GET /garage/vehicles/summary': () => json(GARAGE_SUMMARY),
    'GET /garage/drivers': () => json(emptyList()),
    'GET /garage/drivers/summary': () =>
      json({ ...GARAGE_SUMMARY, assigned: 0, documentsIncomplete: 0 }),
    'GET /vehicle-classifications': () => json(emptyList()),
    // Справочник площадок наполняет фильтр отбора по объекту — своих строк среза он не даёт.
    'GET /objects': () => json(emptyList()),
    // Соседняя колонка «ТО»: своё право, свой пакет (ADR 0110). Спрашивают с неё свои тесты.
    [MAINTENANCE_SNAPSHOT]: ({ query }) => json({ on: query.get('on') ?? '', items: [] }),
    // День в ответе — тот, который спросили: по нему видно, что колонка отвечает про срез (Р14).
    [SNAPSHOT]: ({ query }) => json({ to: query.get('to') ?? '', items: options.items ?? [SPENT] }),
    [SPEND]: () => json(SPEND_DTO),
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    {
      user: options.user,
      viewport: options.viewport,
      route: options.route ?? `/garage?tab=vehicles&date=${ON_DATE}`,
    },
  );
  return http;
}

/** Адрес страницы: окно «Запчасти машины» живёт в нём, и присланная ссылка обязана его открыть. */
function AddressProbe() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

const address = () => screen.getByTestId('address').textContent ?? '';

/** Строка таблицы по госномеру: в ней и спрашивают про колонку. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement;
}

describe('гараж: колонка «Запчасти, ₽»', () => {
  it('спрашивает суммы одним запросом на страницу, а не по строке', async () => {
    const http = renderPage({});

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const call = http.lastCall(SNAPSHOT)!;
    // Две машины — один запрос: строка, спрашивающая за себя, стоила бы срезу дня полсотни ответов.
    expect(call.query.get('ids')).toBe('v1,v2');
    // День среза, а не сегодняшний день браузера (Р14).
    expect(call.query.get('to')).toBe(ON_DATE);
    // Окно машины при этом не спрашивается: его грузит само окно, а не колонка.
    expect(http.countOf(SPEND_V1)).toBe(0);
  });

  it('показывает сумму и дату последней покупки', async () => {
    const http = renderPage({});
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const cells = row('Е646СК799');
    expect(await within(cells).findByText('12 300,00 ₽')).toBeDefined();
    // Дата обязательна рядом с числом: сумма без неё читается как свежая.
    expect(within(cells).getByText('18.07.2026')).toBeDefined();
  });

  it('машина без покупок молчит прочерком, а не нулём', async () => {
    const http = renderPage({});
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const cells = row('В010ОР799');
    await waitFor(() => expect(within(cells).getAllByText('—').length).toBeGreaterThan(0));
    // Ноль был бы утверждением «на машину не тратили», а это другое знание (Р14).
    expect(within(cells).queryByText('0,00 ₽')).toBeNull();
  });

  it('стоит и у механика, которому показания не видны', async () => {
    // Право на суммы — `garage.read` и только оно (Р5): механик читает их наравне с диспетчером,
    // хотя цифр приборов не видит вовсе.
    const http = renderPage({ user: authUser({ role: 'mechanic' }) });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));
    expect(await within(row('Е646СК799')).findByText('12 300,00 ₽')).toBeDefined();
    // Одометр при этом остаётся закрытым: у среза дня своё право, у показаний своё.
    expect(screen.queryAllByText('Одометр')).toHaveLength(0);
  });

  it('на телефоне сумма читается строкой карточки', async () => {
    const http = renderPage({ viewport: MOBILE_VIEWPORT });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    expect(await screen.findByText('запчасти: 12 300,00 ₽ (18.07.2026)')).toBeDefined();
  });
});

describe('гараж: окно «Запчасти машины»', () => {
  it('открывается нажатием на сумму и называется в адресе', async () => {
    const http = renderPage({});
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    fireEvent.click(await within(row('Е646СК799')).findByText('12 300,00 ₽'));

    expect(await screen.findByText('Запчасти — Е646СК799')).toBeDefined();
    // Ради этого окно и живёт в адресе: ссылку отправляют коллеге, а перезагрузка её не теряет.
    expect(address()).toContain('spend=v1');
    // Перечень грузится своей ручкой — не той, что заполняла колонку.
    await waitFor(() => expect(http.countOf(SPEND_V1)).toBe(1));
    expect(http.lastCall(SPEND_V1)!.path).toBe('/auto-part-receipts/vehicles/v1');
    // Окно открывается тем же днём среза, каким посчитана сумма в ячейке.
    expect(http.lastCall(SPEND_V1)!.query.get('to')).toBe(ON_DATE);
  });

  it('открывается прямо из адреса и показывает строки с их чеками', async () => {
    const http = renderPage({ route: `/garage?tab=vehicles&date=${ON_DATE}&spend=v1` });

    expect(await screen.findByText('Запчасти — Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SPEND_V1)).toBe(1));

    // Итог сверху — с сервера, а не сумма показанных строк (Р11): оба числа приходят одним ответом.
    expect(screen.getByText('90 000,00 ₽')).toBeDefined();
    expect(screen.getByText('ООО «Автодеталь»')).toBeDefined();
    expect(screen.getByText('Фильтр масляный 2101-1012005')).toBeDefined();
    expect(screen.getByText('2 шт')).toBeDefined();

    /*
     * Строка ведёт в карточку чека — и ведёт на ту вкладку, где карточка живёт (§8): ключ
     * `?receipt=` читает «Автозапчасти», и оставленный `?tab=vehicles` открыл бы адрес, на который
     * никто не отвечает.
     */
    const link = screen.getByTitle('Открыть карточку чека');
    expect(link.getAttribute('href')).toContain('tab=parts');
    expect(link.getAttribute('href')).toContain('receipt=r-1');
  });
});

describe('карточка машины: блок «Автозапчасти»', () => {
  function renderBlock(user?: ReturnType<typeof authUser>): HttpMock {
    const http = mockHttp({ [SPEND]: () => json(SPEND_DTO) });
    renderWithUser(
      <VehiclePartsSpendBlock vehicleId="v1" from="2026-07-01" to={ON_DATE} href="?spend=v1" />,
      { user },
    );
    return http;
  }

  it('показывает обе цифры и берёт их одним ответом', async () => {
    const http = renderBlock();

    expect(await screen.findByText('Автозапчасти')).toBeDefined();
    // «За период» отвечает на вопрос карточки, «всего» не даёт прочитать её как всю правду.
    expect(screen.getByText('12 300,00 ₽')).toBeDefined();
    expect(screen.getByText('90 000,00 ₽')).toBeDefined();
    // Один запрос на обе цифры: вторым они стали бы парой снимков, снятых в разные моменты (Р16).
    expect(http.countOf(SPEND_V1)).toBe(1);
    const call = http.lastCall(SPEND_V1)!;
    expect(call.query.get('from')).toBe('2026-07-01');
    expect(call.query.get('to')).toBe(ON_DATE);
  });

  it('без права на гараж не рисуется и ничего не запрашивает', async () => {
    // Штаб ведёт заявки объекта, и гараж ему не виден вовсе: заглушка «данных нет» на месте блока
    // отвечала бы за чужую ручку (Р16).
    const http = renderBlock(authUser({ role: 'shtab' }));

    await waitFor(() => expect(http.countOf(SPEND_V1)).toBe(0));
    expect(screen.queryByText('Автозапчасти')).toBeNull();
  });
});
