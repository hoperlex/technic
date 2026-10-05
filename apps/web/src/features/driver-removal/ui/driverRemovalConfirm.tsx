import { Space, Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
import {
  DRIVER_REMOVAL_ACK_REQUIRED_CODE,
  type DriverRemovalAckRequiredDetails,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';

/**
 * Driver removal confirmation handshake (docs/adr/0190-person-soft-removal.md, item 5). Built like
 * the waybill acknowledgement handshake and for the same reason: the portal shows the price of the
 * action before it and confirms a concrete consequence list, not a general intention.
 *
 * Why it exists: cards used to be removed silently regardless of active orders. The person stayed
 * printed on issued waybills, the portal kept issuing paper in their name, and it surfaced only at
 * the next weekly extension as a refusal nobody could explain (prod, 14.09.2026).
 *
 * Both dialogs intentionally swallow the rejected promise. A 409 driver_removal_ack_required is
 * half of the handshake, not a failure: the mutation's onError has already shown the list, so the
 * refusal has been read. Returning the rejection to antd leaves the dialog open (a second one would
 * stack on top — two order lists about one person) and produces an unhandled rejection, which goes
 * to the console in a browser and fails the whole file in a test run. Swallowing is safe exactly
 * that far: an unknown code is shown by onError as a toast and never opens a dialog.
 */

/**
 * First step: the ordinary directory confirmation, without a list. It lives next to the second
 * dialog because both are steps of one action — the second opens on exactly the refusal the first
 * returns; split across files, the swallowing rule would have to be written twice. The request
 * itself stays with the caller: the first attempt has no body, and the caller knows whom it
 * removes.
 */
export function confirmDriverRemovalStart(
  modal: ModalApi,
  driver: { fullName: string },
  remove: () => Promise<unknown>,
): void {
  modal.confirm({
    title: `Удалить водителя «${driver.fullName}»?`,
    // This is a soft removal because issued waybills still reference the person.
    content: 'Выданные путевые листы сохранятся, но в отбор он больше не попадёт.',
    okText: 'Удалить',
    okButtonProps: { danger: true },
    cancelText: 'Отмена',
    onOk: () => remove().catch(() => undefined),
  });
}

/** Validate both the error code and payload shape because transport details are `unknown`. */
export function driverRemovalDetails(e: unknown): DriverRemovalAckRequiredDetails | null {
  if (!isApiError(e) || e.code !== DRIVER_REMOVAL_ACK_REQUIRED_CODE) return null;
  const details = e.details as Partial<DriverRemovalAckRequiredDetails> | undefined;
  if (!details || typeof details.fingerprint !== 'string' || !Array.isArray(details.orders)) {
    return null;
  }
  return details as DriverRemovalAckRequiredDetails;
}

function sheetsLabel(n: number): string {
  const last = n % 10;
  const tens = Math.floor((n % 100) / 10);
  if (tens === 1 || last === 0 || last >= 5) return `${n} листов`;
  if (last === 1) return `${n} лист`;
  return `${n} листа`;
}

/**
 * Consequence dialog: the list of orders and the price of removal.
 *
 * The sheet count arrives computed by the server paper plan, including a pending extension (step R7
 * of the machinist-card-removal plan): weeks ahead and forms are different numbers — a week
 * legitimately holds two sheets, and a rental unit may have no paper at all. A dialog that tells HR
 * a wrong number is worse than one without a number. The caller owns the retry: it resends the same
 * request, for which the server computed the list, with the exact displayed fingerprint.
 */
export function confirmDriverRemoval(
  modal: ModalApi,
  details: DriverRemovalAckRequiredDetails,
  retry: (acknowledge: { fingerprint: string }) => Promise<unknown>,
): void {
  modal.confirm({
    title: `Снять карточку «${details.fullName}»?`,
    width: 640,
    okText: 'Всё равно удалить',
    okButtonProps: { danger: true },
    cancelText: 'Отмена',
    content: (
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text>
          Человек ведёт машинистом заказы — карточка снимется, а бумага по ним продолжит
          выписываться на неё:
        </Typography.Text>
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {details.orders.map((order) => (
            <li key={order.requestId}>
              <Typography.Text>
                ТС-{order.num}
                {order.customer && ` · ${order.customer}`} · до {formatDateOnly(order.dateTo)}
                {order.assumedDateTo !== order.dateTo &&
                  ` (продление до ${formatDateOnly(order.assumedDateTo)}${
                    order.pendingWeeklyNum ? ` по НЗ-${order.pendingWeeklyNum}` : ''
                  })`}
                {order.futureSheets > 0 && ` — выпишется ещё ${sheetsLabel(order.futureSheets)}`}
              </Typography.Text>
            </li>
          ))}
        </ul>
        {details.futureRouteDays > 0 && (
          <Typography.Text type="secondary">
            И рейсов будущих дней, где он за рулём: {details.futureRouteDays}.
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          Чтобы бумага пошла на другого человека, назначьте машиниста в карточке заказа — и удалите
          карточку после этого.
        </Typography.Text>
      </Space>
    ),
    // A second 409 means the list changed; onError opens the refreshed dialog after this one closes.
    onOk: () => retry({ fingerprint: details.fingerprint }).catch(() => undefined),
  });
}
