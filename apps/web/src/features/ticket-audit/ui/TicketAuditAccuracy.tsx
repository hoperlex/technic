import { Alert, Button, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { TicketAuditAccuracyDto, TicketAuditPeriod } from '@technic/contracts';
import { ticketAuditAccuracyQuery } from '@entities/waste-ticket';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../../utils/format';
import {
  ACCURACY_ARBITRATION_NOTE,
  ACCURACY_BIAS_NOTE,
  ACCURACY_QUEUE_NOTE,
  ACCURACY_TITLE,
  accuracyQueue,
  accuracyTotals,
  sortAccuracyRows,
  type AccuracyTotals,
} from '../model/accuracy';
import { ACCURACY_INTERVAL_NOTE, accuracyIntervalView, accuracyTotalView } from '../model/numbers';
import { AccuracyCards, AccuracyTable } from './AccuracyRows';
import { PeriodBar } from './PeriodBar';
import { Ratio } from './Ratio';
import { StatLine } from './StatLine';

/**
 * Точность среди неисправленных подтверждённых талонов (§5.5 плана): что показала слепая
 * перепроверка и чем кончились расхождения.
 *
 * ЗАГОЛОВОК ДЛИННЫЙ НАМЕРЕННО, и сокращать его нельзя. В слепую выборку попадают только машинные
 * талоны, которых первый оператор не исправлял: известные ошибки модели в неё не входят вовсе.
 * Короткое «Точность» читалось бы как точность потока и было бы неправдой — той самой убедительной
 * неправдой, ради которой модуль и переписывался (§3, §10).
 *
 * Экран не соседствует со сводкой и в одну плитку с долей исправлений не сводится (§5.5):
 * подтверждение оператора независимым чтением не является, и смешение этих чисел рождает ровно ту
 * ошибку чтения, от которой раздел защищается.
 *
 * Состояний четыре — загрузка, ошибка, пусто, данные, — как у соседей: «перепроверок не выдавали»
 * и «выдавали, но все ждут» отвечают на разные вопросы и не имеют права выглядеть одинаково.
 */
interface Props {
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  /** Окно открыто и право есть: закрытую ручку незачем спрашивать ради 403. */
  enabled: boolean;
}

export function TicketAuditAccuracy({ period, onPeriodChange, enabled }: Props) {
  const isMobile = useIsMobile();
  const { data, isLoading, isError, error, refetch } = useQuery(
    ticketAuditAccuracyQuery(period, enabled),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {ACCURACY_TITLE}
      </Typography.Title>
      {/* Границы те же, что у сводки, а считаются по времени ВЫДАЧИ перепроверки — и говорит об
          этом подпись полосы, единственное, чем такие различия вообще видны (§1.3). */}
      <PeriodBar period={period} onChange={onPeriodChange} subject="checks" />
      {isLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {isError ? (
        <Alert
          type="error"
          showIcon
          message="Точность не загрузилась"
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
      {!isLoading && !isError && data ? <AccuracyBody data={data} isMobile={isMobile} /> : null}
    </Space>
  );
}

/** Данные и пустота. Разделены с загрузкой и ошибкой, чтобы каждое состояние читалось отдельно. */
function AccuracyBody({ data, isMobile }: { data: TicketAuditAccuracyDto; isMobile: boolean }) {
  if (data.issued === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Нет данных за период: слепых перепроверок в эти дни не выдавалось"
      />
    );

  const rows = sortAccuracyRows(data.fields);
  const totals = accuracyTotals(data.fields);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/*
       * Предупреждение о смещении стоит НАД числами и видно всегда — не подсказкой и не сноской.
       * Текст дословно из §3: выборка смещена в сторону неисправленных талонов, и процент под ней
       * ожидаемо оптимистичен. Прочитанный без этой строки, он отвечает не на тот вопрос, который
       * задан; поэтому строки нет ровно там, где нет и числа, — в пустом состоянии выше.
       */}
      <Alert type="warning" showIcon message={ACCURACY_BIAS_NOTE} />
      <Queues data={data} />
      <Total totals={totals} />
      {isMobile ? <AccuracyCards rows={rows} /> : <AccuracyTable rows={rows} />}
      <Outcomes totals={totals} />
    </Space>
  );
}

/**
 * Очереди перепроверки — вложенно, а не строкой через точку.
 *
 * Так исправлена ошибка макета §5.5: «выдано 24 · вернулись 18 (из них 2 ждут арбитража) · ждут
 * проверяющего 6» читается как четыре независимых слагаемых, а сумма их с выданными не сходится ни
 * при каком раскладе. На деле выданные ДЕЛЯТСЯ на вернувшиеся и ждущие проверяющего, а ждущие
 * арбитража — часть вернувшихся. Отступ и «из них» в каждой подписи говорят это и тому, кто читает
 * строки подряд, не разглядывая вёрстку.
 */
function Queues({ data }: { data: TicketAuditAccuracyDto }) {
  const queue = accuracyQueue(data);
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>Выдано проверок {queue.issued}</Typography.Text>
      <Space direction="vertical" size={4} style={{ width: '100%', paddingLeft: 16 }}>
        <StatLine
          label="из них вернулись"
          hint="Проверяющий прислал своё чтение. Часть из них совпала с машинным, часть разошлась"
        >
          <Typography.Text>{queue.returned}</Typography.Text>
        </StatLine>
        <Space direction="vertical" size={4} style={{ width: '100%', paddingLeft: 16 }}>
          <StatLine
            label="из них ждут арбитража"
            hint="Вернувшиеся проверки, где чтения разошлись, а верное значение ещё никто не назвал. В точность они не идут ни верными, ни неверными"
          >
            <Typography.Text>{queue.waitingArbitration}</Typography.Text>
          </StatLine>
        </Space>
        <StatLine
          label="из них ждут проверяющего"
          hint="Проверка выдана, но человек её ещё не сделал. Таких талонов в числах ниже нет вовсе"
        >
          <Typography.Text>{queue.waitingChecker}</Typography.Text>
        </StatLine>
      </Space>
      {/* Подпись видна всегда: без неё четыре числа складывают глазами — и не сходятся. */}
      <Typography.Text type="secondary">— {ACCURACY_QUEUE_NOTE}</Typography.Text>
    </Space>
  );
}

/**
 * Итог по трём полям: «верно / n», процент и интервал Уилсона.
 *
 * Интервал печатается только там, где напечатан процент, — порог у них общий (`numbers.ts`).
 * Показанный при малой выборке, он читался бы как измерение тем убедительнее, чем шире.
 */
function Total({ totals }: { totals: AccuracyTotals }) {
  const interval = accuracyIntervalView(totals.right, totals.n);
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Typography.Text strong>Всего</Typography.Text>
        <Ratio view={accuracyTotalView(totals)} />
        {interval.kind === 'interval' ? (
          <Tooltip title={ACCURACY_INTERVAL_NOTE}>
            <Typography.Text type="secondary">
              интервал Уилсона {interval.lowPercent}–{interval.highPercent} %, n = {interval.n}
            </Typography.Text>
          </Tooltip>
        ) : null}
      </Space>
      {/* Оговорка стоит рядом с интервалом, а не в подсказке: интервал выглядит мерой неуверенности
          целиком, и прочитанный так — обещает, что истина лежит между границами. Между ними лежит
          только случайный разброс этой выборки; смещение двигает обе границы разом. */}
      {interval.kind === 'interval' ? (
        <Typography.Text type="secondary">— {ACCURACY_INTERVAL_NOTE}</Typography.Text>
      ) : null}
    </Space>
  );
}

/**
 * Исходы расхождений. Слово «арбитраж» здесь уместно — в отличие от блока каскада: перепроверка
 * слепая, разбирает расхождение третий человек, и присылает он значение, а не выбор из двух. Отсюда
 * и третий исход: ошиблись оба. Он не остаток и не округление — он выразим в собранных данных, и
 * не показать его значило бы утверждать, что кто-то из двоих всегда прав.
 */
function Outcomes({ totals }: { totals: AccuracyTotals }) {
  if (totals.diverged === 0)
    return (
      <Typography.Text type="secondary">
        Расхождений не было: оба чтения совпали везде
      </Typography.Text>
    );

  const items = [
    {
      label: 'права машина',
      value: totals.machineRight,
      hint: 'Арбитр назвал значение, совпавшее с машинным чтением',
    },
    {
      label: 'прав проверяющий',
      value: totals.checkerRight,
      hint: 'Арбитр назвал значение, совпавшее с чтением проверяющего',
    },
    {
      label: 'ошиблись оба',
      value: totals.bothWrong,
      hint: 'Арбитр назвал значение, которого не предлагал ни один из двоих',
    },
  ];

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {/* Заголовок называет обе доли расхождений сразу: разобранные и ждущие. Без второго числа
          три исхода под ним читались бы как весь итог, а он неполон, пока арбитраж не прошёл. */}
      <Typography.Text strong>
        Исходы расхождений ({totals.arbitrated} разобрано, {totals.awaitingFields} ждут)
      </Typography.Text>
      {totals.arbitrated === 0 ? (
        <Typography.Text type="secondary">
          Ни одно расхождение ещё не разобрано: кто был прав, неизвестно
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={4} style={{ width: '100%', paddingLeft: 16 }}>
          {items.map((item) => (
            <StatLine key={item.label} label={item.label} hint={item.hint}>
              <Typography.Text>{item.value}</Typography.Text>
            </StatLine>
          ))}
        </Space>
      )}
      <Tooltip title={ACCURACY_ARBITRATION_NOTE}>
        <Typography.Text type="secondary">
          — расхождения и исходы считаются ПОЛЯМИ, а очереди выше — проверками: одна проверка с
          двумя расхождениями даёт единицу там и двойку здесь
        </Typography.Text>
      </Tooltip>
    </Space>
  );
}
