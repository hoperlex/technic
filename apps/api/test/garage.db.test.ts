import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GarageBusyEntry, type GarageVehicleDto, moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Гараж на живой схеме: срез дня собирается из четырёх источников сразу (ADR 0076).
 *
 * Правил у модуля почти нет — есть SQL: три EXISTS-подзапроса, `CASE` старшинства состояний и
 * доборы занятостей. Проверить это тестом на правилах невозможно в принципе: ошибка здесь живёт
 * не в ветвлении, а в имени колонки, в приведении даты и в том, попадает ли граница периода
 * внутрь. Поэтому файл идёт по настоящему HTTP-пути на настоящей базе.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый водитель гаража: свой СНИЛС, чтобы не пересечься с водителем соседнего db-теста. */
const DRIVER_SNILS = '22222222290';
const ADMIN_EMAIL = 'garage-db-test@example.invalid';
const ADMIN_PASSWORD = 'garage-db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Спецтехника с категорией: на неё заводится заказ на объект. */
  special: { id: string; typeId: string; categoryId: string | null };
  /** Своя активная машина под рейс — заведомо другая, иначе состояния наложились бы. */
  routeVehicle: { id: string };
  /** Третья машина: ею проверяются «свободна» и «недоступна». */
  spare: { id: string };
  objectId: string;
  personId: string;
  today: string;
}

let ctx: Ctx;

/** Что тест завёл в общей базе — уборка в `afterAll` держится за эти два идентификатора. */
const created: { requestId?: string; routeId?: string } = {};

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

/** Учётка и водитель: парк, объекты, серии бланков и категории прав приходят миграциями. */
async function seed(): Promise<{ personId: string }> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (!user) {
    await db.insert(schema.users).values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: 'Гаражный',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
    });
  }

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${DRIVER_SNILS}`);
  if (existing) return { personId: existing.id };

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = 'driver_license'`);
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(sql`${schema.qualificationCategories.code} in ('b', 'c')`);

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Гаражный',
        firstName: 'Водитель',
        middleName: 'Тестовый',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: срез гаража',
      })
      .returning({ id: schema.persons.id });
    const personId = person!.id;

    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization!.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
    await tx.insert(schema.personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: 'Г-100',
      jobTitle: 'Водитель',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
        number: '000600',
        issuedOn: '2021-03-12',
        // Срок заведомо длинный: иначе тест однажды сломается молча — пробелами комплекта.
        expiresOn: '2099-03-12',
        verificationStatus: 'verified',
        verifiedAt: new Date('2021-03-12T12:00:00Z'),
      })
      .returning({ id: schema.personCredentials.id });
    await tx.insert(schema.personCredentialCategories).values(
      categories.map((c) => ({
        credentialId: credential!.id,
        qualificationCategoryId: c.id,
        credentialTypeId: licenseType!.id,
        validFrom: '2021-03-12',
      })),
    );
    return { personId };
  });
}

/** Строка гаража по машине: срез спрашивается страницей побольше — парк невелик. */
async function vehicleRow(vehicleId: string, query = ''): Promise<GarageVehicleDto | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${ctx.today}&pageSize=500${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().onDate).toBe(ctx.today);
  return (res.json().items as GarageVehicleDto[]).find((row) => row.id === vehicleId);
}

function busyKinds(entries: readonly GarageBusyEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

describe.skipIf(!DB_URL)('гараж: срез дня на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { personId } = await seed();
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const today = moscowDateKeyOf(new Date());

    /**
     * Машины, у которых на этот день нет ничего: ни рейса, ни заказа, ни недельного листа.
     *
     * База у db-тестов общая и живёт между прогонами — «первая попавшаяся своя машина» к третьему
     * запуску оказывается занятой чужой заявкой, и тест начинает проверять не то, что написано.
     * Условия здесь те же три, что складывают состояние в `vehicleStateSql`; уборку за собой тест
     * всё равно делает (`afterAll`), а это — защита от чужих данных.
     */
    const freeVehicles = sql`
      v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM vehicle_routes r WHERE r.vehicle_id = v.id AND r.route_date = ${today}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM vehicle_request_assignments a
        JOIN vehicle_requests vr ON vr.id = a.request_id
        JOIN special_equipment_request_details d ON d.request_id = vr.id
        WHERE a.vehicle_id = v.id AND vr.status = 'confirmed' AND vr.deleted_at IS NULL
          AND d.date_from <= ${today}::date
          AND coalesce(d.date_to, d.date_from) >= ${today}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM waybills w
        WHERE w.vehicle_id = v.id AND w.form_code = 'esm2' AND w.status <> 'cancelled'
          AND w.period_from <= ${today}::date AND w.period_to >= ${today}::date
      )`;

    const special = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
      sql`SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
          FROM vehicles v
          JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE ${freeVehicles}
            AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
          LIMIT 1`,
    );
    const specialVehicle = special.rows[0];
    if (!specialVehicle) {
      throw new Error('Нет свободной на сегодня спецтехники: срез не на чем проверить');
    }

    // Две другие машины: одна поедет рейсом, вторая останется свободной и уйдёт в ремонт.
    const others = await db.execute<{ id: string }>(
      sql`SELECT v.id FROM vehicles v
          WHERE ${freeVehicles} AND v.id <> ${specialVehicle.id}
          ORDER BY v.id LIMIT 2`,
    );
    if (others.rows.length < 2) {
      throw new Error('Свободных на сегодня своих машин меньше трёх: срез не собрать');
    }

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const object = objects.rows[0];
    if (!object) throw new Error('В базе нет активного объекта');

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      special: {
        id: specialVehicle.id,
        typeId: specialVehicle.type_id,
        categoryId: specialVehicle.category_id,
      },
      routeVehicle: { id: others.rows[0]!.id },
      spare: { id: others.rows[1]!.id },
      objectId: object.id,
      personId,
      // День среза — сегодня по Москве: заявку задним числом сервер не принимает.
      today,
    };
  }, 120_000);

  /**
   * Уборка за собой: заведённые рейс и заявка иначе остаются в общей базе и занимают машины
   * следующему прогону — тот отбирает свободные на сегодня.
   *
   * Рейс удаляется (пустой, без листа — можно), заявка **откатывается в «Новую»**, и этого
   * довольно: занятой машину делает только заявка «В работе», а откат заодно аннулирует её
   * недельные листы (ADR 0060). Удалять её насовсем нечем и не нужно — номер побывавшего бланка
   * держит её строкой в `waybill_requests`, и это правильное поведение журнала учёта.
   *
   * Ошибки уборки прогон не роняют: тест уже отработал.
   */
  afterAll(async () => {
    if (created.routeId) {
      await ctx?.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-routes/${created.routeId}`,
        headers: ctx.auth,
      });
    }
    if (created.requestId) {
      const current = await ctx?.app.inject({
        method: 'GET',
        url: `/api/v1/vehicle-requests/${created.requestId}`,
        headers: ctx.auth,
      });
      if (current?.statusCode === 200) {
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/vehicle-requests/${created.requestId}/status`,
          headers: ctx.auth,
          payload: {
            status: 'new',
            comment: 'уборка после теста',
            version: current.json().version,
          },
        });
      }
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('заказ спецтехники на сегодня делает машину «на объекте» и приводит заявку с недельным листом', async () => {
    const createdRequest = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-requests',
      headers: ctx.auth,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: ctx.special.typeId,
        vehicleCategoryId: ctx.special.categoryId,
        dateFrom: ctx.today,
        dateTo: ctx.today,
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      },
    });
    expect(createdRequest.statusCode, createdRequest.body).toBe(201);
    const request = createdRequest.json();
    created.requestId = request.id;

    const approved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/approval`,
      headers: ctx.auth,
      payload: { approved: true, version: request.version },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const confirmed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'confirmed',
        comment: '',
        version: approved.json().version,
        assignment: {
          vehicleId: ctx.special.id,
          pricePerHour: null,
          pricePerShift: null,
          shiftHours: null,
          driverPersonId: ctx.personId,
        },
        schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.today },
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const row = await vehicleRow(ctx.special.id);
    expect(row?.state).toBe('on_site');
    // Заказ и недельный лист — два самостоятельных источника занятости: лист ЭСМ-2 выписывается
    // той же транзакцией (ADR 0060), и в срезе он стоит рядом с заявкой, а не вместо неё.
    expect(busyKinds(row!.busy)).toContain('special');
    expect(busyKinds(row!.busy)).toContain('esm2');

    // Именно наша заявка, а не первая попавшаяся: машина свободна на сегодня по трём условиям
    // отбора, но вчерашние заказы у неё бывают.
    const special = row!.busy.find(
      (entry) => entry.kind === 'special' && entry.requestId === request.id,
    );
    expect(special).toMatchObject({
      requestId: request.id,
      displayNumber: request.displayNumber,
      dateFrom: ctx.today,
      // Смену за день ещё не заполняли — строки в `vehicle_request_shifts` нет.
      shift: null,
      earlyEndPending: false,
    });
    // Машинист недельного листа виден в строке машины: колонку «Водители» собирает сервер.
    expect(row!.drivers.map((d) => d.personId)).toContain(ctx.personId);
  });

  it('рейс на сегодня делает машину «в рейсе», а её водителя — назначенным', async () => {
    const route = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-routes',
      headers: ctx.auth,
      payload: {
        vehicleId: ctx.routeVehicle.id,
        routeDate: ctx.today,
        driverPersonId: ctx.personId,
      },
    });
    expect(route.statusCode, route.body).toBe(201);
    created.routeId = route.json().id;

    const row = await vehicleRow(ctx.routeVehicle.id);
    expect(row?.state).toBe('on_route');
    expect(busyKinds(row!.busy)).toEqual(['route']);
    expect(row!.busy[0]).toMatchObject({
      kind: 'route',
      routeId: route.json().id,
      displayNumber: route.json().displayNumber,
      driverPersonId: ctx.personId,
      // Лист по рейсу не выписывали — и «не выписан» здесь означает именно это.
      waybill: null,
    });

    const drivers = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/drivers?on=${ctx.today}&pageSize=500`,
      headers: ctx.auth,
    });
    expect(drivers.statusCode, drivers.body).toBe(200);
    const driver = drivers
      .json()
      .items.find((d: { personId: string }) => d.personId === ctx.personId);
    expect(driver?.state).toBe('assigned');
    expect(driver?.personnelNo).toBe('Г-100');
    // Комплект документов полон — пустой список пробелов означает «лист выпишется без пропусков».
    expect(driver?.gaps).toEqual([]);
    expect(driver.busy.map((entry: GarageBusyEntry) => entry.kind)).toContain('route');
  });

  it('нерабочий статус машины перекрывает всё остальное', async () => {
    const free = await vehicleRow(ctx.spare.id);
    expect(free?.state).toBe('free');
    expect(free?.busy).toEqual([]);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicles/${ctx.spare.id}`,
      headers: ctx.auth,
      payload: { status: 'maintenance' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    try {
      const row = await vehicleRow(ctx.spare.id);
      expect(row?.state).toBe('unavailable');
      expect(row?.status).toBe('maintenance');
    } finally {
      // Машина возвращается в строй: база одна на все db-тесты, и оставлять её в ремонте нельзя.
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicles/${ctx.spare.id}`,
        headers: ctx.auth,
        payload: { status: 'active' },
      });
    }
  });

  it('фильтр состояния и сводка считают один и тот же день', async () => {
    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles/summary?on=${ctx.today}`,
      headers: ctx.auth,
    });
    expect(summary.statusCode, summary.body).toBe(200);
    const totals = summary.json();
    expect(totals.onDate).toBe(ctx.today);
    // Состояние у машины ровно одно, поэтому четыре цифры складываются в парк без остатка.
    expect(totals.free + totals.onRoute + totals.onSite + totals.unavailable).toBe(totals.total);
    expect(totals.onSite).toBeGreaterThan(0);
    expect(totals.onRoute).toBeGreaterThan(0);

    // Фильтр отбирает по тому же выражению, что считает колонку: занятые в него не попадают.
    const freeOnly = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${ctx.today}&state=free&pageSize=500`,
      headers: ctx.auth,
    });
    expect(freeOnly.statusCode, freeOnly.body).toBe(200);
    const rows = freeOnly.json().items as GarageVehicleDto[];
    expect(rows.every((row) => row.state === 'free')).toBe(true);
    expect(rows.map((row) => row.id)).not.toContain(ctx.special.id);
    expect(rows.map((row) => row.id)).not.toContain(ctx.routeVehicle.id);
    expect(freeOnly.json().total).toBe(totals.free);
  });

  it('вчерашний день ничего этого не знает: занятость считается по дате, а не «вообще»', async () => {
    const yesterday = moscowDateKeyOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${yesterday}&pageSize=500`,
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().onDate).toBe(yesterday);
    const row = (res.json().items as GarageVehicleDto[]).find(
      (item) => item.id === ctx.routeVehicle.id,
    );
    // Рейс заведён на сегодня — вчера машина свободна, и граница периода здесь строгая.
    expect(row?.state).toBe('free');
    expect(row?.busy).toEqual([]);
  });
});
