import { Alert, Button, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  TICKET_AUDIT_FIELDS,
  TICKET_AUDIT_LOST_WARNING_SHARE,
  type TicketAuditOutcomeCounts,
  type TicketAuditPeriod,
  type TicketAuditSummaryDto,
} from '@technic/contracts';
import { ticketAuditSummaryQuery } from '@entities/waste-ticket';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../../utils/format';
import { CASCADE_FIELDS_NOTE } from '../model/numbers';
import { FieldCards, FieldTable } from './FieldRows';
import { PeriodBar } from './PeriodBar';

/**
 * Сводка аудита распознавания (§5.1 плана): что за период прочитала машина и что за ней исправил
 * человек.
 *
 * Экран имеет четыре состояния — загрузка, ошибка, пусто, данные, — и пустое отличается от нулевого
 * намеренно: «нет данных за период» и «0 %» отвечают на разные вопросы, а сливаются в один ответ
 * «всё хорошо».
 */
interface Props {
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  /** Окно открыто и право есть: закрытую ручку незачем спрашивать ради 403. */
  enabled: boolean;
}

export function TicketAuditSummary({ period, onPeriodChange, enabled }: Props) {
  const isMobile = useIsMobile();
  const { data, isLoading, isError, error, refetch } = useQuery(
    ticketAuditSummaryQuery(period, enabled),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <PeriodBar
        period={period}
        onChange={onPeriodChange}
        collectingSince={data?.collectingSince}
      />
      {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {isError ? (
        <Alert
          type="error"
          showIcon
          message="Сводка не загрузилась"
          description={errorMessage(error)}
          // Кнопка, а не молчаливое повторение: сеть отвалилась на минуту — человек решает сам,
          // ждать ли ему ещё; отчёт за прошедший период никуда не убежит.
          action={
            <Button size="small" onClick={() => void refetch()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {!isLoading && !isError && data ? <SummaryBody data={data} isMobile={isMobile} /> : null}
    </Space>
  );
}

/** Данные и пустота. Разделены с загрузкой и ошибкой, чтобы каждое состояние читалось отдельно. */
function SummaryBody({ data, isMobile }: { data: TicketAuditSummaryDto; isMobile: boolean }) {
  if (data.observations.total === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Нет данных за период: машинных чтений в эти дни не было"
      />
    );

  // Порядок строк — порядок бланка (`TICKET_AUDIT_FIELDS`), а не порядок ответа: обход обязан быть
  // устойчивым, иначе строки прыгают между обновлениями и таблицу перестают читать глазами.
  const rows = [...data.fields].sort(
    (a, b) => TICKET_AUDIT_FIELDS.indexOf(a.field) - TICKET_AUDIT_FIELDS.indexOf(b.field),
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <LostWarning share={data.lostShare} outcomes={data.observations} />
      <Outcomes counts={data.observations} />
      {isMobile ? <FieldCards rows={rows} /> : <FieldTable rows={rows} />}
      <Typography.Text type="secondary">— {CASCADE_FIELDS_NOTE}</Typography.Text>
      <Proposals data={data} />
    </Space>
  );
}

/**
 * Потерянные исходы: талон удалили раньше, чем по его чтению что-то решили. Порог назван числом в
 * плане (§1.2), и выше него сводку читать надо с оговоркой — доли посчитаны по неполной выборке.
 */
function LostWarning({ share, outcomes }: { share: number; outcomes: TicketAuditOutcomeCounts }) {
  if (share <= TICKET_AUDIT_LOST_WARNING_SHARE) return null;
  const percent = (share * 100).toFixed(1).replace('.', ',');
  const threshold = (TICKET_AUDIT_LOST_WARNING_SHARE * 100).toFixed(0);
  return (
    <Alert
      type="warning"
      showIcon
      message={`Потеряно исходов: ${outcomes.lost} из ${outcomes.total} — ${percent} % при пороге ${threshold} %`}
      description="Талоны удалены раньше, чем по их чтению что-то решили. Доли ниже посчитаны без этих наблюдений."
    />
  );
}

/** Подписи исходов: каждая — строка словаря §1.2, а не выдумка экрана. */
const OUTCOME_HINTS: Record<string, string> = {
  решено: 'исправлено, принято как есть, разобран спор или принято предложение',
  'ждут решения': 'наблюдение свежее, исхода у него ещё нет — в доли исправлений оно не идёт',
  вытеснено: 'талон перечитали, и прежнее чтение заменено новым',
  снято: 'талон снят целиком',
  потеряно: 'талон удалён, исход наблюдения неизвестен',
  'вне разбора': 'поля предложений без полевого исхода: повторившие талон и поля отклонённого',
};

/** Строка исходов над таблицей: из чего сложены наблюдения периода. */
function Outcomes({ counts }: { counts: TicketAuditOutcomeCounts }) {
  const items: { label: string; value: number }[] = [
    { label: 'решено', value: counts.resolved },
    { label: 'ждут решения', value: counts.pending },
    { label: 'вытеснено', value: counts.superseded },
    { label: 'снято', value: counts.dismissed },
    { label: 'потеряно', value: counts.lost },
    { label: 'вне разбора', value: counts.outOfScope },
  ];
  return (
    <Space size={[8, 4]} wrap>
      <Typography.Text strong>Наблюдений {counts.total}</Typography.Text>
      {items.map((item) => (
        <Typography.Text key={item.label} type="secondary">
          ·{' '}
          <Tooltip title={OUTCOME_HINTS[item.label]}>
            <span>
              {item.label} <Typography.Text>{item.value}</Typography.Text>
            </span>
          </Tooltip>
        </Typography.Text>
      ))}
    </Space>
  );
}

/**
 * Предложения перераспознавания и повторные правки — строка под таблицей.
 *
 * Предложения считаются предложениями, а не полями: отказ говорит лишь «хотя бы одно из
 * отличавшихся значений неприемлемо», и разложить его по пяти полям нельзя (§1.2.1).
 */
function Proposals({ data }: { data: TicketAuditSummaryDto }) {
  const total = data.proposals.accepted + data.proposals.rejected;
  return (
    <Space size={[16, 4]} wrap>
      {total === 0 ? (
        <Typography.Text type="secondary">Предложений перераспознавания не было</Typography.Text>
      ) : (
        <Tooltip title="Отказ стоит числом предложений, а не полей: он не говорит, какое из отличавшихся значений человеку не подошло">
          <Typography.Text>
            Предложений {total}: принято {data.proposals.accepted} · отклонено{' '}
            {data.proposals.rejected}
          </Typography.Text>
        </Tooltip>
      )}
      <Tooltip title="Поле правили дважды и более: вторая правка — не вторая ошибка машины, поэтому в доли она не идёт">
        <Typography.Text>Повторных правок: {data.repeatedEdits}</Typography.Text>
      </Tooltip>
    </Space>
  );
}
