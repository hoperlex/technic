import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  DriverAssignmentDto,
  DriverPreviousReading,
  DriverReportDto,
  ReportItemDto,
  ReportSubmitBody,
  VehicleReadingDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';
import type { DraftItem } from '../src/pages/driver/api';

/**
 * Передача показаний из кабинета водителя (ADR 0103; план docs/driver-cabinet-ux-plan.md, Р4 и Р6;
 * план docs/driver-readings-first-plan.md, Р1 и Р4).
 *
 * Проверяется форма отправки как протокол, а не как разметка. Блок — на каждую строку ожидания,
 * потому что строки заводит сервер по источникам дня, и своего состава портал не выдумывает.
 *
 * Форма — сама index-страница кабинета, а не лист поверх задания: блоки есть сразу после входа, и
 * хелпера «открой оверлей» здесь больше нет. Открытие отчёта от этого не изменилось — тот же
 * `POST …/open`, только по показу дня, а не по нажатию кнопки.
 *
 * Два правила ввода, ради которых набор и переписан:
 *
 * 1. **Вида «нет возможности снять показания» у водителя нет** (Р4). Строку без показаний закрывает
 *    персонал — с причиной, которую знает человек; поля, которым водитель мог отписаться от ввода,
 *    в форме нет вовсе, и сервер такую отправку от него не принимает.
 * 2. **Предупреждения показываются во время ввода, а не после отправки** (Р6). Мягкое — значение
 *    меньше предыдущего или прирост выше суточного порога — снимается галочкой: странное число
 *    бывает правдой. Грубое — значение вне абсолютных границ — не снимается ничем: это опечатка в
 *    разряде, и подтверждать её бессмысленно.
 *
 * Предыдущий снимок счётчиков приходит в задании (`previous`), а не в отчёте: по нему стоит подпись
 * под полем и считаются оба мягких предупреждения. Его может не быть — начало ряда законно, и форма
 * обязана работать без него.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');

/**
 * jsdom не реализует `scrollIntoView`, а отказ отправки приводит к первому незаполненному блоку
 * (ADR 0094). Без заглушки тест падал бы на отсутствующем методе браузера, а не на смысле; саму
 * прокрутку в jsdom всё равно не проверить — размеры там нулевые.
 */
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

/** Строка ожидания приходит из `open` с идентификатором: до него записывать некуда (Р13). */
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

/**
 * Предыдущий снимок счётчиков машины. Двое суток назад — это и есть множитель порога: суточные
 * 1500 км превращаются в 3000, и прирост между ними предупреждения не вызывает.
 */
const previousSnapshot: DriverPreviousReading = {
  odometerKm: 145320,
  engineHours: 9812.5,
  measuredOn: '2026-08-10',
  daysAgo: 2,
};

/** Показание прошлой отправки с непризнанной аномалией одометра — с тем, с чем сравнивали (Р20). */
const jumpedReading: VehicleReadingDto = {
  id: 'reading-1',
  itemId: routeItem.id,
  kind: 'values',
  odometerKm: 145320,
  engineHours: null,
  fuelStartLiters: null,
  fuelFilledLiters: null,
  fuelEndLiters: null,
  noDataReason: '',
  comment: '',
  source: 'driver',
  recordedAt: `${today}T10:00:00.000Z`,
  odometerAnomaly: {
    kind: 'implausible_jump',
    confirmed: false,
    previousValue: 140000,
    previousDate: '2026-08-10',
  },
  engineHoursAnomaly: null,
  odometerDelta: 5320,
  engineHoursDelta: null,
  fileIds: [],
};

/** Строка, закрытая персоналом: чисел в ней нет и не будет, причину написал человек (Р4). */
const staffNoData: VehicleReadingDto = {
  ...jumpedReading,
  id: 'reading-2',
  kind: 'no_data',
  odometerKm: null,
  noDataReason: 'Счётчик неисправен, машину увёл сменщик',
  source: 'staff',
  odometerAnomaly: null,
  odometerDelta: null,
};

/**
 * Уже сохранённое показание вида `values` без всяких аномалий: его числа приезжают в поля, и
 * очистка последнего из них — команда, а не молчание (Р6).
 */
const storedValues: VehicleReadingDto = {
  ...jumpedReading,
  id: 'reading-4',
  odometerAnomaly: null,
  odometerDelta: null,
};

const photoFile = { id: 'file-1', filename: 'щиток.jpg', contentType: 'image/jpeg', size: 1024 };

/** Введённое по одной строке — все пять чисел в порядке смены (ADR 0163). */
const draftItem = (patch: Partial<DraftItem> = {}): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  fuelStartLiters: '',
  fuelFilledLiters: '',
  fuelEndLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
  ...patch,
});

const V2_PREFIX = `technic:driver-draft-v2:${driver.id}:${today}:`;

/**
 * Ветка черновика соседней загрузки страницы — ячейка хранилища, написанная руками. Своя ветка у
 * модуля одна на весь прогон, и разводить их значением нечем (Р11в); а состояние «в блоке лежит
 * загруженный файл и ни одного числа» другим способом в jsdom и не получить.
 */
function putBranch(branch: string, entries: Record<string, DraftItem>): void {
  const savedAt = Date.now();
  localStorage.setItem(
    `${V2_PREFIX}${branch}`,
    JSON.stringify({
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          { clock: { counter: 1, branch }, savedAt, item: value },
        ]),
      ),
      legacy: [],
      attempts: [],
    }),
  );
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

/**
 * Задание дня: оно рисует кнопку шапки (Р10) и оно же несёт предыдущий снимок счётчиков, с которым
 * форма сверяет ввод. Строки задания и строки ожидания сходятся по источнику — `itemId` в задании
 * появляется только после открытия отчёта.
 */
function assignmentOf(
  items: ReportItemDto[],
  previous: Record<string, DriverPreviousReading> = {},
  canSubmit = true,
): DriverAssignmentDto {
  return {
    date: today,
    canSubmit,
    entries: items.map((item) => ({
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      sourceLabel: item.sourceLabel,
      purposeLabel: 'Грузоперевозка',
      vehicleLabel: item.vehicleLabel,
      garageNumber: '',
      trailerLabel: '',
      itemId: item.id,
      shiftOrder: item.shiftOrder,
      // Показания к порядку объезда не привязаны: сценарий проверяет счётчики, а не задание.
      points: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
      previous: previous[item.sourceId] ?? null,
    })),
  };
}

interface SentRequest {
  path: string;
  headers: Record<string, string>;
}

interface CabinetOptions {
  /** Окно записи: сервер закрывает его сам, портал берёт ответ из задания и не считает его сам. */
  canSubmit?: boolean;
  /** Сохранённый отчёт дня (`GET`): им, а не ответом `open`, называется состояние дня над формой. */
  stored?: DriverReportDto | null;
}

function renderCabinet(
  items: ReportItemDto[],
  previous: Record<string, DriverPreviousReading> = {},
  options: CabinetOptions = {},
) {
  const http = mockHttp({
    'GET /driver/assignment': () => json(assignmentOf(items, previous, options.canSubmit ?? true)),
    'GET /driver/reports/:date': () => json(options.stored ?? null),
    // Показ дня и есть открытие отчёта: строки ожидания приходят отсюда с их `itemId`.
    'POST /driver/reports/:date/open': () => json(reportOf(items)),
    'POST /driver/reports/:date/submit': () =>
      json(reportOf(items, { state: 'submitted', version: 4 })),
  });

  /*
   * Заголовки `mockHttp` не журналирует — ему хватает метода, пути и тела. Ключ идемпотентности
   * живёт именно заголовком (Р25: он свойство попытки, а не её тела), поэтому запросы
   * подсматриваются поверх мока: снимать подмену не нужно — общий хук возвращает настоящий `fetch`
   * после каждого теста.
   */
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

/**
 * Ждёт блоки строк. Нажатий здесь нет ни одного — и это предмет проверки, а не удобство: кабинет
 * открывается формой, и до ответа `open` блоков нет, потому что записывать некуда (Р13).
 *
 * Ждёт дольше секунды по умолчанию: `open` уходит с задержкой (Р7) — ею отсекаются промежуточные
 * дни при листании стрелками, — и строки приходят после неё.
 */
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

/**
 * Поле блока — по его подписи в обёртке-`label`. Роль по такому DOM спрашивать дорого, а подпись
 * и есть то, по чему поле находит человек.
 */
function field(scope: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = [...scope.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = wrapper?.querySelector('input, textarea');
  if (!input) throw new Error(`Поля «${label}» нет в блоке`);
  return input as HTMLInputElement | HTMLTextAreaElement;
}

/**
 * Группа полей одного момента смены — «Начало смены», «За смену», «Конец смены» (Р7).
 *
 * Ищется не для красоты: подписи полей укоротились до «Одометр», «Моточасы», «Топливо», и два
 * поля топлива различаются РОВНО заголовком группы. Поиск по одной подписи всегда находил бы
 * первое, то есть остаток на начало, — и караул на конец смены молча проверял бы утро.
 */
function group(scope: HTMLElement, title: string): HTMLElement {
  const heading = [...scope.querySelectorAll('strong')].find((el) => el.textContent === title);
  const box = heading?.closest('div');
  if (!box) throw new Error(`Группы «${title}» нет в блоке`);
  return box as HTMLElement;
}

/** Остаток в баке на начало смены — первая группа блока. */
const fuelStart = (itemId: string) =>
  field(group(blockOf(itemId), 'Начало смены'), 'Топливо') as HTMLInputElement;

/** Остаток в баке на конец смены — третья группа, рядом со счётчиками. */
const fuelEnd = (itemId: string) =>
  field(group(blockOf(itemId), 'Конец смены'), 'Топливо') as HTMLInputElement;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

/** Подсказка Р8 — серой строкой под группой «Конец смены», а не запретом отправки. */
const EVENING_HINT = 'Вечерние показания ещё не переданы — снимите их в конце смены';

/**
 * Строка пустого открытого дня (Р6). Стоит в подвале, у самой кнопки: человек смотрит на то, что
 * только что нажал, и объяснению место там же, а не тостом, уехавшим за клавиатуру.
 */
const DAY_BLANK = 'Заполните хотя бы одно значение: пока в дне нет ни одного числа';

/** Подвал: и кнопка, и причина, по которой нажатие не дало отправки, живут в нём (Р10, Р6). */
function footer(): HTMLElement {
  const element = document.querySelector('.driver-footer');
  if (!element) throw new Error('Подвала на экране нет');
  return element as HTMLElement;
}

/** Галочка «Всё верно» стоит в самом предупреждении: подтверждают то, что показано. */
function confirmBox(itemId: string): HTMLInputElement | null {
  return blockOf(itemId).querySelector('input[type="checkbox"]');
}

/**
 * Кнопка отправки — в закреплённом подвале страницы; строка состояния дня над формой называется
 * иначе («Передать показания»), и точное совпадение подписи их разводит.
 *
 * Клика ждёт: пока состояние дня неизвестно (отчёт дня ещё не прочитан), кнопка выключена — как
 * прежде ждала кнопка шапки, не пуская в лист над уже принятым днём.
 */
async function submitSheet(): Promise<void> {
  const button = await screen.findByText('Передать');
  await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
  fireEvent.click(button);
}

function submitBody(http: ReturnType<typeof mockHttp>): ReportSubmitBody {
  return http.lastCall('POST /driver/reports/:date/submit')?.body as ReportSubmitBody;
}

describe('кабинет водителя: передача показаний', () => {
  // Черновик лежит в localStorage по ключу «учётка + дата» и пережил бы соседний тест, подменив
  // ему введённое: чистим перед каждым — как чистит его выход из учётной записи.
  beforeEach(() => localStorage.clear());

  it('вход в кабинет рисует блоки без единого нажатия', async () => {
    const { http } = renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    // Р1: кабинет открывается формой показаний. Ни одного `fireEvent` в этом тесте нет намеренно —
    // прежде до блоков добирались нажатием кнопки шапки поверх задания.
    expect(http.countOf('POST /driver/reports/:date/open')).toBe(1);
    // Дата в заголовке — та, что выбрана в шапке: передают показания за конкретный день.
    expect(screen.getByText(`Показания за ${dayjs(today).format('D MMMM')}`)).toBeDefined();
    // Блоков ровно столько, сколько строк ожидания завёл сервер: за день по одной машине бывает
    // две смены, и общая форма склеила бы их показания.
    expect(document.querySelectorAll('[id^="reading-"]')).toHaveLength(2);

    const route = blockOf(routeItem.id);
    expect(within(route).getByText('Рейс Р-142')).toBeDefined();
    expect(within(route).getByText('КамАЗ 65115 · А123ВС799')).toBeDefined();
    expect(within(blockOf(esm2Item.id)).getByText('ЭСМ-2 № 000123')).toBeDefined();
  });

  it('строка над формой называет состояние дня, а не действие', async () => {
    // Р4: слова кнопки шапки не пропали вместе с кнопкой — они переехали строкой над формой.
    // Состояние берётся из сохранённого отчёта, а не из ответа `open`: тот всегда `draft`, и
    // «Черновик» стояло бы над каждым нетронутым днём.
    renderCabinet([routeItem], {}, { stored: reportOf([routeItem], { state: 'submitted' }) });
    await waitForBlocks();

    expect(await screen.findByText('Передано')).toBeDefined();
    expect(screen.getByText('Можно поправить, пока день не приняли')).toBeDefined();
    // Кнопка «Передать» при этом жива: переданное правят, пока день не приняли.
    expect(screen.getByText('Передать').closest('button')?.disabled).toBe(false);
  });

  it('день вне окна записи: причина названа словами, а кнопки «Передать» нет', async () => {
    // Окно записи держит сервер (`canSubmit`), портал его не вычисляет. Отчёт у такого дня уже
    // сохранённый: строки заводит `open`, а за границей окна записи он не зовётся вовсе — клетки
    // матрицы разобраны в driver-day-matrix.
    renderCabinet([routeItem], {}, { canSubmit: false, stored: reportOf([routeItem]) });
    await waitForBlocks();

    // Прежде на этом месте была выключенная кнопка шапки, не пускавшая в лист. Теперь кнопки нет
    // вовсе, а причину называет подвал — теми же словами, что и строка состояния над формой (Р10).
    expect(await screen.findByText('Черновик')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Передать' })).toBeNull();
    const footer = document.querySelector('.driver-footer');
    expect(footer?.textContent).toContain('Показания принимаются за сегодня');
  });

  it('переключателя «нет возможности снять показания» в форме нет', async () => {
    renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // Р4: строку без показаний закрывает персонал с причиной, которую знает человек. У водителя
    // поля, которым можно отписаться от ввода, нет вовсе — ни переключателя, ни причины.
    expect(block.querySelector('button[role="switch"]')).toBeNull();
    expect(within(block).queryByText('Нет возможности снять показания')).toBeNull();
    expect(within(block).queryByText('Причина')).toBeNull();
    // Числовые поля при этом на месте и не спрятаны ни за каким видом показания.
    expect(within(block).getByText('Одометр')).toBeDefined();
    expect(within(block).getByText('Моточасы')).toBeDefined();
  });

  it('строку, закрытую персоналом, водитель читает и не отправляет заново', async () => {
    const { http } = renderCabinet([{ ...routeItem, reading: staffNoData }, esm2Item]);
    await waitForBlocks();
    const closed = blockOf(routeItem.id);

    // Пустой блок над закрытой строкой водитель принял бы за свою недоделку: портал называет, кто
    // и почему её закрыл.
    expect(within(closed).getByText('Строку закрыл диспетчер')).toBeDefined();
    expect(within(closed).getByText('Счётчик неисправен, машину увёл сменщик')).toBeDefined();

    type(field(blockOf(esm2Item.id), 'Моточасы'), '9812.5');
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Закрытая строка в отправку не идёт: чисел у неё нет, а вида `no_data` водителю больше не
    // дают — иначе один такой блок не давал бы сдать весь день.
    expect(submitBody(http).items.map((entry) => entry.itemId)).toEqual([esm2Item.id]);
  });

  it('под полем стоит предыдущее показание, а без снимка форма работает по-прежнему', async () => {
    const { http } = renderCabinet([routeItem, esm2Item], {
      [routeItem.sourceId]: previousSnapshot,
    });
    await waitForBlocks();

    // П1: водитель сверяет два числа глазами до того, как ошибётся. Разряды разделены при выводе
    // (П2) — при наборе группировка ломала бы позицию курсора.
    const withPrevious = blockOf(routeItem.id);
    expect(within(withPrevious).getByText('предыдущее: 145 320 (10.08)')).toBeDefined();
    expect(within(withPrevious).getByText('предыдущее: 9 812,5 (10.08)')).toBeDefined();

    // Начало ряда — законное состояние, а не ошибка: подписи нет, и форма отправляется как обычно.
    const withoutPrevious = blockOf(esm2Item.id);
    expect(within(withoutPrevious).queryByText(/предыдущее/u)).toBeNull();

    type(field(withPrevious, 'Одометр'), '145400');
    type(field(withoutPrevious, 'Моточасы'), '10');
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
  });

  it('значение меньше предыдущего уходит только с подтверждением', async () => {
    const { http } = renderCabinet([routeItem], { [routeItem.sourceId]: previousSnapshot });
    await waitForBlocks();

    type(field(blockOf(routeItem.id), 'Одометр'), '140000');

    // Предупреждение показано во время ввода и называет то, с чем сравнивали: «невероятно» без
    // «от чего» человеку нечем проверить.
    expect(
      within(blockOf(routeItem.id)).getByText('Одометр: меньше предыдущего (145 320 от 10.08)'),
    ).toBeDefined();

    await submitSheet();
    expect(
      await within(blockOf(routeItem.id)).findByText('Подтвердите значение галочкой «Всё верно»'),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    // Сброшенный или заменённый счётчик — не ошибка ввода, и подтверждённое число уходит вместе с
    // самим подтверждением: разбирается с ним сервер (Р20).
    fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]).toMatchObject({
      itemId: routeItem.id,
      confirmOdometerAnomaly: true,
    });
    expect(submitBody(http).items[0]!.reading).toMatchObject({ odometerKm: 140000 });
  });

  it('невероятный прирост считается по суточному порогу, умноженному на прошедшие дни', async () => {
    const { http } = renderCabinet([routeItem], { [routeItem.sourceId]: previousSnapshot });
    await waitForBlocks();
    const odometer = field(blockOf(routeItem.id), 'Одометр');

    // Прошло двое суток, суточный порог — 1500 км из readingLimits: 1680 км за два дня нормальны,
    // и предупреждать здесь означало бы приучить водителя щёлкать галочку не глядя.
    type(odometer, '147000');
    expect(within(blockOf(routeItem.id)).queryByText(/прирост/u)).toBeNull();

    type(odometer, '149000');
    expect(
      within(blockOf(routeItem.id)).getByText('Одометр: прирост 3 680 км за 2 дня — проверьте'),
    ).toBeDefined();

    await submitSheet();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]).toMatchObject({ confirmOdometerAnomaly: true });
  });

  it('значение вне абсолютных границ не уходит ни с какой галочкой', async () => {
    const { http } = renderCabinet([routeItem], { [routeItem.sourceId]: previousSnapshot });
    await waitForBlocks();

    // Моточасы ниже предыдущих — мягкое предупреждение: галочка на экране появляется.
    type(field(blockOf(routeItem.id), 'Моточасы'), '9000');
    // Одометр в семь знаков — грубое: столько ни один одометр не показывает, и это опечатка в
    // разряде, а не факт.
    type(field(blockOf(routeItem.id), 'Одометр'), '9999999');
    expect(
      within(blockOf(routeItem.id)).getByText('Проверьте разряд: столько одометр не показывает'),
    ).toBeDefined();

    fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    // Подтверждать опечатку бессмысленно: водитель подтвердит её так же, как набрал (Р6).
    await waitFor(() =>
      expect(
        within(blockOf(routeItem.id)).getByText('Проверьте разряд: столько одометр не показывает'),
      ).toBeDefined(),
    );
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    // Исправленный разряд отправку освобождает — вместе с подтверждением мягкого предупреждения.
    type(field(blockOf(routeItem.id), 'Одометр'), '146000');
    if (!confirmBox(routeItem.id)!.checked) fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      odometerKm: 146000,
      engineHours: 9000,
    });
  });

  it('день с двумя машинами уходит с одной заполненной, а вторая остаётся ждать', async () => {
    const { http } = renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    // Р6 — самая существенная правка портала выпуска, и она не про топливо: прежде пустой блок
    // держал весь день, и водитель с двумя машинами не мог сдать утром одну. Караул на прежнее
    // поведение стоял здесь же и закреплял ровно то, что решение отменило (Н1).
    type(field(blockOf(routeItem.id), 'Одометр'), '145320');
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Нетронутая строка в тело не идёт — и не отказом, а пропуском: «сюда ещё не дошли» не команда,
    // и сервер, получив её пустой, оставил бы в базе прежнее.
    expect(submitBody(http).items.map((entry) => entry.itemId)).toEqual([routeItem.id]);
    // Ни одного отказа на экране: вторая машина ждёт вечера, а не краснеет за человека.
    expect(screen.queryByText(/Заполните хотя бы одно значение/u)).toBeNull();
    // Блок второй машины при этом на месте: её ещё сдавать.
    expect(field(blockOf(esm2Item.id), 'Одометр').value).toBe('');
  });

  it('день, где не заполнено ничего, не уходит, и причину называет подвал', async () => {
    const { http } = renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    await submitSheet();

    /*
     * Второй конец того же решения (Р6). Пустой блок отправку не держит — значит нажатие «Передать»
     * на нетронутом дне не ответило бы вовсе: тело пустое, отказов схемы нет, показывать нечего.
     * Поэтому сборка тела возвращает признак пустого открытого дня, а подвал говорит словами — там,
     * где стоит кнопка, а не подсветкой всех блоков разом и не тостом за клавиатурой.
     */
    expect(await screen.findByText(DAY_BLANK)).toBeDefined();
    expect(footer().textContent).toContain(DAY_BLANK);
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    // И гаснет она первой же правкой: строка подвала, пережившая день, в котором уже есть что
    // передать, врала бы человеку ровно тогда, когда он всё исправил.
    type(field(blockOf(routeItem.id), 'Одометр'), '145320');
    await waitFor(() => expect(screen.queryByText(DAY_BLANK)).toBeNull());
  });

  it('день, целиком закрытый персоналом, сохраняет своё отдельное сообщение', async () => {
    const { http } = renderCabinet([
      { ...routeItem, reading: staffNoData },
      { ...esm2Item, reading: { ...staffNoData, id: 'reading-3', itemId: esm2Item.id } },
    ]);
    await waitForBlocks();

    await submitSheet();

    /*
     * Нулевое тело имеет два разных объяснения, и путать их нельзя (Р6). Здесь передавать нечего
     * не потому, что человек не начал, а потому, что за него всё закрыл персонал: это новость, а
     * не подсказка, и она остаётся тостом. Скажи ему тут «заполните хотя бы одно значение» — и он
     * пошёл бы искать поля, которых у закрытой строки нет.
     */
    expect(
      await screen.findByText('Передавать нечего: строки этого дня уже закрыты'),
    ).toBeDefined();
    expect(screen.queryByText(DAY_BLANK)).toBeNull();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);
  });

  it('комментарий и файл без единого числа за пустой блок не сходят', async () => {
    // Файл до отправки ничей и живёт в черновике: набрать его в jsdom нечем, а вот положить в
    // ветку — ровно то же состояние, в котором его застаёт нажатие «Передать».
    putBranch('aaaa', { 'esm2:wb-1': draftItem({ files: [photoFile] }) });
    const { http } = renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    type(field(blockOf(routeItem.id), 'Комментарий'), 'одометр не работает, снять нечем');
    await submitSheet();

    /*
     * Пустотой считаются только числа (Р6). Человек, написавший «одометр не работает» или
     * приложивший фото щитка, ждёт, что это уедет: пропусти такой блок — и текст с вложением
     * исчезли бы без единого слова, а портал показал бы успех. Ему отвечает схема, и отказ стоит
     * на его собственном блоке.
     */
    expect(
      await within(blockOf(routeItem.id)).findByText(/Заполните хотя бы одно значение/u),
    ).toBeDefined();
    expect(
      within(blockOf(esm2Item.id)).getByText(/Заполните хотя бы одно значение/u),
    ).toBeDefined();
    // Отказ поля старше строки подвала: он конкретнее и приводит к самому блоку.
    expect(screen.queryByText(DAY_BLANK)).toBeNull();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);
  });

  it('очистка последнего числа существующего показания даёт отказ, а не молчание', async () => {
    const { http } = renderCabinet([{ ...routeItem, reading: storedValues }]);
    await waitForBlocks();
    const odometer = field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement;
    expect(odometer.value).toBe('145320');

    // Человек стёр последнее число уже сохранённого показания. Отсюда это выглядит так же, как
    // нетронутая новая строка, — а означает противоположное: не «сюда ещё не дошли», а команда.
    type(odometer, '');
    await submitSheet();

    /*
     * Пропуск здесь был бы худшим исходом из возможных: тело уехало бы без строки, сервер оставил
     * бы в базе прежние 145 320, а портал отчитался бы успехом — очистка исчезла бы молча. Поэтому
     * опустошённый `values` обязан дойти до схемы и получить оттуда отказ.
     */
    expect(
      await within(blockOf(routeItem.id)).findByText(/Заполните хотя бы одно значение/u),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);
    expect(screen.queryByText(DAY_BLANK)).toBeNull();
  });

  it('потолок в 1000 л держит оба остатка, а суточный порог к ним не применяется', async () => {
    // Снимок предыдущей смены есть — и это половина проверки: у остатков ни порога прироста в
    // `PER_DAY`, ни прошлого значения в контракте нет намеренно (Р10). Появись он — сравнение
    // остатков между сменами и стало бы тем расходом, который заказчик отложил (Р3).
    const { http } = renderCabinet([routeItem], { [routeItem.sourceId]: previousSnapshot });
    await waitForBlocks();

    // Потолок общий с заправкой и тот же у обоих концов смены: остаток и заправку меряют одним
    // баком. Грубая ошибка — отправку не пускает и галочкой не снимается.
    type(fuelStart(routeItem.id), '1200');
    expect(
      within(group(blockOf(routeItem.id), 'Начало смены')).getByText(
        'Проверьте разряд: столько в бак не входит',
      ),
    ).toBeDefined();
    await submitSheet();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(fuelStart(routeItem.id), '900');
    type(fuelEnd(routeItem.id), '1500');
    expect(
      within(group(blockOf(routeItem.id), 'Конец смены')).getByText(
        'Проверьте разряд: столько в бак не входит',
      ),
    ).toBeDefined();
    await submitSheet();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    // 900 → 20 за смену: у счётчика такой скачок дал бы мягкое предупреждение с галочкой, а у бака
    // это обычный день — за ночь его сливают, доливают со стороны и меняют машину под человеком.
    type(fuelEnd(routeItem.id), '20');
    expect(within(blockOf(routeItem.id)).queryByText(/прирост|меньше предыдущего/u)).toBeNull();
    expect(confirmBox(routeItem.id)).toBeNull();
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      fuelStartLiters: 900,
      fuelEndLiters: 20,
    });
  });

  it('подсказка о недосданном вечере появляется от утра или заправки и гаснет счётчиком', async () => {
    renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // Р8 — словами, а не запретом: передать одно утро законно, и отказывать за это нельзя. На
    // нетронутом блоке подсказки нет: она про недосданное, а не про незаполненное.
    expect(within(block).queryByText(EVENING_HINT)).toBeNull();

    type(fuelStart(routeItem.id), '120');
    expect(within(block).getByText(EVENING_HINT)).toBeDefined();

    // Хватает ОДНОГО вечернего числа: что снимать дальше, решает машина, а не портал — на технике
    // без одометра его нет физически.
    type(field(block, 'Одометр'), '145320');
    expect(within(block).queryByText(EVENING_HINT)).toBeNull();

    // Второй повод для подсказки — дневная заправка без утра: формулировка потому и не говорит
    // «сдано начало», что «начала» у такого водителя нет вовсе.
    type(field(block, 'Одометр'), '');
    type(fuelStart(routeItem.id), '');
    type(field(block, 'Заправлено'), '80');
    expect(within(block).getByText(EVENING_HINT)).toBeDefined();

    type(fuelEnd(routeItem.id), '150');
    expect(within(block).queryByText(EVENING_HINT)).toBeNull();
  });

  it('запятая в дробном поле становится точкой', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // На телефоне десятичный разделитель зависит от раскладки: человек набирает тот, что на
    // клавише, и отказывать ему за это нельзя (Р14).
    const hours = field(block, 'Моточасы') as HTMLInputElement;
    type(hours, '9812,5');
    expect(hours.value).toBe('9812.5');

    // Одометр целый по схеме: дробную часть он не принимает на вводе, а не отказом отправки. И
    // отбрасывает её, а не приклеивает к целой: «145 320,7» → «1453207» был бы пробег, выросший в
    // десять раз, — такой и схему пройдёт, и в учёт ляжет.
    const odometer = field(block, 'Одометр') as HTMLInputElement;
    type(odometer, '145 320,7');
    expect(odometer.value).toBe('145320');

    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Число уехало числом, а не строкой с запятой: сервер разбирал бы её как угодно.
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      kind: 'values',
      odometerKm: 145320,
      engineHours: 9812.5,
    });
  });

  it('отправка идёт одним запросом с ключом идемпотентности и своим itemId у каждой строки', async () => {
    const { http, sent } = renderCabinet([routeItem, esm2Item]);
    await waitForBlocks();

    type(field(blockOf(routeItem.id), 'Одометр'), '145320');
    type(field(blockOf(esm2Item.id), 'Моточасы'), '9812.5');
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    const body = submitBody(http);
    // Версия шапки едет с отправкой: состав дня могли изменить, пока оверлей был открыт.
    expect(body.version).toBe(3);
    // Показание принадлежит выезду, а не дню: каждая строка называет свою — иначе показания двух
    // смен одной машины оказались бы неразличимы.
    expect(body.items.map((item) => item.itemId)).toEqual([routeItem.id, esm2Item.id]);
    expect(body.items[0]!.reading).toMatchObject({ odometerKm: 145320 });
    expect(body.items[1]!.reading).toMatchObject({ engineHours: 9812.5 });

    // Ключ идемпотентности — заголовком: повтор после обрыва связи остаётся той же отправкой.
    const submitRequest = sent.filter((r) => r.path.endsWith('/submit')).at(-1);
    expect(submitRequest?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('аномалия сервера показана с предыдущим значением, а подтверждение уезжает следующей отправкой', async () => {
    const { http } = renderCabinet([{ ...routeItem, reading: jumpedReading }]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // Аномалия, записанная сервером по прошлой отправке, показывается рядом с предупреждениями
    // ввода: водителю всё равно, кто именно усомнился, — ответ от него нужен один.
    expect(
      within(block).getByText('Одометр: невероятный прирост (предыдущее 140000 от 10.08.2026)'),
    ).toBeDefined();
    // Числа прошлой отправки стоят в полях: подтверждают показанное, а не вводят заново.
    expect((field(block, 'Одометр') as HTMLInputElement).value).toBe('145320');

    fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Аномалия не отказ, а предупреждение: подтверждение уезжает тем же запросом, что и числа.
    expect(submitBody(http).items[0]).toMatchObject({
      itemId: routeItem.id,
      confirmOdometerAnomaly: true,
    });
  });
  it('открытие отчёта объявляет формат черновика заголовком', async () => {
    const { sent } = renderCabinet([routeItem]);
    await waitForBlocks();

    // Р13: граница, за которой перестают рождаться записи прежнего формата, проводится здесь —
    // ключи черновика делаются из `itemId`, а `itemId` приходит только из `open`. Сборке, которая
    // формат не объявила, сервер отвечает `client_outdated`.
    const openRequest = sent.filter((r) => r.path.endsWith('/open')).at(-1);
    expect(openRequest?.headers['x-driver-draft-format']).toBe('v2');
  });

  it('вторая отправка сразу за первой уходит с версией из ответа и новым ключом', async () => {
    const { http, sent } = renderCabinet([routeItem]);
    await waitForBlocks();

    type(field(blockOf(routeItem.id), 'Одометр'), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Р12: страница после отправки живёт дальше и обязана сама стать «днём после отправки».
    // Прежде это делало закрытие листа; теперь отчёт заменяется ответом, а израсходованный ключ
    // гасится вместе с попыткой — иначе правка сразу за отправкой получала бы 409 дважды: по
    // устаревшей версии и по тому же ключу с другим телом.
    type(field(blockOf(routeItem.id), 'Одометр'), '145400');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(2));

    expect(submitBody(http).version).toBe(4);
    const keys = sent
      .filter((r) => r.path.endsWith('/submit'))
      .map((r) => r.headers['Idempotency-Key']);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
