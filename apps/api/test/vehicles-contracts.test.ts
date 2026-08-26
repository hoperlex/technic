import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createVehicleSchema,
  rentalActivationBlockReason,
  updateVehicleSchema,
  updateVehicleSchemaByOwnership,
  vehicleListQuerySchema,
  vehicleTitle,
  type DeleteVehicleResult,
  type UpdateVehicleResult,
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
    lessorIsActive: null,
    deactivatedWithLessor: false,
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

  // Причина запрета одна и та же в подсказке интерфейса и в ответе сервера (ADR 0018 §16).
  describe('запрет включения аренды у неактивного арендодателя', () => {
    const rental: VehicleDto = {
      ...base,
      ownership: 'rental',
      lessorId: LESSOR,
      lessorName: 'ООО «ЭВЕРЕНТ»',
      lessorIsActive: true,
    };

    it('активный арендодатель — включать можно', () => {
      expect(rentalActivationBlockReason(rental)).toBeNull();
    });

    it('неактивный арендодатель — причина с его наименованием', () => {
      const reason = rentalActivationBlockReason({ ...rental, lessorIsActive: false });
      expect(reason).toContain('ООО «ЭВЕРЕНТ»');
      expect(reason).toContain('неактивен');
    });

    it('собственной техники правило не касается', () => {
      expect(rentalActivationBlockReason({ ...base, lessorIsActive: false })).toBeNull();
    });

    // Выключенным вместе с арендодателем возвращаться вручную не нужно — они поднимутся сами.
    it('выключенным каскадом обещан автоматический возврат', () => {
      const reason = rentalActivationBlockReason({
        ...rental,
        lessorIsActive: false,
        deactivatedWithLessor: true,
      });
      expect(reason).toContain('включится обратно вместе с ним');
    });

    it('выключенным вручную предложено активировать арендодателя', () => {
      const reason = rentalActivationBlockReason({
        ...rental,
        lessorIsActive: false,
        deactivatedWithLessor: false,
      });
      expect(reason).toContain('справочнике контрагентов');
    });
  });
});

/**
 * Форма ответа правки — `PATCH /vehicles/:id`.
 *
 * Правка машины делает две вещи разом: меняет карточку и — при списании либо переводе типа на
 * бланк «форма № 3» — снимает привязки закреплённых прицепов (план `docs/vehicle-trailers-plan.md`,
 * §4.2.3). §7 обещает, что портал скажет, сколько снял, и списание идёт именно этой дверью, а не
 * `DELETE`: промолчи она — немым остаётся самый частый путь.
 */
describe('vehicles: ответ правки', () => {
  const card = { id: 'v1', registrationNumber: 'В094ЕТ77' } as VehicleDto;

  it('обёртка: карточка отдельно, число снятых привязок отдельно', () => {
    const res: UpdateVehicleResult = { vehicle: card, unhitchedTrailers: 2 };
    expect(Object.keys(res).sort()).toEqual(['unhitchedTrailers', 'vehicle']);
    expect(res.vehicle).toBe(card);
    // Исход операции не приписан свойствам машины: в карточке числа нет и быть не должно —
    // иначе оно читалось бы у каждой строки списка, где никто ничего не снимал.
    expect(res.vehicle).not.toHaveProperty('unhitchedTrailers');
  });

  it('ничего не сняли — ноль, а не пропущенное поле: портал молчит по значению', () => {
    const res: UpdateVehicleResult = { vehicle: card, unhitchedTrailers: 0 };
    expect(res.unhitchedTrailers).toBe(0);
    expect('unhitchedTrailers' in res).toBe(true);
  });

  /**
   * Сторож самой ручки. Типы держат согласие сервера и портала, пока обёртка объявлена; но убери
   * её из контрактов вместе с обоими читателями — и `tsc` снова зелёный, а обещание §7 снова
   * не выполнено. Ровно так оно и осталось невыполненным в первый раз: снятие привязок в `PATCH`
   * было написано верно, а ответ о нём молчал. Проверка смотрит **только** ветку `PATCH`:
   * заведение и восстановление отвечают карточкой, и это правильно.
   */
  it('PATCH отвечает обёрткой, а не голой карточкой', () => {
    const src = readFileSync(new URL('../src/routes/vehicles.ts', import.meta.url), 'utf8');
    const patchBranch = src.slice(src.indexOf('r.patch('), src.indexOf('r.delete('));
    expect(patchBranch).toMatch(
      /const answer: UpdateVehicleResult = \{[\s\S]*?unhitchedTrailers[\s\S]*?\};/,
    );
    expect(patchBranch).not.toMatch(/return \(await getById\(id\)\)!;/);
  });
});

/**
 * Ответ мягкого удаления — `DELETE /vehicles/:id`, кнопка «В архив».
 *
 * Третья дверь той же таблицы §4.2.3: уход машины в архив снимает привязки прицепов, как списание
 * и перевод на «форму № 3». Снятие тут написано верно с самого начала, а вот сказать о нём ответ
 * не мог: число ехало полем, не объявленным ни в одном контракте, — портал типизировал ответ как
 * `{ ok: boolean }` и число не читал. Немой ответ и молчащий ответ для §7 — одно и то же.
 */
describe('vehicles: ответ архивации', () => {
  it('форма: признак успеха и число снятых привязок, карточки нет', () => {
    const res: DeleteVehicleResult = { ok: true, unhitchedTrailers: 2 };
    expect(Object.keys(res).sort()).toEqual(['ok', 'unhitchedTrailers']);
    expect(res.ok).toBe(true);
    // Карточки в ответе нет намеренно: удалённую запись списки не показывают, показывать нечего.
    expect(res).not.toHaveProperty('vehicle');
  });

  it('ничего не сняли — ноль, а не пропущенное поле: портал молчит по значению', () => {
    const res: DeleteVehicleResult = { ok: true, unhitchedTrailers: 0 };
    expect(res.unhitchedTrailers).toBe(0);
    expect('unhitchedTrailers' in res).toBe(true);
  });

  /**
   * Сторож самой ручки — тем же приёмом, что и у `PATCH` выше, и по той же причине: `tsconfig`
   * приложения каталог `test/` не включает, поэтому проверка типом здесь без зубов, а исходник
   * ручки читается всегда. Убери аннотацию — и ответ снова разойдётся с контрактом молча.
   */
  it('DELETE отвечает объявленным типом, а не голым { ok: true }', () => {
    const src = readFileSync(new URL('../src/routes/vehicles.ts', import.meta.url), 'utf8');
    const start = src.indexOf('r.delete(');
    const deleteBranch = src.slice(start, src.indexOf('/:id/restore', start));
    expect(deleteBranch).toMatch(
      /const answer: DeleteVehicleResult = \{[\s\S]*?unhitchedTrailers[\s\S]*?\};/,
    );
    expect(deleteBranch).not.toMatch(/return \{ ok: true \};/);
  });
});
