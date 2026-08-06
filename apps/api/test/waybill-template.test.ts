import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { WAYBILL_SNAPSHOT_KEYS } from '@technic/contracts';
import { inspectTemplate, renderOfficeTemplate } from '../src/services/office-template';

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
 * Есть ли у ячейки линия графы — нижняя граница. Линия живёт не в ячейке: ячейка держит номер
 * стиля, стиль — номер рамки, и только в рамке написано, чем она снизу обведена.
 */
function bottomBorderOf(files: Record<string, Uint8Array>, address: string): boolean {
  const sheet = decoder.decode(files['xl/worksheets/sheet1.xml']!);
  const styles = decoder.decode(files['xl/styles.xml']!);
  const cell = new RegExp(`<c r="${address}"((?:(?!/>|>)[\\s\\S])*)`).exec(sheet);
  expect(cell, `ячейки ${address} в бланке нет`).not.toBeNull();

  const xfs =
    /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/
      .exec(styles)![1]!
      .match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  const xf = xfs[Number(/\ss="(\d+)"/.exec(cell![1]!)?.[1] ?? 0)]!;
  const borders =
    /<borders count="\d+">([\s\S]*?)<\/borders>/
      .exec(styles)![1]!
      .match(/<border\b[^>]*\/>|<border\b[^>]*>[\s\S]*?<\/border>/g) ?? [];
  return /<bottom style=/.test(borders[Number(/borderId="(\d+)"/.exec(xf)?.[1] ?? 0)]!);
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
   * СНИЛС с удостоверением. Проверяются обе стороны: то, без чего лист бессмысленен, размечено, а
   * графы рейса не размечены — их в бланке нет, и появление ключа означало бы, что кто-то вписал
   * значение в чужую клетку.
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
      // Семь строк недели: числа месяца и объект — по каждому дню.
      'day1_date',
      'day7_date',
      'day1_object',
      'day7_object',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
    for (const key of [
      // Машинист работает по удостоверению тракториста-машиниста, которого портал не ведёт
      // (ADR 0055): этих граф в бланке нет и быть не должно.
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
