import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { MechRequestDto, MechRequestHistorySummaryDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { MechRequestsPage } from '../src/pages/mech/MechRequestsPage';

/**
 * Механизация → «История» (план `docs/mechanization-module-plan.md`, §7, Э3).
 *
 * Закрепляется то, что ломается молча и читается неверно.
 *
 * **Часы и смены — два числа, а не одно.** Ставка задаётся за час либо за смену (Р7), складывать
 * их нельзя, и «120» без единицы не значит ничего. Единица не встретилась в отборе — её число не
 * показывается вовсе: «Отработано смен: 0» в журнале, где смен не было ни одной, читается как
 * «техника простояла», то есть отвечает на вопрос, которого никто не задавал.
 *
 * **Журнал — своя ручка, а не список с отбором по статусу.** У него свой порядок, свои поля
 * сортировки и свой итог; спроси он `/mech-requests` с `status=done`, вкладка потеряла бы и
 * сортировку по факту, и сводку.
 *
 * **Итог и файл считаются по отбору, а не по странице.** Сводка, посчитанная по двадцати видимым
 * строкам, врёт вернее, чем её отсутствие, а книга, повторяющая одну страницу, читается как весь
 * период.
 */

const HISTORY = 'GET /mech-requests/history';
const SUMMARY = 'GET /mech-requests/history/summary';
const EXPORT = 'GET /mech-requests/history/export';

function requestDto(over: Partial<MechRequestDto> = {}): MechRequestDto {
  return {
    id: 'mech-1',
    num: 42,
    displayNumber: 'МХ-42',
    objectId: 'obj-1',
    objectCode: 'О-1',
    objectName: 'Школа №7',
    objectAddress: 'Ленина, 14',
    departmentId: null,
    departmentCode: null,
    departmentName: null,
    kindName: 'Виброплита реверсивная',
    plannedFrom: '2026-08-03',
    plannedTo: '2026-08-17',
    responsibleName: 'Петров П. П.',
    responsiblePhone: '9000000000',
    comment: '',
    status: 'done',
    cancelReason: null,
    lessorId: 'cp-1',
    lessorName: 'СтройАренда',
    lessorType: 'mech_lessor',
    rate: 1200,
    rateUnit: 'hour',
    actualFrom: '2026-08-03',
    actualTo: '2026-08-19',
    actualUnits: 120,
    finalCost: 144000,
    files: [],
    version: 3,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-19T08:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    ...over,
  };
}

/** Отменённая до подачи: закрыта, но арендой не была — техника по ней не выезжала. */
const CANCELLED = requestDto({
  id: 'mech-2',
  num: 43,
  displayNumber: 'МХ-43',
  status: 'cancelled',
  cancelReason: 'Обошлись своими силами',
  lessorId: null,
  lessorName: null,
  lessorType: null,
  rate: null,
  rateUnit: null,
  actualFrom: null,
  actualTo: null,
  actualUnits: null,
  finalCost: null,
});

function summaryDto(
  over: Partial<MechRequestHistorySummaryDto> = {},
): MechRequestHistorySummaryDto {
  return {
    closed: 2,
    rentals: 1,
    cancelled: 1,
    days: 17,
    hours: 120,
    shifts: 0,
    cost: '144000.00',
    ...over,
  };
}

/** Справочники отборов: экрану они нужны все, а сценарию не интересен ни один. */
const DICTIONARIES: RouteMap = {
  'GET /objects': () => json(emptyList()),
  'GET /departments': () => json(emptyList()),
  'GET /counterparties': () => json(emptyList()),
  'GET /mech-requests/kinds': () => json({ items: [] }),
};

function renderHistory(routes: RouteMap = {}) {
  const http = mockHttp({
    ...DICTIONARIES,
    [HISTORY]: () => json(list([requestDto(), CANCELLED])),
    [SUMMARY]: () => json(summaryDto()),
    [EXPORT]: () => json({}),
    ...routes,
  });
  renderWithUser(<MechRequestsPage />, { route: '/mech?tab=history' });
  return http;
}

/**
 * Текст сводки одной строкой — читаем её так же, как человек: подпись вместе со значением.
 *
 * Числа проверяются в паре с подписью, а не поиском по «8»: то же число стоит в таблице, и
 * одинокий поиск подтвердил бы сводку строкой списка. Неразрывные пробелы `toLocaleString`
 * заменяются обычными — глазами эта разница не видна, а сравнение строк ломает.
 */
function summaryText(): string {
  return (document.querySelector('.ant-tabs-extra-content')?.textContent ?? '').replace(
    /\u00a0/gu,
    ' ',
  );
}

beforeAll(() => {
  // jsdom не умеет ни того, ни другого, а `apiDownload` зовёт оба: без заглушек падал бы
  // транспорт, а не проверяемое поведение.
  URL.createObjectURL = () => 'blob:mech-history';
  URL.revokeObjectURL = () => {};
});

describe('механизация: журнал закрытых аренд', () => {
  it('показывает часы отдельным числом, а смен, которых не было, не показывает вовсе', async () => {
    renderHistory();

    await waitFor(() => expect(summaryText()).toContain('Отработано часов: 120'));
    // Ноль смен — не ответ: в отборе не встретилось ни одной заявки со ставкой за смену.
    expect(summaryText()).not.toContain('Отработано смен');
    // Деньги приходят строкой `numeric` и показываются форматом модуля, а не сырым «144000.00».
    expect(summaryText()).toContain('Стоимость: 144 000,00 ₽');
  });

  it('часы и смены стоят двумя числами, когда встретились обе единицы', async () => {
    renderHistory({ [SUMMARY]: () => json(summaryDto({ hours: 120, shifts: 3 })) });

    // Два числа со своими подписями, и нигде не 123: час и смена — разные величины, а не разные
    // единицы одной.
    await waitFor(() => expect(summaryText()).toContain('Отработано часов: 120'));
    expect(summaryText()).toContain('Отработано смен: 3');
    expect(summaryText()).not.toContain('123');
  });

  it('закрытые и аренды показаны разными числами с разными подписями', async () => {
    renderHistory({
      [SUMMARY]: () => json(summaryDto({ closed: 5, rentals: 3, cancelled: 2 })),
    });

    /*
     * «Закрыто» и «Из них с выдачей» — не одно и то же число: закрыта и та заявка, которую
     * отменили до подачи, но арендой она не была — техника по ней не выезжала, и в расходы она не
     * идёт. Каждое число берётся из своего поля ответа: покажи вкладка `closed` дважды, разница
     * пропала бы молча, а вместе с ней и смысл подписи.
     */
    await waitFor(() => expect(summaryText()).toContain('Закрыто: 5'));
    expect(summaryText()).toContain('Из них с выдачей: 3');
    expect(summaryText()).toContain('Отменена: 2');
  });

  it('спрашивает свою ручку журнала, без отборов действующей аренды', async () => {
    const http = renderHistory();

    await waitFor(() => expect(http.countOf(HISTORY)).toBe(1));
    const call = http.lastCall(HISTORY)!;
    // Порядок — по плановому возврату: у отменённой заявки фактического нет вовсе, и по нему все
    // отмены слиплись бы в пустой хвост.
    expect(call.query.get('sortBy')).toBe('plannedTo');
    for (const absent of ['rental', 'overdue', 'archive']) {
      expect(call.query.get(absent)).toBeNull();
    }
    // Список заявок при этом не дёргается: журнал не его отбор, а своя выборка.
    expect(http.countOf('GET /mech-requests')).toBe(0);
  });

  it('итог считается по отбору, а не по странице', async () => {
    const http = renderHistory();

    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    const call = http.lastCall(SUMMARY)!;
    expect(call.query.get('page')).toBeNull();
    expect(call.query.get('pageSize')).toBeNull();
  });

  it('выгрузка уносит тот же отбор и тот же порядок, что на экране, но не страницу', async () => {
    const http = renderHistory({
      [HISTORY]: ({ query }) =>
        json(list(query.get('status') === 'cancelled' ? [CANCELLED] : [requestDto(), CANCELLED])),
    });

    // Кнопка выгрузки ждёт ответа списка: пустой отбор выгружать нечего, и до него она выключена.
    await waitFor(() => expect(http.countOf(HISTORY)).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Выгрузить/u }));

    await waitFor(() => expect(http.countOf(EXPORT)).toBe(1));
    const call = http.lastCall(EXPORT)!;
    expect(call.query.get('sortBy')).toBe('plannedTo');
    expect(call.query.get('page')).toBeNull();
  });
});
