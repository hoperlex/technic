import { and, asc, gt, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { wasteRequests } from '../src/db/schema';
import {
  recomputeTicketReviewState,
  ticketPaperSql,
} from '../src/services/waste-ticket-review-state';

/**
 * Прогрев состояния разбора талонов (план `docs/waste-ticket-auto-confirm-plan.md`, Р19; выпуск A,
 * шаг выката).
 *
 * ЗАЧЕМ ОН. Миграция заводит `waste_ticket_review_state` пустой: посчитать числа значка на SQL
 * значило бы записать правило сверки второй раз — со всеми допусками, отклонёнными талонами и
 * снятыми принятиями. Наполняет таблицу тот же код, что считает карточку и список, и делает это
 * заранее: до конца прогрева реестр «Требуют разбора» показывает лишнее (пустая строка читается
 * как «не знаем», Р21), а не прячет нужное, — но показывать лишнее сутки тоже не годится.
 *
 * ЗАПУСКАТЬ ПОСЛЕ ПЕРЕЗАПУСКА API. Прогон, начатый до него, посчитал бы заявки правилами прежней
 * версии и записал бы их с прежним отпечатком — то есть сделал бы ровно ту работу, которую первое
 * же чтение выбросит.
 *
 * ЗАМКА ЗАЯВКИ ОН НЕ БЕРЁТ. Мутации разбора начинаются с `FOR UPDATE` по заявке, и прогон,
 * повторяющий этот порядок, часами стоял бы в очереди к живой работе — и стоял бы у неё на пути.
 * Ему это не нужно: запись состояния условна по ревизии, и проигранная гонка означает всего лишь
 * пропущенную строку, которую перечитает и починит список. Отсюда же отсутствие транзакции на
 * заявку: атомарности здесь защищать нечего.
 *
 * WHAT IT SELECTS. Requests that have PAPER, by the same condition the checks use: a ticket, a
 * recognition row, or a live attached ticket file of a type inside the unreviewed-paper boundary
 * (`countsUnreviewedTicketPaper`: garbage and snow). The last part is not a remark about types but
 * the ADR 0150 boundary about the past: attached receipts of other types do not wait for review,
 * and a warm-up that counted them would flood the register with long-closed requests.
 *
 * Заявки без бумаги не считаются вовсе: строки у них нет и быть не должно («разбирать нечего» и
 * «всё разобрано» — разные ответы), а прогон по всей таблице заявок стоил бы часов ради пустых
 * расчётов.
 *
 * Коды возврата: 0 — посчитано всё, 1 — не разобраны аргументы, 2 — часть заявок не посчиталась.
 *
 * Использование:
 *   pnpm --filter @technic/api recompute:ticket-review
 *   pnpm --filter @technic/api recompute:ticket-review -- --batch 500
 */

const EXIT_FAILURE = 1;
const EXIT_INCOMPLETE = 2;
/** Пачка: столько заявок читается одним запросом отбора и печатается одной строкой прогресса. */
const DEFAULT_BATCH = 200;
/** Сколько первых ошибок показать целиком: чинят их по одной, а список бывает длинным. */
const SAMPLE_LIMIT = 10;

interface Options {
  batch: number;
}

function parseArgs(argv: readonly string[]): Options | string {
  let batch = DEFAULT_BATCH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Разделитель `pnpm run … -- --batch` доезжает до `argv` отдельным словом: спотыкаться о
    // собственный способ запуска скрипт не должен.
    if (arg === '--') continue;
    if (arg === '--batch') {
      const value = Number(argv[i + 1] ?? '');
      if (!Number.isInteger(value) || value <= 0) return 'размер пачки — целое число больше нуля';
      batch = value;
      i += 1;
      continue;
    }
    return `неизвестный аргумент «${arg}»`;
  }
  return { batch };
}

/**
 * "The request has paper" — the same condition that decides whether it gets a badge (R21), shared
 * with the register (`ticketPaperSql`): a ticket (manual ones included), a recognition file row, or
 * a ticket file attached to a type whose unreviewed paper counts (garbage and snow, ADR 0150).
 */
const hasPaper = ticketPaperSql(wasteRequests.id, wasteRequests.requestType);

/**
 * Следующая пачка заявок с бумагой — по возрастанию `id`, начиная с последней посчитанной.
 *
 * Ключом, а не `OFFSET`: прогон идёт минутами, и заявки в это время заводят и удаляют — смещение
 * пропустило бы ровно столько строк, сколько их появилось.
 */
async function nextBatch(after: string, limit: number): Promise<{ id: string; num: number }[]> {
  return db
    .select({ id: wasteRequests.id, num: wasteRequests.num })
    .from(wasteRequests)
    .where(
      and(
        sql`${wasteRequests.deletedAt} IS NULL`,
        after ? gt(wasteRequests.id, after) : undefined,
        hasPaper,
      ),
    )
    .orderBy(asc(wasteRequests.id))
    .limit(limit);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`recompute:ticket-review: ${parsed}`);
    process.exit(EXIT_FAILURE);
  }

  const startedAt = Date.now();
  console.log(`recompute:ticket-review: пачка — ${parsed.batch} заявок`);

  let after = '';
  let done = 0;
  const failures: string[] = [];
  for (;;) {
    const batch = await nextBatch(after, parsed.batch);
    if (batch.length === 0) break;
    after = batch[batch.length - 1]!.id;

    for (const request of batch) {
      try {
        await recomputeTicketReviewState(db, request.id);
        done += 1;
      } catch (error) {
        // Одна упавшая заявка прогон не останавливает: остальные считаются, а её строка остаётся
        // непосчитанной — то есть ровно тем, чем была до прогона, и список посчитает её сам.
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`М-${request.num}: ${message}`);
      }
    }
    console.log(`  посчитано ${done}, последняя пачка — ${batch.length}`);
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `recompute:ticket-review: итого посчитано ${done} за ${seconds} с${
      failures.length > 0 ? `, не посчиталось ${failures.length}` : ''
    }`,
  );
  if (failures.length === 0) return;
  for (const failure of failures.slice(0, SAMPLE_LIMIT)) console.error(`  ${failure}`);
  if (failures.length > SAMPLE_LIMIT) {
    console.error(`  … и ещё ${failures.length - SAMPLE_LIMIT}`);
  }
  // Непосчитанные заявки — не успех: «зелёный» прогон в выкате скрыл бы недоделанное, а реестр
  // показывал бы по ним лишнее до первого открытия списка.
  process.exit(EXIT_INCOMPLETE);
}

await main().catch((error: unknown) => {
  console.error(
    `recompute:ticket-review: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(EXIT_FAILURE);
});
// Явный выход: пул соединений держит цикл событий, и без него прогон, сделавший всё, просто висел
// бы в выкате.
process.exit(0);
