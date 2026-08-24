import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';

/*
 * Файлу нужна СВОЯ база: он проверяет управляющую строку в том виде, в каком её завела миграция, а
 * `assignment-mode.db.test.ts` эту же строку меняет. Запущенные параллельно по одной
 * `TEST_DATABASE_URL`, они мешают друг другу — падение выглядит поломкой схемы, хотя это гонка.
 */

/**
 * Физические инварианты истории назначения и управляющего контура модуля
 * (план `docs/assignment-periods-plan.md`, §6; миграции `0166` и `0167`).
 *
 * Проверяется не поведение сервера — его на этих таблицах пока нет вовсе, — а то, что **база не
 * примет** невозможного. Порядок здесь обратный обычному: схема уехала раньше кода, и до этапа 3
 * единственное, что охраняет модель, это её собственные ограничения. Разойдись они с задуманным —
 * первые же двери начнут писать историю, которой не бывает, и узнается это не на ревью, а на
 * бумаге: `unknown` с названным человеком, две действующие строки на одну дату, отмена заполнения,
 * превращающая известного машиниста в «мы не знаем».
 *
 * Особое внимание — паре строк заполнения `unknown` (Щ1, Э3, Ю2): её вставка требует ослабления
 * группового индекса, а всякое ослабление проверяется с двух сторон. Поэтому здесь и то, что
 * законная пара **ложится**, и то, что через послабление не пролезает чужая строка.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-periods-schema.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: учётка сцены живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

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
  ctx = { db, closeDb };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

/** Что заведено в транзакции сценария: всё, на что ссылаются строки истории. */
interface Scene {
  requestId: string;
  vehicleId: string;
  personId: string;
  otherPersonId: string;
  correctionId: string;
  userId: string;
}

/**
 * Собирает заявку с машиной, двумя людьми и операцией журнала коррекций.
 *
 * Транзакция **всегда откатывается**: база у db-тестов общая, и оставленные за собой учётка,
 * заявка и человек испортили бы соседние файлы, половина которых берёт из справочников «первую
 * попавшуюся» запись.
 */
async function inScene<T>(run: (tx: never, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<{ id: string }> => {
        const [row] = (await tx.execute<{ id: string }>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vt = await one(sql`SELECT id FROM vehicle_types LIMIT 1`);
      const veh = await one(sql`SELECT id FROM vehicles LIMIT 1`);
      // Учётка своя: в чистой базе `users` пуста — её наполняет не миграция, а регистрация.
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-schema-${RUN}@example.invalid`}, 'Схемов', 'Пров', 'x', 'observer', false)
        RETURNING id`);
      const person = async (last: string) =>
        one(sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`);
      const p1 = await person('Машинистов');
      const p2 = await person('Сменщиков');
      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
        VALUES ('freight_transport', ${obj.id}, ${vt.id}, 'confirmed', ${user.id}) RETURNING id`);
      await tx.execute(sql`INSERT INTO freight_transport_request_details (request_id, scheduled_at)
                           VALUES (${request.id}, now())`);
      const correction = await one(sql`
        INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id)
        VALUES (gen_random_uuid(), 'ap-schema', 'esm2', 'проверка схемы', ${user.id})
        RETURNING id`);

      out = await run(tx as never, {
        requestId: request.id,
        vehicleId: veh.id,
        personId: p1.id,
        otherPersonId: p2.id,
        correctionId: correction.id,
        userId: user.id,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Отказ базы: код `SQLSTATE` и имя нарушенного ограничения; `null` — запись прошла. */
interface Refusal {
  code: string;
  constraint: string;
}

/**
 * Ответ базы на попытку записи.
 *
 * Имя ограничения проверяется наравне с кодом: у этой таблицы девять `CHECK`'ов, и половина
 * невозможных строк нарушает сразу два. Сравнивай тест один код `23514` — он проходил бы, отказывай
 * база по другой причине, чем названо в заголовке, и снятое послабление осталось бы незамеченным.
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
  const name = `probe_${(savepoint += 1)}`;
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

/** Строка истории: все колонки, которые задаёт сценарий, — остальные берут умолчания схемы. */
interface Change {
  requestId: string;
  day: number;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string | null;
  personId?: string | null;
  driverState?: 'set' | 'cleared' | 'unknown' | null;
  origin: string;
  groupId?: string | null;
  correctionId?: string | null;
  id?: string | null;
  supersedesId?: string | null;
  /** Погашение задаётся тройкой; `user` — кем. Отдельно проверяется, что тройку не разорвать. */
  superseded?: { user: string; kind: 'replaced' | 'cancelled' } | null;
  /** Разорванное погашение: только метка времени, без автора и вида. */
  supersededAtOnly?: boolean;
}

function insertChange(c: Change) {
  return sql`
    INSERT INTO vehicle_request_assignment_changes
      (id, request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
       origin, change_group_id, correction_id, supersedes_change_id,
       superseded_at, superseded_by_user, superseded_kind)
    VALUES (
      coalesce(${c.id ?? null}::uuid, gen_random_uuid()),
      ${c.requestId}::uuid,
      CURRENT_DATE + ${c.day}::int,
      ${c.dimension},
      ${c.vehicleId ?? null}::uuid,
      ${c.personId ?? null}::uuid,
      ${c.driverState ?? null},
      ${c.origin},
      coalesce(${c.groupId ?? null}::uuid, gen_random_uuid()),
      ${c.correctionId ?? null}::uuid,
      ${c.supersedesId ?? null}::uuid,
      ${c.superseded || c.supersededAtOnly ? sql`now()` : sql`NULL`},
      ${c.superseded?.user ?? null}::uuid,
      ${c.superseded?.kind ?? null})`;
}

describe.skipIf(!DB_URL)('состав строки истории задаёт шкала', () => {
  it('изменение техники и изменение машиниста ложатся', async () => {
    const [vehicle, driver] = await inScene(async (tx, s) => [
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 800,
          dimension: 'vehicle',
          vehicleId: s.vehicleId,
          origin: 'assignment',
        }),
      ),
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 800,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'assignment',
        }),
      ),
    ]);

    expect(vehicle).toBeNull();
    // Шкалы независимы: изменение машины и изменение машиниста на одну дату — обычное дело.
    expect(driver).toBeNull();
  });

  /** У vehicle-строки человека нет: за него отвечает своя шкала, и два ответа разошлись бы. */
  it('изменение техники с машинистом — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 801,
          dimension: 'vehicle',
          vehicleId: s.vehicleId,
          personId: s.personId,
          origin: 'assignment',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_value_check',
    });
  });

  /** `set` без человека — это не «назначен», а пустое утверждение. */
  it('назначенный машинист без человека — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 802,
          dimension: 'driver',
          driverState: 'set',
          origin: 'machinist_change',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_value_check',
    });
  });

  /**
   * Четвёртое сочетание, которого не существует: «не знаем, но человек назван». Именно оно
   * превратило бы `unknown` из признания неполноты в мнение — а вся ценность состояния в том, что
   * оно отличает «не знаем» от «знаем».
   */
  it('`unknown` с названным человеком — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 803,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'unknown',
          origin: 'backfill',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_value_check',
    });
  });
});

describe.skipIf(!DB_URL)('`unknown` заводит только бэкфилл и остаток заполнения', () => {
  it('бэкфилл пишет `unknown` без коррекции', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 810,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'backfill',
        }),
      ),
    );

    expect(code).toBeNull();
  });

  /** Человек `unknown` не заводит никогда: он либо называет машиниста, либо снимает его (Р19). */
  it('смена машиниста в `unknown` — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 811,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'machinist_change',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_unknown_check',
    });
  });

  /**
   * Обратная сторона того же CHECK'а: у бэкфилла коррекции нет по построению — он восстанавливает
   * историю по бумаге, а не правит её задним числом.
   */
  it('бэкфилл с коррекцией — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 812,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'backfill',
          correctionId: s.correctionId,
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_unknown_check',
    });
  });

  /**
   * Граница заполнения рождается внутри коррекции и без автора появиться не может (Ш4).
   *
   * Эту строку отвергают оба CHECK'а сразу — и `unknown_check` («остаток обязан нести коррекцию»),
   * и `remainder_check` («origin остатка означает `unknown` с коррекцией»). Перекрытие намеренное:
   * они смотрят с разных сторон, а какое имя вернёт база, решает порядок её проверок. Тест
   * называет то, что база проверяет первым, — важно, что строка не проходит.
   */
  it('остаток заполнения без коррекции — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 813,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'unknown_remainder',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_remainder_check',
    });
  });
});

describe.skipIf(!DB_URL)('origin остатка не надевается на чужую строку (Щ3)', () => {
  /**
   * Обратное направление CHECK'а. Оно не косметика: групповой индекс ослаблен **по этому origin**,
   * и `set`, надевший его, проскользнул бы мимо счёта строк в группе — то есть послабление ради
   * заполнения стало бы дырой.
   */
  it('назначенный машинист с origin остатка — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 820,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_remainder_check',
    });
  });

  it('изменение техники с origin остатка — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 821,
          dimension: 'vehicle',
          vehicleId: s.vehicleId,
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_remainder_check',
    });
  });
});

describe.skipIf(!DB_URL)('провенанс заполнения (Ю2)', () => {
  /**
   * `known_fill` — не украшение журнала: по составу строк группу заполнения не отличить от обычной
   * исторической смены машиниста, и отмена «по составу» превратила бы известного человека обратно
   * в `unknown`. Поэтому у заполнения свой origin и такой же двусторонний CHECK, как у остатка.
   */
  it('заполнение без человека — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 830,
          dimension: 'driver',
          driverState: 'cleared',
          origin: 'known_fill',
          correctionId: s.correctionId,
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_known_fill_check',
    });
  });

  /** Заполнение — всегда операция журнала: без коррекции у него нет ни автора, ни обоснования. */
  it('заполнение без коррекции — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 831,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'known_fill',
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_known_fill_check',
    });
  });
});

describe.skipIf(!DB_URL)('группа рождена одним решением', () => {
  /**
   * Главная вставка волны (Щ1): заполнение `unknown` — это ДВЕ driver-строки одной группы, `set` на
   * начале отрезка и граница `unknown` за его концом. Прежний групповой индекс допускал по одной
   * актуальной строке на шкалу и отказал бы второй вставке unique-нарушением — то есть команда
   * заполнения не работала бы вовсе.
   */
  it('заполнение и его граница ложатся одной группой', async () => {
    const [fill, remainder] = await inScene(async (tx, s) => {
      const groupId = (
        await (tx as never as { execute: (typeof AppDb)['execute'] }).execute<{ id: string }>(
          sql`SELECT gen_random_uuid() AS id`,
        )
      ).rows[0]!.id;
      return [
        await refusal(
          tx,
          insertChange({
            requestId: s.requestId,
            day: 840,
            dimension: 'driver',
            personId: s.personId,
            driverState: 'set',
            origin: 'known_fill',
            correctionId: s.correctionId,
            groupId,
          }),
        ),
        await refusal(
          tx,
          insertChange({
            requestId: s.requestId,
            day: 850,
            dimension: 'driver',
            driverState: 'unknown',
            origin: 'unknown_remainder',
            correctionId: s.correctionId,
            groupId,
          }),
        ),
      ];
    });

    expect(fill).toBeNull();
    expect(remainder).toBeNull();
  });

  /**
   * Послабление узкое: две актуальные driver-строки в группе допустимы только тогда, когда вторая
   * — граница заполнения. Обычная пара строк одной шкалы в одной группе означала бы, что «одно
   * решение» распалось на два, и групповое гашение оставило бы половину.
   */
  it('две обычные строки одной шкалы в группе — отказ UNIQUE', async () => {
    const code = await inScene(async (tx, s) => {
      const groupId = (
        await (tx as never as { execute: (typeof AppDb)['execute'] }).execute<{ id: string }>(
          sql`SELECT gen_random_uuid() AS id`,
        )
      ).rows[0]!.id;
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 860,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          groupId,
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 861,
          dimension: 'driver',
          personId: s.otherPersonId,
          driverState: 'set',
          origin: 'machinist_change',
          groupId,
        }),
      );
    });

    expect(code).toEqual({
      code: '23505',
      constraint: 'vehicle_request_assignment_changes_group_dimension_unique',
    });
  });

  /** Исключённые из счёта строки не остаются вовсе без счёта (Э3): остаток один на группу. */
  it('два действующих остатка в одной группе — отказ UNIQUE', async () => {
    const code = await inScene(async (tx, s) => {
      const groupId = (
        await (tx as never as { execute: (typeof AppDb)['execute'] }).execute<{ id: string }>(
          sql`SELECT gen_random_uuid() AS id`,
        )
      ).rows[0]!.id;
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 870,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
          groupId,
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 871,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
          groupId,
        }),
      );
    });

    expect(code).toEqual({
      code: '23505',
      constraint: 'vehicle_request_assignment_changes_group_remainder_unique',
    });
  });

  /** Погашенная строка счёта не занимает: отмена гасит прежнюю границу до вставки новой. */
  it('погашенный остаток уступает место новому', async () => {
    const code = await inScene(async (tx, s) => {
      const groupId = (
        await (tx as never as { execute: (typeof AppDb)['execute'] }).execute<{ id: string }>(
          sql`SELECT gen_random_uuid() AS id`,
        )
      ).rows[0]!.id;
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 880,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
          groupId,
          superseded: { user: s.userId, kind: 'cancelled' },
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 881,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'unknown_remainder',
          correctionId: s.correctionId,
          groupId,
        }),
      );
    });

    expect(code).toBeNull();
  });
});

describe.skipIf(!DB_URL)('одна действующая строка на шкалу и дату', () => {
  /**
   * Главный инвариант модели: свёртка читает «последнюю строку не позже даты», и две актуальные
   * строки на одну дату дали бы два ответа на вопрос, на который бумага отвечает однозначно.
   */
  it('две действующие строки одной шкалы на одну дату — отказ UNIQUE', async () => {
    const code = await inScene(async (tx, s) => {
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 890,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 890,
          dimension: 'driver',
          personId: s.otherPersonId,
          driverState: 'set',
          origin: 'machinist_change',
        }),
      );
    });

    expect(code).toEqual({
      code: '23505',
      constraint: 'vehicle_request_assignment_changes_actual_unique',
    });
  });

  /**
   * Порядок правки — «погасить прежнюю, вставить новую» — обязан проходить без отложенных
   * ограничений: к моменту вставки частичный UNIQUE уже свободен.
   */
  it('погашенная строка не мешает новой на ту же дату', async () => {
    const code = await inScene(async (tx, s) => {
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 891,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          superseded: { user: s.userId, kind: 'replaced' },
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 891,
          dimension: 'driver',
          personId: s.otherPersonId,
          driverState: 'set',
          origin: 'machinist_change',
        }),
      );
    });

    expect(code).toBeNull();
  });

  /** Погашение — неразрывная тройка: когда, кем и как. Половина не отвечает ни на один вопрос. */
  it('погашение без автора — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 892,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          supersededAtOnly: true,
        }),
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_supersede_check',
    });
  });
});

describe.skipIf(!DB_URL)('замена привязана к той же заявке, шкале и дате', () => {
  /** Строка не объявляет заменённой соседнюю шкалу: составной FK не находит такой цели. */
  it('замена строки другой шкалы — отказ целостности', async () => {
    const code = await inScene(async (tx, s) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const [target] = (
        await runner.execute<{ id: string }>(sql`
          INSERT INTO vehicle_request_assignment_changes
            (request_id, effective_date, dimension, vehicle_id, origin)
          VALUES (${s.requestId}, CURRENT_DATE + 900, 'vehicle', ${s.vehicleId}, 'assignment')
          RETURNING id`)
      ).rows;
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 900,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          supersedesId: target!.id,
        }),
      );
    });

    expect(code).toEqual({
      code: '23503',
      constraint: 'vehicle_request_assignment_changes_supersedes_fk',
    });
  });

  /** Замена достаётся ровно одной наследнице: иначе цепочка ветвится и «что действует» теряется. */
  it('две наследницы у одной строки — отказ UNIQUE', async () => {
    const code = await inScene(async (tx, s) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const [target] = (
        await runner.execute<{ id: string }>(sql`
          INSERT INTO vehicle_request_assignment_changes
            (request_id, effective_date, dimension, driver_person_id, driver_state, origin,
             superseded_at, superseded_by_user, superseded_kind)
          VALUES (${s.requestId}, CURRENT_DATE + 901, 'driver', ${s.personId}, 'set',
                  'machinist_change', now(), ${s.userId}, 'replaced')
          RETURNING id`)
      ).rows;
      await refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 901,
          dimension: 'driver',
          personId: s.otherPersonId,
          driverState: 'set',
          origin: 'machinist_change',
          supersedesId: target!.id,
          superseded: { user: s.userId, kind: 'replaced' },
        }),
      );
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 901,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          supersedesId: target!.id,
        }),
      );
    });

    expect(code).toEqual({
      code: '23505',
      constraint: 'vehicle_request_assignment_changes_supersedes_unique',
    });
  });

  /** Цикл длины один составной FK не ловит — он смотрит на существование цели, а цель есть. */
  it('строка, заменяющая саму себя, — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const id = (await runner.execute<{ id: string }>(sql`SELECT gen_random_uuid() AS id`))
        .rows[0]!.id;
      return refusal(
        tx,
        insertChange({
          requestId: s.requestId,
          day: 902,
          dimension: 'driver',
          personId: s.personId,
          driverState: 'set',
          origin: 'machinist_change',
          id,
          supersedesId: id,
        }),
      );
    });

    expect(code).toEqual({
      code: '23514',
      constraint: 'vehicle_request_assignment_changes_self_check',
    });
  });
});

describe.skipIf(!DB_URL)('готовность истории у заявки', () => {
  /**
   * `empty` тогда и только тогда, когда дня расчёта нет. Ограничение добавлено `NOT VALID` — старые
   * строки оно не проверяло, — но новые и правку проверяет с первой же секунды, и проверить это
   * важнее: писать состояние начнёт этап 3, а сегодняшние строки удовлетворяют условию по
   * построению.
   */
  it('готовность без дня расчёта — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        sql`UPDATE vehicle_requests SET assignment_history_state = 'ready'
             WHERE id = ${s.requestId}`,
      ),
    );

    expect(code).toEqual({ code: '23514', constraint: 'vehicle_requests_history_state_check' });
  });

  it('готовность с днём расчёта ложится', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        sql`UPDATE vehicle_requests
               SET assignment_history_state = 'ready',
                   assignment_history_validated_on = CURRENT_DATE,
                   assignment_history_dirty = true
             WHERE id = ${s.requestId}`,
      ),
    );

    expect(code).toBeNull();
  });

  /** Умолчания: заявка заводится без истории, и это ровно `empty` + пусто + не загрязнена. */
  it('новая заявка заводится пустой историей', async () => {
    const row = await inScene(async (tx, s) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const res = await runner.execute<{
        assignment_history_state: string;
        assignment_history_validated_on: string | null;
        assignment_history_dirty: boolean;
      }>(sql`SELECT assignment_history_state, assignment_history_validated_on,
                    assignment_history_dirty
               FROM vehicle_requests WHERE id = ${s.requestId}`);
      return res.rows[0]!;
    });

    expect(row.assignment_history_state).toBe('empty');
    expect(row.assignment_history_validated_on).toBeNull();
    expect(row.assignment_history_dirty).toBe(false);
  });
});

describe.skipIf(!DB_URL)('управляющая строка модуля', () => {
  /**
   * Без строки `SELECT ... FOR SHARE` не блокирует ничего, а `UPDATE` обновляет ноль строк — и
   * freeze считался бы пройденным (И3). Поэтому удаление запрещено безусловно, а не правами: роли
   * `technic_app` в репозитории нет, миграции ходят тем же `DATABASE_URL`, а владельцу таблицы
   * `REVOKE` не помеха (Л4).
   */
  it('удаление управляющей строки не проходит', async () => {
    const code = await inScene(async (tx) =>
      refusal(tx, sql`DELETE FROM assignment_periods_control`),
    );

    expect(code?.code).toBe('P0001');
  });

  it('вторая управляющая строка не заводится', async () => {
    const code = await inScene(async (tx) =>
      refusal(tx, sql`INSERT INTO assignment_periods_control (id) VALUES (true)`),
    );

    expect(code?.code).toBe('23505');
  });

  it('строка заведена миграцией и лежит в исходном режиме', async () => {
    const row = await inScene(async (tx) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const res = await runner.execute<{
        write_mode: string;
        read_mode: string;
        lock_tick: number;
      }>(sql`SELECT write_mode, read_mode, lock_tick FROM assignment_periods_control`);
      return res.rows[0]!;
    });

    expect(row).toMatchObject({ write_mode: 'normal', read_mode: 'legacy', lock_tick: 0 });
  });

  /** История без поколения не включается: иначе переключение нечем обосновать постфактум (М1). */
  it('чтение истории без поколения — отказ CHECK', async () => {
    const code = await inScene(async (tx) =>
      refusal(tx, sql`UPDATE assignment_periods_control SET read_mode = 'history'`),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'assignment_periods_control_cutover_check',
    });
  });
});

describe.skipIf(!DB_URL)('поколения теневого сравнения и журнал переходов', () => {
  /** Завершённое поколение обязано иметь время конца, работающее — не иметь. */
  it('завершённое поколение без времени конца — отказ CHECK', async () => {
    const code = await inScene(async (tx) =>
      refusal(
        tx,
        sql`INSERT INTO assignment_shadow_runs
              (status, as_of, algo_version, build_version, expected_checks)
            VALUES ('completed', CURRENT_DATE, 'v1', 'sha', 10)`,
      ),
    );

    expect(code).toEqual({ code: '23514', constraint: 'assignment_shadow_runs_finish_check' });
  });

  /**
   * Результат одной строкой (К2): «проверено» без отпечатка означало бы поколение, которое
   * выглядит зелёным, не сравнив ничего.
   */
  it('совпадение без отпечатка — отказ CHECK', async () => {
    const code = await inScene(async (tx) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const [run] = (
        await runner.execute<{ run_id: string }>(sql`
          INSERT INTO assignment_shadow_runs
            (status, as_of, algo_version, build_version, expected_checks)
          VALUES ('running', CURRENT_DATE, 'v1', 'sha', 1)
          RETURNING run_id`)
      ).rows;
      return refusal(
        tx,
        sql`INSERT INTO assignment_shadow_checks
              (run_id, request_id, scope_fingerprint, status, checked_at)
            VALUES (${run!.run_id}, gen_random_uuid(), 'scope', 'match', now())`,
      );
    });

    expect(code).toEqual({ code: '23514', constraint: 'assignment_shadow_checks_result_check' });
  });

  /** Активация истории обязана опираться на поколение и аттестацию (О4). */
  it('переход в историю без поколения — отказ CHECK', async () => {
    const code = await inScene(async (tx, s) =>
      refusal(
        tx,
        sql`INSERT INTO assignment_periods_mode_transitions
              (actor_user_id, from_read_mode, to_read_mode, from_write_mode, to_write_mode,
               build_sha, algo_version, reason)
            VALUES (${s.userId}, 'legacy', 'history', 'all_frozen', 'all_frozen',
                    'sha', 'v1', 'включение истории')`,
      ),
    );

    expect(code).toEqual({
      code: '23514',
      constraint: 'assignment_periods_mode_transitions_history_check',
    });
  });

  /**
   * Журнал append-only физически (О5). Соглашения тут мало: журнал и есть доказательство «чем и
   * когда разрешён переход», а доказательство, которое можно поправить, ничего не доказывает.
   */
  it('правка и удаление записи журнала не проходят', async () => {
    const [updated, deleted] = await inScene(async (tx, s) => {
      await (tx as never as { execute: (typeof AppDb)['execute'] }).execute(sql`
        INSERT INTO assignment_periods_mode_transitions
          (actor_user_id, from_read_mode, to_read_mode, from_write_mode, to_write_mode,
           build_sha, algo_version, reason)
        VALUES (${s.userId}, 'legacy', 'legacy', 'normal', 'all_frozen',
                'sha', 'v1', 'заморозка перед выкатом')`);
      return [
        await refusal(
          tx,
          sql`UPDATE assignment_periods_mode_transitions SET reason = 'другая причина'`,
        ),
        await refusal(tx, sql`DELETE FROM assignment_periods_mode_transitions`),
      ];
    });

    expect(updated?.code).toBe('P0001');
    expect(deleted?.code).toBe('P0001');
  });
});

describe.skipIf(!DB_URL)('журнал коррекций знает виды истории назначения', () => {
  /*
   * Два новых вида и снимок авторизации — та часть §6, без которой двери этапа 3 не поедут:
   * контракты этапа 1 уже отдают `crew` и `assignment_tail`, а действующий CHECK знал семь видов и
   * отверг бы первую же вставку.
   */
  it('вид `crew` со снимком записывается, а без снимка — отвергается', async () => {
    const [withScope, withoutScope] = await inScene(async (tx, s) => {
      const runner = tx as never as { execute: (typeof AppDb)['execute'] };
      const insert = (kind: string, scope: string | null) => sql`
        INSERT INTO waybill_corrections (kind, reason, actor_user_id, operation_id, fingerprint,
                                         authorization_scope)
        VALUES (${kind}, 'смена машиниста задним числом', ${s.userId}, gen_random_uuid(),
                ${`fp_${kind}_${scope ? 'scope' : 'none'}`},
                ${scope}::jsonb)`;
      const scope = JSON.stringify({
        schemaVersion: 1,
        requiresCorrect: true,
        requiresCorrectBeyondLimit: false,
        requiresArchiveRestore: false,
        effectiveDate: '2026-03-01',
        authorizedAsOf: '2026-08-20',
      });
      await runner.execute(insert('crew', scope));
      return [null, await refusal(tx, insert('assignment_tail', null))];
    });

    // Первая вставка прошла — иначе `inScene` бросил бы, а не вернул пару.
    expect(withScope).toBeNull();
    expect(withoutScope?.constraint).toBe('waybill_corrections_authorization_scope_check');
  });

  it('старый вид без снимка по-прежнему записывается: миграция их не переписывала', async () => {
    const refused = await inScene(async (tx, s) =>
      refusal(
        tx,
        sql`
          INSERT INTO waybill_corrections (kind, reason, actor_user_id, operation_id, fingerprint)
          VALUES ('esm2', 'обычная коррекция бумаги', ${s.userId}, gen_random_uuid(), 'fp_old')`,
      ),
    );
    expect(refused).toBeNull();
  });

  it('выдуманный вид не проходит', async () => {
    const refused = await inScene(async (tx, s) =>
      refusal(
        tx,
        sql`
          INSERT INTO waybill_corrections (kind, reason, actor_user_id, operation_id, fingerprint,
                                           authorization_scope)
          VALUES ('crew_tail', 'опечатка', ${s.userId}, gen_random_uuid(), 'fp_bad', '{}'::jsonb)`,
      ),
    );
    expect(refused?.constraint).toBe('waybill_corrections_kind_check');
  });
});
