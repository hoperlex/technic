import type { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type * as schema from '../src/db/schema';
import {
  computeAssignmentHistory,
  ensureAssignmentHistory,
  readAssignmentHistorySnapshot,
} from '../src/services/assignment-ensure';
import { ASSIGNMENT_READINESS_POPULATION } from '../src/services/assignment-readiness';
import type { AssignmentHistoryUnrestorable } from '../src/services/assignment-ensure';

/**
 * Ядро прогонов по истории назначения: кого брать в работу и что с ним делать.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Обход популяции нужен двум командам, и работа у них одна и та же.
 * Массовый прогон (`assignment-backfill.ts`) достраивает пустую историю и ведёт возобновляемый
 * отчёт; окно переключения (`assignment-cutover.ts`) делает ревалидацию — пересчёт валидности
 * непустой истории под единым днём, — и ни отчёта, ни файла состояния ему не нужно. Разными
 * остаются оболочки, общими обязаны быть три вещи: **кого** брать (предикат выборки), **что**
 * делать с заявкой (одна транзакция на заявку) и **когда повторять** (конфликт сериализации).
 *
 * Разойдись эти три — и «ревалидация прошла» у окна означало бы не то же, что у прогона, а дверь
 * активации сверяет `validated_on` у **всех** заявок популяции: расхождение выяснилось бы отказом
 * двери в самом окне, когда портал уже заморожен.
 *
 * ПРАВИЛ ВОССТАНОВЛЕНИЯ ЗДЕСЬ НЕТ. Модуль зовёт ту же дверь, что и портал
 * (`ensureAssignmentHistory`), и не знает ни одного правила §6 плана `docs/assignment-periods-plan.md`.
 */

type Handle = ReturnType<typeof drizzle<typeof schema>>;

/** Что делает прогон: достраивает пустую историю либо пересчитывает валидность непустой. */
export type HistoryRunWork = 'backfill' | 'revalidate';

/** Исход по одной заявке — общий для записи и для dry-run, чтобы отчёт не различал их формой. */
export interface HistoryRunOutcome {
  state: 'empty' | 'materialized' | 'ready';
  unrestorable: readonly AssignmentHistoryUnrestorable[];
  blockers: readonly { date: string; kind: 'unknown' | 'cleared' }[];
  warnings: readonly { historyVehicleId: string; assignmentVehicleId: string }[];
  /** Строк истории: записанных (`ensure`) либо тех, что были бы записаны (`plan`). */
  written: number;
}

/**
 * Предикат готовности Р20 с расширением Р28 — из общего модуля, а не своей копией.
 *
 * Им же считают готовность сводка (`assignment-readiness.ts`), дверь активации и метрики.
 * Псевдонимы фиксированы его контрактом: `r` — `vehicle_requests`, `d` — детали спецтехники.
 */
const POPULATION = ASSIGNMENT_READINESS_POPULATION;

/**
 * Область работы прогона — половина, различающая две работы.
 *
 * **Бэкфилл** берёт только `empty`, и это запрет пересборки (Д3): заявка, у которой история уже
 * появилась (в том числе отменённая человеком до пустоты, но оставшаяся `materialized`), в выборку
 * не попадает никогда.
 *
 * **Ревалидация** берёт обратное: непустую историю, чьё состояние считалось не на сегодняшний
 * `asOf` либо помечено `dirty`. Пересборки нет и здесь — путь тот же, `ensureAssignmentHistory`, а
 * он на непустой истории строк не добавляет (Р26): пересчитывает состояние и снимает метку.
 */
export function historyRunScope(work: HistoryRunWork, asOf: string) {
  return work === 'backfill'
    ? sql`r.assignment_history_state = 'empty'`
    : sql`r.assignment_history_state <> 'empty'
          AND (r.assignment_history_validated_on IS DISTINCT FROM ${asOf}::date
               OR r.assignment_history_dirty)`;
}

/**
 * Очередная страница заявок к обработке.
 *
 * Порядок по `id` — он же курсор возобновления: устойчив к любым правкам данных, в отличие от
 * порядка по номеру или по дате.
 */
export async function nextHistoryPage(
  db: Handle,
  params: { after: string | null; limit: number; work: HistoryRunWork; asOf: string },
): Promise<{ id: string; num: number }[]> {
  const rows = await db.execute<{ id: string; num: number }>(sql`
    SELECT r.id, r.num
      FROM vehicle_requests r
      JOIN special_equipment_request_details d ON d.request_id = r.id
     WHERE ${POPULATION}
       AND ${historyRunScope(params.work, params.asOf)}
       ${params.after === null ? sql`` : sql`AND r.id > ${params.after}::uuid`}
     ORDER BY r.id
     LIMIT ${params.limit}`);
  return [...rows.rows];
}

/**
 * Dry-run одной заявки: расчёт без единой записи, и это свойство держит **база**, а не дисциплина.
 *
 * Транзакция объявляется `READ ONLY` первым же запросом, поэтому случайная запись здесь упадёт
 * отказом PostgreSQL, а не уедет в базу. Строку заявки dry-run намеренно не блокирует: писать ему
 * нечего, а `FOR UPDATE` посреди рабочего дня останавливал бы диспетчеров ради замера.
 */
export async function planOneRequest(
  db: Handle,
  requestId: string,
  asOf: string,
): Promise<HistoryRunOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const snapshot = await readAssignmentHistorySnapshot(tx, requestId);
    const computed = computeAssignmentHistory(snapshot, asOf);
    return {
      state: computed.state,
      unrestorable: computed.unrestorable,
      blockers: computed.blockers,
      warnings: computed.warnings,
      written: computed.mutations.length,
    };
  });
}

/**
 * Запись истории одной заявки — одна транзакция на заявку.
 *
 * Единица именно заявка: история заявки атомарна (пара строк одной группы гаснет вместе, Г2), а
 * пакет из сотни заявок в одной транзакции держал бы сотню блокировок строк и рушился бы целиком
 * из-за одной. Порядок захвата канонический — строка заявки первой операцией (этап 2a, подтверждено
 * спайком §4.3): при конфликте отказ приходит на первом же запросе, и выброшенной работы ноль.
 * Блокировка берётся здесь своим запросом, а не через `lockRequestRow`: тот живёт в
 * `services/vehicle-routes.ts`, который импортирует прикладной пул, — а прогон обязан работать без
 * портального окружения (Ю23).
 */
export async function ensureOneRequest(
  db: Handle,
  requestId: string,
  asOf: string,
): Promise<HistoryRunOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM vehicle_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const ensured = await ensureAssignmentHistory(tx, { requestId, asOf });
    if (ensured.state === 'empty') {
      return {
        state: 'empty' as const,
        unrestorable: ensured.unrestorable,
        blockers: [],
        warnings: [],
        written: 0,
      };
    }
    return {
      state: ensured.state,
      unrestorable: [],
      blockers: ensured.blockers,
      warnings: ensured.warnings,
      written: ensured.materialized.length,
    };
  });
}

/** Сколько раз повторять конфликт сериализации, прежде чем считать его отказом по существу. */
const RETRY_LIMIT = 3;

/** Конфликт сериализации или разорванный клинч: повторяется, всё остальное — отказ по существу. */
export function isRetryableDbError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === '40001' || code === '40P01';
}

export async function withHistoryRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_LIMIT || !isRetryableDbError(error)) throw error;
    }
  }
}
