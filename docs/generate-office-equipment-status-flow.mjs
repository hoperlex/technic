import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(
  process.argv[2] ?? 'docs/Инфографика_движение_статусов_заявок_оргтехника.pdf',
);
const WORK = mkdtempSync(join(tmpdir(), 'office-status-flow-'));
const W = 1600;
const H = 900;
const SLIDE_COUNT = 7;

const C = {
  navy: '#0b1930',
  ink: '#17233a',
  text: '#33415c',
  muted: '#6b7892',
  faint: '#a8b2c5',
  line: '#dfe5ef',
  bg: '#f5f7fb',
  panel: '#ffffff',
  blue: '#1677ff',
  blueDark: '#0958d9',
  blueSoft: '#eaf3ff',
  cyan: '#08979c',
  cyanSoft: '#e6fffb',
  orange: '#d46b08',
  orangeSoft: '#fff4e5',
  gold: '#d48806',
  goldSoft: '#fff8d8',
  green: '#389e0d',
  greenSoft: '#f0fae8',
  lime: '#7cb305',
  limeSoft: '#f8ffe8',
  red: '#cf1322',
  redSoft: '#fff0f0',
  purple: '#722ed1',
  purpleSoft: '#f5edff',
  graySoft: '#f1f3f7',
  gray: '#7e8797',
};

const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

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

function wrap(value, width, size, weight = 400) {
  const words = String(value).trim().split(/\s+/);
  const lines = [];
  let current = '';
  const factor = weight >= 650 ? 0.59 : 0.55;
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

function paragraph(x, y, value, width, size = 22, options = {}) {
  const { lineHeight = Math.round(size * 1.35), maxLines, ...textOptions } = options;
  let lines = wrap(value, width, size, textOptions.weight);
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:]?$/, '')}…`;
  }
  return lines
    .map((lineValue, index) =>
      text(x, y + index * lineHeight, lineValue, size, textOptions),
    )
    .join('');
}

function rect(x, y, width, height, options = {}) {
  const {
    fill = 'none',
    stroke = 'none',
    sw = 1,
    r = 0,
    opacity = 1,
    shadow = false,
    dash,
  } = options;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${shadow ? ' filter="url(#shadow)"' : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function line(x1, y1, x2, y2, options = {}) {
  const { stroke = C.line, sw = 2, dash, opacity = 1 } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function path(d, options = {}) {
  const { fill = 'none', stroke = C.text, sw = 2, dash, opacity = 1 } = options;
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function circle(cx, cy, radius, options = {}) {
  const { fill = 'none', stroke = 'none', sw = 1, opacity = 1 } = options;
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
}

function arrow(x1, y1, x2, y2, options = {}) {
  const { stroke = C.blue, sw = 4, dash, marker = 'arrow-blue' } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${marker})"/>`;
}

function arrowPath(d, options = {}) {
  const { stroke = C.blue, sw = 4, dash, marker = 'arrow-blue' } = options;
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${marker})"/>`;
}

function pill(x, y, label, options = {}) {
  const {
    fill = C.blueSoft,
    color = C.blue,
    stroke = 'none',
    size = 18,
    pad = 15,
    height = 40,
    weight = 650,
  } = options;
  const width = Math.max(70, label.length * size * 0.59 + pad * 2);
  return {
    width,
    svg:
      rect(x, y, width, height, { fill, stroke, r: height / 2 }) +
      text(x + width / 2, y + height / 2 + size * 0.35, label, size, {
        fill: color,
        weight,
        anchor: 'middle',
      }),
  };
}

function statusCard(x, y, width, titleValue, subtitle, options = {}) {
  const {
    color = C.blue,
    soft = C.blueSoft,
    index,
    terminal = false,
    height = 150,
    titleSize = 27,
  } = options;
  let output = rect(x, y, width, height, {
    fill: C.panel,
    stroke: terminal ? color : C.line,
    sw: terminal ? 2 : 1,
    r: 22,
    shadow: true,
  });
  output += rect(x, y, width, 10, { fill: color, r: 6 });
  if (index !== undefined) {
    output += circle(x + 32, y + 43, 18, { fill: soft, stroke: color, sw: 1 });
    output += text(x + 32, y + 50, index, 18, { fill: color, weight: 750, anchor: 'middle' });
  }
  output += paragraph(x + (index !== undefined ? 62 : 24), y + 53, titleValue, width - (index !== undefined ? 78 : 48), titleSize, {
    fill: C.ink,
    weight: 750,
    lineHeight: titleSize + 5,
    maxLines: 2,
  });
  output += paragraph(x + 24, y + height - 48, subtitle, width - 48, 17, {
    fill: C.muted,
    lineHeight: 22,
    maxLines: 2,
  });
  return output;
}

function miniStatus(x, y, width, label, options = {}) {
  const { color = C.blue, soft = C.blueSoft, size = 20 } = options;
  return (
    rect(x, y, width, 50, { fill: soft, stroke: color, r: 14 }) +
    circle(x + 22, y + 25, 6, { fill: color }) +
    text(x + 40, y + 32, label, size, { fill: C.ink, weight: 700 })
  );
}

function bullet(x, y, value, width, options = {}) {
  const { color = C.blue, size = 19, lineHeight = 27, weight = 400, check = false } = options;
  let output = circle(x + 8, y - 7, 9, { fill: color });
  if (check) {
    output += path(`M ${x + 3} ${y - 7} l 4 4 l 7 -9`, { stroke: '#fff', sw: 2.5 });
  }
  output += paragraph(x + 28, y, value, width - 28, size, {
    fill: C.text,
    lineHeight,
    weight,
  });
  return output;
}

function titleBlock(slide, eyebrow, titleValue, subtitle) {
  let output = text(70, 64, eyebrow.toUpperCase(), 16, {
    fill: C.blue,
    weight: 750,
    letter: 2.4,
  });
  output += text(70, 119, titleValue, 42, { fill: C.ink, weight: 780 });
  if (subtitle) {
    output += paragraph(70, 158, subtitle, 1250, 20, {
      fill: C.muted,
      lineHeight: 28,
      maxLines: 2,
    });
  }
  output += text(1530, 64, `${String(slide).padStart(2, '0')} / ${String(SLIDE_COUNT).padStart(2, '0')}`, 16, {
    fill: C.faint,
    weight: 650,
    anchor: 'end',
    letter: 1.2,
  });
  return output;
}

function footer(note = 'Оргтехника · движение статусов заявок') {
  return (
    line(70, 852, 1530, 852, { stroke: C.line, sw: 1 }) +
    text(70, 878, note, 13, { fill: C.faint, weight: 500 }) +
    text(1530, 878, '27.08.2026', 13, { fill: C.faint, weight: 500, anchor: 'end' })
  );
}

function document(body, options = {}) {
  const { dark = false } = options;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#112240" flood-opacity="0.10"/>
    </filter>
    <linearGradient id="cover" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#071426"/>
      <stop offset="0.62" stop-color="#0d2442"/>
      <stop offset="1" stop-color="#12365d"/>
    </linearGradient>
    <linearGradient id="blueBand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0958d9"/>
      <stop offset="1" stop-color="#36cfc9"/>
    </linearGradient>
    <marker id="arrow-blue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.blue}"/>
    </marker>
    <marker id="arrow-green" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.green}"/>
    </marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.red}"/>
    </marker>
    <marker id="arrow-gray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.gray}"/>
    </marker>
  </defs>
  <rect width="${W}" height="${H}" fill="${dark ? 'url(#cover)' : C.bg}"/>
  ${body}
  </svg>`;
}

function slide1() {
  let b = '';
  b += circle(1410, 110, 280, { fill: '#1677ff', opacity: 0.10 });
  b += circle(150, 810, 310, { fill: '#36cfc9', opacity: 0.08 });
  b += rect(80, 68, 200, 42, { fill: '#1677ff', r: 21 });
  b += text(180, 96, 'ИНФОГРАФИКА · 16:9', 15, { fill: '#fff', weight: 750, anchor: 'middle', letter: 1 });
  b += text(80, 210, 'Как движется заявка', 62, { fill: '#fff', weight: 780 });
  b += text(80, 282, 'в модуле «Оргтехника»', 62, { fill: '#7dd3fc', weight: 780 });
  b += paragraph(80, 340, 'Единый цикл для ремонта и расходников: кто делает следующий шаг, где включается смета и как заявка завершается.', 920, 25, {
    fill: '#c7d5ea',
    lineHeight: 36,
    maxLines: 2,
  });

  const nodes = [
    { x: 92, w: 210, label: 'Новая', color: '#69b1ff' },
    { x: 340, w: 210, label: 'Назначена', color: '#5cdbd3' },
    { x: 588, w: 210, label: 'В работе', color: '#ffc069' },
    { x: 836, w: 210, label: 'Решена', color: '#b7eb8f' },
    { x: 1084, w: 210, label: 'Закрыта', color: '#95de64' },
  ];
  b += line(150, 590, 1240, 590, { stroke: '#315275', sw: 7 });
  nodes.forEach((node, index) => {
    b += rect(node.x, 540, node.w, 100, { fill: '#ffffff', opacity: 0.97, r: 20, shadow: true });
    b += circle(node.x + 30, 590, 8, { fill: node.color });
    b += text(node.x + 52, 599, node.label, 25, { fill: C.ink, weight: 740 });
    if (index < nodes.length - 1) {
      b += arrow(node.x + node.w + 5, 590, nodes[index + 1].x - 12, 590, { stroke: '#69b1ff', sw: 4 });
    }
  });
  b += rect(805, 690, 710, 88, { fill: '#ffffff', opacity: 0.08, stroke: '#4d6e94', r: 18 });
  b += text(840, 730, 'Для ремонта:', 19, { fill: '#7dd3fc', weight: 750 });
  b += text(982, 730, '«В работе» → «Смета на согласовании» → «В работе»', 19, { fill: '#ffffff', weight: 600 });
  b += text(840, 759, 'Для расходников сметный круг пропускается.', 16, { fill: '#b8c9df' });
  const p1 = pill(80, 815, 'РЕМОНТ', { fill: '#1677ff', color: '#fff', size: 15, height: 34 });
  const p2 = pill(80 + p1.width + 12, 815, 'РАСХОДНИКИ', { fill: '#0e7490', color: '#fff', size: 15, height: 34 });
  const p3 = pill(80 + p1.width + p2.width + 24, 815, '8 ЖИВЫХ СТАТУСОВ', { fill: '#ffffff', color: C.navy, size: 15, height: 34 });
  b += p1.svg + p2.svg + p3.svg;
  b += text(1515, 842, 'Актуальная схема · 27 августа 2026', 14, { fill: '#8fa7c5', anchor: 'end' });
  return document(b, { dark: true });
}

function slide2() {
  let b = titleBlock(
    2,
    '01 · основной маршрут',
    'Основной маршрут: от обращения до закрытия',
    'Смета — не отдельный цикл, а ветка внутри статуса «В работе» только для ремонта.',
  );

  const y = 285;
  const width = 205;
  const cards = [
    { x: 70, title: 'Новая', sub: 'Назначить исполнителя', color: C.blue, soft: C.blueSoft },
    { x: 320, title: 'Назначена', sub: 'Принять в работу', color: C.cyan, soft: C.cyanSoft },
    { x: 570, title: 'В работе', sub: 'Выполнить задачу', color: C.orange, soft: C.orangeSoft },
    { x: 1065, title: 'Решена', sub: 'Принять результат', color: C.lime, soft: C.limeSoft },
    { x: 1315, title: 'Закрыта', sub: 'Цикл завершён', color: C.green, soft: C.greenSoft, terminal: true },
  ];
  cards.forEach((card, index) => {
    b += statusCard(card.x, y, width, card.title, card.sub, {
      color: card.color,
      soft: card.soft,
      index: index + 1,
      terminal: card.terminal,
      height: 150,
    });
  });
  b += arrow(278, 360, 313, 360, { stroke: C.blue, sw: 4 });
  b += arrow(528, 360, 563, 360, { stroke: C.blue, sw: 4 });
  b += arrow(778, 360, 1058, 360, { stroke: C.blue, sw: 4 });
  b += arrow(1273, 360, 1308, 360, { stroke: C.green, sw: 4, marker: 'arrow-green' });

  b += rect(805, 245, 230, 230, { fill: C.goldSoft, stroke: '#f0c94b', sw: 2, r: 26, shadow: true });
  b += pill(835, 265, 'ТОЛЬКО РЕМОНТ', { fill: '#f5c242', color: '#5f4300', size: 14, height: 32 }).svg;
  b += paragraph(832, 334, 'Смета на согласовании', 180, 25, { fill: C.ink, weight: 760, lineHeight: 31, maxLines: 2 });
  b += paragraph(832, 414, 'Сначала ИТ, затем оператор', 180, 16, { fill: C.muted, lineHeight: 21, maxLines: 2 });
  b += arrowPath('M 725 280 C 725 215, 920 205, 920 238', { stroke: C.gold, sw: 4, marker: 'arrow-gray' });
  b += arrowPath('M 920 480 C 920 520, 725 520, 725 444', { stroke: C.gold, sw: 4, marker: 'arrow-gray' });
  b += text(747, 207, 'предъявить смету', 15, { fill: C.gold, weight: 650 });
  b += text(775, 542, 'решение по смете', 15, { fill: C.gold, weight: 650 });

  b += rect(70, 545, 1450, 230, { fill: '#fff', stroke: C.line, r: 22 });
  b += text(102, 590, 'Что меняет статус', 22, { fill: C.ink, weight: 760 });
  const actionCols = [
    { x: 102, color: C.blue, title: '1 · Распределение', body: 'Оператор или ИТ назначает своего сотрудника либо сервисную компанию.' },
    { x: 458, color: C.orange, title: '2 · Исполнение', body: 'Назначенный исполнитель принимает заявку и доводит её до результата.' },
    { x: 814, color: C.gold, title: '3 · Решение по смете', body: 'У ремонта смета получает визу ИТ, затем денежное согласование.' },
    { x: 1170, color: C.green, title: '4 · Приёмка', body: 'Оператор закрывает заявку или возвращает её в работу.' },
  ];
  actionCols.forEach((col, index) => {
    if (index > 0) b += line(col.x - 22, 582, col.x - 22, 742, { stroke: C.line, sw: 1 });
    b += circle(col.x + 9, 632, 9, { fill: col.color });
    b += text(col.x + 28, 639, col.title, 18, { fill: C.ink, weight: 710 });
    b += paragraph(col.x, 684, col.body, 300, 17, { fill: C.muted, lineHeight: 24, maxLines: 3 });
  });
  b += footer();
  return document(b);
}

function slide3() {
  let b = titleBlock(
    3,
    '02 · ремонт',
    'Смета: два последовательных решения',
    'В «Смете на согласовании» очередь меняется по данным заявки: сначала ждут ИТ, после его визы — оператора.',
  );

  const steps = [
    { x: 70, n: '1', title: 'Исполнитель', body: 'Собирает смету и предъявляет новую ревизию.', color: C.orange, soft: C.orangeSoft },
    { x: 390, n: '2', title: 'ИТ-служба', body: 'Решает: ремонтировать аппарат или рекомендовать замену.', color: C.purple, soft: C.purpleSoft },
    { x: 710, n: '3', title: 'Оператор', body: 'После визы ИТ согласует сумму либо отклоняет смету.', color: C.blue, soft: C.blueSoft },
    { x: 1030, n: '4', title: 'Исполнитель', body: 'Продолжает работу или корректирует расчёт.', color: C.orange, soft: C.orangeSoft },
  ];
  steps.forEach((step, index) => {
    b += rect(step.x, 265, 270, 190, { fill: '#fff', stroke: C.line, r: 22, shadow: true });
    b += circle(step.x + 40, 308, 23, { fill: step.color });
    b += text(step.x + 40, 316, step.n, 20, { fill: '#fff', weight: 780, anchor: 'middle' });
    b += text(step.x + 78, 316, step.title, 23, { fill: C.ink, weight: 750 });
    b += paragraph(step.x + 28, 365, step.body, 215, 18, { fill: C.text, lineHeight: 26, maxLines: 3 });
    if (index < steps.length - 1) b += arrow(step.x + 277, 360, steps[index + 1].x - 10, 360, { stroke: C.blue, sw: 4 });
  });

  b += rect(1340, 265, 180, 190, { fill: C.orangeSoft, stroke: C.orange, sw: 2, r: 22 });
  b += text(1430, 310, 'СТАТУС', 14, { fill: C.orange, weight: 750, anchor: 'middle', letter: 1.5 });
  b += paragraph(1430, 355, 'В работе', 135, 25, { fill: C.ink, weight: 780, anchor: 'middle', lineHeight: 31 });
  b += text(1430, 425, 'цикл продолжается', 14, { fill: C.muted, anchor: 'middle' });

  b += rect(70, 515, 700, 250, { fill: C.greenSoft, stroke: '#b7e38f', r: 22 });
  b += text(102, 560, 'Если согласовано', 23, { fill: C.green, weight: 760 });
  b += miniStatus(102, 595, 235, 'Смета', { color: C.gold, soft: C.goldSoft });
  b += arrow(345, 620, 420, 620, { stroke: C.green, sw: 4, marker: 'arrow-green' });
  b += miniStatus(430, 595, 250, 'В работе', { color: C.orange, soft: C.orangeSoft });
  b += bullet(102, 696, 'Виза ИТ статуса не меняет.', 280, { color: C.purple, size: 17, lineHeight: 23 });
  b += bullet(390, 696, 'Согласование суммы возвращает в работу.', 315, { color: C.green, size: 17, lineHeight: 23 });

  b += rect(800, 515, 720, 250, { fill: C.redSoft, stroke: '#ffb3b8', r: 22 });
  b += text(832, 560, 'Если решение отрицательное', 23, { fill: C.red, weight: 760 });
  b += rect(832, 594, 310, 122, { fill: '#fff', stroke: '#ffd1d4', r: 16 });
  b += text(857, 628, 'ИТ: аппарат лучше заменить', 18, { fill: C.ink, weight: 700 });
  b += text(857, 662, '→ Отменена', 20, { fill: C.red, weight: 780 });
  b += text(857, 694, 'причина обязательна', 14, { fill: C.muted });
  b += rect(1170, 594, 318, 122, { fill: '#fff', stroke: '#ffd1d4', r: 16 });
  b += text(1195, 628, 'Оператор: смету доработать', 18, { fill: C.ink, weight: 700 });
  b += text(1195, 662, '→ В работе', 20, { fill: C.orange, weight: 780 });
  b += text(1195, 694, 'с причиной отклонения', 14, { fill: C.muted });

  b += rect(70, 792, 1450, 42, { fill: C.purpleSoft, r: 12 });
  b += text(795, 820, 'Новая ревизия сметы автоматически обесценивает обе прежние подписи — ИТ и оператора.', 17, { fill: C.purple, weight: 650, anchor: 'middle' });
  b += footer();
  return document(b);
}

function slide4() {
  let b = titleBlock(
    4,
    '03 · ответственность',
    'Кто именно двигает заявку',
    'Один статус может быть доступен разным сторонам, но каждое действие закреплено за конкретным участником.',
  );

  const lanes = [
    {
      y: 238,
      name: 'Заявитель',
      badge: 'создаёт и наблюдает',
      color: C.gray,
      soft: C.graySoft,
      items: ['Создать заявку', 'Уточнить контакт', 'Следить за историей'],
      note: 'Статусы не меняет',
    },
    {
      y: 362,
      name: 'Ведение',
      badge: 'оператор оргтехники',
      color: C.blue,
      soft: C.blueSoft,
      items: ['Назначить', 'Согласовать смету', 'Принять / вернуть', 'Отложить / отменить'],
      note: 'Управляет бизнес-циклом',
    },
    {
      y: 486,
      name: 'ИТ-служба',
      badge: 'техническое решение',
      color: C.purple,
      soft: C.purpleSoft,
      items: ['Назначить', 'Виза по смете', 'Рекомендовать замену', 'Отложить / возобновить'],
      note: 'Решает целесообразность ремонта',
    },
    {
      y: 610,
      name: 'Исполнитель',
      badge: 'сотрудник или сервис',
      color: C.orange,
      soft: C.orangeSoft,
      items: ['Принять в работу', 'Предъявить смету', 'Закрыть работы', 'Отказаться от назначения'],
      note: 'Ходы открывает назначение',
    },
    {
      y: 734,
      name: 'Портал',
      badge: 'автоматически',
      color: C.green,
      soft: C.greenSoft,
      items: ['Через 24 часа', 'Решена → Закрыта'],
      note: 'Если заявка созрела для закрытия',
    },
  ];

  lanes.forEach((lane) => {
    b += rect(70, lane.y, 1450, 100, { fill: '#fff', stroke: C.line, r: 20 });
    b += rect(70, lane.y, 14, 100, { fill: lane.color, r: 7 });
    b += text(110, lane.y + 39, lane.name, 23, { fill: C.ink, weight: 760 });
    b += text(110, lane.y + 70, lane.badge, 15, { fill: lane.color, weight: 650 });
    let x = 390;
    lane.items.forEach((item) => {
      const p = pill(x, lane.y + 29, item, { fill: lane.soft, color: lane.color, size: 15, height: 42, pad: 14 });
      b += p.svg;
      x += p.width + 13;
    });
    b += text(1485, lane.y + 59, lane.note, 15, { fill: C.muted, weight: 600, anchor: 'end' });
  });
  b += footer('Роли · кто делает следующий шаг');
  return document(b);
}

function slide5() {
  let b = titleBlock(
    5,
    '04 · особые маршруты',
    'Пауза, отказ, доработка и административный откат',
    'Эти переходы не заменяют основной цикл: они возвращают заявку в понятную точку или временно останавливают движение.',
  );

  b += rect(70, 235, 705, 290, { fill: '#fff', stroke: C.line, r: 24, shadow: true });
  b += text(105, 282, 'Отложить и возобновить', 26, { fill: C.ink, weight: 770 });
  b += pill(560, 255, 'ПРИЧИНА ОБЯЗАТЕЛЬНА', { fill: C.graySoft, color: C.gray, size: 13, height: 34 }).svg;
  b += miniStatus(105, 330, 190, 'Любой шаг', { color: C.blue, soft: C.blueSoft });
  b += arrow(305, 355, 390, 355, { stroke: C.gray, sw: 4, marker: 'arrow-gray' });
  b += miniStatus(405, 330, 205, 'Отложена', { color: C.gray, soft: C.graySoft });
  b += arrowPath('M 510 388 C 510 456, 220 456, 220 392', { stroke: C.green, sw: 4, marker: 'arrow-green' });
  b += text(310, 474, 'возврат строго в исходный статус', 16, { fill: C.green, weight: 680, anchor: 'middle' });
  b += paragraph(105, 500, 'Можно отложить «Новую», «Назначена», «Смету», «В работе» и «Решена». После возврата возраст статуса начинается заново.', 610, 16, {
    fill: C.muted,
    lineHeight: 22,
    maxLines: 2,
  });

  b += rect(815, 235, 705, 290, { fill: '#fff', stroke: C.line, r: 24, shadow: true });
  b += text(850, 282, 'Бизнес-возвраты', 26, { fill: C.ink, weight: 770 });
  const returns = [
    { y: 326, from: 'Назначена', to: 'Новая', why: 'исполнитель отказался', color: C.cyan },
    { y: 397, from: 'Решена', to: 'В работе', why: 'результат вернули на доработку', color: C.orange },
    { y: 468, from: 'Смета', to: 'В работе', why: 'согласована или отклонена', color: C.gold },
  ];
  returns.forEach((row) => {
    b += text(850, row.y, row.from, 18, { fill: C.ink, weight: 700 });
    b += arrow(985, row.y - 7, 1060, row.y - 7, { stroke: row.color, sw: 3, marker: 'arrow-gray' });
    b += text(1080, row.y, row.to, 18, { fill: C.ink, weight: 700 });
    b += text(1235, row.y, row.why, 15, { fill: C.muted });
  });

  b += rect(70, 560, 1450, 250, { fill: C.graySoft, stroke: C.line, r: 24 });
  b += text(105, 606, 'Административные откаты · исправление ошибочного хода', 24, { fill: C.ink, weight: 760 });
  b += text(1490, 606, 'пунктиром на итоговой карте', 15, { fill: C.gray, weight: 600, anchor: 'end' });
  const rollback = [
    ['Назначена', 'Новая'],
    ['В работе', 'Назначена'],
    ['Решена', 'В работе'],
    ['Закрыта', 'Решена'],
    ['Отменена', 'Новая'],
  ];
  rollback.forEach((pair, index) => {
    const x = 105 + index * 277;
    b += rect(x, 650, 245, 104, { fill: '#fff', stroke: '#d4d9e2', r: 16 });
    b += text(x + 20, 685, pair[0], 17, { fill: C.ink, weight: 700 });
    b += arrow(x + 20, 715, x + 108, 715, { stroke: C.gray, sw: 3, dash: '8 7', marker: 'arrow-gray' });
    b += text(x + 122, 722, pair[1], 17, { fill: C.gray, weight: 700 });
  });
  b += footer();
  return document(b);
}

function slide6() {
  let b = titleBlock(
    6,
    '05 · рабочая очередь',
    'Статус сразу отвечает: чьего шага ждут',
    '«Смета на согласовании» — единственный живой статус, где ожидаемая сторона меняется без смены самого статуса.',
  );

  const rows = [
    { y: 238, status: 'Новая', waits: 'Ведение / ИТ', action: 'назначить исполнителей', color: C.blue, soft: C.blueSoft },
    { y: 312, status: 'Назначена', waits: 'Исполнитель', action: 'принять в работу', color: C.cyan, soft: C.cyanSoft },
    { y: 386, status: 'В работе', waits: 'Исполнитель', action: 'выполнить и закрыть работы', color: C.orange, soft: C.orangeSoft },
    { y: 460, status: 'Смета на согласовании', waits: 'Сначала ИТ → затем ведение', action: 'решить по ремонту → согласовать сумму', color: C.gold, soft: C.goldSoft },
    { y: 534, status: 'Решена', waits: 'Ведение', action: 'принять работу или вернуть', color: C.lime, soft: C.limeSoft },
    { y: 608, status: 'Отложена', waits: 'Никого', action: 'заявка снята с рабочих очередей', color: C.gray, soft: C.graySoft },
    { y: 682, status: 'Закрыта', waits: 'Никого', action: 'успешный терминал', color: C.green, soft: C.greenSoft },
    { y: 756, status: 'Отменена', waits: 'Никого', action: 'терминал без результата', color: C.red, soft: C.redSoft },
  ];
  b += rect(70, 210, 1450, 594, { fill: '#fff', stroke: C.line, r: 22 });
  b += rect(70, 210, 1450, 52, { fill: C.navy, r: 22 });
  b += rect(70, 240, 1450, 22, { fill: C.navy });
  b += text(105, 244, 'СТАТУС', 15, { fill: '#fff', weight: 750, letter: 1.2 });
  b += text(620, 244, 'КОГО ЖДУТ', 15, { fill: '#fff', weight: 750, letter: 1.2 });
  b += text(1030, 244, 'СЛЕДУЮЩЕЕ ДЕЙСТВИЕ', 15, { fill: '#fff', weight: 750, letter: 1.2 });
  rows.forEach((row, index) => {
    if (index % 2 === 1) b += rect(82, row.y + 25, 1426, 70, { fill: '#fafbfe', r: 10 });
    b += rect(105, row.y + 37, 360, 46, { fill: row.soft, stroke: row.color, r: 13 });
    b += circle(130, row.y + 60, 6, { fill: row.color });
    b += text(150, row.y + 68, row.status, 19, { fill: C.ink, weight: 720 });
    b += text(620, row.y + 68, row.waits, 18, { fill: row.color, weight: 700 });
    b += text(1030, row.y + 68, row.action, 18, { fill: C.text, weight: 500 });
  });
  b += footer('Рабочая очередь · статус, ожидание и действие');
  return document(b);
}

function slide7() {
  let b = titleBlock(
    7,
    '06 · карта на одном листе',
    'Карта рабочих переходов',
    'Сплошные линии — рабочий цикл, серые — пауза и административные исправления, красные — отмена.',
  );

  const nodes = {
    new: { x: 70, y: 310, w: 190, label: 'Новая', color: C.blue, soft: C.blueSoft },
    assigned: { x: 330, y: 310, w: 190, label: 'Назначена', color: C.cyan, soft: C.cyanSoft },
    work: { x: 590, y: 310, w: 190, label: 'В работе', color: C.orange, soft: C.orangeSoft },
    done: { x: 1110, y: 310, w: 190, label: 'Решена', color: C.lime, soft: C.limeSoft },
    closed: { x: 1370, y: 310, w: 160, label: 'Закрыта', color: C.green, soft: C.greenSoft },
    estimate: { x: 720, y: 205, w: 280, label: 'Смета на согласовании', color: C.gold, soft: C.goldSoft },
    hold: { x: 615, y: 570, w: 220, label: 'Отложена', color: C.gray, soft: C.graySoft },
    cancel: { x: 1120, y: 570, w: 220, label: 'Отменена', color: C.red, soft: C.redSoft },
  };
  Object.values(nodes).forEach((node) => {
    b += rect(node.x, node.y, node.w, 72, { fill: node.soft, stroke: node.color, sw: 2, r: 18, shadow: true });
    b += circle(node.x + 27, node.y + 36, 7, { fill: node.color });
    b += text(node.x + 48, node.y + 45, node.label, node.w < 180 ? 19 : 21, { fill: C.ink, weight: 740 });
  });

  b += arrow(265, 346, 323, 346, { stroke: C.blue, sw: 4 });
  b += text(294, 332, 'назначить', 13, { fill: C.blue, weight: 650, anchor: 'middle' });
  b += arrow(525, 346, 583, 346, { stroke: C.orange, sw: 4, marker: 'arrow-gray' });
  b += text(554, 332, 'принять', 13, { fill: C.orange, weight: 650, anchor: 'middle' });
  b += arrow(785, 346, 1103, 346, { stroke: C.orange, sw: 4, marker: 'arrow-gray' });
  b += text(945, 332, 'закрыть работы', 13, { fill: C.orange, weight: 650, anchor: 'middle' });
  b += arrow(1305, 346, 1363, 346, { stroke: C.green, sw: 4, marker: 'arrow-green' });
  b += text(1334, 332, 'принять', 13, { fill: C.green, weight: 650, anchor: 'middle' });

  b += arrowPath('M 690 304 C 690 240, 700 240, 714 240', { stroke: C.gold, sw: 4, marker: 'arrow-gray' });
  b += arrowPath('M 860 282 C 860 410, 750 410, 750 388', { stroke: C.gold, sw: 4, marker: 'arrow-gray' });
  b += text(654, 232, 'предъявить', 13, { fill: C.gold, weight: 650 });
  b += text(805, 425, 'решение → обратно в работу', 13, { fill: C.gold, weight: 650 });

  b += arrowPath('M 420 388 C 420 470, 150 470, 150 390', { stroke: C.gray, sw: 3, dash: '8 7', marker: 'arrow-gray' });
  b += text(280, 492, 'отказ / админ-откат', 13, { fill: C.gray, weight: 650, anchor: 'middle' });
  b += arrowPath('M 1160 388 C 1160 500, 690 500, 690 390', { stroke: C.orange, sw: 3, marker: 'arrow-gray' });
  b += text(926, 520, 'вернуть на доработку', 13, { fill: C.orange, weight: 650, anchor: 'middle' });

  b += arrowPath('M 660 390 C 660 500, 675 500, 675 564', { stroke: C.gray, sw: 3, marker: 'arrow-gray' });
  b += arrowPath('M 830 606 C 940 606, 940 470, 760 390', { stroke: C.green, sw: 3, dash: '8 7', marker: 'arrow-green' });
  b += text(750, 552, 'пауза', 13, { fill: C.gray, weight: 650, anchor: 'middle' });
  b += text(942, 592, 'возврат в исходный', 13, { fill: C.green, weight: 650, anchor: 'middle' });

  b += arrowPath('M 760 388 C 850 475, 1110 500, 1180 564', { stroke: C.red, sw: 3, marker: 'arrow-red' });
  b += arrowPath('M 985 277 C 1070 350, 1150 450, 1200 564', { stroke: C.red, sw: 3, marker: 'arrow-red' });
  b += text(1050, 470, 'отмена с причиной', 13, { fill: C.red, weight: 650 });

  b += rect(70, 685, 925, 120, { fill: '#fff', stroke: C.line, r: 20 });
  b += text(100, 724, 'Легенда', 20, { fill: C.ink, weight: 750 });
  b += line(100, 757, 165, 757, { stroke: C.blue, sw: 4 });
  b += text(180, 763, 'основной ход', 15, { fill: C.text });
  b += line(355, 757, 420, 757, { stroke: C.gray, sw: 3, dash: '8 7' });
  b += text(435, 763, 'возврат / пауза', 15, { fill: C.text });
  b += line(650, 757, 715, 757, { stroke: C.red, sw: 3 });
  b += text(730, 763, 'отмена', 15, { fill: C.text });
  b += text(100, 787, 'В «Отложена»: из Новой, Назначена, Сметы, В работе и Решена.', 14, { fill: C.muted });
  b += text(100, 807, 'В «Отменена»: из Новой, Назначена, Сметы, В работе и Отложена.', 14, { fill: C.muted });

  b += rect(1025, 685, 495, 120, { fill: C.purpleSoft, stroke: '#d6b8ff', r: 20 });
  b += text(1055, 724, 'Legacy — только история', 20, { fill: C.purple, weight: 750 });
  b += text(1055, 757, '«Согласована ИТ» · «Диагностика»', 17, { fill: C.ink, weight: 680 });
  b += paragraph(1055, 786, 'Новые заявки в эти статусы не переходят.', 420, 14, { fill: C.muted, lineHeight: 19 });
  b += footer('Итоговая карта · живой цикл без legacy-статусов');
  return document(b);
}

const slides = [slide1(), slide2(), slide3(), slide4(), slide5(), slide6(), slide7()];

for (const [index, svg] of slides.entries()) {
  const stem = `office-equipment-status-flow-${String(index + 1).padStart(2, '0')}`;
  const svgPath = join(WORK, `${stem}.svg`);
  const pngPath = join(WORK, `${stem}.png`);
  writeFileSync(svgPath, svg);
  const rendered = spawnSync(
    'python3',
    [resolve('docs/render-svg-to-png.py'), svgPath, pngPath, '1920'],
    { encoding: 'utf8' },
  );
  if (rendered.status !== 0) {
    throw new Error(`Slide ${index + 1} render failed:\n${rendered.stdout}\n${rendered.stderr}`);
  }
}

const pdf = await PDFDocument.create();
pdf.setTitle('Оргтехника — движение статусов заявок');
pdf.setSubject('Инфографика по живому циклу заявок на ремонт и расходники');
pdf.setKeywords(['оргтехника', 'заявки', 'статусы', 'ремонт', 'смета', 'инфографика']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG presentation generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-08-27T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < slides.length; index += 1) {
  const stem = `office-equipment-status-flow-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([960, 540]);
  page.drawImage(png, { x: 0, y: 0, width: 960, height: 540 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
