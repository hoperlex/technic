import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Единый текстовый исходник четырёх руководств по модулю «Орг.техника».
 *
 * PDF намеренно собирается из PPTX: текст остаётся доступным для поиска и копирования, а каждое
 * руководство можно поправить в PowerPoint без перерисовки растровых страниц. Содержание сверено
 * с контрактами, маршрутом заявок и рабочими планами 07.09.2026. Возможности незавершённых волн
 * помечены как поэтапно вводимые и всегда сопровождаются действующим запасным маршрутом.
 */

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const PptxGenJS = require('pptxgenjs');
const LABELS = JSON.parse(
  readFileSync(new URL('./labels/service-request-labels.json', import.meta.url), 'utf8'),
);

const OUT_DIR = resolve(process.argv[2] ?? 'docs');
const REVIEWED_ON = '07.09.2026';
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
  addText(slide, `${guide.footer} · сверено ${REVIEWED_ON} · рабочая редакция`, {
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

function renderPage(pptx, guide, page, total) {
  const slide = pptx.addSlide();
  pageFrame(pptx, slide, guide, page, total);
  let y = BODY_TOP;
  for (const block of page.blocks) {
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
            ['Номенклатура', 'Для заявки на расходники — что запрошено и что выдано', 'Читать'],
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
              body: 'Принять заявку в работу, вести объём работ, подшивать файлы и закрывать работы — только если вы назначены поимённо.',
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
            `Для «${kind('repair')}» заполните объём работ; для «${kind('consumable')}» — состав номенклатуры и фактически выданное количество.`,
            'Если нужно ждать деталь или доступ, отложите заявку с причиной. Возобновление вернёт её туда, откуда остановили.',
            'По завершении заполните фактический результат, гарантийные сроки и закройте работы.',
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
        '«Смета» переименована в «Объём работ». Предъявление и согласование больше не являются отдельным статусом.',
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
              'Приоритет, заданный при создании или службой',
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
            `Для «${kind('repair')}» ведёт объём работ; для «${kind('consumable')}» — номенклатуру и факт выдачи.`,
            'Уточнения пишет в обсуждение с адресатом; документы подшивает правильным видом.',
            'Закрывает фактический результат и гарантии, переводя заявку в «Решена».',
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
        'Подпись относится к конкретной ревизии. Правка после предъявления требует явного возврата.',
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

const built = [];
for (const guide of [requester, itGuide, fullGuide, serviceGuide]) {
  built.push(...(await buildGuide(guide)));
}
process.stdout.write(`${built.map((file) => basename(file)).join('\n')}\n`);
