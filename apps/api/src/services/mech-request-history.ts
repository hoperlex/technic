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
 * Audit events that reach the card history — exactly the card registry of the module plan (R11)
 * and of the visa plan (R12).
 *
 * An action missing here never reaches the card: `loadAuditEvents` selects the log by this list.
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
  // Виза площадки и её отзыв (план `docs/mechanization-approval-and-grants-plan.md`, Р12): после
  // отзыва колонки подписи пусты, и что она была — помнит одна эта запись. Отзыв бывает и
  // автоматическим — правкой по существу от того, кто визировать не может (Р11).
  'mech_request.approve',
  'mech_request.approval_revoke',
  // Продление: своё событие, потому что прежний срок строка не хранит — она помнит одно «сейчас».
  // Без вида в реестре оно приехало бы в карточку как «изменено», то есть срок аренды читался бы
  // правкой формы.
  'mech_request.extend',
  // The extension visa (ADR 0171, stage 3): the request, the refusal and the drop. The approval is
  // `mech_request.extend` above — it still means "the term moved". The request row is overwritten
  // and deleted, so these events are the only memory of the chain.
  'mech_request.extend_request',
  'mech_request.extend_reject',
  'mech_request.extend_drop',
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
  // Виды общие с заказом техники: подпись площадки — одно и то же действие во всех модулях, и
  // заводить ему свой вид значило бы дать той же строке ленты вторую подпись и второй цвет.
  'mech_request.approve': 'approved',
  'mech_request.approval_revoke': 'approvalRevoked',
  'mech_request.extend': 'mechExtended',
  'mech_request.extend_request': 'mechExtendRequested',
  'mech_request.extend_reject': 'mechExtendRejected',
  'mech_request.extend_drop': 'mechExtendDropped',
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
