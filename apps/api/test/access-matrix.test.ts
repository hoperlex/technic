import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS_PROFILES, type AccessSubject } from '@technic/contracts';

/**
 * Сквозная проверка прав: настоящие запросы к собранному приложению под каждым субъектом
 * доступа — ролью, а у внешнего исполнителя парой «роль + тип контрагента» (ADR 0038).
 *
 * Матрица (`permissions.test.ts`) отвечает на вопрос «что субъект может», страж
 * (`route-authorization.test.ts`) — «объявлена ли проверка». Здесь проверяется третье:
 * что маршрут отдаёт 403 именно тем, кому должен, — то есть что к маршруту привязано
 * правильное право, а не просто какое-нибудь.
 *
 * До обработчиков дело не доходит: у запрещённых ролей отказ приходит из preHandler, а
 * разрешённым мы проверяем только «не 403» — БД подменена заглушкой, любой запрос в неё
 * падает и превращается в 500, чего для проверки доступа достаточно.
 */

const DB_CALL = 'вызов БД в тесте прав';

vi.mock('../src/db/client', () => {
  const fail = () => {
    throw new Error(DB_CALL);
  };
  // Любое обращение к db — ошибка: тест доходит максимум до входа в обработчик.
  const db = new Proxy({}, { get: () => fail });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

// Токен и загрузка пользователя подменяются: проверяем права, а не механику входа.
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
    role: currentSubject.role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectId: OBJECT_ID,
    counterpartyId: COUNTERPARTY_ID,
    counterpartyType: currentSubject.counterpartyType ?? null,
    authVersion: 1,
  }),
}));

// Валидные UUID: схемы проверяются до preHandler, и на кривом id тест увидел бы 400 вместо 403.
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
/** Заявку заводят не раньше чем на завтра по МСК — берём заведомо будущую дату. */
const FUTURE_DELIVERY_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

/** Субъект текущего запроса: подменённый `loadPrincipal` возвращает его принципалу. */
let currentSubject: AccessSubject = { role: null };
let app: FastifyInstance;

/**
 * Ключ субъекта в перечнях кейсов: у исполнителя — «роль/тип контрагента», у остальных ролей
 * просто роль. Пара пишется одной строкой, потому что и разрешение у неё одно на пару: роль
 * исполнителя без типа контрагента не отвечает ни на один вопрос про доступ.
 */
type ProfileKey =
  | 'admin'
  | 'manager'
  | 'dispatcher'
  | 'shtab'
  | 'rukstroy'
  | 'observer'
  | 'operator/operator'
  | 'operator/vehicle_lessor';

const keyOf = (s: AccessSubject): ProfileKey =>
  (s.counterpartyType ? `${s.role}/${s.counterpartyType}` : String(s.role)) as ProfileKey;

const PROFILE_KEYS = ACCESS_PROFILES.map(keyOf);

interface Case {
  title: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  /** Тело запроса: схема Fastify проверяется до preHandler, поэтому оно должно быть валидным. */
  payload?: unknown;
  /** Субъекты, которым маршрут разрешён; остальным ожидается 403. */
  allowed: ProfileKey[];
  /**
   * Маршрут решает по самой записи, а не по роли (`authorizeInHandler`): роль сюда не пускает
   * и не отсекает — доступ определяется тем, видна ли пользователю связанная заявка.
   */
  checkedInHandler?: true;
}

const CASES: Case[] = [
  // ── Водители (ADR 0037): своё право, а не `directories.*` — в карточке персональные данные ──
  {
    title: 'справочник водителей — чтение закрыто от всех, кроме ведущих заявки',
    method: 'GET',
    url: '/api/v1/drivers',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'заведение водителя — тем же, кто выписывает путевой лист',
    method: 'POST',
    url: '/api/v1/drivers',
    payload: {
      lastName: 'Тестовый',
      firstName: 'Водитель',
      snils: '112-233-445 95',
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Отбор водителя под машину — часть формы перевода заявки в работу. Право на статусы
    // заявок ТС сюда не годится: с ADR 0038 оно есть и у арендодателя, а водителей нашего
    // парка он не назначает — путевой лист выписывается только на собственные машины.
    title: 'отбор водителей под машину — тем же, кто ведёт водителей',
    method: 'GET',
    url: '/api/v1/drivers/available?vehicleId=00000000-0000-4000-8000-000000000000&on=2026-08-03',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // ── Справочники: чтение нужно всем (форма заявки), ведение — трём ролям ──
  {
    title: 'справочник техники — чтение',
    method: 'GET',
    url: '/api/v1/vehicles',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'справочник типов ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-types',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    // Классификатор (ADR 0028) — тот же справочник, что типы и категории, только одним списком:
    // им заполняется форма заявки, поэтому читать его должны все роли.
    title: 'классификатор ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-classifications',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'объекты — создание',
    method: 'POST',
    url: '/api/v1/objects',
    payload: { code: 'OBJ-1', name: 'Объект', address: 'Москва' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'техника — удаление',
    method: 'DELETE',
    url: `/api/v1/vehicles/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'прайс вывоза — создание позиции',
    method: 'POST',
    url: '/api/v1/waste-tariffs',
    payload: {
      operatorCounterpartyId: COUNTERPARTY_ID,
      wasteTypeId: RECORD_ID,
      containerTypeId: RECORD_ID,
      pricePerM3: 1000,
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'контрагенты — удаление',
    method: 'DELETE',
    url: `/api/v1/counterparties/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'контрагенты — восстановление из архива',
    method: 'POST',
    url: `/api/v1/counterparties/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },

  // ── Вывоз мусора: раньше модуль был открыт любому вошедшему ──
  {
    title: 'вывоз — список',
    method: 'GET',
    url: '/api/v1/waste-requests',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/operator',
      'observer',
    ],
  },
  {
    title: 'вывоз — удаление заявки',
    method: 'DELETE',
    url: `/api/v1/waste-requests/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy'],
  },
  {
    title: 'вывоз — смена статуса',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}/status`,
    payload: { status: 'confirmed', version: 1 },
    allowed: ['admin', 'manager', 'dispatcher', 'operator/operator'],
  },
  {
    title: 'вывоз — назначение оператора',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}/operator`,
    payload: { operatorCounterpartyId: COUNTERPARTY_ID, version: 1 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'вывоз — восстановление из архива',
    method: 'POST',
    url: `/api/v1/waste-requests/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },

  // ── Заказ ТС: оператору вывоза недоступен целиком (ADR 0010), арендодателю открыт как
  // исполнителю — он видит заявки, на которые вышла его техника, и закрывает их (ADR 0038) ──
  {
    title: 'заказ ТС — список',
    method: 'GET',
    url: '/api/v1/vehicle-requests',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — сводка',
    method: 'GET',
    url: '/api/v1/vehicle-requests/summary',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    // Срез «На объекте» (ADR 0036) — то же чтение заявок: наблюдателю он открыт, оператору
    // вывоза недоступен вместе со всем модулем.
    title: 'заказ ТС — техника на объектах',
    method: 'GET',
    url: '/api/v1/vehicle-requests/on-site',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — итог по технике на объектах',
    method: 'GET',
    url: '/api/v1/vehicle-requests/on-site/summary',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — удаление заявки',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy'],
  },
  {
    // Виза — решение заказчика со стороны объекта, а не того, кто заявку обрабатывает (ADR 0025):
    // менеджеру и диспетчеру она недоступна, хотя статусы ведут именно они.
    title: 'заказ ТС — виза руководителя строительства',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/approval`,
    payload: { approved: true, version: 1 },
    allowed: ['admin', 'rukstroy'],
  },
  {
    title: 'заказ ТС — смена статуса',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/status`,
    payload: { status: 'confirmed', version: 1 },
    // Право на маршрут у арендодателя есть; коридор переходов и чужие заявки отсекаются дальше —
    // проверками области и `assertTransitionAllowed`, а не 403 на входе.
    allowed: ['admin', 'manager', 'dispatcher', 'operator/vehicle_lessor'],
  },

  // ── Назначение исполнителя не должно обходиться общими маршрутами заявки (ADR 0010) ──
  {
    title: 'вывоз — исполнитель прямо в форме создания',
    method: 'POST',
    url: '/api/v1/waste-requests',
    payload: {
      objectId: OBJECT_ID,
      requestType: 'container_install',
      containerTypeId: RECORD_ID,
      operatorCounterpartyId: COUNTERPARTY_ID,
      deliveryAt: FUTURE_DELIVERY_AT,
      deliveryTimeUnspecified: true,
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'вывоз — смена исполнителя правкой заявки',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}`,
    payload: { operatorCounterpartyId: COUNTERPARTY_ID, version: 1 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'вывоз — создание заявки без исполнителя',
    method: 'POST',
    url: '/api/v1/waste-requests',
    payload: {
      objectId: OBJECT_ID,
      requestType: 'container_install',
      containerTypeId: RECORD_ID,
      deliveryAt: FUTURE_DELIVERY_AT,
      deliveryTimeUnspecified: true,
    },
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy'],
  },

  // ── Архив справочника: смотрит тот, кто его ведёт; возвращает из архива администратор ──
  {
    title: 'техника — восстановление из архива',
    method: 'POST',
    url: `/api/v1/vehicles/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },

  // ── Файлы: доступ определяется связанной заявкой, а не ролью (authorizeInHandler) ──
  {
    title: 'файл — ссылка на скачивание',
    method: 'GET',
    url: `/api/v1/files/${RECORD_ID}/download`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
    ],
    checkedInHandler: true,
  },

  // ── Администрирование ──
  { title: 'учётки — список', method: 'GET', url: '/api/v1/users', allowed: ['admin'] },
  { title: 'аудит — журнал', method: 'GET', url: '/api/v1/audit', allowed: ['admin'] },
];

async function request(subject: AccessSubject, c: Case) {
  currentSubject = subject;
  return app.inject({
    method: c.method,
    url: c.url,
    headers: { authorization: 'Bearer test-token' },
    ...(c.payload === undefined ? {} : { payload: c.payload as object }),
  });
}

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
    LOG_LEVEL: 'fatal',
  });
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('доступ по субъектам — запреты', () => {
  for (const c of CASES) {
    const denied = ACCESS_PROFILES.filter((s) => !c.allowed.includes(keyOf(s)));
    if (denied.length === 0) continue;
    it(`${c.title}: отказ для ${denied.map(keyOf).join(', ')}`, async () => {
      for (const subject of denied) {
        const res = await request(subject, c);
        expect(res.statusCode, `${keyOf(subject)} → ${c.method} ${c.url}`).toBe(403);
      }
    });
  }
});

describe('доступ по субъектам — разрешения', () => {
  for (const c of CASES) {
    it(`${c.title}: пропускает ${c.allowed.join(', ')}`, async () => {
      for (const key of c.allowed) {
        const subject = ACCESS_PROFILES.find((s) => keyOf(s) === key);
        expect(subject, `неизвестный субъект ${key}`).toBeDefined();
        const res = await request(subject!, c);
        // Проверка прав пройдена — дальше обработчик упирается в подменённую БД.
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(403);
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(401);
      }
    });
  }
});

describe('перечни кейсов покрывают всех, кто бывает в портале', () => {
  it('каждый субъект доступа встречается хотя бы в одном разрешении', () => {
    const mentioned = new Set(CASES.flatMap((c) => c.allowed));
    expect(PROFILE_KEYS.filter((k) => !mentioned.has(k))).toEqual([]);
  });
});

describe('учётка без роли', () => {
  it('не проходит ни на один маршрут, закрытый правом', async () => {
    for (const c of CASES.filter((x) => !x.checkedInHandler)) {
      const res = await request({ role: null }, c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
  });

  it('на маршрутах «по записи» доходит до обработчика — там её не видит ни одна заявка', async () => {
    for (const c of CASES.filter((x) => x.checkedInHandler)) {
      const res = await request({ role: null }, c);
      expect(res.statusCode, `${c.method} ${c.url}`).not.toBe(403);
    }
  });
});

describe('вход обязателен', () => {
  it('без токена — 401 на любом маршруте матрицы', async () => {
    for (const c of CASES) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        ...(c.payload === undefined ? {} : { payload: c.payload as object }),
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });
});
