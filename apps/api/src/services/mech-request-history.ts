import { desc, eq, sql } from 'drizzle-orm';
import type { RequestHistoryEntryDto, RequestHistoryKind } from '@technic/contracts';
import { db } from '../db/client';
import { mechRequestStatusHistory, users } from '../db/schema';
import { HISTORY_LIMIT, loadAuditEvents, mergeHistory } from './request-history';

// История заявки на механизацию (ADR 0012; план `docs/mechanization-module-plan.md`, Р11). Общая
// часть — в `request-history.ts`; здесь только своя таблица переходов и перечень событий аудита
// этого модуля.
//
// Реестров аудита у модуля ДВА, и путать их нельзя (§6). Здесь первый — история карточки; второй
// (`status`, `create`, `hard_delete`, `purge`) живёт только в общем журнале и в карточку не
// приходит: у трёх последних заявки после действия уже нет, а переход и его причина приезжают из
// таблицы истории статусов, где лежат оба, — событие аудита их бы только продублировало.

/**
 * События аудита, попадающие в историю заявки. Восемь — ровно те, что перечислены каноническим
 * реестром плана (Р11).
 *
 * Пропущенное здесь действие в карточку не попадёт вовсе: `loadAuditEvents` отбирает журнал по
 * этому списку. Поэтому он и сверяется тестом с реестром до элемента.
 */
const AUDIT_ACTIONS = [
  'mech_request.update',
  // Договорённость (Р11): назначена, исправлена или стёрта входом в «Новую». Без своего события
  // «была ставка 1200/час, стала 1500» не осталось бы нигде — строка помнит одно «сейчас».
  'mech_request.deal',
  // Момент, с которого пошли деньги, и его отмена. Снятие — не «правка выдачи»: после него строка
  // снова выглядит невыданной, и что выдача была, помнит одно это событие.
  'mech_request.issue',
  'mech_request.issue_revoke',
  // Продление (Э2 плана): маршрут появится следующим этапом, а место в реестре занято сразу —
  // событие с неизвестным действием приехало бы в карточку как «изменено», то есть срок аренды
  // читался бы правкой формы.
  'mech_request.extend',
  // Завершение, в том числе повторное после отката: прежние числа не сохранит ничто, кроме этой
  // записи, а именно их спрашивают, разбирая счёт.
  'mech_request.complete',
  // Имя `soft_delete` — как у всех трёх соседних модулей, а не своё `delete`.
  'mech_request.soft_delete',
  'mech_request.restore',
] as const;

/**
 * Какой вид истории означает действие. Без своего вида событие приезжает как «изменено»
 * (`auditKinds[action] ?? 'updated'`), то есть отметка выдачи читалась бы правкой.
 *
 * Архив и восстановление берут ГОТОВЫЕ виды `deleted` и `restored`, а не `updated`: у них свои
 * подписи и теги, а `changes` пуст по существу события — сведи их к правке, и карточка показала бы
 * тег «Правка» с текстом «состав изменений не записан».
 */
const AUDIT_KINDS: Record<string, RequestHistoryKind> = {
  'mech_request.update': 'updated',
  'mech_request.deal': 'mechDeal',
  'mech_request.issue': 'mechIssued',
  'mech_request.issue_revoke': 'mechIssueRevoked',
  'mech_request.extend': 'mechExtended',
  'mech_request.complete': 'completed',
  'mech_request.soft_delete': 'deleted',
  'mech_request.restore': 'restored',
};

/**
 * История заявки в хронологическом порядке. `created` — запасной вариант для заведения: обычно оно
 * есть в истории статусов (переход «— → Новая»), но у записей, заведённых в БД помимо приложения,
 * его может не быть.
 */
export async function loadMechRequestHistory(
  requestId: string,
  created: { at: Date; actorId: string; actorName: string },
): Promise<RequestHistoryEntryDto[]> {
  const [statusRows, auditRows] = await Promise.all([
    db
      .select({
        id: mechRequestStatusHistory.id,
        fromStatus: mechRequestStatusHistory.fromStatus,
        toStatus: mechRequestStatusHistory.toStatus,
        comment: mechRequestStatusHistory.comment,
        at: mechRequestStatusHistory.changedAt,
        actorId: mechRequestStatusHistory.changedBy,
        // Автор перехода в таблице обязателен (`changed_by NOT NULL`): переводов выкатом у модуля
        // нет ни одного. Пусто здесь бывает лишь от снесённой учётки — но и её `restrict` не даёт
        // снести, так что `coalesce` тут страховка формы общего типа, а не рабочий случай.
        actorName: sql<string>`coalesce(${users.fullName}, 'Портал')`,
      })
      .from(mechRequestStatusHistory)
      // Внешнее соединение, а не внутреннее: строка без автора иначе выпала бы из истории вовсе, и
      // заявка выглядела бы сменившей статус ниоткуда.
      .leftJoin(users, eq(mechRequestStatusHistory.changedBy, users.id))
      .where(eq(mechRequestStatusHistory.requestId, requestId))
      .orderBy(desc(mechRequestStatusHistory.changedAt))
      .limit(HISTORY_LIMIT),
    loadAuditEvents('mech_request', requestId, AUDIT_ACTIONS),
  ]);

  return mergeHistory({ requestId, statusRows, auditRows, auditKinds: AUDIT_KINDS, created });
}
