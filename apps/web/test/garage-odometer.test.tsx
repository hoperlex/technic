import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Техника»: колонка последнего одометра (план «Показания техники», Р16).
 *
 * Проверяется ровно то, за что колонка отвечает на портале, — и ничего сверх: число приходит
 * сервером **на день среза**, портал его печатает вместе с датой снятия и показывает колонку
 * только тому, кому положены сами показания.
 *
 * Дата рядом с числом — не подпись-украшение: одометр без неё читается как сегодняшний и врёт тем
 * сильнее, чем дольше машина стоит. Поэтому она здесь проверяется наравне с числом.
 *
 * Право проверяется двумя рендерами, а не подменой поля: механику гараж виден (`garage.read`), а
 * показания — нет, и сервер поля ему не присылает вовсе. Портал в этом случае обязан убрать
 * колонку целиком: столбец прочерков означал бы «показаний нет», то есть неправду про парк.
 */

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
    ...overrides,
  };
}

/** Первая машина показания сдавала, вторая — нет: колонка обязана различать «нет» и ноль. */
const withOdometer = vehicle({
  id: 'v1',
  label: 'Е646СК799',
  // Снято за день до среза: ровно тот случай, ради которого дата и едет рядом с числом.
  lastOdometer: { km: 128_400, measuredOn: '2026-07-23' },
});
const withoutOdometer = vehicle({ id: 'v2', label: 'В010ОР799', lastOdometer: null });

const summary: GarageVehiclesSummaryDto = {
  total: 2,
  free: 2,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

function renderPage(options: {
  rows: Row[];
  user: ReturnType<typeof authUser>;
  viewport?: Viewport;
}) {
  const list: GarageVehicleListDto = {
    items: options.rows,
    total: options.rows.length,
    page: 1,
    pageSize: 50,
    onDate: ON_DATE,
  };
  const http = mockHttp({
    'GET /garage/vehicles': () => json(list),
    'GET /garage/vehicles/summary': () => json(summary),
    'GET /garage/drivers': () => json(emptyList()),
    'GET /garage/drivers/summary': () => json({ ...summary, assigned: 0, documentsIncomplete: 0 }),
    'GET /vehicle-classifications': () => json(emptyList()),
    // Соседняя колонка «ТО» спрашивает своё состояние пакетом (Р16) — и у диспетчера, и у
    // механика: право на обслуживание есть у обоих. Здесь она молчит пустым ответом, а спрашивают
    // с неё свои тесты (`garage-maintenance`).
    'GET /vehicle-maintenance/snapshot': ({ query }) =>
      json({ on: query.get('on') ?? '', items: [] }),
  });
  const rendered = renderWithUser(<GaragePage />, {
    user: options.user,
    viewport: options.viewport,
    route: `/garage?tab=vehicles&date=${ON_DATE}`,
  });
  return { ...rendered, http };
}

describe('гараж: колонка одометра', () => {
  it('показывает число и день, за который его сняли', async () => {
    renderPage({ rows: [withOdometer, withoutOdometer], user: authUser({ role: 'dispatcher' }) });

    // Ждём строку, а не заголовок: шапка таблицы стоит и до ответа сервера.
    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.getAllByText('Одометр').length).toBeGreaterThan(0);
    // В разметке разряды разделены неразрывным пробелом («128 400 км» не должно рваться на две
    // строки), а в ожидании он обычный: сравнение идёт по нормализованному тексту.
    expect(screen.getByText('128 400 км')).toBeDefined();
    // Дата снятия — с годом: последнее показание бывает и прошлогодним.
    expect(screen.getByText('снято 23.07.2026')).toBeDefined();
  });

  it('машина без показаний показывает прочерк, а не ноль', async () => {
    renderPage({ rows: [withoutOdometer], user: authUser({ role: 'dispatcher' }) });

    expect(await screen.findByText('В010ОР799')).toBeDefined();
    expect(screen.getAllByText('Одометр').length).toBeGreaterThan(0);
    // Ноль на приборе и отсутствие снимка — разные вещи, и колонка их не путает.
    expect(screen.queryByText(/ км$/u)).toBeNull();
    expect(screen.queryByText(/снято /u)).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('без права на показания колонки нет вовсе', async () => {
    // Механик: гараж ему положен, показания — нет (Р14), и сервер поля в строке не присылает.
    const rows = [vehicle({ id: 'v1', label: 'Е646СК799' })];
    renderPage({ rows, user: authUser({ role: 'mechanic' }) });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    // Заголовков у колонки в разметке таблицы бывает два (видимый и мерный) — нет ни одного.
    expect(screen.queryAllByText('Одометр')).toHaveLength(0);
    expect(screen.queryByText(/снято /u)).toBeNull();
  });

  it('на телефоне одометр читается строкой карточки', async () => {
    renderPage({
      rows: [withOdometer],
      user: authUser({ role: 'dispatcher' }),
      viewport: MOBILE_VIEWPORT,
    });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    // Пробелы в ожидании обычные: разряды в разметке разделены неразрывными, а сравнение идёт по
    // нормализованному тексту — testing-library сводит любой пробел к обычному.
    expect(screen.getByText('одометр: 128 400 км (23.07.2026)')).toBeDefined();
  });
});
