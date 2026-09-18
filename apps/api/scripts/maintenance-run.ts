import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Оболочка возобновляемого прогона maintenance: флаги командной строки и файл состояния.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Такой прогон в каталоге не один: массовый бэкфилл истории назначения
 * (`assignment-backfill.ts`) и обратный прогон (`assignment-rollback.ts`) устроены одинаково —
 * страница заявок, работа по одной, курсор в файле, отчёт с выжимкой на экран. Различается у них
 * только работа; всё, что вокруг неё, было двумя дословными копиями, вплоть до текста отказов.
 * Здесь та же граница, что и у соседей (`maintenance-access.ts` — «чем открыта дверь»,
 * `assignment-history-run.ts` — «общее ядро прогона, разные оболочки»): одно правило живёт в одном
 * месте, потому что вторая его копия расходится с первой молча.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Самой работы, выборки и отчёта: модуль ничего не исполняет и ничего не печатает —
 * его загрузка не должна ни к чему приводить. Формат состояния он тоже не задаёт: каждый прогон
 * хранит свои счётчики и свои строки отчёта, а общими остаются три поля шапки (`version`, `mode`,
 * `asOf`), по которым чужой файл отвергается.
 */

/** Ошибка аргументов: её ловит оболочка прогона и отвечает кодом «ошибка в аргументах». */
export class UsageError extends Error {}

export type Flags = Map<string, string>;

/**
 * `--флаг=значение` и `--флаг` (то же, что `--флаг=1`). Позиционных аргументов у прогонов нет.
 *
 * Список известных флагов передаётся вызывающим: он у каждого прогона свой, а вот отказ на
 * неизвестном флаге — общий и обязательный. Молча пропущенная опечатка (`--aply` вместо `--apply`)
 * означала бы прогон по всей базе не в том режиме, в каком его запускали.
 */
export function parseArgs(argv: readonly string[], known: ReadonlySet<string>): Flags {
  const flags: Flags = new Map();
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      throw new UsageError(`Неожиданный аргумент: ${raw} (ожидались флаги вида --state=…)`);
    }
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw.slice(2) : raw.slice(2, eq);
    if (!known.has(name)) throw new UsageError(`Неизвестный флаг --${name}`);
    flags.set(name, eq < 0 ? '1' : raw.slice(eq + 1));
  }
  return flags;
}

export function boolFlag(flags: Flags, name: string): boolean {
  const value = flags.get(name);
  return value !== undefined && value !== '0' && value !== 'false';
}

export function intFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flags.get(name)?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--${name}=${raw}: ожидалось целое неотрицательное число`);
  }
  return value;
}

/** Сколько строк отчёта печатать на экран: полный список идёт в `--report`. */
export const SAMPLE_LIMIT = 20;
/** Размер страницы выборки. Работа идёт по одной заявке, страницами берутся только их номера. */
export const PAGE_SIZE = 500;
/** Версия формата файла состояния: чужой формат лучше отвергнуть, чем прочитать наполовину. */
export const STATE_VERSION = 1;
/**
 * Как часто состояние сбрасывается на диск.
 *
 * Не «после каждой заявки», и это измерено: файл состояния несёт **весь** отчёт для человека, то
 * есть растёт вместе с ним, — запись его на каждой заявке делает прогон квадратичным. На замере
 * 17 205 заявок с 1620 блокирующими строками цена страницы в 2000 заявок росла с 7 до 13 секунд
 * ровно по этой причине.
 *
 * Плата за редкий сброс названа честно: прерванный прогон переделывает не больше сотни заявок, и
 * переделка безобидна — сделанная заявка в выборку уже не попадает. Но счётчики возобновлённого
 * прогона могут недосчитать эту сотню: их состояние сменилось, и вторая выборка их не видит.
 * Точное число всегда даёт таблица популяции — она читается из базы, а не из счётчиков.
 */
export const STATE_FLUSH_EVERY = 100;

/** Прогон либо считает, либо пишет; третьего режима нет, и файл состояния их не путает. */
export type RunMode = 'dry-run' | 'apply';

/** Шапка файла состояния — то общее, по чему чужой файл отвергается. */
export interface StoredRun {
  version: number;
  mode: RunMode;
  /** День расчёта валидности. Есть не у всех прогонов: откату считать нечего. */
  asOf?: string;
}

/**
 * Прочитать сохранённое состояние — и отвергнуть чужое.
 *
 * Проверок до трёх, и каждая закрывает свой способ получить бессмысленный отчёт: версия формата —
 * файл от другой сборки; режим — продолжение записи под видом dry-run (и наоборот); `asOf` —
 * продолжение вчерашнего прогона сегодня. Последняя спрашивается только у прогонов, которые
 * считают на дату, и это не мелочь для них: состояние пишется вместе с
 * `assignment_history_validated_on`, и заявки второго дня получили бы вчерашнюю дату проверки, а
 * предикат cutover требует одного дня на всех (З2).
 *
 * Нет файла — `null`: это не отказ, а «прогон начинается с нуля».
 */
export function readRunState<T extends StoredRun>(
  path: string,
  expect: { mode: RunMode; asOf?: string },
): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const state = JSON.parse(raw) as T;
  if (state.version !== STATE_VERSION) {
    throw new Error(
      `Файл состояния ${path} записан форматом ${state.version}, а прогон понимает ${STATE_VERSION}: начните заново (--restart)`,
    );
  }
  if (state.mode !== expect.mode) {
    throw new Error(
      `Файл состояния ${path} принадлежит прогону «${state.mode}», а запущен «${expect.mode}»: возьмите другой файл либо --restart`,
    );
  }
  if (expect.asOf !== undefined && state.asOf !== expect.asOf) {
    throw new Error(
      `Файл состояния ${path} считает валидность на ${state.asOf}, а прогон запущен на ${expect.asOf}. ` +
        'Продолжать нельзя: заявки получили бы разные даты проверки, а cutover требует одной (З2). ' +
        `Либо повторите прежний день (--asof=${state.asOf}), либо начните заново (--restart).`,
    );
  }
  return state;
}

export function writeRunState(path: string, state: StoredRun): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
