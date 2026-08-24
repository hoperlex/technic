import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as Backstop from '../src/services/assignment-backstop';
import type * as Esm2 from '../src/services/waybill-esm2';
import type * as Period from '../src/services/vehicle-request-period';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, И ОН ЕЁ ЗАВОДИТ САМ. Половина случаев здесь переводит управляющую строку
 * модуля в `read_mode = history`, а соседние файлы читают её же и ждут `legacy`. Раньше это стояло
 * тут просьбой к запускающему — и просьбу нарушал любой, кто запускал набор одной командой.
 * Теперь база выводится из `TEST_DATABASE_URL` и создаётся механикой
 * ([assignment-read-mode.ts](assignment-read-mode.ts)), а не договорённостью.
 */

/**
 * Бэкстоп чужих дверей и его фаза
 * ([assignment-backstop.ts](../src/services/assignment-backstop.ts); план
 * `docs/assignment-periods-plan.md`, Р21, Р22, Р31, фазирование Ж5).
 *
 * ПРЕДМЕТ. Не форма запроса, а **одно и то же положение дел под двумя режимами**: заказ, у которого
 * история назначения не знает машиниста (`unknown` — то, что оставляет бэкфилл там, где восстановить
 * человека нечем), а бумага при этом ведётся исправно — легаси берёт машиниста с последнего листа.
 * Пока `read_mode = legacy`, дверь правки срока обязана **сработать** и оставить теневую улику;
 * после переключения чтения та же дверь на том же заказе обязана **отказать** и не записать ничего.
 *
 * ПОЧЕМУ ФАЙЛ ИДЁТ ДВУМЯ ПРОГОНАМИ (подэтап 4b, У1). Раньше два режима стояли двумя случаями, и
 * каждый переключал строку сам, внутри своей сцены. Разница между ними тонула в том, что сцены
 * тоже были разные: чтобы увидеть расхождение, приходилось читать оба случая целиком и сверять их
 * глазами. Теперь режим — параметр блока, а не шаг случая: сцена, вызов и порядок одни и те же в
 * обоих прогонах, и различаются ровно ожидания (`byReadMode`). Заодно исчезает возможность
 * написать половину набора: обе половины требуются типом.
 *
 * ЗАЧЕМ БАЗА. Сцепка здесь ровно та, которой нет в памяти: строки истории с их частичными UNIQUE
 * (миграция `0166`), выписанные листы ЭСМ-2 с расходом номеров, управляющая строка режима с её
 * `CHECK`-ами и FK на поколение сверки (миграция `0167`) и журнал `audit_log`, куда уходит
 * диагностика. Ни одну из четырёх не подменить объектом.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА ФИКСИРОВАН. Изменяемая область (Р21) считается по `asOf`, и прогон, взявший
 * «сегодня» из часов, менял бы смысл случаев в зависимости от дня недели.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-backstop.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/**
 * Своя база и режим на ней — одной строкой. Стоит до собственного `beforeAll` файла намеренно:
 * механика регистрирует свой хук первым и потому успевает выставить `DATABASE_URL` до того, как
 * файл импортирует клиента.
 */
const readMode = useReadModeDatabase('backstop');

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

// ── Календарь сцены ──

const MONDAY = weekStartKey(moscowDateKeyOf(new Date()));
/** День расчёта — среда текущей недели: есть и отработанная неделя, и текущая, и предстоящая. */
const AS_OF = shiftDateKey(MONDAY, 2);
const PREV = shiftDateKey(MONDAY, -7);
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
const TERM_TO = shiftDateKey(NEXT, 6);
/** Куда продлевают: ещё одна неделя вперёд. */
const EXTENDED_TO = shiftDateKey(TERM_TO, 7);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  backstop: typeof Backstop;
  period: typeof Period;
  esm2: typeof Esm2;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и база готовы хуком механики — остаётся забрать клиента и сервисы.
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    backstop: await import('../src/services/assignment-backstop'),
    period: await import('../src/services/vehicle-request-period'),
    esm2: await import('../src/services/waybill-esm2'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Сцена ──

interface SceneOptions {
  /** Что знает история о машинисте с начала срока. */
  driver: 'unknown' | 'named';
  /** Расхождение хвоста (Р31): с понедельника история ведёт вторую машину, назначение — первую. */
  tailMismatch?: boolean;
}

interface Scene {
  requestId: string;
  userId: string;
  vehicleA: string;
  vehicleB: string;
  personA: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе: собственная машина на весь срок, бумага выписана на все три недели,
 * история материализована.
 *
 * Бумага выписывается **расчётом от начала срока**: иначе прошедшая неделя листа не получила бы
 * вовсе, и `lastMachinistOf` не нашёл бы человека — сверка отказала бы «укажите машиниста» ещё до
 * того, как до неё дошёл бы бэкстоп, и предмет случая подменился бы.
 */
async function inScene<T>(
  options: SceneOptions,
  run: (tx: SceneTx, scene: Scene) => Promise<T>,
): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const fleet = (
        await tx.execute<{ id: string; vehicle_type_id: string }>(
          sql`SELECT id, vehicle_type_id FROM vehicles
               WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 2`,
        )
      ).rows;
      const [vehicleA, vehicleB] = fleet;
      if (!vehicleA || !vehicleB) throw new Error('в парке меньше двух своих машин');
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-backstop-${RUN}@example.invalid`}, 'Бэкстопов', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Человек без действующей специализации водителя в лист не попадает вовсе (`findMachinist`).
      const person = await one(
        sql`INSERT INTO persons (last_name, first_name) VALUES ('Машинистов', 'Пров') RETURNING id`,
      );
      await tx.execute(sql`
        INSERT INTO person_specializations (person_id, specialization_id, started_on)
        VALUES (${person.id}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);

      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicleA.vehicle_type_id}, 'confirmed',
                ${user.id}, 'materialized', ${AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${vehicleA.id}, ${vehicleA.vehicle_type_id},
                ${vehicleA.vehicle_type_id}, ${user.id})`);

      // История, какой её оставил бы бэкфилл: машина с начала срока и то, что известно о человеке.
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'vehicle',
        vehicleId: vehicleA.id,
        origin: 'assignment',
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'driver',
        ...(options.driver === 'unknown'
          ? { driverState: 'unknown', origin: 'backfill' }
          : { driverState: 'set', driverPersonId: person.id, origin: 'assignment' }),
      });
      if (options.tailMismatch) {
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: MONDAY,
          dimension: 'vehicle',
          vehicleId: vehicleB.id,
          origin: 'reassignment',
        });
      }

      await ctx.esm2.syncEsm2Waybills(tx, {
        requestId: request.id!,
        actor: { id: user.id! },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: person.id,
        asOf: TERM_FROM,
      });

      ctx.backstop.resetAssignmentBackstopCounters();
      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicleA.id,
        vehicleB: vehicleB.id,
        personA: person.id!,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

async function insertChange(
  tx: SceneTx,
  row: {
    requestId: string;
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverPersonId?: string;
    driverState?: string;
    origin: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${randomUUID()})`);
}

/** Записанный последний день срока — им проверяется «не записано ничего». */
async function dateToOf(tx: SceneTx, requestId: string): Promise<string | null> {
  const [row] = (
    await tx.execute<{ date_to: string }>(
      sql`SELECT date_to::text AS date_to FROM special_equipment_request_details
           WHERE request_id = ${requestId}`,
    )
  ).rows;
  return row?.date_to ?? null;
}

/** Строки теневой диагностики по заказу — то, ради чего расчёт вообще ведётся в `legacy`. */
async function shadowRows(
  tx: SceneTx,
  requestId: string,
): Promise<{ metadata: Record<string, unknown> }[]> {
  return (
    await tx.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
       WHERE action = 'assignment.backstop_shadow'
         AND entity_type = 'vehicle_request'
         AND entity_id = ${requestId}
       ORDER BY created_at`)
  ).rows;
}

/** Продлить срок в базе и позвать общие последствия — ровно то, что делает `PATCH /:id`. */
async function extendAndSync(tx: SceneTx, scene: Scene): Promise<Period.WorkPeriodChangeResult> {
  await tx.execute(sql`
    UPDATE special_equipment_request_details SET date_to = ${EXTENDED_TO}
     WHERE request_id = ${scene.requestId}`);
  return ctx.period.afterWorkPeriodChanged(tx, {
    requestId: scene.requestId,
    actor: { id: scene.userId },
    reason: 'Срок работ изменён правкой заявки — путевые листы переоформлены',
    dropPendingEarlyEnd: true,
    backstop: 'work_period',
  });
}

/**
 * Фаза бэкстопа (Ж5): одно и то же положение дел, один и тот же вызов — и два разных исхода.
 *
 * Оба прогона верны, и оба обязательны. `legacy` — сегодняшний прод: чтение ещё из назначения,
 * останавливать работу бэкстопу нельзя, и всё, что он имеет право сделать, — оставить улику.
 * `history` — мир после этапа 5: та же неполная история уже читается как источник истины, и та же
 * дверь на том же заказе обязана отказать, не записав ничего.
 */
describeReadModes(
  readMode,
  'бэкстоп чужих дверей: правка срока при неизвестном машинисте',
  (mode) => {
    it('дверь либо срабатывает с уликой, либо отказывает и не пишет ничего', async () => {
      await inScene({ driver: 'unknown' }, async (tx, scene) => {
        /*
         * Ожидания названы до вызова и обе половины сразу: так видно, что расходится именно исход, а
         * не сцена. `outcome` — что дверь обязана сделать; `paper` — сколько после неё бумаги;
         * `shadow` — сколько теневых строк; `counters`/`refusals` — какой из двух счётчиков процесса
         * шевельнулся.
         */
        const expected = byReadMode(mode, {
          legacy: {
            outcome: 'proceeds' as const,
            dateTo: EXTENDED_TO,
            shadowRows: 1,
            counters: [{ door: 'work_period' as const, count: 1 }],
            refusals: [],
          },
          history: {
            outcome: 'refuses' as const,
            dateTo: TERM_TO,
            shadowRows: 0,
            counters: [],
            refusals: [{ door: 'work_period' as const, count: 1 }],
          },
        });

        /*
         * Вызов один на оба прогона, и вложенная транзакция тоже: настоящий `SAVEPOINT` нужен
         * отказу — только по нему видно, что он не оставил ни нового срока, ни бумаги (Р31), — а
         * успеху он не мешает, потому что снятый савпоинт виден снаружи как обычная запись.
         */
        const call = await tx
          .transaction(async (inner) => extendAndSync(inner as unknown as SceneTx, scene))
          .then((result) => ({ result, failure: null }))
          .catch((e: unknown) => ({
            result: null,
            failure: e as {
              statusCode?: number;
              code?: string;
              message: string;
              details?: unknown;
            },
          }));

        if (expected.outcome === 'proceeds') {
          // Дверь **сработала**: новая неделя срока получила лист. Это и есть смысл фазы `legacy` —
          // до переключения чтения бэкстоп не имеет права остановить работу (Ж5, Е2).
          expect(call.failure).toBeNull();
          expect(call.result!.esm2.issued.length).toBeGreaterThan(0);
        } else {
          expect(call.failure?.statusCode).toBe(422);
          expect(call.failure?.code).toBe(ctx.backstop.ASSIGNMENT_BACKSTOP_CODE);
          // Отказ обязан называть не только беду, но и дверь, которая её чинит (Р22): правка срока
          // машиниста не назначает — это дело команды «Сменить машиниста».
          expect(call.failure?.message).toContain('Сменить машиниста');
          expect(call.failure?.message).toContain('машиниста не назначает');
          const details = call.failure?.details as Backstop.AssignmentBackstopDetails;
          expect(details.door).toBe('work_period');
          expect(details.requests[0]?.requiredAnchors[0]).toMatchObject({
            effectiveDate: TERM_FROM,
          });
        }

        // Дальше — общий хвост: три вопроса одинаковые, ответы на них разные. Записан ли срок,
        // осталась ли улика и какой счётчик шевельнулся — по ним и видно разницу режимов без чтения
        // ветвей выше.
        expect(await dateToOf(tx, scene.requestId)).toBe(expected.dateTo);
        const rows = await shadowRows(tx, scene.requestId);
        expect(rows).toHaveLength(expected.shadowRows);
        if (rows[0]) {
          const metadata = rows[0].metadata as {
            door: string;
            readMode: string;
            requiredAnchors: { effectiveDate: string; from: string; to: string }[];
          };
          expect(metadata.door).toBe('work_period');
          // Режим записывается вместе с событием: без него строка через месяц читалась бы как
          // «отказ, который кто-то обошёл».
          expect(metadata.readMode).toBe(mode);
          expect(metadata.requiredAnchors).toHaveLength(1);
          expect(metadata.requiredAnchors[0]).toMatchObject({ effectiveDate: TERM_FROM });
        }
        // Счётчики процесса — второй адрес диагностики: по ним ненулевую тень и ненулевой отказ
        // видно метриками `technic_assignment_backstop_shadow` и `…_refused`, без запроса в базу.
        expect(ctx.backstop.assignmentBackstopCounters()).toEqual(expected.counters);
        expect(ctx.backstop.assignmentBackstopRefusals()).toEqual(expected.refusals);
      });
    });

    it('полная история: ни отказа, ни теневой записи — обычная работа не дорожает ни в одном режиме', async () => {
      await inScene({ driver: 'named' }, async (tx, scene) => {
        // Здесь ожидания как раз НЕ расходятся, и это тоже результат: цена бэкстопа платится только
        // за неполную историю. Прогон в обоих режимах — единственный способ это утверждать.
        const result = await extendAndSync(tx, scene);
        expect(result.esm2.issued.length).toBeGreaterThan(0);
        expect(await shadowRows(tx, scene.requestId)).toHaveLength(0);
        expect(ctx.backstop.assignmentBackstopCounters()).toEqual([]);
        expect(ctx.backstop.assignmentBackstopRefusals()).toEqual([]);
      });
    });
  },
);

/**
 * Вердикт бэкстопа — расчёт, и режима он не знает вовсе: `evaluateAssignmentBackstop` считает, что
 * дверь обязана спросить, а решает, отказывать ли, `recordAssignmentBackstop` — уже по режиму.
 * Поэтому случаи ниже идут одним прогоном: второй проверял бы ту же арифметику дважды.
 */
describe.skipIf(!readMode.enabled)('вердикты бэкстопа: расчёт, не зависящий от режима', () => {
  it('заказ, не ведущий недельной бумаги, бэкстоп не трогает вовсе (Р21 п. 2)', async () => {
    await inScene({ driver: 'unknown' }, async (tx, scene) => {
      // Пробел в истории тот же самый, а вот бланка у заказа вне работы не будет ни одного —
      // значит и выписать его «не на того» невозможно. Такие пробелы чинит своя дверь и в своё
      // время; чужую они не касаются, иначе первый же новый заказ поднимал бы ложную тревогу.
      await tx.execute(
        sql`UPDATE vehicle_requests SET status = 'new' WHERE id = ${scene.requestId}`,
      );
      const verdict = await ctx.backstop.evaluateAssignmentBackstop(tx, {
        door: 'request_status',
        requestId: scene.requestId,
        asOf: AS_OF,
      });
      expect(verdict).toBeNull();
    });
  });

  it('расхождение хвоста спрашивают только двери, расширяющие срок (Р30, Р31)', async () => {
    await inScene({ driver: 'named', tailMismatch: true }, async (tx, scene) => {
      // Недельная операция открывает новые дни — на них хвост истории и оживает, поэтому Р31
      // требует решения именно у неё.
      const weekly = await ctx.backstop.evaluateAssignmentBackstop(tx, {
        door: 'weekly_apply',
        requestId: scene.requestId,
        asOf: AS_OF,
        prospectiveDateTo: EXTENDED_TO,
      });
      expect(weekly?.requiredAnchors).toEqual([]);
      expect(weekly?.requiredVehicleResolution).toMatchObject({
        tailVehicleId: scene.vehicleB,
        assignmentVehicleId: scene.vehicleA,
        since: shiftDateKey(TERM_TO, 1),
      });

      // Смена статуса новых дней не открывает: расхождение бумаге не мешает (Р30), и запирать им
      // работу значило бы требовать решения ради состояния, которое ни на что не влияет.
      const status = await ctx.backstop.evaluateAssignmentBackstop(tx, {
        door: 'request_status',
        requestId: scene.requestId,
        asOf: AS_OF,
      });
      expect(status).toBeNull();
    });
  });
});
