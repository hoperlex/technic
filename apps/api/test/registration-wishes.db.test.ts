import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activationDefaultsFor,
  REGISTRATION_ROLE_REQUESTS,
  requestRoleTitle,
  type ActivationDefaults,
  type RegistrationRoleRequest,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { registrationRoleRequestEnum } from '../src/db/schema';
import { pgErrorOf } from '../src/lib/pg-error';

/**
 * Пожелание при регистрации: перечень базы против кода и CHECK'и уточнений (миграции 0218 и 0219,
 * план `docs/registration-wishes-and-activation-plan.md` §3.1, §3.4, §3.10).
 *
 * **Зачем сторож перечня.** Значение enum'а PostgreSQL не удаляется вовсе — `ALTER TYPE ... DROP
 * VALUE` не существует, — и на этих значениях стоят живые строки `users.requested_role`: пожелание
 * это то, что заявитель о себе сказал, и переписать его задним числом нечем. Поэтому перечень
 * расходится молча и в обе стороны, и каждая сторона ломает своё:
 *
 * - **значение есть в базе, а в коде его нет** — это упразднённое пожелание, снятое с экрана
 *   регистрации. Список заявок, карточка учётки, письма и журнал изменений покажут вместо
 *   пожелания пустоту (`registrationRoleRequestLabels[value]` → `undefined`), а форма
 *   рассмотрения останется без умолчаний — в заявке, которую уже не переписать. Подпись поэтому и
 *   спрашивается функцией `requestRoleTitle` (действующая, затем архивная), а не словарём;
 * - **значение есть в коде, а в базе его нет** — экран регистрации предложит должность, которую
 *   база не примет: заявка упадёт пятисоткой на `INSERT`. Ровно поэтому этапы 1 и 2 плана
 *   выкатываются вместе.
 *
 * Сегодня словарь архивных подписей пуст, и это правильное состояние, а не заготовка: ни одно
 * пожелание не упраздняется. Страж заведён вместе с ним и **раньше** первого упразднения — иначе
 * он проверял бы работу, сделанную минуту назад, вместо того чтобы покраснеть на том релизе,
 * который значение снимет, а подпись перенести забудет.
 *
 * **Сверяются множества, а не последовательности.** Порядок в базе — порядок добавления
 * (`ALTER TYPE ... ADD VALUE` без `BEFORE`, миграции 0057, 0067, 0130, 0218), порядок в массиве
 * контрактов — порядок списка на экране регистрации. Они уже не совпадают, совпадать не обязаны, и
 * сортировок по этому типу в портале нет ни одной.
 *
 * **Зачем сюда же CHECK'и.** Обязательность уточнения — единственное, что держит база сама: код
 * проверяет её `registrationRequestIssue`, но заявка приходит и мимо формы. Проверять эти правила
 * на подменах нельзя вовсе — расходятся не правила, а код и схема, и увидеть расхождение можно
 * только там, где CHECK существует. Главное здесь — что **отдел пишется в колонку
 * `requested_object`**: в этом суть решения §3.4 («колонку переиспользуем, а не заводим
 * четвёртую»), и разворачивается оно ровно одной строкой миграции 0219.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/registration-wishes.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Хвост прогона в адресе. Строк тест за собой не оставляет вовсе (каждая проба откатывается), но
 * два прогона по одной базе могут держать свои `INSERT` одновременно: уникальный индекс по email
 * заставил бы второго ждать первого и ответить `23505` вместо нарушенного CHECK — то есть отказом
 * не про то, о чём тест.
 */
const RUN = randomUUID().slice(0, 8);

let client: pg.Client;
/** Значения перечисления, как их видит база, — читаются один раз на файл. */
let dbValues: string[] = [];

/** Отказ базы: код `SQLSTATE` и имя нарушенного ограничения; `null` — заявка принята. */
interface Refusal {
  code: string;
  constraint: string;
}

interface Attempt {
  refusal: Refusal | null;
  /** Что легло в колонки уточнений; читается до отката — им и проверяется, куда попал отдел. */
  stored: { object: string; company: string } | null;
}

let probeNo = 0;

/**
 * Заявка с указанным пожеланием и уточнениями — и ответ базы на неё.
 *
 * **Транзакция откатывается всегда, в том числе на принятой заявке.** База у db-тестов общая и
 * переживает прогон, а половина соседних файлов берёт из `users` «первую попавшуюся» строку:
 * оставленная учётка портит не этот файл, а чужой и на следующем запуске. Уборка `DELETE`'ом
 * после `COMMIT` здесь не нужна вовсе — проверяется реакция схемы, а не жизнь строки, и её видно
 * внутри транзакции целиком.
 */
async function attempt(
  wish: string | null,
  detail: { object?: string; company?: string } = {},
): Promise<Attempt> {
  probeNo += 1;
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ requested_object: string; requested_company: string }>(
      `INSERT INTO users
         (email, password_hash, last_name, first_name,
          requested_role, requested_object, requested_company)
       VALUES ($1, 'x', 'Пожеланов', 'Тест', $2::registration_role_request, $3, $4)
       RETURNING requested_object, requested_company`,
      [
        `reg-wish-${probeNo}-${RUN}@example.invalid`,
        wish,
        detail.object ?? '',
        detail.company ?? '',
      ],
    );
    const row = rows[0]!;
    return {
      refusal: null,
      stored: { object: row.requested_object, company: row.requested_company },
    };
  } catch (e) {
    // Имя ограничения проверяется наравне с кодом: CHECK'ов на `users` много, и «упало хоть
    // как-то» прошло бы и на опечатке в колонке, и на чужом ограничении.
    const info = pgErrorOf(e) ?? {};
    return {
      refusal: { code: info.code ?? 'unknown', constraint: info.constraint ?? '—' },
      stored: null,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Нарушение CHECK: этим кодом база отвечает на невозможное уточнение. */
const CHECK_VIOLATION = '23514';

describe.skipIf(!DB_URL)('пожелания при регистрации: перечень базы и CHECK уточнений', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
    const { rows } = await client.query<{ value: string }>(
      `SELECT e.enumlabel AS value FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'registration_role_request' ORDER BY e.enumsortorder`,
    );
    dbValues = rows.map((r) => r.value);
  }, 300_000);

  afterAll(async () => {
    await client?.end();
  });

  it('подпись есть у каждого значения перечисления, а не только у действующих', async () => {
    // Пустой список значил бы, что тип назван с опечаткой, и весь страж проходил бы вхолостую.
    expect(dbValues.length).toBeGreaterThan(0);

    // Спрашивается именно `requestRoleTitle`: прямое обращение к словарю действующих подписей
    // ответило бы `undefined` в день упразднения. Ответ сверяется с самим кодом, потому что
    // неизвестное значение функция возвращает как есть — сырой код в списке заявок и есть тот
    // признак, по которому видно забытую подпись.
    const untitled = dbValues.filter((value) => requestRoleTitle(value) === value);
    expect(untitled).toEqual([]);
  });

  it('ответ таблицы активации есть у каждого значения перечисления в базе', async () => {
    /*
     * Каст здесь намеренный, и в нём весь смысл проверки: таблица спрашивается тем, что лежит в
     * базе, а не тем, что обещает тип. Тип узок по перечню кода — а строки стоят на значениях
     * enum'а, и заявка с упразднённым пожеланием откроется в форме рассмотрения ровно так же, как
     * вчерашняя.
     *
     * Покраснеет страж на релизе, который снимет пожелание из `REGISTRATION_ROLE_REQUESTS`, и это
     * не ложная тревога: `activationDefaultsFor` ответит `undefined`, а форма читает у ответа роль
     * и наборы. Лечения два, и оба законны: оставить упразднённому значению строку умолчаний либо
     * научить функцию отвечать «умолчания нет» на всё, чего в перечне уже нет.
     */
    const unanswered = dbValues.filter((value) => {
      const answer: ActivationDefaults | undefined = activationDefaultsFor(
        value as RegistrationRoleRequest,
      );
      return !answer || !Array.isArray(answer.grants);
    });
    expect(unanswered).toEqual([]);
  });

  it('перечень кода целиком принимается базой', async () => {
    // Сравнение множествами: порядок в базе — порядок добавления значений, порядок в массиве —
    // порядок списка на экране регистрации, и совпадать они не обязаны.
    const known = new Set(dbValues);
    expect(REGISTRATION_ROLE_REQUESTS.filter((value) => !known.has(value))).toEqual([]);
    /*
     * Объявление drizzle — третий список тех же значений, и расходится он тише двух других:
     * компилятор пропустит `INSERT` с пожеланием, которого в базе нет, а упадёт запрос в проде.
     * Стоит проверка одной строки, поэтому проверяется здесь, а не отдельным файлом.
     */
    expect(registrationRoleRequestEnum.enumValues.filter((value) => !known.has(value))).toEqual([]);
  });

  it('пожелание об отделе без подразделения база не принимает', async () => {
    const empty = await attempt('department_staff');
    expect(empty.refusal).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_requested_object_check',
    });

    // Пробелы уточнением не считаются — за это отвечает `btrim` в условии, и без пробы он тихо
    // выпал бы при следующей правке ограничения.
    const blank = await attempt('department_head', { object: '   ' });
    expect(blank.refusal?.constraint).toBe('users_requested_object_check');
  });

  it('отдел пишется в ту же колонку, что и объект', async () => {
    // Суть §3.4: колонка переиспользуется, а не заводится четвёртая. Проверяется не только «заявка
    // прошла», но и куда легло написанное: примись отдел молча в `requested_company` — карточка
    // показала бы его как компанию.
    const staff = await attempt('department_staff', { object: 'Отдел снабжения' });
    expect(staff.refusal).toBeNull();
    expect(staff.stored).toEqual({ object: 'Отдел снабжения', company: '' });

    const head = await attempt('department_head', { object: 'Отдел главного механика' });
    expect(head.refusal).toBeNull();

    /*
     * И обратная половина того же решения: полей уточнения три, четвёртого нет. Появись
     * `requested_department` рядом — про отдел стало бы две колонки об одном и том же, и всякий
     * читатель заявки (нормализация, форма регистрации, карточка, подстановка при активации)
     * обязан был бы ветвиться по ним.
     */
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'requested\\_%'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'requested_comment',
      'requested_company',
      'requested_object',
      'requested_role',
    ]);
  });

  it('пожелание о сервисной компании без компании база не принимает', async () => {
    const empty = await attempt('service_company');
    expect(empty.refusal).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_requested_company_check',
    });

    const named = await attempt('service_company', { company: 'ООО «Сервис-Печать»' });
    expect(named.refusal).toBeNull();
    // Компания пишется своей колонкой, подразделения у неё не спрашивают вовсе.
    expect(named.stored).toEqual({ object: '', company: 'ООО «Сервис-Печать»' });
  });

  it('пожелание без уточнений проходит без них', async () => {
    // Диспетчер не работает ни в пределах объекта, ни от лица контрагента: пустые уточнения у него
    // — законная заявка, а не недозаполненная.
    expect((await attempt('dispatcher')).refusal).toBeNull();
    /*
     * «Другое» тоже проходит: обязательность комментария держит `registerSchema` в контрактах, а
     * не CHECK. Заведи его база — старые заявки, которым комментарий дозаполнить нечем, перестали
     * бы двигаться вовсе: ни активировать, ни сменить адрес (довод миграций 0139 и 0219).
     */
    expect((await attempt('other')).refusal).toBeNull();
    // Учётка, заведённая администратором руками: пожелания у неё нет и быть не может (0057).
    expect((await attempt(null)).refusal).toBeNull();
  });

  it('прежние пожелания требуют того же, что и до расширения', async () => {
    // 0219 переписывает оба ограничения целиком (`DROP` плюс `ADD`), а значит может и потерять
    // прежнее значение из списка: расширение проверяется по старым пожеланиям, а не только по трём
    // новым.
    const byWish: Record<string, string | undefined> = {};
    // Пробы идут по очереди: клиент один, а каждая проба — своя транзакция.
    for (const wish of [
      'site_staff',
      'rukstroy',
      'commandant',
      'waste_operator',
      'vehicle_lessor',
    ]) {
      byWish[wish] = (await attempt(wish)).refusal?.constraint;
    }
    expect(byWish).toEqual({
      site_staff: 'users_requested_object_check',
      rukstroy: 'users_requested_object_check',
      commandant: 'users_requested_object_check',
      waste_operator: 'users_requested_company_check',
      vehicle_lessor: 'users_requested_company_check',
    });
    expect((await attempt('site_staff', { object: 'ЖК Северный' })).refusal).toBeNull();
    expect((await attempt('vehicle_lessor', { company: 'ООО «Аренда»' })).refusal).toBeNull();
  });
});
