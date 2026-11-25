import { describe, expect, it } from 'vitest';
import { operatorOptionsForObject } from '@entities/counterparty';

/**
 * The operator choice follows the server's binding rule (snow-removal plan, §3.2): a site without
 * any link offers every operator, a site with links offers its own — and a site whose links all
 * point at operators the list does not carry (inactive or removed) is configured, not unlinked.
 */
const operators = [
  { id: 'a', name: 'Альфа', objects: [{ id: 'site-1' }] },
  { id: 'b', name: 'Бета', objects: [] },
];

describe('operatorOptionsForObject', () => {
  it('offers every operator for a site without links', () => {
    expect(operatorOptionsForObject(operators, 'site-2', undefined, 0).map((o) => o.value)).toEqual(
      ['a', 'b'],
    );
    expect(operatorOptionsForObject(operators, 'site-2').map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('offers only the linked operators for a site with links', () => {
    expect(operatorOptionsForObject(operators, 'site-1', undefined, 1).map((o) => o.value)).toEqual(
      ['a'],
    );
  });

  it('offers nobody for a site whose every link points at an operator absent from the list', () => {
    expect(operatorOptionsForObject(operators, 'site-3', undefined, 1)).toEqual([]);
  });

  it('keeps the saved operator labelled in every case', () => {
    const options = operatorOptionsForObject(operators, 'site-3', { id: 'z', name: 'Старый' }, 2);
    expect(options.map((o) => o.value)).toEqual(['z']);
  });
});
