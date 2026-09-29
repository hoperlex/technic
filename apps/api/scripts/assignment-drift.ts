import { writeFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { formatVehicleRequestNumber, moscowDateKeyOf } from '@technic/contracts';
import * as schema from '../src/db/schema';
import { readAssignmentMode } from '../src/services/assignment-mode';
import {
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveMaintenanceAccess,
} from './maintenance-access';
import {
  applyDriftRepair,
  listDriftCandidates,
  planDriftRepair,
  type DriftVerdict,
} from './assignment-drift-core';

/**
 * Report and repair history that drifted from the issued ESM-2 paper (ADR 0212, decision 5).
 *
 * The rules live in `assignment-drift-core.ts`; this file is the operator's shell around them:
 * maintenance credentials instead of the application pool (the same rule as every `assignment:*`
 * command, `maintenance-access.ts`), one connection (a second writer would compete with the
 * portal for the same rows), one transaction per request.
 *
 * Usage:
 *
 *   (no flags)          dry run: examines every request and prints what would be written
 *   --apply             write the repairs; requires --actor
 *   --actor=EMAIL|UUID  the portal account the history rows and the audit event are written by
 *   --request=N[,N…]    only these request numbers (the number printed on the request, e.g. 1117)
 *   --reason=TEXT       why — goes into the audit event (default names the command)
 *   --asof=YYYY-MM-DD   the day readiness is recomputed for (default: today, Moscow)
 *   --report=PATH       also write the full report to a file
 *
 * Exit codes: 0 — nothing left for a human; 3 — some requests need a human (listed as
 * «вручную»); 1 — the run failed; 2 — bad arguments.
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm assignment-drift
 *   docker compose … run --rm assignment-drift --apply --actor=<email>
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_MANUAL = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const KNOWN = new Set(['apply', 'actor', 'request', 'reason', 'asof', 'report', 'help']);

class UsageError extends Error {}

type Handle = ReturnType<typeof drizzle<typeof schema>>;

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
    if (!match || !KNOWN.has(match[1]!)) throw new UsageError(`Неизвестный аргумент: ${arg}`);
    flags.set(match[1]!, match[2] ?? 'true');
  }
  return flags;
}

async function resolveActor(db: Handle, raw: string): Promise<{ id: string; label: string }> {
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, fullName: schema.users.fullName })
    .from(schema.users)
    .where(UUID_RE.test(raw) ? eq(schema.users.id, raw) : eq(schema.users.email, raw))
    .limit(2);
  if (rows.length === 0) throw new UsageError(`Исполнитель не найден: --actor=${raw}`);
  if (rows.length > 1) throw new Error(`По --actor=${raw} нашлось несколько учёток`);
  return { id: rows[0]!.id, label: `${rows[0]!.fullName} <${rows[0]!.email}>` };
}

const REASON_WORDS: Record<'paper_follows_stale_tail' | 'unresolvable' | 'no_paper', string> = {
  paper_follows_stale_tail:
    'история и листы сходятся, но оба ведут не ту машину, что назначена, до конца срока — лист уже перевыписан на прежнюю машину',
  unresolvable: 'история противоречит листу посреди его дней — по границам листов не сводится',
  no_paper: 'у заказа нет ни одного действующего листа — сверять историю не с чем',
};

function describe(num: number, verdict: DriftVerdict, applied: boolean): string {
  const head = formatVehicleRequestNumber(num);
  if (verdict.kind === 'clean') return `${head}: сходится`;
  if (verdict.kind === 'manual') {
    return (
      `${head}: ВРУЧНУЮ — ${REASON_WORDS[verdict.reason]}` +
      (verdict.sheets.length > 0
        ? `; расходятся листы с ${verdict.sheets.map((s) => s.from).join(', ')}`
        : '')
    );
  }
  const points = verdict.points
    .map(
      (p) =>
        `${p.date}: машина ${p.vehicleId.slice(0, 8)}${p.driver ? `, машинист ${p.driver.state === 'set' ? p.driver.personId.slice(0, 8) : p.driver.state}` : ''}`,
    )
    .join('; ');
  return `${head}: ${applied ? 'ПОЧИНЕНО' : 'будет починено'} с ${verdict.boundary} — ${points}`;
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    process.stdout.write(
      'assignment:drift — сверка истории назначения с выданными листами ЭСМ-2 и починка (ADR 0212)\n' +
        '  без флагов — отчёт, ничего не пишется; --apply --actor=<email> — запись\n' +
        '  --request=1117,1120  только эти заказы   --reason=ТЕКСТ   --asof=ГГГГ-ММ-ДД   --report=ПУТЬ\n',
    );
    return 0;
  }
  const apply = flags.has('apply');
  const asOf = flags.get('asof') ?? moscowDateKeyOf(new Date());
  if (!DATE_RE.test(asOf)) throw new UsageError(`--asof ждёт дату ГГГГ-ММ-ДД, пришло «${asOf}»`);
  const nums = (flags.get('request') ?? '')
    .split(',')
    .map((part) => part.trim().replace(/^ТС-/u, ''))
    .filter(Boolean)
    .map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0)
        throw new UsageError(`--request ждёт номера заказов, пришло «${part}»`);
      return n;
    });
  if (apply && !flags.get('actor')) throw new UsageError('--apply требует --actor=<email>');
  const reason =
    flags.get('reason')?.trim() || 'Починка истории назначения по выданным листам (ADR 0212)';

  const access = resolveMaintenanceAccess();
  // One connection: a second writer of this command would compete with the portal for the same rows.
  const pool = buildMaintenancePool(access, 1);
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  try {
    const identity = await readMaintenanceIdentity(pool);
    const [dbRow] = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows;
    const mode = await readAssignmentMode(db);
    const actor = apply ? await resolveActor(db, flags.get('actor')!) : null;
    const lines: string[] = [
      `Сверка истории назначения с листами ЭСМ-2 — ${apply ? 'ЗАПИСЬ' : 'отчёт (ничего не пишется)'}`,
      `База: ${dbRow?.db ?? '?'}, доступ ${maintenanceAccessLine(access, identity)}`,
      `Режим модуля: запись ${mode.writeMode}, чтение ${mode.readMode}; готовность на ${asOf}`,
      ...(actor ? [`Исполнитель: ${actor.label}`] : []),
      '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    const candidates = await listDriftCandidates(db, { nums });
    const counts = { clean: 0, repair: 0, manual: 0, failed: 0 };
    for (const request of candidates) {
      let line: string;
      try {
        const verdict = actor
          ? await applyDriftRepair(db, {
              requestId: request.id,
              asOf,
              actorUserId: actor.id,
              reason,
            })
          : await db.transaction(async (tx) => {
              // The report never writes: the database refuses, not the discipline of this file.
              await tx.execute(sql`SET TRANSACTION READ ONLY`);
              return planDriftRepair(tx, request.id);
            });
        counts[verdict.kind] += 1;
        if (verdict.kind === 'clean') continue;
        line = describe(request.num, verdict, apply);
      } catch (error) {
        counts.failed += 1;
        line = `${formatVehicleRequestNumber(request.num)}: ОШИБКА — ${(error as Error).message}`;
      }
      lines.push(line);
      process.stdout.write(`${line}\n`);
    }
    const summary =
      `\nПроверено заказов: ${candidates.length}; сходится: ${counts.clean}; ` +
      `${apply ? 'починено' : 'к починке'}: ${counts.repair}; вручную: ${counts.manual}; ошибок: ${counts.failed}\n`;
    lines.push(summary);
    process.stdout.write(summary);
    const reportPath = flags.get('report');
    if (reportPath) writeFileSync(reportPath, `${lines.join('\n')}\n`);
    if (counts.failed > 0) return EXIT_FAILURE;
    return counts.manual > 0 ? EXIT_MANUAL : 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT_FAILURE;
  });
