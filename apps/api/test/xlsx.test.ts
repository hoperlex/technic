import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readWorkbook, writeWorkbook, XlsxError } from '../src/lib/xlsx';

/**
 * Ядро обмена справочниками через Excel.
 *
 * Проверяется тестом, потому что по этому пути данные попадают в портал извне: администратор
 * выгружает справочник, правит его в редакторе таблиц и загружает обратно. Ошибка разбора здесь
 * не видна глазом — она молча меняет содержимое справочника, а «книга открылась» ещё ничего не
 * значит. Файлы редактора собираются в тесте руками: наш писатель проверять сам себя не может.
 */

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Перенос внутри ячейки набирают Alt+Enter, и он обязан пережить круг «выгрузил — загрузил». */
const MULTILINE = `первая строка
вторая строка`;

/**
 * Книга, собранная руками. Части названы не так, как называет их наш писатель: `книга.xml` вместо
 * `workbook.xml`, `листы/первый.xml` вместо `worksheets/sheet1.xml`, префикс `rel:` вместо `r:` —
 * всё это законно и встречается у чужих редакторов, а разбор обязан идти по связям, а не по
 * привычным именам.
 */
function handmadeBook(parts: { sheet: string; shared?: string; styles?: string }): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '_rels/.rels':
      strToU8(`<Relationships xmlns="${PKG_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument"
        Target="/xl/книга.xml"/></Relationships>`),
    'xl/книга.xml': strToU8(
      `<workbook xmlns="${MAIN_NS}" xmlns:rel="${REL_NS}">` +
        '<sheets><sheet name="Водители &amp; техника" sheetId="1" rel:id="rId9"/></sheets></workbook>',
    ),
    'xl/_rels/книга.xml.rels': strToU8(
      `<Relationships xmlns="${PKG_NS}"><Relationship Id="rId9" Type="${REL_NS}/worksheet" ` +
        'Target="листы/первый.xml"/></Relationships>',
    ),
    'xl/листы/первый.xml': strToU8(
      `<worksheet xmlns="${MAIN_NS}"><sheetData>${parts.sheet}</sheetData></worksheet>`,
    ),
  };
  if (parts.shared !== undefined) files['xl/sharedStrings.xml'] = strToU8(parts.shared);
  if (parts.styles !== undefined) files['xl/styles.xml'] = strToU8(parts.styles);
  return zipSync(files);
}

function firstSheetXml(book: Uint8Array): string {
  const part = unzipSync(book)['xl/worksheets/sheet1.xml'];
  return part === undefined ? '' : strFromU8(part);
}

describe('круг «выгрузил — загрузил»', () => {
  it('возвращает те же листы и те же строки', () => {
    const book = writeWorkbook([
      {
        name: 'Водители',
        rows: [
          ['ФИО', 'СНИЛС'],
          ['Иванов Иван', '11111111145'],
        ],
      },
      { name: 'Техника', rows: [['Марка'], ['КамАЗ']] },
    ]);

    expect(readWorkbook(book)).toEqual([
      {
        name: 'Водители',
        rows: [
          ['ФИО', 'СНИЛС'],
          ['Иванов Иван', '11111111145'],
        ],
      },
      { name: 'Техника', rows: [['Марка'], ['КамАЗ']] },
    ]);
  });

  it('кириллица, спецсимволы XML и перенос строки доходят без потерь', () => {
    const rows = [
      ['Наименование', 'Примечание'],
      ['Иванов & Ко', "О'Коннор <главный>"],
      ['ООО «Техника»', MULTILINE],
      [`кавычки " и апостроф '`, 'угловые < > вместе'],
    ];

    expect(readWorkbook(writeWorkbook([{ name: 'Ш', rows }]))[0]?.rows).toEqual(rows);
  });

  it('пустые ячейки в середине строки сохраняются, а хвостовые пустые строки и колонки уходят', () => {
    const book = writeWorkbook([
      {
        name: 'Справочник',
        rows: [
          ['А', 'Б', 'В', ''],
          ['', 'заполнено', '', ''],
          ['', '', '', ''],
        ],
      },
    ]);

    // Хвост из пустых ячеек и строк Excel оставляет щедро, и справочник не должен получать из
    // него пустые записи: границей листа считается последняя заполненная ячейка.
    expect(readWorkbook(book)[0]?.rows).toEqual([
      ['А', 'Б', 'В'],
      ['', 'заполнено', ''],
    ]);
  });

  it('колонки после 26-й нумерует буквами: 27-я — AA, 703-я — AAA', () => {
    const row = new Array<string>(703).fill('');
    row[0] = 'первая';
    row[26] = 'двадцать седьмая';
    row[702] = 'семьсот третья';

    const book = writeWorkbook([{ name: 'Широкий', rows: [row] }]);
    const xml = firstSheetXml(book);
    expect(xml).toContain('r="A1"');
    expect(xml).toContain('r="AA1"');
    expect(xml).toContain('r="AAA1"');

    const read = readWorkbook(book)[0]?.rows[0];
    expect(read?.length).toBe(703);
    expect(read?.[26]).toBe('двадцать седьмая');
    expect(read?.[702]).toBe('семьсот третья');
  });

  it('закрепляет шапку с автофильтром, ставит ширины и выделяет шапку', () => {
    const xml = firstSheetXml(
      writeWorkbook([
        {
          name: 'Водители',
          rows: [
            ['ФИО', 'СНИЛС'],
            ['Иванов', '11111111145'],
          ],
          widths: [40],
          freezeHeader: true,
        },
      ]),
    );

    expect(xml).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(xml).toContain('<autoFilter ref="A1:B1"/>');
    expect(xml).toContain('<col min="1" max="1" width="40" customWidth="1"/>');
    // Шапка — жирным стилем, тело — обычным; оба с форматом «Текстовый» (см. styles.xml).
    expect(xml).toContain('<c r="A1" s="2" t="inlineStr">');
    expect(xml).toContain('<c r="A2" s="1" t="inlineStr">');
  });

  it('имя листа подрезает и чистит вместо отказа выгрузить книгу', () => {
    const book = writeWorkbook([
      { name: 'Отчёт: 2026/07 [черновик] по всем подразделениям', rows: [['x']] },
    ]);

    const name = readWorkbook(book)[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).toBe('Отчёт  2026 07  черновик  по вс');
  });

  it('вырезает управляющие знаки: с ними редактор объявляет книгу повреждённой', () => {
    const bell = String.fromCharCode(7);
    const rows = [[`Иванов${bell}Иван`, `таб${String.fromCharCode(9)}остаётся`]];

    expect(readWorkbook(writeWorkbook([{ name: 'Ш', rows }]))[0]?.rows).toEqual([
      ['ИвановИван', `таб${String.fromCharCode(9)}остаётся`],
    ]);
  });

  it('одинаковая выгрузка даёт одинаковые байты: дата в zip фиксирована', () => {
    const sheets = [{ name: 'Лист', rows: [['а', 'б']] }];
    expect(writeWorkbook(sheets)).toEqual(writeWorkbook(sheets));
  });
});

describe('чтение книги из чужого редактора', () => {
  it('берёт значения из общей таблицы строк, включая куски форматированного текста', () => {
    const book = handmadeBook({
      shared:
        `<sst xmlns="${MAIN_NS}" count="3" uniqueCount="3">` +
        '<si><t>ФИО</t></si>' +
        '<si><r><t>Иванов </t></r><r><rPr><b/></rPr><t>Иван</t></r></si>' +
        '<si><t xml:space="preserve">Иванов &amp; сын</t></si></sst>',
      sheet:
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row>',
    });

    expect(readWorkbook(book)).toEqual([
      {
        name: 'Водители & техника',
        rows: [
          ['ФИО', ''],
          ['Иванов Иван', 'Иванов & сын'],
        ],
      },
    ]);
  });

  it('читает встроенную строку, значение формулы, булево и ошибку', () => {
    const book = handmadeBook({
      sheet:
        '<row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>встроенная</t></is></c>' +
        '<c r="B1" t="str"><f>CONCAT(A1)</f><v>вычислено</v></c>' +
        '<c r="C1" t="b"><v>1</v></c>' +
        '<c r="D1" t="e"><v>#N/A</v></c>' +
        '<c r="E1" t="inlineStr"><is><t>край</t></is></c>' +
        '</row>',
    });

    // Ошибка формулы — не значение: в справочник ей идти нечем, и пустая ячейка честнее.
    expect(readWorkbook(book)[0]?.rows).toEqual([['встроенная', 'вычислено', '1', '', 'край']]);
  });

  it('пропущенные ячейки строки становятся пустыми по своим координатам', () => {
    const book = handmadeBook({
      sheet:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>А</t></is></c></row><row r="3">' +
        '<c r="C3" t="inlineStr"><is><t>В</t></is></c></row>',
    });

    expect(readWorkbook(book)[0]?.rows).toEqual([
      ['А', '', ''],
      ['', '', ''],
      ['', '', 'В'],
    ]);
  });

  it('число остаётся числом, а не экспонентой и не «15.0»', () => {
    const book = handmadeBook({
      sheet:
        '<row r="1"><c r="A1"><v>15.0</v></c><c r="B1"><v>1875.5</v></c>' +
        '<c r="C1"><v>11111111145</v></c></row>',
    });

    // СНИЛС в экспоненте — не опечатка вывода, а потерянное значение: обратно его не собрать.
    expect(readWorkbook(book)[0]?.rows).toEqual([['15', '1875.5', '11111111145']]);
  });
});

/** Стили книги, набранной человеком: встроенный формат даты, пользовательский и обычное число. */
const DATE_STYLES =
  `<styleSheet xmlns="${MAIN_NS}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0.00 [$руб.-419]"/></numFmts>' +
  '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"><alignment horizontal="center"/></xf>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';

describe('ячейка-дата', () => {
  it('читается как «ДД.ММ.ГГГГ» и по встроенному формату, и по пользовательскому', () => {
    const book = handmadeBook({
      styles: DATE_STYLES,
      sheet: '<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="2"><v>45292.75</v></c></row>',
    });

    // Дробная часть — время суток: справочнику нужна дата, и час её не меняет.
    expect(readWorkbook(book)[0]?.rows).toEqual([['01.01.2024', '01.01.2024']]);
  });

  it('обходит несуществующее 29 февраля 1900 года', () => {
    const book = handmadeBook({
      styles: DATE_STYLES,
      sheet:
        '<row r="1"><c r="A1" s="1"><v>61</v></c><c r="B1" s="1"><v>59</v></c>' +
        '<c r="C1" s="1"><v>1</v></c></row>',
    });

    // Excel унаследовал от Lotus 1-2-3 високосный 1900 год: serial 60 не существует, и всё, что
    // до него, сдвинуто на сутки.
    expect(readWorkbook(book)[0]?.rows).toEqual([['01.03.1900', '28.02.1900', '01.01.1900']]);
  });

  it('денежный формат датой не считается', () => {
    const book = handmadeBook({
      styles: DATE_STYLES,
      sheet: '<row r="1"><c r="A1" s="3"><v>45292</v></c><c r="B1" s="0"><v>45292</v></c></row>',
    });

    expect(readWorkbook(book)[0]?.rows).toEqual([['45292', '45292']]);
  });
});

describe('отказ вместо падения', () => {
  it('мусорные байты — это не книга', () => {
    const garbage = new Uint8Array([0x50, 0x4b, 0x07, 0x08, 0x11, 0x22, 0x33, 0x44]);
    expect(() => readWorkbook(garbage)).toThrow(XlsxError);
    expect(() => readWorkbook(garbage)).toThrow(/книгу Excel/u);
  });

  it('пустой ввод — это не книга', () => {
    expect(() => readWorkbook(new Uint8Array())).toThrow(XlsxError);
  });

  it('zip без книги внутри — это не книга', () => {
    const zip = zipSync({ 'readme.xml': strToU8('<a>не книга</a>') });
    expect(() => readWorkbook(zip)).toThrow(XlsxError);
  });

  it('книга без единого листа с частью — это не книга', () => {
    const zip = zipSync({
      '_rels/.rels': strToU8(
        `<Relationships xmlns="${PKG_NS}"><Relationship Id="rId1" ` +
          `Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
          '<sheets><sheet name="Потеряшка" sheetId="1" r:id="rId7"/></sheets></workbook>',
      ),
    });

    expect(() => readWorkbook(zip)).toThrow(XlsxError);
  });

  it('лист размером во всю сетку Excel отвергается, а не съедает память', () => {
    const book = handmadeBook({
      sheet: '<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>край</t></is></c></row>',
    });

    // Одна ячейка в дальнем углу задаёт таблицу на 17 миллиардов клеток: разворачивать её нельзя.
    expect(() => readWorkbook(book)).toThrow(XlsxError);
  });
});
