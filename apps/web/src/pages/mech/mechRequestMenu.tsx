import {
  allowedStatusTransitions,
  can,
  isMechAwaitingIssue,
  isMechRentalRunning,
  MECH_DELETE_RUNNING_MESSAGE,
  mechDeleteScope,
  mechEditScope,
  mechTransitionBlocker,
  isPlaceScopedRole,
  type AuthUser,
  type MechRequestDto,
  type RequestStatus,
} from '@technic/contracts';
import type { ActionSheetItem } from '@shared/ui';

/**
 * Что можно сделать со строкой аренды — **чистая функция от заявки и субъекта**.
 *
 * Меню строится по барьерам контрактов, а не по статусу «на глаз», и это главное правило модуля
 * (Р19, Р2). Барьеров три, и они независимы: состояние записи (Б1), роль заявителя (Б2) и
 * признак архива (Б3). Тот же ответ даёт сервер, и разойтись им нельзя — иначе человек нажимал бы
 * пункт, кончающийся отказом.
 *
 * Самое заметное следствие: **после отметки выдачи пункта отмены в меню нет вовсе**. Не выключен,
 * не «спросим и откажем» — его нет: за выданную технику выставят счёт, и отмена означала бы, что
 * аренды не было. Отката в «Новую» там тоже нет, и это отдельный барьер, а не следствие первого:
 * `confirmed → new` стирает договорённость и факт по построению, и без запрета получалась бы дверь
 * в обход запрета на удаление действующей аренды.
 *
 * Удаление — единственный пункт, который **показывается выключенным**: у него есть готовый текст
 * причины (`MECH_DELETE_RUNNING_MESSAGE`), общий с отказом сервера, и молча спрятанный пункт
 * оставил бы человека гадать, куда делось действие, которое вчера было.
 */

/** Куда ведёт переход и как он называется человеку. Подписи свои, а не имена статусов. */
const TRANSITION_LABELS: Record<string, string> = {
  'new>confirmed': 'Взять в работу',
  'confirmed>done': 'Завершить аренду',
  'new>cancelled': 'Отменить заявку',
  'confirmed>cancelled': 'Отменить заявку',
  'confirmed>new': 'Вернуть в «Новую»',
  'done>confirmed': 'Вернуть в работу',
  'cancelled>new': 'Вернуть в «Новую»',
};

/** Окна, которые открывает меню; кто ими владеет — дело вызывающего (ADR 0140). */
export interface MechMenuTargets {
  takeInWork: (request: MechRequestDto) => void;
  editDeal: (request: MechRequestDto) => void;
  issue: (request: MechRequestDto) => void;
  revokeIssue: (request: MechRequestDto) => void;
  complete: (request: MechRequestDto) => void;
  cancel: (request: MechRequestDto) => void;
  rollbackToNew: (request: MechRequestDto) => void;
  edit: (request: MechRequestDto) => void;
}

/** Действия без окна: уходят прямо в запрос либо в подтверждение. */
export interface MechMenuRunners {
  /** Откат, ничего не стирающий («Выполнена» → «В работе»): объяснять нечего. */
  rollback: (request: MechRequestDto, status: RequestStatus) => void;
  duplicate: (request: MechRequestDto) => void;
  remove: (request: MechRequestDto) => void;
}

export interface MechMenuOptions {
  user: AuthUser | null;
  open: MechMenuTargets;
  run: MechMenuRunners;
}

export function mechMenuItems(
  request: MechRequestDto,
  { user, open, run }: MechMenuOptions,
): ActionSheetItem[] {
  // Архивная строка не ведётся вовсе (Б3): у неё есть только восстановление и удаление насовсем, и
  // живут они действиями вкладки «Архив», а не этим меню.
  if (request.deletedAt) return [];

  const items: ActionSheetItem[] = [];
  const mayStatus = can(user, 'mechRequests.status');
  const placeScoped = isPlaceScopedRole(user?.role);

  /*
   * Ходы по циклу — коридором прав, а барьер состояния вычитается из него отдельно: коридор
   * отвечает «что за чем идёт», а «можно ли отсюда именно этой заявке» знает только строка.
   */
  const transitions = user ? allowedStatusTransitions(request.status, user, 'mech') : [];
  for (const to of transitions) {
    if (mechTransitionBlocker(request, to)) continue;
    const key = `${request.status}>${to}`;
    const label = TRANSITION_LABELS[key];
    if (!label) continue;
    items.push({
      key: `status:${to}`,
      label,
      danger: to === 'cancelled',
      // Главный шаг «Новой» — взять её в работу: ради него список и открывают.
      primary: key === 'new>confirmed',
      onClick: () => {
        if (key === 'new>confirmed') return open.takeInWork(request);
        if (to === 'done') return open.complete(request);
        if (to === 'cancelled') return open.cancel(request);
        // Возврат в «Новую» стирает договорённость (`mechTransitionResetsDeal`) — он спрашивает
        // причину и перечисляет потерю; прочие откаты ничего не стирают и идут сразу.
        if (to === 'new') return open.rollbackToNew(request);
        return run.rollback(request, to);
      },
    });
  }

  /*
   * Выдача и её снятие — не переходы, и коридор о них не знает: аренда идёт внутри «В работе» и
   * различается полями (Р2). Право то же, что у статуса, — двигают заявку одни и те же люди.
   */
  if (mayStatus && isMechAwaitingIssue(request)) {
    items.push({
      key: 'issue',
      label: 'Отметить выдачу',
      primary: true,
      onClick: () => open.issue(request),
    });
    // Договорённость правится, пока техника не выдана, тем же правом, что её и поставило (Р19).
    // После выдачи её не правят вовсе: техника уже работает по этой ставке.
    items.push({
      key: 'deal',
      label: 'Изменить договорённость',
      onClick: () => open.editDeal(request),
    });
  }
  if (mayStatus && isMechRentalRunning(request)) {
    items.push({
      key: 'issue-revoke',
      label: 'Снять отметку выдачи',
      onClick: () => open.revokeIssue(request),
    });
  }

  /*
   * «Дублировать» (Р3): «нужны две виброплиты» — две заявки, потому что ставка задаётся за
   * единицу, а две единицы возвращают в разные дни и отрабатывают разное число часов. Право —
   * заведения: это и есть заведение новой заявки, а не копия строки.
   */
  if (can(user, 'mechRequests.create')) {
    items.push({ key: 'duplicate', label: 'Дублировать', onClick: () => run.duplicate(request) });
  }

  /*
   * Правка и удаление — не ход заявки, а распоряжение самой записью, и потому стоят ниже.
   *
   * Барьер состояния (Б1) отвечает, что вообще правится сейчас; барьер роли (Б2) — кому это
   * разрешено. Второй не заменяется первым: площадка и отдел правят заявку только в «Новой», то
   * есть ровно при полном объёме правки (`all`), а комментарий закрытой аренды — работа офиса.
   */
  const editScope = mechEditScope(request);
  if (
    can(user, 'mechRequests.update') &&
    editScope !== 'none' &&
    (!placeScoped || editScope === 'all')
  ) {
    items.push({ key: 'edit', label: 'Редактировать', onClick: () => open.edit(request) });
  }

  const deleteScope = mechDeleteScope(request);
  const mayDeleteByRole =
    can(user, 'mechRequests.delete') && (!placeScoped || request.status === 'new');
  if (mayDeleteByRole) {
    items.push({
      key: 'delete',
      label: deleteScope === 'hard' ? 'Удалить' : 'Удалить в архив',
      danger: true,
      // Действующая аренда и коррекция завершения не удаляются никем: строка ушла бы из всех
      // выборок вместе со стоимостью состоявшейся аренды.
      disabled: deleteScope === 'none',
      disabledReason: deleteScope === 'none' ? MECH_DELETE_RUNNING_MESSAGE : undefined,
      onClick: () => run.remove(request),
    });
  }

  return items;
}
