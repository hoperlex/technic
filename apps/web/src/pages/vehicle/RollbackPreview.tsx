import { Alert, Space, Typography } from 'antd';
import type { VehicleRequestStatusPreviewDto } from '@technic/contracts';
import { formatDateOnly } from './shared';

/**
 * Второй шаг окна назначения на откате «Выполнена» → «В работе»: что случится после возврата.
 *
 * Отдельным файлом от `VehicleAssignModal`, потому что это другой экран, а не часть формы: у него
 * нет ни одного общего с ней значения — он читает только ответ сервера и ничего не спрашивает.
 * В самом окне он и стоял особняком (форма на этом шаге прячется целиком), а весил при этом
 * шестьдесят строк сплошного текста между полями подбора техники.
 */

/**
 * Всё посчитано сервером той же сверкой, которая потом отработает (§5.4 плана), — «недель срока
 * минус выписанные» обещало бы листы за прошедшие недели, которых сверка не выпишет.
 *
 * О прошлом здесь не сказано ни слова, и это не забывчивость: снимок режима снимается закрытием, а
 * линейный заказ могли закрыть, не распланировав ни одного дня, — тогда угадать, как он вёлся,
 * нечем. Портал говорит только то, что знает точно: чем заказ пойдёт дальше, что сделает сверка
 * ЭСМ-2 и как будет считаться занятость машины.
 */
export function RollbackPreview({ preview }: { preview: VehicleRequestStatusPreviewDto }) {
  const { issue, cancel } = preview.esm2;
  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      <Alert
        type="info"
        showIcon
        title={preview.mode === 'daily' ? 'Заказ пойдёт по дням' : 'Заказ пойдёт по неделям'}
        description={
          preview.mode === 'daily'
            ? 'Работа планируется днями: на каждый день заводится рейс и печатается 4-П, а недельные листы ЭСМ-2 портал сам не выписывает — их просят по требованию.'
            : 'Работа ведётся неделями: на каждую неделю срока портал выписывает свой ЭСМ-2, дни заявке не планируются.'
        }
      />
      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {issue.length === 0 && cancel.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: выписывать и аннулировать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {issue.map((p) => (
              <li key={`issue-${p.from}`}>
                Выпишется лист за {formatDateOnly(p.from)} — {formatDateOnly(p.to)}
              </li>
            ))}
            {cancel.map((w) => (
              <li key={w.id}>
                Аннулируется {w.number} ({formatDateOnly(w.from)} — {formatDateOnly(w.to)})
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <Typography.Text strong>Занятость машины</Typography.Text>
        <div>
          <Typography.Text type="secondary">
            {preview.busy === 'term'
              ? 'Машина будет занята весь срок заявки — в гараже она встанет занятой с первого дня по последний.'
              : 'Машина будет занята только в распланированные дни — в остальные её можно поставить на другой заказ.'}
          </Typography.Text>
        </div>
      </div>
    </Space>
  );
}
