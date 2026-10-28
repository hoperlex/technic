/**
 * Short instruction for the driver and the machinist.
 *
 * Facts and captions are checked against the interface as of 28.10.2026:
 * - RegisterPage.tsx;
 * - DriverLayout.tsx, DriverDayView.tsx, DriverReadingsPage.tsx, DriverReadingFields.tsx,
 *   DriverRouteTimes.tsx, DriverSubmitCheck.tsx, readingChecks.ts;
 * - ADR 0237: readings go as a whole shift at its end, the previous shift is checked in a window
 *   before sending, and the time fields have no «сейчас» button.
 *
 * A page is drawn in SVG, the system librsvg turns it into PNG, and pdf-lib assembles A4. The other
 * illustrated instructions of the project use the same route; it needs no browser and makes the
 * result reproducible from the repository.
 *
 * node docs/generate-driver-guide.mjs [output.pdf]   (default: docs/Инструкция_водителю_и_машинисту.pdf)
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Инструкция_водителю_и_машинисту.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'driver-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 5;
const REVISION = '28 октября 2026';

const C = {
  ink: '#172033',
  text: '#303744',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e4e9f0',
  panel: '#ffffff',
  surface: '#f6f8fb',
  blue: '#1677ff',
  blueDark: '#0958d9',
  blueSoft: '#e6f4ff',
  bluePale: '#f3f8ff',
  green: '#389e0d',
  greenSoft: '#f6ffed',
  orange: '#d46b08',
  orangeSoft: '#fff7e6',
  gold: '#ad6800',
  goldSoft: '#fffbe6',
  red: '#cf1322',
  redSoft: '#fff1f0',
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
  const factor = weight >= 600 ? 0.64 : 0.59;
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

function text(x, y, value, size = 22, options = {}) {
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
    .map((lineValue, index) => text(x, y + index * lineHeight, lineValue, size, textOptions))
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
  const { stroke = C.line, sw = 1, dash, opacity = 1 } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function circle(cx, cy, radius, options = {}) {
  const { fill = 'none', stroke = 'none', sw = 1, shadow = false } = options;
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${shadow ? ' filter="url(#shadow)"' : ''}/>`;
}

function path(d, options = {}) {
  const { fill = 'none', stroke = C.text, sw = 2, dash } = options;
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function defs() {
  return `<defs>
    <filter id="shadow" x="-25%" y="-25%" width="150%" height="170%">
      <feDropShadow dx="0" dy="10" stdDeviation="13" flood-color="#172033" flood-opacity="0.12"/>
    </filter>
    <filter id="smallShadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#172033" flood-opacity="0.16"/>
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
    text(110, 54, kicker.toUpperCase(), 15, { fill: C.blue, weight: 700, letter: 1.3 }),
    text(110, 92, titleValue, 35, { fill: C.ink, weight: 700 }),
    text(1068, 70, `${String(page).padStart(2, '0')} / ${String(TOTAL).padStart(2, '0')}`, 17, {
      fill: C.faint,
      weight: 600,
      anchor: 'end',
    }),
    line(55, 120, 1068, 120),
  ].join('');
}

function footer() {
  return (
    line(55, 1530, 1068, 1530) +
    text(55, 1560, `Инструкция водителю и машинисту • актуально на ${REVISION}`, 14, {
      fill: C.faint,
    }) +
    text(1068, 1560, 'АВТО', 14, {
      fill: C.blue,
      weight: 700,
      anchor: 'end',
      letter: 1.2,
    })
  );
}

function dot(number, x, y, options = {}) {
  const { fill = C.blue, radius = 19 } = options;
  return (
    circle(x, y, radius, { fill, stroke: '#fff', sw: 4, shadow: true }) +
    text(x, y + 7, number, radius + 2, { fill: '#fff', weight: 700, anchor: 'middle' })
  );
}

function check(x, y, color = C.green) {
  return path(`M ${x} ${y} l 7 8 l 15 -18`, { stroke: color, sw: 4 });
}

function pill(x, y, label, options = {}) {
  const { fill = C.blueSoft, color = C.blue, stroke = 'none', size = 14, width } = options;
  const actualWidth = width ?? Math.max(50, label.length * size * 0.72 + 24);
  return (
    rect(x, y, actualWidth, size + 17, { fill, stroke, r: (size + 17) / 2 }) +
    text(x + actualWidth / 2, y + size + 1, label, size, {
      fill: color,
      weight: 600,
      anchor: 'middle',
    })
  );
}

function step(x, y, number, titleValue, body, width, options = {}) {
  const { fill = C.blueSoft, stroke = '#91caff', dotFill = C.blue, height = 126 } = options;
  let output = rect(x, y, width, height, { fill, stroke, r: 14 });
  output += circle(x + 35, y + 36, 19, { fill: dotFill });
  output += text(x + 35, y + 43, number, 19, { fill: '#fff', weight: 700, anchor: 'middle' });
  output += text(x + 68, y + 37, titleValue, 19, { fill: C.ink, weight: 700 });
  output += paragraph(x + 68, y + 70, body, width - 92, 16, {
    fill: C.text,
    lineHeight: 22,
    maxLines: 3,
  });
  return output;
}

function note(x, y, width, height, titleValue, body, options = {}) {
  const { fill = C.greenSoft, stroke = '#b7eb8f', color = C.green } = options;
  let output = rect(x, y, width, height, { fill, stroke, r: 14 });
  output += check(x + 26, y + 37, color);
  output += text(x + 59, y + 38, titleValue, 18, { fill: color, weight: 700 });
  output += paragraph(x + 24, y + 75, body, width - 48, 16, {
    fill: C.text,
    lineHeight: 23,
  });
  return output;
}

function field(x, y, width, label, value = '', options = {}) {
  const { suffix, placeholder = false, height = 49, selected = false, error, hint } = options;
  let output = text(x, y, label, 14, { fill: C.text, weight: 500 });
  output += rect(x, y + 10, width, height, {
    fill: '#fff',
    stroke: error ? C.red : selected ? C.blue : '#d9d9d9',
    sw: error || selected ? 2 : 1,
    r: 7,
  });
  if (value)
    output += text(x + 13, y + 10 + height / 2 + 6, value, 16, {
      fill: placeholder ? C.faint : C.text,
      weight: selected ? 500 : 400,
    });
  if (suffix)
    output += text(x + width - 13, y + 10 + height / 2 + 6, suffix, 14, {
      fill: C.muted,
      anchor: 'end',
    });
  // A refusal replaces the hint: the real form shows one line under a field, red when it refuses.
  if (error) output += text(x, y + 10 + height + 20, error, 13, { fill: C.red });
  else if (hint) output += text(x, y + 10 + height + 20, hint, 13, { fill: C.muted });
  return output;
}

function button(x, y, width, label, options = {}) {
  const { primary = true, height = 48, disabled = false } = options;
  const fill = disabled ? '#f5f5f5' : primary ? C.blue : '#fff';
  const stroke = disabled ? '#e5e5e5' : primary ? C.blue : '#d9d9d9';
  const color = disabled ? C.faint : primary ? '#fff' : C.text;
  return (
    rect(x, y, width, height, { fill, stroke, r: 7 }) +
    text(x + width / 2, y + height / 2 + 7, label, 17, {
      fill: color,
      weight: 600,
      anchor: 'middle',
    })
  );
}

function appChrome(x, y, width, options = {}) {
  const { page = 'Показания', pending = false } = options;
  let output = rect(x, y, width, 114, { fill: '#fff' });
  output += line(x, y + 114, x + width, y + 114);
  output += circle(x + 30, y + 31, 17, { fill: C.blue });
  output += text(x + 30, y + 38, 'A', 20, { fill: '#fff', weight: 700, anchor: 'middle' });
  output += text(x + 78, y + 38, '‹', 31, { fill: C.ink, anchor: 'middle' });
  output += text(x + width / 2, y + 36, 'Сегодня', 18, { fill: C.ink, weight: 600, anchor: 'middle' });
  output += text(x + width - 78, y + 38, '›', 31, { fill: C.ink, anchor: 'middle' });
  output += circle(x + width - 30, y + 31, 16, { fill: '#d6e4ff' });
  output += text(x + width - 30, y + 37, 'ИИ', 11, { fill: C.blueDark, weight: 700, anchor: 'middle' });
  output += rect(x + 13, y + 58, width - 26, 42, { fill: C.blueSoft, r: 7 });
  output += text(x + width / 2, y + 85, page === 'Показания' ? 'Задание' : 'Показания', 16, {
    fill: C.blueDark,
    weight: 600,
    anchor: 'middle',
  });
  if (pending) output += text(x + 14, y + 132, 'Не переданы показания за 27 окт.', 13, { fill: C.orange, weight: 600 });
  return output;
}

function page1() {
  let body = pageHeader(1, 'Регистрация и вход', 'АВТО · ВОДИТЕЛЬ / МАШИНИСТ');
  body += paragraph(
    55,
    163,
    'Зарегистрируйтесь один раз. Машинист и тракторист в форме тоже выбирают «Водитель».',
    1000,
    20,
    { fill: C.muted, lineHeight: 28 },
  );

  body += step(55, 238, '1', 'Откройте портал', 'Зайдите на auto.su10.ru и нажмите «Зарегистрироваться».', 465);
  body += step(55, 382, '2', 'Заполните контакты', 'Фамилия, имя, отчество, email, телефон и пароль.', 465);
  body += step(55, 526, '3', 'Выберите должность', 'В поле «Кем вы работаете» выберите «Водитель».', 465, {
    fill: C.orangeSoft,
    stroke: '#ffd591',
    dotFill: C.orange,
  });
  body += step(
    55,
    670,
    '4',
    'Пройдите проверку',
    'Если на форме есть «Я не робот» — отметьте. Затем нажмите «Зарегистрироваться».',
    465,
  );

  body += note(
    55,
    832,
    465,
    157,
    'После регистрации',
    'Подтверждать email не нужно. Дождитесь активации и звонка администратора; до активации войти нельзя.',
  );
  body += note(
    55,
    1012,
    465,
    153,
    'Пароль и вход',
    'После активации войдите по своему email и паролю. Ссылка «Забыли пароль?» находится на экране входа.',
    { fill: C.bluePale, stroke: '#bae0ff', color: C.blueDark },
  );
  body += rect(55, 1190, 465, 177, { fill: C.goldSoft, stroke: '#ffe58f', r: 14 });
  body += text(80, 1230, 'Машинисту и трактористу', 18, { fill: C.gold, weight: 700 });
  body += paragraph(
    80,
    1265,
    'Отдельной роли в списке нет. Выберите «Водитель» — после активации откроется тот же кабинет с заданием и показаниями.',
    415,
    17,
    { lineHeight: 25 },
  );

  const sx = 560;
  const sy = 226;
  const sw = 508;
  body += text(sx, 194, 'ФОРМА РЕГИСТРАЦИИ', 16, { fill: C.muted, weight: 700, letter: 0.8 });
  body += rect(sx, sy, sw, 1188, { fill: '#fff', stroke: '#d6deea', r: 22, shadow: true });
  body += text(sx + sw / 2, sy + 62, 'Регистрация', 25, { fill: C.ink, weight: 700, anchor: 'middle' });
  body += paragraph(
    sx + 55,
    sy + 102,
    'После регистрации аккаунт будет неактивен до активации администратором.',
    sw - 110,
    14,
    { fill: C.muted, lineHeight: 20 },
  );
  body += field(sx + 46, sy + 170, sw - 92, 'Фамилия', 'Иванов');
  body += field(sx + 46, sy + 252, sw - 92, 'Имя', 'Иван');
  body += field(sx + 46, sy + 334, sw - 92, 'Отчество', 'Иванович');
  body += field(sx + 46, sy + 416, sw - 92, 'Email', 'ivanov@example.ru');
  body += field(sx + 46, sy + 498, sw - 92, 'Телефон', '+7 (___) ___-__-__', { placeholder: true });
  body += field(sx + 46, sy + 580, sw - 92, 'Пароль', '••••••••••');
  body += field(sx + 46, sy + 662, sw - 92, 'Кем вы работаете', 'Водитель', { selected: true });
  body += text(sx + 46, sy + 744, 'Доступ назначит администратор при активации', 13, { fill: C.muted });
  body += field(sx + 46, sy + 784, sw - 92, 'Комментарий', 'Машинист экскаватора', {
    placeholder: true,
    height: 58,
  });
  body += text(sx + 46, sy + 891, 'Проверка', 14, { fill: C.text, weight: 500 });
  body += rect(sx + 46, sy + 905, sw - 92, 73, { fill: '#fafafa', stroke: '#d9d9d9', r: 7 });
  body += rect(sx + 67, sy + 929, 24, 24, { fill: '#fff', stroke: C.blue, sw: 2, r: 4 });
  body += check(sx + 70, sy + 944, C.blue);
  body += text(sx + 106, sy + 948, 'Я не робот', 16, { fill: C.text, weight: 500 });
  body += text(sx + sw - 64, sy + 938, 'Smart', 11, { fill: C.faint, anchor: 'end' });
  body += text(sx + sw - 64, sy + 954, 'Captcha', 11, { fill: C.faint, anchor: 'end' });
  body += button(sx + 46, sy + 1007, sw - 92, 'Зарегистрироваться');
  body += text(sx + sw / 2, sy + 1091, 'Уже есть аккаунт?  Войти', 14, { fill: C.blue, anchor: 'middle' });
  body += dot('3', sx + 22, sy + 715, { fill: C.orange });
  body += dot('4', sx + 22, sy + 948);
  body += footer();
  return document(body);
}

function page2() {
  let body = pageHeader(2, 'Кабинет на каждый день', 'АВТО · ВОДИТЕЛЬ / МАШИНИСТ');
  body += paragraph(
    55,
    163,
    'После входа сразу открывается форма показаний за сегодня. Показания передаются один раз — в конце смены. Задание — соседняя страница того же дня.',
    1000,
    20,
    { fill: C.muted, lineHeight: 28 },
  );

  const sx = 55;
  const sy = 230;
  const sw = 520;
  const sh = 875;
  body += rect(sx, sy, sw, sh, { fill: '#fff', stroke: '#d6deea', r: 22, shadow: true });
  body += appChrome(sx, sy, sw, { page: 'Показания', pending: true });
  body += text(sx + 24, sy + 184, 'Показания за 28 октября', 23, { fill: C.ink, weight: 700 });
  body += text(sx + 24, sy + 224, 'Передать показания', 18, { fill: C.ink, weight: 700 });
  body += rect(sx + 24, sy + 252, sw - 48, 466, { fill: '#fff', stroke: C.line, r: 12 });
  body += text(sx + 46, sy + 290, 'А123ВС 77', 22, { fill: C.ink, weight: 700 });
  body += text(sx + 46, sy + 318, 'Путевой лист ПЛ-00421 · смена 1', 14, { fill: C.muted });
  body += text(sx + 46, sy + 365, 'Начало смены', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 46, sy + 396, sw - 92, 'Топливо', '', { suffix: 'л' });
  body += text(sx + 46, sy + 493, 'За смену', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 46, sy + 524, sw - 92, 'Заправлено', '', { suffix: 'л' });
  body += text(sx + 46, sy + 621, 'Конец смены', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 46, sy + 652, sw - 92, 'Одометр', '', { suffix: 'км' });
  body += button(sx + 24, sy + 786, sw - 48, 'Передать');
  body += dot('1', sx + 75, sy + 32);
  body += dot('2', sx + sw - 34, sy + 79);
  body += dot('3', sx + sw - 23, sy + 130, { fill: C.orange });
  body += dot('4', sx + sw - 30, sy + 32, { fill: C.green });

  body += step(615, 230, '1', 'Выберите день', 'Стрелки листают дни; нажмите на «Сегодня», чтобы открыть календарь.', 453, {
    height: 133,
  });
  body += step(615, 381, '2', 'Переключайте экран', '«Задание» открывает маршрут. На нём ссылка меняется на «Показания».', 453, {
    height: 133,
  });
  body += step(615, 532, '3', 'Закройте прошлые дни', 'Оранжевая строка ведёт к ближайшему дню, где показания ещё не переданы.', 453, {
    fill: C.orangeSoft,
    stroke: '#ffd591',
    dotFill: C.orange,
    height: 133,
  });
  body += step(615, 683, '4', 'Откройте меню', 'В круге справа — «Сменить пароль» и «Выйти».', 453, {
    fill: C.greenSoft,
    stroke: '#b7eb8f',
    dotFill: C.green,
    height: 133,
  });

  body += text(615, 877, 'ОКНО РАБОТЫ С ДАТОЙ', 14, { fill: C.muted, weight: 700, letter: 0.8 });
  body += rect(615, 897, 453, 208, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  body += text(642, 937, 'Передать самому', 17, { fill: C.blueDark, weight: 700 });
  body += paragraph(642, 970, 'Сегодня и 7 предыдущих дней.', 390, 17, { lineHeight: 25 });
  body += text(642, 1030, 'Посмотреть задание', 17, { fill: C.blueDark, weight: 700 });
  body += paragraph(642, 1063, 'В пределах календаря кабинета; будущие дни доступны только для просмотра.', 390, 16, {
    lineHeight: 23,
  });

  body += text(55, 1160, 'Что делать в течение смены', 25, { fill: C.ink, weight: 700 });
  body += line(122, 1248, 1003, 1248, { stroke: '#91caff', sw: 5 });
  const moments = [
    { x: 130, n: '1', title: 'Начало смены', body: 'Запишите остаток топлива в баке', fill: C.blue },
    { x: 412, n: '2', title: 'За смену', body: 'Запишите, сколько заправили', fill: C.orange },
    { x: 710, n: '3', title: 'Конец смены', body: 'Снимите одометр или моточасы и остаток топлива', fill: C.green },
    { x: 1000, n: '4', title: 'Передать', body: 'Один раз, когда всё заполнено', fill: C.blueDark },
  ];
  for (const moment of moments) {
    body += circle(moment.x, 1248, 27, { fill: moment.fill, stroke: '#fff', sw: 5 });
    body += text(moment.x, 1257, moment.n, 22, { fill: '#fff', weight: 700, anchor: 'middle' });
    body += text(moment.x, 1311, moment.title, 17, { fill: C.ink, weight: 700, anchor: 'middle' });
    body += paragraph(moment.x, 1343, moment.body, 224, 15, {
      fill: C.muted,
      lineHeight: 21,
      anchor: 'middle',
    });
  }
  body += note(
    55,
    1404,
    1013,
    110,
    'Передавайте смену целиком',
    'Отправить одну утреннюю часть нельзя. Введённое сохраняется на телефоне как черновик, а передать его можно, когда заполнены все обязательные поля.',
    { fill: C.orangeSoft, stroke: '#ffd591', color: C.orange },
  );
  body += footer();
  return document(body);
}

function page3() {
  let body = pageHeader(3, 'Передача показаний', 'АВТО · ВОДИТЕЛЬ / МАШИНИСТ');
  body += paragraph(
    55,
    163,
    'Показания передаются целиком, один раз за смену. Заполните все поля, кроме «Заправлено»: если не заправлялись, оставьте его пустым.',
    1000,
    20,
    { fill: C.muted, lineHeight: 28 },
  );

  const sx = 55;
  const sy = 226;
  const sw = 540;
  const sh = 1224;
  body += rect(sx, sy, sw, sh, { fill: '#fff', stroke: '#d6deea', r: 22, shadow: true });
  body += appChrome(sx, sy, sw, { page: 'Показания' });
  body += text(sx + 24, sy + 154, 'Показания за 28 октября', 23, { fill: C.ink, weight: 700 });
  body += text(sx + 24, sy + 194, 'Черновик', 18, { fill: C.ink, weight: 700 });
  body += text(sx + 24, sy + 221, 'Заполнено, но не передано', 14, { fill: C.muted });
  body += rect(sx + 22, sy + 247, sw - 44, 880, { fill: '#fff', stroke: C.line, r: 12 });
  body += text(sx + 44, sy + 286, 'А123ВС 77', 22, { fill: C.ink, weight: 700 });
  body += text(sx + 44, sy + 315, 'Путевой лист ПЛ-00421 · смена 1', 14, { fill: C.muted });

  body += text(sx + 44, sy + 361, 'Начало смены', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 44, sy + 392, sw - 88, 'Топливо', '92', {
    suffix: 'л',
    selected: true,
    hint: 'в конце прошлой смены: 92 л (27.10)',
  });
  body += text(sx + 44, sy + 512, 'За смену', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 44, sy + 543, sw - 88, 'Заправлено', '75', { suffix: 'л' });
  body += text(sx + 44, sy + 639, 'Конец смены', 17, { fill: C.ink, weight: 700 });
  body += field(sx + 44, sy + 670, sw - 88, 'Одометр', '145320', {
    suffix: 'км',
    hint: 'предыдущее: 145 108 (27.10)',
  });
  body += field(sx + 44, sy + 781, sw - 88, 'Моточасы', '', {
    suffix: 'ч',
    hint: 'предыдущее: 3 233,5 (27.10)',
  });
  body += field(sx + 44, sy + 892, sw - 88, 'Топливо', '60', { suffix: 'л' });
  body += field(sx + 44, sy + 986, sw - 88, 'Комментарий', 'Заправка по чеку', { height: 53 });
  body += button(sx + 44, sy + 1074, 213, 'Прикрепить фото', { primary: false, height: 44 });
  body += text(sx + 275, sy + 1102, 'чек_28-10.jpg', 13, { fill: C.blue });
  body += button(sx + 22, sy + 1150, sw - 44, 'Передать');

  body += dot('1', sx + sw - 20, sy + 286);
  body += dot('2', sx + sw - 20, sy + 427, { fill: C.orange });
  body += dot('3', sx + sw - 20, sy + 704, { fill: C.green });
  body += dot('4', sx + sw - 20, sy + 471);
  body += dot('5', sx + sw - 20, sy + 1174);

  body += step(635, 226, '1', 'Проверьте машину', 'Госномер стоит первым; ниже указан источник и смена.', 433, { height: 126 });
  body += step(635, 370, '2', 'Обязательные поля', 'Все, кроме «Заправлено». Не заправлялись — оставьте пустым.', 433, {
    fill: C.orangeSoft,
    stroke: '#ffd591',
    dotFill: C.orange,
    height: 126,
  });
  body += step(635, 514, '3', 'Одометр или моточасы', 'Достаточно одного: того, что есть на вашей машине.', 433, {
    fill: C.greenSoft,
    stroke: '#b7eb8f',
    dotFill: C.green,
    height: 126,
  });
  body += step(635, 658, '4', 'Сверьте с подсказками', 'Под топливом — остаток с конца прошлой смены, под счётчиками — их прошлые значения.', 433, {
    height: 126,
  });
  body += step(635, 802, '5', 'Нажмите «Передать»', 'После успеха появится состояние «Передано». Фото и комментарий — по желанию.', 433, {
    height: 126,
  });

  body += rect(635, 966, 433, 300, { fill: C.goldSoft, stroke: '#ffe58f', r: 14 });
  body += text(660, 1007, 'Если поле подсвечено красным', 17, { fill: C.gold, weight: 700 });
  body += field(660, 1030, 383, 'Топливо', '', {
    suffix: 'л',
    error: 'Укажите остаток топлива на конец смены',
  });
  body += paragraph(
    660,
    1150,
    'Под полем написано, чего не хватает. Заполните его и нажмите «Передать» снова. Пока блок не заполнен целиком, данные не передаются.',
    383,
    16,
    { lineHeight: 23 },
  );

  body += rect(635, 1286, 433, 200, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  body += text(660, 1327, 'Если машин несколько', 17, { fill: C.blueDark, weight: 700 });
  body += paragraph(
    660,
    1363,
    'Каждая машина показана отдельным блоком. Блок, в который ничего не введено, портал пропустит: сдайте его, когда эта смена закончится. Начатый блок должен быть заполнен целиком.',
    383,
    16,
    { lineHeight: 23 },
  );
  body += footer();
  return document(body);
}

function windowCard(mx, my, mw, mh) {
  let output = rect(mx, my, mw, mh, { fill: '#fff', r: 14, shadow: true });
  output += circle(mx + 38, my + 46, 14, { fill: '#faad14' });
  output += text(mx + 38, my + 53, '!', 18, { fill: '#fff', weight: 700, anchor: 'middle' });
  output += text(mx + 64, my + 53, 'Проверьте данные перед передачей', 17, { fill: C.ink, weight: 700 });
  output += paragraph(mx + 28, my + 104, 'В указанных данных выявлены следующие расхождения:', mw - 56, 15, {
    lineHeight: 22,
  });
  output += text(mx + 28, my + 170, '1.', 15, { fill: C.ink, weight: 700 });
  output += text(mx + 52, my + 170, 'А123ВС 77 · Путевой лист ПЛ-00421', 15, { fill: C.ink, weight: 700 });
  output += paragraph(
    mx + 52,
    my + 196,
    'Топливо на начало смены (80 л) не совпадает с остатком на конец прошлой смены (92 л, 27.10)',
    mw - 80,
    15,
    { lineHeight: 22 },
  );
  output += text(mx + 28, my + 290, '2.', 15, { fill: C.ink, weight: 700 });
  output += text(mx + 52, my + 290, 'В010ОР 77 · ЭСМ-2 № 000318', 15, { fill: C.ink, weight: 700 });
  output += paragraph(mx + 52, my + 316, 'Одометр: меньше предыдущего (145 320 от 27.10)', mw - 80, 15, {
    lineHeight: 22,
  });
  output += paragraph(
    mx + 28,
    my + 400,
    'Подтверждаете ли вы, что значения сняты с приборов верно? Если допущена ошибка, вернитесь к форме и исправьте её.',
    mw - 56,
    15,
    { lineHeight: 22 },
  );
  output += button(mx + 28, my + 480, mw - 56, 'Вернуться к исправлению', { primary: false });
  output += button(mx + 28, my + 540, mw - 56, 'Подтверждаю, передать');
  return output;
}

function page4() {
  let body = pageHeader(4, 'Проверка данных и время', 'АВТО · ВОДИТЕЛЬ / МАШИНИСТ');
  body += paragraph(
    55,
    163,
    'Если введённое расходится с прошлой сменой, портал спросит один раз — при нажатии «Передать». Время смены вводится вручную.',
    1000,
    20,
    { fill: C.muted, lineHeight: 28 },
  );

  const sx = 55;
  const sy = 226;
  const sw = 540;
  const sh = 760;
  body += rect(sx, sy, sw, sh, { fill: '#e9edf3', stroke: '#d6deea', r: 22, shadow: true });
  // The form behind the window, dimmed: the window opens over it and changes nothing in it.
  body += rect(sx + 24, sy + 24, sw - 48, 36, { fill: '#dde3ec', r: 8 });
  body += rect(sx + 24, sy + 76, sw - 48, 22, { fill: '#dde3ec', r: 8 });
  body += rect(sx + 24, sy + 700, sw - 48, 36, { fill: '#cfd8e6', r: 8 });
  const mx = sx + 36;
  const my = sy + 80;
  const mw = sw - 72;
  body += windowCard(mx, my, mw, 620);
  body += dot('1', sx + sw - 18, my + 46);
  body += dot('2', sx + sw - 18, my + 190);
  body += dot('3', sx + sw - 18, my + 503, { fill: C.orange });
  body += dot('4', sx + sw - 18, my + 563, { fill: C.green });

  body += step(635, 226, '1', 'Окно появляется само', 'Если данные расходятся с прошлой сменой, при «Передать» откроется список.', 433, {
    height: 126,
  });
  body += step(635, 370, '2', 'Сверьте с прибором', 'Проверьте каждую строку списка по показаниям на машине.', 433, { height: 126 });
  body += step(635, 514, '3', 'Ошибка? Вернитесь', 'Нажмите «Вернуться к исправлению»: ничего не будет передано.', 433, {
    fill: C.orangeSoft,
    stroke: '#ffd591',
    dotFill: C.orange,
    height: 126,
  });
  body += step(635, 658, '4', 'Всё верно? Подтвердите', 'Нажмите «Подтверждаю, передать»: показания будут переданы.', 433, {
    fill: C.greenSoft,
    stroke: '#b7eb8f',
    dotFill: C.green,
    height: 126,
  });
  body += rect(635, 806, 433, 180, { fill: C.goldSoft, stroke: '#ffe58f', r: 14 });
  body += text(660, 847, 'Расхождение — не всегда ошибка', 17, { fill: C.gold, weight: 700 });
  body += paragraph(
    660,
    883,
    'Счётчик могли заменить, топливо — слить или долить. Подтверждайте, только если значения списаны с приборов.',
    383,
    16,
    { lineHeight: 23 },
  );

  body += text(55, 1052, 'Время смены и маршрута', 25, { fill: C.ink, weight: 700 });

  // Недельный лист: пара «начало — конец».
  const cy = 1084;
  body += rect(55, cy, 497, 410, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  body += text(81, cy + 42, 'Недельный лист (ЭСМ-2)', 18, { fill: C.blueDark, weight: 700 });
  body += field(81, cy + 75, 210, 'Время начала', '08:00');
  body += field(316, cy + 75, 210, 'Время окончания', '20:00', { hint: 'смена 12 ч' });
  body += paragraph(
    81,
    cy + 200,
    'Время вводится с клавиатуры: достаточно цифр, «730» станет 07:30. Если конец раньше начала, смена считается ночной.',
    445,
    16,
    { lineHeight: 23 },
  );
  body += paragraph(
    81,
    cy + 290,
    'Кнопки «сейчас» нет: укажите то время, которое было на самом деле.',
    445,
    16,
    { lineHeight: 23, fill: C.muted },
  );

  // Рейс: время по точкам.
  body += rect(571, cy, 497, 410, { fill: C.greenSoft, stroke: '#b7eb8f', r: 14 });
  body += text(597, cy + 42, 'Рейс по маршруту', 18, { fill: C.green, weight: 700 });
  body += text(597, cy + 80, '1. Склад, ул. Промышленная, 12', 15, { fill: C.ink, weight: 700 });
  body += field(597, cy + 104, 212, 'Прибытие', '07:40');
  body += field(832, cy + 104, 212, 'Убытие', '08:30');
  body += text(597, cy + 206, '2. Объект, ул. Строителей, 48', 15, { fill: C.ink, weight: 700 });
  body += field(597, cy + 230, 212, 'Убытие', '10:05');
  body += paragraph(
    597,
    cy + 318,
    'На первой точке отмечаются прибытие (начало смены) и убытие, на остальных — убытие. Убытие с последней точки — конец смены. Для перегона время не вводится.',
    445,
    16,
    { lineHeight: 23 },
  );
  body += footer();
  return document(body);
}

function page5() {
  let body = pageHeader(5, 'Задание и статусы', 'АВТО · ВОДИТЕЛЬ / МАШИНИСТ');
  body += paragraph(
    55,
    163,
    'Задание показывает машину, порядок точек, время, работу и контакты. Изменять его в кабинете нельзя.',
    1000,
    20,
    { fill: C.muted, lineHeight: 28 },
  );

  const sx = 55;
  const sy = 226;
  const sw = 570;
  const sh = 938;
  body += rect(sx, sy, sw, sh, { fill: '#fff', stroke: '#d6deea', r: 22, shadow: true });
  body += appChrome(sx, sy, sw, { page: 'Задание' });
  body += rect(sx + 22, sy + 140, sw - 44, 738, { fill: '#fff', stroke: C.line, r: 12 });
  body += text(sx + 43, sy + 181, 'Рейс Р-128', 20, { fill: C.ink, weight: 700 });
  body += pill(sx + 193, sy + 157, 'Грузоперевозка', { fill: '#fafafa', color: C.muted });
  body += text(sx + 43, sy + 226, 'Машина', 13, { fill: C.muted });
  body += text(sx + 127, sy + 226, 'А123ВС 77 · гар. № 15', 17, { fill: C.text, weight: 500 });
  body += text(sx + 43, sy + 263, 'Прицеп', 13, { fill: C.muted });
  body += text(sx + 127, sy + 263, 'В456ОР 77', 16, { fill: C.text });

  body += line(sx + 43, sy + 298, sx + sw - 43, sy + 298);
  body += text(sx + 43, sy + 336, 'Точка 1', 18, { fill: C.ink, weight: 700 });
  body += pill(sx + 145, sy + 311, '08:30', { width: 75 });
  body += text(sx + 43, sy + 378, 'Адрес', 13, { fill: C.muted });
  body += paragraph(sx + 127, sy + 378, 'Склад, ул. Промышленная, 12', sw - 190, 17, {
    fill: C.ink,
    weight: 600,
    lineHeight: 23,
  });
  body += text(sx + 43, sy + 432, 'Погрузка', 16, { fill: C.ink, weight: 700 });
  body += text(sx + 155, sy + 432, 'ТС-241/1 · песок', 16, { fill: C.text });
  body += text(sx + 43, sy + 472, 'Встречает', 13, { fill: C.muted });
  body += text(sx + 142, sy + 472, 'Петров П.П. · +7 900 123-45-67', 17, { fill: C.blue, weight: 500 });

  body += line(sx + 43, sy + 511, sx + sw - 43, sy + 511);
  body += text(sx + 43, sy + 550, 'Точка 2', 18, { fill: C.ink, weight: 700 });
  body += pill(sx + 145, sy + 525, '10:00', { width: 75 });
  body += text(sx + 43, sy + 592, 'Адрес', 13, { fill: C.muted });
  body += paragraph(sx + 127, sy + 592, 'Объект, ул. Строителей, 48', sw - 190, 17, {
    fill: C.ink,
    weight: 600,
    lineHeight: 23,
  });
  body += text(sx + 43, sy + 646, 'Разгрузка', 16, { fill: C.ink, weight: 700 });
  body += text(sx + 155, sy + 646, 'ТС-241/1', 16, { fill: C.text });
  body += text(sx + 43, sy + 686, 'Встречает', 13, { fill: C.muted });
  body += text(sx + 142, sy + 686, 'Сидоров А.А. · +7 900 987-65-43', 17, { fill: C.blue, weight: 500 });
  body += text(sx + 43, sy + 736, 'На точке', 13, { fill: C.muted });
  body += paragraph(sx + 142, sy + 736, 'Позвонить за 20 минут до приезда', sw - 205, 16, {
    lineHeight: 22,
  });
  body += dot('1', sx + sw - 22, sy + 78);
  body += dot('2', sx + sw - 22, sy + 375);
  body += dot('3', sx + sw - 22, sy + 470, { fill: C.green });
  body += dot('4', sx + sw - 22, sy + 803, { fill: C.orange });

  body += step(665, 226, '1', 'Откройте «Задание»', 'Ссылка находится под выбранной датой.', 403, { height: 126 });
  body += step(665, 370, '2', 'Идите по точкам', 'На каждой: время, адрес и что нужно сделать.', 403, { height: 126 });
  body += step(665, 514, '3', 'Позвоните одним нажатием', 'Номер ответственного — активная ссылка.', 403, {
    fill: C.greenSoft,
    stroke: '#b7eb8f',
    dotFill: C.green,
    height: 126,
  });
  body += step(665, 658, '4', 'Вернитесь к вводу', 'Нажмите «Показания» вверху.', 403, {
    fill: C.orangeSoft,
    stroke: '#ffd591',
    dotFill: C.orange,
    height: 126,
  });
  body += note(
    665,
    820,
    403,
    191,
    'Изменять задание нельзя',
    'Если не совпадает машина, водитель, маршрут, адрес или время — свяжитесь с диспетчером. Исправления вносит он.',
    { fill: C.orangeSoft, stroke: '#ffd591', color: C.orange },
  );

  body += text(55, 1218, 'Что означают статусы показаний', 25, { fill: C.ink, weight: 700 });
  const statuses = [
    {
      x: 55,
      label: 'Черновик',
      color: C.orange,
      fill: C.orangeSoft,
      stroke: '#ffd591',
      body: 'Введено на телефоне, но ещё не передано.',
    },
    {
      x: 307,
      label: 'Передано',
      color: C.blueDark,
      fill: C.bluePale,
      stroke: '#bae0ff',
      body: 'Можно поправить, пока диспетчер не принял день.',
    },
    {
      x: 559,
      label: 'Принято',
      color: C.green,
      fill: C.greenSoft,
      stroke: '#b7eb8f',
      body: 'Правки теперь вносит только диспетчер.',
    },
    {
      x: 811,
      label: 'На повторном приёме',
      color: C.red,
      fill: C.redSoft,
      stroke: '#ffccc7',
      body: 'Диспетчер исправил принятый день и проверяет его снова.',
    },
  ];
  for (const status of statuses) {
    body += rect(status.x, 1255, 237, 181, { fill: status.fill, stroke: status.stroke, r: 13 });
    body += text(status.x + 18, 1291, status.label, 16, { fill: status.color, weight: 700 });
    body += paragraph(status.x + 18, 1328, status.body, 201, 15, { lineHeight: 22 });
  }
  body += footer();
  return document(body);
}

const pages = [page1(), page2(), page3(), page4(), page5()];

for (const [index, svg] of pages.entries()) {
  const stem = `driver-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Инструкция водителю и машинисту');
pdf.setSubject('Регистрация, задание и передача показаний техники целиком в конце смены');
pdf.setKeywords(['водитель', 'машинист', 'задание', 'показания', 'топливо', 'АВТО']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-10-28T20:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `driver-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
if (process.env.DRIVER_GUIDE_KEEP_WORK) console.log(WORK);
else rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
