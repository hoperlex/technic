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

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  fireEvent.change(input, { target: { value } });
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
    expect(within(block).getByText('Одометр на конец смены')).toBeDefined();
    expect(within(block).getByText('Моточасы на конец смены')).toBeDefined();
  });

  it('строку, закрытую персоналом, водитель читает и не отправляет заново', async () => {
    const { http } = renderCabinet([{ ...routeItem, reading: staffNoData }, esm2Item]);
    await waitForBlocks();
    const closed = blockOf(routeItem.id);

    // Пустой блок над закрытой строкой водитель принял бы за свою недоделку: портал называет, кто
    // и почему её закрыл.
    expect(within(closed).getByText('Строку закрыл диспетчер')).toBeDefined();
    expect(within(closed).getByText('Счётчик неисправен, машину увёл сменщик')).toBeDefined();

    type(field(blockOf(esm2Item.id), 'Моточасы на конец смены'), '9812.5');
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

    type(field(withPrevious, 'Одометр на конец смены'), '145400');
    type(field(withoutPrevious, 'Моточасы на конец смены'), '10');
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
  });

  it('значение меньше предыдущего уходит только с подтверждением', async () => {
    const { http } = renderCabinet([routeItem], { [routeItem.sourceId]: previousSnapshot });
    await waitForBlocks();

    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '140000');

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
    const odometer = field(blockOf(routeItem.id), 'Одометр на конец смены');

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
    type(field(blockOf(routeItem.id), 'Моточасы на конец смены'), '9000');
    // Одометр в семь знаков — грубое: столько ни один одометр не показывает, и это опечатка в
    // разряде, а не факт.
    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '9999999');
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
    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '146000');
    if (!confirmBox(routeItem.id)!.checked) fireEvent.click(confirmBox(routeItem.id)!);
    await submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      odometerKm: 146000,
      engineHours: 9000,
    });
  });

  it('пустой блок не отправляется, и портал называет, чего не хватает', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();

    await submitSheet();

    // Ни одно поле не обязательно по отдельности — на технике без одометра его нет физически, —
    // но пустая строка не закрывает день, и отказ говорит об этом словами.
    expect(await screen.findByText(/Заполните хотя бы одно значение/u)).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);
  });

  it('запятая в дробном поле становится точкой', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // На телефоне десятичный разделитель зависит от раскладки: человек набирает тот, что на
    // клавише, и отказывать ему за это нельзя (Р14).
    const hours = field(block, 'Моточасы на конец смены') as HTMLInputElement;
    type(hours, '9812,5');
    expect(hours.value).toBe('9812.5');

    // Одометр целый по схеме: дробную часть он не принимает на вводе, а не отказом отправки. И
    // отбрасывает её, а не приклеивает к целой: «145 320,7» → «1453207» был бы пробег, выросший в
    // десять раз, — такой и схему пройдёт, и в учёт ляжет.
    const odometer = field(block, 'Одометр на конец смены') as HTMLInputElement;
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

    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '145320');
    type(field(blockOf(esm2Item.id), 'Моточасы на конец смены'), '9812.5');
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
    expect((field(block, 'Одометр на конец смены') as HTMLInputElement).value).toBe('145320');

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

    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '145320');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));

    // Р12: страница после отправки живёт дальше и обязана сама стать «днём после отправки».
    // Прежде это делало закрытие листа; теперь отчёт заменяется ответом, а израсходованный ключ
    // гасится вместе с попыткой — иначе правка сразу за отправкой получала бы 409 дважды: по
    // устаревшей версии и по тому же ключу с другим телом.
    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '145400');
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
