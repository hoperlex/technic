import { beforeAll, describe, expect, it } from 'vitest';
import type { RouteOptions } from 'fastify';

/**
 * Страж авторизации: каждый маршрут API обязан объявить, чем он проверяет доступ.
 *
 * Полностью забытая проверка не ломает ни один тест и никак не проявляется в поведении — она
 * просто открывает маршрут всем ролям сразу. Маршруты здесь перечисляет само приложение,
 * поэтому маршрут без `requirePermission` (или без явного `authorizeInHandler` с причиной)
 * роняет тест, а не уезжает в прод (ADR 0021).
 *
 * Чего этот тест НЕ проверяет: что к маршруту привязано правильное право и что проверка внутри
 * обработчика действительно что-то запрещает. Это дело `access-matrix.test.ts` (запросы под
 * каждой ролью) и `file-access.test.ts` (правило доступа к файлу) — страж без них показывает
 * лишь то, что строчка проверки на месте.
 */

/**
 * Маршруты, которые обязаны работать без входа: проверки живости для nginx и сам вход.
 *
 * Сравниваются по пути, а не по паре «метод + путь», и это про смысл списка, а не про удобство:
 * разрешение здесь означает «маршрут открыт целиком». Записи в трёх списках ниже — `PUBLIC_ROUTES`,
 * `SELF_SERVICE_ROUTES`, `INTERNAL_ROUTES` — читаются так же; методами сужен только
 * `COMMON_ROUTES`, где на одном пути живут ручки с разным условием.
 */
const PUBLIC_ROUTES = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
  '/api/v1/auth/register',
  '/api/v1/auth/captcha',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  // Ссылки из писем (ADR 0072): по ним ходит тот, кто ещё не вошёл, — и войти как раз не может.
  // Владение ящиком доказывает одноразовый токен, а запросы письма закрыты капчей и лимитами.
  '/api/v1/auth/verify-email',
  '/api/v1/auth/verify-email/resend',
  '/api/v1/auth/password-reset/request',
  '/api/v1/auth/password-reset/confirm',
]);

/**
 * Внутренние маршруты (ADR 0075): ими планировщик из worker просит API собрать рассылку. Прав у них
 * нет и быть не может — у планировщика нет человека, от чьего имени он действует; доступ закрыт
 * общим секретом `INTERNAL_API_TOKEN`, который обработчик проверяет первым делом, а наружу префикс
 * `/internal/` не проксируется (`deploy/nginx/spa.conf`).
 *
 * Перечислены поимённо намеренно: список из двух строк заметен в ревью, а «пропустить всё под
 * /internal/» однажды прикрыло бы забытую ручку без всякой проверки.
 */
const INTERNAL_ROUTES = new Set([
  '/internal/mail/schedules/due',
  '/internal/mail/runs',
  // Автозакрытие «Решена» → «Закрыта» (Н7): пачку закрывает портал, человека за ручкой нет.
  '/internal/service-requests/auto-close',
]);

/** Маршруты «про себя»: доступны любому вошедшему независимо от роли. */
const SELF_SERVICE_ROUTES = new Set(['/api/v1/auth/me', '/api/v1/auth/change-password']);

/**
 * Маршруты «про сам портал»: тоже без права, но по другой причине. Журнал обновлений (ADR 0077) и
 * список руководств (`docs/manuals-plan.md` §3.2) персональных данных не содержат, а право,
 * закрывающее «что нового в портале» и «как порталом пользоваться», пришлось бы выдать всем — то
 * есть оно не различало бы никого.
 *
 * Строкой в списке, а не молчаливым исключением: каждое «права нет» должно быть видно в ревью
 * рядом с остальными.
 *
 * **Единственный из четырёх списков, который сравнивается по паре «метод + путь».** У руководств по
 * корневому пути живут и чтение, и заведение: строка `/api/v1/manuals` разрешила бы заодно `POST`,
 * и забытый на нём `manuals.manage` перестал бы ловиться — ровно та тихая дыра, ради которой страж
 * и написан. `PATCH` с `DELETE` стоят на `/manuals/:id` и под исключение корневого пути не попали
 * бы, но полагаться на это нельзя: любая следующая ручка по корню — массовая правка порядка,
 * импорт списком — вернула бы дыру молча.
 */
const COMMON_ROUTES = new Set(['GET /api/v1/releases', 'GET /api/v1/manuals']);

interface RouteInfo {
  key: string;
  /** Метод в том виде, в каком его показало приложение: `HEAD` приводится к `GET` ниже. */
  method: string;
  url: string;
  /**
   * Пометки стражей как есть: право из матрицы, `anyOf:<право>|<право>` либо `handler:<причина>`
   * (см. auth/plugin.ts).
   */
  authz: string[];
  requiresLogin: boolean;
}

/**
 * Пометка стража «одно из перечисленных прав» (`auth/plugin.ts`): префикс плюс перечень через `|`.
 * Литералом, как и `handler:` ниже: сверять пометку тем же модулем, который её пишет, значило бы
 * проверять код его собственным утверждением.
 */
const ANY_OF = 'anyOf:';

/**
 * Права, которые страж на самом деле спрашивает: дизъюнкция разворачивается в свои члены.
 *
 * Разворачивать обязательно. Проверки ниже читают пометки как имена прав («модуль закрыт своими
 * правами», «удаление насовсем — под `records.purge`»), и нетронутая пометка `anyOf:…` для них —
 * просто незнакомая строка: маршрут молча выпал бы из-под правила, ради которого оно написано.
 */
function permissionsOf(route: RouteInfo): string[] {
  return route.authz
    .filter((a) => !a.startsWith('handler:'))
    .flatMap((a) => (a.startsWith(ANY_OF) ? a.slice(ANY_OF.length).split('|') : [a]));
}

/**
 * Ключ строки `COMMON_ROUTES`. `HEAD` приводится к `GET`: Fastify заводит его к каждому `GET` сам,
 * и перечислять оба написания значило бы удваивать список ради того, чего никто не регистрировал
 * руками.
 */
function commonKey(r: RouteInfo): string {
  return `${r.method === 'HEAD' ? 'GET' : r.method} ${r.url}`;
}

const routes: RouteInfo[] = [];

/**
 * Корень префикса Fastify заводит в двух написаниях — `/api/v1/releases` и с завершающим слешем
 * (`prefixTrailingSlash`). Списки выше перечисляют путь один раз, поэтому слеш снимаем здесь: иначе
 * маршрут, разрешённый поимённо, вернулся бы в отчёт своим вторым написанием.
 */
function pathOf(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

function handlersOf(route: RouteOptions): Record<string, unknown>[] {
  const pre = route.preHandler;
  if (!pre) return [];
  return (Array.isArray(pre) ? pre : [pre]) as unknown as Record<string, unknown>[];
}

beforeAll(async () => {
  // Конфиг читается из окружения при импорте модуля, поэтому значения ставим до него.
  // Сборка приложения не ходит ни в БД, ни в S3 — маршруты регистрируются оффлайн.
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
  });
  const { buildApp } = await import('../src/app');
  const app = await buildApp({
    onRoute: (route) => {
      const handlers = handlersOf(route);
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        routes.push({
          key: `${method} ${route.url}`,
          method,
          url: pathOf(route.url),
          authz: handlers.flatMap((h) => (h.authz ? [String(h.authz)] : [])),
          // Вход проверяет `authenticate` — единственный страж без пометки authz.
          requiresLogin: handlers.some((h) => !h.authz),
        });
      }
    },
  });
  await app.close();
  /*
   * Тридцать секунд вместо умолчания в десять — не «тест бывает медленным», а мерка выросшего
   * приложения: сборка со всеми маршрутами занимает около восьми секунд транспиляции, и вместе с
   * накладными расходами прогона умолчание пробивается стабильно, а под параллельной нагрузкой —
   * с запасом. Падал при этом не тест, а хук, и падение читалось как поломка манифеста, хотя ни
   * одного факта о маршрутах проверить не успевали.
   */
}, 30_000);

describe('авторизация маршрутов', () => {
  it('маршруты собраны из приложения, а не перечислены в тесте', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('каждый маршрут либо публичный, либо проверяет право', () => {
    const unguarded = routes
      .filter(
        (r) =>
          !PUBLIC_ROUTES.has(r.url) &&
          !SELF_SERVICE_ROUTES.has(r.url) &&
          !COMMON_ROUTES.has(commonKey(r)) &&
          !INTERNAL_ROUTES.has(r.url),
      )
      .filter((r) => r.authz.length === 0)
      .map((r) => r.key);
    expect(unguarded).toEqual([]);
  });

  it('непубличные маршруты требуют входа', () => {
    const anonymous = routes
      .filter((r) => !PUBLIC_ROUTES.has(r.url) && !INTERNAL_ROUTES.has(r.url))
      .filter((r) => !r.requiresLogin)
      .map((r) => r.key);
    expect(anonymous).toEqual([]);
  });

  /**
   * Проверка самого сужения списка методами: чтение руководств стоит без права намеренно, а запись
   * по тому же пути обязана остаться под `manuals.manage`. До перехода на пары «метод + путь» одна
   * строка `/api/v1/manuals` покрывала бы оба маршрута сразу.
   */
  it('список без права сужен методом: запись по тому же пути осталась в проверке', () => {
    const manuals = routes.filter((r) => r.url.startsWith('/api/v1/manuals'));
    expect(manuals.length).toBeGreaterThan(0);
    for (const route of manuals) {
      const openByList = COMMON_ROUTES.has(commonKey(route));
      // `GET` (и заведённый к нему Fastify `HEAD`) — в списке и без пометки права; всё остальное —
      // наоборот. Ни один маршрут не может оказаться сразу в списке и под правом.
      expect(openByList, route.key).toBe(route.method === 'GET' || route.method === 'HEAD');
      expect(permissionsOf(route), route.key).toEqual(openByList ? [] : ['manuals.manage']);
    }
  });

  it('доступ «по самой записи, а не по роли» оставлен только файлам', () => {
    const inHandler = routes
      .filter((r) => r.authz.some((a) => a.startsWith('handler:')))
      .map((r) => r.url);
    expect(inHandler.length).toBeGreaterThan(0);
    for (const url of inHandler) expect(url.startsWith('/api/v1/files')).toBe(true);
  });

  it('модуль «Вывоз мусора» закрыт правами, а не запретами для отдельных ролей', () => {
    const waste = routes.filter((r) => r.url.startsWith('/api/v1/waste-requests'));
    expect(waste.length).toBeGreaterThan(0);
    for (const route of waste) {
      expect(
        permissionsOf(route).every(
          (a) =>
            a.startsWith('wasteRequests.') ||
            a.startsWith('archive.') ||
            // Удаление насовсем — общее действие над архивом, а не право модуля (ADR 0070):
            // заявки сносит тот же `records.purge`, что и записи справочников.
            a === 'records.purge',
        ),
      ).toBe(true);
    }
  });

  /**
   * Удаление насовсем (ADR 0060) — единственное действие над справочником, которое не отменить.
   * Ведут справочники менеджер и диспетчер (`directories.write`), а сносить записи может только
   * администратор, и разница между двумя правами здесь — вся защита. Маршруты собраны из
   * приложения, поэтому очередной справочник, закрытый не тем правом, роняет тест.
   */
  it('окончательное удаление закрыто правом `records.purge`', () => {
    const purge = routes.filter((r) => r.url.endsWith('/purge'));
    expect(purge.length).toBeGreaterThan(0);
    for (const route of purge) expect(permissionsOf(route)).toContain('records.purge');
  });

  /**
   * Страж «одно из перечисленных прав» открывает ручку двум сторонам сразу, и оставлен он ровно
   * там, где сторон действительно две: у ходов исполнителя заявки на обслуживание (план
   * переработки цикла §7.3). Инвариант тот же, что у доступа «по самой записи» выше: дизъюнкция,
   * приписанная соседнему маршруту, — это удвоенный круг допущенных, и заметить её иначе можно
   * только в бою.
   *
   * Какая пара прав стоит на каждой ручке, здесь не проверяется: это ожидание живёт в манифесте
   * (`access-manifest.test.ts`), а тут — только место и форма пометки.
   */
  it('страж «одно из прав» оставлен ходам исполнителя заявок на обслуживание', () => {
    const disjunctive = routes.filter((r) => r.authz.some((a) => a.startsWith(ANY_OF)));
    expect(disjunctive.length).toBeGreaterThan(0);
    for (const route of disjunctive) {
      expect(route.url.startsWith('/api/v1/service-requests/'), route.key).toBe(true);
      // Один страж на маршрут: два «одного из прав» подряд — это уже конъюнкция дизъюнкций,
      // которую манифест не выражает, а ревьюер не прочитает.
      expect(route.authz.filter((a) => a.startsWith(ANY_OF)).length, route.key).toBe(1);
      // Пометка обязана называть права: перечень из одного члена — обычное `requirePermission`,
      // записанное так, что сверка с манифестом перестала бы отличать выбор от единственного права.
      expect(permissionsOf(route).length, route.key).toBeGreaterThan(1);
    }
  });
});
