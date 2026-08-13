import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import { pgErrorOf } from '../src/lib/pg-error';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Учётная запись водителя (ADR 0102, план §2 — Р1–Р8, Р30, Р31) — на живой схеме, через настоящие
 * HTTP-пути.
 *
 * Зачем база. Правило «водитель в портале — это карточка человека, у которой появился вход»
 * держится не кодом, а условием БД `users_driver_person_check` (миграция 0131), и всё остальное
 * решение выстроено вокруг него: отвязки живой водительской учётки не бывает вовсе (Р6), а
 * восстановление из архива обязано выбрать человека той же транзакцией (Р8) — иначе оно упрётся в
 * то же условие пятисоткой из драйвера. Проверить это на подменах нельзя: расходятся не правила, а
 * код и схема, и увидеть расхождение можно только там, где CHECK существует.
 *
 * Тем же и объясняется остальной состав файла. Увольнение (Р2) закрывает карточку, а не учётку, и
 * запрет входа держится соединением двух таблиц. Дозаполнение при привязке (Р31) правит **вторую**
 * строку — карточку, — и вопрос «откатится ли оно вместе с отказом» вне транзакции не задать.
 * Обратный перенос ФИО и телефона из справочника в учётку (Р31) — тоже правка двух таблиц одним
 * запросом.
 *
 * Запуск — как у остальных db-тестов (README, `docs/runbook.md`):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test driver-account
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const EMAIL_LIKE = `db-drvacc-%-${RUN}@example.invalid`;

function emailOf(tag: string): string {
  return `db-drvacc-${tag}-${RUN}@example.invalid`;
}

/**
 * СНИЛС генерируется, а не берётся из сида: номера сида в общей базе заняты живыми карточками.
 * Контрольное число считается правилами ПФР — иначе разбор отвергнет номер раньше базы.
 */
function makeSnils(): string {
  const nums = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = nums.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${nums.join('')}${String(checksum).padStart(2, '0')}`;
}

/**
 * Телефоны — десятизначные и свои у каждой стороны: перенос проверяется сверкой значений, и один
 * номер на всех сделал бы «приехал из карточки» неотличимым от «так и было».
 */
let phoneNo = 0;
function nextPhone(): string {
  phoneNo += 1;
  return `99900${String(phoneNo).padStart(5, '0')}`;
}

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  passwordHash: string;
}

let ctx: Ctx;
/** Карточки, заведённые прогоном: их СНИЛС снимаются в конце. */
const createdSnils: string[] = [];

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а входов в файле несколько. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

interface PersonSeed {
  lastName?: string;
  firstName?: string;
  middleName?: string;
  phone?: string;
  email?: string;
}

/** Карточка работника — той же ручкой, что зовёт справочник водителей. */
async function createPerson(seed: PersonSeed = {}): Promise<string> {
  const snils = makeSnils();
  createdSnils.push(snils);
  const res = await inject('POST', '/api/v1/drivers', ctx.admin, {
    lastName: seed.lastName ?? 'Водителев',
    firstName: seed.firstName ?? 'Иван',
    middleName: seed.middleName ?? 'Иванович',
    snils,
    phone: seed.phone ?? '',
    email: seed.email ?? '',
    jobTitle: 'Водитель',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

interface AccountSeed {
  tag: string;
  role?: string;
  personId?: string | null;
  lastName?: string;
  firstName?: string;
  middleName?: string;
  phone?: string;
  confirmNameMismatch?: boolean;
}

/** Учётка — ручкой администратора: письмо не просим, предмет проверки не почта. */
async function createAccount(seed: AccountSeed): Promise<{ id: string; email: string }> {
  const email = emailOf(seed.tag);
  const res = await inject('POST', '/api/v1/users', ctx.admin, {
    email,
    lastName: seed.lastName ?? 'Водителев',
    firstName: seed.firstName ?? 'Иван',
    middleName: seed.middleName ?? 'Иванович',
    phone: seed.phone ?? '',
    role: seed.role ?? 'driver',
    password: PASSWORD,
    isActive: true,
    notifyUser: false,
    ...(seed.personId === undefined ? {} : { personId: seed.personId }),
    ...(seed.confirmNameMismatch ? { confirmNameMismatch: true } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().user.id as string, email };
}

interface UserRow {
  id: string;
  person_id: string | null;
  role: string | null;
  deleted_at: Date | null;
  auth_version: number;
  last_name: string;
  middle_name: string;
  phone: string;
  email: string;
}

async function userRow(id: string): Promise<UserRow> {
  const res = await ctx.db.execute<UserRow>(sql`
    SELECT id, person_id, role::text AS role, deleted_at, auth_version,
           last_name, middle_name, phone, email::text AS email
      FROM users WHERE id = ${id}`);
  return res.rows[0]!;
}

interface PersonRow {
  id: string;
  last_name: string;
  middle_name: string;
  phone: string;
  email: string;
  deleted_at: Date | null;
  version: number;
}

async function personRow(id: string): Promise<PersonRow> {
  const res = await ctx.db.execute<PersonRow>(sql`
    SELECT id, last_name, middle_name, phone, email::text AS email, deleted_at, version
      FROM persons WHERE id = ${id}`);
  return res.rows[0]!;
}

/** События журнала по учётке: перепривязка (Р6) обязана быть отдельной записью. */
async function auditOf(
  entityId: string,
  action: string,
): Promise<{ metadata: Record<string, unknown> }[]> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_id = ${entityId} AND action = ${action}
     ORDER BY created_at`);
  return [...res.rows];
}

async function login(email: string): Promise<{ statusCode: number; body: string; token?: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress: nextAddress(),
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    token: res.statusCode === 200 ? (res.json().accessToken as string) : undefined,
  };
}

describe.skipIf(!DB_URL)('учётная запись водителя (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);
    // Администратор заводится SQL: форма учётки — предмет самого файла, и заводить ею же ту
    // учётку, которой всё делается, значило бы проверять её собой.
    await db.execute(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${emailOf('admin')}, 'Тестовый', 'Администратор', '', ${passwordHash},
              'admin'::role, true, now())`);

    const app = await buildApp();
    ctx = {
      app,
      db,
      closeDb,
      admin: { authorization: '' },
      passwordHash,
    };
    const admin = await login(emailOf('admin'));
    expect(admin.statusCode, admin.body).toBe(200);
    ctx.admin = { authorization: `Bearer ${admin.token}` };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    // Порядок обратный ссылкам: журнал держит учётки внешним ключом, учётки — карточки (SET NULL).
    const ours = sql`SELECT id FROM users WHERE email LIKE ${EMAIL_LIKE}`;
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_LIKE}`);
    if (createdSnils.length > 0) {
      await ctx.db.execute(
        sql`DELETE FROM persons WHERE snils IN (${sql.join(
          createdSnils.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      );
    }
    await ctx.closeDb();
  });

  /**
   * Само условие (Р2). Оно и есть причина всему остальному в файле: живая учётка водителя без
   * карточки не ответит ни на один вопрос кабинета, а выяснится это в шесть утра, когда человек
   * полез смотреть задание.
   */
  describe('условие БД: живая учётка водителя без работника невозможна', () => {
    it('вставка живой строки роли «Водитель» без работника отклоняется базой', async () => {
      // Отказ разбирается через `pgErrorOf`, а не сверкой текста: drizzle оборачивает ошибку
      // драйвера в свою, и на верхнем сообщении остаётся только сам запрос — код и имя нарушенного
      // ограничения лежат в `cause`. Сверять «упало хоть как-нибудь» здесь нельзя: опечатка в
      // самой вставке дала бы точно такой же провалившийся промис.
      const failure = await ctx.db
        .execute(
          sql`
          INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                             is_active)
          VALUES (${emailOf('check-live')}, 'Безкарточкин', 'Иван', '', ${ctx.passwordHash},
                  'driver'::role, true)`,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(failure, 'вставка прошла — CHECK не сработал').not.toBeNull();
      expect(pgErrorOf(failure)).toMatchObject({
        // 23514 — check_violation: отказало именно условие, а не уникальность адреса.
        code: '23514',
        constraint: 'users_driver_person_check',
      });
    });

    it('архивная — законна: удаление человека обнуляет ссылку именно у неё', async () => {
      // Ветка `deleted_at IS NOT NULL` не смягчает правило, а делает его исполнимым:
      // `users.person_id` объявлен ON DELETE SET NULL, и без неё архивная строка стала бы
      // неудаляемой и непочинимой — CHECK не дал бы ни обновить её, ни снести человека.
      await expect(
        ctx.db.execute(sql`
          INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                             is_active, deleted_at)
          VALUES (${emailOf('check-archived')}, 'Архивный', 'Пётр', '', ${ctx.passwordHash},
                  'driver'::role, false, now())`),
      ).resolves.toBeTruthy();
    });

    it('учётка водителя заводится вместе с работником и им же держится', async () => {
      const personId = await createPerson({ lastName: 'Заводимов', firstName: 'Семён' });
      const account = await createAccount({
        tag: 'created',
        personId,
        lastName: 'Заводимов',
        firstName: 'Семён',
      });
      expect((await userRow(account.id)).person_id).toBe(personId);
    });
  });

  /**
   * Увольнение (Р2). Закрывается карточка, а учётку никто не трогает — и без сверки при каждом
   * входе человек смотрел бы задания и телефоны заказчиков ещё две недели, пока жив выданный
   * refresh-токен.
   */
  describe('уволенный водитель', () => {
    it('входит, пока карточка жива, и перестаёт входить, как только она в архиве', async () => {
      const personId = await createPerson({ lastName: 'Уволеннов', firstName: 'Олег' });
      const account = await createAccount({
        tag: 'fired',
        personId,
        lastName: 'Уволеннов',
        firstName: 'Олег',
      });
      const before = await login(account.email);
      expect(before.statusCode, before.body).toBe(200);

      const archived = await inject('DELETE', `/api/v1/drivers/${personId}`, ctx.admin);
      expect(archived.statusCode, archived.body).toBe(204);

      const after = await login(account.email);
      // Отказ именно входа, а не «неверный пароль»: человеку сказано, что делать дальше.
      expect(after.statusCode, after.body).toBe(403);
      expect(after.body).toContain('карточкой работника');
      // Учётка при этом жива и активна — закрыта карточка, и только она.
      expect(await userRow(account.id)).toMatchObject({ deleted_at: null, person_id: personId });
    });

    it('и выданный до увольнения токен перестаёт действовать в тот же миг', async () => {
      // Второй запрет, тот же по смыслу: `loadPrincipal` сверяет карточку на каждом запросе. Без
      // него уже выданный access-токен доживал бы свой срок в кабинете уволенного.
      const personId = await createPerson({ lastName: 'Токенов', firstName: 'Илья' });
      const account = await createAccount({
        tag: 'token',
        personId,
        lastName: 'Токенов',
        firstName: 'Илья',
      });
      const session = await login(account.email);
      expect(session.statusCode, session.body).toBe(200);
      const auth = { authorization: `Bearer ${session.token}` };

      const before = await inject('GET', '/api/v1/auth/me', auth);
      expect(before.statusCode, before.body).toBe(200);

      await inject('DELETE', `/api/v1/drivers/${personId}`, ctx.admin);

      const after = await inject('GET', '/api/v1/auth/me', auth);
      expect(after.statusCode, after.body).toBe(401);
    });
  });

  /**
   * Замена человека (Р6). Отвязки живой водительской учётки не бывает: между шагами «отвязать» и
   * «привязать» строка нарушала бы CHECK, а транзакция из двух запросов портала не гарантируется
   * ничем. Поэтому ошибочно привязанного **заменяют** одним действием.
   */
  describe('перепривязка работника', () => {
    it('отвязать живую учётку водителя нельзя — только заменить', async () => {
      const personId = await createPerson({ lastName: 'Отвязкин', firstName: 'Роман' });
      const account = await createAccount({
        tag: 'unbind',
        personId,
        lastName: 'Отвязкин',
        firstName: 'Роман',
      });

      const res = await inject('PATCH', `/api/v1/users/${account.id}`, ctx.admin, {
        personId: null,
      });

      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('обязателен работник');
      expect((await userRow(account.id)).person_id).toBe(personId);
    });

    it('замена проходит одним действием: работник, версия токенов и событие журнала', async () => {
      const first = await createPerson({ lastName: 'Сменяев', firstName: 'Артём' });
      const second = await createPerson({ lastName: 'Сменяев', firstName: 'Артём' });
      const account = await createAccount({
        tag: 'relink',
        personId: first,
        lastName: 'Сменяев',
        firstName: 'Артём',
      });
      const versionBefore = (await userRow(account.id)).auth_version;

      const res = await inject('PATCH', `/api/v1/users/${account.id}`, ctx.admin, {
        personId: second,
      });
      expect(res.statusCode, res.body).toBe(200);

      const row = await userRow(account.id);
      expect(row.person_id).toBe(second);
      // Сменившийся работник — это другие рейсы в кабинете: выданные токены гасятся так же, как
      // при смене роли.
      expect(row.auth_version).toBe(versionBefore + 1);

      // Своё событие журнала со старым и новым человеком: внутри общей правки от перепривязки
      // остался бы один флаг «что-то поменяли», а разбирают её вопросом «кому ушли задания».
      const events = await auditOf(account.id, 'user.driver_person_relinked');
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ person: { from: first, to: second } });
    });

    it('занятого работника не отдаёт: у него уже есть живая учётка', async () => {
      const mine = await createPerson({ lastName: 'Занятов', firstName: 'Кирилл' });
      const taken = await createPerson({ lastName: 'Занятов', firstName: 'Кирилл' });
      const account = await createAccount({
        tag: 'busy-mine',
        personId: mine,
        lastName: 'Занятов',
        firstName: 'Кирилл',
      });
      await createAccount({
        tag: 'busy-taken',
        personId: taken,
        lastName: 'Занятов',
        firstName: 'Кирилл',
      });

      const res = await inject('PATCH', `/api/v1/users/${account.id}`, ctx.admin, {
        personId: taken,
      });

      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('уже заведена учётная запись');
      expect((await userRow(account.id)).person_id).toBe(mine);
    });

    it('уволенного не привязывает: карточка в архиве — сначала восстановите её', async () => {
      const mine = await createPerson({ lastName: 'Архивов', firstName: 'Глеб' });
      const fired = await createPerson({ lastName: 'Архивов', firstName: 'Глеб' });
      await inject('DELETE', `/api/v1/drivers/${fired}`, ctx.admin);
      const account = await createAccount({
        tag: 'relink-fired',
        personId: mine,
        lastName: 'Архивов',
        firstName: 'Глеб',
      });

      const res = await inject('PATCH', `/api/v1/users/${account.id}`, ctx.admin, {
        personId: fired,
      });

      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('в архиве');
      expect((await userRow(account.id)).person_id).toBe(mine);
    });

    it('отказ на любом шаге правки уносит и дозаполнение карточки', async () => {
      // Привязка правит ВТОРУЮ строку — карточку (Р31), — и делает это раньше, чем сама учётка
      // сохранена. Если бы дозаполнение шло своей транзакцией, отказ на следующем шаге оставил бы
      // в карточке телефон учётки, которую так и не привязали.
      const person = await createPerson({ lastName: 'Откатов', firstName: 'Юрий', phone: '' });
      const account = await createAccount({
        tag: 'rollback',
        role: 'observer',
        lastName: 'Откатов',
        firstName: 'Юрий',
        phone: nextPhone(),
      });
      const accountPhone = (await userRow(account.id)).phone;

      // Правка «роль объекта + несуществующий объект + новый работник»: работник привязывается и
      // дозаполняет карточку, а объекты проверяются следом — и не находятся.
      const res = await inject('PATCH', `/api/v1/users/${account.id}`, ctx.admin, {
        personId: person,
        role: 'shtab',
        constructionObjectIds: [randomUUID()],
      });

      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('Объект не найден');
      // Ни учётка, ни карточка не сдвинулись: телефон не уехал, работник не привязан, роль прежняя.
      expect(await personRow(person)).toMatchObject({ phone: '' });
      expect(await userRow(account.id)).toMatchObject({
        person_id: null,
        role: 'observer',
        phone: accountPhone,
      });
    });
  });

  /**
   * Дозаполнение (Р31) и подтверждение расхождения ФИО (Р30). Пусто с одной стороны — переносим
   * молча, отметив в журнале; заполнено с обеих и различается — не трогаем ничего.
   */
  describe('привязка сводит учётку и карточку', () => {
    it('пустое поле заполняется из другой стороны — в обе стороны, но каждое своей', async () => {
      const personPhone = nextPhone();
      const person = await createPerson({
        lastName: 'Дозаполнев',
        firstName: 'Марк',
        // Отчества в карточке нет, телефон есть — и наоборот в учётке: каждая сторона отдаёт то,
        // чего нет у другой.
        middleName: '',
        phone: personPhone,
        email: '',
      });
      const account = await createAccount({
        tag: 'fill',
        personId: person,
        lastName: 'Дозаполнев',
        firstName: 'Марк',
        middleName: 'Маркович',
        phone: '',
      });

      expect(await userRow(account.id)).toMatchObject({
        middle_name: 'Маркович',
        // Телефон приехал из карточки: в учётке его не было.
        phone: personPhone,
      });
      expect(await personRow(person)).toMatchObject({
        // Отчество приехало из учётки: в карточке его не было.
        middle_name: 'Маркович',
        // Адрес переносится только в карточку: на него шлёт письма рассылка «Задание водителю»,
        // а обратно нельзя — адрес учётки это логин.
        email: account.email,
      });

      // Перенос идёт молча, и запись журнала — единственный его след: без неё «откуда у учётки
      // взялся телефон» осталось бы вопросом без ответа.
      const events = await auditOf(account.id, 'user.create');
      expect(events[0]!.metadata).toMatchObject({
        personId: person,
        filledFields: { middleName: 'person', phone: 'user', email: 'person' },
      });
    });

    it('расходящееся поле не трогается ни с одной стороны', async () => {
      const personPhone = nextPhone();
      const accountPhone = nextPhone();
      const person = await createPerson({
        lastName: 'Расхождев',
        firstName: 'Тимур',
        middleName: 'Тимурович',
        phone: personPhone,
        email: 'card-owner@example.invalid',
      });
      const account = await createAccount({
        tag: 'diverged',
        personId: person,
        lastName: 'Расхождев',
        firstName: 'Тимур',
        middleName: 'Тимофеевич',
        phone: accountPhone,
      });

      expect(await userRow(account.id)).toMatchObject({
        middle_name: 'Тимофеевич',
        phone: accountPhone,
      });
      expect(await personRow(person)).toMatchObject({
        middle_name: 'Тимурович',
        phone: personPhone,
        // Свой адрес карточки, заведённый кадрами, привязка не трогает: он принадлежит справочнику.
        email: 'card-owner@example.invalid',
      });
      const events = await auditOf(account.id, 'user.create');
      expect(events[0]!.metadata).not.toHaveProperty('filledFields');
    });

    it('расхождение фамилии требует подтверждения — и записывает его в журнал', async () => {
      const person = await createPerson({ lastName: 'Петров', firstName: 'Никита' });

      const refused = await inject('POST', '/api/v1/users', ctx.admin, {
        email: emailOf('mismatch'),
        lastName: 'Иванов',
        firstName: 'Никита',
        middleName: '',
        role: 'driver',
        password: PASSWORD,
        isActive: true,
        notifyUser: false,
        personId: person,
      });
      // Смена фамилии — дело обычное, случайный однофамилец — редкое, и различить их может только
      // человек: молчаливая привязка отдала бы заявителю чужие задания вместе с телефонами.
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().message).toContain('подтвердите');
      expect(refused.json().fields).toMatchObject({ confirmNameMismatch: expect.any(String) });

      const account = await createAccount({
        tag: 'mismatch',
        personId: person,
        lastName: 'Иванов',
        firstName: 'Никита',
        middleName: '',
        confirmNameMismatch: true,
      });
      const events = await auditOf(account.id, 'user.create');
      expect(events[0]!.metadata).toMatchObject({ nameMismatchConfirmed: true });
    });

    it('отчество расхождением не считается: его пишут по-разному и часто не пишут вовсе', async () => {
      // Расхождение самое обыкновенное — «ё» против «е»: в паспорте одно, в кадрах другое. Спроси
      // портал подтверждение по отчеству — его спрашивали бы у половины привязок, то есть галочка
      // перестала бы что-либо значить.
      const person = await createPerson({
        lastName: 'Отчествов',
        firstName: 'Павел',
        middleName: 'Артёмович',
      });
      const account = await createAccount({
        tag: 'patronymic',
        personId: person,
        lastName: 'Отчествов',
        firstName: 'Павел',
        middleName: 'Артемович',
      });

      // Привязка прошла без подтверждения, и обе стороны остались при своём написании: заполнено с
      // обеих — не переносим (Р31).
      expect((await userRow(account.id)).person_id).toBe(person);
      expect((await userRow(account.id)).middle_name).toBe('Артемович');
      expect((await personRow(person)).middle_name).toBe('Артёмович');
      const events = await auditOf(account.id, 'user.create');
      expect(events[0]!.metadata).not.toHaveProperty('nameMismatchConfirmed');
    });
  });

  /**
   * Восстановление из архива (Р8). Архивная учётка `person_id` иметь не обязана — при удалении
   * человека связь обнуляется, — поэтому вернуть её вслепую нельзя: CHECK ответил бы пятисоткой
   * ровно так же, как раньше отвечал занятый адрес.
   */
  describe('возврат водительской учётки из архива', () => {
    it('без работника отказывает, с работником — восстанавливает той же транзакцией', async () => {
      const person = await createPerson({ lastName: 'Возвратов', firstName: 'Денис' });
      const account = await createAccount({
        tag: 'restore',
        personId: person,
        lastName: 'Возвратов',
        firstName: 'Денис',
      });

      // Учётка в архив, следом карточка — и насовсем: так `person_id` и обнуляется в жизни
      // (`ON DELETE SET NULL`), а не выдуманным UPDATE.
      expect((await inject('DELETE', `/api/v1/users/${account.id}`, ctx.admin)).statusCode).toBe(
        200,
      );
      expect((await inject('DELETE', `/api/v1/drivers/${person}`, ctx.admin)).statusCode).toBe(204);
      const purged = await inject('DELETE', `/api/v1/drivers/${person}/purge`, ctx.admin);
      expect(purged.statusCode, purged.body).toBe(200);
      expect(await userRow(account.id)).toMatchObject({ person_id: null });

      const blind = await inject('POST', `/api/v1/users/${account.id}/restore`, ctx.admin);
      expect(blind.statusCode, blind.body).toBe(400);
      expect(blind.json().message).toContain('обязателен работник');
      // Отказ ничего не сдвинул: учётка осталась в архиве.
      expect((await userRow(account.id)).deleted_at).not.toBeNull();

      const replacement = await createPerson({ lastName: 'Возвратов', firstName: 'Денис' });
      const restored = await inject('POST', `/api/v1/users/${account.id}/restore`, ctx.admin, {
        personId: replacement,
      });
      expect(restored.statusCode, restored.body).toBe(200);
      // Снятие `deleted_at` и привязка — один UPDATE: строки без работника между ними не бывает,
      // иначе CHECK ответил бы пятисоткой.
      expect(await userRow(account.id)).toMatchObject({
        deleted_at: null,
        person_id: replacement,
      });
    });

    it('прежний работник проверяется заново: пока учётка лежала в архиве, его могли занять', async () => {
      const person = await createPerson({ lastName: 'Перехватов', firstName: 'Егор' });
      const account = await createAccount({
        tag: 'restore-taken',
        personId: person,
        lastName: 'Перехватов',
        firstName: 'Егор',
      });
      await inject('DELETE', `/api/v1/users/${account.id}`, ctx.admin);
      // Человек вернулся раньше своей учётки, и ему завели новую: архивная его не занимает.
      await createAccount({
        tag: 'restore-new',
        personId: person,
        lastName: 'Перехватов',
        firstName: 'Егор',
      });

      const res = await inject('POST', `/api/v1/users/${account.id}/restore`, ctx.admin);

      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('уже заведена учётная запись');
      expect((await userRow(account.id)).deleted_at).not.toBeNull();
    });
  });

  /**
   * Удаление карточки насовсем (Р2). Внешний ключ здесь не помощник: `users.person_id` объявлен
   * ON DELETE SET NULL и молча отвязал бы человека от его входа в портал.
   */
  describe('удаление карточки насовсем при живой учётке', () => {
    it('водителю отказывает и зовёт в архив: отвязать его учётку нельзя вовсе', async () => {
      const person = await createPerson({ lastName: 'Неудалимов', firstName: 'Борис' });
      await createAccount({
        tag: 'purge-driver',
        personId: person,
        lastName: 'Неудалимов',
        firstName: 'Борис',
      });
      await inject('DELETE', `/api/v1/drivers/${person}`, ctx.admin);

      const res = await inject('DELETE', `/api/v1/drivers/${person}/purge`, ctx.admin);

      expect(res.statusCode, res.body).toBe(409);
      // Совет отвязать выполним не у всякой учётки: у водительской связь обязательна (CHECK), и
      // путь из неё один — в архив.
      expect(res.json().message).toBe(
        'На водителя заведена учётная запись — сначала заархивируйте её',
      );
      expect(await personRow(person)).toBeTruthy();
    });

    it('прочим ролям текст прежний: связь у них справочная и снимается правкой', async () => {
      const person = await createPerson({ lastName: 'Справочнов', firstName: 'Антон' });
      await createAccount({
        tag: 'purge-other',
        role: 'observer',
        personId: person,
        lastName: 'Справочнов',
        firstName: 'Антон',
      });
      await inject('DELETE', `/api/v1/drivers/${person}`, ctx.admin);

      const res = await inject('DELETE', `/api/v1/drivers/${person}/purge`, ctx.admin);

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toBe(
        'На водителя заведена учётная запись — сначала отвяжите или удалите её',
      );
    });

    it('архивная учётка удалению не мешает: она уже ничем не распоряжается', async () => {
      const person = await createPerson({ lastName: 'Архивоучёткин', firstName: 'Лев' });
      const account = await createAccount({
        tag: 'purge-archived',
        personId: person,
        lastName: 'Архивоучёткин',
        firstName: 'Лев',
      });
      await inject('DELETE', `/api/v1/users/${account.id}`, ctx.admin);
      await inject('DELETE', `/api/v1/drivers/${person}`, ctx.admin);

      const res = await inject('DELETE', `/api/v1/drivers/${person}/purge`, ctx.admin);

      expect(res.statusCode, res.body).toBe(200);
      // Ссылка обнулилась внешним ключом — ради этого CHECK и держит ветку про архив.
      expect(await userRow(account.id)).toMatchObject({ person_id: null });
    });
  });

  /**
   * Владелец ФИО и телефона — справочник (Р31): в карточке имя нормализовано и подтверждено
   * документами, а в учётке его могли ввести как попало. Поэтому правка карточки доезжает до живой
   * учётки, а обратно — нет.
   */
  describe('правка карточки доезжает до учётки', () => {
    it('ФИО и телефон переносятся, адрес — нет: он принадлежит учётке', async () => {
      const person = await createPerson({
        lastName: 'Правкин',
        firstName: 'Степан',
        middleName: 'Степанович',
        phone: nextPhone(),
        email: 'card-before@example.invalid',
      });
      const account = await createAccount({
        tag: 'sync',
        personId: person,
        lastName: 'Правкин',
        firstName: 'Степан',
        middleName: 'Степанович',
        phone: nextPhone(),
      });
      const version = (await personRow(person)).version;
      const newPhone = nextPhone();

      const res = await inject('PATCH', `/api/v1/drivers/${person}`, ctx.admin, {
        lastName: 'Правкина',
        phone: newPhone,
        email: 'card-after@example.invalid',
        version,
      });
      expect(res.statusCode, res.body).toBe(200);

      expect(await userRow(account.id)).toMatchObject({
        last_name: 'Правкина',
        phone: newPhone,
        // Адрес учётки — это логин, и меняют его подтверждением владения ящиком (ADR 0092).
        email: account.email,
      });
    });

    it('в архивную учётку не доезжает: правится живая, и только она', async () => {
      const person = await createPerson({
        lastName: 'Архивоправкин',
        firstName: 'Гурий',
        phone: nextPhone(),
      });
      const account = await createAccount({
        tag: 'sync-archived',
        personId: person,
        lastName: 'Архивоправкин',
        firstName: 'Гурий',
      });
      await inject('DELETE', `/api/v1/users/${account.id}`, ctx.admin);
      const version = (await personRow(person)).version;

      const res = await inject('PATCH', `/api/v1/drivers/${person}`, ctx.admin, {
        lastName: 'Архивоправкина',
        version,
      });
      expect(res.statusCode, res.body).toBe(200);

      expect((await userRow(account.id)).last_name).toBe('Архивоправкин');
    });
  });
});
