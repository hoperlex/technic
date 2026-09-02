import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { maintenanceSummary } from './factories/maintenance';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Техника»: колонка «ТО» и вход механика в сводку обслуживания (план «Показания
 * техники», Р12—Р16, Р24, Р14в).
 *
 * Проверяется ровно то, за что колонка отвечает на портале.
 *
 * **Запрос один на страницу.** Расчёт пробега с обслуживания идёт по цепочке показаний, и полсотни
 * запросов из строк открывали бы срез дня заметно дольше — счёт запросов здесь такая же часть
 * поведения, как показанный текст.
 *
 * **День среза уходит в `on` (Р16).** Срез марта, показавший майское ТО, отвечал бы не на тот
 * вопрос, который задали календарём наверху.
 *
 * **Незнание и «не ведём» — разные вещи (Р11в, Р13).** `not_tracked` — норма справочника и
 * молчаливый прочерк; `unknown` — повод разобраться, и он объяснён словами: «неизвестно» без
 * объяснения читается как поломка портала.
 *
 * **Право своё (Р14).** Без `vehicleMaintenance.read` нет ни колонки, ни запроса — не «столбец
 * прочерков», который означал бы «обслуживания за парком не числится». А у механика всё наоборот:
 * колонка ТО есть, одометра и вкладки «Показания» нет вовсе, и строка гаража — его единственный
 * вход в журнал обслуживания (Р14в).
 */

const SNAPSHOT = 'GET /vehicle-maintenance/snapshot';
const SUMMARY = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';

const ON_DATE = '2026-07-24';

/** Строка среза плюс состояние показаний: сервер отдаёт его вместе с колонкой (ADR 0103, Р27). */
type Row = GarageVehicleDto & { readingState: string };

function vehicle(overrides: Partial<Row> & Pick<Row, 'id' | 'label'>): Row {
  return {
    state: 'free',
    status: 'active',
    registrationNumber: overrides.label,
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
    ...overrides,
  };
}

const FIRST = vehicle({ id: 'v1', label: 'Е646СК799' });
const SECOND = vehicle({ id: 'v2', label: 'В010ОР799' });

const GARAGE_SUMMARY: GarageVehiclesSummaryDto = {
  total: 2,
  free: 2,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

/** Сводка машины в пакетном ответе: состояние считает та же функция, что и сервер (Р24). */
function summaryFor(
  row: Row,
  overrides: Partial<VehicleMaintenanceSummaryDto> = {},
): VehicleMaintenanceSummaryDto {
  return maintenanceSummary({ vehicleId: row.id, vehicleLabel: row.label, ...overrides });
}

function renderPage(options: {
  rows: Row[];
  summaries?: VehicleMaintenanceSummaryDto[];
  user?: ReturnType<typeof authUser>;
  viewport?: Viewport;
  route?: string;
}): HttpMock {
  const list: GarageVehicleListDto = {
    items: options.rows,
    total: options.rows.length,
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
    // День в ответе — тот, который спросили: по нему видно, что колонка отвечает про срез (Р16).
    [SNAPSHOT]: ({ query }) =>
      json({
        on: query.get('on') ?? '',
        items: options.summaries ?? options.rows.map((r) => summaryFor(r)),
      }),
    [SUMMARY]: ({ params }) =>
      json(summaryFor(options.rows.find((r) => r.id === params.vehicleId) ?? FIRST)),
    [HISTORY]: () => json({ items: [] }),
    // Соседняя колонка «Запчасти, ₽» спрашивает суммы своим пакетом (план чеков, Р14): права на
    // ТО она не требует и стоит даже у механика, поэтому ответ нужен во всех этих сценариях.
    'GET /auto-part-receipts/vehicles/snapshot': ({ query }) =>
      json({ to: query.get('to') ?? '', items: [] }),
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

/** Адрес и шаг назад по истории: окно сводки живёт в адресе, и «назад» обязано его закрыть. */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Шаг назад</button>
    </>
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';

/** Строка таблицы по госномеру: в ней и спрашивают про колонку ТО. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement;
}

describe('гараж: колонка ТО', () => {
  it('спрашивает состояние одним запросом на страницу, а не по строке', async () => {
    const http = renderPage({ rows: [FIRST, SECOND] });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    // Две машины — один запрос: расчёт пробега с ТО идёт по цепочке показаний, и строка,
    // спрашивающая за себя, стоила бы срезу дня полсотни запросов.
    const call = http.lastCall(SNAPSHOT)!;
    expect(call.query.get('ids')).toBe('v1,v2');
    // День среза, а не сегодняшний день браузера (Р16).
    expect(call.query.get('on')).toBe(ON_DATE);
    // Сводка одной машины при этом не спрашивается: её грузит окно, а не колонка.
    expect(http.countOf(SUMMARY)).toBe(0);
  });

  it('показывает состояние и дату последнего акта', async () => {
    const http = renderPage({ rows: [FIRST] });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    expect(screen.getAllByText('ТО').length).toBeGreaterThan(0);
    expect(await within(row('Е646СК799')).findByText('в норме')).toBeDefined();
    // Дата акта — с годом: последнее обслуживание бывает и прошлогодним.
    expect(within(row('Е646СК799')).getByText('10.06.2026')).toBeDefined();
  });

  it('просрочку показывает тревожно', async () => {
    // Норматив пройден (Р12): цвет берётся из контрактного словаря, второй формулы на портале нет.
    const http = renderPage({ rows: [FIRST], summaries: [summaryFor(FIRST, { kmSince: 10200 })] });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const tag = await within(row('Е646СК799')).findByText('просрочено');
    expect(tag.className).toContain('ant-tag-red');
    // Почему просрочено — тут же, подсказкой: в колонку объяснение не помещается.
    expect(within(row('Е646СК799')).getByTitle(/Норматив 10 000 км пройден/u)).toBeDefined();
  });

  it('тип техники без ТО молчит прочерком, а не тревогой', async () => {
    const http = renderPage({
      rows: [FIRST],
      summaries: [
        summaryFor(FIRST, { maintenanceBasis: 'none', kmSince: null, lastMaintenance: null }),
      ],
    });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const cells = row('Е646СК799');
    await waitFor(() => expect(within(cells).getAllByText('—').length).toBeGreaterThan(0));
    // «Не ведём» — норма справочника (Р13): тег в каждой строке легковых и прицепов кричал бы о
    // том, о чём вопроса нет. И с «не знаем» это путать нельзя.
    expect(within(cells).queryByText('не ведётся')).toBeNull();
    expect(within(cells).queryByText('неизвестно')).toBeNull();
    // Молчит, но не отмалчивается: почему прочерк — объясняет подсказка самого прочерка.
    expect(within(cells).getByTitle(/ТО по пробегу не ведётся/u)).toBeDefined();
    // Спрашивать нечего — входа в сводку у такой строки тоже нет.
    expect(within(cells).queryByText('сводка')).toBeNull();
  });

  it('незнание помечено и объяснено словами', async () => {
    // Та же цифра, что у «скоро ТО», но со сброшенным счётчиком: своя формула на портале ответила
    // бы «скоро ТО», контрактная — «неизвестно» (Р11в).
    const http = renderPage({
      rows: [FIRST],
      summaries: [summaryFor(FIRST, { kmSince: 9500, chainBroken: true })],
    });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    const cells = row('Е646СК799');
    expect(await within(cells).findByText('неизвестно')).toBeDefined();
    expect(within(cells).queryByText('скоро ТО')).toBeNull();
    // Объяснение обязательно: «неизвестно» без него читается как поломка портала.
    expect(within(cells).getByTitle(/счётчик меняли/u)).toBeDefined();
  });

  it('без права на обслуживание колонки нет и запроса нет', async () => {
    // Штаб ведёт заявки объекта и к обслуживанию техники отношения не имеет — как и в тесте блока
    // карточки: право на ТО проверяется независимо от того, кто смотрит на список.
    const http = renderPage({ rows: [FIRST], user: authUser({ role: 'shtab' }) });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    // Заголовков у колонки в разметке таблицы бывает два (видимый и мерный) — нет ни одного.
    expect(screen.queryAllByText('ТО')).toHaveLength(0);
    await waitFor(() => expect(http.countOf('GET /garage/vehicles')).toBe(1));
    expect(http.countOf(SNAPSHOT)).toBe(0);
  });

  it('на телефоне состояние читается строкой карточки', async () => {
    const http = renderPage({
      rows: [FIRST],
      summaries: [summaryFor(FIRST, { kmSince: 10200 })],
      viewport: MOBILE_VIEWPORT,
    });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    expect(await screen.findByText('ТО: просрочено (10.06.2026)')).toBeDefined();
  });
});

describe('гараж: сводка ТО механика', () => {
  it('открывается из строки и называется в адресе', async () => {
    const http = renderPage({ rows: [FIRST, SECOND] });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    fireEvent.click(await within(row('Е646СК799')).findByText('сводка'));

    expect(await screen.findByText('Обслуживание — Е646СК799')).toBeDefined();
    // Ради этого окно и живёт в адресе: ссылку отправляют коллеге, а перезагрузка её не теряет.
    expect(address()).toContain('maintenance=v1');
    // Сводка грузится своей ручкой — не той, что заполняла колонку.
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    expect(http.lastCall(SUMMARY)!.path).toBe('/vehicle-maintenance/vehicles/v1/summary');
    expect(http.lastCall(SUMMARY)!.query.get('on')).toBe(ON_DATE);
  });

  it('открывается прямо из адреса', async () => {
    const http = renderPage({
      rows: [FIRST],
      route: `/garage?tab=vehicles&date=${ON_DATE}&maintenance=v1`,
    });

    expect(await screen.findByText('Обслуживание — Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
  });

  it('«назад» закрывает окно, а не уводит со страницы', async () => {
    const http = renderPage({ rows: [FIRST] });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    fireEvent.click(await within(row('Е646СК799')).findByText('сводка'));
    expect(await screen.findByText('Обслуживание — Е646СК799')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));

    await waitFor(() => expect(screen.queryByText('Обслуживание — Е646СК799')).toBeNull());
    expect(address()).not.toContain('maintenance=');
    // Со среза дня «назад» не уводит: закрылось окно, а список остался тем же.
    expect(address()).toContain(`date=${ON_DATE}`);
    expect(screen.getByText('Е646СК799')).toBeDefined();
  });

  it('механик видит ТО и не видит ни одометра, ни вкладки показаний', async () => {
    // Единственное право роли — обслуживание (Р14): `vehicleReadings.read` открыл бы вместе с
    // формой ТО приёмку, журналы, выгрузки и фотографии приборных панелей.
    const http = renderPage({ rows: [FIRST], user: authUser({ role: 'mechanic' }) });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    expect(screen.getAllByText('ТО').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Одометр')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: 'Показания' })).toBeNull();

    // И вход в журнал обслуживания у него ровно один — строка гаража (Р14в).
    fireEvent.click(await within(row('Е646СК799')).findByText('сводка'));
    expect(await screen.findByText('Обслуживание — Е646СК799')).toBeDefined();
  });

  it('на телефоне сводка открывается пунктом действий строки', async () => {
    const http = renderPage({
      rows: [FIRST],
      user: authUser({ role: 'mechanic' }),
      viewport: MOBILE_VIEWPORT,
    });
    await waitFor(() => expect(http.countOf(SNAPSHOT)).toBe(1));

    // На телефоне строка — карточка, и действия у неё списком с подписями (ADR 0030).
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    fireEvent.click(await screen.findByText('Обслуживание'));

    expect(await screen.findByText('Обслуживание — Е646СК799')).toBeDefined();
    expect(address()).toContain('maintenance=v1');
  });
});
