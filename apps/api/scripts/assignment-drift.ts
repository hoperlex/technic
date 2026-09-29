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
  type DriftManualReason,
  type DriftRepairPlan,
  type DriftVerdict,
} from './assignment-drift-core';
import {
  applyTraceHeal,
  DRIFT_FIXES,
  inspectTraces,
  listTraceCandidates,
  traceHealPlanOf,
  traceKindsOf,
  type DriftFix,
  type RequestTraces,
  type TraceHealPlan,
  type TraceKind,
  type TraceSheet,
} from './assignment-drift-traces';

/**
 * Report and repair history that drifted from the issued ESM-2 paper (ADR 0212, decision 5), and
 * the traces the defective repair door left (ADR 0212, amendment of 29.09.2026).
 *
 * The rules live in `assignment-drift-core.ts` and `assignment-drift-traces.ts`; this file is the
 * operator's shell around them: maintenance credentials instead of the application pool (the same
 * rule as every `assignment:*` command, `maintenance-access.ts`), one connection (a second writer
 * would compete with the portal for the same rows), one transaction per request.
 *
 * Usage:
 *
 *   (no flags)          dry run: every request, every trace, what each fix would write
 *   --apply             write; requires --actor; what is written is named by --fix
 *   --fix=LIST          what --apply writes, comma-separated (default: drift):
 *                         drift       history follows the issued paper (ADR 0212, decision 5)
 *                         leak        a leaked known fill gets its `unknown` boundary back and the
 *                                     blanks it printed for the leaked days are cancelled
 *                         fill-paper  active blanks of a cancelled known fill are cancelled
 *                         all         all three
 *   --actor=EMAIL|UUID  the portal account the rows, the journal operation and the audit event are
 *                       written by
 *   --request=N[,N…]    only these request numbers (the number printed on the request, e.g. 1117)
 *   --reason=TEXT       why — goes into the audit event and the journal (default names the command)
 *   --asof=YYYY-MM-DD   the day readiness and cancellability are judged on (default: today, Moscow)
 *   --report=PATH       also write the full report to a file
 *
 * A request carrying any trace never gets the drift repair in the same run — the cure first, a
 * human look, then the next run (the user's decision of 29.09.2026).
 *
 * Exit codes: 0 — nothing left for a human; 3 — some items need a human (listed as «ВРУЧНУЮ»,
 * orphans, archived repairs, blanks a repair printed in passing); 1 — the run failed; 2 — bad
 * arguments.
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm assignment-drift
 *   docker compose … run --rm assignment-drift --apply --fix=leak,fill-paper --actor=<email>
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_MANUAL = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const KNOWN = new Set(['apply', 'actor', 'request', 'reason', 'asof', 'report', 'fix', 'help']);

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

function parseFixes(raw: string | undefined): Set<DriftFix> {
  if (raw === undefined) return new Set<DriftFix>(['drift']);
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0)
    throw new UsageError('--fix ждёт перечень: drift, leak, fill-paper или all');
  const fixes = new Set<DriftFix>();
  for (const part of parts) {
    if (part === 'all') DRIFT_FIXES.forEach((fix) => fixes.add(fix));
    else if ((DRIFT_FIXES as readonly string[]).includes(part)) fixes.add(part as DriftFix);
    else
      throw new UsageError(`--fix: неизвестное лечение «${part}» (drift, leak, fill-paper, all)`);
  }
  return fixes;
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

// ── Words ──

const REASON_WORDS: Record<DriftManualReason, string> = {
  paper_follows_stale_tail:
    'история и листы сходятся, но оба ведут не ту машину, что назначена, до конца срока — лист уже перевыписан на прежнюю машину',
  unresolvable: 'история противоречит листу посреди его дней — по границам листов не сводится',
  no_paper: 'у заказа нет ни одного действующего листа — сверять историю не с чем',
  trace_first: 'сначала лечение следа двери ремонта',
  archived: 'заявка в архиве — решается вместе с восстановлением',
};

const TRACE_LETTER: Record<TraceKind, string> = {
  leak: 'В',
  cancelled_fill: 'А',
  orphan: 'Б',
  archived_repair: 'Г',
  incidental_sheet: 'Д',
};

const short = (id: string | null): string => (id ? id.slice(0, 8) : '—');
const sheetLine = (sheet: TraceSheet): string =>
  `${sheet.number} (${sheet.from}…${sheet.to}, машинист ${short(sheet.driverPersonId)})`;

function pointsLine(plan: DriftRepairPlan): string {
  return plan.points
    .map(
      (p) =>
        `${p.date}: машина ${p.vehicleId.slice(0, 8)}${p.driver ? `, машинист ${p.driver.state === 'set' ? p.driver.personId.slice(0, 8) : p.driver.state}` : ''}`,
    )
    .join('; ');
}

function describeDrift(num: number, verdict: DriftVerdict, applied: boolean): string {
  const head = formatVehicleRequestNumber(num);
  if (verdict.kind === 'clean') return `${head}: сходится`;
  if (verdict.kind === 'manual') {
    if (verdict.withheld) {
      const letters = (verdict.traces ?? []).map((kind) => TRACE_LETTER[kind]).join(', ');
      return (
        `${head}: ВРУЧНУЮ — ${REASON_WORDS[verdict.reason]}${letters ? ` (${letters})` : ''}; ` +
        `починка с ${verdict.withheld.boundary} не пишется — ${pointsLine(verdict.withheld)}`
      );
    }
    return (
      `${head}: ВРУЧНУЮ — ${REASON_WORDS[verdict.reason]}` +
      (verdict.sheets.length > 0
        ? `; расходятся листы с ${verdict.sheets.map((s) => s.from).join(', ')}`
        : '')
    );
  }
  return `${head}: ${applied ? 'ПОЧИНЕНО' : 'будет починено'} с ${verdict.boundary} — ${pointsLine(verdict)}`;
}

/** Lines of the trace sections, and how many items in them need a human. */
interface TraceSections {
  leak: string[];
  cancelled_fill: string[];
  orphan: string[];
  archived_repair: string[];
  incidental_sheet: string[];
  manual: number;
  curable: number;
  healed: number;
}

function addTraceLines(
  out: TraceSections,
  traces: RequestTraces,
  plan: TraceHealPlan | null,
  /** The fixes of a writing run; `null` — a report, where nothing is "not selected". */
  applied: ReadonlySet<DriftFix> | null,
): void {
  const skipped = (fix: DriftFix): string =>
    applied && !applied.has(fix) ? ' (не выбрано в --fix)' : '';
  const head = formatVehicleRequestNumber(traces.num);
  const cancelled = new Set(plan?.cancels.map((sheet) => sheet.id) ?? []);
  const healedLeak = new Set(
    plan?.remainders.map((item) => `${item.changeGroupId}:${item.date}`) ?? [],
  );

  for (const leak of traces.leaks) {
    const op = leak.operation;
    const lines = [
      `  ${head}: заполнение ${leak.fill.from}…${leak.fill.to} машинистом ${short(leak.fill.personId)} ` +
        `(операция ${short(op.operationId)} от ${op.day}, чтение ${op.readMode}` +
        (leak.stateBefore ? `, готовность ${leak.stateBefore} → ${leak.stateAfter}` : '') +
        `): человек тянется с ${leak.day} по ${leak.through}` +
        (leak.forward.length > 0
          ? `; бланки вперёд: ${leak.forward.map(sheetLine).join(', ')}`
          : '; бланков вперёд нет') +
        (leak.others.length > 0
          ? `; другие листы на этих днях (решит якорь): ${leak.others.map((s) => s.number).join(', ')}`
          : ''),
    ];
    if (leak.manual.length > 0) {
      out.manual += 1;
      lines.push(`      → ВРУЧНУЮ: ${leak.manual.join('; ')}`);
    } else if (healedLeak.has(`${leak.changeGroupId}:${leak.day}`)) {
      out.healed += 1;
      lines.push(
        `      → ВЫЛЕЧЕНО: граница «не знаем» на ${leak.day}` +
          (leak.forward.length > 0
            ? `, аннулированы ${leak.forward.map((s) => s.number).join(', ')}`
            : '') +
          '; заявка ждёт якоря',
      );
    } else {
      out.curable += 1;
      lines.push(
        `      → лечится --fix=leak: граница «не знаем» на ${leak.day}` +
          (leak.forward.length > 0
            ? `, аннулировать через журнал коррекций ${leak.forward.map((s) => s.number).join(', ')}`
            : '') +
          skipped('leak'),
      );
    }
    out.leak.push(...lines);
  }

  for (const trace of traces.cancelledFills) {
    if (trace.sheets.length === 0) continue;
    const op = trace.operation;
    out.cancelled_fill.push(
      `  ${head}: заполнение ${trace.fill.from}…${trace.fill.to} машинистом ${short(trace.fill.personId)} ` +
        `отменено, его бланки живы (операция ${short(op.operationId)} от ${op.day}):`,
    );
    for (const item of trace.sheets) {
      if (item.manual) {
        out.manual += 1;
        out.cancelled_fill.push(`      ${sheetLine(item.sheet)} → ВРУЧНУЮ: ${item.manual}`);
      } else if (cancelled.has(item.sheet.id)) {
        out.healed += 1;
        out.cancelled_fill.push(`      ${sheetLine(item.sheet)} → ВЫЛЕЧЕНО: аннулирован`);
      } else {
        out.curable += 1;
        out.cancelled_fill.push(
          `      ${sheetLine(item.sheet)} → лечится --fix=fill-paper: аннулировать через журнал коррекций` +
            skipped('fill-paper'),
        );
      }
    }
  }

  for (const orphan of traces.orphans) {
    out.manual += 1;
    const op = orphan.operation;
    const days = orphan.uncovered
      .map(
        (range) =>
          `${range.from}…${range.to} (${range.locked ? 'прошлое — заполнить дверью ремонта' : 'впереди — назначить машиниста'})`,
      )
      .join(', ');
    out.orphan.push(
      `  ${head}: ${sheetLine(orphan.sheet)} ${orphan.how === 'burned' ? 'сожжён' : 'укорочен'} ` +
        `операцией ${short(op.operationId)} от ${op.day}; без бланка: ${days}` +
        (orphan.sheet.driverPersonId
          ? ` → вернуть дням человека сожжённого листа (${short(orphan.sheet.driverPersonId)}), если он и работал`
          : ''),
    );
  }

  for (const repair of traces.archivedRepairs) {
    out.manual += 1;
    const op = repair.operation;
    const parts = [
      repair.issued.length > 0 ? `выписаны ${repair.issued.map(sheetLine).join(', ')}` : '',
      repair.burned.length > 0 ? `сожжены ${repair.burned.map(sheetLine).join(', ')}` : '',
      repair.trimmed.length > 0 ? `укорочены ${repair.trimmed.map(sheetLine).join(', ')}` : '',
    ].filter(Boolean);
    out.archived_repair.push(
      `  ${head}: операция ${short(op.operationId)} от ${op.day} без восстановления: ${parts.join('; ')} ` +
        '→ решить вручную: восстановить заявку и сверить бумагу либо аннулировать выписанное',
    );
  }

  for (const item of traces.incidentalSheets) {
    out.manual += 1;
    const op = item.operation;
    const days = item.outside.map((range) => `${range.from}…${range.to}`).join(', ');
    out.incidental_sheet.push(
      `  ${head}: ${sheetLine(item.sheet)} выписан операцией ремонта ${short(op.operationId)} ` +
        `от ${op.day} на дни вне её команды: ${days} → бланк выписан попутно, команда эти дни не ` +
        'меняла; оставить или аннулировать — решает пользователь',
    );
  }
}

async function readOnly<T>(
  db: Handle,
  work: (tx: Parameters<Parameters<Handle['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // The report never writes: the database refuses, not the discipline of this file.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return work(tx);
  });
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    process.stdout.write(
      'assignment:drift — сверка истории назначения с листами ЭСМ-2 и следы двери ремонта (ADR 0212)\n' +
        '  без флагов — отчёт, ничего не пишется; --apply --actor=<email> — запись\n' +
        '  --fix=drift,leak,fill-paper|all  что пишет --apply (по умолчанию drift)\n' +
        '  --request=1117,1120  только эти заказы   --reason=ТЕКСТ   --asof=ГГГГ-ММ-ДД   --report=ПУТЬ\n',
    );
    return 0;
  }
  const apply = flags.has('apply');
  const fixes = parseFixes(flags.get('fix'));
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
  const given = flags.get('reason')?.trim();
  const reason = given || 'Починка истории назначения по выданным листам (ADR 0212)';
  // The cure's reason lands in `cancel_reason` of every blank it burns: it must say why the number
  // was burned, not repeat the drift repair's words.
  const healReason = given || 'Лечение следа двери ремонта истории назначения (ADR 0212)';
  const heal = apply && (fixes.has('leak') || fixes.has('fill-paper'));

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
      `Сверка истории назначения с листами ЭСМ-2 — ${apply ? `ЗАПИСЬ (--fix=${[...fixes].join(',')})` : 'отчёт (ничего не пишется)'}`,
      `База: ${dbRow?.db ?? '?'}, доступ ${maintenanceAccessLine(access, identity)}`,
      `Режим модуля: запись ${mode.writeMode}, чтение ${mode.readMode}; готовность и отменяемость на ${asOf}`,
      ...(actor ? [`Исполнитель: ${actor.label}`] : []),
      '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    const drift = await listDriftCandidates(db, { nums });
    const traced = await listTraceCandidates(db, { nums });
    const requests = new Map<string, { num: number; drift: boolean }>();
    for (const request of traced) requests.set(request.id, { num: request.num, drift: false });
    for (const request of drift) requests.set(request.id, { num: request.num, drift: true });
    const ordered = [...requests.entries()].sort((a, b) => a[1].num - b[1].num);

    const sections: TraceSections = {
      leak: [],
      cancelled_fill: [],
      orphan: [],
      archived_repair: [],
      incidental_sheet: [],
      manual: 0,
      curable: 0,
      healed: 0,
    };
    const driftLines: string[] = [];
    const counts = { clean: 0, repair: 0, manual: 0, failed: 0 };
    let tracedRequests = 0;

    for (const [id, request] of ordered) {
      try {
        let before = await readOnly(db, (tx) => inspectTraces(tx, id, asOf));
        let plan: TraceHealPlan | null = null;
        // The writing transaction (door gate, row lock) is opened only where the report found a
        // cure; the cure itself is recomputed under the lock, never taken from this read.
        const curable = traceHealPlanOf(before, fixes);
        if (heal && (curable.remainders.length > 0 || curable.cancels.length > 0)) {
          const outcome = await applyTraceHeal(db, {
            requestId: id,
            asOf,
            actorUserId: actor!.id,
            reason: healReason,
            fixes,
          });
          before = outcome.before;
          plan = outcome.plan;
        }
        const kinds = traceKindsOf(before);
        if (kinds.length > 0) {
          tracedRequests += 1;
          addTraceLines(sections, before, plan, apply ? fixes : null);
        }
        if (!request.drift) continue;

        let verdict: DriftVerdict;
        if (actor && fixes.has('drift') && kinds.length === 0) {
          verdict = await applyDriftRepair(db, {
            requestId: id,
            asOf,
            actorUserId: actor.id,
            reason,
          });
        } else {
          verdict = await readOnly(db, (tx) => planDriftRepair(tx, id, { asOf }));
          // A request that had traces when this run began waits for the next run even when the
          // cure has just removed them: the cure changes paper, and a human looks first.
          if (verdict.kind === 'repair' && kinds.length > 0) {
            const { kind: _repair, ...withheld } = verdict;
            verdict = {
              kind: 'manual',
              reason: 'trace_first',
              sheets: verdict.sheets,
              historyTailVehicleId: null,
              assignmentVehicleId: null,
              withheld,
              traces: kinds,
            };
          }
        }
        counts[verdict.kind] += 1;
        if (verdict.kind === 'clean') continue;
        driftLines.push(
          describeDrift(
            request.num,
            verdict,
            apply && fixes.has('drift') && verdict.kind === 'repair',
          ),
        );
      } catch (error) {
        counts.failed += 1;
        driftLines.push(
          `${formatVehicleRequestNumber(request.num)}: ОШИБКА — ${(error as Error).message}`,
        );
      }
    }

    const body: string[] = ['Следы двери ремонта (ADR 0212, поправка 29.09.2026)'];
    const section = (title: string, rows: string[]): void => {
      body.push(`${title}${rows.length === 0 ? ': нет' : ':'}`, ...rows);
    };
    section('В. Протекание заполнения за последний запертый день (Д3)', sections.leak);
    section('А. Действующие бланки отменённого заполнения (Д4)', sections.cancelled_fill);
    section('Б. Листы, сожжённые заполнением без замены (Д5) — только отчёт', sections.orphan);
    section(
      'Г. Ремонт архивной заявки без восстановления (Д2) — только отчёт',
      sections.archived_repair,
    );
    section(
      'Д. Бланки, выписанные ремонтом попутно, на дни вне его команды — только отчёт',
      sections.incidental_sheet,
    );
    body.push('', 'Сверка истории с листами (ADR 0212, решение 5)');
    body.push(
      ...(driftLines.length > 0 ? driftLines.map((line) => `  ${line}`) : ['  расхождений нет']),
    );
    const summary =
      `\nЗаказов со следами: ${tracedRequests}; ${apply ? 'вылечено' : 'к лечению'}: ` +
      `${apply ? sections.healed : sections.curable}` +
      (apply && sections.curable > 0 ? ` (не выбрано: ${sections.curable})` : '') +
      `; вручную: ${sections.manual}\n` +
      `Сверка: проверено заказов ${drift.length}; сходится: ${counts.clean}; ` +
      `${apply && fixes.has('drift') ? 'починено' : 'к починке'}: ${counts.repair}; вручную: ${counts.manual}; ошибок: ${counts.failed}\n`;
    body.push(summary);
    process.stdout.write(`${body.join('\n')}\n`);
    lines.push(...body);
    const reportPath = flags.get('report');
    if (reportPath) writeFileSync(reportPath, `${lines.join('\n')}\n`);
    if (counts.failed > 0) return EXIT_FAILURE;
    return counts.manual > 0 || sections.manual > 0 ? EXIT_MANUAL : 0;
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
