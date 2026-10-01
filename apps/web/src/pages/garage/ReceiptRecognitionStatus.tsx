import { Button, Typography, theme } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import type {
  ReceiptDraft,
  ReceiptRecognitionHealthDto,
  ReceiptRecognitionStateDto,
} from '@technic/contracts';
import { formatMoney } from '@shared/lib';
import './ReceiptRecognitionPanel.css';

/**
 * The paper is the only source of truth. A cropped scan, omitted rows and VAT need distinct
 * explanations, but warnings never prohibit applying a draft and do not create a receipt.
 */
function draftWarnings(
  draft: ReceiptDraft,
  data: ReceiptRecognitionStateDto,
  progressUnit: 'files' | 'pages',
): string[] {
  const { notes } = draft;
  const warnings: string[] = [];
  if (notes.droppedLines > 0) {
    warnings.push(
      `Распознано ${notes.recognizedLines} позиций, в один чек помещается 100 — остальные заведите вторым чеком с тем же номером`,
    );
  } else if (notes.linesTruncated) {
    warnings.push(
      'Похоже, таблица обрезана кадром: снимите лист целиком или допишите позиции руками',
    );
  }
  // Compare integer kopecks; binary floating-point tails must not flag matching totals.
  if (
    notes.linesTotal !== null &&
    Math.round(notes.linesTotal * 100) !== Math.round(notes.draftTotal * 100)
  ) {
    warnings.push(
      `На бумаге «Итого» ${formatMoney(notes.linesTotal)}, в подставленных строках ${formatMoney(notes.draftTotal)} — проверьте, все ли позиции попали в кадр`,
    );
  }
  // VAT above the line total is a billing convention, not a recognition failure.
  if (
    notes.linesTotal !== null &&
    notes.documentTotal !== null &&
    Math.round(notes.documentTotal * 100) > Math.round(notes.linesTotal * 100)
  ) {
    warnings.push(
      `«Всего к оплате» ${formatMoney(notes.documentTotal)} больше «Итого» ${formatMoney(notes.linesTotal)}: НДС начислен сверх таблицы`,
    );
  }
  if (progressUnit === 'pages' && data.processedPages < data.totalPages) {
    warnings.push(`В файле страниц: ${data.totalPages}, прочитано: ${data.processedPages}`);
  }
  return warnings;
}

function healthText(health?: ReceiptRecognitionHealthDto): string | undefined {
  switch (health?.state) {
    case 'disabled':
      return 'Распознавание чеков сейчас выключено — заполняйте форму руками.';
    case 'unconfigured':
      return `Сервис распознавания не настроен${health.code ? ` (${health.code})` : ''} — нужен администратор, само не восстановится.`;
    case 'degraded':
      return `Сервис распознавания сейчас недоступен: отказов за час ${health.failed} из ${health.attempts}. Попытки продолжатся сами.`;
    default:
      return undefined;
  }
}

interface Props {
  data?: ReceiptRecognitionStateDto;
  health?: ReceiptRecognitionHealthDto;
  reading: boolean;
  fileSelected: boolean;
  requestError?: string;
  disabled: boolean;
  formFilled: boolean;
  onRetry: () => void;
  onApply: (draft: ReceiptDraft) => void;
  progressUnit?: 'files' | 'pages';
  extraNotices?: readonly string[];
  alreadyApplied?: boolean;
  applyMode?: 'replace' | 'append';
  applyBlocked?: boolean;
  retryFailed?: boolean;
  pendingLineCount?: number;
}

export function ReceiptRecognitionStatus({
  data,
  health,
  reading,
  fileSelected,
  requestError,
  disabled,
  formFilled,
  onRetry,
  onApply,
  progressUnit = 'pages',
  extraNotices = [],
  alreadyApplied = false,
  applyMode = 'replace',
  applyBlocked = false,
  retryFailed = false,
  pendingLineCount,
}: Props) {
  const { token } = theme.useToken();
  // A forced retry must not offer the previous draft while its POST is still in flight.
  const draft = !reading && data?.status === 'done' ? data.draft : null;
  const failed = !reading && data?.status === 'failed';
  const unsupported = !reading && data?.status === 'unsupported';
  const delayed = reading && data?.delayed === true;
  const showRequestError = !reading && !!requestError;
  const warning = delayed || failed || unsupported || showRequestError;
  const title = reading
    ? delayed
      ? 'Распознавание задержалось — ждать дальше необязательно'
      : 'Распознаём чек…'
    : failed
      ? 'Распознать скан не удалось — заполните чек руками'
      : unsupported
        ? 'Это не изображение и не PDF'
        : showRequestError
          ? 'Не удалось получить результат распознавания'
          : draft
            ? alreadyApplied
              ? 'Распознанные позиции уже в форме'
              : applyMode === 'append'
                ? `Новых позиций: ${pendingLineCount ?? 0}`
                : `Распознано позиций: ${draft.lines.length}`
            : 'Распознавание чека';
  const Icon = reading
    ? LoadingOutlined
    : warning
      ? ExclamationCircleOutlined
      : draft
        ? CheckCircleOutlined
        : FileSearchOutlined;
  const color = warning ? token.colorWarning : draft ? token.colorSuccess : token.colorPrimary;

  // The provider reports completed pages, not progress within one page.
  const totalPages = data?.status === 'pending' ? data.totalPages : 0;
  const processedPages = data?.status === 'pending' ? data.processedPages : 0;
  const hasProgress = totalPages > 0 && processedPages > 0;
  const progressLabel = totalPages
    ? progressUnit === 'files'
      ? `Распознано файлов: ${processedPages} из ${totalPages}`
      : `Успешно прочитано страниц: ${processedPages} из ${totalPages}`
    : 'Файл ожидает очереди или подготавливается к распознаванию.';
  const serviceMessage = failed || delayed ? healthText(health) : undefined;
  const warnings = draft && data ? draftWarnings(draft, data, progressUnit) : [];

  return (
    <section
      className="receipt-recognition-panel"
      aria-label="Распознавание скана чека"
      style={{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }}
    >
      <div className="receipt-recognition-panel__heading">
        <Icon spin={reading} aria-hidden="true" style={{ color }} />
        <Typography.Text role="status" strong>
          {title}
        </Typography.Text>
      </div>
      <div
        className="receipt-recognition-progress__track"
        role={reading ? 'progressbar' : undefined}
        aria-hidden={!reading}
        aria-busy={reading || undefined}
        aria-label={reading ? 'Распознавание чека' : undefined}
        aria-valuemin={reading ? 0 : undefined}
        aria-valuemax={reading ? totalPages || undefined : undefined}
        aria-valuenow={reading && hasProgress ? processedPages : undefined}
        aria-valuetext={reading ? progressLabel : undefined}
        style={{ background: reading ? token.colorFillSecondary : undefined }}
      >
        {reading && (
          <span
            className={hasProgress ? undefined : 'receipt-recognition-progress__indeterminate'}
            style={{
              background: color,
              width: hasProgress ? `${(processedPages / totalPages) * 100}%` : undefined,
            }}
          />
        )}
      </div>
      <div
        className="receipt-recognition-panel__body"
        role="region"
        aria-label="Подробности распознавания"
        aria-live="polite"
        tabIndex={0}
      >
        {reading && (
          <>
            <p>
              {delayed
                ? progressLabel
                : 'Подождите немного: ориентир — 20–30 секунд на страницу, иногда дольше.'}
              {!delayed && totalPages > 0 && ` ${progressLabel}`}
            </p>
            <p>
              Можно продолжить вручную или перезагрузить страницу: черновик и сканы восстановятся.
            </p>
          </>
        )}
        {failed && (
          <p>
            {data.errorClass === 'terminal'
              ? `${data.message} Автоматического повтора не будет.`
              : `${data.message} Можно попробовать ещё раз.`}
          </p>
        )}
        {unsupported && <p>{data.message}</p>}
        {showRequestError && <p>{requestError}</p>}
        {serviceMessage && <p>{serviceMessage}</p>}
        {!reading && progressUnit === 'files' && data && (
          <p>{`Распознано файлов: ${data.processedPages} из ${data.totalPages}`}</p>
        )}
        {!reading && data?.duplicate && (
          <p
            className="receipt-recognition-panel__warning"
            style={{ color: token.colorWarningText }}
          >
            <ExclamationCircleOutlined aria-hidden="true" />
            <span>
              {`Этот скан уже подшит к чеку № ${data.duplicate.documentNumber} от ${data.duplicate.purchasedOn}`}
              {' — проверьте, не вносите ли покупку второй раз.'}
            </span>
          </p>
        )}
        {warnings.map((message) => (
          <p
            key={message}
            className="receipt-recognition-panel__warning"
            style={{ color: token.colorWarningText }}
          >
            <ExclamationCircleOutlined aria-hidden="true" />
            <span>{message}</span>
          </p>
        ))}
        {extraNotices.map((message) => (
          <p
            key={message}
            className="receipt-recognition-panel__warning"
            style={{ color: token.colorWarningText }}
          >
            <ExclamationCircleOutlined aria-hidden="true" />
            <span>{message}</span>
          </p>
        ))}
        {draft && warnings.length === 0 && extraNotices.length === 0 && !alreadyApplied && (
          <p>Проверьте данные и нажмите «Заполнить форму».</p>
        )}
        {!reading && !failed && !unsupported && !showRequestError && !draft && (
          <p>
            {fileSelected
              ? 'Скан прикреплён. Можно заполнить чек вручную.'
              : 'Прикрепите скан — распознаем данные и предложим заполнить форму.'}
          </p>
        )}
      </div>
      <div className="receipt-recognition-panel__actions">
        {!reading && (failed || showRequestError) && (
          <Button size="small" disabled={disabled} onClick={onRetry}>
            Ещё раз
          </Button>
        )}
        {draft && (
          <>
            <Button size="small" disabled={disabled} onClick={onRetry}>
              {retryFailed ? 'Повторить сбой' : 'Распознать заново'}
            </Button>
            {!alreadyApplied && (
              <Button
                size="small"
                type="primary"
                disabled={disabled || applyBlocked}
                onClick={() => {
                  // Append preserves edits to earlier pages; replacing existing input still needs consent.
                  if (
                    applyMode === 'append' ||
                    !formFilled ||
                    window.confirm(`Заменить набранное распознанным (${draft.lines.length} строк)?`)
                  ) {
                    onApply(draft);
                  }
                }}
              >
                {applyMode === 'append' ? 'Добавить новые строки' : 'Заполнить форму'}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
