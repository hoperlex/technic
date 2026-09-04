import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type {
  DriverReportDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingIntakeDto,
  ReadingIntakeReport,
  ReadingIntakeRow,
  VehicleReadingDto,
  VehicleReadingJournalDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';
import { VehicleReadingsJournal } from '../src/pages/garage/VehicleReadingsJournal';

/**
 * Гараж → «Показания» → «Приём»: реестр строк и пакетный приём отчётов (план «Показания техники»,
 * Р1, Р5—Р9а, Р19, Р23, Р29).
 *
 * Проверяется то, ради чего экран заводили, и ровно те места, где портал мог бы начать думать за
 * сервер.
 *
 * **Полоса подвкладок** (Р1). Их стало две, и переключение обязано жить в адресе: ссылка «вот
 * реестр за эти дни» — половина пользы экрана.
 *
 * **Пометки приходят с сервера** (Р5, Р7). Портал не пересчитывает уровня и не сочиняет текстов: в
 * ответе лежит готовая фраза с числами и порогом, и на экране обязана оказаться она же. Зелёная
 * строка при этом молчит совсем (Р6) — не «всё в порядке» полусотней подтверждений.
 *
 * **Счётчик кнопки берётся из отчётов, а не из видимых строк** (Р9а). Это единственное место, где
 * ошибка не видна глазом: пагинация делит отчёт между страницами, и счёт по странице предложил бы
 * принять день с невидимой жёлтой строкой. Поэтому в ответе отчёт разрезан границей страницы, а
 * тест листает и сверяет счётчик.
 *
 * **Топливо — одной ячейкой, пометка о нём — с сервера** (ADR 0163, Н3, Н4). Три числа смены
 * печатаются рядом «120,0 / +80,0 / 60,0» в одной колонке: три отдельные увели бы «Пометки» за
 * край ноутбучного экрана. А пометка «вечерние показания не переданы» — такая же серверная, как
 * аномалия и просрочка: портал показывает её и там, где сам бы не поставил, и молчит там, где
 * сервер промолчал.
 *
 * **Итог приёма и кэш** (Р9, Р19). Пакет — N транзакций, отказ по одному не отменяет остальных:
 * «принято N из M» и причины отказов показываются всегда. После приёма гасится корень слайса —
 * поэтому рядом с реестром в тесте живёт журнал: он на другом семействе ключей и обязан
 * перезапроситься вместе с реестром.
 */

const INTAKE = 'GET /vehicle-readings/intake';
const ACCEPT = 'POST /vehicle-readings/reports/accept-batch';
const STATS = 'GET /vehicle-readings/stats';
const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';
/** Карточка отчёта спрашивает свой ответ: строки реестра ей не хватает (Р9а). */
const REPORT = 'GET /vehicle-readings/reports/:id';

/** День среза страницы: от него отсчитывается окно приёмки. */
const DAY = '2026-08-14';
/** Умолчание периода приёма — неделя, кончающаяся днём среза. */
const WEEK_START = '2026-08-08';
/** Начало месяца дня среза: умолчание соседней подвкладки — им и видно, что окна разные. */
const MONTH_START = '2026-08-01';

/** Серверное «сегодня» (Р23): по нему посчитаны просрочки, и оно приходит в ответе. */
const TODAY = '2026-08-17';

/** Строк в периоде заведомо больше страницы: ровно тот случай, ради которого страницы и заводят. */
const TOTAL = 150;

/** Готовый текст жёлтой пометки — с числами и порогом. Портал обязан показать его дословно. */
const ANOMALY_MESSAGE = 'одометр — прирост 3 400 км за 1 день при пороге 1 500 км';
const OVERDUE_MESSAGE = 'нет показания 4 дня';
/** Текст пометки о неполном вечере (ADR 0163, Р4): его тоже пишет сервер, а не портал. */
const TAIL_MESSAGE = 'вечерние показания не переданы';

function reading(over: Partial<VehicleReadingDto> = {}): VehicleReadingDto {
  return {
    id: 'rd-1',
    itemId: 'it-1',
    kind: 'values',
    odometerKm: 128400,
    engineHours: 1240.5,
    fuelStartLiters: null,
    fuelFilledLiters: 120,
    fuelEndLiters: null,
    noDataReason: '',
    comment: '',
    source: 'driver',
    recordedAt: '2026-08-14T05:20:00.000Z',
    odometerAnomaly: null,
    engineHoursAnomaly: null,
    odometerDelta: 240,
    engineHoursDelta: 8,
    fileIds: [],
    ...over,
  };
}

function row(over: Partial<ReadingIntakeRow> & Pick<ReadingIntakeRow, 'key' | 'vehicleLabel'>) {
  const item: ReadingIntakeRow = {
    itemId: over.key,
    reportId: 'r-1',
    reportDate: DAY,
    vehicleId: 'v-1',
    personId: 'p-1',
    personName: 'Петров П. П.',
    sourceKind: 'route',
    sourceLabel: 'Р-142',
    reading: reading(),
    issues: [],
    ...over,
  };
  return item;
}

function report(over: Partial<ReadingIntakeReport> & Pick<ReadingIntakeReport, 'reportId'>) {
  const item: ReadingIntakeReport = {
    personName: 'Петров П. П.',
    state: 'submitted',
    version: 3,
    batchEligible: true,
    itemCount: 3,
    greenCount: 3,
    ...over,
  };
  return item;
}

/**
 * Отчёты периода: два принимаются пакетом, третий — нет.
 *
 * Разрезанный границей страницы — первый: две его зелёные строки на первой странице, третья на
 * второй. Счёт по видимым строкам дал бы на первой странице один отчёт, на второй — другое число;
 * счёт по отчётам обязан дать два на обеих.
 */
const REPORTS: ReadingIntakeReport[] = [
  report({ reportId: 'r-1' }),
  report({ reportId: 'r-2', personName: 'Сидоров С. С.', version: 5, itemCount: 1, greenCount: 1 }),
  report({
    reportId: 'r-3',
    personName: 'Кузнецов К. К.',
    version: 2,
    batchEligible: false,
    itemCount: 2,
    greenCount: 1,
  }),
];

/** Первая страница: две зелёные строки одного и того же отчёта. */
const PAGE_ONE: ReadingIntakeRow[] = [
  row({ key: 'it-1', vehicleLabel: 'КамАЗ · А111АА777' }),
  row({ key: 'it-2', vehicleLabel: 'МАЗ · В222ВВ777' }),
];

/** Вторая: хвост того же отчёта, жёлтая строка чужого и красная строка неоткрытого дня. */
const PAGE_TWO: ReadingIntakeRow[] = [
  row({ key: 'it-3', vehicleLabel: 'Урал · С333СС777' }),
  row({
    key: 'it-4',
    vehicleLabel: 'Экскаватор · 0002 ММ 77',
    reportId: 'r-3',
    personName: 'Кузнецов К. К.',
    issues: [{ code: 'anomaly_odometer', level: 'yellow', message: ANOMALY_MESSAGE }],
  }),
  // Виртуальная строка неоткрытого дня (Р26): источник есть, строки ожидания и показания нет.
  row({
    key: 'route:rt-9',
    vehicleLabel: 'Автовышка · Е555ЕЕ777',
    itemId: null,
    reportId: null,
    reportDate: '2026-08-10',
    reading: null,
    issues: [{ code: 'overdue', level: 'red', message: OVERDUE_MESSAGE }],
  }),
];

function intakeDto(page: number, from: string, to: string): ReadingIntakeDto {
  return {
    items: page === 1 ? PAGE_ONE : PAGE_TWO,
    total: TOTAL,
    page,
    pageSize: 100,
    from,
    to,
    today: TODAY,
    // Отчёты приходят ВСЕ и одни и те же на любой странице: они про период, а не про страницу.
    reports: REPORTS,
  };
}

/** Отчёт, который открывается из строки: реестру он не нужен, карточке — нужен целиком. */
const REPORT_DTO: DriverReportDto = {
  id: 'r-1',
  personId: 'p-1',
  personName: 'Петров П. П.',
  reportDate: DAY,
  state: 'submitted',
  contentVersion: 4,
  version: 3,
  acceptedContentVersion: null,
  acceptedAt: null,
  acceptedByName: '',
  items: [],
  discrepancies: [],
  canAccept: true,
  blockers: [],
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

const JOURNAL_PAGE: VehicleReadingJournalDto = {
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ · А111АА777',
  from: WEEK_START,
  to: DAY,
  total: 0,
  page: 1,
  pageSize: 100,
  items: [],
};

/** Адрес виден тесту: подвкладка и период живут именно в нём, а не в состоянии экрана (Р1, Р29). */
function AddressProbe() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

interface Options {
  route?: string;
  /** Дописанные маршруты: приём и журнал нужны не всякому сценарию. */
  over?: RouteMap;
  /** Второй экран слайса рядом с реестром — им проверяется, что кэш гасится корнем (Р19). */
  withJournal?: boolean;
}

function renderGarage({ route, over = {}, withJournal = false }: Options = {}) {
  const http = mockHttp({
    [INTAKE]: ({ query }) =>
      json(
        intakeDto(Number(query.get('page') ?? '1'), query.get('from') ?? '', query.get('to') ?? ''),
      ),
    // Соседняя подвкладка: она монтируется при переключении, и без её ручки запрос ушёл бы в пустоту.
    [STATS]: ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  });
  const rendered = renderWithUser(
    <>
      <GaragePage />
      {withJournal && (
        <VehicleReadingsJournal
          vehicleId="v-1"
          vehicleLabel="КамАЗ · А111АА777"
          day={DAY}
          open
          onClose={() => {}}
        />
      )}
      <AddressProbe />
    </>,
    { route: route ?? `/garage?tab=readings&sub=intake&date=${DAY}` },
  );
  return { ...rendered, http };
}

const address = () => screen.getByTestId('address').textContent ?? '';

/** Период последнего запроса реестра: им и проверяется, какое окно ушло на сервер. */
function askedPeriod(http: HttpMock): [string, string] {
  const query = http.lastCall(INTAKE)!.query;
  return [query.get('from') ?? '', query.get('to') ?? ''];
}

/** Строка таблицы по подписи машины: подписи в фикстуре разные — по ним строки и различают. */
const tableRow = (label: string) => screen.getByText(label).closest('tr') as HTMLElement;

/**
 * Реестр из своих строк, одной страницей. Топливные караулы смотрят на ячейку и на пометку, и
 * страницы им только мешают: разрезанный отчёт `intakeDto` нужен счётчику кнопки, а не колонке.
 */
function withRows(items: ReadingIntakeRow[]): RouteMap {
  return {
    [INTAKE]: ({ query }) => {
      const base = intakeDto(1, query.get('from') ?? '', query.get('to') ?? '');
      return json({ ...base, items, total: items.length });
    },
  };
}

/** Кнопка пакетного приёма: её подпись и есть счётчик отчётов. */
const acceptButton = () => screen.getByRole('button', { name: /Принять/u });

describe('приём показаний: полоса подвкладок', () => {
  it('переключает экраны и пишет подвкладку в адрес', async () => {
    const { http } = renderGarage();

    // Реестр открыт: строки с сервера уже на экране.
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Приём' })).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Статистика' }));

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    expect(address()).toContain('sub=stats');
    // Реестр не просто спрятан: его строк на экране больше нет.
    expect(screen.queryByText('КамАЗ · А111АА777')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Приём' }));

    await waitFor(() => expect(address()).toContain('sub=intake'));
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();
  });

  it('у подвкладок свои окна: неделя у приёма, месяц у сводки', async () => {
    const { http } = renderGarage();

    // Приёмку открывают утром вопросом «что не сдано», и неделя накрывает выходные и просрочку.
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));
    expect(askedPeriod(http)).toEqual([WEEK_START, DAY]);

    fireEvent.click(screen.getByRole('tab', { name: 'Статистика' }));

    // Месяц сводки в реестре означал бы просьбу показать месяц ожидаемых смен — поэтому период
    // уходит вместе с подвкладкой, а не тянется за ней.
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    const stats = http.lastCall(STATS)!.query;
    expect([stats.get('from'), stats.get('to')]).toEqual([MONTH_START, DAY]);
  });

  it('период из адреса перебивает умолчание и возвращается в адрес', async () => {
    const { http } = renderGarage({
      route: `/garage?tab=readings&sub=intake&date=${DAY}&from=2026-08-01&to=2026-08-03`,
    });

    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));
    expect(askedPeriod(http)).toEqual(['2026-08-01', '2026-08-03']);
    expect(address()).toContain('from=2026-08-01');
  });
});

describe('приём показаний: строки реестра', () => {
  it('печатает пометки текстом сервера и красит строку его уровнем', async () => {
    const { http } = renderGarage();
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
    expect(await screen.findByText('Экскаватор · 0002 ММ 77')).toBeDefined();

    /*
     * Жёлтая строка: текст с числами и порогом пришёл готовым (Р7) — портал такого не собирает и
     * собирать не должен, у него нет ни значения предшественника, ни расстояния между днями.
     */
    const yellow = tableRow('Экскаватор · 0002 ММ 77');
    expect(within(yellow).getByText(ANOMALY_MESSAGE)).toBeDefined();
    expect(yellow.querySelector('.ant-badge-status-warning')).not.toBeNull();
    expect(yellow.querySelector('.ant-badge-status-error')).toBeNull();

    // Красная — просрочка ожидания: дни посчитал сервер по московскому дню (Р23).
    const red = tableRow('Автовышка · Е555ЕЕ777');
    expect(within(red).getByText(OVERDUE_MESSAGE)).toBeDefined();
    expect(red.querySelector('.ant-badge-status-error')).not.toBeNull();

    // День, на который посчитана просрочка, назван на экране — иначе «4 дня» не от чего отсчитать.
    expect(screen.getByText('17.08.2026')).toBeDefined();
  });

  it('зелёная строка не показывает пометок вовсе', async () => {
    renderGarage();
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    // Зелёное — это пустой список пометок (Р6), а не пометка «всё хорошо»: реестр открывают ради
    // строк, с которыми что-то не так, и хор подтверждений прятал бы их.
    const green = tableRow('КамАЗ · А111АА777');
    expect(green.querySelectorAll('.ant-tag')).toHaveLength(0);
    expect(green.querySelector('.ant-badge-status-success')).not.toBeNull();
    // Числа показания при этом на месте: строка молчит о проблемах, а не о данных.
    expect(within(green).getByText('128400')).toBeDefined();
  });

  /**
   * Ряд топлива ОДНОЙ ячейкой (ADR 0163, Н4).
   *
   * Караулятся здесь три решения разом, и все три легко «поправить» в обратную сторону.
   *
   * 1. **Колонка одна.** Три отдельные, как в журнале машины, добавляют реестру около 260 px, а
   *    смотрят его на ноутбуке — за край уехали бы «Пометки», ради которых реестр и открывают.
   * 2. **Порядок — по ходу смены:** уровень бака на начало, поток за смену, уровень на конец.
   *    Переставленные крайние числа читаются как обычный день, а не как ошибка.
   * 3. **«+» стоит только у середины.** Заправка — поток, два крайних числа — уровни; без знака
   *    ряд читается как три уровня, то есть как невозможно упавший и снова выросший бак.
   */
  it('печатает топливо одной ячейкой в порядке смены, и «+» только у заправки', async () => {
    renderGarage({
      over: withRows([
        row({
          key: 'it-1',
          vehicleLabel: 'КамАЗ · А111АА777',
          reading: reading({ fuelStartLiters: 120, fuelFilledLiters: 80, fuelEndLiters: 60 }),
        }),
        row({
          key: 'it-2',
          vehicleLabel: 'МАЗ · В222ВВ777',
          reading: reading({ fuelStartLiters: 120, fuelFilledLiters: null, fuelEndLiters: 60 }),
        }),
      ]),
    });
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    // Колонка на все три числа одна, и заголовок называет единицы за всех троих сразу.
    expect(screen.getByRole('columnheader', { name: 'Топливо, л' })).toBeDefined();
    expect(screen.queryByRole('columnheader', { name: 'Топливо на начало' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Топливо на конец' })).toBeNull();

    expect(within(tableRow('КамАЗ · А111АА777')).getByText('120,0 / +80,0 / 60,0')).toBeDefined();
    // Отсутствующее число — прочерк на своём месте: ряд не съезжает, и видно, какого числа нет.
    expect(within(tableRow('МАЗ · В222ВВ777')).getByText('120,0 / — / 60,0')).toBeDefined();
  });

  it('полностью пустая тройка топлива схлопывается в один прочерк', async () => {
    renderGarage({
      over: withRows([
        row({
          key: 'it-1',
          vehicleLabel: 'Урал · С333СС777',
          // Счётчики сданы, литров нет вовсе: законный день техники без указателя уровня.
          reading: reading({ fuelStartLiters: null, fuelFilledLiters: null, fuelEndLiters: null }),
        }),
      ]),
    });
    expect(await screen.findByText('Урал · С333СС777')).toBeDefined();

    // «— / — / —» кричало бы о трёх отсутствиях там, где отсутствие одно: топлива не передали
    // вовсе. Прочерк в строке ровно один — второй пришёл бы из пустого счётчика, а они сданы.
    const line = tableRow('Урал · С333СС777');
    expect(within(line).queryByText('— / — / —')).toBeNull();
    expect(within(line).getAllByText('—')).toHaveLength(1);
  });

  /**
   * Пометка `shift_tail_missing` показывается, но НЕ вычисляется (ADR 0163, Н3; Р5).
   *
   * Уровень строки считает единственная функция контрактов `intakeLevel` по списку пометок,
   * который прислал сервер. Заведи портал свою формулу «нет чисел конца смены — значит жёлтая», и
   * разъехались бы две вещи сразу: цвет строки и кнопка пакетного приёма, которая требует всех
   * зелёных. Поэтому караул подаёт обе половины расхождения.
   *
   * Проверять это можно только парой строк: одна доказывает, что портал показывает чужую пометку
   * даже там, где сам бы её не поставил; вторая — что он не ставит своей там, где сервер промолчал.
   * Порознь любая из них проходит и с самодельной формулой.
   */
  it('пометку о неполном вечере показывает текстом сервера, но сам её не выводит', async () => {
    renderGarage({
      over: withRows([
        // Числа полны все пять — а пометка от сервера есть. Своя формула эту строку промолчала бы.
        row({
          key: 'it-1',
          vehicleLabel: 'КамАЗ · А111АА777',
          reading: reading({ fuelStartLiters: 120, fuelFilledLiters: 80, fuelEndLiters: 60 }),
          issues: [{ code: 'shift_tail_missing', level: 'yellow', message: TAIL_MESSAGE }],
        }),
        // И наоборот: вечерних чисел нет ни одного, а пометки сервер не прислал — портал молчит.
        row({
          key: 'it-2',
          vehicleLabel: 'МАЗ · В222ВВ777',
          reading: reading({
            odometerKm: null,
            engineHours: null,
            fuelStartLiters: 90,
            fuelFilledLiters: null,
            fuelEndLiters: null,
          }),
          issues: [],
        }),
      ]),
    });
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    // Пометка стоит дословно и красит строку жёлтым — уровень собран по списку сервера.
    const yellow = tableRow('КамАЗ · А111АА777');
    expect(within(yellow).getByText(TAIL_MESSAGE)).toBeDefined();
    expect(yellow.querySelector('.ant-badge-status-warning')).not.toBeNull();

    // Утренняя строка без пометки остаётся зелёной и молчит: пересчитывать за сервер портал не
    // берётся, даже когда условие пометки видно прямо в её числах.
    const silent = tableRow('МАЗ · В222ВВ777');
    expect(within(silent).queryByText(TAIL_MESSAGE)).toBeNull();
    expect(silent.querySelectorAll('.ant-tag')).toHaveLength(0);
    expect(silent.querySelector('.ant-badge-status-success')).not.toBeNull();
    // Ряд топлива при этом на месте: строка молчит о пометках, а не о числах.
    expect(within(silent).getByText('90,0 / — / —')).toBeDefined();
  });

  it('строка ведёт в отчёт дня, и отчёт называется в адресе', async () => {
    const { http } = renderGarage({ over: { [REPORT]: () => json(REPORT_DTO) } });
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    fireEvent.click(screen.getByText('КамАЗ · А111АА777'));

    // Предмет живёт в адресе (Р29): ссылку «вот этот день Петрова» отправляют соседу, и открывает
    // она тот же отчёт. Сам отчёт карточка спрашивает своей ручкой — реестр знает про него три
    // числа, а разбирают день по составу (Р9а).
    await waitFor(() => expect(address()).toContain('report=r-1'));
    await waitFor(() => expect(http.countOf(REPORT)).toBe(1));
    expect(await screen.findByText('Отчёт — Петров П. П., 14.08.2026')).toBeDefined();
  });
});

describe('приём показаний: пакетная кнопка', () => {
  it('считает отчёты периода, а не видимые строки', async () => {
    const { http } = renderGarage();
    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();

    /*
     * На первой странице видны две строки одного отчёта — по ним пакет насчитал бы один. Отчётов же
     * к приёму два, и оба названы в ответе со счётчиками по всем своим строкам (Р9а).
     */
    expect(acceptButton().textContent).toContain('Принять 2 отчёта');

    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
    expect(await screen.findByText('Экскаватор · 0002 ММ 77')).toBeDefined();

    // Вторая страница показывает хвост того же отчёта и чужую жёлтую строку — счёт по видимому
    // изменился бы, счёт по отчётам не меняется.
    expect(acceptButton().textContent).toContain('Принять 2 отчёта');
    expect(http.lastCall(INTAKE)!.query.get('page')).toBe('2');
  });

  it('отправляет отчёты с их версиями, показывает итог с причинами и гасит корень слайса', async () => {
    const { http } = renderGarage({
      over: {
        [ACCEPT]: () =>
          json({
            accepted: ['r-1'],
            failed: [
              {
                id: 'r-2',
                code: 'version',
                reason: 'Отчёт изменился после того, как его показали',
              },
            ],
          }),
      },
    });

    expect(await screen.findByText('КамАЗ · А111АА777')).toBeDefined();
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));

    fireEvent.click(acceptButton());

    await waitFor(() => expect(http.countOf(ACCEPT)).toBe(1));
    // Уходят только пригодные отчёты и с теми версиями, которые видел принимающий (Р9).
    expect(http.lastCall(ACCEPT)!.body).toEqual({
      reports: [
        { id: 'r-1', version: 3 },
        { id: 'r-2', version: 5 },
      ],
    });

    // Отказ по одному отчёту не отменяет приёма остальных, поэтому итог — два числа и причина.
    // Заголовок окна antd печатает дважды (свой и подтверждения) — важно, что он есть.
    expect((await screen.findAllByText('Принято 1 из 2')).length).toBeGreaterThan(0);
    expect(
      screen.getByText('Сидоров С. С. — Отчёт изменился после того, как его показали'),
    ).toBeDefined();

    // Реестр перечитан: принятое перестало быть непринятым.
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
  });

  it('гасит корень слайса, а не свой ключ: журнал перезапрашивается вместе с реестром', async () => {
    const { http } = renderGarage({
      withJournal: true,
      over: {
        [ACCEPT]: () => json({ accepted: ['r-1', 'r-2'], failed: [] }),
        [JOURNAL]: () => json(JOURNAL_PAGE),
      },
    });

    await waitFor(() => expect(http.countOf(INTAKE)).toBe(1));
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));

    fireEvent.click(acceptButton());

    // Всё принято — итог показывается и в этом случае: молчание после действия читается как отказ.
    expect(await screen.findByText('Принято 2 из 2')).toBeDefined();
    await waitFor(() => expect(http.countOf(INTAKE)).toBe(2));
    // Журнал живёт на своём семействе ключей и обязан обновиться вместе с реестром (Р19).
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(2));
  });
});
