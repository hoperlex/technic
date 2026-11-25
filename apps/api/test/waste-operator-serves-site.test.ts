import { describe, expect, it } from 'vitest';
import { wasteOperatorServesSite } from '@technic/contracts';

/**
 * The portal asks the question the server asks before it assigns an operator (snow-removal plan,
 * §3.2): a site with no links accepts anyone, a site with links only its own operators — and a link
 * to a removed operator is still a link, which the portal's operator list does not show.
 */
describe('wasteOperatorServesSite', () => {
  it('accepts any operator for a site without links', () => {
    expect(wasteOperatorServesSite([], 'a')).toBe(true);
    expect(wasteOperatorServesSite([], 'a', 0)).toBe(true);
  });

  it('accepts only a linked operator for a site with links', () => {
    expect(wasteOperatorServesSite(['a', 'b'], 'a')).toBe(true);
    expect(wasteOperatorServesSite(['a', 'b'], 'c')).toBe(false);
  });

  it('counts links to removed operators as links', () => {
    expect(wasteOperatorServesSite([], 'a', 1)).toBe(false);
    expect(wasteOperatorServesSite(['a'], 'a', 2)).toBe(true);
    expect(wasteOperatorServesSite(['b'], 'a', 1)).toBe(false);
  });
});
