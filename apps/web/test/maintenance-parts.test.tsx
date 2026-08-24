import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AutoPartDto, MaintenanceUpdateBody } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { maintenancePart, maintenanceRecord, maintenanceSummary } from './factories/maintenance';
import { VehicleMaintenanceBlock } from '../src/features/vehicle-maintenance';

/**
 * Расход автозапчастей в акте обслуживания (план `docs/auto-parts-plan.md`, этап 5).
 *
 * Проверяется то, ради чего блок и заведён, — не «поля отрисовались», а четыре утверждения, каждое
 * из которых при поломке стоит склада:
 *
 *   1. **Итог будущей записи виден до нажатия** (§8). Движение необратимо: журнал остатка
 *      неизменяем, и узнавать «12 → 11» из ленты постфактум поздно.
 *   2. **Правка реквизитов склад не двигает** (Р18, Р19). Портал всегда шлёт полный набор строк —
 *      тот же самый набор сервер видит нулевой разницей и второго права не спрашивает. Диспетчер
 *      без `autoParts.stock` правит номер документа у акта с расходом, и строки остаются на месте.
 *   3. **Отказ по строке окно не закрывает** (Р7). 409 с кодом склада — не «версия уехала»: набранное
 *      в форме и есть то, что надо поправить.
 *   4. **Акт с движениями аннулируют, а не удаляют** (Р6), и портал знает это заранее по
 *      `hasPartMovements`, а не из 409 после нажатия.
 */

const SUMMARY = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';
const CREATE = 'POST /vehicle-maintenance/vehicles/:vehicleId';
const UPDATE = 'PATCH /vehicle-maintenance/:id';
const VOID = 'POST /vehicle-maintenance/:id/void';
const PARTS = 'GET /auto-parts';
const PART = 'GET /auto-parts/:id';

const ON = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';

const shown = () => (document.body.textContent ?? '').replace(/\u00a0/gu, ' ');

/** Карточка склада: остаток, единица и дата заведения — на них опирается весь блок. */
function autoPart(over: Partial<AutoPartDto> = {}): AutoPartDto {
  return {
    id: 'ap-1',
    code: 'LF3349',
    name: 'Фильтр масляный',
    unit: 'шт',
    quantity: 12,
    isActive: true,
    comment: '',
    applicability: [],
    hasStockHistory: true,
    createdAt: '2026-01-10T08:00:00.000Z',
    updatedAt: '2026-01-10T08:00:00.000Z',
    ...over,
  };
}

/** Механик: у него и акт, и склад. Диспетчер ведёт акт, но остаток не двигает (Р19). */
const mechanic = () => authUser({ role: 'mechanic' });

function renderBlock(over: RouteMap = {}, user = mechanic(), route = '/garage'): HttpMock {
  const http = mockHttp({
    [SUMMARY]: () => json(maintenanceSummary()),
    [HISTORY]: () => json({ items: [maintenanceRecord()] }),
    [PARTS]: () => json({ items: [autoPart()], total: 1, page: 1, pageSize: 50 }),
    [PART]: ({ params }) => json(autoPart({ id: params.id })),
    ...over,
  });
  renderWithUser(<VehicleMaintenanceBlock vehicleId="v-1" vehicleLabel={LABEL} on={ON} />, {
    user,
    route,
  });
  return http;
}

/** Открытая форма заведения акта. */
async function openCreateForm(over: RouteMap = {}, user = mechanic()) {
  const http = renderBlock(
    { [CREATE]: () => json(maintenanceRecord({ id: 'm-2' }), 201), ...over },
    user,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Добавить ТО/u }));
  await screen.findByText(`Запись о ТО — ${LABEL}`);
  return http;
}

/** Выбор позиции в строке блока: список живёт в портале, поэтому вариант ищется в выпадашке. */
async function pickPart(text: string) {
  const input = screen.getAllByLabelText('Позиция').at(-1)!;
  const field = input.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(text),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(option);
}

describe('блок автозапчастей в форме акта', () => {
  it('подбор идёт под машину и показывает остаток с единицей', async () => {
    const http = await openCreateForm();

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    await waitFor(() => expect(http.countOf(PARTS)).toBe(1));
    // Ранг применимости считает сервер (Р21): портал называет машину и не сортирует пришедшее сам.
    expect(http.lastCall(PARTS)!.query.get('vehicleId')).toBe('v-1');
    // Погашенные в подбор не идут (Р24): добавить такую строку всё равно нельзя.
    expect(http.lastCall(PARTS)!.query.get('isActive')).toBe('true');

    await pickPart('Фильтр масляный');
    // Остаток и единица видны прямо в строке: «5» без единицы — загадка.
    expect(shown()).toContain('12 шт');
    expect(shown()).toContain('Остаток изменится после сохранения всего акта');
  });

  it('итог «после сохранения» считается словами и уходит в тело запроса', async () => {
    const http = await openCreateForm();

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    await pickPart('Фильтр масляный');

    await waitFor(() => expect(shown()).toContain('После сохранения: Фильтр масляный 12 → 11'));

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    const body = http.lastCall(CREATE)!.body as MaintenanceUpdateBody;
    expect(body.parts).toEqual([{ autoPartId: 'ap-1', quantity: 1, note: '' }]);
  });

  it('количество больше остатка подсвечивается до отправки', async () => {
    await openCreateForm({
      [PARTS]: () => json({ items: [autoPart({ quantity: 3 })], total: 1, page: 1, pageSize: 50 }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    await pickPart('Фильтр масляный');
    fireEvent.change(screen.getAllByLabelText('Количество').at(-1)!, { target: { value: '5' } });

    // Предупреждение, а не запрет: остаток сервер проверяет под блокировкой, и проверенное формой
    // число к моменту записи уже устареет (Р7).
    await waitFor(() => expect(shown()).toContain('На складе 3 шт — не хватает 2'));
    expect(screen.getByRole('button', { name: 'Сохранить' }).hasAttribute('disabled')).toBe(false);
  });

  it('строка без позиции не отправляется, и отказ виден в самом блоке', async () => {
    const http = await openCreateForm();

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    // Не тост в углу (ADR 0094): строка живёт состоянием окна, но место ошибки названо.
    expect(await screen.findByText(/Выберите позицию в строке автозапчастей/u)).toBeDefined();
    expect(http.countOf(CREATE)).toBe(0);
  });

  it('акт раньше заведения позиции — предупреждение о двойном списании', async () => {
    await openCreateForm({
      [PARTS]: () =>
        json({
          items: [autoPart({ createdAt: '2026-08-24T08:00:00.000Z' })],
          total: 1,
          page: 1,
          pageSize: 50,
        }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    await pickPart('Фильтр масляный');

    // Открывающий остаток уже учитывает всё, что установлено раньше (Р20).
    await waitFor(() => expect(shown()).toContain('акт раньше даты заведения выбранной позиции'));
    expect(shown()).toContain('заведена 24.08.2026');
  });

  it('нехватку остатка объясняет сервер, и окно остаётся открытым', async () => {
    const http = await openCreateForm({
      [CREATE]: () =>
        apiError(409, {
          code: 'auto_part_shortage',
          message: 'На складе «Фильтр масляный»: 3 шт, списываете 5',
        }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Добавить позицию/u }));
    await pickPart('Фильтр масляный');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(await screen.findByText(/списываете 5/u)).toBeDefined();
    // Следующий шаг сервер назвать не может — он отвечает про запись, а не про экран.
    expect(shown()).toContain('оприходуйте остаток');
    // Окно не закрывается: набранное в нём и есть то, что надо поправить.
    expect(screen.queryByText(`Запись о ТО — ${LABEL}`)).not.toBeNull();
  });
});

describe('правка акта не двигает склад сама по себе', () => {
  const withParts = () =>
    maintenanceRecord({ parts: [maintenancePart({ quantity: 2 })], hasPartMovements: true });

  it('механик правит номер документа — строки уходят прежним набором', async () => {
    const http = renderBlock({
      [HISTORY]: () => json({ items: [withParts()] }),
      [UPDATE]: () => json(withParts()),
    });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить запись ТО' }));
    await screen.findByText(`Правка записи ТО — ${LABEL}`);
    fireEvent.change(screen.getByLabelText('Номер документа'), { target: { value: 'Акт № 129' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    const body = http.lastCall(UPDATE)!.body as MaintenanceUpdateBody;
    expect(body.documentNumber).toBe('Акт № 129');
    // Полный набор, а не пропуск поля: тот же набор сервер видит нулевой разницей и склад не
    // двигает (Р5, Р18). Пропуск же означал бы «строки не менять» — верно, но угадывать «трогали
    // блок или нет» портал не станет.
    expect(body.parts).toEqual([{ autoPartId: 'ap-1', quantity: 2, note: '' }]);
  });

  it('диспетчеру блок виден только на чтение, и склад он не спрашивает', async () => {
    const http = renderBlock(
      { [HISTORY]: () => json({ items: [withParts()] }), [UPDATE]: () => json(withParts()) },
      authUser(),
    );
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить запись ТО' }));
    await screen.findByText(`Правка записи ТО — ${LABEL}`);

    // Строки видны словами, полей ввода нет: акт правят и менеджер с диспетчером, а склад двигают
    // механики (Р19).
    expect(shown()).toContain('Фильтр масляный · LF3349');
    expect(screen.queryByLabelText('Позиция')).toBeNull();
    expect(screen.queryByRole('button', { name: /Добавить позицию/u })).toBeNull();
    // Остатки ему не нужны: подпись, ради которой они пришли бы, тут не рисуется.
    expect(http.countOf(PARTS)).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(UPDATE)).toBe(1));
    const body = http.lastCall(UPDATE)!.body as MaintenanceUpdateBody;
    expect(body.parts).toEqual([{ autoPartId: 'ap-1', quantity: 2, note: '' }]);
  });
});

describe('история актов', () => {
  const withParts = () =>
    maintenanceRecord({
      parts: [
        maintenancePart({ quantity: 8, unit: 'л', name: 'Масло моторное 10W-40', note: 'Замена' }),
      ],
      hasPartMovements: true,
    });

  it('строка раскрывается списком поставленного', async () => {
    renderBlock({ [HISTORY]: () => json({ items: [withParts()] }) });
    await screen.findByText('Обслуживание');

    // До раскрытия журнал остаётся журналом: позиций у акта бывает десяток.
    expect(shown()).not.toContain('Установленные автозапчасти');
    fireEvent.click(document.querySelector('.ant-table-row-expand-icon')!);

    expect(await screen.findByText('Установленные автозапчасти')).toBeDefined();
    expect(shown()).toContain('Масло моторное 10W-40');
    expect(shown()).toContain('8 л');
    expect(shown()).toContain('Замена');
  });

  it('акт без расхода не раскрывается вовсе', async () => {
    renderBlock();
    await screen.findByText('Обслуживание');

    // Пустой раскрыватель обещал бы содержимое, которого у акта нет.
    expect(document.querySelector('.ant-table-row-expand-icon-spaced')).not.toBeNull();
    expect(document.querySelector('.ant-table-row-expand-icon-collapsed')).toBeNull();
  });

  it('адрес называет акт — строки раскрыты сразу', async () => {
    renderBlock(
      { [HISTORY]: () => json({ items: [withParts()] }) },
      mechanic(),
      '/garage?maintenance=v-1&record=m-1',
    );

    // Ссылка из ленты склада ведёт к документу, а не к машине: раскрывать строку руками человек
    // не должен — он пришёл за ответом «почему стало 11» (Р14).
    expect(await screen.findByText('Установленные автозапчасти')).toBeDefined();
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
});

describe('аннулирование вместо удаления', () => {
  const withMovements = () =>
    maintenanceRecord({ parts: [maintenancePart({ quantity: 2 })], hasPartMovements: true });

  it('у акта с движениями склада кнопка «Удалить» заменена', async () => {
    renderBlock({ [HISTORY]: () => json({ items: [withMovements()] }) });
    await screen.findByText('Обслуживание');

    // Портал знает правило заранее по `hasPartMovements`, а не узнаёт его из 409 после нажатия.
    expect(screen.queryByRole('button', { name: 'Удалить запись ТО' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Аннулировать запись ТО' })).toBeDefined();
  });

  it('окно требует причину и называет возвращаемое, а запрос идёт с версией', async () => {
    const http = renderBlock({
      [HISTORY]: () => json({ items: [withMovements()] }),
      [VOID]: () => json(withMovements()),
    });
    await screen.findByText('Обслуживание');

    fireEvent.click(await screen.findByRole('button', { name: 'Аннулировать запись ТО' }));
    await screen.findByText(/Аннулировать акт от/u);
    // Возврат назван до нажатия: аннулирование двигает склад сразу по всем строкам.
    expect(shown()).toContain('Все позиции акта вернутся на склад');
    expect(shown()).toContain('Фильтр масляный +2 шт');

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

    // Не «запись изменили в другом окне»: 409 здесь про склад, и открывать её заново незачем.
    expect(await screen.findByText(/аннулируют с причиной/u)).toBeDefined();
    expect(shown()).not.toContain('изменили в другом окне');
    // Журнал перечитывается: кнопка стояла по устаревшему признаку и обещала невозможное.
    await waitFor(() => expect(http.countOf(HISTORY)).toBe(2));
  });
});
