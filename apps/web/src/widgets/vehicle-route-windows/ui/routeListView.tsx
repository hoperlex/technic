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
      searchable: false,
      render: (_value, route) => (
        <Space orientation="vertical" size={0}>
          <Space size={6}>
            <span>{route.displayNumber}</span>
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
        const source = route.sourceRequest;
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
    actionsColumn<VehicleRouteDto>((route) => {
      const frozen = !isRouteEditable(route.waybill?.status ?? null);
      return (
        <Space>
          <RowActionButton
            title="Открыть маршрут"
            icon={<EyeOutlined />}
            onClick={() => openRoute(route.id)}
          />
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
