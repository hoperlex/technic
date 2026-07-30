import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLES, type Role } from '@technic/contracts';

/**
 * Сквозная проверка прав: настоящие запросы к собранному приложению под каждой ролью.
 *
 * Матрица (`permissions.test.ts`) отвечает на вопрос «что роль может», страж
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
  verifyAccessToken: async () => ({ sub: 'user-1', role: currentRole, av: 1 }),
  signAccessToken: async () => 'test-token',
}));

vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => ({
    id: 'user-1',
    email: 'user@test.local',
    fullName: 'Пользователь',
    role: currentRole,
    isActive: true,
    mustChangePassword: false,
    constructionObjectId: OBJECT_ID,
    counterpartyId: COUNTERPARTY_ID,
    authVersion: 1,
  }),
}));

// Валидные UUID: схемы проверяются до preHandler, и на кривом id тест увидел бы 400 вместо 403.
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
/** Заявку заводят не раньше чем на завтра по МСК — берём заведомо будущую дату. */
const FUTURE_DELIVERY_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

/** Роль текущего запроса: подменённый `loadPrincipal` возвращает её принципалу. */
let currentRole: Role | null = null;
let app: FastifyInstance;

interface Case {
  title: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  /** Тело запроса: схема Fastify проверяется до preHandler, поэтому оно должно быть валидным. */
  payload?: unknown;
  /** Роли, которым маршрут разрешён; остальным ожидается 403. */
  allowed: Role[];
  /**
   * Маршрут решает по самой записи, а не по роли (`authorizeInHandler`): роль сюда не пускает
   * и не отсекает — доступ определяется тем, видна ли пользователю связанная заявка.
   */
  checkedInHandler?: true;
}

const CASES: Case[] = [
  // ── Справочники: чтение нужно всем (форма заявки), ведение — трём ролям ──
  {
    title: 'справочник техники — чтение',
    method: 'GET',
    url: '/api/v1/vehicles',
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator', 'observer'],
  },
  {
    title: 'справочник типов ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-types',
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator', 'observer'],
  },
  {
    // Классификатор (ADR 0028) — тот же справочник, что типы и категории, только одним списком:
    // им заполняется форма заявки, поэтому читать его должны все роли.
    title: 'классификатор ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-classifications',
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator', 'observer'],
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
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator', 'observer'],
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
    allowed: ['admin', 'manager', 'dispatcher', 'operator'],
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

  // ── Заказ ТС: оператору вывоза недоступен целиком (ADR 0010) ──
  {
    title: 'заказ ТС — список',
    method: 'GET',
    url: '/api/v1/vehicle-requests',
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'observer'],
  },
  {
    title: 'заказ ТС — сводка',
    method: 'GET',
    url: '/api/v1/vehicle-requests/summary',
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'observer'],
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
    allowed: ['admin', 'manager', 'dispatcher'],
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
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator', 'observer'],
    checkedInHandler: true,
  },

  // ── Администрирование ──
  { title: 'учётки — список', method: 'GET', url: '/api/v1/users', allowed: ['admin'] },
  { title: 'аудит — журнал', method: 'GET', url: '/api/v1/audit', allowed: ['admin'] },
];

async function request(role: Role | null, c: Case) {
  currentRole = role;
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

describe('доступ по ролям — запреты', () => {
  for (const c of CASES) {
    const denied = ROLES.filter((r) => !c.allowed.includes(r));
    if (denied.length === 0) continue;
    it(`${c.title}: отказ для ${denied.join(', ')}`, async () => {
      for (const role of denied) {
        const res = await request(role, c);
        expect(res.statusCode, `${role} → ${c.method} ${c.url}`).toBe(403);
      }
    });
  }
});

describe('доступ по ролям — разрешения', () => {
  for (const c of CASES) {
    it(`${c.title}: пропускает ${c.allowed.join(', ')}`, async () => {
      for (const role of c.allowed) {
        const res = await request(role, c);
        // Проверка прав пройдена — дальше обработчик упирается в подменённую БД.
        expect(res.statusCode, `${role} → ${c.method} ${c.url}`).not.toBe(403);
        expect(res.statusCode, `${role} → ${c.method} ${c.url}`).not.toBe(401);
      }
    });
  }
});

describe('учётка без роли', () => {
  it('не проходит ни на один маршрут, закрытый правом', async () => {
    for (const c of CASES.filter((x) => !x.checkedInHandler)) {
      const res = await request(null, c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
  });

  it('на маршрутах «по записи» доходит до обработчика — там её не видит ни одна заявка', async () => {
    for (const c of CASES.filter((x) => x.checkedInHandler)) {
      const res = await request(null, c);
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
