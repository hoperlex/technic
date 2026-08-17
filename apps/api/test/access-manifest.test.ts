import { beforeAll, describe, expect, it } from 'vitest';
import type { RouteOptions } from 'fastify';
import {
  ACCESS_MANIFEST,
  guardPermissionsOf,
  type AccessCondition,
  type AccessConditionKind,
} from '../src/lib/access-manifest';

/**
 * Сверка манифеста доступа с фактом: у каждого маршрута приложения есть строка в манифесте, у
 * каждой строки — маршрут, и объявленное условие совпадает с тем, чем маршрут закрыт на самом деле.
 *
 * Почему сравниваются две стороны, а не берётся `guard.authz` за истину. Тест, построенный на
 * пометке стража, проверял бы код его же собственным утверждением: разработчик, привязавший к
 * маршруту не то право (скажем, `directories.read` вместо `drivers.read` — ФИО и СНИЛС открылись
 * бы всем, кто заполняет форму заявки), получил бы от стража это же неверное право. Множества
 * сошлись бы, тест промолчал бы — и промолчал бы ровно про ту ошибку, ради которой проверки
 * доступа и пишутся. Поэтому ожидание живёт отдельным файлом, который пишут и ревьюят руками
 * (`src/lib/access-manifest.ts`), а факт снимается с собранного приложения. Тест ловит не
 * «неправильное право» — это дело ревьюера, — а **расхождение** между тем, что заявлено, и тем,
 * что работает: правка маршрута без правки манифеста роняет прогон, и в диффе видно оба места.
 *
 * Манифест лежит в `src`, а не рядом с тестом, намеренно: `apps/api/tsconfig.json` не включает
 * каталог `test/`, и типизированное ожидание, положенное туда, перестало бы быть типизированным
 * (см. docs/permissions-restructure-plan.md §14).
 *
 * Чего этот тест НЕ делает: не ходит по маршрутам запросами. «С полным набором прав проходит, без
 * каждого права — 403» и сценарии условного права — следующий шаг реформы; здесь только сверка
 * ожидания с фактом. Забытую пометку стража по-прежнему ловит `route-authorization.test.ts`.
 */

interface RouteFact {
  /** Ключ манифеста: «метод + путь», как их показывает само приложение. */
  key: string;
  url: string;
  /** Пометки стражей: право из матрицы либо `handler:<причина>` (см. auth/plugin.ts). */
  authz: string[];
}

const facts: RouteFact[] = [];

/**
 * Корень префикса Fastify заводит в двух написаниях — `/api/v1/users` и с завершающим слешем
 * (`prefixTrailingSlash`). Манифест перечисляет путь один раз, поэтому слеш снимаем здесь.
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
  const seen = new Map<string, RouteFact>();
  const { buildApp } = await import('../src/app');
  const app = await buildApp({
    onRoute: (route) => {
      const handlers = handlersOf(route);
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // `HEAD` Fastify заводит к каждому `GET` сам, и отдельной строки в манифесте он не
        // заслуживает: условие у него то же, что у `GET`, а перечисление удвоило бы файл.
        if (method === 'HEAD') continue;
        const url = pathOf(route.url);
        const key = `${method} ${url}`;
        const authz = handlers.flatMap((h) => (h.authz ? [String(h.authz)] : []));
        const before = seen.get(key);
        if (before) {
          // Два написания одного пути обязаны быть закрыты одинаково — иначе слеш открывал бы
          // маршрут в обход манифеста.
          expect(authz, `${key}: два написания пути закрыты по-разному`).toEqual(before.authz);
          continue;
        }
        const fact: RouteFact = { key, url, authz };
        seen.set(key, fact);
        facts.push(fact);
      }
    },
  });
  await app.close();
});

const manifest = ACCESS_MANIFEST as Record<string, AccessCondition>;

function permissionsFact(authz: string[]): string[] {
  return authz.filter((a) => !a.startsWith('handler:'));
}

function isHandlerFact(authz: string[]): boolean {
  return authz.some((a) => a.startsWith('handler:'));
}

/** Множества, а не списки: порядок стражей в `preHandler` условия не меняет. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

describe('манифест доступа маршрутов', () => {
  it('маршруты собраны из приложения, а не перечислены в тесте', () => {
    expect(facts.length).toBeGreaterThan(200);
  });

  it('у каждого маршрута приложения есть строка в манифесте', () => {
    const missing = facts.filter((f) => !(f.key in manifest)).map((f) => f.key);
    expect(missing, 'новый маршрут без строки в манифесте').toEqual([]);
  });

  it('в манифесте нет строк для маршрутов, которых больше нет', () => {
    const live = new Set(facts.map((f) => f.key));
    const stale = Object.keys(manifest).filter((key) => !live.has(key));
    expect(stale, 'строка манифеста без маршрута').toEqual([]);
  });

  it('объявленное условие совпадает с фактическим', () => {
    const mismatched: string[] = [];
    for (const fact of facts) {
      const condition = manifest[fact.key];
      if (!condition) continue; // отсутствие строки — отдельная проверка выше
      const expected = guardPermissionsOf(condition);
      const actual = permissionsFact(fact.authz);
      const handler = isHandlerFact(fact.authz);
      if (condition.kind === 'handlerAuthorized') {
        // Доступ по самой записи: страж обязан быть помечен `handler:`, права у него нет.
        if (!handler || actual.length > 0) {
          mismatched.push(
            `${fact.key}: манифест — handlerAuthorized, факт — [${fact.authz.join(', ')}]`,
          );
        }
        continue;
      }
      if (handler) {
        mismatched.push(
          `${fact.key}: манифест — ${condition.kind}, факт — доступ по самой записи (${fact.authz.join(', ')})`,
        );
        continue;
      }
      if (!sameSet(expected, actual)) {
        mismatched.push(
          `${fact.key}: манифест ожидает [${expected.join(', ') || '—'}], ` +
            `страж объявляет [${actual.join(', ') || '—'}]`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('`public`, `authenticated` и `internalToken` объявлены без права', () => {
    const kinds = new Set<AccessConditionKind>(['public', 'authenticated', 'internalToken']);
    const withPermission = facts
      .filter((f) => {
        const condition = manifest[f.key];
        return condition && kinds.has(condition.kind) && permissionsFact(f.authz).length > 0;
      })
      .map((f) => `${f.key}: ${f.authz.join(', ')}`);
    expect(withPermission, 'маршрут без права в манифесте на деле закрыт правом').toEqual([]);
  });

  it('`handlerAuthorized` встречается ровно у маршрутов файлов', () => {
    const declared = Object.entries(manifest)
      .filter(([, condition]) => condition.kind === 'handlerAuthorized')
      .map(([key]) => key);
    expect(declared.length).toBeGreaterThan(0);
    for (const key of declared) {
      expect(key.split(' ')[1]!.startsWith('/api/v1/files'), key).toBe(true);
    }
    // И обратная сторона: ни один файловый маршрут не закрыт правом из матрицы, а ни один
    // нефайловый — обработчиком. Инвариант тот же, что у `route-authorization.test.ts`, но здесь
    // он проверяется по ожиданию: строка `handlerAuthorized`, приписанная чужому маршруту, была бы
    // разрешением решать доступ самому обработчику — то есть лазейкой.
    const factHandlers = facts.filter((f) => isHandlerFact(f.authz)).map((f) => f.key);
    expect([...factHandlers].sort()).toEqual([...declared].sort());
  });

  it('условное право объявлено там, где оно есть, и пока живёт в обработчике', () => {
    const conditional = Object.entries(manifest).filter(
      ([, c]) => c.kind === 'conditionalPermissions',
    );
    // Условных мест в модели два, оба в «Вывозе мусора»: заведение и правка заявки требуют
    // `wasteRequests.assignOperator` только при присутствии `operatorCounterpartyId`. Список
    // поимённый: третье такое место обязано попасть в ревью, а не приехать молча.
    expect(conditional.map(([key]) => key).sort()).toEqual([
      'PATCH /api/v1/waste-requests/:id',
      'POST /api/v1/waste-requests',
    ]);
    for (const [key, condition] of conditional) {
      if (condition.kind !== 'conditionalPermissions') continue;
      expect(condition.conditionalAllOf.length, key).toBeGreaterThan(0);
      // Пока условие спрашивается внутри обработчика, в `guard.authz` его нет вовсе — и делать
      // вид, что сверка «манифест ↔ факт» покрыла условную половину, нельзя. Когда страж получит
      // структурную декларацию, пометка станет `true`, и здесь появится сравнение с фактом.
      expect(condition.conditionDeclaredOnRoute, `${key}: условие уже объявлено на маршруте?`).toBe(
        false,
      );
    }
  });

  it('в манифесте перечислены все шесть типов условия', () => {
    const kinds = new Set(Object.values(manifest).map((c) => c.kind));
    expect([...kinds].sort()).toEqual([
      'authenticated',
      'conditionalPermissions',
      'handlerAuthorized',
      'internalToken',
      'permissions',
      'public',
    ]);
  });
});
