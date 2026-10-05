import { Button, Space, Tag, Tooltip, type TableColumnType } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import type { VehicleRequestDto } from '@technic/contracts';
import { actionsColumn, RowActionButton } from '@shared/ui';
import type {
  VehicleRequestFeedActions,
  VehicleRequestFeedRights,
  VehicleRequestFeedRow,
} from '../model/types';

export function vehicleRequestFeedActionsColumn({
  actions,
  rights,
}: {
  actions: VehicleRequestFeedActions;
  rights: VehicleRequestFeedRights;
}): TableColumnType<VehicleRequestFeedRow> {
  // One equipment-change button for both action branches: the lessor's short branch has it too.
  const reassignButton = (request: VehicleRequestDto) => (
    <Tooltip title="Сменить технику">
      <Button
        size="small"
        icon={<SwapOutlined />}
        aria-label="Сменить технику"
        onClick={() => actions.reassign(request)}
      />
    </Tooltip>
  );

  return actionsColumn<VehicleRequestFeedRow>((row) => {
    // A weekly row has exactly one action, open the week: its composition is edited, approved and
    // cancelled on its own page, where the user sees what exactly is being approved.
    if (row.kind === 'weekly') {
      return (
        <RowActionButton
          title="Открыть неделю"
          icon={<EyeOutlined />}
          onClick={() => actions.openWeekly(row.weekly)}
        />
      );
    }

    const request = row.order;
    // The card opens for an archived order too: what was in it and why can only be understood
    // there, since the table row has neither history nor full addresses.
    const view = (
      <Tooltip title="Открыть карточку">
        <Button
          size="small"
          icon={<EyeOutlined />}
          aria-label="Открыть карточку"
          onClick={() => actions.openOrder(request)}
        />
      </Tooltip>
    );

    if (request.deletedAt) {
      return (
        <Space size={4}>
          {view}
          {rights.canRestore ? (
            <Tooltip title="Восстановить">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => actions.restore(request)}
              />
            </Tooltip>
          ) : (
            <Tag style={{ marginInlineEnd: 0 }}>в архиве</Tag>
          )}
        </Space>
      );
    }

    // A role without the right to manage requests (an observer) sees no edit/delete buttons: a
    // disabled button reads as "not now", while for this role it is "never". Equipment change has
    // its own right (ADR 0048) and is asked separately: a lessor cannot edit the request but swaps
    // its own vehicle.
    if (!rights.canEdit && !rights.canDelete) {
      return actions.canReassign(request) ? (
        <Space size={4}>
          {view}
          {reassignButton(request)}
        </Space>
      ) : (
        view
      );
    }

    const modifiable = actions.canModify(request);
    return (
      <Space size={4}>
        {view}
        {actions.canReassign(request) && reassignButton(request)}
        {/* Early end (ADR 0044): while a request awaits approval the button leads to the card,
            because the decision is made after reading the reason, and the reason is there. Without
            a pending request the shortening is requested right from here. */}
        {actions.canDecideEarlyEnd(request) ? (
          <Tooltip title="Ждёт визы на досрочное завершение">
            <Button
              size="small"
              icon={<FieldTimeOutlined />}
              onClick={() => actions.openOrder(request)}
              aria-label="Досрочное завершение ждёт визы"
            />
          </Tooltip>
        ) : (
          actions.canRequestEarlyEnd(request) && (
            <Tooltip title="Завершить досрочно">
              <Button
                size="small"
                icon={<FieldTimeOutlined />}
                onClick={() => actions.requestEarlyEnd(request)}
                aria-label="Завершить досрочно"
              />
            </Tooltip>
          )
        )}
        <Button
          size="small"
          icon={<EditOutlined />}
          disabled={!modifiable}
          onClick={() => actions.edit(request)}
        />
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={!modifiable}
          onClick={() => actions.remove(request)}
        />
      </Space>
    );
  }, 150);
}
