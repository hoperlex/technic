import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { AutoPartApplicationExportQuery } from '@technic/contracts';
import { db } from '../db/client';
import { autoPartApplications, autoPartReceiptLines, autoPartReceipts, users } from '../db/schema';
import { writeWorkbook } from '../lib/xlsx';
import { loadVehicleBriefs, type Reader } from './auto-part-receipts-read';

export interface AutoPartApplicationsExportResult {
  filename: string;
  bytes: Uint8Array;
}

/** First day of the following month without depending on the process time zone. */
function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  return value === 12
    ? `${String(year + 1).padStart(4, '0')}-01-01`
    : `${String(year).padStart(4, '0')}-${String(value + 1).padStart(2, '0')}-01`;
}

/**
 * A stable monthly reporting form based on immutable application documents, not current stock.
 * Current balances cannot reproduce what happened during a closed month after later applications.
 */
export async function buildAutoPartApplicationsExport(
  query: AutoPartApplicationExportQuery,
  reader: Reader = db,
): Promise<AutoPartApplicationsExportResult> {
  const from = `${query.month}-01`;
  const to = nextMonth(query.month);
  const rows = await reader
    .select({
      appliedOn: autoPartApplications.appliedOn,
      documentNumber: autoPartApplications.documentNumber,
      vehicleId: autoPartApplications.vehicleId,
      purchasedOn: autoPartReceipts.purchasedOn,
      receiptDocumentNumber: autoPartReceipts.documentNumber,
      sellerName: autoPartReceipts.sellerName,
      article: autoPartReceiptLines.article,
      name: autoPartReceiptLines.name,
      quantity: autoPartApplications.quantity,
      unit: autoPartReceiptLines.unit,
      amount: autoPartApplications.amount,
      note: autoPartApplications.note,
      createdByName: users.fullName,
      createdAt: autoPartApplications.createdAt,
    })
    .from(autoPartApplications)
    .innerJoin(
      autoPartReceiptLines,
      eq(autoPartReceiptLines.id, autoPartApplications.receiptLineId),
    )
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .innerJoin(users, eq(users.id, autoPartApplications.createdBy))
    .where(and(gte(autoPartApplications.appliedOn, from), lt(autoPartApplications.appliedOn, to)))
    .orderBy(
      asc(autoPartApplications.appliedOn),
      asc(autoPartApplications.createdAt),
      asc(autoPartApplications.id),
    );
  const vehicles = await loadVehicleBriefs(
    reader,
    rows.map((row) => row.vehicleId),
  );

  const header = [
    'Дата применения',
    'Документ применения',
    'Техника',
    'Дата чека',
    'Номер чека',
    'Продавец',
    'Артикул',
    'Наименование',
    'Количество',
    'Единица',
    'Сумма, ₽',
    'Примечание',
    'Оформил',
  ];
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  const reportRows = rows.map((row) => [
    { date: row.appliedOn } as const,
    row.documentNumber,
    vehicles.get(row.vehicleId)?.label ?? row.vehicleId,
    { date: row.purchasedOn } as const,
    row.receiptDocumentNumber,
    row.sellerName,
    row.article,
    row.name,
    { num: row.quantity, digits: 0 as const },
    row.unit,
    { num: Number(row.amount) },
    row.note,
    row.createdByName,
  ]);
  const bytes = writeWorkbook([
    {
      name: 'Применение со склада',
      rows: [
        [`Применение автозапчастей со склада за ${query.month}`],
        [],
        header,
        ...reportRows,
        ['', '', '', '', '', '', '', '', '', 'Итого', { num: total }],
      ],
      widths: [14, 20, 24, 14, 18, 24, 18, 34, 12, 10, 14, 30, 24],
      headerRow: 3,
      freezeHeader: true,
    },
  ]);
  return { filename: `Применение автозапчастей ${query.month}.xlsx`, bytes };
}
