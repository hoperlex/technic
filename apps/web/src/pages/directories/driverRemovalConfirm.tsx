import { Space, Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
import {
  DRIVER_REMOVAL_ACK_REQUIRED_CODE,
  type DriverRemovalAckRequiredDetails,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '../../utils/date';

/**
 * Подтверждение удаления карточки водителя (решение `docs/adr/0190-person-soft-removal.md`, п. 5;
 * план `machinist-card-removal`, Э3).
 *
 * Устроено как рукопожатие выписки (`waybillAckConfirm`) и по той же причине: портал показывает
 * цену действия **до** него и подтверждает не намерение вообще, а конкретный перечень. Отдельным
 * модулем, а не блоком вкладки: разбор тела отказа и оба окна — общая пара, и держать её рядом с
 * таблицей значило бы прятать правило в разметке.
 *
 * Зачем это вообще. Карточку снимали молча, не глядя на действующие заказы: человек оставался
 * напечатан в выданных листах, портал продолжал вести им бумагу, и узнавали об этом на первом же
 * продлении недели — отказом, который никто не мог объяснить (прод 14.09.2026).
 *
 * ОБА ОКНА ГАСЯТ ОТКЛОНЁННЫЙ ПРОМИС, и это не небрежность. `409 driver_removal_ack_required` —
 * половина рукопожатия, а не поломка: перечень по нему человеку уже показал `onError` мутации,
 * то есть отказ прочитан. Вернуть отклонение в antd значит получить окно, которое не закрылось
 * (второе повисло бы поверх первого — два списка заказов об одном человеке), и необработанное
 * отклонение промиса: в браузере оно уходит в консоль, в прогоне тестов роняет файл целиком.
 * Гасить позволено ровно настолько: ни один отказ, о котором человеку не сказали, сюда не попадает
 * — незнакомый код `onError` показывает тостом и окна не открывает вовсе.
 */

/**
 * Первое окно: обычное подтверждение справочника, без перечня. Живёт здесь, рядом со вторым, потому
 * что это два шага одного действия — и второе окно открывается ровно тем отказом, который вернёт
 * первое. Разнеси их по файлам, и правило гашения пришлось бы писать дважды.
 *
 * Сам запрос остаётся у вызывающего: тело первой попытки пустое, а кого снимают — знает вкладка.
 */
export function confirmDriverRemovalStart(
  modal: ModalApi,
  driver: { fullName: string },
  remove: () => Promise<unknown>,
): void {
  modal.confirm({
    title: `Удалить водителя «${driver.fullName}»?`,
    // Пометка, а не стирание: на водителя ссылаются выданные путевые листы.
    content: 'Выданные путевые листы сохранятся, но в отбор он больше не попадёт.',
    okText: 'Удалить',
    okButtonProps: { danger: true },
    cancelText: 'Отмена',
    onOk: () => remove().catch(() => undefined),
  });
}

/** Тот ли это отказ. Проверяется и код, и форма тела: `details` приходит транспортом как `unknown`. */
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
    // Гасится по правилу из шапки модуля: второй `409` приходит, когда перечень успел измениться,
    // и открыть по нему новое окно должно `onError` — поверх закрытого, а не поверх этого.
    onOk: () => retry({ fingerprint: details.fingerprint }).catch(() => undefined),
  });
}
