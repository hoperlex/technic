#!/usr/bin/env node
/**
 * `pnpm check` — быстрые ворота качества: типы, линт и все тесты, кроме db-набора.
 *
 * ЗАЧЕМ. Полный прогон 31.08.2026 нашёл 33 падения, и среди них — потерю скана разбора талона,
 * прожившую пять дней при живом и работающем тесте, красный веб-тест (сутки) и красный линт
 * (несколько дней). Запускать всё это было нечему: ни CI, ни хука, ни вызова тестов в деплое.
 * Ворота не добавляют автоматики (её нет намеренно, ADR 0147 Р1) — они убирают повод не
 * запускать: одна команда вместо четырёх разных с разными исключениями.
 *
 * ПОЧЕМУ ПРОГОН НЕ ОСТАНАВЛИВАЕТСЯ НА ПЕРВОМ ПАДЕНИИ. Каждый шаг идёт независимо от исхода
 * предыдущих, а итог собирается в конце одной таблицей. Иначе красный `typecheck` прятал бы за
 * собой красные тесты, человек чинил бы их по одному, каждый раз заново ожидая четыре минуты
 * фронта, — и это ровно тот режим, из-за которого сегодняшние находки жили сутками. Шаги друг
 * друга не портят: vitest типы не проверяет, а линт вообще ни от чего не зависит.
 *
 * ПОРЯДОК ШАГОВ — от самого дешёвого и объясняющего к самому долгому. `typecheck` идёт первым,
 * потому что он объясняет половину падений тестов раньше, чем те начнутся; фронт — последним:
 * он один занимает минуты, а до него человек уже видит первые ответы на экране.
 *
 * LINT FAILS THE RUN ON ERRORS, NEVER ON WARNINGS. It started as a counter (ADR 0147 §4, decision
 * Р2) because the repository had a dozen errors and a blocking gate could not be passed at all.
 * The errors are at zero now, and ADR 0147 promised the switch for exactly that moment
 * (docs/lint-debt-plan.md, Э8): a counter let the first cleanup's errors come back with a new file
 * unnoticed. An error-level rule means broken or forbidden code, so it blocks. A warning is known
 * debt by construction — rule levels stay as they are (plan Р7) — so it never blocks. Two things
 * hold either way:
 *   · exit code 2 is always fatal: ESLint could not check the code (broken config or launch), and
 *     a broken linter must not read as clean code;
 *   · the line `линт: N ошибок, M предупреждений` is always printed, with numbers taken from the
 *     machine report (`--format json`), not from human text. Warnings have no other guard (Р7), and
 *     debt that neither blocks nor shows grows unnoticed — that is how 111 warnings piled up.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. `*.db.test.ts` — они в `pnpm check:db`: тем тестам нужна своя свежая база, и
 * прогон их на общей даёт ложные падения. Перед выкатом с миграцией `check:db` пропускать не стоит:
 * сегодняшняя потеря данных найдена именно db-тестом. Обязанность это человека, а не деплоя —
 * гейт из `deploy-auto` снят (ADR 0147, пересмотр 01.09.2026).
 *
 * План: docs/test-gates-plan.md, этап Э3. Решение: docs/adr/0147-quality-gates.md.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
/** Корень монорепо: каталог скриптов лежит ровно в нём, и на cwd опираться не нужно. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const say = (text = '') => process.stdout.write(`${text}\n`);

/** Итоги шагов: заполняется по ходу, печатается таблицей в конце. */
const results = [];

/**
 * An outcome with `blocking: false` turns red without failing the run. No step returns it since
 * lint became blocking; it stays for a gate that has to start with known debt, as lint did.
 * `note` is what a person reads in the summary table instead of an exit code.
 */
function step({ title, hint, run }) {
  say();
  // В заголовке — и название шага, и чем он делается: разбирая красный прогон, человек первым
  // делом хочет повторить упавший шаг отдельно, а не искать его команду по всему файлу.
  const head = `── ${title} · ${hint} `;
  say(`${head}${'─'.repeat(Math.max(3, 78 - head.length))}`);
  const started = Date.now();
  const outcome = run();
  results.push({
    title,
    blocking: true,
    seconds: Math.round((Date.now() - started) / 1000),
    ...outcome,
  });
}

/** Запуск с прямым выводом в терминал: человеку нужен вывод инструмента, а не пересказ. */
function exec(command, args, options = {}) {
  const res = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (res.error) return { ok: false, note: `не удалось запустить: ${res.error.message}` };
  const code = res.status ?? -1;
  return { ok: code === 0, code, note: code === 0 ? '' : `код возврата ${code}` };
}

// --- линт ------------------------------------------------------------------

/** Filled by the lint step and printed in the summary on a line of its own: people look for it. */
let lintLine = 'линт: не запускался';

function lint() {
  const dir = mkdtempSync(join(tmpdir(), 'technic-check-'));
  const file = join(dir, 'eslint.json');
  try {
    // The json report goes to a file, not to the terminal: a person cannot read it, and we need
    // exact numbers. ESLint still writes its own real failures to stderr, so those stay visible.
    const res = spawnSync(
      'pnpm',
      ['exec', 'eslint', '.', '--format', 'json', '--output-file', file],
      {
        cwd: ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    if (res.error) {
      lintLine = 'линт: не запустился';
      return { ok: false, note: `не удалось запустить ESLint: ${res.error.message}` };
    }
    const code = res.status ?? -1;

    let report = null;
    try {
      report = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      report = null;
    }

    // Code 2 means "ESLint could not check", not "the code has errors", and it must fail the run:
    // otherwise a broken config would read as clean code. An unreadable report fails the same way:
    // without it there are no errors to count, so the gate would pass on silence.
    if (code === 2 || !Array.isArray(report)) {
      lintLine = 'линт: посчитать не удалось';
      return {
        ok: false,
        note:
          code === 2 ? 'ESLint не смог проверить код (код 2)' : 'ESLint не отдал машинный отчёт',
      };
    }

    let errors = 0;
    let warnings = 0;
    const byRule = new Map();
    for (const fileReport of report) {
      errors += fileReport.errorCount ?? 0;
      warnings += fileReport.warningCount ?? 0;
      for (const message of fileReport.messages ?? []) {
        const rule = message.ruleId ?? '(без правила)';
        const place = `${fileReport.filePath.replace(ROOT, '')}:${message.line}:${message.column}`;
        if (message.severity === 2) say(`  ОШИБКА ${place}  ${rule}: ${message.message}`);
        byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }
    }

    // Errors are printed one by one (they fail the run and are to be fixed), warnings as a summary
    // by rule: nobody reads a hundred lines in a row, and "how many of what" answers the debt
    // question.
    if (warnings > 0) {
      say('  предупреждения по правилам:');
      for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
        say(`    ${String(count).padStart(4)} × ${rule}`);
      }
    }

    lintLine = `линт: ${errors} ошибок, ${warnings} предупреждений`;
    say(lintLine);
    return {
      ok: errors === 0,
      note:
        errors === 0
          ? `${warnings} предупреждений (долг)`
          : `${errors} ошибок, ${warnings} предупреждений (предупреждения — долг)`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- прогон ----------------------------------------------------------------

say('pnpm check — типы, линт и тесты без db-набора.');
say('db-тесты сюда не входят: им нужна своя свежая база — pnpm check:db.');

step({
  title: 'типы',
  hint: 'pnpm -r typecheck',
  run: () => exec('pnpm', ['-r', 'typecheck']),
});

step({ title: 'линт', hint: 'eslint .', run: lint });

// `exec vitest run`, а не скрипт пакета: `--exclude` через `pnpm run` разбирался бы самим pnpm,
// а не vitest. Позиционного фильтра тут нет намеренно — исключается набор, а не выбирается.
step({
  title: 'тесты api (без db)',
  hint: 'vitest run --exclude **/*.db.test.ts',
  run: () =>
    exec('pnpm', [
      '--filter',
      '@technic/api',
      'exec',
      'vitest',
      'run',
      '--exclude',
      '**/*.db.test.ts',
    ]),
});

step({
  title: 'тесты worker (без db)',
  hint: 'vitest run --exclude **/*.db.test.ts',
  run: () =>
    exec('pnpm', [
      '--filter',
      '@technic/worker',
      'exec',
      'vitest',
      'run',
      '--exclude',
      '**/*.db.test.ts',
    ]),
});

// Пять проверок фронта (`pretest`) и его тесты — ДВА шага, а не один запуск `pnpm test`.
// Причина в связке `&&` внутри pretest: упав, он не даёт vitest запуститься вовсе, и человек
// чинил бы бюджет качества, не подозревая, что за ним ждут красные тесты. Порознь видно оба.
step({
  title: 'фронт: пять проверок (pretest)',
  hint: 'бюджеты качества, раскладка, блокираторы форм, маршруты',
  run: () => exec('pnpm', ['--filter', '@technic/web', 'run', 'pretest']),
});

step({
  title: 'фронт: тесты',
  hint: 'vitest run',
  run: () => exec('pnpm', ['--filter', '@technic/web', 'exec', 'vitest', 'run']),
});

/*
 * Свои тесты системы обслуживания кодовой базы (docs/maintenance-framework-plan.md). Штатный
 * `node --test`, а не vitest: `tools/maintenance` — не пакет рабочего пространства, своего
 * `package.json` у него нет, и заводить его ради тестов значило бы объявить инструмент частью
 * сборки портала.
 *
 * Шаг стоит в воротах по решению заказчика 14.09.2026: набор, который никто не гоняет, протухает,
 * а эта система решает, что можно править автоматически, — её собственная поломка дороже пяти
 * секунд прогона. Ровно столько он и занимает.
 */
step({
  title: 'обслуживание: тесты',
  hint: 'node --test tools/maintenance/test',
  run: () => exec('pnpm', ['run', 'maintain:test']),
});

/*
 * Типы системы обслуживания.
 *
 * Их не проверял НИКТО: `pnpm -r typecheck` обходит рабочие пакеты, а `tools/` пакетом не является.
 * Node исполняет TypeScript стиранием типов и на несуществующее имя не ругается, пока до строки не
 * дойдёт выполнение, — 18.09.2026 так дожили до ворот три ненайденных имени сразу. Свой tsconfig у
 * системы есть; не хватало только шага, который его гоняет.
 */
step({
  title: 'обслуживание: типы',
  hint: 'tsc -p tools/maintenance/tsconfig.json --noEmit',
  run: () => exec('npx', ['tsc', '-p', 'tools/maintenance/tsconfig.json', '--noEmit']),
});

// This gate always builds with a fixed BUILD_ID and compares measured positive byte limits.
// Keep it out of pretest: targeted UI tests must not pay for a production build each time.
step({
  title: 'фронт: бюджет бандла',
  hint: 'pnpm --filter @technic/web bundle:check',
  run: () => exec('pnpm', ['--filter', '@technic/web', 'bundle:check']),
});

/*
 * Документация — последним шагом (ADR 0176). Порог включения был назван заранее: ноль ошибок, и он
 * достигнут — 106 битых ссылок починены, а исторические пути отделены от опечаток вопросом к
 * истории git.
 *
 * РОНЯЕТ ПРОГОН ТОЛЬКО ОШИБКАМИ, и это решение, а не умолчание: «сломано» (ссылка в никуда,
 * задвоенный номер, отставший указатель) — следствие правки того, кто её сделал; «не описано»
 * (маршрут ещё не в карте, домен не назначен) ведёт тот, кто ведёт документацию, и новый файл
 * `routes/*.ts` не должен красить чужой прогон, пока карта не дополнена. Поднять предупреждения
 * до ошибок можно `pnpm check:docs -- --strict`.
 *
 * Шаг дешёвый (секунды) и стоит в конце по той же причине, по которой типы стоят первыми: он
 * ничего не объясняет в падениях кода, зато ловит то, чего не ловит ни один тест.
 */
step({
  title: 'документация',
  hint: 'node scripts/check-docs.mjs',
  run: () => exec('node', ['scripts/check-docs.mjs']),
});

// --- итог ------------------------------------------------------------------

say();
say('══ итог pnpm check ═══════════════════════════════════════════════════════');
for (const result of results) {
  const mark = result.ok ? 'ок     ' : result.blocking ? 'ПАДЕНИЕ' : 'долг   ';
  const tail = result.note ? `  — ${result.note}` : '';
  say(`  ${mark} ${result.title.padEnd(30)} ${String(result.seconds).padStart(4)} с${tail}`);
}
say();
say(lintLine);

const broken = results.filter((result) => !result.ok && result.blocking);
if (broken.length > 0) {
  say(`ворота НЕ пройдены: ${broken.map((result) => result.title).join(', ')}.`);
  process.exit(1);
}

say('быстрый набор зелёный.');
say('db-набор идёт отдельно: pnpm check:db — ему нужна своя база и минуты времени.');
