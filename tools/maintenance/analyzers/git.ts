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
 * записано, и то, что лежит рядом незакоммиченным. Не разрешившаяся база — пустой ответ, а не
 * молчаливый переход на всё дерево: ложное сужение области опаснее её отсутствия.
 */
export function changedSince(root: string, baseRef: string): string[] {
  const diff = run(root, ['git', 'diff', '--name-only', '-z', `${baseRef}...HEAD`]);
  if (diff.code !== 0) return [];
  const worktree = run(root, ['git', 'diff', '--name-only', '-z', 'HEAD']);
  const files = new Set<string>();
  for (const source of [diff.stdout, worktree.stdout]) {
    for (const file of source.split('\0')) {
      if (file.trim() !== '') files.add(file);
    }
  }
  return [...files].sort();
}
