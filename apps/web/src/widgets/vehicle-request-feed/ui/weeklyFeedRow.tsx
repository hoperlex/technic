import { Tag, Typography } from 'antd';
import {
  vehicleClassificationLabel,
  weeklyItemKindLabels,
  type WeeklyRequestItemDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { formatDateOnly, formatDateTime } from '@shared/lib';
import { ExpandableCell } from '@shared/ui';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** A composition item names its source/vehicle, decision and optional resulting date. */
function itemLine(item: WeeklyRequestItemDto): string {
  const vehicle =
    item.currentVehicleLabel ??
    vehicleClassificationLabel({
      typeName: item.vehicleTypeName ?? '',
      categoryName: item.vehicleCategoryName,
    });
  const head = [item.sourceDisplayNumber, vehicle].filter(Boolean).join(' · ');
  // Leave rows have no date because the source order already owns it; inventing one here would
  // make the weekly document appear to have decided more than it actually did.
  const tail = item.dateTo
    ? `${weeklyItemKindLabels[item.kind]} до ${formatDateOnly(item.dateTo)}`
    : weeklyItemKindLabels[item.kind];
  return head ? `${head} · ${tail}` : tail;
}

/**
 * A weekly document can contain ten vehicles, while a regular assignment contains two lines.
 * ExpandableCell keeps both document kinds in the same row-height contract.
 */
export function WeeklyCompositionCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  if (weekly.items.length === 0) return dash;
  return (
    <ExpandableCell>
      <div>
        {weekly.items.map((item) => (
          <div key={item.id}>{itemLine(item)}</div>
        ))}
      </div>
    </ExpandableCell>
  );
}

/** Only newly requested vehicles carry their own on-site contact in a weekly document. */
export function WeeklyContactsCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  const contacts = weekly.items.filter(
    (item) => item.kind === 'new' && item.responsibleName.trim(),
  );
  if (contacts.length === 0) return dash;
  return (
    <ExpandableCell>
      <div>
        {contacts.map((item) => (
          <div key={item.id}>
            {item.responsibleName}
            {item.responsiblePhone ? ` · +7${item.responsiblePhone}` : ''}
          </div>
        ))}
      </div>
    </ExpandableCell>
  );
}

/**
 * Weekly approval is deliberately read-only in the feed: approving it also moves order terms and
 * issues forms, so the user must review the complete composition on the weekly page first.
 */
export function WeeklyApprovalCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  if (weekly.status === 'pending') {
    return (
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
  }
  if (!weekly.approvedAt) return dash;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{weekly.approvedByName ?? '—'}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {formatDateTime(weekly.approvedAt)}
      </Typography.Text>
    </div>
  );
}

/** The document comment and cancellation reason share the order comment column. */
export function WeeklyCommentCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  const text = weekly.comment.trim();
  if (!text && !weekly.cancelReason) return dash;
  return (
    <ExpandableCell>
      <div>
        {text && <div style={{ whiteSpace: 'pre-line' }}>{text}</div>}
        {!!weekly.cancelReason && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Причина снятия: {weekly.cancelReason}
          </Typography.Text>
        )}
      </div>
    </ExpandableCell>
  );
}
