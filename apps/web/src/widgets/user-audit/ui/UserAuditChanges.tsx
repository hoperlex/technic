import { Space, Typography } from 'antd';
import {
  auditChangesOf,
  describeAuditEntry,
  userAuditFieldLabels,
  type AuditChangeDto,
  type AuditEntryDto,
  type UserAuditField,
} from '@technic/contracts';

/**
 * What an event did to an account (ADR 0109): a heading and the values under it — "Role:
 * Dispatcher → Mechanic".
 *
 * One component serves both the log table and the path drawer: the event line answers the same
 * question in both places, and two copies of the markup would drift apart with the first new
 * account field. The assembly rule itself lives in contracts (`auditChangesOf`); the markup only
 * shows the result.
 */

const line = { fontSize: 12 } as const;

/** Field label; an unknown code comes from an entry written by another portal version. */
function labelOf(field: string): string {
  return userAuditFieldLabels[field as UserAuditField] ?? field;
}

/**
 * The value of a change. There are three kinds and they must stay distinct: an ordinary pair, a
 * value that appeared (an arrow from nothing only gets in the way), and an edit whose values the
 * log did not keep — for it the line honestly says there was a change, but not what it was.
 */
function valueOf(change: AuditChangeDto): string {
  if (change.to === null) return 'значения не сохранены';
  return change.from === null ? change.to : `${change.from} → ${change.to}`;
}

export function AuditChangeLines({ entry }: { entry: AuditEntryDto }) {
  const changes = auditChangesOf(entry);
  if (changes.length === 0) return null;
  return (
    <>
      {changes.map((c, i) => (
        <Typography.Text key={`${c.field}-${i}`} type="secondary" style={line}>
          {labelOf(c.field)}: {valueOf(c)}
        </Typography.Text>
      ))}
    </>
  );
}

/**
 * The whole event: what happened and what became different in the account.
 *
 * The heading stays even with an empty change list — events without values are common (password
 * reset, address confirmation), and a "—" line instead would read as a lost entry.
 */
export function AuditEventCell({ entry }: { entry: AuditEntryDto }) {
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text>{describeAuditEntry(entry)}</Typography.Text>
      <AuditChangeLines entry={entry} />
    </Space>
  );
}
