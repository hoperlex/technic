import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExternalRegistrationEmail, registrationRequestDetail } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Путь водителя от заявки на регистрацию до привязанной карточки (ADR 0102, план §8 — Р29–Р31) —
 * на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Здесь нет ни одного места, где предмет проверки жил бы в одной функции. Заявка
 * проходит через схему разбора, `normalizeRegistrationRequest` и вставку — и «объекта у водителя
 * не спрашивают» видно только в том, что доехало до колонки. Активация упирается сразу в три
 * рубежа (форма, `resolvePersonBinding`, CHECK `users_driver_person_check`), и проверять её мимо
 * базы значило бы проверять первый из трёх. Подсказка кандидатов — вообще целиком SQL: порядок
 * задают три булевых выражения в `ORDER BY`, а похожесть ФИО считает оператор `%` из pg_trgm,
 * которого вне Postgres не существует. Дозаполнение (Р31) правит **вторую** таблицу той же
 * транзакцией, и вопрос «что осталось в карточке» без базы не задать вовсе.
 *
 * Соседний файл `driver-account.db.test.ts` держит ту же связь со стороны учётки — условие БД,
 * увольнение, перепривязку. Здесь — только вход человека в портал: заявка, её рассмотрение и то,
 * что при этом происходит с карточкой справочника.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/driver-registration.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. Своё — и у меток,
 * и у адресов: файл живёт в общем дереве, и второй его экземпляр рядом (полный `vitest run`
 * разработчика) с общей меткой унёс бы карточки из-под живого теста.
 */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const EMAIL_PREFIX = 'db-drvreg-';
const EMAIL_LIKE = `${EMAIL_PREFIX}%-${RUN}@example.invalid`;
/** Метка карточек: уборка идёт по ней, а не «по последним строкам». */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: регистрация водителя';
const MARK = `${MARK_PREFIX} ${RUN}`;

function emailOf(tag: string): string {
  return `${EMAIL_PREFIX}${tag}-${RUN}@example.invalid`;
}

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  issueCaptcha: (issuedAt?: number) => { token: string; code: string };
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

/** Свой адрес на каждый запрос: регистрация ограничена пятью попытками за десять минут с IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Номера свои у каждой стороны: перенос проверяется сверкой значений, и один номер на всех сделал
 * бы «приехал из заявки» неотличимым от «так и было». */
let phoneNo = 0;
function nextPhone(): string {
  phoneNo += 1;
  return `99955${String(phoneNo).padStart(5, '0')}`;
}

/**
 * Уборка. Порядок обратный ссылкам: журнал держит учётки внешним ключом, а живая учётка водителя
 * держит карточку условием `users_driver_person_check` — удали карточку раньше, и `SET NULL`
 * упёрся бы в него.
 *
 * `olderThan` включается перед прогоном: убирать надо хвосты упавших прогонов — учётка водителя
 * переживает падение живой и держит карточку намертво, — но только заведомо мёртвые. Прогон,
 * идущий рядом прямо сейчас, — это живой тест, и унести его данные значит уронить его в случайном
 * месте сообщением, по которому причину не найти.
 */
async function cleanup(db: typeof AppDb, olderThan?: string): Promise<void> {
  const age = olderThan ? sql` AND created_at < now() - ${olderThan}::interval` : sql``;
  const emails = olderThan ? `${EMAIL_PREFIX}%@example.invalid` : EMAIL_LIKE;
  const marks = olderThan ? `${MARK_PREFIX}%` : MARK;
  const ours = sql`SELECT id FROM users WHERE email LIKE ${emails}${age}`;
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ours})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emails}${age}`);
  await db.execute(sql`DELETE FROM persons WHERE comment LIKE ${marks}${age}`);
}

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

interface RegistrationSeed {
  tag: string;
  lastName?: string;
  firstName?: string;
  middleName?: string;
  phone?: string;
  requestedRole?: string;
  requestedObject?: string;
  requestedCompany?: string;
}

interface AccountRow {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  role: string | null;
  is_active: boolean;
  person_id: string | null;
  requested_role: string | null;
  requested_object: string;
  requested_company: string;
}

async function accountRow(id: string): Promise<AccountRow> {
  const res = await ctx.db.execute<AccountRow>(sql`
    SELECT id, email::text AS email, full_name, phone, role::text AS role, is_active, person_id,
           requested_role::text AS requested_role, requested_object, requested_company
      FROM users WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Саморегистрация с настоящей капчей: момент выдачи сдвинут в прошлое, чтобы не ждать. */
async function register(seed: RegistrationSeed): Promise<{ statusCode: number; body: string }> {
  const captcha = ctx.issueCaptcha(Date.now() - 5_000);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: nextAddress(),
    payload: {
      email: emailOf(seed.tag),
      lastName: seed.lastName ?? 'Заявкин',
      firstName: seed.firstName ?? 'Пётр',
      middleName: seed.middleName ?? 'Сергеевич',
      phone: seed.phone ?? '',
      password: PASSWORD,
      requestedRole: seed.requestedRole ?? 'driver',
      requestedObject: seed.requestedObject ?? '',
      requestedCompany: seed.requestedCompany ?? '',
      captchaToken: captcha.token,
      captchaAnswer: captcha.code,
    },
  });
  return { statusCode: res.statusCode, body: res.body };
}

/** Поданная и нерассмотренная заявка: роли нет, учётка неактивна. */
async function pending(seed: RegistrationSeed): Promise<AccountRow> {
  const res = await register(seed);
  expect(res.statusCode, res.body).toBe(201);
  const row = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${emailOf(seed.tag)} AND deleted_at IS NULL`,
  );
  return accountRow(row.rows[0]!.id);
}

interface PersonSeed {
  lastName?: string;
  firstName?: string;
  middleName?: string;
  phone?: string;
  email?: string;
}

/**
 * Карточка работника — прямой вставкой: предмет файла начинается с привязки, а не с заведения
 * водителя, и лишний путь через справочник добавил бы к тесту его правила (СНИЛС, права, приказы).
 */
async function createPerson(seed: PersonSeed = {}): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO persons (last_name, first_name, middle_name, phone, email, comment)
    VALUES (${seed.lastName ?? 'Заявкин'}, ${seed.firstName ?? 'Пётр'},
            ${seed.middleName ?? 'Сергеевич'}, ${seed.phone ?? ''}, ${seed.email ?? ''}, ${MARK})
    RETURNING id`);
  return res.rows[0]!.id;
}

interface PersonRow {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  version: number;
}

async function personRow(id: string): Promise<PersonRow> {
  const res = await ctx.db.execute<PersonRow>(sql`
    SELECT id, full_name, phone, email::text AS email, version FROM persons WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Рассмотрение заявки — тем же телом, каким его шлёт форма активации. */
function approve(id: string, body: Record<string, unknown>) {
  return inject('PATCH', `/api/v1/users/${id}`, ctx.admin, {
    role: 'driver',
    isActive: true,
    approveRegistration: true,
    notifyUser: false,
    ...body,
  });
}

interface Candidate {
  id: string;
  fullName: string;
  matchedBy: string[];
}

async function candidates(userId: string): Promise<Candidate[]> {
  const res = await inject('GET', `/api/v1/users/person-candidates?userId=${userId}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as Candidate[];
}

/** Событие журнала по учётке: решение о привязке принимает человек, и оно обязано быть названо. */
async function auditOf(entityId: string, action: string): Promise<Record<string, unknown>[]> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_id = ${entityId} AND action = ${action}
     ORDER BY created_at`);
  return res.rows.map((row) => row.metadata);
}

async function login(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().accessToken as string;
}

describe.skipIf(!DB_URL)('водитель: заявка на регистрацию и её рассмотрение', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { issueCaptcha } = await import('../src/auth/captcha');
    const { buildApp } = await import('../src/app');
    await cleanup(db, '1 hour');

    // Администратор заводится SQL: форма учётки — предмет самого файла, и заводить ею же ту
    // учётку, которой всё делается, значило бы проверять её собой.
    await db.execute(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${emailOf('admin')}, 'Тестовый', 'Администратор', '', ${await hashPassword(PASSWORD)},
              'admin'::role, true, now())`);

    ctx = {
      app: await buildApp(),
      db,
      closeDb,
      admin: { authorization: '' },
      issueCaptcha,
    };
    ctx.admin = { authorization: `Bearer ${await login(emailOf('admin'))}` };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await cleanup(ctx.db);
    await ctx.closeDb();
  });

  /**
   * Пожелание «Водитель» (Р29). Отдельной кнопки «я водитель» на экране входа нет — появилось
   * восьмое значение в общем списке, и вся правка портала в этой части сводится к четырём
   * таблицам пожелания.
   */
  describe('заявка с пожеланием «Водитель»', () => {
    it('подаётся без объекта и компании: уточнений у водителя не спрашивают вовсе', async () => {
      // Водитель работает от парка, а не от объекта или контрагента (ADR 0102): спрашивать у него
      // площадку не за что, и присланное уточнение до базы не доходит вовсе.
      expect(registrationRequestDetail.driver).toBe('none');

      const account = await pending({
        tag: 'plain',
        requestedObject: 'СМР-1',
        requestedCompany: 'ООО «Рога и копыта»',
      });
      expect(account).toMatchObject({
        requested_role: 'driver',
        requested_object: '',
        requested_company: '',
        // Пожелание не назначает роль (ADR 0034): до рассмотрения заявка не даёт ничего.
        role: null,
        is_active: false,
        person_id: null,
      });
    });

    it('личный адрес водителя внешним не считается', async () => {
      // Почта у водителя личная по определению, и предупреждение «адрес не корпоративный»
      // требовало бы от него невозможного. У «другого» с того же ящика оно, наоборот, уместно:
      // так себя называет чаще свой сотрудник.
      const email = 'ivan.petrov@example.invalid';
      expect(isExternalRegistrationEmail({ email, requestedRole: 'driver' })).toBe(false);
      expect(isExternalRegistrationEmail({ email, requestedRole: 'other' })).toBe(true);
    });
  });

  /**
   * Активация (Р30). Обязательность работника стоит на трёх рубежах сразу, и здесь проверяется
   * средний — тот, что отвечает администратору внятным сообщением, а не отказом драйвера.
   */
  describe('рассмотрение заявки', () => {
    it('роль «Водитель» без выбранного работника не активируется, с работником — активируется', async () => {
      const account = await pending({ tag: 'activate' });

      const refused = await approve(account.id, {});
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.body).toContain('обязателен работник справочника');
      // Отказ ничего не изменил: заявка осталась заявкой и вернётся в очередь целой.
      expect(await accountRow(account.id)).toMatchObject({ role: null, is_active: false });

      const personId = await createPerson();
      const approved = await approve(account.id, { personId });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await accountRow(account.id)).toMatchObject({
        role: 'driver',
        is_active: true,
        person_id: personId,
      });
      // Привязка названа в журнале рассмотрения: без неё «кому отдали задания Иванова» осталось
      // бы вопросом без ответа.
      expect(await auditOf(account.id, 'user.approve_registration')).toEqual([
        expect.objectContaining({ role: 'driver', personId }),
      ]);
    });

    it('подсказка кандидатов: точный телефон и адрес выше похожего ФИО, занятый не предлагается', async () => {
      const phone = nextPhone();
      const account = await pending({ tag: 'candidates', phone });
      // Приметы берутся из самой заявки, поэтому сверяются с тем, что до базы доехало: телефон
      // разбирается схемой, и сравнение идёт с сохранённым значением, а не с набранным в форме.
      expect(account.phone).not.toBe('');

      const byPhone = await createPerson({
        lastName: 'Телефонов',
        firstName: 'Кузьма',
        middleName: 'Ильич',
        phone: account.phone,
      });
      const byEmail = await createPerson({
        lastName: 'Почтов',
        firstName: 'Игнат',
        middleName: 'Львович',
        email: account.email,
      });
      // Тёзка заявителя: ни телефона, ни адреса — совпадает только ФИО, и это самая слабая примета.
      const byName = await createPerson({ lastName: 'Заявкин', firstName: 'Пётр' });
      // Занятый: приметой совпадает сильнее всех, но живая учётка на него уже есть, и выбрать его
      // всё равно нельзя — предлагать его значило бы вести администратора в отказ.
      const taken = await createPerson({
        lastName: 'Занятов',
        firstName: 'Афанасий',
        middleName: 'Петрович',
        phone: account.phone,
      });
      const takenAccount = await inject('POST', '/api/v1/users', ctx.admin, {
        email: emailOf('taken'),
        lastName: 'Занятов',
        firstName: 'Афанасий',
        middleName: 'Петрович',
        phone: '',
        role: 'driver',
        password: PASSWORD,
        isActive: true,
        notifyUser: false,
        personId: taken,
      });
      expect(takenAccount.statusCode, takenAccount.body).toBe(201);

      const items = await candidates(account.id);
      expect(items.map((i) => i.id)).not.toContain(taken);
      // Порядок сверяется по своим карточкам: справочник общий, и чужой однофамилец в подсказке
      // законен — вопрос теста в том, что стоит выше чего.
      const mine = items.filter((i) => [byPhone, byEmail, byName].includes(i.id));
      expect(mine.map((i) => i.id)).toEqual([byPhone, byEmail, byName]);
      // Пометка говорит, чем совпало: администратор выбирает человека по ней, а не по порядку.
      expect(mine.map((i) => i.matchedBy)).toEqual([['phone'], ['email'], ['name']]);
    });
  });

  /**
   * Дозаполнение при привязке (Р31): пусто с одной стороны — переносим молча, отметив в журнале;
   * заполнено с обеих и различается — не трогаем ничего.
   */
  describe('привязка сводит заявку и карточку', () => {
    it('пустой телефон карточки заполняется из заявки', async () => {
      const phone = nextPhone();
      const account = await pending({ tag: 'fill-phone', phone });
      const personId = await createPerson();

      const res = await approve(account.id, { personId });
      expect(res.statusCode, res.body).toBe(200);

      const person = await personRow(personId);
      // Перенос известного факта, а не выбор из двух: в карточке номера не было вовсе.
      expect(person.phone).toBe(account.phone);
      // Адрес переносится только в эту сторону: на `persons.email` шлёт письма рассылка «Задание
      // водителю», а адрес учётки — это логин, и менять его привязкой нельзя.
      expect(person.email).toBe(account.email);
      // Версия карточки выросла: правку сделали мы, и открытая рядом карточка водителя должна
      // упереться в конфликт, а не сохраниться поверх перенесённого.
      expect(person.version).toBe(1);
      expect(await auditOf(account.id, 'user.approve_registration')).toEqual([
        expect.objectContaining({ filledFields: { phone: 'person', email: 'person' } }),
      ]);
    });

    it('расходящийся телефон не трогается ни с одной стороны', async () => {
      const accountPhone = nextPhone();
      const personPhone = nextPhone();
      const account = await pending({ tag: 'keep-phone', phone: accountPhone });
      const personId = await createPerson({ phone: personPhone });

      const res = await approve(account.id, { personId });
      expect(res.statusCode, res.body).toBe(200);

      // Различие показывает форма, а портал не выбирает молча, чьё значение правдивее: у номера
      // учётки и номера карточки разные владельцы и разные поводы смениться (ADR 0043).
      expect((await personRow(personId)).phone).toBe(personPhone);
      expect((await accountRow(account.id)).phone).toBe(accountPhone);
      expect(await auditOf(account.id, 'user.approve_registration')).toEqual([
        expect.objectContaining({ filledFields: { email: 'person' } }),
      ]);
    });

    it('расхождение ФИО без подтверждения отклоняется, с подтверждением проходит и уходит в аудит', async () => {
      const account = await pending({ tag: 'mismatch' });
      const personId = await createPerson({ lastName: 'Однофамильцев', firstName: 'Пётр' });

      const refused = await approve(account.id, { personId });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.body).toContain('подтвердите, что это один человек');
      // Молчаливая привязка отдала бы заявителю чужие задания вместе с телефонами заказчиков,
      // поэтому отказ обязан быть полным: заявка осталась нерассмотренной.
      expect(await accountRow(account.id)).toMatchObject({
        role: null,
        is_active: false,
        person_id: null,
      });

      const approved = await approve(account.id, { personId, confirmNameMismatch: true });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await accountRow(account.id)).toMatchObject({ person_id: personId });
      // Решение принял человек, и оно должно быть названо: разбор «почему у этой учётки чужая
      // фамилия» упирается ровно в эту запись.
      expect(await auditOf(account.id, 'user.approve_registration')).toEqual([
        expect.objectContaining({ personId, nameMismatchConfirmed: true }),
      ]);
      // Смена фамилии — дело обычное: после подтверждения владельцем ФИО становится справочник
      // (Р31), и учётка не переписывает его обратно.
      expect((await personRow(personId)).full_name).toBe('Однофамильцев Пётр Сергеевич');
    });
  });
});
