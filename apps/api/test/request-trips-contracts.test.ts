import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTE_REQUESTS,
  type VehicleRequestTripDto,
  requestCargoTotal,
  requestTripSchema,
  requestTripsSchema,
  tripCargoLabel,
} from '@technic/contracts';

/**
 * Ездки заявки (план `docs/route-trips-plan.md`, Р1–Р3, Р13а).
 *
 * Ездка — строка заявки: своя пара адресов, своё количество, свои контакты. Отсюда и то, что здесь
 * проверяется: подпись груза одна на портал и на бумагу (разойдясь в единицах, карточка и лист
 * заспорят о том, что везли), итог складывается по шкале хранения, а схема не принимает того, что
 * назначает сервер.
 */

const trip = (over: Partial<VehicleRequestTripDto> = {}): VehicleRequestTripDto => ({
  id: 'trip-1',
  num: 1,
  displayNumber: 'ТС-40/1',
  fromLocation: 'Карьер Сычёво',
  toLocation: 'ЖК Северный, к. 3',
  fromAddress: null,
  toAddress: null,
  volumeM3: 10,
  weightTons: null,
  fromResponsibleName: 'Иванов И.И.',
  fromResponsiblePhone: '+7 916 123-45-67',
  toResponsibleName: 'Петров П.П.',
  toResponsiblePhone: '+7 903 765-43-21',
  scheduledAt: null,
  comment: '',
  placement: null,
  ...over,
});

describe('подпись груза ездки', () => {
  it('объём печатается вперёд массы, а пустое количество даёт пустую подпись', () => {
    expect(tripCargoLabel({ volumeM3: 12, weightTons: null })).toBe('12 м³');
    expect(tripCargoLabel({ volumeM3: null, weightTons: 8 })).toBe('8 т');
    expect(tripCargoLabel({ volumeM3: null, weightTons: null })).toBe('');
  });
});

describe('итог по заявке', () => {
  it('шесть ездок с карьера складываются в один объём', () => {
    const trips = Array.from({ length: 6 }, (_, i) => trip({ id: `t${i}`, num: i + 1 }));

    expect(requestCargoTotal(trips)).toEqual({ volumeM3: 60, weightTons: null, trips: 6 });
  });

  /**
   * Количество хранится как `numeric(12,3)`, и складывать такие числа как есть нельзя: в двоичной
   * плавающей точке `0.1 + 0.2` даёт `0.30000000000000004`, и на шести ездках итог показал бы хвост
   * из нулей там, где человек ждёт «60 м³».
   */
  it('сумма приводится к шкале хранения, а не тянет двоичный хвост', () => {
    const total = requestCargoTotal([
      trip({ id: 'a', volumeM3: 0.1 }),
      trip({ id: 'b', volumeM3: 0.2 }),
    ]);

    expect(total.volumeM3).toBe(0.3);
  });

  /**
   * `null`, а не ноль: ноль на месте «количества нет» был бы утверждением «везём нисколько», а у
   * легкового груза не бывает вовсе (`isCargoAmountRequired('leg3') === false`).
   */
  it('количества нет ни у одной ездки — итог null, а не ноль', () => {
    expect(requestCargoTotal([trip({ volumeM3: null })])).toEqual({
      volumeM3: null,
      weightTons: null,
      trips: 1,
    });
  });

  it('смешанная заявка даёт двойной итог', () => {
    const total = requestCargoTotal([
      trip({ id: 'a', volumeM3: 10, weightTons: null }),
      trip({ id: 'b', volumeM3: null, weightTons: 8 }),
    ]);

    expect(total).toEqual({ volumeM3: 10, weightTons: 8, trips: 2 });
  });
});

describe('схема ездки', () => {
  const valid = {
    fromLocation: 'Карьер Сычёво, Волоколамское ш.',
    toLocation: 'ЖК Северный, к. 3',
    fromAddress: { source: 'resolved', fiasId: 'fias-1' },
    toAddress: { source: 'object', refId: '11111111-1111-4111-8111-111111111111' },
    volumeM3: 10,
    fromResponsibleName: 'Иванов И.И.',
    fromResponsiblePhone: '+7 916 123-45-67',
    toResponsibleName: 'Петров П.П.',
    toResponsiblePhone: '+7 903 765-43-21',
  };

  it('обычная ездка проходит, и комментарий дефолтится пустым', () => {
    const parsed = requestTripSchema.parse(valid);

    expect(parsed.comment).toBe('');
    expect(parsed.fromResponsiblePhone).toBe('9161234567');
  });

  /**
   * Жёсткая модель адреса (ADR 0006): адрес выбирают из подсказок DaData либо из справочника.
   * Свободный ввод на запись не проходит — ни у заявки, ни у ездки, которая её заменяет.
   */
  it('непроверенный адрес не проходит', () => {
    expect(
      requestTripSchema.safeParse({ ...valid, fromAddress: { source: 'manual' } }).success,
    ).toBe(false);
  });

  it('адрес без метаданных не проходит: они ходят парой', () => {
    const { fromAddress: _dropped, ...withoutMeta } = valid;

    expect(requestTripSchema.safeParse(withoutMeta).success).toBe(false);
  });

  /**
   * Номер ездки назначает сервер. Принять его от клиента значило бы отдать наружу правило «номер не
   * переиспользуется» (Р13а): форма, не знающая про мягко удалённые ездки, честно прислала бы «2»
   * на место снесённой второй — и «ТС-40/2» в выданном листе перестал бы означать ту ездку, что
   * напечатана.
   */
  it('номер ездки от клиента не принимается', () => {
    expect(requestTripSchema.safeParse({ ...valid, num: 2 }).success).toBe(false);
  });

  it('контакты обязательны на обоих концах', () => {
    expect(requestTripSchema.safeParse({ ...valid, toResponsiblePhone: '' }).success).toBe(false);
    expect(requestTripSchema.safeParse({ ...valid, toResponsibleName: '' }).success).toBe(false);
  });

  /**
   * CHECK «объём или масса» не ставится ни в схеме, ни в базе: нужен ли груз, зависит от бланка
   * заказанного типа ТС, а бланк живёт в справочнике — схеме его взять неоткуда. Обязательность
   * остаётся условной и серверной (`assertCargoAmount`), как она задумана для заявки.
   */
  it('ездка без количества схемой не отклоняется — это решает сервер по бланку', () => {
    const { volumeM3: _dropped, ...withoutAmount } = valid;

    expect(requestTripSchema.safeParse(withoutAmount).success).toBe(true);
  });

  it('количество точнее трёх знаков не проходит: в базе `numeric(12,3)`', () => {
    expect(requestTripSchema.safeParse({ ...valid, volumeM3: 10.0005 }).success).toBe(false);
    expect(requestTripSchema.safeParse({ ...valid, volumeM3: 10.125 }).success).toBe(true);
  });

  /** Своё время ездки — уточняющее (Р3), но рабочее окно у него то же, что у заявки. */
  it('своё время ездки проверяется рабочим окном', () => {
    expect(
      requestTripSchema.safeParse({ ...valid, scheduledAt: '2026-08-14T08:30:00+03:00' }).success,
    ).toBe(true);
    expect(
      requestTripSchema.safeParse({ ...valid, scheduledAt: '2026-08-14T03:00:00+03:00' }).success,
    ).toBe(false);
  });
});

describe('список ездок заявки', () => {
  const valid = {
    fromLocation: 'Карьер',
    toLocation: 'Объект',
    fromAddress: { source: 'resolved', fiasId: 'fias-1' },
    toAddress: { source: 'resolved', fiasId: 'fias-2' },
    fromResponsibleName: 'Иванов',
    fromResponsiblePhone: '+7 916 123-45-67',
    toResponsibleName: 'Петров',
    toResponsiblePhone: '+7 903 765-43-21',
  };

  it('заявка без ездок не проходит', () => {
    expect(requestTripsSchema.safeParse([]).success).toBe(false);
  });

  /**
   * Верхняя граница грубая — потолок по всем бланкам. Настоящую ёмкость считает сервер по всему
   * составу рейса вместе с линейными днями, но без границы вовсе тело запроса разбиралось бы
   * целиком до первой проверки.
   */
  it('ездок не больше потолка по бланкам', () => {
    const many = Array.from({ length: MAX_ROUTE_REQUESTS + 1 }, () => valid);

    expect(requestTripsSchema.safeParse(many).success).toBe(false);
    expect(requestTripsSchema.safeParse(many.slice(1)).success).toBe(true);
  });
});
