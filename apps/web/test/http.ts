/**
 * Мок сети для сценарных тестов.
 *
 * Раньше тесты подменяли модуль `api/resources` целиком: такой мок описывает не поведение
 * портала, а его текущее устройство, и разваливается от любого переноса файлов. Здесь
 * подменяется `fetch`, поэтому проверка держится за HTTP-контракт — тот же, по которому портал
 * разговаривает с сервером на самом деле. Заодно становится видно то, что иначе не проверить:
 * сколько запросов ушло, какие и в каком порядке.
 */

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Обычный ответ: тело плюс 200, если статус не задан явно. */
export const json = <T>(body: T, status = 200): MockResponse => ({ status, body });

/** Ответ без тела: им отвечают удаления. */
export const noContent = (): MockResponse => ({ status: 204 });

/**
 * Ошибка в формате портала. `fields` разбирает `applyApiFieldErrors` и показывает текст на самом
 * поле формы, поэтому тест на валидацию без этой формы ответа ничего не проверит. `requestId`
 * сервер шлёт со всякой ошибкой, а показывается он у пятисотки — им человек и приходит с тостом.
 */
export const apiError = (
  status: number,
  body: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    requestId?: string;
  },
): MockResponse => ({ status, body });

export interface RouteContext {
  /** Значения из шаблона пути: `PATCH /waste-requests/:id/status` → `{ id: '...' }`. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Разобранное тело запроса; `undefined` у GET и DELETE. */
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => MockResponse | Promise<MockResponse>;

/** Ключ маршрута — «МЕТОД путь», путь без префикса `/api/v1`: `'GET /waste-requests'`. */
export type RouteMap = Record<string, RouteHandler>;

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface HttpMock {
  /** Журнал запросов в порядке отправки — по нему проверяют, что ушло и сколько раз. */
  calls: RecordedCall[];
  /** Сколько раз вызывался маршрут: `countOf('GET /waste-requests')`. */
  countOf: (route: string) => number;
  /** Последний вызов маршрута — обычно нужен, чтобы проверить тело запроса. */
  lastCall: (route: string) => RecordedCall | undefined;
  /** Дописать или заменить маршруты по ходу теста: второй пользователь, изменившийся список. */
  use: (routes: RouteMap) => void;
}

const API_PREFIX = '/api/v1';

/**
 * Настоящий `fetch`, снятый перед первой подменой. Хранится в модуле, а не в замыкании вызова:
 * `afterEach`, зарегистрированный изнутри `it`, попадает не в ту сюиту и между тестами не
 * срабатывает, поэтому снимает подмену общий хук в `setup.ts` — один на весь прогон.
 */
let originalFetch: typeof globalThis.fetch | null = null;

/**
 * Запросы, на которые не нашлось маршрута. Собираются отдельно, потому что падение самого
 * запроса теста не роняет: результат фонового запроса никто не ждёт — TanStack Query проглатывает
 * ошибку, и экран молча остаётся без данных. Тест при этом зелёный, хотя проверяет не то, что
 * думает автор. Поэтому список сверяется после каждого теста (`test/setup.ts`).
 */
let unmatched: string[] = [];

/**
 * Забрать список незамоканных запросов, погасив его. Нужен там, где отсутствие мока — предмет
 * самой проверки: без этого тест на «незаданный маршрут падает внятно» падал бы дважды — по делу
 * и следом на общей сверке.
 */
export function takeUnmatchedHttp(): string[] {
  const missed = unmatched;
  unmatched = [];
  return missed;
}

/**
 * Возвращает настоящий `fetch` и сообщает о незамоканных запросах. Зовётся из `test/setup.ts`
 * после каждого теста.
 */
export function restoreHttpMock(): void {
  const missed = unmatched;
  unmatched = [];
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  if (missed.length > 0) {
    const routes = [...new Set(missed)].join('\n  ');
    throw new Error(
      `Экран запросил то, что не описано в mockHttp:\n  ${routes}\n` +
        'Опишите эти маршруты либо разберитесь, зачем экран их дёргает: без ответа он молча остаётся без данных.',
    );
  }
}

interface ParsedRoute {
  method: string;
  segments: string[];
}

function parseRouteKey(key: string): ParsedRoute {
  const [method, path] = key.split(' ');
  if (!method || !path) {
    throw new Error(`Маршрут описывается как «МЕТОД путь», получено: «${key}»`);
  }
  return { method: method.toUpperCase(), segments: path.split('/').filter(Boolean) };
}

/** Совпадение пути с шаблоном; параметры шаблона (`:id`) возвращаются значениями. */
function matchPath(template: string[], actual: string[]): Record<string, string> | null {
  if (template.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of template.entries()) {
    const value = actual[index]!;
    if (part!.startsWith(':')) {
      params[part!.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (part !== value) return null;
  }
  return params;
}

/**
 * Ставит роутер на время теста. `fetch` возвращается на место автоматически: упавший тест иначе
 * утащил бы за собой все следующие, и разбираться пришлось бы не с ним, а с ними.
 */
export function mockHttp(routes: RouteMap): HttpMock {
  const table = new Map<string, RouteHandler>(Object.entries(routes));
  const calls: RecordedCall[] = [];
  // Настоящий fetch запоминается только при первой подмене: второй вызов mockHttp в том же тесте
  // (перерисовка под другой ролью) не должен «сохранить» уже подменённый.
  originalFetch ??= globalThis.fetch;

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    // Загрузка файла идёт мимо API: presigned-ссылка ведёт прямо в хранилище, и запрос к нему
    // проверять нечего — важно лишь, что он не падает.
    if (!url.pathname.startsWith(API_PREFIX)) {
      calls.push({ method, path: url.pathname, query: url.searchParams, body });
      return new Response(null, { status: 200 });
    }

    const path = url.pathname.slice(API_PREFIX.length);
    const actual = path.split('/').filter(Boolean);
    calls.push({ method, path, query: url.searchParams, body });

    for (const [key, route] of table) {
      const parsed = parseRouteKey(key);
      if (parsed.method !== method) continue;
      const params = matchPath(parsed.segments, actual);
      if (!params) continue;
      const result = await route({ params, query: url.searchParams, body });
      const payload = result.body === undefined ? null : JSON.stringify(result.body);
      return new Response(result.status === 204 ? null : payload, {
        status: result.status,
        headers: { 'Content-Type': 'application/json', ...result.headers },
      });
    }

    // Само по себе это исключение теста не роняет: если результата никто не ждёт, ошибка утонет
    // в обработке запроса. Поэтому маршрут ещё и записывается — `restoreHttpMock` сверит список
    // после теста и не даст пропущенному запросу остаться незамеченным.
    unmatched.push(`${method} ${path}`);
    throw new Error(
      `Нет мока для «${method} ${path}». Опишите маршрут в mockHttp или проверьте, зачем экран его запрашивает.`,
    );
  };

  globalThis.fetch = handler as typeof globalThis.fetch;

  const matches = (route: string, call: RecordedCall) => {
    const parsed = parseRouteKey(route);
    return (
      parsed.method === call.method &&
      matchPath(parsed.segments, call.path.split('/').filter(Boolean)) !== null
    );
  };

  return {
    calls,
    countOf: (route) => calls.filter((call) => matches(route, call)).length,
    lastCall: (route) => [...calls].reverse().find((call) => matches(route, call)),
    use: (extra) => {
      for (const [key, route] of Object.entries(extra)) table.set(key, route);
    },
  };
}
