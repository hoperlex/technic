import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRequestDto } from '@technic/contracts';
import { typeDate } from './antd';
import { json, mockHttp, type HttpMock, type RecordedCall, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser, shtabUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  classification,
  freightRequest,
  freightTrip,
  ownAssignment,
  requestRoute,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Копия заявки на технику (ADR 0173, ADR 0206): «Завести такую же» в карточке открывает форму
 * **заведения** с составом прежнего заказа — с карточки заявки ЛЮБОГО статуса.
 *
 * Что здесь стережётся — пять вещей, и каждая ломается молча:
 *
 * 1. **Копия сохраняется заведением, а не правкой.** Ошибись `record` — и «копия» переписала бы
 *    исходную заявку: экран при этом выглядит одинаково, а в списке вместо двух заявок остаётся
 *    одна, изменённая. С работающей и закрытой заявкой цена ошибки выше всего: там правка сдвинула
 *    бы срок машины, которая уже ходит, или переписала бы предъявленный счёт.
 * 2. **Срок предлагается заново — тремя способами (ADR 0206).** Заведение не принимает
 *    необъявленное прошлое (`BACKDATE_UNDECLARED_MESSAGE`), и копия месячной давности упёрлась бы в
 *    отказ на поле, которого человек не трогал. Но «сдвинуть вперёд» — ответ не на всякий случай:
 *    у идущего заказа так уехал бы за прежний и конец, то есть копия заказала бы больше, чем
 *    просят. Ветку выбирает календарь: срок впереди — не двигается, идёт — предлагается остаток,
 *    прошёл — сдвигается с сохранением длительности.
 * 3. **Границу «остатка» держит сегодняшний день, а не первый доступный.** Разница видна только у
 *    заявителя после 15:00 (ADR 0104): его `minDate` — послезавтра, и чужой заказ, начинающийся
 *    завтра, спроси мы ветку у `minDate`, молча превратился бы в «остаток» с послезавтра, потеряв
 *    день работы вместо честного сдвига всего срока.
 * 4. **Переносится заказ, а не запись.** Ездки едут без `id` (строгая схема заведения чужой `id`
 *    отвергнет), рейс и назначенная машина не едут вовсе, а позиция классификатора берётся
 *    **заказанная**: заявку закрыли краном крупнее (ADR 0059) — повторяют всё равно то, что просили.
 * 5. **Календарь заморожен на момент открытия формы.** Поля заполняются один раз, а надпись
 *    рисуется на каждом рендере: спроси она календарь заново — форма, пережившая 15:00 или
 *    полночь, объясняла бы человеку не тот срок, что стоит у неё же в полях. Верят при этом
 *    надписи, а не полям.
 *
 * Живых границ у действия осталось две, и обе здесь: архивная заявка копии не даёт, и роль без
 * права заведения кнопки не видит.
 */

/*
 * Часы фиксированы на весь файл. Правило срока ветвится по сегодняшнему дню, и без фиксации
 * «идущий заказ» перестал бы идти ровно в полночь прогона — набор краснел бы сам собой, не
 * изменившись ни строкой. Полдень МСК взят намеренно: и отсечка 15:00 не пройдена (её двигает
 * отдельный сценарий), и календарный день в поясе прогона тот же, что московский.
 *
 * `shouldAdvanceTime` обязателен: без него `waitFor` из testing-library ждёт по остановленным
 * часам и падает по своему тайм-ауту, ничего не дождавшись.
 */
const NOON_MSK = new Date('2026-09-22T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOON_MSK });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Заказ спецтехники в прошлом: три дня, 05.08–07.08 — оба дня давно позади. */
const SPECIAL = vehicleRequest({ id: 'vr-1', status: 'new', version: 7 });

/**
 * Та же заявка, но настоящая работающая: срок идёт (18.09–30.09), машина назначена, рейс заведён.
 *
 * Машина при этом **крупнее заказанной** (ADR 0059): заявку на 25 т закрыли краном на 50 т. Так
 * проверяется, что копия повторяет заказ, а не то, чем его закрыли.
 */
const IN_WORK = vehicleRequest({
  id: 'vr-9',
  displayNumber: 'Т-44',
  status: 'confirmed',
  dateFrom: '2026-09-18',
  dateTo: '2026-09-30',
  assignment: ownAssignment({
    vehicleId: 'v-2',
    vehicleCategoryId: 'vc-3',
    categoryName: 'г/п 50 т',
    categorySpecs: { lift_capacity: 50 },
    registrationNumber: 'К777КК77',
  }),
  route: requestRoute({ routeDate: '2026-09-18' }),
});

/** Заказ, последний день которого — сегодня: остаток от него вырождается в один день. */
const ENDS_TODAY = vehicleRequest({
  id: 'vr-10',
  displayNumber: 'Т-50',
  status: 'confirmed',
  dateFrom: '2026-09-15',
  dateTo: '2026-09-22',
  assignment: ownAssignment(),
});

/** Заказ целиком впереди: его и повторяют теми же днями. */
const AHEAD = vehicleRequest({
  id: 'vr-11',
  displayNumber: 'Т-51',
  dateFrom: '2026-10-05',
  dateTo: '2026-10-09',
});

/**
 * Выполненная заявка. Факта у неё нет намеренно: заказ закрыли до появления колонки, и такие в
 * базе есть — для копии это ничего не меняет, повторяют не факт, а заказ.
 */
const DONE = vehicleRequest({
  id: 'vr-12',
  displayNumber: 'Т-47',
  status: 'done',
  dateFrom: '2026-08-20',
  dateTo: '2026-08-22',
  assignment: ownAssignment(),
});

/** Отменённая: копия её не возобновляет, а заводит новый заказ со своим номером. */
const CANCELLED = vehicleRequest({
  id: 'vr-13',
  displayNumber: 'Т-48',
  status: 'cancelled',
  cancelReason: 'техника не понадобилась',
  dateFrom: '2026-08-20',
  dateTo: '2026-08-22',
});

/** Архивная (ADR 0070): единственный статус записи, с которого копию не снимают. */
const ARCHIVED = vehicleRequest({
  id: 'vr-14',
  displayNumber: 'Т-49',
  deletedAt: '2026-09-01T06:00:00.000Z',
  deletedByName: 'Диспетчеров Д. П.',
});

/** Проверенный адрес (ADR 0006): у заведения он обязателен, и копия ездки несёт его метаданные. */
const RESOLVED = {
  source: 'resolved' as const,
  fiasId: 'f-1',
  fiasLevel: 8,
  geoLat: 55.7,
  geoLon: 37.6,
};

/** Грузоперевозка с ездкой: у копии её адреса и контакты те же, а `id` — уже нет. */
const FREIGHT = freightRequest({
  trips: [
    freightTrip({
      id: 'vrt-1',
      scheduledAt: '2026-08-06T06:30:00.000Z',
      fromAddress: RESOLVED,
      toAddress: { ...RESOLVED, fiasId: 'f-2' },
    }),
  ],
});

/** Грузоперевозка в работе: машина назначена, заявка стоит в рейсе, у ездок свои номера. */
const FREIGHT_IN_WORK = freightRequest({
  id: 'vr-15',
  displayNumber: 'Т-46',
  status: 'confirmed',
  assignment: ownAssignment({
    vehicleId: 'v-3',
    vehicleKindId: 'vk-truck',
    vehicleTypeId: 'vt-2',
    typeName: 'Самосвалы',
    vehicleCategoryId: 'vc-2',
    categoryName: '20 м³',
    categorySpecs: { body_volume: 20 },
    registrationNumber: 'М555ММ77',
  }),
  route: requestRoute(),
  trips: [
    freightTrip({
      id: 'vrt-9',
      displayNumber: 'Т-46/1',
      fromAddress: RESOLVED,
      toAddress: { ...RESOLVED, fiasId: 'f-2' },
    }),
  ],
});

/** Та же заявка, но адреса ездки не верифицированы — как у строк, доехавших бэкфилом (Р2а). */
const FREIGHT_RAW = freightRequest({
  id: 'vr-3',
  displayNumber: 'Т-45',
  trips: [freightTrip({ id: 'vrt-2' })],
});

/**
 * Заказ, который ещё не начался, но начинается слишком скоро для заявителя: начало завтра, а
 * первый доступный ему день — послезавтра (ADR 0104). Ровно на нём ветка «остаток» и разошлась бы
 * со сдвигом, спроси её код у `minDate` вместо сегодняшнего дня.
 */
const NOT_STARTED = vehicleRequest({
  id: 'vr-16',
  displayNumber: 'Т-52',
  dateFrom: '2026-09-23',
  dateTo: '2026-09-29',
});

/** Идущий заказ, который кончится завтра: заявителю остатка от него уже не достанется. */
const ENDS_TOO_SOON = vehicleRequest({
  id: 'vr-18',
  displayNumber: 'Т-54',
  status: 'confirmed',
  dateFrom: '2026-09-20',
  dateTo: '2026-09-23',
  assignment: ownAssignment(),
});

/** Заказ, начатый сегодня: техника на объекте с утра, и идёт он наравне со вчерашними. */
const STARTS_TODAY = vehicleRequest({
  id: 'vr-17',
  displayNumber: 'Т-53',
  status: 'confirmed',
  dateFrom: '2026-09-22',
  dateTo: '2026-09-30',
  assignment: ownAssignment(),
});

/**
 * Карточка спрашивает своё при открытии — сценарию важна не она, а кнопка в её футере.
 *
 * Контакт водителя (ADR 0122) карточка спрашивает у всякой заявки с назначением, то есть у любой
 * работающей и закрытой: без этого маршрута `mockHttp` роняет весь сценарий на незамоканном
 * запросе, а не на том, что проверяется.
 */
const CARD_ROUTES: RouteMap = {
  'GET /vehicle-requests/:id/history': () => json([]),
  'GET /vehicle-requests/:id/waybills': () => json([]),
  'GET /vehicle-requests/:id/relocations': () => json([]),
  'GET /vehicle-requests/:id/driver': () =>
    json({
      personId: 'p-machinist',
      fullName: 'Семёнов Семён Семёнович',
      phone: '+7 900 000-00-05',
      cardRemovedOn: null,
    }),
};

const CREATE = 'POST /vehicle-requests';

function renderTab(
  items: VehicleRequestDto[] = [SPECIAL],
  user = authUser(),
  over: RouteMap = {},
): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed(items)),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: items.length })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    // Классификатор отдаёт ровно ту позицию, что заказана: копия подставляет тип и категорию
    // только живой строкой справочника — выключенную сервер всё равно не примет. Позиция
    // назначенной машины (50 т) лежит в нём рядом и **живая**: не будь её, «копия взяла заказанную»
    // проверялось бы пустым полем, то есть ничем.
    'GET /vehicle-classifications': () =>
      json(
        list([
          classification({ vehicleTypeId: 'vt-1', vehicleCategoryId: 'vc-1' }),
          classification({
            vehicleTypeId: 'vt-1',
            vehicleCategoryId: 'vc-3',
            categoryName: 'г/п 50 т',
          }),
          classification({
            vehicleTypeId: 'vt-2',
            typeName: 'Самосвалы',
            vehicleCategoryId: 'vc-2',
            categoryName: '20 м³',
            kindCode: 'freight',
          }),
        ]),
      ),
    'GET /vehicles': () => json(emptyList()),
    [CREATE]: () => json(vehicleRequest({ id: 'vr-new', num: 77, displayNumber: 'Т-77' })),
    ...CARD_ROUTES,
    ...over,
  });
  renderWithUser(<VehicleRequestsTab />, { user });
  return http;
}

/** Открыть карточку заявки так, как её открывает человек: нажатием на строку списка. */
async function openCard(displayNumber: string) {
  fireEvent.click(await screen.findByText(displayNumber));
  await waitFor(() =>
    expect(
      [...document.querySelectorAll('.ant-modal')].some((el) =>
        el.textContent?.includes(`Заявка ${displayNumber}`),
      ),
    ).toBe(true),
  );
}

/** Кнопка по видимой подписи — их в окне несколько, и целимся именно в текст. */
function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((el) => el.textContent === label);
}

/**
 * Открыть карточку и нажать в ней «Завести такую же», дождавшись формы копии.
 *
 * Ждут именно заголовка с НОМЕРОМ источника: он же и подтверждает, что открылась форма копии, а не
 * пустое заведение — по одному «по образцу» сценарий прошёл бы и на чужой заявке.
 */
async function openCopy(displayNumber: string) {
  await openCard(displayNumber);
  fireEvent.click(button('Завести такую же')!);
  await waitFor(() =>
    expect(screen.getByText(new RegExp(`по образцу ${displayNumber}`))).toBeDefined(),
  );
}

/** Значение текстового поля формы по его подписи: то, что человек в поле видит. */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

/**
 * Выбранное в списке — подписью, а не значением поля: у antd выбор лежит не в `input` (тот пуст и
 * у заполненного списка), а в `.ant-select-content`.
 */
function selectedValue(label: string): string {
  const item = [...document.querySelectorAll('.ant-modal .ant-form-item')]
    .find((el) => el.querySelector('label')?.textContent === label)
    ?.querySelector('.ant-select-content');
  return item?.textContent ?? '';
}

/**
 * Запросы, адресованные **конкретной** заявке и что-то в ней меняющие. Копия не шлёт ни одного: ни
 * правки, ни смены статуса, ни назначения — иначе повтор заказа менял бы ход исходной работы.
 */
function writesToRequests(http: HttpMock): RecordedCall[] {
  return http.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/vehicle-requests/'));
}

describe('копия заявки на технику', () => {
  it('копируется и «Новая», и работающая — архивная нет', async () => {
    renderTab([SPECIAL, IN_WORK, ARCHIVED]);

    // «Новая» — тот случай, ради которого действие и заводили.
    await openCard('Т-42');
    expect(button('Завести такую же')).toBeTruthy();
    fireEvent.click(button('Закрыть')!);

    // Работающая: срок идёт, машина назначена, заявка в рейсе — и всё равно копируется (ADR 0206).
    // Повторяют не состояние записи, а сам заказ, и та же техника нужна на соседнюю площадку.
    await openCard('Т-44');
    expect(button('Завести такую же')).toBeTruthy();
    fireEvent.click(button('Закрыть')!);

    await openCard('Т-49');
    // Архив — единственная живая граница действия: заявка снята, и повторять «как было» незачем;
    // её сначала восстанавливают.
    await waitFor(() => expect(button('Завести такую же')).toBeUndefined());
  });

  it('кнопки нет у того, кто заявок не заводит', async () => {
    // Наблюдатель заявку читает, но не заводит: копия — это заведение, и предлагать её значило бы
    // вести человека к отказу сервера.
    renderTab([SPECIAL], authUser({ role: 'observer' }));

    await openCard('Т-42');
    expect(button('Завести такую же')).toBeUndefined();
  });

  it('переносит состав заказа и сдвигает прошедший срок, сохраняя длительность', async () => {
    renderTab();
    await openCopy('Т-42');

    // Заголовок называет источник и род действия: «по образцу», а не «копия» (ADR 0206) — у
    // выполненной заявки «копия» обещала бы наследование её состояния, которого в новой не будет.
    expect(screen.getByText('Новая заявка на автотехнику — по образцу Т-42')).toBeDefined();
    // Вложения — единственное, чего копия не унесла, и сказано об этом до сохранения.
    expect(screen.getByText(/Вложения не переносятся/)).toBeDefined();

    expect(selectedValue('Объект/отдел')).toContain('ЖК Северный');
    expect(selectedValue('Тип/категория ТС')).toContain('г/п 25 т');
    expect(fieldValue('Ответственный на объекте')).toBe('Петров П. П.');
    expect(fieldValue('Комментарий (планируемые задачи)')).toBe('разгрузка плит');
    // Срок 05.08–07.08 давно прошёл: начало встаёт на первый доступный день, а конец уезжает на
    // столько же — три дня заказа остаются тремя днями.
    expect(fieldValue('Дата начала')).toBe('22.09.2026');
    expect(fieldValue('Дата окончания')).toBe('24.09.2026');
    // Причина сдвига названа та, что есть: срок кончился месяц назад. Вторая причина —
    // заблаговременность — тут ни при чём: у того, кто ведёт заказы, сегодняшний день открыт
    // (ADR 0104), и назови её надпись, человек искал бы запрет, которого на него не наложено.
    expect(screen.getByText(/прежний срок прошёл/)).toBeDefined();
    expect(screen.queryByText(/технику заказывают заранее/)).toBeNull();
  });

  it('сохранение уходит заведением, а не правкой исходной заявки', async () => {
    const http = renderTab();
    await openCopy('Т-42');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({
      requestType: 'special_equipment',
      objectId: 'obj-1',
      vehicleTypeId: 'vt-1',
      vehicleCategoryId: 'vc-1',
      responsibleName: 'Петров П. П.',
      comment: 'разгрузка плит',
      dateFrom: '2026-09-22',
      dateTo: '2026-09-24',
    });
    // Исходная заявка не тронута ни одним запросом: копия — это заведение.
    expect(writesToRequests(http)).toHaveLength(0);
  });

  it('копия работающей заявки уходит заведением и не трогает оригинал', async () => {
    const http = renderTab([IN_WORK]);
    await openCopy('Т-44');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    /*
     * Ни правки, ни смены статуса, ни назначения — ни одного запроса к `vr-9`. Ошибись портал
     * здесь, и «копия» сдвинула бы срок машине, которая сейчас работает на площадке, а заметили бы
     * это по не приехавшей утром технике.
     */
    expect(writesToRequests(http)).toHaveLength(0);
    // Статус источника в тело не едет вовсе: заведение заводит «Новую», а не вторую работающую.
    expect(http.lastCall(CREATE)?.body).not.toHaveProperty('status');
  });

  it('идущему сроку предлагает остаток: начало сегодня, конец прежний', async () => {
    const http = renderTab([IN_WORK]);
    await openCopy('Т-44');

    // Заказ 18.09–30.09 уже идёт. Сдвинуть его целиком значило бы заказать технику до 12.10 —
    // больше, чем просят: просят дотянуть до того же дня другой машиной.
    expect(fieldValue('Дата начала')).toBe('22.09.2026');
    expect(fieldValue('Дата окончания')).toBe('30.09.2026');

    fireEvent.click(button('Сохранить')!);
    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({
      dateFrom: '2026-09-22',
      dateTo: '2026-09-30',
    });
  });

  it('остаток в один день остаётся одним днём', async () => {
    renderTab([ENDS_TODAY]);
    await openCopy('Т-50');

    // Вырожденный случай той же ветки: заказ 15.09–22.09 кончается сегодня, и остатка от него —
    // ровно сегодняшний день. Конец при этом не уезжает вперёд «чтобы был хоть какой-то срок».
    expect(fieldValue('Дата начала')).toBe('22.09.2026');
    expect(fieldValue('Дата окончания')).toBe('22.09.2026');
  });

  it('срок целиком впереди не двигается', async () => {
    const http = renderTab([AHEAD]);
    await openCopy('Т-51');

    // Двигать нечего: 05.10–09.10 заведение примет как есть, и подмена дат тут означала бы, что
    // портал переписал заказ, который человек повторяет дословно.
    expect(fieldValue('Дата начала')).toBe('05.10.2026');
    expect(fieldValue('Дата окончания')).toBe('09.10.2026');

    fireEvent.click(button('Сохранить')!);
    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({
      dateFrom: '2026-10-05',
      dateTo: '2026-10-09',
    });
  });

  /**
   * Тот самый случай, ради которого ветку выбирает сегодняшний день, а не первый доступный: у
   * заявителя после 15:00 они расходятся на сутки (ADR 0104), и заказ, который ещё НЕ НАЧАЛСЯ,
   * обязан уехать сдвигом целиком — с сохранением длительности, — а не превратиться в «остаток»,
   * потеряв первый день работы.
   */
  it('ещё не начавшийся заказ уходит сдвигом даже под заблаговременностью заявителя', async () => {
    // 16:00 МСК: отсечка пройдена, и ближайший доступный штабу день — послезавтра (24.09).
    vi.setSystemTime(new Date('2026-09-22T13:00:00.000Z'));
    renderTab([NOT_STARTED], shtabUser('obj-1'));
    await openCopy('Т-52');

    // Семь дней заказа (23.09–29.09) остаются семью днями, начинаясь с первого доступного.
    expect(fieldValue('Дата начала')).toBe('24.09.2026');
    expect(fieldValue('Дата окончания')).toBe('30.09.2026');

    // И причину сдвига надпись называет ту, что есть: срок не прошёл — он ещё не начался, а
    // двигает его заблаговременность. Сказанное «прежний срок прошёл» на заказе, который
    // начинается завтра, читается как ошибка портала — и человек лезет править верные даты.
    expect(screen.getByText(/технику заказывают заранее/)).toBeDefined();
    expect(screen.queryByText(/прежний срок прошёл/)).toBeNull();
  });

  /**
   * Заказ, начатый сегодня, — тоже идущий, и копии от него достаётся остаток.
   *
   * Граница тут не «раньше сегодня», а «не позже»: у заявителя первый доступный день впереди
   * сегодняшнего, и сдвиг с сохранением длительности унёс бы конец копии за конец оригинала —
   * заказали бы больше, чем просили, ровно в том случае, ради которого остаток и заводили.
   */
  it('заказ, начатый сегодня, копируется остатком, а не сдвигом', async () => {
    // 16:00 МСК: штабу доступно послезавтра (24.09), и копия обязана кончиться 30.09, как оригинал.
    vi.setSystemTime(new Date('2026-09-22T13:00:00.000Z'));
    renderTab([STARTS_TODAY], shtabUser('obj-1'));
    await openCopy('Т-53');

    expect(fieldValue('Дата начала')).toBe('24.09.2026');
    expect(fieldValue('Дата окончания')).toBe('30.09.2026');
  });

  /**
   * Остаток обязан помещаться в окно, открытое форме: у идущего заказа, который кончится раньше
   * первого доступного дня, остатка не существует вовсе. Тогда копия повторяет прежнюю
   * длительность — другого верного ответа у неё нет, и «остаток» из пустого окна был бы концом
   * раньше начала, которого форма не примет.
   */
  it('идущий заказ, кончающийся раньше доступного дня, уходит сдвигом', async () => {
    // 16:00 МСК: штабу доступно послезавтра (24.09), а работа по Т-54 кончается 23.09.
    vi.setSystemTime(new Date('2026-09-22T13:00:00.000Z'));
    renderTab([ENDS_TOO_SOON], shtabUser('obj-1'));
    await openCopy('Т-54');

    // Четыре дня заказа (20.09–23.09) остаются четырьмя, начинаясь с первого доступного.
    expect(fieldValue('Дата начала')).toBe('24.09.2026');
    expect(fieldValue('Дата окончания')).toBe('27.09.2026');
  });

  /**
   * Третье условие остатка: двигать должно быть ЧТО. У того, кто ведёт заказы, первый доступный
   * день сегодняшний, и у заказа, начатого сегодня, остатку взяться неоткуда — срок предлагается
   * целиком, тем же, каким и был.
   *
   * Поля обеих веток здесь совпадают до дня (22.09–30.09), и ошибку видно ТОЛЬКО по надписи:
   * назови портал нетронутый срок «остатком» — человек прочёл бы, что копии досталась часть
   * заказа, и полез бы возвращать дни, которых никто не терял.
   */
  it('заказ, начатый сегодня, доступный сегодня же, предлагается прежним сроком', async () => {
    renderTab([STARTS_TODAY]);
    await openCopy('Т-53');

    expect(fieldValue('Дата начала')).toBe('22.09.2026');
    expect(fieldValue('Дата окончания')).toBe('30.09.2026');
    expect(screen.getByText(/срок предложен прежний/)).toBeDefined();
    expect(screen.queryByText(/предложен остаток/)).toBeNull();
  });

  /**
   * Календарь копии замораживается в тот миг, когда открыли форму (`CopySource`), и дальше живёт
   * вместе с ней.
   *
   * Поля заполняются один раз, а надпись рисуется на каждом рендере, и первый доступный день
   * считается в рендере заново (`vehicleRequestDateRules`). Спроси его надпись сама — форма,
   * пережившая 15:00 или полночь, объясняла бы человеку не тот срок, что стоит у неё же в полях.
   * Ошибка при этом тихая: даты в полях верные, а текст под ними — от другой ветки правила, и
   * верят тут тексту.
   *
   * Перерисовку вызывает правка ДАТЫ ОКОНЧАНИЯ, а вместе с ней приходит и свидетель этой
   * перерисовки — подсказка длины периода: её печатает сама вкладка (`periodHint`), тем же
   * рендером, что рисует надпись. Без такого свидетеля сценарий был бы пустым: надпись «не
   * изменилась» бы просто потому, что её никто не пересчитывал — вкладка следит за считанными
   * полями (`Form.useWatch`), и «Комментарий» в их число не входит вовсе.
   *
   * Двигается при этом конец, а начало остаётся в покое: замораживается-то первый доступный день,
   * и о нём же говорит проверяемая строка.
   */
  it('календарь копии заморожен на момент открытия формы', async () => {
    // Полдень: отсечка не пройдена, штабу доступно завтра (23.09) — с него и идёт остаток.
    renderTab([STARTS_TODAY], shtabUser('obj-1'));
    await openCopy('Т-53');
    expect(fieldValue('Дата начала')).toBe('23.09.2026');
    expect(screen.getByText(/предложен остаток: 23\.09\.2026/)).toBeDefined();

    // 15:00 прошли, пока форма открыта: незамороженный первый доступный день стал бы 24.09 — и
    // надпись назвала бы началом день, которого в поле нет.
    vi.setSystemTime(new Date('2026-09-22T13:00:00.000Z'));
    typeDate('Дата окончания', '02.10.2026');

    expect(await screen.findByText('10 календарных дней')).toBeDefined();
    expect(fieldValue('Дата начала')).toBe('23.09.2026');
    expect(screen.getByText(/предложен остаток: 23\.09\.2026/)).toBeDefined();

    // И через московскую полночь: заморожен не только первый доступный день, но и сам «сегодня»,
    // которым ветвится правило, — иначе назавтра та же форма поехала бы уже с 24.09.
    vi.setSystemTime(new Date('2026-09-23T09:00:00.000Z'));
    typeDate('Дата окончания', '03.10.2026');

    expect(await screen.findByText('11 календарных дней')).toBeDefined();
    expect(fieldValue('Дата начала')).toBe('23.09.2026');
    expect(screen.getByText(/предложен остаток: 23\.09\.2026/)).toBeDefined();
  });

  it('копия выполненной заявки уходит заведением', async () => {
    const http = renderTab([DONE]);
    await openCopy('Т-47');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    // Закрытая заявка ушла в выгрузку бухгалтерии, и правка её была бы правкой предъявленного
    // счёта (ADR 0101 п. 3). Копия туда не ходит вовсе.
    expect(writesToRequests(http)).toHaveLength(0);
    expect(http.lastCall(CREATE)?.body).toMatchObject({ dateFrom: '2026-09-22' });
  });

  it('копия отменённой заявки уходит заведением', async () => {
    const http = renderTab([CANCELLED]);
    await openCopy('Т-48');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    // Отказ по старой заявке остаётся отказом: копия не возобновляет её, а заводит новый заказ.
    expect(writesToRequests(http)).toHaveLength(0);
  });

  it('берёт заказанную позицию классификатора, а не назначенную машину', async () => {
    const http = renderTab([IN_WORK]);
    await openCopy('Т-44');

    // Заказывали 25 т, закрыли краном на 50 т (ADR 0059). Повторяют заказ: назначенное — решение
    // диспетчерской о ЭТОЙ заявке, а не часть просьбы площадки, и подставь копия его — человек
    // заказал бы технику крупнее, сам того не выбрав.
    expect(selectedValue('Тип/категория ТС')).toContain('г/п 25 т');
    expect(selectedValue('Тип/категория ТС')).not.toContain('50');

    fireEvent.click(button('Сохранить')!);
    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({ vehicleCategoryId: 'vc-1' });
  });

  it('у грузоперевозки переносит ездки — без чужих идентификаторов', async () => {
    const http = renderTab([FREIGHT]);
    await openCopy('Т-43');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    const body = http.lastCall(CREATE)?.body as {
      scheduledAt: string;
      trips: Record<string, unknown>[];
    };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]).toMatchObject({
      fromLocation: 'г. Москва, ул. Складская, 4',
      toLocation: 'г. Москва, ул. Северная, 1',
      toResponsibleName: 'Кузнецов К. К.',
      volumeM3: 12,
    });
    // Строгая схема заведения `id` не примет, и переносить его незачем: номера ездкам назначит
    // сервер.
    expect(body.trips[0]!.id).toBeUndefined();
    // День подачи уехал вперёд, а час остался прежним — вместе с ним и час самой ездки.
    expect(body.scheduledAt.slice(0, 10)).toBe('2026-09-22');
  });

  it('копия работающей грузоперевозки не тащит рейс и чужие номера ездок', async () => {
    const http = renderTab([FREIGHT_IN_WORK]);
    await openCopy('Т-46');

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    const body = http.lastCall(CREATE)?.body as Record<string, unknown> & {
      trips: Record<string, unknown>[];
    };
    // Рейс принадлежит ходу работы, а не заказу: новая заявка в чужой рейс не встаёт — её поставят
    // туда, куда решит диспетчерская. Того же и машина: назначения у «Новой» не бывает.
    expect(body).not.toHaveProperty('routeId');
    expect(body).not.toHaveProperty('route');
    expect(body).not.toHaveProperty('vehicleId');
    expect(body.trips[0]!.id).toBeUndefined();
    expect(writesToRequests(http)).toHaveLength(0);
  });

  /**
   * Граница, а не поломка: заведение принимает только проверенный адрес (ADR 0006), а правка
   * старой ездки — любой (Р2а). Копия заявки с адресом, доехавшим бэкфилом, поэтому и требует
   * выбрать его заново — и делает это ДО отправки, полем формы, а не отказом сервера.
   */
  it('копия ездки с непроверенным адресом просит выбрать его заново', async () => {
    const http = renderTab([FREIGHT_RAW]);
    await openCopy('Т-45');

    fireEvent.click(button('Сохранить')!);

    expect(
      await screen.findAllByText('Адрес нужно выбрать из подсказок DaData либо из справочника'),
    ).toHaveLength(2);
    expect(http.countOf(CREATE)).toBe(0);
  });

  it('окно говорит, что исходная заявка не меняется', async () => {
    renderTab([IN_WORK]);
    await openCopy('Т-44');

    /*
     * Главный страх человека, снимающего копию с работающей заявки, — «сейчас я испорчу то, что
     * уже едет». Отвечают на него до сохранения и словами, а не молчанием формы.
     *
     * Проверяется ключевой оборот, а не абзац целиком: тексты правятся, и тест, переписанный под
     * каждую редакцию, перестал бы стеречь смысл.
     */
    expect(screen.getByText(/Заявка Т-44 не меняется/)).toBeDefined();
    // Перечень собран из того, что у заявки есть: машина назначена и рейс собран, а факта ещё
    // нет — названный, он обещал бы сбережение того, чего не существует.
    expect(screen.getByText(/Техника и рейс остаются у Т-44/)).toBeDefined();
    expect(screen.queryByText(/и факт остаются/)).toBeNull();
    // Надпись объясняет и подставленный срок: без объяснения не те даты в полях читаются как сбой
    // формы, и человек правит их обратно в прошлое — туда, где заведение их не примет.
    expect(screen.getByText(/предложен остаток/)).toBeDefined();
    // И называет дверь, за которой стоит настоящее «нужна та же машина дольше»: копией это делают
    // по ошибке — вторая заявка встанет рядом с первой и упрётся в занятость той же машины.
    expect(screen.getByText(/Нужна та же машина дольше/)).toBeDefined();
  });

  it('у выполненной надпись называет её статус и единственное наследство', async () => {
    renderTab([DONE]);
    await openCopy('Т-47');

    // Статус источника повторён словами там же, где возникает страх его испортить: «завести такую
    // же» с карточки закрытой заявки человек нажимает, косясь на предъявленный по ней счёт.
    expect(screen.getByText(/Заявка Т-47 не меняется — она остаётся выполненной/)).toBeDefined();
    /*
     * Наследство у неё одно — машина, и согласование числа тут не косметика: перечень читают как
     * список того, что у источника сохранится, и «техника и рейс остаются» назвало бы рейс,
     * которого у заказа нет. Строку про вложения под ней после такого читают с тем же доверием.
     */
    expect(screen.getByText(/Техника остаётся у Т-47/)).toBeDefined();
    expect(screen.queryByText(/остаются у Т-47/)).toBeNull();
    // Двери продления у закрытого заказа нет: продлевать нечего, а совет «поправьте дату
    // окончания» повёл бы человека в заявку, которую правкой уже не открыть.
    expect(screen.queryByText(/Нужна та же машина дольше/)).toBeNull();
  });

  it('у отменённой сказано, что копия её не возобновляет', async () => {
    renderTab([CANCELLED]);
    await openCopy('Т-48');

    // «Завести такую же» звучит как «вернуть», и разница названа прямо: отказ по Т-48 остаётся
    // отказом, а рядом заводится новая заявка со своим номером.
    expect(
      screen.getByText(/Заявка Т-48 не меняется — копия не возобновляет отменённую/),
    ).toBeDefined();
    // Наследовать ей нечего: машины не назначали, рейса не было, факта не будет — перечня в
    // надписи нет вовсе, и остаётся одна строка про вложения.
    expect(screen.getByText(/^Вложения не переносятся/)).toBeDefined();
    expect(screen.queryByText(/остаётся у Т-48|остаются у Т-48/)).toBeNull();
  });

  it('у грузоперевозки в работе наследство названо, а двери продления нет', async () => {
    renderTab([FREIGHT_IN_WORK]);
    await openCopy('Т-46');

    expect(screen.getByText(/Заявка Т-46 не меняется — она остаётся в работе/)).toBeDefined();
    expect(screen.getByText(/Техника и рейс остаются у Т-46/)).toBeDefined();
    // Продлевают срок, а у грузоперевозки его нет — у неё момент подачи: совет «поправьте дату
    // окончания» отправил бы человека править поле, которого в такой заявке не существует.
    expect(screen.queryByText(/Нужна та же машина дольше/)).toBeNull();
  });
});
