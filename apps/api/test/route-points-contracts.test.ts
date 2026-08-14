import { describe, expect, it } from 'vitest';
import {
  type AddressMeta,
  type FreightAction,
  type VehicleRoutePointDto,
  addressKeyOf,
  brokenTripOrder,
  contactKeyOf,
  pointOrderSchema,
  routePointSchema,
  sameRouteAddress,
  samePointIdentity,
  splitPointSchema,
  suggestPointMerges,
} from '@technic/contracts';

/**
 * Тождество точки маршрута и инвариант порядка (план `docs/route-trips-plan.md`, Р6, Р8, Р9, Р9а).
 *
 * Правила здесь чистые: их зовёт и автосборка на сервере, и карточка маршрута в браузере, и
 * разойтись им нельзя — портал предложил бы совместить то, что сервер оставит двумя точками.
 *
 * Цена ошибки несимметрична, и тесты написаны с этой стороны. Лишний заезд диспетчер уберёт сам
 * (Р9а: «совместить» — явное действие). А вот молча склеенные точки надо сначала **заметить**:
 * машина приедет один раз туда, где её ждут в двух местах.
 */

const meta = (m: Partial<AddressMeta>): AddressMeta => ({ source: 'resolved', ...m });

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('тождество адреса', () => {
  it('запись справочника решает раньше ФИАС и раньше строки', () => {
    const byRef = {
      location: 'ЖК Северный, к. 3',
      address: meta({ source: 'object', refId: UUID_A }),
    };
    const sameRefOtherText = {
      location: 'Московская обл., ЖК «Северный», корпус 3',
      address: meta({ source: 'object', refId: UUID_A, fiasId: 'fias-1' }),
    };

    expect(addressKeyOf(byRef)).toBe(`ref:${UUID_A}`);
    expect(sameRouteAddress(byRef, sameRefOtherText)).toBe(true);
  });

  it('ФИАС решает раньше строки', () => {
    const a = { location: 'Волоколамское ш., 12', address: meta({ fiasId: 'fias-1' }) };
    const b = { location: 'ш. Волоколамское, д. 12', address: meta({ fiasId: 'fias-1' }) };

    expect(sameRouteAddress(a, b)).toBe(true);
  });

  /**
   * Легаси-адрес сравнивать больше нечем — только строкой. Регистр, лишние пробелы и «ё» —
   * оформление: «Сычёво» и «Сычево» набирают оба, и без сведения одна площадка развалилась бы на
   * два заезда.
   */
  it('легаси-адрес сводится строкой: регистр, пробелы и «ё» — оформление', () => {
    const a = { location: 'Карьер Сычёво', address: null };
    const b = { location: '  карьер   Сычево ', address: null };

    expect(sameRouteAddress(a, b)).toBe(true);
  });

  it('разные записи справочника — разные места, даже при одинаковом тексте', () => {
    const a = { location: 'Склад', address: meta({ source: 'warehouse', refId: UUID_A }) };
    const b = { location: 'Склад', address: meta({ source: 'warehouse', refId: UUID_B }) };

    expect(sameRouteAddress(a, b)).toBe(false);
  });
});

describe('ключ ответственного', () => {
  it('десять цифр и одиннадцать с 7 или 8 дают один ключ', () => {
    expect(contactKeyOf('+7 916 123-45-67')).toBe('tel:9161234567');
    expect(contactKeyOf('89161234567')).toBe('tel:9161234567');
    expect(contactKeyOf('9161234567')).toBe('tel:9161234567');
  });

  /**
   * Три состояния, а не два (Р9). Номер, который `normalizePhone` не сводит, — это **не** «телефона
   * нет», а другой телефон: миграция `0095` такие записи не трогала (ADR 0066 п. 7). Свести их к
   * пустому значило бы объявить двух разных ответственных одним.
   */
  it('несводимый номер получает свой ключ, а не пустой', () => {
    const withExtension = contactKeyOf('8 (495) 123-45-67 доб. 12');
    const otherExtension = contactKeyOf('8 (495) 123-45-67 доб. 14');
    const twoNumbers = contactKeyOf('+7 916 123-45-67, +7 903 765-43-21');

    expect(withExtension).toMatch(/^raw:/);
    expect(otherExtension).toMatch(/^raw:/);
    expect(withExtension).not.toBe(otherExtension);
    expect(twoNumbers).toMatch(/^raw:/);
    expect(twoNumbers).not.toBe(withExtension);
  });

  it('пусто — ключа нет вовсе', () => {
    expect(contactKeyOf('')).toBeNull();
    expect(contactKeyOf('   ')).toBeNull();
  });
});

describe('тождество точки', () => {
  const carrier = { location: 'Карьер Сычёво', address: meta({ fiasId: 'fias-carrier' }) };

  it('один адрес и разные телефоны — разные точки', () => {
    expect(
      samePointIdentity(
        { ...carrier, contacts: [{ phone: '+7 916 123-45-67' }] },
        { ...carrier, contacts: [{ phone: '+7 903 765-43-21' }] },
      ),
    ).toBe(false);
  });

  it('один телефон в разных написаниях — одна точка', () => {
    expect(
      samePointIdentity(
        { ...carrier, contacts: [{ phone: '+7 916 123-45-67' }] },
        { ...carrier, contacts: [{ phone: '8 916 123 45 67' }] },
      ),
    ).toBe(true);
  });

  /**
   * Порядок контактов на тождество не влияет: множество канонизируется. Иначе две одинаковые точки
   * то склеивались бы, то нет — в зависимости от того, как строки вернул SQL.
   */
  it('порядок контактов не влияет', () => {
    const two = [{ phone: '+7 916 123-45-67' }, { phone: '+7 903 765-43-21' }];

    expect(
      samePointIdentity(
        { ...carrier, contacts: two },
        { ...carrier, contacts: [...two].reverse() },
      ),
    ).toBe(true);
  });

  it('повтор одного телефона тождества не меняет', () => {
    expect(
      samePointIdentity(
        { ...carrier, contacts: [{ phone: '+7 916 123-45-67' }] },
        {
          ...carrier,
          contacts: [{ phone: '+7 916 123-45-67' }, { phone: '89161234567' }],
        },
      ),
    ).toBe(true);
  });

  it('контакт без номера тождества не меняет: сравнивать нечем', () => {
    expect(
      samePointIdentity(
        { ...carrier, contacts: [{ phone: '+7 916 123-45-67' }] },
        { ...carrier, contacts: [{ phone: '+7 916 123-45-67' }, { phone: '' }] },
      ),
    ).toBe(true);
  });

  /**
   * Ключ упакован JSON-ом, а не склеен разделителем, — и это ловится ровно здесь: у `raw:`-ключа
   * внутри произвольный текст, и склейка сделала бы два ключа «12345» и «678901» неотличимыми от
   * одного легаси-номера, в котором записаны оба.
   */
  it('два легаси-номера не сливаются с одним, где записаны оба', () => {
    expect(
      samePointIdentity(
        { ...carrier, contacts: [{ phone: '12345' }, { phone: '678901' }] },
        { ...carrier, contacts: [{ phone: '12345,raw:678901' }] },
      ),
    ).toBe(false);
  });
});

const point = (
  id: string,
  position: number,
  location: string,
  address: AddressMeta | null,
  contacts: { name: string; phone: string }[],
  actions: FreightAction[] = [],
): VehicleRoutePointDto => ({
  id,
  position,
  location,
  address,
  arrivalTime: '',
  comment: '',
  actions,
  contacts,
});

describe('подсказки совмещения', () => {
  const ivanov = [{ name: 'Иванов И.И.', phone: '+7 916 123-45-67' }];
  const petrov = [{ name: 'Петров П.П.', phone: '+7 903 765-43-21' }];

  it('точки одного адреса с одним ответственным — полное тождество', () => {
    const suggestions = suggestPointMerges([
      point('p1', 1, 'Карьер Сычёво', meta({ fiasId: 'f1' }), ivanov),
      point('p2', 4, 'Карьер Сычёво', meta({ fiasId: 'f1' }), ivanov),
    ]);

    expect(suggestions).toEqual([{ pointIds: ['p1', 'p2'], sameContacts: true }]);
  });

  /**
   * Разные ответственные совмещению не помеха (Р9а) — но человек обязан узнать, что в лист пойдут
   * оба. Различает эти два случая признак `sameContacts`, и на нём же стоит оговорка в подсказке.
   */
  it('тот же адрес с разными ответственными предлагается с оговоркой', () => {
    const suggestions = suggestPointMerges([
      point('p1', 1, 'ЖК Северный', meta({ source: 'object', refId: UUID_A }), ivanov),
      point('p2', 2, 'ЖК Северный', meta({ source: 'object', refId: UUID_A }), petrov),
    ]);

    expect(suggestions).toEqual([{ pointIds: ['p1', 'p2'], sameContacts: false }]);
  });

  it('три заезда в один карьер — одно предложение, а не три попарных', () => {
    const suggestions = suggestPointMerges([
      point('p3', 5, 'Карьер', meta({ fiasId: 'f1' }), ivanov),
      point('p1', 1, 'Карьер', meta({ fiasId: 'f1' }), ivanov),
      point('p2', 3, 'Карьер', meta({ fiasId: 'f1' }), ivanov),
    ]);

    expect(suggestions).toHaveLength(1);
    // Первый в списке — цель совмещения: роли переезжают в самую раннюю точку (§7 плана).
    expect(suggestions[0]!.pointIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('разные адреса не предлагаются', () => {
    expect(
      suggestPointMerges([
        point('p1', 1, 'Карьер', meta({ fiasId: 'f1' }), ivanov),
        point('p2', 2, 'ЖК Северный', meta({ fiasId: 'f2' }), ivanov),
      ]),
    ).toEqual([]);
  });
});

describe('инвариант «погрузка раньше разгрузки»', () => {
  const trip = (
    role: 'load' | 'unload',
    requestNum: number,
    tripNum: number,
    pairPosition: number,
  ): FreightAction => ({
    kind: 'freight',
    ref: {
      kind: 'freight',
      requestId: `req-${requestNum}`,
      tripId: `trip-${requestNum}-${tripNum}`,
    },
    role,
    cargoLabel: '10 м³',
    pairPosition,
    displayNumber: `ТС-${requestNum}/${tripNum}`,
    requestNum,
    tripNum,
    customerName: 'ЖК Северный',
    contactName: 'Иванов И.И.',
    contactPhone: '+7 916 123-45-67',
    addressMismatch: false,
  });

  const at = (position: number, actions: FreightAction[]): VehicleRoutePointDto =>
    point(
      `p${position}`,
      position,
      `Точка ${position}`,
      meta({ fiasId: `f${position}` }),
      [],
      actions,
    );

  it('правильный порядок нарушений не даёт', () => {
    expect(
      brokenTripOrder([at(1, [trip('load', 40, 1, 2)]), at(2, [trip('unload', 40, 1, 1)])]),
    ).toEqual([]);
  });

  it('разгрузка раньше погрузки — находится и называет ездку', () => {
    const broken = brokenTripOrder([
      at(1, [trip('unload', 40, 2, 2)]),
      at(2, [trip('load', 40, 2, 1)]),
    ]);

    expect(broken).toEqual([{ kind: 'freight', requestId: 'req-40', tripId: 'trip-40-2' }]);
  });

  /**
   * Совпадение позиций — тоже нарушение: между погрузкой и разгрузкой груз в кузове, и «выгрузили
   * там же, где грузили» описывает ездку, которой не было. Р6 требует **строго** меньше.
   */
  it('обе роли на одной точке — нарушение', () => {
    expect(
      brokenTripOrder([at(1, [trip('load', 40, 1, 1), trip('unload', 40, 1, 1)])]),
    ).toHaveLength(1);
  });

  /**
   * Ездка с одним найденным концом — это не нарушение порядка, а неразложенная строка: у неё свой
   * отказ (`rows_unplaced`), и путать их нельзя — чинятся они в разных местах.
   */
  it('ездка с одним концом нарушением порядка не считается', () => {
    expect(brokenTripOrder([at(1, [trip('load', 40, 1, 0)])])).toEqual([]);
  });

  it('нарушения перечисляются по номерам заявки и ездки', () => {
    const broken = brokenTripOrder([
      at(1, [trip('unload', 41, 1, 4), trip('unload', 40, 2, 3)]),
      at(2, [trip('load', 40, 2, 1)]),
      at(3, [trip('load', 41, 1, 1)]),
    ]);

    expect(broken.map((ref) => (ref.kind === 'freight' ? ref.tripId : ref.workDate))).toEqual([
      'trip-40-2',
      'trip-41-1',
    ]);
  });
});

describe('схемы точек', () => {
  const validPoint = {
    location: 'Карьер Сычёво, Волоколамское ш.',
    address: { source: 'resolved', fiasId: 'fias-1' },
    roles: [{ kind: 'freight', requestId: UUID_A, tripId: UUID_B, role: 'load' }],
    version: 3,
  };

  it('точка без задания не заводится', () => {
    expect(routePointSchema.safeParse({ ...validPoint, roles: [] }).success).toBe(false);
  });

  /**
   * Адрес точки печатается в бланк (Р11б), поэтому на запись он требуется верифицированным — той же
   * жёсткой моделью, что и адрес заявки (ADR 0006). Снимок легаси-адреса в базе при этом остаётся:
   * модель действует на запись, а не на чтение.
   */
  it('непроверенный адрес точки на запись не проходит', () => {
    expect(
      routePointSchema.safeParse({ ...validPoint, address: { source: 'manual' } }).success,
    ).toBe(false);
  });

  it('одна и та же роль дважды — отказ', () => {
    expect(
      routePointSchema.safeParse({
        ...validPoint,
        roles: [validPoint.roles[0], validPoint.roles[0]],
      }).success,
    ).toBe(false);
  });

  /** У линейной роли поля `role` нет вовсе: она всегда `work`, и присылать сочетание нечем. */
  it('линейная роль не принимает поля role', () => {
    expect(
      routePointSchema.safeParse({
        ...validPoint,
        roles: [{ kind: 'linear', requestId: UUID_A, workDate: '2026-08-12', role: 'load' }],
      }).success,
    ).toBe(false);
  });

  it('время прибытия — пусто либо ЧЧ:ММ', () => {
    expect(routePointSchema.safeParse({ ...validPoint, arrivalTime: '08:30' }).success).toBe(true);
    expect(routePointSchema.safeParse({ ...validPoint, arrivalTime: '' }).success).toBe(true);
    expect(routePointSchema.safeParse({ ...validPoint, arrivalTime: '8-30' }).success).toBe(false);
  });

  it('перестановка не принимает точку дважды', () => {
    expect(pointOrderSchema.safeParse({ pointIds: [UUID_A, UUID_A], version: 1 }).success).toBe(
      false,
    );
    expect(pointOrderSchema.safeParse({ pointIds: [UUID_A, UUID_B], version: 1 }).success).toBe(
      true,
    );
  });

  it('разнесение требует сказать, что уходит в новую точку', () => {
    expect(splitPointSchema.safeParse({ roles: [], version: 1 }).success).toBe(false);
  });
});
