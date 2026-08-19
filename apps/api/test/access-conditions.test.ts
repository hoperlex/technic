import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ROLE_PERMISSIONS, type Permission, type Role } from '@technic/contracts';
import {
  ACCESS_MANIFEST,
  allPermissionsOf,
  type AccessCondition,
  type ManifestRouteKey,
} from '../src/lib/access-manifest';

/**
 * Перебор доступа **по условию манифеста**, а не по перечню профилей (план §14).
 *
 * Чем это отличается от `access-matrix.test.ts`. Тот перебирает поставочные профили
 * (`ACCESS_PROFILES`) по таблице кейсов, написанной руками: он отвечает на вопрос «этой должности
 * маршрут открыт или закрыт». Вопрос правильный, но неполный сразу с двух сторон. Во-первых,
 * профилей больше, чем поставочных: схема допускает обе надстройки сразу, а после реформы —
 * произвольный набор прав, и «перебрать все субъекты» перестанет быть выполнимым в принципе.
 * Во-вторых, роль отвечает за все свои права разом: маршрут, закрытый **конъюнкцией**
 * (`waybills.read` + `vehicleRequests.status` + `waybills.correct` у коррекции задним числом),
 * профилем проверяется как одно целое — привяжи к нему на одно право меньше, и все перечни
 * сойдутся по-прежнему.
 *
 * Здесь субъект синтетический: роль, не дающая ни одного проверяемого права, плюс ровно те права,
 * которые нужны сценарию. Тогда на каждый маршрут приходится три вида случаев:
 *
 * 1. **минимальный разрешающий набор** — все обязательные права и ничего сверх: ожидается не 403 и
 *    не 401 (что вернёт обработчик — не наше дело: БД подменена, и дальше стража всё равно 500);
 * 2. **минус каждое право по очереди** — ожидается 403. Их столько, сколько прав в условии, и
 *    именно они доказывают, что каждое право обязательно, а не приписано рядом;
 * 3. **пустой набор** — 403.
 *
 * Ожидание берётся из манифеста (`src/lib/access-manifest.ts`), который пишут и ревьюят руками, а
 * не из пометки `guard.authz`: перебор по пометке проверял бы код его же собственным утверждением
 * (см. преамбулу манифеста). Совпадение пометки с манифестом — дело `access-manifest.test.ts`;
 * здесь проверяется, что объявленное условие **работает**: настоящими HTTP-запросами к собранному
 * приложению.
 *
 * Чего перебор не проверяет: область видимости («над какими строками») и правила внутри
 * обработчиков. Он останавливается на границе доступа — «пустил страж или нет», — и ровно поэтому
 * ему довольно подменённой БД.
 *
 * Что остаётся за `access-matrix.test.ts` и почему он не удаляется. Перебор доказывает, что
 * **объявленное** условие работает; правильно ли оно объявлено, он не знает вовсе — маршрут,
 * закрытый `directories.read` вместо `drivers.read`, пройдёт здесь безупречно. На вопрос «то ли это
 * право» отвечают две независимые записи ожидания: манифест, написанный правами, и матрица,
 * написанная должностями («карточки водителей читает служба главного механика, а арендодатель —
 * нет»). Вторая ловит первую: перепутанное право почти всегда меняет состав ролей, и перечень
 * матрицы разойдётся с поведением. Плюс матрица держит то, чего в манифесте нет по построению:
 * коридоры сторон, маршруты «по самой записи» и полноту самих субъектов — каждый поставочный профиль
 * встречается хотя бы в одном разрешении, выдуманных ключей в перечнях нет, а профиль с надстройкой
 * проходит там, где его базовой роли отказано.
 */

const DB_CALL = 'вызов БД в переборе доступа';

/**
 * Любое обращение к db — ошибка: перебор доходит максимум до входа в обработчик. Заглушка та же,
 * что в `access-matrix.test.ts`, и падает она на `await`, а не на вызове: запрос drizzle собирается
 * цепочкой, и синхронный бросок из её середины оставлял бы соседний промис необработанным
 * (`Promise.all([...])` в журнале листов однажды именно так и уронил прогон).
 */
vi.mock('../src/db/client', () => {
  const fail = () => Promise.reject(new Error(DB_CALL));
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) => reject(new Error(DB_CALL))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

// Токен и загрузка пользователя подменяются: проверяются права, а не механика входа.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: 'user-1', role: currentSubject.role, av: 1 }),
  signAccessToken: async () => 'test-token',
}));

vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => ({
    id: 'user-1',
    email: 'user@test.local',
    lastName: 'Пользователь',
    firstName: 'Тестовый',
    middleName: '',
    fullName: 'Пользователь Тестовый',
    phone: '9000000000',
    role: currentSubject.role,
    isActive: true,
    mustChangePassword: false,
    /*
     * Области заполнены у всех четырёх осей, хотя роль перебора ни на одной из них не стоит:
     * проверяется граница доступа, а не то, кому область выдана. Пустая область у роли с осью
     * отвечала бы «работает только со своими объектами» — тем же 403, что и страж, — и негативные
     * случаи доказывали бы работу области вместо права.
     */
    constructionObjectIds: [OBJECT_ID],
    departmentIds: [DEPARTMENT_ID],
    departmentObjectIds: [OBJECT_ID],
    counterpartyId: COUNTERPARTY_ID,
    counterpartyType: null,
    personId: PERSON_ID,
    /*
     * Права приходят назначенными полномочиями (ADR 0106, шаг 1c) — четвёртым источником субъекта.
     * Это единственный источник, который выражает **произвольный** набор: роль несёт свой набор
     * целиком, надстройка — свой, и собрать из них «ровно эти два права» нельзя. Коды наборов при
     * этом пусты: состав набора живёт в базе, а матрица получает готовый список прав.
     */
    grantCodes: [],
    grantPermissions: [...currentSubject.grants],
    addons: [],
    authVersion: 1,
  }),
}));

// Валидные UUID: схемы проверяются до preHandler, и на кривом id перебор увидел бы 400 вместо 403.
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';
const PERSON_ID = '44444444-4444-4444-8444-444444444444';
const DEPARTMENT_ID = '55555555-5555-4555-8555-555555555555';

/** Заведомо будущая дата: рейс задним числом требует `waybills.correct` (ADR 0101 п. 4). */
const FUTURE_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_DATE = FUTURE_AT.slice(0, 10);
/**
 * Заведомо прошедшая дата — для показаний: их снимают с прибора, и день из будущего обработчик
 * отвергает («день ещё не наступил») до всякой БД, то есть 403 пришёл бы не от стража.
 */
const PAST_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Отпечаток последствий нужного вида — 64 шестнадцатеричных знака (`expectedImpactHashSchema`).
 * Заведомо не совпадающий с настоящим: перебор доходит до стража, а до сверки отпечатка — нет.
 */
const IMPACT_HASH = 'a'.repeat(64);

/** Значения параметров пути по умолчанию: одно на каждое имя, встречающееся в манифесте. */
const PARAM_VALUES: Record<string, string> = {
  id: RECORD_ID,
  fileId: RECORD_ID,
  grantId: RECORD_ID,
  licenseId: RECORD_ID,
  pointId: RECORD_ID,
  requestId: RECORD_ID,
  specId: RECORD_ID,
  vehicleId: RECORD_ID,
  personId: PERSON_ID,
  date: FUTURE_DATE,
  key: 'objects',
};

/**
 * Как построить запрос к маршруту. Пустая фикстура — обычное дело: у `GET` без обязательных
 * фильтров и у `DELETE` без версии в адресе строится всё по умолчанию.
 *
 * Правильность фикстуры проверяет сам перебор, и проверяет её строго: схема Fastify стоит **до**
 * preHandler, поэтому кривое тело даёт 400 раньше, чем страж — 403. Случай «пустой набор прав →
 * 403» есть у каждого маршрута с правами, и он же ловит любую негодную фикстуру — 400 вместо 403
 * означает, что до стража запрос не дошёл и доказывать было нечего.
 */
interface RouteFixture {
  /** Строка запроса без `?`. */
  query?: string;
  /** Тело запроса; у `POST`/`PATCH`/`PUT` по умолчанию `{}`. */
  payload?: unknown;
  /** Значения параметров пути, если значение по умолчанию схему не проходит. */
  params?: Record<string, string>;
  /**
   * Права, которые обработчик спрашивает до первого запроса в БД, — сверх условия маршрута.
   * Нужны там, где отказ пришёл бы не от стража, а из обработчика (коридоры сторон заявки на
   * обслуживание, Р17), и положительный случай выглядел бы отказом стража.
   *
   * Пересекаться с условием они не могут — это проверяется отдельно: право из условия, выданное
   * «сверх», сделало бы негативный случай бессмысленным.
   */
  handlerNeeds?: readonly Permission[];
  /**
   * Как выглядит отказ **обработчика** этого маршрута — тот, что случается до первого запроса в БД.
   * Работает в обе стороны, и обе нужны:
   *
   * - в **положительном** случае такой отказ доказывает, что страж запрос пропустил (обработчик
   *   стоит после preHandler, и добраться до его проверки иначе нельзя). Другого доказательства
   *   там, где правило обработчика правом не выражается вовсе, не бывает: недельную заявку ведут по
   *   площадке (`assertWeeklyRequestScope`), а площадки у роли перебора нет ни при каком праве;
   * - в **негативном** случае — наоборот, признак беды: значит страж право не спросил, запрос
   *   пустили внутрь, и 403 пришёл от чужого правила. Код у обоих отказов один (`forbidden`), и
   *   снятую проверку прав перебор без этой сверки принял бы за работающую.
   *
   * Сверяется вхождением подстроки: в тексте отказа стоят имя роли и название статуса, а
   * опознаётся правило по неизменной части.
   */
  selfRefusal?: string;
  /**
   * Текст отказа условной проверки (`assertCan` в обработчике): им доказывается, что условное право
   * спрошено **своей** проверкой, а не стражем базового права. Без него негативный случай условного
   * права сошёлся бы с любым 403 — в том числе с отказом, к условному полю отношения не имеющим.
   */
  conditionalRefusal?: string;
  /**
   * Значения условного поля (`conditionalPermissions`), которые пропускает схема **этого**
   * маршрута: на каждое строится свой набор сценариев. `null` бывает только там, где поле
   * `nullable` (план §14).
   */
  conditionalValues?: Record<string, readonly { label: string; value: unknown }[]>;
}

/** Верифицированный адрес (ADR 0006): на запись схема принимает только выбранный из подсказок. */
const ADDRESS = { source: 'resolved', fiasId: 'fias-test-0001' };
/** Роль на точке маршрута: линейный день — самая короткая из двух форм (Р5а). */
const POINT_ROLE = { kind: 'linear', requestId: RECORD_ID, workDate: FUTURE_DATE };
const PASSWORD = 'Zx9-Portal-Proba-2026';
const CONTACT = { responsibleName: 'Петров П. П.', responsiblePhone: '+7 926 000-00-01' };
/**
 * Неизменная часть отказа коридора сторон (`assertSideAllowed`, Р17): «<Роль> не переводит заявку в
 * «<Статус>» — это шаг другой стороны». Правило живёт в обработчике и правом маршрута не выражается.
 */
const CORRIDOR_REFUSAL = 'это шаг другой стороны';
/** Отказ условной проверки назначения исполнителя (`assertCan` в обработчике вывоза). */
const ASSIGN_OPERATOR_REFUSAL = 'Оператора назначает диспетчер или менеджер';

const FIXTURES: Partial<Record<ManifestRouteKey, RouteFixture>> = {
  // ── Вход и self-service ──
  // Тело валидное, потому что схема стоит до стража: с пустым телом невошедший получил бы 400, и
  // проверка «без токена — 401» доказывала бы работу схемы.
  'POST /api/v1/auth/change-password': {
    payload: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` },
  },

  'POST /api/v1/auth/refresh': {
    // Публичный маршрут, который сам отвечает 401: пары токенов в запросе нет. Отказ не стража —
    // тот бы ответил «Требуется авторизация», а вход здесь как раз и не требуется.
    selfRefusal: 'Отсутствует refresh-токен',
  },

  // ── Внутренние ручки планировщика ──
  'POST /internal/mail/runs': { payload: { scheduleId: RECORD_ID, plannedAt: FUTURE_AT } },

  // ── Учётные записи ──
  'POST /api/v1/users': {
    payload: {
      email: 'new-user@test.local',
      lastName: 'Тестовый',
      firstName: 'Пользователь',
      role: 'manager',
      password: PASSWORD,
    },
  },
  'POST /api/v1/users/:id/email': { payload: { newEmail: 'other@test.local' } },
  'POST /api/v1/users/:id/password': { payload: { newPassword: PASSWORD } },
  'POST /api/v1/users/:id/reject': {
    payload: { reason: 'учётка не подтверждена', notifyApplicant: false },
  },

  // ── Каталог назначаемых полномочий (ADR 0106) ──
  // Тела валидные, потому что схема стоит до стража: без кода и названия негативный случай получил
  // бы 400 от схемы и доказывал бы её работу вместо работы права. Состав пустой намеренно — барьеры
  // выдачи проверяются своим тестом на живой базе, а здесь предмет один: пустил страж или нет.
  'POST /api/v1/grants': {
    payload: { code: 'access_sweep_probe', name: 'Набор перебора доступа' },
  },
  'PATCH /api/v1/grants/:id': { payload: { expectedVersion: 1, expectedImpactHash: IMPACT_HASH } },
  'POST /api/v1/grants/:id/preview': { payload: {} },

  // ── Выдача и отзыв полномочия (ADR 0106, решение 7) ──
  // Отпечаток последствий обязателен и проверяется схемой по формату: короткая строка дала бы 400 до
  // стража, и негативный случай доказывал бы работу схемы вместо работы права.
  'POST /api/v1/users/:id/grants': {
    payload: { grantId: RECORD_ID, expectedImpactHash: IMPACT_HASH },
  },
  'POST /api/v1/users/:id/grants/preview': {
    payload: { operation: 'assign', grantId: RECORD_ID },
  },
  'DELETE /api/v1/users/:id/grants/:grantId': { query: `expectedImpactHash=${IMPACT_HASH}` },

  // ── Почтовый контур ──
  'GET /api/v1/admin/mail/drivers-with-routes': { query: `date=${FUTURE_DATE}` },
  'GET /api/v1/admin/mail/recipient-candidates': { query: 'permissions=vehicleRequests.read' },
  'POST /api/v1/admin/mail/recipients': {
    payload: {
      event: 'service_request_waiting_it',
      toEmail: 'mail@test.local',
      replyToMode: 'portal',
    },
  },
  'PATCH /api/v1/admin/mail/recipients/:id': {
    payload: {
      toEmail: 'mail@test.local',
      isEnabled: true,
      replyToMode: 'portal',
      replyToEmail: '',
      comment: '',
      version: 0,
    },
  },
  'POST /api/v1/admin/mail/schedules': {
    payload: {
      type: 'driver_routes',
      name: 'Задание водителям',
      sendAt: '06:30',
      windowFromDays: 0,
      windowDays: 1,
    },
  },
  'PATCH /api/v1/admin/mail/schedules/:id': {
    payload: {
      type: 'driver_routes',
      name: 'Задание водителям',
      sendAt: '06:30',
      windowFromDays: 0,
      windowDays: 1,
      version: 0,
    },
  },
  'POST /api/v1/admin/mail/test': {
    payload: { kind: 'driver_routes', toUserId: RECORD_ID, date: FUTURE_DATE },
  },

  // ── Руководства пользователя (`docs/manuals-plan.md`) ──
  // Тело обязано быть годным: схема проверяется до `preHandler`, и без названия со ссылкой
  // негативные случаи получали бы 400 от разбора вместо 403 от стража — то есть не проверяли бы
  // ничего. Ссылка по `https`: `CHECK` базы того же требует, но здесь отказал бы zod.
  'POST /api/v1/manuals': {
    payload: { title: 'Краткая инструкция', url: 'https://disk.360.yandex.ru/i/example' },
  },

  // ── Справочники ──
  'POST /api/v1/objects': { payload: { code: 'OBJ-1', name: 'Объект', address: 'Москва' } },
  'POST /api/v1/departments': { payload: { code: 'DEP-1', name: 'Отдел' } },
  'POST /api/v1/counterparties': {
    payload: { type: 'contractor', name: 'ООО «Проба»', inn: '7700000000' },
  },
  'GET /api/v1/counterparties/resolve': { query: 'name=Проба' },
  'POST /api/v1/warehouses': {
    payload: { supplierId: COUNTERPARTY_ID, address: 'г. Мытищи, ул. Ленина, д. 1' },
  },
  'PATCH /api/v1/warehouses/:id': { payload: { address: 'г. Мытищи, ул. Ленина, д. 2' } },
  'POST /api/v1/container-types': { payload: { code: 'CT-1', name: 'Бункер 8 м³' } },
  'POST /api/v1/waste-tariffs': {
    payload: {
      operatorCounterpartyId: COUNTERPARTY_ID,
      wasteTypeId: RECORD_ID,
      containerTypeId: RECORD_ID,
      pricePerM3: 1000,
    },
  },
  'GET /api/v1/waste-tariffs/resolve': {
    query: `operatorCounterpartyId=${COUNTERPARTY_ID}&wasteTypeId=${RECORD_ID}&containerTypeId=${RECORD_ID}`,
  },
  'POST /api/v1/vehicle-types': {
    payload: { kindId: RECORD_ID, code: 'vt_proba', name: 'Самосвал' },
  },
  'POST /api/v1/vehicle-types/:id/linear': { payload: { isLinear: true } },
  'GET /api/v1/vehicle-types/:id/linear-switch-preview': { query: 'isLinear=true' },
  'POST /api/v1/vehicle-types/:id/specs': { payload: { specId: RECORD_ID, sortOrder: 1 } },
  'PATCH /api/v1/vehicle-types/:id/specs/:specId': { payload: { sortOrder: 2 } },
  'POST /api/v1/vehicle-specs': { payload: { code: 'spec_proba', name: 'Грузоподъёмность' } },
  'POST /api/v1/vehicle-categories': {
    payload: { vehicleTypeId: RECORD_ID, values: [{ specId: RECORD_ID, value: '25' }] },
  },
  'POST /api/v1/vehicles': {
    payload: { ownership: 'own', vehicleTypeId: RECORD_ID, registrationNumber: 'А123ВС77' },
  },

  // ── Справочник водителей ──
  'POST /api/v1/drivers': {
    payload: { lastName: 'Тестовый', firstName: 'Водитель', snils: '112-233-445 95' },
  },
  'PATCH /api/v1/drivers/:id': { payload: { version: 0 } },
  'POST /api/v1/drivers/:id/licenses': {
    payload: { number: '482645', categories: [{ categoryId: RECORD_ID }] },
  },
  'POST /api/v1/drivers/:id/licenses/:licenseId/revoke': {
    payload: { revokeReason: 'лишение права управления' },
  },
  'POST /api/v1/drivers/:id/licenses/:licenseId/verify': {
    payload: { verificationStatus: 'verified' },
  },
  'GET /api/v1/drivers/available': { query: `vehicleId=${RECORD_ID}&on=${FUTURE_DATE}` },

  // ── Обмен справочниками файлом ──
  'POST /api/v1/directories/:key/import': {
    payload: { dryRun: true, filename: 'objects.xlsx', contentBase64: 'UEsDBBQAAAAIAA==' },
  },

  // ── Орг.техника ──
  'POST /api/v1/office-equipment-types': { payload: { code: 'plotter', name: 'Плоттер' } },
  'PATCH /api/v1/office-equipment-types/:id': { payload: { name: 'Плоттеры' } },
  'POST /api/v1/office-equipment': {
    payload: {
      equipmentTypeId: RECORD_ID,
      name: 'Kyocera ECOSYS M3145',
      inventoryNumber: '0012345',
      objectId: OBJECT_ID,
    },
  },
  'POST /api/v1/office-equipment/:id/move': {
    payload: { objectId: OBJECT_ID, movedOn: FUTURE_DATE, reason: 'переезд кабинета' },
  },

  // ── Заявки на обслуживание ──
  'POST /api/v1/service-requests': {
    payload: {
      officeEquipmentId: RECORD_ID,
      description: 'не захватывает бумагу',
      responsibleName: CONTACT.responsibleName,
      responsiblePhone: '9000000000',
    },
  },
  'PATCH /api/v1/service-requests/:id': { payload: { description: 'не тянет бумагу', version: 1 } },
  'PATCH /api/v1/service-requests/:id/accept': { payload: { version: 1 } },
  /*
   * Коридоры сторон (Р17) стоят первой строкой обработчика, до чтения заявки: субъекту, у которого
   * этой дуги нет вовсе, отказывают сразу. Дуга исполнителя требует `serviceRequests.estimate`, дуга
   * оператора — `serviceRequests.status`, и на маршрутах ниже одно из двух прав в условии не
   * названо: дугу открывает не оно. Без добавки положительный случай упирался бы в коридор, а не в
   * стража; с добавкой негативные случаи остаются в силе — она не пересекается с условием (это
   * отдельная проверка ниже).
   */
  'PATCH /api/v1/service-requests/:id/complete': {
    payload: { completedOn: FUTURE_DATE, items: [], version: 1 },
    handlerNeeds: ['serviceRequests.status'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/decline': {
    payload: { reason: 'заняты до конца месяца', version: 1 },
    handlerNeeds: ['serviceRequests.estimate'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PUT /api/v1/service-requests/:id/estimate': {
    payload: {
      items: [{ kind: 'part', name: 'Ролик подачи', quantity: 1, unitPrice: 1800 }],
      version: 1,
    },
  },
  'PATCH /api/v1/service-requests/:id/estimate/approval': {
    payload: { approved: true, version: 1 },
    handlerNeeds: ['serviceRequests.status'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/estimate/reopen': {
    payload: { reason: 'нужен ещё термоузел', version: 1 },
    handlerNeeds: ['serviceRequests.status'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/estimate/submit': {
    payload: { version: 1 },
    handlerNeeds: ['serviceRequests.status'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'POST /api/v1/service-requests/:id/files': { payload: { fileIds: [RECORD_ID], kind: 'act' } },
  // Заморозка и возврат — шаг ведущей стороны (ADR 0125): право то же, что у прочих ходов
  // оператора, а сервисной компании обе ручки отказывают своим сообщением.
  'PATCH /api/v1/service-requests/:id/hold': {
    payload: { reason: 'ждём запчасть с завода', version: 1 },
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/resume': {
    payload: { version: 1 },
    selfRefusal: 'это шаг того, кто её ведёт',
  },
  'PATCH /api/v1/service-requests/:id/it-approval': { payload: { approved: true, version: 1 } },
  'POST /api/v1/service-requests/:id/notify': { payload: { idempotencyKey: RECORD_ID } },
  'PATCH /api/v1/service-requests/:id/rework': {
    payload: { reason: 'подача по-прежнему не работает', version: 1 },
  },
  'PATCH /api/v1/service-requests/:id/service': {
    payload: { serviceCounterpartyId: COUNTERPARTY_ID, version: 1 },
    handlerNeeds: ['serviceRequests.status'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/service-comment': {
    payload: { serviceComment: 'будем во вторник', version: 1 },
  },
  'PATCH /api/v1/service-requests/:id/start': {
    payload: { version: 1 },
    handlerNeeds: ['serviceRequests.estimate'],
    selfRefusal: CORRIDOR_REFUSAL,
  },
  'PATCH /api/v1/service-requests/:id/status': {
    payload: { status: 'cancelled', reason: 'технику списали', version: 1 },
  },
  'PATCH /api/v1/service-requests/:id/urgency': {
    payload: { isUrgent: true, urgencyReason: 'печатают акты приёмки', version: 1 },
  },

  // ── Вывоз мусора ──
  'POST /api/v1/waste-requests': {
    payload: {
      objectId: OBJECT_ID,
      requestType: 'container_install',
      containerTypeId: RECORD_ID,
      deliveryAt: FUTURE_AT,
      deliveryTimeUnspecified: true,
      ...CONTACT,
    },
    conditionalRefusal: ASSIGN_OPERATOR_REFUSAL,
    conditionalValues: {
      // Схема заведения принимает необязательный UUID: `null` Zod отклонит раньше проверки права,
      // и сценарий на него доказывал бы работу схемы (план §14).
      operatorCounterpartyId: [{ label: 'идентификатор', value: COUNTERPARTY_ID }],
    },
  },
  'PATCH /api/v1/waste-requests/:id': {
    payload: { version: 1 },
    conditionalRefusal: ASSIGN_OPERATOR_REFUSAL,
    conditionalValues: {
      // У правки поле `nullable`: снять назначенного исполнителя — такое же назначение, и права
      // оно требует по присутствию поля, а не по истинности значения.
      operatorCounterpartyId: [
        { label: 'идентификатор', value: COUNTERPARTY_ID },
        { label: 'null — снятие исполнителя', value: null },
      ],
    },
  },
  'PATCH /api/v1/waste-requests/:id/comment': {
    payload: { operatorComment: 'будем после 15:00', version: 1 },
  },
  'PATCH /api/v1/waste-requests/:id/operator': {
    payload: { operatorCounterpartyId: COUNTERPARTY_ID, version: 1 },
  },
  'PATCH /api/v1/waste-requests/:id/status': { payload: { status: 'confirmed', version: 1 } },
  'GET /api/v1/waste-requests/present-groups': { query: `objectId=${OBJECT_ID}` },

  // ── Недельная заявка на технику ──
  'POST /api/v1/weekly-vehicle-requests': {
    payload: { objectId: OBJECT_ID, weekStart: FUTURE_DATE, items: [] },
    // Недельную заявку ведут по площадке (`assertWeeklyRequestScope`), а роль перебора работает на
    // оси работника справочника — площадки у неё нет вовсе, и правом это не исправить. Поэтому
    // положительный случай доказывается тем, что отказ пришёл из обработчика: значит страж пропустил.
    selfRefusal: 'не ведёт недельные заявки',
  },
  'PATCH /api/v1/weekly-vehicle-requests/:id': { payload: { items: [], version: 0 } },
  'POST /api/v1/weekly-vehicle-requests/:id/approval': {
    payload: { approved: true, version: 0 },
  },
  'POST /api/v1/weekly-vehicle-requests/:id/status': {
    payload: { status: 'cancelled', reason: 'техника не понадобилась', version: 0 },
  },
  'GET /api/v1/weekly-vehicle-requests/suggestion': {
    query: `objectId=${OBJECT_ID}&weekStart=${FUTURE_DATE}`,
    selfRefusal: 'не ведёт недельные заявки',
  },

  // ── Заказ ТС ──
  'POST /api/v1/vehicle-requests': {
    payload: {
      requestType: 'special_equipment',
      objectId: OBJECT_ID,
      vehicleTypeId: RECORD_ID,
      dateFrom: FUTURE_DATE,
      dateTo: FUTURE_DATE,
      ...CONTACT,
    },
  },
  'PATCH /api/v1/vehicle-requests/:id': {
    payload: {
      requestType: 'special_equipment',
      objectId: OBJECT_ID,
      vehicleTypeId: RECORD_ID,
      dateFrom: FUTURE_DATE,
      dateTo: FUTURE_DATE,
      ...CONTACT,
      version: 1,
    },
  },
  'PATCH /api/v1/vehicle-requests/:id/approval': { payload: { approved: true, version: 1 } },
  'PATCH /api/v1/vehicle-requests/:id/assignment': {
    payload: { vehicleId: RECORD_ID, version: 1 },
  },
  'POST /api/v1/vehicle-requests/:id/days/:date/route': { payload: { routeId: RECORD_ID } },
  'POST /api/v1/vehicle-requests/:id/early-end': {
    payload: { newDateTo: FUTURE_DATE, reason: 'работы закончены', version: 1 },
  },
  'PATCH /api/v1/vehicle-requests/:id/early-end': { payload: { approved: true, version: 1 } },
  'POST /api/v1/vehicle-requests/:id/esm2': {
    payload: {
      weekOf: FUTURE_DATE,
      vehicleId: RECORD_ID,
      driverPersonId: PERSON_ID,
      version: 1,
    },
  },
  'POST /api/v1/vehicle-requests/:id/relocations': {
    payload: {
      purpose: 'delivery',
      routeDate: FUTURE_DATE,
      moveFrom: 'Москва, ул. Первая, 1',
      moveTo: 'Москва, ул. Вторая, 2',
    },
  },
  'PATCH /api/v1/vehicle-requests/:id/request-type': {
    // Смена типа приходит телом целой заявки: тип задаёт состав полей, и половина заявки нового
    // типа схему не проходит.
    payload: {
      requestType: 'special_equipment',
      objectId: OBJECT_ID,
      vehicleTypeId: RECORD_ID,
      dateFrom: FUTURE_DATE,
      dateTo: FUTURE_DATE,
      ...CONTACT,
      version: 1,
    },
  },
  'PUT /api/v1/vehicle-requests/:id/shifts/:date': { payload: { machineHours: 8 } },
  'POST /api/v1/vehicle-requests/:id/shifts/:date/approval': { payload: { approved: true } },
  'PATCH /api/v1/vehicle-requests/:id/status': { payload: { status: 'confirmed', version: 1 } },
  'POST /api/v1/vehicle-requests/:id/status/preview': {
    payload: { status: 'confirmed', version: 1 },
  },

  // ── Рейсы и точки маршрута ──
  'POST /api/v1/vehicle-routes': { payload: { vehicleId: RECORD_ID, routeDate: FUTURE_DATE } },
  'PATCH /api/v1/vehicle-routes/:id': { payload: { version: 0 } },
  'GET /api/v1/vehicle-routes/:id/correction': {},
  'POST /api/v1/vehicle-routes/:id/correction': {
    // Пустая коррекция отклоняется схемой (Р31): в теле обязательно что-то меняется.
    payload: {
      operationId: RECORD_ID,
      version: 0,
      vehicleId: RECORD_ID,
      reason: 'ошибка при выписке',
    },
  },
  'POST /api/v1/vehicle-routes/:id/correction/transfer': {
    payload: {
      operationId: RECORD_ID,
      version: 0,
      source: { routeId: OBJECT_ID, version: 0 },
      requestId: RECORD_ID,
      reason: 'ошибка при выписке',
    },
  },
  'PUT /api/v1/vehicle-routes/:id/order': { payload: { requestIds: [RECORD_ID], version: 0 } },
  'POST /api/v1/vehicle-routes/:id/points': {
    payload: {
      location: 'Москва, ул. Первая, 1',
      address: ADDRESS,
      roles: [POINT_ROLE],
      version: 0,
    },
  },
  'PATCH /api/v1/vehicle-routes/:id/points/:pointId': {
    payload: {
      location: 'Москва, ул. Первая, 1',
      address: ADDRESS,
      roles: [POINT_ROLE],
      version: 0,
    },
  },
  'DELETE /api/v1/vehicle-routes/:id/points/:pointId': { query: 'version=0' },
  'PUT /api/v1/vehicle-routes/:id/points/:pointId/roles/order': {
    payload: { roles: [POINT_ROLE], version: 0 },
  },
  'POST /api/v1/vehicle-routes/:id/points/:pointId/split': {
    payload: { roles: [POINT_ROLE], version: 0 },
  },
  'POST /api/v1/vehicle-routes/:id/points/merge': {
    payload: { pointIds: [RECORD_ID, OBJECT_ID], version: 0 },
  },
  'PUT /api/v1/vehicle-routes/:id/points/order': {
    payload: { pointIds: [RECORD_ID], version: 0 },
  },
  'POST /api/v1/vehicle-routes/:id/requests': { payload: { requestId: RECORD_ID, version: 0 } },
  'DELETE /api/v1/vehicle-routes/:id/requests/:requestId': { query: 'version=0' },
  'POST /api/v1/vehicle-routes/:id/waybill': { payload: { version: 0 } },
  'GET /api/v1/vehicle-routes/suggest': { query: `vehicleId=${RECORD_ID}&date=${FUTURE_DATE}` },

  // ── Путевые листы ──
  'POST /api/v1/waybills/:id/cancel': { payload: { reason: 'испорчен при печати' } },
  'POST /api/v1/waybills/:id/files': { payload: { addFileIds: [RECORD_ID] } },
  'POST /api/v1/waybills/print-batch': { payload: { ids: [RECORD_ID] } },

  // ── Кабинет водителя ──
  'POST /api/v1/driver/reports/:date/submit': {
    params: { date: PAST_DATE },
    payload: {
      version: 0,
      items: [{ itemId: RECORD_ID, reading: { kind: 'values', odometerKm: 128_400 } }],
    },
  },

  // ── Показания одометра ──
  'POST /api/v1/vehicle-readings/items/:id/rebase': {
    payload: { reason: 'ошибка при вводе', reportVersions: {} },
  },
  // Вариант выгрузки обязателен (Р18), и берётся парковый: у журналов одной машины схема требует
  // ещё и `vehicleId`, а проверяется здесь право маршрута, а не полнота запроса.
  'GET /api/v1/vehicle-readings/export': {
    query: `kind=fleetSummary&from=${PAST_DATE}&to=${PAST_DATE}`,
  },
  'GET /api/v1/vehicle-readings/intake': { query: `from=${PAST_DATE}&to=${PAST_DATE}` },
  'GET /api/v1/vehicle-readings/journal/:vehicleId': {
    query: `from=${PAST_DATE}&to=${PAST_DATE}`,
  },
  // Список непустой намеренно: пустой пакет — законное тело, но с ним обработчик отвечает 200, ни
  // разу не спросив БД, и «положительный» случай проходил бы даже у маршрута без приёма внутри.
  'POST /api/v1/vehicle-readings/reports/accept-batch': {
    payload: { reports: [{ id: RECORD_ID, version: 0 }] },
  },
  'POST /api/v1/vehicle-readings/reports/:id/accept': { payload: { version: 0 } },
  'POST /api/v1/vehicle-readings/reports/:id/discrepancies': {
    payload: {
      kind: 'driver',
      fingerprint: 'проба',
      resolution: 'accepted_as_is',
      reason: 'источник переназначен',
      version: 0,
    },
  },
  'GET /api/v1/vehicle-readings/reports/:personId/:date': { params: { date: PAST_DATE } },
  'POST /api/v1/vehicle-readings/reports/:personId/:date/open': { params: { date: PAST_DATE } },
  'POST /api/v1/vehicle-readings/reports/:personId/:date/submit': {
    params: { date: PAST_DATE },
    payload: {
      version: 0,
      items: [{ itemId: RECORD_ID, reading: { kind: 'values', odometerKm: 128_400 } }],
    },
  },
  'PATCH /api/v1/vehicle-readings/shift-order': {
    payload: {
      vehicleId: RECORD_ID,
      date: PAST_DATE,
      expectedOrder: [RECORD_ID],
      order: [{ itemId: RECORD_ID, shiftOrder: 1 }],
      reportVersions: { [RECORD_ID]: 0 },
      reason: 'смены записали не в том порядке',
    },
  },
  'GET /api/v1/vehicle-readings/stats': { query: `from=${PAST_DATE}&to=${PAST_DATE}` },
  'GET /api/v1/vehicle-readings/stats/export': { query: `from=${PAST_DATE}&to=${PAST_DATE}` },
  'GET /api/v1/vehicle-readings/vehicles/:id/card': {
    query: `from=${PAST_DATE}&to=${PAST_DATE}`,
  },

  // ── Техническое обслуживание ──
  'PATCH /api/v1/vehicle-maintenance/:id': {
    payload: { performedOn: PAST_DATE, odometerKm: 128_400, version: 0 },
  },
  'DELETE /api/v1/vehicle-maintenance/:id': { query: 'version=0' },
  'GET /api/v1/vehicle-maintenance/snapshot': { query: `on=${PAST_DATE}&ids=${RECORD_ID}` },
  'POST /api/v1/vehicle-maintenance/vehicles/:id': {
    payload: { performedOn: PAST_DATE, odometerKm: 128_400, documentNumber: 'АКТ-17' },
  },
};

/** Субъект текущего запроса: подменённый `loadPrincipal` собирает из него принципала. */
interface Subject {
  role: Role;
  grants: readonly Permission[];
}

let currentSubject: Subject = { role: 'driver', grants: [] };
let app: FastifyInstance;

/**
 * Роль субъекта перебора: она обязана не давать ни одного права из условия маршрута, иначе
 * негативный случай «минус право» проходил бы за счёт роли и ничего не доказывал.
 *
 * Роли без прав в модели нет (самая узкая — `driver` с двумя правами кабинета), поэтому роль
 * выбирается под маршрут: `driver` не пересекается ни с чем, кроме собственного кабинета, а на
 * кабинете её подменяет `observer` — шесть прав чтения, среди которых кабинета нет. Обе роли
 * заодно стоят вне осей области (`driver` — на своей, четвёртой), и предикаты области их не
 * ограничивают: отказ, который увидит перебор, придёт от стража, а не от чужого объекта.
 */
const BASELINE_ROLES: readonly Role[] = ['driver', 'observer'];

function roleFor(condition: AccessCondition): Role {
  const needed = new Set<Permission>(allPermissionsOf(condition));
  const role = BASELINE_ROLES.find((r) => !ROLE_PERMISSIONS[r].some((p) => needed.has(p)));
  if (!role) throw new Error('нет роли, свободной от прав условия');
  return role;
}

/**
 * Каждый запрос идёт с собственного адреса: перебор бьёт по маршрутам шестью сотнями запросов, и с
 * одного адреса он упёрся бы в защиту от подбора (429) — она считает запросы по IP.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function urlOf(key: string, fixture: RouteFixture | undefined): string {
  const path = key.slice(key.indexOf(' ') + 1);
  const filled = path
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg;
      const name = seg.slice(1);
      const value = fixture?.params?.[name] ?? PARAM_VALUES[name];
      if (!value) throw new Error(`нет значения для параметра ${seg} (${key})`);
      return value;
    })
    .join('/');
  return fixture?.query ? `${filled}?${fixture.query}` : filled;
}

interface Request {
  method: string;
  url: string;
  payload?: unknown;
}

function requestOf(key: ManifestRouteKey, override?: unknown): Request {
  const fixture = FIXTURES[key];
  const method = key.slice(0, key.indexOf(' '));
  const hasBody = method === 'POST' || method === 'PATCH' || method === 'PUT';
  const payload =
    override !== undefined ? override : hasBody ? (fixture?.payload ?? {}) : fixture?.payload;
  return { method, url: urlOf(key, fixture), payload };
}

/** Запрос под субъектом: роль и набор прав — из сценария. */
async function inject(request: Request, subject?: Subject) {
  if (subject) currentSubject = subject;
  return app.inject({
    method: request.method as 'GET',
    url: request.url,
    remoteAddress: nextAddress(),
    ...(subject ? { headers: { authorization: 'Bearer test-token' } } : {}),
    ...(request.payload === undefined ? {} : { payload: request.payload as object }),
  });
}

/** Короткая выжимка ответа для сообщения об ошибке: код плюс тело, если оно не пустое. */
function describeResponse(res: { statusCode: number; body: string }): string {
  return `${res.statusCode} ${res.body.slice(0, 220)}`;
}

/** Текст отказа из тела ответа: им отличается отказ обработчика от отказа стража. */
function messageOf(res: { body: string }): string {
  try {
    return String((JSON.parse(res.body) as { message?: unknown }).message ?? '');
  } catch {
    return '';
  }
}

/**
 * Отказ выдал сам обработчик, а не страж. Значит запрос дошёл до тела обработчика — то есть страж
 * его пропустил, и для положительного случая это такое же доказательство, как ответ 200 или 500.
 */
function isSelfRefusal(key: ManifestRouteKey, res: { body: string }): boolean {
  const own = FIXTURES[key]?.selfRefusal;
  return !!own && messageOf(res).includes(own);
}

// ── Сценарии перебора ──

interface Scenario {
  /** Что проверяется: «минимальный набор», «минус право», «пустой набор». */
  title: string;
  grants: readonly Permission[];
  expect: 'pass' | 'forbidden';
  /** Тело запроса сценария (у условных прав оно своё). */
  payload?: unknown;
  /**
   * Чей отказ ожидается: пусто — стража, текст — условной проверки в обработчике. Снятое условное
   * право иначе доказывалось бы любым 403, включая чужой.
   */
  refusal?: string;
}

/**
 * Сценарии одного варианта запроса: разрешающий набор, минус каждое обязательное право, пустой
 * набор. Наборы, совпавшие по составу, не повторяются: у маршрута с одним правом «минус это право»
 * и «пустой набор» — один и тот же субъект, и второй запрос доказывал бы то же самое.
 */
function scenariosOf(
  variant: Variant,
  handlerNeeds: readonly Permission[],
  conditionalRefusal: string | undefined,
): Scenario[] {
  const suffix = variant.label ? ` (${variant.label})` : '';
  const withNeeds = (grants: readonly Permission[]): Permission[] => [...grants, ...handlerNeeds];
  const conditional = new Set<Permission>(variant.conditional);
  const out: Scenario[] = [
    {
      title: `минимальный разрешающий набор${suffix}`,
      grants: withNeeds(variant.required),
      expect: 'pass',
      payload: variant.payload,
    },
  ];
  const seen = new Set<string>();
  for (const dropped of variant.required) {
    const grants = variant.required.filter((p) => p !== dropped);
    seen.add([...grants].sort().join('|'));
    out.push({
      title: `без права ${dropped}${suffix}`,
      grants: withNeeds(grants),
      expect: 'forbidden',
      payload: variant.payload,
      // Условное право спрашивает обработчик, а не страж: отказ у него свой, и он же доказывает,
      // что сработала именно условная проверка.
      refusal: conditional.has(dropped) ? conditionalRefusal : undefined,
    });
  }
  if (!seen.has('')) {
    out.push({
      title: `пустой набор прав${suffix}`,
      grants: withNeeds([]),
      expect: 'forbidden',
      payload: variant.payload,
    });
  }
  return out;
}

interface Variant {
  label: string;
  payload?: unknown;
  /** Обязательные права этого варианта запроса. */
  required: readonly Permission[];
  /** Те из них, что требуются условным полем, а не маршрутом как таким. */
  conditional: readonly Permission[];
}

/**
 * Варианты запроса: один у обычного условия, по одному на **каждое значение условного поля**, которое
 * пропускает схема этого маршрута, — у условного (план §14). Без второго варианта условное право не
 * проверялось бы вовсе: запрос без поля законен и с одним базовым правом.
 */
function variantsOf(key: ManifestRouteKey, condition: AccessCondition): Variant[] {
  if (condition.kind === 'permissions') {
    return [
      { label: '', payload: requestOf(key).payload, required: condition.allOf, conditional: [] },
    ];
  }
  if (condition.kind !== 'conditionalPermissions') return [];
  const fixture = FIXTURES[key];
  const base = requestOf(key).payload as Record<string, unknown>;
  const out: Variant[] = [
    {
      label: 'без условного поля',
      payload: base,
      required: condition.baseAllOf,
      conditional: [],
    },
  ];
  for (const rule of condition.conditionalAllOf) {
    for (const value of fixture?.conditionalValues?.[rule.when] ?? []) {
      out.push({
        label: `${rule.when} = ${value.label}`,
        payload: { ...base, [rule.when]: value.value },
        required: [...condition.baseAllOf, ...rule.allOf],
        conditional: rule.allOf,
      });
    }
  }
  return out;
}

interface RouteSweep {
  key: ManifestRouteKey;
  condition: AccessCondition;
  scenarios: Scenario[];
}

const MANIFEST = Object.entries(ACCESS_MANIFEST) as [ManifestRouteKey, AccessCondition][];

const SWEEPS: RouteSweep[] = MANIFEST.filter(
  ([, c]) => c.kind === 'permissions' || c.kind === 'conditionalPermissions',
).map(([key, condition]) => {
  const handlerNeeds = FIXTURES[key]?.handlerNeeds ?? [];
  return {
    key,
    condition,
    scenarios: variantsOf(key, condition).flatMap((v) =>
      scenariosOf(v, handlerNeeds, FIXTURES[key]?.conditionalRefusal),
    ),
  };
});

const BY_KIND = (kind: AccessCondition['kind']): [ManifestRouteKey, AccessCondition][] =>
  MANIFEST.filter(([, c]) => c.kind === kind);

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    // Внутренние ручки закрыты общим секретом: без него они отвечают «внутренний доступ не
    // настроен» всем подряд, и перебор проверял бы отсутствие настройки, а не проверку токена.
    INTERNAL_API_TOKEN: 'test-internal-token',
    LOG_LEVEL: 'fatal',
  });
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
  // Своя граница времени: на холодном кеше vite трансформация приложения занимает больше десяти
  // секунд, и умолчание vitest роняло бы прогон на сборке, а не на проверке.
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('перебор построен из манифеста', () => {
  it('фикстуры описывают только живые маршруты', () => {
    const live = new Set<string>(Object.keys(ACCESS_MANIFEST));
    expect(Object.keys(FIXTURES).filter((key) => !live.has(key))).toEqual([]);
  });

  it('роль перебора не даёт ни одного проверяемого права', () => {
    const bad = SWEEPS.filter(({ condition }) => {
      const role = roleFor(condition);
      const needed = new Set<Permission>(allPermissionsOf(condition));
      return ROLE_PERMISSIONS[role].some((p) => needed.has(p));
    }).map(({ key }) => key);
    expect(bad).toEqual([]);
  });

  it('добавка «нужно обработчику» не пересекается с условием маршрута', () => {
    const bad: string[] = [];
    for (const { key, condition } of SWEEPS) {
      const needed = new Set<Permission>(allPermissionsOf(condition));
      for (const extra of FIXTURES[key]?.handlerNeeds ?? []) {
        if (needed.has(extra)) bad.push(`${key}: ${extra} есть в условии`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('у каждого условного поля есть хотя бы одно значение', () => {
    const bad: string[] = [];
    for (const [key, condition] of BY_KIND('conditionalPermissions')) {
      if (condition.kind !== 'conditionalPermissions') continue;
      for (const rule of condition.conditionalAllOf) {
        const values = FIXTURES[key]?.conditionalValues?.[rule.when] ?? [];
        if (values.length === 0) bad.push(`${key}: ${rule.when}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('на каждый маршрут с правами приходится набор плюс негативные случаи', () => {
    // Число случаев маршрута считается двумя способами: перечислением (`scenarios`) и формулой.
    // Разойтись они могут только если сценарии где-то потерялись — например, у условного маршрута
    // без значений условного поля: перебор тогда молча съёжился бы до одного варианта.
    const wrong = SWEEPS.filter(({ key, condition, scenarios }) => {
      const expected = variantsOf(key, condition).reduce(
        // На вариант: разрешающий набор, минус каждое право по очереди и пустой набор — последний
        // не считается отдельно там, где «минус единственное право» и есть пустой набор.
        (sum, v) => sum + 1 + v.required.length + (v.required.length > 1 ? 1 : 0),
        0,
      );
      return expected !== scenarios.length;
    }).map(({ key, scenarios }) => `${key}: ${scenarios.length}`);
    expect(wrong).toEqual([]);
  });

  it('каждый маршрут манифеста попал ровно в одну группу перебора', () => {
    // Иначе новый тип условия (или маршрут, выпавший из `SWEEPS` из-за ошибки в фикстуре) не
    // проверялся бы вовсе, а прогон оставался бы зелёным.
    const covered = [
      ...SWEEPS.map(({ key }) => key),
      ...BY_KIND('public').map(([key]) => key),
      ...BY_KIND('authenticated').map(([key]) => key),
      ...BY_KIND('internalToken').map(([key]) => key),
      ...BY_KIND('handlerAuthorized').map(([key]) => key),
    ];
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual(Object.keys(ACCESS_MANIFEST).sort());
  });
});

/** Сколько HTTP-случаев строит перебор: число видно в отчёте прогона — это его цена. */
const CASE_COUNT = SWEEPS.reduce((sum, sweep) => sum + sweep.scenarios.length, 0);

describe(`маршруты с условием прав — ${SWEEPS.length} маршрутов, ${CASE_COUNT} случаев`, () => {
  for (const { key, scenarios } of SWEEPS) {
    const condition = ACCESS_MANIFEST[key] as AccessCondition;
    it(`${key} — ${scenarios.length} случаев`, async () => {
      const role = roleFor(condition);
      const problems: string[] = [];
      for (const scenario of scenarios) {
        const request = requestOf(key, scenario.payload);
        const res = await inject(request, { role, grants: scenario.grants });
        const own = isSelfRefusal(key, res);
        if (scenario.expect === 'forbidden') {
          if (res.statusCode !== 403) {
            problems.push(`${scenario.title}: ожидался 403, получен ${describeResponse(res)}`);
          } else if (own) {
            // 403 от чужого правила означает, что страж право не спросил: запрос пустили внутрь, и
            // отказал уже обработчик — по своей причине, которая к проверяемому праву не относится.
            problems.push(`${scenario.title}: 403 не от стража — ${describeResponse(res)}`);
          } else if (scenario.refusal && !messageOf(res).includes(scenario.refusal)) {
            problems.push(
              `${scenario.title}: ожидался отказ условной проверки — ${describeResponse(res)}`,
            );
          }
        } else if ((res.statusCode === 403 || res.statusCode === 401) && !own) {
          problems.push(`${scenario.title}: отказ стража — ${describeResponse(res)}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

describe('маршруты без права', () => {
  for (const [key] of BY_KIND('public')) {
    it(`${key} — отвечает без токена`, async () => {
      const res = await inject(requestOf(key));
      // Отказ маршрута по его собственной причине (нет refresh-cookie) — не отказ стража: страж
      // ответил бы «Требуется авторизация», а входа здесь как раз не требуется.
      if (isSelfRefusal(key, res)) return;
      expect(describeResponse(res), key).not.toMatch(/^(401|403)/);
    });
  }

  for (const [key] of BY_KIND('authenticated')) {
    it(`${key} — без токена 401, с любой ролью проходит`, async () => {
      const anon = await inject(requestOf(key));
      expect(anon.statusCode, `${key} без токена`).toBe(401);
      for (const role of BASELINE_ROLES) {
        const res = await inject(requestOf(key), { role, grants: [] });
        expect(describeResponse(res), `${key} под ${role}`).not.toMatch(/^(401|403)/);
      }
    });
  }

  for (const [key] of BY_KIND('internalToken')) {
    it(`${key} — без секрета отказ, с секретом проходит`, async () => {
      const request = requestOf(key);
      const anon = await inject(request);
      expect(anon.statusCode, `${key} без секрета`).toBe(401);
      const res = await app.inject({
        method: request.method as 'GET',
        url: request.url,
        remoteAddress: nextAddress(),
        headers: { 'x-internal-token': 'test-internal-token' },
        ...(request.payload === undefined ? {} : { payload: request.payload as object }),
      });
      expect(describeResponse(res), `${key} с секретом`).not.toMatch(/^(401|403)/);
    });
  }
});

describe('маршруты, где решает обработчик', () => {
  /**
   * Перебор прав для них не строится — доступ к файлу выводится из связанной заявки, и перебирать
   * тут нечего. Зато ссылка на тест, который правило доказывает, обязана быть живой: `provenBy`,
   * указывающий на удалённый файл, — это дыра, выглядящая как проверка.
   */
  for (const [key, condition] of BY_KIND('handlerAuthorized')) {
    it(`${key} — доказывается своим тестом`, () => {
      if (condition.kind !== 'handlerAuthorized') return;
      expect(
        existsSync(resolve(import.meta.dirname, '..', condition.provenBy)),
        condition.provenBy,
      ).toBe(true);
    });
  }
});
