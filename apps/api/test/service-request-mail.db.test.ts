import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as ServiceMail from '../src/services/service-request-mail';

/**
 * Письма по заявке на обслуживание (план `docs/office-equipment-mail-and-history-plan.md`,
 * Р65–Р70, Р91; письмо о назначении — `office-equipment-requests-rework-plan.md`, §7.3, Н13).
 *
 * Ценность проверки не в том, что письмо составилось, а в том, **когда** оно составилось, сколько
 * их вышло и **кому**. Событие привязано к входу в статус, а не к ручке: «Новой» заявка бывает и при
 * заведении, и вернувшись откатом, — и служба ждёт её в обоих случаях. Ключ дедупликации при этом
 * обязан различать и повторные циклы, и адресатов: уникальность очереди — `(kind, dedupe_key)`, и
 * ошибка здесь означает не лишнее письмо, а **молча пропавшее**.
 *
 * Письмо о назначении проверяется по третьему вопросу — кому: у него адресат не служба, а люди, и
 * ошибка в списке означает либо задание, ушедшее мимо исполнителя, либо разглашение движения по
 * заявке тем, кому оно не адресовано.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-request-mail
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';
const SERVICE_MAILBOX = `repair-${RUN}@example.invalid`;
const COPY_MAILBOX = `copy-${RUN}@example.invalid`;
/** Копия на событие назначения: «хочу видеть все назначения» — сторонний наблюдатель. */
const ASSIGN_COPY_MAILBOX = `assign-copy-${RUN}@example.invalid`;
/**
 * ИНН контрагентов прогона: десять цифр, уникальные среди живых строк. Из суффикса прогона его не
 * собрать — тот шестнадцатеричный, а `counterparties_inn_format_check` принимает только цифры.
 */
const inn = (): string => String(7_000_000_000 + Math.floor(Math.random() * 999_999_999));
const SERVICE_INN = inn();
const EMPTY_INN = inn();
const MAILBOX_INN = inn();
const OPERATORS_INN = inn();

/**
 * Общий ящик сервисной компании (ADR 0153) — адрес самой организации, а не её учётки. Ради него всё
 * и затевалось: подрядчик читает почту, а в портал не входит.
 */
const CONTRACTOR_MAILBOX = `contractor-${RUN}@example.invalid`;
/** Тот же ящик у компании, за которой нет ни одной учётки: единственный адресат её заданий. */
const MAILBOX_ONLY_CONTRACTOR = `contractor-solo-${RUN}@example.invalid`;

interface Auth {
  authorization: string;
}

/** Учётка фикстуры: письмо о назначении адресуется людям, и одного адреса ему мало — нужен id. */
interface Person {
  id: string;
  email: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  customer: Auth;
  customerEmail: string;
  /** Своя единица на каждый сценарий: по одной технике незакрытая заявка бывает только одна. */
  newEquipment: (tag: string) => Promise<string>;
  /**
   * Почтовый модуль целиком: ручка `PUT /:id/executors` приезжает соседней зоной той же волны, и
   * до неё письмо о назначении проверяется там, где оно живёт, — на своих функциях. Импорт
   * ленивый, как у приложения: модуль читает конфигурацию на загрузке.
   */
  mail: typeof ServiceMail;
  people: {
    admin: Person;
    /** Автор заявки: письма о назначении он не получает, но обратный адрес — его (В16). */
    customer: Person;
    /** Свои сисадмины, назначаемые поимённо. */
    exec1: Person;
    exec2: Person;
    /** Оператор сервисной компании: он читает почту за всю компанию (§4.2). */
    operator: Person;
    /** Оператор компании без общего ящика. */
    operatorNoMailbox: Person;
    /** Отключённая учётка: адресатом задания быть не может. */
    retired: Person;
  };
  /** Сервисная компания с оператором в портале и такая же — без единой учётки. */
  serviceCounterpartyId: string;
  emptyCounterpartyId: string;
  /** Компания без учёток, но с общим ящиком в карточке (ADR 0153). */
  mailboxCounterpartyId: string;
  /** Компания с учётками и пустым полем адреса — зеркальный случай. */
  operatorsCounterpartyId: string;
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
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  // Канал службы настроен: он и отправитель, и получатель писем модуля (Р88).
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${SERVICE_MAILBOX}>`;
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

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.30.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/**
 * Адресаты, за которых отвечает этот файл: ящик самого канала (`channel`), копии, которые он
 * заводит сам (ключ — идентификатор строки адресата), и учётки его же фикстур, назначенные
 * исполнителями (ключ — идентификатор учётки).
 *
 * Набор пополняется по ходу: строка копии появляется в своём сценарии, и до него её ключа не
 * существует.
 */
const ownRecipients = new Set<string>(['channel']);

/**
 * Письма по заявке — те, что журнал записал на её сущность **по подпискам этого файла**.
 *
 * Отбор по ключу адресата, а не по всей сущности. База у db-тестов общая, а список копий
 * (`module_mail_recipients`) — один на весь портал: соседний файл (`module-mail-recipients`)
 * заводит своих адресатов на те же события и держит их до конца своего прогона. Портал в это время
 * рассылает верно — каждой включённой строке по письму, — но к нашей заявке добавляются чужие
 * копии, и «письмо на событие одно» превращалось в «пять вместо трёх» на ровном месте.
 *
 * Ключ дедупликации собран как `событие:строка истории:адресат[:ключ повтора]`, и третье поле
 * говорит, КАКОЙ подпиской письмо вызвано, — а не куда оно ушло. Поэтому проверки не ослабли:
 * адрес письма по-прежнему сверяется целиком (уйди письмо канала не на тот ящик, оно останется в
 * выборке и уронит сверку), счёт по-прежнему точный, а спрятать пропавшее письмо отбор не может —
 * своих подписок он не выкидывает.
 */
async function mailsOf(requestId: string) {
  const res = await ctx.db.execute<{
    kind: string;
    to_email: string;
    reply_to: string;
    account: string;
    subject: string;
    dedupe_key: string;
    body_text: string;
  }>(sql`SELECT kind, to_email, reply_to, account, subject, dedupe_key, body_text FROM mail_messages
          WHERE entity_type = 'serviceRequest' AND entity_id = ${requestId}
            AND split_part(dedupe_key, ':', 3) = ANY(${sql.param([...ownRecipients])}::text[])
          ORDER BY created_at`);
  return res.rows;
}

async function createRequest(equipmentId: string, description: string) {
  const res = await inject('POST', '/api/v1/service-requests', ctx.customer, {
    officeEquipmentId: equipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { request: ServiceRequestDto; mail: string };
}

describe.skipIf(!DB_URL)('письма службе по заявке (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SM-${RUN}`}, ${`Площадка писем ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      opts: { counterpartyId?: string; isActive?: boolean } = {},
    ): Promise<Person> {
      const email = `db-sm-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           counterparty_id, is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, ${opts.counterpartyId ?? null},
                ${opts.isActive ?? true}, now())
        RETURNING id`);
      if (role !== 'admin') {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${row.rows[0]!.id}, ${objectId})`);
      }
      return { id: row.rows[0]!.id, email };
    }

    /** Сервисная компания: исполнителем заявки бывает только контрагент типа `service`. */
    async function makeService(name: string, innValue: string, email = ''): Promise<string> {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn, email)
        VALUES ('service', ${`${name} ${RUN}`}, ${innValue}, ${email})
        RETURNING id`);
      return row.rows[0]!.id;
    }

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]!.id;

    // Суффикс прогона стоит и в наименовании, а не только в инвентарном номере: с миграции
    // `0171` наименование карточки — это имя строки справочника `office_equipment_models`, и
    // вставка без `model_id` заводит модель сама. По этому же суффиксу уборка её и находит.
    const equipment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
        VALUES (${typeId}, ${`МФУ ${tag} ${RUN}`}, ${`СМ-${RUN}-${tag}`}, ${objectId})
        RETURNING id`);
      return row.rows[0]!.id;
    };

    const app = await buildApp();
    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }

    const serviceCounterpartyId = await makeService(
      'Сервис писем',
      SERVICE_INN,
      CONTRACTOR_MAILBOX,
    );
    // Без учёток и без адреса: единственное состояние, при котором заданию уйти некуда.
    const emptyCounterpartyId = await makeService('Сервис без учёток', EMPTY_INN);
    // Без учёток, но с ящиком — то самое, ради чего заведена колонка: подрядчик вне портала.
    const mailboxCounterpartyId = await makeService(
      'Сервис только с ящиком',
      MAILBOX_INN,
      MAILBOX_ONLY_CONTRACTOR,
    );
    // Зеркальный случай: учётки есть, поле адреса пустое. Так выглядит подрядчик, заведённый до
    // появления колонки, — и именно он не получал отмены.
    const operatorsCounterpartyId = await makeService('Сервис только с учётками', OPERATORS_INN);

    const admin = await makeUser('admin', 'admin');
    const customer = await makeUser('cust', 'shtab');
    const people = {
      admin,
      customer,
      exec1: await makeUser('exec1', 'shtab'),
      exec2: await makeUser('exec2', 'shtab'),
      operator: await makeUser('oper', 'operator', { counterpartyId: serviceCounterpartyId }),
      /** Оператор компании без общего ящика: единственный, до кого доходит её почта. */
      operatorNoMailbox: await makeUser('oper2', 'operator', {
        counterpartyId: operatorsCounterpartyId,
      }),
      retired: await makeUser('retired', 'shtab', { isActive: false }),
    };
    ctx = {
      app,
      db,
      closeDb,
      admin: await login(admin.email),
      customer: await login(customer.email),
      customerEmail: customer.email,
      newEquipment: equipment,
      mail: await import('../src/services/service-request-mail'),
      people,
      serviceCounterpartyId,
      emptyCounterpartyId,
      mailboxCounterpartyId,
      operatorsCounterpartyId,
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const requests = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (
        SELECT id FROM office_equipment WHERE inventory_number LIKE ${`СМ-${RUN}-%`})`;
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE entity_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM jobs WHERE type = 'send_email'
        AND (payload->>'mailMessageId')::uuid NOT IN (SELECT id FROM mail_messages)`);
      await ctx.db.execute(sql`DELETE FROM service_request_status_history
        WHERE request_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`СМ-${RUN}-%`}`,
      );
      // Модели, заведённые карточками этого файла. С миграции `0171` наименование карточки — это
      // имя строки справочника `office_equipment_models`, и вставка без `model_id` заводит модель
      // сама; удаление карточки её за собой не уносит, а база у db-тестов общая — за неделю
      // прогонов справочник зарастёт именами фикстур. Отбор идёт по суффиксу прогона в самом
      // наименовании: копию боевого парка в этой базе он не заденет. Проверка «карточек не
      // осталось» — страховка от `ON DELETE RESTRICT` у ссылки карточки: пережившая уборку
      // карточка уронила бы `afterAll` отказом внешнего ключа вместо тихо оставленной строки.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM module_mail_recipients
             WHERE to_email IN (${COPY_MAILBOX}, ${ASSIGN_COPY_MAILBOX})
                OR to_email LIKE ${`db-sm-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-sm-%-${RUN}@example.invalid`}`,
      );
      // После учёток: на контрагенте висит `counterparty_id` оператора, и ссылка `restrict`.
      await ctx.db.execute(
        sql`DELETE FROM counterparties
             WHERE inn IN (${SERVICE_INN}, ${EMPTY_INN}, ${MAILBOX_INN}, ${OPERATORS_INN})`,
      );
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`SM-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  it('заведение шлёт письмо на ящик службы — с её же канала и с ответом заявителю', async () => {
    const { request, mail } = await createRequest(
      await ctx.newEquipment('dup'),
      'Не печатает вторую сторону',
    );
    expect(mail).toBe('queued');

    const letters = await mailsOf(request.id);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.kind).toBe('service_request_waiting_it');
    expect(letters[0]!.to_email).toBe(SERVICE_MAILBOX);
    expect(letters[0]!.account).toBe('repair');
    // Ответ уходит заявителю: письмо, где отправитель и получатель — один ящик, без обратного
    // адреса отвечает само себе (К22).
    expect(letters[0]!.reply_to).toBe(ctx.customerEmail);
    expect(letters[0]!.subject).toContain(request.displayNumber);
  });

  it('срочная заявка помечена в теме', async () => {
    const res = await inject('POST', '/api/v1/service-requests', ctx.customer, {
      officeEquipmentId: await ctx.newEquipment('urgent'),
      description: 'Дым из блока',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      isUrgent: true,
      urgencyReason: 'Работа встала',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { request } = res.json() as { request: ServiceRequestDto };

    const letters = await mailsOf(request.id);
    expect(letters[0]!.subject).toMatch(/^СРОЧНО/u);
  });

  /**
   * Главная проверка события: «Новой» заявка бывает не только при заведении. Отмена и возврат из
   * неё дают ещё два письма, и каждое — со своим ключом: по заявке ключ подавил бы второй заход.
   */
  it('отмена и возврат в «Новую» дают свои письма', async () => {
    const { request } = await createRequest(await ctx.newEquipment('cycle'), 'Замятие бумаги');

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'cancelled', reason: 'Решили менять аппарат', version: request.version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const afterCancel = (cancelled.json() as { request: ServiceRequestDto }).request;

    const restored = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'new', reason: 'Отменили по ошибке', version: afterCancel.version },
    );
    expect(restored.statusCode, restored.body).toBe(200);

    const letters = await mailsOf(request.id);
    expect(letters.map((l) => l.kind)).toEqual([
      'service_request_waiting_it',
      'service_request_cancelled',
      'service_request_waiting_it',
    ]);
    // Три письма — три разные строки истории статуса в ключах.
    expect(new Set(letters.map((l) => l.dedupe_key)).size).toBe(3);
  });

  it('копия адресата приходит вторым письмом, а не вместо основного', async () => {
    const added = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: COPY_MAILBOX,
      replyToMode: 'portal',
    });
    expect(added.statusCode, added.body).toBe(201);
    const copyRecipientId = (added.json() as { id: string }).id;
    // С этой минуты копия — наша подписка, и её письма входят в выборку наравне с письмами канала.
    ownRecipients.add(copyRecipientId);

    const { request } = await createRequest(
      await ctx.newEquipment('copy'),
      'Не берёт бумагу из лотка',
    );
    const letters = await mailsOf(request.id);

    expect(letters.map((l) => l.to_email).sort()).toEqual([COPY_MAILBOX, SERVICE_MAILBOX].sort());
    // У копии режим «общий адрес портала» — своего обратного адреса у неё нет.
    expect(letters.find((l) => l.to_email === COPY_MAILBOX)!.reply_to).toBe('');

    // Копия убирается сразу: дальше проверяется счёт писем, и лишний адресат сделал бы «одно
    // письмо на событие» неотличимым от «двух».
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/mail/recipients/${copyRecipientId}`,
      headers: ctx.admin,
    });
    expect(removed.statusCode).toBe(204);
    // Ключ снятой копии из выборки не убирается намеренно: письма по ней уже составлены, и после
    // её удаления счёт следующих сценариев обязан сойтись сам — новых писем она не даёт.
  });

  /**
   * Копия получает СВОЁ тело, потому что у неё свой режим обратного адреса (Р68). Прежде ей уходило
   * тело службы с припиской «ответ уйдёт заявителю» — неправда у трёх режимов из четырёх: при
   * `fixed` ответ уходит на заданный ящик, при `actor` — нажавшему, при `portal` — в никуда.
   * Письмо, которое врёт про адрес ответа, хуже письма без приписки.
   */
  it('копия не обещает адрес ответа — у неё свой режим', async () => {
    const added = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: COPY_MAILBOX,
      replyToMode: 'fixed',
      replyToEmail: COPY_MAILBOX,
    });
    expect(added.statusCode, added.body).toBe(201);
    const copyId = (added.json() as { id: string }).id;
    ownRecipients.add(copyId);

    const { request } = await createRequest(await ctx.newEquipment('copytext'), 'Гаснет экран');
    const letters = await mailsOf(request.id);
    const copy = letters.find((l) => l.to_email === COPY_MAILBOX)!;
    const service = letters.find((l) => l.to_email === SERVICE_MAILBOX)!;

    // Обратный адрес копии — её собственный, и тело больше не обещает чужой.
    expect(copy.reply_to).toBe(COPY_MAILBOX);
    expect(copy.body_text).toContain('настройке рассылки');
    expect(copy.body_text).not.toContain('уйдёт заявителю');
    // Письмо службе не изменилось: у неё вопросы к заявителю, и ответ идёт ему.
    expect(service.reply_to).toBe(ctx.customerEmail);
    expect(service.body_text).toContain('уйдёт заявителю');

    const removed = await inject('DELETE', `/api/v1/admin/mail/recipients/${copyId}`, ctx.admin);
    expect(removed.statusCode).toBe(204);
  });

  it('повтор кнопкой: тот же ключ — одно письмо, новый — второе', async () => {
    const { request } = await createRequest(await ctx.newEquipment('repeat'), 'Полосы на копиях');
    const before = (await mailsOf(request.id)).length;
    const key = randomUUID();

    const first = await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: key,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().mail).toBe('queued');

    // Тот же ключ — повтор HTTP или второе нажатие: письма не прибавляется.
    await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: key,
    });
    const afterSame = await mailsOf(request.id);
    expect(afterSame.length).toBe(before + 1);

    await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: randomUUID(),
    });
    expect((await mailsOf(request.id)).length).toBe(before + 2);

    // Постановка в очередь записана аудитом именно как постановка: отправляет письмо worker.
    const audit = await ctx.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM audit_log
       WHERE action = 'serviceRequest.mailQueued' AND entity_id = ${request.id}`);
    expect(Number(audit.rows[0]!.count)).toBe(3);
  });

  /**
   * Назначение так, как его сделает ручка `PUT /:id/executors`: строки исполнителей и контрагент
   * пишутся **до** помощника перехода, и всё это — одной транзакцией вместе с письмами.
   *
   * Порядок здесь не декорация. Данные письма (`loadServiceLetterData`) читаются той же
   * транзакцией и берут исполнителей из `service_request_executors`: запиши их после — и письмо о
   * назначении соберётся без единого имени. Инвариант «в рабочем статусе есть исполнитель»
   * отложенный (`0178`), поэтому любой порядок шагов внутри транзакции законен, и поймать эту
   * ошибку базой нельзя — её ловит сборка тела.
   *
   * **Статуса назначение больше не меняет** (Р5, миграция 0224): «Назначена» снята, заявка остаётся
   * «Новой», а строка истории кладётся `from = to`. Прежний `UPDATE … status = 'assigned'` теперь
   * упёрся бы в `service_requests_dead_status_check` — и правильно: обойти дверь значило бы
   * проверять письмо на состоянии, которого в модуле не бывает.
   */
  async function assignAndMail(params: {
    requestId: string;
    plan: ServiceMail.ServiceMailPlan;
    userIds: string[];
    serviceCounterpartyId?: string;
  }): Promise<void> {
    await ctx.db.transaction(async (tx) => {
      if (params.serviceCounterpartyId) {
        await tx.execute(sql`UPDATE service_requests
             SET service_counterparty_id = ${params.serviceCounterpartyId}
           WHERE id = ${params.requestId}`);
      }
      for (const userId of params.userIds) {
        await tx.execute(sql`
          INSERT INTO service_request_executors (request_id, user_id, assigned_by)
          VALUES (${params.requestId}, ${userId}, ${ctx.people.admin.id})`);
      }
      const history = await tx.execute<{ id: string }>(sql`
        INSERT INTO service_request_status_history (request_id, from_status, to_status, changed_by)
        VALUES (${params.requestId}, 'new', 'new', ${ctx.people.admin.id})
        RETURNING id`);
      const data = await ctx.mail.loadServiceLetterData(tx, params.requestId);
      await ctx.mail.queueServiceMails(tx, {
        plan: params.plan,
        statusHistoryId: history.rows[0]!.id,
        requestId: params.requestId,
        letters: ctx.mail.renderServiceLetters('service_request_assigned', data),
      });
    });
  }

  /** План письма о назначении: действует администратор, автор заявки — заказчик. */
  function planAssignment(
    userIds: string[],
    serviceCounterpartyId: string | null,
    previousServiceCounterpartyId: string | null = null,
  ) {
    return ctx.mail.planServiceAssignmentMail(
      { userIds, serviceCounterpartyId, previousServiceCounterpartyId },
      { actor: ctx.people.admin, authorId: ctx.people.customer.id },
    );
  }

  /** Письма события назначения по заявке — своих подписок, как и всё в этом файле. */
  async function assignmentLetters(requestId: string) {
    const letters = await mailsOf(requestId);
    return letters.filter((l) => l.kind === 'service_request_assigned');
  }

  /**
   * Главное отличие письма о назначении от остальных писем модуля: адресат.
   *
   * Остальные два уходят на ящик службы и копиям из настройки — то есть службе. Это уходит
   * **людям**: назначенным поимённо и оператору сервисной компании (Н13). Проверяется поэтому не
   * «письмо составилось», а кого в нём **нет**: ящика службы, который назначение и сделал, и
   * заявителя, которому портал показывает движение и без почты (В16).
   */
  it('письмо о назначении уходит назначенным, а не в ящик службы', async () => {
    const { request } = await createRequest(await ctx.newEquipment('assign'), 'Не берёт картридж');

    // План считается ДО транзакции и по будущему составу: строк исполнителей ещё нет — их пишет та
    // самая транзакция, ради которой письмо и составляется.
    const planned = await planAssignment(
      [ctx.people.exec1.id, ctx.people.exec2.id],
      ctx.serviceCounterpartyId,
    );
    expect(planned.outcome).toBe('queued');
    const plan = planned.plan!;
    for (const recipient of plan.recipients) ownRecipients.add(recipient.key);

    expect(plan.recipients.map((r) => r.email).sort()).toEqual(
      [
        ctx.people.exec1.email,
        ctx.people.exec2.email,
        ctx.people.operator.email,
        CONTRACTOR_MAILBOX,
      ].sort(),
    );
    expect(plan.recipients.map((r) => r.email)).not.toContain(SERVICE_MAILBOX);
    expect(plan.recipients.map((r) => r.email)).not.toContain(ctx.customerEmail);
    /**
     * Обратный адрес один на всех — **ящик службы** (ADR 0153). Прежде отвечали заявителю, и для
     * своих сисадминов это было удобно; с появлением внешнего адресата так оставлять нельзя — ответ
     * подрядчика ушёл бы от лица чужой организации человеку, который её не знает.
     */
    expect([...new Set(plan.recipients.map((r) => r.replyTo))]).toEqual([SERVICE_MAILBOX]);
    // Общий ящик компании — аудитория «подрядчик»: у него своё тело письма.
    const contractor = plan.recipients.find((r) => r.email === CONTRACTOR_MAILBOX)!;
    expect(contractor.key).toBe(`counterparty-${ctx.serviceCounterpartyId}`);
    expect(contractor.audience).toBe('contractor');

    await assignAndMail({
      requestId: request.id,
      plan,
      userIds: [ctx.people.exec1.id, ctx.people.exec2.id],
      serviceCounterpartyId: ctx.serviceCounterpartyId,
    });

    const letters = await assignmentLetters(request.id);
    expect(letters.map((l) => l.to_email).sort()).toEqual(
      [
        ctx.people.exec1.email,
        ctx.people.exec2.email,
        ctx.people.operator.email,
        CONTRACTOR_MAILBOX,
      ].sort(),
    );
    // По письму на адресата, и каждое со своим ключом: общий ключ подавил бы всё, кроме первого.
    expect(new Set(letters.map((l) => l.dedupe_key)).size).toBe(4);
    expect(letters[0]!.account).toBe('repair');
    expect(letters[0]!.subject).toContain(request.displayNumber);
    // Тело называет обе стороны: «свой сисадмин + подрядчик» — обычная постановка, а не редкость.
    expect(letters[0]!.body_text).toContain(`Тестовый Пользователь exec1`);
    expect(letters[0]!.body_text).toContain(`Сервис писем ${RUN}`);
  });

  /**
   * Копия и адресация — разные вещи, и человек бывает и тем, и другим сразу. Ключи у двух его
   * попаданий разные (id учётки и id строки настройки), и очередь их не схлопнет: без
   * дедупликации по адресу исполнитель получил бы два одинаковых письма.
   */
  it('копия работает поверх назначенных и не удваивает письмо исполнителю', async () => {
    const outsider = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin, {
      event: 'service_request_assigned',
      toEmail: ASSIGN_COPY_MAILBOX,
      replyToMode: 'portal',
    });
    expect(outsider.statusCode, outsider.body).toBe(201);
    const outsiderId = (outsider.json() as { id: string }).id;
    ownRecipients.add(outsiderId);

    // Вторая строка — на ящик самого исполнителя: тот же человек с двух сторон.
    const twice = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin, {
      event: 'service_request_assigned',
      toEmail: ctx.people.exec1.email,
      replyToMode: 'portal',
    });
    expect(twice.statusCode, twice.body).toBe(201);
    const twiceId = (twice.json() as { id: string }).id;
    ownRecipients.add(twiceId);

    const { request } = await createRequest(await ctx.newEquipment('acopy'), 'Мажет тонером');
    const plan = (await planAssignment([ctx.people.exec1.id], null)).plan!;
    for (const recipient of plan.recipients) ownRecipients.add(recipient.key);

    expect(plan.recipients.map((r) => r.email)).toEqual([
      ctx.people.exec1.email,
      ASSIGN_COPY_MAILBOX,
    ]);
    // Исполнитель остался исполнителем: ключ его, обратный адрес — ящик службы (ADR 0153), а не
    // «общий адрес портала», как просила бы строка настройки, победи она в дедупликации.
    expect(plan.recipients[0]!.key).toBe(ctx.people.exec1.id);
    expect(plan.recipients[0]!.replyTo).toBe(SERVICE_MAILBOX);
    expect(plan.recipients[1]!.replyTo).toBe('');

    await assignAndMail({ requestId: request.id, plan, userIds: [ctx.people.exec1.id] });
    const letters = await assignmentLetters(request.id);
    expect(letters).toHaveLength(2);
    expect(letters.filter((l) => l.to_email === ctx.people.exec1.email)).toHaveLength(1);

    // Копии убираются сразу: дальше считаются письма, и лишний адресат сделал бы счёт неотличимым.
    for (const id of [outsiderId, twiceId]) {
      const removed = await inject('DELETE', `/api/v1/admin/mail/recipients/${id}`, ctx.admin);
      expect(removed.statusCode).toBe(204);
    }
  });

  /**
   * Пустой список адресатов — не повод отправить письмо службе: она назначение и сделала, а
   * исполнитель задания всё равно не увидит. Портал обязан сказать это исходом, иначе назначивший
   * останется уверен, что подрядчика позвали.
   *
   * Оба источника пусты по разным причинам, и обе настоящие: подрядчик без единой учётки в портале
   * — обычное дело, а отключённая учётка это ящик, за которым никого нет.
   */
  it('назначенным писать некуда — письма нет вовсе, и исход это называет', async () => {
    const planned = await planAssignment([ctx.people.retired.id], ctx.emptyCounterpartyId);
    expect(planned).toEqual({ plan: null, outcome: 'no_recipients' });
  });

  /**
   * «Писем нет» бывает двух разных смыслов, и путать их нельзя (ADR 0153).
   *
   * `no_recipients` выше — это задание, которое НЕ ДОШЛО: исполнителя назначили, а писать ему
   * некуда, и назначивший обязан позвонить сам. Здесь — другое: правка состава никого не назначила
   * (сняли сервисную компанию, оставив прежнего исполнителя), и адресатов у задания нет по
   * построению. Совет «заведите ящик компании» в этом случае звал бы заводить адрес тому, кому
   * больше не пишут, — поэтому исход свой, и портал по нему молчит.
   *
   * Проверяются обе половины разом: со снятой компанией отзыв УХОДИТ (`queued`, письмо только ей),
   * а когда отзывать некого — писем нет вовсе (`not_needed`).
   */
  it('снятие компании без нового назначения: отзыв уходит, тревоги нет', async () => {
    // Ровно то, что считает ручка состава, снимая компанию при неизменном поимённом составе:
    // добавленных нет, новой компании нет, прежняя — та, у которой заявку забрали.
    const withdrawal = await planAssignment([], null, ctx.serviceCounterpartyId);
    expect(withdrawal.outcome).toBe('queued');
    expect(withdrawal.plan!.recipients.map((r) => r.audience)).toEqual([
      'contractor_withdrawn',
      'contractor_withdrawn',
    ]);
    expect(withdrawal.plan!.recipients.map((r) => r.email).sort()).toEqual(
      [ctx.people.operator.email, CONTRACTOR_MAILBOX].sort(),
    );

    // Тот же случай без прежней компании — возврат заявки прежнему составу: писать не о чем.
    expect(await planAssignment([], null, null)).toEqual({ plan: null, outcome: 'not_needed' });
  });

  /**
   * Ради этого случая колонка и заведена (ADR 0153, миграция 0241). Подрядчик без единой учётки в
   * портале — обычное дело: он читает почту, а заявки ведёт офис. До решения такое назначение
   * отвечало `no_recipients` — портал честно говорил «задание не ушло», и дальше его доносили
   * голосом; теперь оно доходит на общий ящик компании из её карточки.
   *
   * Поимённых исполнителей здесь нет вовсе, и это не упрощение сценария, а его суть: единственный
   * адресат письма — сама организация.
   */
  it('подрядчику без учёток задание уходит на общий ящик из карточки', async () => {
    const { request } = await createRequest(await ctx.newEquipment('solo'), 'Не тянет бумагу');

    const planned = await planAssignment([], ctx.mailboxCounterpartyId);
    expect(planned.outcome).toBe('queued');
    const plan = planned.plan!;
    for (const recipient of plan.recipients) ownRecipients.add(recipient.key);

    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0]!.email).toBe(MAILBOX_ONLY_CONTRACTOR);
    expect(plan.recipients[0]!.audience).toBe('contractor');
    expect(plan.recipients[0]!.replyTo).toBe(SERVICE_MAILBOX);

    await assignAndMail({
      requestId: request.id,
      plan,
      userIds: [],
      serviceCounterpartyId: ctx.mailboxCounterpartyId,
    });

    const letters = await assignmentLetters(request.id);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.to_email).toBe(MAILBOX_ONLY_CONTRACTOR);
    expect(letters[0]!.reply_to).toBe(SERVICE_MAILBOX);
    // Тело обязано говорить правду про обратный адрес: подрядчик вне портала, и приписка — его
    // единственный способ узнать, куда отвечать.
    expect(letters[0]!.body_text).toContain('в службу оргтехники');
    expect(letters[0]!.body_text).toContain('Подтвердите получение ответом');
    expect(letters[0]!.body_text).not.toContain('портал');
    expect(letters[0]!.body_text).not.toContain('уйдёт заявителю');
    expect(letters[0]!.body_text).toContain(`Сервис только с ящиком ${RUN}`);
  });

  /**
   * Переназначение — отзыв прежнего задания и выдача нового, а не одно письмо новой компании.
   * Старый подрядчик уже мог собрать выезд по первому письму; без отдельного отзыва он не узнает,
   * что заявка ушла другому. Тело отзыва не перечисляет новых исполнителей — это уже чужая работа.
   */
  it('переназначение отзывает задание у прежней сервисной компании', async () => {
    const { request } = await createRequest(
      await ctx.newEquipment('reassign-mail'),
      'Периодически пропадает изображение',
    );
    ownRecipients.add(`counterparty-${ctx.mailboxCounterpartyId}`);
    ownRecipients.add(`counterparty-withdrawn-${ctx.serviceCounterpartyId}`);
    ownRecipients.add(`withdrawn-${ctx.people.operator.id}`);

    const first = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: request.version },
    );
    expect(first.statusCode, first.body).toBe(200);
    const afterFirst = (first.json() as { request: ServiceRequestDto }).request;

    const second = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      {
        userIds: [],
        serviceCounterpartyId: ctx.mailboxCounterpartyId,
        reason: 'Первый подрядчик не успевает',
        version: afterFirst.version,
      },
    );
    expect(second.statusCode, second.body).toBe(200);

    const letters = await assignmentLetters(request.id);
    const withdrawn = letters.find((l) =>
      l.dedupe_key.includes(`counterparty-withdrawn-${ctx.serviceCounterpartyId}`),
    );
    const assigned = letters.find((l) =>
      l.dedupe_key.includes(`counterparty-${ctx.mailboxCounterpartyId}`),
    );
    const withdrawnOperator = letters.find((l) =>
      l.dedupe_key.includes(`withdrawn-${ctx.people.operator.id}`),
    );
    expect(withdrawn).toBeDefined();
    expect(withdrawn!.to_email).toBe(CONTRACTOR_MAILBOX);
    expect(withdrawn!.subject).toContain('Назначение сервисной компании отозвано');
    expect(withdrawn!.body_text).toContain('выезд не требуется');
    expect(withdrawn!.body_text).not.toContain(`Сервис только с ящиком ${RUN}`);
    expect(withdrawn!.body_text).not.toContain('портал');
    expect(withdrawnOperator).toBeDefined();
    expect(withdrawnOperator!.to_email).toBe(ctx.people.operator.email);
    expect(withdrawnOperator!.body_text).toContain('выезд не требуется');
    expect(assigned).toBeDefined();
    expect(assigned!.to_email).toBe(MAILBOX_ONLY_CONTRACTOR);
    expect(assigned!.body_text).toContain(`Сервис только с ящиком ${RUN}`);
  });

  /**
   * Сторона подрядчика — это его УЧЁТКИ И его ящик, а не один ящик. Письмо о назначении так и
   * считало с самого начала, отмена — нет: компания с операторами в портале и пустым полем адреса
   * получала задание и не получала отмены, а портал отвечал `queued`, потому что письмо службе в
   * очередь встало. Ехали зря.
   *
   * Проверяются обе половины: у компании с учётками отмена доходит до оператора, а у компании без
   * учёток и без ящика исход перестаёт быть `queued` — сказать было некому, и назначивший обязан
   * узнать это сразу.
   */
  it('отмена доходит до операторов подрядчика, а не только до общего ящика', async () => {
    const { request } = await createRequest(await ctx.newEquipment('cxl-op'), 'Не сканирует');
    ownRecipients.add(ctx.people.operatorNoMailbox.id);

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      {
        userIds: [],
        serviceCounterpartyId: ctx.operatorsCounterpartyId,
        version: request.version,
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const afterAssign = (assigned.json() as { request: ServiceRequestDto }).request;

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'cancelled', reason: 'Аппарат списали', version: afterAssign.version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((cancelled.json() as { mail: string }).mail).toBe('queued');

    const letters = (await mailsOf(request.id)).filter(
      (l) => l.kind === 'service_request_cancelled',
    );
    expect(letters.map((l) => l.to_email).sort()).toEqual(
      [SERVICE_MAILBOX, ctx.people.operatorNoMailbox.email].sort(),
    );
    const toOperator = letters.find((l) => l.to_email === ctx.people.operatorNoMailbox.email)!;
    expect(toOperator.reply_to).toBe(SERVICE_MAILBOX);
    expect(toOperator.body_text).toContain('выезд не требуется');
  });

  /**
   * Обратная сторона той же проверки: сказать подрядчику нечем — и это не `queued`. Письмо службе
   * при этом уходит: исход отвечает за сторону подрядчика, а не за всё письмо разом.
   */
  it('отмена, которую подрядчику некуда отправить, исходом это называет', async () => {
    const { request } = await createRequest(await ctx.newEquipment('cxl-none'), 'Течёт тонер');

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      { userIds: [], serviceCounterpartyId: ctx.emptyCounterpartyId, version: request.version },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const afterAssign = (assigned.json() as { request: ServiceRequestDto }).request;

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'cancelled', reason: 'Передумали', version: afterAssign.version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((cancelled.json() as { mail: string }).mail).toBe('no_recipients');

    // Служба оповещена: половина, которая могла уйти, ушла.
    const letters = (await mailsOf(request.id)).filter(
      (l) => l.kind === 'service_request_cancelled',
    );
    expect(letters.map((l) => l.to_email)).toEqual([SERVICE_MAILBOX]);
  });

  /**
   * «Письма не требовалось» спрашивается ПЕРВЫМ — до почты и канала. Иначе правка состава, которая
   * никого не назначила, отвечала бы «отправка писем выключена»: тревога про настройку сервера там,
   * где письма и не требовалось. Это ровно то, что ломало смысл исхода `not_needed`.
   *
   * Почта гасится на время проверки: исход считается на живой конфигурации, и подменить её иначе,
   * не подменяя весь модуль, нельзя.
   */
  it('«письма не требовалось» отвечается и при выключенной почте', async () => {
    const { config } = await import('../src/config');
    const was = config.mail.enabled;
    config.mail.enabled = false;
    try {
      // Ничего не назначено и нечего отзывать: состояние сервера к делу не относится.
      expect(await planAssignment([], null, null)).toEqual({ plan: null, outcome: 'not_needed' });
      // А вот назначение при выключенной почте — по-прежнему «письма нет из-за настройки».
      expect(await planAssignment([], ctx.mailboxCounterpartyId, null)).toEqual({
        plan: null,
        outcome: 'mail_disabled',
      });
    } finally {
      config.mail.enabled = was;
    }
  });

  /**
   * Переназначение — два обязательства сразу: новому выдать, у прежнего забрать. Исход обязан
   * отвечать за обе половины: иначе переназначение к подрядчику с ящиком отчитывалось бы `queued`,
   * пока прежний, которому написать некуда, продолжал бы собирать выезд.
   */
  it('переназначение, где прежней компании писать некуда, не отчитывается «ушло»', async () => {
    const planned = await planAssignment([], ctx.mailboxCounterpartyId, ctx.emptyCounterpartyId);
    expect(planned.outcome).toBe('no_recipients');
    // План при этом есть: новое задание уходит, потерян только отзыв.
    expect(planned.plan!.recipients.map((r) => r.email)).toEqual([MAILBOX_ONLY_CONTRACTOR]);
  });

  /**
   * Отмена — второе событие, адресованное подрядчику (ADR 0153): он уже собрался ехать, а везти
   * нечего. Проверяется не только адрес, но и **два разных тела одного события**: службе уходит
   * прежнее письмо с ответом заявителю, подрядчику — своё, с ответом в службу и словами «выезд не
   * требуется». Совпади тела — внешний адресат ответил бы человеку, который его не знает.
   */
  it('отмена назначенной заявки доходит до подрядчика — своим телом и с ответом в службу', async () => {
    const { request } = await createRequest(await ctx.newEquipment('cxl'), 'Гудит и не печатает');
    // Ключ подрядчика — наша подписка: письма по ней входят в выборку наравне с письмами канала.
    ownRecipients.add(`counterparty-${ctx.serviceCounterpartyId}`);

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: request.version },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const afterAssign = (assigned.json() as { request: ServiceRequestDto }).request;

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'cancelled', reason: 'Аппарат увезли', version: afterAssign.version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const letters = (await mailsOf(request.id)).filter(
      (l) => l.kind === 'service_request_cancelled',
    );
    // Сторона подрядчика — обе её половины: общий ящик компании и её оператор в портале.
    expect(letters.map((l) => l.to_email).sort()).toEqual(
      [SERVICE_MAILBOX, CONTRACTOR_MAILBOX, ctx.people.operator.email].sort(),
    );

    const toService = letters.find((l) => l.to_email === SERVICE_MAILBOX)!;
    const toContractor = letters.find((l) => l.to_email === CONTRACTOR_MAILBOX)!;
    const toOperator = letters.find((l) => l.to_email === ctx.people.operator.email)!;
    // Оператору — то же тело подрядчика: приписка про адрес ответа важнее ссылки в портал.
    expect(toOperator.reply_to).toBe(SERVICE_MAILBOX);
    expect(toOperator.body_text).toContain('выезд не требуется');
    // Службе — как и раньше: ответ уходит заявителю, у неё вопросы к нему.
    expect(toService.reply_to).toBe(ctx.customerEmail);
    expect(toService.body_text).toContain('уйдёт заявителю');
    // Подрядчику — своё тело: ответ в службу и главное первым делом.
    expect(toContractor.reply_to).toBe(SERVICE_MAILBOX);
    expect(toContractor.body_text).toContain('выезд не требуется');
    expect(toContractor.body_text).not.toContain('уйдёт заявителю');
  });

  /**
   * Повтор письма службе запирается не только статусом, но и **составом исполнителей** (Р14,
   * `serviceMailRepeatable`). Пока «Новая» означала «ещё не назначена», на этот вопрос отвечал сам
   * статус: назначенная заявка стояла в «Назначена», и до этой ручки не доходила. После слияния
   * (Р1) статус половину ответа потерял бы молча — кнопка осталась бы на месте, а письмо звало бы
   * службу разбирать заявку, которую уже разобрали.
   *
   * Проверяется поэтому пара «до и после» на одной заявке: до назначения повтор проходит, после —
   * 422, и заявка при этом по-прежнему «Новая», то есть отбил её именно состав.
   */
  it('после назначения исполнителей повтор письма службе закрыт — 422', async () => {
    const { request } = await createRequest(
      await ctx.newEquipment('reassigned'),
      'Заминает бумагу на выходе',
    );
    const before = await inject(
      'POST',
      `/api/v1/service-requests/${request.id}/notify`,
      ctx.admin,
      { idempotencyKey: randomUUID() },
    );
    expect(before.statusCode, before.body).toBe(200);

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.admin,
      { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: request.version },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    // Статус не сменился — назначение переходом быть перестало (Р5): значит повтор ниже отобьёт
    // именно состав исполнителей, а не «другой статус».
    expect((assigned.json() as { request: ServiceRequestDto }).request.status).toBe('new');

    const after = await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: randomUUID(),
    });
    expect(after.statusCode, after.body).toBe(422);
    expect(after.json().message).toContain('уже разобрали');
  });

  /**
   * Статус выбран заморозкой, а не визой ИТ: виза упразднена вовсе (Р10), и «Согласована ИТ» из
   * «Новой» администратору не доступна. Проверяется здесь не эта дуга, а то, что повтор письма
   * привязан к событию: у статуса без письма повторять нечего, и портал обязан сказать это
   * словами, а не молча ничего не отправить.
   */
  it('в статусе без события повторять нечего — 422', async () => {
    const { request } = await createRequest(await ctx.newEquipment('held'), 'Не сканирует');
    const held = await inject('PATCH', `/api/v1/service-requests/${request.id}/hold`, ctx.admin, {
      reason: 'Ждём запчасть',
      version: request.version,
    });
    expect(held.statusCode, held.body).toBe(200);

    const res = await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('не отправлялись');
  });
});
