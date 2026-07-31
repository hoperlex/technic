import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

/**
 * Разметка бланков путевых листов плейсхолдерами (ADR 0037).
 *
 * Бланки приходят от бухгалтерии готовыми — `templates/source/` хранит их ровно такими, какими
 * их прислали. Скрипт не рисует форму, а только вписывает `{{ключ}}` в графы, которые заполняет
 * портал: вёрстка, стили, штампы и линии остаются нетронутыми, потому что правится ровно
 * содержимое перечисленных ячеек.
 *
 * Так замена бланка не требует правки кода: положить новый файл в `source/`, при необходимости
 * поправить адреса ниже и прогнать скрипт. Тест `waybill-template.test.ts` затем проверит, что
 * набор плейсхолдеров совпал с тем, что собирает сервер.
 *
 * Использование: pnpm --filter @technic/api template:waybill
 */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

interface Blank {
  /** Файл-оригинал в `templates/source/`. */
  source: string;
  /** Готовый шаблон: имя совпадает с кодом формы (`vehicle_types.waybill_form_code`). */
  out: string;
  /** Ячейка → плейсхолдер. Адреса выверены по линиям заполнения самого бланка. */
  cells: Record<string, string>;
  /** Как бланк ложится на лист A4 при печати (ADR 0041). */
  orientation: 'portrait' | 'landscape';
}

/**
 * Форма 4-П. Сетка мелкая (колонки до FJ): графа набирается в одной ячейке, а текст растекается
 * вправо по линии заполнения. Поэтому значение пишется в первую ячейку линии.
 *
 * Часть подписей бланка — объединённые ячейки, и адрес обязан быть либо вне объединения, либо его
 * левым верхним углом: значение, попавшее внутрь чужого объединения, не печатается совсем. Это не
 * теория — так потерялись «Организация», гаражный номер и номер листа в обоих талонах, пока
 * `waybill-template.test.ts` не начал проверять адреса против `mergeCells` (ADR 0041).
 */
const FORM_4P: Blank = {
  source: '4П.xlsx',
  out: 'waybill-4p.xlsx',
  // 166 колонок в ширину — на портретном листе бланк рвётся пополам по вертикали.
  orientation: 'landscape',
  cells: {
    // Шапка: серия, номер и дата — три линии над «(серия)» и правее «№».
    BR2: '{{waybill_series}}',
    CX2: '{{waybill_number}}',
    BJ4: '{{waybill_date}}',
    // Организация и её коды; ОКУД впечатан типографией, ОКПО — наш. Подпись «Организация» —
    // объединение N6:AD6, поэтому линия заполнения начинается сразу за ним.
    AE6: '{{org_name}}, {{org_address}}, тел. {{org_phone}}',
    EY6: '{{org_okpo}}',
    // Автомобиль.
    V12: '{{vehicle_brand}}',
    AH13: '{{vehicle_reg_number}}',
    // Гаражный номер набирается в рамке справа — она и есть объединение CD13:CO13.
    CD13: '{{vehicle_garage_number}}',
    // Водитель: ФИО, СНИЛС (обязателен с 01.03.2023) и табельный номер.
    I14: '{{driver_fio}}',
    AY14: '{{driver_snils}}',
    CD14: '{{driver_personnel_no}}',
    S16: '{{driver_license_number}}',
    BE16: '{{driver_license_issued_on}}',
    V17: '{{communication_kind}}',
    // Прицепы: марка и госномер каждого.
    J20: '{{trailer1_brand}}',
    AV20: '{{trailer1_reg_number}}',
    J22: '{{trailer2_brand}}',
    AV22: '{{trailer2_reg_number}}',
    // Задание водителю: в чьё распоряжение — две строки, наименование и адрес заказчика.
    A30: '{{customer_name}}',
    A31: '{{customer_address}}',
    AN30: '{{task_departure_time}}',
    // Кто выписал.
    AD34: '{{dispatcher_fio}}',
    // Талоны заказчиков: левый (третий-четвёртый) и правый (первый-второй). Номер идёт в линию
    // за подписью «к путевому листу №» — она объединена, линия начинается следующей ячейкой.
    AL42: '{{waybill_number}}',
    BF42: '{{waybill_date}}',
    DQ42: '{{waybill_number}}',
    EK42: '{{waybill_date}}',
    // Нижнее задание водителю: откуда, куда, груз, заказчик. Строк в таблице четыре — ровно
    // столько заявок держит рейс (ADR 0050), и каждая печатается своей строкой. Пустые остаются
    // пустыми: рейс из одной заявки выглядит так же, как выглядел лист до маршрутов.
    A75: '{{task_from}}',
    Y75: '{{task_to}}',
    AT75: '{{task_cargo}}',
    BG75: '{{customer_name}}',
    A76: '{{task2_from}}',
    Y76: '{{task2_to}}',
    AT76: '{{task2_cargo}}',
    BG76: '{{task2_customer}}',
    A77: '{{task3_from}}',
    Y77: '{{task3_to}}',
    AT77: '{{task3_cargo}}',
    BG77: '{{task3_customer}}',
    A78: '{{task4_from}}',
    Y78: '{{task4_to}}',
    AT78: '{{task4_cargo}}',
    BG78: '{{task4_customer}}',
  },
};

/**
 * Форма № 3 (легковой автомобиль). Портал её пока не выписывает — на служебные машины заявок не
 * заводят (ADR 0037), — но бланк размечен: включение будет простановкой `waybill_form_code`.
 * Серии и номера в бланке нет вовсе, поэтому они пишутся в свободную строку под заголовком.
 */
const FORM_LEG3: Blank = {
  source: 'пут.лист легков..xlsx',
  out: 'waybill-leg3.xlsx',
  // Вдвое уже 4-П (88 колонок) и на треть длиннее — ложится на портретный лист.
  orientation: 'portrait',
  cells: {
    Q8: 'Серия {{waybill_series}}   № {{waybill_number}}   от {{waybill_date}}',
    M11: '{{org_name}}',
    A12: '{{org_address}}, тел. {{org_phone}}',
    BW12: '{{org_okpo}}',
    M14: '{{vehicle_brand}}',
    X16: '{{vehicle_reg_number}}',
    BW16: '{{vehicle_garage_number}}',
    M18: '{{driver_fio}}',
    BW18: '{{vehicle_inventory_number}}',
    N20: '{{driver_license_number}}',
    M22: '{{driver_license_issued_on}}',
    M24: '{{driver_snils}}',
    N27: '{{customer_name}}, {{customer_address}}',
    AA39: '{{dispatcher_fio}}',
  },
};

const COL = /^([A-Z]+)(\d+)$/;

function colNumber(ref: string): number {
  const letters = COL.exec(ref)![1]!;
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * Вписывает значение в ячейку листа. Стиль ячейки сохраняется: он несёт шрифт, выравнивание и
 * линию графы — потеряв его, значение выпало бы из бланка.
 */
function setCell(sheet: string, address: string, value: string): string {
  const text = `<is><t xml:space="preserve">${escapeXml(value)}</t></is>`;
  const existing = new RegExp(`<c r="${address}"([^>]*?)(/>|>[\\s\\S]*?</c>)`).exec(sheet);

  if (existing) {
    const attrs = existing[1] ?? '';
    const style = /\ss="(\d+)"/.exec(attrs);
    const s = style ? ` s="${style[1]}"` : '';
    return sheet.replace(existing[0], `<c r="${address}"${s} t="inlineStr">${text}</c>`);
  }

  // Ячейки в строке нет — вставляем в порядке колонок: Excel требует возрастающего порядка.
  const row = COL.exec(address)![2]!;
  const rowRe = new RegExp(`(<row r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const found = rowRe.exec(sheet);
  if (!found) throw new Error(`В листе нет строки ${row} — проверьте адрес ${address}`);

  const cell = `<c r="${address}" t="inlineStr">${text}</c>`;
  const body = found[2]!;
  const target = colNumber(address);
  const cells = [...body.matchAll(/<c r="([A-Z]+\d+)"[\s\S]*?(?:\/>|<\/c>)/g)];
  const next = cells.find((m) => colNumber(m[1]!) > target);
  const patched = next ? body.replace(next[0], `${cell}${next[0]}`) : `${body}${cell}`;
  return sheet.replace(found[0], `${found[1]}${patched}${found[3]}`);
}

/**
 * Параметры печати листа (ADR 0041).
 *
 * Бланки приходят из бухгалтерии без `pageSetup`: в Excel их печатали руками, подгоняя масштаб в
 * диалоге печати. Без него лист печатается портретным в 100%, и бланк 4-П расползается на четыре
 * страницы вместо двух — разрезанным и по ширине, и по высоте. Разрывы страниц в самом бланке
 * расставлены (`rowBreaks`, `colBreaks`), то есть замысел известен: страница — это лицевая
 * сторона и оборот. Здесь этот замысел лишь записывается так, чтобы его понимали и Excel, и
 * конвертер в PDF.
 *
 * `fitToHeight="0"` — «по ширине на страницу, в высоту сколько получится»: иначе обе стороны
 * бланка сжались бы в один лист. Поля сведены к 5 мм: при подгонке по ширине дюймовые поля
 * оригинала съедают масштаб, а вместе с ним и читаемость мелких граф.
 */
function setPageSetup(sheet: string, orientation: Blank['orientation']): string {
  const setup = `<pageSetup paperSize="9" orientation="${orientation}" fitToWidth="1" fitToHeight="0" />`;
  const margins =
    '<pageMargins left="0.2" right="0.2" top="0.2" bottom="0.2" header="0" footer="0" />';

  let patched = sheet.replace(/<pageMargins[^>]*>/, `${margins}${setup}`);
  if (patched === sheet) throw new Error('В листе нет <pageMargins> — некуда вписать pageSetup');

  // Подгонка включается флагом в `sheetPr`: без него `fitToWidth` в файле есть, а Excel печатает
  // по-старому в 100%.
  if (/<pageSetUpPr[^>]*fitToPage=/.test(patched)) return patched;
  patched = patched.replace(/<pageSetUpPr([^>]*?)\/>/, '<pageSetUpPr$1 fitToPage="1" />');
  if (!/fitToPage="1"/.test(patched)) {
    throw new Error('В листе нет <pageSetUpPr /> — подгонку по ширине включить нечем');
  }
  return patched;
}

function mark(blank: Blank): void {
  const files = unzipSync(new Uint8Array(readFileSync(join(templatesDir, 'source', blank.source))));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheet = new TextDecoder().decode(files[sheetPath]!);

  for (const [address, value] of Object.entries(blank.cells)) {
    sheet = setCell(sheet, address, value);
  }
  sheet = setPageSetup(sheet, blank.orientation);

  files[sheetPath] = new TextEncoder().encode(sheet);
  // Время фиксировано: одинаковый исходник обязан давать одинаковый шаблон.
  writeFileSync(join(templatesDir, blank.out), zipSync(files, { mtime: Date.UTC(1980, 0, 1) }));
  console.log(`${blank.out}: размечено граф ${Object.keys(blank.cells).length}`);
}

for (const blank of [FORM_4P, FORM_LEG3]) mark(blank);
