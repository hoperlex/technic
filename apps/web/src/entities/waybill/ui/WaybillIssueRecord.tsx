import { Space, Tag, Tooltip, Typography } from 'antd';
import {
  type WaybillIssueCheckDto,
  waybillIssueCheckLabels,
  type WaybillTripLinkDto,
} from '@technic/contracts';
import { type WarnedLine, WarnedLineList } from './WaybillWarnings';

/**
 * What a spent number was issued under and what it printed by trip (ADR 0108 items 20–21): the
 * reading half of the issue handshake.
 *
 * Shown in three places — the journal row, the sheet's view window and the route card — and kept
 * here so the three read one wording. The texts are the stored ones: the record answers «what did
 * the dispatcher agree to», so the portal neither re-words nor re-derives them, and the warning
 * list uses the same bullets the confirmation showed before the number was spent.
 *
 * The fields are optional here although the DTO declares them: a bundle newer than the API (the
 * `deploy-auto --previous` window, a cached tab after a rollback) gets sheets without them, and a
 * journal that crashes on a missing field is worse than one that reads «not checked». Absent reads
 * exactly as the column default does.
 */

const NOT_CHECKED: WaybillIssueCheckDto = { status: 'not_checked', warnings: [] };

function checkLines(check: WaybillIssueCheckDto): WarnedLine[] {
  // The index is part of the key: two stored warnings may share code and subject (two points with
  // the same address mismatch), and the record is never re-sorted, so position is stable here.
  return check.warnings.map((warning, index) => ({
    key: `${index}:${warning.code}:${warning.entities.join(',')}`,
    text: warning.message,
  }));
}

/** The check in full: its state in words and, when warnings were confirmed, their list. */
export function WaybillIssueCheck({ check = NOT_CHECKED }: { check?: WaybillIssueCheckDto }) {
  return (
    <Space orientation="vertical" size={4} style={{ display: 'flex' }}>
      <Typography.Text type={check.status === 'acknowledged' ? 'warning' : 'secondary'}>
        {waybillIssueCheckLabels[check.status]}
      </Typography.Text>
      {check.warnings.length > 0 && <WarnedLineList lines={checkLines(check)} />}
    </Space>
  );
}

/**
 * The journal's mark: only a sheet issued under confirmed warnings gets one.
 *
 * «Clean» and «not checked» stay silent in the row on purpose. Every sheet before migration 0136
 * and every weekly ESM-2 written by reconciliation is `not_checked`, and a tag on each of them would
 * drown the few rows that carry a decision; the view window names all three states.
 *
 * Which warnings, the tooltip says, and a hover-only tooltip on an unfocusable tag never opens from
 * the keyboard: the tab stop and the focus trigger fix that. The hidden text is for a screen reader:
 * the tooltip describes its anchor only while open, so the warnings are part of the tag's own text.
 */
export function WaybillIssueCheckTag({ check }: { check?: WaybillIssueCheckDto }) {
  if (check?.status !== 'acknowledged') return null;
  const lines = check.warnings.length > 0 ? checkLines(check) : null;
  return (
    <Tooltip
      trigger={['hover', 'focus']}
      title={lines ? <WarnedLineList lines={lines} /> : waybillIssueCheckLabels.acknowledged}
    >
      <Tag color="orange" tabIndex={0} style={{ marginInlineEnd: 0 }}>
        с предупреждениями
        <span className="visually-hidden">
          :{' '}
          {lines ? lines.map((line) => line.text).join('; ') : waybillIssueCheckLabels.acknowledged}
        </span>
      </Tag>
    </Tooltip>
  );
}

/**
 * Printed task rows by trip, in form order. A trip removed from its request later keeps its row:
 * the journal remembers what went on paper (ADR 0108 item 13a), and the number is never reused,
 * so the name still means that trip.
 */
export function WaybillTripRows({ trips }: { trips: readonly WaybillTripLinkDto[] }) {
  return (
    <Space orientation="vertical" size={0}>
      {trips.map((trip) => (
        <span key={trip.tripId}>
          {trip.slot}. {trip.displayNumber}
          {trip.deleted && (
            <Typography.Text type="secondary">
              {' '}
              — ездка удалена из заявки после выписки
            </Typography.Text>
          )}
        </span>
      ))}
    </Space>
  );
}
