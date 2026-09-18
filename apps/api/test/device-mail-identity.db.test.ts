import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedDeviceMessage } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type {
  applyDeviceTelemetry as ApplyTelemetry,
  applyResolvedDeviceMessage as ApplyResolved,
  bindDeviceMailIdentity as Bind,
  countBindTargets as CountTargets,
} from '../src/services/device-mail/apply';
import type { resolveDeviceIdentity as Resolve } from '../src/services/device-mail/identity';

/**
 * Идентификация аппарата и применение разобранного (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §6 Р9, §9 Р20—Р22, Р33; §12).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — не форма ответа, а то, ЧЕГО В БАЗЕ НЕ ПОЯВИЛОСЬ. «Ни одной записи
 * при двух кандидатах», «карточка не тронута», «повтор не удваивает ряд» — все три утверждения
 * держатся уникальными индексами, частичными индексами номеров и `NOT NULL` у привязки, то есть
 * ровно теми вещами, которых на моках нет. На моках сошлись бы моки.
 *
 * Что доказывается, и почему каждое отдельно:
 *
 * - **серийник сравнивается формой уникального индекса** (`upper(btrim(...))`): письмо приносит
 *   номер в нижнем регистре и с пробелами, а карточка находится. Считай резолв другой формой — и
 *   он перестал бы находить заведённое соседним местом, причём молча;
 * - **двое кандидатов — `ambiguous` и НИ ОДНОЙ записи.** Это главный случай файла: ошибка здесь
 *   приписывает чужую наработку живой карточке, и заметить это некому;
 * - **серийник письма не совпал с карточкой — пометка, карточка не тронута.** Письмо принято,
 *   разобрано и ждёт человека: `unmatched` — штатный исход, а не ошибка;
 * - **повтор того же источника не удваивает ряд.** Ключ `(source, source_ref, metric_code,
 *   component)` — один на почту, коллектор и ручной ввод, и у коллектора Этапа 2 повтор пачки
 *   после таймаута иначе удвоил бы будущую месячную дельту;
 * - **разрез — часть ключа (Р33):** четыре тонера одного письма ложатся четырьмя рядами, а не
 *   затирают друг друга;
 * - **привязка по опознающему ключу применяет накопленное ПАЧКОЙ, по адресу — одну строку.**
 *   Служебный адрес отправителя у всего парка — обычное дело, и пачка по нему одним нажатием
 *   приписала бы сотни писем разных аппаратов одной карточке;
 * - **каждое письмо применяет СВОЙ снимок**: у трёх писем пачки три разных числа, и в базе обязаны
 *   оказаться все три, а не одно, записанное трижды.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-mail-identity
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`. Именно поэтому
 * ворота зовутся `check:db`, а не `vitest`: без адреса кластера `vitest` промолчал бы и отдал ноль.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const TAG = RUN.toUpperCase();
const ACCOUNT = `mfp-${RUN}@example.invalid`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  resolve: typeof Resolve;
  apply: typeof ApplyTelemetry;
  bind: typeof Bind;
  /** Число «будет затронуто писем», которое окно показывает до подтверждения. */
  countTargets: typeof CountTargets;
  /** Настоящий конвейер: исход резолва плюс снимок → строка письма и, если опознано, ряды. */
  applyResolved: typeof ApplyResolved;
  objectId: string;
  typeId: string;
  /** Три карточки: опознаваемая номерами и две под спор подтверждённых привязок. */
  alpha: string;
  beta: string;
  gamma: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  // Ключи подписи конфиг требует всегда, хотя этому файлу они не нужны ни разу: он не поднимает
  // приложение и никого не пускает. Дешевле сочинить пару, чем заводить конфигу исключение.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
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

// ── Сцена ──

/** Пустой снимок: поля, которых не касается случай, обязаны быть явными, а не додуманными. */
const NO_HINTS = {
  serial: null,
  inventory: null,
  deviceName: null,
  host: null,
  ip: null,
  model: null,
} as const;

function snapshot(patch: Partial<ParsedDeviceMessage> = {}): ParsedDeviceMessage {
  return {
    profileCode: 'ricoh',
    parserVersion: 1,
    observations: [],
    events: [],
    ...patch,
    identity: { ...NO_HINTS, ...(patch.identity ?? {}) },
  };
}

let uidNo = 0;
/** Письмо в очереди: строка `device_mail_messages` со снимком и статусом «ждёт человека». */
async function message(
  status: 'received' | 'unmatched' | 'ambiguous',
  payload: ParsedDeviceMessage,
  from = `dev-${RUN}@example.invalid`,
  /**
   * На сколько суток назад отодвинуть приём. Нужно случаю про `observed_at`: письмо из архива
   * обязано лечь своим временем приёма, а не моментом, когда человек нажал «привязать».
   */
  receivedDaysAgo = 0,
): Promise<string> {
  uidNo += 1;
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO device_mail_messages (account, uid_validity, uid, from_address, subject,
                                      status, raw_state, parsed_payload, profile_code,
                                      parser_version, observation_count, event_count, parsed_at,
                                      received_at)
    VALUES (${ACCOUNT}, 1, ${uidNo}, ${from}, ${`Счётчики ${RUN}`}, ${sql.raw(`'${status}'::device_message_status`)},
            'absent', ${JSON.stringify(payload)}::jsonb, 'ricoh', 1,
            ${payload.observations.length}, ${payload.events.length}, now(),
            now() - make_interval(days => ${receivedDaysAgo}))
    RETURNING id`);
  return row.rows[0]!.id;
}

async function countObservations(equipmentId: string): Promise<number> {
  const res = await ctx.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM device_observations WHERE equipment_id = ${equipmentId}`,
  );
  return Number(res.rows[0]!.n);
}

async function countEvents(equipmentId: string): Promise<number> {
  const res = await ctx.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM device_events WHERE equipment_id = ${equipmentId}`,
  );
  return Number(res.rows[0]!.n);
}

async function statusOf(
  messageId: string,
): Promise<{ status: string; equipmentId: string | null }> {
  const res = await ctx.db.execute<{ status: string; equipment_id: string | null }>(
    sql`SELECT status, equipment_id FROM device_mail_messages WHERE id = ${messageId}`,
  );
  return { status: res.rows[0]!.status, equipmentId: res.rows[0]!.equipment_id };
}

/** Снимок карточки — тем, чем её портит ошибочная привязка: номера, имя, отметка правки. */
async function equipmentSnapshot(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT serial_number, inventory_number, name, updated_at
      FROM office_equipment WHERE id = ${id}`);
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('идентификация аппарата и применение телеметрии (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { resolveDeviceIdentity } = await import('../src/services/device-mail/identity');
    const {
      applyDeviceTelemetry,
      applyResolvedDeviceMessage,
      bindDeviceMailIdentity,
      countBindTargets,
    } = await import('../src/services/device-mail/apply');

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`DMI-${RUN}`}, ${`Площадка телеметрии ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!typeRow.rows[0]) {
      throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');
    }
    const objectId = objectRow.rows[0]!.id;
    const typeId = typeRow.rows[0]!.id;

    /** Карточка заводится SQL: её форма — предмет своих тестов, здесь она декорация. */
    async function makeEquipment(tag: string, serial: string | null): Promise<string> {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, serial_number, inventory_number,
                                      object_id, location)
        VALUES (${typeId}, ${`Ricoh Aficio ${tag} ${RUN}`}, ${serial ?? ''},
                ${`ИНВ-${TAG}-${tag}`}, ${objectId}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    }

    await db.execute(sql`
      INSERT INTO device_mail_accounts (account) VALUES (${ACCOUNT})
      ON CONFLICT (account) DO NOTHING`);

    ctx = {
      db,
      closeDb,
      resolve: resolveDeviceIdentity,
      apply: applyDeviceTelemetry,
      bind: bindDeviceMailIdentity,
      countTargets: countBindTargets,
      applyResolved: applyResolvedDeviceMessage,
      objectId,
      typeId,
      alpha: await makeEquipment('A', `SN-${TAG}-A`),
      beta: await makeEquipment('B', `SN-${TAG}-B`),
      gamma: await makeEquipment('C', `SN-${TAG}-C`),
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    const мои = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ИНВ-${TAG}-%`}`;
    await ctx.db.execute(sql`DELETE FROM device_events WHERE equipment_id IN (${мои})`);
    await ctx.db.execute(sql`DELETE FROM device_observations WHERE equipment_id IN (${мои})`);
    await ctx.db.execute(sql`DELETE FROM device_mail_messages WHERE account = ${ACCOUNT}`);
    await ctx.db.execute(sql`DELETE FROM device_mail_accounts WHERE account = ${ACCOUNT}`);
    await ctx.db.execute(sql`DELETE FROM device_mail_identities WHERE equipment_id IN (${мои})`);
    await ctx.db.execute(sql`DELETE FROM office_equipment WHERE id IN (${мои})`);
    // Модель заводит триггер зеркала на вставке карточки — уборка обязана снять и её.
    await ctx.db.execute(sql`
      DELETE FROM office_equipment_models m
       WHERE m.name LIKE ${`Ricoh Aficio % ${RUN}`}
         AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`DMI-${RUN}`}`);
    await ctx.closeDb();
  }, 60_000);

  it('серийник опознаёт карточку формой уникального индекса', async () => {
    const resolution = await ctx.resolve(ctx.db, {
      // Нижний регистр и пробелы по краям — та самая форма, в которой номер приезжает из письма.
      hints: { ...NO_HINTS, serial: `  sn-${TAG.toLowerCase()}-a ` },
    });
    expect(resolution.status).toBe('matched');
    if (resolution.status !== 'matched') return;
    expect(resolution.equipmentId).toBe(ctx.alpha);
    expect(resolution.by.kind).toBe('serial');
  });

  it('инвентарный опознаёт, когда серийника в письме нет', async () => {
    const resolution = await ctx.resolve(ctx.db, {
      hints: { ...NO_HINTS, inventory: `инв-${TAG.toLowerCase()}-b` },
    });
    expect(resolution.status).toBe('matched');
    if (resolution.status !== 'matched') return;
    expect(resolution.equipmentId).toBe(ctx.beta);
    expect(resolution.by.kind).toBe('inventory');
  });

  it('имя устройства и IP сами по себе не опознают никогда', async () => {
    // Имя карточки буквально совпадает с именем устройства из письма, а IP — с чем угодно: ни то,
    // ни другое не имеет права дать `matched`, пока человек не завёл привязку.
    const resolution = await ctx.resolve(ctx.db, {
      hints: {
        ...NO_HINTS,
        deviceName: `Ricoh Aficio A ${RUN}`,
        host: `ricoh-a-${RUN}`,
        ip: '10.10.10.10',
      },
    });
    expect(resolution.status).toBe('unmatched');
  });

  it('серийник письма не совпал с карточкой: пометка, карточка не тронута', async () => {
    const before = await equipmentSnapshot(ctx.alpha);
    const id = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial: `SN-${TAG}-НЕТ-ТАКОГО` },
        observations: [
          {
            metricCode: 'printed_impressions_total',
            component: '',
            value: '1000',
            unit: 'impressions',
            deviceTime: null,
            rawLabel: 'Total',
          },
        ],
      }),
    );

    const resolution = await ctx.resolve(ctx.db, {
      hints: { ...NO_HINTS, serial: `SN-${TAG}-НЕТ-ТАКОГО` },
    });
    expect(resolution.status).toBe('unmatched');

    // Письмо лежит в очереди со своим снимком, и это законное состояние, а не ошибка.
    expect(await statusOf(id)).toEqual({ status: 'unmatched', equipmentId: null });
    // Ни одной записи ни у одной карточки — и сама карточка не изменилась ни в одном поле.
    expect(await countObservations(ctx.alpha)).toBe(0);
    expect(await equipmentSnapshot(ctx.alpha)).toEqual(before);
  });

  it('двое кандидатов: ambiguous и ни одной записи', async () => {
    // Спор двух решений человека: имя устройства он привязал к одной карточке, сетевое имя — к
    // другой, а письмо несёт оба ключа разом. Разбирать это порталу нечем.
    await ctx.db.execute(sql`
      INSERT INTO device_mail_identities (key_kind, key_value, equipment_id)
      VALUES ('deviceName', ${`RICOH-${TAG}-SPOR`}, ${ctx.beta}),
             ('host', ${`RICOH-${TAG}-SPOR-HOST`}, ${ctx.gamma})`);

    const before = {
      beta: await equipmentSnapshot(ctx.beta),
      gamma: await equipmentSnapshot(ctx.gamma),
    };
    const betaRows = await countObservations(ctx.beta);
    const gammaRows = await countObservations(ctx.gamma);

    const resolution = await ctx.resolve(ctx.db, {
      hints: {
        ...NO_HINTS,
        deviceName: `ricoh-${TAG.toLowerCase()}-spor`,
        host: `ricoh-${TAG.toLowerCase()}-spor-host`,
      },
    });
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(new Set(resolution.candidates.map((c) => c.equipmentId))).toEqual(
      new Set([ctx.beta, ctx.gamma]),
    );

    // Ни одной записи и ни одной тронутой карточки: резолв не пишет вовсе, а применение без
    // однозначного `equipmentId` попросту не с чем позвать.
    expect(await countObservations(ctx.beta)).toBe(betaRows);
    expect(await countObservations(ctx.gamma)).toBe(gammaRows);
    expect(await countEvents(ctx.beta)).toBe(0);
    expect(await countEvents(ctx.gamma)).toBe(0);
    expect(await equipmentSnapshot(ctx.beta)).toEqual(before.beta);
    expect(await equipmentSnapshot(ctx.gamma)).toEqual(before.gamma);
  });

  it('спор подтверждённых привязок не проваливается на серийник', async () => {
    // Письмо несёт и спорную пару ключей, и совпадающий серийник карточки A. Провалиться со
    // ступени, давшей двух кандидатов, на следующую значило бы: человек сказал «B», потом «C», а
    // портал молча выбрал третьего.
    const resolution = await ctx.resolve(ctx.db, {
      hints: {
        ...NO_HINTS,
        serial: `SN-${TAG}-A`,
        deviceName: `RICOH-${TAG}-SPOR`,
        host: `RICOH-${TAG}-SPOR-HOST`,
      },
    });
    expect(resolution.status).toBe('ambiguous');
  });

  it('повторное применение того же источника не удваивает ряд', async () => {
    const sourceRef = randomUUID();
    const observedAt = new Date();
    const input = {
      equipmentId: ctx.alpha,
      source: 'email' as const,
      sourceRef,
      observedAt,
      observations: [
        {
          metricCode: 'printed_impressions_total' as const,
          component: '' as const,
          value: '12345',
          unit: 'impressions' as const,
          deviceTime: null,
          rawLabel: 'Всего оттисков',
        },
        // Четыре тонера одного письма — Р33: разрез входит в ключ, иначе трое из четырёх молча
        // потерялись бы под одним кодом метрики.
        ...(['black', 'cyan', 'magenta', 'yellow'] as const).map((component, index) => ({
          metricCode: 'supply_level_percent' as const,
          component,
          value: String(10 * (index + 1)),
          unit: 'percent' as const,
          deviceTime: null,
          rawLabel: component,
        })),
      ],
      events: [
        {
          eventCode: 'paper_jam' as const,
          severity: 'warning' as const,
          deviceTime: null,
          vendorCode: 'SC552',
          text: 'Замятие в лотке 1',
        },
        // Второе замятие того же письма: `ordinal` обязан развести их, иначе лента потеряла бы
        // половину аварий.
        {
          eventCode: 'paper_jam' as const,
          severity: 'warning' as const,
          deviceTime: null,
          vendorCode: 'SC553',
          text: 'Замятие в лотке 2',
        },
      ],
    };

    const first = await ctx.apply(ctx.db, input);
    expect(first).toEqual({ observations: 5, events: 2 });

    const again = await ctx.apply(ctx.db, input);
    expect(again).toEqual({ observations: 0, events: 0 });

    const rows = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM device_observations
       WHERE source = 'email' AND source_ref = ${sourceRef}`);
    expect(Number(rows.rows[0]!.n)).toBe(5);
    const evts = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM device_events
       WHERE source = 'email' AND source_ref = ${sourceRef}`);
    expect(Number(evts.rows[0]!.n)).toBe(2);
  });

  it('привязка по опознающему ключу применяет накопленные письма пачкой', async () => {
    const serial = `SN-${TAG}-ПАЧКА`;
    /** Три письма одного аппарата, у каждого СВОЙ счётчик: подменить их одним нельзя. */
    const values = ['100', '200', '300'];
    const ids: string[] = [];
    for (const value of values) {
      ids.push(
        await message(
          'unmatched',
          snapshot({
            identity: { ...NO_HINTS, serial },
            observations: [
              {
                metricCode: 'printed_sheets_total',
                component: '',
                value,
                unit: 'sheets',
                deviceTime: null,
                rawLabel: 'Листов',
              },
            ],
          }),
        ),
      );
    }
    // Чужое письмо того же ящика: пачка не имеет права его задеть.
    const stranger = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial: `SN-${TAG}-ЧУЖОЙ` },
      }),
    );

    const before = await countObservations(ctx.gamma);
    const result = await ctx.bind({
      // Нажали на первом письме, а значение ввели в другом регистре и с пробелами.
      messageId: ids[0]!,
      equipmentId: ctx.gamma,
      kind: 'serial',
      value: ` ${serial.toLowerCase()} `,
      note: 'разбор очереди',
    });
    expect(result.appliedMessages).toBe(3);
    expect(result.observations).toBe(3);
    expect(result.skippedMessages).toBe(0);

    for (const id of ids) {
      expect(await statusOf(id)).toEqual({ status: 'parsed', equipmentId: ctx.gamma });
    }
    expect((await statusOf(stranger)).status).toBe('unmatched');
    expect(await countObservations(ctx.gamma)).toBe(before + 3);

    // Каждое письмо применило СВОЙ снимок: три разных числа, а не одно, записанное трижды.
    const written = await ctx.db.execute<{ value: string }>(sql`
      SELECT value FROM device_observations
       WHERE equipment_id = ${ctx.gamma} AND metric_code = 'printed_sheets_total'
       ORDER BY value`);
    expect(written.rows.map((row) => Number(row.value))).toEqual([100, 200, 300]);

    // Повторное нажатие: письма уже применены, второго ряда не появляется.
    const twice = await ctx.bind({
      messageId: ids[0]!,
      equipmentId: ctx.gamma,
      kind: 'serial',
      value: serial,
    });
    expect(twice.appliedMessages).toBe(0);
    expect(await countObservations(ctx.gamma)).toBe(before + 3);

    // И следующее письмо того же аппарата матчится уже само — ради этого привязку и заводят.
    const next = await ctx.resolve(ctx.db, { hints: { ...NO_HINTS, serial } });
    expect(next.status).toBe('matched');
    if (next.status === 'matched') expect(next.equipmentId).toBe(ctx.gamma);
  });

  it('привязка по адресу применяет только ту строку, на которой нажали', async () => {
    const from = `parking-${RUN}@example.invalid`;
    const clicked = await message(
      'unmatched',
      snapshot({
        observations: [
          {
            metricCode: 'marker_life_total',
            component: '',
            value: '7',
            unit: 'impressions',
            deviceTime: null,
            rawLabel: 'Счётчик',
          },
        ],
      }),
      from,
    );
    const neighbour = await message(
      'unmatched',
      snapshot({
        observations: [
          {
            metricCode: 'marker_life_total',
            component: '',
            value: '9',
            unit: 'impressions',
            deviceTime: null,
            rawLabel: 'Счётчик',
          },
        ],
      }),
      from,
    );

    const before = await countObservations(ctx.beta);
    const result = await ctx.bind({
      messageId: clicked,
      equipmentId: ctx.beta,
      kind: 'fromAddress',
      value: from,
    });
    // Служебный адрес отправителя у всего парка — обычное дело: пачка по нему приписала бы сотни
    // писем разных аппаратов одной карточке, мгновенно и без отката.
    expect(result.appliedMessages).toBe(1);
    expect(await statusOf(clicked)).toEqual({ status: 'parsed', equipmentId: ctx.beta });
    expect((await statusOf(neighbour)).status).toBe('unmatched');
    expect(await countObservations(ctx.beta)).toBe(before + 1);
  });

  it('пачка ищется формой индекса: строчная «s» и внутренний пробел не мешают', async () => {
    /*
     * Ключ нарочно такой, каким имя устройства бывает в жизни: строчными и с внутренним пробелом.
     *
     * Строчная «s» — это найденный судьёй отказ: в шаблоне `sql` drizzle берёт СВАРЕННУЮ строку, и
     * `\s+` доезжал до Postgres выражением `s+`, то есть схлопывал не пробелы, а букву. Имя
     * `ricoh-sales  214` превращалось в `RICOH- ALE   214`, пачка не находила ничего, и привязка
     * применяла одну строку вместо двадцати. Обратная сторона того же: подсказка `ABsC` сводилась к
     * `AB C` — и карточка с ключом `AB C` забирала письма ЧУЖОГО аппарата.
     *
     * Двойной внутренний пробел — вторая половина случая: он обязан сохраниться. `btrim` у
     * уникальных индексов номеров внутренние пробелы не трогает, и `normalizeIdentityValue` их тоже
     * не схлопывает (у номера `3282 Z920584`, склеенного при заводе карточки, схлопывание дало бы
     * значение, которого в индексе нет).
     */
    const deviceName = `ricoh-sales  ${TAG}`;
    const ids = [
      await message('unmatched', snapshot({ identity: { ...NO_HINTS, deviceName } })),
      await message('unmatched', snapshot({ identity: { ...NO_HINTS, deviceName } })),
    ];

    // То самое число, которое окно показывает до подтверждения: «Будет затронуто писем: 2».
    const preview = await ctx.countTargets(ctx.db, {
      messageId: ids[0]!,
      kind: 'deviceName',
      value: ` Ricoh-Sales  ${TAG} `,
    });
    expect(preview).toBe(2);

    const result = await ctx.bind({
      messageId: ids[0]!,
      equipmentId: ctx.alpha,
      kind: 'deviceName',
      value: ` Ricoh-Sales  ${TAG} `,
    });
    expect(result.appliedMessages).toBe(2);
    for (const id of ids) {
      expect(await statusOf(id)).toEqual({ status: 'parsed', equipmentId: ctx.alpha });
    }
  });

  it('пачка работает и по инвентарному номеру', async () => {
    // Без этого случая из `HINT_FIELD` можно было выкинуть строку `inventory`, и набор остался бы
    // зелёным: пачка была доказана только для серийника.
    const inventory = `ИНВ-${TAG}-ПАЧКА`;
    const ids = [
      await message('unmatched', snapshot({ identity: { ...NO_HINTS, inventory } })),
      await message('unmatched', snapshot({ identity: { ...NO_HINTS, inventory } })),
    ];
    const result = await ctx.bind({
      messageId: ids[0]!,
      equipmentId: ctx.beta,
      kind: 'inventory',
      value: inventory.toLowerCase(),
    });
    expect(result.appliedMessages).toBe(2);
    for (const id of ids) {
      expect(await statusOf(id)).toEqual({ status: 'parsed', equipmentId: ctx.beta });
    }
  });

  it('применение снимка пишет события каждого письма со своими порядковыми номерами', async () => {
    /*
     * Без этого случая мутация «применять письма без событий» (`events: []`) проходила весь набор:
     * счётчики сходились, статусы менялись, лента оставалась пустой — и заметить это было бы
     * некому, потому что ленту событий читает только экран карточки.
     *
     * Два письма нужны по отдельной причине: `ordinal` считается ВНУТРИ одного источника, и второе
     * замятие второго письма обязано снова получить нулевой номер, а не третий.
     */
    const serial = `SN-${TAG}-СОБЫТИЯ`;
    const jamTwice = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial },
        events: [
          {
            eventCode: 'paper_jam',
            severity: 'warning',
            deviceTime: null,
            vendorCode: 'SC552',
            text: 'Лоток 1',
          },
          {
            eventCode: 'paper_jam',
            severity: 'warning',
            deviceTime: null,
            vendorCode: 'SC553',
            text: 'Лоток 2',
          },
          {
            eventCode: 'toner_low',
            severity: 'warning',
            deviceTime: null,
            vendorCode: '',
            text: 'Чёрный',
          },
        ],
      }),
    );
    const coverOnce = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial },
        events: [
          {
            eventCode: 'cover_open',
            severity: 'info',
            deviceTime: null,
            vendorCode: '',
            text: 'Крышка',
          },
        ],
      }),
    );

    const before = await countEvents(ctx.gamma);
    const result = await ctx.bind({
      messageId: jamTwice,
      equipmentId: ctx.gamma,
      kind: 'serial',
      value: serial,
    });
    expect(result.appliedMessages).toBe(2);
    expect(result.events).toBe(4);
    expect(await countEvents(ctx.gamma)).toBe(before + 4);

    const first = await ctx.db.execute<{
      event_code: string;
      ordinal: number;
      vendor_code: string;
    }>(sql`
      SELECT event_code, ordinal, vendor_code FROM device_events
       WHERE source = 'email' AND source_ref = ${jamTwice}
       ORDER BY event_code, ordinal`);
    expect(first.rows).toEqual([
      { event_code: 'paper_jam', ordinal: 0, vendor_code: 'SC552' },
      { event_code: 'paper_jam', ordinal: 1, vendor_code: 'SC553' },
      { event_code: 'toner_low', ordinal: 0, vendor_code: '' },
    ]);

    const second = await ctx.db.execute<{ event_code: string; ordinal: number }>(sql`
      SELECT event_code, ordinal FROM device_events
       WHERE source = 'email' AND source_ref = ${coverOnce}`);
    expect(second.rows).toEqual([{ event_code: 'cover_open', ordinal: 0 }]);
  });

  it('observed_at наблюдения — момент приёма письма, а не момент применения', async () => {
    /*
     * Мутация `observedAt: new Date()` вместо `received_at` письма тоже проходила весь набор: числа
     * в базе те же, рядов столько же. А между тем это Р21 целиком — порядок ряда держит момент
     * приёма, и пачка из сорока архивных писем, легшая одной секундой, навсегда портит и ленту, и
     * будущие месячные дельты.
     */
    const serial = `SN-${TAG}-АРХИВ`;
    const archived = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial },
        observations: [
          {
            metricCode: 'printed_mono_total',
            component: '',
            value: '4242',
            unit: 'impressions',
            deviceTime: null,
            rawLabel: 'Ч/б',
          },
        ],
      }),
      undefined,
      40,
    );

    await ctx.bind({ messageId: archived, equipmentId: ctx.gamma, kind: 'serial', value: serial });

    // Сходство с допуском в секунду, а не равенство до микросекунды: у колонки микросекунды, а
    // через `Date` значение приезжает с точностью до миллисекунды и теряет хвост. Допуск в секунду
    // мутацию не пропускает — она уводит время на сорок суток.
    const row = await ctx.db.execute<{ same: boolean; age_days: number }>(sql`
      SELECT abs(extract(epoch FROM (o.observed_at - m.received_at))) < 1 AS same,
             extract(day FROM now() - o.observed_at)::int AS age_days
        FROM device_observations o
        JOIN device_mail_messages m ON m.id = o.source_ref
       WHERE o.source = 'email' AND o.source_ref = ${archived}`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.same).toBe(true);
    // И это именно архив, а не «только что»: момент применения от приёма отличается на сорок дней.
    expect(row.rows[0]!.age_days).toBeGreaterThanOrEqual(39);
  });

  it('конвейер при двух кандидатах не пишет ничего и не заполняет аппарат письма', async () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ ФАЙЛА, и идёт он настоящим путём — резолв, а затем запись исхода
     * (`applyResolvedDeviceMessage`), — а не одним резолвом. Проверка «читалка ничего не записала»
     * покраснеть не может по построению: настоящая дверь к беде — конвейер, который при `ambiguous`
     * возьмёт `candidates[0]`, и вот она-то здесь и закрыта.
     */
    await ctx.db.execute(sql`
      INSERT INTO device_mail_identities (key_kind, key_value, equipment_id)
      VALUES ('deviceName', ${`KONF-${TAG}`}, ${ctx.beta}),
             ('host', ${`KONF-${TAG}-H`}, ${ctx.gamma})`);

    const payload = snapshot({
      identity: { ...NO_HINTS, deviceName: `konf-${TAG}`, host: `konf-${TAG}-h` },
      observations: [
        {
          metricCode: 'printed_color_total',
          component: '',
          value: '777',
          unit: 'impressions',
          deviceTime: null,
          rawLabel: 'Цвет',
        },
      ],
      events: [
        {
          eventCode: 'toner_empty',
          severity: 'critical',
          deviceTime: null,
          vendorCode: '',
          text: 'Пусто',
        },
      ],
    });
    // Письмо приходит из приёмника в `received` — ровно как в жизни; статус ставит конвейер.
    const id = await message('received', payload);

    const betaEvents = await countEvents(ctx.beta);
    const gammaEvents = await countEvents(ctx.gamma);
    const betaRows = await countObservations(ctx.beta);
    const gammaRows = await countObservations(ctx.gamma);

    const outcome = await ctx.db.transaction(async (tx) => {
      const resolution = await ctx.resolve(tx, {
        hints: payload.identity,
      });
      expect(resolution.status).toBe('ambiguous');
      return ctx.applyResolved(tx, {
        messageId: id,
        receivedAt: new Date(),
        snapshot: payload,
        resolution,
      });
    });

    expect(outcome).toEqual({ status: 'ambiguous', equipmentId: null, observations: 0, events: 0 });
    expect(await statusOf(id)).toEqual({ status: 'ambiguous', equipmentId: null });
    expect(await countObservations(ctx.beta)).toBe(betaRows);
    expect(await countObservations(ctx.gamma)).toBe(gammaRows);
    expect(await countEvents(ctx.beta)).toBe(betaEvents);
    expect(await countEvents(ctx.gamma)).toBe(gammaEvents);
    // Ни одного ряда НИ У КОГО по этому источнику: «ни одна карточка не тронута» — это про всех.
    const any = await ctx.db.execute<{ n: string }>(sql`
      SELECT (SELECT count(*) FROM device_observations WHERE source_ref = ${id})
           + (SELECT count(*) FROM device_events WHERE source_ref = ${id}) AS n`);
    expect(Number(any.rows[0]!.n)).toBe(0);

    // Разобранное не выброшено: снимок лежит в строке, и привязка потом его применит.
    const saved = await ctx.db.execute<{ n: number }>(sql`
      SELECT jsonb_array_length(parsed_payload -> 'observations') AS n
        FROM device_mail_messages WHERE id = ${id}`);
    expect(Number(saved.rows[0]!.n)).toBe(1);
  });

  it('непригодный снимок откладывается, а пачку не роняет', async () => {
    /*
     * Отрицательное значение встречает `device_observations_value_check`. Раньше сторож бросал
     * исключение — и отказ на девятнадцатом письме откатил бы восемнадцать применённых. Теперь
     * письмо уходит в `skippedMessages`, остаётся в очереди, а соседи по пачке применяются.
     */
    const serial = `SN-${TAG}-МИНУС`;
    const broken = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial },
        observations: [
          {
            metricCode: 'printed_sheets_total',
            component: '',
            value: '-5',
            unit: 'sheets',
            deviceTime: null,
            rawLabel: 'Листов',
          },
        ],
      }),
    );
    const healthy = await message(
      'unmatched',
      snapshot({
        identity: { ...NO_HINTS, serial },
        observations: [
          {
            metricCode: 'printed_sheets_total',
            component: '',
            value: '5',
            unit: 'sheets',
            deviceTime: null,
            rawLabel: 'Листов',
          },
        ],
      }),
    );

    const result = await ctx.bind({
      messageId: broken,
      equipmentId: ctx.alpha,
      kind: 'serial',
      value: serial,
    });
    expect(result.appliedMessages).toBe(1);
    expect(result.skippedMessages).toBe(1);
    expect((await statusOf(broken)).status).toBe('unmatched');
    expect(await statusOf(healthy)).toEqual({ status: 'parsed', equipmentId: ctx.alpha });
  });
});
