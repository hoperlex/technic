import { describe, expect, it } from 'vitest';
import {
  assignRouteSchema,
  assignVehicleSchema,
  attachRouteRequestSchema,
  canIssueWaybill,
  canJoinRoute,
  formatVehicleRouteNumber,
  isRouteEditable,
  MAX_ROUTE_REQUESTS,
  parseVehicleRouteNumberSearch,
  routeCargoLabel,
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

const emptyRoute = { routeDate: '2026-08-03', requestCount: 0, purpose: 'freight' as const };

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

  it('пятая заявка не добавляется — в бланке четыре талона', () => {
    const full = {
      routeDate: '2026-08-03',
      requestCount: MAX_ROUTE_REQUESTS,
      purpose: 'freight' as const,
    };
    const check = canJoinRoute(goodRequest, full);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('второй маршрут');
    expect(canJoinRoute(goodRequest, { ...full, requestCount: MAX_ROUTE_REQUESTS - 1 })).toEqual({
      ok: true,
    });
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
  const own = { ownership: 'own' as const, typeName: 'Самосвалы' };

  it('грузовой рейс печатается бланком своего типа', () => {
    expect(routeWaybillForm({ ...own, purpose: 'freight', formCode: '4p' }).formCode).toBe('4p');
    expect(
      routeWaybillForm({ ...own, purpose: 'freight', formCode: 'leg3', typeName: 'Легковые' })
        .formCode,
    ).toBe('leg3');
  });

  it('тип без бланка объясняет себя словами — это поправимое состояние справочника', () => {
    const check = routeWaybillForm({
      purpose: 'freight',
      ownership: 'own',
      formCode: null,
      typeName: 'Экскаваторы гусеничные',
    });
    expect(check.formCode).toBeNull();
    expect(check.reason).toContain('Экскаваторы гусеничные');
  });

  it('перегон печатается 4-П даже у типа без бланка: по дорогам едет транспортное средство', () => {
    for (const purpose of ['delivery', 'pickup'] as const) {
      expect(
        routeWaybillForm({
          purpose,
          ownership: 'own',
          formCode: null,
          typeName: 'Экскаваторы-погрузчики',
        }),
      ).toEqual({ formCode: '4p', reason: null });
    }
  });

  it('на арендную технику лист выписывает арендодатель — и перегон её тоже его', () => {
    for (const purpose of ['freight', 'delivery'] as const) {
      const check = routeWaybillForm({
        purpose,
        ownership: 'rental',
        formCode: '4p',
        typeName: 'Самосвалы',
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
