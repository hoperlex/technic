import { Tag, Tooltip } from 'antd';
import {
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { statusAgeLabel } from '../model/waiting';

/**
 * Статус заявки на обслуживание одним тегом. Подписи и цвета — из контрактов: те же самые видят
 * сервер в истории и письма, и расхождение означало бы, что «Ожидает приёмки» в списке и в письме
 * называются по-разному.
 *
 * Возраст ожидания приписан к тегу (Р36), а не вынесен отдельной колонкой в каждом списке:
 * «Диагностика · 9 дней» — это один факт, и читают его вместе. Отдельная колонка возраста в
 * списке всё равно есть — она сортируемая, а здесь возраст стоит там, где на статус смотрят.
 */
export function ServiceStatusTag({
  status,
  statusChangedAt,
}: {
  status: ServiceRequestStatus;
  /** Не передан — тег без возраста: в карточке рядом стоит своя строка «в статусе с …». */
  statusChangedAt?: string;
}) {
  const tag = (
    <Tag color={serviceRequestStatusColors[status]} style={{ marginInlineEnd: 0 }}>
      {serviceRequestStatusLabels[status]}
      {statusChangedAt ? ` · ${statusAgeLabel(statusChangedAt)}` : ''}
    </Tag>
  );
  if (!statusChangedAt) return tag;
  return <Tooltip title="Сколько заявка стоит в этом статусе">{tag}</Tooltip>;
}
