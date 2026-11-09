import { Collapse, Space, Tag, Typography } from 'antd';
import {
  mechLessorReceiptRetireReasonLabels,
  mechLessorReceiptStatusLabels,
} from '@technic/contracts';
import { formatDateTime } from '@shared/lib';
import {
  RECEIPT_REASON_LABELS,
  RECEIPT_STATUS_COLORS,
  type MechLessorReceiptLine,
} from '../model/lines';
import { MechLessorReceiptFileLink } from './MechLessorReceiptFileLink';

const secondary = { fontSize: 12 } as const;

/**
 * One version: its status, its file, who attached it and when, the decision and its words, and —
 * for a retired version — why it is no longer current. Retiring never changes the status (P1), so a
 * retired line reads «утверждён» and «заменён» at once: both facts are true.
 *
 * A waiver has no file and no author apart from the one who decided: its line names the decision.
 */
export function MechLessorReceiptVersionLine({ line }: { line: MechLessorReceiptLine }) {
  const waiver = line.status === 'waived';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <Space size={6} wrap>
        <Tag color={RECEIPT_STATUS_COLORS[line.status]} style={{ marginInlineEnd: 0 }}>
          {mechLessorReceiptStatusLabels[line.status]}
        </Tag>
        <Typography.Text strong>Версия {line.versionNo}</Typography.Text>
        {line.file && <MechLessorReceiptFileLink file={line.file} />}
      </Space>
      {!waiver && (
        <Typography.Text type="secondary" style={secondary}>
          Прикрепил {line.author} · {formatDateTime(line.createdAt)}
        </Typography.Text>
      )}
      {line.decidedAt && (
        <Typography.Text type="secondary" style={secondary}>
          {waiver ? 'Разрешил' : line.status === 'rejected' ? 'Отклонил' : 'Утвердил'}
          {line.decidedBy ? ` ${line.decidedBy}` : ''} · {formatDateTime(line.decidedAt)}
        </Typography.Text>
      )}
      {line.reason && (
        <Typography.Text style={secondary}>
          {RECEIPT_REASON_LABELS[line.status]}: {line.reason}
        </Typography.Text>
      )}
      {line.retiredAt && line.retiredReason && (
        <Typography.Text type="secondary" style={secondary}>
          Не действует: {mechLessorReceiptRetireReasonLabels[line.retiredReason]}
          {line.retiredBy ? ` · ${line.retiredBy}` : ''} · {formatDateTime(line.retiredAt)}
        </Typography.Text>
      )}
    </div>
  );
}

/**
 * «Версии чека (n)» — the retired versions, newest first, collapsed: the current one is what is
 * decided on, the rest is the evidence kept openable while the request lives (O8).
 *
 * `lines` is `null` while only the list row is on screen (its DTO carries the count, not the
 * versions); the header still says how many there are, and the fresh card fills it in.
 */
export function MechLessorReceiptVersions({
  lines,
  count,
}: {
  lines: MechLessorReceiptLine[] | null;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <Collapse
      size="small"
      ghost
      items={[
        {
          key: 'versions',
          label: `Версии чека (${count})`,
          children: lines ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {lines.map((line) => (
                <MechLessorReceiptVersionLine key={line.id} line={line} />
              ))}
            </div>
          ) : (
            <Typography.Text type="secondary">Загрузка…</Typography.Text>
          ),
        },
      ]}
    />
  );
}
