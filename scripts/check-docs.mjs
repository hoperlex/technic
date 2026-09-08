#!/usr/bin/env node
/**
 * `pnpm check:docs` — целостность документации: коллизии номеров решений, битые ссылки, пути из
 * шапок, словари статуса и доменов.
 *
 * ЗАЧЕМ. В `docs` больше трёхсот документов и 176 нумерованных решений; ссылки между ними и есть
 * навигация, и она уже поехала — 113 промахов, два номера заняты дважды. Указатель решений
 * (`docs/adr/README.md`, этап Э3) собирается из этих же шапок, поэтому проверка и генератор
 * пользуются одним разбором (`scripts/lib/docs-navigation.mjs`, Р2): две реализации на таком
 * разнообразии шапок дали бы два разных графа.
 *
 * ЧТО РОНЯЕТ ПРОГОН. Всё, что означает ошибку прямо сейчас: новая коллизия номера, битая ссылка
 * четырёх классов, отсутствующий путь из шапки затронутого решения, статус или домен вне словаря.
 * Исторический долг — только то, что поимённо занесено в baseline (`scripts/lib/docs-baseline.mjs`)
 * с причиной; остального «известного долга» здесь нет и не заводится.
 *
 * СТРОГОСТЬ ОБЪЯВЛЯЕТ САМ ФАЙЛ (Р8). Обязательные поля новой шапки спрашиваются с решений, у
 * которых есть поле «Домены»: написав его, автор сказал «этот файл по новой форме». Границу по
 * `git diff` проверка не проводит — поток занимает по два-три решения в день, и любой снимок
 * границы устаревал бы в день выката, а «затронутое» в общем дереве включает чужие незавершённые
 * правки.
 *
 * УРОВЕНЬ НАХОДКИ — ПО ЕЁ ПРИРОДЕ (Р12): ошибка — сломано (ссылка в никуда, задвоенный номер,
 * отставший указатель), предупреждение — не описано (домен не назначен, маршрут не в карте).
 * Поднять вторые до первых можно флагом `--strict` — это режим ведущего документацию.
 *
 * РЕЖИМЫ:
 *   node scripts/check-docs.mjs                  — проверить, ненулевой код при ошибках;
 *   node scripts/check-docs.mjs --report-only     — те же находки, код возврата 0 (снять baseline);
 *   node scripts/check-docs.mjs --strict          — поднять предупреждения до ошибок.
 *
 * План: docs/docs-navigation-plan.md, этап Э1.
 */
import process from 'node:process';
// Печать — через `process.stdout`, как в `scripts/check.mjs`: корневые скрипты не размечены
// node-глобалями в конфиге линта, и `console` там читается как опечатка.
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DOMAINS,
  STATUSES,
  classifyBrokenLink,
  collisionProblems,
  linksIn,
  pathEverExisted,
  readAdrs,
  readDocs,
} from './lib/docs-navigation.mjs';
import { LEGACY_DOMAINS } from './lib/docs-legacy-domains.mjs';

const say = (text = '') => process.stdout.write(`${text}\n`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const reportOnly = argv.includes('--report-only');
// `--strict` поднимает предупреждения до ошибок: режим того, кто ведёт указатель и карту (Р12).
// В общих воротах он не включается — «не описано» не должно ронять чужой прогон.
const strict = argv.includes('--strict');

const adrs = readAdrs(ROOT);
const docs = readDocs(ROOT);
const adrsByNumber = new Map();
for (const adr of adrs) adrsByNumber.set(adr.id, [...(adrsByNumber.get(adr.id) ?? []), adr.name]);

const errors = [];
const warnings = [];

// ── Коллизии номеров ─────────────────────────────────────────────────────────────────────────
for (const problem of collisionProblems(adrs)) errors.push({ kind: 'collision', text: problem });

// ── Ссылки ───────────────────────────────────────────────────────────────────────────────────
const linkCounts = { 'missing-parent': 0, 'adr-slug': 0, 'code-path': 0, other: 0, total: 0 };
for (const file of docs) {
  const rel = path.relative(ROOT, file);
  for (const link of linksIn(readFileSync(file, 'utf8'))) {
    linkCounts.total += 1;
    const abs = path.resolve(path.dirname(file), link.target);
    if (existsSync(abs)) continue;
    const { kind, hint } = classifyBrokenLink({
      file,
      target: link.target,
      root: ROOT,
      adrsByNumber,
    });
    linkCounts[kind] += 1;
    const where = `${rel}:${link.line}`;
    const text = `${where} → ${link.target}${hint ? ` (${hint})` : ''}`;
    /*
     * Ссылка в код, которого нет: жил ли он когда-нибудь (Р5). Жил — история решения, и её не
     * чинят; не жил — опечатка, и возраст документа её не оправдывает.
     */
    if (kind === 'code-path' && pathEverExisted(ROOT, hint)) warnings.push({ kind, text });
    else errors.push({ kind: `link:${kind}`, text });
  }
}

// ── Пути из шапок решений ────────────────────────────────────────────────────────────────────
let headerPaths = 0;
for (const adr of adrs) {
  for (const target of adr.codePaths) {
    headerPaths += 1;
    if (existsSync(path.join(ROOT, target))) continue;
    const text = `${adr.name} → ${target}`;
    if (pathEverExisted(ROOT, target)) warnings.push({ kind: 'header-path', text });
    else errors.push({ kind: 'header-path', text: `${text} — такого пути не было никогда` });
  }
}

// ── Источник домена: ровно один на решение (Р3) ───────────────────────────────────────────────
/*
 * Ни одного источника — решение выпадет из указателя целиком; два источника — поле и строка
 * таблицы разъедутся на первой же правке, и разъедутся молча. Поэтому оба случая ошибки, и
 * ретрофит шапки обязан удалять строку из таблицы, а не дополнять её.
 */
for (const adr of adrs) {
  const inTable = LEGACY_DOMAINS.has(adr.name);
  const hasField = adr.domains.length > 0;
  if (!inTable && !hasField) {
    errors.push({
      kind: 'domains',
      text: `${adr.name}: нет ни поля «Домены», ни строки в таблице`,
    });
  }
  if (inTable && hasField) {
    errors.push({
      kind: 'domains',
      text: `${adr.name}: домен задан дважды — поле «Домены» и строка таблицы`,
    });
  }
}

// ── Свежесть указателя ────────────────────────────────────────────────────────────────────────
/*
 * Сверка идёт САМИМ генератором (`--check`), а не второй сборкой здесь: два кода, собирающих один
 * файл, разошлись бы — и первым признаком стал бы вечно красный прогон при верном указателе.
 */
{
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/gen-adr-index.mjs'), '--check'],
    {
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) {
    errors.push({ kind: 'index', text: (res.stdout || res.stderr || '').trim() });
  }
}

// ── Карта кода: полнота владения входами ──────────────────────────────────────────────────────
/*
 * Карта описывает СЕГОДНЯШНЕЕ состояние, поэтому её пути строги без всякого baseline (Р10), а
 * полнота считается по дереву, а не по числу в плане: разделы берутся из реестра контрактов,
 * маршруты — перечнем файлов. Реестр читается РАЗБОРОМ файла, а не импортом: модули контрактов
 * пишут импорты без расширений, и голым Node такой файл не грузится (тот же приём у
 * `apps/web/scripts/check-portal-routes.mjs`).
 */
const MAP_FILE = path.join(ROOT, 'docs', 'code-map.md');
/*
 * «Не описано» — предупреждение, «сломано» — ошибка (Р12). Маршрут, не попавший в карту, и раздел
 * без блока — это чужая нормальная работа, ещё не описанная тем, кто ведёт документацию; уронив
 * ими общий прогон, мы обязали бы автора нового `routes/*.ts` править отдельный рукописный
 * документ. Битая ссылка карты и отсутствие самого файла остаются ошибкой: это сломано.
 */
const gap = (text) => warnings.push({ kind: 'map', text });
const REQUIRED_MAP_LINES = ['Источник истины', 'Разделы портала', 'API-маршруты', 'Решения'];
if (!existsSync(MAP_FILE)) {
  errors.push({ kind: 'map', text: 'нет docs/code-map.md' });
} else {
  const map = readFileSync(MAP_FILE, 'utf8');
  const blocks = map.split(/^## /m).slice(1);
  for (const block of blocks) {
    const title = block.split('\n')[0].trim();
    for (const line of REQUIRED_MAP_LINES) {
      if (!block.includes(`- ${line}:`)) gap(`блок «${title}»: нет строки «${line}»`);
    }
  }
  // Пути карты обязаны существовать: устаревший путь здесь — дефект, а не история.
  for (const link of linksIn(map)) {
    if (!existsSync(path.resolve(path.dirname(MAP_FILE), link.target))) {
      errors.push({ kind: 'map', text: `docs/code-map.md:${link.line} → ${link.target}` });
    }
  }
  // Разделы портала: каждый идентификатор реестра — ровно у одного блока.
  const registry = readFileSync(
    path.join(ROOT, 'packages/contracts/src/portal-sections.ts'),
    'utf8',
  );
  const ids = [...new Set([...registry.matchAll(/^\s+id: '([a-z-]+)',$/gm)].map((m) => m[1]))];
  for (const id of ids) {
    const owners = blocks.filter((b) => new RegExp(`- Разделы портала:.*\`${id}\``).test(b));
    if (owners.length === 0) gap(`раздел «${id}» не назван ни одним блоком`);
    if (owners.length > 1) gap(`раздел «${id}» назван ${owners.length} блоками`);
  }
  // Маршруты: каждый файл покрыт хотя бы одним блоком, широкого покрытия каталогом не бывает.
  const routeDir = path.join(ROOT, 'apps/api/src/routes');
  const routeFiles = readdirSync(routeDir).filter((n) => n.endsWith('.ts'));
  for (const name of routeFiles) {
    if (!map.includes(`apps/api/src/routes/${name}`)) gap(`маршрут ${name} не покрыт картой`);
  }
  if (/\(\.\.\/apps\/api\/src\/routes\)|\(\.\.\/apps\/api\/src\)/.test(map)) {
    gap('широкое покрытие корневым каталогом маршрутов');
  }
}

// ── AGENTS.md: есть и не разросся (Р13) ───────────────────────────────────────────────────────
/*
 * Отсутствие файла — ошибка: без него у входа в репозиторий нет двери. Длина — предупреждение:
 * это ограничение прозы, и ронять им сборку неправильно; порог задуман поводом подрезать
 * справочное содержание, уже доступное по ссылкам в указателе и карте.
 */
{
  const agents = path.join(ROOT, 'AGENTS.md');
  if (!existsSync(agents)) errors.push({ kind: 'agents', text: 'нет корневого AGENTS.md' });
  else {
    const length = readFileSync(agents, 'utf8').trimEnd().split('\n').length;
    if (length > 100) {
      warnings.push({
        kind: 'agents',
        text: `AGENTS.md разросся: ${length} строк при пороге 100 — вынесите справочное в карту и указатель`,
      });
    }
  }
}

// ── Строгую форму объявляет сам файл (Р8) ────────────────────────────────────────────────────
/*
 * СТРОГОСТЬ СПРАШИВАЕТСЯ С ТЕХ, КТО ЕЁ ОБЪЯВИЛ. Признак — поле «Домены» в шапке: написав его,
 * автор сказал «этот файл по новой форме», и с него спрашивается всё остальное — словарь статуса,
 * словарь доменов, «Область».
 *
 * Почему не `git diff` от базы. Поток занимает по два-три решения в день, и любой снимок границы
 * («всё, что новее такого-то») устаревал бы в день выката: первый же чужой ADR старого образца
 * ронял бы общие ворота. А набор «затронутого» в ОБЩЕМ дереве включает чужие незавершённые правки
 * — зелёный результат зависел бы от чужого файла. Признак «есть поле» одинаково работает до
 * коммита, после, без `origin/main` и в архиве исходников, а новая форма вводится добровольно.
 */
for (const adr of adrs) {
  if (adr.domains.length === 0) continue;
  if (!STATUSES.includes(adr.status)) {
    errors.push({ kind: 'status', text: `${adr.name}: статус «${adr.statusRaw.slice(0, 48)}»` });
  }
  for (const domain of adr.domains) {
    if (!DOMAINS.includes(domain)) {
      errors.push({ kind: 'domains', text: `${adr.name}: домен «${domain}» вне словаря` });
    }
  }
  if (!adr.fields.has('Область')) {
    errors.push({ kind: 'area', text: `${adr.name}: есть «Домены», но нет «Область»` });
  }
}

// ── Итог ─────────────────────────────────────────────────────────────────────────────────────
/*
 * Форма вывода — как у `scripts/check.mjs`: прогон не останавливается на первой находке, числа
 * печатаются всегда, итог собирается в конце. Числа считаются по дереву, а не зашиты константами:
 * дерево общее, и снимок обмера устаревает быстрее, чем правится проверка.
 */
say(`Решений: ${adrs.length}. Документов: ${docs.length}. Локальных ссылок: ${linkCounts.total}.`);
say(
  `Битые ссылки: не хватает «../» — ${linkCounts['missing-parent']}, устаревший slug решения — ` +
    `${linkCounts['adr-slug']}, снятый код — ${linkCounts['code-path']}, прочее — ${linkCounts.other}.`,
);
say(
  `Путей в шапках решений: ${headerPaths}. Решений по новой форме (с полем «Домены»): ` +
    `${adrs.filter((a) => a.domains.length > 0).length}.`,
);

const show = (list, title) => {
  if (list.length === 0) return;
  say(`\n${title} (${list.length}):`);
  for (const item of list.slice(0, 25)) say(`  ${item.text}`);
  if (list.length > 25) say(`  … и ещё ${list.length - 25}`);
};
show(warnings, 'Известный исторический долг');
show(errors, 'Ошибки');

say(`\nОшибок: ${errors.length}. Предупреждений: ${warnings.length}.`);
if (strict && warnings.length > 0) {
  say('Режим --strict: предупреждения считаются ошибками.');
}
if (reportOnly && errors.length > 0) {
  say('Режим --report-only: код возврата 0, находки только показаны.');
}
/*
 * `--report-only` возвращает 0 всегда: им снимают картину, а не проверяют. `--strict` поднимает
 * предупреждения до ошибок целиком — одним местом, а не веткой у каждой находки: иначе «поднять
 * всё» и «поднять то, что не забыли поднять» разъехались бы на первой же новой проверке.
 */
const failing = errors.length + (strict ? warnings.length : 0);
process.exit(!reportOnly && failing > 0 ? 1 : 0);
