/**
 * Рабочий каталог прогона: почтовый ящик между системой и агентом.
 *
 * Всё, что здесь лежит, — ПРОИЗВОДНОЕ: факты, задания, ответы, находки, отчёты, контрольные
 * точки. В историю оно не идёт, и это не вопрос аккуратности: закоммиченный снимок прогона
 * начинает выглядеть источником истины о проекте, хотя описывает одно рабочее дерево в одну
 * минуту.
 *
 * Раскладка нарочно плоская и предсказуемая: человек открывает `task.md` руками и отдаёт его
 * агенту в IDE, а ответ кладёт в `results/`. Пока адаптер ручной, каталог — это и есть протокол.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface Workspace {
  readonly home: string;
  readonly context: string;
  readonly results: string;
  readonly reports: string;
  readonly tmp: string;
  /** Состояние текущей партии: что разрешено править и от чего откатываться. */
  readonly state: string;
  /** Контрольные точки: копии файлов партии до правки. */
  readonly checkpoints: string;
  readonly taskFile: string;
}

export function workspaceOf(runtimeDir: string): Workspace {
  return {
    home: runtimeDir,
    context: path.join(runtimeDir, 'context'),
    results: path.join(runtimeDir, 'results'),
    reports: path.join(runtimeDir, 'reports'),
    tmp: path.join(runtimeDir, 'tmp'),
    state: path.join(runtimeDir, 'state'),
    checkpoints: path.join(runtimeDir, 'checkpoints'),
    taskFile: path.join(runtimeDir, 'task.md'),
  };
}

export function ensureWorkspace(runtimeDir: string): Workspace {
  const workspace = workspaceOf(runtimeDir);
  for (const dir of [
    workspace.home,
    workspace.context,
    workspace.results,
    workspace.reports,
    workspace.tmp,
    workspace.state,
    workspace.checkpoints,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return workspace;
}

/**
 * Проверка, что рабочий каталог действительно вне истории.
 *
 * Спрашивается сам git, а не текст `.gitignore`: правило может прийти из глобального файла, из
 * `.git/info/exclude` или из строки с отрицанием, и разбор текста ответил бы уверенно и неверно.
 * Ошибиться здесь дорого — незамеченный `git add -A` унесёт в публичный репозиторий содержимое
 * прогонов.
 */
export function isIgnoredByGit(root: string, target: string): boolean {
  const probe = path.join(target, '.probe');
  const result = spawnSync('git', ['check-ignore', '-q', probe], { cwd: root });
  return result.status === 0;
}
