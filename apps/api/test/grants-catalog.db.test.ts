import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_GRANT_CODES,
  ADMIN_GRANTS,
  MODULE_GRANT_CODES,
  MODULE_GRANTS,
  ALL_SYSTEM_GRANT_CODES,
  isPermission,
  ROLE_ADDON_BASE_ROLES,
  ROLE_ADDON_PERMISSIONS,
  SYSTEM_GRANT_CODES,
  type Permission,
  type Role,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Каталог системных полномочий в базе против каталога в контрактах (ADR 0106, шаг 1a) — страж
 * двойной записи.
 *
 * **Что здесь охраняется.** Состав системных наборов существует в двух копиях: в контрактах и в
 * миграциях каталога, которые переписывают его руками строками `INSERT`. Наборов сегодня шесть, и
 * приехали они двумя поставками — два перенесены из надстроек (`ROLE_ADDON_PERMISSIONS`,
 * `ROLE_ADDON_BASE_ROLES`, миграция `0145_permission_grants.sql`), четыре административных заведены
 * этапом 4 (`ADMIN_GRANTS`, миграция `0150_admin_grants_catalog.sql`). Сегодня копии совпадают, но
 * проверяет это только человек. Сверка `backfill-grants` (`backfill-grants.db.test.ts`) здесь не
 * помогает вовсе: она сравнивает **назначения** — кому набор выдан, — и на состав набора не
 * смотрит.
 *
 * **Чем это кончается.** До шага 1c права держателя считает матрица, и расхождение спит. После —
 * источником прав становится база, и правка матрицы без правки каталога перестаёт что-либо менять:
 * право, добавленное оператору оргтехники в `ROLE_ADDON_PERMISSIONS`, у живой учётки не появится, а
 * убранное — не пропадёт. Ни один тест матрицы этого не увидит: они все читают контракты. Отсюда
 * файл — он единственный смотрит на строки в базе.
 *
 * **Зачем база, а не подмена.** Предмет теста и есть база: проверяется результат `INSERT`'ов
 * миграции, то есть строки, которых на моках не существует. Читает файл поэтому голым `pg.Client`,
 * без конфига приложения и без drizzle: смотреть три таблицы на равенство спискам — вся его работа.
 *
 * **Параллельный прогон.** Утверждений обо всей базе здесь нет ни одного: соседние db-тесты заводят
 * свои учётки и назначения, но системные наборы правит только миграция. Фильтр везде — по кодам из
 * `ALL_SYSTEM_GRANT_CODES` плюс отдельная проверка, что других системных наборов (`is_system =
 * true`) в базе не завелось; пользовательские наборы будущего конструктора под неё не попадают.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/grants-catalog.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

let client: pg.Client;

/**
 * Объявленный каталог одним перечнем: код → состав и роли.
 *
 * Собран из двух источников, а не переписан третьим списком. Перенесённые из надстроек наборы
 * объявлены `ROLE_ADDON_*` — там состав обязан совпадать с надстройкой один в один, и своей копии у
 * него нет по построению; административные объявлены `ADMIN_GRANTS`, потому что никакой надстройки
 * за ними не стоит. Сверять их одним проходом можно и нужно: страж отвечает на вопрос «равна ли
 * база коду», а не «откуда набор приехал».
 */
const DECLARED: ReadonlyMap<
  string,
  {
    readonly name?: string;
    readonly permissions: readonly Permission[];
    readonly roles: readonly Role[];
  }
> = new Map([
  ...SYSTEM_GRANT_CODES.map(
    (code) =>
      [
        code as string,
        { permissions: ROLE_ADDON_PERMISSIONS[code], roles: ROLE_ADDON_BASE_ROLES[code] },
      ] as const,
  ),
  ...ADMIN_GRANT_CODES.map((code) => [code as string, ADMIN_GRANTS[code]] as const),
  /*
   * Модульная часть (волна В5 плана переработки заявок) объявлена `MODULE_GRANTS` — как
   * административная, и по той же причине: надстройки за ней не стоит. Без этой строки набор
   * попадал бы в перебор `ALL_SYSTEM_GRANT_CODES` (существует, помечен системным), но его состав
   * не сверялся бы ни с чем — то есть страж молчал бы о расхождении, ради которого заведён.
   */
  ...MODULE_GRANT_CODES.map((code) => [code as string, MODULE_GRANTS[code]] as const),
]);

/** Состав набора в базе, отсортированный: порядок строк `INSERT`'а свойством каталога не является. */
async function permissionsOf(code: string): Promise<string[]> {
  const { rows } = await client.query<{ permission: string }>(
    `SELECT gp.permission
       FROM grant_permissions gp
       JOIN grants g ON g.id = gp.grant_id
      WHERE g.code = $1
      ORDER BY gp.permission`,
    [code],
  );
  return rows.map((r) => r.permission);
}

/**
 * Роли, которым набор разрешено назначать. Сортировка здесь, а не в `ORDER BY`: `role` — enum, и
 * Postgres упорядочивает его по порядку объявления значений, а сравнивать список надо со списком из
 * контрактов, отсортированным как строки.
 */
async function rolesOf(code: string): Promise<string[]> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT gr.role
       FROM grant_roles gr
       JOIN grants g ON g.id = gr.grant_id
      WHERE g.code = $1`,
    [code],
  );
  return rows.map((r) => r.role).sort();
}

/**
 * Разница двух списков словами. Сообщение теста читает не тот, кто его писал, а тот, кто минуту
 * назад правил матрицу прав и забыл про каталог, — и ему нужно имя набора и обе стороны расхождения,
 * а не «expected [...] to equal [...]» на двух экранах.
 */
function diff(code: string, inDb: readonly string[], inCode: readonly string[]): string {
  const db = new Set(inDb);
  const contracts = new Set(inCode);
  const extra = inDb.filter((v) => !contracts.has(v));
  const missing = inCode.filter((v) => !db.has(v));
  return [
    `набор «${code}»: каталог в базе разошёлся с контрактами`,
    extra.length ? `лишнее в базе: ${extra.join(', ')}` : '',
    missing.length ? `нет в базе: ${missing.join(', ')}` : '',
    'миграции каталога (0145, 0150) переписывают состав руками — поправь его новой миграцией',
  ]
    .filter(Boolean)
    .join('; ');
}

describe.skipIf(!DB_URL)('каталог системных полномочий: база против контрактов', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  /**
   * Наличие строки. Без неё разошедшийся состав проверять не на чем, а назначению шага 1b не на что
   * ссылаться: перенос соединяется с каталогом по коду и на отсутствующем наборе теряет выдачу
   * молча. `is_system` при этом не украшение — только системный набор может нести сквозную область
   * (ADR 0106, решение 2) и только он не правится из интерфейса.
   */
  it('в базе есть набор на каждый код, и все они системные', async () => {
    const { rows } = await client.query<{
      code: string;
      name: string;
      is_system: boolean;
      deleted_at: Date | null;
    }>('SELECT code, name, is_system, deleted_at FROM grants WHERE code = ANY($1)', [
      [...ALL_SYSTEM_GRANT_CODES],
    ]);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const code of ALL_SYSTEM_GRANT_CODES) {
      const row = byCode.get(code);
      expect(
        row,
        `в таблице grants нет набора «${code}» — миграция каталога не накатана?`,
      ).toBeTruthy();
      expect(row!.is_system, `набор «${code}» не помечен is_system`).toBe(true);
      // Мягкое удаление системного набора — то же, что его отсутствие: выдавать и отражать нечего.
      expect(row!.deleted_at, `набор «${code}» помечен удалённым`).toBeNull();
      /*
       * Название сверяется только там, где оно объявлено в коде. У административных наборов это
       * `ADMIN_GRANTS[code].name`, и сверять его стоит: имя набора уходит в текст отказа выдачи
       * (`grantLabel`) и в реестр выдач, а системный набор не редактируется — значит разъехаться
       * база и код могут только правкой миграции, то есть по ошибке. У перенесённых из надстроек
       * подписи живут в `roleAddonLabels` и принадлежат надстройке, а не набору: их сверка уйдёт
       * вместе с `role-addons.ts` на шаге 1e, и заводить её здесь — значит заводить копию на снос.
       */
      const declared = DECLARED.get(code)?.name;
      if (declared !== undefined) {
        expect(row!.name, `название набора «${code}» в базе разошлось с ADMIN_GRANTS`).toBe(
          declared,
        );
      }
    }
  });

  /**
   * Обратная сторона: системный набор, которого нет в коде. Взяться он может из миграции, заведшей
   * набор «на будущее», или из `UPDATE grants SET is_system = true` руками — и в обоих случаях это
   * набор, чей состав никто не сверяет, а сквозную область он получить не может (таблица области
   * типизирована `SystemGrantCode`). Утверждение узкое: строки с `is_system = false` сюда не
   * попадают, поэтому пользовательские наборы соседних тестов проверку не роняют.
   */
  it('лишних системных наборов в базе нет', async () => {
    const { rows } = await client.query<{ code: string }>(
      'SELECT code FROM grants WHERE is_system = true AND deleted_at IS NULL ORDER BY code',
    );
    expect(rows.map((r) => r.code)).toEqual([...ALL_SYSTEM_GRANT_CODES].sort());
  });

  /**
   * **Главная проверка файла.** Состав прав в базе — точно тот, что объявлен в контрактах. Точно, а
   * не «содержит»: лишнее право в базе после шага 1c даст держателю доступ, которого матрица не
   * выдавала (и который не покажет ни один тест прав), а недостающее — тихо отнимет тот, что она
   * выдаёт. Ни то, ни другое не видно в интерфейсе: набор системный, его состав не редактируется и
   * на экране не показан.
   */
  it('состав прав каждого набора точно равен объявленному в контрактах', async () => {
    for (const [code, declared] of DECLARED) {
      const inDb = await permissionsOf(code);
      const inCode = [...declared.permissions].sort();
      expect(inDb, diff(code, inDb, inCode)).toEqual(inCode);
    }
  });

  /**
   * Список ролей — вторая половина той же копии. Роль, потерянная в базе, после шага 1c закроет
   * выдачу набора половине тех, кому он положен («оператор оргтехники» перестанет назначаться
   * отделу), а лишняя — откроет её тем, кому надстройку не выдавали никогда: «оператор оргтехники»
   * на арендодателе ТС и есть тот доступ, ради запрета которого `ROLE_ADDON_BASE_ROLES` заведена
   * таблицей. У административных наборов цена ошибки та же: лишняя роль в `grant_roles` — это
   * право выдать «Архивариуса» площадке, то есть удалённые записи всей компании роли с осью.
   */
  it('список ролей каждого набора точно равен объявленному в контрактах', async () => {
    for (const [code, declared] of DECLARED) {
      const inDb = await rolesOf(code);
      const inCode = [...declared.roles].sort() as Role[];
      expect(inDb, diff(code, inDb, inCode)).toEqual(inCode);
    }
  });

  /**
   * Право в базе хранится текстом, и словаря прав в базе нет намеренно (`grant_permissions` —
   * комментарий схемы): справочник был бы второй копией закрытого словаря контрактов. Цена этого —
   * возможность строки-сироты: право, переименованное выкатом, остаётся в наборе строкой, которой не
   * соответствует ничего. Доступа она не даёт (читатель обязан её отфильтровать), но набор молча
   * теряет действие — и в системном наборе такая строка означает, что миграцию каталога забыли.
   */
  it('все права системных наборов существуют в словаре', async () => {
    const { rows } = await client.query<{ code: string; permission: string }>(
      `SELECT g.code, gp.permission
         FROM grant_permissions gp
         JOIN grants g ON g.id = gp.grant_id
        WHERE g.code = ANY($1)
        ORDER BY g.code, gp.permission`,
      [[...ALL_SYSTEM_GRANT_CODES]],
    );
    expect(
      rows,
      'у системных наборов нет ни одного права — миграция каталога не накатана?',
    ).not.toEqual([]);
    for (const { code, permission } of rows) {
      expect(
        isPermission(permission),
        `набор «${code}»: права «${permission}» нет в словаре PERMISSIONS`,
      ).toBe(true);
    }
  });

  /**
   * **Этап 4 не расширяет доступ ни одной живой учётке** (план §10 и §15, колонка «расширяет
   * доступ» — «нет»). Наборы заводятся и на этом всё: доступ расширяется только явной выдачей
   * администратора, и каждая такая выдача — строка с автором и временем.
   *
   * Проверка узкая по построению: спрашиваются назначения **только четырёх административных**
   * наборов. Перенесённые из надстроек под неё не попадают намеренно — их назначения заводит
   * шаг 1b и соседние db-тесты выдачи, и утверждение «`user_grants` пуст» упало бы от чужой
   * работы, а не от чужой ошибки. Административные наборы не выдаёт никто: они появились
   * миграцией сегодня, и ни один тест их по коду не берёт.
   *
   * Что ловится: строка `INSERT INTO user_grants`, дописанная в миграцию каталога «чтобы
   * диспетчерам сразу работалось». Это и есть расширение доступа миграцией — молча, мимо журнала
   * выдач и мимо того, кто за него отвечает.
   */
  it('миграция не создала ни одного назначения административных наборов', async () => {
    const { rows } = await client.query<{ code: string; holders: string }>(
      `SELECT g.code, count(ug.id)::text AS holders
         FROM grants g
         LEFT JOIN user_grants ug ON ug.grant_id = g.id
        WHERE g.code = ANY($1)
        GROUP BY g.code
        ORDER BY g.code`,
      [[...ADMIN_GRANT_CODES]],
    );
    expect(
      rows.map((r) => r.code),
      'в базе нет административных наборов — миграция 0150 не накатана?',
    ).toEqual([...ADMIN_GRANT_CODES].sort());
    for (const { code, holders } of rows) {
      expect(
        holders,
        `набор «${code}» кому-то выдан: этап 4 заводит наборы, никому их не выдавая`,
      ).toBe('0');
    }
  });
});
