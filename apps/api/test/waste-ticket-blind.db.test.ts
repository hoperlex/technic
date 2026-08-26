import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import { eq as sqlEq, sql as sqlRaw } from 'drizzle-orm';

/**
 * Разбор талона на живых маршрутах: слепая перепроверка (Р31) и предложения перераспознавания
 * (Р13) — ADR 0114.
 *
 * Зачем через `inject`, а не запросами к базе. Всё ценное здесь — это ЗАПРЕТЫ, и живут они в
 * маршруте: подтвердивший талон не читает его второй раз, проверяющий не разбирает собственное
 * расхождение, чужая строка перепроверки не находится по идентификатору. Проверь их SQL-копией —
 * и копия останется зелёной ровно тогда, когда маршрут перестанет их применять.
 *
 * Доля выборки выставлена в единицу: отбор случайный, и тест, полагающийся на жребий, был бы
 * тестом генератора случайных чисел.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-ticket-blind.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Blind-Check-1234';

interface Person {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  /** Подтверждает талоны: ему перепроверка своей же бумаги запрещена. */
  owner: Person;
  /** Читает бумагу вторым. */
  checker: Person;
  /** Третий: разбирает расхождение. */
  arbiter: Person;
  objectId: string;
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
  // Каждый подтверждённый машинный талон уходит в перепроверку: жребий в тесте проверял бы
  // `Math.random`, а не правило.
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
  const email = `blind-${RUN}-${tag}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Слепов',
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

/** Выполненная заявка с машинным неподтверждённым талоном — то, с чего начинается разбор. */
async function seedTicket(rawNumber: string): Promise<{ requestId: string; ticketId: string }> {
  const { db, schema } = ctx;
  const { wasteTicketNumberFuzzy, wasteTicketNumberKey } = await import('@technic/contracts');
  // Ключ нормализуется так же, как его пишет воркер: сравнение чтений идёт по ключу, и талон с
  // ненормализованным ключом разошёлся бы с любым чтением из-за одного регистра.
  const number = rawNumber.toUpperCase();
  const [request] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-08-17T09:00:00.000Z'),
      createdBy: ctx.owner.id,
      status: 'done',
      comment: `blind-${RUN}`,
      volumeM3: '20',
    })
    .returning({ id: schema.wasteRequests.id });
  const [ticket] = await db
    .insert(schema.wasteTickets)
    .values({
      requestId: request!.id,
      seq: 1,
      origin: 'ocr',
      status: 'unconfirmed',
      numberRaw: number,
      numberKey: wasteTicketNumberKey(number),
      numberFuzzy: wasteTicketNumberFuzzy(number),
      issuedOn: '2026-08-17',
      volumeM3: '20',
      workKind: 'removal',
      addressRaw: '',
      createdBy: ctx.owner.id,
    })
    .returning({ id: schema.wasteTickets.id });
  return { requestId: request!.id, ticketId: ticket!.id };
}

/** Подтверждение владельцем: оно же заводит задание перепроверки (доля равна единице). */
async function confirm(requestId: string, ticketId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/confirm`,
    headers: ctx.owner.auth,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function queueOf(person: Person): Promise<{ id: string; ticketId: string }[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/waste-requests/ticket-blind-checks',
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as { id: string; ticketId: string }[];
}

describe.skipIf(!DB_URL)('слепая перепроверка на живых маршрутах', () => {
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
      .values({ code: `blind-${RUN}`, name: `Площадка ${RUN}`, address: 'Волоколамское ш., 71к14' })
      .returning({ id: schema.constructionObjects.id });

    ctx = {
      app,
      db,
      schema,
      closeDb,
      objectId: object!.id,
      owner: null as never,
      checker: null as never,
      arbiter: null as never,
    };
    ctx.owner = await newPerson('owner');
    ctx.checker = await newPerson('checker');
    ctx.arbiter = await newPerson('arbiter');
  }, 240_000);

  afterAll(async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [`blind-${RUN}`]);
    await client.query(`DELETE FROM construction_objects WHERE code = $1`, [`blind-${RUN}`]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`blind-${RUN}-%`]);
    await client.end();
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('подтверждение машинного талона заводит задание, и подтвердившему его не показывают', async () => {
    const { requestId, ticketId } = await seedTicket(`A${RUN}`);
    await confirm(requestId, ticketId);

    // Владельцу задания не видно: он уже согласился с этими цифрами, и «второе чтение» мерило бы
    // его память, а не рукопись.
    expect((await queueOf(ctx.owner)).some((t) => t.ticketId === ticketId)).toBe(false);
    expect((await queueOf(ctx.checker)).some((t) => t.ticketId === ticketId)).toBe(true);
  });

  it('очередь не отдаёт ни одного прочитанного значения', async () => {
    const { requestId, ticketId } = await seedTicket(`B${RUN}`);
    await confirm(requestId, ticketId);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-blind-checks',
      headers: ctx.checker.auth,
    });
    // Слепота держится составом ответа, а не вёрсткой: приедь цифры в браузер — и вся метрика
    // зависела бы от того, открыл человек инструменты разработчика или нет.
    expect(res.body).not.toContain(`B${RUN}`.toUpperCase());
    expect(res.body).not.toContain('2026-08-17');
    expect(res.body).not.toContain('volumeM3');
  });

  it('подтвердившему чтение запрещено, даже если задание он нашёл', async () => {
    const { requestId, ticketId } = await seedTicket(`C${RUN}`);
    await confirm(requestId, ticketId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/blind-check`,
      headers: ctx.owner.auth,
      payload: { number: `C${RUN}`.toUpperCase(), issuedOn: '2026-08-17', volumeM3: 20 },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('совпавшее чтение закрывает задание само', async () => {
    const { requestId, ticketId } = await seedTicket(`D${RUN}`);
    await confirm(requestId, ticketId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: `D${RUN}`.toUpperCase(), issuedOn: '2026-08-17', volumeM3: 20 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('match');
    // Взятое задание из очереди уходит: гонка двух проверяющих решается в пользу первого.
    expect((await queueOf(ctx.checker)).some((t) => t.ticketId === ticketId)).toBe(false);
  });

  it('разошедшееся чтение ждёт третьего: проверяющий сам себя не разбирает', async () => {
    const { requestId, ticketId } = await seedTicket(`E${RUN}`);
    await confirm(requestId, ticketId);

    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: `E${RUN}`.toUpperCase(), issuedOn: '2026-08-17', volumeM3: 28 },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().status).toBe('mismatch');
    const blindCheckId = read.json().id as string;

    const own = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/blind-checks/${blindCheckId}/arbitrate`,
      headers: ctx.checker.auth,
      payload: { resolvedFields: ['volumeM3'], volumeM3: 20 },
    });
    expect(own.statusCode, own.body).toBe(403);

    const byOwner = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/blind-checks/${blindCheckId}/arbitrate`,
      headers: ctx.owner.auth,
      payload: { resolvedFields: ['volumeM3'], volumeM3: 20 },
    });
    // Подтвердивший талон — тоже сторона: он уже сказал, что цифры верны.
    expect(byOwner.statusCode, byOwner.body).toBe(403);

    const byArbiter = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/blind-checks/${blindCheckId}/arbitrate`,
      headers: ctx.arbiter.auth,
      payload: { resolvedFields: ['volumeM3'], volumeM3: 20 },
    });
    expect(byArbiter.statusCode, byArbiter.body).toBe(200);
  });

  it('неполный разбор отбивается словами, а не ошибкой базы', async () => {
    // Разошлись оба поля — номер и объём, — а арбитр называет только объём. Полноту держит и
    // `CHECK`, но его нарушение вернуло бы 500: человек узнал бы, что запрос не прошёл, и не узнал
    // бы, что осталось разобрать.
    const { requestId, ticketId } = await seedTicket(`H${RUN}`);
    await confirm(requestId, ticketId);
    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: `H${RUN}X`.toUpperCase(), issuedOn: '2026-08-17', volumeM3: 28 },
    });
    expect(read.json().status).toBe('mismatch');

    const partial = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/blind-checks/${read.json().id as string}/arbitrate`,
      headers: ctx.arbiter.auth,
      payload: { resolvedFields: ['volumeM3'], volumeM3: 20 },
    });
    expect(partial.statusCode, partial.body).toBe(400);
    expect(partial.body).toContain('Номер');

    // Полный разбор той же строки проходит: отказ был про полноту, а не про саму строку.
    const full = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/blind-checks/${read.json().id as string}/arbitrate`,
      headers: ctx.arbiter.auth,
      payload: {
        resolvedFields: ['number', 'volumeM3'],
        number: `H${RUN}`.toUpperCase(),
        volumeM3: 20,
      },
    });
    expect(full.statusCode, full.body).toBe(200);
  });

  it('строка перепроверки из чужой заявки не находится по идентификатору', async () => {
    const first = await seedTicket(`F${RUN}`);
    await confirm(first.requestId, first.ticketId);
    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${first.requestId}/tickets/${first.ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: `F${RUN}X`.toUpperCase(), issuedOn: null, volumeM3: null },
    });
    expect(read.statusCode, read.body).toBe(200);
    const blindCheckId = read.json().id as string;

    const other = await seedTicket(`G${RUN}`);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${other.requestId}/blind-checks/${blindCheckId}/arbitrate`,
      headers: ctx.arbiter.auth,
      payload: { resolvedFields: ['number'], number: `F${RUN}`.toUpperCase() },
    });
    // 404, а не 403: «она есть, но не ваша» позволяло бы перебирать чужие заявки номерами.
    expect(res.statusCode, res.body).toBe(404);
  });

  describe('портал не молчит о том, что бумагу никто не читал (Р29)', () => {
    /**
     * Самая дорогая ошибка модуля — не сбой, а тишина: заявка с приложенным, но не прочитанным
     * талоном выглядит проверенной. Проверяется целиком через маршруты, потому что складывается
     * она из трёх источников сразу: состояния подсистемы, состава файлов в ответе и того, что
     * скажет кнопка «перераспознать».
     */
    async function attachTicketFile(requestId: string): Promise<string> {
      const [file] = await ctx.db
        .insert(ctx.schema.files)
        .values({
          bucket: 'test',
          objectKey: `blind-${RUN}/${randomUUID()}.jpg`,
          filename: 'talon.jpg',
          contentType: 'image/jpeg',
          size: 1024,
          uploadedBy: ctx.owner.id,
        })
        .returning({ id: ctx.schema.files.id });
      await ctx.db
        .insert(ctx.schema.requestFiles)
        .values({ requestId, fileId: file!.id, kind: 'ticket' });
      return file!.id;
    }

    it('выключенный модуль называет себя выключенным, а не исправным', async () => {
      // `TICKET_OCR_ENABLED` в этом прогоне не выставлен, то есть выключено. Скажи ручка «ok» —
      // баннер не появился бы, и портал написал бы «расхождений нет» над нечитанной бумагой.
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/waste-requests/ticket-recognition/health',
        headers: ctx.owner.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().state).toBe('disabled');
    });

    it('приложенный, но не разобранный талон виден в ответе карточки', async () => {
      const { requestId } = await seedTicket(`W${RUN}`);
      const fileId = await attachTicketFile(requestId);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/waste-requests/${requestId}/tickets`,
        headers: ctx.owner.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      const file = (res.json().files as { fileId: string; status: string; reason: string }[]).find(
        (f) => f.fileId === fileId,
      );
      // Строки распознавания у него нет — она заводится вместе с задачей, а задач не было. Раньше
      // такой талон не попадал в ответ вовсе, и экран показывал пустоту.
      expect(file).toBeDefined();
      expect(file!.status).toBe('not_queued');
      expect(file!.reason).toContain('в разбор не поступал');
    });

    it('«перераспознать» при выключенном модуле отказывает, а не обещает', async () => {
      const { requestId } = await seedTicket(`X${RUN}`);
      const fileId = await attachTicketFile(requestId);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/ticket-files/${fileId}/recognize`,
        headers: ctx.owner.auth,
        payload: {},
      });
      // Постановка задачи при выключенном модуле молча ничего не делает — и без этой проверки
      // кнопка отвечала бы «отправлено», не отправив ничего.
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('выключено');
    });
  });

  describe('журнал распознавания и разбора (Р30)', () => {
    /**
     * Самый сильный сигнал качества модели — исправление оператора, и до этого журнала он пропадал
     * целиком: талон помнит только последнее значение, а общий аудит писал лишь имя поля. Теперь
     * «было → стало» сохраняется вместе с моделью, версией промпта и числом проходов каскада.
     */
    async function eventsOf(ticketId: string) {
      const rows = await ctx.db.execute<{
        event: string;
        field: string;
        old_value: string | null;
        new_value: string | null;
        model: string;
        passes: number;
        actor_id: string | null;
      }>(
        sqlRaw`SELECT event, field, old_value, new_value, model, passes, actor_id
                 FROM waste_ticket_field_events
                WHERE ticket_id = ${ticketId}::uuid
                ORDER BY created_at, field`,
      );
      return rows.rows;
    }

    it('правка пишет прежнее и новое значение', async () => {
      const { requestId, ticketId } = await seedTicket(`J${RUN}`);

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}`,
        headers: ctx.owner.auth,
        payload: { volumeM3: 38 },
      });
      expect(res.statusCode, res.body).toBe(200);

      const events = await eventsOf(ticketId);
      const edited = events.filter((e) => e.event === 'edited');
      expect(edited).toHaveLength(1);
      // Ровно тот случай, ради которого журнал заведён: модель прочитала 20, на бумаге 38.
      expect(edited[0]!.field).toBe('volumeM3');
      expect(Number(edited[0]!.old_value)).toBe(20);
      expect(Number(edited[0]!.new_value)).toBe(38);
      // Человеческое событие обязано знать человека — иначе непонятно, кто исправил.
      expect(edited[0]!.actor_id).toBe(ctx.owner.id);
    });

    it('подтверждение событий не заводит: согласие ничего не говорит о качестве', async () => {
      const { requestId, ticketId } = await seedTicket(`K${RUN}`);
      await confirm(requestId, ticketId);

      // Человек смотрит на подставленное значение и склонен согласиться (Р31) — писать пять строк
      // на каждый талон ради слабейшего сигнала незачем. Знаменатель берётся по `recognized`.
      expect(await eventsOf(ticketId)).toHaveLength(0);
    });

    it('«не талон» пишется по всем полям и без нового значения', async () => {
      const { requestId, ticketId } = await seedTicket(`L${RUN}`);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/dismiss`,
        headers: ctx.owner.auth,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);

      const events = await eventsOf(ticketId);
      // Модель увидела бумагу там, где её нет: поля не менялись, изменилась их судьба.
      expect(events.every((e) => e.event === 'dismissed')).toBe(true);
      expect(events.every((e) => e.new_value === null)).toBe(true);
      expect(events.map((e) => e.field).sort()).toEqual([
        'addressRaw',
        'issuedOn',
        'number',
        'volumeM3',
        'workKind',
      ]);
    });

    it('машинное событие человека не называет', async () => {
      // `recognized` совершила модель, и приписать его сотруднику нельзя — это держит `CHECK`.
      // Обратное не проверяется намеренно: удаление учётки обнуляет актора у прошлых правок, и
      // двусторонняя проверка запрещала бы кадровые действия ради журнала.
      const { requestId, ticketId } = await seedTicket(`M${RUN}`);
      await expect(
        ctx.db.execute(sqlRaw`
          INSERT INTO waste_ticket_field_events
            (ticket_id, request_id, event, field, new_value, actor_id)
          VALUES (${ticketId}::uuid, ${requestId}::uuid, 'recognized', 'volumeM3', '38',
                  ${ctx.owner.id}::uuid)
        `),
      ).rejects.toThrow();
    });
  });

  describe('предложение перераспознавания', () => {
    /** Предложение рядом с подтверждённым талоном — то, что кладёт воркер после нового прохода. */
    async function seedProposal(
      ticketId: string,
      values: { number: string; issuedOn: string | null; volumeM3: string | null },
    ): Promise<void> {
      await ctx.db.insert(ctx.schema.wasteTicketProposals).values({
        ticketId,
        numberRaw: values.number,
        issuedOn: values.issuedOn,
        volumeM3: values.volumeM3,
        workKind: 'removal',
        addressRaw: '',
      });
    }

    it('принятие переносит значения в талон и уносит предложение', async () => {
      const { requestId, ticketId } = await seedTicket(`P${RUN}`);
      await confirm(requestId, ticketId);
      await seedProposal(ticketId, { number: `P${RUN}NEW`.toUpperCase(), issuedOn: '2026-08-18', volumeM3: '25' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/proposal/accept`,
        headers: ctx.owner.auth,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);

      const [ticket] = await ctx.db
        .select()
        .from(ctx.schema.wasteTickets)
        .where(sqlEq(ctx.schema.wasteTickets.id, ticketId));
      expect(ticket!.numberRaw).toBe(`P${RUN}NEW`.toUpperCase());
      expect(ticket!.issuedOn).toBe('2026-08-18');
      // Принятие — правка: талон помечается тронутым, и следующий проход уже не перепишет его молча.
      expect(ticket!.editedAt).not.toBeNull();
      // Происхождение не меняется: `origin` про то, откуда строка взялась, а не кто её касался.
      expect(ticket!.origin).toBe('ocr');

      const left = await ctx.db
        .select()
        .from(ctx.schema.wasteTicketProposals)
        .where(sqlEq(ctx.schema.wasteTicketProposals.ticketId, ticketId));
      expect(left).toHaveLength(0);
    });

    it('отклонение талон не трогает, а строку уносит', async () => {
      const { requestId, ticketId } = await seedTicket(`Q${RUN}`);
      await confirm(requestId, ticketId);
      await seedProposal(ticketId, { number: `Q${RUN}NEW`.toUpperCase(), issuedOn: null, volumeM3: null });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/proposal/dismiss`,
        headers: ctx.owner.auth,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);

      const [ticket] = await ctx.db
        .select()
        .from(ctx.schema.wasteTickets)
        .where(sqlEq(ctx.schema.wasteTickets.id, ticketId));
      // Человек уже сказал, что написано на бумаге, и новый проход этого не отменяет.
      expect(ticket!.numberRaw).toBe(`Q${RUN}`.toUpperCase());
      expect(ticket!.editedAt).toBeNull();
    });

    it('принимать нечего — отказ словами, а не тишиной', async () => {
      const { requestId, ticketId } = await seedTicket(`R${RUN}`);
      await confirm(requestId, ticketId);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/tickets/${ticketId}/proposal/accept`,
        headers: ctx.owner.auth,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(400);
    });

    it('принятие, упирающееся в занятый номер, отбивается 409 и принимает причину', async () => {
      // Предложение — не обход уникальности: бумага, чей номер уже занят, остаётся конфликтующей,
      // кто бы её ни прочитал (Р13, Р27).
      const busy = await seedTicket(`S${RUN}`);
      await confirm(busy.requestId, busy.ticketId);

      const other = await seedTicket(`T${RUN}`);
      await confirm(other.requestId, other.ticketId);
      await seedProposal(other.ticketId, { number: `S${RUN}`.toUpperCase(), issuedOn: null, volumeM3: null });

      const conflict = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${other.requestId}/tickets/${other.ticketId}/proposal/accept`,
        headers: ctx.owner.auth,
        payload: {},
      });
      expect(conflict.statusCode, conflict.body).toBe(409);

      const withReason = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${other.requestId}/tickets/${other.ticketId}/proposal/accept`,
        headers: ctx.owner.auth,
        payload: { duplicateOverrideReason: 'разные книжки перевозчика' },
      });
      expect(withReason.statusCode, withReason.body).toBe(200);
      expect(withReason.json().duplicateOverrideApplied).toBe(true);
    });
  });
});
