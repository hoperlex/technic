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
 * Известные имена полей. Нужны разбору отдельно от общего правила: поле умеет нести УТОЧНЕНИЕ между
 * именем и двоеточием, и без списка имён такую строку не отличить от обычной прозы.
 */
const KNOWN_FIELDS = [
  ...RELATION_FIELDS.keys(),
  ...FIELD_ALIASES.keys(),
  'Статус',
  'Область',
  'Связано',
  'Миграции',
  'Домены',
  'План',
  'Этап',
  'Внимание',
].sort((a, b) => b.length - a.length);

/**
 * Поля шапки с продолжениями и уточнениями.
 *
 * Продолжением считается строка с отступом: так поле переживает перенос, а перенос здесь правило —
 * «Область» у больших решений занимает десяток строк.
 *
 * УТОЧНЕНИЕ — то, что стоит между именем поля и двоеточием. Встречается оно редко, но несёт ровно
 * тот смысл, ради которого поле и читают: ADR 0141 отменяет приём ADR 0053 **только в модуле
 * оргтехники**, и потерять оговорку значит объявить старое решение недействующим целиком. Прежний
 * разбор такую строку не узнавал вовсе — имя поля искалось до первого двоеточия и не допускало в
 * себе ни `*`, ни тире, — и связь пропадала молча, вместе с самой оговоркой.
 */
export function parseFields(header) {
  const entries = [];
  let current = null;
  for (const line of header.split('\n')) {
    if (/^- /.test(line)) {
      const rest = line.slice(2).replace(/^\*\*/, '');
      // Имя поля кончилось, если следом не строчная буква: иначе «Связано» съело бы «Связанность».
      const known = KNOWN_FIELDS.find(
        (name) => rest.startsWith(name) && !/^[а-яёa-z]/.test(rest.slice(name.length)),
      );
      let entry = null;
      if (known) {
        const after = rest.slice(known.length).replace(/^\*\*/, '');
        const colon = after.indexOf(':');
        if (colon !== -1) {
          entry = {
            name: FIELD_ALIASES.get(known) ?? known,
            qualifier: after.slice(0, colon).trim(),
            value: after.slice(colon + 1).trim(),
          };
        }
      } else {
        const m = line.match(/^- (?:\*\*)?([А-ЯЁ][^:*]{1,40}?)(?:\*\*)?:\s?(.*)$/);
        if (m) {
          entry = {
            name: FIELD_ALIASES.get(m[1].trim()) ?? m[1].trim(),
            qualifier: '',
            value: m[2],
          };
        }
      }
      current = entry;
      if (entry) entries.push(entry);
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.value = `${current.value} ${line.trim()}`.trim();
      continue;
    }
    if (/^\S/.test(line)) current = null;
  }
  return entries;
}

/** Значения полей одной картой: одноимённые поля склеиваются, как это было и до уточнений. */
export function fieldsOf(header) {
  const fields = new Map();
  for (const { name, value } of parseFields(header)) {
    fields.set(name, [fields.get(name), value].filter(Boolean).join(' '));
  }
  return fields;
}

/** Номера решений, названные в значении поля: и ссылкой `[ADR 0021](…)`, и словами «ADR 0021». */
export function adrRefsIn(value = '') {
  return [...new Set([...value.matchAll(/ADR[\s\u00a0]?(\d{4})/g)].map((m) => m[1]))];
}

/**
 * Читаемая форма уточнения. Автор сам выделяет границу жирным — «Отменяет — **в модуле
 * оргтехники** — приём ADR 0053», — и это самая точная запись из трёх встречающихся в корпусе.
 * Где выделения нет («Отменяет ограничение», «Отменяет действующую половину»), уточнением служит
 * весь текст до двоеточия, очищенный от ссылок и тире.
 */
export function qualifierText(raw = '') {
  const emphasised = raw.match(/\*\*([^*]+)\*\*/);
  if (emphasised) return emphasised[1].trim();
  return raw
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim();
}

/**
 * ЦЕЛЬ СВЯЗИ — ИМЯ ФАЙЛА, А НЕ НОМЕР (Р6, Р7).
 *
 * Номер 0060 занят двумя решениями, 0085 — тоже, и хранить ребро по номеру значит выдать обоим
 * одинаковые связи: «Окончательное удаление записей справочников» получало пометку «отменён 0142»,
 * которая относится к недельному листу ЭСМ-2. Ссылка в шапке называет файл — по нему цель и
 * опознаётся.
 *
 * Голый номер без ссылки у занятого дважды номера цель НЕ выбирает: он помечается `ambiguous`, и
 * указатель показывает это как неоднозначность. Догадка здесь была бы хуже пропуска — она молча
 * приписала бы связь не тому решению.
 */
export function adrTargetsIn(value = '', adrsByNumber = new Map()) {
  const out = [];
  const seen = new Set();
  const linked = new Set();
  /*
   * Выделенные куски значения. Частичную отмену автор пишет именно так — «Отменяет: **решение 3
   * [ADR 0133](…)**», — и без этого куска указатель объявил бы отменённым всё решение целиком.
   */
  const spans = [...value.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => ({
    from: m.index,
    to: m.index + m[0].length,
    text: m[1],
  }));
  const spanAt = (index) => spans.find((sp) => index >= sp.from && index < sp.to);
  const LINK =
    /\[[^\]]*\]\(\s*<?\.?\/?((\d{4})-[\w.-]+\.md)(?:#[^)\s]*)?>?\s*\)(?:\s*\(([^)]{0,120})\))?/g;
  for (const m of value.matchAll(LINK)) {
    const [, name, id, note] = m;
    linked.add(id);
    if (seen.has(name)) continue;
    seen.add(name);
    const span = spanAt(m.index);
    out.push({ id, name, ambiguous: false, note: (span ? span.text : (note ?? '')).trim() });
  }
  for (const id of adrRefsIn(value)) {
    if (linked.has(id)) continue;
    const candidates = adrsByNumber.get(id) ?? [];
    if (candidates.length === 1) {
      if (seen.has(candidates[0])) continue;
      seen.add(candidates[0]);
      out.push({ id, name: candidates[0], ambiguous: false, note: '' });
    } else {
      const key = `?${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, name: null, ambiguous: candidates.length > 1, note: '' });
    }
  }
  return out;
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
  const names = readdirSync(adrDir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort();
  // Номер → имена: нужен до разбора связей, чтобы голый номер занятого дважды номера стал
  // неоднозначностью, а не догадкой.
  const adrsByNumber = new Map();
  for (const name of names) {
    const id = name.slice(0, 4);
    adrsByNumber.set(id, [...(adrsByNumber.get(id) ?? []), name]);
  }
  return names.map((name) => {
    const file = path.join(adrDir, name);
    const text = readFileSync(file, 'utf8');
    const header = headerOf(text);
    const entries = parseFields(header);
    const fields = new Map();
    for (const { name: field, value } of entries) {
      fields.set(field, [fields.get(field), value].filter(Boolean).join(' '));
    }
    const statusRaw = (fields.get('Статус') ?? '').trim();
    const relations = [];
    const seen = new Set();
    for (const entry of entries) {
      const kind = RELATION_FIELDS.get(entry.name);
      if (!kind) continue;
      // Цель бывает названа внутри уточнения («Отменяет — в модуле оргтехники — приём [ADR 0053]»),
      // поэтому ищется в обеих половинах строки.
      for (const target of adrTargetsIn(`${entry.qualifier} ${entry.value}`, adrsByNumber)) {
        const key = `${kind}:${target.name ?? `?${target.id}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
          kind,
          id: target.id,
          name: target.name,
          ambiguous: target.ambiguous,
          // Уточнение поля важнее уточнения ссылки: «Отменяет — в модуле оргтехники —» описывает
          // границу отмены, а скобка после ссылки чаще просто называет старое решение.
          qualifier: qualifierText(entry.qualifier) || qualifierText(target.note) || '',
        });
      }
    }
    const region = fields.get('Область');
    return {
      id: name.slice(0, 4),
      name,
      file,
      text,
      header,
      fields,
      title: (text.match(/^#\s+ADR\s+\d{4}\.?\s*(.+)$/m)?.[1] ?? name).trim(),
      statusRaw,
      /*
       * Первое слово: пояснение и дата идут после статуса и словарём не проверяются (Р4).
       * Выделение снимается до разбора — ADR 0134 пишет `**Отменено** [ADR 0154]`, и без этого
       * единственное по-настоящему отменённое решение корпуса не получало знака ⛔: статус
       * сравнивался со словарём вместе со звёздочками и не совпадал ни с чем.
       */
      status: statusRaw.replace(/[*_`]/g, '').split(/[\s(,.;]/)[0] ?? '',
      domains: (fields.get('Домены') ?? '')
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean),
      migrations: fields.get('Миграции') ?? '',
      // Проверке нужны ВСЕ пути шапки: опечатка в любом поле остаётся опечаткой.
      codePaths: codePathsIn(header, { adrDir, root }),
      /*
       * Указателю нужна именно «Область» (Э3 плана). Поле есть у 54 решений из 177; у остальных
       * ту же роль играет legacy-написание — область названа прямо в «Связано» (ADR 0021 и вся
       * ранняя половина корпуса). Поэтому при отсутствии поля берётся шапка целиком: это не запасной
       * ход, а тот же факт в прежнем правописании, ровно как с синонимами полей.
       */
      regionPaths: region
        ? codePathsIn(region, { adrDir, root })
        : codePathsIn(header, { adrDir, root }),
      relations,
    };
  });
}

/**
 * Markdown-документы, чьи ссылки проверяются: `docs/**` и корневые `README.md` с `AGENTS.md` (§6
 * плана). Корневые перечислены поимённо — они и есть точка входа, с которой начинают читать, и
 * битая ссылка в них дороже битой ссылки в глубине `docs`.
 */
export function readDocs(root) {
  const out = [];
  for (const name of ['README.md', 'AGENTS.md']) {
    const full = path.join(root, name);
    if (existsSync(full)) out.push(full);
  }
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
 * СУЩЕСТВОВАЛ ЛИ ПУТЬ КОГДА-НИБУДЬ (Р5). Историю от опечатки отличает не рукописный список, а
 * `git log --all`: файл, живший в репозитории и снятый позже, — правда о прошлом решения; файл,
 * которого не было никогда, — промах в шапке, и возраст решения его не оправдывает.
 *
 * ОТВЕТА ТРИ, А НЕ ДВА. Прежняя двоичная версия возвращала «не существовал» и когда история молчит,
 * и когда её нечем спросить: в архиве исходников без `.git`, в поверхностном клоне (`--depth`), при
 * любом сбое `git`. Там она превращала полсотни исторических путей в ошибки — то есть красила
 * прогон ровно в тех местах, где проверять было нечем. Третий ответ `unknown` честно говорит
 * «не знаю»: он предупреждение, а под `--strict` — ошибка.
 *
 * Ответы кэшируются: путей под сотню, а `git log` по каждому — самая дорогая часть прогона.
 */
export const HISTORY = { EXISTS: 'exists', ABSENT: 'absent', UNKNOWN: 'unknown' };

/** Пригодна ли история к вопросам: есть репозиторий и он не поверхностный. Считается один раз. */
let historyState = null;
function historyUsable(root) {
  if (historyState !== null) return historyState;
  try {
    const git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') historyState = false;
    else historyState = git(['rev-parse', '--is-shallow-repository']) !== 'true';
  } catch {
    historyState = false;
  }
  return historyState;
}

const historyCache = new Map();
export function pathHistory(root, rel) {
  if (historyCache.has(rel)) return historyCache.get(rel);
  let answer = HISTORY.UNKNOWN;
  try {
    const out = execFileSync('git', ['log', '--all', '--oneline', '-1', '--', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Найденный коммит доказывает существование даже в поверхностном клоне; пустой ответ там
    // не доказывает ничего.
    if (out.trim().length > 0) answer = HISTORY.EXISTS;
    else answer = historyUsable(root) ? HISTORY.ABSENT : HISTORY.UNKNOWN;
  } catch {
    answer = HISTORY.UNKNOWN;
  }
  historyCache.set(rel, answer);
  return answer;
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
