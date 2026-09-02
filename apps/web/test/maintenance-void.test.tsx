import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { maintenanceRecord, maintenanceSummary } from './factories/maintenance';
import { VehicleMaintenanceBlock } from '../src/features/vehicle-maintenance';

/**
 * Акт обслуживания, который нельзя удалить (план `docs/auto-parts-plan.md`, Р6, и
 * `docs/auto-part-receipts-plan.md`, Р2, Р3).
 *
 * Строк расхода портал больше не читает и не шлёт: купленное живёт чеками во вкладке
 * «Автозапчасти», а не списанием со склада. А вот запрет удаления пережил склад и уходит только со
 * вторым выпуском, поэтому проверяются ровно те три утверждения, которые ему остались:
 *
 *   1. **Правило известно заранее по `hasPartMovements`**, а не по строкам акта: строки снимали
 *      правкой, а движения по ним оставались навсегда — `parts.length` не ответил бы на этот
 *      вопрос и раньше;
 *   2. **окно аннулирования называет последствие и требует причину**, а возврат позиций не
 *      обещает: до заморозки его делает сервер, и это не то, что портал может пообещать человеку;
 *   3. **отказ 409 «по акту прошёл расход» — не «версия уехала»**: открывать запись заново
 *      незачем, а журнал перечитывается — кнопка стояла по устаревшему признаку.
 */

const SUMMARY = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';
const VOID = 'POST /vehicle-maintenance/:id/void';

const ON = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';

const shown = () => (document.body.textContent ?? '').replace(/\u00a0/gu, ' ');

/** Механик ведёт акты обслуживания: у него и правка, и аннулирование. */
const mechanic = () => authUser({ role: 'mechanic' });

function renderBlock(over: RouteMap = {}, user = mechanic(), route = '/garage'): HttpMock {
  const http = mockHttp({
    [SUMMARY]: () => json(maintenanceSummary()),
    [HISTORY]: () => json({ items: [maintenanceRecord()] }),
    ...over,
  });
  renderWithUser(<VehicleMaintenanceBlock vehicleId="v-1" vehicleLabel={LABEL} on={ON} />, {
    user,
    route,
  });
  return http;
}

describe('история актов', () => {
  it('действующий акт не раскрывается: раскрытие обещало бы объяснение, которого нет', async () => {
    renderBlock();
    await screen.findByText('Обслуживание');

    expect(document.querySelector('.ant-table-row-expand-icon-spaced')).not.toBeNull();
    expect(document.querySelector('.ant-table-row-expand-icon-collapsed')).toBeNull();
  });

  it('аннулированный акт помечен, объяснён и не правится', async () => {
    renderBlock({
      [HISTORY]: () =>
        json({
          items: [
            maintenanceRecord({
              voidedAt: '2026-08-24T09:30:00.000Z',
              voidedByName: 'Механиков Михаил Иванович',
              voidReason: 'Акт заведён на чужую машину',
            }),
          ],
        }),
    });
    await screen.findByText('Обслуживание');

    expect(shown()).toContain('Аннулирован');
    // Правка закрыта: прошлое не подчищают, его объясняют — исправление вводится новым актом (Р6).
    expect(
      screen.getByRole('button', { name: 'Изменить запись ТО' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(document.querySelector('.ant-table-row-expand-icon')!);
    expect(await screen.findByText(/Акт заведён на чужую машину/u)).toBeDefined();
  });

  it('акт, названный в адресе, раскрыт сразу', async () => {
    renderBlock(
      {
        [HISTORY]: () =>
          json({
            items: [
              maintenanceRecord({
                voidedAt: '2026-08-24T09:30:00.000Z',
                voidedByName: 'Механиков Михаил Иванович',
                voidReason: 'Акт заведён на чужую машину',
              }),
            ],
          }),
      },
      mechanic(),
      '/garage?maintenance=v-1&record=m-1',
    );

    // Ссылка ведёт к документу, а не к машине: раскрывать строку руками человек не должен — он
    // пришёл за ответом «что с этим актом» (Р14).
    expect(await screen.findByText(/Акт заведён на чужую машину/u)).toBeDefined();
  });
});

describe('аннулирование вместо удаления', () => {
  /** Акт с движениями складского журнала: они пережили строки расхода и запрет держат они (Р3). */
  const withMovements = () => maintenanceRecord({ hasPartMovements: true });

  it('у акта с движениями кнопка «Удалить» заменена', async () => {
    renderBlock({ [HISTORY]: () => json({ items: [withMovements()] }) });
    await screen.findByText('Обслуживание');

    // Портал знает правило заранее по `hasPartMovements`, а не узнаёт его из 409 после нажатия.
    expect(screen.queryByRole('button', { name: 'Удалить запись ТО' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Аннулировать запись ТО' })).toBeDefined();
  });

  it('окно называет последствие, требует причину, а запрос идёт с версией', async () => {
    const http = renderBlock({
      [HISTORY]: () => json({ items: [withMovements()] }),
      [VOID]: () => json(withMovements()),
    });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Аннулировать запись ТО' }));
    await screen.findByText(/Аннулировать акт от/u);
    // Последствие названо до нажатия, а возврат позиций не обещан: строк портал не знает вовсе.
    expect(shown()).toContain('Акт останется в истории с пометкой');
    expect(shown()).toContain('пробег с ТО');
    expect(shown()).not.toContain('вернутся на склад');

    fireEvent.click(screen.getByRole('button', { name: 'Аннулировать' }));
    // Без причины запрос не уходит: аннулированный акт читают через месяц.
    await screen.findByText('Укажите причину аннулирования');
    expect(http.countOf(VOID)).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина аннулирования'), {
      target: { value: 'Акт заведён на чужую машину' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Аннулировать' }));

    await waitFor(() => expect(http.countOf(VOID)).toBe(1));
    expect(http.lastCall(VOID)!.path).toBe('/vehicle-maintenance/m-1/void');
    expect(http.lastCall(VOID)!.body).toEqual({
      version: 0,
      reason: 'Акт заведён на чужую машину',
    });
  });

  it('удаление акта, по которому успели провести расход, объясняется словами', async () => {
    const http = renderBlock({
      'DELETE /vehicle-maintenance/:id': () =>
        apiError(409, {
          code: 'maintenance_has_stock_movements',
          message:
            'По акту прошёл расход автозапчастей — такой акт не удаляют, а аннулируют с причиной',
        }),
    });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить запись ТО' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));

    // Не «запись изменили в другом окне»: 409 здесь про движения, и открывать её заново незачем.
    expect(await screen.findByText(/аннулируют с причиной/u)).toBeDefined();
    expect(shown()).not.toContain('изменили в другом окне');
    // Журнал перечитывается: кнопка стояла по устаревшему признаку и обещала невозможное.
    await waitFor(() => expect(http.countOf(HISTORY)).toBe(2));
  });
});
