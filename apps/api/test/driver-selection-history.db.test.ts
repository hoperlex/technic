import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { DriverOption, selectDrivers } from '../src/services/drivers';

/**
 * Исторический отбор водителя (ADR 0101 п. 15): кого можно было посадить за машину в **тот** день.
 *
 * Зачем база. Правило целиком выражено запросом — окно `started_on <= on AND (ended_on IS NULL OR
 * ended_on >= on)` считает Postgres по двум кадровым таблицам сразу, — и проверить его можно только
 * на живой схеме: контрактам о трудовых отношениях не известно ничего. Прежняя проверка
 * («отношение не закрыто») с датой отбора не сверялась вовсе, и разойтись с новой они могут ровно
 * в тех строках, которых в памяти не бывает.
 *
 * Отбор зовётся сервисом, а не HTTP-путём: ту же функцию сервер зовёт и списком для формы, и
 * сверкой присланного водителя (ADR 0037 п. 6), а ручка добавила бы к проверяемому правилу права и
 * схемы запроса. Люди заводятся прямой вставкой: формой заведения дату приёма в прошлом не
 * поставить так свободно, а проверяется здесь именно поведение на кадровых датах.
 *
 * Каждый вопрос задаётся отбором, суженным до одного человека (`personId`): база db-тестов общая и
 * живёт между прогонами, в справочнике сотни чужих водителей, и «попал / не попал» по длине общего
 * списка не проверить. Общий список спрашивается один раз — им и доказывается, что окно стоит в
 * самом запросе, а не в ветке проверки одного человека.
 *
 * Запуск — как у прочих db-тестов (`docs/runbook.md`):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test driver-selection-history
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Даты — от сегодняшнего дня, а не константами: «не попадает на сегодня» проверяется настоящим
 * сегодня, и прибитый гвоздями август через год превратил бы этот тест в проверку двух прошедших
 * дат, где разницы между «сегодня» и «на дату рейса» уже не видно.
 */
function shift(days: number): string {
  return moscowDateKeyOf(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

const TODAY = shift(0);
/** День рейса, который правят задним числом. */
const ROUTE_DAY = shift(-7);
/** Увольнение — после рейса, но до сегодня: ровно тот случай, ради которого правило и менялось. */
const FIRED_ON = shift(-4);
/** Приём на работу — после рейса: такого человека в лист за тот день не поставить. */
const HIRED_LATE_ON = shift(-2);
/** Давний приём: до него кадровых дат в этом тесте нет. */
const LONG_AGO = shift(-400);
/** Перевод в машинисты: последний день на прежней должности и первый на новой. */
const MOVED_LAST_DAY = shift(-5);
const MOVED_FIRST_DAY = shift(-4);

/**
 * СНИЛС здесь — только ключ строки: люди вставляются прямо в таблицу, и контрольную сумму
 * (её считает сервис) никто не спросит. Номер случайный, потому что база общая: номера сида в ней
 * заняты живыми карточками, а прогон должен убирать за собой ровно своих.
 */
function makeSnils(): string {
  return `1${Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join('')}`;
}

/** Табельный уникален среди действующих отношений работодателя — метка своя на прогон. */
const RUN = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

interface Person {
  id: string;
  snils: string;
}

interface Ctx {
  closeDb: () => Promise<void>;
  select: typeof selectDrivers;
  vehicleId: string;
  /** Вёз в день рейса, уволен четырьмя днями позже. */
  fired: Person;
  /** Принят уже после дня рейса. */
  hiredLate: Person;
  /** Удалён из справочника — при действующей специализации. */
  deleted: Person;
  /** Переведён из водителей в машинисты экскаватора между днём рейса и сегодня. */
  moved: Person;
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

interface EmploymentSeed {
  jobTitle: string;
  personnelNo: string;
  startedOn: string;
  endedOn?: string;
}

/**
 * Водитель с заданными кадровыми датами. Удостоверений нет намеренно: список ими не сужается
 * (ADR 0064), а проверяется здесь состав отбора, а не полнота комплекта.
 */
async function seedDriver(params: {
  lastName: string;
  specializationStartedOn: string;
  specializationEndedOn?: string;
  employments: EmploymentSeed[];
  deleted?: boolean;
}): Promise<Person> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization)
    throw new Error('В базе нет специализации «водитель»: миграции не применены');

  const snils = makeSnils();
  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: params.lastName,
        firstName: 'Историк',
        middleName: 'Отборович',
        snils,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: исторический отбор водителя',
        deletedAt: params.deleted ? new Date() : null,
      })
      .returning({ id: schema.persons.id });
    const personId = person!.id;

    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization.id,
      isPrimary: true,
      startedOn: params.specializationStartedOn,
      endedOn: params.specializationEndedOn ?? null,
    });
    for (const e of params.employments) {
      await tx.insert(schema.personEmployments).values({
        personId,
        employmentType: 'staff',
        personnelNo: e.personnelNo,
        jobTitle: e.jobTitle,
        startedOn: e.startedOn,
        endedOn: e.endedOn ?? null,
      });
    }
    return { id: personId, snils };
  });
}

/** Отбор, суженный до одного человека: есть строка — попал, пусто — не попал. */
async function optionOf(person: Person, on: string): Promise<DriverOption | undefined> {
  const selection = await ctx.select({ vehicleId: ctx.vehicleId, on, personId: person.id });
  expect(selection, 'машина отбора пропала из справочника').not.toBeNull();
  return selection!.drivers[0];
}

async function isSelected(person: Person, on: string): Promise<boolean> {
  return (await optionOf(person, on)) !== undefined;
}

describe.skipIf(!DB_URL)('исторический отбор водителя по дате рейса (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { selectDrivers } = await import('../src/services/drivers');

    // Любая неудалённая машина: требование к категории на состав отбора не влияет (ADR 0055) —
    // расхождение по ней едет пометкой, а не убирает человека из списка.
    const vehicles = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicles WHERE deleted_at IS NULL LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    if (!vehicle) throw new Error('В базе нет ни одной машины: миграции не применены');

    ctx = {
      closeDb,
      select: selectDrivers,
      vehicleId: vehicle.id,
      fired: await seedDriver({
        lastName: `Уволенный${RUN}`,
        specializationStartedOn: LONG_AGO,
        specializationEndedOn: FIRED_ON,
        employments: [
          {
            jobTitle: 'Водитель',
            personnelNo: `ИО-${RUN}-1`,
            startedOn: LONG_AGO,
            endedOn: FIRED_ON,
          },
        ],
      }),
      hiredLate: await seedDriver({
        lastName: `Поздний${RUN}`,
        specializationStartedOn: HIRED_LATE_ON,
        employments: [
          { jobTitle: 'Водитель', personnelNo: `ИО-${RUN}-2`, startedOn: HIRED_LATE_ON },
        ],
      }),
      deleted: await seedDriver({
        lastName: `Удалённый${RUN}`,
        specializationStartedOn: LONG_AGO,
        employments: [{ jobTitle: 'Водитель', personnelNo: `ИО-${RUN}-3`, startedOn: LONG_AGO }],
        deleted: true,
      }),
      moved: await seedDriver({
        lastName: `Переведённый${RUN}`,
        specializationStartedOn: LONG_AGO,
        employments: [
          {
            jobTitle: 'Водитель',
            personnelNo: `ИО-${RUN}-4`,
            startedOn: LONG_AGO,
            endedOn: MOVED_LAST_DAY,
          },
          {
            jobTitle: 'Машинист экскаватора',
            personnelNo: `ИО-${RUN}-5`,
            startedOn: MOVED_FIRST_DAY,
          },
        ],
      }),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { db } = await import('../src/db/client');
    // Убирается только заведённое этим прогоном: специализации и трудовые отношения уходят каскадом.
    await db.execute(
      sql`DELETE FROM persons WHERE snils IN (${ctx.fired.snils}, ${ctx.hiredLate.snils},
        ${ctx.deleted.snils}, ${ctx.moved.snils})`,
    );
    await ctx.closeDb();
  });

  it('уволившийся стоит в отборе на дату рейса и не стоит на сегодня', async () => {
    // Он и вёз в тот день; лист за тот день выписывается на него. Сегодня его в списке нет —
    // плановое назначение уволенного человека новым правилом не открывается.
    expect(await isSelected(ctx.fired, ROUTE_DAY)).toBe(true);
    expect(await isSelected(ctx.fired, TODAY)).toBe(false);
  });

  it('день увольнения — ещё рабочий: верхняя граница окна включающая', async () => {
    expect(await isSelected(ctx.fired, FIRED_ON)).toBe(true);
    expect(await isSelected(ctx.fired, shift(-3))).toBe(false);
  });

  it('нанятый после рейса в отбор на дату рейса не попадает', async () => {
    // Иначе «исторический» отбор оказался бы отбором без даты вовсе: в лист за прошлый вторник
    // попал бы человек, вышедший на работу в пятницу.
    expect(await isSelected(ctx.hiredLate, ROUTE_DAY)).toBe(false);
    expect(await isSelected(ctx.hiredLate, TODAY)).toBe(true);
  });

  it('день приёма — уже рабочий: нижняя граница окна тоже включающая', async () => {
    expect(await isSelected(ctx.hiredLate, HIRED_LATE_ON)).toBe(true);
    expect(await isSelected(ctx.hiredLate, shift(-3))).toBe(false);
  });

  it('удалённый не попадает ни на дату рейса, ни на сегодня', async () => {
    // Удаление значит «его здесь не должно быть», а не «он уволился» (ADR 0101 п. 15): специализация
    // у него действующая, и только `deleted_at` держит его вне списка.
    expect(await isSelected(ctx.deleted, ROUTE_DAY)).toBe(false);
    expect(await isSelected(ctx.deleted, TODAY)).toBe(false);
  });

  it('должность берётся та, что действовала на дату рейса', async () => {
    // Должность решает вид документа для листа (ADR 0095): у водителя это водительское
    // удостоверение, у машиниста экскаватора — тракториста-машиниста. Взять сегодняшнюю должность
    // для рейса трёхнедельной давности значило бы выписать лист по документу, которого в тот день
    // с человека никто не спрашивал.
    const atRoute = await optionOf(ctx.moved, ROUTE_DAY);
    expect(atRoute?.jobTitle).toBe('Водитель');
    expect(atRoute?.credentialTypeCode).toBe('driver_license');
    expect(atRoute?.personnelNo).toBe(`ИО-${RUN}-4`);

    const now = await optionOf(ctx.moved, TODAY);
    expect(now?.jobTitle).toBe('Машинист экскаватора');
    expect(now?.credentialTypeCode).toBe('tractor_license');
    expect(now?.personnelNo).toBe(`ИО-${RUN}-5`);
  });

  it('окно стоит в самом запросе: тот же состав в общем списке выбора', async () => {
    // Проверка одного человека и список для формы — одна функция в двух применениях (ADR 0037 п. 6),
    // и разъехаться им негде: если окно окажется только в ветке `personId`, форма покажет не тех.
    const selection = await ctx.select({ vehicleId: ctx.vehicleId, on: ROUTE_DAY });
    const ids = new Set(selection!.drivers.map((d) => d.personId));
    expect(ids.has(ctx.fired.id)).toBe(true);
    expect(ids.has(ctx.hiredLate.id)).toBe(false);
    expect(ids.has(ctx.deleted.id)).toBe(false);
  });
});
