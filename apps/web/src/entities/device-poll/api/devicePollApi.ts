import type { DevicePollTargetDto, DevicePollTargetsDto } from '@technic/contracts';
import { apiFetch } from '@shared/api';

const PATH = '/device-poll/targets';

/**
 * Опрос аппаратов по сети (решение `docs/adr/0205-device-network-poll.md`).
 *
 * СПИСОК ЦЕЛИКОМ, БЕЗ КУРСОРА: цели живут в настройке окружения, их единицы, и читают их как один
 * набор.
 *
 * `poll` ВОЗВРАЩАЕТ ЦЕЛЬ, А НЕ ПОПЫТКУ, хотя нажатие порождает именно попытку. Так ответ на кнопку
 * и ответ на чтение списка — одной формы: экран обновляет карточку из того, что вернул сервер, а не
 * сшивает её из двух источников, которые разойдутся на первой же правке.
 */
export const devicePollApi = {
  list: () => apiFetch<DevicePollTargetsDto>(PATH),
  poll: (key: string) => apiFetch<DevicePollTargetDto>(`${PATH}/${key}/poll`, { method: 'POST' }),
};
