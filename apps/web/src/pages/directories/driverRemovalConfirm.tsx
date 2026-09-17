import { Space, Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
import {
  DRIVER_REMOVAL_ACK_REQUIRED_CODE,
  type DriverRemovalAckRequiredDetails,
} from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * Подтверждение удаления карточки водителя (план `machinist-card-removal`, Э3).
 *
 * Устроено как рукопожатие выписки (`waybillAckConfirm`) и по той же причине: портал показывает
 * цену действия **до** него и подтверждает не намерение вообще, а конкретный перечень. Отдельным
 * модулем, а не блоком вкладки: разбор тела отказа и окно — общая пара, и держать её рядом с
 * таблицей значило бы прятать правило в разметке.
 *
 * Зачем это вообще. Карточку снимали молча, не глядя на действующие заказы: человек оставался
 * напечатан в выданных листах, портал продолжал вести им бумагу, и узнавали об этом на первом же
 * продлении недели — отказом, который никто не мог объяснить (прод 14.09.2026).
 */

/** Тот ли это отказ. Проверяется и код, и форма тела: `details` приходит транспортом как `unknown`. */
export function driverRemovalDetails(e: unknown): DriverRemovalAckRequiredDetails | null {
  if (!isApiError(e) || e.code !== DRIVER_REMOVAL_ACK_REQUIRED_CODE) return null;
  const details = e.details as Partial<DriverRemovalAckRequiredDetails> | undefined;
  if (!details || typeof details.fingerprint !== 'string' || !Array.isArray(details.orders)) {
    return null;
  }
  return details as DriverRemovalAckRequiredDetails;
}

/** «2026-09-14» → «14.09.2026»: через `Date` дата поехала бы на день. */
function dateRu(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

function sheetsLabel(n: number): string {
  const last = n % 10;
  const tens = Math.floor((n % 100) / 10);
  if (tens === 1 || last === 0 || last >= 5) return `${n} листов`;
  if (last === 1) return `${n} лист`;
  return `${n} листа`;
}

/**
 * Окно со списком заказов и ценой удаления.
 *
 * Число листов приходит **посчитанным планом бумаги** и с учётом ожидающего продления (Р7): недель
 * впереди и бланков — разные числа, в неделе законно живут два листа, а у арендной единицы бумаги
 * может не быть вовсе. Диалог, назвавший кадровику неверное число, хуже диалога без числа.
 *
 * Повтором распоряжается вызывающий: отпечаток уходит к нему готовым, и повторить обязан он тем же
 * запросом, к которому сервер уже посчитал перечень.
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
                {order.customer && ` · ${order.customer}`} · до {dateRu(order.dateTo)}
                {order.assumedDateTo !== order.dateTo &&
                  ` (продление до ${dateRu(order.assumedDateTo)}${
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
    onOk: () => retry({ fingerprint: details.fingerprint }),
  });
}
