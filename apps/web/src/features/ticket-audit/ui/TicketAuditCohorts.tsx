import { Alert, Button, Empty, Skeleton, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { TicketAuditCohortsDto, TicketAuditPeriod } from '@technic/contracts';
import { ticketAuditCohortsQuery } from '@entities/waste-ticket';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../../utils/format';
import { sortCohorts } from '../model/cohorts';
import { COHORTS_INCOMPARABLE_NOTE } from '../model/numbers';
import { CohortCards, CohortTable } from './CohortRows';
import { PeriodBar } from './PeriodBar';
import { TicketAuditCascadeBlock } from './TicketAuditCascade';

/**
 * Сигналы по производственным когортам (§5.2 плана): что происходит в каждой конфигурации
 * конвейера и что даёт каскад.
 *
 * Название честное, и экран держится за него: A/B не проводится, конфигурации видят разный поток,
 * и вывода «модель X лучше модели Y» здесь не делается — он требует прогонки одной выборки обеими.
 * Отсюда подпись под таблицей: она стоит на экране постоянно, а не прячется в подсказку, потому
 * что без неё три доли столбцом читаются как таблица результатов состязания.
 *
 * Состояний четыре — загрузка, ошибка, пусто, данные, — как и у сводки: «нет данных за период» и
 * «0 %» отвечают на разные вопросы и не имеют права выглядеть одинаково.
 */
interface Props {
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  /** Окно открыто и право есть: закрытую ручку незачем спрашивать ради 403. */
  enabled: boolean;
}

export function TicketAuditCohorts({ period, onPeriodChange, enabled }: Props) {
  const isMobile = useIsMobile();
  const { data, isLoading, isError, error, refetch } = useQuery(
    ticketAuditCohortsQuery(period, enabled),
  );

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {/* Период тот же и в том же виде, что на сводке: экран меняется, отчёт остаётся одним. */}
      <PeriodBar period={period} onChange={onPeriodChange} />
      {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {isError ? (
        <Alert
          type="error"
          showIcon
          title="Когорты не загрузились"
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
      {!isLoading && !isError && data ? <CohortsBody data={data} isMobile={isMobile} /> : null}
    </Space>
  );
}

/** Данные и пустота. Разделены с загрузкой и ошибкой, чтобы каждое состояние читалось отдельно. */
function CohortsBody({ data, isMobile }: { data: TicketAuditCohortsDto; isMobile: boolean }) {
  if (data.cohorts.length === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Нет данных за период: машинных разборов в эти дни не было"
      />
    );

  // Порядок задаёт клиент, а не ответ: обход обязан быть устойчивым, иначе строки прыгают между
  // обновлениями и таблицу перестают читать глазами.
  const rows = sortCohorts(data.cohorts);

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {isMobile ? <CohortCards rows={rows} /> : <CohortTable rows={rows} />}
      {/* Подпись стоит под таблицей и видна всегда: это не сноска про оформление, а условие, при
          котором эти доли вообще можно читать. */}
      <Typography.Text type="secondary">— {COHORTS_INCOMPARABLE_NOTE}</Typography.Text>
      <TicketAuditCascadeBlock cascade={data.cascade} />
    </Space>
  );
}
