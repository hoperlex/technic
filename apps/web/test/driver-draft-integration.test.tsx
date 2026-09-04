import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  DriverAssignmentDto,
  DriverReportDto,
  ReportItemDto,
  ReportSubmitBody,
  VehicleReadingDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { apiError, json, mockHttp, type RouteHandler } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';
import { readDraft } from '../src/pages/driver/draftStore';
import type { DraftItem } from '../src/pages/driver/api';

/**
 * Форма показаний и её черновик вместе (план docs/driver-readings-first-plan.md — Р11–Р14а).
 *
 * Соседний набор (driver-draft-store) проверяет хранилище само по себе: слияние веток, логические
 * часы, надгробия. Здесь проверяется то, чего в нём не видно, — **порядок**, в котором страница
 * трогает хранилище, сеть и файлы, и то, что показано человеку между шагами:
 *
 * 1. **Введённое адресуется источником.** Пересозданная строка ожидания приходит с другим `itemId`,
 *    и по нему черновик терялся от одного нажатия чужого водителя (Р11).
 * 2. **Ничто введённое не исчезает молча** (Р14). Запись, не сопоставившаяся ни с одной строкой, не
 *    отбрасывается, а показывается блоком — и переносит её человек, а не портал.
 * 3. **Сначала запись, потом всё остальное** (Р14а п. 5, Р12а п. 1). Отказ хранилища не меняет ни
 *    экрана, ни файлов, ни попытки отправки; команда, ушедшая без следа, при повторе стала бы
 *    второй отправкой того же дня.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');

/** jsdom не реализует `scrollIntoView`, а отказ отправки приводит к первому плохому блоку. */
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

const V1_KEY = `technic:driver-draft:${driver.id}:${today}`;
const V2_PREFIX = `technic:driver-draft-v2:${driver.id}:${today}:`;

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

const item = (patch: Partial<DraftItem> = {}): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  // Пять чисел, а не три (ADR 0163): остатки в баке обязательны в типе и стоят вокруг заправки
  // в порядке смены. Пропущенный здесь ключ — не мелочь фикстуры: `DraftItem` собирают все
  // перечисления черновика, и литерал без него перестал бы быть тем, что читает форма.
  fuelStartLiters: '',
  fuelFilledLiters: '',
  fuelEndLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
  ...patch,
});

const file = (id: string) => ({ id, filename: `${id}.jpg`, contentType: 'image/jpeg', size: 1024 });

/** Показание, записанное сервером по отправке: им форма заполняет поля после успеха. */
function readingOf(odometerKm: number): VehicleReadingDto {
  return {
    id: 'reading-1',
    itemId: routeItem.id,
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
  items: ReportItemDto[],
  overrides: Partial<DriverReportDto> = {},
): DriverReportDto {
  return {
    id: 'report-1',
    personId: 'p-1',
    personName: driver.fullName,
    reportDate: today,
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

function assignmentOf(items: ReportItemDto[], canSubmit: boolean): DriverAssignmentDto {
  return {
    date: today,
    canSubmit,
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

// ── Черновик до входа ──

/** Черновик прежнего формата: ключи записей — `itemId`, объект дня целиком (Р11б). */
function putV1(items: Record<string, Partial<DraftItem>>): void {
  localStorage.setItem(
    V1_KEY,
    JSON.stringify({
      idempotencyKey: 'legacy-key',
      savedAt: Date.now(),
      items: Object.fromEntries(Object.entries(items).map(([id, raw]) => [id, item(raw)])),
    }),
  );
}

/**
 * Ветка соседнего документа — ячейка чужой загрузки страницы. Пишется руками, а не через
 * `writeDraft`: своя ветка у модуля одна на весь прогон, и разводить их значением нечем (Р11в).
 */
function putBranch(branch: string, entries: Record<string, DraftItem>, counter = 1): void {
  const savedAt = Date.now();
  localStorage.setItem(
    `${V2_PREFIX}${branch}`,
    JSON.stringify({
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          { clock: { counter, branch }, savedAt, item: value },
        ]),
      ),
      legacy: [],
      attempts: [],
    }),
  );
}

/** Событие приходит только соседним вкладкам того же происхождения — свою запись оно не сопровождает. */
function fireStorage(branch: string): void {
  window.dispatchEvent(new StorageEvent('storage', { key: `${V2_PREFIX}${branch}` }));
}

// ── Рендер кабинета ──

interface SentRequest {
  path: string;
  headers: Record<string, string>;
}

interface CabinetOptions {
  canSubmit?: boolean;
  stored?: DriverReportDto | null;
  open?: RouteHandler;
  submit?: RouteHandler;
}

function renderCabinet(items: ReportItemDto[], options: CabinetOptions = {}) {
  const http = mockHttp({
    'GET /driver/assignment': () => json(assignmentOf(items, options.canSubmit ?? true)),
    'GET /driver/reports/:date': () => json(options.stored ?? null),
    'POST /driver/reports/:date/open': options.open ?? (() => json(reportOf(items))),
    'POST /driver/reports/:date/submit':
      options.submit ?? (() => json(reportOf(items, { state: 'submitted', version: 4 }))),
    // Файл, вытесненный заменой или снятый из строки, удаляется тем же вызовом: он ещё ничей.
    'DELETE /files/:id': () => json({ ok: true }),
  });

  // Ключ идемпотентности уезжает заголовком, а `mockHttp` заголовков не журналирует.
  const sent: SentRequest[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      path: new URL(raw, window.location.origin).pathname,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;

  const rendered = renderWithUser(
    <DriverLayout>
      <DriverReadingsPage />
    </DriverLayout>,
    { user: driver, route: '/driver' },
  );
  return { ...rendered, http, sent };
}

/** Ждёт дольше секунды по умолчанию: строки открытого дня приходят после задержки `open` (Р7). */
async function waitForBlocks(): Promise<void> {
  await waitFor(
    () => expect(document.querySelectorAll('[id^="reading-"]').length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
}

function blockOf(itemId: string): HTMLElement {
  const element = document.getElementById(`reading-${itemId}`);
  if (!element) throw new Error(`Блока строки «${itemId}» нет на экране`);
  return element;
}

function field(scope: HTMLElement, label: string): HTMLInputElement {
  const wrapper = [...scope.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = wrapper?.querySelector('input, textarea');
  if (!input) throw new Error(`Поля «${label}» нет в блоке`);
  return input as HTMLInputElement;
}

const odometer = (itemId: string) => field(blockOf(itemId), 'Одометр');

/**
 * Группа полей одного момента смены (Р7). Без неё два поля с подписью «Топливо» неразличимы:
 * поиск по подписи всегда находил бы первое — остаток на начало.
 */
function group(scope: HTMLElement, title: string): HTMLElement {
  const heading = [...scope.querySelectorAll('strong')].find((el) => el.textContent === title);
  const box = heading?.closest('div');
  if (!box) throw new Error(`Группы «${title}» нет в блоке`);
  return box as HTMLElement;
}

const fuelStart = (itemId: string) => field(group(blockOf(itemId), 'Начало смены'), 'Топливо');
const fuelEnd = (itemId: string) => field(group(blockOf(itemId), 'Конец смены'), 'Топливо');

function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

async function submitSheet(): Promise<void> {
  const button = await screen.findByText('Передать');
  await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
  fireEvent.click(button);
}

function submitBody(http: ReturnType<typeof mockHttp>): ReportSubmitBody {
  return http.lastCall('POST /driver/reports/:date/submit')?.body as ReportSubmitBody;
}

const idempotencyKeys = (sent: SentRequest[]): (string | undefined)[] =>
  sent.filter((r) => r.path.endsWith('/submit')).map((r) => r.headers['Idempotency-Key']);

const orphanBlocks = () => screen.queryAllByText('Введено, но не привязано к строке');

/** Чтения отчёта именно показанного дня: строка долга в шапке спрашивает тем же маршрутом прошлые. */
const reportReads = (http: ReturnType<typeof mockHttp>): number =>
  http.calls.filter((call) => call.method === 'GET' && call.path === `/driver/reports/${today}`)
    .length;

const draft = () => readDraft(driver.id, today);

const STORAGE_REFUSED = 'Не хватило места в памяти телефона — ничего не изменено';

describe('кабинет водителя: черновик по источнику', () => {
  beforeEach(() => localStorage.clear());

  it('введённое переживает пересоздание строки ожидания', async () => {
    const first = renderCabinet([routeItem]);
    await waitForBlocks();
    type(odometer(routeItem.id), '145320');
    first.unmount();

    // Перенос источника между черновиками сделан парой «удалить — завести»: у нового владельца
    // строка получает другой `itemId`, а рейс остаётся тем же рейсом (Р11).
    renderCabinet([{ ...routeItem, id: 'item-route-2' }]);
    await waitForBlocks();

    expect(odometer('item-route-2').value).toBe('145320');
    // Ключ сопоставился — блока «введено, но не привязано» быть не должно.
    expect(orphanBlocks()).toHaveLength(0);
  });

  it('несопоставленное показано блоком и в отправку не идёт', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '111111' }) });
    putV1({ 'item-old': { odometerKm: '222222' } });
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();

    // Три случая сходятся в один экран: `v2` с ушедшим источником и запись прежнего формата (Р14).
    expect(orphanBlocks()).toHaveLength(2);
    expect(screen.getByText('Строка ушла из задания')).toBeDefined();
    expect(screen.getByText('Введено в прежней версии портала')).toBeDefined();
    expect(screen.getByText('111111 км')).toBeDefined();
    expect(screen.getByText('222222 км')).toBeDefined();

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Отправить их нечем: строки отчёта у них нет, и выдумывать её порталу не из чего.
    expect(submitBody(http).items).toHaveLength(1);
    expect(submitBody(http).items[0]!.reading).toMatchObject({ odometerKm: 145320 });
  });

  it('осиротевшее введённое показывает остатки в баке и переносит их вместе с прочим', async () => {
    putBranch('aaaa', {
      'route:route-gone': item({
        odometerKm: '145320',
        fuelStartLiters: '120',
        fuelFilledLiters: '80',
        fuelEndLiters: '40',
      }),
    });
    renderCabinet([routeItem]);
    await waitForBlocks();

    /*
     * Н5: блок печатает потерянное введённое построчно, и остатки для него — не оформление.
     * Пропусти их в перечислении полей — и они исчезли бы РОВНО там, где введённое показывают,
     * чтобы человек перенёс его руками или продиктовал диспетчеру: числа были бы в хранилище, а на
     * экране их не было бы вовсе.
     *
     * Порядок строк — по ходу смены, тот же, что в форме: строку эту диктуют вслух, и
     * переставленные числа диспетчер запишет в том порядке, в каком услышал.
     */
    expect(orphanBlocks()).toHaveLength(1);
    expect(screen.getByText('Топливо на начало')).toBeDefined();
    expect(screen.getByText('120 л')).toBeDefined();
    expect(screen.getByText('80 л')).toBeDefined();
    expect(screen.getByText('Топливо на конец')).toBeDefined();
    expect(screen.getByText('40 л')).toBeDefined();

    // Цель одна и пуста — спрашивать «в ту ли строку» не о чем (Р14а п. 2).
    fireEvent.click(screen.getByRole('button', { name: 'Перенести' }));
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));

    // Перенос кладёт запись целиком: потеряй он остаток по дороге, человек увидел бы «перенесено»
    // и недосчитался числа — молча и без единого следа в хранилище.
    expect(fuelStart(routeItem.id).value).toBe('120');
    expect(fuelEnd(routeItem.id).value).toBe('40');
    expect(orphanBlocks()).toHaveLength(0);
    expect(draft().items['route:route-1']?.item).toMatchObject({
      fuelStartLiters: '120',
      fuelFilledLiters: '80',
      fuelEndLiters: '40',
    });
  });

  it('перенос в занятую строку показывает сравнение и заменяет одной записью', async () => {
    putBranch('aaaa', {
      'route:route-gone': item({
        odometerKm: '145320',
        comment: 'снято у КамАЗа',
        confirmAnomaly: true,
        files: [file('f-new')],
      }),
      'route:route-1': item({ odometerKm: '999', files: [file('f-old')] }),
    });
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();

    fireEvent.click(screen.getByRole('button', { name: 'Перенести' }));
    // Занятую строку молча не перезаписывают: человек видит оба варианта по всем полям (Р14а п. 2).
    expect(await screen.findByText('Сейчас')).toBeDefined();
    expect(screen.getByText('В этой строке уже есть введённое')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Заменить' }));

    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));
    expect(orphanBlocks()).toHaveLength(0);
    // Файл, вытесненный заменой, удаляется тем же вызовом, что и при ручном удалении: до отправки
    // он ещё ничей (Р14а п. 3). И удаляется он ПОСЛЕ записи черновика, а не вместо неё.
    await waitFor(() => expect(http.countOf('DELETE /files/:id')).toBe(1));
    expect(http.lastCall('DELETE /files/:id')?.path).toBe('/files/f-old');

    const view = draft();
    expect(view.items['route:route-1']?.item).toMatchObject({
      odometerKm: '145320',
      comment: 'снято у КамАЗа',
      // Подтверждают показанное, а показывают его заново — галочка сбрасывается (Р14а п. 3).
      confirmAnomaly: false,
      files: [file('f-new')],
    });
    // Источник погашен надгробием, а не вычеркнут: ячейка соседней ветки на месте, и вернуть из неё
    // строку слияние уже не может (Р11г).
    expect(view.items['route:route-gone']).toBeUndefined();
    expect(localStorage.getItem(`${V2_PREFIX}aaaa`)).toContain('route-gone');
  });

  it('в дне без открытой правки переносить некуда, и блок остаётся', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '145320' }) });
    // День вне окна записи: строк, открытую правку которых водитель имеет, у него нет ни одной.
    // Отчёт при этом сохранённый: без него за границей окна записи строк не было бы вовсе — их
    // заводит `open`, а его такой день не зовёт (матрица состояний, Р2).
    renderCabinet([routeItem], { canSubmit: false, stored: reportOf([routeItem]) });
    await waitForBlocks();

    // Кнопки нет вовсе, а не выключенной: числа нужны, чтобы продиктовать их диспетчеру (Р14а п. 1).
    expect(await screen.findByText('Перенести некуда')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Перенести' })).toBeNull();
    expect(orphanBlocks()).toHaveLength(1);
  });

  it('отказ открытия введённое не прячет', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '111111' }) });
    renderCabinet([routeItem], {
      open: () => apiError(503, { code: 'service_unavailable', message: 'Сервер недоступен' }),
    });

    // Р14 обещает показ несопоставленной записи в любом состоянии дня, и отказ открытия — не
    // исключение: в офлайне это её единственная копия, и спрятать её за сообщением об отказе
    // значило бы потерять введённое вместе с сетью.
    expect(await screen.findByText('Не удалось открыть день')).toBeDefined();
    expect(orphanBlocks()).toHaveLength(1);
    expect(screen.getByText('111111 км')).toBeDefined();
    // Строк дня портал при этом не знает: целей нет, и кнопки нет вовсе (Р14а п. 1).
    expect(await screen.findByText('Перенести некуда')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Перенести' })).toBeNull();
  });

  it('запись прежнего формата гасится переносом, а изменённая возвращается', async () => {
    putV1({ 'item-old': { odometerKm: '145320' } });
    const before = localStorage.getItem(V1_KEY);
    const first = renderCabinet([routeItem]);
    await waitForBlocks();

    // Цель одна и пуста — спрашивать «в ту ли строку» не о чем (Р14а п. 2).
    fireEvent.click(await screen.findByRole('button', { name: 'Перенести' }));
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('145320'));
    expect(orphanBlocks()).toHaveLength(0);
    // В чужой ключ новая сборка не пишет и записей из него не удаляет: у той ячейки два писателя,
    // и тронуть её значило бы затереть то, что держит в памяти вкладка прежней сборки (Р11б).
    expect(localStorage.getItem(V1_KEY)).toBe(before);
    first.unmount();

    // Старая вкладка переписала ту же строку другим числом: отпечаток разошёлся, и это уже новая
    // правка человека, а не воскресший призрак (Р11б).
    putV1({ 'item-old': { odometerKm: '146000' } });
    renderCabinet([routeItem]);
    await waitForBlocks();

    expect(orphanBlocks()).toHaveLength(1);
    expect(screen.getByText('146000 км')).toBeDefined();
  });

  it('правку прежнего формата соседняя вкладка возвращает без перезагрузки', async () => {
    putV1({ 'item-old': { odometerKm: '145320' } });
    renderCabinet([routeItem]);
    await waitForBlocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Перенести' }));
    await waitFor(() => expect(orphanBlocks()).toHaveLength(0));

    // Старая вкладка переписала ту же запись — отпечаток разошёлся, и блок обязан появиться снова
    // (Р11б). Событие приходит по ключу прежнего формата: со своего префикса он не начинается
    // намеренно, и фильтр, знающий только нынешний, правку бы не заметил до перезагрузки.
    putV1({ 'item-old': { odometerKm: '146000' } });
    window.dispatchEvent(new StorageEvent('storage', { key: V1_KEY }));

    await waitFor(() => expect(orphanBlocks()).toHaveLength(1));
    expect(screen.getByText('146000 км')).toBeDefined();
  });
});

describe('кабинет водителя: отправка и попытки', () => {
  beforeEach(() => localStorage.clear());

  it('успех гасит свои строки и не трогает осиротевшую', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '111111' }) });
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Общая очистка дня унесла бы вместе с отправленными строками введённое по источнику, которого
    // в отчёте уже нет (Р12).
    await waitFor(() => expect(draft().items['route:route-1']).toBeUndefined());
    expect(draft().items['route:route-gone']?.item.odometerKm).toBe('111111');
    expect(orphanBlocks()).toHaveLength(1);
  });

  it('правку, сделанную пока запрос был в пути, успех не гасит', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted = reportOf([{ ...routeItem, reading: readingOf(145320) }], {
      state: 'submitted',
      version: 4,
    });
    const { http } = renderCabinet([routeItem], {
      submit: async () => {
        await gate;
        return json(submitted);
      },
    });
    await waitForBlocks();

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Пока `POST` был в пути, строку переписали: эта правка сделана позже отправленной.
    type(odometer(routeItem.id), '146000');
    release!();

    // Погасить её значило бы выбросить то, чего сервер не видел: она остаётся значением и уйдёт
    // следующей попыткой, со своим ключом (Р12, Р12а).
    await waitFor(() => expect(draft().items['route:route-1']?.item.odometerKm).toBe('146000'));
    expect(odometer(routeItem.id).value).toBe('146000');
  });

  it('потерянный ответ после коммита повторяется исходной парой «ключ + версия»', async () => {
    const first = renderCabinet([routeItem], {
      // Связь в поле рвётся именно так: сервер команду принял, а ответ не доехал.
      submit: () => {
        throw new TypeError('Связь оборвалась');
      },
    });
    await waitForBlocks();
    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(first.http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(await screen.findByText('Связь оборвалась')).toBeDefined();
    first.unmount();

    // Сервер поднял версию до 6, и свежий `GET` после перезагрузки вернул именно её.
    const second = renderCabinet([routeItem], {
      open: () => json(reportOf([routeItem], { version: 6 })),
    });
    await waitForBlocks();
    await submitSheet();
    await waitFor(() => expect(second.http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Правило «версия изменилась — ключ новый» дало бы вторую отправку того же дня. Повторяется
    // ровно исходная пара: сервер сверяет ключ раньше версии и на повтор отвечает состоянием (Р12а).
    expect(submitBody(second.http).version).toBe(3);
    expect(idempotencyKeys(second.sent)[0]).toBe(idempotencyKeys(first.sent)[0]);
  });

  it('известный отказ закрывает попытку и лечится перечитыванием, а не открытием', async () => {
    const { http, sent } = renderCabinet([routeItem], {
      stored: reportOf([routeItem]),
      submit: () => apiError(409, { code: 'version_conflict', message: 'Отчёт изменился' }),
    });
    await waitForBlocks();
    // Открытие уходит с задержкой: не дождавшись первого, проверка «второго `open` не было»
    // доказывала бы лишь то, что и первый уйти не успел.
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/open')).toBe(1), {
      timeout: 3000,
    });
    const reads = reportReads(http);

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Ответ сервера — исход известный: повторять эту команду нечего, повторяется только обрыв.
    await waitFor(() => expect(draft().attempts[0]?.state).toBe('rejected'));

    /*
     * Строки перечитываются чтением, а не открытием: `openReport` берёт блокировки машин, отчёта и
     * источников ДО проверки состояния, и по принятому или аннулированному дню это была бы тяжёлая
     * транзакция без единого следствия — ровно то, что Р2 и запрещает.
     */
    await waitFor(() => expect(reportReads(http)).toBe(reads + 1));
    expect(http.countOf('POST /driver/reports/:date/open')).toBe(1);

    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(2));
    const keys = idempotencyKeys(sent);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('ошибка шлюза попытку не закрывает: повтор идёт тем же ключом', async () => {
    const { http, sent } = renderCabinet([routeItem], {
      submit: () => apiError(502, { code: 'error', message: 'Bad gateway' }),
    });
    await waitForBlocks();

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(await screen.findByText('Bad gateway')).toBeDefined();

    /*
     * Р12а различает «сервер сказал об исходе» и «ответа не было». 502 приходит от шлюза, за
     * которым транзакция API могла и закоммититься: исхода не назвал никто, попытка остаётся
     * незавершённой, и повтор уходит ТЕМ ЖЕ ключом — иначе он станет второй отправкой того же дня.
     */
    expect(draft().attempts[0]?.state).toBe('pending');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(2));
    expect(idempotencyKeys(sent)[1]).toBe(idempotencyKeys(sent)[0]);
  });

  it('перенос делает прежнюю попытку недействительной: у отправки свой ключ', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '111111' }) });
    const { http, sent } = renderCabinet([routeItem], {
      // Обрыв: ответа не было вовсе, и попытка остаётся незавершённой — её ключ и повторяют.
      submit: () => {
        throw new TypeError('Связь оборвалась');
      },
    });
    await waitForBlocks();

    type(odometer(routeItem.id), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(await screen.findByText('Связь оборвалась')).toBeDefined();

    // То же тело — та же команда: повтор уходит тем же ключом, и сервер отвечает на него
    // состоянием, а не вторым приёмом показаний.
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(2));
    expect(idempotencyKeys(sent)[1]).toBe(idempotencyKeys(sent)[0]);

    // Перенос меняет состав тела — значит следующая отправка это уже другая команда (Р14а п. 6).
    // Отдельного действия здесь нет: отпечаток разошёлся, и этого достаточно.
    fireEvent.click(screen.getByRole('button', { name: 'Перенести' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(odometer(routeItem.id).value).toBe('111111'));

    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(3));
    expect(idempotencyKeys(sent)[2]).not.toBe(idempotencyKeys(sent)[0]);
  });

  it('тело и надгробия считаются по одному снимку черновика', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();
    type(odometer(routeItem.id), '145320');
    await waitFor(() => expect(draft().items['route:route-1']?.item.odometerKm).toBe('145320'));

    // Соседняя вкладка переписала ту же строку, а событие `storage` ещё не пришло: на экране
    // прежнее число, в хранилище — новое. Счётчик старше — победитель слияния определён.
    putBranch('bbbb', { 'route:route-1': item({ odometerKm: '146000' }) }, 5);
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Гасить надо по тому снимку, который ушёл на сервер (Р12): собранное двумя чтениями — телом
    // из рендера и надгробиями из свежего чтения — отправило бы одно число, а стёрло другое.
    expect(submitBody(http).items[0]!.reading).toMatchObject({ odometerKm: 146000 });
    await waitFor(() => expect(draft().items['route:route-1']).toBeUndefined());
  });

  it('поздний ответ отправки не подставляет черновик соседнего дня', async () => {
    putBranch('aaaa', { 'route:route-gone': item({ odometerKm: '111111' }) });
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { http } = renderCabinet([esm2Item], {
      submit: async () => {
        await held;
        return json(reportOf([esm2Item], { state: 'submitted', version: 4 }));
      },
    });
    await waitForBlocks();

    type(odometer(esm2Item.id), '9812');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    /*
     * Страница при смене даты НЕ перемонтируется: маршрут тот же, меняется `?date=`. Значит
     * отправка и аплоад живут дольше показа своего дня и возвращаются уже в чужой — а у недельного
     * ЭСМ-2 ключ источника один на несколько дат, и черновик 19-го встал бы в форму 20-го.
     */
    fireEvent.click(screen.getByLabelText('Предыдущий день'));
    const yesterday = dayjs(today).subtract(1, 'day').format('D MMMM');
    expect(await screen.findByText(`Показания за ${yesterday}`)).toBeDefined();
    release!();

    // В хранилище запись ушла по своей дате, и это правильно: отправка касалась именно того дня.
    await waitFor(() => expect(draft().attempts[0]?.state).toBe('succeeded'));
    expect(draft().items['esm2:wb-1']).toBeUndefined();
    expect(draft().items['route:route-gone']?.item.odometerKm).toBe('111111');

    // А в состояние страницы результат не попал: ни «Показания переданы» над днём, которого
    // отправка не касалась, ни чужого черновика с его несопоставленной записью.
    expect(screen.queryByText('Показания переданы')).toBeNull();
    await waitForBlocks();
    expect(orphanBlocks()).toHaveLength(0);
    expect(odometer(esm2Item.id).value).toBe('');
  });

  it('отказ хранилища не меняет ни экрана, ни попытки', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();
    type(odometer(routeItem.id), '145320');
    await waitFor(() => expect(draft().items['route:route-1']?.item.odometerKm).toBe('145320'));

    const quota = new DOMException('переполнено', 'QuotaExceededError');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota;
    });

    type(odometer(routeItem.id), '146000');
    expect(await screen.findByText(STORAGE_REFUSED)).toBeDefined();

    // Проглоченный отказ дал бы худший исход: на экране одно, в единственной копии — другое.
    await submitSheet();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    setItem.mockRestore();
    expect(draft().items['route:route-1']?.item.odometerKm).toBe('145320');
    expect(draft().attempts).toHaveLength(0);
    expect(odometer(routeItem.id).value).toBe('145320');
  });

  it('правка соседней вкладки перерисовывает форму', async () => {
    renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    // Событие спасает не запись, а экран: браузер шлёт его другим вкладкам того же происхождения
    // уже после того, как чужая ветка легла в хранилище (Р11в).
    putBranch('bbbb', { 'esm2:wb-1': item({ odometerKm: '9812' }) });
    fireStorage('bbbb');

    await waitFor(() => expect(odometer(esm2Item.id).value).toBe('9812'));
    expect(within(blockOf(routeItem.id)).getAllByRole('textbox').length).toBeGreaterThan(0);
  });
});
