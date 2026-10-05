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
            // The week's state sits next to its number (ADR 0218): «created by НЗ-12» and
            // «created by НЗ-12 (annulled)» are different claims, and the second explains why the
            // order is cancelled.
            children: <WeeklyRef link={weeklyRequestPath} week={weekly.origin} />,
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
                  <WeeklyRef
                    key={`${extension.weeklyRequestId}-${extension.weekStart}`}
                    link={weeklyRequestPath}
                    week={extension}
                    note={weeklyWeekLabel(extension.weekStart)}
                  />
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

/**
 * A link to a weekly request carrying its state (ADR 0218).
 *
 * One carrier for both places that render it — the order's origin and the list of extensions:
 * a second retelling of «number plus state» would drift from the first. The route builder arrives
 * as a prop, the way this slice takes every route (`weeklyRequestPath`): the card is reusable and
 * must not know the vehicle pages' URLs.
 */
function WeeklyRef(props: {
  link: (id: string) => string;
  /** Fields come under their DTO names, so both the origin and an extension fit without a mapper. */
  week: { weeklyRequestId: string; weeklyRequestNum: number; weeklyRequestStatus: string };
  /** The parenthesised note: the week label for an extension, nothing for the origin. */
  note?: string;
}) {
  const annulled = props.week.weeklyRequestStatus === 'annulled';
  const suffix = [props.note, annulled ? 'аннулирована' : null].filter((part) => part).join(', ');
  return (
    <span>
      <EntityLink to={props.link(props.week.weeklyRequestId)} title="Открыть недельную заявку">
        {formatWeeklyRequestNumber(props.week.weeklyRequestNum)}
      </EntityLink>
      {suffix ? <Typography.Text type="secondary"> ({suffix})</Typography.Text> : null}
    </span>
  );
}
