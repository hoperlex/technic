#!/usr/bin/env node
/**
 * `pnpm check:version` — согласованность версии портала в трёх местах.
 *
 * ЗАЧЕМ. Номер выпуска живёт не в одном месте, а в трёх: строкой в `VERSION`, тегом на коммите и
 * записью в журнале обновлений, которую заводит миграция. Три места расходятся молча: миграцию
 * пишет человек руками, тег ставится в момент выката, а файл правят до него. Расхождение
 * обнаруживается позже всего и хуже всего — когда по версии пытаются понять, что именно стоит на
 * проде.
 *
 * ПОЧЕМУ ИСТОЧНИК — МИГРАЦИИ, А НЕ БАЗА. Проверка обязана работать на любой машине и в любом
 * прогоне, в том числе без поднятой базы: она сверяет намерение репозитория, а не состояние
 * сервера. Запись выпуска в миграции — то же намерение, и именно она доедет до прода.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Проверки того, что тег указывает на правильный коммит: пока выкат не ставит теги
 * сам, это знание есть только у человека. Отсутствие тега — предупреждение, а не ошибка, и порог
 * назван в политике (`tag.since`).
 *
 * Правила: architecture/policies/versioning.yaml. Решение: docs/adr/0191-version-numbering.md.
 */
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{4})$/;
/** Первый выпуск, у которого тег обязателен. Совпадает с `tag.since` политики. */
const TAG_SINCE = '0.1.83.0191';

/**
 * Известные коллизии номера выпуска — ТОЧНЫМИ множествами версий (`knownCollisions` политики).
 *
 * Разреши мы «номер 64 занимать дважды» — третья версия с тем же номером проехала бы молча, и
 * подмена одной из двух тоже. Здесь же множество сверяется целиком: исключение стережёт ровно ту
 * пару, которую поздно перенумеровывать.
 */
const KNOWN_COLLISIONS = [
  ['0.1.64.0154', '0.1.64.0155'],
  ['0.1.66.0156', '0.1.66.0158'],
];

function isKnownCollision(a, b) {
  const pair = [a, b].sort().join('|');
  return KNOWN_COLLISIONS.some((set) => [...set].sort().join('|') === pair);
}

const errors = [];
const warnings = [];

function out(text) {
  process.stdout.write(`${text}\n`);
}

/** Разбор номера: без него сравнивать версии строкой нельзя — «0.1.10» встанет раньше «0.1.9». */
function parse(version) {
  const m = VERSION_PATTERN.exec(version);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], release: +m[3], decision: m[4], raw: version };
}

function compareLine(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

// ── 1. VERSION ───────────────────────────────────────────────────────────────
const versionFile = path.join(ROOT, 'VERSION');
if (!existsSync(versionFile)) {
  out('ОШИБКА: нет файла VERSION — единственного источника версии в репозитории.');
  process.exit(1);
}
const declared = parse(readFileSync(versionFile, 'utf8').trim());
if (!declared) {
  out('ОШИБКА: VERSION не соответствует формату <линия>.<выпуск>.<решение>, например 0.1.82.0190.');
  process.exit(1);
}

// ── 2. Журнал выпусков из миграций ───────────────────────────────────────────
// Берём ВСЕ записи, а не последнюю по имени файла: номер миграции и порядок выпусков — разные
// потоки, и «последний по алфавиту файл» не обязан нести последний выпуск.
const drizzle = path.join(ROOT, 'apps', 'api', 'drizzle');
const releases = [];
for (const name of readdirSync(drizzle).filter((f) => f.endsWith('.sql'))) {
  const sql = readFileSync(path.join(drizzle, name), 'utf8');
  if (!/INSERT\s+INTO\s+app_releases/i.test(sql)) continue;
  for (const m of sql.matchAll(/'(\d+\.\d+\.\d+\.\d{4})'/g)) {
    const parsed = parse(m[1]);
    if (parsed) releases.push({ ...parsed, file: name });
  }
}

if (releases.length === 0) {
  out('ОШИБКА: в миграциях нет ни одной записи выпуска — сверять версию не с чем.');
  process.exit(1);
}

// Последний выпуск — наибольший по линии, затем по номеру в линии.
const latest = releases.reduce((best, cur) => {
  const line = compareLine(cur, best);
  if (line !== 0) return line > 0 ? cur : best;
  return cur.release > best.release ? cur : best;
});

if (latest.raw !== declared.raw) {
  errors.push(
    `VERSION (${declared.raw}) расходится с последней записью выпуска в миграциях ` +
      `(${latest.raw}, ${latest.file}).`,
  );
}

// ── 3. Монотонность выпусков внутри линии ────────────────────────────────────
const byLine = new Map();
for (const r of releases) {
  const key = `${r.major}.${r.minor}`;
  if (!byLine.has(key)) byLine.set(key, []);
  byLine.get(key).push(r);
}
for (const [line, list] of byLine) {
  const seen = new Map();
  for (const r of list) {
    const prev = seen.get(r.release);
    if (prev && prev.raw !== r.raw) {
      if (isKnownCollision(prev.raw, r.raw)) {
        warnings.push(
          `Линия ${line}: номер выпуска ${r.release} занят дважды (${prev.raw} и ${r.raw}) — ` +
            'известная коллизия, перенумеровать поздно.',
        );
      } else {
        errors.push(
          `Линия ${line}: номер выпуска ${r.release} занят дважды — ${prev.raw} и ${r.raw}.`,
        );
      }
    }
    seen.set(r.release, r);
  }
}

// ── 4. Решение из хвоста существует ──────────────────────────────────────────
const adrDir = path.join(ROOT, 'docs', 'adr');
const adrNumbers = new Set(
  readdirSync(adrDir)
    .map((f) => /^(\d{4})-/.exec(f)?.[1])
    .filter(Boolean),
);
if (!adrNumbers.has(declared.decision)) {
  errors.push(
    `Хвост версии ${declared.decision} не соответствует ни одному решению в docs/adr — ` +
      'хвост обязан называть решение, вошедшее в выпуск, либо повторять хвост предыдущего.',
  );
}

// ── 5. Тег выпуска ───────────────────────────────────────────────────────────
// Отсутствие тега — предупреждение: проверка запускается и до выката, когда ставить его ещё рано.
const since = parse(TAG_SINCE);
const tagRequired =
  compareLine(declared, since) > 0 ||
  (compareLine(declared, since) === 0 && declared.release >= since.release);
if (tagRequired) {
  let tags = '';
  try {
    tags = execFileSync('git', ['tag', '--list', `v${declared.raw}`], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    tags = '';
  }
  if (!tags) warnings.push(`Выпуск ${declared.raw} ещё не помечен тегом v${declared.raw}.`);
}

// ── Итог ─────────────────────────────────────────────────────────────────────
out(`Версия: ${declared.raw}. Записей выпуска в миграциях: ${releases.length}.`);
for (const w of warnings) out(`  предупреждение: ${w}`);
for (const e of errors) out(`  ОШИБКА: ${e}`);
out(`Ошибок: ${errors.length}. Предупреждений: ${warnings.length}.`);
process.exit(errors.length > 0 ? 1 : 0);
