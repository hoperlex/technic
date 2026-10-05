import { Tag, Typography } from 'antd';
import {
  vehicleClassificationLabel,
  weeklyItemKindLabels,
  type WeeklyRequestItemDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { formatDateOnly, formatDateTime } from '@shared/lib';
import { ExpandableCell } from '@shared/ui';

/*
 * Weekly-request cells of the common vehicle feed. A separate module rather than branches inside
 * the columns: everything a weekly row differs in is gathered here, exactly as many differences as
 * the document has own fields. There is deliberately no document-kind tag: the "НЗ-12" number
 * names the document already, and the vehicle type column stays empty for a week because a weekly
 * document has no classifier position.
 */

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** One composition item as a phrase: whose unit, what was decided about it and until when. */
function itemLine(item: WeeklyRequestItemDto): string {
  const vehicle =
    item.currentVehicleLabel ??
    vehicleClassificationLabel({
      typeName: item.vehicleTypeName ?? '',
      categoryName: item.vehicleCategoryName,
    });
  const head = [item.sourceDisplayNumber, vehicle].filter(Boolean).join(' · ');
  // Extension ("остаётся до 23.08") and a new unit (term inside the week) carry a date; a leaving
  // unit does not, because the source order already owns that date. Repeating it here would make
  // the weekly document appear to have decided more than it actually did.
  const tail = item.dateTo
    ? `${weeklyItemKindLabels[item.kind]} до ${formatDateOnly(item.dateTo)}`
    : weeklyItemKindLabels[item.kind];
  return head ? `${head} · ${tail}` : tail;
}

/**
 * The "Техника" column of a weekly row: the whole composition. A weekly document can contain ten
 * vehicles, while a regular assignment has two lines; ExpandableCell keeps both document kinds in
 * the same row-height contract. Collapsed it shows two units, enough to recognise the week, and
 * expanding reveals the composition without opening the page.
 *
 * The composition arrives from the server already narrowed to the account's scope (a lessor sees
 * only its own lines, and counts are computed over them too), so there is no filter here: a second
 * place holding the same condition would drift away from the first.
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

/**
 * Only "нужна дополнительно" (new) items carry their own on-site contact, like an ordinary order.
 * Extension and leaving items have none: their contact stayed in the order itself, and showing it
 * here would duplicate someone else's field.
 */
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
 * Weekly approval sits in the same column as order approval but is deliberately read-only in the
 * feed, even though an order has a button: approving a week moves order terms and issues forms in
 * the same transaction (docs/adr/0085-weekly-vehicle-request.md, Р6), so approving from a list
 * row would apply a document without seeing the composition being applied. The decision is made
 * on the weekly page.
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
