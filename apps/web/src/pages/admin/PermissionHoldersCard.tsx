import { Space, Tag, Typography } from 'antd';
import {
  accessProfileLabel,
  permissionActionLabels,
  permissionModuleLabels,
} from '@technic/contracts';
import { subjectOf } from './accessOverview';
import { FULL_ACCESS, type PermissionRow } from './permissionRows';

/**
 * Карточка права: кому оно положено по матрице и у кого есть на самом деле.
 *
 * Отдельно от таблицы, потому что показывает два разных ответа рядом и обязана не дать спутать их
 * между собой: профили матрицы говорят, что даёт должность, живые учётки — что человек может
 * сегодня, и расхождение между списками здесь не дефект, а главный вывод среза. Объяснения к этому
 * длиннее самой разметки, и в описании колонок они читались бы примечанием к `render`.
 */

/** Кто владеет правом: профили матрицы и живые учётки под ними. */
export function PermissionDetails({ row, pending }: { row: PermissionRow; pending: boolean }) {
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Text type="secondary">
          {row.permission} · {permissionModuleLabels[row.module]} ·{' '}
          {permissionActionLabels[row.action]}
        </Typography.Text>
      </div>

      <div>
        <Typography.Text strong>Профили матрицы ({row.profiles.length})</Typography.Text>
        <div style={{ marginTop: 4 }}>
          {row.profiles.length > 0 ? (
            <Space size={[4, 4]} wrap>
              {row.profiles.map((label) => (
                <Tag key={label} color={FULL_ACCESS.has(label) ? 'magenta' : undefined}>
                  {label}
                </Tag>
              ))}
            </Space>
          ) : (
            // «Ни у одного профиля» больше не значит «ни у кого»: право может прийти набором,
            // которого в матрице нет. Ответ на «пользуется ли им кто-нибудь» стоит ниже, в списке
            // держателей, и путать эти два ответа нельзя.
            <Typography.Text type="secondary">
              Права нет ни у одного профиля матрицы: по должности оно не положено никому.
            </Typography.Text>
          )}
        </div>
      </div>

      <div>
        <Typography.Text strong>Учётки ({pending ? '…' : row.holders.length})</Typography.Text>
        <div style={{ marginTop: 4 }}>
          {row.holders.length > 0 ? (
            // Роль рядом с каждым именем: держателей одного права набирают несколько профилей
            // сразу, и без неё список не отвечает, кто из них кто. Держателю, которому право дала не
            // должность, дописано «набором» — это ответ на «почему он здесь», и без него строка
            // выглядела бы ошибкой матрицы.
            <Space orientation="vertical" size={0} style={{ width: '100%' }}>
              {row.holders.map(({ user, byGrant }) => (
                <div key={user.id}>
                  {user.fullName}{' '}
                  <Typography.Text type="secondary">
                    — {accessProfileLabel(subjectOf(user))}
                    {byGrant ? ', набором' : ''}
                  </Typography.Text>
                </div>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {pending
                ? 'Учётки ещё загружаются'
                : 'Живых учёток с этим правом нет: право заведено, но им никто не пользуется.'}
            </Typography.Text>
          )}
        </div>
      </div>
    </Space>
  );
}
