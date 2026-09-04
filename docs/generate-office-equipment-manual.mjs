/**
 * Полное пользовательское руководство по модулю «Орг.техника» — отдельным PDF.
 *
 * Родня генератору `generate-office-equipment-guide.mjs`: те же приёмы (страница рисуется строкой
 * SVG, librsvg переводит её в PNG, `pdf-lib` собирает A4), та же палитра и те же помощники —
 * руководства портала должны выглядеть одной семьёй.
 *
 * Источник фактов: код на 01.09.2026 плюс ADR 0145 (цикл заявки) и ADR 0146 (расходники, закупка,
 * заявка без аппарата). Подписи кнопок, полей и столбцов взяты из интерфейса дословно.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Руководство_Оргтехника_полное.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'office-equipment-manual-'));
const W = 1123;
const H = 1588;
const TOTAL = 20;
const RELEASE = '1 сентября 2026';

const C = {
  ink: '#172033',
  text: '#2f3440',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e7eaf0',
  bg: '#f5f7fb',
  panel: '#ffffff',
  blue: '#1677ff',
  blue2: '#4096ff',
  blueSoft: '#e6f4ff',
  bluePale: '#f0f7ff',
  cyan: '#08979c',
  cyanSoft: '#e6fffb',
  green: '#389e0d',
  greenSoft: '#f6ffed',
  orange: '#d46b08',
  orangeSoft: '#fff7e6',
  gold: '#d48806',
  goldSoft: '#fffbe6',
  red: '#cf1322',
  redSoft: '#fff1f0',
  purple: '#722ed1',
  purpleSoft: '#f9f0ff',
  graySoft: '#fafafa',
};

const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function wrap(value, width, size, weight = 400) {
  const words = String(value).trim().split(/\s+/);
  const lines = [];
  let current = '';
  const factor = weight >= 600 ? 0.665 : 0.605;
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (!current || next.length * size * factor <= width) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function text(x, y, value, size = 24, options = {}) {
  const {
    fill = C.text,
    weight = 400,
    anchor = 'start',
    letter = 0,
    opacity = 1,
    italic = false,
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="DejaVu Sans" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letter}" opacity="${opacity}"${italic ? ' font-style="italic"' : ''}>${esc(value)}</text>`;
}

function paragraph(x, y, value, width, size = 20, options = {}) {
  const { lineHeight = Math.round(size * 1.4), maxLines, ...textOptions } = options;
  let lines = wrap(value, width, size, textOptions.weight);
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:]?$/, '')}…`;
  }
  return lines
    .map((lineValue, i) => text(x, y + i * lineHeight, lineValue, size, textOptions))
    .join('');
}

function rect(x, y, w, h, options = {}) {
  const { fill = 'none', stroke = 'none', sw = 1, r = 0, opacity = 1, shadow = false, dash } =
    options;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${shadow ? ' filter="url(#shadow)"' : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function line(x1, y1, x2, y2, options = {}) {
  const { stroke = C.line, sw = 1, dash, opacity = 1 } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function circle(cx, cy, r, options = {}) {
  const { fill = 'none', stroke = 'none', sw = 1, shadow = false } = options;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${shadow ? ' filter="url(#shadow)"' : ''}/>`;
}

function path(d, options = {}) {
  const { fill = 'none', stroke = C.text, sw = 2, dash } = options;
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function pill(x, y, label, options = {}) {
  const {
    fill = C.blueSoft,
    color = C.blue,
    stroke = 'none',
    size = 14,
    pad = 10,
    weight = 600,
  } = options;
  const width = Math.max(42, label.length * size * 0.75 + pad * 2);
  return {
    width,
    svg:
      rect(x, y, width, size + 16, { fill, stroke, r: (size + 16) / 2 }) +
      text(x + width / 2, y + size + 1, label, size, { fill: color, weight, anchor: 'middle' }),
  };
}

function button(x, y, width, label, options = {}) {
  const { primary = false, danger = false, compact = false, disabled = false, icon } = options;
  const height = compact ? 36 : 46;
  const fill = disabled ? '#f5f5f5' : primary ? C.blue : danger ? C.redSoft : '#fff';
  const stroke = disabled ? '#e5e5e5' : primary ? C.blue : danger ? '#ffccc7' : '#d9d9d9';
  const color = disabled ? C.faint : primary ? '#fff' : danger ? C.red : C.text;
  let output = rect(x, y, width, height, { fill, stroke, r: 7 });
  if (icon) output += text(x + 16, y + (compact ? 24 : 30), icon, 18, { fill: color, weight: 700 });
  output += text(x + width / 2 + (icon ? 8 : 0), y + (compact ? 24 : 30), label, compact ? 15 : 17, {
    fill: color,
    weight: primary ? 600 : 500,
    anchor: 'middle',
  });
  return output;
}

function input(x, y, width, label, value, options = {}) {
  const { placeholder = false, height = 44, suffix, disabled = false } = options;
  let output = label ? text(x, y, label, 14, { fill: C.text, weight: 500 }) : '';
  const top = label ? y + 10 : y - 24;
  output += rect(x, top, width, height, {
    fill: disabled ? '#f5f5f5' : '#fff',
    stroke: '#d9d9d9',
    r: 6,
  });
  output += text(x + 13, top + height / 2 + 6, value, 15, {
    fill: placeholder || disabled ? C.faint : C.text,
  });
  if (suffix)
    output += text(x + width - 12, top + height / 2 + 6, suffix, 14, {
      fill: C.muted,
      anchor: 'end',
    });
  return output;
}

function check(x, y, color = C.green) {
  return path(`M ${x} ${y} l 6 7 l 14 -17`, { stroke: color, sw: 4 });
}

function arrow(x1, y1, x2, y2, options = {}) {
  const { stroke = C.blue, sw = 3, dash } = options;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 10;
  const x3 = x2 - size * Math.cos(angle - Math.PI / 6);
  const y3 = y2 - size * Math.sin(angle - Math.PI / 6);
  const x4 = x2 - size * Math.cos(angle + Math.PI / 6);
  const y4 = y2 - size * Math.sin(angle + Math.PI / 6);
  return (
    line(x1, y1, x2, y2, { stroke, sw, dash }) +
    path(`M ${x3} ${y3} L ${x2} ${y2} L ${x4} ${y4}`, { stroke, sw })
  );
}

function numberDot(number, x, y, options = {}) {
  const { fill = C.blue, radius = 19 } = options;
  return (
    circle(x, y, radius, { fill, stroke: '#fff', sw: 4, shadow: true }) +
    text(x, y + 7, number, radius + 2, { fill: '#fff', weight: 700, anchor: 'middle' })
  );
}

function bullet(x, y, value, width, options = {}) {
  const { color = C.blue, size = 16, lineHeight = 24, checkmark = false, weight = 400 } = options;
  let output = circle(x + 7, y - 5, 9, {
    fill: checkmark ? color : `${color}18`,
    stroke: color,
    sw: 1,
  });
  if (checkmark) output += check(x + 1, y - 5, '#fff');
  else output += circle(x + 7, y - 5, 3, { fill: color });
  output += paragraph(x + 28, y, value, width - 28, size, { fill: C.text, lineHeight, weight });
  return output;
}

function callout(x, y, width, height, number, titleValue, body, options = {}) {
  const { fill = '#fff', stroke = C.line, dotFill = C.blue, titleColor = C.ink } = options;
  let output = rect(x, y, width, height, { fill, stroke, r: 13, shadow: options.shadow });
  output += numberDot(number, x + 33, y + 33, { fill: dotFill, radius: 17 });
  output += text(x + 62, y + 34, titleValue, 17, { fill: titleColor, weight: 700 });
  output += paragraph(x + 24, y + 72, body, width - 48, 14, {
    fill: C.muted,
    lineHeight: 21,
    maxLines: Math.max(2, Math.floor((height - 78) / 21)),
  });
  return output;
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

function header(page, titleValue, kicker, subtitle) {
  let output = circle(70, 67, 25, { fill: C.blue });
  output += text(70, 77, 'A', 29, { fill: '#fff', weight: 700, anchor: 'middle' });
  output += text(110, 54, kicker.toUpperCase(), 15, { fill: C.blue, weight: 700, letter: 1.35 });
  output += text(110, 91, titleValue, 33, { fill: C.ink, weight: 700 });
  output += text(1068, 67, `${String(page).padStart(2, '0')} / ${TOTAL}`, 16, {
    fill: C.faint,
    weight: 600,
    anchor: 'end',
  });
  output += line(55, 119, 1068, 119, { stroke: C.line });
  if (subtitle)
    output += paragraph(55, 160, subtitle, 1005, 16, { fill: C.muted, lineHeight: 23, maxLines: 2 });
  return output;
}

function footer(label = `Орг.техника • полное руководство • ${RELEASE}`) {
  return (
    line(55, 1530, 1068, 1530, { stroke: C.line }) +
    text(55, 1560, label, 14, { fill: C.faint }) +
    text(1068, 1560, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 })
  );
}

function sectionLabel(x, y, label, options = {}) {
  return pill(x, y, label.toUpperCase(), {
    fill: options.fill ?? C.blueSoft,
    color: options.color ?? C.blue,
    size: 12,
    pad: 10,
  }).svg;
}

function sectionTitle(x, y, label) {
  return text(x, y, label, 24, { fill: C.ink, weight: 700 });
}

function tabs(x, y, labels, active, width) {
  let output = '';
  let xx = x;
  for (const label of labels) {
    const selected = label === active;
    const tabWidth = label.length * 14 * 0.6 + 30;
    output += text(xx + tabWidth / 2, y, label, 14, {
      fill: selected ? C.blue : C.text,
      weight: selected ? 600 : 400,
      anchor: 'middle',
    });
    if (selected)
      output += line(xx + 2, y + 17, xx + tabWidth - 2, y + 17, { stroke: C.blue, sw: 3 });
    xx += tabWidth + 5;
  }
  output += line(x, y + 18, x + width, y + 18, { stroke: C.line });
  return output;
}

function tableHeader(x, y, widths, labels, options = {}) {
  const size = options.size ?? 12;
  let output = rect(
    x,
    y,
    widths.reduce((sum, value) => sum + value, 0),
    42,
    { fill: '#fafafa', stroke: C.line },
  );
  let xx = x;
  labels.forEach((label, i) => {
    output += paragraph(xx + 10, y + 22, label, widths[i] - 16, size, {
      fill: C.muted,
      weight: 600,
      lineHeight: 15,
      maxLines: 2,
    });
    xx += widths[i];
    if (i < labels.length - 1) output += line(xx, y, xx, y + 42, { stroke: C.line });
  });
  return output;
}

function tableRow(x, y, widths, values, options = {}) {
  const height = options.height ?? 55;
  let output = rect(
    x,
    y,
    widths.reduce((sum, value) => sum + value, 0),
    height,
    { fill: options.fill ?? '#fff', stroke: C.line },
  );
  let xx = x;
  values.forEach((value, i) => {
    output += paragraph(xx + 10, y + (options.top ?? 25), value, widths[i] - 20, options.size ?? 12, {
      fill: options.colors?.[i] ?? C.text,
      weight: options.weights?.[i] ?? 400,
      lineHeight: options.lineHeight ?? 17,
      maxLines: options.maxLines ?? 2,
    });
    xx += widths[i];
    if (i < values.length - 1) output += line(xx, y, xx, y + height, { stroke: C.line });
  });
  return output;
}

/** Абзац по центру заданной точки: `paragraph` умеет только левый край. */
function centerParagraph(cx, y, value, width, size, options = {}) {
  const { lineHeight = Math.round(size * 1.4), ...rest } = options;
  return wrap(value, width, size, rest.weight)
    .map((lineValue, i) =>
      text(cx, y + i * lineHeight, lineValue, size, { ...rest, anchor: 'middle' }),
    )
    .join('');
}

/** Плитка статуса для схемы цикла: подпись статуса и одна строка «что это значит». */
function statusBox(x, y, w, h, label, note, options = {}) {
  const { color = C.blue, soft = C.blueSoft, stroke } = options;
  let output = rect(x, y, w, h, { fill: soft, stroke: stroke ?? color, r: 12, sw: 1.5 });
  output += text(x + w / 2, y + 34, label, 20, { fill: color, weight: 700, anchor: 'middle' });
  if (note)
    output += centerParagraph(x + w / 2, y + 60, note, w - 24, 12, {
      fill: C.text,
      lineHeight: 17,
    });
  return output;
}

/** Подпись у стрелки: кнопка и, при необходимости, кто её нажимает. */
function edgeLabel(x, y, label, who, options = {}) {
  const { color = C.blue, anchor = 'middle' } = options;
  let output = text(x, y, label, 13, { fill: color, weight: 700, anchor });
  if (who) output += text(x, y + 17, who, 12, { fill: C.muted, anchor });
  return output;
}

/** Строка «поле → что в него пишут» для разбора формы. */
function fieldRow(x, y, width, label, body, options = {}) {
  const { color = C.blue, labelWidth = 200 } = options;
  let output = rect(x, y, 4, 40, { fill: color, r: 2 });
  output += paragraph(x + 16, y + 15, label, labelWidth - 16, 15, {
    fill: C.ink,
    weight: 700,
    lineHeight: 18,
    maxLines: 2,
  });
  output += paragraph(x + labelWidth, y + 14, body, width - labelWidth, 13, {
    fill: C.muted,
    lineHeight: 18,
    maxLines: 2,
  });
  return output;
}

/** Макет портала: боковое меню разделов и рабочая область раздела. */
function appShell(x, y, width, height, active = 'Орг.техника') {
  const side = 205;
  const items = [
    ['▤', 'Вывоз мусора'],
    ['▱', 'Заказ ТС'],
    ['▦', 'Орг.техника'],
    ['▩', 'Справочники'],
    ['⚙', 'Администрирование'],
  ];
  let output = rect(x, y, width, height, { fill: '#fff', stroke: '#dfe3eb', r: 14, shadow: true });
  output += `<clipPath id="shell-${x}-${y}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14"/></clipPath><g clip-path="url(#shell-${x}-${y})">`;
  output += rect(x, y, side, height, { fill: '#fff' });
  output += line(x + side, y, x + side, y + height, { stroke: C.line });
  output += circle(x + 31, y + 34, 18, { fill: C.blue });
  output += text(x + 31, y + 41, 'A', 21, { fill: '#fff', weight: 700, anchor: 'middle' });
  output += text(x + 60, y + 41, 'АВТО', 17, { fill: C.ink, weight: 700, letter: 1 });
  let yy = y + 101;
  for (const [icon, label] of items) {
    const selected = label === active;
    if (selected) output += rect(x + 10, yy - 27, side - 20, 45, { fill: C.blueSoft, r: 7 });
    output += text(x + 29, yy + 2, icon, 20, {
      fill: selected ? C.blue : C.muted,
      weight: 700,
      anchor: 'middle',
    });
    output += text(x + 55, yy, label, 13.5, {
      fill: selected ? C.blue : C.text,
      weight: selected ? 600 : 400,
    });
    yy += 55;
  }
  output += line(x + 13, y + height - 76, x + side - 13, y + height - 76, { stroke: C.line });
  output += circle(x + 31, y + height - 37, 14, { fill: '#d9eaff' });
  output += text(x + 55, y + height - 33, 'И. Оператор', 13, { fill: C.text, weight: 500 });
  return { svg: output, contentX: x + side + 25, contentWidth: width - side - 50, close: '</g>' };
}

function page1() {
  let b = circle(76, 82, 30, { fill: C.blue });
  b += text(76, 93, 'A', 35, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(121, 73, 'АВТО • ПОРТАЛ • ОРГ.ТЕХНИКА', 16, { fill: C.blue, weight: 700, letter: 1.45 });
  b += text(121, 103, 'Полное руководство пользователя', 18, { fill: C.muted });
  b += pill(846, 59, 'РЕДАКЦИЯ 01.09.2026', {
    fill: C.greenSoft,
    color: C.green,
    stroke: '#b7eb8f',
    size: 13,
    pad: 13,
  }).svg;

  b += text(55, 214, 'Орг.техника', 66, { fill: C.ink, weight: 750 });
  b += text(55, 292, 'от заявки до закупки', 58, { fill: C.ink, weight: 750 });
  b += paragraph(
    58,
    352,
    'Как устроен раздел и чем он отличается от справочника, кто что может, как проходит заявка, как ведут остаток картриджей и как заводят плановую закупку.',
    980,
    24,
    { fill: C.muted, lineHeight: 35 },
  );

  b += rect(55, 462, 1013, 570, { fill: C.bg, stroke: C.line, r: 18 });
  const cards = [
    {
      n: '1',
      color: C.blue,
      soft: C.blueSoft,
      tag: 'ЗАЯВКИ',
      title: 'Работа с техникой',
      body: 'Два вида заявки, поимённые исполнители, объём работ с подписью, приёмка. Шесть живых статусов и ни одного лишнего нажатия.',
      foot: 'Орг.техника → Заявки',
    },
    {
      n: '2',
      color: C.purple,
      soft: C.purpleSoft,
      tag: 'СКЛАД',
      title: 'Расходники',
      body: 'Остаток с журналом движений, потребность «сколько держать на полке» и дефицит, из которого собирается заказ.',
      foot: 'Орг.техника → Расходники',
    },
    {
      n: '3',
      color: C.orange,
      soft: C.orangeSoft,
      tag: 'ЗАКУПКА',
      title: 'Плановая закупка',
      body: 'Отдельный документ с номером ЗК: собирается по дефициту, уходит снабжению и закрывается после того, как приход занесли.',
      foot: 'Кнопка «Плановая закупка»',
    },
  ];
  cards.forEach((card, i) => {
    const x = 78 + i * 335;
    b += rect(x, 500, 300, 494, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += circle(x + 52, 560, 30, { fill: card.color });
    b += text(x + 52, 571, card.n, 29, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += sectionLabel(x + 26, 624, card.tag, { fill: card.soft, color: card.color });
    b += text(x + 26, 698, card.title, 25, { fill: C.ink, weight: 700 });
    b += paragraph(x + 26, 748, card.body, 248, 17, { fill: C.muted, lineHeight: 27 });
    b += line(x + 26, 908, x + 274, 908, { stroke: C.line });
    b += text(x + 26, 948, card.foot, 14, { fill: card.color, weight: 600 });
  });
  b += arrow(384, 748, 408, 748, { stroke: C.faint, sw: 2 });
  b += arrow(719, 748, 743, 748, { stroke: C.faint, sw: 2 });

  b += rect(55, 1078, 1013, 288, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 1124, 'Кому это руководство', 21, { fill: C.ink, weight: 700 });
  b += bullet(82, 1176, 'Заявителю — завести заявку и понимать, чего по ней ждут.', 450, {
    color: C.blue,
    size: 16,
    lineHeight: 23,
  });
  b += bullet(82, 1246, 'ИТ-специалисту — вести назначенные заявки и предъявлять объём работ.', 450, {
    color: C.purple,
    size: 16,
    lineHeight: 23,
  });
  b += bullet(82, 1316, 'Тому, кто ведёт модуль, — распределять, согласовывать и принимать.', 450, {
    color: C.green,
    size: 16,
    lineHeight: 23,
  });
  b += bullet(565, 1176, 'Ответственному за номенклатуру — вести картриджи и совместимость.', 450, {
    color: C.cyan,
    size: 16,
    lineHeight: 23,
  });
  b += bullet(565, 1246, 'Тому, кто следит за полкой, — остаток, потребность и плановые закупки.', 450, {
    color: C.orange,
    size: 16,
    lineHeight: 23,
  });
  b += bullet(565, 1316, 'Администратору портала — кому и какие наборы полномочий выдавать.', 450, {
    color: C.red,
    size: 16,
    lineHeight: 23,
  });

  b += text(55, 1440, `Редакция: ${RELEASE}`, 15, { fill: C.faint });
  b += text(1068, 1440, `${TOTAL} страниц`, 15, { fill: C.faint, anchor: 'end' });
  b += footer();
  return document(b);
}

function page2() {
  let b = header(
    2,
    'Раздел «Орг.техника»: пять вкладок',
    '1. Из чего состоит модуль',
    'Раздел открывают два права — на заявки и на технику, — и вкладки появляются не все сразу: каждая проверяет своё. Вкладки отвечают на разные вопросы, и начинать день удобно с той, что отвечает на ваш.',
  );

  const shell = appShell(55, 222, 1013, 610, 'Орг.техника');
  b += shell.svg;
  const cx = shell.contentX;
  const cw = shell.contentWidth;
  b += text(cx, 272, 'Орг.техника', 25, { fill: C.ink, weight: 700 });
  b += tabs(cx, 325, ['Заявки', 'Гарантии', 'Архив', 'Техника', 'Расходники'], 'Заявки', cw);
  b += pill(cx, 356, 'Все заявки', { fill: C.blueSoft, color: C.blue, size: 13 }).svg;
  b += pill(cx + 132, 356, 'Требуют решения', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 13 }).svg;
  b += pill(cx + 314, 356, 'Срочные', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 13 }).svg;
  b += pill(cx + 428, 356, 'Ожидаются документы', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 13 }).svg;
  b += button(cx + cw - 192, 246, 192, 'Создать заявку', { compact: true, primary: true, icon: '+' });

  const widths = [78, 118, 190, 150, 160, 92];
  b += tableHeader(cx, 420, widths, ['№', 'Статус', 'Техника', 'Объект', 'Исполнители', 'Ждёт']);
  b += tableRow(cx, 462, widths, ['СО-412', 'Новая', 'Ricoh MP 201SPF', 'АЛ13 · Бухгалтерия', '—', '2 дня'], { fill: '#fcfdff' });
  b += tableRow(cx, 517, widths, ['СО-410', 'В работе', 'Kyocera M3145', 'АЛ14 · ИТ', 'И. Петров', '4 часа']);
  b += tableRow(cx, 572, widths, ['СО-407', 'Решена', 'Без аппарата', 'Отдел кадров', 'ИТ-служба', '1 день'], { fill: '#fcfdff' });
  b += tableRow(cx, 627, widths, ['СО-401', 'Отложена', 'Pantum P2500W', 'АЛ13 · приёмная', 'СервисПро', '12 дней']);
  b += text(cx, 718, '1–20 из 64 · по умолчанию сверху то, что ждёт дольше всех', 13, { fill: C.muted });
  b += shell.close;

  const tabCards = [
    ['Заявки', 'Что чинится и чего не хватает сейчас: рабочий список с очередями и карточкой заявки.', C.blue, C.bluePale, '#bae0ff'],
    ['Гарантии', 'Что ещё покрыто гарантией — и на технику, и на выполненные ремонты.', C.cyan, C.cyanSoft, '#87e8de'],
    ['Архив', 'Что было: удалённые заявки, их возврат и окончательное удаление.', C.faint, C.graySoft, '#d9d9d9'],
    ['Техника', 'Где что стоит, что уехало в ремонт и по чему истекает гарантия.', C.green, C.greenSoft, '#b7eb8f'],
    ['Расходники', 'Чего не хватает на складе: остаток, потребность, дефицит и закупки.', C.purple, C.purpleSoft, '#d3adf7'],
  ];
  tabCards.forEach((card, i) => {
    const x = 55 + i * 205;
    b += rect(x, 862, 193, 196, { fill: card[3], stroke: card[4], r: 13 });
    b += text(x + 18, 902, card[0], 19, { fill: card[2], weight: 700 });
    b += line(x + 18, 918, x + 175, 918, { stroke: card[4] });
    b += paragraph(x + 18, 948, card[1], 157, 13, { fill: C.text, lineHeight: 19, maxLines: 6 });
  });

  b += rect(55, 1090, 1013, 340, { fill: '#fff', stroke: C.line, r: 16 });
  b += sectionTitle(82, 1136, 'Кому какие вкладки видны');
  const vwidths = [290, 455, 268];
  b += tableHeader(82, 1164, vwidths, ['Вкладка', 'Открывается', 'Если её нет']);
  b += tableRow(82, 1206, vwidths, [
    'Заявки · Гарантии',
    'Правом на заявки — оно есть у всех, кто их заводит и ведёт',
    'Учётке не открыты заявки модуля',
  ], { fill: '#fcfdff', weights: [600] });
  b += tableRow(82, 1261, vwidths, [
    'Техника · Расходники',
    'Правом на технику — им же открывается справочник оргтехники',
    'Учётке не открыта оргтехника',
  ], { weights: [600] });
  b += tableRow(82, 1316, vwidths, [
    'Архив',
    'Отдельным доступом к архиву поверх права на заявки',
    'Архив вашей роли не положен',
  ], { fill: '#fcfdff', weights: [600] });
  b += paragraph(82, 1400, 'Сервисной компании открыты заявки и не открыт парк: реквизиты нужного ей аппарата приходят снимком в самой заявке.', 940, 13, { fill: C.muted, lineHeight: 19 });
  b += footer();
  return document(b);
}

function page3() {
  let b = header(
    3,
    'Там ведут — здесь работают',
    '2. Граница со «Справочниками»',
    'Номенклатуру — карточки аппаратов, типы, модели, картриджи — ведут в «Справочниках». В разделе «Орг.техника» ею работают. Данные одни и те же, вопросы разные, и потому кнопки у двух дверей разные.',
  );

  b += rect(55, 228, 490, 430, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += sectionLabel(82, 252, 'ведение', { fill: '#fff', color: C.blue });
  b += text(82, 330, 'Справочники → Оргтехника', 23, { fill: C.blue, weight: 700 });
  b += paragraph(82, 364, 'Здесь заводят, правят и архивируют карточки техники. Отсюда же открываются три окна номенклатуры.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += bullet(82, 432, 'Добавить технику, поправить реквизиты, снять «Активна».', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 486, '«Типы оргтехники» — МФУ, принтер, сканер и прочие виды.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 540, '«Модели аппаратов» — единые названия, из которых выбирают в карточке.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 600, '«Картриджи и тонеры» — заведение позиции, цвет, совместимость, гашение и удаление.', 436, { color: C.blue, size: 14, lineHeight: 20 });

  b += rect(578, 228, 490, 430, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += sectionLabel(605, 252, 'работа', { fill: '#fff', color: C.green });
  b += text(605, 330, 'Раздел «Орг.техника»', 23, { fill: C.green, weight: 700 });
  b += paragraph(605, 364, 'Здесь той же номенклатурой пользуются: заводят заявки, смотрят парк, правят полку и заказывают.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += bullet(605, 432, 'Завести заявку на обслуживание или на расходники.', 436, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(605, 486, 'Посмотреть, где аппарат стоит, и записать его переезд.', 436, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(605, 540, 'Изменить остаток, задать потребность, прочитать журнал движений.', 436, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(605, 600, 'Завести плановую закупку по дефициту.', 436, { color: C.green, size: 14, lineHeight: 20 });

  b += circle(561, 443, 26, { fill: '#fff', stroke: C.line, sw: 2 });
  b += text(561, 452, '↔', 24, { fill: C.faint, weight: 700, anchor: 'middle' });

  b += sectionTitle(55, 728, 'Где что делать');
  const widths = [370, 350, 293];
  b += tableHeader(55, 756, widths, ['Что нужно', 'Куда идти', 'Кому это открыто']);
  const rows = [
    ['Завести аппарат или поправить его карточку', 'Справочники → Оргтехника', '«Оргтехника: ведение»', '#fcfdff'],
    ['Завести тип, модель или картридж', 'Справочники → Оргтехника, три окна', '«Ведение», «Номенклатура»', '#fff'],
    ['Завести заявку', 'Орг.техника → Заявки', 'Всем, кому открыты заявки', '#fcfdff'],
    ['Узнать, где стоит аппарат, записать переезд', 'Орг.техника → Техника', 'Всем, кому открыта техника', '#fff'],
    ['Поправить остаток или потребность', 'Орг.техника → Расходники', '«Оргтехника: номенклатура»', '#fcfdff'],
    ['Завести плановую закупку', 'Орг.техника → Расходники', '«Оргтехника: ведение»', '#fff'],
  ];
  rows.forEach((row, i) => {
    b += tableRow(55, 798 + i * 55, widths, [row[0], row[1], row[2]], { fill: row[3], size: 13 });
  });

  b += rect(55, 1160, 1013, 150, { fill: C.orangeSoft, stroke: '#ffd591', r: 13 });
  b += text(82, 1204, 'Почему на вкладке «Расходники» нельзя завести позицию', 18, { fill: C.orange, weight: 700 });
  b += paragraph(82, 1240, 'Это не недоделка, а та же граница. Вкладка отвечает на вопрос «чего не хватает и что заказать», а новый код номенклатуры — это ведение справочника: его заводят один раз и там, где следят за уникальностью кода. Кнопка «Добавить расходник» живёт в окне «Картриджи и тонеры».', 950, 15, { fill: C.text, lineHeight: 23 });

  b += rect(55, 1338, 1013, 138, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1380, 'Столбцы у двух дверей одинаковые', 17, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1412, 'Перечень позиций в справочнике и на вкладке показывает одно и то же — код, наименование, цвет, наличие, потребность, совместимость. Различаются только действия строки: в справочнике есть заведение и удаление, на вкладке — потребность и закупка.', 950, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page4() {
  let b = header(
    4,
    'Как устроен доступ',
    '3. Роли и наборы полномочий',
    'Что человек видит и что может — два разных вопроса. Смотреть заявки и технику даёт базовая роль. Действовать — именной набор полномочий, который выдаёт администратор портала.',
  );

  const bands = [
    {
      y: 226,
      n: '1',
      title: 'Базовая роль — что видно',
      color: C.blue,
      soft: C.blueSoft,
      body: 'Чтение заявок и техники приходит с ролью учётки, а не с набором. Поэтому раздел «Орг.техника» открыт и тому, кто ничего в нём не ведёт: заявку заводят и читают все.',
      points: [
        'Заявку заводит любой, кому раздел открыт: своя заявка видна её автору всегда.',
        'Роль же задаёт и область: одним видны заявки своей площадки, другим — своего отдела.',
      ],
    },
    {
      y: 526,
      n: '2',
      title: 'Набор полномочий — что можно',
      color: C.purple,
      soft: C.purpleSoft,
      body: 'Набор — это именованная пачка действий поверх роли. Наборов три, все выдаются поимённо: администратор ставит их в карточке учётки, и в списке учёток они видны пометкой рядом с ролью.',
      points: [
        'Набор не выдаётся ролью целиком: «оператор оргтехники» — это человек, а не должность.',
        'Наборов у учётки бывает несколько: вести номенклатуру и вести модуль может один человек.',
      ],
    },
    {
      y: 826,
      n: '3',
      title: 'Область — над какими строками',
      color: C.green,
      soft: C.greenSoft,
      body: 'Обычно набор области не меняет: он говорит «что дополнительно можно», а не «над чем». Исключение одно — «Оргтехника: ИТ-служба»: ей модуль виден целиком.',
      points: [
        'Сквозная область у ИТ-службы — ТОЛЬКО в оргтехнике: заявки и парк всей компании.',
        'В вывозе мусора, заказе ТС и путевых листах она остаётся тем, кем была по своей роли.',
      ],
    },
  ];

  for (const band of bands) {
    b += rect(55, band.y, 1013, 282, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(55, band.y, 12, 282, { fill: band.color, r: 6 });
    b += circle(110, band.y + 60, 27, { fill: band.soft, stroke: band.color, sw: 2 });
    b += text(110, band.y + 70, band.n, 25, { fill: band.color, weight: 700, anchor: 'middle' });
    b += text(158, band.y + 52, band.title, 24, { fill: C.ink, weight: 700 });
    b += paragraph(158, band.y + 88, band.body, 860, 15, { fill: C.muted, lineHeight: 22 });
    band.points.forEach((point, i) => {
      b += bullet(158, band.y + 178 + i * 52, point, 855, {
        color: band.color,
        size: 15,
        lineHeight: 22,
      });
    });
  }

  b += rect(55, 1140, 1013, 296, { fill: C.purpleSoft, stroke: '#d3adf7', r: 16 });
  b += circle(100, 1190, 24, { fill: C.purple });
  b += text(100, 1198, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(142, 1184, 'Сквозная область ИТ-службы работает только в оргтехнике', 22, { fill: C.ink, weight: 700 });
  b += paragraph(142, 1216, 'Это не оговорка мелким шрифтом, а устройство: согласующий, видящий только свой отдел, не смог бы решать по заявкам всей компании — а видеть заодно каждый вывоз мусора ему незачем.', 900, 14, { fill: C.muted, lineHeight: 21 });
  b += rect(82, 1268, 470, 140, { fill: '#fff', stroke: '#d3adf7', r: 12 });
  b += text(106, 1306, 'В оргтехнике', 17, { fill: C.purple, weight: 700 });
  b += paragraph(106, 1336, 'Видны все заявки и весь парк компании, независимо от площадки и отдела учётки.', 424, 14, { fill: C.text, lineHeight: 21 });
  b += rect(571, 1268, 470, 140, { fill: '#fff', stroke: C.line, r: 12 });
  b += text(595, 1306, 'В остальных модулях', 17, { fill: C.muted, weight: 700 });
  b += paragraph(595, 1336, 'Всё как у обычной учётки этой роли: своя площадка или свой отдел, не больше.', 424, 14, { fill: C.text, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page5() {
  let b = header(
    5,
    'Три набора и что они дают',
    '4. Роли и наборы полномочий',
    'Названия наборов человек видит дважды: администратор выбирает их при выдаче, а в списке учёток они стоят пометкой рядом с ролью. Ниже — что каждый из них меняет на экране.',
  );

  const grants = [
    {
      y: 222,
      color: C.blue,
      soft: C.blueSoft,
      name: 'Оргтехника: ведение',
      who: 'Тот, кто отвечает за модуль целиком',
      points: [
        'Ведёт справочник техники: заводит и правит карточки аппаратов.',
        'Распределяет заявки: «Назначить исполнителей», «Изменить исполнителей».',
        'Согласовывает объём работ и отказывает по нему.',
        'Принимает работу и возвращает на доработку, отменяет заявку.',
        'Отмечает срочность, откладывает и возобновляет заявку.',
        'Заводит и ведёт плановые закупки расходников.',
        'Может завести заявку без аппарата.',
      ],
    },
    {
      y: 610,
      color: C.purple,
      soft: C.purpleSoft,
      name: 'Оргтехника: ИТ-служба',
      who: 'Свои специалисты, которые чинят сами',
      points: [
        'Работает исполнителем: принимает в работу и закрывает работы на заявках, где назначена.',
        'Предъявляет объём работ, заполняет номенклатуру заявки на расходники.',
        'Назначает исполнителей — в том числе берёт чужую заявку, назначив себя.',
        'Откладывает заявку, пока ждут запчасть, и подшивает документы.',
        'Может завести заявку без аппарата — и заказчика выбирает из обеих осей.',
        'Видит модуль целиком: все заявки и весь парк компании.',
      ],
    },
    {
      y: 946,
      color: C.green,
      soft: C.greenSoft,
      name: 'Оргтехника: номенклатура',
      who: 'Тот, кто ведёт картриджи и полку',
      points: [
        'Заводит, правит и гасит позиции: код, наименование, цвет, совместимые модели.',
        'Задаёт потребность — сколько позиции держать на полке.',
        'Правит остаток вручную: каждая правка с причиной и в журнале.',
      ],
    },
  ];

  for (const grant of grants) {
    const rows = Math.ceil(grant.points.length / 2);
    const height = 150 + rows * 52;
    b += rect(55, grant.y, 1013, height, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(55, grant.y, 12, height, { fill: grant.color, r: 6 });
    b += text(96, grant.y + 46, grant.name, 25, { fill: C.ink, weight: 700 });
    b += pill(96, grant.y + 62, grant.who.toUpperCase(), {
      fill: grant.soft,
      color: grant.color,
      size: 11,
      pad: 10,
    }).svg;
    grant.points.forEach((point, i) => {
      const col = i % 2;
      const rowIndex = Math.floor(i / 2);
      b += bullet(96 + col * 490, grant.y + 140 + rowIndex * 52, point, 470, {
        color: grant.color,
        size: 14,
        lineHeight: 20,
      });
    });
  }

  b += rect(55, 1230, 1013, 212, { fill: C.orangeSoft, stroke: '#ffd591', r: 16 });
  b += text(82, 1274, 'Чего наборы намеренно не дают', 20, { fill: C.orange, weight: 700 });
  b += bullet(82, 1318, 'ИТ-служба не принимает работу и не отменяет заявку: приёмка и отмена остаются за «Ведением» — иначе исполнитель принимал бы собственную работу.', 940, { color: C.orange, size: 14, lineHeight: 20 });
  b += bullet(82, 1382, '«Ведение» не предъявляет объём работ: его пишет исполнитель, а согласует ведущий. Одному человеку оба права дали бы подпись под собственным счётом.', 940, { color: C.orange, size: 14, lineHeight: 20 });

  b += footer();
  return document(b);
}

function page6() {
  let b = header(
    6,
    'Заявка: что спрашивает форма',
    '5. Заявка от заведения до закрытия',
    'Вид заявки выбирают первым — от него зависит, о чём форма спросит дальше. У заведённой заявки вид не меняется: «Обслуживание» и «Расходники» — это две разные работы, а не два слова.',
  );

  b += rect(55, 222, 635, 1032, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 270, 'Новая заявка на обслуживание', 23, { fill: C.ink, weight: 700 });

  b += text(82, 312, 'Чем помочь', 14, { fill: C.text, weight: 500 });
  b += rect(82, 324, 300, 42, { fill: C.graySoft, stroke: '#d9d9d9', r: 8 });
  b += rect(85, 327, 147, 36, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(158, 351, 'Обслуживание', 15, { fill: C.ink, weight: 600, anchor: 'middle' });
  b += text(307, 351, 'Расходники', 15, { fill: C.muted, anchor: 'middle' });

  b += input(82, 392, 581, 'Какой аппарат', 'Модель, инвентарный или серийный номер', {
    placeholder: true,
    suffix: '⌄',
  });
  b += input(82, 476, 581, 'Описание', 'Мнёт бумагу на каждой второй странице', { height: 76 });
  b += input(82, 592, 581, 'Для кого заявка', 'АЛ13 · площадка', { suffix: '⌄' });
  b += input(82, 676, 285, 'Кто обращается', 'Петрова М. А.');
  b += input(378, 676, 285, 'Телефон для связи', '+7 900 000-00-00');
  b += input(82, 760, 581, 'Откуда обращаетесь', 'Ваша площадка', { placeholder: true, suffix: '⌄' });

  b += rect(82, 852, 22, 22, { fill: C.blue, stroke: C.blue, r: 4 });
  b += check(87, 863, '#fff');
  b += text(116, 870, 'Срочная заявка', 15, { fill: C.text, weight: 500 });
  b += input(82, 892, 581, 'Почему срочно', 'Единственный принтер на площадке', {});
  b += input(82, 976, 581, 'Что ещё важно знать', 'Необязательно', { placeholder: true, height: 64 });

  b += button(82, 1078, 210, 'Фото и документы', { compact: true, icon: '↑' });
  b += text(304, 1102, 'Только при заведении', 13, { fill: C.faint });
  b += button(437, 1160, 100, 'Отмена');
  b += button(550, 1160, 113, 'Создать', { primary: true });

  b += callout(715, 222, 353, 190, '1', 'Вид — первым и навсегда', '«Обслуживание» — это не только поломка: им же просят настроить, подключить и заправить. «Расходники» — просьба привезти картридж.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(715, 428, 353, 190, '2', 'Аппарат обычно обязателен', 'Заявка живёт на аппарате: его объектом и отделом она попадает в чью-то область. Пропустить поле могут только «Ведение» и ИТ-служба — см. стр. 13.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(715, 634, 353, 190, '3', 'Описание — словами', 'Одно поле у обоих видов. Номенклатуру заявки на расходники заявитель не подбирает: состав заполнит исполнитель, которому везти.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });
  b += callout(715, 840, 353, 190, '4', 'Два разных «откуда»', '«Для кого заявка» — от чьего имени просят, «Откуда обращаетесь» — где числится сам заявитель. Путать их значит записать заявку на чужой отдел.', { fill: C.cyanSoft, stroke: '#87e8de', dotFill: C.cyan });
  b += callout(715, 1046, 353, 208, '5', 'Срочность — с причиной', 'Галочка без объяснения не сохраняется: без причины через месяц срочными окажутся все заявки, и очередь перестанет что-либо значить. Снять и поставить срочность потом может «Ведение».', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });

  b += rect(55, 1292, 1013, 150, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1334, 'Гарантия — вопрос конкретного аппарата', 18, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1368, 'Блок обращения по гарантии показывается только у «Обслуживания» и только когда аппарат выбран: обращаются либо по гарантии поставщика на него, либо по работе, выполненной на нём же. У заявки на расходники и у заявки без аппарата такого блока нет вовсе.', 950, 15, { fill: C.muted, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page7() {
  let b = header(
    7,
    'Путь заявки: кто и что делает',
    '6. Заявка от заведения до закрытия',
    'Шагов шесть, и половину из них делает не тот, кто заявку завёл. Каждый шаг — это одна кнопка в карточке; названия ниже совпадают с интерфейсом дословно.',
  );

  const steps = [
    {
      color: C.blue,
      soft: C.blueSoft,
      who: 'Заявитель',
      title: 'Завести заявку',
      body: 'Выбрать вид, аппарат и заказчика, описать словами, что не так. После назначения исполнителей заявку править уже нельзя: за ней стоят договорённости.',
      button: 'Создать заявку',
    },
    {
      color: C.purple,
      soft: C.purpleSoft,
      who: '«Оргтехника: ведение»',
      title: 'Назначить исполнителей',
      body: 'Можно назначить нескольких сотрудников и одну сервисную компанию сразу. Пока исполнителей нет, заявка стоит в «Новой» и ждёт распределения.',
      button: 'Назначить исполнителей',
    },
    {
      color: C.orange,
      soft: C.orangeSoft,
      who: 'Исполнитель',
      title: 'Взять заявку в работу',
      body: 'Ходы исполнителя открывает факт назначения, а не должность: свой сисадмин и подрядчик нажимают одни и те же кнопки. Ненужную заявку снимают с себя «Отказаться от заявки».',
      button: 'Принять в работу',
    },
    {
      color: C.gold,
      soft: C.goldSoft,
      who: 'Исполнитель и согласующий',
      title: 'Предъявить и согласовать объём работ',
      body: 'Шаг только у «Обслуживания» и только если работы нужно подтвердить. Заявка при этом остаётся «В работе» — подробно на стр. 11.',
      button: 'Объём работ',
    },
    {
      color: C.cyan,
      soft: C.cyanSoft,
      who: 'Исполнитель',
      title: 'Закрыть работы',
      body: 'Заявка уходит в «Решена» и ждёт приёмки. У ремонта сервисной компанией кнопка не сработает, пока не подшит закрывающий документ — акт, счёт или гарантийный талон.',
      button: 'Закрыть работы',
    },
    {
      color: C.green,
      soft: C.greenSoft,
      who: '«Оргтехника: ведение»',
      title: 'Принять работу',
      body: 'Приёмка закрывает заявку. Если сделано не то или не до конца — «Вернуть на доработку», и заявка возвращается исполнителю в «В работе».',
      button: 'Принять работу',
    },
  ];

  steps.forEach((step, i) => {
    const y = 222 + i * 162;
    b += rect(55, y, 1013, 150, { fill: '#fff', stroke: C.line, r: 14 });
    b += rect(55, y, 10, 150, { fill: step.color, r: 5 });
    b += numberDot(String(i + 1), 118, y + 48, { fill: step.color, radius: 20 });
    b += text(160, y + 42, step.title, 21, { fill: C.ink, weight: 700 });
    b += paragraph(160, y + 76, step.body, 600, 13.5, { fill: C.muted, lineHeight: 20, maxLines: 3 });
    b += pill(800, y + 26, step.who.toUpperCase(), { fill: step.soft, color: step.color, size: 11, pad: 10 }).svg;
    b += button(800, y + 76, 240, step.button, { compact: true });
  });

  b += rect(55, 1218, 1013, 224, { fill: C.purpleSoft, stroke: '#d3adf7', r: 16 });
  b += text(82, 1262, 'Заявка на расходники идёт тем же путём, но состав в ней называет исполнитель', 20, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1296, 'Заявитель говорит словами: «закончился чёрный тонер, печатать нечем». Позиции справочника подбирает тот, кому везти, — действием «Заполнить номенклатуру» в карточке. Заказчик состав видит и не правит.', 950, 15, { fill: C.text, lineHeight: 22 });
  b += bullet(82, 1372, 'Выдачу отмечают при закрытии работ — тогда же остаток и уменьшается.', 470, { color: C.purple, size: 14, lineHeight: 20 });
  b += bullet(565, 1372, 'Объёма работ у этого вида нет: согласовывать нечего и не у кого.', 470, { color: C.purple, size: 14, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page8() {
  let b = header(
    8,
    'Движение по статусам',
    '7. Живые статусы и переходы',
    'Живых статусов шесть. Прямой путь — четыре плитки слева направо; остальные два статуса это не шаги, а остановка и обрыв. Кто именно ходит по каждой дуге, названо в таблице внизу.',
  );

  const chain = [
    ['Новая', 'заведена; исполнителей может ещё не быть', C.blue, C.blueSoft],
    ['В работе', 'взята исполнителем', C.orange, C.orangeSoft],
    ['Решена', 'работы закрыты, ждут приёмки', C.cyan, C.cyanSoft],
    ['Закрыта', 'принята, дальше ходов нет', C.green, C.greenSoft],
  ];
  chain.forEach((item, i) => {
    const x = 95 + i * 255;
    b += statusBox(x, 240, 195, 118, item[0], item[1], { color: item[2], soft: item[3] });
    if (i < 3) {
      b += arrow(x + 195, 299, x + 250, 299, { stroke: C.faint, sw: 3 });
      b += circle(x + 222, 268, 14, { fill: '#fff', stroke: C.faint, sw: 2 });
      b += text(x + 222, 274, String(i + 1), 15, { fill: C.text, weight: 700, anchor: 'middle' });
    }
  });

  const legend = [
    ['1', '«Принять в работу» — назначенный исполнитель', C.orange],
    ['2', '«Закрыть работы» — исполнитель', C.cyan],
    ['3', '«Принять работу» — «Оргтехника: ведение»', C.green],
  ];
  legend.forEach((item, i) => {
    const x = 95 + i * 330;
    b += circle(x + 12, 396, 13, { fill: item[2] });
    b += text(x + 12, 402, item[0], 14, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += paragraph(x + 34, 402, item[1], 290, 13.5, { fill: C.text, lineHeight: 19, maxLines: 2 });
  });

  b += rect(55, 440, 490, 250, { fill: C.graySoft, stroke: C.line, r: 14 });
  b += text(82, 484, 'Остановка', 20, { fill: C.ink, weight: 700 });
  b += statusBox(82, 502, 190, 92, 'Отложена', 'движение остановлено с причиной', { color: C.muted, soft: '#fff', stroke: '#d9d9d9' });
  b += paragraph(292, 530, 'Откладывают и возобновляют «Ведение» и ИТ-служба. Причина обязательна всегда.', 226, 13, { fill: C.muted, lineHeight: 19, maxLines: 5 });
  b += paragraph(82, 626, '«Возобновить» возвращает заявку ровно в тот статус, из которого её отложили. Оператору сервисной компании заморозка закрыта: «ждём запчасть» не должно становиться решением подрядчика.', 436, 13, { fill: C.text, lineHeight: 19 });

  b += rect(578, 440, 490, 250, { fill: C.redSoft, stroke: '#ffccc7', r: 14 });
  b += text(605, 484, 'Обрыв', 20, { fill: C.ink, weight: 700 });
  b += statusBox(605, 502, 190, 92, 'Отменена', 'снята с причиной, ходов нет', { color: C.red, soft: '#fff', stroke: '#ffccc7' });
  b += paragraph(815, 528, 'Отменяют из «Новой», «В работе» и «Отложена». Сюда же ведёт отказ по объёму работ — с причиной и решением, что делаем вместо.', 226, 13, { fill: C.muted, lineHeight: 19, maxLines: 6 });
  b += paragraph(605, 630, 'Отменённая заявка не удалена: она остаётся историей того, что просили и почему не сделали.', 436, 13, { fill: C.text, lineHeight: 19 });

  b += sectionTitle(55, 748, 'Все переходы и кто по ним ходит');
  const widths = [300, 380, 333];
  b += tableHeader(55, 776, widths, ['Откуда → куда', 'Кнопка', 'Кто нажимает']);
  const rows = [
    ['Новая → В работе', 'Принять в работу', 'Назначенный исполнитель'],
    ['В работе → Решена', 'Закрыть работы', 'Исполнитель'],
    ['Решена → Закрыта', 'Принять работу', '«Оргтехника: ведение»'],
    ['Решена → В работе', 'Вернуть на доработку', '«Оргтехника: ведение»'],
    ['Новая · В работе · Отложена → Отменена', 'Отменить заявку (причина обязательна)', '«Оргтехника: ведение»'],
    ['В работе → Отменена', 'Не согласовать объём работ (причина и решение)', '«Ведение» или назначенный исполнитель'],
    ['Рабочий статус → Отложена', 'Отложить (причина обязательна)', '«Ведение» и ИТ-служба'],
    ['Отложена → прежний статус', 'Возобновить', '«Ведение» и ИТ-служба'],
    ['В работе → Новая', 'Вернуть в «Новую»', 'Администратор портала'],
    ['Закрыта → Решена', 'Отменить приёмку', 'Администратор портала'],
    ['Отменена → Новая', 'Вернуть в работу', 'Администратор портала'],
  ];
  rows.forEach((row, i) => {
    b += tableRow(55, 818 + i * 46, widths, row, {
      height: 46,
      fill: i % 2 === 0 ? '#fcfdff' : '#fff',
      size: 13,
      top: 21,
      lineHeight: 15,
      weights: [600],
      colors: [C.ink, C.text, C.muted],
    });
  });

  b += paragraph(55, 1372, 'Назначение исполнителей и отказ от заявки переходами не являются: они меняют состав, а не статус. Заявка остаётся «Новой» — и именно поэтому «Новая» отвечает то «распределите меня», то «возьмите меня в работу».', 1013, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page9() {
  let b = header(
    9,
    'Мёртвые статусы и очередь',
    '8. Что видно в истории и в списке',
    'В ленте истории попадаются статусы, которых нет в сегодняшнем цикле. Это не сбой: строка «Новая → Назначена» от 20.08 правдива, и портал обязан её подписать. Заявок в этих статусах не бывает.',
  );

  b += sectionTitle(55, 228, 'Четыре подписи, которые остались только истории');
  const dead = [
    ['Назначена', 'Означала «распределивший уже нажал, а исполнитель ещё нет». Это не состояние работы, а ожидание нажатия: аппарат не чинился быстрее оттого, что заявка стоит здесь. Сегодня то же самое видно по составу исполнителей.'],
    ['Смета на согласовании', 'Означала «объём работ предъявлен, решения нет». Заявка при этом была в работе — и сегодня остаётся «В работе», а ожидание подписи портал держит признаком, а не статусом.'],
    ['Согласована ИТ', 'Виза ИТ упразднена: подпись под работой теперь одна. Вопрос «чинить или менять» задаёт себе тот же человек, который смотрит на объём работ.'],
    ['Диагностика', 'Снята раньше, вместе с прежней разбивкой цикла. Работы по осмотру идут в «В работе», как и любые другие.'],
  ];
  dead.forEach((item, i) => {
    const y = 262 + i * 152;
    b += rect(55, y, 1013, 140, { fill: C.graySoft, stroke: C.line, r: 13 });
    b += rect(55, y, 8, 140, { fill: C.faint, r: 4 });
    b += text(92, y + 46, item[0], 21, { fill: C.muted, weight: 700 });
    b += pill(92, y + 62, 'В ЦИКЛЕ НЕ УЧАСТВУЕТ', { fill: '#fff', color: C.faint, stroke: '#d9d9d9', size: 10, pad: 8 }).svg;
    b += paragraph(400, y + 44, item[1], 640, 13.5, { fill: C.text, lineHeight: 20, maxLines: 5 });
  });

  b += rect(55, 890, 1013, 150, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(82, 934, 'Почему их не переименовали в «Новую»', 19, { fill: C.blue, weight: 700 });
  b += paragraph(82, 968, 'Слей мы «Назначена» с «Новой» одним словом, два разных состояния слились бы в ленте истории — ровно там, где их и различают. История переходов не переписывается ни строкой: она рассказывает, как заявка шла на самом деле, а не как она шла бы по сегодняшним правилам.', 950, 15, { fill: C.text, lineHeight: 22 });

  b += sectionTitle(55, 1094, 'Список отвечает на вопрос «что ждёт меня»');
  b += rect(55, 1122, 490, 318, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(82, 1164, 'Очереди над списком', 18, { fill: C.ink, weight: 700 });
  b += bullet(82, 1206, '«Все заявки» — весь список в вашей области.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1258, '«Требуют решения» — те, где ход за вами.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1310, '«Срочные» — с той самой галочкой и причиной.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1362, '«Ожидаются документы» — закрыть работы нечем.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += paragraph(82, 1412, 'Умолчание списка — сверху то, что ждёт дольше всех.', 436, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(578, 1122, 490, 318, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(605, 1164, 'Столбец «Ждёт»', 18, { fill: C.ink, weight: 700 });
  b += paragraph(605, 1198, 'Показывает возраст текущего ожидания, а не возраст статуса. Передали заявку другому исполнителю — счётчик пошёл заново, даже если статус не менялся.', 436, 14, { fill: C.muted, lineHeight: 21 });
  b += rect(605, 1284, 436, 132, { fill: C.bg, stroke: C.line, r: 10 });
  b += text(627, 1320, 'Одна «Новая» — два разных ожидания', 15, { fill: C.ink, weight: 700 });
  b += paragraph(627, 1348, 'Без исполнителей она ждёт распределения, с исполнителями — что за неё возьмутся. Подпись шага в карточке об этом и говорит.', 392, 13, { fill: C.muted, lineHeight: 19 });
  b += footer();
  return document(b);
}

function page10() {
  let b = header(
    10,
    'Объём работ',
    '9. Предъявление и подпись',
    'Раньше это называлось сметой. Сегодня «Объём работ» — не статус, а документ внутри заявки: исполнитель говорит, что и на какую сумму собирается сделать, а тот, кто ведёт заявку, соглашается или нет.',
  );

  b += rect(55, 222, 620, 470, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 268, 'Заявка СО-412', 21, { fill: C.ink, weight: 700 });
  b += tabs(82, 316, ['Заявка', 'Объём работ', 'Документы', 'История'], 'Объём работ', 566);
  const widths = [300, 90, 80, 96];
  b += tableHeader(82, 350, widths, ['Работа или деталь', 'Кол-во', 'Цена', 'Сумма']);
  b += tableRow(82, 392, widths, ['Замена термоблока', '1', '8 400', '8 400'], { height: 44, fill: '#fcfdff', size: 12, top: 27 });
  b += tableRow(82, 436, widths, ['Ролик захвата бумаги', '2', '950', '1 900'], { height: 44, size: 12, top: 27 });
  b += tableRow(82, 480, widths, ['Работа мастера', '2 ч', '1 200', '2 400'], { height: 44, fill: '#fcfdff', size: 12, top: 27 });
  b += text(82, 552, 'Итого: 12 700 ₽', 18, { fill: C.ink, weight: 700 });
  b += pill(300, 534, 'ЖДЁТ ПОДПИСИ', { fill: C.goldSoft, color: C.gold, stroke: '#ffe58f', size: 12 }).svg;
  b += button(82, 596, 250, 'Согласовать объём работ', { compact: true, primary: true });
  b += button(344, 596, 280, 'Не согласовать объём работ', { compact: true, danger: true });

  b += callout(705, 222, 363, 220, '1', 'Предъявляет исполнитель', 'Кнопка «Объём работ» в карточке: заполнил состав — предъявил. Пока предъявление висит, ни изменить его, ни предъявить второй раз нельзя, и передать заявку другому исполнителю тоже.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(705, 458, 363, 234, '2', 'Подписывают двое', 'Согласовать может «Ведение» либо поимённо назначенный исполнитель — так решил заказчик. Оператор сервисной компании исключён раньше обеих веток: объём предъявил он, и подпись под собственным счётом это не согласование, а его копия.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  b += rect(55, 720, 1013, 210, { fill: C.goldSoft, stroke: '#ffe58f', r: 16 });
  b += circle(100, 770, 24, { fill: C.gold });
  b += text(100, 778, '?', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(142, 764, 'Почему это не статус', 22, { fill: C.ink, weight: 700 });
  b += paragraph(142, 796, 'Прежняя «Смета на согласовании» означала не состояние работы, а ожидание нажатия кнопки. Аппарат не переставал быть сломанным, пока смотрят на сумму, и не чинился быстрее оттого, что заявка стоит в отдельном статусе.', 900, 15, { fill: C.text, lineHeight: 22 });
  b += paragraph(142, 872, 'Поэтому заявка остаётся «В работе», а то, что ждут подписи, портал показывает подписью шага и очередью «Требуют решения». Согласие статуса не меняет вовсе.', 900, 15, { fill: C.muted, lineHeight: 22 });

  b += sectionTitle(55, 986, 'Три исхода');
  const outcomes = [
    ['Согласовано', 'Заявка остаётся «В работе», ход возвращается к исполнителю. Подпись привязана к редакции объёма: предъявили заново — прежнее согласие уже не считается.', C.green, C.greenSoft, '#b7eb8f'],
    ['Не согласовано', 'Заявка уходит в «Отменена». Спрашивают два разных вопроса: причину — почему не согласны, и решение — что делаем вместо. Решение видно в карточке отменённой заявки.', C.red, C.redSoft, '#ffccc7'],
    ['Вернуть объём в правку', 'Отзывает предъявление и снимает подпись, если она уже стояла. Нажимает сторона исполнителя: после этого состав снова правят и предъявляют заново.', C.blue, C.bluePale, '#bae0ff'],
  ];
  outcomes.forEach((item, i) => {
    const x = 55 + i * 341;
    b += rect(x, 1018, 331, 246, { fill: item[3], stroke: item[4], r: 14 });
    b += text(x + 24, 1062, item[0], 19, { fill: item[2], weight: 700 });
    b += line(x + 24, 1080, x + 307, 1080, { stroke: item[4] });
    b += paragraph(x + 24, 1112, item[1], 283, 14, { fill: C.text, lineHeight: 21, maxLines: 8 });
  });

  b += rect(55, 1296, 1013, 146, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1338, 'У заявки на расходники объёма работ нет', 17, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1370, 'Картридж берут со своего склада: согласовывать по нему нечего и не у кого. Вместо объёма работ у этого вида — «Заполнить номенклатуру»: то же окно и та же кнопка исполнителя, только отвечает она на вопрос «что по заявке пойдёт».', 950, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page11() {
  let b = header(
    11,
    'Отмены, откаты и заморозка',
    '10. Когда что-то пошло не так',
    'Три разные вещи, и путать их дорого. Отмена закрывает заявку насовсем, заморозка останавливает её на время, откат отматывает ошибочное нажатие. Причину спрашивают там, где через месяц её будут искать.',
  );

  const blocks = [
    {
      x: 55,
      color: C.red,
      soft: C.redSoft,
      stroke: '#ffccc7',
      title: 'Отмена',
      lead: 'Кнопка «Отменить заявку». Ведёт в «Отменена» — конечный статус.',
      points: [
        'Отменяет тот, кто ведёт заявку: из «Новой», «В работе» и «Отложена».',
        'Причина обязательна всегда.',
        'Сам заказчик статусов не двигает — он просит отменить, а ход делает «Ведение».',
        'Сюда же ведёт «Не согласовать объём работ», и там спрашивают ещё и решение.',
      ],
    },
    {
      x: 396,
      color: C.gold,
      soft: C.goldSoft,
      stroke: '#ffe58f',
      title: 'Заморозка',
      lead: 'Кнопки «Отложить» и «Возобновить». Статус «Отложена».',
      points: [
        'Откладывают и возобновляют «Ведение» и ИТ-служба; оператору сервисной компании заморозка закрыта.',
        'Причина обязательна: даты «отложена до» у заморозки нет.',
        '«Возобновить» возвращает заявку в тот статус, из которого её отложили.',
        'Отложенная заявка не считается закрытой: вторую на тот же аппарат завести нельзя.',
      ],
    },
    {
      x: 737,
      color: C.purple,
      soft: C.purpleSoft,
      stroke: '#d3adf7',
      title: 'Откаты',
      lead: 'Отдельный доступ администратора портала поверх прав модуля.',
      points: [
        '«Вернуть в «Новую»» — отматывает «Принять в работу». Исполнители остаются на заявке.',
        '«Отменить приёмку» — возвращает закрытую в «Решена».',
        '«Вернуть в работу» — поднимает отменённую заявку обратно в «Новую».',
        'Чтобы сменить исполнителя, откат не нужен: для этого есть «Изменить исполнителей».',
      ],
    },
  ];

  blocks.forEach((block) => {
    b += rect(block.x, 222, 331, 640, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(block.x, 222, 331, 92, { fill: block.soft, r: 16 });
    b += rect(block.x, 290, 331, 24, { fill: block.soft });
    b += text(block.x + 24, 278, block.title, 24, { fill: block.color, weight: 700 });
    b += paragraph(block.x + 24, 344, block.lead, 283, 14, { fill: C.muted, lineHeight: 20, maxLines: 3 });
    block.points.forEach((point, i) => {
      b += bullet(block.x + 24, 424 + i * 108, point, 290, {
        color: block.color,
        size: 13.5,
        lineHeight: 19,
      });
    });
  });

  b += rect(55, 894, 1013, 210, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += text(82, 938, 'Отказ исполнителя — не отмена и не откат', 20, { fill: C.blue, weight: 700 });
  b += paragraph(82, 972, '«Отказаться от заявки» снимает с неё вас (или вашу компанию) и статуса не меняет: заявка остаётся «Новой» и ждёт нового распределения. Если исполнителей было трое, а отказался один, работа никуда не передана — счётчик ожидания не обнуляется.', 950, 15, { fill: C.text, lineHeight: 22 });
  b += paragraph(82, 1052, 'Отказа «я уже взялся, но передумал» в портале нет: такую заявку возвращает переназначение или откат «Вернуть в «Новую»».', 950, 14, { fill: C.muted, lineHeight: 21 });

  b += rect(55, 1136, 1013, 306, { fill: C.redSoft, stroke: '#ffccc7', r: 16 });
  b += circle(100, 1186, 24, { fill: C.red });
  b += text(100, 1194, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(142, 1180, 'Что необратимо', 22, { fill: C.ink, weight: 700 });
  b += paragraph(142, 1212, 'Почти всё в модуле отматывается — на то и откаты. Необратимых действий два, и оба про удаление, а не про статус.', 900, 15, { fill: C.text, lineHeight: 22 });
  b += rect(82, 1264, 470, 150, { fill: '#fff', stroke: '#ffccc7', r: 12 });
  b += text(106, 1302, '«Удалить окончательно» в архиве', 16, { fill: C.red, weight: 700 });
  b += paragraph(106, 1332, 'Удалённая заявка сперва уходит в архив, и оттуда её возвращает «Восстановить». Окончательное удаление из архива не отменяется ничем.', 424, 13.5, { fill: C.text, lineHeight: 20 });
  b += rect(571, 1264, 470, 150, { fill: '#fff', stroke: '#ffccc7', r: 12 });
  b += text(595, 1302, 'История переходов', 16, { fill: C.red, weight: 700 });
  b += paragraph(595, 1332, 'Лента не правится и не подчищается. Ошибочный ход исправляют новым ходом — он встанет в историю рядом, вместе с причиной.', 424, 13.5, { fill: C.text, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page12() {
  let b = header(
    12,
    'Заявка без аппарата',
    '11. Когда предмета в справочнике ещё нет',
    'Обычно заявка живёт на аппарате: его объектом и отделом она попадает в чью-то область видимости. Но работа бывает и без аппарата — «поставьте розетку» или «настройте почту новому сотруднику».',
  );

  b += rect(55, 226, 600, 470, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 272, 'Новая заявка на обслуживание', 21, { fill: C.ink, weight: 700 });
  b += input(82, 314, 546, 'Какой аппарат', 'Не выбран', { placeholder: true, suffix: '⌄' });
  b += paragraph(82, 392, 'Не выбран — заявка заведётся без аппарата, и заказчика придётся назвать самому', 546, 13, { fill: C.muted, lineHeight: 19 });
  b += input(82, 436, 546, 'Для кого заявка', 'Отдел кадров', { suffix: '⌄' });
  b += rect(82, 506, 546, 56, { fill: C.orangeSoft, stroke: '#ffd591', r: 8 });
  b += text(104, 541, 'Поле стало обязательным', 15, { fill: C.orange, weight: 700 });
  b += input(82, 588, 546, 'Описание', 'Настроить почту новому сотруднику', { height: 60 });

  b += callout(683, 226, 385, 220, '1', 'Кому это положено', 'Пропустить «Какой аппарат» могут только держатели наборов «Оргтехника: ведение» и «Оргтехника: ИТ-служба». Остальным поле обязательно, и это не строгость ради строгости — см. пункт 2.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(683, 462, 385, 234, '2', 'Заказчик — по своей оси', 'Роли площадки предлагаются её объекты, роли отдела — её отделы, ИТ-службе со сквозной областью — и то и другое. Иначе заявка ушла бы в чужую область и пропала бы у самого автора сразу после отправки.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });

  b += sectionTitle(55, 750, 'Как такая заявка выглядит дальше');
  const widths = [340, 673];
  b += tableHeader(55, 778, widths, ['Где', 'Что видно']);
  const rows = [
    ['В списке заявок', 'В столбце «Техника» стоит «Без аппарата» — словами, а не прочерком.'],
    ['В карточке', 'Строки «Где стоит» нет: у заявки нет аппарата, и место брать неоткуда.'],
    ['В гарантиях', 'Обращения по гарантии у неё не бывает: гарантия — свойство конкретного аппарата.'],
    ['В отборе ИТ-службы', 'Пометки «аппарат стоит не на том объекте» тоже не бывает: сравнивать не с чем.'],
    ['В области видимости', 'Заявка попадает в область только через заказчика — того самого, которого назвали в форме.'],
  ];
  rows.forEach((row, i) => {
    b += tableRow(55, 820 + i * 50, widths, row, {
      height: 50,
      fill: i % 2 === 0 ? '#fcfdff' : '#fff',
      size: 13,
      top: 23,
      lineHeight: 16,
      weights: [600],
    });
  });

  b += rect(55, 1104, 1013, 200, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += text(82, 1148, 'Почему рядовому заявителю аппарат обязателен', 20, { fill: C.green, weight: 700 });
  b += paragraph(82, 1182, 'Область видимости заявки считается по трём вещам: аппарату, его объекту и его отделу. Пока аппарат выбран, заявка попадает к нужным людям сама — даже если заказчиком случайно назвали не тот отдел. Без аппарата единственной опорой остаётся заказчик, и ошибка в нём означает заявку, которой не видит никто, включая её автора.', 950, 15, { fill: C.text, lineHeight: 22 });
  b += paragraph(82, 1284, 'Поэтому свободный выбор здесь и не открыт: ось предлагается та же, по которой человек и так работает.', 950, 14, { fill: C.muted, lineHeight: 21 });

  b += rect(55, 1330, 1013, 112, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1372, 'Заявку заводят и за сотрудника', 17, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1402, 'ИТ-служба нередко оформляет заявку сама — за того, кто позвонил. Тогда состав расходников она заполняет сразу, не дожидаясь распределения: два шага там, где хватает одного, никому не нужны.', 950, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page13() {
  let b = header(
    13,
    'Справочник расходников',
    '12. Картриджи и тонеры',
    'Позицию заводят, правят, гасят и удаляют в одном месте: «Справочники» → «Оргтехника» → «Картриджи и тонеры». Отдельная позиция — на каждый код и каждый цвет.',
  );

  b += rect(55, 224, 1013, 400, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 270, 'Картриджи и тонеры', 23, { fill: C.ink, weight: 700 });
  b += input(82, 300, 250, '', 'Наименование или код', { placeholder: true, height: 40 });
  b += input(345, 300, 230, '', 'Все модели', { placeholder: true, suffix: '⌄', height: 40 });
  b += pill(590, 292, '□  Нет в наличии', { fill: C.redSoft, color: C.red, stroke: '#ffccc7', size: 12 }).svg;
  b += pill(759, 292, '□  Только активные', { fill: C.greenSoft, color: C.green, stroke: '#b7eb8f', size: 12 }).svg;
  const widths = [148, 250, 100, 92, 100, 90, 106, 100];
  b += tableHeader(82, 348, widths, ['Код', 'Наименование', 'Цвет', 'Наличие', 'Потребность', 'Модели', 'Активность', 'Действия']);
  b += tableRow(82, 390, widths, ['Д0000337741', 'Тонер Ricoh 201 (шт)', '—', '12', '20', '3', 'Активен', '✎  №  ⏱  ×'], { height: 48, fill: '#fcfdff', top: 24, weights: [500, 600] });
  b += tableRow(82, 438, widths, ['Б0000014256', 'Картридж Ricoh Type 1270D', 'чёрный', '0', '6', '2', 'Активен', '✎  №  ⏱  ×'], { height: 48, top: 24, colors: [C.text, C.text, C.text, C.red] });
  b += tableRow(82, 486, widths, ['Д0000341142', 'Тонер Ricoh MP C2503', 'голубой', '2', '—', '1', 'Активен', '✎  №  ⏱  ×'], { height: 48, fill: '#fcfdff', top: 24 });
  b += tableRow(82, 534, widths, ['Д0000341143', 'Тонер Ricoh MP C2503', 'жёлтый', '0', '—', '1', 'Погашен', '✎  №  ⏱  ×'], { height: 48, top: 24, fill: C.graySoft, colors: [C.text, C.text, C.text, C.red, C.faint, C.text, C.faint] });
  b += button(815, 244, 226, 'Добавить расходник', { primary: true, compact: true, icon: '+' });
  b += paragraph(82, 604, 'Прочерк в «Цвете» — это ответ «у чёрно-белой позиции цвета не бывает», а не «не заполнили».', 900, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(55, 656, 600, 470, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 702, 'Новый картридж или тонер', 21, { fill: C.ink, weight: 700 });
  b += input(82, 736, 522, 'Код номенклатуры', 'Д0000341142');
  b += input(82, 820, 250, 'Цвет', 'голубой');
  b += input(354, 820, 250, 'Активность', 'Активен', { suffix: '⌄' });
  b += input(82, 904, 522, 'Наименование', 'Тонер Ricoh MP C2503 (шт)');
  b += input(82, 988, 522, 'Подходит к', 'Ricoh MP C2503 · Ricoh MP C2003', { suffix: '⌄' });
  b += paragraph(82, 1070, 'Можно оставить пустым и уточнить совместимость позже.', 522, 12, { fill: C.muted, lineHeight: 18 });

  b += callout(683, 656, 385, 150, '1', 'Код уникален', 'Пишите как в учётной системе. Лишние пробелы портал уберёт, регистр приведёт к единому.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(683, 822, 385, 150, '2', 'Цвет — отдельная позиция', 'Чёрный, голубой, пурпурный и жёлтый — разные коды и разные остатки. Комплект — тоже своя позиция.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(683, 988, 385, 138, '3', 'Совместимость кормит подбор', 'Именно связь с моделями отвечает на вопрос «чем заправлять этот аппарат».', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  b += rect(55, 1158, 490, 284, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += text(82, 1202, 'Гасите, а не удаляйте', 19, { fill: C.orange, weight: 700 });
  b += paragraph(82, 1236, 'Снятое «Активен» убирает позицию из подбора и из плановой закупки, но сохраняет остаток, совместимость и всю историю движений. Именно так поступают с кодом, который больше не покупают.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += paragraph(82, 1356, 'Удаление оставлено ошибочно заведённой строке — той, по которой ничего не было.', 436, 13.5, { fill: C.muted, lineHeight: 20 });

  b += rect(578, 1158, 490, 284, { fill: C.redSoft, stroke: '#ffccc7', r: 14 });
  b += text(605, 1202, 'Что не даст удалить или погасить', 19, { fill: C.red, weight: 700 });
  b += bullet(605, 1246, 'По позиции было движение остатка — журнал не подчищают.', 436, { color: C.red, size: 13.5, lineHeight: 19 });
  b += bullet(605, 1310, 'Позиция стоит в открытой закупке — портал назовёт её номер.', 436, { color: C.red, size: 13.5, lineHeight: 19 });
  b += bullet(605, 1374, 'Позиция стоит в любой закупке — удалить нельзя даже закрытую.', 436, { color: C.red, size: 13.5, lineHeight: 19 });
  b += footer();
  return document(b);
}

function page14() {
  let b = header(
    14,
    'Вкладка «Расходники»',
    '13. Рабочее место склада',
    'Здесь со складом работают: смотрят, чего не хватает, правят остаток и потребность, читают журнал и заводят закупку. Заведения, правки и удаления позиций тут нет — за ними в справочник.',
  );

  b += rect(55, 224, 1013, 466, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += rect(82, 262, 210, 40, { fill: C.graySoft, stroke: '#d9d9d9', r: 8 });
  b += rect(85, 265, 102, 34, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(136, 288, 'Позиции', 14, { fill: C.ink, weight: 600, anchor: 'middle' });
  b += text(240, 288, 'Закупки', 14, { fill: C.muted, anchor: 'middle' });
  b += button(839, 262, 202, 'Плановая закупка', { primary: true, compact: true, icon: '+' });
  b += input(82, 348, 230, '', 'Наименование или код', { placeholder: true, height: 40 });
  b += input(325, 348, 170, '', 'Все модели', { placeholder: true, suffix: '⌄', height: 40 });
  b += pill(510, 326, '☑  Есть дефицит', { fill: C.blueSoft, color: C.blue, stroke: '#91caff', size: 12 }).svg;
  b += pill(670, 326, '□  Нет в наличии', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 12 }).svg;
  b += pill(839, 326, '□  Только активные', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 12 }).svg;

  const widths = [128, 196, 84, 100, 104, 96, 132, 146];
  b += tableHeader(82, 396, widths, ['Код', 'Наименование', 'Наличие', 'Потребность', 'Уже заказано', 'К закупке', 'Правка остатка', 'Действия']);
  b += tableRow(82, 438, widths, ['Д0000337741', 'Тонер Ricoh 201', '12', '20', '4', '4', '24.08.2026 11:42', '№   ⛁   ⏱'], { height: 52, fill: '#fcfdff', top: 26, weights: [500, 600], colors: [C.text, C.text, C.text, C.text, C.text, C.orange] });
  b += tableRow(82, 490, widths, ['Б0000014256', 'Картридж Ricoh 1270D', '0', '6', '—', '6', '02.07.2026 16:20', '№   ⛁   ⏱'], { height: 52, top: 26, colors: [C.text, C.text, C.red, C.text, C.faint, C.orange] });
  b += tableRow(82, 542, widths, ['Д0000337810', 'Тонер Kyocera TK-3160', '4', '—', '—', '—', '—', '№   ⛁   ⏱'], { height: 52, fill: '#fcfdff', top: 26, colors: [C.text, C.text, C.text, C.faint, C.faint, C.faint, C.faint] });
  b += tableRow(82, 594, widths, ['Д0000341142', 'Тонер Ricoh MP C2503', '2', '8', '6', '—', '19.08.2026 09:05', '№   ⛁   ⏱'], { height: 52, top: 26, colors: [C.text, C.text, C.text, C.text, C.text, C.faint] });
  b += paragraph(82, 668, 'Действия строки: «№» — «Изменить остаток», «⛁» — «Потребность», «⏱» — «История остатка».', 900, 13, { fill: C.muted, lineHeight: 19 });

  b += sectionTitle(55, 740, 'Что означают столбцы');
  const cols = [
    ['Наличие', 'Сколько лежит на полке. Прямо в таблице не правится: остаток меняется событием с причиной, а не ячейкой.', C.blue, C.bluePale, '#bae0ff'],
    ['Потребность', 'Сколько позиции хотим держать на полке. Ноль означает «не следим»: такую позицию закупка не предложит.', C.purple, C.purpleSoft, '#d3adf7'],
    ['Уже заказано', 'Сколько стоит в открытых закупках — «Новых» и «В работе». Закрытая и отменённая не считаются.', C.orange, C.orangeSoft, '#ffd591'],
    ['К закупке', 'Потребность минус наличие минус уже заказанное, но не меньше нуля. Столько и предложит форма закупки.', C.green, C.greenSoft, '#b7eb8f'],
    ['Правка остатка', 'Когда остаток последний раз правили руками. Выдачи и возвраты по заявкам сюда не считаются; прочерк — «не трогали ни разу».', C.cyan, C.cyanSoft, '#87e8de'],
    ['В парке', 'Сколько подходящих аппаратов стоит в вашей области видимости. Ноль значит «у вас таких нет», а не «позиция ничему не подходит».', C.faint, C.graySoft, '#d9d9d9'],
  ];
  cols.forEach((col, i) => {
    const x = 55 + (i % 3) * 341;
    const y = 772 + Math.floor(i / 3) * 208;
    b += rect(x, y, 331, 190, { fill: col[3], stroke: col[4], r: 13 });
    b += text(x + 22, y + 42, col[0], 18, { fill: col[2] === C.faint ? C.muted : col[2], weight: 700 });
    b += line(x + 22, y + 58, x + 309, y + 58, { stroke: col[4] });
    b += paragraph(x + 22, y + 88, col[1], 287, 13.5, { fill: C.text, lineHeight: 20, maxLines: 6 });
  });

  b += rect(55, 1196, 1013, 126, { fill: C.bluePale, stroke: '#bae0ff', r: 13 });
  b += text(82, 1236, 'Срез, ради которого сюда и заходят', 17, { fill: C.blue, weight: 700 });
  b += paragraph(82, 1266, '«Есть дефицит» и «Нет в наличии» — разные вопросы. Позиция с потребностью 20 и остатком 5 в наличии есть, а заказывать её надо; позиция с нулевой потребностью и пустой полкой в наличии отсутствует, но дефицита у неё нет — за ней не следят.', 950, 14, { fill: C.text, lineHeight: 21 });

  b += rect(55, 1336, 1013, 106, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1376, 'Переключатель «Позиции / Закупки»', 17, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1404, 'Вторая половина вкладки — список плановых закупок; она открыта только тому, кто их ведёт. Кнопка «Плановая закупка» видна из обеих половин: закупку заводят, глядя на дефицит.', 950, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page15() {
  let b = header(
    15,
    'Остаток и его история',
    '14. Число, у которого есть причина',
    'Остаток — не редактируемое поле, а последовательность событий. Портал спрашивает новое значение и объяснение, и оба встают в журнал позиции.',
  );

  b += rect(55, 224, 470, 520, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 272, 'Остаток: Тонер Ricoh 201', 21, { fill: C.ink, weight: 700 });
  b += input(82, 320, 386, 'Стало', '18');
  b += input(82, 428, 386, 'Причина', 'Поступление по счёту 1245', { height: 62 });
  b += paragraph(82, 528, 'Куда ушло или откуда пришло: «выдано на АЛ13», «поступление по счёту 1245».', 386, 12.5, { fill: C.muted, lineHeight: 19 });
  b += rect(82, 572, 386, 92, { fill: C.orangeSoft, stroke: '#ffd591', r: 9 });
  b += text(104, 606, 'Если число изменил другой', 14, { fill: C.orange, weight: 700 });
  b += paragraph(104, 632, 'Портал покажет новое текущее значение и попросит свериться перед сохранением.', 342, 12, { fill: C.text, lineHeight: 17 });
  b += button(224, 682, 100, 'Отмена');
  b += button(338, 682, 130, 'Сохранить', { primary: true });

  b += rect(558, 224, 510, 520, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(585, 272, 'История остатка', 21, { fill: C.ink, weight: 700 });
  b += text(585, 296, 'Д0000337741 · Тонер Ricoh 201', 13, { fill: C.muted });
  b += rect(585, 314, 456, 38, { fill: C.graySoft, stroke: '#d9d9d9', r: 8 });
  b += rect(588, 317, 100, 32, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(638, 338, 'Все', 13, { fill: C.ink, weight: 600, anchor: 'middle' });
  b += text(742, 338, 'Ручные правки', 13, { fill: C.muted, anchor: 'middle' });
  b += text(860, 338, 'Выдачи', 13, { fill: C.muted, anchor: 'middle' });
  b += text(970, 338, 'Возвраты', 13, { fill: C.muted, anchor: 'middle' });

  const entries = [
    ['24.08.2026 11:42', '12 → 18', 'Поступление по счёту 1245', 'Иванов И. И. · Штаб · Оргтехника: номенклатура', C.green],
    ['21.08.2026 09:14', '13 → 12', 'Выдача по заявке СО-398', 'Заявка открывается по ссылке', C.blue],
    ['14.08.2026 16:05', '10 → 13', 'Возврат по заявке СО-390', 'Номер без ссылки: заявка вам не видна', C.faint],
  ];
  entries.forEach((entry, i) => {
    const y = 376 + i * 104;
    b += rect(585, y, 456, 92, { fill: '#fcfdff', stroke: C.line, r: 10 });
    b += text(605, y + 30, entry[0], 13, { fill: C.muted });
    b += text(1021, y + 30, entry[1], 16, { fill: entry[4], weight: 700, anchor: 'end' });
    b += text(605, y + 54, entry[2], 14, { fill: C.ink, weight: 600 });
    b += text(605, y + 76, entry[3], 12, { fill: C.faint });
  });
  b += text(585, 716, '1–50 из 128 · страницами, сверху последние события', 12.5, { fill: C.muted });

  b += sectionTitle(55, 806, 'Что нужно знать про журнал');
  b += callout(55, 838, 331, 200, '1', 'Журнал по одной позиции', 'Общего журнала по всем расходникам нет: ленту открывают кнопкой в строке той позиции, чей остаток разбирают.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(396, 838, 331, 200, '2', 'Ссылка на заявку честная', 'Номер заявки стоит всегда, а ссылкой становится только тогда, когда смотрящий эту заявку может открыть. Иначе номер остаётся текстом.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(737, 838, 331, 200, '3', 'Подпись — сегодняшняя', 'Роль и наборы полномочий у автора события показаны нынешние: кем человек был на момент правки, портал не хранит.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  b += rect(55, 1070, 1013, 174, { fill: C.cyanSoft, stroke: '#87e8de', r: 16 });
  b += text(82, 1114, 'Ручная правка и движение по заявке — разные события', 20, { fill: C.cyan, weight: 700 });
  b += paragraph(82, 1148, 'Выдача картриджа по заявке уменьшает остаток сама, когда исполнитель отмечает выдачу при закрытии работ. В столбец «Правка остатка» такие события не попадают: он отвечает на вопрос «когда мы сами пересчитывали полку», и разница между «менялся» и «правили руками» — это весь смысл столбца.', 950, 15, { fill: C.text, lineHeight: 22 });

  b += rect(55, 1272, 1013, 170, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1314, 'Кому что открыто', 17, { fill: C.ink, weight: 700 });
  b += bullet(82, 1354, 'Читают журнал все, кому видна сама позиция: своего доступа у ленты нет.', 470, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(565, 1354, 'Правят остаток — только держатели набора «Оргтехника: номенклатура».', 470, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(82, 1406, 'Причина обязательна и короче трёх знаков не принимается.', 470, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(565, 1406, 'Событие «0 → 0» журнал не пропускает: менять нечего.', 470, { color: C.green, size: 14, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page16() {
  let b = header(
    16,
    'Потребность и дефицит',
    '15. Сколько держать на полке',
    'Потребность — это план, а не факт: сколько позиции хотим видеть на складе. Она плавающая и правится по обстоятельствам. Из неё, остатка и уже заказанного портал считает, сколько предложить в закупку.',
  );

  b += rect(55, 224, 470, 330, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 272, 'Потребность: Тонер Ricoh 201', 20, { fill: C.ink, weight: 700 });
  b += text(82, 316, 'На складе: 12', 14, { fill: C.muted });
  b += text(250, 316, 'Уже заказано: 4', 14, { fill: C.muted });
  b += text(400, 316, 'К закупке: 4', 14, { fill: C.green, weight: 700 });
  b += input(82, 348, 386, 'Сколько держать на полке', '20');
  b += paragraph(82, 442, 'Ноль означает «не следим»: такую позицию плановая закупка не предложит, даже если полка пуста.', 386, 12.5, { fill: C.muted, lineHeight: 19 });
  b += button(224, 492, 100, 'Отмена');
  b += button(338, 492, 130, 'Сохранить', { primary: true });

  b += rect(558, 224, 510, 330, { fill: C.bg, stroke: C.line, r: 16 });
  b += text(585, 272, 'Как считается «К закупке»', 20, { fill: C.ink, weight: 700 });
  b += rect(585, 300, 456, 92, { fill: '#fff', stroke: '#bae0ff', r: 12 });
  b += text(813, 340, 'потребность − наличие − уже заказано', 19, { fill: C.blue, weight: 700, anchor: 'middle' });
  b += text(813, 370, 'и никогда не меньше нуля', 14, { fill: C.muted, anchor: 'middle' });
  b += paragraph(585, 424, 'Уже заказанное вычитается специально: без этого портал звал бы заказать второй раз то, что уже везут. Именно поэтому закрытая закупка перестаёт вычитаться — считается, что приход по ней уже занесён.', 456, 14, { fill: C.text, lineHeight: 21 });

  b += sectionTitle(55, 606, 'Четыре позиции и что с ними делать');
  const widths = [270, 120, 140, 140, 343];
  b += tableHeader(55, 634, widths, ['Позиция', 'Наличие', 'Потребность', 'Уже заказано', 'К закупке и почему']);
  const rows = [
    ['Тонер Ricoh 201', '12', '20', '4', '4 — потребность закрыта не полностью', C.green],
    ['Картридж Ricoh 1270D', '0', '6', '—', '6 — полка пуста, ничего не заказано', C.red],
    ['Тонер Kyocera TK-3160', '4', '—', '—', '— за позицией не следят: потребность ноль', C.faint],
    ['Тонер Ricoh MP C2503', '2', '8', '6', '— уже везут ровно столько, сколько не хватает', C.muted],
  ];
  rows.forEach((row, i) => {
    b += tableRow(55, 676 + i * 58, widths, row.slice(0, 5), {
      height: 58,
      fill: i % 2 === 0 ? '#fcfdff' : '#fff',
      size: 13,
      top: 26,
      lineHeight: 17,
      weights: [600],
      colors: [C.ink, C.text, C.text, C.text, row[5]],
    });
  });

  b += rect(55, 936, 490, 240, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += text(82, 980, 'Ноль — это решение, а не пустота', 19, { fill: C.orange, weight: 700 });
  b += paragraph(82, 1014, 'У позиции с нулевой потребностью дефицита не бывает никогда, и в форму закупки она не попадает. Так помечают то, что покупают под конкретный случай, а не держат на полке.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += paragraph(82, 1112, 'В таблице такой ноль показан прочерком: «не следим», а не «нужно ноль штук».', 436, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(578, 936, 490, 240, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(605, 980, 'Потребность правят, глядя на три числа', 19, { fill: C.blue, weight: 700 });
  b += paragraph(605, 1014, 'Окно «Потребность» показывает наличие, уже заказанное и текущий дефицит рядом с полем: держать их в голове или возвращаться в таблицу не нужно.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += paragraph(605, 1112, 'Кто правит потребность — тот же, кто ведёт номенклатуру.', 436, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(55, 1208, 1013, 234, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 1252, 'Зачем вообще потребность, если есть остаток', 20, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1286, 'Пустой остаток не говорит, надо ли заказывать: у одной позиции ноль — это авария, у другой — норма. Потребность отвечает на этот вопрос один раз и за всех, и именно она превращает перечень картриджей в план закупки.', 950, 15, { fill: C.text, lineHeight: 22 });
  b += paragraph(82, 1362, 'В карточке позиции потребность стоит обычным полем; на вкладке «Расходники» её правят отдельным действием строки — там, где на дефицит и смотрят.', 950, 14, { fill: C.muted, lineHeight: 21 });
  b += footer();
  return document(b);
}

function page17() {
  let b = header(
    17,
    'Плановая закупка',
    '16. Документ для снабжения',
    'Закупка — не третий вид заявки, а самостоятельный документ со своим номером «ЗК-». У неё нет площадки и отдела: остаток расходников один на компанию, и заказ по дефициту тоже общий.',
  );

  const cycle = [
    ['Новая', 'черновик: состав правится', C.blue, C.blueSoft],
    ['В работе', 'бумага передана снабжению', C.orange, C.orangeSoft],
    ['Закрыта', 'привезли, приход занесён', C.green, C.greenSoft],
  ];
  cycle.forEach((item, i) => {
    const x = 95 + i * 305;
    b += statusBox(x, 250, 230, 110, item[0], item[1], { color: item[2], soft: item[3] });
    if (i < 2) {
      b += arrow(x + 230, 305, x + 300, 305, { stroke: C.faint, sw: 3 });
      b += edgeLabel(x + 265, 232, i === 0 ? '«Провести»' : '«Закрыть»', null, { color: C.text });
    }
  });
  b += statusBox(400, 430, 230, 90, 'Отменена', 'снята с причиной', { color: C.red, soft: C.redSoft, stroke: '#ffccc7' });
  b += arrow(210, 362, 400, 460, { stroke: '#ffa39e', sw: 2, dash: '6 5' });
  b += arrow(515, 362, 515, 428, { stroke: '#ffa39e', sw: 2, dash: '6 5' });
  b += paragraph(660, 452, 'Отменить можно из «Новой» и «В работе», причина обязательна: «заказали напрямую у поставщика по счёту 1245».', 400, 13.5, { fill: C.text, lineHeight: 20 });
  b += paragraph(660, 520, 'Закрытая и отменённая — конечные: ошибку исправляют новой закупкой.', 400, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(55, 558, 1013, 440, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 604, 'Плановая закупка', 22, { fill: C.ink, weight: 700 });
  b += text(82, 630, 'Форма открывается уже заполненной: в ней те позиции, у которых есть дефицит', 13, { fill: C.muted });
  const widths = [265, 375, 140, 179];
  b += tableHeader(82, 650, widths, ['Позиция', 'Из чего сложилось', 'Предложено', 'Заказываем']);
  b += tableRow(82, 692, widths, ['Тонер Ricoh 201', 'потребность 20 − наличие 12 − заказано 4', '4', '4'], { height: 52, fill: '#fcfdff', top: 26, size: 13, weights: [600] });
  b += tableRow(82, 744, widths, ['Картридж Ricoh 1270D', 'потребность 6 − наличие 0', '6', '6'], { height: 52, top: 26, size: 13, weights: [600] });
  b += tableRow(82, 796, widths, ['Тонер HP 106A', 'потребность 4 − наличие 1', '3', '10'], { height: 52, fill: '#fcfdff', top: 26, size: 13, weights: [600], colors: [C.ink, C.text, C.text, C.orange] });
  b += text(82, 884, 'Итого позиций: 3', 15, { fill: C.ink, weight: 700 });
  b += text(240, 884, 'Заказать больше, чем предлагает портал, можно — это ваше решение', 13, { fill: C.muted });
  b += input(82, 928, 470, '', 'Дописать позицию (только действующие)', { placeholder: true, height: 42, suffix: '⌄' });
  b += input(572, 928, 300, '', 'К чему закупка — необязательно', { placeholder: true, height: 42 });
  b += button(874, 946, 168, 'Завести закупку', { compact: true, primary: true });

  b += rect(55, 1026, 490, 190, { fill: C.purpleSoft, stroke: '#d3adf7', r: 14 });
  b += text(82, 1070, 'Чего у закупки нет', 19, { fill: C.purple, weight: 700 });
  b += paragraph(82, 1104, 'Ни вложений, ни обсуждения, ни срочности, ни заморозки, ни писем. В общем списке заявок её тоже нет — это другой документ. Счёт от поставщика подшивают в учётной системе.', 436, 14, { fill: C.text, lineHeight: 21 });

  b += rect(578, 1026, 490, 190, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(605, 1070, 'Кому она видна', 19, { fill: C.blue, weight: 700 });
  b += paragraph(605, 1104, 'По набору «Оргтехника: ведение», и только по нему: у документа нет площадки и отдела, а значит и области видимости, по которой его можно было бы делить.', 436, 14, { fill: C.text, lineHeight: 21 });

  b += rect(55, 1244, 1013, 198, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 1288, 'Что можно делать с закупкой и когда', 20, { fill: C.ink, weight: 700 });
  b += bullet(82, 1330, '«Править» — только в «Новой»: после проведения бумага уже у снабжения.', 470, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(565, 1330, '«Провести» — передать состав снабжению; закупка становится «В работе».', 470, { color: C.orange, size: 14, lineHeight: 20 });
  b += bullet(82, 1394, '«Закрыть» — только из «В работе» и только с подтверждением (стр. 18).', 470, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(565, 1394, '«Отменить» — из «Новой» и «В работе», с обязательной причиной.', 470, { color: C.red, size: 14, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page18() {
  let b = header(
    18,
    'Сначала приход, потом закрытие',
    '17. Единственное правило, которое портал не проверяет',
    'Закупка не двигает остаток: она бумага для снабжения, а приход заводят ручной правкой остатка. Порядок этих двух действий обязателен, и держит его человек, а не проверка.',
  );

  b += rect(55, 224, 600, 480, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 270, 'Закрыть закупку ЗК-14', 21, { fill: C.ink, weight: 700 });
  b += rect(82, 292, 546, 106, { fill: C.bluePale, stroke: '#bae0ff', r: 10 });
  b += circle(112, 322, 13, { fill: C.blue });
  b += text(112, 328, 'i', 15, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(136, 328, 'Сначала приход, потом закрытие', 15, { fill: C.blue, weight: 700 });
  b += paragraph(136, 352, 'Занесите приход ручной правкой остатка и только потом закрывайте: закрытая перестаёт вычитаться из дефицита.', 470, 12.5, { fill: C.text, lineHeight: 18 });
  const widths = [280, 130, 136];
  b += tableHeader(82, 414, widths, ['Позиция', 'Заказано', 'На складе сейчас']);
  b += tableRow(82, 456, widths, ['Тонер Ricoh 201', '4', '18'], { height: 46, fill: '#fcfdff', top: 27, size: 13 });
  b += tableRow(82, 502, widths, ['Картридж Ricoh 1270D', '6', '6'], { height: 46, top: 27, size: 13 });
  b += rect(82, 570, 22, 22, { fill: C.blue, stroke: C.blue, r: 4 });
  b += check(87, 581, '#fff');
  b += text(116, 588, 'Приход по этой закупке занесён в остатки', 15, { fill: C.text, weight: 500 });
  b += paragraph(82, 616, 'Портал не может это проверить и не притворяется, что может: остаток не доказывает, по какой закупке он вырос.', 546, 12.5, { fill: C.muted, lineHeight: 18 });
  b += button(456, 648, 172, 'Закрыть закупку', { compact: true, primary: true });

  b += rect(683, 224, 385, 480, { fill: C.bg, stroke: C.line, r: 16 });
  b += text(710, 270, 'Порядок из двух шагов', 20, { fill: C.ink, weight: 700 });
  b += numberDot('1', 740, 336, { fill: C.green, radius: 22 });
  b += text(780, 328, 'Занести приход', 18, { fill: C.ink, weight: 700 });
  b += paragraph(780, 356, 'Кнопкой «Изменить остаток» в перечне расходников: новое количество и причина со ссылкой на счёт.', 262, 13, { fill: C.muted, lineHeight: 19 });
  b += line(740, 386, 740, 470, { stroke: C.faint, sw: 2, dash: '5 5' });
  b += numberDot('2', 740, 502, { fill: C.blue, radius: 22 });
  b += text(780, 494, 'Закрыть закупку', 18, { fill: C.ink, weight: 700 });
  b += paragraph(780, 522, 'Кнопка «Закрыть» в карточке ЗК и галочка-подтверждение. После этого закупка перестаёт вычитаться из дефицита.', 262, 13, { fill: C.muted, lineHeight: 19 });
  b += rect(710, 596, 332, 84, { fill: '#fff', stroke: C.line, r: 10 });
  b += paragraph(730, 626, 'Оба шага делает один и тот же человек — тот, кто ведёт модуль.', 292, 13, { fill: C.text, lineHeight: 19 });

  b += rect(55, 736, 1013, 226, { fill: C.redSoft, stroke: '#ffccc7', r: 16 });
  b += circle(100, 786, 24, { fill: C.red });
  b += text(100, 794, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(142, 780, 'Что будет, если закрыть раньше, чем занесли приход', 22, { fill: C.ink, weight: 700 });
  b += paragraph(142, 812, 'Закрытая закупка перестаёт считаться «уже заказанным». Дефицит по позиции тут же вырастет обратно, форма плановой закупки предложит её снова — и её закажут второй раз. Ошибка тихая: портал не отличит новую потребность от незанесённого прихода.', 900, 15, { fill: C.text, lineHeight: 22 });
  b += paragraph(142, 906, 'Лечится это тем же ручным приходом: занесите поступившее количество, и дефицит сойдётся сам.', 900, 14, { fill: C.muted, lineHeight: 21 });

  b += sectionTitle(55, 1010, 'Почему проверить это нельзя');
  b += paragraph(55, 1044, 'Между тем, как закупку провели, и тем, как её закрывают, остаток живёт своей жизнью: по нему шли выдачи по заявкам, ручные корректировки и, возможно, приход по соседней закупке. Выросшее число не доказывает, что выросло оно именно по этой бумаге, — поэтому портал спрашивает подтверждение человека, а не считает сам. Галочка делает ровно две вещи: заставляет прочитать правило в момент, когда оно применяется, и оставляет имя того, кто это утверждал.', 1013, 15, { fill: C.text, lineHeight: 23 });

  b += rect(55, 1176, 490, 266, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(82, 1220, 'Позицию в открытой закупке не погасить', 18, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1252, '«Больше не покупаем» и «уже заказали и ждём» — прямое противоречие. Портал назовёт номер: «По позиции открыта закупка ЗК-14 — закройте или отмените её».', 436, 14, { fill: C.muted, lineHeight: 21 });
  b += paragraph(82, 1350, 'Номер в тексте и есть ответ: идти надо именно в эту закупку.', 436, 13, { fill: C.text, lineHeight: 20 });

  b += rect(578, 1176, 490, 266, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(605, 1220, 'Позицию из любой закупки не удалить', 18, { fill: C.ink, weight: 700 });
  b += paragraph(605, 1252, 'Здесь строже: держат и закрытая, и отменённая. Документ не должен указывать на пустоту — иначе через год состав закупки нечем будет прочитать.', 436, 14, { fill: C.muted, lineHeight: 21 });
  b += paragraph(605, 1350, 'Если позиция больше не нужна — снимите «Активен», а не удаляйте.', 436, 13, { fill: C.text, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page19() {
  let b = header(
    19,
    'Гарантии, архив и техника',
    '18. Остальные вкладки раздела',
    'Три вкладки, на которые заходят реже, но за конкретным ответом. Все три показывают то же, что и заявки, — только под другим углом.',
  );

  const panels = [
    {
      x: 55,
      color: C.cyan,
      soft: C.cyanSoft,
      stroke: '#87e8de',
      title: 'Гарантии',
      lead: 'Что ещё покрыто гарантией — и техника, и выполненные ремонты.',
      points: [
        'Срезы «Только техника» и «Только ремонты»: у гарантии два разных носителя.',
        'Отбор по объекту, отделу и типу техники — как в остальных списках модуля.',
        'Отдельно показываются истекающие: их видно заранее, а не задним числом.',
        'Из строки реестра заводится обращение по гарантии — заявка на обслуживание с уже проставленным основанием.',
      ],
    },
    {
      x: 396,
      color: C.faint,
      soft: C.graySoft,
      stroke: '#d9d9d9',
      title: 'Архив',
      lead: 'Удалённые заявки и два действия над ними.',
      points: [
        'Вкладка видна не всем: нужен отдельный доступ к архиву поверх права на заявки.',
        '«Восстановить» возвращает заявку в рабочий список в том же виде.',
        '«Удалить окончательно» — единственное необратимое действие модуля.',
        'Своя вкладка, а не флажок в списке: архивную строку нельзя ни вести, ни закрыть, и в рабочем списке она только мешает.',
      ],
    },
    {
      x: 737,
      color: C.green,
      soft: C.greenSoft,
      stroke: '#b7eb8f',
      title: 'Техника',
      lead: 'Парк глазами того, кто ведёт заявки: где что стоит.',
      points: [
        'Отборы: объект, тип, отдел, состояние и гарантия — «Действует», «Истекает», «Истекла».',
        'Срез «В ремонте без заявок» — аппараты, про которые забыли завести заявку.',
        'Отсюда записывают перемещение техники и читают её историю.',
        'Заведения и правки карточек здесь нет: за ними в «Справочники» — см. стр. 3.',
      ],
    },
  ];

  panels.forEach((panel) => {
    b += rect(panel.x, 224, 331, 640, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(panel.x, 224, 331, 96, { fill: panel.soft, r: 16 });
    b += rect(panel.x, 296, 331, 24, { fill: panel.soft });
    b += text(panel.x + 24, 274, panel.title, 24, { fill: panel.color === C.faint ? C.muted : panel.color, weight: 700 });
    b += paragraph(panel.x + 24, 350, panel.lead, 283, 14, { fill: C.muted, lineHeight: 20, maxLines: 3 });
    panel.points.forEach((point, i) => {
      b += bullet(panel.x + 24, 428 + i * 110, point, 290, {
        color: panel.color === C.faint ? C.muted : panel.color,
        size: 13.5,
        lineHeight: 19,
      });
    });
  });

  b += rect(55, 896, 1013, 190, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += text(82, 940, 'Обсуждение, документы и история — внутри карточки заявки', 20, { fill: C.blue, weight: 700 });
  b += paragraph(82, 974, 'В карточке живут вкладки «Заявка», «Объём работ» (или «Номенклатура» у расходников), «Документы» и «История», а рядом с действиями — «Обсуждение»: лента сообщений с адресатами. Документы подшивают через «Фото и документы» при заведении и на вкладке «Документы» после него, где у каждого файла есть вид: акт, счёт, гарантийный талон.', 950, 15, { fill: C.text, lineHeight: 22 });

  b += rect(55, 1118, 490, 324, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(82, 1162, 'Что ещё есть в модуле', 19, { fill: C.ink, weight: 700 });
  b += bullet(82, 1204, 'История обслуживания прямо в карточке аппарата.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1256, 'Отчёт по расходу расходников за период.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1308, 'Повторная отправка письма службе — если задание потерялось.', 436, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(82, 1372, 'Запись перемещения техники прямо из карточки заявки.', 436, { color: C.blue, size: 14, lineHeight: 20 });

  b += rect(578, 1118, 490, 324, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += text(605, 1162, 'Аппарат стоит не на том объекте', 19, { fill: C.orange, weight: 700 });
  b += paragraph(605, 1196, 'Если заявитель отметил, что аппарат стоит не там, где записано в карточке, заявка получает пометку. Справочник она не правит: перенос единицы — решение ИТ-службы после проверки, а не следствие галочки в заявке.', 436, 14, { fill: C.text, lineHeight: 21 });
  b += paragraph(605, 1322, 'Пометка гаснет сама, когда карточку поправили: она сравнивает объект заявки с сегодняшней карточкой, а не хранит вечное «когда-то не совпало».', 436, 13.5, { fill: C.muted, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page20() {
  let b = header(
    20,
    'Что делать, если',
    '19. Частые тупики',
    'Шесть случаев, в которых портал ведёт себя правильно, а выглядит это как поломка. Во всех шести ответ один: посмотреть, чего именно не хватает — доступа, назначения или соседнего действия.',
  );

  const cases = [
    {
      color: C.blue,
      soft: C.bluePale,
      stroke: '#bae0ff',
      title: 'Заявки не видно в списке',
      body: 'Список показывает только вашу область. Заявка на аппарате попадает в неё через объект и отдел аппарата, заявка без аппарата — только через заказчика. Проверьте, того ли заказчика назвали, и не ушла ли заявка в архив.',
    },
    {
      color: C.purple,
      soft: C.purpleSoft,
      stroke: '#d3adf7',
      title: 'В карточке нет нужной кнопки',
      body: 'Действия открываются тремя вещами сразу: набором полномочий, назначением на эту заявку и её статусом. «Принять в работу» появится только у назначенного, «Принять работу» — только у «Ведения» и только в «Решена».',
    },
    {
      color: C.orange,
      soft: C.orangeSoft,
      stroke: '#ffd591',
      title: '«Закрыть работы» неактивна',
      body: 'У ремонта сервисной компанией нужен закрывающий документ. Подшейте акт, счёт или гарантийный талон на вкладке «Документы» — кнопка оживёт. Подсказка о том же написана рядом с ней.',
    },
    {
      color: C.green,
      soft: C.greenSoft,
      stroke: '#b7eb8f',
      title: 'Позицию не удалить и не погасить',
      body: 'Мешает либо движение остатка (журнал не подчищают), либо закупка. Портал называет её номер: откройте ЗК, закройте или отмените — и повторите. Если позиция просто больше не нужна, снимите «Активен».',
    },
    {
      color: C.cyan,
      soft: C.cyanSoft,
      stroke: '#87e8de',
      title: 'Форма закупки открылась пустой',
      body: '«Заказывать нечего»: по действующим позициям дефицита нет — потребность закрыта остатком и открытыми закупками. Пустую закупку портал не заводит; если заказ всё же нужен, допишите позицию подбором в самой форме.',
    },
    {
      color: C.red,
      soft: C.redSoft,
      stroke: '#ffccc7',
      title: 'Портал говорит, что числа изменились',
      body: 'Пока форма была открыта, склад изменился. Новые числа уже проставлены в строках рядом с прежними: проверьте количества и отправьте ещё раз. Заказать больше, чем предлагает портал, можно — это и будет вашим подтверждением.',
    },
  ];

  cases.forEach((item, i) => {
    const x = 55 + (i % 2) * 517;
    const y = 226 + Math.floor(i / 2) * 232;
    b += rect(x, y, 496, 214, { fill: item.soft, stroke: item.stroke, r: 14 });
    b += circle(x + 46, y + 48, 22, { fill: item.color });
    b += text(x + 46, y + 56, '?', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += paragraph(x + 82, y + 42, item.title, 380, 18, { fill: C.ink, weight: 700, lineHeight: 24, maxLines: 2 });
    b += paragraph(x + 30, y + 108, item.body, 436, 13.5, { fill: C.text, lineHeight: 20, maxLines: 5 });
  });

  b += rect(55, 934, 1013, 216, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 978, 'Ещё три сообщения, которые не означают поломку', 20, { fill: C.ink, weight: 700 });
  b += bullet(82, 1020, '«Черновик изменил другой человек» — закупку правил кто-то ещё; перечитайте состав и сохраните заново.', 950, { color: C.muted, size: 14, lineHeight: 20 });
  b += bullet(82, 1072, '«Пока окно было открыто, остаток изменил другой человек» — сверьтесь с новым числом и повторите правку.', 950, { color: C.muted, size: 14, lineHeight: 20 });
  b += bullet(82, 1124, '«Закупку уже провели» — состояние документа изменилось, пока карточка была открыта; обновите её.', 950, { color: C.muted, size: 14, lineHeight: 20 });

  b += rect(55, 1182, 1013, 260, { fill: C.bg, stroke: C.line, r: 16 });
  b += text(82, 1226, 'Куда идти дальше', 20, { fill: C.ink, weight: 700 });
  b += bullet(82, 1268, 'Набора полномочий нет — его выдаёт администратор портала поимённо, в карточке учётки.', 470, { color: C.blue, size: 14, lineHeight: 20 });
  b += bullet(565, 1268, 'Позиции нет в справочнике — её заводят в «Картриджи и тонеры», а не на вкладке.', 470, { color: C.purple, size: 14, lineHeight: 20 });
  b += bullet(82, 1332, 'Аппарата нет в справочнике — его заводят в «Справочники» → «Оргтехника».', 470, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(565, 1332, 'Заявку завели не на то — её отменяет «Ведение», причина обязательна.', 470, { color: C.orange, size: 14, lineHeight: 20 });
  b += paragraph(82, 1400, 'Руководства портала лежат в служебном меню: там же обновляется и это.', 950, 13.5, { fill: C.muted, lineHeight: 20 });
  b += footer();
  return document(b);
}

const pages = [
  page1(),
  page2(),
  page3(),
  page4(),
  page5(),
  page6(),
  page7(),
  page8(),
  page9(),
  page10(),
  page11(),
  page12(),
  page13(),
  page14(),
  page15(),
  page16(),
  page17(),
  page18(),
  page19(),
  page20(),
];

for (const [index, svg] of pages.entries()) {
  const stem = `office-equipment-manual-${String(index + 1).padStart(2, '0')}`;
  const svgPath = join(WORK, `${stem}.svg`);
  const pngPath = join(WORK, `${stem}.png`);
  writeFileSync(svgPath, svg);
  const rendered = spawnSync(
    'python3',
    [resolve('docs/render-svg-to-png.py'), svgPath, pngPath, String(W)],
    { encoding: 'utf8' },
  );
  if (rendered.status !== 0) {
    throw new Error(`Страница ${index + 1} не отрисовалась:\n${rendered.stdout}\n${rendered.stderr}`);
  }
}

const pdf = await PDFDocument.create();
pdf.setTitle('Орг.техника — полное руководство пользователя');
pdf.setSubject('Раздел «Орг.техника»: заявки, наборы полномочий, расходники и плановые закупки');
pdf.setKeywords(['оргтехника', 'заявки', 'расходники', 'картриджи', 'закупка', 'руководство']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG manual generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-01T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `office-equipment-manual-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
