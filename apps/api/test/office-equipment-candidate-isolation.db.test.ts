import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIRECTORY_DATA_SHEET,
  type OfficeEquipmentCandidateDto,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentConsumableUsageDto,
  type OfficeEquipmentDto,
  type OfficeEquipmentModelDto,
  type ServiceWarrantyRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as XlsxNs from '../src/lib/xlsx';

/**
 * ИЗОЛЯЦИЯ СООБЩЕНИЯ О ТЕХНИКЕ ОТ ПАРКА (план `docs/office-equipment-candidate-plan.md`, Р1, Р17,
 * §12; этап Э7).
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ. Кандидат живёт в своей таблице (Р1), и вся плата за этот выбор внесена
 * ради одного обещания: до решения человека с `officeEquipment.write` записи в парке НЕТ ВОВСЕ —
 * ни выключенной, ни «черновой», никакой. Обещание это выполняется по построению: ни один
 * сегодняшний запрос справочника таблицу кандидатов не читает. Но по построению — значит не
 * инвариантом базы, а тем, что никто не дописал читателю парка соединение с кандидатами и не завёл
 * ему второй ветви; «верно сегодня» и «верно через полгода» — разные утверждения, и второе
 * доказывает только страж. Он перед вами.
 *
 * ПОЧЕМУ СПИСОК ЧИТАТЕЛЕЙ ИМЕННО ТАКОЙ. Он не собран по вдохновению — это тот же перечень, которым
 * §12 плана мерил цену отвергнутого варианта B («строка парка со статусом проверки»): там изоляцию
 * пришлось бы выполнять ПЕРЕЧИСЛЕНИЕМ дверей, и список назывался поимённо. Двери и есть все
 * способы, которыми запись справочника выходит наружу:
 *
 *   1. список справочника — все его отборы, включая архив и `isActive` во всех трёх значениях
 *      (отсутствие параметра — тоже значение, и именно оно у большинства читателей);
 *   2. карточка по идентификатору: идентификатор кандидата, поданный как идентификатор единицы, —
 *      404, а не чужая строка;
 *   3. селектор «Какой аппарат» в форме заявки: с Ф1 это тот же список с `search` и `isActive`,
 *      и «не нашёл в справочнике» обязано оставаться правдой ПОСЛЕ отправки сообщения — иначе
 *      заявитель выбрал бы собственное непроверенное сообщение как аппарат;
 *   4. счётчики парка у моделей и расходников — «сколько аппаратов надо кормить»;
 *   5. отчёт расхода расходников: у него своя область (её нет) и своё соединение с карточкой;
 *   6. вкладка «Гарантии» и срез «в ремонте, а заявок нет» — два среза парка мимо обычного списка;
 *   7. выгрузка обмена файлом: единственная дверь, ведущая из портала НАРУЖУ, в чужую систему;
 *   8. лента истории карточки и её выгрузка — шесть источников одним потоком;
 *   9. поиск по номерам в заявках;
 *  10. чужая область: тот же кандидат из-под учётки другой площадки и другого отдела.
 *
 * Одиннадцатым разделом проверено уточнение §12 про `file_is_linked`: у кандидата нет ни вложений,
 * ни ссылки на `files`, поэтому страж файлов его не касается и ждать от него сигнала нельзя. Это
 * утверждение о СХЕМЕ, и держать его прозой в плане мало — прочитанное однажды, оно перестанет быть
 * правдой в тот день, когда кандидату припишут фотографию.
 *
 * КОНТРОЛЬ ЖИВОСТИ — ВТОРАЯ ПОЛОВИНА КАЖДОГО УТВЕРЖДЕНИЯ, и без неё файл ничего не стоит. «Ноль
 * совпадений» — самый дешёвый в мире результат: его даёт и сломанный отбор, и пустая база, и
 * опечатка в запросе. Поэтому рядом с каждым нулём стоит настоящая карточка парка, которую тот же
 * читатель тем же запросом ОБЯЗАН найти: список отдаёт её, счётчик считает единицей, выгрузка
 * печатает её номер, поиск заявок доводит до неё. Ноль осмыслен ровно настолько, насколько рядом с
 * ним осмыслена единица.
 *
 * ТА ЖЕ МОДЕЛЬ У КАНДИДАТА И У КАРТОЧКИ — нарочно. Заявленная модель кандидата (Р7 — текстом, а не
 * ссылкой) дословно повторяет наименование модели справочника, на которую ссылается живая карточка.
 * Так проверяется не «разные строки не смешались», а сильное: счётчик модели остаётся единицей,
 * селектор по этому наименованию отдаёт одну строку, а не две, и вторая модель в справочнике от
 * заявленного текста не заводится. Номера при этом у кандидата свои — уникальные приметы прогона,
 * по которым ответ читается насквозь.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Утверждения здесь — «этих строк в ответе нет», и проверяются они на
 * настоящих запросах настоящих ручек: подменённый слой данных отвечал бы тем, что в него положили,
 * то есть проверял бы подмену. Половина читателей вдобавок живёт в SQL, которого в коде не видно
 * целиком, — коррелированные счётчики, соединения выгрузки, шесть источников ленты.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: почти каждое утверждение — про ОТСУТСТВИЕ строк и
 * про точные числа («в справочнике три живые карточки», «счётчик модели равен единице»), и чужой
 * прогон в тех же таблицах сделал бы их ложными. База заводится, мигрируется с нуля и сносится в
 * `afterAll` — устройство взято у соседей `office-equipment-candidate-access.db.test.ts` и
 * `office-equipment-candidate-decisions.db.test.ts`.
 *
 * ФИКСТУРЫ — ПРЯМЫМ SQL, а не ручками заведения. Ручка заведения пары «кандидат + заявка» и ручки
 * склада разбираются своими файлами; повесив на них фикстуры, этот прогон краснел бы от каждой их
 * правки, ничего не сообщая про изоляцию. Прямой вставке вдобавок доступны состояния, которых
 * обычный цикл не производит по одному запросу, — архивная карточка, выведенная из эксплуатации,
 * аппарат «в ремонте» без открытых заявок.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/office-equipment-candidate-isolation.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_candidate_isolation_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-candidate-isolation-password-123';

const CANDIDATES = '/api/v1/office-equipment-candidates';
const EQUIPMENT = '/api/v1/office-equipment';
const MODELS = '/api/v1/office-equipment-models';
const CONSUMABLES = '/api/v1/office-equipment-consumables';
const REQUESTS = '/api/v1/service-requests';
const DIRECTORIES = '/api/v1/directories';

/**
 * Приметы кандидата: значения, которых в ответе читателя парка быть не может ни в каком виде.
 * Ими же идёт сплошная вычитка тела ответа — структурная проверка отвечает за то, что понятно
 * заранее («в списке нет строки с таким номером»), а вычитка — за то, что окажется в ответе
 * завтра: новое поле, новая вложенная сущность, новый лист книги.
 */
const CAND_SERIAL = `SN-CAND-${RUN}`;
const CAND_INVENTORY = `INV-CAND-${RUN}`;
const CAND_LOCATION = `каб. КАНД-${RUN}`;
const CAND_COMMENT = `примета кандидата ${RUN}`;

/** Живая карточка парка — тот самый «контроль живости» рядом с каждым нулём. */
const PARK_SERIAL = `SN-PARK-${RUN}`;
const PARK_INVENTORY = `INV-PARK-${RUN}`;

/** Модель справочника; ЕЮ ЖЕ назвался кандидат в поле заявленной модели (Р7). */
const MODEL_NAME = `Kyocera ECOSYS M3145 ${RUN}`;

/**
 * Период отчёта расхода взят с запасом в обе стороны: файл спрашивает отчёт не про период, а про
 * то, чьи аппараты в нём названы, и сужать окно значило бы завести вторую причину для пустоты.
 */
const REPORT_FROM = '2000-01-01';
const REPORT_TO = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** Справочники оргтехники в обмене файлом — все четыре: раздел выгружают целиком. */
const OFFICE_DIRECTORY_KEYS = [
  'office-equipment-types',
  'office-equipment-models',
  'office-equipment',
  'office-equipment-consumables',
] as const;

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

/**
 * Действующие лица. Их четверо, и каждый отвечает за свою сторону утверждений: оператор читает парк
 * всеми дверьми сразу, автор написал сообщение, двое чужих стоят на двух разных осях области —
 * площадке и подразделении.
 */
type UserTag =
  | 'admin'
  /** Оператор площадки A: читает справочник, ведёт его, проверяет сообщения и выгружает обмен. */
  | 'operator'
  /** Автор сообщения и его заявки: роль площадки A, подразделение D. */
  | 'author'
  /** Проверяющий ЧУЖОЙ ПЛОЩАДКИ B: право у него то же самое, область другая. */
  | 'strangerObject'
  /** Проверяющий ЧУЖОГО ОТДЕЛА Z: вторая ось области, и меряется она снимком отдела автора. */
  | 'strangerDept';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  xlsx: typeof XlsxNs;
  closeDb: () => Promise<void>;
  users: Record<UserTag, TestUser>;
  typeId: string;
  objectA: string;
  modelId: string;
  consumableId: string;
  /** Сообщение о технике: `pending`, с уникальными номерами и заявленной моделью справочника. */
  candidateId: string;
  /** Заявка кандидата и заявка живой карточки: их пара нужна отчёту, ленте и поиску. */
  candidateRequestId: string;
  parkRequestId: string;
  /** Карточки парка: живая с моделью и гарантией, «в ремонте», архивная, выведенная из эксплуатации. */
  cards: { live: string; stranded: string; archived: string; inactive: string };
}

let ctx: Ctx;

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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST', url: string, auth: Auth) {
  return ctx.app.inject({ method, url, headers: auth, remoteAddress: nextAddress() });
}

/** Ответ ручки: разобранное тело и оно же строкой — вторая половина каждой проверки. */
async function get<T>(who: UserTag, url: string): Promise<{ dto: T; body: string }> {
  const res = await inject('GET', url, ctx.users[who].auth);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return { dto: res.json() as T, body: res.body };
}

/**
 * Сплошная вычитка ответа. Приметы ищутся в СЫРОМ теле, а не в разобранных полях, и это не
 * перестраховка: структурная проверка знает только те поля, которые есть сегодня, а утечка
 * приезжает новым — вложенным объектом, второй веткой ответа, лишним листом книги.
 */
function expectNoCandidate(where: string, text: string): void {
  for (const mark of [CAND_SERIAL, CAND_INVENTORY, CAND_LOCATION, CAND_COMMENT, ctx.candidateId]) {
    expect(text.includes(mark), `${where}: в ответе нашлась примета кандидата «${mark}»`).toBe(
      false,
    );
  }
}

interface Page<T> {
  items: T[];
  total: number;
}

/** Справочник техники глазами названного читателя. */
async function park(
  who: UserTag,
  query = '',
): Promise<{ page: Page<OfficeEquipmentDto>; body: string }> {
  const { dto, body } = await get<Page<OfficeEquipmentDto>>(who, `${EQUIPMENT}${query}`);
  return { page: dto, body };
}

/** Номера, которыми карточки опознают: по ним и читается, кто попал в выдачу. */
function numbersOf(items: OfficeEquipmentDto[]): string[] {
  return items.flatMap((item) => [item.serialNumber, item.inventoryNumber]);
}

/** Книга .xlsx одной строкой: листы, строки и ячейки — всё подряд, для сплошной вычитки. */
function bookText(bytes: Buffer): string {
  return ctx.xlsx
    .readWorkbook(bytes)
    .flatMap((sheet) => [sheet.name, ...sheet.rows.flat()])
    .join('\n');
}

/** Лист «Данные» выгрузки справочника: по нему читается, чьи строки в файле. */
function dataSheetText(bytes: Buffer): string {
  const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET);
  expect(sheet, 'в книге выгрузки нет листа «Данные»').toBeDefined();
  return sheet!.rows.flat().join('\n');
}

describe.skipIf(!DB_URL)(
  'изоляция сообщения о технике от парка: десять читателей и ни одного совпадения',
  () => {
    beforeAll(async () => {
      /*
       * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
       * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
       */
      const admin = new pg.Client({ connectionString: ADMIN_DB });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
        await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
      } finally {
        await admin.end();
      }
      const client = new pg.Client({ connectionString: OWN_DB });
      await client.connect();
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query('CREATE EXTENSION IF NOT EXISTS citext');
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await applyMigrations(client);
      } finally {
        await client.end();
      }

      prepareEnv(OWN_DB!);
      const { db, closeDb } = await import('../src/db/client');
      const xlsx = await import('../src/lib/xlsx');
      const { hashPassword } = await import('../src/auth/password');
      const { buildApp } = await import('../src/app');
      const passwordHash = await hashPassword(PASSWORD);

      const object = async (tag: string): Promise<string> => {
        const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`CI-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
        return row.rows[0]!.id;
      };
      const objectA = await object('A');
      const objectB = await object('B');

      const department = async (tag: string): Promise<string> => {
        const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`CI-${tag}-${RUN}`}, ${`Отдел ${tag} ${RUN}`})
        RETURNING id`);
        return row.rows[0]!.id;
      };
      const departmentD = await department('D');
      const departmentZ = await department('Z');

      const typeRow = await db.execute<{ id: string }>(
        sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
      );
      const typeId = typeRow.rows[0]?.id ?? '';
      if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

      async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
        const email = `db-oeci-${tag}-${RUN}@example.invalid`;
        const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Читатель', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
        return { id: res.rows[0]!.id, email };
      }

      const raw = {
        admin: await makeUser('admin', 'admin'),
        operator: await makeUser('operator', 'shtab'),
        author: await makeUser('author', 'shtab'),
        strangerObject: await makeUser('strobj', 'shtab'),
        strangerDept: await makeUser('strdept', 'department'),
      } satisfies Record<UserTag, { id: string; email: string }>;

      await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${raw.operator.id}, ${objectA}), (${raw.author.id}, ${objectA}),
             (${raw.strangerObject.id}, ${objectB})`);
      await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${raw.author.id}, ${departmentD}), (${raw.strangerDept.id}, ${departmentZ})`);

      /**
       * Наборы прогона — СВОИМИ кодами, а не системными: поставочный состав «Ведения» живёт своей
       * жизнью, и подмешивать в него права ради теста нельзя. Набор называет ровно те права, на
       * которых стоят утверждения файла.
       *
       * `archive.read` здесь не украшение: без него ЛЮБОЕ значение отбора архива молча означает «без
       * архива» (`archiveWhere`), и две трети первого раздела проверяли бы отбор, которого не было.
       * `officeEquipment.review` — затем же: без него кандидат не виден вовсе, и «ноль совпадений»
       * стал бы утверждением о пустой базе, а не об изоляции.
       */
      const makeGrant = async (
        code: string,
        permissions: string[],
        roles: string[],
        holderIds: string[],
      ): Promise<void> => {
        const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${`Набор прогона ${code}`}, 'Изоляция кандидата (план Р17)', false,
                ${raw.admin.id})
        RETURNING id`);
        const grantId = row.rows[0]!.id;
        await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission)
        SELECT ${grantId}, permission FROM unnest(${sql.raw(
          `ARRAY[${permissions.map((p) => `'${p}'`).join(',')}]`,
        )}) AS permission`);
        for (const role of roles) {
          await db.execute(sql`
          INSERT INTO grant_roles (grant_id, role)
          VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`);
        }
        for (const holderId of holderIds) {
          await db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id, granted_by)
          VALUES (${holderId}, ${grantId}, ${raw.admin.id})`);
        }
      };

      await makeGrant(
        `oeci-park-${RUN}`,
        [
          'officeEquipment.read',
          'officeEquipment.write',
          'officeEquipment.review',
          'serviceRequests.read',
          'archive.read',
          'directories.export',
        ],
        ['shtab', 'department'],
        [raw.operator.id, raw.strangerObject.id, raw.strangerDept.id],
      );
      // Автору — только чтение заявок: сообщение он видит основанием `own`, а очередь проверки ему
      // закрыта правом. Больше от него в этом файле ничего не требуется.
      await makeGrant(`oeci-author-${RUN}`, ['serviceRequests.read'], ['shtab'], [raw.author.id]);

      // ── Справочники: модель и расходник, которым и меряются счётчики парка ──

      const modelRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_models (equipment_type_id, name)
      VALUES (${typeId}, office_equipment_model_name_normalize(${MODEL_NAME}))
      RETURNING id`);
      const modelId = modelRow.rows[0]!.id;

      const consumableRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_consumables (code, name, quantity, created_by)
      VALUES (office_equipment_consumable_code_key(${`TN-${RUN}`}),
              ${`Тонер прогона ${RUN}`}, 0, ${raw.admin.id})
      RETURNING id`);
      const consumableId = consumableRow.rows[0]!.id;
      await db.execute(sql`
      INSERT INTO office_equipment_consumable_models (consumable_id, model_id)
      VALUES (${consumableId}, ${modelId})`);

      // ── Парк: четыре карточки, по одной на каждый отбор списка ──

      const makeCard = async (opts: {
        tag: string;
        serialNumber: string;
        inventoryNumber: string;
        modelId?: string;
        state?: 'on_site' | 'at_service';
        isActive?: boolean;
        archived?: boolean;
        warranty?: boolean;
      }): Promise<string> => {
        const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (
          equipment_type_id, name, model_id, serial_number, inventory_number, object_id,
          location, state, is_active, warranty_until, deleted_at, deleted_by, created_by)
        VALUES (
          ${typeId}, ${opts.modelId ? MODEL_NAME : `Аппарат ${opts.tag} ${RUN}`},
          ${opts.modelId ?? null}, ${opts.serialNumber}, ${opts.inventoryNumber}, ${objectA},
          ${`каб. ${opts.tag}`},
          ${sql.raw(`'${opts.state ?? 'on_site'}'::office_equipment_state`)},
          ${opts.isActive ?? true},
          ${opts.warranty ? sql`CURRENT_DATE + 30` : null},
          ${opts.archived ? sql`now()` : null}, ${opts.archived ? raw.admin.id : null},
          ${raw.admin.id})
        RETURNING id`);
        return row.rows[0]!.id;
      };

      const cards = {
        // Живая, активная, со ссылкой на модель и действующей гарантией: она отвечает за контроль
        // живости почти во всех разделах.
        live: await makeCard({
          tag: 'LIVE',
          serialNumber: PARK_SERIAL,
          inventoryNumber: PARK_INVENTORY,
          modelId,
          warranty: true,
        }),
        // «В ремонте, а открытых заявок нет» — единственная законная строка среза `strandedAtService`.
        stranded: await makeCard({
          tag: 'STRAND',
          serialNumber: `SN-STRAND-${RUN}`,
          inventoryNumber: `INV-STRAND-${RUN}`,
          state: 'at_service',
        }),
        archived: await makeCard({
          tag: 'ARCH',
          serialNumber: `SN-ARCH-${RUN}`,
          inventoryNumber: `INV-ARCH-${RUN}`,
          archived: true,
        }),
        inactive: await makeCard({
          tag: 'OFF',
          serialNumber: `SN-OFF-${RUN}`,
          inventoryNumber: `INV-OFF-${RUN}`,
          isActive: false,
        }),
      };

      // ── Кандидат и две заявки ──

      const candidateRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_candidates (
        status, equipment_type_id, declared_model, serial_number, inventory_number,
        object_id, location, comment, requester_department_id, created_by,
        idempotency_key, idempotency_fingerprint)
      VALUES (
        'pending', ${typeId}, ${MODEL_NAME}, ${CAND_SERIAL}, ${CAND_INVENTORY},
        ${objectA}, ${CAND_LOCATION}, ${CAND_COMMENT}, ${departmentD}, ${raw.author.id},
        ${randomUUID()}, ${`fingerprint-isolation-${RUN}`})
      RETURNING id`);
      const candidateId = candidateRow.rows[0]!.id;

      const candidateRequest = await db.execute<{ id: string }>(sql`
      INSERT INTO service_requests (
        equipment_candidate_id, equipment_object_id,
        equipment_name, equipment_serial_number, equipment_inventory_number, equipment_location,
        description, responsible_name, created_by)
      VALUES (
        ${candidateId}, ${objectA},
        ${MODEL_NAME}, ${CAND_SERIAL}, ${CAND_INVENTORY}, ${CAND_LOCATION},
        'Не печатает, зажёвывает бумагу', 'Иванов Иван Иванович', ${raw.author.id})
      RETURNING id`);
      const candidateRequestId = candidateRequest.rows[0]!.id;

      const parkRequest = await db.execute<{ id: string }>(sql`
      INSERT INTO service_requests (
        office_equipment_id, equipment_object_id,
        equipment_name, equipment_serial_number, equipment_inventory_number, equipment_location,
        description, responsible_name, created_by)
      VALUES (
        ${cards.live}, ${objectA},
        ${MODEL_NAME}, ${PARK_SERIAL}, ${PARK_INVENTORY}, 'каб. LIVE',
        'Замять бумагу, заменить тонер', 'Петров Пётр Петрович', ${raw.author.id})
      RETURNING id`);
      const parkRequestId = parkRequest.rows[0]!.id;

      /*
       * СКЛАД И ДВЕ ВЫДАЧИ — ОДНОЙ ТРАНЗАКЦИЕЙ, и порядок внутри неё задан базой, а не вкусом:
       * цепочка событий (`office_equipment_consumable_stock_chain`) требует, чтобы «было» равнялось
       * «стало» прошлого события, а «стало» — фактическому остатку карточки, то есть правка карточки
       * идёт ПЕРЕД вставкой события. Отложенные проверки покрытия сходятся уже на коммите: остаток
       * подтверждён последним событием, а факт каждой строки заявки — суммой её движений.
       *
       * Выдач две, и вторая — по заявке КАНДИДАТА: именно она и есть предмет раздела 5. Такая выдача
       * законна (цикл заявки обычный, кроме приёмки, Р16), и отчёт обязан показать её строкой БЕЗ
       * аппарата, а не приписать расход непроверенному сообщению.
       */
      await db.transaction(async (tx) => {
        const parkLine = await tx.execute<{ id: string }>(sql`
        INSERT INTO service_request_consumables (request_id, consumable_id, requested_quantity,
                                                 issued_quantity)
        VALUES (${parkRequestId}, ${consumableId}, 1, 1)
        RETURNING id`);
        const candidateLine = await tx.execute<{ id: string }>(sql`
        INSERT INTO service_request_consumables (request_id, consumable_id, requested_quantity,
                                                 issued_quantity)
        VALUES (${candidateRequestId}, ${consumableId}, 1, 1)
        RETURNING id`);

        await tx.execute(sql`
        UPDATE office_equipment_consumables SET quantity = 10 WHERE id = ${consumableId}`);
        await tx.execute(sql`
        INSERT INTO office_equipment_consumable_stock_entries (
          consumable_id, entry_kind, quantity_before, quantity_after, reason, changed_by)
        VALUES (${consumableId}, 'manual', 0, 10, 'приход прогона', ${raw.admin.id})`);

        await tx.execute(sql`
        UPDATE office_equipment_consumables SET quantity = 9 WHERE id = ${consumableId}`);
        await tx.execute(sql`
        INSERT INTO office_equipment_consumable_stock_entries (
          consumable_id, entry_kind, service_request_id, service_request_consumable_id,
          quantity_before, quantity_after, reason, changed_by)
        VALUES (${consumableId}, 'issue', ${parkRequestId}, ${parkLine.rows[0]!.id},
                10, 9, 'выдача по заявке карточки', ${raw.admin.id})`);

        await tx.execute(sql`
        UPDATE office_equipment_consumables SET quantity = 8 WHERE id = ${consumableId}`);
        await tx.execute(sql`
        INSERT INTO office_equipment_consumable_stock_entries (
          consumable_id, entry_kind, service_request_id, service_request_consumable_id,
          quantity_before, quantity_after, reason, changed_by)
        VALUES (${consumableId}, 'issue', ${candidateRequestId}, ${candidateLine.rows[0]!.id},
                9, 8, 'выдача по заявке кандидата', ${raw.admin.id})`);
      });

      const app = await buildApp();
      await app.ready();

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
      const users = {} as Record<UserTag, TestUser>;
      for (const [tag, user] of Object.entries(raw) as [UserTag, { id: string; email: string }][]) {
        users[tag] = { ...user, auth: await login(user.email) };
      }

      ctx = {
        app,
        db,
        xlsx,
        closeDb,
        users,
        typeId,
        objectA,
        modelId,
        consumableId,
        candidateId,
        candidateRequestId,
        parkRequestId,
        cards,
      };
    }, 180_000);

    afterAll(async () => {
      // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная помешала бы
      // следующему прогону завести её заново.
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

    // ── 0. Контроль: сообщение существует и видно СВОЕЙ дверью ──

    describe('сообщение о технике заведено и читается своей ручкой', () => {
      it('проверяющий видит его карточку и очередь — иначе нули ниже были бы про пустую базу', async () => {
        const { dto } = await get<OfficeEquipmentCandidateDto>(
          'operator',
          `${CANDIDATES}/${ctx.candidateId}`,
        );
        expect(dto.serialNumber).toBe(CAND_SERIAL);
        expect(dto.inventoryNumber).toBe(CAND_INVENTORY);
        // Заявленная модель — та же строка, что и наименование модели справочника: на этом стоят
        // утверждения про счётчики и селектор.
        expect(dto.declaredModel).toBe(MODEL_NAME);

        const queue = await get<Page<OfficeEquipmentCandidateDto>>(
          'operator',
          `${CANDIDATES}?status=pending`,
        );
        expect(queue.dto.items.map((item) => item.id)).toEqual([ctx.candidateId]);
      });
    });

    // ── 1. Список справочника: все отборы ──

    describe('список справочника', () => {
      it('ни один отбор не показывает кандидата — включая архив и три значения «Активна»', async () => {
        const filters: [string, string][] = [
          ['без отборов', ''],
          ['архив вместе с живыми', '?archive=include'],
          ['только архив', '?archive=only'],
          ['только действующие', '?isActive=true'],
          ['только выведенные из эксплуатации', '?isActive=false'],
          ['площадка кандидата', `?objectId=${ctx.objectA}`],
          ['тип кандидата', `?equipmentTypeId=${ctx.typeId}`],
          ['модель, которой назвался кандидат', `?modelId=${ctx.modelId}`],
          ['без владельца', '?unassignedDepartment=true'],
          ['местонахождение «в ремонте»', '?state=at_service'],
          ['гарантия действует', '?warranty=active'],
          ['гарантия истекает', '?warranty=expiring'],
          ['гарантия истекла', '?warranty=expired'],
          ['поиск по серийному номеру кандидата', `?search=${encodeURIComponent(CAND_SERIAL)}`],
          [
            'поиск по инвентарному номеру кандидата',
            `?search=${encodeURIComponent(CAND_INVENTORY)}`,
          ],
          ['поиск по месту кандидата', `?search=${encodeURIComponent(CAND_LOCATION)}`],
          ['поиск по заявленной модели', `?search=${encodeURIComponent(MODEL_NAME)}`],
        ];
        for (const [name, query] of filters) {
          const { page, body } = await park('operator', query);
          expectNoCandidate(`список справочника, ${name}`, body);
          expect(numbersOf(page.items), name).not.toContain(CAND_SERIAL);
          expect(numbersOf(page.items), name).not.toContain(CAND_INVENTORY);
          // Счётчик списка считается отдельным запросом с тем же условием — и он тоже не должен
          // знать о кандидате: разъехавшись со строками, он дал бы «показано 3 из 4».
          expect(page.total, `${name}: счётчик`).toBe(page.items.length);
        }
      });

      it('поиск по номеру ЖИВОЙ карточки её находит — ноль выше не от сломанного отбора', async () => {
        const { page } = await park('operator', `?search=${encodeURIComponent(PARK_SERIAL)}`);
        expect(page.items.map((item) => item.id)).toEqual([ctx.cards.live]);
      });

      it('в области оператора ровно три живые карточки и одна архивная — кандидат не четвёртая', async () => {
        // Числа — про область площадки A, а не про всю базу: справочник оргтехники заполнен сидом
        // (миграция 0143), и вне области оператора живых карточек сотни.
        const live = await park('operator');
        expect(live.page.total).toBe(3);
        const archive = await park('operator', '?archive=only');
        expect(archive.page.items.map((item) => item.id)).toEqual([ctx.cards.archived]);
        const both = await park('operator', '?archive=include');
        expect(both.page.total).toBe(4);
      });
    });

    // ── 2. Карточка по идентификатору-двойнику ──

    describe('карточка справочника', () => {
      it('идентификатор кандидата, поданный как идентификатор единицы, — 404', async () => {
        const res = await inject('GET', `${EQUIPMENT}/${ctx.candidateId}`, ctx.users.operator.auth);
        expect(res.statusCode, res.body).toBe(404);
        // Дословно: по тексту видно, что отказ пришёл от справочника, а не от чужой ручки.
        expect((res.json() as { message: string }).message).toBe('Единица оргтехники не найдена');
      });

      it('карточка живой единицы при этом открывается', async () => {
        const { dto } = await get<OfficeEquipmentDto>('operator', `${EQUIPMENT}/${ctx.cards.live}`);
        expect(dto.serialNumber).toBe(PARK_SERIAL);
      });
    });

    // ── 3. Селектор формы заявки ──

    describe('селектор «Какой аппарат» в форме заявки', () => {
      /**
       * Селектор с Ф1 — это тот же список с `search`, `isActive=true` и своим размером страницы
       * (`officeEquipmentOptionsQuery`). Проверяется он теми же запросами, что шлёт портал: своей
       * ручки у вариантов нет, и заводить её ради теста значило бы проверять не то, чем пользуются.
       */
      const options = (search: string) =>
        `${EQUIPMENT}?page=1&pageSize=50&isActive=true&sortBy=name&sortOrder=asc&search=${encodeURIComponent(search)}`;

      it('по номерам кандидата не предлагает ничего — «не нашёл» осталось правдой после отправки', async () => {
        for (const search of [CAND_SERIAL, CAND_INVENTORY, CAND_LOCATION]) {
          const { dto, body } = await get<Page<OfficeEquipmentDto>>('author', options(search));
          expect(dto.items, search).toEqual([]);
          expectNoCandidate(`селектор, поиск «${search}»`, body);
        }
      });

      it('по заявленной модели предлагает одну карточку парка, а не две', async () => {
        // Кандидат назвался ТОЙ ЖЕ моделью, что и живая карточка: не отдай сервер ровно одну строку —
        // заявитель выбрал бы аппаратом собственное непроверенное сообщение.
        const { dto } = await get<Page<OfficeEquipmentDto>>('author', options(MODEL_NAME));
        expect(dto.items.map((item) => item.id)).toEqual([ctx.cards.live]);
      });
    });

    // ── 4. Счётчики парка у моделей и расходников ──

    describe('счётчики парка', () => {
      it('модель считает одну карточку, хотя кандидат назвался ею же', async () => {
        // Поиском по наименованию, а не всем перечнем: справочник моделей общий на компанию и
        // заполнен сидом (миграция 0143), а утверждение здесь — про ОДНУ модель прогона.
        const { dto, body } = await get<Page<OfficeEquipmentModelDto>>(
          'operator',
          `${MODELS}?pageSize=100&search=${encodeURIComponent(MODEL_NAME)}`,
        );
        expectNoCandidate('перечень моделей', body);
        // Второй модели от заявленного текста не завелось: заявленное остаётся текстом (Р7).
        const mine = dto.items.filter((item) => item.name === MODEL_NAME);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.equipmentCount).toBe(1);
      });

      it('расходник считает те же аппараты — «сколько кормить» кандидата не касается', async () => {
        const { dto, body } = await get<Page<OfficeEquipmentConsumableDto>>(
          'operator',
          `${CONSUMABLES}?pageSize=100&search=${encodeURIComponent(`TN-${RUN}`)}`,
        );
        expectNoCandidate('перечень расходников', body);
        const consumable = dto.items.find((item) => item.id === ctx.consumableId);
        expect(consumable?.equipmentCount).toBe(1);
      });
    });

    // ── 5. Отчёт расхода расходников ──

    describe('отчёт расхода расходников', () => {
      const url = `${CONSUMABLES}/usage-report?from=${REPORT_FROM}&to=${REPORT_TO}`;

      it('выдача по заявке кандидата показана строкой БЕЗ аппарата, а не приписана кандидату', async () => {
        const { dto, body } = await get<OfficeEquipmentConsumableUsageDto>('operator', url);
        expectNoCandidate('отчёт расхода', body);

        const byRequest = new Map(dto.rows.map((row) => [row.requestId, row]));
        const parkRow = byRequest.get(ctx.parkRequestId);
        const candidateRow = byRequest.get(ctx.candidateRequestId);
        // Контроль живости: расход по заявке живой карточки назван аппаратом полностью.
        expect(parkRow?.equipmentId).toBe(ctx.cards.live);
        expect(parkRow?.equipmentSerialNumber).toBe(PARK_SERIAL);
        // А по заявке кандидата — четыре поля аппарата пусты ВМЕСТЕ: это «аппарата нет», а не
        // четыре независимых прочерка (контракт строки отчёта).
        expect(candidateRow, 'выдача по заявке кандидата в отчёт не попала вовсе').toBeDefined();
        expect(candidateRow?.equipmentId).toBeNull();
        expect(candidateRow?.equipmentName).toBeNull();
        expect(candidateRow?.equipmentSerialNumber).toBeNull();
        expect(candidateRow?.equipmentInventoryNumber).toBeNull();
        // Итог считается по голому журналу и обязан сойтись со строками — обе выдачи в нём.
        expect(dto.totalIssued).toBe(2);
      });

      it('тот же отчёт файлом кандидата тоже не называет', async () => {
        const res = await inject(
          'GET',
          `${CONSUMABLES}/usage-report.xlsx?from=${REPORT_FROM}&to=${REPORT_TO}`,
          ctx.users.operator.auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        const text = bookText(res.rawPayload);
        expectNoCandidate('отчёт расхода файлом', text);
        // Контроль живости: строка живой карточки в книге есть. Аппарат в ней подписан инвентарным
        // номером, а не серийным, — так его называет общий `officeEquipmentTitle`.
        expect(text).toContain(PARK_INVENTORY);
      });
    });

    // ── 6. Гарантии и «в ремонте, а заявок нет» ──

    describe('срезы парка мимо списка', () => {
      it('реестр гарантий по номерам кандидата пуст, а по номеру карточки — нет', async () => {
        for (const search of [CAND_SERIAL, CAND_INVENTORY]) {
          const { dto, body } = await get<{ items: ServiceWarrantyRowDto[] }>(
            'operator',
            `/api/v1/service-requests/warranties?search=${encodeURIComponent(search)}`,
          );
          expect(dto.items, search).toEqual([]);
          expectNoCandidate(`реестр гарантий, поиск «${search}»`, body);
        }

        const { dto } = await get<{ items: ServiceWarrantyRowDto[] }>(
          'operator',
          `/api/v1/service-requests/warranties?search=${encodeURIComponent(PARK_SERIAL)}`,
        );
        expect(dto.items.map((row) => row.equipmentId)).toEqual([ctx.cards.live]);
      });

      it('срез «в ремонте, а заявок нет» отдаёт одну карточку — ту, что действительно в ремонте', async () => {
        const { page, body } = await park('operator', '?strandedAtService=true');
        expect(page.items.map((item) => item.id)).toEqual([ctx.cards.stranded]);
        expectNoCandidate('срез «в ремонте, а заявок нет»', body);
      });
    });

    // ── 7. Выгрузка обмена файлом ──

    describe('обмен справочниками файлом', () => {
      it('ни один из четырёх файлов офисного раздела кандидата не выносит', async () => {
        for (const key of OFFICE_DIRECTORY_KEYS) {
          const res = await inject('GET', `${DIRECTORIES}/${key}/export`, ctx.users.operator.auth);
          expect(res.statusCode, `${key}: ${res.body}`).toBe(200);
          // Вычитывается вся книга целиком, включая лист «Справка»: файл уходит наружу, в чужую
          // систему, и «нашлось в примечании» — та же утечка, что «нашлось в строке».
          expectNoCandidate(`выгрузка «${key}»`, bookText(res.rawPayload));
        }
      });

      it('в файле оргтехники при этом стоят номера живых карточек', async () => {
        const res = await inject(
          'GET',
          `${DIRECTORIES}/office-equipment/export`,
          ctx.users.operator.auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        const data = dataSheetText(res.rawPayload);
        expect(data).toContain(PARK_SERIAL);
        expect(data).toContain(`SN-STRAND-${RUN}`);
        // Архивная карточка в файл не идёт (выгрузка отбирает живые), а кандидат — тем более.
        expect(data).not.toContain(`SN-ARCH-${RUN}`);
      });

      it('счётчик вкладки обмена считает парк, а не парк вместе с сообщениями', async () => {
        /*
         * Числа берутся из базы, а не пишутся в тесте: справочник оргтехники заполнен сидом
         * (миграция 0143), и «три карточки» здесь было бы утверждением о прогоне, а не о счётчике.
         * Проверяется ровно то, что должно: счётчик обмена равен числу ЖИВЫХ строк парка — при том,
         * что ожидающих сообщений в базе не ноль, и сложи их счётчик вместе, число разошлось бы.
         */
        const live = await ctx.db.execute<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM office_equipment WHERE deleted_at IS NULL`,
        );
        const models = await ctx.db.execute<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM office_equipment_models`,
        );
        const pending = await ctx.db.execute<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM office_equipment_candidates WHERE status = 'pending'`,
        );
        expect(pending.rows[0]!.c).toBeGreaterThan(0);

        const { dto } = await get<{ items: { key: string; count: number }[] }>(
          'operator',
          DIRECTORIES,
        );
        const counts = new Map(dto.items.map((item) => [item.key, item.count]));
        expect(counts.get('office-equipment')).toBe(live.rows[0]!.c);
        expect(counts.get('office-equipment-models')).toBe(models.rows[0]!.c);
      });
    });

    // ── 8. Лента истории карточки и её выгрузка ──

    describe('история единицы', () => {
      it('лента живой карточки кандидата не поминает', async () => {
        const { dto, body } = await get<{ items: unknown[] }>(
          'operator',
          `${EQUIPMENT}/${ctx.cards.live}/history`,
        );
        expectNoCandidate('лента истории карточки', body);
        // Контроль живости: своя заявка в ленте есть — источники читаются, а не молчат.
        expect(dto.items.length).toBeGreaterThan(0);
      });

      it('выгрузка ленты — тоже', async () => {
        const res = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.cards.live}/history.xlsx`,
          ctx.users.operator.auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        expectNoCandidate('выгрузка ленты истории', bookText(res.rawPayload));
      });

      it('истории у кандидата нет вовсе: обе ручки отвечают 404 на его идентификатор', async () => {
        const feed = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.candidateId}/history`,
          ctx.users.operator.auth,
        );
        expect(feed.statusCode, feed.body).toBe(404);
        const file = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.candidateId}/history.xlsx`,
          ctx.users.operator.auth,
        );
        expect(file.statusCode, file.body).toBe(404);
      });
    });

    // ── 9. Поиск по номерам в заявках ──

    describe('поиск по номерам в списке заявок', () => {
      /**
       * ЗДЕСЬ ОЖИДАЕТСЯ НЕ НОЛЬ, И ЭТО ЧАСТЬ УТВЕРЖДЕНИЯ. Номера кандидата лежат в СНИМКЕ заявки
       * (`equipment_serial_number` и соседи) — так и задумано: заявка описывает предмет словами
       * заявителя, и найти её по названному номеру человек обязан. Изоляция говорит о другом: за
       * этими номерами не стоит карточки парка. Поэтому проверяется пара — найденная заявка та самая,
       * а блок аппарата у неё пуст, — и рядом контроль: у заявки по живой карточке тот же блок
       * заполнен. Ожидай файл ноль строк, он проверял бы поломку поиска, а не отсутствие карточки.
       */
      it('находит заявку кандидата, но аппарата у неё нет', async () => {
        const { dto } = await get<Page<{ id: string; equipment: { id: string } | null }>>(
          'operator',
          `${REQUESTS}?search=${encodeURIComponent(CAND_SERIAL)}`,
        );
        expect(dto.items.map((item) => item.id)).toEqual([ctx.candidateRequestId]);
        expect(dto.items[0]!.equipment).toBeNull();
      });

      it('а по номеру живой карточки — заявку с заполненным аппаратом', async () => {
        const { dto } = await get<Page<{ id: string; equipment: { id: string } | null }>>(
          'operator',
          `${REQUESTS}?search=${encodeURIComponent(PARK_SERIAL)}`,
        );
        expect(dto.items.map((item) => item.id)).toEqual([ctx.parkRequestId]);
        expect(dto.items[0]!.equipment?.id).toBe(ctx.cards.live);
      });
    });

    // ── 10. Чужая область ──

    describe('чужая область', () => {
      it('проверяющий другой площадки и проверяющий другого отдела получают 404 на карточку', async () => {
        for (const who of ['strangerObject', 'strangerDept'] as const) {
          const res = await inject('GET', `${CANDIDATES}/${ctx.candidateId}`, ctx.users[who].auth);
          // 404, а не 403: право на ручку у обоих есть, не существует для них именно этой строки —
          // 403 сам по себе сообщал бы, что сообщение есть.
          expect(res.statusCode, `${who}: ${res.body}`).toBe(404);
        }
      });

      it('и ноль строк в очереди — при том, что своя очередь у них открывается', async () => {
        for (const who of ['strangerObject', 'strangerDept'] as const) {
          const { dto, body } = await get<Page<OfficeEquipmentCandidateDto>>(who, CANDIDATES);
          expect(dto.items, who).toEqual([]);
          expect(dto.total, who).toBe(0);
          expectNoCandidate(`очередь чужой области (${who})`, body);
        }
      });

      it('и в их справочнике кандидата тоже нет', async () => {
        for (const who of ['strangerObject', 'strangerDept'] as const) {
          const { body } = await park(who, '?archive=include');
          expectNoCandidate(`справочник чужой области (${who})`, body);
        }
      });
    });

    // ── 11. Файлы: страж `file_is_linked` кандидата не касается ──

    describe('вложений у кандидата нет', () => {
      /**
       * Уточнение §12 плана: `file-linkage.db.test.ts` перебирает таблицы, у которых есть ссылка на
       * `files`, и кандидата не видит вовсе — фото приезжает вложением ЗАЯВКИ (граница §1). Ждать от
       * того стража сигнала нельзя, и молчание — не доказательство: доказывает его схема, и проверить
       * её надо здесь. Цена ошибки известна поимённо: модуль, о котором `file_is_linked` не знает,
       * отдаёт свои вложения загрузившему их человеку бессрочно, а уборка считает подшитый документ
       * сиротой (миграции 0225 и 0238).
       */
      it('ни одной ссылки на файлы у таблицы кандидата — поэтому её нет и в `file_is_linked`', async () => {
        const fks = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c
          FROM pg_constraint
         WHERE conrelid = 'office_equipment_candidates'::regclass
           AND contype = 'f'
           AND confrelid = 'files'::regclass`);
        expect(fks.rows[0]!.c).toBe(0);

        const columns = await ctx.db.execute<{ column_name: string }>(sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'office_equipment_candidates'
           AND column_name LIKE '%file%'`);
        expect(columns.rows.map((row) => row.column_name)).toEqual([]);

        const fn = await ctx.db.execute<{ def: string }>(sql`
        SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname = 'file_is_linked'`);
        expect(fn.rows).toHaveLength(1);
        expect(fn.rows[0]!.def).not.toContain('candidate');
      });
    });
  },
);
