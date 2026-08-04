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
      const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']!);
      const strings = new TextDecoder().decode(files['xl/sharedStrings.xml']!);

      const dictionary = [...strings.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
        [...si!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''),
      );
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
   * Тем же решением, что и графа диспетчера: в исходнике ЭСМ-2 над линией «(расшифровка подписи)»
   * впечатана фамилия начальника отдела автотехники. Напечатанная рядом с пустой линией, она
   * читается как подпись, которой нет, — и вдобавок это персональные данные живого человека в
   * публичном репозитории. Должность остаётся: её подписывает человек, а не портал.
   */
  it('в ЭСМ-2 стёрта фамилия начальника отдела: подписывает человек, а не портал', () => {
    const files = unzipSync(template('esm2'));
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']!);
    const strings = new TextDecoder().decode(files['xl/sharedStrings.xml']!);

    const dictionary = [...strings.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
      [...si!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''),
    );
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
    for (const key of ['customer_name', 'customer_address', 'task_from', 'task_to', 'task_cargo']) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  /**
   * Форма № 3 печатает задание на обороте: лицевая сторона держит только «Адрес подачи», а рейс
   * с его заявками — таблица «Место отправления / назначения, время убытия, груз, заказчик».
   * Без неё лист выходил бы без единого адреса, ради которого машина выезжала.
   */
  it('в форме № 3 размечены реквизиты и задание рейса', () => {
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
      'customer_name',
      'task_from',
      'task_to',
      'task_departure_hh',
      'task_departure_mm',
      // Талоны рейса: маршрут держит четыре заявки, и печатаются все четыре.
      'task2_from',
      'task3_from',
      'task4_from',
      'task4_customer',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
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
    const sheet = new TextDecoder().decode(unzipSync(template(form))['xl/worksheets/sheet1.xml']!);
    const colNumber = (ref: string): number =>
      [.../^([A-Z]+)/.exec(ref)![1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const rowNumber = (ref: string): number => Number(/(\d+)$/.exec(ref)![1]);

    const merges = [...sheet.matchAll(/mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map(
      ([, from, to]) => ({ from: from!, to: to! }),
    );
    // Ячейки со значением портала: их вписывает `mark-waybill-templates.ts`. Разбирается ячейка
    // целиком, а не «от адреса до первой скобки»: пустые ячейки самозакрыты (`<c r="A1" />`), и
    // поиск по куску разметки перескакивал бы через них на чужой плейсхолдер. Атрибуты читаются
    // нежадно ровно поэтому: жадный кусок съедает косую черту самозакрытия, и пустая ячейка
    // прикидывается открывающим тегом.
    const marked = [...sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)]
      .filter(([, , body]) => body?.includes('{{'))
      .map(([, ref]) => ref!);
    expect(marked.length).toBeGreaterThan(10);

    const hidden = marked.filter((ref) =>
      merges.some(
        (m) =>
          ref !== m.from &&
          rowNumber(m.from) <= rowNumber(ref) &&
          rowNumber(ref) <= rowNumber(m.to) &&
          colNumber(m.from) <= colNumber(ref) &&
          colNumber(ref) <= colNumber(m.to),
      ),
    );
    expect(hidden).toEqual([]);
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
    for (const part of ['xl/styles.xml', 'xl/drawings/drawing1.xml', 'xl/media/image1.png']) {
      expect(Array.from(after[part]!), part).toEqual(Array.from(before[part]!));
    }
  });
});
