import { Space, Typography } from 'antd';
import {
  auditChangesOf,
  describeAuditEntry,
  userAuditFieldLabels,
  type AuditChangeDto,
  type AuditEntryDto,
  type UserAuditField,
} from '@technic/contracts';

/**
 * Что событие сделало с учётной записью (ADR 0109): заголовок и под ним значения — «Роль:
 * Диспетчер → Механик».
 *
 * Один компонент на таблицу журнала и на панель пути: строка события в обоих местах отвечает на
 * один и тот же вопрос, и раздвоившись в вёрстке, формулировки разъехались бы при первом же новом
 * поле учётки. Правило сборки при этом не здесь, а в контрактах (`auditChangesOf`) — вёрстка
 * только показывает готовое.
 */

const line = { fontSize: 12 } as const;

/** Подпись поля; незнакомый код — из записи, сделанной другой версией портала. */
function labelOf(field: string): string {
  return userAuditFieldLabels[field as UserAuditField] ?? field;
}

/**
 * Значение изменения. Три вида, и различать их обязательно: обычная пара, появившееся значение
 * (стрелка из пустоты только мешает) и правка, значения которой журнал не сохранил, — про неё
 * честно говорится, что было изменение, но чего именно — неизвестно.
 */
function valueOf(change: AuditChangeDto): string {
  if (change.to === null) return 'значения не сохранены';
  return change.from === null ? change.to : `${change.from} → ${change.to}`;
}

export function AuditChangeLines({ entry }: { entry: AuditEntryDto }) {
  const changes = auditChangesOf(entry);
  if (changes.length === 0) return null;
  return (
    <>
      {changes.map((c, i) => (
        <Typography.Text key={`${c.field}-${i}`} type="secondary" style={line}>
          {labelOf(c.field)}: {valueOf(c)}
        </Typography.Text>
      ))}
    </>
  );
}

/**
 * Событие целиком: что произошло и что в учётке стало другим.
 *
 * Заголовок остаётся и при пустом перечне — событий без значений хватает (сброс пароля,
 * подтверждение адреса), и строка «—» вместо них читалась бы как потеря записи.
 */
export function AuditEventCell({ entry }: { entry: AuditEntryDto }) {
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text>{describeAuditEntry(entry)}</Typography.Text>
      <AuditChangeLines entry={entry} />
    </Space>
  );
}
