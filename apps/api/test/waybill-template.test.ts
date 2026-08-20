import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { TASK_ROW_GEOMETRY, TASK_ROW_LINES, WAYBILL_SNAPSHOT_KEYS } from '@technic/contracts';
import { inspectTemplate, renderOfficeTemplate } from '../src/services/office-template';
import { BOX, LINE, mergeCells, unborderCells } from '../scripts/mark-waybill-templates';

/**
 * Согласованность бланка и сборщика значений (ADR 0037 п. 10).
 *
 * Бланки пришли от бухгалтерии готовыми; портал только вписывает в них плейсхолдеры
 * (`scripts/mark-waybill-templates.ts`). Разъехавшись со сборщиком, разметка не ломает ни
 * типизацию, ни ревью: лист молча напечатается с пустой графой вместо СНИЛС, и заметит это
 * только тот, кто возьмёт бумагу в руки. Поэтому набор плейсхолдеров сверяется тестом.
 */

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** Код формы = имя файла: `vehicle_types.waybill_form_code` выбирает бланк по нему. */
const FORMS = ['4p', 'leg3', 'esm2'] as const;

function template(form: (typeof FORMS)[number]): Uint8Array {
  return new Uint8Array(readFileSync(join(templatesDir, `waybill-${form}.xlsx`)));
}

const decoder = new TextDecoder();

/**
 * Словарь строк книги. Текст ячейки xlsx хранит не в самой ячейке: `<c t="s"><v>5</v></c>` — это
 * ссылка на пятую запись `sharedStrings.xml`, и надпись бланка приходится искать по индексу.
 */
function dictionaryOf(strings: string): string[] {
  return [...strings.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''),
  );
}

/** Адреса ячеек листа, которые ссылаются на эту запись словаря. */
function cellsWithString(sheet: string, index: number): string[] {
  return [
    ...sheet.matchAll(new RegExp(`<c r="([A-Z]+\\d+)"[^>]*t="s"[^>]*><v>${index}</v></c>`, 'g')),
  ].map(([, ref]) => ref!);
}

/**
 * Запись стиля ячейки. Оформление живёт не в ячейке: ячейка держит номер стиля, а рамка, шрифт и
 * выравнивание графы описаны в нём.
 */
function xfOf(files: Record<string, Uint8Array>, address: string): string {
  const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
  const styles = decoder.decode(files['xl/styles.xml']!);
  const cell = new RegExp(`<c r="${address}"((?:(?!/>|>)[\\s\\S])*)`).exec(sheet);
  expect(cell, `ячейки ${address} в бланке нет`).not.toBeNull();

  const xfs =
    /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/
      .exec(styles)![1]!
      .match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  return xfs[Number(/\ss="(\d+)"/.exec(cell![1]!)?.[1] ?? 0)]!;
}

/** Рамка графы целиком: в стиле записан её номер, а чем обведена ячейка — только в самой рамке. */
function borderOf(files: Record<string, Uint8Array>, address: string): string {
  const styles = decoder.decode(files['xl/styles.xml']!);
  const borders =
    /<borders count="\d+">([\s\S]*?)<\/borders>/
      .exec(styles)![1]!
      .match(/<border\b[^>]*\/>|<border\b[^>]*>[\s\S]*?<\/border>/g) ?? [];
  const borderId = Number(/borderId="(\d+)"/.exec(xfOf(files, address))?.[1] ?? 0);
  return borders[borderId]!;
}

/** Есть ли у ячейки линия графы: в стиле записан номер рамки, и только в рамке — чем она обведена. */
function bottomBorderOf(files: Record<string, Uint8Array>, address: string): boolean {
  return /<bottom style=/.test(borderOf(files, address));
}

/** Стороны рамки, которыми обведена ячейка: у графы без обводки список пуст. */
const BORDER_SIDES = ['left', 'right', 'top', 'bottom'] as const;
function sidesOf(files: Record<string, Uint8Array>, address: string): string[] {
  const border = borderOf(files, address);
  return BORDER_SIDES.filter((side) => new RegExp(`<${side} style=`).test(border));
}

/**
 * Содержимое ячейки листа: у пустой его нет вовсе (`<c r="A1" s="7" />`). Атрибуты читаются
 * нежадно — жадный кусок съедает косую черту самозакрытия, и пустая ячейка прикидывается
 * открывающим тегом, а поиск уезжает на содержимое следующей.
 */
function bodyOf(sheet: string, address: string): string {
  return new RegExp(`<c r="${address}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet)?.[1] ?? '';
}

/** Шрифт графы: в стиле записан его номер, а кегль с начертанием — в самой записи шрифта. */
function fontOf(files: Record<string, Uint8Array>, address: string): string {
  const styles = decoder.decode(files['xl/styles.xml']!);
  const fonts =
    /<fonts count="\d+"[^>]*>([\s\S]*?)<\/fonts>/
      .exec(styles)![1]!
      .match(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g) ?? [];
  return fonts[Number(/fontId="(\d+)"/.exec(xfOf(files, address))?.[1] ?? 0)]!;
}

/** Высота строки листа в пунктах. */
function rowHeightOf(files: Record<string, Uint8Array>, row: number): number {
  const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
  const found = new RegExp(`<row r="${row}"[^>]*>`).exec(sheet);
  expect(found, `строки ${row} в бланке нет`).not.toBeNull();
  return Number(/\sht="([\d.]+)"/.exec(found![0])?.[1] ?? 0);
}

/** Адрес ячейки: `AI4` → колонка 35, строка 4. Колонки пронумерованы буквами по основанию 26. */
const colNumber = (ref: string): number =>
  [.../^([A-Z]+)/.exec(ref)![1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const rowNumber = (ref: string): number => Number(/(\d+)$/.exec(ref)![1]);

interface Merge {
  from: string;
  to: string;
}

function mergesOf(sheet: string): Merge[] {
  return [...sheet.matchAll(/mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map(([, from, to]) => ({
    from: from!,
    to: to!,
  }));
}

/** Накрывает ли объединение этот адрес — считая и собственный левый верхний угол. */
function covers(merge: Merge, ref: string): boolean {
  return (
    rowNumber(merge.from) <= rowNumber(ref) &&
    rowNumber(ref) <= rowNumber(merge.to) &&
    colNumber(merge.from) <= colNumber(ref) &&
    colNumber(ref) <= colNumber(merge.to)
  );
}

describe('разметка бланков', () => {
  it.each(FORMS)('в бланке %s нет графы, которой не собирает сервер', (form) => {
    const inTemplate = inspectTemplate(template(form));
    const known = new Set<string>(WAYBILL_SNAPSHOT_KEYS);

    expect(inTemplate.length).toBeGreaterThan(10);
    expect(inTemplate.filter((key) => !known.has(key))).toEqual([]);
  });

  it('в 4-П размечены реквизиты, без которых лист недействителен', () => {
    const inTemplate = new Set(inspectTemplate(template('4p')));
    // Приказ Минтранса № 390; СНИЛС водителя — с 01.03.2023.
    for (const key of [
      'org_name',
      'org_okpo',
      'waybill_series',
      'waybill_number',
      'waybill_date',
      'vehicle_brand',
      'vehicle_reg_number',
      'driver_fio',
      'driver_snils',
      'driver_license_number',
      'driver_license_issued_on',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  /**
   * Графа диспетчера стёрта из обоих бланков: портал документ не подписывает, а напечатанная
   * рядом с пустой линией фамилия читается как подпись, которой нет.
   *
   * Проверяется по ячейкам, а не по словарю книги: строка «Диспетчер» остаётся в
   * `sharedStrings.xml` — вырезать её оттуда значит сбить индексы всех прочих строк бланка, —
   * но ссылаться на неё не должна ни одна ячейка листа.
   */
  // Графа диспетчера есть только у листов на рейс: ЭСМ-2 выписывается не на поездку, и подписей
  // выезда в нём нет вовсе — у него стёрта своя строка (см. тест ниже).
  it.each(['4p', 'leg3'] as const)(
    'в бланке %s нет графы диспетчера — ни ячейкой, ни плейсхолдером',
    (form) => {
      const files = unzipSync(template(form));
      const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);

      const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));
      const dispatcher = dictionary.flatMap((text, index) =>
        text.trim() === 'Диспетчер' ? [index] : [],
      );
      expect(dispatcher.length, 'подпись «Диспетчер» пропала из словаря книги').toBeGreaterThan(0);

      for (const index of dispatcher) {
        expect(sheet).not.toMatch(
          new RegExp(`<c r="[A-Z]+\\d+"[^>]*t="s"[^>]*><v>${index}</v></c>`),
        );
      }
      expect(inspectTemplate(template(form))).not.toContain('dispatcher_fio');
    },
  );

  /**
   * Блок выдачи задания под таблицей 4-П убран целиком (ADR 0071): две строки подписи
   * «Водительское удостоверение проверил, / задание выдал, выдать горючего ___ литр» и линии под
   * ними — под горючее, под подпись диспетчера и под её расшифровку.
   *
   * Проверяются обе половины: текст и линия. Стёртая подпись без снятой линии оставляет на бумаге
   * пустую черту во всю ширину графы — то есть блок, который выглядит как незаполненный, а не как
   * убранный, и в него что-нибудь впишут.
   */
  it('в 4-П убран блок выдачи задания — вместе с линиями под ним', () => {
    const files = unzipSync(template('4p'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));

    for (const caption of [
      'Водительское удостоверение проверил,',
      'задание выдал, выдать горючего',
      'литр',
    ]) {
      const indexes = dictionary.flatMap((text, index) => (text.trim() === caption ? [index] : []));
      expect(indexes.length, `подпись «${caption}» пропала из словаря книги`).toBeGreaterThan(0);
      for (const index of indexes) {
        expect(cellsWithString(sheet, index), caption).toEqual([]);
      }
    }

    // Линии графы: под горючее (Y33:BB33), под подпись диспетчера (N34:AA34) и её расшифровку
    // (AD34:BB34). Правее по тем же строкам идут линии возврата машины — их заполняет механик, и
    // тронуть их разметка не имеет права: стиль у них тот же самый.
    for (const address of ['Y33', 'AA33', 'BB33', 'N34', 'AA34', 'AD34', 'BB34']) {
      expect(bottomBorderOf(files, address), address).toBe(false);
    }
    for (const address of ['DR32', 'DY33', 'DR34', 'EH34']) {
      expect(bottomBorderOf(files, address), `${address} — линия механика`).toBe(true);
    }
  });

  /**
   * Блок «Количество отработанных часов» убран из шапки 4-П целиком: часы работы машины считает и
   * заверяет подписью заказчик на месте, портал их не знает. Стоит блок среди реквизитов, которые
   * портал печатает, и на бумаге читался его же незаполненной графой.
   *
   * Проверяются все три половины, потому что каждая остаётся на бумаге сама по себе: текст графы,
   * рамка поля (обведено со всех четырёх сторон — снятого низа тут мало, от поля осталась бы
   * распахнутая скоба) и линии подписи с расшифровкой правее.
   */
  it('в 4-П убран блок отработанных часов — вместе с рамкой поля и линиями подписи', () => {
    const files = unzipSync(template('4p'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));

    // Подпись графы: строка остаётся в словаре книги, но на неё не смотрит ни одна ячейка листа.
    const caption = dictionary.flatMap((text, index) =>
      text.trim() === 'Количество отработанных часов' ? [index] : [],
    );
    expect(caption.length, 'подпись блока пропала из словаря книги').toBeGreaterThan(0);
    for (const index of caption) expect(cellsWithString(sheet, index)).toEqual([]);

    // Подписи линий («(подпись)», «(расшифровка подписи)») по словарю не проверить: теми же
    // строками подписаны графы механика и водителя ниже. Сверяются сами ячейки блока.
    for (const address of ['CR16', 'EM17', 'EW17']) {
      expect(bodyOf(sheet, address), `${address} — ячейка убранного блока`).toBe('');
    }

    // Поле в рамке: снимается вся обводка, а не только линия графы.
    for (const address of ['DX16', 'EA16', 'EJ16']) {
      expect(sidesOf(files, address), `${address} — поле отработанных часов`).toEqual([]);
    }
    // Линии подписи и её расшифровки правее поля.
    for (const address of ['EM16', 'ET16', 'EW16', 'FJ16']) {
      expect(bottomBorderOf(files, address), address).toBe(false);
    }
    // Соседнее поле в рамке — табельный номер водителя — цело: стиль правится по ячейкам, и
    // снятая рамка не имеет права утащить за собой поля, которые бланк оставил под запись.
    expect(sidesOf(files, 'CD14'), 'рамка табельного номера').toEqual([
      'left',
      'right',
      'top',
      'bottom',
    ]);
  });

  /**
   * Расшифровка подписи водителя в обоих его блоках 4-П — «Автомобиль принял. Водитель» (DY32) и
   * «Сдал водитель» (DN37). Расшифровка — это фамилия подписавшего, водитель у листа один, и
   * портал её знает: от руки остаётся сама подпись.
   *
   * Идёт короткое имя, а не полное ФИО шапки: графа «Сдал водитель» — 14 клеток, и полное ФИО
   * переносится в ней второй строкой поверх подписи «(расшифровка подписи)» под линией.
   *
   * Графы механика рядом (EK37, ET37) проверяются пустыми: их подписывает человек, и напечатанная
   * порталом фамилия читалась бы там подписью, которой нет.
   */
  it('в 4-П расшифровки водителя размечены коротким именем, а графы механика пусты', () => {
    const sheet = decoder.decode(unzipSync(template('4p'))['xl/worksheets/sheet1.xml']!);

    for (const [address, what] of [
      ['DY32', 'автомобиль принял'],
      ['DN37', 'сдал водитель'],
    ] as const) {
      expect(bodyOf(sheet, address), `${what} (${address})`).toContain('{{driver_short_name}}');
    }
    for (const address of ['EK37', 'ET37']) {
      expect(bodyOf(sheet, address), `${address} — графа механика`).not.toContain('{{');
    }
  });

  /**
   * Тем же решением, что и графа диспетчера: в исходнике ЭСМ-2 над линией «(расшифровка подписи)»
   * впечатана фамилия начальника отдела автотехники. Напечатанная рядом с пустой линией, она
   * читается как подпись, которой нет, — и вдобавок это персональные данные живого человека в
   * публичном репозитории. Должность остаётся: её подписывает человек, а не портал.
   */
  it('в ЭСМ-2 стёрта фамилия начальника отдела: подписывает человек, а не портал', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);

    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));
    // Строка остаётся в словаре книги — вырезать её значит сбить индексы всех прочих подписей
    // бланка; проверяется, что на неё не смотрит ни одна ячейка листа.
    const surname = dictionary.flatMap((text, index) =>
      /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.$/u.test(text.trim()) ? [index] : [],
    );
    expect(surname.length, 'фамилия пропала из словаря книги — проверьте исходник').toBeGreaterThan(
      0,
    );
    for (const index of surname) {
      expect(sheet).not.toMatch(new RegExp(`<c r="[A-Z]+\\d+"[^>]*t="s"[^>]*><v>${index}</v></c>`));
    }
    // Должность на месте: стирается расшифровка подписи, а не сама графа.
    expect(dictionary.some((t) => t.includes('Начальник отдела автотехники'))).toBe(true);
  });

  /**
   * Логотип убран из всех трёх бланков. Каждый из них — типовая межотраслевая форма, утверждённая
   * постановлением Госкомстата: её вид задан самой формой, и эмблема, врисованная бухгалтерией в
   * левый верхний угол поверх готового бланка, к форме отношения не имеет.
   *
   * У 4-П и формы № 3 весь рисунок состоял из одного логотипа и удалён целиком — вместе со
   * ссылкой листа на него; у ЭСМ-2 файл рисунка остаётся, в нём прямоугольники самого бланка.
   */
  it.each(FORMS)(
    'в бланке %s нет логотипа: форма межотраслевая, эмблеме в ней не место',
    (form) => {
      const files = unzipSync(template(form));

      expect(Object.keys(files).filter((name) => name.startsWith('xl/media/'))).toEqual([]);

      const drawing = files['xl/drawings/drawing1.xml'];
      if (drawing) {
        // Рисунок оставлен ради фигур бланка: картинок в нём не должно остаться ни одной.
        const xml = decoder.decode(drawing);
        expect(xml).not.toContain('<xdr:pic');
        expect(xml).toContain('<xdr:sp');
      } else {
        // Рисунка нет — не должно остаться и ссылки на него: битая связь делает книгу
        // неоткрываемой, а набор плейсхолдеров при этом сходится и прочие проверки молчат.
        const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
        expect(sheet).not.toMatch(/<drawing\b/);
      }
    },
  );

  /**
   * ЭСМ-2 — документ на неделю работы машины, а не на поездку: в нём нет ни груза, ни задания, ни
   * граф СНИЛС и удостоверения. Проверяются обе стороны: то, без чего лист бессмысленен,
   * размечено, а графы рейса не размечены — их в бланке нет, и появление ключа означало бы, что
   * кто-то вписал значение в чужую клетку.
   */
  it('в ЭСМ-2 размечена неделя работ, и нет граф рейса', () => {
    const inTemplate = new Set(inspectTemplate(template('esm2')));
    for (const key of [
      'org_name',
      'customer_name',
      'customer_address',
      'vehicle_brand',
      'vehicle_reg_number',
      'vehicle_inventory_number',
      'driver_fio',
      'driver_personnel_no',
      'object_code',
      'period_from_day',
      'period_to_day',
      'period_month',
      'period_year',
      // Семь строк недели: по каждому дню печатается число месяца — и только оно.
      'day1_date',
      'day7_date',
      // Объект — один на лист, в шапке графы работ: лист выписан на неделю работы одной машины на
      // одной площадке (см. проверку ниже).
      'object_line',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
    for (const key of [
      /*
       * Удостоверение машиниста портал ведёт (миграция 0123, ADR 0095) и кладёт его серию с
       * номером в снимок листа — а вот граф под него и под СНИЛС форма Госкомстата не содержит.
       * Клетки здесь не размечены намеренно: маппинг бланка правкой должностей не затрагивался, и
       * это решение, а не недоделка. Значение в снимке живёт независимо от разметки — размеченная
       * клетка иначе печатала бы пустое место у листов, выданных до неё.
       */
      'driver_snils',
      'driver_license_number',
      'driver_license_issued_on',
      // Задание, груз и время выезда — графы листа на рейс.
      'task_from',
      'task_to',
      'task_cargo',
      'task_departure_time',
    ]) {
      expect(inTemplate.has(key), key).toBe(false);
    }
  });

  /**
   * Объект печатается один раз — в шапке графы работ, на обеих сторонах бланка (D13 на лицевой,
   * I102 на обороте), а не в каждом из семи дней недели. Лист выписывается на неделю работы одной
   * машины на одной площадке, и прежняя разметка повторяла один и тот же адрес семь раз подряд,
   * вытесняя из графы ту самую «выполняемую работу», ради которой заказчик её и заполняет.
   *
   * Проверяются обе стороны и обе половины: подпись бланка вокруг вставки цела (иначе графа
   * останется без имени), а строки дней разметки не несут вовсе — вернувшийся туда `{{...}}`
   * означал бы возврат к семи повторам.
   */
  it('в ЭСМ-2 объект стоит в шапках граф обеих сторон, а в днях его нет', () => {
    const sheet = decoder.decode(unzipSync(template('esm2'))['xl/worksheets/sheet1.xml']!);

    for (const [address, side] of [
      ['D13', 'лицевая'],
      ['I102', 'оборот'],
    ] as const) {
      const body = bodyOf(sheet, address);
      expect(body, `шапка графы объекта, ${side} (${address})`).toContain('{{object_line}}');
      // Подпись самого бланка вокруг вставки — на месте: объект вписан отдельной строкой под ней,
      // а не вместо неё.
      expect(body, `подпись графы, ${side}`).toContain('Наименование и адрес объекта');
      expect(body, `подпись графы, ${side}`).toContain('Выполняемая работа');
    }

    // Семь строк недели: число месяца в графе «Числа месяца» осталось, графа объекта рядом пуста.
    for (const [date, object] of [
      ['C19', 'D19'],
      ['C23', 'D23'],
      ['C27', 'D27'],
      ['C31', 'D31'],
      ['C35', 'D35'],
      ['C39', 'D39'],
      ['C43', 'D43'],
    ] as const) {
      expect(bodyOf(sheet, date), `${date} — число месяца дня`).toContain('{{');
      expect(bodyOf(sheet, object), `${object} — графа объекта дня`).not.toContain('{{');
    }
  });

  /**
   * Блок «коды объектов» — шпаргалка бухгалтерии, дописанная поверх типовой формы: подпись графы
   * набок (AL143) и три строки сокращений площадок. Код объекта портал печатает в шапке листа
   * (`object_code`), а таблица расшифровок на бумаге читается графой, которую забыли заполнить.
   *
   * Проверяется и словарь книги, и сами ячейки: строки остаются в `sharedStrings.xml` — вырезать
   * их значит сбить индексы всех прочих подписей бланка, — но смотреть на них не должна ни одна
   * ячейка листа.
   */
  it('в ЭСМ-2 нет блока кодов объектов: код листа стоит в шапке', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));

    for (const caption of ['коды объектов', 'БОТСАД', 'КНОЗ', 'ХОДЫН', 'СКЛАД']) {
      const indexes = dictionary.flatMap((text, index) => (text.trim() === caption ? [index] : []));
      expect(indexes.length, `подпись «${caption}» пропала из словаря книги`).toBeGreaterThan(0);
      for (const index of indexes) expect(cellsWithString(sheet, index), caption).toEqual([]);
    }

    // Три строки списка целиком — по ячейкам: словарь ловит только те коды, что перечислены выше.
    for (const row of [144, 145, 146]) {
      for (const column of ['AP', 'AT', 'AW', 'AZ', 'BD', 'BG']) {
        expect(bodyOf(sheet, `${column}${row}`), `${column}${row} — код объекта`).toBe('');
      }
    }
    expect(bodyOf(sheet, 'AL143'), 'подпись блока кодов').toBe('');
  });

  it('в 4-П размечено задание водителю: по нему лист и выписывают', () => {
    const inTemplate = new Set(inspectTemplate(template('4p')));
    for (const key of [
      'customer_name',
      'customer_address',
      'task_from',
      'task_to',
      'task_cargo',
      // Графа «заказчик, телефон» — контакты концов маршрута, по строке на талон рейса.
      'task_contacts',
      'task2_contacts',
      'task3_contacts',
      'task4_contacts',
      // Рейсы 5–7 — строкой в блоке доп. задания: граф там нет, и задание собрано целиком
      // (ADR 0068).
      'task5_line',
      'task6_line',
      'task7_line',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  /**
   * Задание рейсов 5–7 стоит там, где бланк оставил пустое место, — в трёх нижних строках блока
   * «Дополнительное задание водителю». Проверяется именно оно: адрес, съехавший на строку выше,
   * затёр бы графу «Расход горючего», а съехавший ниже — примечание, и оба раза лист вышел бы из
   * принтера правдоподобным.
   *
   * Верхние строки блока остаются пустыми намеренно: они узкие (справа «Расход горючего») и
   * заполняются от руки — ради того блок в бланке и заведён.
   */
  it('доп. задание 4-П занимает три нижние строки блока, и только их', () => {
    const files = unzipSync(template('4p'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);

    const cellOf = (address: string): string =>
      new RegExp(`<c r="${address}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet)?.[1] ?? '';

    expect(cellOf('CG76')).toContain('{{task5_line}}');
    expect(cellOf('CG77')).toContain('{{task6_line}}');
    expect(cellOf('CG78')).toContain('{{task7_line}}');
    for (const free of ['CG72', 'CG73', 'CG75']) {
      expect(cellOf(free), `${free} — строка диспетчера, портал её не занимает`).not.toContain(
        '{{',
      );
    }
  });

  /**
   * Строка доп. задания идёт во всю ширину блока и в одну строку не встаёт: «откуда → куда, груз,
   * контакты» длиннее её. Держит это `wrapText` — стиль самого бланка его не несёт, и без флага
   * хвост задания срезался бы по границе объединения: заказчик, груз или телефон исчезали бы с
   * бумаги молча.
   */
  it('строки доп. задания 4-П переносят текст: задание в одну строку не влезает', () => {
    const files = unzipSync(template('4p'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const styles = decoder.decode(files['xl/styles.xml']!);
    const xfs = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/
      .exec(styles)![1]!
      .match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)!;

    for (const address of ['CG76', 'CG77', 'CG78']) {
      const cell = new RegExp(`<c r="${address}"((?:(?!/>|>)[\\s\\S])*)`).exec(sheet)!;
      const xf = xfs[Number(/\ss="(\d+)"/.exec(cell[1]!)![1])]!;
      expect(xf, address).toMatch(/wrapText="(1|true)"/);
      // Верх, а не середина: вторая строка обязана лечь под первой, а не раздвинуть её за
      // границы строки листа.
      expect(xf, address).toMatch(/vertical="top"/);
    }
  });

  /**
   * Графа «заказчик, телефон» держит две строки, и разводит их перенос внутри ячейки. Работает он
   * только при `wrapText`: без флага обе строки лягут одна на другую в одну — на бумаге останется
   * контакт погрузки, а телефон разгрузки исчезнет молча.
   */
  it('графа контактов 4-П переносит строки: их там две', () => {
    const files = unzipSync(template('4p'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const styles = decoder.decode(files['xl/styles.xml']!);
    const xfs = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/
      .exec(styles)![1]!
      .match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)!;

    for (const address of ['BG75', 'BG76', 'BG77', 'BG78']) {
      const cell = new RegExp(`<c r="${address}"((?:(?!/>|>)[\\s\\S])*)`).exec(sheet)!;
      const style = Number(/\ss="(\d+)"/.exec(cell[1]!)![1]);
      expect(xfs[style], address).toMatch(/wrapText="(1|true)"/);
    }
  });

  /**
   * Форма № 3 печатается реквизитами, но без задания (ADR 0071): ни таблицы оборота «Место
   * отправления / назначения, время убытия, груз, заказчик», ни «Адреса подачи» на лицевой.
   * Порядок поездок легкового портал не решает — напечатанная последовательность выдавала бы за
   * задание догадку, а оборот бланка разграфлен типографией под отметки водителя по факту.
   */
  it('в форме № 3 размечены реквизиты, но не задание рейса', () => {
    const inTemplate = new Set(inspectTemplate(template('leg3')));
    for (const key of [
      'org_name',
      'org_okpo',
      'waybill_number',
      'waybill_date',
      'vehicle_brand',
      'vehicle_reg_number',
      'driver_fio',
      'driver_snils',
      'driver_license_number',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }

    // Ни одной графы задания: ни маршрута, ни груза, ни заказчика, ни времени убытия. Проверяется
    // весь класс ключей, а не перечисленные адреса, — вернувшаяся разметка любой строки означает,
    // что бланк снова печатает порядок, которого портал не знает.
    expect([...inTemplate].filter((key) => key.startsWith('task'))).toEqual([]);
    expect(inTemplate.has('customer_name'), 'адрес подачи из заявки').toBe(false);
    expect(inTemplate.has('customer_address'), 'адрес подачи из заявки').toBe(false);
  });

  /**
   * Блок «Водительское удостоверение проверил» — это графа диспетчера формы № 3, и убран он тем же
   * решением, что графа диспетчера в 4-П: портал удостоверений не проверяет и документ не
   * подписывает.
   *
   * На освободившееся место поднят блок «Водитель по состоянию здоровья к управлению допущен,
   * алкотест пройден» (строки 42–43 → 37–38): своей подписи у него в бланке нет, и оставь его на
   * месте — от убранной графы посреди лицевой стороны осталась бы дыра в пять пустых строк.
   *
   * Проверяются три вещи, и каждая ловит свою ошибку: подпись убранной графы не стоит ни в одной
   * ячейке; текст допуска стоит ровно в строках 37–38 (промахнувшийся `move` разложил бы его по
   * чужим строкам, а не потерял); линий под ним нет — иначе прямо под «допущен» осталась бы пара
   * пустых черт, которые читаются приглашением расписаться.
   */
  it('в форме № 3 блок допуска поднят на место графы удостоверения, и линий под ним нет', () => {
    const files = unzipSync(template('leg3'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));

    const indexOf = (caption: string): number[] => {
      const found = dictionary.flatMap((text, index) => (text.trim() === caption ? [index] : []));
      expect(found.length, `подпись «${caption}» пропала из словаря книги`).toBeGreaterThan(0);
      return found;
    };

    // Подпись убранной графы: строка остаётся в словаре, ячейки на неё не смотрят.
    for (const index of indexOf('Водительское удостоверение проверил')) {
      expect(cellsWithString(sheet, index)).toEqual([]);
    }

    // Текст допуска — ровно в двух строках на месте убранной графы; строки 42–43 пусты.
    expect(
      indexOf('Водитель по состоянию здоровья к управления допущен,').flatMap((index) =>
        cellsWithString(sheet, index),
      ),
    ).toEqual(['A37']);
    expect(indexOf('алкотест пройден').flatMap((index) => cellsWithString(sheet, index))).toEqual([
      'A38',
    ]);

    // Объединение убранной графы снято: поднятый текст набран в более широком A42:AX42 и по
    // границе A37:AU37 обрезался бы, теряя хвост «…допущен,».
    expect(mergesOf(sheet).map((m) => `${m.from}:${m.to}`)).not.toContain('A37:AU37');

    // Линии графы диспетчера — под подпись (Q39:Y39) и под её расшифровку (AA39:AR39).
    for (const address of ['Q39', 'Y39', 'AA39', 'AR39']) {
      expect(bottomBorderOf(files, address), address).toBe(false);
    }
    // Линии самого водителя ниже целы: их он заполняет от руки.
    for (const address of ['Q48', 'AA48', 'Q55', 'AA55']) {
      expect(bottomBorderOf(files, address), `${address} — линия водителя`).toBe(true);
    }
  });

  /**
   * Расшифровка подписи водителя в обоих его блоках формы № 3 — «Автомобиль принял / водитель»
   * (AA48) и «Автомобиль сдал / водитель» (AA55). Решение то же, что в 4-П: расшифровка — это
   * фамилия подписавшего, водитель у листа один, и портал её знает.
   *
   * Графы механика (BK56, BU56) проверяются пустыми: их подписывает человек.
   */
  it('в форме № 3 расшифровки водителя размечены коротким именем, а графы механика пусты', () => {
    const sheet = decoder.decode(unzipSync(template('leg3'))['xl/worksheets/sheet1.xml']!);

    for (const [address, what] of [
      ['AA48', 'автомобиль принял'],
      ['AA55', 'автомобиль сдал'],
    ] as const) {
      expect(bodyOf(sheet, address), `${what} (${address})`).toContain('{{driver_short_name}}');
    }
    for (const address of ['BK56', 'BU56']) {
      expect(bodyOf(sheet, address), `${address} — графа механика`).not.toContain('{{');
    }
  });

  it.each(FORMS)('заполненный бланк %s не содержит незакрытых плейсхолдеров', (form) => {
    const values = Object.fromEntries(WAYBILL_SNAPSHOT_KEYS.map((k) => [k, `знач-${k}`]));
    const rendered = renderOfficeTemplate(template(form), values);

    expect(rendered.missing).toEqual([]);
    expect(inspectTemplate(rendered.bytes)).toEqual([]);
  });

  /**
   * Плейсхолдер внутри чужого объединения (ADR 0041). Excel показывает содержимое только левой
   * верхней ячейки объединения — остальные молчат. Значение, попавшее в такую ячейку, не
   * печатается вовсе: ни ошибки, ни пустой графы с плейсхолдером, просто ничего. Так на бланке
   * теряли «Организацию», гаражный номер и номер листа в обоих талонах — набор ключей при этом
   * сходился, и проверки выше молчали.
   */
  it.each(FORMS)('в бланке %s ни один плейсхолдер не спрятан внутри объединения', (form) => {
    const sheet = decoder.decode(unzipSync(template(form))['xl/worksheets/sheet1.xml']!);
    const merges = mergesOf(sheet);
    // Ячейки со значением портала: их вписывает `mark-waybill-templates.ts`. Разбирается ячейка
    // целиком, а не «от адреса до первой скобки»: пустые ячейки самозакрыты (`<c r="A1" />`), и
    // поиск по куску разметки перескакивал бы через них на чужой плейсхолдер. Атрибуты читаются
    // нежадно ровно поэтому: жадный кусок съедает косую черту самозакрытия, и пустая ячейка
    // прикидывается открывающим тегом.
    const marked = [...sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)]
      .filter(([, , body]) => body?.includes('{{'))
      .map(([, ref]) => ref!);
    expect(marked.length).toBeGreaterThan(10);

    // Левый верхний угол объединения — единственное место, где значение видно; остальные адреса
    // диапазона молчат.
    const hidden = marked.filter((ref) => merges.some((m) => ref !== m.from && covers(m, ref)));
    expect(hidden).toEqual([]);
  });

  /**
   * Подпись формы ЭСМ-2 — «строительной машины» под заголовком «ПУТЕВОЙ ЛИСТ» — не заперта в
   * объединении. Объединение режет длинный текст по своей границе вместо того, чтобы переполнить
   * пустых соседей: подпись стояла в объединении шириной в две узкие колонки, и на бумаге от неё
   * оставалось «нс». Без объединения текст растекается по пустой строке и печатается целиком.
   *
   * Ячейка ищется по индексу строки в словаре книги, а не по адресу: подпись центрируется под
   * заголовком и колонка у неё подобрана на глаз — привязка к адресу сломалась бы от сдвига на
   * колонку, ничего при этом не проверяя.
   */
  it('в ЭСМ-2 подпись формы не заперта в объединении: иначе печатается «нс»', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));

    const caption = dictionary.flatMap((text, index) =>
      text.trim() === 'строительной машины' ? [index] : [],
    );
    expect(caption.length, 'подпись формы пропала из словаря книги').toBeGreaterThan(0);

    const merges = mergesOf(sheet);
    const cells = caption.flatMap((index) => cellsWithString(sheet, index));
    expect(cells.length, 'подпись формы не стоит ни в одной ячейке листа').toBeGreaterThan(0);

    // Проверяется вхождение в диапазон целиком, включая левый верхний угол: в отличие от
    // спрятанного плейсхолдера, тексту мешает само объединение, а не место внутри него.
    expect(cells.filter((ref) => merges.some((m) => covers(m, ref)))).toEqual([]);
  });

  /**
   * Графа «Машина» (H9, объединение H9:Z9) размечена под ужатие текста. Наименование машины
   * приходит из справочника техники и бывает длиннее графы, а печатает портал через LibreOffice:
   * по флагу `shrinkToFit` он подбирает кегль под ширину графы. Без флага лишнее молча
   * обрезается по границе объединения — на экране бланк выглядит верным, на бумаге нет.
   */
  it('в ЭСМ-2 графа «Машина» ужимает кегль: наименование из справочника длиннее графы', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const styles = decoder.decode(files['xl/styles.xml']!);

    // Ячейка держит не оформление, а номер стиля: `s="19"` — это девятнадцатый `<xf>` из
    // `<cellXfs>`, и выравнивание графы описано там.
    const cell = /<c r="H9"[^>]*?(?:\/>|>)/.exec(sheet);
    expect(cell, 'графа «Машина» пропала из бланка').not.toBeNull();
    const styleIndex = Number(/ s="(\d+)"/.exec(cell![0])?.[1]);
    expect(Number.isInteger(styleIndex), 'у графы «Машина» нет своего стиля').toBe(true);

    const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1]!;
    // Записи бывают и самозакрытыми, и с вложенными `<alignment>`/`<protection>` — нежадный
    // поиск «до первой косой черты» съедал бы половину записи вместе с выравниванием.
    const xf = [...cellXfs.matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(([m]) => m)[
      styleIndex
    ];
    expect(xf, `стиля ${styleIndex} нет в книге`).toBeDefined();

    // Флаг проверяется в самом `<alignment>`: `shrinkToFit="false"` стоит в каждой записи книги,
    // и поиск по всему файлу нашёл бы чужую.
    const alignment = /<alignment\b[^>]*\/?>/.exec(xf!)?.[0] ?? '';
    expect(alignment, `выравнивание графы «Машина»: ${xf}`).toContain('shrinkToFit="true"');
  });

  /**
   * ФИО машиниста идёт в линию заполнения, а не в клетку бланка: ячейки под него в исходнике нет,
   * и портал заводит её сам. Своего стиля у такой ячейки нет — она получает шрифт книги по
   * умолчанию (Arial 8 при наборе бланка Times 11), и ФИО выходило вдвое мельче марки машины
   * строкой выше. Кегль сверяется с госномером — соседней графой той же шапки.
   *
   * Номер листа и его дата стоят на одной линии с заголовком бланка, и эталон у них другой — сам
   * заголовок: см. проверку ниже.
   */
  it('в ЭСМ-2 ФИО машиниста набрано кеглем госномера, а не мельче бланка', () => {
    const files = unzipSync(template('esm2'));
    const sample = fontOf(files, 'AO9');
    expect(sample, 'у госномера — эталона кегля — нет своего шрифта').toContain('<sz val="11"/>');
    expect(fontOf(files, 'H11'), 'ФИО машиниста набрано не кеглем госномера').toBe(sample);
  });

  /**
   * Номер листа и его дата — единым видом с заголовком «ПУТЕВОЙ ЛИСТ» и на одной с ним линии.
   * Заголовок набран объединением в две строки листа (T2:AL3, Tahoma 18 pt, прижат к низу), а
   * номер с датой стояли в одной строке кеглем 11 pt и на разных строках: шапка «плясала» —
   * номер ниже даты, оба мельче заголовка.
   *
   * Проверяются обе половины: объединение в те же две строки и шрифт заголовка. Одного шрифта
   * мало — 18 pt в одну строку шапки не встаёт и садится не на линию заголовка; одного
   * объединения мало — без шрифта величина остаётся припиской к нему.
   */
  it('в ЭСМ-2 номер и дата стоят в высоту заголовка и его кеглем', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const merges = mergesOf(sheet).map((m) => `${m.from}:${m.to}`);
    const title = fontOf(files, 'T2');
    expect(title, 'у заголовка бланка нет своего шрифта').toContain('<sz val="18"/>');

    for (const [address, merge, what, key] of [
      ['AM2', 'AM2:BE3', 'номер листа', '{{waybill_number}}'],
      ['BH2', 'BH2:BO3', 'дата листа', '{{waybill_date}}'],
    ] as const) {
      expect(merges, `${what}: объединения ${merge} в бланке нет`).toContain(merge);
      expect(fontOf(files, address), `${what} набран не кеглем заголовка`).toBe(title);
      expect(bodyOf(sheet, address), `${what} стоит не в ${address}`).toContain(key);
    }

    // Заголовок и подпись «от» между новыми объединениями целы: наехавшие друг на друга
    // объединения Excel чинит молча сам, выбрасывая их, — и шапка расходится уже у бухгалтера.
    for (const merge of ['T2:AL3', 'BF2:BG3']) {
      expect(merges, `объединение бланка ${merge}`).toContain(merge);
    }
  });

  /**
   * Подписи правой колонки шапки ЭСМ-2 («Форма по ОКУД», «Дата составления») прижаты вправо и
   * печатаются переполнением: своей клетки им мало, и текст растекается по пустым соседям слева.
   *
   * Объединение такой текст режет по своей границе — тем же ходом, каким «строительная машина»
   * печаталась как «нс» (см. `unmerge` в разметке). Объединение под дату листа, дотянутое до BT3,
   * заняло всю полосу переполнения, и от «Формы по ОКУД» на бумаге оставалась «КУД»: набор
   * плейсхолдеров при этом сходился, а подпись бланка исчезала молча.
   *
   * Поэтому проверяются обе стороны: подпись не заперта в чужом объединении и полоса слева от неё
   * свободна — ни объединения, ни содержимого. Адрес подписи берётся из словаря книги, а не
   * вписан числом: уедет она на клетку — тест скажет об этом, а не проверит пустоту.
   */
  it('в ЭСМ-2 подписям шапки есть куда переполниться: полоса слева от них свободна', () => {
    const files = unzipSync(template('esm2'));
    const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
    const dictionary = dictionaryOf(decoder.decode(files['xl/sharedStrings.xml']!));
    const merges = mergesOf(sheet);
    const coveringOf = (ref: string): string[] =>
      merges.filter((m) => covers(m, ref)).map((m) => `${m.from}:${m.to}`);

    // Полоса переполнения — пять клеток бланка между кодовой таблицей и объединениями портала.
    for (const [caption, address, run] of [
      ['Форма по ОКУД', 'BU3', ['BP3', 'BQ3', 'BR3', 'BS3', 'BT3']],
      ['Дата составления', 'BU4', ['BP4', 'BQ4', 'BR4', 'BS4', 'BT4']],
    ] as const) {
      const indexes = dictionary.flatMap((text, index) => (text.trim() === caption ? [index] : []));
      expect(indexes.length, `подпись «${caption}» пропала из словаря книги`).toBeGreaterThan(0);
      expect(
        indexes.flatMap((index) => cellsWithString(sheet, index)),
        `подпись «${caption}» стоит не в ${address}`,
      ).toEqual([address]);
      expect(coveringOf(address), `подпись «${caption}» заперта в объединении`).toEqual([]);

      for (const free of run) {
        expect(coveringOf(free), `${free}: клетка переполнения «${caption}» объединена`).toEqual(
          [],
        );
        expect(bodyOf(sheet, free), `${free}: клетка переполнения «${caption}» занята`).toBe('');
      }
    }
  });

  /**
   * Высота строки в бланке задана жёстко, и шрифт крупнее прежнего она не раздвигает: LibreOffice
   * при печати такую строку не режет, а Excel режет — и в скачанном файле у номера с датой пропала
   * бы верхушка букв. Обе строки шапки подняты до 14 pt: объединения номера и даты занимают их
   * обе, и кеглю 18 pt заголовка достаётся 28 pt.
   */
  it('в ЭСМ-2 строки номера и даты вмещают кегль заголовка: иначе Excel срежет верхушки', () => {
    const files = unzipSync(template('esm2'));
    for (const row of [2, 3]) {
      expect(rowHeightOf(files, row), `строка ${row} ниже 14 pt`).toBeGreaterThanOrEqual(14);
    }
    expect(
      rowHeightOf(files, 2) + rowHeightOf(files, 3),
      'две строки шапки не вмещают кегль 18 pt',
    ).toBeGreaterThanOrEqual(28);
  });

  /**
   * Параметры печати (ADR 0041). Без них бланк печатается портретным в 100% и расползается на
   * четыре страницы вместо двух — разрезанным по ширине; это не ловит ни одна проверка выше,
   * потому что значения-то на месте. Сверяется файл, а не скрипт: печатает портал именно его.
   */
  it.each(FORMS)('бланк %s размечен под лист A4: иначе печать порвёт его пополам', (form) => {
    const sheet = new TextDecoder().decode(unzipSync(template(form))['xl/worksheets/sheet1.xml']!);

    expect(sheet).toContain('fitToPage="1"');
    expect(sheet).toContain('fitToWidth="1"');
    // В высоту — сколько получится: у бланка две стороны, лицевая и оборот, и сжимать их в один
    // лист нельзя.
    expect(sheet).toContain('fitToHeight="0"');
    expect(sheet).toContain('paperSize="9"');
  });

  // 4-П — 166 колонок, ЭСМ-2 — 86 шириной 208 знаков: на портретный лист не ложатся ни тот, ни
  // другой. У ЭСМ-2 проверка ловит и вторую ошибку: исходник пришёл из LibreOffice со своим
  // `<pageSetup orientation="portrait">`, и разметка обязана его переписать, а не дописать второй.
  it.each(['4p', 'esm2'] as const)('бланк %s печатается альбомным', (form) => {
    const sheet = new TextDecoder().decode(unzipSync(template(form))['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('orientation="landscape"');
    expect(sheet.match(/<pageSetup[^>]*>/g)).toHaveLength(1);
  });

  it.each(FORMS)('подстановка не трогает вёрстку бланка %s: стили и рисунки те же', (form) => {
    const original = template(form);
    const rendered = renderOfficeTemplate(original, { driver_fio: 'Иванов' });

    // Бланк прислан бухгалтерией: линии, шрифты и штампы обязаны пережить подстановку без правок.
    const before = unzipSync(original);
    const after = unzipSync(rendered.bytes);

    // Список частей берётся из самого бланка, а не пишется в тесте руками: состав у трёх бланков
    // разный и меняется (логотипа с его `media/` нет ни в одном, рисунок остался только у ЭСМ-2),
    // а вписанное имя несуществующей части превращает проверку в сравнение двух `undefined`.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

    // Текст книги живёт в словаре строк и на листах — только их подстановка и переписывает.
    // Всё остальное — стили, тема, рисунки, связи, свойства — обязано совпасть байт в байт.
    const layout = Object.keys(before).filter(
      (part) => part !== 'xl/sharedStrings.xml' && !/^xl\/worksheets\/[^/]+\.xml$/.test(part),
    );
    expect(layout).toContain('xl/styles.xml');
    for (const part of layout) {
      expect(Array.from(after[part]!), part).toEqual(Array.from(before[part]!));
    }
  });
});

/**
 * Геометрия граф задания против чисел, которыми считает бюджет строки
 * (`TASK_ROW_GEOMETRY`, план `docs/route-trips-plan.md`, Р11а).
 *
 * Бюджет решает, что напечатается, а что свернётся в «+N» или упрётся в отказ «строка не влезает».
 * Числа для него сняты с этого самого файла — и разъехаться с ним обязаны громко. Одной ширины
 * ячейки тут мало: на вместимость влияют и шрифт, и кегль, и высота строки, и перенос, — поэтому
 * сверяются **все пять**. Разойдутся — упадёт тест, а не бланк у водителя; иначе бюджет тихо
 * разминётся с бумагой и даст либо ложные 422, либо то самое молчаливое обрезание, от которого он
 * и заводился (ADR 0060).
 */
describe('геометрия граф задания 4-П', () => {
  const files = (): Record<string, Uint8Array> => unzipSync(template('4p'));

  /** Ширины колонок листа: `<col min max width>` описывает диапазон, а не одну колонку. */
  function columnWidths(sheet: string): { min: number; max: number; width: number }[] {
    return [...sheet.matchAll(/<col min="(\d+)" max="(\d+)"[^>]*width="([\d.]+)"[^>]*\/>/g)].map(
      ([, min, max, width]) => ({ min: Number(min), max: Number(max), width: Number(width) }),
    );
  }

  /** Ширина объединения в единицах Excel: сумма ширин всех колонок, которые оно накрывает. */
  function mergeWidthUnits(sheet: string, merge: string): number {
    const [from, to] = merge.split(':') as [string, string];
    const widths = columnWidths(sheet);
    const widthOf = (column: number): number =>
      widths.find((c) => c.min <= column && column <= c.max)?.width ?? 0;
    let total = 0;
    for (let column = colNumber(from); column <= colNumber(to); column += 1)
      total += widthOf(column);
    return total;
  }

  it('шрифт книги и его высота строки — те, из которых выведена единица ширины', () => {
    const styles = decoder.decode(files()['xl/styles.xml']!);
    const sheet = decoder.decode(files()['xl/worksheets/sheet1.xml']!);
    const bookFont =
      /<fonts count="\d+"[^>]*>\s*(<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>)/.exec(
        styles,
      )![1]!;

    // Единица ширины колонки Excel — ширина цифры «0» шрифта книги. Сменится шрифт или кегль —
    // сменится и она, а с ней все пять ширин граф в пунктах.
    expect(bookFont).toContain('<name val="Arial"');
    expect(bookFont).toContain(`<sz val="${TASK_ROW_GEOMETRY.bookFontPt}"`);
    expect(/<sheetFormatPr[^>]*defaultRowHeight="([\d.]+)"/.exec(sheet)![1]).toBe(
      String(TASK_ROW_GEOMETRY.bookRowHeightPt),
    );
  });

  it('все пять граф стоят своими объединениями и своей ширины', () => {
    const parts = files();
    const sheet = decoder.decode(parts['xl/worksheets/sheet1.xml']!);
    const merges = mergesOf(sheet);

    for (const [cell, geometry] of Object.entries(TASK_ROW_GEOMETRY.cells)) {
      const anchor = geometry.merge.split(':')[0]!;
      const merge = merges.find((m) => covers(m, anchor));

      expect(merge, `графа ${cell}: объединения у ${anchor} нет`).toBeDefined();
      expect(`${merge!.from}:${merge!.to}`, `графа ${cell}`).toBe(geometry.merge);
      // Ширина сверяется с допуском в сотую единицы: Excel хранит её с плавающей точкой.
      expect(mergeWidthUnits(sheet, geometry.merge), `графа ${cell}`).toBeCloseTo(
        geometry.widthUnits,
        2,
      );
    }
  });

  it('кегль граф — тот, при котором считается ширина, и перенос у них включён', () => {
    const parts = files();

    for (const [cell, geometry] of Object.entries(TASK_ROW_GEOMETRY.cells)) {
      const anchor = geometry.merge.split(':')[0]!;

      expect(fontOf(parts, anchor), `графа ${cell}`).toContain(
        `<sz val="${TASK_ROW_GEOMETRY.fontPt}"`,
      );
      // Без переноса вторая строка легла бы на первую, и «две строки» бюджета были бы выдумкой.
      expect(xfOf(parts, anchor), `графа ${cell}`).toMatch(/wrapText="(1|true)"/);
    }
  });

  it('высота строк держит ровно две строки текста — столько бюджет и считает', () => {
    const parts = files();

    for (const geometry of Object.values(TASK_ROW_GEOMETRY.cells)) {
      const row = Number(/(\d+)$/.exec(geometry.merge.split(':')[0]!)![1]);
      expect(rowHeightOf(parts, row)).toBe(TASK_ROW_GEOMETRY.rowHeightPt);
    }
    // Не «две по определению», а две по расчёту: высота строки при кегле 6 pt — 11.45/8 × 6.
    expect(TASK_ROW_LINES).toBe(2);
  });
});

/**
 * Операции разметки на исходных бланках (`scripts/mark-waybill-templates.ts`).
 *
 * Проверки выше читают готовый шаблон и потому видят только те операции, которыми пользуется хоть
 * один бланк. Операция, заведённая под будущую правку формы, до первого своего применения не
 * проверена ничем — а применять её будут к присланному бухгалтерией файлу, где и рамка, и
 * объединение записаны не так, как в примере из головы: ЭСМ-2 прошёл через LibreOffice и пишет
 * стороны рамки пустым тегом, 4-П — тегом с цветом внутри. Поэтому операции прогоняются здесь на
 * самих исходниках, из которых собираются шаблоны.
 */
describe('операции разметки', () => {
  const encoder = new TextEncoder();

  interface Book {
    sheet: string;
    styles: string;
  }

  /** Исходник бланка, каким его прислала бухгалтерия: шаблон собирается из него. */
  function source(file: string): Book {
    const files = unzipSync(new Uint8Array(readFileSync(join(templatesDir, 'source', file))));
    return {
      sheet: decoder.decode(files['xl/worksheets/sheet1.xml']!),
      styles: decoder.decode(files['xl/styles.xml']!),
    };
  }

  /** Рамка графы целиком: в стиле записан её номер, а чем обведена ячейка — только в самой рамке. */
  function borderOf(book: Book, address: string): string {
    // `xfOf` читает книгу частями, а операции правят её строками — собираем части обратно.
    const xf = xfOf(
      {
        'xl/worksheets/sheet1.xml': encoder.encode(book.sheet),
        'xl/styles.xml': encoder.encode(book.styles),
      },
      address,
    );
    const borders =
      /<borders count="\d+">([\s\S]*?)<\/borders>/
        .exec(book.styles)![1]!
        .match(/<border\b[^>]*\/>|<border\b[^>]*>[\s\S]*?<\/border>/g) ?? [];
    return borders[Number(/borderId="(\d+)"/.exec(xf)?.[1] ?? 0)]!;
  }

  /** Число записей в таблице книги — то, что стоит в её заголовке; Excel сверяет его со списком. */
  function countOf(styles: string, table: 'cellXfs' | 'borders'): number {
    return Number(new RegExp(`<${table} count="(\\d+)"`).exec(styles)![1]);
  }

  /** Сколько объединений записано в заголовке списка. */
  function mergeCount(sheet: string): number {
    return Number(/<mergeCells count="(\d+)">/.exec(sheet)![1]);
  }

  const SIDES = ['left', 'right', 'top', 'bottom'] as const;
  /** «Количество отработанных часов» 4-П: поле обведено со всех четырёх сторон (рамка 3). */
  const BOXED = 'DX16:EJ16';

  it('unbox снимает у поля в рамке все четыре стороны', () => {
    const before = source('4П.xlsx');
    for (const side of SIDES) {
      expect(borderOf(before, 'DX16'), side).toMatch(new RegExp(`<${side} style=`));
    }

    const after = unborderCells(before.sheet, before.styles, [BOXED], BOX);

    // Рамку снимает каждая ячейка графы своей: обведён весь блок, а не одна его клетка.
    for (const address of ['DX16', 'EA16', 'EJ16']) {
      for (const side of SIDES) {
        expect(borderOf(after, address), `${address} ${side}`).not.toMatch(
          new RegExp(`<${side} style=`),
        );
      }
    }
  });

  it('unline у того же поля снимает только линию, оставляя бока и верх', () => {
    const before = source('4П.xlsx');
    const after = unborderCells(before.sheet, before.styles, [BOXED], LINE);

    expect(borderOf(after, 'DX16')).not.toMatch(/<bottom style=/);
    for (const side of ['left', 'right', 'top']) {
      expect(borderOf(after, 'DX16'), side).toMatch(new RegExp(`<${side} style=`));
    }
  });

  it('на всю графу заводится одна запись стиля, а не по одной на клетку', () => {
    const before = source('4П.xlsx');
    const after = unborderCells(before.sheet, before.styles, [BOXED], BOX);

    // Тринадцать клеток графы носят один стиль — копий и рамки, и записи обязано быть по одной.
    expect(countOf(after.styles, 'cellXfs')).toBe(countOf(before.styles, 'cellXfs') + 1);
    expect(countOf(after.styles, 'borders')).toBe(countOf(before.styles, 'borders') + 1);
    // Заголовок таблицы обязан сойтись со списком: разошёлся — книга для Excel повреждена.
    expect((after.styles.match(/<border\b/g) ?? []).length).toBe(countOf(after.styles, 'borders'));
  });

  it('merge дописывает объединение и правит его счётчик', () => {
    const { sheet } = source('СДМ.xlsx');
    const merged = mergeCells(sheet, 'AM2:AM3');

    expect(merged).toContain('<mergeCell ref="AM2:AM3" />');
    expect(mergeCount(merged)).toBe(mergeCount(sheet) + 1);
    expect((merged.match(/<mergeCell /g) ?? []).length).toBe(mergeCount(merged));
    // Ячеек AM2 и AM3 в бланке нет вовсе — пустых клеток он не хранит, и лист остаётся как был.
    const withoutMerges = (xml: string): string =>
      xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, '');
    expect(withoutMerges(merged)).toBe(withoutMerges(sheet));
  });

  it('merge оставляет содержимое только левому верхнему углу', () => {
    // BU3 «Форма по ОКУД» и BU4 «Дата составления» — две подписи ЭСМ-2 одна под другой.
    const { sheet } = source('СДМ.xlsx');
    const merged = mergeCells(sheet, 'BU3:BU4');

    expect(/<c r="BU3"[\s\S]*?<\/c>/.exec(merged)![0]).toContain('<v>');
    // Спрятанный текст на бумаге не печатается, а в файле остаётся мусором. Стиль сохраняется —
    // он несёт линии, которыми нарисован сам бланк.
    expect(/<c r="BU4"[\s\S]*?(?:\/>|<\/c>)/.exec(merged)![0]).toBe('<c r="BU4" s="7" />');
  });

  it('merge не заводит объединение поверх чужого', () => {
    const { sheet } = source('СДМ.xlsx');

    // Заголовок «ПУТЕВОЙ ЛИСТ» — объединение T2:AL3; книгу с наездом Excel чинит молча сам.
    expect(() => mergeCells(sheet, 'AL2:AM3')).toThrow(/наезжает на T2:AL3/);
    expect(() => mergeCells(sheet, 'T2:AL3')).toThrow(/уже есть/);
  });
});
