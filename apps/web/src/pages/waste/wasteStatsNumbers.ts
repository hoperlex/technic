import type { WasteStatsFigures } from '@technic/contracts';
import { formatMoney } from '@shared/lib';

/**
 * Numbers of the waste "Statistics" tab (ADR 0209, warnings — ADR 0213) — one place for the table,
 * the site window and the total: the same figure on two screens must look the same, otherwise
 * people start reconciling them by eye.
 */

/**
 * Why a figure cannot be taken at face value: the lines of the tooltip on its warning icon. Empty —
 * the figure is complete, and no icon is drawn.
 *
 * A warning, not a caption (ADR 0213): captions like "без цены 216 м³" under every sum turned the
 * cost cell into four lines of reservations, and still did not say why the price was missing. The
 * icon keeps the cell to its figures, and the tooltip has room to name the volume and the reason.
 */
export type StatsWarning = string[];

/**
 * A caption under a figure, optionally with a warning of its own. `key` names the figure the
 * caption belongs to, so React keys never depend on the caption text.
 */
export interface StatsNote {
  key: string;
  text: string;
  warning?: StatsWarning;
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

/** "N заявок" under "Заказано" — the only caption decision Z7 keeps besides the money ones. */
export function plannedNotes(a: WasteStatsFigures): StatsNote[] {
  const n = a.requests;
  return [{ key: 'requests', text: `${n} ${pluralForm(n, ['заявка', 'заявки', 'заявок'])}` }];
}

/**
 * Where a price comes from, said once per tooltip. Without it "без цены" reads as a portal defect,
 * while the fix is a price list position — and a price reaches a request only when it is filed or
 * closed, never later (ADR 0009).
 */
const PRICE_SOURCE = 'Цена берётся из прайса вывоза, когда заявку заводят и закрывают';

/**
 * The unpriced share of a money figure. A partly priced sum is a NUMBER that is understated; a
 * wholly unpriced one is a dash (R3 of ADR 0209) — both get the icon, because a bare dash explained
 * nothing either.
 */
function unpricedWarning(unpriced: number, volume: number, whose: string): StatsWarning {
  if (unpriced <= 0 || volume <= 0) return [];
  const head =
    unpriced >= volume
      ? `Суммы нет: без цены все ${volumeText(volume)} ${whose}`
      : `Сумма неполная: без цены ${volumeText(unpriced)} из ${volumeText(volume)} ${whose}`;
  return [head, PRICE_SOURCE];
}

/**
 * What the ticket figure holds besides accepted paper (ADR 0213): readings nobody has reviewed,
 * tickets whose volume was not read, and scans the recognition could not read at all.
 *
 * After "у" the genitive is needed — "у 1 талона", "у 2 талонов", "у 21 талона".
 */
export function ticketWarning(a: WasteStatsFigures): StatsWarning {
  const lines: StatsWarning = [];
  const unconfirmed = a.ticketsUnconfirmed;
  if (unconfirmed > 0) {
    const volume = a.ticketVolumeUnconfirmedM3;
    const tickets = `${unconfirmed} ${pluralForm(unconfirmed, ['талон', 'талона', 'талонов'])}`;
    lines.push(
      volume > 0
        ? `Не подтверждено: ${tickets} на ${volumeText(volume)}`
        : `Не подтверждено: ${tickets}`,
    );
  }
  const unread = a.ticketsWithoutVolume;
  if (unread > 0) {
    lines.push(
      `Объём не прочитан у ${unread} ${pluralForm(unread, ['талона', 'талонов', 'талонов'])}`,
    );
  }
  const filesUnread = a.ticketFilesUnread;
  const filesEmpty = a.ticketFilesWithoutTickets;
  const files = filesUnread + filesEmpty;
  if (files > 0) {
    const count = `${files} ${pluralForm(files, ['файл', 'файла', 'файлов'])}`;
    const why =
      filesUnread > 0 && filesEmpty > 0
        ? `не удалось прочитать ${filesUnread}, талоны не найдены в ${filesEmpty}`
        : filesUnread > 0
          ? 'не удалось прочитать'
          : 'талоны не найдены';
    lines.push(`Не распознано: ${count} — ${why}`);
  }
  return lines;
}

/** Warning of the removed cost — the large figure of the cost cell. */
export function doneCostWarning(a: WasteStatsFigures): StatsWarning {
  return unpricedWarning(a.doneVolumeUnpricedM3, a.doneVolumeM3, 'вывезенного');
}

/**
 * Captions of the cost cell (decision Z2): the planned cost and the ticket cost, each with its own
 * warning. The ticket cost carries both kinds — the unpriced share and the unreviewed paper — since
 * a person reading "по талонам 27 000 ₽" needs to know both before trusting it. With no tickets at
 * all the caption stays "по талонам 0,00 ₽" (user decision of 29.09.2026).
 */
export function costNotes(a: WasteStatsFigures): StatsNote[] {
  return [
    {
      key: 'planned',
      text: `план ${costText(a.plannedCost)}`,
      warning: unpricedWarning(a.plannedVolumeUnpricedM3, a.plannedVolumeM3, 'заказанного'),
    },
    {
      key: 'tickets',
      text: `по талонам ${costText(a.ticketCost)}`,
      warning: [
        ...unpricedWarning(a.ticketVolumeUnpricedM3, a.ticketVolumeM3, 'по талонам'),
        ...ticketWarning(a),
      ],
    },
  ];
}
