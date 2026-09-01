#!/usr/bin/env node
/**
 * `pnpm check:db` — db-набор на СВЕЖЕЙ базе, двумя заходами, с уборкой за собой.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА. Без неё ворота бессмысленны: продуктовый дефект, ради которого их
 * заводили, — потеря скана разбора талона — найден `file-linkage.db.test.ts`, а он в быстрый
 * набор не входит. Держать db-тесты в `pnpm check` тоже нельзя: им нужна своя база и минуты
 * времени, и общая команда, которую не запускают из-за долготы, хуже двух честных.
 *
 * ПОЧЕМУ БАЗА СВЕЖАЯ, А НЕ ОБЩАЯ. Общая `technic_archive_test` врёт в обе стороны — см. шапку
 * `apps/api/scripts/quality-db.ts`. Привычка объяснять красное средой стоила пяти дней жизни
 * настоящему дефекту: на чистой базе он падает детерминированно.
 *
 * ПОЧЕМУ ДВА ЗАХОДА. Первый идёт `--maxWorkers=3` — так набор укладывается в разумное время.
 * Часть падений в нём наносная: файлы делят одну базу и `max_connections`, и сосед, оборвавший
 * соединение, красит невиновного. Второй заход повторяет ТОЛЬКО упавшие файлы `--maxWorkers=1`:
 * в одиночку конкурировать не с кем, и то, что покраснело снова, покраснело по делу. Зелёный
 * повтор не прячется — файлы называются вслух: это не «ничего не было», а «проверьте изоляцию».
 *
 * ПОЧЕМУ WORKER ПОСЛЕ API. Тесты воркера ждут промигрированную базу, а миграции накатывают тесты
 * api. Обратный порядок дал бы падение, не имеющее отношения к воркеру.
 *
 * АДРЕС БАЗЫ — из окружения (`TEST_DATABASE_URL`, иначе `DATABASE_URL`), не зашит: локально это
 * dev-кластер на 5433, на другой машине — другой. Заводится и сносится СВОЯ база с отметкой
 * времени в имени; чужую команда не трогает никогда — из адреса берётся только кластер.
 *
 * План: docs/test-gates-plan.md, этап Э3. Решение: docs/adr/0147-quality-gates.md.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { ROOT, reportStamp, writeStamp } from './quality-stamp.mjs';

const say = (text = '') => process.stdout.write(`${text}\n`);

/**
 * Необязательный фильтр: `pnpm check:db file-linkage` прогонит на свежей базе только его. Нужен
 * тому, кто чинит один db-тест, — иначе каждая проверка правки стоила бы полного набора.
 *
 * Отметку о зелёном прогоне такой запуск НЕ пишет: прошла часть набора, а отметка утверждает про
 * весь. Разрешить ей писаться значило бы завести законный способ выкатить, прогнав один файл.
 */
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const partial = filters.length > 0;

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) {
  say(
    'не задан ни TEST_DATABASE_URL, ни DATABASE_URL — неизвестно, в каком кластере заводить базу.',
  );
  say('локально это, как правило:');
  say('  TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev pnpm check:db');
  say('Из адреса берётся только кластер: база заводится своя, с отметкой времени в имени.');
  process.exit(2);
}

/**
 * Имя базы прогона. Отметка времени делает его уникальным — на это опирается уборка: она сносит
 * базу прогона вместе с производными, которые заводят себе отдельные тесты.
 */
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const DB_NAME = `technic_check_${stamp}`;

const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const targetUrl = new URL(source);
targetUrl.pathname = `/${DB_NAME}`;

const dbEnv = {
  ...process.env,
  QUALITY_DB_ADMIN_URL: adminUrl.toString(),
  QUALITY_DB_NAME: DB_NAME,
};

function manageDb(mode) {
  const res = spawnSync(
    'pnpm',
    ['--filter', '@technic/api', 'exec', 'tsx', 'scripts/quality-db.ts', mode],
    { cwd: ROOT, stdio: 'inherit', env: dbEnv },
  );
  return (res.status ?? -1) === 0;
}

/** Уборка идёт и по обрыву: Ctrl+C посреди прогона иначе оставлял бы базу навсегда. */
let dropped = false;
function dropOnce() {
  if (dropped) return;
  dropped = true;
  manageDb('drop');
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(`\nпрогон прерван (${signal}) — сношу базу ${DB_NAME}`);
    dropOnce();
    process.exit(130);
  });
}

// --- заходы vitest ---------------------------------------------------------

const reportDir = mkdtempSync(join(tmpdir(), 'technic-check-db-'));

/**
 * Один заход vitest. Кроме обычного вывода просит машинный отчёт: имена упавших файлов нужны
 * второму заходу точными, а разбирать человеческий вывод — способ однажды повторить не то.
 *
 * ВАЖНО про фильтр: позиционный аргумент vitest — ПОДСТРОКА ПУТИ, а не маска. `db.test` отбирает
 * весь набор, а маска-глоб (две звёздочки, слэш, звёздочка, `.db.test.ts`) не нашла бы ни одного
 * файла — заход оказался бы пустым и зелёным, то есть ворота молча пропустили бы всё.
 */
function vitestPass(pkg, filters, workers) {
  // Имя пакета идёт в имя файла отчёта, а в нём есть `@` и слэш — иначе vitest завёл бы
  // в каталоге отчётов подкаталог `@technic`, чего никто не просил.
  const slug = pkg.replace(/[^a-z0-9]+/gi, '-');
  const jsonFile = join(reportDir, `${slug}-${workers}-${Date.now()}.json`);
  const res = spawnSync(
    'pnpm',
    [
      '--filter',
      pkg,
      'exec',
      'vitest',
      'run',
      ...filters,
      `--maxWorkers=${workers}`,
      // При точечном фильтре пустой заход — норма: файл может лежать только в одном из пакетов.
      // Полный набор такого допуска не получает: пустой заход там означал бы, что фильтр набора
      // сломан, и ворота молча пропустили бы всё.
      ...(partial ? ['--passWithNoTests'] : []),
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${jsonFile}`,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: targetUrl.toString() },
    },
  );

  let failed = [];
  let files = 0;
  try {
    const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
    files = (report.testResults ?? []).length;
    failed = (report.testResults ?? [])
      .filter((file) => file.status === 'failed')
      .map((file) => file.name)
      .map((name) => {
        const cut = name.indexOf('/test/');
        return cut > 0 ? name.slice(cut + 1) : name;
      });
  } catch {
    failed = [];
  }

  return { ok: (res.status ?? -1) === 0, files, failed: [...new Set(failed)] };
}

/**
 * Набор одного пакета целиком: заход в три работника, затем одиночный повтор упавших.
 * Возвращает `{ ok, note }`, где `note` — то, что человек прочитает в итоге.
 */
function suite(pkg, title) {
  say();
  say(`── ${title}: заход 1 из 2 (--maxWorkers=3) ────────────────────────────`);
  const first = vitestPass(pkg, partial ? filters : ['db.test'], 3);
  if (first.ok) {
    return {
      ok: true,
      files: first.files,
      note:
        first.files === 0
          ? 'по фильтру файлов нет'
          : `зелено с первого захода, файлов: ${first.files}`,
    };
  }

  if (first.failed.length === 0) {
    // Падение без единого красного файла — это необработанные исключения (например, обрыв
    // соединений при сносе базы) либо отказ самого vitest. Повторять нечего, и списать на
    // конкуренцию такое нельзя: vitest честно предупреждает, что тесты могли стать
    // ложноположительными.
    return {
      ok: false,
      note: 'прогон упал без красных файлов — смотрите необработанные исключения выше',
    };
  }

  say();
  say(`── ${title}: заход 2 из 2 (--maxWorkers=1, только упавшие) ────────────`);
  say(`   повторяются: ${first.failed.join(', ')}`);
  const second = vitestPass(pkg, first.failed, 1);
  if (second.ok) {
    return {
      ok: true,
      note: `краснели только в параллельном заходе (конкуренция, не регрессия): ${first.failed.join(', ')}`,
    };
  }
  const real = second.failed.length > 0 ? second.failed.join(', ') : 'см. вывод выше';
  return { ok: false, note: `воспроизводимые падения: ${real}` };
}

// --- прогон ----------------------------------------------------------------

say(`pnpm check:db — свежая база ${DB_NAME} в кластере ${adminUrl.host}.`);
if (partial) {
  say(
    `точечный прогон по фильтру: ${filters.join(', ')} — отметка о зелёном прогоне записана НЕ будет.`,
  );
  say(
    'фильтр — подстрока пути, а не маска: под него может попасть и тест, которому база не нужна.',
  );
}

if (!manageDb('create')) {
  say('базу завести не удалось — прогон не начинался, сносить нечего.');
  rmSync(reportDir, { recursive: true, force: true });
  process.exit(1);
}

// Точечному прогону миграции накатываются заранее: под фильтр может не попасть ни один тест api,
// а именно они наполняют базу в полном наборе. Полный набор этого шага не получает намеренно —
// иначе тесты, которые проверяют поведение на непромигрированной базе, проверяли бы не то.
if (partial && !manageDb('migrate')) {
  say('миграции на свежую базу не накатились — точечный прогон был бы бессмысленным.');
  dropOnce();
  rmSync(reportDir, { recursive: true, force: true });
  process.exit(1);
}

const results = [];
try {
  results.push({ title: 'api db', ...suite('@technic/api', 'api db') });
  // Воркер идёт всегда, даже если api покраснел: цель прогона — увидеть все проблемы разом.
  // Но если api не дошёл до миграций, красное у воркера может быть их следствием — об этом
  // говорит примечание в итоге.
  results.push({ title: 'worker db', ...suite('@technic/worker', 'worker db') });
} finally {
  say();
  dropOnce();
  rmSync(reportDir, { recursive: true, force: true });
}

say();
say('══ итог pnpm check:db ════════════════════════════════════════════════════');
for (const result of results) {
  say(`  ${result.ok ? 'ок     ' : 'ПАДЕНИЕ'} ${result.title.padEnd(12)} — ${result.note}`);
}

if (results.some((result) => !result.ok)) {
  if (!results[0].ok) {
    say();
    say('api покраснел: если он не дошёл до наката миграций, красное у воркера — его следствие.');
  }
  say('ворота НЕ пройдены; отметка о зелёном прогоне не записана.');
  process.exit(1);
}

if (partial) {
  if (results.every((result) => result.files === 0)) {
    say(`фильтр «${filters.join(' ')}» не нашёл ни одного файла — прогонять было нечего.`);
    process.exit(1);
  }
  say('точечный прогон зелёный. Отметка не записана: прошла часть набора, а отметка — про весь.');
  process.exit(0);
}

say('db-набор зелёный.');
reportStamp('check:db', writeStamp('check:db'));
