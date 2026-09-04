import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AssignmentPreviewDto,
  type Role,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * Предпросмотр и отпечаток **старой двери смены техники** — `POST /:id/assignment/preview` и
 * `PATCH /:id/assignment` (`docs/assignment-periods-plan.md`, §8 «новая ручка у старой двери»,
 * Р11, Р18, Р32; фазирование — Ж5, И5).
 *
 * ЗАЧЕМ БАЗА И ПОЧЕМУ HTTP. Предмет здесь — не форма ответа, а сцепка четырёх вещей, ни одна из
 * которых не воспроизводится на объектах в памяти:
 *
 * 1. **бумага** — недельные листы ЭСМ-2 с расходом номеров и границей отменяемости: предпросмотр
 *    обязан назвать те же номера, которые сожжёт и выпишет сверка;
 * 2. **смены** — два раздельных множества Р18 (`blockedShiftDays` и `clearedShiftDays`) читаются из
 *    `vehicle_request_shifts`, и различает их подпись объекта, а не флаг в коде;
 * 3. **отпечаток** — он обязан совпасть у предпросмотра и у боевой ручки, посчитанных **разными
 *    транзакциями**, и разойтись, если состояние успело измениться, не тронув `version` заявки;
 * 4. **фаза** — режим чтения живёт в управляющей строке, одной на базу, и от него зависит, обязателен
 *    отпечаток или нет.
 *
 * Путь настоящий, HTTP: сверка отпечатка стоит внутри транзакции двери, между блокировками и первой
 * записью, и вызов сервиса напрямую этого порядка не проверяет вовсе.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА — **старый клиент не сломан**. Портал отпечатка сегодня не шлёт, окно
 * приедет волной 4a, и в режиме `legacy` смена техники обязана работать ровно так же, как до этой
 * волны. Проверяется прямо: тот же запрос без единого нового поля меняет машину и отвечает 200.
 *
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, и он заводит её сам: режим чтения живёт в управляющей строке, а она одна
 * на базу — прогон по общей `TEST_DATABASE_URL` менял бы её соседям.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/ap_assign \
 *     npx vitest run test/assignment-reassign.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const readMode = useReadModeDatabase('reassign');

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-ap-reassign';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: предпросмотр смены техники';
const REQUEST_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: предпросмотр смены техники';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

// ── Календарь сцены ──
//
// Считается от понедельника текущей недели: так у срока есть и отработанная неделя (прошлая), и
// ещё не кончившаяся (текущая), и предстоящая. Без отработанной недели коррекции нечего
// разблокировать, а без предстоящей — нечего выписывать.

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const TERM_FROM = shiftDateKey(MONDAY, -7);
const TERM_TO = shiftDateKey(MONDAY, 13);
/** День внутри отработанной недели: под ним и стоит подпись объекта. */
const PAST_DAY = shiftDateKey(TERM_FROM, 1);
/** День предстоящей недели: он лежит внутри `workBlockRange` обычной смены техники. */
const FUTURE_DAY = shiftDateKey(MONDAY, 8);

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
  personA: string;
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
  // который проверяет этот файл, у него нет вовсе (ADR 0100 §6).
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
  ctx.personA = await newPerson('Машинистов');
  // Администратор: у исторической коррекции исход `crew`, и коррекционные права ей нужны (Р32).
  ctx.admin = await newAccount('admin');
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
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${PERSON_MARK}) RETURNING id`)
  ).rows;
  const personId = row!.id;
  const [spec] = (
    await ctx.db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
  ).rows;
  // Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не зависит
  // (ADR 0164), но водителем справочника человек числится именно ею.
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
    VALUES (${personId}, ${spec!.id}, true, ${shiftDateKey(TERM_FROM, -400)})`);
  return personId;
}

async function newAccount(role: Role): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${role}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Сменов', 'Пров', '', ${await hashPassword(PASSWORD)}, ${role}, true, now())
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

interface Scene {
  requestId: string;
  version: number;
  /** Лист отработанной недели: цель разблокировки у коррекции. */
  pastSheetId: string;
}

interface SceneOptions {
  /** Подписанный объектом день внутри отработанной недели. */
  approvedPastDay?: boolean;
}

/**
 * Заказ спецтехники в работе: своя машина на весь срок, история материализована, бумага выписана
 * расчётом от начала срока — тогда лист получает и та неделя, что к сегодня уже отработана.
 *
 * Собирается SQL'ем, а не статусной ручкой, намеренно: в режиме `history` перевод в работу упирается
 * в бэкстоп (Р22), а предмет этого файла к подготовке отношения не имеет.
 */
async function makeScene(options: SceneOptions = {}): Promise<Scene> {
  const [request] = (
    await ctx.db.execute<{ id: string; version: number }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, 'materialized', ${TODAY})
      RETURNING id, version`)
  ).rows;
  const requestId = request!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${TERM_FROM}, ${TERM_TO})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleA.id}, ${ctx.vehicleA.typeId}, ${ctx.vehicleA.typeId},
            ${ctx.admin.id})`);
  // История, какой её оставил бы бэкфилл: машина и человек с начала срока. Без неё бэкстоп чужих
  // дверей называл бы пробелы машиниста, и предпросмотр показывал бы первую фазу Р16.
  await insertChange({
    requestId,
    effectiveDate: TERM_FROM,
    dimension: 'vehicle',
    vehicleId: ctx.vehicleA.id,
    origin: 'assignment',
  });
  await insertChange({
    requestId,
    effectiveDate: TERM_FROM,
    dimension: 'driver',
    driverPersonId: ctx.personA,
    driverState: 'set',
    origin: 'assignment',
  });

  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.admin.id },
      reason: 'сцена теста: бумага на весь срок',
      driverPersonId: ctx.personA,
      // Расчёт от начала срока: иначе отработанная неделя листа не получила бы вовсе.
      asOf: TERM_FROM,
    });
  });

  if (options.approvedPastDay) {
    await insertShift(requestId, PAST_DAY, 8, true);
  }

  const [sheet] = (
    await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled' AND period_to < ${TODAY}
       ORDER BY period_from LIMIT 1`)
  ).rows;
  if (!sheet)
    throw new Error('у сцены нет листа отработанной недели: срок или расчёт собраны не так');

  return { requestId, version: await versionOf(requestId), pastSheetId: sheet.id };
}

async function insertChange(row: {
  requestId: string;
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string;
  driverPersonId?: string;
  driverState?: string;
  origin: string;
}): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${randomUUID()})`);
}

async function insertShift(
  requestId: string,
  date: string,
  hours: number,
  approved: boolean,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, filled_by,
                                        approved_by, approved_at)
    VALUES (${requestId}, ${date}, ${hours}, ${ctx.admin.id},
            ${approved ? ctx.admin.id : null}, ${approved ? new Date().toISOString() : null})`);
}

async function versionOf(requestId: string): Promise<number> {
  const [row] = (
    await ctx.db.execute<{ version: number }>(
      sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
    )
  ).rows;
  return Number(row!.version);
}

async function assignedVehicleOf(requestId: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ vehicle_id: string }>(
      sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${requestId}`,
    )
  ).rows;
  return row!.vehicle_id;
}

/** Снимок всего, что дверь способна тронуть: им доказывается, что предпросмотр не пишет (Р20). */
async function snapshotOf(requestId: string): Promise<Record<string, number | string>> {
  const scalar = async (q: Parameters<typeof ctx.db.execute>[0]): Promise<string> => {
    const [row] = (await ctx.db.execute<Record<string, string>>(q)).rows;
    return String(Object.values(row ?? {})[0] ?? '');
  };
  return {
    version: await versionOf(requestId),
    vehicle: await assignedVehicleOf(requestId),
    waybills: await scalar(
      sql`SELECT count(*) FROM waybills WHERE source_request_id = ${requestId}`,
    ),
    activeWaybills: await scalar(
      sql`SELECT count(*) FROM waybills
           WHERE source_request_id = ${requestId} AND status <> 'cancelled'`,
    ),
    changes: await scalar(
      sql`SELECT count(*) FROM vehicle_request_assignment_changes WHERE request_id = ${requestId}`,
    ),
    shifts: await scalar(
      sql`SELECT count(*) FROM vehicle_request_shifts WHERE request_id = ${requestId}`,
    ),
    approvedShifts: await scalar(
      sql`SELECT count(*) FROM vehicle_request_shifts
           WHERE request_id = ${requestId} AND approved_at IS NOT NULL`,
    ),
    corrections: await scalar(sql`SELECT count(*) FROM waybill_corrections`),
    audit: await scalar(
      sql`SELECT count(*) FROM audit_log
           WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}::text`,
    ),
  };
}

// ── Ручки ──

function previewOf(scene: Scene, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${scene.requestId}/assignment/preview`,
    headers: ctx.admin.auth,
    payload: { vehicleId: ctx.vehicleB.id, version: scene.version, ...body },
  });
}

function applyOf(scene: Scene, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${scene.requestId}/assignment`,
    headers: ctx.admin.auth,
    payload: { vehicleId: ctx.vehicleB.id, version: scene.version, ...body },
  });
}

/** Коррекционный блок: разблокировать лист отработанной недели — исход `crew` (Р32). */
function correctionBlock(scene: Scene): Record<string, unknown> {
  return {
    correction: {
      operationId: randomUUID(),
      reason: 'ехала другая машина — проверено по журналу объекта',
      unlockWaybillIds: [scene.pastSheetId],
    },
  };
}

describeReadModes(readMode, 'предпросмотр смены техники', (mode) => {
  it('предпросмотр не пишет ничего и показывает подписанные дни, запирающие обычную смену', async () => {
    const scene = await makeScene({ approvedPastDay: true });
    const before = await snapshotOf(scene.requestId);

    const res = await previewOf(scene, {});
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json<AssignmentPreviewDto>();

    // Первое множество Р18: подпись объекта под днём работы — то, из-за чего обычная смена
    // невозможна. Часы показываются рядом с днём, чтобы цена была видна, а не подразумевалась.
    expect(dto.blockedShiftDays).toEqual([{ date: PAST_DAY, hours: 8 }]);
    // Второе множество пусто: обычная смена подписей не снимает — она об них разбивается.
    expect(dto.clearedShiftDays).toEqual([]);
    expect(dto.clearedShiftsFingerprint).toBeNull();
    // План бумаги непустой: машина в бланке напечатана, и сменить её можно только перевыпиской.
    expect(dto.plan.issue.length).toBeGreaterThan(0);
    expect(dto.plan.issue.every((sheet) => sheet.vehicleId === ctx.vehicleB.id)).toBe(true);
    expect(dto.fingerprint).not.toBe('');
    expect(dto.asOf).toBe(TODAY);
    // Исход `none`: обычная смена с сегодняшнего дня прошлого не трогает и причины не требует (Р32).
    expect(dto.operationRequirement).toBeNull();

    expect(await snapshotOf(scene.requestId)).toEqual(before);
  });

  it('предпросмотр коррекции показывает снимаемые подписи и листы под разблокировку', async () => {
    const scene = await makeScene({ approvedPastDay: true });
    const before = await snapshotOf(scene.requestId);

    const res = await previewOf(scene, correctionBlock(scene));
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json<AssignmentPreviewDto>();

    // Коррекция те же дни не запирает: снятие подписи — её цель, а не помеха ей (Р18, ADR 0101).
    expect(dto.blockedShiftDays).toEqual([]);
    expect(dto.clearedShiftDays).toEqual([{ date: PAST_DAY, hours: 8 }]);
    expect(dto.clearedShiftsFingerprint).not.toBeNull();
    // Лист отработанной недели назван **сервером**: тело подтверждает отпечаток, а не список (Б3).
    expect(dto.requiredUnlocks.map((sheet) => sheet.waybillId)).toContain(scene.pastSheetId);
    expect(dto.unlockFingerprint).not.toBeNull();
    // Исход `crew`: команда задевает исторический диапазон, и журнал ей обязателен (Р32).
    expect(dto.operationRequirement).toEqual({
      kind: 'crew',
      reasonRequired: true,
      operationIdRequired: true,
    });

    expect(await snapshotOf(scene.requestId)).toEqual(before);
  });

  it('устаревший отпечаток — 409 и ни одной записи, хотя версия заявки не менялась', async () => {
    const scene = await makeScene();
    const preview = await previewOf(scene, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const { fingerprint } = preview.json<AssignmentPreviewDto>();

    /*
     * Состояние меняется **мимо версии**: объект внёс часы за день предстоящей недели. Заявку это
     * не трогает вовсе — ни `version`, ни назначения, — а последствия смены техники меняет: день с
     * часами лежит внутри диапазона, который команда переписывает (Р18). Ровно того, чего `version`
     * не ловит, отпечаток и обязан не пропустить.
     */
    await insertShift(scene.requestId, FUTURE_DAY, 6, false);
    const before = await snapshotOf(scene.requestId);

    const res = await applyOf(scene, { previewFingerprint: fingerprint });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('assignment_preview_stale');
    expect(await snapshotOf(scene.requestId)).toEqual(before);

    // Пересмотренный предпросмотр даёт другой отпечаток — и с ним команда проходит.
    const again = await previewOf(scene, {});
    expect(again.statusCode, again.body).toBe(200);
    const fresh = again.json<AssignmentPreviewDto>();
    expect(fresh.fingerprint).not.toBe(fingerprint);
  });

  it('свежий отпечаток принимается, и дверь меняет машину', async () => {
    const scene = await makeScene();
    const preview = await previewOf(scene, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<AssignmentPreviewDto>();

    const res = await applyOf(scene, { previewFingerprint: dto.fingerprint });
    /*
     * Ожидание одно на оба режима, и это утверждение, а не совпадение: отпечаток считается по
     * содержанию последствий, а не по режиму чтения, — и полная история сцены не даёт бэкстопу
     * чужих дверей ни одного пробела машиниста, из-за которого он отказал бы в `history` (Р22).
     */
    const expected = byReadMode(mode, { legacy: 200, history: 200 });
    expect(res.statusCode, res.body).toBe(expected);
    expect(await assignedVehicleOf(scene.requestId)).toBe(ctx.vehicleB.id);
    // Обещанная бумага и есть выписанная: план предпросмотра не расходится со сверкой.
    const [issued] = (
      await ctx.db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM waybills
         WHERE source_request_id = ${scene.requestId} AND status <> 'cancelled'
           AND vehicle_id = ${ctx.vehicleB.id}`)
    ).rows;
    expect(Number(issued!.n)).toBe(dto.plan.issue.length);
  });

  it('запрос без отпечатка: в `legacy` работает по-старому, в `history` — 409 с просьбой обновиться', async () => {
    const scene = await makeScene();
    const before = await snapshotOf(scene.requestId);

    const res = await applyOf(scene, {});
    const expected = byReadMode(mode, {
      // Главное утверждение файла: портал отпечатка не шлёт, и до волны 4a слать не будет — смена
      // техники обязана работать ровно так же, как до этой волны.
      legacy: 200,
      // После переключения чтения исполнять команду без просмотра последствий небезопасно, и
      // старый клиент получает понятный 409 из обработчика, а не 400 от схемы (И5).
      history: 409,
    });
    expect(res.statusCode, res.body).toBe(expected);
    if (expected === 200) {
      expect(await assignedVehicleOf(scene.requestId)).toBe(ctx.vehicleB.id);
    } else {
      expect(res.json<{ code: string }>().code).toBe('client_upgrade_required');
      expect(await snapshotOf(scene.requestId)).toEqual(before);
    }
  });
});
