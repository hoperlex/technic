import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(
  process.argv[2] ?? 'docs/Краткая_инструкция_Рассылки_и_оповещения_оргтехники.pdf',
);
const WORK = mkdtempSync(join(tmpdir(), 'mailing-office-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 6;

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

function iconGear(x, y, size = 32, color = C.blue) {
  return (
    circle(x + size / 2, y + size / 2, size * 0.34, { fill: 'none', stroke: color, sw: 3 }) +
    circle(x + size / 2, y + size / 2, size * 0.12, { fill: 'none', stroke: color, sw: 3 }) +
    path(
      `M ${x + size / 2} ${y} V ${y + 6} M ${x + size / 2} ${y + size - 6} V ${y + size} M ${x} ${y + size / 2} H ${x + 6} M ${x + size - 6} ${y + size / 2} H ${x + size}`,
      { stroke: color, sw: 3 },
    )
  );
}

function numberDot(number, x, y, color = C.blue, radius = 18) {
  return (
    circle(x, y, radius, { fill: color, stroke: '#fff', sw: 4, shadow: true }) +
    text(x, y + 7, number, 20, { fill: '#fff', weight: 700, anchor: 'middle' })
  );
}

function pill(x, y, label, options = {}) {
  const { fill = C.blueSoft, color = C.blue, size = 13, pad = 10, stroke = 'none' } = options;
  const width = Math.max(48, label.length * size * 0.61 + pad * 2);
  return {
    width,
    svg:
      rect(x, y, width, size + 15, { fill, stroke, r: (size + 15) / 2 }) +
      text(x + width / 2, y + size + 1, label, size, { fill: color, weight: 600, anchor: 'middle' }),
  };
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
  if (suffix) out += text(x + width - 12, y + 10 + height / 2 + 5, suffix, 14, { fill: C.muted, anchor: 'end' });
  return out;
}

function toggle(x, y, on = true) {
  const fill = on ? C.blue : '#d0d5dd';
  return (
    rect(x, y, 42, 24, { fill, r: 12 }) +
    circle(x + (on ? 30 : 12), y + 12, 9, { fill: '#fff', shadow: true })
  );
}

function checkbox(x, y, label, checked = true, options = {}) {
  const { size = 14, color = C.blue } = options;
  let out = rect(x, y, 20, 20, { fill: checked ? color : '#fff', stroke: checked ? color : '#d0d5dd', r: 4 });
  if (checked) out += path(`M ${x + 4} ${y + 10} l 4 4 l 8 -9`, { stroke: '#fff', sw: 2.5 });
  out += text(x + 29, y + 16, label, size, { fill: C.text });
  return out;
}

function bullet(x, y, value, width, options = {}) {
  const { color = C.blue, size = 16, lineHeight = 23, checkmark = false, weight = 400 } = options;
  let out = circle(x + 8, y - 5, 9, { fill: checkmark ? color : `${color}18`, stroke: color, sw: 1 });
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
  if (subtitle) out += paragraph(55, 160, subtitle, 1013, 16, { fill: C.muted, lineHeight: 23, maxLines: 2 });
  return out;
}

function footer(label = 'Портал «Техник» • краткая инструкция • 02.09.2026') {
  return (
    line(55, 1524, 1068, 1524, { stroke: C.line }) +
    text(55, 1554, label, 12, { fill: C.faint }) +
    text(1068, 1554, 'Администрирование → Рассылки', 12, { fill: C.faint, anchor: 'end' })
  );
}

function appFrame(x, y, width, height, activeTab = 'Рассылки') {
  let out = rect(x, y, width, height, { fill: '#fff', stroke: '#d0d5dd', r: 12, shadow: true });
  out += rect(x, y, width, 52, { fill: '#102a43', r: 12 });
  out += rect(x, y + 40, width, 12, { fill: '#102a43' });
  out += circle(x + 28, y + 26, 14, { fill: C.blue });
  out += text(x + 28, y + 31, 'Т', 14, { fill: '#fff', weight: 700, anchor: 'middle' });
  out += text(x + 52, y + 32, 'Техник', 16, { fill: '#fff', weight: 700 });
  out += text(x + width - 22, y + 32, 'Администратор', 13, { fill: '#dbeafe', anchor: 'end' });
  out += rect(x, y + 52, 150, height - 52, { fill: '#f8fafc' });
  const nav = ['Пользователи', 'Права', 'Рассылки', 'Руководства'];
  nav.forEach((item, i) => {
    const iy = y + 82 + i * 46;
    if (item === activeTab) out += rect(x + 10, iy - 24, 130, 37, { fill: C.blueSoft, r: 7 });
    out += text(x + 24, iy, item, 14, {
      fill: item === activeTab ? C.blueDark : C.muted,
      weight: item === activeTab ? 700 : 400,
    });
  });
  return out;
}

function subTabs(x, y, active) {
  let out = '';
  const tabs = [
    ['Расписания', 100],
    ['Служебные адреса', 160],
    ['Отладка', 82],
  ];
  let tx = x;
  for (const [label, width] of tabs) {
    out += text(tx + 10, y, label, 14, {
      fill: label === active ? C.blue : C.muted,
      weight: label === active ? 700 : 500,
    });
    if (label === active) out += rect(tx + 4, y + 12, width - 8, 3, { fill: C.blue, r: 1.5 });
    tx += width;
  }
  out += line(x, y + 15, tx, y + 15, { stroke: C.line });
  return out;
}

function page1() {
  let b = rect(0, 0, W, H, { fill: '#f4f8ff' });
  b += circle(905, 155, 240, { fill: '#dbeafe', opacity: 0.62 });
  b += circle(1030, 375, 135, { fill: C.cyanSoft, opacity: 0.9 });
  b += circle(122, 1380, 210, { fill: C.purpleSoft, opacity: 0.7 });
  b += pill(55, 70, 'КРАТКАЯ ИНСТРУКЦИЯ · 6 СТРАНИЦ', { fill: C.blue, color: '#fff', size: 14, pad: 14 }).svg;
  b += paragraph(55, 175, 'Рассылки и почтовые оповещения оргтехники', 760, 49, {
    fill: C.ink,
    weight: 700,
    lineHeight: 62,
    maxLines: 3,
  });
  b += paragraph(
    58,
    385,
    'Как настроить расписание, служебные адреса, отдельный канал ремонта и проверить доставку до запуска.',
    650,
    22,
    { fill: C.muted, lineHeight: 32, maxLines: 3 },
  );

  b += rect(730, 270, 300, 300, { fill: '#fff', stroke: '#bae0ff', r: 28, shadow: true });
  b += circle(880, 405, 91, { fill: C.blueSoft });
  b += iconEnvelope(823, 366, 114, C.blue);
  b += circle(957, 478, 40, { fill: C.green, stroke: '#fff', sw: 7, shadow: true });
  b += check(941, 480, '#fff', 6);

  b += text(55, 630, 'Что внутри', 25, { fill: C.ink, weight: 700 });
  const cards = [
    {
      x: 55,
      color: C.blue,
      fill: C.bluePale,
      title: 'Расписания',
      body: 'Кому, когда и за какие дни отправлять задания водителям и ролевые сводки.',
    },
    {
      x: 391,
      color: C.purple,
      fill: C.purpleSoft,
      title: 'Служебные адреса',
      body: 'Дополнительные копии по событиям оргтехники и правила обратного адреса.',
    },
    {
      x: 727,
      color: C.green,
      fill: C.greenSoft,
      title: 'Проверка',
      body: 'Тестовая отправка через нужный канал и контроль результата в заявке.',
    },
  ];
  cards.forEach((card, i) => {
    b += rect(card.x, 675, 310, 245, { fill: card.fill, stroke: `${card.color}55`, r: 18 });
    b += numberDot(i + 1, card.x + 38, 720, card.color, 20);
    b += text(card.x + 70, 727, card.title, 20, { fill: C.ink, weight: 700 });
    b += paragraph(card.x + 26, 785, card.body, 258, 16, { fill: C.text, lineHeight: 24, maxLines: 5 });
  });

  b += rect(55, 980, 982, 205, { fill: '#fff', stroke: '#b7eb8f', r: 18, shadow: true });
  b += circle(107, 1034, 25, { fill: C.green });
  b += check(94, 1036, '#fff', 4.5);
  b += text(148, 1038, 'Главное различие', 22, { fill: C.ink, weight: 700 });
  b += paragraph(
    87,
    1092,
    'Расписание — массовая отправка пользователям портала по времени. Оповещение оргтехники — письмо по событию: новая заявка, отмена или назначение исполнителя.',
    900,
    18,
    { fill: C.text, lineHeight: 27, maxLines: 3 },
  );

  b += rect(55, 1220, 982, 185, { fill: C.goldSoft, stroke: '#ffe58f', r: 18 });
  b += text(87, 1264, 'Два уровня настройки', 20, { fill: C.gold, weight: 700 });
  b += bullet(87, 1310, 'В портале: расписания, дополнительные служебные адреса, тестовая отправка.', 420, { color: C.gold, size: 16 });
  b += bullet(545, 1310, 'На сервере: SMTP, отправитель, пароль, лимит и канал repair.', 420, { color: C.gold, size: 16 });
  b += footer('Портал «Техник» • рассылки и оргтехника • 02.09.2026');
  return document(b);
}

function page2() {
  let b = header(
    2,
    '1. Карта интерфейса',
    'Где находятся настройки',
    'Нужны права «Смотрит рассылки» для просмотра и «Настраивает рассылки» для изменений.',
  );

  const x = 55;
  const y = 230;
  const width = 1013;
  const height = 620;
  b += appFrame(x, y, width, height);
  b += text(x + 180, y + 92, 'Администрирование', 23, { fill: C.ink, weight: 700 });
  b += subTabs(x + 180, y + 138, 'Расписания');
  b += text(x + 185, y + 205, 'Расписания рассылок', 18, { fill: C.ink, weight: 700 });
  b += button(x + width - 225, y + 174, 185, '+  Добавить расписание', { primary: true, compact: true });

  const tx = x + 182;
  const ty = y + 240;
  const cols = [190, 170, 80, 95, 170, 70];
  const labels = ['Название', 'Тип', 'Время', 'Дни', 'Следующий запуск', 'Вкл.'];
  b += rect(tx, ty, 790, 42, { fill: '#f2f4f7', stroke: C.line, r: 4 });
  let cx = tx;
  labels.forEach((label, i) => {
    b += text(cx + 10, ty + 27, label, 12, { fill: C.muted, weight: 700 });
    cx += cols[i];
  });
  const rows = [
    ['Водителям на завтра', 'Задание водителям', '18:00', 'Пн–Пт', '03.09.2026 18:00', true],
    ['Утренняя сводка', 'Сводка по ролям', '07:30', 'Пн–Сб', '03.09.2026 07:30', true],
    ['Сводка на выходные', 'Сводка по ролям', '16:00', 'Пт', '—', false],
  ];
  rows.forEach((row, ri) => {
    const ry = ty + 42 + ri * 57;
    b += rect(tx, ry, 790, 57, { fill: ri % 2 ? '#fcfcfd' : '#fff', stroke: C.line });
    let rx = tx;
    row.slice(0, 5).forEach((value, i) => {
      b += text(rx + 10, ry + 33, value, i === 0 ? 13 : 12, { fill: i === 0 ? C.ink : C.text, weight: i === 0 ? 600 : 400 });
      rx += cols[i];
    });
    b += toggle(tx + 720, ry + 17, row[5]);
  });
  b += rect(tx, ty + 235, 790, 98, { fill: C.graySoft, stroke: C.line, r: 7 });
  b += text(tx + 18, ty + 269, 'История запусков: выберите расписание', 14, { fill: C.ink, weight: 600 });
  b += text(tx + 18, ty + 299, 'Статус, плановое время, начало, окончание, отправлено / пропущено / ошибка', 12, { fill: C.muted });

  b += numberDot(1, x + 248, y + 138, C.blue);
  b += numberDot(2, x + 425, y + 138, C.purple);
  b += numberDot(3, x + 548, y + 138, C.green);

  b += callout(55, 905, 317, 205, '1', 'Расписания', 'Автоматическая отправка по дням недели и времени. Здесь же — запуск «сейчас», включение, правка и история.', { fill: C.bluePale, stroke: '#bae0ff', color: C.blue });
  b += callout(403, 905, 317, 205, '2', 'Служебные адреса', 'Копии писем по событиям оргтехники. Адрес не обязан принадлежать учётной записи портала.', { fill: C.purpleSoft, stroke: '#d3adf7', color: C.purple });
  b += callout(751, 905, 317, 205, '3', 'Отладка', 'Одно настоящее тестовое письмо администратору через выбранный SMTP-канал.', { fill: C.greenSoft, stroke: '#b7eb8f', color: C.green });

  b += rect(55, 1150, 1013, 255, { fill: '#fff', stroke: C.line, r: 16 });
  b += text(84, 1192, 'Возможности раздела', 21, { fill: C.ink, weight: 700 });
  const capabilities = [
    'два типа расписаний: задания водителям и сводка по правам;',
    'окно данных: первый день и продолжительность до 31 дня;',
    'исключения по датам, водителям, площадкам, отделам и получателям;',
    'ручной рабочий запуск — письма уйдут реальным адресатам;',
    'включение / пауза без удаления и история запусков;',
    'тест доставки и вёрстки с пометкой «[ТЕСТ]».',
  ];
  capabilities.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    b += bullet(84 + col * 490, 1244 + row * 57, item, 450, { color: col ? C.purple : C.blue, size: 14, lineHeight: 20 });
  });
  b += footer();
  return document(b);
}

function page3() {
  let b = header(
    3,
    '2. Расписание',
    'Как настроить автоматическую рассылку',
    'Создайте отдельное расписание для каждого типа и режима. Тип сохранённого расписания не меняется.',
  );

  b += rect(55, 225, 690, 1120, { fill: '#fff', stroke: '#d0d5dd', r: 14, shadow: true });
  b += rect(55, 225, 690, 60, { fill: '#f8fafc', stroke: C.line, r: 14 });
  b += rect(55, 273, 690, 12, { fill: '#f8fafc' });
  b += text(84, 264, 'Новое расписание', 20, { fill: C.ink, weight: 700 });
  b += field(84, 320, 300, 'Название', 'Утренняя сводка');
  b += field(412, 320, 304, 'Тип рассылки', 'Сводка по ролям', { suffix: '⌄' });
  b += text(84, 425, 'Когда', 17, { fill: C.ink, weight: 700 });
  b += line(84, 442, 716, 442, { stroke: C.line });
  b += text(84, 478, 'Дни выполнения', 13, { fill: C.text, weight: 600 });
  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'].forEach((day, i) => {
    b += checkbox(84 + i * 72, 495, day, true, { size: 13 });
  });
  b += checkbox(444, 495, 'Сб', false, { size: 13 });
  b += checkbox(516, 495, 'Вс', false, { size: 13 });
  b += field(84, 552, 190, 'Время отправки', '07:30');
  b += field(300, 552, 416, 'Даты без рассылки', '01.01.2027', { suffix: '⌄' });
  b += text(84, 655, 'За какие дни', 17, { fill: C.ink, weight: 700 });
  b += line(84, 672, 716, 672, { stroke: C.line });
  b += field(84, 702, 300, 'Первый день', 'Сегодняшний день', { suffix: '⌄' });
  b += field(412, 702, 150, 'На сколько дней', '3');
  b += text(84, 792, 'В письмо попадут данные за сегодня и ещё два дня.', 13, { fill: C.muted });
  b += text(84, 844, 'Аудитория', 17, { fill: C.ink, weight: 700 });
  b += line(84, 861, 716, 861, { stroke: C.line });
  b += field(84, 890, 632, 'Права-адресаты', 'vehicleRequests.read; waybills.read', { suffix: '⌄' });
  b += field(84, 974, 300, 'Площадки и отделы', 'Все (и будущие)', { suffix: '⌄' });
  b += field(412, 974, 304, 'Получатели', 'Все подходящие — 24', { suffix: '⌄' });
  b += text(84, 1070, 'Содержание', 17, { fill: C.ink, weight: 700 });
  b += line(84, 1087, 716, 1087, { stroke: C.line });
  b += field(84, 1115, 632, 'Охват заявок', 'Заявки его площадок и отделов', { suffix: '⌄' });
  b += checkbox(84, 1205, 'Перевозки (4-П, форма № 3)', true, { size: 14 });
  b += checkbox(380, 1205, 'Техника на объектах', true, { size: 14 });
  b += text(84, 1271, 'Включена', 13, { fill: C.text, weight: 600 });
  b += toggle(162, 1253, true);
  b += button(495, 1283, 102, 'Отмена', { compact: true });
  b += button(608, 1283, 108, 'Сохранить', { primary: true, compact: true });

  b += callout(780, 235, 288, 180, '1', 'Когда', 'Отметьте дни недели и местное время портала. Даты без рассылки подходят для праздников и остановок.', { fill: C.bluePale, stroke: '#bae0ff', color: C.blue });
  b += callout(780, 445, 288, 180, '2', 'Окно данных', 'Первый день считается от дня запуска: 0 — сегодня, 1 — завтра. Длительность — от 1 до 31 дня.', { fill: C.cyanSoft, stroke: '#87e8de', color: C.cyan });
  b += callout(780, 655, 288, 210, '3', 'Аудитория сводки', 'Письмо уйдёт людям, у которых уже есть хотя бы одно выбранное право. Расписание не выдаёт доступ и не расширяет видимость.', { fill: C.purpleSoft, stroke: '#d3adf7', color: C.purple });
  b += callout(780, 895, 288, 180, '4', 'Содержание', 'Для сводки выберите охват и хотя бы одну таблицу. У задания водителям — исключения дат и водителей.', { fill: C.greenSoft, stroke: '#b7eb8f', color: C.green });
  b += callout(780, 1105, 288, 240, '5', 'Запуск и пауза', '«Запустить сейчас» — рабочая отправка реальным адресатам и не сдвигает очередной запуск. Для паузы выключите переключатель; удаление стирает историю запусков.', { fill: C.goldSoft, stroke: '#ffe58f', color: C.gold });

  b += footer();
  return document(b);
}

function page4() {
  let b = header(
    4,
    '3. Служебные адреса',
    'Дополнительные получатели событий оргтехники',
    'Служебный адрес — рабочий ящик без учётной записи портала. Он получает отдельную копию письма по выбранному событию.',
  );

  b += appFrame(55, 225, 1013, 610);
  b += text(235, 315, 'Администрирование', 22, { fill: C.ink, weight: 700 });
  b += subTabs(235, 362, 'Служебные адреса');
  b += text(240, 430, 'Служебные адреса', 18, { fill: C.ink, weight: 700 });
  b += button(425, 401, 138, '+  Добавить адрес', { primary: true, compact: true });

  b += rect(240, 462, 798, 78, { fill: C.bluePale, stroke: '#bae0ff', r: 8 });
  b += circle(267, 488, 11, { fill: C.blue });
  b += text(267, 493, 'i', 13, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(290, 488, 'Письма службам, у которых нет учётной записи', 13, { fill: C.blueDark, weight: 700 });
  b += text(290, 514, 'Здесь задаются дополнительные копии по событиям модуля.', 12, { fill: C.muted });

  const tx = 240;
  const ty = 562;
  b += rect(tx, ty, 798, 38, { fill: '#f2f4f7', stroke: C.line, r: 4 });
  b += text(tx + 10, ty + 25, 'Событие', 12, { fill: C.muted, weight: 700 });
  b += text(tx + 370, ty + 25, 'Кому', 12, { fill: C.muted, weight: 700 });
  b += text(tx + 565, ty + 25, 'Ответ уйдёт', 12, { fill: C.muted, weight: 700 });
  const serviceRows = [
    ['Заявка ждёт разбора', 'it-service@example.ru', 'Автору заявки', true],
    ['Заявка отменена', 'dispatch@example.ru', 'Вызвавшему событие', true],
    ['Назначена исполнителю', 'chief@example.ru', 'На указанный адрес', false],
  ];
  serviceRows.forEach((row, i) => {
    const ry = ty + 38 + i * 68;
    b += rect(tx, ry, 798, 68, { fill: i % 2 ? '#fcfcfd' : '#fff', stroke: C.line });
    b += text(tx + 10, ry + 28, row[0], 12, { fill: C.ink, weight: 600 });
    b += text(tx + 370, ry + 28, row[1], 12, { fill: C.text });
    b += text(tx + 565, ry + 28, row[2], 11, { fill: C.text });
    if (!row[3]) b += pill(tx + 370, ry + 36, 'Выключен', { fill: '#f2f4f7', color: C.muted, size: 10, pad: 8 }).svg;
    b += text(tx + 759, ry + 30, '✎  ⋮', 18, { fill: C.muted, anchor: 'end' });
  });

  b += numberDot(1, 474, 420, C.blue);
  b += numberDot(2, 890, 650, C.purple);

  b += rect(55, 880, 650, 525, { fill: '#fff', stroke: '#d0d5dd', r: 14, shadow: true });
  b += rect(55, 880, 650, 58, { fill: '#f8fafc', stroke: C.line, r: 14 });
  b += rect(55, 926, 650, 12, { fill: '#f8fafc' });
  b += text(84, 918, 'Новый служебный адрес', 19, { fill: C.ink, weight: 700 });
  b += field(84, 972, 592, 'Событие', 'Заявка на обслуживание отменена', { suffix: '⌄' });
  b += field(84, 1056, 592, 'Адрес службы', 'dispatch@example.ru');
  b += field(84, 1140, 592, 'Куда уйдёт ответ', 'Тому, кто вызвал событие', { suffix: '⌄' });
  b += field(84, 1224, 592, 'Запасной адрес ответа', 'operator@example.ru');
  b += text(84, 1316, 'Рассылка включена', 13, { fill: C.text, weight: 600 });
  b += toggle(225, 1297, true);
  b += button(462, 1340, 98, 'Отмена', { compact: true });
  b += button(571, 1340, 105, 'Сохранить', { primary: true, compact: true });

  b += callout(740, 900, 328, 195, '1', 'Событие + адрес', 'Один адрес можно добавить к нескольким событиям отдельными строками. У сохранённой строки событие не меняется.', { fill: C.bluePale, stroke: '#bae0ff', color: C.blue });
  b += callout(740, 1120, 328, 285, '2', 'Обратный адрес Reply-To', '«Указанный адрес» требует адрес. «Автору» и «Вызвавшему» допускают запасной. «Общий адрес портала» берёт MAIL_REPLY_TO и запасного поля не имеет.', { fill: C.purpleSoft, stroke: '#d3adf7', color: C.purple });

  b += footer();
  return document(b);
}

function page5() {
  let b = header(
    5,
    '4. Оргтехника',
    'Кому и когда уходят письма',
    'Письма модуля отправляются отдельным каналом repair. Основной адресат и дополнительные копии зависят от события.',
  );

  b += rect(55, 225, 1013, 120, { fill: C.bluePale, stroke: '#bae0ff', r: 16 });
  b += iconEnvelope(87, 266, 44, C.blue);
  b += text(153, 268, 'Канал repair', 21, { fill: C.ink, weight: 700 });
  b += paragraph(153, 300, 'Отправитель и основной ящик службы задаются на сервере. Служебные строки из интерфейса добавляют копии и не заменяют адресата события.', 870, 15, { fill: C.text, lineHeight: 22, maxLines: 2 });

  const events = [
    {
      y: 390,
      color: C.blue,
      fill: C.bluePale,
      step: '01',
      title: 'Новая заявка / возврат в «Новую»',
      to: 'ящик канала repair + включённые копии события',
      note: 'Если заявка уже назначена, повторное письмо о разборе недоступно.',
    },
    {
      y: 575,
      color: C.red,
      fill: C.redSoft,
      step: '02',
      title: 'Заявка отменена',
      to: 'ящик канала repair + включённые копии события',
      note: 'Смысл письма — предупредить службу, чтобы не выезжали зря.',
    },
    {
      y: 760,
      color: C.purple,
      fill: C.purpleSoft,
      step: '03',
      title: 'Назначены или изменены исполнители',
      to: 'назначенные сотрудники / операторы подрядчика + копии',
      note: 'Заявителю письмо не уходит; он видит движение заявки в портале.',
    },
  ];
  events.forEach((event) => {
    b += rect(55, event.y, 1013, 150, { fill: '#fff', stroke: `${event.color}55`, r: 16, shadow: true });
    b += rect(55, event.y, 112, 150, { fill: event.fill, r: 16 });
    b += rect(145, event.y, 22, 150, { fill: event.fill });
    b += text(111, event.y + 66, event.step, 30, { fill: event.color, weight: 700, anchor: 'middle' });
    b += iconEnvelope(94, event.y + 87, 34, event.color);
    b += text(195, event.y + 39, event.title, 18, { fill: C.ink, weight: 700 });
    b += pill(195, event.y + 57, `Кому: ${event.to}`, { fill: event.fill, color: event.color, size: 12, pad: 11 }).svg;
    b += paragraph(195, event.y + 113, event.note, 815, 13, { fill: C.muted, lineHeight: 20, maxLines: 2 });
  });

  b += rect(55, 980, 620, 380, { fill: '#fff', stroke: '#d0d5dd', r: 16, shadow: true });
  b += rect(55, 980, 620, 56, { fill: '#f8fafc', stroke: C.line, r: 16 });
  b += rect(55, 1024, 620, 12, { fill: '#f8fafc' });
  b += text(84, 1017, 'Действия заявки', 18, { fill: C.ink, weight: 700 });
  const menu = [
    'Открыть карточку',
    'Обсуждение',
    'Записать перемещение техники',
    'Отправить письмо службе ещё раз',
  ];
  menu.forEach((item, i) => {
    const my = 1065 + i * 58;
    b += rect(76, my - 28, 578, 47, {
      fill: i === 3 ? C.bluePale : '#fff',
      stroke: i === 3 ? '#bae0ff' : C.line,
      r: 7,
    });
    if (i === 3) b += iconEnvelope(94, my - 16, 25, C.blue);
    b += text(i === 3 ? 132 : 94, my + 2, item, 15, {
      fill: i === 3 ? C.blueDark : C.text,
      weight: i === 3 ? 700 : 400,
    });
  });
  b += rect(76, 1302, 578, 42, { fill: C.greenSoft, stroke: '#b7eb8f', r: 8 });
  b += text(94, 1328, 'Письмо поставлено в очередь: repair@example.ru, it@example.ru', 12, { fill: C.green, weight: 600 });

  b += callout(710, 990, 358, 170, '1', 'Повторная отправка', 'Доступна оператору в «Новой» заявке без исполнителей и в отменённой заявке. Успех показывает адресатов.', { fill: C.bluePale, stroke: '#bae0ff', color: C.blue });
  b += callout(710, 1185, 358, 175, '2', 'Почта не блокирует заявку', 'Если почта выключена, канал не настроен или письмо не собралось, действие сохраняется, а портал показывает предупреждение.', { fill: C.goldSoft, stroke: '#ffe58f', color: C.gold });

  b += footer();
  return document(b);
}

function page6() {
  let b = header(
    6,
    '5. Проверка и запуск',
    'Чек-лист администратора',
    'Сначала настройте канал на сервере, затем проверьте его из интерфейса и только после этого включайте рабочие сценарии.',
  );

  b += rect(55, 225, 470, 570, { fill: '#fff', stroke: '#d0d5dd', r: 16, shadow: true });
  b += text(84, 267, 'Отладочная отправка', 21, { fill: C.ink, weight: 700 });
  b += rect(84, 292, 412, 72, { fill: C.goldSoft, stroke: '#ffe58f', r: 8 });
  b += text(105, 321, '[ТЕСТ] Письмо уходит по-настоящему', 13, { fill: C.gold, weight: 700 });
  b += text(105, 345, 'Получатель — только действующий администратор.', 12, { fill: C.muted });
  b += field(84, 398, 412, 'Тип письма', 'Уведомление о смене пароля', { suffix: '⌄' });
  b += field(84, 482, 412, 'Канал отправки', 'Ящик службы ремонта — repair@…', { suffix: '⌄' });
  b += field(84, 566, 412, 'Получатель', 'Администратор — admin@…', { suffix: '⌄' });
  b += button(84, 666, 160, 'Отправить тест', { primary: true });
  b += text(84, 744, 'Проверьте: доставку, отправителя, тему, Reply-To, вид на телефоне.', 12, { fill: C.muted });

  b += rect(555, 225, 513, 570, { fill: '#101828', stroke: '#101828', r: 16, shadow: true });
  b += text(586, 269, 'Настройка сервера · prod.env', 19, { fill: '#fff', weight: 700 });
  const env = [
    ['MAIL_ENABLED', 'true'],
    ['MAIL_TRANSPORT', 'smtp'],
    ['MAIL_ACCOUNT_REPAIR_HOST', 'smtp.example.ru'],
    ['MAIL_ACCOUNT_REPAIR_PORT', '465'],
    ['MAIL_ACCOUNT_REPAIR_SECURE', 'true'],
    ['MAIL_ACCOUNT_REPAIR_AUTH_METHOD', 'LOGIN'],
    ['MAIL_ACCOUNT_REPAIR_USER', 'repair@example.ru'],
    ['MAIL_ACCOUNT_REPAIR_PASSWORD', '••••••••••'],
    ['MAIL_ACCOUNT_REPAIR_FROM', 'Ремонт <repair@example.ru>'],
    ['MAIL_ACCOUNT_REPAIR_MAX_PER_MINUTE', '20'],
  ];
  env.forEach(([key, value], i) => {
    const ey = 315 + i * 42;
    b += text(586, ey, key, 9, { fill: '#93c5fd', weight: 600 });
    b += text(875, ey, '=', 10, { fill: '#667085' });
    b += text(895, ey, value, 9, { fill: '#d1fadf' });
  });
  b += rect(586, 738, 451, 34, { fill: '#1f2937', r: 6 });
  b += text(602, 760, 'Секреты не хранятся в портале и не коммитятся в git.', 11, { fill: '#fef3c7' });

  b += text(55, 852, 'Порядок проверки', 23, { fill: C.ink, weight: 700 });
  const steps = [
    ['1', 'Сервер', 'Заполните SMTP канала repair, проверьте порт/TLS и DNS домена: SPF, DKIM, DMARC.', C.blue, C.bluePale],
    ['2', 'Отладка', 'Администрирование → Рассылки → Отладка. Выберите repair и отправьте тест администратору.', C.purple, C.purpleSoft],
    ['3', 'Служебные копии', 'Добавьте нужные адреса по событиям, настройте Reply-To и включите строки.', C.cyan, C.cyanSoft],
    ['4', 'Рабочий сценарий', 'Создайте тестовую заявку, назначьте исполнителя, отмените её и проверьте нужные ящики.', C.green, C.greenSoft],
  ];
  steps.forEach(([num, titleValue, body, color, fill], i) => {
    const sy = 895 + i * 106;
    b += rect(55, sy, 1013, 84, { fill, stroke: `${color}55`, r: 13 });
    b += numberDot(num, 91, sy + 42, color, 18);
    b += text(126, sy + 34, titleValue, 16, { fill: C.ink, weight: 700 });
    b += paragraph(325, sy + 31, body, 710, 14, { fill: C.text, lineHeight: 21, maxLines: 2 });
  });

  b += rect(55, 1345, 1013, 118, { fill: C.redSoft, stroke: '#ffccc7', r: 14 });
  b += text(84, 1383, 'Если письмо не пришло', 18, { fill: C.red, weight: 700 });
  b += paragraph(84, 1418, 'Проверьте предупреждение в портале, выбранный канал, адрес и папку «Спам». Ненастроенный repair не останавливает основной канал; его письма ждут настройки.', 930, 14, { fill: C.text, lineHeight: 21, maxLines: 2 });
  b += footer('Портал «Техник» • готово к передаче администратору • 02.09.2026');
  return document(b);
}

const pages = [page1(), page2(), page3(), page4(), page5(), page6()];

for (const [index, svg] of pages.entries()) {
  const stem = `mailing-office-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Рассылки и почтовые оповещения оргтехники — краткая инструкция');
pdf.setSubject('Настройка расписаний, служебных адресов и почтового канала ремонта');
pdf.setKeywords(['рассылки', 'почта', 'служебные адреса', 'оргтехника', 'SMTP', 'инструкция']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-02T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `mailing-office-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
