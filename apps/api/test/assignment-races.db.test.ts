import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { esm2Periods, moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, И ОН ОПАСНЕЕ ОБЫЧНОГО db-ТЕСТА.
 *
 * 1. Он **держит строки заявок открытыми транзакциями** — в этом весь его предмет: очередь за
 *    строкой заявки и есть то, что проверяется. Чужая нагрузка на ту же базу сделала бы ожидание
 *    неотличимым от ошибки порядка, а свой заказ он при этом заводит новый на каждый случай.
 * 2. Он **берёт управляющую строку модуля `FOR SHARE`** на каждой команде (шаг 0 канона), а соседние
 *    файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30): прогон по общей
 *    `TEST_DATABASE_URL` дал бы падение, которое выглядит поломкой кода, а не гонкой файлов.
 * 3. Он **жжёт номера бланков строгой отчётности**: строка серии `waybill_series` одна на портал, и
 *    конкурентный счётчик номеров — сам по себе источник `40001` у соседей.
 *
 * Режим модуля файл при этом НЕ меняет: заморозки здесь нет ни в одном случае.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_races \
 *     npx vitest run test/assignment-races.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/**
 * Гонки дверей истории назначения — этап 3, волна 3.4
 * (`docs/assignment-periods-plan.md`, §8, Р9, Р32; «Конкурентные», «Ручная выписка и блокировки»).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЭТОГО НЕ ВИДНО НИ В ОДНОМ ПРЕДМЕТНОМ ТЕСТЕ. Предметные файлы
 * (`assignment-crew`, `assignment-correction`, `assignment-repair`) гоняют дверь на одном
 * соединении: там видно, что дверь делает, но не видно, **что она делает, пока рядом работает
 * другая**. Порядок «блокировка → расчёт → запись» — свойство пары транзакций: файл, прочитанный
 * сверху вниз, показывает, что версия сверяется под блокировкой, и не показывает, что этого
 * достаточно.
 *
 * Предметы файла:
 *
 * 1. **две команды по одной заявке** — вторая обязана дождаться строки заявки, перечитать версию и
 *    отказать, а не проскочить между расчётом первой и её записью;
 * 2. **предпросмотр против вклинившегося изменения** — 409 по отпечатку, и именно по отпечатку
 *    (`assignment_preview_stale`), а не по версии: человек должен узнать, что последствия стали
 *    другими;
 * 3. **команда истории против ручной выписки ЭСМ-2** — они серийны, дедлока нет, а проигравшая
 *    получает 409 по версии и **не жжёт номер**;
 * 4. **команда истории против ручек смены** — порядок `заявка → смена` переведён подэтапом 2a
 *    (Ю28, Ю29), и здесь проверяется, что он держит у обеих ручек, сохранения и подписи: они не
 *    только встают в очередь, но и **принимают решение о состоянии дня под той же блокировкой**,
 *    под которой пишут;
 * 5. **повтор по одному `operationId` из двух соединений** — работа делается один раз, строка
 *    журнала одна, версия поднимается один раз (Р9).
 *
 * ПОЧЕМУ КАЖДЫЙ ЗЕЛЁНЫЙ СЛУЧАЙ ЧЕМ-ТО ПОДПЁРТ. Тест на гонку, в которой встреча невозможна в
 * принципе, зелен и на сломанном коде — тем же рассуждением, каким подэтап 2a завёл контрольный
 * клинч (Ю29). Поэтому здесь:
 *
 * - параллельность **доказывается**, а не предполагается: обе двери сначала встают в очередь за
 *   строкой заявки, которую держит отдельное соединение, и очередь видна через `pg_blocking_pids`;
 * - у случаев с ручной выпиской и сменами есть **контрольный сюжет**, обязанный дать другой ответ
 *   («держатель версии не тронул» → лист выписан; «коррекции не было» → 422 «согласована» и тихая
 *   подпись без единого события);
 * - клинч в сцене смены **достижим**, и это показано сырым SQL со встречным порядком: `40P01`.
 *
 * ПОЧЕМУ `lock_timeout` У ВСЕХ СОЕДИНЕНИЙ, ВКЛЮЧАЯ ПУЛ ПРИЛОЖЕНИЯ. Ошибка порядка проявляется
 * ожиданием, а ожидание без предела — это зависший прогон, который читается как «тест сломался», а
 * не «код сломался». Предел ставится и пулу — параметром `options` в строке подключения, — потому
 * что двери работают на его соединениях, а не на наших.
 */

const RAW_DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом.
 *
 * Больше барьера очереди намеренно: пока вторая дверь встаёт в очередь, первая уже в ней стоит, и
 * предел, меньший барьера, убивал бы её раньше, чем сцена соберётся, — тест падал бы на собственной
 * обвязке, а выглядело бы это ошибкой порядка захвата.
 */
const LOCK_TIMEOUT_MS = 20_000;
/** Сколько ждём, пока дверь встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 10_000;

/**
 * Строка подключения приложения с пределом ожидания.
 *
 * `options=-c lock_timeout=…` — стартовый параметр протокола, и node-postgres передаёт его как есть.
 * Без него соединение пула ждало бы чужую блокировку вечно, и сломанный порядок захвата выглядел бы
 * как зависший прогон.
 */
const APP_DB_URL = RAW_DB_URL
  ? `${RAW_DB_URL}${RAW_DB_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    )}`
  : undefined;

const ADMIN_EMAIL = 'db-races-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: гонки дверей истории';
const TYPE_PREFIX = 'races_';
/**
 * Имя типа с «Ямобуры…» по той же причине, что и у соседних файлов: половина db-тестов берёт тип
 * своего вида выражением `ORDER BY vt.name LIMIT 1`, и тип на «А» увёл бы их заявки к нам.
 */
const TYPE_NAME = 'Ямобуры тестовые (гонки, линейные)';

// ── Календарь сцен ──
//
// Всё считается от понедельника текущей недели: у сцены есть отработанная неделя (прошлая), текущая
// и две предстоящие. День расчёта дверей — сегодняшний: `crewAsOf()` берёт его из часов, и передать
// туда свой день через HTTP нечем.

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** Понедельник прошлой недели: к сегодняшнему дню эта неделя уже отработана. */
const PREV = shiftDateKey(MONDAY, -7);
/** Понедельник через неделю: его лист и аннулируют посреди сюжета с отпечатком. */
const NEXT2 = shiftDateKey(MONDAY, 14);
const TERM_TO = shiftDateKey(NEXT2, 6);

/**
 * Срок сцены коррекции — с понедельника прошлой недели: разрез машины ставится на понедельник
 * текущей, и первый отрезок обязан быть **раньше** него. Со вчерашним началом срока (см. ниже)
 * разрез оказался бы перед началом, и целью коррекции стало бы последнее решение о машине — то,
 * которое правит окно смены техники, а не эта дверь (Р7).
 */
const CORRECTION_TERM = { from: PREV, to: TERM_TO };

/**
 * Начало срока у сцен команды машиниста — **вчера**, и это не украшение календаря.
 *
 * Причина в устройстве этапа 3. Бумагу исполняет прежняя недельная сверка, и печатает она машиниста
 * заявки **на день расчёта** (`legacyDriverPersonId = driverOn(asOf)`), а постусловие Р11 сверяет
 * результат с новым, отрезковым планом. Сойтись они обязаны — иначе `assignment_paper_diverged`, —
 * и сходятся ровно тогда, когда команда назначает человека **с даты не позже сегодняшней и до конца
 * срока**: тогда «машинист заявки» и «машинист отрезка» — один и тот же человек. Команда будущей
 * датой этого свойства не имеет: старый алгоритм напечатал бы прежнего человека там, где новый план
 * ждёт нового, — и такая команда до переключения чтения истории попросту недостижима.
 *
 * Вчерашнее начало срока даёт сверх того **устойчивый исход**: `set` этой датой всегда задевает
 * прошедший день, то есть всегда `crew` (Р32) — с причиной, ключом операции и правом коррекции.
 * Возьми сцена понедельник текущей недели, исход зависел бы от дня запуска: в понедельник `none`,
 * в остальные дни `crew`, — и половина случаев проверяла бы себя через раз.
 */
const TERM_FROM = shiftDateKey(TODAY, -1);

/**
 * Начало срока у сцен **ручной выписки** — прошлый понедельник, а в дни месячного разреза начало
 * того куска недели, который идёт прямо сейчас.
 *
 * ПОЧЕМУ ДЕНЬ ПОДБИРАЕТСЯ, А НЕ ПИШЕТСЯ. Обеим сценам выписка нужна **обычной дверью**: предмет
 * случаев — очередь за строкой заявки и версия, а не право на прошлое, и 422 «укажите причину»
 * убил бы их обоих ещё до всякой блокировки. Между тем просьба адресована неделе целиком
 * (`onDemandPeriodsOf`), право спрашивается по концу её **первого** листа, а месячный разрез
 * (ADR 0142) в переходную неделю ставит первым односуточный кусок вроде «31–31 августа» — то есть
 * вчерашний. Со сроком от прошлого понедельника дверь в такие дни законно становится операцией
 * коррекции, и красной оказывается посылка сцены, а не порядок захвата, который она стережёт.
 *
 * Начало куска ищется тем же `esm2Periods`, каким режет бумагу портал: чем именно она режется —
 * дело портала, и повторять здесь «первое число месяца» значило бы завести второе правило разреза,
 * которое однажды разойдётся с первым.
 *
 * ЧТО ПОКРАСНЕЛО БЫ, ОСТАВЬ МЫ `PREV`. Перебор дней 2025–2027: 107 дней из 1095 — те, где первое
 * число месяца попадает в текущую неделю позже понедельника и не позже сегодняшнего дня. Ровно на
 * таком дне (вторник 1 сентября 2026-го) оба случая и покраснели.
 *
 * ЧТО ОТ ПОДБОРА НЕ МЕНЯЕТСЯ. Просьба идёт о той же самой — сегодняшней — неделе, и лист у неё
 * по-прежнему ровно один: срок кончается сегодня, поэтому за сегодняшним днём периодов нет вовсе, а
 * подбор убирает только те, что кончились до него. Контрольный случай оттого и вправе ждать
 * `toHaveLength(1)` в любой день года. Ни очередь, ни версия от длины срока не зависят: держатель
 * берёт строку заявки, а выписка встаёт за ней, чем бы ни была нарезана бумага.
 */
const ESM2_TERM_FROM = ((): string => {
  const running = esm2Periods(MONDAY, shiftDateKey(MONDAY, 6)).find((period) => period.to >= TODAY);
  if (!running) throw new Error('в текущей неделе не нашлось куска, который не кончился бы вчера');
  return running.from === MONDAY ? PREV : running.from;
})();

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  userId: string;
  objectId: string;
  vehicleA: { id: string; typeId: string; kindId: string };
  vehicleB: { id: string; typeId: string };
  vehicleC: { id: string; typeId: string };
  personA: string;
  personB: string;
  personC: string;
  /** Линейный тип: только под ним живёт ручная выписка `on_demand` (ADR 0100 §6). */
  linearTypeId: string;
}

let ctx: Ctx;
/** Заказы, заведённые случаями: их убирает `afterAll`. */
const created: string[] = [];

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

// ── Сцены ──

interface SceneOptions {
  /** Выписать бумагу на весь срок: тогда у команды есть непустой бумажный план. */
  issueSheets?: boolean;
  /** Разрез машины с понедельника текущей недели: первый отрезок историчен и правится коррекцией. */
  vehicleSplit?: boolean;
  /** Подписанные дни объекта в первом отрезке: их снимает коррекция. */
  approvals?: boolean;
  /** Линейный заказ: единственный, у которого работает ручная выписка `on_demand`. */
  linear?: boolean;
  term?: { from: string; to: string };
}

interface Scene {
  requestId: string;
  version: number;
  /** Идентификатор первого vehicle-изменения: цель коррекции. */
  firstVehicleChangeId: string;
}

/**
 * Заказ спецтехники в работе, заведённый **напрямую в базе**.
 *
 * Через HTTP сцену не собрать: истории у свежей заявки нет вовсе (`empty`), а двери истории такую
 * заявку не пускают (Р20) — материализует её ленивый бэкфилл, у которого свои условия и свой
 * предмет проверки (`assignment-ensure.db.test.ts`). Здесь предмет другой — очередь двух
 * транзакций, — и сцена обязана быть готовой к первому же запросу.
 */
async function seedScene(options: SceneOptions): Promise<Scene> {
  const term = options.term ?? { from: TERM_FROM, to: TERM_TO };
  const typeId = options.linear ? ctx.linearTypeId : ctx.vehicleA.typeId;
  // Хвост истории — последнее активное vehicle-изменение, и денормализация обязана его повторять
  // (Р17): сцена с разрезом закрыта второй машиной, без разреза — первой.
  const tail = options.vehicleSplit ? ctx.vehicleB : ctx.vehicleA;

  const [request] = (
    await ctx.db.execute<{ id: string; version: number }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                    assignment_history_state, assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${typeId}, 'confirmed', ${ctx.userId},
              'materialized', ${TODAY})
      RETURNING id, version`)
  ).rows;
  const requestId = request!.id;
  created.push(requestId);

  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${term.from}, ${term.to})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${tail.id}, ${tail.typeId}, ${typeId}, ${ctx.userId})`);

  // История, какой её оставил бы бэкфилл: машина с начала срока и названный человек.
  const firstVehicleChangeId = await insertChange({
    requestId,
    effectiveDate: term.from,
    dimension: 'vehicle',
    vehicleId: ctx.vehicleA.id,
    origin: 'assignment',
  });
  await insertChange({
    requestId,
    effectiveDate: term.from,
    dimension: 'driver',
    driverState: 'set',
    driverPersonId: ctx.personA,
    origin: 'assignment',
  });
  if (options.vehicleSplit) {
    await insertChange({
      requestId,
      effectiveDate: MONDAY,
      dimension: 'vehicle',
      vehicleId: ctx.vehicleB.id,
      origin: 'reassignment',
    });
  }
  if (options.approvals) {
    // Два дня первого отрезка: его начало и последний день перед разрезом. Ровно они и попадают в
    // `approvalClearRange` коррекции (Р11).
    for (const date of [term.from, shiftDateKey(MONDAY, -1)]) {
      await ctx.db.execute(sql`
        INSERT INTO vehicle_request_shifts
          (request_id, shift_date, machine_hours, comment, filled_by, approved_by, approved_at)
        VALUES (${requestId}, ${date}, 8, '', ${ctx.userId}, ${ctx.userId}, now())`);
    }
  }
  if (options.issueSheets) {
    const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
    await ctx.db.transaction(async (tx) => {
      await syncEsm2Waybills(tx, {
        requestId,
        actor: { id: ctx.userId },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: ctx.personA,
        // Расчёт от начала срока: тогда лист получает и та неделя, что к сегодня уже отработана.
        asOf: term.from,
      });
    });
  }

  return { requestId, version: await versionOf(requestId), firstVehicleChangeId };
}

async function insertChange(row: {
  requestId: string;
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string;
  driverPersonId?: string;
  driverState?: string;
  origin: string;
  changeGroupId?: string;
}): Promise<string> {
  const [inserted] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
              ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
              ${row.changeGroupId ?? randomUUID()})
      RETURNING id`)
  ).rows;
  return inserted!.id;
}

async function versionOf(requestId: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
  );
  return rows[0]!.version;
}

/** Актуальные строки истории заявки: их число и есть мера «сколько работы сделано». */
async function changesOf(requestId: string) {
  return (
    await ctx.db.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      driver_person_id: string | null;
      origin: string;
    }>(sql`
      SELECT id, effective_date, dimension, driver_person_id, origin
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension`)
  ).rows;
}

/** Действующие листы заявки: их число и есть мера «сколько бланков сожжено». */
async function sheetsOf(requestId: string) {
  return (
    await ctx.db.execute<{ id: string; period_from: string; driver_person_id: string }>(sql`
      SELECT id, period_from, driver_person_id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'
       ORDER BY period_from`)
  ).rows;
}

/**
 * События подписи и её снятия по заявке — различитель случаев с подписью.
 *
 * Ручка пишет событие **только за состоявшуюся правку**: повторное нажатие той же кнопки журнал не
 * пополняет. Поэтому наличие события отвечает на вопрос, ради которого эти случаи и написаны, —
 * какое состояние дня ручка увидела, когда решала, что делать.
 */
async function shiftApprovalEvents(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
       WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}
         AND action IN ('vehicle_request.shift_approve', 'vehicle_request.shift_revoke')
       ORDER BY created_at`)
  ).rows.map((row) => row.action);
}

/**
 * Боевое тело периодной коррекции по её же предпросмотру — общее у трёх случаев пары «команда
 * истории ↔ ручка смены».
 *
 * Цель — **первое** решение о машине: последнее правит окно смены техники (Р7). Исход у такой
 * команды `crew` (дата в прошлом), отсюда причина и ключ операции.
 */
async function armedCorrectionOf(scene: Scene): Promise<Record<string, unknown>> {
  const correction = {
    target: { changeId: scene.firstVehicleChangeId },
    vehicleId: ctx.vehicleC.id,
    version: scene.version,
  };
  const preview = await previewCorrection(scene.requestId, correction);
  expect(preview.statusCode, preview.body).toBe(200);
  return armed(correction, json(preview) as never, {
    operationId: randomUUID(),
    reason: 'на первой неделе на объект выходила другая машина',
  });
}

/** Операции журнала, задевшие эту заявку (Р9): по одной на выполненную команду, и ни одной лишней. */
async function operationsOf(requestId: string) {
  return (
    await ctx.db.execute<{ id: string; operation_id: string; kind: string; reason: string }>(sql`
      SELECT c.id, c.operation_id, c.kind, c.reason
        FROM waybill_corrections c
        JOIN vehicle_request_corrections vrc ON vrc.correction_id = c.id
       WHERE vrc.request_id = ${requestId}
       ORDER BY c.created_at`)
  ).rows;
}

// ── Соединения-наблюдатели и держатель блокировки ──

/** Соединение-наблюдатель: только опрос очередей, ни одной блокировки за собой. */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({ connectionString: RAW_DB_URL });
  await probe.connect();
  return probe;
}

/**
 * Держатель строки заявки — стартовый барьер гонки.
 *
 * Пока он открыт, ни одна дверь дальше `lockRequestRow` не уйдёт: обе встают в очередь, и обе
 * начинают работу с одного и того же состояния. Без барьера «параллельность» была бы догадкой —
 * планировщик мог бы выполнить запросы подряд, и зелёный случай ничего не значил бы.
 *
 * Порядок захвата у держателя канонический (§8): управляющая строка `FOR SHARE`, затем строка
 * заявки `FOR UPDATE`.
 */
async function openHolder(requestId: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: RAW_DB_URL });
  await client.connect();
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM assignment_periods_control WHERE id = true FOR SHARE');
  await client.query('SELECT 1 FROM vehicle_requests WHERE id = $1 FOR UPDATE', [requestId]);
  return client;
}

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

/**
 * Дождаться, пока за этим бэкендом встанет очередь нужной длины.
 *
 * Наблюдатель — ОТДЕЛЬНОЕ соединение и обязательно вне транзакции: снимок `pg_stat_activity`
 * кешируется на всю транзакцию читателя, и опрос изнутри держателя блокировки возвращал бы текст
 * запроса, снятый первым же чтением (найдено подэтапом 2a, Ю29). `pg_blocking_pids` при этом всегда
 * свежий — он читает менеджер блокировок, а не статистику.
 *
 * ОЧЕРЕДЬ СЧИТАЕТСЯ ТРАНЗИТИВНО, И ЭТО НЕ ПЕДАНТИЗМ. `pg_blocking_pids` второго в очереди называет
 * **первого**, а не держателя: проверено на живой базе — оба запроса стоят на одной строке, а
 * условие `holder = ANY(pg_blocking_pids(pid))` истинно только у первого. Прямая проверка «сколько
 * запросов блокирует держатель» поэтому никогда не увидела бы двоих, и барьер «оба встали в
 * очередь» не сработал бы ни при каком коде. Отсюда обход в ширину: множество ждущих растёт от
 * держателя через тех, кого он блокирует.
 */
async function waitForWaiters(probe: pg.Client, pid: number, count: number): Promise<string[]> {
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await probe.query<{ pid: number; query: string; blockers: number[] }>(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    const chain = new Set<number>([pid]);
    const queue: { pid: number; query: string }[] = [];
    // Проход повторяется, пока множество растёт: третий в очереди виден только после второго.
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (chain.has(row.pid)) continue;
        if (!row.blockers.some((b) => chain.has(b))) continue;
        chain.add(row.pid);
        queue.push({ pid: row.pid, query: row.query });
        grew = true;
      }
    }
    if (queue.length >= count) return queue.map((r) => r.query);
    if (Date.now() > deadline) {
      const seen = queue.map((r) => `#${r.pid}: ${r.query}`).join('\n') || '— ни одного';
      throw new Error(
        `за держателем строки заявки встало ${queue.length} запросов вместо ${count}: ` +
          `значит дверь её не берёт — порядок захвата потерян. Очередь:\n${seen}`,
      );
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ── Двери через HTTP ──

type Reply = { statusCode: number; body: string };

const json = (res: Reply): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;
const codeOf = (res: Reply): unknown => json(res).code;

function previewCrew(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/preview`,
    headers: ctx.auth,
    payload: body,
  });
}

function commandCrew(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes`,
    headers: ctx.auth,
    payload: body,
  });
}

function previewCorrection(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/correction/preview`,
    headers: ctx.auth,
    payload: body,
  });
}

function commandCorrection(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/correction`,
    headers: ctx.auth,
    payload: body,
  });
}

function approveShift(requestId: string, date: string, approved: boolean): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}/approval`,
    headers: ctx.auth,
    payload: { approved },
  });
}

function saveShift(requestId: string, date: string, hours: number): Promise<Reply> {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}`,
    headers: ctx.auth,
    payload: { machineHours: hours, refuel: '', comment: '' },
  });
}

function issueEsm2(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/esm2`,
    headers: ctx.auth,
    payload: body,
  });
}

/**
 * Тело боевой команды по посчитанному предпросмотру: отпечаток, разблокировки и envelope.
 *
 * Отпечаток множества разблокировок приходит из предпросмотра и при исходе `crew` обязателен даже
 * для пустого множества (Д4), поэтому подставляется он ровно тогда, когда предпросмотр его вернул.
 */
function armed(
  body: Record<string, unknown>,
  preview: { fingerprint: string; unlockFingerprint: string | null },
  operation?: { operationId: string; reason: string },
): Record<string, unknown> {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(operation ? { operation } : {}),
  };
}

/**
 * Боевое тело команды машиниста, собранное по её же предпросмотру.
 *
 * Envelope операции подставляется **по ответу предпросмотра** (`operationRequirement`), а не по
 * догадке теста: исход считает сервер (Р32), и тело, приславшее причину при исходе `none`, получило
 * бы 422 — как и тело без причины при `assignment_tail`. Ключ операции по умолчанию свой у каждого
 * вызова: одинаковый увёл бы вторую команду в ветку повтора, а это отдельный предмет.
 */
async function armedCrew(
  requestId: string,
  body: Record<string, unknown>,
  operationId?: string,
): Promise<Record<string, unknown>> {
  const preview = await previewCrew(requestId, body);
  expect(preview.statusCode, preview.body).toBe(200);
  const dto = json(preview) as {
    fingerprint: string;
    unlockFingerprint: string | null;
    operationRequirement: unknown;
  };
  return armed(
    body,
    dto,
    dto.operationRequirement
      ? {
          operationId: operationId ?? randomUUID(),
          reason: 'на этой неделе на объект выходит другой машинист',
        }
      : undefined,
  );
}

/**
 * Отпечаток подтверждения предупреждений ручной выписки, посчитанный **заранее** (Р21а).
 *
 * Нужен ровно затем, чтобы гоночный вызов был одноходовым: рукопожатие — двухходовка (409 с
 * отпечатком, потом запрос с ним), и посреди гонки второй ход означал бы второй заход на
 * блокировку, то есть другую гонку.
 *
 * Спрашивается заведомо негодной версией: тогда до расхода номера дело не дойдёт ни при каком
 * ответе — сверка версии стоит после выписки и откатывает её (`err.conflict`), а отпечаток
 * предупреждений считается **до**. Ответ `version_conflict` при этом означает «предупреждений нет,
 * подтверждать нечего».
 */
async function ackFingerprintOf(
  requestId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const res = await issueEsm2(requestId, { ...payload, version: 10_000 });
  expect(res.statusCode, res.body).toBe(409);
  const body = json(res) as { code?: string; details?: { fingerprint?: string } };
  if (body.code === 'version_conflict') return null;
  expect(body.code, res.body).toBe('waybill_ack_required');
  return body.details!.fingerprint!;
}

describe.skipIf(!RAW_DB_URL)('гонки дверей истории назначения (§8, Р9, Р32)', () => {
  beforeAll(async () => {
    prepareEnv(APP_DB_URL!);
    await migrate(RAW_DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const existing = (
      await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`)
    ).rows;
    const [user] = existing[0]
      ? existing
      : (
          await db.execute<{ id: string }>(sql`
            INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                               is_active)
            VALUES (${ADMIN_EMAIL}, 'Тестовый', 'Администратор', '',
                    ${await hashPassword(PASSWORD)}, 'admin', true)
            RETURNING id`)
        ).rows;

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const fleet = (
      await db.execute<{ id: string; vehicle_type_id: string; kind_id: string }>(sql`
        SELECT v.id, v.vehicle_type_id, vt.kind_id
          FROM vehicles v
          JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
         WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND v.status = 'active'
           AND vk.code = 'special_equipment'
         ORDER BY v.id LIMIT 3`)
    ).rows;
    const [vehicleA, vehicleB, vehicleC] = fleet;
    if (!vehicleA || !vehicleB || !vehicleC) throw new Error('в парке меньше трёх своих спецмашин');
    const [object] = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
      )
    ).rows;
    if (!object) throw new Error('в справочнике нет объекта: миграции не применены');

    const [spec] = (
      await db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
    ).rows;
    // Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не
    // зависит (ADR 0164), но водителем справочника человек числится именно ею.
    const person = async (last: string): Promise<string> => {
      const [row] = (
        await db.execute<{ id: string }>(sql`
          INSERT INTO persons (last_name, first_name, comment)
          VALUES (${last}, 'Пров', ${PERSON_MARK}) RETURNING id`)
      ).rows;
      await db.execute(sql`
        INSERT INTO person_specializations (person_id, specialization_id, started_on)
        VALUES (${row!.id}, ${spec!.id}, ${shiftDateKey(TERM_FROM, -400)})`);
      return row!.id;
    };

    const [linearType] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO vehicle_types (kind_id, code, name, is_linear)
        VALUES (${vehicleA.kind_id}, ${`${TYPE_PREFIX}${Date.now().toString(36)}`}, ${TYPE_NAME},
                true)
        RETURNING id`)
    ).rows;

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` },
      userId: user!.id,
      objectId: object.id,
      vehicleA: { id: vehicleA.id, typeId: vehicleA.vehicle_type_id, kindId: vehicleA.kind_id },
      vehicleB: { id: vehicleB.id, typeId: vehicleB.vehicle_type_id },
      vehicleC: { id: vehicleC.id, typeId: vehicleC.vehicle_type_id },
      personA: await person('Машинистов'),
      personB: await person('Сменщиков'),
      personC: await person('Подменов'),
      linearTypeId: linearType!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      for (const id of created) {
        await ctx.db.execute(sql`DELETE FROM waybills WHERE source_request_id = ${id}`);
        await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ${id}`);
      }
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections
         WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
         WHERE code LIKE ${`${TYPE_PREFIX}%`}
           AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
           AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM person_specializations
         WHERE person_id IN (SELECT id FROM persons WHERE comment = ${PERSON_MARK})`);
      await ctx.db.execute(sql`
        DELETE FROM persons
         WHERE comment = ${PERSON_MARK}
           AND id NOT IN (SELECT driver_person_id FROM waybills WHERE driver_person_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM audit_log
         WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  // ── 1. Две команды по одной заявке ──

  /**
   * Обе команды стартуют с одного состояния и обе держат версию `N`. Проигравшая обязана дождаться
   * строки заявки, **перечитать** версию под ней и отказать — а не проскочить между расчётом
   * победившей и её записью.
   *
   * Случай не вырождается в «второй прислал устаревшую версию», потому что параллельность здесь
   * доказана: обе двери сначала встают в очередь за держателем, и очередь видна через
   * `pg_blocking_pids`. Убери из канона сверку версии (шаг 3) — вторая дошла бы до плана и ответила
   * бы 422 «тот же машинист на ту же дату»; убери блокировку — обе посчитали бы план по одному
   * состоянию и одна упала бы на частичном UNIQUE. Оба ответа не равны ожидаемому.
   *
   * Ключи операций у команд **разные**: одинаковый увёл бы вторую в ветку повтора (Р9), а это
   * предмет отдельного случая ниже.
   */
  it('две параллельные команды: вторая ждёт заявку, перечитывает версию и отказывает', async () => {
    const scene = await seedScene({ issueSheets: true });
    const body = {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: TERM_FROM,
      driverPersonId: ctx.personB,
      version: scene.version,
    };
    const first = await armedCrew(scene.requestId, body);
    const second = await armedCrew(scene.requestId, body);
    // Исход у такой команды устойчив: `set` вчерашней датой всегда задевает прошедший день, то есть
    // всегда `crew` (Р32) — с причиной и ключом операции.
    expect(first.operation, JSON.stringify(first)).toBeDefined();

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let replies: Reply[];
    try {
      const pid = await backendPid(holder);
      // Двери не ждутся здесь намеренно: очередь за строкой заявки — предмет проверки.
      const firstInFlight = commandCrew(scene.requestId, first);
      const secondInFlight = commandCrew(scene.requestId, second);
      const waiting = await waitForWaiters(probe, pid, 2);
      for (const query of waiting) {
        expect(query).toMatch(/vehicle_requests/);
        expect(query.toLowerCase()).toContain('for update');
      }
      await holder.query('COMMIT');
      replies = await Promise.all([firstInFlight, secondInFlight]);
    } finally {
      await holder.end();
      await probe.end();
    }

    const codes = replies.map((r) => r.statusCode).sort();
    expect(codes, replies.map((r) => r.body).join(' | ')).toEqual([200, 409]);
    const loser = replies.find((r) => r.statusCode === 409)!;
    expect(codeOf(loser)).toBe('version_conflict');

    // Работа сделана ровно один раз: одна актуальная строка на дату, одна операция журнала и один
    // шаг версии.
    const atStart = (await changesOf(scene.requestId)).filter(
      (c) => c.effective_date === TERM_FROM && c.dimension === 'driver',
    );
    expect(atStart).toHaveLength(1);
    expect(atStart[0]!.driver_person_id).toBe(ctx.personB);
    expect(await operationsOf(scene.requestId)).toHaveLength(1);
    expect(await versionOf(scene.requestId)).toBe(scene.version + 1);
  }, 60_000);

  /**
   * Контроль к предыдущему случаю: те же две команды, разведённые во времени и снабжённые свежей
   * версией, проходят обе. Без него зелёный выше объяснялся бы и тем, что дверь отказывает всякой
   * второй команде, — а она отказывает именно устаревшей.
   */
  it('контроль: те же команды по очереди и со свежей версией проходят обе', async () => {
    const scene = await seedScene({ issueSheets: true });

    const first = await commandCrew(
      scene.requestId,
      await armedCrew(scene.requestId, {
        kind: 'set',
        dimension: 'driver',
        effectiveDate: TERM_FROM,
        driverPersonId: ctx.personB,
        version: scene.version,
      }),
    );
    expect(first.statusCode, first.body).toBe(200);

    const second = await commandCrew(
      scene.requestId,
      await armedCrew(scene.requestId, {
        kind: 'set',
        dimension: 'driver',
        effectiveDate: TERM_FROM,
        driverPersonId: ctx.personC,
        version: await versionOf(scene.requestId),
      }),
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(await versionOf(scene.requestId)).toBe(scene.version + 2);
  }, 60_000);

  // ── 2. Предпросмотр против вклинившегося аннулирования ──

  /**
   * Между предпросмотром и командой **своей же ручкой** аннулируют лист будущей недели: заявку никто
   * не трогал, версия её не двинулась, а последствия команды стали другими — сгорать теперь нечему,
   * выписывать надо заново.
   *
   * Ответ обязан быть **409 по отпечатку**. Сюжет выбран именно такой, потому что он отделяет
   * отпечаток от версии начисто: `version` этого случая не ловит вовсе — ровно тем он и назван в
   * контракте поля («лист аннулировали своей ручкой»). Отсюда и проверка кода
   * (`assignment_preview_stale`, а не `version_conflict`): два разных 409 означают два разных
   * действия портала, и подмена одного другим оставила бы человека без объяснения.
   */
  it('вклинившееся аннулирование листа обесценивает предпросмотр: 409 assignment_preview_stale', async () => {
    const scene = await seedScene({ issueSheets: true });
    const body = {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: TERM_FROM,
      driverPersonId: ctx.personB,
      version: scene.version,
    };
    const stale = await armedCrew(scene.requestId, body);

    /*
     * ЭСМ2-РАЗРЕЗ. Лист адресуется **последним по периоду**, а не равенством `period_from === NEXT2`.
     * Пока лист и неделя совпадают, это одно и то же; после переключения чтения (этап 5) в неделе
     * живут два листа, и ни один не обязан начинаться в понедельник — прежняя адресация нашла бы
     * `undefined` и уронила бы случай на пустом месте, хотя предмет проверки (устаревший отпечаток)
     * к разрезу отношения не имеет.
     */
    const sheets = await sheetsOf(scene.requestId);
    const doomed = sheets[sheets.length - 1]!;
    expect(doomed.period_from >= NEXT2).toBe(true);
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waybills/${doomed.id}/cancel`,
      headers: ctx.auth,
      payload: { reason: 'бланк испорчен при печати' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const res = await commandCrew(scene.requestId, {
      ...stale,
      // Версию человек перечитал бы карточкой — и всё равно получил бы 409: предмет отказа не она.
      version: await versionOf(scene.requestId),
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('assignment_preview_stale');

    // И ни одной записи: отказ стоит до журнала и до мутаций.
    const atStart = (await changesOf(scene.requestId)).filter(
      (c) => c.effective_date === TERM_FROM && c.dimension === 'driver',
    );
    expect(atStart).toHaveLength(1);
    expect(atStart[0]!.driver_person_id).toBe(ctx.personA);
    expect(await operationsOf(scene.requestId)).toEqual([]);

    // Контроль: та же команда с пересчитанным предпросмотром проходит — дело было в отпечатке, а не
    // в самой команде.
    const fresh = await commandCrew(
      scene.requestId,
      await armedCrew(scene.requestId, { ...body, version: await versionOf(scene.requestId) }),
    );
    expect(fresh.statusCode, fresh.body).toBe(200);
  }, 60_000);

  // ── 3. Команда истории против ручной выписки ЭСМ-2 ──

  /*
   * ПОЧЕМУ КОМАНДА ИСТОРИИ ЗДЕСЬ ИЗОБРАЖЕНА СЫРЫМ SQL, А НЕ ВЗЯТА БОЕВОЙ РУЧКОЙ. Ручная выписка
   * живёт только у **линейного** заказа (`onDemandRefusal`, ADR 0100 §6), а обе боевые двери
   * истории линейный заказ отвергают до всякой работы (Р14: «у линейного заказа машиниста называют
   * при выписке листа»). То есть заявки, где обе двери работают одновременно, не существует по
   * предметному правилу, и настоящая встреча этих двух дверей возможна ровно в том виде, в каком
   * она изображена: канонический порядок захвата на соседнем соединении — `control FOR SHARE →
   * request FOR UPDATE` — плюс инкремент версии, который любая команда истории делает шагом 14.
   *
   * Тем же приёмом доказан клинч подэтапа 2a (Ю29), и он же даёт здесь больше, чем очередь: держатель
   * двигает версию, и проверяется не только «выписка дождалась», но и «дождавшись, она не выписала
   * бланк по устаревшему состоянию».
   */
  it('ручная выписка ЭСМ-2 ждёт команду истории и получает 409 по версии, не сжигая номер', async () => {
    // Начало срока подобрано (`ESM2_TERM_FROM`): выписка обязана прийти сюда обычной дверью, а в
    // дни месячного разреза срок от прошлого понедельника делал бы её операцией заднего числа.
    const scene = await seedScene({ linear: true, term: { from: ESM2_TERM_FROM, to: TODAY } });
    const payload = {
      weekOf: TODAY,
      vehicleId: ctx.vehicleA.id,
      driverPersonId: ctx.personA,
    };
    const fingerprint = await ackFingerprintOf(scene.requestId, payload);
    const before = await sheetsOf(scene.requestId);

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let res: Reply;
    try {
      const pid = await backendPid(holder);
      const inFlight = issueEsm2(scene.requestId, {
        ...payload,
        version: scene.version,
        ...(fingerprint ? { acknowledge: { fingerprint } } : {}),
      });
      const [waiting] = await waitForWaiters(probe, pid, 1);
      // Ждёт именно строку заявки, а не лист и не серию: «заявка первой» (план Л3, подэтап 2a).
      expect(waiting).toMatch(/vehicle_requests/);
      expect(waiting!.toLowerCase()).toContain('for update');

      // Команда истории свободно берёт всё, что ниже заявки, — выписка до этих строк ещё не дошла и
      // дойти не могла. Держи она хоть одну из них, встречный захват дал бы клинч.
      await holder.query('SELECT 1 FROM waybills WHERE source_request_id = $1 FOR UPDATE', [
        scene.requestId,
      ]);
      // Шаг 14 канона: версия поднимается любой успешной командой истории.
      await holder.query(
        'UPDATE vehicle_requests SET version = version + 1, updated_at = now() WHERE id = $1',
        [scene.requestId],
      );
      await holder.query('COMMIT');
      res = await inFlight;
    } finally {
      await holder.end();
      await probe.end();
    }

    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('version_conflict');
    // Номер строгой отчётности не израсходован: отказ откатывает выписку целиком.
    expect(await sheetsOf(scene.requestId)).toHaveLength(before.length);
  }, 60_000);

  /**
   * Контроль к предыдущему случаю: тот же сюжет, но держатель версию **не трогает** — и выписка,
   * дождавшись строки заявки, доводит работу до конца.
   *
   * Без него зелёный выше объяснялся бы чем угодно — от закрытой двери до сломанной сцены: 409
   * получить легко, а вот отличить «отказала из-за гонки» от «не работает вовсе» можно только
   * встречным случаем.
   */
  it('контроль: тот же сюжет без правки версии — выписка дожидается и выписывает лист', async () => {
    // Срок — тот же подобранный, что и у случая выше: контроль обязан отличаться от него ровно
    // одним, правкой версии, и вторая разница обесценила бы обоих.
    const scene = await seedScene({ linear: true, term: { from: ESM2_TERM_FROM, to: TODAY } });
    const payload = {
      weekOf: TODAY,
      vehicleId: ctx.vehicleA.id,
      driverPersonId: ctx.personA,
    };
    const fingerprint = await ackFingerprintOf(scene.requestId, payload);

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let res: Reply;
    try {
      const pid = await backendPid(holder);
      const inFlight = issueEsm2(scene.requestId, {
        ...payload,
        version: scene.version,
        ...(fingerprint ? { acknowledge: { fingerprint } } : {}),
      });
      await waitForWaiters(probe, pid, 1);
      await holder.query('COMMIT');
      res = await inFlight;
    } finally {
      await holder.end();
      await probe.end();
    }

    expect(res.statusCode, res.body).toBe(200);
    expect(await sheetsOf(scene.requestId)).toHaveLength(1);
    expect(await versionOf(scene.requestId)).toBe(scene.version + 1);
  }, 60_000);

  // ── 4. Команда истории против ручек смен ──

  /**
   * Порядок `режим → заявка → смена` переведён подэтапом 2a у всех четырёх ручек смен (Ю28), и
   * здесь проверяется, что он **держит** — причём в той своей части, ради которой и переводился.
   *
   * Сцена: день `PREV` подписан объектом, и сохранение смены такой день не переписывает (422).
   * Коррекция истории снимает подписи своего диапазона (Р11) — значит после неё тот же запрос
   * законен. Обе двери стартуют из очереди за строкой заявки, коррекция впереди.
   *
   * Ответ `200` доказывает сразу две вещи: клинча не случилось (иначе одна из транзакций получила бы
   * `40P01`), и решение «день не подписан» принято **под той же блокировкой**, под которой пишется.
   * Прежняя ручка читала смену до транзакции и ответила бы 422 по состоянию, которого уже нет, —
   * именно эта щель и названа Ю28 главной.
   */
  it('сохранение смены ждёт коррекцию истории и видит снятую ею подпись', async () => {
    const scene = await seedScene({ vehicleSplit: true, approvals: true, term: CORRECTION_TERM });
    const armedCorrection = await armedCorrectionOf(scene);

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let corrected: Reply;
    let saved: Reply;
    try {
      const pid = await backendPid(holder);
      // Очередь строится по одному: Postgres выдаёт исключительную блокировку в порядке прихода, и
      // «коррекция первой» здесь не пожелание, а установленный порядок.
      const correctionInFlight = commandCorrection(scene.requestId, armedCorrection);
      await waitForWaiters(probe, pid, 1);
      const shiftInFlight = saveShift(scene.requestId, PREV, 9);
      await waitForWaiters(probe, pid, 2);
      await holder.query('COMMIT');
      [corrected, saved] = await Promise.all([correctionInFlight, shiftInFlight]);
    } finally {
      await holder.end();
      await probe.end();
    }

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect((json(corrected).clearedApprovals as string[]).sort()).toEqual(
      [PREV, shiftDateKey(MONDAY, -1)].sort(),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const [shift] = (
      await ctx.db.execute<{ machine_hours: string; approved_at: string | null }>(sql`
        SELECT machine_hours, approved_at FROM vehicle_request_shifts
         WHERE request_id = ${scene.requestId} AND shift_date = ${PREV}`)
    ).rows;
    expect(Number(shift!.machine_hours)).toBe(9);
    expect(shift!.approved_at).toBeNull();
  }, 60_000);

  /**
   * Контроль к предыдущему случаю — тот, который **обязан** упасть на сохранении: без коррекции
   * подпись на месте, и ручка отвечает 422. Без него зелёный выше не значил бы ничего: 200 на
   * неподписанном дне не доказывает, что подпись вообще была.
   */
  it('контроль: то же сохранение без коррекции — 422 «согласована»', async () => {
    const scene = await seedScene({ vehicleSplit: true, approvals: true, term: CORRECTION_TERM });
    const res = await saveShift(scene.requestId, PREV, 9);
    expect(res.statusCode, res.body).toBe(422);
    expect(json(res).message).toMatch(/согласована/);
  }, 60_000);

  /**
   * Вторая ручка смен той же парой — **подпись**, и разбирается она тем же вопросом: под какой
   * блокировкой принято решение.
   *
   * Сцена: день подписан, коррекция подпись снимает. Запрос «подтвердить» на подписанном дне —
   * пустое действие: ручка отвечает 200, но ничего не пишет и события не заводит. На дне, с
   * которого подпись только что сняли, тот же запрос — настоящая работа, и событие появляется.
   * Событие журнала здесь и есть различитель: по нему видно, какое состояние ручка увидела.
   *
   * Прежний порядок (чтение смены до транзакции) дал бы «уже подписан» — то есть тишину вместо
   * подписи, и объект остался бы с непринятым днём, не узнав об этом.
   */
  it('подпись дня ждёт коррекцию истории и подписывает день, с которого та сняла подпись', async () => {
    const scene = await seedScene({ vehicleSplit: true, approvals: true, term: CORRECTION_TERM });
    const armedCorrection = await armedCorrectionOf(scene);

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let corrected: Reply;
    let approved: Reply;
    try {
      const pid = await backendPid(holder);
      const correctionInFlight = commandCorrection(scene.requestId, armedCorrection);
      await waitForWaiters(probe, pid, 1);
      const approvalInFlight = approveShift(scene.requestId, PREV, true);
      await waitForWaiters(probe, pid, 2);
      await holder.query('COMMIT');
      [corrected, approved] = await Promise.all([correctionInFlight, approvalInFlight]);
    } finally {
      await holder.end();
      await probe.end();
    }

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(approved.statusCode, approved.body).toBe(200);
    // Подпись легла заново — значит ручка увидела состояние **после** коррекции.
    const [shift] = (
      await ctx.db.execute<{ approved_at: string | null }>(sql`
        SELECT approved_at FROM vehicle_request_shifts
         WHERE request_id = ${scene.requestId} AND shift_date = ${PREV}`)
    ).rows;
    expect(shift!.approved_at).not.toBeNull();
    expect(await shiftApprovalEvents(scene.requestId)).toEqual(['vehicle_request.shift_approve']);
  }, 60_000);

  /**
   * Контроль к подписи — тот, который **обязан** остаться тихим: без коррекции день уже подписан,
   * и повторное нажатие журнал не пополняет. Без него зелёный выше объяснялся бы тем, что событие
   * пишется на всякий запрос.
   */
  it('контроль: та же подпись без коррекции — тихий 200 и ни одного события', async () => {
    const scene = await seedScene({ vehicleSplit: true, approvals: true, term: CORRECTION_TERM });
    const res = await approveShift(scene.requestId, PREV, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await shiftApprovalEvents(scene.requestId)).toEqual([]);
  }, 60_000);

  /**
   * Контрольный клинч — второй подпорок той же пары дверей и прямое наследие Ю29.
   *
   * Прежний порядок изображён сырым SQL: ручка смены правит смену и только потом трогает заявку
   * (именно это делала бы сборка до подэтапа 2a), а команда истории идёт каноном. Ожидание
   * встречное, и Postgres обязан разорвать одну из транзакций.
   *
   * Случай нужен ровно затем, чтобы предыдущий что-то стоил: он показывает, что клинч **в этой
   * сцене достижим**, и зелёный выше — свойство порядка, а не удачи. Предел ожидания больше
   * `deadlock_timeout` (по умолчанию секунда): иначе первым сработал бы он, и вместо клинча тест
   * увидел бы обычный таймаут.
   */
  it('контрольный клинч: встречный порядок «смена → заявка» даёт 40P01', async () => {
    const scene = await seedScene({ vehicleSplit: true, approvals: true, term: CORRECTION_TERM });
    const oldDoor = new pg.Client({ connectionString: RAW_DB_URL });
    const history = new pg.Client({ connectionString: RAW_DB_URL });
    await oldDoor.connect();
    await history.connect();
    const probe = await openProbe();
    try {
      await oldDoor.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await history.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await oldDoor.query('BEGIN');
      await history.query('BEGIN');

      // Старая дверь: сначала смена.
      await oldDoor.query(
        `UPDATE vehicle_request_shifts SET updated_at = now()
          WHERE request_id = $1 AND shift_date = $2`,
        [scene.requestId, PREV],
      );
      // Команда истории: сначала заявка.
      await history.query('SELECT 1 FROM vehicle_requests WHERE id = $1 FOR UPDATE', [
        scene.requestId,
      ]);

      const oldWaits = oldDoor.query(
        'UPDATE vehicle_requests SET assignment_history_dirty = true WHERE id = $1',
        [scene.requestId],
      );
      await waitForWaiters(probe, await backendPid(history), 1);

      // Команда истории идёт за сменой — кольцо замкнулось.
      const historyWaits = history.query(
        `UPDATE vehicle_request_shifts SET updated_at = now()
          WHERE request_id = $1 AND shift_date = $2`,
        [scene.requestId, PREV],
      );

      const outcome = await Promise.allSettled([oldWaits, historyWaits]);
      const codes = outcome
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as { code?: string }).code);
      expect(codes).toContain('40P01');
    } finally {
      await oldDoor.query('ROLLBACK').catch(() => undefined);
      await history.query('ROLLBACK').catch(() => undefined);
      await oldDoor.end();
      await history.end();
      await probe.end();
    }
  }, 60_000);

  // ── 5. Повтор по одному ключу операции из двух соединений ──

  /**
   * Оба запроса приходят с одним `operationId` и одинаковым телом — так выглядит клиент, повторивший
   * запрос после потерянного ответа, и так же выглядят две вкладки одного человека.
   *
   * Проверяется порядок Р9: под блокировкой первым делом идёт **повторный** `findCorrection`, и он
   * стоит **до** сверки версии. Иначе второй запрос, дождавшись строки заявки, получил бы 409 по
   * версии (её поднял первый) или, начав планирование, упёрся бы в погашенную цель — 422 вместо
   * прежнего результата.
   *
   * Работа при этом обязана быть сделана ровно один раз: одна строка журнала, одна замена в истории,
   * один шаг версии — и ни одного лишнего бланка.
   */
  it('повтор по одному operationId из двух соединений: работа одна, строка журнала одна', async () => {
    const scene = await seedScene({ issueSheets: true });
    const operationId = randomUUID();
    const body = await armedCrew(
      scene.requestId,
      {
        kind: 'set',
        dimension: 'driver',
        effectiveDate: TERM_FROM,
        driverPersonId: ctx.personB,
        version: scene.version,
      },
      operationId,
    );
    // Ключ операции обязан оказаться в теле: без него случай проверял бы не то, ради чего написан.
    expect(body.operation, JSON.stringify(body)).toBeDefined();
    const sheetsBefore = await sheetsOf(scene.requestId);

    const holder = await openHolder(scene.requestId);
    const probe = await openProbe();
    let replies: Reply[];
    try {
      const pid = await backendPid(holder);
      const first = commandCrew(scene.requestId, body);
      const second = commandCrew(scene.requestId, body);
      await waitForWaiters(probe, pid, 2);
      await holder.query('COMMIT');
      replies = await Promise.all([first, second]);
    } finally {
      await holder.end();
      await probe.end();
    }

    for (const res of replies) expect(res.statusCode, res.body).toBe(200);
    const repeated = replies.map((r) => json(r).repeated as boolean);
    expect(repeated.filter(Boolean), replies.map((r) => r.body).join(' | ')).toHaveLength(1);
    expect(repeated.filter((r) => !r)).toHaveLength(1);

    const operations = await operationsOf(scene.requestId);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.operation_id).toBe(operationId);
    expect(operations[0]!.kind).toBe('crew');

    const atStart = (await changesOf(scene.requestId)).filter(
      (c) => c.effective_date === TERM_FROM && c.dimension === 'driver',
    );
    expect(atStart).toHaveLength(1);
    expect(atStart[0]!.driver_person_id).toBe(ctx.personB);
    // Бумага переоформлена один раз: столько же действующих листов, сколько было, и ни одним больше.
    expect(await sheetsOf(scene.requestId)).toHaveLength(sheetsBefore.length);
    // Повтор версию не поднимает (Р9): работы второй раз не происходит.
    expect(await versionOf(scene.requestId)).toBe(scene.version + 1);
  }, 60_000);

  /**
   * Контроль к предыдущему случаю: тот же ключ с **другим** телом — 409 `CORRECTION_KEY_REUSED`.
   *
   * Он показывает, что ветка повтора не «отдаёт прежний результат всякому, кто прислал знакомый
   * ключ», а сверяет отпечаток тела (Р9): без этого зелёный выше означал бы всего лишь, что второй
   * запрос чем-то ответил.
   */
  it('контроль: тот же ключ с другим телом — 409 CORRECTION_KEY_REUSED', async () => {
    const scene = await seedScene({ issueSheets: true });
    const operationId = randomUUID();
    const first = await commandCrew(
      scene.requestId,
      await armedCrew(
        scene.requestId,
        {
          kind: 'set',
          dimension: 'driver',
          effectiveDate: TERM_FROM,
          driverPersonId: ctx.personB,
          version: scene.version,
        },
        operationId,
      ),
    );
    expect(first.statusCode, first.body).toBe(200);

    const second = await commandCrew(scene.requestId, {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: TERM_FROM,
      // Другой человек — другая команда: ключ тот же, предмет иной.
      driverPersonId: ctx.personC,
      version: await versionOf(scene.requestId),
      previewFingerprint: 'x'.repeat(64),
      // Причина та же, что у первой команды: отличается только предмет — и отказ обязан быть о нём.
      operation: { operationId, reason: 'на этой неделе на объект выходит другой машинист' },
    });
    expect(second.statusCode, second.body).toBe(409);
    // Общий журнал отвечает словами, а не своим кодом (`err.conflict(CORRECTION_KEY_REUSED)`):
    // проверяется поэтому текст — тот самый, которым портал объясняет занятый ключ.
    expect(json(second).message).toMatch(/Ключ операции уже занят другой командой/);
  }, 60_000);
});
