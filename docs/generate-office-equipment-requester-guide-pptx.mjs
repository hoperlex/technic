import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { argv, stdout } from 'node:process';

/**
 * Памятка заявителю по модулю «Орг.техника» — каркас PPTX (этап Э3 плана
 * `docs/office-equipment-requester-guide-update-plan.md`, субзадачи С9 и С11).
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ ПРЕЖНЕГО ГЕНЕРАТОРА. Тот рисовал страницы строками SVG и склеивал PNG в PDF:
 * текст в готовом документе не выделялся, не искался и не правился — опечатку нельзя было
 * поправить, не запустив сборку, а слайд нельзя было вынести в чужую презентацию (находка Н9).
 * Здесь **исходник — PPTX**, собранный текстовыми рамками и автофигурами, а PDF получается из него
 * LibreOffice. Отдельного пути «сразу в PDF» нет намеренно (Р1): два пути дали бы два документа с
 * одинаковым именем.
 *
 * ШРИФТ — ARIAL, И ЭТО НЕ ВКУСОВЩИНА (Р2б). Заказчик открывает PPTX в PowerPoint, где Arial есть
 * всегда; в контуре сборки его нет, но стоит метрически совместимый Liberation Sans, и LibreOffice
 * подставляет его без смещения строк. Прежний DejaVu Sans в Windows отсутствует вовсе — открытый
 * файл «поехал» бы на первом слайде.
 *
 * ПОДПИСИ НЕ ЖИВУТ В ЭТОМ ФАЙЛЕ (Р3, С7). Названия видов, статусов, сторон ожидания и документов
 * читаются из `docs/labels/service-request-labels.json`, который собирает
 * `pnpm --filter @technic/api docs:labels` из контрактов и сверяет страж
 * `apps/api/test/docs-service-labels.test.ts`. Именно вторая копия подписей и развела прежнюю
 * памятку с порталом: статусы `assigned` и `estimate_review` переименовали, документ не заметил.
 *
 * ЧТО ЗДЕСЬ УЖЕ ЕСТЬ. Разметка A4, мастер-стили (шапка, шаги, врезка, таблица, лента статусов,
 * место под кадр, колонтитул) и ОДНА пробная страница на них. Содержание страниц переносится
 * этапами Э4–Э6: план требует проверить каркас на одной странице раньше, чем в него уедет текст, —
 * иначе вёрстка правится сразу в пяти местах.
 */

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const PptxGenJS = require('pptxgenjs');

/**
 * Путь обязателен, пока это каркас. Целевое имя — `docs/Памятка_Оргтехника_заявителю.pptx`, и
 * запуск без аргумента был бы удобнее, но рядом с ним лежит собранный прежним генератором PDF того
 * же имени: `soffice --outdir docs` затёр бы его каркасной пробой, а выдать пробу за памятку —
 * ровно та ошибка, из-за которой документы расходятся с интерфейсом молча. Дефолт появится вместе
 * с содержанием (этапы Э4–Э6), одновременно со снятием прежнего генератора (Э9).
 */
if (!argv[2]) {
  throw new Error(
    'укажите путь для сборки: пока это каркас (Э3), целевая памятка собирается после Э4–Э6',
  );
}
const OUT_PPTX = resolve(argv[2]);
const LABELS = JSON.parse(
  readFileSync(new URL('./labels/service-request-labels.json', import.meta.url), 'utf8'),
);

/** Дата сверки, а не дата сборки (Р9, С11): документ отвечает, какому интерфейсу он соответствует. */
export const REVIEWED_ON = '04.09.2026';
const RELEASE = 78;
const TOTAL_PAGES = 5;

// ── Мастер-стили (Р2г) ──

const FONT = 'Arial';
const W = 8.27;
const H = 11.69;
const M = 0.55;
const CW = W - 2 * M;

const C = {
  ink: '172033',
  text: '2F3440',
  muted: '667085',
  faint: '98A2B3',
  line: 'E7EAF0',
  blue: '1677FF',
  bluePale: 'F0F7FF',
  blueEdge: 'BAE0FF',
  green: '389E0D',
  greenPale: 'F6FFED',
  greenEdge: 'B7EB8F',
  orange: 'D46B08',
  orangePale: 'FFF7E6',
  orangeEdge: 'FFD591',
  grayPale: 'FAFAFA',
  white: 'FFFFFF',
};

const TONES = {
  blue: { color: C.blue, fill: C.bluePale, edge: C.blueEdge },
  green: { color: C.green, fill: C.greenPale, edge: C.greenEdge },
  orange: { color: C.orange, fill: C.orangePale, edge: C.orangeEdge },
};

const label = (list, value) => list.find((item) => item.value === value)?.label ?? value;
const liveStatuses = () => LABELS.statuses.filter((status) => status.live);

/** Шапка страницы: кикер, заголовок, подзаголовок, номер. Возвращает Y, с которого идёт контент. */
function page(pptx, { kicker, title, subtitle, number }) {
  const slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addText(kicker.toUpperCase(), {
    x: M,
    y: 0.42,
    w: CW - 1,
    h: 0.2,
    fontFace: FONT,
    fontSize: 8.5,
    bold: true,
    color: C.blue,
    charSpacing: 1.2,
  });
  slide.addText(title, {
    x: M,
    y: 0.6,
    w: CW - 1,
    h: 0.42,
    fontFace: FONT,
    fontSize: 20,
    bold: true,
    color: C.ink,
  });
  slide.addText(`${String(number).padStart(2, '0')} / ${String(TOTAL_PAGES).padStart(2, '0')}`, {
    x: W - M - 1,
    y: 0.45,
    w: 1,
    h: 0.2,
    align: 'right',
    fontFace: FONT,
    fontSize: 9,
    bold: true,
    color: C.faint,
  });
  slide.addShape(pptx.ShapeType.line, {
    x: M,
    y: 1.06,
    w: CW,
    h: 0,
    line: { color: C.line, width: 0.75 },
  });
  let y = 1.2;
  if (subtitle) {
    slide.addText(subtitle, {
      x: M,
      y,
      w: CW,
      h: 0.42,
      fontFace: FONT,
      fontSize: 10,
      color: C.muted,
      lineSpacingMultiple: 1.15,
      valign: 'top',
    });
    y += 0.54;
  }
  footer(pptx, slide);
  return { slide, y };
}

/** Колонтитул: редакция и выпуск (С11) — на каждой странице, иначе документ нельзя датировать. */
function footer(pptx, slide) {
  slide.addShape(pptx.ShapeType.line, {
    x: M,
    y: H - 0.62,
    w: CW,
    h: 0,
    line: { color: C.line, width: 0.75 },
  });
  slide.addText(
    `Памятка заявителю · Орг.техника · редакция ${REVIEWED_ON} · портал, выпуск ${RELEASE}`,
    {
      x: M,
      y: H - 0.55,
      w: CW - 0.8,
      h: 0.22,
      fontFace: FONT,
      fontSize: 8,
      color: C.faint,
    },
  );
  slide.addText('АВТО', {
    x: W - M - 0.8,
    y: H - 0.55,
    w: 0.8,
    h: 0.22,
    align: 'right',
    fontFace: FONT,
    fontSize: 8,
    bold: true,
    color: C.blue,
  });
}

/** Заголовок раздела внутри страницы. */
function heading(slide, y, text) {
  slide.addText(text, {
    x: M,
    y,
    w: CW,
    h: 0.26,
    fontFace: FONT,
    fontSize: 13,
    bold: true,
    color: C.ink,
  });
  return y + 0.34;
}

/**
 * Нумерованные шаги — та форма, которую заказчик просил сохранить (Р7).
 *
 * Высота пункта считается по длине текста, а не берётся постоянной: PowerPoint переносит строки
 * сам, но соседний пункт об этом не знает — и двухстрочный шаг накрывается следующим номером.
 * Оценка грубая (символов в строке при Arial 10.5), но ошибается в безопасную сторону: лишний
 * зазор виден, наложение — нет.
 */
function steps(slide, y, items, { x = M, w = CW, size = 10.5 } = {}) {
  const textWidth = w - 0.32;
  const perLine = Math.floor((textWidth * 96) / (size * 0.75));
  const lineHeight = size * 0.019;
  let cursor = y;
  items.forEach((item, index) => {
    const lines = Math.max(1, Math.ceil(item.length / perLine));
    const height = Math.max(0.3, lines * lineHeight + 0.1);
    slide.addShape('ellipse', {
      x,
      y: cursor + 0.02,
      w: 0.22,
      h: 0.22,
      fill: { color: C.blue },
      line: { color: C.blue, width: 0 },
    });
    slide.addText(String(index + 1), {
      x,
      y: cursor + 0.02,
      w: 0.22,
      h: 0.22,
      align: 'center',
      valign: 'middle',
      fontFace: FONT,
      fontSize: 9,
      bold: true,
      color: C.white,
    });
    slide.addText(item, {
      x: x + 0.32,
      y: cursor,
      w: textWidth,
      h: height,
      fontFace: FONT,
      fontSize: size,
      color: C.text,
      valign: 'top',
      lineSpacingMultiple: 1.05,
    });
    cursor += height;
  });
  return cursor + 0.06;
}

/** Врезка «если»: не больше четырёх строк текста (Р7). */
function callout(slide, { x = M, y, w = CW, h = 0.85, title, body, tone = 'blue' }) {
  const t = TONES[tone];
  slide.addShape('roundRect', {
    x,
    y,
    w,
    h,
    rectRadius: 0.06,
    fill: { color: t.fill },
    line: { color: t.edge, width: 1 },
  });
  slide.addText(title, {
    x: x + 0.18,
    y: y + 0.1,
    w: w - 0.36,
    h: 0.22,
    fontFace: FONT,
    fontSize: 10.5,
    bold: true,
    color: t.color,
  });
  slide.addText(body, {
    x: x + 0.18,
    y: y + 0.32,
    w: w - 0.36,
    h: h - 0.42,
    fontFace: FONT,
    fontSize: 9.5,
    color: C.text,
    lineSpacingMultiple: 1.12,
    valign: 'top',
  });
  return y + h + 0.16;
}

/** Таблица с шапкой: подписи столбцов и строки, ширины — в дюймах. */
function table(slide, { y, head, rows, widths }) {
  const header = head.map((text) => ({
    text,
    options: { bold: true, color: C.muted, fill: { color: C.grayPale }, fontSize: 9 },
  }));
  const body = rows.map((row) =>
    row.map((text) => ({ text, options: { color: C.text, fontSize: 9.5 } })),
  );
  slide.addTable([header, ...body], {
    x: M,
    y,
    w: CW,
    colW: widths,
    border: { type: 'solid', color: C.line, pt: 0.75 },
    fontFace: FONT,
    valign: 'top',
    margin: 0.06,
    autoPage: false,
  });
}

/** Лента живых статусов — автофигурами, а не картинкой (Р2в). */
function statusFlow(slide, y) {
  const statuses = liveStatuses().filter(
    (status) => status.value !== 'on_hold' && status.value !== 'cancelled',
  );
  const gap = 0.22;
  const w = (CW - gap * (statuses.length - 1)) / statuses.length;
  statuses.forEach((status, index) => {
    const x = M + index * (w + gap);
    slide.addShape('roundRect', {
      x,
      y,
      w,
      h: 0.42,
      rectRadius: 0.2,
      fill: { color: C.bluePale },
      line: { color: C.blueEdge, width: 1 },
    });
    slide.addText(status.label, {
      x,
      y,
      w,
      h: 0.42,
      align: 'center',
      valign: 'middle',
      fontFace: FONT,
      fontSize: 10,
      bold: true,
      color: C.blue,
    });
    if (index < statuses.length - 1) {
      slide.addShape('rightArrow', {
        x: x + w + 0.04,
        y: y + 0.15,
        w: gap - 0.08,
        h: 0.12,
        fill: { color: C.faint },
        line: { width: 0 },
      });
    }
  });
  return y + 0.58;
}

/**
 * Место под кадр. Пока кадров нет (их снимает Э2), рисуется рамка с именем файла: пустое место в
 * каркасе честнее нарисованной имитации интерфейса, из-за которой памятка и разошлась с формой.
 */
function figure(slide, { x = M, w = CW, y, h = 1.6, file, caption }) {
  slide.addShape('roundRect', {
    x,
    y,
    w,
    h,
    rectRadius: 0.05,
    fill: { color: C.grayPale },
    line: { color: C.line, width: 1, dashType: 'dash' },
  });
  slide.addText(`кадр ${file}`, {
    x,
    y: y + h / 2 - 0.15,
    w,
    h: 0.3,
    align: 'center',
    fontFace: FONT,
    fontSize: 9.5,
    color: C.faint,
  });
  slide.addText(caption, {
    x,
    y: y + h + 0.04,
    w,
    h: 0.2,
    fontFace: FONT,
    fontSize: 8.5,
    italic: true,
    color: C.muted,
  });
  return y + h + 0.32;
}

// ── Страница 2: категории заявок (этап Э5, субзадачи С4 и С5) ──

/**
 * ПОЧЕМУ КАТЕГОРИЙ ДВЕ И ПОЧЕМУ ПЕРЕМЕЩЕНИЕ СРЕДИ ОБСЛУЖИВАНИЯ (Р5). Вид заявки в контрактах ровно
 * два, и «перемещение» — не третий: справочник правит оператор (`POST /:id/move` под
 * `officeEquipment.write`), а заявитель сообщает факт. Отдельная ветка процесса потребовала бы
 * своего цикла, своих прав и своей истории ради заявки, которая ничем от обслуживания не
 * отличается.
 *
 * ФОРМУЛИРОВКИ ИНТЕРФЕЙСА ЦИТИРУЮТСЯ, А НЕ ПЕРЕСКАЗЫВАЮТСЯ. «Обращение по гарантии», «Обычная
 * заявка», «Не нашли технику?», «Написать в техподдержку» и текст отказа сверены с деревом
 * 03.09.2026: человек ищет на экране те же слова, что прочитал в памятке. Названия категорий берутся
 * из словаря (Р3) и здесь не написаны.
 */
function categoriesPage(pptx) {
  const { slide, y } = page(pptx, {
    number: 2,
    kicker: 'Категории заявок',
    title: 'Какую категорию выбрать',
    subtitle:
      'Категория выбирается в форме переключателем «Чем помочь» и после отправки не меняется. Категорий две; третьей нет — перемещение, настройка и проверка перед списанием подаются как обслуживание.',
  });

  let cursor = heading(slide, y, 'Две категории');
  table(slide, {
    y: cursor,
    head: ['Категория в форме', 'Когда выбирать', 'Примеры'],
    widths: [1.5, 2.2, CW - 3.7],
    rows: [
      [
        label(LABELS.kinds, 'repair'),
        'Аппарат работает не так, как нужно, или с ним нужно что-то сделать',
        'не печатает, мнёт бумагу, полосы на копиях, не сканирует; подключить к сети или к новому компьютеру; перенести в другой кабинет или на другую площадку; проверить перед списанием',
      ],
      [
        label(LABELS.kinds, 'consumable'),
        'Аппарат исправен, кончился картридж или тонер',
        'закончился чёрный тонер, печатать нечем; нужен картридж на замену; запас на площадку',
      ],
    ],
  });
  cursor += 1.56;

  cursor = heading(slide, cursor, 'Перемещение аппарата');
  cursor = steps(slide, cursor, [
    `Выберите «${label(LABELS.kinds, 'repair')}»: отдельной категории для перемещения нет.`,
    'Укажите аппарат и напишите в описании, куда его перенести — площадку, кабинет, отдел.',
    'Если аппарат уже стоит не там, где записано, отметьте это в форме.',
  ]);
  cursor = callout(slide, {
    y: cursor,
    h: 0.72,
    title: 'Новое место в справочнике проставляет служба',
    body: 'Заявка сообщает факт: где аппарат стоит и куда его нужно перенести. Карточку аппарата правит ответственный за оргтехнику — после того, как перемещение выполнено.',
    tone: 'orange',
  });

  cursor = heading(slide, cursor, 'Три случая, о которых спрашивают чаще всего');
  cursor = callout(slide, {
    y: cursor,
    h: 1.02,
    title: 'Ремонт по гарантии',
    body: 'В форме есть поле «Обращение по гарантии»; по умолчанию в нём «Обычная заявка». Выберите «Гарантия на технику», если аппарат ещё на гарантии поставщика. «Гарантия на прошлый ремонт» выбирается в реестре гарантий. Источник читает исполнитель: по нему решают, чинить по гарантии или за деньги.',
    tone: 'blue',
  });
  cursor = callout(slide, {
    y: cursor,
    h: 1.06,
    title: 'Аппарата нет в списке',
    body: 'Нажмите «Не нашли технику?» под полем выбора и заполните окно «Сообщить об аппарате»: что за аппарат, модель с шильдика, серийный или инвентарный номер, где стоит. Карточка уйдёт вместе с заявкой и попадёт на проверку — в списке заявка будет помечена «Аппарат на проверке». Приложите фото шильдика: по нему проверяющий сверяет модель.',
    tone: 'green',
  });
  cursor = callout(slide, {
    y: cursor,
    h: 0.95,
    title: 'По этой технике уже есть заявка',
    body: 'Вторую незакрытую заявку на один аппарат портал не заводит и называет номер первой: «По этой технике уже есть незакрытая заявка СО-142 (обслуживание) — откройте её». Откройте её и допишите нужное в обсуждении.',
    tone: 'orange',
  });

  const half = (CW - 0.2) / 2;
  const figureHeight = H - cursor - 1.05;
  figure(slide, {
    y: cursor,
    h: figureHeight,
    w: half,
    file: 'S04',
    caption: 'Форма с категорией «Расходники».',
  });
  figure(slide, {
    x: M + half + 0.2,
    y: cursor,
    h: figureHeight,
    w: half,
    file: 'S05',
    caption: 'Поле «Обращение по гарантии».',
  });
}

// ── Страница 1: как завести заявку (этап Э4, субзадачи С6, С8) ──

/**
 * СРОЧНОСТЬ ЗДЕСЬ НЕ ОПИСАНА ГАЛОЧКОЙ, И ЭТО ЦЕЛЕВОЕ ПОВЕДЕНИЕ (Р8 ред. 2, Р10). Матрица профилей
 * (`office-equipment-access-profiles-plan.md` §5.1) отдаёт `serviceRequests.urgency` оператору:
 * заявитель срочность не ставит и не снимает. Сегодня чекбокс в форме ещё стоит — памятка
 * описывает то, чем экран станет, а не то, чем он был; проверка этого места — в Э0-повторе.
 */
function requestPage(pptx) {
  const { slide, y } = page(pptx, {
    number: 1,
    kicker: 'Заявка на обслуживание',
    title: 'Как завести заявку',
    subtitle:
      'Одно окно и восемь полей. Всё, что вы напишете, читает тот, кто приедет чинить: чем точнее описание и телефон, тем меньше уточняющих звонков.',
  });

  let cursor = heading(slide, y, 'Где кнопка');
  slide.addText(
    'Раздел «Орг.техника» → вкладка «Заявки» → кнопка «Создать заявку» справа над списком.',
    { x: M, y: cursor, w: CW, h: 0.24, fontFace: FONT, fontSize: 10.5, color: C.text },
  );
  cursor += 0.38;

  cursor = heading(slide, cursor, 'Что заполнить');
  cursor = steps(slide, cursor, [
    `«Чем помочь» — категория заявки: «${label(LABELS.kinds, 'repair')}» или «${label(
      LABELS.kinds,
      'consumable',
    )}». Как выбрать — страница 2.`,
    '«Какой аппарат» — поиск по модели, инвентарному или серийному номеру. Под полем сразу видно, что уйдёт в заявку: номера, место, гарантия.',
    '«Описание» — что происходит с аппаратом. Обязательно, и это главное поле заявки.',
    '«Для кого заявка» — площадка или отдел, для которого работает аппарат. Портал обычно подставляет его сам.',
    '«Кто обращается» и «Телефон для связи» — берутся из вашей учётки. Оставьте номер, по которому вас найдут.',
    '«Откуда обращаетесь» — появляется, если отделов у вас несколько.',
    '«Что ещё важно знать» — необязательное поле для деталей, которым не место в описании.',
    '«Прикрепить фото и документы» — только при заведении. Дальше файлы живут на вкладке «Документы».',
  ]);

  cursor = callout(slide, {
    y: cursor,
    h: 0.72,
    title: 'Без чего заявка не отправится',
    body: 'Обязательны пять полей: аппарат, описание, «Для кого заявка», имя и телефон. Незаполненное портал подсветит при отправке.',
    tone: 'blue',
  });

  cursor = callout(slide, {
    y: cursor,
    h: 0.92,
    title: 'Срочность назначает служба',
    body: 'Сами вы заявку срочной не помечаете. Если из-за поломки встала работа — напишите об этом в описании: «единственный принтер на площадке, встала выдача пропусков». Очередь разбирает оператор, и такие заявки он поднимает выше.',
    tone: 'orange',
  });

  const half = (CW - 0.2) / 2;
  const h = H - cursor - 1.05;
  figure(slide, {
    y: cursor,
    h,
    w: half,
    file: 'S02',
    caption: 'Верх формы: категория и аппарат.',
  });
  figure(slide, {
    x: M + half + 0.2,
    y: cursor,
    h,
    w: half,
    file: 'S03',
    caption: 'Низ формы: описание, заказчик, контакт.',
  });
}

// ── Страница 3: ход заявки (этап Э4, субзадача С12) ──

/**
 * АВТОЗАКРЫТИЯ НЕТ, И ЭТО ПРОВЕРЕНО ПО КОДУ (С12). Прежняя памятка обещала: «если через сутки после
 * „Решена“ никто не возразил, портал закрывает заявку сам». Ни планировщика, ни перехода
 * `done → accepted` по таймеру в сервере нет — приёмку делает оператор
 * (`SERVICE_OPERATOR_TRANSITIONS`). Обещание убрано, а не переписано мягче: документ, обещающий
 * несуществующее, хуже документа, который молчит.
 */
function flowPage(pptx) {
  const { slide, y } = page(pptx, {
    number: 3,
    kicker: 'Ход заявки',
    title: 'Что происходит дальше',
    subtitle:
      'Заявку ведёт служба: распределяет, чинит и принимает работу. От вас после отправки чаще всего не нужно ничего — кроме ответа на звонок.',
  });

  let cursor = heading(slide, y, 'Обычный путь заявки');
  cursor = statusFlow(slide, cursor);
  slide.addText(
    'Рядом со статусом в списке стоит подпись, кого заявка ждёт: «Ждёт оператора», «Ждёт исполнителя», «Ждёт согласования». Пока там не написано про вас — от вас ничего не требуется.',
    { x: M, y: cursor, w: CW, h: 0.4, fontFace: FONT, fontSize: 10, color: C.muted, valign: 'top' },
  );
  cursor += 0.46;

  cursor = heading(slide, cursor, 'Что означает каждое состояние');
  table(slide, {
    y: cursor,
    head: ['Статус', 'Что произошло', 'Что нужно от вас'],
    widths: [1.15, 3.0, CW - 4.15],
    rows: [
      [
        label(LABELS.statuses, 'new'),
        'Заявка зарегистрирована и ждёт, когда её распределят',
        'Действий не требуется. Пока исполнителя нет, заявку можно поправить или удалить',
      ],
      [
        label(LABELS.statuses, 'in_work'),
        'За заявку взялся исполнитель: свой системный администратор или сервисная компания',
        'Ответить на звонок и показать аппарат; иногда — обеспечить доступ в кабинет',
      ],
      [
        label(LABELS.statuses, 'on_hold'),
        'Движение остановлено с причиной — например, ждут поставку картриджа',
        'Действий не требуется: вернуть заявку в работу может только служба',
      ],
      [
        label(LABELS.statuses, 'done'),
        'Работы закрыты, заявка ждёт приёмки оператором',
        'Проверить, что всё работает. Если нет — сказать до приёмки',
      ],
      [
        label(LABELS.statuses, 'accepted'),
        'Оператор принял работу, заявка закончена',
        'Действий не требуется. Сломалось снова — заводите новую заявку',
      ],
      [
        label(LABELS.statuses, 'cancelled'),
        'Заявку сняли с причиной — например, аппарат рекомендован под замену',
        'Действий не требуется. Причина видна в заявке и в её истории',
      ],
    ],
  });
  cursor += 3.05;

  cursor = callout(slide, {
    y: cursor,
    h: 0.7,
    title: 'Заявка не закрывается сама',
    body: `Из состояния «${label(LABELS.statuses, 'done')}» в «${label(
      LABELS.statuses,
      'accepted',
    )}» её переводит оператор. Пока этого не произошло, ваши замечания по работе ещё можно учесть — напишите их в обсуждении заявки.`,
    tone: 'blue',
  });

  cursor = callout(slide, {
    y: cursor,
    h: 0.76,
    title: 'Статусы двигает служба, не вы',
    body: 'Вы не переводите заявку между состояниями и не отменяете её. Пока она «Новая» и исполнителя нет — её можно удалить; дальше об отмене просят оператора и называют причину.',
    tone: 'orange',
  });

  cursor = heading(slide, cursor, 'Если заявка стоит дольше обычного');
  cursor = steps(slide, cursor, [
    'Посмотрите в списке подпись под статусом: она называет, кого заявка ждёт, и сколько дней стоит.',
    'Напишите в обсуждении заявки — его читают все, кто с ней работает, и ответ останется в заявке.',
    'Если ответа нет, обратитесь к оператору службы и назовите номер заявки.',
  ]);

  figure(slide, {
    y: cursor,
    h: H - cursor - 1.05,
    file: 'S08',
    caption:
      'Строка списка: статус, подпись «кого ждёт», счётчик дней и метка непрочитанного обсуждения.',
  });
}

// ── Страница 4: карточка заявки (этап Э6, субзадачи С1, С2, С3) ──

/**
 * ТРИ ВКЛАДКИ, И ЭТО РЕШЕНИЕ, А НЕ ОПИСАНИЕ ЭКРАНА (Р6). Карточка разграничена по аудиториям
 * (ADR 0160): заявителю не уходят ни объём работ, ни суммы, ни закрытые виды документов — причём не
 * условным рендером, а проекцией DTO на сервере. Перечень документов берётся из словаря (Р3), где
 * он посчитан теми же `isServiceFileKindVisible` и `canAttachServiceFile`, что решают это в коде:
 * второй список видов разошёлся бы с матрицей §4.1 молча.
 */
function cardPage(pptx) {
  const visible = LABELS.fileKinds.filter((kind) => kind.visibleToRequester);
  const attachable = LABELS.fileKinds.filter((kind) => kind.attachableByRequester);
  const { slide, y } = page(pptx, {
    number: 4,
    kicker: 'Карточка заявки',
    title: 'Где смотреть свою заявку',
    subtitle:
      'Свои заявки видно во вкладке «Заявки»: поиск понимает номер заявки, модель и оба номера аппарата, а отбор «Мои заявки» оставляет только заведённые вами. Карточка открывается по строке.',
  });

  let cursor = heading(slide, y, 'Что в карточке');
  table(slide, {
    y: cursor,
    head: ['Вкладка', 'Что показывает', 'Что вы можете'],
    widths: [1.25, 3.1, CW - 4.35],
    rows: [
      [
        'Заявка',
        'Всё, что вы написали: аппарат и его место, описание, заказчик, контакт, срочность; плюс статус, исполнители и автор',
        'Читать; править — пока заявка «Новая» и исполнителя нет',
      ],
      [
        'Документы',
        `Из документов заявки вам видны ${visible.map((kind) => kind.label.toLowerCase()).join(' и ')}`,
        `Приложить ${attachable.map((kind) => kind.label.toLowerCase()).join(', ')} и снять своё`,
      ],
      [
        'История',
        'Кто и когда менял заявку: переходы состояний с причинами, правки, назначение исполнителя',
        'Читать. Причина отмены или остановки видна целиком',
      ],
    ],
  });
  cursor += 1.95;

  cursor = callout(slide, {
    y: cursor,
    h: 0.86,
    title: 'Стоимости работ в карточке нет — так задумано',
    body: 'Смета, счёт и акт — отношения компании с подрядчиком, и предмет вашей заявки другой: «не работает принтер». Поэтому вкладки «Объём работ» у вас нет, а суммы не показываются ни в списке, ни в истории. Если сумма нужна по работе — спрашивайте у службы, а не в карточке.',
    tone: 'blue',
  });

  cursor = heading(slide, cursor, 'Обсуждение заявки');
  cursor = steps(slide, cursor, [
    'Кнопка «Обсуждение» есть в карточке и в строке списка; синее число рядом означает непрочитанные реплики.',
    'Писать в обсуждении может автор заявки; читают все, кому заявка видна.',
    'Адресата реплики выбираете вы: служба, системный администратор или сервисная компания.',
  ]);

  const third = (CW - 0.4) / 3;
  const h = H - cursor - 1.05;
  figure(slide, { y: cursor, h, w: third, file: 'S09', caption: 'Вкладка «Заявка».' });
  figure(slide, {
    x: M + third + 0.2,
    y: cursor,
    h,
    w: third,
    file: 'S10',
    caption: 'Вкладка «Документы».',
  });
  figure(slide, {
    x: M + 2 * (third + 0.2),
    y: cursor,
    h,
    w: third,
    file: 'S11',
    caption: 'Вкладка «История».',
  });
}

// ── Страница 5: что можно исправить (этап Э4) ──

/**
 * ПУНКТЫ МЕНЮ НАЗВАНЫ ПО ADR 0162. Из меню действий ушли повтор письма службе и перемещение
 * техники (последнее переехало к реквизитам аппарата и заявителю недоступно вовсе), поэтому
 * страница обещает ровно два действия — правку и удаление, — и оба под условием «пока „Новая“ и
 * исполнителя нет».
 */
function questionsPage(pptx) {
  const { slide, y } = page(pptx, {
    number: 5,
    kicker: 'Частые вопросы',
    title: 'Что можно исправить и к кому идти',
    subtitle:
      'Короткие ответы на то, о чём спрашивают чаще всего. Если ответа здесь нет — напишите в обсуждении заявки: его читают те, кто с ней работает.',
  });

  const half = (CW - 0.2) / 2;
  const rows = [
    [
      'Ошибся в описании',
      'Пока заявка «Новая» и исполнителя нет, откройте её и выберите «Редактировать» в меню действий. Аппарат в правке не меняется.',
      'blue',
    ],
    [
      'Передумал заводить заявку',
      'Пока она «Новая» — «Удалить» в том же меню. Дальше заявку отменяет оператор: попросите его и назовите причину.',
      'orange',
    ],
    [
      'Перепутал категорию',
      'Категорию заведённой заявки не меняют. Заведите новую в нужной категории, а эту удалите или попросите отменить.',
      'blue',
    ],
    [
      'Аппарат стоит не там, где записано',
      'Скажите об этом в заявке: фактическое место уйдёт вместе с ней. Справочник поправит ответственный после подтверждения.',
      'green',
    ],
    [
      'Мастер приходил, а заявка ещё открыта',
      'Работы закрывает исполнитель, а принимает оператор. Если работа сделана, а состояние не поменялось — напишите в обсуждении.',
      'orange',
    ],
    [
      'Раздел «Орг.техника» не открывается',
      'Это вопрос доступа: обратитесь к администратору портала. Заявку в этом случае заводит за вас коллега или служба.',
      'green',
    ],
  ];
  let cursor = y;
  rows.forEach(([title, body, tone], index) => {
    const column = index % 2;
    const y0 = cursor + Math.floor(index / 2) * 1.2;
    callout(slide, {
      x: M + column * (half + 0.2),
      y: y0,
      w: half,
      h: 1.04,
      title,
      body,
      tone,
    });
  });
  cursor += 3.6;

  cursor = heading(slide, cursor, 'Куда обращаться');
  cursor = steps(slide, cursor, [
    'По конкретной заявке — в её обсуждение: там отвечают те, кто с ней работает.',
    'Если аппарата нет в справочнике — отправьте карточку на проверку прямо из формы заявки (страница 2).',
    'Если не открывается раздел или не подходит учётная запись — к администратору портала.',
  ]);

  const h = H - cursor - 1.05;
  figure(slide, {
    y: cursor,
    h,
    w: half,
    file: 'S13',
    caption: 'Меню действий у заявки «Новая».',
  });
  figure(slide, {
    x: M + half + 0.2,
    y: cursor,
    h,
    w: half,
    file: 'S14',
    caption: 'Тот же список на телефоне.',
  });
}

// ── Воспроизводимость сборки ──

/**
 * ДВА ПРОГОНА ОБЯЗАНЫ ДАТЬ ОДИН И ТОТ ЖЕ ФАЙЛ. Оба артефакта лежат в репозитории, и пересборка без
 * правок не должна давать бинарный дифф: иначе «что изменилось в памятке» перестаёт быть вопросом,
 * на который отвечает `git diff`. Прежний генератор это выполнял (фиксированная дата в pdf-lib), и
 * терять свойство при переезде на PPTX незачем.
 *
 * Времени в двух местах, и оба закрыты здесь, потому что закрыть их снаружи нечем: `pptxgenjs` даты
 * задавать не умеет (в API только `revision`), а LibreOffice не слушает `SOURCE_DATE_EPOCH` —
 * проверено, дата экспорта осталась текущей.
 */
const STAMP_ISO = '2026-09-03T12:00:00+05:00';
const STAMP_PDF = "20260903120000+05'00'";

/**
 * PPTX: `pptxgenjs` берёт дату документа и время записей zip из `new Date()`. Подмена конструктора
 * на время сборки — самое дешёвое место вмешательства: своего zip-писателя ради двух полей заводить
 * не стоит, а `zip` в контуре нет. Подмена снимается в `finally` — иначе фиксированное «сейчас»
 * досталось бы всему остальному коду процесса.
 */
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

/**
 * PDF: LibreOffice кладёт в файл время экспорта, `/ID` и `/DocChecksum` — 94 байта, которые плавают
 * от прогона к прогону. Все три поля фиксированной длины, поэтому правятся на месте: смещения
 * `xref` не сдвигаются, и переписывать PDF целиком не нужно.
 *
 * `/ID` и `/DocChecksum` считаются от уже нормализованного содержимого, а не берутся константой:
 * идентификатор обязан различать РАЗНЫЕ документы, и прибитый гвоздями он сделал бы две разные
 * редакции памятки неразличимыми для читалок, которые на него смотрят.
 */
function normalizePdf(file) {
  const text = readFileSync(file).toString('latin1');
  const dated = text.replace(
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
  const fixed = blanked
    .replace(idPattern, (_, a, __, b, ___, d) => `${a}${id}${b}${id}${d}`)
    .replace(sumPattern, (_, a) => `${a}${checksum}`);
  writeFileSync(file, Buffer.from(fixed, 'latin1'));
}

// ── Сборка ──

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'A4', width: W, height: H });
pptx.layout = 'A4';
pptx.author = 'АВТО';
pptx.company = 'АВТО';
pptx.title = 'Орг.техника: памятка заявителю';
pptx.subject = 'Как завести заявку на обслуживание оргтехники и что с ней происходит дальше';

requestPage(pptx);
categoriesPage(pptx);
flowPage(pptx);
cardPage(pptx);
questionsPage(pptx);

mkdirSync(dirname(OUT_PPTX), { recursive: true });
await writePptxAtFixedTime(pptx, OUT_PPTX);

/** PDF — только из этого PPTX (Р1). Профиль LibreOffice берётся временный: чужой мы не трогаем. */
const profile = mkdtempSync(join(tmpdir(), 'soffice-'));
const converted = spawnSync(
  'soffice',
  [
    `-env:UserInstallation=file://${profile}`,
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    dirname(OUT_PPTX),
    OUT_PPTX,
  ],
  { encoding: 'utf8' },
);
rmSync(profile, { recursive: true, force: true });
if (converted.status !== 0) {
  throw new Error(`PDF не собрался:\n${converted.stdout}\n${converted.stderr}`);
}

const OUT_PDF = OUT_PPTX.replace(/\.pptx$/, '.pdf');
normalizePdf(OUT_PDF);

stdout.write(`${OUT_PPTX}\n${OUT_PDF}\n`);
