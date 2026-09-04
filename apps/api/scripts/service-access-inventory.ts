import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Инвентарь фактических проверок доступа в модуле заявок на обслуживание оргтехники — этап Э0
 * плана `docs/office-equipment-executor-access-audit-plan.md`.
 *
 * ЗАЧЕМ. Карта ручек §2.2 плана снята чтением и записана словами: «область — `assertScope`»,
 * «сторона — `assertExecutorSide`». Пока она пересказ, все следующие этапы опираются на память
 * человека: Э1 объявляет манифест области и стороны по «сегодняшнему коду», Э2 требует, чтобы
 * падали ровно названные тесты, а критерий К2 §8 прямо оговаривает — проверяется инвентарём, а не
 * глазами. Пересказ устаревает молча: ручка, у которой в теле не оказалось проверки области, в
 * таблице выглядит закрытой, и ни один прогон об этом не скажет. Скрипт снимает тот же факт
 * машиной, и расхождение с таблицей — это находка, а не опечатка.
 *
 * ЧТО ДЕЛАЕТ. Ничего не меняет: ни файлов, ни базы — базу он даже не открывает. Читает исходники
 * маршрутов текстом и печатает по каждой зарегистрированной ручке метод, путь, набор `preHandler`
 * (и права, которые тот спрашивает) и проверки, встреченные в теле обработчика.
 *
 * ПОЧЕМУ РАЗБОР ТЕКСТОМ, А НЕ ЗАПУСКОМ ПРИЛОЖЕНИЯ. Собранное приложение знает про маршрут ровно
 * то, что видит fastify: метод, путь и цепочку `preHandler`, — то есть **право**. Всё, ради чего
 * заведён аудит, живёт внутри обработчика (`requireEditable`, `assertExecutorSide`, предикаты
 * контрактов) и на собранном приложении не наблюдаемо никак: это обычные вызовы функций. Ровно об
 * этом Н5 — манифест доказывает право и молчит про область и сторону. Поэтому единственный
 * источник, где факт вообще есть, — текст обработчика.
 *
 * ГРАНИЦА РУЧКИ — СЛЕДУЮЩАЯ РЕГИСТРАЦИЯ (то же правило, что в §2.2). Тело обработчика скобками не
 * выделяется дёшево: у ручки три аргумента, третий — стрелочная функция на две сотни строк с
 * транзакциями и вложенными литералами. Границей взят участок «от `r.post(` до следующей
 * регистрации»: он заведомо шире тела, и ошибается разбор в безопасную сторону — лишнее в столбце
 * видно человеку, пропущенное — нет.
 *
 * ЧЕГО СКРИПТ НЕ ВИДИТ. Проверок, спрятанных за вызовом в другой файл: чат спрашивает `canWriteChat`
 * внутри `postChatMessage` (`services/service-request-chat.ts`), и в столбце ручки `POST
 * /:id/messages` его не будет. Переход по локальным помощникам того же файла — есть (столбец «→»):
 * `requireEditable` тянет за собой `loadRow` и `assertScope`, и без этого перехода половина
 * таблицы §2.2 читалась бы как «области нет».
 *
 * Запуск:
 *   pnpm --filter @technic/api report:service-access
 *   pnpm --filter @technic/api report:service-access -- --json
 */

const EXIT_FAILURE = 1;

/** Корень пакета: скрипт лежит в `apps/api/scripts`, исходники — рядом в `apps/api/src`. */
const API_ROOT = new URL('..', import.meta.url).pathname;

/**
 * Разбираемые файлы. Внутренний контур включён вместе с прикладным намеренно: `POST
 * /internal/service-requests/auto-close` стоит в §2.2 такой же строкой, а закрыт не правом, а общим
 * секретом — и «ручка модуля без области» обязана попасть в инвентарь, а не выпасть из него по
 * признаку «лежит в другом файле».
 */
const TARGETS = ['src/routes/service-requests.ts', 'src/routes/internal-service-requests.ts'];

/** Где объявлены префиксы маршрутов. Читаются оттуда же, а не переписываются сюда строкой. */
const APP_FILE = 'src/app.ts';

/**
 * Помощник, регистрирующий `DELETE /:id/purge` за модуль. Ручка своя у каждого справочника, а
 * зарегистрирована общим кодом: не знай про это скрипт, из инвентаря пропала бы единственная
 * строка §2.2 с пустой клеткой области.
 */
const DELEGATED = { call: 'registerPurgeRoute', file: 'src/services/directory-purge.ts' };

/**
 * Проверки, которые ищутся в теле, — список плана Э0 дословно. Порядок здесь не важен: в выводе
 * они идут в порядке появления в коде, потому что §2.1 утверждает именно порядок слоёв («право →
 * область → сторона → состояние»), и нарушенный порядок — такая же находка, как пропущенная
 * проверка.
 */
const CHECKS = [
  'requireEditable',
  'loadRow',
  'assertScope',
  'assertArchiveVisible',
  'assertSideAllowed',
  'assertTransition',
  'assertExecutorSide',
  'assertConsumableIssuer',
  'assertCanHold',
  'assertServiceRequestEditable',
  'assertServiceRequestDeletable',
  'assertRepairKind',
  'lockRequest',
  'executorAssignment',
  'canAssignServiceExecutors',
  'canDeclineServiceRequest',
  'canStartServiceWork',
  'canSubmitServiceEstimate',
  'canApproveServiceEstimate',
  'canReopenServiceEstimate',
  'canWriteChat',
  /*
   * Пять имён сверх перечня Э0 — и каждое потому, что без него строка таблицы читается как «ручка
   * не закрыта ничем», а это неправда. Пустая клетка в инвентаре обязана означать пустую клетку в
   * коде, иначе следующий этап начнёт закрывать дыры, которых нет, и не заметит настоящих.
   *
   * `visibility` и `listWhere` — область витрин: §2.2 пишет её в тех же клетках, что `assertScope`
   * у карточек, и без них пять списочных ручек выглядели бы вовсе беспризорными.
   * `canHoldService` / `canResumeService` названы в §2.2 поимённо: коридор заморозки спрашивает
   * право предикатом в обработчике, а не стражем. `assertInternalToken` — единственная дверь
   * внутреннего контура: право у `POST /auto-close` не спрашивается вовсе, и «общий секрет» из
   * §2.2 — это он.
   */
  'visibility',
  'listWhere',
  'canHoldService',
  'canResumeService',
  'assertInternalToken',
] as const;

export type AccessCheck = (typeof CHECKS)[number];

export interface RouteAccess {
  /** Файл, где ручка зарегистрирована, — относительно `apps/api`. */
  file: string;
  /** Строка регистрации: с ней находка открывается в редакторе без поиска. */
  line: number;
  method: string;
  /** Путь целиком, с префиксом из `app.ts`. */
  path: string;
  /** Путь без префикса — как он написан в регистрации. */
  route: string;
  /** Имя набора `preHandler` (`auth`, `canAssign`, …) либо `inline`, если набор написан на месте. */
  guard: string;
  /** Права, которые спрашивает набор. Пусто — страж не спрашивает прав вовсе. */
  permissions: string[];
  /** Проверки, встреченные в теле, в порядке появления. */
  checks: AccessCheck[];
  /** Проверки, до которых тело добирается через помощников того же файла. */
  implied: AccessCheck[];
  /** Файл, который регистрирует ручку за модуль, если это не сам маршрутный файл. */
  via?: string;
}

// ── Разбор текста ──
//
// Дальше — минимальный сканер: границы скобок и строковых литералов. Полноценный разбор TypeScript
// сюда не берётся сознательно — вопрос у скрипта один («встречается ли имя в этом участке»), и
// зависимость на компилятор ради него означала бы, что инвентарь ломается вместе с любой правкой
// версии tsc.

const OPEN = '([{';
const CLOSE = ')]}';

/** Строковый литерал в кавычках: возвращает индекс сразу за закрывающей кавычкой. */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Шаблонная строка с подстановками: `${…}` проходится скобочным сканером, включая вложенные. */
function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i = matchBracket(src, i + 1) + 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Индекс парной закрывающей скобки к той, что стоит в `open`. */
function matchBracket(src: string, open: number): number {
  const stack = [CLOSE[OPEN.indexOf(src[open]!)]!];
  let i = open + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (OPEN.includes(c)) {
      stack.push(CLOSE[OPEN.indexOf(c)]!);
      i += 1;
      continue;
    }
    if (CLOSE.includes(c)) {
      if (c !== stack[stack.length - 1]) throw new Error(`Скобки разошлись на позиции ${i}`);
      stack.pop();
      if (stack.length === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  throw new Error(`Незакрытая скобка с позиции ${open}`);
}

/**
 * Комментарии затираются пробелами, а не вырезаются: смещения обязаны совпасть с исходником, иначе
 * номер строки в находке уводил бы в чужое место. Строковые литералы остаются — из них читаются
 * пути маршрутов и имена прав.
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i += 1) if (src[i] !== '\n') out[i] = ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Аргументы вызова по верхнему уровню запятых: `[начало, конец)` каждого. */
function topLevelArgs(src: string, open: number): { start: number; end: number }[] {
  const close = matchBracket(src, open);
  const args: { start: number; end: number }[] = [];
  let start = open + 1;
  let i = start;
  while (i < close) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (OPEN.includes(c)) {
      i = matchBracket(src, i) + 1;
      continue;
    }
    if (c === ',') {
      args.push({ start, end: i });
      start = i + 1;
    }
    i += 1;
  }
  if (src.slice(start, close).trim().length > 0) args.push({ start, end: close });
  return args;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

/** Вызов имени в участке текста: первое вхождение или `-1`. */
function callIndex(text: string, name: string): number {
  return text.search(new RegExp(`\\b${name}\\s*\\(`));
}

function checksIn(text: string): AccessCheck[] {
  return CHECKS.map((name) => ({ name, at: callIndex(text, name) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.name);
}

// ── Право маршрута ──

function permissionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/requirePermission\(\s*'([^']+)'/g)) out.push(m[1]!);
  for (const m of text.matchAll(/requireAnyPermission\(\s*\[([^\]]*)\]/g)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) out.push(q[1]!);
  }
  return out;
}

/** Наборы `preHandler`, объявленные в файле константой: имя → права, которые набор спрашивает. */
function guardSets(code: string): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  for (const m of code.matchAll(/\bconst (\w+) = \{/g)) {
    const brace = m.index! + m[0].length - 1;
    const body = code.slice(brace, matchBracket(code, brace) + 1);
    if (!body.includes('preHandler:')) continue;
    sets.set(m[1]!, permissionsIn(body));
  }
  return sets;
}

// ── Помощники файла ──

/**
 * Проверки, до которых доходит каждый локальный помощник, — с переходом по цепочке вызовов.
 * Без него столбец ручки `PATCH /:id/complete` показывал бы `requireEditable` и молчал бы о том,
 * что область спрошена: `assertScope` зовёт именно он.
 */
function helperChecks(code: string): Map<string, AccessCheck[]> {
  const bodies = new Map<string, string>();
  for (const m of code.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const params = matchBracket(code, m.index! + m[0].length - 1);
    const brace = code.indexOf('{', params);
    if (brace < 0) continue;
    bodies.set(m[1]!, code.slice(brace, matchBracket(code, brace) + 1));
  }

  const resolved = new Map<string, AccessCheck[]>();
  const walking = new Set<string>();
  function walk(name: string): AccessCheck[] {
    const done = resolved.get(name);
    if (done) return done;
    // Рекурсия помощников (её здесь нет, но появиться может) не должна вешать инвентарь.
    if (walking.has(name)) return [];
    walking.add(name);
    const body = bodies.get(name) ?? '';
    const found = new Set<AccessCheck>(checksIn(body));
    for (const callee of bodies.keys()) {
      if (callee !== name && callIndex(body, callee) >= 0) {
        for (const deep of walk(callee)) found.add(deep);
      }
    }
    walking.delete(name);
    const list = [...found];
    resolved.set(name, list);
    return list;
  }
  for (const name of bodies.keys()) walk(name);
  return resolved;
}

/** До чего тело добирается через помощников файла — сверх того, что позвало само. */
function impliedIn(text: string, helpers: Map<string, AccessCheck[]>, direct: AccessCheck[]) {
  const found = new Set<AccessCheck>();
  for (const [name, deep] of helpers) {
    if (callIndex(text, name) < 0) continue;
    for (const check of deep) found.add(check);
  }
  for (const check of direct) found.delete(check);
  return CHECKS.filter((check) => found.has(check));
}

// ── Сбор ──

function read(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), 'utf8');
}

/**
 * Префикс маршрутного файла — из `app.ts`, а не константой здесь: переезд модуля на другой путь
 * иначе оставил бы инвентарь с вчерашними адресами, и расхождение с §2.2 выглядело бы находкой,
 * которой нет.
 */
function prefixOf(appCode: string, rel: string): string {
  const file = rel.replace(/^src\//, './').replace(/\.ts$/, '');
  const imported = appCode.match(new RegExp(`import\\s+(\\w+)\\s+from\\s+'${file}'`));
  if (!imported) throw new Error(`В ${APP_FILE} нет импорта маршрутов ${rel}`);
  const registered = appCode.match(
    new RegExp(`register\\(\\s*${imported[1]!}\\s*,\\s*\\{\\s*prefix:\\s*'([^']+)'`),
  );
  if (!registered) throw new Error(`В ${APP_FILE} не найден префикс маршрутов ${rel}`);
  return registered[1]!;
}

/** Регистрации файла в порядке появления: `r.get(`, `app.post(` и делегирующий помощник. */
function registrations(code: string): { at: number; method: string; open: number }[] {
  const found: { at: number; method: string; open: number }[] = [];
  for (const m of code.matchAll(/\b(?:r|app)\.(get|post|put|patch|delete)\(/g)) {
    found.push({ at: m.index!, method: m[1]!.toUpperCase(), open: m.index! + m[0].length - 1 });
  }
  for (const m of code.matchAll(new RegExp(`\\b${DELEGATED.call}\\s*\\(`, 'g'))) {
    found.push({ at: m.index!, method: 'DELEGATED', open: m.index! + m[0].length - 1 });
  }
  return found.sort((a, b) => a.at - b.at);
}

function collectFile(rel: string, appCode: string): RouteAccess[] {
  const src = read(rel);
  const code = blankComments(src);
  const prefix = prefixOf(appCode, rel);
  const sets = guardSets(code);
  const helpers = helperChecks(code);
  const marks = registrations(code);
  const out: RouteAccess[] = [];

  marks.forEach((mark, i) => {
    const bodyEnd = marks[i + 1]?.at ?? code.length;
    const body = code.slice(mark.at, bodyEnd);
    if (mark.method === 'DELEGATED') {
      out.push(delegated(rel, prefix, src, mark.at, body));
      return;
    }
    const args = topLevelArgs(code, mark.open);
    const route = code.slice(args[0]!.start, args[0]!.end).trim().replace(/'/g, '');
    const options = args[1] ? code.slice(args[1].start, args[1].end).trim() : '';
    const spreads = [...options.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]!);
    const bare = /^\w+$/.test(options) ? [options] : [];
    const names = [...spreads, ...bare].filter((name) => sets.has(name));
    const inline = options.includes('preHandler:') && names.length === 0;
    const direct = checksIn(body);
    out.push({
      file: rel,
      line: lineOf(src, mark.at),
      method: mark.method,
      path: prefix + (route === '/' ? '' : route),
      route,
      guard: names.length > 0 ? names.join('+') : inline ? 'inline' : '—',
      permissions: names.length > 0 ? names.flatMap((n) => sets.get(n)!) : permissionsIn(options),
      checks: direct,
      implied: impliedIn(body, helpers, direct),
    });
  });
  return out;
}

/**
 * Ручка, зарегистрированная за модуль общим помощником. Право и путь берутся из него самого, а
 * проверки — из двух мест сразу: тела помощника и объекта настройки, переданного на месте вызова
 * (там модуль дописывает свои условия).
 */
function delegated(
  rel: string,
  prefix: string,
  src: string,
  at: number,
  callBody: string,
): RouteAccess {
  const helperSrc = read(DELEGATED.file);
  const helperCode = blankComments(helperSrc);
  const helpers = helperChecks(helperCode);
  const mark = registrations(helperCode)[0];
  if (!mark) throw new Error(`В ${DELEGATED.file} нет регистрации маршрута`);
  const args = topLevelArgs(helperCode, mark.open);
  const route = helperCode.slice(args[0]!.start, args[0]!.end).trim().replace(/'/g, '');
  const options = args[1] ? helperCode.slice(args[1].start, args[1].end) : '';
  const body = helperCode.slice(mark.at) + callBody;
  const direct = checksIn(body);
  return {
    file: rel,
    line: lineOf(src, at),
    method: mark.method,
    path: prefix + route,
    route,
    guard: 'inline',
    permissions: permissionsIn(options),
    checks: direct,
    implied: impliedIn(body, helpers, direct),
    via: DELEGATED.file,
  };
}

/** Инвентарь целиком, в порядке регистрации. Его же читает тест `service-access-inventory.test.ts`. */
export function collectServiceAccessInventory(): RouteAccess[] {
  const appCode = blankComments(read(APP_FILE));
  return TARGETS.flatMap((rel) => collectFile(rel, appCode));
}

// ── Вывод ──

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - [...text].length));
}

function printTable(rows: RouteAccess[]): void {
  const cells = rows.map((row) => [
    row.method,
    row.route,
    row.permissions.length > 0 ? row.permissions.join(' ∨ ') : '—',
    `${row.guard}${row.via ? ` (${row.via})` : ''}`,
    row.checks.length > 0 ? row.checks.join(', ') : '—',
    row.implied.length > 0 ? `→ ${row.implied.join(', ')}` : '',
  ]);
  const head = ['МЕТОД', 'ПУТЬ', 'ПРАВО', 'НАБОР', 'ПРОВЕРКИ В ТЕЛЕ', 'ЧЕРЕЗ ПОМОЩНИКОВ'];
  const widths = head.map((title, i) =>
    Math.max([...title].length, ...cells.map((row) => [...row[i]!].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, i) => pad(cell, widths[i]!))
      .join('  ')
      .trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of cells) console.log(line(row));
}

/** «1 ручка», «2 ручки», «5 ручек»: отчёт читают люди, и «1 ручек» в нём читается как ошибка. */
function handles(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return `${count} ручек`;
  const last = count % 10;
  if (last === 1) return `${count} ручка`;
  if (last >= 2 && last <= 4) return `${count} ручки`;
  return `${count} ручек`;
}

function main(): void {
  const json = process.argv.includes('--json');
  const rows = collectServiceAccessInventory();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const appCode = blankComments(read(APP_FILE));
  for (const rel of TARGETS) {
    const own = rows.filter((row) => row.file === rel);
    console.log(`\n${rel} — ${handles(own.length)}, префикс ${prefixOf(appCode, rel)}`);
    printTable(own);
  }
  console.log(`\nВсего ручек: ${rows.length}`);
}

/*
 * Прогон — только из командной строки: тест инвентаря импортирует `collectServiceAccessInventory`,
 * и печать таблицы посреди прогона мешала бы читать его вывод.
 */
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  try {
    main();
  } catch (e) {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT_FAILURE);
  }
}
