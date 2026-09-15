/**
 * Контрольная точка и откат.
 *
 * ПОЧЕМУ НЕ `git stash` И НЕ `git checkout .`. Рабочее дерево здесь общее: рядом лежит чужая
 * незавершённая работа. Откат «всего дерева» унёс бы её вместе с неудачной правкой — это самая
 * дорогая ошибка, которую эта система может совершить, и она необратима для человека, который
 * ничего про прогон не знал.
 *
 * Поэтому контрольная точка ПОФАЙЛОВАЯ и снимается только с тех файлов, которые разрешено
 * трогать. Всё, что вне списка, для транзакции не существует: она его не сохраняет, не
 * восстанавливает и не удаляет.
 *
 * Второе следствие того же выбора: система обязана заметить правку за пределами списка. Сама она
 * её не откатит (это не её файлы), но и принять партию не имеет права — об этом отдельная
 * проверка в `verification/`.
 */
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizePath } from '../core/paths.ts';

/**
 * Границы, которые транзакция обязана уметь: создать точку, откатить к ней, принять.
 *
 * Интерфейс отделён от реализации не ради стройности: сегодня точка — копии файлов, завтра это
 * может быть отдельное рабочее дерево git. Оркестратор об этом знать не должен.
 */
export interface WorkspaceTransaction {
  createCheckpoint(files: readonly string[]): Promise<string>;
  rollback(id: string): Promise<RollbackReport>;
  accept(id: string): Promise<void>;
}

export interface RollbackReport {
  readonly restored: readonly string[];
  readonly removed: readonly string[];
}

interface FileRecord {
  readonly file: string;
  readonly existed: boolean;
  readonly hash: string | null;
}

interface Manifest {
  readonly id: string;
  readonly createdAt: string;
  readonly files: readonly FileRecord[];
}

const MANIFEST = 'manifest.json';
const CONTENT = 'content';

export class FileCheckpointTransaction implements WorkspaceTransaction {
  readonly #root: string;
  readonly #home: string;

  constructor(root: string, home: string) {
    this.#root = root;
    this.#home = home;
  }

  async createCheckpoint(files: readonly string[]): Promise<string> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomSuffix()}`;
    const dir = path.join(this.#home, id);
    mkdirSync(path.join(dir, CONTENT), { recursive: true });

    const records: FileRecord[] = [];
    for (const raw of files) {
      const file = normalizePath(this.#root, raw);
      const source = path.join(this.#root, file);
      if (existsSync(source)) {
        const target = path.join(dir, CONTENT, file);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(source, target);
        records.push({ file, existed: true, hash: hashOf(source) });
      } else {
        // Файла ещё нет — значит, правка его создаст, и откат обязан его удалить. Без этой записи
        // неудачная партия оставляла бы в дереве половину новой сущности.
        records.push({ file, existed: false, hash: null });
      }
    }

    const manifest: Manifest = { id, createdAt: new Date().toISOString(), files: records };
    writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return id;
  }

  async rollback(id: string): Promise<RollbackReport> {
    const dir = path.join(this.#home, id);
    const manifest = this.#manifest(id);
    const restored: string[] = [];
    const removed: string[] = [];

    for (const record of manifest.files) {
      const target = path.join(this.#root, record.file);
      if (record.existed) {
        const saved = path.join(dir, CONTENT, record.file);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(saved, target);
        restored.push(record.file);
      } else if (existsSync(target)) {
        rmSync(target, { force: true });
        removed.push(record.file);
      }
    }

    rmSync(dir, { recursive: true, force: true });
    return { restored, removed };
  }

  async accept(id: string): Promise<void> {
    rmSync(path.join(this.#home, id), { recursive: true, force: true });
  }

  /**
   * Сколько строк изменила партия: считается по контрольной точке, а не по словам исполнителя.
   *
   * ЭТО ЕДИНСТВЕННЫЙ ЧЕСТНЫЙ ИСТОЧНИК ЧИСЛА. Раньше лимит строк в политике стоял, а считать его
   * было нечем: в автоматы приходил ноль, условие «объём правки превышен» не могло сработать
   * никогда, и отчёт печатал человеку «изменено 0 строк» на любой правке. Обещание предела, от
   * которого остался только текст, хуже отсутствия предела.
   *
   * Складываются добавленные и удалённые: для бюджета важен объём работы, а не итоговый прирост —
   * правка, переписавшая сто строк на сто других, стоит проверяющему столько же, сколько сотня
   * новых.
   */
  changedLinesIn(id: string): number {
    const dir = path.join(this.#home, id, CONTENT);
    let total = 0;
    for (const record of this.#manifest(id).files) {
      const target = path.join(this.#root, record.file);
      const saved = path.join(dir, record.file);
      const existsNow = existsSync(target);
      if (!record.existed) {
        total += existsNow ? countLines(target) : 0;
        continue;
      }
      if (!existsNow) {
        total += countLines(saved);
        continue;
      }
      total += diffLines(saved, target);
    }
    return total;
  }

  /** Какие файлы партии действительно изменились: сравнение по содержимому, а не по времени. */
  changedIn(id: string): string[] {
    const changed: string[] = [];
    for (const record of this.#manifest(id).files) {
      const target = path.join(this.#root, record.file);
      const exists = existsSync(target);
      if (record.existed !== exists) {
        changed.push(record.file);
        continue;
      }
      if (exists && hashOf(target) !== record.hash) changed.push(record.file);
    }
    return changed;
  }

  #manifest(id: string): Manifest {
    const file = path.join(this.#home, id, MANIFEST);
    if (!existsSync(file)) throw new Error(`контрольной точки ${id} нет`);
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  }
}

/** Строк в файле. Пустой хвост после последнего перевода строки строкой не считается. */
function countLines(file: string): number {
  const text = readFileSync(file, 'utf8');
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * Добавленные и удалённые строки между двумя версиями файла.
 *
 * Считает git, а не собственный проход по строкам: свой наивный счёт («сколько строк не совпало
 * попарно») врёт на любой вставке — добавленная в начале строка сдвигает файл, и все последующие
 * выглядят изменёнными. Ошибка была бы в разы и всегда в сторону завышения, то есть бюджет
 * исчерпывался бы раньше времени.
 */
function diffLines(before: string, after: string): number {
  const result = spawnSync('git', ['diff', '--no-index', '--numstat', '--', before, after], {
    encoding: 'utf8',
  });
  const line = (result.stdout ?? '').split('\n').find((row) => row.trim() !== '');
  if (line === undefined) return 0;
  const [added = '0', removed = '0'] = line.split('\t');
  const sum = Number(added) + Number(removed);
  return Number.isFinite(sum) ? sum : 0;
}

function hashOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function randomSuffix(): string {
  return createHash('sha256').update(`${process.pid}-${Math.random()}`).digest('hex').slice(0, 6);
}
