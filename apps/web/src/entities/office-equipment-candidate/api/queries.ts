import { queryOptions } from '@tanstack/react-query';
import { officeEquipmentCandidatesApi } from './officeEquipmentCandidatesApi';
import { officeEquipmentCandidateKeys } from './keys';

/**
 * Сколько сообщений ждёт проверки — счётчик в подписи подвкладки (§9).
 *
 * СРОКА ПРОВЕРКИ У МОДУЛЯ НЕТ ВОВСЕ (В3), и счётчик — единственное, чем очередь о себе заявляет:
 * ни таблицы сроков, ни фоновой рассылки о залежавшихся кандидатах не заводится. Поэтому число
 * стоит прямо в переключателе, а не внутри вкладки: увидеть его обязан и тот, кто пришёл смотреть
 * парк и заходить в очередь не собирался.
 *
 * Страница из одной записи, а не отдельная ручка счёта: `total` списка отвечает на тот же вопрос, а
 * своя ручка `GET /…/pending-count` была бы вторым способом посчитать одно и то же — и разошлась бы
 * с отбором очереди на первом же изменении видимости (Р9).
 *
 * Ключ — обычный ключ семейства списка, и это не совпадение: решение по кандидату гасит корень
 * целиком, и счётчик обновляется тем же гашением, что и сама очередь. Отдельное семейство пришлось
 * бы гасить вторым вызовом, и забытый вызов оставил бы в подписи вчерашнее число.
 */
const PENDING_COUNT_PARAMS = {
  page: 1,
  pageSize: 1,
  status: 'pending',
  sortBy: 'createdAt',
  sortOrder: 'asc',
} as const;

export const officeEquipmentCandidatePendingCountQuery = () =>
  queryOptions({
    queryKey: officeEquipmentCandidateKeys.list(PENDING_COUNT_PARAMS),
    queryFn: () => officeEquipmentCandidatesApi.list(PENDING_COUNT_PARAMS),
    select: (r) => r.total,
  });
