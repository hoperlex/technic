import { Space, Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
import {
  DRIVER_REMOVAL_ACK_REQUIRED_CODE,
  type DriverRemovalAckRequiredDetails,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';

/**
 * Driver removal confirmation handshake (ADR 0190). The portal confirms a concrete consequence
 * list rather than a general intention, because active orders keep printing the removed person's
 * identity on already established paper flows.
 *
 * Both dialogs intentionally consume rejected promises. A known
 * `driver_removal_ack_required` response has already been rendered by the mutation error handler;
 * rethrowing it keeps the Ant dialog open and can stack two consequence lists. Unknown errors never
 * reach these callbacks and remain visible as messages.
 */

/** First step: ordinary soft-removal confirmation before the server computes consequences. */
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
 * Consequence dialog. Sheet counts come from the server paper plan because weeks and forms are not
 * interchangeable. The caller retries the same command with the exact displayed fingerprint.
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
