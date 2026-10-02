import { CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  earlyEndDaysSaved,
  formatWeeklyRequestNumber,
  requestStatusColors,
  requestStatusLabels,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
  type VehicleRequestEarlyEndDto,
  type VehicleRequestTripDto,
  vehicleClassificationLabel,
  vehicleEarlyEndStatusColors,
  vehicleEarlyEndStatusLabels,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
  weeklyWeekLabel,
} from '@technic/contracts';
import { AddressCell } from '@entities/address';
import { formatDateTimeMaybe } from '@entities/request';
import { ResponsibleValue } from '@entities/user-account';
import { calendarDaysLabel, formatDate, formatDateOnly, formatDateTime } from '@shared/lib';
import { EntityLink, type ViewField } from '@shared/ui';

interface WeeklyContext {
  origin: SpecialEquipmentRequestDto['weeklyOrigin'];
  extensions: SpecialEquipmentRequestDto['weeklyExtensions'];
}

interface OverviewFieldOptions {
  request: VehicleRequestDto;
  amountText: string | null;
  earlyEndActions?: (request: VehicleRequestDto) => ReactNode;
  singleTrip: VehicleRequestTripDto | null;
  trips: VehicleRequestTripDto[] | null;
  weekly: WeeklyContext | null;
  weeklyRequestPath: (id: string) => string;
}

function EarlyEndDetails({
  earlyEnd,
  actions,
}: {
  earlyEnd: VehicleRequestEarlyEndDto;
  actions?: ReactNode;
}) {
  return (
    <div style={{ lineHeight: 1.6 }}>
      <Space size={8} wrap>
        <Tag color={vehicleEarlyEndStatusColors[earlyEnd.status]} style={{ marginInlineEnd: 0 }}>
          {vehicleEarlyEndStatusLabels[earlyEnd.status]}
        </Tag>
        <span>
          {formatDateOnly(earlyEnd.previousDateTo)} → {formatDateOnly(earlyEnd.newDateTo)}
        </span>
        {earlyEndDaysSaved(earlyEnd.previousDateTo, earlyEnd.newDateTo) != null && (
          <Typography.Text type="secondary">
            освобождается {earlyEndDaysSaved(earlyEnd.previousDateTo, earlyEnd.newDateTo)} дн.
          </Typography.Text>
        )}
      </Space>
      <div>
        <Typography.Text type="secondary">
          {earlyEnd.requestedByName} · {formatDateTime(earlyEnd.requestedAt)} — {earlyEnd.reason}
        </Typography.Text>
      </div>
      {earlyEnd.decidedAt && (
        <div>
          <Typography.Text type="secondary">
            {earlyEnd.status === 'approved' ? 'Согласовал' : 'Отклонил'}{' '}
            {earlyEnd.decidedByName ?? '—'} · {formatDateTime(earlyEnd.decidedAt)}
            {earlyEnd.decisionComment ? ` — ${earlyEnd.decisionComment}` : ''}
          </Typography.Text>
        </div>
      )}
      {actions && <div style={{ marginTop: 8 }}>{actions}</div>}
    </div>
  );
}

function termOf(request: VehicleRequestDto): ReactNode {
  if (request.requestType !== 'special_equipment') {
    return formatDateTimeMaybe(request.scheduledAt, request.scheduledTimeUnspecified);
  }
  const period = request.dateTo
    ? `${formatDateOnly(request.dateFrom)} – ${formatDateOnly(request.dateTo)}`
    : formatDateOnly(request.dateFrom);
  const days = calendarDaysLabel(request.dateFrom, request.dateTo);
  return (
    <Space size={6} wrap>
      <span>{period}</span>
      {days && <Typography.Text type="secondary">{days}</Typography.Text>}
    </Space>
  );
}

/** Fields describing what the customer ordered, before execution details. */
export function requestOverviewFields({
  request,
  amountText,
  earlyEndActions,
  singleTrip,
  trips,
  weekly,
  weeklyRequestPath,
}: OverviewFieldOptions): ViewField[] {
  return [
    {
      key: 'status',
      label: 'Статус',
      children: (
        <Tag color={requestStatusColors[request.status]}>{requestStatusLabels[request.status]}</Tag>
      ),
    },
    {
      key: 'requestType',
      label: 'Тип заявки',
      children: (
        <Tag color={vehicleRequestTypeColors[request.requestType]}>
          {vehicleRequestTypeLabels[request.requestType]}
        </Tag>
      ),
    },
    {
      key: 'approval',
      label: 'Согласование',
      full: true,
      children: request.approvedAt ? (
        <Space orientation="vertical" size={4}>
          <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
            Завизирована
          </Tag>
          <span>
            {request.approvedByName ?? '—'} · {formatDateTime(request.approvedAt)}
          </span>
        </Space>
      ) : (
        <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          Ждёт визы руководителя строительства
        </Tag>
      ),
    },
    {
      key: 'customer',
      label: request.departmentId ? 'Отдел' : 'Объект',
      full: true,
      children: request.departmentId
        ? `${request.departmentCode} — ${request.departmentName}`
        : `${request.objectCode} — ${request.objectName}`,
    },
    {
      key: 'vehicleType',
      label: 'Тип/категория',
      children: vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      }),
    },
    ...(request.requestType === 'special_equipment' && request.linearFrozen
      ? [
          {
            key: 'linearFrozen',
            label: 'Режим заказа',
            full: true,
            children: (
              <Space orientation="vertical" size={4}>
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                  прежний режим: {request.linearFrozen.isLinear ? 'по дням' : 'по неделям'}, с{' '}
                  {formatDate(request.linearFrozen.at)}
                </Tag>
                <Typography.Text type="secondary">
                  С этого числа тип «{request.vehicleTypeName}» ведёт заказы иначе, а эта заявка
                  дорабатывает так, как заведена:{' '}
                  {request.linearFrozen.isLinear
                    ? 'дни планируются в рейсах, недельные листы ЭСМ-2 портал по ней не выписывает.'
                    : 'ЭСМ-2 портал выписывает по ней сам за каждую неделю срока, дни ей не планируются.'}
                </Typography.Text>
              </Space>
            ),
          },
        ]
      : []),
    {
      key: 'term',
      label: request.requestType === 'special_equipment' ? 'Период работы' : 'Подача',
      children: termOf(request),
    },
    ...(request.requestType === 'special_equipment' && request.earlyEnd
      ? [
          {
            key: 'earlyEnd',
            label: 'Досрочное завершение',
            full: true,
            children: (
              <EarlyEndDetails earlyEnd={request.earlyEnd} actions={earlyEndActions?.(request)} />
            ),
          },
        ]
      : []),
    ...(weekly?.origin
      ? [
          {
            key: 'weeklyOrigin',
            label: 'Создан по недельной заявке',
            children: (
              <EntityLink
                to={weeklyRequestPath(weekly.origin.weeklyRequestId)}
                title="Открыть недельную заявку"
              >
                {formatWeeklyRequestNumber(weekly.origin.weeklyRequestNum)}
              </EntityLink>
            ),
          },
        ]
      : []),
    ...(weekly && weekly.extensions.length > 0
      ? [
          {
            key: 'weeklyExtensions',
            label: 'Продления',
            full: true,
            children: (
              <Space size={12} wrap>
                {weekly.extensions.map((extension) => (
                  <span key={`${extension.weeklyRequestId}-${extension.weekStart}`}>
                    <EntityLink
                      to={weeklyRequestPath(extension.weeklyRequestId)}
                      title="Открыть недельную заявку"
                    >
                      {formatWeeklyRequestNumber(extension.weeklyRequestNum)}
                    </EntityLink>{' '}
                    <Typography.Text type="secondary">
                      ({weeklyWeekLabel(extension.weekStart)})
                    </Typography.Text>
                  </span>
                ))}
              </Space>
            ),
          },
        ]
      : []),
    ...(request.requestType === 'special_equipment'
      ? [
          {
            key: 'responsible',
            label: 'Ответственный',
            children: (
              <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
            ),
          },
        ]
      : []),
    ...(trips ? [{ key: 'amount', label: 'Объём / масса', children: amountText }] : []),
    ...(singleTrip
      ? [
          {
            key: 'loading',
            label: 'Погрузка',
            full: true,
            children: <AddressCell text={singleTrip.fromLocation} meta={singleTrip.fromAddress} />,
          },
          {
            key: 'loadingResponsible',
            label: 'Ответственный за погрузку',
            children: (
              <ResponsibleValue
                name={singleTrip.fromResponsibleName}
                phone={singleTrip.fromResponsiblePhone}
              />
            ),
          },
          {
            key: 'unloading',
            label: 'Разгрузка',
            full: true,
            children: <AddressCell text={singleTrip.toLocation} meta={singleTrip.toAddress} />,
          },
          {
            key: 'unloadingResponsible',
            label: 'Ответственный за разгрузку',
            children: (
              <ResponsibleValue
                name={singleTrip.toResponsibleName}
                phone={singleTrip.toResponsiblePhone}
              />
            ),
          },
        ]
      : []),
  ];
}
