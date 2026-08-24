import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema';
// Доступ административного пути — общим модулем: правило «своими кредами и никогда прикладными»
// (П7) живёт в одном месте на все команды maintenance.
import {
  APP_ROLE,
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveMaintenanceAccess,
} from './maintenance-access';
// Только типы: `import type` стирается при компиляции, и модуль сравнения (а с ним прикладной
// конфиг) при разборе аргументов не загружается. Контракт при этом проверяет `tsc`.
import type * as Shadow from '../src/services/assignment-shadow';

/**
 * Теневое сравнение планов бумаги — команда оператора (этап 4 плана
 * `docs/assignment-periods-plan.md`, волна 4.1).
 *
 * ЗАЧЕМ ОНА. Прогон сравнения — не прикладное действие, а доказательство права на cutover: он
 * заводит поколение, наполняет манифест целей, печатает его, считает цели и объявляет исход.
 * HTTP-двери у этого пути нет и не будет (З3: maintenance-путь ходит мимо портала), а исполнять
 * его должен не тот, кто ходит в базу от лица приложения.
 *
 * ПОРЯДОК РАБОТЫ. Он же порядок §10 плана — под полной заморозкой записи:
 *
 *   assignment:mode set --write=all_frozen …      закрыть запись (дождаться писателей)
 *   assignment:shadow start --build=<sha>         завести поколение, построить и запечатать манифест
 *   assignment:shadow run --run=<uuid>            посчитать цели (можно в несколько заходов)
 *   assignment:shadow mismatches --run=<uuid>     разобрать расхождения группами
 *   assignment:shadow finalize --run=<uuid>       объявить исход: completed | failed
 *   assignment:mode set --read=history --run=…    переключить чтение по этому поколению
 *
 * ПОЧЕМУ КОМАНДЕ НУЖЕН ENV ПРИЛОЖЕНИЯ. Сравнение зовёт **боевой** недельный расчёт бумаги
 * (`waybill-esm2.ts`), а тот тянет журнал аудита и через него прикладной конфиг. Подменять расчёт
 * ради независимости от env нельзя: сравнение с копией алгоритма доказывало бы совпадение копии с
 * оригиналом, а не совпадение планов. В базу команда при этом всё равно ходит **своими** кредами
 * (`DATABASE_MAINTENANCE_URL`, при отсутствии — `DATABASE_MIGRATION_URL`): прикладной `DATABASE_URL`
 * нужен модулю конфига, а не этой команде, и переключение поколения им не открывается.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Правил сравнения, популяции целей, печати и финализации: всё это —
 * [assignment-shadow.ts](../src/services/assignment-shadow.ts). Второй копии этих правил быть не
 * должно: разойдясь, они дали бы поколение, запечатанное скриптом мимо проверок сервиса.
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/** Модуль сравнения грузится по имени: статический импорт потребовал бы конфиг даже от `help`. */
const SHADOW_MODULE = '../src/services/assignment-shadow';

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

class UsageError extends Error {}

type Args = { command: string; flags: Map<string, string> };

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? 'status';
  const flags = new Map<string, string>();
  for (const raw of argv.slice(1)) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --run=…)`);
    }
    const eq = raw.indexOf('=');
    // Флаг без значения — это переключатель (`--quiet`): пустая строка означает «названо, но
    // значения нет», и разбор значений (`optionalCount`) читает её как «не задано».
    if (eq < 0) flags.set(raw.slice(2), '');
    else flags.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  return { command, flags };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function requireRun(flags: Map<string, string>): string {
  const value = flags.get('run')?.trim();
  if (!value) throw new UsageError('Не задан --run=<uuid>: поколение называют явно');
  if (!UUID_RE.test(value)) throw new UsageError(`--run=${value} не похоже на uuid`);
  return value;
}

function optionalCount(flags: Map<string, string>, name: string, max: number): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`--${name}=${raw}: ожидалось целое от 1 до ${max}`);
  }
  return value;
}

// ───────────────────────────────── вывод ─────────────────────────────────

const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function when(value: Date | null): string {
  return value ? `${moscow.format(value)} МСК` : '—';
}

function printHeader(header: Shadow.ShadowRunHeader, tally?: Shadow.ShadowTally): void {
  console.log(`поколение  : ${header.runId}`);
  console.log(`состояние  : ${header.status}`);
  console.log(`день       : ${header.asOf}`);
  console.log(`алгоритм   : ${header.algoVersion}, сборка ${header.buildVersion}`);
  console.log(`начато     : ${when(header.startedAt)}, завершено: ${when(header.finishedAt)}`);
  if (tally) {
    console.log(
      `манифест   : целей ${tally.total} из объявленных ${header.expectedChecks}; ` +
        `совпало ${tally.match}, расхождений ${tally.mismatch}, не проверено ${tally.pending}`,
    );
  } else {
    console.log(`объявлено  : ${header.expectedChecks} целей`);
  }
}

// ───────────────────────────────── точка входа ─────────────────────────────────

function usage(): void {
  console.log(
    [
      'assignment-shadow — теневое сравнение планов бумаги (этап 4 плана assignment-periods).',
      '',
      '  assignment:shadow start --build=<sha> [--as-of=<ГГГГ-ММ-ДД>]',
      '                                       завести поколение, построить и запечатать манифест',
      '  assignment:shadow run --run=<uuid> [--limit=N] [--quiet]',
      '                                       посчитать цели (можно в несколько заходов)',
      '  assignment:shadow status [--run=<uuid>] [--limit=N]',
      '                                       состояние поколения либо список последних',
      '  assignment:shadow mismatches --run=<uuid> [--examples=N]',
      '                                       сводка расхождений группами по причине',
      '  assignment:shadow finalize --run=<uuid>',
      '                                       объявить исход: completed при нуле расхождений',
      '',
      'Доступ: DATABASE_MAINTENANCE_URL, при отсутствии — DATABASE_MIGRATION_URL.',
      'Сверх того команде нужен env приложения: она зовёт боевой недельный расчёт бумаги.',
      'Порядок cutover целиком — docs/assignment-periods-plan.md §10.',
    ].join('\n'),
  );
}

type Handle = ReturnType<typeof drizzle<typeof schema>>;

async function loadShadow(): Promise<typeof Shadow> {
  try {
    return (await import(SHADOW_MODULE)) as typeof Shadow;
  } catch (error) {
    throw new Error(
      `Модуль сравнения не загружается (${SHADOW_MODULE}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Он зовёт боевой расчёт бумаги, а тот требует прикладной конфиг — задайте env приложения ' +
        '(в деплое команда запускается профилем tools, наследующим общий env).',
    );
  }
}

async function runStart(
  shadow: typeof Shadow,
  db: Handle,
  flags: Map<string, string>,
): Promise<void> {
  const buildVersion =
    flags.get('build')?.trim() || process.env.BUILD_SHA?.trim() || process.env.BUILD_ID?.trim();
  if (!buildVersion) {
    throw new UsageError(
      "Не названа сборка: --build=<sha> (тег запущенного образа — docker inspect -f '{{.Config.Image}}' technic-api). " +
        'Поколение обязано помнить, каким кодом получен результат.',
    );
  }
  const asOf = flags.get('as-of')?.trim();
  if (asOf && !DATE_RE.test(asOf)) throw new UsageError(`--as-of=${asOf}: ожидалось ГГГГ-ММ-ДД`);

  const opened = await shadow.openShadowRun(db, {
    buildVersion,
    ...(asOf ? { asOf } : {}),
  });
  console.log(`заведено   : ${opened.runId}, объявлено ${opened.expectedChecks} целей`);

  const built = await shadow.buildShadowManifest(db, { runId: opened.runId });
  console.log(`манифест   : заведено ${built.added} строк, всего ${built.total}`);

  const sealed = await shadow.sealShadowRun(db, opened.runId);
  console.log(`печать     : состав целей закрыт, поколение ${sealed.status}`);
  console.log('');
  console.log(`дальше     : assignment:shadow run --run=${sealed.runId}`);
}

async function runChecks(
  shadow: typeof Shadow,
  db: Handle,
  flags: Map<string, string>,
): Promise<void> {
  const runId = requireRun(flags);
  const limit = optionalCount(flags, 'limit', 1_000_000);
  const quiet = flags.has('quiet');
  const started = Date.now();
  const progress = await shadow.runShadowChecks(db, {
    runId,
    ...(limit ? { limit } : {}),
    onCheck: quiet
      ? undefined
      : (outcome, done, total): void => {
          if (outcome.status === 'mismatch') {
            console.log(`  ! ${outcome.details.summary ?? outcome.requestId}`);
          } else if (done % 250 === 0) {
            console.log(`  · ${done}/${total}`);
          }
        },
  });
  console.log(
    `посчитано  : ${progress.checked} целей за ${Math.round((Date.now() - started) / 1000)} с; ` +
      `совпало ${progress.matched}, расхождений ${progress.mismatched}, ` +
      `повторов ${progress.repeated}, осталось ${progress.remaining}`,
  );
  for (const failure of progress.failures) {
    console.warn(`!! цель ${failure.requestId} не посчитана: ${failure.message}`);
  }
  if (progress.remaining === 0 && progress.failures.length === 0) {
    console.log(`дальше     : assignment:shadow finalize --run=${runId}`);
  }
}

async function printStatus(
  shadow: typeof Shadow,
  db: Handle,
  flags: Map<string, string>,
): Promise<void> {
  const runId = flags.get('run')?.trim();
  if (!runId) {
    const runs = await shadow.listShadowRuns(db, optionalCount(flags, 'limit', 100) ?? 10);
    if (runs.length === 0) {
      console.log('поколений сравнения ещё не было');
      return;
    }
    for (const run of runs) {
      const tally = await shadow.shadowTally(db, run.runId);
      console.log(
        `${run.runId}  ${run.status.padEnd(9)} ${run.asOf}  ` +
          `цели ${tally.match}/${tally.total} (расхождений ${tally.mismatch}, ` +
          `не проверено ${tally.pending}), сборка ${run.buildVersion}`,
      );
    }
    return;
  }
  if (!UUID_RE.test(runId)) throw new UsageError(`--run=${runId} не похоже на uuid`);
  const header = await shadow.readShadowRun(db, runId);
  if (!header) throw new Error(`Поколение ${runId} не найдено`);
  printHeader(header, await shadow.shadowTally(db, runId));
  const notes = await shadow.shadowNoteTally(db, runId);
  console.log(
    `бумага     : подтверждена обеими сторонами у ${notes.paperConfirmed} целей, ` +
      `сдвинулась бы у ${notes.paperTouched}, отсутствует у ${notes.paperAbsent}`,
  );
  console.log(
    `заметки    : расхождение хвоста (Р30) у ${notes.tailVehicleMismatch} целей, ` +
      `пробел машиниста (Р16) у ${notes.driverGaps}, ` +
      `история восстановлена в памяти у ${notes.historyComputed}`,
  );
}

async function printMismatches(
  shadow: typeof Shadow,
  db: Handle,
  flags: Map<string, string>,
): Promise<void> {
  const runId = requireRun(flags);
  const groups = await shadow.shadowMismatchSummary(
    db,
    runId,
    optionalCount(flags, 'examples', 50) ?? 3,
  );
  if (groups.length === 0) {
    console.log('расхождений нет: обе стороны хотят от бумаги одного и того же');
    return;
  }
  for (const group of groups) {
    console.log(`${group.reason} — ${group.count}: ${group.words}`);
    for (const example of group.examples) {
      console.log(`    заказ ${example.requestNumber} (${example.requestId})`);
      if (example.summary) console.log(`      ${example.summary}`);
    }
  }
}

async function runFinalize(
  shadow: typeof Shadow,
  db: Handle,
  flags: Map<string, string>,
): Promise<void> {
  const runId = requireRun(flags);
  const { header, tally } = await shadow.finalizeShadowRun(db, runId);
  printHeader(header, tally);
  if (header.status === 'completed') {
    console.log('');
    console.log('исход      : поколение годится для переключения чтения');
    console.log(`дальше     : assignment:mode set --read=history --run=${runId} …`);
  } else {
    console.log('');
    console.log(
      `исход      : поколение отклонено — ${tally.mismatch} расхождений. ` +
        `Разберите их (assignment:shadow mismatches --run=${runId}), почините данные ` +
        'и заведите новое поколение: переключение по failed невозможно.',
    );
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (!['start', 'run', 'status', 'mismatches', 'finalize'].includes(command)) {
    throw new UsageError(
      `Неизвестная команда: ${command} (ожидалось start | run | status | mismatches | finalize)`,
    );
  }

  const access = resolveMaintenanceAccess();
  const pool = buildMaintenancePool(access);
  try {
    const identity = await readMaintenanceIdentity(pool);
    console.log(`доступ     : ${maintenanceAccessLine(access, identity)}`);
    if (identity.currentUser === APP_ROLE) {
      throw new Error(
        `Прогон отменён: соединение открыто прикладной ролью ${APP_ROLE}. ` +
          'Теневое сравнение — путь maintenance (З3), и ходит он своей ролью.',
      );
    }
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    const shadow = await loadShadow();
    switch (command) {
      case 'start':
        await runStart(shadow, db, flags);
        break;
      case 'run':
        await runChecks(shadow, db, flags);
        break;
      case 'mismatches':
        await printMismatches(shadow, db, flags);
        break;
      case 'finalize':
        await runFinalize(shadow, db, flags);
        break;
      default:
        await printStatus(shadow, db, flags);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`ОШИБКА: ${error.message}`);
    usage();
    process.exit(EXIT_USAGE);
  }
  console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_FAILURE);
});
