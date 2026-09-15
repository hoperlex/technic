/**
 * Состояние дерева.
 *
 * РАЗБОР ИДЁТ ЧЕРЕЗ `--porcelain -z`. Это не стилевая мелочь: обычный `--porcelain` кавычит
 * неанглийские имена (`"docs/\320\272..."`), и любой фильтр по кавычкам молча теряет кириллицу.
 * Нулевой разделитель снимает вопрос целиком — имена приходят как есть.
 */
import type { GitFacts } from '../core/facts.ts';
import { run } from './run.ts';

const STATUS_LENGTH = 2;

export function collectGit(root: string): GitFacts {
  const head = run(root, ['git', 'rev-parse', 'HEAD']).stdout.trim();
  const branch = run(root, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const status = run(root, ['git', 'status', '--porcelain', '-z']);

  const changed: string[] = [];
  const untracked: string[] = [];
  for (const entry of status.stdout.split('\0')) {
    if (entry.length <= STATUS_LENGTH + 1) continue;
    const code = entry.slice(0, STATUS_LENGTH);
    const file = entry.slice(STATUS_LENGTH + 1);
    if (code === '??') untracked.push(file);
    else changed.push(file);
  }

  return {
    head,
    branch,
    // Чистым считается дерево без изменений отслеживаемых файлов. Неотслеживаемые чистоте не
    // мешают: они не попадут ни в контрольную точку, ни в откат, и требовать их удаления значило
    // бы требовать убрать чужие черновики ради своего прогона.
    clean: changed.length === 0,
    changedFiles: changed.sort(),
    untrackedFiles: untracked.sort(),
  };
}

/**
 * Файлы, затронутые работой относительно базы.
 *
 * Возвращается объединение коммитов ветки и рабочего дерева: система обязана видеть и то, что уже
 * записано, и то, что лежит рядом незакоммиченным. Не разрешившаяся база — `null`, и вызывающий
 * обязан остановиться: молчаливый переход на всё дерево опаснее отказа.
 */
export function changedSince(root: string, baseRef: string): string[] | null {
  const diff = run(root, ['git', 'diff', '--name-only', '-z', `${baseRef}...HEAD`]);
  /*
   * Отказ git возвращается как `null`, а не как пустой список, и это не педантизм типов. Пустой
   * список ниже по течению означает ПОЛНЫЙ ОБЗОР — так его читает `widenScope` для тяжёлого окна.
   * Значит опечатка в `--since` или недоступная база молча превращалась бы в задание агенту по
   * всему репозиторию: ровно то, чего область работы и должна не допускать.
   */
  if (diff.code !== 0) return null;
  const worktree = run(root, ['git', 'diff', '--name-only', '-z', 'HEAD']);
  const files = new Set<string>();
  for (const source of [diff.stdout, worktree.stdout]) {
    for (const file of source.split('\0')) {
      if (file.trim() !== '') files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Файлы, изменённые начиная с указанного момента.
 *
 * Нужны журналу находок: решение человека («это осознанный долг») действует ровно до тех пор, пока
 * код вокруг находки не изменился. Спрашивается git, а не время правки файла на диске: время
 * сбрасывается любой выгрузкой дерева, а история — нет.
 *
 * В ответ идут и коммиты, и рабочее дерево: незакоммиченная правка — такая же смена обстоятельств,
 * и ждать коммита, чтобы переоткрыть находку, значило бы спрашивать про заведомо устаревшее.
 */
export function filesChangedSince(root: string, since: string): string[] {
  const files = new Set<string>();
  /*
   * `core.quotepath=false` обязателен: иначе `git log --name-only` кавычит неанглийские имена
   * (`"docs/\320\230..."`), и такой путь не совпадёт ни с одним нормализованным. Промах молчалив —
   * решение журнала продолжало бы действовать на изменившемся коде. В истории этого репозитория
   * таких имён 36 штук, так что случай не гипотетический.
   */
  const log = run(root, [
    'git',
    '-c',
    'core.quotepath=false',
    'log',
    `--since=${since}`,
    '--name-only',
    '--pretty=format:',
  ]);
  if (log.code === 0) {
    for (const line of log.stdout.split('\n')) {
      const file = line.trim();
      if (file !== '') files.add(file);
    }
  }
  for (const file of run(root, ['git', 'diff', '--name-only', '-z', 'HEAD']).stdout.split('\0')) {
    if (file.trim() !== '') files.add(file);
  }
  return [...files].sort();
}

/** Когда файл менялся в истории последний раз. `null` — файла в истории нет. */
export function lastChangeOf(root: string, file: string): string | null {
  const result = run(root, ['git', 'log', '-1', '--format=%cI', '--', file]);
  const value = result.stdout.trim();
  return result.code === 0 && value !== '' ? value : null;
}

/**
 * Как часто файлы менялись за последние дни.
 *
 * Нужно очереди долга: долг в живом коде дороже долга в спящем. Файл, который правят каждую
 * неделю, будет прочитан ещё много раз, и беспорядок в нём стоит дорого; файл, не менявшийся
 * полгода, работает — и трогать его без нужды рискованнее, чем оставить.
 *
 * Считается по истории, а не по датам файлов: дата правки сбрасывается любой выгрузкой дерева и
 * ничего не говорит о том, сколько раз файл переписывали.
 */
export function fileHotness(root: string, days: number): Map<string, number> {
  // Кавычки отключены по той же причине, что и в `filesChangedSince`: закавыченное имя не совпадёт
  // с путём находки, и горячий файл будет посчитан спящим.
  const result = run(root, [
    'git',
    '-c',
    'core.quotepath=false',
    'log',
    `--since=${days} days ago`,
    '--name-only',
    '--pretty=format:',
  ]);
  const counts = new Map<string, number>();
  if (result.code !== 0) return counts;
  for (const line of result.stdout.split('\n')) {
    const file = line.trim();
    if (file === '') continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}
