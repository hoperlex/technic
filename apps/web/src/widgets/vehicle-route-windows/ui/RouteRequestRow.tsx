import { Button, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import {
  requestStatusColors,
  requestStatusLabels,
  type VehicleRouteRequestDto,
} from '@technic/contracts';
import { EntityLink } from '@shared/ui';
import { useAuth } from '@entities/session';
import { vehicleRequestViewLink } from '@entities/vehicle-request';
import { useRouteModal } from '@features/route-modal';
import { formatDateOnly } from '@shared/lib';

/**
 * A request in the route composition: number, customer and the reason the row is in the route.
 *
 * It no longer has up/down arrows, and this is a fix rather than a simplification: print order is
 * set by route points (R11), while the composition position remains the order of **tickets** and
 * the entry point of corrections. Arrows left here would move the ticket number without changing
 * anything in the task, i.e. promise the person a different action than the one performed. The
 * "extra task, no ticket" mark is gone as well: a ticket belongs to a task line (R12), not to a
 * request, and lives in the «Задание листа» (sheet task) block; a request with six trips can have
 * one half with a ticket and the other without.
 *
 * A cancelled or closed request stays in the route as history (a sheet has already been issued for
 * it): a tag marks it, and it also blocks issuing a new sheet until it is removed.
 *
 * The request number is a link (ADR 0120, plan `docs/vehicle-routes-modal-plan.md` section 1). It
 * used to be plain text because the request lived in a neighbouring tab: following it meant
 * leaving the route being assembled, so people searched for the number in the list by hand. Now
 * the request opens as a window over the card, and "what is that job" is answered without
 * dismantling the route. That is why the row is no longer pure: `can` and `openRequest` are read
 * here rather than passed as props. The composition is rendered in one place, and threading two
 * fields through it for the sake of one number would duplicate them in the route card, where they
 * decide nothing.
 */
export function RouteRequestRow({
  item,
  frozen,
  busy,
  onDetach,
  onTransfer,
}: {
  item: VehicleRouteRequestDto;
  frozen: boolean;
  busy: boolean;
  onDetach: () => void;
  /**
   * Backdated transfer of the ticket to a route of another day (ADR 0101, R30); `null` means the
   * route is today's or there is no correction permission. The button sits on the row rather than
   * in the card footer because the **ticket** is transferred, not the route: in a frozen route this
   * is the only way to do anything with it.
   */
  onTransfer: { disabledReason: string | null; onClick: () => void } | null;
}) {
  const { can } = useAuth();
  const { openRequest } = useRouteModal();

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{item.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          {/* The number stays bold: it is the row's anchor, the thing the eye looks for in a
            composition of seven. Without the right to view requests `vehicleRequestViewLink`
            returns `null`, the number stays plain text and the window does not open at all (see
            `EntityLink`). */}
          <EntityLink
            to={vehicleRequestViewLink(can, item.requestId)}
            title="Открыть заявку"
            onActivate={() => openRequest(item.requestId)}
          >
            <strong>{item.displayNumber}</strong>
          </EntityLink>
          <span>{item.customerName}</span>
          {/* A day of a linear order (ADR 0100 section 2): the row is in the route for one day of
            the term and must read as an order day, not as an anonymous task line. The date equals
            the route day by construction; it is shown so that the composition answers "what job
            is this" without opening the request. */}
          {item.workDate && <Tag color="blue">день заказа {formatDateOnly(item.workDate)}</Tag>}
          {item.status !== 'confirmed' && (
            <Tag color={requestStatusColors[item.status]}>{requestStatusLabels[item.status]}</Tag>
          )}
        </Space>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {/* An on-site equipment order has no loading, unloading or tonnage: the day's task
              prints the site and the nature of work from the request itself (ADR 0100 decision
              10). The generic line would show a bare arrow between two empty addresses. */}
            {item.workDate
              ? 'День работ на объекте: в задание печатаются адрес площадки и характер работ'
              : `${item.loadingLocation} → ${item.unloadingLocation}${item.cargoLabel ? ` · ${item.cargoLabel}` : ''}`}
          </Typography.Text>
        </div>
      </div>
      {/* The backdated transfer is visible in a frozen route too, which is exactly where it is
        needed: the paper is issued, but the request travelled on another day. A linear day does
        not use this door (ADR 0100 item 8): the day equals its route's day, and "moving" it means
        scheduling a different day, from the request card. */}
      {onTransfer && !item.workDate && (
        <Button
          size="small"
          icon={<SwapOutlined />}
          title={onTransfer.disabledReason ?? 'Заявка ехала другим рейсом: перенести задним числом'}
          aria-label={`Перенести ${item.displayNumber} задним числом`}
          disabled={busy || !!onTransfer.disabledReason}
          onClick={onTransfer.onClick}
        />
      )}
      {!frozen && (
        <Space>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            // From the route side a linear day can be removed but not added (ADR 0100 decision 8):
            // "remove the request" would be false for it, since the request stays and only one of
            // its days goes.
            title={item.workDate ? 'Снять день с рейса' : 'Убрать из маршрута'}
            aria-label={`Убрать ${item.displayNumber}`}
            disabled={busy}
            onClick={onDetach}
          />
        </Space>
      )}
    </div>
  );
}
