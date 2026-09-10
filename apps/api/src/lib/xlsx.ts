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

/**
 * Ячейка листа. Строка — как было: текст с форматом «Текстовый». Число и дата пришли с
 * административной книгой показаний (план `readings-admin-export-plan.md`, Р4): по текстовым
 * ячейкам не считает ни формула, ни сводная таблица, а «1 234,5», набранное строкой, не станет
 * числом и после ручного переформатирования колонки.
 *
 * Прочерк неизвестного значения остаётся **строкой** и в числовой колонке: пустая ячейка сводную
 * не искажает, а ноль исказил бы. Поэтому тип ячейки решает вызывающий, а не колонка.
 */
export type CellInput =
  string | { readonly num: number; readonly digits?: 0 | 1 } | { readonly date: string };

/** Заливка строки. Зелёная — «нареканий нет», серая — заголовок группы. */
export type RowFill = 'green' | 'grey';

export interface RowStyle {
  fill?: RowFill;
  bold?: boolean;
}

export interface SheetInput {
  /** Имя листа как его увидит человек. */
  name: string;
  /** Строки, включая шапку. Всё уже приведено к ячейкам вызывающим. */
  rows: CellInput[][];
  /** Ширины колонок в символах; короче массива строк — остальные по умолчанию. */
  widths?: number[];
  /** Закрепить первую строку и повесить на неё автофильтр. */
  freezeHeader?: boolean;
  /**
   * Строка шапки, если она не первая (1-based): книга с заголовком и периодом над таблицей.
   * Шапка рисуется жирным, закрепляется вместе со всем, что над ней, и несёт автофильтр —
   * если он не отключён (`autoFilter: false`): на листе с группами фильтр поймал бы заголовки
   * групп и строки итогов и перемешал бы их с данными.
   */
  headerRow?: number;
  autoFilter?: boolean;
  /** Стиль отдельных строк: заливка и жирность. Индекс — номер строки от нуля. */
  rowStyles?: (RowStyle | undefined)[];
  /** Слитые ячейки: `A4:O4`. Заголовок группы читается строкой, а не первой колонкой. */
  merges?: readonly string[];
  /** Уровень группировки строки (0 — не сгруппирована): смены машины сворачиваются кнопкой. */
  outline?: number[];
  /** Лист-источник сводной таблицы человеку не нужен — он скрыт. */
  hidden?: boolean;
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

function rowWidth(rows: readonly CellInput[][]): number {
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

// ── Стили ──

/**
 * Вид ячейки: чем она набрана. Текст — прежний формат «Текстовый» (см. `STYLES_XML`), число и
 * дата — свои форматы, без которых Excel показал бы дату числом 46 234, а число — как получится.
 */
const CELL_KINDS = ['text', 'int', 'dec', 'date'] as const;
type CellKind = (typeof CELL_KINDS)[number];

/** Вид строки: сочетание заливки и жирности. Порядок задаёт номера стилей и меняться не должен. */
const ROW_KINDS = ['plain', 'bold', 'green', 'greenBold', 'grey', 'greyBold'] as const;
type RowKind = (typeof ROW_KINDS)[number];

/**
 * Первые три записи `cellXfs` — те же, что были до чисел и заливок: общий, текст и текст жирным.
 * Обычная текстовая ячейка берёт их и сегодня, поэтому книга без чисел и заливок собирается
 * байт в байт такой же, какой собиралась прежде, — а «одинаковая выгрузка даёт одинаковые байты»
 * тут не украшение: повторная выдача того же справочника не должна выглядеть другим файлом.
 *
 * Всё остальное считается по таблице `ROW_KINDS × CELL_KINDS`, начиная с третьего номера.
 */
const STYLE_BASE = 3;

function styleIndex(kind: CellKind, row: RowKind): number {
  if (kind === 'text' && row === 'plain') return 1;
  if (kind === 'text' && row === 'bold') return 2;
  return STYLE_BASE + ROW_KINDS.indexOf(row) * CELL_KINDS.length + CELL_KINDS.indexOf(kind);
}

function rowKindOf(style: RowStyle | undefined, header: boolean): RowKind {
  const bold = header || style?.bold === true;
  if (style?.fill === 'green') return bold ? 'greenBold' : 'green';
  if (style?.fill === 'grey') return bold ? 'greyBold' : 'grey';
  return bold ? 'bold' : 'plain';
}

/**
 * День в ячейке-дате — числом дней от 1 января 1900 года, как их считает Excel. Двойка в поправке
 * не описка: в его календаре есть несуществующее 29 февраля 1900 года, и все даты после него
 * сдвинуты на день. Сдвиг общий для Excel, LibreOffice и отечественных редакторов — он часть
 * формата, а не ошибка одного из них.
 */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function excelSerial(date: string): number | null {
  const parsed = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.round((parsed - EXCEL_EPOCH) / 86_400_000);
}

/** Число в XML — с точкой, независимо от того, какой разделитель показывает редактор. */
function numberXml(value: number, digits: 0 | 1): string {
  return value.toFixed(digits);
}

function cellXml(value: CellInput, ref: string, row: RowKind): string {
  if (typeof value === 'string') {
    // Пустая ячейка не пишется вовсе: разрежённая строка — это меньше байт и ровно тот же
    // лист. Координата остальных проставляется явно, поэтому пропуск ничего не сдвигает.
    if (value === '') return '';
    const text = escapeXml(sanitizeText(value));
    return `<c r="${ref}" s="${styleIndex('text', row)}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
  }
  if ('num' in value) {
    if (!Number.isFinite(value.num)) return '';
    const digits = value.digits ?? 0;
    return `<c r="${ref}" s="${styleIndex(digits === 0 ? 'int' : 'dec', row)}"><v>${numberXml(value.num, digits)}</v></c>`;
  }
  const serial = excelSerial(value.date);
  if (serial === null) return '';
  return `<c r="${ref}" s="${styleIndex('date', row)}"><v>${serial}</v></c>`;
}

function sheetXml(sheet: SheetInput): string {
  const width = rowWidth(sheet.rows);
  const headerRow = sheet.headerRow ?? (sheet.freezeHeader === true ? 1 : 0);
  const hasHeader = headerRow > 0 && sheet.rows.length > 0 && width > 0;
  const filter = hasHeader && sheet.autoFilter !== false;
  const outline = sheet.outline ?? [];
  const grouped = outline.some((level) => level > 0);
  const parts = [XML_HEAD, `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];

  // Порядок частей листа задан схемой и произволу не подлежит: `sheetPr`, `dimension`,
  // `sheetViews`, `cols`, `sheetData`, `autoFilter`, `mergeCells`.
  if (grouped) parts.push('<sheetPr><outlinePr summaryBelow="1"/></sheetPr>');
  if (width > 0 && sheet.rows.length > 0) {
    parts.push(`<dimension ref="A1:${columnName(width)}${sheet.rows.length}"/>`);
  }
  if (hasHeader) {
    parts.push(
      '<sheetViews><sheetView workbookViewId="0">' +
        `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
        '</sheetView></sheetViews>',
    );
  }
  parts.push(colsXml(sheet.widths), '<sheetData>');

  sheet.rows.forEach((row, rowIndex) => {
    const kind = rowKindOf(sheet.rowStyles?.[rowIndex], hasHeader && rowIndex === headerRow - 1);
    const cells = row
      .map((value, columnIndex) =>
        cellXml(value, `${columnName(columnIndex + 1)}${rowIndex + 1}`, kind),
      )
      .join('');
    const level = outline[rowIndex] ?? 0;
    const attrs = `r="${rowIndex + 1}"${level > 0 ? ` outlineLevel="${level}"` : ''}`;
    parts.push(cells === '' ? `<row ${attrs}/>` : `<row ${attrs}>${cells}</row>`);
  });

  parts.push('</sheetData>');
  if (filter) {
    parts.push(`<autoFilter ref="A${headerRow}:${columnName(width)}${headerRow}"/>`);
  }
  if (sheet.merges && sheet.merges.length > 0) {
    const merges = sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('');
    parts.push(`<mergeCells count="${sheet.merges.length}">${merges}</mergeCells>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * Стили книги.
 *
 * Числовой формат «@» (встроенный `numFmtId="49"`, Текстовый) стоит на каждой текстовой ячейке не
 * для красоты: без него Excel при первом же пересохранении приводит содержимое к числу — табельный
 * номер `007` теряет нули, а СНИЛС `11111111145` превращается в `1,1111E+10`. Обратно такой файл
 * уже не разобрать.
 *
 * Числовые и датовые форматы — свои (164–166), а не встроенные: встроенный формат даты (`14`)
 * зависит от языка системы и показывает американский порядок `9/10/2026` там, где в портале
 * стоит `10.09.2026`.
 *
 * Зелёная заливка — `C6EFCE` с текстом `006100`, те самые цвета, которыми Excel красит стиль
 * «Хорошо»: книгу читают рядом с его собственными таблицами, и свой оттенок зелёного читался бы
 * как другая пометка.
 */
const NUM_FMTS =
  '<numFmts count="3">' +
  '<numFmt numFmtId="164" formatCode="DD.MM.YYYY"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0"/>' +
  '<numFmt numFmtId="166" formatCode="#,##0.0"/>' +
  '</numFmts>';

const KIND_FMT: Record<CellKind, number> = { text: 49, int: 165, dec: 166, date: 164 };
const ROW_FONT: Record<RowKind, number> = {
  plain: 0,
  bold: 1,
  green: 2,
  greenBold: 3,
  grey: 0,
  greyBold: 1,
};
const ROW_FILL: Record<RowKind, number> = {
  plain: 0,
  bold: 0,
  green: 2,
  greenBold: 2,
  grey: 3,
  greyBold: 3,
};

function cellXfsXml(): string {
  const base = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
    '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>',
  ];
  const rest = ROW_KINDS.flatMap((row) =>
    CELL_KINDS.map(
      (kind) =>
        `<xf numFmtId="${KIND_FMT[kind]}" fontId="${ROW_FONT[row]}" fillId="${ROW_FILL[row]}" borderId="0" xfId="0"` +
        ' applyNumberFormat="1" applyFont="1" applyFill="1"/>',
    ),
  );
  const all = [...base, ...rest];
  return `<cellXfs count="${all.length}">${all.join('')}</cellXfs>`;
}

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  NUM_FMTS +
  '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><color rgb="FF006100"/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><color rgb="FF006100"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  // Второй заливкой обязан быть gray125: Excel считает книгу без него повреждённой.
  '<fills count="4"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  cellXfsXml() +
  '</styleSheet>';

// ── Сводная таблица ──

/**
 * Сводная таблица книги (`docs/readings-admin-export-plan.md`, §3.3).
 *
 * Собирается она здесь, а не библиотекой: от SheetJS в этом файле отказались осознанно, а из всего
 * богатства формата книге нужна ровно одна сводная одного вида — «строки, колонки, три значения».
 *
 * Источник — обычный лист книги: его строки уже собраны, и кэш пишется по ним. Второго набора
 * данных для сводной не передаётся — разойдись он с листом, сводная считала бы не то, что видно.
 *
 * Записи кэша пишутся **полностью**, а не заглушкой с одним `refreshOnLoad`: с пустым кэшем
 * сводная оживает только в Excel, который пересчитывает её при открытии, а LibreOffice и
 * отечественные редакторы показали бы пустой лист. `refreshOnLoad` при этом стоит тоже — как
 * подстраховка для Excel, чтобы он пересобрал разметку по своим правилам.
 */
export interface PivotValue {
  /** Имя колонки-источника, по которой считается значение. */
  field: string;
  /** Как значение подписано в сводной. */
  label: string;
  digits?: 0 | 1;
}

export interface PivotInput {
  /** Лист, на котором рисуется сводная: он должен быть среди листов книги. */
  sheet: string;
  /** Лист-источник: его первая строка — шапка полей, остальные — записи. */
  source: string;
  /** Поле строк и поле колонок — имена колонок источника. */
  rowField: string;
  columnField: string;
  values: readonly PivotValue[];
  /**
   * Вычисляемые поля сводной: `имя` и формула по именам полей источника. Считаются они по суммам
   * (отношение сумм, а не среднее из отношений), поэтому «л/100 км» живёт здесь, а не колонкой
   * листа: колонка дала бы среднее по сменам, завышенное на всяком коротком выезде.
   */
  calculated?: readonly { name: string; formula: string }[];
  /** Строка, с которой начинается сводная на листе (1-based). */
  startRow: number;
}

const CT_PIVOT_CACHE_DEF =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';
const CT_PIVOT_CACHE_RECORDS =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml';
const CT_PIVOT_TABLE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';

/** Текст ячейки источника: числовая ячейка в кэше остаётся числом, всё прочее — строкой. */
function cacheValue(cell: CellInput | undefined): number | string | null {
  if (cell === undefined || cell === '') return null;
  if (typeof cell === 'string') return cell;
  if ('num' in cell) return Number.isFinite(cell.num) ? cell.num : null;
  return cell.date;
}

interface CacheField {
  name: string;
  numeric: boolean;
  /** Значения-словарь для строкового поля: индекс в нём и стоит в записях. */
  items: string[];
}

function buildCacheFields(
  header: readonly CellInput[],
  body: readonly CellInput[][],
): CacheField[] {
  return header.map((title, column) => {
    const values = body.map((row) => cacheValue(row[column]));
    const numeric =
      values.some((value) => typeof value === 'number') &&
      !values.some((value) => typeof value === 'string');
    const items: string[] = [];
    if (!numeric) {
      for (const value of values) {
        const text = value === null ? '' : String(value);
        if (!items.includes(text)) items.push(text);
      }
    }
    return { name: typeof title === 'string' ? title : '', numeric, items };
  });
}

function cacheDefinitionXml(
  fields: readonly CacheField[],
  body: readonly CellInput[][],
  pivot: PivotInput,
  sourceTitle: string,
  sourceRef: string,
): string {
  const dataFields = fields
    .map((field) => {
      if (field.numeric) {
        return (
          `<cacheField name="${escapeXml(field.name)}" numFmtId="0">` +
          '<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"/>' +
          '</cacheField>'
        );
      }
      const items = field.items
        .map((item) => (item === '' ? '<m/>' : `<s v="${escapeXml(item)}"/>`))
        .join('');
      return (
        `<cacheField name="${escapeXml(field.name)}" numFmtId="0">` +
        `<sharedItems count="${field.items.length}">${items}</sharedItems>` +
        '</cacheField>'
      );
    })
    .join('');
  // Вычисляемые поля идут последними и записей не имеют: их считает редактор по формуле.
  const calculated = (pivot.calculated ?? [])
    .map(
      (field) =>
        `<cacheField name="${escapeXml(field.name)}" numFmtId="0" formula="${escapeXml(field.formula)}" databaseField="0">` +
        '<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"/>' +
        '</cacheField>',
    )
    .join('');
  const count = fields.length + (pivot.calculated?.length ?? 0);
  return (
    `${XML_HEAD}<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" r:id="rId1"` +
    ` refreshOnLoad="1" refreshedVersion="3" createdVersion="3" minRefreshableVersion="3"` +
    ` recordCount="${body.length}">` +
    `<cacheSource type="worksheet"><worksheetSource ref="${sourceRef}" sheet="${escapeXml(sourceTitle)}"/></cacheSource>` +
    `<cacheFields count="${count}">${dataFields}${calculated}</cacheFields>` +
    '</pivotCacheDefinition>'
  );
}

function cacheRecordsXml(fields: readonly CacheField[], body: readonly CellInput[][]): string {
  const rows = body
    .map((row) => {
      const cells = fields
        .map((field, column) => {
          const value = cacheValue(row[column]);
          if (field.numeric) {
            return typeof value === 'number' ? `<n v="${value}"/>` : '<m/>';
          }
          const index = field.items.indexOf(value === null ? '' : String(value));
          return `<x v="${index < 0 ? 0 : index}"/>`;
        })
        .join('');
      return `<r>${cells}</r>`;
    })
    .join('');
  return (
    `${XML_HEAD}<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" count="${body.length}">` +
    `${rows}</pivotCacheRecords>`
  );
}

/**
 * Разметка самой таблицы: машина по строкам, месяц по колонкам, значения под машиной.
 *
 * Значения стоят по строкам (`dataOnRows`), а не по колонкам, — так их читают в макете: под именем
 * машины три подписанные строки. Разложи их по колонкам, и шапка месяца утроилась бы.
 */
function pivotTableXml(
  fields: readonly CacheField[],
  pivot: PivotInput,
  rowFieldIndex: number,
  columnFieldIndex: number,
): string {
  const rowItems = fields[rowFieldIndex]?.items ?? [];
  const columnItems = fields[columnFieldIndex]?.items ?? [];
  /*
   * Строк под машиной столько, сколько значений **всего** — вместе с вычисляемыми: они такие же
   * строки таблицы, как суммы, и не учти мы их здесь, разметка обещала бы редактору три строки
   * там, где значений четыре.
   */
  const values = [
    ...pivot.values,
    ...(pivot.calculated ?? []).map((field) => ({ field: field.name, label: field.name })),
  ];

  const pivotFields = fields
    .map((field, index) => {
      if (index === rowFieldIndex || index === columnFieldIndex) {
        const axis = index === rowFieldIndex ? 'axisRow' : 'axisCol';
        const items =
          field.items.map((_, itemIndex) => `<item x="${itemIndex}"/>`).join('') +
          '<item t="default"/>';
        return (
          `<pivotField axis="${axis}" showAll="0">` +
          `<items count="${field.items.length + 1}">${items}</items></pivotField>`
        );
      }
      const isValue = values.some((value) => value.field === field.name);
      return isValue ? '<pivotField dataField="1" showAll="0"/>' : '<pivotField showAll="0"/>';
    })
    .join('');
  const calculatedFields = (pivot.calculated ?? [])
    .map(() => '<pivotField dataField="1" showAll="0"/>')
    .join('');

  // Строки: имя машины, под ним — по строке на каждое значение; в конце общий итог теми же
  // строками. `r` — сколько уровней строки повторяют предыдущую, `i` — номер значения.
  const rows = rowItems
    .map(
      (_, index) =>
        `<i><x v="${index}"/></i>` +
        values
          .map((_value, valueIndex) =>
            valueIndex === 0 ? '' : `<i r="1" i="${valueIndex}"><x v="${valueIndex}"/></i>`,
          )
          .join(''),
    )
    .join('');
  const grandRows =
    '<i t="grand"><x/></i>' +
    values
      .map((_value, valueIndex) =>
        valueIndex === 0 ? '' : `<i t="grand" r="1" i="${valueIndex}"><x v="${valueIndex}"/></i>`,
      )
      .join('');
  const rowItemCount = rowItems.length * values.length + values.length;

  const colItems =
    columnItems.map((_, index) => `<i><x v="${index}"/></i>`).join('') + '<i t="grand"><x/></i>';

  const width = 1 + (columnItems.length + 1) * 1;
  const height = 1 + rowItemCount;
  const ref = `A${pivot.startRow}:${columnName(width)}${pivot.startRow + height}`;

  const dataFields = values
    .map((value, index) => {
      // Вычисляемые поля стоят в кэше после полей источника — в том же порядке, в каком заданы.
      const field =
        index < pivot.values.length
          ? fields.findIndex((f) => f.name === value.field)
          : fields.length + (index - pivot.values.length);
      return `<dataField name="${escapeXml(value.label)}" fld="${field}" baseField="0" baseItem="0"/>`;
    })
    .join('');

  return (
    `${XML_HEAD}<pivotTableDefinition xmlns="${NS_MAIN}" name="СводнаяПоказания" cacheId="1"` +
    ' dataOnRows="1" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0"' +
    ' applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1"' +
    ' dataCaption="Значения" updatedVersion="3" minRefreshableVersion="3" createdVersion="3"' +
    ' indent="0" outline="1" outlineData="1" multipleFieldFilters="0">' +
    `<location ref="${ref}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>` +
    `<pivotFields count="${fields.length + (pivot.calculated?.length ?? 0)}">${pivotFields}${calculatedFields}</pivotFields>` +
    `<rowFields count="2"><field x="${rowFieldIndex}"/><field x="-2"/></rowFields>` +
    `<rowItems count="${rowItemCount}">${rows}${grandRows}</rowItems>` +
    `<colFields count="1"><field x="${columnFieldIndex}"/></colFields>` +
    `<colItems count="${columnItems.length + 1}">${colItems}</colItems>` +
    `<dataFields count="${values.length}">${dataFields}</dataFields>` +
    '</pivotTableDefinition>'
  );
}

interface PivotParts {
  files: Record<string, Uint8Array>;
  /** Номер листа (1-based) со сводной: ему нужна своя связь с частью таблицы. */
  sheetIndex: number;
  contentTypes: string;
}

/** Части книги, которых требует сводная. `null` — сводной в книге нет либо источник пуст. */
function pivotParts(
  pivot: PivotInput | undefined,
  sheets: readonly SheetInput[],
  titles: readonly string[],
): PivotParts | null {
  if (!pivot) return null;
  const sourceIndex = sheets.findIndex((sheet) => sheet.name === pivot.source);
  const sheetIndex = sheets.findIndex((sheet) => sheet.name === pivot.sheet);
  if (sourceIndex < 0 || sheetIndex < 0) return null;

  const source = sheets[sourceIndex]!;
  const [header, ...body] = source.rows;
  if (header === undefined || body.length === 0) return null;

  const fields = buildCacheFields(header, body);
  const rowFieldIndex = fields.findIndex((field) => field.name === pivot.rowField);
  const columnFieldIndex = fields.findIndex((field) => field.name === pivot.columnField);
  if (rowFieldIndex < 0 || columnFieldIndex < 0) return null;

  const sourceRef = `A1:${columnName(header.length)}${body.length + 1}`;
  const files: Record<string, Uint8Array> = {
    'xl/pivotCache/pivotCacheDefinition1.xml': encoder.encode(
      cacheDefinitionXml(fields, body, pivot, titles[sourceIndex] ?? pivot.source, sourceRef),
    ),
    'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels': encoder.encode(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/pivotCacheRecords" Target="pivotCacheRecords1.xml"/>` +
        '</Relationships>',
    ),
    'xl/pivotCache/pivotCacheRecords1.xml': encoder.encode(cacheRecordsXml(fields, body)),
    'xl/pivotTables/pivotTable1.xml': encoder.encode(
      pivotTableXml(fields, pivot, rowFieldIndex, columnFieldIndex),
    ),
    [`xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`]: encoder.encode(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/pivotTable" Target="../pivotTables/pivotTable1.xml"/>` +
        '</Relationships>',
    ),
  };

  const contentTypes =
    `<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="${CT_PIVOT_CACHE_DEF}"/>` +
    `<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="${CT_PIVOT_CACHE_RECORDS}"/>` +
    `<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="${CT_PIVOT_TABLE}"/>`;

  return { files, sheetIndex: sheetIndex + 1, contentTypes };
}

function workbookXml(
  titles: string[],
  sheets_: readonly SheetInput[],
  pivotRelId: number | null,
): string {
  const sheets = titles
    .map(
      (title, index) =>
        `<sheet name="${escapeXml(title)}" sheetId="${index + 1}"` +
        `${sheets_[index]?.hidden === true ? ' state="hidden"' : ''} r:id="rId${index + 1}"/>`,
    )
    .join('');
  // Связь кэша идёт последней в списке связей книги — после листов и стилей.
  const caches =
    pivotRelId === null
      ? ''
      : `<pivotCaches><pivotCache cacheId="1" r:id="rId${pivotRelId}"/></pivotCaches>`;
  return `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets}</sheets>${caches}</workbook>`;
}

function workbookRelsXml(count: number, withPivot: boolean): string {
  const sheets = Array.from(
    { length: count },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  const styles = `<Relationship Id="rId${count + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`;
  const cache = withPivot
    ? `<Relationship Id="rId${count + 2}" Type="${NS_REL}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>`
    : '';
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheets}${styles}${cache}</Relationships>`;
}

function contentTypesXml(count: number, pivotTypes: string): string {
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
    `${sheets}${pivotTypes}</Types>`
  );
}

/** Книга целиком в байтах. */
export function writeWorkbook(sheets: SheetInput[], pivot?: PivotInput): Uint8Array {
  // Книгу без единого листа Excel открыть отказывается, поэтому пустой ввод даёт пустой лист, а
  // не заведомо битый файл: выгрузка справочника, в котором нечего выгружать, — обычное дело.
  const input = sheets.length > 0 ? sheets : [{ name: 'Лист1', rows: [] }];
  const titles = sheetTitles(input);

  const parts = pivotParts(pivot, input, titles);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encoder.encode(contentTypesXml(input.length, parts?.contentTypes ?? '')),
    '_rels/.rels': encoder.encode(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ),
    'xl/workbook.xml': encoder.encode(
      workbookXml(titles, input, parts === null ? null : input.length + 2),
    ),
    'xl/_rels/workbook.xml.rels': encoder.encode(workbookRelsXml(input.length, parts !== null)),
    'xl/styles.xml': encoder.encode(STYLES_XML),
  };
  input.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = encoder.encode(sheetXml(sheet));
  });
  if (parts !== null) Object.assign(files, parts.files);

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
