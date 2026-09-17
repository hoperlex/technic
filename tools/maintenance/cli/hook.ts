/**
 * Очередь коммитов и хук, который её пополняет.
 *
 * ЗАЧЕМ. Прогон, который зовут руками, случается тогда, когда о нём вспомнили, — то есть редко и
 * не там, где нужно. А работа в этом дереве идёт непрерывно и оформляется коммитами: коммит — это
 * единственный момент, когда автор сам объявил кусок работы законченным. Лучшего повода посмотреть
 * на код не будет.
 *
 * ПОЧЕМУ ХУК ТОЛЬКО КЛАДЁТ В ОЧЕРЕДЬ. Соблазн запустить прогон прямо из хука велик и обманчив:
 * коммитов в этом дереве несколько в час, из разных сессий сразу, и каждый поднимал бы свой прогон
 * с агентом на пятнадцать минут. Очередь снимает вопрос: коммиты копятся, а разбирает их один
 * прогон, когда дойдёт очередь. Самозапуск возможен, но включается отдельно и упирается в замок.
 *
 * ПОЧЕМУ ЗАМОК ОБЯЗАТЕЛЕН. Состояние прогона — один файл. Два прогона сразу писали бы в него по
 * очереди, и второй продолжил бы чужой проход как свой: партия одного была бы проверена бюджетом
 * другого. Замок держит пропуск ровно у одного.
 */
import path from 'node:path';
import process from 'node:process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { run } from '../analyzers/run.ts';
import type { Reporter } from '../core/contracts.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import type { CommandResult } from './commands.ts';

/** Метка в сообщении коммита самой системы: по ней хук узнаёт свою же работу и молчит. */
export const OWN_COMMIT_MARK = 'refactor(maintain)';

/** Сколько минут замок считается живым, если процесс исчез, не убрав его за собой. */
const LOCK_STALE_MINUTES = 90;

function queueFile(workspace: Workspace): string {
  return path.join(workspace.state, 'commit-queue');
}

function lockFile(workspace: Workspace): string {
  return path.join(workspace.state, 'run.lock');
}

/** Положить коммит в очередь. Зовётся хуком, а не системой. */
export function enqueueCommit(workspace: Workspace, sha: string): void {
  mkdirSync(workspace.state, { recursive: true });
  appendFileSync(queueFile(workspace), `${sha}\n`, 'utf8');
}

/** Что накопилось. Порядок сохраняется: старое разбирается первым. */
export function queuedCommits(workspace: Workspace): string[] {
  try {
    return readFileSync(queueFile(workspace), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

/**
 * Забрать очередь себе.
 *
 * Очередь очищается СРАЗУ, а не после разбора: пока прогон идёт, в неё капают новые коммиты, и
 * чистка по завершении стёрла бы то, чего прогон не видел.
 */
export function takeQueue(workspace: Workspace): string[] {
  const commits = queuedCommits(workspace);
  rmSync(queueFile(workspace), { force: true });
  return commits;
}

export interface Lock {
  release(): void;
}

/**
 * Взять замок прогона. `null` — занят, и вызывающий обязан уйти, а не ждать.
 *
 * Ожидание здесь было бы хуже отказа: команду зовёт человек или хук, и висеть полчаса в надежде на
 * чужой прогон незачем — очередь никуда не денется.
 */
export function takeLock(workspace: Workspace): Lock | null {
  mkdirSync(workspace.state, { recursive: true });
  const file = lockFile(workspace);
  const holder = readLock(file);
  if (holder !== null && alive(holder.pid) && fresh(holder.at)) return null;

  writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
  return {
    release(): void {
      // Снимаем только СВОЙ замок: чужой мог появиться, если наш признали протухшим.
      const current = readLock(file);
      if (current?.pid === process.pid) rmSync(file, { force: true });
    },
  };
}

/** Кто держит замок сейчас. Печатается человеку: «занято» без имени занявшего бесполезно. */
export function lockHolder(workspace: Workspace): { pid: number; at: string } | null {
  return readLock(lockFile(workspace));
}

function readLock(file: string): { pid: number; at: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'string') return null;
    return { pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    // Нулевой сигнал ничего не делает процессу, но отвечает на вопрос «он есть?».
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fresh(at: string): boolean {
  const started = Date.parse(at);
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < LOCK_STALE_MINUTES * 60_000;
}

/**
 * Текст хука.
 *
 * Корень вписывается абсолютным: хук срабатывает и в отдельных деревьях (у git они делят каталог
 * хуков), а рабочий каталог системы живёт ровно в одном месте.
 *
 * Своя работа пропускается по метке в сообщении: без этого коммит системы поднимал бы следующий
 * прогон, тот — свой коммит, и цикл не кончился бы никогда.
 */
function hookText(root: string, auto: boolean): string {
  const start = auto
    ? `(cd ${root} && nohup pnpm maintain converge >/dev/null 2>&1 &)\n`
    : '# самозапуск выключен: очередь разберёт следующий `pnpm maintain converge`\n';
  return [
    '#!/bin/sh',
    '# Ставится командой `pnpm maintain hook --install`. Кладёт коммит в очередь обслуживания.',
    'test -n "$MAINTAIN_NO_HOOK" && exit 0',
    `git log -1 --pretty=%s | grep -q '${OWN_COMMIT_MARK}' && exit 0`,
    `mkdir -p ${root}/.maintenance/state`,
    `git rev-parse HEAD >> ${root}/.maintenance/state/commit-queue`,
    start,
    'exit 0',
    '',
  ].join('\n');
}

export function hookPath(root: string): string {
  const dir = run(root, ['git', 'rev-parse', '--git-common-dir']).stdout.trim();
  const base = path.isAbsolute(dir) ? dir : path.join(root, dir);
  return path.join(base, 'hooks', 'post-commit');
}

export function installHook(root: string, auto: boolean): string {
  const file = hookPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, hookText(root, auto), 'utf8');
  chmodSync(file, 0o755);
  return file;
}

/** Команда `maintain hook`: поставить, снять или рассказать, как сейчас. */
export function hook(
  config: { readonly root: string; readonly runtimeDir: string },
  out: Reporter,
  args: { readonly install: boolean; readonly remove: boolean; readonly auto: boolean },
): CommandResult {
  const workspace = ensureWorkspace(config.runtimeDir);
  if (args.install) {
    const file = installHook(config.root, args.auto);
    out.item(`хук поставлен: ${path.relative(config.root, file)}`);
    out.item(
      args.auto
        ? 'каждый коммит заводит прогон сам; одновременных прогонов не будет — их держит замок'
        : 'коммиты копятся в очереди; разбирает их следующий pnpm maintain converge',
    );
    return { ok: true };
  }
  if (args.remove) {
    const file = removeHook(config.root);
    out.item(file === null ? 'хука и не было' : `хук снят: ${path.relative(config.root, file)}`);
    return { ok: true };
  }

  const file = hookPath(config.root);
  out.item(
    existsSync(file) ? `хук стоит: ${file}` : 'хука нет: поставить — maintain hook --install',
  );
  const queue = queuedCommits(workspace);
  out.item(queue.length === 0 ? 'очередь пуста' : `в очереди коммитов: ${queue.length}`);
  for (const sha of queue.slice(0, 10)) out.item(`  ${sha.slice(0, 8)}`);
  const holder = lockHolder(workspace);
  if (holder !== null) out.item(`прогон занят процессом ${holder.pid} с ${holder.at}`);
  return { ok: true };
}

export function removeHook(root: string): string | null {
  const file = hookPath(root);
  if (!existsSync(file)) return null;
  rmSync(file, { force: true });
  return file;
}
