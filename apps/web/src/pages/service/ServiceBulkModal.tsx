import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Progress, Space, Typography } from 'antd';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  serviceRequestBulkOperationLabels,
  serviceRequestBulkSchema,
  type ServiceRequestBulkBody,
  type ServiceRequestBulkResultDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { newIdempotencyKey } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import {
  clearServiceBulkRun,
  saveServiceBulkRun,
  serviceBulkBody,
  serviceBulkFingerprint,
  serviceBulkPrompts,
  serviceBulkRequestsLabel,
  serviceBulkWarnings,
  type ServiceBulkCommand,
  type ServiceBulkRun,
} from './serviceBulkCommands';

/**
 * Массовая команда — ОДНО окно в трёх состояниях: подтверждение → прогресс → отчёт (Р11, Р12).
 *
 * Одно, а не три, потому что это один разговор: человек назвал команду, увидел, к чему она
 * применится и к чему нет, дождался и прочитал, что вышло. Три окна означали бы три закрытия и
 * потерянный отчёт между вторым и третьим.
 *
 * ОТЧЁТ НЕ ЗАКРЫВАЕТСЯ САМ и не исчезает по таймеру: это результат действия над чужой работой.
 * `Escape` уводит только подтверждение — отчёт с неудачами человек обязан успеть прочитать.
 */

/** Как часто спрашивается состояние пачки: секунда — цена честного «обработано 12 из 50». */
const POLL_MS = 1000;

/** Сколько неприменимых строк называется поимённо; остальные считаются числом (Р11). */
const NAMED_SKIPPED = 5;

/** Чем окно открыто: новой командой полосы либо пачкой, пережившей перезагрузку вкладки (§7.2). */
export type ServiceBulkTarget =
  { kind: 'command'; command: ServiceBulkCommand } | { kind: 'restored'; run: ServiceBulkRun };

type Phase =
  | { kind: 'confirm' }
  | { kind: 'running'; run: ServiceBulkRun }
  | { kind: 'error'; run: ServiceBulkRun; message: string }
  | { kind: 'report'; result: ServiceRequestBulkResultDto };

/** Общая причина, уже уехавшая в теле: повтор неудавшихся идёт с ней же, а не с пустой. */
function textOf(body: ServiceRequestBulkBody): string {
  if ('reason' in body) return body.reason;
  if ('urgencyReason' in body) return body.urgencyReason;
  if ('comment' in body) return body.comment ?? '';
  return '';
}

/** Строки, которых команда не коснётся, — поимённо и с причиной у каждой. */
function SkippedList({ skipped }: { skipped: ServiceBulkCommand['skipped'] }) {
  if (skipped.length === 0) return null;
  const rest = skipped.length - NAMED_SKIPPED;
  return (
    <Alert
      type="warning"
      showIcon
      description={
        <>
          <div>Эти заявки останутся как есть:</div>
          {skipped.slice(0, NAMED_SKIPPED).map(({ request, reason }) => (
            <div key={request.id}>
              {request.displayNumber} — {reason}
            </div>
          ))}
          {rest > 0 && <div>и ещё {rest}</div>}
        </>
      }
    />
  );
}

/** Отчёт построчно: номер, исход, причина и вход в неудавшуюся заявку (Р12). */
function ReportRows({ result }: { result: ServiceRequestBulkResultDto }) {
  return (
    <div className="bulk-report">
      {result.rows.map((row) => (
        <div key={row.index}>
          {row.outcome === 'failed' ? (
            // Ссылка тем же адресом, каким карточку открывает письмо: разбирают неудачу в ней.
            <Link to={`?open=${row.id}`}>{row.displayNumber ?? `строка ${row.index + 1}`}</Link>
          ) : (
            <Typography.Text>{row.displayNumber ?? `строка ${row.index + 1}`}</Typography.Text>
          )}{' '}
          <Typography.Text type={row.outcome === 'done' ? 'success' : 'danger'}>
            {row.outcome === 'done' ? 'выполнено' : 'не вышло'}
          </Typography.Text>
          {row.reason ? <Typography.Text type="secondary"> — {row.reason}</Typography.Text> : null}
        </div>
      ))}
    </div>
  );
}

export function ServiceBulkModal({
  target,
  latest,
  onClose,
}: {
  target: ServiceBulkTarget;
  /**
   * Свежая строка списка по идентификатору. «Повторить неудавшиеся» собирает пачку заново и берёт
   * версии ОТСЮДА: присланная в первый раз версия уже устарела — по ней и отказали.
   */
  latest: (id: string) => ServiceRequestDto | undefined;
  /**
   * Закрыть окно. Признак «пачка ушла» решает судьбу выбора: отменённое подтверждение оставляет
   * набор человеку, а закрытый отчёт его снимает — версии выбранных строк уже устарели.
   */
  onClose: (used: boolean) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const operation = target.kind === 'command' ? target.command.operation : target.run.operation;
  const requested =
    target.kind === 'command' ? target.command.rows.length : target.run.body.rows.length;

  const [phase, setPhase] = useState<Phase>(() =>
    target.kind === 'command' ? { kind: 'confirm' } : { kind: 'running', run: target.run },
  );
  const [sent, setSent] = useState<ServiceBulkRun | null>(
    target.kind === 'restored' ? target.run : null,
  );
  const [text, setText] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [processed, setProcessed] = useState(0);

  const finish = (result: ServiceRequestBulkResultDto) => {
    clearServiceBulkRun();
    // Гасится и справочник техники: карточка единицы собирает историю обслуживания join-ом.
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
    setPhase({ kind: 'report', result });
  };

  const run = useMutation({
    mutationFn: (next: ServiceBulkRun) => serviceRequestsApi.bulk(next.body, next.key),
    onSuccess: finish,
    /*
     * Сеть упала — окно остаётся, и «Повторить» шлёт ТОТ ЖЕ ключ и то же тело: это повтор
     * попытки, а не вторая команда. Сервер по ключу отдаст сохранённый отчёт, если пачка всё же
     * доехала, и выполнит её, если нет.
     */
    onError: (error, next) => setPhase({ kind: 'error', run: next, message: errorMessage(error) }),
  });

  const start = (next: ServiceBulkRun) => {
    saveServiceBulkRun(next);
    setSent(next);
    setProcessed(0);
    setPhase({ kind: 'running', run: next });
    run.mutate(next);
  };

  /*
   * Прогресс и восстановление после обрыва — одним опросом (Н12): синхронный `POST` о ходе дела
   * молчит, а перезагруженная вкладка не знает даже, доехала ли пачка. Первый вопрос своей же
   * идущей пачке задаётся не сразу — ответ на него всё равно был бы «обработано 0».
   */
  const polling = phase.kind === 'running';
  const pollKey = polling ? phase.run.key : null;
  const own = run.isPending;
  useEffect(() => {
    if (!pollKey) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const status = await serviceRequestsApi.bulkStatus(pollKey);
        if (!alive) return;
        setProcessed(status.processed);
        if (status.state === 'finished' && status.result) {
          finish(status.result);
          return;
        }
      } catch {
        /* пачка до сервера не доехала либо ответ потерян: «Продолжить» отправит её тем же ключом */
      }
      if (alive) timer = setTimeout(() => void ask(), POLL_MS);
    };
    timer = setTimeout(() => void ask(), own ? POLL_MS : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey, own]);

  const confirm = () => {
    // Повторное нажатие во время выполнения второго запроса не шлёт: пачка идёт секунды, и
    // кнопка всё это время видна.
    if (target.kind !== 'command' || run.isPending) return;
    const rows = target.command.rows.map((row) => ({ id: row.id, version: row.version }));
    const body = serviceBulkBody(operation, rows, text.trim());
    /*
     * Проверяется ТОЙ ЖЕ схемой, что и на сервере: отказ по пустой причине человек обязан увидеть
     * в поле, а не тостом после запроса, и второй набор правил длины и обязательности здесь
     * разошёлся бы с телом команды на первой же правке.
     */
    const parsed = serviceRequestBulkSchema.safeParse(body);
    if (!parsed.success) {
      setIssue(parsed.error.issues[0]?.message ?? 'Проверьте общую причину');
      return;
    }
    setIssue(null);
    start({ key: newIdempotencyKey(), operation, fingerprint: serviceBulkFingerprint(body), body });
  };

  /** Повтор неудавшихся: НОВАЯ пачка — новый ключ и свежие версии перечитанного списка (Р12). */
  const retryFailed = (result: ServiceRequestBulkResultDto) => {
    if (!sent || run.isPending) return;
    const rows = result.rows
      .filter((row) => row.outcome === 'failed')
      .map((row) => latest(row.id))
      .filter((row): row is ServiceRequestDto => !!row)
      .map((row) => ({ id: row.id, version: row.version }));
    if (rows.length === 0) {
      message.info('Неудавшихся заявок в текущем отборе больше нет — обновите список');
      return;
    }
    const body = serviceBulkBody(operation, rows, textOf(sent.body));
    start({ key: newIdempotencyKey(), operation, fingerprint: serviceBulkFingerprint(body), body });
  };

  const close = () => onClose(phase.kind !== 'confirm');
  const label = serviceRequestBulkOperationLabels[operation];
  const prompt = serviceBulkPrompts[operation];
  const warning = serviceBulkWarnings[operation];
  const failed = phase.kind === 'report' ? phase.result.failed : 0;
  /** Отчёт с неудачами клавишей не закрывается: человек обязан успеть его прочитать (Р12). */
  const escapable = phase.kind === 'confirm' || (phase.kind === 'report' && failed === 0);

  const footer = () => {
    if (phase.kind === 'running') {
      return run.isPending ? null : (
        // Аренда истекла либо ответ потерян: тот же ключ и то же тело — это продолжение, а не
        // вторая команда.
        <Button type="primary" onClick={() => start(phase.run)}>
          Продолжить
        </Button>
      );
    }
    if (phase.kind === 'error') {
      return (
        <Space>
          <Button onClick={close}>Закрыть</Button>
          <Button type="primary" onClick={() => start(phase.run)}>
            Повторить
          </Button>
        </Space>
      );
    }
    if (phase.kind === 'report') {
      return (
        <Space>
          {failed > 0 && (
            <Button onClick={() => retryFailed(phase.result)} loading={run.isPending}>
              Повторить неудавшиеся
            </Button>
          )}
          <Button type="primary" onClick={close}>
            Закрыть
          </Button>
        </Space>
      );
    }
    return (
      <Space>
        <Button onClick={close}>Отмена</Button>
        <Button
          type="primary"
          danger={target.kind === 'command' && target.command.danger}
          onClick={confirm}
        >
          {`${label}: ${serviceBulkRequestsLabel(requested)}`}
        </Button>
      </Space>
    );
  };

  return (
    <Modal
      open
      title={label}
      onCancel={close}
      footer={footer()}
      mask={{ closable: false }}
      keyboard={escapable}
      closable={phase.kind !== 'running'}
      destroyOnHidden
    >
      {phase.kind === 'confirm' && target.kind === 'command' && (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text>
            {`Применится к ${requested} из ${
              requested + target.command.skipped.length
            } выбранных заявок.`}
          </Typography.Text>
          <SkippedList skipped={target.command.skipped} />
          {warning && <Alert type="warning" showIcon title={warning} />}
          {prompt && (
            <label>
              {prompt.label}
              <Input.TextArea
                autoFocus
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
          {issue && <Typography.Text type="danger">{issue}</Typography.Text>}
        </Space>
      )}

      {phase.kind === 'running' && (
        <Space orientation="vertical" style={{ width: '100%' }}>
          {/* Считается по ТЕКУЩЕЙ пачке, а не по исходному выбору: повтор неудавшихся идёт своей
              длины, и «обработано 1 из 9» после него было бы неправдой. */}
          <Typography.Text aria-live="polite">
            {`Обработано ${processed} из ${phase.run.body.rows.length}`}
          </Typography.Text>
          <Progress percent={Math.round((processed / phase.run.body.rows.length) * 100)} />
        </Space>
      )}

      {phase.kind === 'error' && (
        <Alert
          type="error"
          showIcon
          title={phase.message}
          description="«Повторить» отправит ту же пачку тем же ключом: дважды заявки не тронутся."
        />
      )}

      {phase.kind === 'report' && (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text aria-live="polite">
            {`Выполнено: ${phase.result.done}. Не вышло: ${phase.result.failed}.`}
          </Typography.Text>
          <ReportRows result={phase.result} />
        </Space>
      )}
    </Modal>
  );
}
