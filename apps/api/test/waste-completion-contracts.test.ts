import { describe, expect, it } from 'vitest';
import {
  calcWasteFactCost,
  changeWasteRequestStatusSchema,
  completeWasteRequestSchema,
  factVolumeOf,
  factWeightOf,
  requiresWasteFact,
  sumVehicleVolume,
  updateWasteRequestSchema,
  vehicleVolume,
  type WasteFactAmount,
  wasteFactLabel,
  wasteFactUnit,
  type WasteRequestVehicleDto,
} from '@technic/contracts';

/**
 * Закрытие заявки на вывоз (ADR 0035, ADR 0067): предъявляется вывезенное и стоимость, а не
 * состав техники. Здесь проверяется вход: что схема принимает, что отклоняет и что считает сама.
 * Обязательность факта и подбор цены — за сервером: схема не знает ни типа заявки, ни прайса.
 */

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_VEHICLE_ID = '88888888-8888-4888-8888-888888888888';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

describe('какие заявки отчитываются фактом', () => {
  it('вывоз — да, контейнерные операции закрываются одним талоном', () => {
    expect(requiresWasteFact('waste_removal')).toBe(true);
    expect(requiresWasteFact('metal_removal')).toBe(true);
    expect(requiresWasteFact('container_install')).toBe(false);
    expect(requiresWasteFact('container_replace')).toBe(false);
    expect(requiresWasteFact('container_removal')).toBe(false);
  });

  // Единица — свойство типа заявки (ADR 0067): «3,2» без неё не отвечает, кубометры это или тонны.
  it('мусор меряется объёмом, металлолом — весом', () => {
    expect(wasteFactUnit('waste_removal')).toBe('volume_m3');
    expect(wasteFactUnit('metal_removal')).toBe('weight_tons');
    expect(wasteFactUnit('container_install')).toBeNull();
    expect(wasteFactUnit('container_replace')).toBeNull();
    expect(wasteFactUnit('container_removal')).toBeNull();
  });

  // Величина и её единица — одно неразделимое значение (`WasteFactAmount`): пара необязательных
  // чисел разъезжалась бы молча, потому что `null` легален и в шаблонной строке, и в JSX.
  it('вывезенное печатается со своей единицей', () => {
    expect(wasteFactLabel({ unit: 'volume_m3', volumeM3: 48 })).toBe('48 м³');
    expect(wasteFactLabel({ unit: 'weight_tons', weightTons: 3.2 })).toBe('3.2 т');
  });

  it('величину факта достают только по её единице', () => {
    const volume: WasteFactAmount = { unit: 'volume_m3', volumeM3: 48 };
    const weight: WasteFactAmount = { unit: 'weight_tons', weightTons: 3.2 };
    expect(factVolumeOf(volume)).toBe(48);
    expect(factVolumeOf(weight)).toBeNull();
    expect(factWeightOf(weight)).toBe(3.2);
    expect(factWeightOf(volume)).toBeNull();
    // Факта нет вовсе — у контейнерных операций и у незакрытой заявки.
    expect(factVolumeOf(null)).toBeNull();
    expect(factWeightOf(undefined)).toBeNull();
  });
});

describe('факт вывоза', () => {
  it('объём обязателен и строго положителен', () => {
    expect(completeWasteRequestSchema.parse({ volumeM3: 48 }).volumeM3).toBe(48);
    expect(() => completeWasteRequestSchema.parse({})).toThrow();
    expect(() => completeWasteRequestSchema.parse({ volumeM3: 0 })).toThrow();
    expect(() => completeWasteRequestSchema.parse({ volumeM3: -5 })).toThrow();
  });

  // Объём берут из талона и весовой квитанции, а не из вместимости кузова: дробный он там обычен.
  it('объём дробный — до трёх знаков', () => {
    expect(completeWasteRequestSchema.parse({ volumeM3: 47.5 }).volumeM3).toBe(47.5);
    expect(completeWasteRequestSchema.parse({ volumeM3: 47.125 }).volumeM3).toBe(47.125);
    expect(() => completeWasteRequestSchema.parse({ volumeM3: 47.1256 })).toThrow();
  });

  // Стоимость правится свободно — счёт оператора включает и подачу, и недогруз. Ноль допустим:
  // вывоз бывает в счёт другой работы, и требовать выдуманную цифру не за что.
  it('стоимость необязательна, допускает ноль и две цифры после запятой', () => {
    expect(completeWasteRequestSchema.parse({ volumeM3: 48 }).totalCost).toBeUndefined();
    expect(completeWasteRequestSchema.parse({ volumeM3: 48, totalCost: 0 }).totalCost).toBe(0);
    expect(completeWasteRequestSchema.parse({ volumeM3: 48, totalCost: 40_800.5 }).totalCost).toBe(
      40_800.5,
    );
    expect(() => completeWasteRequestSchema.parse({ volumeM3: 48, totalCost: -1 })).toThrow();
    expect(() =>
      completeWasteRequestSchema.parse({ volumeM3: 48, totalCost: 40_800.555 }),
    ).toThrow();
  });

  // Пустая сумма и отсутствующая — разное: первая означает «закрываем без суммы», вторая —
  // «посчитай сам по прайсу». Различает их сервер, схема обе пропускает.
  it('пустая стоимость принимается явным null', () => {
    expect(
      completeWasteRequestSchema.parse({ volumeM3: 48, totalCost: null }).totalCost,
    ).toBeNull();
  });

  it('состав техники в факте не передаётся — вывоз считается объёмом', () => {
    expect(() =>
      completeWasteRequestSchema.parse({ volumeM3: 48, vehicles: [{ containerTypeId: TYPE_ID }] }),
    ).toThrow();
  });
});

// Металлолом предъявляется весом и без денег (ADR 0067). Что величина прислана именно та, которой
// меряется эта заявка, проверяет сервер — схеме тип заявки неизвестен.
describe('факт сдачи металлолома', () => {
  it('вес обязателен, строго положителен и дробен до трёх знаков', () => {
    expect(completeWasteRequestSchema.parse({ weightTons: 3.2 }).weightTons).toBe(3.2);
    expect(completeWasteRequestSchema.parse({ weightTons: 3.125 }).weightTons).toBe(3.125);
    expect(() => completeWasteRequestSchema.parse({ weightTons: 0 })).toThrow();
    expect(() => completeWasteRequestSchema.parse({ weightTons: -1 })).toThrow();
    expect(() => completeWasteRequestSchema.parse({ weightTons: 3.1256 })).toThrow();
  });

  // Две величины разом — два ответа на вопрос «сколько увезли»; ни одной — закрытие, которое
  // ничего не предъявило. Тот же инвариант держит CHECK в БД (миграция 0090).
  it('величина ровно одна', () => {
    expect(() => completeWasteRequestSchema.parse({ volumeM3: 48, weightTons: 3.2 })).toThrow();
    expect(() => completeWasteRequestSchema.parse({})).toThrow();
  });

  // Прайс задан в ₽/м³ на пару «тип мусора × техника», и приложить его к тоннам нечем: сумма
  // рядом с весом означала бы расчёт, которого не было.
  it('стоимость к весу не прикладывается', () => {
    expect(() =>
      completeWasteRequestSchema.parse({ weightTons: 3.2, totalCost: 15_000 }),
    ).toThrow();
    expect(() => completeWasteRequestSchema.parse({ weightTons: 3.2, totalCost: null })).toThrow();
  });
});

describe('расчёт стоимости по прайсу', () => {
  it('объём × цена, с округлением до копейки', () => {
    expect(calcWasteFactCost(48, 850)).toBe(40_800);
    expect(calcWasteFactCost(47.5, 850.25)).toBe(40_386.88);
  });

  // Цены в прайсе может не быть вовсе — тогда считать нечем, и это не мешает закрытию: сумму
  // вводят руками. Ради этого блокер по цене и снят (ADR 0035).
  it('без цены расчёта нет', () => {
    expect(calcWasteFactCost(48, null)).toBeNull();
  });
});

describe('факт при смене статуса', () => {
  it('принимается только при закрытии заявки', () => {
    const completion = { volumeM3: 48, totalCost: 40_800 };
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, completion }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, completion }),
    ).toThrow();
  });

  // При повторном закрытии (после отката администратором) хватает уже предъявленного факта, и
  // видит это только сервер: он знает и тип заявки, и её прошлое закрытие.
  it('закрытие без факта схемой не запрещено — его наличие проверяет сервер по заявке', () => {
    const parsed = changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 });
    expect(parsed.completion).toBeUndefined();
  });

  it('состав техники в смене статуса больше не принимается', () => {
    const parsed = changeWasteRequestStatusSchema.parse({
      status: 'done',
      version: 1,
      vehicles: [{ containerTypeId: TYPE_ID }],
      vehicleCounts: [{ vehicleId: VEHICLE_ID, count: 2 }],
    }) as Record<string, unknown>;
    expect(parsed.vehicles).toBeUndefined();
    expect(parsed.vehicleCounts).toBeUndefined();
  });
});

// Талоны — общий пул заявки у любого типа (ADR 0024). Обязательность считает сервер: он видит
// состояние заявки, а бумага могла прийти ещё с прошлым закрытием.
describe('талоны заявки при смене статуса', () => {
  it('принимаются только при закрытии заявки', () => {
    const ticketFileIds = [FILE_ID];
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, ticketFileIds }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, ticketFileIds }),
    ).toThrow();
  });

  it('пустой список схема пропускает — обязательность талона считает сервер', () => {
    expect(
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 }).ticketFileIds,
    ).toEqual([]);
  });

  it('комментарий к выполнению необязателен и уходит в историю', () => {
    const parsed = changeWasteRequestStatusSchema.parse({
      status: 'done',
      version: 1,
      comment: '  вывезли не полностью  ',
    });
    expect(parsed.comment).toBe('вывезли не полностью');
    expect(changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 }).comment).toBe('');
  });
});

describe('правка заявки', () => {
  // Факт правят повторным закрытием, а не правкой заявки: расчёт по прайсу виден там, где его
  // вводят. Присланные поля молча игнорируются — схема их просто не знает.
  it('факт выполнения через правку не передаётся', () => {
    const parsed = updateWasteRequestSchema.parse({
      version: 3,
      completion: { volumeM3: 48 },
      addVehicles: [{ containerTypeId: TYPE_ID, count: 2 }],
    }) as Record<string, unknown>;
    expect(parsed.completion).toBeUndefined();
    expect(parsed.addVehicles).toBeUndefined();
  });
});

// Состав техники прошлых закрытий остаётся в истории заявки: новых строк не появляется, но по
// этим цифрам заявки принимали, и показывать их нужно как было.
describe('состав техники прошлых закрытий', () => {
  const vehicle = (
    volumeM3: number,
    count = 1,
    opts: { isDeleted?: boolean; id?: string } = {},
  ): WasteRequestVehicleDto => ({
    id: opts.id ?? VEHICLE_ID,
    containerTypeId: TYPE_ID,
    containerTypeName: 'Самосвал 25 м³',
    containerKind: 'truck',
    volumeM3,
    count,
    pricePerM3: 850,
    amount: Math.round(volumeM3 * count * 850 * 100) / 100,
    isDeleted: opts.isDeleted ?? false,
    createdAt: '2026-07-27T10:00:00.000Z',
  });

  it('объём строки — вместимость × количество', () => {
    expect(vehicleVolume({ volumeM3: 25, count: 2 })).toBe(50);
  });

  it('помеченные на удаление в сумму не входят', () => {
    expect(
      sumVehicleVolume([
        vehicle(25, 2),
        vehicle(20),
        vehicle(8, 1, { isDeleted: true, id: OTHER_VEHICLE_ID }),
      ]),
    ).toBe(70);
  });
});
