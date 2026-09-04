import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  VehicleReadingDto,
  VehicleReadingJournalDto,
  VehicleReadingJournalRow,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { VehicleReadingsJournal } from '../src/pages/garage/VehicleReadingsJournal';

/**
 * Окно журнала показаний машины (ADR 0103; план «Показания техники», Р25).
 *
 * Проверяется то, ради чего у журнала появились страницы: строки режет сервер, а не портал.
 * Раньше окно показывало всё, что поместилось в ответ, и предупреждало об обрезанном хвосте —
 * такой список отвечает «дальше ничего нет» там, где дальше есть ещё год работы машины.
 *
 * Отсюда три утверждения теста: запрос несёт страницу, вторая страница берётся у сервера (а не
 * нарезается из загруженного), и смена периода возвращает к первой странице — третья страница
 * другого отрезка означала бы уже не те смены.
 *
 * Четвёртое пришло с топливом в баке (ADR 0163, Р2, Н4): три числа смены стоят здесь **тремя
 * соседними колонками** — журнал единственное место гаража, где на это есть ширина, — и стоят в
 * порядке смены. В реестре приёма те же числа собраны в одну ячейку, и это не расхождение, а
 * решение по ширине: караул держит обе стороны от «выравнивания» экранов друг под друга.
 */

const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';

/** День среза, из которого окно открывают: период по умолчанию отсчитывается от него назад. */
const DAY = '2026-07-24';
const PERIOD_START = '2026-06-24';

/** Строк в периоде заведомо больше страницы: ровно тот случай, ради которого страницы и заводят. */
const TOTAL = 240;
const PAGE_SIZE = 100;

function row(num: number, over: Partial<VehicleReadingJournalRow> = {}): VehicleReadingJournalRow {
  return {
    itemId: `item-${num}`,
    reportId: `report-${num}`,
    reportDate: '2026-07-20',
    shiftOrder: 1,
    reportState: 'accepted',
    sourceKind: 'route',
    sourceId: `route-${num}`,
    sourceLabel: `Р-${num}`,
    personId: 'p-1',
    personName: 'Петров Пётр Петрович',
    reading: null,
    files: [],
    edits: [],
    ...over,
  };
}

/**
 * Показание с полной тройкой топлива: остаток бака на начало смены, заправленное за неё, остаток
 * на конец (ADR 0163). Числа разные и неокруглённые нарочно — по ним видно, какое из трёх встало
 * не в свою колонку.
 */
const FUEL_READING: VehicleReadingDto = {
  id: 'rd-1',
  itemId: 'item-1',
  kind: 'values',
  odometerKm: 128400,
  engineHours: 1240.5,
  fuelStartLiters: 120,
  fuelFilledLiters: 80,
  fuelEndLiters: 60.5,
  noDataReason: '',
  comment: '',
  source: 'driver',
  recordedAt: '2026-07-20T17:20:00.000Z',
  odometerAnomaly: null,
  engineHoursAnomaly: null,
  odometerDelta: 240,
  engineHoursDelta: 8,
  fileIds: [],
};

/** Страница журнала: своя строка на каждой — по ней и видно, какую страницу показывает окно. */
function pageOf(page: number, from = PERIOD_START, to = DAY): VehicleReadingJournalDto {
  return {
    vehicleId: 'v-1',
    vehicleLabel: 'КамАЗ 65115 · А123ВС799',
    from,
    to,
    total: TOTAL,
    page,
    pageSize: PAGE_SIZE,
    items: [row(page)],
  };
}

function renderJournal(): HttpMock {
  const http = mockHttp({
    [JOURNAL]: ({ query }) =>
      json(
        pageOf(
          Number(query.get('page') ?? '1'),
          query.get('from') ?? PERIOD_START,
          query.get('to') ?? DAY,
        ),
      ),
  });
  renderWithUser(
    <VehicleReadingsJournal
      vehicleId="v-1"
      vehicleLabel="КамАЗ 65115 · А123ВС799"
      day={DAY}
      open
      onClose={() => {}}
    />,
  );
  return http;
}

/** Журнал из своих строк: топливные караулы смотрят на колонки, а не на страницы. */
function renderRows(items: VehicleReadingJournalRow[]): void {
  mockHttp({
    [JOURNAL]: () => json({ ...pageOf(1), total: items.length, items }),
  });
  renderWithUser(
    <VehicleReadingsJournal
      vehicleId="v-1"
      vehicleLabel="КамАЗ 65115 · А123ВС799"
      day={DAY}
      open
      onClose={() => {}}
    />,
  );
}

/** Ячейки строки таблицы по порядку: ими и проверяется, что число встало в свою колонку. */
const cellsOf = (label: string): string[] =>
  [...(screen.getByText(label).closest('tr') as HTMLElement).querySelectorAll('td')].map(
    (cell) => cell.textContent ?? '',
  );

/**
 * Период вводится руками: календарь в jsdom мышью не открывается, а набранное значение antd
 * принимает по Enter — тем же приёмом, что и в тестах аудита.
 */
function typeRange(from: string, to: string): void {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>('.ant-modal .ant-picker-input input'),
  ];
  expect(inputs.length, 'поля периода').toBe(2);
  for (const [index, text] of [from, to].entries()) {
    const input = inputs[index]!;
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  }
}

describe('журнал показаний машины', () => {
  it('спрашивает страницу периода и показывает, сколько строк в нём всего', async () => {
    const http = renderJournal();

    expect(await screen.findByText('Р-1')).toBeDefined();
    const query = http.lastCall(JOURNAL)!.query;
    // Период по умолчанию — месяц назад от дня среза; страница обычная для портала.
    expect(query.get('from')).toBe(PERIOD_START);
    expect(query.get('to')).toBe(DAY);
    expect(query.get('page')).toBe('1');
    expect(query.get('pageSize')).toBe(String(PAGE_SIZE));

    // Общее число строк — то, что раньше говорило предупреждение об обрезанном хвосте, только
    // честно: не «остальное не поместилось», а сколько именно строк в периоде.
    expect(screen.getByText(`Всего: ${TOTAL}`)).toBeDefined();
    expect(screen.queryByText(/не поместились/u)).toBeNull();
  });

  it('вторая страница берётся у сервера, а не нарезается из загруженного', async () => {
    const http = renderJournal();
    expect(await screen.findByText('Р-1')).toBeDefined();

    fireEvent.click(screen.getByTitle('2'));

    expect(await screen.findByText('Р-2')).toBeDefined();
    expect(http.countOf(JOURNAL)).toBe(2);
    expect(http.lastCall(JOURNAL)!.query.get('page')).toBe('2');
    // Отрезок при листании тот же: страницу меняют, а не период.
    expect(http.lastCall(JOURNAL)!.query.get('from')).toBe(PERIOD_START);
  });

  it('смена периода возвращает к первой странице', async () => {
    const http = renderJournal();
    expect(await screen.findByText('Р-1')).toBeDefined();

    fireEvent.click(screen.getByTitle('2'));
    expect(await screen.findByText('Р-2')).toBeDefined();

    typeRange('01.05.2026', '31.05.2026');

    await waitFor(() => {
      const query = http.lastCall(JOURNAL)!.query;
      expect(query.get('from')).toBe('2026-05-01');
      expect(query.get('to')).toBe('2026-05-31');
      // Третья страница другого отрезка показывала бы уже не те смены, о которых спросили.
      expect(query.get('page')).toBe('1');
    });
  });

  /**
   * Три числа топлива — тремя СОСЕДНИМИ колонками, в порядке смены (ADR 0163, Р2).
   *
   * Караул стоит здесь по двум причинам сразу. Первая — порядок: подписи трёх колонок различаются
   * одним словом, единицы у всех три раза литры, и переставленные местами «начало» и «конец»
   * читаются как обычный день, а не как ошибка. Вторая — само число колонок: в реестре приёма те
   * же три числа стоят ОДНОЙ ячейкой (Н4), и первый же читатель, увидев расхождение, захочет
   * «выровнять» экраны. Выравнивать нельзя ни в ту, ни в другую сторону: у окна журнала ширина
   * есть, у реестра, который смотрят на ноутбуке, её нет.
   */
  it('показывает три отдельные колонки топлива в порядке смены, после моточасов', async () => {
    renderRows([row(1, { reading: FUEL_READING })]);
    expect(await screen.findByText('Р-1')).toBeDefined();

    // Форма таблицы целиком: топливо стоит группой после «Моточасы» и не сдвинуло ни «Показание»,
    // ни «Файлы» — колонок в журнале ровно столько, сколько названо.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'День',
      'Смена',
      'Одометр',
      'Моточасы',
      'Топливо на начало',
      'Заправлено',
      'Топливо на конец',
      'Показание',
      'Файлы',
    ]);

    // И числа стоят в своих колонках, а не просто где-то в строке: 120 — уровень бака на начало,
    // 80 — заправленное за смену, 60,5 — уровень на конец. Прироста рядом с ними нет намеренно
    // (Р1): разность соседних уровней и была бы расходом, отложенным решением 12 ADR 0103.
    const cells = cellsOf('Р-1');
    expect(cells[4]).toBe('120,0 л');
    expect(cells[5]).toBe('80,0 л');
    expect(cells[6]).toBe('60,5 л');
    expect(cells.some((text) => text.includes('прирост'))).toBe(false);
  });

  it('у показания без топлива в каждой из трёх колонок прочерк, а не ноль', async () => {
    renderRows([
      row(1, {
        reading: {
          ...FUEL_READING,
          fuelStartLiters: null,
          fuelFilledLiters: null,
          fuelEndLiters: null,
        },
      }),
    ]);
    expect(await screen.findByText('Р-1')).toBeDefined();

    // Ноль в баке — это утверждение о машине («бак пуст»), которого никто не делал: литров просто
    // не передали, и прочерк — единственный честный ответ.
    const cells = cellsOf('Р-1');
    expect(cells.slice(4, 7)).toEqual(['—', '—', '—']);
    expect(cells.some((text) => text.includes('0,0 л'))).toBe(false);
  });
});
