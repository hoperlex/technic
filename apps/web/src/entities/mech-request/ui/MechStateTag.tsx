import { Space, Tag, Tooltip } from 'antd';
import {
  mechLessorReceiptMark,
  mechLessorReceiptMarkLabels,
  mechStateTag,
  mechStateTagLabels,
  requestStatusColors,
  requestStatusLabels,
  type MechLessorReceiptMark,
  type MechStateTagKind,
  type MechTransitionState,
} from '@technic/contracts';

/**
 * Строка, из которой тег читает всё, что ему нужно: состояние плюс причина отмены. `deletedAt` is
 * required: an archived row shows no receipt mark (lessor receipt plan, P16), and a caller that
 * forgot it must not compile into a mark on the archive.
 */
export type MechStateRow = MechTransitionState & {
  cancelReason?: string | null;
  deletedAt: string | null;
};

/**
 * Цвета тегов состояния (Р2; виза — план визы, Р13). Все три предупреждающие, но разной природы, и
 * в списке их различают глазами: «ждёт визы» золотым — ожидание чужой подписи, без которой заявку
 * не возьмут в работу; «ждёт подачи» оранжевым, как всякое ожидание в портале; «коррекция
 * завершения» — `volcano`: это не ожидание чужого действия, а недоделанная работа своей стороны.
 */
const STATE_COLORS: Record<MechStateTagKind, string> = {
  awaitingApproval: 'gold',
  awaitingIssue: 'orange',
  correction: 'volcano',
  // The same gold as the request visa: both wait for the site's signature (ADR 0171, stage 3).
  extensionPending: 'gold',
};

/**
 * Receipt marks (lessor receipt plan, P16): «ждёт визы» gold like every signature the module waits
 * for; a refusal red — the lessor has something to fix; «нет чека» orange, as every wait on the
 * portal's own side.
 */
const RECEIPT_MARK_COLORS: Record<MechLessorReceiptMark, string> = {
  pending: 'gold',
  rejected: 'red',
  missing: 'orange',
};

/**
 * The receipt mark alone: next to the state here, and on its own in the lessor's list, where every
 * rental is «В работе» (O12) and a state tag would repeat one word on every row.
 */
export function MechLessorReceiptMarkTag({ mark }: { mark: MechLessorReceiptMark }) {
  return (
    <Tag color={RECEIPT_MARK_COLORS[mark]} style={{ marginInlineEnd: 0 }}>
      {mechLessorReceiptMarkLabels[mark]}
    </Tag>
  );
}

/**
 * Состояние аренды в строке списка и в карточке: статус заявки плюс тег того, чего статус не
 * говорит.
 *
 * Статусов у модуля три, а состояний пять (Р2): «договорились, техники нет», «аренда идёт» и
 * «коррекция завершения» — это всё один `confirmed`, разведённый **полями** `actual_from` и
 * `actual_to`. Четвёртого статуса заказчик не называл, и выдумывать его нельзя, поэтому разницу и
 * несёт второй тег.
 *
 * Что именно показать, решает `mechStateTag` контрактов, а не эта разметка: тегов три, места у
 * них три (таблица, карточка телефона, окно заявки), и разойтись подписи не должны. `null` —
 * состояние читается по самому статусу, и второй ярлык рядом с ним был бы шумом.
 */
export function MechStateTag({ row }: { row: MechStateRow }) {
  const state = mechStateTag(row);
  // A second mark, not a fifth value of the state tag: the tag is the rental's single state (ADR
  // 0171 decision 13), and a receipt can wait for a visa in any of them.
  const receipt = mechLessorReceiptMark(row);
  const status = (
    <Tag color={requestStatusColors[row.status]} style={{ marginInlineEnd: 0 }}>
      {requestStatusLabels[row.status]}
    </Tag>
  );
  return (
    <Space size={4} wrap>
      {/* Причина отмены — в подсказке на теге: колонки под неё в таблице нет, а знать её нужно.
          На телефоне подсказок нет вовсе, и там причина выносится строкой карточки. */}
      {row.cancelReason ? (
        <Tooltip title={`Причина отмены: ${row.cancelReason}`}>{status}</Tooltip>
      ) : (
        status
      )}
      {state && (
        <Tag color={STATE_COLORS[state]} style={{ marginInlineEnd: 0 }}>
          {mechStateTagLabels[state]}
        </Tag>
      )}
      {receipt && <MechLessorReceiptMarkTag mark={receipt} />}
    </Space>
  );
}
