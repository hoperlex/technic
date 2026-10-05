import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import {
  assignmentRateLabel,
  requestCustomerLabel,
  vehicleClassificationLabel,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { FilesCell } from '@entities/file';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '@entities/object';
import {
  VehicleRequestAssignmentCell,
  VehicleRequestEarlyEndTag,
  vehicleRequestTermLabel,
} from '@entities/vehicle-request';
import { WeeklyStatusTag } from '@entities/weekly-request';
import { formatDate } from '@shared/lib';
import { EntityLink, ExpandableCell, textColumn, UserAvatar } from '@shared/ui';
import type {
  VehicleRequestFeedActions,
  VehicleRequestFeedPending,
  VehicleRequestFeedRights,
  VehicleRequestFeedRow,
} from '../model/types';
import { ApprovalCell, StatusCell } from './orderStateCells';
import { RequestContactsCell } from './requestContactsCell';
import { vehicleRequestFeedActionsColumn } from './feedActionsColumn';
import {
  WeeklyApprovalCell,
  WeeklyCommentCell,
  WeeklyCompositionCell,
  WeeklyContactsCell,
} from './weeklyFeedRow';

/** Dash for a column that has no value in a weekly row by the nature of that document. */
const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * One table for three document kinds: the two vehicle request types and the weekly request
 * (docs/adr/0085-weekly-vehicle-request.md). Columns of the other kind stay empty, and every column
 * answers the weekly row with its own branch; the weekly renderers live in weeklyFeedRow so the
 * branching does not smear across this file. Empty weekly fields are meaningful: a weekly document
 * has no classification, route or files.
 *
 * The column key is also the server sort field (VEHICLE_REQUEST_SORT_FIELDS): renaming a sortable
 * key silently breaks sorting, because the server ignores unknown fields.
 *
 * Volume/mass and loading/unloading addresses have no column: only freight has them, and the list
 * is read by number, customer and term; they live in the request card. Author and request type do
 * not take columns either: they refine the number and the vehicle type as their second lines.
 */
export function vehicleRequestFeedColumns({
  actions,
  pending,
  rights,
}: {
  actions: VehicleRequestFeedActions;
  pending: VehicleRequestFeedPending;
  rights: VehicleRequestFeedRights;
}): TableColumnType<VehicleRequestFeedRow>[] {
  return [
    {
      key: 'num',
      title: '№',
      width: 190,
      sorter: true,
      // The ТС/НЗ prefix ("НЗ-12" vs "ТС-341") already names the document kind, so a separate kind
      // badge would duplicate the first thing the user reads.
      render: (_value, row) => {
        const record = row.kind === 'order' ? row.order : row.weekly;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{record.displayNumber}</div>
            <Space size={6}>
              <UserAvatar name={record.createdByName} size={18} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.createdByName}
              </Typography.Text>
            </Space>
          </div>
        );
      },
    },
    // Every column has a width: with scroll.x='max-content' a column without one grows to its
    // content, and a single long comment would bring back horizontal scroll for the whole table.
    // Customer is an object or a department (ADR 0040) in one column: a request has exactly one
    // customer, and a second column would be empty in every row. Sorting stayed on objectName
    // because the column key is the server sort field.
    textColumn<VehicleRequestFeedRow>({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_value, row) => {
        // A weekly request's customer is always a site: a week is assembled from the equipment
        // standing on an object, and a department does not order special equipment.
        if (row.kind === 'weekly') {
          return <ObjectCell name={row.weekly.objectName} address={row.weekly.objectCode} />;
        }
        const customer = requestCustomerLabel(row.order);
        return (
          <ObjectCell name={customer.text} hint={customer.hint} address={row.order.objectAddress} />
        );
      },
    }),
    {
      key: 'vehicleTypeName',
      title: 'Тип/категория',
      width: 200,
      sorter: true,
      // Intentionally empty for a weekly row: the document has no classifier position (its units
      // are many and different). A dash is more honest than a list of composition types, which
      // would read as "this was ordered" while ordering happens per item.
      render: (_value, row) => {
        if (row.kind === 'weekly') return dash;
        const request = row.order;
        return (
          <div style={{ lineHeight: 1.35 }}>
            {/* The ordered classifier position (ADR 0028): the category, or the type without one.
                A category name already starts with its type, so the type is not repeated. */}
            <div>
              {vehicleClassificationLabel({
                typeName: request.vehicleTypeName,
                categoryName: request.vehicleCategoryName,
              })}
            </div>
            {/* Request type captions are long ("Техника для работы на объекте"), so the tag wraps
                to a second line instead of stretching the column. */}
            <Tag
              color={vehicleRequestTypeColors[request.requestType]}
              style={{
                whiteSpace: 'normal',
                lineHeight: 1.25,
                maxWidth: '100%',
                wordBreak: 'break-word',
                marginTop: 2,
              }}
            >
              {vehicleRequestTypeLabels[request.requestType]}
            </Tag>
            {/* The order was caught by a linearity switch of its type (migration 0137, ADR 0107):
                the type now runs orders differently, while this one finishes the way it was
                opened. Without the tag a dispatcher sees two orders of one type behaving
                differently and no explanation on screen. The card explains it in full; here only
                the mode and the date. */}
            {request.requestType === 'special_equipment' && request.linearFrozen ? (
              <Tooltip
                title={`Тип «${request.vehicleTypeName}» переключили после того, как заявку взяли в работу: до закрытия она ведётся так, как заведена`}
              >
                <Tag color="gold" style={{ marginInlineEnd: 0, marginTop: 2 }}>
                  прежний режим: {request.linearFrozen.isLinear ? 'по дням' : 'по неделям'}, с{' '}
                  {formatDate(request.linearFrozen.at)}
                </Tag>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'term',
      title: 'Срок',
      width: 170,
      // The term lives in different fields per request type, so the server owns this sort. A week
      // sorts by its Monday: the document occupies the whole week, and that week is its term.
      sorter: true,
      // Early end (ADR 0044) is read right here: a requested one as a "ждёт визы" tag, an approved
      // one as a note about the original end. Otherwise a two-week order ending the day after
      // tomorrow looks like a typo.
      render: (_value, row) => {
        // weekLabel comes ready from the server ("17–23 августа 2026"): the portal must have no
        // second notion of a week, otherwise the list could promise days other than the ones the
        // approval will apply.
        if (row.kind === 'weekly') return row.weekly.weekLabel;
        const request = row.order;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{vehicleRequestTermLabel(request)}</div>
            {request.requestType === 'special_equipment' && (
              <VehicleRequestEarlyEndTag earlyEnd={request.earlyEnd} />
            )}
          </div>
        );
      },
    },
    {
      // Assigned equipment (ADR 0027): empty for a "Новая" request, then what took it and at what
      // rate. The rate is the second line, otherwise the list shows who went but not what it cost;
      // the lessor is the fallback for an assignment without rates.
      //
      // The cell is collapsible (VehicleRequestAssignmentCell): an order has exactly two lines
      // here, but the same column carries the weekly composition, one line per vehicle, and without
      // a height limit one such row would stretch the whole list.
      key: 'assignment',
      title: 'Техника',
      width: 200,
      render: (_value, row) =>
        row.kind === 'weekly' ? (
          <WeeklyCompositionCell weekly={row.weekly} />
        ) : (
          <VehicleRequestAssignmentCell
            assignment={row.order.assignment}
            detail={(assignment) => assignmentRateLabel(assignment) || assignment.lessorName || '—'}
          />
        ),
    },
    {
      // The route the order travels in. An empty cell means nothing by itself: a "Новая" request,
      // a rental or an on-site order has no route.
      key: 'route',
      title: 'Маршрут',
      width: 150,
      render: (_value, row) => {
        // A weekly request travels nowhere itself: routes are created for the orders it extended or
        // spawned, and each of them is visible in its own feed row.
        if (row.kind === 'weekly') return dash;
        const request = row.order;
        const route = request.route;
        if (route) {
          return (
            <div style={{ lineHeight: 1.35 }}>
              {/* The route number opens its card as a window over the list (ADR 0120): "where does
                  this order travel" is asked while standing in this row, and the answer must not
                  cost leaving the screen with its filters and page. The link is still real, so
                  Ctrl-click opens it in a neighbouring tab. */}
              <div>
                <EntityLink
                  to={actions.routeLink(route.id)}
                  title="Открыть маршрут"
                  onActivate={() => actions.openRoute(route.id)}
                >
                  {route.displayNumber}
                </EntityLink>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                строка {route.position}
                {route.hasWaybill ? ' · лист выписан' : ''}
              </Typography.Text>
            </div>
          );
        }
        // A confirmed own-fleet freight order without a route is operationally lost: no waybill
        // will be issued for it and nobody sees it in the vehicle's day, so the empty value must be
        // a warning rather than a neutral dash.
        const lost =
          request.status === 'confirmed' &&
          request.requestType === 'freight_transport' &&
          request.assignment?.ownership === 'own';
        return lost ? <Tag color="orange">Без маршрута</Tag> : dash;
      },
    },
    {
      key: 'status',
      title: 'Статус',
      width: 150,
      sorter: true,
      // The documents have different statuses with no common list: an order has five with
      // transitions (ADR 0021), a week has four of its own
      // (docs/adr/0085-weekly-vehicle-request.md). Hence different cells: for a week it is a plain
      // tag, since week transitions are decided on its page together with the composition.
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyStatusTag status={row.weekly.status} />;
        const request = row.order;
        return (
          <StatusCell
            status={request.status}
            deleted={!!request.deletedAt}
            approved={!!request.approvedAt}
            cancelReason={request.cancelReason}
            pending={pending.statusRequestId === request.id}
            onChange={(status) => actions.changeStatus(request, status)}
          />
        );
      },
    },
    {
      // Construction manager's approval (ADR 0025): without it the dispatcher does not take the
      // order into work. A week's approval means the same and sits in the same column, but is set
      // only on its page: it moves the orders' terms in the same transaction
      // (docs/adr/0085-weekly-vehicle-request.md, Р6).
      key: 'approval',
      title: 'Согласование',
      width: 160,
      sorter: true,
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyApprovalCell weekly={row.weekly} />;
        const request = row.order;
        return (
          <ApprovalCell
            status={request.status}
            deleted={!!request.deletedAt}
            approved={!!request.approvedAt}
            approvedByName={request.approvedByName}
            approvedAt={request.approvedAt}
            canApprove={rights.canApprove}
            pending={pending.approvalRequestId === request.id}
            onChange={(approved) => actions.changeApproval(request, approved)}
          />
        );
      },
    },
    {
      // Contacts per work place (requestContacts): the on-site contact for special equipment, one
      // responsible per route end for freight. They follow approval because once approved the order
      // goes into work, and work starts with a call to whoever opens the gate. The cell collapses:
      // two contacts with addresses are five or six lines and would stretch every list row.
      key: 'contacts',
      title: 'Контактные данные',
      width: 260,
      render: (_value, row) =>
        row.kind === 'weekly' ? (
          <WeeklyContactsCell weekly={row.weekly} />
        ) : (
          <RequestContactsCell request={row.order} />
        ),
    },
    textColumn<VehicleRequestFeedRow>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 260,
      // Not ellipsis: it keeps the comment on one line and cuts it exactly where the essence of the
      // order begins. Here the text wraps to the column width, and the collapsed cell shows two
      // lines, as many as the neighbouring columns take.
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyCommentCell weekly={row.weekly} />;
        const text = row.order.comment;
        return text.trim() ? (
          <ExpandableCell>
            {/* pre-line keeps the author's paragraphs from the multiline comment field. */}
            <span style={{ whiteSpace: 'pre-line' }}>{text}</span>
          </ExpandableCell>
        ) : (
          dash
        );
      },
    }),
    {
      key: 'files',
      title: 'Файлы',
      width: 110,
      // A weekly request has no files: attachments (invoice, access scheme, letter) belong to the
      // order, while a week is a decision about terms with nothing to attach.
      render: (_value, row) =>
        row.kind === 'weekly' ? dash : <FilesCell files={row.order.files} />,
    },
    vehicleRequestFeedActionsColumn({ actions, rights }),
  ];
}
