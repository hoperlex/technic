import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2] ?? '/tmp/waste-ticket-ocr-ui';
await mkdir(outDir, { recursive: true });

const W = 1600;
const H = 900;
const C = {
  ink: '#17233d',
  muted: '#64748b',
  line: '#d9e2ef',
  soft: '#f5f7fb',
  white: '#ffffff',
  blue: '#1677ff',
  blueSoft: '#eaf3ff',
  green: '#389e0d',
  greenSoft: '#f0f9eb',
  amber: '#d48806',
  amberSoft: '#fff8e6',
  red: '#cf1322',
  redSoft: '#fff1f0',
  purple: '#722ed1',
  purpleSoft: '#f9f0ff',
  grayTag: '#f0f0f0',
};

const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function rect(x, y, w, h, fill = C.white, radius = 12, stroke = 'none', sw = 1) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function line(x1, y1, x2, y2, color = C.line, sw = 1, dash = '') {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function text(x, y, value, size = 24, color = C.ink, weight = 400, anchor = 'start') {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
}

function lines(x, y, values, size = 22, color = C.ink, weight = 400, gap = 1.35) {
  return values.map((v, i) => text(x, y + i * size * gap, v, size, color, weight)).join('');
}

function circle(cx, cy, r, fill, stroke = 'none', sw = 1) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function pill(x, y, label, fill, color, opts = {}) {
  const size = opts.size ?? 18;
  const px = opts.px ?? 14;
  const h = opts.h ?? 32;
  const w = opts.w ?? Math.max(54, label.length * size * 0.57 + px * 2);
  return `${rect(x, y, w, h, fill, h / 2, opts.stroke ?? 'none', 1)}${text(x + w / 2, y + h * 0.68, label, size, color, opts.weight ?? 600, 'middle')}`;
}

function button(x, y, label, opts = {}) {
  const primary = opts.primary ?? false;
  const danger = opts.danger ?? false;
  const size = opts.size ?? 18;
  const h = opts.h ?? 40;
  const w = opts.w ?? Math.max(90, label.length * size * 0.58 + 30);
  const fill = primary ? C.blue : C.white;
  const color = primary ? C.white : danger ? C.red : C.blue;
  const stroke = primary ? C.blue : danger ? '#ffccc7' : '#91caff';
  return `${rect(x, y, w, h, fill, 7, stroke)}${text(x + w / 2, y + h * 0.67, label, size, color, 600, 'middle')}`;
}

function field(x, y, w, label, value, opts = {}) {
  const h = opts.h ?? 48;
  return `${text(x, y - 10, label, 16, C.ink, 500)}${rect(x, y, w, h, opts.fill ?? C.white, 6, opts.stroke ?? '#d9d9d9')}${text(x + 14, y + h * 0.65, value, 18, opts.valueColor ?? C.ink, 400)}${opts.extra ? text(x, y + h + 23, opts.extra, 14, opts.extraColor ?? C.muted, 400) : ''}`;
}

function alertBox(x, y, w, kind, title, description = '') {
  const conf = {
    success: [C.greenSoft, '#b7eb8f', C.green, '✓'],
    info: [C.blueSoft, '#91caff', C.blue, 'i'],
    warning: [C.amberSoft, '#ffe58f', C.amber, '!'],
    error: [C.redSoft, '#ffa39e', C.red, '!'],
  }[kind];
  const h = description ? 82 : 56;
  return `${rect(x, y, w, h, conf[0], 8, conf[1])}${circle(x + 28, y + 28, 13, conf[2])}${text(x + 28, y + 35, conf[3], 17, C.white, 700, 'middle')}${text(x + 52, y + 27, title, 18, C.ink, 600)}${description ? text(x + 52, y + 56, description, 15, C.muted, 400) : ''}`;
}

function numberCallout(x, y, n, label, color = C.blue) {
  return `${circle(x, y, 20, color)}${text(x, y + 7, n, 20, C.white, 700, 'middle')}${text(x + 32, y + 7, label, 20, C.ink, 600)}`;
}

function logo(x, y, size = 38) {
  const r = size / 2;
  const scale = size / 64;
  return `<g transform="translate(${x},${y}) scale(${scale})"><circle cx="32" cy="32" r="32" fill="${C.blue}"/><path d="M22 46 L32 20 L42 46 M25 38 H39" fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

function iconCamera(x, y, color = C.blue) {
  return `<g transform="translate(${x},${y})" stroke="${color}" stroke-width="2.5" fill="none" stroke-linejoin="round"><rect x="0" y="5" width="27" height="19" rx="3"/><path d="M7 5l3-4h7l3 4"/><circle cx="13.5" cy="14.5" r="5"/></g>`;
}

function iconUpload(x, y, color = C.blue) {
  return `<g transform="translate(${x},${y})" stroke="${color}" stroke-width="2.5" fill="none" stroke-linecap="round"><path d="M14 18V1M7 8l7-7 7 7"/><path d="M3 16v8h22v-8"/></g>`;
}

function iconScan(x, y, color = C.blue) {
  return `<g transform="translate(${x},${y})" stroke="${color}" stroke-width="2.4" fill="none" stroke-linecap="round"><path d="M0 8V0h8M20 0h8v8M28 20v8h-8M8 28H0v-8"/><path d="M5 14h18M5 18h18"/></g>`;
}

function iconPerson(x, y, color = C.blue) {
  return `<g transform="translate(${x},${y})" fill="none" stroke="${color}" stroke-width="2.4"><circle cx="14" cy="8" r="6"/><path d="M2 28c1-8 5-11 12-11s11 3 12 11"/></g>`;
}

function iconDone(x, y, color = C.green) {
  return `<g transform="translate(${x},${y})"><circle cx="15" cy="15" r="15" fill="${color}"/><path d="M7 15l5 5 11-12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

function base(titleValue, kicker, pageNo, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.soft}"/>
  <rect width="${W}" height="8" fill="${C.blue}"/>
  ${logo(58, 34, 40)}
  ${text(112, 63, 'АВТО', 20, C.ink, 700)}
  ${text(1500, 60, `0${pageNo}`, 18, C.muted, 600, 'end')}
  ${text(60, 116, kicker.toUpperCase(), 15, C.blue, 700)}
  ${text(60, 164, titleValue, 36, C.ink, 700)}
  ${body}
  ${text(60, 872, 'Распознавание талонов вывоза · пользовательский сценарий', 14, C.muted, 400)}
  ${text(1540, 872, 'Демонстрационные данные', 14, C.muted, 400, 'end')}
  </svg>`;
}

function browserShell(x, y, w, h, inner, opts = {}) {
  const sider = opts.sider ?? 170;
  return `${rect(x, y, w, h, C.white, 14, '#ccd6e4')}
    ${rect(x, y, w, 48, '#fbfcfe', 14)}
    ${circle(x + 22, y + 24, 5, '#ff7875')}${circle(x + 40, y + 24, 5, '#ffd666')}${circle(x + 58, y + 24, 5, '#95de64')}
    ${rect(x + 90, y + 13, w - 120, 24, '#edf1f6', 7)}
    ${rect(x, y + 48, sider, h - 48, '#ffffff', 0)}${line(x + sider, y + 48, x + sider, y + h, '#e6ebf2')}
    ${logo(x + 20, y + 68, 28)}${text(x + 58, y + 91, 'АВТО', 17, C.ink, 700)}
    ${pill(x + 16, y + 124, '▤  Вывоз мусора', C.blueSoft, C.blue, { w: sider - 32, h: 38, size: 16 })}
    ${text(x + 25, y + 191, '▣  Заявки на технику', 15, C.muted, 500)}
    ${text(x + 25, y + 232, '▦  Путевые листы', 15, C.muted, 500)}
    ${text(x + 25, y + 273, '◫  Гараж', 15, C.muted, 500)}
    ${inner}`;
}

const pages = [];

// 01 — cover and end-to-end path.
pages.push(
  base(
    'Как пользователь работает с талоном',
    'Распознавание рукописных талонов',
    1,
    `${text(60, 210, 'От загрузки фото до подтверждённой сверки — прямо в карточке заявки.', 23, C.muted, 400)}
    ${rect(60, 260, 1480, 148, C.ink, 18)}
    ${text(96, 311, 'Главный принцип', 17, '#8cbcff', 700)}
    ${text(96, 360, 'Портал читает бумагу и подсвечивает риск.', 31, C.white, 700)}
    ${text(885, 360, 'Решение всегда остаётся за человеком.', 31, '#8cbcff', 700)}
    ${text(96, 391, 'Распознанные значения не подтверждаются автоматически и не меняют факт закрытия.', 17, '#cbd5e1', 400)}

    ${rect(60, 462, 330, 308, C.white, 16, C.line)}
    ${circle(112, 518, 30, C.blueSoft)}${iconCamera(98, 503, C.blue)}
    ${pill(84, 568, '1', C.blue, C.white, { w: 42, h: 42, size: 21 })}
    ${text(144, 598, 'Прикрепить талон', 25, C.ink, 700)}
    ${lines(84, 642, ['В форме выполнения:', 'объём, дата вывоза', 'и фото / файл талона.'], 18, C.muted, 400, 1.5)}

    ${text(414, 625, '→', 36, '#9fb3cb', 500, 'middle')}
    ${rect(438, 462, 330, 308, C.white, 16, C.line)}
    ${circle(490, 518, 30, C.blueSoft)}${iconScan(476, 504, C.blue)}
    ${pill(462, 568, '2', C.blue, C.white, { w: 42, h: 42, size: 21 })}
    ${text(522, 598, 'Дождаться чтения', 25, C.ink, 700)}
    ${lines(462, 642, ['Заявка уже закрыта.', 'Статус распознавания', 'виден в списке и карточке.'], 18, C.muted, 400, 1.5)}

    ${text(792, 625, '→', 36, '#9fb3cb', 500, 'middle')}
    ${rect(816, 462, 330, 308, C.white, 16, C.line)}
    ${circle(868, 518, 30, C.blueSoft)}${iconPerson(854, 503, C.blue)}
    ${pill(840, 568, '3', C.blue, C.white, { w: 42, h: 42, size: 21 })}
    ${text(900, 598, 'Проверить', 25, C.ink, 700)}
    ${lines(840, 642, ['Сверить номер, дату,', 'объём и адрес;', 'подтвердить или исправить.'], 18, C.muted, 400, 1.5)}

    ${text(1170, 625, '→', 36, '#9fb3cb', 500, 'middle')}
    ${rect(1194, 462, 346, 308, C.white, 16, C.line)}
    ${circle(1246, 518, 30, C.greenSoft)}${iconDone(1231, 503, C.green)}
    ${pill(1218, 568, '4', C.green, C.white, { w: 42, h: 42, size: 21 })}
    ${text(1278, 598, 'Получить результат', 25, C.ink, 700)}
    ${lines(1218, 642, ['Зелёная отметка — всё', 'разобрано. Расхождения', 'остаются в истории.'], 18, C.muted, 400, 1.5)}`,
  ),
);

// 02 — completion modal.
{
  const sx = 60;
  const sy = 218;
  const sw = 1110;
  const sh = 610;
  const ix = sx + 190;
  const iy = sy + 78;
  const modal = `${rect(ix, iy, 850, 488, C.white, 12, '#c9d3e0')}
    ${text(ix + 28, iy + 42, 'Выполнение заявки', 25, C.ink, 700)}${line(ix, iy + 62, ix + 850, iy + 62, '#edf0f4')}
    ${text(ix + 28, iy + 96, 'Заявка № 1842, ЖК «Карасай», блок Б · заявлено 48 м³', 16, C.muted, 400)}
    ${field(ix + 28, iy + 136, 365, 'Вывезено, м³', '48', { extra: 'По факту выполнения' })}
    ${field(ix + 430, iy + 136, 365, 'Дата вывоза', '24.08.2026', { extra: 'Дата с талона, не дата закрытия' })}
    ${field(ix + 28, iy + 240, 365, 'Стоимость, ₽', '336 000', { extra: '7 000 ₽/м³ по прайсу' })}
    ${text(ix + 430, iy + 230, 'Талоны', 16, C.ink, 500)}
    ${button(ix + 430, iy + 240, '  Прикрепить талон', { w: 216 })}${iconUpload(ix + 450, iy + 248, C.blue)}
    ${pill(ix + 430, iy + 292, 'IMG_4821.jpg   ×', '#f5f5f5', C.ink, { w: 190, h: 34, size: 15, weight: 400, stroke: '#d9d9d9' })}
    ${text(ix + 28, iy + 359, 'Комментарий', 16, C.ink, 500)}${rect(ix + 28, iy + 374, 767, 54, C.white, 6, '#d9d9d9')}
    ${text(ix + 42, iy + 407, 'Необязательно: что важно знать об этом выполнении', 15, '#b0b8c5', 400)}
    ${line(ix, iy + 446, ix + 850, iy + 446, '#edf0f4')}${button(ix + 626, iy + 462, 'Отмена', { w: 92 })}${button(ix + 730, iy + 462, 'Выполнена', { w: 96, primary: true })}`;

  pages.push(
    base(
      'Шаг 1. Закрыть заявку и приложить талон',
      'Роль: исполнитель или диспетчер',
      2,
      `${browserShell(sx, sy, sw, sh, modal)}
      ${rect(1205, 218, 335, 610, C.white, 16, C.line)}
      ${numberCallout(1243, 273, '1', 'Заполните факт')}
      ${lines(1243, 310, ['Объём и дата остаются', 'самостоятельным фактом', 'закрытия заявки.'], 17, C.muted, 400, 1.45)}
      ${line(1243, 392, 1500, 392, '#e8edf4')}
      ${numberCallout(1243, 439, '2', 'Добавьте файл')}
      ${lines(1243, 476, ['На компьютере — файл.', 'На телефоне доступна', 'кнопка «Снять камерой».'], 17, C.muted, 400, 1.45)}
      ${line(1243, 562, 1500, 562, '#e8edf4')}
      ${numberCallout(1243, 609, '3', 'Закройте заявку')}
      ${lines(1243, 646, ['Талон обязателен, но', 'распознавание идёт уже', 'после закрытия — ждать не надо.'], 17, C.muted, 400, 1.45)}
      ${alertBox(1235, 744, 275, 'info', 'Важно', 'Цифры из талона форму не заполняют.')}`,
    ),
  );
}

// 03 — list and automatic recognition status.
{
  const sx = 60;
  const sy = 222;
  const sw = 1120;
  const sh = 600;
  const cx = sx + 194;
  const list = `${text(cx, sy + 91, 'Заявки на вывоз мусора', 25, C.ink, 700)}
    ${button(cx + 650, sy + 62, '+ Новая заявка', { primary: true, w: 156 })}
    ${rect(cx, sy + 126, 880, 52, '#f7f9fc', 0, '#e5eaf1')}
    ${text(cx + 18, sy + 158, '№', 15, C.muted, 600)}${text(cx + 78, sy + 158, 'Объект', 15, C.muted, 600)}${text(cx + 344, sy + 158, 'Контейнер / машина', 15, C.muted, 600)}${text(cx + 590, sy + 158, 'Талоны', 15, C.muted, 600)}${text(cx + 740, sy + 158, 'Статус', 15, C.muted, 600)}
    ${rect(cx, sy + 178, 880, 90, C.white, 0, '#e5eaf1')}
    ${text(cx + 18, sy + 214, '1842', 17, C.blue, 600)}${text(cx + 78, sy + 212, 'ЖК «Карасай», блок Б', 17, C.ink, 600)}${text(cx + 78, sy + 237, 'ул. Сейфуллина, 56', 14, C.muted, 400)}
    ${text(cx + 344, sy + 212, 'Самосвал · 48 м³', 17, C.ink, 400)}${text(cx + 344, sy + 237, '336 000 ₽', 14, C.muted, 400)}
    ${pill(cx + 590, sy + 197, '⏳ 2', C.blueSoft, C.blue, { w: 78, h: 34, size: 17 })}
    ${pill(cx + 740, sy + 197, 'Выполнена', C.greenSoft, C.green, { w: 112, h: 34, size: 15 })}
    ${text(cx, sy + 313, 'Карточка заявки · Талоны', 20, C.ink, 700)}
    ${alertBox(cx, sy + 338, 880, 'info', 'Распознаётся…', 'попытка 1 из 5 — выполняется сейчас')}
    ${rect(cx, sy + 438, 880, 76, '#fbfcfe', 8, '#e5eaf1')}
    ${text(cx + 20, sy + 469, 'Файлы и попытки распознавания', 17, C.ink, 600)}
    ${text(cx + 20, sy + 497, 'IMG_4821.jpg · страниц 1 · файл готовится к чтению', 15, C.muted, 400)}
    ${button(cx + 728, sy + 456, 'Перераспознать', { w: 132, size: 15, h: 36 })}`;

  pages.push(
    base(
      'Шаг 2. Следить за статусом — без отдельного экрана',
      'Автоматическая обработка',
      3,
      `${browserShell(sx, sy, sw, sh, list)}
      ${rect(1215, 222, 325, 600, C.white, 16, C.line)}
      ${text(1245, 270, 'Что видит пользователь', 22, C.ink, 700)}
      ${pill(1245, 304, '⏳ 2', C.blueSoft, C.blue, { w: 80, h: 36, size: 17 })}
      ${text(1342, 330, 'два талона ждут', 17, C.ink, 600)}
      ${text(1342, 354, 'подтверждения', 17, C.muted, 400)}
      ${pill(1245, 390, '🚫 1', C.grayTag, C.muted, { w: 80, h: 36, size: 17 })}
      ${text(1342, 416, 'один файл прочитать', 17, C.ink, 600)}
      ${text(1342, 440, 'не удалось', 17, C.muted, 400)}
      ${pill(1245, 476, '✓', C.greenSoft, C.green, { w: 54, h: 36, size: 18 })}
      ${text(1316, 502, 'всё разобрано,', 17, C.ink, 600)}
      ${text(1316, 526, 'расхождений нет', 17, C.muted, 400)}
      ${line(1245, 570, 1510, 570, '#e8edf4')}
      ${lines(1245, 615, ['Если сервис временно недоступен,', 'портал показывает предупреждение', 'и повторяет попытку сам.', '', 'Если нужен администратор,', 'интерфейс говорит об этом прямо.'], 16, C.muted, 400, 1.42)}`,
    ),
  );
}

// 04 — detailed review.
{
  const x = 60;
  const y = 222;
  const w = 1480;
  const body = `${rect(x, y, w, 602, C.white, 16, C.line)}
    ${text(x + 30, y + 43, 'Заявка № 1842 · Талоны', 24, C.ink, 700)}
    ${alertBox(x + 30, y + 66, w - 60, 'error', 'В талонах 40 м³, в закрытии 48 м³', 'Предварительно: не все талоны подтверждены')}
    ${button(x + 30, y + 166, 'Добавить талон вручную', { w: 216, size: 16 })}
    ${pill(x + 1275, y + 170, '2 из 2 найдены', C.blueSoft, C.blue, { w: 145, h: 34, size: 15 })}
    ${rect(x + 30, y + 222, w - 60, 52, '#f7f9fc', 0, '#e5eaf1')}
    ${text(x + 46, y + 254, '№ талона', 15, C.muted, 600)}${text(x + 232, y + 254, 'Дата', 15, C.muted, 600)}${text(x + 410, y + 254, 'Объём', 15, C.muted, 600)}${text(x + 558, y + 254, 'Адрес', 15, C.muted, 600)}${text(x + 912, y + 254, 'Состояние', 15, C.muted, 600)}
    ${rect(x + 30, y + 274, w - 60, 92, C.white, 0, '#e5eaf1')}
    ${text(x + 46, y + 312, '30476', 18, C.ink, 600)}${text(x + 232, y + 312, '24.08.2026', 17, C.ink, 400)}${text(x + 410, y + 312, '20 м³', 17, C.ink, 400)}${text(x + 558, y + 312, 'Сейфуллина, 56', 17, C.ink, 400)}
    ${pill(x + 912, y + 292, 'на проверке', C.blueSoft, C.blue, { w: 126, h: 34, size: 15 })}
    ${button(x + 1060, y + 290, 'Подтвердить', { w: 120, size: 15, h: 36 })}${button(x + 1190, y + 290, 'Исправить', { w: 100, size: 15, h: 36 })}${button(x + 1300, y + 290, 'Не талон', { w: 92, size: 15, h: 36, danger: true })}
    ${rect(x + 30, y + 366, w - 60, 108, '#fffdf7', 0, '#e5eaf1')}
    ${pill(x + 46, y + 389, 'спорно', C.amberSoft, C.amber, { w: 82, h: 32, size: 15 })}${text(x + 140, y + 412, '30477 / 30471', 15, C.muted, 400)}
    ${text(x + 232, y + 412, '24.08.2026', 17, C.ink, 400)}${text(x + 410, y + 412, '20 м³', 17, C.ink, 400)}${text(x + 558, y + 412, 'Сейфуллина, 56', 17, C.ink, 400)}
    ${pill(x + 912, y + 389, 'на проверке', C.blueSoft, C.blue, { w: 126, h: 34, size: 15 })}
    ${text(x + 1060, y + 412, 'Подтвердить', 15, '#b8c2cf', 600)}${button(x + 1190, y + 387, 'Разобрать', { w: 100, size: 15, h: 36 })}${button(x + 1300, y + 387, 'Не талон', { w: 92, size: 15, h: 36, danger: true })}
    ${text(x + 46, y + 450, 'Модели прочитали номер по-разному — сначала укажите верное значение.', 14, C.amber, 500)}
    ${alertBox(x + 30, y + 500, w - 60, 'info', 'На некоторых кадрах больше одного талона', 'страница 1: 2 — проверьте, что обе строки есть в таблице')}`;

  pages.push(
    base(
      'Шаг 3. Сверить распознанные данные с бумагой',
      'Роль: проверяющий талонов',
      4,
      body,
    ),
  );
}

// 05 — exceptions and actions.
{
  const y = 232;
  const cardW = 458;
  const cardH = 528;
  pages.push(
    base(
      'Шаг 4. Разобрать исключение понятным действием',
      'Без скрытых автоматических решений',
      5,
      `${rect(60, y, cardW, cardH, C.white, 16, C.line)}
      ${pill(84, y + 26, 'A', C.amberSoft, C.amber, { w: 40, h: 40, size: 20 })}${text(140, y + 57, 'Поле прочитано спорно', 22, C.ink, 700)}
      ${lines(84, y + 101, ['В таблице видны оба варианта.', '«Подтвердить» выключена до правки.'], 17, C.muted, 400, 1.42)}
      ${rect(84, y + 178, 410, 112, '#fffdf7', 8, '#ffe58f')}
      ${text(104, y + 210, '№ талона', 14, C.muted, 500)}${pill(104, y + 226, 'спорно', C.amberSoft, C.amber, { w: 82, h: 30, size: 14 })}${text(198, y + 249, '30477 / 30471', 17, C.ink, 600)}
      ${button(104, y + 318, 'Разобрать', { w: 118, primary: true })}
      ${lines(84, y + 394, ['Откройте скан, впишите верное', 'значение и сохраните. Это снимает', 'спорность именно с этого поля.'], 17, C.ink, 500, 1.45)}

      ${rect(571, y, cardW, cardH, C.white, 16, C.line)}
      ${pill(595, y + 26, 'B', C.blueSoft, C.blue, { w: 40, h: 40, size: 20 })}${text(651, y + 57, 'Нужно исправить талон', 22, C.ink, 700)}
      ${text(595, y + 101, 'Форма повторяет реальные поля талона.', 17, C.muted, 400)}
      ${rect(607, y + 136, 386, 335, '#fbfcfe', 10, '#d9e2ef')}
      ${text(631, y + 172, 'Исправить талон', 21, C.ink, 700)}
      ${field(631, y + 205, 338, '№ талона', '30477', { h: 42 })}
      ${field(631, y + 288, 160, 'Дата талона', '24.08.2026', { h: 42 })}${field(809, y + 288, 160, 'Объём, м³', '20', { h: 42 })}
      ${text(631, y + 377, 'Что было', 15, C.ink, 500)}${pill(631, y + 392, 'Вывоз', C.blueSoft, C.blue, { w: 78, h: 34, size: 15 })}${pill(718, y + 392, 'Простой', '#f5f5f5', C.muted, { w: 88, h: 34, size: 15, stroke: '#d9d9d9' })}${pill(815, y + 392, 'Иное', '#f5f5f5', C.muted, { w: 70, h: 34, size: 15, stroke: '#d9d9d9' })}
      ${button(843, y + 482, 'Сохранить', { w: 126, primary: true })}

      ${rect(1082, y, cardW, cardH, C.white, 16, C.line)}
      ${pill(1106, y + 26, 'C', C.redSoft, C.red, { w: 40, h: 40, size: 20 })}${text(1162, y + 57, 'Файл не читается', 22, C.ink, 700)}
      ${alertBox(1106, y + 102, 410, 'error', 'Файл не распознан', 'Перезалейте скан или заведите талон вручную')}
      ${lines(1106, y + 223, ['1. Попробуйте более чёткое фото.', '2. Нажмите «Перераспознать».', '3. Если не помогло — введите вручную.'], 17, C.ink, 500, 1.55)}
      ${button(1106, y + 350, 'Перераспознать', { w: 168 })}${button(1288, y + 350, 'Ввести вручную', { w: 172, primary: true })}
      ${line(1106, y + 425, 1516, y + 425, '#e8edf4')}
      ${pill(1106, y + 452, 'Не талон', C.redSoft, C.red, { w: 94, h: 34, size: 15 })}${lines(1217, y + 478, ['Если в файл попала обложка,', 'приписка или лишний кадр.'], 15, C.muted, 400, 1.4)}

      ${alertBox(60, 784, 1480, 'success', 'Любой ручной ввод сразу считается подтверждённым', 'Он занимает номер талона и фиксируется в истории заявки.')}`,
    ),
  );
}

// 06 — completed state and concise role map.
{
  const y = 224;
  pages.push(
    base(
      'Готово: талон подтверждён, результат прозрачен',
      'Финальное состояние',
      6,
      `${rect(60, y, 935, 556, C.white, 16, C.line)}
      ${text(90, y + 48, 'Карточка заявки № 1842 · Талоны', 24, C.ink, 700)}
      ${alertBox(90, y + 72, 875, 'success', 'Расхождений нет', '')}
      ${rect(90, y + 152, 875, 50, '#f7f9fc', 0, '#e5eaf1')}
      ${text(108, y + 183, '№ талона', 15, C.muted, 600)}${text(276, y + 183, 'Дата', 15, C.muted, 600)}${text(444, y + 183, 'Объём', 15, C.muted, 600)}${text(590, y + 183, 'Состояние', 15, C.muted, 600)}
      ${rect(90, y + 202, 875, 68, C.white, 0, '#e5eaf1')}
      ${text(108, y + 244, '30476', 17, C.ink, 600)}${text(276, y + 244, '24.08.2026', 16, C.ink, 400)}${text(444, y + 244, '24 м³', 16, C.ink, 400)}${pill(590, y + 220, 'подтверждён', C.greenSoft, C.green, { w: 132, h: 34, size: 15 })}${button(800, y + 218, 'Исправить', { w: 112, size: 15, h: 36 })}
      ${rect(90, y + 270, 875, 68, C.white, 0, '#e5eaf1')}
      ${text(108, y + 312, '30477', 17, C.ink, 600)}${text(276, y + 312, '24.08.2026', 16, C.ink, 400)}${text(444, y + 312, '24 м³', 16, C.ink, 400)}${pill(590, y + 288, 'подтверждён', C.greenSoft, C.green, { w: 132, h: 34, size: 15 })}${button(800, y + 286, 'Исправить', { w: 112, size: 15, h: 36 })}
      ${text(90, y + 397, 'История', 20, C.ink, 700)}
      ${line(112, y + 431, 112, y + 515, '#b7d4ff', 3)}
      ${circle(112, y + 442, 9, C.blue)}${text(138, y + 448, '24.08.2026  14:08 · талон 30476 подтверждён', 16, C.ink, 500)}
      ${circle(112, y + 486, 9, C.blue)}${text(138, y + 492, '24.08.2026  14:10 · талон 30477 исправлен и подтверждён', 16, C.ink, 500)}

      ${rect(1030, y, 510, 556, C.ink, 16)}
      ${text(1064, y + 54, 'Кто что делает', 25, C.white, 700)}
      ${pill(1064, y + 88, 'Исполнитель / диспетчер', '#233451', '#b8d5ff', { w: 238, h: 38, size: 16 })}
      ${lines(1064, y + 148, ['• вводит факт выполнения', '• прикладывает фото или файл', '• заявка закрывается сразу'], 18, C.white, 500, 1.55)}
      ${pill(1064, y + 282, 'Проверяющий талонов', '#233451', '#b8d5ff', { w: 204, h: 38, size: 16 })}
      ${lines(1064, y + 342, ['• видит распознанные значения', '• подтверждает или исправляет', '• разбирает спорные случаи'], 18, C.white, 500, 1.55)}
      ${line(1064, y + 470, 1504, y + 470, '#3d4f6a')}
      ${text(1064, y + 510, '✓  Любое решение фиксируется в истории', 17, '#b8d5ff', 600)}

      ${rect(60, 804, 1480, 34, C.blueSoft, 8)}${text(800, 827, 'Итог: быстрее ручной сверки, но без автоматического принятия решений за пользователя.', 17, C.blue, 700, 'middle')}`,
    ),
  );
}

await Promise.all(
  pages.map((svg, index) =>
    writeFile(path.join(outDir, `waste-ticket-ui-${String(index + 1).padStart(2, '0')}.svg`), svg),
  ),
);

console.log(`${pages.length} SVG pages written to ${outDir}`);
