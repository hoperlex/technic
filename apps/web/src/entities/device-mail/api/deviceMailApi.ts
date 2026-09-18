import type {
  DeviceIdentityKind,
  DeviceMailBindInput,
  DeviceMailBindResultDto,
  DeviceMailQueueDto,
  DeviceMessageStatus,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

const PATH = '/device-mail';

/** Что спрашивают у очереди: продолжение и размер страницы. Оба необязательны. */
export type DeviceMailQueueParams = {
  cursor?: string;
  pageSize?: number;
};

/** Сколько писем затронет привязка — до подтверждения (Р20). Считает сервер, не портал. */
export interface DeviceMailBindTargets {
  messages: number;
}

/**
 * Очередь «Письма устройств» и три её действия (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * `createListApi` здесь не разворачивается намеренно: у очереди не страничный список со счётчиком
 * и сортировками, а лента с курсором и шапкой состояния ящиков в том же ответе
 * (`DeviceMailQueueDto`). Фабрика дала бы `total` и `page`, которых у ручки нет, — то есть поля,
 * компилирующиеся и всегда пустые.
 *
 * ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ СПРАШИВАЕТСЯ У СЕРВЕРА ОТДЕЛЬНЫМ ВОПРОСОМ, а не считается здесь: пачка
 * ищется по нормализованной подсказке внутри снимков ВСЕХ накопленных писем, а у экрана на руках
 * одна страница. Своя оценка показала бы одно число, а применилось бы другое — в том самом
 * действии, цена ошибки которого «чужая наработка в живой карточке».
 */
export const deviceMailApi = {
  queue: (query: DeviceMailQueueParams = {}) =>
    apiFetch<DeviceMailQueueDto>(`${PATH}/queue`, { query }),
  bindTargets: (messageId: string, query: { kind: DeviceIdentityKind; value: string }) =>
    apiFetch<DeviceMailBindTargets>(`${PATH}/messages/${messageId}/bind-targets`, { query }),
  bind: (messageId: string, body: DeviceMailBindInput) =>
    apiFetch<DeviceMailBindResultDto>(`${PATH}/messages/${messageId}/bind`, {
      method: 'POST',
      body,
    }),
  /**
   * «Игнорировать»: письмо разбирать не надо. Меняет СТАТУС — и потому выводит письмо не только из
   * очереди, но и из отбора пачки, который идёт по статусу. Отметка просмотра так не умеет.
   */
  ignore: (messageId: string) =>
    apiFetch<{ id: string; status: DeviceMessageStatus }>(`${PATH}/messages/${messageId}/ignore`, {
      method: 'POST',
    }),
  /** Закрывающий след очереди: `stuck`-строку иначе не убрать из выдачи ничем. */
  markReviewed: (messageId: string) =>
    apiFetch<{ id: string; reviewedAt: string }>(`${PATH}/messages/${messageId}/reviewed`, {
      method: 'POST',
    }),
  reparse: (messageId: string) =>
    apiFetch<{ status: DeviceMessageStatus }>(`${PATH}/messages/${messageId}/reparse`, {
      method: 'POST',
    }),
};
