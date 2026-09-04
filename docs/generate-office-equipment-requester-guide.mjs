import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Памятка заявителю по модулю «Орг.техника» — отдельный документ на четыре страницы.
 *
 * Читатель — рядовой сотрудник: он заводит заявку, когда что-то не работает или кончился картридж,
 * и больше в модуле не делает ничего. Поэтому здесь нет ни назначения, ни объёма работ, ни приёмки,
 * ни расходников со складом: всё это делают другие, и заявителю их кнопки не показываются.
 *
 * Приёмы рисования — те же, что у полного руководства (`generate-office-equipment-guide.mjs`):
 * страницы собираются строками SVG, рендерятся librsvg через `render-svg-to-png.py` и склеиваются
 * `pdf-lib` в A4. Три документа обязаны выглядеть одной семьёй, поэтому палитра и помощники
 * повторены, а не переизобретены.
 */

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Памятка_Оргтехника_заявителю.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'office-equipment-requester-'));
const W = 1123;
const H = 1588;
const TOTAL = 4;
const DATE = '01.09.2026';

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
  lime: '#7cb305',
  limeSoft: '#fcffe6',
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
  output += text(
    x + width / 2 + (icon ? 8 : 0),
    y + (compact ? 24 : 30),
    label,
    compact ? 15 : 17,
    {
      fill: color,
      weight: primary ? 600 : 500,
      anchor: 'middle',
    },
  );
  return output;
}

/** Поле формы: подпись, рамка и значение. `required` рисует красную звёздочку, как antd. */
function input(x, y, width, label, value, options = {}) {
  const { placeholder = false, height = 44, suffix, disabled = false, required = false } = options;
  let output = '';
  if (label) {
    if (required) {
      output += text(x, y, '*', 15, { fill: C.red });
      output += text(x + 12, y, label, 14, { fill: C.text, weight: 500 });
    } else {
      output += text(x, y, label, 14, { fill: C.text, weight: 500 });
    }
  }
  const top = label ? y + 10 : y - 24;
  output += rect(x, top, width, height, {
    fill: disabled ? '#f5f5f5' : '#fff',
    stroke: '#d9d9d9',
    r: 6,
  });
  output += text(x + 13, top + height / 2 + 6, value, 15, {
    fill: placeholder || disabled ? C.faint : C.text,
  });
  if (suffix) {
    output += text(x + width - 12, top + height / 2 + 6, suffix, 14, {
      fill: C.muted,
      anchor: 'end',
    });
  }
  return output;
}

/** Многострочное поле: та же рамка, но с подсказкой внутри и счётчиком символов. */
function textarea(x, y, width, height, label, value, options = {}) {
  const { placeholder = false, counter, required = false } = options;
  let output = '';
  if (required) {
    output += text(x, y, '*', 15, { fill: C.red });
    output += text(x + 12, y, label, 14, { fill: C.text, weight: 500 });
  } else {
    output += text(x, y, label, 14, { fill: C.text, weight: 500 });
  }
  output += rect(x, y + 10, width, height, { fill: '#fff', stroke: '#d9d9d9', r: 6 });
  output += paragraph(x + 13, y + 38, value, width - 26, 15, {
    fill: placeholder ? C.faint : C.text,
    lineHeight: 22,
  });
  if (counter) {
    output += text(x + width - 12, y + height - 2, counter, 12, { fill: C.faint, anchor: 'end' });
  }
  return output;
}

function checkbox(x, y, label, options = {}) {
  const { checked = false, size = 18, color = C.blue, labelSize = 15 } = options;
  let output = rect(x, y, size, size, {
    fill: checked ? color : '#fff',
    stroke: checked ? color : '#d9d9d9',
    r: 4,
  });
  if (checked) output += path(`M ${x + 4} ${y + 9} l 4 4 l 7 -8`, { stroke: '#fff', sw: 2.4 });
  output += text(x + size + 10, y + size - 3, label, labelSize, { fill: C.text });
  return output;
}

/** Переключатель вида заявки: слева выбранное, справа второе. */
function segmented(x, y, width, height, left, right, options = {}) {
  const { active = 'left' } = options;
  const half = width / 2;
  let output = rect(x, y, width, height, { fill: '#f0f0f0', r: 8 });
  const cx = active === 'left' ? x + 3 : x + half;
  output += rect(cx, y + 3, half - 3, height - 6, {
    fill: '#fff',
    r: 6,
    shadow: false,
    stroke: '#e0e0e0',
  });
  output += text(x + half / 2, y + height / 2 + 6, left, 15, {
    fill: active === 'left' ? C.ink : C.muted,
    weight: active === 'left' ? 600 : 400,
    anchor: 'middle',
  });
  output += text(x + half + half / 2, y + height / 2 + 6, right, 15, {
    fill: active === 'right' ? C.ink : C.muted,
    weight: active === 'right' ? 600 : 400,
    anchor: 'middle',
  });
  return output;
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

function callout(x, y, width, height, number, titleValue, body, options = {}) {
  const {
    fill = '#fff',
    stroke = C.line,
    dotFill = C.blue,
    titleColor = C.ink,
    bodySize = 14,
  } = options;
  let output = rect(x, y, width, height, { fill, stroke, r: 13, shadow: options.shadow });
  output += numberDot(number, x + 33, y + 33, { fill: dotFill, radius: 17 });
  output += paragraph(x + 62, y + 34, titleValue, width - 86, 17, {
    fill: titleColor,
    weight: 700,
    lineHeight: 22,
    maxLines: 1,
  });
  output += paragraph(x + 24, y + 72, body, width - 48, bodySize, {
    fill: C.muted,
    lineHeight: Math.round(bodySize * 1.5),
    maxLines: Math.max(2, Math.floor((height - 78) / Math.round(bodySize * 1.5))),
  });
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
  output += text(1068, 67, `${String(page).padStart(2, '0')} / 0${TOTAL}`, 16, {
    fill: C.faint,
    weight: 600,
    anchor: 'end',
  });
  output += line(55, 119, 1068, 119, { stroke: C.line });
  if (subtitle) {
    output += paragraph(55, 158, subtitle, 1005, 16, {
      fill: C.muted,
      lineHeight: 23,
      maxLines: 2,
    });
  }
  return output;
}

function footer(label = `Памятка заявителю • Орг.техника • ${DATE}`) {
  return (
    line(55, 1500, 1068, 1500, { stroke: C.line }) +
    text(55, 1530, label, 14, { fill: C.faint }) +
    text(1068, 1530, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 })
  );
}

/** Метка статуса — теми же цветами, что и в списке заявок. */
const STATUS = {
  new: { label: 'Новая', fill: C.blueSoft, color: C.blue, stroke: '#91caff' },
  work: { label: 'В работе', fill: C.orangeSoft, color: C.orange, stroke: '#ffd591' },
  hold: { label: 'Отложена', fill: '#f5f5f5', color: C.muted, stroke: '#d9d9d9' },
  done: { label: 'Решена', fill: C.limeSoft, color: C.lime, stroke: '#d3f261' },
  accepted: { label: 'Закрыта', fill: C.greenSoft, color: C.green, stroke: '#b7eb8f' },
  cancelled: { label: 'Отменена', fill: C.redSoft, color: C.red, stroke: '#ffccc7' },
};

function statusTag(x, y, key, options = {}) {
  const { size = 14 } = options;
  const s = STATUS[key];
  return pill(x, y, s.label, { fill: s.fill, color: s.color, stroke: s.stroke, size, pad: 12 });
}

function statusBox(cx, cy, key, options = {}) {
  const { width = 168, height = 48, size = 18 } = options;
  const s = STATUS[key];
  return (
    rect(cx - width / 2, cy - height / 2, width, height, {
      fill: s.fill,
      stroke: s.stroke,
      r: height / 2,
    }) + text(cx, cy + 7, s.label, size, { fill: s.color, weight: 700, anchor: 'middle' })
  );
}

// ── Страница 1: как завести заявку ──

function page1() {
  let b = header(
    1,
    'Как завести заявку',
    'Памятка заявителю · шаг 1',
    'Одно окно и шесть полей. Всё, что вы здесь напишете, читает тот, кто приедет чинить: чем понятнее описание и телефон, тем меньше уточняющих звонков.',
  );

  // Путь до кнопки.
  b += rect(55, 196, 1013, 66, { fill: C.bg, stroke: C.line, r: 12 });
  b += text(82, 236, 'Путь:', 15, { fill: C.muted, weight: 600 });
  const p1 = pill(142, 213, 'Орг.техника', {
    fill: '#fff',
    color: C.ink,
    stroke: '#d9d9d9',
    size: 15,
    pad: 14,
  });
  b += p1.svg;
  b += arrow(142 + p1.width + 12, 229, 142 + p1.width + 44, 229, { stroke: C.faint, sw: 2 });
  const p2x = 142 + p1.width + 56;
  const p2 = pill(p2x, 213, 'вкладка «Заявки»', {
    fill: '#fff',
    color: C.ink,
    stroke: '#d9d9d9',
    size: 15,
    pad: 14,
  });
  b += p2.svg;
  b += arrow(p2x + p2.width + 12, 229, p2x + p2.width + 44, 229, { stroke: C.faint, sw: 2 });
  b += button(p2x + p2.width + 56, 206, 200, 'Создать заявку', { primary: true, icon: '+' });
  b += text(1041, 236, 'кнопка справа над списком', 13, { fill: C.faint, anchor: 'end' });

  // Макет окна заявки.
  b += rect(55, 286, 628, 1190, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 332, 'Новая заявка на обслуживание', 22, { fill: C.ink, weight: 700 });
  b += text(656, 330, '✕', 18, { fill: C.faint, anchor: 'end' });
  b += line(82, 354, 656, 354, { stroke: C.line });

  b += text(82, 392, 'Чем помочь', 14, { fill: C.text, weight: 500 });
  b += segmented(82, 402, 320, 40, 'Обслуживание', 'Расходники');
  b += paragraph(
    420,
    414,
    'Обслуживание — сломалось или надо настроить. Расходники — кончился картридж.',
    208,
    12,
    { fill: C.faint, lineHeight: 16, maxLines: 3 },
  );

  b += input(82, 480, 574, 'Какой аппарат', 'Модель, инвентарный или серийный номер', {
    placeholder: true,
    required: true,
    suffix: '⌄',
  });
  b += text(82, 556, 'Не нашли технику?', 13, { fill: C.blue, weight: 600 });

  b += rect(82, 572, 574, 128, { fill: C.bluePale, stroke: '#bae0ff', r: 10 });
  b += text(104, 602, 'Аппарат', 13, { fill: C.muted });
  b += text(230, 602, 'Kyocera ECOSYS M3145', 14, { fill: C.text, weight: 600 });
  b += text(104, 632, 'Номера', 13, { fill: C.muted });
  b += text(230, 632, 'инв. № 00001802 · сер. № R7119', 14, { fill: C.text });
  b += text(104, 662, 'Где стоит', 13, { fill: C.muted });
  b += text(230, 662, 'АЛ13 · корпус 1, кабинет 214', 14, { fill: C.text });
  b += text(104, 690, 'Гарантия', 13, { fill: C.muted });
  b += pill(230, 676, 'истекла', {
    fill: '#fff',
    color: C.muted,
    stroke: '#d9d9d9',
    size: 12,
    pad: 9,
  }).svg;

  b += checkbox(82, 714, 'Аппарат стоит на другом объекте', { labelSize: 14 });

  b += textarea(82, 762, 574, 92, 'Описание', 'Например: мнёт бумагу на каждой второй странице', {
    placeholder: true,
    required: true,
    counter: '0 / 4000',
  });

  b += input(82, 888, 320, 'Для кого заявка', 'Бухгалтерия', { required: true, suffix: '⌄' });
  b += text(418, 926, 'площадка или отдел', 13, { fill: C.faint });

  b += input(82, 976, 275, 'Кто обращается', 'Петров Игорь Сергеевич', { required: true });
  b += input(381, 976, 275, 'Телефон для связи', '+7 912 345-67-89', { required: true });

  b += input(82, 1064, 320, 'Откуда обращаетесь', 'Бухгалтерия', { required: true, suffix: '⌄' });
  b += paragraph(418, 1096, 'Поле появляется, только если отделов у вас несколько.', 238, 13, {
    fill: C.faint,
    lineHeight: 18,
  });

  b += checkbox(82, 1146, 'Срочная заявка', { checked: true });
  b += input(
    82,
    1188,
    574,
    'Почему срочно',
    'Единственный принтер на площадке, встала выдача пропусков',
    {
      required: true,
    },
  );

  b += input(82, 1272, 574, 'Что ещё важно знать', 'Необязательно', { placeholder: true });

  b += text(82, 1360, 'Фото и документы', 13, { fill: C.muted });
  b += button(82, 1372, 296, 'Прикрепить фото и документы', { compact: true, icon: '↑' });

  b += line(82, 1424, 656, 1424, { stroke: C.line });
  b += button(430, 1436, 100, 'Отмена', { compact: true });
  b += button(544, 1436, 112, 'Сохранить', { primary: true, compact: true });

  // Выноски.
  const notes = [
    [
      '1',
      'Аппарат назвать обязательно',
      'Ищите по модели, инвентарному или серийному номеру. Под полем сразу видно, что уйдёт в заявку: номера, где стоит аппарат и цела ли гарантия.',
      C.blue,
      C.bluePale,
      '#bae0ff',
    ],
    [
      '2',
      'Описание — своими словами',
      'Пишите, что видите: «мнёт бумагу на каждой второй странице», «закончился чёрный тонер, печатать нечем». «Не работает» мастеру не говорит ничего.',
      C.purple,
      C.purpleSoft,
      '#d3adf7',
    ],
    [
      '3',
      'Для кого заявка',
      'Ваш отдел или площадка, где стоит аппарат. Обычно портал подставляет его сам — меняйте, только если просите за другой отдел.',
      C.cyan,
      C.cyanSoft,
      '#87e8de',
    ],
    [
      '4',
      'Кто обращается',
      'Имя и телефон подставляются из вашей учётки. Оставьте тот номер, по которому вас найдут: по нему звонят, если аппарата нет на месте или нужен доступ в кабинет.',
      C.green,
      C.greenSoft,
      '#b7eb8f',
    ],
    [
      '5',
      'Срочно — только с причиной',
      'Галочка открывает поле «Почему срочно», и без него заявка не отправится. Причину читают: срочные разбирают вне очереди, и «просто так» отнимает её у тех, у кого работа встала.',
      C.orange,
      C.orangeSoft,
      '#ffd591',
    ],
  ];
  notes.forEach((note, i) => {
    b += callout(703, 286 + i * 204, 365, 188, note[0], note[1], note[2], {
      fill: note[4],
      stroke: note[5],
      dotFill: note[3],
    });
  });

  b += rect(703, 1310, 365, 166, { fill: '#fff', stroke: C.line, r: 13 });
  b += text(727, 1354, 'Аппарата нет в списке?', 17, { fill: C.ink, weight: 700 });
  b += paragraph(
    727,
    1388,
    'Нажмите «Не нашли технику?» под полем: портал соберёт текст обращения и даст кнопку «Написать в техподдержку». Карточку заведут — и заявку подадите по ней.',
    317,
    14,
    { fill: C.muted, lineHeight: 21 },
  );

  b += footer();
  return document(b);
}

// ── Страница 2: что дальше ──

function page2() {
  let b = header(
    2,
    'Что происходит дальше',
    'Памятка заявителю · шаг 2',
    'Заявку ведёт служба: распределяет, чинит и принимает работу. От вас после отправки почти всегда не нужно ничего — кроме ответа на звонок.',
  );

  b += rect(55, 196, 1013, 208, { fill: C.bg, stroke: C.line, r: 14 });
  const track = [
    [175, 'new', 'вы завели'],
    [415, 'work', 'за неё взялись'],
    [655, 'done', 'работы закрыли'],
    [895, 'accepted', 'работу приняли'],
  ];
  track.forEach(([cx, key, caption]) => {
    b += statusBox(cx, 258, key);
    b += text(cx, 302, caption, 13, { fill: C.faint, anchor: 'middle' });
  });
  b += arrow(265, 258, 325, 258, { stroke: C.faint, sw: 2.5 });
  b += arrow(505, 258, 565, 258, { stroke: C.faint, sw: 2.5 });
  b += arrow(745, 258, 805, 258, { stroke: C.faint, sw: 2.5 });

  b += text(82, 366, 'Бывает и так:', 15, { fill: C.muted, weight: 600 });
  b += statusBox(300, 360, 'hold', { width: 150, height: 42, size: 16 });
  b += statusBox(470, 360, 'cancelled', { width: 158, height: 42, size: 16 });
  b += text(566, 366, '— причину всегда пишут, и её видно в заявке', 14, { fill: C.muted });

  const cards = [
    [
      'new',
      'Заявку зарегистрировали, она ждёт, когда её распределят. В списке подписана «Ждёт оператора».',
      'Ничего. Пока за неё никто не взялся — можно поправить или удалить самому.',
    ],
    [
      'work',
      'За заявку взялся исполнитель: свой системный администратор или сервисная компания.',
      'Ответить на звонок и показать аппарат. Иногда просят освободить доступ или подписать бумагу.',
    ],
    [
      'hold',
      'Движение остановлено с причиной, и она написана прямо в строке: «Отложена: ждём поставку картриджа».',
      'Ничего. Вернуть заявку в работу или отменить может только служба.',
    ],
    [
      'done',
      'Работы закрыты, заявка ждёт приёмки. Если сутки никто не возразил, портал закрывает её сам.',
      'Проверить, что всё правда работает. Что-то не так — сказать, пока сутки не вышли.',
    ],
    [
      'accepted',
      'Работу приняли, заявка закончена. Что по ней делали, остаётся в её истории.',
      'Ничего. Сломалось снова — заводите новую заявку.',
    ],
    [
      'cancelled',
      'Заявку сняли с причиной: например, чинить нецелесообразно и аппарат рекомендован под замену.',
      'Ничего. Причину смотрите в карточке, на вкладке «История».',
    ],
  ];
  cards.forEach(([key, meaning, waiting], i) => {
    const x = 55 + (i % 2) * 516;
    const y = 424 + Math.floor(i / 2) * 262;
    const s = STATUS[key];
    b += rect(x, y, 497, 244, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
    b += rect(x, y, 10, 244, { fill: s.color, r: 5 });
    b += statusTag(x + 28, y + 24, key, { size: 16 }).svg;
    b += paragraph(x + 28, y + 100, meaning, 441, 15, {
      fill: C.text,
      lineHeight: 23,
      maxLines: 3,
    });
    b += line(x + 28, y + 168, x + 469, y + 168, { stroke: C.line });
    b += text(x + 28, y + 202, 'От вас:', 14, { fill: s.color, weight: 700 });
    b += paragraph(x + 100, y + 202, waiting, 369, 14, {
      fill: C.muted,
      lineHeight: 20,
      maxLines: 2,
    });
  });

  b += rect(55, 1218, 1013, 246, { fill: C.orangeSoft, stroke: '#ffd591', r: 14 });
  b += circle(98, 1268, 24, { fill: C.orange });
  b += text(98, 1276, '!', 22, { fill: '#fff', weight: 700, anchor: 'middle' });
  b += text(140, 1276, 'Передумали или ошиблись — что можно сделать', 22, {
    fill: C.ink,
    weight: 700,
  });
  b += rect(82, 1310, 470, 132, { fill: '#fff', stroke: '#ffd591', r: 12 });
  b += text(106, 1348, 'Пока «Новая» и исполнителя нет', 16, { fill: C.orange, weight: 700 });
  b += paragraph(
    106,
    1380,
    'В меню «Действия» карточки есть «Редактировать» и «Удалить». Удалённая заявка уходит в архив: вернуть её сможет только администратор.',
    422,
    14,
    { fill: C.text, lineHeight: 21 },
  );
  b += rect(571, 1310, 470, 132, { fill: '#fff', stroke: '#ffd591', r: 12 });
  b += text(595, 1348, 'Как только назначили исполнителя', 16, { fill: C.orange, weight: 700 });
  b += paragraph(
    595,
    1380,
    'Правки закрыты: за заявкой уже договорённость с мастером. Статус вы не двигаете — попросите отменить того, кто ведёт заявки, и назовите причину.',
    422,
    14,
    { fill: C.text, lineHeight: 21 },
  );

  b += footer();
  return document(b);
}

// ── Страница 3: где смотреть ──

function page3() {
  let b = header(
    3,
    'Где смотреть свою заявку',
    'Памятка заявителю · шаг 3',
    'Свои заявки видно во вкладке «Заявки». Строка списка отвечает, где заявка стоит и кого ждут; карточка — что по ней происходит и что уже сделано.',
  );

  // Список.
  b += rect(55, 196, 1013, 452, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += input(82, 216, 424, '', 'СО-14, модель, инв. или серийный номер', {
    placeholder: true,
    height: 40,
  });
  // Лупа рисуется, а не берётся символом: в DejaVu Sans её глифа нет. Поле без подписи стоит
  // выше своей координаты (см. `input`), поэтому значок и метки выровнены по 192..232.
  b += circle(478, 209, 7, { stroke: C.faint, sw: 2 });
  b += line(483, 214, 488, 219, { stroke: C.faint, sw: 2 });
  b += pill(526, 198, 'Мои заявки', {
    fill: C.blueSoft,
    color: C.blue,
    stroke: '#91caff',
    size: 13,
    pad: 12,
  }).svg;
  b += pill(656, 198, 'Все статусы', {
    fill: '#fff',
    color: C.text,
    stroke: '#d9d9d9',
    size: 13,
    pad: 12,
  }).svg;
  b += button(866, 194, 175, 'Создать заявку', { primary: true, compact: true, icon: '+' });

  const cw = [200, 240, 220, 205, 90];
  const cx0 = 82;
  const heads = ['№', 'Статус', 'Техника', 'Описание', 'Ждёт'];
  b += rect(cx0, 286, 955, 40, { fill: '#fafafa', stroke: C.line });
  let hx = cx0;
  heads.forEach((label, i) => {
    b += text(hx + 12, 312, label, 12, { fill: C.muted, weight: 600 });
    hx += cw[i];
    if (i < heads.length - 1) b += line(hx, 286, hx, 326, { stroke: C.line });
  });

  const rows = [
    {
      y: 326,
      num: 'СО-142',
      author: 'завёл Петров И. С.',
      status: 'new',
      wait: 'Ждёт оператора',
      equip: 'Kyocera ECOSYS M3145',
      equip2: 'инв. 00001802 · АЛ13',
      desc: 'Мнёт бумагу на каждой второй странице',
      age: 'сегодня',
      urgent: true,
      chat: 2,
      fill: '#fcfdff',
    },
    {
      y: 426,
      num: 'СО-138',
      author: 'завёл Петров И. С.',
      status: 'work',
      wait: 'Ждёт исполнителя',
      equip: 'Ricoh Aficio MP 201SPF',
      equip2: 'инв. 00001428 · АЛ13',
      desc: 'Закончился чёрный тонер, печатать нечем',
      age: '2 дня',
      urgent: false,
      chat: 0,
      fill: '#fff',
    },
    {
      y: 526,
      num: 'СО-131',
      author: 'завёл Петров И. С.',
      status: 'done',
      wait: 'Ждёт оператора',
      equip: 'Pantum P2500W',
      equip2: 'инв. 00002011 · АЛ13',
      desc: 'Не берёт бумагу из лотка',
      age: '5 дней',
      urgent: false,
      chat: 0,
      fill: '#fcfdff',
    },
  ];
  for (const row of rows) {
    b += rect(cx0, row.y, 955, 100, { fill: row.fill, stroke: C.line });
    let x = cx0;
    // № — номер и метки под ним: срочность и непрочитанное обсуждение стоят у номера (Р56).
    b += text(x + 12, row.y + 32, row.num, 15, { fill: C.text, weight: 600 });
    if (row.chat) {
      b += circle(x + 84, row.y + 27, 11, { fill: C.blue });
      b += text(x + 84, row.y + 32, String(row.chat), 12, {
        fill: '#fff',
        weight: 700,
        anchor: 'middle',
      });
    }
    if (row.urgent) {
      b += pill(x + 12, row.y + 44, 'Срочная', {
        fill: C.redSoft,
        color: C.red,
        stroke: '#ffccc7',
        size: 12,
        pad: 9,
      }).svg;
    }
    b += text(x + 12, row.y + (row.urgent ? 92 : 58), row.author, 12, { fill: C.faint });
    x += cw[0];
    b += line(x, row.y, x, row.y + 100, { stroke: C.line });
    // Статус
    b += statusTag(x + 12, row.y + 20, row.status, { size: 14 }).svg;
    b += text(x + 12, row.y + 74, row.wait, 13, { fill: C.muted });
    x += cw[1];
    b += line(x, row.y, x, row.y + 100, { stroke: C.line });
    // Техника
    b += paragraph(x + 12, row.y + 38, row.equip, cw[2] - 24, 13, {
      fill: C.text,
      lineHeight: 18,
      maxLines: 2,
    });
    b += text(x + 12, row.y + 78, row.equip2, 12, { fill: C.faint });
    x += cw[2];
    b += line(x, row.y, x, row.y + 100, { stroke: C.line });
    // Описание
    b += paragraph(x + 12, row.y + 40, row.desc, cw[3] - 24, 13, {
      fill: C.text,
      lineHeight: 18,
      maxLines: 3,
    });
    x += cw[3];
    b += line(x, row.y, x, row.y + 100, { stroke: C.line });
    b += text(x + 12, row.y + 56, row.age, 13, { fill: C.text });
  }

  const listNotes = [
    [
      '1',
      'Найти свою',
      'Поиск понимает номер заявки, модель и оба номера аппарата. Отбор «Мои заявки» оставит только заведённые вами.',
      C.blue,
      C.bluePale,
      '#bae0ff',
    ],
    [
      '2',
      'Метка статуса',
      'Строка под ней говорит, кого сейчас ждут: оператора, исполнителя или согласования. От вас в это время не ждут ничего.',
      C.cyan,
      C.cyanSoft,
      '#87e8de',
    ],
    [
      '3',
      'Столбец «Ждёт»',
      'Сколько дней заявка стоит там, где стоит. Счёт начинается заново, когда её передают дальше.',
      C.purple,
      C.purpleSoft,
      '#d3adf7',
    ],
    [
      '4',
      'Синее число',
      'По заявке вам написали. Нажмите на него — откроется лента обсуждения, там же и отвечают.',
      C.green,
      C.greenSoft,
      '#b7eb8f',
    ],
  ];
  listNotes.forEach((note, i) => {
    b += callout(55 + i * 257, 670, 240, 178, note[0], note[1], note[2], {
      fill: note[4],
      stroke: note[5],
      dotFill: note[3],
      bodySize: 13,
    });
  });

  // Карточка.
  b += rect(55, 876, 620, 570, { fill: '#fff', stroke: C.line, r: 16, shadow: true });
  b += text(82, 922, 'Заявка СО-142', 22, { fill: C.ink, weight: 700 });
  b += text(648, 920, '✕', 18, { fill: C.faint, anchor: 'end' });
  const tabs = ['Заявка', 'Объём работ', 'Документы', 'История'];
  let tx = 82;
  tabs.forEach((label, i) => {
    const tabWidth = label.length * 14 * 0.62 + 26;
    b += text(tx + tabWidth / 2, 966, label, 14, {
      fill: i === 0 ? C.blue : C.text,
      weight: i === 0 ? 600 : 400,
      anchor: 'middle',
    });
    if (i === 0) b += line(tx + 2, 982, tx + tabWidth - 2, 982, { stroke: C.blue, sw: 3 });
    tx += tabWidth + 8;
  });
  b += line(82, 983, 648, 983, { stroke: C.line });

  const fields = [
    ['Статус', null, 1022],
    ['Какой аппарат', 'Kyocera ECOSYS M3145', 1082],
    ['Где стоит и для кого', 'АЛ13 · корпус 1, кабинет 214', 1150],
    ['Описание', 'Мнёт бумагу на каждой второй странице', 1206],
    ['Кто обращается', 'Петров И. С. · +7 912 345-67-89', 1252],
    ['Исполнители', 'не назначены', 1298],
    ['Автор', 'Петров И. С. · 01.09.2026 09:14', 1344],
  ];
  for (const [label, value, y] of fields) {
    b += text(82, y, label, 13, { fill: C.muted });
    if (value) b += text(240, y, value, 14, { fill: C.text });
  }
  const statusPill = statusTag(240, 1008, 'new', { size: 14 });
  b += statusPill.svg;
  const urgentPill = pill(240 + statusPill.width + 10, 1008, 'Срочная', {
    fill: C.redSoft,
    color: C.red,
    stroke: '#ffccc7',
    size: 12,
    pad: 9,
  });
  b += urgentPill.svg;
  b += text(
    250 + statusPill.width + urgentPill.width + 12,
    1022,
    'Ждёт оператора · ждёт сегодня',
    13,
    {
      fill: C.muted,
    },
  );
  b += text(240, 1104, 'МФУ · инв. 00001802 · SN R7119', 12, { fill: C.faint });
  b += pill(478, 1136, 'Бухгалтерия', {
    fill: '#fafafa',
    color: C.text,
    stroke: '#d9d9d9',
    size: 12,
    pad: 9,
  }).svg;

  b += line(82, 1376, 648, 1376, { stroke: C.line });
  b += button(82, 1392, 152, 'Обсуждение · 2', { compact: true });
  b += button(246, 1392, 110, 'Действия', { compact: true });
  b += button(368, 1392, 150, 'Редактировать', { primary: true, compact: true });
  b += button(530, 1392, 118, 'Закрыть', { compact: true });

  const cardNotes = [
    [
      '5',
      'Четыре вкладки',
      '«Заявка» — то, что вы написали. «Объём работ» — что предлагает сделать исполнитель и на какую сумму. «Документы» — акт, счёт, гарантийный талон. «История» — кто и когда что менял, там же причина отмены.',
      C.blue,
      C.bluePale,
      '#bae0ff',
    ],
    [
      '6',
      'Обсуждение',
      'Переписка по заявке: выбираете, кому адресовать — службе, системному администратору или сервисному центру. Писать в ней может автор заявки; читают все, кому заявка видна.',
      C.purple,
      C.purpleSoft,
      '#d3adf7',
    ],
    [
      '7',
      '«Редактировать» и «Удалить»',
      'Есть, пока заявка «Новая» и исполнителя ещё не назначили. Технику в правке не меняют: другой аппарат — это другая заявка.',
      C.orange,
      C.orangeSoft,
      '#ffd591',
    ],
  ];
  cardNotes.forEach((note, i) => {
    b += callout(695, 876 + i * 194, 373, 178, note[0], note[1], note[2], {
      fill: note[4],
      stroke: note[5],
      dotFill: note[3],
      bodySize: 13,
    });
  });

  b += footer();
  return document(b);
}

// ── Страница 4: частые вопросы ──

function page4() {
  let b = header(
    4,
    'Частые вопросы',
    'Памятка заявителю · шаг 4',
    'Короткие ответы на то, о чём спрашивают чаще всего. Если ответа здесь нет — напишите в «Обсуждении» заявки: его читают те, кто с ней работает.',
  );

  const qa = [
    [
      'Передумал — как отменить?',
      'Статус заявки вы не двигаете. Пока она «Новая» и исполнителя нет — удалите её сами через «Действия». Дальше попросите отменить того, кто ведёт заявки: он отменит с причиной.',
      C.red,
      C.redSoft,
      '#ffccc7',
    ],
    [
      'Ошибся в описании',
      'Пока заявку никто не взял, откройте её и нажмите «Редактировать». Аппарат при правке не меняется: перепутали технику — заводите новую заявку, а эту удалите.',
      C.blue,
      C.bluePale,
      '#bae0ff',
    ],
    [
      '«По этой технике уже есть незакрытая заявка»',
      'Портал не даёт завести вторую такую же заявку на один аппарат и называет номер первой. Откройте её и допишите нужное в «Обсуждении».',
      C.orange,
      C.orangeSoft,
      '#ffd591',
    ],
    [
      '«Обслуживание» или «Расходники»?',
      'Сломалось, мнёт, не печатает, надо настроить или подключить — «Обслуживание». Кончился картридж или тонер — «Расходники». У заведённой заявки вид уже не меняется.',
      C.purple,
      C.purpleSoft,
      '#d3adf7',
    ],
    [
      'Что писать в «Описании»?',
      'То, что видите, и подробно: «мнёт бумагу на каждой второй странице» лучше, чем «не работает». Фото поможет ещё больше — кнопка «Прикрепить фото и документы» внизу формы.',
      C.cyan,
      C.cyanSoft,
      '#87e8de',
    ],
    [
      'Когда отмечать срочной?',
      'Когда работа встала: «единственный принтер на площадке, встала выдача пропусков». Причина обязательна, и её читают — срочные разбирают вне очереди.',
      C.gold,
      C.goldSoft,
      '#ffe58f',
    ],
    [
      'Аппарат стоит не там, где написано',
      'Отметьте в форме «Аппарат стоит на другом объекте» и укажите, где он на самом деле. Справочник этим не правится: технику перенесёт ИТ-служба, разобрав расхождения.',
      C.green,
      C.greenSoft,
      '#b7eb8f',
    ],
    [
      'Заявка закрылась сама',
      'Так и задумано: если через сутки после «Решена» никто не возразил, портал закрывает её сам. Что-то не так — скажите до того, как сутки вышли.',
      C.muted,
      C.graySoft,
      '#d9d9d9',
    ],
  ];

  qa.forEach(([question, answer, color, fill, stroke], i) => {
    const x = 55 + (i % 2) * 516;
    const y = 200 + Math.floor(i / 2) * 236;
    b += rect(x, y, 497, 216, { fill, stroke, r: 14 });
    b += circle(x + 30, y + 40, 17, { fill: color });
    b += text(x + 30, y + 47, '?', 19, { fill: '#fff', weight: 700, anchor: 'middle' });
    b += paragraph(x + 60, y + 40, question, 415, 18, {
      fill: C.ink,
      weight: 700,
      lineHeight: 24,
      maxLines: 2,
    });
    b += paragraph(x + 28, y + 110, answer, 441, 15, { fill: C.text, lineHeight: 23, maxLines: 4 });
  });

  b += rect(55, 1146, 1013, 200, { fill: C.ink, r: 16 });
  b += text(82, 1196, 'Коротко', 24, { fill: '#fff', weight: 700 });
  const short = [
    'Аппарат и описание — обязательны.',
    'Срочно — только с настоящей причиной.',
    'Пока «Новая» — правьте сами. Дальше — служба.',
    'Всё общение по заявке — в «Обсуждении».',
  ];
  short.forEach((item, i) => {
    const x = 82 + (i % 2) * 496;
    const y = 1248 + Math.floor(i / 2) * 52;
    b += circle(x + 9, y - 5, 9, { fill: C.blue });
    b += path(`M ${x + 4} ${y - 5} l 4 4 l 8 -9`, { stroke: '#fff', sw: 2.4 });
    b += paragraph(x + 32, y, item, 440, 16, { fill: '#fff', lineHeight: 22, maxLines: 1 });
  });

  b += rect(55, 1372, 1013, 96, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  b += text(82, 1412, 'Не получается завести заявку?', 17, { fill: C.blue, weight: 700 });
  b += paragraph(
    82,
    1442,
    'Техники нет в справочнике — «Не нашли технику?» под полем и кнопка «Написать в техподдержку». Не открывается раздел «Орг.техника» — это вопрос к администратору портала.',
    959,
    14,
    { fill: C.text, lineHeight: 21 },
  );

  b += footer(`Памятка заявителю • Орг.техника • редакция ${DATE}`);
  return document(b);
}

const pages = [page1(), page2(), page3(), page4()];

for (const [index, svg] of pages.entries()) {
  const stem = `office-equipment-requester-${String(index + 1).padStart(2, '0')}`;
  const svgPath = join(WORK, `${stem}.svg`);
  const pngPath = join(WORK, `${stem}.png`);
  writeFileSync(svgPath, svg);
  const rendered = spawnSync(
    'python3',
    [resolve('docs/render-svg-to-png.py'), svgPath, pngPath, String(W)],
    { encoding: 'utf8' },
  );
  if (rendered.status !== 0) {
    throw new Error(
      `Страница ${index + 1} не отрисовалась:\n${rendered.stdout}\n${rendered.stderr}`,
    );
  }
}

const pdf = await PDFDocument.create();
pdf.setTitle('Орг.техника: памятка заявителю');
pdf.setSubject('Как завести заявку на обслуживание оргтехники и что с ней происходит дальше');
pdf.setKeywords(['оргтехника', 'заявка', 'обслуживание', 'расходники', 'памятка']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-01T12:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `office-equipment-requester-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
