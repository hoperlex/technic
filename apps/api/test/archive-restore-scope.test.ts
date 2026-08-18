import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// Только тип: сам модуль импортируется уже после того, как выставлено окружение, — конфиг
// проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import {
  ADMIN_GRANTS,
  ROLES,
  ROLE_PERMISSIONS,
  roleScopeAxis,
  type CounterpartyType,
  type Permission,
  type Role,
} from '@technic/contracts';
import {
  assertLessorScope,
  assertOfficeEquipmentScope,
  assertOperatorScope,
  assertRequestScope,
  assertServiceRequestScope,
  assertWasteObjectScope,
} from '../src/lib/access';
import type { Principal } from '../src/auth/principal';

/**
 * Область у возврата записи из архива (ADR 0021, ADR 0106).
 *
 * Ручек возврата семь, и все они закрыты одним правом `archive.restore`. Долгое время это было
 * **единственным** условием: обработчик поднимал строку по id и снимал `deleted_at`, не спрашивая,
 * чья она. Дверь держала не проверка, а клетка матрицы выдачи (`GRANT_SCOPE_MATRIX.records`
 * запрещает права модуля ролям с осью) — то есть решение о составе наборов, а не устройство ручки.
 * Поменяй клетку однажды, и семь ручек молча отдали бы чужие записи.
 *
 * Здесь проверен второй слой: там, где у сущности область есть, возврат спрашивает её теми же
 * функциями, что карточка и правка. У контрагентов, техники и учёток области нет ни у одного
 * действия их модулей — проверять там нечего, и эти три ручки в файле не участвуют намеренно.
 *
 * Субъект собирается напрямую, без учётки в базе: сегодня роли с осью право возврата не получают
 * никаким способом, и дождаться отказа от настоящего профиля нельзя — а проверять надо ровно то,
 * что случится, когда такой профиль появится. БД подменена: сценарий доходит до проверки области и
 * дальше не идёт, а положительный случай останавливается на первой же настоящей работе с базой —
 * поэтому от него и требуется «не 403», а не конкретный успешный ответ (тот же приём в
 * `access-conditions.test.ts`). Настоящий 200 под администратором доказывают тесты на живой схеме:
 * `request-archive.db.test.ts` и `service-request-flow.db.test.ts`.
 */

/** Валидные UUID: схема маршрута проверяется до стража, и на кривом id пришло бы 400. */
const RECORD_ID = '11111111-1111-4111-8111-111111111111';
/** Реквизиты **строки**: объект, отдел и контрагент, которыми размечена запись в архиве. */
const ROW_OBJECT = '22222222-2222-4222-8222-222222222222';
const ROW_DEPARTMENT = '33333333-3333-4333-8333-333333333333';
const ROW_COUNTERPARTY = '44444444-4444-4444-8444-444444444444';
/** Реквизиты **субъекта** в отрицательных случаях: заведомо не те, что у строки. */
const OTHER_OBJECT = '55555555-5555-4555-8555-555555555555';
const OTHER_COUNTERPARTY = '66666666-6666-4666-8666-666666666666';
const OTHER_DEPARTMENT = '77777777-7777-4777-8777-777777777777';
/** Момент удаления заготовленных строк: восстанавливают запись, у которой он проставлен. */
const DELETED_AT = new Date('2026-08-01T10:00:00.000Z');

/**
 * Состояние подмен: субъект текущего запроса и строки, которые «лежат в базе». Строки заведены
 * **удалёнными** — восстанавливают именно такие, и проверка области обязана работать на них.
 */
const state = vi.hoisted(() => {
  const id = '11111111-1111-4111-8111-111111111111';
  const objectId = '22222222-2222-4222-8222-222222222222';
  const departmentId = '33333333-3333-4333-8333-333333333333';
  const counterpartyId = '44444444-4444-4444-8444-444444444444';
  const deletedAt = new Date('2026-08-01T10:00:00.000Z');
  return {
    subject: {
      role: 'admin' as Role | null,
      counterpartyType: null as CounterpartyType | null,
      counterpartyId: null as string | null,
      constructionObjectIds: [] as string[],
      departmentIds: [] as string[],
      grantPermissions: [] as string[],
    },
    /**
     * Ключ — имя таблицы в БД: подмена не разбирает условий запроса и отвечает по первой таблице
     * `from`. Реквизиты у строк только те, что читает область; остального обработчику уже не
     * нужно — до него отрицательный сценарий не доходит.
     */
    rows: {
      waste_requests: [
        { id, objectId, operatorCounterpartyId: counterpartyId, status: 'confirmed', deletedAt },
      ],
      vehicle_requests: [
        { id, objectId, departmentId: null, status: 'confirmed', version: 1, deletedAt },
      ],
      // Арендодатель заказа ТС приходит с назначенной машины: своей колонки у заявки нет.
      vehicle_request_assignments: [{ lessorId: counterpartyId }],
      service_requests: [
        {
          id,
          officeEquipmentId: '88888888-8888-4888-8888-888888888888',
          equipmentObjectId: objectId,
          customerDepartmentId: departmentId,
          equipmentDepartmentId: departmentId,
          serviceCounterpartyId: counterpartyId,
          status: 'new',
          version: 1,
          deletedAt,
        },
      ],
      office_equipment: [
        {
          id,
          objectId,
          ownerDepartmentId: departmentId,
          serialNumber: 'SN-1',
          inventoryNumber: 'ИНВ-1',
          deletedAt,
        },
      ],
    } as Record<string, unknown[]>,
  };
});

/**
 * БД подменена цепочкой, отвечающей заготовленными строками по имени таблицы в `from`. Условия
 * запроса не разбираются: сценарию нужен один ответ — «строка с такими реквизитами есть», — а
 * дальше проверки области отрицательный случай не уходит.
 */
vi.mock('../src/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  /** Шаг цепочки drizzle: его и продолжают (`.where`, `.set`, `.innerJoin`), и ждут (`await`). */
  const chain = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop): unknown =>
          prop === 'then'
            ? (ok: (v: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
                Promise.resolve(rows).then(ok, fail)
            : () => chain(rows),
      },
    );
  const rowsOf = (table: unknown): unknown[] => state.rows[getTableName(table as never)] ?? [];
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: unknown) => chain(rowsOf(table)) }),
    update: (table: unknown) => chain(rowsOf(table)),
    insert: () => chain([]),
    delete: () => chain([]),
    // Транзакция отдаёт тот же клиент: возврат оргтехники и заявки на обслуживание идёт через `tx`.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async () => ({ rows: [] }),
  };
  return { db, pingDb: async () => {}, pool: { end: async () => {} } };
});

// Вход подменён: проверяется область, а не механика токенов.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: 'user-1', role: state.subject.role, av: 1 }),
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
    role: state.subject.role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: state.subject.constructionObjectIds,
    departmentIds: state.subject.departmentIds,
    departmentObjectIds: state.subject.constructionObjectIds,
    counterpartyId: state.subject.counterpartyId,
    counterpartyType: state.subject.counterpartyType,
    personId: null,
    grantCodes: [],
    /*
     * Право приходит назначенным полномочием (ADR 0106) — единственным источником, который
     * выражает произвольный набор. Роль своего набора не меняет, и «штаб с `archive.restore`»
     * собирается только так: сегодня матрица выдачи такую пару запрещает, а поменяют клетку —
     * ручка обязана держать удар сама.
     */
    grantPermissions: [...state.subject.grantPermissions],
    addons: [],
    authVersion: 1,
  }),
}));

let app: Awaited<ReturnType<typeof buildApp>>;

/** Каждый запрос со своего адреса: защита от подбора считает по IP, а тест проверяет не её. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Модули, у сущности которых область есть; остальные три ручки возврата её не имеют вовсе. */
const SCOPED_MODULES = [
  'waste-requests',
  'vehicle-requests',
  'service-requests',
  'office-equipment',
] as const;

interface Subject {
  role: Role;
  counterpartyType?: CounterpartyType;
  counterpartyId?: string;
  constructionObjectIds?: string[];
  departmentIds?: string[];
}

/** Возврат из архива субъектом с правом и заданной осью — собранным напрямую, без учётки в базе. */
async function restore(module: string, subject: Subject) {
  state.subject = {
    role: subject.role,
    counterpartyType: subject.counterpartyType ?? null,
    counterpartyId: subject.counterpartyId ?? null,
    constructionObjectIds: subject.constructionObjectIds ?? [],
    departmentIds: subject.departmentIds ?? [],
    // Пара целиком: `archive.restore` без `archive.read` — возврат вслепую, и наборы её не разводят.
    grantPermissions: ['archive.read', 'archive.restore'],
  };
  return app.inject({
    method: 'POST',
    url: `/api/v1/${module}/${RECORD_ID}/restore`,
    remoteAddress: nextAddress(),
    headers: { authorization: 'Bearer test-token' },
    payload: {},
  });
}

/** Переводит заготовленные строки в архив и обратно: у ручки возврата два входа, и оба проверяются. */
function setDeleted(deletedAt: Date | null): void {
  for (const rows of Object.values(state.rows)) {
    for (const row of rows) {
      if ('deletedAt' in (row as object)) (row as { deletedAt: Date | null }).deletedAt = deletedAt;
    }
  }
}

function messageOf(res: { body: string }): string {
  try {
    return String((JSON.parse(res.body) as { message?: unknown }).message ?? '');
  } catch {
    return '';
  }
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
  // Своя граница времени: на холодном кеше трансформация приложения занимает больше десяти секунд.
}, 60_000);

afterAll(async () => {
  await app?.close();
});

/**
 * Отказ по области у каждой ручки, у которой область есть. Ось берётся та, которой сущность
 * действительно размечена, и на каждой оси — своя проверка: перепутай их местами, и «отказ есть»
 * означало бы, что сработала соседняя.
 */
describe('возврат из архива спрашивает область', () => {
  const onObject = (role: Role): Subject => ({ role, constructionObjectIds: [OTHER_OBJECT] });
  const asCounterparty = (counterpartyType: CounterpartyType): Subject => ({
    role: 'operator',
    counterpartyType,
    counterpartyId: OTHER_COUNTERPARTY,
  });

  const cases: { title: string; module: string; subject: Subject; refusal: string }[] = [
    {
      title: 'вывоз мусора — чужой объект',
      module: 'waste-requests',
      subject: onObject('shtab'),
      refusal: 'работает только со своими объектами',
    },
    {
      title: 'вывоз мусора — чужой оператор',
      module: 'waste-requests',
      subject: asCounterparty('operator'),
      refusal: 'Оператор работает только с заявками своего контрагента',
    },
    {
      title: 'заказ ТС — чужой объект',
      module: 'vehicle-requests',
      subject: onObject('shtab'),
      refusal: 'работает только со своими объектами',
    },
    {
      title: 'заказ ТС — на заявке техника чужого арендодателя',
      module: 'vehicle-requests',
      subject: asCounterparty('vehicle_lessor'),
      refusal: 'Арендодатель работает только с заявками',
    },
    {
      title: 'обслуживание оргтехники — чужой объект',
      module: 'service-requests',
      subject: onObject('shtab'),
      refusal: 'работает только со своими объектами',
    },
    {
      title: 'обслуживание оргтехники — заявка назначена чужому сервису',
      module: 'service-requests',
      subject: asCounterparty('service'),
      refusal: 'Сервисная компания работает только с назначенными ей заявками',
    },
    {
      title: 'справочник оргтехники — чужой объект',
      module: 'office-equipment',
      subject: onObject('shtab'),
      refusal: 'работает только со своими объектами',
    },
  ];

  for (const c of cases) {
    it(`${c.title} — 403`, async () => {
      const res = await restore(c.module, c.subject);
      expect(res.statusCode, res.body).toBe(403);
      // Текст сверяется затем, что 403 умеет отвечать и страж права: без сверки тест доказывал бы
      // работу отказа, к области отношения не имеющего.
      expect(messageOf(res)).toContain(c.refusal);
    });
  }

  it('живая запись закрыта тем же условием — возврат отдаёт её карточку целиком', async () => {
    /*
     * Возврат идемпотентен: живая запись просто отдаётся — повтор запроса при потерянном ответе
     * обычное дело. Отсюда требование к порядку: область спрашивается **до** разбора «удалена ли
     * строка», иначе `archive.restore` работал бы читалкой чужих живых записей в обход прав их
     * модулей. Проверять надо именно живую строку: на удалённой отказ пришёл бы и при позднем
     * порядке.
     */
    setDeleted(null);
    try {
      for (const module of SCOPED_MODULES) {
        const res = await restore(module, {
          role: 'shtab',
          constructionObjectIds: [OTHER_OBJECT],
        });
        expect(res.statusCode, `${module}: ${res.body}`).toBe(403);
        expect(messageOf(res)).toContain('работает только со своими объектами');
      }
    } finally {
      setDeleted(DELETED_AT);
    }
  });

  it('своя запись отказа не получает — ось совпала', async () => {
    // Тот же субъект и та же строка, но объект теперь его: отказ обязан исчезнуть, иначе случаи
    // выше доказывали бы не область, а нечто, отказывающее всем подряд.
    for (const module of SCOPED_MODULES) {
      const res = await restore(module, { role: 'shtab', constructionObjectIds: [ROW_OBJECT] });
      expect(res.statusCode, `${module}: ${res.body}`).not.toBe(403);
    }
  });

  it('держатель права без оси проходит область насквозь', async () => {
    // Диспетчер с набором «Архивариус» — единственный, кому право сегодня достаётся сверх роли
    // администратора. Своей оси у него нет, ни одна проверка на нём не срабатывает; чем ответит
    // обработчик дальше — не наше дело, БД подменена.
    for (const module of SCOPED_MODULES) {
      const res = await restore(module, { role: 'dispatcher' });
      expect(res.statusCode, `${module}: ${res.body}`).not.toBe(403);
    }
  });
});

/**
 * Доказательство того, что сегодняшнее поведение не изменилось, — механическое, а не рассуждением:
 * перебором всех держателей права, а не перечислением тех, кого вспомнили.
 */
describe('сегодняшние держатели `archive.restore` области не имеют', () => {
  /** Роли, получающие право ролью либо любым набором каталога, — вместе. */
  const holders = (): Role[] => {
    const byRole = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('archive.restore'));
    const byGrant = Object.values(ADMIN_GRANTS)
      .filter((g) => (g.permissions as readonly Permission[]).includes('archive.restore'))
      .flatMap((g) => g.roles as readonly Role[]);
    return [...new Set([...byRole, ...byGrant])];
  };

  it('перебор находит и роль, и набор', () => {
    // Пустой перебор доказал бы что угодно: перестань право выдаваться вовсе — проверки ниже
    // обязаны упасть, а не позеленеть на пустом списке.
    expect(holders()).toContain('admin');
    expect(holders().length).toBeGreaterThan(1);
  });

  it('ни у одного держателя нет оси области', () => {
    expect(holders().filter((r) => roleScopeAxis(r) !== 'none')).toEqual([]);
  });

  it('на каждом держателе все шесть проверок молчат — на заведомо чужой строке', () => {
    // Прямой ответ на «не сломает ли новая проверка сегодняшний возврат»: функции зовутся теми же
    // реквизитами, что в обработчиках, и с чужими значениями на всех осях сразу.
    for (const role of holders()) {
      const p: Principal = {
        id: 'user-1',
        email: 'user@test.local',
        lastName: 'Пользователь',
        firstName: 'Тестовый',
        middleName: '',
        fullName: 'Пользователь Тестовый',
        phone: '',
        role,
        isActive: true,
        mustChangePassword: false,
        constructionObjectIds: [OTHER_OBJECT],
        departmentIds: [OTHER_DEPARTMENT],
        departmentObjectIds: [OTHER_OBJECT],
        counterpartyId: OTHER_COUNTERPARTY,
        counterpartyType: null,
        personId: null,
        grantCodes: [],
        grantPermissions: ['archive.read', 'archive.restore'],
        addons: [],
        authVersion: 1,
      };
      expect(() => {
        assertWasteObjectScope(p, ROW_OBJECT);
        assertOperatorScope(p, ROW_COUNTERPARTY);
        assertRequestScope(p, { objectId: ROW_OBJECT, departmentId: ROW_DEPARTMENT });
        assertLessorScope(p, ROW_COUNTERPARTY);
        assertServiceRequestScope(p, {
          objectId: ROW_OBJECT,
          customerDepartmentId: ROW_DEPARTMENT,
          equipmentDepartmentId: ROW_DEPARTMENT,
        });
        assertOfficeEquipmentScope(p, {
          objectId: ROW_OBJECT,
          ownerDepartmentId: ROW_DEPARTMENT,
        });
      }, role).not.toThrow();
    }
  });
});
