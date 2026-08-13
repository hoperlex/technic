import { beforeEach, describe, expect, it } from 'vitest';
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
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverPage } from '../src/pages/driver/DriverPage';

/**
 * Передача показаний из кабинета водителя (ADR 0103): этап 5 плана, решения Р14 и Р18.
 *
 * Проверяется форма отправки как протокол, а не как разметка. Блок — на каждую строку ожидания,
 * потому что строки заводит сервер по источникам дня, и своего состава портал не выдумывает.
 * Показание либо числа, либо `no_data` с причиной — третьего вида нет, и переключатель ровно этим
 * и переключает: без него день по машине с неисправным счётчиком нечем закрыть, а приёмка требует
 * закрытых строк. Отправка идёт одним запросом с ключом идемпотентности в заголовке и `itemId` по
 * каждой строке — плохая связь не должна порождать ни дублей, ни показаний, приписанных чужому
 * выезду. Аномалия — предупреждение, а не отказ: её подтверждают, и подтверждение уезжает следующей
 * отправкой вместе с теми же числами.
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

/** Показание прошлой отправки с непризнанной аномалией одометра — с тем, с чем сравнивали (Р20). */
const jumpedReading: VehicleReadingDto = {
  id: 'reading-1',
  itemId: routeItem.id,
  kind: 'values',
  odometerKm: 145320,
  engineHours: null,
  fuelFilledLiters: null,
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

/** Задание дня: оно и рисует кнопку шапки — без заданий передавать нечего, и кнопки нет (Р10). */
const assignment: DriverAssignmentDto = {
  date: today,
  canSubmit: true,
  entries: [
    {
      sourceKind: 'route',
      sourceId: 'route-1',
      sourceLabel: 'Рейс Р-142',
      purposeLabel: 'Грузоперевозка',
      vehicleLabel: 'КамАЗ 65115 · А123ВС799',
      garageNumber: '',
      trailerLabel: '',
      itemId: null,
      shiftOrder: null,
      requests: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
    },
  ],
};

interface SentRequest {
  path: string;
  headers: Record<string, string>;
}

function renderCabinet(items: ReportItemDto[]) {
  const http = mockHttp({
    'GET /driver/assignment': () => json(assignment),
    'GET /driver/reports/:date': () => json(null),
    // Открытие оверлея и есть открытие отчёта: строки ожидания приходят отсюда с их `itemId`.
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
      <DriverPage />
    </DriverLayout>,
    { user: driver, route: '/driver' },
  );
  return { ...rendered, http, sent };
}

/** Открывает оверлей и дожидается строк: до ответа `open` блоков нет и записывать некуда. */
async function openSheet(): Promise<void> {
  const button = await screen.findByText('Передать показания');
  // Пока состояние отчёта дня неизвестно, кнопка в загрузке и клик игнорирует — ждём ответа.
  await waitFor(() => expect(button.closest('button')?.className).not.toMatch(/loading/u));
  fireEvent.click(button);
  await waitFor(() =>
    expect(document.querySelectorAll('[id^="reading-"]').length).toBeGreaterThan(0),
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

/** Кнопка отправки — в липком подвале листа; подпись шапки («Передать показания») другая. */
function submitSheet(): void {
  fireEvent.click(screen.getByText('Передать'));
}

function submitBody(http: ReturnType<typeof mockHttp>): ReportSubmitBody {
  return http.lastCall('POST /driver/reports/:date/submit')?.body as ReportSubmitBody;
}

describe('кабинет водителя: передача показаний', () => {
  // Черновик лежит в localStorage по ключу «учётка + дата» и пережил бы соседний тест, подменив
  // ему введённое: чистим перед каждым — как чистит его выход из учётной записи.
  beforeEach(() => localStorage.clear());

  it('оверлей открывается блоком на каждую строку задания', async () => {
    renderCabinet([routeItem, esm2Item]);
    await openSheet();

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

  it('«нет возможности снять показания» гасит числа, требует причину и закрывает строку', async () => {
    const { http } = renderCabinet([routeItem]);
    await openSheet();
    const block = blockOf(routeItem.id);
    const toggle = block.querySelector('button[role="switch"]');
    expect(toggle).not.toBeNull();

    type(field(block, 'Одометр на конец смены'), '145320');
    fireEvent.click(toggle!);

    // Числовых полей больше нет: «нет данных» — это строка с причиной и без чисел (Р18).
    expect(within(block).queryByText('Одометр на конец смены')).toBeNull();
    expect(within(block).queryByText('Моточасы на конец смены')).toBeNull();
    expect(within(block).getByText('Причина')).toBeDefined();

    // Причина обязательна: без неё «нет данных» неотличимо от несданной строки.
    submitSheet();
    expect(await within(block).findByText('Укажите причину')).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(field(block, 'Причина'), 'Счётчик неисправен');
    submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toEqual({
      kind: 'no_data',
      noDataReason: 'Счётчик неисправен',
      comment: '',
    });

    // Введённое число ушло вместе с переключателем, а не осталось лежать под ним: иначе снятое
    // выключение вернуло бы значение, противоречащее уже отправленному виду показания.
    fireEvent.click(blockOf(routeItem.id).querySelector('button[role="switch"]')!);
    expect((field(blockOf(routeItem.id), 'Одометр на конец смены') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('пустой блок без переключателя не отправляется, и портал называет, чего не хватает', async () => {
    const { http } = renderCabinet([routeItem]);
    await openSheet();

    submitSheet();

    // Ни одно поле не обязательно по отдельности — на технике без одометра его нет физически, —
    // но пустая строка не закрывает день, и отказ говорит об этом вместе с выходом из положения.
    expect(
      await screen.findByText(
        'Заполните хотя бы одно значение или отметьте «нет возможности снять показания»',
      ),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);
  });

  it('запятая в дробном поле становится точкой', async () => {
    const { http } = renderCabinet([routeItem]);
    await openSheet();
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

    submitSheet();

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
    await openSheet();

    type(field(blockOf(routeItem.id), 'Одометр на конец смены'), '145320');
    type(field(blockOf(esm2Item.id), 'Моточасы на конец смены'), '9812.5');
    submitSheet();

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

  it('аномалия показана с предыдущим значением, а подтверждение уезжает следующей отправкой', async () => {
    const { http } = renderCabinet([{ ...routeItem, reading: jumpedReading }]);
    await openSheet();
    const block = blockOf(routeItem.id);

    // Предупреждение без предшественника проверить нечем: «невероятный прирост» человек сверяет
    // именно с тем числом, от которого его посчитали.
    expect(
      within(block).getByText('Одометр: невероятный прирост (предыдущее 140000 от 10.08.2026)'),
    ).toBeDefined();
    // Числа прошлой отправки стоят в полях: подтверждают показанное, а не вводят заново.
    expect((field(block, 'Одометр на конец смены') as HTMLInputElement).value).toBe('145320');

    const confirm = block.querySelector('input[type="checkbox"]');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);
    submitSheet();

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // Аномалия не отказ, а предупреждение: подтверждение уезжает тем же запросом, что и числа.
    expect(submitBody(http).items[0]).toMatchObject({
      itemId: routeItem.id,
      confirmOdometerAnomaly: true,
    });
  });
});
