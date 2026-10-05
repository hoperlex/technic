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

/*
 * Early-end request: the date the term is asked to be cut to, why, who asked and how it ended. The
 * reason must be shown: the decision is made by it, and a rejection without it would leave the
 * request on its old term with no explanation.
 */
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

/*
 * Term: the work period for special equipment, the delivery date (and time if set) for freight. The
 * period gets its calendar-day count, the same hint as in the request form: rental length counted
 * in the head from two dates comes out wrong, and decisions are made by it.
 */
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
    // Approval (ADR 0025): the card must say not only whether it exists but who approved.
    {
      key: 'approval',
      label: 'Согласование',
      full: true,
      children: request.approvedAt ? (
        // The signature goes on a line below the tag, not beside it: in a narrow window the name
        // next to the tag gets a two-letter column and breaks mid-word.
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
      // The request customer (ADR 0040): an object shows its code, a department shows its own.
      label: request.departmentId ? 'Отдел' : 'Объект',
      full: true,
      children: request.departmentId
        ? `${request.departmentCode} — ${request.departmentName}`
        : `${request.objectCode} — ${request.objectName}`,
    },
    /*
     * What was ordered: classifier position, term, who receives the vehicle and, for freight, cargo
     * and addresses. The order goes above execution: the card is opened with "what was asked for",
     * and "what closed it" answers that question.
     *
     * Ordered classifier position (ADR 0028): the category with its specs, or the type itself when
     * it has no specs.
     */
    {
      key: 'vehicleType',
      label: 'Тип/категория',
      children: vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      }),
    },
    /*
     * The request was caught by a switch of the type's linear flag (migration 0137): the directory
     * now runs orders of this type differently, while this one finishes the way it was created. The
     * row sits right under the type because it is about the type. Without it the dispatcher sees
     * two requests of one type behaving differently and no explanation on screen.
     */
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
    /*
     * Early end (ADR 0044): the card is where the request is decided, because it is decided after
     * reading the reason, and the reason is only here. The row sits under the term it changes.
     */
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
    /*
     * The weekly request that produced this order (docs/adr/0085-weekly-vehicle-request.md, R11).
     * It sits next to the term: an order must explain its appearance, and it appeared where someone
     * decided the vehicle stays on site for another week.
     */
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
    /*
     * Extensions as a separate list row (docs/adr/0085-weekly-vehicle-request.md, R16): an order is
     * created by exactly one weekly request but extended week after week, so a single "basis" field
     * would lie by the second week. The week itself goes next to the number: it tells what the
     * extension was for.
     */
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
    // Who receives the equipment on site (migration 0062). Freight has a contact per trip end,
    // shown below next to its address.
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
    // Cargo and addresses exist only for freight: special equipment is ordered for a term.
    ...(trips ? [{ key: 'amount', label: 'Объём / масса', children: amountText }] : []),
    /*
     * A single trip is shown as a pair of addresses with contacts, exactly as requests looked
     * before multi-trip requests: a one-trip request is yesterday's request (R24), and a one-row
     * table would change the card of every existing request while adding nothing. Requests with
     * several trips get a table below the fields.
     */
    ...(singleTrip
      ? [
          {
            key: 'loading',
            label: 'Погрузка',
            full: true,
            // Address verification mark (ADR 0006), the same as in the trips table.
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
