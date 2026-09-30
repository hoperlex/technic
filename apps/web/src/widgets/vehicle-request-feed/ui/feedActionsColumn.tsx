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
    // Weekly decisions require the full composition, so the feed exposes only its page.
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

    // Permanently unavailable commands are omitted. Reassignment has its own permission and may
    // remain available to a lessor who cannot edit the request itself.
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
        {/* A pending early-end decision opens the card so its reason is read before approval. */}
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
