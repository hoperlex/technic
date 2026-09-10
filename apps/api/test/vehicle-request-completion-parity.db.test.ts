import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ПАРИТЕТ ЗАКРЫТИЯ ЗАКАЗА ТЕХНИКИ: что дверь унесла со статусной ручки — этапы Э8 и Э14 плана
 * [vehicle-request-actual-end-date-plan.md](../../../docs/vehicle-request-actual-end-date-plan.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ И ЧТО С НИМ СТАЛО
 *
 * Написан он был **до** переноса (Э8) и характеризовал старую статусную ручку: закрытие заказа
 * техники делает помимо записи статуса пять вещей, список этих пяти не выводится ни из схемы, ни
 * из типов — он рассыпан по трём сотням строк маршрута, и потерять из него строку можно молча.
 * Тесты и были определением паритета; написанные после переноса, они описывали бы уже новое
 * поведение и не поймали бы ничего.
 *
 * Перенос состоялся (Э9), а этим этапом (Э14) закрылась и сама старая дорога: `PATCH /:id/status`
 * отвечает на «Выполнена» у заказа техники на объект отказом 422 и называет правильный вход.
 * Поэтому все случаи файла **переехали на дверь** — по смыслу, а не «чтобы позеленело»: сцена и
 * вопрос у каждого прежние, а закрывает их теперь `POST /:id/completion` с предпросмотром и
 * отпечатком, как это делает окно.
 *
 * Отсюда правило чтения: файл по-прежнему ничего не утверждает о том, как **правильно**. Он
 * утверждает, что дверь делает **всё то же самое** — теми же именами событий и в том же порядке.
 * Красный тест здесь — вопрос: паритет ли это, или потеря.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЧТО ЗАФИКСИРОВАНО — по строкам перечня Р24, по случаю на строку
 *
 * 1. Снятие заморозки режима (`is_linear_frozen`, `linear_frozen_at`) — **строго после** обеих
 *    сверок, бумажной и линейной. Порядок здесь не деталь: снятая раньше заморозка отдала бы обеим
 *    сверкам режим, в котором заявка не работала.
 * 2. Событие факта называется `vehicle_request.complete`, а не `.completion`. Имя проверяется
 *    поимённо, потому что имя события — это контракт: по нему история собирает вид записи, и
 *    переименование при переносе двери потеряло бы закрытие из карточки заявки, ничего не сломав.
 * 3. `shiftsPending` в событии закрытия — перечень неподписанных дней **внутри** факта, и
 *    подписанный день из него выпадает.
 * 4. Снятый закрытием ожидающий запрос на досрочное завершение пишет **своё** событие
 *    (`vehicle_request.early_end_cancel`), а не растворяется в событии перехода.
 * 5. Результат линейной сверки получает **отдельное** событие `vehicle_request.days_sync` с
 *    причиной `status:done`, а не строку внутри события статуса. Пишет его теперь каркас команды
 *    внутри транзакции (у ручки это делал `auditLinearDaysSync` после коммита) — имя, причина и
 *    состав те же, а нетранзакционного окна «работа сделана, события нет» не осталось.
 * 6. И отдельно — **заменённое** поведение линейных дней (Р27, решение заказчика В10). Оно здесь
 *    не ради паритета, а ровно наоборот: волна его намеренно отменила, и случай переписан на новое
 *    ожидание — отработанные дни остаются в рейсах, снимаются только дни за фактической датой.
 * 7. И **запрет старого пути** (Р1, Э14): статусная ручка «Выполнена» у заказа техники на объект
 *    отвечает 422, а грузоперевозку закрывает по-прежнему.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЧТО ЭТОТ ФАЙЛ НЕ ПРОВЕРЯЕТ
 *
 * Ни матрицы прав, ни границ тела, ни отпечатков: у них свои стражи, и дублировать их значило бы
 * платить временем каждого прогона за уже проверенное. Здесь только последствия закрывающего
 * перехода — то, что дверь Э9 обязана унести с собой.
 *
 * Режим чтения модуля периодов назначения (`read_mode`) остаётся умолчанием (`legacy`) — тем, в
 * котором ручка работает на проде. Равенство планов двух планировщиков сторожит теневое сравнение
 * (Э4 плана), и повторять его здесь нечем.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: половина утверждений здесь про **точные** числа
 * («листов у заказа ноль», «событие ровно одно», «в перечне ровно одна дата»), и чужая строка в
 * тех же таблицах сделала бы их ложными. База заводится с нуля, мигрируется и сносится в
 * `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/vehicle-request-completion-parity.db.test.ts --maxWorkers=1
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_e8_parity';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const ADMIN_EMAIL = 'db-e8-parity-admin@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Уникальный хвост прогона: коды справочников уникальны, а тип заводится на каждый случай свой. */
const RUN = Date.now().toString(36);

/** Контакт заказа: номер выдуман и своими цифрами ни на кого не похож. */
const SITE = { name: 'Паритетов Пётр Сергеевич', phone: '9007770801' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** Вид техники, которым заводятся свои типы: заказ техники на объект ведут спецтехникой. */
  kindId: string;
  /** Своя активная машина: на неё выписываются недельные листы и в её рейсы встают дни. */
  vehicleId: string;
  /** Машинист заказа: на него перевод в работу выписывает недельные листы ЭСМ-2 (ADR 0060). */
  driverId: string;
  /**
   * Грузовой тип, его категория и машина: ими закрывается единственный случай про грузоперевозку
   * (Р3). Категория обязательна там, где она у типа заведена, — и берётся у самой машины, чтобы
   * заказанное и назначенное сошлись.
   */
  freightTypeId: string;
  freightCategoryId: string | null;
  freightVehicleId: string;
  /** Адрес площадки: ездка называет его текстом рядом со ссылкой на объект. */
  objectAddress: string;
  today: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этих сценариях не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.RATE_LIMIT_MAX ??= '100000';
}

// ── Сцена ──

/** Заявка глазами этого файла: больше её DTO ни для чего здесь не нужен. */
interface RequestDto {
  id: string;
  version: number;
  status: string;
  dateFrom?: string;
  dateTo?: string | null;
}

async function login(): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/**
 * Свой тип ТС на каждый случай, а не один на файл: переключение линейности (случай 1) морозит
 * **все** работающие заказы своего типа, и общий тип связал бы случаи между собой.
 */
async function createType(isLinear: boolean, tag: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId: ctx.kindId,
      code: `e8_parity_${tag}_${RUN}`,
      // С «Яя» — требование соседства: половина db-тестов берёт тип из справочника выражением
      // `ORDER BY … LIMIT 1`, и запись, ставшая первой, увела бы их заявки на тестовый тип.
      name: `Яя тестовый тип паритета (${tag} ${RUN})`,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заказ техники на объект: срок с сегодняшнего дня — им же меряется «наступивший день» смен. */
async function createRequest(
  typeId: string,
  options: { dateTo?: string; comment?: string } = {},
): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.today,
      dateTo: options.dateTo ?? shiftDateKey(ctx.today, 5),
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: options.comment ?? 'ТЕСТ Э8: характеризующий прогон закрытия',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as RequestDto;
}

/** Виза руководителя строительства: без неё заявку в работу не берут (ADR 0025). */
async function approve(request: RequestDto): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

function changeStatus(
  request: RequestDto,
  payload: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: { version: request.version, ...payload },
  });
}

/** Заказ, доведённый до работы назначенной машиной и названным машинистом. */
async function inWork(typeId: string, options: { dateTo?: string } = {}): Promise<RequestDto> {
  const approved = await approve(await createRequest(typeId, options));
  const res = await changeStatus(approved, {
    status: 'confirmed',
    comment: '',
    assignment: {
      vehicleId: ctx.vehicleId,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      driverPersonId: ctx.driverId,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

/** Тело двери: факт целиком плюс фактическая дата — семантическая половина у обоих входов одна. */
function completionBody(request: RequestDto, endedOn: string): Record<string, unknown> {
  return {
    version: request.version,
    comment: '',
    completion: { workedUnit: 'shifts', workedAmount: 1, endedOn },
  };
}

/**
 * Закрытие заказа фактической датой — тот самый переход, поведение которого фиксирует весь файл.
 *
 * Идёт **дверью** (`POST /:id/completion`), а не статусной ручкой: с этапа Э14 ручка на «Выполнена»
 * у заказа техники отвечает 422. Порядок здесь тот же, каким его делает окно, и другого быть не
 * может: отпечаток предпросмотра дверь спрашивает всегда (Р17), и «закрыть без просмотра» — это не
 * упрощение сцены, а тело, которое сервер отвергнет 409.
 *
 * Умолчание даты — сегодняшний день: сцены файла заводят заказ с сегодняшнего дня и закрывают его
 * тем же днём, ровно как это делала статусная ручка, у которой фактической даты не было вовсе.
 */
async function close(request: RequestDto, endedOn?: string): ReturnType<typeof ctx.app.inject> {
  const body = completionBody(request, endedOn ?? ctx.today);
  const shown = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/completion/preview`,
    headers: ctx.auth,
    payload: body,
  });
  expect(shown.statusCode, shown.body).toBe(200);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/completion`,
    headers: ctx.auth,
    payload: { ...body, previewFingerprint: shown.json().fingerprint },
  });
}

/**
 * Заказ на **грузоперевозку**, доведённый до работы: у него нет ни срока работ, ни недельной
 * бумаги, и закрывается он статусной ручкой — той самой, которую заказу техники закрыли (Р3).
 *
 * Сцена дороже соседних на три строки справочника (свой вид техники, свой тип, своя машина), и
 * иначе нельзя: заявку на перевозку выполняет только грузовая техника (`vehicleKindMatchesRequest`),
 * а весь остальной файл живёт на спецтехнике.
 */
async function freightInWork(): Promise<RequestDto> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.freightTypeId,
      ...(ctx.freightCategoryId ? { vehicleCategoryId: ctx.freightCategoryId } : {}),
      scheduledAt: `${ctx.today}T10:00:00+03:00`,
      trips: [
        {
          fromLocation: ctx.objectAddress,
          toLocation: ctx.objectAddress,
          fromAddress: { source: 'object', refId: ctx.objectId },
          toAddress: { source: 'object', refId: ctx.objectId },
          volumeM3: 12,
          fromResponsibleName: SITE.name,
          fromResponsiblePhone: SITE.phone,
          toResponsibleName: SITE.name,
          toResponsiblePhone: SITE.phone,
        },
      ],
      comment: 'ТЕСТ Э14: грузоперевозка закрывается прежним путём',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const approved = await approve(created.json() as RequestDto);
  const res = await changeStatus(approved, {
    status: 'confirmed',
    comment: '',
    assignment: {
      vehicleId: ctx.freightVehicleId,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      // Грузоперевозка планируется рейсом, а не сроком: без маршрута её в работу не берут вовсе.
      route: { newRoute: { driverPersonId: ctx.driverId } },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

// ── Чтение последствий ──

/** Заявка, перечитанная после чужой команды: у неё другая версия, а тело команды носит именно её. */
async function reload(requestId: string): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

/** Статус заявки прямо из строки: ответ ручки о нём тут не спрашивают — спрашивают базу. */
async function statusOf(requestId: string): Promise<string> {
  const rows = await ctx.db.execute<{ status: string }>(
    sql`SELECT status FROM vehicle_requests WHERE id = ${requestId}`,
  );
  return rows.rows[0]!.status;
}

/** События заявки одного вида: их и сверяет весь файл — закрытие живёт в журнале, а не в ответе. */
async function auditOf(
  requestId: string,
  action: string,
): Promise<{ metadata: Record<string, unknown> }[]> {
  const rows = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId} AND action = ${action}
     ORDER BY created_at`);
  return rows.rows.map((row) => ({ metadata: row.metadata }));
}

/** Все виды событий заявки: ими проверяется, что события не подменили друг друга. */
async function auditActions(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ action: string }>(sql`
    SELECT action FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}
     ORDER BY created_at`);
  return rows.rows.map((row) => row.action);
}

/**
 * Метаданные закрывающего перехода среди событий статуса заявки: их у прошедшей полный путь заявки
 * два — перевод в работу и закрытие, — и «первое попавшееся» отвечало бы про чужой переход.
 */
function closingStatusEvent(
  events: { metadata: Record<string, unknown> }[],
): Record<string, unknown> {
  const closing = events.filter((e) => e.metadata.to === 'done');
  expect(closing).toHaveLength(1);
  return closing[0]!.metadata;
}

/** Изменения события закрытия — по ним и читается `shiftsPending`. */
function changesOf(metadata: Record<string, unknown>): { field: string; to: string | null }[] {
  return (metadata.changes ?? []) as { field: string; to: string | null }[];
}

/** Снимок режима у заявки: `null` — заморозки нет, и заявка читает справочник живым. */
async function frozenOf(
  requestId: string,
): Promise<{ isLinear: boolean | null; at: string | null }> {
  const rows = await ctx.db.execute<{
    is_linear_frozen: boolean | null;
    linear_frozen_at: string | null;
  }>(sql`SELECT is_linear_frozen, linear_frozen_at FROM vehicle_requests WHERE id = ${requestId}`);
  const row = rows.rows[0]!;
  return { isLinear: row.is_linear_frozen, at: row.linear_frozen_at };
}

/** Сколько действующих листов ЭСМ-2 у заказа: им и меряется, каким режимом посчитана бумага. */
async function esm2Count(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM waybills
     WHERE source_request_id = ${requestId} AND form_code = 'esm2' AND status <> 'cancelled'`);
  return Number(rows.rows[0]!.n);
}

/** Дни заказа, стоящие в рейсах, — прямо из состава рейсов, а не из ответа ручки. */
async function daysInRoutes(requestId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ work_date: string }>(sql`
    SELECT work_date FROM vehicle_route_requests
     WHERE request_id = ${requestId} AND work_date IS NOT NULL
     ORDER BY work_date`);
  return rows.rows.map((row) => row.work_date);
}

/** Ожидающий визы запрос на досрочное завершение — есть ли он у заказа сейчас. */
async function pendingEarlyEnds(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM vehicle_request_early_endings
     WHERE request_id = ${requestId} AND status = 'pending'`);
  return Number(rows.rows[0]!.n);
}

/** «24.07.2026» — так перечень дат печатает сама ручка (`listDates`). */
function dateRu(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

// ── Действия сцены ──

/** Переключение линейности типа: с предпросмотром и его отпечатком, как это делает человек. */
async function switchLinear(typeId: string, isLinear: boolean): Promise<void> {
  const shown = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-types/${typeId}/linear-switch-preview?isLinear=${isLinear}`,
    headers: ctx.auth,
  });
  expect(shown.statusCode, shown.body).toBe(200);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-types/${typeId}/linear`,
    headers: ctx.auth,
    payload: { isLinear, fingerprint: shown.json().fingerprint },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Поставить день линейного заказа в свежий рейс своей машины. */
async function planDay(requestId: string, date: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: { newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Заполнить смену дня и подписать её объектом: подписанный день выпадает из `shiftsPending`. */
async function approveShift(request: RequestDto, date: string): Promise<void> {
  const filled = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/vehicle-requests/${request.id}/shifts/${date}`,
    headers: ctx.auth,
    payload: {
      startedAt: '08:00',
      endedAt: '17:00',
      machineHours: 8,
      refuel: '',
      comment: '',
    },
  });
  expect(filled.statusCode, filled.body).toBe(200);
  const signed = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/shifts/${date}/approval`,
    headers: ctx.auth,
    payload: { approved: true },
  });
  expect(signed.statusCode, signed.body).toBe(200);
}

/** Попросить досрочное завершение и оставить запрос ждать визы. */
async function askEarlyEnd(request: RequestDto, newDateTo: string): Promise<RequestDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/early-end`,
    headers: ctx.auth,
    payload: { newDateTo, reason: 'ТЕСТ Э8: работы кончились раньше', version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as RequestDto;
}

describe.skipIf(!DB_URL)('паритет закрытия заказа техники: дверь и старая ручка (Э8, Э14)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска), — их
     * ставим до журнала миграций, а не надеемся на образ. Справочники (площадки, парк, серии
     * бланков) приезжают теми же миграциями: сцене есть на чём стоять сразу.
     */
    const adminClient = new pg.Client({ connectionString: ADMIN_DB });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await adminClient.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await adminClient.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    await db.insert(schema.users).values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    });

    /*
     * Машинист заводится свой: людей миграции не наполняют вовсе, а назначение спрашивает ровно
     * «человек есть и он водитель» (ADR 0064) — удостоверения этой сцене не нужны.
     */
    const [specialization] = await db
      .select({ id: schema.specializations.id })
      .from(schema.specializations)
      .where(sql`${schema.specializations.code} = 'driver'`);
    if (!specialization) throw new Error('в справочнике нет специализации «водитель»');
    const [person] = await db
      .insert(schema.persons)
      .values({
        lastName: 'Паритетов',
        firstName: 'Тест',
        middleName: 'Машинистович',
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: паритет закрытия заказа техники',
      })
      .returning({ id: schema.persons.id });
    await db.insert(schema.personSpecializations).values({
      personId: person!.id,
      specializationId: specialization.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });

    // Площадка и парк — из справочника: их наполняют миграции. Машина обязана быть своей и
    // активной: на арендную ни лист ЭСМ-2 не выписывают, ни рейс не ведут.
    const objects = await db.execute<{ id: string; address: string }>(
      sql`SELECT id, address FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vk.code = 'special_equipment'
       ORDER BY v.registration_number
       LIMIT 1`);
    const object = objects.rows[0];
    const vehicle = vehicles.rows[0];
    if (!object || !vehicle) {
      throw new Error('в базе нет площадки или своей спецтехники: миграции не применены');
    }

    /*
     * Грузовая машина и её тип — для единственного случая про грузоперевозку (Р3). Берётся так же,
     * как спецтехника: из справочника, заполненного миграциями. Тип здесь **справочный**, а не свой,
     * в отличие от типов спецтехники: заявку на перевозку выполняет ровно та техника, тип которой в
     * ней заказан, и заведи мы под неё пустой тип — назначать было бы нечего. Линейность этого типа
     * никто не переключает, поэтому связать случаи между собой он не может.
     */
    const freight = await db.execute<{
      id: string;
      type_id: string;
      category_id: string | null;
    }>(sql`
      SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vk.code = 'freight_transport'
         -- С категорией: у типа с характеристиками заявка обязана назвать категорию (ADR 0028), а
         -- взять её неоткуда, кроме как у самой машины, — иначе заказанное и назначенное разойдутся.
         AND v.vehicle_category_id IS NOT NULL
       ORDER BY v.registration_number
       LIMIT 1`);
    const freightVehicle = freight.rows[0];
    if (!freightVehicle)
      throw new Error('в базе нет своей грузовой техники: миграции не применены');

    const app = await buildApp();
    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: '' },
      objectId: object.id,
      kindId: vehicle.kind_id,
      vehicleId: vehicle.id,
      driverId: person!.id,
      freightTypeId: freightVehicle.type_id,
      freightCategoryId: freightVehicle.category_id,
      freightVehicleId: freightVehicle.id,
      objectAddress: object.address,
      today: moscowDateKeyOf(new Date()),
    };
    ctx.auth = await login();
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком, а не выковыриваем фикстуры: чужих строк в ней нет по
    // построению, а оставленная база помешала бы следующему прогону завести её заново.
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── Р24, строка 1: заморозка режима снимается последней ──

  it('заморозка режима снимается ПОСЛЕ обеих сверок: бумагу считает режим, в котором работали', async () => {
    /*
     * Сцена подобрана так, чтобы порядок был **виден**, а не подразумевался.
     *
     * Заказ заводится линейным типом: линейному листы ЭСМ-2 портал сам не выписывает (ADR 0100
     * §5, режим `on_demand`), и бумаги у него нет. Потом справочник переключают на недельный —
     * заявка застигнута в работе и морозится **прежним** значением (миграция 0137). С этой минуты
     * ответы «по снимку» и «по справочнику» расходятся: снимок говорит «линейный, бумаги нет»,
     * справочник — «недельный, выпиши листы на весь срок».
     *
     * Закрытие обязано посчитать бумагу снимком. Сними ручка заморозку раньше сверки — сверка
     * пошла бы по справочнику и выписала бы закрываемому заказу недельные листы, которых он
     * никогда не имел.
     *
     * ЧЕСТНАЯ ОГОВОРКА ПРО «ОБЕИХ»: наблюдаема сегодня только позиция относительно **бумажной**
     * сверки. Линейная к моменту закрытия обрекает все дни в любом случае — заявка уже в
     * «Выполненной», и общий запрет отвечает отказом что по снимку, что по справочнику (см.
     * последний случай файла). То есть перестановка заморозки перед сверкой дней сегодня ничего
     * не меняет и тестом не ловится; ловится перестановка перед сверкой бумаги — та самая, из-за
     * которой крайняя неделя не выписалась бы вовсе.
     */
    const typeId = await createType(true, 'freeze');
    const request = await inWork(typeId);
    expect(await esm2Count(request.id)).toBe(0);

    await switchLinear(typeId, false);
    const frozen = await frozenOf(request.id);
    expect(frozen.isLinear).toBe(true);
    expect(frozen.at).not.toBeNull();

    /*
     * Контроль: тот же срок, тот же тип — но уже без снимка. Он выписывает бумагу, и значит
     * «ноль листов» ниже говорит именно о режиме, а не о том, что этому сроку листов не положено
     * вовсе. Без контроля случай прошёл бы и на сломанном порядке.
     */
    const control = await inWork(typeId);
    expect(await frozenOf(control.id)).toEqual({ isLinear: null, at: null });
    expect(await esm2Count(control.id)).toBeGreaterThan(0);

    const closed = await close(request);
    expect(closed.statusCode, closed.body).toBe(200);

    // Бумага посчитана снимком: недельных листов у линейно отработавшего заказа не появилось.
    expect(await esm2Count(request.id)).toBe(0);
    // А сам снимок снят — тем же переходом, но после сверок: заявка возвращена справочнику.
    expect(await frozenOf(request.id)).toEqual({ isLinear: null, at: null });
  }, 120_000);

  // ── Р24, строка 2: имя события факта ──

  it('событие факта называется vehicle_request.complete — не .completion', async () => {
    const request = await inWork(await createType(false, 'name'));
    const closed = await close(request);
    expect(closed.statusCode, closed.body).toBe(200);

    /*
     * Имя проверяется поимённо и в обе стороны. Оно контракт: по нему история заявки собирает вид
     * записи (`AUDIT_KINDS` в `vehicle-request-history.ts`), и переименованное при переносе двери
     * событие исчезло бы из карточки, не сломав ни одного типа.
     */
    const actions = await auditActions(request.id);
    expect(actions).toContain('vehicle_request.complete');
    expect(actions).not.toContain('vehicle_request.completion');
    expect(actions.filter((a) => a === 'vehicle_request.complete')).toHaveLength(1);

    // И то же самое с другого конца — глазами карточки заявки: закрытие видно отдельной записью.
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/history`,
      headers: ctx.auth,
    });
    expect(history.statusCode, history.body).toBe(200);
    const kinds = (history.json() as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toContain('completed');
  }, 120_000);

  // ── Р24, строка 3: shiftsPending — неподписанные дни внутри факта ──

  it('shiftsPending — неподписанные дни внутри факта, и подписанный день из перечня выпадает', async () => {
    const typeId = await createType(false, 'shifts');

    /*
     * Заказ заведён с сегодняшнего дня на неделю вперёд и закрывается сегодня же. Наступивший
     * день ровно один — сегодняшний, — и он же единственный, за который никто не расписался.
     *
     * ЧТО ЗДЕСЬ ЗАФИКСИРОВАНО ТОЧНО. Статусная ручка считала перечень по **сроку заявки,
     * обрезанному сегодняшним днём**: фактического периода у неё не было вовсе. Дверь считает то же
     * множество по **факту** (Р24), и в этой сцене ответы совпадают — закрытие фактической датой
     * «сегодня» и есть закрытие сегодняшним днём. Разойдутся они при закрытии задним числом: у
     * двери дни между фактом и сегодняшним днём в долг подписей не попадут, потому что этих дней у
     * заказа больше нет. Это ожидаемая разница, а не потеря, и она — часть решения Р10.
     */
    const pending = await inWork(typeId);
    const closedPending = await close(pending);
    expect(closedPending.statusCode, closedPending.body).toBe(200);

    const [complete] = await auditOf(pending.id, 'vehicle_request.complete');
    expect(complete).toBeDefined();
    const shiftsPending = changesOf(complete!.metadata).filter((c) => c.field === 'shiftsPending');
    expect(shiftsPending).toHaveLength(1);
    // Ровно один день — сегодняшний. Будущие дни срока в перечень не попадают: за них ещё не
    // работали, и «не расписались» про них сказать нечего.
    expect(shiftsPending[0]!.to).toBe(dateRu(ctx.today));

    /*
     * Парный случай: тот же срок, но за сегодняшний день объект расписался. Перечень исчезает
     * целиком — значит поле означает именно «неподписанные», а не «все наступившие».
     */
    const signed = await inWork(typeId);
    await approveShift(signed, ctx.today);
    const fresh = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${signed.id}`,
      headers: ctx.auth,
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const closedSigned = await close(fresh.json() as RequestDto);
    expect(closedSigned.statusCode, closedSigned.body).toBe(200);

    const [completeSigned] = await auditOf(signed.id, 'vehicle_request.complete');
    expect(completeSigned).toBeDefined();
    expect(changesOf(completeSigned!.metadata).map((c) => c.field)).not.toContain('shiftsPending');
  }, 120_000);

  // ── Р24, строка 4: снятый запрос на досрочное завершение — своё событие ──

  it('снятый закрытием запрос на досрочное завершение пишет своё событие', async () => {
    const request = await inWork(await createType(false, 'earlyend'));
    const asked = await askEarlyEnd(request, shiftDateKey(ctx.today, 2));
    expect(await pendingEarlyEnds(request.id)).toBe(1);

    const closed = await close(asked);
    expect(closed.statusCode, closed.body).toBe(200);

    // Строка снята: «ждёт визы» на закрытой заявке висело бы вечно и считалось бы в сводке среза.
    expect(await pendingEarlyEnds(request.id)).toBe(0);
    // И снята не молча: у неё своё событие со своей причиной — иначе по истории было бы не
    // понять, чем кончился запрос.
    const cancelled = await auditOf(request.id, 'vehicle_request.early_end_cancel');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.metadata.reason).toBe('closed');
    expect(changesOf(cancelled[0]!.metadata).map((c) => c.field)).toContain('earlyEndReason');
  }, 120_000);

  // ── Р24, строка 5: линейная сверка — отдельный аудит ──

  it('результат линейной сверки уходит своим событием days_sync, а не строкой события статуса', async () => {
    const typeId = await createType(true, 'daysaudit');
    const request = await inWork(typeId);
    const day = shiftDateKey(ctx.today, 2);
    await planDay(request.id, day);
    expect(await daysInRoutes(request.id)).toEqual([day]);

    const closed = await close(request);
    expect(closed.statusCode, closed.body).toBe(200);

    /*
     * Своё событие — с причиной вида `status:<статус>` и перечнем снятых дней. Оно отдельное не
     * ради красоты: событие перехода отвечает «что стало с заявкой», а это — «что стало с
     * рейсами», и в одной записи два ответа не читаются.
     */
    const sync = await auditOf(request.id, 'vehicle_request.days_sync');
    expect(sync).toHaveLength(1);
    expect(sync[0]!.metadata.reason).toBe('status:done');
    expect(sync[0]!.metadata.detached).toHaveLength(1);
    expect(String((sync[0]!.metadata.detached as string[])[0])).toContain(day);
    expect(sync[0]!.metadata.frozen).toEqual([]);

    // А событие статуса про дни молчит: `detachedDays` в нём появляется только от `detachOnStatus`,
    // который на закрытии не снимает ничего (см. следующий случай).
    const status = closingStatusEvent(await auditOf(request.id, 'vehicle_request.status'));
    expect(status.to).toBe('done');
    expect(status).not.toHaveProperty('detachedDays');
  }, 120_000);

  // ── Р27: ЗАМЕНЁННОЕ ПОВЕДЕНИЕ ЛИНЕЙНЫХ ДНЕЙ ──

  it('ЗАМЕНЕНО (Р27): отработанные дни линейного заказа остаются в рейсах, снимаются только дни за фактом', async () => {
    /*
     * ЭТОТ СЛУЧАЙ ФИКСИРУЕТ ПОВЕДЕНИЕ, КОТОРОЕ ВОЛНА ОТМЕНИЛА, — и потому он единственный в файле,
     * который переписан не только на новую дверь, но и на **другое ожидание**. До Э8 он проверял
     * ровно обратное, и подпись под ним требовала: покраснеет — не «чинить», а переписывать
     * осознанно. Ровно это здесь и сделано.
     *
     * КАК БЫЛО, тремя шагами, и каждый по отдельности выглядел безобидно:
     *
     * 1. `detachOnStatus` на переходе в «Выполнена» не отцеплял **ничего**: `shouldDetachOnStatus`
     *    отвечает `true` только на «Отменена» и «Новая»;
     * 2. но статус писался **до** сверки дней, и сверка читала заявку из базы — уже закрытой;
     * 3. а общий запрет `linearDaysBlocker` у заявки не в работе отвечает отказом, и он сильнее
     *    подённой границы: обречёнными оказывались **все** дни линейного заказа, включая те, что
     *    заказ отработал. Незамороженные снимались с рейсов.
     *
     * КАК СТАЛО (Р27, решение заказчика по В10): дверь считает план **до** смены статуса, по
     * укороченному сроку и с явной политикой `retainCompletedDays`. Дни **внутри** факта остаются в
     * рейсах: рейс отработанного дня — след состоявшейся работы, и «чей это был выезд» обязано
     * читаться после закрытия; у обычного заказа это уже так, а линейный подметался не по решению,
     * а побочным эффектом статусного блокировщика. Снимаются ровно дни **за** границей факта: их у
     * заказа больше нет.
     *
     * ЦЕНА, ЗАПИСАННАЯ ВСЛУХ: у заказов, закрытых **до** выката, дни уже сняты, и задним числом их
     * никто не возвращает. История по обе стороны выката разная — это намеренное расхождение, а не
     * регресс.
     */
    const typeId = await createType(true, 'sweep');
    const request = await inWork(typeId);
    // День внутри факта — сегодняшний: заказ его отработал, и закрытие сегодня его не отнимает.
    const worked = ctx.today;
    // День за границей факта — послезавтрашний: его у закрытого заказа действительно больше нет.
    const future = shiftDateKey(ctx.today, 2);
    await planDay(request.id, worked);
    await planDay(request.id, future);
    expect(await daysInRoutes(request.id)).toEqual([worked, future]);

    const routes = await ctx.db.execute<{ id: string }>(sql`
      SELECT DISTINCT route_id AS id FROM vehicle_route_requests WHERE request_id = ${request.id}`);
    expect(routes.rows).toHaveLength(2);

    const closed = await close(request);
    expect(closed.statusCode, closed.body).toBe(200);

    // Отработанный день остался при заказе, будущий снят. Это и есть отменённое поведение: прежде
    // список был пуст целиком.
    expect(await daysInRoutes(request.id)).toEqual([worked]);
    const sync = await auditOf(request.id, 'vehicle_request.days_sync');
    expect(sync).toHaveLength(1);
    expect(sync[0]!.metadata.detached).toHaveLength(1);
    expect(String((sync[0]!.metadata.detached as string[])[0])).toContain(future);

    // Рейсы при этом живы оба: исчезла именно связь заказа с **будущим** рейсом — то есть ответ на
    // вопрос «чья это была работа» там, где работы уже не будет.
    const alive = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM vehicle_routes
       WHERE id = ANY(${sql.param(routes.rows.map((r) => r.id))}::uuid[])`);
    expect(Number(alive.rows[0]!.n)).toBe(2);

    // И сняла день не отцепка статуса: она на «Выполнена» молчит, как и должна.
    expect(
      closingStatusEvent(await auditOf(request.id, 'vehicle_request.status')),
    ).not.toHaveProperty('detachedDays');

    // Со стороны карточки заказа: план дней у закрытой заявки не ведётся — общий запрет отвечает
    // тем же, чем отвечал. Разница в том, что рейс отработанного дня заказ за собой сохранил.
    const days = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/days`,
      headers: ctx.auth,
    });
    expect(days.statusCode, days.body).toBe(200);
    const plan = days.json() as { blocker: string | null };
    expect(plan.blocker).toContain('дни планируют у заявки в работе');
  }, 120_000);

  // ── Р1, Э14: старый путь закрыт ──

  it('статусная ручка «Выполнена» у заказа техники отвечает 422 и называет окно закрытия', async () => {
    /*
     * ЗАЧЕМ ЭТОТ СЛУЧАЙ ЗДЕСЬ. Весь файл — про то, что дверь унесла со статусной ручки; этот — про
     * то, что у ручки не осталось. Пока обе двери принимали `done`, рядом с новой оставалась дорога
     * мимо фактической даты, и ходили бы по ней ровно те, у кого окно осталось прежним. Отказ
     * выкатывается парой с порталом (Р1) и потому проверяется вместе с паритетом.
     */
    const request = await inWork(await createType(false, 'ban'));
    const refused = await changeStatus(request, {
      status: 'done',
      comment: '',
      completion: { workedUnit: 'shifts', workedAmount: 1 },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    // Отказ называет вход, а не поле: человек читает его в окне и должен понять, куда идти.
    expect(refused.json().message).toContain('окном закрытия');
    // И это именно отказ, а не тихое бездействие: заявка осталась в работе.
    expect(await statusOf(request.id)).toBe('confirmed');

    // А дверь ту же заявку закрывает — второй путь не отобран, он **заменён**.
    const closed = await close(await reload(request.id));
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await statusOf(request.id)).toBe('done');
  }, 120_000);

  it('грузоперевозка закрывается прежним путём: фактическая дата ей ничего не значит', async () => {
    /*
     * Запрет сужен ровно до заказа техники на объект (Р3). У грузоперевозки нет ни срока работ, ни
     * недельной бумаги — «фактическая дата окончания» у неё не существует как понятие, — и новая
     * дверь её не принимает вовсе. Запрети мы `done` и ей, закрывать её стало бы нечем.
     */
    const request = await freightInWork();
    const closed = await changeStatus(request, {
      status: 'done',
      comment: '',
      completion: { workedUnit: 'hours', workedAmount: 4 },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await statusOf(request.id)).toBe('done');
  }, 120_000);
});
