import { EditOutlined, EyeOutlined } from '@ant-design/icons';
import { Space, Tag, Typography } from 'antd';
import {
  isRelocationPurpose,
  isRouteEditable,
  type Permission,
  ROUTE_FROZEN_MESSAGE,
  routePurposeShortLabels,
  routeRequestCapacity,
  type VehicleRouteDto,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestViewLink } from '@entities/vehicle-request';
import { waybillLink } from '@entities/waybill';
import { formatDateOnly } from '@shared/lib';
import {
  actionsColumn,
  type CardConfig,
  EntityLink,
  RowActionButton,
  textColumn,
} from '@shared/ui';

interface Args {
  can: (permission: Permission) => boolean;
  openRequest: (requestId: string) => void;
  openRoute: (routeId: string) => void;
  editRoute: (route: VehicleRouteDto) => void;
}

/** Build the desktop columns and mobile cards from the same route actions. */
export function routeListView({ can, openRequest, openRoute, editRoute }: Args) {
  const columns = [
    textColumn<VehicleRouteDto>({
      key: 'num',
      title: 'Маршрут',
      dataIndex: 'displayNumber',
      width: 140,
      // Search lives in the bar above the table: one search covers route number, plate and driver
      // surname, and a magnifier in one column header would promise searching that column only.
      searchable: false,
      render: (_value, route) => (
        <Space orientation="vertical" size={0}>
          <Space size={6}>
            <span>{route.displayNumber}</span>
            {/* A relocation sits in the same list as freight routes: it is the same vehicle's route on
                the same day, and there would be nowhere to look for it in a separate window. The
                tag marks it, and so does the different content of the "Requests" column. */}
            {isRelocationPurpose(route.purpose) && (
              <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
                {routePurposeShortLabels[route.purpose]}
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateOnly(route.routeDate)}
          </Typography.Text>
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      searchable: false,
      render: (_value, route) => (
        <Space orientation="vertical" size={0}>
          <span>{route.vehicleLabel}</span>
          {route.withTrailer && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              с прицепом {route.trailerLabel}
            </Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      searchable: false,
      width: 220,
      // A missing driver is a state, not a bug: the route was assembled in advance and the person is
      // set in the morning. But no waybill can be issued without one, so it must not stay silent.
      render: (_value, route) => route.driverName || <Tag color="orange">не назначен</Tag>,
    }),
    textColumn<VehicleRouteDto>({
      key: 'requests',
      title: 'Заявки',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 280,
      render: (_value, route) => {
        // Taken out of the row up front: type narrowing does not survive into onActivate, which runs
        // later, so TS would no longer know the field is non-null there.
        const source = route.sourceRequest;
        // A relocation has no composition: it rides on one request, and "from -> to" is its task.
        return isRelocationPurpose(route.purpose) ? (
          <Space orientation="vertical" size={0}>
            <span>
              {source ? (
                <EntityLink
                  to={vehicleRequestViewLink(can, source.requestId)}
                  title="Открыть заявку"
                  onActivate={() => openRequest(source.requestId)}
                >
                  {source.displayNumber}
                </EntityLink>
              ) : (
                '—'
              )}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {route.moveFrom} → {route.moveTo}
            </Typography.Text>
          </Space>
        ) : route.requests.length === 0 ? (
          <Typography.Text type="secondary">рейс пуст</Typography.Text>
        ) : (
          <Space orientation="vertical" size={0}>
            {/* A request number opens its card as a window over the list: route composition is read
                with "what is that request", which used to be answered by switching tabs and
                searching for the number. The link stays real (Ctrl opens a new browser tab), and
                without request rights vehicleRequestViewLink returns null, leaving plain text. */}
            {route.requests.map((item) => (
              <span key={item.requestId}>
                {item.position}.{' '}
                <EntityLink
                  to={vehicleRequestViewLink(can, item.requestId)}
                  title="Открыть заявку"
                  onActivate={() => openRequest(item.requestId)}
                >
                  {item.displayNumber}
                </EntityLink>{' '}
                — {item.customerName}
              </span>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {route.requests.length} из {routeRequestCapacity(route.formCode)} заявок
            </Typography.Text>
          </Space>
        );
      },
    }),
    textColumn<VehicleRouteDto>({
      key: 'waybill',
      title: 'Путевой лист',
      dataIndex: 'waybill',
      sortable: false,
      searchable: false,
      width: 240,
      render: (_value, route) =>
        route.waybill ? (
          <Space orientation="vertical" size={0}>
            {/* The number leads to the journal searched by this number: a waybill has no card, and
                the journal row tells what happened to the form and what it is filed with
                (ADR 0037). */}
            <span>
              <EntityLink
                to={waybillLink(can, route.waybill.number)}
                title="Открыть в журнале листов"
              >
                {route.waybill.number}
              </EntityLink>
            </span>
            <Tag color={waybillStatusColors[route.waybill.status]}>
              {waybillStatusLabels[route.waybill.status]}
            </Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">не выписан</Typography.Text>
        ),
    }),
    /*
     * Composition and waybill issue live in the card; from here a route is opened and its header
     * edited, because "move the day" and "change the driver" are morning actions that do not justify
     * opening the card. Both windows are owned by the URL-window host: the card because it is also
     * opened from the garage and the waybill journal where there is no list, the edit because it
     * must die together with the window it was opened from.
     */
    actionsColumn<VehicleRouteDto>((route) => {
      const frozen = !isRouteEditable(route.waybill?.status ?? null);
      return (
        <Space>
          <RowActionButton
            title="Открыть маршрут"
            icon={<EyeOutlined />}
            onClick={() => openRoute(route.id)}
          />
          {/* The wrapper explains the disabled button: antd shows no tooltip on a disabled one. */}
          <span title={frozen ? ROUTE_FROZEN_MESSAGE : undefined}>
            <RowActionButton
              title="Редактировать маршрут"
              icon={<EditOutlined />}
              disabled={frozen}
              onClick={() => editRoute(route)}
            />
          </span>
        </Space>
      );
    }, 110),
  ];

  // Phone card (ADR 0030): route number and date in the header, vehicle and driver as lines; a tap
  // opens the same route as the desktop "Open" button.
  const card: CardConfig<VehicleRouteDto> = {
    title: (route) => `${route.displayNumber} · ${formatDateOnly(route.routeDate)}`,
    badge: (route) =>
      route.waybill ? (
        <Tag color={waybillStatusColors[route.waybill.status]}>
          {waybillStatusLabels[route.waybill.status]}
        </Tag>
      ) : (
        <Tag>без листа</Tag>
      ),
    primary: (route) => route.vehicleLabel,
    lines: [
      (route) => route.driverName || 'водитель не назначен',
      (route) =>
        route.requests.length === 0
          ? 'рейс пуст'
          : `${route.requests.length} из ${routeRequestCapacity(route.formCode)} заявок: ${route.requests
              .map((item) => item.displayNumber)
              .join(', ')}`,
    ],
    onOpen: (route) => openRoute(route.id),
  };

  return { card, columns };
}
