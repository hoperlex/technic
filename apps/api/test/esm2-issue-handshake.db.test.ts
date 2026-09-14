import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AssignmentPreviewDto,
  type EarlyEndApprovalPreviewDto,
  type RepairPreviewDto,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';

/**
 * РУКОПОЖАТИЕ ПО ЛИСТУ У ТРЁХ ПОСЛЕДНИХ ДВЕРЕЙ: РЕМОНТ ИСТОРИИ, СТАРАЯ СМЕНА ТЕХНИКИ И ДОСРОЧНОЕ
 * ЗАВЕРШЕНИЕ (план `docs/assignment-periods-plan.md`, §7, Б4, В1, Р21;
 * `docs/vehicle-request-actual-end-date-plan.md`, Р19, Р26).
 *
 * ЧТО ЗДЕСЬ ЗАКРЫВАЕТСЯ. Волна, перенёсшая расчёт предупреждений из момента выписки в момент
 * построения плана, закрыла четыре двери из семи, а три оставила — не по забывчивости, а потому что
 * у каждой не хватало своего звена:
 *
 *  - **ремонт истории** считал листы не планом, а исполнением: его шаг 12 живёт в маршруте, готовых
 *    листов туда не передавали, и предпросмотр отдавал пустой `issues` — подтверждать было нечего;
 *  - **старая дверь смены техники** предупреждения показывала, но потребовать подпись не могла:
 *    боевая половина живёт в маршруте, а тело запроса в расчёт не приходит;
 *  - **досрочное завершение** брало снимок и расчёт из плана, но поля подписи в теле не имело, и в
 *    бланк она не ложилась вовсе.
 *
 * ПОЧЕМУ ЭТО НЕ ПРОВЕРИТЬ ЧИСТЫМ ТЕСТОМ. Предупреждение у ЭСМ-2 одно — пробелы в документах
 * машиниста (ADR 0064), — и собирается оно из справочника людей: карточка, СНИЛС, трудовое
 * отношение и удостоверение на дату листа. Ни одного из этих чтений в памяти не подделать так,
 * чтобы утверждение осталось про портал, а не про моки. Путь при этом настоящий, HTTP: у всех трёх
 * дверей рукопожатие стоит **в маршруте или в его команде**, между блокировками и первой записью,
 * и вызов сервиса напрямую прошёл бы мимо предмета.
 *
 * ЧТО УТВЕРЖДАЕТСЯ — по одному набору на дверь:
 *
 *  1. предпросмотр называет предупреждения по каждому выпускаемому листу (у досрочного завершения —
 *     **обезличенно**: виды замечаний и отпечаток, без номера бланка и фамилии, Р26);
 *  2. команда без подписи отвергается 409 `waybill_ack_required` и не жжёт ни одного номера;
 *  3. с подписью проходит, и выписанный лист помнит, под чем он вышел (`issue_warnings.status`);
 *  4. подпись, снятая с прежнего набора, не годится — при том же `previewFingerprint`.
 *
 * ПОЧЕМУ ОСНОВНОЙ ПРОГОН ТОЛЬКО В `history`. Подпись спрашивается там, где бумагу выпускает сам
 * план. В `legacy` листы ведёт недельная сверка: просителя у неё нет вовсе, и неполный комплект
 * документов её не останавливает (ADR 0064) — потребуй дверь подпись там, заперлась бы сегодняшняя
 * работа портала, у которого окна рукопожатий ещё нет. Половину `legacy` держат отдельные случаи:
 * предупреждения там показываются, а команда проходит без подписи.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/esm2-issue-handshake.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/** Своя база и режим чтения на ней; стоит до собственного `beforeAll` — см. `assignment-read-mode`. */
const readMode = useReadModeDatabase('esm2ack');

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-esm2-ack';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: рукопожатие по листу ЭСМ-2';
const REQUEST_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: рукопожатие по листу ЭСМ-2';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';
/**
 * Реквизиты документов уникальны в справочнике: СНИЛС — одиннадцатью цифрами
 * (`persons_snils_format_check`, `persons_snils_unique`), удостоверение — парой «серия + номер»
 * (`person_credentials_number_unique`). Прогон живёт в общей базе и после себя убирает, но внутри
 * него людей с документами несколько — счётчик обязан различать и их.
 */
const DOCS_RUN = String(Date.now()).slice(-9);
let docsCounter = 0;
const nextDocsNo = (): string => String((docsCounter += 1) % 100).padStart(2, '0');

// ── Календарь сцен ──
//
// Считается от понедельника текущей недели: у срока есть и отработанная неделя (прошлая), и ещё не
// кончившаяся (текущая), и предстоящая. Без отработанной нечего разблокировать, без текущей нечего
// резать, без предстоящей нечего выписывать.

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** Понедельник прошлой недели: к сегодня её лист отработан и потому заперт (Р21). */
const PREV_MONDAY = shiftDateKey(MONDAY, -7);
/** Воскресенье текущей недели. */
const THIS_SUNDAY = shiftDateKey(MONDAY, 6);
/** Воскресенье следующей недели: срок, у которого есть куда сокращаться. */
const NEXT_SUNDAY = shiftDateKey(MONDAY, 13);

interface Account {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Account;
  objectId: string;
  vehicleA: { id: string; typeId: string };
  vehicleB: { id: string; typeId: string };
  /** Машинист с полным комплектом: его лист чист, и подтверждать по нему нечего. */
  documented: string;
}

let ctx: Ctx;
let seq = 0;

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и своя база готовы хуком механики; почта в прогоне не нужна вовсе.
  process.env.MAIL_ENABLED = 'false';

  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  ctx = { app: await build(), db, closeDb } as Ctx;

  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  // Своя спецтехника, нелинейная: линейный заказ ведёт бумагу по требованию, и недельного плана,
  // из которого растут предупреждения по листам, у него нет вовсе (ADR 0100 §6).
  const vehicle = async (offset: number) => {
    const row = await one(sql`
      SELECT v.id, v.vehicle_type_id FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND vk.code = 'special_equipment'
         AND vt.is_linear = false
       ORDER BY v.id OFFSET ${offset} LIMIT 1`);
    return { id: row.id!, typeId: row.vehicle_type_id! };
  };
  ctx.vehicleA = await vehicle(0);
  ctx.vehicleB = await vehicle(1);
  ctx.documented = await newPerson('Комплектов', true);
  // Администратор: у ремонта прошлой недели исход `crew`, и коррекционные права ему нужны (Р32);
  // визу досрочного завершения неограниченная роль с правом визы проходит наравне с площадкой.
  ctx.admin = await newAccount();
}, 240_000);

afterAll(async () => {
  if (!readMode.enabled || !ctx) return;
  await cleanup();
  await ctx.app?.close();
  await ctx.closeDb?.();
});

async function cleanup(): Promise<void> {
  const db = ctx.db;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
      SELECT id::text FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  // Заявки первыми: строки истории ссылаются на операции под RESTRICT, и уносит их каскад заявки.
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${REQUEST_MARK}`);
  await db.execute(sql`
    DELETE FROM waybill_corrections WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`
    DELETE FROM person_credentials WHERE person_id IN (
      SELECT id FROM persons WHERE comment = ${PERSON_MARK})`);
  await db.execute(sql`
    DELETE FROM person_specializations WHERE person_id IN (
      SELECT id FROM persons WHERE comment = ${PERSON_MARK})`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

/**
 * Человек справочника. `documents: false` — карточка без СНИЛСа и без удостоверения: ровно тот
 * случай, о котором лист и предупреждает (ADR 0064). `true` — полный комплект.
 *
 * Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не зависит
 * (ADR 0164), но водителем справочника человек числится именно ею.
 */
async function newPerson(lastName: string, documents: boolean): Promise<string> {
  const no = nextDocsNo();
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, snils, comment)
      VALUES (${lastName}, 'Пров', ${documents ? `${DOCS_RUN}${no}` : ''}, ${PERSON_MARK})
      RETURNING id`)
  ).rows;
  const personId = row!.id;
  const [spec] = (
    await ctx.db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
    VALUES (${personId}, ${spec!.id}, true, ${shiftDateKey(PREV_MONDAY, -400)})`);
  if (documents) {
    const [type] = (
      await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM credential_types WHERE code = 'driver_license'`,
      )
    ).rows;
    await ctx.db.execute(sql`
      INSERT INTO person_credentials
        (person_id, credential_type_id, series, number, issued_on, expires_on)
      VALUES (${personId}, ${type!.id}, '77 AA', ${`${DOCS_RUN.slice(-4)}${no}`},
              ${shiftDateKey(PREV_MONDAY, -800)}, ${shiftDateKey(NEXT_SUNDAY, 800)})`);
  }
  return personId;
}

async function newAccount(): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-admin-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Подписев', 'Пров', '', ${await hashPassword(PASSWORD)}, 'admin', true,
              now())
      RETURNING id`)
  ).rows;
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: row!.id, auth: { authorization: `Bearer ${accessToken}` } };
}

// ── Сцена ──

interface HistoryRow {
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string;
  driverPersonId?: string;
  driverState?: 'set' | 'unknown';
}

/**
 * Происхождение строки. `unknown` завести человеку нечем (Р19) — его источник ровно один, бэкфилл,
 * и база это держит (`..._unknown_check`). Сцена и есть бэкфилл: она кладёт историю такой, какой её
 * оставила бы миграция у старого заказа.
 */
const originOf = (row: HistoryRow): string =>
  row.driverState === 'unknown' ? 'backfill' : 'assignment';

interface SceneOptions {
  dateFrom: string;
  dateTo: string;
  history: HistoryRow[];
  /** Кем сцена кладёт бумагу прежней, недельной сверкой: по листу на календарную неделю. */
  sheetsDriver: string;
}

/**
 * Заказ спецтехники в работе: своя машина на весь срок, история материализована, бумага выписана
 * расчётом **от начала срока** — тогда лист получает и та неделя, что к сегодня уже отработана.
 *
 * Собирается SQL'ем, а не статусной ручкой, намеренно: в режиме `history` перевод в работу
 * упирается в бэкстоп (Р22), а предмет этого файла к подготовке отношения не имеет.
 */
async function makeScene(options: SceneOptions): Promise<string> {
  const [request] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, 'materialized', ${TODAY})
      RETURNING id`)
  ).rows;
  const requestId = request!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${options.dateFrom}, ${options.dateTo})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleA.id}, ${ctx.vehicleA.typeId}, ${ctx.vehicleA.typeId},
            ${ctx.admin.id})`);
  for (const row of options.history) {
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES (${requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
              ${row.driverPersonId ?? null},
              ${row.driverState ?? (row.dimension === 'driver' ? 'set' : null)}, ${originOf(row)},
              ${randomUUID()})`);
  }

  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.admin.id },
      reason: 'сцена теста: бумага на весь срок',
      driverPersonId: options.sheetsDriver,
      // Расчёт от начала срока: иначе отработанная неделя листа не получила бы вовсе.
      asOf: options.dateFrom,
    });
  });
  // След подготовки из журнала — прочь: события сверки считают случаи, а не сцена.
  await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${requestId}`);
  return requestId;
}

// ── Чтение состояния ──

interface SheetRow {
  id: string;
  period_from: string;
  period_to: string;
  driver_person_id: string;
  status: string;
  issue_warnings: { status?: string; fingerprint?: string; warnings?: unknown[] } | null;
}

async function sheetsOf(requestId: string): Promise<SheetRow[]> {
  return (
    await ctx.db.execute<SheetRow>(sql`
      SELECT id, period_from, period_to, driver_person_id, status, issue_warnings
        FROM waybills WHERE source_request_id = ${requestId}
       ORDER BY period_from, id`)
  ).rows;
}

const liveSheets = (rows: readonly SheetRow[]): SheetRow[] =>
  rows.filter((row) => row.status !== 'cancelled');

async function versionOf(requestId: string): Promise<number> {
  const [row] = (
    await ctx.db.execute<{ version: number }>(
      sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
    )
  ).rows;
  return Number(row!.version);
}

/** Рукопожатия по всем листам, которым есть что подтверждать, — так их собирает и окно. */
const acknowledgementsOf = (
  issues: readonly { issueKey: number; warningFingerprint: string; warnings?: unknown[] }[],
  /** Предпросмотр визы предупреждений не показывает вовсе — у него виды замечаний (Р26). */
  warned: (issue: { warnings?: unknown[]; codes?: string[] }) => boolean,
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => warned(issue))
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

const byWarnings = (issue: { warnings?: unknown[] }): boolean => (issue.warnings?.length ?? 0) > 0;
const byCodes = (issue: { codes?: string[] }): boolean => (issue.codes?.length ?? 0) > 0;

/** Подписанные листы обязаны помнить подпись, чистые — что проверка была (Р21). */
function expectSignedPaper(issued: readonly SheetRow[], signedDriver: string): void {
  const signed = issued.filter((row) => row.driver_person_id === signedDriver);
  expect(signed.length).toBeGreaterThan(0);
  for (const row of signed) {
    expect(row.issue_warnings?.status).toBe('acknowledged');
    expect(row.issue_warnings?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.issue_warnings?.warnings?.length).toBeGreaterThan(0);
  }
}

/**
 * Кадры дозаполнили карточку: СНИЛС появился, удостоверения по-прежнему нет.
 *
 * Набор предупреждений после этого другой — и старая подпись описывает положение дел, которого
 * больше нет. План при этом не меняется вовсе, и `previewFingerprint` такого случая не ловит: его
 * ловит только рукопожатие, потому оно и считается с фактов, а не с текста.
 */
async function fillSnils(personId: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE persons SET snils = ${`${DOCS_RUN}${nextDocsNo()}`} WHERE id = ${personId}`,
  );
}

// ── Ручки трёх дверей ──

const previewRepair = (requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair/preview`,
    headers: ctx.admin.auth,
    payload: body,
  });

const postRepair = (requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair`,
    headers: ctx.admin.auth,
    payload: body,
  });

const previewReassign = (requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment/preview`,
    headers: ctx.admin.auth,
    payload: body,
  });

const patchReassign = (requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/assignment`,
    headers: ctx.admin.auth,
    payload: body,
  });

const previewEarlyEndDecision = (requestId: string, version: number) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/early-end/decision/preview`,
    headers: ctx.admin.auth,
    payload: { approved: true, version },
  });

const decideEarlyEnd = (requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/early-end`,
    headers: ctx.admin.auth,
    payload: { approved: true, ...body },
  });

/** Запрос на досрочное завершение, ждущий визы, — строкой: визирует его случай, а не заводит. */
async function pendingEarlyEnd(
  requestId: string,
  newDateTo: string,
  previousDateTo: string,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_early_endings
      (request_id, status, new_date_to, previous_date_to, reason, requested_by, requested_at)
    VALUES (${requestId}, 'pending', ${newDateTo}, ${previousDateTo},
            'техника освободилась раньше — проверено на объекте', ${ctx.admin.id}, now())`);
}

// ── Сцены трёх дверей ──
//
// Человек без документов у каждой сцены **свой**: случай устаревшей подписи дозаполняет ему
// карточку, и общий на весь файл машинист унёс бы это изменение к соседям — второй случай
// дозаполнял бы уже заполненное, набор предупреждений не менялся бы, и «устаревшая подпись»
// проверяла бы декорацию.

//
// Каждая построена так, чтобы команда **выписала** лист на человека с пробелами в документах: без
// выписки подтверждать нечего, и случай проверял бы декорации.

interface Scene {
  requestId: string;
  /** Машинист без документов: ни СНИЛСа, ни удостоверения — его лист выйдет с предупреждением. */
  gapped: string;
}

const newGapped = (): Promise<string> => newPerson('Бездокументов', false);

/**
 * Ремонт: история знает машину, но не знает человека (`unknown` с начала срока), а бумага выписана
 * прежней сверкой на человека с полным комплектом. Якорь называет того, у кого документов нет, —
 * и ремонт переоформляет на него весь срок.
 */
async function repairScene(): Promise<Scene> {
  const gapped = await newGapped();
  return {
    gapped,
    requestId: await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: THIS_SUNDAY,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.vehicleA.id },
        { effectiveDate: PREV_MONDAY, dimension: 'driver', driverState: 'unknown' },
      ],
      sheetsDriver: ctx.documented,
    }),
  };
}

const repairBody = (scene: Scene, version: number): Record<string, unknown> => ({
  mode: 'repair',
  version,
  anchors: [{ effectiveDate: PREV_MONDAY, driverPersonId: scene.gapped }],
  operation: { operationId: randomUUID(), reason: 'по табелю обе недели отработал сменщик' },
});

/**
 * Смена техники: заказ ведёт человек без документов, машину меняют на другую. Лист с напечатанной
 * машиной не правится — он гаснет и выписывается заново, с тем же человеком и теми же пробелами.
 */
async function reassignScene(): Promise<Scene> {
  const gapped = await newGapped();
  return {
    gapped,
    requestId: await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: NEXT_SUNDAY,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.vehicleA.id },
        { effectiveDate: PREV_MONDAY, dimension: 'driver', driverPersonId: gapped },
      ],
      sheetsDriver: gapped,
    }),
  };
}

/**
 * Досрочное завершение: с сегодняшнего дня заказ ведёт человек без документов, а бумага выписана
 * прежней сверкой на всю неделю и прежним человеком. Сокращение срока до сегодня забирает у этого
 * листа часть дней — сократить его в такое ожидание нельзя (хвост ждёт другой документ), — и лист
 * гаснет, а взамен выписывается новый: с пробелами, которые человек обязан подтвердить.
 */
async function earlyEndScene(): Promise<Scene> {
  const gapped = await newGapped();
  return {
    gapped,
    requestId: await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: NEXT_SUNDAY,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.vehicleA.id },
        { effectiveDate: PREV_MONDAY, dimension: 'driver', driverPersonId: ctx.documented },
        { effectiveDate: TODAY, dimension: 'driver', driverPersonId: gapped },
      ],
      sheetsDriver: ctx.documented,
    }),
  };
}

// ── Основной прогон: бумагу выпускает сам план ──

describeReadModes(
  readMode,
  'рукопожатие по листу у трёх последних дверей (Б4)',
  () => {
    it('ремонт истории: предпросмотр называет предупреждения, без подписи 409, с подписью проходит', async () => {
      if (!readMode.enabled) return;
      const scene = await repairScene();
      const { requestId } = scene;
      const before = await sheetsOf(requestId);
      const body = repairBody(scene, await versionOf(requestId));

      const preview = await previewRepair(requestId, body);
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<RepairPreviewDto>();
      /*
       * Ключи набора идут по тем же листам и в том же порядке, что и сам план: `issueKey` — индекс
       * в нём, и по этому ключу человек подтверждает бумагу. До этой волны список был пуст вовсе.
       */
      expect(dto.issues.map((issue) => issue.issueKey)).toEqual(
        dto.plan.issue.map((issue) => issue.issueKey),
      );
      expect(dto.issues.length).toBeGreaterThan(0);
      const warned = dto.issues.filter(byWarnings);
      expect(warned.length).toBe(dto.issues.length);
      for (const issue of warned) {
        // Предупреждение у ЭСМ-2 ровно одно возможное — пробелы в документах машиниста (ADR 0064).
        expect(issue.warnings[0]!.facts).toMatchObject({ code: 'driver_documents' });
        expect(issue.warningFingerprint).toMatch(/^[0-9a-f]{64}$/);
      }

      const armed = {
        ...body,
        previewFingerprint: dto.fingerprint,
        ...(dto.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
      };
      /*
       * 409, а не 422: отказано не запросу, а его неподтверждённости — окно обязано показать
       * свежий набор и спросить подпись, а не сказать «поле лишнее».
       */
      const refused = await postRepair(requestId, armed);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');
      // Ни один номер не сгорел и ни один не выписан: до шага 12 команда не дошла.
      expect(await sheetsOf(requestId)).toEqual(before);

      const applied = await postRepair(requestId, {
        ...armed,
        acknowledgements: acknowledgementsOf(dto.issues, byWarnings),
      });
      expect(applied.statusCode, applied.body).toBe(200);

      const known = new Set(before.map((row) => row.id));
      const issued = liveSheets(await sheetsOf(requestId)).filter((row) => !known.has(row.id));
      expectSignedPaper(issued, scene.gapped);
    });

    it('ремонт истории: подпись, снятая с прежнего набора, не годится', async () => {
      if (!readMode.enabled) return;
      const scene = await repairScene();
      const { requestId } = scene;
      const body = repairBody(scene, await versionOf(requestId));

      const first = await previewRepair(requestId, body);
      expect(first.statusCode, first.body).toBe(200);
      const stale = first.json<RepairPreviewDto>();
      const staleAcknowledgements = acknowledgementsOf(stale.issues, byWarnings);

      await fillSnils(scene.gapped);

      const again = await previewRepair(requestId, body);
      expect(again.statusCode, again.body).toBe(200);
      const fresh = again.json<RepairPreviewDto>();
      // План не изменился — и `previewFingerprint` этого случая не ловит вовсе: в него входят
      // последствия команды, а не содержание бланка.
      expect(fresh.fingerprint).toBe(stale.fingerprint);
      expect(fresh.issues.filter(byWarnings).length).toBeGreaterThan(0);
      for (const issue of fresh.issues) {
        expect(issue.warningFingerprint).not.toBe(staleAcknowledgements[String(issue.issueKey)]);
      }

      const armed = {
        ...body,
        previewFingerprint: fresh.fingerprint,
        ...(fresh.unlockFingerprint ? { unlockFingerprint: fresh.unlockFingerprint } : {}),
      };
      const refused = await postRepair(requestId, {
        ...armed,
        acknowledgements: staleAcknowledgements,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');

      // Со свежей подписью та же команда проходит: подтверждено то, что есть на самом деле.
      const applied = await postRepair(requestId, {
        ...armed,
        acknowledgements: acknowledgementsOf(fresh.issues, byWarnings),
      });
      expect(applied.statusCode, applied.body).toBe(200);
    });

    it('смена техники: предпросмотр называет предупреждения, без подписи 409, с подписью проходит', async () => {
      if (!readMode.enabled) return;
      const scene = await reassignScene();
      const { requestId } = scene;
      const before = await sheetsOf(requestId);
      const body = { vehicleId: ctx.vehicleB.id, version: await versionOf(requestId) };

      const preview = await previewReassign(requestId, body);
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<AssignmentPreviewDto>();
      expect(dto.issues.map((issue) => issue.issueKey)).toEqual(
        dto.plan.issue.map((issue) => issue.issueKey),
      );
      const warned = dto.issues.filter(byWarnings);
      expect(warned.length).toBeGreaterThan(0);
      for (const issue of warned) {
        expect(issue.warnings[0]!.facts).toMatchObject({ code: 'driver_documents' });
      }

      const armed = { ...body, previewFingerprint: dto.fingerprint };
      const refused = await patchReassign(requestId, armed);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');
      expect(await sheetsOf(requestId)).toEqual(before);

      const applied = await patchReassign(requestId, {
        ...armed,
        acknowledgements: acknowledgementsOf(dto.issues, byWarnings),
      });
      expect(applied.statusCode, applied.body).toBe(200);
      // Бумага переоформлена на новую машину: в бланке напечатана она, и правкой это не решается.
      const issued = liveSheets(await sheetsOf(requestId)).filter(
        (row) => !new Set(before.map((old) => old.id)).has(row.id),
      );
      expect(issued.length).toBeGreaterThan(0);
      /*
       * И подпись не потерялась. Бумагу этой двери по-прежнему выпускает недельная сверка, но
       * рукопожатие, принятое дверью, доезжает до неё и ложится в сам лист (Р21): иначе человек
       * подтверждал бы набор, а бланк выходил бы с умолчанием «не проверяли».
       */
      expectSignedPaper(issued, scene.gapped);
    });

    it('смена техники: подпись, снятая с прежнего набора, не годится', async () => {
      if (!readMode.enabled) return;
      const scene = await reassignScene();
      const { requestId } = scene;
      const body = { vehicleId: ctx.vehicleB.id, version: await versionOf(requestId) };

      const first = await previewReassign(requestId, body);
      expect(first.statusCode, first.body).toBe(200);
      const stale = first.json<AssignmentPreviewDto>();
      const staleAcknowledgements = acknowledgementsOf(stale.issues, byWarnings);

      await fillSnils(scene.gapped);

      const again = await previewReassign(requestId, body);
      expect(again.statusCode, again.body).toBe(200);
      const fresh = again.json<AssignmentPreviewDto>();
      expect(fresh.fingerprint).toBe(stale.fingerprint);

      const refused = await patchReassign(requestId, {
        ...body,
        previewFingerprint: fresh.fingerprint,
        acknowledgements: staleAcknowledgements,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');

      const applied = await patchReassign(requestId, {
        ...body,
        previewFingerprint: fresh.fingerprint,
        acknowledgements: acknowledgementsOf(fresh.issues, byWarnings),
      });
      expect(applied.statusCode, applied.body).toBe(200);
    });

    it('досрочное завершение: обезличенный предпросмотр называет виды замечаний, без подписи 409', async () => {
      if (!readMode.enabled) return;
      const scene = await earlyEndScene();
      const { requestId } = scene;
      await pendingEarlyEnd(requestId, TODAY, NEXT_SUNDAY);
      const before = await sheetsOf(requestId);

      const preview = await previewEarlyEndDecision(requestId, await versionOf(requestId));
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<EarlyEndApprovalPreviewDto>();
      /*
       * Обезличивание (Р26) и рукопожатие (Б4) здесь встречаются: визирующему нельзя показать ни
       * номер бланка, ни фамилию машиниста — прав на журнал листов у него нет вовсе, — а подписать
       * лист он обязан. Отсюда проекция: вид замечания и отпечаток фактов.
       */
      const warned = dto.issues.filter(byCodes);
      expect(warned.length).toBeGreaterThan(0);
      for (const issue of warned) {
        expect(issue.codes).toEqual(['driver_documents']);
        expect(issue.warningFingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
      // В теле нет ничего, что называет бланк или человека, — и новое поле этого не изменило.
      const body = JSON.stringify(dto);
      expect(body).not.toContain(scene.gapped);
      expect(body).not.toContain('Бездокументов');

      const armed = {
        version: await versionOf(requestId),
        previewFingerprint: dto.fingerprint,
        ...(dto.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: dto.cancelGroupsFingerprint }
          : {}),
        ...(dto.operationRequirement ? { operationId: randomUUID() } : {}),
      };
      const refused = await decideEarlyEnd(requestId, armed);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');
      expect(await sheetsOf(requestId)).toEqual(before);

      const applied = await decideEarlyEnd(requestId, {
        ...armed,
        acknowledgements: acknowledgementsOf(dto.issues, byCodes),
      });
      expect(applied.statusCode, applied.body).toBe(200);

      const known = new Set(before.map((row) => row.id));
      const issued = liveSheets(await sheetsOf(requestId)).filter((row) => !known.has(row.id));
      expectSignedPaper(issued, scene.gapped);
    });

    it('досрочное завершение: подпись, снятая с прежнего набора, не годится', async () => {
      if (!readMode.enabled) return;
      const scene = await earlyEndScene();
      const { requestId } = scene;
      await pendingEarlyEnd(requestId, TODAY, NEXT_SUNDAY);

      const first = await previewEarlyEndDecision(requestId, await versionOf(requestId));
      expect(first.statusCode, first.body).toBe(200);
      const stale = first.json<EarlyEndApprovalPreviewDto>();
      const staleAcknowledgements = acknowledgementsOf(stale.issues, byCodes);

      await fillSnils(scene.gapped);

      const again = await previewEarlyEndDecision(requestId, await versionOf(requestId));
      expect(again.statusCode, again.body).toBe(200);
      const fresh = again.json<EarlyEndApprovalPreviewDto>();
      expect(fresh.fingerprint).toBe(stale.fingerprint);

      const armed = {
        version: await versionOf(requestId),
        previewFingerprint: fresh.fingerprint,
        ...(fresh.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: fresh.cancelGroupsFingerprint }
          : {}),
        ...(fresh.operationRequirement ? { operationId: randomUUID() } : {}),
      };
      const refused = await decideEarlyEnd(requestId, {
        ...armed,
        acknowledgements: staleAcknowledgements,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('waybill_ack_required');

      const applied = await decideEarlyEnd(requestId, {
        ...armed,
        acknowledgements: acknowledgementsOf(fresh.issues, byCodes),
      });
      expect(applied.statusCode, applied.body).toBe(200);
    });
  },
  { modes: ['history'] },
);

// ── Режим `legacy`: показываем, но не требуем ──
//
// Бумагу там ведёт недельная сверка, у которой просителя нет вовсе, и неполный комплект документов
// её не останавливает (ADR 0064). Потребуй дверь подпись — заперлась бы сегодняшняя работа портала,
// у которого окна рукопожатий ещё нет. Но **присланная** подпись проверяется и здесь.

it('в `legacy` смена техники показывает предупреждения и проходит без подписи', async () => {
  if (!readMode.enabled) return;
  await inLegacy(readMode, async () => {
    const scene = await reassignScene();
    const { requestId } = scene;
    const version = await versionOf(requestId);

    const preview = await previewReassign(requestId, { vehicleId: ctx.vehicleB.id, version });
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<AssignmentPreviewDto>();
    // Предупреждения считает план — и в `legacy` тоже: человек вправе видеть, с какими пробелами
    // уйдёт бумага, даже когда переписывает её недельная сверка.
    expect(dto.issues.some(byWarnings)).toBe(true);

    // Ни отпечатка, ни подписи: ровно тот запрос, каким сегодня ходит портал.
    const applied = await patchReassign(requestId, { vehicleId: ctx.vehicleB.id, version });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(liveSheets(await sheetsOf(requestId)).length).toBeGreaterThan(0);
  });
});

it('в `legacy` присланная подпись проверяется: лишняя — 422', async () => {
  if (!readMode.enabled) return;
  await inLegacy(readMode, async () => {
    const scene = await reassignScene();
    const { requestId } = scene;
    const version = await versionOf(requestId);
    const preview = await previewReassign(requestId, { vehicleId: ctx.vehicleB.id, version });
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<AssignmentPreviewDto>();

    /*
     * Подтверждение под листом, которого в плане нет, — 422 и в `legacy`: человек прислал не то, и
     * «посмотрите заново» ему не поможет. Принять и молча не посмотреть хуже, чем не спрашивать.
     */
    const refused = await patchReassign(requestId, {
      vehicleId: ctx.vehicleB.id,
      version,
      previewFingerprint: dto.fingerprint,
      acknowledgements: { [String(dto.issues.length + 10)]: 'a'.repeat(64) },
    });
    expect(refused.statusCode, refused.body).toBe(422);
  });
});

it('в `legacy` ремонт и досрочное завершение проходят без подписи', async () => {
  if (!readMode.enabled) return;
  await inLegacy(readMode, async () => {
    const repairScene_ = await repairScene();
    const repairId = repairScene_.requestId;
    const repair = repairBody(repairScene_, await versionOf(repairId));
    const repairPreview = await previewRepair(repairId, repair);
    expect(repairPreview.statusCode, repairPreview.body).toBe(200);
    const repairDto = repairPreview.json<RepairPreviewDto>();
    // Дверь и здесь называет предупреждения: считает их план, а не исполнение.
    expect(repairDto.issues.some(byWarnings)).toBe(true);
    const repaired = await postRepair(repairId, {
      ...repair,
      previewFingerprint: repairDto.fingerprint,
      ...(repairDto.unlockFingerprint ? { unlockFingerprint: repairDto.unlockFingerprint } : {}),
    });
    expect(repaired.statusCode, repaired.body).toBe(200);

    const earlyId = (await earlyEndScene()).requestId;
    await pendingEarlyEnd(earlyId, TODAY, NEXT_SUNDAY);
    const earlyPreview = await previewEarlyEndDecision(earlyId, await versionOf(earlyId));
    expect(earlyPreview.statusCode, earlyPreview.body).toBe(200);
    const earlyDto = earlyPreview.json<EarlyEndApprovalPreviewDto>();
    const decided = await decideEarlyEnd(earlyId, {
      version: await versionOf(earlyId),
      previewFingerprint: earlyDto.fingerprint,
      ...(earlyDto.cancelGroupsFingerprint
        ? { cancelGroupsFingerprint: earlyDto.cancelGroupsFingerprint }
        : {}),
      ...(earlyDto.operationRequirement ? { operationId: randomUUID() } : {}),
    });
    expect(decided.statusCode, decided.body).toBe(200);
  });
});
