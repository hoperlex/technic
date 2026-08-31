import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Инструкция_Оргтехника_и_заявки.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'office-equipment-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 16;

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
  const factor = weight >= 600 ? 0.585 : 0.55;
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

function pill(x, y, label, options = {}) {
  const {
    fill = C.blueSoft,
    color = C.blue,
    stroke = 'none',
    size = 14,
    pad = 10,
    weight = 600,
  } = options;
  const width = Math.max(42, label.length * size * 0.59 + pad * 2);
  return {
    width,
    svg:
      rect(x, y, width, size + 16, { fill, stroke, r: (size + 16) / 2 }) +
      text(x + width / 2, y + size + 1, label, size, {
        fill: color,
        weight,
        anchor: 'middle',
      }),
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
  if (suffix) output += text(x + width - 12, top + height / 2 + 6, suffix, 14, { fill: C.muted, anchor: 'end' });
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
  let output = circle(x + 7, y - 5, 9, { fill: checkmark ? color : `${color}18`, stroke: color, sw: 1 });
  if (checkmark) output += check(x + 1, y - 5, '#fff');
  else output += circle(x + 7, y - 5, 3, { fill: color });
  output += paragraph(x + 28, y, value, width - 28, size, {
    fill: C.text,
    lineHeight,
    weight,
  });
  return output;
}

function callout(x, y, width, height, number, titleValue, body, options = {}) {
  const {
    fill = '#fff',
    stroke = C.line,
    dotFill = C.blue,
    titleColor = C.ink,
  } = options;
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
  if (subtitle) output += paragraph(55, 160, subtitle, 1005, 16, { fill: C.muted, lineHeight: 23, maxLines: 2 });
  return output;
}

function footer(label = 'Инструкция • оргтехника и заявки • 31.08.2026') {
  return (
    line(55, 1530, 1068, 1530, { stroke: C.line }) +
    text(55, 1560, label, 14, { fill: C.faint }) +
    text(1068, 1560, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 })
  );
}

function appShell(x, y, width, height, active = 'Справочники') {
  const side = 178;
  const items = [
    ['▱', 'Заявки'],
    ['▤', 'Путевые листы'],
    ['▦', 'Справочники'],
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
    output += text(x + 55, yy, label, 14, {
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
    if (selected) output += line(xx + 2, y + 17, xx + tabWidth - 2, y + 17, { stroke: C.blue, sw: 3 });
    xx += tabWidth + 5;
  }
  output += line(x, y + 18, x + width, y + 18, { stroke: C.line });
  return output;
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
  let output = rect(x, y, widths.reduce((sum, value) => sum + value, 0), height, {
    fill: options.fill ?? '#fff',
    stroke: C.line,
  });
  let xx = x;
  values.forEach((value, i) => {
    output += paragraph(xx + 10, y + 25, value, widths[i] - 20, options.size ?? 12, {
      fill: options.colors?.[i] ?? C.text,
      weight: options.weights?.[i] ?? 400,
      lineHeight: 17,
      maxLines: 2,
    });
    xx += widths[i];
    if (i < values.length - 1) output += line(xx, y, xx, y + height, { stroke: C.line });
  });
  return output;
}

function sectionLabel(x, y, label, options = {}) {
  const p = pill(x, y, label.toUpperCase(), {
    fill: options.fill ?? C.blueSoft,
    color: options.color ?? C.blue,
    size: 12,
    pad: 10,
  });
  return p.svg;
}

function page1() {
  let b = circle(76, 82, 30, { fill: C.blue });
  b += text(76, 93, 'A', 35, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(121, 73, 'АВТО • ОРГТЕХНИКА • SERVICE DESK', 16, {
    fill: C.blue,
    weight: 700,
    letter: 1.45,
  });
  b += text(121, 103, 'Пользовательская инструкция', 18, { fill: C.muted });
  const release = pill(867, 59, 'ЦЕЛЕВОЙ ФЛОУ', {
    fill: C.greenSoft,
    color: C.green,
    stroke: '#b7eb8f',
    size: 13,
    pad: 13,
  });
  b += release.svg;

  b += text(55, 212, 'Оргтехника', 64, { fill: C.ink, weight: 750 });
  b += text(55, 286, 'справочники и заявки', 58, { fill: C.ink, weight: 750 });
  b += paragraph(
    58,
    344,
    'Как вести парк аппаратов, подбирать картриджи, контролировать остаток и проводить заявку по обновлённому жизненному циклу.',
    950,
    24,
    { fill: C.muted, lineHeight: 35 },
  );

  b += rect(55, 452, 1013, 590, { fill: C.bg, stroke: C.line, r: 18 });
  const centers = [225, 560, 895];
  const cards = [
    {
      n: '1',
      color: C.blue,
      soft: C.blueSoft,
      title: 'Справочники',
      body: 'Типы, модели, карточки техники, фильтры и перемещения — единая система без свободного ввода модели.',
      tag: 'ПАРК',
    },
    {
      n: '2',
      color: C.purple,
      soft: C.purpleSoft,
      title: 'Расходники',
      body: 'Коды, цвета, совместимые модели, наличие, дата последней ручной правки и своё окно с историей движений.',
      tag: 'СКЛАД',
    },
    {
      n: '3',
      color: C.orange,
      soft: C.orangeSoft,
      title: 'Новый цикл',
      body: 'Поимённые исполнители, виза ИТ по смете, обсуждение заявки, заморозка, очереди и автозакрытие.',
      tag: 'ЗАЯВКИ',
    },
  ];
  cards.forEach((card, i) => {
    const x = 78 + i * 335;
    b += rect(x, 492, 300, 500, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += circle(x + 52, 553, 30, { fill: card.color });
    b += text(x + 52, 564, card.n, 29, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += sectionLabel(x + 26, 618, card.tag, { fill: card.soft, color: card.color });
    b += text(x + 26, 692, card.title, 28, { fill: C.ink, weight: 700 });
    b += paragraph(x + 26, 742, card.body, 248, 18, { fill: C.muted, lineHeight: 28 });
    b += line(x + 26, 903, x + 274, 903, { stroke: C.line });
    b += text(x + 26, 943, i === 0 ? 'Справочники → Оргтехника' : i === 1 ? 'Картриджи и тонеры' : 'Орг.техника → Заявки', 14, {
      fill: card.color,
      weight: 600,
    });
  });
  b += arrow(353, 742, 405, 742, { stroke: C.faint, sw: 2 });
  b += arrow(688, 742, 740, 742, { stroke: C.faint, sw: 2 });

  b += rect(55, 1095, 1013, 260, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(82, 1140, 'Кому пригодится', 21, { fill: C.ink, weight: 700 });
  b += bullet(82, 1191, 'Оператору оргтехники — вести парк, распределять и принимать заявки.', 450, { color: C.blue, size: 16, lineHeight: 23 });
  b += bullet(82, 1260, 'ИТ-службе — исполнять назначенные заявки и визировать сметы.', 450, { color: C.purple, size: 16, lineHeight: 23 });
  b += bullet(565, 1191, 'Ответственному за номенклатуру — вести картриджи и совместимость.', 450, { color: C.green, size: 16, lineHeight: 23 });
  b += bullet(565, 1260, 'Кладовщику — корректировать наличие с обязательной причиной.', 450, { color: C.orange, size: 16, lineHeight: 23 });

  b += text(55, 1435, 'Редакция: 31 августа 2026', 15, { fill: C.faint });
  b += text(1068, 1435, '16 страниц', 15, { fill: C.faint, anchor: 'end' });
  b += footer('Пользовательская инструкция • 31.08.2026');
  return document(b);
}

function page2() {
  let b = header(
    2,
    'Что изменилось',
    '1. Карта обновления',
    'Три больших изменения связаны между собой: модель связывает карточку техники с подходящим расходником, а заявка описывает работу с этой техникой. Внизу — что добавилось в этом выпуске.',
  );

  const blocks = [
    {
      y: 232,
      n: 'A',
      title: 'Модели стали отдельным справочником',
      color: C.blue,
      soft: C.blueSoft,
      points: [
        'В карточке техники модель выбирается из перечня — опечатки больше не создают «новую модель».',
        'Переименование модели обновляет связанные карточки; тип заведённой модели не меняется.',
        'Срез «Без расходника» показывает, для каких моделей ещё не настроен подбор.',
      ],
    },
    {
      y: 532,
      n: 'B',
      title: 'Картриджи и тонеры получили складской контур',
      color: C.purple,
      soft: C.purpleSoft,
      points: [
        'Позиция хранит код, наименование, цвет и совместимые модели аппаратов.',
        'Остаток не редактируется в карточке: каждое изменение — событие с причиной и автором.',
        'В карточке аппарата сразу видно «чем заправлять» и есть ли позиция на складе.',
      ],
    },
    {
      y: 832,
      n: 'C',
      title: 'Заявка говорит языком реальной работы',
      color: C.orange,
      soft: C.orangeSoft,
      points: [
        'Единый путь: Новая → Назначена → В работе → Решена → Закрыта; смета — ветка обслуживания.',
        'Можно назначить нескольких сотрудников и одну сервисную компанию одновременно.',
        'Виза ИТ переехала на смету, заявку можно отложить, а решённые закрываются через 24 часа.',
      ],
    },
  ];

  for (const block of blocks) {
    b += rect(55, block.y, 1013, 285, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(55, block.y, 12, 285, { fill: block.color, r: 6 });
    b += circle(110, block.y + 62, 27, { fill: block.soft, stroke: block.color, sw: 2 });
    b += text(110, block.y + 72, block.n, 25, { fill: block.color, weight: 700, anchor: 'middle' });
    b += text(158, block.y + 54, block.title, 24, { fill: C.ink, weight: 700 });
    block.points.forEach((point, i) => {
      b += bullet(158, block.y + 111 + i * 67, point, 845, {
        color: block.color,
        size: 16,
        lineHeight: 23,
      });
    });
  }

  b += rect(55, 1135, 1013, 300, { fill: C.bg, stroke: C.line, r: 16 });
  b += text(82, 1182, 'Что добавилось в этом выпуске', 21, { fill: C.ink, weight: 700 });
  b += text(1041, 1182, '31 августа 2026', 14, { fill: C.faint, anchor: 'end' });
  const fresh = [
    {
      n: '1',
      color: C.blue,
      title: '«Ремонт» стал «Обслуживанием»',
      body: 'Тот же вид заявки и то же место в форме — слово просто шире: им просят не только починить, но и настроить, подключить, заправить.',
    },
    {
      n: '2',
      color: C.purple,
      title: 'Поле называется «Описание»',
      body: 'Одна подпись у обоих видов — и в форме, и в карточке, и в истории. Подсказка внутри поля у каждого своя, а кнопка вложений теперь «Фото и документы».',
    },
    {
      n: '3',
      color: C.green,
      title: 'Столбец «Правка остатка»',
      body: 'В перечне картриджей видно, когда остаток последний раз правили руками. Выдачи и возвраты по заявкам сюда не считаются, прочерк значит «не трогали».',
    },
    {
      n: '4',
      color: C.orange,
      title: 'Окно «История остатка»',
      body: 'Лента движений ушла из карточки позиции в своё окно: страницы, отбор по виду события, номер заявки и подпись того, кто правил.',
    },
  ];
  fresh.forEach((item, i) => {
    const x = 82 + (i % 2) * 496;
    const y = 1232 + Math.floor(i / 2) * 98;
    b += numberDot(item.n, x + 16, y - 6, { fill: item.color, radius: 14 });
    b += text(x + 42, y, item.title, 15, { fill: C.ink, weight: 700 });
    b += paragraph(x + 42, y + 24, item.body, 420, 13, {
      fill: C.muted,
      lineHeight: 19,
      maxLines: 3,
    });
  });
  b += footer();
  return document(b);
}

function page3() {
  let b = header(
    3,
    'Где находятся справочники',
    '2. Вход в раздел',
    'Откройте «Справочники» и вкладку «Оргтехника». Все связанные перечни доступны из одной шапки — переходить между вкладками не нужно.',
  );

  const shell = appShell(55, 225, 1013, 760, 'Справочники');
  b += shell.svg;
  const cx = shell.contentX;
  const cw = shell.contentWidth;
  b += text(cx, 278, 'Справочники', 25, { fill: C.ink, weight: 700 });
  b += tabs(cx, 331, ['Техника', 'Контрагенты', 'Сотрудники', 'Оргтехника'], 'Оргтехника', cw);
  b += input(cx, 410, 235, '', 'Модель или номер', { placeholder: true });
  b += input(cx + 248, 410, 165, '', 'Все объекты', { placeholder: true, suffix: '⌄' });
  b += input(cx + 425, 410, 150, '', 'Все типы', { placeholder: true, suffix: '⌄' });
  b += input(cx + 587, 410, 170, '', 'Все отделы', { placeholder: true, suffix: '⌄' });

  b += button(cx, 492, 160, 'Типы оргтехники', { compact: true });
  b += button(cx + 172, 492, 170, 'Модели аппаратов', { compact: true });
  b += button(cx + 354, 492, 190, 'Картриджи и тонеры', { compact: true });
  b += button(cx + cw - 170, 492, 170, 'Добавить технику', { compact: true, primary: true, icon: '+' });

  const widths = [235, 145, 145, 160, 108];
  b += tableHeader(cx, 565, widths, ['Модель', 'Тип', 'Инв. №', 'Объект / отдел', 'Гарантия']);
  b += tableRow(cx, 607, widths, ['Ricoh Aficio MP 201SPF', 'МФУ', '00001428', 'АЛ13 · Бухгалтерия', 'до 14.11'], { fill: '#fcfdff' });
  b += tableRow(cx, 662, widths, ['Kyocera ECOSYS M3145', 'МФУ', '00001802', 'АЛ14 · ИТ', 'истекла']);
  b += tableRow(cx, 717, widths, ['Pantum P2500W', 'Принтер', '00002011', 'АЛ13 · —', '—'], { fill: '#fcfdff' });
  b += tableRow(cx, 772, widths, ['HP ScanJet Pro 2600', 'Сканер', 'SN-11704', 'Офис · АХО', 'действует']);
  b += text(cx, 867, '1–20 из 353', 13, { fill: C.muted });
  b += shell.close;

  b += callout(55, 1030, 315, 216, '1', 'Типы', 'Короткий перечень: МФУ, принтер, сканер, ноутбук и другие виды оборудования.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(404, 1030, 315, 216, '2', 'Модели', 'Канонические названия аппаратов. Из них выбирают модель в карточке техники и совместимость расходника.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(753, 1030, 315, 216, '3', 'Расходники', 'Картриджи и тонеры доступны на чтение всем, кому видна оргтехника; изменение зависит от отдельного права.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  b += rect(55, 1280, 1013, 165, { fill: C.graySoft, stroke: C.line, r: 13 });
  b += text(82, 1322, 'На телефоне', 18, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1357, '«Добавить технику» остаётся главным действием, а три справочника находятся в дополнительных действиях рядом с фильтрами. Остаток удобно сверять прямо у полки.', 940, 16, { fill: C.muted, lineHeight: 24 });
  b += footer();
  return document(b);
}

function page4() {
  let b = header(
    4,
    'Список техники: найти и проверить',
    '3. Справочник оргтехники',
    'Поиск работает по модели, серийному и инвентарному номеру. Фильтры отвечают на операционные вопросы: где стоит, кто владелец и что с гарантией.',
  );

  b += rect(55, 235, 1013, 540, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += input(82, 293, 260, '', 'Модель или номер', { placeholder: true });
  b += input(355, 293, 190, '', 'Все объекты', { placeholder: true, suffix: '⌄' });
  b += input(558, 293, 160, '', 'Все типы', { placeholder: true, suffix: '⌄' });
  b += input(731, 293, 205, '', 'Все отделы', { placeholder: true, suffix: '⌄' });
  b += pill(82, 354, 'Без владельца', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 13 }).svg;
  b += pill(218, 354, 'Гарантия: истекает', { fill: C.orangeSoft, color: C.orange, stroke: '#ffd591', size: 13 }).svg;
  b += pill(405, 354, 'Активные', { fill: C.greenSoft, color: C.green, stroke: '#b7eb8f', size: 13 }).svg;

  const widths = [220, 120, 132, 120, 213, 120];
  b += tableHeader(82, 420, widths, ['Модель', 'Тип', 'Инв. №', 'Серийный №', 'Объект · место', 'Состояние']);
  b += tableRow(82, 462, widths, ['Ricoh IM 350', 'МФУ', '00002411', 'W9132', 'АЛ13 · каб. 214', 'Активна'], { fill: '#fcfdff' });
  b += tableRow(82, 520, widths, ['Kyocera M3145', 'МФУ', '00001802', 'R7119', 'АЛ14 · ИТ', 'Активна']);
  b += tableRow(82, 578, widths, ['Pantum P2500W', 'Принтер', '00002011', 'P2500-8', 'АЛ13 · приёмная', 'Неактивна'], { fill: C.graySoft, colors: [C.text, C.text, C.text, C.text, C.text, C.faint] });
  b += tableRow(82, 636, widths, ['Ricoh MP 201SPF', 'МФУ', '00001428', 'M8045', 'Офис · каб. 307', 'Активна']);
  b += text(82, 731, 'Сортировка доступна по основным колонкам; смена любого фильтра возвращает список на первую страницу.', 13, { fill: C.muted });

  b += text(55, 840, 'Действия с карточкой', 24, { fill: C.ink, weight: 700 });
  const cards = [
    ['1', 'Редактировать', 'Исправьте реквизиты, владельца, место, даты или активность.', C.blue, C.blueSoft],
    ['2', 'Переместить', 'Объект, кабинет и владелец меняются отдельной операцией с причиной.', C.purple, C.purpleSoft],
    ['3', 'История', 'Лента показывает заведение, правки и перемещения: что, когда и кем.', C.green, C.greenSoft],
    ['4', 'Удалить', 'Карточка уходит в архив; незакрытая заявка блокирует удаление.', C.red, C.redSoft],
  ];
  cards.forEach((item, i) => {
    const x = 55 + (i % 2) * 516;
    const y = 885 + Math.floor(i / 2) * 200;
    b += callout(x, y, 497, 170, item[0], item[1], item[2], {
      fill: item[4],
      stroke: item[0] === '4' ? '#ffccc7' : item[3] === C.green ? '#b7eb8f' : item[3] === C.purple ? '#d3adf7' : '#bae0ff',
      dotFill: item[3],
    });
  });

  b += rect(55, 1310, 1013, 120, { fill: C.orangeSoft, stroke: '#ffd591', r: 12 });
  b += text(82, 1350, 'Архив ≠ неактивна', 17, { fill: C.orange, weight: 700 });
  b += paragraph(82, 1381, 'Если аппарат остаётся в учёте, но его больше нельзя выбирать в новых заявках, снимите «Активна». Удаление используйте для ошибочной карточки — история заявок при этом остаётся.', 940, 15, { fill: C.text, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page5() {
  let b = header(
    5,
    'Карточка техники: правильный порядок',
    '4. Заведение и правка',
    'Сначала выберите тип, затем модель. Модель больше не вводится текстом: это связь со справочником, по которой подбираются картриджи.',
  );

  b += rect(55, 222, 675, 1040, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 270, 'Новая единица оргтехники', 24, { fill: C.ink, weight: 700 });
  b += input(82, 330, 275, 'Тип', 'МФУ', { suffix: '⌄' });
  b += input(374, 330, 302, 'Модель', 'Ricoh Aficio MP 201SPF', { suffix: '⌄' });
  b += button(675, 340, 35, '+', { compact: true });
  b += input(82, 426, 275, 'Серийный номер', 'M201-03145');
  b += input(374, 426, 302, 'Инвентарный номер', '00001428');
  b += input(82, 522, 275, 'Объект', 'АЛ13', { suffix: '⌄' });
  b += input(374, 522, 302, 'Отдел-владелец', 'Бухгалтерия', { suffix: '⌄' });
  b += input(82, 618, 594, 'Место', 'Корпус 1, кабинет 214');
  b += input(82, 714, 275, 'Дата покупки', '12.11.2024');
  b += input(374, 714, 302, 'Гарантия до', '12.11.2027');
  b += input(82, 810, 594, 'Комментарий', 'Основной аппарат бухгалтерии');
  b += rect(82, 912, 38, 22, { fill: C.blue, r: 11 });
  b += circle(109, 923, 8, { fill: '#fff' });
  b += text(132, 928, 'Активна', 15, { fill: C.text, weight: 500 });
  b += rect(82, 974, 594, 120, { fill: C.bluePale, stroke: '#bae0ff', r: 10 });
  b += text(100, 1007, 'Чем заправлять', 16, { fill: C.blue, weight: 700 });
  b += text(100, 1041, 'Д0000337741 · Тонер Ricoh 201 · в наличии 12', 14, { fill: C.text });
  b += text(100, 1071, 'Б0000014256 · Картридж Ricoh Type 1270D · нет в наличии', 14, { fill: C.red, weight: 600 });
  b += button(455, 1168, 100, 'Отмена', {});
  b += button(568, 1168, 108, 'Сохранить', { primary: true });

  b += callout(765, 240, 303, 178, '1', 'Выберите тип', 'Смена типа очищает модель: принтер и МФУ с похожим названием — разные справочные записи.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(765, 442, 303, 188, '2', 'Выберите модель', 'Если нужной нет, нажмите «+». Новая модель создаётся внутри формы и сразу подставляется.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(765, 654, 303, 188, '3', 'Укажите номер', 'Нужен хотя бы один: серийный или инвентарный. По нему аппарат опознают после ремонта.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });
  b += callout(765, 866, 303, 188, '4', 'Закрепите место', 'Объект обязателен; отдел-владелец и кабинет можно уточнить позже. Ничьи карточки видны отдельным фильтром.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });
  b += callout(765, 1078, 303, 184, '5', 'Проверьте подсказку', 'После сохранения карточка показывает подходящие активные расходники и актуальный остаток.', { fill: C.cyanSoft, stroke: '#87e8de', dotFill: C.cyan });

  b += rect(55, 1305, 1013, 122, { fill: C.graySoft, stroke: C.line, r: 12 });
  b += text(82, 1345, 'При правке', 17, { fill: C.ink, weight: 700 });
  b += paragraph(82, 1377, 'Погашенная модель остаётся в уже заведённой карточке. Это позволяет исправить кабинет или владельца, не заставляя одновременно менять модель аппарата.', 940, 15, { fill: C.muted, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page6() {
  let b = header(
    6,
    'Справочник моделей аппаратов',
    '5. Канонические модели',
    'Окно «Модели аппаратов» — источник единых названий. Поиск идёт по названию и производителю, список по умолчанию отсортирован по алфавиту.',
  );

  b += rect(55, 225, 1013, 650, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 274, 'Модели аппаратов', 25, { fill: C.ink, weight: 700 });
  b += input(82, 337, 270, '', 'Наименование или производитель', { placeholder: true });
  b += input(365, 337, 170, '', 'Все типы', { placeholder: true, suffix: '⌄' });
  b += input(548, 337, 185, '', 'Любая активность', { placeholder: true, suffix: '⌄' });
  b += pill(746, 313, '□  Без расходника', { fill: C.graySoft, color: C.text, stroke: '#d9d9d9', size: 13 }).svg;
  const widths = [265, 135, 170, 100, 125, 90];
  b += tableHeader(82, 402, widths, ['Наименование', 'Тип', 'Производитель', 'В парке', 'Активность', 'Действия']);
  b += tableRow(82, 444, widths, ['Kyocera ECOSYS M3145', 'МФУ', 'Kyocera', '12', 'Активна', '✎  ×'], { fill: '#fcfdff' });
  b += tableRow(82, 502, widths, ['Pantum P2500W', 'Принтер', 'Pantum', '7', 'Активна', '✎  ×']);
  b += tableRow(82, 560, widths, ['Ricoh Aficio MP 201SPF', 'МФУ', 'Ricoh', '68', 'Активна', '✎  ×'], { fill: '#fcfdff' });
  b += tableRow(82, 618, widths, ['Ricoh MP C2503', 'МФУ', 'Ricoh', '3', 'Погашена', '✎  —']);
  b += paragraph(82, 705, '«В парке» — активные карточки модели в вашей области видимости. Архивная и выведенная из эксплуатации техника не считается.', 875, 13, { fill: C.muted, lineHeight: 19 });
  b += button(842, 790, 180, 'Добавить модель', { primary: true, compact: true, icon: '+' });

  b += text(55, 944, 'Карточка модели', 24, { fill: C.ink, weight: 700 });
  b += rect(55, 978, 480, 360, { fill: '#fff', stroke: C.line, r: 14 });
  b += input(82, 1035, 190, 'Тип', 'МФУ', { suffix: '⌄' });
  b += input(286, 1035, 220, 'Производитель', 'Ricoh');
  b += input(82, 1131, 424, 'Наименование', 'Ricoh Aficio MP 201SPF');
  b += input(82, 1227, 424, 'Комментарий', 'Чёрно-белое МФУ');
  b += rect(82, 1311, 38, 22, { fill: C.blue, r: 11 });
  b += circle(109, 1322, 8, { fill: '#fff' });
  b += text(132, 1327, 'Активна', 15, { fill: C.text });

  b += callout(570, 978, 498, 165, '1', '«Без расходника»', 'Показывает модели, к которым не привязан ни один картридж или тонер. Пустой срез означает: совместимость настроена для всех.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(570, 1163, 498, 165, '2', 'Тип не меняют', 'Ошибка в типе означает другую модель: заведите новую запись. Это сохраняет корректность связей с техникой и расходниками.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });
  b += rect(570, 1348, 498, 82, { fill: C.redSoft, stroke: '#ffccc7', r: 12 });
  b += text(594, 1381, 'Удаление', 15, { fill: C.red, weight: 700 });
  b += paragraph(677, 1381, 'занятая модель не удаляется — снимите «Активна».', 365, 14, { fill: C.text, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page7() {
  let b = header(
    7,
    'Картриджи и тонеры: найти позицию',
    '6. Справочник расходников',
    'Список отвечает на четыре вопроса: какой код заказать, к каким аппаратам подходит позиция, сколько единиц сейчас на складе и когда остаток последний раз правили руками.',
  );

  b += rect(55, 225, 1013, 690, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 274, 'Картриджи и тонеры', 25, { fill: C.ink, weight: 700 });
  b += input(82, 337, 250, '', 'Наименование или код', { placeholder: true });
  b += input(345, 337, 230, '', 'Все модели', { placeholder: true, suffix: '⌄' });
  b += pill(588, 313, '□  Нет в наличии', { fill: C.redSoft, color: C.red, stroke: '#ffccc7', size: 13 }).svg;
  b += pill(750, 313, '□  Только активные', { fill: C.greenSoft, color: C.green, stroke: '#b7eb8f', size: 13 }).svg;
  const widths = [120, 195, 75, 70, 130, 70, 70, 105, 115];
  b += tableHeader(82, 402, widths, ['Код', 'Наименование', 'Цвет', 'Наличие', 'Правка остатка', 'Модели', 'В парке', 'Активность', 'Действия']);
  b += tableRow(82, 444, widths, ['Д0000337741', 'Тонер Ricoh 201 (шт)', '—', '12', '24.08.2026 11:42', '3', '68', 'Активен', '№  ✎  ⏱'], { fill: '#fcfdff', weights: [500, 600, 400, 700] });
  b += tableRow(82, 504, widths, ['Б0000014256', 'Картридж Ricoh Type 1270D', 'чёрный', '0', '02.07.2026 16:20', '2', '71', 'Активен', '№  ✎  ⏱'], { colors: [C.text, C.text, C.text, C.red] });
  b += tableRow(82, 564, widths, ['Д0000337810', 'Тонер Kyocera TK-3160', '—', '4', '—', '1', '12', 'Активен', '№  ✎  ⏱'], { fill: '#fcfdff', colors: [C.text, C.text, C.text, C.text, C.faint] });
  b += tableRow(82, 624, widths, ['Д0000341142', 'Тонер Ricoh MP C2503', 'голубой', '2', '19.08.2026 09:05', '1', '3', 'Активен', '№  ✎  ⏱']);
  b += tableRow(82, 684, widths, ['Д0000341143', 'Тонер Ricoh MP C2503', 'жёлтый', '0', '—', '1', '3', 'Погашен', '№  ✎  ⏱'], { fill: C.graySoft, colors: [C.text, C.text, C.text, C.red, C.faint, C.text, C.text, C.faint] });
  b += paragraph(82, 781, '«№» правит остаток и спрашивает причину, «⏱» открывает окно «История остатка», «✎» — карточку позиции. Столбец «Правка остатка» считает только ручные правки: выдачи и возвраты по заявкам его не двигают, а прочерк значит «руками не трогали ни разу».', 925, 13, { fill: C.muted, lineHeight: 19 });
  b += button(820, 845, 202, 'Добавить расходник', { primary: true, compact: true, icon: '+' });

  b += text(55, 980, 'Как пользоваться отбором и столбцами', 24, { fill: C.ink, weight: 700 });
  b += callout(55, 1020, 240, 200, '1', 'Поиск', 'Часть наименования или код номенклатуры: «Pantum» или «Д0000337741».', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(312, 1020, 240, 200, '2', 'Модель', 'Выберите модель аппарата — останутся только совместимые с ней позиции.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(569, 1020, 240, 200, '3', 'Нет в наличии', 'Покажет нулевые остатки. Отсортируйте «Наличие», чтобы собрать заказ поставщику.', { fill: C.redSoft, stroke: '#ffccc7', dotFill: C.red });
  b += callout(826, 1020, 242, 200, '4', 'Правка остатка', 'Отсортируйте столбец: сверху окажется то, чью полку давно не пересчитывали руками.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  b += rect(55, 1260, 1013, 170, { fill: C.greenSoft, stroke: '#b7eb8f', r: 13 });
  b += text(82, 1302, 'Разные права — разные кнопки', 18, { fill: C.green, weight: 700 });
  b += paragraph(82, 1337, 'Чтение доступно вместе со справочником оргтехники. «Добавить/Редактировать» требует ведения номенклатуры; «Изменить остаток» — отдельного складского права. А «История остатка» открыта каждому, кому видна сама позиция: своего права у ленты нет.', 940, 15, { fill: C.text, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page8() {
  let b = header(
    8,
    'Карточка расходника',
    '7. Номенклатура и совместимость',
    'Создавайте отдельную позицию на каждый код и цвет. Остаток не задаётся при создании: первое число тоже заводится отдельной операцией с причиной и встаёт в историю остатка.',
  );

  b += rect(55, 225, 620, 1000, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 273, 'Новый картридж или тонер', 23, { fill: C.ink, weight: 700 });
  b += input(82, 334, 540, 'Код номенклатуры', 'Д0000341142');
  b += text(82, 403, 'Как в учётной системе: Б0000014256, Д0000337741', 12, { fill: C.muted });
  b += input(82, 456, 540, 'Наименование', 'Тонер Ricoh MP C2503 (шт)');
  b += input(82, 552, 250, 'Цвет', 'голубой');
  b += input(346, 552, 276, 'Активность', 'Активен', { suffix: '⌄' });
  b += input(82, 648, 540, 'Подходит к', 'Ricoh MP C2503 · Ricoh MP C2003', { suffix: '⌄' });
  b += text(82, 718, 'Можно оставить пустым и уточнить совместимость позже.', 12, { fill: C.muted });
  b += input(82, 773, 540, 'Комментарий', 'Голубая туба; заказывать поштучно');
  b += rect(82, 874, 540, 112, { fill: C.graySoft, stroke: C.line, r: 10 });
  b += text(104, 910, 'В наличии: 0', 17, { fill: C.text, weight: 700 });
  b += button(425, 894, 174, 'Изменить остаток', { compact: true });
  b += text(104, 954, 'Остаток появится после отдельной операции.', 13, { fill: C.muted });
  b += rect(82, 1006, 540, 152, { fill: C.bluePale, stroke: '#bae0ff', r: 10 });
  b += text(104, 1044, 'Движения остатка — в своём окне', 16, { fill: C.blue, weight: 700 });
  b += paragraph(104, 1078, 'Ленту событий карточка больше не возит: её открывает кнопка «История остатка» — отсюда и из строки перечня.', 250, 13, { fill: C.text, lineHeight: 19, maxLines: 4 });
  b += button(414, 1062, 190, 'История остатка', { compact: true });
  b += button(403, 1170, 100, 'Отмена');
  b += button(516, 1170, 106, 'Сохранить', { primary: true });

  b += callout(715, 225, 353, 182, '1', 'Код уникален', 'Пишите как в учётной системе. Портал убирает лишние пробелы и приводит код к единому регистру.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(715, 430, 353, 182, '2', 'Цвет — свойство позиции', 'Чёрный, голубой, пурпурный и жёлтый — отдельные коды и отдельные остатки. Комплект — отдельная позиция.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(715, 635, 353, 182, '3', 'Привяжите модели', 'Именно эта связь питает фильтр «что подходит» и блок «Чем заправлять» в карточке аппарата.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });
  b += callout(715, 840, 353, 182, '4', 'Гасите, не стирайте', 'Погашенная позиция не предлагается для новых операций, но остаток, совместимость и вся история движений сохраняются.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });
  b += callout(715, 1045, 353, 180, '5', 'Удаляйте только пустую историю', 'Если остаток уже менялся, запись удалить нельзя: исправление проводится новым событием, а не очисткой истории.', { fill: C.redSoft, stroke: '#ffccc7', dotFill: C.red });

  b += rect(55, 1270, 1013, 158, { fill: C.bluePale, stroke: '#bae0ff', r: 12 });
  b += text(82, 1312, 'После сохранения новой позиции', 18, { fill: C.blue, weight: 700 });
  b += paragraph(82, 1348, 'Нажмите «Изменить остаток», укажите фактическое количество и причину — «поступление по счёту …» или «начальный пересчёт». Только после этого наличие станет ненулевым, а событие встанет первой строкой в окне «История остатка».', 940, 15, { fill: C.text, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page9() {
  let b = header(
    9,
    'Остаток: число с историей',
    '8. Правка остатка и её история',
    'Остаток — не редактируемое поле, а последовательность событий: портал спрашивает новое значение и объяснение изменения. Сама лента живёт в отдельном окне «История остатка».',
  );

  b += rect(55, 225, 460, 640, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 275, 'Остаток: Тонер Ricoh 201', 22, { fill: C.ink, weight: 700 });
  b += text(82, 327, 'Сейчас на складе:', 16, { fill: C.muted });
  b += text(250, 327, '12', 18, { fill: C.ink, weight: 700 });
  b += input(82, 390, 380, 'Стало', '18');
  b += input(82, 495, 380, 'Причина', 'Поступление по счёту 1245');
  b += paragraph(82, 568, 'Куда ушло или откуда пришло: «выдано на АЛ13», «поступление по счёту 1245».', 380, 12, { fill: C.muted, lineHeight: 18 });
  b += rect(82, 650, 380, 105, { fill: C.orangeSoft, stroke: '#ffd591', r: 9 });
  b += text(104, 683, 'Если число изменил другой человек', 14, { fill: C.orange, weight: 700 });
  b += paragraph(104, 713, 'Портал покажет новое текущее значение и попросит свериться перед повторным сохранением.', 330, 12, { fill: C.text, lineHeight: 18 });
  b += button(263, 792, 90, 'Отмена');
  b += button(365, 792, 97, 'Сохранить', { primary: true });

  b += text(560, 245, 'Как провести пересчёт', 24, { fill: C.ink, weight: 700 });
  const steps = [
    ['1', 'Откройте позицию', 'Нажмите кнопку остатка в строке или «Изменить остаток» в карточке.'],
    ['2', 'Сверьте «Сейчас»', 'Число на экране — отправная точка и защита от одновременной правки.'],
    ['3', 'Введите «Стало»', 'Указывается итог на полке, не разница: было 12, пришло 6 — стало 18.'],
    ['4', 'Объясните причину', 'Минимум три осмысленных символа; лучше номер счёта, заявка или место выдачи.'],
    ['5', 'Сохраните', 'Одинаковое число не создаёт пустое событие; реальная правка встаёт в историю остатка.'],
  ];
  steps.forEach((step, i) => {
    const y = 292 + i * 118;
    b += numberDot(step[0], 585, y + 22, { fill: i === 4 ? C.green : C.blue, radius: 17 });
    b += text(618, y + 20, step[1], 17, { fill: C.ink, weight: 700 });
    b += paragraph(618, y + 50, step[2], 420, 13, { fill: C.muted, lineHeight: 19, maxLines: 2 });
    if (i < steps.length - 1) b += line(585, y + 45, 585, y + 103, { stroke: C.line, sw: 2 });
  });

  b += text(55, 930, 'Окно «История остатка»', 24, { fill: C.ink, weight: 700 });
  b += text(400, 930, '— открывается из строки перечня и из карточки позиции', 14, { fill: C.muted });

  b += rect(55, 950, 1013, 380, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += text(82, 988, 'История остатка: Тонер Ricoh 201 (шт) · Д0000337741', 17, { fill: C.ink, weight: 700 });
  b += line(82, 1006, 1041, 1006, { stroke: C.line });

  const kinds = ['Все', 'Ручные правки', 'Выдачи', 'Возвраты'];
  const kindWidths = kinds.map((label) => Math.round(label.length * 13 * 0.55 + 26));
  b += rect(82, 1016, kindWidths.reduce((sum, w) => sum + w, 0) + 8, 34, { fill: '#f5f5f5', stroke: C.line, r: 7 });
  let kx = 86;
  kinds.forEach((label, i) => {
    const selected = i === 0;
    if (selected) b += rect(kx, 1020, kindWidths[i], 26, { fill: '#fff', stroke: '#e5e5e5', r: 5 });
    b += text(kx + kindWidths[i] / 2, 1038, label, 13, {
      fill: selected ? C.ink : C.muted,
      weight: selected ? 600 : 400,
      anchor: 'middle',
    });
    kx += kindWidths[i];
  });
  b += text(82, 1072, 'Роль и наборы полномочий у подписи показаны сегодняшние: кем человек был на момент события, портал не хранит.', 12, { fill: C.faint });

  const entries = [
    {
      y: 1086,
      fill: '#fcfdff',
      when: '24.08.2026 11:42',
      tag: null,
      request: null,
      requestOpen: false,
      delta: '+6',
      pair: '12 → 18',
      reason: 'Поступление по счёту 1245',
      author: 'Иванов И. И. · Штаб · Оргтехника: ведение',
    },
    {
      y: 1160,
      fill: '#fff',
      when: '24.08.2026 15:10',
      tag: 'Выдача',
      request: 'СО-146',
      requestOpen: true,
      delta: '−1',
      pair: '18 → 17',
      reason: 'Выдано по заявке СО-146 · Kyocera M3145 · 01802',
      author: 'Петрова А. С. · Штаб · Оргтехника: ИТ-служба',
    },
    {
      y: 1234,
      fill: '#fcfdff',
      when: '25.08.2026 09:02',
      tag: 'Выдача',
      request: 'СО-151',
      requestOpen: false,
      delta: '−1',
      pair: '17 → 16',
      reason: 'Выдано по заявке СО-151 · Ricoh IM 350 · 02118',
      author: 'Сидоров П. Н. · Отдел',
    },
  ];
  for (const entry of entries) {
    b += rect(82, entry.y, 959, 68, { fill: entry.fill, stroke: C.line, r: 10 });
    let xx = 101;
    b += text(xx, entry.y + 25, entry.when, 12.5, { fill: C.faint });
    xx += 134;
    if (entry.tag) {
      const tag = pill(xx, entry.y + 9, entry.tag, { fill: C.blueSoft, color: C.blue, size: 11, pad: 9 });
      b += tag.svg;
      xx += tag.width + 14;
    }
    if (entry.request) {
      b += text(xx, entry.y + 25, entry.request, 13, {
        fill: entry.requestOpen ? C.blue : C.faint,
        weight: 600,
      });
      if (entry.requestOpen) b += line(xx, entry.y + 30, xx + 46, entry.y + 30, { stroke: C.blue });
      xx += 64;
    }
    b += text(xx, entry.y + 25, entry.delta, 14, { fill: C.ink, weight: 700 });
    xx += 42;
    b += text(xx, entry.y + 25, entry.pair, 12.5, { fill: C.muted });
    b += text(101, entry.y + 45, entry.reason, 13, { fill: C.text });
    b += text(101, entry.y + 62, entry.author, 12, { fill: C.faint });
  }
  b += text(1041, 1320, '1–3 из 27 событий      ‹  1  2  3  ›', 13, { fill: C.muted, anchor: 'end' });

  b += rect(55, 1348, 1013, 82, { fill: C.goldSoft, stroke: '#ffe58f', r: 12 });
  b += text(82, 1384, 'Номер заявки — ссылка не для всех', 17, { fill: C.gold, weight: 700 });
  b += paragraph(82, 1412, 'Склад один на компанию, а заявки — нет: ту, которую вам открывать не положено, портал показывает номером без ссылки.', 940, 14, { fill: C.text, lineHeight: 20, maxLines: 1 });

  b += rect(55, 1446, 1013, 60, { fill: C.redSoft, stroke: '#ffccc7', r: 10 });
  b += text(82, 1483, 'Нельзя', 15, { fill: C.red, weight: 700 });
  b += paragraph(155, 1483, 'править и удалять строки истории, затирать чужую правку и оставлять изменение без причины.', 860, 14, { fill: C.text, lineHeight: 20, maxLines: 1 });
  b += footer();
  return document(b);
}

function page10() {
  let b = header(
    10,
    'Быстрый ответ: «чем заправлять»',
    '9. Связь техники и расходников',
    'Откройте существующую карточку аппарата: перед историей обслуживания показаны только активные позиции, совместимые с его моделью.',
  );

  b += rect(55, 225, 700, 825, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 272, 'Редактирование карточки', 23, { fill: C.ink, weight: 700 });
  b += text(82, 322, 'Ricoh Aficio MP 201SPF · инв. 00001428', 17, { fill: C.text, weight: 600 });
  b += text(82, 350, 'АЛ13 · Бухгалтерия · кабинет 214', 14, { fill: C.muted });
  b += line(82, 382, 702, 382, { stroke: C.line });
  b += text(82, 427, 'Чем заправлять', 20, { fill: C.ink, weight: 700 });
  const rows = [
    ['Д0000337741', 'Тонер Ricoh 201 (шт)', '', 'в наличии 12', C.green, C.greenSoft],
    ['Б0000014256', 'Картридж Ricoh Type 1270D', 'чёрный', 'нет в наличии', C.red, C.redSoft],
    ['Д0000341207', 'Тонер совместимый Static Control', '', 'в наличии 3', C.green, C.greenSoft],
  ];
  rows.forEach((row, i) => {
    const y = 460 + i * 105;
    b += rect(82, y, 620, 86, { fill: i % 2 ? '#fff' : '#fcfdff', stroke: C.line, r: 8 });
    b += text(101, y + 29, row[0], 13, { fill: C.muted, weight: 600 });
    b += text(101, y + 59, row[1], 15, { fill: C.text, weight: 600 });
    if (row[2]) b += text(425, y + 59, row[2], 13, { fill: C.muted });
    const status = pill(543, y + 28, row[3], { fill: row[5], color: row[4], stroke: row[4] === C.red ? '#ffccc7' : '#b7eb8f', size: 12, pad: 9 });
    b += status.svg;
  });
  b += line(82, 802, 702, 802, { stroke: C.line });
  b += text(82, 846, 'История обслуживания', 20, { fill: C.ink, weight: 700 });
  b += tableHeader(82, 873, [140, 255, 225], ['Дата', 'Результат', 'Исполнитель']);
  b += tableRow(82, 915, [140, 255, 225], ['14.06.2026', 'Заменён ролик подачи', 'КопиЛайт'], { height: 58 });
  b += text(82, 1018, 'Подбор расходника и история аппарата находятся в одной карточке.', 13, { fill: C.muted });

  b += callout(790, 245, 278, 190, '1', 'Код первым', 'По коду позицию сопоставляют со счётом и заказывают у поставщика.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(790, 458, 278, 190, '2', 'Ноль виден сразу', '«Нет в наличии» означает: совместимость настроена, но позицию нужно заказывать.', { fill: C.redSoft, stroke: '#ffccc7', dotFill: C.red });
  b += callout(790, 671, 278, 190, '3', 'Пустой блок — сигнал', 'Если ни одной позиции нет, откройте модели с фильтром «Без расходника» и настройте связь.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });
  b += callout(790, 884, 278, 166, '4', 'Погашенные скрыты', 'Их больше не предлагают для заказа, но история и остаток в справочнике сохраняются.', { fill: C.graySoft, stroke: C.line, dotFill: C.muted });

  b += text(55, 1115, 'Мини-чек-лист перед заказом', 24, { fill: C.ink, weight: 700 });
  const checklist = [
    'Откройте карточку конкретного аппарата и сверьте его модель.',
    'Скопируйте код подходящей позиции; для цветной серии проверьте цвет.',
    'Посмотрите «в наличии» и сравните с числом аппаратов «В парке».',
    'Если позиции нет, уточните совместимость и добавьте её в карточку расходника.',
  ];
  checklist.forEach((value, i) => {
    const x = 55 + (i % 2) * 516;
    const y = 1167 + Math.floor(i / 2) * 105;
    b += rect(x, y, 497, 86, { fill: i < 2 ? C.bluePale : C.greenSoft, stroke: i < 2 ? '#bae0ff' : '#b7eb8f', r: 11 });
    b += circle(x + 34, y + 43, 16, { fill: i < 2 ? C.blue : C.green });
    b += check(x + 25, y + 45, '#fff');
    b += paragraph(x + 62, y + 31, value, 405, 14, { fill: C.text, lineHeight: 20, maxLines: 3 });
  });
  b += footer();
  return document(b);
}

function statusBox(x, y, width, titleValue, color, soft, subtitle) {
  let output = rect(x, y, width, 105, { fill: '#fff', stroke: color, sw: 2, r: 13, shadow: true });
  output += rect(x, y, width, 12, { fill: color, r: 6 });
  output += text(x + width / 2, y + 54, titleValue, 17, { fill: C.ink, weight: 700, anchor: 'middle' });
  if (subtitle) output += text(x + width / 2, y + 82, subtitle, 12, { fill: C.muted, anchor: 'middle' });
  return output;
}

function page11() {
  let b = header(
    11,
    'Обновлённый жизненный цикл заявки',
    '10. Новый словарь статусов',
    'Оба вида заявки — «Обслуживание» (прежний «Ремонт») и «Расходники» — живут по одному словарю статусов. «Диагностика» слилась с «В работе», а входная «Согласована ИТ» больше не шаг нового цикла.',
  );

  const xs = [55, 255, 455, 785, 955];
  const widths = [145, 145, 145, 145, 113];
  const flow = [
    ['Новая', C.blue, C.blueSoft, 'ждёт распределения'],
    ['Назначена', C.cyan, C.cyanSoft, 'ждёт исполнителя'],
    ['В работе', C.orange, C.orangeSoft, 'исполнение'],
    ['Решена', '#7cb305', '#fcffe6', 'ждёт приёмки'],
    ['Закрыта', C.green, C.greenSoft, 'завершена'],
  ];
  flow.forEach((item, i) => {
    b += statusBox(xs[i], 310, widths[i], item[0], item[1], item[2], item[3]);
    if (i < flow.length - 1) b += arrow(xs[i] + widths[i] + 8, 362, xs[i + 1] - 10, 362, { stroke: C.faint, sw: 2 });
  });

  b += arrow(527, 415, 527, 500, { stroke: C.gold, sw: 3 });
  b += arrow(675, 520, 608, 415, { stroke: C.gold, sw: 3 });
  b += rect(415, 512, 250, 105, { fill: C.goldSoft, stroke: C.gold, sw: 2, r: 13 });
  b += text(540, 555, 'Смета на согласовании', 16, { fill: C.ink, weight: 700, anchor: 'middle' });
  b += text(540, 586, 'ИТ → затем оператор', 12, { fill: C.muted, anchor: 'middle' });
  b += text(700, 536, 'необязательная ветка обслуживания', 12, { fill: C.gold, weight: 600 });
  b += text(700, 565, 'оба решения возвращают', 12, { fill: C.gold });
  b += text(700, 588, 'заявку «В работу»', 12, { fill: C.gold, weight: 600 });

  b += path('M 455 382 C 370 485, 205 570, 205 750', { stroke: C.faint, sw: 2, dash: '8 7' });
  b += arrow(205, 705, 205, 742, { stroke: C.faint, sw: 2, dash: '8 7' });
  b += rect(105, 750, 225, 100, { fill: C.graySoft, stroke: C.muted, sw: 2, r: 13 });
  b += text(218, 792, 'Отложена', 18, { fill: C.ink, weight: 700, anchor: 'middle' });
  b += text(218, 822, 'возврат туда, откуда отложили', 11, { fill: C.muted, anchor: 'middle' });
  b += text(350, 774, 'рабочая пауза · возобновление возвращает в прежний статус', 12, { fill: C.muted });

  b += path('M 327 415 C 327 900, 790 900, 790 965', { stroke: C.red, sw: 2, dash: '8 7' });
  b += rect(695, 965, 190, 100, { fill: C.redSoft, stroke: C.red, sw: 2, r: 13 });
  b += text(790, 1007, 'Отменена', 18, { fill: C.red, weight: 700, anchor: 'middle' });
  b += text(790, 1037, 'причина обязательна', 11, { fill: C.muted, anchor: 'middle' });

  b += text(55, 1130, 'Что делает каждый шаг', 24, { fill: C.ink, weight: 700 });
  const desc = [
    ['Новая', 'Оператор выбирает исполнителей. Виза ИТ на входе больше не нужна.', C.blue],
    ['Назначена', 'Назначенный сотрудник или сервис принимает заявку в работу либо отказывается.', C.cyan],
    ['В работе', 'Исполнитель делает работу; по обслуживанию может подготовить и предъявить смету.', C.orange],
    ['Смета', 'Сначала ИТ решает «чинить или менять», затем оператор согласует сумму.', C.gold],
    ['Решена', 'Работа предъявлена. Оператор принимает или возвращает на доработку.', '#7cb305'],
    ['Закрыта', 'Ручная приёмка либо автоматическое закрытие через 24 часа.', C.green],
  ];
  desc.forEach((item, i) => {
    const x = 55 + (i % 2) * 516;
    const y = 1170 + Math.floor(i / 2) * 90;
    b += text(x, y, item[0], 15, { fill: item[2], weight: 700 });
    b += paragraph(x + 105, y, item[1], 385, 13, { fill: C.text, lineHeight: 19, maxLines: 2 });
  });

  b += rect(55, 1440, 1013, 53, { fill: C.orangeSoft, stroke: '#ffd591', r: 9 });
  b += text(76, 1474, 'Важно:', 14, { fill: C.orange, weight: 700 });
  b += text(140, 1474, '«Согласована ИТ» и «Диагностика» могут временно встречаться только у старых заявок до миграции.', 14, { fill: C.text });
  b += footer();
  return document(b);
}

function page12() {
  let b = header(
    12,
    'Действия по ролям',
    '11. Кто двигает заявку',
    'Кнопки зависят не только от статуса, но и от назначения и полномочий. Исполнитель получает действия только по заявкам, назначенным ему или его сервисной компании.',
  );

  const roles = [
    {
      x: 55,
      color: C.blue,
      soft: C.blueSoft,
      title: 'Ведение оргтехники',
      subtitle: 'оператор',
      actions: ['назначает и меняет исполнителей', 'согласует сумму сметы', 'принимает или возвращает работу', 'ставит срочность, откладывает, отменяет'],
    },
    {
      x: 395,
      color: C.purple,
      soft: C.purpleSoft,
      title: 'ИТ-служба',
      subtitle: 'согласующий + свой исполнитель',
      actions: ['визирует текущую ревизию сметы', 'может рекомендовать замену аппарата', 'работает только по поимённому назначению', 'предъявляет смету и закрывает работы'],
    },
    {
      x: 735,
      color: C.orange,
      soft: C.orangeSoft,
      title: 'Внешний сервис',
      subtitle: 'назначенная компания',
      actions: ['принимает назначенную компании заявку', 'ведёт смету, обсуждение и результат', 'подшивает закрывающий документ', 'не принимает собственную работу за заказчика'],
    },
  ];
  roles.forEach((role) => {
    b += rect(role.x, 240, 318, 475, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
    b += rect(role.x, 240, 318, 12, { fill: role.color, r: 6 });
    b += circle(role.x + 44, 300, 23, { fill: role.soft, stroke: role.color, sw: 2 });
    b += text(role.x + 44, 308, role === roles[0] ? 'В' : role === roles[1] ? 'ИТ' : 'С', role === roles[1] ? 14 : 20, { fill: role.color, weight: 700, anchor: 'middle' });
    b += text(role.x + 78, 292, role.title, 19, { fill: C.ink, weight: 700 });
    b += paragraph(role.x + 78, 321, role.subtitle, 210, 12, { fill: C.muted, lineHeight: 17, maxLines: 2 });
    role.actions.forEach((action, i) => {
      b += bullet(role.x + 27, 392 + i * 70, action, 270, { color: role.color, size: 14, lineHeight: 20 });
    });
  });

  b += text(55, 780, 'Назначение исполнителей', 24, { fill: C.ink, weight: 700 });
  b += rect(55, 820, 640, 430, { fill: '#fff', stroke: C.line, r: 15, shadow: true });
  b += text(82, 866, 'Назначить исполнителей', 22, { fill: C.ink, weight: 700 });
  b += input(82, 930, 560, 'Исполнители', 'Иванов И. И. · Петрова А. С. · КопиЛайт', { suffix: '⌄' });
  b += text(82, 1000, 'Сотрудников можно несколько; сервисная компания — одна.', 12, { fill: C.muted });
  b += input(82, 1055, 560, 'Комментарий исполнителю', 'Проверить сначала узел подачи');
  b += rect(82, 1154, 560, 58, { fill: C.orangeSoft, stroke: '#ffd591', r: 8 });
  b += paragraph(100, 1186, 'При замене состава укажите причину — она попадёт в историю.', 520, 13, { fill: C.text, lineHeight: 18 });

  b += callout(730, 820, 338, 190, '1', 'Свой сотрудник', 'Отказ снимает только его строку. Если остаются другие исполнители, статус не меняется.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(730, 1035, 338, 190, '2', 'Сервисная компания', 'Отказ снимает всю компанию. Кто именно поедет — решает подрядчик, портал людей не выбирает.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });

  b += rect(55, 1295, 1013, 135, { fill: C.greenSoft, stroke: '#b7eb8f', r: 12 });
  b += text(82, 1337, 'Главное правило', 18, { fill: C.green, weight: 700 });
  b += paragraph(82, 1371, 'В рабочем статусе должен остаться хотя бы один исполнитель — сотрудник или сервисная компания. Если отказался последний, заявка возвращается в «Новую» и ждёт распределения.', 940, 15, { fill: C.text, lineHeight: 22 });
  b += footer();
  return document(b);
}

function page13() {
  let b = header(
    13,
    'Смета, документы и автозакрытие',
    '12. Ветка обслуживания',
    'Смета — необязательная ветка заявок на обслуживание. Согласование привязано к ревизии: новое предъявление делает старые подписи неактуальными, не стирая историю.',
  );

  b += text(55, 238, 'Последовательность согласования', 24, { fill: C.ink, weight: 700 });
  const steps = [
    ['1', 'Исполнитель', 'предъявляет смету', C.orange, C.orangeSoft],
    ['2', 'ИТ-служба', 'чинить или менять?', C.purple, C.purpleSoft],
    ['3', 'Оператор', 'согласовать сумму', C.blue, C.blueSoft],
    ['4', 'Исполнитель', 'выполнить работу', C.green, C.greenSoft],
  ];
  steps.forEach((step, i) => {
    const x = 55 + i * 254;
    b += rect(x, 290, 226, 150, { fill: step[4], stroke: step[3], r: 14 });
    b += circle(x + 32, 327, 18, { fill: step[3] });
    b += text(x + 32, 334, step[0], 17, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += text(x + 60, 329, step[1], 16, { fill: C.ink, weight: 700 });
    b += paragraph(x + 22, 383, step[2], 182, 14, { fill: C.text, lineHeight: 20, maxLines: 2 });
    if (i < steps.length - 1) b += arrow(x + 230, 365, x + 250, 365, { stroke: C.faint, sw: 2 });
  });
  b += rect(55, 470, 1013, 112, { fill: C.goldSoft, stroke: '#ffe58f', r: 12 });
  b += text(82, 509, 'Если смету отклонили', 17, { fill: C.gold, weight: 700 });
  b += paragraph(82, 541, 'И решение ИТ «чинить», и решение оператора по деньгам возвращают заявку в «В работу». Отклонение требует причину; исправленная смета предъявляется новой ревизией.', 940, 14, { fill: C.text, lineHeight: 21 });

  b += text(55, 648, 'Когда нужен закрывающий документ', 24, { fill: C.ink, weight: 700 });
  b += rect(55, 690, 490, 300, { fill: C.redSoft, stroke: '#ffccc7', r: 14 });
  b += circle(94, 742, 23, { fill: C.red });
  b += text(94, 750, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(130, 735, 'Внешний сервис + обслуживание', 19, { fill: C.red, weight: 700 });
  b += paragraph(82, 791, 'До перехода в «Решена» приложите хотя бы один документ:', 420, 15, { fill: C.text, lineHeight: 22 });
  b += bullet(82, 850, 'акт выполненных работ', 390, { color: C.red, size: 14, lineHeight: 20 });
  b += bullet(82, 894, 'счёт', 390, { color: C.red, size: 14, lineHeight: 20 });
  b += bullet(82, 938, 'гарантийный талон', 390, { color: C.red, size: 14, lineHeight: 20 });

  b += rect(578, 690, 490, 300, { fill: C.greenSoft, stroke: '#b7eb8f', r: 14 });
  b += circle(617, 742, 23, { fill: C.green });
  b += check(605, 744, '#fff');
  b += text(653, 735, 'Документ не требуется', 19, { fill: C.green, weight: 700 });
  b += paragraph(605, 791, 'Работу можно предъявить без платёжной бумаги, если:', 420, 15, { fill: C.text, lineHeight: 22 });
  b += bullet(605, 850, 'обслуживание делает свой сотрудник', 390, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(605, 894, 'это заявка вида «Расходники»', 390, { color: C.green, size: 14, lineHeight: 20 });
  b += bullet(605, 938, 'внешний сервис не назначен', 390, { color: C.green, size: 14, lineHeight: 20 });

  b += text(55, 1060, 'После статуса «Решена»', 24, { fill: C.ink, weight: 700 });
  b += rect(55, 1102, 1013, 215, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  b += statusBox(82, 1155, 180, 'Решена', '#7cb305', '#fcffe6', 'отсчёт начался');
  b += arrow(282, 1207, 492, 1207, { stroke: C.blue, sw: 4 });
  b += circle(385, 1207, 39, { fill: C.blueSoft, stroke: C.blue, sw: 2 });
  b += text(385, 1201, '24', 21, { fill: C.blue, weight: 700, anchor: 'middle' });
  b += text(385, 1225, 'часа', 11, { fill: C.blue, anchor: 'middle' });
  b += statusBox(515, 1155, 180, 'Закрыта', C.green, C.greenSoft, 'Порталом');
  b += text(740, 1185, 'Оператор может закрыть раньше', 15, { fill: C.ink, weight: 700 });
  b += paragraph(740, 1217, 'или вернуть работу на доработку. Автозакрытие записывается как действие системы — «Портал (автоматически)».', 285, 13, { fill: C.muted, lineHeight: 19 });

  b += rect(55, 1360, 1013, 70, { fill: C.graySoft, stroke: C.line, r: 10 });
  b += text(82, 1404, 'Отложенная заявка не автозакрывается: заморозка останавливает рабочий ход и отсчёт.', 15, { fill: C.text, weight: 600 });
  b += footer();
  return document(b);
}

function page14() {
  let b = header(
    14,
    'Очереди, подсказки и заморозка',
    '13. Ежедневная работа со списком',
    'Состояние в списке показывает не только статус, но и чьего шага ждёт заявка. Главная подпись «Вам: …» ведёт прямо к нужному действию.',
  );

  b += rect(55, 225, 1013, 560, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += pill(82, 260, 'Все заявки', { fill: C.blue, color: '#fff', size: 14, pad: 14 }).svg;
  b += pill(214, 260, 'Требуют решения', { fill: C.blueSoft, color: C.blue, size: 14, pad: 14 }).svg;
  b += pill(389, 260, 'Срочные', { fill: C.redSoft, color: C.red, size: 14, pad: 14 }).svg;
  b += pill(492, 260, 'Ожидаются документы', { fill: C.orangeSoft, color: C.orange, size: 14, pad: 14 }).svg;
  b += button(865, 256, 158, 'Создать заявку', { primary: true, compact: true, icon: '+' });
  const widths = [90, 215, 175, 210, 145, 100];
  b += tableHeader(82, 333, widths, ['№', 'Техника', 'Состояние', 'Заказчик', 'Исполнители', 'Возраст']);
  b += tableRow(82, 375, widths, ['СО-148', 'Ricoh IM 350 · 02411', 'Вам: назначить исполнителей', 'АЛ13 · Бухгалтерия', '—', '2 ч'], { fill: C.bluePale, weights: [700, 600, 600], colors: [C.blue, C.text, C.blue] });
  b += tableRow(82, 445, widths, ['СО-146', 'Kyocera M3145 · 01802', 'Ждёт ИТ: решить по смете', 'АЛ14 · ИТ', 'Иванов И. И.', '6 ч'], { weights: [700, 600, 600], colors: [C.text, C.text, C.purple] });
  b += tableRow(82, 515, widths, ['СО-139', 'Ricoh MP 201 · 01428', 'Отложена: ждём деталь', 'Офис · АХО', 'КопиЛайт', '4 д'], { fill: C.graySoft, weights: [700, 600, 600], colors: [C.text, C.text, C.muted] });
  b += tableRow(82, 585, widths, ['СО-135', 'Pantum P2500W · 02011', 'Вам: принять работу', 'АЛ13 · Приёмная', 'Петрова А. С.', '20 ч'], { weights: [700, 600, 600], colors: [C.text, C.text, C.green] });
  b += tableRow(82, 655, widths, ['СО-122', 'Ricoh IM 350 · 02118', 'Закрыта автоматически', 'АЛ14 · Отдел 3', 'КопиЛайт', '—'], { fill: '#fcfdff', colors: [C.text, C.text, C.green] });
  b += text(82, 760, 'Список по умолчанию сортируется по возрасту в текущем статусе: сверху — то, что ждёт дольше.', 13, { fill: C.muted });

  b += text(55, 850, 'Четыре очереди', 24, { fill: C.ink, weight: 700 });
  b += callout(55, 888, 240, 190, '1', 'Все заявки', 'Полный рабочий реестр с фильтрами по статусу, объекту, отделу, типу и исполнителю.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(312, 888, 240, 190, '2', 'Требуют решения', 'Только заявки, где сейчас ждут вашего шага: назначения, визы, суммы или приёмки.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(569, 888, 240, 190, '3', 'Срочные', 'Отдельный вход в работу. Срочность не меняют, пока заявка отложена.', { fill: C.redSoft, stroke: '#ffccc7', dotFill: C.red });
  b += callout(826, 888, 242, 190, '4', 'Документы', 'Заявки внешнему сервису, где до предъявления работы ещё нужен акт, счёт или талон.', { fill: C.orangeSoft, stroke: '#ffd591', dotFill: C.orange });

  b += rect(55, 1120, 1013, 310, { fill: '#fff', stroke: C.line, r: 14 });
  b += text(82, 1162, 'Когда использовать «Отложить»', 21, { fill: C.ink, weight: 700 });
  b += bullet(82, 1210, 'ждём поставку детали или решения, без которого работа не движется;', 450, { color: C.muted, size: 14, lineHeight: 20 });
  b += bullet(82, 1264, 'нужно остановить автозакрытие уже решённой заявки;', 450, { color: C.muted, size: 14, lineHeight: 20 });
  b += bullet(82, 1318, 'причина обязательна — она видна в состоянии списка.', 450, { color: C.muted, size: 14, lineHeight: 20 });
  b += path('M 555 1190 L 555 1388', { stroke: C.line, sw: 2 });
  b += text(595, 1162, 'Как возобновить', 21, { fill: C.green, weight: 700 });
  b += numberDot('1', 616, 1212, { fill: C.green, radius: 16 });
  b += paragraph(645, 1210, 'Откройте меню строки и нажмите «Возобновить».', 360, 14, { fill: C.text, lineHeight: 20 });
  b += numberDot('2', 616, 1282, { fill: C.green, radius: 16 });
  b += paragraph(645, 1280, 'Заявка вернётся именно в тот статус, из которого её отложили.', 360, 14, { fill: C.text, lineHeight: 20 });
  b += numberDot('3', 616, 1352, { fill: C.green, radius: 16 });
  b += paragraph(645, 1350, 'Возраст шага начнётся заново — исполнитель не наследует время паузы.', 360, 14, { fill: C.text, lineHeight: 20 });
  b += footer();
  return document(b);
}

function page15() {
  let b = header(
    15,
    'Обсуждение заявки',
    '14. Переписка по заявке',
    'Обсуждение заменило «Примечание исполнителя»: реплики не затирают друг друга, у каждой видно автора, время и адресата. Текст читают все, кому видна заявка.',
  );

  // ── Окно обсуждения ──
  b += rect(55, 225, 640, 700, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 273, 'Обсуждение СО-146', 22, { fill: C.ink, weight: 700 });
  b += text(82, 303, 'Kyocera M3145 · 01802 · АЛ14 · ИТ · В работе', 13, { fill: C.muted });
  b += line(82, 328, 668, 328, { stroke: C.line });

  const replies = [
    {
      y: 350,
      author: 'Автор неизвестен',
      authorColor: C.muted,
      when: '~14.06.2026 · дата приблизительная',
      tag: 'перенесено из примечания',
      tagFill: '#f0f0f0',
      tagColor: C.muted,
      body: 'Ждём ролик подачи от поставщика.',
      fill: C.graySoft,
      stroke: C.line,
    },
    {
      y: 468,
      author: 'Петрова А. С. · Ведение',
      authorColor: C.ink,
      when: '26.08.2026 10:12',
      tag: 'Сервисному центру',
      tagFill: C.orangeSoft,
      tagColor: C.orange,
      body: 'Смету согласовали. Когда сможете забрать аппарат?',
      fill: '#fff',
      stroke: C.line,
    },
    {
      y: 586,
      author: 'КопиЛайт · сервис',
      authorColor: C.ink,
      when: '26.08.2026 11:40',
      tag: 'Заявителю',
      tagFill: C.blueSoft,
      tagColor: C.blue,
      body: 'Заберём завтра до 12:00 — подготовьте доступ в кабинет.',
      fill: C.bluePale,
      stroke: '#bae0ff',
    },
  ];
  replies.forEach((reply) => {
    b += rect(82, reply.y, 586, 108, { fill: reply.fill, stroke: reply.stroke, r: 10 });
    b += text(101, reply.y + 30, reply.author, 15, { fill: reply.authorColor, weight: 700 });
    const tag = pill(0, 0, reply.tag, { size: 11, pad: 9 });
    b += pill(649 - tag.width, reply.y + 13, reply.tag, {
      fill: reply.tagFill,
      color: reply.tagColor,
      size: 11,
      pad: 9,
    }).svg;
    b += text(101, reply.y + 55, reply.when, 12, { fill: C.faint });
    b += paragraph(101, reply.y + 85, reply.body, 548, 14, { fill: C.text, lineHeight: 20, maxLines: 1 });
  });

  b += line(82, 712, 668, 712, { stroke: C.line });
  b += input(82, 730, 586, 'Кому', 'Заявителю ×   Сервисному центру ×', { suffix: '⌄' });
  b += input(82, 800, 586, 'Реплика', 'Ждём запчасть от поставщика, обещают к 3-му');
  b += button(571, 866, 97, 'Отправить', { primary: true, compact: true });

  // ── Пояснения справа ──
  b += callout(730, 225, 338, 210, '1', 'Где открыть', 'Кнопка «Обсуждение» внизу карточки заявки — рядом с ней число реплик. Пункт «Обсуждение» в меню строки списка. И метка у номера, если по заявке написали новое.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(730, 470, 338, 210, '2', 'Кому адресовать', 'Всем участникам, Заявителю, Сервисному центру, Системному администратору, Оргтехнике (ведение) — и поимённо назначенным исполнителям. Можно несколько сразу.', { fill: C.purpleSoft, stroke: '#d3adf7', dotFill: C.purple });
  b += callout(730, 715, 338, 210, '3', 'Кто может писать', 'Стороны заявки и её автор. Коллега по отделу переписку читает, но не отвечает. В закрытой и отменённой заявке лента только читается.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  // ── Подсветка непрочитанного ──
  b += text(55, 985, 'Как узнать, что написали', 24, { fill: C.ink, weight: 700 });
  b += text(410, 985, '— прочитанным становится всё обсуждение сразу, как только вы открыли окно', 14, { fill: C.muted });
  b += callout(55, 1015, 245, 195, '1', 'Яркая метка', 'Синий кружок с числом у номера заявки: столько новых реплик адресовано вам.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(311, 1015, 245, 195, '2', 'Блёклая точка', 'Серая точка без числа: по вашей заявке идёт переписка, но адресована не вам.', { fill: C.graySoft, stroke: C.line, dotFill: C.muted });
  b += callout(567, 1015, 245, 195, '3', 'Счётчик в меню', 'Синее число у пункта «Орг.техника» считает только адресованное вам.', { fill: C.bluePale, stroke: '#bae0ff' });
  b += callout(823, 1015, 245, 195, '4', 'Отметить все', 'Кнопка над списком гасит метки по всем заявкам текущего отбора сразу.', { fill: C.greenSoft, stroke: '#b7eb8f', dotFill: C.green });

  // ── Две границы, о которых узнают поздно ──
  b += rect(55, 1245, 1013, 110, { fill: C.goldSoft, stroke: '#ffe58f', r: 12 });
  b += text(82, 1284, 'Адресат — пометка, а не секретность', 18, { fill: C.gold, weight: 700 });
  b += paragraph(82, 1314, 'Текст реплики видят все, кому видна заявка: адресат решает только, у кого она подсветится ярко. Написанное «Сервисному центру» прочитает и заказчик — приватной переписки по заявке в портале нет.', 940, 14, { fill: C.text, lineHeight: 21, maxLines: 2 });

  b += rect(55, 1380, 1013, 110, { fill: C.redSoft, stroke: '#ffccc7', r: 12 });
  b += text(82, 1419, 'Нельзя', 18, { fill: C.red, weight: 700 });
  b += paragraph(82, 1449, 'Править и удалять реплики — ни свои, ни чужие: ошибку исправляют следующей репликой. И не ждите письма о новой реплике: уведомлений пока нет, следите по меткам в портале.', 940, 14, { fill: C.text, lineHeight: 21, maxLines: 2 });
  b += footer();
  return document(b);
}

function page16() {
  let b = header(
    16,
    'Перед обучением и выпуском',
    '15. Граница готовности',
    'Инструкция описывает целевой пользовательский поток. Перед публикацией сверьте незавершённые волны с фактической сборкой.',
  );

  b += rect(55, 230, 1013, 295, { fill: C.greenSoft, stroke: '#b7eb8f', r: 16 });
  b += circle(98, 282, 24, { fill: C.green });
  b += check(85, 283, '#fff');
  b += text(140, 276, 'Уже отражено в текущем интерфейсе', 22, { fill: C.ink, weight: 700 });
  const ready = [
    'справочник моделей и выбор модели в карточке техники;',
    'картриджи и тонеры, совместимость, столбец «Правка остатка» и окно «История остатка»;',
    'блок «Чем заправлять» в карточке аппарата;',
    'два вида заявки — «Обслуживание» и «Расходники» — и общее для обоих поле «Описание»;',
    'поимённые исполнители, новые подписи статусов, заморозка и очереди;',
    'виза ИТ по смете, правило закрывающего документа и автозакрытие;',
    'обсуждение заявки вместо примечания исполнителя и метки непрочитанного.',
  ];
  ready.forEach((item, i) => {
    const x = i < 4 ? 82 : 590;
    const y = i < 4 ? 330 + i * 48 : 330 + (i - 4) * 64;
    b += bullet(x, y, item, i < 4 ? 470 : 430, { color: C.green, size: 14, lineHeight: 20, checkmark: true });
  });

  b += rect(55, 560, 1013, 315, { fill: C.orangeSoft, stroke: '#ffd591', r: 16 });
  b += circle(98, 612, 24, { fill: C.orange });
  b += text(98, 620, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(140, 606, 'Не объявлять доступным до финальной проверки', 22, { fill: C.ink, weight: 700 });
  b += callout(82, 670, 450, 160, '1', 'Вкладка «Расходники» и закупка', 'Своя вкладка раздела, плановая потребность и документ закупки едут следующим выпуском: пока расходники ведут в «Справочниках».', { fill: '#fff', stroke: '#ffd591', dotFill: C.orange });
  b += callout(558, 670, 482, 160, '2', 'Заявка без выбранной техники', 'Возможность завести заявку, не указывая аппарат, готовится отдельно: сегодня «Какой аппарат» обязателен для всех.', { fill: '#fff', stroke: '#ffd591', dotFill: C.orange });

  b += rect(55, 910, 1013, 185, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += text(82, 952, 'Переход старых заявок', 21, { fill: C.blue, weight: 700 });
  b += paragraph(82, 992, 'До отдельной миграции старые строки могут показывать «Согласована ИТ» и «Диагностика». Новые заявки по целевому флоу в эти статусы не переводятся. После cutover проверьте отсутствие живых заявок в двух legacy-статусах и только затем используйте слайд 11 без оговорки.', 940, 15, { fill: C.text, lineHeight: 23 });

  b += text(55, 1160, 'Финальный чек-лист администратора', 24, { fill: C.ink, weight: 700 });
  const finalChecks = [
    'Выданы три набора: «Ведение», «ИТ-служба», «Номенклатура».',
    'У расходников разделены права на карточку и на остаток.',
    'Для каждой активной модели настроен хотя бы один подходящий расходник.',
    'Нулевые остатки сверены, первые значения внесены с причинами.',
    'Тестовая заявка прошла назначение, смету, решение, приёмку и автозакрытие.',
    'Письма о назначении и закрытии проверены на тестовых адресатах.',
  ];
  finalChecks.forEach((item, i) => {
    const x = 55 + (i % 2) * 516;
    const y = 1208 + Math.floor(i / 2) * 80;
    b += circle(x + 17, y - 5, 12, { fill: '#fff', stroke: C.blue, sw: 2 });
    b += paragraph(x + 43, y, item, 445, 14, { fill: C.text, lineHeight: 20, maxLines: 2 });
  });

  b += rect(55, 1460, 1013, 38, { fill: C.blue, r: 9 });
  b += text(561, 1486, 'После этой проверки презентацию можно использовать как пользовательскую инструкцию', 14, { fill: '#fff', weight: 600, anchor: 'middle' });
  b += footer('Инструкция • целевой пользовательский поток • 31.08.2026');
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
];

for (const [index, svg] of pages.entries()) {
  const stem = `office-equipment-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Оргтехника: справочники и заявки — пользовательская инструкция');
pdf.setSubject('Новые функции оргтехники, справочники расходников и обновлённый цикл заявок');
pdf.setKeywords(['оргтехника', 'картриджи', 'тонеры', 'заявки', 'статусы', 'инструкция']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-08-31T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `office-equipment-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
