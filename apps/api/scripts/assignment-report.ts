import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema';
// Доступ административного пути — общим модулем: правило «своими кредами и никогда прикладными»
// (П7) живёт в одном месте на все команды maintenance.
import {
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveMaintenanceAccess,
} from './maintenance-access';
// Предикат готовности — из сервиса, а не своей копией: второй ответ на вопрос «готовы ли мы» был
// бы вторым множеством заявок, и различить их по числам нельзя. Импорт статический: модуль
// прикладной конфиг не тянет (он и написан так ради этой команды).
import {
  assignmentCutoverReadiness,
  type AssignmentCutoverReadiness,
  type CutoverObstacle,
} from '../src/services/assignment-readiness';

/**
 * Сводка готовности модуля истории назначения — этап 4, волна 4.2 плана
 * `docs/assignment-periods-plan.md` (Р20, Р26–Р28, М1, Ж2, З1; нормы — [assignment-periods-observability.md](../../docs/assignment-periods-observability.md)).
 *
 * ЗАЧЕМ ОНА. Перед переключением чтения (этап 5) человек обязан ответить на вопрос «готовы ли мы»
 * числами. До этой команды числа лежали в четырёх местах: состояния готовности — в колонках
 * заявок, доказательство сверки — в manifest поколения, режим — в управляющей строке, разбор
 * невосстановимого — в файле отчёта прогона. Собранные глазами, они расходились: `ready` у всех,
 * но поколение вчерашнее; поколение сегодняшнее, но у трёхсот заявок истории нет вовсе. Команда
 * задаёт все вопросы разом и отвечает **готов / не готов**, а если не готов — называет, что
 * именно мешает и сколько таких заявок.
 *
 * ЭТО НЕ ДВЕРЬ. Она ничего не пишет и ничего не разрешает: переключение делает `assignment:mode
 * set --read=history`, и проверки живут там, в одной транзакции с записью. Здесь — предполётная
 * проверка: то же состояние, прочитанное заранее и без блокировок, чтобы о трёхстах неготовых
 * заявках не узнавали из отказа двери в окне выката.
 *
 * ДВА ВЕРДИКТА, А НЕ ОДИН:
 *
 *   данные       — готова ли история: предикат Р20 + Р28, метки, пересчёт, расхождения поколения.
 *                  Вопрос осмыслен в любой день и меряет остаток работы;
 *   переключение — можно ли нажимать прямо сейчас: полная заморозка записи, поколение
 *                  сегодняшнего дня, свежая непотреблённая аттестация. Вне окна выката —
 *                  «нельзя» по построению, и это норма, а не тревога.
 *
 * Один флаг на оба вопроса был бы красным всегда, и его перестали бы читать.
 *
 * ЧТО УМЕЕТ:
 *
 *   (без флагов)   полная сводка человеку
 *   --json         то же машине: вердикт, числа и перечень препятствий одним объектом
 *   --data         вердикт только по ярусу данных (для ежедневной проверки хода миграции)
 *   --asof=ДАТА    день расчёта валидности (по умолчанию сегодняшний московский)
 *   --run=UUID     поколение, которым собираются переключать (по умолчанию последнее заведённое)
 *   --build=SHA    сборка, которой собираются переключать: сверяется с инвентарём раската (О4)
 *   --limit=N      сколько номеров заявок показывать в каждом перечне (по умолчанию 10)
 *
 * Коды возврата: 0 — готов (в режиме `--data` — готовы данные); 3 — есть препятствия, они
 * перечислены; 1 — ошибка; 2 — ошибка в аргументах. Ненулевой код вне окна выката — норма:
 * поколения и аттестации в обычный день нет.
 *
 * Локально (dev-база, прикладного `DATABASE_URL` в окружении нет):
 *
 *   DATABASE_MAINTENANCE_URL=postgres://technic:technic@127.0.0.1:5433/technic \
 *     pnpm --filter @technic/api assignment:report
 *
 * На площадке — тем же профилем инструментов, что и остальные команды модуля:
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-report
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** Готовности нет: препятствия названы, их разбирает человек. */
const EXIT_BLOCKING = 3;

class UsageError extends Error {}

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

const KNOWN_FLAGS = new Set(['json', 'data', 'asof', 'run', 'build', 'limit', 'help']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --asof=…)`);
    }
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw.slice(2) : raw.slice(2, eq);
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`Неизвестный флаг: --${name}`);
    flags.set(name, eq < 0 ? '1' : raw.slice(eq + 1));
  }
  return flags;
}

// ───────────────────────────────── вывод человеку ─────────────────────────────────

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

/** Доля с одним знаком: «3117 из 3441» человеку меньше говорит, чем «90,6 %». */
function share(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;
}

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(24, ' ')}: ${value}`);
}

function printObstacles(obstacles: readonly CutoverObstacle[]): void {
  for (const o of obstacles) {
    const tier = o.tier === 'data' ? 'данные' : 'окно  ';
    const count = o.count > 0 ? `${o.count}: ` : '';
    console.log(`  [${tier}] ${count}${o.what}`);
    console.log(`           чинит: ${o.fix}`);
    if (o.samples.length > 0) {
      console.log(
        `           заявки: ${o.samples.join(', ')}${o.count > o.samples.length ? ' …' : ''}`,
      );
    }
  }
}

async function printReport(
  db: ReturnType<typeof drizzle<typeof schema>>,
  readiness: AssignmentCutoverReadiness,
  accessLine: string,
  dataOnly: boolean,
): Promise<void> {
  const { population: p, mode, shadow, attestation } = readiness;

  console.log('── ДОСТУП И ДЕНЬ ─────────────────────────────────────────────');
  line('доступ', accessLine);
  line('день расчёта', `${readiness.asOf} (МСК)`);
  line('проверено', when(readiness.checkedAt));

  console.log('');
  console.log('── РЕЖИМ МОДУЛЯ ──────────────────────────────────────────────');
  if (!mode) {
    line('режим', 'УПРАВЛЯЮЩЕЙ СТРОКИ НЕТ — запись остановлена fail-closed');
  } else {
    line('запись', mode.writeMode);
    line('чтение', mode.readMode);
    line('поколение cutover', mode.cutoverRunId ?? '—');
    line('изменено', when(mode.updatedAt));
    // Последний переход — чтобы «почему заморожено» читалось здесь же, а не в другой команде.
    const [last] = await db
      .select({
        at: schema.assignmentPeriodsModeTransitions.at,
        fromWriteMode: schema.assignmentPeriodsModeTransitions.fromWriteMode,
        toWriteMode: schema.assignmentPeriodsModeTransitions.toWriteMode,
        fromReadMode: schema.assignmentPeriodsModeTransitions.fromReadMode,
        toReadMode: schema.assignmentPeriodsModeTransitions.toReadMode,
        reason: schema.assignmentPeriodsModeTransitions.reason,
        actorEmail: schema.users.email,
      })
      .from(schema.assignmentPeriodsModeTransitions)
      .leftJoin(
        schema.users,
        eq(schema.users.id, schema.assignmentPeriodsModeTransitions.actorUserId),
      )
      .orderBy(
        desc(schema.assignmentPeriodsModeTransitions.at),
        desc(schema.assignmentPeriodsModeTransitions.id),
      )
      .limit(1);
    line(
      'последний переход',
      last
        ? `${when(last.at)} — запись ${last.fromWriteMode}→${last.toWriteMode}, ` +
            `чтение ${last.fromReadMode}→${last.toReadMode}, ${last.actorEmail ?? '—'}: ${last.reason}`
        : 'режим ни разу не меняли',
    );
  }

  console.log('');
  console.log('── ГОТОВНОСТЬ ЗАЯВОК (предикат Р20 + Р28) ────────────────────');
  line('требуют готовности', `${p.total} (архивных ${p.archived})`);
  line('ready', `${p.ready}  ${share(p.ready, p.total)}`);
  line('materialized', `${p.materialized}  ${share(p.materialized, p.total)}`);
  line('empty', `${p.empty}  ${share(p.empty, p.total)}`);
  line('  из них без машины', `${p.emptyWithoutAssignment}  (истории не из чего строить)`);
  line('метка dirty', `${p.dirty}  (по всей таблице, как считает дверь)`);
  line('пересчёт не на день', `${p.stale}  (не на ${p.asOf}; по всей таблице, как считает дверь)`);

  console.log('');
  console.log('── ПОКОЛЕНИЕ ТЕНЕВОГО СРАВНЕНИЯ ──────────────────────────────');
  if (!shadow) {
    line('поколение', 'ни одного не заводили');
  } else {
    line('поколение', shadow.runId);
    line('состояние', shadow.status);
    line('день', shadow.asOf);
    line('алгоритм / сборка', `${shadow.algoVersion} / ${shadow.buildVersion}`);
    line('начато / завершено', `${when(shadow.startedAt)} / ${when(shadow.finishedAt)}`);
    line(
      'manifest',
      `целей ${shadow.total} из объявленных ${shadow.expectedChecks}; ` +
        `совпало ${shadow.match}, расхождений ${shadow.mismatch}, не проверено ${shadow.pending}`,
    );
    if (shadow.mismatch > 0) {
      line('разбор', `assignment:shadow mismatches --run=${shadow.runId}`);
    }
  }

  console.log('');
  console.log('── АТТЕСТАЦИЯ ДЕПЛОЯ ─────────────────────────────────────────');
  if (!attestation) {
    line('аттестация', 'непотреблённой нет');
  } else {
    line('аттестация', attestation.id);
    line(
      'снята',
      `${when(attestation.attestedAt)} (${Math.round(attestation.ageMs / 60000)} мин назад)`,
    );
    line('раскатано', attestation.activeBuildShas.join(', '));
    line('алгоритм', attestation.algoVersion);
    line('старых вызовов', attestation.legacyClientCalls);
  }

  console.log('');
  console.log('── ВЕРДИКТ ───────────────────────────────────────────────────');
  if (readiness.alreadySwitched) {
    line('чтение', 'УЖЕ ПЕРЕКЛЮЧЕНО НА ИСТОРИЮ');
  }
  line('данные', readiness.dataReady ? 'ГОТОВЫ' : 'НЕ ГОТОВЫ');
  if (!dataOnly) {
    line('переключение', readiness.switchable ? 'МОЖНО' : 'НЕЛЬЗЯ СЕЙЧАС');
  }

  const shown = dataOnly
    ? readiness.obstacles.filter((o) => o.tier === 'data')
    : readiness.obstacles;
  if (shown.length > 0) {
    console.log('');
    console.log('  ЧТО МЕШАЕТ');
    printObstacles(shown);
  } else {
    console.log('');
    console.log('  препятствий нет');
  }
}

// ───────────────────────────────── точка входа ─────────────────────────────────

function usage(): void {
  console.log(
    [
      'assignment-report — готов ли модуль истории назначения к переключению чтения.',
      '',
      '  assignment:report [--json] [--data] [--asof=ГГГГ-ММ-ДД]',
      '                    [--run=<uuid>] [--build=<sha>] [--limit=N]',
      '',
      '  --json   вердикт и числа машине; --data — вердикт только по ярусу данных.',
      '',
      '  Коды возврата: 0 — готов; 3 — есть препятствия (перечислены); 1 — ошибка; 2 — аргументы.',
      '',
      'Доступ: DATABASE_MAINTENANCE_URL, при отсутствии — DATABASE_MIGRATION_URL.',
      'Прикладной DATABASE_URL не используется: административный путь ходит своей ролью.',
      'Нормы и разбор рисков — docs/assignment-periods-observability.md.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    usage();
    return;
  }

  const asOf = flags.get('asof')?.trim();
  if (asOf !== undefined && !DATE_RE.test(asOf)) {
    throw new UsageError(`--asof=${asOf}: ожидалась дата вида ГГГГ-ММ-ДД`);
  }
  const runId = flags.get('run')?.trim();
  if (runId !== undefined && !UUID_RE.test(runId)) {
    throw new UsageError(`--run=${runId} не похоже на uuid`);
  }
  const rawLimit = flags.get('limit');
  const limit = rawLimit === undefined ? 10 : Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new UsageError(`--limit=${rawLimit}: ожидалось целое от 1 до 500`);
  }
  const dataOnly = flags.has('data');
  const asJson = flags.has('json');

  const access = resolveMaintenanceAccess();
  const pool = buildMaintenancePool(access);
  let ready = false;
  try {
    const identity = await readMaintenanceIdentity(pool);
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    const readiness = await assignmentCutoverReadiness(db, {
      ...(asOf ? { asOf } : {}),
      ...(runId ? { runId } : {}),
      ...(flags.get('build')?.trim() ? { buildSha: flags.get('build')!.trim() } : {}),
      sampleLimit: limit,
    });
    ready = dataOnly ? readiness.dataReady : readiness.switchable && readiness.dataReady;

    if (asJson) {
      /*
       * Ровно то, на что смотрит человек, — но одним объектом: сводку читает и job выката. Поле
       * `ready` отвечает на заданный вопрос (`--data` меняет вопрос, а не ответ), и код возврата
       * повторяет его же — чтобы `&&` в скрипте работал без разбора JSON.
       */
      console.log(
        JSON.stringify(
          {
            asOf: readiness.asOf,
            checkedAt: readiness.checkedAt.toISOString(),
            access: { source: access.source, role: identity.currentUser },
            mode: readiness.mode
              ? {
                  writeMode: readiness.mode.writeMode,
                  readMode: readiness.mode.readMode,
                  cutoverRunId: readiness.mode.cutoverRunId,
                  updatedAt: readiness.mode.updatedAt.toISOString(),
                }
              : null,
            population: readiness.population,
            shadow: readiness.shadow,
            attestation: readiness.attestation,
            dataReady: readiness.dataReady,
            switchable: readiness.switchable,
            alreadySwitched: readiness.alreadySwitched,
            ready,
            obstacles: dataOnly
              ? readiness.obstacles.filter((o) => o.tier === 'data')
              : readiness.obstacles,
          },
          null,
          2,
        ),
      );
    } else {
      await printReport(db, readiness, maintenanceAccessLine(access, identity), dataOnly);
    }
  } finally {
    await pool.end();
  }

  if (!ready) process.exitCode = EXIT_BLOCKING;
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
