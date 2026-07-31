import { describe, expect, it } from 'vitest';
import type {
  FreightTransportRequestDto,
  SpecialEquipmentRequestDto,
  VehicleRequestAssignmentDto,
  VehicleRequestCompletionDto,
} from '@technic/contracts';
import {
  diffVehicleAssignment,
  diffVehicleCompletion,
  diffVehicleRequests,
} from '../src/services/vehicle-request-diff';

// Дифф правки заявки на технику — то, из чего складывается история в карточке (ADR 0015).

const BASE = {
  id: '11111111-1111-4111-8111-111111111111',
  num: 7,
  displayNumber: 'ТС-7',
  objectId: '22222222-2222-4222-8222-222222222222',
  objectCode: 'ОБ-1',
  objectName: 'Жилой комплекс',
  vehicleTypeId: '33333333-3333-4333-8333-333333333333',
  vehicleTypeName: 'Экскаватор',
  // Заявка на тип без ТТХ: категории у него не бывает (ADR 0028).
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  status: 'new' as const,
  comment: 'Заезд со двора',
  cancelReason: null,
  files: [],
  version: 1,
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
};

const SPECIAL: SpecialEquipmentRequestDto = {
  ...BASE,
  requestType: 'special_equipment',
  dateFrom: '2026-08-01',
  dateTo: null,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
};

const FREIGHT: FreightTransportRequestDto = {
  ...BASE,
  requestType: 'freight_transport',
  vehicleTypeName: 'Тентованный',
  scheduledAt: '2026-08-01T07:00:00.000Z',
  scheduledTimeUnspecified: false,
  volumeM3: 20,
  weightTons: null,
  loadingLocation: 'г Москва, ул Тверская, д 1',
  unloadingLocation: 'г Москва, ул Арбат, д 2',
  loadingAddress: { source: 'resolved', fiasId: 'a1' },
  unloadingAddress: { source: 'resolved', fiasId: 'a2' },
  loadingResponsibleName: 'Сидоров С. С.',
  loadingResponsiblePhone: '+7 926 000-00-02',
  unloadingResponsibleName: 'Кузнецов К. К.',
  unloadingResponsiblePhone: '+7 926 000-00-03',
};

const file = (id: string, filename: string) => ({
  id,
  filename,
  contentType: 'application/pdf',
  size: 1024,
  status: 'active' as const,
  createdAt: '2026-07-28T10:00:00.000Z',
});

describe('дифф правки заявки на технику', () => {
  it('без изменений — пустой список', () => {
    expect(diffVehicleRequests(SPECIAL, { ...SPECIAL, version: 2 })).toEqual([]);
    expect(diffVehicleRequests(FREIGHT, { ...FREIGHT, version: 2 })).toEqual([]);
  });

  it('объект и тип ТС показываются названиями, а не идентификаторами', () => {
    const changes = diffVehicleRequests(SPECIAL, {
      ...SPECIAL,
      objectCode: 'ОБ-2',
      objectName: 'Школа',
      vehicleTypeId: 'x',
      vehicleTypeName: 'Автокран',
    });
    expect(changes).toContainEqual({
      field: 'object',
      from: 'ОБ-1 — Жилой комплекс',
      to: 'ОБ-2 — Школа',
    });
    expect(changes).toContainEqual({
      field: 'vehicleType',
      from: 'Экскаватор',
      to: 'Автокран',
    });
  });

  // Заказанная позиция классификатора — одна строка истории (ADR 0028): наименование категории
  // уже начинается с типа, и «Тип ТС» рядом с «Категорией» повторяли бы друг друга.
  it('смена категории внутри типа — одна строка «тип/категория»', () => {
    const from = {
      ...SPECIAL,
      vehicleTypeName: 'Автокраны',
      vehicleCategoryId: '66666666-6666-4666-8666-666666666666',
      vehicleCategoryName: 'Автокраны, г/п 25 т',
    };
    const to = {
      ...from,
      vehicleCategoryId: '77777777-7777-4777-8777-777777777777',
      vehicleCategoryName: 'Автокраны, г/п 130 т',
    };
    const changes = diffVehicleRequests(from, to);
    expect(changes).toEqual([
      { field: 'vehicleType', from: 'Автокраны, г/п 25 т', to: 'Автокраны, г/п 130 т' },
    ]);
  });

  it('тип без категорий показывается чистым типом', () => {
    const to = {
      ...SPECIAL,
      vehicleTypeId: 'x',
      vehicleTypeName: 'Автокраны',
      vehicleCategoryId: '66666666-6666-4666-8666-666666666666',
      vehicleCategoryName: 'Автокраны, г/п 25 т',
    };
    expect(diffVehicleRequests(SPECIAL, to)).toContainEqual({
      field: 'vehicleType',
      from: 'Экскаватор',
      to: 'Автокраны, г/п 25 т',
    });
  });

  it('период спецтехники — датами без времени, снятая дата окончания читается как «—»', () => {
    const withEnd = { ...SPECIAL, dateTo: '2026-08-05' };
    expect(diffVehicleRequests(SPECIAL, withEnd)).toContainEqual({
      field: 'dateTo',
      from: '—',
      to: '05.08.2026',
    });
    expect(diffVehicleRequests(withEnd, SPECIAL)).toContainEqual({
      field: 'dateTo',
      from: '05.08.2026',
      to: '—',
    });
    expect(diffVehicleRequests(SPECIAL, { ...SPECIAL, dateFrom: '2026-08-02' })).toContainEqual({
      field: 'dateFrom',
      from: '01.08.2026',
      to: '02.08.2026',
    });
  });

  it('подача грузоперевозки — в МСК, а «время не задано» показывает только дату', () => {
    expect(
      diffVehicleRequests(FREIGHT, { ...FREIGHT, scheduledAt: '2026-08-02T11:30:00.000Z' }),
    ).toContainEqual({ field: 'scheduledAt', from: '01.08.2026 10:00', to: '02.08.2026 14:30' });
    expect(
      diffVehicleRequests(FREIGHT, { ...FREIGHT, scheduledTimeUnspecified: true }),
    ).toContainEqual({ field: 'scheduledAt', from: '01.08.2026 10:00', to: '01.08.2026' });
  });

  it('объём, масса и адреса грузоперевозки', () => {
    const changes = diffVehicleRequests(FREIGHT, {
      ...FREIGHT,
      volumeM3: null,
      weightTons: 12,
      unloadingLocation: 'г Москва, ул Полянка, д 3',
    });
    expect(changes).toContainEqual({ field: 'volumeM3', from: '20 м³', to: '—' });
    expect(changes).toContainEqual({ field: 'weightTons', from: '—', to: '12 т' });
    expect(changes).toContainEqual({
      field: 'unloadingLocation',
      from: 'г Москва, ул Арбат, д 2',
      to: 'г Москва, ул Полянка, д 3',
    });
    // Адрес погрузки не трогали — события о нём быть не должно.
    expect(changes.some((c) => c.field === 'loadingLocation')).toBe(false);
  });

  it('длинный комментарий обрезается', () => {
    const change = diffVehicleRequests(SPECIAL, { ...SPECIAL, comment: 'а'.repeat(400) }).find(
      (c) => c.field === 'comment',
    );
    expect(change?.to).toHaveLength(301);
    expect(change?.to?.endsWith('…')).toBe(true);
  });

  it('файлы сравниваются по составу, а не по количеству', () => {
    const changes = diffVehicleRequests(
      { ...SPECIAL, files: [file('f1', 'заявка.pdf')] },
      { ...SPECIAL, files: [file('f2', 'путевой.pdf')] },
    );
    expect(changes).toContainEqual({ field: 'filesAdded', from: null, to: 'путевой.pdf' });
    expect(changes).toContainEqual({ field: 'filesRemoved', from: null, to: 'заявка.pdf' });
  });
});

// ── Назначение техники (ADR 0027) ──
const RENTAL: VehicleRequestAssignmentDto = {
  vehicleId: '66666666-6666-4666-8666-666666666666',
  ownership: 'rental',
  typeName: 'Экскаватор',
  categoryName: 'Экскаватор 1,5 м³',
  modelName: null,
  registrationNumber: null,
  description: 'Экскаватор Hitachi 1,5 м³',
  lessorId: '77777777-7777-4777-8777-777777777777',
  lessorName: 'ООО «Спецтехника»',
  pricePerHour: 2500,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: '55555555-5555-4555-8555-555555555555',
  assignedByName: 'Иванов И. И.',
  assignedAt: '2026-07-28T12:00:00.000Z',
};

describe('дифф назначения техники', () => {
  it('первое назначение: слева прочерк — назначения не было', () => {
    const changes = diffVehicleAssignment(null, RENTAL);
    expect(changes).toContainEqual({
      field: 'vehicle',
      from: '—',
      to: 'Экскаватор Hitachi 1,5 м³ · Экскаватор 1,5 м³ · ООО «Спецтехника»',
    });
    expect(changes.find((c) => c.field === 'pricePerHour')?.to).toContain('₽');
    // Ставки за смену не было и нет — событию о ней взяться неоткуда.
    expect(changes.some((c) => c.field === 'pricePerShift')).toBe(false);
  });

  it('та же машина по другой цене — событие о ставке, а не о технике', () => {
    const changes = diffVehicleAssignment(RENTAL, { ...RENTAL, pricePerHour: 2800 });
    expect(changes.some((c) => c.field === 'vehicle')).toBe(false);
    // Разделитель разрядов у ru-RU неразрывный — сравниваем по цифрам, а не по виду строки.
    const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
    expect(digits(changes.find((c) => c.field === 'pricePerHour')?.from)).toBe('250000');
    expect(digits(changes.find((c) => c.field === 'pricePerHour')?.to)).toBe('280000');
  });

  it('своя машина различается госномером, арендодателя у неё нет', () => {
    const own: VehicleRequestAssignmentDto = {
      ...RENTAL,
      ownership: 'own',
      description: '',
      registrationNumber: 'О123ОО197',
      lessorId: null,
      lessorName: null,
      pricePerHour: null,
    };
    const changes = diffVehicleAssignment(RENTAL, own);
    expect(changes).toContainEqual({
      field: 'vehicle',
      from: 'Экскаватор Hitachi 1,5 м³ · Экскаватор 1,5 м³ · ООО «Спецтехника»',
      // Категория рядом с госномером не для красоты: технику подбирают по типу (ADR 0045), и
      // какой позицией классификатора закрыли заявку, видно только здесь.
      to: 'О123ОО197 · Экскаватор 1,5 м³',
    });
    // Ставка снята — в истории это «было 2 500 ₽, стало ничего».
    expect(changes.find((c) => c.field === 'pricePerHour')?.to).toBe('—');
  });

  it('категория, которой машина и подписана, не повторяется дважды', () => {
    // У предложения аренды без описания подпись — сама категория (`vehicleLabel`).
    const changes = diffVehicleAssignment(null, { ...RENTAL, description: '' });
    expect(changes).toContainEqual({
      field: 'vehicle',
      from: '—',
      to: 'Экскаватор 1,5 м³ · ООО «Спецтехника»',
    });
  });
});

// ── Факт выполнения (ADR 0029) ──
const COMPLETION: VehicleRequestCompletionDto = {
  workedUnit: 'shifts',
  workedAmount: 3,
  rate: 18000,
  totalCost: 54000,
  completedBy: '55555555-5555-4555-8555-555555555555',
  completedByName: 'Иванов И. И.',
  completedAt: '2026-08-05T12:00:00.000Z',
};

describe('дифф факта выполнения', () => {
  it('первое закрытие: слева прочерки — факта не было', () => {
    const changes = diffVehicleCompletion(null, COMPLETION);
    expect(changes).toContainEqual({ field: 'worked', from: '—', to: '3 смены' });
    expect(changes.find((c) => c.field === 'totalCost')?.from).toBe('—');
    expect(changes.find((c) => c.field === 'totalCost')?.to).toContain('₽');
  });

  it('повторное закрытие: изменилось время — изменилась и сумма', () => {
    const changes = diffVehicleCompletion(COMPLETION, {
      ...COMPLETION,
      workedAmount: 2,
      totalCost: 36000,
    });
    expect(changes).toContainEqual({ field: 'worked', from: '3 смены', to: '2 смены' });
    const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
    expect(digits(changes.find((c) => c.field === 'totalCost')?.to)).toBe('3600000');
    // Ставка та же — событию о ней взяться неоткуда.
    expect(changes.some((c) => c.field === 'rate')).toBe(false);
  });

  it('смена единицы видна даже при том же числе: 3 смены и 3 часа — разные факты', () => {
    const changes = diffVehicleCompletion(COMPLETION, {
      ...COMPLETION,
      workedUnit: 'hours',
      rate: 2500,
      totalCost: 7500,
    });
    expect(changes).toContainEqual({ field: 'worked', from: '3 смены', to: '3 ч' });
  });

  it('своя машина без ставки: отработанное есть, суммы нет', () => {
    const changes = diffVehicleCompletion(null, {
      ...COMPLETION,
      workedUnit: 'hours',
      workedAmount: 6,
      rate: null,
      totalCost: null,
    });
    expect(changes).toContainEqual({ field: 'worked', from: '—', to: '6 ч' });
    // Ни ставки, ни суммы не было и нет — в истории об этом ни строки.
    expect(changes.some((c) => c.field === 'rate' || c.field === 'totalCost')).toBe(false);
  });
});
