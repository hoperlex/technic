import { isClosedWasteStatus, type Permission, type RequestStatus } from '@technic/contracts';
import { canSeeArchiveTab } from '@entities/request';

type Can = (permission: Permission) => boolean;

/**
 * Заявка на вывоз мусора: рабочий список, журнал закрытых либо архив, если её удалили. Адрес
 * собирается здесь — в письмах заявки на мусор не печатаются, и второго спрашивающего у него нет.
 *
 * Вкладка выбирается по состоянию заявки, потому что вкладки делят строки между собой (ADR 0135):
 * завершённой и отменённой в рабочем списке нет вовсе, и ссылка на неё открывала бы карточку над
 * таблицей, в которой этой строки не найти. Статус необязателен: спрашивающий, у которого его нет
 * под рукой, получает рабочий список — карточка откроется и там, она грузится по номеру.
 *
 * Право на архив спрашивается у слайса заявки: своя копия предиката разошлась бы с той, которой
 * пользуется сам список.
 */
export function wasteRequestLink(
  can: Can,
  request: { id: string; deleted?: boolean; status?: RequestStatus },
): string | null {
  if (!can('wasteRequests.read')) return null;
  if (request.deleted && !canSeeArchiveTab(can)) return null;
  const tab = request.deleted
    ? 'archive'
    : request.status && isClosedWasteStatus(request.status)
      ? 'history'
      : 'requests';
  return `/waste?tab=${tab}&open=${request.id}`;
}
