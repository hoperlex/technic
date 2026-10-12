import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { waybill } from './factories/waybill';
import { WaybillsPage } from '../src/pages/waybills';

/**
 * The "with trailer" caption (ADR 0138, roadmap F2b): the waybill journal, the route window and
 * the list of a vehicle's routes all take it from `trailerCaption` in the contracts.
 *
 * The defect it closes: each of the three drew the caption by the checkbox alone, so a trip ticked
 * "with trailer" with empty boxes showed a bare "с прицепом" — read as "the sheet names a
 * trailer". The checkbox and the boxes are independent, and the caption has to say which is
 * missing.
 */

const SRC = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('надпись «с прицепом»', () => {
  it('журнал листов: прицеп без реквизитов назван честно, с реквизитами — по составу', async () => {
    mockHttp({
      'GET /waybills': () =>
        json(
          list([
            waybill({ id: 'w-1', number: '260604-646-00000001', withTrailer: true }),
            waybill({
              id: 'w-2',
              number: '260604-646-00000002',
              withTrailer: true,
              trailerLabel: 'ШМИТЦ SPR-24 ВХ933277',
            }),
            waybill({ id: 'w-3', number: '260604-646-00000003' }),
          ]),
        ),
      'GET /vehicles': () => json(list([])),
      'GET /drivers': () => json(list([])),
      'GET /objects': () => json(list([])),
    });
    renderWithUser(<WaybillsPage />);
    await waitFor(() => expect(screen.getByText('260604-646-00000003')).toBeDefined());

    const row = (number: string) => screen.getByText(number).closest('tr')!.textContent ?? '';
    expect(row('260604-646-00000001')).toContain('с прицепом — реквизиты не указаны');
    expect(row('260604-646-00000002')).toContain('с прицепом ШМИТЦ SPR-24 ВХ933277');
    expect(row('260604-646-00000003')).not.toContain('прицеп');
  });

  /*
   * The other two renderers sit behind route windows that need a whole route-modal harness; what
   * matters about them is that they ask the contracts and do not assemble the caption themselves,
   * so the portal source is searched for a hand-made one: "с прицепом" followed by an
   * interpolation, in JSX ("с прицепом {…}") or in a template ("с прицепом ${…}"). Checkbox labels
   * ("Рейс с прицепом") end with the phrase and do not match.
   */
  it('портал не собирает надпись сам: ни одной интерполяции после «с прицепом»', () => {
    const handMade = sources(SRC).flatMap((file) =>
      /с прицепом\s*\$?\{/u.test(readFileSync(file, 'utf8')) ? [relative(SRC, file)] : [],
    );
    expect(handMade).toEqual([]);
  });

  it('три места надписи спрашивают контракты', () => {
    for (const file of [
      'pages/waybills/columns.tsx',
      'widgets/vehicle-route-windows/ui/VehicleRouteWindowView.tsx',
      'widgets/vehicle-route-windows/ui/routeListView.tsx',
    ]) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(/trailerCaption\(/);
    }
  });
});
