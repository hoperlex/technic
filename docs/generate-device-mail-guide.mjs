/**
 * Краткая иллюстрированная инструкция по приёму писем от аппаратов — сборка PDF.
 *
 * Текст-источник — `docs/guide-device-mail.md`, решение — ADR 0197. Здесь только его короткая
 * версия с картинками: макеты экранов, путь письма и блоки настроек. Готовый PDF в репозитории не
 * хранится — он производен от этого скрипта, от текста руководства и от кода.
 *
 * Помощники и палитра повторяют `generate-mailing-office-equipment-guide.mjs` дословно: два
 * руководства модуля обязаны выглядеть одним семейством, а разъехавшийся набор примитивов — это
 * две вёрстки, которые правят по отдельности.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Краткая_инструкция_Письма_от_аппаратов.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'device-mail-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 9;
const C = {
  ink: '#172033',
  text: '#344054',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e4e7ec',
  bg: '#f5f7fb',
  blue: '#1677ff',
  blueDark: '#0958d9',
  blueSoft: '#e6f4ff',
  bluePale: '#f0f7ff',
  cyan: '#08979c',
  cyanSoft: '#e6fffb',
  green: '#389e0d',
  greenSoft: '#f6ffed',
  gold: '#d48806',
  goldSoft: '#fffbe6',
  orange: '#d46b08',
  orangeSoft: '#fff7e6',
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

function text(x, y, value, size = 20, options = {}) {
  const {
    fill = C.text,
    weight = 400,
    anchor = 'start',
    letter = 0,
    italic = false,
    opacity = 1,
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="DejaVu Sans" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letter}" opacity="${opacity}"${italic ? ' font-style="italic"' : ''}>${esc(value)}</text>`;
}

function wrap(value, width, size, weight = 400) {
  const words = String(value).trim().split(/\s+/u);
  const lines = [];
  let current = '';
  const factor = weight >= 600 ? 0.59 : 0.55;
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

function paragraph(x, y, value, width, size = 18, options = {}) {
  const { lineHeight = Math.round(size * 1.42), maxLines, ...textOptions } = options;
  let lines = wrap(value, width, size, textOptions.weight);
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:]?$/u, '')}…`;
  }
  return lines
    .map((lineValue, i) => text(x, y + i * lineHeight, lineValue, size, textOptions))
    .join('');
}

function rect(x, y, w, h, options = {}) {
  const {
    fill = 'none',
    stroke = 'none',
    sw = 1,
    r = 0,
    opacity = 1,
    shadow = false,
    dash,
  } = options;
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

function check(x, y, color = C.green, sw = 4) {
  return path(`M ${x} ${y} l 6 7 l 14 -17`, { stroke: color, sw });
}

function iconEnvelope(x, y, size = 32, color = C.blue) {
  const w = size;
  const h = size * 0.7;
  return (
    rect(x, y, w, h, { fill: 'none', stroke: color, sw: 2.5, r: 3 }) +
    path(`M ${x + 2} ${y + 3} L ${x + w / 2} ${y + h / 2 + 2} L ${x + w - 2} ${y + 3}`, {
      stroke: color,
      sw: 2.5,
    })
  );
}

function numberDot(number, x, y, color = C.blue, radius = 18) {
  return (
    circle(x, y, radius, { fill: color, stroke: '#fff', sw: 4, shadow: true }) +
    text(x, y + 7, number, 20, { fill: '#fff', weight: 700, anchor: 'middle' })
  );
}

function button(x, y, width, label, options = {}) {
  const { primary = false, compact = false, danger = false, disabled = false } = options;
  const height = compact ? 38 : 46;
  const fill = disabled ? '#f5f5f5' : primary ? C.blue : danger ? C.redSoft : '#fff';
  const stroke = disabled ? C.line : primary ? C.blue : danger ? '#ffccc7' : '#d0d5dd';
  const color = disabled ? C.faint : primary ? '#fff' : danger ? C.red : C.text;
  return (
    rect(x, y, width, height, { fill, stroke, r: 7 }) +
    text(x + width / 2, y + (compact ? 25 : 30), label, compact ? 14 : 16, {
      fill: color,
      weight: 600,
      anchor: 'middle',
    })
  );
}

function field(x, y, width, label, value, options = {}) {
  const { height = 44, muted = false, suffix, mono = false } = options;
  let out = text(x, y, label, 13, { fill: C.text, weight: 600 });
  out += rect(x, y + 10, width, height, { fill: '#fff', stroke: '#d0d5dd', r: 6 });
  out += `<text x="${x + 13}" y="${y + 10 + height / 2 + 6}" fill="${muted ? C.faint : C.text}" font-family="${mono ? 'DejaVu Sans Mono' : 'DejaVu Sans'}" font-size="14">${esc(value)}</text>`;
  if (suffix)
    out += text(x + width - 12, y + 10 + height / 2 + 5, suffix, 14, {
      fill: C.muted,
      anchor: 'end',
    });
  return out;
}

function toggle(x, y, on = true) {
  const fill = on ? C.blue : '#d0d5dd';
  return (
    rect(x, y, 42, 24, { fill, r: 12 }) +
    circle(x + (on ? 30 : 12), y + 12, 9, { fill: '#fff', shadow: true })
  );
}

function bullet(x, y, value, width, options = {}) {
  const { color = C.blue, size = 16, lineHeight = 23, checkmark = false, weight = 400 } = options;
  let out = circle(x + 8, y - 5, 9, {
    fill: checkmark ? color : `${color}18`,
    stroke: color,
    sw: 1,
  });
  if (checkmark) out += check(x + 2, y - 5, '#fff', 2.5);
  else out += circle(x + 8, y - 5, 3, { fill: color });
  out += paragraph(x + 29, y, value, width - 29, size, { fill: C.text, lineHeight, weight });
  return out;
}

function callout(x, y, width, height, number, titleValue, body, options = {}) {
  const { fill = '#fff', stroke = C.line, color = C.blue, titleColor = C.ink } = options;
  return (
    rect(x, y, width, height, { fill, stroke, r: 13, shadow: options.shadow }) +
    numberDot(number, x + 32, y + 32, color, 16) +
    text(x + 58, y + 37, titleValue, 17, { fill: titleColor, weight: 700 }) +
    paragraph(x + 23, y + 73, body, width - 46, 14, {
      fill: C.muted,
      lineHeight: 21,
      maxLines: Math.floor((height - 78) / 21),
    })
  );
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

/**
 * Метка-«пилюля» с честной шириной. Своя, а не `pill()`: та считает ширину по латинице, а здесь
 * метки набраны кириллицей и капителью — надпись вылезала за скруглённый фон.
 */
function tag(x, y, label, options = {}) {
  const { fill = C.blueSoft, color = C.blue, size = 12, pad = 12 } = options;
  const width = label.length * size * 0.72 + pad * 2;
  return {
    width,
    svg:
      rect(x, y, width, size + 15, { fill, r: (size + 15) / 2 }) +
      text(x + width / 2, y + size + 1, label, size, {
        fill: color,
        weight: 600,
        anchor: 'middle',
      }),
  };
}

function mono(x, y, value, size = 14, options = {}) {
  const { fill = C.text, weight = 400, anchor = 'start' } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="DejaVu Sans Mono" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
}

/** Блок настроек или запроса: тёмная панель с моноширинным текстом. Возвращает высоту — под ним верстают дальше. */
function codeBlock(x, y, width, lines, options = {}) {
  const { size = 15, lineHeight = 28, pad = 22 } = options;
  const height = pad * 2 + lines.length * lineHeight - (lineHeight - size - 4);
  let out = rect(x, y, width, height, { fill: '#101a2b', r: 12, shadow: true });
  lines.forEach((value, i) => {
    const comment = value.startsWith('#') || value.startsWith('--');
    out += mono(x + pad, y + pad + size + i * lineHeight, value, size, {
      fill: comment ? '#7b8ca6' : '#e6f4ff',
    });
  });
  return { height, svg: out };
}

function arrow(x1, y1, x2, y2, options = {}) {
  const { color = C.blue, sw = 2.5, dash } = options;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const hx = x2 - Math.cos(angle) * 10;
  const hy = y2 - Math.sin(angle) * 10;
  const left = `${hx - Math.cos(angle - 0.55) * 13} ${hy - Math.sin(angle - 0.55) * 13}`;
  const right = `${hx - Math.cos(angle + 0.55) * 13} ${hy - Math.sin(angle + 0.55) * 13}`;
  return (
    line(x1, y1, hx, hy, { stroke: color, sw, dash }) +
    `<path d="M ${x2} ${y2} L ${left} L ${right} Z" fill="${color}"/>`
  );
}

function iconPrinter(x, y, size = 40, color = C.blue) {
  const w = size;
  const h = size * 0.86;
  return (
    rect(x + w * 0.2, y, w * 0.6, h * 0.3, { stroke: color, sw: 2.5, r: 2 }) +
    rect(x, y + h * 0.28, w, h * 0.44, { stroke: color, sw: 2.5, r: 3 }) +
    rect(x + w * 0.2, y + h * 0.64, w * 0.6, h * 0.36, {
      fill: '#fff',
      stroke: color,
      sw: 2.5,
      r: 2,
    }) +
    circle(x + w * 0.83, y + h * 0.44, 2.6, { fill: color })
  );
}

function iconCard(x, y, size = 40, color = C.blue) {
  return (
    rect(x, y, size * 0.8, size, { stroke: color, sw: 2.5, r: 4 }) +
    line(x + 9, y + 12, x + size * 0.8 - 9, y + 12, { stroke: color, sw: 2.5 }) +
    line(x + 9, y + 24, x + size * 0.8 - 9, y + 24, { stroke: color, sw: 2.5 }) +
    line(x + 9, y + 36, x + size * 0.8 - 16, y + 36, { stroke: color, sw: 2.5 })
  );
}

/** Звено схемы: цветная шапка, заголовок, пояснение. */
function flowBox(x, y, w, h, titleValue, body, options = {}) {
  const { color = C.blue, fill = '#fff' } = options;
  return (
    rect(x, y, w, h, { fill, stroke: `${color}55`, r: 14, shadow: true }) +
    rect(x, y, w, 6, { fill: color, r: 3 }) +
    text(x + 18, y + 44, titleValue, 17, { fill: C.ink, weight: 700 }) +
    paragraph(x + 18, y + 76, body, w - 36, 13, { fill: C.muted, lineHeight: 19, maxLines: 5 })
  );
}

function header(page, kicker, titleValue, subtitle = '') {
  let out = circle(70, 68, 25, { fill: C.blue });
  out += iconEnvelope(56, 59, 28, '#fff');
  out += text(110, 54, kicker.toUpperCase(), 14, { fill: C.blue, weight: 700, letter: 1.2 });
  out += text(110, 92, titleValue, 32, { fill: C.ink, weight: 700 });
  out += text(1068, 70, `${String(page).padStart(2, '0')} / ${TOTAL}`, 15, {
    fill: C.faint,
    weight: 600,
    anchor: 'end',
  });
  out += line(55, 120, 1068, 120, { stroke: C.line });
  if (subtitle)
    out += paragraph(55, 160, subtitle, 1013, 16, { fill: C.muted, lineHeight: 23, maxLines: 2 });
  return out;
}

function footer(label) {
  return (
    line(55, 1524, 1068, 1524, { stroke: C.line }) +
    text(55, 1554, label, 12, { fill: C.faint }) +
    text(1068, 1554, 'Орг.техника → Техника → Письма устройств', 12, {
      fill: C.faint,
      anchor: 'end',
    })
  );
}

/** Окно раздела «Орг.техника»: шапка портала и вкладки раздела. */
function winFrame(x, y, width, height, activeTab = 'Техника') {
  let out = rect(x, y, width, height, { fill: '#fff', stroke: '#d0d5dd', r: 12, shadow: true });
  out += rect(x, y, width, 46, { fill: '#102a43', r: 12 });
  out += rect(x, y + 34, width, 12, { fill: '#102a43' });
  out += circle(x + 26, y + 23, 13, { fill: C.blue });
  out += text(x + 26, y + 28, 'Т', 13, { fill: '#fff', weight: 700, anchor: 'middle' });
  out += text(x + 48, y + 28, 'Техник · Орг.техника', 14, { fill: '#fff', weight: 700 });
  out += text(x + width - 20, y + 28, 'ИТ-служба', 12, { fill: '#dbeafe', anchor: 'end' });
  let tx = x + 24;
  for (const item of ['Заявки', 'Гарантии', 'Техника', 'Расходники']) {
    const w = item.length * 9 + 32;
    out += text(tx + w / 2, y + 82, item, 14, {
      fill: item === activeTab ? C.blue : C.muted,
      weight: item === activeTab ? 700 : 500,
      anchor: 'middle',
    });
    if (item === activeTab) out += rect(tx + 8, y + 94, w - 16, 3, { fill: C.blue, r: 1.5 });
    tx += w;
  }
  out += line(x, y + 97, x + width, y + 97, { stroke: C.line });
  return out;
}

/** Переключатель режимов вкладки «Техника» — тот самый `Segmented`, которым открывают очередь. */
function segmented(x, y, items, active) {
  const widths = items.map((item) => item.length * 8 + 34);
  const total = widths.reduce((a, b) => a + b, 0);
  let out = rect(x, y, total + 8, 36, { fill: '#f2f4f7', r: 8 });
  let cx = x + 4;
  items.forEach((item, i) => {
    if (item === active) {
      out += rect(cx, y + 4, widths[i], 28, { fill: '#fff', stroke: C.line, r: 6 });
    }
    out += text(cx + widths[i] / 2, y + 24, item, 13, {
      fill: item === active ? C.ink : C.muted,
      weight: item === active ? 700 : 400,
      anchor: 'middle',
    });
    cx += widths[i];
  });
  return out;
}

/**
 * Макет таблицы. Ячейка — строка (перевод строки даёт приписку серым) или функция отрисовки: в
 * очереди в ячейках стоят метки состояния и кнопки, а не текст.
 */
function tableMock(x, y, cols, rows, options = {}) {
  const { rowHeight = 62, headHeight = 40, wrapCells = false } = options;
  const width = cols.reduce((a, c) => a + c.w, 0);
  let out = rect(x, y, width, headHeight, { fill: '#f2f4f7', stroke: C.line, r: 4 });
  let hx = x;
  for (const col of cols) {
    out += text(hx + 10, y + headHeight / 2 + 5, col.title, 12, { fill: C.muted, weight: 700 });
    hx += col.w;
  }
  rows.forEach((row, ri) => {
    const ry = y + headHeight + ri * rowHeight;
    out += rect(x, ry, width, rowHeight, { fill: ri % 2 ? '#fcfcfd' : '#fff', stroke: C.line });
    let rx = x;
    cols.forEach((col, ci) => {
      const cell = row[ci];
      if (typeof cell === 'function') out += cell(rx + 10, ry);
      else if (wrapCells) {
        out += paragraph(rx + 10, ry + 25, String(cell ?? ''), col.w - 22, 13, {
          fill: ci === 0 ? C.ink : C.text,
          weight: ci === 0 ? 600 : 400,
          lineHeight: 19,
          maxLines: 3,
        });
      } else {
        String(cell ?? '')
          .split('\n')
          .forEach((value, li) => {
            out += text(rx + 10, ry + 25 + li * 18, value, li === 0 ? 13 : 11.5, {
              fill: li === 0 ? C.ink : C.muted,
              weight: li === 0 ? 600 : 400,
            });
          });
      }
      rx += col.w;
    });
  });
  return { height: headHeight + rows.length * rowHeight, width, svg: out };
}

function page1() {
  let b = rect(0, 0, W, H, { fill: '#f4f8ff' });
  b += circle(905, 150, 240, { fill: '#dbeafe', opacity: 0.62 });
  b += circle(1035, 372, 130, { fill: C.cyanSoft, opacity: 0.9 });
  b += circle(120, 1385, 205, { fill: C.purpleSoft, opacity: 0.7 });
  b += tag(55, 70, 'КРАТКАЯ ИНСТРУКЦИЯ · 9 СТРАНИЦ', {
    fill: C.blue,
    color: '#fff',
    size: 14,
    pad: 16,
  }).svg;
  b += paragraph(55, 175, 'Письма от аппаратов', 700, 49, {
    fill: C.ink,
    weight: 700,
    lineHeight: 62,
    maxLines: 2,
  });
  b += paragraph(
    58,
    300,
    'Аппарат сам отправляет штатное уведомление в технический ящик. Портал ящик читает, письмо разбирает и кладёт счётчики и события в карточку аппарата.',
    640,
    21,
    { fill: C.muted, lineHeight: 31, maxLines: 4 },
  );

  b += rect(742, 250, 296, 300, { fill: '#fff', stroke: '#bae0ff', r: 28, shadow: true });
  b += iconPrinter(768, 300, 76, C.blue);
  b += arrow(866, 335, 916, 335);
  b += iconEnvelope(930, 316, 70, C.cyan);
  b += arrow(890, 430, 890, 466, { color: C.green });
  b += iconCard(866, 476, 54, C.green);
  b += text(890, 582, 'аппарат → ящик → карточка', 14, {
    fill: C.muted,
    anchor: 'middle',
    weight: 600,
  });

  const facts = [
    'Событие уходит сразу, счётчик — раз в неделю.',
    'Пилот — один аппарат: Ricoh Aficio MP C2011SP.',
    'Тревоги портал только показывает: ни писем, ни автозаявок.',
  ];
  facts.forEach((value, i) => {
    b += bullet(58, 420 + i * 46, value, 640, { color: C.blue, size: 16, lineHeight: 22 });
  });

  b += text(55, 640, 'Что внутри', 25, { fill: C.ink, weight: 700 });
  const cards = [
    {
      x: 55,
      color: C.blue,
      fill: C.bluePale,
      title: 'Ящик и аппарат',
      body: 'Переменные сервера, уведомления Ricoh и Kyocera, проверка отправки руками.',
    },
    {
      x: 391,
      color: C.cyan,
      fill: C.cyanSoft,
      title: 'Приём',
      body: 'Путь письма от аппарата до карточки и рубильник, которым приём открывают.',
    },
    {
      x: 727,
      color: C.green,
      fill: C.greenSoft,
      title: 'Разбор',
      body: 'Показания в карточке, очередь непривязанных писем и два необратимых действия.',
    },
  ];
  cards.forEach((card, i) => {
    b += rect(card.x, 685, 310, 235, { fill: card.fill, stroke: `${card.color}55`, r: 18 });
    b += numberDot(i + 1, card.x + 38, 730, card.color, 20);
    b += text(card.x + 70, 737, card.title, 20, { fill: C.ink, weight: 700 });
    b += paragraph(card.x + 26, 795, card.body, 258, 16, {
      fill: C.text,
      lineHeight: 24,
      maxLines: 5,
    });
  });

  b += rect(55, 980, 982, 200, { fill: '#fff', stroke: '#b7eb8f', r: 18, shadow: true });
  b += circle(107, 1034, 25, { fill: C.green });
  b += check(94, 1036, '#fff', 4.5);
  b += text(148, 1038, 'Почему письмами, а не опросом', 22, { fill: C.ink, weight: 700 });
  b += paragraph(
    87,
    1092,
    'Инициатива на стороне аппарата: он сам соединяется с почтовым сервером. Маршрут «портал → принтер» не нужен, агента ставить некуда, VPN не требуется.',
    900,
    18,
    { fill: C.text, lineHeight: 27, maxLines: 3 },
  );

  b += rect(55, 1215, 982, 195, { fill: C.goldSoft, stroke: '#ffe58f', r: 18 });
  b += text(87, 1258, 'Выкат едет выключенным', 20, { fill: C.gold, weight: 700 });
  b += paragraph(
    87,
    1300,
    'Рубильник device_mail_intake заведён со значением «выключено»: портал не принимает письма, пока его не откроют. Пока он закрыт, аппарат может слать письма — они лежат в ящике непрочитанными, и ни одно не теряется.',
    930,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 4 },
  );
  b += footer('Портал «Техник» • приём писем от аппаратов • 18.09.2026');
  return document(b);
}

function page2() {
  let b = header(
    2,
    '1. Как это работает',
    'Путь письма от аппарата до карточки',
    'Ни одного шага человек не делает руками: он настраивает аппарат и ящик, а дальше разбирает только то, что портал не привязал сам.',
  );

  const boxes = [
    {
      title: 'Аппарат',
      body: 'Штатное уведомление: событие — сразу, счётчик — по расписанию. Отправляет сам.',
      color: C.blue,
    },
    {
      title: 'Ящик',
      body: 'Закрытый ящик у провайдера: в него пишут только аппараты.',
      color: C.cyan,
    },
    {
      title: 'Воркер',
      body: 'Раз в пять минут забирает новые письма и отдаёт их API целиком.',
      color: C.purple,
    },
    {
      title: 'Разбор в API',
      body: 'Кладёт сырьё в хранилище, читает MIME, узнаёт вендора, вынимает счётчики и события.',
      color: C.gold,
    },
  ];
  const bw = 224;
  boxes.forEach((box, i) => {
    const x = 55 + i * (bw + 39);
    b += flowBox(x, 230, bw, 165, box.title, box.body, { color: box.color });
    if (i < boxes.length - 1) b += arrow(x + bw + 6, 312, x + bw + 33, 312, { color: C.faint });
  });

  b += rect(340, 440, 443, 56, { fill: C.blueSoft, stroke: '#91caff', r: 28 });
  b += text(561, 476, 'Аппарат опознан однозначно?', 19, {
    fill: C.blueDark,
    weight: 700,
    anchor: 'middle',
  });
  b += arrow(561, 400, 561, 436, { color: C.faint });
  b += path('M 300 520 H 561 V 496', { stroke: C.faint, sw: 2.5 });
  b += path('M 822 520 H 561', { stroke: C.faint, sw: 2.5 });
  b += arrow(300, 520, 300, 556, { color: C.green });
  b += arrow(822, 520, 822, 556, { color: C.orange });
  b += tag(190, 524, 'ДА: СЕРИЙНЫЙ ИЛИ ЗАВЕДЁННАЯ ПРИВЯЗКА', {
    fill: C.greenSoft,
    color: C.green,
    size: 11,
  }).svg;
  b += tag(700, 524, 'НЕТ ИЛИ ПОДХОДЯТ ДВОЕ', {
    fill: C.orangeSoft,
    color: C.orange,
    size: 11,
  }).svg;

  b += flowBox(
    100,
    566,
    400,
    170,
    'Карточка аппарата',
    'Показания и лента событий. Ни одного учётного поля карточки телеметрия не меняет: ни модель, ни площадку, ни серийный номер.',
    { color: C.green, fill: C.greenSoft },
  );
  b += flowBox(
    622,
    566,
    400,
    170,
    'Очередь «Письма устройств»',
    'Разбор лежит снимком и ждёт человека. Ни одна карточка при этом не тронута — случайную портал не обновляет никогда.',
    { color: C.orange, fill: C.orangeSoft },
  );

  b += text(55, 810, 'Что важно знать про приём', 22, { fill: C.ink, weight: 700 });
  const notes = [
    {
      title: 'Воркер — только транспорт',
      body: 'Он не разбирает письма и не читает рубильник: правила и словари живут в API. Второй экземпляр правил разошёлся бы молча.',
      color: C.purple,
      fill: C.purpleSoft,
    },
    {
      title: 'Курсор сдвигается последним',
      body: 'Строка письма появляется раньше сырья, а отметка «прочитано» — после всего. Падение посередине означает повтор, а не потерю письма.',
      color: C.blue,
      fill: C.bluePale,
    },
    {
      title: 'Одно письмо не держит остальные',
      body: 'Тяжёлое, битое или непонятное письмо получает свою строку с причиной, и разбор идёт дальше по ящику.',
      color: C.cyan,
      fill: C.cyanSoft,
    },
  ];
  notes.forEach((note, i) => {
    const x = 55 + i * 336;
    b += rect(x, 850, 310, 215, { fill: note.fill, stroke: `${note.color}55`, r: 16 });
    b += text(x + 24, 890, note.title, 17, { fill: C.ink, weight: 700 });
    b += paragraph(x + 24, 928, note.body, 262, 14, {
      fill: C.text,
      lineHeight: 21,
      maxLines: 6,
    });
  });

  b += rect(55, 1105, 1013, 170, { fill: '#fff', stroke: '#d3adf7', r: 16 });
  b += circle(107, 1160, 24, { fill: C.purple });
  b += text(107, 1168, '2', 20, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(148, 1167, 'Этап 2 войдёт тем же слоем', 20, { fill: C.ink, weight: 700 });
  b += paragraph(
    87,
    1215,
    'Будущий сборщик в локальной сети будет писать те же таблицы с другим источником. Всё, что выше разбора — карточка, очередь, отчёты, — про почту не знает вовсе, и менять их второй этап не будет.',
    930,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 3 },
  );
  b += footer('Портал «Техник» • путь письма • 18.09.2026');
  return document(b);
}

function page3() {
  let b = header(
    3,
    '2. Ящик',
    'Технический ящик и переменные сервера',
    'Нужен отдельный ящик, который не публикуется нигде: в него пишут только аппараты. Порталу от него нужен доступ по IMAP.',
  );

  b += text(55, 240, 'Блок в prod.env', 20, { fill: C.ink, weight: 700 });
  const env = codeBlock(55, 262, 505, [
    'DEVICE_MAIL_ENABLED=true',
    'DEVICE_MAIL_IMAP_HOST=imap.provider.ru',
    'DEVICE_MAIL_IMAP_PORT=993',
    'DEVICE_MAIL_IMAP_SECURE=true',
    'DEVICE_MAIL_IMAP_USER=mfp@example.ru',
    'DEVICE_MAIL_IMAP_PASSWORD=••••••••••',
    'DEVICE_MAIL_ACCOUNT=default',
    'DEVICE_MAIL_POLL_INTERVAL_MS=300000',
  ]);
  b += env.svg;

  b += rect(590, 262, 478, env.height, { fill: C.bluePale, stroke: '#91caff', r: 12 });
  b += text(618, 305, 'Полный перечень — в .env.example', 18, { fill: C.blueDark, weight: 700 });
  b += paragraph(
    618,
    343,
    'Блок DEVICE_MAIL_* в .env.example описан построчно, с пояснением к каждой строке.',
    422,
    15,
    { fill: C.text, lineHeight: 22, maxLines: 3 },
  );
  b += line(618, 412, 1040, 412, { stroke: '#91caff' });
  b += paragraph(
    618,
    445,
    'Пароль ящика читает только воркер. В конфигурации портала его нет и быть не должно.',
    422,
    15,
    { fill: C.blueDark, lineHeight: 22, maxLines: 3, weight: 600 },
  );

  const rows = tableMock(
    55,
    600,
    [
      { title: 'Переменная', w: 400 },
      { title: 'Что это', w: 613 },
    ],
    [
      [
        (x, y) => mono(x, y + 37, 'DEVICE_MAIL_ENABLED', 14, { fill: C.ink, weight: 700 }),
        'true — воркер начинает заходить в ящик\nЭто не рубильник приёма, а «контур настроен на этом сервере»',
      ],
      [
        (x, y) =>
          mono(x, y + 37, 'DEVICE_MAIL_IMAP_HOST / _PORT / _SECURE', 13, {
            fill: C.ink,
            weight: 700,
          }),
        'Адрес ящика\n993 и true — обычный случай: implicit TLS',
      ],
      [
        (x, y) =>
          mono(x, y + 37, 'DEVICE_MAIL_IMAP_USER / _PASSWORD', 14, { fill: C.ink, weight: 700 }),
        'Учётные данные ящика\nВ журнал не попадают ни при какой ошибке',
      ],
      [
        (x, y) => mono(x, y + 37, 'DEVICE_MAIL_ACCOUNT', 14, { fill: C.ink, weight: 700 }),
        'Ключ ящика в журнале\nМенять незачем, но пустым оставлять нельзя',
      ],
      [
        (x, y) => mono(x, y + 37, 'DEVICE_MAIL_POLL_INTERVAL_MS', 14, { fill: C.ink, weight: 700 }),
        'Как часто заходить в ящик\nУмолчание — пять минут; живого канала к серверу нет, IDLE не используется',
      ],
    ],
    { rowHeight: 66 },
  );
  b += text(55, 575, 'Что означает каждая строка', 20, { fill: C.ink, weight: 700 });
  b += rows.svg;

  const wy = 600 + rows.height + 45;
  b += rect(55, wy, 1013, 190, { fill: C.redSoft, stroke: '#ffccc7', r: 16 });
  b += circle(107, wy + 55, 25, { fill: C.red });
  b += text(107, wy + 63, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(148, wy + 62, 'Если аппарат не может отправить письмо через этот ящик', 20, {
    fill: C.ink,
    weight: 700,
  });
  b += paragraph(
    87,
    wy + 110,
    'Скорее всего он не умеет современный TLS: поколение Aficio этим славится. Это не настройка, а свойство аппарата — решение (другой аппарат, другой ящик или пересылающий узел) принимается отдельно.',
    930,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 3 },
  );

  const ey = wy + 215;
  b += text(55, ey, 'Ещё четыре переменные, о которых стоит знать', 20, {
    fill: C.ink,
    weight: 700,
  });
  const extras = [
    [
      'DEVICE_MAIL_MAX_SIZE_BYTES',
      'Потолок размера. Тяжёлое письмо не скачивается: строка с причиной, и разбор идёт дальше',
    ],
    [
      'DEVICE_MAIL_ALLOWED_SENDERS',
      'Отправители, которым верим, через запятую. Пусто — верим всем, кто дописался в ящик',
    ],
    [
      'DEVICE_MAIL_RAW_TTL_DAYS',
      'Сколько дней живёт сырое письмо. Тридцать: столько нужно на горячий разбор',
    ],
    [
      'DEVICE_MAIL_TRANSPORT',
      'Каталог с .eml вместо сервера (значение dir) — так приёмник проверяют без ящика',
    ],
  ];
  extras.forEach((row, i) => {
    const ry = ey + 28 + i * 56;
    b += rect(55, ry, 1013, 48, { fill: C.graySoft, stroke: C.line, r: 8 });
    b += mono(75, ry + 30, row[0], 13, { fill: C.ink, weight: 700 });
    b += text(415, ry + 30, row[1], 13, { fill: C.muted });
  });
  b += footer('Портал «Техник» • технический ящик • 18.09.2026');
  return document(b);
}

function page4() {
  let b = header(
    4,
    '3. Аппарат',
    'Ricoh и Kyocera: штатные уведомления',
    'Включается средство самого аппарата, никакого агента ставить не нужно. Получателем везде ставится технический ящик.',
  );

  b += rect(55, 215, 496, 620, { fill: '#fff', stroke: '#91caff', r: 16, shadow: true });
  b += rect(55, 215, 496, 6, { fill: C.blue, r: 3 });
  b += text(87, 268, 'Ricoh', 26, { fill: C.ink, weight: 700 });
  b += paragraph(87, 306, 'Web Image Monitor → Настройки устройства → Электронная почта', 432, 14, {
    fill: C.muted,
    lineHeight: 20,
    maxLines: 2,
  });
  b += numberDot(1, 105, 370, C.blue, 16);
  b += text(133, 376, 'Сначала SMTP-сервер', 17, { fill: C.ink, weight: 700 });
  b += paragraph(133, 404, 'Адрес, порт, шифрование и учётные данные отправки.', 390, 14, {
    fill: C.muted,
    lineHeight: 20,
    maxLines: 2,
  });
  b += numberDot(2, 105, 470, C.blue, 16);
  b += text(133, 476, 'Уведомление о состоянии', 17, { fill: C.ink, weight: 700 });
  b += toggle(480, 462, true);
  b += paragraph(
    133,
    504,
    'Замятие, кончился тонер, открыта крышка, вызов сервиса. Уходит в момент события.',
    330,
    14,
    { fill: C.muted, lineHeight: 20, maxLines: 3 },
  );
  b += numberDot(3, 105, 580, C.blue, 16);
  b += text(133, 586, 'Counter Information Notification', 17, { fill: C.ink, weight: 700 });
  b += toggle(480, 572, true);
  b += paragraph(133, 614, 'Отчёт со счётчиком по расписанию — настраивается отдельно.', 330, 14, {
    fill: C.muted,
    lineHeight: 20,
    maxLines: 2,
  });
  b += rect(133, 650, 386, 62, { fill: C.blueSoft, stroke: '#91caff', r: 8 });
  b += text(150, 675, 'Периодичность', 13, { fill: C.blueDark, weight: 700 });
  b += text(150, 697, 'Раз в неделю — согласованная частота', 14, { fill: C.text });
  b += paragraph(
    87,
    760,
    'Ежедневного отчёта портал не ждёт: в этом этапе счётчик нужен как свежее значение, а не как ряд за каждый день.',
    432,
    14,
    { fill: C.muted, lineHeight: 21, maxLines: 3 },
  );

  b += rect(572, 215, 496, 620, { fill: '#fff', stroke: '#87e8de', r: 16, shadow: true });
  b += rect(572, 215, 496, 6, { fill: C.cyan, r: 3 });
  b += text(604, 268, 'Kyocera', 26, { fill: C.ink, weight: 700 });
  b += paragraph(604, 306, 'Command Center RX → Управление → Уведомления', 432, 14, {
    fill: C.muted,
    lineHeight: 20,
    maxLines: 2,
  });
  b += numberDot(1, 622, 370, C.cyan, 16);
  b += text(650, 376, 'События есть', 17, { fill: C.ink, weight: 700 });
  b += toggle(997, 362, true);
  b += paragraph(650, 404, 'Тот же набор: расходники, бумага, замятие, вызов сервиса.', 330, 14, {
    fill: C.muted,
    lineHeight: 20,
    maxLines: 2,
  });
  b += numberDot(2, 622, 470, C.cyan, 16);
  b += text(650, 476, 'Отчёта со счётчиком, скорее всего, нет', 17, { fill: C.ink, weight: 700 });
  b += paragraph(
    650,
    504,
    'Так и должно быть: в уведомлениях Kyocera счётчика не заявлено. Портал примет то, что придёт, и не будет ждать остального.',
    386,
    14,
    { fill: C.muted, lineHeight: 20, maxLines: 4 },
  );
  b += rect(604, 580, 432, 132, { fill: C.cyanSoft, stroke: '#87e8de', r: 12 });
  b += text(628, 618, 'Про другие вендоры', 17, { fill: C.cyan, weight: 700 });
  b += paragraph(
    628,
    650,
    'Pantum умеет SMTP только для сканирования в почту — такие аппараты ждут второго этапа. HP и Xerox проверяются отдельно, по живому письму.',
    384,
    14,
    { fill: C.text, lineHeight: 20, maxLines: 4 },
  );

  b += rect(55, 875, 1013, 175, { fill: C.goldSoft, stroke: '#ffe58f', r: 16 });
  b += text(87, 918, 'Что опознаёт аппарат само', 20, { fill: C.gold, weight: 700 });
  b += paragraph(
    87,
    958,
    'Само письмо находит карточку только по серийному номеру. Имя устройства, сетевое имя и адреса не опознают аппарат ни при каком значении: их привязывают руками один раз, и дальше письма этого аппарата опознаются сами. Переименовывать парк под портал не нужно.',
    930,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 3 },
  );

  b += rect(55, 1090, 1013, 195, { fill: '#fff', stroke: '#b7eb8f', r: 16, shadow: true });
  b += circle(107, 1143, 25, { fill: C.green });
  b += check(94, 1145, '#fff', 4.5);
  b += text(148, 1147, 'Проверка на месте', 20, { fill: C.ink, weight: 700 });
  b += bullet(87, 1200, 'Вызовите событие руками: откройте лоток или вытащите картридж.', 450, {
    color: C.green,
    size: 15,
    lineHeight: 22,
  });
  b += bullet(
    560,
    1200,
    'Убедитесь, что письмо появилось в ящике. Дальше оно пока не пойдёт.',
    450,
    {
      color: C.green,
      size: 15,
      lineHeight: 22,
    },
  );
  b += paragraph(
    87,
    1258,
    'Пока рубильник приёма закрыт, письмо ждёт в ящике — это нормальный ход проверки, а не сбой.',
    930,
    15,
    { fill: C.muted, lineHeight: 22, maxLines: 2 },
  );
  b += footer('Портал «Техник» • настройка аппарата • 18.09.2026');
  return document(b);
}

function page5() {
  let b = header(
    5,
    '4. Открыть приём',
    'Рубильник и порядок работ',
    'Приём открывается одним запросом к базе. Перезапуск не нужен: через несколько минут письма поедут в портал.',
  );

  b += text(55, 240, 'Открыть приём', 20, { fill: C.ink, weight: 700 });
  const open = codeBlock(55, 262, 1013, [
    '-- открыть приём писем от аппаратов',
    "UPDATE feature_flags SET is_enabled = true WHERE key = 'device_mail_intake';",
  ]);
  b += open.svg;

  let y = 262 + open.height + 40;
  b += text(55, y, 'Закрыть приём', 20, { fill: C.ink, weight: 700 });
  const close = codeBlock(55, y + 22, 1013, [
    '-- закрыть: письма останутся в ящике и дождутся включения',
    "UPDATE feature_flags SET is_enabled = false WHERE key = 'device_mail_intake';",
  ]);
  b += close.svg;
  y = y + 22 + close.height + 45;

  b += rect(55, y, 1013, 120, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += circle(107, y + 58, 24, { fill: C.green });
  b += check(94, y + 60, '#fff', 4.5);
  b += paragraph(
    148,
    y + 52,
    'Закрытый рубильник ничего не теряет: портал не помечает письма прочитанными, пока не принял их. Закрыть приём на сутки безопасно.',
    880,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 2 },
  );
  y += 165;

  b += text(55, y, 'Порядок работ целиком', 22, { fill: C.ink, weight: 700 });
  y += 30;
  const steps = [
    [
      'Ящик',
      'Завести отдельный ящик и прописать его порталу блоком DEVICE_MAIL_* на сервере.',
      C.blue,
    ],
    [
      'Аппарат',
      'Включить отправку на одном аппарате и убедиться, что письмо уходит в ящик.',
      C.cyan,
    ],
    ['Рубильник', 'Открыть приём запросом выше и посмотреть, что приехало в портал.', C.purple],
    [
      'Очередь',
      'Разобрать письма, которые портал не привязал сам: связать их с карточками.',
      C.green,
    ],
  ];
  steps.forEach((step, i) => {
    const x = 55 + (i % 2) * 520;
    const sy = y + Math.floor(i / 2) * 185;
    b += callout(x, sy, 493, 165, i + 1, step[0], step[1], {
      fill: '#fff',
      stroke: `${step[2]}55`,
      color: step[2],
    });
  });
  y += 2 * 185 + 20;

  b += rect(55, y, 1013, 150, { fill: C.bluePale, stroke: '#91caff', r: 16 });
  b += text(87, y + 45, 'Кому это доступно', 19, { fill: C.blueDark, weight: 700 });
  b += paragraph(
    87,
    y + 85,
    'Очередь и её действия закрыты правом «Разбирает письма от аппаратов»; у набора «Орг.техника: ИТ-служба» оно есть. Показания в карточке видит тот, кому открыта сама карточка.',
    930,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 3 },
  );
  b += footer('Портал «Техник» • включение приёма • 18.09.2026');
  return document(b);
}

function page6() {
  let b = header(
    6,
    '5. Карточка аппарата',
    'Показания и события',
    'Опознанное письмо в очередь не попадает вовсе: его показания уже в карточке, в блоке «Показания и события».',
  );

  const x = 55;
  const y = 215;
  b += winFrame(x, y, 1013, 880, 'Техника');
  b += text(x + 24, y + 145, 'Ricoh Aficio MP C2011SP · инв. 3282 · Площадка «Заречная»', 19, {
    fill: C.ink,
    weight: 700,
  });
  b += text(x + 24, y + 180, 'Показания и события', 17, { fill: C.ink, weight: 700 });

  const metrics = [
    ['Общий счётчик', '128 470 оттисков'],
    ['Напечатано оттисков', '126 918 оттисков'],
    ['Чёрно-белая печать', '101 240 оттисков'],
    ['Цветная печать', '25 678 оттисков'],
    ['Остаток расходника · Чёрный', '18 %'],
    ['Остаток расходника · Жёлтый', '64 %'],
    ['Остаток ресурса · Чёрный', '900 страниц'],
    ['Замен расходника · Чёрный', '6 раз'],
  ];
  metrics.forEach((row, i) => {
    const mx = x + 24 + (i % 2) * 495;
    const my = y + 225 + Math.floor(i / 2) * 44;
    b += text(mx, my, `${row[0]}:`, 12.5, { fill: C.muted });
    b += text(mx + 218, my, row[1], 13.5, { fill: C.ink, weight: 600 });
    // Отметка одна на все показания и названа вслух: это приём порталом, а не время аппарата.
    b += text(mx + 468, my, 'принято 18.09 09:12', 11, { fill: C.faint, anchor: 'end' });
  });
  b += text(
    x + 24,
    y + 400,
    'Отметка «принято» — когда портал узнал число, а не когда его назвал аппарат.',
    12.5,
    {
      fill: C.faint,
    },
  );

  const events = tableMock(
    x + 24,
    y + 420,
    [
      { title: 'Когда', w: 190 },
      { title: 'Важность', w: 130 },
      { title: 'Что случилось', w: 475 },
      { title: 'Откуда', w: 150 },
    ],
    [
      [
        '18.09.2026 09:12',
        (cx, cy) => tag(cx, cy + 17, 'Внимание', { fill: C.orangeSoft, color: C.orange }).svg,
        'Заканчивается тонер\nBlack toner almost empty · toner-low',
        (cx, cy) => text(cx, cy + 35, 'Письмо аппарата', 12, { fill: C.muted }),
      ],
      [
        '17.09.2026 21:40\n(приём)',
        (cx, cy) => tag(cx, cy + 17, 'Критично', { fill: C.redSoft, color: C.red }).svg,
        'Вызов сервисной службы\nSC554-00',
        (cx, cy) => text(cx, cy + 35, 'Письмо аппарата', 12, { fill: C.muted }),
      ],
      [
        '16.09.2026 14:05',
        (cx, cy) => tag(cx, cy + 17, 'Внимание', { fill: C.orangeSoft, color: C.orange }).svg,
        'Замятие бумаги',
        (cx, cy) => text(cx, cy + 35, 'Письмо аппарата', 12, { fill: C.muted }),
      ],
    ],
    { rowHeight: 66 },
  );
  b += events.svg;

  b += rect(x + 24, y + 420 + events.height + 30, 965, 130, {
    fill: C.bluePale,
    stroke: '#91caff',
    r: 12,
  });
  b += text(x + 52, y + 420 + events.height + 70, 'Две отметки времени и они разные', 17, {
    fill: C.blueDark,
    weight: 700,
  });
  b += paragraph(
    x + 52,
    y + 420 + events.height + 102,
    'У показания отметка — «принято»: когда портал узнал число. У события показано время аппарата, потому что оно случилось тогда; приписка «(приём)» значит, что своего времени аппарат не назвал.',
    905,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 3 },
  );

  b += rect(55, 1150, 496, 165, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += text(87, 1195, 'Ничего не приходило', 18, { fill: C.green, weight: 700 });
  b += paragraph(
    87,
    1232,
    'Блок так и говорит: «Аппарат ещё не присылал писем». Это не поломка портала, а повод настроить уведомления на аппарате.',
    432,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 4 },
  );
  b += rect(572, 1150, 496, 165, { fill: C.redSoft, stroke: '#ffccc7', r: 16 });
  b += text(604, 1195, 'Карточку телеметрия не правит', 18, { fill: C.red, weight: 700 });
  b += paragraph(
    604,
    1232,
    'Письмо «от МФУ» может прислать кто угодно: аппарат не аутентифицируется. Поэтому модель, площадку и номера правит человек с правом и со следом в журнале.',
    432,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 4 },
  );
  b += footer('Портал «Техник» • блок карточки • 18.09.2026');
  return document(b);
}

function page7() {
  let b = header(
    7,
    '6. Очередь писем',
    'Разбор того, что портал не привязал сам',
    'Путь: Орг.техника → вкладка «Техника» → переключатель «Письма устройств». Порядок в очереди — старые сверху: чья очередь, а не что нового.',
  );

  const x = 55;
  const y = 215;
  b += winFrame(x, y, 1013, 690, 'Техника');
  b += segmented(x + 24, y + 120, ['Парк', 'На проверке', 'Письма устройств'], 'Письма устройств');

  b += rect(x + 24, y + 175, 965, 78, { fill: C.goldSoft, stroke: '#ffe58f', r: 8 });
  b += circle(x + 56, y + 214, 15, { fill: C.gold });
  b += text(x + 56, y + 221, '!', 16, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(x + 84, y + 207, 'Курсор ящика стоит с 18.09.2026 06:40', 15, {
    fill: C.ink,
    weight: 700,
  });
  b += text(x + 84, y + 232, 'default · authentication failed · попыток: 4', 13, { fill: C.muted });

  const queue = tableMock(
    x + 24,
    y + 280,
    [
      { title: 'Принято', w: 110 },
      { title: 'Письмо', w: 200 },
      { title: 'Что видно', w: 205 },
      { title: 'Состояние', w: 190 },
      { title: 'Ждёт', w: 75 },
      { title: '', w: 185 },
    ],
    [
      [
        '18.09 09:12',
        'Counter Information\nmfp-01@example.ru',
        'Серийный: W513PB0123\nIP: 10.10.4.21',
        (cx, cy) =>
          tag(cx, cy + 20, 'Аппарат не опознан', { fill: C.orangeSoft, color: C.orange, size: 12 })
            .svg,
        '3 / 1',
        (cx, cy) =>
          text(cx, cy + 30, 'Привязать · Перечитать', 12, { fill: C.blue, weight: 600 }) +
          text(cx, cy + 52, 'Игнорировать', 12, { fill: C.blue }),
      ],
      [
        '18.09 08:40',
        'Device Status Alert\nmfp-01@example.ru',
        'Инвентарный: 3282',
        (cx, cy) =>
          tag(cx, cy + 20, 'Подходит нескольким', { fill: C.purpleSoft, color: C.purple, size: 12 })
            .svg,
        '2 / 0',
        (cx, cy) =>
          text(cx, cy + 30, 'Привязать · Перечитать', 12, { fill: C.blue, weight: 600 }) +
          text(cx, cy + 52, 'Игнорировать', 12, { fill: C.blue }),
      ],
      [
        '17.09 22:15',
        'Toner alert\nprinter@example.ru',
        'Аппарат себя не назвал',
        (cx, cy) =>
          tag(cx, cy + 20, 'Формат не распознан', { fill: C.bluePale, color: C.blueDark, size: 12 })
            .svg,
        '0 / 0',
        (cx, cy) =>
          text(cx, cy + 30, 'Привязать · Перечитать', 12, { fill: C.blue, weight: 600 }) +
          text(cx, cy + 52, 'Игнорировать', 12, { fill: C.blue }),
      ],
      [
        '17.09 19:02',
        'Counter report\nmfp-07@example.ru',
        'Имя устройства: INV-1147',
        (cx, cy) =>
          tag(cx, cy + 14, 'Ошибка разбора', { fill: C.redSoft, color: C.red, size: 12 }).svg +
          text(cx, cy + 56, 'счётчик не разобран', 11, { fill: C.muted }),
        '0 / 0',
        (cx, cy) =>
          text(cx, cy + 30, 'Привязать · Перечитать', 12, { fill: C.blue, weight: 600 }) +
          text(cx, cy + 52, 'Игнорировать', 12, { fill: C.blue }),
      ],
    ],
    { rowHeight: 74 },
  );
  b += queue.svg;
  b += text(x + 24, y + 280 + queue.height + 32, 'Показать ещё', 14, {
    fill: C.blue,
    weight: 600,
  });

  b += text(55, 960, 'Что означает каждое состояние', 22, { fill: C.ink, weight: 700 });
  const triage = tableMock(
    55,
    985,
    [
      { title: 'Что видно', w: 250 },
      { title: 'Что это значит', w: 410 },
      { title: 'Что делать', w: 353 },
    ],
    [
      [
        'Аппарат не опознан',
        'Номера из письма нет ни в одной карточке',
        '«Привязать»: выбрать карточку и ключ',
      ],
      [
        'Подходит нескольким',
        'Номер нашёлся у двух карточек',
        'Разобраться, чей он, и привязать к одной',
      ],
      [
        'Формат не распознан',
        'Письмо от аппарата, которого портал ещё не умеет читать',
        'Оставить: по таким письмам заводят новый разборщик',
      ],
      [
        'Ошибка разбора',
        'Письмо прочитано, поля не вычитались',
        '«Перечитать» после правки разборщика',
      ],
      [
        'Курсор стоит (строка сверху)',
        'Портал не может прочитать сам ящик: пароль, сеть, TLS',
        'Починить доступ к ящику — это не про письмо',
      ],
    ],
    { rowHeight: 62, wrapCells: true },
  );
  b += triage.svg;

  const ny = 985 + triage.height + 35;
  b += rect(55, ny, 1013, 120, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += paragraph(
    87,
    ny + 48,
    'Опознанное письмо в очередь не попадает вовсе. Пустая очередь — это норма и цель работы, и портал говорит об этом словами: «Непривязанных писем нет — всё разобрано».',
    950,
    16,
    { fill: C.text, lineHeight: 24, maxLines: 2 },
  );
  b += footer('Портал «Техник» • очередь писем устройств • 18.09.2026');
  return document(b);
}

function page8() {
  let b = header(
    8,
    '7. Привязка',
    'Связать письмо с карточкой',
    'Окно «Привязать» показывает всё, чем письмо себя назвало, и просит выбрать ключ, карточку и — по желанию — примечание.',
  );

  const x = 55;
  const y = 215;
  b += rect(x, y, 540, 770, { fill: '#fff', stroke: '#d0d5dd', r: 12, shadow: true });
  b += text(x + 28, y + 48, 'Привязать письмо к аппарату', 20, { fill: C.ink, weight: 700 });
  b += line(x, y + 72, x + 540, y + 72, { stroke: C.line });
  const facts = [
    ['Тема', 'Counter Information'],
    ['От кого', 'mfp-01@example.ru'],
    ['Адрес получателя', 'mfp@example.ru'],
    ['Серийный номер', 'W513PB0123'],
    ['IP (не ключ)', '10.10.4.21'],
  ];
  facts.forEach((row, i) => {
    const fy = y + 108 + i * 30;
    b += text(x + 28, fy, `${row[0]}:`, 13, { fill: C.muted });
    b += text(x + 210, fy, row[1], 13, { fill: C.ink, weight: 600 });
  });
  b += field(x + 28, y + 280, 484, 'Чем связываем', 'Серийный номер', {});
  b += field(x + 28, y + 370, 484, 'Значение ключа', 'W513PB0123', { mono: true });
  b += field(x + 28, y + 460, 484, 'Какая карточка', 'Ricoh Aficio MP C2011SP · инв. 3282', {});
  b += field(x + 28, y + 550, 484, 'Примечание', 'Проверено по табличке на корпусе', {
    muted: true,
  });
  b += rect(x + 28, y + 630, 484, 44, { fill: C.blueSoft, stroke: '#91caff', r: 8 });
  b += text(x + 44, y + 658, 'Писем этого аппарата в очереди: 7', 14, {
    fill: C.blueDark,
    weight: 600,
  });
  b += button(x + 300, y + 700, 100, 'Отмена', { compact: true });
  b += button(x + 410, y + 700, 102, 'Привязать', { primary: true, compact: true });

  b += rect(627, y, 441, 330, { fill: C.bluePale, stroke: '#91caff', r: 16 });
  b += text(659, y + 48, 'Пачкой или только это письмо', 19, { fill: C.blueDark, weight: 700 });
  b += bullet(
    659,
    y + 100,
    'Серийный, инвентарный и имя устройства применяют сразу все накопленные письма этого аппарата — портал заранее говорит, сколько их.',
    380,
    { color: C.blue, size: 14, lineHeight: 21 },
  );
  b += bullet(
    659,
    y + 200,
    'Адрес применяет только выбранное письмо: один служебный адрес часто прописан всему парку, и пачка приписала бы одной карточке письма десятка аппаратов.',
    380,
    { color: C.blue, size: 14, lineHeight: 21 },
  );

  b += rect(627, y + 360, 441, 165, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += text(659, y + 405, 'Привязка работает и через полгода', 18, { fill: C.green, weight: 700 });
  b += paragraph(
    659,
    y + 442,
    'Разбор письма хранится снимком, и «Привязать» применяет снимок, а не перечитывает сырьё: очередь разбирается и после того, как сырое письмо вычищено по сроку.',
    380,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 4 },
  );

  b += rect(627, y + 555, 441, 145, { fill: C.orangeSoft, stroke: '#ffd591', r: 16 });
  b += text(659, y + 600, 'Серийник в письме не тот', 18, { fill: C.orange, weight: 700 });
  b += paragraph(
    659,
    y + 637,
    'Портал скажет об этом в очереди, а карточку не тронет: расхождение — повод для пометки, а не для правки учётных полей.',
    380,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 3 },
  );

  b += text(55, 1045, 'Два необратимых действия, и они разные', 22, { fill: C.ink, weight: 700 });
  b += rect(55, 1075, 496, 290, { fill: '#fff', stroke: '#ffccc7', r: 16, shadow: true });
  b += rect(55, 1075, 496, 6, { fill: C.red, r: 3 });
  b += text(87, 1128, 'Игнорировать', 22, { fill: C.red, weight: 700 });
  b += paragraph(87, 1168, 'Письмо не нужно.', 432, 16, {
    fill: C.ink,
    lineHeight: 24,
    weight: 600,
  });
  b += paragraph(
    87,
    1205,
    'Оно уходит из очереди, и его показания в карточку не попадут никогда. Списка отброшенных в портале нет, обратной ручки тоже — поэтому портал спрашивает подтверждение и называет последствие.',
    432,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 6 },
  );
  b += button(87, 1305, 160, 'Отбросить', { danger: true, compact: true });

  b += rect(572, 1075, 496, 290, { fill: '#fff', stroke: '#d0d5dd', r: 16, shadow: true });
  b += rect(572, 1075, 496, 6, { fill: C.muted, r: 3 });
  b += text(604, 1128, 'Просмотрено', 22, { fill: C.ink, weight: 700 });
  b += paragraph(604, 1168, 'Письмо нечем решить.', 432, 16, {
    fill: C.ink,
    lineHeight: 24,
    weight: 600,
  });
  b += paragraph(
    604,
    1205,
    'След для письма, у которого другого выхода нет: закрытое по счётчику застревания, без тела. Письмо, ждущее привязки, так закрыть нельзя — портал откажет словами, а кнопки у такой строки и не будет.',
    432,
    14,
    { fill: C.text, lineHeight: 21, maxLines: 6 },
  );
  b += button(604, 1305, 160, 'Отметить', { compact: true });
  b += footer('Портал «Техник» • привязка и необратимые действия • 18.09.2026');
  return document(b);
}

function page9() {
  let b = header(
    9,
    '8. Если что-то не так',
    'Разбор по порядку',
    'Три четверти случаев решаются четырьмя вопросами, и задавать их стоит именно в этом порядке.',
  );

  const cases = [
    {
      title: 'Писем нет вовсе',
      body: 'Письмо в ящике есть? Нет — дело в аппарате, смотрите страницу 4. Рубильник открыт? Строка «курсор стоит» в шапке очереди пустая? В журнале воркера есть «Ящик оргтехники не читается»?',
      color: C.blue,
      fill: C.bluePale,
    },
    {
      title: 'Письма приходят, показаний в карточке нет',
      body: 'Смотрите очередь: письмо либо ждёт привязки, либо не распознано. Это штатные состояния, а не поломка — портал намеренно не обновляет карточку, в которой не уверен.',
      color: C.cyan,
      fill: C.cyanSoft,
    },
    {
      title: 'Кнопки «Перечитать» нет',
      body: 'Сырое письмо хранится 30 дней; после этого перечитывать нечем, и кнопка не показывается. Правка разборщика достанет только свежие письма — это принятая цена.',
      color: C.gold,
      fill: C.goldSoft,
    },
    {
      title: 'Письмо большое',
      body: 'Письма тяжелее пяти мегабайт портал не забирает целиком: заводит строку с причиной и идёт дальше, чтобы одно тяжёлое не задерживало остальные.',
      color: C.purple,
      fill: C.purpleSoft,
    },
  ];
  cases.forEach((item, i) => {
    const cx = 55 + (i % 2) * 520;
    const cy = 230 + Math.floor(i / 2) * 250;
    b += rect(cx, cy, 493, 225, { fill: item.fill, stroke: `${item.color}55`, r: 16 });
    b += numberDot(i + 1, cx + 38, cy + 44, item.color, 17);
    b += paragraph(cx + 68, cy + 38, item.title, 380, 18, {
      fill: C.ink,
      weight: 700,
      lineHeight: 24,
      maxLines: 2,
    });
    b += paragraph(cx + 26, cy + 105, item.body, 440, 14, {
      fill: C.text,
      lineHeight: 21,
      maxLines: 6,
    });
  });

  b += text(55, 775, 'Названные границы этого этапа', 22, { fill: C.ink, weight: 700 });
  b += rect(55, 800, 1013, 310, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  const limits = [
    'Пропущенное письмо не восстанавливается: аппарат отправляет один раз и историю не хранит.',
    'Счётчик присылают не все аппараты — события приедут, отчёт со счётчиком зависит от модели.',
    'Телеметрия не меняет карточку ни одним полем: аппарат не аутентифицируется.',
    'Сырое письмо живёт 30 дней, дальше остаётся только разобранный снимок.',
    'Тревожных писем портал никому не рассылает и заявок по ним не создаёт — только показывает.',
    'Аппараты, умеющие SMTP лишь для сканирования в почту, ждут второго этапа.',
  ];
  limits.forEach((value, i) => {
    b += bullet(87, 850 + i * 42, value, 950, { color: C.blue, size: 15, lineHeight: 21 });
  });

  b += rect(55, 1150, 1013, 210, { fill: C.bluePale, stroke: '#91caff', r: 16 });
  b += text(87, 1198, 'Где читать дальше', 20, { fill: C.blueDark, weight: 700 });
  b += bullet(87, 1245, 'docs/guide-device-mail.md — полный текст этой инструкции.', 450, {
    color: C.blue,
    size: 14,
    lineHeight: 20,
  });
  b += bullet(
    560,
    1245,
    'docs/adr/0197-device-mail-telemetry.md — принятое решение и отвергнутые ветви.',
    450,
    {
      color: C.blue,
      size: 14,
      lineHeight: 20,
    },
  );
  b += bullet(87, 1310, '.env.example, блок DEVICE_MAIL_* — все переменные построчно.', 450, {
    color: C.blue,
    size: 14,
    lineHeight: 20,
  });
  b += bullet(560, 1310, 'guide-office-equipment-mail.md — про исходящие письма модуля.', 450, {
    color: C.blue,
    size: 14,
    lineHeight: 20,
  });
  b += footer('Портал «Техник» • разбор неполадок • 18.09.2026');
  return document(b);
}

const pages = [page1(), page2(), page3(), page4(), page5(), page6(), page7(), page8(), page9()];

for (const [index, svg] of pages.entries()) {
  const stem = `device-mail-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Письма от аппаратов — краткая инструкция');
pdf.setSubject('Настройка технического ящика и аппаратов, включение приёма и разбор очереди писем');
pdf.setKeywords(['оргтехника', 'МФУ', 'телеметрия', 'почта', 'IMAP', 'инструкция']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-18T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `device-mail-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
