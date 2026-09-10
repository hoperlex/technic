import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { esm2Periods, moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as Shadow from '../src/services/assignment-shadow';
import type * as Esm2 from '../src/services/waybill-esm2';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, И ОН ЗАВОДИТ ЕЁ САМ. Поколение сравнения строится по **всей популяции**
 * заявок базы, и `expected_checks` считается по ней же: чужие заказы соседнего файла попали бы в
 * manifest и сделали бы исход прогона зависимым от порядка файлов.
 *
 * Требование это раньше стояло одними словами — адрес чистой базы полагалось подать снаружи, — и
 * держалось ровно до первого запуска по общей `technic_archive_test`: на ней `checked` приходил
 * равным числу чужих заказов (294 вместо 1), и восемь случаев из десяти падали, ничего не сообщая
 * о самом контуре. Теперь база заводится, мигрируется с нуля и сносится в `afterAll` — тем же
 * приёмом, что у соседей (образец — `service-request-without-equipment.db.test.ts`), и подать
 * не ту базу больше нельзя.
 *
 * Поимённая уборка между случаями остаётся и после этого: своя база пуста ОДИН раз, а популяцию
 * считает каждый случай, и заказы предыдущего вошли бы в manifest следующего. Откатом транзакции
 * этого не сделать — сервис открывает свои и внутри чужой их не увидит.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл проверяет **сам контур сравнения**, который работает только до переключения
 * чтения: он сличает недельный план с отрезковым и доказывает, что переключение не сдвинет ни
 * листа. Обёртка двух режимов здесь бессмысленна дважды — прогон сравнения в `history` не имеет
 * предмета (legacy-проекции уже нет), а расхождение `week_split`, которое сегодня и есть сигнал,
 * после этапа 5 становится **боевым планом**, то есть перестаёт быть расхождением вовсе.
 *
 * Поэтому файл закрыт с `readModeIrrelevant`. Судьба самого контура решается на этапе 5 вместе с
 * §10 плана: либо он снимается как отработавший, либо остаётся для обратной сверки — и тогда его
 * ожидания переписываются целиком, а не половинами.
 */

/**
 * Теневое сравнение планов бумаги
 * ([assignment-shadow.ts](../src/services/assignment-shadow.ts); план
 * `docs/assignment-periods-plan.md`, этап 4, решения З2, З4, К1, К2, Л2, Е1).
 *
 * ПРЕДМЕТ. Не «сходятся ли два алгоритма» — это вопрос к самим алгоритмам, — а **годится ли
 * поколение в доказательство**. Поколение, объявившее себя завершённым с наполовину построенным
 * манифестом, зелёное поколение с неразобранными целями и расхождение, о котором нельзя сказать
 * почему, — три способа получить cutover без основания, и все три обязаны быть невозможны.
 *
 * ЗАЧЕМ БАЗА. Сцепка здесь ровно та, которой нет в памяти: manifest с его составным первичным
 * ключом и `CHECK`-ом на согласованность статуса с результатом (миграция `0167`), выписанные листы
 * ЭСМ-2 с расходом номеров, строки истории с их частичными UNIQUE (`0166`) и оба боевых расчёта,
 * читающих всё это своими запросами. Ни одну из четырёх не подменить объектом — а подмени, и
 * проверялась бы копия.
 *
 * ПОЧЕМУ СРОК В БУДУЩЕМ. Обе стороны отделяют отработанное от предстоящего по дню расчёта, и срок,
 * задевающий сегодняшний день, менял бы смысл случаев в зависимости от дня недели. Заказы сцены
 * стоят на следующей неделе целиком: бумага там ещё аннулируема, а листы ещё выписываются.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-shadow.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_assignment_shadow_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

/** Хвост прогона: учётка и человек живут дольше случая, а email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

/** Сборка сцены: своя, ни на что в репозитории не похожая. */
const BUILD = `build-${RUN}`;

// ── Календарь сцены ──

const TODAY = moscowDateKeyOf(new Date());
/** Следующий понедельник: весь срок сцены лежит впереди, и бумага ещё аннулируема. */
const NEXT_MONDAY = shiftDateKey(weekStartKey(TODAY), 7);
const NEXT_SUNDAY = shiftDateKey(NEXT_MONDAY, 6);
/** Среда следующей недели — ею режется неделя надвое (Б1). */
const NEXT_WEDNESDAY = shiftDateKey(NEXT_MONDAY, 2);
/**
 * Периоды бумаги срока сцены — тем же расчётом, каким режет портал (`esm2Periods`).
 *
 * Их два, если в середине недели кончается месяц (ADR 0142): бумага сцены — не «лист недели», а
 * столько документов, сколько дал разрез. Числа, записанные цифрой, краснели бы раз в месяц.
 */
const TERM_PERIODS = esm2Periods(NEXT_MONDAY, NEXT_SUNDAY);
/** Отработанная неделя: срок кончился, и бумаги ни одна сторона уже не заводит. */
const PAST_MONDAY = shiftDateKey(weekStartKey(TODAY), -14);
const PAST_SUNDAY = shiftDateKey(PAST_MONDAY, 6);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  shadow: typeof Shadow;
  esm2: typeof Esm2;
  userId: string;
  objectId: string;
  vehicleOwn: string;
  vehicleTypeId: string;
  personA: string;
  personB: string;
}

let ctx: Ctx;

/** Что случай завёл — это же он и уберёт: чужого в базе нет, но и своего оставлять нельзя. */
const createdRequests: string[] = [];
const createdRuns: string[] = [];

beforeAll(async () => {
  if (!DB_URL || !OWN_DB || !ADMIN_DB) return;
  process.env.DATABASE_URL = OWN_DB;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';

  // База своя и с нуля: заводится до всякого импорта клиента — конфиг читает `DATABASE_URL` при
  // импорте, и подключаться ему уже некуда, если базы ещё нет.
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: OWN_DB });
  await client.connect();
  try {
    // Расширения ставит ops до миграций (drizzle.config.ts, §8) — своей базе их ставит тест.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
  const { db, closeDb } = await import('../src/db/client');
  const shadow = await import('../src/services/assignment-shadow');
  const esm2 = await import('../src/services/waybill-esm2');

  const one = async <T extends object>(q: Parameters<typeof db.execute>[0]): Promise<T> => {
    const [row] = (await db.execute<T>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  const obj = await one<{ id: string }>(sql`SELECT id FROM construction_objects LIMIT 1`);
  const vehicle = await one<{ id: string; vehicle_type_id: string }>(sql`
    SELECT id, vehicle_type_id FROM vehicles
     WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 1`);
  const user = await one<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
    VALUES (${`ap-shadow-${RUN}@example.invalid`}, 'Теневой', 'Пров', 'x', 'admin', false)
    RETURNING id`);
  const spec = await one<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`);
  // Специализация водителя — реализм сцены: листу она не нужна (ADR 0164), а водителем справочника
  // человек числится ею.
  const makePerson = async (last: string): Promise<string> => {
    const person = await one<{ id: string }>(
      sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`,
    );
    await db.execute(sql`
      INSERT INTO person_specializations (person_id, specialization_id, started_on)
      VALUES (${person.id}, ${spec.id}, ${shiftDateKey(TODAY, -400)})`);
    return person.id;
  };

  ctx = {
    db,
    closeDb,
    shadow,
    esm2,
    userId: user.id,
    objectId: obj.id,
    vehicleOwn: vehicle.id,
    vehicleTypeId: vehicle.vehicle_type_id,
    personA: await makePerson('Первый'),
    personB: await makePerson('Второй'),
  };
}, 180_000);

afterEach(async () => {
  if (!ctx) return;
  for (const runId of createdRuns.splice(0)) {
    await ctx.db.execute(sql`DELETE FROM assignment_shadow_runs WHERE run_id = ${runId}`);
  }
  for (const requestId of createdRequests.splice(0)) {
    await ctx.db.execute(sql`
      DELETE FROM waybill_requests WHERE waybill_id IN
        (SELECT id FROM waybills WHERE source_request_id = ${requestId})`);
    await ctx.db.execute(sql`DELETE FROM waybills WHERE source_request_id = ${requestId}`);
    await ctx.db.execute(
      sql`DELETE FROM vehicle_request_assignment_changes WHERE request_id = ${requestId}`,
    );
    await ctx.db.execute(
      sql`DELETE FROM vehicle_request_assignments WHERE request_id = ${requestId}`,
    );
    await ctx.db.execute(
      sql`DELETE FROM special_equipment_request_details WHERE request_id = ${requestId}`,
    );
    await ctx.db.execute(sql`DELETE FROM request_status_history WHERE request_id = ${requestId}`);
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ${requestId}`);
  }
});

afterAll(async () => {
  // База своя — уносим её целиком: оставленная помешала бы следующему прогону завести её заново.
  await ctx?.closeDb();
  if (!ADMIN_DB) return;
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
  } finally {
    await admin.end();
  }
}, 60_000);

// ── Сцена ──

interface SceneOptions {
  /** Что знает история о машинисте с начала срока. */
  driver?: 'named' | 'unknown';
  /** Выписать бумагу на весь срок расчётом от начала срока. */
  paper?: boolean;
  /** Смена машиниста в среду: разрез недели надвое (Б1). */
  midWeekChange?: boolean;
  status?: 'new' | 'confirmed' | 'done' | 'cancelled';
  /** Срок в прошлом: бумаги на него уже не выписывают — обе стороны молчат по-настоящему пусто. */
  past?: boolean;
  /** Линейный заказ: бумагу неделями он не ведёт вовсе (ADR 0100) — в популяцию не входит. */
  linear?: boolean;
}

/** Заказ спецтехники следующей недели: собственная машина, история и (по просьбе) бумага. */
async function makeRequest(options: SceneOptions = {}): Promise<string> {
  const status = options.status ?? 'confirmed';
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                    is_linear_frozen, linear_frozen_at, assignment_history_state,
                                    assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleTypeId}, ${status}, ${ctx.userId},
              ${options.linear ? true : null}, ${options.linear ? sql`now()` : null},
              'materialized', ${TODAY})
      RETURNING id`)
  ).rows;
  const requestId = row!.id;
  createdRequests.push(requestId);

  const termFrom = options.past ? PAST_MONDAY : NEXT_MONDAY;
  const termTo = options.past ? PAST_SUNDAY : NEXT_SUNDAY;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${termFrom}, ${termTo})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleOwn}, ${ctx.vehicleTypeId}, ${ctx.vehicleTypeId},
            ${ctx.userId})`);

  // История, какой её оставил бы бэкфилл: машина с начала срока и то, что известно о человеке.
  await insertChange(requestId, {
    effectiveDate: termFrom,
    dimension: 'vehicle',
    vehicleId: ctx.vehicleOwn,
    origin: 'assignment',
  });
  await insertChange(requestId, {
    effectiveDate: termFrom,
    dimension: 'driver',
    ...(options.driver === 'unknown'
      ? { driverState: 'unknown', origin: 'backfill' }
      : { driverState: 'set', driverPersonId: ctx.personA, origin: 'assignment' }),
  });

  if (options.paper) {
    await ctx.db.transaction(async (tx) =>
      ctx.esm2.syncEsm2Waybills(tx, {
        requestId,
        actor: { id: ctx.userId },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: ctx.personA,
        asOf: termFrom,
      }),
    );
  }

  // Смена машиниста в среду ставится ПОСЛЕ выписки: бумага сцены — та, что выписал сегодняшний
  // портал, а история — та, что появится после разреза. В этом и состоит расхождение Б1.
  if (options.midWeekChange) {
    await insertChange(requestId, {
      effectiveDate: NEXT_WEDNESDAY,
      dimension: 'driver',
      driverState: 'set',
      driverPersonId: ctx.personB,
      origin: 'machinist_change',
    });
  }
  return requestId;
}

async function insertChange(
  requestId: string,
  row: {
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverPersonId?: string;
    driverState?: string;
    origin: string;
  },
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${randomUUID()})`);
}

/**
 * Лист ЭСМ-2 **по просьбе**: у линейного заказа недели называет человек, а не срок (ADR 0100 §5).
 *
 * Дверь зовётся прямо, а не через `issueRequestEsm2`: приложения этот файл не поднимает вовсе — ни
 * одна его проверка не ходит по HTTP, — а рукопожатие выписки (Р21а) стоит в общей точке выпуска
 * номера и спрашивается с человека независимо от двери. Здесь повторён ровно тот ход, который
 * делает окно портала: первый вызов без подтверждения, отказ со свежим отпечатком, второй с ним.
 * У машиниста сцены комплект документов пуст, так что отказ этот приходит всегда.
 *
 * Возвращает выписанные листы: их бывает два, если неделю режет конец месяца (ADR 0142).
 */
async function issueOnDemand(requestId: string, weekOf: string): Promise<Esm2.IssuedEsm2[]> {
  const guardedPeriods = await ctx.esm2.esm2OnDemandPeriods(ctx.db, { requestId, weekOf });
  const issue = async (acknowledge: { fingerprint: string } | null): Promise<Esm2.IssuedEsm2[]> =>
    ctx.db.transaction(async (tx) =>
      ctx.esm2.issueEsm2OnDemand(tx, {
        requestId,
        weekOf,
        vehicleId: ctx.vehicleOwn,
        driverPersonId: ctx.personA,
        actor: { id: ctx.userId },
        guardedPeriods,
        acknowledge,
      }),
    );
  try {
    return await issue(null);
  } catch (error) {
    const fingerprint = (error as { details?: { fingerprint?: string } }).details?.fingerprint;
    if (!fingerprint) throw error;
    return issue({ fingerprint });
  }
}

/**
 * Посчитать одну цель, не заводя поколения, — второй вход сравнения (разбор одной заявки).
 *
 * Транзакция общая на оба расчёта и `read only`, как её открывает боевой прогон: сравнение,
 * посчитанное по двум разным снимкам базы, доказывало бы не расхождение алгоритмов, а чужую
 * правку между чтениями.
 */
async function evaluateOne(requestId: string): Promise<Shadow.ShadowCheckOutcome> {
  return ctx.db.transaction(
    async (tx) => ctx.shadow.evaluateShadowTarget(tx, { requestId, asOf: TODAY }),
    { accessMode: 'read only' },
  );
}

/** Завести поколение, построить и запечатать манифест — то, что делает команда `start`. */
async function startRun(asOf?: string): Promise<Shadow.ShadowRunHeader> {
  const opened = await ctx.shadow.openShadowRun(ctx.db, {
    buildVersion: BUILD,
    ...(asOf ? { asOf } : {}),
  });
  createdRuns.push(opened.runId);
  await ctx.shadow.buildShadowManifest(ctx.db, { runId: opened.runId });
  return ctx.shadow.sealShadowRun(ctx.db, opened.runId);
}

interface CheckRow {
  status: string;
  evaluation_fingerprint: string | null;
  details: Record<string, unknown> | null;
}

async function checkOf(runId: string, requestId: string): Promise<CheckRow | undefined> {
  return (
    await ctx.db.execute<CheckRow>(sql`
      SELECT status, evaluation_fingerprint, details FROM assignment_shadow_checks
       WHERE run_id = ${runId} AND request_id = ${requestId}`)
  ).rows[0];
}

/** Отказ сервиса: он обязан быть `AppError` с внятным текстом, а не «что-то упало». */
async function refused(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('операция прошла, хотя должна была быть отклонена');
}

describe.skipIf(!DB_URL)('теневое сравнение: поколение как доказательство', () => {
  it('полный жизненный цикл: заявка с согласованной бумагой доводит поколение до completed', async () => {
    const requestId = await makeRequest({ paper: true });

    const sealed = await startRun();
    expect(sealed.status).toBe('running');
    expect(sealed.expectedChecks).toBe(1);
    expect(sealed.algoVersion).toBe('1');
    expect(sealed.asOf).toBe(TODAY);

    const before = await checkOf(sealed.runId, requestId);
    // Строка цели заведена ЗАРАНЕЕ и пуста: manifest, а не журнал (К1).
    expect(before).toMatchObject({
      status: 'pending',
      evaluation_fingerprint: null,
      details: null,
    });

    const progress = await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId });
    expect(progress).toMatchObject({ checked: 1, matched: 1, mismatched: 0, remaining: 0 });
    expect(progress.failures).toEqual([]);

    const after = await checkOf(sealed.runId, requestId);
    expect(after?.status).toBe('match');
    // Отпечаток вычисления обязателен даже у совпадения: им повтор узнаёт свою работу (К2).
    expect(after?.evaluation_fingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const { header, tally } = await ctx.shadow.finalizeShadowRun(ctx.db, sealed.runId);
    expect(header.status).toBe('completed');
    expect(header.finishedAt).not.toBeNull();
    expect(tally).toEqual({ total: 1, pending: 0, match: 1, mismatch: 0 });
  });

  it('обе стороны правят один лист до одного дня — расхождения нет, но и молчанием это не считается', async () => {
    /*
     * Правка периода (`trim`, Р5 и Р6 плана `vehicle-request-actual-end-date-plan.md`) — третий
     * исход сверки рядом с «сжечь» и «выписать»: заказ закрыли фактической датой, хвост недели
     * работы не знал, и лист теряет дни с конца, не расходуя номера.
     *
     * Случай проверяет две вещи сразу, и обе про теневое сравнение, а не про планировщиков:
     *
     * 1. **правка проходит сличение**. Оба планировщика правят один лист до одного дня — значит
     *    совпадение. Совпадение это содержательное: разойдись стороны листом или днём, ключ
     *    сравнения разошёлся бы вместе с ними, потому что правки в него входят;
     * 2. **правка считается действием с бумагой**. `notes.actions` читает отчёт как «сторона бумагу
     *    двигает», и сторона, укорачивающая период действующего бланка, двигает её ровно так же,
     *    как аннулированием. Не считай мы правок, отчёт объявил бы «обе стороны подтвердили
     *    выписанную бумагу» там, где обе её меняют.
     *
     * День обрезки берётся внутри последнего **многодневного** документа срока: месячный разрез
     * (ADR 0142) делает последний документ иногда однодневным, а однодневный не укорачивается — он
     * целиком уходит в аннулирование. Недели из семи дней хватает всегда: как её ни разрежь
     * месяцем, один из кусков длиннее одного дня.
     */
    const requestId = await makeRequest({ paper: true });
    const shortened = [...TERM_PERIODS].reverse().find((period) => period.from < period.to)!;
    const newEnd = shiftDateKey(shortened.to, -1);
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details SET date_to = ${newEnd}
       WHERE request_id = ${requestId}`);

    // Сцена и правда про правку, а не про пару «аннулирование плюс выписка»: недельный
    // планировщик назван прямо, потому что вердикт сравнения без этого читался бы как угодно.
    const sheets = (
      await ctx.db.execute<{ id: string; period_from: string }>(sql`
        SELECT id, period_from FROM waybills
         WHERE source_request_id = ${requestId} AND status <> 'cancelled'
         ORDER BY period_from`)
    ).rows;
    const built = await ctx.esm2.buildEsm2SyncPlan(ctx.db, { requestId, asOf: TODAY });
    expect(built?.plan.trim).toEqual([
      { waybillId: sheets.find((row) => row.period_from === shortened.from)?.id, to: newEnd },
    ]);
    expect(built?.plan.issue).toEqual([]);
    // Документы за укороченным сроком гасятся как прежде: правка отнимает дни, а не недели.
    const burned = TERM_PERIODS.filter((period) => period.from > shortened.from).length;
    expect(built?.plan.cancel).toHaveLength(burned);

    const sealed = await startRun();
    const progress = await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId });
    expect(progress).toMatchObject({ checked: 1, matched: 1, mismatched: 0 });

    const details = (await checkOf(sealed.runId, requestId))?.details as Shadow.ShadowCheckDetails;
    expect(details.reason).toBeUndefined();
    // Действия обеих сторон посчитаны с правкой: она одна плюс сгоревшие документы срока.
    expect(details.notes.actions).toEqual({ legacy: burned + 1, fresh: burned + 1 });

    const notes = await ctx.shadow.shadowNoteTally(ctx.db, sealed.runId);
    expect(notes).toMatchObject({ paperTouched: 1, paperConfirmed: 0, paperAbsent: 0 });

    const { header } = await ctx.shadow.finalizeShadowRun(ctx.db, sealed.runId);
    expect(header.status).toBe('completed');
  });

  it('после печати состав целей не меняется: ни построитель, ни новая заявка в manifest не попадут', async () => {
    await makeRequest({ paper: true });
    const sealed = await startRun();
    expect(sealed.expectedChecks).toBe(1);

    const message = await refused(ctx.shadow.buildShadowManifest(ctx.db, { runId: sealed.runId }));
    expect(message).toMatch(/состав целей после печати не меняется/u);

    // Заявка, заведённая после печати, поколению неизвестна — и это не пропуск, а свойство
    // доказательства: оно описывает мир на момент печати, а не «всё, что было потом».
    const late = await makeRequest({ paper: true });
    expect(await checkOf(sealed.runId, late)).toBeUndefined();
    const tally = await ctx.shadow.shadowTally(ctx.db, sealed.runId);
    expect(tally.total).toBe(1);
  });

  it('печать не проходит, пока manifest построен не полностью (Л2)', async () => {
    const first = await makeRequest({ paper: true });
    await makeRequest({ paper: true });

    const opened = await ctx.shadow.openShadowRun(ctx.db, { buildVersion: BUILD });
    createdRuns.push(opened.runId);
    expect(opened.expectedChecks).toBe(2);
    await ctx.shadow.buildShadowManifest(ctx.db, { runId: opened.runId });

    // Ровно тот случай, ради которого печать и заведена: девяносто целей из ста, все сошлись.
    await ctx.db.execute(sql`
      DELETE FROM assignment_shadow_checks
       WHERE run_id = ${opened.runId} AND request_id = ${first}`);

    const message = await refused(ctx.shadow.sealShadowRun(ctx.db, opened.runId));
    expect(message).toMatch(/целей 1, объявлено 2/u);
    const header = await ctx.shadow.readShadowRun(ctx.db, opened.runId);
    expect(header?.status).toBe('building');
  });

  it('поколение с неразобранными целями не финализируется', async () => {
    await makeRequest({ paper: true });
    await makeRequest({ paper: true });
    const sealed = await startRun();

    const progress = await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId, limit: 1 });
    expect(progress.checked).toBe(1);
    expect(progress.remaining).toBe(1);

    const message = await refused(ctx.shadow.finalizeShadowRun(ctx.db, sealed.runId));
    expect(message).toMatch(/1 целей осталось непроверенными/u);
    expect((await ctx.shadow.readShadowRun(ctx.db, sealed.runId))?.status).toBe('running');
  });

  it('разрез недели виден в сводке с причиной, а поколение получает failed', async () => {
    const requestId = await makeRequest({ paper: true, midWeekChange: true });
    const sealed = await startRun();

    const progress = await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId });
    expect(progress).toMatchObject({ checked: 1, matched: 0, mismatched: 1 });

    const row = await checkOf(sealed.runId, requestId);
    expect(row?.status).toBe('mismatch');
    const details = row?.details as Shadow.ShadowCheckDetails;
    expect(details.reason).toBe('week_split');
    // Обе проекции целиком: разбор идёт по записанному, а не по пересчёту живых данных.
    expect(details.legacy).toEqual({ cancel: [], issue: [], trim: [] });
    /*
     * Переоформляется только та бумага, чей состав разошёлся: документ, кончившийся до среды
     * (а он появляется, когда месяц режет неделю, — ADR 0142), остаётся при своём человеке.
     * Внутри задетого периода разрез идёт по дате смены.
     */
    const touched = TERM_PERIODS.filter((period) => period.to >= NEXT_WEDNESDAY);
    expect(details.fresh?.cancel).toHaveLength(touched.length);
    expect(details.fresh?.issue.map((sheet) => [sheet.from, sheet.to])).toEqual(
      touched.flatMap((period) =>
        period.from < NEXT_WEDNESDAY
          ? [
              [period.from, shiftDateKey(NEXT_WEDNESDAY, -1)],
              [NEXT_WEDNESDAY, period.to],
            ]
          : [[period.from, period.to]],
      ),
    );

    const summary = await ctx.shadow.shadowMismatchSummary(ctx.db, sealed.runId);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ reason: 'week_split', count: 1 });
    expect(summary[0]?.words).toMatch(/другие документы/u);
    expect(summary[0]?.examples[0]?.requestId).toBe(requestId);

    const { header } = await ctx.shadow.finalizeShadowRun(ctx.db, sealed.runId);
    // Расхождение объяснено — но не прощено: переключение по такому поколению невозможно (Е1).
    expect(header.status).toBe('failed');
  });

  it('пробел машиниста называется своей причиной, а не «разными днями»', async () => {
    const requestId = await makeRequest({ driver: 'unknown' });
    const sealed = await startRun();
    await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId });

    const details = (await checkOf(sealed.runId, requestId))?.details as Shadow.ShadowCheckDetails;
    expect(details.reason).toBe('driver_unknown');
    // Недельная сторона выписала бы бумагу срока, не зная человека; отрезковая — не выписывает
    // вовсе (Р16, Р19).
    expect(details.legacy?.issue).toHaveLength(TERM_PERIODS.length);
    expect(details.fresh?.issue).toEqual([]);
    expect(details.notes.blockers?.[0]).toMatchObject({ kind: 'unknown', date: NEXT_MONDAY });
  });

  it('популяция — только заказы, чью бумагу ведёт портал', async () => {
    const governed = await makeRequest({ paper: true });
    const cancelled = await makeRequest({ status: 'cancelled' });
    const draft = await makeRequest({ status: 'new' });
    const linear = await makeRequest({ linear: true });

    const sealed = await startRun();
    expect(sealed.expectedChecks).toBe(1);
    expect(await checkOf(sealed.runId, governed)).toBeDefined();
    for (const outside of [cancelled, draft, linear]) {
      expect(await checkOf(sealed.runId, outside)).toBeUndefined();
    }
  });

  it('линейный заказ: обе стороны ведут выписанный по просьбе бланк — цель сходится', async () => {
    /*
     * ДЫРА В САМИХ ВОРОТАХ (Э10 плана `vehicle-request-actual-end-date-plan.md`). У линейного
     * заказа стороны расходились **по построению**: недельная ведёт выписанные по просьбе бланки
     * (`esm2RequestedPeriods`), а отрезковая звалась с пустыми ожиданиями — как у заявки, которой
     * бумаги не положено вовсе, — и гасила их все. Расхождение выходило при любых данных, то есть
     * не свидетельствовало ни о чём: настоящее утонуло бы в этом шуме.
     *
     * ПОЧЕМУ ЦЕЛЬ СЧИТАЕТСЯ НАПРЯМУЮ. Линейный заказ в популяцию не входит (случай выше), и
     * поколением его не посчитать. Но мимо популяции он в расчёт попадает — переключением режима
     * (ADR 0107) между печатью manifest'а и проверкой цели и разбором одной заявки, — а считаться
     * он обязан верно в любом из этих входов: сравнение спрашивает линейность у снимка, а не у
     * условия отбора.
     */
    const requestId = await makeRequest({ linear: true });
    const sheets = await issueOnDemand(requestId, NEXT_MONDAY);
    // Сцена не пуста: бланки на срок и правда выписаны, и гасить отрезковой стороне есть что.
    expect(sheets).toHaveLength(TERM_PERIODS.length);

    const outcome = await evaluateOne(requestId);
    expect(outcome.status).toBe('match');
    expect(outcome.details.reason).toBeUndefined();
    /*
     * Совпадение содержательное, а не «два пустых списка»: у заказа есть действующая бумага, и
     * обе стороны её подтвердили — отрезковой для этого пришлось сойтись с каждым листом по
     * границам, машине и человеку. Режимы записаны оба: `on_demand` с обеих сторон и есть
     * доказательство, что гейт бумаги спрошен одним вопросом.
     */
    expect(outcome.details.notes).toMatchObject({
      legacyMode: 'on_demand',
      freshMode: 'on_demand',
      actions: { legacy: 0, fresh: 0 },
      sheets: TERM_PERIODS.length,
    });
  });

  it('линейный заказ с сокращённым сроком: обе стороны правят один бланк до одного дня', async () => {
    /*
     * Обратная половина той же починки: сойтись стороны обязаны на **работе**, а не на молчании.
     * Ветка `on_demand`, отдающая пустой план, дала бы здесь ложное совпадение — «обе стороны
     * бумаги не трогают», — при том что бланк стоит по дни, которых у заказа больше нет.
     *
     * День обрезки — внутри последнего многодневного документа срока: месячный разрез (ADR 0142)
     * делает последний документ иногда однодневным, а однодневный не укорачивается — он целиком
     * уходит в аннулирование.
     */
    const requestId = await makeRequest({ linear: true });
    await issueOnDemand(requestId, NEXT_MONDAY);
    const shortened = [...TERM_PERIODS].reverse().find((period) => period.from < period.to)!;
    const newEnd = shiftDateKey(shortened.to, -1);
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details SET date_to = ${newEnd}
       WHERE request_id = ${requestId}`);

    // Недельная сторона названа прямо: без неё вердикт сравнения читался бы как угодно.
    const trimmed = (
      await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM waybills
         WHERE source_request_id = ${requestId} AND status <> 'cancelled'
           AND period_from = ${shortened.from}`)
    ).rows[0];
    const built = await ctx.esm2.buildEsm2SyncPlan(ctx.db, { requestId, asOf: TODAY });
    expect(built?.plan.trim).toEqual([{ waybillId: trimmed?.id, to: newEnd }]);
    // Новых недель линейному заказу не заводит ни одна сторона: их называет человек, а не срок.
    expect(built?.plan.issue).toEqual([]);
    const burned = TERM_PERIODS.filter((period) => period.from > shortened.from).length;
    expect(built?.plan.cancel).toHaveLength(burned);

    const outcome = await evaluateOne(requestId);
    /*
     * Совпадение здесь означает буквально «тот же лист до того же дня»: правка входит в ключ
     * сравнения (Э4), и разойдись стороны бланком или днём — цель разошлась бы вместе с ними
     * (`assignment-shadow-compare.test.ts` проверяет это самой парой планов).
     */
    expect(outcome.status).toBe('match');
    expect(outcome.details.notes.actions).toEqual({
      legacy: burned + 1,
      fresh: burned + 1,
    });
  });

  it('линейный заказ: настоящее расхождение сравнение по-прежнему видит', async () => {
    /*
     * Обратная проверка починки: ветка `on_demand` заведена, чтобы убрать шум, а не чтобы
     * объявлять линейные цели совпавшими. Сцена — сдвиг начала срока: переоформление здесь
     * неизбежно (правка умеет только отнимать дни с конца, а начало не двигает), и стороны
     * расходятся на выписке замены.
     *
     * Расходятся они машинистом, и это расхождение настоящее, а не артефакт сцены. У недельной
     * стороны «машиниста заявки» в режиме `on_demand` не существует вовсе (ADR 0100 §6): его
     * называют на каждую неделю отдельно, и в план он приходит только из самого действия —
     * `buildEsm2SyncPlan` отдаёт `null`. Отрезковая берёт человека **из самого бланка**, который
     * переоформляет. Кто прав — вопрос к планировщикам; дело ворот в том, чтобы такую цель было
     * видно, и после починки она видна с именем причины.
     */
    const requestId = await makeRequest({ linear: true });
    await issueOnDemand(requestId, NEXT_MONDAY);
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details SET date_from = ${NEXT_WEDNESDAY}
       WHERE request_id = ${requestId}`);

    const outcome = await evaluateOne(requestId);
    expect(outcome.status).toBe('mismatch');
    expect(outcome.details.reason).toBe('driver');
    // Оба режима `on_demand` — значит расходятся не гейты бумаги, а планы: гасят стороны один и
    // тот же бланк, а взамен выписывают документ на те же дни, но с разными людьми.
    expect(outcome.details.notes).toMatchObject({
      legacyMode: 'on_demand',
      freshMode: 'on_demand',
    });
    expect(outcome.details.diff?.cancelOnlyLegacy).toEqual([]);
    expect(outcome.details.diff?.cancelOnlyFresh).toEqual([]);
    expect(outcome.details.legacy?.issue[0]?.driverPersonId).toBeNull();
    expect(outcome.details.fresh?.issue[0]?.driverPersonId).toBe(ctx.personA);
  });

  it('прогон, переживший полночь, к целям не допускается (О3)', async () => {
    await makeRequest({ paper: true });
    const sealed = await startRun(shiftDateKey(TODAY, -1));

    const message = await refused(ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId }));
    expect(message).toMatch(/переживший полночь, начинается заново/u);
    // Ни одной строки поколение при этом не получило: вердикт о вчерашнем мире не записывается.
    expect((await ctx.shadow.shadowTally(ctx.db, sealed.runId)).pending).toBe(1);
  });

  it('отчёт различает подтверждённую бумагу и её отсутствие', async () => {
    const withPaper = await makeRequest({ paper: true });
    const idle = await makeRequest({ past: true });

    const sealed = await startRun();
    await ctx.shadow.runShadowChecks(ctx.db, { runId: sealed.runId });

    const confirmed = (await checkOf(sealed.runId, withPaper))
      ?.details as Shadow.ShadowCheckDetails;
    // Обе стороны молчат — но молчат о выписанной бумаге: отрезковой стороне пришлось сойтись с
    // каждым листом по границам, машине и человеку, иначе она бы его переоформила.
    expect(confirmed.notes).toMatchObject({
      actions: { legacy: 0, fresh: 0 },
      sheets: TERM_PERIODS.length,
    });

    const empty = (await checkOf(sealed.runId, idle))?.details as Shadow.ShadowCheckDetails;
    expect(empty.notes).toMatchObject({ actions: { legacy: 0, fresh: 0 }, sheets: 0 });

    // Отчёт обязан их различать: иначе «сошлись все» не отличить от «сравнили ничего с ничем».
    const notes = await ctx.shadow.shadowNoteTally(ctx.db, sealed.runId);
    expect(notes).toMatchObject({ paperConfirmed: 1, paperAbsent: 1, paperTouched: 0 });
  });

  it('незапечатанное поколение целей не считает и не финализируется', async () => {
    await makeRequest({ paper: true });
    const opened = await ctx.shadow.openShadowRun(ctx.db, { buildVersion: BUILD });
    createdRuns.push(opened.runId);
    await ctx.shadow.buildShadowManifest(ctx.db, { runId: opened.runId });

    expect(await refused(ctx.shadow.runShadowChecks(ctx.db, { runId: opened.runId }))).toMatch(
      /не работает \(building\)/u,
    );
    expect(await refused(ctx.shadow.finalizeShadowRun(ctx.db, opened.runId))).toMatch(
      /не работает \(building\)/u,
    );
  });
});
