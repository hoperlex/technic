import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
// Доступ пишущей стороны — общим модулем: правило «своими кредами и никогда прикладными» (П7)
// живёт в одном месте на все команды контура.
import {
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveDeployAccess,
} from './maintenance-access';
import * as schema from '../src/db/schema';
// Версия алгоритма и счётчик старых вызовов — из тех же модулей, которыми их проверяет дверь
// перехода: второй способ их посчитать означал бы два ответа на вопрос «пора ли переключаться».
import { ASSIGNMENT_HISTORY_ALGO_VERSION } from '../src/services/assignment-mode';
import {
  ASSIGNMENT_LEGACY_WINDOW_DAYS,
  countLegacyPeriodCalls,
} from '../src/services/assignment-legacy-calls';

/**
 * Аттестация деплоя для переключения чтения — команда **job'а деплоя** (О4, Р3 плана
 * `docs/assignment-periods-plan.md`, §6).
 *
 * ЗАЧЕМ ОНА. Дверь перехода `read_mode = history` обязана убедиться, что сверка получена той же
 * сборкой, что сейчас работает, тем же алгоритмом, каким работает дверь, и что старых клиентов не
 * осталось. Ни SQL-функция, ни сам процесс перехода этого знать не могут: `BUILD_SHA` вызывающего
 * процесса ничего не говорит об инвентаре раската, а инвентарь знает тот, кто раскатывал. Поэтому
 * источник истины приносит **отдельная роль отдельной командой**, а дверь перехода эту строку
 * только потребляет — у неё прав на запись аттестации нет.
 *
 * ПОЧЕМУ ЭТО НЕ ФЛАГ ОПЕРАТОРА. Разрешение «переключайся» и его обоснование должны исходить от
 * разных рук: одна кнопка, которая и подтверждает раскат, и использует подтверждение, вернула бы
 * круговую проверку — оператор объявляет себе, что всё в порядке, и сам себе верит.
 *
 * ЧТО СЧИТАЕТСЯ ЗДЕСЬ, А ЧТО ПРИНОСИТСЯ АРГУМЕНТОМ. Считается то, что видно из базы: сколько раз
 * за неделю срок правили старым широким маршрутом (И5). Приносится то, чего в базе нет: какие
 * сборки сейчас раскатаны. Версия алгоритма берётся из кода этой самой сборки — тем и доказывает,
 * что раскатано именно то, что аттестуется.
 *
 * СРОК ГОДНОСТИ. Дверь перехода принимает аттестацию не старше 30 минут и ровно один раз:
 * потреблённая помечается и связывается с записью перехода. Снимать её заранее, «чтобы была», не
 * получится — и это тоже намеренно: она описывает раскат на момент снятия, а не вообще.
 *
 * Запуск — сервисом профиля tools, сразу после успешного раската:
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-attest --build=<sha раскатанного образа>
 *
 * Команды оператора — docs/runbook.md, раздел «История назначения заказа техники».
 */

const EXIT_USAGE = 2;
const EXIT_FAILURE = 1;
/** Гейт не пройден — своя цифра: job деплоя отличает «не смог» от «ещё рано». */
const EXIT_GATE = 3;

class UsageError extends Error {}

function usage(): void {
  console.log(
    [
      'assignment-attest — аттестация раската для переключения чтения истории назначения.',
      '',
      '  assignment-attest --build=<sha> [--build=<sha2> …] [--allow-legacy-calls]',
      '',
      '  --build                 сборка, работающая прямо сейчас. Во время раската их законно две —',
      "                          назовите обе: docker inspect -f '{{.Config.Image}}' technic-api",
      '  --allow-legacy-calls    записать аттестацию даже при ненулевом клиентском гейте.',
      '                          Дверь перехода её всё равно не примет — флаг нужен, чтобы снять',
      '                          строку «для протокола» и увидеть число в журнале аттестаций',
      '',
      'Доступ: DATABASE_DEPLOY_URL, при отсутствии — DATABASE_MAINTENANCE_URL, затем',
      'DATABASE_MIGRATION_URL. Прикладной DATABASE_URL не используется никогда.',
    ].join('\n'),
  );
}

function parseBuilds(argv: readonly string[]): { builds: string[]; allowLegacy: boolean } {
  const builds: string[] = [];
  let allowLegacy = false;
  for (const raw of argv) {
    if (raw === '--allow-legacy-calls') {
      allowLegacy = true;
      continue;
    }
    if (raw === 'help' || raw === '--help' || raw === '-h') throw new UsageError('help');
    const m = /^--build=(.+)$/.exec(raw);
    if (!m) throw new UsageError(`Неизвестный аргумент: ${raw}`);
    const value = m[1]!.trim();
    if (!value) throw new UsageError('--build= пуст: назовите сборку');
    if (!builds.includes(value)) builds.push(value);
  }
  if (builds.length === 0) {
    throw new UsageError(
      'Не названа ни одна сборка: --build=<sha>. Инвентарь раската приносит job деплоя — ' +
        'сама база его не знает',
    );
  }
  return { builds, allowLegacy };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    usage();
    return;
  }
  const { builds, allowLegacy } = parseBuilds(argv);

  const access = resolveDeployAccess();
  const pool = buildMaintenancePool(access);
  try {
    const identity = await readMaintenanceIdentity(pool);
    const db = drizzle(pool, { schema, casing: 'snake_case' });

    const legacyCalls = await countLegacyPeriodCalls(db);

    console.log(maintenanceAccessLine(access, identity));
    if (!access.separated) {
      // Не отказ: пока роли в кластере не разделены, писать аттестацию больше нечем. Но молчать
      // об этом нельзя — разделение обязанностей здесь и есть предмет проверки.
      console.log(
        'ВНИМАНИЕ: аттестация пишется не ролью деплоя (DATABASE_DEPLOY_URL не задан) — ' +
          'разделения обязанностей между раскатом и переключением на этой площадке нет',
      );
    }
    console.log(`сборки     : ${builds.join(', ')}`);
    console.log(`алгоритм   : ${ASSIGNMENT_HISTORY_ALGO_VERSION}`);
    console.log(
      `старых вызовов за ${ASSIGNMENT_LEGACY_WINDOW_DAYS} дн.: ${legacyCalls}` +
        (legacyCalls === 0 ? ' — клиентский гейт пройден' : ' — гейт НЕ пройден'),
    );

    if (legacyCalls > 0 && !allowLegacy) {
      console.error(
        'ОТКАЗ: срок работ ещё правят старым широким маршрутом. Дверь перехода такую аттестацию ' +
          'не примет (И5). Кто и когда — в журнале:\n' +
          '  select created_at, entity_id, metadata from audit_log\n' +
          "   where action = 'assignment.legacy_period_call' order by created_at desc limit 20;",
      );
      process.exit(EXIT_GATE);
    }

    /*
     * Сборки уезжают `ARRAY[…]`, а не одним параметром: массив, подставленный в запрос целиком,
     * приезжает в драйвер строкой, и `('fb43638')::text[]` отказывает приведением. Каждая сборка —
     * свой параметр: и типы сходятся, и подстановки не бывает.
     */
    const shas = sql.join(
      builds.map((b) => sql`${b}`),
      sql`, `,
    );
    const { rows } = await db.execute<{ id: string; attested_at: string }>(sql`
      INSERT INTO assignment_deploy_attestations (active_build_shas, algo_version, legacy_client_calls)
      VALUES (ARRAY[${shas}]::text[], ${ASSIGNMENT_HISTORY_ALGO_VERSION}, ${legacyCalls})
      RETURNING id, attested_at`);
    const row = rows[0]!;
    console.log(`аттестация : ${row.id}`);
    console.log(
      'Годна 30 минут и ровно на одно переключение. Дальше — assignment-mode set --read=history ' +
        `--run=<поколение> --attestation=${row.id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    if (error.message !== 'help') console.error(`ОШИБКА: ${error.message}`);
    usage();
    process.exit(EXIT_USAGE);
  }
  console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_FAILURE);
});
