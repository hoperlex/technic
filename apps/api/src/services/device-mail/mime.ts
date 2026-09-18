import { simpleParser } from 'mailparser';
import type { DeviceMailContext } from '@technic/contracts';

/**
 * Письмо аппарата → нейтральный вид (`DeviceMailContext`), план
 * `docs/office-equipment-mail-telemetry-plan.md` §8.
 *
 * Здесь кончается всё знание о MIME: ни один профиль вендора не видит ни `Buffer`, ни частей, ни
 * разметки. Причина не в красоте слоёв, а в тестируемости (Р13 и §12): случаи разбора гоняются на
 * `.eml` без базы и без окружения, а профиль обязан быть чистой функцией от полей контекста.
 *
 * Отсюда же три решения этого файла, которые иначе выглядят произволом:
 *
 * 1. **Таблицы приводятся к `string[][]` прямо здесь.** Аппараты старых прошивок шлют счётчики
 *    таблицей и только таблицей; профиль, разбирающий её регулярным выражением по разметке,
 *    сломается на первом же письме с `<td class=...>` или переносом строки внутри ячейки.
 * 2. **Вложения отдаются текстом, а не байтами.** Единственный способ решить, какой кодировкой
 *    читать CSV-отчёт, — заголовок его же части; выше по стеку этого заголовка уже нет.
 * 3. **`dateHeader` отдаётся в ISO 8601, а сырая строка остаётся в `headers.date`.** Профиль кладёт
 *    время в `deviceTime`, а контракт требует там `datetime()`; заставлять каждый профиль разбирать
 *    RFC 5322 заново значит получить столько разборов даты, сколько вендоров.
 */

/** Пустой контекст: поля объявлены все, чтобы профиль не проверял их существование. */
const EMPTY_CONTEXT: DeviceMailContext = {
  subject: '',
  fromAddress: '',
  envelopeTo: '',
  messageIdHeader: '',
  dateHeader: null,
  text: '',
  html: '',
  tables: [],
  attachments: [],
  headers: {},
};

/**
 * Синонимы кодировок. Прошивки пишут их как придётся (`cp1251`, `Windows1251`, `koi8`), а
 * `TextDecoder` знает ровно одно написание и на прочих бросает исключение — то есть роняет разбор
 * целого письма из-за опечатки в заголовке части.
 */
const CHARSET_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  cp1251: 'windows-1251',
  'cp-1251': 'windows-1251',
  win1251: 'windows-1251',
  'win-1251': 'windows-1251',
  windows1251: 'windows-1251',
  'windows-1251': 'windows-1251',
  koi8: 'koi8-r',
  koi8r: 'koi8-r',
  'koi8-r': 'koi8-r',
  'koi8-u': 'koi8-u',
  'iso8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
};

function canonicalCharset(raw: string | undefined | null): string {
  const key = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/gu, '');
  if (!key) return 'utf-8';
  return CHARSET_ALIASES[key] ?? key;
}

/**
 * Байты → строка. Незнакомая кодировка читается как UTF-8, а не роняет письмо: мусор в одном поле
 * человек в очереди увидит и поймёт, а потерянное письмо — нет (Р13).
 */
export function decodeText(bytes: Uint8Array, charset?: string | null): string {
  const name = canonicalCharset(charset);
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeQuotedPrintableWord(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '_') {
      bytes.push(0x20);
      continue;
    }
    if (ch === '=' && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/**
 * `encoded-word` (RFC 2047) в значении заголовка. `mailparser` раскрывает тему и адреса сам, но не
 * вендорские `X-`заголовки, а именно в них старые Ricoh кладут имя аппарата — по-русски и в
 * `windows-1251`.
 */
export function decodeEncodedWords(value: string): string {
  // Пробел между двумя соседними encoded-word по RFC 2047 не значит ничего и обязан исчезнуть:
  // длинное имя аппарата разрезано на слова не по словам, а по 75 знакам строки.
  const glued = value.replace(/\?=\s+=\?/gu, '?==?');
  return glued.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/gu,
    (whole, charset: string, encoding: string, payload: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Uint8Array.from(Buffer.from(payload, 'base64'))
            : decodeQuotedPrintableWord(payload);
        return decodeText(bytes, charset);
      } catch {
        return whole;
      }
    },
  );
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  laquo: '\u00ab',
  raquo: '\u00bb',
  deg: '\u00b0',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body.startsWith('#x') || body.startsWith('#X')
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Текст ячейки. Неразрывный пробел схлопывается в обычный намеренно: `&nbsp;` внутри числа —
 * штатное поведение прошивок (§13, риск Э3), и разбирать «1 234 567» каждому профилю отдельно
 * значит ошибиться в одном из них.
 */
function cellText(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/[\u00a0\u2007\u202f\u2009]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const TAG_RE = /<!--[\s\S]*?-->|<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gu;

/**
 * Таблицы HTML построчно ячейками. Свой проход, а не библиотека разбора DOM: в зависимостях API её
 * нет, а нужна ровно одна операция — «строки и ячейки», причём на разметке, которую пишет прошивка
 * принтера, то есть без гарантий закрытых тегов.
 *
 * Вложенная таблица становится **отдельной** таблицей и в ячейку внешней не попадает. Так
 * предсказуемее: «таблица внутри ячейки» у вендоров означает вёрстку колонками, а не данные.
 */
export function extractHtmlTables(html: string): string[][][] {
  if (!html) return [];
  const tables: string[][][] = [];
  const stack: { slot: number; rows: string[][]; row: string[] | null; cell: string | null }[] = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  const closeCell = () => {
    const frame = top();
    if (!frame || frame.cell === null) return;
    const text = cellText(frame.cell);
    frame.cell = null;
    if (!frame.row) frame.row = [];
    frame.row.push(text);
  };
  const closeRow = () => {
    const frame = top();
    if (!frame) return;
    closeCell();
    if (frame.row) {
      frame.rows.push(frame.row);
      frame.row = null;
    }
  };

  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(html)) !== null) {
    const frame = top();
    if (frame && frame.cell !== null) frame.cell += html.slice(cursor, match.index);
    cursor = TAG_RE.lastIndex;
    const name = match[1]?.toLowerCase();
    if (!name) continue; // комментарий
    const closing = match[0].startsWith('</');
    switch (name) {
      case 'table':
        if (closing) {
          closeRow();
          const done = stack.pop();
          if (done) tables[done.slot] = done.rows;
        } else {
          // Вложенная таблица разрывает текст внешней ячейки, и на её месте остаётся пробел:
          // без него «метка<table>…</table>число» склеивалось бы в одно слово.
          const parent = top();
          if (parent && parent.cell !== null) parent.cell += ' ';
          tables.push([]);
          stack.push({ slot: tables.length - 1, rows: [], row: null, cell: null });
        }
        break;
      case 'tr':
        if (top()) {
          closeRow();
          if (!closing) top()!.row = [];
        }
        break;
      case 'td':
      case 'th':
        if (top()) {
          closeCell();
          if (!closing) top()!.cell = '';
        }
        break;
      case 'br':
      case 'p':
      case 'div':
        if (top()?.cell !== null && top()) top()!.cell += ' ';
        break;
      default:
        break;
    }
  }
  // Хвост после последнего тега — тоже текст ячейки. Прошивка, не закрывшая `</td>` у последней
  // колонки (а «`<td>метка<td>число`» — законный HTML), иначе теряла бы ровно значение.
  const tail = top();
  if (tail && tail.cell !== null) tail.cell += html.slice(cursor);
  // Незакрытые таблицы всё равно отдаются: прошивка, забывшая `</table>`, не повод потерять данные.
  while (stack.length > 0) {
    closeRow();
    const done = stack.pop();
    if (done) tables[done.slot] = done.rows;
  }
  return tables.filter((rows) => rows.length > 0);
}

/** Текстовые типы вложений: остальное (картинка, PDF) в контекст текстом не едет. */
function isTextualContentType(contentType: string, filename: string): boolean {
  const type = contentType.toLowerCase();
  if (type.startsWith('text/')) return true;
  if (/^application\/(csv|json|xml|.*\+xml)$/u.test(type)) return true;
  return /\.(csv|txt|xml|json|log|tsv)$/iu.test(filename);
}

/**
 * Спасение заголовка, написанного сырыми восьмибитными байтами.
 *
 * По RFC 5322 в заголовке не бывает ничего, кроме ASCII, и всё прочее обязано ехать
 * `encoded-word`. Прошивки принтеров это правило нарушают регулярно — русское имя аппарата
 * приезжает в `X-`заголовке байтами UTF-8 как есть. Разборщик MIME читает такие байты как
 * latin1, и человек в очереди видит «Ð Ð¸Ñ» вместо имени.
 *
 * Условие срабатывания намеренно узкое: строка целиком укладывается в latin1 **и** её байты
 * складываются в правильный UTF-8 с многобайтовыми последовательностями. Случайно так не
 * получается: законный latin1-текст (`Café`) проверку UTF-8 не проходит и остаётся собой.
 */
function recoverRawEightBit(value: string): string {
  let hasHigh = false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Знак вне latin1 означает, что строку уже кто-то расшифровал правильно.
    if (code > 0xff) return value;
    if (code >= 0x80) hasHigh = true;
  }
  if (!hasHigh) return value;
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function headerValue(line: string): string {
  const colon = line.indexOf(':');
  const value = colon >= 0 ? line.slice(colon + 1) : line;
  return decodeEncodedWords(recoverRawEightBit(value)).replace(/\s+/gu, ' ').trim();
}

/**
 * Разбор сырого письма.
 *
 * `envelopeTo` приходит вторым аргументом, а не вычитывается из заголовков: адрес конверта знает
 * транспорт (IMAP), и он же может отличаться от `To` — рассылка по группе, скрытая копия, чужой
 * ящик. Не передали — берётся первый адрес `To`, и это честное умолчание для прогона на `.eml`.
 */
export async function parseDeviceMail(
  raw: Buffer,
  envelope?: { envelopeTo?: string },
): Promise<DeviceMailContext> {
  const parsed = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true });

  const headers: Record<string, string> = {};
  for (const { key, line } of parsed.headerLines ?? []) {
    const value = headerValue(line);
    // Повторы (`Received`, вендорские `X-`) склеиваются, а не затирают друг друга: последний
    // выигравший молча выбросил бы половину маршрута письма.
    headers[key] = key in headers ? `${headers[key]}\n${value}` : value;
  }

  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const toAddress = parsed.to
    ? Array.isArray(parsed.to)
      ? parsed.to[0]?.value?.[0]?.address
      : parsed.to.value?.[0]?.address
    : undefined;

  const attachments = (parsed.attachments ?? []).map((attachment) => {
    const filename = attachment.filename ?? '';
    const contentType = attachment.contentType ?? 'application/octet-stream';
    const params = (attachment.headers?.get('content-type') as { params?: Record<string, string> })
      ?.params;
    return {
      filename,
      contentType,
      text: isTextualContentType(contentType, filename)
        ? decodeText(attachment.content, params?.charset)
        : '',
    };
  });

  return {
    ...EMPTY_CONTEXT,
    subject: decodeEncodedWords(recoverRawEightBit(parsed.subject ?? '')),
    fromAddress: parsed.from?.value?.[0]?.address ?? '',
    envelopeTo: envelope?.envelopeTo ?? toAddress ?? '',
    messageIdHeader: parsed.messageId ?? '',
    dateHeader: parsed.date ? parsed.date.toISOString() : null,
    text: parsed.text ?? '',
    html,
    tables: extractHtmlTables(html),
    attachments,
    headers,
  };
}
