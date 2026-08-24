import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentDirty from '../src/services/assignment-dirty';
import type * as AssignmentEnsure from '../src/services/assignment-ensure';
import type * as AssignmentWrite from '../src/services/assignment-write';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Сцена заводит заявки, листы и типы техники, а соседние файлы модуля
 * истории меняют и замораживают общую управляющую строку (план Ю27, Ю30). Прогон по общей
 * `TEST_DATABASE_URL` даёт падение, которое выглядит поломкой кода, а не гонкой файлов.
 */

/**
 * Ленивый бэкфилл заявки и три состояния готовности
 * ([assignment-ensure.ts](../src/services/assignment-ensure.ts); план
 * `docs/assignment-periods-plan.md`, Р19, Р20, Р26, Р27, Р30, §6 «Бэкфилл»).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — три предмета:
 *
 * 1. **восстановление истории по бумаге и назначению** — правила §6 по одному: заявка без листов,
 *    листы одной машины, смена машины внутри срока, линейная заявка (из листов не
 *    восстанавливается вовсе), начало срока раньше первого листа, расхождение хвоста. Проверяется
 *    на живой схеме потому, что половину правил держат частичные UNIQUE, CHECK происхождения
 *    `unknown` и групповые индексы: на объектах в памяти проверялась бы выдумка о базе;
 * 2. **честный отказ** — заявка, историю которой из бумаги однозначно не построить, не
 *    восстанавливается никак: ни строки, ни состояния. Это главное правило бэкфилла и единственное,
 *    нарушение которого не видно никому: заявку без истории видно, а заявку с выдуманной историей —
 *    нет;
 * 3. **состояние как поддерживаемый инвариант** (Р26) — ленивая ревалидация по `validated_on` и
 *    `dirty`, переход `ready → materialized` от одного лишь продления срока, и повторный вызов,
 *    который ничего не пересобирает.
 *
 * ПОЧЕМУ СЦЕНА ЖИВЁТ В ОТКАТЫВАЕМОЙ ТРАНЗАКЦИИ. База у db-тестов общая, и оставленные заявки,
 * листы и типы техники испортили бы соседние файлы, половина которых берёт из справочников «первую
 * попавшуюся» запись. `ensureAssignmentHistory` блокировок не берёт и транзакцией не владеет —
 * её держит вызывающий, — поэтому сцене хватает обычной транзакции без вложенности.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_ensure \
 *     npx vitest run test/assignment-ensure.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

const TODAY = moscowDateKeyOf(new Date());
/** Понедельник текущей недели: её лист ещё можно аннулировать, а её дни — изменяемые. */
const WEEK_NOW = weekStartKey(TODAY);
const WEEK_PREV = shiftDateKey(WEEK_NOW, -7);
const WEEK_PREV2 = shiftDateKey(WEEK_NOW, -14);
/** Воскресенье недели: конец периода листа и он же граница `canCancelWaybill`. */
const sunday = (monday: string): string => shiftDateKey(monday, 6);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  ensure: typeof AssignmentEnsure;
  write: typeof AssignmentWrite;
  command: typeof AssignmentCommand;
  dirty: typeof AssignmentDirty;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!DB_URL) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
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
  ctx = {
    db,
    closeDb,
    ensure: await import('../src/services/assignment-ensure'),
    write: await import('../src/services/assignment-write'),
    command: await import('../src/services/assignment-command'),
    dirty: await import('../src/services/assignment-dirty'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Сцена ──

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

interface RequestSpec {
  dateFrom: string;
  dateTo?: string | null;
  /** Машина назначения; `null` — назначения нет вовсе (заявка до подбора техники). */
  vehicleId: string | null;
  linear?: boolean;
}

interface SheetSpec {
  from: string;
  to?: string;
  vehicleId: string;
  personId: string;
  cancelled?: boolean;
}

interface Scene {
  userId: string;
  ivan: string;
  petr: string;
  /** Две собственные машины и одна арендная: принадлежность решает, чья бумага (Р4). */
  own: string;
  ownB: string;
  rental: string;
  makeRequest(spec: RequestSpec): Promise<string>;
  issueSheet(requestId: string, spec: SheetSpec): Promise<string>;
  setTerm(requestId: string, dateTo: string): Promise<void>;
}

/**
 * Заказ спецтехники, две собственные машины, одна арендная и два человека.
 *
 * Арендная берётся из парка, а не заводится: у арендной единицы CHECK требует арендодателя, цену и
 * пустые собственные графы, и собирать её вручную значило бы повторять в тесте половину правил
 * справочника.
 */
async function inScene<T>(run: (tx: SceneTx, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const org = await one(
        sql`SELECT id FROM organizations WHERE is_active ORDER BY name LIMIT 1`,
      );
      const series = await one(sql`SELECT id FROM waybill_series WHERE code = 'esm2'`);
      const ownRows = (
        await tx.execute<{ id: string; vehicle_type_id: string }>(sql`
          SELECT id, vehicle_type_id FROM vehicles
           WHERE ownership = 'own' AND deleted_at IS NULL ORDER BY id LIMIT 2`)
      ).rows;
      const [own, ownB] = ownRows;
      const rental = await one(sql`
        SELECT id, vehicle_type_id FROM vehicles
         WHERE ownership = 'rental' AND deleted_at IS NULL ORDER BY id LIMIT 1`);
      if (!own || !ownB) throw new Error('в парке меньше двух собственных машин: сцену не собрать');
      const kind = await one(sql`SELECT id FROM vehicle_kinds ORDER BY code LIMIT 1`);
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-ensure-${RUN}@example.invalid`}, 'Готовнов', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const person = (last: string) =>
        one(sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`);
      const ivan = await person('Машинистов');
      const petr = await person('Сменщиков');
      // Линейный тип заводится свой: в сиде линейных нет, а режим заявки читается по нему
      // (`is_linear_frozen` у заявки пуст, значит живой признак заказанного типа).
      const linearType = await one(sql`
        INSERT INTO vehicle_types (kind_id, code, name, waybill_form_code, is_linear)
        VALUES (${kind.id}, ${`ap_ensure_lin_${RUN}`}, 'Линейный (тест)', 'esm2', true)
        RETURNING id`);
      /** Номера листов внутри прогона: пара «серия + номер» уникальна и в откатываемой транзакции. */
      let sheetNumber = 900_000_000 + Math.floor(Math.random() * 90_000_000);

      const ownershipType = (vehicleId: string): string =>
        vehicleId === rental.id!
          ? rental.vehicle_type_id!
          : own.id === vehicleId
            ? own.vehicle_type_id
            : ownB.vehicle_type_id;

      const scene: Scene = {
        userId: user.id!,
        ivan: ivan.id!,
        petr: petr.id!,
        own: own.id,
        ownB: ownB.id,
        rental: rental.id!,
        async makeRequest(spec) {
          const request = await one(sql`
            INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status,
                                          created_by)
            VALUES ('special_equipment', ${obj.id},
                    ${spec.linear ? linearType.id : own.vehicle_type_id}, 'confirmed', ${user.id})
            RETURNING id`);
          await tx.execute(sql`
            INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
            VALUES (${request.id}, ${spec.dateFrom}, ${spec.dateTo ?? null})`);
          if (spec.vehicleId) {
            await tx.execute(sql`
              INSERT INTO vehicle_request_assignments
                (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
              VALUES (${request.id}, ${spec.vehicleId}, ${ownershipType(spec.vehicleId)},
                      ${spec.linear ? linearType.id : own.vehicle_type_id}, ${user.id})`);
          }
          return request.id!;
        },
        /*
         * ЭСМ2-РАЗРЕЗ. Умолчание `to` — воскресенье той же недели: лист-неделя. Оно оставлено, потому
         * что большинство сцен файла проверяют не разрез; сцены разреза передают `to` явно.
         *
         * Проверено здесь: изменения ложатся на **границы отрезков**, а не на начало срока и не на
         * начало недели, — правило «изменение там, где меняется значение шкалы» (§6 п. 2) от длины
         * листа не зависит. Аномалией остаётся совпадение `(period_from, vehicle_id)` и пересечение
         * периодов; два листа одной недели с разными началами — норма.
         */
        async issueSheet(requestId, spec) {
          sheetNumber += 1;
          const to = spec.to ?? sunday(spec.from);
          const row = await one(sql`
            INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                                  driver_person_id, issued_for_date, source_request_id,
                                  period_from, period_to, issued_by, cancelled_at, cancelled_by,
                                  cancel_reason)
            VALUES (${series.id}, ${sheetNumber}, 'esm2',
                    ${spec.cancelled ? 'cancelled' : 'issued'}, ${org.id}, ${spec.vehicleId},
                    ${spec.personId}, ${spec.from}, ${requestId}, ${spec.from}, ${to}, ${user.id},
                    ${spec.cancelled ? new Date() : null}, ${spec.cancelled ? user.id : null},
                    ${spec.cancelled ? 'испорчен при печати' : ''})
            RETURNING id`);
          return row.id!;
        },
        async setTerm(requestId, dateTo) {
          await tx.execute(sql`
            UPDATE special_equipment_request_details SET date_to = ${dateTo}
             WHERE request_id = ${requestId}`);
        },
      };

      out = await run(tx, scene);
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Действующие строки истории заявки — как их видит база, по возрастанию даты. */
async function rowsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      vehicle_id: string | null;
      driver_person_id: string | null;
      driver_state: string | null;
      origin: string;
      change_group_id: string;
      correction_id: string | null;
      created_by: string | null;
    }>(sql`
      SELECT id, effective_date::text AS effective_date, dimension, vehicle_id, driver_person_id,
             driver_state, origin, change_group_id, correction_id, created_by
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension DESC`)
  ).rows;
}

/** Колонки готовности заявки. */
async function readinessOf(tx: SceneTx, requestId: string) {
  const [row] = (
    await tx.execute<{ state: string; validated_on: string | null; dirty: boolean }>(sql`
      SELECT assignment_history_state AS state,
             assignment_history_validated_on::text AS validated_on,
             assignment_history_dirty AS dirty
        FROM vehicle_requests WHERE id = ${requestId}`)
  ).rows;
  return row!;
}

/** Короткая запись строки истории для сравнения: дата, шкала и значение. */
const shapeOf = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
  rows.map((row) => ({
    date: row.effective_date,
    dimension: row.dimension,
    value: row.vehicle_id ?? row.driver_state ?? null,
    person: row.driver_person_id,
  }));

const errorOf = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  throw new Error('ожидался отказ, а вызов прошёл');
};

// ── §6 «Бэкфилл»: восстановление по листам и назначению ──

describe('бэкфилл заявки без листов (§6 п. 4)', () => {
  it('пишет машину из назначения и `unknown` вместо машиниста', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      const rows = await rowsOf(tx, requestId);
      expect(shapeOf(rows)).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'unknown', person: null },
      ]);
      // Происхождение и автор — единственный способ отличить восстановленное от решённого
      // человеком: у бэкфилла автора нет, и приписывать его запустившему команду нельзя.
      expect(rows.every((row) => row.origin === 'backfill')).toBe(true);
      expect(rows.every((row) => row.created_by === null)).toBe(true);
      expect(rows.every((row) => row.correction_id === null)).toBe(true);
      // Пара «машина и её машинист» — одно решение и одна группа (Г2): отмена снимет их вместе.
      expect(rows[0]!.change_group_id).toBe(rows[1]!.change_group_id);
      // Собственная машина без человека на изменяемых днях — не готовность, а признание пробела.
      expect(result.state).toBe('materialized');
      if (result.state === 'empty') throw new Error('история не восстановлена');
      expect(result.blockers.every((blocker) => blocker.kind === 'unknown')).toBe(true);
      expect(result.blockers.every((blocker) => blocker.date >= TODAY)).toBe(true);
      expect(await readinessOf(tx, requestId)).toEqual({
        state: 'materialized',
        validated_on: TODAY,
        dirty: false,
      });
    });
  });

  it('арендной машине пишет `cleared`, и это готовность: бланк ведёт арендодатель', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.rental,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.rental, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'cleared', person: null },
      ]);
      // `cleared` — осознанное «машиниста нет», и бумаги портала на арендном отрезке не ожидается:
      // блокером он становится только у `portal`-отрезка (Р19, Р30).
      expect(result.state).toBe('ready');
    });
  });
});

describe('бэкфилл по листам (§6 п. 2)', () => {
  it('листы одной машины дают одно изменение на начало срока', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      // Вторая неделя того же состава изменения не заводит: изменение пишется там, где меняется
      // значение шкалы, а не на каждый лист.
      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'set', person: scene.ivan },
      ]);
      // Текущая неделя листа ещё не имеет, но человек последнего листа действует и на ней: конца у
      // изменения нет, его задаёт следующее изменение (Р1). Вперёд это законно — назад нет.
      expect(result.state).toBe('ready');
    });
  });

  it('смена машины ставит границу по первому листу нового значения', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.ownB,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.ownB,
        personId: scene.petr,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'set', person: scene.ivan },
        { date: WEEK_PREV, dimension: 'vehicle', value: scene.ownB, person: null },
        { date: WEEK_PREV, dimension: 'driver', value: 'set', person: scene.petr },
      ]);
      // Хвост истории сошёлся с назначением — предупреждать не о чем (Р30).
      expect(result.state).toBe('ready');
      if (result.state === 'empty') throw new Error('история не восстановлена');
      expect(result.warnings).toEqual([]);
    });
  });

  /*
   * ЭСМ2-РАЗРЕЗ. Одна календарная неделя, разрезанная дважды: три листа подряд, стыки день-в-день.
   * Внутри недели меняется и машина, и машинист — ровно то, ради чего фича делается.
   *
   * Проверяется, что изменения встают на **границы отрезков**: два vehicle-изменения там, где
   * меняется машина, и два driver-изменения там, где меняется человек, — а не одно на начало срока
   * и не по строке на каждый лист. До разреза такой сцены не бывало: неделя была одним листом.
   */
  it('неделя из трёх листов: изменения встают на границы отрезков', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const monday = WEEK_PREV;
      const wednesday = shiftDateKey(monday, 2);
      const friday = shiftDateKey(monday, 4);
      const requestId = await scene.makeRequest({
        dateFrom: monday,
        dateTo: sunday(monday),
        vehicleId: scene.ownB,
      });
      // Пн–вт: своя машина, Иван. Ср–чт: та же машина, Пётр. Пт–вс: другая машина, Пётр.
      await scene.issueSheet(requestId, {
        from: monday,
        to: shiftDateKey(monday, 1),
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: wednesday,
        to: shiftDateKey(monday, 3),
        vehicleId: scene.own,
        personId: scene.petr,
      });
      await scene.issueSheet(requestId, {
        from: friday,
        to: sunday(monday),
        vehicleId: scene.ownB,
        personId: scene.petr,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      /*
       * Четыре строки, а не шесть: машина не менялась между первым и вторым листом, человек — между
       * вторым и третьим. Изменение пишется там, где меняется значение шкалы, а не на каждой
       * границе бумаги.
       */
      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: monday, dimension: 'vehicle', value: scene.own, person: null },
        { date: monday, dimension: 'driver', value: 'set', person: scene.ivan },
        { date: wednesday, dimension: 'driver', value: 'set', person: scene.petr },
        { date: friday, dimension: 'vehicle', value: scene.ownB, person: null },
      ]);
      expect(result.state).toBe('ready');
      if (result.state === 'empty') throw new Error('история не восстановлена');
      expect(result.warnings).toEqual([]);
    });
  });

  it('аннулированный лист доказательством не считается', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_PREV),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.ownB,
        personId: scene.petr,
        cancelled: true,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      // Списанный бланк — диагностика, а не история: машина и человек берутся из действующего.
      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'set', person: scene.ivan },
      ]);
    });
  });
});

describe('начало срока раньше первого листа (§6 п. 3)', () => {
  it('машину берёт из назначения, а машиниста назад не тянет', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_PREV),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      const rows = await rowsOf(tx, requestId);
      expect(shapeOf(rows)).toEqual([
        // Голова срока: машина из назначения — лучшее доказательство того, чем работали.
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        // ...а человек — `unknown`: о первой неделе бумага молчит, и приписать ей Ивана значило бы
        // уверенно утверждать неизвестное (Р19).
        { date: WEEK_PREV2, dimension: 'driver', value: 'unknown', person: null },
        // Иван начинается ровно с даты своего первого листа.
        { date: WEEK_PREV, dimension: 'driver', value: 'set', person: scene.ivan },
      ]);
      // Второе vehicle-изменение не пишется: машина листа та же, что в назначении (Р12).
      expect(rows.filter((row) => row.dimension === 'vehicle')).toHaveLength(1);
      // Заблокированный `unknown` готовности не мешает: бумага тех дней выдана, человек в ней
      // напечатан, а история восстановлена приблизительно (Р16, Р19).
      expect(result.state).toBe('ready');
    });
  });
});

describe('линейная заявка (§6 п. 1, ADR 0100 §7)', () => {
  it('из листов не восстанавливается и машиниста не заводит вовсе', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
        linear: true,
      });
      // В неделе законно стоят два листа разных машин: у линейного заказа неделю на объекте
      // закрывают две единицы. Одной временной шкалы из этого не построить — и не строится.
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.ownB,
        personId: scene.petr,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
      ]);
      // Машиниста заявки у линейного заказа не существует вовсе (ADR 0100 §6): человека называют
      // при выписке каждого листа, и требовать его в истории значило бы придумывать решение,
      // которого никто не принимал.
      expect(result.state).toBe('ready');
    });
  });
});

describe('расхождение хвоста (§6 п. 5, Р30)', () => {
  it('за концом срока изменения не пишет, а расхождение отдаёт предупреждением', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_PREV),
        vehicleId: scene.ownB,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      // Свободного дня внутри срока не осталось: граница пришлась бы на `dateTo + 1`.
      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'set', person: scene.ivan },
      ]);
      // История с бумагой сходится, расходится лишь денормализация — это предупреждение, а не
      // блокер, и `ready` оно не мешает (Р30).
      expect(result.state).toBe('ready');
      if (result.state === 'empty') throw new Error('история не восстановлена');
      expect(result.warnings).toEqual([
        {
          kind: 'tail_vehicle_mismatch',
          historyVehicleId: scene.own,
          assignmentVehicleId: scene.ownB,
        },
      ]);
    });
  });

  it('внутри срока пишет границу и `unknown`: о тех днях бумага ещё молчит', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.ownB,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV2,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(shapeOf(await rowsOf(tx, requestId))).toEqual([
        { date: WEEK_PREV2, dimension: 'vehicle', value: scene.own, person: null },
        { date: WEEK_PREV2, dimension: 'driver', value: 'set', person: scene.ivan },
        { date: WEEK_NOW, dimension: 'vehicle', value: scene.ownB, person: null },
        // Машинист новой машины неизвестен: последний лист выписан на прежнюю, и тянуть Ивана на
        // машину B значило бы приписать ему дни, которых он на ней не работал.
        { date: WEEK_NOW, dimension: 'driver', value: 'unknown', person: null },
      ]);
      expect(result.state).toBe('materialized');
      if (result.state === 'empty') throw new Error('история не восстановлена');
      // Хвост истории теперь равен назначению — предупреждать не о чем.
      expect(result.warnings).toEqual([]);
      expect(result.blockers.every((blocker) => blocker.date >= WEEK_NOW)).toBe(true);
    });
  });
});

// ── Честный отказ: восстановить нечем ──

describe('заявки, которые бэкфилл восстанавливать отказывается', () => {
  it('без назначения не оставляет ни строк, ни состояния', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: null,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(result.state).toBe('empty');
      if (result.state !== 'empty') throw new Error('ожидался отказ восстановления');
      expect(result.unrestorable).toEqual([{ kind: 'no_assignment' }]);
      expect(await rowsOf(tx, requestId)).toEqual([]);
      // Состояние не поднимается: `empty` и пустой `validated_on` — это то, по чему заявку найдёт
      // массовый прогон и увидит человек.
      expect(await readinessOf(tx, requestId)).toEqual({
        state: 'empty',
        validated_on: null,
        dirty: false,
      });
    });
  });

  it('два листа одной недели на разных машинах — неоднозначность, а не догадка', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      const second = await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.ownB,
        personId: scene.petr,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(result.state).toBe('empty');
      if (result.state !== 'empty') throw new Error('ожидался отказ восстановления');
      const [reason] = result.unrestorable;
      expect(reason?.kind).toBe('ambiguous_sheets');
      expect(reason?.kind === 'ambiguous_sheets' && reason.waybillIds).toContain(second);
      expect(await rowsOf(tx, requestId)).toEqual([]);
      expect((await readinessOf(tx, requestId)).state).toBe('empty');
    });
  });

  it('пересечение периодов у нелинейной заявки — тот же отказ', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      // Лист понедельника–вторника и лист всей недели: начала разные, дни общие.
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        to: shiftDateKey(WEEK_PREV, 1),
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      await scene.issueSheet(requestId, {
        from: shiftDateKey(WEEK_PREV, 1),
        to: sunday(WEEK_PREV),
        vehicleId: scene.ownB,
        personId: scene.petr,
      });

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(result.state).toBe('empty');
      if (result.state !== 'empty') throw new Error('ожидался отказ восстановления');
      expect(result.unrestorable[0]?.kind).toBe('overlapping_sheets');
      expect(await rowsOf(tx, requestId)).toEqual([]);
    });
  });
});

// ── Р20: предпросмотр ничего не пишет ──

describe('предпросмотр (Р20)', () => {
  it('считает ту же историю и не оставляет в базе ничего', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });

      // Читающий прокси фазы расчёта — тот же, что каркас отдаёт двери на шагах 4–6.
      const planned = await ctx.ensure.planAssignmentHistory(ctx.command.readOnlyTx(tx), {
        requestId,
        asOf: TODAY,
      });

      expect(planned.mutations).toHaveLength(3);
      expect(await rowsOf(tx, requestId)).toEqual([]);
      expect((await readinessOf(tx, requestId)).state).toBe('empty');

      // ...а исполнение по тем же входам даёт ровно ту историю, которую показал предпросмотр.
      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      expect(await rowsOf(tx, requestId)).toHaveLength(3);
      expect(result.state).toBe(planned.state);
    });
  });

  it('запись под читающей транзакцией отказывает, даже когда писать было бы нечего', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      // Заявка уже готова: `ensure` не записала бы ни строки — и всё равно отказывает, иначе
      // ошибка двери всплыла бы через неделю на первой же неготовой заявке.
      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      const error = await errorOf(() =>
        ctx.ensure.ensureAssignmentHistory(ctx.command.readOnlyTx(tx), {
          requestId,
          asOf: TODAY,
        }),
      );

      expect(error.message).toContain('предпросмотр');
    });
  });
});

// ── Р26: состояние — поддерживаемый инвариант ──

describe('состояния готовности (Р26)', () => {
  it('повторный вызов ничего не пересобирает и не пишет', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await scene.issueSheet(requestId, {
        from: WEEK_PREV,
        vehicleId: scene.own,
        personId: scene.ivan,
      });
      const first = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      const before = await rowsOf(tx, requestId);

      const second = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      if (first.state === 'empty' || second.state === 'empty') throw new Error('нет истории');
      expect(second.materialized).toEqual([]);
      // Валидность свежая и состояние то же — колонку переписывать незачем.
      expect(second.revalidated).toBe(false);
      // Идентификаторы стабильны с первой материализации: ремонт правит историю обычными
      // командами, а не пересобирает её.
      expect((await rowsOf(tx, requestId)).map((row) => row.id)).toEqual(
        before.map((row) => row.id),
      );
    });
  });

  it('вчерашняя валидность пересчитывается, а строки остаются прежними', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      const before = await rowsOf(tx, requestId);
      const yesterday = shiftDateKey(TODAY, -1);
      await tx.execute(sql`
        UPDATE vehicle_requests SET assignment_history_validated_on = ${yesterday}
         WHERE id = ${requestId}`);

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      if (result.state === 'empty') throw new Error('нет истории');
      expect(result.revalidated).toBe(true);
      expect(result.materialized).toEqual([]);
      expect((await rowsOf(tx, requestId)).map((row) => row.id)).toEqual(
        before.map((row) => row.id),
      );
      expect((await readinessOf(tx, requestId)).validated_on).toBe(TODAY);
    });
  });

  it('метка `dirty` пересчитывает внутри дня и снимается тем же `UPDATE`', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      // Метку ставят двери, меняющие отменяемость бумаги внутри дня (К4): календарь про них молчит.
      await ctx.dirty.markAssignmentHistoryDirty(tx, requestId);
      expect((await readinessOf(tx, requestId)).dirty).toBe(true);

      const result = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      if (result.state === 'empty') throw new Error('нет истории');
      expect(result.revalidated).toBe(true);
      expect(result.materialized).toEqual([]);
      expect(await readinessOf(tx, requestId)).toEqual({
        state: 'materialized',
        validated_on: TODAY,
        dirty: false,
      });
    });
  });

  it('продление срока опускает `ready` до `materialized` — область валидности расширилась', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      // Срок целиком в прошлом: `unknown` заблокирован бумагой и готовности не мешает.
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_PREV),
        vehicleId: scene.own,
      });
      const first = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      expect(first.state).toBe('ready');

      // Продление ничего не меняет в самой истории: те же дни становятся изменяемыми, и последнее
      // изменение шкалы — `unknown` — накрывает их собой (З1, Ж1).
      await scene.setTerm(requestId, sunday(WEEK_NOW));
      const second = await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      expect(second.state).toBe('materialized');
      if (second.state === 'empty') throw new Error('нет истории');
      expect(second.materialized).toEqual([]);
      expect((await readinessOf(tx, requestId)).state).toBe('materialized');
    });
  });

  it('отменённую человеком строку бэкфилл не воскрешает', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const requestId = await scene.makeRequest({
        dateFrom: WEEK_PREV2,
        dateTo: sunday(WEEK_NOW),
        vehicleId: scene.own,
      });
      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });
      const [head] = await rowsOf(tx, requestId);
      // Отмена гасит всю группу: и машину, и её спутника-машиниста (В2).
      await ctx.write.applyAssignmentMutations(tx, {
        requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'keep' },
        mutations: [{ kind: 'cancel', target: { changeId: head!.id } }],
      });

      await ctx.ensure.ensureAssignmentHistory(tx, { requestId, asOf: TODAY });

      // Строк нет, но состояние у заявки уже не `empty` — и пересобирать историю поверх решения
      // человека нельзя: отмена записана на самой backfill-строке, и второй бэкфилл стёр бы её.
      expect(await rowsOf(tx, requestId)).toEqual([]);
    });
  });
});

// ── Границы применимости ──

describe('кому готовность не считается', () => {
  it('грузоперевозке истории не полагается вовсе', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const [freight] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
          SELECT 'freight_transport', co.id, vt.id, 'confirmed', ${scene.userId}
            FROM construction_objects co, vehicle_types vt
           WHERE vt.waybill_form_code = '4p' LIMIT 1
          RETURNING id`)
      ).rows;

      const error = await errorOf(() =>
        ctx.ensure.ensureAssignmentHistory(tx, { requestId: freight!.id, asOf: TODAY }),
      );

      expect(error.message).toContain('заказа спецтехники');
    });
  });

  it('несуществующая заявка — 404, а не молчаливая пустота', async () => {
    if (!DB_URL) return;
    await inScene(async (tx) => {
      const error = await errorOf(() =>
        ctx.ensure.ensureAssignmentHistory(tx, { requestId: randomUUID(), asOf: TODAY }),
      );
      expect(error.message).toContain('не найдена');
    });
  });
});
