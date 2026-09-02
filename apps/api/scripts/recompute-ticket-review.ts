import { and, asc, eq, exists, gt, or, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import {
  files,
  requestFiles,
  wasteRequests,
  wasteTicketFiles,
  wasteTickets,
} from '../src/db/schema';
import { recomputeTicketReviewState } from '../src/services/waste-ticket-review-state';

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
 * ЧТО В ОТБОРЕ. Заявки, у которых есть БУМАГА, — тем же тройным условием, каким её видит сверка:
 * талон, строка распознавания либо живой приложенный файл-талон у вывоза мусора. Последнее — не
 * оговорка про типы, а граница ADR 0150 про прошлое: приложенная квитанция прочих типов разбора не
 * ждёт, и прогрев, посчитавший их, вывалил бы в реестр давно закрытые заявки.
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
 * «У заявки есть бумага» — то же условие, что решает, получит ли она значок (Р21). Три ветви, и
 * каждая отвечает за свой способ бумаге появиться: разобранный талон (в том числе заведённый
 * руками), файл, взятый распознаванием, и скан, приложенный при закрытии.
 */
const hasPaper = or(
  exists(
    db
      .select({ one: sql`1` })
      .from(wasteTickets)
      .where(eq(wasteTickets.requestId, wasteRequests.id)),
  ),
  exists(
    db
      .select({ one: sql`1` })
      .from(wasteTicketFiles)
      .where(eq(wasteTicketFiles.requestId, wasteRequests.id)),
  ),
  and(
    eq(wasteRequests.requestType, 'waste_removal'),
    exists(
      db
        .select({ one: sql`1` })
        .from(requestFiles)
        .innerJoin(files, eq(files.id, requestFiles.fileId))
        .where(
          and(
            eq(requestFiles.requestId, wasteRequests.id),
            eq(requestFiles.kind, 'ticket'),
            eq(files.status, 'active'),
          ),
        ),
    ),
  ),
);

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
