import { readFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type {
  departmentsByUserIds as DepartmentsByUserIds,
  headsByDepartmentIds as HeadsByDepartmentIds,
  replaceDepartmentHeads as ReplaceDepartmentHeads,
  replaceUserDepartments as ReplaceUserDepartments,
} from '../src/services/user-scopes';

/**
 * Руководитель отдела — признак связи, а не имя роли (миграция 0149, §11.1 плана реструктуризации
 * прав).
 *
 * **Зачем этому тесту база.** Проверяется ровно то, что нельзя проверить на правилах: какой строкой
 * отвечает справочник и что с этой строкой делают три записи — правка набора отделов учётки,
 * правка набора руководителей отдела и перенос миграцией. Цена ошибки здесь не отказ, а тишина:
 * карточка отдела опустеет, ни одного права не изменив и ни одного теста доступа не покрасив, —
 * ради этого развязывание и вынесено отдельным этапом ДО перевода ролей.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test user-scopes
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface TestUser {
  id: string;
  fullName: string;
}

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  departmentsByUserIds: typeof DepartmentsByUserIds;
  headsByDepartmentIds: typeof HeadsByDepartmentIds;
  replaceDepartmentHeads: typeof ReplaceDepartmentHeads;
  replaceUserDepartments: typeof ReplaceUserDepartments;
  /** Кто правит: `created_by` ссылается на живую учётку. */
  actor: TestUser;
  /** Роль «Руководитель отдела» без признака — руководителем не считается. */
  roleOnly: TestUser;
  /** Признак при другой роли — считается. */
  headByFlag: TestUser;
  /** Держатель признака в архиве: связь в базе есть, в карточке отдела его нет. */
  headArchived: TestUser;
  /** Живая учётка объектной оси: отделов у такой роли не бывает вовсе. */
  offAxis: TestUser;
  /** Нерассмотренная заявка: роли нет, области нет. */
  pending: TestUser;
  /** Отдел, по которому читают карточку. */
  readDeptId: string;
  /** Отдел, на котором проверяется перенос миграцией. */
  migrationDeptId: string;
  /** Два отдела для правки набора из карточки учётки. */
  keptDeptId: string;
  addedDeptId: string;
  /** Отдел, на котором правят набор руководителей из карточки справочника. */
  writeDeptId: string;
}

let ctx: Ctx;
const createdUserIds: string[] = [];
const createdDepartmentIds: string[] = [];

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

/**
 * Перенос состояния из миграции 0149 — её собственным текстом, а не пересказом.
 *
 * Пересказ проверял бы, что тест умеет писать тот же UPDATE, а не что его пишет миграция: разойдись
 * они — в базе останется правило миграции, и узнать об этом будет неоткуда. Отсюда и чтение файла.
 *
 * Условие по отделу дописывается снаружи: база у db-тестов общая и живёт между прогонами, а
 * запускать перенос по всей таблице значило бы править чужие строки. Правило переноса при этом
 * остаётся ровно тем, что в файле, — соединение с `users` и условие по роли не трогаются.
 */
function migrationBackfill(departmentId: string): string {
  const text = readFileSync(
    new URL('../drizzle/0149_department_head_link.sql', import.meta.url),
    'utf8',
  );
  const start = text.indexOf('UPDATE user_departments');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return `${text.slice(start, end)} AND ud.department_id = '${departmentId}'`;
}

describe.skipIf(!DB_URL)('руководитель отдела: признак связи, а не роль (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const {
      departmentsByUserIds,
      headsByDepartmentIds,
      replaceDepartmentHeads,
      replaceUserDepartments,
    } = await import('../src/services/user-scopes');

    async function makeUser(input: {
      tag: string;
      // `null` — заявка на регистрацию: роли ей не назначали, области у неё нет.
      role: 'admin' | 'department' | 'department_head' | 'shtab' | null;
      deleted?: boolean;
    }): Promise<TestUser> {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: `db-head-${input.tag}-${suffix}@example.invalid`,
          lastName: 'Тестовый',
          firstName: 'Руководитель',
          middleName: input.tag,
          // Входа в этом тесте нет: связи правятся сервисом, а не через HTTP.
          passwordHash: 'db-test-not-a-hash',
          role: input.role,
          emailVerifiedAt: new Date(),
          deletedAt: input.deleted ? new Date() : null,
        })
        .returning({ id: schema.users.id, fullName: schema.users.fullName });
      createdUserIds.push(row!.id);
      return { id: row!.id, fullName: row!.fullName };
    }

    async function makeDepartment(tag: string): Promise<string> {
      const [row] = await db
        .insert(schema.departments)
        .values({ code: `HD-${tag}-${suffix}`, name: `Тестовый отдел ${tag} ${suffix}` })
        .returning({ id: schema.departments.id });
      createdDepartmentIds.push(row!.id);
      return row!.id;
    }

    ctx = {
      db,
      closeDb,
      schema,
      departmentsByUserIds,
      headsByDepartmentIds,
      replaceDepartmentHeads,
      replaceUserDepartments,
      actor: await makeUser({ tag: 'actor', role: 'admin' }),
      roleOnly: await makeUser({ tag: 'roleonly', role: 'department_head' }),
      headByFlag: await makeUser({ tag: 'byflag', role: 'department' }),
      headArchived: await makeUser({ tag: 'archived', role: 'department_head', deleted: true }),
      offAxis: await makeUser({ tag: 'offaxis', role: 'shtab' }),
      pending: await makeUser({ tag: 'pending', role: null }),
      readDeptId: await makeDepartment('read'),
      migrationDeptId: await makeDepartment('migr'),
      keptDeptId: await makeDepartment('kept'),
      addedDeptId: await makeDepartment('added'),
      writeDeptId: await makeDepartment('write'),
    };

    // Карточка отдела для чтения: роль без признака, признак при другой роли, признак у архивной.
    await db.insert(schema.userDepartments).values([
      { userId: ctx.roleOnly.id, departmentId: ctx.readDeptId, isHead: false },
      { userId: ctx.headByFlag.id, departmentId: ctx.readDeptId, isHead: true },
      { userId: ctx.headArchived.id, departmentId: ctx.readDeptId, isHead: true },
    ]);
  });

  afterAll(async () => {
    if (!ctx) return;
    const { db, schema } = ctx;
    // Связи учёток с отделами уходят каскадом за учёткой; отделы сносятся после них.
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
    if (createdDepartmentIds.length > 0) {
      await db
        .delete(schema.departments)
        .where(inArray(schema.departments.id, createdDepartmentIds));
    }
    await ctx.closeDb();
  });

  /** Признак связи «человек ↔ отдел» — то, что в тесте проверяют чаще всего. */
  async function isHead(userId: string, departmentId: string): Promise<boolean | null> {
    const [row] = await ctx.db
      .select({ isHead: ctx.schema.userDepartments.isHead })
      .from(ctx.schema.userDepartments)
      .where(
        and(
          eq(ctx.schema.userDepartments.userId, userId),
          eq(ctx.schema.userDepartments.departmentId, departmentId),
        ),
      );
    // `null` — связи нет вовсе: у снятия руководства и у «не руководитель» разные ответы.
    return row ? row.isHead : null;
  }

  async function headIds(departmentId: string): Promise<string[]> {
    const map = await ctx.headsByDepartmentIds([departmentId]);
    return (map.get(departmentId) ?? []).map((h) => h.id);
  }

  describe('чтение карточки отдела', () => {
    it('роль «Руководитель отдела» без признака руководителем не делает', async () => {
      expect(await headIds(ctx.readDeptId)).not.toContain(ctx.roleOnly.id);
    });

    it('признак делает руководителем при любой роли', async () => {
      // Учётка роли «Отдел» — рядовой сотрудник по правам, — но в карточке этого отдела она и есть
      // руководитель: слияние ролей не должно опустошать справочник.
      expect(await headIds(ctx.readDeptId)).toContain(ctx.headByFlag.id);
    });

    it('архивная учётка из карточки исчезает, а связь остаётся', async () => {
      expect(await headIds(ctx.readDeptId)).not.toContain(ctx.headArchived.id);
      expect(await isHead(ctx.headArchived.id, ctx.readDeptId)).toBe(true);
    });
  });

  describe('признак в карточке учётки', () => {
    it('приходит той же строкой, что и отдел: второй стороны связи для него не нужно', async () => {
      // Пока признака не было в `UserDepartmentRefDto`, портал выводил его из `DepartmentDto.heads`
      // — вторым запросом в справочник, который выключенные отделы не отдаёт вовсе.
      const byUser = await ctx.departmentsByUserIds([ctx.headByFlag.id, ctx.roleOnly.id]);
      const head = (byUser.get(ctx.headByFlag.id) ?? []).find((d) => d.id === ctx.readDeptId);
      expect(head?.isHead).toBe(true);
      // Роль «Руководитель отдела» сама по себе признака не даёт — карточка учётки отвечает тем же,
      // чем карточка отдела.
      const member = (byUser.get(ctx.roleOnly.id) ?? []).find((d) => d.id === ctx.readDeptId);
      expect(member?.isHead).toBe(false);
    });
  });

  describe('перенос состояния миграцией', () => {
    it('существующие связи учёток с ролью получают признак, чужие — нет', async () => {
      const { db, schema } = ctx;
      // Состояние «до миграции»: признака нет ни у кого, хотя роль у двоих та самая.
      await db.insert(schema.userDepartments).values([
        { userId: ctx.roleOnly.id, departmentId: ctx.migrationDeptId, isHead: false },
        { userId: ctx.headArchived.id, departmentId: ctx.migrationDeptId, isHead: false },
        { userId: ctx.headByFlag.id, departmentId: ctx.migrationDeptId, isHead: false },
      ]);

      await db.execute(sql.raw(migrationBackfill(ctx.migrationDeptId)));

      expect(await isHead(ctx.roleOnly.id, ctx.migrationDeptId)).toBe(true);
      // Архивная переносится наравне с живой: фильтр по `deleted_at` стоит на чтении, и
      // восстановление учётки обязано вернуть человека отделу руководителем, а не рядовым.
      expect(await isHead(ctx.headArchived.id, ctx.migrationDeptId)).toBe(true);
      // Сотрудник отдела руководителем не становится: перенос повторяет прежний запрос дословно.
      expect(await isHead(ctx.headByFlag.id, ctx.migrationDeptId)).toBe(false);
    });
  });

  describe('правка набора отделов из карточки учётки', () => {
    it('сохраняет признак у оставшихся связей, а новую заводит сотрудником', async () => {
      const { db, schema } = ctx;
      await db
        .insert(schema.userDepartments)
        .values({ userId: ctx.headByFlag.id, departmentId: ctx.keptDeptId, isHead: true });

      const changed = await db.transaction((tx) =>
        ctx.replaceUserDepartments(
          tx,
          ctx.headByFlag.id,
          // Набор, который присылает форма учётки: прежний отдел плюс новый.
          [ctx.readDeptId, ctx.migrationDeptId, ctx.keptDeptId, ctx.addedDeptId],
          ctx.actor.id,
        ),
      );

      expect(changed).toBe(true);
      // Признак пережил правку, которая его не касалась: строка не пересоздавалась.
      expect(await isHead(ctx.headByFlag.id, ctx.keptDeptId)).toBe(true);
      expect(await headIds(ctx.keptDeptId)).toContain(ctx.headByFlag.id);
      // Новый отдел — участие, а не руководство: его назначают из карточки справочника.
      expect(await isHead(ctx.headByFlag.id, ctx.addedDeptId)).toBe(false);
    });

    it('отдел, убранный из набора, уносит и руководство', async () => {
      const { db } = ctx;
      await db.transaction((tx) =>
        ctx.replaceUserDepartments(
          tx,
          ctx.headByFlag.id,
          [ctx.readDeptId, ctx.migrationDeptId, ctx.addedDeptId],
          ctx.actor.id,
        ),
      );

      expect(await isHead(ctx.headByFlag.id, ctx.keptDeptId)).toBeNull();
      expect(await headIds(ctx.keptDeptId)).toEqual([]);
    });
  });

  describe('правка набора руководителей из карточки отдела', () => {
    it('назначает руководителем при любой роли и не пересоздаёт связь участника', async () => {
      const { db, schema } = ctx;
      // Человек уже состоит в отделе сотрудником — назначение обязано поставить признак, не
      // переписав автора и время привязки: они описывают участие, которое старше назначения.
      await db
        .insert(schema.userDepartments)
        .values({ userId: ctx.headByFlag.id, departmentId: ctx.writeDeptId, isHead: false });
      const [before] = await db
        .select({ createdAt: schema.userDepartments.createdAt })
        .from(schema.userDepartments)
        .where(
          and(
            eq(schema.userDepartments.userId, ctx.headByFlag.id),
            eq(schema.userDepartments.departmentId, ctx.writeDeptId),
          ),
        );

      const affected = await db.transaction((tx) =>
        // Роль кандидата больше не проверяется: `headByFlag` — учётка роли «Отдел», и прежний код
        // отвечал бы отказом «не руководитель отдела».
        ctx.replaceDepartmentHeads(
          tx,
          ctx.writeDeptId,
          [ctx.headByFlag.id, ctx.roleOnly.id],
          ctx.actor.id,
        ),
      );

      expect(affected).toEqual(expect.arrayContaining([ctx.headByFlag.id, ctx.roleOnly.id]));
      expect(await isHead(ctx.headByFlag.id, ctx.writeDeptId)).toBe(true);
      expect(await isHead(ctx.roleOnly.id, ctx.writeDeptId)).toBe(true);
      const [after] = await db
        .select({ createdAt: schema.userDepartments.createdAt })
        .from(schema.userDepartments)
        .where(
          and(
            eq(schema.userDepartments.userId, ctx.headByFlag.id),
            eq(schema.userDepartments.departmentId, ctx.writeDeptId),
          ),
        );
      expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
    });

    it('снятие руководства убирает связь целиком — область отдела не остаётся', async () => {
      const { db } = ctx;
      const affected = await db.transaction((tx) =>
        ctx.replaceDepartmentHeads(tx, ctx.writeDeptId, [ctx.roleOnly.id], ctx.actor.id),
      );

      expect(affected).toEqual([ctx.headByFlag.id]);
      // Не «признак снят, участие осталось»: иначе освобождённый от руководства продолжал бы
      // видеть заявки отдела, и расширение доступа сделал бы шаг, доступа не касавшийся.
      expect(await isHead(ctx.headByFlag.id, ctx.writeDeptId)).toBeNull();
      expect(await headIds(ctx.writeDeptId)).toEqual([ctx.roleOnly.id]);
    });

    it('учётку вне отдельской оси в руководители не берут — иначе назначение отменилось бы молча', async () => {
      // Роль решает, есть ли у учётки ось отдела: у объектной роли набор отделов обнуляется при
      // каждом сохранении карточки (`resolveDepartmentIds`), и признак ушёл бы вместе с ним — от
      // правки телефона, руководства не касавшейся. Отказ здесь называет причину, а не запрет.
      await expect(
        ctx.db.transaction((tx) =>
          ctx.replaceDepartmentHeads(tx, ctx.writeDeptId, [ctx.offAxis.id], ctx.actor.id),
        ),
      ).rejects.toThrow(/отделы бывают только у ролей/);
      expect(await isHead(ctx.offAxis.id, ctx.writeDeptId)).toBeNull();

      // Заявка на регистрацию — тот же отказ другими словами: роли ей ещё не назначили.
      await expect(
        ctx.db.transaction((tx) =>
          ctx.replaceDepartmentHeads(tx, ctx.writeDeptId, [ctx.pending.id], ctx.actor.id),
        ),
      ).rejects.toThrow(/заявка на регистрацию/);
    });

    it('отказ случается до записи: набор руководителей остаётся прежним', async () => {
      // Проверяется не откат транзакции, а порядок: сначала проверка всего набора, потом правки.
      // Иначе назначение годного кандидата зависело бы от того, каким по счёту в списке стоит
      // негодный, — и половина набора уезжала бы в базу до отказа.
      const before = await headIds(ctx.writeDeptId);
      await expect(
        ctx.db.transaction((tx) =>
          ctx.replaceDepartmentHeads(
            tx,
            ctx.writeDeptId,
            [ctx.headByFlag.id, ctx.offAxis.id],
            ctx.actor.id,
          ),
        ),
      ).rejects.toThrow();
      expect(await headIds(ctx.writeDeptId)).toEqual(before);
    });

    it('несуществующую учётку в руководители не берут', async () => {
      const { db } = ctx;
      await expect(
        db.transaction((tx) =>
          ctx.replaceDepartmentHeads(tx, ctx.writeDeptId, [randomUUID()], ctx.actor.id),
        ),
      ).rejects.toThrow();
      // Архивная — то же самое: привязать того, кого в справочнике учёток нет, нельзя.
      await expect(
        db.transaction((tx) =>
          ctx.replaceDepartmentHeads(tx, ctx.writeDeptId, [ctx.headArchived.id], ctx.actor.id),
        ),
      ).rejects.toThrow();
    });
  });
});
