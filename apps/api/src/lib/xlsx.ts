import { unzipSync, zipSync } from 'fflate';

/**
 * Чтение и запись книг .xlsx: обмен справочниками через редактор таблиц.
 *
 * Уровень намеренно низкий — «книга ↔ массив строк текста», без знания о справочниках. Формат
 * разбирается как zip с XML внутри, тем же приёмом, что и подстановка в бланк
 * (`services/office-template.ts`), и по той же причине: из книги нужен текст ячеек, а не объектная
 * модель. Библиотека уровня SheetJS тянет за собой формулы, диаграммы и сводные таблицы — всё то,
 * чего в справочнике не бывает, зато прибавляет мегабайты кода и зависимость на пути, по которому
 * в портал попадают данные извне.
 *
 * Всё, что приходит из файла, считается набранным человеком: он вправе оставить ячейку пустой,
 * набрать дату ячейкой-датой, дописать лист и прислать вместо книги фотографию. Поэтому разбор
 * нигде не падает на TypeError — только `XlsxError` с текстом, который показывают загрузившему.
 */

/** Файл не разобран: не zip, не книга, лист пуст. Свой класс — «прислали не тот файл» отличается от «сервер сломался». */
export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/** Нижняя граница времени, которое умеет хранить zip: 1 января 1980 года. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1);

/**
 * Потолки разбора. Книга приходит из портала, и «архивная бомба» — распакованный на гигабайты
 * лист из одной ячейки `XFD1048576` — обязана упереться в отказ, а не в память процесса.
 */
const MAX_CELLS = 500_000;
const MAX_UNPACKED = 64 * 1024 * 1024;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const CT_BOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CT_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const CT_STYLES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const CT_RELS = 'application/vnd.openxmlformats-package.relationships+xml';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * XML-экранирование. Без него апостроф в фамилии («О'Коннор») или амперсанд в наименовании
 * организации («Иванов & Ко») ломают не значение, а весь документ: редактор объявляет файл
 * повреждённым и не открывает его вовсе.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * Управляющие символы XML не допускает вовсе, и Excel считает такой файл повреждённым. Табуляция,
 * перевод строки и возврат каретки — законные: перенос внутри ячейки набирают руками. Класс
 * задан отрицанием категории Unicode: перечислять коды в регулярке линтер справедливо
 * считает опечаткой, а промах в диапазоне здесь тихо режет живой текст.
 */
const CONTROL_CHARS = /[^\P{Cc}\t\n\r]/gu;

function sanitizeText(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

/**
 * Имя колонки по её номеру: 1 → `A`, 27 → `AA`, 703 → `AAA`. Это не 26-ричная система — разряда
 * «ноль» в ней нет, поэтому единица вычитается на каждом шаге.
 */
function columnName(index: number): string {
  let rest = index;
  let name = '';
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

export interface SheetInput {
  /** Имя листа как его увидит человек. */
  name: string;
  /** Строки, включая шапку. Всё уже приведено к тексту вызывающим. */
  rows: string[][];
  /** Ширины колонок в символах; короче массива строк — остальные по умолчанию. */
  widths?: number[];
  /** Закрепить первую строку и повесить на неё автофильтр. */
  freezeHeader?: boolean;
}

/** Excel запрещает в имени листа `: \ / ? * [ ]` и длину больше 31 знака. */
const FORBIDDEN_IN_TITLE = /[:\\/?*[\]]/gu;

/**
 * Имя листа приводится к тому, что примет Excel, а не отвергается: имя приходит из справочника
 * («Транспорт: спецтехника»), и отказ выгрузить книгу из-за двоеточия в заголовке — не та цена.
 * Совпадения разводятся суффиксом: книгу с двумя одинаковыми именами листов Excel не открывает.
 */
function sheetTitles(sheets: SheetInput[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const clean = sanitizeText(sheet.name).replace(FORBIDDEN_IN_TITLE, ' ').trim().slice(0, 31);
    let title = clean.trim() || `Лист${index + 1}`;
    for (let attempt = 2; used.has(title.toLowerCase()); attempt += 1) {
      const suffix = ` (${attempt})`;
      title = title.slice(0, 31 - suffix.length).trim() + suffix;
    }
    used.add(title.toLowerCase());
    return title;
  });
}

function rowWidth(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function colsXml(widths: number[] | undefined): string {
  if (!widths || widths.length === 0) return '';
  const cols = widths
    .map((width, index) =>
      Number.isFinite(width) && width > 0
        ? `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
        : '',
    )
    .join('');
  return cols === '' ? '' : `<cols>${cols}</cols>`;
}

function sheetXml(sheet: SheetInput): string {
  const width = rowWidth(sheet.rows);
  const freeze = sheet.freezeHeader === true && sheet.rows.length > 0 && width > 0;
  const parts = [XML_HEAD, `<worksheet xmlns="${NS_MAIN}">`];

  if (width > 0 && sheet.rows.length > 0) {
    parts.push(`<dimension ref="A1:${columnName(width)}${sheet.rows.length}"/>`);
  }
  if (freeze) {
    parts.push(
      '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '</sheetView></sheetViews>',
    );
  }
  parts.push(colsXml(sheet.widths), '<sheetData>');

  sheet.rows.forEach((row, rowIndex) => {
    // Шапка — вторым стилем (жирным), тело — первым; оба с числовым форматом «Текстовый».
    const style = rowIndex === 0 ? 2 : 1;
    const cells = row
      .map((value, columnIndex) => {
        // Пустая ячейка не пишется вовсе: разрежённая строка — это меньше байт и ровно тот же
        // лист. Координата остальных проставляется явно, поэтому пропуск ничего не сдвигает.
        if (value === '') return '';
        const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
        const text = escapeXml(sanitizeText(value));
        return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
      })
      .join('');
    parts.push(
      cells === '' ? `<row r="${rowIndex + 1}"/>` : `<row r="${rowIndex + 1}">${cells}</row>`,
    );
  });

  parts.push('</sheetData>');
  if (freeze) parts.push(`<autoFilter ref="A1:${columnName(width)}1"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * Стили книги. Числовой формат «@» (встроенный `numFmtId="49"`, Текстовый) стоит на каждой
 * ячейке не для красоты: без него Excel при первом же пересохранении приводит содержимое к числу —
 * табельный номер `007` теряет нули, а СНИЛС `11111111145` превращается в `1,1111E+10`. Обратно
 * такой файл уже не разобрать.
 */
const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  // Второй заливкой обязан быть gray125: Excel считает книгу без него повреждённой.
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '</cellXfs></styleSheet>';

function workbookXml(titles: string[]): string {
  const sheets = titles
    .map(
      (title, index) =>
        `<sheet name="${escapeXml(title)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  return `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets}</sheets></workbook>`;
}

function workbookRelsXml(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  const styles = `<Relationship Id="rId${count + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`;
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheets}${styles}</Relationships>`;
}

function contentTypesXml(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${CT_SHEET}"/>`,
  ).join('');
  return (
    `${XML_HEAD}<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_BOOK}"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${CT_STYLES}"/>` +
    `${sheets}</Types>`
  );
}

/** Книга целиком в байтах. */
export function writeWorkbook(sheets: SheetInput[]): Uint8Array {
  // Книгу без единого листа Excel открыть отказывается, поэтому пустой ввод даёт пустой лист, а
  // не заведомо битый файл: выгрузка справочника, в котором нечего выгружать, — обычное дело.
  const input = sheets.length > 0 ? sheets : [{ name: 'Лист1', rows: [] }];
  const titles = sheetTitles(input);

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encoder.encode(contentTypesXml(input.length)),
    '_rels/.rels': encoder.encode(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ),
    'xl/workbook.xml': encoder.encode(workbookXml(titles)),
    'xl/_rels/workbook.xml.rels': encoder.encode(workbookRelsXml(input.length)),
    'xl/styles.xml': encoder.encode(STYLES_XML),
  };
  input.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = encoder.encode(sheetXml(sheet));
  });

  // Время фиксировано: одинаковая выгрузка обязана давать одинаковые байты, иначе повторная
  // выдача того же справочника выглядит как другой файл. Нижняя граница формата zip, а не эпоха
  // Unix: 1970 года он не знает вовсе.
  return zipSync(files, { mtime: ZIP_EPOCH });
}

export interface SheetOutput {
  name: string;
  /** Строки листа; ячейки — текстом, отсутствующие — пустой строкой. */
  rows: string[][];
}

const NOT_A_WORKBOOK = 'Файл не похож на книгу Excel (.xlsx).';
const TOO_LARGE = 'Файл слишком большой: в книге не должно быть больше 500 000 заполненных ячеек.';

const RELATIONSHIP = /<Relationship\b[^>]*\/?>/gu;
const SHEET_TAG = /<sheet\b[^>]*\/?>/gu;
const ROW_TAG = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu;
const CELL_TAG = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu;
const SI_TAG = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/gu;
const T_TAG = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/gu;
const VALUE_TAG = /<v\b[^>]*>([\s\S]*?)<\/v>/u;
const CELL_REF = /^([A-Z]+)([0-9]+)$/u;

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag)?.[1];
}

/** Ссылка на часть книги. Префикс пространства имён у неё не обязан быть `r`, поэтому он любой. */
function relationshipId(tag: string): string | undefined {
  return /\s(?:[A-Za-z0-9_.-]+:)?id\s*=\s*"([^"]*)"/u.exec(tag)?.[1];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1] === 'x' || code[1] === 'X';
      const point = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (!Number.isInteger(point) || point < 1 || point > 0x10ffff) return whole;
      return String.fromCodePoint(point);
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Распаковка. Разбираются только XML-части: картинки и объекты в книге справочника не нужны, а
 * распаковывать их значит впустить бомбу через часть, которую всё равно никто не прочитает.
 * Предел проверяется по объявленному размеру — до того, как часть развернётся в память.
 */
function unzipParts(bytes: Uint8Array): Record<string, Uint8Array> {
  let unpacked = 0;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        if (!/\.(?:xml|rels)$/iu.test(file.name)) return false;
        unpacked += file.originalSize;
        if (unpacked > MAX_UNPACKED) throw new XlsxError(TOO_LARGE);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError(NOT_A_WORKBOOK);
  }
}

function readPart(files: Record<string, Uint8Array>, name: string): string | undefined {
  const part = files[name];
  return part === undefined ? undefined : decoder.decode(part);
}

/** Путь части по ссылке из `.rels`: он относителен каталогу владельца, а начальный `/` — корню. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = baseDir === '' ? [] : baseDir.split('/');
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function relsPathOf(path: string): string {
  const dir = dirOf(path);
  const name = path.slice(dir === '' ? 0 : dir.length + 1);
  return dir === '' ? `_rels/${name}.rels` : `${dir}/_rels/${name}.rels`;
}

/** Куда ведёт корневая связь книги. Имя `xl/workbook.xml` — соглашение Excel, а не требование. */
function workbookPath(files: Record<string, Uint8Array>): string {
  const rels = readPart(files, '_rels/.rels');
  for (const match of rels?.matchAll(RELATIONSHIP) ?? []) {
    const type = attr(match[0], 'Type');
    const target = attr(match[0], 'Target');
    if (type?.endsWith('/officeDocument') === true && target !== undefined) {
      return resolveTarget('', unescapeXml(target));
    }
  }
  return 'xl/workbook.xml';
}

function relationTargets(xml: string | undefined, baseDir: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const match of xml?.matchAll(RELATIONSHIP) ?? []) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    // Внешняя ссылка ведёт за пределы книги — своей части в архиве у неё нет.
    if (id === undefined || target === undefined) continue;
    if (attr(match[0], 'TargetMode') === 'External') continue;
    targets.set(id, resolveTarget(baseDir, unescapeXml(target)));
  }
  return targets;
}

/** Текст элемента вместе с кусками форматированного текста (`<r><t>`), которыми Excel рвёт строку. */
function collectText(xml: string): string {
  // Фонетическая подсказка `<rPh>` — тоже `<t>`, и без вырезания она приклеивается к значению.
  const body = xml.includes('<rPh') ? xml.replace(/<rPh\b[\s\S]*?<\/rPh>/gu, '') : xml;
  let text = '';
  for (const match of body.matchAll(T_TAG)) text += unescapeXml(match[1] ?? '');
  return text;
}

function readSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const strings: string[] = [];
  for (const match of xml.matchAll(SI_TAG)) strings.push(collectText(match[1] ?? ''));
  return strings;
}

/** Встроенные форматы даты и времени (ECMA-376, 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55,
  56, 57, 58,
]);

/**
 * Пользовательский формат — дата, если в его коде есть год, день или месяц. Литералы в кавычках,
 * экранированные знаки и секции в квадратных скобках вырезаются: в `[Red]` тоже есть `d`, а в
 * `"мес."` — точка и текст, к формату отношения не имеющие.
 */
function isDateFormatCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  const bare = code
    .replace(/\\./gu, '')
    .replace(/"[^"]*"/gu, '')
    .replace(/\[[^\]]*\]/gu, '')
    .toLowerCase();
  if (/[yd]/u.test(bare)) return true;
  // `m` означает и месяц, и минуты. Рядом с часами или секундами это время (`ч:мм`), а не дата.
  return /m/u.test(bare) && !/[hs]/u.test(bare);
}

/** Номера стилей (`s=` у ячейки), которыми показывают дату. */
function readDateStyles(xml: string | undefined): Set<number> {
  const dateStyles = new Set<number>();
  if (xml === undefined) return dateStyles;

  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?>/gu)) {
    const id = Number(attr(match[0], 'numFmtId'));
    const code = attr(match[0], 'formatCode');
    if (Number.isInteger(id) && code !== undefined) custom.set(id, unescapeXml(code));
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(xml);
  if (cellXfs === null) return dateStyles;
  let index = 0;
  for (const match of (cellXfs[1] ?? '').matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/gu)) {
    const id = Number(attr(match[0], 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id) || isDateFormatCode(custom.get(id))) dateStyles.add(index);
    index += 1;
  }
  return dateStyles;
}

/**
 * Дата Excel — число дней от 30.12.1899. Смещение именно такое из-за ошибки Lotus 1-2-3,
 * унаследованной ради совместимости: 1900 год в книге високосный, поэтому serial 60 — это
 * несуществующее 29.02.1900, а всё, что до него, сдвинуто на сутки назад.
 */
function excelDate(raw: string): string | null {
  const serial = Number(raw);
  if (!Number.isFinite(serial) || serial < 1) return null;
  const whole = Math.floor(serial);
  const days = whole < 60 ? whole + 1 : whole;
  const at = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
  if (Number.isNaN(at.getTime())) return null;
  const day = String(at.getUTCDate()).padStart(2, '0');
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${at.getUTCFullYear()}`;
}

/**
 * Число текстом. `String` печатает экспонентой только за пределами 1e21, но справочник может
 * принести и такое: показывать человеку `1e+21` вместо номера нельзя ни при каких значениях.
 */
function formatNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw.trim();
  const text = String(value);
  if (!text.includes('e')) return text;
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

function cellText(tag: string, inner: string, shared: string[], dateStyles: Set<number>): string {
  const type = attr(tag, 't') ?? 'n';
  if (type === 'inlineStr') return collectText(inner);
  // Ячейка с ошибкой (`#Н/Д`, `#ДЕЛ/0!`) — это не значение, и подставлять её текст в справочник
  // нельзя: пустая ячейка честнее.
  if (type === 'e') return '';

  const raw = VALUE_TAG.exec(inner)?.[1];
  if (raw === undefined) return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  // `str` — вычисленное значение формулы, `b` — булево (`1`/`0`), `d` — дата по ISO 8601.
  if (type !== 'n') return unescapeXml(raw);

  const style = attr(tag, 's');
  if (style !== undefined && dateStyles.has(Number(style))) {
    const date = excelDate(raw);
    if (date !== null) return date;
  }
  return formatNumber(raw);
}

function columnOf(ref: string): number | null {
  const match = CELL_REF.exec(ref);
  if (match === null) return null;
  let column = 0;
  for (const letter of match[1] ?? '') column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

function rowOf(ref: string): number | null {
  const match = CELL_REF.exec(ref);
  return match === null ? null : Number(match[2]);
}

/**
 * Лист в виде плотной таблицы. Заполненные ячейки собираются разрежённо, и границы листа задают
 * именно они: Excel щедро оставляет хвост из пустых строк и колонок — стоит один раз проехаться
 * по листу мышью, и в файле появляются тысячи пустых `<row>`.
 */
function readSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
  budget: { cells: number },
): string[][] {
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/u.exec(xml);
  if (sheetData === null) return [];

  const filled = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxColumn = 0;
  let rowNumber = 0;

  for (const rowMatch of (sheetData[1] ?? '').matchAll(ROW_TAG)) {
    // Номер строки обычно объявлен, но не обязан быть: без него строки идут подряд.
    rowNumber = Number(attr(rowMatch[1] ?? '', 'r')) || rowNumber + 1;
    let columnNumber = 0;

    for (const cellMatch of (rowMatch[2] ?? '').matchAll(CELL_TAG)) {
      const tag = cellMatch[1] ?? '';
      const ref = attr(tag, 'r');
      columnNumber = (ref === undefined ? null : columnOf(ref)) ?? columnNumber + 1;
      const at = (ref === undefined ? null : rowOf(ref)) ?? rowNumber;

      budget.cells += 1;
      if (budget.cells > MAX_CELLS) throw new XlsxError(TOO_LARGE);

      const value = cellText(tag, cellMatch[2] ?? '', shared, dateStyles);
      if (value === '') continue;
      let line = filled.get(at);
      if (line === undefined) {
        line = new Map<number, string>();
        filled.set(at, line);
      }
      line.set(columnNumber, value);
      if (at > maxRow) maxRow = at;
      if (columnNumber > maxColumn) maxColumn = columnNumber;
    }
  }

  // Одна ячейка в `XFD1048576` задаёт лист на 17 миллиардов клеток — под него нельзя даже
  // выделять память, не то что отдавать его вызывающему.
  if (maxRow * maxColumn > MAX_CELLS) throw new XlsxError(TOO_LARGE);

  const rows: string[][] = [];
  for (let index = 1; index <= maxRow; index += 1) {
    const line = new Array<string>(maxColumn).fill('');
    for (const [column, value] of filled.get(index) ?? []) line[column - 1] = value;
    rows.push(line);
  }
  return rows;
}

/** Разбор книги. Порядок листов — как в книге. */
export function readWorkbook(bytes: Uint8Array): SheetOutput[] {
  const files = unzipParts(bytes);
  const bookPath = workbookPath(files);
  const bookXml = readPart(files, bookPath);
  if (bookXml === undefined || !bookXml.includes('<sheets')) throw new XlsxError(NOT_A_WORKBOOK);

  const bookDir = dirOf(bookPath);
  const targets = relationTargets(readPart(files, relsPathOf(bookPath)), bookDir);
  const shared = readSharedStrings(
    readPart(files, bookDir === '' ? 'sharedStrings.xml' : `${bookDir}/sharedStrings.xml`),
  );
  const dateStyles = readDateStyles(
    readPart(files, bookDir === '' ? 'styles.xml' : `${bookDir}/styles.xml`),
  );

  const budget = { cells: 0 };
  const sheets: SheetOutput[] = [];
  for (const match of bookXml.matchAll(SHEET_TAG)) {
    const id = relationshipId(match[0]);
    const path = id === undefined ? undefined : targets.get(id);
    const sheetPart = path === undefined ? undefined : readPart(files, path);
    // Лист, которому не нашлось части, пропускается: так книга с диаграммой на отдельном листе
    // читается целиком, а не отвергается вся.
    if (sheetPart === undefined) continue;
    sheets.push({
      name: unescapeXml(attr(match[0], 'name') ?? ''),
      rows: readSheet(sheetPart, shared, dateStyles, budget),
    });
  }

  if (sheets.length === 0) throw new XlsxError(NOT_A_WORKBOOK);
  return sheets;
}
