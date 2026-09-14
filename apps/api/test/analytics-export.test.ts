import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsQualityEntry } from '@technic/contracts';
import { readWorkbook, type SheetOutput } from '../src/lib/xlsx';
import type { AnalyticsAtom } from '../src/services/analytics/types';

/**
 * Книга сводной аналитики (`docs/analytics-summary-export-plan.md`, §3).
 *
 * Проверяется **состав книги, а не расчёт**: счётчики и деньги считает слой аналитики
 * (`analytics-facts-*.db.test.ts`, `analytics-rollup.test.ts`), и второго ответа на «сколько смен»
 * тест заводить не должен. Поэтому выборка подменена, атомы известны наизусть, а утверждать можно
 * про саму книгу: какие листы и в каком порядке, где прочерк, сходится ли скрытый лист со сводом и
 * описана ли каждая колонка методикой.
 *
 * Разбирается книга тем же `readWorkbook`, которым портал читает чужие книги: байты zip проверять
 * бессмысленно, а состав листов — ровно то, что увидит человек, открывший файл.
 */

const OB1 = '11111111-1111-4111-8111-111111111111';
const OB2 = '22222222-2222-4222-8222-222222222222';
const DEP = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({
  atoms: [] as unknown[],
  quality: [] as unknown[],
}));

/*
 * Подменяется вся сборка свода: книга обязана ходить за атомами ровно один раз (Р13, ADR 0180 §4),
 * и подмена с одним источником — заодно проверка этого. `buildAnalyticsSummary` подменён отказом:
 * позови его книга вторым обращением к базе за теми же днями, тест упал бы на месте.
 */
vi.mock('../src/services/analytics/summary', () => ({
  assertAnalyticsQuery: () => undefined,
  loadAnalyticsAtoms: async () => ({ atoms: state.atoms, quality: state.quality }),
  buildAnalyticsSummary: async () => {
    throw new Error('Книга собирается из атомов, а не вторым запросом свода');
  },
}));

/*
 * Лист инфографики НЕ подменяется: книга с выбранной площадкой — это единственный пакет, где рядом
 * живут кэш сводной и рисунок с четырнадцатью диаграммами, и собираться он обязан здесь, а не
 * впервые у человека. Подменённый лист проверял бы форму мока вместо формы книги.
 */

const { buildAnalyticsExport } = await import('../src/services/analytics-export');

// ── Атомы ──

function atom(partial: Partial<AnalyticsAtom> & Pick<AnalyticsAtom, 'module'>): AnalyticsAtom {
  return {
    customerKind: 'object',
    customerId: OB1,
    customerCode: 'ОБ-014',
    customerName: 'Северная 12',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2026-08-03',
    positionKey: 'p1',
    positionLabel: 'А123ВС 78 КамАЗ 65115',
    registrationNumber: 'А123ВС78',
    requestId: 'r1',
    requestLabel: 'ТС-40',
    requestStatus: 'completed',
    shifts: 0,
    planShifts: 0,
    trips: 0,
    volumeM3: 0,
    weightTons: 0,
    engineHours: 0,
    mechHours: 0,
    mechDays: 0,
    removals: 0,
    containerOps: 0,
    relocations: 0,
    moneyFact: 0,
    moneyLow: 0,
    moneyHigh: 0,
    priced: true,
    ...partial,
  };
}

/**
 * Три заказчика: объект с работой трёх разрядов, объект с одним вывозом и отдел с перевозками.
 * Отдел здесь не для полноты — на нём проверяется и порядок строк (объекты первыми, Р4), и
 * прочерк в разряде, которого у заказчика нет вовсе.
 */
function sampleAtoms(): AnalyticsAtom[] {
  return [
    atom({ module: 'freight', shifts: 1, trips: 3, volumeM3: 40, moneyFact: 12_000 }),
    atom({
      module: 'freight',
      date: '2026-07-28',
      shifts: 1,
      trips: 2,
      weightTons: 12,
      moneyFact: 8000,
    }),
    atom({
      module: 'onsite',
      positionKey: 'p2',
      positionLabel: 'Е777КХ 78 Экскаватор Hitachi',
      registrationNumber: 'Е777КХ78',
      requestId: 'r2',
      requestLabel: 'ТС-41',
      requestStatus: 'confirmed',
      shifts: 1,
      // День срока, на который смену завели: план и факт лежат на ОДНОМ атоме — второй удвоил бы
      // верхнюю оценку этого дня (Р29).
      planShifts: 1,
      engineHours: 9.5,
      moneyLow: 5000,
      moneyHigh: 7000,
      priced: true,
    }),
    atom({
      // Голый день срока: смены на него не завели, а план он даёт всё равно (Р7, Р29) — иначе
      // колонка отвечала бы про старательность учётчика, а не про срок заказа.
      module: 'onsite',
      date: '2026-08-05',
      positionKey: 'p2',
      positionLabel: 'Е777КХ 78 Экскаватор Hitachi',
      registrationNumber: 'Е777КХ78',
      requestId: 'r2',
      requestLabel: 'ТС-41',
      requestStatus: 'confirmed',
      planShifts: 1,
      moneyHigh: 3000,
    }),
    atom({
      module: 'onsite',
      date: '2026-08-04',
      positionKey: 'p2',
      positionLabel: 'Е777КХ 78 Экскаватор Hitachi',
      registrationNumber: 'Е777КХ78',
      requestId: 'r2',
      requestLabel: 'ТС-41',
      requestStatus: 'confirmed',
      relocations: 1,
    }),
    atom({
      module: 'waste',
      positionKey: 'w1',
      positionLabel: 'Строительный мусор · самосвал 20 м³',
      registrationNumber: null,
      requestId: 'r3',
      requestLabel: 'М-12',
      removals: 1,
      volumeM3: 20,
      moneyFact: 7200,
    }),
    atom({
      module: 'waste',
      customerId: OB2,
      customerCode: 'ОБ-021',
      customerName: 'Парковая 4',
      positionKey: 'w1',
      positionLabel: 'ТКО · контейнер 8 м³',
      registrationNumber: null,
      requestId: 'r4',
      requestLabel: 'М-13',
      removals: 1,
      volumeM3: 8,
      moneyFact: 3000,
      priced: false,
    }),
    atom({
      module: 'freight',
      customerKind: 'department',
      customerId: DEP,
      customerCode: 'ОТД-03',
      customerName: 'Снабжение',
      requestId: 'r5',
      requestLabel: 'ТС-42',
      shifts: 1,
      trips: 1,
      volumeM3: 5,
      moneyFact: 4000,
    }),
  ];
}

const QUALITY: AnalyticsQualityEntry[] = [
  {
    key: 'onsite.shifts-unapproved',
    label: 'Смен на объекте без визы площадки',
    value: 14,
    outOf: 52,
    note: 'Часть работы не подтверждена заказчиком',
  },
  {
    key: 'vehicle.requests-unpriced',
    label: 'Заявок на технику без цены назначения',
    value: 3,
    outOf: null,
    note: 'В деньги не вошли ни фактом, ни оценкой',
  },
];

// ── Книга ──

interface Book {
  sheets: SheetOutput[];
  bytes: Uint8Array;
}

async function book(chartObjectId?: string): Promise<Book> {
  state.atoms = sampleAtoms();
  state.quality = QUALITY;
  const result = await buildAnalyticsExport(
    { from: '2026-07-01', to: '2026-08-31', step: 'month', chartObjectId },
    { actor: 'Петров П.П. (admin@dev.local)', at: '11.09.2026 18:20' },
  );
  return { sheets: readWorkbook(result.bytes), bytes: result.bytes };
}

function sheet(sheets: SheetOutput[], name: string): string[][] {
  const found = sheets.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Лист «${name}» не найден`);
  return found.rows;
}

/** Индекс колонки по подписи нижнего этажа шапки: тест не должен знать порядок колонок наизусть. */
function columnOf(header: string[], title: string): number {
  const index = header.indexOf(title);
  if (index === -1) throw new Error(`Колонка «${title}» не найдена`);
  return index;
}

function part(bytes: Uint8Array, path: string): string {
  const file = unzipSync(bytes)[path];
  if (file === undefined) throw new Error(`В книге нет части ${path}`);
  return new TextDecoder().decode(file);
}

describe('книга сводной аналитики', () => {
  it('семь листов в заданном порядке, инфографики нет без выбранной площадки', async () => {
    const { sheets } = await book();

    // Лист инфографики отсутствует, и это законное состояние книги, а не сбой (Р12а).
    expect(sheets.map((item) => item.name)).toEqual([
      'Свод',
      'Детализация',
      'Данные',
      'Сводная',
      'Качество',
      'Параметры',
    ]);
  });

  it('с выбранной площадкой лист инфографики третий, а имя площадки — в первой строке', async () => {
    const { sheets } = await book(OB1);

    expect(sheets.map((item) => item.name)).toEqual([
      'Свод',
      'Детализация',
      'Инфографика',
      'Данные',
      'Сводная',
      'Качество',
      'Параметры',
    ]);
    // Имя листа ставит сборщик (потолок 31 знак, имя уходит в формулы и в ссылки графиков), а
    // название площадки живёт заголовком настоящего листа — его и читаем.
    expect(sheet(sheets, 'Инфографика')[0]?.[0]).toBe('Инфографика: ОБ-014 Северная 12');
  });

  it('шапка свода в два этажа со слитыми ячейками', async () => {
    const { sheets, bytes } = await book();
    const rows = sheet(sheets, 'Свод');
    const groups = rows[2] ?? [];
    const titles = rows[3] ?? [];

    expect(groups[0]).toBe('Заказчик');
    expect(titles[0]).toBe('Объект / отдел');
    // Верхний этаж — разряд работы, нижний — показатель; под разрядом пусто до конца его группы.
    expect(groups[1]).toBe('Перевозки');
    expect(groups[2]).toBe('');
    expect(titles.slice(1, 6)).toEqual(['смен', 'ед.', 'ездок', 'м³', 'т']);

    const xml = part(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<mergeCell ref="B3:F3"/>');
    // Ось строк слита по вертикали: два слова над одной колонкой читались бы как две колонки.
    expect(xml).toContain('<mergeCell ref="A3:A4"/>');
  });

  it('подытоги и «Всего» сходятся со строками свода', async () => {
    const { sheets } = await book();
    const rows = sheet(sheets, 'Свод');
    const titles = rows[3] ?? [];
    const fact = columnOf(titles, 'факт');
    const lower = columnOf(titles, 'итого ниж.');
    const money = (label: string, column: number): number => {
      const row = rows.find((item) => item[0] === label);
      if (row === undefined) throw new Error(`Строки «${label}» нет`);
      return Number(row[column]);
    };

    // Объекты идут раньше отделов (Р4), подытог стоит под своей группой.
    expect(rows.map((row) => row[0]).filter(Boolean)).toEqual([
      'Сводная аналитика по заказчикам за 01.07.2026 – 31.08.2026',
      'Заказчик',
      'Объект / отдел',
      'ОБ-014 Северная 12',
      'ОБ-021 Парковая 4',
      'Итого по объектам',
      'ОТД-03 Снабжение',
      'Итого по отделам',
      'Всего',
    ]);

    expect(money('Итого по объектам', fact)).toBe(
      money('ОБ-014 Северная 12', fact) + money('ОБ-021 Парковая 4', fact),
    );
    expect(money('Всего', fact)).toBe(
      money('Итого по объектам', fact) + money('Итого по отделам', fact),
    );
    // «Итого ниж.» — факт плюс нижняя оценка: вилка обязана сходиться и в подытоге.
    expect(money('Всего', lower)).toBe(
      money('Итого по объектам', lower) + money('Итого по отделам', lower),
    );
  });

  it('прочерк стоит там, где величины у разряда не бывает', async () => {
    const { sheets } = await book();
    const summary = sheet(sheets, 'Свод');
    const titles = summary[3] ?? [];
    const department = summary.find((row) => row[0] === 'ОТД-03 Снабжение') ?? [];

    // Отделу вывоз мусора не заказывают вовсе: ноль читался бы как «возили, да ничего не вывезли».
    expect(department[columnOf(titles, 'вывозов')]).toBe('—');
    expect(department[columnOf(titles, 'конт. опер.')]).toBe('—');
    // А перевозки у него есть, и там стоит число.
    expect(Number(department[columnOf(titles, 'ездок')])).toBe(1);

    const detail = sheet(sheets, 'Детализация');
    const detailTitles = detail[2] ?? [];
    const onsite = detail.find((row) => row[0] === 'Техника на объекте') ?? [];
    // У работы на площадке не бывает ездок и объёма — это `null` в счётчиках, а не ноль (Р16).
    expect(onsite[columnOf(detailTitles, 'Ездок')]).toBe('—');
    expect(onsite[columnOf(detailTitles, 'м³')]).toBe('—');
    expect(Number(onsite[columnOf(detailTitles, 'Мото-ч')])).toBe(9.5);
  });

  it('детализация показывает перегоны счётчиком и план смен отдельной строкой', async () => {
    const { sheets } = await book();
    const rows = sheet(sheets, 'Детализация');
    const titles = rows[2] ?? [];
    const relocations = rows.find((row) => row[0]?.startsWith('перегонов')) ?? [];

    // Перегон — счётчик, а не смена (Р27): в перевозках он удвоил бы работу, а спрятанный целиком
    // скрыл бы стоимость доставки техники на площадку.
    expect(Number(relocations[columnOf(titles, 'Перегонов')])).toBe(1);
    expect(relocations[columnOf(titles, 'Смен')]).toBe('—');
    // Позиция блока названа машиной, и гос. номер стоит своей колонкой.
    const position = rows.find((row) => row[0] === 'Е777КХ 78 Экскаватор Hitachi') ?? [];
    expect(position[columnOf(titles, 'Гос. номер')]).toBe('Е777КХ78');
  });

  it('план смен стоит числом рядом с фактом, а разница названа словами', async () => {
    const { sheets } = await book();
    const rows = sheet(sheets, 'Детализация');
    const titles = rows[2] ?? [];
    const onsite = rows.find((row) => row[0] === 'Техника на объекте') ?? [];
    const plan = rows.find((row) => row[0]?.startsWith('план смен')) ?? [];

    // Два дня срока против одной заполненной смены: план считается по СРОКУ, и голый день срока
    // даёт его так же, как день со сменой (Р7, Р29).
    expect(Number(onsite[columnOf(titles, 'Смен')])).toBe(1);
    expect(Number(onsite[columnOf(titles, 'План смен')])).toBe(2);
    expect(Number(plan[columnOf(titles, 'План смен')])).toBe(2);
    // Разница названа в подписи: вычитать в уме читателю не приходится.
    expect(plan[0]).toContain('заполнено 1');
    expect(plan[0]).toContain('без смены 1');
    // У позиции план тоже свой: день срока несёт машину ЭТОГО дня, ту же, на которую ляжет смена.
    const position = rows.find((row) => row[0] === 'Е777КХ 78 Экскаватор Hitachi') ?? [];
    expect(Number(position[columnOf(titles, 'План смен')])).toBe(2);
    // У разрядов без срока плана не бывает вовсе — прочерк, а не ноль (Р16).
    const freight = rows.find((row) => row[0] === 'Перевозки') ?? [];
    expect(freight[columnOf(titles, 'План смен')]).toBe('—');
  });

  it('скрытый лист «Данные» сходится со сводом строка в строку', async () => {
    const { sheets, bytes } = await book();
    const summary = sheet(sheets, 'Свод');
    const titles = summary[3] ?? [];
    const data = sheet(sheets, 'Данные');
    const dataTitles = data[0] ?? [];
    const customer = columnOf(dataTitles, 'Заказчик');
    const module = columnOf(dataTitles, 'Разряд работы');
    const factColumn = columnOf(dataTitles, '₽ факт');
    const shiftsColumn = columnOf(dataTitles, 'Смен');

    for (const row of summary.slice(4)) {
      const label = row[0] ?? '';
      if (!label.startsWith('ОБ-') && !label.startsWith('ОТД-')) continue;
      const own = data.slice(1).filter((item) => item[customer] === label);
      const fact = own.reduce((total, item) => total + Number(item[factColumn]), 0);
      const freightShifts = own
        .filter((item) => item[module] === 'Перевозки')
        .reduce((total, item) => total + Number(item[shiftsColumn] || 0), 0);

      expect(fact).toBe(Number(row[columnOf(titles, 'факт')]));
      /*
       * `columnOf` находит первую колонку «смен» — перевозочную: ими шапка и начинается. Прочерк
       * в ней означает «перевозок у заказчика нет вовсе», и на скрытом листе им отвечает
       * отсутствие строк, а не ноль.
       */
      const shiftsCell = row[columnOf(titles, 'смен')];
      expect(freightShifts).toBe(shiftsCell === '—' ? 0 : Number(shiftsCell));
    }

    // Лист служебный: человеку он не нужен, а сводная без него пуста.
    const xml = part(bytes, 'xl/workbook.xml');
    expect(xml).toMatch(/<sheet name="Данные"[^>]*state="hidden"/u);
    expect(Object.keys(unzipSync(bytes))).toContain('xl/pivotTables/pivotTable1.xml');
  });

  it('неизвестное число листа «Данные» — пустая ячейка, а не прочерк', async () => {
    const { sheets } = await book();
    const data = sheet(sheets, 'Данные');
    const titles = data[0] ?? [];
    const waste =
      data.slice(1).find((row) => row[columnOf(titles, 'Разряд работы')] === 'Вывоз мусора') ?? [];

    // У вывоза не бывает смен и моточасов; прочерк сделал бы поле кэша сводной смешанным, и
    // колонка перестала бы складываться.
    expect(waste[columnOf(titles, 'Смен')]).toBe('');
    expect(waste[columnOf(titles, 'Мото-ч')]).toBe('');
    // Плана у вывоза не бывает тем более: срока заказа там нет вовсе.
    expect(waste[columnOf(titles, 'План смен')]).toBe('');
    // А голый день срока на площадке несёт план и без смены — сводная сравнит их мышью.
    const bare = data.slice(1).find((row) => row[columnOf(titles, 'Дата')] === '05.08.2026') ?? [];
    expect(Number(bare[columnOf(titles, 'План смен')])).toBe(1);
    expect(Number(bare[columnOf(titles, 'Смен')])).toBe(0);
    expect(Number(waste[columnOf(titles, 'м³')])).toBe(20);
    // Отрезок периода подписан своим шагом — по нему сводная строит колонки.
    expect(waste[columnOf(titles, 'Отрезок периода')]).toBe('08.2026');
  });

  it('на листе «Качество» доля считается только при непустом знаменателе', async () => {
    const rows = sheet((await book()).sheets, 'Качество');
    const values = new Map(rows.map((row) => [row[0], row.slice(1)]));

    expect(values.get('Смен на объекте без визы площадки')?.[0]).toBe('14 из 52 (27 %)');
    expect(values.get('Заявок на технику без цены назначения')?.[0]).toBe('3');
    expect(values.get('Смен на объекте без визы площадки')?.[1]).toContain('не подтверждена');
  });

  it('параметры называют период, шаг, площадку и описывают методикой все колонки свода', async () => {
    const { sheets } = await book();
    const summary = sheet(sheets, 'Свод');
    const rows = sheet(sheets, 'Параметры');
    const values = new Map(rows.map((row) => [row[0], row[1]]));

    expect(values.get('Период с')).toBe('01.07.2026');
    expect(values.get('Период по')).toBe('31.08.2026');
    expect(values.get('Шаг периода')).toBe('Месяц');
    expect(values.get('Выгрузил')).toBe('Петров П.П. (admin@dev.local)');
    expect(values.get('Площадка инфографики')).toContain('не выбрана');
    // Счётчики названы тем, что считают: строк на листах больше, чем заказчиков и позиций.
    expect(Number(values.get('Заказчиков в своде'))).toBe(3);
    expect(Number(values.get('Строк листа «Данные» (атомов)'))).toBe(
      sheet(sheets, 'Данные').length - 1,
    );
    const detail = sheet(sheets, 'Детализация');
    const positions = Number(values.get('Позиций в детализации'));
    expect(positions).toBe(5);
    // Подпись и число отвечают про одно: строк на листе заведомо больше, чем позиций.
    expect(detail.length).toBeGreaterThan(positions);

    /*
     * Методика описывает КАЖДУЮ колонку свода (Р19) — сверяется числом строк, а не текстами:
     * тексты правятся при каждой редакции, а забытая колонка — это спор о том, что такое смена, в
     * следующей же редакции. Строк на одну больше: план смен в свод не идёт (там и без него
     * двадцать с лишним колонок), но объяснён наравне с остальными.
     */
    const start = rows.findIndex((row) => row[0] === 'Колонка' && row[1] === 'Что считается');
    expect(start).toBeGreaterThan(0);
    const method = rows.slice(start + 1).filter((row) => (row[0] ?? '') !== '');
    expect(method).toHaveLength((summary[3] ?? []).length - 1 + 1);
    expect(method.some((row) => row[0]?.includes('план смен'))).toBe(true);
    // Каждая строка методики отвечает на все четыре вопроса: что, откуда, каким днём, что не входит.
    for (const row of method) expect(row.slice(0, 5).every((cell) => cell !== '')).toBe(true);
  });

  it('кнопка сворачивания относится к своей группе, а не к следующему блоку', async () => {
    const { bytes } = await book();
    const detail = part(bytes, 'xl/worksheets/sheet2.xml');

    /*
     * Итога под группой на этом листе нет: блок кончается пустой строкой и заголовком следующего
     * заказчика, а итог стоит сверху. Обещай книга обратное, Excel повесил бы «минус» позиций
     * «Перевозок» на строку «Вывоз мусора».
     */
    expect(detail).toContain('<sheetPr><outlinePr summaryBelow="0"/></sheetPr>');
    // Проверка чего-то стоит только при живой группировке: уровни на листе есть.
    expect(detail).toMatch(/outlineLevel="2"/u);
    // На листах без группировки обещания не даётся вовсе.
    expect(part(bytes, 'xl/worksheets/sheet1.xml')).not.toContain('outlinePr');
  });

  it('книга с инфографикой собирается целиком: графики, сводная и скрытый лист рядом', async () => {
    const { sheets, bytes } = await book(OB1);
    const parts = Object.keys(unzipSync(bytes));
    const charts = parts.filter((name) => /^xl\/charts\/chart\d+\.xml$/u.test(name));

    /*
     * Это ровно тот пакет, который получит человек: сводная с полным кэшем и лист с диаграммами в
     * одной книге. Порознь они собирались и раньше, а вместе делят файл связей листа и
     * `[Content_Types].xml` — и молча затирали бы друг друга.
     *
     * Графиков меньше четырнадцати: варианты по механизации в этом наборе атомов не рисуются,
     * потому что аренд в периоде нет. Витрина показывает то, о чём есть данные.
     */
    expect(charts.length).toBeGreaterThanOrEqual(12);
    expect(parts).toContain('xl/drawings/drawing1.xml');
    expect(parts).toContain('xl/drawings/_rels/drawing1.xml.rels');
    expect(parts).toContain('xl/pivotCache/pivotCacheRecords1.xml');
    expect(parts).toContain('xl/pivotTables/pivotTable1.xml');

    // Файл связей у листа один: рисунок назван у инфографики, сводная — у своего листа.
    expect(part(bytes, 'xl/worksheets/_rels/sheet3.xml.rels')).toContain(
      '../drawings/drawing1.xml',
    );
    expect(part(bytes, 'xl/worksheets/sheet3.xml')).toContain('<drawing r:id="rId1"/>');
    expect(part(bytes, 'xl/worksheets/_rels/sheet5.xml.rels')).toContain(
      '../pivotTables/pivotTable1.xml',
    );

    // Незаявленную часть Excel считает повреждением книги, а не лишним файлом.
    const types = part(bytes, '[Content_Types].xml');
    for (const name of [...charts, 'xl/drawings/drawing1.xml', 'xl/pivotTables/pivotTable1.xml']) {
      expect(types).toContain(`PartName="/${name}"`);
    }

    // Кэш сводной пишется целиком: с пустым кэшем лист оживает только в Excel (ADR 0180 §3).
    expect(part(bytes, 'xl/pivotCache/pivotCacheRecords1.xml')).toContain('<r>');
    expect(part(bytes, 'xl/pivotCache/pivotCacheDefinition1.xml')).toContain('ОБ-014 Северная 12');

    // И лист инфографики несёт числа площадки, а не один заголовок: серии графиков ссылаются на
    // эти клетки, и пустая таблица нарисовала бы четырнадцать пустых рамок.
    const info = sheet(sheets, 'Инфографика');
    expect(info.some((row) => row[0] === '08.2026')).toBe(true);
    expect(sheets).toHaveLength(7);
  });

  it('имя файла названо человеку — периодом, а не ключом', async () => {
    state.atoms = sampleAtoms();
    state.quality = QUALITY;
    const result = await buildAnalyticsExport({
      from: '2026-08-01',
      to: '2026-08-31',
      step: 'month',
    });

    expect(result.filename).toBe('Сводная аналитика 01.08.2026 – 31.08.2026.xlsx');
  });
});
