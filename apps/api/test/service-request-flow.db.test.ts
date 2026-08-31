import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatServiceRequestNumber,
  moscowDateKeyOf,
  WARRANTY_EXPIRING_DAYS,
  type OfficeEquipmentServiceEntryDto,
  type ServiceRequestDto,
  type ServiceRequestItemDto,
  type ServiceRequestStatus,
  type ServiceWarrantyRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Заявка на обслуживание оргтехники от заведения до гарантийного обращения (ADR 0085, план §5) —
 * одной цепочкой на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Ценность модуля не в отдельных правилах, а в том, что состояние заявки переживает
 * весь цикл: смета доживает до закрытия ревизией, согласование — до сверки при закрытии, факт —
 * до приёмки, гарантия выполненной строки — до заявки, заведённой по ней через два месяца. Ни
 * одно из этих последствий контрактным тестом не видно: расходятся здесь не правила, а код,
 * схема и порядок шагов в транзакции. Итог по акту считает БД (`amount` и `actual_amount` —
 * GENERATED), сброс факта при возврате упирается в CHECK «гарантии без выполнения не бывает»,
 * «одна открытая заявка на единицу» держит частичный уникальный индекс, а `ON DELETE RESTRICT`
 * на гарантийной ссылке превращает `purge` заявки-источника в 409. Собрать это на моках —
 * значит проверить моки.
 *
 * Поэтому файл идёт **шагами одного сценария**, а не набором изолированных кейсов: каждый `it`
 * продолжает предыдущий, и порядок здесь — часть проверки.
 *
 * Данные готовятся настоящими ручками везде, где портал это умеет. Прямой SQL остаётся ровно в
 * трёх местах, и каждое отмечено комментарием: учётки и контрагенты (форма учётки — не предмет
 * этого файла), строка `files` под подшивку документа (загрузка идёт в S3, которого в тесте нет)
 * и одно состояние, недостижимое через API вовсе, — расхождение ревизий сметы в «В работе».
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/oe_flow_test \
 *     pnpm --filter @technic/api test service-request-flow --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: от него сервер отсчитывает гарантии строк. */
const TODAY = moscowDateKeyOf(new Date());

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: заводит то, чего не заводит никто другой, и делает `purge`. */
  admin: TestUser;
  /** Заказчик — штаб своей площадки: заводит заявку и наблюдает за ней. */
  customer: TestUser;
  /** Оператор оргтехники — тот же штаб плюс надстройка роли (ADR 0086). */
  operator: TestUser;
  /** Согласующий от ИТ (Р51): виза плюс сквозная область модуля — заявки всех площадок. */
  itApprover: TestUser;
  /** Исполнитель — учётка сервисной компании. */
  service: TestUser;
  /**
   * Поимённый исполнитель (Н5, план §7.2): свой сотрудник с набором «Оргтехника: ИТ-служба» —
   * `read`, `approveIt`, `assign`, `hold`, `execute`, `files`. Ни `serviceRequests.status`, ни
   * `.estimate` в наборе нет и не будет: первое открывает весь операторский коридор, второе —
   * ведение сметы. Именно этой парой отсутствий и держится проверка стража «одно из прав».
   */
  namedExecutor: TestUser;
  /**
   * Тот же набор, но **без назначения** на заявку. Без него доказательство неполно: отказ
   * назначенному и отказ постороннему различает не страж, а коридор, и увидеть это можно только
   * двумя одинаково снаряжёнными учётками.
   */
  strayExecutor: TestUser;
  /** Штаб чужой площадки: ни одна заявка этого файла на неё не заводится. */
  foreignShtab: TestUser;
  /** Сотрудник отдела: у него своя ось области — по отделам, а не по объектам. */
  department: TestUser;
  /**
   * Держатель справочников (роль `manager`): ведёт карточки техники, но заявок на обслуживание не
   * видит. Только им и проверяется, что секция обслуживания закрыта правом модуля, а не
   * справочника (§8.2): у всех прочих учёток файла оба права либо есть, либо нет разом.
   */
  keeper: TestUser;
  /**
   * Сотрудник **двух** отделов: без него ветки выбора заказчика (Р5) неразличимы — у учётки с
   * одним отделом подсказка из техники и «единственный отдел» дают один и тот же ответ.
   */
  multiDepartment: TestUser;
  objectId: string;
  /** Чужая площадка: её видит `foreignShtab`, и на неё же не переносится техника (Р7). */
  foreignObjectId: string;
  departmentId: string;
  /** Второй отдел учётки `multiDepartment`. */
  secondDepartmentId: string;
  /** Отдел, к которому ни одна учётка теста не приписана. */
  foreignDepartmentId: string;
  serviceCounterpartyId: string;
  /** Второй сервис: им проверяется, что исполнитель не видит чужие назначенные заявки. */
  otherServiceCounterpartyId: string;
  /** Тип оргтехники из сида: им заводятся единицы, в том числе по ходу самих шагов. */
  typeId: string;
  /** Единица, вокруг которой идёт весь цикл. */
  mfp: { id: string; inventoryNumber: string };
  /** Вторая единица: её заявка даёт «чужую» позицию ремонта для гарантийного обращения. */
  scanner: { id: string };
  /** Техника отдела: по ней роль отдела видит заявку, которую заводила не она. */
  deptPrinter: { id: string };
  /** Техника без владельца: на ней отдел заводит заявку от своего имени. */
  freePrinter: { id: string };
  /** Техника второго отдела: на ней проверяется подсказка из владельца единицы (Р5). */
  hintPrinter: { id: string };
  /** Неразмеченная техника: подсказки из неё нет, и отдел выбирают руками. */
  choicePrinter: { id: string };
  /** Техника чужого отдела: роли отдела она в справочнике не видна (Р7). */
  foreignDeptPrinter: { id: string };
}

let ctx: Ctx;

/**
 * Что сценарий накопил по дороге. Шаги идут цепочкой и передают друг другу идентификаторы —
 * заявку, её строки и заявки-спутники, из которых собираются гарантийные обращения.
 */
const state: {
  /** Главная заявка цикла. */
  main: { id: string; num: number };
  /** Вторая заявка на ту же единицу: отменена со сметой — источник «заявка не принята». */
  cancelled: { id: string; num: number; itemId: string };
  /** Третья заявка на ту же единицу: заведена по гарантии выполненной строки главной. */
  claim: { id: string; num: number };
  /** Заявка на второй единице: её строка — «чужая» позиция ремонта. */
  otherUnit: { id: string; itemId: string };
  /** Заявка на технике отдела, заведённая администратором. */
  deptOwned: { id: string };
  /** Заявка, заведённая самим отделом. */
  deptOwn: { id: string };
  /** Строки главной заявки после закрытия: по ним и обращаются по гарантии. */
  performedItemId: string;
  notPerformedItemId: string;
  expiredItemId: string;
  /** Счёт, подшитый в закрытую заявку: его же снимает распорядитель чужих файлов (§8.3). */
  attachedInvoiceId: string;
  /** Акт главной заявки: подшит **до** приёмки (Р112) — без него её бы не приняли. */
  attachedActId: string;
  /** Заявка со срочностью: на своей единице — по единице разрешена одна открытая заявка (Р21). */
  urgent: { id: string; num: number; equipmentId: string };
} = {
  main: { id: '', num: 0 },
  cancelled: { id: '', num: 0, itemId: '' },
  claim: { id: '', num: 0 },
  otherUnit: { id: '', itemId: '' },
  deptOwned: { id: '' },
  deptOwn: { id: '' },
  performedItemId: '',
  notPerformedItemId: '',
  expiredItemId: '',
  attachedInvoiceId: '',
  attachedActId: '',
  urgent: { id: '', num: 0, equipmentId: '' },
};

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует: документы подшиваются уже загруженными строками `files`.
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а учёток здесь шесть. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * «Дата плюс N месяцев» календарём — ожидаемое значение гарантии, посчитанное независимо от
 * сервера. 31 января плюс месяц — это 28 (29) февраля: в феврале 31-го нет, и без подрезки дата
 * уехала бы в март.
 */
function plusMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 + months, d!));
  if (at.getUTCDate() !== d) at.setUTCDate(0);
  return at.toISOString().slice(0, 10);
}

/** Заведомо истёкшая гарантия: год назад — и такой она останется в любом будущем прогоне. */
/**
 * Десятизначный ИНН по девяти цифрам основы: последняя считается по весам приказа ФНС, и портал
 * проверяет её на каждом заведении контрагента (`isValidInn`).
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

/** «Дата плюс N дней» — порог «истекает» считается сутками, а не месяцами (`WARRANTY_EXPIRING_DAYS`). */
function plusDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const EXPIRED_ON = plusMonths(TODAY, -12);
/**
 * Дата из талона при закрытии: сервер не принимает гарантию, истекающую раньше даты выполнения
 * (это опечатка в году либо чужой талон), поэтому «короткая» гарантия задаётся сроком вперёд, а
 * ветка «гарантия истекла» собирается ниже прямым `UPDATE` — иначе такого состояния через API не
 * получить вовсе.
 */
const SHORT_WARRANTY_ON = plusMonths(TODAY, 1);

// ── Обращения к API ──

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    // Свой адрес на каждый запрос — по той же причине, что и у входа: общий ограничитель считает
    // 300 обращений в минуту с адреса (`app.ts`), а один этот файл проходит цикл заявки полтора
    // десятка раз. С общего адреса он упирался бы в 429 на середине — и падение выглядело бы как
    // дефект модуля, хотя ограничитель отработал ровно так, как задуман.
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

/** Карточка заявки; по умолчанию глазами оператора — он видит все заявки своей площадки. */
async function card(id: string, auth: Auth = ctx.operator.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Текущая версия заявки: её спрашивает каждая изменяющая ручка (Р30). */
async function version(id: string, auth: Auth = ctx.operator.auth): Promise<number> {
  return (await card(id, auth)).version;
}

function itemNamed(dto: ServiceRequestDto, name: string): ServiceRequestItemDto {
  const item = dto.items.find((row) => row.name === name);
  if (!item) throw new Error(`В смете нет строки «${name}»`);
  return item;
}

/** Идентификаторы заявок, видимых субъекту: страница заведомо больше, чем данных у теста. */
async function listIds(auth: Auth, query = ''): Promise<string[]> {
  const res = await inject('GET', `/api/v1/service-requests?pageSize=200${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

/** Идентификаторы единиц справочника, видимых субъекту (Р7): страница заведомо больше данных. */
async function equipmentIds(auth: Auth): Promise<string[]> {
  const res = await inject('GET', '/api/v1/office-equipment?pageSize=200', auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((row) => row.id);
}

/**
 * Загруженный файл строкой в `files`. Настоящая загрузка идёт через presign в S3, которого в
 * тесте нет, а предмет проверки — правила подшивки (§8.3), а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`oe/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

// ── Подготовка данных ──

/**
 * Наименование модели с суффиксом прогона. С миграции `0171` наименование карточки — это имя
 * строки справочника `office_equipment_models`: карточка, заведённая без `model_id`, заводит
 * модель сама. База у db-тестов общая, и в ней лежит копия боевого парка, — без метки прогона
 * уборка не отличила бы свою модель от настоящей и уносила бы либо чужое, либо ничего.
 */
const modelName = (base: string): string => `${base} ${RUN}`;

/** Единица справочника — ручкой оператора: справочник ведёт он (ADR 0085 §3). */
async function makeEquipment(input: {
  typeId: string;
  name: string;
  inventoryNumber: string;
  objectId: string;
  departmentId?: string | null;
}): Promise<string> {
  const res = await inject('POST', '/api/v1/office-equipment', ctx.operator.auth, {
    equipmentTypeId: input.typeId,
    name: modelName(input.name),
    inventoryNumber: input.inventoryNumber,
    objectId: input.objectId,
    departmentId: input.departmentId ?? null,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика: общий вход всех веток сценария. */
async function createRequest(
  auth: Auth,
  officeEquipmentId: string,
  description: string,
  extra: Record<string, unknown> = {},
): Promise<ServiceRequestDto> {
  const res = await inject('POST', '/api/v1/service-requests', auth, {
    officeEquipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  // Заведение отвечает заявкой и исходом письма службе (план `office-equipment-mail-and-history-plan.md`,
  // Р67): сама заявка лежит в `request`.
  return (res.json() as { request: ServiceRequestDto }).request;
}

// Помощник `approveByIt` снят вместе с самой визой (Р10, ADR 0145): ручки `PATCH /:id/it-approval`
// больше нет, порядка двух подписей — тоже. Объём работ согласует один человек, и делает он это
// ручкой `PATCH /:id/estimate/approval`.

/**
 * Заявка, взятая исполнителем в работу: назначение и «принять в работу». Прежде помощник
 * назывался `toDiagnostics` и вёл в одноимённый статус — тот слился с «В работе» (Н2), и смета
 * теперь предъявляется отсюда же.
 */
async function toInWork(id: string): Promise<void> {
  const assigned = await inject(
    'PUT',
    `/api/v1/service-requests/${id}/executors`,
    ctx.operator.auth,
    {
      userIds: [],
      serviceCounterpartyId: ctx.serviceCounterpartyId,
      version: await version(id),
    },
  );
  expect(assigned.statusCode, assigned.body).toBe(200);
  const started = await inject('PATCH', `/api/v1/service-requests/${id}/start`, ctx.service.auth, {
    version: (assigned.json() as { request: ServiceRequestDto }).request.version,
  });
  expect(started.statusCode, started.body).toBe(200);
}

// ── Помощники заморозки и приёмки (план `office-equipment-cycle-changes-plan.md`) ──

/**
 * Рабочие статусы, из которых заявку откладывают (Р106): всё, кроме «Закрыта» и «Отменена».
 *
 * Четыре мёртвых значения в перечень не входят. `it_approved` и `diagnostics` умерли с единым
 * циклом (Н2, Н4), `assigned` и `estimate_review` — миграцией 0224 (Р1): заявок в них не бывает,
 * `service_requests_dead_status_check` их запрещает, и собрать такую заявку помощнику нечем.
 * Ожидания, которые они означали, стали признаками строки — состав исполнителей и непогашенное
 * предъявление, — и заморозка их не различает: заявка «Новая с исполнителями» откладывается тем
 * же ходом, что и «Новая» без них, и возвращается в тот же статус.
 *
 * **`done` из перечня ушла не по той же причине, и это расхождение, а не решение.** План (§6.2)
 * требует заморозку из «Решена» прямо и дважды: сегодняшнее поведение (Р106 ADR 0125) и
 * единственный способ снять заявку с автозакрытия руками. Контракты волны В1 объявили
 * `SERVICE_HOLD_TRANSITIONS.done = []` — маршрут спрашивает их и отвечает 403. Пока таблица не
 * исправлена, гонять этот статус через помощника значило бы закрепить в тесте поведение, которого
 * план не разрешал.
 */
const WORKING_STATUSES = ['new', 'in_work'] as const satisfies readonly ServiceRequestStatus[];

/**
 * Заявка, доведённая до нужного рабочего статуса своими ручками.
 *
 * Помощником, а не семью выписанными цепочками: заморозка проверяется из **каждого** статуса
 * (Р106), и повторить ради этого назначение, диагностику, смету и закрытие семь раз значило бы
 * семь раз переписать сам цикл — а расходиться эти семь копий начали бы с первой же правки.
 */
async function driveTo(id: string, target: ServiceRequestStatus): Promise<void> {
  if (target === 'new') return;

  const assigned = await inject(
    'PUT',
    `/api/v1/service-requests/${id}/executors`,
    ctx.operator.auth,
    { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: await version(id) },
  );
  expect(assigned.statusCode, assigned.body).toBe(200);
  // Назначение статуса не меняет (Р5): «Назначена» снята, и цели `assigned` у помощника нет вовсе.

  const started = await inject('PATCH', `/api/v1/service-requests/${id}/start`, ctx.service.auth, {
    version: (assigned.json() as { request: ServiceRequestDto }).request.version,
  });
  expect(started.statusCode, started.body).toBe(200);

  const put = await inject('PUT', `/api/v1/service-requests/${id}/estimate`, ctx.service.auth, {
    items: [
      {
        kind: 'service',
        name: 'Чистка узла подачи',
        quantity: 1,
        unitPrice: 1000,
        warrantyMonths: 3,
      },
    ],
    version: started.json().version,
  });
  expect(put.statusCode, put.body).toBe(200);
  const submitted = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/submit`,
    ctx.service.auth,
    { version: put.json().version },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);

  // Подпись одна (Р10): виза ИТ упразднена, порядка двух подписей больше нет. Согласие статуса не
  // меняет — заявка как стояла в «В работе», так и стоит, — и гасит предъявление.
  const approved = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/approval`,
    ctx.operator.auth,
    { approved: true, version: await version(id) },
  );
  expect(approved.statusCode, approved.body).toBe(200);
  if (target === 'in_work') return;

  // Планка закрывающего документа переехала на «Решена» (Н8): заявку, назначенную сервису, без
  // бумаги туда не пускают, и помощник обязан её подшить — иначе он собирал бы состояние, которого
  // в новом цикле не бывает.
  await attachClosingDocument(id);

  const before = await card(id);
  const completed = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/complete`,
    ctx.service.auth,
    {
      completedOn: TODAY,
      items: before.items.map((item) => ({ id: item.id, performed: true })),
      version: before.version,
    },
  );
  expect(completed.statusCode, completed.body).toBe(200);
  if (target === 'done') return;

  throw new Error(`Статус «${target}» этим помощником не собирается`);
}

/** Акт исполнителя: с ним заявка сервиса и уходит в «Решена» (Н8). */
async function attachClosingDocument(id: string, kind = 'act'): Promise<string> {
  const fileId = await uploadedFile(ctx.service.id, `${kind}-${randomUUID()}.pdf`);
  const res = await inject('POST', `/api/v1/service-requests/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind,
  });
  expect(res.statusCode, res.body).toBe(200);
  return fileId;
}

/** Закрытие работ по всей смете: исполнитель предъявляет то, что и было согласовано. */
async function completeWork(id: string) {
  const before = await card(id);
  return inject('PATCH', `/api/v1/service-requests/${id}/complete`, ctx.service.auth, {
    completedOn: TODAY,
    items: before.items.map((item) => ({ id: item.id, performed: true })),
    version: before.version,
  });
}

/** Закрывающий документ, подшитый помощником: снимать его будут по этому же id. */
async function closingFileId(id: string): Promise<string> {
  const file = (await card(id)).files.find((f) => f.kind === 'act');
  if (!file) throw new Error('У заявки нет подшитого акта');
  return file.id;
}

/** Своя единица под каждую заявку помощника: по технике разрешена одна открытая заявка (Р21). */
let extraUnitNo = 0;
async function freshUnit(): Promise<string> {
  extraUnitNo += 1;
  return makeEquipment({
    typeId: ctx.typeId,
    name: 'Kyocera FS-1040',
    // Суффикс прогона тот же, что у остальной техники файла: уборка ищет по нему (`afterAll`).
    inventoryNumber: `ОЕ-${RUN}-h${extraUnitNo}`,
    objectId: ctx.objectId,
  });
}

/** Заявка на своей единице, доведённая до нужного статуса. */
async function requestIn(
  status: ServiceRequestStatus,
  description: string,
): Promise<ServiceRequestDto> {
  const dto = await createRequest(ctx.customer.auth, await freshUnit(), description);
  await driveTo(dto.id, status);
  return card(dto.id);
}

/**
 * Заявка **распределённая, но не взятая в работу** — то, что прежде звалось статусом «Назначена».
 * Своим помощником, а не целью `driveTo`: статуса у этого состояния больше нет (Р1), и называет
 * его теперь состав исполнителей — «Новая», у которой они есть (Р2). Помощник это и утверждает
 * сразу: статус «Новая», сервис назначен, ждут исполнителя.
 */
async function assignedRequest(description: string): Promise<ServiceRequestDto> {
  const dto = await createRequest(ctx.customer.auth, await freshUnit(), description);
  const assigned = await inject(
    'PUT',
    `/api/v1/service-requests/${dto.id}/executors`,
    ctx.operator.auth,
    { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: dto.version },
  );
  expect(assigned.statusCode, assigned.body).toBe(200);
  const after = (assigned.json() as { request: ServiceRequestDto }).request;
  expect(after.status).toBe('new');
  expect(after.waitingOn).toBe('service');
  return after;
}

/**
 * Предъявить объём работ заново по заявке в «В работе»: снять то, что мешает (подпись либо своё
 * же висящее предъявление), заменить состав и предъявить. Одним помощником, потому что после Р9
 * замков стало два и оба открываются одним ключом — «вернуть объём работ в правку».
 *
 * Статуса ни один из трёх шагов не меняет (Р8): всё это время заявка стоит в «В работе», а
 * ожидание подписи открывает и гасит колонка `estimate_pending_revision`.
 */
async function submitEstimate(
  id: string,
  items: Record<string, unknown>[] = [
    { kind: 'service', name: 'Замена ролика', quantity: 1, unitPrice: 1200, warrantyMonths: 3 },
  ],
): Promise<ServiceRequestDto> {
  const before = await card(id);
  if (before.estimatePendingRevision !== null || before.approval !== null) {
    const reopened = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/estimate/reopen`,
      ctx.service.auth,
      { reason: 'Пересчитываем состав', version: before.version },
    );
    expect(reopened.statusCode, reopened.body).toBe(200);
  }
  const put = await inject('PUT', `/api/v1/service-requests/${id}/estimate`, ctx.service.auth, {
    items,
    version: await version(id),
  });
  expect(put.statusCode, put.body).toBe(200);
  const submitted = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/submit`,
    ctx.service.auth,
    { version: (put.json() as ServiceRequestDto).version },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  const after = submitted.json() as ServiceRequestDto;
  expect(after.status).toBe('in_work');
  expect(after.estimatePendingRevision).toBe(after.estimateRevision);
  expect(after.waitingOn).toBe('approval');
  return after;
}

/**
 * Заявка с **предъявленным и непогашенным объёмом работ** — то, что прежде звалось «Смета на
 * согласовании». Статуса у состояния нет (Р1): заявка стоит в «В работе», а ожидание подписи
 * держит колонка `estimate_pending_revision` (Р2).
 */
async function pendingEstimateRequest(description: string): Promise<ServiceRequestDto> {
  const dto = await createRequest(ctx.customer.auth, await freshUnit(), description);
  await driveTo(dto.id, 'in_work');
  return submitEstimate(dto.id);
}

/** Заморозка: причина обязательна (Р107), а куда вернуть — сервер берёт из самой заявки (Р104). */
function hold(id: string, reason: string, auth: Auth = ctx.operator.auth) {
  return version(id).then((v) =>
    inject('PATCH', `/api/v1/service-requests/${id}/hold`, auth, { reason, version: v }),
  );
}

/** Возврат из заморозки: цель клиент не присылает — она в `held_from_status`. */
function resume(id: string, auth: Auth = ctx.operator.auth, comment = '') {
  return version(id).then((v) =>
    inject('PATCH', `/api/v1/service-requests/${id}/resume`, auth, { comment, version: v }),
  );
}

/** Приёмка глазами оператора: версию спрашивает каждая изменяющая ручка (Р30). */
function acceptWork(id: string) {
  return version(id).then((v) =>
    inject('PATCH', `/api/v1/service-requests/${id}/accept`, ctx.operator.auth, { version: v }),
  );
}

/** Подшитый документ вместе с id самого файла: снимать его будут по нему же. */
async function attach(
  id: string,
  kind: string,
  filename: string,
  auth: Auth = ctx.service.auth,
  userId: string = ctx.service.id,
) {
  const fileId = await uploadedFile(userId, filename);
  const res = await inject('POST', `/api/v1/service-requests/${id}/files`, auth, {
    fileIds: [fileId],
    kind,
  });
  return { fileId, res };
}

/** Число для бейджа раздела: та же очередь «ждут меня», но своей ручкой (Р35). */
async function waitingCount(auth: Auth): Promise<number> {
  const res = await inject('GET', '/api/v1/service-requests/waiting-count', auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().count as number;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ответ ручки: тот же тип, что отдаёт `inject`, — нужен помощнику гонки под именем. */
type Injected = Awaited<ReturnType<typeof inject>>;

describe.skipIf(!DB_URL)('обслуживание оргтехники: сквозной цикл на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагенты, площадка и отдел заводятся SQL: форма учётки и справочник контрагентов —
    // предмет своих тестов, а здесь они только декорации, без которых не разложить три стороны.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${`db-oe-${input.tag}-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь',
                ${input.tag}, ${passwordHash}, ${sql.raw(`'${input.role}'::role`)},
                true, now(), ${input.counterpartyId ?? null})
        RETURNING id, email`);
      const row = res.rows[0]!;
      return { id: row.id, email: `db-oe-${input.tag}-${RUN}@example.invalid` };
    }

    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    // ИНН — с настоящей контрольной суммой, а не «77…01»: пока идёт прогон, контрагенты лежат в
    // общей базе (а после падения остаются там и вовсе), а обмен справочниками
    // (`directory-transfer.db`) выгружает её целиком и загружает обратно — на выдуманном ИНН он
    // падает, и падение выглядит как дефект чужого модуля.
    const digits = String(Date.now()).slice(-6);
    const serviceCounterpartyId = await counterparty(`Сервис-Про ${RUN}`, innOf(`77${digits}0`));
    const otherServiceCounterpartyId = await counterparty(
      `Сервис-Альт ${RUN}`,
      innOf(`77${digits}1`),
    );

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OE-${RUN}`}, ${`Тестовая площадка ОЕ ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;
    const foreignRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OE-F-${RUN}`}, ${`Тестовая чужая площадка ОЕ ${RUN}`}, 'г Москва, ул Чужая, д 2')
      RETURNING id`);
    const foreignObjectId = foreignRow.rows[0]!.id;

    /** Отдел — три штуки: свой, второй у сотрудника двух отделов и заведомо чужой (Р5, Р7). */
    const makeDepartment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`OE-${tag}-${RUN}`}, ${`Тестовый отдел ${tag} ${RUN}`})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const departmentId = await makeDepartment('D');
    const secondDepartmentId = await makeDepartment('D2');
    const foreignDepartmentId = await makeDepartment('DF');

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({
      tag: 'serv',
      role: 'operator',
      counterpartyId: serviceCounterpartyId,
    });
    const foreignShtab = await makeUser({ tag: 'fshtab', role: 'shtab' });
    const department = await makeUser({ tag: 'dept', role: 'department' });
    const multiDepartment = await makeUser({ tag: 'dept2', role: 'department' });
    const keeper = await makeUser({ tag: 'keeper', role: 'manager' });
    // Согласующий от ИТ: роль отдела и **чужой** отдел в области. Именно чужой — так проверяется,
    // что заявки он видит не по своей роли, а по надстройке (Р54).
    const itApprover = await makeUser({ tag: 'it', role: 'department' });
    // Две учётки поимённого исполнителя: обе — штаб своей площадки, обе с набором ИТ-службы, и
    // отличаются они ровно назначением на заявку.
    const namedExecutor = await makeUser({ tag: 'exec', role: 'shtab' });
    const strayExecutor = await makeUser({ tag: 'stray', role: 'shtab' });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${namedExecutor.id}, ${objectId}), (${strayExecutor.id}, ${objectId}),
             (${foreignShtab.id}, ${foreignObjectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${department.id}, ${departmentId}),
             (${multiDepartment.id}, ${departmentId}),
             (${multiDepartment.id}, ${secondDepartmentId}),
             (${itApprover.id}, ${foreignDepartmentId})`);
    // Надстройка роли (ADR 0086): тот же штаб, но со стороной оператора оргтехники. Роль у него
    // остаётся `shtab` — именно это и проверяет коридор: право статуса у надстройки есть, а шаги
    // исполнителя ей всё равно не положены.
    //
    // Заводится она **сервисом**, а не прямым SQL, — единственное исключение среди декораций этого
    // блока, и вот почему. С шага 1a перехода на назначаемые полномочия (ADR 0106, решение 9)
    // выдача надстройки пишет две таблицы одной транзакцией: `user_role_addons` и `user_grants`.
    // Прямая вставка в старую таблицу оставила бы половину — на шаге 1c, когда права читаются уже
    // из назначений, оператор и виза ИТ молча лишились бы своих прав, и сценарий упал бы шагов на
    // двадцать ниже, в проверке чужого правила. Заодно такая фикстура — расхождение для сверки шага
    // 1b (`backfill:grants`), которая идёт по всей базе и о чужих тестах ничего не знает.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
      await replaceUserAddons(tx, itApprover.id, ['office_equipment_it_approver'], admin.id);
    });

    /**
     * Набор «Оргтехника: ИТ-служба» (план §7.2) — своим кодом на прогон, а не системным
     * `office_equipment_it_approver`: состав системного набора до волны В5 остаётся прежним (одна
     * виза ИТ), и подмешать в него `execute` значило бы править поставочные права ради теста.
     * Прогонный набор даёт ровно тот состав, который волна В5 и выдаст, — и проверяет он стража, а
     * не каталог.
     *
     * Прямым SQL по той же причине, что и учётки: форма набора — предмет своего теста. Роль в
     * `grant_roles` обязательна: права набора считаются через гейт совместимости с ролью
     * (`grantPermissionsExpr`), и без строки `shtab` учётки не получили бы ни одного права.
     */
    const executorGrantCode = `oe-it-service-${RUN}`;
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${executorGrantCode}, ${`Оргтехника: ИТ-служба ${RUN}`},
              'Набор поимённого исполнителя заявок оргтехники (план переработки цикла §7.2)',
              false, ${admin.id})
      RETURNING id`);
    const executorGrantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      SELECT ${executorGrantId}, permission
      FROM unnest(ARRAY['serviceRequests.read', 'serviceRequests.approveIt',
                        'serviceRequests.assign', 'serviceRequests.hold',
                        'serviceRequests.execute', 'serviceRequests.files']) AS permission`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${executorGrantId}, 'shtab'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${namedExecutor.id}, ${executorGrantId}, ${admin.id}),
             (${strayExecutor.id}, ${executorGrantId}, ${admin.id})`);

    const app = await buildApp();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      customer: await withAuth(customer),
      operator: await withAuth(operator),
      service: await withAuth(service),
      foreignShtab: await withAuth(foreignShtab),
      department: await withAuth(department),
      multiDepartment: await withAuth(multiDepartment),
      keeper: await withAuth(keeper),
      itApprover: await withAuth(itApprover),
      namedExecutor: await withAuth(namedExecutor),
      strayExecutor: await withAuth(strayExecutor),
      objectId,
      foreignObjectId,
      departmentId,
      secondDepartmentId,
      foreignDepartmentId,
      serviceCounterpartyId,
      otherServiceCounterpartyId,
      typeId,
      mfp: { id: '', inventoryNumber: '' },
      scanner: { id: '' },
      deptPrinter: { id: '' },
      freePrinter: { id: '' },
      hintPrinter: { id: '' },
      choicePrinter: { id: '' },
      foreignDeptPrinter: { id: '' },
    };

    const inventoryNumber = `ОЕ-${RUN}-1`;
    ctx.mfp = {
      id: await makeEquipment({
        typeId,
        name: 'Kyocera ECOSYS M3145',
        inventoryNumber,
        objectId,
      }),
      inventoryNumber,
    };
    ctx.scanner = {
      id: await makeEquipment({
        typeId,
        name: 'HP ScanJet 5000',
        inventoryNumber: `ОЕ-${RUN}-2`,
        objectId,
      }),
    };
    ctx.deptPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Xerox B310',
        inventoryNumber: `ОЕ-${RUN}-3`,
        objectId,
        departmentId,
      }),
    };
    ctx.freePrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Brother HL-1223',
        inventoryNumber: `ОЕ-${RUN}-4`,
        objectId,
      }),
    };
    // Владелец — **второй** отдел учётки: подсказка обязана прийти из карточки техники, а не из
    // набора отделов автора, и на первом отделе набора эти два ответа неразличимы.
    ctx.hintPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Canon i-SENSYS LBP223',
        inventoryNumber: `ОЕ-${RUN}-5`,
        objectId,
        departmentId: secondDepartmentId,
      }),
    };
    ctx.choicePrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Pantum P3300',
        inventoryNumber: `ОЕ-${RUN}-6`,
        objectId,
      }),
    };
    ctx.foreignDeptPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Ricoh SP 330',
        inventoryNumber: `ОЕ-${RUN}-7`,
        objectId,
        departmentId: foreignDepartmentId,
      }),
    };
  }, 180_000);

  /**
   * Уборка: база у db-тестов общая и живёт между прогонами, поэтому файл уносит ровно то, что
   * завёл сам. Опознаётся всё по суффиксу прогона (`RUN`), а порядок задан внешними ключами:
   * гарантийная ссылка объявлена `RESTRICT` и держит строку сметы, заявки держат технику,
   * учётку-автора и контрагента-исполнителя, техника — площадку и отдел. Каскады остального
   * (строки сметы, документы, история статусов, объекты и отделы учёток) сработают сами.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ОЕ-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-oe-%-${RUN}@example.invalid`}`;
      // События журнала остатка, оставленные случаем про выдачу расходников. Их надо снять первыми:
      // на заявку и на автора они ссылаются `RESTRICT`ом, и без этого не удалить ни заявку, ни
      // учётку. Строки журнала неизменяемы триггером (Р11), круг размыкает только временное
      // гашение — одной транзакцией и обратно `ENABLE ALWAYS`, как в `service-request-consumables.db`.
      const расходники = sql`SELECT id FROM office_equipment_consumables WHERE code LIKE ${`ДFLOW${RUN.toUpperCase()}%`}`;
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`
          ALTER TABLE office_equipment_consumable_stock_entries
            DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
        await tx.execute(sql`
          DELETE FROM office_equipment_consumable_stock_entries WHERE consumable_id IN (${расходники})`);
        await tx.execute(sql`
          ALTER TABLE office_equipment_consumable_stock_entries
            ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
      });
      // Обращение по гарантии ссылается на строку сметы другой заявки: пока ссылка стоит, ни ту,
      // ни другую заявку не удалить одним запросом — `RESTRICT` проверяется построчно.
      await ctx.db.execute(sql`
        UPDATE service_requests SET warranty_claim_source = NULL, warranty_claim_item_id = NULL
        WHERE office_equipment_id IN (${equipment})`);
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      await ctx.db.execute(sql`DELETE FROM office_equipment_consumables WHERE id IN (${расходники})`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`ОЕ-${RUN}-%`}`,
      );
      // Модели, заведённые карточками этого файла. С миграции `0171` наименование карточки — это
      // имя строки справочника `office_equipment_models`, и вставка без `model_id` заводит модель
      // сама; удаление карточки её за собой не уносит, а база у db-тестов общая — за неделю
      // прогонов справочник зарастёт именами фикстур. Отбор идёт по суффиксу прогона в самом
      // наименовании: копию боевого парка в этой базе он не заденет. Проверка «карточек не
      // осталось» — страховка от `ON DELETE RESTRICT` у ссылки карточки: пережившая уборку
      // карточка уронила бы `afterAll` отказом внешнего ключа вместо тихо оставленной строки.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      // Отложенное удаление из S3 (задача outbox) вместе с самим файлом: хранилища в тесте нет,
      // и задача осталась бы висеть в очереди живого планировщика.
      await ctx.db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${`oe/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`oe/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-oe-%-${RUN}@example.invalid`}`,
      );
      // Набор прогона: назначения ушли каскадом вместе с учётками, состав и роли уйдут с ним самим.
      await ctx.db.execute(sql`DELETE FROM grants WHERE code = ${`oe-it-service-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE name LIKE ${`Сервис-% ${RUN}`}`);
      // Отделы раньше площадок: у отдела бывает своя площадка (ADR 0062), и ссылка на неё —
      // `RESTRICT`. У отделов этого теста её нет, но порядок не должен зависеть от этого.
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`OE-%${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`OE-%${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── Шаг 1. Заявка заведена ──

  it('заказчик заводит заявку: снимок предмета, статус «Новая», ждут распределения', async () => {
    // «Желаемого срока» у заявки больше нет (Р115): давность читается возрастом в статусе, и он
    // точнее отвечает на вопрос «кто тянет».
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Не захватывает бумагу из нижнего лотка',
    );
    state.main = { id: dto.id, num: dto.num };

    expect(dto.status).toBe('new');
    // Кого ждут — считает сервер: правило одно на список, карточку и бейдж раздела (Р35).
    // «Новую» ждёт тот, кто распределяет: визы на входе больше нет (Н3), и до назначения с
    // заявкой ничего не происходит.
    expect(dto.waitingOn).toBe('operator');
    expect(dto.itApproval).toBeNull();
    // Вид заявки — ремонт: он умолчание и остаётся им навсегда (решение 9 ADR 0133). Заявку на
    // расходники заводят, явно назвав `kind`, и её цикл проверяет service-request-consumables.db.
    expect(dto.kind).toBe('repair');
    // Подразделение заявителя проставляет сервер по учётке автора (Н11): у штаба отделов нет, и
    // подразделением становится его площадка — со снимком названия, а не одной ссылкой.
    expect(dto.requesterPlace).toMatchObject({ kind: 'object', id: ctx.objectId });
    expect(dto.requesterPlace?.name).toBeTruthy();
    expect(dto.executors).toEqual([]);
    expect(dto.replacementRecommended).toBe(false);
    expect(dto.acceptanceSource).toBeNull();
    expect(dto.displayNumber).toBe(formatServiceRequestNumber(dto.num));
    // Реквизиты предмета — снимок: единицу перенесут и переименуют, а заявка обязана остаться
    // рассказом о том, что чинили тогда (Р10).
    expect(dto.equipment).toMatchObject({
      id: ctx.mfp.id,
      name: modelName('Kyocera ECOSYS M3145'),
      inventoryNumber: ctx.mfp.inventoryNumber,
      typeName: 'МФУ',
      // Место внутри объекта — часть того же снимка (Р57): по нему едет мастер, а карточка к
      // моменту ремонта могла переехать.
      location: 'кабинет 214',
    });
    expect(dto.object.id).toBe(ctx.objectId);
    // Заявку завёл штаб: отделов у него нет, и заявка объектная, а не «ничья, видная всем».
    expect(dto.customerDepartment).toBeNull();
    expect(dto.service).toBeNull();
    expect(dto.estimateRevision).toBe(0);
    expect(dto.items).toEqual([]);
    expect(dto.version).toBe(0);
  });

  it('вторая заявка на ту же единицу отклоняется номером первой (Р21)', async () => {
    // Две параллельные заявки означали бы два сервиса, два акта и две гарантии на одну работу.
    // Номер в ответе — не украшение: портал вместо глухого отказа предлагает открыть эту заявку.
    const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
      officeEquipmentId: ctx.mfp.id,
      description: 'Тот же аппарат, второй заход',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(formatServiceRequestNumber(state.main.num));
  });

  it('«Новую» заявку сервис не видит: исполнителя в ней ещё нет', async () => {
    // Следствие области исполнителя, принятое в ADR 0085 сознательно: до назначения заявка ничья.
    expect(await listIds(ctx.service.auth)).not.toContain(state.main.id);
    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.service.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  // ── Шаг 2. Виза отдела ИТ упразднена (Р10) ──
  //
  // Случай «визу ИТ на „Новую“ не ставят» снят: ставить нечего и нечем — ручка `PATCH
  // /:id/it-approval` удалена, `SERVICE_IT_TRANSITIONS` пуста, а вопрос «чинить или менять» задаёт
  // себе тот же человек, что смотрит на объём работ (ответ В2). Область согласующего от ИТ при
  // этом никуда не делась — её проверяет случай ниже, — потому что надстройка модуля даёт не визу,
  // а видимость чужих площадок.

  it('согласующий от ИТ видит чужую площадку: область даёт надстройка, а не роль', async () => {
    // Учётка ИТ приписана к постороннему отделу и не имеет ни одного объекта: по своей роли она не
    // увидела бы эту заявку вовсе (Р54).
    expect(await listIds(ctx.itApprover.auth)).toContain(state.main.id);
    const card = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.itApprover.auth,
    );
    expect(card.statusCode, card.body).toBe(200);
    // Справочник — тоже: перед визой смотрят, что за аппарат и что с ним уже делали.
    const equipment = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.mfp.id}`,
      ctx.itApprover.auth,
    );
    expect(equipment.statusCode, equipment.body).toBe(200);
  });

  it('«Новую» ждёт распределяющий — и это все, кто умеет назначать', async () => {
    const card = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.operator.auth,
    );
    expect(card.json().waitingOn).toBe('operator');
    expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).toContain(state.main.id);
    /*
     * ИТ-служба **тоже** видит «Новую» в своей очереди, и это не регрессия, а следствие волны В5:
     * вместе с набором она получила `serviceRequests.assign` — взять чужую заявку можно, только
     * назначив на неё себя (§6.1). До В5 право было лишь у «Ведения», и очередь ИТ на «Новой»
     * действительно пустовала.
     *
     * Очередь считается стороной `waitingOn`, а сторона «operator» — это «тот, кто распределяет», а
     * не конкретный набор: расширился круг распределяющих — расширилась и очередь. Виза ИТ по-
     * прежнему начинается со сметы, и это проверяет соседний случай.
     */
    expect(await listIds(ctx.itApprover.auth, '&waitingOnMe=true')).toContain(state.main.id);
  });

  // Случай «оператор визы не имеет» снят вместе с визой (Р10): проверять разделение двух подписей
  // не на чем — подпись осталась одна. Кто её ставит, разбирает согласование объёма работ ниже:
  // оператор подрядчика исключён из согласующих явно (Р3), и это отдельный случай.

  /**
   * «Не согласовано» — второй исход единственной оставшейся подписи (Р8, В1), и спрашивает он
   * теперь ТРИ вещи вместо одной. Причина отвечает, почему объём не согласован, и уходит
   * комментарием перехода в историю; решение («что делаем вместо») остаётся полем заявки, потому
   * что с него начинается разбор отклонённой через месяц; галочка замены стала ответом человека, а
   * не выводом ручки — прежде отказ ИТ означал «не чинить, значит менять», и флаг проставлялся сам.
   *
   * Проверяются все три и жизненный цикл решения: `CHECK` в базе держит его только у отменённой,
   * а откат «Отменена → Новая» обязан снять обе пометки разом — не сними он решение, откат упёрся
   * бы в `service_requests_rejection_resolution_check` ошибкой БД (Р12).
   */
  it('«не согласовано» закрывает заявку причиной, решением и пометкой замены — и все три обязательны', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.choicePrinter.id,
      'Хочу второй монитор к рабочему месту',
    );
    // Решают «чинить за эти деньги или менять аппарат», и без предъявленного объёма работ у
    // решения нет предмета: согласование требует непогашенного предъявления (Р11).
    await driveTo(dto.id, 'in_work');
    const submitted = await submitEstimate(dto.id);
    expect(submitted.estimatePendingRevision).toBe(submitted.estimateRevision);

    const silent = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: false, version: await version(dto.id) },
    );
    // Оба текста обязательны схемой: «не согласовано» без объяснения заказчик прочитает как
    // молчание, а без решения спор по заявке через месяц начинается с нуля (Р12).
    expect(silent.statusCode, silent.body).toBe(400);
    const fields = (silent.json() as { fields?: Record<string, string> }).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(['reason', 'resolution']);

    const rejected = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/estimate/approval`,
      ctx.operator.auth,
      {
        approved: false,
        reason: 'Ремонт дороже нового аппарата',
        resolution: 'Меняем аппарат, заявка на закупку заведена',
        replacementRecommended: true,
        version: await version(dto.id),
      },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    // Своего терминального статуса у отказа нет (Р53): заявка закрыта тем же «Отменена», а
    // отличают его событие истории, решение и пометка «рекомендована замена» (В21).
    const after = rejected.json() as ServiceRequestDto;
    expect(after.status).toBe('cancelled');
    expect(after.replacementRecommended).toBe(true);
    expect(after.rejectionResolution).toBe('Меняем аппарат, заявка на закупку заведена');
    // Ответ получен — предъявление погашено: иначе отменённая заявка осталась бы в очереди подписи.
    expect(after.estimatePendingRevision).toBeNull();
    expect(after.waitingOn).toBe('nobody');

    // Возврат отменённой в «Новую» снимает ОБЕ пометки разом (флаг `rejection` матрицы сброса,
    // Р12): они всегда живут и умирают вместе, а решение вдобавок держит `CHECK` — оставленное, оно
    // уронило бы сам откат ошибкой БД.
    const back = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/status`,
      ctx.admin.auth,
      { status: 'new', reason: 'Вернули по просьбе заказчика', version: await version(dto.id, ctx.admin.auth) },
    );
    expect(back.statusCode, back.body).toBe(200);
    const returned = (back.json() as { request: ServiceRequestDto }).request;
    expect(returned.replacementRecommended).toBe(false);
    expect(returned.rejectionResolution).toBe('');
    expect(returned.status).toBe('new');
    const closed = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/status`,
      ctx.admin.auth,
      { status: 'cancelled', reason: 'Служебная заявка теста', version: await version(dto.id, ctx.admin.auth) },
    );
    expect(closed.statusCode, closed.body).toBe(200);

    // Решение доходит до ленты элементом `changes`, а не полем рядом с `revision` (Р12): сборка
    // истории читает только `metadata.changes`, и положенное иначе она молча пропустила бы.
    const history = await inject(
      'GET',
      `/api/v1/service-requests/${dto.id}/history`,
      ctx.itApprover.auth,
    );
    const events = history.json() as {
      kind: string;
      changes?: { field: string; to: string }[];
    }[];
    expect(events.map((e) => e.kind)).toContain('estimateRejected');
    const rejection = events.find((e) => e.kind === 'estimateRejected')!;
    expect(rejection.changes?.map((c) => c.field)).toContain('rejectionResolution');
    expect(rejection.changes?.find((c) => c.field === 'rejectionResolution')?.to).toBe(
      'Меняем аппарат, заявка на закупку заведена',
    );
  });

  it('автовизы при заведении больше нет: заявка согласующего от ИТ тоже «Новая»', async () => {
    const own = await createRequest(
      ctx.itApprover.auth,
      ctx.foreignDeptPrinter.id,
      'Гудит блок питания',
    );
    // Прежде заявку обладателя визы подписывала сама система (Р52): подписывать себе заявку
    // вторым действием на входе было ритуалом. Виза по смете — решение по **чужому счёту** (Н3),
    // и автоматической быть не может: `it_approved_auto` из эксплуатации выведен.
    expect(own.status).toBe('new');
    expect(own.itApproval).toBeNull();

    const byAdmin = await createRequest(ctx.admin.auth, ctx.hintPrinter.id, 'Не включается');
    expect(byAdmin.status).toBe('new');
    expect(byAdmin.itApproval).toBeNull();

    // Прибираем за собой: обе заявки открытые, а по единице разрешена одна (Р21).
    for (const id of [own.id, byAdmin.id]) {
      const cancelled = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/status`,
        ctx.admin.auth,
        {
          status: 'cancelled',
          reason: 'Служебная заявка теста',
          version: await version(id, ctx.admin.auth),
        },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }
  });

  // ── Шаг 3. Исполнитель назначен — но статуса это не меняет (Р5) ──

  it('оператор назначает сервис — заявка остаётся «Новой» и становится видна исполнителю', async () => {
    const res = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        version: await version(state.main.id),
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    // Назначение отвечает парой «заявка + исход письма исполнителям» (Н13).
    const dto = (res.json() as { request: ServiceRequestDto }).request;
    /*
     * Статуса назначение не меняет (Р5): «Назначена» означала не состояние заявки, а ожидание
     * нажатия кнопки исполнителем, и видно это ожидание без статуса — по составу исполнителей.
     * Поэтому проверяется пара: статус прежний, а очередь уже другая — ждут не распределяющего, а
     * того, кто возьмётся (`serviceRequestWaitingOn`, таблица Р2).
     */
    expect(dto.status).toBe('new');
    expect(dto.waitingOn).toBe('service');
    expect(dto.service?.id).toBe(ctx.serviceCounterpartyId);

    // Событие в ленте всё равно есть: строка истории кладётся `from = to`, иначе «у заявки
    // появился исполнитель» осталось бы без следа.
    const history = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}/history`,
      ctx.operator.auth,
    );
    const statuses = (
      history.json() as { kind: string; fromStatus: string | null; toStatus: string | null }[]
    )
      .filter((e) => e.kind === 'status')
      .map((e) => `${e.fromStatus}→${e.toStatus}`);
    expect(statuses).toContain('new→new');

    expect(await listIds(ctx.service.auth)).toContain(state.main.id);
  });

  /**
   * **Заказчик правит заявку, пока её никому не отдали** (Р14). Прежде на этот вопрос отвечал сам
   * статус: назначение уводило заявку в «Назначенную», а правка была открыта только в «Новой».
   * После слияния (Р1) оба состояния зовутся «Новой», и, оставь предикат `status === 'new'`,
   * правка молча открылась бы у заявки, которую исполнитель уже прочитал и по которой договорился.
   *
   * Удаление при этом — СВОЁ правило, а не «то же, что правка» (В20): назначенную заявку удалять
   * можно, работа по ней не начиналась. Проверяются оба рядом, иначе следующая правка приняла бы
   * их совпадение по статусу за один общий перечень.
   */
  it('назначенную заявку заказчик уже не правит, но ещё удаляет (Р14)', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      await freshUnit(),
      'Правка заказчиком до и после назначения',
    );

    const before = await inject('PATCH', `/api/v1/service-requests/${dto.id}`, ctx.customer.auth, {
      description: 'Уточнил неисправность до назначения',
      version: dto.version,
    });
    expect(before.statusCode, before.body).toBe(200);

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        version: (before.json() as ServiceRequestDto).version,
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const after = (assigned.json() as { request: ServiceRequestDto }).request;
    expect(after.status).toBe('new');

    const late = await inject('PATCH', `/api/v1/service-requests/${dto.id}`, ctx.customer.auth, {
      description: 'А теперь ещё и сканер не работает',
      version: after.version,
    });
    expect(late.statusCode, late.body).toBe(403);
    expect(late.json().message).toContain('только до назначения сервиса');
    expect((await card(dto.id)).description).toBe('Уточнил неисправность до назначения');

    // Удаление той же назначенной заявки проходит: набор заявок, который покрывал прежний перечень
    // «Новая + Назначена», после слияния покрывает один `new`.
    const removed = await inject(
      'DELETE',
      `/api/v1/service-requests/${dto.id}`,
      ctx.customer.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as { ok: boolean }).ok).toBe(true);
  });

  /**
   * **Нераспределённую заявку в работу не берут** — третий запрет, который держал снятый статус
   * (после третьего замка предъявления на файле объёма работ и «есть от чего отказываться» у
   * `decline`). Закрыт шестым предикатом Р11 — `canStartServiceWork`.
   *
   * Р6 плана утверждал, что перечня статусов здесь не нужно: «ход открывает факт назначения, а не
   * право, и он же сам собой закрывает ход у нераспределённой — `isServiceExecutor` ложен при любом
   * праве». Верна половина: `isServiceExecutor` действительно ложен. Но коридор исполнителя
   * открывает **дизъюнкция**, и вторая её половина — право на объём работ — назначения не
   * спрашивает вовсе. Пока коридор был `assigned → in_work`, это ничего не значило: у «Новой» дуг
   * не было. После Р6 коридор стал `new → in_work`, и запрет исчез вместе со статусом.
   *
   * **Проверяется не только код, но и то, что отложенный триггер молчит.** В этом и была авария:
   * заявка уезжала в «В работе» без единого исполнителя, `service_requests_executor_present` (0178)
   * ловил это на `COMMIT` ошибкой БД, и наружу уходило 500 — данные целы, но человеку вместо
   * «сначала распределите заявку» показывали «что-то пошло не так».
   */
  it('нераспределённую «Новую» в работу не берут — 422 до всякой транзакции', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      await freshUnit(),
      'Принять в работу нераспределённую',
    );
    expect(dto.status).toBe('new');
    expect(dto.service).toBeNull();
    expect(dto.executors).toEqual([]);

    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/start`,
      ctx.admin.auth,
      { version: dto.version },
    );
    // 422, а не 500 и не 403. Не 500 — до транзакции дело не доходит вовсе; не 403 — право у
    // держателя есть, и просить его не надо: заявку надо сперва распределить.
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('сначала распределяют');
    expect(res.json().fields?.status).toBe('Исполнителей нет');
    // Именно отказ, а не авария: `internal_error` означал бы, что запрет держит только БД.
    expect(res.json().code).not.toBe('internal_error');

    // 1. Отложенный триггер не срабатывал, потому что срабатывать было не на чем: заявка не
    //    двигалась. Возраст ожидания и версия — на месте.
    const after = await card(dto.id);
    expect(after.status).toBe('new');
    expect(after.statusChangedAt).toBe(dto.statusChangedAt);
    expect(after.version).toBe(dto.version);

    // 2. Лента чиста: перехода `new → in_work` в ней нет, есть только заведение.
    const history = await inject(
      'GET',
      `/api/v1/service-requests/${dto.id}/history`,
      ctx.admin.auth,
    );
    const events = history.json() as {
      kind: string;
      fromStatus: string | null;
      toStatus: string | null;
    }[];
    expect(events.map((e) => e.kind)).toEqual(['created']);
    expect(events.filter((e) => e.toStatus === 'in_work')).toEqual([]);

    // 3. А распределённую ту же заявку исполнитель берёт в работу тем же ходом: решает состав
    //    исполнителей, а не субъект и не статус — оба до и после одинаковы.
    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/executors`,
      ctx.operator.auth,
      { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: dto.version },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const ready = (assigned.json() as { request: ServiceRequestDto }).request;
    expect(ready.status).toBe('new');

    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/start`,
      ctx.service.auth,
      { version: ready.version },
    );
    expect(started.statusCode, started.body).toBe(200);
    expect((started.json() as ServiceRequestDto).status).toBe('in_work');
  });

  // ── Шаг 3. Коридоры: у каждой стороны свои дуги (Р17) ──

  it('оператор не выполняет шаги исполнителя: диагностика, смета и закрытие — 403', async () => {
    // Право `serviceRequests.status` у надстройки есть, и по общей таблице переходов оператор смог
    // бы взять заявку в диагностику. Коридор исполнителя ему недоступен именно как коридор, а не
    // как отсутствующее право: отказ приходит от `assertSideAllowed`, а не от `requirePermission`.
    const start = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/start`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(start.statusCode, start.body).toBe(403);
    expect(start.json().message).toContain('шаг другой стороны');

    // Смета — право стороны исполнителя, и у надстройки его нет намеренно: выданные одному
    // субъекту, смета и её согласование превратили бы согласование в подпись под своей работой.
    // Здесь отказ приходит уже от права, и это разные отказы: сообщение их и различает.
    const submit = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(submit.statusCode, submit.body).toBe(403);
    expect(submit.json().message).toContain('Объём работ ведёт исполнитель');

    const complete = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.operator.auth,
      { completedOn: TODAY, items: [], version: await version(state.main.id) },
    );
    expect(complete.statusCode, complete.body).toBe(403);
    expect(complete.json().message).toContain('Объём работ ведёт исполнитель');
  });

  it('сервис не согласует смету, не принимает работу и не отменяет заявку — 403', async () => {
    const approve = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.service.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(approve.statusCode, approve.body).toBe(403);
    // Оператор подрядчика исключён из согласующих явно и раньше обеих веток (Р3): объём работ
    // предъявил он, и подпись под собственным счётом — не согласование, а его копия. Отказ здесь
    // даёт страж маршрута: права согласования в наборе подрядчика нет вовсе.
    expect(approve.json().message).toContain('Объём работ согласует тот, кто ведёт заявку');

    // Право статуса у исполнителя есть — и приёмку, и отмену закрывает именно коридор.
    const accept = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/accept`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(accept.statusCode, accept.body).toBe(403);
    expect(accept.json().message).toContain('шаг другой стороны');

    const cancel = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/status`,
      ctx.service.auth,
      {
        status: 'cancelled',
        reason: 'Не хотим этим заниматься',
        version: await version(state.main.id),
      },
    );
    expect(cancel.statusCode, cancel.body).toBe(403);
    expect(cancel.json().message).toContain('шаг другой стороны');
  });

  // ── Шаг 4. Работа и смета ──

  it('сервис принимает заявку в работу и наполняет смету', async () => {
    // Отдельного статуса «Диагностика» больше нет (Н2): взявшийся за заявку стоит в «В работе» и
    // оттуда же предъявляет смету.
    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/start`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe('in_work');

    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
        ],
        version: started.json().version,
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    const dto = put.json() as ServiceRequestDto;
    // Сумму строки считает БД (`amount` — GENERATED): производная не может разойтись со слагаемыми.
    expect(itemNamed(dto, 'Ролик подачи').amount).toBe(3600);
    expect(itemNamed(dto, 'Тормозная площадка').amount).toBe(900);
    expect(itemNamed(dto, 'Замена узла подачи').amount).toBe(1500);
    // Факт до закрытия не заполнен вовсе: `null`, а не `false` — иначе план читался бы как факт.
    expect(dto.items.map((i) => i.performed)).toEqual([null, null, null]);
    // Предъявленной суммы пока нет: смета — черновик, и ревизия у неё нулевая.
    expect(dto.estimatedTotalAmount).toBeNull();
    expect(dto.estimateRevision).toBe(0);
  });

  it('правка сметы с чужой версией — 409: окно простояло, пока смету меняли (Р30)', async () => {
    const stale = await version(state.main.id);
    const first = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
        ],
        version: stale,
      },
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().version).toBe(stale + 1);

    // Второе окно с той же версией: правка уже прошла, и его данные относятся к прошлой смете.
    const second = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      { items: [{ kind: 'service', name: 'Чистка', quantity: 1, unitPrice: 500 }], version: stale },
    );
    expect(second.statusCode, second.body).toBe(409);
    // Состав от отказавшей правки не пострадал: строки остались прежними.
    expect((await card(state.main.id)).items).toHaveLength(3);
  });

  it('сервис предъявляет объём работ: ревизия 1, сумма зафиксирована, статус прежний', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    /*
     * Предъявление переходом быть перестало (Р8): «Смета на согласовании» означала не состояние
     * заявки, а ожидание ответа на предъявленный счёт, — и заявка всё это время стоит в «В
     * работе», ровно как просил заказчик. Само ожидание открывает своя колонка
     * `estimate_pending_revision`, равная только что поднятой ревизии (`CHECK` в базе сторожит
     * равенство), и очередь считается по ней.
     */
    expect(dto.status).toBe('in_work');
    expect(dto.estimatePendingRevision).toBe(1);
    // Сторона `approval` — новая (Р3): согласующий не совпадает ни с одной старой, и оставь его
    // очередь на `operator`, поимённый исполнитель не увидел бы заявку в «Ждут меня» вовсе.
    expect(dto.waitingOn).toBe('approval');
    expect(dto.estimateRevision).toBe(1);
    // Снимок предъявленной суммы: по нему потом сверяется закрытие.
    expect(dto.estimatedTotalAmount).toBe(6000);
    expect(dto.estimateSubmittedAt).not.toBeNull();
    expect(dto.approval).toBeNull();
  });

  it('предъявленный объём работ правке не подлежит, и предъявить его заново нельзя — 409 (Р9)', async () => {
    /*
     * **Два замка, а не один.** Прежде оба держал сам статус: из «Сметы на согласовании» и правка
     * состава, и повторное предъявление были недоступны. Статус снят — и, не заведи мы замки
     * заново, исполнитель менял бы цифры под висящей подписью либо поднимал ревизию, подменяя
     * снимок суммы под уже открытым окном согласования.
     *
     * 409, а не 422: состав запер не сам исполнитель, а его предъявление, — и человеку нужно
     * обновить окно либо вернуть объём в правку, а не исправить данные.
     */
    const edited = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [{ kind: 'part', name: 'Ролик подачи', quantity: 9, unitPrice: 1800 }],
        version: await version(state.main.id),
      },
    );
    expect(edited.statusCode, edited.body).toBe(409);
    expect(edited.json().message).toContain('верните его в правку');

    const again = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().message).toContain('уже предъявлен и ждёт ответа');

    // Ни ревизия, ни снимок суммы от двух отказов не сдвинулись.
    const after = await card(state.main.id);
    expect(after.estimatedTotalAmount).toBe(6000);
    expect(after.estimateRevision).toBe(1);
    expect(after.estimatePendingRevision).toBe(1);
  });

  // ── Шаг 5. Согласование и вторая ревизия ──
  //
  // Порядок двух подписей («сперва ИТ, потом деньги») снят вместе с визой (Р10): подпись осталась
  // одна, и вопрос «чинить или менять» задаёт себе тот же человек, что смотрит на объём работ.
  // Проверять «до визы ИТ сумму не согласуют» и «ИТ визирует смету» больше не на чем — ручки нет.
  //
  // Переназначение под висящим предъявлением при этом по-прежнему запрещено, и запрет переехал из
  // пустого коридора «Сметы на согласовании» в сам предикат (Р11) — свой случай ниже.

  it('под висящим предъявлением заявку не переназначают — 422 (Р11)', async () => {
    const res = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [ctx.namedExecutor.id],
        serviceCounterpartyId: null,
        reason: 'Забираем у подрядчика',
        version: await version(state.main.id),
      },
    );
    /*
     * Правило сегодняшнее, а не новое: цифры предъявленного объёма принадлежат прежнему
     * исполнителю, и переданная заявка оставила бы новому чужой счёт. Прежде его держал пустой
     * `SERVICE_ASSIGNER_TRANSITIONS.estimate_review`; после слияния это же состояние зовётся «В
     * работе» + предъявление, и не войди условие в предикат — запрет исчез бы вместе со статусом.
     *
     * 422, а не 403: право у распределяющего есть, и просить его не надо — надо дождаться ответа
     * по объёму работ.
     */
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('ждёт ответа');
    expect((await card(state.main.id)).service?.id).toBe(ctx.serviceCounterpartyId);
  });

  it('оператор согласует объём работ: снимок «кто, когда, какая ревизия», статус прежний', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    // «Согласовано» статуса не меняет вовсе (Р8): заявка как стояла в «В работе», так и стоит —
    // ровно как просил заказчик, — а из очереди подписи её выводит погашенное предъявление.
    expect(dto.status).toBe('in_work');
    expect(dto.estimatePendingRevision).toBeNull();
    expect(dto.waitingOn).toBe('service');
    expect(dto.approval).toMatchObject({ by: ctx.operator.id, revision: 1 });
  });

  it('согласованный объём работ правят, только вернув его в правку: статус при этом не меняется', async () => {
    // Единственный путь изменить согласованный объём работ (Р9). Прежде он откатывал заявку в
    // «Диагностику»; та слилась с «В работе» (Н2), а второй дуги в предъявление заводить нельзя —
    // она сделала бы необязательным подъём ревизии, на котором держится обесценивание подписи.
    // Поэтому ручка снимает только снимок согласования и само предъявление, а статус не трогает.
    const locked = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [{ kind: 'part', name: 'Ролик подачи', quantity: 9, unitPrice: 1800 }],
        version: await version(state.main.id),
      },
    );
    expect(locked.statusCode, locked.body).toBe(409);
    expect(locked.json().message).toContain('согласована');

    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/reopen`,
      ctx.service.auth,
      {
        reason: 'Нужен ещё термоузел — без него ремонт не держит',
        version: await version(state.main.id),
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('in_work');
    // Снимок согласования недействителен, а объём работ остаётся черновиком той же ревизии.
    expect(dto.approval).toBeNull();
    expect(dto.estimatePendingRevision).toBeNull();
    expect(dto.estimateRevision).toBe(1);
    expect(dto.items).toHaveLength(3);
    expect(dto.estimatedTotalAmount).toBe(6000);
    // Дату предъявления возврат НЕ трогает (Р9): она сохраняет смысл «когда предъявляли в
    // последний раз», а активное состояние определяет исключительно `estimatePendingRevision`.
    expect(dto.estimateSubmittedAt).not.toBeNull();
  });

  it('сервис меняет состав и предъявляет ревизию 2', async () => {
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
          { kind: 'part', name: 'Термоузел', quantity: 1, unitPrice: 4400, warrantyMonths: 12 },
        ],
        version: await version(state.main.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);

    const submit = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.service.auth,
      { version: put.json().version },
    );
    expect(submit.statusCode, submit.body).toBe(200);
    const dto = submit.json() as ServiceRequestDto;
    expect(dto.estimateRevision).toBe(2);
    expect(dto.estimatedTotalAmount).toBe(10400);
    expect(dto.approval).toBeNull();
  });

  it('до повторного согласования работы не закрываются — отбивает ревизия, а не коридор', async () => {
    /*
     * **Отказ сменил основание, и это следствие Р1.** Прежде заявка стояла в «Смете на
     * согласовании», у которой дуг исполнителя не было вовсе, и закрытие отбивал коридор (403).
     * Статуса больше нет: заявка стоит в «В работе», откуда `in_work → done` исполнителю открыт, —
     * и до отказа теперь доходит сверка ревизий (409). Предъявленная ревизия 2 не подписана
     * никем: подпись стояла на ревизии 1 и снята возвратом в правку.
     *
     * Ослаблением это не является: закрыть работы под висящим предъявлением по-прежнему нельзя, а
     * 409 вместо 403 человеку честнее — просить прав не надо, надо дождаться подписи.
     */
    const before = await card(state.main.id);
    expect(before.status).toBe('in_work');
    expect(before.estimatePendingRevision).toBe(2);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      { completedOn: TODAY, items: [], version: before.version },
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('Согласована ревизия');
  });

  it('оператор согласует ревизию 2 — подпись одна, порядка двух больше нет', async () => {
    // Подъём ревизии обесценил подпись (Н3): прошлая стояла на ревизии 1. Второй подписи, которой
    // прежде полагалось идти первой, больше не существует (Р10) — согласует один человек и сразу.
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('in_work');
    expect(dto.approval?.revision).toBe(2);
    expect(dto.estimatePendingRevision).toBeNull();
    expect(dto.waitingOn).toBe('service');
  });

  /**
   * **Очередь списком обязана сойтись с очередью карточки** — и на новой стороне `approval` это
   * не формальность (Р2, Р3). Карточка отвечает предикатом `serviceRequestWaitingOn` по строке, а
   * список — SQL-условием `waitingSideWhere`, выведенным из того же предиката перебором статусов
   * по двум булевым осям. Оси после Р2 другие (`hasExecutors` и непогашенное предъявление), и
   * разъедься эти два расчёта — заявка стояла бы в карточке «Ждёт согласования», а в «Ждут меня» у
   * согласующего не показывалась вовсе.
   *
   * Вторая половина случая — про то, кого сторона `approval` НЕ включает: оператор подрядчика
   * исключён из неё явно (Р3), потому что объём работ предъявил он, и подпись под собственным
   * счётом не согласование, а его копия. По стороне `service` он ту же заявку до предъявления
   * видел — значит проверка отличает «исключили согласующего-подрядчика» от «список ему пуст».
   */
  it('заявка с висящим предъявлением встаёт в «Ждут меня» согласующему, но не подрядчику', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      await freshUnit(),
      'Очередь согласования: список против карточки',
    );
    await driveTo(dto.id, 'in_work');

    // До предъявления заявку ждёт исполнитель — и в списке она стоит именно у него.
    expect(await listIds(ctx.service.auth, '&waitingOnMe=true')).toContain(dto.id);

    const submitted = await submitEstimate(dto.id);
    expect(submitted.waitingOn).toBe('approval');

    const beforeCount = await waitingCount(ctx.operator.auth);
    expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).toContain(dto.id);
    // Исполнитель из очереди вышел: ход не за ним, пока по счёту не ответили.
    expect(await listIds(ctx.service.auth, '&waitingOnMe=true')).not.toContain(dto.id);

    // Ответ по объёму работ возвращает ход исполнителю — и обе очереди меняются вместе.
    const approved = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: submitted.version },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).not.toContain(dto.id);
    expect(await listIds(ctx.service.auth, '&waitingOnMe=true')).toContain(dto.id);
    // Бейдж раздела считает ту же очередь своей ручкой: разойдись они, число вело бы в пустой
    // список.
    expect(await waitingCount(ctx.operator.auth)).toBe(beforeCount - 1);
  });

  /**
   * **Возраст ожидания у возврата в правку — условный, и условие здесь не «сменилась ли сторона
   * вообще»** (Р4). У ручки два предусловия, и сторону меняет только одно: отзыв ВИСЯЩЕГО
   * предъявления возвращает ход исполнителю (`approval → service`) — отсчёт начинается заново;
   * снятие подписи с уже согласованного объёма не двигает ничего — до него ждали исполнителя и
   * после него ждут его же.
   *
   * Своей заявкой, а не на главной цепочке: сравниваются два вызова одной ручки, и разделить их
   * можно только на состояниях, собранных подряд.
   */
  it('возврат в правку обнуляет возраст только у висящего предъявления (Р4)', async () => {
    const pending = await pendingEstimateRequest('Возраст ожидания при возврате в правку');
    expect(pending.waitingOn).toBe('approval');

    // 1. Отзыв ВИСЯЩЕГО предъявления: ход вернулся исполнителю — возраст начинается заново.
    const withdrawn = await inject(
      'PATCH',
      `/api/v1/service-requests/${pending.id}/estimate/reopen`,
      ctx.service.auth,
      { reason: 'посчитал заново, отзываю', version: pending.version },
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const afterWithdraw = withdrawn.json() as ServiceRequestDto;
    expect(afterWithdraw.estimatePendingRevision).toBeNull();
    expect(afterWithdraw.waitingOn).toBe('service');
    expect(new Date(afterWithdraw.statusChangedAt).getTime()).toBeGreaterThan(
      new Date(pending.statusChangedAt).getTime(),
    );

    // 2. Предъявляем и СОГЛАСОВЫВАЕМ — теперь снимать будем подпись, а не предъявление.
    const resubmitted = await submitEstimate(pending.id);
    const approved = await inject(
      'PATCH',
      `/api/v1/service-requests/${pending.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: resubmitted.version },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    const signed = approved.json() as ServiceRequestDto;
    expect(signed.approval?.revision).toBe(resubmitted.estimateRevision);

    // 3. Снятие подписи с согласованного объёма сторону не меняет — возраст стоит на месте.
    const unsigned = await inject(
      'PATCH',
      `/api/v1/service-requests/${pending.id}/estimate/reopen`,
      ctx.service.auth,
      { reason: 'нужен ещё термоузел', version: signed.version },
    );
    expect(unsigned.statusCode, unsigned.body).toBe(200);
    const afterUnsign = unsigned.json() as ServiceRequestDto;
    expect(afterUnsign.approval).toBeNull();
    expect(afterUnsign.waitingOn).toBe('service');
    expect(afterUnsign.statusChangedAt).toBe(signed.statusChangedAt);
  });

  it('работы по несогласованной ревизии сметы не закрываются — 409', async () => {
    // Состояние «в работе, а ревизии разошлись» через API недостижимо: правку согласованной сметы
    // запирает сам снимок согласования, а снятие снимка (`/estimate/reopen`) равняет ревизии
    // обратно только через новое предъявление. Поэтому расхождение делается прямым UPDATE — иначе
    // страховку инварианта (Р12) не проверить вовсе, а сработает она ровно на испорченных данных.
    const before = await card(state.main.id);
    await ctx.db.execute(sql`
      UPDATE service_requests SET estimate_revision = estimate_revision + 1
      WHERE id = ${state.main.id}`);

    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      { completedOn: TODAY, items: [], version: before.version },
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('Согласована ревизия 2');

    await ctx.db.execute(sql`
      UPDATE service_requests SET estimate_revision = ${before.estimateRevision}
      WHERE id = ${state.main.id}`);
    expect((await card(state.main.id)).estimateRevision).toBe(2);
  });

  // ── Шаг 6. Закрытие работ ──

  it('без закрывающего документа заявка сервиса в «Решена» не уходит — 422 (Н8)', async () => {
    // Планка переехала с приёмки на «Решена» (Н8): за работу внешнего сервиса платят, и бумага —
    // основание платежа. Прежде та же проверка стояла на приёмке, и «акт пришлю завтра» оставляло
    // предъявленную работу без единого документа до самого закрытия.
    const before = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: before.items.map((item) => ({ id: item.id, performed: true })),
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('требует закрывающего документа');
    expect((await card(state.main.id)).status).toBe('in_work');
  });

  it('сервис закрывает работы: итог считает сервер, гарантии — только выполненным строкам', async () => {
    // Акт подшивается ещё в «В работе»: именно он и отпирает переход (Н8).
    const actFile = await uploadedFile(ctx.service.id, 'akt.pdf');
    const act = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/files`,
      ctx.service.auth,
      { fileIds: [actFile], kind: 'act' },
    );
    expect(act.statusCode, act.body).toBe(200);
    state.attachedActId = actFile;

    const before = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: [
          // Роликов согласовали два, поставили один: фактическое количество меньше планового.
          {
            id: itemNamed(before, 'Ролик подачи').id,
            performed: true,
            actualQuantity: 1,
          },
          // Тормозная площадка не понадобилась — гарантии на неустановленную деталь не бывает.
          { id: itemNamed(before, 'Тормозная площадка').id, performed: false },
          { id: itemNamed(before, 'Замена узла подачи').id, performed: true },
          // Дата из талона побеждает расчёт и помечается введённой руками. Талон здесь заведомо
          // просроченный: по нему проверяется отказ гарантийного обращения ниже.
          {
            id: itemNamed(before, 'Термоузел').id,
            performed: true,
            warrantyUntil: SHORT_WARRANTY_ON,
          },
        ],
        adjustmentAmount: -700,
        adjustmentReason: 'Скидка по акту: выезд не выставляли',
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('done');
    expect(dto.waitingOn).toBe('operator');

    // Итог не принимается от клиента: сумма выполненных (1800 + 0 + 1500 + 4400) плюс скидка.
    expect(dto.completion).toMatchObject({
      totalAmount: 7000,
      adjustmentAmount: -700,
      adjustmentReason: 'Скидка по акту: выезд не выставляли',
    });

    const roller = itemNamed(dto, 'Ролик подачи');
    expect(roller).toMatchObject({ performed: true, actualQuantity: 1, actualAmount: 1800 });
    // Гарантия считается от даты выполнения календарными месяцами, а не тридцатью днями.
    expect(roller.warrantyUntil).toBe(plusMonths(TODAY, 6));
    expect(roller.warrantyUntilManual).toBe(false);

    const plate = itemNamed(dto, 'Тормозная площадка');
    expect(plate).toMatchObject({ performed: false, actualAmount: 0, warrantyUntil: null });

    const work = itemNamed(dto, 'Замена узла подачи');
    expect(work).toMatchObject({ performed: true, actualAmount: 1500 });
    expect(work.warrantyUntil).toBe(plusMonths(TODAY, 3));

    const fuser = itemNamed(dto, 'Термоузел');
    expect(fuser).toMatchObject({ warrantyUntil: SHORT_WARRANTY_ON, warrantyUntilManual: true });

    state.performedItemId = roller.id;
    state.notPerformedItemId = plate.id;
    state.expiredItemId = fuser.id;
  });

  // ── Шаг 7. Возврат на доработку ──

  it('возврат на доработку снимает факт целиком, а смету и согласование сохраняет', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/rework`,
      ctx.operator.auth,
      { reason: 'Лоток по-прежнему заедает — доделайте', version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('in_work');

    // Матрица §5.4: дата, итог, корректировка, отметки строк и гарантии — всё это предъявят заново.
    expect(dto.completion).toBeNull();
    for (const item of dto.items) {
      expect(item.performed).toBeNull();
      expect(item.actualQuantity).toBeNull();
      expect(item.actualAmount).toBeNull();
      // Гарантия снимается и посчитанная, и введённая руками: возврат отменяет само выполнение, а
      // строка без выполнения гарантии не держит (CHECK в БД).
      expect(item.warrantyUntil).toBeNull();
      expect(item.warrantyUntilManual).toBe(false);
    }
    // Смета и согласование остаются: работу возвращают ту же и по той же согласованной цене.
    expect(dto.items).toHaveLength(4);
    expect(dto.estimateRevision).toBe(2);
    expect(dto.estimatedTotalAmount).toBe(10400);
    expect(dto.approval?.revision).toBe(2);
  });

  it('повторное закрытие проходит и даёт тот же итог', async () => {
    const before = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: [
          { id: itemNamed(before, 'Ролик подачи').id, performed: true, actualQuantity: 1 },
          { id: itemNamed(before, 'Тормозная площадка').id, performed: false },
          { id: itemNamed(before, 'Замена узла подачи').id, performed: true },
          {
            id: itemNamed(before, 'Термоузел').id,
            performed: true,
            warrantyUntil: SHORT_WARRANTY_ON,
          },
        ],
        adjustmentAmount: -700,
        adjustmentReason: 'Скидка по акту: выезд не выставляли',
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('done');
    expect(dto.completion?.totalAmount).toBe(7000);
    // Идентичность строк возврат не трогал: гарантийные обращения ниже ссылаются на те же id.
    expect(itemNamed(dto, 'Ролик подачи').id).toBe(state.performedItemId);
    expect(itemNamed(dto, 'Ролик подачи').warrantyUntil).toBe(plusMonths(TODAY, 6));
  });

  // ── Шаг 8. Приёмка ──

  it('оператор принимает работу — заявка становится терминальной, источник «человек»', async () => {
    // Бумагу приёмка больше не спрашивает: планка переехала на «Решена» (Н8), и заявка дошла сюда
    // уже с актом. Двойная проверка запирала бы заявку-наследие, уехавшую в «Решена» без бумаги до
    // выпуска 1: автозакрытие её не берёт, и снять с очереди мог бы только человек.
    expect((await card(state.main.id)).files).toEqual([
      expect.objectContaining({ id: state.attachedActId, kind: 'act' }),
    ]);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/accept`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('accepted');
    expect(dto.waitingOn).toBe('nobody');
    expect(dto.acceptedAt).not.toBeNull();
    expect(dto.acceptedByName).not.toBe('');
    // Приёмка человеком помечается источником (Н7): у автоматической он `auto`, а автора нет.
    expect(dto.acceptanceSource).toBe('human');
  });

  // ── Шаг 9. Документы после приёмки (§8.3) ──

  it('после приёмки вложение не принимают, а снять акт исполнитель уже не может', async () => {
    // Вложение — вид «обычной жизни» заявки, и после терминального статуса его не принимают:
    // правило одной строкой — закрытая заявка принимает только документы (акт, счёт, талон).
    const attachment = await uploadedFile(ctx.service.id, 'foto.pdf');
    const plain = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/files`,
      ctx.service.auth,
      { fileIds: [attachment], kind: 'attachment' },
    );
    expect(plain.statusCode, plain.body).toBe(422);

    // Снимает документ из закрытой заявки только тот, кто распоряжается чужими файлами; у
    // исполнителя такого права нет, даже если акт подшил он сам. С планкой приёмки (Р112) у этого
    // правила появился второй смысл: снятый акт оставил бы принятую заявку вовсе без бумаги.
    const detach = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/files/${state.attachedActId}`,
      ctx.service.auth,
    );
    expect(detach.statusCode, detach.body).toBe(403);
    expect((await card(state.main.id)).files).toHaveLength(1);
  });

  // ── Шаг 10. Заявки-спутники: источники гарантийных обращений ──

  it('после приёмки на ту же единицу заводится новая заявка — и её отменяют со сметой', async () => {
    // Первая половина проверки Р21 была отказом (409); вторая — что закрытая заявка место больше
    // не занимает. Эта заявка нужна и дальше: отменённая, но со сметой, она даёт позицию ремонта
    // из **непринятой** заявки на той же единице.
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Полосит при печати — посмотрите заодно',
    );
    state.cancelled = { id: dto.id, num: dto.num, itemId: '' };

    await toInWork(dto.id);
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Девелопер', quantity: 1, unitPrice: 2500, warrantyMonths: 6 },
        ],
        version: await version(dto.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    state.cancelled.itemId = itemNamed(put.json() as ServiceRequestDto, 'Девелопер').id;

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/status`,
      ctx.operator.auth,
      { status: 'cancelled', reason: 'Аппарат решили менять целиком', version: put.json().version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // Отмена шлёт письмо службе, поэтому ответ у неё такой же, как у заведения: заявка и исход.
    const after = (cancelled.json() as { request: ServiceRequestDto }).request;
    expect(after.status).toBe('cancelled');
    // Отмена возвращает заявку в состояние «ничего не делали»: исполнителя и согласования у неё
    // больше нет, но состав сметы остаётся историей того, что собирались чинить.
    expect(after.service).toBeNull();
    expect(after.items).toHaveLength(1);
  });

  it('отказ единственного исполнителя возвращает заявку в «Новую» и снимает сервис', async () => {
    const dto = await createRequest(ctx.customer.auth, ctx.scanner.id, 'Не протягивает лист');
    state.otherUnit = { id: dto.id, itemId: '' };

    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        version: await version(dto.id),
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);

    const declined = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/decline`,
      ctx.service.auth,
      { reason: 'Сканеры этой серии не обслуживаем', version: (assigned.json() as { request: ServiceRequestDto }).request.version },
    );
    expect(declined.statusCode, declined.body).toBe(200);
    const after = declined.json() as ServiceRequestDto;
    // Оператор сервисной компании отказом снимает **всю компанию** (§4.2): поимённых строк у неё
    // нет, и «часть подрядчика» отказаться не может. Исполнителей не осталось — заявка вернулась в
    // «Новую» и снова ждёт распределения. К визе ИТ отказ отношения не имеет: её на входе больше
    // нет вовсе (Н3).
    expect(after.status).toBe('new');
    expect(after.service).toBeNull();
    expect(after.executors).toEqual([]);
    expect(after.waitingOn).toBe('operator');
    expect(after.itApproval).toBeNull();
    // И она снова невидима исполнителю, который от неё отказался.
    expect(await listIds(ctx.service.auth)).not.toContain(dto.id);
  });

  it('после повторного назначения та же заявка даёт «чужую» позицию ремонта', async () => {
    const dto = await card(state.otherUnit.id);
    await toInWork(dto.id);
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик сканера', quantity: 1, unitPrice: 700, warrantyMonths: 6 },
        ],
        version: await version(dto.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    state.otherUnit.itemId = itemNamed(put.json() as ServiceRequestDto, 'Ролик сканера').id;
  });

  // ── Шаг 11. Гарантийное обращение (Р26) ──

  it('обращение по выполненной строке принятой заявки проходит', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Снова не тянет бумагу — месяц после ремонта',
      { warrantyClaim: { source: 'item', itemId: state.performedItemId } },
    );
    state.claim = { id: dto.id, num: dto.num };
    expect(dto.warrantyClaim).toMatchObject({
      source: 'item',
      itemId: state.performedItemId,
      itemName: 'Ролик подачи',
      // Спор с сервисом ведут по номеру заявки-источника — он и приезжает в карточке.
      sourceRequestNum: state.main.num,
    });
  });

  it('обращение отклоняется, если основание не годится: четыре ветки проверки', async () => {
    /** Смена источника у заведённой заявки: обращение проверяется заново, как при заведении. */
    const claim = async (id: string, itemId: string) =>
      inject('PATCH', `/api/v1/service-requests/${id}`, ctx.customer.auth, {
        warrantyClaim: { source: 'item', itemId },
        version: await version(id, ctx.customer.auth),
      });

    // Работа не выполнялась — гарантии на неё нет вовсе.
    const notPerformed = await claim(state.claim.id, state.notPerformedItemId);
    expect(notPerformed.statusCode, notPerformed.body).toBe(422);
    expect(notPerformed.json().message).toContain('не выполнялась');

    // Срок кончился. Такого состояния через API не получить: сервер не принимает талон, гарантия
    // по которому истекает раньше даты выполнения, — поэтому дата состаривается прямым UPDATE, как
    // и расхождение ревизий выше. Проверяется здесь именно ветка «гарантия была, но истекла», а не
    // ввод испорченного талона.
    await ctx.db.execute(sql`
      UPDATE service_request_items SET warranty_until = ${EXPIRED_ON}
      WHERE id = ${state.expiredItemId}`);
    const expired = await claim(state.claim.id, state.expiredItemId);
    expect(expired.statusCode, expired.body).toBe(422);
    expect(expired.json().message).toContain('истекла');

    // Позиция из заявки на другой единице: гарантия на ролик сканера этому МФУ не поможет.
    const foreign = await claim(state.claim.id, state.otherUnit.itemId);
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(foreign.json().message).toContain('другой единице');

    // Заявка-источник не принята (отменена): ремонта не было, гарантировать нечего.
    const notAccepted = await claim(state.claim.id, state.cancelled.itemId);
    expect(notAccepted.statusCode, notAccepted.body).toBe(422);
    expect(notAccepted.json().message).toContain('не принята');

    // Ни одна отклонённая попытка обращение не сдвинула.
    expect((await card(state.claim.id)).warrantyClaim?.itemId).toBe(state.performedItemId);
  });

  it('заявку, по гарантии которой обратились, нельзя удалить насовсем — 409 с номером обращения', async () => {
    // Ссылка объявлена `ON DELETE RESTRICT`, и человеку нужен не код 23503, а номер заявки,
    // которая на неё сослалась: спор с сервисом ведут именно по нему.
    const removed = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.admin.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);

    const purged = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/purge`,
      ctx.admin.auth,
    );
    expect(purged.statusCode, purged.body).toBe(409);
    expect(purged.json().message).toContain(formatServiceRequestNumber(state.claim.num));

    // Заявка возвращается из архива: закрытая, место по единице она не занимает (Р21).
    const restored = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/restore`,
      ctx.admin.auth,
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect((restored.json() as ServiceRequestDto).deletedAt).toBeNull();
  });

  // ── Шаг 12. Область видимости ──

  it('штаб чужой площадки заявку не видит — ни в списке, ни по прямому id', async () => {
    expect(await listIds(ctx.foreignShtab.auth)).not.toContain(state.main.id);
    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.foreignShtab.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  it('роль отдела видит заявку своего отдела и заявку по технике своего отдела', async () => {
    // Ось отдела двойная (Р5): заявку ведёт и тот, кто её подал, и отдел, за которым числится
    // техника. Первую заводит сам отдел, вторую — администратор на технику этого отдела.
    const own = await createRequest(
      ctx.department.auth,
      ctx.freePrinter.id,
      'Зажёвывает бумагу при двусторонней печати',
    );
    state.deptOwn = { id: own.id };
    expect(own.customerDepartment?.id).toBe(ctx.departmentId);
    expect(own.equipmentDepartment).toBeNull();

    const owned = await createRequest(ctx.admin.auth, ctx.deptPrinter.id, 'Не видит сеть');
    state.deptOwned = { id: owned.id };
    // Администратор отделов не имеет — заявка объектная, но техника числится за отделом.
    expect(owned.customerDepartment).toBeNull();
    expect(owned.equipmentDepartment?.id).toBe(ctx.departmentId);

    const visible = await listIds(ctx.department.auth);
    expect(visible).toContain(state.deptOwn.id);
    expect(visible).toContain(state.deptOwned.id);
    // Заявка площадки без отделов отделу не видна: `NULL` означает «к отделам не относится», а не
    // «видна всем» — иначе «ничья» заявка осталась бы видна каждому отделу навсегда.
    expect(visible).not.toContain(state.main.id);
    const foreign = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.department.auth,
    );
    expect(foreign.statusCode, foreign.body).toBe(403);
  });

  it('сервис видит только назначенные ему заявки', async () => {
    // Заявку отдела назначают ДРУГОМУ исполнителю: нашему сервису она от этого видна не становится
    // — область исполнителя считается по контрагенту. Статуса назначение не меняет вовсе (Р5), и
    // это делает проверку строже прежней: раньше заявка уходила в «Назначена», и «не видна» можно
    // было списать на смену статуса.
    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${state.deptOwned.id}/executors`,
      ctx.admin.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.otherServiceCounterpartyId,
        version: await version(state.deptOwned.id, ctx.admin.auth),
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);

    const visible = await listIds(ctx.service.auth);
    // Свои: главная заявка и заявка на сканере, которую он ведёт.
    expect(visible).toContain(state.main.id);
    expect(visible).toContain(state.otherUnit.id);
    // Чужие: назначенная другому сервису и ещё никому не назначенная.
    expect(visible).not.toContain(state.deptOwned.id);
    expect(visible).not.toContain(state.deptOwn.id);
    expect(visible).not.toContain(state.claim.id);

    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.deptOwned.id}`,
      ctx.service.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  // ── Шаг 13. Справочник и незакрытая заявка (Р33) ──

  it('единицу с незакрытой заявкой из справочника не удаляют — 409', async () => {
    // По МФУ висит гарантийное обращение: пока аппарат в работе, его карточка — единственное, чем
    // заявка объясняет, что именно чинят.
    const res = await inject('DELETE', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(formatServiceRequestNumber(state.claim.num));

    // Карточка на месте: отказ ничего не унёс побочным эффектом.
    const still = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().deletedAt).toBeNull();
  });

  // ── Шаг 14. Остальные правила документов (§8.3) ──
  //
  // Шаг 9 закрыл главную пару: акт после приёмки принимают, вложение — нет, и снять документ
  // приложивший уже не может. Здесь дописано остальное из таблицы §8.3, потому что «принимает
  // только документы» — это три вида из пяти, а не один, и «снять нельзя» — правило про право, а
  // не про человека.

  it('закрытая заявка принимает счёт и гарантийный талон, но не смету', async () => {
    const attach = async (kind: string, filename: string) => {
      const fileId = await uploadedFile(ctx.service.id, filename);
      const res = await inject(
        'POST',
        `/api/v1/service-requests/${state.main.id}/files`,
        ctx.service.auth,
        { fileIds: [fileId], kind },
      );
      return { fileId, res };
    };

    const invoice = await attach('invoice', 'schet.pdf');
    expect(invoice.res.statusCode, invoice.res.body).toBe(200);
    const warrantyCard = await attach('warranty_card', 'talon.pdf');
    expect(warrantyCard.res.statusCode, warrantyCard.res.body).toBe(200);

    // Смета — вид исполнителя из середины цикла: после приёмки она не «ещё один документ», а
    // попытка переписать то, что уже согласовали и приняли.
    const estimate = await attach('estimate', 'smeta.pdf');
    expect(estimate.res.statusCode, estimate.res.body).toBe(422);
    expect(estimate.res.json().message).toContain('принимает только документы');

    // В заявке остались акт шага 9 и две принятые бумаги: отказ ничего не подшил побочно.
    const files = (await card(state.main.id)).files;
    expect(files.map((f) => f.kind).sort()).toEqual(['act', 'invoice', 'warranty_card']);
    state.attachedInvoiceId = invoice.fileId;
  });

  it('снимает документ из закрытой заявки только распорядитель чужих файлов', async () => {
    // Отказ исполнителю проверен шагом 9; здесь — вторая половина того же правила: закрывает
    // снятие отсутствие `files.manageAny`, а не то, кто именно подшивал бумагу. Иначе «снять
    // нельзя» читалось бы как «нельзя никому», и ошибочно подшитый счёт остался бы в заявке
    // навсегда.
    const res = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/files/${state.attachedInvoiceId}`,
      ctx.admin.auth,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ServiceRequestDto).files.map((f) => f.kind).sort()).toEqual([
      'act',
      'warranty_card',
    ]);
  });

  /**
   * **ТРЕТИЙ ЗАМОК ВИСЯЩЕГО ПРЕДЪЯВЛЕНИЯ — на файле объёма работ** (Р9 + правка, найденная этим
   * файлом).
   *
   * Правило «предъявленный объём работ не вынимают из карточки» держал СТАТУС: страж снятия
   * сравнивал статус с «В работе», а предъявление уводило заявку в «Смету на согласовании».
   * Предъявление статуса менять перестало (Р8) — заявка остаётся в «В работе», прежнее условие
   * обращается в ложь, и исполнитель вынимал бы бумагу из-под открытого окна согласования:
   * согласующий смотрит на цифры, документа под которыми уже нет. Условий поэтому теперь два:
   * прежнее (`status !== 'in_work'`) сохранено целиком, а рядом встал признак предъявления.
   *
   * Проверяется всё четвёрками, и **ключ важнее замка**: замок без ключа был бы просто новым
   * тупиком, из которого исполнителю не выбраться. Ключ тот же, что у двух других замков Р9, —
   * «Вернуть объём работ в правку».
   */
  it('файл объёма работ заперт висящим предъявлением, а «вернуть в правку» его отпирает', async () => {
    const attach = async (filename: string) => {
      const fileId = await uploadedFile(ctx.service.id, filename);
      const res = await inject(
        'POST',
        `/api/v1/service-requests/${state.otherUnit.id}/files`,
        ctx.service.auth,
        { fileIds: [fileId], kind: 'estimate' },
      );
      expect(res.statusCode, res.body).toBe(200);
      return fileId;
    };
    const detach = (fileId: string, auth: Auth = ctx.service.auth) =>
      inject('DELETE', `/api/v1/service-requests/${state.otherUnit.id}/files/${fileId}`, auth);

    // Черновик, предъявления по которому ещё не было, снимается свободно: замок ставит не вид
    // документа, а состояние заявки.
    const draft = await attach('kp-chernovik.pdf');
    const removed = await detach(draft);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as ServiceRequestDto).files).toEqual([]);

    const final = await attach('kp.pdf');
    const submitted = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.otherUnit.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.otherUnit.id) },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    // Предъявление статуса не меняет (Р8): заявка осталась в «В работе», а ожидание подписи держит
    // своя колонка — значит и запирает файл именно она, а не статус.
    expect(submitted.json().status).toBe('in_work');
    expect(submitted.json().estimatePendingRevision).toBe(submitted.json().estimateRevision);

    // 1. ЗАМОК. Статус к снятию располагает, и отбивает только признак предъявления.
    const locked = await detach(final);
    expect(locked.statusCode, locked.body).toBe(422);
    expect(locked.json().message).toContain('верните его в правку и предъявите заново');
    expect((await card(state.otherUnit.id)).files).toHaveLength(1);

    // 2. ОГОВОРКА `!manageAny` не тронута: распорядитель чужих файлов проходит сквозь оба условия.
    //    Проверяется отказом соседней двери — «снять вложение может тот, кто его приложил»: до неё
    //    администратор доходит, то есть замок объёма работ его пропустил.
    const byManager = await detach(final, ctx.admin.auth);
    expect(byManager.statusCode, byManager.body).toBe(200);
    expect((byManager.json() as ServiceRequestDto).files).toEqual([]);

    // 3. КЛЮЧ. Возвращаем бумагу и отзываем предъявление — файл снимается снова, и снимает его сам
    //    исполнитель. Без этого шага замок был бы тупиком: править состав нельзя, предъявить заново
    //    нельзя, снять бумагу нельзя — и выйти из состояния нечем.
    const again = await attach('kp-2.pdf');
    const reopened = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.otherUnit.id}/estimate/reopen`,
      ctx.service.auth,
      { reason: 'отзываю предъявление, меняю бумагу', version: await version(state.otherUnit.id) },
    );
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect((reopened.json() as ServiceRequestDto).estimatePendingRevision).toBeNull();

    const unlocked = await detach(again);
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect((unlocked.json() as ServiceRequestDto).files).toEqual([]);

    // 4. ПРЕЖНЯЯ ПОЛОВИНА ПРАВИЛА НЕ ПОТЕРЯНА: из «Решена» файл не снимается, и держит это уже не
    //    предъявление — оно погашено согласованием, — а сам статус.
    const third = await attach('kp-3.pdf');
    const resubmitted = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.otherUnit.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.otherUnit.id) },
    );
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    const approved = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.otherUnit.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.otherUnit.id) },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect((approved.json() as ServiceRequestDto).estimatePendingRevision).toBeNull();
    await attachClosingDocument(state.otherUnit.id);
    const completed = await completeWork(state.otherUnit.id);
    expect(completed.statusCode, completed.body).toBe(200);
    expect((completed.json() as ServiceRequestDto).status).toBe('done');

    const byStatus = await detach(third);
    expect(byStatus.statusCode, byStatus.body).toBe(422);
    expect(byStatus.json().message).toContain('не снимается');
    expect((await card(state.otherUnit.id)).files.map((f) => f.kind).sort()).toEqual([
      'act',
      'estimate',
    ]);
  });

  // ── Шаг 15. От чьего имени заявка: выбор отдела заказчика (Р5) ──
  //
  // Ветка «у автора ровно один отдел» пройдена шагом 12 (заявка сотрудника отдела на неразмеченную
  // технику), ветки «отделов нет вовсе» — шагом 1 (штаб) и тем же шагом 12 (администратор). Здесь
  // остаются три, которые видны только на учётке с **двумя** отделами: на одном подсказка из
  // техники и единственный отдел дают один и тот же ответ.

  it('подсказка приходит из отдела-владельца техники, а не из набора отделов автора', async () => {
    const dto = await createRequest(
      ctx.multiDepartment.auth,
      ctx.hintPrinter.id,
      'Печатает с полосой по краю',
      // Подразделение **заявителя** — второе поле и второе решение (Н11): подсказка из техники к
      // нему не относится вовсе, и у учётки с двумя отделами выбор обязателен. Заказчик при этом
      // по-прежнему подсказывается сам.
      { requesterDepartmentId: ctx.secondDepartmentId },
    );
    // Техника числится за вторым отделом учётки — от его имени заявка и заведена, хотя выбор
    // человеку не предъявляли: спрашивать нечего, ответ уже есть в карточке техники.
    expect(dto.customerDepartment?.id).toBe(ctx.secondDepartmentId);
    expect(dto.equipmentDepartment?.id).toBe(ctx.secondDepartmentId);
    // Снимок подразделения заявителя — ссылка и название вместе (Н11).
    expect(dto.requesterPlace).toMatchObject({ kind: 'department', id: ctx.secondDepartmentId });
    expect(dto.requesterPlace?.name).toBeTruthy();
  });

  it('подразделение заявителя: без выбора 422, чужое 422 (Н11)', async () => {
    // Своя единица: по каждой разрешена одна открытая заявка (Р21), а подсказку из техники этот
    // случай не проверяет вовсе — предмет здесь подразделение самого заявителя.
    const payload = {
      officeEquipmentId: await freshUnit(),
      description: 'Проверка подразделения заявителя',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      customerDepartmentId: ctx.secondDepartmentId,
    };
    // Привязок у учётки две — сервер не выбирает за человека: первый элемент массива это
    // случайный отдел, и отчёт по подразделениям стал бы выдумкой.
    const silent = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, payload);
    expect(silent.statusCode, silent.body).toBe(422);
    expect(silent.json().fields?.requesterDepartmentId).toBeTruthy();

    // Чужое подразделение не принимается: «выбор» не означает «любое».
    const foreign = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      ...payload,
      requesterDepartmentId: ctx.foreignDepartmentId,
    });
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(foreign.json().message).toContain('не числится в этом отделе');
  });

  it('без подсказки из техники отдел у автора нескольких отделов обязателен — 422', async () => {
    const payload = {
      officeEquipmentId: ctx.choicePrinter.id,
      description: 'Не включается',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    };
    const res = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      ...payload,
      requesterDepartmentId: ctx.secondDepartmentId,
    });
    // 422, а не «взяли первый отдел набора»: первый элемент массива — это случайный отдел, и
    // заявка ушла бы в область, к которой человек её не относил.
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('Укажите отдел');

    // Тупика при этом нет: названный свой отдел принимается тем же запросом.
    const chosen = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      ...payload,
      customerDepartmentId: ctx.secondDepartmentId,
      requesterDepartmentId: ctx.secondDepartmentId,
    });
    expect(chosen.statusCode, chosen.body).toBe(201);
    const dto = (chosen.json() as { request: ServiceRequestDto }).request;
    expect(dto.customerDepartment?.id).toBe(ctx.secondDepartmentId);
    // Техника не размечена — второй отдельской оси у заявки нет вовсе.
    expect(dto.equipmentDepartment).toBeNull();
  });

  it('заявку от чужого отдела роль отдела не заводит — 403', async () => {
    const res = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      officeEquipmentId: ctx.freePrinter.id,
      description: 'Проверка чужого отдела',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      customerDepartmentId: ctx.foreignDepartmentId,
    });
    // 403, а не 422: дело не в состоянии заявки, а в том, что от имени этого отдела учётке
    // работать не положено вовсе (`resolveCustomerDepartment`, Р5).
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toContain('только от своих отделов');
  });

  // ── Шаг 15а. «Аппарат стоит не на том объекте» (Р16) ──
  //
  // Признаков два, и делят они работу так: ХРАНИМЫЙ `objectOverridden` — факт заявления («объект в
  // этой заявке указал человек, а не подставила карточка»), он историчен и не гаснет ничем;
  // РАСХОЖДЕНИЕ `objectMismatch` — величина вычисляемая, соединением с карточкой, и гаснет само,
  // когда ИТ-служба перенесёт единицу в справочнике. Одного хранимого мало — он не гаснет; одного
  // вычисляемого мало — технику возят, и у прошлогодних заявок снимок расходится с карточкой
  // сплошь и рядом, никто этого не заявлял.

  it('пометка «не тот объект» и объект — одно утверждение: порознь их не принимают', async () => {
    const body = (extra: Record<string, unknown>) => ({
      officeEquipmentId: '',
      description: 'Аппарат переехал, а карточка нет',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      ...extra,
    });

    // Пометка без объекта не говорит, где аппарат стоит на самом деле.
    const noObject = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
      ...body({ objectOverridden: true }),
      officeEquipmentId: await freshUnit(),
    });
    expect(noObject.statusCode, noObject.body).toBe(400);

    // А объект без пометки — молчаливая подмена области видимости заявки.
    const noFlag = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
      ...body({ objectId: ctx.objectId }),
      officeEquipmentId: await freshUnit(),
    });
    expect(noFlag.statusCode, noFlag.body).toBe(400);
  });

  it('объект вне области заявителя — 422, и заявка не заводится', async () => {
    /*
     * `equipment_object_id` задаёт область видимости роли объекта: свободный выбор означал бы, что
     * заявку можно отправить в чужую область — и увести из своей, оставив автора без собственной
     * заявки. Отбор считает сервер по привязкам `created_by`; портал показывает то же самое, но
     * портал не защита.
     *
     * 422, а не 403: право заводить заявку у штаба есть, негодно присланное значение — ровно тот же
     * код, каким отвечает чужой отдел заявителя.
     */
    const equipmentId = await freshUnit();
    const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
      officeEquipmentId: equipmentId,
      description: 'Аппарат уехал на чужую площадку',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      objectId: ctx.foreignObjectId,
      objectOverridden: true,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('только на свой объект');

    // Заявка не завелась вовсе: та же единица принимает следующую без «уже есть незакрытая» (Р21).
    const ok = await createRequest(ctx.customer.auth, equipmentId, 'Обычная заявка на ту же единицу');
    expect(ok.objectOverridden).toBe(false);
    expect(ok.object.id).toBe(ctx.objectId);
  });

  it('заявленный объект хранится, а расхождение считается по карточке', async () => {
    // Ось у проверки одна — объектная: у роли администратора области нет вовсе, и объект её не
    // сужает. Ему выбор открыт целиком — ровно как и держателю сквозной области модуля.
    const equipmentId = await freshUnit();
    const dto = await createRequest(ctx.admin.auth, equipmentId, 'Аппарат стоит на соседней площадке', {
      objectId: ctx.foreignObjectId,
      objectOverridden: true,
    });
    expect(dto.object.id).toBe(ctx.foreignObjectId);
    // Хранится ЗАЯВЛЕНИЕ, а расхождение вычисляется: снимок заявки разошёлся с карточкой техники,
    // которая по-прежнему числится на своей площадке.
    expect(dto.objectOverridden).toBe(true);
    expect(dto.objectMismatch).toBe(true);

    // Справочник заявка НЕ правит: перенос единицы — решение ИТ-службы после проверки, а карточку
    // заводит всякий заявитель, и опечатка в заявке возила бы аппараты по объектам.
    const equipment = await inject(
      'GET',
      `/api/v1/office-equipment/${equipmentId}`,
      ctx.operator.auth,
    );
    expect(equipment.statusCode, equipment.body).toBe(200);
    expect(equipment.json().object.id).toBe(ctx.objectId);

    // Заявка без пометки расхождения не заявляет: обычная заявка на ту же площадку молчит.
    const plain = await createRequest(ctx.admin.auth, await freshUnit(), 'Обычная заявка');
    expect(plain.objectOverridden).toBe(false);
    expect(plain.objectMismatch).toBe(false);
  });

  // ── Шаг 16. Область справочника оргтехники (Р7) ──
  //
  // Коды ответов по правам — предмет `access-matrix.test.ts`: там закреплено, что справочник
  // закрыт коменданту и сервисной компании целиком, а ведение приходит надстройкой. Здесь
  // проверяется то, чего матрица прав не видит, — **область**: право есть, а строка чужая.

  it('объект правкой карточки не меняется вовсе — для переезда есть своя ручка (Р59)', async () => {
    const res = await inject('PATCH', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth, {
      objectId: ctx.foreignObjectId,
    });
    // 400 схемы, а не 403 области: поле из правки убрано — переезд обязан оставлять след в
    // журнале, и тихая смена площадки в форме такого следа не оставляла.
    expect(res.statusCode, res.body).toBe(400);

    const still = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().object.id).toBe(ctx.objectId);
  });

  it('чужую единицу не перемещают: область проверяется по исходной стороне (Р60)', async () => {
    const res = await inject(
      'POST',
      `/api/v1/office-equipment/${ctx.foreignDeptPrinter.id}/move`,
      ctx.department.auth,
      {
        objectId: ctx.objectId,
        movedOn: TODAY,
        reason: 'Забираем к себе',
      },
    );
    // «Забрать» чужую технику нельзя: перемещение фиксирует отдающая сторона.
    expect(res.statusCode, res.body).toBe(403);
  });

  it('штаб чужой площадки техники не видит — ни в списке, ни по прямому id', async () => {
    expect(await equipmentIds(ctx.foreignShtab.auth)).not.toContain(ctx.mfp.id);
    const direct = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.mfp.id}`,
      ctx.foreignShtab.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  it('роль отдела видит свою и неразмеченную технику, но не технику чужого отдела', async () => {
    const visible = await equipmentIds(ctx.department.auth);
    expect(visible).toContain(ctx.deptPrinter.id);
    // Неразмеченная техника открыта намеренно: разметить её больше некому, и спрятать её от
    // единственного, кто может проставить владельца, значит закрыть разметку навсегда.
    expect(visible).toContain(ctx.freePrinter.id);
    expect(visible).not.toContain(ctx.foreignDeptPrinter.id);
    // Второй отдел этой учётке не принадлежит: техника соседнего отдела ей так же чужая.
    expect(visible).not.toContain(ctx.hintPrinter.id);

    const direct = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.foreignDeptPrinter.id}`,
      ctx.department.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
    expect(direct.json().message).toContain('только с техникой своих отделов');
  });

  /**
   * Реестр действующих гарантий (§9.5) и секция обслуживания в карточке единицы (§8.2).
   *
   * Оба ответа собираются из одних и тех же данных, но по разным правилам видимости, и проверяются
   * вместе именно поэтому: реестр сужается **двумя** областями сразу — парк техники отдаётся по
   * области справочника, ремонты по области заявок, — а секция карточки открывается правом модуля,
   * хотя живёт в справочнике.
   */
  describe('гарантии: реестр и карточка единицы', () => {
    /** Гарантия поставщика — своя, не из ремонта: без неё в реестре был бы один носитель из двух. */
    const SUPPLIER_WARRANTY_ON = plusMonths(TODAY, 24);

    async function warranties(auth: Auth, query = ''): Promise<ServiceWarrantyRowDto[]> {
      const res = await inject('GET', `/api/v1/service-requests/warranties${query}`, auth);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items as ServiceWarrantyRowDto[];
    }

    it('оператор видит оба носителя: гарантию поставщика и гарантию на выполненный ремонт', async () => {
      const patch = await inject(
        'PATCH',
        `/api/v1/office-equipment/${ctx.mfp.id}`,
        ctx.operator.auth,
        {
          warrantyUntil: SUPPLIER_WARRANTY_ON,
        },
      );
      expect(patch.statusCode, patch.body).toBe(200);

      const rows = await warranties(ctx.operator.auth);
      const supplier = rows.find((r) => r.kind === 'equipment' && r.equipmentId === ctx.mfp.id);
      expect(supplier, 'гарантия поставщика в реестре').toBeDefined();
      expect(supplier).toMatchObject({ warrantyUntil: SUPPLIER_WARRANTY_ON, state: 'active' });
      // Заявки у гарантии поставщика нет: её источник — покупка, а не ремонт.
      expect(supplier!.requestId).toBeNull();

      const repair = rows.find((r) => r.itemId === state.performedItemId);
      expect(repair, 'гарантия на выполненный ремонт в реестре').toBeDefined();
      // Реестр — единственное место, где портал берёт `itemId` для обращения по прошлому ремонту
      // (Р26): без него ссылку на позицию сметы человеку взять негде.
      expect(repair).toMatchObject({
        kind: 'repair',
        equipmentId: ctx.mfp.id,
        requestId: state.main.id,
        displayNumber: `СО-${state.main.num}`,
      });

      // Истёкшая гарантия — история: реестр отвечает на вопрос «что ещё покрыто», и просроченная
      // строка в нём означала бы, что по ней ещё можно обратиться.
      expect(rows.some((r) => r.itemId === state.expiredItemId)).toBe(false);
      // Невыполненная позиция гарантии не несёт вовсе (Р12) — ни в реестре, ни в базе.
      expect(rows.some((r) => r.itemId === state.notPerformedItemId)).toBe(false);
    });

    it('сервисная компания видит свои ремонты и не видит парка заказчика', async () => {
      const rows = await warranties(ctx.service.auth);
      expect(rows.some((r) => r.itemId === state.performedItemId)).toBe(true);
      // Справочник исполнителю закрыт (Р7), и реестр — не обход этого запрета: «его» техника в
      // справочнике ничем не отмечена, поэтому гарантии парка означали бы для сервиса весь парк.
      expect(rows.every((r) => r.kind === 'repair')).toBe(true);
    });

    it('штаб чужой площадки не видит ни гарантий техники, ни гарантий её ремонтов', async () => {
      expect(await warranties(ctx.foreignShtab.auth)).toEqual([]);
    });

    it('фильтр «истекает» отбирает по порогу подсветки, а не по всему сроку', async () => {
      // Гарантия, которая правда кончается на днях: месячный срок ремонта в порог не попадает —
      // тридцать дней порога короче календарного месяца, и проверять фильтр им значило бы
      // проверять длину августа.
      const soon = plusDays(TODAY, 10);
      const patch = await inject(
        'PATCH',
        `/api/v1/office-equipment/${ctx.scanner.id}`,
        ctx.operator.auth,
        { warrantyUntil: soon },
      );
      expect(patch.statusCode, patch.body).toBe(200);

      const rows = await warranties(ctx.operator.auth, '?expiring=true');
      expect(rows.some((r) => r.equipmentId === ctx.scanner.id && r.kind === 'equipment')).toBe(
        true,
      );
      // Гарантия поставщика на два года — не «истекает»: иначе срез «что продлевать в этом
      // месяце» вернул бы весь парк.
      expect(rows.some((r) => r.kind === 'equipment' && r.equipmentId === ctx.mfp.id)).toBe(false);
      expect(rows.every((r) => (r.daysLeft ?? 0) <= WARRANTY_EXPIRING_DAYS)).toBe(true);
    });

    it('карточка единицы рассказывает оператору, что с техникой уже делали', async () => {
      const res = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
      expect(res.statusCode, res.body).toBe(200);
      const history = res.json().serviceHistory as OfficeEquipmentServiceEntryDto[];
      expect(history, 'секция обслуживания').toBeDefined();

      const main = history.find((e) => e.id === state.main.id);
      expect(main, 'закрытая заявка в истории').toBeDefined();
      expect(main).toMatchObject({ displayNumber: `СО-${state.main.num}`, status: 'accepted' });
      // Гарантии — только действующие и только по выполненным позициям: карточку открывают, чтобы
      // понять, за что второй раз платить не нужно.
      const covered = main!.warranties.map((w) => w.itemId);
      expect(covered).toContain(state.performedItemId);
      expect(covered).not.toContain(state.expiredItemId);
      expect(covered).not.toContain(state.notPerformedItemId);
    });

    it('держателю справочника секции нет вовсе — право справочника её не открывает', async () => {
      const res = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.keeper.auth);
      // Карточка ему открыта: техникой он и занимается.
      expect(res.statusCode, res.body).toBe(200);
      // А поля нет совсем, а не пустым списком: пустой список означал бы «ремонтов не было», и
      // менеджер решил бы, что аппарат ни разу не чинили.
      expect(res.json().serviceHistory).toBeUndefined();
    });
  });

  // ── Шаг 18. Приём заявки и срочность (план модернизации, Р49, Р56, Р57) ──

  describe('заявитель и срочность', () => {
    it('заявка без ФИО и телефона не заводится — обязательность живёт на сервере, а не в форме', async () => {
      // Своя единица: по каждой разрешена одна открытая заявка (Р21), и занимать чужую нельзя.
      state.urgent.equipmentId = await makeEquipment({
        typeId: ctx.typeId,
        name: 'HP LaserJet M404',
        inventoryNumber: `ОЕ-${RUN}-9`,
        objectId: ctx.objectId,
      });

      const noName = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: state.urgent.equipmentId,
        description: 'Мигает лампа замятия',
        responsiblePhone: '+79990000000',
      });
      expect(noName.statusCode, noName.body).toBe(400);

      const noPhone = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: state.urgent.equipmentId,
        description: 'Мигает лампа замятия',
        responsibleName: 'Иванов Иван Иванович',
      });
      expect(noPhone.statusCode, noPhone.body).toBe(400);
    });

    it('срочность ставится парой «флаг + причина» и снимается вместе с причиной', async () => {
      const dto = await createRequest(
        ctx.customer.auth,
        state.urgent.equipmentId,
        'Не тянет бумагу',
        {
          isUrgent: true,
          urgencyReason: 'Единственный принтер на площадке',
        },
      );
      state.urgent = { ...state.urgent, id: dto.id, num: dto.num };
      expect(dto.isUrgent).toBe(true);
      expect(dto.urgencyReason).toBe('Единственный принтер на площадке');

      /*
       * Срочность переехала на своё право `serviceRequests.urgency` (Н12): прежде она приходила
       * вместе с `serviceRequests.update`, то есть всякому, кто правит заявку. В набор «Ведение»
       * право дописывает каталог полномочий (волна В5), а до его выката держатель у права один —
       * администратор. Поэтому ручку здесь зовёт он: это не про «кому положено», а про то, что
       * маршрут спрашивает право, которого у надстройки пока нет.
       */
      const halfPair = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.admin.auth,
        { isUrgent: true, version: dto.version },
      );
      expect(halfPair.statusCode, halfPair.body).toBe(400);

      const cleared = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.admin.auth,
        { isUrgent: false, version: await version(dto.id) },
      );
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().isUrgent).toBe(false);
      // Причина уходит вместе с флагом: оставшийся текст читался бы как «срочность сняли, но
      // повод остался».
      expect(cleared.json().urgencyReason).toBe('');
    });

    it('срочность ставят и после назначения сервиса, а исполнитель — не ставит вовсе', async () => {
      const id = state.urgent.id;
      const assigned = await inject(
        'PUT',
        `/api/v1/service-requests/${id}/executors`,
        ctx.operator.auth,
        {
          userIds: [],
          serviceCounterpartyId: ctx.serviceCounterpartyId,
          version: await version(id),
        },
      );
      expect(assigned.statusCode, assigned.body).toBe(200);

      // Заказчику заявка уже не правится (§5.3), и срочность вместе с ней: «Новой» она больше не
      // является.
      const byCustomer = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.customer.auth,
        { isUrgent: true, urgencyReason: 'Совсем встало', version: await version(id) },
      );
      expect(byCustomer.statusCode, byCustomer.body).toBe(403);

      // Исполнителю признак не принадлежит вовсе: срочность — решение заказывающей стороны.
      const byService = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.service.auth,
        { isUrgent: true, urgencyReason: 'Поставим себе в приоритет', version: await version(id) },
      );
      expect(byService.statusCode, byService.body).toBe(403);

      // Держатель права `serviceRequests.urgency` (до волны В5 — только администратор).
      const byOperator = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.admin.auth,
        { isUrgent: true, urgencyReason: 'Встала выдача пропусков', version: await version(id) },
      );
      expect(byOperator.statusCode, byOperator.body).toBe(200);
      expect(byOperator.json().isUrgent).toBe(true);
      // Возраст в статусе срочность не сбрасывает: она не ожидание, и очередь «дольше всех ждут»
      // не должна обнуляться от того, что заявку пометили красным.
      expect(byOperator.json().statusChangedAt).toBe(
        (assigned.json() as { request: ServiceRequestDto }).request.statusChangedAt,
      );
    });

    it('срочные идут первыми в списке и отбираются своим фильтром', async () => {
      const all = await inject('GET', '/api/v1/service-requests?pageSize=100', ctx.operator.auth);
      expect(all.statusCode, all.body).toBe(200);
      const items = all.json().items as ServiceRequestDto[];
      expect(items[0]?.id, 'срочная заявка первой строкой').toBe(state.urgent.id);

      const onlyUrgent = await inject(
        'GET',
        '/api/v1/service-requests?urgent=true&pageSize=100',
        ctx.operator.auth,
      );
      expect(onlyUrgent.statusCode, onlyUrgent.body).toBe(200);
      const urgentItems = onlyUrgent.json().items as ServiceRequestDto[];
      expect(urgentItems.every((r) => r.isUrgent)).toBe(true);
      expect(urgentItems.map((r) => r.id)).toContain(state.urgent.id);
    });

    it('снимок места в заявке не переписывается переездом карточки', async () => {
      const moved = await inject(
        'PATCH',
        `/api/v1/office-equipment/${state.urgent.equipmentId}`,
        ctx.operator.auth,
        { location: 'кабинет 305' },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().location).toBe('кабинет 305');

      const request = await inject(
        'GET',
        `/api/v1/service-requests/${state.urgent.id}`,
        ctx.operator.auth,
      );
      expect(request.statusCode, request.body).toBe(200);
      // Заявка помнит место, где аппарат стоял в момент заведения: по нему ехали, и переезд
      // карточки этого не отменяет (Р57).
      expect(request.json().equipment.location).toBe('кабинет 214');
    });

    it('история заявки читает срочность отдельным событием, а не правкой', async () => {
      const res = await inject(
        'GET',
        `/api/v1/service-requests/${state.urgent.id}/history`,
        ctx.operator.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const kinds = (res.json() as { kind: string; changes: { field: string }[] }[]).filter(
        (e) => e.kind === 'urgencyChanged',
      );
      expect(kinds.length, 'событий срочности').toBeGreaterThanOrEqual(2);
      expect(kinds.some((e) => e.changes.some((c) => c.field === 'isUrgent'))).toBe(true);
    });
  });

  // ── Шаг 19. Перемещения и местонахождение единицы (Р59–Р63) ──

  describe('перемещения техники', () => {
    it('перемещение записывает обе стороны, меняет карточку и попадает в ленту (Р59, Р62)', async () => {
      const equipmentId = state.urgent.equipmentId;
      const before = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}`,
        ctx.operator.auth,
      );
      expect(before.json().state).toBe('on_site');

      // Увезли в сервис — переезд, вызванный ремонтом: у записи есть ссылка на заявку.
      const away = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          location: '',
          state: 'at_service',
          movedOn: TODAY,
          reason: 'Увезли в сервис по заявке',
          serviceRequestId: state.urgent.id,
        },
      );
      expect(away.statusCode, away.body).toBe(201);
      expect(away.json().state).toBe('at_service');

      // Переезд на чужую площадку разрешён (Р60): отдающий теряет технику из своего списка.
      const moved = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.foreignObjectId,
          location: 'кабинет 12',
          state: 'on_site',
          movedOn: TODAY,
          reason: 'Перевод бухгалтерии на другую площадку',
        },
      );
      expect(moved.statusCode, moved.body).toBe(201);
      expect(moved.json().object.id).toBe(ctx.foreignObjectId);
      expect(moved.json().location).toBe('кабинет 12');

      // И из справочника отдающего она исчезла — это и есть «утрата, а не захват».
      expect(
        (await inject('GET', '/api/v1/office-equipment?pageSize=200', ctx.operator.auth))
          .json()
          .items.map((row: { id: string }) => row.id),
      ).not.toContain(equipmentId);

      // Лента карточки читается администратором: у него область сквозная.
      const history = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}/history`,
        ctx.admin.auth,
      );
      expect(history.statusCode, history.body).toBe(200);
      // Лента — один поток событий с курсором (Р75–Р79): перемещения приходят в нём наравне с
      // ремонтами, правками карточки и гарантиями, а не отдельным массивом.
      const page = history.json() as {
        items: {
          kind: string;
          toObject?: { id: string };
          toState?: string;
          serviceRequestNum?: number | null;
        }[];
        serviceVisible: boolean;
      };
      const movements = page.items.filter((event) => event.kind === 'movement');
      expect(movements).toHaveLength(2);
      // Свежее сверху: карточку открывают вопросом «где оно сейчас и откуда приехало».
      expect(movements[0]).toMatchObject({
        toObject: { id: ctx.foreignObjectId },
        toState: 'on_site',
      });
      expect(movements[1]).toMatchObject({
        toState: 'at_service',
        serviceRequestNum: state.urgent.num,
      });
      // Ремонтная часть открыта тому, кому открыт модуль.
      expect(page.serviceVisible).toBe(true);
      expect(page.items.some((event) => event.kind === 'service_request')).toBe(true);
    });

    it('перемещение без изменений и без причины не записывается', async () => {
      const equipmentId = ctx.scanner.id;
      const same = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        { objectId: ctx.objectId, location: 'кабинет 214', movedOn: TODAY, reason: 'Просто так' },
      );
      // Запись «переехало туда, где стояло» — строка ни о чём: журнал, которому нельзя верить,
      // хуже отсутствующего.
      expect(same.statusCode, same.body).toBe(422);

      const noReason = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        { objectId: ctx.foreignObjectId, movedOn: TODAY, reason: '' },
      );
      expect(noReason.statusCode, noReason.body).toBe(400);
    });

    it('«на складе» без уточнения не принимается: искать такую технику негде (Р61)', async () => {
      const res = await inject(
        'POST',
        `/api/v1/office-equipment/${ctx.scanner.id}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          state: 'in_stock',
          movedOn: TODAY,
          reason: 'Сняли с эксплуатации до переезда',
        },
      );
      expect(res.statusCode, res.body).toBe(400);

      const ok = await inject(
        'POST',
        `/api/v1/office-equipment/${ctx.scanner.id}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          state: 'in_stock',
          stateNote: 'Склад АХО, стеллаж 3',
          movedOn: TODAY,
          reason: 'Сняли с эксплуатации до переезда',
        },
      );
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().stateNote).toBe('Склад АХО, стеллаж 3');

      // Срез «в ремонте, а заявок нет» её не показывает: она на складе, а не в сервисе.
      const stranded = await inject(
        'GET',
        '/api/v1/office-equipment?strandedAtService=true&pageSize=200',
        ctx.admin.auth,
      );
      expect(stranded.statusCode, stranded.body).toBe(200);
      expect(stranded.json().items.map((row: { id: string }) => row.id)).not.toContain(
        ctx.scanner.id,
      );
    });

    it('ленту обслуживания не отдают тому, кому закрыт модуль', async () => {
      const res = await inject(
        'GET',
        `/api/v1/office-equipment/${ctx.mfp.id}/history`,
        ctx.keeper.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { items: { kind: string }[]; serviceVisible: boolean };
      // События самой карточки он видит: это справочник, который он и ведёт (заведение,
      // перемещения, правки).
      expect(
        page.items.some((event) =>
          ['card_lifecycle', 'movement', 'card_change'].includes(event.kind),
        ),
      ).toBe(true);
      // А ремонтной части нет вовсе, и признак говорит именно «не положено видеть», а не «пусто»:
      // то же правило, что у секции карточки.
      expect(page.serviceVisible).toBe(false);
      expect(page.items.some((event) => event.kind === 'service_request')).toBe(false);
    });
  });

  // ── Шаг 20. Заморозка заявки (план `office-equipment-cycle-changes-plan.md`, Р103–Р111, Р118, Р119) ──
  //
  // Заморозка — статус, а не флаг рядом со статусом (Р103): из неё нет обычных ходов, и ровно это
  // проверяется здесь. Живой схемой, а не контрактами: пара «откуда и почему» связана в базе тремя
  // CHECK'ами (`service_requests_hold_check`, `service_requests_held_from_check`, переписанный
  // `service_requests_executor_check`), и разъехаться с ними код может только на настоящем
  // PostgreSQL — на моках все три условия просто не существуют.

  describe('заморозка и возврат', () => {
    it('заявку откладывают из каждого рабочего статуса и возвращают ровно в него (Р104, Р106, Р108)', async () => {
      for (const status of WORKING_STATUSES) {
        const before = await requestIn(status, `Заморозка из статуса «${status}»`);
        expect(before.status, 'подготовка статуса').toBe(status);

        const frozenRes = await hold(before.id, 'Ждём запчасть с завода');
        expect(frozenRes.statusCode, frozenRes.body).toBe(200);
        const frozen = frozenRes.json() as ServiceRequestDto;
        expect(frozen.status).toBe('on_hold');
        // Куда вернуть, помнит сама заявка (Р104). Выбирай цель человек — «Отложена» стала бы
        // вторым входом в цикл, в обход визы ИТ, назначения и согласования сметы.
        expect(frozen.heldFromStatus).toBe(status);
        expect(frozen.holdReason).toBe('Ждём запчасть с завода');
        // Заморозку не ждёт никто (Р111): она стоит по решению оператора, а не в чьей-то очереди.
        expect(frozen.waitingOn).toBe('hold');
        // Возраст в статусе обнуляется заморозкой (Р108): «Отложена · 12 дней» — тот самый сигнал,
        // ради которого статус и заводили, и наследовать чужое время он не должен.
        expect(new Date(frozen.statusChangedAt).getTime()).toBeGreaterThan(
          new Date(before.statusChangedAt).getTime(),
        );

        const backRes = await resume(before.id);
        expect(backRes.statusCode, backRes.body).toBe(200);
        const back = backRes.json() as ServiceRequestDto;
        expect(back.status).toBe(status);
        // Поля заморозки чистит матрица сбросов (Р118), а не ручка: иначе возврат упёрся бы в
        // `service_requests_hold_check` ошибкой БД — статус уже не `on_hold`, а исходный ещё стоит.
        expect(back.heldFromStatus).toBeNull();
        expect(back.holdReason).toBe('');
        expect(back.waitingOn).not.toBe('hold');
        // И второй раз — при возврате (Р108): вернувшийся исполнитель не наследует время простоя.
        expect(new Date(back.statusChangedAt).getTime()).toBeGreaterThan(
          new Date(frozen.statusChangedAt).getTime(),
        );

        // Заморозка ничего не отменяет: согласование сметы и факт закрытия переживают её целиком —
        // иначе «остановили на неделю» означало бы заново собранную смету и заново предъявленные
        // работы.
        if (status === 'in_work' || status === 'done') {
          expect(back.approval?.revision, `согласование после возврата в «${status}»`).toBe(1);
        }
        if (status === 'done') expect(back.completion?.totalAmount).toBe(1000);
      }
    }, 120_000);

    /**
     * Прежде перечень рабочих статусов включал «Назначена» и «Смету на согласовании», и заморозка
     * из них проверялась общим циклом выше. Статусов больше нет (Р1), а состояния — есть, и
     * называют их теперь признаки строки. Значит и проверять надо признаки: заморозка обязана
     * возвращать заявку не просто в тот же статус, а в то же ОЖИДАНИЕ — иначе отложенная под
     * висящей подписью возвращалась бы обычной «В работе», и предъявленный счёт молча выпадал бы
     * из очереди согласования.
     */
    it('заморозка возвращает заявку в то же ожидание, а не только в тот же статус', async () => {
      const pending = await pendingEstimateRequest('Заморозка под висящим предъявлением');
      expect(pending.waitingOn).toBe('approval');

      const frozenRes = await hold(pending.id, 'Ждём решения по деньгам');
      expect(frozenRes.statusCode, frozenRes.body).toBe(200);
      const frozen = frozenRes.json() as ServiceRequestDto;
      expect(frozen.status).toBe('on_hold');
      expect(frozen.heldFromStatus).toBe('in_work');
      // Заморозка снимает заявку со всех очередей — но предъявление не гасит: ответа по нему как
      // не было, так и нет.
      expect(frozen.waitingOn).toBe('hold');
      expect(frozen.estimatePendingRevision).toBe(pending.estimateRevision);

      const backRes = await resume(pending.id);
      expect(backRes.statusCode, backRes.body).toBe(200);
      const back = backRes.json() as ServiceRequestDto;
      expect(back.status).toBe('in_work');
      expect(back.estimatePendingRevision).toBe(pending.estimateRevision);
      expect(back.waitingOn).toBe('approval');

      // И согласовать её после возврата можно тем же ходом: предъявление дожило целиком.
      const approved = await inject(
        'PATCH',
        `/api/v1/service-requests/${pending.id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: back.version },
      );
      expect(approved.statusCode, approved.body).toBe(200);
      expect((approved.json() as ServiceRequestDto).approval?.revision).toBe(
        pending.estimateRevision,
      );
    });

    it('заморозка без причины не проходит: ни пустой, ни из пробелов (Р107)', async () => {
      const dto = await assignedRequest('Причина заморозки обязательна');
      for (const reason of ['', '   ']) {
        const res = await inject(
          'PATCH',
          `/api/v1/service-requests/${dto.id}/hold`,
          ctx.operator.auth,
          {
            reason,
            version: dto.version,
          },
        );
        // Даты «отложена до» у заморозки нет вовсе (Р107): на вопрос «когда ждать» отвечает только
        // причина, и «Отложена · 12 дней» без неё не читается никак.
        expect(res.statusCode, res.body).toBe(400);
      }
      expect((await card(dto.id)).status).toBe('new');
    });

    it('исполнитель заявку не откладывает и не возвращает — заморозку ставит тот, кто её ведёт (Р105)', async () => {
      const dto = await requestIn('in_work', 'Заморозку ставит оператор, а не сервис');

      const byService = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/hold`,
        ctx.service.auth,
        { reason: 'Ждём запчасть — пусть повисит', version: dto.version },
      );
      // Заморозку маршрут спрашивает предикатом контрактов `canHoldService`, а не правом (§7.3), и
      // исполнителю она закрыта при **любом** праве (Р105): о задержке сервис сообщает
      // примечанием, а останавливает заявку тот, кто её ведёт, — иначе «ждём запчасть»
      // становилось бы решением подрядчика.
      expect(byService.statusCode, byService.body).toBe(403);
      expect(byService.json().message).toContain('это шаг того, кто её ведёт');

      // Заказчику отказывает тот же предикат: заявку он завёл, но не ведёт.
      const byCustomer = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/hold`,
        ctx.customer.auth,
        { reason: 'Подождём до следующего месяца', version: dto.version },
      );
      expect(byCustomer.statusCode, byCustomer.body).toBe(403);

      const frozen = await hold(dto.id, 'Ждём запчасть с завода');
      expect(frozen.statusCode, frozen.body).toBe(200);

      const backByService = await resume(dto.id, ctx.service.auth);
      expect(backByService.statusCode, backByService.body).toBe(403);
      // Отказ говорит про сторону, а не про конкретную учётку: сверяется право, и та же фраза
      // обязана оставаться верной для администратора, снимающего чужую заморозку (ниже).
      expect(backByService.json().message).toContain('это шаг того, кто её ведёт');

      // Отпускает заявку ведущая сторона, а не тот же человек: администратор снимает заморозку
      // оператора — иначе отложенная заявка ушедшего в отпуск оператора осталась бы стоять.
      const byAdmin = await resume(dto.id, ctx.admin.auth);
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      expect(byAdmin.json().status).toBe('in_work');
    });

    it('отложенную не правят, срочность ей не меняют и обычных ходов у неё нет (Р110, Р119)', async () => {
      const dto = await assignedRequest('Матрица действий отложенной заявки');
      // Срочность спрашивает своё право (Н12), и до волны В5 его держит только администратор.
      const urgent = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.admin.auth,
        {
          isUrgent: true,
          urgencyReason: 'Единственный принтер на площадке',
          version: dto.version,
        },
      );
      expect(urgent.statusCode, urgent.body).toBe(200);

      const frozen = await hold(dto.id, 'Нет денег до начала квартала');
      expect(frozen.statusCode, frozen.body).toBe(200);

      // Правка предмета — ход мимо остановки: `on_hold` в перечень правимых не входит, и
      // отложенную правят, вернув её в работу. Заявка вдобавок уже распределена, а после Р14
      // назначенную не правят и в «Новой»: за ней стоят договорённости с исполнителем.
      const edited = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}`,
        ctx.operator.auth,
        { description: 'Переписали неисправность', version: await version(dto.id) },
      );
      expect(edited.statusCode, edited.body).toBe(403);

      // Срочность (Р119) — 422, а не 403: право у держателя есть, отказ даёт состояние заявки.
      // Разбирать красную метку поверх остановки незачем — очередь срочных отложенную не
      // показывает, и «поставили срочность» не сдвинуло бы её ни на строку.
      const urgency = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.admin.auth,
        { isUrgent: false, urgencyReason: '', version: await version(dto.id, ctx.admin.auth) },
      );
      expect(urgency.statusCode, urgency.body).toBe(422);
      expect(urgency.json().message).toContain('Отложенной заявке срочность не меняют');

      // Обычный ход: принять отложенную в работу нельзя — коридоры `on_hold` пусты у всех
      // четырёх сторон, и заморозка перестала бы что-либо останавливать.
      const start = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/start`,
        ctx.service.auth,
        { version: await version(dto.id) },
      );
      expect(start.statusCode, start.body).toBe(403);

      // Административный откат — тоже (Р110): выходов из заморозки два, возврат и отмена, и
      // третий пришлось бы считать от `held_from_status` вторым путём.
      const rollback = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/status`,
        ctx.admin.auth,
        {
          status: 'new',
          reason: 'Откатить назначение',
          version: await version(dto.id, ctx.admin.auth),
        },
      );
      expect(rollback.statusCode, rollback.body).toBe(422);

      // Ни одна отклонённая попытка заявку не сдвинула.
      const after = await card(dto.id);
      expect(after.status).toBe('on_hold');
      // Отложили распределённую «Новую» — в неё же и вернут: «Назначена» снята (Р1), и признак
      // «исполнители есть» заморозку переживает наравне с остальными полями заявки.
      expect(after.heldFromStatus).toBe('new');
      expect(after.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(after.description).toBe('Матрица действий отложенной заявки');
    });

    it('отложенная принимает документы исходного статуса и примечание исполнителя (Р110)', async () => {
      const dto = await assignedRequest('Отложенная живёт обычной жизнью');
      const frozen = await hold(dto.id, 'Ждём решения заказчика по деньгам');
      expect(frozen.statusCode, frozen.body).toBe(200);

      // Вид документа решает «эффективный» статус (Р110) — тот, из которого отложили: вложение
      // принадлежит «Новой», и заморозка его вида не меняет. Тот же расчёт делает портал, и
      // разойдись они — портал предлагал бы вид, на котором придёт отказ.
      const attachment = await attach(dto.id, 'attachment', 'foto-otlozhennoy.pdf');
      expect(attachment.res.statusCode, attachment.res.body).toBe(200);

      // А вид, которого исходный статус не знает, по-прежнему не принимают: заморозка правила
      // видов не отменяет — она их не меняет. Объём работ ведут из «В работе» (Р8), и талон
      // подшивают начиная с неё же (§7.3) — «Новая» не знает ни того, ни другого.
      const estimate = await attach(dto.id, 'estimate', 'kp-ranshe-vremeni.pdf');
      expect(estimate.res.statusCode, estimate.res.body).toBe(422);
      const warranty = await attach(dto.id, 'warranty_card', 'talon-ranshe-vremeni.pdf');
      expect(warranty.res.statusCode, warranty.res.body).toBe(422);

      // «Запчасть будет 3-го» пишут именно тогда, когда заявка стоит: запрети мы примечание,
      // единственный способ сообщить о сроке исчез бы вместе с ходом заявки.
      const comment = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/service-comment`,
        ctx.service.auth,
        { serviceComment: 'Запчасть будет 3-го', version: await version(dto.id) },
      );
      expect(comment.statusCode, comment.body).toBe(200);
      expect((comment.json() as ServiceRequestDto).serviceComment).toBe('Запчасть будет 3-го');
      expect((comment.json() as ServiceRequestDto).status).toBe('on_hold');
    });

    it('пока заявка отложена, вторую на ту же единицу не завести (Р109)', async () => {
      const equipmentId = await freshUnit();
      const dto = await createRequest(
        ctx.customer.auth,
        equipmentId,
        'Отложенная занимает единицу',
      );
      const frozen = await hold(dto.id, 'Ждём решения заказчика');
      expect(frozen.statusCode, frozen.body).toBe(200);

      const second = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: equipmentId,
        description: 'Тот же аппарат, второй заход',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      // Отложенная — открытая (Р109): техника ждёт этого же ремонта, и вторая заявка означала бы
      // два сервиса и два акта на одну работу. Держит это частичный уникальный индекс
      // `service_requests_open_per_equipment_unique`, чьё условие `on_hold` и не знает.
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json().message).toContain(formatServiceRequestNumber(dto.num));
    });

    it('отложенная выпадает из очереди «ждут меня» и из счётчика раздела (Р111)', async () => {
      const dto = await requestIn('new', 'Отложенная не ждёт оператора');
      const before = await waitingCount(ctx.operator.auth);
      expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).toContain(dto.id);

      const frozen = await hold(dto.id, 'Нет денег до начала квартала');
      expect(frozen.statusCode, frozen.body).toBe(200);

      // `serviceWaitingOn('on_hold')` — своё значение `hold`, и `isWaitingOn` для него ложно ни у
      // кого: заморозка не «ждёт оператора» — она не ждёт вовсе, и в очереди «Требуют решения» ей
      // делать нечего.
      expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).not.toContain(dto.id);
      expect(await listIds(ctx.itApprover.auth, '&waitingOnMe=true')).not.toContain(dto.id);
      // Бейдж раздела считает ту же очередь своей ручкой: разойдись они, число вело бы в пустой
      // список.
      expect(await waitingCount(ctx.operator.auth)).toBe(before - 1);

      const back = await resume(dto.id);
      expect(back.statusCode, back.body).toBe(200);
      expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).toContain(dto.id);
      expect(await waitingCount(ctx.operator.auth)).toBe(before);
    });

    it('срочная отложенная не всплывает первой строкой и не входит в фильтр срочных (Р119)', async () => {
      // Обычная заявка заводится **первой**: список берётся по номеру по возрастанию, и без
      // правила «срочные вперёд» она стоит выше. Всплывёт срочная — значит правило сработало, и
      // проверка отличает «отложенную не подняли» от «сортировки нет вовсе».
      const ordinary = await assignedRequest('Обычная заявка для сравнения порядка');
      const urgent = await createRequest(
        ctx.customer.auth,
        await freshUnit(),
        'Срочная, но отложенная',
        { isUrgent: true, urgencyReason: 'Единственный принтер на площадке' },
      );

      const frozenRes = await hold(urgent.id, 'Ждём поставку картриджа');
      expect(frozenRes.statusCode, frozenRes.body).toBe(200);
      const frozen = frozenRes.json() as ServiceRequestDto;
      // Признак заморозка не гасит (Р119): заявка не перестала быть срочной оттого, что её
      // остановили, и после возобновления красная метка должна работать без второго объяснения.
      expect(frozen.isUrgent).toBe(true);
      expect(frozen.urgencyReason).toBe('Единственный принтер на площадке');

      const byNum = () => listIds(ctx.operator.auth, '&sortBy=num&sortOrder=asc');
      const held = await byNum();
      expect(held).toContain(urgent.id);
      // Первой строкой списка стоит то, за что берутся сейчас, а отложенная ждёт решения, а не рук.
      expect(held[0]).not.toBe(urgent.id);
      expect(held.indexOf(urgent.id)).toBeGreaterThan(held.indexOf(ordinary.id));
      // Фильтр срочных — та же очередь: показывай он отложенные, оператор начинал бы день со
      // списка, половина которого не двигается.
      expect(await listIds(ctx.operator.auth, '&urgent=true')).not.toContain(urgent.id);

      const back = await resume(urgent.id);
      expect(back.statusCode, back.body).toBe(200);
      const resumed = await byNum();
      // Возобновлённая срочная встаёт наверх сама — сортировка на месте, и наверх её не пускала
      // именно заморозка.
      expect(resumed.indexOf(urgent.id)).toBeLessThan(resumed.indexOf(ordinary.id));
      expect(await listIds(ctx.operator.auth, '&urgent=true')).toContain(urgent.id);
    });

    it('отмена отложенной заявки проходит и чистит всё сразу: заморозку, исполнителя и согласование (Р118)', async () => {
      const dto = await requestIn('in_work', 'Отмена отложенной со сметой и исполнителем');
      expect(dto.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(dto.approval?.revision).toBe(1);

      const frozen = await hold(dto.id, 'Ждём решения заказчика: аппарат, возможно, меняют');
      expect(frozen.statusCode, frozen.body).toBe(200);
      expect((frozen.json() as ServiceRequestDto).heldFromStatus).toBe('in_work');

      const cancelled = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/status`,
        ctx.operator.auth,
        {
          status: 'cancelled',
          reason: 'Аппарат решили менять целиком',
          version: await version(dto.id),
        },
      );
      // 200, а не 500 (Р118): флаг `hold` в матрице сбросов поднимается на **любом** выходе из
      // заморозки, и без него отмену отложенной поймал бы `service_requests_hold_check` ошибкой
      // БД — статус уже `cancelled`, а `held_from_status` ещё стоит.
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const after = (cancelled.json() as { request: ServiceRequestDto }).request;
      expect(after.status).toBe('cancelled');
      expect(after.heldFromStatus).toBeNull();
      expect(after.holdReason).toBe('');
      // Второй факт той же проверки: флаг заморозки **дополняет** обычный сброс, а не подменяет
      // его. Отмена отложенной обязана снять исполнителя и снимок согласования ровно так же, как
      // отмена из любого другого статуса, — иначе у отменённой остались бы и сервис, и согласие со
      // сметой, которую никто не выполнит.
      expect(after.service).toBeNull();
      expect(after.approval).toBeNull();

      // Колонками, а не только DTO: снимок согласования собирается из трёх полей, и `approval`
      // показал бы `null`, будь пустым хоть одно из них.
      const row = await ctx.db.execute<{
        service_counterparty_id: string | null;
        estimate_approved_by: string | null;
        estimate_approved_at: Date | null;
        approved_estimate_revision: number | null;
        held_from_status: string | null;
        hold_reason: string;
      }>(sql`
        SELECT service_counterparty_id, estimate_approved_by, estimate_approved_at,
               approved_estimate_revision, held_from_status, hold_reason
        FROM service_requests WHERE id = ${dto.id}`);
      expect(row.rows[0]).toEqual({
        service_counterparty_id: null,
        estimate_approved_by: null,
        estimate_approved_at: null,
        approved_estimate_revision: null,
        held_from_status: null,
        hold_reason: '',
      });
    });
  });

  // ── Шаг 21. Планка закрывающего документа и его снятие (Н8, Р112) ──

  describe('планка закрывающего документа', () => {
    it('без документа заявка сервиса в «Решена» не уходит, и вложение закрывающим не считается', async () => {
      // Планка переехала с приёмки на «Решена» (Н8): за работу внешнего сервиса платят, и бумага —
      // основание платежа. Прежде она стояла на приёмке, и работа предъявлялась без единого
      // документа.
      const dto = await requestIn('in_work', 'Закрытие работ требует бумаги');
      const empty = await completeWork(dto.id);
      expect(empty.statusCode, empty.body).toBe(422);
      expect(empty.json().message).toContain('требует закрывающего документа');

      // Вложение — «обычная жизнь» заявки, а не документ: фотография принтера ничего не закрывает,
      // и планка, которую снимает любой приложенный файл, не планка вовсе.
      const photo = await attach(dto.id, 'attachment', 'foto-printera.pdf');
      expect(photo.res.statusCode, photo.res.body).toBe(200);
      const withPhoto = await completeWork(dto.id);
      expect(withPhoto.statusCode, withPhoto.body).toBe(422);
      expect((await card(dto.id)).status).toBe('in_work');
    });

    it('любого из трёх документов по отдельности хватает: акт, счёт, гарантийный талон', async () => {
      // Комплекта планка не требует (ответ заказчика от 19.08.2026): любой из трёх подтверждает,
      // что работа состоялась. Нужен контроль комплекта — это отчёт, а не запрет на закрытие.
      //
      // Гарантийный талон в этом перечне и объясняет правку `FILE_KIND_STATUSES` (§7.3): подшить
      // его нужно **до** «Решена», иначе заявка, у которой единственная бумага — талон, не
      // закрылась бы вовсе.
      for (const kind of ['act', 'invoice', 'warranty_card']) {
        const dto = await requestIn('in_work', `Закрытие по одному документу вида «${kind}»`);
        const doc = await attach(dto.id, kind, `${kind}.pdf`);
        expect(doc.res.statusCode, doc.res.body).toBe(200);

        const completed = await completeWork(dto.id);
        expect(completed.statusCode, completed.body).toBe(200);
        expect((completed.json() as ServiceRequestDto).status).toBe('done');

        const accepted = await acceptWork(dto.id);
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect((accepted.json() as ServiceRequestDto).status).toBe('accepted');
      }
    }, 60_000);

    it('у принятой заявки единственный акт уже не снять', async () => {
      const dto = await requestIn('done', 'Снятие акта после приёмки');
      const act = { fileId: await closingFileId(dto.id) };
      const accepted = await acceptWork(dto.id);
      expect(accepted.statusCode, accepted.body).toBe(200);

      // Проверки снятия стоят внутри транзакции и читают статус, перечитанный под блокировкой
      // (Р112). Прежде они решали по строке, прочитанной до транзакции, — то есть по состоянию,
      // которое к моменту удаления уже могло стать «Принята».
      const detached = await inject(
        'DELETE',
        `/api/v1/service-requests/${dto.id}/files/${act.fileId}`,
        ctx.service.auth,
      );
      expect(detached.statusCode, detached.body).toBe(403);
      expect((await card(dto.id)).files.map((f) => f.kind)).toEqual(['act']);
    });

    it('последний закрывающий документ не снимает и администратор, а предпоследний — снимает', async () => {
      const dto = await requestIn('done', 'Замена акта у принятой заявки');
      const act = { fileId: await closingFileId(dto.id) };
      expect((await acceptWork(dto.id)).statusCode).toBe(200);

      /*
       * `files.manageAny` снимает чужие файлы и работает в закрытой заявке — но не тогда, когда
       * этот файл единственный оставшийся закрывающий (ADR 0125, ответ заказчика от 19.08.2026).
       * Иначе планка приёмки держалась бы только в момент нажатия кнопки: принять без бумаги
       * нельзя, а снять её через минуту — можно, и принятая заявка осталась бы без подтверждения
       * работы, не отбираясь ни очередью, ни отчётом.
       */
      const last = await inject(
        'DELETE',
        `/api/v1/service-requests/${dto.id}/files/${act.fileId}`,
        ctx.admin.auth,
      );
      expect(last.statusCode, last.body).toBe(422);
      expect(last.json().message).toContain('единственный документ, по которому заявку приняли');

      // Ошибочный акт меняется в обратном порядке: сначала подшить верный, потом снять неверный.
      const fixed = await attach(
        dto.id,
        'act',
        'akt-vernyy.pdf',
        ctx.operator.auth,
        ctx.operator.id,
      );
      expect(fixed.res.statusCode, fixed.res.body).toBe(200);

      const detached = await inject(
        'DELETE',
        `/api/v1/service-requests/${dto.id}/files/${act.fileId}`,
        ctx.admin.auth,
      );
      expect(detached.statusCode, detached.body).toBe(200);
      const after = await card(dto.id);
      expect(after.status).toBe('accepted');
      expect(after.files.map((f) => f.filename)).toEqual(['akt-vernyy.pdf']);
      expect(after.acceptanceSource).toBe('human');
    });

    /**
     * Очередь на строке заявки (Р112) — обеими сторонами.
     *
     * Стенд один на оба порядка: строку заявки держит **третье** соединение, а обе ручки уходят в
     * приложение при уже занятой строке и выстраиваются за ней. Так проверяется сериализация, а не
     * удача планировщика: кто из двух запросов доберётся до базы первым, иначе решал бы цикл
     * событий, и тест был бы зелёным при любом поведении сервера.
     *
     * Порядок ожидания задаёт сам PostgreSQL: освободившуюся строку он отдаёт ожидающим в порядке
     * очереди, поэтому первым проходит тот, кто встал раньше, а второй решает уже по его
     * результату — ради этого `lockRequest` и перечитывает строку под блокировкой.
     */
    async function underRowLock(
      requestId: string,
      first: () => Promise<Injected>,
      second: () => Promise<Injected>,
    ): Promise<[Injected, Injected]> {
      const blocker = new pg.Client({ connectionString: DB_URL });
      await blocker.connect();
      const settled = { first: false, second: false };
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [
          requestId,
        ]);

        const firstP = first().then((res) => {
          settled.first = true;
          return res;
        });
        // Пауза задаёт порядок очереди: запрос, ушедший раньше, раньше и встаёт на блокировку.
        await pause(250);
        const secondP = second().then((res) => {
          settled.second = true;
          return res;
        });
        await pause(250);

        // Обе ручки стоят на занятой строке: ответь любая сейчас — значит, она решает по
        // состоянию, прочитанному до транзакции, и «сериализованы» осталось бы словом в
        // комментарии.
        expect(settled.first, 'первый запрос ждёт освобождения строки заявки').toBe(false);
        expect(settled.second, 'второй запрос ждёт освобождения строки заявки').toBe(false);

        await blocker.query('COMMIT');
        return await Promise.all([firstP, secondP]);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end();
      }
    }

    it('приёмка успела первой — снятие документа видит «Принята» и отказывает (Р112)', async () => {
      const dto = await requestIn('done', 'Гонка: приёмка впереди снятия');
      const act = { fileId: await closingFileId(dto.id) };
      const at = await version(dto.id);

      const [accepted, detached] = await underRowLock(
        dto.id,
        () =>
          inject('PATCH', `/api/v1/service-requests/${dto.id}/accept`, ctx.operator.auth, {
            version: at,
          }),
        () =>
          inject(
            'DELETE',
            `/api/v1/service-requests/${dto.id}/files/${act.fileId}`,
            ctx.service.auth,
          ),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      // Снятие решает по статусу, перечитанному под блокировкой, а не по строке из
      // `requireEditable`: та говорила «Ожидает приёмки», и по ней акт сняли бы у уже принятой
      // заявки — та осталась бы без единственной бумаги.
      expect(detached.statusCode, detached.body).toBe(403);

      const after = await card(dto.id);
      expect(after.status).toBe('accepted');
      expect(after.files.map((f) => f.kind)).toEqual(['act']);
    }, 30_000);

    it('снятие успело первым — закрытие работ видит заявку без бумаги и отказывает (Н8)', async () => {
      // Та же очередь на строке заявки, что и у приёмки, только планка теперь стоит на «Решена»:
      // проверяется она **внутри** транзакции и после блокировки. Спроси её закрытие по DTO,
      // прочитанному до транзакции, — работа предъявилась бы без единого документа.
      const dto = await requestIn('in_work', 'Гонка: снятие впереди закрытия работ');
      const act = await attach(dto.id, 'act', 'akt-gonka-snyatie.pdf');
      expect(act.res.statusCode, act.res.body).toBe(200);
      const at = await card(dto.id);

      const [detached, completed] = await underRowLock(
        dto.id,
        () =>
          inject(
            'DELETE',
            `/api/v1/service-requests/${dto.id}/files/${act.fileId}`,
            ctx.service.auth,
          ),
        () =>
          inject('PATCH', `/api/v1/service-requests/${dto.id}/complete`, ctx.service.auth, {
            completedOn: TODAY,
            items: at.items.map((item) => ({ id: item.id, performed: true })),
            version: at.version,
          }),
      );
      // Заявка ещё не закрыта, акт подшивал сам исполнитель — снятие законно.
      expect(detached.statusCode, detached.body).toBe(200);
      expect(completed.statusCode, completed.body).toBe(422);
      expect(completed.json().message).toContain('требует закрывающего документа');

      const after = await card(dto.id);
      expect(after.status).toBe('in_work');
      expect(after.files).toEqual([]);
    }, 30_000);
  });
  // ── Поимённый исполнитель: страж «одно из прав» (блокер, найденный волной В3) ──
  /**
   * Ходы исполнителя закрыты правом стороны — `serviceRequests.status` у «принять в работу» и
   * отказа, `serviceRequests.estimate` у сметы, закрытия работ и примечания. У набора «Оргтехника:
   * ИТ-служба» нет ни того, ни другого (план §7.2), а дугу поимённому исполнителю открывает
   * назначение вместе с `serviceRequests.execute`. Пока страж требовал право стороны, он отвечал
   * такому исполнителю 403 **раньше**, чем коридор успевал разрешить ему ход, и матрица §6 для него
   * не работала ни при каком `execute`.
   *
   * Поэтому маршруты переведены на страж «одно из перечисленных прав». Проверяются обе половины
   * решения, и порознь ни одна ничего не доказывает:
   *
   * - назначенный поимённо проходит свой коридор целиком — значит страж пускает;
   * - держатель того же набора **без назначения** получает отказ, и отказ этот приходит **не от
   *   стража**: его узнают по тексту («не может перевести заявку», «не ведёт смету этой заявки»),
   *   а страж отвечал бы «Недостаточно прав для смены статуса». Совпади тексты — проверка
   *   доказывала бы ровно противоположное тому, ради чего написана.
   *
   * Сервисной компании не меняется ничего: `.status` и `.estimate` у неё были и остались, и страж
   * пускает её первым же членом выбора — это весь остальной файл.
   */
  /**
   * Кандидаты в поимённые исполнители (§7.1) — своя ручка модуля, а не список учёток.
   *
   * Ради чего она заведена: `GET /users` закрыт правом `users.manage`, которого нет ни у
   * «Ведения», ни у ИТ-службы, — то есть поле выбора заполнялось бы только у администратора
   * портала, а у того, кто заявки и распределяет, оставалось бы пустым. Здесь страж — то самое
   * право, которым назначают.
   */
  describe('кандидаты в исполнители', () => {
    it('отдаёт держателей права исполнения и не отдаёт всех подряд', async () => {
      const res = await inject(
        'GET',
        '/api/v1/service-requests/executor-candidates',
        ctx.operator.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const ids = (res.json().items as { id: string; fullName: string }[]).map((row) => row.id);

      // Обе учётки с набором «Оргтехника: ИТ-служба» — кандидаты: право `serviceRequests.execute`
      // отвечает на вопрос «кого можно назначить», а не «кто уже назначен».
      expect(ids).toContain(ctx.namedExecutor.id);
      expect(ids).toContain(ctx.strayExecutor.id);
      // Заказчик и подрядчик — нет: у первого права исполнения не бывает, второй назначается
      // компанией целиком и поимённо не выбирается вовсе (Н5).
      expect(ids).not.toContain(ctx.customer.id);
      expect(ids).not.toContain(ctx.service.id);
    });

    it('право читается эффективным: набор, несовместимый с ролью, кандидата не даёт', async () => {
      /*
       * Гейт совместимости набора с ролью (`grantPermissionsExpr`) — не украшение: учётка, у
       * которой роль сменили после выдачи набора, прав по нему больше не имеет. Попади она в
       * список — назначение прошло бы, а коридор отказал бы ей на первом же ходе, и человек
       * оказался бы «назначенным исполнителем», который ничего не может.
       */
      await ctx.db.execute(
        sql`UPDATE users SET role = 'observer' WHERE id = ${ctx.strayExecutor.id}::uuid`,
      );
      try {
        const res = await inject(
          'GET',
          '/api/v1/service-requests/executor-candidates',
          ctx.operator.auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        const ids = (res.json().items as { id: string }[]).map((row) => row.id);
        expect(ids).not.toContain(ctx.strayExecutor.id);
        expect(ids).toContain(ctx.namedExecutor.id);
      } finally {
        await ctx.db.execute(
          sql`UPDATE users SET role = 'shtab' WHERE id = ${ctx.strayExecutor.id}::uuid`,
        );
      }
    });

    it('заказчику список кандидатов закрыт: распределяет не он', async () => {
      const res = await inject(
        'GET',
        '/api/v1/service-requests/executor-candidates',
        ctx.customer.auth,
      );
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * Смешанное назначение «свой сотрудник + сервисная компания» — обычный случай постановки, и у
   * него своё правило отказа (§4.2 плана, Р7): «снять только отказавшегося» применимо к поимённым,
   * а у сервиса поимённых строк нет вовсе — отказ его оператора снимает **всю компанию**.
   *
   * **Статуса отказ не меняет ни при одном исходе** (Р7): прежде различие держал сам статус —
   * полный отказ уводил заявку из «Назначена» в «Новую», частичный оставлял в «Назначена». После
   * слияния (Р1) отказавшийся и так стоит в «Новой», и различает исходы состав исполнителей:
   * остался кто-то — заявка ждёт исполнителя, не осталось никого — распределяющего.
   *
   * Контрагента при этом снимает **сама ручка**, а не матрица сброса: дуги, на которой стоял
   * `reset.executor`, больше нет, и на `in_work → new` сброс не ставится намеренно (Р5, п. 2) —
   * иначе он ломал бы переназначение и откат «принял в работу».
   */
  describe('смешанное назначение: свой сотрудник и сервисная компания', () => {
    async function assignedToBoth(description: string): Promise<ServiceRequestDto> {
      const dto = await createRequest(ctx.customer.auth, await freshUnit(), description);
      const assigned = await inject(
        'PUT',
        `/api/v1/service-requests/${dto.id}/executors`,
        ctx.operator.auth,
        {
          userIds: [ctx.namedExecutor.id],
          serviceCounterpartyId: ctx.serviceCounterpartyId,
          version: dto.version,
        },
      );
      expect(assigned.statusCode, assigned.body).toBe(200);
      return card(dto.id);
    }

    it('отказ подрядчика снимает контрагента сам — заявка остаётся у своего, статус прежний', async () => {
      const both = await assignedToBoth('Смешанное назначение: отказывается подрядчик');
      expect(both.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
      expect(both.service?.id).toBe(ctx.serviceCounterpartyId);

      const declined = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.service.auth,
        { reason: 'нет свободных инженеров до конца месяца', version: both.version },
      );
      expect(declined.statusCode, declined.body).toBe(200);

      const after = await card(both.id);
      // Контрагента снял `patch` самой ручки: понадейся она на матрицу сброса, отказавшаяся
      // компания осталась бы в заявке молча — дуги, на которой стоял сброс, больше нет (Р5, п. 2).
      expect(after.service).toBeNull();
      // Свой сотрудник остался — и заявка вместе с ним по-прежнему ждёт исполнителя.
      expect(after.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
      expect(after.status).toBe('new');
      expect(after.waitingOn).toBe('service');
    });

    it('отказ своего снимает его строку, а компания продолжает вести заявку', async () => {
      const both = await assignedToBoth('Смешанное назначение: отказывается свой сисадмин');
      const declined = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.namedExecutor.auth,
        { reason: 'уезжаю в отпуск, передаю подрядчику', version: both.version },
      );
      expect(declined.statusCode, declined.body).toBe(200);

      const after = await card(both.id);
      expect(after.executors).toEqual([]);
      expect(after.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(after.status).toBe('new');
      expect(after.waitingOn).toBe('service');
    });

    /**
     * **От заявки, которую никому не отдали, отказываться нечего** — второй запрет, который держал
     * снятый статус (первый — третий замок предъявления на файле объёма работ).
     *
     * Прежде это держала сама дуга: отказ ходил `assigned → new`, и нераспределённая заявка стояла
     * в «Новой», то есть до ручки не доходила вовсе. После слияния (Р1) перечень стал `new`, и
     * нераспределённая проходит его наравне с назначенной; сторона её тоже не отбивает — держатель
     * `serviceRequests.estimate` (вне контрагента-сервиса это администратор) проходит
     * `actsAsServiceExecutor` ПО ПРАВУ, а не по назначению.
     *
     * **Проверяется след, а не только код.** Вреден дефект был не двухсоткой, а тем, что оставлял
     * после себя: возраст ожидания обнулялся — заявка молодела в очереди распределения, хотя её
     * никто не трогал, — а в ленту ложились переход `new → new` и событие «исполнителей стало
     * меньше» там, где их не было ни одного.
     */
    it('от нераспределённой «Новой» отказываться нечего — 422 и ни следа после', async () => {
      const dto = await createRequest(
        ctx.customer.auth,
        await freshUnit(),
        'Отказ по нераспределённой заявке',
      );
      expect(dto.status).toBe('new');
      expect(dto.service).toBeNull();
      expect(dto.executors).toEqual([]);

      const res = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/decline`,
        ctx.admin.auth,
        { reason: 'отказываюсь, хотя заявку никто не брал', version: dto.version },
      );
      // 422 у состояния заявки, а не 403 у стороны: дело не в субъекте — отказываться просто не от
      // чего. Текст обязан говорить про исполнителей, иначе администратор пошёл бы просить прав.
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('никому не отдали');
      expect(res.json().message).not.toContain('назначенного исполнителя');
      expect(res.json().fields?.status).toBe('Исполнителей нет');

      // 1. Возраст ожидания не сдвинулся: заявка стоит в очереди распределения ровно столько же.
      const after = await card(dto.id);
      expect(after.status).toBe('new');
      expect(after.statusChangedAt).toBe(dto.statusChangedAt);
      expect(after.version).toBe(dto.version);

      // 2. Лента чиста: ни перехода `from = to`, ни события отказа — только заведение.
      const history = await inject(
        'GET',
        `/api/v1/service-requests/${dto.id}/history`,
        ctx.admin.auth,
      );
      const events = history.json() as {
        kind: string;
        fromStatus: string | null;
        toStatus: string | null;
      }[];
      expect(events.map((e) => e.kind)).toEqual(['created']);
      expect(
        events.filter((e) => e.kind === 'status' && e.fromStatus === 'new' && e.toStatus === 'new'),
      ).toEqual([]);

      // 3. В аудите — ничего, кроме заведения: `writeAudit` ходит МИМО транзакции, и запись,
      //    сделанная до отказа, пережила бы его. Проверять поэтому надо саму таблицу, а не только
      //    ответ ручки; сверяется полный список действий, чтобы `decline` не спрятался за счётом.
      const audit = await ctx.db.execute<{ action: string }>(sql`
        SELECT action FROM audit_log
         WHERE entity_type = 'serviceRequest' AND entity_id = ${dto.id}
         ORDER BY action`);
      expect(audit.rows.map((r) => r.action)).toEqual(['serviceRequest.create']);
    });

    /**
     * **Коды не схлопнулись.** Новый 422 отвечает за состояние заявки, прежний 403 — за сторону, и
     * различить их можно только парой: та же ручка, тот же статус, разница ровно в составе
     * исполнителей. `strayExecutor` держит набор «Оргтехника: ИТ-служба» (то есть страж маршрута
     * его пускает) и не назначен ни на что — значит отказывает ему именно предикат стороны.
     */
    it('субъект без стороны по заявке С исполнителями получает 403, а не новый 422', async () => {
      const both = await assignedToBoth('Отказ посторонним держателем набора');
      const res = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.strayExecutor.auth,
        { reason: 'я тут ни при чём', version: both.version },
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().message).toContain('это шаг назначенного исполнителя');
      expect(res.json().message).not.toContain('никому не отдали');

      // Состав от чужой попытки не пострадал.
      const after = await card(both.id);
      expect(after.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(after.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
    });

    it('отказ последнего из двух оставляет заявку без исполнителей — ждать её начинает оператор', async () => {
      const both = await assignedToBoth('Смешанное назначение: отказываются оба');
      const first = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.service.auth,
        { reason: 'подрядчик отказался первым', version: both.version },
      );
      expect(first.statusCode, first.body).toBe(200);

      const middle = await card(both.id);
      const second = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.namedExecutor.auth,
        { reason: 'и свой следом', version: middle.version },
      );
      expect(second.statusCode, second.body).toBe(200);

      const after = await card(both.id);
      // Ни строк, ни контрагента — заявке некому её вести, и она уходит на распределение заново.
      // Статус при этом не менялся ни разу: и до, и после она «Новая» (Р7).
      expect(after.executors).toEqual([]);
      expect(after.service).toBeNull();
      expect(after.status).toBe('new');
      expect(after.waitingOn).toBe('operator');
    });

    /**
     * **Возраст ожидания обнуляется от смены того, кого ждут, а не от смены статуса** (Р4). Отказ
     * — единственная ручка, где флаг сброса условен: ушёл последний исполнитель — ждать начинает
     * распределяющий, и отсчёт идёт заново; кто-то остался — работу никому не передавали, и
     * оставшиеся ждут её ровно столько же, сколько ждали.
     *
     * Обнули мы возраст и при частичном отказе, уход одного из троих сисадминов прятал бы заявку
     * из очереди «кто тянет» на неделю. Статусом это правило больше не выражается вовсе — оба
     * исхода оставляют заявку «Новой», — поэтому проверять его надо здесь и явно.
     */
    it('частичный отказ возраст ожидания не обнуляет, а полный — обнуляет (Р4)', async () => {
      const both = await assignedToBoth('Возраст ожидания при частичном и полном отказе');
      const started = both.statusChangedAt;

      const partial = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.service.auth,
        { reason: 'подрядчик уходит, свой остаётся', version: both.version },
      );
      expect(partial.statusCode, partial.body).toBe(200);
      const afterPartial = await card(both.id);
      expect(afterPartial.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
      expect(afterPartial.statusChangedAt).toBe(started);

      const full = await inject(
        'PATCH',
        `/api/v1/service-requests/${both.id}/decline`,
        ctx.namedExecutor.auth,
        { reason: 'и свой следом', version: afterPartial.version },
      );
      expect(full.statusCode, full.body).toBe(200);
      const afterFull = await card(both.id);
      expect(afterFull.service).toBeNull();
      expect(afterFull.executors).toEqual([]);
      expect(new Date(afterFull.statusChangedAt).getTime()).toBeGreaterThan(
        new Date(started).getTime(),
      );
    });

    /**
     * **Переназначение из «В работе» возвращает заявку в «Новую» и СОХРАНЯЕТ назначенных** (Р5).
     * Ловушка здесь та, из-за которой правилось само решение: прежняя редакция плана вешала на эту
     * дугу сброс исполнителя, а сброс — это `DELETE ... WHERE request_id = …` по всей заявке, и
     * шёл бы он ПОСЛЕ вставки новых строк. Заявка оставалась бы ничьей молча: отложенный
     * `service_requests_executor_present` для эффективного статуса `new` возвращается сразу и
     * такого не ловит.
     */
    it('переназначение из «В работе» возвращает заявку в «Новую» и сохраняет новых исполнителей', async () => {
      const dto = await createRequest(
        ctx.customer.auth,
        await freshUnit(),
        'Переназначение из «В работе»',
      );
      await driveTo(dto.id, 'in_work');
      const inWork = await card(dto.id);
      expect(inWork.status).toBe('in_work');
      expect(inWork.service?.id).toBe(ctx.serviceCounterpartyId);

      const reassigned = await inject(
        'PUT',
        `/api/v1/service-requests/${dto.id}/executors`,
        ctx.operator.auth,
        {
          userIds: [ctx.namedExecutor.id],
          serviceCounterpartyId: null,
          reason: 'Забираем у подрядчика, чинит свой сисадмин',
          version: inWork.version,
        },
      );
      expect(reassigned.statusCode, reassigned.body).toBe(200);
      const after = (reassigned.json() as { request: ServiceRequestDto }).request;
      // Заявка вернулась в «Новую», чтобы новый исполнитель нажал «Принять в работу» сам, — иначе
      // он унаследовал бы чужое «взялся» и не нажал бы её никогда.
      expect(after.status).toBe('new');
      // И вернулась ВМЕСТЕ с только что назначенными: сброс на этой дуге не стоит намеренно.
      expect(after.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
      expect(after.service).toBeNull();
      expect(after.waitingOn).toBe('service');
      // Смету прежнего исполнителя стёрло правило `handedOver` — вместе с ней ушло и предъявление:
      // ревизия уходит в 0, и оставленная pending-ревизия уронила бы саму запись (`CHECK`).
      expect(after.estimateRevision).toBe(0);
      expect(after.estimatePendingRevision).toBeNull();
      expect(after.approval).toBeNull();
      expect(after.items).toEqual([]);
    });

    /**
     * **Откат «принял в работу» обязан вернуть заявку назначенным, не теряя их** (Р13, Р5 п. 2).
     * Прежде эта дуга звалась `in_work → assigned` и не сбрасывала ничего; после слияния она зовётся
     * `in_work → new`, и поставь мы на неё сброс — откат «взялся» превратился бы в откат «назначил»,
     * то есть в другое действие, которого в цикле больше нет.
     */
    it('откат «принял в работу» возвращает заявку назначенным, не теряя их', async () => {
      const dto = await createRequest(
        ctx.customer.auth,
        await freshUnit(),
        'Откат «принял в работу»',
      );
      await driveTo(dto.id, 'in_work');
      const inWork = await card(dto.id);

      const rolled = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/status`,
        ctx.admin.auth,
        {
          status: 'new',
          reason: 'Взялись по ошибке — вернуть исполнителю',
          version: await version(dto.id, ctx.admin.auth),
        },
      );
      expect(rolled.statusCode, rolled.body).toBe(200);
      const after = (rolled.json() as { request: ServiceRequestDto }).request;
      expect(after.status).toBe('new');
      expect(after.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(after.waitingOn).toBe('service');
      // Смета отката не касается: заявку вернули тому же исполнителю, и его работа никуда не делась.
      expect(after.estimateRevision).toBe(inWork.estimateRevision);
      expect(after.items).toHaveLength(inWork.items.length);

      // И «Принять в работу» ей снова доступно — тем же ходом `new → in_work`.
      const again = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/start`,
        ctx.service.auth,
        { version: after.version },
      );
      expect(again.statusCode, again.body).toBe(200);
      expect((again.json() as ServiceRequestDto).status).toBe('in_work');
    });
  });

  /**
   * Окно выката (§3 плана, п. 2). Между накатом миграции `0176` и перезапуском сервисов приёмку
   * пишет **старый** код: дата есть, источник пуст. Такая заявка живёт неделю — до выпуска 2, — и
   * всё это время API обязан отдавать её как принятую человеком, а не как ошибку.
   */
  describe('совместимость выпуска 1: приёмка без источника', () => {
    /**
     * Тест 10 плана в редакции выпуска 2. Прежде он проверял СОВМЕСТИМОСТЬ: заявку, принятую
     * старым кодом без источника, портал читал как принятую человеком. Выпуск 2 (`0198`) эту
     * совместимость снял и поставил на её место эквивалентность «принята ⟺ известно, кем закрыта»,
     * а backfill той же миграции проставил `human` всем, кого приняли в окне выката.
     *
     * Поэтому случай перевёрнут: проверяется не то, что портал терпит пустой источник, а то, что
     * база его больше не допускает. Прямой `UPDATE` — единственный способ сюда добраться: маршрут
     * такого состояния не производит.
     */
    it('принятая заявка без источника базой больше не принимается', async () => {
      const done = await requestIn('done', 'Окно выката: приёмка старым кодом');
      await attachClosingDocument(done.id);
      const accepted = await inject(
        'PATCH',
        `/api/v1/service-requests/${done.id}/accept`,
        ctx.operator.auth,
        { version: (await card(done.id)).version },
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await card(done.id)).acceptanceSource).toBe('human');

      // Ровно то, что оставил бы после себя старый код, — и ровно то, что теперь отбивает `CHECK`.
      await expect(
        ctx.db.execute(
          sql`UPDATE service_requests SET acceptance_source = NULL WHERE id = ${done.id}::uuid`,
        ),
      ).rejects.toThrow();

      const dto = await card(done.id);
      expect(dto.status).toBe('accepted');
      expect(dto.acceptanceSource).toBe('human');
      expect(dto.acceptedByName).toBeTruthy();
      expect(dto.acceptedAt).toBeTruthy();
    });
  });

  describe('поимённый исполнитель ведёт заявку набором «Оргтехника: ИТ-служба»', () => {
    /**
     * Заявка, назначенная **только** поимённо: контрагента у неё нет, платить по ней некому, и
     * закрывающего документа «Решена» не требует (Н8). Ровно случай «чинит свой сисадмин».
     */
    async function assignedToNamed(description: string): Promise<ServiceRequestDto> {
      const dto = await createRequest(ctx.customer.auth, await freshUnit(), description);
      const assigned = await inject(
        'PUT',
        `/api/v1/service-requests/${dto.id}/executors`,
        ctx.operator.auth,
        { userIds: [ctx.namedExecutor.id], serviceCounterpartyId: null, version: dto.version },
      );
      expect(assigned.statusCode, assigned.body).toBe(200);
      return card(dto.id);
    }

    /** Объём работ из одной строки: предмет проверки — кто его пишет, а не что в нём. */
    const ESTIMATE_ITEMS = [
      { kind: 'service', name: 'Чистка узла подачи', quantity: 1, unitPrice: 1000 },
    ];

    it('назначенный поимённо проходит «принять в работу», объём работ и закрытие работ', async () => {
      const assigned = await assignedToNamed('Поимённый исполнитель: чинит свой сисадмин');
      // Назначение статуса не меняет (Р5): заявка «Новая», а «Назначена» её называет состав.
      expect(assigned.status).toBe('new');
      expect(assigned.waitingOn).toBe('service');
      expect(assigned.executors.map((e) => e.userId)).toEqual([ctx.namedExecutor.id]);
      expect(assigned.service).toBeNull();

      const started = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/start`,
        ctx.namedExecutor.auth,
        { version: assigned.version },
      );
      expect(started.statusCode, started.body).toBe(200);
      expect((started.json() as ServiceRequestDto).status).toBe('in_work');

      const put = await inject(
        'PUT',
        `/api/v1/service-requests/${assigned.id}/estimate`,
        ctx.namedExecutor.auth,
        { items: ESTIMATE_ITEMS, version: (started.json() as ServiceRequestDto).version },
      );
      expect(put.statusCode, put.body).toBe(200);
      const submitted = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/estimate/submit`,
        ctx.namedExecutor.auth,
        { version: (put.json() as ServiceRequestDto).version },
      );
      expect(submitted.statusCode, submitted.body).toBe(200);
      // Предъявление статуса не меняет: заявка стоит в «В работе», а ход перешёл к согласующему.
      expect((submitted.json() as ServiceRequestDto).status).toBe('in_work');
      expect((submitted.json() as ServiceRequestDto).waitingOn).toBe('approval');

      // Подпись осталась одна (Р10): визы ИТ больше нет вовсе, а согласие по деньгам — чужая
      // сторона, и набором ИТ-службы она не открывается.
      const approved = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await version(assigned.id) },
      );
      expect(approved.statusCode, approved.body).toBe(200);

      // Примечание исполнителя — тоже его ручка, и стояла она под правом сметы.
      const commented = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/service-comment`,
        ctx.namedExecutor.auth,
        { serviceComment: 'ролик заменил, проверяю подачу', version: await version(assigned.id) },
      );
      expect(commented.statusCode, commented.body).toBe(200);

      const before = await card(assigned.id);
      const completed = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/complete`,
        ctx.namedExecutor.auth,
        {
          completedOn: TODAY,
          items: before.items.map((item) => ({ id: item.id, performed: true })),
          version: before.version,
        },
      );
      expect(completed.statusCode, completed.body).toBe(200);
      expect((completed.json() as ServiceRequestDto).status).toBe('done');
    });

    it('тот же набор без назначения не проходит ни один ход — и отказывает ему коридор, а не страж', async () => {
      /** Отказ обязан быть чужим для стража: его текст жёстко задан `requireAnyPermission`. */
      const GUARD_REFUSALS = [
        'Недостаточно прав для смены статуса',
        'Объём работ ведёт исполнитель',
      ];
      const refused = (res: { statusCode: number; body: string }, contains: string): void => {
        expect(res.statusCode, res.body).toBe(403);
        const message = (res.json() as { message: string }).message;
        expect(message).toContain(contains);
        for (const guard of GUARD_REFUSALS) expect(message).not.toContain(guard);
      };

      const assigned = await assignedToNamed('Поимённый исполнитель: посторонний держатель набора');
      expect(assigned.status).toBe('new');

      /*
       * «Принять в работу»: страж пускает по `execute`, а назначение спрашивается по строке заявки
       * — и не находится. Коридор теперь `new → in_work` (Р6), а не `assigned → in_work`.
       *
       * **Коды при этом не схлопнулись**, и это половина случая: у заявки С исполнителями отказ
       * приходит про СУБЪЕКТА (403 «не может перевести заявку»), а новый 422 «сначала распределяют»
       * отвечает про ЗАЯВКУ и только у нераспределённой. Слейся они, посторонний держатель набора
       * читал бы «заявку сначала распределяют» у распределённой заявки.
       */
      const strayStart = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/start`,
        ctx.strayExecutor.auth,
        { version: assigned.version },
      );
      refused(strayStart, 'не может перевести заявку');
      expect(strayStart.json().message).not.toContain('сначала распределяют');

      const started = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/start`,
        ctx.namedExecutor.auth,
        { version: assigned.version },
      );
      expect(started.statusCode, started.body).toBe(200);

      // Смета и примечание статуса не меняют, коридора у них нет — сторону спрашивает сам
      // обработчик (`assertExecutorSide`), и спрашивает он то же назначение.
      refused(
        await inject(
          'PUT',
          `/api/v1/service-requests/${assigned.id}/estimate`,
          ctx.strayExecutor.auth,
          { items: ESTIMATE_ITEMS, version: await version(assigned.id) },
        ),
        'не ведёт объём работ этой заявки',
      );
      refused(
        await inject(
          'PATCH',
          `/api/v1/service-requests/${assigned.id}/service-comment`,
          ctx.strayExecutor.auth,
          { serviceComment: 'я тут ни при чём', version: await version(assigned.id) },
        ),
        'не пишет примечание исполнителя',
      );

      // Доводим заявку до состояния, из которого закрывают работы, руками назначенного.
      const put = await inject(
        'PUT',
        `/api/v1/service-requests/${assigned.id}/estimate`,
        ctx.namedExecutor.auth,
        { items: ESTIMATE_ITEMS, version: await version(assigned.id) },
      );
      expect(put.statusCode, put.body).toBe(200);
      const submitted = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/estimate/submit`,
        ctx.namedExecutor.auth,
        { version: (put.json() as ServiceRequestDto).version },
      );
      expect(submitted.statusCode, submitted.body).toBe(200);
      const approved = await inject(
        'PATCH',
        `/api/v1/service-requests/${assigned.id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await version(assigned.id) },
      );
      expect(approved.statusCode, approved.body).toBe(200);

      // Возврат объёма работ в правку статуса не меняет — сторону и у него спрашивает обработчик.
      refused(
        await inject(
          'PATCH',
          `/api/v1/service-requests/${assigned.id}/estimate/reopen`,
          ctx.strayExecutor.auth,
          { reason: 'мне кажется, там ещё термоузел', version: await version(assigned.id) },
        ),
        'не возвращает объём работ в правку',
      );

      const before = await card(assigned.id);
      refused(
        await inject(
          'PATCH',
          `/api/v1/service-requests/${assigned.id}/complete`,
          ctx.strayExecutor.auth,
          {
            completedOn: TODAY,
            items: before.items.map((item) => ({ id: item.id, performed: true })),
            version: before.version,
          },
        ),
        'не может перевести заявку',
      );

      // Заявка осталась там же, где была: ни один чужой ход не прошёл.
      expect((await card(assigned.id)).status).toBe('in_work');
    });

    /**
     * Тест 8 плана: **правку факта выдачи спрашивают тем же вопросом, что и прочие ходы
     * исполнителя** — назначением по строке заявки, а не одним правом на маршруте.
     *
     * Случай нужен именно здесь, а не в `service-request-consumables.db`: там единственный актор —
     * администратор, у которого есть всё, и «кому отказано» на нём не показать. Здесь же готова
     * пара, которая различается ровно одним: `namedExecutor` назначен на заявку, `strayExecutor`
     * держит тот же набор «Оргтехника: ИТ-служба» и не назначен ни на что.
     */
    /**
     * Остаток теста 8 плана — две границы, которые до сих пор держались только кодом.
     *
     * Первая: **исполнителем назначают лишь того, кто им может быть.** Право проверяется у
     * НАЗНАЧАЕМОГО, а не у назначающего, и отказ обязан назвать имя: оператор выбирает из списка
     * живых учёток и по одному «нельзя» не поймёт, которая из трёх не годится.
     *
     * Второй половиной теста 8 — «ИТ-служба заявок не удаляет» — здесь не занимаются, и это не
     * упущение: правило держится СОСТАВОМ НАБОРА (`serviceRequests.delete` в него не входит), а не
     * отказом обработчика, и проверяется там же, где живёт состав, — контрактным случаем в
     * `permissions.test.ts` и сверкой каталога с базой в `grants-catalog.db.test.ts`. Попытка
     * проверить его здесь, живым удалением, доказывала бы обратное: у поимённого исполнителя роль
     * `shtab`, а штаб — заказчик модуля (ADR 0085) и свои заявки в «Новой» удаляет законно, своим
     * правом, а не набором.
     */
    it('исполнителем не назначить учётку без права исполнения — 422 с именем', async () => {
      // Своя единица: по каждой разрешена одна открытая заявка, и общий `ctx.mfp` к этому месту
      // сценария уже занят.
      const equipmentId = await makeEquipment({
        typeId: ctx.typeId,
        name: 'Kyocera ECOSYS M3145',
        inventoryNumber: `ОЕ-${RUN}-NOEXEC`,
        objectId: ctx.objectId,
      });
      const dto = await createRequest(ctx.customer.auth, equipmentId, 'Не печатает');
      const res = await inject(
        'PUT',
        `/api/v1/service-requests/${dto.id}/executors`,
        ctx.operator.auth,
        {
          // Заказчик — живая учётка своей площадки, и в справочнике он есть. Нет у него ровно
          // одного: `serviceRequests.execute`.
          userIds: [ctx.customer.id],
          serviceCounterpartyId: null,
          version: dto.version,
        },
      );
      expect(res.statusCode, res.body).toBe(422);
      const message = (res.json() as { message: string }).message;
      expect(message).toContain('не может быть исполнителем');
      // Имя в отказе — половина его смысла: без него оператор не узнает, которую строку убрать.
      // Берётся оно из базы, а не собирается в тесте: `full_name` — вычисляемая колонка, и её
      // правило (порядок частей, разделители) — предмет схемы, а не догадки этого файла.
      const имя = await ctx.db.execute<{ full_name: string }>(
        sql`SELECT full_name FROM users WHERE id = ${ctx.customer.id}::uuid`,
      );
      expect(message).toContain(имя.rows[0]!.full_name);

      // Заявка осталась нераспределённой: негодная строка не пропустила и годных.
      const after = await card(dto.id);
      expect(after.executors).toEqual([]);
      expect(after.status).toBe('new');
    });

    it('правку выдачи расходников держит назначение, а не право на маршруте', async () => {
      const consumable = await inject(
        'POST',
        '/api/v1/office-equipment-consumables',
        ctx.admin.auth,
        {
          code: `ДFLOW${RUN.toUpperCase()}1`,
          name: `Тонер прав ${RUN} (шт)`,
          quantity: 5,
          color: null,
          comment: '',
        },
      );
      expect(consumable.statusCode, consumable.body).toBe(201);
      const consumableId = (consumable.json() as { id: string }).id;

      const equipmentId = await makeEquipment({
        typeId: ctx.typeId,
        name: 'Kyocera ECOSYS M3145',
        inventoryNumber: `ОЕ-${RUN}-ISSUE`,
        objectId: ctx.objectId,
      });
      const request = await createRequest(ctx.customer.auth, equipmentId, 'Нужны картриджи', {
        kind: 'consumable',
        consumables: [{ consumableId, requestedQuantity: 2 }],
      });

      const assigned = await inject(
        'PUT',
        `/api/v1/service-requests/${request.id}/executors`,
        ctx.operator.auth,
        {
          userIds: [ctx.namedExecutor.id],
          serviceCounterpartyId: null,
          version: request.version,
        },
      );
      expect(assigned.statusCode, assigned.body).toBe(200);
      const started = await inject(
        'PATCH',
        `/api/v1/service-requests/${request.id}/start`,
        ctx.namedExecutor.auth,
        { version: (assigned.json() as { request: ServiceRequestDto }).request.version },
      );
      expect(started.statusCode, started.body).toBe(200);

      const lineId = (started.json() as ServiceRequestDto).consumables[0]!.id;
      const issue = (auth: Auth, version: number) =>
        inject('PATCH', `/api/v1/service-requests/${request.id}/consumables/issued`, auth, {
          items: [{ id: lineId, issuedQuantity: 2 }],
          version,
        });

      // Заказчик заявку завёл — и на этом его участие кончается: до обработчика он не доходит,
      // его отбивает страж маршрута, у роли `shtab` прав по заявкам нет вовсе.
      const byCustomer = await issue(ctx.customer.auth, await version(request.id));
      expect(byCustomer.statusCode, byCustomer.body).toBe(403);

      // А вот посторонний держатель набора страж маршрута ПРОХОДИТ (`execute` у него есть) и
      // упирается в назначение — то есть отказ приходит из обработчика, а не с порога.
      const byStray = await issue(ctx.strayExecutor.auth, await version(request.id));
      expect(byStray.statusCode, byStray.body).toBe(403);
      expect((byStray.json() as { message: string }).message).toContain('не отмечает выдачу');

      // Ни одна отбитая попытка склада не коснулась.
      const stock = await ctx.db.execute<{ quantity: number }>(
        sql`SELECT quantity FROM office_equipment_consumables WHERE id = ${consumableId}::uuid`,
      );
      expect(Number(stock.rows[0]!.quantity)).toBe(5);

      // Назначенный проходит — и списывает.
      const ok = await issue(ctx.namedExecutor.auth, await version(request.id));
      expect(ok.statusCode, ok.body).toBe(200);
      const after = await ctx.db.execute<{ quantity: number }>(
        sql`SELECT quantity FROM office_equipment_consumables WHERE id = ${consumableId}::uuid`,
      );
      expect(Number(after.rows[0]!.quantity)).toBe(3);
    }, 60_000);
  });
});
