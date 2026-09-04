import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  DriverAssignmentDto,
  DriverReportDto,
  ReportItemDto,
  ReportSubmitBody,
  VehicleReadingDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { apiError, json, mockHttp, type MockResponse, type RouteHandler } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';

/**
 * Протокол открытия отчёта и кэш кабинета (план `docs/driver-readings-first-plan.md`, Р7 и Р8;
 * пункты 3–7 раздела «Тесты»).
 *
 * Соседние наборы проверяют, ЧТО нарисовано (driver-day-matrix) и что уходит в отправку
 * (driver-readings, driver-draft-integration). Здесь — цена показа дня и порядок обращений, то
 * есть ровно то, что не видно на экране:
 *
 * 1. **`open` — тяжёлая транзакция**, а не чтение: она занимает источники дня глобально и берёт
 *    блокировки машин. Поэтому уходит она с задержкой (листание стрелками промежуточные дни не
 *    открывает), по разу на дату, и по возврату в приложение вслепую не повторяется — только там,
 *    где состав источников задания разошёлся с составом строк отчёта.
 * 2. **Неудача открытием не считается.** Дата в учёт не попадает, отказ читается словами, а
 *    повторяет его человек кнопкой: автоповтор по рвущейся сети бил бы по базе ровно тогда, когда
 *    ей и без того плохо.
 * 3. **Кэш отчёта один — `driverKeys.report(date)`.** Туда кладут ответы `open` и `submit`, оттуда
 *    же читает строку долга шапка. Два кэша разъехались бы, и первым это увидел бы водитель: день,
 *    только что переданный, остался бы в шапке несданным.
 * 4. **Чтение и запись не пересекаются.** Фоновый `GET`, стартовавший до отправки и ответивший
 *    после неё, не возвращает страницу к версии «до» — иначе следующая отправка получила бы 409.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');
const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
const twoDaysAgo = dayjs(today).subtract(2, 'day').format('YYYY-MM-DD');

/** jsdom не реализует `scrollIntoView`, а поле ввода доводится до видимой части по фокусу. */
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const driver = authUser({
  id: 'user-driver',
  email: 'driver@example.test',
  role: 'driver',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: 'Иванович',
  fullName: 'Водителев Виктор Иванович',
});

const routeItem: ReportItemDto = {
  id: 'item-route',
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  shiftOrder: 1,
  reading: null,
};

/** Второй рейс: им проверяется расхождение состава — рейс, заведённый диспетчером днём. */
const esm2Item: ReportItemDto = {
  id: 'item-esm2',
  sourceKind: 'esm2',
  sourceId: 'wb-1',
  sourceLabel: 'ЭСМ-2 № 000123',
  vehicleId: 'v-2',
  vehicleLabel: 'Экскаватор JCB · В010ОР799',
  shiftOrder: 2,
  reading: null,
};

function readingOf(itemId: string, odometerKm: number): VehicleReadingDto {
  return {
    id: `reading-${itemId}`,
    itemId,
    kind: 'values',
    odometerKm,
    engineHours: null,
    fuelStartLiters: null,
    fuelFilledLiters: null,
    fuelEndLiters: null,
    noDataReason: '',
    comment: '',
    source: 'driver',
    recordedAt: `${today}T10:00:00.000Z`,
    odometerAnomaly: null,
    engineHoursAnomaly: null,
    odometerDelta: null,
    engineHoursDelta: null,
    fileIds: [],
  };
}

function reportOf(
  date: string,
  items: ReportItemDto[],
  overrides: Partial<DriverReportDto> = {},
): DriverReportDto {
  return {
    id: `report-${date}`,
    personId: 'p-1',
    personName: driver.fullName,
    reportDate: date,
    state: 'draft',
    contentVersion: 1,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items,
    discrepancies: [],
    canAccept: false,
    blockers: [],
    ...overrides,
  };
}

function assignmentOf(date: string, items: ReportItemDto[]): DriverAssignmentDto {
  return {
    date,
    canSubmit: true,
    entries: items.map((entry) => ({
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel,
      purposeLabel: 'Грузоперевозка',
      vehicleLabel: entry.vehicleLabel,
      garageNumber: '',
      trailerLabel: '',
      itemId: entry.id,
      shiftOrder: entry.shiftOrder,
      points: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
      previous: null,
    })),
  };
}

/**
 * Сервер в памяти, а не готовые ответы на каждый маршрут: половина проверок здесь о том, что
 * портал делает ПОСЛЕ записи — открытие заводит отчёт, отправка поднимает версию, — и мок,
 * отвечающий всегда одинаково, показывал бы согласие там, где его нет.
 */
function makeServer(entriesOf: (date: string) => ReportItemDto[]) {
  const reports = new Map<string, DriverReportDto>();
  return {
    entriesOf,
    report: (date: string): DriverReportDto | null => reports.get(date) ?? null,
    /** Открытие идемпотентно и синхронизирует состав — ровно как `openReport` на сервере. */
    open: (date: string): DriverReportDto => {
      const before = reports.get(date);
      const dto = reportOf(date, entriesOf(date), { version: before?.version ?? 3 });
      reports.set(date, dto);
      return dto;
    },
    /** Отправка записывает показания и поднимает версию: правку сразу за ней сверяют именно по ней. */
    submit: (date: string, body: ReportSubmitBody): DriverReportDto => {
      const sent = new Map(body.items.map((row) => [row.itemId, row.reading]));
      const items = entriesOf(date).map((item) => {
        const reading = sent.get(item.id);
        return {
          ...item,
          reading:
            reading?.kind === 'values' ? readingOf(item.id, reading.odometerKm ?? 0) : item.reading,
        };
      });
      const dto = reportOf(date, items, { state: 'submitted', version: 4 });
      reports.set(date, dto);
      return dto;
    },
  };
}

interface CabinetOptions {
  route?: string;
  /** Состав дня: по умолчанию один рейс у сегодняшнего и вчерашнего, у прочих дней пусто. */
  entriesOf?: (date: string) => ReportItemDto[];
  /** Чем подменить маршрут: тестам про отказ и про фоновое чтение нужен свой обработчик. */
  openRoute?: RouteHandler;
  reportRoute?: RouteHandler;
}

function renderCabinet(options: CabinetOptions = {}) {
  const server = makeServer(
    options.entriesOf ?? ((date) => (date === today || date === yesterday ? [routeItem] : [])),
  );
  const http = mockHttp({
    'GET /driver/assignment': ({ query }) => {
      const date = query.get('date') ?? today;
      return json(assignmentOf(date, server.entriesOf(date)));
    },
    'GET /driver/reports/:date':
      options.reportRoute ?? (({ params }) => json(server.report(params.date ?? today))),
    'POST /driver/reports/:date/open':
      options.openRoute ?? (({ params }) => json(server.open(params.date ?? today))),
    'POST /driver/reports/:date/submit': ({ params, body }) =>
      json(server.submit(params.date ?? today, body as ReportSubmitBody)),
  });
  const rendered = renderWithUser(
    <DriverLayout>
      <DriverReadingsPage />
    </DriverLayout>,
    { user: driver, route: options.route ?? '/driver' },
  );
  return { ...rendered, http, server };
}

const opens = (http: ReturnType<typeof mockHttp>) =>
  http.countOf('POST /driver/reports/:date/open');

/** За какие дни уходило открытие, в порядке отправки: дата стоит в самом пути запроса. */
const openedDates = (http: ReturnType<typeof mockHttp>): string[] =>
  http.calls
    .filter((call) => call.path.endsWith('/open'))
    .map((call) => call.path.split('/')[3] ?? '');

/*
 * Чтения считаются по конкретному дню, а не маршрутом целиком: шапка кабинета спрашивает отчёт и
 * задание ещё за три прошедших дня — строкой долга (П4), — и общий счётчик мерил бы их заодно.
 */
const reportReads = (http: ReturnType<typeof mockHttp>, date: string): number =>
  http.calls.filter((call) => call.method === 'GET' && call.path === `/driver/reports/${date}`)
    .length;

const assignmentReads = (http: ReturnType<typeof mockHttp>, date: string): number =>
  http.calls.filter((call) => call.path === '/driver/assignment' && call.query.get('date') === date)
    .length;

/**
 * Пауза дольше задержки открытия (Р7). Без неё проверка «второго `open` не было» проходила бы при
 * любом поведении портала: запрос просто не успел бы уйти.
 */
const afterOpenDelay = () => new Promise((resolve) => setTimeout(resolve, 600));

/**
 * Возврат в приложение. Именно это событие слушает TanStack Query: браузер шлёт его, когда вкладку
 * разворачивают, — и по нему кабинет перечитывает задание и отчёт (Р7).
 */
const returnToApp = () => window.dispatchEvent(new Event('visibilitychange'));

async function waitForBlocks(): Promise<void> {
  await waitFor(
    () => expect(document.querySelectorAll('[id^="reading-"]').length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
}

function odometer(itemId: string): HTMLInputElement {
  const block = document.getElementById(`reading-${itemId}`);
  const wrapper = [...(block?.querySelectorAll('label') ?? [])].find((label) =>
    label.textContent?.startsWith('Одометр на конец смены'),
  );
  const input = wrapper?.querySelector('input');
  if (!input) throw new Error(`Поля одометра в блоке «${itemId}» нет`);
  return input as HTMLInputElement;
}

async function submitSheet(): Promise<void> {
  const button = await screen.findByText('Передать');
  await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
  fireEvent.click(button);
}

const submitBody = (http: ReturnType<typeof mockHttp>): ReportSubmitBody =>
  http.lastCall('POST /driver/reports/:date/submit')?.body as ReportSubmitBody;

describe('кабинет водителя: протокол открытия отчёта', () => {
  // Черновик лежит в localStorage по ключу «учётка + дата» и пережил бы соседний тест.
  beforeEach(() => localStorage.clear());

  it('открытие уходит ровно один раз на показанный день', async () => {
    const { http } = renderCabinet();
    await waitForBlocks();
    expect(opens(http)).toBe(1);

    // Перерисовки открытия не заводят: учёт открытых дат живёт в ref страницы, а не в состоянии.
    fireEvent.change(odometer(routeItem.id), { target: { value: '145320' } });
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));

    // Возврат в приложение перечитывает задание и отчёт — оба дешёвые и читающие (Р7).
    const reads = assignmentReads(http, today);
    returnToApp();
    await waitFor(() => expect(assignmentReads(http, today)).toBe(reads + 1));
    await waitFor(() => expect(reportReads(http, today)).toBeGreaterThan(1));

    // А `open` по фокусу вслепую не повторяется: состав задания и состав строк отчёта сошлись,
    // открывать нечего, и тяжёлой транзакции взяться неоткуда.
    await afterOpenDelay();
    expect(opens(http)).toBe(1);
  });

  it('две стрелки подряд промежуточный день не открывают', async () => {
    const { http } = renderCabinet({ entriesOf: () => [routeItem] });
    await waitForBlocks();
    expect(openedDates(http)).toEqual([today]);

    // Листают день за днём, и без паузы каждый промежуточный открывался бы тяжёлой транзакцией с
    // блокировками машин и источников.
    fireEvent.click(screen.getByLabelText('Предыдущий день'));
    fireEvent.click(screen.getByLabelText('Предыдущий день'));

    await waitFor(() => expect(openedDates(http)).toEqual([today, twoDaysAgo]), { timeout: 3000 });
    // И вчерашний день не открывается ни позже: таймер сбрасывается сменой даты, а не откладывается.
    await afterOpenDelay();
    expect(openedDates(http)).toEqual([today, twoDaysAgo]);
  });

  it('отказ открытия не считается открытием: «Повторить», и повтор открывает день', async () => {
    let broken = true;
    const server = makeServer(() => [routeItem]);
    const { http } = renderCabinet({
      entriesOf: () => [routeItem],
      openRoute: ({ params }) =>
        broken
          ? apiError(503, { code: 'service_unavailable', message: 'Сервер недоступен' })
          : json(server.open(params.date ?? today)),
    });

    expect(await screen.findByText('Не удалось открыть день')).toBeDefined();
    expect(screen.getByText('Сервер недоступен')).toBeDefined();
    const retry = screen.getByRole('button', { name: 'Повторить' });

    // Автоповтора нет намеренно: `open` — тяжёлая транзакция с блокировками, и слепой ретрай по
    // сети, которая как раз рвётся, бьёт по базе ровно тогда, когда ей и без того плохо (Р8).
    await afterOpenDelay();
    expect(opens(http)).toBe(1);

    // Дата в учёт открытых не попала — иначе повтору было бы нечего открывать.
    broken = false;
    fireEvent.click(retry);
    await waitForBlocks();
    expect(opens(http)).toBe(2);
  });

  it('заданий не было, рейс появился днём — форма открывается по возврату в приложение', async () => {
    let entries: ReportItemDto[] = [];
    const { http } = renderCabinet({ entriesOf: () => entries });

    // Пустой день формы не получает, и `open` над ним не зовётся: открывать нечего (Р6).
    expect(await screen.findByText('На этот день заданий нет')).toBeDefined();
    await afterOpenDelay();
    expect(opens(http)).toBe(0);

    // Диспетчер завёл рейс днём — водитель об этом узнаёт, вернувшись в приложение: задание
    // перечитывается по фокусу, и появившийся рейс включает открытие сам (Р7).
    entries = [routeItem];
    returnToApp();

    await waitForBlocks();
    expect(opens(http)).toBe(1);
    expect(screen.getByText('Рейс Р-142')).toBeDefined();
  });

  it('состав задания разошёлся со строками отчёта — день открывается заново', async () => {
    let entries = [routeItem];
    const { http } = renderCabinet({ entriesOf: () => entries });
    await waitForBlocks();
    expect(opens(http)).toBe(1);

    // Второй рейс того же дня появился уже после открытия: строки под него нет, а завести её
    // можно только открытием — `itemId` приходит оттуда.
    entries = [routeItem, esm2Item];
    returnToApp();

    await waitFor(() => expect(opens(http)).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(document.getElementById(`reading-${esm2Item.id}`)).not.toBeNull());

    // И на этом всё: расхождение закрыто, и третьего открытия не будет — иначе портал ходил бы
    // тяжёлой транзакцией по кругу там, где сервер отдать источник просто не может.
    returnToApp();
    await afterOpenDelay();
    expect(opens(http)).toBe(2);
  });
});

describe('кабинет водителя: один кэш отчёта', () => {
  beforeEach(() => localStorage.clear());

  it('фоновое чтение, стартовавшее до отправки, не возвращает страницу к старой версии', async () => {
    const server = makeServer(() => [routeItem]);
    let held: (() => void) | null = null;
    let hold = false;
    const { http } = renderCabinet({
      entriesOf: () => [routeItem],
      reportRoute: ({ params }) => {
        // Снимок берётся на СТАРТЕ запроса — как у настоящего сервера, который ответил бы тем, что
        // видел в момент обращения, и доехал бы уже после отправки. Задерживается только чтение
        // показанного дня: шапка тем же маршрутом спрашивает прошедшие дни строкой долга.
        const date = params.date ?? today;
        const snapshot = server.report(date);
        if (!hold || date !== today) return json(snapshot);
        hold = false;
        return new Promise<MockResponse>((resolve) => {
          held = () => resolve(json(snapshot));
        });
      },
      openRoute: ({ params }) => json(server.open(params.date ?? today)),
    });
    await waitForBlocks();

    fireEvent.change(odometer(routeItem.id), { target: { value: '145320' } });
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));

    // Возврат в приложение во время ввода: фокусный `GET` стартовал и завис на снимке «до».
    hold = true;
    returnToApp();
    await waitFor(() => expect(held).not.toBeNull());

    const reads = reportReads(http, today);
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(await screen.findByText('Передано')).toBeDefined();
    // Пока отправка в полёте, читающие запросы кабинета выключены: по фокусу они не обновляются,
    // и второго чтения не случается (Р7).
    expect(reportReads(http, today)).toBe(reads);

    // Ответ «до» доезжает после отправки — и не становится тем, что показано.
    held!();
    await afterOpenDelay();
    expect(screen.getByText('Передано')).toBeDefined();

    // Проверка та же, но с другой стороны: следующая отправка уходит с версией из ответа. Снимок
    // «до» дал бы версию 3, то есть гарантированный 409 «Отчёт изменился».
    fireEvent.change(odometer(routeItem.id), { target: { value: '145400' } });
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(2));
    expect(submitBody(http).version).toBe(4);
  });

  it('после отправки строка долга в шапке перестаёт считать день незакрытым', async () => {
    // Шапка считает долг по прошедшим дням окна записи, поэтому смотрим вчерашний: сегодняшний в
    // проверку не входит вовсе. У позавчерашнего задания нет — он в долг не попадает.
    const { http } = renderCabinet({
      route: `/driver?date=${yesterday}`,
      entriesOf: (date) => (date === yesterday ? [routeItem] : []),
    });
    const debt = `Не переданы показания за ${dayjs(yesterday).format('D MMM')}`;
    expect(await screen.findByText(debt)).toBeDefined();
    await waitForBlocks();

    fireEvent.change(odometer(routeItem.id), { target: { value: '145320' } });
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));

    const reads = reportReads(http, yesterday);
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    /*
     * Кэш отчёта один — `driverKeys.report(date)`, и строка долга читает именно его (Р8). Поэтому
     * день перестаёт считаться незакрытым от самого ответа отправки: ни корневой инвалидации, ни
     * повторного чтения отчёта не нужно, и второго кэша, который разъехался бы с этим, нет.
     */
    await waitFor(() => expect(screen.queryByText(debt)).toBeNull());
    expect(reportReads(http, yesterday)).toBe(reads);
  });
});
