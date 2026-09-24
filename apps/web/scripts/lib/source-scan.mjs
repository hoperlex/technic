/**
 * Shared scan over the portal sources, used by the quality checks.
 *
 * It is a module of its own not for brevity: raw query keys are detected by two checks
 * (`check-stage2-layout` and the quality budgets). Once their copies drift apart they start
 * counting differently, and the disagreement shows up exactly when one of them is being relied on.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Every `.ts`/`.tsx` below the directory, recursively. */
export function walkTs(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/*
 * Where an expression is a cache key rather than an arbitrary array. Membership in these three sets
 * is the whole definition of "raw key": a key is reported only because of where it is *used*, never
 * because of how it looks. `const TABS = ['requests', 'on-site']` and `const KEY = ['drivers']` are
 * indistinguishable as declarations, and only the call site tells them apart — a check that blames
 * the first one is switched off after its first false alarm, and then it guards nothing at all.
 *
 * Widening the detector means adding a name here, not loosening the shape test below.
 */

/** Properties whose value is one key: `queryKey: [...]`, including `(id) => [...]` factories. */
const KEY_PROPS = new Set(['queryKey']);

/**
 * Properties whose value is a LIST of keys. `usePurgeAction({ invalidate })` takes whole keys, not
 * their first segments (see the hook's own comment): every element is a key in its own right.
 */
const KEY_LIST_PROPS = new Set(['invalidate']);

/** `QueryClient` methods that take the key as their first argument. */
const KEY_FIRST_ARG_CALLS = new Set([
  'setQueryData',
  'setQueriesData',
  'getQueryData',
  'getQueriesData',
  'getQueryState',
  'invalidateQueries',
  'removeQueries',
  'cancelQueries',
  'resetQueries',
  'refetchQueries',
  'prefetchQuery',
  'fetchQuery',
  'ensureQueryData',
]);

/*
 * Cheap necessary condition, checked before parsing: a file can hold a raw key only if it opens an
 * array with a string literal AND mentions one of the entry points above. Both are plain text, and
 * neither can be absent from a file that the walk below would report — so the prefilter cannot hide
 * a finding, it only keeps the parser off ~750 of the 819 files of `src`.
 *
 * The mention pattern is built from the sets themselves: written out by hand it would quietly stop
 * matching the day a new entry point is added, and the check would go silent instead of red.
 */
const CACHE_MENTION = new RegExp(
  [...KEY_PROPS, ...KEY_LIST_PROPS, ...KEY_FIRST_ARG_CALLS].join('|'),
);
/** `[` up to the opening quote: whitespace, line breaks and comments may stand between them. */
const ARRAY_OPENED_BY_STRING = /\[(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"`]/;

/**
 * Parsing a `.ts` file as TSX breaks on the generic arrow `<T>(x: T) => x`, parsing a `.tsx` file as
 * TS breaks on JSX; either way the tree past the breakage is mangled and detections are lost
 * silently. The file name says which kind to use, but the budgets call us with the source alone
 * (`quality.mjs` is a protected file and keeps its one-argument call), so the kind is confirmed by
 * the parser itself: a tree with parse errors is retried in the other kind and the better one wins.
 *
 * `parseDiagnostics` is internal to TypeScript. If a future version stops exposing it the retry
 * simply never fires and the preferred kind stands — the same behaviour as having no retry at all.
 */
function parseSource(code, fileName) {
  const preferTsx = !fileName || fileName.endsWith('.tsx');
  const parse = (kind) =>
    ts.createSourceFile(fileName ?? 'source.tsx', code, ts.ScriptTarget.Latest, false, kind);

  const first = parse(preferTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const firstErrors = first.parseDiagnostics?.length ?? 0;
  if (firstErrors === 0) return first;

  const second = parse(preferTsx ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  return (second.parseDiagnostics?.length ?? 0) < firstErrors ? second : first;
}

/**
 * Names declared in this file, mapped to what they were declared as.
 *
 * A name declared twice is recorded as `null` — unknown. Scopes are not tracked on purpose: the
 * answer is a single boolean per file, and following scopes would only matter for a name reused
 * with two different meanings. In that case we prefer to miss the key over blaming an array that
 * merely shares a name with one.
 */
function collectBindings(sf) {
  const bindings = new Map();
  const remember = (name, node) => bindings.set(name, bindings.has(name) ? null : node);

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      remember(node.name.text, node.initializer);
    else if (ts.isFunctionDeclaration(node) && node.name) remember(node.name.text, node);
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return bindings;
}

/** Hops through names and calls: a bound on mutually referring declarations, not on nesting depth. */
const MAX_HOPS = 8;

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node))
  )
    node = node.expression;
  return node;
}

/**
 * The shape of a raw key: an array opened by a string, `['vehicle-requests', id]`. A key built by a
 * slice factory (`vehicleRequestKeys.detail(id)`) or opened by a spread never looks like this, and
 * that difference is the only thing the shape test has to make.
 */
function startsWithString(node) {
  const first = ts.isArrayLiteralExpression(node) ? node.elements[0] : undefined;
  return !!first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first));
}

/** Does this expression, standing in a key position, deliver a key written out in this file? */
function isRawKey(node, bindings, hops = 0) {
  const expr = unwrap(node);
  if (!expr || hops > MAX_HOPS) return false;
  if (startsWithString(expr)) return true;

  // `queryKey: SCHEDULES_KEY` — the literal sits in the declaration, which is why the old regexp
  // over the call site alone could not see it.
  if (ts.isIdentifier(expr)) {
    const declared = bindings.get(expr.text);
    return declared ? isRawKey(declared, bindings, hops + 1) : false;
  }

  // `queryKey: (id) => ['waste-requests', id]` — the key is the return value, and the prop takes the
  // factory rather than the key itself.
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isFunctionDeclaration(expr))
    return returnsRawKey(expr, bindings, hops + 1);

  // `queryKey: listKey(params)` — only local names are followed; an imported factory is by
  // definition a key that lives in its slice, which is where keys belong.
  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);
    return callee && ts.isIdentifier(callee) ? isRawKey(callee, bindings, hops + 1) : false;
  }

  if (ts.isConditionalExpression(expr))
    return (
      isRawKey(expr.whenTrue, bindings, hops + 1) || isRawKey(expr.whenFalse, bindings, hops + 1)
    );

  return false;
}

function returnsRawKey(fn, bindings, hops) {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return isRawKey(fn.body, bindings, hops);

  let found = false;
  const visit = (node) => {
    if (found) return;
    // A nested function returns its own value, not this one's.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    )
      return;
    if (ts.isReturnStatement(node)) {
      if (node.expression && isRawKey(node.expression, bindings, hops)) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(fn.body, visit);
  return found;
}

/** Same question for a list position: `invalidate: [['vehicle-specs'], objectKeys.root]`. */
function listHoldsRawKey(node, bindings, hops = 0) {
  const expr = unwrap(node);
  if (!expr || hops > MAX_HOPS) return false;

  if (ts.isArrayLiteralExpression(expr))
    return expr.elements.some((el) =>
      isRawKey(ts.isSpreadElement(el) ? el.expression : el, bindings, hops + 1),
    );
  if (ts.isIdentifier(expr)) {
    const declared = bindings.get(expr.text);
    return declared ? listHoldsRawKey(declared, bindings, hops + 1) : false;
  }
  return false;
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * Does the file reach the query cache with a key written out on the spot?
 *
 * Walks the syntax tree instead of matching text. The regexp this replaced saw only a literal
 * standing directly at the call site, and so missed three forms that are used across the portal: a
 * key put in a constant first, a key handed to the `invalidate` prop as `[['vehicle-specs']]`, and
 * a key built by an arrow (`queryKey: (id) => ['waste-requests', id]`). Each of them returns a
 * literal key to the cache, and each of them went uncounted by the `rawKeyFiles` ratchet.
 *
 * `fileName` is optional so that the protected `quality.mjs` keeps working unchanged; passing it
 * only spares the kind retry in `parseSource`.
 *
 * The answer stays one boolean per file. Naming the key's root and keeping an `unresolved` list
 * (docs/frontend-barriers-stage.md, К2) needs new figures in `quality.mjs` and `quality-budget.json`
 * — both protected — so it is not part of this walk, and a key this walk cannot make sense of is
 * silently left alone rather than reported.
 */
export function hasRawQueryKey(code, fileName) {
  if (!ARRAY_OPENED_BY_STRING.test(code) || !CACHE_MENTION.test(code)) return false;

  const sf = parseSource(code, fileName);
  const bindings = collectBindings(sf);
  let found = false;

  const visit = (node) => {
    if (found) return;

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && KEY_PROPS.has(name) && isRawKey(node.initializer, bindings)) found = true;
      else if (name && KEY_LIST_PROPS.has(name) && listHoldsRawKey(node.initializer, bindings))
        found = true;
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const name = node.name.text;
      if (KEY_PROPS.has(name) && isRawKey(node.name, bindings)) found = true;
      else if (KEY_LIST_PROPS.has(name) && listHoldsRawKey(node.name, bindings)) found = true;
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = propertyName(node.name);
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
      if (value && name && KEY_PROPS.has(name) && isRawKey(value, bindings)) found = true;
      else if (value && name && KEY_LIST_PROPS.has(name) && listHoldsRawKey(value, bindings))
        found = true;
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : callee && ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      // The options form (`invalidateQueries({ queryKey })`) is caught by the property branch above;
      // here only the bare-key form of the same methods is left.
      if (
        name &&
        KEY_FIRST_ARG_CALLS.has(name) &&
        node.arguments.length > 0 &&
        isRawKey(node.arguments[0], bindings)
      )
        found = true;
    }

    if (!found) ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** Keys are what `keys.ts` is made of — strings are at home there. */
export function isEntityKeysFile(relPath) {
  return relPath.startsWith(`entities${path.sep}`) && relPath.includes(`api${path.sep}keys`);
}
