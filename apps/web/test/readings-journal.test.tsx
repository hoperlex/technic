import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleReadingJournalDto, VehicleReadingJournalRow } from '@technic/contracts';
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
 */

const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';

/** День среза, из которого окно открывают: период по умолчанию отсчитывается от него назад. */
const DAY = '2026-07-24';
const PERIOD_START = '2026-06-24';

/** Строк в периоде заведомо больше страницы: ровно тот случай, ради которого страницы и заводят. */
const TOTAL = 240;
const PAGE_SIZE = 100;

function row(num: number): VehicleReadingJournalRow {
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
  };
}

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
});
