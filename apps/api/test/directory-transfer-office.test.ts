import { describe, expect, it, vi } from 'vitest';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Описания справочников оргтехники для обмена файлом (ADR 0073, ADR 0085): перечень типов и сами
 * единицы.
 *
 * Проверяется то, ради чего описание и существует: файл, который портал только что отдал, он же
 * обязан принять без единой правки, а строка, которую в базу пускать нельзя, обязана отвергаться
 * человеческими словами и до записи. Правила у оргтехники не свои: их задают CHECK
 * `office_equipment_identity_check` («хотя бы один номер») и частичные уникальные индексы по
 * `upper(btrim(...))` среди неудалённых карточек — и вместо имени ограничения человек должен
 * прочитать, какой номер занят и кем.
 *
 * База не поднимается: описание — это правила разбора и печати ячеек, а ссылки на соседние
 * справочники приходят из `env`, который здесь собран руками.
 */

// Модуль тянет клиент БД (запросы выгрузки), а тот — конфиг. Значения ставятся до импорта, чтобы
// модуль вообще загрузился: соединение пул открывает лениво, и без запросов оно не понадобится.
vi.hoisted(() => {
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
});

const { officeDirectories } = await import('../src/services/directory-transfer/defs/office');

function directoryFor(key: string): AnyDirectory {
  const found = officeDirectories.find((d) => d.key === key);
  if (!found) throw new Error(`описания справочника «${key}» нет в списке`);
  return found;
}

const typesDir = directoryFor('office-equipment-types');
const equipmentDir = directoryFor('office-equipment');

/** Ячейки строки файла по заголовкам колонок — то же, чем оперирует движок. */
type Cells = Record<string, string>;

interface TestContext extends RowContext {
  problems: string[];
  warnings: string[];
}

function testContext(row = 12): TestContext {
  const problems: string[] = [];
  const warnings: string[] = [];
  return {
    row,
    problems,
    warnings,
    fail: (message) => problems.push(message),
    warn: (message) => warnings.push(message),
  };
}

/** Модель в ячейки — то же, что делает выгрузка. */
function cellsOf(dir: AnyDirectory, env: unknown, model: unknown): Cells {
  const out: Cells = {};
  for (const column of dir.columns(env)) out[column.header] = column.get(model);
  return out;
}

/** Ячейки в модель — тот же обход колонок, что и в движке при разборе строки. */
function applyCells(
  dir: AnyDirectory,
  env: unknown,
  model: unknown,
  cells: Cells,
  ctx: RowContext,
): void {
  for (const column of dir.columns(env)) {
    const text = cells[column.header];
    if (text === undefined || !column.set) continue;
    column.set(model, text, ctx);
  }
}

/**
 * Круг «строка справочника → файл → строка справочника»: выгруженные ячейки разбираются поверх
 * пустой модели и печатаются снова. Расхождение означает, что повторная загрузка выгруженного
 * файла показала бы правку, которой никто не делал.
 */
function roundTrip(
  dir: AnyDirectory,
  env: unknown,
  row: unknown,
): { before: Cells; after: Cells; ctx: TestContext } {
  const before = cellsOf(dir, env, dir.model(row, env));
  const model = dir.blank();
  const ctx = testContext();
  applyCells(dir, env, model, before, ctx);
  return { before, after: cellsOf(dir, env, model), ctx };
}

const AT = new Date('2026-08-10T10:00:00.000Z');

// ── Типы оргтехники ───────────────────────────────────────────────────────────────────────────

const typeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'mfp',
  name: 'МФУ',
  sortOrder: 10,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};

describe('типы оргтехники в обмене файлом', () => {
  it('строка переживает выгрузку и загрузку без единой правки', () => {
    const { before, after, ctx } = roundTrip(typesDir, {}, typeRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
  });

  it('код кириллицей отвергается с объяснением формата', () => {
    const ctx = testContext();
    const model = typesDir.blank();
    applyCells(typesDir, {}, model, { Код: 'МФУ', Наименование: 'МФУ' }, ctx);
    expect(ctx.problems).toHaveLength(1);
    expect(ctx.problems[0]).toMatch(/латинские строчные буквы/u);
  });

  it('код в один знак отвергается: столько же требует и форма перечня', () => {
    const ctx = testContext();
    const model = typesDir.blank();
    applyCells(typesDir, {}, model, { Код: 'm' }, ctx);
    expect(ctx.problems).toHaveLength(1);
    expect(ctx.problems[0]).toMatch(/не короче двух знаков/u);
  });

  it('прописной код приводится к строчному, а не заводит второй тип', () => {
    const ctx = testContext();
    const model = typesDir.blank();
    applyCells(typesDir, {}, model, { Код: 'MFP', Наименование: 'МФУ' }, ctx);
    expect(ctx.problems).toEqual([]);
    expect(typesDir.keyOf(model)).toBe('mfp');
  });

  it('строка без кода и без наименования не заводится', () => {
    const ctx = testContext();
    const model = typesDir.blank();
    typesDir.check?.(model, ctx, {});
    expect(ctx.problems).toEqual([
      'строка без кода не заводится: по нему она и ищется в справочнике',
      'строка без наименования не заводится',
    ]);
  });

  it('пустая ячейка заведённое не стирает', () => {
    const model = typesDir.model(typeRow, {});
    const ctx = testContext();
    applyCells(typesDir, {}, model, { Наименование: '', Порядок: '', Активен: '' }, ctx);
    expect(ctx.problems).toEqual([]);
    expect(cellsOf(typesDir, {}, model)).toEqual(
      cellsOf(typesDir, {}, typesDir.model(typeRow, {})),
    );
  });
});

// ── Оргтехника ────────────────────────────────────────────────────────────────────────────────

const MFP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TYPE_ID = '11111111-1111-4111-8111-111111111112';
const OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const KYOCERA_ID = '44444444-4444-4444-8444-444444444444';
const LAPTOP_ID = '55555555-5555-4555-8555-555555555555';

/** Соседние справочники в том виде, в каком их читает описание оргтехники. */
const equipmentEnv = {
  types: new Map([
    ['mfp', { id: MFP_ID, name: 'МФУ', isActive: true }],
    // Погашенный тип: он остаётся у заведённых карточек, и файл на нём не спотыкается.
    ['plotter', { id: OTHER_TYPE_ID, name: 'Плоттер', isActive: false }],
  ]),
  typeCodeById: new Map([
    [MFP_ID, 'mfp'],
    [OTHER_TYPE_ID, 'plotter'],
  ]),
  objectIdByCode: new Map([['АЛ13', OBJECT_ID]]),
  objectCodeById: new Map([[OBJECT_ID, 'АЛ13']]),
  departmentIdByCode: new Map([['pto', DEPARTMENT_ID]]),
  departmentCodeById: new Map([[DEPARTMENT_ID, 'pto']]),
  bySerial: new Map([
    ['VKN1234567', { id: KYOCERA_ID, title: 'Kyocera ECOSYS M3145 · инв. 0012345' }],
  ]),
  byInventory: new Map([
    ['0012345', { id: KYOCERA_ID, title: 'Kyocera ECOSYS M3145 · инв. 0012345' }],
    ['0099999', { id: LAPTOP_ID, title: 'Lenovo T14 · инв. 0099999' }],
  ]),
};

/** Заведённая карточка: оба номера, отдел-владелец и обе даты. */
const equipmentRow = {
  id: KYOCERA_ID,
  equipmentTypeId: MFP_ID,
  name: 'Kyocera ECOSYS M3145',
  serialNumber: 'VKN1234567',
  inventoryNumber: '0012345',
  objectId: OBJECT_ID,
  ownerDepartmentId: DEPARTMENT_ID,
  location: 'Кабинет 214',
  purchasedOn: '2025-04-01',
  warrantyUntil: '2027-04-01',
  comment: 'куплен по счёту 118',
  isActive: true,
  createdBy: null,
  updatedBy: null,
  deletedBy: null,
  deletedAt: null,
  createdAt: AT,
  updatedAt: AT,
};

/** Карточка без отдела, без дат и без серийного номера: всё это законные пустоты. */
const bareRow = {
  ...equipmentRow,
  id: LAPTOP_ID,
  name: 'Lenovo T14',
  serialNumber: '',
  inventoryNumber: '0099999',
  ownerDepartmentId: null,
  location: '',
  purchasedOn: null,
  warrantyUntil: null,
  comment: '',
};

const BASE: Cells = {
  'Тип (код)': 'mfp',
  Модель: 'HP LaserJet M428',
  'Серийный номер': 'PHB9876543',
  'Инвентарный номер': '0054321',
  'Объект (код)': 'АЛ13',
  'Отдел-владелец (код)': 'pto',
  Место: 'Кабинет 305',
  'Дата покупки': '01.06.2026',
  'Гарантия до': '01.06.2028',
  Комментарий: '',
  Активна: 'да',
};

/** Новая строка из ячеек файла: разбор и проверки — ровно в том же порядке, что в движке. */
function rowFrom(patch: Cells): { model: unknown; ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = equipmentDir.blank();
  applyCells(equipmentDir, equipmentEnv, model, { ...BASE, ...patch }, ctx);
  equipmentDir.check?.(model, ctx, equipmentEnv);
  return { model, ctx, cells: cellsOf(equipmentDir, equipmentEnv, model) };
}

/** Правка заведённой карточки: модель собирается из строки базы, как это делает движок. */
function editOf(row: unknown, patch: Cells): { model: unknown; ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = equipmentDir.model(row, equipmentEnv);
  applyCells(equipmentDir, equipmentEnv, model, patch, ctx);
  equipmentDir.check?.(model, ctx, equipmentEnv);
  return { model, ctx, cells: cellsOf(equipmentDir, equipmentEnv, model) };
}

describe('оргтехника в обмене файлом', () => {
  it('карточка переживает выгрузку и загрузку без единой правки', () => {
    const { before, after, ctx } = roundTrip(equipmentDir, equipmentEnv, equipmentRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
    // Даты человек читает и правит в своём порядке, а не в порядке базы.
    expect(before['Дата покупки']).toBe('01.04.2025');
    expect(before['Гарантия до']).toBe('01.04.2027');
  });

  it('карточка без отдела, дат и серийного номера тоже переживает круг', () => {
    const { before, after, ctx } = roundTrip(equipmentDir, equipmentEnv, bareRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before['Отдел-владелец (код)']).toBe('');
    expect(before['Гарантия до']).toBe('');
  });

  it('ссылки в файле стоят кодами, а не идентификаторами', () => {
    const cells = cellsOf(
      equipmentDir,
      equipmentEnv,
      equipmentDir.model(equipmentRow, equipmentEnv),
    );
    expect(cells['Тип (код)']).toBe('mfp');
    expect(cells['Объект (код)']).toBe('АЛ13');
    expect(cells['Отдел-владелец (код)']).toBe('pto');
  });

  it('корректная строка разбирается без единой жалобы', () => {
    const { ctx, cells } = rowFrom({});
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(cells['Дата покупки']).toBe('01.06.2026');
    expect(equipmentDir.titleOf(rowFrom({}).model)).toBe('HP LaserJet M428 · инв. 0054321');
  });

  it('ключ строки — инвентарный номер, а без него серийный', () => {
    expect(equipmentDir.keyOf(rowFrom({}).model)).toBe('инв 0054321');
    expect(equipmentDir.keyOf(rowFrom({ 'Инвентарный номер': '' }).model)).toBe('sn PHB9876543');
    // Ключ строки без номеров не собрался: об этом уже сказала проверка «нужен хотя бы один номер».
    expect(
      equipmentDir.keyOf(rowFrom({ 'Инвентарный номер': '', 'Серийный номер': '' }).model),
    ).toBe('');
  });

  it('регистр и крайние пробелы номера ключ не меняют — так же его сравнивает индекс', () => {
    expect(equipmentDir.keyOf(rowFrom({ 'Инвентарный номер': '  0054321  ' }).model)).toBe(
      'инв 0054321',
    );
    expect(equipmentDir.keyOf(rowFrom({ 'Инвентарный номер': 'a-54321' }).model)).toBe(
      'инв A-54321',
    );
  });

  it('строка без обоих номеров отвергается словами, а не именем CHECK', () => {
    const { ctx } = rowFrom({ 'Серийный номер': '', 'Инвентарный номер': '' });
    expect(ctx.problems).toEqual([
      'нужен хотя бы один номер — серийный или инвентарный: по нему единицу и опознают при приёмке из ремонта',
    ]);
  });

  it('занятый серийный номер называет карточку, которая его держит', () => {
    const { ctx } = rowFrom({ 'Серийный номер': 'vkn1234567' });
    expect(ctx.problems).toEqual([
      'серийный номер vkn1234567 уже заведён карточкой «Kyocera ECOSYS M3145 · инв. 0012345»',
    ]);
  });

  it('занятый инвентарный номер называет карточку, которая его держит', () => {
    const { ctx } = rowFrom({ 'Инвентарный номер': ' 0099999 ' });
    expect(ctx.problems).toEqual([
      'инвентарный номер 0099999 уже заведён карточкой «Lenovo T14 · инв. 0099999»',
    ]);
  });

  it('свой же номер занятым не считается: карточка не конфликтует с собой', () => {
    const { ctx } = editOf(equipmentRow, { Место: 'Кабинет 215' });
    expect(ctx.problems).toEqual([]);
  });

  it('чужой номер у заведённой карточки отвергается так же, как у новой', () => {
    const { ctx } = editOf(equipmentRow, { 'Инвентарный номер': '0099999' });
    expect(ctx.problems).toEqual([
      'инвентарный номер 0099999 уже заведён карточкой «Lenovo T14 · инв. 0099999»',
    ]);
  });

  it('неизвестный код типа называет порядок загрузки справочников', () => {
    const { ctx } = rowFrom({ 'Тип (код)': 'coffee' });
    expect(ctx.problems).toEqual([
      'тип оргтехники «coffee» не найден — сначала загрузите справочник типов оргтехники',
    ]);
  });

  it('погашенный тип загрузку не отменяет, но и молча не проходит', () => {
    const { ctx } = rowFrom({ 'Тип (код)': 'plotter' });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('погашен'));
  });

  it('неизвестный код объекта называет порядок загрузки справочников', () => {
    const { ctx } = rowFrom({ 'Объект (код)': 'АЛ99' });
    expect(ctx.problems).toEqual([
      'объект «АЛ99» не найден — сначала загрузите справочник объектов',
    ]);
  });

  it('неизвестный код отдела называет порядок загрузки справочников', () => {
    const { ctx } = rowFrom({ 'Отдел-владелец (код)': 'ahо' });
    expect(ctx.problems).toEqual(['отдел «ahо» не найден — сначала загрузите справочник отделов']);
  });

  it('строка без модели и без объекта не заводится', () => {
    const { ctx } = rowFrom({ Модель: '', 'Объект (код)': '' });
    expect(ctx.problems).toEqual([
      'строка без модели не заводится: по ней технику и выбирают в заявке',
      'строка без объекта не заводится: техника всегда где-то стоит',
    ]);
  });

  it('дата не из календаря отвергается разбором ячейки', () => {
    const { ctx, cells } = rowFrom({ 'Дата покупки': '31.02.2026' });
    expect(ctx.problems).toHaveLength(1);
    expect(ctx.problems[0]).toMatch(/такой даты нет в календаре/u);
    expect(cells['Дата покупки']).toBe('');
  });

  it('гарантия раньше покупки загрузку не отменяет, но остаётся замечанием', () => {
    const { ctx } = rowFrom({ 'Дата покупки': '01.06.2026', 'Гарантия до': '01.06.2025' });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('не перепутаны ли колонки'));
  });

  it('слишком длинный номер отвергается до записи', () => {
    const { ctx } = rowFrom({ 'Серийный номер': 'X'.repeat(101) });
    expect(ctx.problems).toContainEqual(expect.stringContaining('Серийный номер — не длиннее 100'));
  });

  it('пустая ячейка данные не стирает, а комментарий — стирает', () => {
    const { cells, ctx } = editOf(equipmentRow, {
      'Серийный номер': '',
      'Отдел-владелец (код)': '',
      Место: '',
      'Гарантия до': '',
      Комментарий: '',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells['Серийный номер']).toBe('VKN1234567');
    expect(cells['Отдел-владелец (код)']).toBe('pto');
    expect(cells['Место']).toBe('Кабинет 214');
    expect(cells['Гарантия до']).toBe('01.04.2027');
    expect(cells['Комментарий']).toBe('');
  });
});
