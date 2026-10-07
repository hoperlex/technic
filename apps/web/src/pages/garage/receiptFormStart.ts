import dayjs, { type Dayjs } from 'dayjs';
import { moscowDateKeyOf, type AutoPartReceiptDto } from '@technic/contracts';
import type { ScanFile } from './ReceiptScanField';
import { loadReceiptCreateDraft } from './receiptCreateDraftStorage';
import { newReceiptLine, receiptLinesFromDto, type ReceiptLineRow } from './receiptLines';

/** Header fields of the receipt window. */
export interface ReceiptHeaderValues {
  purchasedOn: Dayjs;
  documentNumber: string;
  sellerName?: string;
  note?: string;
}

/** What one session of the window starts from: the receipt, the user's create draft or nothing. */
export interface ReceiptFormStart {
  values: Partial<ReceiptHeaderValues>;
  files: ScanFile[];
  rows: ReceiptLineRow[];
  appliedFileIds: string[];
}

export function receiptFormStart(
  receipt: AutoPartReceiptDto | null,
  userId: string | null,
): ReceiptFormStart {
  if (receipt) {
    return {
      values: {
        purchasedOn: dayjs(receipt.purchasedOn),
        documentNumber: receipt.documentNumber,
        sellerName: receipt.sellerName,
        note: receipt.note,
      },
      files: receipt.files.map((file) => ({ ...file })),
      rows: receiptLinesFromDto(receipt.lines),
      appliedFileIds: [],
    };
  }
  const restored = userId ? loadReceiptCreateDraft(userId) : null;
  if (restored) {
    return {
      values: {
        purchasedOn: dayjs(restored.values.purchasedOn),
        documentNumber: restored.values.documentNumber,
        sellerName: restored.values.sellerName,
        note: restored.values.note,
      },
      files: restored.files.map((file) => ({ ...file })),
      rows: restored.rows.map((row) => ({ ...row })),
      appliedFileIds: restored.appliedFileIds ?? [],
    };
  }
  return {
    // The Moscow day is the same boundary the API validates around midnight. Taken when the window
    // opens: a form opened before midnight keeps yesterday as its default (stage 5 plan §4.5).
    values: { purchasedOn: dayjs(moscowDateKeyOf(new Date())) },
    files: [],
    rows: [newReceiptLine()],
    appliedFileIds: [],
  };
}
