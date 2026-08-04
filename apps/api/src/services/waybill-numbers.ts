import { eq, sql } from 'drizzle-orm';
import { waybillDisplayNumber, type WaybillFormCode } from '@technic/contracts';
import { db } from '../db/client';
import { waybillSeries } from '../db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Нумерация путевых листов (ADR 0037 п. 11).
 *
 * Номер выдаётся при выдаче листа, а не при создании черновика: черновиков у листа нет, и дыр
 * от брошенных — тоже. Счётчик живёт строкой в `waybill_series`, а не sequence: sequence не
 * откатывается вместе с транзакцией, а журнал учёта строгой отчётности читают как непрерывный —
 * пропущенный номер там означает утраченный бланк, а не откат.
 */

export interface IssuedNumber {
  seriesId: string;
  number: number;
  /** Серия: печатается в своей графе бланка отдельно от номера. */
  prefix: string;
  /** Как номер печатают и ищут: «260604-646-00000004897». */
  display: string;
}

/**
 * Берёт следующий номер серии, блокируя её строку до конца транзакции. Вызывать только внутри
 * транзакции выдачи листа: вне её блокировка снимется раньше, чем лист сохранится, и два
 * одновременных перевода заявок в работу получат один номер.
 */
export async function takeNextNumber(tx: Tx, seriesId: string): Promise<IssuedNumber> {
  const [series] = await tx
    .select({
      id: waybillSeries.id,
      prefix: waybillSeries.prefix,
      nextNumber: waybillSeries.nextNumber,
      numberWidth: waybillSeries.numberWidth,
      isActive: waybillSeries.isActive,
    })
    .from(waybillSeries)
    .where(eq(waybillSeries.id, seriesId))
    .for('update');

  if (!series) throw new Error(`Серия путевых листов ${seriesId} не найдена`);
  if (!series.isActive) throw new Error(`Серия «${series.prefix}» отключена`);

  const number = series.nextNumber;
  await tx
    .update(waybillSeries)
    .set({ nextNumber: sql`${waybillSeries.nextNumber} + 1`, updatedAt: new Date() })
    .where(eq(waybillSeries.id, seriesId));

  return {
    seriesId: series.id,
    number,
    prefix: series.prefix,
    display: waybillDisplayNumber(series.prefix, number, series.numberWidth),
  };
}

/**
 * Какой серией нумеруется бланк (миграция 0087).
 *
 * Серий стало две. У ЭСМ-2 своя: заявка на месяц забирает пять номеров разом, а каждое досрочное
 * завершение сжигает и выписывает ещё столько же — в общей серии журнал 4-П получал бы дыры от
 * документов, которых в нём нет. Листы на рейс остаются в основной.
 */
const SERIES_BY_FORM: Record<WaybillFormCode, string> = {
  '4p': 'main',
  leg3: 'main',
  esm2: 'esm2',
};

export function seriesCodeOfForm(formCode: WaybillFormCode): string {
  return SERIES_BY_FORM[formCode];
}

/** Серия по коду — ею пользуется выдача, выбирая счётчик по бланку (`seriesCodeOfForm`). */
export async function findSeriesByCode(code: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: waybillSeries.id })
    .from(waybillSeries)
    .where(eq(waybillSeries.code, code));
  return row ?? null;
}
