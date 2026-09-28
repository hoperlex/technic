import { describe, expect, it } from 'vitest';
import { hasSiteLocation, objectLocation } from '../src/services/route-points';

/**
 * Whether a request's object can serve as a day's site address (ADR 0207).
 *
 * The predicate has two callers that must never disagree: `placeLinearDay` refuses a day without a
 * site address, and the day batch asks the same question before its first write so that the refusal
 * cannot arrive halfway through a batch, after «Р-» numbers are already burned. Both read
 * `hasSiteLocation`; these cases pin what it answers, including the degenerate ones the database
 * CHECK on route points would let through.
 */
describe('адресуемость площадки дня', () => {
  it('без объекта адреса нет: левое соединение отдаёт обе колонки пустыми', () => {
    expect(hasSiteLocation({ objectName: null, objectAddress: null })).toBe(false);
  });

  it('пустые наименование и адрес — адреса нет', () => {
    expect(hasSiteLocation({ objectName: '', objectAddress: '' })).toBe(false);
  });

  it('одни пробелы — адреса нет, хотя склейка даёт непустую строку', () => {
    // The joined string is " ,  ", which survives `btrim(location) <> ''`; a comma is still not an
    // address, and the driver would be sent nowhere.
    const row = { objectName: ' ', objectAddress: '  ' };
    expect(objectLocation(row).trim()).toBe(',');
    expect(hasSiteLocation(row)).toBe(false);
    expect(hasSiteLocation({ objectName: '\t', objectAddress: null })).toBe(false);
  });

  it('только наименование — адрес есть', () => {
    const row = { objectName: 'Площадка №5', objectAddress: '' };
    expect(hasSiteLocation(row)).toBe(true);
    expect(objectLocation(row)).toBe('Площадка №5');
  });

  it('только адрес — адрес есть', () => {
    const row = { objectName: '', objectAddress: 'г Москва, ул Дневная, д 5' };
    expect(hasSiteLocation(row)).toBe(true);
    expect(objectLocation(row)).toBe('г Москва, ул Дневная, д 5');
  });

  it('наименование и адрес склеиваются так, как их печатает бланк дня', () => {
    const row = { objectName: 'Площадка №5', objectAddress: 'г Москва, ул Дневная, д 5' };
    expect(hasSiteLocation(row)).toBe(true);
    expect(objectLocation(row)).toBe('Площадка №5, г Москва, ул Дневная, д 5');
  });
});
