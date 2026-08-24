import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema';
// Доступ административного пути — общим модулем: правило «своими кредами и никогда прикладными»
// (П7) обязано жить в одном месте, иначе вторая его копия разойдётся с первой молча.
import {
  APP_ROLE,
  MAINTENANCE_ROLE,
  buildMaintenancePool,
  maintenanceAccessLine,
  readMaintenanceIdentity,
  resolveMaintenanceAccess,
  type MaintenanceAccess,
  type MaintenanceIdentity,
} from './maintenance-access';
// Только типы: `import type` стирается при компиляции, и загрузка сервиса (а с ней — конфига и
// прикладного пула) при `status`/`log` не происходит. Контракт двери при этом проверяет `tsc`.
import type {
  ModeExecutor,
  AssignmentModeChange,
  AssignmentModeTransitionRecord,
  AssignmentReadMode,
  AssignmentWriteMode,
} from '../src/services/assignment-mode';

/**
 * Административная дверь режима модуля истории назначения — этап 2, волна 2.2 плана
 * `docs/assignment-periods-plan.md` (П6).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА. Заморозить запись и переключить чтение — не прикладное действие, а
 * смена режима работы модуля: под ней встают все пишущие двери портала. HTTP-двери у этого пути
 * нет и не будет (решение Р3), а исполнять его должен не тот, кто ходит в базу от лица портала:
 * прикладной роли `UPDATE` на управляющие таблицы не выдаётся вовсе, и открывать дверь её кредами
 * значит вернуть ровно ту границу, ради которой контур заведён (О1, П7).
 *
 * ЧЕМ ХОДИТ В БАЗУ. Своим URL и только им: `DATABASE_MAINTENANCE_URL`, а при его отсутствии —
 * `DATABASE_MIGRATION_URL` (разделение прикладного и миграционного доступа на площадке уже есть, и
 * административный путь строится от него). Молчаливого отката на `DATABASE_URL` нет: команда,
 * которая при отсутствии своих кредов тихо берёт прикладные, — это та же дверь без границы, только
 * незаметная. Нет ни одного из двух — отказ.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Матрицы переходов, проверок поколения, аттестации и записи журнала: всё это —
 * дверь `setModuleMode` из `apps/api/src/services/assignment-mode.ts`. Второй копии правил быть не
 * должно: разойдясь, они дадут путь, где переход, запрещённый сервисом, проходит скриптом. Скрипт
 * отвечает за другое — за то, ЧЕМ и ОТ ЧЬЕГО ИМЕНИ дверь открыта, и за показ состояния.
 *
 * ГРАНИЦА ПРОХОДИТ НЕ ЗДЕСЬ. Сегодня контур ролей не разделён вовсе — прод, dev и тесты ходят
 * одной ролью, а guard-триггер управляющей строки (миграция `0167`) пропускает запись, пока в
 * кластере нет `technic_maintenance`. Проверки этой команды — про «чем открыли», и они fail-closed
 * там, где это ещё имеет смысл: без своего URL команда не работает, при совпадении с прикладным не
 * меняет режим. Физической границей контур становится в тот день, когда роли заведут и раздадут
 * права; до тех пор корректность держится тем, что `UPDATE` на режим прикладной роли не выдан.
 *
 * ЧТО УМЕЕТ:
 *
 *   status                 текущий режим, поколение, кто и когда менял, состояние границы в БД
 *   set                    смена режима через дверь сервиса (обязательны причина и исполнитель)
 *   log                    журнал переходов (append-only, физически неизменяемый)
 *
 * Использование на площадке — аварийный путь, когда портал недоступен или заморожен:
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-mode status
 *   docker compose … run --rm assignment-mode set --write=all_frozen \
 *     --actor=admin@example.org --reason='подготовка к cutover истории' --build=<sha>
 *
 * Локально (dev-база, без прикладного `DATABASE_URL` в окружении):
 *
 *   DATABASE_MAINTENANCE_URL=postgres://technic:technic@127.0.0.1:5433/technic \
 *     pnpm --filter @technic/api assignment:mode status
 *
 * Команды оператора и разбор «режим застрял» — `docs/runbook.md`, раздел «Режим модуля истории
 * назначения».
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/**
 * Режимы перечислены здесь только затем, чтобы отвергнуть опечатку в аргументе; `satisfies` держит
 * список сцепленным с типами сервиса — появится четвёртый режим, и не собраться должно здесь, а не
 * выясниться на площадке отказом двери.
 */
const WRITE_MODES = [
  'normal',
  'history_frozen',
  'all_frozen',
] as const satisfies readonly AssignmentWriteMode[];
const READ_MODES = ['legacy', 'history'] as const satisfies readonly AssignmentReadMode[];

/**
 * Дверь переходов и прикладной пул, на котором она работает. Импорт динамический и по переменной —
 * намеренно: сервис тянет `src/db/client` и через него `src/config`, а тот валидирует **весь** env
 * приложения при загрузке. Статический импорт потребовал бы прикладных секретов даже от команды
 * `status`, которой хватает одного URL. Типы при этом импортированы обычным `import type` — их
 * сверяет `tsc`, а в рантайм они не попадают.
 */
const MODE_DOOR_MODULE = '../src/services/assignment-mode';

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

type Args = { command: string; flags: Map<string, string> };

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? 'status';
  const flags = new Map<string, string>();
  for (const raw of argv.slice(1)) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --reason=…)`);
    }
    const eq = raw.indexOf('=');
    if (eq < 0) {
      throw new UsageError(`Флаг ${raw} без значения: ожидалось ${raw}=…`);
    }
    flags.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  return { command, flags };
}

class UsageError extends Error {}

function requireFlag(flags: Map<string, string>, name: string, what: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new UsageError(`Не задан --${name}: ${what}`);
  return value;
}

function optionalEnum<T extends string>(
  flags: Map<string, string>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = flags.get(name)?.trim();
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(
      `Недопустимое значение --${name}=${value} (ожидалось: ${allowed.join(', ')})`,
    );
  }
  return value as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function optionalUuid(flags: Map<string, string>, name: string): string | undefined {
  const value = flags.get(name)?.trim();
  if (value === undefined || value === '') return undefined;
  if (!UUID_RE.test(value)) throw new UsageError(`--${name}=${value} не похоже на uuid`);
  return value;
}

type Handle = ReturnType<typeof drizzle<typeof schema>>;

// ───────────────────────────────── чтение состояния ─────────────────────────────────

async function readControl(db: Handle) {
  const rows = await db.select().from(schema.assignmentPeriodsControl).limit(2);
  if (rows.length === 0) {
    throw new Error(
      'Управляющей строки нет: `assignment_periods_control` пуста. Без неё freeze проходит ' +
        'вхолостую — строка заводится миграцией 0167 и удалению не подлежит.',
    );
  }
  if (rows.length > 1) {
    throw new Error('В `assignment_periods_control` больше одной строки — разбирает человек');
  }
  return rows[0]!;
}

async function readTransitions(db: Handle, limit: number) {
  const t = schema.assignmentPeriodsModeTransitions;
  return db
    .select({
      id: t.id,
      at: t.at,
      fromWriteMode: t.fromWriteMode,
      toWriteMode: t.toWriteMode,
      fromReadMode: t.fromReadMode,
      toReadMode: t.toReadMode,
      runId: t.runId,
      attestationId: t.attestationId,
      buildSha: t.buildSha,
      algoVersion: t.algoVersion,
      reason: t.reason,
      actorEmail: schema.users.email,
      actorName: schema.users.fullName,
    })
    .from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.actorUserId))
    .orderBy(desc(t.at), desc(t.id))
    .limit(limit);
}

/**
 * Исполнитель перехода. Журнал требует пользователя портала (`actor_user_id NOT NULL`): «кто
 * разрешил» обязано пережить и увольнение, и смену пароля, поэтому машинного «system» здесь нет.
 */
async function resolveActor(db: Handle, raw: string): Promise<{ id: string; label: string }> {
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, fullName: schema.users.fullName })
    .from(schema.users)
    .where(UUID_RE.test(raw) ? eq(schema.users.id, raw) : eq(schema.users.email, raw))
    .limit(2);
  if (rows.length === 0) throw new UsageError(`Исполнитель не найден: --actor=${raw}`);
  if (rows.length > 1) throw new Error(`По --actor=${raw} нашлось несколько учёток`);
  const row = rows[0]!;
  return { id: row.id, label: `${row.fullName} <${row.email}>` };
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

async function printStatus(
  db: Handle,
  access: MaintenanceAccess,
  identity: MaintenanceIdentity,
): Promise<void> {
  const control = await readControl(db);
  const [last] = await readTransitions(db, 1);
  const total = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.assignmentPeriodsModeTransitions);

  console.log(`доступ     : ${maintenanceAccessLine(access, identity)}`);
  console.log(`запись     : ${control.writeMode}`);
  console.log(`чтение     : ${control.readMode}`);
  console.log(`поколение  : ${control.cutoverRunId ?? '—'}`);
  console.log(`изменено   : ${when(control.updatedAt)}`);
  console.log(`переходов  : ${total[0]?.n ?? 0}`);
  if (last) {
    console.log(
      `последний  : ${when(last.at)} — запись ${last.fromWriteMode}→${last.toWriteMode}, ` +
        `чтение ${last.fromReadMode}→${last.toReadMode}, ${last.actorEmail ?? '—'}: ${last.reason}`,
    );
  }
  if (access.sharedWithApp) {
    console.warn(
      '!! административный URL совпадает с прикладным DATABASE_URL: разделения доступа на этой ' +
        'площадке нет, и смена режима отсюда запрещена (читать можно). Заведите ' +
        `${MAINTENANCE_ROLE} и задайте DATABASE_MAINTENANCE_URL.`,
    );
  }
}

async function printLog(db: Handle, limit: number): Promise<void> {
  const rows = await readTransitions(db, limit);
  if (rows.length === 0) {
    console.log('журнал переходов пуст: режим ни разу не меняли');
    return;
  }
  for (const row of rows) {
    console.log(
      `#${row.id}  ${when(row.at)}  запись ${row.fromWriteMode}→${row.toWriteMode}  ` +
        `чтение ${row.fromReadMode}→${row.toReadMode}`,
    );
    console.log(`    кто: ${row.actorName ?? '—'} <${row.actorEmail ?? '—'}>`);
    console.log(`    причина: ${row.reason}`);
    console.log(
      `    поколение: ${row.runId ?? '—'}, аттестация: ${row.attestationId ?? '—'}, ` +
        `сборка: ${row.buildSha}, алгоритм: ${row.algoVersion}`,
    );
  }
}

// ───────────────────────────────── смена режима ─────────────────────────────────

/**
 * Контракт двери. Правила перехода живут в сервисе, и повторять их здесь значило бы завести второй
 * автомат режимов: разойдясь, они дали бы путь, где запрещённое сервисом проходит скриптом.
 */
type ModeDoor = {
  setModuleMode: (
    change: AssignmentModeChange,
    executor: ModeExecutor,
  ) => Promise<AssignmentModeTransitionRecord>;
};

async function loadModeDoor(): Promise<ModeDoor> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(MODE_DOOR_MODULE)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Дверь переходов не загружается (${MODE_DOOR_MODULE}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Смена режима невозможна; чтение (status, log) работает и без неё.',
    );
  }
  if (typeof loaded.setModuleMode !== 'function') {
    throw new Error(
      `В ${MODE_DOOR_MODULE} нет функции setModuleMode — контракт двери разошёлся с этой командой`,
    );
  }
  return loaded as unknown as ModeDoor;
}

async function runSet(
  db: Handle,
  access: MaintenanceAccess,
  identity: MaintenanceIdentity,
  flags: Map<string, string>,
) {
  /*
   * Открывать дверь прикладными кредами нельзя, и проверок здесь две, потому что обходятся они
   * по-разному. Совпадение URL ловит «взяли не ту переменную»; имя роли — «переменная своя, а роль
   * в ней прикладная». Вторая проверка дремлет, пока роли не заведены: сегодня прод, dev и тесты
   * ходят одной ролью, и более общая формулировка запретила бы работу везде.
   */
  if (access.sharedWithApp) {
    throw new Error(
      `Смена режима отменена: ${access.source} совпадает с прикладным DATABASE_URL. ` +
        'Дверь режима не открывается кредами приложения (П7).',
    );
  }
  if (identity.currentUser === APP_ROLE) {
    throw new Error(
      `Смена режима отменена: соединение открыто прикладной ролью ${APP_ROLE}. ` +
        `Административный путь ходит ролью ${MAINTENANCE_ROLE}.`,
    );
  }

  const writeFlag = optionalEnum(flags, 'write', WRITE_MODES);
  const readFlag = optionalEnum(flags, 'read', READ_MODES);
  if (!writeFlag && !readFlag) {
    throw new UsageError(
      'Нечего менять: задайте --write=… либо --read=… (за один вызов меняется что-то одно)',
    );
  }
  const reason = requireFlag(flags, 'reason', 'переход без причины в журнал не пишется');
  const actor = await resolveActor(
    db,
    requireFlag(flags, 'actor', 'журнал переходов хранит учётку исполнителя, а не «system»'),
  );
  const runId = optionalUuid(flags, 'run');
  const attestationId = optionalUuid(flags, 'attestation');
  /*
   * Сборка, которой переключают. Ни имени образа, ни своего SHA процесс не знает: `BUILD_ID`
   * деплой отдаёт только сборщику веба. Поэтому её называет оператор, а подсмотреть тег можно у
   * запущенного контейнера. Умолчания «неизвестно» здесь нет: журнал читают годами, и запись
   * «переключили неизвестно чем» ничего не доказывает.
   */
  const buildSha =
    flags.get('build')?.trim() || process.env.BUILD_SHA?.trim() || process.env.BUILD_ID?.trim();
  if (!buildSha) {
    throw new UsageError(
      "Не названа сборка: --build=<sha> (тег запущенного образа — docker inspect -f '{{.Config.Image}}' technic-api)",
    );
  }

  /*
   * Оба целевых режима у двери обязательны: она сверяет переход целиком и сама отвергает шаг, где
   * меняются сразу оба. Неназванный флагом режим берётся текущим — это не «умолчание», а вторая
   * половина пары, без которой переход не описан.
   */
  const before = await readControl(db);
  console.log(`было       : запись ${before.writeMode}, чтение ${before.readMode}`);
  console.log(`исполнитель: ${actor.label}`);
  console.log(`сборка     : ${buildSha}`);

  /*
   * Дверь исполняет транзакцию тем соединением, которое ей дали: сюда уходит пул этой команды,
   * поднятый на maintenance-кредах. Прикладной пул при этом не поднимается вовсе — а значит и
   * весь env приложения (JWT, S3, почта), который валидирует `src/config.ts`, административной
   * команде не нужен.
   */
  const door = await loadModeDoor();
  const record = await door.setModuleMode(
    {
      targetWriteMode: writeFlag ?? before.writeMode,
      targetReadMode: readFlag ?? before.readMode,
      actorUserId: actor.id,
      reason,
      buildSha,
      runId,
      attestationId,
    },
    db,
  );
  console.log(`переход    : #${record.id} от ${when(record.at)}`);

  /*
   * Итог перечитывается из базы своим соединением, а не берётся из ответа двери: показывать
   * оператору то, что вернул вызов, значит показывать намерение вместо факта.
   */
  const after = await readControl(db);
  console.log(`стало      : запись ${after.writeMode}, чтение ${after.readMode}`);
}

// ───────────────────────────────── точка входа ─────────────────────────────────

function usage(): void {
  console.log(
    [
      'assignment-mode — административная смена режима модуля истории назначения.',
      '',
      '  assignment:mode status                     текущий режим и состояние границы',
      '  assignment:mode log [--limit=N]            журнал переходов (по умолчанию 20)',
      '  assignment:mode set --write=<режим>|--read=<режим> --actor=<uuid|email>',
      '                      --reason=<текст> --build=<sha> [--run=<uuid>] [--attestation=<uuid>]',
      '',
      '  За один вызов меняется что-то одно: сначала заморозка, потом чтение, потом разморозка.',
      '',
      `  режимы записи: ${WRITE_MODES.join(' | ')}`,
      `  режимы чтения: ${READ_MODES.join(' | ')}`,
      '',
      'Доступ: DATABASE_MAINTENANCE_URL, при отсутствии — DATABASE_MIGRATION_URL.',
      'Прикладной DATABASE_URL не используется: административный путь ходит своей ролью.',
      'Команды оператора — docs/runbook.md, раздел «Режим модуля истории назначения».',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (!['status', 'set', 'log'].includes(command)) {
    throw new UsageError(`Неизвестная команда: ${command} (ожидалось status | set | log)`);
  }

  const access = resolveMaintenanceAccess();
  const pool = buildMaintenancePool(access);
  try {
    const identity = await readMaintenanceIdentity(pool);
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    switch (command) {
      case 'status':
        await printStatus(db, access, identity);
        break;
      case 'log': {
        const raw = flags.get('limit');
        const limit = raw === undefined ? 20 : Number.parseInt(raw, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new UsageError(`--limit=${raw}: ожидалось целое от 1 до 500`);
        }
        await printLog(db, limit);
        break;
      }
      default:
        await runSet(db, access, identity, flags);
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
