import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { moscowDateKeyOf } from '@technic/contracts';
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
// Обход популяции — тем же ядром, каким её ходит массовый прогон: «ревалидация прошла» обязано
// означать у обоих одно и то же множество заявок.
import { ensureOneRequest, nextHistoryPage, withHistoryRetry } from './assignment-history-run';
import { planCutover, type CutoverAttestation, type CutoverStep } from './assignment-cutover-plan';
import {
  ASSIGNMENT_HISTORY_ALGO_VERSION,
  setModuleMode,
  type AssignmentReadMode,
  type AssignmentWriteMode,
} from '../src/services/assignment-mode';
import {
  assignmentCutoverReadiness,
  type CutoverObstacle,
} from '../src/services/assignment-readiness';
import type * as Shadow from '../src/services/assignment-shadow';

/**
 * Окно переключения чтения истории назначения — одной командой (§10 плана
 * `docs/assignment-periods-plan.md`, решения Ж2, И1, О4, Р3).
 *
 * ЗАЧЕМ ОНА. Порядок окна состоит из шести шагов, и до сих пор его исполняли руками по runbook,
 * перенося между командами идентификатор поколения и идентификатор аттестации. Цена ошибки в этом
 * переносе — не опечатка, а окно: портал в это время закрыт для записи, аттестация живёт полчаса,
 * а поколение не переживает полуночи. Здесь порядок исполняется как порядок, и каждый шаг
 * начинается ровно тогда, когда предыдущий доказан.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ — И ЭТО ГЛАВНОЕ:
 *
 * - **не заменяет ни одной проверки двери.** Матрица переходов, готовность популяции, поколение,
 *   аттестация, `dirty` — всё это считает `setModuleMode` под блокировкой, в одной транзакции с
 *   записью. Команда только подходит к двери в правильном порядке и с готовыми доказательствами;
 *   её собственный разбор (`planCutover`) — предполётный, и его отказ означает «не начинаем», а
 *   не «нельзя»;
 * - **не снимает аттестацию раската.** Разрешение переключаться и его обоснование обязаны исходить
 *   от разных рук (О4): аттестацию пишет тот, кто раскатывал, своей ролью, а эта команда её
 *   потребляет. Снимай она аттестацию себе — проверка стала бы круговой;
 * - **не заменяет режим технических работ.** Заморозка закрывает запись модулю, а не порталу:
 *   человек в это время видит не объявление, а заявку, которая не сохраняется. Объявление ставит
 *   `deploy-auto --maintenance=on`, и оно ставится **снаружи** этой команды;
 * - **не правит данные.** Единственная её запись помимо режима — ревалидация, а это пересчёт
 *   состояния уже существующей истории тем же путём, что у прогона (`ensureAssignmentHistory`).
 *
 * ВОЗОБНОВЛЯЕМОСТЬ ВМЕСТО ОТКАТА. Обрыв посреди окна не откатывается: переход, записанный в
 * журнал, — факт. Поэтому повторный запуск не начинает заново, а доделывает: шаг, чей результат
 * уже достигнут, пропускается (`planCutover`). Оборвавшееся после переключения окно повторный
 * запуск закрывает разморозкой — то есть ровно тем, что осталось.
 *
 * ЧТО ДЕЛАЕТСЯ ПРИ ПРОВАЛЕ. Если заморозку поставила эта команда, а дальше что-то не сошлось, она
 * её снимает: портал возвращается к работе в прежнем режиме чтения, и это честный исход —
 * переключение не состоялось, а закрытая запись без переключения не нужна никому. Заморозку,
 * которая стояла до неё, команда не трогает: её ставил человек и ради своей работы.
 *
 * Запуск на площадке:
 *
 *   docker compose -f deploy/docker-compose.yml -p technic --profile tools \
 *     run --rm assignment-cutover status --build=<sha> --attestation=<id>
 *   docker compose … run --rm assignment-cutover run --actor=<email> --build=<sha> \
 *     --attestation=<id> --reason='cutover истории назначения'
 *
 * Порядок окна целиком, вместе с режимом техработ, — `docs/runbook.md`, раздел «Переключение
 * чтения на историю (cutover)».
 */

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** Не начали либо не дошли: препятствия названы, разбирает человек. */
const EXIT_BLOCKING = 3;

/**
 * Модуль сравнения грузится по имени: он зовёт боевой расчёт бумаги, а тот тянет прикладной конфиг.
 * Статический импорт потребовал бы полного env приложения даже от `status`.
 */
const SHADOW_MODULE = '../src/services/assignment-shadow';

/** Размер страницы ревалидации — тот же, что у массового прогона. */
const PAGE_SIZE = 500;
/** Как часто печатать ход ревалидации: окно читают в реальном времени, молчание в нём тревожно. */
const PROGRESS_EVERY = 250;

class UsageError extends Error {}
/** Отказ по существу: команда не начала работу либо остановилась, и причина уже напечатана. */
class BlockedError extends Error {}

type Handle = ReturnType<typeof drizzle<typeof schema>>;

// ───────────────────────────────── разбор аргументов ─────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KNOWN_FLAGS = new Set(['actor', 'build', 'attestation', 'reason', 'run', 'keep-frozen']);

interface Args {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? 'status';
  const flags = new Map<string, string>();
  for (const raw of argv.slice(1)) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --build=…)`);
    }
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw.slice(2) : raw.slice(2, eq);
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`Неизвестный флаг: --${name}`);
    flags.set(name, eq < 0 ? '' : raw.slice(eq + 1));
  }
  return { command, flags };
}

function requireFlag(flags: Map<string, string>, name: string, what: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new UsageError(`Не задан --${name}: ${what}`);
  return value;
}

function optionalUuid(flags: Map<string, string>, name: string): string | undefined {
  const value = flags.get(name)?.trim();
  if (!value) return undefined;
  if (!UUID_RE.test(value)) throw new UsageError(`--${name}=${value} не похоже на uuid`);
  return value;
}

function usage(): void {
  console.log(
    [
      'assignment-cutover — окно переключения чтения истории назначения одной командой.',
      '',
      '  assignment-cutover status --build=<sha> [--attestation=<id>]',
      '                        что предстоит сделать и что мешает; ничего не меняет',
      '  assignment-cutover run --actor=<email> --build=<sha> --attestation=<id>',
      '                         [--reason=<текст>] [--run=<uuid>] [--keep-frozen]',
      '                        окно целиком: заморозка → ревалидация → поколение → сводка →',
      '                        переключение → разморозка',
      '  assignment-cutover abort --actor=<email> --build=<sha> [--reason=<текст>]',
      '                        снять заморозку после неудачной попытки; чтение не трогается',
      '',
      '  --attestation  аттестация раската; её снимает тот, кто раскатывал: assignment-attest',
      '                 --build=<sha>. Команда не снимает её сама намеренно (О4)',
      '  --run          продолжить уже заведённое поколение сравнения вместо нового',
      '  --keep-frozen  не размораживать запись после переключения (разбор в закрытом портале)',
      '',
      'Коды возврата: 0 — сделано; 3 — не начали либо остановились (причина названа);',
      '1 — ошибка; 2 — ошибка в аргументах.',
      '',
      'Объявление порталу ставится снаружи: deploy-auto --maintenance=on.',
      'Доступ: DATABASE_MAINTENANCE_URL, при отсутствии — DATABASE_MIGRATION_URL.',
      'Сверх того команде нужен env приложения: сравнение зовёт боевой расчёт бумаги.',
    ].join('\n'),
  );
}

// ───────────────────────────────── вывод ─────────────────────────────────

const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Отметка времени у каждой строки хода: по ней потом считают, сколько портал был закрыт. */
function stamp(): string {
  return moscow.format(new Date());
}

function say(text: string): void {
  console.log(`${stamp()}  ${text}`);
}

function printObstacles(obstacles: readonly CutoverObstacle[]): void {
  for (const o of obstacles) {
    console.log(`  · ${o.count > 0 ? `${o.count}: ` : ''}${o.what}`);
    console.log(`      ${o.fix}`);
    if (o.samples.length > 0) console.log(`      заявки: ${o.samples.join(', ')}`);
  }
}

// ───────────────────────────────── чтение состояния ─────────────────────────────────

async function readControlRow(
  db: Handle,
): Promise<{ writeMode: AssignmentWriteMode; readMode: AssignmentReadMode } | null> {
  const rows = await db
    .select({
      writeMode: schema.assignmentPeriodsControl.writeMode,
      readMode: schema.assignmentPeriodsControl.readMode,
    })
    .from(schema.assignmentPeriodsControl)
    .limit(2);
  if (rows.length > 1) {
    throw new Error('В `assignment_periods_control` больше одной строки — разбирает человек');
  }
  return rows[0] ?? null;
}

/**
 * Аттестация по названному идентификатору — со всеми причинами, по которым она может не годиться.
 *
 * Сводка отдаёт «последнюю непотреблённую», и для предполёта этого мало: оператор держит в руках
 * конкретную строку, и переключаться обязаны именно ею. Потреблённая тоже читается — иначе отказ
 * звучал бы «аттестация не найдена» там, где она найдена и уже израсходована.
 */
async function readAttestationById(db: Handle, id: string): Promise<CutoverAttestation | null> {
  const { rows } = await db.execute<{
    id: string;
    attested_at: Date;
    consumed_at: Date | null;
    active_build_shas: string[];
    algo_version: string;
    legacy_client_calls: number;
  }>(sql`
    SELECT id, attested_at, consumed_at, active_build_shas, algo_version, legacy_client_calls
      FROM assignment_deploy_attestations
     WHERE id = ${id}::uuid`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    attestedAt: new Date(row.attested_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    activeBuildShas: row.active_build_shas,
    algoVersion: row.algo_version,
    legacyClientCalls: Number(row.legacy_client_calls),
  };
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

// ───────────────────────────────── шаги окна ─────────────────────────────────

interface StepContext {
  db: Handle;
  shadow: typeof Shadow;
  actor: { id: string; label: string };
  buildSha: string;
  attestationId: string;
  reason: string;
  asOf: string;
  /** Поколение: названное оператором либо заведённое шагом сравнения. */
  runId: string | null;
}

async function stepFreeze(ctx: StepContext, readMode: AssignmentReadMode): Promise<void> {
  say('заморозка записи: закрываю модуль целиком и жду активных писателей…');
  const record = await setModuleMode(
    {
      targetWriteMode: 'all_frozen',
      targetReadMode: readMode,
      reason: ctx.reason,
      actorUserId: ctx.actor.id,
      buildSha: ctx.buildSha,
    },
    ctx.db,
  );
  say(`заморозка записи: сделано, переход №${record.id}. Портал заявки не сохраняет`);
}

/**
 * Ревалидация: пересчёт состояния всей непустой истории под единым днём (Ж2).
 *
 * Обязательна и обязательно здесь: календарь двигает границу изменяемого сам, каждую полночь, а
 * дверь активации требует `validated_on = день поколения` у всех заявок популяции. Прогон идёт
 * страницами и однопоточно — как массовый бэкфилл и по той же причине (спайк §4.3).
 */
async function stepRevalidate(ctx: StepContext): Promise<void> {
  say(`ревалидация истории на ${ctx.asOf}…`);
  const started = Date.now();
  let cursor: string | null = null;
  let done = 0;
  const failures: { num: number; message: string }[] = [];
  for (;;) {
    const page = await nextHistoryPage(ctx.db, {
      after: cursor,
      limit: PAGE_SIZE,
      work: 'revalidate',
      asOf: ctx.asOf,
    });
    if (page.length === 0) break;
    // Страница обязана начинаться строго за курсором: не сдвинувшийся курсор даёт не отказ, а
    // вечный прогон по одной и той же странице — а мы в окне, и молчащий цикл здесь дороже всего.
    if (cursor !== null && page[0]!.id <= cursor) {
      throw new Error(
        `Выборка вернула заявку ${page[0]!.id} не за курсором ${cursor}: прогон остановлен, чтобы не идти по кругу`,
      );
    }
    for (const request of page) {
      try {
        await withHistoryRetry(() => ensureOneRequest(ctx.db, request.id, ctx.asOf));
      } catch (error) {
        failures.push({
          num: request.num,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      cursor = request.id;
      done += 1;
      if (done % PROGRESS_EVERY === 0) say(`  · пересчитано ${done}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 10)) {
      console.error(`  !! ТС-${failure.num}: ${failure.message}`);
    }
    throw new BlockedError(
      `Ревалидация не довела ${failures.length} заявок: переключаться с непересчитанной историей ` +
        'нельзя — дверь активации сверяет день валидности у всей популяции.',
    );
  }
  say(`ревалидация: пересчитано ${done} заявок за ${Math.round((Date.now() - started) / 1000)} с`);
}

/**
 * Поколение теневого сравнения: завести (или продолжить), посчитать все цели и объявить исход.
 *
 * Заводится оно **после** заморозки и не раньше: поколение, снятое до неё, доказывает состояние,
 * которое успело измениться — legacy-транзакция, начатая до проверки, закоммитит старый план уже
 * после того, как прогон увидел ноль расхождений.
 */
async function stepShadow(ctx: StepContext): Promise<string> {
  let runId = ctx.runId;
  if (runId) {
    const header = await ctx.shadow.readShadowRun(ctx.db, runId);
    if (!header) throw new UsageError(`Поколение ${runId} не найдено`);
    if (header.asOf !== ctx.asOf) {
      throw new BlockedError(
        `Поколение ${runId} посчитано на ${header.asOf}, а сегодня ${ctx.asOf}: календарь двигает ` +
          'валидность истории сам, и дверь такое поколение не примет. Заведите новое, не называя --run.',
      );
    }
    if (header.buildVersion !== ctx.buildSha) {
      throw new BlockedError(
        `Поколение ${runId} получено сборкой ${header.buildVersion}, а переключаем ${ctx.buildSha}`,
      );
    }
    say(`поколение ${runId}: продолжаю начатое (${header.status})`);
  } else {
    const opened = await ctx.shadow.openShadowRun(ctx.db, { buildVersion: ctx.buildSha });
    const built = await ctx.shadow.buildShadowManifest(ctx.db, { runId: opened.runId });
    const sealed = await ctx.shadow.sealShadowRun(ctx.db, opened.runId);
    runId = sealed.runId;
    say(`поколение ${runId}: заведено, целей ${built.total}, состав закрыт`);
  }

  for (;;) {
    const progress = await ctx.shadow.runShadowChecks(ctx.db, {
      runId,
      onCheck: (outcome, checked, total): void => {
        if (outcome.status === 'mismatch') {
          console.log(`  ! ${outcome.details.summary ?? outcome.requestId}`);
        } else if (checked % PROGRESS_EVERY === 0) {
          say(`  · посчитано ${checked}/${total}`);
        }
      },
    });
    for (const failure of progress.failures) {
      console.error(`  !! цель ${failure.requestId} не посчитана: ${failure.message}`);
    }
    if (progress.failures.length > 0) {
      throw new BlockedError(
        `Сравнение не посчитало ${progress.failures.length} целей: исход поколения неизвестен, ` +
          'а переключение допускается только по посчитанному целиком.',
      );
    }
    if (progress.remaining === 0) break;
    if (progress.checked === 0) {
      throw new BlockedError(
        `Сравнение перестало двигаться: осталось ${progress.remaining} целей, а проход не посчитал ` +
          'ни одной. Разбирайте поколение руками: assignment-shadow status --run=' +
          runId,
      );
    }
  }

  const { header, tally } = await ctx.shadow.finalizeShadowRun(ctx.db, runId);
  if (header.status !== 'completed') {
    const groups = await ctx.shadow.shadowMismatchSummary(ctx.db, runId, 3);
    for (const group of groups) {
      console.error(`  ! ${group.reason} — ${group.count}: ${group.words}`);
      for (const example of group.examples) {
        console.error(
          `      заказ ${example.requestNumber}${example.summary ? `: ${example.summary}` : ''}`,
        );
      }
    }
    throw new BlockedError(
      `Поколение ${runId} отклонено: ${tally.mismatch} расхождений между недельной бумагой и ` +
        'отрезковым планом. Переключение по такому поколению невозможно — расхождения разбирают ' +
        'по одному, после чего заводят новое поколение.',
    );
  }
  say(`поколение ${runId}: исход completed, целей ${tally.match} из ${tally.total}`);
  return runId;
}

/**
 * Предполёт с поколением на руках: та же сводка, что печатает `assignment-report`.
 *
 * Шаг не обязателен для двери — она проверит всё заново под блокировкой, — но обязателен для
 * человека: сводка называет препятствия числами и номерами заявок, а отказ двери называет первое.
 */
async function stepVerify(ctx: StepContext, runId: string): Promise<void> {
  const readiness = await assignmentCutoverReadiness(ctx.db, {
    asOf: ctx.asOf,
    runId,
    buildSha: ctx.buildSha,
  });
  if (!readiness.switchable) {
    printObstacles(readiness.obstacles);
    throw new BlockedError(
      'Сводка готовности не зелёная: переключение не начинается. Препятствия названы выше.',
    );
  }
  say('сводка готовности: зелёная — данные готовы, поколение и аттестация на месте');
}

async function stepSwitch(ctx: StepContext, runId: string): Promise<void> {
  say('переключение чтения на историю…');
  const record = await setModuleMode(
    {
      targetWriteMode: 'all_frozen',
      targetReadMode: 'history',
      reason: ctx.reason,
      actorUserId: ctx.actor.id,
      buildSha: ctx.buildSha,
      runId,
      attestationId: ctx.attestationId,
    },
    ctx.db,
  );
  say(`переключение: сделано, переход №${record.id}, поколение ${record.runId ?? runId}`);
}

async function stepUnfreeze(
  ctx: Pick<StepContext, 'db' | 'actor' | 'buildSha' | 'reason'>,
  readMode: AssignmentReadMode,
): Promise<void> {
  say('разморозка записи…');
  const record = await setModuleMode(
    {
      targetWriteMode: 'normal',
      targetReadMode: readMode,
      reason: ctx.reason,
      actorUserId: ctx.actor.id,
      buildSha: ctx.buildSha,
    },
    ctx.db,
  );
  say(`разморозка: сделано, переход №${record.id}. Портал снова пишет`);
}

// ───────────────────────────────── команды ─────────────────────────────────

interface Preflight {
  steps: CutoverStep[];
  refusal: string | null;
  blocking: readonly CutoverObstacle[];
  notes: string[];
  readMode: AssignmentReadMode;
  writeMode: AssignmentWriteMode;
}

async function preflight(
  db: Handle,
  params: {
    buildSha: string;
    attestationId: string | null;
    attestationRequired: boolean;
    keepFrozen: boolean;
    asOf: string;
  },
): Promise<Preflight> {
  const control = await readControlRow(db);
  const readiness = await assignmentCutoverReadiness(db, {
    asOf: params.asOf,
    buildSha: params.buildSha,
  });
  const attestation = params.attestationId
    ? await readAttestationById(db, params.attestationId)
    : null;
  const plan = planCutover({
    controlRow: control,
    dataReady: readiness.dataReady,
    dataObstacles: readiness.obstacles.filter((o) => o.tier === 'data'),
    attestation,
    attestationRequired: params.attestationRequired,
    algoVersion: ASSIGNMENT_HISTORY_ALGO_VERSION,
    buildSha: params.buildSha,
    now: new Date(),
    keepFrozen: params.keepFrozen,
  });
  return {
    ...plan,
    readMode: control?.readMode ?? 'legacy',
    writeMode: control?.writeMode ?? 'normal',
  };
}

const STEP_TITLE: Record<CutoverStep, string> = {
  freeze: 'заморозить запись целиком',
  revalidate: 'пересчитать валидность истории на сегодня',
  shadow: 'завести поколение сравнения и посчитать его',
  verify: 'сверить сводку готовности с этим поколением',
  switch: 'переключить чтение на историю',
  unfreeze: 'разморозить запись',
};

function printPlan(plan: Preflight): void {
  console.log(`запись     : ${plan.writeMode}`);
  console.log(`чтение     : ${plan.readMode}`);
  for (const note of plan.notes) console.log(`примечание : ${note}`);
  if (plan.refusal) {
    console.log('');
    console.log(`НЕ НАЧИНАЕМ: ${plan.refusal}`);
    printObstacles(plan.blocking);
    return;
  }
  if (plan.steps.length === 0) {
    console.log('');
    console.log('делать нечего');
    return;
  }
  console.log('');
  console.log('предстоит:');
  plan.steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${STEP_TITLE[step]}`);
  });
}

async function runStatus(db: Handle, flags: Map<string, string>, asOf: string): Promise<number> {
  const buildSha = requireFlag(flags, 'build', 'назовите сборку, которой собираетесь переключать');
  const attestationId = optionalUuid(flags, 'attestation') ?? null;
  const plan = await preflight(db, {
    buildSha,
    attestationId,
    attestationRequired: false,
    keepFrozen: flags.has('keep-frozen'),
    asOf,
  });
  printPlan(plan);
  return plan.refusal ? EXIT_BLOCKING : 0;
}

async function runWindow(db: Handle, flags: Map<string, string>, asOf: string): Promise<number> {
  const actorRaw = requireFlag(flags, 'actor', 'журнал переходов требует человека, а не «system»');
  const buildSha = requireFlag(flags, 'build', 'журнал обязан помнить, чем переключили');
  const attestationId = requireFlag(
    flags,
    'attestation',
    'её снимает тот, кто раскатывал: assignment-attest --build=<sha>',
  );
  if (!UUID_RE.test(attestationId)) {
    throw new UsageError(`--attestation=${attestationId} не похоже на uuid`);
  }
  const reason = flags.get('reason')?.trim() || 'cutover истории назначения';
  const keepFrozen = flags.has('keep-frozen');
  const namedRun = optionalUuid(flags, 'run') ?? null;

  const actor = await resolveActor(db, actorRaw);
  const plan = await preflight(db, {
    buildSha,
    attestationId,
    attestationRequired: true,
    keepFrozen,
    asOf,
  });
  console.log(`исполнитель: ${actor.label}`);
  printPlan(plan);
  if (plan.refusal) return EXIT_BLOCKING;
  if (plan.steps.length === 0) return 0;

  const shadow = await loadShadow();
  const ctx: StepContext = {
    db,
    shadow,
    actor,
    buildSha,
    attestationId,
    reason,
    asOf,
    runId: namedRun,
  };
  /** Заморозку снимаем при провале только свою: чужую ставил человек и ради своей работы. */
  const frozeHere = plan.steps.includes('freeze');
  const startedAt = Date.now();
  console.log('');

  try {
    let runId = namedRun;
    for (const step of plan.steps) {
      switch (step) {
        case 'freeze':
          await stepFreeze(ctx, plan.readMode);
          break;
        case 'revalidate':
          await stepRevalidate(ctx);
          break;
        case 'shadow':
          runId = await stepShadow(ctx);
          break;
        case 'verify':
          await stepVerify(ctx, runId!);
          break;
        case 'switch':
          await stepSwitch(ctx, runId!);
          break;
        case 'unfreeze': {
          // Режим чтения перечитывается, а не берётся из предполёта: между ними лежит само
          // переключение, и разморозка обязана нести тот режим, который в строке стоит СЕЙЧАС —
          // дверь запрещает менять запись и чтение одним шагом.
          const now = await readControlRow(ctx.db);
          await stepUnfreeze(ctx, now?.readMode ?? plan.readMode);
          break;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('');
    console.error(`ОСТАНОВЛЕНО: ${message}`);
    await recover(ctx, frozeHere);
    return error instanceof BlockedError ? EXIT_BLOCKING : EXIT_FAILURE;
  }

  console.log('');
  say(
    `готово: чтение идёт по истории назначения, окно заняло ${Math.round((Date.now() - startedAt) / 1000)} с`,
  );
  if (keepFrozen) {
    console.log(
      'Запись осталась замороженной (--keep-frozen). Снять: assignment-cutover abort ' +
        `--actor=${actorRaw} --build=${buildSha}`,
    );
  }
  return 0;
}

/**
 * Возврат портала к работе после неудачи.
 *
 * Отдельным шагом и с собственным разбором отказа: разморозка сама проверяет `dirty`, и её отказ —
 * не «команда сломалась», а «revalidation не закончена». Молчаливо оставленная заморозка страшнее
 * любого отказа: портал в ней не отвечает ошибкой, он просто не сохраняет заявки.
 */
async function recover(ctx: StepContext, frozeHere: boolean): Promise<void> {
  if (!frozeHere) {
    console.error(
      'Заморозку ставили не этой командой — не снимаю. Проверьте режим: assignment-mode status',
    );
    return;
  }
  const control = await readControlRow(ctx.db);
  if (!control || control.writeMode !== 'all_frozen') return;
  try {
    await stepUnfreeze(ctx, control.readMode);
  } catch (error) {
    console.error('');
    console.error(
      'ВНИМАНИЕ: запись осталась ЗАМОРОЖЕННОЙ — портал не сохраняет заявки, и ошибок при этом не ' +
        `показывает. Разморозка не прошла: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      `Снять руками: assignment-mode set --write=normal --actor=<email> --build=${ctx.buildSha} ` +
        "--reason='возврат после неудачного окна'",
    );
  }
}

async function runAbort(db: Handle, flags: Map<string, string>): Promise<number> {
  const actorRaw = requireFlag(flags, 'actor', 'журнал переходов требует человека');
  const buildSha = requireFlag(flags, 'build', 'журнал обязан помнить, чем снимали заморозку');
  const reason = flags.get('reason')?.trim() || 'возврат после неудачного окна';
  const control = await readControlRow(db);
  if (!control) throw new Error('Управляющей строки модуля нет — разбирает человек');
  if (control.writeMode === 'normal') {
    console.log('Запись и так в обычном режиме — снимать нечего');
    return 0;
  }
  const actor = await resolveActor(db, actorRaw);
  console.log(`исполнитель: ${actor.label}`);
  await stepUnfreeze({ db, actor, buildSha, reason }, control.readMode);
  return 0;
}

// ───────────────────────────────── точка входа ─────────────────────────────────

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(command)) {
    usage();
    return 0;
  }
  if (!['status', 'run', 'abort'].includes(command)) {
    throw new UsageError(`Неизвестная команда: ${command} (ожидалось status | run | abort)`);
  }

  const access = resolveMaintenanceAccess();
  const pool = buildMaintenancePool(access, 1);
  try {
    const identity = await readMaintenanceIdentity(pool);
    console.log(`доступ     : ${maintenanceAccessLine(access, identity)}`);
    if (identity.currentUser === APP_ROLE) {
      throw new Error(
        `Окно отменено: соединение открыто прикладной ролью ${APP_ROLE}. Переключение — путь ` +
          'maintenance (П7), и ходит он своей ролью.',
      );
    }
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    const asOf = moscowDateKeyOf(new Date());
    if (command === 'status') return await runStatus(db, flags, asOf);
    if (command === 'abort') return await runAbort(db, flags);
    return await runWindow(db, flags, asOf);
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
      console.error(`ОШИБКА: ${error.message}`);
      usage();
      process.exitCode = EXIT_USAGE;
      return;
    }
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_FAILURE;
  });
