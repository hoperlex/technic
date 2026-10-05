import { Tag, Tooltip, Typography } from 'antd';
import {
  assignmentTitle,
  type VehicleRequestAssignmentDto,
  type VehicleRequestEarlyEndDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { ExpandableCell } from '@shared/ui';

/**
 * Assigned equipment in a list row (ADR 0027): what took the request, then the note the column is
 * read for. The live feed and the history journal share this two-line shell so the "Техника"
 * column keeps the same row height on every tab; the second line remains a consumer callback
 * because the live feed shows the rate ("what did it cost") while history shows the lessor.
 *
 * The cell collapses (ExpandableCell) not for the assignment itself (two lines, nothing to hide)
 * but for the weekly composition that fills the same column with a line per vehicle. A request
 * without an assignment is a bare dash: there is nothing to collapse, and measuring would run for
 * every "Новая" request in the list.
 */
export function VehicleRequestAssignmentCell({
  assignment,
  detail,
}: {
  assignment: VehicleRequestAssignmentDto | null;
  detail: (assignment: VehicleRequestAssignmentDto) => string;
}) {
  if (!assignment) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <ExpandableCell>
      <div>{assignmentTitle(assignment)}</div>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detail(assignment)}
        </Typography.Text>
      </div>
    </ExpandableCell>
  );
}

/**
 * Early end in a list row (ADR 0044): a pending request in orange, an approved shortening as a grey
 * "срок сокращён с …" note. A pending request is shown wherever the request is visible: until
 * approval the row keeps the old term, and without the tag the site would learn about the
 * equipment leaving on the day it leaves. A rejected request is not shown: the request lives by
 * the ordered term, and the explanation is in the card.
 */
export function VehicleRequestEarlyEndTag({
  earlyEnd,
}: {
  earlyEnd: VehicleRequestEarlyEndDto | null;
}) {
  if (!earlyEnd || earlyEnd.status === 'rejected') return null;
  if (earlyEnd.status === 'pending') {
    return (
      <Tooltip title={`Запросил ${earlyEnd.requestedByName}: ${earlyEnd.reason}`}>
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          досрочно до {formatDateOnly(earlyEnd.newDateTo)} · ждёт визы
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      срок сокращён с {formatDateOnly(earlyEnd.previousDateTo)}
    </Typography.Text>
  );
}
