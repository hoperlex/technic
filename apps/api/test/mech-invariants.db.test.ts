import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только тип: значение берётся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';

/**
 * Физические инварианты аренды малой механизации (ADR 0152, миграция 0238; план
 * `docs/mechanization-module-plan.md`, §6 «Полнота факта», Р6, Р8).
 *
 * **Зачем база, а не проверка коридора.** Всё, что здесь проверяется, живёт ниже маршрутов и через
 * маршрут не видно ни одной попыткой: коридор статусов — это код, а колонка принимает любое
 * значение своего типа, и строку в базу кладёт не только портал. Три вещи проверяются **прямым
 * запросом** именно потому, что закрыты они не сервером:
 *
 * 1. **`deal_parts_check` — заплата на дыре составного ключа.** PostgreSQL проверяет внешний ключ в
 *    режиме `MATCH SIMPLE`: если хотя бы одна колонка ключа `NULL`, ключ не проверяется **вовсе**.
 *    Строка с правдоподобным `lessor_id`, правдоподобным типом и `lessor_is_active = NULL` прошла бы
 *    мимо ключа целиком — то есть с арендодателем, которого никто не сверял. Что это именно так,
 *    тест не берёт на веру, а показывает: рядом заводится пробная таблица с тем же ключом и **без**
 *    этой проверки, и половинчатый ключ в неё ложится;
 * 2. **`status_check` — «Завершена» у механизации нет.** Тип `request_status` общий на все модули
 *    заявок, значение в нём есть, а перехода в него нет ни в одном коридоре. Без барьера строка со
 *    статусом «Завершена» прошла бы мимо всех проверок договорённости и факта — те спрашивают
 *    `confirmed` и `done` поимённо;
 * 3. **лестница факта — три состояния и только они.** Проверки статусов стерегут один `done`, и
 *    «В работе» с отработанными часами и суммой, но без даты возврата, считалась бы **действующей
 *    арендой с уже проставленным итогом**. Перебор неполных сочетаний — это перебор строк, которых
 *    не бывает, и предъявить его можно только базе.
 *
 * Имя нарушенного ограничения сверяется наравне с кодом: у таблицы четырнадцать `CHECK`'ов, и
 * невозможная строка часто нарушает сразу два. Сравнивай тест один код `23514` — он проходил бы,
 * отказывай база по другой причине, чем названо в заголовке, и снятое послабление осталось бы
 * незамеченным. Поэтому каждый случай подобран так, чтобы нарушение было **ровно одно**.
 *
 * Вся сцена живёт внутри транзакции, которая **всегда откатывается**: база у db-тестов общая, и
 * оставленные за собой площадка, контрагенты и заявки испортили бы соседние файлы, половина которых
 * берёт из справочников «первую попавшуюся» запись.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-invariants.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: сцена откатывается, но email учётки и ИНН контрагента уникальны глобально. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!DB_URL) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
  const { db, closeDb } = await import('../src/db/client');
  ctx = { db, closeDb };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/** Что заведено сценой: площадка, автор и три контрагента — по одному на каждый случай ключа. */
interface Scene {
  objectId: string;
  userId: string;
  /** Арендодатель механизации, активен: с ним строка обязана ложиться. */
  mechLessorId: string;
  /** Арендодатель ТС: тип другой, но `lessor_type_check` называет и его (Р6). */
  vehicleLessorId: string;
  /** Перевозчик: контрагент существует, арендодателем не бывает. */
  operatorId: string;
}

/** Уникальный ИНН: `counterparties_inn_unique` смотрит на всю базу, а она общая. */
let innSeq = 0;
function nextInn(): string {
  innSeq += 1;
  // Десять цифр: девятка впереди и хвост прогона — чтобы не столкнуться ни с сидами, ни с соседями.
  return `9${String(Date.now() % 100_000_000).padStart(8, '0')}${innSeq % 10}`;
}

/**
 * Собирает сцену и отдаёт её обработчику **внутри транзакции**, которая затем откатывается.
 *
 * Откат — не гигиена, а условие правильности: заявка держит площадку и автора `RESTRICT`'ом, а
 * контрагента — составным ключом, и оставленная строка не дала бы прибраться ни этому файлу, ни
 * соседнему.
 */
async function inScene<T>(run: (tx: never, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<{ id: string }> => {
        const [row] = (await tx.execute<{ id: string }>(q)).rows;
        if (!row) throw new Error('сцену не собрать: запрос не вернул строки');
        return row;
      };
      // Площадка своя: чужую пришлось бы искать «первой попавшейся», а её состав и активность
      // меняет соседний файл того же прогона.
      const object = await one(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`яя-mech-inv-${RUN}`}, ${`Площадка инвариантов ${RUN}`}, 'г. Москва, тестовый проезд, 1')
        RETURNING id`);
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`db-mech-inv-${RUN}@example.invalid`}, 'Инвариантов', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const counterparty = async (type: string, name: string) =>
        one(sql`
          INSERT INTO counterparties (type, name, inn, is_active)
          VALUES (${type}, ${`${name} ${RUN}`}, ${nextInn()}, true)
          RETURNING id`);
      const mechLessor = await counterparty('mech_lessor', 'Арендодатель механизации');
      const vehicleLessor = await counterparty('vehicle_lessor', 'Арендодатель ТС');
      const operator = await counterparty('operator', 'Перевозчик');

      out = await run(tx as never, {
        objectId: object.id,
        userId: user.id,
        mechLessorId: mechLessor.id,
        vehicleLessorId: vehicleLessor.id,
        operatorId: operator.id,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Отказ базы: код `SQLSTATE` и имя нарушенного ограничения. `null` — запись прошла. */
interface Refusal {
  code: string;
  constraint: string;
}

/** Проверка прошла: `null` от `refusal` читается на экране хуже, чем именованное «легла». */
const ACCEPTED = null;

/**
 * Ответ базы на попытку записи.
 *
 * Каждая попытка идёт под своей точкой сохранения. Без неё первый же отказ обрывает транзакцию
 * целиком, и следующий запрос получает не свой код, а `25P02` «транзакция в состоянии ошибки».
 */
let savepoint = 0;
async function refusal(
  tx: never,
  query: Parameters<(typeof AppDb)['execute']>[0],
): Promise<Refusal | null> {
  const runner = tx as unknown as { execute: (typeof AppDb)['execute'] };
  const name = `mech_probe_${(savepoint += 1)}`;
  await runner.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    await runner.execute(query);
    await runner.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return null;
  } catch (e) {
    await runner.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    // Drizzle заворачивает ошибку драйвера: `SQLSTATE` и имя ограничения лежат в причине, а не на
    // верхнем уровне. Без разбора причины тест сравнивал бы с 'unknown' и проходил бы на любом
    // отказе — в том числе на «нет такой колонки», то есть проверял бы опечатку, а не ключ.
    const cause = (e as { cause?: { code?: string; constraint?: string } }).cause ?? e;
    const err = cause as { code?: string; constraint?: string };
    return { code: err.code ?? 'unknown', constraint: err.constraint ?? '—' };
  }
}

/** Нарушение `CHECK`: `23514` — единственный код, которым отвечает проверка ограничения. */
const check = (constraint: string): Refusal => ({ code: '23514', constraint });
/** Нарушение внешнего ключа: `23503`. */
const foreignKey = (constraint: string): Refusal => ({ code: '23503', constraint });

/** Договорённость и факт — всё, чем строки этого файла отличаются одна от другой. */
interface Row {
  status?: string;
  lessorId?: string | null;
  lessorType?: string | null;
  lessorIsActive?: boolean | null;
  rate?: string | null;
  rateUnit?: string | null;
  actualFrom?: string | null;
  actualTo?: string | null;
  actualUnits?: string | null;
  finalCost?: string | null;
}

/**
 * Полная договорённость на активного арендодателя механизации: пять колонок, которые живут и
 * умирают вместе. Нужна почти каждому случаю — без неё «В работе» и «Выполнена» отвергались бы
 * `deal_check`'ом, а тест мерил бы не то, что назвал.
 */
function deal(scene: Scene): Row {
  return {
    lessorId: scene.mechLessorId,
    lessorType: 'mech_lessor',
    lessorIsActive: true,
    rate: '1200.00',
    rateUnit: 'hour',
  };
}

/** Полный возврат: три части, которые лестница допускает только вместе. */
const FULL_RETURN: Row = { actualTo: '2026-09-10', actualUnits: '26.00', finalCost: '31200.00' };

/** Вставка заявки: обязательные поля одни и те же, различается только то, что проверяет случай. */
function insert(scene: Scene, row: Row): ReturnType<typeof sql> {
  return sql`
    INSERT INTO mech_requests (
      object_id, kind_name, planned_from, planned_to, responsible_name, responsible_phone,
      created_by, status,
      lessor_id, lessor_type, lessor_is_active, rate, rate_unit,
      actual_from, actual_to, actual_units, final_cost
    ) VALUES (
      ${scene.objectId}, 'Виброплита', '2026-09-01', '2026-09-30', 'Иванов И.И.', '9990000000',
      ${scene.userId}, ${row.status ?? 'new'},
      ${row.lessorId ?? null}, ${row.lessorType ?? null}, ${row.lessorIsActive ?? null},
      ${row.rate ?? null}, ${row.rateUnit ?? null},
      ${row.actualFrom ?? null}, ${row.actualTo ?? null},
      ${row.actualUnits ?? null}, ${row.finalCost ?? null}
    )`;
}

describe.skipIf(!DB_URL)('механизация: инварианты базы (ADR 0152, миграция 0238)', () => {
  it('договорённость целиком или её нет: неполный ключ отбивает deal_parts_check', async () => {
    await inScene(async (tx, scene) => {
      // Тот самый случай, ради которого проверка и заведена: всё, кроме активности. Статус
      // «Отменена» выбран не для красоты — при нём не работают ни `new_empty_check`, ни
      // `deal_check`, и отказать может ровно одно ограничение. Заодно это и есть постановка задачи:
      // договорённость обязана быть целой даже у заявки, которую отменили.
      expect(
        await refusal(
          tx,
          insert(scene, { ...deal(scene), status: 'cancelled', lessorIsActive: null }),
        ),
      ).toEqual(check('mech_requests_deal_parts_check'));

      // Вторая половина того же правила: цена без арендодателя — тоже не договорённость.
      expect(
        await refusal(
          tx,
          insert(scene, { status: 'cancelled', rate: '1200.00', rateUnit: 'hour' }),
        ),
      ).toEqual(check('mech_requests_deal_parts_check'));

      // И полная пятёрка, чтобы отказы выше читались как «неполный ключ», а не «ключ вообще не
      // ложится»: без этой строки тест проходил бы и на сломанной вставке.
      expect(await refusal(tx, insert(scene, { ...deal(scene), status: 'cancelled' }))).toBe(
        ACCEPTED,
      );

      // «В работе» без договорённости вовсе — второй барьер, про который спрашивает сервер: тот же
      // отказ дал бы CHECK, но пятисотым вместо внятного.
      expect(await refusal(tx, insert(scene, { status: 'confirmed' }))).toEqual(
        check('mech_requests_deal_check'),
      );
    });
  }, 60_000);

  it('без deal_parts_check внешний ключ не проверился бы вовсе: MATCH SIMPLE', async () => {
    await inScene(async (tx) => {
      const runner = tx as unknown as { execute: (typeof AppDb)['execute'] };
      // Тот же составной ключ на те же колонки справочника — и БЕЗ проверки полноты. Пробная
      // таблица нужна затем, что на самой `mech_requests` дыру не показать: её закрывает как раз
      // то ограничение, чью необходимость мы и доказываем.
      //
      // Таблица обычная, а не временная: внешний ключ временной таблицы Postgres разрешает только
      // на другую временную (`42P16`), а ссылаться проба обязана на НАСТОЯЩИЙ справочник — иначе
      // она показывала бы свойство своей выдумки, а не нашего ключа. Живёт она внутри той же
      // откатываемой транзакции: DDL здесь транзакционен, и после отката её не существует.
      await runner.execute(sql`
        CREATE TABLE mech_lessor_fk_probe (
          lessor_id uuid,
          lessor_type counterparty_type,
          lessor_is_active boolean,
          CONSTRAINT probe_lessor_fk FOREIGN KEY (lessor_id, lessor_type, lessor_is_active)
            REFERENCES counterparties (id, type, is_active)
        )`);

      // Ключ с одной пустой колонкой ПРОХОДИТ, хотя контрагента с таким id не существует вовсе:
      // ровно это и означает MATCH SIMPLE.
      expect(
        await refusal(
          tx,
          sql`INSERT INTO mech_lessor_fk_probe VALUES (gen_random_uuid(), 'mech_lessor', NULL)`,
        ),
      ).toBe(ACCEPTED);

      // Стоит заполнить все три — и тот же выдуманный арендодатель отбивается ключом. То есть ключ
      // рабочий, а пропускает он строку не по ошибке, а по правилу языка.
      expect(
        await refusal(
          tx,
          sql`INSERT INTO mech_lessor_fk_probe VALUES (gen_random_uuid(), 'mech_lessor', true)`,
        ),
      ).toEqual(foreignKey('probe_lessor_fk'));
    });
  }, 60_000);

  it('арендодатель чужого типа не проходит ни проверкой типа, ни составным ключом', async () => {
    await inScene(async (tx, scene) => {
      // Честно названный перевозчик: ключ бы его пропустил — такая тройка в справочнике есть, — и
      // отсекает его только перечень допустимых типов.
      expect(
        await refusal(
          tx,
          insert(scene, {
            ...deal(scene),
            status: 'confirmed',
            lessorId: scene.operatorId,
            lessorType: 'operator',
          }),
        ),
      ).toEqual(check('mech_requests_lessor_type_check'));

      // Перевозчик, названный арендодателем: перечень типов доволен, а ключ такой тройки в
      // справочнике не находит. Два барьера закрывают две разные подделки, и ни один не лишний.
      expect(
        await refusal(
          tx,
          insert(scene, { ...deal(scene), status: 'confirmed', lessorId: scene.operatorId }),
        ),
      ).toEqual(foreignKey('mech_requests_lessor_fk'));

      // База к «Арендодателю (ТС)» терпима, а сервис — нет, и это ГРАНИЦА, а не рассогласование.
      // Заказчик 02.09.2026 запретил предлагать таких контрагентов в выборе (разворот Р6), и
      // отказ даёт `assertMechLessorAssignable` внятным сообщением. Ограничение базы оставлено
      // прежним намеренно: оно стережёт «арендодатель существует и активен», а «кого сегодня можно
      // выбрать» — вопрос правила, которое меняется без миграции. Этот тест закрепляет именно
      // терпимость базы: сузь её — и возврат к прежнему правилу стоил бы выката схемы.
      expect(
        await refusal(
          tx,
          insert(scene, {
            ...deal(scene),
            status: 'confirmed',
            lessorId: scene.vehicleLessorId,
            lessorType: 'vehicle_lessor',
          }),
        ),
      ).toBe(ACCEPTED);
    });
  }, 60_000);

  it('статуса «Завершена» у аренды нет — ни вставкой, ни правкой', async () => {
    await inScene(async (tx, scene) => {
      // Строка без договорённости и без факта: все прочие проверки спрашивают `confirmed` и `done`
      // поимённо и промолчали бы. Ровно поэтому барьер и стоит отдельным.
      expect(await refusal(tx, insert(scene, { status: 'completed' }))).toEqual(
        check('mech_requests_status_check'),
      );

      // Второй путь к тому же значению — правка живой заявки. Он опаснее вставки: строка уже
      // прошла все проверки, и без барьера «Завершена» приехала бы обычным `UPDATE`.
      expect(await refusal(tx, insert(scene, {}))).toBe(ACCEPTED);
      expect(
        await refusal(
          tx,
          sql`UPDATE mech_requests SET status = 'completed' WHERE object_id = ${scene.objectId}`,
        ),
      ).toEqual(check('mech_requests_status_check'));
    });
  }, 60_000);

  it('лестница факта: принимаются ровно три состояния', async () => {
    await inScene(async (tx, scene) => {
      const base = { ...deal(scene), status: 'confirmed' };
      // 1. Фактов нет: договорились, техника ещё не приехала.
      expect(await refusal(tx, insert(scene, base))).toBe(ACCEPTED);
      // 2. Только выдача: техника на площадке — это и есть действующая аренда.
      expect(await refusal(tx, insert(scene, { ...base, actualFrom: '2026-09-02' }))).toBe(
        ACCEPTED,
      );
      // 3. Выдача плюс полный возврат: у «В работе» это коррекция завершения, у «Выполнена» —
      // закрытая заявка. Оба состояния законны, и оба проверяются здесь.
      expect(
        await refusal(tx, insert(scene, { ...base, actualFrom: '2026-09-02', ...FULL_RETURN })),
      ).toBe(ACCEPTED);
      expect(
        await refusal(
          tx,
          insert(scene, { ...base, status: 'done', actualFrom: '2026-09-02', ...FULL_RETURN }),
        ),
      ).toBe(ACCEPTED);
    });
  }, 60_000);

  it('лестница факта: промежуточных ступеней нет ни одной', async () => {
    await inScene(async (tx, scene) => {
      const running = { ...deal(scene), status: 'confirmed', actualFrom: '2026-09-02' };

      // Самый дорогой из невозможных случаев: строка считалась бы ДЕЙСТВУЮЩЕЙ АРЕНДОЙ — техника
      // якобы стоит на площадке, — но итог по ней уже посчитан и предъявлен.
      expect(
        await refusal(
          tx,
          insert(scene, { ...running, actualUnits: '26.00', finalCost: '31200.00' }),
        ),
      ).toEqual(check('mech_requests_return_parts_check'));

      // Возврат без денег: техника вернулась, а во что это обошлось, не знает никто.
      expect(await refusal(tx, insert(scene, { ...running, actualTo: '2026-09-10' }))).toEqual(
        check('mech_requests_return_parts_check'),
      );
      // Возврат с часами, но без суммы — и он же с суммой, но без часов: расчёт
      // `actual_units × rate` не с чем сверить ни в ту, ни в другую сторону.
      expect(
        await refusal(
          tx,
          insert(scene, { ...running, actualTo: '2026-09-10', actualUnits: '26.00' }),
        ),
      ).toEqual(check('mech_requests_return_parts_check'));
      expect(
        await refusal(
          tx,
          insert(scene, { ...running, actualTo: '2026-09-10', finalCost: '31200.00' }),
        ),
      ).toEqual(check('mech_requests_return_parts_check'));

      // Возврата без выдачи не бывает: полный факт возврата при пустой дате подачи отвергается
      // другим ограничением — `return_parts` здесь доволен, а лестница всё равно не сходится.
      expect(
        await refusal(tx, insert(scene, { ...deal(scene), status: 'confirmed', ...FULL_RETURN })),
      ).toEqual(check('mech_requests_issue_first_check'));

      // «Выполнена» — это ответ на все четыре вопроса. Строка с одной выдачей отвечает на один.
      expect(
        await refusal(
          tx,
          insert(scene, { ...deal(scene), status: 'done', actualFrom: '2026-09-02' }),
        ),
      ).toEqual(check('mech_requests_done_check'));
    });
  }, 60_000);

  it('«Новая» — это просьба и ничего больше, а выданное не отменяют', async () => {
    await inScene(async (tx, scene) => {
      // Договорённость у «Новой»: без этого барьера откат оставлял бы заявку чистым листом с
      // сохранённой ценой — и цепочка `confirmed → cancelled → new` возвращала бы её в оборот.
      expect(await refusal(tx, insert(scene, deal(scene)))).toEqual(
        check('mech_requests_new_empty_check'),
      );
      // Выдача у «Новой»: техника не может стоять на площадке по заявке, которую ещё не взяли.
      expect(await refusal(tx, insert(scene, { actualFrom: '2026-09-02' }))).toEqual(
        check('mech_requests_new_empty_check'),
      );
      // Отмена выданного: за простоявшую на объекте технику выставят счёт, и отмена означала бы,
      // что аренды не было. Барьер базы — тот же запрет, что маршрут отдаёт 422.
      expect(
        await refusal(
          tx,
          insert(scene, { ...deal(scene), status: 'cancelled', actualFrom: '2026-09-02' }),
        ),
      ).toEqual(check('mech_requests_cancel_check'));
    });
  }, 60_000);
});
