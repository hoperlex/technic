import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKDATE_UNDECLARED_MESSAGE,
  createWasteRequestSchema,
  createVehicleRequestSchema,
  movedRequestDateKey,
  movedRequestStartKey,
  isAllowedRequestDate,
  isAllowedRequestDateAt,
  isVehicleRequestRequester,
  isWithinWorkTime,
  isWithinWorkTimeAt,
  minRequestDateKey,
  minVehicleRequestDateKey,
  VEHICLE_REQUEST_LEAD_TIME_MESSAGE,
  vehicleRequestLeadTimeBlocker,
  minutesToTime,
  moscowDateKeyOf,
  moscowTimeOf,
  normalizeTimeInput,
  timeToMinutes,
  updateVehicleRequestSchema,
  updateWasteRequestSchema,
} from '@technic/contracts';

// Создание заявки сверяет дату с текущим днём, а даты в фикстурах календарные — «сейчас»
// фиксируем на 27.07.2026 12:00 МСК: 27-е тогда сегодняшний день, 26-е — прошлое. Тесты самой
// границы переводят часы дальше (`at`), возврат к реальному времени делает общий afterEach.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('нормализация ручного ввода времени', () => {
  it('добивает нулями незаполненные знаки', () => {
    expect(normalizeTimeInput('7')).toBe('07:00');
    expect(normalizeTimeInput('07')).toBe('07:00');
    expect(normalizeTimeInput('21')).toBe('21:00');
    expect(normalizeTimeInput('730')).toBe('07:30');
    expect(normalizeTimeInput('0730')).toBe('07:30');
    expect(normalizeTimeInput('1945')).toBe('19:45');
  });

  it('уважает явный разделитель: «7:5» — это 07:05, а не 07:50', () => {
    expect(normalizeTimeInput('7:5')).toBe('07:05');
    expect(normalizeTimeInput('7:30')).toBe('07:30');
    expect(normalizeTimeInput('19:45')).toBe('19:45');
  });

  it('игнорирует посторонние символы и пробелы', () => {
    expect(normalizeTimeInput('  8  ')).toBe('08:00');
    expect(normalizeTimeInput('8.30')).toBe('08:30');
  });

  it('пустой ввод и несуществующее время не распознаются', () => {
    expect(normalizeTimeInput('')).toBeUndefined();
    expect(normalizeTimeInput('   ')).toBeUndefined();
    expect(normalizeTimeInput('25')).toBeUndefined();
    expect(normalizeTimeInput('0790')).toBeUndefined();
    expect(normalizeTimeInput('12345')).toBeUndefined();
  });

  it('полночь — валидное время суток (её несёт заявка без указанного времени)', () => {
    expect(normalizeTimeInput('0')).toBe('00:00');
    expect(normalizeTimeInput('00:00')).toBe('00:00');
  });
});

describe('минуты ↔ время', () => {
  it('преобразует в обе стороны', () => {
    expect(timeToMinutes('07:30')).toBe(450);
    expect(minutesToTime(450)).toBe('07:30');
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('не разбирает ненормализованный ввод', () => {
    expect(timeToMinutes('7:30')).toBeUndefined();
    expect(timeToMinutes('24:00')).toBeUndefined();
  });
});

describe('рабочее окно 07:00–21:00', () => {
  it('включает границы', () => {
    expect(isWithinWorkTime('07:00')).toBe(true);
    expect(isWithinWorkTime('21:00')).toBe(true);
  });

  it('отсекает время вне окна', () => {
    expect(isWithinWorkTime('06:59')).toBe(false);
    expect(isWithinWorkTime('21:01')).toBe(false);
    expect(isWithinWorkTime('00:00')).toBe(false);
  });

  it('момент времени оценивается по МСК, а не по UTC', () => {
    // 05:00 UTC = 08:00 МСК — внутри окна, хотя по UTC это раннее утро.
    expect(moscowTimeOf(new Date('2026-07-28T05:00:00.000Z'))).toBe('08:00');
    expect(isWithinWorkTimeAt(new Date('2026-07-28T05:00:00.000Z'))).toBe(true);
    // 21:00 МСК = 18:00 UTC — граница включена.
    expect(isWithinWorkTimeAt(new Date('2026-07-28T18:00:00.000Z'))).toBe(true);
    // 22:00 МСК — уже вне окна.
    expect(isWithinWorkTimeAt(new Date('2026-07-28T19:00:00.000Z'))).toBe(false);
  });
});

/**
 * Нижняя граница даты — без права на коррекцию (ADR 0101). Это первый из трёх режимов
 * `minRequestDateKey` и то самое правило, которым портал жил до ADR 0101: заявку заводят на
 * сегодня или позже. Прошлое открывается правом и проверяется `backdateGuard` — режимы с правом
 * проверяются ниже, своим блоком.
 */
describe('минимальная дата новой заявки — сегодня по МСК', () => {
  /** Переводит «сейчас» на указанный момент UTC (таймеры уже фиктивные — см. хуки файла). */
  const at = (utc: string) => vi.setSystemTime(new Date(utc));

  it('минимальная дата — текущий календарный день по МСК', () => {
    at('2026-07-28T09:00:00.000Z'); // 12:00 МСК 28-го
    expect(minRequestDateKey()).toBe('2026-07-28');
  });

  it('после 21:00 UTC в Москве уже следующие сутки — граница сдвигается вместе с ними', () => {
    // 23:30 МСК 28-го: по UTC ещё 28-е, и московское «сегодня» — тоже 28-е.
    at('2026-07-28T20:30:00.000Z');
    expect(moscowDateKeyOf(new Date())).toBe('2026-07-28');
    expect(minRequestDateKey()).toBe('2026-07-28');
    // 00:30 МСК 29-го (21:30 UTC 28-го) — сутки в Москве уже сменились, граница ушла на 29-е.
    at('2026-07-28T21:30:00.000Z');
    expect(moscowDateKeyOf(new Date())).toBe('2026-07-29');
    expect(minRequestDateKey()).toBe('2026-07-29');
  });

  it('прошлое не проходит, сегодня и позже — проходят', () => {
    at('2026-07-28T09:00:00.000Z');
    // Без права прошлое закрыто целиком — сколько бы дней назад оно ни было. Тридцать дней
    // (`WAYBILL_CORRECTION_DAYS`) это граница **внутри** права, а не поблажка всем.
    expect(isAllowedRequestDate('2026-07-26')).toBe(false);
    expect(isAllowedRequestDate('2026-07-27')).toBe(false);
    expect(isAllowedRequestDate('2026-07-28')).toBe(true);
    expect(isAllowedRequestDate('2026-08-15')).toBe(true);
  });

  it('момент времени оценивается по календарю МСК, а не по UTC', () => {
    at('2026-07-28T09:00:00.000Z');
    // 20:30 UTC 27-го = 23:30 МСК того же дня — вчера по Москве, значит уже поздно.
    expect(isAllowedRequestDateAt(new Date('2026-07-27T20:30:00.000Z'))).toBe(false);
    // 21:30 UTC 27-го = 00:30 МСК 28-го — это уже сегодня по Москве, значит допустимо.
    expect(isAllowedRequestDateAt(new Date('2026-07-27T21:30:00.000Z'))).toBe(true);
  });
});

/**
 * Три режима дейтпикера (ADR 0101, Р37). Правило у формы и у сервера одно: портал не предлагает
 * того, что сервер отклонит, и не запрещает того, что примет, — поэтому границ ровно столько же,
 * сколько исходов у `backdateGuard`, и `null` означает «границы нет», а не «очень давно».
 */
describe('минимальная дата под правом на коррекцию', () => {
  const at = (utc: string) => vi.setSystemTime(new Date(utc));

  it('без права — сегодня, с правом — тридцать дней назад, с правом глубины — границы нет', () => {
    at('2026-08-12T09:00:00.000Z');
    expect(minRequestDateKey()).toBe('2026-08-12');
    expect(minRequestDateKey(undefined, { correct: false, beyondLimit: false })).toBe('2026-08-12');
    expect(minRequestDateKey(undefined, { correct: true, beyondLimit: false })).toBe('2026-07-13');
    expect(minRequestDateKey(undefined, { correct: true, beyondLimit: true })).toBeNull();
  });

  /**
   * Второе право без первого не значит ничего — тем же порядком, каким `backdateGuard` сначала
   * спрашивает право и только потом глубину. Иначе дейтпикер открыл бы прошлое тому, кому сервер
   * ответит 403.
   */
  it('право глубины в одиночку прошлого не открывает', () => {
    at('2026-08-12T09:00:00.000Z');
    expect(minRequestDateKey(undefined, { correct: false, beyondLimit: true })).toBe('2026-08-12');
  });

  it('граница считается по МСК, как и всё прочее в заявках', () => {
    // 00:30 МСК 13-го (21:30 UTC 12-го): московские сутки сменились, съехала и нижняя граница.
    at('2026-08-12T21:30:00.000Z');
    expect(minRequestDateKey(undefined, { correct: true, beyondLimit: false })).toBe('2026-07-14');
  });
});

/**
 * Заблаговременность заявки на технику (ADR 0104). Правило висит на субъекте, а не на теле
 * запроса: одну и ту же дату у заявителя портал не примет, а у диспетчера примет — поэтому и
 * граница считается от субъекта, и проверяется она здесь обоими.
 */
describe('ближайший доступный день заявки на технику', () => {
  const at = (utc: string) => vi.setSystemTime(new Date(utc));
  const shtab = { role: 'shtab' } as const;
  const rukstroy = { role: 'rukstroy' } as const;
  const department = { role: 'department' } as const;
  const dispatcher = { role: 'dispatcher' } as const;

  it('заявитель до 15:00 МСК заказывает на завтра', () => {
    at('2026-08-12T11:59:00.000Z'); // 14:59 МСК 12-го
    expect(minVehicleRequestDateKey(shtab)).toBe('2026-08-13');
    expect(minVehicleRequestDateKey(rukstroy)).toBe('2026-08-13');
    expect(minVehicleRequestDateKey(department)).toBe('2026-08-13');
  });

  it('с 15:00 МСК — уже на послезавтра; ровно 15:00 отсечку прошло', () => {
    at('2026-08-12T12:00:00.000Z'); // 15:00 МСК 12-го — граница включена в «после»
    expect(minVehicleRequestDateKey(shtab)).toBe('2026-08-14');
    at('2026-08-12T20:30:00.000Z'); // 23:30 МСК того же дня
    expect(minVehicleRequestDateKey(shtab)).toBe('2026-08-14');
  });

  it('отсечка и сутки считаются по МСК, а не по UTC', () => {
    // 00:30 МСК 13-го (21:30 UTC 12-го): в Москве уже новый день и раннее утро — значит снова
    // «завтра», то есть 14-е. По UTC здесь всё ещё вечер 12-го, и граница разошлась бы на день.
    at('2026-08-12T21:30:00.000Z');
    expect(minVehicleRequestDateKey(shtab)).toBe('2026-08-14');
  });

  it('тот, кто ведёт заказы, заводит заявку и день в день', () => {
    at('2026-08-12T20:30:00.000Z'); // 23:30 МСК — отсечка давно прошла
    expect(minVehicleRequestDateKey(dispatcher)).toBe('2026-08-12');
    expect(minVehicleRequestDateKey({ role: 'manager' })).toBe('2026-08-12');
    expect(minVehicleRequestDateKey({ role: 'admin' })).toBe('2026-08-12');
    // Тем же днём границу считает и общее правило заявок — правило заблаговременности его не
    // двигает: у ведущего заказы нижний край остался прежним.
    expect(minVehicleRequestDateKey(dispatcher)).toBe(minRequestDateKey());
  });

  it('субъект без роли под правило подпадает: прав у него нет никаких', () => {
    at('2026-08-12T09:00:00.000Z');
    expect(isVehicleRequestRequester(null)).toBe(true);
    expect(minVehicleRequestDateKey(null)).toBe('2026-08-13');
  });

  it('блокировка называет причину слишком близкой дате и молчит о доступной', () => {
    at('2026-08-12T09:00:00.000Z'); // 12:00 МСК — до отсечки
    expect(vehicleRequestLeadTimeBlocker(shtab, '2026-08-12')).toBe(
      VEHICLE_REQUEST_LEAD_TIME_MESSAGE,
    );
    expect(vehicleRequestLeadTimeBlocker(shtab, '2026-08-13')).toBeNull();
    // Диспетчеру та же сегодняшняя дата доступна — правило считает границу от субъекта.
    expect(vehicleRequestLeadTimeBlocker(dispatcher, '2026-08-12')).toBeNull();
  });
});

/**
 * Какую дату двигает правка (ADR 0101, §4 плана). Это самое лёгкое место ошибиться во всей фиче:
 * ошибка здесь не роняет запрос, а тихо переносит границу — то спрашивает право там, где правят
 * телефон, то не спрашивает там, где переписывают прошедший день.
 */
describe('эффективная дата правки заявки', () => {
  const TERM = { dateFrom: '2026-08-10', dateTo: '2026-08-20' };

  it('правка без календарных полей заднего числа не заводит', () => {
    // Тело правки несёт только комментарий и контакт: календарь не тронут — `null`, и guard
    // молчит. Ради этого случая функция и существует (Р29, «когда guard срабатывает»).
    expect(movedRequestDateKey(TERM, {})).toBeNull();
    // Переданное, но то же самое значение — тоже не сдвиг: форма шлёт срок целиком всегда.
    expect(movedRequestDateKey(TERM, { dateFrom: '2026-08-10', dateTo: '2026-08-20' })).toBeNull();
  });

  it('двигают новые значения, а из двух границ — более ранняя', () => {
    expect(movedRequestDateKey(TERM, { dateFrom: '2026-08-05' })).toBe('2026-08-05');
    expect(movedRequestDateKey(TERM, { dateTo: '2026-08-25' })).toBe('2026-08-25');
    // Обе границы разом: глубину решает более ранняя — она строже по всем исходам guard.
    expect(movedRequestDateKey(TERM, { dateFrom: '2026-08-04', dateTo: '2026-08-25' })).toBe(
      '2026-08-04',
    );
  });

  it('снятая дата окончания — тоже сдвиг: срок стал однодневным', () => {
    // `null` означает «конец срока переехал на его начало» (coalesce(date_to, date_from)), и это
    // сокращение срока, а не «поле не трогали».
    expect(movedRequestDateKey(TERM, { dateTo: null })).toBe('2026-08-10');
    // А не переданное поле — именно «не трогали»: у однодневной заявки от этого ничего не едет.
    expect(movedRequestDateKey({ dateFrom: '2026-08-10', dateTo: null }, {})).toBeNull();
  });

  it('у грузоперевозки двигается день подачи, а время суток в границе не участвует', () => {
    expect(
      movedRequestDateKey({ scheduledDay: '2026-08-10' }, { scheduledDay: '2026-08-09' }),
    ).toBe('2026-08-09');
    expect(
      movedRequestDateKey({ scheduledDay: '2026-08-10' }, { scheduledDay: '2026-08-10' }),
    ).toBeNull();
  });

  /**
   * День заказа (ADR 0104) — второй вопрос к тому же телу правки, и ответы у них расходятся ровно
   * там, где двигают конец срока: заднему ходу это сдвиг, заблаговременности — нет.
   */
  it('день заказа двигают только начало срока и день подачи', () => {
    expect(movedRequestStartKey(TERM, { dateFrom: '2026-08-12' })).toBe('2026-08-12');
    expect(
      movedRequestStartKey({ scheduledDay: '2026-08-10' }, { scheduledDay: '2026-08-12' }),
    ).toBe('2026-08-12');
    // Сокращение срока — не заказ на другой день: техника ближе не придвинулась.
    expect(movedRequestStartKey(TERM, { dateTo: '2026-08-11' })).toBeNull();
    expect(movedRequestStartKey(TERM, { dateTo: null })).toBeNull();
    // Правка без календаря и переданное прежнее значение — тем же `null`, что у заднего хода.
    expect(movedRequestStartKey(TERM, {})).toBeNull();
    expect(movedRequestStartKey(TERM, { dateFrom: '2026-08-10' })).toBeNull();
  });
});

// ── Схемы заявок ──

const OBJ = '11111111-1111-4111-8111-111111111111';
const TYPE = '33333333-3333-4333-8333-333333333333';

const wasteBase = {
  objectId: OBJ,
  requestType: 'container_install' as const,
  containerTypeId: TYPE,
  // Контакт ответственного обязателен при заведении заявки (миграция 0062); к сроку доставки,
  // который проверяют эти тесты, он отношения не имеет — стоит в базовой фикстуре.
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
};

describe('createWasteRequestSchema: рабочее окно доставки', () => {
  it('принимает время внутри окна', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T08:00:00.000+03:00',
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет время вне окна', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T06:30:00.000+03:00',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'deliveryAt')).toBe(true);
  });

  it('полночь допустима, когда время явно не задано', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T00:00:00.000+03:00',
      deliveryTimeUnspecified: true,
    });
    expect(r.success).toBe(true);
    expect(r.data?.deliveryTimeUnspecified).toBe(true);
  });

  it('без признака время считается заданным', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T09:15:00.000+03:00',
    });
    expect(r.success).toBe(true);
    expect(r.data?.deliveryTimeUnspecified).toBe(false);
  });
});

describe('createWasteRequestSchema: минимальная дата доставки', () => {
  const parseAt = (deliveryAt: string) =>
    createWasteRequestSchema.safeParse({ ...wasteBase, deliveryAt });

  it('отклоняет вчерашнюю дату', () => {
    const r = parseAt('2026-07-26T10:00:00.000+03:00');
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'deliveryAt')).toBe(true);
  });

  it('принимает сегодня — вывоз заказывают и день в день', () => {
    expect(parseAt('2026-07-27T10:00:00.000+03:00').success).toBe(true);
  });

  it('принимает завтра и более поздние даты', () => {
    expect(parseAt('2026-07-28T10:00:00.000+03:00').success).toBe(true);
    expect(parseAt('2026-09-01T10:00:00.000+03:00').success).toBe(true);
  });

  it('правку заявки правило не касается: дату можно оставить прежней', () => {
    const r = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-20T10:00:00.000+03:00',
    });
    expect(r.success).toBe(true);
  });
});

describe('updateWasteRequestSchema: рабочее окно доставки', () => {
  it('проверяет окно, когда дата передана', () => {
    const bad = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-28T22:00:00.000+03:00',
    });
    expect(bad.success).toBe(false);
  });

  it('пропускает проверку при снятом времени', () => {
    const ok = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-28T00:00:00.000+03:00',
      deliveryTimeUnspecified: true,
    });
    expect(ok.success).toBe(true);
  });

  it('не трогает окно, если дата не передана', () => {
    const ok = updateWasteRequestSchema.safeParse({ version: 1, comment: 'без даты' });
    expect(ok.success).toBe(true);
  });
});

const resolvedMeta = {
  source: 'resolved' as const,
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
};

const freightBase = {
  requestType: 'freight_transport' as const,
  objectId: OBJ,
  vehicleTypeId: TYPE,
  volumeM3: 10,
  loadingLocation: 'г Москва, ул Тверская, д 1',
  unloadingLocation: 'г Москва, ул Арбат, д 2',
  loadingAddress: resolvedMeta,
  unloadingAddress: resolvedMeta,
  loadingResponsibleName: 'Сидоров С. С.',
  loadingResponsiblePhone: '+7 926 000-00-02',
  unloadingResponsibleName: 'Кузнецов К. К.',
  unloadingResponsiblePhone: '+7 926 000-00-03',
};

describe('createVehicleRequestSchema: рабочее окно подачи', () => {
  it('принимает время внутри окна', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T10:00:00+03:00',
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет время вне окна', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T05:00:00+03:00',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'scheduledAt')).toBe(true);
  });

  it('полночь допустима, когда время явно не задано', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T00:00:00+03:00',
      scheduledTimeUnspecified: true,
    });
    expect(r.success).toBe(true);
  });
});

describe('createVehicleRequestSchema: минимальная дата', () => {
  const specialBase = {
    requestType: 'special_equipment' as const,
    objectId: OBJ,
    vehicleTypeId: TYPE,
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 926 000-00-01',
  };

  it('грузоперевозка: подача вчера без объяснения отклоняется, сегодня — принимается', () => {
    const yesterday = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-26T10:00:00+03:00',
    });
    expect(yesterday.success).toBe(false);
    expect(yesterday.error?.issues.some((i) => i.path.join('.') === 'scheduledAt')).toBe(true);
    expect(
      createVehicleRequestSchema.safeParse({
        ...freightBase,
        scheduledAt: '2026-07-27T10:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('спецтехника: начало периода не раньше сегодня, пока прошлое не объявлено', () => {
    const yesterday = createVehicleRequestSchema.safeParse({
      ...specialBase,
      dateFrom: '2026-07-26',
      dateTo: '2026-07-30',
    });
    expect(yesterday.success).toBe(false);
    expect(yesterday.error?.issues.some((i) => i.path.join('.') === 'dateFrom')).toBe(true);
    expect(
      createVehicleRequestSchema.safeParse({ ...specialBase, dateFrom: '2026-07-27' }).success,
    ).toBe(true);
  });

  it('правку заявки правило не касается', () => {
    const r = updateVehicleRequestSchema.safeParse({
      requestType: 'special_equipment',
      version: 1,
      dateFrom: '2026-07-20',
    });
    expect(r.success).toBe(true);
  });

  /**
   * Задним числом (ADR 0101, Р15). Здесь проходит граница между схемой и сервером, и до этапа 3
   * она стояла в другом месте: схема отклоняла прошлое **всегда**, даже с объяснением, потому что
   * серверной проверки не существовало и одна строка в теле открывала бы задний день кому угодно.
   *
   * Теперь проверку заводит сервер (`backdateGuard` в `POST /vehicle-requests`), и граница
   * переехала туда, где ей место: схема отвечает только за **необъявленное** прошлое — опечатку в
   * дейтпикере и заведение вчерашним днём по привычке. Объявленное она пропускает молча и не
   * разрешает им ничего: право и глубину спрашивает ручка, и без права ответит 403, сколько бы
   * объяснений ни было в теле.
   */
  it('необъявленное прошлое отклоняется, объявленное причиной — уходит серверу', () => {
    const yesterday = { ...specialBase, dateFrom: '2026-07-26', dateTo: '2026-07-30' };
    expect(createVehicleRequestSchema.safeParse(yesterday).success).toBe(false);
    expect(
      createVehicleRequestSchema.safeParse({
        ...yesterday,
        backdateReason: 'техника вышла 26-го, заявку оформили 27-го',
      }).success,
    ).toBe(true);
  });

  it('то же у грузоперевозки — правило одно на оба вида заявки', () => {
    const yesterday = { ...freightBase, scheduledAt: '2026-07-26T10:00:00+03:00' };
    expect(createVehicleRequestSchema.safeParse(yesterday).success).toBe(false);
    expect(
      createVehicleRequestSchema.safeParse({ ...yesterday, backdateReason: 'рейс был вчера' })
        .success,
    ).toBe(true);
  });

  /**
   * Отказ схемы называет оба недостающих условия сразу, а не одну «слишком раннюю дату»: из тела
   * запроса видно только причину, и человек, прочитавший «дата не может быть раньше сегодняшней»,
   * не узнал бы, что вчерашний день вообще-то открывается — объяснением и правом.
   */
  it('отказ объясняет, чего не хватает, и стоит на самом поле даты', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...specialBase,
      dateFrom: '2026-07-26',
    });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join('.') === 'dateFrom');
    expect(issue?.message).toBe(BACKDATE_UNDECLARED_MESSAGE);
  });

  /**
   * Ключ идемпотентности (Р31) схема принимает, но не требует: нужен он или нет, решает дата, а
   * дату со «сегодня» по-настоящему сравнивает сервер. Обычное заведение ключа не спрашивает —
   * иначе коррекцией пришлось бы объявить всю дневную работу.
   */
  it('ключ операции — необязательное поле обеих схем', () => {
    const key = '9f1c0f7e-1a3d-4c2b-9f2a-2b7d6e5c4a31';
    expect(
      createVehicleRequestSchema.safeParse({
        ...specialBase,
        dateFrom: '2026-07-26',
        backdateReason: 'вышли 26-го',
        operationId: key,
      }).success,
    ).toBe(true);
    expect(
      updateVehicleRequestSchema.safeParse({
        requestType: 'special_equipment',
        version: 1,
        dateFrom: '2026-07-26',
        backdateReason: 'вышли 26-го',
        operationId: key,
      }).success,
    ).toBe(true);
    // Не uuid — не ключ: `runCorrection` пишет его в колонку uuid, и «retry-1» дошёл бы до базы.
    expect(
      createVehicleRequestSchema.safeParse({
        ...specialBase,
        dateFrom: '2026-07-27',
        operationId: 'retry-1',
      }).success,
    ).toBe(false);
  });

  /** Поле при этом живое: сегодняшнюю заявку с причиной схема принимает — её положит сервер. */
  it('причина принимается как поле и не мешает обычному заведению', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...specialBase,
      dateFrom: '2026-07-27',
      backdateReason: 'оформили с опозданием на час',
    });
    expect(r.success).toBe(true);
  });

  it('пустая отговорка объяснением не считается', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...specialBase,
      dateFrom: '2026-07-27',
      backdateReason: '   ',
    });
    expect(r.success).toBe(false);
  });

  it('правка принимает причину сдвига срока — её сервер положит в запись операции', () => {
    const r = updateVehicleRequestSchema.safeParse({
      requestType: 'special_equipment',
      version: 1,
      dateFrom: '2026-07-20',
      backdateReason: 'техника вышла на неделю раньше оформления',
    });
    expect(r.success).toBe(true);
  });
});
