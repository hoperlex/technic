import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';

/**
 * Генератор бланка путевого листа 4-П (ADR 0037).
 *
 * Бланк собирается кодом, а не рисуется в редакторе: так он воспроизводим, правится в диффе и не
 * зависит от того, чья копия файла оказалась свежее. Шаблон — обычный xlsx с плейсхолдерами
 * `{{ключ}}`, которые заполняет `services/office-template.ts` из снимка значений листа.
 *
 * Форма — межотраслевая № 4-П (постановление Госкомстата России от 28.11.1997 № 78) с полем
 * СНИЛС, обязательным с 01.03.2023 (приказ Минтранса № 390). Графы, которые заполняют от руки и
 * штампами — движение горючего, показания спидометра, отметки медосмотра и контроля техсостояния,
 * талоны 2–4 — оставлены пустыми: портал их не ведёт, и подставлять туда нечего.
 *
 * Использование: pnpm --filter @technic/api template:waybill
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'templates');

/** Ширина колонки сетки: бланк мелкографный, и ячейки склеиваются под каждую графу. */
const COL_WIDTH = 3.6;
const COLS = 30;

const THIN: ExcelJS.Borders = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
  diagonal: {},
};

interface CellSpec {
  /** Диапазон «A1:D1» или адрес «A1». */
  at: string;
  text?: string;
  bold?: boolean;
  size?: number;
  /** Выравнивание по горизонтали; по умолчанию — влево. */
  align?: 'left' | 'center' | 'right';
  /** Рамка вокруг склеенной области: у подписей граф её нет, у полей ввода есть. */
  box?: boolean;
  wrap?: boolean;
}

function put(ws: ExcelJS.Worksheet, spec: CellSpec): void {
  const [from, to] = spec.at.includes(':') ? spec.at.split(':') : [spec.at, spec.at];
  if (from !== to) ws.mergeCells(spec.at);
  const cell = ws.getCell(from!);
  if (spec.text !== undefined) cell.value = spec.text;
  cell.font = { name: 'Arial', size: spec.size ?? 7, bold: spec.bold ?? false };
  cell.alignment = {
    horizontal: spec.align ?? 'left',
    vertical: 'middle',
    wrapText: spec.wrap ?? false,
  };
  if (spec.box) {
    // Рамка ставится на каждую ячейку диапазона: у склеенной области Excel рисует только рамку
    // левой верхней, и правый край графы остался бы открытым.
    const range = ws.getCell(from!).master ? spec.at : spec.at;
    const [start, end] = range.split(':');
    const startCell = ws.getCell(start!);
    const endCell = ws.getCell(end ?? start!);
    for (let r = Number(startCell.row); r <= Number(endCell.row); r += 1) {
      for (let c = Number(startCell.col); c <= Number(endCell.col); c += 1) {
        ws.getCell(r, c).border = THIN;
      }
    }
  }
}

function buildSheet(ws: ExcelJS.Worksheet): void {
  ws.properties.defaultRowHeight = 12;
  ws.columns = Array.from({ length: COLS }, () => ({ width: COL_WIDTH }));
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2, header: 0, footer: 0 },
  };

  // ── Шапка формы ──
  put(ws, { at: 'A1:H1', text: 'Место для штампа организации', size: 6, align: 'center' });
  put(ws, {
    at: 'I1:R1',
    text: 'ПУТЕВОЙ ЛИСТ грузового автомобиля',
    bold: true,
    size: 11,
    align: 'center',
  });
  put(ws, {
    at: 'S1:AD1',
    text: 'Типовая межотраслевая форма № 4-П\nУтверждена постановлением Госкомстата России от 28.11.97 № 78',
    size: 6,
    wrap: true,
  });
  ws.getRow(1).height = 26;

  put(ws, { at: 'I2:L2', text: 'Серия', size: 7, align: 'right' });
  put(ws, { at: 'M2:P2', text: '{{waybill_series}}', box: true, align: 'center' });
  put(ws, { at: 'Q2:R2', text: '№', size: 7, align: 'right' });
  put(ws, { at: 'S2:W2', text: '{{waybill_number}}', box: true, align: 'center' });
  put(ws, { at: 'X2:AD2', text: 'от {{waybill_date}}', align: 'center' });

  put(ws, { at: 'A3:D3', text: 'Организация' });
  put(ws, { at: 'E3:T3', text: '{{org_name}}', box: true });
  put(ws, { at: 'U3:X3', text: 'Код по ОКУД', size: 6, align: 'right' });
  put(ws, { at: 'Y3:AD3', text: '0345005', box: true, align: 'center' });

  put(ws, { at: 'E4:T4', text: '{{org_address}} · тел. {{org_phone}}', size: 6, box: true });
  put(ws, { at: 'U4:X4', text: 'по ОКПО', size: 6, align: 'right' });
  put(ws, { at: 'Y4:AD4', text: '{{org_okpo}}', box: true, align: 'center' });
  put(ws, {
    at: 'E5:T5',
    text: '(наименование, адрес и номер телефона)',
    size: 6,
    align: 'center',
  });

  // ── Левый столбец: машина, водитель, прицепы ──
  put(ws, { at: 'A7:E7', text: 'Марка автомобиля' });
  put(ws, { at: 'F7:N7', text: '{{vehicle_brand}}', box: true });
  put(ws, { at: 'A8:E8', text: 'Государственный номерной знак' });
  put(ws, { at: 'F8:J8', text: '{{vehicle_reg_number}}', box: true });
  put(ws, { at: 'K8:M8', text: 'Гаражный №', size: 6, align: 'right' });
  put(ws, { at: 'N8:P8', text: '{{vehicle_garage_number}}', box: true, align: 'center' });

  put(ws, { at: 'A9:E9', text: 'Водитель' });
  // Левый столбец бланка заканчивается на S: с T начинается «Работа водителя и автомобиля»,
  // и графы не должны наезжать друг на друга.
  put(ws, { at: 'F9:M9', text: '{{driver_fio}}', box: true });
  put(ws, { at: 'N9:O9', text: 'СНИЛС', align: 'right' });
  put(ws, { at: 'P9:S9', text: '{{driver_snils}}', box: true, align: 'center' });
  put(ws, { at: 'F10:M10', text: '(фамилия, имя, отчество)', size: 6, align: 'center' });
  put(ws, { at: 'N10:O10', text: 'Табельный №', size: 6, align: 'right' });
  put(ws, { at: 'P10:S10', text: '{{driver_personnel_no}}', box: true, align: 'center' });

  put(ws, { at: 'A11:E11', text: 'Удостоверение №' });
  put(ws, { at: 'F11:J11', text: '{{driver_license_number}}', box: true });
  put(ws, { at: 'K11:N11', text: 'Дата выдачи', size: 6, align: 'right' });
  put(ws, { at: 'O11:S11', text: '{{driver_license_issued_on}}', box: true, align: 'center' });

  put(ws, { at: 'A12:E12', text: 'Вид сообщения' });
  put(ws, { at: 'F12:J12', text: '{{communication_kind}}', box: true });
  put(ws, { at: 'K12:N12', text: 'Вид перевозки', align: 'right' });
  put(ws, { at: 'O12:S12', text: '{{transportation_kind}}', box: true });

  put(ws, { at: 'A13:E13', text: 'Прицеп 1 (марка)' });
  put(ws, { at: 'F13:J13', text: '{{trailer1_brand}}', box: true });
  put(ws, { at: 'K13:N13', text: 'Гос. номер', align: 'right' });
  put(ws, { at: 'O13:S13', text: '{{trailer1_reg_number}}', box: true });
  put(ws, { at: 'A14:E14', text: 'Прицеп 2 (марка)' });
  put(ws, { at: 'F14:J14', text: '{{trailer2_brand}}', box: true });
  put(ws, { at: 'K14:N14', text: 'Гос. номер', align: 'right' });
  put(ws, { at: 'O14:S14', text: '{{trailer2_reg_number}}', box: true });

  // ── Правый столбец: работа водителя и автомобиля (заполняется от руки) ──
  put(ws, {
    at: 'T7:AD7',
    text: 'Работа водителя и автомобиля',
    bold: true,
    align: 'center',
    box: true,
  });
  put(ws, { at: 'T8:V8', text: 'операция', size: 6, align: 'center', box: true });
  put(ws, {
    at: 'W8:Y8',
    text: 'время по графику',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, {
    at: 'Z8:AB8',
    text: 'показание спидометра, км',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, { at: 'AC8:AD8', text: 'дата, время', size: 6, align: 'center', box: true, wrap: true });
  ws.getRow(8).height = 20;
  put(ws, { at: 'T9:V9', text: 'выезд из гаража', size: 6, box: true });
  put(ws, { at: 'W9:Y9', box: true });
  put(ws, { at: 'Z9:AB9', box: true });
  put(ws, { at: 'AC9:AD9', box: true });
  put(ws, { at: 'T10:V10', text: 'возвращение в гараж', size: 6, box: true });
  put(ws, { at: 'W10:Y10', box: true });
  put(ws, { at: 'Z10:AB10', box: true });
  put(ws, { at: 'AC10:AD10', box: true });

  put(ws, { at: 'T12:AD12', text: 'Движение горючего', bold: true, align: 'center', box: true });
  put(ws, { at: 'T13:V13', text: 'марка', size: 6, align: 'center', box: true });
  put(ws, { at: 'W13:X13', text: 'выдано, л', size: 6, align: 'center', box: true });
  put(ws, {
    at: 'Y13:Z13',
    text: 'остаток при выезде',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, {
    at: 'AA13:AB13',
    text: 'остаток при возвращении',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, { at: 'AC13:AD13', text: 'сдано, л', size: 6, align: 'center', box: true });
  ws.getRow(13).height = 20;
  for (const col of ['T14:V14', 'W14:X14', 'Y14:Z14', 'AA14:AB14', 'AC14:AD14']) {
    put(ws, { at: col, box: true });
  }

  // ── Задание водителю ──
  put(ws, { at: 'A16:AD16', text: 'ЗАДАНИЕ ВОДИТЕЛЮ', bold: true, align: 'center' });
  put(ws, {
    at: 'A17:M17',
    text: 'В чьё распоряжение (наименование и адрес заказчика)',
    size: 6,
    align: 'center',
    box: true,
  });
  put(ws, {
    at: 'N17:R17',
    text: 'время прибытия, ч. мин.',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, {
    at: 'S17:W17',
    text: 'время убытия, ч. мин.',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, {
    at: 'X17:AA17',
    text: 'количество часов',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  put(ws, {
    at: 'AB17:AD17',
    text: 'количество ездок',
    size: 6,
    align: 'center',
    box: true,
    wrap: true,
  });
  ws.getRow(17).height = 22;

  put(ws, {
    at: 'A18:M18',
    text: '{{customer_name}}, {{customer_address}}',
    box: true,
    wrap: true,
  });
  put(ws, { at: 'N18:R18', text: '{{task_departure_time}}', box: true, align: 'center' });
  put(ws, { at: 'S18:W18', box: true });
  put(ws, { at: 'X18:AA18', box: true });
  put(ws, { at: 'AB18:AD18', box: true });
  ws.getRow(18).height = 18;

  put(ws, { at: 'A20:F20', text: 'откуда', size: 6, align: 'center', box: true });
  put(ws, { at: 'G20:L20', text: 'куда', size: 6, align: 'center', box: true });
  put(ws, { at: 'M20:S20', text: 'груз', size: 6, align: 'center', box: true });
  put(ws, { at: 'T20:AD20', text: 'заказчик, телефон', size: 6, align: 'center', box: true });
  put(ws, { at: 'A21:F21', text: '{{task_from}}', box: true, wrap: true });
  put(ws, { at: 'G21:L21', text: '{{task_to}}', box: true, wrap: true });
  put(ws, { at: 'M21:S21', text: '{{task_cargo}}', box: true });
  put(ws, { at: 'T21:AD21', text: '{{customer_name}}', box: true });
  ws.getRow(21).height = 18;

  // ── Подписи и отметки: заполняются от руки и штампами ──
  put(ws, { at: 'A23:F23', text: 'Диспетчер' });
  put(ws, { at: 'G23:N23', text: '{{dispatcher_fio}}', box: true });
  put(ws, { at: 'O23:V23', text: 'Автомобиль технически исправен, выезд разрешён', size: 6 });
  put(ws, { at: 'W23:AD23', box: true });

  put(ws, {
    at: 'A25:N25',
    text: 'Водитель по состоянию здоровья к управлению допущен, алкотест пройден',
    size: 6,
  });
  put(ws, { at: 'O25:V25', text: 'Механик (контроль техсостояния)', size: 6 });
  put(ws, { at: 'W25:AD25', box: true });
  put(ws, { at: 'A26:N26', box: true });

  put(ws, { at: 'A28:F28', text: 'Автомобиль принял. Водитель', size: 6 });
  put(ws, { at: 'G28:N28', text: '{{driver_fio}}', box: true });
  put(ws, { at: 'O28:V28', text: 'Сдал водитель', size: 6 });
  put(ws, { at: 'W28:AD28', box: true });

  // ── Талоны заказчиков (1–4): бланк держит четыре, портал заполняет первый ──
  put(ws, { at: 'A30:AD30', text: 'ЛИНИЯ ОТРЕЗА', size: 6, align: 'center' });
  put(ws, {
    at: 'A31:AD31',
    text: 'Талон заказчика (заполняется в организации — владельце автотранспорта)',
    bold: true,
    align: 'center',
  });
  put(ws, { at: 'A32:H32', text: 'к путевому листу № {{waybill_number}}', box: true });
  put(ws, { at: 'I32:P32', text: 'от {{waybill_date}}', box: true });
  put(ws, { at: 'Q32:AD32', text: 'Заказчик: {{customer_name}}', box: true });
  put(ws, {
    at: 'A33:H33',
    text: 'Автомобиль: {{vehicle_brand}} {{vehicle_reg_number}}',
    box: true,
  });
  put(ws, { at: 'I33:P33', text: 'Водитель: {{driver_fio}}', box: true });
  put(ws, { at: 'Q33:AD33', text: 'Груз: {{task_cargo}}', box: true });
}

/**
 * ODS-двойник бланка. Собирается вручную из XML — библиотеки для OpenDocument в проект ради этого
 * не тянем: подстановка обоим форматам нужна одна и та же, а вёрстка у ods здесь проще (таблица
 * без рамок). Ключи плейсхолдеров те же, поэтому тест согласованности проверяет оба сразу.
 */
function buildOds(rows: string[][]): Uint8Array {
  const enc = new TextEncoder();
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cells = (row: string[]) =>
    row
      .map(
        (text) =>
          `<table:table-cell office:value-type="string"><text:p>${escape(text)}</text:p></table:table-cell>`,
      )
      .join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:body><office:spreadsheet><table:table table:name="Путевой лист 4-П">
${rows.map((row) => `<table:table-row>${cells(row)}</table:table-row>`).join('\n')}
</table:table></office:spreadsheet></office:body></office:document-content>`;

  return zipSync(
    {
      mimetype: enc.encode('application/vnd.oasis.opendocument.spreadsheet'),
      'content.xml': enc.encode(content),
      'META-INF/manifest.xml': enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`,
      ),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

/** Те же графы построчно — из них собирается ods-двойник. */
const ODS_ROWS: string[][] = [
  ['ПУТЕВОЙ ЛИСТ грузового автомобиля', '', 'Типовая межотраслевая форма № 4-П'],
  ['Серия', '{{waybill_series}}', '№', '{{waybill_number}}', 'от', '{{waybill_date}}'],
  ['Организация', '{{org_name}}', '{{org_address}}', 'тел. {{org_phone}}', 'ОКПО', '{{org_okpo}}'],
  ['Марка автомобиля', '{{vehicle_brand}}'],
  ['Гос. номерной знак', '{{vehicle_reg_number}}', 'Гаражный №', '{{vehicle_garage_number}}'],
  ['Водитель', '{{driver_fio}}', 'СНИЛС', '{{driver_snils}}'],
  ['Табельный №', '{{driver_personnel_no}}'],
  ['Удостоверение №', '{{driver_license_number}}', 'Дата выдачи', '{{driver_license_issued_on}}'],
  ['Вид сообщения', '{{communication_kind}}', 'Вид перевозки', '{{transportation_kind}}'],
  ['Прицеп 1', '{{trailer1_brand}}', 'Гос. номер', '{{trailer1_reg_number}}'],
  ['Прицеп 2', '{{trailer2_brand}}', 'Гос. номер', '{{trailer2_reg_number}}'],
  ['ЗАДАНИЕ ВОДИТЕЛЮ'],
  ['В чьё распоряжение', '{{customer_name}}', '{{customer_address}}'],
  ['Время прибытия', '{{task_departure_time}}', 'Время убытия', '', 'Часов', '', 'Ездок', ''],
  ['Откуда', '{{task_from}}', 'Куда', '{{task_to}}', 'Груз', '{{task_cargo}}'],
  ['Диспетчер', '{{dispatcher_fio}}'],
  ['Автомобиль принял, водитель', '{{driver_fio}}'],
  ['Талон заказчика к путевому листу', '{{waybill_number}}', 'от', '{{waybill_date}}'],
  ['Заказчик', '{{customer_name}}', 'Автомобиль', '{{vehicle_brand}} {{vehicle_reg_number}}'],
];

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Путевой лист 4-П');
  buildSheet(ws);
  const xlsx = await wb.xlsx.writeBuffer();
  writeFileSync(join(outDir, 'waybill-4p.xlsx'), Buffer.from(xlsx));

  writeFileSync(join(outDir, 'waybill-4p.ods'), Buffer.from(buildOds(ODS_ROWS)));

  console.log(`Бланки собраны: ${outDir}`);
}

await main();
