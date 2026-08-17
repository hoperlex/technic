import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { READING_EXPORT_KINDS, readingExportKindLabels } from '@technic/contracts';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  Permission,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { authUser } from './factories/auth';
import { selectOption } from './antd';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Выгрузки показаний: окно выбора книги (план «Показания техники», §8, Р18, Р31).
 *
 * Кнопка «Выгрузить» больше не скачивает одну заранее выбранную книгу — книг шесть, и различаются
 * они вопросом, на который отвечают. Отсюда и предмет проверок: окно обязано **назвать состав**
 * каждого варианта (иначе выбирают наугад), послать **ровно тот** `kind` и период, что показан на
 * экране, не молчать там, где варианту не хватает машины, и показать отказ сервера словами — у
 * построчных выгрузок он говорит «сузьте период» (Р31), и это указание, а не шум.
 *
 * Скачивания в jsdom не происходит: `apiDownload` берёт ответ, делает из него `Blob` и жмёт на
 * невидимую ссылку. Проверять здесь нечего и нечем — важно, что ушло на сервер и что портал показал
 * в ответ, а `URL.createObjectURL`, которого в jsdom нет вовсе, подменяется заглушкой ниже.
 */

const STATS = 'GET /vehicle-readings/stats';
const EXPORT = 'GET /vehicle-readings/export';

/** День среза страницы: от него отсчитывается умолчание периода сводки. */
const DAY = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';
const SECOND = 'Экскаватор · 0002 ММ 77';

/** Период в адресе — он же период выгрузки: выгружают то, на что смотрят. */
const ROUTE = `/garage?tab=readings&sub=stats&date=${DAY}&from=2026-06-01&to=2026-07-24`;

const ROWS: VehicleReadingStatsRow[] = [
  {
    vehicleId: 'v-1',
    vehicleLabel: LABEL,
    distanceKm: 1240,
    engineHours: 38.5,
    fuelFilledLiters: 620,
    gaps: 1,
  },
  {
    vehicleId: 'v-2',
    vehicleLabel: SECOND,
    distanceKm: null,
    engineHours: 12,
    fuelFilledLiters: 90,
    gaps: 2,
  },
];

const VEHICLES: GarageVehicleListDto = { items: [], total: 0, page: 1, pageSize: 50, onDate: DAY };
const VEHICLES_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: DAY,
};

/** Ответ выгрузки: тело книги тесту безразлично — важны заголовок имени и сам факт ответа. */
const BOOK: MockResponse = {
  status: 200,
  body: 'PK',
  headers: { 'content-disposition': "attachment; filename*=UTF-8''kniga.xlsx" },
};

interface Options {
  rows?: VehicleReadingStatsRow[];
  routes?: RouteMap;
  /** Права учётки: срез на дату описывается по-разному тому, кто видит ТО, и тому, кто не видит. */
  permissions?: Permission[];
}

function renderGarage({ rows = ROWS, routes = {}, permissions }: Options = {}): HttpMock {
  const http = mockHttp({
    [STATS]: ({ query }) =>
      json({ items: rows, from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [EXPORT]: () => BOOK,
    // Соседняя вкладка гаража монтируется вместе со страницей: без её ручек запрос ушёл бы в пустоту.
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...routes,
  });
  renderWithUser(<GaragePage />, {
    route: ROUTE,
    user: permissions ? authUser({ permissions }) : undefined,
  });
  return http;
}

/** Окно выбора книги целиком: искать варианты по всему документу — значит поймать чужую разметку. */
const modal = () => screen.getByText('Выгрузка показаний').closest('.ant-modal') as HTMLElement;

/**
 * Кнопка окна, а не кнопка строки инструментов: подписаны они по-разному именно поэтому.
 *
 * Ищется по тексту подвала, а не по доступному имени: в загрузке antd подставляет в кнопку значок
 * со своей подписью, и точное имя роли перестаёт совпадать ровно в том тесте, где важна загрузка.
 */
function okButton(): HTMLButtonElement {
  const found = [...modal().querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
    (button) => button.textContent?.includes('Скачать книгу'),
  );
  if (!found) throw new Error('кнопки «Скачать книгу» в подвале окна нет');
  return found;
}

/** Открыть окно: сначала дожидаемся сводки — из её строк окно берёт список машин. */
async function openExport(): Promise<void> {
  await screen.findByText('Машин:');
  fireEvent.click(screen.getByRole('button', { name: /Выгрузить/u }));
  await screen.findByText('Выгрузка показаний');
}

/** Выбрать вариант по его человеческому названию — тем же способом, каким его выбирает человек. */
function chooseVariant(title: string): void {
  const radio = within(modal()).getByText(title).closest('label')!.querySelector('input')!;
  fireEvent.click(radio);
}

beforeAll(() => {
  // jsdom не умеет ни того, ни другого, а `apiDownload` зовёт оба: без заглушек падал бы транспорт,
  // а не проверяемое поведение.
  URL.createObjectURL = () => 'blob:readings-export';
  URL.revokeObjectURL = () => {};
});

describe('выгрузки показаний: окно выбора книги', () => {
  it('перечисляет все варианты и объясняет состав каждого', async () => {
    renderGarage();
    await openExport();

    const box = within(modal());
    /*
     * Перечислены все варианты контракта, а не подмножество: список берётся из `READING_EXPORT_KINDS`,
     * и вариант, заведённый сервером, но забытый окном, — это книга, которую никто не увидит.
     * Названия — контрактные же: одна подпись на окно и на имя файла.
     */
    for (const kind of READING_EXPORT_KINDS) {
      expect(box.getByText(readingExportKindLabels[kind])).toBeDefined();
    }

    // И у каждого — строка про то, что внутри: иначе выбор остаётся угадыванием.
    expect(box.getByText(/ровно то, что в таблице на экране/u)).toBeDefined();
    expect(box.getByText(/колонки — месяцы периода/u)).toBeDefined();
    expect(box.getByText(/Все смены подряд одним листом/u)).toBeDefined();
    expect(box.getByText(/каждый месяц периода — отдельный лист книги/u)).toBeDefined();
    expect(box.getByText(/Последний одометр и моточасы на 24\.07\.2026/u)).toBeDefined();
    expect(box.getByText(/Все показания периода одним листом/u)).toBeDefined();

    // Период не спрашивается второй раз — он тот же, что на экране (Р29).
    expect(
      box.getByText(/Период — тот же, что на экране: 01\.06\.2026 — 24\.07\.2026/u),
    ).toBeDefined();
  });

  it('шлёт выбранный вариант и период из адреса', async () => {
    const http = renderGarage();
    await openExport();

    chooseVariant(readingExportKindLabels.fleetJournal);
    fireEvent.click(okButton());

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    const call = http.lastCall(EXPORT)!;
    expect(call.query.get('kind')).toBe('fleetJournal');
    expect(call.query.get('from')).toBe('2026-06-01');
    expect(call.query.get('to')).toBe('2026-07-24');
    // Сводной книге машина не передаётся: лишний параметр — просьба, которой никто не задавал.
    expect(call.query.get('vehicleId')).toBeNull();
  });

  it('журнал одной машины уходит с её идентификатором', async () => {
    const http = renderGarage();
    await openExport();

    chooseVariant(readingExportKindLabels.vehicleMonths);
    await selectOption('Машина', SECOND);
    fireEvent.click(okButton());

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    const call = http.lastCall(EXPORT)!;
    expect(call.query.get('kind')).toBe('vehicleMonths');
    expect(call.query.get('vehicleId')).toBe('v-2');
    expect(call.query.get('from')).toBe('2026-06-01');
  });

  it('вариант по одной машине не скачивается, пока машина не выбрана, и говорит об этом', async () => {
    const http = renderGarage();
    await openExport();

    chooseVariant(readingExportKindLabels.vehicleJournal);

    // Не «кнопка молча ничего не делает»: рядом написано, чего не хватает.
    expect(
      within(modal()).getByText(/Выберите машину: этот журнал строится по одной единице техники/u),
    ).toBeDefined();
    await waitFor(() => expect(okButton().hasAttribute('disabled')).toBe(true));

    fireEvent.click(okButton());
    expect(http.countOf(EXPORT)).toBe(0);

    // Выбрали машину — запрет снят, и книга уходит.
    await selectOption('Машина', LABEL);
    await waitFor(() => expect(okButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(okButton());
    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    expect(http.lastCall(EXPORT)!.query.get('vehicleId')).toBe('v-1');
  });

  it('без единой машины в периоде такие варианты выключены и объясняют причину', async () => {
    renderGarage({ rows: [] });
    await openExport();

    const box = within(modal());
    const radio = (title: string) => box.getByText(title).closest('label')!.querySelector('input')!;

    expect(radio(readingExportKindLabels.vehicleJournal).hasAttribute('disabled')).toBe(true);
    expect(radio(readingExportKindLabels.vehicleMonths).hasAttribute('disabled')).toBe(true);
    // Причина стоит у самого варианта: «выключено» без объяснения читается как поломка.
    expect(
      box.getAllByText(/Выбирать не из чего: за этот период ни одна машина не работала/u).length,
    ).toBe(2);
    // Сводные варианты при этом остаются рабочими — им машина не нужна.
    expect(radio(readingExportKindLabels.fleetMonths).hasAttribute('disabled')).toBe(false);
  });

  it('отказ сервера показан текстом, а окно остаётся открытым', async () => {
    const LIMIT =
      'Период слишком длинный для построчной выгрузки — сузьте период до года или меньше';
    const http = renderGarage({
      routes: { [EXPORT]: () => apiError(400, { code: 'period_too_long', message: LIMIT }) },
    });
    await openExport();

    chooseVariant(readingExportKindLabels.fleetJournal);
    fireEvent.click(okButton());

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    // Указание «сузьте период» читают там же, где выбирают вариант, — тост в углу его унёс бы.
    expect(await within(modal()).findByText(LIMIT)).toBeDefined();
    expect(screen.getByText('Выгрузка показаний')).toBeDefined();
  });

  it('на время сборки книги кнопка показывает загрузку', async () => {
    let release: (() => void) | null = null;
    const http = renderGarage({
      routes: {
        [EXPORT]: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return BOOK;
        },
      },
    });
    await openExport();

    fireEvent.click(okButton());

    // Книга собирается на сервере секундами (Р31): без этого признака человек жмёт кнопку второй раз.
    await waitFor(() => expect(okButton().className).toMatch(/loading/u));
    await waitFor(() => expect(release).not.toBeNull());

    release!();
    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    // Скачивание началось — окно закрывается само: спрашивать было больше нечего.
    await waitFor(() => expect(screen.queryByText('Выгрузка показаний')).toBeNull());
  });

  it('без права на ТО срез на дату не обещает колонок обслуживания', async () => {
    renderGarage({
      permissions: ['garage.read', 'vehicleReadings.read'],
    });
    await openExport();

    const box = within(modal());
    expect(
      box.getByText(/Последний одометр и моточасы на 24\.07\.2026 с датами снятия\./u),
    ).toBeDefined();
    // Портал ничего не скрывает и права не дублирует — он лишь не называет того, чего сервер не даст.
    expect(box.queryByText(/пробег с него/u)).toBeNull();
    expect(box.getByText(readingExportKindLabels.snapshot)).toBeDefined();
  });
});
