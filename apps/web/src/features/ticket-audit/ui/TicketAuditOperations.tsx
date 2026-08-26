import { Alert, Button, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { TicketAuditOperationsDto } from '@technic/contracts';
import { ticketAuditOperationsQuery } from '@entities/waste-ticket';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../../utils/format';
import {
  OPERATIONS_NO_PERIOD_NOTE,
  OPERATIONS_STATES,
  failuresLastHourView,
  generatedLabel,
  lastSuccessLabel,
} from '../model/operations';
import { OperationsQueue, OperationsWindow } from './OperationsRows';

/**
 * Состояние подсистемы (§5.4 плана): работает ли распознавание, во что обошлась неделя вызовов и
 * что копится в очереди.
 *
 * ЕДИНСТВЕННЫЙ ЭКРАН РАЗДЕЛА БЕЗ ПЕРИОДА, и календаря здесь нет вовсе — не спрятанного, не
 * заблокированного, а никакого. Очередь и состояние это снимок «сейчас», её нельзя посчитать за
 * июль; вызовы и отказы считаются по времени вызова фиксированным окном (§1.3). Ручка и та не
 * принимает границ: любой присланный ключ кончается 400. Вместо календаря стоит подпись, почему
 * его нет: отсутствие того, что есть на четырёх соседних экранах, человек прочтёт как поломку
 * раньше, чем как замысел.
 *
 * ДЕНЕГ НА ЭКРАНЕ НЕТ — только токены и вызовы (§5.4, решение заказчика). Сумма, посчитанная
 * порталом по вчерашнему тарифу, выглядела бы точной, не будучи ею.
 *
 * Состояний у экрана четыре, как у соседей, но четвёртое — пустота — живёт ВНУТРИ блоков, а не
 * вместо экрана: слово состояния («выключен», «не настроен») это ответ, и заменить его пустой
 * страницей значило бы отправить дежурного искать сбой там, где принято решение. Поэтому «вызовов
 * не было», «отказов не было» и «очередь пуста» сказаны словами каждое на своём месте.
 */
export function TicketAuditOperations({ enabled }: { enabled: boolean }) {
  const isMobile = useIsMobile();
  const { data, isLoading, isError, error, refetch } = useQuery(
    ticketAuditOperationsQuery(enabled),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* На месте полосы периода — объяснение, почему её нет. Видно всегда, а не подсказкой:
          спрашивают об этом, не найдя календаря глазами, и наводить мышь будет некуда. */}
      <Typography.Text type="secondary">— {OPERATIONS_NO_PERIOD_NOTE}</Typography.Text>
      {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {isError ? (
        <Alert
          type="error"
          showIcon
          message="Состояние подсистемы не загрузилось"
          description={errorMessage(error)}
          // Кнопка, а не молчаливое повторение: не загрузился ОТЧЁТ о подсистеме, а не сама
          // подсистема, и путать эти две беды нельзя — решает человек, ждать ли ему ещё.
          action={
            <Button size="small" onClick={() => void refetch()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {!isLoading && !isError && data ? <OperationsBody data={data} isMobile={isMobile} /> : null}
    </Space>
  );
}

/** Тело экрана: состояние словом, окно вызовов, очередь. */
function OperationsBody({ data, isMobile }: { data: TicketAuditOperationsDto; isMobile: boolean }) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <StateHeader data={data} />
      <OperationsWindow window={data.window} isMobile={isMobile} />
      <OperationsQueue
        queue={data.queue}
        requestsAwaitingReview={data.requestsAwaitingReview}
        journalRows={data.journalRows}
        isMobile={isMobile}
      />
    </Space>
  );
}

/**
 * Состояние словом, сбои за час и два момента времени.
 *
 * Слово стоит первым и крупно: это единственная строка экрана, ради которой его открывают в
 * тревоге. Числа под ним объясняют слово, но не заменяют его — «вызовов 402, отказов 11» не
 * отвечает на вопрос «работает ли», пока кто-то не поделил одно на другое.
 */
function StateHeader({ data }: { data: TicketAuditOperationsDto }) {
  const state = OPERATIONS_STATES[data.state];
  const failures = failuresLastHourView(data.failuresLastHour);
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Typography.Text strong>Состояние:</Typography.Text>
        <Tooltip title={state.hint}>
          <Typography.Text strong type={state.tone}>
            {state.label}
          </Typography.Text>
        </Tooltip>
      </Space>
      {/* Час назван в самой строке: за неделю отказы, скорее всего, были, и «сбоев не обнаружено»
          без окна пообещало бы, что их не было вовсе. */}
      <Typography.Text type={failures.tone}>{failures.text}</Typography.Text>
      <Space size={[16, 4]} wrap>
        <Tooltip title="Момент последнего вызова, дошедшего до конца. Он может быть старше окна в семь дней: подсистема, которую давно не звали, не сломана">
          <Typography.Text type="secondary">
            Последний успешный вызов: {lastSuccessLabel(data.lastSuccessAt)}
          </Typography.Text>
        </Tooltip>
        {/* Момент ответа обязателен: без него экран читается как «прямо сейчас», и вкладка,
            открытая со вчера, показывала бы вчерашнюю очередь под видом текущей. */}
        <Tooltip title="Когда сервер посчитал эти числа. Экран обновляется сам раз в минуту, но обновление может и не дойти — тогда расходится именно этот момент">
          <Typography.Text type="secondary">
            Обновлено: {generatedLabel(data.generatedAt)}
          </Typography.Text>
        </Tooltip>
      </Space>
    </Space>
  );
}
