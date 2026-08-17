import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  DriverReportDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingIntakeDto,
  ReportDiscrepancyDto,
  ReportItemDto,
  VehicleReadingDto,
  VehicleReadingJournalDto,
  VehicleReadingJournalRow,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Показания» → «Приём» → разбор в карточке отчёта дня (ADR 0103, решения 3, 6, 10, 11;
 * план «Показания техники», §7, Р7, Р19).
 *
 * Здесь проверяется то, что карточка **делает**, а не то, что показывает: подтверждение аномалии,
 * решение по расхождению, порядок смен и приведение снимка к источнику. У всех четырёх одна общая
 * граница — портал не решает за сервер, — и у каждого своя.
 *
 * **Расхождение объясняет сервер** (Р7): его фраза стоит на экране целиком, а портал называет
 * только исходы, которые сам же и отправляет.
 *
 * **Решение переменяется** (решение 10): журнал append-only, действует последнее. Значит у
 * разобранного расхождения кнопка остаётся, показано действующее решение, а `revoked` возвращает
 * его в неразобранные.
 *
 * **Порядок смен защищён с двух сторон** (решение 3): уходит полный порядок машины за день —
 * вместе с ожидаемым прежним и версиями **всех** затронутых отчётов, даже если половина дня лежит
 * в чужом. Конфликт объясняется словами, а не «повторите».
 *
 * **Rebase — выход из тупика** (решение 11): подпись и подтверждение называют последствие — строка
 * с показанием уедет в чужой отчёт.
 *
 * **У подтверждения аномалии своей ручки нет**, и портал её не выдумывает: подтверждение живёт
 * полем тела отправки, и уходит той же `submit` с теми же числами.
 *
 * После каждого действия гасится корень слайса (Р19) — это видно по перезапросу реестра.
 */

const INTAKE = 'GET /vehicle-readings/intake';
const STATS = 'GET /vehicle-readings/stats';
const REPORT = 'GET /vehicle-readings/reports/:id';
const RESOLVE = 'POST /vehicle-readings/reports/:id/discrepancies';
const ORDER = 'PATCH /vehicle-readings/shift-order';
const REBASE = 'POST /vehicle-readings/items/:id/rebase';
const SUBMIT = 'POST /vehicle-readings/reports/:personId/:date/submit';
const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';

const DAY = '2026-08-14';
const TODAY = '2026-08-17';

/** Готовые тексты сервера: портал таких не собирает — у него нет ни имён, ни прежних дат. */
const DRIVER_MESSAGE = 'рейс Р-142 переназначен Петрову П. П.';
const MISSING_MESSAGE = 'рейс Р-900 этого дня не вошёл в отчёт';
const RESOLVED_REASON = 'рейс завели задним числом, показание уже сдано';

const READING: VehicleReadingDto = {
  id: 'rd-1',
  itemId: 'item-1',
  kind: 'values',
  odometerKm: 128400,
  engineHours: 1240.5,
  fuelFilledLiters: 120,
  noDataReason: '',
  comment: 'сдал вечером',
  source: 'driver',
  recordedAt: '2026-08-14T17:20:00.000Z',
  odometerAnomaly: {
    kind: 'implausible_jump',
    confirmed: false,
    previousValue: 120000,
    previousDate: '2026-08-12',
  },
  engineHoursAnomaly: null,
  odometerDelta: 8400,
  engineHoursDelta: 8,
  fileIds: [],
};

const ITEM: ReportItemDto = {
  id: 'item-1',
  sourceKind: 'route',
  sourceId: 'rt-1',
  sourceLabel: 'Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ · А111АА777',
  shiftOrder: 1,
  reading: READING,
};

/**
 * Неразобранное расхождение строки: у него есть предмет — значит и перенос возможен. Цель у него
 * названа сервером, и её день цели **уже открыт**: у отчёта `r-2` есть и номер, и версия — ровно
 * тот случай, ради которого перенос и придуман.
 */
const DRIVER_DISCREPANCY: ReportDiscrepancyDto = {
  kind: 'driver',
  itemId: 'item-1',
  sourceKind: 'route',
  sourceId: 'rt-1',
  fingerprint: 'v1:abc',
  message: DRIVER_MESSAGE,
  resolved: false,
  resolvedReason: '',
  target: {
    personId: 'p-2',
    personName: 'Сидоров С. С.',
    date: DAY,
    reportId: 'r-2',
    reportVersion: 5,
  },
};

/**
 * Разобранное расхождение уровня отчёта: строки у него нет вовсе (`itemId === null`), переносить
 * нечего — зато есть действующее решение, которое можно заменить.
 */
const MISSING_DISCREPANCY: ReportDiscrepancyDto = {
  kind: 'missing_source',
  itemId: null,
  sourceKind: 'route',
  sourceId: 'rt-9',
  fingerprint: 'v1:zzz',
  message: MISSING_MESSAGE,
  resolved: true,
  resolvedReason: RESOLVED_REASON,
  // Переносить нечего — и цели у такого расхождения нет: строку заводит разбор, а не перенос.
  target: null,
};

function reportDto(over: Partial<DriverReportDto> = {}): DriverReportDto {
  return {
    id: 'r-1',
    personId: 'p-1',
    personName: 'Петров П. П.',
    reportDate: DAY,
    state: 'submitted',
    contentVersion: 7,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items: [ITEM],
    discrepancies: [DRIVER_DISCREPANCY, MISSING_DISCREPANCY],
    canAccept: false,
    blockers: ['не разобрано расхождений: 1'],
    ...over,
  };
}

/** Соседний отчёт того же дня той же машины: вторая смена у другого работника. */
const NEIGHBOUR = reportDto({
  id: 'r-2',
  personId: 'p-2',
  personName: 'Сидоров С. С.',
  version: 5,
  items: [],
  discrepancies: [],
});

function journalRow(over: Partial<VehicleReadingJournalRow> & { itemId: string }) {
  const row: VehicleReadingJournalRow = {
    reportId: 'r-1',
    reportDate: DAY,
    shiftOrder: 1,
    reportState: 'submitted',
    sourceKind: 'route',
    sourceId: 'rt-1',
    sourceLabel: 'Р-142',
    personId: 'p-1',
    personName: 'Петров П. П.',
    reading: null,
    files: [],
    edits: [],
    ...over,
  };
  return row;
}

/**
 * День машины целиком — и он шире открытого отчёта: вторая смена принадлежит другому работнику, то
 * есть другому отчёту. Ровно поэтому порядок собирается по журналу, а не по составу карточки.
 */
const JOURNAL_DTO: VehicleReadingJournalDto = {
  items: [
    journalRow({
      itemId: 'item-9',
      shiftOrder: 2,
      reportId: 'r-2',
      sourceId: 'rt-9',
      sourceLabel: 'Р-900',
      personName: 'Сидоров С. С.',
    }),
    journalRow({ itemId: 'item-1', shiftOrder: 1, reading: READING }),
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ · А111АА777',
  from: DAY,
  to: DAY,
};

const INTAKE_DTO: ReadingIntakeDto = {
  items: [
    {
      key: 'item-1',
      itemId: 'item-1',
      reportId: 'r-1',
      reportDate: DAY,
      vehicleId: 'v-1',
      vehicleLabel: 'КамАЗ · А111АА777',
      personId: 'p-1',
      personName: 'Петров П. П.',
      sourceKind: 'route',
      sourceLabel: 'Р-142',
      reading: READING,
      issues: [{ code: 'driver', level: 'red', message: DRIVER_MESSAGE }],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 100,
  from: '2026-08-08',
  to: DAY,
  today: TODAY,
  reports: [
    {
      reportId: 'r-1',
      personName: 'Петров П. П.',
      state: 'submitted',
      version: 3,
      batchEligible: false,
      itemCount: 1,
      greenCount: 0,
    },
  ],
};

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

function renderCard(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    [INTAKE]: () => json(INTAKE_DTO),
    [REPORT]: ({ params }) => json(params.id === 'r-2' ? NEIGHBOUR : reportDto()),
    [STATS]: ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<GaragePage />, {
    route: `/garage?tab=readings&sub=intake&date=${DAY}&report=r-1`,
  });
  return http;
}

/** Карточка отчёта: действия ищутся внутри неё, чтобы не поймать строку реестра. */
const card = () =>
  screen.getByText('Отчёт — Петров П. П., 14.08.2026').closest('.ant-modal') as HTMLElement;

/**
 * Окно действия — отдельный портал поверх карточки; ищется по своему заголовку. Заголовок берётся
 * именно из шапки окна: у половины действий кнопка в карточке подписана теми же словами, и «первый
 * попавшийся такой текст» нашёл бы кнопку, а не окно.
 */
const dialog = (title: string) => {
  const heading = screen
    .getAllByText(title)
    .find((node) => node.closest('.ant-modal-title') !== null);
  return heading!.closest('.ant-modal') as HTMLElement;
};

async function openCard(over: RouteMap = {}): Promise<HttpMock> {
  const http = renderCard(over);
  expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
  await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));
  return http;
}

describe('карточка отчёта дня: разбор расхождения', () => {
  it('шлёт предмет с отпечатком и версией, а объясняет расхождение текстом сервера', async () => {
    const http = await openCard({ [RESOLVE]: () => json(reportDto()) });

    // Текст расхождения — серверный: портал его не собирает и в кнопку не переносит.
    expect(within(card()).getByText(DRIVER_MESSAGE)).toBeDefined();
    fireEvent.click(within(card()).getByRole('button', { name: 'Разобрать' }));

    const modal = dialog('Разобрать расхождение');
    expect(within(modal).getByText(DRIVER_MESSAGE)).toBeDefined();
    // «Добавить выезд» бывает только у нехватки источника: остальным сервер откажет, и портал не
    // предлагает того, что заведомо не примут.
    expect(within(modal).queryByText('Добавить выезд в отчёт')).toBeNull();

    fireEvent.click(within(modal).getByRole('button', { name: 'Записать решение' }));
    // Причина обязательна: по ней потом отвечают, почему день приняли с расхождением.
    expect(await screen.findByText('Назовите причину: по ней потом отвечают')).toBeDefined();
    expect(http.countOf(RESOLVE)).toBe(0);

    fireEvent.change(within(modal).getByLabelText('Причина решения'), {
      target: { value: 'рейс переназначен ошибочно, показание сдал прежний водитель' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Записать решение' }));

    await waitFor(() => expect(http.countOf(RESOLVE)).toBe(1));
    expect(http.lastCall(RESOLVE)!.path).toBe('/vehicle-readings/reports/r-1/discrepancies');
    expect(http.lastCall(RESOLVE)!.body).toEqual({
      kind: 'driver',
      itemId: 'item-1',
      sourceKind: 'route',
      sourceId: 'rt-1',
      // Отпечаток возвращается нетронутым: решение действует, пока сравниваемые поля те же.
      fingerprint: 'v1:abc',
      resolution: 'accepted_as_is',
      reason: 'рейс переназначен ошибочно, показание сдал прежний водитель',
      // Версия шапки — оптимистическая блокировка разбора.
      version: 3,
    });

    // Разбор меняет те же числа, которые показывает реестр (Р19): гасится корень слайса.
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
    await waitFor(() => expect(http.countOf(REPORT)).toBe(2));
  });

  it('заменяет действующее решение: журнал append-only, и отмена — такая же запись', async () => {
    const http = await openCard({ [RESOLVE]: () => json(reportDto()) });

    // Разобранное не исчезает: видно и исход, и причину, которую написал разбиравший.
    expect(within(card()).getByText(`разобрано: ${RESOLVED_REASON}`)).toBeDefined();
    fireEvent.click(within(card()).getByRole('button', { name: 'Изменить решение' }));

    const modal = dialog('Изменить решение');
    // Что действует сейчас — сказано до того, как это заменят.
    expect(
      within(modal).getByText(`Сейчас действует: разобрано — ${RESOLVED_REASON}`),
    ).toBeDefined();

    fireEvent.click(within(modal).getByText('Отменить прежнее решение'));
    fireEvent.change(within(modal).getByLabelText('Причина решения'), {
      target: { value: 'выезд всё же был — расхождение остаётся' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Записать решение' }));

    await waitFor(() => expect(http.countOf(RESOLVE)).toBe(1));
    expect(http.lastCall(RESOLVE)!.body).toEqual({
      kind: 'missing_source',
      // Предмет расхождения уровня отчёта — сам источник, а не строка: её у него нет.
      itemId: null,
      sourceKind: 'route',
      sourceId: 'rt-9',
      fingerprint: 'v1:zzz',
      resolution: 'revoked',
      reason: 'выезд всё же был — расхождение остаётся',
      version: 3,
    });
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });
});

describe('карточка отчёта дня: порядок смен', () => {
  async function openOrder(over: RouteMap = {}): Promise<HttpMock> {
    const http = await openCard({ [JOURNAL]: () => json(JOURNAL_DTO), ...over });
    fireEvent.click(
      within(card()).getByRole('button', { name: 'Порядок смен — КамАЗ · А111АА777' }),
    );
    // День спрашивается у журнала машины, а не берётся из состава карточки: вторая смена дня
    // принадлежит другому отчёту, и карточка её не видит.
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));
    expect(http.lastCall(JOURNAL)!.path).toBe('/vehicle-readings/journal/v-1');
    expect(http.lastCall(JOURNAL)!.query.get('from')).toBe(DAY);
    expect(http.lastCall(JOURNAL)!.query.get('to')).toBe(DAY);
    // Версия соседнего отчёта спрашивается своим запросом — без неё сервер отвергнет перестановку.
    await waitFor(() =>
      expect(http.calls.some((call) => call.path === '/vehicle-readings/reports/r-2')).toBe(true),
    );
    // Смены показываются только вместе с версиями: переставить то, чего нельзя отправить, нельзя.
    expect(
      await within(dialog('Порядок смен — КамАЗ · А111АА777, 14.08.2026')).findByText(
        'Сидоров С. С.',
      ),
    ).toBeDefined();
    return http;
  }

  it('шлёт полный порядок с ожидаемым прежним и версиями обоих отчётов', async () => {
    const http = await openOrder({ [ORDER]: () => json([reportDto(), NEIGHBOUR]) });
    const modal = dialog('Порядок смен — КамАЗ · А111АА777, 14.08.2026');

    fireEvent.click(within(modal).getByRole('button', { name: 'Опустить смену — Р-142' }));
    fireEvent.change(within(modal).getByLabelText('Причина перестановки'), {
      target: { value: 'ночная смена вышла первой' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Сохранить порядок' }));

    await waitFor(() => expect(http.countOf(ORDER)).toBe(1));
    expect(http.lastCall(ORDER)!.body).toEqual({
      vehicleId: 'v-1',
      date: DAY,
      // Ожидаемый прежний порядок — тот, который видел переставлявший.
      expectedOrder: ['item-1', 'item-9'],
      order: [
        { itemId: 'item-9', shiftOrder: 1 },
        { itemId: 'item-1', shiftOrder: 2 },
      ],
      // Версии всех затронутых отчётов, а не одного открытого.
      reportVersions: { 'r-1': 3, 'r-2': 5 },
      reason: 'ночная смена вышла первой',
    });
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });

  it('конфликт объясняет словами и перечитывает карточку', async () => {
    const http = await openOrder({
      [ORDER]: () =>
        apiError(409, {
          code: 'conflict',
          message: 'Порядок смен уже изменили — обновите страницу и повторите',
        }),
    });
    const modal = dialog('Порядок смен — КамАЗ · А111АА777, 14.08.2026');

    fireEvent.click(within(modal).getByRole('button', { name: 'Опустить смену — Р-142' }));
    fireEvent.change(within(modal).getByLabelText('Причина перестановки'), {
      target: { value: 'ночная смена вышла первой' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Сохранить порядок' }));

    await waitFor(() => expect(http.countOf(ORDER)).toBe(1));
    // Серверное «обновите страницу» здесь было бы неправдой: карточка перечитывает себя сама.
    expect(await screen.findByText(/Порядок не сохранён/u)).toBeDefined();
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });
});

describe('карточка отчёта дня: приведение снимка к источнику', () => {
  it('называет цель по имени, требует причину и шлёт версии обоих отчётов', async () => {
    const http = await openCard({ [REBASE]: () => json(reportDto({ id: 'r-2' })) });

    // Переносить можно только там, где есть что переносить: у нехватки источника строки нет.
    const buttons = within(card()).getAllByRole('button', {
      name: 'Привести снимок к источнику',
    });
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]!);

    const modal = dialog('Привести снимок к источнику');
    // Последствие названо адресно: кто по документу едет и за какой день — словами сервера, а не
    // безличным «тот, кто ехал». Портал источника не читает и вывести этого сам не может.
    expect(
      within(modal).getByText('Строка переедет в отчёт: Сидоров С. С., 14.08.2026'),
    ).toBeDefined();
    expect(
      within(modal).getByText(/перейдёт в отчёт «Сидоров С\. С\., 14\.08\.2026»/u),
    ).toBeDefined();
    // Отказ больше не объявляет перенос недоступным: он лечится повтором.
    expect(within(modal).queryByText(/со стороны сервера, а не отсюда/u)).toBeNull();

    fireEvent.click(within(modal).getByRole('button', { name: 'Перенести строку' }));
    expect(await screen.findByText('Перенос чужого числа объясняют')).toBeDefined();
    expect(http.countOf(REBASE)).toBe(0);

    fireEvent.change(within(modal).getByLabelText('Причина переноса'), {
      target: { value: 'рейс переназначен, показание едет за ним' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Перенести строку' }));

    await waitFor(() => expect(http.countOf(REBASE)).toBe(1));
    // Переносится строка, а не расхождение: адрес — её.
    expect(http.lastCall(REBASE)!.path).toBe('/vehicle-readings/items/item-1/rebase');
    expect(http.lastCall(REBASE)!.body).toEqual({
      reason: 'рейс переназначен, показание едет за ним',
      // Версии обеих шапок: перенос двигает их обе, и версия цели — защита от двух диспетчеров,
      // переносящих строки в один и тот же день. Её портал берёт из цели расхождения.
      reportVersions: { 'r-1': 3, 'r-2': 5 },
    });
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });

  it('день цели ещё не открыт: уходит одна версия — шапку заведёт сам перенос', async () => {
    const unopened: ReportDiscrepancyDto = {
      ...DRIVER_DISCREPANCY,
      target: { ...DRIVER_DISCREPANCY.target!, reportId: null, reportVersion: null },
    };
    const http = await openCard({
      [REPORT]: ({ params }) =>
        json(
          params.id === 'r-2'
            ? NEIGHBOUR
            : reportDto({ discrepancies: [unopened, MISSING_DISCREPANCY] }),
        ),
      [REBASE]: () => json(reportDto({ id: 'r-2' })),
    });

    fireEvent.click(
      within(card()).getAllByRole('button', { name: 'Привести снимок к источнику' })[0]!,
    );
    const modal = dialog('Привести снимок к источнику');
    // Цель названа и здесь: отчёта у неё пока нет, а человек и день — есть.
    expect(
      within(modal).getByText('Строка переедет в отчёт: Сидоров С. С., 14.08.2026'),
    ).toBeDefined();

    fireEvent.change(within(modal).getByLabelText('Причина переноса'), {
      target: { value: 'рейс переназначен, день получателя ещё не открывали' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Перенести строку' }));

    await waitFor(() => expect(http.countOf(REBASE)).toBe(1));
    // Версии, которой не существует, портал не выдумывает: сервер заведёт шапку сам.
    expect(http.lastCall(REBASE)!.body).toEqual({
      reason: 'рейс переназначен, день получателя ещё не открывали',
      reportVersions: { 'r-1': 3 },
    });
  });
});

describe('карточка отчёта дня: подтверждение аномалии', () => {
  it('уходит той же ручкой отправки и теми же числами — своей ручки портал не выдумывает', async () => {
    const http = await openCard({ [SUBMIT]: () => json(reportDto()) });

    fireEvent.click(
      within(card()).getByRole('button', { name: 'Подтвердить аномалию — Одометр, Р-142' }),
    );

    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    expect(http.lastCall(SUBMIT)!.path).toBe('/vehicle-readings/reports/p-1/2026-08-14/submit');
    expect(http.lastCall(SUBMIT)!.body).toEqual({
      version: 3,
      items: [
        {
          itemId: 'item-1',
          // Числа уходят прежние до последнего знака: сервер не найдёт разницы, правки не запишет,
          // а подпись под аномалией поставит. Подмени портал хоть комментарий — вышла бы правка.
          reading: {
            kind: 'values',
            odometerKm: 128400,
            engineHours: 1240.5,
            fuelFilledLiters: 120,
            comment: 'сдал вечером',
          },
          // Счётчики подписываются поодиночке: одометр мог быть сброшен, а моточасы прыгнуть.
          confirmOdometerAnomaly: true,
          confirmEngineHoursAnomaly: false,
        },
      ],
    });

    // Второй ручки у подтверждения нет, и портал её не придумал: единственная запись — отправка.
    expect(http.calls.filter((call) => call.method !== 'GET').map((call) => call.path)).toEqual([
      '/vehicle-readings/reports/p-1/2026-08-14/submit',
    ]);
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });

  it('у подтверждённой аномалии кнопки нет: снимает подпись пересчёт, а не портал', async () => {
    const confirmed = reportDto({
      items: [
        {
          ...ITEM,
          reading: {
            ...READING,
            odometerAnomaly: { ...READING.odometerAnomaly!, confirmed: true },
          },
        },
      ],
    });
    await openCard({ [REPORT]: () => json(confirmed) });

    expect(within(card()).getByText(/Одометр: невероятный прирост.*— подтверждена/u)).toBeDefined();
    expect(
      within(card()).queryByRole('button', { name: 'Подтвердить аномалию — Одометр, Р-142' }),
    ).toBeNull();
  });
});
