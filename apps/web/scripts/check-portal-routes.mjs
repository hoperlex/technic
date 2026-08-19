#!/usr/bin/env node
/**
 * Раздел портала заводится только через реестр (ADR 0121, `docs/portal-sections-plan.md` §6).
 *
 * Типом это не закрывается ни на сколько: `Record<PortalShellSectionId, ReactNode>` требует
 * страницу для раздела, заведённого в реестре, а обратную сторону — раздел, заведённый **мимо**
 * реестра, — не видит вовсе. Ручной `<Route path="/new" element={<NewPage />} />` в `App.tsx`
 * скомпилируется, заработает и молча вернёт портал к тому, из-за чего реестр и появился: состав
 * разделов снова окажется в двух местах, меню и стартовая страница о новом разделе не узнают, и
 * промах вылезет только у той роли, для которой пропущенный раздел — единственный (ADR 0085).
 *
 * Грепом не проверяется: после переезда на реестр в JSX стоит `path={section.path}`, а литеральных
 * путей разделов там не осталось ни одного — искать нечего. Поэтому и `App.tsx`, и сам реестр
 * разбираются как AST (тот же приём, что в `check-form-blockers.mjs`). Реестр — тоже разбором, а не
 * `import`: модули контрактов пишут импорты без расширений (`from './enums'`), и голым Node такой
 * файл не грузится — понадобился бы сборщик ради двух списков строк.
 *
 * Проверка намеренно грубая: она сторожит не «правильность маршрутов», а то, что состав разделов
 * по-прежнему приходит из одного места.
 *
 * Запуск: pnpm --filter @technic/web check:portal-routes
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// От файла скрипта, а не от `process.cwd()`: страж ходит за пределы пакета — в контракты, — и
// путь, отсчитанный от текущего каталога, развалился бы при запуске из корня монорепо.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = path.resolve(HERE, '../src/App.tsx');
const REGISTRY_FILE = path.resolve(HERE, '../../../packages/contracts/src/portal-sections.ts');

/**
 * Литеральные `path=`, которым в `App.tsx` быть законно, — с причиной у каждого. Новая строка здесь
 * — повод ответить: это раздел портала (тогда ему место в `SHELL_SECTIONS`) или что-то другое?
 *
 * Публичная часть перечислена наравне с остальным, а не вырезана «по расположению» (всё, что вне
 * ветки `ProtectedRoute`). Отбор по расположению завязал бы стража на форму дерева маршрутов:
 * стоило бы кому-то переставить `ProtectedRoute` или завести второй защищённый узел — и часть
 * маршрутов молча выпала бы из-под проверки, причём именно та, о которой никто не помнит. Список
 * короткий, публичных страниц у портала ровно столько, сколько людей может увидеть до входа, и
 * новая такая страница — тоже решение, а не мелочь.
 */
const ALLOWED = {
  '/login': 'вход — до него у человека ни прав, ни разделов',
  '/register': 'заявка на регистрацию: учётки ещё нет',
  '/verify-email': 'подтверждение адреса по ссылке из письма (за EMAIL_VERIFICATION_ENABLED)',
  '/forgot-password': 'запрос ссылки на сброс — тем, кто войти как раз не может',
  '/reset-password': 'сброс пароля по ссылке из письма',
  '*': 'неизвестный адрес уводится на корень; это не раздел, а хвост таблицы маршрутов',
  '/change-password':
    'служебная страница вне каркаса: разделом не является, в меню не показывается',
  // `/driver` остаётся литералом осознанно: у кабинета свой каркас и своя index-страница (ADR 0102),
  // циклом такую ветку не собрать. Совпадение этого литерала с реестром проверяется отдельно — см.
  // ниже, иначе исключение стало бы дырой ровно того размера, что и раздел.
  '/driver': 'кабинет водителя — второй контур со своим каркасом, ветка собирается руками',
  '/vehicle-requests/weekly/:id':
    'подстраница раздела со своим правом (weeklyRequests.read), не раздел',
};

/** Разбор файла: `setParentNodes` включён — без него у узлов нет `getText()` и позиций. */
function parse(file, kind) {
  const code = readFileSync(file, 'utf8');
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Все узлы поддерева, удовлетворяющие предикату. Колбэк обхода намеренно ничего не возвращает:
 * `forEachChild` останавливается на первом истинном ответе — вернув из него накопитель, обход
 * оборвался бы на первом же ребёнке, и файл выглядел бы пустым.
 */
function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  ts.forEachChild(node, (child) => {
    findAll(child, predicate, out);
  });
  return out;
}

/** `as const`, `satisfies` и скобки вокруг значения — шум разбора, до данных они не относятся. */
function unwrap(expression) {
  let node = expression;
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Строковые поля объектного литерала: `{ id: 'waste', path: '/waste' }` → `{ id, path }`. */
function stringFields(object) {
  const fields = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    const value = unwrap(property.initializer);
    if (name && ts.isStringLiteral(value)) fields[name] = value.text;
  }
  return fields;
}

/** Состав разделов из реестра: `SHELL_SECTIONS` (каркас) и `DRIVER_CABINET_SECTION` (кабинет). */
function readRegistry() {
  const source = parse(REGISTRY_FILE, ts.ScriptKind.TS);
  const declarations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, unwrap(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const shell = declarations.get('SHELL_SECTIONS');
  const cabinet = declarations.get('DRIVER_CABINET_SECTION');
  if (
    !shell ||
    !ts.isArrayLiteralExpression(shell) ||
    !cabinet ||
    !ts.isObjectLiteralExpression(cabinet)
  ) {
    return null;
  }
  return {
    shell: shell.elements.filter(ts.isObjectLiteralExpression).map(stringFields),
    cabinet: stringFields(cabinet),
  };
}

/**
 * Имя JSX-тега. Три вида узла спрашиваются одинаково нарочно: от атрибута вверх приходит
 * `JsxOpeningElement`, а от обхода дерева — `JsxElement`, и различать их на каждом вызове значило бы
 * повторять это ветвление всюду.
 */
function tagName(node) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
    return node.tagName.getText();
  return '';
}

/** Атрибут JSX-элемента по имени. */
function attribute(node, name) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (!ts.isJsxSelfClosingElement(opening) && !ts.isJsxOpeningElement(opening)) return null;
  return (
    opening.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
    ) ?? null
  );
}

/** Значение атрибута, если оно записано строкой: `path="/driver"` и `id={'x'}` — оба. */
function literalAttribute(node, name) {
  const attr = attribute(node, name);
  if (!attr?.initializer) return null;
  const value = ts.isJsxExpression(attr.initializer)
    ? attr.initializer.expression && unwrap(attr.initializer.expression)
    : attr.initializer;
  return value && ts.isStringLiteral(value) ? value.text : null;
}

/** `<Route element={<RequireSection …/>}>` — гейт раздела; возвращает сам гейт. */
function sectionGate(node) {
  if (!ts.isJsxElement(node) || tagName(node) !== 'Route') return null;
  const attr = attribute(node, 'element');
  if (!attr?.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
    return null;
  }
  return (
    findAll(attr.initializer.expression, (child) => tagName(child) === 'RequireSection')[0] ?? null
  );
}

/** `<Route path={section.path} …>` — путь взят из реестра, а не написан руками. */
function hasRegistryPathRoute(node) {
  return (
    findAll(node, (child) => {
      if (tagName(child) !== 'Route') return false;
      const attr = attribute(child, 'path');
      if (
        !attr?.initializer ||
        !ts.isJsxExpression(attr.initializer) ||
        !attr.initializer.expression
      ) {
        return false;
      }
      const value = attr.initializer.expression;
      return ts.isPropertyAccessExpression(value) && value.name.text === 'path';
    }).length > 0
  );
}

const problems = [];
const registry = readRegistry();

if (!registry) {
  console.error(
    'Реестр разделов не разобрался: в packages/contracts/src/portal-sections.ts не нашлись\n' +
      'SHELL_SECTIONS (массив разделов) и DRIVER_CABINET_SECTION (объект кабинета).\n' +
      'Если они переименованы или собираются иначе — поправьте разбор в scripts/check-portal-routes.mjs.',
  );
  process.exit(1);
}

const app = parse(APP_FILE, ts.ScriptKind.TSX);
const line = (node) => app.getLineAndCharacterOfPosition(node.getStart(app)).line + 1;
const shellPaths = new Map(registry.shell.map((section) => [section.path, section.id]));

// 1. Генератор ветки каркаса на месте: цикл по реестру, гейт над маршрутом, путь из раздела.
const mapCalls = findAll(
  app,
  (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'map' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'SHELL_SECTIONS',
);
if (mapCalls.length === 0) {
  problems.push(
    'В App.tsx нет цикла SHELL_SECTIONS.map(...): маршруты разделов каркаса больше не строятся по\n' +
      '    реестру. Верните генератор — поимённые <Route> и есть третья копия состава разделов.',
  );
} else {
  const gated = mapCalls.flatMap((call) => findAll(call, (node) => sectionGate(node) !== null));
  if (gated.length === 0) {
    problems.push(
      'Внутри SHELL_SECTIONS.map(...) нет гейта <Route element={<RequireSection …/>}>: маршрут раздела\n' +
        '    открылся бы всем, кто прошёл ProtectedRoute. Верните RequireSection над маршрутом раздела.',
    );
  } else if (!gated.some(hasRegistryPathRoute)) {
    problems.push(
      'Внутри SHELL_SECTIONS.map(...) нет <Route path={section.path} …>: адрес раздела больше не берётся\n' +
        '    из реестра. Путь обязан приходить из строки раздела, иначе адреса разъедутся с меню.',
    );
  }
}

// 2. Ручная ветка кабинета водителя: тот же гейт и тот же адрес, что в реестре.
const cabinetGates = findAll(
  app,
  (node) =>
    sectionGate(node) !== null && literalAttribute(sectionGate(node), 'id') === 'driver-cabinet',
);
if (cabinetGates.length === 0) {
  problems.push(
    'В App.tsx нет ветки <Route element={<RequireSection id="driver-cabinet" />}>: кабинет водителя\n' +
      '    остался бы без общего гейта — условие входа (право вместе с ролью) описано строкой реестра.',
  );
} else {
  // `isJsxElement` в предикате обязателен: у элемента с детьми имя тега есть и у него самого, и у его
  // `JsxOpeningElement`, и без этого условия каждый путь попал бы в перечисление дважды.
  const cabinetPaths = cabinetGates.flatMap((gate) =>
    findAll(
      gate,
      (node) =>
        (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
        tagName(node) === 'Route' &&
        literalAttribute(node, 'path') !== null,
    ).map((node) => literalAttribute(node, 'path')),
  );
  if (!cabinetPaths.includes(registry.cabinet.path)) {
    problems.push(
      `Адрес кабинета водителя разошёлся с реестром: в App.tsx под гейтом — ${cabinetPaths.join(', ') || '(ни одного пути)'},\n` +
        `    в portal-sections.ts DRIVER_CABINET_SECTION.path = ${registry.cabinet.path}. Ветка собирается\n` +
        '    руками, поэтому совпадение держится только этой проверкой.',
    );
  }
}

// 3 и 4. Литеральные пути: раздел реестра, заведённый ещё и руками, — и всё прочее, что не в ALLOWED.
const literalPaths = findAll(
  app,
  (node) => ts.isJsxAttribute(node) && node.name.getText() === 'path',
)
  .map((attr) => {
    const owner = attr.parent.parent;
    return { value: literalAttribute(owner, 'path'), tag: tagName(owner), node: attr };
  })
  .filter((entry) => entry.value !== null);

for (const entry of literalPaths) {
  const sectionId = shellPaths.get(entry.value);
  if (sectionId) {
    problems.push(
      `App.tsx:${line(entry.node)} — <${entry.tag} path="${entry.value}"> повторяет раздел реестра «${sectionId}»:\n` +
        '    он уже заводится циклом SHELL_SECTIONS.map(...). Уберите ручной маршрут; если разделу нужна\n' +
        '    подстраница — у неё свой адрес и своё право (RequirePermission), а не адрес раздела.',
    );
  } else if (!Object.hasOwn(ALLOWED, entry.value)) {
    problems.push(
      `App.tsx:${line(entry.node)} — литеральный путь "${entry.value}" не описан нигде: ни разделом реестра,\n` +
        '    ни исключением. Раздел портала (пункт меню и стартовая страница) заводится строкой в\n' +
        '    SHELL_SECTIONS (packages/contracts/src/portal-sections.ts). Если это не раздел — впишите путь\n' +
        '    в ALLOWED с причиной (scripts/check-portal-routes.mjs).',
    );
  }
}

if (problems.length > 0) {
  console.error('Маршрут в обход реестра разделов (ADR 0121):');
  for (const problem of problems) console.error(`  — ${problem}`);
  process.exit(1);
}

console.log(
  `Маршруты разделов: состав приходит из реестра — ${registry.shell.length} разделов каркаса плюс кабинет ` +
    `(исключений — ${Object.keys(ALLOWED).length}).`,
);
