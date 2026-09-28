#!/usr/bin/env node
/**
 * Что каждая мутация портала гасит в кэше — и две вещи, которые из этого следуют.
 *
 * ЗАЧЕМ. Сервер в одной транзакции меняет больше, чем экран, с которого пришёл запрос: возврат
 * заявки вывоза в «Новую» уносит талоны, правка техники освобождает прицепы, правка карточки
 * водителя переписывает его учётку, подтверждение талонов пересчитывает разбор. Гасится при этом
 * корень своего агрегата — и экран рядом продолжает показывать унесённое. Такую ошибку не ловит ни
 * тип, ни тест экрана: оба экрана по отдельности верны, неверно соседство. Инвентарь ниже делает
 * соседство видимым, а два правила — проверяемым.
 *
 * ЧТО ПРОВЕРЯЕТСЯ. Правило `writes-nothing-dropped`: пишущая мутация не касается кэша вовсе.
 * Правило `home-root-missed`: мутация гасит чужой корень и не гасит корень слайса, чьей ручкой
 * пишет. Оба — только по мутациям, разобранным ПОЛНОСТЬЮ: обвинять код в том, чего не понял
 * разборщик, значит получить отключённую проверку. Подробнее — у самих правил.
 *
 * ЧЕГО ПРОВЕРКА НЕ УМЕЕТ, и это главная часть шапки:
 *
 *   — Она не знает, что меняет СЕРВЕР. Три дефекта, из-за которых она написана, выведены чтением
 *     серверных ручек, и ни одно правило здесь их бы не нашло: у портала нет знания «PATCH
 *     /vehicles/:id освобождает прицепы». Найти их машинно можно только сопоставив таблицы,
 *     которые пишет маршрут, с корнями, чьи запросы их читают, — это отдельный шаг, и он не сделан.
 *     `home-root-missed` ловит соседний класс — «вспомнил о кэше и не дошёл до себя», — и на нём
 *     сразу нашёлся четвёртый дефект того же рода (подтверждение талонов).
 *   — Корень — ПЕРВЫЙ сегмент ключа, и только он. Гашение `vehicleKeys.list(params)` здесь
 *     считается гашением `vehicles`: сравнивать ключи целиком значило бы знать аргументы семейств,
 *     а они — значения времени выполнения. Проверка поэтому оптимистична и пропускает «погасил
 *     соседнюю страницу того же корня».
 *   — Имена разрешаются плоскими портальными таблицами, а не обходом импортов (баррели слайсов
 *     сделали бы это графом модулей). Имя, объявленное дважды с разным смыслом, помечается
 *     конфликтом, и каждое его употребление уходит в `unresolved` — вместо того чтобы молча взять
 *     первый смысл.
 *   — `setQueryData` считается эффектом кэша наравне с гашением: правка строки на месте — законный
 *     способ, и требовать поверх неё `invalidateQueries` проверка не вправе.
 *
 * ПОЧЕМУ `unresolved` ПЕЧАТАЕТСЯ ВСЕГДА. Такая проверка портится единственным способом — перестаёт
 * понимать код и оттого зеленеет. Счёт неразобранного в каждом прогоне — единственное, что отличает
 * «нечего сообщить» от «ничего не понял»: обвал разбора виден числом, а не отсутствием жалоб.
 *
 * ГДЕ ЖИВЁТ. Рядом с `lib/source-scan.mjs` и на его частях: разборщик, таблица локальных имён и, что
 * важнее всего, три набора, называющие ТОЧКИ ВХОДА В КЭШ. Второй список этих точек — та самая
 * рассинхронизация, ради предотвращения которой `source-scan` и выделен в модуль.
 *
 * В `pretest` НЕ ВСТРОЕНА намеренно. Цепочка там через `&&`, и красная проверка молча не пускает
 * четыре следующие; своя команда (`check:cache-invalidation`) роняет только себя.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  walkTs,
  parseSource,
  collectBindings,
  unwrap,
  propertyName,
  KEY_LIST_PROPS,
  KEY_FIRST_ARG_CALLS,
} from './lib/source-scan.mjs';

const WEB = path.resolve(process.cwd());
const SRC = path.join(WEB, 'src');
const MAP_FILE = path.join(WEB, 'cache-invalidation-map.json');

/** Layers a mutation may live in. `shared` is excluded: it knows no domain and owns no key. */
const LAYERS = ['entities', 'features', 'widgets', 'pages'];

/** HTTP verbs that change server state. A mutation over any of these owes the cache a drop. */
const WRITING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * A door's PREVIEW is a read that needs a body, not a write.
 *
 * Every command with consequences worth showing has one (`statusPreview`, `earlyEndPreview`,
 * `assignmentChangePreview`): it computes what the command would do and returns a fingerprint the
 * command then carries back. It is a POST only because a GET has no body to put the draft in, and it
 * changes nothing — so demanding a cache drop of it would be demanding a drop after a read.
 *
 * Recognised by the handle's name, and that is the weak spot: a preview that one day starts writing
 * keeps its name and stops being checked. The trade is deliberate — the alternative is a rule that
 * fires on a dozen honest previews and gets switched off within the week — and the day a preview
 * writes, the pair "preview + command" itself needs rereading, not just this line.
 */
function isPreviewHandle(handle) {
  const member = handle.slice(handle.indexOf('.') + 1);
  return member === 'preview' || /Preview$/.test(member);
}

/**
 * Shared API factories (`src/shared/api/resource.ts`) and the handles they spread into a slice API.
 * Spelled out because the spread hides the HTTP verb: `...createWriteApi(PATH)` is the only place
 * `update` is declared a PATCH, and a scan that skipped it would read half the portal's writes as
 * plain reads and stay silent about them.
 */
const API_FACTORIES = {
  createListApi: { list: 'GET' },
  createGetApi: { get: 'GET' },
  createWriteApi: { create: 'POST', update: 'PATCH' },
  createRemoveApi: { remove: 'DELETE' },
};

/** Bound on hops through names, helpers and factories; guards mutually referring declarations. */
const MAX_HOPS = 8;

const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

/**
 * `entities/driver/api/keys.ts` → `entities/driver`. Only `entities` and `features` have slices that
 * own an API and a key root; a file under `pages` or `widgets` belongs to a screen, and a screen
 * owning a root is itself the thing `check-stage2-layout` is driving out.
 */
function sliceOf(relPath) {
  const parts = relPath.split('/');
  if (parts.length < 3) return undefined;
  if (parts[0] !== 'entities' && parts[0] !== 'features') return undefined;
  return `${parts[0]}/${parts[1]}`;
}

// ---------------------------------------------------------------------------------------------
// Registries: what a name means portal-wide.
// ---------------------------------------------------------------------------------------------

/**
 * Names are resolved through flat portal-wide tables rather than by following imports.
 *
 * Imports here run through barrels (`@entities/driver` re-exports `api/keys`), so honest import
 * resolution would mean re-exporting logic, alias resolution and a module graph. The flat table
 * gives the same answer for every name that is unique in the portal, and says so out loud for the
 * rest: a name declared twice with two meanings is stored as a conflict and every use of it is
 * reported unresolved instead of silently taking the first meaning.
 */
function makeRegistry() {
  const byName = new Map();
  return {
    byName,
    add(name, value, file) {
      const prev = byName.get(name);
      if (prev && prev.value !== value) prev.conflict = true;
      else if (!prev) byName.set(name, { value, file, conflict: false });
    },
    get(name) {
      const hit = byName.get(name);
      if (!hit) return undefined;
      return hit.conflict ? null : hit.value;
    },
  };
}

/** `createQueryKeys('drivers', …)` and `['vehicles', 'trailer-hitch-targets'] as const`. */
function harvestKeyRoots(sf, file, keys, rootOwners) {
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(unwrap(init.expression)) &&
        unwrap(init.expression).text === 'createQueryKeys' &&
        init.arguments[0] &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        const root = init.arguments[0].text;
        keys.add(node.name.text, root, rel(file));
        if (!rootOwners.has(root)) rootOwners.set(root, rel(file));
      } else if (ts.isArrayLiteralExpression(init) && init.elements[0]) {
        // A const holding an array that opens with a string is a key candidate. Whether it really
        // is a key is decided where it is USED (source-scan's rule): this table is consulted only
        // from key positions, so a `['requests', 'on-site']` tab list recorded here can never be
        // read as anything but the key it would be if someone handed it to `invalidateQueries`.
        const first = init.elements[0];
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          keys.add(node.name.text, first.text, rel(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** `export const driversApi = { …, update: (id, b) => apiFetch(`…`, { method: 'PATCH' }) }`. */
function harvestApi(sf, file, objects, unresolved) {
  // Senders first: the handles below are read through them, so a sender declared after the API
  // object would otherwise be missed for every handle above it.
  const localVerbs = new Map();
  const collectSenders = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const verb = apiFetchVerb(init.body ?? init);
        // A sender declared twice in one file is stored as unusable rather than as its first
        // meaning: two senders under one name would silently label half the handles with the other
        // one's verb.
        if (verb) localVerbs.set(node.name.text, localVerbs.has(node.name.text) ? undefined : verb);
      }
    }
    ts.forEachChild(node, collectSenders);
  };
  collectSenders(sf);
  for (const [name, verb] of [...localVerbs]) if (verb === undefined) localVerbs.delete(name);

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const obj = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(obj))
        harvestApiObject(node.name.text, obj, file, objects, unresolved, localVerbs);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * One object literal, recorded as members plus UNRESOLVED SPREADS — not as finished handles.
 *
 * A slice API is not always one literal. `vehicleRequestsApi` is four objects spread together, each
 * declared in a file of its own (`lifecycle`, `doors`, `execution`, `lists`), and reading each
 * literal on its own left every transition of the vehicle-request module without a verb: the spread
 * was "an unknown factory" and the parts were never looked at, because their names do not end in
 * `Api`. So every literal is kept, and the spreads are followed in a second pass, once every file
 * has been read — a spread may name an object declared later or elsewhere.
 */
function harvestApiObject(objName, obj, file, objects, unresolved, localVerbs) {
  const members = new Map();
  const spreads = [];
  for (const member of obj.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spread = unwrap(member.expression);
      const callee = ts.isCallExpression(spread) ? unwrap(spread.expression) : undefined;
      const factory = callee && ts.isIdentifier(callee) ? API_FACTORIES[callee.text] : undefined;
      if (factory) for (const [m, verb] of Object.entries(factory)) members.set(m, verb);
      else if (ts.isIdentifier(spread)) spreads.push(spread.text);
      else
        unresolved.push({
          file: rel(file),
          form: `${objName} spreads an expression`,
          why: 'api-spread-not-a-name-and-not-a-known-factory',
        });
      continue;
    }
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member)) continue;
    const name = propertyName(member.name);
    if (!name) continue;
    const verb = apiFetchVerb(
      ts.isPropertyAssignment(member) ? member.initializer : member,
      localVerbs,
    );
    if (verb) members.set(name, verb);
  }
  // A literal that reaches no request at all is not an API object: a config, a dictionary, a map of
  // labels. Keeping those would fill the table with names that answer nothing.
  if (members.size > 0 || spreads.length > 0)
    objects.add(objName, { members, spreads, file: rel(file) });
}

/**
 * Spreads resolved into handles: `objects` → `api`, after every file has been read.
 *
 * Depth-bounded and cycle-safe for the same reason as the helper table: two objects spreading each
 * other is a runtime error nobody would ship, but the scan must answer rather than hang if one
 * appears mid-edit.
 */
function flattenApiObjects(objects, api, unresolved) {
  const cache = new Map();
  const computing = new Set();
  const resolve = (name, depth) => {
    if (cache.has(name)) return cache.get(name);
    const entry = objects.byName.get(name);
    if (!entry) return undefined;
    if (entry.conflict) return null;
    if (depth > MAX_HOPS || computing.has(name)) return new Map();
    computing.add(name);
    const out = new Map(entry.value.members);
    for (const from of entry.value.spreads) {
      const inner = resolve(from, depth + 1);
      if (inner === undefined)
        unresolved.push({
          file: entry.value.file,
          form: `${name} spreads ${from}`,
          why: 'api-spread-names-an-object-not-found-in-src',
        });
      else if (inner === null)
        unresolved.push({
          file: entry.value.file,
          form: `${name} spreads ${from}`,
          why: 'api-spread-names-an-object-declared-twice',
        });
      else for (const [m, verb] of inner) if (!out.has(m)) out.set(m, verb);
    }
    computing.delete(name);
    cache.set(name, out);
    return out;
  };

  for (const [name, entry] of objects.byName) {
    const members = resolve(name, 0);
    if (!members) continue;
    for (const [member, verb] of members) api.add(`${name}.${member}`, verb, entry.value.file);
  }
}

/**
 * The HTTP verb of a handle: the `method` option of its `apiFetch`, or GET when it has none.
 *
 * `localVerbs` carries the one-line senders a slice API declares above its object — `const patch =
 * (id, tail, body) => apiFetch(…, { method: 'PATCH' })`. Without them a whole module reads as
 * unparsed: the lifecycle of a vehicle request and of a service request declare every transition
 * through such a sender, and each handle would land in `unresolved` with no verb. The table is per
 * FILE, never portal-wide, because these names are deliberately short and mean different things in
 * different slices.
 */
function apiFetchVerb(node, localVerbs) {
  let verb;
  const visit = (n) => {
    if (verb) return;
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name && localVerbs?.has(name)) {
        verb = localVerbs.get(name);
        return;
      }
      if (name === 'apiFetch' || name === 'apiUpload') {
        verb = 'GET';
        const opts = n.arguments.find((a) => ts.isObjectLiteralExpression(unwrap(a)));
        if (opts)
          for (const p of unwrap(opts).properties)
            if (
              ts.isPropertyAssignment(p) &&
              propertyName(p.name) === 'method' &&
              ts.isStringLiteral(unwrap(p.initializer))
            )
              verb = unwrap(p.initializer).text;
        if (name === 'apiUpload') verb = 'POST';
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return verb;
}

// ---------------------------------------------------------------------------------------------
// Resolving a key expression to its root.
// ---------------------------------------------------------------------------------------------

/**
 * The root is the FIRST segment of the key, and that is the whole of what this check reasons about.
 *
 * TanStack Query matches keys by prefix, so `['vehicles']` covers every key that opens with it and
 * nothing that does not. Comparing whole keys would need the arguments of every family, which are
 * runtime values; comparing roots needs only the literal the slice was built from. The price is
 * named in the header: a drop of `vehicleKeys.list(params)` counts here as a drop of `vehicles`,
 * which is wider than what really happened.
 */
function resolveRoots(node, ctx, hops = 0) {
  const expr = unwrap(node);
  if (!expr) return { roots: [], why: 'empty-key-expression' };
  if (hops > MAX_HOPS) return { roots: [], why: 'key-resolution-too-deep' };

  if (ts.isArrayLiteralExpression(expr)) {
    const first = expr.elements[0];
    if (!first) return { roots: [], why: 'empty-array-key' };
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      return { roots: [first.text], why: null };
    if (ts.isSpreadElement(first)) return resolveRoots(first.expression, ctx, hops + 1);
    return { roots: [], why: 'array-key-opened-by-a-computed-value' };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const owner = unwrap(expr.expression);
    if (owner && ts.isIdentifier(owner)) return fromName(owner.text, ctx, hops);
    return { roots: [], why: 'key-read-off-a-computed-object' };
  }

  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);
    if (callee && ts.isPropertyAccessExpression(callee)) {
      const owner = unwrap(callee.expression);
      if (owner && ts.isIdentifier(owner)) return fromName(owner.text, ctx, hops);
    }
    if (callee && ts.isIdentifier(callee)) {
      const local = ctx.bindings.get(callee.text);
      if (local) return resolveRoots(local, ctx, hops + 1);
      return { roots: [], why: `key-built-by-an-unresolved-factory:${callee.text}` };
    }
    return { roots: [], why: 'key-built-by-a-computed-callee' };
  }

  if (ts.isIdentifier(expr)) return fromName(expr.text, ctx, hops);

  if (ts.isConditionalExpression(expr)) {
    const a = resolveRoots(expr.whenTrue, ctx, hops + 1);
    const b = resolveRoots(expr.whenFalse, ctx, hops + 1);
    if (a.why || b.why) return { roots: [...a.roots, ...b.roots], why: a.why ?? b.why };
    return { roots: [...a.roots, ...b.roots], why: null };
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    // `refreshQueryKey={() => key}` and the key factories of `PageTabs`.
    if (expr.body && !ts.isBlock(expr.body)) return resolveRoots(expr.body, ctx, hops + 1);
    return { roots: [], why: 'key-returned-from-a-block-body' };
  }

  return { roots: [], why: `key-of-an-unhandled-shape:${ts.SyntaxKind[expr.kind]}` };
}

/** A bare name in a key position: a local binding first, then the portal-wide key table. */
function fromName(name, ctx, hops) {
  const local = ctx.bindings.get(name);
  if (local) return resolveRoots(local, ctx, hops + 1);
  const known = ctx.keys.get(name);
  if (known === null) return { roots: [], why: `key-name-declared-twice:${name}` };
  if (known === undefined) return { roots: [], why: `key-name-not-declared-in-src:${name}` };
  return { roots: [known], why: null };
}

// ---------------------------------------------------------------------------------------------
// What a body does to the cache.
// ---------------------------------------------------------------------------------------------

/**
 * Walks a body and collects the roots it drops, following calls to functions declared in the same
 * file and to portal-wide helpers by name.
 *
 * Handlers delegate constantly (`invalidate()`, `invalidateRules(qc)`), so a walk that stopped at
 * the call site would read almost every handler as dropping nothing — a check built on that would
 * be red everywhere and switched off within the day.
 */
function collectCacheEffects(node, ctx, acc, hops = 0, seen = new Set()) {
  if (!node || hops > MAX_HOPS) {
    if (hops > MAX_HOPS) acc.why.add('helper-chain-too-deep');
    return;
  }

  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const method = callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;

      if (method && KEY_FIRST_ARG_CALLS.has(method)) {
        readKeyArgument(n, ctx, acc);
      } else if (callee && ts.isIdentifier(callee)) {
        followCall(callee.text, n, ctx, acc, hops, seen);
      }
    }

    // `invalidate: [key, key]` — a list of whole keys handed to a hook that drops them itself.
    if (ts.isPropertyAssignment(n) && KEY_LIST_PROPS.has(propertyName(n.name) ?? '')) {
      const list = unwrap(n.initializer);
      if (ts.isArrayLiteralExpression(list))
        for (const el of list.elements) {
          const { roots, why } = resolveRoots(ts.isSpreadElement(el) ? el.expression : el, ctx);
          roots.forEach((r) => acc.roots.add(r));
          if (why) acc.why.add(why);
        }
      else acc.why.add('invalidate-option-is-not-a-list-literal');
    }

    ts.forEachChild(n, visit);
  };

  visit(node);
}

function readKeyArgument(call, ctx, acc) {
  const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!arg) {
    // `invalidateQueries()` with no filter drops the whole cache; nothing can be stale after it.
    acc.wholeCache = true;
    return;
  }
  if (ts.isObjectLiteralExpression(arg)) {
    const keyProp = arg.properties.find(
      (p) => ts.isPropertyAssignment(p) && propertyName(p.name) === 'queryKey',
    );
    if (keyProp) {
      const { roots, why } = resolveRoots(keyProp.initializer, ctx);
      roots.forEach((r) => acc.roots.add(r));
      if (why) acc.why.add(why);
      return;
    }
    const shorthand = arg.properties.find(
      (p) => ts.isShorthandPropertyAssignment(p) && p.name.text === 'queryKey',
    );
    if (shorthand) {
      const { roots, why } = resolveRoots(shorthand.name, ctx);
      roots.forEach((r) => acc.roots.add(r));
      if (why) acc.why.add(why);
      return;
    }
    if (arg.properties.some((p) => propertyName(p.name ?? undefined) === 'predicate')) {
      acc.why.add('cache-dropped-by-a-predicate-not-by-a-key');
      return;
    }
    acc.wholeCache = true;
    return;
  }
  const { roots, why } = resolveRoots(arg, ctx);
  roots.forEach((r) => acc.roots.add(r));
  if (why) acc.why.add(why);
}

/** A bare call inside a handler: a local helper, a portal-wide helper, or someone else's business. */
function followCall(name, call, ctx, acc, hops, seen) {
  if (seen.has(name)) return;

  const local = ctx.bindings.get(name);
  if (local) {
    const fn = unwrap(local);
    if (
      fn &&
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))
    ) {
      collectCacheEffects(fn.body, ctx, acc, hops + 1, new Set([...seen, name]));
      return;
    }
    /*
     * A local name that is called but is not a function this walk can open: almost always the result
     * of a hook — `const invalidate = useReceiptInvalidation()` — or a destructured handle. Such a
     * value drops the cache as often as not, and RETURNING SILENTLY HERE WAS THE WORST FAILURE THIS
     * SCAN HAD: the mutation came out "fully resolved, drops nothing" and rule 1 blamed a screen
     * whose whole invalidation lives inside that hook. Unresolved is the honest answer.
     */
    acc.why.add(`call-of-a-value-this-walk-cannot-open:${name}`);
    return;
  }

  const helper = ctx.helpers.resolve(name);
  if (helper === null) {
    acc.why.add(`helper-name-declared-twice:${name}`);
    return;
  }
  if (helper) {
    helper.roots.forEach((r) => acc.roots.add(r));
    helper.why.forEach((w) => acc.why.add(w));
    if (helper.wholeCache) acc.wholeCache = true;
    return;
  }

  /*
   * Not a name this walk can see: a parameter (`onDone?.()`), a prop callback, an antd helper, a
   * setState. Those never reach the cache and must not make the whole mutation unresolved — if they
   * did, nearly every handler would be unresolved and the check would guard nothing.
   *
   * The exception is a name that SOUNDS like a cache drop. Such a call is the one case where
   * silence would be a wrong answer rather than an irrelevant one, so it is reported.
   */
  if (/invalidat|refetch|refresh|reload|reset|purge|drop|evict/i.test(name))
    acc.why.add(`unresolved-call-that-may-drop-the-cache:${name}`);
}

/** Every API handle a body reaches, with the HTTP verb the registry knows for it. */
function collectApiCalls(node, ctx, out) {
  if (!node) return;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (callee && ts.isPropertyAccessExpression(callee)) {
        const owner = unwrap(callee.expression);
        if (owner && ts.isIdentifier(owner) && /Api$/.test(owner.text))
          out.add(`${owner.text}.${callee.name.text}`);
      }
    }
    // `purge: driversApi.purge` — a handle passed by reference, never called on the spot.
    if (ts.isPropertyAccessExpression(n)) {
      const owner = unwrap(n.expression);
      if (owner && ts.isIdentifier(owner) && /Api$/.test(owner.text))
        out.add(`${owner.text}.${n.name.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  void ctx;
}

export const __internals = { resolveRoots, collectCacheEffects, collectApiCalls };

// ---------------------------------------------------------------------------------------------
// Mutations of one file.
// ---------------------------------------------------------------------------------------------

const lineOf = (sf, node) =>
  ts.getLineAndCharacterOfPosition(sf, ts.skipTrivia(sf.text, node.pos)).line + 1;

const HANDLERS = ['onSuccess', 'onSettled'];

function optionProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p.name) === name) return p.initializer;
    if (ts.isMethodDeclaration(p) && propertyName(p.name) === name) return p;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

function emptyAcc() {
  return { roots: new Set(), why: new Set(), wholeCache: false };
}

function finish(acc) {
  return {
    invalidates: [...acc.roots].sort(),
    wholeCache: acc.wholeCache,
    unresolved: [...acc.why].sort(),
  };
}

function classifyWrites(handles, ctx) {
  const writes = [];
  const reads = [];
  const unknown = [];
  for (const handle of [...handles].sort()) {
    const verb = ctx.api.get(handle);
    if (verb === undefined) unknown.push(handle);
    else if (verb === null) unknown.push(handle);
    else if (WRITING_METHODS.has(verb) && !isPreviewHandle(handle))
      writes.push(`${handle} ${verb}`);
    else reads.push(`${handle} ${verb}`);
  }
  return { writes, reads, unknown };
}

function scanFileMutations(ctx) {
  const { sf } = ctx;
  const mutations = [];
  const mutationFnRanges = [];

  const visit = (node, hint) => {
    let next = hint;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) next = node.name.text;
    else if (ts.isFunctionDeclaration(node) && node.name) next = node.name.text;
    else if (ts.isMethodDeclaration(node) && propertyName(node.name))
      next = propertyName(node.name);

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = callee && ts.isIdentifier(callee) ? callee.text : undefined;
      const options = node.arguments.map(unwrap).find((a) => a && ts.isObjectLiteralExpression(a));

      if (name === 'useMutation') {
        mutations.push(
          readUseMutation(node, options, hint ?? '<anonymous>', ctx, mutationFnRanges),
        );
      } else if (name && /^use[A-Z]/.test(name) && options) {
        const declared = options.properties.some(
          (p) => ts.isPropertyAssignment(p) && KEY_LIST_PROPS.has(propertyName(p.name) ?? ''),
        );
        if (declared) mutations.push(readDeclaredHook(node, options, name, ctx));
      }
    }

    ts.forEachChild(node, (child) => visit(child, next));
  };

  visit(sf, undefined);
  return { mutations, mutationFnRanges };
}

function readUseMutation(call, options, hint, ctx, mutationFnRanges) {
  const line = lineOf(ctx.sf, call);
  const acc = emptyAcc();
  const handles = new Set();
  const handlers = [];

  if (!options) {
    acc.why.add('useMutation-options-are-not-an-object-literal');
  } else {
    const fn = optionProp(options, 'mutationFn');
    if (fn) {
      mutationFnRanges.push([fn.pos, fn.end]);
      collectApiCalls(fn, ctx, handles);
      if (handles.size === 0) acc.why.add('mutationFn-reaches-no-named-api-handle');
    } else acc.why.add('mutation-without-a-mutationFn');

    for (const h of HANDLERS) {
      const handler = optionProp(options, h);
      if (!handler) continue;
      handlers.push(h);
      collectCacheEffects(handler, ctx, acc);
    }
  }

  const { writes, reads, unknown } = classifyWrites(handles, ctx);
  unknown.forEach((h) => acc.why.add(`api-handle-of-an-unknown-verb:${h}`));

  return {
    id: `${ctx.rel}:${line}:${hint}`,
    file: ctx.rel,
    line,
    name: hint,
    kind: 'useMutation',
    handlers,
    writes,
    reads,
    ...finish(acc),
  };
}

/**
 * A hook that takes the keys to drop as an option (`usePurgeAction({ invalidate: […] })`).
 *
 * The call site is the mutation here, not the hook: the hook's own `useMutation` drops whatever it
 * was handed, and reading it on its own would report a mutation that drops nothing at all.
 */
function readDeclaredHook(call, options, hookName, ctx) {
  const line = lineOf(ctx.sf, call);
  const acc = emptyAcc();
  const handles = new Set();
  collectApiCalls(options, ctx, handles);
  collectCacheEffects(options, ctx, acc);
  if (handles.size === 0) acc.why.add('declared-hook-reaches-no-named-api-handle');

  const { writes, reads, unknown } = classifyWrites(handles, ctx);
  unknown.forEach((h) => acc.why.add(`api-handle-of-an-unknown-verb:${h}`));

  return {
    id: `${ctx.rel}:${line}:${hookName}`,
    file: ctx.rel,
    line,
    name: hookName,
    kind: 'invalidate-option',
    handlers: ['invalidate'],
    writes,
    reads,
    ...finish(acc),
  };
}

/**
 * Writes made outside `useMutation`: a plain `async function submit()` that calls a writing handle.
 *
 * They are part of the inventory because the cache does not care how the write was started — an
 * unrefreshed screen looks the same either way — and the portal has such doors (the vehicle-type
 * editor saves this way). They are collected per ENCLOSING NAMED FUNCTION: the cache drop usually
 * sits a few lines below the write, in the same body.
 */
function scanDirectWrites(ctx, mutationFnRanges) {
  const { sf } = ctx;
  const inMutationFn = (pos) => mutationFnRanges.some(([from, to]) => pos >= from && pos < to);
  const found = new Map();

  const visit = (node, owner) => {
    let next = owner;
    if (ts.isFunctionDeclaration(node) && node.name) next = { name: node.name.text, node };
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        next = { name: node.name.text, node: init };
    } else if (ts.isMethodDeclaration(node) && propertyName(node.name))
      next = { name: propertyName(node.name), node };

    if (ts.isCallExpression(node) && !inMutationFn(node.pos)) {
      const callee = unwrap(node.expression);
      if (callee && ts.isPropertyAccessExpression(callee)) {
        const obj = unwrap(callee.expression);
        if (obj && ts.isIdentifier(obj) && /Api$/.test(obj.text)) {
          const handle = `${obj.text}.${callee.name.text}`;
          const verb = ctx.api.get(handle);
          if (verb && WRITING_METHODS.has(verb) && next) {
            const entry = found.get(next.name) ?? { owner: next, handles: new Set() };
            entry.handles.add(handle);
            found.set(next.name, entry);
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, next));
  };

  visit(sf, undefined);

  return [...found.values()].map(({ owner, handles }) => {
    const acc = emptyAcc();
    collectCacheEffects(owner.node.body ?? owner.node, ctx, acc);
    const line = lineOf(sf, owner.node);
    const { writes, reads, unknown } = classifyWrites(handles, ctx);
    unknown.forEach((h) => acc.why.add(`api-handle-of-an-unknown-verb:${h}`));
    return {
      id: `${ctx.rel}:${line}:${owner.name}`,
      file: ctx.rel,
      line,
      name: owner.name,
      kind: 'direct-call',
      handlers: ['<function body>'],
      writes,
      reads,
      ...finish(acc),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Building the map.
// ---------------------------------------------------------------------------------------------

const CACHE_MENTION = new RegExp([...KEY_FIRST_ARG_CALLS, ...KEY_LIST_PROPS].join('|'));

function buildMap() {
  const files = walkTs(SRC);
  const keys = makeRegistry();
  const api = makeRegistry();
  const objects = makeRegistry();
  const rootOwners = new Map();
  const unresolved = [];
  const parsed = new Map();

  // Pass 1: portal-wide tables. Every file is read; only the ones that can hold a declaration or a
  // mutation are parsed, and only the ones that can hold a mutation are kept.
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    // Every file of a slice's `api/` directory is parsed regardless of what its text looks like: the
    // parts a slice API is spread from are named after what they do (`vehicleRequestLifecycle`), not
    // after the object they end up in, and a pattern looking for `…Api = {` never sees them.
    const declares =
      /createQueryKeys|Api\s*=\s*\{|=\s*\[\s*['"`]/.test(code) || /\/api\//.test(rel(file));
    const acts = /useMutation/.test(code) || CACHE_MENTION.test(code);
    if (!declares && !acts) continue;

    const sf = parseSource(code, file);
    if (sf.parseDiagnostics?.length)
      unresolved.push({ file: rel(file), form: 'whole file', why: 'file-does-not-parse-cleanly' });

    if (declares) {
      harvestKeyRoots(sf, file, keys, rootOwners);
      harvestApi(sf, file, objects, unresolved);
    }
    if (acts) parsed.set(file, sf);
  }

  // Spreads are followed only now: a slice API may be assembled from parts declared in files read
  // after it.
  flattenApiObjects(objects, api, unresolved);

  // Pass 2: portal-wide helper table, resolved on demand so that a helper calling a helper still
  // answers, and a cycle answers once instead of hanging.
  const helperNodes = new Map();
  const helperCache = new Map();
  const computing = new Set();
  const helpers = {
    resolve(name) {
      if (helperCache.has(name)) return helperCache.get(name);
      const decl = helperNodes.get(name);
      if (decl === undefined) return undefined;
      if (decl === null) return null;
      if (computing.has(name)) return { roots: [], why: [], wholeCache: false };
      computing.add(name);
      const acc = emptyAcc();
      collectCacheEffects(decl.node.body ?? decl.node, decl.ctx, acc);
      computing.delete(name);
      const value = { roots: [...acc.roots], why: [...acc.why], wholeCache: acc.wholeCache };
      helperCache.set(name, value);
      return value;
    },
  };

  const contexts = new Map();
  for (const [file, sf] of parsed) {
    const ctx = { rel: rel(file), sf, bindings: collectBindings(sf), keys, api, helpers };
    contexts.set(file, ctx);
    registerHelpers(sf, ctx, helperNodes);
  }

  // Pass 3: the mutations themselves.
  const mutations = [];
  for (const [file, sf] of parsed) {
    const r = rel(file);
    if (!LAYERS.includes(r.split('/')[0])) continue;
    const ctx = contexts.get(file);
    const { mutations: found, mutationFnRanges } = scanFileMutations(ctx);
    mutations.push(...found, ...scanDirectWrites(ctx, mutationFnRanges));
    void sf;
  }

  mutations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name),
  );

  /*
   * The HOME roots of a mutation: the key roots declared in the same slice as the handle it writes
   * through. `driversApi` lives in `entities/driver/api/driversApi.ts`, `driverKeys` in
   * `entities/driver/api/keys.ts` — one slice, so writing through the handle and dropping that root
   * are two halves of one act. Computed from the registries rather than from the key name, because
   * the name proves nothing: `garageKeys` reads like the root of `garage`, and whether it is the
   * home root of `vehiclesApi` depends on which slice declared it.
   *
   * A handle whose slice owns no root leaves the set empty, and rule 2 below then has nothing to
   * require — that is the honest answer for a slice that keeps no cache of its own.
   */
  const rootsBySlice = new Map();
  for (const [root, owner] of rootOwners) {
    const slice = sliceOf(owner);
    if (!slice) continue;
    if (!rootsBySlice.has(slice)) rootsBySlice.set(slice, []);
    rootsBySlice.get(slice).push(root);
  }
  for (const m of mutations) {
    const home = new Set();
    for (const write of m.writes) {
      const handle = write.slice(0, write.indexOf(' '));
      const hit = api.byName.get(handle);
      if (!hit || hit.conflict) {
        m.unresolved.push(`write-handle-declared-twice:${handle}`);
        continue;
      }
      const slice = sliceOf(hit.file);
      // A handle outside a slice (a page calling `apiFetch` itself) has no home root by definition,
      // and saying so out loud beats treating it as "nothing owed".
      if (!slice) m.unresolved.push(`write-handle-outside-a-slice:${handle}`);
      else for (const root of rootsBySlice.get(slice) ?? []) home.add(root);
    }
    m.homeRoots = [...home].sort();
  }

  for (const m of mutations)
    for (const why of m.unresolved)
      unresolved.push({ file: m.file, form: `${m.name} (${m.kind}, line ${m.line})`, why });

  unresolved.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.why.localeCompare(b.why) || a.form.localeCompare(b.form),
  );

  return {
    roots: Object.fromEntries([...rootOwners.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    mutations,
    unresolved,
    totals: {
      mutations: mutations.length,
      byKind: countBy(mutations, (m) => m.kind),
      writing: mutations.filter((m) => m.writes.length > 0).length,
      fullyResolved: mutations.filter((m) => m.unresolved.length === 0).length,
      withUnresolved: mutations.filter((m) => m.unresolved.length > 0).length,
      dropNothing: mutations.filter((m) => m.invalidates.length === 0 && !m.wholeCache).length,
      roots: rootOwners.size,
    },
  };
}

function countBy(items, of) {
  const out = {};
  for (const item of items) out[of(item)] = (out[of(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Named functions of a file, so that a handler calling one of them by name can be followed. */
function registerHelpers(sf, ctx, helperNodes) {
  const remember = (name, node) => {
    if (helperNodes.has(name)) helperNodes.set(name, null);
    else helperNodes.set(name, { node, ctx });
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) remember(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        remember(node.name.text, init);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------
// The two rules.
// ---------------------------------------------------------------------------------------------

/**
 * RULE 1 — a mutation writes to the server and touches no cache at all.
 *
 * Only over FULLY RESOLVED mutations: with anything unresolved the empty effect list means "the
 * scan could not see the effect", and blaming the code for what the scan failed to read is how a
 * check earns its first `eslint-disable`.
 *
 * This does not say every write owes a drop — a file discarded before it was ever attached, a
 * preview, a password change owe nothing. It says the answer must be written down. A legitimate
 * silence is a comment away, and until it is written the reader cannot tell it from the silence of
 * someone who forgot.
 */
function ruleWritesNothingDropped(map) {
  return map.mutations
    .filter(
      (m) =>
        m.writes.length > 0 &&
        m.unresolved.length === 0 &&
        !m.wholeCache &&
        m.invalidates.length === 0,
    )
    .map((m) => ({
      rule: 'writes-nothing-dropped',
      at: `${m.file}:${m.line}`,
      what: `${m.name} пишет ${m.writes.join(', ')} и не гасит ни одного корня`,
    }));
}

/**
 * RULE 2 — a mutation drops SOMEBODY ELSE's root and not its own.
 *
 * The shape of the three defects this check was built after: the screen knows it must refresh
 * something, drops what it reads itself, and misses the root of the very slice whose handle it
 * wrote through. A mutation that drops nothing is rule 1's business; this one fires only where the
 * author already thought about the cache and stopped one root short — which is why it cannot be
 * dismissed as "the check does not know whether a drop is needed here". It is needed: the write
 * went through that slice's own handle.
 */
function ruleHomeRootMissed(map) {
  return map.mutations
    .filter(
      (m) =>
        m.writes.length > 0 &&
        m.unresolved.length === 0 &&
        !m.wholeCache &&
        m.invalidates.length > 0 &&
        m.homeRoots.length > 0 &&
        !m.homeRoots.some((root) => m.invalidates.includes(root)),
    )
    .map((m) => ({
      rule: 'home-root-missed',
      at: `${m.file}:${m.line}`,
      what: `${m.name} гасит ${m.invalidates.join(', ')}, но не свой корень (${m.homeRoots.join(' | ')}) при записи через ${m.writes.join(', ')}`,
    }));
}

// ---------------------------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const map = buildMap();

// The map is written on every run, including a red one: the run that fails is exactly the one whose
// picture somebody is about to read.
writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);

const findings = [...ruleWritesNothingDropped(map), ...ruleHomeRootMissed(map)].sort(
  (a, b) => a.rule.localeCompare(b.rule) || a.at.localeCompare(b.at),
);

const t = map.totals;
console.log(
  `Мутаций ${t.mutations} (пишущих ${t.writing}), корней ${t.roots}; разобрано полностью ${t.fullyResolved}, с неразобранным ${t.withUnresolved}.`,
);
console.log(`Карта: ${path.relative(WEB, MAP_FILE)}`);

// `unresolved` is printed on EVERY run, green or red. A static check of invalidations fails quietly
// in one way only — by understanding nothing and reporting nothing — and the count below is the one
// number that tells that apart from "nothing to report".
if (map.unresolved.length > 0) {
  console.log(
    `Неразобранного: ${map.unresolved.length} (форм: ${countBy(map.unresolved, (u) => u.why) && Object.keys(countBy(map.unresolved, (u) => u.why)).length})`,
  );
  const byWhy = countBy(map.unresolved, (u) => u.why);
  for (const why of Object.keys(byWhy).sort()) console.log(`  · ${why}: ${byWhy[why]}`);
}

// Inventory mode (step Ш0): take the picture, pass no verdict. Used to read the map without the
// queue of known findings standing in the way.
if (args.has('--map')) process.exit(0);

if (findings.length > 0) {
  console.error(`\nИнвалидация кэша нарушена (${findings.length}):`);
  for (const f of findings) console.error(`  — [${f.rule}] ${f.at} — ${f.what}`);
  if (!args.has('--report-only')) process.exit(1);
  process.exit(0);
}

console.log('Инвалидация кэша в порядке.');
