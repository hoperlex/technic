import { Collapse, Space, Tooltip, Typography } from 'antd';
import type { TicketAuditOperationsDto } from '@technic/contracts';
import {
  TOKENS_NOT_MONEY_NOTE,
  WINDOW_EMPTY_NOTE,
  failureCodeLabel,
  formatCount,
  oldestLabel,
  queueItems,
  windowLabel,
} from '../model/operations';
import { StatLine } from './StatLine';

/**
 * Блоки экрана состояния (§5.4 плана): окно вызовов, разбивка отказов и очередь.
 *
 * Оба вида — строкой на десктопе и столбцом на телефоне — в одном файле, по той же причине, что у
 * когорт и полей сводки: счётчики у них общие, и разъедься виды по двум местам, число, добавленное
 * в строку, молча не доехало бы до телефона.
 *
 * Мобильно §5.4 требует прямо: плитки в один столбец, очередь и разбивка по кодам — в раскрытие.
 * Плитка здесь — строка «подпись слева, число справа» (`StatLine`), та же, что в блоке каскада:
 * второй вид одной и той же величины читался бы как другая величина.
 */

const HINTS = {
  calls:
    'Вызовов прокси: по строке на попытку. Не «платных» — отказ, не дошедший до модели, оплачен не будет, а строку создаст',
  failures: 'Из них кончились отказом. Повтор той же страницы — отдельный вызов и отдельная строка',
  cacheHits:
    'Разборов, не потребовавших вызова: попытка переиспользована. Такой разбор бесплатен, но и эскалации в нём не бывает — он заканчивается на кэше',
  tokens: TOKENS_NOT_MONEY_NOTE,
  awaiting:
    'Заявок с приложенными талонами, по которым нет ни одного подтверждённого: работа, ждущая человека или машину. Это заявки, а не файлы и не задачи очереди',
  journal:
    'Строк журнала наблюдений всего, за всё время. Срок хранения не задан, и размер обязан быть виден: по нему решают, когда журнал придётся резать',
};

/** Окно вызовов: сколько раз звали, сколько отказов, сколько разобрано из кэша и во что обошлось. */
export function OperationsWindow({
  window,
  isMobile,
}: {
  window: TicketAuditOperationsDto['window'];
  isMobile: boolean;
}) {
  const items = [
    { label: 'вызовов прокси', value: window.calls, hint: HINTS.calls },
    { label: 'отказов', value: window.failures, hint: HINTS.failures },
    { label: 'разборов из кэша', value: window.cacheHits, hint: HINTS.cacheHits },
    { label: 'токенов', value: window.tokens, hint: HINTS.tokens },
  ];

  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>{windowLabel(window.days)}</Typography.Text>
      {/* Ни одного вызова — это не четыре нуля: нулевые отказы при нулевых вызовах читаются как
          «всё хорошо», а правда — «подсистему не звали ни разу, и о её работоспособности эти
          числа не говорят». */}
      {window.calls === 0 ? (
        <Typography.Text type="secondary">{WINDOW_EMPTY_NOTE}</Typography.Text>
      ) : isMobile ? (
        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
          {items.map((item) => (
            <StatLine key={item.label} label={item.label} hint={item.hint}>
              <Typography.Text>{formatCount(item.value)}</Typography.Text>
            </StatLine>
          ))}
        </Space>
      ) : (
        <Counters items={items} />
      )}
      <FailureCodes codes={window.failureCodes} isMobile={isMobile} />
    </Space>
  );
}

/**
 * Разбивка отказов по парам «класс × область». Пара, а не два столбца: временный отказ подсистемы
 * и окончательный отказ по одному талону — разные беды, и различает их именно сочетание. Первая
 * лечится ожиданием, вторая ожиданием не лечится никогда.
 *
 * На телефоне уходит в раскрытие (§5.4): пар бывает с десяток, и развёрнутые они отодвинули бы
 * очередь под сгиб — а очередь читают чаще.
 */
function FailureCodes({
  codes,
  isMobile,
}: {
  codes: TicketAuditOperationsDto['window']['failureCodes'];
  isMobile: boolean;
}) {
  // Отказов не было — говорится словами. Пустое место читалось бы как «разбивку не посчитали».
  if (codes.length === 0)
    return <Typography.Text type="secondary">Отказов за окно не было</Typography.Text>;

  const body = (
    <Space size={[12, 4]} wrap>
      {codes.map((code) => (
        <Typography.Text key={failureCodeLabel(code)} type="secondary">
          {failureCodeLabel(code)} <Typography.Text>{formatCount(code.count)}</Typography.Text>
        </Typography.Text>
      ))}
    </Space>
  );

  if (!isMobile) return body;
  return (
    <Collapse
      size="small"
      ghost
      items={[{ key: 'codes', label: `Отказы по кодам (${codes.length})`, children: body }]}
    />
  );
}

/**
 * Очередь и то, что рядом с ней ждёт человека.
 *
 * Очередь — снимок «сейчас», и четыре её состояния названы врозь намеренно: упавшая задача
 * повторится сама, мёртвая не повторится никогда, и требует внимания ровно она. Возраст старейшей
 * стоит здесь же: очередь из трёх задач возрастом в минуту и из трёх возрастом в сутки — это
 * «работает» и «встала», а числом задач они неотличимы.
 */
export function OperationsQueue({
  queue,
  requestsAwaitingReview,
  journalRows,
  isMobile,
}: {
  queue: TicketAuditOperationsDto['queue'];
  requestsAwaitingReview: number;
  journalRows: number;
  isMobile: boolean;
}) {
  const items = queueItems(queue);
  const body = isMobile ? (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      {items.map((item) => (
        <StatLine key={item.label} label={item.label} hint={item.hint}>
          <Typography.Text>{formatCount(item.value)}</Typography.Text>
        </StatLine>
      ))}
      <StatLine
        label="старейшая"
        hint="Возраст самой давней ждущей задачи. Растущее число при живых вызовах значит, что очередь разбирается медленнее, чем наполняется"
      >
        <Typography.Text>{oldestLabel(queue.oldestMinutes)}</Typography.Text>
      </StatLine>
    </Space>
  ) : (
    <Space size={[8, 4]} wrap>
      <Counters items={items} />
      <Typography.Text type="secondary">· {oldestLabel(queue.oldestMinutes)}</Typography.Text>
    </Space>
  );

  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>Очередь разбора</Typography.Text>
      {isMobile ? (
        <Collapse
          size="small"
          ghost
          items={[{ key: 'queue', label: queueSummary(queue), children: body }]}
        />
      ) : (
        body
      )}
      <Space size={[16, 4]} wrap>
        <Tooltip title={HINTS.awaiting}>
          <Typography.Text>
            Заявок ждёт разбора: {formatCount(requestsAwaitingReview)}
          </Typography.Text>
        </Tooltip>
        <Tooltip title={HINTS.journal}>
          <Typography.Text type="secondary">
            Строк журнала: {formatCount(journalRows)}
          </Typography.Text>
        </Tooltip>
      </Space>
    </Space>
  );
}

/**
 * Заголовок свёрнутой очереди на телефоне: сколько задач в работе и возраст старейшей. Свёрнутый
 * блок без единого числа заставлял бы раскрывать его каждый раз, чтобы убедиться, что всё тихо.
 */
function queueSummary(queue: TicketAuditOperationsDto['queue']): string {
  const total = queue.waiting + queue.running + queue.failed + queue.dead;
  return total === 0 ? 'Очередь пуста' : `Очередь: ${total} · ${oldestLabel(queue.oldestMinutes)}`;
}

/**
 * Счётчики строкой через `·` — тот же вид, что у исходов наблюдений на сводке. Каждый со своим
 * определением на подписи: число без определения читается как знание.
 */
function Counters({ items }: { items: { label: string; value: number; hint: string }[] }) {
  return (
    <Space size={[8, 4]} wrap>
      {items.map((item, index) => (
        <Typography.Text key={item.label} type="secondary">
          {index > 0 ? '· ' : ''}
          <Tooltip title={item.hint}>
            <span>
              {item.label} <Typography.Text>{formatCount(item.value)}</Typography.Text>
            </span>
          </Tooltip>
        </Typography.Text>
      ))}
    </Space>
  );
}
