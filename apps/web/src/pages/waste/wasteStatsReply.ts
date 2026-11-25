import type { WasteStatsDto, WasteStatsKind } from '@technic/contracts';
import type { WasteStatsReply } from '@entities/waste-request';

/**
 * Why a statistics reply is not shown:
 * - `outdated` — the shape of a server from before ADR 0213: the tab cannot print it;
 * - `unavailable` — snow was asked and the server did not echo `kind: 'snow'`: a server from
 *   before snow ignores the parameter and answers with garbage figures, which must never be
 *   printed under «Снег»;
 * - `mismatch` — the reply is for another month or kind, or is not a statistics reply at all.
 */
export type StatsReplyProblem = 'outdated' | 'unavailable' | 'mismatch';

export class StatsReplyError extends Error {
  constructor(readonly problem: StatsReplyProblem) {
    super(`waste stats reply: ${problem}`);
    this.name = 'StatsReplyError';
  }
}

const COUNTS = [
  'plannedVolumeM3',
  'plannedVolumeUnpricedM3',
  'doneVolumeM3',
  'doneVolumeUnpricedM3',
  'ticketVolumeM3',
  'ticketVolumeUnconfirmedM3',
  'ticketVolumeUnpricedM3',
  'ticketsWithoutVolume',
  'ticketsUnconfirmed',
  'ticketFilesUnread',
  'ticketFilesWithoutTickets',
  'removals',
  'requests',
] as const;
const MONEY = ['plannedCost', 'doneCost', 'ticketCost'] as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Every figure the tab prints is a number (money may be null): nothing reaches render unchecked. */
function hasFigures(f: unknown): boolean {
  return (
    isRecord(f) &&
    COUNTS.every((key) => isNumber(f[key])) &&
    MONEY.every((key) => f[key] === null || isNumber(f[key]))
  );
}

/** A server from before ADR 0213 sends the figures without the ticket fields of that release. */
function isOutdated(reply: Record<string, unknown>): boolean {
  return isRecord(reply.totals) && !isNumber(reply.totals.ticketVolumeM3);
}

/**
 * Checks a reply before it is cached or rendered (snow-removal plan, §3.4). The portal has no
 * error boundary: a field read from an unexpected shape throws in render and blanks the whole
 * portal, not this tab. The month and kind are compared with what was ASKED — a reply cached under
 * the key of another month or kind would print foreign figures under the selected switch.
 *
 * Garbage accepts a reply without `kind` (a server from before snow answers `?month=` as it
 * always did); snow requires the echo.
 */
export function checkedStatsReply(
  reply: WasteStatsReply,
  month: string,
  kind: WasteStatsKind,
): WasteStatsDto {
  if (!isRecord(reply)) throw new StatsReplyError('mismatch');
  const echoed = reply.kind ?? 'waste';
  if (kind === 'snow' && reply.kind !== 'snow') throw new StatsReplyError('unavailable');
  if (echoed !== kind || reply.month !== month) throw new StatsReplyError('mismatch');
  if (isOutdated(reply as unknown as Record<string, unknown>)) {
    throw new StatsReplyError('outdated');
  }
  const rows = reply.rows as unknown;
  const quality = reply.quality as unknown;
  const valid =
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        hasFigures(row) &&
        typeof row.objectId === 'string' &&
        typeof row.name === 'string' &&
        typeof row.code === 'string' &&
        Array.isArray(row.positions) &&
        row.positions.every(
          (p: unknown) => hasFigures(p) && isRecord(p) && typeof p.key === 'string',
        ),
    ) &&
    hasFigures(reply.totals) &&
    Array.isArray(quality) &&
    quality.every((q) => isRecord(q) && typeof q.key === 'string' && isNumber(q.value));
  if (!valid) throw new StatsReplyError('mismatch');
  return { ...reply, kind } as WasteStatsDto;
}
