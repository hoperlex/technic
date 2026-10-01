import type { ReceiptDraft } from '@technic/contracts';
import { RECEIPT_MAX_LINES } from '@technic/contracts';
import { ReceiptRecognitionStatus } from './ReceiptRecognitionStatus';
import { useReceiptRecognitionBatch, type RecognitionScan } from './useReceiptRecognitionBatch';

export interface ReceiptRecognitionPanelProps {
  /** Attachment order is the paper page order, even when uploads finish out of order. */
  files: readonly RecognitionScan[];
  /** Files being uploaded do not have an ID yet; applying OCR must wait for them. */
  uploadCount?: number;
  /** Files whose recognized rows are already in the editable form. */
  appliedFileIds?: readonly string[];
  /** Current form rows, excluding a single untouched placeholder. */
  lineCount?: number;
  /** Existing input requires confirmation before OCR replaces it. */
  formFilled: boolean;
  onApply: (draft: ReceiptDraft, fileIds: string[], mode: 'replace' | 'append') => void;
  onResetApplied?: () => void;
  disabled?: boolean;
}

export function ReceiptRecognitionPanel({
  files,
  uploadCount = 0,
  appliedFileIds = [],
  lineCount = 0,
  formFilled,
  onApply,
  onResetApplied,
  disabled = false,
}: ReceiptRecognitionPanelProps) {
  const batch = useReceiptRecognitionBatch(files, uploadCount, disabled, appliedFileIds);
  const blockedByLineLimit =
    batch.applyMode === 'append' &&
    !!batch.applyDraft &&
    batch.applyDraft.lines.length + lineCount > RECEIPT_MAX_LINES;
  const notices = blockedByLineLimit
    ? [
        ...batch.extraNotices,
        `Новые позиции не поместятся в один чек (предел — ${RECEIPT_MAX_LINES}). Заведите второй чек с тем же номером.`,
      ]
    : batch.extraNotices;

  return (
    <ReceiptRecognitionStatus
      data={batch.data}
      health={batch.health}
      fileSelected={files.length > 0 || uploadCount > 0}
      reading={batch.reading}
      requestError={batch.requestError}
      disabled={disabled}
      formFilled={formFilled}
      onRetry={() => {
        if (!batch.hasFailed && batch.data?.status === 'done') onResetApplied?.();
        batch.retry();
      }}
      onApply={() => {
        if (!batch.applyDraft || blockedByLineLimit) return;
        onApply(batch.applyDraft, batch.appliedFileIds, batch.applyMode);
      }}
      progressUnit={batch.grouped ? 'files' : 'pages'}
      extraNotices={notices}
      alreadyApplied={batch.alreadyApplied}
      applyMode={batch.applyMode}
      applyBlocked={blockedByLineLimit}
      retryFailed={batch.grouped && batch.hasFailed}
      pendingLineCount={batch.applyDraft?.lines.length}
    />
  );
}
