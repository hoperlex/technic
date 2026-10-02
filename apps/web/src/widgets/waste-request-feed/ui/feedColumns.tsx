import { Button, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { requestTypeColors, requestTypeLabels, type WasteRequestDto } from '@technic/contracts';
import { FilesCell } from '@entities/file';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '@entities/object';
import { formatDateTimeMaybe } from '@entities/request';
import { wasteAmountLine, wasteWeightFactLine } from '@entities/waste-request';
import { TicketCell } from '@features/waste-ticket-review';
import { formatDate } from '@shared/lib';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';
import type {
  WasteRequestFeedActions,
  WasteRequestFeedPending,
  WasteRequestFeedRights,
} from '../model/types';
import { WasteCommentCell, WasteStatusCell, WasteSubjectCell } from './feedCells';

/** Desktop columns own only row presentation and dispatch commands through the widget port. */
export function wasteRequestFeedColumns({
  actions,
  pending,
  rights,
}: {
  actions: WasteRequestFeedActions;
  pending: WasteRequestFeedPending;
  rights: WasteRequestFeedRights;
}): TableColumnType<WasteRequestDto>[] {
  return [
    {
      key: 'num',
      title: '№',
      dataIndex: 'num',
      width: 90,
      sorter: true,
      render: (_value, request) => (
        <span style={{ whiteSpace: 'nowrap' }}>{request.displayNumber}</span>
      ),
    },
    // Every column has a width so one long comment cannot stretch the max-content table.
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Объект',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_value, request) => (
        <ObjectCell name={request.objectName} address={request.objectAddress} />
      ),
    }),
    {
      key: 'containerTypeName',
      title: 'Контейнер / машина',
      dataIndex: 'containerTypeName',
      width: 230,
      sorter: true,
      render: (_value, request) => {
        const amountLine = wasteAmountLine(request);
        const weightLine = wasteWeightFactLine(request);
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>
              <WasteSubjectCell request={request} />
            </div>
            {amountLine && (
              <Typography.Text type={amountLine.tone} style={{ fontSize: 12 }}>
                {amountLine.text}
              </Typography.Text>
            )}
            {weightLine && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {weightLine}
              </Typography.Text>
            )}
          </div>
        );
      },
    },
    {
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      width: 150,
      sorter: true,
      render: (_value, request) => request.wasteTypeName ?? '—',
    },
    // Ticket review is permission-protected on both the client and endpoint (ADR 0114).
    ...(rights.canReviewTickets
      ? [
          {
            key: 'ticketBadge',
            title: 'Талоны',
            dataIndex: 'ticketBadge',
            width: 90,
            render: (_value: unknown, request: WasteRequestDto) => (
              <TicketCell request={request} onReview={actions.openTicketReview} />
            ),
          } satisfies TableColumnType<WasteRequestDto>,
        ]
      : []),
    badgeColumn<WasteRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: requestTypeLabels,
      colors: requestTypeColors,
      width: 160,
      multiline: true,
    }),
    {
      key: 'createdAt',
      title: (
        <div style={{ lineHeight: 1.2 }}>
          <div>Дата созд.</div>
          <div>Доставки</div>
        </div>
      ),
      dataIndex: 'createdAt',
      width: 130,
      sorter: true,
      render: (_value, request) => (
        <div style={{ lineHeight: 1.35, whiteSpace: 'nowrap' }}>
          <div>{formatDate(request.createdAt)}</div>
          <Typography.Text style={{ color: '#1677ff' }}>
            {formatDateTimeMaybe(request.deliveryAt, request.deliveryTimeUnspecified)}
          </Typography.Text>
        </div>
      ),
    },
    // An operator sees only its own counterparty, so repeating it in every row adds no information.
    ...(rights.isOperator
      ? []
      : [
          {
            key: 'operatorName',
            title: 'Оператор',
            dataIndex: 'operatorName',
            width: 170,
            sorter: true,
            render: (_value: unknown, request: WasteRequestDto) => request.operatorName ?? '—',
          } satisfies TableColumnType<WasteRequestDto>,
        ]),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 160,
      sorter: true,
      render: (_value, request) => (
        <WasteStatusCell
          request={request}
          pending={pending.statusRequestId === request.id}
          onChange={actions.changeStatus}
        />
      ),
    },
    // Search covers both comment sides, while sorting intentionally follows the site comment.
    textColumn<WasteRequestDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 260,
      render: (_value, request) => <WasteCommentCell request={request} collapsible />,
    }),
    {
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      width: 80,
      render: (_value, request) => <FilesCell files={request.files} />,
    },
    actionsColumn<WasteRequestDto>((request) => {
      const view = (
        <Tooltip title="Открыть карточку">
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label="Открыть карточку"
            onClick={() => actions.open(request)}
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
      if (!rights.canEdit && !rights.canDelete) return view;
      const allowed = actions.canModify(request);
      return (
        <Space size={4}>
          {view}
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!allowed}
            onClick={() => actions.edit(request)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!allowed}
            onClick={() => actions.remove(request)}
          />
        </Space>
      );
    }, 120),
  ];
}
