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
 * называются по-разному. Оттуда же приходят подписи мёртвых статусов «Назначена» и «Смета на
 * согласовании» (Р1): заявок в них не бывает, но лента истории их показывает — переход «Новая →
 * Назначена» от 20.08 правдив, и своего перечня статусов тег не держит именно поэтому.
 *
 * Возраст ожидания приписан к тегу (Р36), а не вынесен отдельной колонкой в каждом списке:
 * «В работе · 9 дней» — это один факт, и читают его вместе. Отдельная колонка возраста в списке
 * всё равно есть — она сортируемая, а здесь возраст стоит там, где на статус смотрят.
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
  // Не «сколько стоит в этом статусе»: после Р4 колонка обнуляется от смены того, кого ждут, а не
  // статуса, — предъявленный объём работ и переданная другому исполнителю заявка статуса не меняют,
  // а ожидание начинают заново. Подсказка обязана называть то, что показано.
  return <Tooltip title="Сколько заявка ждёт того, за кем сейчас ход">{tag}</Tooltip>;
}
