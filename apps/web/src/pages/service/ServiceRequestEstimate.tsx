import { Alert, Space, Typography } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceEstimateTable } from '@entities/service-request';
import { formatDateTime, formatMoney } from '../../utils/format';

/**
 * Вкладка «Смета» карточки (§9.4): текущая ревизия, отметка «согласована ревизия N», план и факт
 * по строкам, итоги.
 *
 * Отметка о согласовании стоит выше строк не для порядка: спор по заявке начинается с вопроса
 * «а это утверждали?», и ответ на него — номер ревизии со снимком «кто и когда», а не сумма.
 */
export function ServiceRequestEstimate({ request }: { request: ServiceRequestDto }) {
  const approval = request.approval;
  const completion = request.completion;
  // Факт показывается, как только он появился хоть у одной строки: возврат на доработку стирает
  // отметки, и тогда таблица снова становится планом.
  const showFact = request.items.some((item) => item.performed != null);

  if (request.items.length === 0) {
    return (
      <Typography.Text type="secondary">
        Сметы пока нет: её собирает исполнитель в диагностике.
      </Typography.Text>
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type={approval ? 'success' : 'info'}
        showIcon
        message={
          approval
            ? `Согласована ревизия ${approval.revision}`
            : `Ревизия ${request.estimateRevision} — согласования нет`
        }
        description={
          approval ? (
            <span>
              {approval.byName || '—'} · {formatDateTime(approval.at)}
              {/* Ревизии разошлись — значит смету переоткрыли после согласования: к работам
                  сервер пустит только по совпадению номеров (Р14). */}
              {approval.revision !== request.estimateRevision && (
                <Typography.Text type="warning">
                  {' '}
                  · смета переоткрыта, текущая ревизия {request.estimateRevision}
                </Typography.Text>
              )}
            </span>
          ) : request.estimateSubmittedAt ? (
            `Предъявлена ${formatDateTime(request.estimateSubmittedAt)}`
          ) : (
            'Черновик исполнителя: на согласование ещё не отправлялся'
          )
        }
      />

      <ServiceEstimateTable items={request.items} showFact={showFact} />

      <Space direction="vertical" size={2} style={{ alignItems: 'flex-end', width: '100%' }}>
        <span>
          <Typography.Text type="secondary">По смете: </Typography.Text>
          <Typography.Text strong>{formatMoney(request.estimatedTotalAmount)}</Typography.Text>
        </span>
        {completion?.adjustmentAmount != null && (
          <span>
            <Typography.Text type="secondary">Скидка по акту: </Typography.Text>
            <Typography.Text>{formatMoney(completion.adjustmentAmount)}</Typography.Text>
            {completion.adjustmentReason && (
              <Typography.Text type="secondary"> · {completion.adjustmentReason}</Typography.Text>
            )}
          </span>
        )}
        {completion && (
          <span>
            <Typography.Text type="secondary">По акту: </Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {formatMoney(completion.totalAmount)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {' '}
              · закрыто {formatDateTime(completion.completedAt)}
            </Typography.Text>
          </span>
        )}
      </Space>
    </Space>
  );
}
