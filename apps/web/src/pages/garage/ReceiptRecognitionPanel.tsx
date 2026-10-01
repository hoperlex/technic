import { useEffect, useRef } from 'react';
import { Alert, Button, Space, Typography, theme } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReceiptDraft,
  ReceiptRecognitionHealthDto,
  ReceiptRecognitionStateDto,
} from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { formatMoney } from '@shared/lib';
import './ReceiptRecognitionPanel.css';

/**
 * Recognition only proposes form values; this panel never saves a receipt. Unlike waste
 * tickets, receipts have no independent reference to reconcile against: the paper is the source.
 * Warnings stay non-blocking because omitted lines or a cropped scan may be intentional.
 * The paper's total is only a draft hint, but it can reveal a missing page or an overlooked row.
 */

/** Polling should expose completed pages promptly without keeping idle forms busy. */
const POLL_MS = 2000;

function truncatedText(notes: ReceiptDraft['notes']): string | null {
  if (notes.droppedLines > 0) {
    return `Распознано ${notes.recognizedLines} позиций, в один чек помещается 100 — остальные заведите вторым чеком с тем же номером`;
  }
  if (notes.linesTruncated) {
    return 'Похоже, таблица обрезана кадром: снимите лист целиком или допишите позиции руками';
  }
  return null;
}

/**
 * Compare integer kopecks; binary floating-point tails would otherwise flag matching totals.
 */
function totalsText(notes: ReceiptDraft['notes']): string | null {
  if (notes.linesTotal === null) return null;
  const diff = Math.round(notes.linesTotal * 100) - Math.round(notes.draftTotal * 100);
  if (diff === 0) return null;
  return `На бумаге «Итого» ${formatMoney(notes.linesTotal)}, в подставленных строках ${formatMoney(notes.draftTotal)} — проверьте, все ли позиции попали в кадр`;
}

/** VAT added above the line total is a billing convention, not a recognition error. */
function vatText(notes: ReceiptDraft['notes']): string | null {
  if (notes.linesTotal === null || notes.documentTotal === null) return null;
  return Math.round(notes.documentTotal * 100) > Math.round(notes.linesTotal * 100)
    ? `«Всего к оплате» ${formatMoney(notes.documentTotal)} больше «Итого» ${formatMoney(notes.linesTotal)}: НДС начислен сверх таблицы`
    : null;
}

function healthText(health: ReceiptRecognitionHealthDto): string {
  switch (health.state) {
    case 'disabled':
      return 'Распознавание чеков сейчас выключено — заполняйте форму руками.';
    case 'unconfigured':
      return `Сервис распознавания не настроен${health.code ? ` (${health.code})` : ''} — нужен администратор, само не восстановится.`;
    case 'degraded':
      return `Сервис распознавания сейчас недоступен: отказов за час ${health.failed} из ${health.attempts}. Попытки продолжатся сами.`;
    default:
      return '';
  }
}

export interface ReceiptRecognitionPanelProps {
  /** The most recently uploaded scan; null means the form has no scan yet. */
  fileId: string | null;
  /** Existing input requires confirmation before recognition replaces the form's rows. */
  formFilled: boolean;
  onApply: (draft: ReceiptDraft) => void;
  disabled?: boolean;
}

export function ReceiptRecognitionPanel({
  fileId,
  formFilled,
  onApply,
  disabled = false,
}: ReceiptRecognitionPanelProps) {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: autoPartReceiptKeys.recognition(fileId ?? 'none'),
    queryFn: () => autoPartReceiptApi.recognition(fileId!),
    enabled: !!fileId,
    // Stop polling after a result; an open form can otherwise keep fetching for hours.
    refetchInterval: (query) =>
      (query.state.data as ReceiptRecognitionStateDto | undefined)?.status === 'pending'
        ? POLL_MS
        : false,
  });

  /**
   * Health is relevant after a failure and while one live job has exceeded the UX threshold.
   * A normal in-flight scan does not need another polling stream.
   */
  const health = useQuery({
    queryKey: autoPartReceiptKeys.recognitionHealth(),
    queryFn: () => autoPartReceiptApi.recognitionHealth(),
    enabled: state.data?.status === 'failed' || state.data?.delayed === true,
  });

  const recognize = useMutation({
    mutationFn: (forced: boolean) => autoPartReceiptApi.recognize(fileId!, forced),
    onSuccess: (next) => {
      queryClient.setQueryData(autoPartReceiptKeys.recognition(next.fileId), next);
    },
  });

  /**
   * Auto-start each new upload only once: the response updates this query and reruns the effect.
   * The mutation object is intentionally excluded because its identity changes on every render.
   */
  const startedFor = useRef<string | null>(null);
  const status = state.data?.status;
  useEffect(() => {
    if (!fileId || disabled) return;
    if (status !== 'idle') return;
    if (startedFor.current === fileId) return;
    startedFor.current = fileId;
    recognize.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation identity is unstable; see above
  }, [fileId, status, disabled]);

  if (!fileId) return null;

  const data = state.data;
  const draft = data?.draft ?? null;
  const reading = data?.status === 'pending' || recognize.isPending;
  // A page has no measurable intermediate progress. Do not invent a timer-driven percentage
  // or show the previous result's counters while a forced recognition request is being queued.
  const totalPages = data?.status === 'pending' ? data.totalPages : 0;
  const processedPages = data?.status === 'pending' ? data.processedPages : 0;
  const hasProgress = totalPages > 0 && processedPages > 0;
  const progressLabel = totalPages
    ? `Успешно прочитано страниц: ${processedPages} из ${totalPages}`
    : 'Файл ожидает очереди или подготавливается к распознаванию.';

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      {reading && (
        <div className="receipt-recognition-progress">
          <Space size={8} align="start">
            <LoadingOutlined
              spin
              aria-hidden="true"
              style={{ color: data?.delayed ? token.colorWarning : token.colorPrimary }}
            />
            <Typography.Text role="status" type={data?.delayed ? 'warning' : undefined}>
              {data?.delayed
                ? 'Распознавание задержалось — ждать дальше необязательно'
                : 'Распознаём чек…'}
            </Typography.Text>
          </Space>
          <div
            className="receipt-recognition-progress__track"
            role="progressbar"
            aria-busy="true"
            aria-label="Распознавание чека"
            aria-valuemin={0}
            aria-valuemax={totalPages || undefined}
            aria-valuenow={hasProgress ? processedPages : undefined}
            aria-valuetext={progressLabel}
            style={{ background: token.colorFillSecondary }}
          >
            <span
              className={hasProgress ? undefined : 'receipt-recognition-progress__indeterminate'}
              style={{
                background: data?.delayed ? token.colorWarning : token.colorPrimary,
                width: hasProgress ? `${(processedPages / totalPages) * 100}%` : undefined,
              }}
            />
          </div>
          <Typography.Text type="secondary" className="receipt-recognition-progress__hint">
            {data?.delayed
              ? progressLabel
              : 'Подождите немного: ориентир — 20–30 секунд на страницу, иногда дольше.'}
            {!data?.delayed && totalPages > 0 && ` ${progressLabel}`}
          </Typography.Text>
          <Typography.Text type="secondary" className="receipt-recognition-progress__hint">
            Можно продолжить вручную или перезагрузить страницу: черновик и сканы восстановятся.
          </Typography.Text>
          {data?.delayed && health.data && health.data.state !== 'ok' && (
            <Typography.Text type="secondary" className="receipt-recognition-progress__hint">
              {healthText(health.data)}
            </Typography.Text>
          )}
        </div>
      )}

      {data?.status === 'failed' && (
        <Alert
          type="warning"
          showIcon
          title="Распознать скан не удалось — заполните чек руками"
          description={
            <Space orientation="vertical" size={4}>
              <Typography.Text>
                {data.errorClass === 'terminal'
                  ? `${data.message} Автоматического повтора не будет.`
                  : `${data.message} Можно попробовать ещё раз.`}
              </Typography.Text>
              {/* A service-wide failure needs a different explanation from an unreadable scan;
                  repeated manual retries cannot repair an unavailable subsystem. */}
              {health.data && health.data.state !== 'ok' && (
                <Typography.Text type="secondary">{healthText(health.data)}</Typography.Text>
              )}
            </Space>
          }
          action={
            <Button size="small" disabled={disabled} onClick={() => recognize.mutate(true)}>
              Ещё раз
            </Button>
          }
        />
      )}

      {data?.status === 'unsupported' && (
        <Alert
          type="warning"
          showIcon
          title="Это не изображение и не PDF"
          description={data.message}
        />
      )}

      {data?.duplicate && (
        <Alert
          type="warning"
          showIcon
          title={`Этот скан уже подшит к чеку № ${data.duplicate.documentNumber} от ${data.duplicate.purchasedOn}`}
          description="Проверьте, не вносите ли покупку второй раз."
        />
      )}

      {draft && data?.status === 'done' && (
        <Alert
          type="success"
          showIcon
          title={`Распознано позиций: ${draft.lines.length}`}
          description={
            <Space orientation="vertical" size={4}>
              {[truncatedText(draft.notes), totalsText(draft.notes), vatText(draft.notes)]
                .filter((text): text is string => !!text)
                .map((text) => (
                  <Typography.Text key={text} type="warning">
                    {text}
                  </Typography.Text>
                ))}
              {data.processedPages < data.totalPages && (
                <Typography.Text type="warning">
                  {`В файле страниц: ${data.totalPages}, прочитано: ${data.processedPages}`}
                </Typography.Text>
              )}
            </Space>
          }
          action={
            <Space orientation="vertical" size={4}>
              <Button
                size="small"
                type="primary"
                disabled={disabled}
                onClick={() => {
                  // Confirm only when applying the draft would overwrite existing user input.
                  if (
                    !formFilled ||
                    window.confirm(`Заменить набранное распознанным (${draft.lines.length} строк)?`)
                  ) {
                    onApply(draft);
                  }
                }}
              >
                Заполнить форму
              </Button>
              <Button size="small" disabled={disabled} onClick={() => recognize.mutate(true)}>
                Распознать заново
              </Button>
            </Space>
          }
        />
      )}
    </Space>
  );
}
