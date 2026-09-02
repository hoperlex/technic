import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  wasteTicketAutoConfirmReady,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
  wasteTicketReviewSettled,
  type WasteTicketBadgeDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Кнопка «подтвердить сошедшееся» — ручка `POST /waste-requests/:id/tickets/confirm-ready`
 * (ADR 0155, план `docs/waste-ticket-auto-confirm-plan.md`, Р16–Р17, Р23–Р24).
 *
 * ЗАЧЕМ ЧЕРЕЗ ЖИВЫЕ МАРШРУТЫ, А НЕ ЗАПРОСАМИ К БАЗЕ. Ручка — это цепочка, каждое звено которой
 * отменяет предыдущее: пересчёт под замком заявки, отпечаток набора, отбор готовых, пакетное
 * подтверждение, ПОВТОРНАЯ проверка постусловия и откат, журнал в той же транзакции. Проверь
 * половину из этого копией SQL — и копия останется зелёной ровно тогда, когда маршрут перестанет
 * применять правило. Здесь же и главная просьба выпуска C: кнопка обещает «✓», значит после неё
 * значок обязан стать нулевым, а заявка — завершаемой.
 *
 * Отпечаток набора не выдумывается: он берётся оттуда же, откуда его берёт портал, — из значка
 * карточки (`GET /:id/tickets` → `badge.confirmableFingerprint`). Собери его тест сам — и он
 * проверял бы собственную копию правила вместо того, которым отказывает сервер.
 *
 * Доля слепой перепроверки выставлена в единицу намеренно (Р7): «пакет в выборку не отбирает»
 * доказуемо только там, где всякое ДРУГОЕ подтверждение отбирает наверняка, — иначе пустая таблица
 * означала бы всего лишь неудачный жребий.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-ticket-confirm-ready.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8).toUpperCase();
const MARK = `confirm-ready-${RUN}`;
const PASSWORD = 'Confirm-Ready-1234';
/** ИНН уникален среди живых контрагентов: общая база теста делится с соседними прогонами. */
const INN = `77${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

interface Person {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  /** Разбирающий: у него право `wasteRequests.ticketReview`, им и нажимают кнопку. */
  reviewer: Person;
  objectId: string;
  operatorId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
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
  // Каждый пригодный талон уходил бы в перепроверку — если бы его туда отбирали. Ровно это и
  // проверяется: пакет не отбирает НИКОГДА, и доказать это можно только при доле 1 (Р7).
  process.env.TICKET_OCR_BLIND_CHECK_RATE = '1';
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

/** Свой адрес на запрос: вход ограничен десятью попытками в минуту с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function newPerson(tag: string): Promise<Person> {
  const { hashPassword } = await import('../src/auth/password');
  const email = `confirm-ready-${RUN}-${tag}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Пакетов',
      firstName: 'Тест',
      middleName: tag,
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return {
    id: created!.id,
    auth: { authorization: `Bearer ${login.json().accessToken as string}` },
  };
}

/**
 * Выполненная заявка с фактом закрытия — единственное состояние, в котором кнопка вообще возможна
 * (Р17): у невыполненной талоны не разбирают, у завершённой уже не правят.
 */
async function seedRequest(
  opts: {
    volumeM3?: number;
    factVolumeM3?: number;
    /** `null` — заявка «ничья»: область уникальности номера у неё своя (Р15). */
    operatorId?: string | null;
  } = {},
): Promise<string> {
  const { db, schema } = ctx;
  const [request] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-08-17T09:00:00.000Z'),
      createdBy: ctx.reviewer.id,
      status: 'done',
      comment: MARK,
      volumeM3: String(opts.volumeM3 ?? 40),
      operatorCounterpartyId: opts.operatorId === undefined ? ctx.operatorId : opts.operatorId,
    })
    .returning({ id: schema.wasteRequests.id });
  const id = request!.id;
  await db.insert(schema.wasteRequestCompletions).values({
    requestId: id,
    volumeM3: String(opts.factVolumeM3 ?? 40),
    removedOn: '2026-08-17',
    removedOnSource: 'entered',
    completedBy: ctx.reviewer.id,
  });
  return id;
}

/**
 * Машинный талон, как его заводит воркер: `origin = 'ocr'`, `status = 'unconfirmed'` и —
 * ГЛАВНОЕ — `operator_counterparty_id = NULL`. Талон «ничей» до подтверждения, оператора он
 * получает снимком в момент подтверждения (`job.ts`, Р15). Подставь тест оператора заранее — и
 * половина проверок этого файла проверяла бы состояние, которого в боевой базе не бывает.
 */
async function seedTicket(
  requestId: string,
  opts: {
    number: string;
    volumeM3?: number;
    seq?: number;
    addressRaw?: string;
    needsReviewFields?: string[];
    /** Подтверждённый талон-сосед: у него оператор уже проставлен, как после подтверждения. */
    confirmed?: boolean;
  },
): Promise<string> {
  const { db, schema } = ctx;
  const confirmed = opts.confirmed ?? false;
  const [ticket] = await db
    .insert(schema.wasteTickets)
    .values({
      requestId,
      seq: opts.seq ?? 1,
      origin: 'ocr',
      status: confirmed ? 'confirmed' : 'unconfirmed',
      numberRaw: opts.number,
      numberKey: wasteTicketNumberKey(opts.number),
      numberFuzzy: wasteTicketNumberFuzzy(opts.number),
      issuedOn: '2026-08-17',
      volumeM3: String(opts.volumeM3 ?? 20),
      workKind: 'removal',
      addressRaw: opts.addressRaw ?? '',
      needsReviewFields: opts.needsReviewFields ?? [],
      operatorCounterpartyId: confirmed ? ctx.operatorId : null,
      createdBy: ctx.reviewer.id,
      confirmedBy: confirmed ? ctx.reviewer.id : null,
      confirmedAt: confirmed ? new Date() : null,
    })
    .returning({ id: schema.wasteTickets.id });
  return ticket!.id;
}

/** Карточка разбора — тот же ответ, из которого портал берёт значок и отпечаток набора. */
async function cardOf(requestId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/${requestId}/tickets`,
    headers: ctx.reviewer.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    badge: WasteTicketBadgeDto;
    checks: { code: string; severity: string; message: string }[];
  };
}

async function badgeOf(requestId: string): Promise<WasteTicketBadgeDto> {
  return (await cardOf(requestId)).badge;
}

/** Нажатие кнопки: отпечаток приходит от портала не глядя, сервер сверяет его под замком (Р23). */
async function confirmReady(requestId: string, fingerprint: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waste-requests/${requestId}/tickets/confirm-ready`,
    headers: ctx.reviewer.auth,
    payload: { fingerprint },
  });
}

/** Строки талонов заявки в порядке предъявления: статус и снимок области — то, что меняет пакет. */
async function ticketsOf(requestId: string) {
  const { db, schema } = ctx;
  return db
    .select({
      id: schema.wasteTickets.id,
      status: schema.wasteTickets.status,
      operatorCounterpartyId: schema.wasteTickets.operatorCounterpartyId,
      confirmedBy: schema.wasteTickets.confirmedBy,
    })
    .from(schema.wasteTickets)
    .where(eq(schema.wasteTickets.requestId, requestId))
    .orderBy(asc(schema.wasteTickets.seq));
}

async function blindChecksOf(ticketIds: string[]): Promise<number> {
  if (ticketIds.length === 0) return 0;
  const { db, schema } = ctx;
  const rows = await db
    .select({ id: schema.wasteTicketBlindChecks.id })
    .from(schema.wasteTicketBlindChecks)
    .where(inArray(schema.wasteTicketBlindChecks.ticketId, ticketIds));
  return rows.length;
}

describe.skipIf(!DB_URL)('пакетное подтверждение талонов на живых маршрутах', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `confirm-ready-${RUN}`,
        name: `Площадка ${RUN}`,
        address: 'Волоколамское шоссе, 71к14',
      })
      .returning({ id: schema.constructionObjects.id });
    const [operator] = await db
      .insert(schema.counterparties)
      .values({ name: `Перевозчик ${RUN}`, type: 'operator', inn: INN })
      .returning({ id: schema.counterparties.id });

    ctx = {
      app,
      db,
      schema,
      closeDb,
      objectId: object!.id,
      operatorId: operator!.id,
      reviewer: null as never,
    };
    ctx.reviewer = await newPerson('reviewer');
  }, 240_000);

  afterAll(async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    // Журнал первым: `actor_user_id` ссылается на людей через `ON DELETE SET NULL`, поэтому после
    // удаления учёток строки остались бы в общей базе сиротами.
    await client.query(
      `DELETE FROM audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`confirm-ready-${RUN}-%`],
    );
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM construction_objects WHERE code = $1`, [
      `confirm-ready-${RUN}`,
    ]);
    await client.query(`DELETE FROM counterparties WHERE inn = $1`, [INN]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`confirm-ready-${RUN}-%`]);
    await client.end();
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('сошедшийся пакет подтверждается одним запросом, и значок становится нулевым', async () => {
    // Ровно тот случай, ради которого кнопка заведена: два машинных талона, сумма сошлась с
    // закрытием, спорить не о чем — и человеку незачем открывать карточку, чтобы дважды нажать
    // «подтвердить».
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `A${RUN}-1`, volumeM3: 20, seq: 1 });
    await seedTicket(requestId, { number: `A${RUN}-2`, volumeM3: 20, seq: 2 });

    const before = await badgeOf(requestId);
    expect(before.confirmable).toBe(2);
    expect(before.pendingConfirmation).toBe(2);
    expect(before.errors + before.warnings + before.failures + before.unreviewedPaper).toBe(0);
    // Портал рисует кнопку по этому предикату — сервер обязан отказывать по нему же (Р16).
    expect(wasteTicketAutoConfirmReady(before, 'done')).toBe(true);

    const res = await confirmReady(requestId, before.confirmableFingerprint);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, confirmed: 2 });

    const tickets = await ticketsOf(requestId);
    expect(tickets.map((t) => t.status)).toEqual(['confirmed', 'confirmed']);
    // Снимок области уникальности берётся с заявки в момент подтверждения (Р17): до нажатия талон
    // «ничей», и без снимка его номер не входил бы в индекс вовсе.
    expect(tickets.every((t) => t.operatorCounterpartyId === ctx.operatorId)).toBe(true);
    expect(tickets.every((t) => t.confirmedBy === ctx.reviewer.id)).toBe(true);

    // Кнопка обещала «✓» — проверяется факт, а не намерение: значок обязан стать нулевым, а
    // заявка — завершаемой (ADR 0135). Отпечаток пустеет вместе с набором: подтверждать больше
    // нечего.
    const after = await badgeOf(requestId);
    expect(after).toEqual({
      confirmable: 0,
      confirmableFingerprint: '',
      errors: 0,
      warnings: 0,
      pendingConfirmation: 0,
      failures: 0,
      unreviewedPaper: 0,
    });
    expect(wasteTicketReviewSettled(after)).toBe(true);

    // Материализованное состояние пересчитано ТОЙ ЖЕ транзакцией (Р19, Р23): иначе список показывал
    // бы кнопку над уже подтверждёнными талонами до первого промаха кэша.
    const [state] = await ctx.db
      .select()
      .from(ctx.schema.wasteTicketReviewState)
      .where(eq(ctx.schema.wasteTicketReviewState.requestId, requestId));
    expect(state).toBeDefined();
    expect(state!.stale).toBe(false);
    expect(state!.confirmable).toBe(0);
    expect(state!.pendingConfirmation).toBe(0);

    // Двойной клик (Р26): второй запрос с тем же отпечатком обязан отличаться от первого. «Ничего
    // не сделал» и «сделал» с одинаковым `ok: true` человек не различил бы никак.
    const again = await confirmReady(requestId, before.confirmableFingerprint);
    expect(again.statusCode, again.body).toBe(409);
    expect(String(again.json().message)).not.toHaveLength(0);
  });

  it('пакет не отбирает в слепую перепроверку даже при доле 1, а одиночное подтверждение отбирает', async () => {
    // Решение Р7 целиком: кнопка списка в выборку контроля качества не отбирает. Причина
    // продуктовая — ждущая перепроверка снова закрыла бы завершение, и обещанной «✓» человек не
    // увидел бы в одном случае из двадцати.
    //
    // Контроль в том же тесте обязателен: пустая таблица после пакета доказывает решение только
    // рядом с непустой после одиночного подтверждения. Иначе тот же ноль дала бы выключенная доля,
    // ошибка в `shouldSampleBlindCheck` или просто неудачный жребий — и тест молчал бы о том, что
    // выборка сломана целиком.
    const batchRequest = await seedRequest({ factVolumeM3: 40 });
    const batchTickets = [
      await seedTicket(batchRequest, { number: `B${RUN}-1`, volumeM3: 20, seq: 1 }),
      await seedTicket(batchRequest, { number: `B${RUN}-2`, volumeM3: 20, seq: 2 }),
    ];
    const badge = await badgeOf(batchRequest);
    const batch = await confirmReady(batchRequest, badge.confirmableFingerprint);
    expect(batch.statusCode, batch.body).toBe(200);
    expect(await blindChecksOf(batchTickets)).toBe(0);

    const singleRequest = await seedRequest({ factVolumeM3: 40 });
    const singleTicket = await seedTicket(singleRequest, {
      number: `B${RUN}-3`,
      volumeM3: 40,
      seq: 1,
    });
    const single = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${singleRequest}/tickets/${singleTicket}/confirm`,
      headers: ctx.reviewer.auth,
      payload: {},
    });
    expect(single.statusCode, single.body).toBe(200);
    expect(await blindChecksOf([singleTicket])).toBe(1);
  });

  it('чужой отпечаток набора — отказ: человек подписывался бы под бумагой, которой не видел', async () => {
    // Отпечаток, а не число (Р23): между отрисовкой строки и нажатием один талон может исчезнуть,
    // а другой появиться — счёт совпадёт, состав будет другим. Здесь отпечаток заведомо чужой, и
    // ручка обязана отказать, хотя по числам значка всё сходится.
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `C${RUN}-1`, volumeM3: 20, seq: 1 });
    await seedTicket(requestId, { number: `C${RUN}-2`, volumeM3: 20, seq: 2 });

    const badge = await badgeOf(requestId);
    expect(wasteTicketAutoConfirmReady(badge, 'done')).toBe(true);

    const res = await confirmReady(requestId, 'нечто');
    expect(res.statusCode, res.body).toBe(409);
    expect(String(res.json().message)).toContain('изменилось');

    // Отказ полный: ни одного подтверждённого талона и ни одной записи в журнале.
    const tickets = await ticketsOf(requestId);
    expect(tickets.map((t) => t.status)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(tickets.every((t) => t.operatorCounterpartyId === null)).toBe(true);
  });

  it('предупреждение сверки закрывает кнопку, и ручка отказывает словами, а не молча', async () => {
    // Адрес талона не похож на площадку — это ⚠️, а не ⛔: оно не мешает ни закрытию, ни
    // завершению. Кнопке — мешает: она обещает, что после клика в строке встанет «✓», а встало бы
    // предупреждение. Поэтому у пакета свой блокер, а не общий с завершением
    // (`wasteTicketReviewBlocker` при единственной причине «есть ⚠️» вернул бы `null`, и ручка
    // ответила бы 409 без текста).
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, {
      number: `D${RUN}`,
      volumeM3: 40,
      addressRaw: 'Ленинградское шоссе, 300',
    });

    const card = await cardOf(requestId);
    expect(card.checks.some((c) => c.code === 'address_mismatch')).toBe(true);
    expect(card.badge.warnings).toBe(1);
    // Талон по-прежнему «готов к подтверждению» — предупреждение не спор о цифрах; кнопки нет
    // именно из-за него, а не из-за состава набора.
    expect(card.badge.confirmable).toBe(1);
    expect(wasteTicketAutoConfirmReady(card.badge, 'done')).toBe(false);

    const res = await confirmReady(requestId, card.badge.confirmableFingerprint);
    expect(res.statusCode, res.body).toBe(409);
    expect(String(res.json().message)).toContain('предупреждений: 1');

    expect((await ticketsOf(requestId)).map((t) => t.status)).toEqual(['unconfirmed']);
  });

  it('журнал получает одну запись `ticket_auto_confirm` с обоими талонами', async () => {
    // Для этой ручки журнал — единственный след происхождения (Р3): по действию
    // `ticket_auto_confirm` и его `ticketIds` потом восстанавливают долю бумаги, принятой не
    // глядя. Поэтому он пишется `writeAuditTx` в той же транзакции: обычный `writeAudit` ошибку
    // намеренно глотает, и потерянная запись стёрла бы происхождение молча.
    const requestId = await seedRequest({ factVolumeM3: 40 });
    const first = await seedTicket(requestId, { number: `E${RUN}-1`, volumeM3: 20, seq: 1 });
    const second = await seedTicket(requestId, { number: `E${RUN}-2`, volumeM3: 20, seq: 2 });

    const badge = await badgeOf(requestId);
    const res = await confirmReady(requestId, badge.confirmableFingerprint);
    expect(res.statusCode, res.body).toBe(200);

    const rows = await ctx.db
      .select()
      .from(ctx.schema.auditLog)
      .where(
        and(
          eq(ctx.schema.auditLog.entityType, 'waste_request'),
          eq(ctx.schema.auditLog.entityId, requestId),
        ),
      );
    // Одна запись на всё действие, а не по одной на талон: пакет атомарен, и разложенный по
    // строкам журнал рассказывал бы о подтверждениях, которых по отдельности не было.
    expect(rows.map((r) => r.action)).toEqual(['waste_request.ticket_auto_confirm']);
    const metadata = rows[0]!.metadata as { ticketIds?: string[]; numbers?: string[] };
    expect([...(metadata.ticketIds ?? [])].sort()).toEqual([first, second].sort());
    expect([...(metadata.numbers ?? [])].sort()).toEqual([`E${RUN}-1`, `E${RUN}-2`].sort());
  });

  it('талон со спорным полем в пакет не идёт, и пакет отказывается целиком', async () => {
    // Спорное поле — это два разных чтения одной цифры (Р14): подтвердить его значит согласиться
    // с тем, чего никто не выбирал, и `confirmTicketTx` такой талон отбивает. Значок это знает
    // заранее — сверка не считает спорный талон в `confirmable`, — а равенство
    // `confirmable === pendingConfirmation` в предикате роняет кнопку у ВСЕЙ заявки. Иначе пакет
    // подтвердил бы соседа, а в строке осталось бы ⏳ после слова «подтверждено».
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `F${RUN}-1`, volumeM3: 20, seq: 1 });
    await seedTicket(requestId, {
      number: `F${RUN}-2`,
      volumeM3: 20,
      seq: 2,
      needsReviewFields: ['volumeM3'],
    });

    const badge = await badgeOf(requestId);
    expect(badge.pendingConfirmation).toBe(2);
    expect(badge.confirmable).toBe(1);
    expect(wasteTicketAutoConfirmReady(badge, 'done')).toBe(false);

    const res = await confirmReady(requestId, badge.confirmableFingerprint);
    expect(res.statusCode, res.body).toBe(409);
    expect(String(res.json().message)).toContain('ждут разбора человеком: 1');

    // Готовый сосед тоже остался неподтверждённым: частичного успеха у пакета нет.
    expect((await ticketsOf(requestId)).map((t) => t.status)).toEqual([
      'unconfirmed',
      'unconfirmed',
    ]);
  });

  it('похожий номер у оператора заявки виден ДО нажатия, а не после него', async () => {
    // Постусловие Р15 с той стороны, где оно дешевле всего: неподтверждённый талон «ничей», и
    // считай сверка его по собственной пустой области — предупреждение о похожем номере всплыло бы
    // ПОСЛЕ подтверждения, то есть ровно там, где кнопка обещала «✓». Поэтому вход сверки
    // подставляет неподтверждённому талону оператора ЗАЯВКИ — ту область, в которой он окажется.
    //
    // Пара номеров различается только знаками, неразличимыми на бумаге: кириллические «М» и «О»
    // против латинской «M» и нуля. Ключи у них разные (запрета нет), поисковые нормализации
    // совпадают — значит предупреждение, а не отказ.
    const neighbourRequest = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(neighbourRequest, { number: `M-0${RUN}`, volumeM3: 40, confirmed: true });

    const requestId = await seedRequest({ factVolumeM3: 40 });
    const ticketId = await seedTicket(requestId, { number: `М-О${RUN}`, volumeM3: 40 });

    const card = await cardOf(requestId);
    expect(card.checks.some((c) => c.code === 'similar_number')).toBe(true);
    expect(card.badge.warnings).toBe(1);
    expect(wasteTicketAutoConfirmReady(card.badge, 'done')).toBe(false);

    // Область в базе по-прежнему не проставлена: подстановка живёт во ВХОДЕ сверки, а не в данных.
    const [row] = await ticketsOf(requestId);
    expect(row!.id).toBe(ticketId);
    expect(row!.operatorCounterpartyId).toBeNull();

    const res = await confirmReady(requestId, card.badge.confirmableFingerprint);
    expect(res.statusCode, res.body).toBe(409);
    expect(String(res.json().message)).toContain('предупреждений: 1');
  });
});
