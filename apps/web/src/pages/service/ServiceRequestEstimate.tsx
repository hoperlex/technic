import { Alert, Button, Space, Typography } from 'antd';
import { serviceEstimatePending, type ServiceRequestDto } from '@technic/contracts';
import { ServiceEstimateTable } from '@entities/service-request';
import type { ActionSheetItem } from '@shared/ui';
import { serviceActionRow } from './serviceRequestRow';
import { formatDateTime, formatMoney } from '../../utils/format';

/** Решения по объёму работ, которые вкладка показывает кнопками: их порядок здесь и есть порядок. */
const DECISION_KEYS = ['approve', 'reject', 'reopen'] as const;

/**
 * Вкладка «Объём работ» карточки (§9.4, Р17): текущая ревизия, отметка «согласована ревизия N»,
 * план и факт по строкам, итоги — и сами решения по предъявленному объёму.
 *
 * Отметка о состоянии стоит выше строк не для порядка: спор по заявке начинается с вопроса «а это
 * утверждали?», и ответ на него — номер ревизии со снимком «кто и когда», а не сумма.
 *
 * **Активное предъявление определяет только признак `serviceEstimatePending`** (Р9), а не непустая
 * дата. Прежде вкладка считала предъявлением сам факт непустого `estimateSubmittedAt`, и после
 * правки это соврало бы: возврат в правку дату не трогает — она сохраняет свой прежний смысл «когда
 * предъявляли в последний раз», — и «предъявлена» стояло бы у отозванного. Поэтому дата и подписана
 * временем последнего предъявления, а не состоянием.
 *
 * Решения переехали сюда из одного лишь меню по просьбе заказчика: смотрят на объём работ здесь, и
 * подписывать его отсюда же. Кнопки строит не вкладка — она получает готовые пункты набора
 * действий, а те спрашивают предикаты Р11. Два входа в одно действие не дублирование ровно до тех
 * пор, пока оба спрашивают одно правило; посчитай вкладка доступность сама — она разошлась бы с
 * меню и с сервером молча.
 */
export function ServiceRequestEstimate({
  request,
  actions = [],
}: {
  request: ServiceRequestDto;
  /**
   * Полный набор действий карточки. Вкладка выбирает из него свои три — «Согласовать», «Не
   * согласовано» и «Вернуть в правку»; нет пункта — нет и кнопки, и решать, почему, вкладке не
   * приходится.
   */
  actions?: ActionSheetItem[];
}) {
  const approval = request.approval;
  const completion = request.completion;
  const pending = serviceEstimatePending(serviceActionRow(request));
  // Факт показывается, как только он появился хоть у одной строки: возврат на доработку стирает
  // отметки, и тогда таблица снова становится планом.
  const showFact = request.items.some((item) => item.performed != null);
  const decisions = DECISION_KEYS.map((key) => actions.find((item) => item.key === key)).filter(
    (item): item is ActionSheetItem => !!item,
  );

  if (request.items.length === 0) {
    return (
      <Typography.Text type="secondary">
        Объёма работ пока нет: его собирает исполнитель, взявший заявку в работу.
      </Typography.Text>
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        // Три состояния, а не два: «ждёт решения» отличается от «согласовано» и от «в правке» тем,
        // что ход сейчас за согласующим, — и именно об этом вкладку и спрашивают.
        type={pending ? 'warning' : approval ? 'success' : 'info'}
        showIcon
        message={
          pending
            ? `Ревизия ${request.estimateRevision} предъявлена — ждём решения`
            : approval
              ? `Согласована ревизия ${approval.revision}`
              : `Ревизия ${request.estimateRevision} — согласования нет`
        }
        description={
          pending ? (
            <span>
              {request.estimateSubmittedAt
                ? `Предъявлена ${formatDateTime(request.estimateSubmittedAt)}`
                : 'Предъявлена'}
              {/* Подпись под прошлой ревизией при висящем предъявлении — обычное дело: объём
                  предъявили заново, и старое согласование к делу больше не относится. Сказать это
                  надо прямо, иначе «Согласована ревизия 2» вспоминалось бы как действующее. */}
              {approval && approval.revision !== request.estimateRevision && (
                <Typography.Text type="secondary">
                  {' '}
                  · прошлое согласование (ревизия {approval.revision}) больше не действует
                </Typography.Text>
              )}
            </span>
          ) : approval ? (
            <span>
              {approval.byName || '—'} · {formatDateTime(approval.at)}
              {/* Ревизии разошлись — значит объём работ предъявляли после согласования: к работам
                  сервер пустит только по совпадению номеров (Р14). */}
              {approval.revision !== request.estimateRevision && (
                <Typography.Text type="warning">
                  {' '}
                  · объём работ правился, текущая ревизия {request.estimateRevision}
                </Typography.Text>
              )}
            </span>
          ) : request.estimateSubmittedAt ? (
            // Дата непуста, а предъявления нет — значит объём вернули в правку (Р9). Дата отвечает
            // на «когда предъявляли в последний раз», и подписана она именно так.
            `В правке у исполнителя · предъявляли ${formatDateTime(request.estimateSubmittedAt)}`
          ) : (
            'Черновик исполнителя: на согласование ещё не отправлялся'
          )
        }
      />

      <ServiceEstimateTable items={request.items} showFact={showFact} />

      <Space direction="vertical" size={2} style={{ alignItems: 'flex-end', width: '100%' }}>
        <span>
          <Typography.Text type="secondary">По объёму работ: </Typography.Text>
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

      {/* Решения — под таблицей и под итогом, а не над ними: подпись ставят, дочитав до суммы. */}
      {decisions.length > 0 && (
        <Space wrap>
          {decisions.map((item) => (
            <Button
              key={item.key}
              // Главное решение — сплошной кнопкой: у согласования оно одно, и признак `primary`
              // проставлен там же, где строится сам пункт (Р117).
              type={item.primary ? 'primary' : 'default'}
              danger={item.danger}
              icon={item.icon}
              onClick={item.onClick}
            >
              {item.key === 'approve'
                ? 'Согласовать'
                : item.key === 'reject'
                  ? 'Не согласовано'
                  : 'Вернуть в правку'}
            </Button>
          ))}
        </Space>
      )}
    </Space>
  );
}
