import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Памятка ИТ-специалисту по модулю «Орг.техника» — отдельный PDF, третий в семье руководств
 * (`generate-office-equipment-guide.mjs` — полное, памятка заявителю — соседнее).
 *
 * Читатель один и очень определённый: сисадмин с набором «Оргтехника: ИТ-служба». Он работает
 * ИСПОЛНИТЕЛЕМ на заявках, где назначен поимённо, и всё, чего у него нет, названо здесь прямо —
 * человек у стойки не должен искать кнопку, которой ему не выдадут.
 *
 * Приёмы рисования те же, что у соседей: страницы собираются строками SVG, рендерятся librsvg
 * (`docs/render-svg-to-png.py`) и склеиваются pdf-lib в A4. Палитра и помощники повторены
 * намеренно — три документа должны читаться как один комплект.
 */

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Памятка_Оргтехника_ИТ-специалисту.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'office-equipment-it-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 6;
const RELEASE = '01.09.2026';

const C = {
  ink: '#172033',
  text: '#2f3440',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e7eaf0',
  bg: '#f5f7fb',
  blue: '#1677ff',
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
  // Ширина строки считается по средней букве, и запас здесь намеренный: кириллица DejaVu шире
  // латиницы, а перенос, случившийся на печати, а не в расчёте, уводит текст за поле страницы.
  const factor = weight >= 600 ? 0.615 : 0.578;
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
  const { fill = 'none', stroke = 'none', sw = 1, r = 0, opacity = 1, shadow = false, dash } = options;
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
  const width = Math.max(42, label.length * size * 0.66 + pad * 2);
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
    output += text(x + width - 12, top + height / 2 + 6, suffix, 14, { fill: C.muted, anchor: 'end' });
  return output;
}

function check(x, y, color = C.green) {
  return path(`M ${x} ${y} l 6 7 l 14 -17`, { stroke: color, sw: 4 });
}

function cross(cx, cy, color = C.red, size = 7) {
  return (
    path(`M ${cx - size} ${cy - size} L ${cx + size} ${cy + size}`, { stroke: color, sw: 3 }) +
    path(`M ${cx + size} ${cy - size} L ${cx - size} ${cy + size}`, { stroke: color, sw: 3 })
  );
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
  let output = circle(x + 7, y - 5, 9, { fill: checkmark ? color : `${color}18`, stroke: color, sw: 1 });
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

/**
 * Шаг колонки: то же, что `callout`, но плотнее — заголовок мельче, строки чаще. Заведён потому,
 * что у памятки колонка узкая и высокая: в `callout` при той же высоте помещаются две строки, а
 * шагу их нужно четыре, и обрезанный многоточием текст в памятке хуже, чем шрифт на кегль меньше.
 */
function stepCard(x, y, width, height, number, titleValue, body, options = {}) {
  const { fill = '#fff', stroke = C.line, dotFill = C.blue } = options;
  return (
    rect(x, y, width, height, { fill, stroke, r: 13 }) +
    numberDot(number, x + 30, y + 30, { fill: dotFill, radius: 15 }) +
    text(x + 54, y + 31, titleValue, 16, { fill: C.ink, weight: 700 }) +
    paragraph(x + 22, y + 62, body, width - 44, 13, {
      fill: C.muted,
      lineHeight: 19,
      maxLines: Math.max(2, Math.floor((height - 56) / 19)),
    })
  );
}

/** Врезка без номера: заголовок цветом и текст под ним. Ею подписаны границы и предупреждения. */
function note(x, y, width, height, titleValue, body, options = {}) {
  const {
    fill = C.graySoft,
    stroke = C.line,
    color = C.ink,
    size = 15,
    lineHeight = 22,
  } = options;
  return (
    rect(x, y, width, height, { fill, stroke, r: 12 }) +
    text(x + 26, y + 40, titleValue, 18, { fill: color, weight: 700 }) +
    paragraph(x + 26, y + 72, body, width - 52, size, {
      fill: C.text,
      lineHeight,
      maxLines: Math.max(1, Math.floor((height - 56) / lineHeight)),
    })
  );
}

function tableHeader(x, y, widths, labels) {
  let output = rect(x, y, widths.reduce((sum, value) => sum + value, 0), 42, {
    fill: '#fafafa',
    stroke: C.line,
  });
  let xx = x;
  labels.forEach((label, i) => {
    output += text(xx + 10, y + 27, label, 12, { fill: C.muted, weight: 600 });
    xx += widths[i];
    if (i < labels.length - 1) output += line(xx, y, xx, y + 42, { stroke: C.line });
  });
  return output;
}

function tableRow(x, y, widths, values, options = {}) {
  const height = options.height ?? 55;
  const lineHeight = options.lineHeight ?? 17;
  const maxLines = options.maxLines ?? 2;
  let output = rect(x, y, widths.reduce((sum, value) => sum + value, 0), height, {
    fill: options.fill ?? '#fff',
    stroke: C.line,
  });
  let xx = x;
  values.forEach((value, i) => {
    output += paragraph(xx + 10, y + (options.top ?? 25), value, widths[i] - 20, options.size ?? 12, {
      fill: options.colors?.[i] ?? C.text,
      weight: options.weights?.[i] ?? 400,
      lineHeight,
      maxLines,
    });
    xx += widths[i];
    if (i < values.length - 1) output += line(xx, y, xx, y + height, { stroke: C.line });
  });
  return output;
}

function sectionLabel(x, y, label, options = {}) {
  return pill(x, y, label.toUpperCase(), {
    fill: options.fill ?? C.blueSoft,
    color: options.color ?? C.blue,
    size: 12,
    pad: 10,
  }).svg;
}

/** Строка меню «Действия» в макете карточки: подпись, признак главного шага и опасные красным. */
function menuRow(x, y, width, label, options = {}) {
  const { primary = false, danger = false, hint } = options;
  let output = primary ? rect(x - 10, y - 24, width + 20, 38, { fill: C.blueSoft, r: 8 }) : '';
  output += circle(x + 6, y - 5, 6, {
    fill: danger ? C.redSoft : primary ? C.blue : '#eef1f6',
    stroke: danger ? '#ffccc7' : 'none',
  });
  output += text(x + 24, y, label, 15, {
    fill: danger ? C.red : C.text,
    weight: primary ? 600 : 400,
  });
  if (hint) output += text(x + width, y, hint, 12, { fill: C.faint, anchor: 'end' });
  return output;
}

function defs() {
  return `<defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#172033" flood-opacity="0.12"/>
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
    output += paragraph(55, 158, subtitle, 1005, 16, { fill: C.muted, lineHeight: 23, maxLines: 2 });
  return output;
}

function footer(label = `Памятка ИТ-специалисту • оргтехника • ${RELEASE}`) {
  return (
    line(55, 1530, 1068, 1530, { stroke: C.line }) +
    text(55, 1560, label, 14, { fill: C.faint }) +
    text(1068, 1560, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 })
  );
}

// ── Страница 1: обложка, маршрут и три правила ──

function page1() {
  let b = circle(76, 82, 30, { fill: C.blue });
  b += text(76, 93, 'A', 35, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(121, 73, 'АВТО • ОРГ.ТЕХНИКА • ЗАЯВКИ', 16, { fill: C.blue, weight: 700, letter: 1.45 });
  b += text(121, 103, 'Памятка исполнителю', 18, { fill: C.muted });
  const badge = pill(843, 59, '«ОРГТЕХНИКА: ИТ-СЛУЖБА»', {
    fill: C.purpleSoft,
    color: C.purple,
    stroke: '#d3adf7',
    size: 13,
    pad: 14,
  });
  b += badge.svg;

  b += text(55, 216, 'Оргтехника', 64, { fill: C.ink, weight: 750 });
  b += text(55, 288, 'памятка ИТ-специалисту', 54, { fill: C.ink, weight: 750 });
  b += paragraph(
    58,
    348,
    'Что я делаю с заявкой на обслуживание, чего не делаю и куда нажимать. Кнопки исполнителя открывает назначение на заявку, а не право: не назначен — кнопок нет.',
    980,
    23,
    { fill: C.muted, lineHeight: 34 },
  );

  // ── Путь заявки ──
  b += rect(55, 450, 1013, 232, { fill: C.bg, stroke: C.line, r: 18 });
  b += sectionLabel(82, 478, 'Путь заявки', { fill: C.blueSoft, color: C.blue });

  const step = (x, label, fill, color, stroke) =>
    pill(x, 560, label, { fill, color, stroke, size: 16, pad: 16 });
  const s1 = step(95, 'Новая', '#fff', C.text, '#d9d9d9');
  const s2 = step(314, 'В работе', C.blueSoft, C.blue, '#91caff');
  const s3 = step(561, 'Решена', C.cyanSoft, C.cyan, '#87e8de');
  const s4 = step(790, 'Закрыта', C.greenSoft, C.green, '#b7eb8f');
  b += s1.svg + s2.svg + s3.svg + s4.svg;
  b += arrow(190, 576, 300, 576, { stroke: C.blue, sw: 3 });
  b += arrow(441, 576, 547, 576, { stroke: C.blue, sw: 3 });
  b += arrow(666, 576, 776, 576, { stroke: C.faint, sw: 3 });
  b += text(245, 545, '«Принять в работу»', 13, { fill: C.blue, weight: 600, anchor: 'middle' });
  b += text(245, 613, 'мой ход', 12, { fill: C.muted, anchor: 'middle' });
  b += text(494, 545, '«Закрыть работы»', 13, { fill: C.blue, weight: 600, anchor: 'middle' });
  b += text(494, 613, 'мой ход', 12, { fill: C.muted, anchor: 'middle' });
  b += text(721, 545, '«Принять работу»', 13, { fill: C.muted, weight: 600, anchor: 'middle' });
  b += text(721, 613, 'ход «Ведения»', 12, { fill: C.muted, anchor: 'middle' });

  const held = pill(910, 500, 'Отложена', { fill: C.goldSoft, color: C.gold, stroke: '#ffe58f', size: 13, pad: 12 });
  b += held.svg;
  b += paragraph(910, 552, 'остановка с причиной; вернётся туда, откуда отложили', 140, 12, {
    fill: C.muted,
    lineHeight: 17,
  });
  const cancelled = pill(910, 616, 'Отменена', { fill: C.redSoft, color: C.red, stroke: '#ffccc7', size: 13, pad: 12 });
  b += cancelled.svg;
  b += text(910, 662, 'снимает «Ведение»', 12, { fill: C.muted });

  // ── Три правила ──
  const cards = [
    {
      x: 55,
      color: C.blue,
      soft: C.blueSoft,
      tag: 'Доступ',
      title: 'Открывает назначение',
      body: 'Пока меня нет в списке исполнителей заявки, ходов исполнителя в ней нет ни при каком праве. В исполнители ставит «Ведение».',
    },
    {
      x: 404,
      color: C.purple,
      soft: C.purpleSoft,
      tag: 'Область',
      title: 'Модуль виден целиком',
      body: 'Заявки и техника оргтехники видны по всей компании: у набора сквозная область. В вывозе мусора и заказе ТС она прежняя, по роли.',
    },
    {
      x: 753,
      color: C.cyan,
      soft: C.cyanSoft,
      tag: 'Граница',
      title: 'Мой ход — до «Решена»',
      body: 'Закрыл работы — дальше принимает «Ведение». Приёмка, отмена, срочность и закупки остаются за ним.',
    },
  ];
  for (const card of cards) {
    b += rect(card.x, 712, 315, 288, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += sectionLabel(card.x + 26, 742, card.tag, { fill: card.soft, color: card.color });
    b += paragraph(card.x + 26, 818, card.title, 265, 23, {
      fill: C.ink,
      weight: 700,
      lineHeight: 30,
    });
    b += paragraph(card.x + 26, 886, card.body, 265, 15, { fill: C.muted, lineHeight: 23 });
  }

  // ── Оглавление ──
  b += rect(55, 1040, 1013, 306, { fill: C.bg, stroke: C.line, r: 16 });
  b += text(82, 1088, 'Что где', 21, { fill: C.ink, weight: 700 });
  const toc = [
    ['Мой рабочий круг: принять, сделать, закрыть', '2'],
    ['Если ход дальше не мой: отказ и заморозка', '3'],
    ['Объём работ и документы заявки', '4'],
    ['Расходники и заявка без аппарата', '5'],
    ['Чего у меня нет · шпаргалка по статусам', '6'],
  ];
  toc.forEach(([label, page], i) => {
    const y = 1140 + i * 42;
    b += circle(96, y - 5, 4, { fill: C.blue });
    b += text(118, y, label, 16, { fill: C.text });
    b += text(1041, y, `стр. ${page}`, 15, { fill: C.faint, weight: 600, anchor: 'end' });
  });

  b += text(55, 1420, `Редакция: ${RELEASE}`, 15, { fill: C.faint });
  b += text(1068, 1420, '6 страниц', 15, { fill: C.faint, anchor: 'end' });
  b += footer(`Памятка ИТ-специалисту • оргтехника • ${RELEASE}`);
  return document(b);
}

// ── Страница 2: рабочий круг ──

function page2() {
  let b = header(
    2,
    'Мой рабочий круг',
    '1. Путь заявки через меня',
    'Заявка становится моей, когда меня в неё назначили: до этого ни кнопок, ни строки «Вам: …». Дальше два хода — «Принять в работу» и «Закрыть работы», и на этом моё заканчивается.',
  );

  // Макет карточки заявки
  b += rect(55, 218, 545, 700, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 266, 'СО-1482 · Обслуживание', 22, { fill: C.ink, weight: 700 });
  const status = pill(455, 246, 'В работе', { fill: C.blueSoft, color: C.blue, stroke: '#91caff', size: 13, pad: 12 });
  b += status.svg;
  b += text(82, 296, 'Ricoh IM 350 · АЛ13, каб. 214', 15, { fill: C.muted });
  b += rect(82, 316, 300, 34, { fill: C.blueSoft, r: 8 });
  b += text(96, 339, 'Вам: выполнить и закрыть работы', 14, { fill: C.blue, weight: 600 });
  b += line(82, 372, 573, 372, { stroke: C.line });
  b += text(82, 402, 'ДЕЙСТВИЯ', 12, { fill: C.faint, weight: 700, letter: 1.2 });

  const rows = [
    ['Объём работ', {}],
    ['Вернуть объём в правку', {}],
    ['Закрыть работы', { primary: true, hint: 'главный шаг' }],
    ['Вернуть в «Новую»', { danger: true }],
    ['Отложить', {}],
    ['Обсуждение', {}],
    ['Изменить исполнителей', {}],
  ];
  rows.forEach(([label, options], i) => {
    b += menuRow(92, 448 + i * 46, 471, label, options);
  });
  b += line(82, 790, 573, 790, { stroke: C.line });
  b += paragraph(
    82,
    814,
    'В «Новой» вместо них — «Принять в работу» и «Отказаться от заявки»: что видно, решают статус и назначение.',
    491,
    14,
    { fill: C.muted, lineHeight: 21 },
  );
  b += button(82, 866, 190, 'Закрыть работы', { primary: true, compact: true });
  b += button(284, 866, 130, 'Действия ⌄', { compact: true });

  // Шаги
  const steps = [
    [
      '1',
      'Заявку передаёт «Ведение»',
      'Оно ставит меня в исполнители поимённо — и заявка появляется в очереди «Ждут меня» с подписью «Вам: принять в работу».',
      C.blue,
      C.bluePale,
      '#bae0ff',
    ],
    [
      '2',
      '«Принять в работу»',
      'Ничего не спрашивает: «Новая» → «В работе». Пока никто не нажал, за заявку не взялись, и возраст ожидания идёт.',
      C.blue,
      '#fff',
      C.line,
    ],
    [
      '3',
      'Работа и слова о ней',
      'Что нашёл, чего ждём, когда приеду — репликой в «Обсуждении» с адресатом «Оргтехнике (ведение)» или «Заявителю». Другого места для текста у заявки нет.',
      C.purple,
      '#fff',
      C.line,
    ],
    [
      '4',
      '«Закрыть работы»',
      'Окно «Закрытие работ»: дата выполнения, отметки по строкам и комментарий «что сделали и чего не понадобилось». Заявка уходит в «Решена».',
      C.cyan,
      '#fff',
      C.line,
    ],
    [
      '5',
      'Дальше принимает «Ведение»',
      '«Принять работу» либо «Вернуть на доработку» — не мой ход. Промолчали сутки — портал закрывает заявку сам, если нужная ей бумага уже подшита.',
      C.green,
      C.greenSoft,
      '#b7eb8f',
    ],
  ];
  steps.forEach(([n, title, body, color, fill, stroke], i) => {
    b += stepCard(630, 218 + i * 148, 438, 136, n, title, body, { fill, stroke, dotFill: color });
  });

  b += note(
    55,
    960,
    497,
    236,
    'Себя в исполнители не поставить',
    'Пункт «Назначить исполнителей» у меня есть, но список сотрудников портал показывает только тому, кто ведёт учётные записи: мне в нём видны сервисные компании и те, кого уже назначили. Значит, заявку передаёт «Ведение».',
    { fill: C.purpleSoft, stroke: '#d3adf7', color: C.purple },
  );
  b += note(
    571,
    960,
    497,
    236,
    'Бумага нужна не всегда',
    'Планка закрывающего документа стоит только у ремонта, который делает сервисная компания: там «Закрыть работы» видна, но неактивна, пока не подшит акт, счёт или гарантийный талон. Свой ремонт и расходники закрываются без бумаги.',
    { fill: C.orangeSoft, stroke: '#ffd591', color: C.orange },
  );

  b += rect(55, 1220, 1013, 262, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 1268, 'Кто ещё стоит на заявке рядом со мной', 21, { fill: C.ink, weight: 700 });
  b += bullet(
    82,
    1318,
    'Сотрудников можно назначить нескольких, сервисная компания — одна: вторая заменяет первую.',
    460,
    { color: C.blue, size: 15, lineHeight: 22 },
  );
  b += bullet(
    82,
    1392,
    'Смешанное назначение «наш сисадмин и сервис» — обычное дело: ходим мы одними и теми же кнопками.',
    460,
    { color: C.purple, size: 15, lineHeight: 22 },
  );
  b += bullet(
    582,
    1318,
    'Снятого исполнителя лишают заявки: его объём работ и согласование стираются, отсчёт ожидания идёт заново.',
    460,
    { color: C.orange, size: 15, lineHeight: 22 },
  );
  b += bullet(
    582,
    1392,
    'Переназначение из «В работе» возвращает заявку в «Новую»: новый исполнитель нажимает «Принять в работу» сам.',
    460,
    { color: C.green, size: 15, lineHeight: 22 },
  );
  b += footer();
  return document(b);
}

// ── Страница 3: отказ и заморозка ──

function page3() {
  let b = header(
    3,
    'Если ход дальше не мой',
    '2. Отказ от заявки и заморозка',
    'Два разных положения дел: «эту работу должен делать не я» и «работа моя, но ждём запчасть». Первое меняет состав исполнителей, второе останавливает саму заявку.',
  );

  b += text(55, 236, 'Отказаться от заявки', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 236, '— пункт есть только в «Новой»', 16, { fill: C.muted, anchor: 'end' });

  b += rect(55, 262, 470, 320, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(82, 306, 'Отказ от заявки', 20, { fill: C.ink, weight: 700 });
  b += input(82, 340, 416, 'Причина', 'Аппарат на объекте, куда я не выезжаю', { height: 90 });
  b += button(300, 500, 90, 'Отмена', { compact: true });
  b += button(402, 500, 96, 'Отказаться', { compact: true, danger: true });

  b += bullet(
    556,
    300,
    'Причина обязательна: по ней в истории читают, почему исполнителей стало меньше.',
    498,
    { color: C.blue, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    372,
    'Портал отвечает «Вы сняты с заявки». Статус не меняется — заявка и была «Новой».',
    498,
    { color: C.blue, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    444,
    'Снимаюсь только я. Остались другие назначенные — заявка ждёт их; не осталось никого — снова ждёт распределения.',
    498,
    { color: C.blue, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    540,
    'У заявки, которую никому не назначили, пункта нет вовсе: отказываться там не от чего.',
    498,
    { color: C.faint, size: 16, lineHeight: 23 },
  );

  b += note(
    55,
    612,
    1013,
    150,
    'Уже принял в работу, а работа не моя',
    'Отказ из «В работе» не открыт. Есть «Вернуть в «Новую»» — это откат моего же «принял в работу»: причины он не спрашивает, исполнителей с заявки не снимает (я остаюсь в списке), и после него отказ снова доступен. Второй путь — попросить «Ведение» переназначить заявку: переназначение из «В работе» само вернёт её в «Новую» и сотрёт предъявленный объём работ вместе с согласованием.',
    { fill: C.bluePale, stroke: '#bae0ff', color: C.blue },
  );

  b += line(55, 800, 1068, 800, { stroke: C.line });
  b += text(55, 856, 'Заморозка: «ждём запчасть»', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 856, '— «Отложить» есть и у меня', 16, { fill: C.muted, anchor: 'end' });

  b += rect(55, 884, 470, 330, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(82, 928, 'Отложить СО-1482', 20, { fill: C.ink, weight: 700 });
  b += rect(82, 948, 416, 74, { fill: C.goldSoft, stroke: '#ffe58f', r: 9 });
  b += text(100, 980, 'Заявка остановится: ход по ней станет', 13, { fill: C.text });
  b += text(100, 1004, 'невозможен. Вернётся туда, откуда отложили.', 13, { fill: C.text });
  b += input(82, 1042, 416, 'Почему откладываем', 'Ждём тонер от поставщика, обещают к 8-му', {
    height: 74,
  });
  b += button(300, 1148, 90, 'Отмена', { compact: true });
  b += button(402, 1148, 96, 'Отложить', { compact: true, primary: true });

  b += bullet(
    556,
    924,
    'Право заморозки входит в мой набор: откладывать и возвращать заявку я могу сам. Закрыта заморозка исполнителю-подрядчику — «ждём запчасть» не его решение.',
    498,
    { color: C.gold, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1020,
    'Откладывают из «Новой», «В работе» и «Решена». В себя заморозка не вкладывается: вторая причина поверх первой стёрла бы путь назад.',
    498,
    { color: C.gold, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1116,
    'Причина обязательна: даты «отложена до» у заморозки нет, и когда ждать — говорит только она. Причину видно в списке и в карточке.',
    498,
    { color: C.gold, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1212,
    'Возврат один — «Возобновить», и только в тот статус, из которого отложили. Возраст в статусе обнулится.',
    498,
    { color: C.green, size: 16, lineHeight: 23 },
  );

  b += note(
    55,
    1296,
    1013,
    186,
    'Что можно с отложенной заявкой',
    'Ход по ней остановлен: ни принять, ни закрыть, ни предъявить объём работ. Срочность и правку самой заявки ей тоже не меняют. Зато остаются файлы, обсуждение и перемещение техники, а виды документов считаются по тому статусу, из которого её отложили. И ещё одно: автозакрытие отложенную заявку не берёт — это единственный способ снять «Решена» с суточного отсчёта, пока идёт разбирательство.',
    { fill: C.graySoft, stroke: C.line, color: C.ink },
  );
  b += footer();
  return document(b);
}

// ── Страница 4: объём работ и документы ──

function page4() {
  let b = header(
    4,
    'Объём работ и документы',
    '3. Деньги и бумаги',
    'Объём работ — не статус: его предъявляют, оставаясь «В работе». Документы подшивают по видам, и один из них решает, закроются ли работы сервисной компании.',
  );

  b += rect(55, 214, 545, 640, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 258, 'Объём работ заявки СО-1482', 21, { fill: C.ink, weight: 700 });
  b += rect(82, 278, 491, 62, { fill: C.bluePale, stroke: '#bae0ff', r: 9 });
  b += text(100, 304, 'Ревизия 1 уже предъявлялась — следующее', 13, { fill: C.text });
  b += text(100, 326, 'предъявление уйдёт ревизией 2', 13, { fill: C.text });

  b += text(82, 378, 'ЗАПЧАСТИ', 12, { fill: C.faint, weight: 700, letter: 1.2 });
  b += rect(82, 392, 491, 46, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(96, 421, 'Термоплёнка Ricoh IM 350', 14, { fill: C.text });
  b += text(560, 421, '1 × 4 200,00 ₽', 13, { fill: C.muted, anchor: 'end' });
  b += text(82, 470, 'РАБОТЫ', 12, { fill: C.faint, weight: 700, letter: 1.2 });
  b += rect(82, 484, 491, 46, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(96, 513, 'Замена узла закрепления', 14, { fill: C.text });
  b += text(560, 513, '1 × 1 800,00 ₽', 13, { fill: C.muted, anchor: 'end' });

  b += text(560, 566, 'Итого по объёму работ: 6 000,00 ₽', 16, {
    fill: C.ink,
    weight: 700,
    anchor: 'end',
  });
  b += input(82, 594, 491, '', 'Комментарий: что нашли при диагностике', {
    placeholder: true,
    height: 62,
  });
  b += button(303, 690, 270, 'Гарантийный ремонт без оплаты', { compact: true });
  b += button(82, 736, 200, 'Сохранить черновик', { compact: true });
  b += button(292, 736, 281, 'Предъявить на согласование', { compact: true, primary: true });
  b += paragraph(
    82,
    806,
    'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что предъявите.',
    491,
    13,
    { fill: C.muted, lineHeight: 19 },
  );

  const cards = [
    [
      '1',
      'Статуса не двигает',
      'Заявка остаётся «В работе», меняется только очередь: в списке она становится «Ждёт согласования». Подписывает объём «Ведение».',
      C.blue,
      '#fff',
      C.line,
    ],
    [
      '2',
      'Пока висит — правка закрыта',
      'Окно скажет: «Ревизия N предъявлена и ждёт ответа». Ни изменить состав, ни предъявить заново нельзя: согласующий подписывает то, что видит.',
      C.orange,
      C.orangeSoft,
      '#ffd591',
    ],
    [
      '3',
      '«Вернуть объём в правку»',
      'Мой ключ от замка: снимает и предъявление, и уже поставленную подпись. Причина обязательна.',
      C.blue,
      '#fff',
      C.line,
    ],
    [
      '4',
      'Повторное обесценивает подпись',
      'Новое предъявление уходит следующей ревизией, а прежнее «согласовано» снимается — согласовывать придётся заново. Ревизии сверяются при закрытии работ.',
      C.red,
      C.redSoft,
      '#ffccc7',
    ],
  ];
  cards.forEach(([n, title, body, color, fill, stroke], i) => {
    b += stepCard(630, 214 + i * 156, 438, 144, n, title, body, { fill, stroke, dotFill: color });
  });
  b += paragraph(
    630,
    854,
    'У вида «Расходники» объёма работ нет вовсе: картридж берут со своего склада, согласовывать по нему нечего.',
    438,
    14,
    { fill: C.muted, lineHeight: 21 },
  );

  b += line(55, 924, 1068, 924, { stroke: C.line });
  b += text(55, 976, 'Документы и вложения', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 976, '— подшивают кнопкой «Фото и документы»', 16, { fill: C.muted, anchor: 'end' });

  const widths = [250, 300, 463];
  b += tableHeader(55, 1004, widths, ['Вид документа', 'Когда его принимают', 'Зачем']);
  b += tableRow(55, 1046, widths, [
    'Вложение',
    'пока заявка не закрыта',
    'фото поломки, экран с ошибкой, что угодно по делу',
  ]);
  b += tableRow(55, 1101, widths, [
    'Объём работ',
    'только в «В работе»',
    'счёт или смета сервиса к предъявленному объёму',
  ], { fill: '#fcfdff' });
  b += tableRow(55, 1156, widths, [
    'Акт · Счёт · Гарантийный талон',
    'с «В работе» и дальше, в том числе после приёмки',
    'закрывающие документы: хватает любого одного из трёх',
  ]);

  b += note(
    55,
    1240,
    497,
    242,
    'Без бумаги не закроется',
    'Ремонт силами сервисной компании не уходит в «Решена», пока нет ни акта, ни счёта, ни гарантийного талона: кнопка «Закрыть работы» видна и неактивна, а причина написана рядом. В списке такая заявка стоит с подписью «Ожидаются документы».',
    { fill: C.orangeSoft, stroke: '#ffd591', color: C.orange },
  );
  b += note(
    571,
    1240,
    497,
    242,
    'Что подшивать мне',
    'Свой ремонт закрывается без документов — подшивайте то, что пригодится потом: фото до и после, гарантийный талон на поставленную запчасть, счёт от сервиса. Снять подшитое можно, пока заявка не закрыта; после приёмки бумага из неё уже не исчезает.',
    { fill: C.bluePale, stroke: '#bae0ff', color: C.blue },
  );
  b += footer();
  return document(b);
}

// ── Страница 5: расходники и заявка без аппарата ──

function page5() {
  let b = header(
    5,
    'Расходники и заявка без аппарата',
    '4. Два частых случая',
    'В заявке на расходники состав пишу я, а выдачу отмечаю при закрытии. Заявку без аппарата завожу тогда, когда чинить нечего: работа не про конкретную единицу техники.',
  );

  b += text(55, 232, 'Заявка на расходники', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 232, '— «Заполнить номенклатуру», потом «Изменить»', 16, { fill: C.muted, anchor: 'end' });

  b += rect(55, 258, 470, 320, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(82, 302, 'Номенклатура заявки СО-1503', 19, { fill: C.ink, weight: 700 });
  b += text(82, 336, 'Что пойдёт по заявке', 14, { fill: C.text, weight: 500 });
  b += rect(82, 348, 320, 44, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(95, 376, 'Тонер Ricoh 201 · на складе 12', 14, { fill: C.text });
  b += rect(410, 348, 60, 44, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(440, 376, '2', 14, { fill: C.text, anchor: 'middle' });
  b += rect(82, 404, 320, 44, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(95, 432, 'Картридж Ricoh 1270D · на складе 0', 14, { fill: C.red });
  b += rect(410, 404, 60, 44, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(440, 432, '1', 14, { fill: C.text, anchor: 'middle' });
  b += button(82, 464, 196, 'Добавить позицию', { compact: true, icon: '+' });
  b += button(376, 522, 122, 'Сохранить', { compact: true, primary: true });

  b += bullet(
    556,
    296,
    'Состав заполняю я: заявитель позиций не выбирает — он говорит словами, чего не хватает.',
    498,
    { color: C.purple, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    368,
    'Выдачу отмечаю в окне «Закрытие работ»: сколько чего выдал. Списание со склада идёт той же операцией, что и переход в «Решена».',
    498,
    { color: C.purple, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    464,
    'Не хватило остатка — закрытие не проходит целиком, и портал называет позицию, остаток и выход.',
    498,
    { color: C.red, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    536,
    'Отдельный пункт «Отметить выдачу» есть в «В работе» и «Решена»; отмеченное правят им же — «Изменить выданное».',
    498,
    { color: C.green, size: 16, lineHeight: 23 },
  );

  b += note(
    55,
    608,
    1013,
    112,
    'После первой отметки выдачи состав замирает',
    'Он стал основанием записи на складе: портал больше не даст его править, и всё дальнейшее — ручная правка остатка в «Расходниках», а это уже не мой ход.',
    { fill: C.goldSoft, stroke: '#ffe58f', color: C.gold, size: 14, lineHeight: 21 },
  );

  b += line(55, 756, 1068, 756, { stroke: C.line });
  b += text(55, 812, 'Заявка без аппарата', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 812, '— «Какой аппарат» у меня необязателен', 16, { fill: C.muted, anchor: 'end' });

  b += rect(55, 840, 470, 430, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(82, 884, 'Новая заявка', 19, { fill: C.ink, weight: 700 });
  b += text(82, 918, 'Чем помочь', 14, { fill: C.text, weight: 500 });
  b += rect(82, 930, 416, 40, { fill: '#f5f5f5', r: 8 });
  b += rect(86, 934, 204, 32, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  b += text(188, 956, 'Обслуживание', 14, { fill: C.text, weight: 600, anchor: 'middle' });
  b += text(394, 956, 'Расходники', 14, { fill: C.muted, anchor: 'middle' });
  b += input(82, 990, 416, 'Какой аппарат', 'Не выбран — заявка без аппарата', {
    placeholder: true,
    suffix: '⌄',
  });
  b += input(82, 1076, 416, 'Описание', 'Настроить почту новому сотруднику');
  b += input(82, 1162, 416, 'Для кого заявка', 'Отдел: Бухгалтерия', { suffix: '⌄' });
  b += text(82, 1252, 'Обязательно, раз аппарат не выбран', 12, { fill: C.orange });

  b += bullet(
    556,
    880,
    'Когда заводить: работа не про конкретную единицу — «поставьте розетку», «настройте почту новому сотруднику».',
    498,
    { color: C.blue, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    976,
    'Оставил «Какой аппарат» пустым — обязательным становится «Для кого заявка».',
    498,
    { color: C.blue, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1048,
    'Заказчика выбирают по своей оси; у меня видны обе — и объекты, и отделы. Заявка, заведённая на чужую ось, пропала бы у самого автора.',
    498,
    { color: C.orange, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1144,
    'В списках такая заявка называется «Без аппарата», строки «Где стоит» у неё нет.',
    498,
    { color: C.muted, size: 16, lineHeight: 23 },
  );
  b += bullet(
    556,
    1216,
    'Гарантий, пометки «не тот объект» и перемещения техники у неё не бывает: переезжать нечему.',
    498,
    { color: C.muted, size: 16, lineHeight: 23 },
  );

  b += note(
    55,
    1310,
    1013,
    174,
    'Вид заявки выбирают первым и меняют только новой заявкой',
    '«Чем помочь» — первый вопрос формы, и у заведённой заявки вид уже не меняется: заявка на картридж, ставшая ремонтной, — это другая заявка. Поле сути у обоих видов называется «Описание»: подсказка внутри поля своя, подпись общая.',
    { fill: C.graySoft, stroke: C.line, color: C.ink },
  );
  b += footer();
  return document(b);
}

// ── Страница 6: границы и шпаргалка ──

function page6() {
  let b = header(
    6,
    'Чего у меня нет и шпаргалка',
    '5. Границы и статусы',
    'Короткий честный список: этих кнопок искать не надо, их не выдадут. Ниже — что означает каждый статус и чей в нём ход.',
  );

  const limits = [
    [
      'Приёмка работы',
      '«Принять работу» и «Вернуть на доработку» — ход «Ведения». Моё заканчивается на «Решена».',
    ],
    [
      'Отмена заявки',
      '«Отменить заявку» из любого статуса — тоже «Ведение». Отказ по объёму работ есть та же отмена, с причиной и решением.',
    ],
    [
      'Срочность',
      'Пункт «Отметить срочной» в меню виден, но портал откажет: срочность ставит тот, кто ведёт заявки.',
    ],
    [
      'Справочник и склад',
      'Карточки аппаратов ведут в «Справочниках», номенклатуру и плановые закупки — другие наборы. Вкладку «Расходники» я вижу, «Изменить остаток», «Потребность» и «Плановая закупка» мне не показываются, как и «Записать перемещение техники».',
    ],
  ];
  b += rect(55, 210, 1013, 340, { fill: C.redSoft, stroke: '#ffccc7', r: 16 });
  limits.forEach(([title, body], i) => {
    const x = 82 + (i % 2) * 500;
    const y = 262 + Math.floor(i / 2) * 150;
    b += cross(x + 12, y - 6, C.red, 8);
    b += text(x + 38, y, title, 18, { fill: C.ink, weight: 700 });
    b += paragraph(x + 38, y + 30, body, 418, 14, { fill: C.text, lineHeight: 21, maxLines: 5 });
  });

  b += text(55, 610, 'Шпаргалка по статусам', 25, { fill: C.ink, weight: 700 });
  b += text(1068, 610, '— живых статусов шесть', 16, { fill: C.muted, anchor: 'end' });

  const widths = [138, 262, 230, 383];
  b += tableHeader(55, 640, widths, ['Статус', 'Что значит', 'Чей ход дальше', 'Мои кнопки в нём']);
  const rows = [
    [
      'Новая',
      'заведена; исполнителей может не быть',
      'нет исполнителей — «Ведения» (назначить); есть — исполнителя',
      'Принять в работу · Отказаться от заявки · Отложить · Обсуждение',
      '#fcfdff',
    ],
    [
      'В работе',
      'кто-то взялся за заявку',
      'мой — закрыть работы; предъявлен объём работ — согласующего',
      'Объём работ · Вернуть объём в правку · Закрыть работы · Вернуть в «Новую» · Отложить',
      '#fff',
    ],
    [
      'Отложена',
      'движение остановлено с причиной',
      'того, кто откладывал: вернуть в работу или отменить',
      'Возобновить · Обсуждение · подшить файл',
      '#fcfdff',
    ],
    [
      'Решена',
      'работы закрыты, ждут приёмки',
      '«Ведения»; через сутки портал закрывает заявку сам',
      'Отметить выдачу (расходники) · Отложить · подшить акт, счёт, талон',
      '#fff',
    ],
    [
      'Закрыта',
      'работа принята',
      'конечный',
      'подшить бумагу можно; снять подшитое уже нельзя',
      '#fcfdff',
    ],
    ['Отменена', 'снята с причиной', 'конечный', '—', '#fff'],
  ];
  rows.forEach(([status, meaning, turn, mine, fill], i) => {
    b += tableRow(55, 682 + i * 76, widths, [status, meaning, turn, mine], {
      height: 76,
      fill,
      size: 13,
      lineHeight: 19,
      maxLines: 3,
      top: 28,
      weights: [700, 400, 400, 400],
      colors: [C.ink, C.text, C.muted, C.text],
    });
  });

  b += note(
    55,
    1166,
    1013,
    116,
    'Подписи, которых больше не бывает',
    '«Согласована ИТ», «Назначена», «Диагностика», «Смета на согласовании» — мёртвые статусы: заявок в них нет, а слова остались ради истории старых. Увидели такое — это запись прошлого, а не состояние, которого от вас ждут.',
    { fill: C.graySoft, stroke: C.line, color: C.ink, size: 14, lineHeight: 21 },
  );

  b += rect(55, 1310, 1013, 174, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += text(82, 1358, 'Если кнопки нет', 21, { fill: C.blue, weight: 700 });
  b += paragraph(
    82,
    1396,
    'Сначала проверьте, назначены ли вы на эту заявку: ходы исполнителя открывает назначение, а не право, и у чужой заявки кнопок не будет никаких. Дальше — статус: половина действий живёт ровно в одном из них. И только потом это чужой ход — тогда он в таблице выше, и просить надо «Ведение».',
    960,
    16,
    { fill: C.text, lineHeight: 24 },
  );
  b += footer();
  return document(b);
}

const pages = [page1(), page2(), page3(), page4(), page5(), page6()];

for (const [index, svg] of pages.entries()) {
  const stem = `office-equipment-it-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Оргтехника: памятка ИТ-специалисту');
pdf.setSubject('Работа исполнителя по заявкам оргтехники: набор «Оргтехника: ИТ-служба»');
pdf.setKeywords(['оргтехника', 'заявки', 'исполнитель', 'ИТ-служба', 'памятка']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-01T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `office-equipment-it-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
