import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AuthUser,
  OfficeEquipmentDto,
  OfficeEquipmentConsumableDetailDto,
  OfficeEquipmentConsumableDto,
  OfficeEquipmentConsumableStockEntryDto,
  OfficeEquipmentModelDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { permissionsFor } from '@technic/contracts';
import { renderWithUser } from './render';
import { MOBILE_VIEWPORT } from './viewport';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { emptyList } from './factories/common';
import { objectDto } from './factories/waste';
import { OfficeEquipmentConsumablesModal } from '../src/pages/directories/OfficeEquipmentConsumablesModal';
import { OfficeEquipmentTab } from '../src/pages/directories/OfficeEquipmentTab';
import { DirectoriesPage } from '../src/pages/DirectoriesPage';

/**
 * Окно «Картриджи и тонеры» (план `docs/office-equipment-consumables-plan.md`, Р7, Р9, §6).
 *
 * Закрепляются три вещи, каждая из которых ломается молча.
 *
 * Первое — порядок. Умолчание `baseListQuery` на сервере это `sortOrder: 'desc'`, и окно, не
 * попросившее алфавит явно, открывалось бы «последняя заведённая сверху»: справочник, который
 * сверяют со счётом глазами, читался бы как случайный список.
 *
 * Второе — что остаток правится только своим окном и только с причиной. Контракт правки карточки
 * количество не принимает вовсе (`z.never()`), поэтому поле на форме карточки означало бы
 * «сохранено» там, где остаток не тронут; а правка без причины оставляет в журнале «12 → 4»,
 * которое через месяц читать нечем.
 *
 * Третье — 409. Это не сбой, а нормальный исход одновременной работы двоих, и человек обязан
 * прочитать словами, что произошло, увидеть новое число и решить сам. Общий тост ошибки на этом
 * месте выглядел бы поломкой портала — и увёл бы правку в никуда.
 */

/**
 * Оператор оргтехники с набором «Оргтехника: номенклатура» (Р10): ведение позиций и правка остатка
 * приходят своими правами, а не общим `officeEquipment.write` — то открывает весь парк техники.
 * Права перечислены прямо, потому что набор выдаётся поимённо и из роли не выводится.
 */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
  permissions: [
    ...permissionsFor({
      role: 'shtab',
      counterpartyType: null,
      addons: ['office_equipment_operator'],
    }),
    'officeEquipmentConsumables.manage',
    'officeEquipmentConsumables.stock',
  ],
});

const MODEL: OfficeEquipmentModelDto = {
  id: 'oem-1',
  type: { id: 'oet-1', name: 'МФУ', isActive: true },
  name: 'Ricoh Aficio MP 201SPF',
  manufacturer: 'Ricoh',
  isActive: true,
  comment: '',
  isUsed: true,
  equipmentCount: 68,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function consumableDto(
  over: Partial<OfficeEquipmentConsumableDto> = {},
): OfficeEquipmentConsumableDto {
  return {
    id: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201 (шт)',
    quantity: 12,
    /*
     * Потребность, «уже заказано» и дефицит (Р13, Р15 плана расходников и закупки). У фикстуры они
     * нулевые: экран печатает эти числа как есть, а проверять на нём формулу
     * `max(0, потребность − остаток − уже заказано)` нечем — считает её сервер одним местом, и
     * второе число, посчитанное здесь, разошлось бы с ним при первой же правке правила.
     */
    requiredQuantity: 0,
    alreadyOrdered: 0,
    deficit: 0,
    isActive: true,
    color: null,
    comment: '',
    models: [{ id: MODEL.id, name: MODEL.name }],
    // Движение уже было: удаление такой карточки запрещено, и остаток у неё правят событием.
    hasStockHistory: true,
    // Сколько аппаратов этой позиции видит смотрящий (Р12): фикстуре хватает единицы — окно
    // печатает число как есть, а его подсчёт проверяется на стороне API.
    equipmentCount: 1,
    /*
     * Когда остаток правили руками (Р3 плана расходников и закупки). Значение отдельное от
     * `updatedAt` намеренно: столбец считается только по ручным правкам, и совпади они в фикстуре,
     * проверка не отличила бы «дату сверки полки» от «даты последней правки карточки».
     */
    lastManualStockAt: '2026-08-20T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    ...over,
  };
}

const ENTRY: OfficeEquipmentConsumableStockEntryDto = {
  id: 'oes-1',
  seq: 1,
  // Ручная правка кладовщика: у неё нет ни заявки, ни её строки — обе ссылки пусты по `CHECK`у.
  entryKind: 'manual',
  serviceRequestId: null,
  serviceRequestConsumableId: null,
  serviceRequestNumber: null,
  // Заявки у ручной правки нет вовсе, поэтому и открывать нечего: признак считает сервер (Р4).
  requestAccessible: false,
  quantityBefore: 15,
  quantityAfter: 12,
  reason: 'выдано на АЛ13',
  changedByName: 'Иванов И. И.',
  // Роль и наборы полномочий — сегодняшние (Р4): историческую роль портал не хранит вовсе.
  changedByRoleLabel: 'Штаб',
  changedByGrants: ['Оргтехника: ведение'],
  createdAt: '2026-08-20T09:00:00.000Z',
};

/**
 * Карточка позиции: с Р4 она ровно то же, что строка списка, — ленту журнала `GET /:id` больше не
 * возит, та уехала в свою ручку со страницами. Фикстура оставлена отдельным именем не для красоты:
 * ответ карточки в тестах подменяют своим (перечитанный после 409 остаток), и звать это «строкой
 * списка» значило бы путать два разных ответа сервера.
 */
function detailDto(
  over: Partial<OfficeEquipmentConsumableDto> = {},
): OfficeEquipmentConsumableDetailDto {
  return consumableDto(over);
}

const LIST = 'GET /office-equipment-consumables';
const DETAIL = 'GET /office-equipment-consumables/:id';
const PATCH = 'PATCH /office-equipment-consumables/:id';
const STOCK = 'POST /office-equipment-consumables/:id/stock';
const ENTRIES = 'GET /office-equipment-consumables/:id/stock-entries';

/** Страница журнала: ровно та форма, которой отвечает новая ручка ленты (Р4). */
function entriesPage(
  items: OfficeEquipmentConsumableStockEntryDto[] = [ENTRY],
  total = items.length,
  page = 1,
) {
  return { items, total, page, pageSize: 50 };
}

/** Тот же оператор, но с одним из двух прав: права проверяются независимо (Р10). */
function withOnly(permission: 'manage' | 'stock'): AuthUser {
  const dropped = `officeEquipmentConsumables.${permission === 'manage' ? 'stock' : 'manage'}`;
  return { ...OPERATOR, permissions: OPERATOR.permissions.filter((p) => p !== dropped) };
}

function renderConsumables(over: RouteMap = {}, user: AuthUser = OPERATOR): HttpMock {
  const http = mockHttp({
    [LIST]: () => json(list([consumableDto()])),
    // Перечень моделей: он же отбор «модель» в шапке и он же поле «Подходит к» в карточке.
    'GET /office-equipment-models': () => json(list([MODEL])),
    [DETAIL]: () => json(detailDto()),
    [ENTRIES]: () => json(entriesPage()),
    ...over,
  });
  renderWithUser(<OfficeEquipmentConsumablesModal open onClose={() => {}} />, { user });
  return http;
}

/** Кнопка строки: подпись живёт в `aria-label` — подсказка antd появляется только по наведению. */
function rowButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
}

/** Окно правки остатка среди прочих: узнаётся по строке, которой больше нигде нет. */
function stockWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.textContent?.includes('Сейчас на складе'),
  );
  if (!found) throw new Error('окно правки остатка не открыто');
  return found;
}

/** Открыть карточку расходника и в ней — окно остатка. */
async function openStockWindow(): Promise<void> {
  await openCard();
  // Сроки ожидания заданы явно: окон открывается два подряд, каждое со своей анимацией и своим
  // запросом карточки, и секунда по умолчанию — это про экран без нагрузки, а не про общий прогон
  // набора, где проверка падала бы не на смысле, а на часах.
  fireEvent.click(await screen.findByText('Изменить остаток', undefined, { timeout: 5000 }));
  await waitFor(() => stockWindow(), { timeout: 5000 });
}

/** Открыть карточку строки: у ведущего номенклатуру она на правку, у прочих — на чтение. */
async function openCard(
  label = 'Редактировать',
  title = 'Редактирование расходника',
): Promise<void> {
  await screen.findByText('Тонер Ricoh 201 (шт)', undefined, { timeout: 5000 });
  fireEvent.click(rowButton(label)!);
  await screen.findByText(title, undefined, { timeout: 5000 });
}

/** Окно карточки расходника: узнаётся по заголовку — среди открытых окон он один такой. */
function cardWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.querySelector('.ant-modal-title')?.textContent?.includes('расходника'),
  );
  if (!found) throw new Error('карточка расходника не открыта');
  return found;
}

function saveStock(): void {
  fireEvent.click(within(stockWindow()).getByRole('button', { name: 'Сохранить' }));
}

describe('окно картриджей и тонеров', () => {
  it('просит алфавит явно: умолчание сервера открыло бы справочник задом наперёд', async () => {
    const http = renderConsumables();

    await screen.findByText('Тонер Ricoh 201 (шт)');
    const query = http.lastCall(LIST)!.query;
    expect(query.get('sortBy')).toBe('name');
    expect(query.get('sortOrder')).toBe('asc');
  });

  it('карточка остаток не правит: поля нет, и в теле правки количества не уходит', async () => {
    const http = renderConsumables({ [PATCH]: () => json(consumableDto({ comment: 'уточнили' })) });

    await screen.findByText('Тонер Ricoh 201 (шт)');
    fireEvent.click(rowButton('Редактировать')!);
    await screen.findByText('Редактирование расходника');
    // Остаток в карточке показан числом рядом с кнопкой, а поля ввода у него нет вовсе: пока окно
    // остатка не открыто, вводить количество негде.
    expect(document.getElementById('quantity')).toBeNull();

    fireEvent.change(document.getElementById('comment')!, { target: { value: 'уточнили' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)!.body as Record<string, unknown>;
    // Количество маршрут правки не принимает вовсе (`z.never()`): присланное, оно превратило бы
    // «сохранено» в обещание, которого никто не выполнял.
    expect(body.quantity).toBeUndefined();
    expect(body.comment).toBe('уточнили');
    // Привязка моделей уходит полным набором — это разметка совместимости, а не пара ручек (Р6).
    expect(body.modelIds).toEqual([MODEL.id]);
  });

  it('остаток правится своим окном: без причины запрос не уходит, с ней уходит увиденное число', async () => {
    const http = renderConsumables({
      [STOCK]: () =>
        json({
          consumable: consumableDto({ quantity: 10 }),
          entry: { ...ENTRY, id: 'oes-2', seq: 2, quantityBefore: 12, quantityAfter: 10 },
        }),
    });

    await openStockWindow();
    fireEvent.change(document.getElementById('quantity')!, { target: { value: '10' } });
    saveStock();

    /*
     * Причина обязательна: тот же CHECK держит и база, и запрос без неё был бы отбит 400 — но
     * человеку об этом сказали бы уже после отправки.
     *
     * Срок ожидания задан явно: под окном списка открыто второе окно, и проверка правил antd
     * доезжает до подстрочника не первым кадром. Секунды по умолчанию хватало ровно до общего
     * прогона на загруженной машине — там проверка падала не на смысле, а на часах.
     */
    await screen.findByText('Укажите причину изменения остатка', undefined, { timeout: 5000 });
    expect(http.countOf(STOCK)).toBe(0);

    fireEvent.change(document.getElementById('reason')!, { target: { value: 'выдано на АЛ13' } });
    saveStock();

    await waitFor(() => expect(http.countOf(STOCK)).toBe(1));
    expect(http.lastCall(STOCK)!.body).toEqual({
      quantity: 10,
      // То значение, которое человек видел на экране: без него две правки от 12 записали бы
      // «12 → 10» и «12 → 8», и журнал стал бы враньём при верном итоге (Р7).
      expectedQuantity: 12,
      reason: 'выдано на АЛ13',
    });
  });

  it('без права на остаток кнопки правки остатка нет ни в строке, ни в карточке', async () => {
    // Ведёт номенклатуру, коробки на полке не считает: правка остатка ему не открыта (Р10).
    renderConsumables({}, withOnly('manage'));

    await screen.findByText('Тонер Ricoh 201 (шт)');
    expect(rowButton('Изменить остаток')).toBeUndefined();
    await openCard();
    expect(screen.queryByText('Изменить остаток')).toBeNull();
    // Само число при этом видно: «сколько осталось» читают все, кому видна оргтехника.
    expect(screen.getByText('В наличии:')).toBeTruthy();
  });

  it('без права на номенклатуру карточка открыта на чтение, а остаток править можно', async () => {
    // Обратный случай: кладовщик. Позицию он не заводит и не правит, но полку пересчитывает.
    renderConsumables({}, withOnly('stock'));

    await screen.findByText('Тонер Ricoh 201 (шт)');
    expect(screen.queryByText('Добавить расходник')).toBeNull();
    expect(rowButton('Удалить')).toBeUndefined();

    // Карточка открывается — остаток и «В парке» в ней читают все, — но заперта на правку.
    await openCard('Открыть карточку', 'Карточка расходника');
    expect((document.getElementById('code') as HTMLInputElement).disabled).toBe(true);
    const save = screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // А остаток — правится: своим окном, из строки таблицы.
    fireEvent.click(rowButton('Изменить остаток')!);
    await waitFor(() => stockWindow());
  });

  it('правила формы знают минимумы контракта: короткий код виден до отправки', async () => {
    // Правило, о котором узнают по ответу 400, человек узнаёт на один ход позже, чем мог бы: тут
    // же, на поле, и без отправки. Края обрезаются так же, как в схеме, — «пробел плюс буква» не
    // должно проходить проверку формы и упираться в сервер.
    const http = renderConsumables({
      'POST /office-equipment-consumables': () => json(consumableDto()),
    });

    fireEvent.click(await screen.findByText('Добавить расходник'));
    await screen.findByText('Новый картридж или тонер', undefined, { timeout: 5000 });
    fireEvent.change(document.getElementById('code')!, { target: { value: ' Д ' } });
    fireEvent.change(document.getElementById('name')!, {
      target: { value: 'Тонер Ricoh 201 (шт)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await screen.findByText('Код номенклатуры — не короче двух символов', undefined, {
      timeout: 5000,
    });
    expect(http.countOf('POST /office-equipment-consumables')).toBe(0);
  });

  it('счётчик «В парке» стоит с подписью про область, а не голым числом', async () => {
    // Срез Р15: сколько аппаратов кормит позиция. Считается он в области смотрящего (Р12), и
    // число без этой оговорки читается как масштаб всего парка компании — ровно та ошибка, ради
    // которой «сколько таких у нас» и разведено с «можно ли удалить».
    renderConsumables({
      [LIST]: () => json(list([consumableDto({ equipmentCount: 68 })])),
      // Карточка показывает своё, перечитанное число: строка списка для неё лишь первый снимок.
      [DETAIL]: () => json(detailDto({ equipmentCount: 68 })),
    });

    await screen.findByText('Тонер Ricoh 201 (шт)');
    expect(screen.getByText('68')).toBeTruthy();
    // Подпись под отборами: подсказке по наведению здесь доверять нельзя — её не видно, пока
    // мышь не остановилась на ячейке, а число видно сразу.
    expect(screen.getByText(/в вашей области видимости/)).toBeTruthy();

    await openCard();
    // В карточке — то же число и та же оговорка рядом с ним, а не в другом окне.
    const card = within(cardWindow());
    expect(card.getByText('68')).toBeTruthy();
    expect(card.getByText(/в вашей области видимости, живых и активных/)).toBeTruthy();
  });

  it('409 показан словами в самом окне, а следующая попытка уходит с перечитанным числом', async () => {
    let detailCalls = 0;
    let stockCalls = 0;
    const http = renderConsumables({
      [DETAIL]: () => {
        detailCalls += 1;
        // Пока окно было открыто, остаток изменил другой человек: перечитанная карточка приносит
        // его число.
        return json(detailDto({ quantity: detailCalls === 1 ? 12 : 8 }));
      },
      [STOCK]: () => {
        stockCalls += 1;
        return stockCalls === 1
          ? apiError(409, {
              code: 'stock_conflict',
              message: 'Остаток изменил другой человек, сейчас 8',
            })
          : json({
              consumable: consumableDto({ quantity: 6 }),
              entry: { ...ENTRY, id: 'oes-3', seq: 3, quantityBefore: 8, quantityAfter: 6 },
            });
      },
    });

    await openStockWindow();
    fireEvent.change(document.getElementById('quantity')!, { target: { value: '6' } });
    fireEvent.change(document.getElementById('reason')!, { target: { value: 'выдано на АЛ13' } });
    saveStock();

    // Человек читает, что произошло, — нашими словами и словами сервера с новым числом.
    await within(stockWindow()).findByText(
      'Пока окно было открыто, остаток изменил другой человек',
    );
    within(stockWindow()).getByText(/Остаток изменил другой человек, сейчас 8/);
    // И не видит общего тоста ошибки: 409 здесь — не сбой, а исход одновременной работы двоих.
    expect(document.querySelector('.ant-message-notice')).toBeNull();

    // Карточка перечитана прямо в открытом окне: «сейчас 8» стоит не только в тексте отказа.
    await waitFor(() => expect(within(stockWindow()).getByText('8')).toBeTruthy());

    saveStock();
    await waitFor(() => expect(http.countOf(STOCK)).toBe(2));
    const body = http.lastCall(STOCK)!.body as Record<string, unknown>;
    // Повтор уходит с тем числом, которое человек видит сейчас, — иначе он получил бы тот же 409
    // по кругу, а сервер так и не узнал бы, что правку подтвердили осознанно.
    expect(body.expectedQuantity).toBe(8);
    expect(body.quantity).toBe(6);
  });
});

/**
 * Окно «История остатка» (план `docs/office-equipment-consumables-and-purchase-plan.md`, Р4).
 *
 * Лента уехала из карточки в своё окно, открываемое действием строки, и вместе с ней уехали два
 * свойства, которых у секции карточки не было и которые ломаются молча: страницы и отбор по виду
 * события. Молча — потому что портал, забывший сбросить страницу или отправить отбор, покажет
 * СТРОКИ ЖУРНАЛА, просто не те: человек прочитает чужой ответ как свой и пойдёт спрашивать, куда
 * делись картриджи, у того, кто их не брал.
 *
 * Право здесь не проверяется намеренно: своего у чтения журнала нет вовсе — он открыт всякому,
 * кому открыт перечень (Р4), и это закреплено самим набором действий строки.
 */

/** Окно журнала среди прочих: узнаётся по заголовку — он один такой. */
function historyWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.querySelector('.ant-modal-title')?.textContent?.includes('История остатка'),
  );
  if (!found) throw new Error('окно истории остатка не открыто');
  return found;
}

/** Открыть журнал действием строки — тем самым, которым его открывают в работе. */
async function openHistory(): Promise<void> {
  await screen.findByText('Тонер Ricoh 201 (шт)', undefined, { timeout: 5000 });
  fireEvent.click(rowButton('История остатка')!);
  await waitFor(() => historyWindow(), { timeout: 5000 });
}

describe('окно «История остатка»', () => {
  it('открывается из строки, называет позицию и спрашивает журнал своей ручкой', async () => {
    const http = renderConsumables();

    await openHistory();

    // Своей ручкой, а не карточкой: `GET /:id` ленту больше не возит вовсе (Р4).
    await waitFor(() => expect(http.countOf(ENTRIES)).toBe(1), { timeout: 5000 });
    const win = within(historyWindow());
    // Заголовок называет наименование и код: окно всегда про одну позицию, общего журнала нет.
    expect(historyWindow().querySelector('.ant-modal-title')!.textContent).toContain(
      'Тонер Ricoh 201 (шт)',
    );
    expect(historyWindow().querySelector('.ant-modal-title')!.textContent).toContain('Д0000093569');
    // Строка ленты на месте: сдвиг знаком, пара «было → стало» и причина.
    expect(win.getByText('-3')).toBeTruthy();
    expect(win.getByText('15 → 12')).toBeTruthy();
    expect(win.getByText('выдано на АЛ13')).toBeTruthy();
    /*
     * Подпись автора — имя, роль и наборы перечнем, и словами сказано, что они СЕГОДНЯШНИЕ
     * (решение заказчика): без этой оговорки подпись читается как снимок того дня, когда событие
     * записывали, — а портал истории роли не хранит вовсе.
     */
    expect(win.getByText('Иванов И. И. · Штаб · Оргтехника: ведение')).toBeTruthy();
    expect(win.getByText(/показаны сегодняшние/u)).toBeTruthy();
  });

  it('листается страницами и отбирается по виду события, начиная отбор с первой страницы', async () => {
    // Событий больше страницы: у ходовой позиции их сотни — ради этого страницы и завели.
    const http = renderConsumables({
      [ENTRIES]: ({ query }) => json(entriesPage([ENTRY], 120, Number(query.get('page') ?? '1'))),
    });

    await openHistory();
    await waitFor(() => expect(http.countOf(ENTRIES)).toBe(1), { timeout: 5000 });
    // Первая страница просится явно, а размер — из общего перечня портала: свой сервер не примет.
    expect(http.lastCall(ENTRIES)!.query.get('page')).toBe('1');
    expect(http.lastCall(ENTRIES)!.query.get('pageSize')).toBe('50');
    // Отбора нет — это «все виды», а не какой-то из них: поле в запрос не уходит вовсе.
    expect(http.lastCall(ENTRIES)!.query.get('entryKind')).toBeNull();

    fireEvent.click(within(historyWindow()).getByTitle('2'));
    await waitFor(() => expect(http.lastCall(ENTRIES)!.query.get('page')).toBe('2'), {
      timeout: 5000,
    });

    fireEvent.click(within(historyWindow()).getByText('Ручные правки'));
    await waitFor(() => expect(http.lastCall(ENTRIES)!.query.get('entryKind')).toBe('manual'), {
      timeout: 5000,
    });
    /*
     * И страница вернулась к первой. Иначе отбор сужает ленту, а номер страницы остаётся от
     * прошлого захода: человек нажимает «Ручные правки» и видит пустоту там, где правки есть.
     */
    expect(http.lastCall(ENTRIES)!.query.get('page')).toBe('1');
  });
});

/**
 * Столбец «Правка остатка» (Р3): когда полку последний раз пересчитывали руками.
 *
 * Пусто — это ответ, а не недогруженные данные: у позиции, заведённой с нулевым остатком, ручных
 * событий нет по построению («0 → 0» журнал не пропускает). Пустая ячейка на этом месте читалась
 * бы как «портал не досчитал», и по ней пошли бы пересчитывать то, что пересчитывать не надо.
 */
describe('столбец «Правка остатка»', () => {
  it('показывает дату последней ручной правки — до минут, как её сверяют с журналом', async () => {
    const http = renderConsumables();

    await screen.findByText('Тонер Ricoh 201 (шт)');
    // По Москве и со временем: дату сверяют со строкой журнала, а у неё время есть, и две разные
    // точности заставляли бы гадать, та ли это правка.
    expect(screen.getByText('20.08.2026 12:00')).toBeTruthy();
    // И это не `updatedAt` карточки: он в фикстуре другой, и его в таблице нет вовсе.
    expect(screen.queryByText('20.08.2026 09:00')).toBeNull();

    /*
     * И столбец сортируемый — ради того же, ради чего заведён: найти позиции, полку которых давно
     * не пересчитывали. Поле уходит на сервер тем именем, которое он принимает; ошибись портал в
     * нём, маршрут ответил бы 400, а список молча остался бы прежним.
     */
    // По самому заголовку столбца, а не по тексту: заголовок здесь — разметка с подсказкой, и
    // текст в разметке таблицы встречается дважды.
    const header = [...document.querySelectorAll('th')].find((th) =>
      th.textContent?.includes('Правка остатка'),
    );
    fireEvent.click(header!);
    await waitFor(
      () => expect(http.lastCall(LIST)!.query.get('sortBy')).toBe('lastManualStockAt'),
      { timeout: 5000 },
    );
  });

  it('у позиции без ручных правок рисует прочерк, а не пустую ячейку', async () => {
    /*
     * Цвет, потребность, «уже заказано» и дефицит заполнены намеренно: прочерк рисуют и они — цвет
     * на «у чёрно-белой позиции его не бывает», три числа на «ноль здесь ответ, а не пустая
     * ячейка» (Р13, Р15). Заполнив их, оставляем в строке ровно один прочерк, и проверка держится
     * за наш столбец, а не за соседний.
     */
    renderConsumables({
      [LIST]: () =>
        json(
          list([
            consumableDto({
              color: 'голубой',
              lastManualStockAt: null,
              requiredQuantity: 20,
              alreadyOrdered: 3,
              deficit: 5,
            }),
          ]),
        ),
    });

    await screen.findByText('Тонер Ricoh 201 (шт)');
    const dashes = [...document.querySelectorAll('table tbody td')].filter(
      (td) => td.textContent === '—',
    );
    expect(dashes).toHaveLength(1);
  });
});

/**
 * Вход в окно (Р10). Права номенклатуры выдаются набором «Оргтехника: номенклатура» и роль их не
 * даёт, а вкладка «Оргтехника» в «Справочниках» открывалась по правам на парк и на справочники
 * целиком — то есть человек, которому эту номенклатуру и поручили, до своей работы не доходил
 * вовсе: кнопка окна внутри вкладки ему открыта, а самой вкладки в разделе нет.
 *
 * Проверка идёт по разделу целиком, а не по условию: условие можно переписать, и тест обязан
 * ломаться на том, что человек снова не видит своей вкладки, а не на форме булева выражения.
 */

/** Кладовщик: своей ролью справочников не ведёт, а остаток расходников правит. */
const KEEPER: AuthUser = authUser({
  role: 'operator',
  permissions: [
    ...permissionsFor({ role: 'operator', counterpartyType: null, addons: [] }),
    // Оба права набора требуют чтения справочника оргтехники (`grants.ts`), и выдаются они вместе.
    'officeEquipment.read',
    'officeEquipmentConsumables.stock',
  ],
});

/** Тот же человек до выдачи набора: ни парка, ни справочников, ни номенклатуры. */
const OUTSIDER: AuthUser = authUser({ role: 'operator' });

function renderDirectories(user: AuthUser): HttpMock {
  const http = mockHttp({
    // Вкладка спрашивает перечень техники и отборы: показать её человеку, у которого эти запросы
    // отвалятся, значило бы открыть пустой экран вместо работы.
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
  });
  renderWithUser(<DirectoriesPage />, { user });
  return http;
}

describe('вход во вкладку «Оргтехника»', () => {
  it('набор номенклатуры открывает вкладку и кнопку окна, но не ведение парка', async () => {
    const http = renderDirectories(KEEPER);

    await screen.findByRole('tab', { name: 'Оргтехника' });
    // Вкладка не «открылась пустой»: перечень техники она спросила, и спросила ровно то, что
    // этому набору прав разрешено (сверх описанных маршрутов `mockHttp` объявил бы сам).
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));
    expect(screen.getByText('Картриджи и тонеры')).toBeTruthy();
    // Вкладка открылась не «на всякий случай»: парк ему по-прежнему не ведут — ни заведения
    // техники, ни окон типов и моделей (у них своё право `officeEquipment.write`).
    expect(screen.queryByText('Добавить технику')).toBeNull();
    expect(screen.queryByText('Модели аппаратов')).toBeNull();
    expect(screen.queryByText('Типы оргтехники')).toBeNull();
  });

  it('без прав номенклатуры вкладки нет вовсе', () => {
    renderDirectories(OUTSIDER);

    expect(screen.queryByRole('tab', { name: 'Оргтехника' })).toBeNull();
    expect(screen.queryByText('Картриджи и тонеры')).toBeNull();
  });
});

/**
 * Карточка аппарата отвечает «чем заправлять» (Р15).
 *
 * Ради этого вопроса карточку и открывают чаще всего: у стойки стоит человек с пустым принтером,
 * и ему нужен код для заказа и ответ «есть ли на складе прямо сейчас». Ходить за этим в окно
 * картриджей, вспоминая имя модели, — лишний ход по справочнику, который портал и так знает.
 *
 * Второе, что здесь закрепляется, — разница между «поля нет» и «список пуст». Поле приходит
 * только в карточке (`GET /:id`); в списке справочника его нет вовсе, и сказать по такому ответу
 * «расходников нет» значит соврать. Пустой массив — уже утверждение, и говорится оно словами.
 */

const EQUIPMENT_TYPE = { id: 'oet-1', name: 'МФУ', isActive: true };

function equipmentDto(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: EQUIPMENT_TYPE,
    model: { id: MODEL.id, name: MODEL.name },
    name: MODEL.name,
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function renderEquipmentTab(card: OfficeEquipmentDto): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([equipmentDto()])),
    // Карточка по идентификатору — единственный ответ, который несёт срез «чем заправлять».
    'GET /office-equipment/:id': () => json(card),
    'GET /office-equipment-types': () =>
      json(
        list([
          {
            id: EQUIPMENT_TYPE.id,
            code: 'mfp',
            name: EQUIPMENT_TYPE.name,
            sortOrder: 1,
            isActive: true,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
      ),
    'GET /office-equipment-models': () => json(list([MODEL])),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
  });
  renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR });
  return http;
}

/** Правка карточки: у кнопок строки справочника техники подписи нет — узнаём по значку. */
async function openEquipmentCard(): Promise<void> {
  await screen.findByText('0012345', { exact: false });
  const button = [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => !b.closest('.ant-modal') && b.querySelector('.anticon-edit'),
  );
  if (!button) throw new Error('кнопки правки карточки в строке нет');
  fireEvent.click(button);
  await screen.findByText('Редактирование карточки');
}

describe('карточка аппарата: чем заправлять', () => {
  it('показывает подходящие расходники с кодом и остатком', async () => {
    renderEquipmentTab(
      equipmentDto({
        consumables: [
          {
            id: 'oec-1',
            code: 'Д0000093569',
            name: 'Тонер Ricoh 201 (шт)',
            color: null,
            quantity: 12,
          },
          {
            id: 'oec-2',
            code: 'Д0000062210',
            name: 'Тонер Ricoh MP C2503 (шт)',
            color: 'голубой',
            quantity: 0,
          },
        ],
      }),
    );

    await openEquipmentCard();
    await screen.findByText('Чем заправлять');
    // Код — то, чем заказывают, и в строке он обязан быть рядом с наименованием.
    expect(screen.getByText('Д0000093569')).toBeTruthy();
    expect(screen.getByText('в наличии 12')).toBeTruthy();
    // Ноль читается не числом, а действием: за этим расходником идти на склад незачем.
    expect(screen.getByText('нет в наличии')).toBeTruthy();
    // Цвет различает позиции цветной серии — без него две строки неотличимы (Р5).
    expect(screen.getByText('голубой')).toBeTruthy();
  });

  it('пустой список говорит словами: к модели ничего не привязано', async () => {
    renderEquipmentTab(equipmentDto({ consumables: [] }));

    await openEquipmentCard();
    // Пустой массив — утверждение «к модели ничего не привязано», и по таким аппаратам как раз
    // и дозаполняют номенклатуру.
    await screen.findByText('К модели этого аппарата не привязан ни один картридж или тонер');
  });

  it('без среза в ответе секции нет вовсе: «поля нет» — это не «расходников нет»', async () => {
    // Поля в ответе нет (старый кэш, список справочника, ответ без среза). Сказать по такому
    // ответу «расходников нет» значит соврать — и человек пойдёт заводить второй такой же код.
    //
    // История обслуживания в фикстуре пустым списком не для красоты: она приезжает тем же ответом
    // и рисуется своей секцией — по ней видно, что карточка уже пришла и отрисована. Без такого
    // маркера проверка «секции нет» проходила бы просто потому, что ответ ещё в пути.
    renderEquipmentTab(equipmentDto({ serviceHistory: [] }));

    await openEquipmentCard();
    await screen.findByText('Обслуживание и гарантии');
    expect(screen.queryByText('Чем заправлять')).toBeNull();
    expect(screen.queryByText(/не привязан ни один картридж/)).toBeNull();
  });
});

/**
 * Вход в окна вкладки с телефона (ADR 0030).
 *
 * Десктопная шапка (`extra`) на узком экране не рисуется вовсе — полоса кнопок заняла бы там весь
 * экран, — и три окна вкладки оказывались недостижимы: само окно расходников к телефону готово
 * (карточки строк, отборы шитом, кнопка в футере), а открыть его было нечем.
 *
 * Дороже всего это стоило именно расходникам: остаток пересчитывают у полки, с телефона в руках, и
 * человек с одним правом на правку остатка до своей работы не доходил.
 */
describe('вкладка «Оргтехника» на телефоне', () => {
  it('открывает окно картриджей и не теряет соседние перечни', async () => {
    const http = mockHttp({
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment-models': () => json(list([MODEL])),
      [LIST]: () => json(list([consumableDto()])),
    });
    renderWithUser(<OfficeEquipmentTab />, { user: OPERATOR, viewport: MOBILE_VIEWPORT });

    // Соседние окна остаются на месте: чинили вход, а не разбирали шапку.
    expect(await screen.findByText('Типы оргтехники')).toBeTruthy();
    expect(screen.getByText('Модели аппаратов')).toBeTruthy();

    fireEvent.click(screen.getByText('Картриджи и тонеры'));

    // Окно не просто открылось — оно спросило свой перечень: на телефоне это и есть та работа,
    // ради которой вход чинили.
    await waitFor(() => expect(http.countOf(LIST)).toBe(1), { timeout: 5000 });
    await screen.findByText('Тонер Ricoh 201 (шт)', undefined, { timeout: 5000 });
  });
});

/**
 * Матрица Р14, направление «расходник → модели». В §9 закреплено обратное («модель → справочник
 * техники»), а это осталось без проверки — и без гашения тоже.
 *
 * Форма расходника всегда шлёт полный набор `modelIds`, то есть любое сохранение потенциально
 * меняет привязку; удаление уносит привязки каскадом. А в окне моделей на этой связи стоят сразу
 * два ответа: «удаляема ли модель» (`isUsed`) и срез «без расходника» (Р15).
 *
 * Дефект невидим глазом на тестовом клиенте, поэтому проверка идёт с ПРОДОВЫМ сроком годности: с
 * нулевым перечень перезапрашивался бы при каждом открытии сам, и пропущенное гашение осталось бы
 * незамеченным до продакшена.
 */

/** Тот же срок годности, что у портала (`src/main.tsx`): без него проверка ничего не значит. */
function productionLikeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 }, mutations: { retry: false } },
  });
}

/** Кнопка вкладки, а не заголовок окна: надписи у них совпадают. */
function openWindow(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => !b.closest('.ant-modal') && b.textContent?.includes(label),
  );
  if (!button) throw new Error(`кнопки «${label}» на вкладке нет`);
  fireEvent.click(button);
}

/** Окно моделей среди прочих узнаётся по подписи счётчика — она в нём одна такая. */
function modelsWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.textContent?.includes('Столбец «В парке» — активные карточки'),
  );
  if (!found) throw new Error('окно моделей не открыто');
  return found;
}

/**
 * Окно расходников среди прочих: узнаётся по подписи под отборами.
 *
 * Область поиска здесь обязательна: у строки модели кнопка правки подписана ровно так же, а
 * закрытое окно antd оставляет в разметке — общий поиск по документу нажал бы соседнюю.
 */
function consumablesWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.textContent?.includes('Остаток правится своим окном'),
  );
  if (!found) throw new Error('окно картриджей не открыто');
  return found;
}

/** Кнопка удаления модели в её окне: подпись живёт в `aria-label`. */
function modelDeleteButton(): HTMLButtonElement {
  const button = modelsWindow().querySelector<HTMLButtonElement>(
    'table button[aria-label="Удалить"]',
  );
  if (!button) throw new Error('кнопки удаления модели в окне нет');
  return button;
}

describe('матрица Р14: правка расходника и окно моделей', () => {
  it('привязка расходника доезжает до окна моделей без перезагрузки', async () => {
    // Пока расходник не привязан, модель свободна и удаляема; после сохранения — уже нет.
    let bound = false;
    const http = mockHttp({
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment-models': () => json(list([{ ...MODEL, isUsed: bound }])),
      [LIST]: () => json(list([consumableDto()])),
      [DETAIL]: () => json(detailDto()),
      [PATCH]: () => {
        bound = true;
        return json(consumableDto());
      },
    });
    renderWithUser(<OfficeEquipmentTab />, {
      user: OPERATOR,
      queryClient: productionLikeClient(),
    });

    openWindow('Модели аппаратов');
    await waitFor(() => expect(modelDeleteButton().disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(modelsWindow().querySelector('.ant-modal-close')!);

    openWindow('Картриджи и тонеры');
    const consumables = within(consumablesWindow());
    await consumables.findByText('Тонер Ricoh 201 (шт)', undefined, { timeout: 5000 });
    fireEvent.click(consumablesWindow().querySelector('table button[aria-label="Редактировать"]')!);
    await screen.findByText('Редактирование расходника', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1), { timeout: 5000 });

    openWindow('Модели аппаратов');
    /*
     * Без гашения корня моделей окно показало бы прежний ответ из кэша — и не спросило бы сервер
     * вовсе: перечень ещё «свежий». Человек увидел бы активную кнопку «Удалить» и получил бы 409,
     * то есть портал позвал бы его на отказ.
     */
    await waitFor(() => expect(modelDeleteButton().disabled).toBe(true), { timeout: 5000 });
  });
});
