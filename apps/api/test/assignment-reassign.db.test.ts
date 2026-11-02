import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  moscowDateKeyOf,
  BACKDATE_PERMISSION_MESSAGE,
  shiftDateKey,
  weekStartKey,
  type AssignmentIssueWarningsDto,
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
  /** Signed dates let the test distinguish the previous vehicle’s days from the changed range. */
  approvedDays?: string[];
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
  for (const day of options.approvedDays ?? []) await insertShift(requestId, day, 8, true);

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

/** Подписи по всем листам, которым есть что подтверждать, — так их собирает и окно (Б4). */
const acknowledgementsOf = (
  issues: readonly AssignmentIssueWarningsDto[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

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
  it('предпросмотр не пишет ничего и показывает подписанные дни с даты смены, запирающие обычную смену', async () => {
    // History leaves the worked week with the previous vehicle; legacy still changes the whole term.
    const scene = await makeScene({ approvedDays: [PAST_DAY, FUTURE_DAY] });
    const before = await snapshotOf(scene.requestId);

    const res = await previewOf(scene, {});
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json<AssignmentPreviewDto>();

    // The preview names each blocking signature with its hours, not just a count.
    expect(dto.blockedShiftDays).toEqual(
      byReadMode(mode, {
        legacy: [
          { date: PAST_DAY, hours: 8 },
          { date: FUTURE_DAY, hours: 8 },
        ],
        history: [{ date: FUTURE_DAY, hours: 8 }],
      }),
    );
    // Второе множество пусто: обычная смена подписей не снимает — она об них разбивается.
    expect(dto.clearedShiftDays).toEqual([]);
    expect(dto.clearedShiftsFingerprint).toBeNull();
    // The paper plan is not empty: the vehicle is printed on the sheet, and only re-issue changes it.
    // From today every sheet goes to the new vehicle. In `history` a change made mid-week also
    // re-issues the days before it onto the previous vehicle (ADR 0212), so only those are exempt.
    expect(dto.plan.issue.length).toBeGreaterThan(0);
    expect(
      dto.plan.issue
        .filter((sheet) => sheet.to >= TODAY)
        .every((sheet) => sheet.vehicleId === ctx.vehicleB.id),
    ).toBe(true);
    expect(dto.fingerprint).not.toBe('');
    expect(dto.asOf).toBe(TODAY);
    // Исход `none`: обычная смена с сегодняшнего дня прошлого не трогает и причины не требует (Р32).
    expect(dto.operationRequirement).toBeNull();

    expect(await snapshotOf(scene.requestId)).toEqual(before);
  });

  it('дата смены после последнего подписанного дня снимает замок; прежняя машина за свои дни не отвечает', async () => {
    const scene = await makeScene({ approvedDays: [PAST_DAY, FUTURE_DAY] });
    const later = shiftDateKey(FUTURE_DAY, 1);
    const res = await previewOf(scene, { effectiveDate: later });
    // Legacy has one whole-term assignment and cannot honour an explicit date.
    const expected = byReadMode(mode, { legacy: 422, history: 200 });
    expect(res.statusCode, res.body).toBe(expected);
    if (expected === 200) {
      const dto = res.json<AssignmentPreviewDto>();
      expect(dto.blockedShiftDays).toEqual([]);
      // No sheet of the new vehicle may cover a day before the chosen date.
      const forNew = dto.plan.issue.filter((sheet) => sheet.vehicleId === ctx.vehicleB.id);
      expect(forNew.length).toBeGreaterThan(0);
      expect(forNew.every((sheet) => sheet.from >= later)).toBe(true);
    }
  });

  it('дата смены вне срока заявки — 422 в обоих режимах, ничего не записано', async () => {
    const scene = await makeScene();
    const before = await snapshotOf(scene.requestId);
    for (const effectiveDate of [shiftDateKey(TERM_FROM, -1), shiftDateKey(TERM_TO, 1)]) {
      const preview = await previewOf(scene, { effectiveDate });
      expect(preview.statusCode, preview.body).toBe(422);
      const apply = await applyOf(scene, { effectiveDate });
      expect(apply.statusCode, apply.body).toBe(422);
      expect(apply.json<{ message: string }>().message).toContain('вне срока заявки');
    }
    expect(await snapshotOf(scene.requestId)).toEqual(before);
  });

  it('дата, которую дверь берёт и так, — та же команда: отпечаток не зависит от того, прислали ли её', async () => {
    const scene = await makeScene();
    const without = (await previewOf(scene, {})).json<AssignmentPreviewDto>();
    const withDate = await previewOf(scene, { effectiveDate: TODAY });
    expect(withDate.statusCode, withDate.body).toBe(200);
    expect(withDate.json<AssignmentPreviewDto>().fingerprint).toBe(without.fingerprint);
  });

  it('смена с будущей даты: дни до неё остаются за прежней машиной, с неё работает новая', async () => {
    const scene = await makeScene();
    const effectiveDate = shiftDateKey(MONDAY, 8);
    const preview = await previewOf(scene, { effectiveDate });
    const expected = byReadMode(mode, { legacy: 422, history: 200 });
    expect(preview.statusCode, preview.body).toBe(expected);
    const refusal = await applyOf(scene, { effectiveDate });
    if (expected === 422) {
      // A legacy refusal prevents silently changing the whole term.
      expect(refusal.statusCode, refusal.body).toBe(422);
      expect(await assignedVehicleOf(scene.requestId)).toBe(ctx.vehicleA.id);
      return;
    }
    const dto = preview.json<AssignmentPreviewDto>();
    const res = await applyOf(scene, {
      effectiveDate,
      previewFingerprint: dto.fingerprint,
      acknowledgements: acknowledgementsOf(dto.issues),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await assignedVehicleOf(scene.requestId)).toBe(ctx.vehicleB.id);
    // The history row of the new vehicle lies on the chosen day, not on today.
    const rows = (
      await ctx.db.execute<{ effective_date: string }>(sql`
        SELECT effective_date::text FROM vehicle_request_assignment_changes
         WHERE request_id = ${scene.requestId} AND dimension = 'vehicle'
           AND vehicle_id = ${ctx.vehicleB.id} AND superseded_at IS NULL`)
    ).rows;
    expect(rows.map((row) => row.effective_date)).toEqual([effectiveDate]);
    // No sheet of the new vehicle starts before that day.
    const early = (
      await ctx.db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM waybills
         WHERE source_request_id = ${scene.requestId} AND status <> 'cancelled'
           AND vehicle_id = ${ctx.vehicleB.id} AND period_from < ${effectiveDate}`)
    ).rows;
    expect(Number(early[0]!.n)).toBe(0);
  });

  it('дата в отработанной неделе: нужны причина и право, а листы закончившейся недели — только коррекцией', async () => {
    const scene = await makeScene();
    const before = await snapshotOf(scene.requestId);
    // The backdate guard must refuse a missing reason before any write.
    const noReason = await applyOf(scene, { effectiveDate: PAST_DAY });
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(noReason.json<{ message: string }>().message).toMatch(/причин/iu);
    expect(await snapshotOf(scene.requestId)).toEqual(before);

    // A reason does not unlock worked weeks: their sheets still require the correction block.
    const reasoned = await previewOf(scene, {
      effectiveDate: PAST_DAY,
      backdateReason: 'ехала другая машина — проверено по журналу объекта',
    });
    expect(reasoned.statusCode, reasoned.body).toBe(
      byReadMode(mode, { legacy: 422, history: 200 }),
    );
    const refused = await applyOf(scene, {
      effectiveDate: PAST_DAY,
      backdateReason: 'ехала другая машина — проверено по журналу объекта',
      ...(mode === 'history'
        ? {
            previewFingerprint: reasoned.json<AssignmentPreviewDto>().fingerprint,
            acknowledgements: acknowledgementsOf(reasoned.json<AssignmentPreviewDto>().issues),
          }
        : {}),
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(await snapshotOf(scene.requestId)).toEqual(before);
  });

  it('право менять технику не разрешает смену с прошедшей даты без права коррекции', async () => {
    const originalAdmin = ctx.admin;
    try {
      ctx.admin = await newAccount('manager');
      const scene = await makeScene();
      const before = await snapshotOf(scene.requestId);
      const res = await applyOf(scene, {
        effectiveDate: PAST_DAY,
        backdateReason: 'Вчера работала другая машина',
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ message: string }>().message).toBe(BACKDATE_PERMISSION_MESSAGE);
      expect(await snapshotOf(scene.requestId)).toEqual(before);
    } finally {
      ctx.admin = originalAdmin;
    }
  });

  it('прошедшая дата текущей недели сохраняет предыдущую машину до неё и записывает причину в историю', async () => {
    if (mode !== 'history') return;
    const originalAdmin = ctx.admin;
    // Freeze Date alone: HTTP and database timers must continue while the scene is on Thursday.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${shiftDateKey(MONDAY, 3)}T09:00:00+03:00`));
    try {
      ctx.admin = await newAccount('admin');
      const scene = await makeScene({ approvedDays: [MONDAY] });
      const effectiveDate = shiftDateKey(MONDAY, 1);
      const backdateReason = 'По журналу объекта со вторника работала другая машина';
      const preview = await previewOf(scene, { effectiveDate });
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<AssignmentPreviewDto>();
      expect(dto.blockedShiftDays).toEqual([]);
      const res = await applyOf(scene, {
        effectiveDate,
        backdateReason,
        previewFingerprint: dto.fingerprint,
        acknowledgements: acknowledgementsOf(dto.issues),
      });
      expect(res.statusCode, res.body).toBe(200);
      const history = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-requests/${scene.requestId}/history`,
        headers: ctx.admin.auth,
      });
      expect(history.statusCode, history.body).toBe(200);
      expect(history.body).toContain(backdateReason);
      expect(history.body).toContain('effectiveDate');
      const [signed] = (
        await ctx.db.execute<{ approved: boolean }>(sql`
        SELECT approved_at IS NOT NULL AS approved FROM vehicle_request_shifts
         WHERE request_id = ${scene.requestId} AND shift_date = ${MONDAY}`)
      ).rows;
      expect(signed?.approved).toBe(true);
      const sheets = (
        await ctx.db.execute<{ vehicle_id: string; period_from: string; period_to: string }>(sql`
        SELECT vehicle_id, period_from::text, period_to::text FROM waybills
         WHERE source_request_id = ${scene.requestId} AND status <> 'cancelled'
           AND period_from <= ${effectiveDate} AND period_to >= ${MONDAY}`)
      ).rows;
      expect(
        sheets.some((sheet) => sheet.vehicle_id === ctx.vehicleA.id && sheet.period_to === MONDAY),
      ).toBe(true);
      expect(
        sheets.some(
          (sheet) => sheet.vehicle_id === ctx.vehicleB.id && sheet.period_from === effectiveDate,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      ctx.admin = originalAdmin;
    }
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

    /*
     * Рукопожатие по листам (Б4) едет вместе с отпечатком: у машиниста сцены документов нет вовсе,
     * и в `history` дверь требует подпись по каждому выписываемому бланку. В `legacy` она не
     * требуется, но присланная проверяется и там — набор один и тот же, и команда проходит в обоих
     * режимах. Предмет случая от этого не меняется: он про отпечаток, а подпись сюда приезжает
     * ровно так же, как её привозит окно.
     */
    const res = await applyOf(scene, {
      previewFingerprint: dto.fingerprint,
      acknowledgements: acknowledgementsOf(dto.issues),
    });
    /*
     * One expectation for both modes, and it is a statement, not a coincidence: the fingerprint is
     * computed from the content of the consequences, not from the read mode; and in `history` the
     * door writes the history itself (ADR 0212) and inherits the scene's machinist, so nothing is
     * left for it to refuse.
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
    expect(Number(issued!.n)).toBe(
      dto.plan.issue.filter((sheet) => sheet.vehicleId === ctx.vehicleB.id).length,
    );
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
