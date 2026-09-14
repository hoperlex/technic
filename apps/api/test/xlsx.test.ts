import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ChartInput } from '../src/lib/xlsx';
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

  it('апостроф по краям имени листа снимается, в том числе открытый обрезкой', () => {
    const titles = readWorkbook(
      writeWorkbook([
        { name: "'Площадка «Юг»'", rows: [['x']] },
        // Тридцать первым знаком имени оказывается апостроф: край открывается обрезкой, и чистить
        // его надо после неё, а не только до.
        { name: `${'А'.repeat(30)}'Б`, rows: [['x']] },
        { name: " ' ' ", rows: [['x']] },
      ]),
    ).map((sheet) => sheet.name);

    // Имя, начинающееся или кончающееся апострофом, Excel не принимает вовсе: книга не
    // открывается, редактор предлагает восстановление.
    expect(titles[0]).toBe('Площадка «Юг»');
    expect(titles[1]).toBe('А'.repeat(30));
    // Имя из одних апострофов и пробелов — это отсутствие имени, и лист получает номерное.
    expect(titles[2]).toBe('Лист3');
  });

  it('«История» разводится как занятое имя: так зовётся служебный лист Excel', () => {
    const titles = readWorkbook(
      writeWorkbook([
        { name: 'История', rows: [['x']] },
        { name: 'History', rows: [['x']] },
        { name: 'история', rows: [['x']] },
      ]),
    ).map((sheet) => sheet.name);

    // Имя занято не соседним листом, а самим редактором, поэтому разводится тем же суффиксом.
    expect(titles).toEqual(['История (2)', 'History (2)', 'история (3)']);
  });

  it('третий одноимённый лист получает один суффикс, а не суффикс поверх суффикса', () => {
    const titles = readWorkbook(
      writeWorkbook([
        { name: 'Лист', rows: [['x']] },
        { name: 'Лист', rows: [['x']] },
        { name: 'Лист', rows: [['x']] },
      ]),
    ).map((sheet) => sheet.name);

    // «Лист (2) (3)» — номер попытки поверх номера попытки: суффикс наращивался от прошлого имени.
    expect(titles).toEqual(['Лист', 'Лист (2)', 'Лист (3)']);
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

/**
 * Числа, даты, заливка и сводная таблица (`docs/readings-admin-export-plan.md`, Р4).
 *
 * Всё это пришло со служебной книгой показаний, и проверять его надо здесь, на писателе: `readWorkbook`
 * отдаёт только текст ячеек, и «книга открылась» ничего не говорит ни про формат числа, ни про цвет
 * строки. Поэтому части разбираются как XML — глазами того же редактора, который их прочтёт.
 */
describe('писатель: числа, оформление и сводная', () => {
  const partOf = (bytes: Uint8Array, name: string): string =>
    strFromU8(unzipSync(bytes)[name] ?? new Uint8Array());

  it('число лежит числом, а не текстом', () => {
    const book = writeWorkbook([{ name: 'Лист', rows: [['Пробег'], [{ num: 3480 }]] }]);
    const sheet = partOf(book, 'xl/worksheets/sheet1.xml');

    // Числовая ячейка идёт без `t="inlineStr"` и со значением в `<v>`: только такую считает
    // формула и берёт в кэш сводная.
    expect(sheet).toContain('<v>3480</v>');
    expect(sheet).not.toContain('<is><t xml:space="preserve">3480</t></is>');
  });

  it('в ячейке лежит точное число, а разрядность задаёт только показ', () => {
    const book = writeWorkbook([
      {
        name: 'Деньги',
        rows: [['₽ факт'], [{ num: 1000.4 }], [{ num: 1000.4 }], [{ num: 2000.8 }]],
      },
    ]);
    const sheet = partOf(book, 'xl/worksheets/sheet1.xml');

    // Денежные колонки сводной аналитики объявлены с нулём знаков. Храни писатель показанное, обе
    // строки легли бы тысячами, а подытог — 2001: человек выделяет колонку в редакторе и получает
    // сумму, не равную напечатанному итогу, и какое из двух чисел верное, по книге не понять.
    expect(sheet).toContain('<v>1000.4</v>');
    expect(sheet).toContain('<v>2000.8</v>');
    // Округляет показ — формат ячейки; в стилях он свой на каждую разрядность.
    expect(partOf(book, 'xl/styles.xml')).toContain('formatCode="#,##0"');
  });

  it('разрядность не дописывает нулей к значению и не режет знаков сверх него', () => {
    const sheet = partOf(
      writeWorkbook([
        { name: 'Лист', rows: [[{ num: 300, digits: 1 }], [{ num: 198.75, digits: 1 }]] },
      ]),
      'xl/worksheets/sheet1.xml',
    );

    // `300,0` и `198,8` — это показ, а не содержимое: в файле лежит ровно то, что дал вызывающий.
    expect(sheet).toContain('<v>300</v>');
    expect(sheet).toContain('<v>198.75</v>');
  });

  it('число за пределами экспоненты пишется обычной записью', () => {
    const sheet = partOf(
      writeWorkbook([{ name: 'Лист', rows: [[{ num: 1e21 }], [{ num: 1e-7, digits: 1 }]] }]),
      'xl/worksheets/sheet1.xml',
    );

    // `1e+21` в значении ячейки понимают не все читалки, а писатель обязан быть понятным не
    // одному редактору.
    expect(sheet).toContain('<v>1000000000000000000000</v>');
    expect(sheet).toContain('<v>0.0000001</v>');
  });

  it('дата уезжает числом дней Excel и своим форматом', () => {
    const book = writeWorkbook([{ name: 'Лист', rows: [[{ date: '2026-08-29' }]] }]);

    // 29.08.2026 — 46 263-й день календаря Excel, в котором есть несуществующее 29.02.1900.
    expect(partOf(book, 'xl/worksheets/sheet1.xml')).toContain('<v>46263</v>');
    // Формат свой, а не встроенный: встроенный показывает дату по языку системы.
    expect(partOf(book, 'xl/styles.xml')).toContain('formatCode="DD.MM.YYYY"');
  });

  it('прочерк в числовой колонке остаётся текстом', () => {
    const book = writeWorkbook([{ name: 'Лист', rows: [['—']] }]);

    // Ноль вместо прочерка соврал бы про «стояла», а пустая ячейка сводную не искажает.
    expect(partOf(book, 'xl/worksheets/sheet1.xml')).toContain('—');
  });

  it('заливка строки, слитая ячейка и группировка доезжают до листа', () => {
    const book = writeWorkbook([
      {
        name: 'Лист',
        headerRow: 1,
        autoFilter: false,
        rows: [['Шапка'], ['Машина'], ['смена']],
        rowStyles: [undefined, { fill: 'green', bold: true }],
        merges: ['A2:C2'],
        outline: [0, 0, 1],
      },
    ]);
    const sheet = partOf(book, 'xl/worksheets/sheet1.xml');

    expect(sheet).toContain('<mergeCell ref="A2:C2"/>');
    expect(sheet).toContain('outlineLevel="1"');
    // Автофильтр отключён намеренно: на листе с заголовками групп он таскал бы их вместе с данными.
    expect(sheet).not.toContain('<autoFilter');
    expect(partOf(book, 'xl/styles.xml')).toContain('FFC6EFCE');
  });

  it('итог под группой обещает лист, а не писатель', () => {
    const sheetOf = (summaryBelow?: boolean): string =>
      partOf(
        writeWorkbook([
          {
            name: 'Детализация',
            rows: [['Заказчик'], ['позиция'], ['']],
            outline: [0, 1, 0],
            summaryBelow,
          },
        ]),
        'xl/worksheets/sheet1.xml',
      );

    // У книги показаний итог действительно стоит под группой — это и остаётся умолчанием.
    expect(sheetOf(undefined)).toContain('<outlinePr summaryBelow="1"/>');
    // У листа «Детализация» сводной аналитики за позициями идёт пустая строка и следующий
    // заголовок. Соври разметка про итог — кнопка сворачивания уедет на соседнюю группу.
    expect(sheetOf(false)).toContain('<outlinePr summaryBelow="0"/>');
    // Лист без группировки свойства не заводит вовсе: обещать нечего.
    expect(
      partOf(
        writeWorkbook([{ name: 'Лист', rows: [['Заказчик']], summaryBelow: false }]),
        'xl/worksheets/sheet1.xml',
      ),
    ).not.toContain('<sheetPr>');
  });

  it('скрытый лист помечен скрытым в книге', () => {
    const book = writeWorkbook([
      { name: 'Виден', rows: [['раз']] },
      { name: 'Данные', hidden: true, rows: [['два']] },
    ]);

    expect(partOf(book, 'xl/workbook.xml')).toContain('state="hidden"');
  });

  it('сводная приходит с полным кэшем, а не с пустым обещанием пересчёта', () => {
    const book = writeWorkbook(
      [
        { name: 'Сводная', rows: [['Сводная']] },
        {
          name: 'Данные',
          hidden: true,
          rows: [
            ['Техника', 'Месяц', 'Пробег, км'],
            ['А123БВ797', '08.2026', { num: 245 }],
            ['А123БВ797', '09.2026', { num: 300 }],
          ],
        },
      ],
      {
        sheet: 'Сводная',
        source: 'Данные',
        rowField: 'Техника',
        columnField: 'Месяц',
        startRow: 3,
        values: [{ field: 'Пробег, км', label: 'Пробег, км' }],
        calculated: [{ name: 'Вдвое', formula: "'Пробег, км'*2" }],
      },
    );
    const records = partOf(book, 'xl/pivotCache/pivotCacheRecords1.xml');
    const definition = partOf(book, 'xl/pivotCache/pivotCacheDefinition1.xml');
    const table = partOf(book, 'xl/pivotTables/pivotTable1.xml');

    // Записи кэша — все: с пустым кэшем сводная оживает только в Excel, а LibreOffice и
    // отечественные редакторы показали бы пустой лист.
    expect(records).toContain('<n v="245"/>');
    expect(records).toContain('<n v="300"/>');
    expect(definition).toContain('<s v="А123БВ797"/>');
    // Вычисляемое поле записей не имеет — его считает редактор по формуле.
    expect(definition).toContain('databaseField="0"');
    // Значений в таблице два: сумма и вычисляемое поле, и разметка строк знает про оба.
    expect(table).toContain('<dataFields count="2">');
    expect(partOf(book, '[Content_Types].xml')).toContain('pivotTable+xml');
  });

  it('пустоты источника объявлены в определении кэша, а не только в записях', () => {
    const book = writeWorkbook(
      [
        { name: 'Сводная', rows: [['Сводная']] },
        {
          name: 'Данные',
          hidden: true,
          rows: [
            ['Заказчик', 'Разряд', 'Смен', 'Объём', 'Примечание'],
            ['Северная', 'перевозки', { num: 3 }, { num: 12 }, 'срочно'],
            // У вывоза смен не бывает — пустота в числовой колонке гарантирована составом книги.
            ['Северная', 'вывоз', '', { num: 8 }, ''],
          ],
        },
      ],
      {
        sheet: 'Сводная',
        source: 'Данные',
        rowField: 'Заказчик',
        columnField: 'Разряд',
        startRow: 3,
        values: [{ field: 'Объём', label: 'Объём' }],
      },
    );
    const definition = partOf(book, 'xl/pivotCache/pivotCacheDefinition1.xml');
    const fieldOf = (name: string): string =>
      new RegExp(`<cacheField name="${name}"[\\s\\S]*?</cacheField>`, 'u').exec(definition)?.[0] ??
      '';

    // Записи несут пустой элемент, и определение обязано о нём сказать: Excel спасает пересчёт при
    // открытии, а у прочих читалок такой гарантии нет (ADR 0180 — сводная оживает не только в нём).
    expect(partOf(book, 'xl/pivotCache/pivotCacheRecords1.xml')).toContain('<m/>');
    expect(fieldOf('Смен')).toContain('containsBlank="1"');
    expect(fieldOf('Смен')).toContain('containsNumber="1"');
    // Строковое поле с пустотой — тем же признаком.
    expect(fieldOf('Примечание')).toContain('containsBlank="1"');
    // Колонка без единой дыры признака не получает: он описывает записи, а не колонку вообще.
    expect(fieldOf('Объём')).not.toContain('containsBlank');
    expect(fieldOf('Разряд')).not.toContain('containsBlank');
  });

  it('запись кэша повторяет клетку листа тем же числом', () => {
    const book = writeWorkbook(
      [
        { name: 'Сводная', rows: [['Сводная']] },
        {
          name: 'Данные',
          hidden: true,
          rows: [
            ['Заказчик', 'Разряд', '₽ факт'],
            ['Северная', 'перевозки', { num: 1000.4 }],
          ],
        },
      ],
      {
        sheet: 'Сводная',
        source: 'Данные',
        rowField: 'Заказчик',
        columnField: 'Разряд',
        startRow: 3,
        values: [{ field: '₽ факт', label: '₽ факт' }],
      },
    );

    // Разойдись кэш с листом — сводная считала бы не то, что видно в источнике.
    expect(partOf(book, 'xl/worksheets/sheet2.xml')).toContain('<v>1000.4</v>');
    expect(partOf(book, 'xl/pivotCache/pivotCacheRecords1.xml')).toContain('<n v="1000.4"/>');
  });

  it('без листа-источника сводная не заводится, а книга остаётся книгой', () => {
    const book = writeWorkbook([{ name: 'Лист', rows: [['раз']] }], {
      sheet: 'Лист',
      source: 'Нет такого',
      rowField: 'Техника',
      columnField: 'Месяц',
      startRow: 3,
      values: [],
    });

    expect(Object.keys(unzipSync(book))).not.toContain('xl/pivotTables/pivotTable1.xml');
    expect(readWorkbook(book)[0]?.rows[0]?.[0]).toBe('раз');
  });
});

describe('писатель: графики', () => {
  const partOf = (bytes: Uint8Array, name: string): string =>
    strFromU8(unzipSync(bytes)[name] ?? new Uint8Array());

  const rows = [
    ['Период', 'Смен', 'На объекте', 'Мото-ч'],
    ['2026-06', { num: 14 }, { num: 22 }, { num: 198, digits: 1 as const }],
    ['2026-07', { num: 18 }, { num: 26 }, { num: 243, digits: 1 as const }],
  ];

  const chart = (patch: Partial<ChartInput>): ChartInput => ({
    kind: 'bar',
    title: 'А. Столбцы рядом',
    firstRow: 2,
    lastRow: 3,
    categoryColumn: 1,
    series: [{ name: 'Смен', column: 2 }],
    anchor: { column: 1, row: 6, width: 8, height: 15 },
    ...patch,
  });

  const withChart = (patch: Partial<ChartInput>): Uint8Array =>
    writeWorkbook([{ name: 'Динамика', rows, charts: [chart(patch)] }]);

  it('книга без графиков собирается байт в байт прежней', () => {
    // Слепок снят с писателя ДО появления графиков — на книге, где собрано всё, что он умел:
    // числа, дата, заливка, слитые ячейки, группировка, скрытый лист и сводная с кэшем.
    // Обмен справочниками и семь действующих книг правку заметить не должны, а «одинаковая
    // выгрузка даёт одинаковые байты» — договорённость этого файла (см. ADR 0180).
    const book = writeWorkbook(
      [
        { name: 'Сводная', rows: [['Сводная']] },
        {
          name: 'Детализация',
          headerRow: 2,
          autoFilter: false,
          widths: [12, 20],
          merges: ['A3:B3'],
          outline: [0, 0, 1],
          rowStyles: [undefined, { bold: true }, { fill: 'green' }],
          rows: [
            ['Свод показаний'],
            ['Техника', 'Месяц', 'Пробег, км'],
            ['А123БВ797', '08.2026', { num: 245 }],
            ['А123БВ797', '09.2026', { num: 300.5, digits: 1 }, { date: '2026-08-29' }],
          ],
        },
        {
          name: 'Данные',
          hidden: true,
          rows: [
            ['Техника', 'Месяц', 'Пробег, км'],
            ['А123БВ797', '08.2026', { num: 245 }],
            ['А123БВ797', '09.2026', { num: 300 }],
          ],
        },
      ],
      {
        sheet: 'Сводная',
        source: 'Данные',
        rowField: 'Техника',
        columnField: 'Месяц',
        startRow: 3,
        values: [{ field: 'Пробег, км', label: 'Пробег, км' }],
        calculated: [{ name: 'Вдвое', formula: "'Пробег, км'*2" }],
      },
    );

    expect(book.length).toBe(6196);
    expect(createHash('sha256').update(book).digest('hex')).toBe(
      '736849a83aa7b39c6cd3bf23de6e8db57b5b3c7698eea2ed56eb41dc196da306',
    );
    // Ни одной части графиков в книге без графиков: они стоят денег даже пустыми.
    expect(Object.keys(unzipSync(book)).filter((name) => name.includes('chart'))).toEqual([]);
  });

  it('график приезжает своей частью, рисунком и связями листа', () => {
    const book = withChart({});
    const names = Object.keys(unzipSync(book));

    expect(names).toContain('xl/charts/chart1.xml');
    expect(names).toContain('xl/drawings/drawing1.xml');
    expect(names).toContain('xl/drawings/_rels/drawing1.xml.rels');
    expect(names).toContain('xl/worksheets/_rels/sheet1.xml.rels');
    // Лист называет рисунок у себя, иначе редактор не покажет ничего и не пожалуется.
    expect(partOf(book, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id="rId1"/>');
    expect(partOf(book, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain(
      'Target="../drawings/drawing1.xml"',
    );
    expect(partOf(book, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(
      'Target="../charts/chart1.xml"',
    );
    const types = partOf(book, '[Content_Types].xml');
    expect(types).toContain('drawingml.chart+xml');
    expect(types).toContain('officedocument.drawing+xml');
    // Данные листа график не заслоняет: книга по-прежнему читается как книга.
    expect(readWorkbook(book)[0]?.rows[1]?.[1]).toBe('14');
  });

  it('серия ссылается на клетки листа, а не несёт копию чисел', () => {
    const chartXml = partOf(withChart({}), 'xl/charts/chart1.xml');

    // Диапазон значений и диапазон подписей — ровно те строки, что заказаны. Правка числа в
    // книге обязана перерисовать график, а читатель — дотянуть диапазон мышью.
    expect(chartXml).toContain('<c:f>&apos;Динамика&apos;!$B$2:$B$3</c:f>');
    expect(chartXml).toContain('<c:f>&apos;Динамика&apos;!$A$2:$A$3</c:f>');
    // Кэш значений разошёлся бы с листом в первой же ручной правке — его нет вовсе.
    expect(chartXml).not.toContain('numCache');
  });

  it('вторая ось и линия внутри столбчатого графика доезжают до разметки', () => {
    const chartXml = partOf(
      withChart({
        title: 'В. Столбцы + линия по второй оси',
        series: [
          { name: 'Смен', column: 2 },
          { name: 'Мото-ч', column: 4, asLine: true, secondaryAxis: true },
        ],
      }),
      'xl/charts/chart1.xml',
    );

    expect(chartXml).toContain('<c:barChart>');
    expect(chartXml).toContain('<c:lineChart>');
    // Линия мерится своей шкалой: её группа ссылается на вторую пару осей, а та стоит справа.
    expect(chartXml).toContain('<c:axId val="333333333"/><c:axId val="444444444"/>');
    expect(chartXml).toContain('<c:axPos val="r"/>');
    // Вторая ось подписей скрыта: категории те же, и второй ряд задвоил бы их под графиком.
    expect(chartXml).toContain('<c:axId val="333333333"/><c:scaling><c:orientation val="minMax"/>');
    expect(chartXml).toContain('<c:delete val="1"/>');
  });

  it('нормированные столбцы нормированы, а накопительные накоплены', () => {
    const percent = partOf(withChart({ kind: 'percentBar' }), 'xl/charts/chart1.xml');
    const stacked = partOf(withChart({ kind: 'stackedBar' }), 'xl/charts/chart1.xml');

    expect(percent).toContain('<c:grouping val="percentStacked"/>');
    // Ось долей — процентами: без формата она показала бы 0,2 вместо 20 %.
    expect(percent).toContain('formatCode="0%"');
    expect(stacked).toContain('<c:grouping val="stacked"/>');
    // Без полного нахлёста «накопительный» остаётся только в разметке: на глаз столбцы стоят рядом.
    expect(stacked).toContain('<c:overlap val="100"/>');
  });

  it('кольцо приходит с дыркой и красится по секторам', () => {
    const chartXml = partOf(
      withChart({ kind: 'doughnut', series: [{ name: 'Смен', column: 2 }] }),
      'xl/charts/chart1.xml',
    );

    expect(chartXml).toContain('<c:doughnutChart>');
    expect(chartXml).toContain('<c:holeSize val="50"/>');
    // Цвет проставлен явно: темы в книге нет, и по ссылке на неё LibreOffice рисует пустоту.
    expect(chartXml).toContain('<c:dPt><c:idx val="0"/>');
    expect(chartXml).toContain('<a:srgbClr val="ED7D31"/>');
  });

  it('круговая с двумя сериями — ошибка вызывающего, а не битая книга', () => {
    expect(() =>
      withChart({
        kind: 'pie',
        series: [
          { name: 'Смен', column: 2 },
          { name: 'На объекте', column: 3 },
        ],
      }),
    ).toThrow(XlsxError);
    // Текст называет и график, и число серий: чинить придётся вызывающему коду.
    expect(() => withChart({ kind: 'pie', series: [] })).toThrow(/без серий/u);
  });

  it('лист со сводной и графиком не теряет ни одной связи', () => {
    const book = writeWorkbook(
      [
        { name: 'Сводная', rows: [['Сводная']], charts: [chart({})] },
        {
          name: 'Данные',
          hidden: true,
          rows: [
            ['Техника', 'Месяц', 'Пробег, км'],
            ['А123БВ797', '08.2026', { num: 245 }],
          ],
        },
      ],
      {
        sheet: 'Сводная',
        source: 'Данные',
        rowField: 'Техника',
        columnField: 'Месяц',
        startRow: 3,
        values: [{ field: 'Пробег, км', label: 'Пробег, км' }],
      },
    );
    const rels = partOf(book, 'xl/worksheets/_rels/sheet1.xml.rels');

    // Два писателя со своим `rId1` затёрли бы друг друга, и лист потерял бы одну из частей молча.
    expect(rels).toContain('Id="rId1" Type="' + REL_NS + '/pivotTable"');
    expect(rels).toContain('Id="rId2" Type="' + REL_NS + '/drawing"');
    expect(partOf(book, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id="rId2"/>');
  });

  it('имя листа в диапазоне — то, под которым лист попал в книгу', () => {
    // Двоеточие Excel в имени листа не принимает, и писатель меняет его на пробел. Формула с
    // исходным именем указала бы в никуда — график остался бы пустым без единой жалобы.
    const book = writeWorkbook([{ name: 'Динамика: объект', rows, charts: [chart({})] }]);

    expect(partOf(book, 'xl/charts/chart1.xml')).toContain(
      '&apos;Динамика  объект&apos;!$B$2:$B$3',
    );
  });

  it('в диапазоне серии стоит подрезанное имя листа, а не исходное', () => {
    const book = writeWorkbook([
      { name: 'Инфографика по площадке Северная развязка', rows, charts: [chart({})] },
    ]);
    const title = readWorkbook(book)[0]?.name ?? '';

    // Имя длиннее 31 знака лист теряет при попадании в книгу. Формула, собранная из исходного
    // имени, указала бы в никуда — и график остался бы пустым без единой жалобы редактора.
    expect(title).toBe('Инфографика по площадке Северна');
    expect(partOf(book, 'xl/charts/chart1.xml')).toContain(`&apos;${title}&apos;!$B$2:$B$3`);
  });

  it('апостроф внутри имени листа удваивается в диапазоне', () => {
    const book = writeWorkbook([{ name: "Динамика О'Кей", rows, charts: [chart({})] }]);

    // Имя листа в формуле стоит в апострофах, и внутренний апостроф формат экранирует удвоением:
    // без удвоения имя обрывается на нём, а диапазон становится битой ссылкой.
    expect(partOf(book, 'xl/charts/chart1.xml')).toContain(
      '&apos;Динамика О&apos;&apos;Кей&apos;!$B$2:$B$3',
    );
  });

  it('два листа с графиками нумеруют части сквозь книгу, а связи — внутри рисунка', () => {
    const book = writeWorkbook([
      { name: 'Первый', rows, charts: [chart({}), chart({ title: 'Б. Накопительно' })] },
      { name: 'Второй', rows, charts: [chart({ title: 'В. Линия' })] },
    ]);
    const names = Object.keys(unzipSync(book));

    // Части книги нумеруются сквозь неё: третий график — chart3, второй рисунок — drawing2.
    expect(names).toContain('xl/charts/chart3.xml');
    expect(names).toContain('xl/drawings/drawing2.xml');
    // А связи живут внутри своего рисунка и начинаются с rId1 заново: номер связи локален, и
    // сквозная нумерация в нём указала бы на несуществующую связь.
    expect(partOf(book, 'xl/drawings/_rels/drawing2.xml.rels')).toContain(
      `Id="rId1" Type="${REL_NS}/chart" Target="../charts/chart3.xml"`,
    );
    expect(partOf(book, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(
      `Id="rId2" Type="${REL_NS}/chart" Target="../charts/chart2.xml"`,
    );
    expect(partOf(book, 'xl/worksheets/_rels/sheet2.xml.rels')).toContain(
      'Target="../drawings/drawing2.xml"',
    );
    expect(partOf(book, 'xl/worksheets/sheet2.xml')).toContain('<drawing r:id="rId1"/>');
    // Каждый лист рисует свои графики: диапазоны второго ссылаются на второй лист.
    expect(partOf(book, 'xl/charts/chart3.xml')).toContain('&apos;Второй&apos;!$B$2:$B$3');
    expect(partOf(book, '[Content_Types].xml')).toContain('/xl/drawings/drawing2.xml');
  });

  it('битый диапазон, колонка нулём и якорь нулём — отказ до сборки книги', () => {
    // Разметка диаграммы не показывает ошибку: Excel чинит книгу целиком, вместе со сводной и
    // стилями, поэтому нарушения ловятся здесь и называются словами.
    expect(() => withChart({ firstRow: 0 })).toThrow(/не диапазон листа/u);
    expect(() => withChart({ firstRow: 5, lastRow: 3 })).toThrow(/не диапазон листа/u);
    expect(() => withChart({ lastRow: 2.5 })).toThrow(XlsxError);
    expect(() => withChart({ categoryColumn: 0 })).toThrow(/считается с единицы/u);
    expect(() => withChart({ series: [{ name: 'Смен', column: 0 }] })).toThrow(
      /считается с единицы/u,
    );
    // Нулевой якорь и нулевой размер: рамка в ноль клеток рисуется невидимой, а место «нулевой
    // колонки» на листе не существует вовсе.
    expect(() => withChart({ anchor: { column: 1, row: 6, width: 0, height: 15 } })).toThrow(
      /клетками/u,
    );
    expect(() => withChart({ anchor: { column: 1, row: 6, width: 8, height: 0 } })).toThrow(
      /клетками/u,
    );
    expect(() => withChart({ anchor: { column: 0, row: 6, width: 8, height: 15 } })).toThrow(
      /клетками/u,
    );
    expect(() => withChart({ anchor: { column: 1, row: 0, width: 8, height: 15 } })).toThrow(
      /клетками/u,
    );
  });
});
