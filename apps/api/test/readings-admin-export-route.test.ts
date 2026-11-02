import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Permission, Role } from '@technic/contracts';

/**
 * Who may download the readings report (ADR 0240).
 *
 * The report is company-wide by construction: rows are every vehicle request by day. So beyond the
 * route's permissions (swept in `access-conditions.test.ts`), the handler refuses a principal whose
 * role stands on any area axis — object, department, counterparty — even when a grant gave them
 * every permission the route asks for. A cut-down book would differ between two people for the
 * same period with no word about why.
 *
 * The database and the book builder are mocked: this file checks the door, not the book.
 */

const state = vi.hoisted(() => ({
  role: 'dispatcher' as Role,
  grants: [] as Permission[],
  built: 0,
}));

vi.mock('../src/db/client', () => {
  const fail = () => Promise.reject(new Error('unexpected database call'));
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) =>
              reject(new Error('unexpected database call'))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: 'user-1', role: state.role, av: 1 }),
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
    phone: '',
    role: state.role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: ['11111111-1111-4111-8111-111111111111'],
    departmentIds: ['55555555-5555-4555-8555-555555555555'],
    departmentObjectIds: [],
    counterpartyId: '22222222-2222-4222-8222-222222222222',
    counterpartyType: null,
    personId: null,
    grantCodes: [],
    grantPermissions: [...state.grants],
    addons: [],
    authVersion: 1,
  }),
}));

vi.mock('../src/services/readings-admin-export', () => ({
  buildAdminReadingsExport: async () => {
    state.built += 1;
    return { filename: 'Показания автотранспорта 01.10.2026.xlsx', bytes: new Uint8Array([1]) };
  },
}));

const FULL: Permission[] = [
  'vehicleReadings.export',
  'vehicleReadings.read',
  'vehicleRequests.read',
];
const URL = '/api/v1/vehicle-readings/admin-export?from=2026-10-01&to=2026-10-01';

let app: FastifyInstance;
let requestNo = 0;

async function download(role: Role, grants: Permission[]) {
  state.role = role;
  state.grants = grants;
  requestNo += 1;
  return app.inject({
    method: 'GET',
    url: URL,
    remoteAddress: `10.2.0.${requestNo}`,
    headers: { authorization: 'Bearer test-token' },
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
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('readings report: the area of the principal', () => {
  it.each([
    ['shtab', 'объекты строительства'],
    ['department', 'отделы'],
    ['operator', 'контрагент'],
  ] as const)(
    'refuses a %s principal even with every permission of the route',
    async (role, axis) => {
      const before = state.built;
      const res = await download(role, FULL);

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toBe(
        `Выгрузка сводит все площадки; у вашей учётки область ограничена (${axis})`,
      );
      // The refusal comes before the book: nothing is read for a principal who gets nothing.
      expect(state.built).toBe(before);
    },
  );

  it('lets a principal without an area axis download the book', async () => {
    const res = await download('dispatcher', ['vehicleReadings.export']);

    expect(res.statusCode, res.payload.slice(0, 200)).toBe(200);
    expect(res.headers['content-disposition']).toContain('.xlsx');
  });
});
