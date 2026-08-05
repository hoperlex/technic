import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

/**
 * Разметка бланков путевых листов плейсхолдерами (ADR 0037).
 *
 * Бланки приходят от бухгалтерии готовыми — `templates/source/` хранит их ровно такими, какими
 * их прислали. Скрипт не рисует форму, а только вписывает `{{ключ}}` в графы, которые заполняет
 * портал: вёрстка, стили, штампы и линии остаются нетронутыми, потому что правится ровно
 * содержимое перечисленных ячеек.
 *
 * Так замена бланка не требует правки кода: положить новый файл в `source/`, при необходимости
 * поправить адреса ниже и прогнать скрипт. Тест `waybill-template.test.ts` затем проверит, что
 * набор плейсхолдеров совпал с тем, что собирает сервер.
 *
 * Использование: pnpm --filter @technic/api template:waybill
 */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

interface Blank {
  /** Файл-оригинал в `templates/source/`. */
  source: string;
  /** Готовый шаблон: имя совпадает с кодом формы (`vehicle_types.waybill_form_code`). */
  out: string;
  /** Ячейка → плейсхолдер. Адреса выверены по линиям заполнения самого бланка. */
  cells: Record<string, string>;
  /**
   * Ячейки, содержимое которых стирается: графа диспетчера с подписью и её расшифровкой. Портал
   * документ не подписывает, а напечатанная рядом с пустой линией фамилия читается как подпись,
   * которой нет. Стиль ячейки при очистке сохраняется — он несёт рамку и линию графы.
   */
  clear?: string[];
  /**
   * Объединения, которые снимаются с бланка. Внутри объединения длинный текст режется по его
   * границе, а не переполняет пустых соседей, — и подпись, набранная бухгалтерией в двух узких
   * клетках, печатается огрызком.
   */
  unmerge?: string[];
  /** Содержимое переезжает из ячейки в ячейку вместе со стилем: «откуда» → «куда». */
  move?: Record<string, string>;
  /**
   * Графы, где текст ужимается по ширине (`shrinkToFit`). Ставится там, где значение приходит из
   * справочника и его длину бланк не выбирает.
   */
  shrink?: string[];
  /**
   * Графы, где текст переносится по словам (`wrapText`) и прижимается к верху. Нужны там, где
   * бланк отвёл под значение строку в две высоты, а значение в одну строку не влезает: без флага
   * хвост молча срезается по границе объединения.
   */
  wrap?: string[];
  /** Как бланк ложится на лист A4 при печати (ADR 0041). */
  orientation: 'portrait' | 'landscape';
}

/**
 * Форма 4-П. Сетка мелкая (колонки до FJ): графа набирается в одной ячейке, а текст растекается
 * вправо по линии заполнения. Поэтому значение пишется в первую ячейку линии.
 *
 * Часть подписей бланка — объединённые ячейки, и адрес обязан быть либо вне объединения, либо его
 * левым верхним углом: значение, попавшее внутрь чужого объединения, не печатается совсем. Это не
 * теория — так потерялись «Организация», гаражный номер и номер листа в обоих талонах, пока
 * `waybill-template.test.ts` не начал проверять адреса против `mergeCells` (ADR 0041).
 */
const FORM_4P: Blank = {
  source: '4П.xlsx',
  out: 'waybill-4p.xlsx',
  // 166 колонок в ширину — на портретном листе бланк рвётся пополам по вертикали.
  orientation: 'landscape',
  cells: {
    // Шапка: серия, номер и дата — три линии над «(серия)» и правее «№».
    BR2: '{{waybill_series}}',
    CX2: '{{waybill_number}}',
    BJ4: '{{waybill_date}}',
    // Организация и её коды; ОКУД впечатан типографией, ОКПО — наш. Подпись «Организация» —
    // объединение N6:AD6, поэтому линия заполнения начинается сразу за ним.
    AE6: '{{org_name}}, {{org_address}}, тел. {{org_phone}}',
    EY6: '{{org_okpo}}',
    // Автомобиль.
    V12: '{{vehicle_brand}}',
    AH13: '{{vehicle_reg_number}}',
    // Гаражный номер набирается в рамке справа — она и есть объединение CD13:CO13.
    CD13: '{{vehicle_garage_number}}',
    // Водитель: ФИО, СНИЛС (обязателен с 01.03.2023) и табельный номер.
    I14: '{{driver_fio}}',
    AY14: '{{driver_snils}}',
    CD14: '{{driver_personnel_no}}',
    S16: '{{driver_license_number}}',
    BE16: '{{driver_license_issued_on}}',
    V17: '{{communication_kind}}',
    // Прицепы: марка и госномер каждого.
    J20: '{{trailer1_brand}}',
    AV20: '{{trailer1_reg_number}}',
    J22: '{{trailer2_brand}}',
    AV22: '{{trailer2_reg_number}}',
    // Задание водителю: в чьё распоряжение — две строки, наименование и адрес заказчика.
    A30: '{{customer_name}}',
    A31: '{{customer_address}}',
    AN30: '{{task_departure_time}}',
    // Талоны заказчиков: левый (третий-четвёртый) и правый (первый-второй). Номер идёт в линию
    // за подписью «к путевому листу №» — она объединена, линия начинается следующей ячейкой.
    AL42: '{{waybill_number}}',
    BF42: '{{waybill_date}}',
    DQ42: '{{waybill_number}}',
    EK42: '{{waybill_date}}',
    /*
     * Нижнее задание водителю: откуда, куда, груз и графа «заказчик, телефон». Строк в таблице
     * четыре — ровно столько заявок держит рейс (ADR 0050), и каждая печатается своей строкой.
     * Пустые остаются пустыми: рейс из одной заявки выглядит так же, как выглядел лист до
     * маршрутов.
     *
     * В графе 27 стоят контакты рейса, а не наименование заказчика: заказчик уже напечатан в
     * шапке задания «в чьё распоряжение», а бланк просит здесь телефон — тот, по которому
     * водитель дозвонится на месте. Строк две, погрузка и разгрузка; переносом их разводит сам
     * бланк — стиль графы уже несёт `wrapText`, а высота строки держит две строки шрифтом 6 pt.
     */
    A75: '{{task_from}}',
    Y75: '{{task_to}}',
    AT75: '{{task_cargo}}',
    BG75: '{{task_contacts}}',
    A76: '{{task2_from}}',
    Y76: '{{task2_to}}',
    AT76: '{{task2_cargo}}',
    BG76: '{{task2_contacts}}',
    A77: '{{task3_from}}',
    Y77: '{{task3_to}}',
    AT77: '{{task3_cargo}}',
    BG77: '{{task3_contacts}}',
    A78: '{{task4_from}}',
    Y78: '{{task4_to}}',
    AT78: '{{task4_cargo}}',
    BG78: '{{task4_contacts}}',
    /*
     * Рейсы 5–7 (ADR 0068). Талонов в бланке четыре, а заявок у машины за смену бывает больше — и
     * место для них в бланке есть: справа от задания стоит блок «Дополнительное задание водителю»,
     * три нижние строки которого пусты и идут во всю его ширину (объединения CG76:EG76 … CG78:EG78,
     * 62 знака при кегле 6 pt и высоте строки в две таких).
     *
     * Граф внутри у них нет ни одной, поэтому идёт готовая строка «откуда → куда, груз, контакты»
     * — тем же порядком, что и графы таблицы слева. Три верхние строки блока (CG72, CG73, CG75)
     * не размечаются: они узкие (рядом «Расход горючего») и остаются диспетчеру под то, ради чего
     * блок в бланке и заведён, — задание, которого нет в заявках.
     */
    CG76: '{{task5_line}}',
    CG77: '{{task6_line}}',
    CG78: '{{task7_line}}',
  },
  // Строка задания идёт во всю ширину блока и в одну строку не встаёт; стиль бланка перенос не
  // несёт — без флага хвост срезался бы по границе объединения.
  wrap: ['CG76', 'CG77', 'CG78'],
  // Графа диспетчера: сама подпись «Диспетчер» (A34), линия для фамилии (AD34) и подписи под ней
  // (N35, AD35). Строка выше — «Водительское удостоверение проверил, задание выдал, выдать
  // горючего ___ литр» — остаётся: её заполняют от руки, как одометр и остатки топлива.
  clear: ['A34', 'AD34', 'N35', 'AD35'],
};

/**
 * Форма № 3 (легковой автомобиль). Выписывается на заявку-грузоперевозку, взятую в работу
 * легковой машиной: тип «Легковые автомобили» стоит под видом ТС «Грузоперевозки», и отдельного
 * входа выдачи ему не понадобилось.
 *
 * Серии и номера в бланке нет вовсе, поэтому они пишутся в свободную строку под заголовком.
 * Задание же печатается на обороте: лицевая сторона держит только «Адрес подачи», а маршрут
 * рейса — таблица «Место отправления / назначения, время убытия, груз, заказчик».
 */
const FORM_LEG3: Blank = {
  source: 'пут.лист легков..xlsx',
  out: 'waybill-leg3.xlsx',
  // Вдвое уже 4-П (88 колонок) и на треть длиннее — ложится на портретный лист.
  orientation: 'portrait',
  cells: {
    Q8: 'Серия {{waybill_series}}   № {{waybill_number}}   от {{waybill_date}}',
    M11: '{{org_name}}',
    A12: '{{org_address}}, тел. {{org_phone}}',
    BW12: '{{org_okpo}}',
    M14: '{{vehicle_brand}}',
    X16: '{{vehicle_reg_number}}',
    BW16: '{{vehicle_garage_number}}',
    M18: '{{driver_fio}}',
    BW18: '{{vehicle_inventory_number}}',
    N20: '{{driver_license_number}}',
    M22: '{{driver_license_issued_on}}',
    M24: '{{driver_snils}}',
    N27: '{{customer_name}}, {{customer_address}}',
    // «Вид сообщения:» — подпись занимает объединение A31:P31, линия идёт следом. «Вид перевозки»
    // не размечается: «коммерческая» впечатана в бланк типографией.
    Q31: '{{communication_kind}}',
    /*
     * Оборотная сторона: задание рейса построчно. Таблица разграфлена и пронумерована самим
     * бланком на десять строк, и размечены все десять — столько заявок держит маршрут легкового
     * (`ROUTE_REQUEST_CAPACITY.leg3`, ADR 0068). Ни талонов, ни доп. задания в этой форме нет:
     * все строки равноправны и заполняются одними и теми же графами.
     *
     * Каждая строка задания — это две строки листа (объединения вида H61:AA62), поэтому шаг по
     * таблице через одну: 61, 63, 65, 67, 69, 71, 73, 75, 77, 79. Адреса — левые верхние углы
     * объединений.
     */
    H61: '{{task_from}}',
    AB61: '{{task_to}}',
    // Часы и минуты убытия — две отдельные графы, одной строкой «08:30» их не заполнить.
    AU61: '{{task_departure_hh}}',
    BA61: '{{task_departure_mm}}',
    BG61: '{{task_cargo}}',
    BY61: '{{customer_name}}',
    H63: '{{task2_from}}',
    AB63: '{{task2_to}}',
    BG63: '{{task2_cargo}}',
    BY63: '{{task2_customer}}',
    H65: '{{task3_from}}',
    AB65: '{{task3_to}}',
    BG65: '{{task3_cargo}}',
    BY65: '{{task3_customer}}',
    H67: '{{task4_from}}',
    AB67: '{{task4_to}}',
    BG67: '{{task4_cargo}}',
    BY67: '{{task4_customer}}',
    H69: '{{task5_from}}',
    AB69: '{{task5_to}}',
    BG69: '{{task5_cargo}}',
    BY69: '{{task5_customer}}',
    H71: '{{task6_from}}',
    AB71: '{{task6_to}}',
    BG71: '{{task6_cargo}}',
    BY71: '{{task6_customer}}',
    H73: '{{task7_from}}',
    AB73: '{{task7_to}}',
    BG73: '{{task7_cargo}}',
    BY73: '{{task7_customer}}',
    H75: '{{task8_from}}',
    AB75: '{{task8_to}}',
    BG75: '{{task8_cargo}}',
    BY75: '{{task8_customer}}',
    H77: '{{task9_from}}',
    AB77: '{{task9_to}}',
    BG77: '{{task9_cargo}}',
    BY77: '{{task9_customer}}',
    H79: '{{task10_from}}',
    AB79: '{{task10_to}}',
    BG79: '{{task10_cargo}}',
    BY79: '{{task10_customer}}',
  },
  // Графа диспетчера — та же, что в 4-П: подпись, линия для фамилии и подписи под ней.
  clear: ['A39', 'AA39', 'Q40', 'AA40'],
};

/**
 * Форма ЭСМ-2 (строительная машина). Единственный бланк, который выписывается не на рейс, а на
 * неделю работы машины на площадке: семь строк «пн…вс», недельные итоги и оборотная сторона
 * «Заполняется заказчиком».
 *
 * Исходник прислан в `.xls` (BIFF8) — `unzipSync` на нём падает, поэтому рядом лежит `СДМ.xlsx`,
 * полученный из него LibreOffice:
 *
 *   soffice --headless --convert-to xlsx --outdir templates/source templates/source/СДМ.xls
 *
 * Заменит бухгалтерия бланк — конвертацию придётся повторить; у двух прежних форм этой ступени
 * нет, они пришли готовыми `.xlsx`.
 */
const FORM_ESM2: Blank = {
  source: 'СДМ.xlsx',
  out: 'waybill-esm2.xlsx',
  // 86 колонок шириной 208 знаков; разрыв строк после 98-й делит книгу на лицевую и оборот.
  orientation: 'landscape',
  cells: {
    // Шапка: номер сразу за заголовком «ПУТЕВОЙ ЛИСТ», дата — на линии за «от» и тремя клетками
    // «Дата составления» (день, месяц, год порознь).
    AM3: '№ {{waybill_series}}{{waybill_number}}',
    BH2: '{{waybill_date}}',
    BV4: '{{waybill_date_dd}}',
    BY4: '{{waybill_date_mm}}',
    CC4: '{{waybill_date_yyyy}}',
    H5: '{{org_name}}, {{org_address}}, тел. {{org_phone}}',
    BV5: '{{org_okpo}}',
    // Заказчик — объект строительства заявки. Клетка «по ОКПО» заказчика остаётся пустой: у
    // площадки нет ни ОКПО, ни своего телефона организации — есть телефон ответственного.
    H7: '{{customer_name}}, {{customer_address}}, тел. {{customer_phone}}',
    // Марка/модель машины из справочника (ADR 0007). Графа — объединение H9:Z9 в 39 знаков, а
    // длину наименования выбирает не бланк, а справочник: см. `shrink` ниже.
    H9: '{{vehicle_brand}}',
    AO9: '{{vehicle_reg_number}}',
    // Машинист: ФИО и табельный номер — и всё. СНИЛС и водительского удостоверения в бланке нет:
    // машинист работает по удостоверению тракториста-машиниста, которого портал не ведёт.
    H11: '{{driver_fio}}',
    BE11: '{{object_code}}',
    /*
     * «Период работы: с __ по __ месяца __ года __» — фактические дни недели, а не понедельник с
     * воскресеньем. Клетка «по» состоит из двух ячеек: `BJ11` не размечается, иначе число
     * печатается вторым рядом с первым («09 99»). Месяц один на графу — у недели через границу
     * месяца туда идёт «08–09» (объединение BK11:BO11 шириной 13 знаков это держит).
     */
    BH11: '{{period_from_day}}',
    BI11: '{{period_to_day}}',
    BK11: '{{period_month}}',
    BP11: '{{period_year}}',
    // Инвентарный номер машины. Соседняя клетка «Машина: марка» (`BV11`) не размечается: восемь
    // знаков ширины, и «JCB 3CX» налезает на инвентарный номер — а марка уже напечатана строкой
    // «Машина» выше.
    BY11: '{{vehicle_inventory_number}}',
    // Табельный номер начинается с `CD11`: `CC11` шириной 0,65 знака обрезает текст.
    CD11: '{{driver_personnel_no}}',
    /*
     * Семь строк недели, шаг — четыре строки листа. Число месяца печатается вместе с подписью дня
     * («пн 31»): «пн»…«вс» впечатаны бланком, а объединение C19:C22 — одна ячейка, и дописать
     * число второй клеткой некуда. Объект — только в дни внутри срока заявки; в остальные графа
     * остаётся пустой, потому что портал не знает, работала ли машина в субботу.
     */
    C19: 'пн {{day1_date}}',
    D19: '{{day1_object}}',
    C23: 'вт {{day2_date}}',
    D23: '{{day2_object}}',
    C27: 'ср {{day3_date}}',
    D27: '{{day3_object}}',
    C31: 'чт {{day4_date}}',
    D31: '{{day4_object}}',
    C35: 'пт {{day5_date}}',
    D35: '{{day5_object}}',
    C39: 'сб {{day6_date}}',
    D39: '{{day6_object}}',
    C43: 'вс {{day7_date}}',
    D43: '{{day7_object}}',
    // Оборот заполняет заказчик — часы, простои, стоимость машино-часа и штамп. Портал печатает
    // там только числа месяца, чтобы не гадать, какая это неделя.
    B106: 'пн {{day1_date}}',
    B110: 'вт {{day2_date}}',
    B114: 'ср {{day3_date}}',
    B118: 'чт {{day4_date}}',
    B122: 'пт {{day5_date}}',
    B126: 'сб {{day6_date}}',
    B130: 'вс {{day7_date}}',
  },
  /*
   * ФИО начальника отдела автотехники, впечатанное над линией «(расшифровка подписи)». Стирается
   * тем же решением, что и графа диспетчера в двух прежних бланках: напечатанная рядом с пустой
   * линией фамилия читается как подпись, которой нет. Сама должность остаётся — её подписывает
   * человек, а не портал.
   */
  clear: ['BT141'],
  /*
   * Вторая строка заголовка — «строительной машины» — набрана в объединении двух узких клеток
   * (AI4:AJ4 шириной 4 знака). В объединении текст режется по его границе, и на бумаге от
   * подписи оставалось «нс»: так печатается и присланный бухгалтерией исходник, ещё до разметки.
   * Без объединения текст переполняет пустых соседей и печатается целиком.
   */
  unmerge: ['AI4:AJ4'],
  // Переполнение расходится от той клетки, где текст лежит, — а лежал он правее середины, и
  // подзаголовок вставал не под «ПУТЕВОЙ ЛИСТ», а сдвинутым вправо. AC4 — клетка, чья середина
  // приходится на середину заголовка (объединение T2:AL3).
  move: { AI4: 'AC4' },
  /*
   * «Машина (наименование, марка)»: наименование приходит из справочника марок и бывает длиннее
   * графы («Автокран КС-45719-1Р»), а печатает портал через LibreOffice — он по этому флагу
   * подбирает кегль под ширину. Без флага объединение молча срезает хвост наименования, и
   * заказчик получает лист с машиной без марки.
   */
  shrink: ['H9'],
};

const COL = /^([A-Z]+)(\d+)$/;

function colNumber(ref: string): number {
  const letters = COL.exec(ref)![1]!;
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** Ячейка листа целиком: `$1` — её атрибуты без `r`, `$2` — содержимое (у пустой его нет). */
function cellRe(address: string): RegExp {
  return new RegExp(`<c r="${address}"((?:(?!/>|>)[\\s\\S])*)(?:/>|>([\\s\\S]*?)</c>)`);
}

/** Стиль ячейки: он несёт шрифт, выравнивание и линию графы — терять его при правке нельзя. */
function styleOf(attrs: string): string {
  const style = /\ss="(\d+)"/.exec(attrs);
  return style ? ` s="${style[1]}"` : '';
}

/** Кладёт готовую ячейку на её место в листе — вместо прежней либо между соседями по колонкам. */
function putCell(sheet: string, address: string, cell: string): string {
  const existing = cellRe(address).exec(sheet);
  if (existing) return sheet.replace(existing[0], cell);

  // Ячейки в строке нет — вставляем в порядке колонок: Excel требует возрастающего порядка.
  const row = COL.exec(address)![2]!;
  const rowRe = new RegExp(`(<row r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const found = rowRe.exec(sheet);
  if (!found) throw new Error(`В листе нет строки ${row} — проверьте адрес ${address}`);

  const body = found[2]!;
  const target = colNumber(address);
  const cells = [...body.matchAll(/<c r="([A-Z]+\d+)"[\s\S]*?(?:\/>|<\/c>)/g)];
  const next = cells.find((m) => colNumber(m[1]!) > target);
  const patched = next ? body.replace(next[0], `${cell}${next[0]}`) : `${body}${cell}`;
  return sheet.replace(found[0], `${found[1]}${patched}${found[3]}`);
}

/**
 * Вписывает значение в ячейку листа. Стиль ячейки сохраняется: он несёт шрифт, выравнивание и
 * линию графы — потеряв его, значение выпало бы из бланка.
 */
function setCell(sheet: string, address: string, value: string): string {
  const text = `<is><t xml:space="preserve">${escapeXml(value)}</t></is>`;
  const s = styleOf(cellRe(address).exec(sheet)?.[1] ?? '');
  return putCell(sheet, address, `<c r="${address}"${s} t="inlineStr">${text}</c>`);
}

/**
 * Стирает содержимое ячейки, оставляя её саму и её стиль: рамка, линия графы и высота строки —
 * часть вёрстки бланка, и удалять ячейку целиком нельзя.
 *
 * Текст подписей живёт в общем словаре книги (`sharedStrings.xml`), и вырезать его оттуда значит
 * сбить индексы всех прочих строк бланка. Поэтому очищается ссылка: строка в словаре остаётся, но
 * на неё больше не смотрит ни одна ячейка листа.
 */
function clearCell(sheet: string, address: string): string {
  const found = cellRe(address).exec(sheet);
  if (!found) throw new Error(`Ячейки ${address} в листе нет — стирать нечего, проверьте адрес`);

  return sheet.replace(found[0], `<c r="${address}"${styleOf(found[1] ?? '')} />`);
}

/**
 * Снимает объединение ячеек, оставляя сами ячейки и их стили.
 *
 * Объединение — это не только внешний вид: текст в нём не переполняет соседей, а обрезается по
 * границе. Подпись, набранная бухгалтерией в двух узких клетках, печатается из-за этого огрызком —
 * и в самом бланке, и в PDF портала. Расширить объединение нельзя: содержимое показывает только
 * его левая верхняя ячейка, а текст всё равно резался бы, только по другой границе.
 */
function unmergeCells(sheet: string, ref: string): string {
  const merge = new RegExp(`<mergeCell ref="${ref}"\\s*/>`);
  if (!merge.test(sheet)) throw new Error(`В листе нет объединения ${ref} — снимать нечего`);

  // `count` в заголовке списка обязан сойтись с числом объединений: Excel считает книгу
  // повреждённой, а не пересчитывает молча.
  const patched = sheet.replace(merge, '');
  return patched.replace(
    /<mergeCells count="(\d+)">/,
    (_, count: string) => `<mergeCells count="${Number(count) - 1}">`,
  );
}

/**
 * Переносит содержимое ячейки в другую вместе со стилем: та несёт шрифт и выравнивание, без
 * которых подпись легла бы в бланк чужим кеглем.
 *
 * Нужен там, где снятое объединение вернуло тексту переполнение: расходится оно от той клетки, где
 * текст лежит, и подпись встаёт по её середине, а не по середине графы.
 */
function moveCell(sheet: string, from: string, to: string): string {
  const found = cellRe(from).exec(sheet);
  if (!found?.[2]) throw new Error(`Ячейка ${from} пуста — переносить в ${to} нечего`);

  const attrs = (found[1] ?? '').trim();
  const moved = `<c r="${to}"${attrs ? ` ${attrs}` : ''}>${found[2]}</c>`;
  return putCell(clearCell(sheet, from), to, moved);
}

/** Правка выравнивания графы: чем правится стиль и как называется в сообщении об ошибке. */
interface Restyle {
  /** Флаги выравнивания, которые получает копия стиля. */
  flags: Record<string, string>;
  /** Что делаем с графой: «ужимать», «переносить» — идёт в текст ошибки. */
  what: string;
}

/** Текст ужимается по ширине графы: кегль подбирается под длину значения. */
const SHRINK: Restyle = { flags: { shrinkToFit: 'true' }, what: 'ужимать' };

/**
 * Текст переносится по словам и прижимается к верху графы. Верх, а не середина: перенесённая
 * вторая строка обязана лечь ниже первой, а не раздвинуть её от середины за границы строки листа.
 */
const WRAP: Restyle = { flags: { wrapText: 'true', vertical: 'top' }, what: 'переносить' };

/** Стоят ли флаги правки в записи стиля — тогда копию заводить незачем. */
function alreadyRestyled(xf: string, flags: Record<string, string>): boolean {
  return Object.entries(flags).every(([name, value]) =>
    new RegExp(`${name}="${value === 'true' ? '(1|true)' : value}"`).test(xf),
  );
}

/**
 * Флаги выравнивания в записи стиля. Правится сам `<alignment>`, а не запись целиком: в `<xf>`
 * лежат ещё шрифт, рамка и числовой формат графы.
 *
 * `applyAlignment` включается вместе с флагами: без него Excel читает выравнивание не из стиля
 * ячейки, а из именованного, и правка тихо пропадает.
 */
function withAlignment(xf: string, flags: Record<string, string>): string {
  const applied = /applyAlignment="/.test(xf)
    ? xf.replace(/applyAlignment="[^"]*"/, 'applyAlignment="true"')
    : xf.replace('<xf ', '<xf applyAlignment="true" ');

  return Object.entries(flags).reduce(
    (patched, [name, value]) =>
      new RegExp(`\\s${name}="`).test(patched)
        ? patched.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`)
        : patched.replace('<alignment ', `<alignment ${name}="${value}" `),
    applied,
  );
}

/**
 * Переводит графу на копию её стиля с поправленным выравниванием.
 *
 * Нужно там, где длину значения выбирает не бланк: наименование приходит из справочника, задание
 * рейса — из заявки. Готового стиля с нужными флагами в книге нет, а править чужой нельзя — один
 * стиль в бланке носят десятки ячеек, и ужиматься (или переноситься) начали бы все. Поэтому в
 * конец таблицы стилей дописывается копия нужного, и ячейка переводится на неё.
 *
 * Печатает бланк LibreOffice: по этим флагам он подбирает кегль под ширину графы и переносит
 * длинную строку. Без них лишнее молча обрезается по границе объединения — на экране бланк
 * выглядит верным, на бумаге нет.
 */
function restyleCell(
  sheet: string,
  styles: string,
  address: string,
  how: Restyle,
): { sheet: string; styles: string } {
  const found = cellRe(address).exec(sheet);
  if (!found) throw new Error(`Ячейки ${address} в листе нет — ${how.what} нечего`);

  const table = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(styles);
  if (!table) throw new Error(`В книге нет таблицы стилей ячеек — ${how.what} графу нечем`);
  const xfs = table[2]!.match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];

  const current = Number(/\ss="(\d+)"/.exec(found[1] ?? '')?.[1] ?? 0);
  const base = xfs[current];
  if (!base) throw new Error(`Стиля ${current} ячейки ${address} в книге нет`);
  if (alreadyRestyled(base, how.flags)) return { sheet, styles };

  const patched = withAlignment(base, how.flags);
  if (!alreadyRestyled(patched, how.flags)) {
    throw new Error(`У стиля ${current} нет выравнивания — флаги графы ${address} вписать некуда`);
  }

  // Остальные атрибуты ячейки остаются как были: в них тип значения, и потеряв его, лист
  // напечатал бы вместо наименования пустоту.
  const attrs = (found[1] ?? '').trim();
  const restyled = /\ss="\d+"/.test(found[1] ?? '')
    ? attrs.replace(/s="\d+"/, `s="${xfs.length}"`)
    : `s="${xfs.length}"${attrs ? ` ${attrs}` : ''}`;

  return {
    sheet: sheet.replace(
      found[0],
      found[2] === undefined
        ? `<c r="${address}" ${restyled} />`
        : `<c r="${address}" ${restyled}>${found[2]}</c>`,
    ),
    styles: styles.replace(
      table[0],
      `<cellXfs count="${xfs.length + 1}">${table[2]}${patched}</cellXfs>`,
    ),
  };
}

/**
 * Параметры печати листа (ADR 0041).
 *
 * Бланки приходят из бухгалтерии без `pageSetup`: в Excel их печатали руками, подгоняя масштаб в
 * диалоге печати. Без него лист печатается портретным в 100%, и бланк 4-П расползается на четыре
 * страницы вместо двух — разрезанным и по ширине, и по высоте. Разрывы страниц в самом бланке
 * расставлены (`rowBreaks`, `colBreaks`), то есть замысел известен: страница — это лицевая
 * сторона и оборот. Здесь этот замысел лишь записывается так, чтобы его понимали и Excel, и
 * конвертер в PDF.
 *
 * `fitToHeight="0"` — «по ширине на страницу, в высоту сколько получится»: иначе обе стороны
 * бланка сжались бы в один лист. Поля сведены к 5 мм: при подгонке по ширине дюймовые поля
 * оригинала съедают масштаб, а вместе с ним и читаемость мелких граф.
 *
 * Бланк, прошедший через LibreOffice (ЭСМ-2, Р1), приходит уже со своими параметрами печати —
 * и оба места приходится не дополнять, а переписывать. Второй `<pageSetup>` рядом с имеющимся
 * схеме листа противоречит, а `fitToPage="false"` в `sheetPr` — это выключенная подгонка, а не
 * её отсутствие: приняв атрибут за признак «уже настроено», портал печатал бы ЭСМ-2 на восьми
 * страницах вместо двух. Ни то ни другое не падает — оно молча расползается по бумаге.
 */
function setPageSetup(sheet: string, orientation: Blank['orientation']): string {
  const setup = `<pageSetup paperSize="9" orientation="${orientation}" fitToWidth="1" fitToHeight="0" />`;
  const margins =
    '<pageMargins left="0.2" right="0.2" top="0.2" bottom="0.2" header="0" footer="0" />';

  let patched = sheet.replace(/<pageMargins[^>]*>/, margins);
  if (patched === sheet) throw new Error('В листе нет <pageMargins> — некуда вписать pageSetup');
  patched = /<pageSetup[^>]*>/.test(patched)
    ? patched.replace(/<pageSetup[^>]*>/, setup)
    : patched.replace(margins, `${margins}${setup}`);

  // Подгонка включается флагом в `sheetPr`: без него `fitToWidth` в файле есть, а Excel печатает
  // по-старому в 100%.
  if (/<pageSetUpPr[^>]*fitToPage="(1|true)"/.test(patched)) return patched;
  patched = /<pageSetUpPr[^>]*fitToPage=/.test(patched)
    ? patched.replace(/(<pageSetUpPr[^>]*fitToPage=)"[^"]*"/, '$1"1"')
    : patched.replace(/<pageSetUpPr([^>]*?)\/>/, '<pageSetUpPr$1 fitToPage="1" />');
  if (!/fitToPage="1"/.test(patched)) {
    throw new Error('В листе нет <pageSetUpPr /> — подгонку по ширине включить нечем');
  }
  return patched;
}

/**
 * Убирает из бланка эмблему организации — растровую картинку в левом верхнем углу.
 *
 * Бланк — типовая межотраслевая форма, и логотипа в ней нет: он попал в файлы вместе с чужой
 * вёрсткой, которой бухгалтерия печатала листы у себя. Оставаясь на бумаге, он выдаёт документ за
 * фирменный, а форма от этого перестаёт быть той, что утверждена постановлением.
 *
 * Вычёркивается всё вместе — сама картинка, её якорь и связь с ним: осиротевшая ссылка на
 * несуществующую часть архива делает книгу повреждённой, и её не откроет ни Excel, ни конвертер.
 * Прочие фигуры рисунка остаются: в ЭСМ-2 ими нарисован сам бланк — рамки клеток недельной
 * таблицы, и вырезав их, портал напечатал бы форму без разлиновки.
 */
function dropPictures(files: Record<string, Uint8Array>): void {
  const read = (name: string): string => new TextDecoder().decode(files[name]!);
  const write = (name: string, xml: string): void => {
    files[name] = new TextEncoder().encode(xml);
  };

  for (const name of Object.keys(files)) {
    if (name.startsWith('xl/media/')) delete files[name];
  }

  for (const name of Object.keys(files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(name)) continue;
    const rels = name.replace(/^xl\/drawings\//, 'xl/drawings/_rels/') + '.rels';
    const drawing = read(name).replace(
      /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)[\s\S]*?<\/xdr:\1>/g,
      (anchor) => (anchor.includes('<xdr:pic') ? '' : anchor),
    );

    if (/<xdr:(twoCell|oneCell|absolute)Anchor/.test(drawing)) {
      write(name, drawing);
      if (files[rels]) {
        write(rels, read(rels).replace(/<Relationship [^>]*relationships\/image[^>]*\/>/g, ''));
      }
      continue;
    }

    // Рисунок состоял из одной эмблемы — вычёркиваем его целиком, вместе со ссылкой листа.
    delete files[name];
    delete files[rels];
    write(
      '[Content_Types].xml',
      read('[Content_Types].xml').replace(new RegExp(`<Override PartName="/${name}"[^>]*/>`), ''),
    );
    for (const relsName of Object.keys(files)) {
      if (!/^xl\/worksheets\/_rels\/.+\.rels$/.test(relsName)) continue;
      const link = new RegExp(
        `<Relationship Id="([^"]+)"[^>]*${name.replace('xl/', '../')}"[^>]*/>`,
      );
      const found = link.exec(read(relsName));
      if (!found) continue;
      write(relsName, read(relsName).replace(found[0], ''));
      const sheetName = relsName.replace('/_rels/', '/').replace(/\.rels$/, '');
      write(
        sheetName,
        read(sheetName).replace(new RegExp(`<drawing r:id="${found[1]}"\\s*/>`), ''),
      );
    }
  }
}

function mark(blank: Blank): void {
  const files = unzipSync(new Uint8Array(readFileSync(join(templatesDir, 'source', blank.source))));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const stylesPath = 'xl/styles.xml';
  let sheet = new TextDecoder().decode(files[sheetPath]!);
  let styles = new TextDecoder().decode(files[stylesPath]!);

  // Сперва правки самой формы, потом значения портала: адреса в `cells` — это адреса бланка,
  // каким он уходит на печать, а не каким пришёл.
  for (const ref of blank.unmerge ?? []) sheet = unmergeCells(sheet, ref);
  for (const [from, to] of Object.entries(blank.move ?? {})) sheet = moveCell(sheet, from, to);
  for (const [address, value] of Object.entries(blank.cells)) {
    sheet = setCell(sheet, address, value);
  }
  for (const address of blank.clear ?? []) sheet = clearCell(sheet, address);
  for (const address of blank.shrink ?? [])
    ({ sheet, styles } = restyleCell(sheet, styles, address, SHRINK));
  for (const address of blank.wrap ?? [])
    ({ sheet, styles } = restyleCell(sheet, styles, address, WRAP));
  sheet = setPageSetup(sheet, blank.orientation);

  files[sheetPath] = new TextEncoder().encode(sheet);
  files[stylesPath] = new TextEncoder().encode(styles);
  dropPictures(files);
  // Время фиксировано: одинаковый исходник обязан давать одинаковый шаблон.
  writeFileSync(join(templatesDir, blank.out), zipSync(files, { mtime: Date.UTC(1980, 0, 1) }));
  const cleared = blank.clear?.length ? `, стёрто ${blank.clear.length}` : '';
  const shrunk = blank.shrink?.length ? `, ужато ${blank.shrink.length}` : '';
  const wrapped = blank.wrap?.length ? `, с переносом ${blank.wrap.length}` : '';
  console.log(
    `${blank.out}: размечено граф ${Object.keys(blank.cells).length}${cleared}${shrunk}${wrapped}`,
  );
}

for (const blank of [FORM_4P, FORM_LEG3, FORM_ESM2]) mark(blank);
