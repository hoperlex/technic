/**
 * Передача принятой партии из цеха в историю.
 *
 * ЗАЧЕМ ЭТО СУЩЕСТВУЕТ. В цехе (`openWorkshop`) правка сделана и проверена, но лежит она в
 * отдельном каталоге, который живёт до конца прогона. Оставить её там — значит выбросить: каталог
 * снесут, и работа исчезнет. Перенести файлами в рабочее дерево тоже нельзя — там непрерывно
 * правят другие, и наш файл затёр бы чужую строку.
 *
 * Поэтому принятая партия уходит КОММИТОМ. Коммит трогает ровно файлы партии, не зависит от
 * состояния чужой работы и оставляет след, который видно в истории, а не только в отчёте системы.
 *
 * ТРИ ОПАСНОСТИ, И КАЖДАЯ ЗДЕСЬ ЗАКРЫТА ЯВНО.
 *
 * Первая — ветка ушла вперёд, пока мы работали. Двадцать минут в общем репозитории — это один-два
 * чужих коммита. Ссылка переставляется сравнением с ожидаемым значением (`update-ref` с третьим
 * аргументом): если вершина уже не та, git откажет, а не затрёт чужую работу. После отказа наш
 * коммит переносится на новую вершину и попытка повторяется ровно один раз.
 *
 * Вторая — потерянный коммит. Пока ссылка ветки на него не указывает, он висит ни на чём, и сборщик
 * мусора вправе его снести. Поэтому на него СРАЗУ ставится служебная ссылка, и снимается она
 * только после успешной передачи.
 *
 * Третья — рабочее дерево после переноса ветки. Сдвинув ветку, мы делаем файлы рабочего дерева
 * «отставшими»: их содержимое — старое, и git покажет их как правку наоборот. Поэтому те файлы
 * партии, которых в рабочем дереве никто не трогал, подтягиваются к новой вершине, а тронутые —
 * не трогаются и называются человеку: это чужая работа, и решать по ней не нам.
 */
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { run } from '../analyzers/run.ts';

export interface HandoffOptions {
  /** Репозиторий, где живёт ветка. */
  readonly root: string;
  /** Цех: дерево, в котором лежит принятая правка. */
  readonly tree: string;
  /** Вершина, от которой цех собран: с ней сравнивается ссылка ветки. */
  readonly base: string;
  /** Файлы партии. Коммитится только они — ничего, что агент тронул сверх, здесь не окажется. */
  readonly files: readonly string[];
  readonly message: string;
  /** Служебная ссылка, которая держит коммит, пока он не в ветке. */
  readonly keepRef: string;
}

export interface HandoffResult {
  /** Коммит; `null` — передать не удалось, причина в `problem`. */
  readonly sha: string | null;
  /** Ветка, в которую лёг коммит. */
  readonly branch: string | null;
  /** Файлы, подтянутые в рабочем дереве к новой вершине. */
  readonly synced: readonly string[];
  /** Файлы партии, которые в рабочем дереве заняты чужой работой: их не трогали. */
  readonly busy: readonly string[];
  readonly problem: string | null;
}

/** Передать принятую партию в историю. */
export function handOff(options: HandoffOptions): HandoffResult {
  const { root, tree, base } = options;
  const files = [...options.files];
  if (files.length === 0) {
    return { sha: null, branch: null, synced: [], busy: [], problem: 'партия пуста' };
  }

  /*
   * Кто отстанет после переноса ветки, считается ДО коммита.
   *
   * Сравнение идёт с базой цеха: файл, совпадающий с ней, в рабочем дереве никто не трогал — его
   * можно подтянуть без потерь. Считать это после сдвига ветки было бы поздно: там уже не отличить
   * «чужая правка» от «наша, ещё не подтянутая».
   */
  const safe = files.filter((file) => untouched(root, base, file));
  const busy = files.filter((file) => !safe.includes(file));

  const staged = run(tree, ['git', 'add', '--', ...files]);
  if (staged.code !== 0) {
    return { sha: null, branch: null, synced: [], busy, problem: `git add: ${why(staged)}` };
  }

  /*
   * `--no-verify` намеренно. Хуки коммита в этом репозитории гоняют свои проверки, а партия уже
   * прошла ворота системы — те же и строже, да ещё в изолированном дереве. Второй прогон стоил бы
   * минут на каждую партию и мог бы отказать по чужой красноте, к партии не относящейся.
   */
  const committed = run(tree, ['git', 'commit', '--no-verify', '-m', options.message]);
  if (committed.code !== 0) {
    return { sha: null, branch: null, synced: [], busy, problem: `git commit: ${why(committed)}` };
  }

  let sha = run(tree, ['git', 'rev-parse', 'HEAD']).stdout.trim();
  if (sha === '') {
    return { sha: null, branch: null, synced: [], busy, problem: 'коммит создан, но не опознан' };
  }
  run(root, ['git', 'update-ref', options.keepRef, sha]);

  const branch = run(root, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (branch === '' || branch === 'HEAD') {
    return {
      sha,
      branch: null,
      synced: [],
      busy,
      problem: `рабочее дерево не на ветке: коммит ${sha.slice(0, 8)} держит ссылка ${options.keepRef}`,
    };
  }
  const ref = `refs/heads/${branch}`;

  let moved = run(root, ['git', 'update-ref', ref, sha, base]);
  if (moved.code !== 0) {
    // Ветка ушла вперёд: переносим коммит на новую вершину и пробуем ещё раз — один раз, потому
    // что бесконечная гонка с пятью сессиями не выигрывается упорством.
    const head = run(root, ['git', 'rev-parse', ref]).stdout.trim();
    const rebased = run(tree, ['git', 'rebase', '--onto', head, base]);
    if (rebased.code !== 0) {
      run(tree, ['git', 'rebase', '--abort']);
      return {
        sha,
        branch,
        synced: [],
        busy,
        problem: `ветка ушла вперёд, а перенос не сошёлся: коммит ${sha.slice(0, 8)} держит ссылка ${options.keepRef}`,
      };
    }
    sha = run(tree, ['git', 'rev-parse', 'HEAD']).stdout.trim();
    run(root, ['git', 'update-ref', options.keepRef, sha]);
    moved = run(root, ['git', 'update-ref', ref, sha, head]);
    if (moved.code !== 0) {
      return {
        sha,
        branch,
        synced: [],
        busy,
        problem: `ветку занял кто-то ещё: коммит ${sha.slice(0, 8)} держит ссылка ${options.keepRef}`,
      };
    }
  }

  const synced = safe.filter((file) => pull(root, sha, file));
  // Ссылка сделала своё дело: коммит в ветке, держать его отдельно больше незачем.
  run(root, ['git', 'update-ref', '-d', options.keepRef]);
  return { sha, branch, synced, busy, problem: null };
}

/** Совпадает ли файл рабочего дерева с базой цеха. Несовпадение — чужая работа поверх. */
function untouched(root: string, base: string, file: string): boolean {
  return run(root, ['git', 'diff', '--quiet', base, '--', file]).code === 0;
}

/**
 * Подтянуть файл рабочего дерева к новой вершине.
 *
 * Удаление — отдельный случай: файла в коммите нет, и `checkout` по нему промахнётся. Тогда файл
 * убирается из индекса и с диска, и рабочее дерево снова совпадает с веткой.
 */
function pull(root: string, sha: string, file: string): boolean {
  const present = run(root, ['git', 'cat-file', '-e', `${sha}:${file}`]).code === 0;
  if (present) return run(root, ['git', 'checkout', sha, '--', file]).code === 0;
  const dropped = run(root, ['git', 'rm', '--quiet', '--cached', '--', file]);
  if (dropped.code !== 0) return false;
  const full = path.join(root, file);
  if (existsSync(full)) rmSync(full, { force: true });
  return true;
}

function why(result: { stderr: string; stdout: string }): string {
  return result.stderr.trim() || result.stdout.trim() || 'без объяснения';
}
