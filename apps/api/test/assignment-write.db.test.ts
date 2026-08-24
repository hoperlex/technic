import { generateKeyPairSync } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentEffects from '../src/services/assignment-effects';
import type * as AssignmentWrite from '../src/services/assignment-write';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Каждая команда здесь берёт управляющую строку модуля `FOR SHARE` (шаг 0
 * канона), а соседние файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30). Прогон по
 * общей `TEST_DATABASE_URL` даёт падение, которое выглядит поломкой кода, а не гонкой файлов.
 */

/**
 * Ядро записи истории и каркас канонической транзакции
 * ([assignment-write.ts](../src/services/assignment-write.ts),
 * [assignment-command.ts](../src/services/assignment-command.ts); план `docs/assignment-periods-plan.md`,
 * Р3, Р9, Р10, Р17, Р30, §8).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Три предмета, и все три — про то, чего не видно в коде двери:
 *
 * 1. **правила неизменяемых строк (Р3)** — замена гасит прежнюю и ссылается на неё обратной
 *    ссылкой, цепочка не ветвится, отмена гасит **группу**, а порядок «гасим → вставляем» держит
 *    ядро, а не дисциплина вызывающего. Проверяется на живой схеме потому, что половину правил
 *    держат частичные UNIQUE и составной FK: на объектах в памяти проверялась бы выдумка о базе;
 * 2. **денормализация (Р17)** — четыре намерения двери и отказ на каждом расхождении. Это главная
 *    опасность dual-write: две записи об одном факте расходятся молча, а обнаруживается это через
 *    месяц по счёту арендодателя;
 * 3. **порядок §8** — что каркас делает сам и в каком месте: гейт, блокировки, повтор под
 *    блокировкой, отпечаток один раз, аудит **в транзакции**, версия **один раз**. Порядок
 *    доказывается не чтением кода, а откатом: команда, упавшая на шаге 12, не должна оставить ни
 *    строки истории, ни события, ни поднятой версии.
 *
 * ПОЧЕМУ СЦЕНА ЖИВЁТ В ОТКАТЫВАЕМОЙ ТРАНЗАКЦИИ, А КОМАНДА — В ЕЁ SAVEPOINT. База у db-тестов общая,
 * и оставленные заявка, учётка и человек испортили бы соседние файлы, половина которых берёт из
 * справочников «первую попавшуюся» запись. Каркас при этом обязан идти в **настоящей** транзакции —
 * иначе проверять откат было бы нечем, — поэтому исполнителем ему отдаётся вложенная транзакция
 * сцены: drizzle разворачивает её в `SAVEPOINT` и откатывает к нему при отказе.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_write \
 *     npx vitest run test/assignment-write.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

const TODAY = moscowDateKeyOf(new Date());
const PAST = shiftDateKey(TODAY, -5);
const FUTURE = shiftDateKey(TODAY, 5);
const TERM_FROM = shiftDateKey(TODAY, -10);
const TERM_TO = shiftDateKey(TODAY, 10);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  write: typeof AssignmentWrite;
  command: typeof AssignmentCommand;
  effects: typeof AssignmentEffects;
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
    write: await import('../src/services/assignment-write'),
    command: await import('../src/services/assignment-command'),
    effects: await import('../src/services/assignment-effects'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Сцена ──

interface Scene {
  requestId: string;
  otherRequestId: string;
  userId: string;
  vehicleA: string;
  vehicleAType: string;
  vehicleB: string;
  vehicleBType: string;
  personA: string;
  personB: string;
}

/** Транзакция сцены: та же, что уходит в ядро записи. Тип сужать незачем — файл её только носит. */
type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе, с назначением на машину A, второй заявкой-соседкой и двумя людьми.
 *
 * Соседка заведена не для полноты: групповое гашение обязано смотреть на `request_id`, а цели для
 * составного FK у группы нет — база одинаковый `change_group_id` у двух заявок примет. Без соседки
 * это правило проверить нечем.
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
      const vehicles = (
        await tx.execute<{ id: string; vehicle_type_id: string }>(
          sql`SELECT id, vehicle_type_id FROM vehicles WHERE deleted_at IS NULL ORDER BY id LIMIT 2`,
        )
      ).rows;
      const [vehicleA, vehicleB] = vehicles;
      if (!vehicleA || !vehicleB) throw new Error('в парке меньше двух машин: сцену не собрать');
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-write-${RUN}@example.invalid`}, 'Историев', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const person = (last: string) =>
        one(sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`);
      const personA = await person('Машинистов');
      const personB = await person('Сменщиков');

      const makeRequest = async (): Promise<string> => {
        const request = await one(sql`
          INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
          VALUES ('special_equipment', ${obj.id}, ${vehicleA.vehicle_type_id}, 'confirmed',
                  ${user.id})
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
          VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
        return request.id!;
      };
      const requestId = await makeRequest();
      const otherRequestId = await makeRequest();
      // Назначение — та самая денормализация, ответ на «чем заявка закрыта сейчас» (Р17).
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${requestId}, ${vehicleA.id}, ${vehicleA.vehicle_type_id},
                ${vehicleA.vehicle_type_id}, ${user.id})`);

      out = await run(tx, {
        requestId,
        otherRequestId,
        userId: user.id!,
        vehicleA: vehicleA.id,
        vehicleAType: vehicleA.vehicle_type_id,
        vehicleB: vehicleB.id,
        vehicleBType: vehicleB.vehicle_type_id,
        personA: personA.id!,
        personB: personB.id!,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Строки истории заявки как их видит база — включая погашенные. */
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
      supersedes_change_id: string | null;
      superseded_at: string | null;
      superseded_by_user: string | null;
      superseded_kind: string | null;
    }>(sql`
      SELECT * FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId}
       ORDER BY effective_date, created_at`)
  ).rows;
}

const errorOf = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  throw new Error('ожидался отказ, а команда прошла');
};

// ── Р3: строки неизменяемы ──

describe('правка изменения (Р3)', () => {
  it('гасит прежнюю строку и вставляет новую с обратной ссылкой', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const first = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'materialize' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: PAST,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
          },
        ],
      });

      await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'keep' },
        mutations: [
          {
            kind: 'replace',
            target: { changeId: first.inserted[0]!.id },
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personB } },
          },
        ],
      });

      const rows = await rowsOf(tx, scene.requestId);
      expect(rows).toHaveLength(2);
      const old = rows.find((r) => r.id === first.inserted[0]!.id)!;
      const fresh = rows.find((r) => r.id !== old.id)!;
      // Прежняя строка не переписана: изменилась только тройка погашения.
      expect(old.driver_person_id).toBe(scene.personA);
      expect(old.superseded_kind).toBe('replaced');
      expect(old.superseded_by_user).toBe(scene.userId);
      expect(old.superseded_at).not.toBeNull();
      // Новая ссылается назад — прямую ссылку «старая → новая» записать нечем ни в каком порядке.
      expect(fresh.supersedes_change_id).toBe(old.id);
      expect(fresh.driver_person_id).toBe(scene.personB);
      expect(fresh.superseded_at).toBeNull();
      // Шкала и дата у замены те же: их держит составной FK, а перенос — это `cancel` + `insert`.
      expect(fresh.effective_date).toBe(old.effective_date);
      expect(fresh.dimension).toBe('driver');
      // Замена продолжает то же решение, а не заводит новое: группа наследуется, и следующая
      // отмена снимет их вместе.
      expect(fresh.change_group_id).toBe(old.change_group_id);
    });
  });

  it('цепочка замен не ветвится: погашенная строка целью не бывает', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const first = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'materialize' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
          },
        ],
      });
      const target = { changeId: first.inserted[0]!.id };
      const replace = (personId: string) =>
        ctx.write.applyAssignmentMutations(tx, {
          requestId: scene.requestId,
          actorUserId: scene.userId,
          correctionId: null,
          denormalization: { kind: 'keep' },
          mutations: [
            {
              kind: 'replace',
              target,
              origin: 'machinist_change',
              value: { dimension: 'driver', driver: { state: 'set', personId } },
            },
          ],
        });
      await replace(scene.personB);

      // Вторая правка по той же цели — это ветка: она объявила бы заменённой уже заменённую строку,
      // и «что действует» перестало бы иметь один ответ.
      const failure = await errorOf(() => replace(scene.personA));
      expect(failure.message).toMatch(/заменено или отменено/);

      const rows = await rowsOf(tx, scene.requestId);
      expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
      // Наследница у погашенной строки ровно одна — это же держит частичный UNIQUE по ссылке.
      expect(rows.filter((r) => r.supersedes_change_id === first.inserted[0]!.id)).toHaveLength(1);
    });
  });
});

describe('отмена изменения (Р3, В2)', () => {
  it('гасит всю группу решения и не трогает соседей', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      // Решение одного человека: машина уходит в аренду, и её спутник снимает машиниста (Р16).
      const decision = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'materialize' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'reassignment',
            group: 'решение',
            value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
          },
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'reassignment',
            group: 'решение',
            value: { dimension: 'driver', driver: { state: 'cleared' } },
          },
          {
            kind: 'insert',
            effectiveDate: PAST,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
          },
        ],
      });
      const [vehicleRow, clearedRow, independent] = decision.inserted;
      expect(vehicleRow!.changeGroupId).toBe(clearedRow!.changeGroupId);
      expect(independent!.changeGroupId).not.toBe(vehicleRow!.changeGroupId);

      // Строка соседней заявки с тем же групповым ключом: цели для составного FK у группы нет, и
      // принадлежность обязан проверить сервис. Ключ берётся у одиночного изменения — глобальный
      // индекс «одна актуальная строка на (группу, шкалу)» держит только вторую строку той же
      // шкалы, а вот две заявки в одной группе он не различает вовсе.
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignment_changes
          (request_id, effective_date, dimension, vehicle_id, origin, change_group_id)
        VALUES (${scene.otherRequestId}, ${FUTURE}, 'vehicle', ${scene.vehicleB}, 'assignment',
                ${independent!.changeGroupId})`);

      // Отменяем, назвав только vehicle-строку: спутник обязан погаснуть вместе с ней, иначе он
      // оживёт при следующем продлении срока и оставит собственный отрезок без машиниста.
      const cancelled = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'keep' },
        mutations: [{ kind: 'cancel', target: { changeId: vehicleRow!.id } }],
      });
      expect(cancelled.cancelledGroups).toEqual([vehicleRow!.changeGroupId]);
      expect(cancelled.inserted).toHaveLength(0);

      const rows = await rowsOf(tx, scene.requestId);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(vehicleRow!.id)!.superseded_kind).toBe('cancelled');
      expect(byId.get(clearedRow!.id)!.superseded_kind).toBe('cancelled');
      // Отмена — не замена: наследницы у погашенных строк нет.
      expect(rows.every((r) => r.supersedes_change_id === null)).toBe(true);
      // Чужая шкала того же дня не тронута.
      expect(byId.get(independent!.id)!.superseded_at).toBeNull();

      // И наконец главное: отмена одиночного изменения гасит только свою заявку, хотя группа у неё
      // общая с соседкой. Без условия по `request_id` соседка погасла бы заодно — и заметить это
      // можно было бы только по бумаге.
      await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'keep' },
        mutations: [{ kind: 'cancel', target: { changeId: independent!.id } }],
      });
      const neighbour = await rowsOf(tx, scene.otherRequestId);
      expect(neighbour).toHaveLength(1);
      expect(neighbour[0]!.superseded_at).toBeNull();
    });
  });

  it('порядок «гасим → вставляем» держит ядро, а не список двери', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const first = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'materialize' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
          },
        ],
      });

      // Перенос решения (Р13) выражается парой `cancel` + `insert`, и дверь перечисляет их в
      // «естественном» порядке — сначала новое. Частичный UNIQUE на (заявка, шкала, дата) отверг бы
      // такую вставку, если бы ядро шло по списку.
      const moved = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'keep' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personB } },
          },
          { kind: 'cancel', target: { changeId: first.inserted[0]!.id } },
        ],
      });

      expect(moved.inserted).toHaveLength(1);
      const rows = await rowsOf(tx, scene.requestId);
      const actual = rows.filter((r) => r.superseded_at === null);
      expect(actual).toHaveLength(1);
      expect(actual[0]!.driver_person_id).toBe(scene.personB);
      // Новая строка отмену не «наследует»: это другое решение, и группа у него своя.
      expect(actual[0]!.change_group_id).not.toBe(
        rows.find((r) => r.superseded_at)!.change_group_id,
      );
    });
  });

  it('гашение без автора не проходит: отмена решения всегда чья-то', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const first = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: null,
        correctionId: null,
        denormalization: { kind: 'materialize' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: PAST,
            origin: 'backfill',
            value: { dimension: 'driver', driver: { state: 'unknown' } },
          },
        ],
      });
      // Бэкфилл вставляет без автора — так и записано в схеме: у восстановленной по бумаге истории
      // автора нет. Но погасить строку без автора нельзя.
      expect(first.inserted[0]!.createdBy).toBeNull();

      const failure = await errorOf(() =>
        ctx.write.applyAssignmentMutations(tx, {
          requestId: scene.requestId,
          actorUserId: null,
          correctionId: null,
          denormalization: { kind: 'keep' },
          mutations: [{ kind: 'cancel', target: { changeId: first.inserted[0]!.id } }],
        }),
      );
      expect(failure.message).toMatch(/без автора/);
    });
  });
});

// ── Р17: денормализация ──

describe('денормализация (Р17)', () => {
  /** Записать историю и сразу проверить обещание — так же, как это делает каркас в конце шага 11. */
  const applyAndCheck = async (
    tx: SceneTx,
    scene: Scene,
    intent: AssignmentWrite.AssignmentDenormalizationIntent,
    mutations: AssignmentWrite.AssignmentWriteMutation[],
  ): Promise<void> => {
    const result = await ctx.write.applyAssignmentMutations(tx, {
      requestId: scene.requestId,
      actorUserId: scene.userId,
      correctionId: null,
      denormalization: intent,
      mutations,
    });
    await ctx.write.assertAssignmentDenormalization(tx, result.denormalization);
  };

  const materializeHistory = (tx: SceneTx, scene: Scene, vehicleId: string, date: string) =>
    applyAndCheck(tx, scene, { kind: 'materialize' }, [
      {
        kind: 'insert',
        effectiveDate: date,
        origin: 'backfill',
        value: { dimension: 'vehicle', vehicleId },
      },
    ]);

  it('историческая правка назначения не касается — и это проверяется', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      await materializeHistory(tx, scene, scene.vehicleA, TERM_FROM);
      // Мартовская машина действует дальше; правка января её не двигает.
      await applyAndCheck(tx, scene, { kind: 'materialize' }, [
        {
          kind: 'insert',
          effectiveDate: TODAY,
          origin: 'backfill',
          value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
        },
      ]);
      await applyAndCheck(tx, scene, { kind: 'keep' }, [
        {
          kind: 'replace',
          target: { dimension: 'vehicle', effectiveDate: TERM_FROM },
          origin: 'reassignment',
          value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
        },
      ]);
    });
  });

  it('сдвинув хвост, команда обязана перевести назначение — иначе отказ', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      await materializeHistory(tx, scene, scene.vehicleA, TERM_FROM);
      const failure = await errorOf(() =>
        applyAndCheck(tx, scene, { kind: 'keep' }, [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'reassignment',
            value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
          },
        ]),
      );
      expect(failure.message).toMatch(/не переведя назначение/);
    });
  });

  it('`follow` требует, чтобы назначение показывало хвост истории', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      await materializeHistory(tx, scene, scene.vehicleA, TERM_FROM);

      // Дверь обещала перевести назначение, но не перевела: расхождение поймано до коммита.
      const failure = await errorOf(() =>
        applyAndCheck(tx, scene, { kind: 'follow' }, [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'reassignment',
            value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
          },
        ]),
      );
      expect(failure.message).toMatch(/разошлись/);
    });
  });

  it('`follow` проходит, когда дверь перевела назначение своим полным путём', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      await materializeHistory(tx, scene, scene.vehicleA, TERM_FROM);
      const result = await ctx.write.applyAssignmentMutations(tx, {
        requestId: scene.requestId,
        actorUserId: scene.userId,
        correctionId: null,
        denormalization: { kind: 'follow' },
        mutations: [
          {
            kind: 'insert',
            effectiveDate: FUTURE,
            origin: 'reassignment',
            value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
          },
        ],
      });
      // Полный путь со ставками и правилами аренды остаётся у двери — здесь он изображён прямым
      // `UPDATE`: ядру важно, что назначение и история сошлись, а не кто их свёл.
      await tx.execute(sql`
        UPDATE vehicle_request_assignments
           SET vehicle_id = ${scene.vehicleB}, vehicle_type_id = ${scene.vehicleBType}
         WHERE request_id = ${scene.requestId}`);
      await ctx.write.assertAssignmentDenormalization(tx, result.denormalization);
    });
  });

  it('`assignment_wins` пишет границу машиной назначения и назначения не трогает', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      await materializeHistory(tx, scene, scene.vehicleB, TERM_FROM);
      const tailDate = shiftDateKey(TERM_TO, 1);

      // Дремлющая граница со «своей» машиной — не решение хвоста, а плановая смена машины в обход
      // Р7: значение обязано равняться текущему назначению, и другое ядро не принимает. Неудачная
      // попытка идёт своей вложенной транзакцией: отказ обязан её откатить, иначе следующая,
      // правильная, упёрлась бы в строку, которой не должно было остаться.
      const failure = await errorOf(() =>
        tx.transaction((sp) =>
          applyAndCheck(sp as SceneTx, scene, { kind: 'tail_assignment_wins' }, [
            {
              kind: 'insert',
              effectiveDate: tailDate,
              origin: 'tail_resolution',
              value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
            },
          ]),
        ),
      );
      expect(failure.message).toMatch(/не равна машине назначения/);

      await applyAndCheck(tx, scene, { kind: 'tail_assignment_wins' }, [
        {
          kind: 'insert',
          effectiveDate: tailDate,
          origin: 'tail_resolution',
          value: { dimension: 'vehicle', vehicleId: scene.vehicleA },
        },
      ]);
      const assignment = (
        await tx.execute<{ vehicle_id: string }>(
          sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`,
        )
      ).rows[0]!;
      expect(assignment.vehicle_id).toBe(scene.vehicleA);
    });
  });

  it('материализация терпит расхождение хвоста — это предупреждение, а не блокер (Р30)', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      // Бэкфилл по бумаге: последний лист был на машине B, а назначение показывает A. Ремонта это
      // не требует — история с бумагой сходятся, расходится лишь денормализация.
      await materializeHistory(tx, scene, scene.vehicleB, TERM_FROM);
      const assignment = (
        await tx.execute<{ vehicle_id: string }>(
          sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`,
        )
      ).rows[0]!;
      expect(assignment.vehicle_id).toBe(scene.vehicleA);
    });
  });
});

// ── §8: канонический порядок ──

describe('каркас канонической транзакции (§8)', () => {
  interface DoorOptions {
    version?: number;
    mutations?: AssignmentWrite.AssignmentWriteMutation[];
    effectMutations?: AssignmentEffects.AssignmentMutation[];
    operation?: { operationId: string; reason: string } | null;
    previewFingerprint?: string;
    onPlan?: (ctx: AssignmentCommand.AssignmentPlanContext) => Promise<void> | void;
    syncPaper?: () => Promise<void>;
    body?: unknown;
    seen?: { scope?: unknown; steps: string[] };
  }

  /**
   * Дверь-пустышка: настоящих предметных правил у неё нет, но места канона она занимает все — по
   * ней и видно, что каркас зовёт их в объявленном порядке.
   */
  const door = (
    scene: Scene,
    options: DoorOptions = {},
  ): AssignmentCommand.AssignmentCommandSpec<null, AssignmentWrite.AssignmentWriteResult, void> => {
    const steps = options.seen?.steps ?? [];
    return {
      door: 'history',
      journalDoor: 'assignment-changes',
      requestId: scene.requestId,
      actor: { id: scene.userId },
      expectedVersion: options.version ?? 0,
      body: options.body ?? { kind: 'set', driverPersonId: scene.personA },
      operation: options.operation ?? null,
      previewFingerprint: options.previewFingerprint ?? 'fp',
      asOf: TODAY,
      plan: async (planCtx) => {
        steps.push('plan');
        await options.onPlan?.(planCtx);
        const changes = await ctx.write.readAssignmentChanges(planCtx.tx, scene.requestId, {
          actualOnly: true,
        });
        return {
          effects: ctx.effects.assignmentCommandEffects({
            changes,
            term: planCtx.request.term,
            asOf: planCtx.asOf,
            mutations: options.effectMutations ?? [],
          }),
          fingerprint: 'fp',
          plan: null,
        };
      },
      handshake: () => {
        steps.push('handshake');
      },
      authorize: () => {
        steps.push('authorize');
        return {
          schemaVersion: 1,
          requiresCorrect: true,
          requiresCorrectBeyondLimit: false,
          requiresArchiveRestore: false,
          effectiveDate: PAST,
          authorizedAsOf: TODAY,
        };
      },
      authorizeRepeat: (scope) => {
        steps.push('authorizeRepeat');
        if (options.seen) options.seen.scope = scope;
      },
      mutate: async (applyCtx) => {
        steps.push('mutate');
        const write = await ctx.write.applyAssignmentMutations(applyCtx.tx, {
          requestId: scene.requestId,
          actorUserId: scene.userId,
          correctionId: applyCtx.operation?.id ?? null,
          denormalization: { kind: 'keep' },
          mutations: options.mutations ?? [],
        });
        return { write, applied: write };
      },
      syncPaper: async () => {
        steps.push('syncPaper');
        await options.syncPaper?.();
      },
      audit: () => {
        steps.push('audit');
        return { action: 'vehicle_request.assignment_change', metadata: { probe: RUN } };
      },
    };
  };

  /** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
  const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
    ({
      transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
    }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

  const versionOf = async (tx: SceneTx, requestId: string): Promise<number> =>
    Number(
      (
        await tx.execute<{ version: string }>(
          sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
        )
      ).rows[0]!.version,
    );

  const auditCount = async (tx: SceneTx): Promise<number> =>
    Number(
      (
        await tx.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM audit_log
               WHERE action = 'vehicle_request.assignment_change'
                 AND metadata->>'probe' = ${RUN}`,
        )
      ).rows[0]!.n,
    );

  it('проходит шаги в объявленном порядке, поднимает версию один раз и пишет аудит', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const seen = { steps: [] as string[] };
      const outcome = await ctx.command.runAssignmentCommand(
        executorOf(tx),
        door(scene, {
          seen,
          mutations: [
            {
              kind: 'insert',
              effectiveDate: FUTURE,
              origin: 'machinist_change',
              value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
            },
          ],
          effectMutations: [
            {
              kind: 'insert',
              dimension: 'driver',
              effectiveDate: FUTURE,
              origin: 'machinist_change',
            },
          ],
        }),
      );

      expect(seen.steps).toEqual([
        'plan',
        'handshake',
        'authorize',
        'mutate',
        'syncPaper',
        'audit',
      ]);
      expect(outcome.repeated).toBe(false);
      // Исход `none` журнала не заводит: у плановой смены машиниста причины нет и быть не должно.
      expect(outcome.operation).toBeNull();
      expect(outcome.effects?.operationOutcome).toBe('none');
      // Версия — ровно один инкремент, и он принадлежит шагу 14.
      expect(outcome.version).toBe(1);
      expect(await versionOf(tx, scene.requestId)).toBe(1);
      expect(await auditCount(tx)).toBe(1);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(1);
    });
  });

  it('исход с журналом заводит операцию со снимком авторизации и связью с заявкой', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const operationId = randomUUID();
      const outcome = await ctx.command.runAssignmentCommand(
        executorOf(tx),
        door(scene, {
          operation: { operationId, reason: 'Машинист был другой — восстанавливаем по табелю' },
          mutations: [
            {
              kind: 'insert',
              effectiveDate: PAST,
              origin: 'machinist_change',
              value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
            },
          ],
          effectMutations: [
            {
              kind: 'insert',
              dimension: 'driver',
              effectiveDate: PAST,
              origin: 'machinist_change',
            },
          ],
        }),
      );

      expect(outcome.effects?.operationOutcome).toBe('crew');
      expect(outcome.operation?.kind).toBe('crew');
      const [row] = (
        await tx.execute<{
          id: string;
          kind: string;
          authorization_scope: { schemaVersion: number } | null;
          payload: { effects?: { paperRange?: unknown[] } } | null;
          fingerprint: string;
        }>(sql`SELECT id, kind, authorization_scope, payload, fingerprint
                 FROM waybill_corrections WHERE operation_id = ${operationId}`)
      ).rows;
      // Снимок требований обязателен у новых видов — иначе повтор проверять нечем (Р9).
      expect(row!.authorization_scope?.schemaVersion).toBe(1);
      // Диапазоны Р11 каркас кладёт в снимок сам: забытый снимок обнаружился бы через месяцы.
      expect(row!.payload?.effects?.paperRange).toBeDefined();
      const links = (
        await tx.execute<{ n: string }>(sql`
          SELECT count(*) AS n FROM vehicle_request_corrections
           WHERE correction_id = ${row!.id} AND request_id = ${scene.requestId}`)
      ).rows[0]!;
      expect(Number(links.n)).toBe(1);
    });
  });

  it('повтор по ключу операции ничего не делает и версии не трогает', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const operationId = randomUUID();
      const operation = { operationId, reason: 'Повтор после обрыва связи' };
      const mutations: AssignmentWrite.AssignmentWriteMutation[] = [
        {
          kind: 'insert',
          effectiveDate: PAST,
          origin: 'machinist_change',
          value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
        },
      ];
      const effectMutations: AssignmentEffects.AssignmentMutation[] = [
        { kind: 'insert', dimension: 'driver', effectiveDate: PAST, origin: 'machinist_change' },
      ];
      await ctx.command.runAssignmentCommand(
        executorOf(tx),
        door(scene, { operation, mutations, effectMutations }),
      );

      const seen = { steps: [] as string[] };
      const repeat = await ctx.command.runAssignmentCommand(
        executorOf(tx),
        // Версия в теле — прежняя: повтор приходит тем же запросом, что и первая попытка, и
        // поиск операции обязан стоять ДО проверки версии, иначе retry получил бы 409.
        door(scene, { operation, mutations, effectMutations, seen }),
      );

      expect(repeat.repeated).toBe(true);
      expect(repeat.applied).toBeNull();
      // Ни планирования, ни мутаций — только перепроверка прав по сохранённому снимку.
      expect(seen.steps).toEqual(['authorizeRepeat']);
      expect((seen.scope as { requiresCorrect: boolean }).requiresCorrect).toBe(true);
      expect(await versionOf(tx, scene.requestId)).toBe(1);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(1);
    });
  });

  it('чужой ключ и переиспользованный ключ — 409, а не чужой результат', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const operation = { operationId: randomUUID(), reason: 'Первая команда' };
      const mutations: AssignmentWrite.AssignmentWriteMutation[] = [
        {
          kind: 'insert',
          effectiveDate: PAST,
          origin: 'machinist_change',
          value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
        },
      ];
      const effectMutations: AssignmentEffects.AssignmentMutation[] = [
        { kind: 'insert', dimension: 'driver', effectiveDate: PAST, origin: 'machinist_change' },
      ];
      await ctx.command.runAssignmentCommand(
        executorOf(tx),
        door(scene, { operation, mutations, effectMutations }),
      );

      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(
          executorOf(tx),
          door(scene, {
            operation,
            mutations,
            effectMutations,
            body: { kind: 'set', driverPersonId: scene.personB },
          }),
        ),
      );
      expect((failure as { statusCode?: number }).statusCode).toBe(409);
    });
  });

  it('фаза расчёта ничего не записывает', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(
          executorOf(tx),
          door(scene, {
            onPlan: async (planCtx) => {
              await planCtx.tx
                .insert((await import('../src/db/schema')).vehicleRequestAssignmentChanges)
                .values({
                  requestId: scene.requestId,
                  effectiveDate: FUTURE,
                  dimension: 'vehicle',
                  vehicleId: scene.vehicleB,
                  origin: 'reassignment',
                });
            },
          }),
        ),
      );
      expect(failure.message).toMatch(/фаза расчёта ничего не записывает/);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
    });
  });

  it('устаревший отпечаток предпросмотра — 409 до всякой записи', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(
          executorOf(tx),
          door(scene, {
            previewFingerprint: 'вчерашний',
            mutations: [
              {
                kind: 'insert',
                effectiveDate: FUTURE,
                origin: 'machinist_change',
                value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
              },
            ],
            effectMutations: [
              {
                kind: 'insert',
                dimension: 'driver',
                effectiveDate: FUTURE,
                origin: 'machinist_change',
              },
            ],
          }),
        ),
      );
      expect((failure as { statusCode?: number }).statusCode).toBe(409);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });

  it('отказ на шаге 12 откатывает всё — историю, аудит, операцию и версию', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const operationId = randomUUID();
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(
          executorOf(tx),
          door(scene, {
            operation: { operationId, reason: 'Коррекция, которая не сошлась с бумагой' },
            mutations: [
              {
                kind: 'insert',
                effectiveDate: PAST,
                origin: 'machinist_change',
                value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
              },
            ],
            effectMutations: [
              {
                kind: 'insert',
                dimension: 'driver',
                effectiveDate: PAST,
                origin: 'machinist_change',
              },
            ],
            syncPaper: async () => {
              throw new Error('постусловие по paperScope не сошлось');
            },
          }),
        ),
      );
      expect(failure.message).toMatch(/paperScope/);
      // Аудит транзакционен (шаг 13): у отката событий не остаётся — ни одного, ни половины.
      expect(await auditCount(tx)).toBe(0);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
      const operations = (
        await tx.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM waybill_corrections WHERE operation_id = ${operationId}`,
        )
      ).rows[0]!;
      expect(Number(operations.n)).toBe(0);
    });
  });

  it('обещание Р17 проверяет каркас, а не дверь: расхождение откатывает команду', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      // Дверь-пустышка объявляет себя исторической (`keep`), а вставляет vehicle-изменение в
      // будущее — то есть двигает хвост и обязана была перевести назначение. Сама она этого не
      // проверяет вовсе: проверка стоит в конце шага 11 у каркаса.
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(
          executorOf(tx),
          door(scene, {
            mutations: [
              {
                kind: 'insert',
                effectiveDate: FUTURE,
                origin: 'reassignment',
                value: { dimension: 'vehicle', vehicleId: scene.vehicleB },
              },
            ],
            effectMutations: [
              {
                kind: 'insert',
                dimension: 'vehicle',
                effectiveDate: FUTURE,
                origin: 'reassignment',
              },
            ],
          }),
        ),
      );
      expect(failure.message).toMatch(/не переведя назначение/);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });

  it('разошедшаяся версия заявки — 409 до расчёта', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const seen = { steps: [] as string[] };
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(executorOf(tx), door(scene, { version: 7, seen })),
      );
      expect((failure as { statusCode?: number }).statusCode).toBe(409);
      expect(seen.steps).toEqual([]);
    });
  });

  it('предпросмотр считает то же самое и не пишет ничего — даже при закрытой двери', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      const spec = door(scene, {
        mutations: [
          {
            kind: 'insert',
            effectiveDate: PAST,
            origin: 'machinist_change',
            value: { dimension: 'driver', driver: { state: 'set', personId: scene.personA } },
          },
        ],
        effectMutations: [
          { kind: 'insert', dimension: 'driver', effectiveDate: PAST, origin: 'machinist_change' },
        ],
      });

      // Дверь закрыта на запись — предпросмотр обязан всё равно ответить: «модуль закрыт» человек
      // услышит при попытке применить, а не вместо ответа на вопрос «что будет».
      await tx.execute(
        sql`UPDATE assignment_periods_control SET write_mode = 'all_frozen' WHERE id = true`,
      );
      const preview = await ctx.command.previewAssignmentCommand(executorOf(tx), spec);

      expect(preview.effects.operationOutcome).toBe('crew');
      expect(preview.request.term).toEqual({ dateFrom: TERM_FROM, dateTo: TERM_TO });
      expect(preview.asOf).toBe(TODAY);
      // Предпросмотр вызывается дважды подряд (двухфазность Р16) — и оба раза не пишет.
      await ctx.command.previewAssignmentCommand(executorOf(tx), spec);
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
      expect(await auditCount(tx)).toBe(0);
    });
  });

  it('закрытый режим не пускает дверь истории дальше шага 0', async () => {
    if (!DB_URL) return;
    await inScene(async (tx, scene) => {
      // Строка одна на базу, и меняется она здесь внутри откатываемой транзакции сцены: соседние
      // файлы её такой не увидят.
      await tx.execute(
        sql`UPDATE assignment_periods_control SET write_mode = 'history_frozen' WHERE id = true`,
      );
      const seen = { steps: [] as string[] };
      const failure = await errorOf(() =>
        ctx.command.runAssignmentCommand(executorOf(tx), door(scene, { seen })),
      );
      expect((failure as { statusCode?: number }).statusCode).toBe(503);
      expect(seen.steps).toEqual([]);
    });
  });
});
