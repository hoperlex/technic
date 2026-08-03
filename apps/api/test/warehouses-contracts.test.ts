import { describe, expect, it } from 'vitest';
import {
  createWarehouseSchema,
  updateWarehouseSchema,
  warehouseListQuerySchema,
  warehouseTitle,
} from '@technic/contracts';

// Контракт склада (ADR 0051): поставщик и адрес обязательны, всё остальное — необязательные
// уточнения, и пустая строка в них означает «не заполнено», а не «стереть смысл».

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111';

describe('контракт склада', () => {
  it('требует поставщика и адрес; метка, контакт и комментарий необязательны', () => {
    const parsed = createWarehouseSchema.parse({
      supplierId: SUPPLIER_ID,
      address: '  г. Мытищи, Олимпийский пр-т, 10  ',
    });
    expect(parsed.address).toBe('г. Мытищи, Олимпийский пр-т, 10');
    expect(parsed.name).toBe('');
    expect(parsed.contactPerson).toBe('');
    expect(parsed.contactPhone).toBe('');
    expect(parsed.comment).toBe('');
    expect(parsed.isActive).toBe(true);
  });

  it('не принимает склад без поставщика и без адреса', () => {
    expect(() =>
      createWarehouseSchema.parse({ address: 'г. Мытищи, Олимпийский пр-т, 10' }),
    ).toThrow();
    expect(() => createWarehouseSchema.parse({ supplierId: SUPPLIER_ID })).toThrow();
    expect(() =>
      createWarehouseSchema.parse({ supplierId: SUPPLIER_ID, address: '   ' }),
    ).toThrow();
    expect(() =>
      createWarehouseSchema.parse({ supplierId: 'не-uuid', address: 'Мытищи, 10' }),
    ).toThrow();
  });

  it('телефон склада необязателен, но заглушка вместо номера не проходит', () => {
    expect(
      createWarehouseSchema.parse({
        supplierId: SUPPLIER_ID,
        address: 'Мытищи, 10',
        contactPhone: '',
      }).contactPhone,
    ).toBe('');
    expect(
      createWarehouseSchema.parse({
        supplierId: SUPPLIER_ID,
        address: 'Мытищи, 10',
        contactPhone: '+7 (926) 123-45-67',
      }).contactPhone,
    ).toBe('+7 (926) 123-45-67');
    // «-» и «нет» выглядят заполненными, а номером не являются — то же правило, что у учётки.
    expect(() =>
      createWarehouseSchema.parse({
        supplierId: SUPPLIER_ID,
        address: 'Мытищи, 10',
        contactPhone: '-',
      }),
    ).toThrow();
  });

  it('правка без поля не трогает его, пустая строка — снимает значение', () => {
    const untouched = updateWarehouseSchema.parse({ address: 'Мытищи, 10' });
    expect(untouched.contactPerson).toBeUndefined();
    expect(untouched.name).toBeUndefined();
    expect(untouched.isActive).toBeUndefined();
    expect(updateWarehouseSchema.parse({ contactPerson: '' }).contactPerson).toBe('');
  });

  it('поставщика у склада можно сменить — это исправление ошибки ввода', () => {
    expect(updateWarehouseSchema.parse({ supplierId: SUPPLIER_ID }).supplierId).toBe(SUPPLIER_ID);
  });

  it('список фильтруется по поставщику и активности, сортируется по разрешённым полям', () => {
    const q = warehouseListQuerySchema.parse({
      supplierId: SUPPLIER_ID,
      isActive: 'true',
      sortBy: 'supplier',
    });
    expect(q.supplierId).toBe(SUPPLIER_ID);
    expect(q.isActive).toBe(true);
    expect(warehouseListQuerySchema.parse({}).isActive).toBeUndefined();
    expect(() => warehouseListQuerySchema.parse({ sortBy: 'contactPhone' })).toThrow();
  });

  it('называется склад адресом, метка — уточнением к нему', () => {
    expect(warehouseTitle({ address: 'Мытищи, 10', name: '' })).toBe('Мытищи, 10');
    expect(warehouseTitle({ address: 'Мытищи, 10', name: 'Основной' })).toBe(
      'Мытищи, 10 (Основной)',
    );
  });
});
