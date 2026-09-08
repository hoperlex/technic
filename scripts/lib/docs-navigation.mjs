/**
 * Разбор документации: шапки решений, ссылки, граф связей и набор затронутых файлов.
 *
 * ОДИН РАЗБОР НА ПРОВЕРКУ И ГЕНЕРАТОР (план `docs/docs-navigation-plan.md`, Р2). Шапки писались
 * три года и неоднородны: у одних решений область названа ссылкой, у других — обратными кавычками,
 * поля зовутся то «Связано», то «Связано с», перенос строки внутри поля — правило, а не исключение.
 * Две независимые реализации такого разбора дали бы два разных графа — и разошлись бы молча:
 * указатель показывал бы одно, проверка ругалась бы на другое.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Ни одной эвристики, угадывающей домен решения по словам заголовка
 * (Р3): угаданный домен хуже отсутствующего — он молча уводит поиск в сторону. Домены приезжают
 * либо полем `Домены` самого ADR, либо точной таблицей legacy-классификации; ни то ни другое этот
 * модуль не выдумывает.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Словарь статусов (Р4). Проверяется только у затронутых решений: из 176 существующих 166 стоят в
 * «Принято», а остальные несут составную фразу, и ретрофит словаря переписал бы шапки, которых
 * работа не касается.
 */
export const STATUSES = ['Принято', 'Реализовано', 'Отменено', 'Заменено'];

/**
 * Словарь доменов (§4 плана) — общий для указателя решений и карты кода. Разойдись они, вышли бы
 * две несовпадающие классификации одного и того же портала.
 */
export const DOMAINS = [
  'вывоз-мусора',
  'заказ-тс',
  'путевые-листы',
  'механизация',
  'оргтехника',
  'гараж',
  'кабинет-водителя',
  'справочники',
  'автозапчасти',
  'доступ',
  'учётки-и-аудит',
  'почта',
  'файлы-и-распознавание',
  'каркас-портала',
  'схема-и-выкат',
  'качество',
];

/**
 * ИЗВЕСТНЫЕ КОЛЛИЗИИ НОМЕРОВ — ТОЧНЫМИ МНОЖЕСТВАМИ ИМЁН, А НЕ РАЗРЕШЁННЫМИ НОМЕРАМИ (Р7).
 *
 * Разница не в оформлении: разреши мы «номер 0085 занимать дважды», третий файл с тем же номером
 * проехал бы молча, и подмена одного из двух имён — тоже. Здесь же множество сверяется целиком,
 * поэтому исключение стережёт ровно ту пару, которую заказчик согласился не перенумеровывать
 * (Р6: на «ADR 0085» ссылаются сотни мест, из них 490 — в неизменяемых сообщениях коммитов).
 */
export const COLLISION_EXCEPTIONS = [
  {
    id: '0060',
    files: ['0060-directory-record-purge.md', '0060-esm2-weekly-waybill.md'],
    since: '2026-08-04',
    why: 'два потока заняли номер в один день; ссылок на «ADR 0060» — 173, перенумерация ломает хронологию',
  },
  {
    id: '0085',
    files: ['0085-office-equipment-module.md', '0085-weekly-vehicle-request.md'],
    since: '2026-08-07',
    why: 'то же самое; на «ADR 0085» ссылаются 320 мест, включая сообщения коммитов',
  },
];

/**
 * Поля шапки и что они означают для графа (Р4). Ключ — как поле пишут в документах, значение —
 * тип ребра. Прозаические поля («Статус», «Область», «План», «Этап») сюда не входят: придуманная
 * им семантика была бы выводом, которого автор не делал.
 *
 * `cancels` и `changes` — единственные типы, из которых указатель делает вывод о судьбе СТАРОГО
 * решения. `extends` показывается связью и ничего не отменяет; `Связано` не типизируется вовсе.
 */
export const RELATION_FIELDS = new Map([
  ['Отменяет', 'cancels'],
  ['Заменяет', 'cancels'],
  ['Изменяет', 'changes'],
  ['Уточняет', 'changes'],
  ['Исправляет', 'changes'],
  ['Развивает', 'extends'],
  ['Дополняет', 'extends'],
  ['Расширяет', 'extends'],
  ['Основано на', 'extends'],
  ['Реализует', 'extends'],
  ['Решение вырастает из', 'extends'],
  ['Повторяет приём', 'extends'],
  // Обратное поле: старое решение само называет того, кто его правит. Нормализуется в то же
  // направленное ребро «новый → старый», иначе одна и та же связь легла бы в граф дважды.
  ['Изменён', 'changed-by'],
  ['Отменён', 'cancelled-by'],
]);

/** Поля-синонимы: слева то, как написано в документе, справа — общее имя. */
const FIELD_ALIASES = new Map([
  ['Связано с', 'Связано'],
  ['Связано с кодом', 'Связано'],
  ['Миграция', 'Миграции'],
  ['Миграций нет', 'Миграции'],
  ['Миграций не требует', 'Миграции'],
  ['Области', 'Область'],
]);

// ── Шапка решения ────────────────────────────────────────────────────────────────────────────

/**
 * Шапка — всё до первого раздела `##`. Дальше идёт проза, и поля оттуда брать нельзя: строка
 * «- Статус: …» внутри примера означала бы совсем другое.
 */
export function headerOf(text) {
  const end = text.search(/^## /m);
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Поля шапки с продолжениями. Продолжением считается строка с отступом: так поле переживает
 * перенос, а перенос здесь правило — «Область» у больших решений занимает десяток строк.
 */
export function fieldsOf(header) {
  const fields = new Map();
  let current = null;
  for (const line of header.split('\n')) {
    const start = line.match(/^- (?:\*\*)?([А-ЯЁ][^:*]{1,40}?)(?:\*\*)?:\s?(.*)$/);
    if (start) {
      const name = FIELD_ALIASES.get(start[1].trim()) ?? start[1].trim();
      current = name;
      fields.set(name, [fields.get(name), start[2]].filter(Boolean).join(' '));
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      fields.set(current, `${fields.get(current)} ${line.trim()}`.trim());
      continue;
    }
    if (/^\S/.test(line)) current = null;
  }
  return fields;
}

/** Номера решений, названные в значении поля: и ссылкой `[ADR 0021](…)`, и словами «ADR 0021». */
export function adrRefsIn(value = '') {
  return [...new Set([...value.matchAll(/ADR[\s\u00a0]?(\d{4})/g)].map((m) => m[1]))];
}

/**
 * Пути к коду, названные шапкой, — из обоих видов записи сразу. Половина решений называет область
 * ссылкой (`0106`, `0174`), половина — обратными кавычками (`0013`, `0020`), и разбор одного вида
 * потерял бы половину областей.
 *
 * Возвращаются пути ОТНОСИТЕЛЬНО КОРНЯ репозитория: сравнивать их с деревом и заносить в baseline
 * можно только в одной нормальной форме.
 */
export function codePathsIn(header, { adrDir, root }) {
  const paths = new Set();
  for (const link of linksIn(header)) {
    const abs = path.resolve(adrDir, link.target);
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..') && !rel.startsWith('docs/')) paths.add(rel);
  }
  for (const m of header.matchAll(/`([\w./@-]+\.(?:ts|tsx|sql|mjs|json|ya?ml))`/g)) {
    const rel = m[1].replace(/^\.\//, '');
    if (rel.includes('/')) paths.add(rel);
  }
  return [...paths];
}

// ── Ссылки ───────────────────────────────────────────────────────────────────────────────────

/** Огороженный и строчный код: примеры путями не считаются (§6 плана). */
function stripCode(text) {
  return text
    .replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
}

/** Внешняя ссылка, якорь или адрес портала — не путь файловой системы, и проверять его нечем. */
function isNavigable(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // https:, mailto:, tel:, data:
  if (target.startsWith('#')) return false;
  if (target.startsWith('/')) return false; // адрес раздела портала, например /login
  return true;
}

/**
 * Локальные ссылки документа: inline, картинки и reference-style. Возвращается очищенная цель
 * (без query и якоря, с раскодированным percent-encoding) и номер строки — по нему человек и
 * находит промах.
 */
export function linksIn(text) {
  const clean = stripCode(text);
  const out = [];
  const push = (raw, line) => {
    const target = decodeURI(raw.split('#')[0].split('?')[0].trim());
    if (isNavigable(target)) out.push({ target, line });
  };
  const lines = clean.split('\n');
  const refs = new Map();
  lines.forEach((line, index) => {
    const def = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/);
    if (def) refs.set(def[1].toLowerCase(), { target: def[2], line: index + 1 });
  });
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      push(m[1], index + 1);
    }
    for (const m of line.matchAll(/!?\[[^\]]*\]\[([^\]]+)\]/g)) {
      const ref = refs.get(m[1].toLowerCase());
      if (ref) push(ref.target, index + 1);
    }
  });
  return out;
}

/**
 * Класс битой ссылки — и он же способ починки (§1.5, §6 плана):
 *
 *   · `missing-parent` — путь написан от корня репозитория, а документ лежит в `docs/`: не хватает
 *     `../`. Чинится механически;
 *   · `adr-slug` — номер решения верный, имя файла устарело после переименования. Чинится
 *     механически, но подсказка даётся только при единственном файле с таким номером: у 0060 и
 *     0085 автоисправления быть не может;
 *   · `code-path` — ссылка ведёт в код, которого больше нет. Историческая правда решения, а не
 *     дефект: такие пары живут в baseline;
 *   · `other` — разбирается глазами.
 */
export function classifyBrokenLink({ file, target, root, adrsByNumber }) {
  const fromRoot = path.resolve(root, target.replace(/^\.\.\//, ''));
  if (existsSync(fromRoot) && !path.relative(root, fromRoot).startsWith('..')) {
    return { kind: 'missing-parent', hint: path.relative(path.dirname(file), fromRoot) };
  }
  const base = path.basename(target);
  const num = base.match(/^(\d{4})-.+\.md$/)?.[1];
  if (num && adrsByNumber.has(num)) {
    const candidates = adrsByNumber.get(num);
    return {
      kind: 'adr-slug',
      hint:
        candidates.length === 1
          ? candidates[0]
          : `номер занят дважды: ${candidates.join(', ')} — выберите нужный вручную`,
    };
  }
  const abs = path.resolve(path.dirname(file), target);
  const rel = path.relative(root, abs);
  if (/^(apps|packages|scripts|deploy)\//.test(rel)) return { kind: 'code-path', hint: rel };
  return { kind: 'other', hint: '' };
}

// ── Чтение дерева ────────────────────────────────────────────────────────────────────────────

export function readAdrs(root) {
  const adrDir = path.join(root, 'docs', 'adr');
  return readdirSync(adrDir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => {
      const file = path.join(adrDir, name);
      const text = readFileSync(file, 'utf8');
      const header = headerOf(text);
      const fields = fieldsOf(header);
      const statusRaw = (fields.get('Статус') ?? '').trim();
      const relations = new Map();
      for (const [field, kind] of RELATION_FIELDS) {
        for (const ref of adrRefsIn(fields.get(field) ?? '')) {
          const key = `${kind}:${ref}`;
          if (!relations.has(key)) relations.set(key, { kind, id: ref });
        }
      }
      return {
        id: name.slice(0, 4),
        name,
        file,
        text,
        header,
        fields,
        title: (text.match(/^#\s+ADR\s+\d{4}\.?\s*(.+)$/m)?.[1] ?? name).trim(),
        statusRaw,
        // Первое слово: пояснение и дата идут после статуса и словарём не проверяются (Р4).
        status: statusRaw.split(/[\s(,.;]/)[0] ?? '',
        domains: (fields.get('Домены') ?? '')
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean),
        migrations: fields.get('Миграции') ?? '',
        codePaths: codePathsIn(header, { adrDir, root }),
        relations: [...relations.values()],
      };
    });
}

/** Все markdown-документы `docs/**` — навигация между решениями живёт в них же. */
export function readDocs(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(path.join(root, 'docs'));
  return out;
}

/**
 * Затронутые работой файлы (Р8): объединение коммитов ветки, индекса, рабочего дерева и
 * неотслеживаемых файлов. Строгие поля спрашиваются только с них — иначе работа обязана была бы
 * привести в порядок 176 чужих шапок, чтобы выкатить свою правку.
 *
 * Не разрешившаяся база — ОШИБКА, а не «проверим только рабочее дерево»: молчаливое сужение
 * набора даёт ложнозелёный прогон ровно там, где он нужен.
 */
export function affectedFiles(root, baseRef) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  let base = null;
  try {
    base = git(['merge-base', baseRef, 'HEAD']);
  } catch {
    return { ok: false, files: [], baseRef };
  }
  const files = new Set();
  const add = (out) => {
    for (const line of out.split('\n')) if (line.trim()) files.add(line.trim());
  };
  add(git(['diff', '--name-only', '--diff-filter=d', `${base}..HEAD`]));
  add(git(['diff', '--name-only', '--diff-filter=d', 'HEAD']));
  add(git(['diff', '--name-only', '--diff-filter=d', '--cached']));
  add(git(['ls-files', '--others', '--exclude-standard']));
  return { ok: true, files: [...files], baseRef };
}

/**
 * СУЩЕСТВОВАЛ ЛИ ПУТЬ КОГДА-НИБУДЬ (Р5 редакции 3). Историю от опечатки отличает не рукописный
 * список, а `git log --all`: файл, живший в репозитории и снятый позже, — правда о прошлом
 * решения; файл, которого не было никогда, — промах в шапке, и возраст решения его не оправдывает.
 *
 * Рукописный baseline, стоявший здесь в первой реализации, ровно этот случай и заморозил бы: среди
 * 27 отсутствующих путей один (`service-request-mail-events.db.test.ts` у ADR 0159) не существовал
 * никогда — настоящий файл зовётся `service-request-mail.db.test.ts`.
 *
 * Ответы кэшируются: путей под сотню, а `git log` по каждому — самая дорогая часть прогона.
 */
const everExistedCache = new Map();
export function pathEverExisted(root, rel) {
  if (everExistedCache.has(rel)) return everExistedCache.get(rel);
  let existed = false;
  try {
    const out = execFileSync('git', ['log', '--all', '--oneline', '-1', '--', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    existed = out.trim().length > 0;
  } catch {
    existed = false;
  }
  everExistedCache.set(rel, existed);
  return existed;
}

/** Проверка коллизий по точным множествам (Р7): и третий файл, и подмена имени — ошибка. */
export function collisionProblems(adrs) {
  const byId = new Map();
  for (const adr of adrs) byId.set(adr.id, [...(byId.get(adr.id) ?? []), adr.name]);
  const problems = [];
  for (const [id, names] of byId) {
    if (names.length === 1) continue;
    const known = COLLISION_EXCEPTIONS.find((e) => e.id === id);
    const sorted = [...names].sort();
    if (
      known &&
      known.files.length === sorted.length &&
      known.files.every((f, i) => f === sorted[i])
    ) {
      continue;
    }
    problems.push(
      known
        ? `номер ${id}: набор файлов разошёлся с объявленным исключением — ${sorted.join(', ')}`
        : `номер ${id} занят дважды: ${sorted.join(', ')}`,
    );
  }
  return problems;
}
