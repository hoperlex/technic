/**
 * Памятка диспетчеру: смена машиниста внутри недели (после переключения чтения истории назначения).
 *
 * Факты и подписи сверены с интерфейсом на 17.09.2026:
 * - VehicleRequestsTab.tsx — пункт «Сменить машиниста» в «Действиях» и условия его видимости;
 * - VehicleMachinistModal.tsx — заголовок окна, названия кнопок, поле «Причина»;
 * - MachinistFields.tsx — поля «Машинист» и «Работает с» и их подсказки;
 * - MachinistChangePreview.tsx — формулировки последствий («Сгорит № …», «Выпишется лист за …»).
 *
 * Разрез недели описан ADR 0126, месячный — ADR 0142; включение отрезкового плана — ADR 0196.
 *
 * Страница рисуется в SVG, render-svg-to-png.py переводит её в PNG, pdf-lib собирает A4 — тем же
 * маршрутом, что и остальные иллюстрированные инструкции проекта: он не требует браузера и делает
 * результат воспроизводимым в репозитории.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const OUTPUT = resolve(process.argv[2] ?? 'docs/Памятка_смена_машиниста_в_середине_недели.pdf');
const WORK = mkdtempSync(join(tmpdir(), 'machinist-guide-'));
const W = 1123;
const H = 1588;
const TOTAL = 2;
const REVISION = '17 сентября 2026';

const C = {
  ink: '#172033',
  text: '#303744',
  muted: '#667085',
  faint: '#98a2b3',
  line: '#e4e9f0',
  surface: '#f6f8fb',
  blue: '#1677ff',
  blueDark: '#0958d9',
  blueSoft: '#e6f4ff',
  bluePale: '#f3f8ff',
  green: '#389e0d',
  greenSoft: '#f6ffed',
  greenLine: '#b7eb8f',
  orange: '#d46b08',
  orangeSoft: '#fff7e6',
  orangeLine: '#ffd591',
  gold: '#ad6800',
  goldSoft: '#fffbe6',
  red: '#cf1322',
  redSoft: '#fff1f0',
  redLine: '#ffccc7',
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
  const { lineHeight = Math.round(size * 1.4), ...textOptions } = options;
  return wrap(value, width, size, textOptions.weight)
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
    text(110, 92, titleValue, 33, { fill: C.ink, weight: 700 }),
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
    text(55, 1560, `Памятка диспетчеру • заказ спецтехники • актуально на ${REVISION}`, 14, {
      fill: C.faint,
    }) +
    text(1068, 1560, 'АВТО', 14, { fill: C.blue, weight: 700, anchor: 'end', letter: 1.2 })
  );
}

function dot(number, x, y, options = {}) {
  const { fill = C.blue, radius = 18 } = options;
  return (
    circle(x, y, radius, { fill, stroke: '#fff', sw: 4, shadow: true }) +
    text(x, y + 7, String(number), radius + 1, { fill: '#fff', weight: 700, anchor: 'middle' })
  );
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

/** Поле формы как его видит человек: подпись, рамка и значение либо подсказка. */
function field(x, y, width, label, value, options = {}) {
  const { placeholder = false, height = 46 } = options;
  return (
    text(x, y, label, 15, { fill: C.muted, weight: 600 }) +
    rect(x, y + 12, width, height, { fill: '#fff', stroke: '#d0d7e2', r: 8 }) +
    text(x + 14, y + 12 + height / 2 + 6, value, 17, {
      fill: placeholder ? C.faint : C.ink,
      weight: placeholder ? 400 : 600,
    })
  );
}

// ───────────────────────────────── страница 1 ─────────────────────────────────

/** Неделя с разрезом: слева прежний машинист, справа новый, снизу — два бланка. */
function weekSplit(x, y) {
  const days = ['пн 14', 'вт 15', 'ср 16', 'чт 17', 'пт 18', 'сб 19', 'вс 20'];
  const cell = 128;
  let out = '';
  days.forEach((day, index) => {
    const left = x + index * cell;
    const before = index < 2;
    out += rect(left, y, cell - 6, 62, {
      fill: before ? C.blueSoft : C.greenSoft,
      stroke: before ? '#91caff' : C.greenLine,
      r: 9,
    });
    out += text(left + (cell - 6) / 2, y + 38, day, 19, {
      fill: before ? C.blueDark : C.green,
      weight: 600,
      anchor: 'middle',
    });
  });
  // Сам разрез — по границе вторника и среды, то есть по дате «Работает с».
  const cut = x + 2 * cell - 3;
  out += line(cut, y - 26, cut, y + 150, { stroke: C.red, sw: 3, dash: '7 6' });
  out += pill(cut - 88, y - 60, 'Работает с 16-го', {
    fill: C.redSoft,
    color: C.red,
    stroke: C.redLine,
    size: 15,
  });

  out += rect(x, y + 86, 2 * cell - 6, 64, { fill: '#fff', stroke: '#91caff', r: 10 });
  out += text(x + 16, y + 112, 'ЭСМ-2 № 1041', 17, { fill: C.blueDark, weight: 700 });
  out += text(x + 16, y + 136, '14–15 сентября · Иванов', 15, { fill: C.muted });

  out += rect(x + 2 * cell, y + 86, 5 * cell - 6, 64, { fill: '#fff', stroke: C.greenLine, r: 10 });
  out += text(x + 2 * cell + 16, y + 112, 'ЭСМ-2 № 1042', 17, { fill: C.green, weight: 700 });
  out += text(x + 2 * cell + 16, y + 136, '16–20 сентября · Петров', 15, { fill: C.muted });
  return out;
}

function page1() {
  let body = pageHeader(1, 'Смена машиниста в середине недели', 'заказ спецтехники');

  body += rect(55, 148, 1013, 104, { fill: C.bluePale, stroke: '#bae0ff', r: 14 });
  body += paragraph(
    80,
    186,
    'Неделя больше не обязана быть одним документом. Назовите день, с которого работает новый человек, — портал сам разрежет неделю: прежний машинист останется в бланке по вчерашний день, новый получит свой лист с названного числа.',
    963,
    19,
    { lineHeight: 27 },
  );

  body += text(55, 310, 'Как это выглядит', 25, { fill: C.ink, weight: 700 });
  body += weekSplit(66, 400);

  body += text(55, 640, 'Порядок действий', 25, { fill: C.ink, weight: 700 });

  const steps = [
    {
      title: 'Откройте заказ и выберите «Сменить машиниста»',
      body: 'Вкладка «Заказ ТС» → строка заказа → «Действия» → «Сменить машиниста». Пункт стоит рядом со сменой техники: это решение о человеке, машина остаётся прежней.',
    },
    {
      title: 'Заполните «Машинист» и «Работает с»',
      body: 'Фамилию портал не подставляет сам — даже когда в справочнике один водитель: она уезжает в бланк строгой отчётности настоящей. Дата — первый день нового человека; прежний работает по предыдущий день включительно.',
    },
    {
      title: 'Прочитайте последствия',
      body: 'Портал перечислит, что именно произойдёт с бумагой: «Сгорит № 1041 за 14–20 сентября», «Выпишется лист за 14–15 сентября… машинист Иванов», «Выпишется лист за 16–20 сентября… машинист Петров».',
    },
    {
      title: 'Подтвердите',
      body: 'Кнопка называет шаг: сначала «Сменить машиниста», на экране последствий — «Подтвердить». Кнопка «Назад» вернёт окно заполненным, ничего не записав.',
    },
    {
      title: 'Распечатайте оба листа',
      body: 'После подтверждения в заказе два действующих бланка на эту неделю — каждый со своими днями и своей фамилией. Старый номер аннулирован и в печать не идёт.',
    },
  ];
  let y = 700;
  for (const [index, step] of steps.entries()) {
    body += dot(index + 1, 82, y + 6);
    body += text(124, y + 13, step.title, 20, { fill: C.ink, weight: 700 });
    body += paragraph(124, y + 44, step.body, 930, 17, { lineHeight: 24, fill: C.text });
    const lines = wrap(step.body, 930, 17).length;
    y += 44 + lines * 24 + 22;
  }

  // Блок прижат к низу полосы набора, а не к концу шагов: так он не наезжает на колонтитул, когда
  // шаг переносится на лишнюю строку.
  const limitsY = 1356;
  body += text(55, limitsY - 26, 'Где смена машиниста недоступна', 25, {
    fill: C.ink,
    weight: 700,
  });
  const limits = [
    {
      label: 'Арендная машина',
      body: 'Бланк ведёт арендодатель — истории человека портал по ней не ведёт вовсе.',
    },
    {
      label: 'Линейная техника',
      body: 'Машиниста называют при выписке каждого листа, и разрезать там нечего.',
    },
    {
      label: 'Заказ вне работы',
      body: 'Пункт доступен по заказу «В работе» или «Выполнен» с назначенной техникой.',
    },
  ];
  limits.forEach((limit, index) => {
    const x = 55 + index * 344;
    body += rect(x, limitsY, 325, 142, { fill: C.surface, stroke: C.line, r: 12 });
    body += text(x + 20, limitsY + 36, limit.label, 17, { fill: C.ink, weight: 700 });
    body += paragraph(x + 20, limitsY + 68, limit.body, 285, 15, { lineHeight: 22, fill: C.muted });
  });

  body += footer();
  return document(body);
}

// ───────────────────────────────── страница 2 ─────────────────────────────────

/** Макет окна: подбор слева, последствия справа. */
function modalMockups(x, y) {
  let out = '';
  // Экран подбора.
  out += rect(x, y, 470, 330, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  out += rect(x, y, 470, 52, { fill: C.surface, r: 14 });
  out += rect(x, y + 38, 470, 14, { fill: C.surface });
  out += text(x + 20, y + 34, 'Сменить машиниста: заявка ТС-1274', 17, {
    fill: C.ink,
    weight: 700,
  });
  out += line(x, y + 52, x + 470, y + 52);
  out += field(x + 20, y + 84, 430, 'Машинист', 'Кто сядет за технику', { placeholder: true });
  out += field(x + 20, y + 170, 430, 'Работает с', '16.09.2026');
  out += paragraph(
    x + 20,
    y + 258,
    'Прежний машинист работает по этот день включительно.',
    430,
    14,
    { lineHeight: 20, fill: C.muted },
  );
  out += rect(x + 268, y + 282, 182, 36, { fill: C.blue, r: 8 });
  out += text(x + 359, y + 306, 'Сменить машиниста', 15, {
    fill: '#fff',
    weight: 600,
    anchor: 'middle',
  });

  // Стрелка между экранами.
  out += path(`M ${x + 492} ${y + 165} l 38 0 m -12 -11 l 12 11 l -12 11`, {
    stroke: C.faint,
    sw: 3,
  });

  // Экран последствий.
  out += rect(x + 548, y, 470, 330, { fill: '#fff', stroke: C.line, r: 14, shadow: true });
  out += rect(x + 548, y, 470, 52, { fill: C.surface, r: 14 });
  out += rect(x + 548, y + 38, 470, 14, { fill: C.surface });
  out += text(x + 568, y + 34, 'Последствия', 17, { fill: C.ink, weight: 700 });
  out += line(x + 548, y + 52, x + 1018, y + 52);
  out += text(x + 568, y + 86, 'Путевые листы ЭСМ-2', 16, { fill: C.ink, weight: 700 });
  const lines = [
    { mark: '–', color: C.red, value: 'Сгорит № 1041 за 14.09 — 20.09' },
    { mark: '+', color: C.green, value: 'Выпишется лист за 14.09 — 15.09: Иванов' },
    { mark: '+', color: C.green, value: 'Выпишется лист за 16.09 — 20.09: Петров' },
  ];
  lines.forEach((item, index) => {
    const ly = y + 122 + index * 38;
    out += circle(x + 578, ly - 5, 11, { fill: item.color === C.red ? C.redSoft : C.greenSoft });
    out += text(x + 578, ly + 1, item.mark, 17, {
      fill: item.color,
      weight: 700,
      anchor: 'middle',
    });
    out += text(x + 600, ly + 1, item.value, 15, { fill: C.text });
  });
  out += rect(x + 568, y + 240, 430, 40, { fill: C.goldSoft, stroke: '#ffe58f', r: 8 });
  out += text(x + 584, y + 265, 'Причина — если задеты уже отработанные дни', 14, {
    fill: C.gold,
  });
  out += rect(x + 856, y + 292, 142, 32, { fill: C.blue, r: 8 });
  out += text(x + 927, y + 314, 'Подтвердить', 14, {
    fill: '#fff',
    weight: 600,
    anchor: 'middle',
  });
  return out;
}

function page2() {
  let body = pageHeader(2, 'Что портал спросит и когда откажет', 'заказ спецтехники');

  body += text(55, 172, 'Два экрана окна', 25, { fill: C.ink, weight: 700 });
  body += modalMockups(55, 210);

  body += text(55, 610, 'Портал может спросить ещё', 25, { fill: C.ink, weight: 700 });
  const asks = [
    {
      label: 'Кто работал 3.08 — 9.08',
      color: C.blue,
      fill: C.blueSoft,
      stroke: '#91caff',
      body: 'На каких-то днях срока человек не назван вовсе. Пока их не закроют, последствий не будет: портал не выпишет лист за дни, за которыми никого нет. Имя ставится на начало отрезка.',
    },
    {
      label: 'Причина',
      color: C.gold,
      fill: C.goldSoft,
      stroke: '#ffe58f',
      body: 'Появляется, когда смена задевает отработанные дни или правит уже принятое решение: команда пойдёт записью в журнал коррекций. Нужно право «Коррекция путевых листов».',
    },
    {
      label: 'Отработанные недели',
      color: C.orange,
      fill: C.orangeSoft,
      stroke: C.orangeLine,
      body: 'Перечень листов, чья неделя уже закрыта. Сами они не переоформились бы — портал называет их отдельно, чтобы было видно, откуда в списке сгорающих взялись прошлые недели.',
    },
  ];
  let y = 660;
  for (const ask of asks) {
    // Ярлык — своей колонкой: «Кто работал 3.08 — 9.08» длиннее любого поля формы, и поставленный
    // в одну строку с текстом он на этот текст наезжает.
    const labelLines = wrap(ask.label, 230, 17, 700);
    const bodyLines = wrap(ask.body, 720, 17).length;
    const height = Math.max(96, 44 + Math.max(bodyLines, labelLines.length) * 24);
    body += rect(55, y, 1013, height, { fill: ask.fill, stroke: ask.stroke, r: 12 });
    body += paragraph(78, y + 36, ask.label, 230, 17, {
      lineHeight: 24,
      fill: ask.color,
      weight: 700,
    });
    body += paragraph(330, y + 36, ask.body, 715, 17, { lineHeight: 24, fill: C.text });
    y += height + 16;
  }

  body += text(55, y + 76, 'Ещё три вещи, которые стоит знать', 25, { fill: C.ink, weight: 700 });
  const notes = [
    {
      label: 'Состав по датам',
      body: 'Окно всё время показывает, кто и на чём работал по дням срока. Там же видно, есть ли дни без человека.',
    },
    {
      label: 'Дата после конца срока',
      body: 'Завести можно: решение подождёт продления. Логически оно есть, бумаги по нему пока нет.',
    },
    {
      label: 'Техника — отдельно',
      body: 'Машину меняет «Сменить технику»: там свои ставки, аренда и рейс. Это окно решает только про человека.',
    },
  ];
  notes.forEach((note, index) => {
    const x = 55 + index * 344;
    body += rect(x, y + 106, 325, 168, { fill: C.bluePale, stroke: '#bae0ff', r: 12 });
    body += text(x + 20, y + 142, note.label, 17, { fill: C.blueDark, weight: 700 });
    body += paragraph(x + 20, y + 174, note.body, 285, 15, { lineHeight: 22, fill: C.text });
  });

  body += rect(55, y + 306, 1013, 124, { fill: C.greenSoft, stroke: C.greenLine, r: 12 });
  body += text(78, y + 344, 'Если что-то пошло не так', 17, { fill: C.green, weight: 700 });
  body += paragraph(
    78,
    y + 376,
    'Портал отвечает словами, а не кодом: в тексте отказа названо и что мешает, и куда идти. Ответ «Чинить нечего» либо «Последствия пересчитаны» значит, что окно устарело, — закройте карточку заказа и откройте заново. Дни без человека чинит соседний пункт «Починка истории».',
    963,
    16,
    { lineHeight: 23, fill: C.text },
  );

  body += footer();
  return document(body);
}

const pages = [page1(), page2()];

for (const [index, svg] of pages.entries()) {
  const stem = `machinist-guide-${String(index + 1).padStart(2, '0')}`;
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
pdf.setTitle('Смена машиниста в середине недели');
pdf.setSubject('Памятка диспетчеру: разрез недели на два путевых листа ЭСМ-2');
pdf.setKeywords(['машинист', 'ЭСМ-2', 'путевой лист', 'заказ ТС', 'АВТО']);
pdf.setAuthor('АВТО');
pdf.setCreator('SVG guide generator + librsvg + pdf-lib');
pdf.setProducer('pdf-lib');
const fixedDate = new Date('2026-09-17T18:00:00+05:00');
pdf.setCreationDate(fixedDate);
pdf.setModificationDate(fixedDate);

for (let index = 0; index < pages.length; index += 1) {
  const stem = `machinist-guide-${String(index + 1).padStart(2, '0')}`;
  const png = await pdf.embedPng(readFileSync(join(WORK, `${stem}.png`)));
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
rmSync(WORK, { recursive: true, force: true });
console.log(OUTPUT);
