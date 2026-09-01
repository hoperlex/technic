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
 * ЛИНТ НЕ РОНЯЕТ ПРОГОН (решение Р2) — но с двумя оговорками, без которых решение выродилось бы
 * в молчание:
 *   · код возврата 2 фатален всегда: это поломка конфигурации или запуска ESLint, а не известный
 *     долг. Разница принципиальна — «долг не блокирует» не значит «сломанный линт не блокирует»;
 *   · итоговая строка `линт: N ошибок, M предупреждений` печатается всегда, и числа берутся из
 *     машинного вывода (`--format json`), а не из человеческого текста. Долг, который не
 *     блокирует и не показывается, растёт незаметно — именно так набралось 111 предупреждений.
 * После того как ошибок стало ноль (этап Э7 плана), линт становится блокирующим — но это
 * отдельное решение и отдельная правка: сегодня он всё ещё только считает.
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
 * `blocking: false` — шаг может покраснеть, не роняя прогон (сегодня это только линт с долгом).
 * `note` — то, что человек прочитает в итоговой таблице вместо кода возврата.
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

/** Заполняется шагом линта и печатается в итоге отдельной строкой — её ищут глазами. */
let lintLine = 'линт: не запускался';

function lint() {
  const dir = mkdtempSync(join(tmpdir(), 'technic-check-'));
  const file = join(dir, 'eslint.json');
  try {
    // Вывод формата json уходит в файл, а не в терминал: человеку он нечитаем, а нам нужны точные
    // числа. Сам ESLint при этом продолжает писать в stderr свои настоящие ошибки — их видно.
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

    // Код 2 — это «ESLint не смог проверить», а не «в коде найдены ошибки». Такой ответ обязан
    // ронять прогон: иначе поломка конфига читалась бы как чистый код. Нечитаемый отчёт — то же
    // самое: без чисел решение «не блокировать» превращается в тишину.
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

    // Ошибки печатаются поимённо (их положено чинить), предупреждения — сводкой по правилам:
    // сотня строк подряд не читается никем, а «сколько и чего» отвечает на вопрос о долге.
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
      blocking: false,
      note:
        errors === 0
          ? `${warnings} предупреждений (долг)`
          : `${errors} ошибок, ${warnings} предупреждений (долг, прогон не роняет)`,
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
