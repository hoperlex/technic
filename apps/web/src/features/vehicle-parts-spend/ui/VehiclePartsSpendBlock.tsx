import { Alert, Skeleton, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { errorMessage } from '@shared/lib';
import { EntityLink } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { formatMoney } from '../../../utils/format';

/**
 * Блок «Автозапчасти» в карточке машины (план `docs/auto-part-receipts-plan.md`, Р16): сколько на
 * эту машину потратили за период карточки и сколько за всё время.
 *
 * **Композицией, а не полем чужого ответа.** Карточка машины живёт под `vehicleReadings.read` и
 * отдаёт статистику показаний; про чеки она не знает ничего. Суммы приходят своей ручкой под
 * `garage.read` (Р5), и складывает их в один экран карточка — ровно так туда встал блок ТО
 * (ADR 0110 Р14а).
 *
 * **Право блок спрашивает сам, и без него нет ни блока, ни запроса.** Не «блок с пустотой» и не
 * «ответ, из которого сервер вырезал поля»: право, влияющее на состав чужого DTO, — то же
 * смешение прав, только спрятанное в сериализатор. Заглушки «данных нет» здесь тоже не будет —
 * она отвечала бы за чужую ручку.
 *
 * **Обе цифры из одного ответа** (§6, `VehiclePartsSpendDto`). Вторым запросом «за всё время»
 * стало бы вторым снимком, снятым в другой момент, — а на экране они стоят рядом и читаются как
 * одно утверждение. Своего сложения у блока нет вовсе: суммы считает сервер (Р11).
 *
 * **Вход в окно — ссылкой, а не кнопкой.** Окно «Запчасти машины» названо в адресе (`?spend=`,
 * Р15), и адрес этот собирает тот, кто блок поставил: разбор ключа живёт у экранов гаража, а
 * сценарий про них не знает. Ссылку присылают коллеге и открывают соседней вкладкой — кнопка не
 * умеет ни того, ни другого.
 */
export function VehiclePartsSpendBlock({
  vehicleId,
  from,
  to,
  href,
}: {
  vehicleId: string;
  /** Период карточки: первая из двух цифр отвечает ровно про него. */
  from: string;
  to: string;
  /** Адрес окна «Запчасти машины» для этой машины (`useVehicleSpendAddress().href`). */
  href: string;
}) {
  const { can } = useAuth();
  const canRead = can('garage.read');

  const query = { from, to };
  const { data, isError, error } = useQuery({
    queryKey: autoPartReceiptKeys.vehicleSpend(vehicleId, query),
    queryFn: () => autoPartReceiptApi.vehicleSpend(vehicleId, query),
    enabled: canRead,
  });

  if (!canRead) return null;

  if (isError) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Суммы по автозапчастям загрузить не удалось"
        description={errorMessage(error)}
      />
    );
  }
  if (!data) return <Skeleton active paragraph={{ rows: 1 }} />;

  return (
    <Space orientation="vertical" size={4} style={{ display: 'flex' }}>
      <Space size={8} wrap>
        <Typography.Text strong>Автозапчасти</Typography.Text>
        <EntityLink to={href} title="Открыть перечень покупок по машине">
          что купили
        </EntityLink>
      </Space>
      {/* Обе цифры рядом и в этом порядке (Р16): «за период» отвечает на вопрос карточки, «всего»
          не даёт прочитать её как всю правду о машине. */}
      <Typography.Text>
        За период: <Typography.Text strong>{formatMoney(data.total)}</Typography.Text>
        {' · '}
        Всего: <Typography.Text strong>{formatMoney(data.totalAllTime)}</Typography.Text>
      </Typography.Text>
    </Space>
  );
}
