import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Инструкция_Автозапчасти_в_гараже.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'auto-parts-guide-'));
const TOTAL = 6;

const W = 1123;
const H = 1588;

const C = {
  ink: '#172033',
  text: '#262626',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e7eaf0',
  bg: '#f5f7fb',
  panel: '#ffffff',
  blue: '#1677ff',
  blue2: '#4096ff',
  blueSoft: '#e6f4ff',
  bluePale: '#f0f7ff',
  green: '#389e0d',
  greenSoft: '#f6ffed',
  orange: '#d46b08',
  orangeSoft: '#fff7e6',
  red: '#cf1322',
  redSoft: '#fff1f0',
  graySoft: '#fafafa',
  purple: '#722ed1',
  purpleSoft: '#f9f0ff',
};

const esc = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function wrap(text, width, size, weight = 400) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  const factor = weight >= 600 ? 0.59 : 0.55;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length * size * factor <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function text(x, y, value, size = 24, opts = {}) {
  const {
    fill = C.text,
    weight = 400,
    anchor = 'start',
    letter = 0,
    family = 'DejaVu Sans',
    opacity = 1,
    italic = false,
  } = opts;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letter}" opacity="${opacity}"${italic ? ' font-style="italic"' : ''}>${esc(value)}</text>`;
}

function paragraph(x, y, value, width, size = 24, opts = {}) {
  const { lineHeight = Math.round(size * 1.35), maxLines, ...textOpts } = opts;
  let lines = wrap(value, width, size, textOpts.weight);
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:]?$/, '')}…`;
  }
  return lines.map((line, i) => text(x, y + i * lineHeight, line, size, textOpts)).join('');
}

function rect(x, y, w, h, opts = {}) {
  const {
    fill = 'none',
    stroke = 'none',
    sw = 1,
    r = 0,
    opacity = 1,
    shadow = false,
    dash,
  } = opts;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${shadow ? ' filter="url(#shadow)"' : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function line(x1, y1, x2, y2, opts = {}) {
  const { stroke = C.line, sw = 1, dash, opacity = 1 } = opts;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function circle(cx, cy, r, opts = {}) {
  const { fill = 'none', stroke = 'none', sw = 1, shadow = false } = opts;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${shadow ? ' filter="url(#shadow)"' : ''}/>`;
}

function button(x, y, w, label, opts = {}) {
  const { primary = false, danger = false, compact = false, icon } = opts;
  const h = compact ? 34 : 44;
  const fill = primary ? C.blue : danger ? C.redSoft : '#fff';
  const stroke = primary ? C.blue : danger ? '#ffccc7' : '#d9d9d9';
  const color = primary ? '#fff' : danger ? C.red : C.text;
  let out = rect(x, y, w, h, { fill, stroke, r: 7 });
  if (icon) out += text(x + 15, y + (compact ? 23 : 29), icon, compact ? 16 : 18, { fill: color, weight: 700 });
  out += text(x + w / 2 + (icon ? 7 : 0), y + (compact ? 23 : 29), label, compact ? 15 : 17, {
    fill: color,
    weight: primary ? 600 : 400,
    anchor: 'middle',
  });
  return out;
}

function input(x, y, w, label, value, opts = {}) {
  const { placeholder = false, error = false, h = 44, suffix } = opts;
  let out = text(x, y, label, 15, { fill: C.text, weight: 500 });
  out += rect(x, y + 10, w, h, {
    fill: '#fff',
    stroke: error ? '#ff4d4f' : '#d9d9d9',
    sw: error ? 2 : 1,
    r: 6,
  });
  out += text(x + 13, y + 10 + h / 2 + 6, value, 16, { fill: placeholder ? C.faint : C.text });
  if (suffix) out += text(x + w - 12, y + 10 + h / 2 + 6, suffix, 14, { fill: C.muted, anchor: 'end' });
  return out;
}

function pill(x, y, label, opts = {}) {
  const { fill = C.blueSoft, color = C.blue, stroke = 'none', size = 14, pad = 10 } = opts;
  const w = Math.max(42, label.length * size * 0.59 + pad * 2);
  return {
    w,
    svg:
      rect(x, y, w, size + 15, { fill, stroke, r: (size + 15) / 2 }) +
      text(x + w / 2, y + size + 1, label, size, { fill: color, weight: 600, anchor: 'middle' }),
  };
}

function dot(n, x, y, opts = {}) {
  const { fill = C.blue, r = 18 } = opts;
  return circle(x, y, r, { fill, stroke: '#fff', sw: 4, shadow: true }) + text(x, y + 7, n, r + 3, { fill: '#fff', weight: 700, anchor: 'middle' });
}

function check(x, y, color = C.green) {
  return `<path d="M ${x} ${y} l 6 7 l 13 -16" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function defs() {
  return `<defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#172033" flood-opacity="0.12"/>
    </filter>
    <filter id="shadowSmall" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#172033" flood-opacity="0.12"/>
    </filter>
  </defs>`;
}

function document(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <rect width="${W}" height="${H}" fill="#fff"/>
    ${body}
  </svg>`;
}

function pageHeader(page, titleValue, kicker) {
  return [
    circle(70, 67, 25, { fill: C.blue }),
    text(70, 77, 'A', 29, { fill: '#fff', weight: 700, anchor: 'middle' }),
    text(110, 54, kicker.toUpperCase(), 15, { fill: C.blue, weight: 700, letter: 1.4 }),
    text(110, 91, titleValue, 34, { fill: C.ink, weight: 700 }),
    text(1055, 67, `${String(page).padStart(2, '0')} / ${String(TOTAL).padStart(2, '0')}`, 17, { fill: C.faint, weight: 600, anchor: 'end' }),
    line(55, 119, 1068, 119, { stroke: C.line }),
  ].join('');
}

function footer(label = 'Пользовательская инструкция • 25.08.2026') {
  return line(55, 1530, 1068, 1530, { stroke: C.line }) + text(55, 1560, label, 14, { fill: C.faint }) + text(1068, 1560, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 });
}

function sidebar(x, y, w, h, active = 'Гараж') {
  const items = [
    ['▱', 'Заявки'],
    ['▤', 'Путевые листы'],
    ['◫', 'Гараж'],
    ['▦', 'Справочники'],
  ];
  let out = rect(x, y, w, h, { fill: '#fff' }) + line(x + w, y, x + w, y + h, { stroke: '#ededed' });
  out += circle(x + 30, y + 31, 17, { fill: C.blue });
  out += text(x + 30, y + 38, 'A', 20, { fill: '#fff', weight: 700, anchor: 'middle' });
  out += text(x + 57, y + 38, 'АВТО', 17, { fill: C.ink, weight: 700, letter: 1 });
  let yy = y + 92;
  for (const [ic, label] of items) {
    const selected = label === active;
    if (selected) out += rect(x + 10, yy - 25, w - 20, 43, { fill: C.blueSoft, r: 7 });
    out += text(x + 29, yy + 2, ic, 20, { fill: selected ? C.blue : C.muted, weight: 700, anchor: 'middle' });
    out += text(x + 52, yy, label, 15, { fill: selected ? C.blue : C.text, weight: selected ? 600 : 400 });
    yy += 53;
  }
  out += line(x + 12, y + h - 77, x + w - 12, y + h - 77, { stroke: C.line });
  out += circle(x + 30, y + h - 38, 14, { fill: '#d9eaff' });
  out += text(x + 54, y + h - 34, 'И. Механик', 13, { fill: C.text, weight: 500 });
  return out;
}

function tabs(x, y, labels, active) {
  let out = '';
  let xx = x;
  for (const label of labels) {
    const selected = label === active;
    const tw = label.length * 15 * 0.6 + 34;
    out += text(xx + tw / 2, y, label, 15, { fill: selected ? C.blue : C.text, weight: selected ? 600 : 400, anchor: 'middle' });
    if (selected) out += line(xx + 2, y + 18, xx + tw - 2, y + 18, { stroke: C.blue, sw: 3 });
    xx += tw + 7;
  }
  out += line(x, y + 19, x + 770, y + 19, { stroke: C.line });
  return out;
}

function tableHeader(x, y, widths, labels) {
  let out = rect(x, y, widths.reduce((a, b) => a + b, 0), 42, { fill: '#fafafa', stroke: C.line });
  let xx = x;
  labels.forEach((label, i) => {
    out += text(xx + 10, y + 27, label, 13, { fill: C.muted, weight: 600 });
    xx += widths[i];
    if (i < labels.length - 1) out += line(xx, y, xx, y + 42, { stroke: C.line });
  });
  return out;
}

function stockBadge(x, y, value, unit, zero = false) {
  const label = `${value} ${unit}`;
  const p = pill(x, y, label, {
    fill: zero ? C.redSoft : C.greenSoft,
    color: zero ? C.red : C.green,
    stroke: zero ? '#ffccc7' : '#b7eb8f',
    size: 13,
    pad: 9,
  });
  return p.svg;
}

function mainScreen(x, y, w, h, annotate = false) {
  const side = 168;
  const cx = x + side + 24;
  const cw = w - side - 48;
  let out = rect(x, y, w, h, { fill: '#fff', stroke: '#dfe3eb', r: 14, shadow: true });
  out += `<clipPath id="mainClip"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/></clipPath><g clip-path="url(#mainClip)">`;
  out += sidebar(x, y, side, h);
  out += tabs(cx, y + 56, ['Техника', 'Водители', 'Показания', 'Автозапчасти'], 'Автозапчасти');
  out += input(cx, y + 105, 260, '', 'Название или код', { placeholder: true, h: 38 });
  out += input(cx + 272, y + 105, 152, '', 'Наличие: все', { placeholder: true, h: 38, suffix: '⌄' });
  out += input(cx + 436, y + 105, 188, '', 'Применимость', { placeholder: true, h: 38, suffix: '⌄' });
  out += button(x + w - 145, y + 115, 116, 'Добавить', { primary: true, compact: true, icon: '+' });

  const sm = pill(cx, y + 169, 'Всего 24 позиции', { fill: C.graySoft, color: C.muted, stroke: C.line, size: 13 });
  out += sm.svg;
  const s2 = pill(cx + sm.w + 10, y + 169, 'Нет в наличии: 3', { fill: C.redSoft, color: C.red, stroke: '#ffccc7', size: 13 });
  out += s2.svg;

  const widths = [220, 128, 66, 100, 220, 86];
  const labels = ['Наименование', 'Код', 'Ед.', 'Остаток', 'Применимость', 'Статус'];
  const ty = y + 218;
  out += tableHeader(cx, ty, widths, labels);
  const rows = [
    ['Фильтр масляный', 'LF3349', 'шт', '12', 'КАМАЗ 65115 · Самосвалы', 'Активна'],
    ['Масло моторное 10W-40', '—', 'л', '24', 'Грузовые', 'Активна'],
    ['Ремень генератора', 'AVX13×1250', 'шт', '0', 'ГАЗ 3309', 'Активна'],
    ['Щётка стеклоочистителя', '3397004668', 'компл', '5', 'Легковые', 'Активна'],
    ['Антифриз G12, красный', 'G12-R', 'л', '8', 'Все типы', 'Активна'],
  ];
  rows.forEach((row, ri) => {
    const ry = ty + 42 + ri * 61;
    out += rect(cx, ry, widths.reduce((a, b) => a + b, 0), 61, { fill: ri === 2 ? '#fffafa' : '#fff', stroke: C.line });
    let xx = cx;
    row.forEach((v, i) => {
      if (i === 3) out += stockBadge(xx + 10, ry + 16, v, row[2], v === '0');
      else if (i === 5) {
        const p = pill(xx + 8, ry + 16, v, { fill: C.greenSoft, color: C.green, size: 12, pad: 7 });
        out += p.svg;
      } else {
        const size = i === 0 ? 14 : 12.5;
        const color = i === 1 && v === '—' ? C.faint : i === 4 ? C.muted : C.text;
        out += paragraph(xx + 10, ry + 24, v, widths[i] - 18, size, { fill: color, weight: i === 0 ? 600 : 400, lineHeight: 18, maxLines: 2 });
      }
      xx += widths[i];
    });
  });
  out += text(cx, y + h - 28, '1–5 из 24', 13, { fill: C.muted });
  out += text(x + w - 35, y + h - 28, '1  2  3  ›', 13, { fill: C.blue, anchor: 'end' });
  out += '</g>';
  if (annotate) {
    out += dot('1', cx + 225, y + 121, { r: 16 });
    out += dot('2', cx + 615, y + 121, { r: 16 });
    out += dot('3', cx + 32, ty + 116, { r: 16 });
    out += dot('4', x + w - 43, y + 121, { r: 16 });
  }
  return out;
}

function callout(x, y, w, h, n, titleValue, body, opts = {}) {
  const { fill = C.bluePale, stroke = '#bae0ff', dotFill = C.blue } = opts;
  let out = rect(x, y, w, h, { fill, stroke, r: 14 });
  out += circle(x + 30, y + 31, 18, { fill: dotFill });
  out += text(x + 30, y + 38, n, 19, { fill: '#fff', weight: 700, anchor: 'middle' });
  out += text(x + 59, y + 29, titleValue, 17, { fill: C.ink, weight: 700 });
  out += paragraph(x + 59, y + 56, body, w - 78, 14, { fill: C.muted, lineHeight: 20 });
  return out;
}

function page1() {
  let b = '';
  b += circle(76, 82, 30, { fill: C.blue });
  b += text(76, 93, 'A', 35, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(120, 72, 'АВТО • ГАРАЖ • АВТОЗАПЧАСТИ', 16, { fill: C.blue, weight: 700, letter: 1.6 });
  b += text(120, 101, 'Краткая пользовательская инструкция', 17, { fill: C.muted, weight: 500 });
  const ready = pill(803, 63, 'РАБОЧИЙ СЦЕНАРИЙ', { fill: C.greenSoft, color: C.green, stroke: '#b7eb8f', size: 14, pad: 13 });
  b += ready.svg;

  b += text(55, 205, 'Автозапчасти', 57, { fill: C.ink, weight: 700, letter: -1 });
  b += text(55, 270, 'в гараже', 57, { fill: C.ink, weight: 700, letter: -1 });
  b += paragraph(58, 324, 'Как найти позицию, изменить остаток и списать установленную деталь через акт обслуживания.', 850, 24, { fill: C.muted, lineHeight: 34 });

  b += mainScreen(55, 425, 1013, 646, false);

  const p1 = pill(55, 1120, 'РЕЕСТР', { fill: C.blueSoft, color: C.blue, size: 15, pad: 14 });
  b += p1.svg;
  b += text(55, 1180, 'Что есть на складе', 21, { fill: C.ink, weight: 700 });
  b += paragraph(55, 1210, 'Название, код, единица, остаток и применимость — в одной строке.', 290, 16, { fill: C.muted, lineHeight: 23 });

  const p2 = pill(405, 1120, 'ОСТАТОК', { fill: C.greenSoft, color: C.green, size: 15, pad: 14 });
  b += p2.svg;
  b += text(405, 1180, 'Число с историей', 21, { fill: C.ink, weight: 700 });
  b += paragraph(405, 1210, 'Каждая ручная правка требует причины; прошлое не редактируется.', 290, 16, { fill: C.muted, lineHeight: 23 });

  const p3 = pill(755, 1120, 'ОБСЛУЖИВАНИЕ', { fill: C.purpleSoft, color: C.purple, size: 15, pad: 14 });
  b += p3.svg;
  b += text(755, 1180, 'Списание через акт', 21, { fill: C.ink, weight: 700 });
  b += paragraph(755, 1210, 'Поставленная деталь видна и на складе, и в истории конкретной машины.', 300, 16, { fill: C.muted, lineHeight: 23 });

  b += rect(55, 1360, 1013, 105, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(82, 1402, 'Кому доступно', 16, { fill: C.blue, weight: 700 });
  b += paragraph(82, 1431, 'Остаток и номенклатуру ведут механик и главный механик. Остальные пользователи «Гаража» могут открыть склад, карточку позиции и историю — без кнопок изменения.', 940, 15, { fill: C.muted, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page2() {
  let b = pageHeader(2, 'Вкладка «Автозапчасти»', '1. Найти или добавить');
  b += rect(55, 147, 1013, 90, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += circle(90, 192, 20, { fill: C.blue });
  b += text(90, 200, 'i', 23, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(127, 183, 'Откройте «Гараж» → «Автозапчасти»', 21, { fill: C.ink, weight: 700 });
  b += text(127, 212, 'У неё нет календаря дня: склад показывает текущее состояние.', 16, { fill: C.muted });
  b += mainScreen(55, 272, 1013, 650, true);

  b += callout(55, 965, 493, 120, '1', 'Поиск', 'Ищет одновременно по названию и номенклатурному коду.');
  b += callout(575, 965, 493, 120, '2', 'Фильтры', 'Наличие, активность, модель или тип техники.');
  b += callout(55, 1105, 493, 120, '3', 'Открыть карточку', 'Нажмите строку — откроются реквизиты, применимость и журнал.');
  b += callout(575, 1105, 493, 120, '4', 'Добавить позицию', 'Укажите название и единицу. Код и применимость можно оставить пустыми; начальный остаток — при наличии права склада.');

  b += rect(55, 1265, 1013, 172, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += text(82, 1305, 'Как читать остаток', 19, { fill: C.orange, weight: 700 });
  b += stockBadge(82, 1330, '12', 'шт');
  b += text(179, 1352, 'есть в наличии', 16, { fill: C.text, weight: 500 });
  b += stockBadge(380, 1330, '0', 'шт', true);
  b += text(463, 1352, 'нет в наличии — строка выделена', 16, { fill: C.text, weight: 500 });
  b += paragraph(82, 1400, 'Нажмите красный счётчик «Нет в наличии», чтобы оставить в списке только позиции с нулевым остатком. Автоматического заказа или уведомления нет.', 930, 15, { fill: C.muted, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page3() {
  let b = pageHeader(3, 'Карточка автозапчасти', '2. Посмотреть позицию');
  b += paragraph(55, 161, 'Карточка открывается поверх вкладки. В ней собраны свойства позиции и полная история движения остатка.', 1000, 17, { fill: C.muted, lineHeight: 24 });

  b += rect(75, 225, 973, 985, { fill: '#fff', stroke: '#dfe3eb', r: 16, shadow: true });
  b += text(110, 278, 'Фильтр масляный · LF3349', 25, { fill: C.ink, weight: 700 });
  b += button(800, 250, 105, 'Изменить', { compact: true });
  b += button(916, 250, 92, 'Закрыть', { compact: true });
  b += line(105, 307, 1018, 307, { stroke: C.line });

  b += text(110, 350, 'Реквизиты', 18, { fill: C.ink, weight: 700 });
  const fields = [
    ['Наименование', 'Фильтр масляный'],
    ['Код', 'LF3349'],
    ['Единица', 'шт'],
    ['Статус', 'Активна'],
  ];
  fields.forEach(([k, v], i) => {
    const xx = 110 + (i % 2) * 275;
    const yy = 385 + Math.floor(i / 2) * 75;
    b += text(xx, yy, k, 13, { fill: C.faint, weight: 600 });
    b += text(xx, yy + 27, v, 16, { fill: C.text, weight: 500 });
  });

  b += rect(675, 342, 333, 165, { fill: C.greenSoft, stroke: '#b7eb8f', r: 14 });
  b += text(702, 376, 'Остаток', 14, { fill: C.green, weight: 700 });
  b += text(702, 431, '12', 42, { fill: C.ink, weight: 700 });
  b += text(764, 431, 'шт', 18, { fill: C.muted, weight: 500 });
  b += button(816, 394, 166, 'Изменить остаток', { compact: true });
  b += text(702, 477, 'обновлён 24.08.2026 в 11:42', 13, { fill: C.muted });

  b += text(110, 550, 'Применимость', 18, { fill: C.ink, weight: 700 });
  const a1 = pill(110, 570, 'Модель · КАМАЗ 65115', { fill: C.blueSoft, color: C.blue, stroke: '#91caff', size: 14 });
  b += a1.svg;
  const a2 = pill(110 + a1.w + 10, 570, 'Тип · Самосвалы', { fill: C.purpleSoft, color: C.purple, stroke: '#d3adf7', size: 14 });
  b += a2.svg;
  b += paragraph(110, 632, 'Подбор в акте сначала покажет эти совпадения, но не запретит выбрать другую позицию.', 860, 14, { fill: C.muted, lineHeight: 21 });

  b += text(110, 705, 'Движение остатка', 18, { fill: C.ink, weight: 700 });
  b += tableHeader(110, 730, [145, 122, 335, 175, 135], ['Дата', 'Было → стало', 'Причина', 'Автор', 'Документ']);
  const moves = [
        ['24.08.2026 11:42', '20 → 12', 'Списание по акту обслуживания', 'Иванов И.И.', 'Акт от 24.08'],
    ['22.08.2026 09:15', '10 → 20', 'Приход по накладной 406', 'Петров А.А.', '—'],
    ['04.08.2026 16:03', '12 → 10', 'Пересчёт; повреждены 2 шт', 'Иванов И.И.', '—'],
  ];
  moves.forEach((row, ri) => {
    const yy = 772 + ri * 79;
    b += rect(110, yy, 912, 79, { fill: ri % 2 ? '#fff' : '#fcfcfd', stroke: C.line });
    const starts = [110, 255, 377, 712, 887];
    const widths = [145, 122, 335, 175, 135];
    row.forEach((v, i) => {
      b += paragraph(starts[i] + 9, yy + 27, v, widths[i] - 16, i === 1 ? 15 : 12.5, { fill: i === 1 ? (v.includes('→ 12') || v.includes('→ 10') ? C.red : C.green) : i === 4 && v !== '—' ? C.blue : C.text, weight: i === 1 || (i === 4 && v !== '—') ? 600 : 400, lineHeight: 18, maxLines: 2 });
    });
  });

  b += line(105, 1040, 1018, 1040, { stroke: C.line });
  b += text(110, 1080, 'Комментарий', 13, { fill: C.faint, weight: 600 });
  b += text(110, 1111, 'Основной фильтр для двигателей Cummins ISB6.7', 15, { fill: C.text });
  b += button(891, 1141, 117, 'Закрыть', { compact: true });

  b += rect(55, 1260, 1013, 181, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(82, 1301, 'Главное правило', 18, { fill: C.blue, weight: 700 });
  b += paragraph(82, 1334, 'Остаток не редактируется в обычной форме позиции. Для него есть отдельная кнопка и обязательная причина — поэтому число всегда объясняется журналом.', 940, 17, { fill: C.ink, weight: 500, lineHeight: 25 });
  b += text(82, 1404, 'Если движение уже было, позицию можно только погасить — удалить её нельзя.', 15, { fill: C.muted });
  b += footer();
  return document(b);
}

function page4() {
  let b = pageHeader(4, 'Ручная корректировка остатка', '3. Приход и пересчёт');
  b += paragraph(55, 161, 'Используйте её для прихода, пересчёта, брака, продажи или другой операции, которая не является обслуживанием машины.', 1000, 17, { fill: C.muted, lineHeight: 24 });

  b += rect(55, 235, 500, 700, { fill: '#f3f5f8', r: 16 });
  b += rect(95, 285, 420, 555, { fill: '#fff', stroke: '#dfe3eb', r: 14, shadow: true });
  b += text(125, 335, 'Изменить остаток', 23, { fill: C.ink, weight: 700 });
  b += text(125, 367, 'Фильтр масляный · LF3349', 14, { fill: C.muted });
  b += line(120, 393, 490, 393, { stroke: C.line });
  b += text(125, 435, 'Сейчас на складе', 14, { fill: C.faint, weight: 600 });
  b += text(125, 486, '12 шт', 34, { fill: C.ink, weight: 700 });
  b += input(125, 535, 360, 'Новый остаток', '20', { suffix: 'шт' });
  b += rect(125, 615, 360, 58, { fill: C.greenSoft, stroke: '#b7eb8f', r: 8 });
  b += text(145, 651, '+8 шт будет добавлено в журнал', 15, { fill: C.green, weight: 600 });
  b += input(125, 716, 360, 'Причина', 'Приход по накладной 406');
  b += text(125, 796, 'Причина обязательна', 13, { fill: C.muted });
  b += button(277, 866, 100, 'Отмена', { compact: true });
  b += button(388, 866, 97, 'Сохранить', { primary: true, compact: true });
  b += dot('1', 485, 557, { r: 16 });
  b += dot('2', 485, 738, { r: 16 });
  b += dot('3', 485, 883, { r: 16 });

  b += text(600, 262, 'Три шага', 26, { fill: C.ink, weight: 700 });
  b += callout(600, 300, 468, 126, '1', 'Введите итоговое число', 'Не «добавить 8», а «стало 20». Портал сам вычислит разницу.', { fill: '#fff', stroke: C.line });
  b += callout(600, 446, 468, 126, '2', 'Объясните изменение', 'Коротко и проверяемо: приход, пересчёт, брак или возврат.', { fill: '#fff', stroke: C.line });
  b += callout(600, 592, 468, 126, '3', 'Сохраните', 'Появится неизменяемая запись «12 → 20» с автором и временем.', { fill: '#fff', stroke: C.line });

  b += rect(600, 755, 468, 180, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += text(627, 797, 'Если остаток изменил коллега', 18, { fill: C.orange, weight: 700 });
  b += paragraph(627, 830, 'Портал не перезапишет чужую работу. Он покажет: «остаток изменил другой человек, сейчас 18». Закройте предупреждение, проверьте новое число и повторите действие.', 410, 15, { fill: C.text, lineHeight: 23 });

  b += text(55, 1005, 'Когда какой способ использовать', 24, { fill: C.ink, weight: 700 });
  b += tableHeader(55, 1040, [285, 365, 363], ['Ситуация', 'Действие', 'Что попадёт в журнал']);
  const uses = [
    ['Получили 10 фильтров', 'Изменить остаток вручную', 'Ручная корректировка +10'],
    ['Пересчитали и нашли недостачу', 'Изменить остаток вручную', 'Ручная корректировка −N'],
    ['Поставили фильтр на машину', 'Добавить в акт обслуживания', 'Списание по акту −1'],
    ['Сняли ошибочную строку акта', 'Исправить тот же акт', 'Возврат по акту +N'],
  ];
  uses.forEach((row, ri) => {
    const yy = 1082 + ri * 75;
    b += rect(55, yy, 1013, 75, { fill: ri % 2 ? '#fff' : '#fcfcfd', stroke: C.line });
    b += paragraph(68, yy + 29, row[0], 255, 14, { fill: C.text, weight: 500, lineHeight: 20, maxLines: 2 });
    b += paragraph(350, yy + 29, row[1], 335, 14, { fill: ri >= 2 ? C.blue : C.text, weight: ri >= 2 ? 600 : 400, lineHeight: 20, maxLines: 2 });
    b += paragraph(715, yy + 29, row[2], 330, 14, { fill: ri === 3 ? C.green : ri === 2 ? C.red : C.muted, weight: 500, lineHeight: 20, maxLines: 2 });
  });
  b += footer();
  return document(b);
}

function page5() {
  let b = pageHeader(5, 'Списание через акт обслуживания', '4. Установить на машину');
  b += paragraph(55, 161, 'Отдельной выдачи со склада нет. Деталь списывается там, где фиксируется работа, — в записи ТО конкретной машины.', 1000, 17, { fill: C.muted, lineHeight: 24 });

  b += rect(55, 230, 1013, 910, { fill: '#f3f5f8', r: 16 });
  b += rect(88, 264, 947, 833, { fill: '#fff', stroke: '#dfe3eb', r: 14, shadow: true });
  b += text(120, 314, 'Запись о ТО — КАМАЗ 65115 · В613ВУ197', 22, { fill: C.ink, weight: 700 });
  b += line(118, 340, 1005, 340, { stroke: C.line });

  b += input(120, 380, 280, 'Дата обслуживания', '24.08.2026');
  b += input(425, 380, 280, 'Пробег на момент ТО, км', '128 400');
  b += input(730, 380, 275, 'Номер документа', 'Акт № 128');
  b += input(120, 482, 885, 'Примечание', 'Плановое ТО: масло и фильтры', { h: 58 });

  b += rect(120, 557, 885, 50, { fill: C.bluePale, stroke: '#bae0ff', r: 8 });
  b += text(142, 588, 'Подходящие детали показаны первыми; при необходимости можно выбрать любую активную позицию.', 14, { fill: C.blue, weight: 600 });

  b += rect(112, 625, 900, 357, { fill: C.bluePale, stroke: '#91caff', sw: 2, r: 12 });
  b += text(140, 670, 'Автозапчасти', 21, { fill: C.ink, weight: 700 });
  b += text(140, 697, 'Остаток изменится после сохранения всего акта', 14, { fill: C.muted });
  b += button(819, 646, 160, 'Добавить позицию', { compact: true, icon: '+' });

  b += text(140, 743, 'Позиция', 13, { fill: C.muted, weight: 600 });
  b += text(670, 743, 'Количество', 13, { fill: C.muted, weight: 600 });
  b += text(807, 743, 'Примечание', 13, { fill: C.muted, weight: 600 });
  b += rect(140, 758, 500, 47, { fill: '#fff', stroke: C.blue, sw: 2, r: 6 });
  b += text(155, 787, 'Фильтр масляный · LF3349', 15, { fill: C.text, weight: 500 });
  b += text(620, 787, '12 шт  ⌄', 13, { fill: C.green, weight: 600, anchor: 'end' });
  b += rect(670, 758, 105, 47, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(722, 788, '1', 16, { fill: C.text, anchor: 'middle' });
  b += rect(807, 758, 144, 47, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(820, 787, 'При ТО', 14, { fill: C.text });
  b += text(978, 788, '×', 20, { fill: C.red, weight: 600, anchor: 'middle' });

  b += rect(140, 835, 500, 47, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(155, 864, 'Масло моторное 10W-40', 15, { fill: C.text, weight: 500 });
  b += text(620, 864, '24 л  ⌄', 13, { fill: C.green, weight: 600, anchor: 'end' });
  b += rect(670, 835, 105, 47, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(722, 865, '8', 16, { fill: C.text, anchor: 'middle' });
  b += rect(807, 835, 144, 47, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(820, 864, 'Замена', 14, { fill: C.text });
  b += text(978, 865, '×', 20, { fill: C.red, weight: 600, anchor: 'middle' });

  b += rect(140, 910, 610, 48, { fill: C.greenSoft, stroke: '#b7eb8f', r: 7 });
  b += check(158, 936, C.green);
  b += text(190, 940, 'После сохранения: фильтр 12 → 11, масло 24 → 16', 14, { fill: C.green, weight: 600 });

  b += line(118, 1005, 1005, 1005, { stroke: C.line });
  b += button(771, 1030, 105, 'Отмена', { compact: true });
  b += button(887, 1030, 118, 'Сохранить', { primary: true, compact: true });

  b += dot('1', 641, 780, { r: 16 });
  b += dot('2', 775, 857, { r: 16 });
  b += dot('3', 1004, 949, { r: 16 });
  b += dot('4', 1005, 1047, { r: 16 });

  b += callout(55, 1185, 493, 118, '1', 'Выберите позицию', 'Сначала показаны подходящие модели и типы, затем весь справочник.');
  b += callout(575, 1185, 493, 118, '2', 'Укажите количество', 'Рядом видны доступный остаток и единица измерения.');
  b += callout(55, 1323, 493, 118, '3', 'Проверьте итог', 'Списать больше остатка нельзя — строка подсветится до отправки.');
  b += callout(575, 1323, 493, 118, '4', 'Сохраните акт', 'Остаток и история машины обновятся одной операцией. Без права склада блок доступен только для чтения.');
  b += footer();
  return document(b);
}

function page6() {
  let b = pageHeader(6, 'Результат после сохранения', '5. Проверить историю');
  b += paragraph(55, 161, 'Одна запись отвечает сразу на два вопроса: что поставили на машину и почему изменился склад.', 1000, 17, { fill: C.muted, lineHeight: 24 });

  b += text(55, 238, 'История машины', 22, { fill: C.ink, weight: 700 });
  b += rect(55, 267, 1013, 342, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += tableHeader(78, 292, [120, 140, 190, 315, 180], ['Дата ТО', 'Пробег', 'Документ', 'Примечание', 'Кто внёс']);
  b += rect(78, 334, 945, 68, { fill: C.bluePale, stroke: '#91caff' });
  b += text(91, 374, '24.08.2026', 14, { fill: C.text, weight: 600 });
  b += text(211, 374, '128 400 км', 14, { fill: C.text });
  b += text(351, 374, 'Акт № 128', 14, { fill: C.blue, weight: 600 });
  b += text(541, 374, 'Плановое ТО: масло и фильтры', 14, { fill: C.text });
  b += text(856, 374, 'Иванов И.И.', 14, { fill: C.text });
  b += text(1000, 374, '⌃', 16, { fill: C.blue, anchor: 'middle' });
  b += rect(78, 402, 945, 168, { fill: '#fcfcfd', stroke: C.line });
  b += text(103, 438, 'Установленные автозапчасти', 16, { fill: C.ink, weight: 700 });
  b += text(103, 478, 'Фильтр масляный · LF3349', 15, { fill: C.text, weight: 500 });
  b += text(645, 478, '1 шт', 15, { fill: C.red, weight: 700 });
  b += text(720, 478, 'При ТО', 14, { fill: C.muted });
  b += line(103, 497, 995, 497, { stroke: C.line });
  b += text(103, 532, 'Масло моторное 10W-40', 15, { fill: C.text, weight: 500 });
  b += text(645, 532, '8 л', 15, { fill: C.red, weight: 700 });
  b += text(720, 532, 'Замена', 14, { fill: C.muted });

  b += line(562, 624, 562, 676, { stroke: C.blue, sw: 3 });
  b += `<path d="M 552 666 L 562 678 L 572 666" fill="none" stroke="${C.blue}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  b += circle(562, 651, 24, { fill: C.blue, stroke: '#fff', sw: 4, shadow: true });
  b += text(562, 659, '=', 22, { fill: '#fff', weight: 700, anchor: 'middle' });

  b += text(55, 733, 'Журнал склада', 22, { fill: C.ink, weight: 700 });
  b += rect(55, 762, 1013, 290, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(85, 810, 'Фильтр масляный · LF3349', 18, { fill: C.ink, weight: 700 });
  b += stockBadge(861, 787, '11', 'шт');
  b += tableHeader(85, 836, [165, 155, 345, 170, 130], ['Дата', 'Было → стало', 'Причина', 'Автор', 'Связь']);
  b += rect(85, 878, 965, 78, { fill: '#fcfcfd', stroke: C.line });
  b += paragraph(97, 906, '24.08.2026 11:42', 140, 13, { fill: C.text, lineHeight: 18 });
  b += text(260, 924, '12 → 11', 16, { fill: C.red, weight: 700 });
  b += paragraph(415, 906, 'Списание по акту обслуживания', 315, 14, { fill: C.text, weight: 500, lineHeight: 20 });
  b += text(760, 924, 'Иванов И.И.', 13, { fill: C.text });
  b += text(930, 916, 'Акт от 24.08', 12, { fill: C.blue, weight: 600 });
  b += text(930, 936, 'КАМАЗ 65115', 12, { fill: C.blue, weight: 600 });
  b += text(85, 1008, 'Ссылка открывает именно этот акт; запись журнала изменить или удалить нельзя.', 14, { fill: C.muted });

  b += text(55, 1120, 'Если в акте ошибка', 24, { fill: C.ink, weight: 700 });
  b += callout(55, 1154, 320, 205, '1', 'Измените количество', 'Было 1, стало 2 — портал дополнительно спишет ещё 1.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(402, 1154, 320, 205, '2', 'Снимите позицию', 'Портал вернёт всё количество на склад и оставит обе записи в журнале.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });
  b += callout(748, 1154, 320, 205, '3', 'Аннулируйте ошибочный акт', 'Укажите причину: портал вернёт все позиции и исключит акт из расчёта последнего ТО.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });

  b += rect(55, 1393, 1013, 78, { fill: C.redSoft, stroke: '#ffccc7', r: 12 });
  b += text(82, 1438, 'Важно:', 16, { fill: C.red, weight: 700 });
  b += text(150, 1438, 'возврат через правку акта — это новое движение, а не стирание прошлого.', 16, { fill: C.text, weight: 500 });
  b += footer();
  return document(b);
}

const pages = [page1(), page2(), page3(), page4(), page5(), page6()];

for (const [index, svg] of pages.entries()) {
  const stem = `auto-parts-guide-${String(index + 1).padStart(2, '0')}`;
  const svgPath = join(WORK, `${stem}.svg`);
  const pngPath = join(WORK, `${stem}.png`);
  writeFileSync(svgPath, svg);
  const rendered = spawnSync(
    'python3',
    [resolve('docs/render-svg-to-png.py'), svgPath, pngPath, String(W)],
    { encoding: 'utf8' },
  );
  if (rendered.status !== 0) {
    throw new Error(`Page ${index + 1} render failed:\n${rendered.stdout}\n${rendered.stderr}`);
  }
}

const pdf = await PDFDocument.create();
pdf.setTitle('Автозапчасти в гараже — краткая пользовательская инструкция');
pdf.setSubject('Поиск автозапчастей, ведение остатка и списание через акт обслуживания');
pdf.setKeywords(['автозапчасти', 'гараж', 'остаток', 'акт обслуживания', 'инструкция']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-08-25T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `auto-parts-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
