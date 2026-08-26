import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wasteTicketReviewBlocker, wasteTicketReviewSettled } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { loadTicketCheckInputs as LoadInputs } from '../src/services/waste-ticket-inputs';
import type { wasteTicketChecks as Checks } from '../src/services/waste-ticket-checks';

/**
 * Вход сверки читается из живой базы (ADR 0114, Р15–Р24).
 *
 * Зачем база и зачем отдельно от `waste-ticket-checks.test.ts`. Сама сверка — чистая функция, и её
 * поведение проверено на выдуманных объектах. Здесь проверяется ДРУГОЕ: что строки таблиц
 * превращаются в её вход правильно. Между этими двумя вещами стоит преобразование, у которого нет
 * своего голоса: ошибись в нём — сверка продолжит работать безупречно, только на пустых полях.
 * Ровно это и случилось: маршрут собирал вход руками, формы разъехались, расхождение было
 * замазано `as never`, и все юнит-тесты остались зелёными, пока боевая карточка молча не сверяла
 * ничего.
 *
 * Значок сюда же: он считается той же сверкой, что и карточка, и разойтись с ней не должен —
 * пустой значок при живом фильтре «Требуют разбора» читается как ошибка портала.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-ticket-badge
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const suffix = randomUUID().slice(0, 8);
const MARK = `badge-probe-${suffix}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  loadInputs: typeof LoadInputs;
  checks: typeof Checks;
  objectId: string;
  userId: string;
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

/** Заявка на вывоз 40 м³, выполненная, с фактом закрытия ровно на заявленное. */
async function seedRequest(opts: {
  volumeM3?: number;
  factVolumeM3?: number;
  removedOn?: string | null;
  deliveryAt?: Date;
  /** Тип заявки: бумага разбирается только у вывоза мусора (ADR 0114, Р1). */
  requestType?: 'waste_removal' | 'container_removal' | 'metal_removal';
}): Promise<string> {
  const { db, schema } = ctx;
  const [request] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: opts.requestType ?? 'waste_removal',
      deliveryAt: opts.deliveryAt ?? new Date('2026-08-17T09:00:00.000Z'),
      createdBy: ctx.userId,
      status: 'done',
      comment: MARK,
      // У металлолома объёма не бывает вовсе (ADR 0067): вывезенное меряют весом, и CHECK схемы
      // такую строку не принимает.
      volumeM3:
        (opts.requestType ?? 'waste_removal') === 'metal_removal'
          ? null
          : String(opts.volumeM3 ?? 40),
      operatorCounterpartyId: ctx.operatorId,
    })
    .returning({ id: schema.wasteRequests.id });
  const id = request!.id;
  if (opts.factVolumeM3 !== undefined) {
    await db.insert(schema.wasteRequestCompletions).values({
      requestId: id,
      volumeM3: String(opts.factVolumeM3),
      removedOn: opts.removedOn === undefined ? '2026-08-17' : opts.removedOn,
      removedOnSource: opts.removedOn === null ? 'unknown' : 'entered',
      completedBy: ctx.userId,
    });
  }
  return id;
}

/**
 * Талон, приложенный к заявке при закрытии (`request_files.kind = 'ticket'`), — бумага как она
 * есть, ДО всякого распознавания. Строк `waste_ticket_files` он не заводит намеренно: именно так
 * выглядит закрытие при выключенном модуле и файл, чья задача не дошла до страниц.
 */
async function seedTicketFile(requestId: string): Promise<string> {
  const { db, schema } = ctx;
  const [file] = await db
    .insert(schema.files)
    .values({
      bucket: 'test',
      objectKey: `badge-${suffix}/${randomUUID()}.pdf`,
      filename: 'ticket.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.userId,
    })
    .returning({ id: schema.files.id });
  await db.insert(schema.requestFiles).values({ requestId, fileId: file!.id, kind: 'ticket' });
  return file!.id;
}

async function seedTicket(
  requestId: string,
  opts: {
    number: string;
    volumeM3?: number | null;
    issuedOn?: string | null;
    status?: 'unconfirmed' | 'confirmed' | 'dismissed';
    addressRaw?: string;
    seq?: number;
  },
): Promise<string> {
  const { db, schema } = ctx;
  const status = opts.status ?? 'confirmed';
  // Ручной талон схемой обязан быть подтверждённым (Р28: он создаётся сразу подтверждённым и
  // сразу занимает номер), поэтому неподтверждённый в тесте — всегда машинный.
  const origin = status === 'unconfirmed' ? ('ocr' as const) : ('manual' as const);
  const [ticket] = await db
    .insert(schema.wasteTickets)
    .values({
      requestId,
      seq: opts.seq ?? 1,
      origin,
      status,
      numberRaw: opts.number,
      numberKey: opts.number,
      numberFuzzy: opts.number,
      issuedOn: opts.issuedOn === undefined ? '2026-08-17' : opts.issuedOn,
      volumeM3:
        opts.volumeM3 === undefined ? '40' : opts.volumeM3 === null ? null : String(opts.volumeM3),
      workKind: 'removal',
      addressRaw: opts.addressRaw ?? '',
      operatorCounterpartyId: ctx.operatorId,
      createdBy: ctx.userId,
      confirmedBy: status === 'confirmed' ? ctx.userId : null,
      confirmedAt: status === 'confirmed' ? new Date() : null,
    })
    .returning({ id: schema.wasteTickets.id });
  return ticket!.id;
}

/** Вход + сверка одной заявки — тот же путь, которым идут карточка и список. */
async function badgeOf(requestId: string) {
  const { db, schema, loadInputs, checks } = ctx;
  const [row] = await db
    .select({
      id: schema.wasteRequests.id,
      num: schema.wasteRequests.num,
      objectId: schema.wasteRequests.objectId,
      objectName: schema.constructionObjects.name,
      objectAddress: schema.constructionObjects.address,
      requestType: schema.wasteRequests.requestType,
      volumeM3: schema.wasteRequests.volumeM3,
      deliveryAt: schema.wasteRequests.deliveryAt,
      operatorCounterpartyId: schema.wasteRequests.operatorCounterpartyId,
    })
    .from(schema.wasteRequests)
    .innerJoin(
      schema.constructionObjects,
      eq(schema.constructionObjects.id, schema.wasteRequests.objectId),
    )
    .where(eq(schema.wasteRequests.id, requestId));
  const bundles = await loadInputs([row!]);
  const bundle = bundles.get(requestId);
  return bundle ? checks(bundle.inputs) : null;
}

describe.skipIf(!DB_URL)('вход сверки талонов на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { loadTicketCheckInputs } = await import('../src/services/waste-ticket-inputs');
    const { wasteTicketChecks } = await import('../src/services/waste-ticket-checks');

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `badge-${suffix}`,
        name: `Площадка ${suffix}`,
        address: 'Волоколамское шоссе, 71к14',
      })
      .returning({ id: schema.constructionObjects.id });
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `badge-${suffix}@example.invalid`,
        lastName: 'Значков',
        firstName: 'Тест',
        middleName: '',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const [operator] = await db
      .insert(schema.counterparties)
      .values({ name: `Перевозчик ${suffix}`, type: 'operator', inn: '7700000000' })
      .returning({ id: schema.counterparties.id });

    ctx = {
      db,
      closeDb,
      schema,
      loadInputs: loadTicketCheckInputs,
      checks: wasteTicketChecks,
      objectId: object!.id,
      userId: user!.id,
      operatorId: operator!.id,
    };
  });

  afterAll(async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM construction_objects WHERE code = $1`, [`badge-${suffix}`]);
    await client.query(`DELETE FROM counterparties WHERE name = $1`, [`Перевозчик ${suffix}`]);
    await client.query(`DELETE FROM users WHERE email = $1`, [`badge-${suffix}@example.invalid`]);
    await client.end();
    await ctx?.closeDb();
  });

  it('сошедшиеся талоны дают пустой значок, а не отсутствие значка', async () => {
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `A${suffix}1`, volumeM3: 20 });
    await seedTicket(requestId, { number: `A${suffix}2`, volumeM3: 20, seq: 2 });

    const state = await badgeOf(requestId);
    expect(state).not.toBeNull();
    expect(state!.checks).toEqual([]);
    expect(state!.ticketsVolumeM3).toBe(40);
    expect(state!.badge).toEqual({
      errors: 0,
      warnings: 0,
      pendingConfirmation: 0,
      failures: 0,
      unreviewedPaper: 0,
    });
  });

  it('объём талонов против факта закрытия сверяется по прочитанным из базы цифрам', async () => {
    // Тот самый случай, который молчал: `requestedVolumeM3` и `completion` не доезжали до сверки,
    // и расхождение в 20 м³ не давало ни одного замечания.
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `B${suffix}`, volumeM3: 20 });

    const state = await badgeOf(requestId);
    const volume = state!.checks.find((c) => c.code === 'volume_mismatch');
    expect(volume).toBeDefined();
    expect(volume!.message).toContain('20');
    expect(volume!.message).toContain('40');
    expect(state!.badge.errors).toBe(1);
  });

  it('дата талона сверяется с днём вывоза, а не с датой закрытия в портале', async () => {
    const requestId = await seedRequest({ factVolumeM3: 40, removedOn: '2026-08-17' });
    await seedTicket(requestId, { number: `C${suffix}`, volumeM3: 40, issuedOn: '2026-07-30' });

    const state = await badgeOf(requestId);
    expect(state!.checks.some((c) => c.code === 'date_mismatch')).toBe(true);
  });

  it('адрес талона сверяется с адресом площадки, прочитанным из объекта', async () => {
    // Пока адрес объекта не доезжал до сверки, она сравнивала талон с пустой строкой и молчала
    // на любой чужой площадке.
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, {
      number: `D${suffix}`,
      volumeM3: 40,
      addressRaw: 'Ленинградское шоссе, 300',
    });

    const state = await badgeOf(requestId);
    expect(state!.checks.some((c) => c.code === 'address_mismatch')).toBe(true);
  });

  it('номер, уже предъявленный по чужой заявке, виден соседом', async () => {
    // Второй талон ещё не подтверждён — иначе его не пустил бы сам индекс уникальности (Р17).
    // Это и есть боевой порядок: сначала распознали и предупредили, и только потом человек решает,
    // подтверждать ли — с причиной «это разные бумаги» или без неё вовсе.
    const number = `E${suffix}`;
    const first = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(first, { number, volumeM3: 40 });

    const second = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(second, { number, volumeM3: 40, status: 'unconfirmed' });

    const state = await badgeOf(second);
    const duplicate = state!.checks.find((c) => c.code === 'duplicate_number');
    expect(duplicate).toBeDefined();
    // Видимость чужой заявки не передана — значит и номер её не назван (Р28).
    expect(duplicate!.message).toContain('по другой заявке');
    expect(state!.badge.errors).toBeGreaterThan(0);
  });

  it('неподтверждённый талон держит заявку в очереди и делает сверку предварительной', async () => {
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicket(requestId, { number: `F${suffix}`, volumeM3: 40, status: 'unconfirmed' });

    const state = await badgeOf(requestId);
    expect(state!.preliminary).toBe(true);
    expect(state!.acceptanceAllowed).toBe(false);
    expect(state!.badge.pendingConfirmation).toBe(1);
  });

  it('заявка без единой строки распознавания значка не получает вовсе', async () => {
    const requestId = await seedRequest({ factVolumeM3: 40 });
    expect(await badgeOf(requestId)).toBeNull();
  });

  it('приложенный талон без единого подтверждённого держит заявку в разборе', async () => {
    // Тот самый случай, который выкат 0195 счёл разобранным: бумага приложена, распознавания у неё
    // нет вовсе — значит и неподтверждённых талонов нет, и прежнее правило читало это как «всё
    // чисто». Разбирать здесь ровно всё.
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicketFile(requestId);

    const state = await badgeOf(requestId);
    expect(state).not.toBeNull();
    expect(state!.badge.unreviewedPaper).toBe(1);
    expect(wasteTicketReviewSettled(state!.badge)).toBe(false);
    expect(wasteTicketReviewBlocker(state!.badge)).toContain('приложенных талонов не разобрано: 1');
  });

  it('подтверждённый талон гасит признак нетронутой бумаги, отклонённый — нет', async () => {
    const requestId = await seedRequest({ factVolumeM3: 40 });
    await seedTicketFile(requestId);
    await seedTicket(requestId, { number: `G${suffix}`, volumeM3: 40, status: 'dismissed' });

    // «Это не талон» — не разбор бумаги, а вывод о том, что бумаги на кадре нет.
    const dismissedOnly = await badgeOf(requestId);
    expect(dismissedOnly!.badge.unreviewedPaper).toBe(1);

    await seedTicket(requestId, { number: `H${suffix}`, volumeM3: 40, seq: 2 });
    const confirmed = await badgeOf(requestId);
    expect(confirmed!.badge.unreviewedPaper).toBe(0);
    expect(wasteTicketReviewSettled(confirmed!.badge)).toBe(true);
  });

  it('у заявки, чья бумага разбору не подлежит, приложенный талон значка не даёт', async () => {
    // Снятие контейнера и металлолом в распознавание не ставятся (Р1): вывезенного объёма у первого
    // нет вовсе, второй закрывается весовой квитанцией. Считай мы их бумагу нетронутой — завершение
    // таких заявок закрылось бы навсегда.
    for (const requestType of ['container_removal', 'metal_removal'] as const) {
      const requestId = await seedRequest({ requestType });
      await seedTicketFile(requestId);
      expect(await badgeOf(requestId)).toBeNull();
    }
  });
});
