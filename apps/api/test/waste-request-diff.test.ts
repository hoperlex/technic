import { describe, expect, it } from 'vitest';
import type { WasteRequestCompletionDto, WasteRequestDto } from '@technic/contracts';
import { diffWasteCompletion, diffWasteRequests } from '../src/services/waste-request-diff';

// Дифф правки заявки и её закрытия — то, из чего складывается история в карточке (ADR 0012).

const BASE: WasteRequestDto = {
  id: '11111111-1111-4111-8111-111111111111',
  num: 42,
  objectId: '22222222-2222-4222-8222-222222222222',
  objectCode: 'ОБ-1',
  objectName: 'Жилой комплекс',
  requestType: 'waste_removal',
  containerTypeId: '33333333-3333-4333-8333-333333333333',
  containerTypeName: 'Самосвал 20 м³',
  wasteTypeId: '44444444-4444-4444-8444-444444444444',
  wasteTypeName: 'Строительный мусор',
  volumeM3: 20,
  pricePerM3: 900,
  amount: 18000,
  operatorCounterpartyId: null,
  operatorName: null,
  deliveryAt: '2026-08-01T07:00:00.000Z',
  deliveryTimeUnspecified: false,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
  comment: 'Заезд со двора',
  operatorComment: '',
  status: 'new',
  cancelReason: null,
  files: [],
  tickets: [],
  vehicles: [],
  completion: null,
  version: 1,
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
};

const file = (id: string, filename: string) => ({
  id,
  filename,
  contentType: 'application/pdf',
  size: 1024,
  status: 'active' as const,
  createdAt: '2026-07-28T10:00:00.000Z',
});

const byField = (changes: { field: string }[]) => changes.map((c) => c.field);

describe('дифф правки заявки', () => {
  it('без изменений — пустой список', () => {
    expect(diffWasteRequests(BASE, { ...BASE, version: 2 })).toEqual([]);
  });

  it('объём и пересчитанная сумма показываются готовым текстом', () => {
    const changes = diffWasteRequests(BASE, {
      ...BASE,
      volumeM3: 40,
      amount: 36000,
    });
    expect(changes).toContainEqual({ field: 'volumeM3', from: '20 м³', to: '40 м³' });
    const amount = changes.find((c) => c.field === 'amount');
    // Пробел в «18 000,00 ₽» — неразрывный (ru-RU), поэтому сверяем по цифрам и знаку.
    expect(amount?.from).toMatch(/^18.000,00 ₽$/);
    expect(amount?.to).toMatch(/^36.000,00 ₽$/);
  });

  it('дата доставки — в МСК, а «время не задано» показывает только дату', () => {
    const withTime = diffWasteRequests(BASE, {
      ...BASE,
      deliveryAt: '2026-08-02T11:30:00.000Z',
    });
    expect(withTime).toContainEqual({
      field: 'deliveryAt',
      from: '01.08.2026 10:00',
      to: '02.08.2026 14:30',
    });
    const withoutTime = diffWasteRequests(BASE, { ...BASE, deliveryTimeUnspecified: true });
    expect(withoutTime).toContainEqual({
      field: 'deliveryAt',
      from: '01.08.2026 10:00',
      to: '01.08.2026',
    });
  });

  it('снятый оператор и пустой комментарий читаются как «—»', () => {
    const assigned = { ...BASE, operatorCounterpartyId: 'x', operatorName: 'ООО «Вывоз»' };
    expect(diffWasteRequests(assigned, { ...assigned, operatorName: null })).toContainEqual({
      field: 'operator',
      from: 'ООО «Вывоз»',
      to: '—',
    });
    expect(diffWasteRequests(BASE, { ...BASE, comment: '' })).toContainEqual({
      field: 'comment',
      from: 'Заезд со двора',
      to: '—',
    });
  });

  // Стороны комментария разведены (ADR 0053): правка примечания исполнителя — своё изменение, и
  // строку площадки она не трогает.
  it('комментарий исполнителя — отдельное изменение от комментария площадки', () => {
    const changes = diffWasteRequests(BASE, { ...BASE, operatorComment: 'будем после 15:00' });
    expect(changes).toEqual([{ field: 'operatorComment', from: '—', to: 'будем после 15:00' }]);
  });

  it('длинный комментарий обрезается', () => {
    const long = 'а'.repeat(400);
    const change = diffWasteRequests(BASE, { ...BASE, comment: long }).find(
      (c) => c.field === 'comment',
    );
    expect(change?.to).toHaveLength(301);
    expect(change?.to?.endsWith('…')).toBe(true);
  });

  it('файлы сравниваются по составу, а не по количеству', () => {
    const before = { ...BASE, files: [file('f1', 'акт.pdf')] };
    const after = { ...BASE, files: [file('f2', 'талон.pdf')] };
    const changes = diffWasteRequests(before, after);
    expect(changes).toContainEqual({ field: 'filesAdded', from: null, to: 'талон.pdf' });
    expect(changes).toContainEqual({ field: 'filesRemoved', from: null, to: 'акт.pdf' });
  });

  // Факт правкой заявки не меняется (ADR 0035): его предъявляет закрытие, и в истории он идёт
  // своим событием — здесь у правки о нём просто нечего сказать.
  it('состав техники прошлых закрытий в дифф правки не попадает', () => {
    const before = { ...BASE, vehicles: [] };
    const after = { ...BASE, comment: 'Другой заезд' };
    expect(byField(diffWasteRequests(before, after))).toEqual(['comment']);
  });
});

// Закрытие заявки — отдельное событие истории (ADR 0035): «выполнена» и «вывезли столько-то на
// такую-то сумму» отвечают на разные вопросы.
describe('дифф закрытия заявки', () => {
  const completion = (
    volumeM3: number,
    pricePerM3: number | null,
    totalCost: number | null,
  ): WasteRequestCompletionDto => ({
    unit: 'volume_m3',
    volumeM3,
    pricePerM3,
    totalCost,
    completedBy: BASE.createdBy,
    completedByName: BASE.createdByName,
    completedAt: '2026-08-01T12:00:00.000Z',
  });

  /** Закрытие металлолома (ADR 0067): один вес, без цены и суммы. */
  const metalCompletion = (weightTons: number): WasteRequestCompletionDto => ({
    unit: 'weight_tons',
    weightTons,
    pricePerM3: null,
    totalCost: null,
    completedBy: BASE.createdBy,
    completedByName: BASE.createdByName,
    completedAt: '2026-08-01T12:00:00.000Z',
  });

  it('первое закрытие показывает объём, цену и сумму', () => {
    const changes = diffWasteCompletion(null, completion(48, 850, 40_800));
    expect(byField(changes)).toEqual(['factVolume', 'factPrice', 'factCost']);
    expect(changes[0]).toEqual({ field: 'factVolume', from: '—', to: '48 м³' });
    expect(changes[2]?.to).toMatch(/^40.800,00 ₽$/);
  });

  // Повторное закрытие (после отката администратором) сравнивается с прошлым фактом: видно, какую
  // именно цифру исправили — ради этого закрытие и держит свою историю.
  it('повторное закрытие показывает только исправленное', () => {
    const changes = diffWasteCompletion(completion(48, 850, 40_800), completion(48, 850, 39_000));
    expect(byField(changes)).toEqual(['factCost']);
  });

  // Цены в прайсе может не быть вовсе — сумму тогда вводят руками. Событию о цене взяться
  // неоткуда («было — стало —»), а объём и сумма в истории остаются.
  it('закрытие без цены не выдумывает её', () => {
    const changes = diffWasteCompletion(null, completion(48, null, 39_000));
    expect(byField(changes)).toEqual(['factVolume', 'factCost']);
  });

  // Вес — своя строка истории (ADR 0067): у металлолома другая величина, и общая строка
  // «Вывезено» показала бы «48 → 3,2» без единиц.
  it('металлолом показывает вес и молчит о цене с суммой', () => {
    const changes = diffWasteCompletion(null, metalCompletion(3.2));
    expect(byField(changes)).toEqual(['factWeight']);
    expect(changes[0]).toEqual({ field: 'factWeight', from: '—', to: '3.2 т' });
  });

  // Возврат заявки в «Новую» стирает предъявленное: история обязана показать это строками, а не
  // молчанием — иначе цифры пропали бы из карточки, ни разу в неё не попав.
  it('снятый факт показывается пустой правой стороной', () => {
    const changes = diffWasteCompletion(metalCompletion(3.2), null);
    expect(changes).toContainEqual({ field: 'factWeight', from: '3.2 т', to: '—' });
  });
});
