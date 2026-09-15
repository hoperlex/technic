/**
 * Стабильная точка этого репозитория: версия выпуска, её тег и место тега в истории.
 *
 * ПОЧЕМУ ФАЙЛ ЛЕЖИТ В `project/`. Он знает про конкретный репозиторий: про файл `VERSION`, про
 * формат номера `<линия>.<выпуск>.<решение>` и про порог, с которого у выпусков есть теги. Ядру
 * (`core/**`) этого знать нельзя, поэтому решение «начинать ли прогон» принимается не здесь, а в
 * `core/start-gate.ts` — сюда приходит только описание точки.
 *
 * ЧТО ИМЕННО СЧИТАЕТСЯ ЯКОРЕМ. Политика версий (`architecture/policies/versioning.yaml`, решение
 * `docs/adr/0191-version-numbering.md`) держит выпуск в трёх местах: строкой в `VERSION`, тегом
 * `v<версия>` на коммите и записью журнала, которую заводит миграция. Журнал здесь не
 * спрашивается намеренно: он живёт в базе и на машине без наката недоступен, а согласованность
 * версии с миграциями уже проверяет `pnpm check:version`. Системе обслуживания нужны ровно два
 * ответа — как выпуск называется и где он в истории.
 *
 * ОТСУТСТВИЕ ТЕГА — НЕ ОШИБКА. Теги ведутся начиная с `0.1.83.0191` (`tag.since`) и задним числом
 * не расставляются (`retroactive: false`): восемьдесят два прежних выпуска выкатывались без них, и
 * коммит выпуска у части из них достоверно не определить, а восстановленный наугад тег хуже
 * отсутствующего — он выглядит как факт. Поэтому отсутствие тега здесь описывается словами как
 * известное состояние, а не молчанием и не отказом.
 *
 * `problems` — СТРОКИ, А НЕ УРОВНИ. Уровень («это запрет» или «это оговорка») зависит от режима
 * прогона, а режим знает ядро. Заведи мы severity здесь — одно и то же обстоятельство получило бы
 * два веса в двух местах, и они разошлись бы.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { run } from '../analyzers/run.ts';

/** Формат номера — дословно из `format.pattern` политики версий. */
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{4})$/;

/** Первый выпуск, у которого тег предусмотрен политикой (`sources.tag.since`). */
const TAG_SINCE = { raw: '0.1.83.0191', major: 0, minor: 1, release: 83 } as const;

export interface ReleaseAnchor {
  /** Содержимое `VERSION`. `null` — файла нет или он пуст. */
  readonly version: string | null;
  /** Соответствует ли номер формату политики. */
  readonly wellFormed: boolean;
  /** `v{version}`, если такой тег существует; иначе `null`. */
  readonly tag: string | null;
  /** Стоит ли тег на текущей вершине. */
  readonly tagOnHead: boolean;
  /** Сколько коммитов набрано после тега. `null` — тега нет или git не ответил. */
  readonly commitsSinceTag: number | null;
  /** Человеческим языком, по строке на обстоятельство. Пусто — точка названа и стоит на вершине. */
  readonly problems: readonly string[];
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly release: number;
}

/** Разбор номера. Строкой версии сравнивать нельзя: «0.1.10» встало бы раньше «0.1.9». */
function parse(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) return null;
  const [, major, minor, release] = match;
  if (major === undefined || minor === undefined || release === undefined) return null;
  return { major: Number(major), minor: Number(minor), release: Number(release) };
}

/** Дошёл ли выпуск до порога, с которого теги вообще ведутся. */
function atOrAfterTagSince(version: ParsedVersion): boolean {
  if (version.major !== TAG_SINCE.major) return version.major > TAG_SINCE.major;
  if (version.minor !== TAG_SINCE.minor) return version.minor > TAG_SINCE.minor;
  return version.release >= TAG_SINCE.release;
}

export function readReleaseAnchor(root: string): ReleaseAnchor {
  const problems: string[] = [];

  let version: string | null = null;
  try {
    const text = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    if (text === '') {
      problems.push('Файл VERSION пуст: назвать выпуск, от которого идёт прогон, нечем.');
    } else {
      version = text;
    }
  } catch {
    problems.push(
      'Нет файла VERSION — единственного источника версии в репозитории: стабильную точку ' +
        'назвать нечем.',
    );
  }

  const parsed = version === null ? null : parse(version);
  if (version !== null && parsed === null) {
    problems.push(
      `VERSION (${version}) не соответствует формату <линия>.<выпуск>.<решение>, например ` +
        '0.1.83.0192: такой номер не сопоставим ни с журналом выпусков, ни с тегом.',
    );
  }

  // Тег ищется только у разобранного номера: у мусорной строки «тег v<мусор>» не имеет смысла, а
  // спрашивать git о заведомой ерунде — лишний повод получить непонятную ошибку.
  if (parsed === null || version === null) {
    return {
      version,
      wellFormed: false,
      tag: null,
      tagOnHead: false,
      commitsSinceTag: null,
      problems,
    };
  }

  const wanted = `v${version}`;
  const listed = run(root, ['git', 'tag', '--list', wanted]);
  if (listed.code !== 0) {
    problems.push(
      `Git не ответил на запрос тега (${listed.stderr.trim() || 'без сообщения'}): есть ли ` +
        `${wanted}, неизвестно.`,
    );
    return {
      version,
      wellFormed: true,
      tag: null,
      tagOnHead: false,
      commitsSinceTag: null,
      problems,
    };
  }

  if (listed.stdout.trim() === '') {
    if (atOrAfterTagSince(parsed)) {
      problems.push(
        `Выпуск ${version} ещё не помечен тегом ${wanted}. Это ожидаемое состояние, а не ошибка: ` +
          'тег ставит человек в момент выката, а прогон случается и до него. Точка старта названа ' +
          'версией, но места в истории у неё пока нет.',
      );
    } else {
      problems.push(
        `У выпуска ${version} тега нет и не будет: теги ведутся с ${TAG_SINCE.raw} и задним числом ` +
          'не расставляются (retroactive: false). Известное состояние, а не ошибка — точка старта ' +
          'названа версией.',
      );
    }
    return {
      version,
      wellFormed: true,
      tag: null,
      tagOnHead: false,
      commitsSinceTag: null,
      problems,
    };
  }

  // `rev-list -n 1` снимает обёртку аннотированного тега и даёт коммит; `rev-parse <тег>` у такого
  // тега вернул бы объект тега, и сравнение с вершиной молча не сошлось бы никогда.
  const head = run(root, ['git', 'rev-parse', 'HEAD']).stdout.trim();
  const target = run(root, ['git', 'rev-list', '-n', '1', wanted]).stdout.trim();
  const tagOnHead = head !== '' && head === target;

  const counted = run(root, ['git', 'rev-list', '--count', `${wanted}..HEAD`]);
  const count = Number.parseInt(counted.stdout.trim(), 10);
  const commitsSinceTag = counted.code === 0 && Number.isFinite(count) ? count : null;

  if (!tagOnHead) {
    problems.push(
      commitsSinceTag !== null && commitsSinceTag > 0
        ? `Тег ${wanted} стоит не на вершине: после него ${commitsSinceTag} коммитов. Прогон ` +
            'стартует не от выпуска, и откат вернёт дерево к промежуточному состоянию.'
        : `Тег ${wanted} не совпадает с вершиной, хотя коммитов после него нет: вершина отстаёт от ` +
            'выпуска или ушла в сторону.',
    );
  }

  return { version, wellFormed: true, tag: wanted, tagOnHead, commitsSinceTag, problems };
}

/**
 * Названа ли стабильная точка.
 *
 * Тег в это НЕ входит, и это главное здесь решение: по политике версий теги ведутся только с
 * `0.1.83.0191` и задним числом не расставляются, так что требование тега закрыло бы обслуживание
 * всему, что старше. Назвать выпуск достаточно разобранной версией — она сопоставима и с журналом,
 * и с историей.
 */
export function anchorNamed(anchor: ReleaseAnchor): boolean {
  return anchor.wellFormed;
}
