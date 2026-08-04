import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WaybillDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { WaybillsPage } from '../src/pages/WaybillsPage';

/**
 * Журнал учёта путевых листов: три бланка в одной таблице (миграция 0087).
 *
 * До ЭСМ-2 журнал был однороден — каждая строка означала рейс одного дня. Теперь рядом живёт лист
 * на неделю работы машины на площадке, и различать их приходится прямо в таблице: у формы своя
 * колонка с фильтром, а «На дату» у недельного листа показывает период, а не день.
 *
 * Отдельная колонка — вложения: лист уходит на объект бумагой и возвращается заполненным, и
 * журнал обязан отвечать, чем кончился выданный номер.
 */

const TRIP: WaybillDto = {
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
  requests: [],
  files: [],
};

/** Недельный лист: период вместо дня и скан заполненного заказчиком оборота. */
const WEEK: WaybillDto = {
  ...TRIP,
  id: 'w-2',
  number: 'ЭСМ-00000004',
  formCode: 'esm2',
  issuedForDate: '2026-08-31',
  periodFrom: '2026-08-31',
  periodTo: '2026-09-06',
  vehicleLabel: 'JCB 3CX · У777УУ177',
  driverName: 'Семёнов Семён Семёнович',
  files: [
    {
      id: 'f-1',
      filename: 'esm2-оборот.pdf',
      contentType: 'application/pdf',
      size: 120_000,
      status: 'active',
      createdAt: '2026-09-08T08:00:00.000Z',
    },
  ],
};

function renderJournal(items: WaybillDto[] = [TRIP, WEEK]) {
  const http = mockHttp({ 'GET /waybills': () => json(list(items)) });
  renderWithUser(<WaybillsPage />);
  return http;
}

/** Строка листа по его номеру: искать по тексту в таблице надёжнее, чем по индексу строки. */
function rowOf(number: string): HTMLElement {
  return screen.getByText(number).closest('tr')!;
}

/** Скрепка вложений в строке: у кнопки нет подписи, кроме числа файлов. */
function filesButton(row: HTMLElement): HTMLElement {
  return row.querySelector('.anticon-paper-clip')!.closest('button')!;
}

describe('журнал путевых листов: три бланка в одной таблице', () => {
  it('форма показана колонкой, а неделя работ — периодом вместо дня', async () => {
    renderJournal();
    await waitFor(() => expect(screen.getByText('ЭСМ-00000004')).toBeDefined());

    // Короткая подпись, а не полная: «Форма ЭСМ-2 (строительная машина)» в колонку не влезает.
    expect(within(rowOf('ЭСМ-00000004')).getByText('ЭСМ-2')).toBeDefined();
    expect(within(rowOf('260604-646-00000001')).getByText('4-П')).toBeDefined();

    // У листа на рейс — день, у недельного — обе границы: по одной дате не понять, какую неделю
    // держит бланк.
    expect(within(rowOf('260604-646-00000001')).getByText('10.08.2026')).toBeDefined();
    expect(within(rowOf('ЭСМ-00000004')).getByText('31.08 — 06.09.2026')).toBeDefined();
  });

  it('фильтр по форме уходит на сервер отдельным параметром', async () => {
    const http = renderJournal();
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));
    expect(http.lastCall('GET /waybills')!.query.get('formCode')).toBeNull();

    // Фильтр столбца — тот же приём, что и у статуса: журнал сам спрашивает только период.
    const header = screen.getByRole('columnheader', { name: /Форма/ });
    fireEvent.click(header.querySelector('.ant-table-filter-trigger')!);
    fireEvent.click(
      await screen.findByText('ЭСМ-2', { selector: '.ant-dropdown-menu-title-content span' }),
    );
    fireEvent.click(screen.getByText('OK'));

    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(2));
    expect(http.lastCall('GET /waybills')!.query.get('formCode')).toBe('esm2');
  });

  it('вложения — своей колонкой: скрепка со счётчиком, по клику список', async () => {
    renderJournal();
    await waitFor(() => expect(screen.getByText('ЭСМ-00000004')).toBeDefined());

    // У листа без сканов — «нет», у листа со сканом — их число: пустая ячейка ничего не сообщает.
    fireEvent.click(filesButton(rowOf('ЭСМ-00000004')));
    expect(await screen.findByText('esm2-оборот.pdf')).toBeDefined();
    expect(screen.getByText('Прикрепить')).toBeDefined();
  });

  it('без права на файлы прикрепить нечем, а прочесть — можно', async () => {
    const http = mockHttp({ 'GET /waybills': () => json(list([WEEK])) });
    renderWithUser(<WaybillsPage />, { user: authUser({ role: 'observer' }) });
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));

    await waitFor(() => expect(screen.getByText('ЭСМ-00000004')).toBeDefined());
    fireEvent.click(filesButton(rowOf('ЭСМ-00000004')));
    expect(await screen.findByText('esm2-оборот.pdf')).toBeDefined();
    expect(screen.queryByText('Прикрепить')).toBeNull();
  });
});
