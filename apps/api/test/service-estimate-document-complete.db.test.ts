import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, type ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **ЗАКРЫТИЕ РАБОТ ПО ДОКУМЕНТНОЙ ЗАЯВКЕ И ПЛАНКА ПРИЁМКИ** — вторая половина этапа Э4 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md` (решение Р8, находка Н14).
 *
 * ЧТО ДОКАЗЫВАЕТ ФАЙЛ.
 *
 *   Д1. Документная заявка НЕ закрывается без акта — и подшитый счёт акта не заменяет: у такой
 *       ревизии перечень закрывающих бумаг сужен до акта (Р5), иначе заявка закрывалась бы тем же
 *       документом, которым объём работ предъявлен.
 *   Д2. Присланные строки, скидка и расходники — 422, а не молчаливое отбрасывание: молча
 *       проигнорированное поле у денежной ручки однажды уже стоило разбора (ADR 0179).
 *   Д3. С актом работы закрываются БЕЗ построчного факта, хотя строка черновика в заявке лежит
 *       (документная подача её не удаляет, Р10) — общий путь потребовал бы по ней отметку.
 *   Д4. Итог по акту остался `NULL`, а не нулём: `sumAmounts([])` даёт ноль, и записанный ноль
 *       читался бы как «работы бесплатны» (запрет ADR 0179).
 *   Д5. Черновая строка не получила ни факта, ни гарантии: гарантия живёт только на строке, и по
 *       документной заявке она не фиксируется до разбора документа (Р8).
 *   Д6. В аудите закрытия нет ни итога, ни корректировки: посчитанный ноль читался бы в журнале
 *       ценой, и отчёт по затратам счёл бы работу подрядчика бесплатной.
 *   Д7. Приёмка требует, чтобы СОГЛАСОВАННАЯ ревизия совпадала с действующей (Н14): подпись,
 *       снятую после закрытия работ, приёмка прежде не замечала вовсе.
 *
 * ПОЧЕМУ БАЗА. Предмет — ровно то, чего на моках не бывает: формат действующей ревизии читается под
 * блокировкой строки заявки, планка закрывающего документа считается запросом по роли файла и виду,
 * а «итог пуст» и «итог ноль» различимы только в самой колонке `final_total_amount`. Плюс рубильник
 * документного режима — строка таблицы `feature_flags`, которую читает сама ручка без кэша.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл переключает ГЛОБАЛЬНЫЙ рубильник, а в общей базе
 * рядом работают соседи — и переключённый ключ менял бы поведение их ручек посреди прогона. Механизм
 * тот же, что у `service-estimate-document-submit`.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5455/postgres \
 *     npx vitest run test/service-estimate-document-complete.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_document_complete_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-doc-complete-password-123';
const REQUESTS = '/api/v1/service-requests';
/** Дата выполнения — московские календарные сутки: от них считаются гарантии (`warrantyToday`). */
const TODAY = moscowDateKeyOf(new Date());

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: TestUser;
  customer: TestUser;
  /** «Ведение» модуля: назначает подрядчика, согласует объём работ и принимает работу. */
  operator: TestUser;
  /** Оператор назначенного контрагента-сервиса: предъявляет объём работ и закрывает работы. */
  service: TestUser;
  objectId: string;
  counterpartyId: string;
  typeId: string;
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
  // S3 здесь не участвует: страницы счёта и акт подшиваются уже загруженными строками `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Почта выключена намеренно: предмет файла — колонки закрытия и планка приёмки, а письма о
  // предъявлении и документах проверяет `service-estimate-document-submit`.
  process.env.MAIL_ENABLED = 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы по адресу (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function messageOf(res: LightMyRequestResponse): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

async function statusOf(id: string): Promise<string> {
  return (await card(id)).status;
}

/** Рубильник волны: значение читается ручкой без кэша, поэтому `UPDATE` действует сразу. */
async function setFlag(key: string, enabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${enabled} WHERE key = ${key}`,
  );
  // Ноль обновлённых строк означал бы, что миграция 0307 не накачена, — и весь файл проверял бы
  // тогда выключенное состояние, считая его включённым.
  expect(res.rowCount, `рубильник ${key} не найден`).toBe(1);
}

function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `RICOH MP C2011 ${RUN}`,
    inventoryNumber: `CMP-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 312',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/**
 * Загруженный файл строкой в `files`: настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — состояние заявки, а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`cmp/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'active', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Подшивка бумаги подрядчиком: вид — аргумент, им и отличается акт от счёта (Д1). */
async function attach(id: string, kind: 'act' | 'invoice'): Promise<string> {
  const fileId = await uploadedFile(ctx.service.id, `${kind}-${randomUUID()}.pdf`);
  const res = await inject('POST', `${REQUESTS}/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind,
  });
  expect(res.statusCode, res.body).toBe(200);
  return fileId;
}

/**
 * Заявка, у которой объём работ ПРЕДЪЯВЛЕН СЧЁТОМ И СОГЛАСОВАН, а закрывающей бумаги ещё нет.
 *
 * Строка черновика набирается ДО переключения на документ намеренно: портал пускает в этот режим с
 * одной набранной строкой, документная подача её не удаляет (Р10), и именно такая заявка проверяет
 * ветвь закрытия по-настоящему — «строк ноль» здесь неправда.
 */
async function documentRequestApproved(
  description: string,
): Promise<{ id: string; itemId: string }> {
  const created = await inject('POST', REQUESTS, ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;

  const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.counterpartyId,
    version: await versionOf(id),
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.service.auth, {
    version: await versionOf(id),
  });
  expect(started.statusCode, started.body).toBe(200);

  const draft = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
    items: [{ kind: 'service', name: 'Диагностика МФУ', quantity: 1, unitPrice: 1500 }],
    version: await versionOf(id),
  });
  expect(draft.statusCode, draft.body).toBe(200);
  const itemId = (draft.json() as ServiceRequestDto).items[0]!.id;

  const submitted = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
    mode: 'document',
    fileIds: [await uploadedFile(ctx.service.id, `schet-${randomUUID()}.pdf`)],
    version: await versionOf(id),
  });
  expect(submitted.statusCode, submitted.body).toBe(200);

  const approved = await inject('PATCH', `${REQUESTS}/${id}/estimate/approval`, ctx.operator.auth, {
    approved: true,
    version: await versionOf(id),
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { id, itemId };
}

/** Закрытие работ подрядчиком. Тело собирается случаями: предмет Д2 — именно лишние поля. */
async function complete(
  id: string,
  body: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return inject('PATCH', `${REQUESTS}/${id}/complete`, ctx.service.auth, {
    completedOn: TODAY,
    items: [],
    version: await versionOf(id),
    ...body,
  });
}

/** Колонки итога — сырыми: разница между «пусто» и «ноль» видна только в них (Д4). */
async function totalsOf(id: string): Promise<{
  final_total_amount: string | null;
  final_adjustment_amount: string | null;
  final_adjustment_reason: string;
  completed_at: Date | null;
}> {
  const res = await ctx.db.execute<{
    final_total_amount: string | null;
    final_adjustment_amount: string | null;
    final_adjustment_reason: string;
    completed_at: Date | null;
  }>(sql`
    SELECT final_total_amount, final_adjustment_amount, final_adjustment_reason, completed_at
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

async function itemFactOf(itemId: string): Promise<{
  performed: boolean | null;
  actual_quantity: string | null;
  warranty_until: string | null;
}> {
  const res = await ctx.db.execute<{
    performed: boolean | null;
    actual_quantity: string | null;
    warranty_until: string | null;
  }>(sql`
    SELECT performed, actual_quantity, warranty_until
      FROM service_request_items WHERE id = ${itemId}`);
  return res.rows[0]!;
}

async function completionAuditOf(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_type = 'serviceRequest' AND entity_id = ${id}
       AND action = 'serviceRequest.complete'
     ORDER BY created_at DESC
     LIMIT 1`);
  return res.rows[0]!.metadata;
}

describe.skipIf(!DB_URL)('закрытие работ по документной заявке (Э4, Р8)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    await migrate(OWN_DB!);

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-cmp-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-CMP ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`CMP-${RUN}`}, ${`Тестовая площадка CMP ${RUN}`}, 'г Москва, ул Тестовая, д 2')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const adminUser = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId})`);

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], adminUser.id);
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

    const login = async (user: { id: string; email: string }): Promise<TestUser> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextAddress(),
        payload: { email: user.email, password: PASSWORD },
      });
      if (res.statusCode !== 200) throw new Error(`вход ${user.email}: ${res.body}`);
      const token = (res.json() as { accessToken: string }).accessToken;
      return { ...user, auth: { authorization: `Bearer ${token}` } };
    };

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminUser),
      customer: await login(customer),
      operator: await login(operator),
      service: await login(service),
      objectId,
      counterpartyId,
      typeId,
    };
    // Рубильник документного режима включён на весь файл: без него предъявление счётом не проходит
    // вовсе, и закрывать было бы нечего.
    await setFlag('service_estimate_document_mode', true);
  }, 300_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── Д1, Д3–Д6. Одна заявка проходит путь закрытия целиком ──

  describe('Д1, Д3. закрывает акт, а не полнота данных', () => {
    let id: string;
    let itemId: string;

    beforeAll(async () => {
      ({ id, itemId } = await documentRequestApproved('Объём работ предъявлен счётом, закрываем'));
    });

    it('без закрывающей бумаги — 422, и отказ называет именно акт', async () => {
      const res = await complete(id);
      expect(res.statusCode, res.body).toBe(422);
      /*
       * ОТКАЗ НЕ ПЕРЕЧИСЛЯЕТ НАСЛЕДСТВЕННЫЙ НАБОР «акт, счёт или гарантийный талон»: счёт у этой
       * заявки уже лежит основанием, и человек, прочитавший такой текст, принёс бы его второй раз.
       */
      expect(messageOf(res)).toContain('требует акта о выполненных работах');
      expect(await statusOf(id)).toBe('in_work');
    });

    it('подшитый счёт документную заявку не закрывает', async () => {
      await attach(id, 'invoice');
      const res = await complete(id);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('требует акта о выполненных работах');
      expect(await statusOf(id)).toBe('in_work');
    });

    it('присланные строки, скидка и расходники — 422, а не молчаливое отбрасывание (Д2)', async () => {
      /*
       * АКТ ПОДШИВАЕТСЯ ДО СЛУЧАЯ НАМЕРЕННО: отказ по телу стоит ПОСЛЕ планки бумаг (планка —
       * предусловие самого хода и одна для всех форматов), и без акта случай проверял бы её, а не
       * разбор тела. Тот же акт отпирает следующий случай — закрытие.
       */
      await attach(id, 'act');
      const cases: Record<string, unknown>[] = [
        { items: [{ id: itemId, performed: true }] },
        { adjustmentAmount: -500, adjustmentReason: 'Скидка по договорённости' },
        { consumables: [{ id: itemId, issuedQuantity: 1 }] },
      ];
      for (const body of cases) {
        const res = await complete(id, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(messageOf(res)).toContain('предъявлен счётом');
      }
      // Ни одного следа: отказ, проставивший факт по черновой строке, был бы хуже пропуска.
      expect(await statusOf(id)).toBe('in_work');
      expect((await itemFactOf(itemId)).performed).toBeNull();
    });

    it('с актом работы закрываются без построчного факта', async () => {
      const res = await complete(id);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as ServiceRequestDto).status).toBe('done');
      // Дата выполнения записана — она и есть то единственное, что человек вводил.
      expect((await totalsOf(id)).completed_at).not.toBeNull();
    });

    it('итог по акту остался пустым, а не нулевым (Д4)', async () => {
      const totals = await totalsOf(id);
      /*
       * `NULL`, А НЕ `0.00`: строк у документной ревизии нет, `sumAmounts([])` дал бы ноль, и этот
       * ноль читался бы как «работы бесплатны» — ровно запрет ADR 0179. Проверка сырой колонки, а не
       * DTO: портал показывает «сумма не разобрана» по пустому полю, и разница существует только
       * здесь.
       */
      expect(totals.final_total_amount).toBeNull();
      expect(totals.final_adjustment_amount).toBeNull();
      expect(totals.final_adjustment_reason).toBe('');
      // И то же самое в карточке: факт закрытия у заявки есть, а итога в нём нет.
      const completion = (await card(id)).completion;
      expect(completion?.totalAmount).toBeNull();
      expect(completion?.adjustmentAmount).toBeNull();
    });

    it('черновая строка не получила ни факта, ни гарантии (Д5)', async () => {
      /*
       * Строка в заявке ЛЕЖИТ — документная подача черновик не удаляет (Р10), — и именно поэтому
       * ветвь закрытия обязана быть явной: общий путь потребовал бы по ней отметку о выполнении, а
       * её сумма стала бы итогом по акту. Гарантия не фиксируется вовсе: носитель у неё один —
       * строка предъявленного объёма работ, а предъявлен был счёт.
       */
      const fact = await itemFactOf(itemId);
      expect(fact.performed).toBeNull();
      expect(fact.actual_quantity).toBeNull();
      expect(fact.warranty_until).toBeNull();
    });

    it('в аудите закрытия нет ни итога, ни корректировки (Д6)', async () => {
      const metadata = await completionAuditOf(id);
      // Ревизия есть — по ней разбирают денежное решение; суммы нет — её система не знает.
      expect(metadata).toEqual({ revision: 1, completedOn: TODAY });
    });
  });

  // ── Д7. Планка приёмки ──

  describe('Д7. приёмка идёт по согласованному объёму работ', () => {
    let id: string;

    beforeAll(async () => {
      ({ id } = await documentRequestApproved('Документная заявка, у которой снимут подпись'));
      await attach(id, 'act');
      const closed = await complete(id);
      expect(closed.statusCode, closed.body).toBe(200);
    });

    it('подпись, снятая после закрытия работ, запирает приёмку', async () => {
      /*
       * ПОДПИСЬ СНИМАЕТСЯ ПРЯМО В БАЗЕ, И ЭТО НЕ СРЕЗАНИЕ УГЛА: ручки, которая снимает её в
       * «Решена», в этом выпуске ещё нет — её приносит исход спора «нужна подпись» (Р9, этап Э5).
       * Предмет проверки — сама планка приёмки (Н14), а не путь, которым состояние получено; пара
       * «ревизия + дата» гасится целиком, иначе `service_requests_approval_check` не пустил бы
       * `UPDATE`.
       */
      await ctx.db.execute(sql`
        UPDATE service_requests
           SET approved_estimate_revision = NULL, estimate_approved_at = NULL,
               estimate_approved_by = NULL, estimate_approval_source = NULL
         WHERE id = ${id}`);

      const res = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(messageOf(res)).toContain('принимают по согласованному объёму работ');
      expect(await statusOf(id)).toBe('done');
    });

    it('с подписью на месте заявка принимается', async () => {
      await ctx.db.execute(sql`
        UPDATE service_requests
           SET approved_estimate_revision = estimate_revision, estimate_approved_at = now(),
               estimate_approval_source = 'human', estimate_approved_by = ${ctx.operator.id}
         WHERE id = ${id}`);

      const res = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(id)).toBe('accepted');
    });
  });
});
