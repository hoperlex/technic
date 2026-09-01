/**
 * Отметка о зелёном прогоне ворот качества — общая часть `pnpm check` и `pnpm check:db`.
 *
 * ЗАЧЕМ ОНА ЕСТЬ. Ворота запускает человек (ADR 0147, решение Р1): git-хука нет намеренно —
 * рабочее дерево общее, и автоматика в нём вмешивалась бы в чужую работу. Но у выката, который
 * несёт миграцию или идёт окном `--cutover`, отката уже нет, и «я вроде прогонял» там не ответ.
 * Отметка переводит это «вроде» в проверяемый факт: какой коммит, когда, какими наборами.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ. Она ничего не запрещает разработчику и никого не подгоняет: её читает
 * только `deploy/deploy-auto.sh`, и только на выкатах без отката. Обычный кодовый выкат её не
 * спрашивает — ждать полного прогона там дороже, чем откатиться.
 *
 * ПОЧЕМУ ФАЙЛ ВНЕ GIT. Отметка описывает состояние конкретного рабочего дерева («здесь только что
 * всё прошло»), а не историю. В git она стала бы вечно конфликтующим файлом, который к тому же
 * пришлось бы коммитить ПОСЛЕ прогона — то есть менять тот самый SHA, про который отметка и
 * говорит. Цена: на машину выката отметку переносят руками (см. ADR 0147, «Цена и границы»).
 *
 * ПОЧЕМУ ГРЯЗНОЕ ДЕРЕВО ОТМЕТКИ НЕ ПОЛУЧАЕТ. Единственное, чем отметка привязана к коду, — SHA
 * коммита. На дереве с несохранёнными правками прогонялось не то, что этим SHA описывается, и
 * отметка утверждала бы неправду. Поэтому запись не делается вовсе, а причина печатается вслух:
 * молчаливый пропуск читался бы как «записали».
 *
 * ФОРМАТ (те же `ключ=значение`, что у состояний деплоя, — их читает bash грепом):
 *
 *   sha=<полный SHA коммита>
 *   check=<время прогона быстрого набора, UTC ISO-8601>
 *   check:db=<время прогона db-набора>
 *
 * Время у каждого набора своё: наборы прогоняются порознь и протухают порознь (срок — 24 часа).
 */
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

/** Корень монорепо: каталог скриптов лежит ровно в нём, и на cwd опираться не нужно. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const STAMP_PATH = join(ROOT, '.quality-check');

/** Наборы, которые умеет отмечать эта механика. Имена совпадают с именами команд — не случайно:
 *  в отметке, в выводе скриптов и в сообщении деплоя человек читает одно и то же слово. */
export const SETS = ['check', 'check:db'];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Состояние дерева: коммит и чистота. `null` — git недоступен или это не репозиторий (архив,
 * распакованный без `.git`): тогда отметка не пишется, но и прогон из-за этого не падает.
 */
export function treeState() {
  try {
    return {
      sha: git(['rev-parse', 'HEAD']).trim(),
      dirty: git(['status', '--porcelain']).trim().length > 0,
    };
  } catch {
    return null;
  }
}

/** Читает отметку в объект `ключ → значение`. Комментарии и мусорные строки пропускаются. */
export function readStamp() {
  let text;
  try {
    text = readFileSync(STAMP_PATH, 'utf8');
  } catch {
    return null;
  }
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

/**
 * Отмечает набор `set` как прошедший. Возвращает `{ written, reason, sets }` — писать в консоль
 * вызывающий будет сам, своими словами.
 *
 * Отметка ДРУГОГО коммита не дополняется, а заменяется целиком: зелёный `check` на вчерашнем
 * коммите ничего не говорит про сегодняшний, и оставить его рядом со свежим `check:db` значило бы
 * собрать разрешение на выкат из двух половин, которые никогда не сходились вместе.
 */
export function writeStamp(set) {
  if (!SETS.includes(set)) throw new Error(`неизвестный набор «${set}»`);

  const tree = treeState();
  if (!tree) return { written: false, reason: 'no-git' };
  if (tree.dirty) return { written: false, reason: 'dirty' };

  const previous = readStamp();
  const kept = previous && previous.sha === tree.sha ? previous : {};
  const stamped = { ...kept, sha: tree.sha, [set]: new Date().toISOString() };

  const lines = [
    '# Отметка о зелёном прогоне ворот качества — docs/adr/0147-quality-gates.md.',
    '# Пишется командами `pnpm check` и `pnpm check:db`, читается deploy-auto на выкатах без',
    '# отката. В git файла нет: он про это рабочее дерево, а не про историю. Правка руками',
    '# бессмысленна — она подделывает единственное, ради чего файл заведён.',
    `sha=${stamped.sha}`,
    ...SETS.filter((name) => stamped[name]).map((name) => `${name}=${stamped[name]}`),
    '',
  ];

  // Запись через временный файл рядом: деплой читает отметку целиком, и половина файла (обрыв,
  // полный диск) прочиталась бы как «набор не проходил» — то есть тем же, чем и отсутствие файла.
  const tmp = `${STAMP_PATH}.tmp`;
  try {
    writeFileSync(tmp, lines.join('\n'));
    renameSync(tmp, STAMP_PATH);
  } catch (error) {
    rmSync(tmp, { force: true });
    return { written: false, reason: 'io', error: String(error) };
  }

  return {
    written: true,
    sha: tree.sha,
    sets: SETS.filter((name) => stamped[name]),
  };
}

/** Печатает итог отметки одинаково у обеих команд: разный текст здесь только путал бы. */
export function reportStamp(set, result) {
  const say = (text) => process.stdout.write(`${text}\n`);
  if (result.written) {
    say(`отметка ${STAMP_PATH}: ${result.sha.slice(0, 12)}, наборы — ${result.sets.join(', ')}`);
    return;
  }
  if (result.reason === 'dirty') {
    say(`отметка НЕ записана: рабочее дерево грязное, и SHA не описывает того, что прогналось.`);
    say(
      `  Выкатам без отката (миграция или --cutover) эта отметка нужна — закоммитьте и повторите`,
    );
    say(
      `  ${set === 'check:db' ? 'pnpm check:db' : 'pnpm check'}. Обычному кодовому выкату она не нужна вовсе.`,
    );
    return;
  }
  if (result.reason === 'no-git') {
    say('отметка НЕ записана: git недоступен, привязать прогон к коммиту нечем.');
    return;
  }
  say(`отметка НЕ записана: ${result.error}`);
}
