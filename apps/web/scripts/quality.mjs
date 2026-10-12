#!/usr/bin/env node
/**
 * Front-end quality budgets: figures that are only allowed to go down.
 *
 * Why this on top of the linter and the layout checks. `max-lines` was a warning then and blocked
 * nothing (an error since ADR 0228, with a looser measure — see `LINE_LIMIT`);
 * `check-stage2-layout` is about what was postponed, not about what grows. Within one week three
 * pages gained 1369 lines and `resources.ts` 224, and not a single check turned red. A budget
 * catches exactly growth: it asks for no fix today, but does not let the debt grow unnoticed.
 *
 * Two modes, separate on purpose:
 *   check  — read-only; fails both on growth and on an improvement that is not written down;
 *   update — rewrites the budget, but ONLY in the direction of improvement.
 *
 * `check` runs from `pretest`, so it has no right to write to the tree: a budget edit made silently
 * in the middle of a test run is too easy to leave uncommitted, and the ratchet would loosen by
 * itself. A relaxation (a figure going up) is not made by `update` either: it is edited by hand,
 * where review sees it.
 *
 * Most figures are counts. Named lists (stage 5 plan, §5) cover whole-cache invalidations,
 * timers and server lists without placeholder handling: the question is "which ones". A new place
 * must not hide behind an old one going away. A list compares as a set
 * (see `compareList`).
 *
 * Run: pnpm --filter @technic/web quality:check | quality:update
 * Plan: docs/frontend-followup-plan.md, barriers Б1 and Б2; the query figures — the front-end
 * stage 5 plan (queries and rendering), invariants 4–5 and §5, wave 2a1.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  walkTs,
  hasRawQueryKey,
  isEntityKeysFile,
  collectBindings,
  propertyName,
  unwrap,
} from './lib/source-scan.mjs';

const WEB = path.resolve(process.cwd());
const SRC = path.join(WEB, 'src');
const BUDGET_FILE = path.join(WEB, 'quality-budget.json');

/*
 * The threshold is shared with `max-lines` in eslint.config.mjs: two numbers would drift apart at
 * the first edit. The measure differs: lint counts without blank lines and comments, here lines are
 * raw — the ones a person sees in the editor. The budget is therefore strictly stricter than lint:
 * a file over the limit here may be silent in lint, and a file lint reports is always over it here.
 *
 * The measures are not aligned on purpose. Dropping `skipComments` in lint would punish a comment,
 * and here a comment carries a design decision, not noise; counting the lint way here would take
 * part of the long files out of the ratchet altogether. Both now fail a run — lint at `error`
 * since ADR 0228 — but this is the gate: it holds the ratchet and the raw measure, while lint names
 * the file in the editor.
 */
const LINE_LIMIT = 400;

/** Каталоги, оставшиеся от раскладки до FSD. Новый файл здесь — повод решить, куда он относится. */
const LEGACY_DIRS = ['hooks', 'utils', 'components'];

/**
 * Устаревшее в antd 6: пропсы, которых в следующем мажоре не будет.
 *
 * Ключ — имя элемента ровно так, как оно написано в JSX. Это не педантизм: `direction` законен у
 * `Flex`, `type` — у `Button` и `Typography.Text`, `message` — у `Form.Item`, `width` — у `Modal`.
 * Текстовый греп посчитал бы всё это долгом, число перестало бы что-либо значить, и ратчет
 * пришлось бы отключить первым же честным `<Flex direction=…>`.
 */
const DEPRECATED_PROPS = {
  Space: ['direction', 'split'],
  Divider: ['type'],
  Alert: ['message'],
  Descriptions: ['labelStyle'],
  Drawer: ['width', 'destroyOnClose'],
  Dropdown: ['destroyOnClose'],
  InputNumber: ['addonBefore', 'addonAfter'],
  Select: ['onDropdownVisibleChange'],
  Spin: ['tip'],
};

/** `List` уходит целиком, а не пропсом: каждое употребление — место будущей замены вёрсткой. */
const DEPRECATED_TAGS = ['List', 'List.Item', 'List.Item.Meta'];

/**
 * Пункты `Timeline` строятся не в теге, а в помощнике-`map`, и привязать ключ объекта к тегу
 * статически нечем. Отличаем по соседям: у пункта `Timeline` подписи нет вовсе (`label` там тоже
 * устарел), а у пункта `Descriptions`, где `children` совершенно законен, она есть всегда.
 * Правило заведомо неполное — пункт с `label` и `children` мы пропустим, — но лучше недосчитать,
 * чем записать в долг чужой законный ключ.
 */
function isTimelineItemChildren(node, sf) {
  if (!ts.isPropertyAssignment(node) || node.name.getText(sf) !== 'children') return false;
  const owner = node.parent;
  return (
    ts.isObjectLiteralExpression(owner) &&
    !owner.properties.some((p) => p.name && p.name.getText(sf) === 'label')
  );
}

/**
 * One parse per file, shared by every figure that walks the tree: parsing is most of the run, and
 * `pretest` waits for it. Parent links are on — the stage 5 figures walk upwards from a node.
 */
function parseFile(file, code) {
  // The kind follows the extension rather than always TSX: a `.ts` file parsed as TSX breaks on the
  // generic arrow `<T>(x: T) => x`, and the tree past that point cannot be counted.
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}

/** How many deprecated antd props and components one file has. */
function countAntdDeprecated(sf, code) {
  const hasTimeline = /<Timeline[\s/>]/.test(code);
  let found = 0;

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (DEPRECATED_TAGS.includes(tag)) found += 1;
      const props = DEPRECATED_PROPS[tag] ?? [];
      if (props.length > 0)
        for (const attr of node.attributes.properties)
          if (ts.isJsxAttribute(attr) && props.includes(attr.name.getText(sf))) found += 1;
    }
    if (hasTimeline && isTimelineItemChildren(node, sf)) found += 1;
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

// --- query hygiene (stage 5: freshness, whole-cache drops, timers) -----------

/**
 * The one module allowed to write freshness numbers (stage 5 plan, §4.1): profiles and the client
 * defaults live there, and every other read either spreads a profile from it or says why it does
 * not.
 */
const QUERY_CONFIG = path.join('src', 'shared', 'config', 'query.ts');

/**
 * Query options that decide how old server data may get and when it is fetched again. Written
 * outside `QUERY_CONFIG`, each one is a freshness decision of its own, and invariant 4 of the plan
 * lets it stand only with a marker next to it: the next reader learns it is deliberate, and the
 * profile wave (3a1) learns what it must not fold into a profile.
 *
 * `refetchIntervalInBackground` is not named by the plan. It is listed because it only changes how
 * an interval behaves, and intervals are exactly what this list is about.
 */
const FRESHNESS_OPTIONS = new Set([
  'staleTime',
  'gcTime',
  'refetchOnWindowFocus',
  'refetchOnMount',
  'refetchOnReconnect',
  'refetchInterval',
  'refetchIntervalInBackground',
]);

/**
 * Cheap text prefilter: a file that names none of these holds none of the three findings, because
 * every one of them is an option or a call spelled with exactly these letters. It keeps the walk
 * below off ~85% of `src`.
 */
const HYGIENE_MENTION =
  /staleTime|gcTime|refetchOn|refetchInterval|invalidateQueries|setInterval|setTimeout/;

/**
 * `query-freshness: <PROFILE|exception> — <reason in English>`. The first word is either a key of
 * `QUERY_PROFILE` in `QUERY_CONFIG` (a read that takes one number of a profile on purpose, like
 * PICK over a DICTIONARY factory) or `exception`. The profile names are read from the module rather
 * than listed here: a second list would accept a profile the module no longer has.
 *
 * A comment that carries the word but not this shape marks nothing. It is not an error of its own —
 * prose may well mention the marker — but the place it stands next to stays counted, and the growth
 * message names what is wrong with it.
 */
const MARKER_WORD = 'query-freshness:';
const MARKER = /query-freshness:[ \t]*([A-Za-z_]+)[ \t]*[—–-][ \t]*(\S[^\r\n]*)/;

/** Hops through local functions when following a timer callback: a bound on mutual recursion. */
const REARM_HOPS = 8;

function readProfileNames() {
  const file = path.join(WEB, QUERY_CONFIG);
  const names = new Set();
  if (!existsSync(file)) return names;
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'QUERY_PROFILE'
    ) {
      const value = unwrap(node.initializer);
      if (value && ts.isObjectLiteralExpression(value))
        for (const prop of value.properties) {
          const name = prop.name && propertyName(prop.name);
          if (name) names.add(name);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Is a marker valid? `undefined` when it is, otherwise what is wrong with it, for the message. */
function markerFault(text, profiles) {
  const match = text.match(MARKER);
  if (!match) return 'ожидается «query-freshness: <PROFILE|exception> — <reason in English>»';
  const [, word, reason] = match;
  if (word !== 'exception' && !profiles.has(word))
    return `«${word}» — не профиль из ${QUERY_CONFIG} и не exception`;
  if (/[\u0400-\u04FF]/.test(reason) || !/[A-Za-z]/.test(reason))
    return 'причина пишется по-английски';
  return undefined;
}

/**
 * The comment that holds a position, or `undefined` when the position is code, a string or JSX text
 * — so a marker spelled inside a string literal marks nothing.
 *
 * Comments are not nodes: they live in the trivia before a token, and a comment between two
 * properties, after a comma or before a closing brace sits before a punctuation token that
 * `forEachChild` never visits. So the walk descends through `getChildren`, which yields those tokens
 * too, and only along the path to the position — cheap enough to run for every marker. JSDoc nodes
 * are passed over: they overlap the trivia they were parsed from. The trivia before a token holds
 * the previous token's trailing comments (same line) and then this token's leading ones; TypeScript
 * hands them out by two functions, so both are asked.
 */
function commentAround(sf, at) {
  let node = sf;
  for (;;) {
    const children = node.getChildren(sf);
    if (children.length === 0) break;
    const holder = children.find(
      (c) =>
        !(c.kind >= ts.SyntaxKind.FirstJSDocNode && c.kind <= ts.SyntaxKind.LastJSDocNode) &&
        c.pos <= at &&
        at < c.end,
    );
    if (!holder) return undefined;
    node = holder;
  }
  if (node.kind === ts.SyntaxKind.JsxText || at >= node.getStart(sf)) return undefined;
  return [
    ...(ts.getTrailingCommentRanges(sf.text, node.pos) ?? []),
    ...(ts.getLeadingCommentRanges(sf.text, node.pos) ?? []),
  ].find((range) => range.pos <= at && at < range.end);
}

/** Comments that carry the marker word, each once, whatever their shape. */
function markerComments(sf, code) {
  const found = new Map();
  for (let at = code.indexOf(MARKER_WORD); at !== -1; at = code.indexOf(MARKER_WORD, at + 1)) {
    const range = commentAround(sf, at);
    if (range) found.set(range.pos, range);
  }
  return [...found.values()];
}

/** Does a comment start a line of its own, i.e. nothing but indentation stands before it? */
function standsOnOwnLine(text, pos) {
  return /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos));
}

/** The statement (or class member) that contains a node: the unit a comment above code annotates. */
function statementOf(node) {
  let current = node;
  for (let up = node.parent; up; current = up, up = up.parent)
    if (
      ts.isSourceFile(up) ||
      ts.isBlock(up) ||
      ts.isModuleBlock(up) ||
      ts.isCaseClause(up) ||
      ts.isDefaultClause(up) ||
      ts.isClassLike(up)
    )
      return current;
  return current;
}

/**
 * Is a freshness option marked? A marker counts when it stands — on the syntax tree, not by line
 * distance —
 *   1. inside the braces of the object literal that holds the option: above it, at the end of its
 *      line, beside a neighbouring option; or
 *   2. on its own line(s) directly above the statement that contains that object: the JSDoc of a
 *      factory `export const xQuery = () => queryOptions({ … })`, the comment above
 *      `const { data } = useQuery({ … })`.
 * One marker covers every option of its object (1) or of its statement (2): an exception is one
 * decision per read, not one per number. A comment higher up — at the top of the hook, above the
 * function that returns the read — does not count, nor does a comment after the closing brace: in
 * trivia it belongs to the NEXT statement, and taking it would mark the neighbour instead. The
 * reason has to stand where the next reader of this read looks.
 */
function markerNear(option, sf, markers) {
  const holder = option.parent;
  const statement = statementOf(holder);
  const from = holder.getStart(sf);
  const statementStart = statement.getStart(sf);
  return markers.filter(
    (m) =>
      (m.pos >= from && m.end <= holder.end) ||
      (m.pos >= statement.pos && m.end <= statementStart && m.ownLine),
  );
}

/**
 * The name a function or class goes by, and whether that name is a binding the code can call.
 * Arrows take the name of what they are assigned to; a property or JSX attribute name is good for
 * reading a place id (`onImported`) but is not a binding — a callback calling a prop that happens to
 * be named like the handler around it is not recursion.
 */
function scopeName(node, sf) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
    return { text: node.name.text, binding: true };
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const text = propertyName(node.name);
    return text && { text, binding: false };
  }
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isClassExpression(node))
    return undefined;
  if (node.name) return { text: node.name.text, binding: true };
  let owner = node.parent;
  while (owner && (ts.isParenthesizedExpression(owner) || ts.isAsExpression(owner)))
    owner = owner.parent;
  if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name))
    return { text: owner.name.text, binding: true };
  if (owner && ts.isPropertyAssignment(owner)) {
    const text = propertyName(owner.name);
    return text && { text, binding: false };
  }
  if (owner && ts.isJsxExpression(owner) && owner.parent && ts.isJsxAttribute(owner.parent))
    return { text: owner.parent.name.getText(sf), binding: false };
  return undefined;
}

function enclosingScopes(node, sf) {
  const scopes = [];
  for (let up = node.parent; up; up = up.parent) {
    const name = scopeName(up, sf);
    if (name) scopes.unshift(name);
  }
  return scopes;
}

/**
 * A place in a named list is `<file> › <enclosing named functions> [› <kind>]`, e.g.
 * `src/pages/directories/DirectoriesPage.tsx › DirectoriesPage › refreshOnSwitch`. Not a line
 * number: an import added above would move the line, the list would see one place gone and one
 * appeared, and `pretest` would turn red on an edit that changed nothing — in files that later
 * waves of the plan do edit, and in a budget that is a protected file. The name changes only when
 * the code around the place is renamed or moved, which is a change review should see anyway. Two
 * places under one name are told apart by order: ` #2`.
 */
function placeId(rel, node, sf, kind) {
  const scopes = enclosingScopes(node, sf).map((s) => s.text);
  return [rel, ...(scopes.length > 0 ? scopes : ['<module>']), ...(kind ? [kind] : [])].join(' › ');
}

function calleeName(call) {
  const callee = unwrap(call.expression);
  if (callee && ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return callee && ts.isIdentifier(callee) ? callee.text : undefined;
}

/**
 * `invalidateQueries()` that drops the whole cache: no filters at all, `undefined`, or an object
 * literal with neither `queryKey` nor `predicate`. `{ type: 'active' }` and `{ refetchType }` stay
 * whole-cache: they say which entries refetch, not which are invalidated. Filters handed over as a
 * value, or an object with a spread or a computed name, cannot be judged here and are left alone —
 * failing towards silence, like the raw-key walk.
 */
function dropsWholeCache(call) {
  if (calleeName(call) !== 'invalidateQueries') return false;
  const filters = unwrap(call.arguments[0]);
  if (!filters || ts.isVoidExpression(filters)) return true;
  if (ts.isIdentifier(filters)) return filters.text === 'undefined';
  if (!ts.isObjectLiteralExpression(filters)) return false;
  return filters.properties.every((prop) => {
    if (ts.isSpreadAssignment(prop)) return false;
    const name = propertyName(prop.name);
    return name !== undefined && name !== 'queryKey' && name !== 'predicate';
  });
}

/** `refetchInterval: false` (or `0`) switches polling off — it is not a timer. */
function setsInterval(option) {
  if (ts.isShorthandPropertyAssignment(option)) return true;
  const value = unwrap(option.initializer);
  return !(
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(value) && Number(value.text) === 0) ||
    (ts.isIdentifier(value) && value.text === 'undefined')
  );
}

/** An identifier that refers to a binding, as opposed to naming a property or declaring a name. */
function isReference(id) {
  const parent = id.parent;
  if (!parent || parent.name !== id) return true;
  return !(
    ts.isPropertyAccessExpression(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isJsxAttribute(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent)
  );
}

function isFunctionValue(node) {
  const value = unwrap(node);
  return (
    !!value &&
    (ts.isFunctionDeclaration(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value))
  );
}

/**
 * Does this `setTimeout` arm its own function again — a poller? It does when its callback reaches,
 * directly or through local functions of this file, the name of a function the call sits in:
 * `const ask = async () => { …; timer = setTimeout(() => void ask(), POLL_MS); }`, or
 * `function tick() { …; setTimeout(tick, ms); }`. The call that starts such a loop from outside
 * (`timer = setTimeout(() => void ask(), 0)`) is not a second timer — it is not inside `ask`.
 *
 * A single delayed action is not a timer (invariant 5): a debounce, a scroll after layout, a load
 * timeout. None of them reaches its enclosing function, so none is counted.
 *
 * Out of reach, failing towards silence: a loop re-armed by React — an effect that sets a timeout
 * and lists, among its dependencies, state that the timeout itself changes — and recursion through
 * `this.method()` or a function imported from another file.
 */
function rearmsItself(call, sf, bindings) {
  const own = new Set(
    enclosingScopes(call, sf)
      .filter((s) => s.binding)
      .map((s) => s.text),
  );
  const callback = call.arguments[0];
  if (own.size === 0 || !callback) return false;

  const opened = new Set();
  const reaches = (node, hops) => {
    let hit = false;
    const visit = (child) => {
      if (hit) return;
      if (ts.isIdentifier(child) && isReference(child)) {
        if (own.has(child.text)) {
          hit = true;
          return;
        }
        const declared = bindings.get(child.text);
        if (declared && hops < REARM_HOPS && !opened.has(child.text) && isFunctionValue(declared)) {
          opened.add(child.text);
          if (reaches(declared, hops + 1)) {
            hit = true;
            return;
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return hit;
  };
  return reaches(callback, 0);
}

/**
 * The three stage 5 figures of one file:
 *   freshness — options of `FRESHNESS_OPTIONS` outside `QUERY_CONFIG`, each with its marker
 *     verdict; one place per written option, so the figure falls by one as each gets a profile;
 *   invalidations — `invalidateQueries` calls dropping the whole cache (`dropsWholeCache`);
 *   timers — `setInterval`, a non-false `refetchInterval` (counted wherever it is written, the
 *     config module included: a profile with an interval is still a timer) and a `setTimeout` that
 *     re-arms itself (`rearmsItself`).
 */
function scanQueryHygiene(sf, rel, code, profiles) {
  const found = { freshness: [], invalidations: [], timers: [] };
  if (!HYGIENE_MENTION.test(code)) return found;

  const inConfig = rel === QUERY_CONFIG;
  const markers = code.includes(MARKER_WORD)
    ? markerComments(sf, code).map((c) => ({
        pos: c.pos,
        end: c.end,
        ownLine: standsOnOwnLine(code, c.pos),
        fault: markerFault(code.slice(c.pos, c.end), profiles),
      }))
    : [];
  let bindings;
  const taken = new Map();
  const place = (node, placeKind) => {
    const base = placeId(rel, node, sf, placeKind);
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return { id: n === 1 ? base : `${base} #${n}`, line };
  };

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && FRESHNESS_OPTIONS.has(name) && !inConfig) {
        const near = markerNear(node, sf, markers);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.freshness.push({
          at: `${rel}:${line} ${name}`,
          marked: near.some((m) => m.fault === undefined),
          fault: near.find((m) => m.fault !== undefined)?.fault,
        });
      }
      if (name === 'refetchInterval' && setsInterval(node))
        found.timers.push(place(node, 'refetchInterval'));
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (dropsWholeCache(node)) found.invalidations.push(place(node));
      else if (name === 'setInterval') found.timers.push(place(node, 'setInterval'));
      else if (name === 'setTimeout' && rearmsItself(node, sf, (bindings ??= collectBindings(sf))))
        found.timers.push(place(node, 'setTimeout'));
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/**
 * A `useListParams` owner needs the list helper in the same function. This deliberately counts
 * client-paged and address-only uses until they carry a local exception marker: a new server list
 * must not hide behind an unclassified call in the same file. The check does not infer data flow
 * across functions; every list state owner in this portal also owns its query.
 */
function scanUnheldLists(sf, rel, code) {
  if (!code.includes('useListParams')) return [];
  const found = [];
  const taken = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === 'useListParams') {
      let owner = node.parent;
      while (
        owner &&
        !ts.isFunctionDeclaration(owner) &&
        !ts.isArrowFunction(owner) &&
        !ts.isFunctionExpression(owner) &&
        !ts.isMethodDeclaration(owner)
      )
        owner = owner.parent;
      let hasHelper = false;
      const findHelper = (child) => {
        if (ts.isCallExpression(child) && calleeName(child) === 'listQueryOptions')
          hasHelper = true;
        if (!hasHelper) ts.forEachChild(child, findHelper);
      };
      if (owner) findHelper(owner);
      let statement = node.parent;
      while (
        statement &&
        !ts.isVariableStatement(statement) &&
        !ts.isExpressionStatement(statement)
      )
        statement = statement.parent;
      const comments = statement
        ? (ts.getLeadingCommentRanges(code, statement.getFullStart()) ?? [])
        : [];
      const exception = comments.some(({ pos, end }) =>
        /list-query: exception — [A-Za-z]/.test(code.slice(pos, end)),
      );
      if (!hasHelper && !exception) {
        const base = placeId(rel, node, sf);
        const n = (taken.get(base) ?? 0) + 1;
        taken.set(base, n);
        found.push({
          id: n === 1 ? base : `${base} #${n}`,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// --- measurement -------------------------------------------------------------

function measure() {
  const legacyFiles = {};
  for (const dir of LEGACY_DIRS) {
    const full = path.join(SRC, dir);
    // A directory that is gone has been taken apart: zero, not a gap. A gap would read as "not
    // measured".
    legacyFiles[dir] = existsSync(full)
      ? walkTs(full).filter((f) => path.dirname(f) === full).length
      : 0;
  }

  let rawKeyFiles = 0;
  let antdDeprecated = 0;
  const maxLines = {};
  const profiles = readProfileNames();
  const freshness = [];
  const invalidations = [];
  const timers = [];
  const unheldLists = [];
  for (const file of walkTs(SRC)) {
    const rel = path.relative(WEB, file);
    const code = readFileSync(file, 'utf8');

    if (!isEntityKeysFile(path.relative(SRC, file)) && hasRawQueryKey(code)) rawKeyFiles += 1;
    const sf = parseFile(file, code);
    antdDeprecated += countAntdDeprecated(sf, code);

    const hygiene = scanQueryHygiene(sf, rel, code, profiles);
    freshness.push(...hygiene.freshness);
    invalidations.push(...hygiene.invalidations);
    timers.push(...hygiene.timers);
    unheldLists.push(...scanUnheldLists(sf, rel, code));

    /*
     * Lines in a file are counted by line breaks, not by the pieces of a split. `split('\n')` of a
     * file ending with a newline (every file has one, prettier puts it there) yields one piece too
     * many: the last one is the empty string after the final `\n`. A file of exactly 400 lines was
     * counted as 401 and declared "longer than 400" — which is what happened to
     * `ServiceRequestForm.tsx` and turned the gate red on a file that did not break the limit.
     *
     * The figure has to match what a person sees in the editor and in `wc -l`, and the requirement
     * rests on the person, not on the linter: `max-lines` has a measure of its own, without blank
     * lines and comments (see the header at `LINE_LIMIT`). The budget counts raw lines because raw
     * lines are what people argue about: "I have 400 and the gate says 401" is settled by opening
     * the editor, not by reading rule settings.
     */
    const lines = code.replace(/\n$/, '').split('\n').length;
    if (lines > LINE_LIMIT) maxLines[rel] = lines;
  }

  const unmarked = freshness.filter((option) => !option.marked);
  const ids = (places) => places.map((p) => p.id).sort();
  return {
    // What the budget records: `update` writes this object as it is.
    figures: {
      legacyFiles,
      rawKeyFiles,
      antdDeprecated,
      maxLines,
      queryFreshnessUnmarked: unmarked.length,
      unfilteredInvalidations: ids(invalidations),
      timers: ids(timers),
      unheldLists: ids(unheldLists),
    },
    // Where things are, for the messages only: line numbers stay out of the budget (see `placeId`).
    places: {
      unmarked: unmarked.map((o) =>
        o.fault ? `${o.at} — маркер рядом не годится: ${o.fault}` : o.at,
      ),
      line: new Map([...invalidations, ...timers, ...unheldLists].map((p) => [p.id, p.line])),
    },
  };
}

// --- comparison with the budget ----------------------------------------------

/**
 * Growth is an error, an improvement is a reason to update the budget. Kept apart on purpose: the
 * first is fixed by the author of the change, the second is done by `quality:update` in one command,
 * and both show in the commit diff.
 */
function compare(actual, budget, places) {
  const grown = [];
  const improved = [];

  for (const dir of LEGACY_DIRS) {
    const was = budget.legacyFiles?.[dir];
    if (was === undefined) {
      grown.push(`бюджет не знает каталога src/${dir} — обновите его через quality:update`);
      continue;
    }
    const now = actual.legacyFiles[dir];
    if (now > was)
      grown.push(
        `src/${dir}: файлов ${now}, бюджет ${was} — разложите новый файл по слоям либо поднимите бюджет руками, с причиной`,
      );
    if (now < was) improved.push(`src/${dir}: ${was} → ${now}`);
  }

  if (actual.rawKeyFiles > budget.rawKeyFiles)
    grown.push(
      `файлов с сырыми ключами: ${actual.rawKeyFiles}, бюджет ${budget.rawKeyFiles} — ключи новых запросов заводятся в entities/*/api/keys`,
    );
  if (actual.rawKeyFiles < budget.rawKeyFiles)
    improved.push(`сырые ключи: ${budget.rawKeyFiles} → ${actual.rawKeyFiles}`);

  // The figure is at zero since 2026-10-12 (roadmap Q8: `List` became `ItemList`, `InputNumber`
  // addons `FieldAddons` / `Space.Compact`, the rest the current prop names), and its budget keeps it
  // there: the portal is on antd 6.5 already, and the next major drops these props. `Space` and
  // `Divider` are also guarded by no-restricted-syntax.
  // The figure is new and the budget may not know it yet. That is not growth: in `grown` it would
  // block the very `quality:update` that records it, so it goes to `improved`.
  if (budget.antdDeprecated === undefined)
    improved.push(`устаревшее antd: бюджет числа не знает → ${actual.antdDeprecated}`);
  else if (actual.antdDeprecated > budget.antdDeprecated)
    grown.push(
      `устаревших пропсов antd: ${actual.antdDeprecated}, бюджет ${budget.antdDeprecated} — новый код пишется на нынешних именах (см. DEPRECATED_PROPS в этом файле)`,
    );
  else if (actual.antdDeprecated < budget.antdDeprecated)
    improved.push(`устаревшее antd: ${budget.antdDeprecated} → ${actual.antdDeprecated}`);

  const budgetLines = budget.maxLines ?? {};
  for (const [file, now] of Object.entries(actual.maxLines)) {
    const was = budgetLines[file];
    // A new long file is growth too, although no old figure changed. Without this branch the limit
    // is bypassed by creating one more file of 900 lines.
    if (was === undefined)
      grown.push(`${file}: ${now} строк — новый файл длиннее ${LINE_LIMIT}; разделите его`);
    else if (now > was) grown.push(`${file}: ${now} строк, бюджет ${was}`);
    else if (now < was) improved.push(`${file}: ${was} → ${now}`);
  }
  for (const [file, was] of Object.entries(budgetLines)) {
    if (actual.maxLines[file] === undefined)
      improved.push(`${file}: ${was} → ниже ${LINE_LIMIT} (или файла нет)`);
  }

  // Stage 5, invariant 4: a freshness number outside the config module is a profile or a marked
  // exception. The figure goes to zero in wave 3a1; until then it may only fall. A new figure the
  // budget does not know yet is recorded through `improved`, for the reason given at antd above.
  const unmarkedWas = budget.queryFreshnessUnmarked;
  const unmarkedNow = actual.queryFreshnessUnmarked;
  if (unmarkedWas === undefined)
    improved.push(`опции свежести без маркера: бюджет числа не знает → ${unmarkedNow}`);
  else if (unmarkedNow > unmarkedWas)
    grown.push(
      `опций свежести без маркера: ${unmarkedNow}, бюджет ${unmarkedWas} — срок и перечитывание ` +
        `задаются профилем из ${QUERY_CONFIG} либо с маркером ` +
        `«query-freshness: <PROFILE|exception> — <reason in English>» внутри фигурных скобок ` +
        `объекта опций или в комментарии прямо над его оператором. Места без маркера:\n` +
        places.unmarked.map((at) => `      ${at}`).join('\n'),
    );
  else if (unmarkedNow < unmarkedWas)
    improved.push(`опции свежести без маркера: ${unmarkedWas} → ${unmarkedNow}`);

  compareList(
    'сброс всего кэша (invalidateQueries без queryKey и predicate)',
    actual.unfilteredInvalidations,
    budget.unfilteredInvalidations,
    places.line,
    'гасите корни своих слайсов (план этапа 5, Р5); осознанный полный сброс вносится в перечень ' +
      'руками, с причиной',
    { grown, improved },
  );
  compareList(
    'таймеры',
    actual.timers,
    budget.timers,
    places.line,
    'новых таймеров нет (план этапа 5, §3 п. 5): свежесть даёт профиль или инвалидация; ' +
      'осознанное исключение вносится в перечень руками, с причиной',
    { grown, improved },
  );
  compareList(
    'списки без удержания предыдущих строк',
    actual.unheldLists,
    budget.unheldLists,
    places.line,
    'оберните серверный запрос в listQueryOptions или отметьте локальное исключение ' +
      '«list-query: exception — <reason in English>» над вызовом useListParams',
    { grown, improved },
  );

  return { grown, improved };
}

/**
 * A named list compares as a set. A place the budget does not list is growth. A listed place the
 * code no longer has is a DEAD entry, reported as an improvement — so `check` fails until
 * `quality:update` drops it: left in the list, it would let a new place under the same name pass
 * unseen. A list the budget does not know yet is recorded the same way as a new figure.
 */
function compareList(label, now, was, line, growthHint, { grown, improved }) {
  if (was === undefined) {
    improved.push(`${label}: бюджет перечня не знает → мест ${now.length}`);
    return;
  }
  const listed = new Set(was);
  const present = new Set(now);
  const added = now.filter((id) => !listed.has(id));
  if (added.length > 0)
    grown.push(
      `${label} — новые места вне перечня; ${growthHint}:\n` +
        added.map((id) => `      ${id} (строка ${line.get(id)})`).join('\n'),
    );
  for (const id of was)
    if (!present.has(id)) improved.push(`${label}: места ${id} в коде нет — запись мёртвая`);
}

// --- modes -------------------------------------------------------------------

const mode = process.argv[2] ?? 'check';
if (!['check', 'update'].includes(mode)) {
  console.error(`Неизвестный режим «${mode}»: ожидается check или update`);
  process.exit(2);
}

const { figures: actual, places } = measure();

if (!existsSync(BUDGET_FILE)) {
  if (mode !== 'update') {
    console.error(
      `Нет ${path.relative(WEB, BUDGET_FILE)} — снимите первый бюджет: pnpm --filter @technic/web quality:update`,
    );
    process.exit(1);
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(actual, null, 2) + '\n');
  console.log('Бюджет снят впервые.');
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
const { grown, improved } = compare(actual, budget, places);

if (grown.length > 0) {
  console.error('Долг вырос:\n' + grown.map((m) => `  — ${m}`).join('\n'));
  if (mode === 'update')
    console.error(
      '\nquality:update ослабить бюджет не может: рост правится руками — так его видно на ревью.',
    );
  process.exit(1);
}

if (mode === 'update') {
  if (improved.length === 0) {
    console.log('Бюджет уже точен — обновлять нечего.');
    process.exit(0);
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(actual, null, 2) + '\n');
  console.log('Бюджет подтянут:\n' + improved.map((m) => `  · ${m}`).join('\n'));
  process.exit(0);
}

if (improved.length > 0) {
  console.error(
    'Стало лучше, но бюджет не записан:\n' +
      improved.map((m) => `  · ${m}`).join('\n') +
      '\n\nЗапустите pnpm --filter @technic/web quality:update и закоммитьте quality-budget.json —' +
      '\nиначе достигнутое не закрепится и место освободится под новый долг.',
  );
  process.exit(1);
}

console.log('Бюджеты качества в порядке.');
