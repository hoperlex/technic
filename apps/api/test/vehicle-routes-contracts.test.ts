import { describe, expect, it } from 'vitest';
import {
  assignRouteSchema,
  assignVehicleSchema,
  attachRouteRequestSchema,
  canIssueWaybill,
  canJoinRoute,
  formatVehicleRouteNumber,
  isRouteEditable,
  ROUTE_REQUEST_CAPACITY,
  parseVehicleRouteNumberSearch,
  routeCargoLabel,
  routeContactsLabel,
  routeExtraTaskLine,
  routeWaybillForm,
  routeOrderSchema,
  routeTripFieldsSchema,
  shouldDetachOnStatus,
} from '@technic/contracts';

/**
 * Маршрут — рейс машины на дату (план `docs/vehicle-routes-plan.md`). Правила здесь чистые: их
 * зовут и форма, и сервер, и разъехаться двум наборам условий негде — как это уже сделано с
 * `waybillRequirement` (ADR 0041 п. 1).
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

/** Заявка, годная для рейса: от неё отталкиваются проверки «чего не хватает». */
const goodRequest = {
  requestType: 'freight_transport' as const,
  status: 'confirmed' as const,
  deletedAt: null,
  tripDate: '2026-08-03',
  ownership: 'own' as const,
};

const emptyRoute = {
  routeDate: '2026-08-03',
  requestCount: 0,
  purpose: 'freight' as const,
  formCode: '4p' as const,
};

describe('номер маршрута', () => {
  it('читается так же, как его называют в разговоре', () => {
    expect(formatVehicleRouteNumber(12)).toBe('Р-12');
  });

  it('поиск понимает и число, и номер с префиксом', () => {
    expect(parseVehicleRouteNumberSearch('12')).toBe(12);
    expect(parseVehicleRouteNumberSearch('Р-12')).toBe(12);
    expect(parseVehicleRouteNumberSearch('р 0012')).toBe(12);
    expect(parseVehicleRouteNumberSearch('Р-')).toBeUndefined();
    expect(parseVehicleRouteNumberSearch('маршрут')).toBeUndefined();
  });
});

describe('заморозка маршрута выписанным листом', () => {
  it('без листа и с аннулированным маршрут правится', () => {
    expect(isRouteEditable(null)).toBe(true);
    expect(isRouteEditable('cancelled')).toBe(true);
  });

  it('с действующим листом — нет: бумага у водителя главнее записи', () => {
    expect(isRouteEditable('issued')).toBe(false);
  });
});

describe('какая заявка годится для рейса', () => {
  it('грузоперевозка в работе на собственной машине в тот же день', () => {
    expect(canJoinRoute(goodRequest, emptyRoute)).toEqual({ ok: true });
  });

  it('заказ техники на объект по маршруту не едет', () => {
    const check = canJoinRoute({ ...goodRequest, requestType: 'special_equipment' }, emptyRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('грузоперевозки');
  });

  it('заявка не в работе в рейс не кладётся, и статус назван в ответе', () => {
    const check = canJoinRoute({ ...goodRequest, status: 'new' }, emptyRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('Новая');
  });

  it('удалённая заявка не годится', () => {
    expect(canJoinRoute({ ...goodRequest, deletedAt: '2026-08-01T10:00:00Z' }, emptyRoute).ok).toBe(
      false,
    );
  });

  it('арендная машина и машина без назначения объясняются по-разному', () => {
    const rental = canJoinRoute({ ...goodRequest, ownership: 'rental' }, emptyRoute);
    expect(rental.ok === false && rental.reason).toContain('арендодатель');
    const none = canJoinRoute({ ...goodRequest, ownership: null }, emptyRoute);
    expect(none.ok === false && none.reason).toContain('не назначена');
  });

  it('заявка соседнего дня в рейс не попадает: лист печатает задание на день', () => {
    const check = canJoinRoute({ ...goodRequest, tripDate: '2026-08-04' }, emptyRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('2026-08-04');
  });

  /*
   * Вместимость задаёт бумага, и у бланков она разная (ADR 0068): 4-П держит семь строк задания
   * (четыре талона и три строки доп. задания), а таблица оборота формы № 3 разграфлена на десять.
   * Одним числом на портал это не выразить — отсюда и `ROUTE_REQUEST_CAPACITY`.
   */
  it('восьмая заявка не встаёт в 4-П: в нём семь строк задания', () => {
    const full = { ...emptyRoute, requestCount: ROUTE_REQUEST_CAPACITY['4p'] };
    const check = canJoinRoute(goodRequest, full);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('7 строк задания');
    expect(check.ok === false && check.reason).toContain('второй маршрут');
    expect(
      canJoinRoute(goodRequest, { ...full, requestCount: ROUTE_REQUEST_CAPACITY['4p'] - 1 }),
    ).toEqual({ ok: true });
  });

  it('легковой держит десять: столько строк в таблице формы № 3', () => {
    const leg3 = { ...emptyRoute, formCode: 'leg3' as const };
    // Восьмая заявка, отбитая у 4-П, здесь проходит: бланк другой, и строк в нём больше.
    expect(
      canJoinRoute(goodRequest, { ...leg3, requestCount: ROUTE_REQUEST_CAPACITY['4p'] }),
    ).toEqual({ ok: true });
    const check = canJoinRoute(goodRequest, {
      ...leg3,
      requestCount: ROUTE_REQUEST_CAPACITY.leg3,
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('10 строк задания');
  });
});

describe('состав рейса при смене статуса заявки', () => {
  it('«Выполнена» состав не трогает: рейс состоялся, связь — история', () => {
    expect(shouldDetachOnStatus('done', false)).toBe(false);
    expect(shouldDetachOnStatus('done', true)).toBe(false);
  });

  it('отмена и возврат в «Новую» вынимают заявку, пока маршрут не заморожен', () => {
    expect(shouldDetachOnStatus('cancelled', false)).toBe(true);
    expect(shouldDetachOnStatus('new', false)).toBe(true);
  });

  it('из выписанного листа заявка исчезнуть не может', () => {
    expect(shouldDetachOnStatus('cancelled', true)).toBe(false);
    expect(shouldDetachOnStatus('new', true)).toBe(false);
  });
});

describe('готовность рейса к выписке листа', () => {
  const ready = {
    purpose: 'freight' as const,
    driverPersonId: UUID_A,
    formCode: '4p' as const,
    requests: [{ displayNumber: 'ТС-501', status: 'confirmed' as const }],
    sourceRequest: null,
    waybillStatus: null,
  };

  it('водитель, непустой состав и все заявки в работе', () => {
    expect(canIssueWaybill(ready)).toEqual({ ok: true });
  });

  it('без водителя лист не выписать — он обязательный реквизит', () => {
    const check = canIssueWaybill({ ...ready, driverPersonId: null });
    expect(check.ok === false && check.reason).toContain('водителя');
  });

  it('пустому рейсу выписывать нечего', () => {
    expect(canIssueWaybill({ ...ready, requests: [] }).ok).toBe(false);
  });

  it('действующий лист второго не даёт, аннулированный — даёт', () => {
    expect(canIssueWaybill({ ...ready, waybillStatus: 'issued' }).ok).toBe(false);
    expect(canIssueWaybill({ ...ready, waybillStatus: 'cancelled' })).toEqual({ ok: true });
  });

  it('отменённая заявка в составе называет себя и блокирует выдачу', () => {
    const check = canIssueWaybill({
      ...ready,
      waybillStatus: 'cancelled',
      requests: [
        { displayNumber: 'ТС-501', status: 'confirmed' },
        { displayNumber: 'ТС-502', status: 'cancelled' },
      ],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual(['ТС-502']);
  });

  /*
   * Собрать рейс шире бланка портал не даёт (`canJoinRoute`), но бланк типа машины правится
   * справочником уже после сборки (ADR 0065): десять заявок легкового могли остаться с семью
   * строками 4-П. Печатать такой лист нельзя — часть работы дня в бумаге не назовётся.
   */
  it('состав шире бланка выписку останавливает и называет лишние заявки', () => {
    const requests = Array.from({ length: ROUTE_REQUEST_CAPACITY.leg3 }, (_, i) => ({
      displayNumber: `ТС-${500 + i}`,
      status: 'confirmed' as const,
    }));
    expect(canIssueWaybill({ ...ready, formCode: 'leg3', requests })).toEqual({ ok: true });

    const check = canIssueWaybill({ ...ready, formCode: '4p', requests });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('7 строк задания');
    expect(check.ok === false && check.blocking).toEqual(['ТС-507', 'ТС-508', 'ТС-509']);
  });

  it('закрытая заявка — тоже история рейса, а не задание на новый', () => {
    const check = canIssueWaybill({
      ...ready,
      requests: [{ displayNumber: 'ТС-501', status: 'done' }],
    });
    expect(check.ok === false && check.blocking).toEqual(['ТС-501']);
  });

  /**
   * У перегона состава нет: вместо талонов заказчиков он держит заявку, ради которой едет, — и
   * проверяется её состояние. «Выполнена» перегону не мешает: технику вывозят с объекта и после
   * того, как работы закрыли.
   */
  describe('перегон техники', () => {
    const relocation = {
      purpose: 'delivery' as const,
      driverPersonId: UUID_A,
      formCode: '4p' as const,
      requests: [],
      sourceRequest: { displayNumber: 'ТС-700', status: 'confirmed' as const },
      waybillStatus: null,
    };

    it('пустой состав перегону не мешает — он едет по своей заявке', () => {
      expect(canIssueWaybill(relocation)).toEqual({ ok: true });
    });

    it('вывоз выписывается и по закрытой заявке: технику увозят после работ', () => {
      expect(canIssueWaybill({ ...relocation, purpose: 'pickup' })).toEqual({ ok: true });
      expect(
        canIssueWaybill({
          ...relocation,
          purpose: 'pickup',
          sourceRequest: { displayNumber: 'ТС-700', status: 'done' },
        }),
      ).toEqual({ ok: true });
    });

    it('отменённая и откатанная в «Новую» заявка перегон не выписывает', () => {
      for (const status of ['cancelled', 'new'] as const) {
        const check = canIssueWaybill({
          ...relocation,
          sourceRequest: { displayNumber: 'ТС-700', status },
        });
        expect(check.ok).toBe(false);
        expect(check.ok === false && check.blocking).toEqual(['ТС-700']);
      }
    });

    it('водитель обязателен и здесь — он реквизит листа, а не состава', () => {
      expect(canIssueWaybill({ ...relocation, driverPersonId: null }).ok).toBe(false);
    });
  });
});

/**
 * Бланк рейса (`routeWaybillForm`). У грузового его выбирает тип машины, у перегона он всегда
 * 4-П: экскаватор идёт по дорогам как транспортное средство, и документ у этой поездки один.
 */
describe('бланк рейса', () => {
  const own = { ownership: 'own' as const };

  it('грузовой рейс печатается бланком своего типа', () => {
    expect(routeWaybillForm({ ...own, purpose: 'freight', formCode: '4p' }).formCode).toBe('4p');
    expect(routeWaybillForm({ ...own, purpose: 'freight', formCode: 'leg3' }).formCode).toBe(
      'leg3',
    );
  });

  it('перегон печатается 4-П, каким бы бланком ни печатался рейс типа', () => {
    for (const purpose of ['delivery', 'pickup'] as const) {
      expect(
        routeWaybillForm({ purpose, ownership: 'own', formCode: 'leg3' }),
      ).toEqual({ formCode: '4p', reason: null });
    }
  });

  it('на арендную технику лист выписывает арендодатель — и перегон её тоже его', () => {
    for (const purpose of ['freight', 'delivery'] as const) {
      const check = routeWaybillForm({
        purpose,
        ownership: 'rental',
        formCode: '4p',
      });
      expect(check.formCode).toBeNull();
      expect(check.reason).toContain('арендодатель');
    }
  });
});

/** Заявки в перегон не кладут: талоны заказчиков — про грузоперевозку. */
describe('состав перегона', () => {
  it('заявка в рейс перемещения не встаёт', () => {
    const check = canJoinRoute(goodRequest, { ...emptyRoute, purpose: 'delivery' });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('перегон');
  });
});

describe('груз в подписи рейса', () => {
  it('объём вперёд массы — тем же правилом, что печатает бланк', () => {
    expect(routeCargoLabel('12.000', '8.000')).toBe('12.000 м³');
    expect(routeCargoLabel(null, '8.000')).toBe('8.000 т');
    expect(routeCargoLabel(null, null)).toBe('');
  });
});

/**
 * Графа «заказчик, телефон» бланка 4-П: по строке на каждый конец маршрута. Строки не подписаны —
 * их порядок повторяет графы «откуда» и «куда» той же строки задания, — и обе обязаны уместиться
 * в графу, у которой по высоте ровно две строки.
 */
describe('контакты в графе задания', () => {
  it('строка на погрузку и строка на разгрузку, в порядке маршрута', () => {
    expect(
      routeContactsLabel([
        { name: 'Иванов Иван Иванович', phone: '9141234567' },
        { name: 'Петров Пётр Петрович', phone: '9147654321' },
      ]),
    ).toBe('Иванов И.И., +7 (914) 123 45 67\nПетров П.П., +7 (914) 765 43 21');
  });

  it('ФИО из трёх слов сокращается до инициалов — иначе строка не влезает в графу', () => {
    expect(
      routeContactsLabel([{ name: 'Кузнецова Анна Владимировна', phone: '9141112233' }]),
    ).toBe('Кузнецова А.В., +7 (914) 111 22 33');
  });

  it('запись не из трёх слов печатается как есть: разбирать её портал не берётся', () => {
    expect(routeContactsLabel([{ name: 'Иванов И.И.', phone: '9141112233' }])).toBe(
      'Иванов И.И., +7 (914) 111 22 33',
    );
    expect(
      routeContactsLabel([{ name: 'прораб Иванов Иван Иванович', phone: '9141112233' }]),
    ).toBe('прораб Иванов Иван Иванович, +7 (914) 111 22 33');
  });

  /*
   * Заявки старше миграции 0062 контакта не несут вовсе. Пустая строка в графе выглядела бы
   * потерянным номером — печатается только то, что известно, а нет ничего, так и графа пуста.
   */
  it('пустой контакт строки не занимает', () => {
    expect(
      routeContactsLabel([
        { name: '', phone: '' },
        { name: 'Петров Пётр Петрович', phone: '9147654321' },
      ]),
    ).toBe('Петров П.П., +7 (914) 765 43 21');
    expect(routeContactsLabel([{ name: '', phone: '' }])).toBe('');
  });

  it('телефон без имени печатается один: дозвониться по нему можно', () => {
    expect(routeContactsLabel([{ name: '', phone: '9147654321' }])).toBe('+7 (914) 765 43 21');
  });
});

/**
 * Задание рейсов 5–7 (ADR 0068): в бланке 4-П им отведены три нижние строки блока
 * «Дополнительное задание водителю» — по одной объединённой ячейке без граф внутри.
 */
describe('строка доп. задания', () => {
  const contacts = routeContactsLabel([
    { name: 'Иванов Иван Иванович', phone: '9141234567' },
    { name: 'Петров Пётр Петрович', phone: '9147654321' },
  ]);

  it('складывается порядком граф таблицы выше: откуда, куда, груз, контакты', () => {
    expect(
      routeExtraTaskLine({
        from: 'Зимняя, 666',
        to: 'Лётная, 555',
        cargo: '10 м³',
        contacts,
      }),
    ).toBe(
      'Зимняя, 666 → Лётная, 555, 10 м³, Иванов И.И., +7 (914) 123 45 67; Петров П.П., +7 (914) 765 43 21',
    );
  });

  /*
   * Контакты приходят двумя строками — так их печатает графа «заказчик, телефон» четырёх верхних
   * строк. Здесь строка одна на всё задание и высотой в две: перенос внутри контактов вытеснил бы
   * с бумаги вторую половину задания.
   */
  it('контакты сводятся в одну строку: переносов внутри задания быть не должно', () => {
    expect(routeExtraTaskLine({ from: 'А', to: 'Б', cargo: '', contacts })).not.toContain('\n');
  });

  it('пустой рейс даёт пустую строку — ни стрелки, ни запятых', () => {
    expect(routeExtraTaskLine({ from: '', to: '', cargo: '', contacts: '' })).toBe('');
  });

  /*
   * Заявка без части граф — обычное дело: груз не всегда заведён, контакта у заявок старше
   * миграции 0062 нет вовсе. Разделители пропадают вместе со значением, иначе строка приезжает на
   * бумагу с осиротевшими запятыми.
   */
  it('пропущенная графа не оставляет разделителя', () => {
    expect(routeExtraTaskLine({ from: 'Зимняя, 666', to: '', cargo: '', contacts: '' })).toBe(
      'Зимняя, 666',
    );
    expect(
      routeExtraTaskLine({ from: 'Зимняя, 666', to: 'Лётная, 555', cargo: '', contacts: '' }),
    ).toBe('Зимняя, 666 → Лётная, 555');
  });
});

describe('схемы маршрута', () => {
  it('реквизиты прицепа без прицепа в рейсе не принимаются', () => {
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: true, trailer1Model: 'МАЗ' }).success,
    ).toBe(true);
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: false, trailer1Model: 'МАЗ' }).success,
    ).toBe(false);
  });

  it('порядок присылается полным списком без повторов и не длиннее бланка', () => {
    expect(routeOrderSchema.safeParse({ requestIds: [UUID_A, UUID_B], version: 3 }).success).toBe(
      true,
    );
    expect(routeOrderSchema.safeParse({ requestIds: [UUID_A, UUID_A], version: 3 }).success).toBe(
      false,
    );
    expect(
      routeOrderSchema.safeParse({
        requestIds: [UUID_A, UUID_B, UUID_C, UUID_A, UUID_B],
        version: 3,
      }).success,
    ).toBe(false);
  });

  it('перенос опознаёт исходный маршрут парой «кто + версия»', () => {
    const moved = attachRouteRequestSchema.safeParse({
      requestId: UUID_A,
      version: 2,
      source: { routeId: UUID_B, version: 7 },
    });
    expect(moved.success).toBe(true);
    // Одной версии мало: она нумеруется в каждом маршруте отдельно и совпала бы случайно.
    expect(
      attachRouteRequestSchema.safeParse({ requestId: UUID_A, version: 2, source: { version: 7 } })
        .success,
    ).toBe(false);
  });

  it('заявка едет либо в существующий рейс, либо в новый — но не в оба сразу', () => {
    expect(assignRouteSchema.safeParse({ routeId: UUID_A }).success).toBe(true);
    expect(assignRouteSchema.safeParse({ newRoute: { driverPersonId: UUID_B } }).success).toBe(
      true,
    );
    expect(assignRouteSchema.safeParse({ newRoute: {} }).success).toBe(true);
    expect(
      assignRouteSchema.safeParse({ routeId: UUID_A, newRoute: { driverPersonId: UUID_B } })
        .success,
    ).toBe(false);
    expect(assignRouteSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * Тело перевода заявки в работу (Р3, Р22): рейс приходит вместе с назначением, а прежние поля —
 * водитель и графы бланка — принимаются, пока живо старое тело запроса.
 */
describe('назначение с маршрутом', () => {
  const base = { vehicleId: UUID_A };

  it('принимает существующий рейс и новый', () => {
    expect(assignVehicleSchema.safeParse({ ...base, route: { routeId: UUID_B } }).success).toBe(
      true,
    );
    expect(
      assignVehicleSchema.safeParse({
        ...base,
        route: { newRoute: { driverPersonId: UUID_C, trip: { garageNumber: '00000389' } } },
      }).success,
    ).toBe(true);
  });

  it('старого тела больше нет: водитель и графы бланка описывают рейс, а не назначение', () => {
    // Схема strict: поля, отменённые contract-релизом, теперь отклоняются, а не игнорируются
    // молча — иначе клиент, отставший на версию, думал бы, что назначил водителя.
    const parsed = assignVehicleSchema.safeParse({
      ...base,
      driverPersonId: UUID_C,
      waybill: { withTrailer: false, garageNumber: '00000389' },
    });
    expect(parsed.success).toBe(false);
  });

  it('назначение без рейса проходит схему: рейс обязателен не всегда, и решает это сервер', () => {
    // Аренда и заказ техники на объект рейса не знают вовсе — отказ на уровне схемы отсёк бы их.
    expect(assignVehicleSchema.safeParse(base).success).toBe(true);
  });
});
