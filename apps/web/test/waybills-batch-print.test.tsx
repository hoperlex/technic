import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WaybillDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { WaybillsPage } from '../src/pages/WaybillsPage';

/**
 * Печать пачкой и запрет бумаги у аннулированного листа.
 *
 * Пачка нужна, потому что печатают день целиком: до сих пор это значило открыть, напечатать и
 * закрыть столько раз, сколько листов, — с отдельным диалогом печати на каждый. Проверяется, что
 * выбор превращается в **один** запрос со списком листов: два запроса означали бы два документа и
 * два диалога, то есть ровно то, от чего уходили.
 *
 * Аннулированный лист не печатают и не выгружают ни одной ролью: напечатанный, он неотличим от
 * действующего и, попав к водителю, ездит документом, которого уже нет. Поэтому его нельзя ни
 * выбрать в пачку, ни отправить в принтер поодиночке.
 */

const ISSUED: WaybillDto = {
  id: 'w-1',
  number: '260604-646-00000001',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-08-10',
  periodFrom: null,
  periodTo: null,
  organizationName: 'ООО «СУ-10»',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  withTrailer: false,
  trailerLabel: '',
  issuedByName: 'Диспетчер',
  issuedAt: '2026-08-10T06:00:00.000Z',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  printedAt: null,
  exportedAt: null,
  isCorrection: false,
  correctionReason: '',
  correctsNumber: null,
  correctedByNumber: null,
  routeId: 'route-1',
  routeNumber: 'Р-12',
  requests: [],
  files: [],
};

const SECOND: WaybillDto = { ...ISSUED, id: 'w-2', number: '260604-646-00000002' };

/** Уже печатали и уже выгружали — на кнопках это отмечено точкой. */
const MARKED: WaybillDto = {
  ...ISSUED,
  id: 'w-3',
  number: '260604-646-00000003',
  printedAt: '2026-08-10T07:00:00.000Z',
  exportedAt: '2026-08-10T07:05:00.000Z',
};

const CANCELLED: WaybillDto = {
  ...ISSUED,
  id: 'w-4',
  number: '260604-646-00000004',
  status: 'cancelled',
  cancelledByName: 'Диспетчер',
  cancelledAt: '2026-08-10T08:00:00.000Z',
  cancelReason: 'испорчен при печати',
};

const DIRECTORIES = {
  'GET /vehicles': () => json(list([])),
  'GET /drivers': () => json(list([])),
};

function renderJournal(items: WaybillDto[]) {
  const http = mockHttp({
    'GET /waybills': () => json(list(items)),
    // Тело печати — файл; для теста важно лишь, что ответ пришёл и окно его показало.
    'POST /waybills/print-batch': () => json('%PDF-1.4'),
    ...DIRECTORIES,
  });
  renderWithUser(<WaybillsPage />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Строка листа по его номеру. */
function rowOf(number: string): HTMLElement {
  return screen.getByText(number).closest('tr')!;
}

/** Чекбокс выбора в строке: он единственный в ней — колонка выбора одна. */
function selectBox(row: HTMLElement): HTMLInputElement {
  return row.querySelector('input[type="checkbox"]')!;
}

const printButton = (row: HTMLElement): HTMLButtonElement =>
  within(row).getByLabelText('Печать бланка');
const exportButton = (row: HTMLElement): HTMLButtonElement =>
  within(row).getByLabelText('Скачать бланк');

describe('журнал листов: печать пачкой', () => {
  it('виджет выбора появляется только с выбранными листами и считает их', async () => {
    renderJournal([ISSUED, SECOND]);
    await screen.findByText(ISSUED.number);

    expect(screen.queryByText(/Выбрано/)).toBeNull();

    fireEvent.click(selectBox(rowOf(ISSUED.number)));
    expect(await screen.findByText('Выбрано 1 лист')).toBeDefined();

    fireEvent.click(selectBox(rowOf(SECOND.number)));
    expect(await screen.findByText('Выбрано 2 листа')).toBeDefined();
  });

  it('печать пачки уходит одним запросом со списком листов', async () => {
    const http = renderJournal([ISSUED, SECOND]);
    await screen.findByText(ISSUED.number);

    fireEvent.click(selectBox(rowOf(ISSUED.number)));
    fireEvent.click(selectBox(rowOf(SECOND.number)));
    fireEvent.click(screen.getByText('Напечатать'));

    await waitFor(() => expect(http.countOf('POST /waybills/print-batch')).toBe(1));
    expect(http.lastCall('POST /waybills/print-batch')!.body).toEqual({ ids: ['w-1', 'w-2'] });
    // Один документ — одно окно печати: заголовок называет, сколько листов в нём собрано.
    expect(await screen.findByText('Путевые листы: 2 в одном документе')).toBeDefined();
  });

  it('«снять выбор» убирает виджет', async () => {
    renderJournal([ISSUED, SECOND]);
    await screen.findByText(ISSUED.number);

    fireEvent.click(selectBox(rowOf(ISSUED.number)));
    fireEvent.click(await screen.findByText('Снять выбор'));

    await waitFor(() => expect(screen.queryByText(/Выбрано/)).toBeNull());
  });
});

describe('журнал листов: аннулированный бланк', () => {
  it('не печатается, не выгружается и в пачку не выбирается', async () => {
    renderJournal([CANCELLED]);
    await screen.findByText(CANCELLED.number);
    const row = rowOf(CANCELLED.number);

    expect(printButton(row).disabled).toBe(true);
    expect(exportButton(row).disabled).toBe(true);
    expect(selectBox(row).disabled).toBe(true);
  });

  it('выбрать всё на странице аннулированные не захватывает', async () => {
    renderJournal([ISSUED, CANCELLED]);
    await screen.findByText(ISSUED.number);

    // Заголовок таблица рисует дважды (видимая шапка и слой измерения) — жмём первый.
    fireEvent.click(screen.getAllByLabelText('Выбрать всё на странице')[0]!);

    expect(await screen.findByText('Выбрано 1 лист')).toBeDefined();
  });
});

describe('журнал листов: отметки о печати и выгрузке', () => {
  it('точка стоит там, где бумага уже уходила, и не стоит там, где нет', async () => {
    renderJournal([ISSUED, MARKED]);
    await screen.findByText(MARKED.number);

    // Точка — значок antd рядом с кнопкой; ищем её в ячейке действий той же строки.
    const marked = rowOf(MARKED.number);
    expect(marked.querySelectorAll('.ant-badge-dot').length).toBe(2);
    expect(rowOf(ISSUED.number).querySelectorAll('.ant-badge-dot').length).toBe(0);
  });
});
