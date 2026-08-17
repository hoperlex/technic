import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPermission } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { digestRecipients as DigestRecipients } from '../src/services/mailings/role-digest';

/**
 * Адресация сводки переживает перевод ролей (ADR 0111; §11.1 плана реструктуризации прав).
 *
 * **Что здесь проверяется и почему именно в базе.** Адрес расписания — право, а не имя роли:
 * строка `mailing_schedule_permissions` отвечает на вопрос «кому отправлять» так, как его задают в
 * работе, — «кто ведёт заказы техники», а не «кто называется штабом». До ADR 0111 адресом была
 * роль, и перевод ролей ломал рассылку двумя тихими способами: расписание с упразднённой ролью не
 * сопоставлялось никому — письма просто переставали приходить, не сообщив об этом ни разу, — а
 * слияние ролей, отмеченных по отдельности, расширяло аудиторию на тех, кого из неё исключали.
 * Правилами такого не поймать: расходятся не правила, а строки таблицы с перечнем ролей в коде.
 *
 * Отсюда три проверки, и все — про перевод, а не про сегодняшний день:
 *   1. каждое право в расписаниях известно коду — выкат, снявший право из словаря, оставил бы здесь
 *      строку-сироту, и адресация по ней молча не сработала бы;
 *   2. строка прежней адресации по роли ни одного получателя не стоит — таблица оставлена до
 *      миграции удаления, и вернуть её в отбор не должна ни одна правка сервиса;
 *   3. смена роли получателя аудиторию не меняет, пока право при нём остаётся, — то самое, ради
 *      чего этап 7 идёт до этапа 8: перевод учётки в другую роль с тем же правом письма не отбирает.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test digest-role-audience
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  digestRecipients: typeof DigestRecipients;
}

let ctx: Ctx;
const createdScheduleIds: string[] = [];
const createdUserIds: string[] = [];

/** Аудитория «все и всё»: отбор по области и перечню в этом файле не проверяется. */
const ALL_AUDIENCE = {
  scopeMode: 'all' as const,
  objectIds: [],
  departmentIds: [],
  recipientMode: 'all' as const,
};

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

describe.skipIf(!DB_URL)('адресация сводки переживает перевод ролей (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);
  /** Расписание, адресованное праву заказов техники: его держат обе роли перевода. */
  let scheduleId: string;
  /** Получатель, роль которого меняется по ходу теста. */
  let movedUserId: string;
  /** Комендант: права заказов техники у роли нет, и адресатом он быть не должен. */
  let commandantUserId: string;

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { digestRecipients } = await import('../src/services/mailings/role-digest');
    ctx = { db, closeDb, schema, digestRecipients };

    const [schedule] = await db
      .insert(schema.mailingSchedules)
      .values({ type: 'role_digest', name: `Перевод ролей ${suffix}`, sendAt: '18:00' })
      .returning({ id: schema.mailingSchedules.id });
    createdScheduleIds.push(schedule!.id);
    scheduleId = schedule!.id;
    await db
      .insert(schema.mailingSchedulePermissions)
      .values({ scheduleId, permission: 'vehicleRequests.read' });

    async function makeUser(tag: string, role: 'shtab' | 'commandant'): Promise<string> {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: `db-digest-${tag}-${suffix}@example.invalid`,
          lastName: 'Тестовый',
          firstName: 'Получатель',
          middleName: tag,
          // Входа в этом тесте нет: проверяется отбор, а не аутентификация.
          passwordHash: 'db-test-not-a-hash',
          role,
          isActive: true,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      createdUserIds.push(row!.id);
      return row!.id;
    }

    movedUserId = await makeUser('move', 'shtab');
    commandantUserId = await makeUser('comm', 'commandant');
  }, 60_000);

  afterAll(async () => {
    if (!ctx) return;
    // Права расписания уходят каскадом за ним.
    if (createdScheduleIds.length > 0) {
      await ctx.db
        .delete(ctx.schema.mailingSchedules)
        .where(inArray(ctx.schema.mailingSchedules.id, createdScheduleIds));
    }
    if (createdUserIds.length > 0) {
      await ctx.db.delete(ctx.schema.users).where(inArray(ctx.schema.users.id, createdUserIds));
    }
    await ctx.closeDb();
  });

  it('право каждого расписания известно коду', async () => {
    const rows = await ctx.db
      .selectDistinct({ permission: ctx.schema.mailingSchedulePermissions.permission })
      .from(ctx.schema.mailingSchedulePermissions);
    // Сирота — след выката, снявшего право из словаря и забывшего расписания: писем по такой
    // строке не уйдёт никому, и сказать об этом некому. Проверка идёт по всей таблице намеренно:
    // забыть расписания может любой будущий выкат, а не только свой.
    const orphans = rows.map((r) => r.permission).filter((p) => !isPermission(p));
    expect(orphans).toEqual([]);
  });

  it('строка прежней адресации на аудиторию не влияет', async () => {
    // `mailing_schedule_roles` оставлена до миграции удаления (§13 плана: между «перестали писать»
    // и «удалили» обязан пройти релиз), и вот чего она стоить не должна — ни одного получателя.
    // Проверка стоит здесь, а не в форме: вернуть старую таблицу в отбор может любая правка
    // сервиса, и заметить это иначе можно только письмом, ушедшим не тому.
    await ctx.db
      .insert(ctx.schema.mailingScheduleRoles)
      .values({ scheduleId, role: 'commandant' })
      .onConflictDoNothing();

    const ids = (await ctx.digestRecipients(scheduleId, ALL_AUDIENCE)).map((r) => r.userId);
    expect(ids).toContain(movedUserId);
    // У коменданта права заказов техники нет: прежняя адресация его бы выбрала, нынешняя — нет.
    expect(ids).not.toContain(commandantUserId);
  });

  it('смена роли получателя аудиторию не меняет, пока право при нём остаётся', async () => {
    const idsOf = async (): Promise<string[]> =>
      (await ctx.digestRecipients(scheduleId, ALL_AUDIENCE)).map((r) => r.userId);

    expect(await idsOf()).toContain(movedUserId);

    // Перевод роли — ровно то, что делает этап 8 (`shtab` → `site`) и что прежняя адресация
    // ломала: строка расписания с именем старой роли не сопоставилась бы этой учётке ни разу.
    // Здесь роль меняется на ту, у которой то же право, и письмо остаётся при человеке.
    await ctx.db
      .update(ctx.schema.users)
      .set({ role: 'department' })
      .where(eq(ctx.schema.users.id, movedUserId));
    expect(await idsOf()).toContain(movedUserId);

    // А роль без этого права выводит человека из аудитории — и это тоже правильный ответ:
    // адресация следует за работой, а не за названием должности.
    await ctx.db
      .update(ctx.schema.users)
      .set({ role: 'commandant' })
      .where(eq(ctx.schema.users.id, movedUserId));
    expect(await idsOf()).not.toContain(movedUserId);
  });
});
