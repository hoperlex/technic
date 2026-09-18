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
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Каталоги рабочих деревьев: их убирает git, а не уборка каталога. */
const TREE_HOMES = new Set(['trees', 'workshop']);

/** Через сколько часов брошенное считается мусором: партия живёт минуты, прогон — часы. */
const LITTER_MAX_AGE_HOURS = 24;

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
  sweep(workspace);
  return workspace;
}

/**
 * Убрать за брошенными прогонами.
 *
 * ПОЧЕМУ ЭТО ОБЯЗАННОСТЬ СИСТЕМЫ, А НЕ ЧЕЛОВЕКА. Каталог производный, в историю не идёт, и потому
 * его никто не смотрит — а он растёт: машинные отчёты линта по этому репозиторию весят по
 * восемнадцать мегабайт штука, и к 18.09.2026 их накопилось пять. Контрольные точки живут по той
 * же причине: партия, ушедшая человеку, свою точку не снимает — и правильно делает, откат ещё
 * может понадобиться, — но через сутки решать по ней уже нечего.
 *
 * Что younger суток, не трогается вовсе, а точка открытой партии — тем более: её номер лежит в
 * `state/batch.json`, и он спрашивается до всякой уборки.
 */
function sweep(workspace: Workspace): void {
  const active = activeCheckpoint(workspace);
  const cutoff = Date.now() - LITTER_MAX_AGE_HOURS * 60 * 60 * 1000;

  /*
   * В `tmp` убирается всё, кроме двух каталогов, где живут рабочие деревья git: снос такого
   * каталога мимо `git worktree` оставил бы запись о дереве, которого нет. Деревья убирает тот,
   * кто их создал, — у него для этого есть команда git, а не `rm`.
   */
  dropOlder(workspace.tmp, cutoff, (name) => !TREE_HOMES.has(name));
  dropOlder(workspace.checkpoints, cutoff, (name) => name !== active);
}

/** Номер точки открытой партии. `null` — открытой партии нет. */
function activeCheckpoint(workspace: Workspace): string | null {
  try {
    const batch = JSON.parse(
      readFileSync(path.join(workspace.state, 'batch.json'), 'utf8'),
    ) as unknown as { checkpoint?: unknown };
    return typeof batch.checkpoint === 'string' ? batch.checkpoint : null;
  } catch {
    return null;
  }
}

function dropOlder(dir: string, cutoff: number, allowed: (name: string) => boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!allowed(entry)) continue;
    const full = path.join(dir, entry);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* чужой процесс мог убрать это прямо сейчас — не наше дело */
    }
  }
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
