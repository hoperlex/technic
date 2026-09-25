import type { WasteStatsFigures } from '@technic/contracts';
import { formatMoney } from '@shared/lib';

/**
 * Numbers of the waste "Statistics" tab (ADR 0209) — one place for the table, the site window and
 * the total: the same figure on two screens must look the same, otherwise people start reconciling
 * them by eye.
 */

/**
 * A caption under a figure. `key` names the figure the caption belongs to: two captions of one
 * cell may read the same ("без цены 5 м³" under the removed cost and under the tickets), and React
 * keys must not collide.
 */
export interface StatsNote {
  key: string;
  text: string;
}

/**
 * "412,5 м³". Digit groups with spaces, up to three decimals and no trailing zeros: a completion
 * stores 0.001 m3, but people write "40 м³", not "40,000".
 *
 * A missing number prints a dash instead of throwing: a new build may talk to an old server (the
 * rollout window, a tab that survived `deploy-auto --previous`), and there is no error boundary in
 * the portal — an exception in render would blank the whole portal, not this tab.
 */
export function volumeText(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} м³`;
}

/** Money or a dash: `null` means none of the volume has a price (ADR 0209, R3), not free work. */
export function costText(value: number | null | undefined): string {
  return value == null ? '—' : formatMoney(value);
}

/**
 * Russian plural form for a count: `forms` are [1, 2–4, 5+] — "1 заявка / 4 заявки / 5 заявок". The
 * teens (11–14) always take the third form, and the last digit decides the rest ("21 заявка").
 */
export function pluralForm(n: number, forms: readonly [string, string, string]): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/** A share is signed only when it is PART of the figure: the whole figure unpriced is a dash. */
function partlyUnpriced(unpriced: number, volume: number): boolean {
  return unpriced > 0 && unpriced < volume;
}

/** "N заявок" under "Заказано" — the only caption decision Z7 keeps besides the reliability ones. */
export function plannedNotes(a: WasteStatsFigures): StatsNote[] {
  const n = a.requests;
  return [{ key: 'requests', text: `${n} ${pluralForm(n, ['заявка', 'заявки', 'заявок'])}` }];
}

/**
 * Captions of the confirmed volume. A ticket with an unread volume is unknown, not zero (R4):
 * without this caption the shortfall would be looked for in the completion, while it lies in the
 * smudged paper. After "у" the genitive is needed — "у 1 талона", "у 2 талонов", "у 21 талона".
 */
export function confirmedNotes(a: WasteStatsFigures): StatsNote[] {
  const notes: StatsNote[] = [];
  const n = a.ticketsWithoutVolume;
  if (n > 0) {
    notes.push({
      key: 'unread',
      text: `объём не прочитан у ${n} ${pluralForm(n, ['талона', 'талонов', 'талонов'])}`,
    });
  }
  if (partlyUnpriced(a.confirmedVolumeUnpricedM3, a.confirmedVolumeM3)) {
    notes.push({ key: 'unpriced', text: `без цены ${volumeText(a.confirmedVolumeUnpricedM3)}` });
  }
  return notes;
}

/**
 * Captions of the cost cell (decisions Z2, Z7). The cell's own figure is the removed cost; under it
 * go the unpriced share of the removed volume, the planned cost and the confirmed cost. The planned
 * caption carries its unpriced share in the same line, so the "без цены" captions of one cell can
 * never be mistaken for each other; the confirmed one stays under "По талонам" and is not repeated.
 * "N без цены" is not shown (Z7).
 */
export function costNotes(a: WasteStatsFigures): StatsNote[] {
  const notes: StatsNote[] = [];
  if (partlyUnpriced(a.doneVolumeUnpricedM3, a.doneVolumeM3)) {
    notes.push({ key: 'doneUnpriced', text: `без цены ${volumeText(a.doneVolumeUnpricedM3)}` });
  }
  const plan = `план ${costText(a.plannedCost)}`;
  notes.push({
    key: 'planned',
    text: partlyUnpriced(a.plannedVolumeUnpricedM3, a.plannedVolumeM3)
      ? `${plan}, без цены ${volumeText(a.plannedVolumeUnpricedM3)}`
      : plan,
  });
  notes.push({ key: 'confirmed', text: `по талонам ${costText(a.confirmedCost)}` });
  return notes;
}
