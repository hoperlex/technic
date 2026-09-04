import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RouteOptions } from 'fastify';
import {
  ACCESS_CONDITION_KINDS,
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
  /*
   * Тридцать секунд вместо умолчания в десять — не «тест бывает медленным», а мерка выросшего
   * приложения: сборка со всеми маршрутами занимает около восьми секунд транспиляции, и вместе с
   * накладными расходами прогона умолчание пробивается стабильно, а под параллельной нагрузкой —
   * с запасом. Падал при этом не тест, а хук, и падение читалось как поломка манифеста, хотя ни
   * одного факта о маршрутах проверить не успевали.
   */
}, 30_000);

const manifest = ACCESS_MANIFEST as Record<string, AccessCondition>;

/**
 * Пометка стража «одно из перечисленных прав» (`auth/plugin.ts`): префикс плюс перечень через `|`.
 * Литералом, как и `handler:`, а не импортом из проверяемого кода: пометка — это **факт**, и
 * разбирать его тем же модулем, который его пишет, значило бы сверять код с самим собой.
 */
const ANY_OF = 'anyOf:';

function isAnyOfFact(authz: string): boolean {
  return authz.startsWith(ANY_OF);
}

/** Права, объявленные стражами: дизъюнкция разворачивается в свои члены. */
function permissionsFact(authz: string[]): string[] {
  return authz
    .filter((a) => !a.startsWith('handler:'))
    .flatMap((a) => (isAnyOfFact(a) ? a.slice(ANY_OF.length).split('|') : [a]));
}

/** Наборы прав из пометок «одно из перечисленных» — по одному на каждого такого стража. */
function anyOfFacts(authz: string[]): string[][] {
  return authz.filter(isAnyOfFact).map((a) => a.slice(ANY_OF.length).split('|'));
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
      // Дизъюнкция сверяется отдельно от конъюнкции, а не одним множеством прав: «нужны оба» и
      // «довольно любого» из одинаковой пары прав дают один и тот же перечень имён, и множество
      // сошлось бы на подменённом условии — том самом, что открывает ручку вдвое шире.
      const disjunctions = anyOfFacts(fact.authz);
      if (condition.kind === 'anyOf') {
        const only = disjunctions.length === 1 ? disjunctions[0]! : null;
        if (!only || !sameSet(only, condition.anyOf) || actual.length !== only.length) {
          mismatched.push(
            `${fact.key}: манифест ожидает «одно из [${condition.anyOf.join(', ')}]», ` +
              `страж объявляет [${fact.authz.join(', ') || '—'}]`,
          );
        }
        continue;
      }
      if (disjunctions.length > 0) {
        mismatched.push(
          `${fact.key}: манифест — ${condition.kind}, факт — страж «одно из прав» (${fact.authz.join(', ')})`,
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
    // Условных мест в модели четыре. Два в «Вывозе мусора»: заведение и правка заявки требуют
    // `wasteRequests.assignOperator` только при присутствии `operatorCounterpartyId`. Третье —
    // заведение расходника оргтехники: ненулевой начальный остаток требует
    // `officeEquipmentConsumables.stock` сверх `manage`, потому что это уже утверждение о складе, а
    // не о номенклатуре. Оно отличается от первых способом проверки: право спрашивается по
    // ЗНАЧЕНИЮ (`quantity > 0`), а не по присутствию поля, — `quantity` приезжает умолчанием схемы
    // и в теле есть всегда. Пятым было заведение автозапчасти тем же приёмом — оно уехало вместе со
    // складом автозапчастей (план `docs/auto-part-receipts-plan.md`, Р2).
    //
    // Правка заявки на обслуживание сюда НЕ ВХОДИТ, хотя срочность там тоже спрашивает своё право:
    // условие у неё по ЭФФЕКТУ, а не по телу (`effectConditionalPermissions`, план профилей
    // оргтехники, Р10). Разница не в оформлении — форма шлёт пару срочности всегда, и условие «поле
    // прислали» закрыло бы правом срочности всю правку заявителя.
    // Список поимённый: пятое такое место обязано попасть в ревью, а не приехать молча.
    expect(conditional.map(([key]) => key).sort()).toEqual([
      'PATCH /api/v1/waste-requests/:id',
      'POST /api/v1/office-equipment-consumables',
      'POST /api/v1/service-requests/:id/messages',
      'POST /api/v1/waste-requests',
    ]);
    /*
     * Четвёртое место — отправка реплики в обсуждение заявки (ADR 0141) — единственное с ПУСТЫМ
     * `conditionalAllOf`, и пустота эта содержательна. Условие там не право, а участие в разговоре:
     * сторона считается из фактов заявки (автор ли я, в области ли заказчика, назначен ли подрядчик,
     * назван ли я поимённо), и записать её правом невозможно по построению. Требуй тест непустого
     * перечня у всех подряд — условие пришлось бы либо выдумать правом, которого нет, либо спрятать
     * маршрут в `permissions` и потерять пометку «сверх базового спрашивается ещё кое-что».
     */
    const emptyConditional = conditional
      .filter(([, c]) => c.kind === 'conditionalPermissions' && c.conditionalAllOf.length === 0)
      .map(([key]) => key);
    expect(emptyConditional).toEqual(['POST /api/v1/service-requests/:id/messages']);
    for (const [key, condition] of conditional) {
      if (condition.kind !== 'conditionalPermissions') continue;
      // Пока условие спрашивается внутри обработчика, в `guard.authz` его нет вовсе — и делать
      // вид, что сверка «манифест ↔ факт» покрыла условную половину, нельзя. Когда страж получит
      // структурную декларацию, пометка станет `true`, и здесь появится сравнение с фактом.
      expect(condition.conditionDeclaredOnRoute, `${key}: условие уже объявлено на маршруте?`).toBe(
        false,
      );
    }
  });

  /**
   * Дизъюнкция открывает ручку двум сторонам сразу, и список её мест обязан быть поимённым:
   * двенадцатая такая строка должна попасть в ревью, а не приехать молча вместе с правкой
   * соседнего маршрута.
   *
   * Десять из одиннадцати — ходы исполнителя заявки на обслуживание (план переработки цикла §7.3),
   * и во всех десяти вторым членом стоит `serviceRequests.execute`: ради поимённого исполнителя
   * дизъюнкция и заведена. Дизъюнкция без него в этой десятке означала бы, что ручку открыли
   * кому-то ещё.
   *
   * Восьмая приехала выпуском 3 — правка факта выдачи расходников (Р6): отмечает выдачу тот, кто
   * картриджи вёз, и это ровно тот же выбор сторон, что у статусных ходов.
   *
   * Девятая и десятая приехали упрощением цикла (ADR 0145). `PATCH /:id/estimate/approval` —
   * согласование объёма работ: по ответу В2 подписывает НАЗНАЧЕННЫЙ сотрудник, а не только
   * «Ведение» (Р3), и одним `approveEstimate` он упёрся бы в стража ещё до предиката.
   * `PUT /:id/consumables` — состав расходников: заполняет его исполнитель, а не заявитель (Р15),
   * и прежнее «заказчик, пока заявку не отдали» открывало ручку ровно не тому.
   *
   * ОДИННАДЦАТАЯ — ПЕРВАЯ ДИЗЪЮНКЦИЯ НЕ ПРО ПОИМЁННОГО ИСПОЛНИТЕЛЯ, и потому она названа здесь
   * отдельно, а не дописана в общий перебор. Карточку сообщения об отсутствующей технике (план
   * кандидатов, Р9) читают две стороны: участники видимой заявки — правом `serviceRequests.read`,
   * и проверяющий — правом `officeEquipment.review`, которому связанная заявка может быть не видна
   * вовсе. Оба члена здесь — права СТОРОН, а не пара «право стороны + назначение», и требовать от
   * этой строки `serviceRequests.execute` значило бы требовать признак, которого у случая нет.
   * Перебор ниже поэтому спрашивает `execute` у десятки заявок, а не у всякой дизъюнкции: правило
   * «дизъюнкция всегда ради назначения» было верным ровно до тех пор, пока все её места были ходами
   * одной ручки.
   */
  it('дизъюнкция объявлена поимённо, и у ходов заявки второй член — назначение', () => {
    const declared = Object.entries(manifest).filter(([, c]) => c.kind === 'anyOf');
    expect(declared.map(([key]) => key).sort()).toEqual([
      'GET /api/v1/office-equipment-candidates/:id',
      'PATCH /api/v1/service-requests/:id/complete',
      'PATCH /api/v1/service-requests/:id/consumables/issued',
      'PATCH /api/v1/service-requests/:id/decline',
      'PATCH /api/v1/service-requests/:id/estimate/approval',
      'PATCH /api/v1/service-requests/:id/estimate/reopen',
      'PATCH /api/v1/service-requests/:id/estimate/submit',
      'PATCH /api/v1/service-requests/:id/service-comment',
      'PATCH /api/v1/service-requests/:id/start',
      'PUT /api/v1/service-requests/:id/consumables',
      'PUT /api/v1/service-requests/:id/estimate',
    ]);
    for (const [key, condition] of declared) {
      if (condition.kind !== 'anyOf') continue;
      // Ходы заявки на обслуживание — и только они: второй член у них обязан быть назначением.
      if (key.includes('/service-requests/')) {
        expect(condition.anyOf, key).toContain('serviceRequests.execute');
      }
      // Выбор из одного члена — это `permissions`, только записанное так, что в ревью не спросить
      // «почему их два». Тип это уже требует; здесь проверка на случай приведения типа.
      expect(condition.anyOf.length, key).toBeGreaterThan(1);
    }
  });

  /**
   * Видов условия восемь, и перечень их поимённый по той же причине, что и списки условных мест:
   * девятый вид — это новая форма доступа, и приезжать молча она не должна.
   *
   * Сверяется РЕЕСТР (`ACCESS_CONDITION_KINDS`), а не множество видов, встреченных в манифесте.
   * Union рантайму не виден, а полноту реестра держит компилятор, — поэтому реестр отвечает на
   * «сколько видов бывает», тогда как манифест отвечает лишь на «сколько уже применено». Разница не
   * теоретическая, и её история тому доказательство: `effectConditionalPermissions` простоял
   * незанятым с заморозки склада автозапчастей (три его строки уехали вместе со складским расходом,
   * план `docs/auto-part-receipts-plan.md`, Р2, Р3) — и снова занят правкой заявки на обслуживание,
   * где право срочности спрашивается по разнице со строкой (план профилей оргтехники, Р10). Вид,
   * который тогда не выбросили, не пришлось теперь изобретать.
   */
  it('видов условия восемь, и все они перечислены реестром', () => {
    expect([...ACCESS_CONDITION_KINDS].sort()).toEqual([
      'anyOf',
      'authenticated',
      'conditionalPermissions',
      'effectConditionalPermissions',
      'handlerAuthorized',
      'internalToken',
      'permissions',
      'public',
    ]);
    // Обратная сторона: вид, встреченный в манифесте, обязан быть в реестре. Иначе реестр отстал бы
    // от union'а молча — ровно так, как отставал руками писанный список ключей профилей.
    const used = [...new Set(Object.values(manifest).map((c) => c.kind))];
    const unknown = used.filter(
      (kind) => !(ACCESS_CONDITION_KINDS as readonly string[]).includes(kind),
    );
    expect(unknown, 'вид условия из манифеста не назван реестром').toEqual([]);
    // И третья: реестр не копилка — каждый вид применён хотя бы одним маршрутом. Исключений сейчас
    // нет ни одного: `effectConditionalPermissions` пустовал с заморозки склада (план чеков, Р2) и
    // снова занят правкой заявки на обслуживание (Р10). Пустующий вид — состояние законное, но
    // называть его придётся здесь поимённо и с причиной: без этого реестр молча копил бы формы
    // доступа, которых в модели уже нет.
    const idle = ACCESS_CONDITION_KINDS.filter((kind) => !used.includes(kind));
    expect(idle, 'вид условия заведён, но не применён ни одним маршрутом').toEqual([]);
  });

  /**
   * Ссылка на доказательство обязана вести в существующий файл. Проверяются те условия, у которых
   * перебором прав правило не доказать вовсе (`handlerAuthorized` — доступ по самой записи,
   * `effectConditionalPermissions` — право по эффекту запроса): у них `provenBy` — единственное
   * место, где сказано, чем правило держится, и протухшая ссылка тиха вдвойне.
   *
   * Перебираются РЕАЛЬНО ОБЪЯВЛЕННЫЕ строки манифеста, а не виды: пока у вида нет ни одного
   * маршрута, доказывать ему нечего, и требовать файл заранее значило бы требовать написать тест
   * раньше кода, который он проверяет.
   */
  it('`provenBy` условий ведёт в существующий файл теста', () => {
    const missing = Object.entries(manifest)
      .flatMap(([key, condition]) =>
        condition.kind === 'handlerAuthorized' || condition.kind === 'effectConditionalPermissions'
          ? [[key, condition.provenBy] as const]
          : [],
      )
      .filter(
        ([, provenBy]) => !existsSync(fileURLToPath(new URL(`../${provenBy}`, import.meta.url))),
      )
      .map(([key, provenBy]) => `${key}: ${provenBy}`);
    expect(missing, 'условие ссылается на несуществующий тест').toEqual([]);
  });
});
