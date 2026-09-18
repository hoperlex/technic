import type { DeviceMailContext } from '@technic/contracts';

/**
 * Общая вычитка полей для профилей вендоров (план `docs/office-equipment-mail-telemetry-plan.md`
 * §8, `extract.ts`).
 *
 * Только чистые функции: ни базы, ни контекста запроса, ни чтения времени. Это условие того, что
 * профиль проверяется на `.eml` без окружения, и одновременно — условие того, что правило чтения
 * числа живёт **одним местом**. Три вендора, каждый со своим `parseFloat`, разойдутся на первом же
 * письме с неразрывным пробелом в счётчике, и разойдутся молча.
 */

/**
 * Пробелы, которыми аппараты разделяют разряды. Неразрывный (`&nbsp;` → U+00A0), узкий неразрывный
 * и «цифровой» — всё это встречается в HTML-отчётах прошивок наравне с обычным.
 */
const SPACE_CLASS = /[\s\u00a0\u2007\u202f\u2009]+/gu;

/** Пробелы к одному виду, края обрезаны. Основа всякого сравнения меток в этом файле. */
export function normalizeSpaces(value: string): string {
  return value.replace(SPACE_CLASS, ' ').trim();
}

/** Форма сравнения метки: регистр и хвостовое двоеточие значения не имеют. */
export function normalizeLabel(value: string): string {
  return normalizeSpaces(value)
    .replace(/[:：]\s*$/u, '')
    .toLocaleLowerCase('ru-RU');
}

/**
 * Один числовой токен строки: группы цифр, разделители между ними и признак пробельной
 * группировки. Разбор идёт сканером, а не жадным регулярным выражением, по одной причине:
 * жадный класс `[\d\s.,]*` **склеивает два числа**. На строке «45 % 10.09.2026» — процент и
 * дата рядом, обычное дело в письме об уровнях — он собирал из обоих одно число и выдавал
 * 451009.203, то есть правдоподобную чушь без всякого признака ошибки.
 */
interface NumberToken {
  /** Группы цифр по порядку: первая — старшая. */
  runs: string[];
  /** Разделители между группами: `' '` (любой пробел), `'.'` или `','`. */
  seps: string[];
  negative: boolean;
  /** В исходной строке разряды разделены пробелами. Вето на чтение точек и запятых как разрядов. */
  spaceGrouped: boolean;
}

const SPACE_CHARS = new Set([' ', '\t', '\u00a0', '\u2007', '\u202f', '\u2009']);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function digitsFrom(text: string, start: number): string {
  let end = start;
  while (isDigit(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * Первый числовой токен строки.
 *
 * Правило разделителя: **пробел разрядный только перед группой ровно из трёх цифр**, за которой не
 * идёт четвёртая. Точка и запятая принимаются и перед группой другой длины, но такая группа может
 * быть только последней — это дробная часть, и после неё токен заканчивается.
 */
function scanNumberToken(text: string): NumberToken | null {
  for (let start = 0; start < text.length; start += 1) {
    const negative = text[start] === '-';
    const head = negative ? start + 1 : start;
    const first = digitsFrom(text, head);
    if (!first) continue;
    const runs = [first];
    const seps: string[] = [];
    let spaceGrouped = false;
    let cursor = head + first.length;
    for (;;) {
      const sep = text[cursor];
      if (sep === undefined) break;
      if (SPACE_CHARS.has(sep)) {
        const group = digitsFrom(text, cursor + 1);
        if (group.length !== 3) break;
        runs.push(group);
        seps.push(' ');
        spaceGrouped = true;
        cursor += 1 + group.length;
        continue;
      }
      if (sep === '.' || sep === ',') {
        const group = digitsFrom(text, cursor + 1);
        if (group.length === 0) break;
        runs.push(group);
        seps.push(sep);
        cursor += 1 + group.length;
        if (group.length !== 3) break;
        continue;
      }
      break;
    }
    return { runs, seps, negative, spaceGrouped };
  }
  return null;
}

/**
 * Токен → целая и дробная части.
 *
 * `grouping` — разрешено ли читать точку и запятую как разрядный разделитель. Даже когда
 * разрешено, три цифры считаются разрядами **только** при строгой группировке всего тела одним и
 * тем же разделителем (`1.234`, `8,125`) и **только** если пробельной группировки в строке не
 * было. Без этого вето девятизначный счётчик «999 999 999,999» превращался в двенадцатизначный:
 * пробелы снимались раньше проверки, и хвост из трёх цифр читался как ещё одна тысяча.
 */
function splitToken(token: NumberToken, grouping: boolean): { whole: string; fraction: string } {
  let lastPunctuation = -1;
  for (let index = 0; index < token.seps.length; index += 1) {
    if (token.seps[index] !== ' ') lastPunctuation = index;
  }
  if (lastPunctuation < 0) return { whole: token.runs.join(''), fraction: '' };

  const punctuation = token.seps.filter((sep) => sep !== ' ');
  const sameSeparator = punctuation.every((sep) => sep === punctuation[0]);
  const thirds =
    (token.runs[0]?.length ?? 0) <= 3 && token.runs.slice(1).every((run) => run.length === 3);
  if (grouping && !token.spaceGrouped && sameSeparator && thirds) {
    return { whole: token.runs.join(''), fraction: '' };
  }
  return {
    whole: token.runs.slice(0, lastPunctuation + 1).join(''),
    fraction: token.runs[lastPunctuation + 1] ?? '',
  };
}

/** Знаков после запятой в схеме наблюдения — три (`numeric(18,3)`), и это единственное дробное. */
const MAX_FRACTION_DIGITS = 3;

/**
 * Целая и дробная части → строка вида, который принимает контракт (`^\d+(\.\d{1,3})?$`).
 *
 * Округление лишних знаков идёт **на строке через `BigInt`**, а не через `Number`: счётчик за жизнь
 * аппарата уходит за девять знаков, и контракт держит значение строкой ровно затем, чтобы оно не
 * путешествовало через double. Перенос при округлении (9,9999 → 10) здесь тоже строковый.
 */
function formatDecimal(whole: string, fraction: string): string | null {
  if (!/^\d+$/u.test(whole)) return null;
  if (fraction !== '' && !/^\d+$/u.test(fraction)) return null;
  if (fraction.length <= MAX_FRACTION_DIGITS) {
    const head = whole.replace(/^0+(?=\d)/u, '');
    const tail = fraction.replace(/0+$/u, '');
    return tail ? `${head}.${tail}` : head;
  }
  const keep = fraction.slice(0, MAX_FRACTION_DIGITS);
  let scaled = BigInt(whole + keep);
  if (fraction.charCodeAt(MAX_FRACTION_DIGITS) - 48 >= 5) scaled += 1n;
  const text = scaled.toString().padStart(MAX_FRACTION_DIGITS + 1, '0');
  const head = text.slice(0, -MAX_FRACTION_DIGITS).replace(/^0+(?=\d)/u, '');
  const tail = text.slice(-MAX_FRACTION_DIGITS).replace(/0+$/u, '');
  return tail ? `${head}.${tail}` : head;
}

/**
 * Число из строки аппарата в вид, который принимает контракт наблюдения
 * (`^\d+(\.\d{1,3})?$`).
 *
 * Что здесь учтено и почему:
 *
 * - **разряды пробелами** (`1 234 567`, в HTML — `1&nbsp;234&nbsp;567`): это обычная запись
 *   счётчика в русской локали прошивки;
 * - **разряды точкой и запятой** (`1.234`, `8,125`): только при строгой группировке всего тела
 *   одним разделителем и только когда пробельной группировки в строке нет (см. `splitToken`);
 * - **смешанная запись** (`1,234.56` и `1.234,56`): последний разделитель — дробный, остальные
 *   разрядные. Правило «запятая всегда дробная» ломается на первом же письме с англоязычной
 *   прошивки, а прошивка одного аппарата меняется вместе с языком интерфейса;
 * - **больше трёх знаков после запятой** округляется, а не отбрасывается: отбрасывание дало бы
 *   9,9999 → 9,999 вместо 10.
 *
 * **Отрицательное — `null`, а не число со знаком.** Прошивки пишут в числовой колонке `-1` и `-3`,
 * и значат они «датчика нет», а не «минус три оттиска». Знака схема наблюдения не принимает вовсе,
 * и в этом вся цена решения: отдай мы `-3` строкой, zod отверг бы снимок — и письмо ушло бы в
 * `failed` целиком, из-за одной колонки без датчика, вместе с честно вычитанными счётчиками.
 * Возвращённый `null` означает «наблюдения нет», и остальные строки письма доезжают.
 *
 * Не число — тоже `null`, а не ноль. Ноль здесь означал бы «счётчик обнулён», то есть ровно ту
 * аномалию, ради которой в будущем заводятся месячные дельты.
 */
export function parseNumericValue(raw: string): string | null {
  const token = scanNumberToken(normalizeSpaces(raw));
  if (!token || token.negative) return null;
  const { whole, fraction } = splitToken(token, true);
  return formatDecimal(whole, fraction);
}

/**
 * Процент остатка расходника.
 *
 * Своё правило разбора, а не общее: **у процента не бывает разрядов**. Шкала 0…100, и «8,125» —
 * это восемь процентов с дробью, а не восемь тысяч. Общее правило разрядов читало бы остаток
 * тонера в восемь процентов как полный картридж, а обрезка сверху доделывала бы подлог незаметно.
 *
 * Обрезка остаётся только сверху и только потому, что `110` у свежезалитого картриджа — штатная
 * переливка, а не другое поле. Снизу обрезки нет: отрицательное значит «датчика нет» и уходит
 * `null`, потому что «ноль процентов» — это заявка на замену тонера, которой аппарат не подавал.
 */
export function parsePercentValue(raw: string): string | null {
  const token = scanNumberToken(normalizeSpaces(raw.replace(/%/gu, ' ')));
  if (!token || token.negative) return null;
  const { whole, fraction } = splitToken(token, false);
  const formatted = formatDecimal(whole, fraction);
  if (formatted === null) return null;
  return Number.parseFloat(formatted) > 100 ? '100' : formatted;
}

/** Строки письма: текст, и следом тексты вложений — порядок важен, первым выигрывает тело. */
export function textLines(ctx: DeviceMailContext): string[] {
  const chunks = [ctx.text, ...ctx.attachments.map((attachment) => attachment.text)];
  return chunks
    .join('\n')
    .split(/\r?\n/u)
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0);
}

function labelMatches(candidate: string, labels: readonly string[]): boolean {
  const normalized = normalizeLabel(candidate);
  return labels.some((label) => normalized === normalizeLabel(label));
}

function labelStarts(candidate: string, labels: readonly string[]): boolean {
  const normalized = normalizeLabel(candidate);
  return labels.some((label) => normalized.startsWith(normalizeLabel(label)));
}

/**
 * «Метка: значение» по строкам текста. Разделителем считается и двоеточие, и табуляция, и цепочка
 * точек — все три встречаются в отчётах прошивок, а второй и третий вид ещё и в CSV-вложениях.
 */
export function findLabeledValueInText(
  ctx: DeviceMailContext,
  labels: readonly string[],
): string | null {
  for (const line of textLines(ctx)) {
    const split = /^(.*?)\s*[:：\t]\s*(.+)$/u.exec(line) ?? /^(.*?)\s*\.{2,}\s*(.+)$/u.exec(line);
    if (!split) continue;
    const [, label = '', raw = ''] = split;
    if (labelMatches(label, labels)) {
      const value = normalizeSpaces(raw);
      if (value) return value;
    }
  }
  return null;
}

/**
 * «Метка → соседняя ячейка» по таблицам. Значением считается первая непустая ячейка справа: у
 * вендоров между меткой и числом попадается пустая колонка-разделитель, а строка «метка | | 12»
 * без этого правила читалась бы как строка без значения.
 */
export function findLabeledValueInTables(
  tables: DeviceMailContext['tables'],
  labels: readonly string[],
): string | null {
  for (const table of tables) {
    for (const row of table) {
      for (let column = 0; column < row.length - 1; column += 1) {
        if (!labelMatches(row[column] ?? '', labels)) continue;
        for (let next = column + 1; next < row.length; next += 1) {
          const value = normalizeSpaces(row[next] ?? '');
          if (value) return value;
        }
      }
    }
  }
  return null;
}

/** Метка по всему письму: сначала таблицы (там значение точнее), затем текст и вложения. */
export function findLabeledValue(ctx: DeviceMailContext, labels: readonly string[]): string | null {
  return findLabeledValueInTables(allTables(ctx), labels) ?? findLabeledValueInText(ctx, labels);
}

/** То же, но значением обязано быть число. Метка нашлась, а число нет — это `null`, а не «0». */
export function findNumericValue(ctx: DeviceMailContext, labels: readonly string[]): string | null {
  const raw = findLabeledValue(ctx, labels);
  return raw === null ? null : parseNumericValue(raw);
}

/**
 * Разделённый текст (CSV/TSV вложения) в таблицу. Здесь, а не в `mime.ts`: разметку знает разбор
 * MIME, а «чем разделены колонки в отчёте этого вендора» — предметное знание профиля.
 *
 * Разделитель угадывается по первой непустой строке: аппараты одной марки шлют `;` в русской
 * локали и `,` в английской, и это не повод заводить два профиля.
 */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const head = lines[0];
  if (head === undefined) return [];
  const chosen = delimiter ?? [';', ',', '\t'].find((candidate) => head.includes(candidate)) ?? ';';
  return lines.map((line) =>
    line.split(chosen).map((cell) => normalizeSpaces(cell.replace(/^\s*"(.*)"\s*$/u, '$1'))),
  );
}

/** Таблицы вложений: CSV-отчёт становится такой же таблицей, как HTML-таблица письма. */
export function attachmentTables(ctx: DeviceMailContext): string[][][] {
  return ctx.attachments
    .filter((attachment) => attachment.text.length > 0)
    .map((attachment) => parseDelimitedText(attachment.text))
    .filter((table) => table.length > 0);
}

/** Все таблицы письма: разметка и вложения вместе — профилю различать их незачем. */
export function allTables(ctx: DeviceMailContext): string[][][] {
  return [...ctx.tables.map((table) => table.map((row) => [...row])), ...attachmentTables(ctx)];
}

/**
 * Серийный номер. Метка — первая ступень, шаблон — вторая: часть прошивок пишет серийник в теме
 * письма без всякой метки. Форма шаблона намеренно широкая (буквы, цифры, дефис, от шести знаков),
 * потому что резолв всё равно сверяет значение с карточкой (Р9) — лишний кандидат там отсеется, а
 * пропущенный не появится ниоткуда.
 */
export const SERIAL_LABELS = [
  'серийный номер',
  'серийный №',
  'заводской номер',
  'serial number',
  'serial no',
  'serial',
  's/n',
  'sn',
] as const;

export const INVENTORY_LABELS = [
  'инвентарный номер',
  'инвентарный №',
  'инв. номер',
  'asset number',
  'asset tag',
  'inventory number',
] as const;

export const DEVICE_NAME_LABELS = [
  'имя устройства',
  'название аппарата',
  'device name',
  'printer name',
  'system name',
] as const;

export const HOST_LABELS = ['сетевое имя', 'имя узла', 'host name', 'hostname', 'host'] as const;

export const MODEL_LABELS = [
  'модель',
  'модель аппарата',
  'model name',
  'model',
  'product name',
] as const;

export const IP_LABELS = [
  'ip-адрес',
  'ip адрес',
  'адрес',
  'ip address',
  'ipv4 address',
  'ip',
] as const;

const SERIAL_PATTERN = /\b(?=[A-Z0-9-]{6,})(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9-]{5,29}\b/u;
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/u;

/** Значение по метке, а если метки нет — по шаблону в теме и первых строках письма. */
export function findSerial(ctx: DeviceMailContext): string | null {
  const labeled = findLabeledValue(ctx, SERIAL_LABELS);
  if (labeled) return labeled;
  const haystack = [ctx.subject, ...textLines(ctx).slice(0, 20)].join('\n');
  const matched = SERIAL_PATTERN.exec(haystack);
  return matched ? matched[0] : null;
}

/**
 * IP письма. Опознанием он не является **никогда** (Р9: после DHCP по старому адресу стоит другой
 * принтер) — это подсказка человеку в очереди, и ровно поэтому она вычитывается без метки тоже.
 */
export function findIpAddress(ctx: DeviceMailContext): string | null {
  const labeled = findLabeledValue(ctx, IP_LABELS);
  if (labeled) {
    const inLabel = IPV4_PATTERN.exec(labeled);
    if (inLabel) return inLabel[0];
  }
  const haystack = [ctx.subject, ctx.text, ...ctx.attachments.map((a) => a.text)].join('\n');
  const matched = IPV4_PATTERN.exec(haystack);
  return matched ? matched[0] : null;
}

/** Есть ли в письме строка, начинающаяся с одной из меток (признак формата для `detect`). */
export function hasLabel(ctx: DeviceMailContext, labels: readonly string[]): boolean {
  if (textLines(ctx).some((line) => labelStarts(line, labels))) return true;
  return allTables(ctx).some((table) =>
    table.some((row) => row.some((cell) => labelMatches(cell, labels))),
  );
}
