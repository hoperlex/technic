import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type {
  EquipmentChangeRowDto,
  EquipmentHistoryEventDto,
  EquipmentMovementRowDto,
  EquipmentRequestRowDto,
} from '@technic/contracts';

/**
 * Выгрузка истории аппарата книгой из четырёх листов (план
 * `docs/office-equipment-history-blocks-plan.md`, Р12; регрессия — §10.3, приёмка К6).
 *
 * ГЛАВНОЕ ЗДЕСЬ — НЕ НОВЫЕ ЛИСТЫ, А СТАРЫЙ. На выгрузке истории строят инвентаризацию и спор с
 * подрядчиком: файл, выданный в прошлом году, и файл, выданный сегодня, обязаны говорить об одном и
 * том же событии одними и теми же словами в одной и той же ячейке. Поэтому лист «Полная история»
 * закреплён здесь дважды — эталоном значений (снят с реализации ДО плана) и сверкой с прежней
 * однолистовой книгой, которую по сей день отдаёт маршрут.
 *
 * БАЙТЫ НЕ СРАВНИВАЮТСЯ (прямое требование §10.3): три новых листа меняют оглавление книги, связи и
 * порядок частей zip, и требовать побайтового совпадения значило бы запретить книгу вовсе. Поэтому
 * обе книги РАЗБИРАЮТСЯ, и сравниваются значения, порядок, типы (`inlineStr`) и форматы ячеек
 * (числовой формат «Текстовый» и жирная шапка), ширины колонок и закрепление шапки.
 *
 * БЕЗ БАЗЫ. Сборка листов ничего не решает про доступ — она печатает уже отобранное, — а выборки
 * блоков и ленты проверены своими db-тестами (`equipment-history-blocks.db.test.ts`,
 * `office-equipment-history-audience.db.test.ts`). Здесь проверяется ровно то, что решает эта
 * функция: что попало в ячейку и в каком порядке.
 */

// Конфиг читается из окружения при импорте модуля, поэтому значения ставим до него: сборщик книги
// в базу не ходит, но тянет за собой выборки блоков, а те — клиент БД.
Object.assign(process.env, {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://portal.test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
  JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
  COOKIE_SECRET: 'test-cookie-secret-value',
  CSRF_SECRET: 'test-csrf-secret-value',
  S3_ENDPOINT: 'https://s3.test.local',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
});

const { equipmentHistoryBookWorkbook, equipmentHistoryWorkbook } =
  await import('../src/services/office-equipment-history-export');
const { readWorkbook } = await import('../src/lib/xlsx');

// ── Что печатаем ──

const CO = { id: '11111111-1111-1111-1111-111111111111', code: 'ЦО', name: 'Центральный офис' };
const SU = { id: '22222222-2222-2222-2222-222222222222', code: 'СУ-7', name: 'Стройучасток 7' };
const REQUEST_ID = '33333333-3333-3333-3333-333333333333';

const EQUIPMENT = {
  name: 'HP LaserJet',
  inventoryNumber: 'ОТ-000145',
  serialNumber: 'CNB1234567',
};

/**
 * Лента: все шесть видов события и все четыре действия гарантии. Меньший набор заморозил бы лист
 * наполовину — а расходятся такие файлы обычно как раз на редком виде.
 */
const FEED_EVENTS: EquipmentHistoryEventDto[] = [
  {
    kind: 'card_lifecycle',
    id: 'e1',
    sortId: 'lifecycle:e1',
    occurredOn: '2026-01-15',
    recordedAt: '2026-01-15T06:00:00.000Z',
    actorName: 'Иванов И.И.',
    action: 'created',
  },
  {
    kind: 'movement',
    id: 'e2',
    sortId: 'movement:e2',
    occurredOn: '2026-02-01',
    recordedAt: '2026-02-01T07:10:00.000Z',
    actorName: 'Петров П.П.',
    fromObject: CO,
    toObject: SU,
    fromLocation: 'каб. 210',
    toLocation: 'вагончик',
    fromState: 'on_site',
    toState: 'at_service',
    toDepartmentName: 'Отдел кадров',
    reason: 'Отправлен в ремонт',
    comment: 'везли своим ходом',
    serviceRequestId: REQUEST_ID,
    serviceRequestNum: 14,
  },
  {
    kind: 'service_request',
    id: 'e3',
    sortId: 'request:e3',
    occurredOn: '2026-02-02',
    recordedAt: '2026-02-02T08:00:00.000Z',
    actorName: 'Сидоров С.С.',
    requestId: REQUEST_ID,
    displayNumber: 'СО-14',
    status: 'in_work',
    serviceName: 'ООО «Сервис»',
    totalAmount: 12500.5,
    description: 'Не печатает, полосит',
  },
  {
    kind: 'service_step',
    id: 'e4',
    sortId: 'step:e4',
    occurredOn: '2026-02-09',
    recordedAt: '2026-02-09T09:30:00.000Z',
    actorName: 'Сидоров С.С.',
    requestId: REQUEST_ID,
    displayNumber: 'СО-14',
    toStatus: 'accepted',
    comment: 'принято без замечаний',
  },
  {
    kind: 'card_change',
    id: 'e5',
    sortId: 'change:e5',
    occurredOn: '2026-02-10',
    recordedAt: '2026-02-10T10:00:00.000Z',
    actorName: 'Иванов И.И.',
    changes: [
      { field: 'location', from: 'каб. 210', to: 'вагончик' },
      // Поле, которого нет в словаре подписей: в ячейку обязано лечь сырое имя, а не пустота.
      { field: 'somethingNew', from: null, to: 'значение' },
    ],
  },
  {
    kind: 'warranty',
    id: 'e6',
    sortId: 'warranty:e6',
    occurredOn: '2026-02-11',
    recordedAt: '2026-02-11T11:00:00.000Z',
    actorName: 'Иванов И.И.',
    source: 'equipment',
    action: 'set',
    subject: 'HP LaserJet',
    from: null,
    until: '2027-02-11',
    requestId: null,
    displayNumber: null,
  },
  {
    kind: 'warranty',
    id: 'e7',
    sortId: 'warranty:e7',
    occurredOn: '2026-02-12',
    recordedAt: '2026-02-12T11:00:00.000Z',
    actorName: 'Иванов И.И.',
    source: 'equipment',
    action: 'moved',
    subject: 'HP LaserJet',
    from: '2027-02-11',
    until: '2028-02-11',
    requestId: null,
    displayNumber: null,
  },
  {
    kind: 'warranty',
    id: 'e8',
    sortId: 'warranty:e8',
    occurredOn: '2026-02-13',
    recordedAt: '2026-02-13T11:00:00.000Z',
    actorName: null,
    source: 'item',
    action: 'cleared',
    subject: 'Печка',
    from: '2026-03-01',
    until: null,
    requestId: REQUEST_ID,
    displayNumber: 'СО-14',
  },
  {
    kind: 'warranty',
    id: 'e9',
    sortId: 'warranty:e9',
    occurredOn: '2026-03-01',
    recordedAt: '2026-03-01T00:00:00.000Z',
    actorName: null,
    source: 'item',
    action: 'expired',
    subject: 'Ролик захвата',
    from: null,
    until: '2026-03-01',
    requestId: REQUEST_ID,
    displayNumber: 'СО-14',
  },
];

const REQUEST_ROWS: EquipmentRequestRowDto[] = [
  {
    id: REQUEST_ID,
    displayNumber: 'СО-14',
    kind: 'repair',
    summary: 'Не печатает, полосит',
    executors: ['ООО «Сервис»', 'Сидоров С.С.'],
    createdAt: '2026-02-02T08:00:00.000Z',
    // Вечер по Москве, но ещё вчерашний день по UTC: колонка обязана назвать 10-е, как экран.
    updatedAt: '2026-02-09T21:30:00.000Z',
    status: 'accepted',
    outcome: { code: 'accepted', label: 'Принята' },
    totalAmount: 12500.5,
    warranties: [{ itemId: 'i1', name: 'Печка', warrantyUntil: '2026-08-01' }],
    objectMismatch: true,
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    displayNumber: 'СО-15',
    kind: 'consumable',
    summary: 'Нужен картридж',
    executors: [],
    createdAt: '2026-03-01T05:00:00.000Z',
    updatedAt: '2026-03-01T05:00:00.000Z',
    status: 'new',
    outcome: { code: 'open', label: 'Ещё идёт' },
    // Заявитель: сумма вычищена проекцией аудитории — в ячейке пусто, а не «0,00 ₽».
    totalAmount: null,
    warranties: [],
    objectMismatch: false,
  },
];

const CHANGE_ROWS: EquipmentChangeRowDto[] = [
  {
    id: 'c1',
    at: '2026-02-10T18:05:00.000Z',
    actorName: 'Иванов И.И.',
    changes: [
      { field: 'location', from: 'каб. 210', to: 'вагончик' },
      { field: 'warrantyUntil', from: '11.02.2027', to: '11.02.2028' },
    ],
  },
  // Запись до появления диффа: строка есть, подробностей нет (Н5).
  { id: 'c2', at: '2026-01-20T06:00:00.000Z', actorName: null, changes: [] },
];

const MOVEMENT_ROWS: EquipmentMovementRowDto[] = [
  {
    id: 'm1',
    movedOn: '2026-02-01',
    fromObject: CO,
    toObject: SU,
    fromDepartment: { id: 'd1', code: 'ОК', name: 'Отдел кадров' },
    toDepartment: null,
    fromLocation: 'каб. 210',
    toLocation: 'вагончик',
    fromState: 'on_site',
    toState: 'with_employee',
    fromStateNote: '',
    toStateNote: 'Петров П.П.',
    reason: 'Отправлен в ремонт',
    comment: 'везли своим ходом',
    serviceRequestId: REQUEST_ID,
    serviceRequestNum: 14,
    confirmsDeclaredPlace: true,
    movedByName: 'Петров П.П.',
    createdAt: '2026-02-01T07:10:00.000Z',
  },
];

function book(over: Partial<Parameters<typeof equipmentHistoryBookWorkbook>[0]> = {}) {
  return equipmentHistoryBookWorkbook({
    events: FEED_EVENTS,
    eventsTruncated: false,
    requests: { rows: REQUEST_ROWS, truncated: false },
    changes: { rows: CHANGE_ROWS, truncated: false },
    movements: { rows: MOVEMENT_ROWS, truncated: false },
    ...over,
  });
}

function rowsOf(bytes: Uint8Array, sheet: string): string[][] {
  const found = readWorkbook(bytes).find((s) => s.name === sheet);
  if (!found) throw new Error(`в книге нет листа «${sheet}»`);
  return found.rows;
}

// ── Разбор книги до ячейки: типы и форматы словами, а не байтами ──

interface ExportCell {
  ref: string;
  value: string;
  /** Тип ячейки XLSX. `inlineStr` — текст лежит в самом листе, а не в общей таблице строк. */
  type: string;
  /** Числовой формат по стилю: «@» — Текстовый, тот, что не даёт Excel съесть ведущие нули. */
  numFmt: string;
  bold: boolean;
}

interface ExportSheet {
  name: string;
  widths: string[];
  frozen: boolean;
  autoFilter: string | null;
  cells: ExportCell[];
}

const decoder = new TextDecoder();

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/** Стили книги: числовой формат и жирность по номеру стиля ячейки. */
function stylesOf(xml: string): { numFmt: string; bold: boolean }[] {
  const bolds = [...xml.matchAll(/<font>([\s\S]*?)<\/font>/gu)].map((m) => m[1]!.includes('<b/>'));
  const cellXfs = xml.slice(xml.indexOf('<cellXfs'), xml.indexOf('</cellXfs>'));
  return [...cellXfs.matchAll(/<xf\b[^>]*\/>/gu)].map((m) => {
    const numFmtId = /numFmtId="(\d+)"/u.exec(m[0])?.[1] ?? '0';
    const fontId = Number(/fontId="(\d+)"/u.exec(m[0])?.[1] ?? '0');
    return {
      numFmt: numFmtId === '49' ? '@' : `numFmtId:${numFmtId}`,
      bold: bolds[fontId] === true,
    };
  });
}

/**
 * Книга по частям. Лист берётся по порядковому номеру, а не по связи `rId`: разбирается выдача
 * собственного писателя (`lib/xlsx.ts`), у которого лист N лежит в `sheetN.xml`, и городить ради
 * этого второй разборщик связей значило бы проверять разборщик, а не выгрузку.
 */
function parseBook(bytes: Uint8Array): ExportSheet[] {
  const files = unzipSync(bytes);
  const part = (name: string): string => {
    const raw = files[name];
    if (!raw) throw new Error(`в книге нет части ${name}`);
    return decoder.decode(raw);
  };

  const styles = stylesOf(part('xl/styles.xml'));
  const names = [...part('xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/gu)].map((m) =>
    unescapeXml(m[1]!),
  );

  return names.map((name, index) => {
    const xml = part(`xl/worksheets/sheet${index + 1}.xml`);
    const cells: ExportCell[] = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)].map((m) => {
      const attrs = m[1]!;
      const style = styles[Number(/\ss="(\d+)"/u.exec(attrs)?.[1] ?? '0')];
      return {
        ref: /\sr="([^"]+)"/u.exec(attrs)?.[1] ?? '',
        value: unescapeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/u.exec(m[2]!)?.[1] ?? ''),
        type: /\st="([^"]+)"/u.exec(attrs)?.[1] ?? '',
        numFmt: style?.numFmt ?? '',
        bold: style?.bold ?? false,
      };
    });
    return {
      name,
      widths: [...xml.matchAll(/<col\b[^>]*\swidth="([^"]*)"/gu)].map((m) => m[1]!),
      frozen: xml.includes('<pane '),
      autoFilter: /<autoFilter ref="([^"]+)"/u.exec(xml)?.[1] ?? null,
      cells,
    };
  });
}

// ── Подписи экрана: книга обязана называть то же теми же словами ──
//
// Списаны с окна истории (`apps/web/src/features/equipment-history/ui/`): вкладки —
// `EquipmentHistoryModal.tsx`, колонки — `RequestsBlock.tsx`, `ChangesBlock.tsx`,
// `MovementsBlock.tsx`. Человек выгружает то, что видит, и переименованная в файле колонка
// заставляет его гадать, та ли это цифра.

const SHEETS = ['Заявки', 'Правки', 'Перемещения', 'Полная история'];
const REQUESTS_HEADER = ['Заявка', 'Что делали', 'Даты', 'Итог'];
const CHANGES_HEADER = ['Дата', 'Что изменилось', 'Кто'];
const MOVEMENTS_HEADER = ['Дата', 'Откуда → куда', 'Почему', 'Кто'];

/**
 * Эталон листа «Полная история» — снят с реализации, которая была ДО этого плана
 * (`git show HEAD:…/office-equipment-history-export.ts` на тех же событиях). Это и есть предмет
 * §10.3: не «сборка работает», а «файл не изменился». Правка любой строки ниже означает, что
 * прошлогодняя выгрузка и сегодняшняя расходятся, — и обязана быть решением, а не следствием.
 */
const FULL_HISTORY_GOLDEN: string[][] = [
  ['Дата', 'Событие', 'Что произошло', 'Подробности', 'Кто'],
  ['15.01.2026', 'Карточка', 'Карточка заведена', '', 'Иванов И.И.'],
  [
    '01.02.2026',
    'Перемещение',
    'ЦО · каб. 210 → СУ-7 · вагончик · В ремонте',
    'Отправлен в ремонт; везли своим ходом; отдел: Отдел кадров; по заявке СО-14',
    'Петров П.П.',
  ],
  [
    '02.02.2026',
    'Обслуживание',
    'СО-14: В работе',
    'Не печатает, полосит; ООО «Сервис»; 12500.50 ₽',
    'Сидоров С.С.',
  ],
  ['09.02.2026', 'Ход заявки', 'СО-14: Закрыта', 'принято без замечаний', 'Сидоров С.С.'],
  [
    '10.02.2026',
    'Правка карточки',
    'Место: каб. 210 → вагончик; somethingNew:  → значение',
    '',
    'Иванов И.И.',
  ],
  ['11.02.2026', 'Гарантия', 'Гарантия на «HP LaserJet» до 11.02.2027', '', 'Иванов И.И.'],
  [
    '12.02.2026',
    'Гарантия',
    'Гарантия на «HP LaserJet»: 11.02.2027 → 11.02.2028',
    '',
    'Иванов И.И.',
  ],
  ['13.02.2026', 'Гарантия', 'Гарантия на «Печка» снята (была до 01.03.2026)', 'заявка СО-14', ''],
  ['01.03.2026', 'Гарантия', 'Гарантия на «Ролик захвата» истекла', 'заявка СО-14', ''],
];

describe('выгрузка истории аппарата: лист «Полная история» не изменился (§10.3, К6)', () => {
  it('значения и порядок — те же, что до плана', () => {
    expect(rowsOf(book(), 'Полная история')).toEqual(FULL_HISTORY_GOLDEN);
  });

  it('обрезка объявляется той же строкой и в той же колонке', () => {
    const rows = rowsOf(book({ eventsTruncated: true }), 'Полная история');
    expect(rows.slice(0, FULL_HISTORY_GOLDEN.length)).toEqual(FULL_HISTORY_GOLDEN);
    expect(rows.at(-1)).toEqual([
      '',
      '',
      'Показаны не все события: выгрузка ограничена по объёму',
      '',
      '',
    ]);
  });

  /**
   * Вторая половина §10.3 — сверка двух РАЗОБРАННЫХ книг: прежней однолистовой, которую маршрут
   * отдаёт по сей день, и новой. Сравниваются значения, порядок, типы и форматы ячеек, ширины
   * колонок и закрепление шапки; имя листа в сравнение не входит — его Р12 меняет намеренно
   * («Полная история» вместо «История <модель>»).
   *
   * ЧТО ИМЕННО ЭТО СТЕРЕЖЁТ: чтобы книга не начала собирать «Полную историю» ПО-СВОЕМУ. Пока обе
   * книги строит одна и та же функция листа, проверка зелена по построению — и именно поэтому она
   * упадёт в тот день, когда кто-то заведёт для книги вторую сборку «почти такого же» листа.
   * Правки, сделанные сразу в обеих, ловит эталон выше, а не она.
   *
   * Когда маршрут перейдёт на книгу, переходная функция уйдёт — и эта проверка вместе с ней.
   */
  it('совпадает с прежней однолистовой книгой по типам, форматам и ширинам', () => {
    const old = parseBook(equipmentHistoryWorkbook(EQUIPMENT, FEED_EVENTS, false))[0]!;
    const full = parseBook(book()).find((s) => s.name === 'Полная история')!;
    const compared = (sheet: ExportSheet) => ({
      widths: sheet.widths,
      frozen: sheet.frozen,
      autoFilter: sheet.autoFilter,
      cells: sheet.cells,
    });
    // Разбор обязан что-то найти: сравнение двух пустых списков сошлось бы и на пустой книге.
    expect(full.cells.length).toBe(FULL_HISTORY_GOLDEN.flat().filter(Boolean).length);
    expect(compared(full)).toEqual(compared(old));
  });

  it('шапка жирная, тело — обычное, всё текстом и текстовым форматом', () => {
    const full = parseBook(book()).find((s) => s.name === 'Полная история')!;
    expect(full.cells.every((cell) => cell.type === 'inlineStr' && cell.numFmt === '@')).toBe(true);
    expect(full.cells.filter((cell) => cell.bold).map((cell) => cell.ref)).toEqual([
      'A1',
      'B1',
      'C1',
      'D1',
      'E1',
    ]);
    expect(full.widths).toEqual(['12', '18', '60', '50', '24']);
    expect(full.frozen).toBe(true);
  });
});

describe('выгрузка истории аппарата: три листа блоков (Р12)', () => {
  it('листы названы вкладками экрана и идут их порядком', () => {
    expect(readWorkbook(book()).map((s) => s.name)).toEqual(SHEETS);
  });

  it('лист «Заявки» повторяет строки блока и подписи его колонок', () => {
    expect(rowsOf(book(), 'Заявки')).toEqual([
      REQUESTS_HEADER,
      [
        'СО-14; Закрыта; Обслуживание',
        'Не печатает, полосит; ООО «Сервис», Сидоров С.С.; Печка — гарантия до 01.08.2026; Место не подтверждено',
        '02.02.2026; изменена 10.02.2026',
        'Принята; 12500.50 ₽',
      ],
      [
        'СО-15; Новая; Расходники',
        'Нужен картридж; Исполнитель не назначен',
        '01.03.2026; изменена 01.03.2026',
        'Ещё идёт',
      ],
    ]);
  });

  it('лист «Правки» повторяет строки блока, включая запись без подробностей', () => {
    expect(rowsOf(book(), 'Правки')).toEqual([
      CHANGES_HEADER,
      [
        '10.02.2026 21:05',
        'Место: каб. 210 → вагончик; Гарантия поставщика: 11.02.2027 → 11.02.2028',
        'Иванов И.И.',
      ],
      ['20.01.2026 09:00', 'Правка без подробностей', '—'],
    ]);
  });

  it('лист «Перемещения» повторяет строку журнала целиком', () => {
    expect(rowsOf(book(), 'Перемещения')).toEqual([
      MOVEMENTS_HEADER,
      [
        '01.02.2026',
        'ЦО · каб. 210 → СУ-7 · вагончик · У сотрудника (Петров П.П.); Отдел: Отдел кадров → не закреплена',
        'Отправлен в ремонт; везли своим ходом; СО-14; Место подтверждено',
        'Петров П.П.',
      ],
    ]);
  });

  it('каждый упёршийся в потолок лист говорит об этом последней строкой', () => {
    const bytes = book({
      requests: { rows: REQUEST_ROWS, truncated: true },
      changes: { rows: CHANGE_ROWS, truncated: true },
      movements: { rows: MOVEMENT_ROWS, truncated: true },
    });
    const note = 'Показаны не все строки: выгрузка ограничена по объёму';
    for (const sheet of ['Заявки', 'Правки', 'Перемещения']) {
      expect(rowsOf(bytes, sheet).at(-1)?.[1]).toBe(note);
    }
    // Лента здесь не обрезана — и молчит: обрезку объявляет тот лист, который в потолок упёрся.
    expect(rowsOf(bytes, 'Полная история')).toEqual(FULL_HISTORY_GOLDEN);
  });

  it('листы блоков размечены так же, как лист ленты: шапка жирная, ячейки текстовые', () => {
    for (const sheet of parseBook(book())) {
      expect(sheet.frozen).toBe(true);
      expect(sheet.cells.every((cell) => cell.type === 'inlineStr' && cell.numFmt === '@')).toBe(
        true,
      );
      expect(sheet.cells.filter((cell) => cell.bold).every((cell) => cell.ref.endsWith('1'))).toBe(
        true,
      );
    }
  });
});

describe('выгрузка истории аппарата: доступ книгой не расширяется (Р12)', () => {
  /**
   * Без `serviceRequests.read` лист «Заявки» остаётся на месте — топология книги фиксирована и о
   * правах читателя не рассказывает, — но сервисных данных на нём нет ни одной ячейки. Лента у
   * такого читателя приходит без сервисных событий (это делает выборка, `office-equipment-history.ts`),
   * поэтому и в книге их быть неоткуда: проверяется вся книга целиком, а не один лист.
   */
  it('лист «Заявки» существует, но несёт одну строку отказа и ни номера, ни суммы', () => {
    const bytes = book({
      requests: null,
      // Так эту же ленту отдаёт выборка читателю без права: сервисных событий в ней нет вовсе.
      events: FEED_EVENTS.filter(
        (event) =>
          event.kind !== 'service_request' &&
          event.kind !== 'service_step' &&
          !(event.kind === 'warranty' && event.source === 'item'),
      ),
    });
    expect(readWorkbook(bytes).map((s) => s.name)).toEqual(SHEETS);
    expect(rowsOf(bytes, 'Заявки')).toEqual([
      REQUESTS_HEADER,
      ['Нет доступа к заявкам', '', '', ''],
    ]);

    // Ни одной суммы во всей книге. Номер заявки при этом остаётся в журнале перемещений («уехал
    // по заявке СО-14») — там он и сегодня виден без права на заявки, и новых правил видимости
    // книга не заводит; ужесточить это значило бы решить за модуль перемещений.
    const printed = parseBook(bytes)
      .flatMap((sheet) => sheet.cells)
      .map((cell) => cell.value);
    expect(printed.some((value) => value.includes('₽'))).toBe(false);
  });
});
