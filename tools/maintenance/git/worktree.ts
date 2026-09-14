/**
 * Изолированное рабочее дерево под прогон ворот качества.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ЕСТЬ. Ворота (`pnpm check`) судят всё дерево целиком, а дерево здесь общее:
 * рядом всегда лежит чужая незавершённая работа. Красная чужая правка откатывала верную правку
 * системы — так было на трёх живых прогонах подряд. Поэтому ворота гоняются не там, где работает
 * человек, а в отдельном дереве git, собранном из `HEAD` плюс файлы партии: всё, чего партия не
 * называла, там ровно такое, каким его видит коммит.
 *
 * ПОЧЕМУ ЗАВИСИМОСТИ ПОДКЛАДЫВАЮТСЯ ССЫЛКАМИ, А НЕ СТАВЯТСЯ ЗАНОВО. `pnpm install` на этом
 * репозитории — минуты и гигабайты на каждую партию; система, которая столько стоит, не будет
 * запущена ни разу. Ссылка бесплатна.
 *
 * ПОЧЕМУ ПРОСТОЙ symlink НА `node_modules` НЕ ГОДИТСЯ — это проверено экспериментом, и без этого
 * знания весь замысел разваливается молча. В pnpm свои же пакеты лежат в `node_modules`
 * ОТНОСИТЕЛЬНЫМИ ссылками: `apps/web/node_modules/@technic/contracts -> ../../../../packages/contracts`.
 * Если `apps/web/node_modules` — ссылка на основное дерево, то относительный путь считается от её
 * настоящего места, и `@technic/contracts` разрешается в ИСХОДНИКИ ОСНОВНОГО ДЕРЕВА, со всей чужой
 * незакоммиченной работой. На этом самом репозитории `pnpm -r typecheck` в изолированном дереве
 * так и упал: `labels.ts` взят из `HEAD`, а контракты — из грязного основного дерева, и типы не
 * сошлись. То есть изоляция была бы бумажной.
 *
 * Поэтому каталоги зависимостей не подставляются целиком, а ЗЕРКАЛЯТСЯ: сам каталог создаётся
 * настоящим, его содержимое — ссылки на основное дерево, и только ссылки на пакеты репозитория
 * перенаправляются внутрь изолированного дерева. Зеркалятся лишь «каталоги-указатели»
 * (`@scope`, `node_modules`, `.pnpm`) — там и только там живут ссылки на свои пакеты; сами пакеты
 * зависимостей подставляются одной ссылкой и не обходятся.
 */
import path from 'node:path';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizePath } from '../core/paths.ts';
import { run } from '../analyzers/run.ts';

/** Готовое изолированное дерево. Владелец обязан вызвать `dispose` — иначе каталог останется. */
export interface IsolatedTree {
  /** Абсолютный путь: отсюда запускаются ворота. */
  readonly path: string;
  /** Sha, от которого дерево собрано. Нужен в отчёте: иначе непонятно, что именно проверяли. */
  readonly base: string;
  /** Убрать дерево за собой. Повторный вызов безопасен. */
  dispose(): void;
}

export interface IsolateOptions {
  /** Корень основного репозитория. */
  readonly root: string;
  /** Каталог, где создавать дерево (внутри `.maintenance`, он не версионируется). */
  readonly home: string;
  /** Файлы партии: копируются поверх базы. Удалённый в партии файл удаляется и здесь. */
  readonly files: readonly string[];
  /** Каталоги (или файлы), которые надо подложить из основного дерева: `node_modules` и подобное. */
  readonly linkPaths: readonly string[];
  /** База дерева, по умолчанию `HEAD`. */
  readonly baseRef?: string;
}

/**
 * Глубина обхода каталогов-указателей. Четырёх хватает на самый длинный путь до своей ссылки в
 * pnpm: `node_modules/.pnpm/node_modules/@scope/pkg`. Ограничение здесь не ради скорости, а чтобы
 * случайная петля ссылок не увела обход в бесконечность.
 */
const MIRROR_DEPTH = 4;

/**
 * Собрать изолированное дерево.
 *
 * Основное дерево при этом не трогается НИ В ЧЁМ: ни `add`, ни `stash`, ни `checkout`. Git пишет
 * только служебную запись о новом дереве и сам новый каталог.
 */
export function createIsolatedTree(options: IsolateOptions): IsolatedTree {
  const root = path.resolve(options.root);
  const baseRef = options.baseRef ?? 'HEAD';
  const base = resolveBase(root, baseRef);

  // Чистка ДО создания: упавший прогон оставляет запись о дереве, каталога которого уже нет, и
  // такая запись мешает занять то же имя снова. Сама по себе она безвредна, но копится.
  run(root, ['git', 'worktree', 'prune']);

  mkdirSync(options.home, { recursive: true });
  const treePath = path.join(options.home, uniqueName());

  // `--detach`: дерево не занимает ветку. Иначе параллельные прогоны и человек, работающий в
  // основном дереве, дрались бы за одну и ту же ветку.
  const added = run(root, ['git', 'worktree', 'add', '--detach', treePath, base]);
  if (added.code !== 0) {
    throw new Error(
      `не удалось создать изолированное дерево: ${added.stderr.trim() || added.stdout.trim()}`,
    );
  }

  try {
    applyBatch(root, treePath, options.files);
    for (const relative of options.linkPaths) supply(root, treePath, relative);
  } catch (error) {
    // Полудерево хуже отсутствия дерева: ворота в нём соврут. Убираем и отдаём ошибку наверх.
    removeTree(root, treePath);
    throw error;
  }

  let disposed = false;
  return {
    path: treePath,
    base,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeTree(root, treePath);
    },
  };
}

function resolveBase(root: string, ref: string): string {
  const result = run(root, ['git', 'rev-parse', ref]);
  if (result.code !== 0) throw new Error(`нет такой базы для изолированного дерева: ${ref}`);
  return result.stdout.trim();
}

/**
 * Имя каталога уникально, потому что деревьев может быть несколько сразу: соседний прогон системы
 * или человек, запустивший проверку руками. Совпадение имён — это чужое дерево, снесённое чужим
 * `dispose`.
 */
function uniqueName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = createHash('sha256')
    .update(`${process.pid}-${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `tree-${stamp}-${suffix}`;
}

/**
 * Наложение партии поверх базы.
 *
 * Три случая, и все три обязаны воспроизводиться: файл изменён, файл создан правкой (в базе его
 * нет), файл правкой удалён (в основном дереве его уже нет). Пропусти последний — и ворота будут
 * судить код, который партия как раз и убрала.
 */
function applyBatch(root: string, treePath: string, files: readonly string[]): void {
  for (const raw of files) {
    const relative = normalizePath(root, raw);
    const source = path.join(root, relative);
    const target = path.join(treePath, relative);
    if (existsSync(source)) {
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    } else {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

/** Подложить путь основного дерева. Каталог зеркалится, одиночный файл — просто ссылка. */
function supply(root: string, treePath: string, relative: string): void {
  const clean = normalizePath(root, relative);
  const source = path.join(root, clean);
  // Молчаливый пропуск намеренный: список подкладываемого общий для всех репозиториев, а
  // `apps/worker/node_modules` существует не в каждом.
  if (!existsSync(source)) return;
  const target = path.join(treePath, clean);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  if (statSync(source).isDirectory()) mirror(root, treePath, source, target, 0);
  else symlinkSync(source, target);
}

/**
 * Зеркало каталога зависимостей: сам каталог настоящий, содержимое — ссылки.
 *
 * Ссылки на пакеты самого репозитория перенаправляются внутрь изолированного дерева — ради этого
 * всё и затевалось (см. заголовок файла). Ссылка на что угодно внутри `node_modules` остаётся как
 * есть: это чужой код, он одинаков в обоих деревьях.
 */
function mirror(
  root: string,
  treePath: string,
  source: string,
  target: string,
  depth: number,
): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      symlinkSync(redirect(root, treePath, from), to);
      continue;
    }
    if (entry.isDirectory() && depth < MIRROR_DEPTH && isPointerDir(entry.name)) {
      mirror(root, treePath, from, to, depth + 1);
      continue;
    }
    symlinkSync(from, to);
  }
}

/**
 * Каталог-указатель — тот, внутри которого лежат ссылки на пакеты, а не сам пакет: `@scope`,
 * вложенный `node_modules`, служебный `.pnpm`. Всё остальное — тело зависимости, и обходить его
 * незачем: там тысячи файлов и ни одной ссылки на наши исходники.
 */
function isPointerDir(name: string): boolean {
  return name.startsWith('@') || name === 'node_modules' || name === '.pnpm';
}

/** Куда должна указывать ссылка в изолированном дереве. */
function redirect(root: string, treePath: string, link: string): string {
  let real: string;
  try {
    real = realpathSync(link);
  } catch {
    // Битая ссылка бывает у частично установленных зависимостей. Повторяем её как есть: чинить
    // чужую установку — не дело проверки.
    return link;
  }
  const relative = normalizePath(root, real);
  const outsideRepo = relative.startsWith('..');
  const insideModules = /(^|\/)node_modules(\/|$)/.test(relative);
  // Свой пакет репозитория: только он и должен браться из изолированного дерева.
  if (!outsideRepo && !insideModules) return path.join(treePath, relative);
  return real;
}

/**
 * Снос дерева.
 *
 * Сначала штатный `git worktree remove --force` — он снимает и запись git, и каталог. Он честно
 * отказывается, если каталога уже нет или если в нём осталось лишнее; тогда каталог убирается
 * руками, а запись снимает `prune`. Оставленная запись потом мешает создавать деревья, а
 * оставленный каталог — это гигабайты.
 */
function removeTree(root: string, treePath: string): void {
  const removed = run(root, ['git', 'worktree', 'remove', '--force', treePath]);
  if (removed.code !== 0 || existsSync(treePath)) {
    // Ссылки удаляются как ссылки: `rmSync` не ходит по ним внутрь, поэтому основное дерево и его
    // `node_modules` в безопасности.
    rmSync(treePath, { recursive: true, force: true });
    run(root, ['git', 'worktree', 'prune']);
  }
}
