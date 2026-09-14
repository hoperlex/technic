import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Единый редактируемый исходник четырёх руководств по модулю «Орг.техника».
 *
 * PDF намеренно собирается из PPTX: текст остаётся доступным для поиска и копирования, а каждое
 * руководство можно поправить в PowerPoint. Редакция 3 построена по образцу инструкции водителя:
 * реальные экраны актуальной версии приложения слева, пронумерованные действия справа, короткие
 * правила ниже. Руководства описывают функциональность как выпущенную к моменту публикации.
 */

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const PptxGenJS = require('pptxgenjs');
const LABELS = JSON.parse(
  readFileSync(new URL('./labels/service-request-labels.json', import.meta.url), 'utf8'),
);

const OUT_DIR = resolve(process.argv[2] ?? 'docs');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR = join(SCRIPT_DIR, 'image', 'office-equipment-latest');
const STAMP_ISO = '2026-09-07T12:00:00+05:00';
const STAMP_PDF = "20260907120000+05'00'";

const FONT = 'Arial';
const W = 8.27;
const H = 11.69;
const M = 0.55;
const CW = W - 2 * M;
const BODY_TOP = 1.42;
const BODY_BOTTOM = 10.92;

const C = {
  ink: '172033',
  text: '2F3440',
  muted: '667085',
  faint: '98A2B3',
  line: 'E7EAF0',
  white: 'FFFFFF',
  blue: '1677FF',
  bluePale: 'F0F7FF',
  blueEdge: 'BAE0FF',
  green: '389E0D',
  greenPale: 'F6FFED',
  greenEdge: 'B7EB8F',
  orange: 'D46B08',
  orangePale: 'FFF7E6',
  orangeEdge: 'FFD591',
  red: 'CF1322',
  redPale: 'FFF1F0',
  redEdge: 'FFCCC7',
  purple: '722ED1',
  purplePale: 'F9F0FF',
  purpleEdge: 'D3ADF7',
  grayPale: 'FAFAFA',
  surface: 'F5F7FB',
  navy: '0F172A',
  cyan: '08979C',
  cyanPale: 'E6FFFB',
};

const TONES = {
  blue: { color: C.blue, fill: C.bluePale, edge: C.blueEdge },
  green: { color: C.green, fill: C.greenPale, edge: C.greenEdge },
  orange: { color: C.orange, fill: C.orangePale, edge: C.orangeEdge },
  red: { color: C.red, fill: C.redPale, edge: C.redEdge },
  purple: { color: C.purple, fill: C.purplePale, edge: C.purpleEdge },
  gray: { color: C.muted, fill: C.grayPale, edge: C.line },
};

const label = (list, value) => list.find((item) => item.value === value)?.label ?? value;
const kind = (value) => label(LABELS.kinds, value);
const status = (value) => label(LABELS.statuses, value);

function linesFor(text, width, size = 9.5) {
  const chars = Math.max(20, Math.floor((width * 93) / (size * 0.72)));
  return String(text)
    .split('\n')
    .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / chars)), 0);
}

function textHeight(text, width, size = 9.5, padding = 0.08) {
  return linesFor(text, width, size) * size * 0.019 + padding;
}

function addText(slide, text, options) {
  slide.addText(String(text), {
    fontFace: FONT,
    fontSize: 9.5,
    color: C.text,
    breakLine: false,
    margin: 0,
    valign: 'top',
    ...options,
  });
}

function pageFrame(pptx, slide, guide, page, total) {
  slide.background = { color: C.white };
  addText(slide, guide.kicker.toUpperCase(), {
    x: M,
    y: 0.35,
    w: CW - 1,
    h: 0.18,
    fontSize: 7.8,
    bold: true,
    color: C.blue,
    charSpacing: guide.kicker.length > 30 ? 0.25 : 1.1,
  });
  addText(slide, page.title, {
    x: M,
    y: 0.55,
    w: CW - 0.9,
    h: 0.38,
    fontSize: 19,
    bold: true,
    color: C.ink,
  });
  addText(slide, `${String(page.number).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, {
    x: W - M - 0.8,
    y: 0.39,
    w: 0.8,
    h: 0.18,
    align: 'right',
    fontSize: 8,
    bold: true,
    color: C.faint,
  });
  slide.addShape(pptx.ShapeType.line, {
    x: M,
    y: 1.0,
    w: CW,
    h: 0,
    line: { color: C.line, width: 0.75 },
  });
  if (page.subtitle) {
    addText(slide, page.subtitle, {
      x: M,
      y: 1.1,
      w: CW,
      h: 0.26,
      fontSize: 9.2,
      color: C.muted,
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: M,
    y: 11.08,
    w: CW,
    h: 0,
    line: { color: C.line, width: 0.75 },
  });
  addText(slide, `${guide.footer} · актуальная версия приложения · редакция 3`, {
    x: M,
    y: 11.17,
    w: CW - 0.7,
    h: 0.16,
    fontSize: 7.3,
    color: C.faint,
  });
  addText(slide, 'АВТО', {
    x: W - M - 0.7,
    y: 11.17,
    w: 0.7,
    h: 0.16,
    align: 'right',
    fontSize: 7.3,
    bold: true,
    color: C.blue,
  });
}

function section(slide, y, value) {
  addText(slide, value, {
    x: M,
    y,
    w: CW,
    h: 0.25,
    fontSize: 12.5,
    bold: true,
    color: C.ink,
  });
  return y + 0.34;
}

function paragraph(slide, y, value, options = {}) {
  const x = options.x ?? M;
  const w = options.w ?? CW;
  const size = options.size ?? 9.5;
  const h = textHeight(value, w, size, 0.11);
  addText(slide, value, { x, y, w, h, fontSize: size, color: options.color ?? C.text });
  return y + h + 0.05;
}

function bullets(slide, y, items, options = {}) {
  const x = options.x ?? M;
  const w = options.w ?? CW;
  const size = options.size ?? 9.3;
  const tone = TONES[options.tone ?? 'blue'];
  let cursor = y;
  for (const item of items) {
    const h = Math.max(0.28, textHeight(item, w - 0.3, size, 0.06));
    slide.addShape('ellipse', {
      x,
      y: cursor + 0.06,
      w: 0.12,
      h: 0.12,
      fill: { color: tone.color },
      line: { color: tone.color, width: 0 },
    });
    addText(slide, item, { x: x + 0.23, y: cursor, w: w - 0.23, h, fontSize: size });
    cursor += h + 0.06;
  }
  return cursor + 0.02;
}

function steps(slide, y, items, options = {}) {
  const x = options.x ?? M;
  const w = options.w ?? CW;
  const size = options.size ?? 9.3;
  const tone = TONES[options.tone ?? 'blue'];
  let cursor = y;
  items.forEach((item, index) => {
    const h = Math.max(0.32, textHeight(item, w - 0.38, size, 0.08));
    slide.addShape('ellipse', {
      x,
      y: cursor + 0.02,
      w: 0.23,
      h: 0.23,
      fill: { color: tone.color },
      line: { color: tone.color, width: 0 },
    });
    addText(slide, String(index + 1), {
      x,
      y: cursor + 0.045,
      w: 0.23,
      h: 0.14,
      fontSize: 8.3,
      bold: true,
      color: C.white,
      align: 'center',
      valign: 'mid',
    });
    addText(slide, item, { x: x + 0.34, y: cursor, w: w - 0.34, h, fontSize: size });
    cursor += h + 0.06;
  });
  return cursor + 0.02;
}

function callout(pptx, slide, y, block) {
  const tone = TONES[block.tone ?? 'blue'];
  const x = block.x ?? M;
  const w = block.w ?? CW;
  const bodyH = textHeight(block.body, w - 0.34, 8.9, 0.08);
  const h = block.h ?? Math.max(0.72, 0.38 + bodyH);
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.06,
    fill: { color: tone.fill },
    line: { color: tone.edge, width: 0.8 },
  });
  addText(slide, block.title, {
    x: x + 0.17,
    y: y + 0.14,
    w: w - 0.34,
    h: 0.2,
    fontSize: 10,
    bold: true,
    color: tone.color,
  });
  addText(slide, block.body, {
    x: x + 0.17,
    y: y + 0.39,
    w: w - 0.34,
    h: h - 0.49,
    fontSize: 8.9,
    color: C.text,
  });
  return y + h + 0.12;
}

function cards(pptx, slide, y, items) {
  const gap = 0.18;
  const width = (CW - gap) / 2;
  const rows = Math.ceil(items.length / 2);
  const heights = [];
  for (let row = 0; row < rows; row += 1) {
    const pair = items.slice(row * 2, row * 2 + 2);
    heights[row] = Math.max(
      ...pair.map((item) => Math.max(0.84, 0.4 + textHeight(item.body, width - 0.34, 8.7, 0.13))),
    );
  }
  let cursor = y;
  items.forEach((item, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = M + col * (width + gap);
    const h = heights[row];
    const tone = TONES[item.tone ?? 'blue'];
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: cursor,
      w: width,
      h,
      rectRadius: 0.05,
      fill: { color: tone.fill },
      line: { color: tone.edge, width: 0.8 },
    });
    addText(slide, item.title, {
      x: x + 0.16,
      y: cursor + 0.13,
      w: width - 0.32,
      h: 0.2,
      fontSize: 9.7,
      bold: true,
      color: tone.color,
    });
    addText(slide, item.body, {
      x: x + 0.16,
      y: cursor + 0.38,
      w: width - 0.32,
      h: h - 0.48,
      fontSize: 8.7,
    });
    if (col === 1 || index === items.length - 1) cursor += h + 0.14;
  });
  return cursor;
}

function table(slide, y, block) {
  const widths = block.widths.map((part) => (part / block.widths.reduce((a, b) => a + b, 0)) * CW);
  const rowHeights = block.rows.map((row) =>
    Math.max(
      0.42,
      ...row.map((cell, index) => textHeight(cell, widths[index] - 0.16, block.size ?? 8.1, 0.12)),
    ),
  );
  const headerH = 0.38;
  const totalH = headerH + rowHeights.reduce((a, b) => a + b, 0);
  let x = M;
  block.head.forEach((cell, index) => {
    slide.addShape('rect', {
      x,
      y,
      w: widths[index],
      h: headerH,
      fill: { color: C.ink },
      line: { color: C.white, width: 0.35 },
    });
    addText(slide, cell, {
      x: x + 0.08,
      y: y + 0.1,
      w: widths[index] - 0.16,
      h: 0.17,
      fontSize: 8,
      bold: true,
      color: C.white,
    });
    x += widths[index];
  });
  let rowY = y + headerH;
  block.rows.forEach((row, rowIndex) => {
    x = M;
    row.forEach((cell, index) => {
      slide.addShape('rect', {
        x,
        y: rowY,
        w: widths[index],
        h: rowHeights[rowIndex],
        fill: { color: rowIndex % 2 === 0 ? C.white : C.grayPale },
        line: { color: C.line, width: 0.45 },
      });
      addText(slide, cell, {
        x: x + 0.08,
        y: rowY + 0.09,
        w: widths[index] - 0.16,
        h: rowHeights[rowIndex] - 0.12,
        fontSize: block.size ?? 8.1,
        bold: index === 0 && block.boldFirst !== false,
        color: index === 0 ? C.ink : C.text,
      });
      x += widths[index];
    });
    rowY += rowHeights[rowIndex];
  });
  return y + totalH + 0.14;
}

function flow(pptx, slide, y, block) {
  const gap = 0.1;
  const width = (CW - gap * (block.items.length - 1)) / block.items.length;
  block.items.forEach((item, index) => {
    const tone = TONES[item.tone ?? 'blue'];
    const x = M + index * (width + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w: width,
      h: 0.72,
      rectRadius: 0.06,
      fill: { color: tone.fill },
      line: { color: tone.edge, width: 0.8 },
    });
    addText(slide, item.title, {
      x: x + 0.08,
      y: y + 0.13,
      w: width - 0.16,
      h: 0.18,
      fontSize: 8.6,
      bold: true,
      align: 'center',
      color: tone.color,
    });
    addText(slide, item.body, {
      x: x + 0.08,
      y: y + 0.37,
      w: width - 0.16,
      h: 0.24,
      fontSize: 7.3,
      align: 'center',
      color: C.muted,
    });
  });
  return y + 0.86;
}

/**
 * Наглядные фрагменты портала. Это не фотографии произвольного стенда, а компактные схемы
 * действующих экранов: те же вкладки, поля, подписи и основные входы, что в React-интерфейсе.
 * В отличие от растрового снимка, подписи остаются редактируемыми в PPTX и не устаревают отдельно
 * от текста памятки. Номера на экране связаны с короткими карточками справа — приём из инструкции
 * водителя, выбранной заказчиком как образец.
 */
function uiShape(pptx, slide, type, x, y, w, h, options = {}) {
  slide.addShape(type, {
    x,
    y,
    w,
    h,
    rectRadius: options.radius ?? 0.04,
    fill: { color: options.fill ?? C.white, transparency: options.transparency ?? 0 },
    line: { color: options.line ?? C.line, width: options.lineWidth ?? 0.7 },
  });
}

function uiText(slide, value, x, y, w, h = 0.18, options = {}) {
  addText(slide, value, {
    x,
    y,
    w,
    h,
    fontSize: options.size ?? 7.6,
    bold: options.bold ?? false,
    color: options.color ?? C.text,
    align: options.align,
    valign: options.valign ?? 'mid',
  });
}

function uiPill(pptx, slide, value, x, y, w, toneName = 'blue') {
  const tone = TONES[toneName] ?? TONES.blue;
  uiShape(pptx, slide, pptx.ShapeType.roundRect, x, y, w, 0.23, {
    fill: tone.fill,
    line: tone.edge,
  });
  uiText(slide, value, x + 0.04, y + 0.025, w - 0.08, 0.15, {
    size: 6.4,
    bold: true,
    color: tone.color,
    align: 'center',
  });
}

function uiButton(pptx, slide, value, x, y, w, options = {}) {
  const primary = options.primary ?? false;
  const danger = options.danger ?? false;
  const fill = primary ? C.blue : danger ? C.redPale : C.white;
  const edge = primary ? C.blue : danger ? C.redEdge : 'D9D9D9';
  const color = primary ? C.white : danger ? C.red : C.ink;
  uiShape(pptx, slide, pptx.ShapeType.roundRect, x, y, w, options.h ?? 0.3, {
    fill,
    line: edge,
  });
  uiText(slide, value, x + 0.05, y + 0.035, w - 0.1, (options.h ?? 0.3) - 0.07, {
    size: options.size ?? 6.9,
    bold: primary,
    color,
    align: 'center',
  });
}

function uiField(pptx, slide, labelValue, value, x, y, w, options = {}) {
  uiText(slide, labelValue, x, y, w, 0.14, { size: 6.3, bold: true, color: C.muted });
  const top = y + 0.17;
  uiShape(pptx, slide, pptx.ShapeType.roundRect, x, top, w, options.h ?? 0.34, {
    fill: options.disabled ? C.grayPale : C.white,
    line: options.focus ? C.blue : 'D9D9D9',
    lineWidth: options.focus ? 1.2 : 0.65,
  });
  uiText(slide, value, x + 0.09, top + 0.04, w - 0.18, (options.h ?? 0.34) - 0.08, {
    size: options.size ?? 6.8,
    color: options.placeholder ? C.faint : C.text,
  });
}

function uiMarker(pptx, slide, number, x, y, toneName = 'blue') {
  const tone = TONES[toneName] ?? TONES.blue;
  slide.addShape('ellipse', {
    x: x - 0.13,
    y: y - 0.13,
    w: 0.26,
    h: 0.26,
    fill: { color: tone.color },
    line: { color: C.white, width: 1.1 },
  });
  uiText(slide, String(number), x - 0.13, y - 0.105, 0.26, 0.16, {
    size: 7,
    bold: true,
    color: C.white,
    align: 'center',
  });
}

function uiTabs(pptx, slide, tabs, active, x, y, w) {
  const gap = 0.04;
  const tabW = Math.min(1.03, (w - gap * (tabs.length - 1)) / tabs.length);
  tabs.forEach((tab, index) => {
    const tx = x + index * (tabW + gap);
    const selected = tab === active;
    uiText(slide, tab, tx, y, tabW, 0.2, {
      size: 6.25,
      bold: selected,
      color: selected ? C.blue : C.muted,
      align: 'center',
    });
    if (selected) {
      slide.addShape(pptx.ShapeType.line, {
        x: tx + 0.06,
        y: y + 0.24,
        w: tabW - 0.12,
        h: 0,
        line: { color: C.blue, width: 1.7 },
      });
    }
  });
}

function uiRow(pptx, slide, x, y, w, titleValue, meta, options = {}) {
  uiShape(pptx, slide, pptx.ShapeType.roundRect, x, y, w, options.h ?? 0.56, {
    fill: C.white,
    line: options.selected ? C.blueEdge : C.line,
    lineWidth: options.selected ? 1.1 : 0.6,
  });
  uiText(slide, titleValue, x + 0.11, y + 0.08, w - 1.18, 0.17, {
    size: 7.3,
    bold: true,
    color: C.ink,
  });
  uiText(slide, meta, x + 0.11, y + 0.31, w - 1.18, 0.14, {
    size: 6.1,
    color: C.muted,
  });
  if (options.status)
    uiPill(pptx, slide, options.status, x + w - 0.95, y + 0.09, 0.79, options.tone);
}

function drawScene(pptx, slide, scene, x, y, w, h) {
  const marks = [];
  const mark = (mx, my, tone = 'blue') => marks.push({ x: mx, y: my, tone });
  const [name, variant = ''] = scene.split(':');
  const contentY = y + 0.82;
  const innerX = x + 0.18;
  const innerW = w - 0.36;

  uiShape(pptx, slide, pptx.ShapeType.roundRect, x, y, w, h, {
    fill: C.white,
    line: 'D6DEEA',
    lineWidth: 0.9,
  });
  slide.addShape('ellipse', {
    x: x + 0.17,
    y: y + 0.15,
    w: 0.28,
    h: 0.28,
    fill: { color: C.blue },
    line: { color: C.blue, width: 0 },
  });
  uiText(slide, 'A', x + 0.17, y + 0.188, 0.28, 0.14, {
    size: 7.7,
    bold: true,
    color: C.white,
    align: 'center',
  });
  uiText(slide, 'Орг.техника', x + 0.53, y + 0.13, 1.25, 0.2, {
    size: 8.2,
    bold: true,
    color: C.ink,
  });
  uiText(slide, 'Заявки и обслуживание', x + 0.53, y + 0.34, 1.55, 0.14, {
    size: 5.9,
    color: C.faint,
  });
  uiPill(pptx, slide, 'АБ', x + w - 0.55, y + 0.16, 0.34, 'green');
  slide.addShape(pptx.ShapeType.line, {
    x: x + 0.12,
    y: y + 0.57,
    w: w - 0.24,
    h: 0,
    line: { color: C.line, width: 0.65 },
  });
  uiTabs(
    pptx,
    slide,
    ['Заявки', 'Гарантии', 'Архив', 'Техника', 'Расходники'],
    ['consumables', 'purchase'].includes(name)
      ? 'Расходники'
      : name === 'equipment' || name === 'history'
        ? 'Техника'
        : 'Заявки',
    innerX,
    y + 0.58,
    innerW,
  );
  uiShape(pptx, slide, 'rect', x + 0.02, contentY, w - 0.04, h - 0.84, {
    fill: C.surface,
    line: C.surface,
  });

  if (name === 'create') {
    uiText(slide, 'Новая заявка на обслуживание', innerX, contentY + 0.11, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiText(slide, 'Чем помочь', innerX, contentY + 0.43, 1, 0.14, {
      size: 6.3,
      bold: true,
      color: C.muted,
    });
    uiPill(pptx, slide, 'Обслуживание', innerX, contentY + 0.62, 1.06, 'blue');
    uiPill(pptx, slide, 'Расходники', innerX + 1.12, contentY + 0.62, 0.9, 'gray');
    mark(innerX + 0.05, contentY + 0.66);
    uiField(
      pptx,
      slide,
      'Какой аппарат',
      'МФУ Canon iR 2425 · инв. 01472',
      innerX,
      contentY + 0.98,
      innerW,
      { focus: true },
    );
    uiText(slide, 'Не нашли технику?', innerX, contentY + 1.54, 1.2, 0.15, {
      size: 6.1,
      bold: true,
      color: C.blue,
    });
    mark(innerX + innerW - 0.02, contentY + 1.28, 'purple');
    uiField(
      pptx,
      slide,
      'Описание',
      'Мнёт бумагу на каждой второй странице',
      innerX,
      contentY + 1.78,
      innerW,
      { h: 0.55 },
    );
    mark(innerX + innerW - 0.02, contentY + 2.14, 'orange');
    uiField(
      pptx,
      slide,
      'Для кого заявка',
      'БЦ «Север» · отдел снабжения',
      innerX,
      contentY + 2.58,
      innerW * 0.57,
    );
    uiField(
      pptx,
      slide,
      'Телефон для связи',
      '+7 777 123-45-67',
      innerX + innerW * 0.6,
      contentY + 2.58,
      innerW * 0.4,
    );
    uiButton(pptx, slide, 'Создать заявку', innerX + innerW - 1.35, contentY + 3.28, 1.35, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.43, 'green');
  } else if (name === 'candidate') {
    uiText(slide, 'Сообщить об аппарате', innerX, contentY + 0.11, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiText(
      slide,
      'Карточка уйдёт на проверку вместе с заявкой',
      innerX,
      contentY + 0.35,
      innerW,
      0.15,
      { size: 6.2, color: C.muted },
    );
    uiField(pptx, slide, 'Тип техники', 'МФУ', innerX, contentY + 0.62, innerW * 0.36, {
      focus: true,
    });
    uiField(
      pptx,
      slide,
      'Модель с шильдика',
      'Canon imageRUNNER 2425',
      innerX + innerW * 0.39,
      contentY + 0.62,
      innerW * 0.61,
    );
    mark(innerX + 0.04, contentY + 0.92);
    uiField(
      pptx,
      slide,
      'Инвентарный или серийный номер',
      'SN: QZX35192',
      innerX,
      contentY + 1.38,
      innerW,
      { focus: true },
    );
    mark(innerX + innerW - 0.02, contentY + 1.67, 'purple');
    uiField(
      pptx,
      slide,
      'Где стоит',
      'БЦ «Север», 3 этаж, каб. 315',
      innerX,
      contentY + 2.15,
      innerW,
    );
    uiField(pptx, slide, 'Фото шильдика', 'IMG_35192.jpg', innerX, contentY + 2.88, innerW * 0.58);
    uiButton(pptx, slide, 'Отправить с заявкой', innerX + innerW - 1.48, contentY + 2.99, 1.48, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.14, 'green');
  } else if (name === 'list') {
    uiField(
      pptx,
      slide,
      'Поиск',
      'номер, модель, серийный №',
      innerX,
      contentY + 0.08,
      innerW * 0.53,
      { placeholder: true },
    );
    uiButton(
      pptx,
      slide,
      variant === 'requester' ? 'Создать заявку' : 'Фильтры',
      innerX + innerW - 1.25,
      contentY + 0.25,
      1.25,
      { primary: variant === 'requester' },
    );
    uiPill(
      pptx,
      slide,
      variant === 'requester' ? 'Мои заявки' : 'Ждут меня',
      innerX,
      contentY + 0.72,
      0.87,
      'blue',
    );
    uiPill(pptx, slide, 'Рабочие', innerX + 0.95, contentY + 0.72, 0.68, 'gray');
    mark(innerX + 0.03, contentY + 0.82);
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.13,
      innerW,
      'СО-1842 · МФУ Canon iR 2425',
      'БЦ «Север», каб. 315 · ждёт 2 дня',
      {
        status: status('new'),
        tone: 'blue',
        selected: true,
      },
    );
    uiPill(
      pptx,
      slide,
      variant === 'service'
        ? 'Вам: принять в работу'
        : variant === 'it'
          ? 'Ждёт оператора'
          : 'Ждёт исполнителя',
      innerX + 0.13,
      contentY + 1.78,
      1.55,
      variant === 'service' ? 'orange' : 'gray',
    );
    uiPill(pptx, slide, 'Повтор ×3', innerX + 1.79, contentY + 1.78, 0.8, 'purple');
    mark(innerX + innerW - 0.02, contentY + 1.42, 'orange');
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 2.22,
      innerW,
      'СО-1837 · Принтер HP LaserJet',
      'СК «Восток», офис 12 · обновлено сегодня',
      {
        status: status('in_work'),
        tone: 'orange',
      },
    );
    if (variant === 'service')
      uiButton(pptx, slide, 'Принять в работу', innerX + innerW - 1.37, contentY + 2.91, 1.37, {
        primary: true,
      });
    else uiButton(pptx, slide, 'Открыть карточку', innerX + innerW - 1.31, contentY + 2.91, 1.31);
    mark(innerX + innerW - 0.02, contentY + 3.06, 'green');
  } else if (name === 'card') {
    uiText(slide, 'Заявка СО-1842', innerX, contentY + 0.1, 1.4, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiPill(pptx, slide, status('in_work'), innerX + 1.5, contentY + 0.08, 0.72, 'orange');
    uiButton(pptx, slide, 'Действия', innerX + innerW - 0.86, contentY + 0.06, 0.86);
    uiTabs(
      pptx,
      slide,
      variant === 'requester'
        ? ['Заявка', 'Документы', 'История']
        : ['Заявка', 'Объём работ', 'Документы', 'История'],
      'Заявка',
      innerX,
      contentY + 0.42,
      innerW,
    );
    mark(innerX + 0.05, contentY + 0.56);
    uiField(
      pptx,
      slide,
      'Аппарат',
      'МФУ Canon iR 2425 · инв. 01472',
      innerX,
      contentY + 0.82,
      innerW,
    );
    uiField(
      pptx,
      slide,
      'Место',
      'БЦ «Север» · 3 этаж · каб. 315',
      innerX,
      contentY + 1.52,
      innerW * 0.6,
    );
    uiField(
      pptx,
      slide,
      'Исполнители',
      variant === 'service' ? 'Сервис «ПринтСервис»' : 'Иванов И.И. · Сервис «ПринтСервис»',
      innerX + innerW * 0.63,
      contentY + 1.52,
      innerW * 0.37,
    );
    mark(innerX + innerW - 0.02, contentY + 1.83, 'purple');
    uiField(
      pptx,
      slide,
      'Описание',
      'Мнёт бумагу. Нужна печать пропусков.',
      innerX,
      contentY + 2.22,
      innerW,
      { h: 0.5 },
    );
    uiButton(pptx, slide, 'Обсуждение · 2', innerX, contentY + 3.02, 1.45, { primary: true });
    mark(innerX + 0.02, contentY + 3.16, 'green');
    if (variant === 'requester')
      uiPill(pptx, slide, 'Суммы скрыты', innerX + innerW - 0.88, contentY + 3.04, 0.88, 'gray');
  } else if (name === 'assign') {
    uiText(slide, 'Исполнители заявки СО-1842', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiField(
      pptx,
      slide,
      'Исполнители',
      'Иванов И.И.; Петров П.П.',
      innerX,
      contentY + 0.52,
      innerW,
      { focus: true },
    );
    mark(innerX + innerW - 0.02, contentY + 0.84);
    uiPill(pptx, slide, 'Сотрудник · Иванов И.И.', innerX, contentY + 1.19, 1.55, 'blue');
    uiPill(pptx, slide, 'Сотрудник · Петров П.П.', innerX + 1.64, contentY + 1.19, 1.55, 'green');
    uiField(
      pptx,
      slide,
      'Сервисная компания',
      'ООО «ПринтСервис»',
      innerX,
      contentY + 1.63,
      innerW,
    );
    mark(innerX + 0.03, contentY + 1.96, 'purple');
    uiField(
      pptx,
      slide,
      'Причина изменения состава',
      'Выездной ремонт механизма подачи',
      innerX,
      contentY + 2.35,
      innerW,
      { h: 0.48 },
    );
    uiButton(pptx, slide, 'Сохранить состав', innerX + innerW - 1.36, contentY + 3.18, 1.36, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.33, 'green');
  } else if (name === 'estimate') {
    uiText(slide, 'Объём работ · ревизия 2', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiPill(
      pptx,
      slide,
      variant === 'service' ? 'Редактируется исполнителем' : 'Ждёт согласования',
      innerX,
      contentY + 0.43,
      1.64,
      variant === 'service' ? 'blue' : 'orange',
    );
    mark(innerX + 0.03, contentY + 0.55);
    const cols = [2.05, 0.55, 0.72, 0.72];
    let cx = innerX;
    ['Работа / материал', 'Кол.', 'Цена', 'Сумма'].forEach((head, index) => {
      uiShape(pptx, slide, 'rect', cx, contentY + 0.88, cols[index], 0.28, {
        fill: C.navy,
        line: C.white,
      });
      uiText(slide, head, cx + 0.06, contentY + 0.93, cols[index] - 0.12, 0.14, {
        size: 5.8,
        bold: true,
        color: C.white,
      });
      cx += cols[index];
    });
    [
      ['Диагностика и чистка', '1', '2 500', '2 500'],
      ['Ролик подачи', '1', '4 600', '4 600'],
    ].forEach((row, rowIndex) => {
      cx = innerX;
      row.forEach((cell, index) => {
        uiShape(pptx, slide, 'rect', cx, contentY + 1.16 + rowIndex * 0.39, cols[index], 0.39, {
          fill: rowIndex ? C.grayPale : C.white,
          line: C.line,
        });
        uiText(
          slide,
          cell,
          cx + 0.06,
          contentY + 1.25 + rowIndex * 0.39,
          cols[index] - 0.12,
          0.15,
          { size: 6.1, bold: index === 0 },
        );
        cx += cols[index];
      });
    });
    uiText(slide, 'Итого: 7 100 ₽', innerX + innerW - 1.2, contentY + 2.05, 1.2, 0.2, {
      size: 7.6,
      bold: true,
      color: C.ink,
      align: 'right',
    });
    mark(innerX + innerW - 0.02, contentY + 2.15, 'purple');
    if (variant === 'service') {
      uiButton(pptx, slide, 'Сохранить', innerX + innerW - 2.55, contentY + 2.62, 0.9);
      uiButton(pptx, slide, 'Предъявить', innerX + innerW - 1.55, contentY + 2.62, 1.55, {
        primary: true,
      });
    } else {
      uiButton(pptx, slide, 'Не согласовать', innerX + innerW - 2.4, contentY + 2.62, 1.18, {
        danger: true,
      });
      uiButton(pptx, slide, 'Согласовать', innerX + innerW - 1.12, contentY + 2.62, 1.12, {
        primary: true,
      });
    }
    mark(innerX + innerW - 0.02, contentY + 2.77, 'green');
  } else if (name === 'documents') {
    uiText(slide, 'Документы заявки', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiButton(pptx, slide, 'Добавить файл', innerX + innerW - 1.08, contentY + 0.06, 1.08, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 0.2);
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 0.52,
      innerW,
      'Акт № 48.pdf',
      'вид: Акт · добавлен сервисом',
      { status: 'Закрывающий', tone: 'green' },
    );
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.21,
      innerW,
      'Гарантия_90_дней.pdf',
      'вид: Гарантийный талон · виден заявителю',
      { status: 'Гарантия', tone: 'purple' },
    );
    mark(innerX + 0.04, contentY + 1.49, 'purple');
    uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, contentY + 1.96, innerW, 0.68, {
      fill: C.bluePale,
      line: C.blueEdge,
    });
    uiText(
      slide,
      'Для внешнего ремонта нужен акт, счёт или иной закрывающий документ.',
      innerX + 0.13,
      contentY + 2.1,
      innerW - 0.26,
      0.28,
      { size: 6.6, color: C.blue },
    );
    uiButton(pptx, slide, 'Закрыть работы', innerX + innerW - 1.32, contentY + 2.95, 1.32, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.1, 'green');
  } else if (name === 'movement') {
    uiText(slide, 'Перемещение аппарата из заявки', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiField(
      pptx,
      slide,
      'Сейчас в карточке',
      'БЦ «Север» · каб. 315',
      innerX,
      contentY + 0.53,
      innerW,
    );
    uiField(
      pptx,
      slide,
      'Заявлено в обращении',
      'БЦ «Север» · каб. 412',
      innerX,
      contentY + 1.28,
      innerW,
      { focus: true },
    );
    mark(innerX + innerW - 0.02, contentY + 1.6, 'orange');
    uiField(
      pptx,
      slide,
      'Куда переместить',
      'БЦ «Север» · 4 этаж · каб. 412',
      innerX,
      contentY + 2.04,
      innerW,
    );
    uiPill(pptx, slide, 'Заявленное место подтверждено', innerX, contentY + 2.72, 1.8, 'green');
    mark(innerX + 0.03, contentY + 2.83, 'purple');
    uiButton(
      pptx,
      slide,
      'Переместить и записать в историю',
      innerX + innerW - 2.12,
      contentY + 3.15,
      2.12,
      { primary: true },
    );
    mark(innerX + innerW - 0.02, contentY + 3.3, 'green');
  } else if (name === 'history') {
    uiText(slide, 'История · МФУ Canon iR 2425', innerX, contentY + 0.1, innerW - 1.1, 0.2, {
      size: 8.2,
      bold: true,
      color: C.ink,
    });
    uiButton(pptx, slide, 'Скачать историю', innerX + innerW - 1.12, contentY + 0.06, 1.12);
    uiTabs(
      pptx,
      slide,
      ['Заявки', 'Правки', 'Перемещения', 'Полная история'],
      variant === 'moves' ? 'Перемещения' : 'Заявки',
      innerX,
      contentY + 0.42,
      innerW,
    );
    mark(innerX + 0.05, contentY + 0.57);
    if (variant === 'moves') {
      uiRow(
        pptx,
        slide,
        innerX,
        contentY + 0.88,
        innerW,
        '07.09 · перемещение подтверждено',
        'каб. 315 → каб. 412 · из заявки СО-1842',
        { status: 'Подтверждено', tone: 'green' },
      );
      uiRow(
        pptx,
        slide,
        innerX,
        contentY + 1.58,
        innerW,
        '18.08 · уточнение места',
        'склад → БЦ «Север», каб. 315',
        { status: 'Ручная запись', tone: 'gray' },
      );
    } else {
      uiRow(
        pptx,
        slide,
        innerX,
        contentY + 0.88,
        innerW,
        'СО-1842 · обслуживание',
        'Решена · ролик подачи заменён',
        { status: 'Результат', tone: 'green' },
      );
      uiRow(
        pptx,
        slide,
        innerX,
        contentY + 1.58,
        innerW,
        'СО-1761 · обслуживание',
        'Закрыта · чистка тракта',
        { status: 'Гарантия 90 дн.', tone: 'purple' },
      );
    }
    uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, contentY + 2.4, innerW, 0.66, {
      fill: C.white,
      line: C.line,
    });
    uiText(
      slide,
      'Выгрузка: Заявки · Правки · Перемещения · Полная история',
      innerX + 0.12,
      contentY + 2.58,
      innerW - 0.24,
      0.17,
      { size: 6.6, bold: true, color: C.muted },
    );
    mark(innerX + innerW - 0.02, contentY + 2.72, 'green');
  } else if (name === 'bulk') {
    uiText(slide, 'Заявки', innerX, contentY + 0.1, 1.1, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    [
      ['СО-1842 · Canon iR 2425', status('new'), 'blue'],
      ['СО-1837 · HP LaserJet', status('in_work'), 'orange'],
      ['СО-1829 · Xerox B315', status('done'), 'purple'],
    ].forEach((row, index) => {
      const ry = contentY + 0.52 + index * 0.66;
      uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, ry, 0.25, 0.25, {
        fill: index < 2 ? C.blue : C.white,
        line: C.blue,
      });
      if (index < 2)
        uiText(slide, '✓', innerX, ry + 0.03, 0.25, 0.14, {
          size: 7,
          bold: true,
          color: C.white,
          align: 'center',
        });
      uiRow(
        pptx,
        slide,
        innerX + 0.36,
        ry - 0.12,
        innerW - 0.36,
        row[0],
        'выбрана для общей операции',
        { status: row[1], tone: row[2], h: 0.5 },
      );
    });
    mark(innerX + 0.12, contentY + 0.65);
    uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, contentY + 2.67, innerW, 0.72, {
      fill: C.navy,
      line: C.navy,
    });
    uiText(slide, 'Выбрано: 2', innerX + 0.14, contentY + 2.86, 0.78, 0.16, {
      size: 6.8,
      bold: true,
      color: C.white,
    });
    uiButton(pptx, slide, 'Отложить', innerX + 1.02, contentY + 2.83, 0.82);
    uiButton(pptx, slide, 'Снять срочность', innerX + 1.92, contentY + 2.83, 1.08);
    uiButton(pptx, slide, 'Отменить', innerX + innerW - 0.84, contentY + 2.83, 0.84, {
      danger: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.03, 'orange');
  } else if (name === 'consumables') {
    uiText(slide, 'Расходники', innerX, contentY + 0.1, 1.1, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiButton(pptx, slide, 'План закупки', innerX + innerW - 1.08, contentY + 0.06, 1.08, {
      primary: true,
    });
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 0.54,
      innerW,
      'Картридж Canon 057H · чёрный',
      'совместим: Canon i-SENSYS LBP223dw',
      { status: 'Остаток 2', tone: 'orange' },
    );
    uiPill(pptx, slide, 'Потребность 5', innerX + 0.13, contentY + 1.2, 0.92, 'red');
    uiPill(pptx, slide, 'Заказано 2', innerX + 1.14, contentY + 1.2, 0.85, 'purple');
    mark(innerX + innerW - 0.02, contentY + 0.82, 'orange');
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.68,
      innerW,
      'Тонер Xerox 006R04399 · голубой',
      'совместим: Xerox C315',
      { status: 'Остаток 8', tone: 'green' },
    );
    uiButton(pptx, slide, 'История остатка', innerX, contentY + 2.43, 1.18);
    uiButton(pptx, slide, 'Изменить остаток', innerX + 1.3, contentY + 2.43, 1.23);
    mark(innerX + 0.03, contentY + 2.58, 'purple');
    uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, contentY + 2.95, innerW, 0.44, {
      fill: C.bluePale,
      line: C.blueEdge,
    });
    uiText(
      slide,
      'Выдача по заявке пишет движение склада отдельно.',
      innerX + 0.12,
      contentY + 3.06,
      innerW - 0.24,
      0.16,
      { size: 6.5, color: C.blue },
    );
  } else if (name === 'purchase') {
    uiText(slide, 'Плановая закупка № ЗК-028', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiPill(
      pptx,
      slide,
      variant === 'closed' ? 'Закрыта' : 'Черновик',
      innerX + innerW - 0.77,
      contentY + 0.08,
      0.77,
      variant === 'closed' ? 'green' : 'gray',
    );
    uiField(
      pptx,
      slide,
      'Поставщик / комментарий',
      'Закупка на сентябрь',
      innerX,
      contentY + 0.5,
      innerW,
    );
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.22,
      innerW,
      'Canon 057H',
      'нужно 5 · в заявках 3 · уже заказано 2',
      { status: 'Заказать 3', tone: 'orange' },
    );
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.91,
      innerW,
      'Xerox 006R04399',
      'нужно 2 · остаток 0 · заказано 0',
      { status: 'Заказать 2', tone: 'red' },
    );
    mark(innerX + innerW - 0.02, contentY + 2.19, 'orange');
    uiButton(pptx, slide, 'Сохранить черновик', innerX + innerW - 2.55, contentY + 2.85, 1.3);
    uiButton(pptx, slide, 'Провести', innerX + innerW - 1.15, contentY + 2.85, 1.15, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 3.0, 'green');
  } else if (name === 'equipment') {
    uiText(slide, 'Справочник оргтехники', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiButton(pptx, slide, 'Добавить аппарат', innerX + innerW - 1.2, contentY + 0.06, 1.2, {
      primary: true,
    });
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 0.55,
      innerW,
      'МФУ · Canon imageRUNNER 2425',
      'инв. 01472 · SN QZX35192 · БЦ «Север», каб. 412',
      { status: 'Активна', tone: 'green' },
    );
    uiPill(pptx, slide, 'ч/б печать', innerX + 0.13, contentY + 1.21, 0.73, 'gray');
    uiPill(pptx, slide, 'A3', innerX + 0.95, contentY + 1.21, 0.43, 'blue');
    uiPill(pptx, slide, 'двусторонняя', innerX + 1.47, contentY + 1.21, 0.95, 'purple');
    mark(innerX + innerW - 0.02, contentY + 0.83, 'orange');
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.69,
      innerW,
      'Принтер · HP LaserJet Pro M404',
      'инв. 01203 · гарантия до 30.11.2026',
      { status: 'Гарантия', tone: 'purple' },
    );
    uiButton(pptx, slide, 'История', innerX, contentY + 2.45, 0.78);
    uiButton(pptx, slide, 'Переместить', innerX + 0.9, contentY + 2.45, 0.98);
    uiButton(pptx, slide, 'Редактировать', innerX + 2.0, contentY + 2.45, 1.07);
    mark(innerX + 0.04, contentY + 2.6, 'green');
  } else if (name === 'warranty') {
    uiText(slide, 'Гарантии на выполненные работы', innerX, contentY + 0.1, innerW, 0.2, {
      size: 8.4,
      bold: true,
      color: C.ink,
    });
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 0.55,
      innerW,
      'СО-1761 · Canon iR 2425',
      'чистка тракта · до 18.11.2026',
      { status: 'Действует', tone: 'green' },
    );
    uiButton(pptx, slide, 'Создать обращение', innerX + innerW - 1.35, contentY + 1.18, 1.35, {
      primary: true,
    });
    mark(innerX + innerW - 0.02, contentY + 1.33, 'green');
    uiRow(
      pptx,
      slide,
      innerX,
      contentY + 1.75,
      innerW,
      'СО-1614 · HP LaserJet Pro M404',
      'замена термоплёнки · закончилась 01.09.2026',
      { status: 'Истекла', tone: 'gray' },
    );
    uiShape(pptx, slide, pptx.ShapeType.roundRect, innerX, contentY + 2.5, innerW, 0.67, {
      fill: C.orangePale,
      line: C.orangeEdge,
    });
    uiText(
      slide,
      'Гарантия поставщика выбирается в новой заявке; гарантия ремонта — из этого реестра.',
      innerX + 0.12,
      contentY + 2.66,
      innerW - 0.24,
      0.3,
      { size: 6.5, color: C.orange },
    );
    mark(innerX + 0.03, contentY + 2.83, 'orange');
  }

  return marks;
}

const SCREENSHOT_BY_SCENE = {
  'create:requester': 'request-create.png',
  'candidate:requester': 'candidate-report.png',
  'list:requester': 'requests-requester.png',
  'list:service': 'requests-service.png',
  'list:it': 'requests-it.png',
  'card:requester': 'request-card-requester.png',
  'card:service': 'request-card-service.png',
  'card:it': 'request-card-it.png',
  'assign:it': 'assignment.png',
  'estimate:service': 'estimate-editor.png',
  'estimate:it': 'estimate-approval.png',
  'documents:service': 'documents-service.png',
  'documents:it': 'documents-service.png',
  'consumables:it': 'consumables.png',
  'purchase:open': 'purchase.png',
  'equipment:it': 'equipment-list.png',
  'movement:it': 'equipment-move.png',
  'history:moves': 'equipment-history.png',
  'warranty:service': 'warranties.png',
  'warranty:it': 'warranties.png',
  // На снимке массового режима нижняя адаптивная панель занимает слишком много места на A4.
  // Очередь ИТ показывает те же строки и элементы выбора без потери читаемости.
  'bulk:it': 'requests-it.png',
};

const pngDimensions = new Map();

function readPngDimensions(path) {
  if (pngDimensions.has(path)) return pngDimensions.get(path);
  const bytes = readFileSync(path);
  if (bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`Ожидался PNG-снимок интерфейса: ${path}`);
  }
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  pngDimensions.set(path, dimensions);
  return dimensions;
}

function addContainedScreenshot(slide, path, x, y, w, h) {
  const { width, height } = readPngDimensions(path);
  const scale = Math.min(w / width, h / height);
  const imageW = width * scale;
  const imageH = height * scale;
  slide.addImage({
    path,
    x: x + (w - imageW) / 2,
    y: y + (h - imageH) / 2,
    w: imageW,
    h: imageH,
  });
}

function visualScreen(pptx, slide, y, block) {
  const h = block.h ?? 4.55;
  const screenW = block.full ? CW : 4.68;
  const notesX = M + screenW + 0.18;
  const notesW = CW - screenW - 0.18;
  const screenshotName = SCREENSHOT_BY_SCENE[block.scene];
  if (!screenshotName) throw new Error(`Для сценария ${block.scene} не назначен снимок экрана`);
  const screenshotPath = join(SCREEN_DIR, screenshotName);
  if (!existsSync(screenshotPath)) throw new Error(`Не найден снимок экрана: ${screenshotPath}`);

  uiShape(pptx, slide, pptx.ShapeType.roundRect, M, y, screenW, h, {
    fill: C.surface,
    line: C.line,
  });
  uiText(
    slide,
    'АКТУАЛЬНЫЙ ЭКРАН · ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ',
    M + 0.12,
    y + 0.08,
    screenW - 0.24,
    0.14,
    {
      size: 5.9,
      bold: true,
      color: C.faint,
    },
  );
  addContainedScreenshot(slide, screenshotPath, M + 0.08, y + 0.29, screenW - 0.16, h - 0.37);

  if (!block.full) {
    const noteGap = 0.11;
    const noteH = (h - noteGap * (block.notes.length - 1)) / block.notes.length;
    block.notes.forEach((item, index) => {
      const tone = TONES[item.tone ?? 'blue'];
      const ny = y + index * (noteH + noteGap);
      uiShape(pptx, slide, pptx.ShapeType.roundRect, notesX, ny, notesW, noteH, {
        fill: tone.fill,
        line: tone.edge,
      });
      slide.addShape('ellipse', {
        x: notesX + 0.12,
        y: ny + 0.12,
        w: 0.28,
        h: 0.28,
        fill: { color: tone.color },
        line: { color: tone.color, width: 0 },
      });
      uiText(slide, String(index + 1), notesX + 0.12, ny + 0.155, 0.28, 0.14, {
        size: 7.2,
        bold: true,
        color: C.white,
        align: 'center',
      });
      uiText(slide, item.title, notesX + 0.49, ny + 0.09, notesW - 0.61, 0.22, {
        size: 7.8,
        bold: true,
        color: C.ink,
      });
      uiText(slide, item.body, notesX + 0.49, ny + 0.34, notesW - 0.61, noteH - 0.41, {
        size: 6.7,
        color: C.text,
        valign: 'top',
      });
    });
  }
  return y + h + 0.18;
}

function renderPage(pptx, guide, page, total) {
  const slide = pptx.addSlide();
  pageFrame(pptx, slide, guide, page, total);
  let y = BODY_TOP;
  if (page.visual) y = visualScreen(pptx, slide, y, page.visual);
  const blocks = page.visual?.after ?? page.blocks;
  for (const block of blocks) {
    switch (block.type) {
      case 'section':
        y = section(slide, y, block.text);
        break;
      case 'p':
        y = paragraph(slide, y, block.text, block);
        break;
      case 'bullets':
        y = bullets(slide, y, block.items, block);
        break;
      case 'steps':
        y = steps(slide, y, block.items, block);
        break;
      case 'callout':
        y = callout(pptx, slide, y, block);
        break;
      case 'cards':
        y = cards(pptx, slide, y, block.items);
        break;
      case 'table':
        y = table(slide, y, block);
        break;
      case 'flow':
        y = flow(pptx, slide, y, block);
        break;
      case 'screen':
        y = visualScreen(pptx, slide, y, block);
        break;
      case 'space':
        y += block.h;
        break;
      default:
        throw new Error(`Неизвестный блок ${block.type}`);
    }
  }
  if (y > BODY_BOTTOM) {
    throw new Error(`${guide.file}: страница ${page.number} выходит за поле (${y.toFixed(2)})`);
  }
}

async function writePptxAtFixedTime(deck, fileName) {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(STAMP_ISO).getTime();
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
  try {
    await deck.writeFile({ fileName });
  } finally {
    globalThis.Date = RealDate;
  }
}

function normalizePdf(file) {
  const source = readFileSync(file).toString('latin1');
  const dated = source.replace(
    /\/(CreationDate|ModDate)\(D:\d{14}[+-]\d{2}'\d{2}'\)/g,
    (_, field) => `/${field}(D:${STAMP_PDF})`,
  );
  const idPattern = /(\/ID \[ <)([0-9A-F]{32})(>\s*<)([0-9A-F]{32})(> \])/;
  const sumPattern = /(\/DocChecksum \/)([0-9A-F]{32})/;
  const blanked = dated
    .replace(
      idPattern,
      (_, a, id, b, __, d) => `${a}${'0'.repeat(id.length)}${b}${'0'.repeat(id.length)}${d}`,
    )
    .replace(sumPattern, (_, a, sum) => `${a}${'0'.repeat(sum.length)}`);
  const digest = createHash('sha256').update(blanked, 'latin1').digest('hex').toUpperCase();
  const id = digest.slice(0, 32);
  const checksum = digest.slice(32, 64);
  writeFileSync(
    file,
    Buffer.from(
      blanked
        .replace(idPattern, (_, a, __, b, ___, d) => `${a}${id}${b}${id}${d}`)
        .replace(sumPattern, (_, a) => `${a}${checksum}`),
      'latin1',
    ),
  );
}

async function buildGuide(guide) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'A4', width: W, height: H });
  pptx.layout = 'A4';
  pptx.author = 'АВТО';
  pptx.company = 'АВТО';
  pptx.subject = guide.subject;
  pptx.title = guide.title;
  pptx.lang = 'ru-RU';
  pptx.theme = {
    headFontFace: FONT,
    bodyFontFace: FONT,
    lang: 'ru-RU',
  };
  guide.pages.forEach((page, index) =>
    renderPage(pptx, guide, { ...page, number: index + 1 }, guide.pages.length),
  );

  const pptxPath = join(OUT_DIR, `${guide.file}.pptx`);
  mkdirSync(dirname(pptxPath), { recursive: true });
  await writePptxAtFixedTime(pptx, pptxPath);

  const profile = mkdtempSync(join(tmpdir(), 'office-guides-soffice-'));
  const runtime = join(profile, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const converted = spawnSync(
    'soffice',
    [
      `-env:UserInstallation=file://${profile}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      OUT_DIR,
      pptxPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtime,
        SAL_USE_VCLPLUGIN: 'svp',
      },
    },
  );
  rmSync(profile, { recursive: true, force: true });
  if (converted.status !== 0) {
    throw new Error(`${guide.file}: PDF не собрался\n${converted.stdout}\n${converted.stderr}`);
  }
  const pdfPath = join(OUT_DIR, `${guide.file}.pdf`);
  normalizePdf(pdfPath);
  return [pptxPath, pdfPath];
}

const requester = {
  file: 'Памятка_Оргтехника_заявителю',
  title: 'Оргтехника: памятка заявителю',
  subject: 'Как создать и сопровождать заявку на обслуживание оргтехники',
  kicker: 'Оргтехника · заявитель',
  footer: 'Памятка заявителю',
  pages: [
    {
      title: 'Создать заявку без лишних шагов',
      subtitle: 'Раздел «Орг.техника» → «Заявки» → «Создать заявку».',
      blocks: [
        { type: 'section', text: 'Что заполнить' },
        {
          type: 'steps',
          items: [
            `Выберите «Чем помочь»: «${kind('repair')}» или «${kind('consumable')}».`,
            'Найдите аппарат по модели, инвентарному или серийному номеру. Проверьте место и номера под полем.',
            'Опишите, что происходит. Для расходников напишите цвет и что закончилось; позиции справочника подберёт исполнитель.',
            'Проверьте поля «Для кого заявка», «Кто обращается», телефон и при необходимости «Откуда обращаетесь».',
            'Если работа действительно встала, отметьте «Срочная заявка» и обязательно объясните причину.',
            'Приложите фото неисправности или шильдика и нажмите «Сохранить».',
          ],
        },
        {
          type: 'callout',
          title: 'Срочность после отправки меняет служба',
          body: 'При создании заявки заявитель может попросить срочный приоритет. Позже поставить или снять его может оператор. Срочная метка не заменяет точного описания.',
          tone: 'orange',
        },
        {
          type: 'cards',
          items: [
            {
              title: 'Хорошее описание',
              body: '«Мнёт бумагу на каждой второй странице; печать нужна для пропусков».',
              tone: 'green',
            },
            {
              title: 'Нужны расходники',
              body: '«Закончился чёрный тонер; печать остановлена». Не выбирайте картридж из справочника сами.',
              tone: 'blue',
            },
            {
              title: 'Аппарат стоит не там',
              body: 'Отметьте расхождение и укажите фактическое место. Карточку парка исправит ответственный.',
              tone: 'purple',
            },
            {
              title: 'Повторная проблема',
              body: 'Если старая заявка ещё открыта, портал предложит открыть её. Допишите сведения в обсуждении.',
              tone: 'gray',
            },
          ],
        },
      ],
    },
    {
      title: 'Категория и предмет заявки',
      subtitle:
        'Категорию после отправки не меняют: при ошибке создают новую заявку, прежнюю удаляют или просят отменить.',
      blocks: [
        { type: 'section', text: 'Две категории' },
        {
          type: 'table',
          head: ['Категория', 'Когда выбирать', 'Примеры'],
          widths: [1.4, 2.3, 3.5],
          rows: [
            [
              kind('repair'),
              'Аппарат неисправен, требует настройки, проверки или переноса',
              'Не печатает; полосы; не сканирует; подключить; перенести; проверить перед списанием',
            ],
            [
              kind('consumable'),
              'Аппарат исправен, но закончился материал',
              'Картридж; тонер; нужен запас на площадку',
            ],
          ],
        },
        { type: 'section', text: 'Если аппарата нет в списке' },
        {
          type: 'steps',
          items: [
            'Нажмите «Не нашли технику?» под полем выбора.',
            'Если доступно окно «Сообщить об аппарате», заполните тип, модель с шильдика, один из номеров, объект и место. Сообщение уйдёт вместе с заявкой на проверку.',
            'Если вместо окна показана техподдержка, скопируйте подготовленный текст, отправьте его и дождитесь появления карточки в справочнике.',
          ],
        },
        {
          type: 'callout',
          title: 'Функция включается поэтапно',
          body: 'Карточка отсутствующего аппарата и очередь проверки уже подготовлены, но право на них может быть ещё не выдано в вашем контуре. Ориентируйтесь на вариант, который показывает портал.',
          tone: 'orange',
        },
        { type: 'section', text: 'Гарантия и перемещение' },
        {
          type: 'bullets',
          items: [
            'Для действующей гарантии поставщика выберите «Гарантия на технику». Обращение по гарантии прошлого ремонта создают из реестра гарантий.',
            `Перенос аппарата — это «${kind('repair')}». В описании укажите откуда и куда; после выполнения служба подтверждает новое место.`,
            'Заявка без выбранного аппарата доступна только отдельным профилям службы и ИТ; обычному заявителю аппарат обязателен.',
          ],
        },
      ],
    },
    {
      title: 'Ход заявки и ожидание',
      subtitle:
        'Рабочих состояний шесть. Назначение исполнителя и согласование объёма работ теперь показываются как шаги ожидания, а не отдельные статусы.',
      blocks: [
        {
          type: 'flow',
          items: [
            { title: status('new'), body: 'распределение / старт', tone: 'blue' },
            { title: status('in_work'), body: 'работа / согласование', tone: 'orange' },
            { title: status('done'), body: 'приёмка', tone: 'purple' },
            { title: status('accepted'), body: 'завершено', tone: 'green' },
          ],
        },
        {
          type: 'table',
          head: ['Статус', 'Что означает', 'Что делать заявителю'],
          widths: [1.25, 3.0, 3.0],
          rows: [
            [
              status('new'),
              'Заявка заведена. Она либо ждёт распределения, либо уже ждёт назначенного исполнителя',
              'До назначения можно исправить описание; до начала работ — удалить',
            ],
            [
              status('in_work'),
              'Исполнитель работает либо ждёт согласования предъявленного объёма',
              'Быть на связи; отвечать в обсуждении',
            ],
            [
              status('on_hold'),
              'Ход остановлен с причиной',
              'Посмотреть причину; при новых данных написать в обсуждении',
            ],
            [
              status('done'),
              'Работы предъявлены и ждут приёмки',
              'Проверить результат и сразу сообщить о недостатках',
            ],
            [
              status('accepted'),
              'Работа принята человеком или порталом',
              'При новой поломке создать новую заявку',
            ],
            [
              status('cancelled'),
              'Заявка отменена с причиной',
              'Прочитать причину в карточке и истории',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Автоматическая приёмка через 24 часа',
          body: `Если заявка остаётся в «${status('done')}», портал переводит её в «${status('accepted')}» через 24 часа. Для работы внешнего сервиса закрывающий документ должен быть подшит. Отложенная заявка автоматически не закрывается.`,
          tone: 'blue',
        },
      ],
    },
    {
      title: 'Карточка, документы и обсуждение',
      subtitle:
        'Заявителю показывается рабочая информация по его обращению без внутренних сумм и расчётов подрядчика.',
      blocks: [
        { type: 'section', text: 'Что видно' },
        {
          type: 'table',
          head: ['Раздел карточки', 'Содержание', 'Действия заявителя'],
          widths: [1.45, 3.2, 2.6],
          rows: [
            [
              'Заявка',
              'Аппарат, место, описание, заказчик, контакт, срочность, статус и исполнители',
              'Читать; править только новую заявку без исполнителей',
            ],
            ['Расходники', 'Для заявки на расходники — что запрошено и что выдано', 'Читать'],
            [
              'Документы',
              'Вложения и гарантийный талон',
              'Добавить вложение; снять только своё, пока заявка не закрыта',
            ],
            [
              'История',
              'Переходы, причины, правки и назначения без скрытых финансовых значений',
              'Читать',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Почему нет вкладки «Объём работ» и сумм',
          body: 'Объём работ, акт, счёт и стоимость относятся к внутреннему расчёту компании с исполнителем. Сервер не передаёт их аудитории заявителя — это не ошибка интерфейса.',
          tone: 'blue',
        },
        { type: 'section', text: 'Обсуждение' },
        {
          type: 'steps',
          items: [
            'Откройте «Обсуждение» из строки или карточки заявки.',
            'Выберите адресата: всем участникам, службе, системному администратору или сервисному центру — доступные варианты покажет портал.',
            'Напишите сообщение по существу и приложите файл во вкладке «Документы», если он нужен.',
            'Синяя метка у обсуждения означает непрочитанные реплики. После закрытия заявки лента доступна только для чтения.',
          ],
        },
        {
          type: 'callout',
          title: 'Почта — уведомление, портал — источник истины',
          body: 'Часть новых почтовых событий включается отдельно после проверки адресатов. Не ждите письмо как подтверждение: статус, документы и ответы проверяйте в карточке заявки.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Что можно исправить',
      subtitle:
        'Кнопки могут постепенно переезжать из меню «Действия» к статусу или нужному полю. Название операции остаётся тем же.',
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Ошибка в описании',
              body: `Пока заявка «${status('new')}» и исполнителя нет — «Редактировать». Аппарат и категорию в правке не меняют.`,
              tone: 'blue',
            },
            {
              title: 'Заявка больше не нужна',
              body: `Пока она «${status('new')}» — «Удалить». После начала работ попросите оператора отменить её и назовите причину.`,
              tone: 'orange',
            },
            {
              title: 'Аппарат уже перенесли',
              body: 'Напишите фактическое место в заявке. Если кнопка подтверждения перемещения вам недоступна, это действие выполняет ИТ или оператор.',
              tone: 'purple',
            },
            {
              title: 'Работа сделана плохо',
              body: `Пока заявка «${status('done')}», сразу напишите в обсуждении. Оператор вернёт её на доработку или остановит автоприёмку.`,
              tone: 'red',
            },
            {
              title: 'Сломалось снова',
              body: `После «${status('accepted')}» создайте новую заявку. Плановая метка повторного обращения может появиться позже и ничего сама не запускает.`,
              tone: 'green',
            },
            {
              title: 'Раздел не открывается',
              body: 'Обратитесь к администратору портала. Профиль заявителя выдаётся ролью или отдельным набором; сервисная учётка его не заменяет.',
              tone: 'gray',
            },
          ],
        },
        { type: 'section', text: 'Короткий контроль перед отправкой' },
        {
          type: 'bullets',
          tone: 'green',
          items: [
            'Выбран правильный аппарат и проверено его место.',
            'Описание объясняет симптом и влияние на работу.',
            'Телефон актуален, фото читаемо, срочность обоснована.',
            'Если аппарат не найден, использован именно тот маршрут, который сейчас показывает портал.',
          ],
        },
      ],
    },
  ],
};

const itGuide = {
  file: 'Памятка_Оргтехника_ИТ-специалисту',
  title: 'Оргтехника: памятка ИТ-специалисту',
  subject: 'Координация и выполнение заявок оргтехники системным администратором',
  kicker: 'Оргтехника · системный администратор',
  footer: 'Памятка ИТ-специалисту',
  pages: [
    {
      title: 'Две части профиля ИТ',
      subtitle:
        'Профиль выдаётся двумя наборами: координация модуля и работа назначенным исполнителем.',
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Координация',
              body: 'Сквозной просмотр заявок и техники, финансы, назначение исполнителей, отложить/возобновить, создать заявку без аппарата, подтвердить перемещение.',
              tone: 'purple',
            },
            {
              title: 'Исполнение',
              body: 'Принять заявку в работу, подшивать файлы и закрывать работы — только если вы назначены поимённо; объём работ ведут по заявкам сервисной компании.',
              tone: 'blue',
            },
            {
              title: 'Чего нет',
              body: 'ИТ не ведёт весь справочник техники, не меняет срочность после создания, не принимает завершённую работу за заказчика и не отменяет заявки операторским коридором.',
              tone: 'red',
            },
            {
              title: 'Почему два набора',
              body: 'Назначенному исполнителю не требуется доступ ко всем чужим заявкам. Разделение сохраняет сквозную координацию только у профиля ИТ.',
              tone: 'green',
            },
          ],
        },
        { type: 'section', text: 'Начало дня' },
        {
          type: 'steps',
          items: [
            'Откройте «Орг.техника» → «Заявки». Сначала проверьте «Ждут меня», затем срочные и старые ожидания.',
            'Сверьте, есть ли у заявки исполнитель и не ждёт ли она согласования объёма работ.',
            'Если работаете руками — убедитесь, что назначены поимённо. Одного просмотра карточки недостаточно.',
            'Все уточнения фиксируйте в обсуждении; телефон используйте для скорости, итог продублируйте в заявке.',
          ],
        },
        {
          type: 'callout',
          title: 'Кнопка определяется и правом, и назначением',
          body: 'Если нужного действия нет, сначала проверьте состав исполнителей и статус. Не просите расширять доступ, пока не исключено обычное отсутствие назначения.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Очередь, назначение и отказ',
      subtitle: `После упрощения «${status('new')}» означает и нераспределённую заявку, и заявку с назначенными исполнителями до старта.`,
      blocks: [
        {
          type: 'table',
          head: ['Ситуация', 'Подпись ожидания', 'Ваше действие'],
          widths: [2.4, 1.7, 3.4],
          rows: [
            [
              `«${status('new')}», исполнителей нет`,
              'Ждёт оператора',
              'Назначить одного или нескольких сотрудников и не более одной сервисной компании',
            ],
            [
              `«${status('new')}», вы назначены`,
              'Ждёт исполнителя',
              '«Принять в работу» либо «Отказаться от заявки» с причиной',
            ],
            [
              `«${status('in_work')}», объём предъявлен`,
              'Ждёт согласования',
              'Согласовать или не согласовать; сервисная компания свою редакцию не согласует',
            ],
            [
              `«${status('on_hold')}»`,
              'Отложена',
              'Проверить причину и при готовности возобновить в прежнее состояние',
            ],
          ],
        },
        { type: 'section', text: 'Назначение' },
        {
          type: 'bullets',
          items: [
            'Первое назначение не меняет статус. Причина обязательна при замене состава и массовом назначении.',
            'Отказ поимённого сотрудника снимает только его строку; отказ сервиса снимает компанию целиком.',
            'Если отказался последний исполнитель, заявка остаётся «Новой» и снова ждёт распределения.',
            'Состав нельзя менять, пока висит предъявленный объём работ. Сначала согласуйте его или верните в правку.',
          ],
        },
        {
          type: 'callout',
          title: 'Быстрые входы вводятся поэтапно',
          body: '«Принять в работу» и смена статуса могут быть показаны рядом со статусом или оставаться в меню «Действия». При отсутствии быстрого входа используйте меню — серверное правило одинаково.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Выполнение заявки',
      subtitle: 'Рабочий статус один; назначение и предъявление объёма работ его не меняют.',
      blocks: [
        {
          type: 'flow',
          items: [
            { title: status('new'), body: 'назначены', tone: 'blue' },
            { title: 'Принять в работу', body: 'только назначенный', tone: 'purple' },
            { title: status('in_work'), body: 'работа', tone: 'orange' },
            { title: 'Закрыть работы', body: 'результат и гарантии', tone: 'green' },
            { title: status('done'), body: 'приёмка', tone: 'purple' },
          ],
        },
        { type: 'section', text: 'Если вы исполнитель' },
        {
          type: 'steps',
          items: [
            'Нажмите «Принять в работу». Если кнопки нет — проверьте, что заявка «Новая» и вы назначены.',
            'Уточните симптом, место и контакт. Расхождение места зафиксируйте до перемещения.',
            `Для «${kind('repair')}» под сервисной компанией заполните объём работ; если ремонт ведёте вы сами, этапа объёма работ у заявки нет. Для «${kind('consumable')}» заполните состав расходников и фактически выданное количество.`,
            'Если нужно ждать деталь или доступ, отложите заявку с причиной. Возобновление вернёт её туда, откуда остановили.',
            'По завершении закройте работы: по заявке сервисной компании — фактический результат и гарантийные сроки, по внутреннему ремонту — дату выполнения и необязательное «Что сделали».',
          ],
        },
        {
          type: 'callout',
          title: 'ИТ не принимает собственную работу за заказчика',
          body: `Переход «${status('done')}» → «${status('accepted')}» относится к оператору «Ведения» либо к автоприёмке. Если результат спорный, оператор возвращает заявку в работу.`,
          tone: 'blue',
        },
        { type: 'section', text: 'Заявка без аппарата' },
        {
          type: 'p',
          text: 'Профиль ИТ может создать заявку без выбранной единицы — например, на инфраструктурную работу. Обязательно выберите заказчика и дайте предмету понятное название в описании; гарантийный сценарий без аппарата не применяется.',
        },
      ],
    },
    {
      title: 'Объём работ и согласование',
      subtitle:
        'Этап есть только у заявок, которые ведёт сервисная компания. «Смета» переименована в «Объём работ»; предъявление и согласование больше не являются отдельным статусом.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Исполнитель открывает «Объём работ», добавляет услуги и детали, количества, цены и гарантийные месяцы.',
            '«Предъявить объём работ» создаёт новую ревизию. Пока она ждёт решения, состав и исполнителей не меняют.',
            'Доступный согласующий нажимает «Согласовать объём работ» либо «Не согласовать» с причиной и решением.',
            'При исправлении выберите «Вернуть объём в правку»: предъявление и прежнее согласование снимаются.',
            'После правки предъявите новую ревизию; старая подпись к ней не относится.',
          ],
        },
        {
          type: 'table',
          head: ['Кто', 'Может подготовить', 'Может согласовать'],
          widths: [2.3, 2.5, 2.5],
          rows: [
            [
              'Сервисная компания',
              'Да, по заявке своей компании',
              'Нет — собственный объём не согласуется самим подрядчиком',
            ],
            [
              'Поимённый ИТ-исполнитель',
              'Да, по назначенной заявке',
              'Да, если портал показывает действие для текущей ревизии',
            ],
            ['Оператор «Ведения»', 'Нет', 'Да; отвечает за сумму и итоговое решение'],
          ],
        },
        {
          type: 'callout',
          title: 'Виза ИТ на входе упразднена',
          body: 'Старые записи истории могут содержать «Согласована ИТ», «Диагностика», «Назначена» и «Смета на согласовании». Новые заявки в эти состояния не переходят; подписи сохранены только ради истории.',
          tone: 'gray',
        },
      ],
    },
    {
      title: 'Документы, гарантии и приёмка',
      subtitle:
        'Для внешнего ремонта закрывающий документ обязателен до перехода в «Решена». Для внутреннего ремонта — нет.',
      blocks: [
        {
          type: 'table',
          head: ['Документ', 'Для чего', 'Кому виден'],
          widths: [1.45, 3.2, 2.55],
          rows: [
            [
              'Вложение',
              'Фото, описание, переписка по факту',
              'Всем участникам по правилам заявки',
            ],
            ['Объём работ', 'Расчёт услуг и деталей', 'Финансовой аудитории'],
            ['Акт / счёт', 'Закрывающий документ внешнего сервиса', 'Финансовой аудитории'],
            ['Гарантийный талон', 'Подтверждение срока', 'В том числе заявителю'],
          ],
        },
        { type: 'section', text: 'Гарантийный сценарий' },
        {
          type: 'bullets',
          items: [
            'До работ проверьте источник обращения: гарантия техники или прошлого ремонта.',
            'При закрытии укажите фактически выполненные строки и срок гарантии. Не обещайте срок без подтверждаемого основания.',
            'Возврат на доработку снимает рассчитанные даты; при повторном закрытии их нужно проверить заново.',
            'Расширенный реестр, исправление дат и выгрузка ещё проходят отдельную волну. Пользуйтесь только видимыми в портале действиями.',
          ],
        },
        {
          type: 'callout',
          title: '24 часа на возражение',
          body: `После «${status('done')}» портал может принять заявку автоматически через 24 часа. Возврат в работу начинает отсчёт заново; «${status('on_hold')}» снимает заявку с очереди автоприёмки.`,
          tone: 'blue',
        },
      ],
    },
    {
      title: 'Перемещение и история аппарата',
      subtitle:
        'Перемещение записывается отдельным событием и может быть подтверждено из карточки заявки.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Сверьте текущие объект, отдел, место и состояние аппарата с фактом.',
            'Откройте действие перемещения рядом с реквизитами аппарата. Укажите новое место, дату, причину и комментарий.',
            'Если заявитель сообщил иное место, подтвердите, что новое значение соответствует заявленному, либо объясните расхождение.',
            'При конфликте «аппарат уже перемещён» обновите карточку и повторите решение по свежим данным.',
          ],
        },
        {
          type: 'callout',
          title: 'Волна ещё заканчивает совместимый переход',
          body: 'В текущей схеме прежнее место сверяется, но на первом выпуске может быть необязательным в запросе. После обновления клиентов оно станет обязательным. Для пользователя порядок действий не меняется.',
          tone: 'orange',
        },
        { type: 'section', text: 'История' },
        {
          type: 'bullets',
          items: [
            'Сегодня доступна полная лента событий аппарата и заявки.',
            'Новые блоки «Изменения», «Перемещения», «Заявки» и «Полная история» вводятся поэтапно; первые серверные выборки уже готовы.',
            'До появления всех блоков ищите событие в полной истории. Не делайте вывод «события нет» только по пустому новому блоку.',
          ],
        },
        { type: 'section', text: 'Отсутствующий аппарат' },
        {
          type: 'p',
          text: 'Очередь проверки кандидатов предназначена профилю «Ведение», потому что решение создаёт карточку парка. ИТ может помочь уточнить модель, но не подтверждает кандидата без права ведения справочника.',
        },
      ],
    },
    {
      title: 'Переходный период и диагностика',
      subtitle:
        'Инструкция описывает целевой поток и честно отмечает функции, которые ещё включаются или принимаются.',
      blocks: [
        {
          type: 'table',
          head: ['Функция', 'Состояние на 07.09.2026', 'Как работать сейчас'],
          widths: [2.0, 2.55, 2.8],
          rows: [
            [
              'Быстрая смена статуса',
              'Код и тесты готовы, пилотная приёмка не завершена',
              'Если нет входа на статусе — меню «Действия»',
            ],
            ['Массовые действия', 'Собраны; выкат и пилот впереди', 'Работать по одной заявке'],
            [
              'Кандидат техники',
              'Собран; права ещё могут быть не выданы',
              'Маршрут «Не нашли технику?» → техподдержка',
            ],
            [
              'Почтовые события',
              'Код готов; новые события включаются после проверки адресатов',
              'Смотреть очередь и обсуждение в портале',
            ],
            [
              'Гарантийное завершение',
              'База работает; расширение реестра и правки дат не закончены',
              'Не использовать невидимые действия; фиксировать уточнения в истории',
            ],
          ],
        },
        { type: 'section', text: 'Если нет кнопки' },
        {
          type: 'steps',
          items: [
            'Обновите карточку: версия заявки могла измениться после вашего открытия.',
            'Проверьте статус, назначение и ожидание; наведите на неактивное действие — причина должна быть доступна.',
            'Убедитесь, что профиль ИТ выдан полностью двумя наборами.',
            'Если условие выполнено, а действие отсутствует, передайте администратору номер заявки, своё ФИО, время и скрин без персональных данных посторонних заявок.',
          ],
        },
      ],
    },
  ],
};

const serviceGuide = {
  file: 'Инструкция_Оргтехника_сервисной-компании',
  title: 'Оргтехника: инструкция сервисной компании',
  subject: 'Работа сотрудников внешней сервисной компании с назначенными заявками оргтехники',
  kicker: 'Оргтехника · сервисная компания',
  footer: 'Инструкция сервисной компании',
  pages: [
    {
      title: 'Что видит сотрудник сервиса',
      subtitle:
        'Доступ определяется учёткой, связанной с вашей сервисной компанией, и назначением заявки этой компании.',
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Видно',
              body: 'Только заявки, назначенные вашей компании: аппарат снимком, место, контакт, описание, обсуждение, объём работ, суммы и документы.',
              tone: 'green',
            },
            {
              title: 'Можно',
              body: 'Принять или отклонить назначение, вести и предъявлять объём работ, прикладывать документы, закрывать выполненные работы.',
              tone: 'blue',
            },
            {
              title: 'Нельзя',
              body: 'Просматривать весь парк, создавать и править заявку заказчика, назначать исполнителей, ставить срочность, откладывать, отменять или принимать свою работу.',
              tone: 'red',
            },
            {
              title: 'Назначается компания',
              body: 'Портал не выбирает конкретного мастера внутри вашей организации. Все сотрудники с корректной сервисной учёткой работают от одной стороны компании.',
              tone: 'purple',
            },
          ],
        },
        { type: 'section', text: 'Безопасный вход' },
        {
          type: 'bullets',
          items: [
            'Используйте только личную учётную запись; не передавайте пароль коллегам.',
            'Если список пуст, сначала уточните у заказчика, назначена ли заявка именно вашей компании.',
            'Если видна чужая компания или чужая заявка, прекратите работу и сообщите администратору портала — это ошибка привязки доступа.',
          ],
        },
        {
          type: 'callout',
          title: 'Письмо не создаёт доступ',
          body: 'Ссылка из уведомления откроется только после назначения вашей компании. Если письмо не пришло, заявка всё равно может быть доступна в портале; проверяйте очередь.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Принять или отказаться',
      subtitle: `Назначенная заявка остаётся в статусе «${status('new')}» до того, как исполнитель примет её в работу.`,
      blocks: [
        {
          type: 'steps',
          items: [
            'Откройте заявку и проверьте аппарат, адрес, контакт, описание, срочность и приложенные фото.',
            'Если готовы выполнять — нажмите «Принять в работу». Статус станет «В работе».',
            'Если выполнить нельзя — нажмите «Отказаться от заявки» и укажите конкретную причину.',
            'Отказ сервисной учётки снимает назначение всей компании, а не одного сотрудника.',
            'После начала работ отказаться этой кнопкой нельзя: сообщите оператору в обсуждении, чтобы он изменил исполнителей или вернул заявку.',
          ],
        },
        {
          type: 'callout',
          title: 'Кнопка может быть в двух местах',
          body: 'На новых экранах «Принять в работу» выводится быстрой кнопкой рядом со статусом. Во время поэтапного выката она может оставаться только в меню «Действия».',
          tone: 'orange',
        },
        { type: 'section', text: 'Перед выездом' },
        {
          type: 'bullets',
          items: [
            'Свяжитесь с заявителем по номеру из карточки и согласуйте доступ.',
            'Сверьте серийный и инвентарный номера на месте; при расхождении не подменяйте аппарат в заявке, а сообщите оператору.',
            'Если аппарат уже перемещён, напишите фактическое место в обсуждении. Карточку парка меняет ИТ или оператор.',
            'Если требуется гарантийный выезд, проверьте указанный источник гарантии до платных работ.',
          ],
        },
      ],
    },
    {
      title: 'Объём работ',
      subtitle:
        'Сервис готовит расчёт, но не согласует его сам. Предъявление создаёт ревизию и оставляет заявку «В работе».',
      blocks: [
        {
          type: 'steps',
          items: [
            'Откройте вкладку «Объём работ» или одноимённое действие.',
            'Добавьте услуги и детали: наименование, количество, цену и гарантийный срок в месяцах, если он предоставляется.',
            'Проверьте итог и приложите файл вида «Объём работ», если расчёт оформлен отдельным документом.',
            'Нажмите «Предъявить объём работ». Пока он ждёт решения, менять строки или повторно предъявлять нельзя.',
            'После согласования выполняйте работы. При возврате в правку исправьте строки и предъявите новую ревизию.',
          ],
        },
        {
          type: 'callout',
          title: 'Не согласовывайте собственный расчёт',
          body: 'У сервисной компании действий «Согласовать» и «Не согласовать» быть не должно. Решение принимает сторона заказчика. Если кнопка появилась, не нажимайте её и сообщите администратору.',
          tone: 'red',
        },
        { type: 'section', text: 'Когда объём работ не нужен' },
        {
          type: 'p',
          text: `Для заявки вида «${kind('consumable')}» вкладки с расчётом нет: предметом служит номенклатура. Если такая заявка назначена сервису и нужного действия нет, уточните маршрут у оператора — основной внешний сценарий рассчитан на обслуживание.`,
        },
        { type: 'section', text: 'Обсуждение' },
        {
          type: 'bullets',
          items: [
            'Адресуйте вопросы заявителю, оператору или всем участникам.',
            'Фиксируйте согласованные изменения состава работ в портале, а не только по телефону.',
            'После закрытия обсуждение читается, но новые реплики не добавляются.',
          ],
        },
      ],
    },
    {
      title: 'Документы и закрытие работ',
      subtitle: `Внешнее обслуживание нельзя перевести в «${status('done')}», пока не приложен хотя бы один закрывающий документ.`,
      blocks: [
        {
          type: 'table',
          head: ['Вид файла', 'Когда использовать', 'Считается закрывающим'],
          widths: [1.65, 3.75, 1.9],
          rows: [
            ['Вложение', 'Фото до/после, техническое заключение без финансового назначения', 'Нет'],
            ['Объём работ', 'Расчёт или коммерческое предложение', 'Нет'],
            ['Акт', 'Подтверждение выполненных работ', 'Да'],
            ['Счёт', 'Документ на оплату', 'Да'],
            ['Гарантийный талон', 'Подтверждение гарантии результата', 'Да'],
          ],
        },
        { type: 'section', text: 'Закрыть работы' },
        {
          type: 'steps',
          items: [
            'Приложите хотя бы акт, счёт или гарантийный талон и выберите правильный вид файла.',
            'Откройте «Закрыть работы». Если действие неактивно, наведите на него: портал назовёт недостающий документ.',
            'Отметьте, что выполнено полностью, частично или не выполнено; укажите фактические суммы и скидку с причиной, если она была.',
            'Проверьте гарантийные даты и отправьте результат. Заявка перейдёт в «Решена».',
          ],
        },
        {
          type: 'callout',
          title: 'Файл можно добавить позже, удалить — не всегда',
          body: 'Закрывающие документы разрешено подшивать и после приёмки, если бумага пришла позднее. Удаление после закрытия ограничено; ошибочный файл не заменяйте молча — согласуйте исправление с оператором.',
          tone: 'blue',
        },
      ],
    },
    {
      title: 'После выполнения и гарантия',
      subtitle: `Из «${status('done')}» заявку принимает оператор либо портал автоматически через 24 часа.`,
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Работа принята',
              body: `Статус «${status('accepted')}». Карточка остаётся в истории, документы доступны по правилам роли.`,
              tone: 'green',
            },
            {
              title: 'Вернули на доработку',
              body: `Статус снова «${status('in_work')}». Прочитайте причину, проверьте состав и гарантийные даты, затем закройте повторно.`,
              tone: 'orange',
            },
            {
              title: 'Автоприёмка',
              body: 'Через 24 часа после последнего перехода в «Решена», если заявка не отложена и обязательный документ на месте.',
              tone: 'blue',
            },
            {
              title: 'Спор по результату',
              body: 'Не закрывайте новую заявку вместо исправления. Работайте в возвращённой заявке, чтобы история и гарантия остались связаны.',
              tone: 'red',
            },
          ],
        },
        { type: 'section', text: 'Гарантийные обязательства' },
        {
          type: 'bullets',
          items: [
            'Гарантийный срок по строке работ указывайте только для фактически выполненного результата.',
            'При повторном закрытии портал пересчитывает даты; проверьте их заново после возврата на доработку.',
            'Исправление ошибочной даты и расширенная выгрузка реестра ещё вводятся отдельной волной. До появления действия обращайтесь к оператору.',
          ],
        },
        {
          type: 'callout',
          title: 'Не полагайтесь только на электронную почту',
          body: 'Новые уведомления по статусам, документам и обсуждению включаются после проверки адресатов. Очередь заявок и карточка в портале остаются основным источником.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Частые проблемы',
      subtitle:
        'Перед обращением в поддержку обновите карточку: параллельная правка могла изменить версию заявки.',
      blocks: [
        {
          type: 'table',
          head: ['Проблема', 'Проверить', 'Что делать'],
          widths: [2.0, 2.5, 2.8],
          rows: [
            [
              'Заявка не видна',
              'Назначена ли ваша компания; верно ли привязан контрагент учётки',
              'Попросить оператора проверить назначение; затем администратора — привязку',
            ],
            [
              'Нет «Принять в работу»',
              `Статус «${status('new')}» и назначение вашей компании`,
              'Открыть «Действия»; обновить карточку',
            ],
            [
              'Не редактируется объём',
              'Не предъявлена ли ревизия на согласование',
              'Дождаться решения или попросить вернуть в правку',
            ],
            [
              '«Закрыть работы» неактивно',
              'Есть ли акт, счёт или гарантийный талон с правильным видом',
              'Подшить документ и обновить карточку',
            ],
            [
              'Нужно сменить аппарат/адрес',
              'Это не право сервиса',
              'Сообщить фактические данные оператору в обсуждении',
            ],
            [
              'Ошибка версии',
              'Кто-то изменил заявку после открытия',
              'Обновить данные и повторить осознанно',
            ],
          ],
        },
        { type: 'section', text: 'Что сообщить поддержке' },
        {
          type: 'bullets',
          items: [
            'Номер заявки, время, название действия и полный текст ошибки.',
            'На каком устройстве и в каком браузере воспроизвелось.',
            'Скриншот только своей заявки; не пересылать пароли, токены и персональные данные чужих заявок.',
          ],
        },
      ],
    },
  ],
};

const fullGuide = {
  file: 'Руководство_Оргтехника_полное',
  title: 'Оргтехника: полное руководство',
  subject: 'Единое руководство по заявкам, парку, расходникам, гарантиям и ролям',
  kicker: 'Оргтехника · полное руководство',
  footer: 'Полное руководство по оргтехнике',
  pages: [
    {
      title: 'О руководстве и поэтапном вводе',
      subtitle:
        'Документ объединяет действующий цикл, готовые волны рефакторинга и честные ограничения ещё не завершённых работ.',
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Базовый поток',
              body: 'Заявки двух видов, шесть рабочих статусов, назначение, объём работ, обсуждение, документы, автоприёмка, расходники и закупки.',
              tone: 'green',
            },
            {
              title: 'Вводится поэтапно',
              body: 'Быстрые действия на статусе, очищенное меню, перемещение из карточки заявки, массовые операции и блоки истории.',
              tone: 'orange',
            },
            {
              title: 'Собрано, но может быть выключено',
              body: 'Сообщение об отсутствующем аппарате и новые почтовые события — до выдачи прав и проверки адресатов.',
              tone: 'purple',
            },
            {
              title: 'Только план',
              body: 'Метка повторных обращений и автоматический сбор наработки. Эти функции нельзя считать доступными, пока их нет на экране.',
              tone: 'gray',
            },
          ],
        },
        { type: 'section', text: 'Главное правило переходного периода' },
        {
          type: 'callout',
          title: 'Следуйте видимому действию, а не ожидаемому месту кнопки',
          body: 'Операция может находиться у статуса, у нужного поля или в меню «Действия». Если быстрый вход ещё не выкачен, основной маршрут остаётся в меню. Если функция помечена как не включённая, используйте указанный запасной процесс.',
          tone: 'blue',
        },
        { type: 'section', text: 'Словарь модуля' },
        {
          type: 'bullets',
          items: [
            `«${kind('repair')}» — ремонт, настройка, диагностика, перемещение и иная работа с аппаратом.`,
            `«${kind('consumable')}» — выдача картриджа, тонера или запаса со склада.`,
            '«Объём работ» — строки услуг и деталей с ценами; прежнее слово «Смета» осталось только в старой истории и технических именах.',
            '«Оператор» в руководстве — профиль «Ведение оргтехники»; «сервис» — внешний подрядчик.',
          ],
        },
      ],
    },
    {
      title: 'Профили и границы доступа',
      subtitle:
        'Права отвечают на «что можно», область — «над какими строками», назначение — «чей сейчас ход».',
      blocks: [
        {
          type: 'table',
          head: ['Профиль', 'Область', 'Основные действия'],
          widths: [1.65, 2.2, 3.5],
          rows: [
            [
              'Заявитель',
              'Свои и доступные по роли заявки; собственные изменения',
              'Создать, уточнить до назначения, удалить новую, вложения и обсуждение',
            ],
            [
              'Оператор «Ведения»',
              'Объекты/отделы роли либо администраторская область',
              'Парк, распределение, срочность, заморозка, согласование, приёмка, закупки',
            ],
            [
              'Системный администратор',
              'Сквозной просмотр модуля; исполнение только по назначению',
              'Назначение, заморозка, финансы, перемещения; работа при поимённом назначении',
            ],
            [
              'Сервисный центр',
              'Только заявки, назначенные своей компании',
              'Принять/отказаться, объём работ, документы, закрыть работы',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Сервисному центру наборы оргтехники не выдают',
          body: 'Его профиль задаёт пара «роль operator + контрагент типа service». Попытка выдать обычный набор не создаст правильную область и может открыть лишние данные.',
          tone: 'red',
        },
        { type: 'section', text: 'Совмещение профилей' },
        {
          type: 'bullets',
          items: [
            'Один человек может быть заявителем и оператором; действия складываются, но ограничения предмета и аудитории сохраняются.',
            'ИТ-профиль состоит из двух наборов. Координация без исполнителя не даёт права закрывать работы; исполнение без координации не открывает весь модуль.',
            'Финансовая аудитория видит объём работ и суммы; заявитель получает серверную проекцию без этих полей.',
            'Администратор портала может разбирать ошибки, но штатный процесс всё равно проходит бизнес-профилями.',
          ],
        },
      ],
    },
    {
      title: 'Создание и правка заявки',
      subtitle: 'Форма одинакова для двух видов, но предмет после отправки ведёт исполнитель.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Выбрать вид и аппарат; проверить снимок номера, места и гарантии.',
            'Заполнить описание, заказчика, заявителя, телефон и при необходимости место обращения.',
            'При фактическом расхождении места отметить его и назвать правильный объект.',
            'Срочность при создании требует причины; позднее её меняет только оператор.',
            'Приложить вложения и сохранить.',
          ],
        },
        {
          type: 'table',
          head: ['Что меняется', 'Пока новая без исполнителей', 'После назначения'],
          widths: [2.3, 2.5, 2.5],
          rows: [
            [
              'Описание, заказчик, контакт, комментарий',
              'Заявитель может исправить',
              'Только через обсуждение и решение службы',
            ],
            ['Аппарат и категория', 'Не меняются правкой', 'Не меняются; нужна новая заявка'],
            [
              'Вложения',
              'Добавляются при создании и во вкладке документов',
              'Добавляются по правилам аудитории',
            ],
            ['Удаление', 'Доступно до начала работ', 'Недоступно; оператор отменяет с причиной'],
          ],
        },
        {
          type: 'callout',
          title: 'Заявка без аппарата — отдельное право',
          body: 'Она предназначена оператору и ИТ для работ без единицы парка. Заказчик обязателен. Обычному заявителю пустой аппарат не разрешён.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Предмет: аппарат, кандидат или отсутствие',
      subtitle:
        'У заявки ровно один способ назвать предмет; смешивать выбранную карточку, кандидата и отсутствие нельзя.',
      blocks: [
        {
          type: 'cards',
          items: [
            {
              title: 'Карточка парка',
              body: 'Обычный путь. Снимок реквизитов сохраняется в заявке, поэтому история остаётся понятной после правок справочника.',
              tone: 'green',
            },
            {
              title: 'Аппарат на проверке',
              body: 'Заявитель сообщает наблюдаемые реквизиты. Проверяющий подтверждает новой карточкой, связывает с существующей или отклоняет.',
              tone: 'purple',
            },
            {
              title: 'Без аппарата',
              body: 'Разрешено отдельным правом для инфраструктурной или организационной работы. Заказчик задаёт область заявки.',
              tone: 'orange',
            },
            {
              title: 'Дубликат',
              body: 'Портал ищет по серийному и инвентарному номерам. Открытая заявка на тот же аппарат блокирует повтор и называет существующий номер.',
              tone: 'blue',
            },
          ],
        },
        { type: 'section', text: 'Проверка кандидата' },
        {
          type: 'steps',
          items: [
            'Очередь видит держатель права проверки в своей области; ИТ-профиль сам по себе это право не получает.',
            'Сверить тип, модель, номера, объект и место; при необходимости поправить заявленные реквизиты.',
            'Подтвердить полной карточкой парка, связать с существующей активной карточкой или отклонить с обязательной причиной.',
            'До решения заявку можно назначать и выполнять, но принять работу и открыть гарантийное обращение нельзя.',
          ],
        },
        {
          type: 'callout',
          title: 'На 07.09 функция может быть не включена',
          body: 'Сервер, портал и тесты собраны, но выдача прав и включение событий относятся к финальной волне. Запасной процесс — обращение в техподдержку и создание карточки оператором.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Статусы и стороны ожидания',
      subtitle:
        'Статус показывает состояние, а подпись ожидания — кто должен сделать следующий шаг.',
      blocks: [
        {
          type: 'flow',
          items: [
            { title: status('new'), body: 'распределить / старт', tone: 'blue' },
            { title: status('in_work'), body: 'работа / согласовать', tone: 'orange' },
            { title: status('done'), body: 'принять', tone: 'purple' },
            { title: status('accepted'), body: 'закрыто', tone: 'green' },
          ],
        },
        {
          type: 'table',
          head: ['Статус', 'Ожидание', 'Допустимый следующий шаг'],
          widths: [1.3, 2.1, 3.9],
          rows: [
            [
              status('new'),
              'Оператор — если никого нет; исполнитель — если назначен',
              'Назначить, принять в работу, отказаться, отменить или отложить',
            ],
            [
              status('in_work'),
              'Исполнитель либо согласующий',
              'Работа, объём работ, закрытие, отмена, отложить',
            ],
            [
              status('on_hold'),
              'Пауза с причиной',
              'Возобновить в сохранённое состояние либо отменить',
            ],
            [status('done'), 'Оператор / 24 часа', 'Принять, вернуть на доработку или отложить'],
            [status('accepted'), 'Никто', 'Архив; администраторский откат при ошибке'],
            [status('cancelled'), 'Никто', 'Архив; администраторский возврат при ошибке'],
          ],
        },
        {
          type: 'callout',
          title: 'Четыре старых статуса — только для истории',
          body: '«Согласована ИТ», «Назначена», «Диагностика» и «Смета на согласовании» больше не получают новые заявки. Их подписи сохранены для правдивой ленты прошлых переходов.',
          tone: 'gray',
        },
      ],
    },
    {
      title: 'Назначение и очереди',
      subtitle: 'Назначение — изменение состава, а не смена статуса.',
      blocks: [
        {
          type: 'bullets',
          items: [
            'Назначить можно несколько внутренних сотрудников и не более одной сервисной компании.',
            'Первое назначение не требует причины; замена состава требует причину и попадает в историю.',
            'Поимённый сотрудник работает только по своему назначению. Сотрудник сервиса действует за всю назначенную компанию.',
            'Отказ до старта снимает себя или компанию; после старта состав меняет оператор/ИТ.',
            'При висящем предъявлении объёма работ переназначение закрыто: сначала решают текущую ревизию.',
          ],
        },
        { type: 'section', text: 'Рабочие очереди' },
        {
          type: 'table',
          head: ['Очередь/отбор', 'Для кого', 'Смысл'],
          widths: [1.8, 2.0, 3.5],
          rows: [
            [
              'Ждут меня',
              'Оператор, согласующий, исполнитель',
              'Следующий ход относится к моей стороне',
            ],
            [
              'Срочные',
              'Оператор и видящие модуль',
              'Отбор по приоритету; наверх списка срочные не поднимаются',
            ],
            [
              'Ожидание по дням',
              'Все рабочие профили',
              'Сколько длится текущая сторона ожидания, а не просто статус',
            ],
            [
              'Архив',
              'По отдельному праву',
              'Мягко удалённые/закрытые записи без расширения аудитории',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Повторные обращения пока не рабочая очередь',
          body: 'План метки повторного обращения подготовлен, но порог и включение ещё не согласованы. Отсутствие метки не означает, что похожих заявок нет.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Работа исполнителя',
      subtitle:
        'Внутренний сотрудник и внешний сервис используют общий исполнительский коридор, но имеют разную область.',
      blocks: [
        {
          type: 'steps',
          items: [
            `Из «${status('new')}» назначенный исполнитель выбирает «Принять в работу».`,
            'Сверяет предмет, место, контакт, гарантийный источник и приложения.',
            `Для «${kind('repair')}» под сервисной компанией ведёт объём работ, при внутреннем ремонте — нет; для «${kind('consumable')}» — состав расходников и факт выдачи.`,
            'Уточнения пишет в обсуждение с адресатом; документы подшивает правильным видом.',
            'Закрывает заявку в «Решена»: под сервисной компанией — фактический результат и гарантии, при внутреннем ремонте — дата выполнения и необязательное «Что сделали».',
          ],
        },
        {
          type: 'table',
          head: ['Действие', 'Внутренний исполнитель', 'Внешний сервис'],
          widths: [2.7, 2.3, 2.3],
          rows: [
            ['Видит заявку', 'Поимённое назначение', 'Назначение своей компании'],
            ['Объём и суммы', 'Только назначенной заявки', 'Только заявки своей компании'],
            ['Отказ до старта', 'Снимает себя', 'Снимает компанию'],
            ['Закрывающий документ', 'Не обязателен', 'Обязателен для обслуживания'],
            ['Принять работу', 'Нет', 'Нет'],
          ],
        },
        {
          type: 'callout',
          title: 'Исполнение не даёт права вести парк',
          body: 'Фактическое перемещение или ошибка номера сообщаются оператору/ИТ. Исполнитель не исправляет карточку аппарата обходом заявки.',
          tone: 'blue',
        },
      ],
    },
    {
      title: 'Объём работ и ревизии',
      subtitle:
        'Объём работ ведут только по заявкам сервисной компании. Подпись относится к конкретной ревизии, а правка после предъявления требует явного возврата.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Исполнитель заполняет услуги/детали, количества, цены и обещанные месяцы гарантии.',
            'Предъявляет объём; заявка остаётся «В работе», ожидание меняется на «Ждёт согласования».',
            'Оператор или доступный поимённый согласующий принимает ревизию либо отклоняет с причиной и решением.',
            'Для исправления исполнитель возвращает объём в правку; предъявление и согласование снимаются.',
            'Новая ревизия требует нового решения. Старые строки и причины сохраняются в истории.',
          ],
        },
        {
          type: 'cards',
          items: [
            {
              title: 'Согласовано',
              body: 'Статус не меняется. Исполнитель продолжает работы по подписанной ревизии.',
              tone: 'green',
            },
            {
              title: 'Не согласовано',
              body: 'Заявка отменяется с причиной и решением по предмету; это не возврат в прежний статус.',
              tone: 'red',
            },
            {
              title: 'Вернуть в правку',
              body: 'Исполнитель отзывает предъявление и подпись, затем меняет состав.',
              tone: 'orange',
            },
            {
              title: 'Сервис не согласует себя',
              body: 'Контрагент-сервис исключён из стороны согласования, даже если у него есть права статуса.',
              tone: 'purple',
            },
          ],
        },
      ],
    },
    {
      title: 'Документы, результат и автоприёмка',
      subtitle: 'Вид файла влияет на видимость, планку закрытия и гарантийный контур.',
      blocks: [
        {
          type: 'table',
          head: ['Вид', 'Назначение', 'Заявителю'],
          widths: [1.45, 4.15, 1.7],
          rows: [
            ['Вложение', 'Фото и общие материалы', 'Видно'],
            ['Объём работ', 'Расчёт и приложение к ревизии', 'Скрыто'],
            ['Акт', 'Подтверждение выполненных работ', 'Скрыто'],
            ['Счёт', 'Финансовый документ', 'Скрыто'],
            ['Гарантийный талон', 'Подтверждение срока', 'Видно'],
          ],
        },
        {
          type: 'bullets',
          items: [
            'Для внешнего обслуживания до «Решена» нужен хотя бы акт, счёт или гарантийный талон.',
            'Закрытие фиксирует выполненные, частичные и невыполненные строки, фактические суммы и гарантии.',
            'Оператор принимает работу либо возвращает её на доработку с причиной.',
            'Через 24 часа «Решена» принимается автоматически, если не отложена и документная планка выполнена.',
            'Возврат на доработку снимает рассчитанные гарантийные даты; повторное закрытие пересчитывает их.',
          ],
        },
        {
          type: 'callout',
          title: 'Непроверенный кандидат блокирует приёмку',
          body: 'Работу можно выполнить и предъявить, но окончательно принять заявку с аппаратом «на проверке» нельзя до решения по карточке.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Расходники и плановая закупка',
      subtitle: 'Номенклатура, складской остаток, потребность и закупка — разные сущности.',
      blocks: [
        {
          type: 'table',
          head: ['Контур', 'Кто ведёт', 'Что меняет'],
          widths: [1.7, 2.2, 3.4],
          rows: [
            [
              'Номенклатура',
              'Набор «Оргтехника: номенклатура»',
              'Карточки картриджей/тонеров и совместимость моделей',
            ],
            [
              'Остаток',
              'Тот же набор, отдельное право',
              'Ручная корректировка с причиной и журналом',
            ],
            [
              'Заявка',
              'Заявитель + назначенный исполнитель',
              'Описание → выбранные позиции → фактически выдано',
            ],
            ['Потребность', 'Ответственный за номенклатуру', 'Сколько держать на полке'],
            [
              'Закупка',
              'Оператор «Ведения»',
              'Черновик, отправка, закрытие/отмена документа; склад не меняет',
            ],
          ],
        },
        { type: 'section', text: 'Цикл заявки на расходники' },
        {
          type: 'steps',
          items: [
            'Заявитель словами описывает, чего не хватает.',
            'Исполнитель подбирает позиции справочника и количество.',
            'В «В работе» или «Решена» отмечает фактическую выдачу; расхождение требует причины.',
            'Списание/возврат пишется событием склада и ссылкой на строку заявки.',
            'Объёма работ и согласования стоимости у такого вида нет.',
          ],
        },
        {
          type: 'callout',
          title: 'Закупка не пополняет остаток автоматически',
          body: 'Закрытый документ закупки означает, что процесс снабжения завершён. Фактическое поступление отражается отдельной операцией склада.',
          tone: 'blue',
        },
      ],
    },
    {
      title: 'Парк, модели и характеристики',
      subtitle:
        'Карточка аппарата отделена от модели; цветность и другие характеристики принадлежат модели.',
      blocks: [
        {
          type: 'table',
          head: ['Сущность', 'Основные поля', 'Правило'],
          widths: [1.55, 3.4, 2.35],
          rows: [
            ['Тип', 'МФУ, принтер и другие классы', 'Область справочника'],
            [
              'Модель',
              'Производитель, наименование, характеристики',
              'Единый канон для аппаратов и совместимости',
            ],
            [
              'Аппарат',
              'Серийный/инвентарный номер, объект, отдел, место, покупка, гарантия, состояние',
              'Живая единица парка',
            ],
            [
              'Расходник',
              'Код, название, цвет, остаток, потребность',
              'Совместимость многие-ко-многим с моделями',
            ],
          ],
        },
        {
          type: 'bullets',
          items: [
            'Выключенная карточка не принимает новые заявки; открытые заявки сначала доводят или отменяют.',
            'Цветность показывается второй строкой у типа модели; «н/д» означает отсутствие подтверждённых данных, а не чёрно-белую печать.',
            'Серийный и инвентарный номера защищены от дублей; поиск в форме заявки выполняется на сервере.',
            'Справочник и история сохраняют мягкое удаление/архив; физическое удаление — отдельное административное право.',
          ],
        },
        {
          type: 'callout',
          title: 'Автоматический сбор наработки — не пользовательская функция текущей версии',
          body: 'SNMP/IPP, локальный коллектор, показания и статистика описаны планами и требуют пилота в сети объекта. Не ищите эти показатели в карточке, пока модуль не выпущен отдельно.',
          tone: 'gray',
        },
      ],
    },
    {
      title: 'Перемещения и агрегированная история',
      subtitle:
        'Текущее место — состояние карточки, каждое перемещение — отдельное событие с причиной.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Открыть аппарат из заявки или справочника и выбрать перемещение.',
            'Зафиксировать откуда, куда, дату, состояние, причину и комментарий.',
            'При заявленном расхождении подтвердить совпадение нового места с заявлением либо объяснить отличия.',
            'При конфликте обновить карточку: параллельное перемещение уже изменило исходную точку.',
          ],
        },
        {
          type: 'table',
          head: ['Блок истории', 'Что отвечает', 'Состояние волны'],
          widths: [1.8, 3.3, 2.2],
          rows: [
            [
              'Изменения',
              'Как менялись реквизиты карточки',
              'Контракты и сервер готовы; портал вводится',
            ],
            [
              'Перемещения',
              'Откуда → куда, дата, причина, состояние',
              'Вводится вместе с карточкой истории',
            ],
            ['Заявки', 'Обслуживание и расходники по аппарату', 'Серверная выборка готова'],
            [
              'Полная история',
              'Общий хронологический журнал и выгрузка',
              'Действующий запасной источник',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Не путать историю заявки и аппарата',
          body: 'Первая объясняет решения по одному обращению. Вторая собирает изменения, переезды и все заявки одной единицы. Ссылка из блока заявки открывает карточку исходного обращения.',
          tone: 'blue',
        },
      ],
    },
    {
      title: 'Гарантии',
      subtitle:
        'Есть гарантия единицы техники и гарантия результата ремонта/детали. Их источники и жизненный цикл различаются.',
      blocks: [
        {
          type: 'table',
          head: ['Гарантия', 'Источник даты', 'Где используется'],
          widths: [1.8, 3.0, 2.5],
          rows: [
            [
              'Техники',
              'Карточка аппарата / документы поставки',
              'Обращение «Гарантия на технику»',
            ],
            [
              'Ремонта или детали',
              'Обещанные месяцы + дата завершения либо дата талона',
              'Реестр гарантий и новая заявка по прошлой работе',
            ],
            [
              'Гарантийный талон',
              'Файл заявки с правильным видом',
              'Подтверждает срок и виден заявителю',
            ],
          ],
        },
        {
          type: 'bullets',
          items: [
            'Пограничный день считается действующим по единому календарю модуля.',
            'Возврат на доработку очищает даты результата; повторное закрытие требует новой проверки.',
            'Архивирование не должно расширять аудиторию и не должно стирать бизнес-факт выполненной работы.',
            'Отдельная волна ещё завершает исправление ошибочной даты, полный реестр, архив, выгрузку и предупреждения.',
          ],
        },
        {
          type: 'callout',
          title: 'Работайте по текущему экрану',
          body: 'Если в реестре нет фильтра, выгрузки или действия исправления даты, не подменяйте их обычной правкой заявки. Зафиксируйте ошибку и передайте оператору до выпуска гарантийной волны.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Обсуждение, письма и аудит',
      subtitle:
        'Обсуждение — адресная лента внутри заявки; почта — производное уведомление; история и аудит — доказательство действий.',
      blocks: [
        {
          type: 'table',
          head: ['Канал', 'Назначение', 'Не использовать как'],
          widths: [1.6, 3.3, 2.4],
          rows: [
            [
              'Обсуждение',
              'Вопросы и ответы участникам заявки, непрочитанные реплики',
              'Поле для финансовых строк вместо объёма работ',
            ],
            [
              'Документы',
              'Файлы с явным видом и правилами аудитории',
              'Комментарий без объяснения',
            ],
            [
              'История заявки',
              'Бизнес-события, причины, изменения и переходы',
              'Полный технический аудит системы',
            ],
            ['Почта', 'Оповещение адресатов о событии', 'Единственное подтверждение операции'],
          ],
        },
        { type: 'section', text: 'Почтовая волна' },
        {
          type: 'bullets',
          items: [
            'События переходов, объёма работ, документов, комментариев и кандидатов собраны через атомарную очередь.',
            'Новые виды остаются выключенными до проверки адресатов и живой отправки.',
            'Источник действия не получает бессмысленную копию; участники и копии считаются после блокировки заявки.',
            'Массовая операция формирует сводку, а не десятки одинаковых писем одному человеку.',
          ],
        },
        {
          type: 'callout',
          title: 'Если письмо не пришло',
          body: 'Операция могла завершиться успешно при выключенном событии или отсутствии адресата. Смотрите тост результата и карточку заявки; администратор проверяет исход уведомления и настройки события.',
          tone: 'orange',
        },
      ],
    },
    {
      title: 'Быстрые и массовые действия',
      subtitle:
        'Обе волны используют те же доменные проверки, что одиночные операции, и не расширяют права.',
      blocks: [
        {
          type: 'table',
          head: ['Механика', 'Что готово', 'Ограничение/запасной путь'],
          widths: [1.7, 3.25, 2.4],
          rows: [
            [
              'Статус как кнопка',
              'Быстрый вход в строке и карточке, причины неактивности, фокус/мобильность',
              'Пилот не завершён; меню «Действия» остаётся',
            ],
            [
              'Очистка меню',
              'Повторы сняты или перенесены к полю/статусу',
              'Часть волн ждёт наблюдения и приёмки',
            ],
            [
              'Массовые операции',
              'Отмена, пауза, возобновление, срочность, назначение, старт, приёмка, архив',
              'Выкат/пилот впереди; на телефоне полоса выбора не показывается',
            ],
            [
              'Отчёт пачки',
              'Построчный результат, повтор неудачных, восстановление по ключу',
              'Успех одних строк не откатывается из-за отказа других',
            ],
          ],
        },
        {
          type: 'callout',
          title: 'Что массово не делается',
          body: 'Закрытие работ, возврат на доработку, объём работ и административные откаты требуют строчных фактов, документов или разных причин. Их выполняют по одной заявке.',
          tone: 'red',
        },
        { type: 'section', text: 'Безопасность пачки' },
        {
          type: 'bullets',
          items: [
            'Выбираются только видимые строки текущего набора фильтров; смена области сбрасывает выбор.',
            'Каждая строка отправляется с версией; изменившаяся заявка получает отдельный отказ.',
            'Причина массового назначения, отмены, паузы и срочности относится ко всем выбранным строкам.',
            'До ввода волны выполняйте эти действия по одной заявке через обычные окна.',
          ],
        },
      ],
    },
    {
      title: 'Карта готовности рефакторинга',
      subtitle:
        'Состояние приведено по рабочему дереву на дату сверки, а не как обещание конкретного прод-контура.',
      blocks: [
        {
          type: 'table',
          head: ['Область', 'Состояние', 'Пользовательское правило'],
          widths: [2.05, 2.65, 2.65],
          rows: [
            [
              'Профили и аудитории карточки',
              'Ядро и портал реализованы',
              'Использовать новую матрицу ролей и скрытие финансов заявителю',
            ],
            [
              'Упрощённый цикл и объём работ',
              'Реализованы',
              'Не ждать старых статусов; смотреть сторону ожидания',
            ],
            [
              'Кандидаты техники',
              'Собраны, включение прав впереди',
              'Если окна нет — техподдержка',
            ],
            [
              'Быстрый статус и меню',
              'Код готов/частично введён, пилот не закрыт',
              'Искать то же действие в меню',
            ],
            ['Массовые операции', 'Код готов, выкат впереди', 'Пока по одной заявке'],
            [
              'Блоки истории',
              'Контракты/сервер готовы; портал и выгрузка в работе',
              'Полная история — запасной источник',
            ],
            [
              'Гарантийное завершение',
              'Инвентарь и тесты; изменения впереди',
              'Не обещать ещё невидимые действия',
            ],
            ['Повторные заявки / наработка', 'Планы', 'Не считать функциями текущей версии'],
          ],
          size: 7.7,
        },
        { type: 'section', text: 'Приёмка перед объявлением функции' },
        {
          type: 'bullets',
          items: [
            'Миграции накатаны, сервер и клиент совместимы, обязательные quality-ворота зелёные.',
            'Положительный и отрицательный сценарии проверены под каждым бизнес-профилем.',
            'Письма проверены на живых адресатах либо событие оставлено выключенным.',
            'Инструкция обновлена по фактическому экрану, а не только по плану.',
          ],
        },
      ],
    },
    {
      title: 'Диагностика и контрольный список',
      subtitle:
        'Большинство «пропавших кнопок» объясняется статусом, назначением, аудиторией или незавершённой волной.',
      blocks: [
        {
          type: 'steps',
          items: [
            'Обновить карточку и сверить версию, статус и подпись ожидания.',
            'Проверить профиль, область, назначение сотрудника/компании и аудиторию карточки.',
            'Посмотреть причину неактивного действия и обязательные документы.',
            'Проверить запасной вход: статус, нужное поле, вкладка или меню «Действия».',
            'Сверить карту готовности: не относится ли функция к невключённой или плановой волне.',
            'Передать поддержке номер заявки, действие, время, полный текст ошибки и безопасный скриншот.',
          ],
        },
        { type: 'section', text: 'Контроль оператора модуля' },
        {
          type: 'bullets',
          tone: 'green',
          items: [
            'Профили выданы корректно; сервисная учётка связана с правильным контрагентом.',
            'Нераспределённые, срочные и старые ожидания разбираются ежедневно.',
            'Внешняя работа не уходит в «Решена» без закрывающего документа.',
            'Кандидаты и почтовые события включаются только после приёмки соответствующей волны.',
            'Полная история и аудит используются при разборе спорных действий.',
            'Плановые функции не упоминаются пользователям как уже доступные.',
          ],
        },
        {
          type: 'callout',
          title: 'Единый источник истины',
          body: 'Права и подписи определяют контракты, фактическое состояние — сервер и база, доступное действие — текущая карточка. План объясняет направление, но не заменяет проверку выпущенного поведения.',
          tone: 'blue',
        },
      ],
    },
  ],
};

// ── Редакция 3: реальные экраны актуального приложения ─────────────────────────────────────

const visualPage = (title, subtitle, scene, notes, after = []) => ({
  title,
  subtitle,
  blocks: [],
  visual: { scene, notes, after },
});

requester.pages = [
  visualPage(
    'Создать заявку за один проход',
    'Орг.техника → Заявки → Создать заявку. На экране показана заполненная форма перед отправкой.',
    'create:requester',
    [
      {
        title: 'Опишите симптом',
        body: 'Что происходит, как часто повторяется и чему мешает. Пишите наблюдаемый результат, а не предполагаемую причину.',
      },
      {
        title: 'Проверьте заказчика',
        body: 'Выберите площадку или отдел, укажите имя и телефон человека, который покажет аппарат.',
        tone: 'purple',
      },
      {
        title: 'Обоснуйте срочность',
        body: 'Отметьте срочность только при остановке работы и заполните обязательную причину.',
        tone: 'orange',
      },
      {
        title: 'Приложите и отправьте',
        body: 'Добавьте фото ошибки или шильдика, проверьте форму и нажмите «Сохранить».',
        tone: 'green',
      },
    ],
    [
      { type: 'section', text: 'Перед отправкой' },
      {
        type: 'bullets',
        tone: 'green',
        items: [
          'Категория и аппарат выбраны верно; после отправки их не меняют.',
          '«Для кого заявка» — площадка или отдел, которому нужен аппарат.',
          'Имя и телефон должны вести к человеку, который покажет технику.',
        ],
      },
      {
        type: 'callout',
        title: 'Срочность — просьба, а не способ ускорить всё',
        body: 'Ставьте её только при реальной остановке работы и объясните причину. После создания срочность меняет служба.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Если аппарата нет в списке',
    'Сообщите об аппарате прямо из формы: укажите данные с шильдика и отправьте их вместе с заявкой.',
    'candidate:requester',
    [
      {
        title: 'Перепишите шильдик',
        body: 'Укажите тип и точную модель — без догадок и сокращений.',
      },
      {
        title: 'Добавьте номер',
        body: 'Достаточно серийного или инвентарного; фото шильдика ускоряет проверку.',
        tone: 'purple',
      },
      {
        title: 'Отправьте с заявкой',
        body: 'Появится пометка «Аппарат на проверке». Проверяющий свяжет запись или создаст карточку.',
        tone: 'green',
      },
    ],
    [
      { type: 'section', text: 'Как выбрать предмет обращения' },
      {
        type: 'cards',
        items: [
          {
            title: 'Перенос аппарата',
            body: 'Категория «Обслуживание». В описании укажите старое и новое место.',
            tone: 'blue',
          },
          {
            title: 'Гарантия поставщика',
            body: 'В форме выберите «Гарантия на технику», если срок ещё действует.',
            tone: 'purple',
          },
          {
            title: 'Гарантия ремонта',
            body: 'Создавайте обращение из вкладки «Гарантии» по нужной работе.',
            tone: 'green',
          },
          {
            title: 'Уже есть открытая заявка',
            body: 'Откройте её и допишите сведения в обсуждении — дубль портал не создаст.',
            tone: 'orange',
          },
        ],
      },
    ],
  ),
  visualPage(
    'Следить за заявкой в списке',
    'Поиск понимает номер заявки, модель и номера аппарата. Фильтр «Мои заявки» оставляет ваши обращения.',
    'list:requester',
    [
      {
        title: 'Сузьте список',
        body: 'Используйте «Мои заявки», рабочие статусы и поиск — выбранные фильтры сохраняются.',
      },
      {
        title: 'Читайте две подписи',
        body: 'Статус показывает состояние, «Ждёт …» — кто делает следующий шаг.',
        tone: 'orange',
      },
      {
        title: 'Откройте карточку',
        body: 'Повтор ×N ведёт к предыдущим обращениям; синяя метка показывает непрочитанное.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'flow',
        items: [
          { title: status('new'), body: 'распределение', tone: 'blue' },
          { title: status('in_work'), body: 'работа', tone: 'orange' },
          { title: status('done'), body: 'приёмка', tone: 'purple' },
          { title: status('accepted'), body: 'закрыто', tone: 'green' },
        ],
      },
      {
        type: 'bullets',
        items: [
          `«${status('on_hold')}» — пауза с причиной; «${status('cancelled')}» — окончательная отмена.`,
          'После назначения заявку нельзя править или удалить самостоятельно — напишите оператору.',
          'Повторное обращение ничего не запускает автоматически: это подсказка для проверки истории.',
        ],
      },
      {
        type: 'callout',
        title: '24 часа на проверку результата',
        body: `После перевода в «${status('done')}» проверьте работу. Через 24 часа без возражений портал принимает её автоматически; при проблеме сразу напишите в обсуждении.`,
        tone: 'blue',
      },
    ],
  ),
  visualPage(
    'Карточка, файлы и обсуждение',
    'Карточка заявителя показывает нужное для обращения и скрывает внутренний расчёт с исполнителем.',
    'card:requester',
    [
      {
        title: 'Три вкладки',
        body: 'Заявка, Документы и История. «Объём работ» и суммы заявителю не передаются.',
      },
      {
        title: 'Проверьте исполнителей',
        body: 'По полю видно, кто ведёт обращение и кому адресовать уточнение.',
        tone: 'purple',
      },
      {
        title: 'Пишите в обсуждении',
        body: 'Выберите доступного адресата. После закрытия переписка остаётся только для чтения.',
        tone: 'green',
      },
    ],
    [
      { type: 'section', text: 'Документы' },
      {
        type: 'bullets',
        items: [
          'Заявитель видит и добавляет обычные вложения; гарантийный талон виден, но добавляет его служба.',
          'Акт, счёт и файл объёма работ относятся к внутреннему расчёту и скрыты.',
          'Снять можно свой файл, пока заявка не закрыта и файл не используется в переходе.',
        ],
      },
      {
        type: 'callout',
        title: 'Почта только сообщает',
        body: 'Фактический статус, документы, причина паузы и ответы находятся в карточке. Отсутствие письма не означает, что действие не выполнено.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Исправить ошибку и обратиться повторно',
    'Действия зависят от статуса и назначения. Портал показывает только допустимые шаги.',
    'list:requester',
    [
      {
        title: 'Новая без исполнителя',
        body: 'Можно исправить описание, контакт и заказчика либо удалить заявку.',
      },
      {
        title: 'Работа уже началась',
        body: 'Попросите оператора отменить или вернуть на доработку; причину зафиксируйте в обсуждении.',
        tone: 'orange',
      },
      {
        title: 'Проблема вернулась',
        body: 'После закрытия создайте новую заявку. Метка «Повтор ×N» связывает её с историей.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Аппарат уже перенесли',
            body: 'Сообщите фактическое место. Перемещение подтверждает ИТ или оператор.',
            tone: 'purple',
          },
          {
            title: 'Результат не принят',
            body: `Пока статус «${status('done')}», напишите о недостатке — служба вернёт работу исполнителю.`,
            tone: 'red',
          },
          {
            title: 'Кнопки нет',
            body: 'Сверьте статус, назначение и профиль. Нередко действие находится у статуса или нужного поля.',
            tone: 'orange',
          },
          {
            title: 'Раздел не открывается',
            body: 'Обратитесь к администратору: доступ заявителя выдаётся профилем оргтехники.',
            tone: 'gray',
          },
        ],
      },
    ],
  ),
];

itGuide.pages = [
  visualPage(
    'Рабочая очередь ИТ',
    'Сначала «Ждут меня», затем срочные и самые старые ожидания. Статус и сторона ожидания — разные поля.',
    'list:it',
    [
      {
        title: 'Отберите очередь',
        body: 'Фильтры сохраняются. «Ждут меня» показывает заявки, где от вашего профиля требуется шаг; срочные собирает пресет «Срочные».',
      },
      {
        title: 'Проверьте ожидание',
        body: '«Новая» бывает и без исполнителя, и уже с назначенными исполнителями.',
        tone: 'orange',
      },
      {
        title: 'Откройте заявку',
        body: 'Повтор, срочность, возраст и непрочитанное видны до входа в карточку.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Координация',
            body: 'Сквозной просмотр, назначение, согласование, пауза, перемещение, массовые действия.',
            tone: 'purple',
          },
          {
            title: 'Исполнение',
            body: 'Старт, объём работ, файлы и закрытие — только для поимённо назначенного сотрудника.',
            tone: 'blue',
          },
        ],
      },
      {
        type: 'callout',
        title: 'Не расширяйте доступ до проверки назначения',
        body: 'Если рабочей кнопки нет, сначала сверяйте исполнителей, статус и причину блокировки.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Назначить исполнителей',
    'Состав меняется у поля «Исполнители» внутри карточки. Назначение само по себе не меняет статус.',
    'assign:it',
    [
      {
        title: 'Выберите сотрудников',
        body: 'Можно назначить нескольких своих сотрудников; они работают поимённо.',
      },
      {
        title: 'Добавьте сервис',
        body: 'Одновременно разрешена не более чем одна сервисная компания.',
        tone: 'purple',
      },
      {
        title: 'Объясните замену',
        body: 'При смене состава причина обязательна; новый исполнитель начнёт со статуса «Новая».',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Отказ сотрудника снимает только его строку; отказ сервисной компании снимает компанию целиком.',
          'Если отказался последний исполнитель, заявка снова ждёт распределения.',
          'Предъявленный объём работ сначала согласуйте либо верните в правку; во время ожидания состав не меняют.',
        ],
      },
      {
        type: 'callout',
        title: 'Назначение из карточки и массовый режим — разные вещи',
        body: 'Массового назначения в полосе выбора нет: состав допустимых исполнителей считается отдельно для каждой заявки.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Принять заявку и вести ход работ',
    'Назначенный сотрудник принимает заявку в работу. Остальные переходы доступны по коридору и правам.',
    'card:it',
    [
      {
        title: 'Откройте нужную вкладку',
        body: 'Карточка ИТ включает внутренние документы, а «Объём работ» — только у заявок, которые ведёт сервисная компания.',
      },
      {
        title: 'Сверьте состав',
        body: 'Одного права исполнителя недостаточно — ваша учётка должна быть назначена.',
        tone: 'purple',
      },
      {
        title: 'Фиксируйте общение',
        body: 'Телефон ускоряет работу, но результат и договорённость продублируйте в обсуждении.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'flow',
        items: [
          { title: status('new'), body: 'принять', tone: 'blue' },
          { title: status('in_work'), body: 'выполнить', tone: 'orange' },
          { title: status('done'), body: 'предъявить', tone: 'purple' },
          { title: status('accepted'), body: 'принято', tone: 'green' },
        ],
      },
      {
        type: 'bullets',
        items: [
          '«Отложить» требует причины и запоминает, куда вернуть заявку.',
          '«Отказаться от заявки» доступно до начала работы; после старта исполнитель сообщает оператору.',
          'ИТ не принимает собственную работу за заказчика и не ведёт парк без отдельного права.',
        ],
      },
    ],
  ),
  visualPage(
    'Объём работ и согласование',
    'Этап есть только у заявок, которые ведёт сервисная компания: исполнитель предъявляет ревизию, согласующий принимает именно показанную редакцию.',
    'estimate:it',
    [
      {
        title: 'Читайте состояние ревизии',
        body: 'Редактирование закрывается на время согласования.',
      },
      {
        title: 'Сверьте строки и сумму',
        body: 'Решение относится к конкретной ревизии; новая правка создаёт следующую.',
        tone: 'purple',
      },
      {
        title: 'Выберите решение',
        body: 'Согласовать, не согласовать с причиной или вернуть исполнителю в правку.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Заявку, которую ведёт свой сотрудник, объём работ не проходит: её закрывают датой выполнения и необязательным «Что сделали».',
          'Сервисная компания не согласует собственный расчёт; это делает ИТ или оператор.',
          'Несогласование закрывает заявку с причиной и решением по замене/дальнейшим действиям.',
          'Пустую ревизию всё равно нужно явно согласовать либо вернуть — молчание не решение.',
        ],
      },
      {
        type: 'callout',
        title: 'Статус остаётся «В работе»',
        body: 'Предъявление и согласование отражаются стороной ожидания и ревизией, а не отдельными рабочими статусами.',
        tone: 'blue',
      },
    ],
  ),
  visualPage(
    'Документы и закрытие работ',
    'Вид файла определяет видимость, гарантийный контур и возможность завершить внешнюю работу.',
    'documents:it',
    [
      {
        title: 'Назовите вид файла',
        body: 'Вложение, объём работ, акт, счёт или гарантийный талон — это не взаимозаменяемые метки.',
      },
      {
        title: 'Проверьте закрывающий файл',
        body: 'Для внешнего ремонта до «Решена» требуется хотя бы один закрывающий документ.',
        tone: 'purple',
      },
      {
        title: 'Закройте работы',
        body: 'По заявке сервисной компании — фактические строки, гарантию и рекомендации; по внутреннему ремонту — дату выполнения и «Что сделали».',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Акт, счёт и объём работ скрыты от заявителя; обычное вложение и гарантийный талон видны.',
          'Кандидат аппарата должен быть разобран до приёмки результата.',
          `В статусе «${status('done')}» оператор принимает работу либо возвращает её; через 24 часа возможна автоприёмка.`,
        ],
      },
      {
        type: 'callout',
        title: 'Удаление файла ограничено',
        body: 'Нельзя снять документ, который уже использован закрытием, гарантией или другим доменным действием.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Подтвердить перемещение',
    'Перемещение из заявки сверяет текущее и заявленное место под блокировкой и оставляет одну запись в истории.',
    'movement:it',
    [
      {
        title: 'Сверьте два места',
        body: 'Если аппарат уже переместили параллельно, портал покажет конфликт и новое исходное место.',
      },
      {
        title: 'Подтвердите заявление',
        body: 'Отметка связывает фактическое перемещение с расхождением, указанным в заявке.',
        tone: 'purple',
      },
      {
        title: 'Запишите движение',
        body: 'Новое место попадёт в карточку, заявку и историю аппарата одной операцией.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Кнопка живёт у реквизитов аппарата, пока заявка не закрыта и право на перемещение есть.',
          'Область доступа проверяется по исходному месту; чужой объект не открывается через карточку заявки.',
          'При споре сначала обновите карточку: сервер не даст записать движение от устаревшего места.',
        ],
      },
    ],
  ),
  visualPage(
    'Массовые действия и история аппарата',
    'Полоса выбора выполняет те же доменные команды, что одиночное меню, и возвращает отчёт по каждой строке.',
    'bulk:it',
    [
      {
        title: 'Выберите строки',
        body: 'Недоступный чекбокс объясняет причину. Смена области или набора фильтров сбрасывает выбор.',
      },
      {
        title: 'Запустите общую команду',
        body: 'Пауза, возобновление, срочность, старт, приёмка, отмена или архив — только где применимо.',
        tone: 'orange',
      },
    ],
    [
      { type: 'section', text: 'После операции' },
      {
        type: 'bullets',
        items: [
          'Частичный результат нормален: успешные строки применены, пропущенные перечислены с причиной.',
          'Одна общая причина относится ко всем строкам; массового назначения, объёма работ и закрытия работ нет.',
          'История аппарата открывается из справочника вкладками «Заявки», «Правки», «Перемещения», «Полная история».',
          'XLSX-выгрузка содержит те же четыре листа и подчиняется той же видимости.',
        ],
      },
      {
        type: 'callout',
        title: 'Если действие оборвалось',
        body: 'Не создавайте новую пачку вслепую: портал предлагает продолжить начатую операцию с тем же ключом и показывает итог.',
        tone: 'blue',
      },
    ],
  ),
];

serviceGuide.pages = [
  visualPage(
    'Очередь сервисной компании',
    'Сервис видит только заявки, назначенные его компании. Письмо сообщает о назначении, но доступ создаёт портал.',
    'list:service',
    [
      {
        title: 'Откройте «Ждут меня»',
        body: 'Проверьте новые назначения, срочность, место, контакт и приложенные фото.',
      },
      {
        title: 'Читайте ожидание',
        body: 'До старта статус остаётся «Новая», а подпись говорит «Ждёт исполнителя».',
        tone: 'orange',
      },
      {
        title: 'Примите заявку',
        body: 'Быстрая кнопка и меню «Действия» вызывают одну и ту же операцию.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Видно',
            body: 'Назначенные компании заявки, аппарат, контакт, файлы, история и адресованные сервису реплики.',
            tone: 'green',
          },
          {
            title: 'Не видно',
            body: 'Чужие заявки, внутренние учётки ИТ, административные справочники и неадресованные реплики.',
            tone: 'red',
          },
        ],
      },
      {
        type: 'callout',
        title: 'Адрес компании — не учётная запись',
        body: 'Уведомление приходит на общий ящик сервиса. Работайте в портале под своей учёткой, связанной с компанией.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Принять или отказаться',
    'До начала работ проверьте предмет, место, доступ и гарантийный источник.',
    'card:service',
    [
      {
        title: 'Откройте карточку',
        body: 'Сверьте модель, номера, фактическое место, заявителя и описание.',
      },
      {
        title: 'Сверьте назначение',
        body: 'Компания назначается целиком; отказ снимает всю компанию с заявки.',
        tone: 'purple',
      },
      {
        title: 'Свяжитесь с заявителем',
        body: 'Согласуйте доступ и время; итог договорённости запишите в обсуждении.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'steps',
        items: [
          'Готовы выполнять — нажмите «Принять в работу»: статус станет «В работе».',
          'Выполнить нельзя — «Отказаться от заявки» и укажите конкретную причину.',
          'После начала работ отказ этой кнопкой закрыт: сообщите оператору, чтобы он изменил состав.',
        ],
      },
      {
        type: 'callout',
        title: 'Не подменяйте аппарат',
        body: 'При расхождении серийного или инвентарного номера остановитесь и напишите оператору. Фактическое место фиксируйте в обсуждении.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Составить объём работ',
    'Строки — план работ и материалов. Предъявление создаёт ревизию и переводит ожидание к согласующему.',
    'estimate:service',
    [
      {
        title: 'Заполните строки',
        body: 'Название, количество, цена и сумма должны позволять понять, за что платят.',
      },
      {
        title: 'Проверьте итог',
        body: 'До предъявления сохраните черновик; после предъявления редакция запирается.',
        tone: 'purple',
      },
      {
        title: 'Предъявите',
        body: 'ИТ или оператор согласует, не согласует либо вернёт ревизию в правку.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Сервис не согласует собственный объём работ.',
          'Новая редакция после возврата получает следующий номер ревизии.',
          'Несогласование закрывает заявку и сохраняет причину и решение по дальнейшим действиям.',
        ],
      },
      {
        type: 'callout',
        title: 'Статус остаётся «В работе»',
        body: 'Этап согласования виден подписью «Ждёт согласования» и состоянием ревизии, а не отдельным статусом заявки.',
        tone: 'blue',
      },
    ],
  ),
  visualPage(
    'Подшить документы и закрыть работы',
    'Перед завершением внешнего ремонта добавьте закрывающий документ и заполните фактический результат.',
    'documents:service',
    [
      {
        title: 'Добавьте файлы',
        body: 'Выберите правильный вид: акт, счёт, гарантийный талон, объём работ или обычное вложение.',
      },
      {
        title: 'Проверьте планку',
        body: 'Хотя бы один закрывающий документ обязателен для внешнего ремонта.',
        tone: 'purple',
      },
      {
        title: 'Закройте работы',
        body: 'Запишите результат, факт по строкам, рекомендации и гарантию.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Для заявки на расходники укажите, что фактически выдано; движение склада записывается отдельно.',
          'Файл можно добавить позже, пока заявка открыта и право сохраняется.',
          'Удалить использованный закрывающий или гарантийный документ нельзя.',
        ],
      },
      {
        type: 'callout',
        title: 'Проверьте кандидата аппарата',
        body: 'Если заявка создана с пометкой «Аппарат на проверке», результат нельзя окончательно принять до решения проверяющего.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'После выполнения и гарантия',
    `В статусе «${status('done')}» результат ждёт приёмки. Новую гарантийную проблему оформляют из реестра гарантий.`,
    'warranty:service',
    [
      {
        title: 'Откройте гарантию ремонта',
        body: 'Кнопка создаёт новую заявку с точной ссылкой на исходную работу.',
        tone: 'green',
      },
      {
        title: 'Не путайте источники',
        body: 'Гарантия поставщика выбирается в обычной форме новой заявки.',
        tone: 'orange',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Приняли',
            body: 'Заявка закрыта; обсуждение и документы доступны только для чтения.',
            tone: 'green',
          },
          {
            title: 'Вернули',
            body: 'Заявка снова «В работе» у прежних исполнителей; устраните замечание.',
            tone: 'orange',
          },
          {
            title: 'Автоприёмка',
            body: 'Через 24 часа без возражений портал принимает результат автоматически.',
            tone: 'blue',
          },
          {
            title: 'Сломалось снова',
            body: 'Портал помечает повторную заявку «Повтор ×N»; метка не меняет маршрут.',
            tone: 'purple',
          },
        ],
      },
    ],
  ),
  visualPage(
    'Частые проблемы сервиса',
    'Перед обращением в поддержку обновите карточку и прочитайте причину недоступного действия.',
    'card:service',
    [
      {
        title: 'Карточка пропала',
        body: 'Проверьте, не сняли ли назначение вашей компании и не закрылась ли заявка.',
      },
      {
        title: 'Действие недоступно',
        body: 'Причина обычно в статусе, ожидании, незавершённой ревизии или обязательном документе.',
        tone: 'purple',
      },
      {
        title: 'Письмо не пришло',
        body: 'Проверьте очередь портала. События включаются раздельно и могут собираться в сводку.',
        tone: 'green',
      },
    ],
    [
      { type: 'section', text: 'Что передать оператору' },
      {
        type: 'bullets',
        items: [
          'Номер заявки, время действия и полный текст сообщения.',
          'Что ожидали сделать и в какой вкладке находились.',
          'Безопасный снимок экрана без паролей и чужих персональных данных.',
        ],
      },
      {
        type: 'callout',
        title: 'Источник истины — карточка',
        body: 'Телефон и почта помогают договориться, но статус, ревизия, документы и результат должны остаться в портале.',
        tone: 'blue',
      },
    ],
  ),
];

fullGuide.pages = [
  {
    title: 'Как пользоваться руководством',
    subtitle:
      'Актуальная версия модуля на момент публикации: заявки, парк, расходники, закупки, гарантии, история и массовые действия.',
    blocks: [
      {
        type: 'flow',
        items: [
          { title: 'Создать', body: 'описать потребность', tone: 'blue' },
          { title: 'Распределить', body: 'назначить исполнителя', tone: 'purple' },
          { title: 'Выполнить', body: 'работы и документы', tone: 'orange' },
          { title: 'Принять', body: 'результат и гарантия', tone: 'green' },
        ],
      },
      { type: 'section', text: 'Пять сущностей модуля' },
      {
        type: 'cards',
        items: [
          { title: 'Заявка', body: 'Процесс от обращения до принятого результата.', tone: 'blue' },
          {
            title: 'Аппарат',
            body: 'Карточка парка, модель, место, гарантия и история.',
            tone: 'green',
          },
          {
            title: 'Кандидат',
            body: 'Сообщение об отсутствующем аппарате до решения проверяющего.',
            tone: 'purple',
          },
          {
            title: 'Расходник',
            body: 'Номенклатура, совместимость, потребность и движение остатка.',
            tone: 'orange',
          },
          {
            title: 'План закупки',
            body: 'Самостоятельный документ; проведение не меняет остаток склада.',
            tone: 'gray',
          },
          {
            title: 'Гарантия',
            body: 'Поставщик аппарата или конкретная выполненная работа.',
            tone: 'red',
          },
        ],
      },
      { type: 'section', text: 'Как читать интерфейс' },
      {
        type: 'bullets',
        items: [
          'Статус отвечает «где заявка», подпись ожидания — «кто делает следующий шаг».',
          'Доступное действие определяется профилем, областью, назначением, статусом и содержимым заявки.',
          'Главное действие находится у статуса или связанного поля; остальные собраны в меню «Действия».',
          'Портал и сервер — источник истины; письмо только уведомляет.',
        ],
      },
      {
        type: 'callout',
        title: 'Граница руководства',
        body: 'Документ начинается с уже открытого раздела «Орг.техника» и описывает только работу с заявками, парком, расходниками и гарантиями.',
        tone: 'blue',
      },
    ],
  },
  {
    title: 'Профили и область доступа',
    subtitle:
      'Права отвечают за действие, область — за строки, назначение — за право исполнить конкретную заявку.',
    blocks: [
      {
        type: 'table',
        head: ['Профиль', 'Видит', 'Главные действия'],
        widths: [1.5, 2.65, 3.2],
        rows: [
          [
            'Заявитель',
            'Свои и доступные по области заявки; без внутренних сумм',
            'Создать, ограниченно править/удалить, файлы и обсуждение',
          ],
          [
            'Оператор',
            'Заявки своей области; рабочие и финансовые данные',
            'Распределить, срочность, пауза, отмена, приёмка, парк',
          ],
          [
            'ИТ-служба',
            'Сквозная координация; исполнение при назначении',
            'Назначить, согласовать, выполнить, переместить, массовые действия',
          ],
          [
            'Сервисная компания',
            'Только назначенные компании заявки',
            'Принять/отказаться, объём работ, документы, закрытие',
          ],
          ['Наблюдатель', 'Разрешённые строки без ведения', 'Только чтение'],
        ],
      },
      { type: 'section', text: 'Четыре проверки перед поиском «пропавшей» кнопки' },
      {
        type: 'steps',
        items: [
          'Есть ли у учётки нужный профиль оргтехники.',
          'Попадает ли заявка или аппарат в область учётки.',
          'Назначен ли сотрудник либо сервисная компания на эту заявку.',
          'Разрешено ли действие текущим статусом, ожиданием и документами.',
        ],
      },
      {
        type: 'callout',
        title: 'Сервисный доступ устроен иначе',
        body: 'Сервисному центру не выдают внутренние профили оргтехники: его область возникает из назначения контрагента на заявку.',
        tone: 'orange',
      },
    ],
  },
  visualPage(
    'Навигация, поиск и очереди',
    'Основные вкладки: Заявки, Техника, Расходники, Гарантии; состав зависит от профиля.',
    'list:it',
    [
      {
        title: 'Фильтруйте список',
        body: 'Поиск, рабочая/закрытая очередь, статус, категория, исполнитель, объект и «Ждут меня».',
      },
      {
        title: 'Читайте строку целиком',
        body: 'Номер, аппарат, статус, ожидание, срочность, повтор и непрочитанное отвечают на разные вопросы.',
        tone: 'orange',
      },
      {
        title: 'Открывайте карточку',
        body: 'Строка ведёт в детальный экран; действия строки доступны также с клавиатуры и телефона.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Фильтры сохраняются между открытиями; режим «Предыдущие заявки» у повтора — отдельный режим списка.',
          'Порядок строк задаёт выбранная сортировка: срочные наверх не поднимаются, их собирают пресет «Срочные» и отбор.',
          'Закрытые и отменённые записи не должны смешиваться с рабочей очередью.',
          'На телефоне создание и действия показываются крупными кнопками или нижней панелью.',
        ],
      },
    ],
  ),
  visualPage(
    'Создание и правка заявки',
    'На снимке — нижняя часть заполненной формы: описание, заказчик, контакт, срочность и вложения.',
    'create:requester',
    [
      { title: 'Описание', body: 'Зафиксируйте симптом, частоту и влияние на работу.' },
      {
        title: 'Заказчик и контакт',
        body: 'Площадка/отдел, имя и телефон фиксируются снимком заявки.',
        tone: 'purple',
      },
      {
        title: 'Срочность',
        body: 'Причина обязательна и должна объяснять остановку работы.',
        tone: 'orange',
      },
      {
        title: 'Фото и отправка',
        body: 'Приложите подтверждение, проверьте форму и сохраните заявку.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'При правке аппарат и категорию не меняют; срочность требует отдельного права.',
          'Заявитель правит новую неназначенную заявку и удаляет её до начала работы.',
          'Вложения после создания добавляются на вкладке «Документы».',
        ],
      },
    ],
  ),
  visualPage(
    'Аппарат, кандидат или отсутствие',
    'Предмет заявки — карточка парка, сообщение на проверку либо заявка без аппарата при специальном праве.',
    'candidate:requester',
    [
      { title: 'Опишите аппарат', body: 'Тип и точная модель с шильдика.' },
      {
        title: 'Дайте идентификатор',
        body: 'Серийный/инвентарный номер и фото защищают от дубля.',
        tone: 'purple',
      },
      {
        title: 'Дождитесь решения',
        body: 'Связать с найденной карточкой, создать новую либо отклонить сообщение.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Карточка парка',
            body: 'Обычный путь: место и модель берутся из справочника.',
            tone: 'green',
          },
          {
            title: 'Кандидат',
            body: 'Живёт рядом с заявкой и блокирует окончательную приёмку, пока не разобран.',
            tone: 'purple',
          },
          {
            title: 'Без аппарата',
            body: 'Отдельное право службы/ИТ; заказчик обязателен.',
            tone: 'blue',
          },
          {
            title: 'Дубликат',
            body: 'Портал предлагает найденную карточку или открытую заявку.',
            tone: 'orange',
          },
        ],
      },
    ],
  ),
  {
    title: 'Статусы и стороны ожидания',
    subtitle: 'Живых статусов шесть; назначение и согласование показаны признаками и ожиданием.',
    blocks: [
      {
        type: 'flow',
        items: [
          { title: status('new'), body: 'распределить / старт', tone: 'blue' },
          { title: status('in_work'), body: 'работа / согласование', tone: 'orange' },
          { title: status('done'), body: 'приёмка', tone: 'purple' },
          { title: status('accepted'), body: 'завершено', tone: 'green' },
        ],
      },
      {
        type: 'table',
        head: ['Статус', 'Ожидание', 'Допустимый смысл'],
        widths: [1.25, 2.05, 4.05],
        rows: [
          [
            status('new'),
            'Оператор / исполнитель',
            'Нет назначения либо назначенный ещё не принял',
          ],
          [
            status('in_work'),
            'Исполнитель / согласование',
            'Работа, подготовка или решение по предъявленной ревизии',
          ],
          [
            status('on_hold'),
            'Отложена',
            'Пауза с обязательной причиной и сохранённой дугой возврата',
          ],
          [
            status('done'),
            'Оператор / 24 часа',
            'Результат предъявлен; принять, вернуть или дождаться автоприёмки',
          ],
          [status('accepted'), 'Никто', 'Работа принята; только чтение и гарантийное обращение'],
          [status('cancelled'), 'Никто', 'Заявка отменена с причиной'],
        ],
      },
      {
        type: 'callout',
        title: 'Старые статусы остаются только в истории',
        body: '«Согласована ИТ», «Назначена», «Диагностика» и «Смета на согласовании» не используются для новых переходов.',
        tone: 'gray',
      },
    ],
  },
  visualPage(
    'Фильтры, повтор и предыдущие заявки',
    'Повторное обращение — наблюдение за недавними ремонтами того же аппарата, а не автоматический маршрут.',
    'list:it',
    [
      {
        title: 'Найдите свою очередь',
        body: '«Ждут меня» и сохранённые фильтры сокращают ежедневный просмотр.',
      },
      {
        title: 'Откройте повтор',
        body: '«Повтор ×N» показывает число предыдущих обращений в периоде и ссылку на них.',
        tone: 'orange',
      },
      {
        title: 'Работайте с заявкой',
        body: 'Метка не меняет срочность, исполнителя, статус и гарантию.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Повтор считается только для обслуживания; совместимость сегодня означает тот же вид заявки.',
          'Ссылка «Предыдущие заявки по аппарату» открывает режим списка с тем же правилом периода.',
          'Возраст рядом со статусом считается в текущем ожидании, а не от даты создания целиком.',
        ],
      },
    ],
  ),
  visualPage(
    'Карточка и аудитории',
    'Один экран собирается сервером по аудитории; скрытые суммы не попадают в ответ заявителю.',
    'card:requester',
    [
      {
        title: 'Вкладки по аудитории',
        body: 'Заявителю — Заявка, Документы, История; «Объём работ» добавляется службе и исполнителю только у заявок сервисной компании. У расходников обе стороны видят «Расходники».',
      },
      {
        title: 'Исполнители и место',
        body: 'Поле состава и реквизиты аппарата — основные точки координации.',
        tone: 'purple',
      },
      {
        title: 'Обсуждение',
        body: 'Адресат — пометка получателя; непрочитанное считается по ленте.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Заявитель не получает стоимость, акт, счёт и служебные поля даже через API.',
          'История заявки показывает переходы, причины, назначения, документы, переписку и перемещение.',
          'После закрытия карточка, файлы и обсуждение доступны только для чтения.',
        ],
      },
    ],
  ),
  visualPage(
    'Назначение исполнителей',
    'Поимённые сотрудники и одна сервисная компания составляют единую команду заявки.',
    'assign:it',
    [
      {
        title: 'Сотрудники',
        body: 'Несколько внутренних исполнителей; действие требует назначения конкретной учётки.',
      },
      {
        title: 'Сервис',
        body: 'Не более одной компании; отказ компании снимает всю её сторону.',
        tone: 'purple',
      },
      {
        title: 'Причина изменения',
        body: 'При замене состава обязательна и попадает в историю и аудит.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Первое назначение не меняет статус «Новая».',
          'Переназначение из «В работе» возвращает новую сторону к «Новой» и очищает несогласованный объём.',
          'Во время предъявленной ревизии состав не меняют: сначала решение по ней.',
        ],
      },
    ],
  ),
  visualPage(
    'Работа исполнителя и действия',
    'Статус открывает переходы, поле — предметное действие, меню — остальные допустимые операции.',
    'card:it',
    [
      {
        title: 'Статус',
        body: 'Нажатие показывает допустимые переходы с названием результата и действия.',
      },
      {
        title: 'Предметные входы',
        body: 'Исполнители, перемещение и решения объёма работ находятся рядом со своими данными.',
        tone: 'purple',
      },
      {
        title: 'Меню действий',
        body: 'Пауза, срочность, отмена, обсуждение и прочие операции не дублируются.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'cards',
        items: [
          {
            title: 'Принять в работу',
            body: 'Только назначенный исполнитель; «Новая» → «В работе».',
            tone: 'blue',
          },
          {
            title: 'Отложить',
            body: 'Причина обязательна; возобновление вернёт сохранённый статус.',
            tone: 'orange',
          },
          {
            title: 'Закрыть работы',
            body: 'Сервис — факт, документы и гарантия; свой сотрудник — дата и «Что сделали». «В работе» → «Решена».',
            tone: 'green',
          },
          {
            title: 'Отменить',
            body: 'Операторский коридор с причиной; снимает исполнителей.',
            tone: 'red',
          },
        ],
      },
    ],
  ),
  visualPage(
    'Объём работ и ревизии',
    'Исполнитель предъявляет редакцию, согласующий принимает именно эту версию.',
    'estimate:it',
    [
      {
        title: 'Состояние редакции',
        body: 'Черновик, предъявлена, согласована, не согласована или возвращена в правку.',
      },
      {
        title: 'Строки и сумма',
        body: 'План и итог видны только внутренней аудитории и назначенному сервису.',
        tone: 'purple',
      },
      {
        title: 'Решение',
        body: 'Согласовать, не согласовать с причиной или вернуть в правку.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Объём работ ведут только по заявкам сервисной компании; внутренний ремонт этого этапа не проходит.',
          'Сервис не подписывает собственную редакцию.',
          'Согласование и предъявление не требуют отдельных статусов заявки.',
          'Несогласование закрывает заявку и фиксирует решение по замене или дальнейшим действиям.',
        ],
      },
    ],
  ),
  visualPage(
    'Документы, результат и приёмка',
    'Вид документа задаёт видимость и доменные ограничения.',
    'documents:it',
    [
      {
        title: 'Загрузите с видом',
        body: 'Вложение, объём работ, акт, счёт или гарантийный талон.',
      },
      {
        title: 'Закройте планку',
        body: 'Внешний ремонт требует закрывающего документа до статуса «Решена».',
        tone: 'purple',
      },
      {
        title: 'Предъявите результат',
        body: 'Внешний ремонт — факт, рекомендации и гарантия; внутренний — дата и «Что сделали». Затем приёмка или доработка.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Гарантийный талон виден заявителю; акт, счёт и объём работ скрыты.',
          'Автоприёмка — через 24 часа в «Решена», если нет блокировки и возврата.',
          'Непроверенный кандидат аппарата блокирует окончательную приёмку.',
        ],
      },
    ],
  ),
  visualPage(
    'Обсуждение, письма и аудит',
    'Лента заявки, почтовые события и аудит отвечают на три разных вопроса.',
    'card:it',
    [
      {
        title: 'Обсуждение',
        body: 'Реплики идут лентой; адресат — пометка, удаление и правка не предусмотрены.',
      },
      {
        title: 'Аудитория письма',
        body: 'Тело зависит от получателя; сервису не уходят чужие реплики и внутренние суммы.',
        tone: 'purple',
      },
      {
        title: 'История и аудит',
        body: 'История объясняет бизнес-ход, аудит — кто и когда вызвал команду.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Семь почтовых событий включаются раздельно; частые события могут собираться в сводку.',
          'Актор события исключается как источник, а общий ящик сервиса получает только разрешённую аудиторию.',
          'Если письмо не пришло, проверьте карточку и статус события у администратора.',
        ],
      },
    ],
  ),
  visualPage(
    'Расходники: номенклатура и остаток',
    'Модель аппарата, совместимость, складской остаток, потребность и заказанное — разные данные.',
    'consumables:it',
    [
      {
        title: 'Смотрите остаток и дефицит',
        body: 'Потребность учитывает заявки и уже заказанное, но не меняет склад.',
      },
      {
        title: 'Открывайте журнал',
        body: 'Каждая ручная правка и выдача по заявке оставляет отдельное движение.',
        tone: 'purple',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Заявитель описывает потребность словами; состав расходников заявки заполняет исполнитель.',
          'Цвет — свободная характеристика позиции; совместимость связывает расходник с моделью аппарата.',
          'Остаток меняется событием с причиной, а не редактированием голого числа.',
          'Факт выдачи из заявки и ручная корректировка различаются в журнале.',
        ],
      },
    ],
  ),
  visualPage(
    'Плановая закупка',
    'Закупка проходит четыре состояния; проведение фиксирует заказ, а не приход на склад.',
    'purchase:open',
    [
      {
        title: 'Соберите строки',
        body: 'Портал показывает остаток, потребность и уже заказанное для расчёта дефицита.',
      },
      {
        title: 'Проведите документ',
        body: 'Черновик редактируется; проведённый документ защищён версией и меняет показатель «заказано».',
        tone: 'orange',
      },
    ],
    [
      {
        type: 'flow',
        items: [
          { title: 'Черновик', body: 'можно править', tone: 'gray' },
          { title: 'Проведена', body: 'заказ учтён', tone: 'blue' },
          { title: 'Получена', body: 'приход отражён отдельно', tone: 'purple' },
          { title: 'Закрыта', body: 'документ завершён', tone: 'green' },
        ],
      },
      {
        type: 'callout',
        title: 'Закупка не пополняет остаток автоматически',
        body: 'Приёмку и складское движение фиксируют отдельно; это защищает от чисел, которых физически ещё нет.',
        tone: 'orange',
      },
    ],
  ),
  visualPage(
    'Парк, модели и характеристики',
    'Карточка единицы ссылается на тип и модель; характеристики печати принадлежат модели.',
    'equipment:it',
    [
      {
        title: 'Карточка единицы',
        body: 'Номера, состояние, место, ответственное лицо и гарантия.',
      },
      {
        title: 'Действия рядом',
        body: 'История, перемещение и редактирование показываются по отдельным правам.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Модель существует независимо от парка и уникальна внутри типа техники.',
          'Цветность печати, формат и другие ТТХ — характеристики модели, а не произвольные поля карточки.',
          'Списание/архив не стирает прошлые заявки, движения и гарантии.',
          'Импорт справочника проверяет ссылки на типы и модели до записи.',
        ],
      },
    ],
  ),
  visualPage(
    'Перемещение из заявки',
    'Фактическое движение подтверждает человек с отдельным правом; место сверяется в транзакции.',
    'movement:it',
    [
      {
        title: 'Сверьте источник',
        body: 'Текущее место в карточке и место, заявленное в обращении.',
      },
      {
        title: 'Отметьте разбор',
        body: 'Подтверждение связывает движение с расхождением по месту.',
        tone: 'purple',
      },
      {
        title: 'Запишите новое место',
        body: 'Карточка и история меняются одной операцией; конфликт требует обновления.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Кнопка живёт у реквизитов аппарата, а не в общем меню заявки.',
          'Область проверяется по исходному месту и не расширяется карточкой заявки.',
          'Ручное перемещение из справочника использует тот же замок и ту же историю.',
        ],
      },
    ],
  ),
  visualPage(
    'История аппарата и выгрузка',
    'Три бизнес-блока и полная лента читают одни канонические события.',
    'history:moves',
    [
      {
        title: 'Выберите вопрос',
        body: 'Заявки, Правки, Перемещения или Полная история — у каждого блока свой порядок.',
      },
      {
        title: 'Скачайте книгу',
        body: 'XLSX содержит четыре листа с теми же данными и той же областью доступа.',
        tone: 'green',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'В блоке заявок одна заявка занимает одну строку с итогом, исполнителем и гарантией.',
          'Правки показывают жизненный цикл и гарантийные изменения; перемещения — откуда, куда и связь с заявкой.',
          'Полная история остаётся каноном при споре; блоки — удобные представления над ней.',
          'История заявки и история аппарата различаются: первая про процесс, вторая — про единицу парка.',
        ],
      },
    ],
  ),
  visualPage(
    'Гарантии',
    'Источник обращения определяет маршрут: гарантия поставщика аппарата или гарантия конкретной работы.',
    'warranty:it',
    [
      {
        title: 'Гарантия ремонта',
        body: 'Создаётся из реестра и переносит точную ссылку на исходную позицию работы.',
        tone: 'green',
      },
      {
        title: 'Гарантия поставщика',
        body: 'Выбирается при заведении обслуживания на конкретный аппарат.',
        tone: 'orange',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Перед платным выездом исполнитель обязан сверить активный гарантийный источник.',
          'Гарантийная работа не стирает исходную заявку и получает собственный цикл.',
          'Срок и условия гарантии фиксируются при закрытии работ и видны в реестре.',
          'Истёкшая гарантия остаётся в истории, но не открывает гарантийный маршрут.',
        ],
      },
    ],
  ),
  visualPage(
    'Массовые действия',
    'Пакетная команда повторяет одиночные правила и даёт построчный отчёт вместо общего отката.',
    'bulk:it',
    [
      {
        title: 'Выберите допустимые строки',
        body: 'Каждая строка несёт версию; недоступность объясняется до запуска.',
      },
      {
        title: 'Выполните общую команду',
        body: 'Применимые строки проходят, остальные возвращаются в отчёте с причиной.',
        tone: 'orange',
      },
    ],
    [
      {
        type: 'bullets',
        items: [
          'Доступны пауза/возобновление, срочность, старт, приёмка, отмена и архив — по правам и состоянию.',
          'Нет массового назначения, закрытия работ, объёма работ и возврата на доработку.',
          'Одна причина честно относится ко всем выбранным строкам; аудит остаётся построчным.',
          'Незавершённая пачка принадлежит учётке, которая её начала, и продолжается после обрыва.',
        ],
      },
    ],
  ),
  {
    title: 'Диагностика и контрольный список',
    subtitle: 'Проверяйте состояние данных до обращения в поддержку или повторной операции.',
    blocks: [
      {
        type: 'steps',
        items: [
          'Обновить карточку; сверить статус, ожидание, версию и исполнителей.',
          'Проверить профиль, область и наличие поимённого назначения.',
          'Прочитать причину недоступного действия и проверить обязательный документ/кандидата.',
          'Искать основной вход у статуса, нужного поля, вкладки или меню «Действия».',
          'Для пакета открыть отчёт и продолжить прежнюю операцию, не запускать дубль.',
          'Передать поддержке номер, время, действие, текст ошибки и безопасный снимок.',
        ],
      },
      { type: 'section', text: 'Ежедневный контроль модуля' },
      {
        type: 'cards',
        items: [
          {
            title: 'Очереди',
            body: 'Нераспределённые, срочные и старые ожидания разобраны.',
            tone: 'blue',
          },
          {
            title: 'Документы',
            body: 'Внешняя работа не закрыта без подтверждения.',
            tone: 'green',
          },
          {
            title: 'Кандидаты',
            body: 'Новые сообщения связаны, созданы или отклонены.',
            tone: 'purple',
          },
          { title: 'Склад', body: 'Выдачи, корректировки и закупки не смешаны.', tone: 'orange' },
        ],
      },
      {
        type: 'callout',
        title: 'Единый источник истины',
        body: 'Подписи берутся из контрактов, фактическое состояние — из сервера, разрешённое действие — из текущей карточки. Документ объясняет интерфейс, но не подменяет его проверку.',
        tone: 'blue',
      },
    ],
  },
];

const built = [];
for (const guide of [requester, itGuide, fullGuide, serviceGuide]) {
  built.push(...(await buildGuide(guide)));
}
process.stdout.write(`${built.map((file) => basename(file)).join('\n')}\n`);
