import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingJournalDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Техника»: вход в журнал показаний машины (ADR 0103, Р25, Р27).
 *
 * Проверяется здесь адрес, а не содержимое журнала: строки и страницы окна спрашивает свой тест
 * (`readings-journal`), а сюда журнал приходит переходом — и переход этот был сломан. Ссылка
 * «журнал» вела на `?journal=<id>`, но параметр читался из состояния таблицы (`useListParams` —
 * это `useState`), а не из адреса: на десктопе нажатие меняло адрес и не открывало ничего, на
 * телефоне то же окно открывалось обработчиком карточки и работало.
 *
 * Отсюда четыре утверждения: окно открывается нажатием, открывается прямо из присланного адреса,
 * закрывается шагом назад и не открывается вовсе тому, кому показания не положены. Пятое —
 * телефон: карточка и ссылка обязаны вести в одно и то же место, иначе ссылка, присланная с
 * телефона, откроет у коллеги не то.
 */

const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';
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

/** Пустой журнал: тест спрашивает, чей журнал открылся, а не что в нём написано. */
function journalOf(vehicleId: string): VehicleReadingJournalDto {
  return {
    vehicleId,
    vehicleLabel: vehicleId === 'v1' ? 'Е646СК799' : 'В010ОР799',
    from: '2026-06-24',
    to: ON_DATE,
    total: 0,
    page: 1,
    pageSize: 100,
    items: [],
  };
}

function renderPage(options: {
  rows?: Row[];
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
    // Соседняя колонка «ТО» спрашивает своё состояние пакетом (Р16); спрашивают с неё свои тесты.
    'GET /vehicle-maintenance/snapshot': ({ query }) =>
      json({ on: query.get('on') ?? '', items: [] }),
    [JOURNAL]: ({ params }) => json(journalOf(params.vehicleId!)),
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    {
      user: options.user ?? authUser({ role: 'dispatcher' }),
      viewport: options.viewport,
      route: options.route ?? `/garage?tab=vehicles&date=${ON_DATE}`,
    },
  );
  return http;
}

/** Адрес и шаг назад по истории: окно живёт в адресе, и «назад» обязано его закрыть. */
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

/** Строка таблицы по госномеру: из неё и открывают журнал. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement;
}

describe('гараж: вход в журнал показаний', () => {
  it('ссылка строки открывает журнал и называет машину в адресе', async () => {
    const http = renderPage({});

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    // Ссылка ведёт по адресу, а не «куда-то»: её копируют и присылают, поэтому проверяется href.
    const link = within(row('Е646СК799')).getByText('журнал');
    expect(link.getAttribute('href')).toBe(`/garage?tab=vehicles&date=${ON_DATE}&journal=v1`);

    fireEvent.click(link);

    expect(await screen.findByText('Показания — Е646СК799')).toBeDefined();
    expect(address()).toContain('journal=v1');
    // День и вкладка ссылку переживают: открывшись у коллеги, она покажет тот же срез.
    expect(address()).toContain(`date=${ON_DATE}`);
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));
    expect(http.lastCall(JOURNAL)!.path).toBe('/vehicle-readings/journal/v1');
  });

  it('открывается прямо из присланного адреса', async () => {
    const http = renderPage({ route: `/garage?tab=vehicles&date=${ON_DATE}&journal=v2` });

    // Ровно то, ради чего окно живёт в адресе: перезагрузка и чужая ссылка открывают его сами.
    expect(await screen.findByText('Показания — В010ОР799')).toBeDefined();
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));
    expect(http.lastCall(JOURNAL)!.path).toBe('/vehicle-readings/journal/v2');
  });

  it('«назад» закрывает журнал, а не уводит со среза', async () => {
    renderPage({});

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    fireEvent.click(within(row('Е646СК799')).getByText('журнал'));
    expect(await screen.findByText('Показания — Е646СК799')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));

    await waitFor(() => expect(screen.queryByText('Показания — Е646СК799')).toBeNull());
    expect(address()).not.toContain('journal=');
    expect(address()).toContain(`date=${ON_DATE}`);
    expect(screen.getByText('Е646СК799')).toBeDefined();
  });

  it('без права на показания ссылки нет, и адрес журнала ничего не открывает', async () => {
    // Механику гараж положен (`garage.read`), показания — нет (Р14): ни ссылки, ни окна, ни
    // запроса, даже если адрес с параметром прислали.
    const http = renderPage({
      user: authUser({ role: 'mechanic' }),
      route: `/garage?tab=vehicles&date=${ON_DATE}&journal=v1`,
    });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.queryByText('журнал')).toBeNull();
    expect(screen.queryByText('Показания — Е646СК799')).toBeNull();
    expect(http.countOf(JOURNAL)).toBe(0);
  });

  it('на телефоне карточка открывает тот же журнал и тем же адресом', async () => {
    renderPage({ rows: [FIRST], viewport: MOBILE_VIEWPORT });

    fireEvent.click(await screen.findByText('Е646СК799'));

    expect(await screen.findByText('Показания — Е646СК799')).toBeDefined();
    // Тот же ключ адреса, что у ссылки на десктопе: присланная с телефона ссылка открывает у
    // коллеги ровно тот же журнал.
    expect(address()).toContain('journal=v1');
  });
});
