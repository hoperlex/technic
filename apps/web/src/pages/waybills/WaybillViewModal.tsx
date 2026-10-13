import dayjs from 'dayjs';
import { Space, Tag, Typography } from 'antd';
import {
  trailerCaption,
  type WaybillDto,
  waybillFormLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { WaybillIssueCheck, WaybillTripRows } from '@entities/waybill';
import { ViewFields, type ViewField, ViewModal } from '@shared/ui';

interface Props {
  /** The journal row being read; `null` closes the window. */
  waybill: WaybillDto | null;
  onClose: () => void;
}

const dateTime = (value: string) => dayjs(value).format('DD.MM.YYYY HH:mm');

/**
 * One sheet read in full: the journal row plus the two records the row has no room for — which
 * trip was printed as which task row (`waybill_trips`) and what the number was issued under
 * (`issue_warnings`), ADR 0108 items 20–21.
 *
 * Read-only on purpose and fed by the journal row, not by a read of its own: every command of the
 * sheet (print, export, cancel, files) already lives in the row, and a second set of buttons here
 * would be a second place to keep in step with the date rules. The row is the page's current
 * answer, so the window shows exactly what the line under it shows.
 */
export function WaybillViewModal({ waybill, onClose }: Props) {
  const trailer = waybill ? trailerCaption(waybill) : null;
  // An API older than the bundle (a rollback window) sends neither record; see WaybillIssueRecord.
  const trips = waybill?.trips ?? [];
  const items: ViewField[] = waybill
    ? [
        { key: 'form', label: 'Бланк', children: waybillFormLabels[waybill.formCode] },
        {
          key: 'status',
          label: 'Статус',
          children: (
            <Tag color={waybillStatusColors[waybill.status]}>
              {waybillStatusLabels[waybill.status]}
            </Tag>
          ),
        },
        {
          key: 'date',
          label: waybill.periodFrom && waybill.periodTo ? 'Период работы' : 'На дату',
          children:
            waybill.periodFrom && waybill.periodTo
              ? `${dayjs(waybill.periodFrom).format('DD.MM')} — ${dayjs(waybill.periodTo).format('DD.MM.YYYY')}`
              : dayjs(waybill.issuedForDate).format('DD.MM.YYYY'),
        },
        { key: 'route', label: 'Маршрут', children: waybill.routeNumber ?? '—' },
        {
          key: 'vehicle',
          label: 'Техника',
          full: true,
          children: trailer ? `${waybill.vehicleLabel} · ${trailer}` : waybill.vehicleLabel,
        },
        { key: 'driver', label: 'Водитель', children: waybill.driverName },
        {
          key: 'issued',
          label: 'Выдан',
          children: `${waybill.issuedByName}, ${dateTime(waybill.issuedAt)}`,
        },
        {
          key: 'talons',
          label: 'Талоны заказчиков',
          full: true,
          children:
            waybill.requests.length === 0 ? (
              '—'
            ) : (
              <Space orientation="vertical" size={0}>
                {waybill.requests.map((link) => (
                  <span key={link.requestId}>
                    {link.slot}. {link.displayNumber} — {link.objectName}
                  </span>
                ))}
              </Space>
            ),
        },
        {
          key: 'trips',
          label: 'Строки задания по ездкам',
          full: true,
          // Empty is a legitimate answer, and it is said why: a linear day is named by its coupon,
          // a relocation and a weekly ESM-2 print no trips at all.
          children:
            trips.length === 0 ? (
              <Typography.Text type="secondary">
                Ездок в листе нет. У линейного заказа строка задания — день работ; недельный лист
                ЭСМ-2 рейса не имеет вовсе
              </Typography.Text>
            ) : (
              <WaybillTripRows trips={trips} />
            ),
        },
        {
          key: 'check',
          label: 'Проверка при выписке',
          full: true,
          children: <WaybillIssueCheck check={waybill.issueWarnings} />,
        },
        ...(waybill.status === 'cancelled'
          ? [
              {
                key: 'cancelled',
                label: 'Аннулирован',
                full: true,
                children: [
                  waybill.cancelledByName,
                  waybill.cancelledAt ? dateTime(waybill.cancelledAt) : null,
                  waybill.cancelReason,
                ]
                  .filter(Boolean)
                  .join(', '),
              },
            ]
          : []),
      ]
    : [];

  return (
    <ViewModal
      title={waybill ? `Путевой лист № ${waybill.number}` : 'Путевой лист'}
      open={!!waybill}
      onClose={onClose}
      footer={null}
      destroyOnHidden
    >
      {waybill && <ViewFields items={items} />}
    </ViewModal>
  );
}
