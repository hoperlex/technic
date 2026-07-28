import { describe, expect, it } from 'vitest';
import {
  createVehicleSchema,
  updateVehicleSchema,
  updateVehicleSchemaByOwnership,
  vehicleListQuerySchema,
  vehicleTitle,
  type VehicleDto,
} from '@technic/contracts';

const TYPE = '33333333-3333-4333-8333-333333333333';
const MODEL = '44444444-4444-4444-8444-444444444444';
const CATEGORY = '55555555-5555-4555-8555-555555555555';
const LESSOR = '66666666-6666-4666-8666-666666666666';

const own = (patch: Record<string, unknown> = {}) => ({
  ownership: 'own' as const,
  vehicleTypeId: TYPE,
  ...patch,
});
const rental = (patch: Record<string, unknown> = {}) => ({
  ownership: 'rental' as const,
  vehicleTypeId: TYPE,
  lessorId: LESSOR,
  pricePerHour: 3500,
  ...patch,
});

describe('vehicles: создание собственной', () => {
  it('минимально валидно: принадлежность + тип, остальное дефолтами', () => {
    const v = createVehicleSchema.parse(own());
    expect(v.ownership).toBe('own');
    expect(v.status).toBe('active');
    expect(v.note).toBe('');
  });

  it('vehicleTypeId обязателен и uuid', () => {
    expect(() => createVehicleSchema.parse({ ownership: 'own' })).toThrow();
    expect(() => createVehicleSchema.parse(own({ vehicleTypeId: 'not-uuid' }))).toThrow();
  });

  it('принадлежность обязательна: без неё ветку не выбрать', () => {
    expect(() => createVehicleSchema.parse({ vehicleTypeId: TYPE })).toThrow();
    expect(() =>
      createVehicleSchema.parse({ ownership: 'leasing', vehicleTypeId: TYPE }),
    ).toThrow();
  });

  it('strict: лишние поля отклоняются', () => {
    expect(() => createVehicleSchema.parse(own({ foo: 1 }))).toThrow();
  });

  it('поля аренды недоступны собственной технике', () => {
    for (const field of [
      'lessorId',
      'pricePerHour',
      'pricePerShift',
      'shiftHours',
      'description',
    ]) {
      expect(() => createVehicleSchema.parse(own({ [field]: 1 }))).toThrow();
    }
  });

  it('status — только из перечня; у своей машины доступны все состояния', () => {
    expect(() => createVehicleSchema.parse(own({ status: 'bogus' }))).toThrow();
    expect(createVehicleSchema.parse(own({ status: 'retired' })).status).toBe('retired');
  });

  it('госномер: обрезка пробелов и лимит длины', () => {
    const v = createVehicleSchema.parse(own({ registrationNumber: '  В094ЕТ77 ' }));
    expect(v.ownership === 'own' && v.registrationNumber).toBe('В094ЕТ77');
    expect(() => createVehicleSchema.parse(own({ registrationNumber: 'x'.repeat(51) }))).toThrow();
  });

  // Инв. №, зав. № / VIN, изготовитель и дата выпуска убраны из справочника: схема их не принимает.
  it('снятые поля отклоняются как лишние', () => {
    for (const field of ['inventoryNumber', 'serialNumber', 'manufacturerName', 'manufacturedOn']) {
      expect(() => createVehicleSchema.parse(own({ [field]: 'x' }))).toThrow();
      expect(() => updateVehicleSchema.parse({ [field]: 'x' })).toThrow();
    }
  });

  it('модель и категория — uuid или null', () => {
    const v = createVehicleSchema.parse(
      own({ vehicleModelId: MODEL, vehicleCategoryId: CATEGORY }),
    );
    expect(v.ownership === 'own' && v.vehicleModelId).toBe(MODEL);
    expect(v.vehicleCategoryId).toBe(CATEGORY);
    expect(
      createVehicleSchema.parse(own({ vehicleModelId: null })).vehicleCategoryId,
    ).toBeUndefined();
    expect(() => createVehicleSchema.parse(own({ vehicleModelId: 'x' }))).toThrow();
  });
});

describe('vehicles: создание предложения аренды', () => {
  it('арендодатель и хотя бы одна цена обязательны', () => {
    expect(createVehicleSchema.parse(rental()).ownership).toBe('rental');
    expect(() => createVehicleSchema.parse(rental({ lessorId: undefined }))).toThrow();
    expect(() =>
      createVehicleSchema.parse(rental({ pricePerHour: undefined, pricePerShift: undefined })),
    ).toThrow();
    expect(() =>
      createVehicleSchema.parse(rental({ pricePerHour: null, pricePerShift: 28000 })),
    ).not.toThrow();
  });

  it('реквизиты машины недоступны аренде', () => {
    for (const field of ['vehicleModelId', 'registrationNumber', 'passportNumber']) {
      expect(() => createVehicleSchema.parse(rental({ [field]: MODEL }))).toThrow();
    }
  });

  it('цена строго положительная и не мельче копейки', () => {
    expect(() => createVehicleSchema.parse(rental({ pricePerHour: 0 }))).toThrow();
    expect(() => createVehicleSchema.parse(rental({ pricePerHour: -1 }))).toThrow();
    expect(() => createVehicleSchema.parse(rental({ pricePerHour: 3500.555 }))).toThrow();
    expect(createVehicleSchema.parse(rental({ pricePerHour: 3500.55 })).ownership).toBe('rental');
  });

  it('состояния машины у предложения аренды недоступны', () => {
    expect(() => createVehicleSchema.parse(rental({ status: 'maintenance' }))).toThrow();
    expect(() => createVehicleSchema.parse(rental({ status: 'retired' }))).toThrow();
    expect(createVehicleSchema.parse(rental({ status: 'inactive' })).status).toBe('inactive');
  });

  it('длительность смены — целое 1..24', () => {
    expect(() => createVehicleSchema.parse(rental({ shiftHours: 0 }))).toThrow();
    expect(() => createVehicleSchema.parse(rental({ shiftHours: 25 }))).toThrow();
    expect(() => createVehicleSchema.parse(rental({ shiftHours: 8.5 }))).toThrow();
  });

  it('описание — короткий срез-идентификатор, по умолчанию пустое', () => {
    const v = createVehicleSchema.parse(rental());
    expect(v.ownership === 'rental' && v.description).toBe('');
    const named = createVehicleSchema.parse(rental({ description: '  Автокран 70 тн ' }));
    expect(named.ownership === 'rental' && named.description).toBe('Автокран 70 тн');
    expect(() => createVehicleSchema.parse(rental({ description: 'x'.repeat(121) }))).toThrow();
  });
});

describe('vehicles: обновление', () => {
  it('частичное обновление: пустой объект ок', () => {
    expect(() => updateVehicleSchema.parse({})).not.toThrow();
  });

  it('strict: лишние поля отклоняются', () => {
    expect(() => updateVehicleSchema.parse({ foo: 1 })).toThrow();
  });

  it('принадлежность неизменяема: ownership в теле не принимается', () => {
    expect(() => updateVehicleSchema.parse({ ownership: 'rental' })).toThrow();
  });

  it('можно поменять только статус (без дефолтов на остальные поля)', () => {
    const v = updateVehicleSchema.parse({ status: 'maintenance' });
    expect(v.status).toBe('maintenance');
    expect(v.vehicleTypeId).toBeUndefined();
    expect(v.note).toBeUndefined();
  });

  // Ветку PATCH определяет запись, а не тело: маршрут разбирает тело схемой своей принадлежности.
  it('схема по принадлежности отсекает поля чужой ветки', () => {
    expect(updateVehicleSchemaByOwnership.own.safeParse({ pricePerHour: 100 }).success).toBe(false);
    expect(
      updateVehicleSchemaByOwnership.own.safeParse({ registrationNumber: 'А001АА77' }).success,
    ).toBe(true);
    expect(
      updateVehicleSchemaByOwnership.rental.safeParse({ registrationNumber: 'А001АА77' }).success,
    ).toBe(false);
    expect(updateVehicleSchemaByOwnership.rental.safeParse({ pricePerHour: 100 }).success).toBe(
      true,
    );
    expect(updateVehicleSchemaByOwnership.rental.safeParse({ status: 'retired' }).success).toBe(
      false,
    );
  });
});

describe('vehicles: список', () => {
  it('includeDeleted: строка → boolean, по умолчанию false', () => {
    expect(vehicleListQuerySchema.parse({}).includeDeleted).toBe(false);
    expect(vehicleListQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted).toBe(true);
    expect(vehicleListQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted).toBe(false);
  });

  it('сортировка — только из allowlist', () => {
    expect(() => vehicleListQuerySchema.parse({ sortBy: 'note' })).toThrow();
    expect(vehicleListQuerySchema.parse({ sortBy: 'status' }).sortBy).toBe('status');
    expect(vehicleListQuerySchema.parse({ sortBy: 'pricePerHour' }).sortBy).toBe('pricePerHour');
  });

  it('фильтры по принадлежности и арендодателю', () => {
    expect(() => vehicleListQuerySchema.parse({ ownership: 'bogus' })).toThrow();
    expect(vehicleListQuerySchema.parse({ ownership: 'rental' }).ownership).toBe('rental');
    expect(vehicleListQuerySchema.parse({ lessorId: LESSOR }).lessorId).toBe(LESSOR);
  });

  it('status фильтр — из перечня', () => {
    expect(() => vehicleListQuerySchema.parse({ status: 'bogus' })).toThrow();
    expect(vehicleListQuerySchema.parse({ status: 'active' }).status).toBe('active');
  });
});

describe('vehicles: заголовок строки', () => {
  const base: VehicleDto = {
    id: '1',
    ownership: 'own',
    vehicleTypeId: TYPE,
    typeName: 'Автокраны',
    vehicleCategoryId: null,
    categoryName: null,
    vehicleModelId: null,
    modelName: null,
    registrationNumber: null,
    passportNumber: null,
    lessorId: null,
    lessorName: null,
    description: '',
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    status: 'active',
    note: '',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };

  it('своя машина: госномер, иначе модель, иначе классификация', () => {
    expect(vehicleTitle({ ...base, registrationNumber: 'В094ЕТ77', modelName: 'МАЗ' })).toBe(
      'В094ЕТ77',
    );
    expect(vehicleTitle({ ...base, modelName: 'МАЗ 6501В5' })).toBe('МАЗ 6501В5');
    expect(vehicleTitle({ ...base, categoryName: 'Автокраны, г/п 25 т' })).toBe(
      'Автокраны, г/п 25 т',
    );
    expect(vehicleTitle(base)).toBe('Автокраны');
  });

  it('аренда: описание, иначе категория, иначе тип', () => {
    const r: VehicleDto = { ...base, ownership: 'rental', lessorName: 'ООО «ЭВЕРЕНТ»' };
    expect(vehicleTitle({ ...r, description: 'Автокран 70 тн' })).toBe('Автокран 70 тн');
    expect(vehicleTitle({ ...r, categoryName: 'Автокраны, г/п 25 т' })).toBe('Автокраны, г/п 25 т');
    expect(vehicleTitle(r)).toBe('Автокраны');
  });
});
