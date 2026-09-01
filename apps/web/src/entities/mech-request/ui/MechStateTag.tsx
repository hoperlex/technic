import { Space, Tag, Tooltip } from 'antd';
import {
  mechStateTag,
  mechStateTagLabels,
  requestStatusColors,
  requestStatusLabels,
  type MechRentalState,
} from '@technic/contracts';

/** Строка, из которой тег читает всё, что ему нужно: состояние плюс причина отмены. */
export type MechStateRow = MechRentalState & { cancelReason?: string | null };

/**
 * Цвета тегов состояния (Р2). Оба — предупреждающие, но разной природы, и в списке их различают
 * глазами: «ждёт подачи» оранжевым, как всякое ожидание в портале, «коррекция завершения» —
 * `volcano`: это не ожидание чужого действия, а недоделанная работа своей стороны.
 */
const STATE_COLORS: Record<'awaitingIssue' | 'correction', string> = {
  awaitingIssue: 'orange',
  correction: 'volcano',
};

/**
 * Состояние аренды в строке списка и в карточке: статус заявки плюс тег того, чего статус не
 * говорит.
 *
 * Статусов у модуля три, а состояний пять (Р2): «договорились, техники нет», «аренда идёт» и
 * «коррекция завершения» — это всё один `confirmed`, разведённый **полями** `actual_from` и
 * `actual_to`. Четвёртого статуса заказчик не называл, и выдумывать его нельзя, поэтому разницу и
 * несёт второй тег.
 *
 * Что именно показать, решает `mechStateTag` контрактов, а не эта разметка: тегов два, места у
 * них три (таблица, карточка телефона, окно заявки), и разойтись подписи не должны. `null` —
 * состояние читается по самому статусу, и второй ярлык рядом с ним был бы шумом.
 */
export function MechStateTag({ row }: { row: MechStateRow }) {
  const state = mechStateTag(row);
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
    </Space>
  );
}
