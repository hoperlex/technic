import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  DriverReportDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingIntakeDto,
  ReadingIntakeRow,
  ReportItemDto,
  VehicleReadingDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Показания» → «Приём» → карточка отчёта дня (ADR 0103; план «Показания техники», §7,
 * Р19, Р23, Р26, Р29).
 *
 * Карточка — то место, где чужой день разбирают: смотрят состав, вносят показание за работника и
 * принимают день целиком. Проверяется в ней ровно то, где портал мог бы начать решать за сервер.
 *
 * **Предмет живёт в адресе** (Р29). Карточку открывают и строкой реестра, и ссылкой, присланной
 * соседом, — а «назад» обязано её закрыть и вернуть к реестру. Состояние в `useState` такой ссылки
 * не даёт: оно теряется от перезагрузки и от пересылки.
 *
 * **Отчёт спрашивается своей ручкой.** Реестр знает про отчёт три числа (Р9а), и собрать из них
 * состав нельзя: строки, расхождения и причины отказа приходят целиком в `DriverReportDto`.
 *
 * **Причины отказа — серверные** (`blockers`). Портал их не выводит: четыре условия приёма
 * проверяются под блокировками, и своя копия правил предлагала бы принять день, который сервер
 * отвергнет. Поэтому при `canAccept === false` кнопки нет вовсе, а на её месте — перечень причин.
 *
 * **Правка чужого числа идёт с причиной.** Её требует сервис, и портал не даёт дойти до отказа:
 * поле обязательно у всякой уже закрытой строки. Предупреждения при этом делятся надвое —
 * невероятный прирост отправку **не держит** (странное число бывает правдой, а аномалию запишет
 * сервер), значение вне абсолютных границ не пускает вовсе (опечатка в разряде).
 *
 * **Кэш гасится корнем слайса** (Р19): после приёма реестр обязан перезапроситься — принятое
 * перестало быть непринятым.
 */

const INTAKE = 'GET /vehicle-readings/intake';
const STATS = 'GET /vehicle-readings/stats';
const REPORT = 'GET /vehicle-readings/reports/:id';
const ACCEPT = 'POST /vehicle-readings/reports/:id/accept';
const SUBMIT = 'POST /vehicle-readings/reports/:personId/:date/submit';
const OPEN = 'POST /vehicle-readings/reports/:personId/:date/open';

/** День среза страницы: от него отсчитывается окно приёмки. */
const DAY = '2026-08-14';
/** Серверное «сегодня» (Р23): по нему посчитаны пометки просрочки. */
const TODAY = '2026-08-17';
/** День, который никто не открывал: у его строки реестра отчёта нет вовсе (Р26). */
const VIRTUAL_DAY = '2026-08-10';

/** Готовый текст расхождения: портал такого не собирает — у него нет ни имени, ни прежней даты. */
const DISCREPANCY_MESSAGE = 'рейс Р-142 переназначен Петрову П. П.';
/** Готовые причины отказа приёма: их считает сервер под блокировками. */
const BLOCKERS = ['не закрыто строк: 1', 'не подтверждены аномалии (одометр)'];

/**
 * Показание с непризнанной аномалией одометра — и с тем, **с чем сервер сравнивал**.
 *
 * Пара «значение + дата предшественника» здесь не для красоты: другого предыдущего снимка карточка
 * отчёта не получает (в кабинете он приходит в задании), и ровно из неё считается предупреждение о
 * невероятном приросте. Два дня до `DAY` — это множитель порога: суточные 1500 км превращаются в
 * 3000.
 */
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

/** Строка с показанием: её правят, и правка требует причины. */
const FILLED_ITEM: ReportItemDto = {
  id: 'item-1',
  sourceKind: 'route',
  sourceId: 'rt-1',
  sourceLabel: 'Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ · А111АА777',
  shiftOrder: 1,
  reading: READING,
};

/** Строка без показания: её заполняют впервые, и объяснять там нечего. */
const EMPTY_ITEM: ReportItemDto = {
  id: 'item-2',
  sourceKind: 'esm2',
  sourceId: 'wb-1',
  sourceLabel: 'ЭСМ-2 № 000123',
  vehicleId: 'v-2',
  vehicleLabel: 'Экскаватор · 0002 ММ 77',
  shiftOrder: 2,
  reading: null,
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
    items: [FILLED_ITEM, EMPTY_ITEM],
    discrepancies: [
      {
        kind: 'driver',
        itemId: 'item-1',
        sourceKind: 'route',
        sourceId: 'rt-1',
        fingerprint: 'v1:abc',
        message: DISCREPANCY_MESSAGE,
        resolved: false,
        resolvedReason: '',
        // Цель переноса: кто по документу едет теперь и за какой день (ADR 0103, решение 11).
        target: {
          personId: 'p-2',
          personName: 'Сидоров С. С.',
          date: DAY,
          reportId: null,
          reportVersion: null,
        },
      },
    ],
    canAccept: false,
    blockers: BLOCKERS,
    ...over,
  };
}

/** Тот же отчёт, но принимаемый: строки закрыты, расхождений нет, причин отказа нет. */
const ACCEPTABLE = reportDto({
  items: [FILLED_ITEM],
  discrepancies: [],
  canAccept: true,
  blockers: [],
});

function intakeRow(over: Partial<ReadingIntakeRow> & Pick<ReadingIntakeRow, 'key'>) {
  const row: ReadingIntakeRow = {
    itemId: over.key,
    reportId: 'r-1',
    reportDate: DAY,
    vehicleId: 'v-1',
    vehicleLabel: 'КамАЗ · А111АА777',
    personId: 'p-1',
    personName: 'Петров П. П.',
    sourceKind: 'route',
    sourceLabel: 'Р-142',
    reading: READING,
    issues: [],
    ...over,
  };
  return row;
}

const INTAKE_DTO: ReadingIntakeDto = {
  items: [
    intakeRow({ key: 'item-1' }),
    // Виртуальная строка неоткрытого дня (Р26): источник есть, строки ожидания и отчёта — нет.
    intakeRow({
      key: 'route:rt-9',
      itemId: null,
      reportId: null,
      reportDate: VIRTUAL_DAY,
      vehicleLabel: 'Автовышка · Е555ЕЕ777',
      personId: 'p-9',
      personName: 'Сидоров С. С.',
      reading: null,
      issues: [{ code: 'overdue', level: 'red', message: 'нет показания 4 дня' }],
    }),
  ],
  total: 2,
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
      itemCount: 2,
      greenCount: 1,
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

/** Адрес и «назад» браузера видны тесту: карточка — переход, а не состояние экрана (Р29). */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Назад браузера</button>
    </>
  );
}

function renderGarage(route: string, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    [INTAKE]: () => json(INTAKE_DTO),
    [REPORT]: () => json(reportDto()),
    // Соседняя подвкладка: она монтируется при переключении, и без её ручки запрос ушёл бы в пустоту.
    [STATS]: ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    { route },
  );
  return http;
}

const intakeRoute = (extra = '') => `/garage?tab=readings&sub=intake&date=${DAY}${extra}`;

const address = () => screen.getByTestId('address').textContent ?? '';

/** Открыта ли карточка: её заголовок называет работника и день. */
const cardTitle = () => screen.queryByText(`Отчёт — Петров П. П., 14.08.2026`);

/** Окно карточки целиком: запросы внутрь идут через него, чтобы не поймать строку реестра. */
const card = () => cardTitle()!.closest('.ant-modal') as HTMLElement;

/** Форма показания — отдельное окно поверх карточки; ищется по своему заголовку. */
const form = (source: string) =>
  screen.getByText(`Показания — ${source}`).closest('.ant-modal') as HTMLElement;

/** Поле формы по подписи: значения проверяются и подставляются через него. */
function field(source: string, label: string): HTMLInputElement {
  return within(form(source)).getByLabelText(label) as HTMLInputElement;
}

/** «Сохранить» именно в форме показания: у карточки рядом свои кнопки. */
const saveButton = (source: string) =>
  within(form(source)).getByRole('button', { name: 'Сохранить' });

/** Открыть форму правки строки: подпись кнопки называет и действие, и источник. */
async function openForm(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name }));
}

describe('карточка отчёта дня: вход и адрес', () => {
  it('открывается из строки реестра, а «назад» её закрывает', async () => {
    const http = renderGarage(intakeRoute());
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    fireEvent.click(screen.getAllByText('КамАЗ · А111АА777')[0]!);

    await waitFor(() => expect(address()).toContain('report=r-1'));
    // Реестр знает про отчёт три числа (Р9а) — состав приходит своим ответом.
    await waitFor(() => expect(http.countOf(REPORT)).toBe(1));
    expect(http.lastCall(REPORT)!.path).toBe('/vehicle-readings/reports/r-1');
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();

    fireEvent.click(screen.getByText('Назад браузера'));

    // Открытие пишется в историю, поэтому «назад» снимает именно карточку: страница остаётся той
    // же, период — тоже, уходит только предмет.
    await waitFor(() => expect(cardTitle()).toBeNull());
    expect(address()).not.toContain('report=');
    expect(address()).toContain('sub=intake');
  });

  it('открывается прямо из адреса, без реестра под рукой', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'));

    // Ссылку «вот этот день Петрова» присылают соседом, и открывает она сразу разбор.
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
    await waitFor(() => expect(http.countOf(REPORT)).toBe(1));
  });
});

describe('карточка отчёта дня: что показано', () => {
  it('печатает состав, расхождения и причины отказа текстами сервера', async () => {
    renderGarage(intakeRoute('&report=r-1'));
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
    const view = within(card());

    // Состав: источник, машина и позиция смены — без них разность соседних снимков не к чему
    // отнести (ADR 0103).
    expect(view.getByText('Р-142')).toBeDefined();
    expect(view.getByText('смена 1')).toBeDefined();
    expect(view.getByText('ЭСМ-2 № 000123')).toBeDefined();
    expect(view.getByText('смена 2')).toBeDefined();

    // Снимок и прирост стоят рядом и подписаны: приросты считает сервер, портал их показывает.
    expect(view.getByText('128 400 км')).toBeDefined();
    expect(view.getByText('прирост 8 400 км')).toBeDefined();
    // Строка без показания молчит о числах, но не о себе: день с ней не примут.
    expect(view.getByText('Показание не передано — строка ждёт')).toBeDefined();

    // Аномалия названа с тем значением, с которым сравнивали, и с тем, что подписи под ней нет.
    expect(
      view.getByText(
        'Одометр: невероятный прирост, предыдущее 120 000 от 12.08.2026 — не подтверждена',
      ),
    ).toBeDefined();

    // Расхождение — готовой фразой сервера: у портала нет ни имени нового работника, ни прежней даты.
    expect(view.getByText(DISCREPANCY_MESSAGE)).toBeDefined();
    expect(view.getByText('не разобрано — день не примут')).toBeDefined();

    // Причины отказа перечисляются целиком: разная работа не сворачивается в одну фразу.
    for (const blocker of BLOCKERS) expect(view.getByText(blocker)).toBeDefined();
    // И кнопки приёма при этом нет вовсе — вместо неё причины.
    expect(view.queryByText('Принять день')).toBeNull();
  });
});

describe('карточка отчёта дня: внесение за работника', () => {
  it('не отправляет правку сданного числа без причины, а с причиной шлёт верное тело', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [SUBMIT]: () => json(reportDto()),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();

    await openForm('Поправить показание — Р-142');
    // Форма открывается уже сданными числами: правят их, а не заполняют заново.
    expect(field('Р-142', 'Одометр на конец смены, км').value).toBe('128400');

    fireEvent.change(field('Р-142', 'Одометр на конец смены, км'), {
      target: { value: '128500' },
    });
    fireEvent.click(saveButton('Р-142'));

    // Причина обязательна там, где правят уже существующее число: сервис откажет, и портал не
    // даёт дойти до отказа.
    expect(await screen.findByText('Чужое число меняют с объяснением')).toBeDefined();
    expect(http.countOf(SUBMIT)).toBe(0);

    fireEvent.change(field('Р-142', 'Причина правки'), {
      target: { value: 'водитель списал с прицепа' },
    });
    fireEvent.click(saveButton('Р-142'));

    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    // Адрес отправки — работник и день, а не отчёт: строку правят в дне того, чей это день.
    expect(http.lastCall(SUBMIT)!.path).toBe('/vehicle-readings/reports/p-1/2026-08-14/submit');
    expect(http.lastCall(SUBMIT)!.body).toEqual({
      // Версия шапки, которую видел вносящий: оптимистическая блокировка отчёта.
      version: 3,
      reason: 'водитель списал с прицепа',
      items: [
        {
          itemId: 'item-1',
          reading: {
            kind: 'values',
            odometerKm: 128500,
            // Незатронутые числа уходят теми же: отправка описывает показание целиком.
            engineHours: 1240.5,
            fuelFilledLiters: 120,
            comment: 'сдал вечером',
          },
        },
      ],
    });
  });

  it('невероятный прирост предупреждает, но отправку не держит', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [SUBMIT]: () => json(reportDto()),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();

    await openForm('Поправить показание — Р-142');
    // Предыдущий снимок — 120 000 от 12.08, до дня отчёта двое суток: порог 1500 × 2 = 3000 км.
    fireEvent.change(field('Р-142', 'Одометр на конец смены, км'), {
      target: { value: '200000' },
    });

    expect(
      await within(form('Р-142')).findByText(/Одометр: прирост 80 000 км за 2 дня/u),
    ).toBeDefined();

    fireEvent.change(field('Р-142', 'Причина правки'), { target: { value: 'сверено по фото' } });
    fireEvent.click(saveButton('Р-142'));

    // Странное число бывает правдой: аномалию запишет сервер, и день без её подтверждения не
    // примут, — а держать ввод предупреждением значило бы не дать внести правду.
    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    expect(
      (http.lastCall(SUBMIT)!.body as { items: { reading: { odometerKm: number } }[] }).items[0]!
        .reading.odometerKm,
    ).toBe(200000);
  });

  it('значение вне абсолютных границ отправку не пускает вовсе', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [SUBMIT]: () => json(reportDto()),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();

    await openForm('Поправить показание — Р-142');
    fireEvent.change(field('Р-142', 'Одометр на конец смены, км'), {
      target: { value: '9999999' },
    });
    fireEvent.change(field('Р-142', 'Причина правки'), { target: { value: 'опечатка' } });
    fireEvent.click(saveButton('Р-142'));

    // Опечатку в разряде подтверждать нечем: её подтвердят так же, как набрали.
    expect(
      await screen.findByText('Проверьте разряд: столько одометр не показывает'),
    ).toBeDefined();
    expect(http.countOf(SUBMIT)).toBe(0);
  });

  it('вносит показание в пустую строку без причины и гасит корень слайса', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [SUBMIT]: () => json(reportDto()),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));

    await openForm('Внести показание — ЭСМ-2 № 000123');
    // Поля причины у первого ввода нет вовсе: объяснять нечего, а пустое обязательное поле просило
    // бы назвать причину того, что делают впервые.
    expect(within(form('ЭСМ-2 № 000123')).queryByLabelText('Причина правки')).toBeNull();

    fireEvent.change(field('ЭСМ-2 № 000123', 'Моточасы на конец смены'), {
      // Запятая нормализуется на вводе: десятичный разделитель зависит от раскладки.
      target: { value: '812,5' },
    });
    fireEvent.click(saveButton('ЭСМ-2 № 000123'));

    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    expect(http.lastCall(SUBMIT)!.body).toEqual({
      version: 3,
      reason: '',
      items: [
        {
          itemId: 'item-2',
          reading: {
            kind: 'values',
            odometerKm: null,
            engineHours: 812.5,
            fuelFilledLiters: null,
            comment: '',
          },
        },
      ],
    });

    // Правка меняет те же числа, которые показывает реестр (Р19): он обязан перезапроситься.
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });
});

describe('карточка отчёта дня: приём одного дня', () => {
  it('шлёт версию, которую видел принимающий, и гасит корень слайса', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [REPORT]: () => json(ACCEPTABLE),
      [ACCEPT]: () => json({ ...ACCEPTABLE, state: 'accepted', canAccept: false }),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));

    // Имя кнопки собирается вместе с подписью её иконки, поэтому ищется выражением, а не строкой.
    fireEvent.click(await screen.findByRole('button', { name: /Принять день/u }));

    await waitFor(() => expect(http.countOf(ACCEPT)).toBe(1));
    // Приём подтверждает данные, а не факт нажатия: версия — та, которую показали.
    expect(http.lastCall(ACCEPT)!.body).toEqual({ version: 3 });
    expect(await screen.findByText('День принят')).toBeDefined();

    // Принятое перестало быть непринятым — реестр и сама карточка перечитываются (Р19).
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
    await waitFor(() => expect(http.countOf(REPORT)).toBe(2));
  });

  it('объясняет расхождение версий словами и перечитывает карточку', async () => {
    const http = renderGarage(intakeRoute('&report=r-1'), {
      [REPORT]: () => json(ACCEPTABLE),
      [ACCEPT]: () =>
        apiError(409, {
          code: 'conflict',
          message: 'Отчёт изменился, обновите страницу и повторите',
        }),
    });
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
    await waitFor(() => expect(http.countOf(REPORT)).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: /Принять день/u }));

    await waitFor(() => expect(http.countOf(ACCEPT)).toBe(1));
    // Серверное «обновите страницу» здесь было бы неправдой: карточка перечитывает себя сама.
    expect(await screen.findByText(/Приём не состоялся: отчёт изменился/u)).toBeDefined();
    await waitFor(() => expect(http.countOf(REPORT)).toBe(2));
  });
});

describe('карточка отчёта дня: день, которого нет', () => {
  it('открывает отчёт за работника и показывает обычную карточку', async () => {
    const opened = reportDto({ id: 'r-9', personId: 'p-9', personName: 'Сидоров С. С.' });
    const http = renderGarage(intakeRoute(), {
      [OPEN]: () => json(opened),
      [REPORT]: () => json(opened),
    });
    expect(await screen.findByText('Автовышка · Е555ЕЕ777')).toBeDefined();

    fireEvent.click(screen.getByText('Автовышка · Е555ЕЕ777'));

    // Открытие заводит в чужом дне строки ожидания — учётный след, и о нём спрашивают.
    // Заголовок окна antd печатает дважды (свой и подтверждения) — важно, что он есть.
    expect((await screen.findAllByText('Открыть отчёт за Сидоров С. С.?')).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть' }));

    await waitFor(() => expect(http.countOf(OPEN)).toBe(1));
    // Работник и день берутся из строки реестра: других координат у неоткрытого дня нет.
    expect(http.lastCall(OPEN)!.path).toBe(`/vehicle-readings/reports/p-9/${VIRTUAL_DAY}/open`);

    // Дальше — обычная карточка, и открытый отчёт назван в адресе.
    await waitFor(() => expect(address()).toContain('report=r-9'));
    expect(await screen.findByText('Отчёт — Сидоров С. С., 14.08.2026')).toBeDefined();
    // Реестр перечитан: виртуальная строка стала строкой отчёта (Р19).
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });
});
