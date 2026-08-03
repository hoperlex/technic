import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@technic/contracts';
import { DESKTOP_PAGE_SIZE, MOBILE_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@shared/config';

/**
 * `shared` не импортирует контракты — правило слоя, — поэтому размеры страниц там продублированы.
 * Сверка живёт здесь: тесту контракты знать можно, а расхождение иначе всплыло бы отказом сервера
 * на первом же запросе с неподдерживаемым размером.
 */
describe('размеры страниц согласованы с контрактами', () => {
  it('переключатель предлагает ровно те размеры, что принимает сервер', () => {
    expect([...PAGE_SIZE_OPTIONS]).toEqual([...PAGE_SIZES]);
  });

  it('размер по умолчанию на десктопе — тот же, что у сервера', () => {
    expect(DESKTOP_PAGE_SIZE).toBe(DEFAULT_PAGE_SIZE);
  });

  it('мобильный размер сервер тоже принимает', () => {
    expect(PAGE_SIZES as readonly number[]).toContain(MOBILE_PAGE_SIZE);
  });
});
