import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SERVICE_ACCESS_MANIFEST,
  SERVICE_SIDES,
  type ServiceRouteAccess,
  type ServiceSide,
} from '../src/lib/service-access-manifest';

/**
 * Сверка манифеста области и стороны (`src/lib/service-access-manifest.ts`) с фактом: у каждой
 * ручки модуля заявок на обслуживание есть строка манифеста, у каждой строки — ручка, «область не
 * спрашивается» объяснено словами, а объявленная область совпадает с тем, что делает обработчик.
 *
 * Приём тот же, что у манифеста прав (`access-manifest.test.ts`): ожидание пишут и ревьюят руками,
 * факт снимается с СОБРАННОГО приложения через `onRoute`. Перечислять маршруты в самом тесте
 * нельзя по той же причине, что и там: перечень, писанный руками с обеих сторон, сойдётся сам с
 * собой и промолчит ровно про новый маршрут, который забыли закрыть.
 *
 * ЧЕГО ЭТОТ ТЕСТ НЕ ДЕЛАЕТ: не ходит по маршрутам запросами. «Чужая заявка → 403/404, своя, но
 * чужая сторона → 403» — прогон живым субъектом, он требует базы и принадлежит этапу Э2 плана
 * `docs/office-equipment-executor-access-audit-plan.md`. Здесь доказывается только полнота и
 * согласованность декларации; `side` и `state` до Э2 остаются объявлением для ревьюера.
 *
 * ПОЧЕМУ ФАКТ ОБЛАСТИ СНИМАЕТСЯ РАЗБОРОМ ИСХОДНИКА, А НЕ ПОМЕТКОЙ НА МАРШРУТЕ. Пометки у области
 * нет вовсе: `requireEditable` зовут из тела обработчика, а не вешают стражем в `preHandler`, и
 * снять её с собранного приложения нечем. Заведи мы такую пометку ради теста — проверяли бы код
 * его же собственным утверждением (та же ловушка, что описана в шапке `access-manifest.test.ts`).
 * Грубый разбор текста от этого свободен: он видит ВЫЗОВ, а не заявление о нём.
 *
 * ПОЧЕМУ РАЗБОР СВОЙ, А НЕ ИНВЕНТАРЬ Э0 (`scripts/service-access-inventory.ts`). Тот отвечает на
 * вопрос «какие из НАЗВАННЫХ проверок встречаются в ручке» и перечисляет входы ПО СТРОКЕ заявки;
 * здесь вопрос один и другой — «спрашивается ли область вообще», и у заведения (`POST /`) строки
 * ещё нет: область у него спрашивает `assertServiceRequestScope` внутри `resolveRequestSubject`,
 * которого в перечне Э0 нет и быть не должно. Перечни маркеров у двух разборов поэтому разные, и
 * сведи мы их в один — пришлось бы либо объявить заведение беспризорным, либо размыть вопрос,
 * ради которого Э0 и заведён.
 */

/** Оба префикса модуля: внешние ручки и внутренняя ручка планировщика. */
const MODULE_PREFIXES = ['/api/v1/service-requests', '/internal/service-requests'] as const;

function isModuleUrl(url: string): boolean {
  return MODULE_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

/**
 * Корень префикса Fastify заводит в двух написаниях — с завершающим слешем и без
 * (`prefixTrailingSlash`). Манифест перечисляет путь один раз, поэтому слеш снимаем здесь.
 */
function pathOf(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

const factKeys: string[] = [];

/**
 * Сборка приложения на холодном кэше трансформации занимает у vitest больше десяти секунд по
 * умолчанию — регистрируются все маршруты портала, а не одни наши. Срок назван явно: прогон,
 * падающий от занятости машины, разучивает читать собственные падения.
 */
const BUILD_TIMEOUT_MS = 60_000;

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
  const seen = new Set<string>();
  const { buildApp } = await import('../src/app');
  const app = await buildApp({
    onRoute: (route) => {
      const url = pathOf(route.url);
      if (!isModuleUrl(url)) return;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // `HEAD` Fastify заводит к каждому `GET` сам: область у него та же, а строка удвоила бы
        // манифест.
        if (method === 'HEAD') continue;
        const key = `${method} ${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        factKeys.push(key);
      }
    },
  });
  await app.close();
}, BUILD_TIMEOUT_MS);

const manifest = SERVICE_ACCESS_MANIFEST as Record<string, ServiceRouteAccess>;

// ── Статический разбор файла маршрутов ──

const ROUTES_FILE = 'src/routes/service-requests.ts';
const routesSource = readFileSync(
  fileURLToPath(new URL(`../${ROUTES_FILE}`, import.meta.url)),
  'utf8',
);

/**
 * Вызовы, каждый из которых означает «ручка спрашивает область заявки»:
 *
 *   · `requireEditable` — живая заявка в области субъекта, общий вход изменяющих ручек;
 *   · `assertScope` — обе оси области по строке (заказчик и назначенный исполнитель);
 *   · `visibility` — тот же вопрос предикатом ВЫБОРКИ, для списков и счётчиков;
 *   · `listWhere` — отбор списка, внутри которого стоит та же `visibility`;
 *   · `resolveRequestSubject` — заведение: заявки ещё нет, и область спрашивается по её предмету
 *     (`assertServiceRequestScope` внутри).
 *
 * Две последние — косвенные, и это осознанно: правило «спрашивает ли ручка область» обязано
 * отвечать одинаково там, где вызов стоит в теле, и там, где он спрятан на уровень ниже. Разъедься
 * этот перечень с кодом — тест упадёт на первой же ручке, а не промолчит: он сверяет ДВЕ стороны.
 */
const SCOPE_MARKERS = [
  'requireEditable',
  'assertScope',
  'visibility',
  'listWhere',
  'resolveRequestSubject',
] as const;

/**
 * Комментарии убираются перед разбором, иначе упоминание `assertScope` в соседнем абзаце объявило
 * бы область у ручки, которая её не спрашивает. Разбор грубый (не AST), и этого довольно: файл
 * маршрутов написан одним стилем, а ошибка разбора роняет прогон, а не проходит молча.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) =>
      /^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/(^|[^:])\/\/.*$/, (_m, head: string) => head),
    )
    .join('\n');
}

interface SourceRoute {
  key: string;
  /** Нашлись ли в теле ручки вызовы, спрашивающие область. */
  asksScope: boolean;
  /** Какие именно — для внятного текста расхождения. */
  markers: string[];
}

/**
 * Ручки файла с границами «от одной регистрации `r.<метод>(` до следующей». Границы грубые: в
 * последний кусок попадают и объявленные рядом помощники. Поэтому строки с `function имя(`
 * отбрасываются — иначе объявление `resolveRequestSubject` считалось бы его же вызовом.
 */
function sourceRoutes(): SourceRoute[] {
  const lines = stripComments(routesSource).split('\n');
  const starts: { line: number; method: string; path: string | null }[] = [];
  lines.forEach((line, index) => {
    const match = /^\s{0,4}r\.(get|post|put|patch|delete)\(\s*(?:'([^']*)')?/.exec(line);
    if (match) {
      starts.push({ line: index, method: match[1]!.toUpperCase(), path: match[2] ?? null });
    }
  });
  return starts.map((start, index) => {
    // Путь бывает на той же строке (`r.get('/:id', ...)`) и на следующей — у ручек, разбитых
    // форматтером по аргументам.
    const path = start.path ?? /'([^']*)'/.exec(lines[start.line + 1] ?? '')?.[1] ?? '';
    const end = starts[index + 1]?.line ?? lines.length;
    const body = lines
      .slice(start.line, end)
      .filter((line) => !/\bfunction\s+\w+\s*\(/.test(line))
      .join('\n');
    const markers = SCOPE_MARKERS.filter((marker) =>
      new RegExp(`\\b${marker}\\(`).test(body),
    ) as string[];
    return {
      key: `${start.method} ${pathOf(`${MODULE_PREFIXES[0]}${path}`)}`,
      asksScope: markers.length > 0,
      markers,
    };
  });
}

const parsed = sourceRoutes();

/**
 * Ручки модуля, которых в разбираемом файле нет: удаление насовсем заводит общая
 * `registerPurgeRoute`, а автозакрытие живёт в `routes/internal-service-requests.ts`. Список
 * поимённый, а не «чего не нашли, то и пропустим»: ручка, уехавшая из файла маршрутов, обязана
 * попасть в ревью, а не тихо выпасть из статической сверки.
 */
const OUTSIDE_ROUTES_FILE = [
  'DELETE /api/v1/service-requests/:id/purge',
  'POST /internal/service-requests/auto-close',
];

describe('манифест области и стороны заявок на обслуживание', () => {
  it('ручки модуля сняты с приложения, а не перечислены в тесте', () => {
    // Тридцать с лишним — порядок величины карты §2.2 плана; точное число живёт в манифесте, и
    // сверять его вторым перечнем значило бы завести третью сторону, которую тоже забудут.
    expect(factKeys.length).toBeGreaterThan(30);
  });

  it('у каждой ручки модуля есть строка манифеста', () => {
    const missing = factKeys.filter((key) => !(key in manifest));
    expect(missing, 'новая ручка модуля без строки манифеста области и стороны').toEqual([]);
  });

  it('в манифесте нет строк для ручек, которых больше нет', () => {
    const live = new Set(factKeys);
    const stale = Object.keys(manifest).filter((key) => !live.has(key));
    expect(stale, 'строка манифеста без маршрута').toEqual([]);
  });

  /**
   * «Область не спрашивается» — это всегда либо решение, либо находка, и молчащей такая строка быть
   * не должна. Тип уже требует поля `why`; здесь проверяется, что оно не пустое, а перечень таких
   * ручек — поимённый: четвёртая обязана попасть в ревью, а не приехать вместе с правкой соседней.
   */
  it('каждая строка `scope: none` объясняет, почему области нет', () => {
    const none = Object.entries(manifest).filter(([, row]) => row.scope === 'none');
    expect(none.map(([key]) => key).sort()).toEqual([
      'DELETE /api/v1/service-requests/:id/purge',
      'POST /internal/service-requests/auto-close',
    ]);
    const silent = none
      .filter(([, row]) => row.scope === 'none' && row.why.trim().length === 0)
      .map(([key]) => key);
    expect(silent, 'область не спрашивается, а почему — не сказано').toEqual([]);
  });

  it('разбор файла маршрутов нашёл ручки, а не пустоту', () => {
    // Страховка от тихой поломки самого разбора: смени файл стиль регистрации — сверка ниже стала
    // бы пустой и зелёной, то есть перестала бы что-либо доказывать.
    expect(parsed.length).toBeGreaterThan(30);
    expect(parsed.filter((route) => route.asksScope).length).toBeGreaterThan(30);
  });

  it('разобранные ручки — те же, что у приложения, кроме двух заведённых снаружи', () => {
    const live = new Set(factKeys);
    const unknown = parsed.map((route) => route.key).filter((key) => !live.has(key));
    expect(unknown, 'разбор выдумал ручку, которой в приложении нет').toEqual([]);
    const parsedKeys = new Set(parsed.map((route) => route.key));
    const outside = factKeys.filter((key) => !parsedKeys.has(key)).sort();
    expect(outside, `ручка модуля мимо ${ROUTES_FILE}`).toEqual([...OUTSIDE_ROUTES_FILE].sort());
  });

  /**
   * Главная проверка этапа: объявленная область совпадает с фактом. Обе стороны, а не одна, — иначе
   * `scope: 'none'`, приписанное ручке, которая область всё-таки спрашивает, читалось бы как
   * находка там, где её нет, а `'visibility'` у ручки без единой проверки — как доказательство.
   */
  it('объявленная область совпадает с фактом обработчика', () => {
    const mismatched: string[] = [];
    for (const route of parsed) {
      const row = manifest[route.key];
      if (!row) continue; // отсутствие строки — отдельная проверка выше
      if (row.scope === 'visibility' && !route.asksScope) {
        mismatched.push(`${route.key}: манифест — visibility, а в теле ручки области нет`);
      }
      if (row.scope === 'none' && route.asksScope) {
        mismatched.push(
          `${route.key}: манифест — none, а в теле ручки ${route.markers.join(', ')}`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('ручки, заведённые снаружи файла маршрутов, объявлены без области', () => {
    // Разбором их не проверить, поэтому декларация сверяется с тем, что про них известно: у обеих
    // области нет — общая ручка удаления насовсем её не спрашивает ни в одном модуле, а у
    // системного субъекта её не бывает.
    for (const key of OUTSIDE_ROUTES_FILE) {
      expect(manifest[key]?.scope, key).toBe('none');
    }
  });

  it('сторон пять, все перечислены реестром и все применены', () => {
    expect([...SERVICE_SIDES].sort()).toEqual([
      'any',
      'assigner',
      'customer',
      'executor',
      'operator',
    ]);
    const used = new Set<ServiceSide>(Object.values(manifest).map((row) => row.side));
    const unknown = [...used].filter(
      (side) => !(SERVICE_SIDES as readonly string[]).includes(side),
    );
    expect(unknown, 'сторона из манифеста не названа реестром').toEqual([]);
    // Реестр не копилка: сторона, которой нет ни у одной ручки, — либо забытая, либо больше не
    // нужная.
    const idle = SERVICE_SIDES.filter((side) => !used.has(side));
    expect(idle, 'сторона заведена, но не применена ни одной ручкой').toEqual([]);
  });

  /**
   * Находка Н2 была зафиксирована строкой, а не только словами в плане: подшивка стороны не
   * спрашивала, и закрывающий документ вправе был подшить любой, кому видна заявка. Р3 находку
   * закрыл, и строка изменилась вместе с кодом — ровно так, как задумано: в диффе видно, что
   * находка закрыта, а не потеряна.
   *
   * Случай оставлен и после починки: он сторожит обратный ход. Верни кто-нибудь `'any'` — прогон
   * назовёт это возвратом находки, а не «поправил манифест».
   */
  it('подшивка документов спрашивает сторону исполнителя — находка Н2 закрыта (Р3)', () => {
    expect(manifest['POST /api/v1/service-requests/:id/files']).toEqual({
      scope: 'visibility',
      side: 'executor',
      state: 'assertFileKindAllowed',
    });
  });

  /**
   * Обе половины находки Н8 — тем же приёмом, что и Н2 выше: строка сторожит обратный ход.
   *
   * `notify` объявлялся `side: 'any'` — стороны у него не было вовсе, и повтор служебной рассылки
   * заводил всякий с `serviceRequests.status`, включая подрядчика (право есть у типа контрагента
   * `service`). `executor-candidates` объявлялся `scope: 'none'` — заявки у ручки не было, а
   * значит и области, — и из этого списка назначали исполнителей, которым заявка недоступна.
   *
   * Верни кто-нибудь прежние значения — прогон назовёт это возвратом находки, а не «поправил
   * манифест». Что сторона и правда отбивает чужого субъекта, доказывает прогон запросов
   * (`service-executor-access.db.test.ts`, §6.18), а не это поле.
   */
  it('повтор письма и кандидаты закрыты стороной и областью — находка Н8 закрыта (Р7, Р9)', () => {
    expect(manifest['POST /api/v1/service-requests/:id/notify']).toEqual({
      scope: 'visibility',
      side: 'operator',
      state: 'serviceMailRepeatable',
    });
    expect(manifest['GET /api/v1/service-requests/executor-candidates']).toEqual({
      scope: 'visibility',
      side: 'assigner',
      state: null,
    });
  });
});
