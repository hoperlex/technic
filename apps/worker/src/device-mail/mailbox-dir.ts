import { randomInt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DeviceMailConfig, DeviceMailEnvelope, DeviceMailbox } from './types';

/**
 * Ящик из каталога `.eml` (Р27) — та же роль, что у `MAIL_TRANSPORT=log` в исходящем контуре.
 *
 * Заведён не для красоты: IMAP-сервера нет ни в тестах, ни на машине разработчика, а тест на мок
 * библиотеки не доказывает ровным счётом ничего — он проверяет, что мок отвечает так, как его
 * научили. Здесь же протокол приёма проверяется целиком: курсор, потолок размера, отметка
 * прочитанного и стоп-граница пачки.
 *
 * РАЗБОРА ПИСЬМА ЗДЕСЬ НЕТ. Заголовки `Date`, `Message-ID` и `To` снимаются с начала файла ровно
 * потому, что при `imap` их отдаёт сам сервер в ENVELOPE: каталог играет роль сервера, а не роль
 * разборщика. Чтение останавливается на пустой строке — до тела дело не доходит ни разу, а MIME,
 * вложения и кодировки разбирает API (Р2).
 */

/** Явный признак фикстуры «ящик пересоздан»: файл с числом эпохи рядом с письмами. */
const UID_VALIDITY_FILE = '.uidvalidity';

interface DirMailboxState {
  uidValidity: number;
  /**
   * Следующий свободный UID. Счётчик первого обнаружения файла, а не позиция в каталоге и не хеш
   * содержимого (Р27): протокол читает «от `last_uid` вверх», и письмо с номером ниже курсора не
   * будет отдано никогда. Позиционный UID съедал бы письма молча — новый файл, сортирующийся
   * раньше прочих, получил бы номер уже принятого, и конфликт разошёлся бы «успехом».
   */
  nextUid: number;
  /** Имя файла → выданный ему UID. Номер закреплён за файлом навсегда, пока цела эпоха. */
  uids: Record<string, number>;
  /** UID, помеченные прочитанными, — здешний аналог флага `\Seen`. */
  seen: number[];
}

function emptyState(uidValidity: number): DirMailboxState {
  return { uidValidity, nextUid: 1, uids: {}, seen: [] };
}

/**
 * Файл состояния лежит РЯДОМ с каталогом, а не в нём: каталог наполняет чужая рука (разработчик
 * кладёт туда `.eml`), и служебный файл внутри рано или поздно уехал бы вместе с письмами или
 * попал бы в их перечень.
 */
function stateFileFor(dir: string): string {
  const resolved = resolve(dir);
  return join(dirname(resolved), `${basename(resolved)}.device-mail-state.json`);
}

/**
 * Эпоха, объявленная фикстурой: файл `.uidvalidity` с числом. Так изображается «ящик пересоздан» —
 * явным признаком, а не побочным эффектом запуска.
 */
function declaredUidValidity(dir: string): number | null {
  const marker = join(resolve(dir), UID_VALIDITY_FILE);
  if (!existsSync(marker)) return null;
  const declared = Number(readFileSync(marker, 'utf8').trim());
  return Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : null;
}

/**
 * Новая эпоха — на случай, когда прежняя утрачена вместе с файлом состояния.
 *
 * ВЫВОДИТЬ ЭПОХУ ИЗ ПУТИ НЕЛЬЗЯ, и это разобранная потеря письма, а не вкусовщина. Пусть путь тот
 * же, а состояние снесено (чистка `tmp`, переустановка, битый JSON): нумерация начинается заново,
 * и письмо, попавшее в каталог первым, получает UID 1 — НИЖЕ курсора. Протокол читает «от
 * `last_uid` вверх», значит такое письмо не будет сдано никогда, без единой строки в базе и без
 * предупреждения; а принятые письма уедут вторично уже как новые. Ровно за это Р27 отвергает
 * хеш-UID, и путь в этой роли не лучше хеша.
 *
 * Новая эпоха переводит тот же случай в описанный: ручка сбросит курсор, поставит отметку Р32 и
 * дочитает ящик под барьером дедупликации. Устойчивость эпохи (Р27) при этом цела — она хранится
 * в самом файле состояния и меняется ровно тогда, когда его не стало.
 */
function freshUidValidity(): number {
  // 32-разрядное, как `UIDVALIDITY` в IMAP; ноль означал бы «эпохи нет» и здесь не годится.
  return randomInt(1, 0xffff_ffff);
}

/**
 * Прочитать состояние ящика. `null` — состояния нет или оно негодное (снесено, битый JSON,
 * нечисловая эпоха). Чинить его здесь нечем: непригодное состояние — это новая эпоха, а решает
 * это `open()`, потому что только он вправе писать.
 */
export function readDirMailboxState(dir: string): DirMailboxState | null {
  const file = stateFileFor(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DirMailboxState>;
    const uidValidity = Number(parsed.uidValidity);
    const nextUid = Number(parsed.nextUid);
    if (!Number.isFinite(uidValidity) || uidValidity <= 0) return null;
    return {
      uidValidity,
      nextUid: Number.isFinite(nextUid) && nextUid >= 1 ? nextUid : 1,
      uids: parsed.uids ?? {},
      seen: parsed.seen ?? [],
    };
  } catch {
    return null;
  }
}

function writeState(dir: string, state: DirMailboxState): void {
  writeFileSync(stateFileFor(dir), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Снять с начала файла то, что при `imap` отдаёт сервер: `Date`, `Message-ID` и адрес получателя.
 * Читается только шапка — до первой пустой строки и не больше восьми килобайт.
 */
function peekHeaders(file: string): { date?: string; messageId?: string; to?: string } {
  const head = readFileSync(file).subarray(0, 8192).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const block = end >= 0 ? head.slice(0, end) : head;
  // Развёрнутый перенос: продолжение заголовка начинается с пробела или табуляции.
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const pick = (name: string): string | undefined => {
    const prefix = `${name.toLowerCase()}:`;
    const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : undefined;
  };
  const to = pick('To');
  const angle = to ? /<([^>]+)>/.exec(to) : null;
  return { date: pick('Date'), messageId: pick('Message-ID'), to: angle ? angle[1] : to };
}

export function createDirMailbox(cfg: DeviceMailConfig): DeviceMailbox {
  const dir = resolve(cfg.dir);
  let state: DirMailboxState = emptyState(0);

  /** Перечень писем каталога с закреплёнными за ними UID; новым файлам номер выдаётся здесь. */
  function scan(): { uid: number; file: string }[] {
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => n.toLowerCase().endsWith('.eml'))
          .sort()
      : [];
    let changed = false;
    for (const name of names) {
      if (state.uids[name] === undefined) {
        state.uids[name] = state.nextUid;
        state.nextUid += 1;
        changed = true;
      }
    }
    if (changed) writeState(dir, state);
    return names
      .map((name) => ({ uid: state.uids[name] as number, file: join(dir, name) }))
      .sort((a, b) => a.uid - b.uid);
  }

  return {
    name: 'dir',
    async open() {
      const loaded = readDirMailboxState(dir);
      const declared = declaredUidValidity(dir);
      if (!loaded) {
        // Состояния нет или оно негодное: эпоха утрачена, и выдаётся НОВАЯ — см. пояснение у
        // `freshUidValidity`. Молча продолжить прежнюю нумерацию значит потерять письмо.
        state = emptyState(declared ?? freshUidValidity());
        writeState(dir, state);
      } else if (declared !== null && declared !== loaded.uidValidity) {
        // Фикстура объявила другую эпоху — «ящик пересоздан»: номера прежнего ящика к новому не
        // относятся ни одним числом, и счётчик начинается заново.
        state = emptyState(declared);
        writeState(dir, state);
      } else {
        state = loaded;
      }
      const uidValidity = state.uidValidity;
      // Номера новым файлам выдаются здесь же: без обхода верхняя граница ящика назвала бы только
      // то, что видели прошлые заходы, и отметка Р32 отсекла бы свежий архив.
      scan();
      // Наибольший занятый номер — «следующий свободный минус один», а не максимум по нынешним
      // файлам: переложенное письмо из каталога ушло, но номер свой у ящика занимало. Пустой ящик
      // границы не имеет вовсе — это `null`, а не ноль.
      const maxUid = state.nextUid > 1 ? state.nextUid - 1 : null;
      return { uidValidity, maxUid };
    },
    async listEnvelopes(fromUid, limit) {
      const out: DeviceMailEnvelope[] = [];
      for (const { uid, file } of scan()) {
        // Прочитанные НЕ скрываются: настоящий ящик их не скрывает, и здешний не вправе. Скрывай
        // он — «виденный UID не берётся второй раз» держалось бы на фильтре, которого в рабочем
        // транспорте нет вовсе, а регрессия в курсоре осталась бы невидимой: каждый тик сдавал бы
        // ручке весь ящик заново, и ворота были бы зелёными.
        if (uid < fromUid) continue;
        if (out.length >= limit) break;
        const headers = peekHeaders(file);
        out.push({
          uid,
          size: statSync(file).size,
          dateHeader: headers.date,
          messageIdHeader: headers.messageId,
          envelopeTo: headers.to,
        });
      }
      return out;
    },
    async fetchRaw(uid) {
      const found = scan().find((m) => m.uid === uid);
      if (!found || !existsSync(found.file)) return null;
      return readFileSync(found.file);
    },
    async markProcessed(uid) {
      const found = scan().find((m) => m.uid === uid);
      if (!state.seen.includes(uid)) state.seen.push(uid);
      if (found && cfg.processedMailbox) {
        // Соседний каталог, а не подкаталог: в IMAP разобранный ящик — сосед INBOX, и здешний
        // каталог обязан вести себя так же, иначе переложенное письмо попадёт в собственный обход.
        const target = isAbsolute(cfg.processedMailbox)
          ? cfg.processedMailbox
          : join(dirname(dir), cfg.processedMailbox);
        mkdirSync(target, { recursive: true });
        renameSync(found.file, join(target, basename(found.file)));
        // Имя освобождается вместе с файлом: положат такое же снова — это НОВОЕ письмо, и номер
        // ему нужен новый. Оставь запись — второе письмо унаследовало бы номер первого и было бы
        // пропущено как уже прочитанное.
        delete state.uids[basename(found.file)];
      }
      writeState(dir, state);
    },
    async close() {},
  };
}
