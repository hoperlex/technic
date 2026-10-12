import type { WaybillIssueCheckDto, WaybillWarning } from '@technic/contracts';

/**
 * Under which warnings a sheet was issued — the envelope of `waybills.issue_warnings` (ADR 0108
 * item 21).
 *
 * The writer (`acknowledgeOrThrow` in `waybill-issue.ts`, the weekly ESM-2 in `waybill-esm2.ts`)
 * and the reader (`issueCheckOf`, the journal) share this module, so a new envelope version cannot
 * be written without the reader being in the same diff. The module holds no database access on
 * purpose: a plain unit test reads the very code the journal runs.
 *
 * The column default `{"schemaVersion":1,"status":"not_checked"}` is the third state and is never
 * written by the code: it marks a sheet issued before the column or by a path without the
 * handshake.
 */
export type IssueWarningsRecord =
  | { schemaVersion: 1; status: 'clean' }
  | {
      schemaVersion: 1;
      status: 'acknowledged';
      fingerprint: string;
      /** The whole list with its texts: six months later the dispute is read from it, not codes. */
      warnings: WaybillWarning[];
    };

const NOT_CHECKED: WaybillIssueCheckDto = { status: 'not_checked', warnings: [] };

/**
 * The stored envelope as the journal shows it.
 *
 * The column is jsonb and outlives the code that wrote it, so the reader trusts nothing it cannot
 * check. An envelope it cannot read reads as `not_checked`, never as `clean`: «we do not know what
 * was confirmed» must not turn into «nothing was wrong». A warning entry without a readable text is
 * dropped rather than shown as an empty line; the status still says that warnings were confirmed.
 * The fingerprint and the machine facts stay in the column: the journal shows what the person read.
 */
export function issueCheckOf(raw: unknown): WaybillIssueCheckDto {
  if (!raw || typeof raw !== 'object') return NOT_CHECKED;
  const record = raw as { schemaVersion?: unknown; status?: unknown; warnings?: unknown };
  if (record.schemaVersion !== 1) return NOT_CHECKED;
  if (record.status === 'clean') return { status: 'clean', warnings: [] };
  if (record.status !== 'acknowledged') return NOT_CHECKED;
  const stored = Array.isArray(record.warnings) ? (record.warnings as unknown[]) : [];
  const warnings = stored.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const warning = item as { facts?: { code?: unknown }; message?: unknown; entities?: unknown };
    if (typeof warning.message !== 'string' || warning.message === '') return [];
    return [
      {
        code: typeof warning.facts?.code === 'string' ? warning.facts.code : '',
        message: warning.message,
        entities: Array.isArray(warning.entities)
          ? warning.entities.filter((entity): entity is string => typeof entity === 'string')
          : [],
      },
    ];
  });
  return { status: 'acknowledged', warnings };
}
