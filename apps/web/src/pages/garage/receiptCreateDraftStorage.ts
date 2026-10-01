import type { ScanFile } from './ReceiptScanField';
import type { ReceiptLineRow } from './receiptLines';

interface ReceiptCreateDraftValues {
  purchasedOn: string;
  documentNumber: string;
  sellerName: string;
  note: string;
}

export interface ReceiptCreateDraftSnapshot {
  values: ReceiptCreateDraftValues;
  files: ScanFile[];
  rows: ReceiptLineRow[];
}

interface StoredReceiptCreateDraft extends ReceiptCreateDraftSnapshot {
  version: 1;
}

const STORAGE_PREFIX = 'auto-part-receipt-create-draft:v1:';

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isScanFile(value: unknown): value is ScanFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return (
    isString(file.id) &&
    isString(file.filename) &&
    (file.contentType === undefined || isString(file.contentType)) &&
    (file.size === undefined ||
      (typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0)) &&
    (file.isNew === undefined || typeof file.isNew === 'boolean')
  );
}

function isReceiptRow(value: unknown): value is ReceiptLineRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isString(row.key) &&
    (row.vehicleId === null || isString(row.vehicleId)) &&
    typeof row.toWarehouse === 'boolean' &&
    isString(row.article) &&
    isString(row.name) &&
    isNullableFiniteNumber(row.quantity) &&
    isString(row.unit) &&
    isNullableFiniteNumber(row.amount) &&
    isString(row.note)
  );
}

function parseStored(value: unknown): StoredReceiptCreateDraft | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  const values = stored.values as Record<string, unknown> | undefined;
  if (
    stored.version !== 1 ||
    !values ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(values.purchasedOn ?? '')) ||
    !isString(values.documentNumber) ||
    !isString(values.sellerName) ||
    !isString(values.note) ||
    !Array.isArray(stored.files) ||
    !stored.files.every(isScanFile) ||
    !Array.isArray(stored.rows) ||
    !stored.rows.every(isReceiptRow)
  ) {
    return null;
  }
  return stored as unknown as StoredReceiptCreateDraft;
}

export function loadReceiptCreateDraft(userId: string): ReceiptCreateDraftSnapshot | null {
  try {
    const raw = sessionStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const stored = parseStored(JSON.parse(raw));
    if (!stored) sessionStorage.removeItem(storageKey(userId));
    return stored;
  } catch {
    return null;
  }
}

export function saveReceiptCreateDraft(userId: string, snapshot: ReceiptCreateDraftSnapshot): void {
  try {
    const stored: StoredReceiptCreateDraft = { version: 1, ...snapshot };
    sessionStorage.setItem(storageKey(userId), JSON.stringify(stored));
  } catch {
    // Storage may be unavailable in hardened/private browser modes; the form must remain usable.
  }
}

export function clearReceiptCreateDraft(userId: string): void {
  try {
    sessionStorage.removeItem(storageKey(userId));
  } catch {
    // Clearing a best-effort draft must never block closing or saving the receipt.
  }
}
