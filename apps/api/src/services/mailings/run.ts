import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  mailingRuns,
  mailingScheduleExcludedDates,
  mailingScheduleExcludedPersons,
  mailingSchedules,
} from '../../db/schema';
import { config } from '../../config';
import { queueMail } from '../mail';
import { buildDriverRoutesMail, driversWithRoutes } from './driver-routes';
import { nextRunAt, routeWindowOf, type SchedulePlan } from './schedule';

/**
 * Запуск рассылки (ADR 0075): от «наступило время» до «письма в очереди».
 *
 * Создание запуска и его выполнение разделены намеренно. Создаёт запуск планировщик — коротко и в
 * транзакции, где уникальность `(schedule_id, planned_at)` не даёт двум worker'ам развести двойную
 * рассылку. Выполняет его API — там, где живут права, область видимости и сборка письма; worker
 * только просит выполнить.
 *
 * Отсюда же безопасность повтора: письма дедуплицируются по `(kind, dedupe_key)`, а ключ включает
 * идентификатор запуска — второй заход по тому же запуску не создаст ни одного нового письма.
 */

export interface RunStats {
  /** Сколько писем составлено этим запуском. */
  sent: number;
  /** Водители с рейсами, но без адреса: им письмо не создаётся, и это надо видеть. */
  withoutEmail: number;
  /** Исключённые администратором получатели. */
  excluded: number;
  /** У кого после вычета исключённых дат не осталось ни одного рейса. */
  empty: number;
}

/** План расписания для расчёта следующего запуска: собирается из строки и её исключений. */
async function planOf(scheduleId: string, row: typeof mailingSchedules.$inferSelect) {
  const excluded = await db
    .select({
      kind: mailingScheduleExcludedDates.kind,
      on: mailingScheduleExcludedDates.excludedOn,
    })
    .from(mailingScheduleExcludedDates)
    .where(eq(mailingScheduleExcludedDates.scheduleId, scheduleId));
  const plan: SchedulePlan = {
    periodicity: row.periodicity,
    sendAt: row.sendAt,
    weekday: row.weekday,
    runWeekdays: row.runWeekdays,
    excludedDates: excluded.filter((e) => e.kind === 'run').map((e) => e.on),
  };
  return {
    plan,
    excludedRouteDates: excluded.filter((e) => e.kind === 'route').map((e) => e.on),
  };
}

/**
 * Заводит запуск расписания на назначенное время. `null` — такой запуск уже есть: значит его
 * успел создать другой экземпляр worker, и делать ничего не надо.
 *
 * Здесь же пересчитывается `next_run_at`: сначала следующее время, потом запуск — если процесс
 * упадёт между ними, расписание проснётся снова и повторит попытку, а уникальный индекс не даст
 * создать второй запуск на то же время.
 */
export async function createRun(input: {
  scheduleId: string;
  plannedAt: Date;
  isManual?: boolean;
}): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mailingSchedules)
      .where(eq(mailingSchedules.id, input.scheduleId));
    if (!row) return null;

    const { plan } = await planOf(input.scheduleId, row);
    // У ручного запуска расписание не сдвигается: «Запустить сейчас» — это разовая рассылка, а не
    // перенос вечерней отправки.
    if (!input.isManual) {
      const next = nextRunAt(plan, input.plannedAt, config.mail.timezone);
      await tx
        .update(mailingSchedules)
        .set({ nextRunAt: next, updatedAt: new Date() })
        .where(eq(mailingSchedules.id, input.scheduleId));
    }

    const [run] = await tx
      .insert(mailingRuns)
      .values({
        scheduleId: input.scheduleId,
        plannedAt: input.plannedAt,
        isManual: input.isManual ?? false,
      })
      .onConflictDoNothing({ target: [mailingRuns.scheduleId, mailingRuns.plannedAt] })
      .returning({ id: mailingRuns.id });
    return run?.id ?? null;
  });
}

/**
 * Выполняет запуск: собирает получателей, ставит письма, записывает итоги.
 *
 * Повторный вызов по тому же запуску безопасен и почти бесплатен: письма уже составлены, и
 * дедупликация вернёт `null` на каждое из них.
 */
export async function performRun(runId: string): Promise<RunStats> {
  const [run] = await db.select().from(mailingRuns).where(eq(mailingRuns.id, runId));
  if (!run) throw new Error(`Запуск рассылки ${runId} не найден`);

  const [schedule] = await db
    .select()
    .from(mailingSchedules)
    .where(eq(mailingSchedules.id, run.scheduleId));
  if (!schedule) throw new Error(`Расписание запуска ${runId} удалено`);

  await db
    .update(mailingRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(mailingRuns.id, runId));

  try {
    const { excludedRouteDates } = await planOf(schedule.id, schedule);
    const stats =
      schedule.type === 'driver_routes'
        ? await runDriverRoutes({ run, schedule, excludedRouteDates })
        : // Ролевые дайджесты приедут своим этапом; до тех пор такой запуск честно помечается
          // пропущенным, а не изображает выполненный.
          null;

    await db
      .update(mailingRuns)
      .set({
        status: stats ? 'done' : 'skipped',
        finishedAt: new Date(),
        stats: stats ?? { reason: 'Вид рассылки пока не поддерживается' },
      })
      .where(eq(mailingRuns.id, runId));
    return stats ?? { sent: 0, withoutEmail: 0, excluded: 0, empty: 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(mailingRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: message })
      .where(eq(mailingRuns.id, runId));
    throw e;
  }
}

async function runDriverRoutes(input: {
  run: typeof mailingRuns.$inferSelect;
  schedule: typeof mailingSchedules.$inferSelect;
  excludedRouteDates: string[];
}): Promise<RunStats> {
  const { run, schedule } = input;
  const window = routeWindowOf(
    run.plannedAt,
    schedule.windowFromDays ?? 1,
    schedule.windowToDays ?? 1,
    config.mail.timezone,
  );
  // Границы данных записываются в запуск: повтор упавшей вечерней рассылки обязан взять те же дни,
  // а не пересчитать окно от утра следующего.
  await db
    .update(mailingRuns)
    .set({ periodStart: window.from, periodEnd: window.to })
    .where(eq(mailingRuns.id, run.id));

  const excludedPersons = new Set(
    (
      await db
        .select({ personId: mailingScheduleExcludedPersons.personId })
        .from(mailingScheduleExcludedPersons)
        .where(eq(mailingScheduleExcludedPersons.scheduleId, schedule.id))
    ).map((r) => r.personId),
  );

  const drivers = await driversWithRoutes(window.from, window.to);
  const stats: RunStats = { sent: 0, withoutEmail: 0, excluded: 0, empty: 0 };

  for (const driver of drivers) {
    if (excludedPersons.has(driver.personId)) {
      stats.excluded += 1;
      continue;
    }
    // Водитель без адреса — не ошибка рассылки, а пробел в справочнике: его считают, чтобы
    // администратор увидел, кому задание не уходит, и завёл адрес.
    if (!driver.email) {
      stats.withoutEmail += 1;
      continue;
    }

    const mail = await buildDriverRoutesMail({
      personId: driver.personId,
      driverName: driver.fullName,
      dateFrom: window.from,
      dateTo: window.to,
      excludedRouteDates: input.excludedRouteDates,
    });
    if (!mail) {
      stats.empty += 1;
      continue;
    }

    await queueMail({
      kind: 'driver_routes',
      // Ключ включает запуск и получателя: повтор запуска не создаст второго письма тому же
      // человеку, а завтрашняя рассылка — создаст, потому что запуск будет другой.
      dedupeKey: `driver-routes:${run.id}:${driver.personId}`,
      to: driver.email,
      subject: mail.subject,
      content: mail.content,
      personId: driver.personId,
      mailingRunId: run.id,
    });
    stats.sent += 1;
  }

  return stats;
}

/** Расписания, чьё время наступило: их забирает планировщик. */
export async function dueSchedules(now: Date): Promise<{ id: string; plannedAt: Date }[]> {
  const rows = await db
    .select({ id: mailingSchedules.id, nextRunAt: mailingSchedules.nextRunAt })
    .from(mailingSchedules)
    .where(
      and(
        eq(mailingSchedules.isEnabled, true),
        sql`${mailingSchedules.nextRunAt} IS NOT NULL AND ${mailingSchedules.nextRunAt} <= ${now}`,
      ),
    );
  return rows.map((r) => ({ id: r.id, plannedAt: r.nextRunAt! }));
}

/** Проставляет `next_run_at` расписаниям, у которых его нет: после включения и после правки. */
export async function refreshNextRun(scheduleIds: string[]): Promise<void> {
  if (scheduleIds.length === 0) return;
  const rows = await db
    .select()
    .from(mailingSchedules)
    .where(inArray(mailingSchedules.id, scheduleIds));
  for (const row of rows) {
    const { plan } = await planOf(row.id, row);
    const next = row.isEnabled ? nextRunAt(plan, new Date(), config.mail.timezone) : null;
    await db
      .update(mailingSchedules)
      .set({ nextRunAt: next })
      .where(eq(mailingSchedules.id, row.id));
  }
}
