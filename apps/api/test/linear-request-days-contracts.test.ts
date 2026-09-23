import { describe, expect, it } from 'vitest';
import {
  canPlanDay,
  dayAlreadyPlannedMessage,
  linearDaysBlocker,
  linearDaysOf,
  linearRouteJoinDay,
  type LinearDaySubject,
  planDayBlocker,
  type PlannedVehicleRequestDay,
  planVehicleRequestDaySchema,
} from '@technic/contracts';

/**
 * Дни заказа техники на объект (ADR 0100, дверь открыта всем заказам решением ADR 0207): правила
 * здесь чистые — их зовут и портал, и сервер.
 *
 * Проверяется ровно то, ради чего они вынесены в контракты: портал обязан не предлагать того, что
 * сервер отклонит, и объяснять недоступное **теми же словами**. Второе — перечень дней: он
 * выводится из срока, а не хранится, и день, оставшийся за сокращённым сроком в замороженном
 * рейсе, обязан быть виден, а не исчезнуть из таблицы.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

/**
 * Заказ в работе на собственной машине — от него отталкиваются проверки «чего не так». Линейным он
 * оставлен не ради правила (доступность дней им больше не решается, ADR 0207 п. 1), а ради того,
 * чтобы снятие замка проверялось на обоих значениях признака от одной и той же заявки.
 */
const linear: LinearDaySubject = {
  requestType: 'special_equipment',
  isLinear: true,
  status: 'confirmed',
  deletedAt: null,
  dateFrom: '2026-08-03',
  dateTo: '2026-08-06',
  ownership: 'own',
};

describe('по какой заявке вообще ведут дни', () => {
  it('линейный заказ в работе на своей технике — ведут', () => {
    expect(linearDaysBlocker(linear)).toBeNull();
  });

  it('у грузоперевозки дней нет: там рейс и есть сама работа', () => {
    const blocker = linearDaysBlocker({ ...linear, requestType: 'freight_transport' });
    expect(blocker).toContain('грузоперевозки');
  });

  /*
   * Здесь стояло обратное утверждение: нелинейному заказу дни не ведут, и блокер обязан был
   * ответить «ведётся неделями стояния на площадке» — дни были привилегией линейного типа ТС
   * (ADR 0100 решение 1).
   *
   * Утверждение снято решением заказчика, а не подогнано под код: ADR 0207 п. 1 отменил саму
   * привилегию — 4-П за день просят и у машины, которая неделю стоит на площадке (выезд за
   * топливом, возврат в гараж), и отказ по типу техники означал бы «такой бумаги не бывает» там,
   * где её всё равно выписывают мимо портала. Цена названа в п. 2 решения: недельный ЭСМ-2 у
   * такого заказа продолжает выписываться сам, и бумаги за день бывает две.
   *
   * Проверяется теперь то, ради чего замок снимали: дверь дней воротят состояние заявки и её
   * машина, а признак типа — нет. Оба значения `isLinear` здесь обязательны: односторонняя
   * проверка «нелинейному разрешено» пережила бы возврат развилки наизнанку, а утверждение в
   * том и состоит, что развилки по типу больше нет.
   */
  it('линейность доступность дней не решает: ответ один при обоих значениях признака', () => {
    expect(linearDaysBlocker({ ...linear, isLinear: false })).toBeNull();
    expect(linearDaysBlocker({ ...linear, isLinear: true })).toBeNull();
  });

  /*
   * Остальные запреты снятие линейности не тронуло, и проверки ниже стерегут именно это: заказ на
   * объект получает дни, только пока он в работе, на своей живой технике и со сроком. Снятый замок
   * не должен был открыть дверь заодно арендной машине и архиву.
   */

  it('заявка не в работе — статус назван в отказе', () => {
    expect(linearDaysBlocker({ ...linear, status: 'new' })).toContain('Новая');
    expect(linearDaysBlocker({ ...linear, deletedAt: '2026-08-01T10:00:00Z' })).toBe(
      'Заявка в архиве',
    );
  });

  /*
   * Машина назначения — машина дня по умолчанию (ADR 0100 §4), и без неё непонятно даже, чем
   * заявку взяли в работу. Арендная в рейсы не ходит вовсе: лист на неё выписывает арендодатель, и
   * блок дней у такой заявки обязан показать причину, а не пустую таблицу (план У14).
   */
  it('без техники и на арендной технике дни не планируют — причины разные', () => {
    expect(linearDaysBlocker({ ...linear, ownership: null })).toContain('не назначена техника');
    expect(linearDaysBlocker({ ...linear, ownership: 'rental' })).toContain('арендодатель');
  });

  it('без срока работ дней у заказа нет', () => {
    expect(linearDaysBlocker({ ...linear, dateFrom: undefined })).toContain('срок работ');
  });
});

describe('какой день можно распланировать', () => {
  it('день внутри срока и ещё не занятый', () => {
    expect(planDayBlocker(linear, '2026-08-04', [])).toBeNull();
    expect(canPlanDay(linear, '2026-08-04', [])).toBe(true);
  });

  it('общий запрет сильнее подённого: он и читается первым', () => {
    expect(planDayBlocker({ ...linear, status: 'cancelled' }, '2026-08-04', [])).toContain(
      'Отменена',
    );
  });

  // Те же слова, что у смен (`shiftDayBlocker`): день у них общий, и два разных объяснения одной
  // границы читались бы как две разные границы.
  it('день вне срока — теми же словами, что и у смен', () => {
    expect(planDayBlocker(linear, '2026-08-02', [])).toBe('День вне срока заявки');
    expect(planDayBlocker(linear, '2026-08-07', [])).toBe('День вне срока заявки');
  });

  it('уже распланированный день — текстом, общим с правилом рейса', () => {
    expect(planDayBlocker(linear, '2026-08-04', ['2026-08-04'])).toBe(
      dayAlreadyPlannedMessage('2026-08-04'),
    );
  });

  /*
   * Прошедший день планируется наравне с будущим — и это не послабление: бумагу оформляют задним
   * числом, а запрет отправил бы такой выезд мимо портала. У смен запрет обратный (подпись под
   * будущим днём ничего не значит), и совпадать эти правила не обязаны.
   */
  it('прошлое и будущее внутри срока равноправны', () => {
    expect(canPlanDay(linear, '2026-08-03', [])).toBe(true);
    expect(canPlanDay(linear, '2026-08-06', [])).toBe(true);
  });
});

describe('перечень дней заказа', () => {
  const planned: PlannedVehicleRequestDay = {
    date: '2026-08-04',
    route: {
      id: UUID,
      displayNumber: 'Р-12',
      position: 1,
      vehicleId: UUID,
      vehicleLabel: 'Автовышка · Е646СК799',
      driverPersonId: null,
      driverName: '',
      waybill: null,
      version: 0,
    },
    shift: null,
    otherVehicle: false,
  };

  it('дни считаются из срока, а не из плана: пустой день это строка таблицы', () => {
    const days = linearDaysOf(linear, [planned]);
    expect(days.map((d) => d.date)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
    expect(days[0]!.route).toBeNull();
    expect(days[1]!.route?.displayNumber).toBe('Р-12');
    expect(days.every((d) => !d.outOfTerm)).toBe(true);
  });

  /*
   * Срок сократили, а рейс дня заморожен выписанным листом и день не отдал (ADR 0100 §11). Прятать
   * такой день нельзя: бумага на него уже у водителя, и человек должен видеть, что именно осталось
   * за сроком.
   */
  it('день за сроком остаётся в таблице с пометкой', () => {
    const shortened = { ...linear, dateTo: '2026-08-03' };
    const days = linearDaysOf(shortened, [planned]);
    expect(days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-04']);
    expect(days[1]!.outOfTerm).toBe(true);
  });

  it('однодневный срок — один день; заявка без срока дней не имеет', () => {
    expect(linearDaysOf({ dateFrom: '2026-08-03', dateTo: null }, [])).toHaveLength(1);
    expect(linearDaysOf({ dateFrom: undefined, dateTo: null }, [])).toEqual([]);
  });

  it('ответ заявки правилу рейса — отрезок срока и занятые дни, а не день', () => {
    expect(linearRouteJoinDay(linear, ['2026-08-04'])).toEqual({
      kind: 'linear',
      dateFrom: '2026-08-03',
      dateTo: '2026-08-06',
      plannedDays: ['2026-08-04'],
    });
  });
});

describe('тело запроса «поставить день в рейс»', () => {
  it('либо существующий рейс, либо новый — но не оба сразу', () => {
    expect(planVehicleRequestDaySchema.safeParse({ routeId: UUID }).success).toBe(true);
    expect(planVehicleRequestDaySchema.safeParse({ newRoute: { vehicleId: UUID } }).success).toBe(
      true,
    );
    expect(
      planVehicleRequestDaySchema.safeParse({ routeId: UUID, newRoute: { vehicleId: UUID } })
        .success,
    ).toBe(false);
  });

  /*
   * Машина у нового рейса обязательна: у линейного заказа назначение — машина по умолчанию, а на
   * разные дни выходят разные единицы (ADR 0100 §4). Водитель — нет: рейс собирают заранее,
   * человека ставят утром, и подставлять вчерашнего портал не вправе (ADR 0083).
   */
  it('машина обязательна, водитель — нет', () => {
    expect(planVehicleRequestDaySchema.safeParse({ newRoute: {} }).success).toBe(false);
    expect(
      planVehicleRequestDaySchema.safeParse({
        newRoute: { vehicleId: UUID, driverPersonId: null },
      }).success,
    ).toBe(true);
  });

  it('дата в теле не передаётся: день — часть адреса', () => {
    expect(
      planVehicleRequestDaySchema.safeParse({ routeId: UUID, date: '2026-08-04' }).success,
    ).toBe(false);
  });
});
