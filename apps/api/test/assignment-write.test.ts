import { describe, expect, it } from 'vitest';
import { resolveChangeTarget, tailVehicleOf } from '../src/services/assignment-write';
import type { AssignmentChangeRecord } from '../src/services/assignment-write';

/**
 * Чистые решения ядра записи истории
 * ([assignment-write.ts](../src/services/assignment-write.ts), план Р10, Р17).
 *
 * Оба предмета файла — те места ядра, где база не участвует вовсе, а ошибка стоит дороже всего:
 * адресация цели и определение хвоста истории. Остальное ядро проверяется на живой схеме
 * (`assignment-write.db.test.ts`) — там, где правила держат частичные UNIQUE и составной FK, и
 * проверять их на объектах в памяти значило бы проверять собственную выдумку о базе.
 *
 * Модуль пула не импортирует (Ю23), поэтому файл обходится без окружения и без базы — то же
 * свойство понадобится maintenance-скрипту массового бэкфилла на этапе 4.
 */

const row = (p: Partial<AssignmentChangeRecord> & { id: string }): AssignmentChangeRecord => ({
  requestId: 'req',
  effectiveDate: '2026-01-01',
  dimension: 'vehicle',
  vehicleId: null,
  driverPersonId: null,
  driverState: null,
  origin: 'assignment',
  changeGroupId: p.id,
  correctionId: null,
  createdBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  supersedesChangeId: null,
  supersededAt: null,
  supersededKind: null,
  ...p,
});

describe('цель команды (Р10)', () => {
  const changes = [
    row({ id: 'a', effectiveDate: '2026-03-01', vehicleId: 'v1' }),
    row({
      id: 'b',
      effectiveDate: '2026-03-01',
      vehicleId: 'v0',
      supersededAt: new Date(),
      supersededKind: 'replaced',
    }),
    row({ id: 'c', effectiveDate: '2026-04-01', dimension: 'driver', driverState: 'cleared' }),
  ];

  it('адресуется идентификатором', () => {
    expect(resolveChangeTarget(changes, { changeId: 'a' }).id).toBe('a');
  });

  it('адресуется логическим ключом — единственным адресом непроматериализованной истории', () => {
    expect(
      resolveChangeTarget(changes, { dimension: 'driver', effectiveDate: '2026-04-01' }).id,
    ).toBe('c');
  });

  /*
   * Главный случай правила: заменённая строка описывает уже отменённое решение, и правка её была бы
   * второй веткой цепочки. Логический ключ при этом указывает на ту же дату и ту же шкалу — то есть
   * отбор «по ключу» без условия актуальности спокойно вернул бы погашенную строку.
   */
  it('погашенная строка целью не бывает — ни по id, ни по ключу', () => {
    expect(() => resolveChangeTarget(changes, { changeId: 'b' })).toThrow(/заменено или отменено/);
    const key = { dimension: 'vehicle', effectiveDate: '2026-03-01' } as const;
    expect(resolveChangeTarget(changes, key).id).toBe('a');
  });

  it('несуществующая цель — отказ, а не пустой результат', () => {
    expect(() => resolveChangeTarget(changes, { changeId: 'zz' })).toThrow();
    expect(() =>
      resolveChangeTarget(changes, { dimension: 'vehicle', effectiveDate: '2026-05-01' }),
    ).toThrow();
  });
});

describe('хвост истории (Р17)', () => {
  it('это последнее по дате действия vehicle-изменение, а не последнее записанное', () => {
    // Коррекция января, заведённая сегодня, текущей машиной не становится: порядок записи и
    // порядок действия — разные вещи.
    const changes = [
      row({ id: 'march', effectiveDate: '2026-03-01', vehicleId: 'v-march' }),
      row({
        id: 'january',
        effectiveDate: '2026-01-10',
        vehicleId: 'v-january',
        createdAt: new Date('2026-08-20T10:00:00Z'),
      }),
    ];
    expect(tailVehicleOf(changes)).toBe('v-march');
  });

  it('шкала машиниста хвоста не двигает', () => {
    const changes = [
      row({ id: 'v', effectiveDate: '2026-03-01', vehicleId: 'v-march' }),
      row({
        id: 'd',
        effectiveDate: '2026-06-01',
        dimension: 'driver',
        driverState: 'set',
        driverPersonId: 'p1',
      }),
    ];
    expect(tailVehicleOf(changes)).toBe('v-march');
  });

  it('погашенные строки в счёт не идут', () => {
    const changes = [
      row({ id: 'v', effectiveDate: '2026-03-01', vehicleId: 'v-march' }),
      row({
        id: 'v2',
        effectiveDate: '2026-05-01',
        vehicleId: 'v-may',
        supersededAt: new Date(),
        supersededKind: 'cancelled',
      }),
    ];
    expect(tailVehicleOf(changes)).toBe('v-march');
  });

  it('истории нет — хвоста нет', () => {
    expect(tailVehicleOf([])).toBeNull();
  });
});
