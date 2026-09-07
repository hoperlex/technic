import { describe, expect, it } from 'vitest';
import {
  parseWasteTicketDateParts,
  resolveWasteTicketIssuedOn,
  suggestWasteTicketYear,
  updateWasteTicketSchema,
} from '@technic/contracts';

// Год в дате талона выбирается по якорю (ADR 0166, план `docs/waste-ticket-date-escalation-plan.md`,
// Р5 и Р10). Проверяется правило целиком: разбор написания, выбор года по якорю, признак
// расхождения `issuedOn` с транскрипцией и подсказка замены года для замечания сверки.
//
// Ни один тест не берёт «сегодня»: в этом и смысл правила — век выбирает якорь заявки, а не
// календарь машины, и разбор, зависящий от текущей даты, повторял бы ошибку промпта.
// Фикстуры синтетические: репозиторий публичный, настоящих сканов и номеров здесь нет.

/** Якорь заявки: фактический день вывоза или плановая дата, всегда календарный ключ. */
const ANCHOR = '2026-08-17';

describe('разбор написания даты (ADR 0166, п.2)', () => {
  it('числовые формы с разделителями бланка', () => {
    expect(parseWasteTicketDateParts('17.08.2026')).toEqual({
      day: 17,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
    expect(parseWasteTicketDateParts('17/08/26')).toEqual({
      day: 17,
      month: 8,
      year: 26,
      yearDigits: 2,
    });
    expect(parseWasteTicketDateParts('17-08-26')).toEqual({
      day: 17,
      month: 8,
      year: 26,
      yearDigits: 2,
    });
    expect(parseWasteTicketDateParts('7 8 2026')).toEqual({
      day: 7,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
  });

  it('русские месяцы полностью и сокращением, с хвостом «г.» и без него', () => {
    expect(parseWasteTicketDateParts('17 августа 2026')).toEqual({
      day: 17,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
    expect(parseWasteTicketDateParts('17 авг 26')).toEqual({
      day: 17,
      month: 8,
      year: 26,
      yearDigits: 2,
    });
    // «г.» снимается только после цифры года: иначе правило откусило бы «г» у самого «авг».
    expect(parseWasteTicketDateParts('17 сент. 2026 г.')).toEqual({
      day: 17,
      month: 9,
      year: 2026,
      yearDigits: 4,
    });
    expect(parseWasteTicketDateParts('5 мая 2026')).toEqual({
      day: 5,
      month: 5,
      year: 2026,
      yearDigits: 4,
    });
  });

  it('те же формы без года: год записи нет, и достраивать его будет якорь', () => {
    expect(parseWasteTicketDateParts('17.08')).toEqual({
      day: 17,
      month: 8,
      year: null,
      yearDigits: 0,
    });
    expect(parseWasteTicketDateParts('17 авг')).toEqual({
      day: 17,
      month: 8,
      year: null,
      yearDigits: 0,
    });
  });

  it('ISO и восемь цифр подряд: первое отдаёт сама модель, второе пишут на бланке', () => {
    expect(parseWasteTicketDateParts('2026-08-17')).toEqual({
      day: 17,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
    // `20260818` — машинный порядок, `18082026` годом 1808 быть не может (Р19 ADR 0114).
    expect(parseWasteTicketDateParts('20260818')).toEqual({
      day: 18,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
    expect(parseWasteTicketDateParts('18082026')).toEqual({
      day: 18,
      month: 8,
      year: 2026,
      yearDigits: 4,
    });
  });

  it('несуществующая дата не разбирается', () => {
    expect(parseWasteTicketDateParts('31.02.2026')).toBeNull();
    expect(parseWasteTicketDateParts('17.13.2026')).toBeNull();
    // Без года день проверяется по самому длинному варианту месяца: 30 февраля не бывает никогда,
    // а 29-е бывает, и решает это уже выбранный год.
    expect(parseWasteTicketDateParts('30.02')).toBeNull();
    expect(parseWasteTicketDateParts('29.02')).toEqual({
      day: 29,
      month: 2,
      year: null,
      yearDigits: 0,
    });
  });

  it('незнакомая форма остаётся неразобранной, а не угадывается', () => {
    expect(parseWasteTicketDateParts('во вторник')).toBeNull();
    expect(parseWasteTicketDateParts('17 хрю 2026')).toBeNull();
    expect(parseWasteTicketDateParts('17.08.2026 и ещё что-то')).toBeNull();
    expect(parseWasteTicketDateParts('')).toBeNull();
    expect(parseWasteTicketDateParts(null)).toBeNull();
  });
});

describe('выбор года по якорю (ADR 0166, п.2)', () => {
  it('двузначный год получает век якоря', () => {
    // Ровно случай из плана: бланк «17.08.26» при якоре 2026 года.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2025-08-17', issuedOnRaw: '17.08.26' }, ANCHOR),
    ).toEqual({ issuedOn: '2026-08-17', conflict: false });
  });

  it('век берёт якорь, а не календарь машины (перенос из waste-ticket-normalize)', () => {
    // Прежний `parseWasteTicketDate` относил двузначный год к ТЕКУЩЕМУ веку, и «17.08.26» в 2126
    // году стало бы 2126-м. Здесь тот же вход даёт век якоря — и разные якоря дают разные века,
    // хотя «сегодня» у обоих вызовов одно.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '17.08.26' }, '1926-08-20'),
    ).toEqual({ issuedOn: '1926-08-17', conflict: false });
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '17.08.26' }, '2126-08-20'),
    ).toEqual({ issuedOn: '2126-08-17', conflict: false });
  });

  it('два прохода с разным веком одной записи сходятся на одной дате', () => {
    // Э2 плана: модель А выбрала 1925 год, модель Б — 2025, написание у обеих одно. После
    // нормализации спорить не о чем, и человек не получает спор на ровном месте.
    const first = resolveWasteTicketIssuedOn(
      { issuedOn: '1925-08-17', issuedOnRaw: '17.08.25' },
      ANCHOR,
    );
    const second = resolveWasteTicketIssuedOn(
      { issuedOn: '2025-08-17', issuedOnRaw: '17.08.25' },
      ANCHOR,
    );
    expect(first).toEqual({ issuedOn: '2025-08-17', conflict: false });
    expect(second).toEqual(first);
  });

  it('запись без года берёт ближайший из года якоря, предыдущего и следующего', () => {
    expect(resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '17.08' }, ANCHOR)).toEqual({
      issuedOn: '2026-08-17',
      conflict: false,
    });
    // Бумагу за 31 декабря приносят в январе: год якоря дальше предыдущего, и берётся предыдущий.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '31.12' }, '2026-01-05'),
    ).toEqual({ issuedOn: '2025-12-31', conflict: false });
  });

  it('четырёхзначный год якорем не подменяется', () => {
    // Прочитанные цифры догадкой системы не подменяются: такая дата — повод для второго прохода и
    // для подсказки человеку, но не для тихой правки.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2019-08-17', issuedOnRaw: '17.08.2019' }, ANCHOR),
    ).toEqual({ issuedOn: '2019-08-17', conflict: false });
  });

  it('при равном расстоянии до якоря побеждает первый кандидат по порядку', () => {
    // 2028 год високосный, поэтому 01.01.2028 и 01.01.2029 отстоят от 02.07.2028 ровно на 183 дня.
    // Порядок кандидатов — часть правила: год якоря стоит первым, и результат не должен зависеть
    // от того, как реализована сортировка.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '01.01' }, '2028-07-02'),
    ).toEqual({ issuedOn: '2028-01-01', conflict: false });
  });

  it('несуществующий кандидат пропускается: 29 февраля ищет високосный год', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: '29.02' }, '2027-03-01'),
    ).toEqual({ issuedOn: '2028-02-29', conflict: false });
  });

  it('неразобранная транскрипция оставляет дату модели — сегодняшнее поведение', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2026-08-17', issuedOnRaw: 'во вторник' }, ANCHOR),
    ).toEqual({ issuedOn: '2026-08-17', conflict: false });
    expect(resolveWasteTicketIssuedOn({ issuedOn: null, issuedOnRaw: null }, ANCHOR)).toEqual({
      issuedOn: null,
      conflict: false,
    });
  });
});

describe('расхождение даты модели с её же транскрипцией (ADR 0166, п.2, п.4)', () => {
  it('другой день — значение модели сохраняется, дата становится спорной для каскада', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2026-08-18', issuedOnRaw: '17.08.26' }, ANCHOR),
    ).toEqual({ issuedOn: '2026-08-18', conflict: true });
  });

  it('другой месяц — тот же исход', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2026-09-17', issuedOnRaw: '17.08.26' }, ANCHOR),
    ).toEqual({ issuedOn: '2026-09-17', conflict: true });
  });

  it('расхождение только по году расхождением не считается — его и выбирает якорь', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '1926-08-17', issuedOnRaw: '17.08.26' }, ANCHOR),
    ).toEqual({ issuedOn: '2026-08-17', conflict: false });
  });
});

describe('выключатель TICKET_OCR_DATE_YEAR_FROM_ANCHOR (ADR 0166, п.2)', () => {
  it('год остаётся от модели, как до этой работы', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '1925-08-17', issuedOnRaw: '17.08.25' }, ANCHOR, {
        yearFromAnchor: false,
      }),
    ).toEqual({ issuedOn: '1925-08-17', conflict: false });
  });

  it('транскрипция всё равно разбирается, и расхождение по дню считается по-прежнему', () => {
    // Выключатель гасит выбор века, а не эскалацию: иначе откат правила заодно отключал бы повод
    // для второго прохода, который от него не зависит.
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '2026-08-18', issuedOnRaw: '17.08.26' }, ANCHOR, {
        yearFromAnchor: false,
      }),
    ).toEqual({ issuedOn: '2026-08-18', conflict: true });
  });

  it('включённое правило — умолчание: без опции век выбирает якорь', () => {
    expect(
      resolveWasteTicketIssuedOn({ issuedOn: '1925-08-17', issuedOnRaw: '17.08.25' }, ANCHOR, {
        yearFromAnchor: true,
      }),
    ).toEqual(
      resolveWasteTicketIssuedOn({ issuedOn: '1925-08-17', issuedOnRaw: '17.08.25' }, ANCHOR),
    );
  });
});

describe('подсказка замены года (ADR 0166, п.5)', () => {
  it('введённый факт вывоза: допуск нулевой, подсказка обязана совпасть с якорем', () => {
    expect(suggestWasteTicketYear('2025-08-17', ANCHOR, 0)).toBe('2026-08-17');
  });

  it('плановая дата: подсказка годится, если попадает в допуск сверки', () => {
    // `planDateDays` = 3: дата вывоза законно позже плановой, и замечания на этом расхождении нет.
    expect(suggestWasteTicketYear('2025-08-19', ANCHOR, 3)).toBe('2026-08-19');
    // За допуском замена года замечание не погасит, и предлагать её нечестно: человек нажал бы, а
    // замечание осталось бы.
    expect(suggestWasteTicketYear('2025-08-25', ANCHOR, 3)).toBeNull();
  });

  it('расхождение в днях подсказки не имеет: год тут ни при чём', () => {
    expect(suggestWasteTicketYear('2025-08-18', ANCHOR, 0)).toBeNull();
  });

  it('дата талона уже совпала с якорем — предлагать нечего', () => {
    expect(suggestWasteTicketYear(ANCHOR, ANCHOR, 0)).toBeNull();
  });

  it('29 февраля: подсказка есть при високосном целевом годе', () => {
    expect(suggestWasteTicketYear('2024-02-29', '2028-02-29', 0)).toBe('2028-02-29');
  });

  it('29 февраля: невисокосный кандидат отбрасывается как несуществующий', () => {
    // Была бы 29.02.2027 датой — она отстояла бы от якоря на день и попала бы в допуск. Такого дня
    // нет, а високосный 2028-й лежит за окном сверки, поэтому подсказки не будет вовсе.
    expect(suggestWasteTicketYear('2024-02-29', '2027-02-28', 3)).toBeNull();
  });
});

describe('маркер источника правки (ADR 0166, п.6)', () => {
  it('разрешён при одиночной правке даты', () => {
    expect(
      updateWasteTicketSchema.parse({ issuedOn: '2026-08-17', editSource: 'year_suggestion' }),
    ).toEqual({ issuedOn: '2026-08-17', editSource: 'year_suggestion' });
  });

  it('обычная ручная правка маркера не передаёт', () => {
    expect(updateWasteTicketSchema.parse({ issuedOn: '2026-08-17' })).toEqual({
      issuedOn: '2026-08-17',
    });
  });

  it('вместе с соседним полем отбивается схемой', () => {
    // Кнопка подсказки меняет ровно дату; маркер при номере или объёме означал бы, что сервер,
    // перестроив подсказку, подтвердил заодно и правку, о которой она ничего не говорит.
    expect(
      updateWasteTicketSchema.safeParse({
        issuedOn: '2026-08-17',
        number: '30476',
        editSource: 'year_suggestion',
      }).success,
    ).toBe(false);
    expect(
      updateWasteTicketSchema.safeParse({ volumeM3: 20, editSource: 'year_suggestion' }).success,
    ).toBe(false);
  });
});
