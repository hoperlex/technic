import { describe, expect, it } from 'vitest';
import {
  approveWeeklyRequestSchema,
  can,
  createWeeklyRequestSchema,
  extendBlocker,
  formatWeeklyRequestNumber,
  itemWarnings,
  newItemBlocker,
  orderEffectiveDateTo,
  parseWeeklyRequestNumberSearch,
  PHONE_FORMAT_MESSAGE,
  profilesWith,
  selectableWeeks,
  sourceItemBlocker,
  updateWeeklyRequestSchema,
  weeklyRequestItemSchema,
  weeklyRequestStatusSchema,
  weeklyWeekBlocker,
  weeklyWeekBounds,
  weeklyWeekLabel,
  WEEKLY_REQUEST_STATUSES,
  WEEKLY_SELECTABLE_WEEKS,
  weeklyItemResultColors,
  weeklyItemResultLabels,
  weeklyRequestStatusColors,
  weeklyRequestStatusLabels,
  type WeeklyItemClassification,
  type WeeklyNewItem,
  type WeeklyRequestScope,
  type WeeklySourceOrder,
} from '@technic/contracts';

/**
 * Контракты недельной заявки на технику: неделя, годность строки состава и формы запросов.
 *
 * Всё это живёт в общем пакете, потому что каждое правило спрашивают двое — форма сборки и
 * сервер. Тест проверяет именно это: одну и ту же строку отказа получают оба, а сервер не
 * принимает из тела ни одного поля, которое обязан проставить сам.
 *
 * «Сегодня» здесь — параметр, а не системные часы: недельную заявку сервер считает от
 * `moscowDateKeyOf(new Date())`, и подмена таймеров ничего к проверке не добавила бы.
 */

const OBJ = '11111111-1111-4111-8111-111111111111';
const OTHER_OBJ = '22222222-2222-4222-8222-222222222222';
const TYPE = '33333333-3333-4333-8333-333333333333';
const CATEGORY = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';

/** Пятница 07.08.2026 — неделя 03–09.08 идёт, ближайшая доступная начинается 10.08. */
const TODAY = '2026-08-07';
const WEEK_START = '2026-08-10';
const WEEK_END = '2026-08-16';

const weekly: WeeklyRequestScope = {
  objectId: OBJ,
  weekStart: WEEK_START,
  weekEnd: WEEK_END,
  objectIsActive: true,
};

/** Заказ, который стоит на площадке и кончается в воскресенье перед целевой неделей. */
const order: WeeklySourceOrder = {
  id: REQUEST,
  objectId: OBJ,
  requestType: 'special_equipment',
  status: 'confirmed',
  deletedAt: null,
  dateFrom: '2026-08-01',
  dateTo: '2026-08-09',
  hasAssignment: true,
};

const orderWith = (patch: Partial<WeeklySourceOrder>): WeeklySourceOrder => ({
  ...order,
  ...patch,
});

describe('номер недельной заявки', () => {
  it('показывается с префиксом «НЗ», ищется в любом написании', () => {
    expect(formatWeeklyRequestNumber(12)).toBe('НЗ-12');
    expect(parseWeeklyRequestNumberSearch('12')).toBe(12);
    expect(parseWeeklyRequestNumberSearch('НЗ-12')).toBe(12);
    expect(parseWeeklyRequestNumberSearch('нз-000012')).toBe(12);
    // Не номер: искать нечего, и «0» здесь не номер тоже.
    expect(parseWeeklyRequestNumberSearch('НЗ-')).toBeUndefined();
    expect(parseWeeklyRequestNumberSearch('0')).toBeUndefined();
  });
});

describe('неделя заявки', () => {
  /**
   * Текущая неделя закрыта (Р2), и день внутри недели на выбор не влияет: в понедельник список
   * тот же, что в воскресенье. Иначе площадка, открывшая форму в понедельник, получила бы неделю,
   * которая уже идёт, — и продление задним числом относительно собственного правила.
   */
  it('предлагаются только будущие недели — и в понедельник, и в воскресенье', () => {
    const expected = ['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
    expect(selectableWeeks('2026-08-03')).toEqual(expected); // понедельник
    expect(selectableWeeks('2026-08-09')).toEqual(expected); // воскресенье той же недели
    expect(selectableWeeks(TODAY)).toEqual(expected); // пятница
    expect(selectableWeeks(TODAY)).toHaveLength(WEEKLY_SELECTABLE_WEEKS);
    // Текущей недели среди предложенных нет ни в одном из трёх случаев.
    expect(selectableWeeks('2026-08-03')).not.toContain('2026-08-03');
  });

  it('границы недели считаются от понедельника, а середина недели к нему приводится', () => {
    expect(weeklyWeekBounds(WEEK_START)).toEqual({ from: WEEK_START, to: WEEK_END });
    expect(weeklyWeekBounds('2026-08-13')).toEqual({ from: WEEK_START, to: WEEK_END });
  });

  it('подпись недели: внутри месяца, через месяц и через год', () => {
    expect(weeklyWeekLabel(WEEK_START)).toBe('10–16 августа 2026');
    // Через месяц: повторять один и тот же год незачем, а месяц назвать обязательно.
    expect(weeklyWeekBounds('2026-08-31')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(weeklyWeekLabel('2026-08-31')).toBe('31 августа – 6 сентября 2026');
    // Через год: год называется у обеих границ — иначе подпись врёт на одной из них.
    expect(weeklyWeekBounds('2025-12-29')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(weeklyWeekLabel('2025-12-29')).toBe('29 декабря 2025 – 4 января 2026');
  });

  /**
   * Тот же разбор проверяет и форма, и сервер в пяти точках (§8): черновик, заведённый в четверг,
   * доживает до понедельника своей недели, и без проверки на подаче и визе портал применил бы
   * заявку на текущую неделю.
   */
  it('допустимая неделя: понедельник, будущая, в пределах предлагаемых', () => {
    for (const week of selectableWeeks(TODAY)) {
      expect(weeklyWeekBlocker(week, TODAY), week).toBeNull();
    }
    expect(weeklyWeekBlocker('2026-07-27', TODAY)).toContain('уже прошла');
    expect(weeklyWeekBlocker('2026-08-03', TODAY)).toContain('уже началась');
    // Пятая будущая неделя: отказ называет последнюю доступную — человеку нужен выход, а не «нет».
    expect(weeklyWeekBlocker('2026-09-07', TODAY)).toContain('не дальше недели 31 августа');
    expect(weeklyWeekBlocker('2026-08-11', TODAY)).toBe('Неделя начинается с понедельника');
    expect(weeklyWeekBlocker('11.08.2026', TODAY)).toContain('календарной датой понедельника');
  });
});

describe('годность строки, ссылающейся на заказ', () => {
  it('заказ на площадке, в работе, с машиной и неизменившимся сроком — годен', () => {
    expect(sourceItemBlocker(order, weekly, '2026-08-09')).toBeNull();
    expect(extendBlocker(order, weekly, '2026-08-09', WEEK_END)).toBeNull();
  });

  it('чужая площадка отсекается первой: внешний ключ сам её не проверяет', () => {
    expect(extendBlocker(orderWith({ objectId: OTHER_OBJ }), weekly, '2026-08-09', WEEK_END)).toBe(
      'Заказ относится к другой площадке',
    );
    expect(extendBlocker(orderWith({ objectId: null }), weekly, '2026-08-09', WEEK_END)).toBe(
      'Заказ относится к другой площадке',
    );
  });

  it('грузоперевозка неделей не ведётся: у неё нет срока работ', () => {
    const freight = orderWith({ requestType: 'freight_transport' });
    expect(extendBlocker(freight, weekly, '2026-08-09', WEEK_END)).toContain('грузоперевозки');
  });

  it('закрытый, отменённый и откаченный в «Новую» заказ негодны одинаково', () => {
    for (const status of ['done', 'cancelled', 'new'] as const) {
      expect(extendBlocker(orderWith({ status }), weekly, '2026-08-09', WEEK_END), status).toBe(
        'Заказ не в статусе «В работе»',
      );
    }
  });

  it('удалённый заказ и заказ без назначения в состав не идут', () => {
    expect(
      extendBlocker(
        orderWith({ deletedAt: '2026-08-06T10:00:00Z' }),
        weekly,
        '2026-08-09',
        WEEK_END,
      ),
    ).toBe('Заказ в архиве');
    expect(extendBlocker(orderWith({ hasAssignment: false }), weekly, '2026-08-09', WEEK_END)).toBe(
      'На заказе нет назначенной техники',
    );
  });

  /**
   * Заказ, заказанный за пределы недели, решать на этой неделе нечем: он и так работает всю её.
   * В шапке формы такие считаются отдельной строкой — «ещё 3 единицы заказаны дольше недели».
   */
  it('заказ, заказанный дольше недели, в состав не попадает', () => {
    const long = orderWith({ dateTo: '2026-08-20' });
    expect(extendBlocker(long, weekly, '2026-08-20', WEEK_END)).toContain('дальше недели заявки');
    // Граница включительно: срок ровно до воскресенья — это уже «вся неделя занята».
    const exact = orderWith({ dateTo: WEEK_END });
    expect(extendBlocker(exact, weekly, WEEK_END, WEEK_END)).toContain('дальше недели заявки');
  });

  it('заказ, кончившийся больше недели назад, продлевается новым заказом, а не продлением', () => {
    const stale = orderWith({ dateTo: '2026-08-02' });
    expect(extendBlocker(stale, weekly, '2026-08-02', WEEK_END)).toContain('больше недели назад');
    // Ровно неделя до понедельника — ещё продлевается: граница проведена по дню, а не «около».
    const edge = orderWith({ dateTo: '2026-08-03' });
    expect(extendBlocker(edge, weekly, '2026-08-03', WEEK_END)).toBeNull();
  });

  /**
   * Сверяется срок, а не версия заказа (Р14): версия растёт от любой правки, включая телефон
   * ответственного, и выбрасывала бы строки по поводам, к решению не относящимся.
   */
  it('срок, изменившийся после подачи, выбрасывает строку и называет обе даты', () => {
    const moved = orderWith({ dateTo: '2026-08-15' });
    expect(sourceItemBlocker(moved, weekly, '2026-08-11')).toBe(
      'Срок заказа изменился после подачи: было 11.08, стало 15.08',
    );
    // Снимка ещё нет (состав только собирается) — сверять не с чем, и строка годна.
    expect(sourceItemBlocker(moved, weekly, null)).toBeNull();
  });

  it('однодневный заказ читается как `coalesce(date_to, date_from)`', () => {
    const single = orderWith({ dateFrom: '2026-08-05', dateTo: null });
    expect(orderEffectiveDateTo(single)).toBe('2026-08-05');
    expect(sourceItemBlocker(single, weekly, '2026-08-05')).toBeNull();
    expect(sourceItemBlocker(single, weekly, '2026-08-04')).toContain('было 04.08, стало 05.08');
  });

  /** Строка «уезжает» задаёт заказу те же вопросы, кроме даты (Р10): список условий один. */
  it('строка «уезжает» проверяется тем же предикатом, что продление', () => {
    expect(sourceItemBlocker(order, weekly, '2026-08-09')).toBeNull();
    for (const patch of [
      { objectId: OTHER_OBJ },
      { status: 'cancelled' as const },
      { deletedAt: '2026-08-06T10:00:00Z' },
      { hasAssignment: false },
      { dateTo: '2026-08-20' },
      { dateTo: '2026-08-02' },
    ]) {
      const candidate = orderWith(patch);
      const forLeave = sourceItemBlocker(candidate, weekly, null);
      expect(forLeave, JSON.stringify(patch)).not.toBeNull();
      // Одна и та же причина у обоих видов строки — второй список условий разошёлся бы с первым.
      expect(extendBlocker(candidate, weekly, null, WEEK_END)).toBe(forLeave);
    }
  });
});

describe('дата продления', () => {
  it('лежит внутри недели заявки', () => {
    expect(extendBlocker(order, weekly, '2026-08-09', '2026-08-17')).toContain(
      'внутри недели заявки',
    );
    expect(extendBlocker(order, weekly, '2026-08-09', '2026-08-09')).toContain(
      'внутри недели заявки',
    );
    expect(extendBlocker(order, weekly, '2026-08-09', WEEK_START)).toBeNull();
  });

  /**
   * Скрытое сокращение (Р4): строку собрали, когда заказ кончался во вторник, а до визы его
   * продлили до пятницы — и «продлить до среды» отняло бы два дня в обход досрочного завершения
   * с визой (ADR 0044).
   */
  it('строго больше нынешнего конца срока — иначе это сокращение в обход визы', () => {
    const till12 = orderWith({ dateTo: '2026-08-12' });
    expect(extendBlocker(till12, weekly, '2026-08-12', '2026-08-12')).toContain(
      'продление не сокращает срок',
    );
    expect(extendBlocker(till12, weekly, '2026-08-12', '2026-08-11')).toContain(
      'продление не сокращает срок',
    );
    expect(extendBlocker(till12, weekly, '2026-08-12', '2026-08-13')).toBeNull();
  });
});

describe('годность строки «нужна дополнительно»', () => {
  const item: WeeklyNewItem = {
    vehicleTypeId: TYPE,
    vehicleCategoryId: CATEGORY,
    dateFrom: WEEK_START,
    dateTo: WEEK_END,
    responsibleName: 'Петров П. П.',
    responsiblePhone: '9260000001',
    deliveryNeeded: false,
    deliveryFrom: '',
  };
  const classification: WeeklyItemClassification = {
    typeIsActive: true,
    categoryIsActive: true,
    hasCategories: true,
  };
  const itemWith = (patch: Partial<WeeklyNewItem>): WeeklyNewItem => ({ ...item, ...patch });

  it('полная строка внутри недели годна', () => {
    expect(newItemBlocker(item, weekly, classification)).toBeNull();
  });

  /**
   * Погашенная позиция классификатора проверяется наравне с заказом (Р9): деактивированный тип в
   * одной строке не роняет неделю целиком, но и молча создавать заказ на него нельзя.
   */
  it('погашенные тип, категория и площадка отсекаются по отдельности', () => {
    expect(newItemBlocker(item, weekly, { ...classification, typeIsActive: false })).toBe(
      'Тип ТС погашен в справочнике',
    );
    expect(newItemBlocker(item, weekly, { ...classification, categoryIsActive: false })).toBe(
      'Категория ТС погашена в справочнике',
    );
    expect(newItemBlocker(item, { ...weekly, objectIsActive: false }, classification)).toBe(
      'Площадка погашена в справочнике',
    );
  });

  it('позиция классификатора выбирается целиком: у типа с категориями категория обязательна', () => {
    const noCategory = itemWith({ vehicleCategoryId: null });
    expect(newItemBlocker(noCategory, weekly, classification)).toBe(
      'У этого типа ТС выбирают категорию',
    );
    // У типа без категорий она и не бывает — пустое значение здесь не «не указали».
    expect(
      newItemBlocker(noCategory, weekly, {
        typeIsActive: true,
        categoryIsActive: null,
        hasCategories: false,
      }),
    ).toBeNull();
  });

  it('срок строки не выходит за пределы недели', () => {
    expect(newItemBlocker(itemWith({ dateFrom: '2026-08-09' }), weekly, classification)).toContain(
      'за пределы недели',
    );
    expect(newItemBlocker(itemWith({ dateTo: '2026-08-17' }), weekly, classification)).toContain(
      'за пределы недели',
    );
    expect(
      newItemBlocker(
        itemWith({ dateFrom: '2026-08-14', dateTo: '2026-08-12' }),
        weekly,
        classification,
      ),
    ).toBe('Дата окончания раньше даты начала');
  });

  it('контакт встречающего обязателен, как в обычной заявке', () => {
    expect(newItemBlocker(itemWith({ responsibleName: '  ' }), weekly, classification)).toBe(
      'Укажите ответственного на объекте',
    );
    expect(newItemBlocker(itemWith({ responsiblePhone: '926' }), weekly, classification)).toBe(
      PHONE_FORMAT_MESSAGE,
    );
  });

  it('доставка без места отправления не заказывается', () => {
    expect(newItemBlocker(itemWith({ deliveryNeeded: true }), weekly, classification)).toBe(
      'Укажите, откуда доставить технику',
    );
    expect(
      newItemBlocker(
        itemWith({ deliveryNeeded: true, deliveryFrom: 'База, ул. Складская, 4' }),
        weekly,
        classification,
      ),
    ).toBeNull();
  });
});

describe('предупреждения строки', () => {
  it('сплошное продление, перевыписка листа, ожидающий отъезд, аренда и вторая неделя', () => {
    const warnings = itemWarnings(
      {
        ...orderWith({ dateTo: '2026-08-05' }),
        ownership: 'own',
        pendingEarlyEndDate: '2026-08-12',
        otherWeekly: { num: 15, weekStart: '2026-08-17' },
      },
      { ...weekly, today: TODAY },
      WEEK_END,
    );
    const kinds = warnings.map((w) => w.kind);
    expect(kinds).toEqual(['idle_days', 'esm2_reissue', 'early_end_pending', 'other_weekly']);
    expect(warnings[0]?.text).toContain('4 дн. до начала недели');
    expect(warnings[2]?.text).toContain('12.08');
    expect(warnings[3]?.text).toContain('НЗ-15 (17–23 августа 2026)');
  });

  it('выходные между сроком и понедельником поводом не считаются', () => {
    const quiet = itemWarnings(
      { ...order, ownership: 'own', pendingEarlyEndDate: null, otherWeekly: null },
      { ...weekly, today: TODAY },
      WEEK_END,
    );
    // Заказ кончается в воскресенье перед неделей: простоя нет, лист недели целый — перевыписки
    // тоже нет.
    expect(quiet).toEqual([]);
  });

  it('аренда объясняется словами, а не пустым местом (Р19)', () => {
    const rental = itemWarnings(
      { ...order, ownership: 'rental', pendingEarlyEndDate: null, otherWeekly: null },
      { ...weekly, today: TODAY },
      WEEK_END,
    );
    expect(rental.map((w) => w.kind)).toEqual(['rental']);
    expect(rental[0]?.text).toContain('арендодатель');
  });
});

describe('схемы запросов', () => {
  const extendItem = { kind: 'extend' as const, sourceRequestId: REQUEST, dateTo: WEEK_END };
  const newItem = {
    kind: 'new' as const,
    vehicleTypeId: TYPE,
    vehicleCategoryId: CATEGORY,
    dateFrom: WEEK_START,
    dateTo: WEEK_END,
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 926 000-00-01',
  };
  const leaveItem = { kind: 'leave' as const, sourceRequestId: REQUEST };

  it('три вида строки разбираются по `kind` и добираются умолчаниями', () => {
    const extend = weeklyRequestItemSchema.parse(extendItem);
    expect(extend).toMatchObject({ kind: 'extend', earlyEndOverride: false, comment: '' });
    const created = weeklyRequestItemSchema.parse(newItem);
    expect(created).toMatchObject({ kind: 'new', deliveryNeeded: false, deliveryFrom: '' });
    // Телефон нормализуется схемой: в колонке не должно заводиться второго формата (ADR 0066).
    expect(created).toMatchObject({ responsiblePhone: '9260000001' });
    expect(weeklyRequestItemSchema.parse(leaveItem)).toMatchObject({ kind: 'leave', comment: '' });
  });

  /**
   * Форма строки — та же развилка, что CHECK `weekly_items_kind_shape_check`: у трёх видов три
   * разных обязательных набора. Общая схема с `optional()` приняла бы «уезжает с типом ТС».
   */
  it('чужие поля вида строки отвергаются', () => {
    expect(weeklyRequestItemSchema.safeParse({ ...extendItem, vehicleTypeId: TYPE }).success).toBe(
      false,
    );
    expect(
      weeklyRequestItemSchema.safeParse({ ...newItem, vehicleTypeId: undefined }).success,
    ).toBe(false);
    expect(
      weeklyRequestItemSchema.safeParse({ ...leaveItem, dateFrom: WEEK_START, dateTo: WEEK_END })
        .success,
    ).toBe(false);
    // Контакт у строки `new` обязателен схемой, а не только сервером.
    expect(weeklyRequestItemSchema.safeParse({ ...newItem, responsiblePhone: '926' }).success).toBe(
      false,
    );
    // Доставка без места отправления не проходит и схему: правило одно, а не «сервер добьёт».
    expect(weeklyRequestItemSchema.safeParse({ ...newItem, deliveryNeeded: true }).success).toBe(
      false,
    );
    expect(
      weeklyRequestItemSchema.safeParse({ ...newItem, dateFrom: WEEK_END, dateTo: WEEK_START })
        .success,
    ).toBe(false);
    // Неизвестный вид строки: разбирать нечем, и «похожий» брать нельзя.
    expect(weeklyRequestItemSchema.safeParse({ ...extendItem, kind: 'prolong' }).success).toBe(
      false,
    );
  });

  it('создание: объект, неделя и состав; пустой состав допустим', () => {
    const parsed = createWeeklyRequestSchema.parse({ objectId: OBJ, weekStart: WEEK_START });
    expect(parsed).toEqual({ objectId: OBJ, weekStart: WEEK_START, items: [], comment: '' });
    expect(
      createWeeklyRequestSchema.parse({
        objectId: OBJ,
        weekStart: WEEK_START,
        items: [extendItem, newItem, leaveItem],
      }).items,
    ).toHaveLength(3);
    // Неделя проверяется отдельно (`weeklyWeekBlocker`): схема отвечает только за формат.
    expect(
      createWeeklyRequestSchema.safeParse({ objectId: OBJ, weekStart: '10.08.2026' }).success,
    ).toBe(false);
  });

  /**
   * Серверные поля в теле (§7): их проставляет только сервер, и `.strict()` — единственное, что
   * отличает «клиент прислал лишнее» от «клиент задал контрольный снимок и провёл через визу
   * продление заказа, срок которого давно другой».
   */
  it('серверных полей в теле нет и быть не может', () => {
    for (const extra of [
      { expectedDateTo: '2026-08-09' },
      { previousDateTo: '2026-08-09' },
      { appliedSourceVersion: 3 },
      { snapshotVehicleId: REQUEST },
      { createdRequestId: REQUEST },
      { result: 'extended' },
      { skipReason: 'нет' },
      { weekStart: WEEK_START },
      { position: 0 },
    ]) {
      expect(
        weeklyRequestItemSchema.safeParse({ ...extendItem, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    for (const extra of [
      { num: 12 },
      { approvedBy: REQUEST },
      { appliedAt: '2026-08-07' },
      { status: 'applied' },
    ]) {
      expect(
        createWeeklyRequestSchema.safeParse({ objectId: OBJ, weekStart: WEEK_START, ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('правка состава переписывает его целиком и требует версию', () => {
    expect(updateWeeklyRequestSchema.parse({ items: [extendItem], version: 3 })).toMatchObject({
      version: 3,
    });
    // Ни объекта, ни недели: пара «объект + неделя» — тождество документа, а не его поле.
    expect(
      updateWeeklyRequestSchema.safeParse({ items: [], version: 3, weekStart: WEEK_START }).success,
    ).toBe(false);
    expect(updateWeeklyRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('подача и снятие: снятие объясняется причиной', () => {
    expect(weeklyRequestStatusSchema.parse({ status: 'pending', version: 0 })).toMatchObject({
      status: 'pending',
      reason: '',
    });
    expect(weeklyRequestStatusSchema.safeParse({ status: 'cancelled', version: 0 }).success).toBe(
      false,
    );
    expect(
      weeklyRequestStatusSchema.safeParse({
        status: 'cancelled',
        reason: 'объект встал',
        version: 0,
      }).success,
    ).toBe(true);
    // Применение — не переход этой ручки: его делает виза той же транзакцией (Р6).
    expect(weeklyRequestStatusSchema.safeParse({ status: 'applied', version: 0 }).success).toBe(
      false,
    );
    expect(weeklyRequestStatusSchema.safeParse({ status: 'draft', version: 0 }).success).toBe(
      false,
    );
  });

  it('виза и отказ — одним телом; отказ объясняется причиной', () => {
    expect(approveWeeklyRequestSchema.parse({ approved: true, version: 2 })).toMatchObject({
      approved: true,
      comment: '',
    });
    expect(approveWeeklyRequestSchema.safeParse({ approved: false, version: 2 }).success).toBe(
      false,
    );
    expect(
      approveWeeklyRequestSchema.safeParse({
        approved: false,
        comment: 'не в этом составе',
        version: 2,
      }).success,
    ).toBe(true);
    // Версия обязательна: согласуют тот состав, который видел визирующий.
    expect(approveWeeklyRequestSchema.safeParse({ approved: true }).success).toBe(false);
  });
});

describe('словари состояний', () => {
  it('у каждого статуса есть подпись и цвет', () => {
    for (const status of WEEKLY_REQUEST_STATUSES) {
      expect(weeklyRequestStatusLabels[status], status).toBeTruthy();
      expect(weeklyRequestStatusColors[status], status).toBeTruthy();
    }
    // Пропущенная строка — то, что площадка просила и не получила: её видно раньше остальных.
    expect(weeklyItemResultColors.skipped).toBe('red');
    expect(weeklyItemResultLabels.skipped).toBe('Пропущена');
  });
});

/**
 * Роли, у которых есть право, — по одному разу каждая и в порядке матрицы.
 *
 * `profilesWith` перечисляет **субъекты доступа**, а не роли, и одна роль встречается в нём
 * столько раз, сколько у неё надстроек (ADR 0086). Здесь спрашивается другое — «кому из ролей
 * открыт модуль», — и повтор роли этому вопросу ничего не добавляет.
 */
function rolesWith(permission: Parameters<typeof profilesWith>[0]): string[] {
  return [...new Set(profilesWith(permission).map((s) => s.role))];
}

describe('права модуля', () => {
  /**
   * Права свои, а не `vehicleRequests.*` (§10): у наблюдателя, оператора вывоза и арендодателя
   * право чтения заказов есть, а область видимости для ролей без объектной оси ничем не
   * ограничена — переиспользование открыло бы им недельные планы всех площадок.
   */
  it('ведут недельные заявки офис и площадка, визирует — руководитель строительства', () => {
    for (const permission of [
      'weeklyRequests.read',
      'weeklyRequests.create',
      'weeklyRequests.update',
    ] as const) {
      expect(rolesWith(permission), permission).toEqual([
        'admin',
        'manager',
        'dispatcher',
        'shtab',
        'rukstroy',
      ]);
    }
    expect(rolesWith('weeklyRequests.approve')).toEqual(['admin', 'rukstroy']);
  });

  it('наблюдатель, комендант, отдел, оператор и арендодатель модуля не видят вовсе', () => {
    const outsiders = [
      { role: 'observer' as const },
      { role: 'commandant' as const },
      { role: 'department' as const },
      { role: 'department_head' as const },
      { role: 'operator' as const, counterpartyType: 'operator' as const },
      { role: 'operator' as const, counterpartyType: 'vehicle_lessor' as const },
    ];
    for (const subject of outsiders) {
      expect(can(subject, 'weeklyRequests.read'), subject.role).toBe(false);
      expect(can(subject, 'weeklyRequests.approve'), subject.role).toBe(false);
    }
    // Заказы ТС при этом им по-прежнему видны — ровно то различие, ради которого права свои.
    expect(can({ role: 'observer' }, 'vehicleRequests.read')).toBe(true);
  });
});
