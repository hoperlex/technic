import { Tag, Tooltip, Typography } from 'antd';
import {
  assignmentTitle,
  type VehicleRequestAssignmentDto,
  type VehicleRequestEarlyEndDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { ExpandableCell } from '@shared/ui';

/**
 * Assigned equipment uses the same two-line shell in the live feed and history. The second line
 * remains a consumer callback because the live feed shows the rate while history shows the lessor.
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
 * A pending early-end request must stay visible beside the unchanged term; an approved request
 * explains why the visible term is shorter. Rejected requests belong to history, not the feed.
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
