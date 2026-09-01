import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { ASSIGNMENT_HISTORY_ALGO_VERSION } from '../src/services/assignment-mode';

/**
 * Прогон db-теста в заданном режиме чтения модуля периодов назначения — подэтап 4b плана
 * [assignment-periods-plan.md](../../../docs/assignment-periods-plan.md) (У1, Ю9, Р5, Р6).
 * Рабочий список файлов и раздача работы — в
 * [assignment-periods-regression.md](../../../docs/assignment-periods-regression.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЗАЧЕМ. Этап 5 переключает `read_mode: legacy → history`, и бумагу начинает вести отрезковый
 * расчёт вместо недельного (Р5, Р6). Тесты, зашившие недельный разрез, после переключения либо
 * упадут, либо — что хуже — продолжат проходить, проверяя несуществующий мир. Чинить их в окно
 * `all_frozen` нельзя: окно тратится на переключение, а не на починку набора. Значит, оба набора
 * ожиданий пишутся **до** cutover, и файл, которому разрез важен, идёт двумя прогонами.
 *
 * ЧТО ЭТО НЕ ЗАМЕНЯЕТ. Дверь переключения (`setModuleMode`) со всеми её доказательствами —
 * поколением сверки, аттестацией деплоя, предикатом готовности Р20 — проверяет
 * [assignment-mode.db.test.ts](assignment-mode.db.test.ts), и только он. Здесь режим ставится
 * **прямой записью** в управляющую строку: сцене важно состояние, а не путь к нему, а собрать
 * законное доказательство активации внутри откатываемой сцены нечем — предикат Р20 считается по
 * всей базе. Тот же приём и по той же причине уже был написан руками — двумя копиями, каждая со
 * своим заведением поколения сверки, — и здесь он сведён в одно место, чтобы третья и последующие
 * не разошлись с первыми. Копия в
 * [assignment-rollback.db.test.ts](assignment-rollback.db.test.ts) остаётся намеренно: там прогон —
 * отдельный процесс, и файлу нужно собственное соединение под гонку на двух коннектах.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ТРИ СВОЙСТВА, РАДИ КОТОРЫХ МОДУЛЬ И ЗАВЕДЁН
 *
 * 1. **По умолчанию не меняется ничего.** Управляющая строка приезжает из миграции `0167` в
 *    `legacy`, и файл, не позвавший `useReadModeDatabase`, о механике не знает вовсе. Ни один из
 *    полусотни существующих файлов не пришлось трогать ради самого факта её существования.
 *
 * 2. **Режим объявляется явно и даёт два прогона.** `describeReadModes` разворачивает один блок в
 *    два `describe` — по одному на режим, — и ожидания выбираются `byReadMode`, который **требует
 *    оба ключа**. Написать половину набора и забыть вторую нельзя: не соберётся типом. Это и есть
 *    то, чем подэтап 4b платит за узкое окно cutover.
 *
 * 3. **Своя база — не пожелание, а механика.** Управляющая строка одна на базу, и файл, который её
 *    двигает, на общей `TEST_DATABASE_URL` топит соседей: они получают `history` неизвестно от кого
 *    и падают не своей виной. Ловилось это уже дважды (Ю27, Ю30), и оба раза лечилось комментарием
 *    «файлу нужна своя база» — то есть договорённостью, которую нарушает любой, кто запустит набор
 *    одной командой. Здесь база **заводится сама**: имя выводится из `TEST_DATABASE_URL`, база
 *    создаётся, мигрируется штатным раннером и сносится за собой. Забыть про неё нельзя.
 *
 * ПОЧЕМУ СВОЯ БАЗА ПОЛУЧАЕТСЯ ДЁШЕВОЙ. Все 176 миграций накатываются на пустую базу примерно за
 * секунду, а справочники (объекты, парк, специализации) приезжают ими же — сцене есть на чём
 * стоять сразу. Так что «своя база на файл» стоит секунду с небольшим, а не минуту, и держать
 * общую базу ради скорости незачем.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * КАК ПОЛЬЗОВАТЬСЯ
 *
 *     const readMode = useReadModeDatabase('crew');   // на верхнем уровне файла, ДО своего beforeAll
 *
 *     beforeAll(async () => {
 *       if (!readMode.enabled) return;
 *       // `DATABASE_URL` и остальное окружение уже выставлены — можно импортировать клиент.
 *       const { db, closeDb } = await import('../src/db/client');
 *       ...
 *     });
 *
 *     describeReadModes(readMode, 'команда машиниста', (mode) => {
 *       it('дремлющая запись за концом срока', async () => {
 *         const expected = byReadMode(mode, {
 *           legacy: 'отказ: запись ждёт переключения чтения',
 *           history: 'проходит: чтение уже переключено',
 *         });
 *         ...
 *       });
 *     });
 *
 * Порядок вызовов важен: `useReadModeDatabase` регистрирует свой `beforeAll` первым и потому
 * успевает выставить окружение до того, как файл импортирует `../src/db/client`. Снос базы, наоборот,
 * идёт последним — `afterAll` в vitest выполняются в обратном порядке регистрации, и пул файла
 * закрывается раньше, чем база исчезает. Это **обязанность файла**, а не любезность: `FORCE` в
 * сносе базы страхует от соединений ПРОШЛОГО прогона (брошенных упавшим или убитым), но не от
 * собственных. Своё оставленное соединение он оборвёт снаружи, `pg` бросит
 * `terminating connection due to administrator command` некому, и прогон получит необработанное
 * исключение — то есть шум поверх настоящей причины падения.
 */

/** Оба режима чтения: третьего у управляющей строки нет и не планируется. */
export const ASSIGNMENT_READ_MODES = ['legacy', 'history'] as const;

export type TestReadMode = (typeof ASSIGNMENT_READ_MODES)[number];

/**
 * Ожидания по режимам: оба ключа обязательны.
 *
 * Отдельная функция вместо `if (mode === 'legacy')` именно ради обязательности. Разветвление
 * `if` спокойно живёт без `else`, и файл с одним написанным набором выглядит переведённым на
 * механику, будучи непереведённым. Здесь недостающая половина — ошибка компиляции.
 */
export function byReadMode<T>(mode: TestReadMode, cases: Record<TestReadMode, T>): T {
  return cases[mode];
}

/** Своя база файла и режим на ней. */
export interface ReadModeDatabase {
  /**
   * Есть ли `TEST_DATABASE_URL`. `false` — файл целиком пропускается, как и все прочие db-тесты;
   * известно на этапе сбора, поэтому `describe.skipIf` работает без обращения к базе.
   */
  readonly enabled: boolean;
  /** Адрес своей базы. До `beforeAll` пуст. */
  readonly url: string;
  /** Поставить режим чтения и убедиться, что он записан. */
  setReadMode(mode: TestReadMode): Promise<void>;
  /** Что стоит в управляющей строке сейчас — для круговых проверок самой механики. */
  currentReadMode(): Promise<TestReadMode>;
}

/** Сборка, которой помечено служебное поколение сверки: по ней его отличают от настоящих. */
const HARNESS_BUILD = 'test-read-mode-harness';

/** Хвост прогона в имени базы: два одновременных прогона одного файла не встречаются в одной. */
const RUN = Date.now().toString(36).slice(-6);

/**
 * Окружение, без которого не импортируется ни один модуль сервиса: конфиг читается при импорте и
 * без него падает. Тот же набор был скопирован в каждом db-тесте — здесь он один.
 */
function prepareEnvironment(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  if (!process.env.JWT_PRIVATE_KEY_PEM || !process.env.JWT_PUBLIC_KEY_PEM) {
    /*
     * `ed25519`, а не P-256: портал подписывает токены алгоритмом `EdDSA`
     * ([tokens.ts](../src/auth/tokens.ts)), и ключ другой кривой он не примет — вход по логину
     * падает `DataError: Invalid key type` уже внутри `jose`. Файлам, которые зовут сервисы
     * напрямую, тип ключа безразличен, поэтому дефект и не проявлялся на пилотах: он ждал первого
     * файла, поднимающего приложение и логинящегося по HTTP.
     */
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  }
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  /*
   * Два прогона одного файла — вдвое больше запросов к приложению, и боевой потолок частоты (300 в
   * минуту) начинает ловить сам прогон, а не дефект. В тестовом окружении он не защищает ни от
   * чего: клиент один, и он же проверяемый.
   */
  process.env.RATE_LIMIT_MAX ??= '100000';
}

/**
 * Служебное поколение сверки — то, без чего `read_mode = 'history'` не поставить вовсе.
 *
 * `assignment_periods_control_cutover_check` требует ссылки на поколение: переключение обязано
 * называть, чем оно обосновано. Ограничение не обходится и обходиться не должно — поколение
 * заводится настоящей строкой, просто помеченной как служебная. Заводится один раз на базу и
 * переиспользуется обоими прогонами.
 */
async function harnessRunId(client: pg.Client): Promise<string> {
  const found = await client.query<{ run_id: string }>(
    'SELECT run_id FROM assignment_shadow_runs WHERE build_version = $1 LIMIT 1',
    [HARNESS_BUILD],
  );
  const existing = found.rows[0]?.run_id;
  if (existing) return existing;
  const created = await client.query<{ run_id: string }>(
    `INSERT INTO assignment_shadow_runs
       (status, as_of, algo_version, build_version, expected_checks, finished_at)
     VALUES ('completed', $1, $2, $3, 0, now())
     RETURNING run_id`,
    [moscowDateKeyOf(new Date()), ASSIGNMENT_HISTORY_ALGO_VERSION, HARNESS_BUILD],
  );
  const runId = created.rows[0]?.run_id;
  if (!runId) throw new Error('служебное поколение сверки не завелось: режим history не поставить');
  return runId;
}

async function writeReadMode(client: pg.Client, mode: TestReadMode): Promise<void> {
  if (mode === 'legacy') {
    // `cutover_run_id` не стирается: условие `CHECK` одностороннее, а возврат в `legacy` не обязан
    // уничтожать след того, чем история включалась (см. миграцию `0167`).
    await client.query(
      "UPDATE assignment_periods_control SET read_mode = 'legacy' WHERE id = true",
    );
    return;
  }
  const runId = await harnessRunId(client);
  await client.query(
    "UPDATE assignment_periods_control SET read_mode = 'history', cutover_run_id = $1 WHERE id = true",
    [runId],
  );
}

async function readReadMode(client: pg.Client): Promise<TestReadMode> {
  const { rows } = await client.query<{ read_mode: TestReadMode }>(
    'SELECT read_mode FROM assignment_periods_control WHERE id = true',
  );
  const mode = rows[0]?.read_mode;
  if (!mode) throw new Error('управляющей строки модуля нет: база промигрирована не до `0167`');
  return mode;
}

/**
 * Имя своей базы: `<исходная>_rm_<метка>_<хвост прогона>`, не длиннее предела PostgreSQL (63).
 *
 * Режется **исходное** имя, а не хвост: хвост и метка — это то, чем две базы различаются, и
 * обрезание с конца склеило бы одновременные прогоны разных файлов в одну базу. Именно такую
 * склейку механика и обязана исключать.
 */
function ownDatabaseName(source: string, tag: string): string {
  const suffix = `_rm_${tag}_${RUN}`;
  return `${source.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

/**
 * Своя база на файл: завести, промигрировать, выставить окружение — и снести за собой.
 *
 * Зовётся на верхнем уровне файла: сама регистрирует `beforeAll` и `afterAll`, и порядок их
 * относительно хуков файла и есть то, ради чего вызов стоит первым (см. шапку модуля).
 *
 * `tag` — короткая метка файла: попадает в имя базы, чтобы брошенную (упавший `beforeAll`, убитый
 * прогон) находили по имени, а не по списку.
 */
export function useReadModeDatabase(tag: string): ReadModeDatabase {
  const source = process.env.TEST_DATABASE_URL;
  const enabled = Boolean(source);

  let client: pg.Client | null = null;
  let url = '';
  let created: { dbName: string; adminUrl: string } | null = null;

  const requireClient = (): pg.Client => {
    if (!client) throw new Error('своя база ещё не заведена: режим ставят после `beforeAll`');
    return client;
  };

  if (enabled) {
    beforeAll(async () => {
      const base = new URL(source!);
      const dbName = ownDatabaseName(base.pathname.slice(1), tag);
      const admin = new URL(source!);
      admin.pathname = '/postgres';
      const own = new URL(source!);
      own.pathname = `/${dbName}`;
      url = own.toString();
      created = { dbName, adminUrl: admin.toString() };

      const adminClient = new pg.Client({ connectionString: admin.toString() });
      await adminClient.connect();
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await adminClient.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await adminClient.end();
      }

      // Окружение выставляется ДО миграций и до любого импорта сервисов: конфиг читается при
      // импорте модуля, и файл, импортировавший клиента раньше, получил бы чужую базу.
      prepareEnvironment(url);

      client = new pg.Client({ connectionString: url });
      await client.connect();
      // Без этих трёх миграции падают на `citext`, `gin_trgm_ops` и `gen_random_uuid()`.
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    }, 180_000);

    afterAll(async () => {
      if (client) {
        // Режим возвращается на место даже перед сносом базы: снос может не удаться (открытое
        // соединение, отобранные права), и оставленная база обязана остаться в исходном состоянии.
        await writeReadMode(client, 'legacy').catch(() => undefined);
        await client.end().catch(() => undefined);
        client = null;
      }
      if (!created) return;
      const adminClient = new pg.Client({ connectionString: created.adminUrl });
      await adminClient.connect();
      try {
        // `FORCE` — про соединения прошлого прогона (брошенные упавшим или убитым), чтобы база не
        // оставалась на кластере навсегда: их там и так копится десятками. Свои соединения к этому
        // моменту обязаны быть закрыты самим файлом — иначе `FORCE` оборвёт их, и `pg` бросит
        // `57P01` некому.
        await adminClient.query(`DROP DATABASE IF EXISTS "${created.dbName}" WITH (FORCE)`);
      } finally {
        await adminClient.end();
      }
      created = null;
    }, 60_000);
  }

  return {
    enabled,
    get url() {
      return url;
    },
    async setReadMode(mode: TestReadMode): Promise<void> {
      const active = requireClient();
      await writeReadMode(active, mode);
      const written = await readReadMode(active);
      if (written !== mode) {
        throw new Error(`режим чтения не встал: просили ${mode}, в строке ${written}`);
      }
    },
    currentReadMode(): Promise<TestReadMode> {
      return readReadMode(requireClient());
    },
  };
}

/**
 * Один блок случаев — двумя прогонами, по прогону на режим чтения.
 *
 * Режим ставится в `beforeAll` блока и **переспрашивается перед каждым случаем**. Второе не
 * перестраховка: управляющая строка глобальна, и её двигает не только эта механика — соседний
 * случай того же файла, дверь `setModuleMode`, ремонтный сценарий. Стоит лишний `SELECT` меньше
 * миллисекунды, а без него порядок случаев внутри файла становится частью условий проверки.
 *
 * После `history`-прогона режим возвращается в `legacy`: остальной файл — и все, кто прочтёт базу
 * после него, — видят состояние по умолчанию.
 */
/**
 * Подготовить сцену в сегодняшнем мире, а проверять — в назначенном.
 *
 * Зачем. Сцены db-тестов заводят заказ обычным путём портала: статусная ручка переводит его в
 * работу. В `history` эта дверь упирается в бэкстоп (Р22) — история назначения стала источником
 * истины, и чужая дверь не имеет права её достраивать. То есть в боевом режиме **не собирается сама
 * сцена**, хотя предмет проверки к этому отношения не имеет.
 *
 * Разделять их правильно: подготовка — не утверждение теста, и мир, в котором она происходит,
 * значения не имеет. Утверждение проверяется уже в назначенном режиме.
 *
 * Ограничение названо прямо: если предмет случая **и есть** поведение подготовки (например,
 * «статусная ручка в `history` отказывает»), заворачивать её сюда нельзя — это спрячет ровно то,
 * что проверяется.
 */
export async function inLegacy<T>(database: ReadModeDatabase, run: () => Promise<T>): Promise<T> {
  const before = await database.currentReadMode();
  if (before === 'legacy') return run();
  await database.setReadMode('legacy');
  try {
    return await run();
  } finally {
    await database.setReadMode(before);
  }
}

export function describeReadModes(
  database: ReadModeDatabase,
  title: string,
  body: (mode: TestReadMode) => void,
  options?: { readonly modes?: readonly TestReadMode[] },
): void {
  for (const mode of options?.modes ?? ASSIGNMENT_READ_MODES) {
    describe.skipIf(!database.enabled)(`${title} [read_mode = ${mode}]`, () => {
      beforeAll(async () => {
        await database.setReadMode(mode);
      });

      beforeEach(async () => {
        if ((await database.currentReadMode()) !== mode) await database.setReadMode(mode);
      });

      afterAll(async () => {
        await database.setReadMode('legacy');
      });

      body(mode);
    });
  }
}
