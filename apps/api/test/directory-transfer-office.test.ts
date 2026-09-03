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
 * Отдельная тема — колонка «Модель»: с миграции 0171 это ссылка на справочник моделей аппаратов, а
 * не свободный текст. Незнакомое написание обязано отвергать строку словами, а не заводить в
 * справочнике вторую модель молча, и модель обязана быть того же типа, что и карточка.
 *
 * Правило «по чему модель опознаётся» описание НЕ повторяет: его считает база
 * (`office_equipment_model_key`), а описание либо совпадает с написанием справочника точно, либо
 * спрашивает базу один раз на файл (`resolveRows`). Отсюда и главный случай ниже — пара «Weiß»/
 * «WEISS»: копия правила в JS схлопнула бы две законные модели в одну, и строка привязалась бы не
 * к той — молча, без единого отказа.
 *
 * База не поднимается: описание — это правила разбора и печати ячеек, ссылки на соседние
 * справочники приходят из `env`, который здесь собран руками, а ответ базы на догрузку задаётся
 * прямо в тесте — проверяется, что описание берёт его как есть, а не считает ключи само.
 */

/**
 * Клиент БД подменён: догрузка моделей (`resolveRows`) ходит в базу одним запросом, и тест задаёт
 * её ответ. Выгрузка и `load()` здесь не вызываются вовсе, поэтому `select` — заглушка.
 */
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/db/client', () => ({ db: { execute, select: vi.fn() } }));

// Модуль тянет конфиг через схему. Значения ставятся до импорта, чтобы модуль вообще загрузился.
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
const modelsDir = directoryFor('office-equipment-models');
const consumablesDir = directoryFor('office-equipment-consumables');
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
const HP_MODEL_ID = '66666666-6666-4666-8666-666666666661';
const KYOCERA_MODEL_ID = '66666666-6666-4666-8666-666666666662';
const LENOVO_MODEL_ID = '66666666-6666-4666-8666-666666666663';
const PLOTTER_MODEL_ID = '66666666-6666-4666-8666-666666666664';
const RICOH_MODEL_ID = '66666666-6666-4666-8666-666666666665';

const WEISS_MODEL_ID = '66666666-6666-4666-8666-666666666666';
const WEISS_UPPER_MODEL_ID = '66666666-6666-4666-8666-666666666667';

/**
 * Справочник моделей аппаратов. Своего листа в обмене у него нет — модели заводят в портале, и файл
 * техники только ссылается на заведённое.
 */
const MODELS = [
  {
    id: HP_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'HP LaserJet M428',
    key: 'HP LASERJET M428',
    isActive: true,
  },
  {
    id: KYOCERA_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'Kyocera ECOSYS M3145',
    key: 'KYOCERA ECOSYS M3145',
    isActive: true,
  },
  {
    id: LENOVO_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'Lenovo T14',
    key: 'LENOVO T14',
    isActive: true,
  },
  // Модель другого типа: ею проверяется «замок» составного ключа, сказанный словами.
  {
    id: PLOTTER_MODEL_ID,
    typeId: OTHER_TYPE_ID,
    typeCode: 'plotter',
    name: 'HP DesignJet T230',
    key: 'HP DESIGNJET T230',
    isActive: true,
  },
  // Погашенная модель: у заведённых карточек остаётся, новой технике не предлагается.
  {
    id: RICOH_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'Ricoh Aficio MP 201SPF',
    key: 'RICOH AFICIO MP 201SPF',
    isActive: false,
  },
  /*
   * Две законные модели одного типа, на которых правило Postgres и правило JavaScript расходятся:
   *
   *   office_equipment_model_key('Weiß 200') <> office_equipment_model_key('WEISS 200') — база
   *     считает их разными, и уникальный индекс обе пропускает;
   *   'Weiß 200'.toUpperCase() === 'WEISS 200' — JavaScript считает их одной.
   *
   * Аппаратов с таким именем в парке нет; пара взята за то, что она ловит ошибку, ради которой
   * ключ и перестали считать в TypeScript. Копия правила в JS сложила бы обе модели в один ключ
   * словаря, и строка файла привязалась бы к той, которую прочитали последней, — без отказа.
   */
  {
    id: WEISS_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'Weiß 200',
    // Ключ — то, что вернула бы `office_equipment_model_key`: `upper()` в Postgres «ß» не
    // разворачивает, поэтому у двух этих моделей ключи разные, а у `toUpperCase()` — одинаковые.
    key: 'WEIß 200',
    isActive: true,
  },
  {
    id: WEISS_UPPER_MODEL_ID,
    typeId: MFP_ID,
    typeCode: 'mfp',
    name: 'WEISS 200',
    key: 'WEISS 200',
    isActive: true,
  },
];

/**
 * Соседние справочники в том виде, в каком их читает описание оргтехники. Собирается функцией, а не
 * константой: догрузка моделей дополняет словари на месте, и тесты не должны видеть, что оставил
 * после себя соседний.
 */
function makeEquipmentEnv() {
  return {
    types: new Map([
      ['mfp', { id: MFP_ID, name: 'МФУ', isActive: true }],
      // Погашенный тип: он остаётся у заведённых карточек, и файл на нём не спотыкается.
      ['plotter', { id: OTHER_TYPE_ID, name: 'Плоттер', isActive: false }],
    ]),
    typeCodeById: new Map([
      [MFP_ID, 'mfp'],
      [OTHER_TYPE_ID, 'plotter'],
    ]),
    // Написания справочника — точными строками: ключ по ним никто не считает.
    models: new Map(
      MODELS.map((m) => [
        `${m.typeId}\u0000${m.name}`,
        { id: m.id, name: m.name, isActive: m.isActive },
      ]),
    ),
    modelNameById: new Map(MODELS.map((m) => [m.id, m.name])),
    // Пустым, как и в бою: перечень типов заполняет только ответ базы на догрузку.
    modelTypesByName: new Map<string, string[]>(),
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
}

/** Окружение по умолчанию: им пользуются случаи, которым догрузка не нужна. */
const equipmentEnv = makeEquipmentEnv();

/** Заведённая карточка: оба номера, отдел-владелец и обе даты. */
const equipmentRow = {
  id: KYOCERA_ID,
  equipmentTypeId: MFP_ID,
  modelId: KYOCERA_MODEL_ID,
  // `name` карточки — копия имени модели: её зеркалит триггер `office_equipment_model_mirror`.
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
  modelId: LENOVO_MODEL_ID,
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
function rowIn(env: unknown, patch: Cells): { model: unknown; ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = equipmentDir.blank();
  applyCells(equipmentDir, env, model, { ...BASE, ...patch }, ctx);
  equipmentDir.check?.(model, ctx, env);
  return { model, ctx, cells: cellsOf(equipmentDir, env, model) };
}

function rowFrom(patch: Cells): { model: unknown; ctx: TestContext; cells: Cells } {
  return rowIn(equipmentEnv, patch);
}

/** Строка ответа базы на догрузку — теми же именами колонок, какими их отдаёт запрос. */
interface ResolvedRow {
  asked: string;
  id: string;
  name: string;
  equipment_type_id: string;
  type_code: string;
  is_active: boolean;
}

/**
 * Догрузка моделей: то же, что делает движок перед проверками, — разбор строк начисто и один
 * запрос в базу на весь файл. Ответ задаётся здесь: считать ключи по правилу Postgres тесту нечем,
 * да и незачем — проверяется, что описание берёт ответ как есть.
 */
async function resolveIn(env: unknown, rows: ResolvedRow[], patches: Cells[]): Promise<void> {
  execute.mockResolvedValueOnce({ rows });
  const models = patches.map((patch) => {
    const model = equipmentDir.blank();
    applyCells(equipmentDir, env, model, { ...BASE, ...patch }, testContext());
    return model;
  });
  await equipmentDir.resolveRows?.(models, env);
}

/** Ответ базы про заведённую модель, найденную по присланному написанию. */
function answerFor(asked: string, model: (typeof MODELS)[number]): ResolvedRow {
  return {
    asked,
    id: model.id,
    name: model.name,
    equipment_type_id: model.typeId,
    type_code: model.typeCode,
    is_active: model.isActive,
  };
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
    // Модель берётся своя, плоттерная: тип карточки и тип модели обязаны совпадать, и «HP LaserJet
    // M428» из МФУ здесь дал бы отказ не про то, ради чего написан этот случай.
    const { ctx } = rowFrom({ 'Тип (код)': 'plotter', Модель: 'HP DesignJet T230' });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('погашен'));
  });

  it('незнакомая модель отвергает строку, а не заводится молча', () => {
    const { ctx } = rowFrom({ Модель: 'Kyocera ECOSYS M3146' });
    expect(ctx.problems).toEqual([
      'модель «Kyocera ECOSYS M3146» не заведена: заведите её в справочнике моделей аппаратов или исправьте написание',
    ]);
  });

  it('модель чужого типа отвергается словами, а не именем составного ключа', async () => {
    const env = makeEquipmentEnv();
    const asked = 'HP DesignJet T230';
    // Точного совпадения у типа карточки нет, и база отвечает тем, что нашла: модель есть, но у
    // плоттеров. Перечень типов в сообщении — из её ответа, а не из нашего разбора имени.
    await resolveIn(env, [answerFor(asked, MODELS[3]!)], [{ Модель: asked }]);
    const { ctx } = rowIn(env, { Модель: asked });
    expect(ctx.problems).toEqual([
      'модель «HP DesignJet T230» заведена у типа «plotter», а карточка типа «mfp» — тип модели обязан совпадать с типом карточки',
    ]);
  });

  it('у незнакомого типа про модель не спрашивают: чинить надо колонку типа', () => {
    const { ctx } = rowFrom({ 'Тип (код)': 'coffee', Модель: 'Kyocera ECOSYS M3146' });
    expect(ctx.problems).toEqual([
      'тип оргтехники «coffee» не найден — сначала загрузите справочник типов оргтехники',
    ]);
  });

  it('написание модели встаёт справочное, а не то, что набрали в ячейке', async () => {
    const env = makeEquipmentEnv();
    const asked = 'kyocera   ECOSYS m3145';
    // Точного совпадения нет — ключ считает база, и вот что она ответила.
    await resolveIn(env, [answerFor(asked, MODELS[1]!)], [{ Модель: asked }]);
    const { ctx, cells } = rowIn(env, { Модель: asked });
    expect(ctx.problems).toEqual([]);
    expect(cells['Модель']).toBe('Kyocera ECOSYS M3145');
  });

  it('другое написание той же модели правкой карточки не считается', async () => {
    const env = makeEquipmentEnv();
    const asked = 'KYOCERA ECOSYS M3145';
    await resolveIn(env, [answerFor(asked, MODELS[1]!)], [{ Модель: asked }]);
    const ctx = testContext();
    const model = equipmentDir.model(equipmentRow, env);
    applyCells(equipmentDir, env, model, { Модель: asked }, ctx);
    equipmentDir.check?.(model, ctx, env);
    expect(ctx.problems).toEqual([]);
    // Ячейки до и после совпадают — значит, движок не покажет правки, которой никто не делал.
    expect(cellsOf(equipmentDir, env, model)['Модель']).toBe(
      cellsOf(equipmentDir, env, equipmentDir.model(equipmentRow, env))['Модель'],
    );
  });

  it('две модели, которые JavaScript считает одной, база различает — и привязка идёт к названной', () => {
    // Тот самый случай, ради которого ключ перестали считать в TypeScript: `toUpperCase()` делает
    // из «Weiß 200» ровно «WEISS 200», а `office_equipment_model_key` — нет. Со своей копией
    // правила словарь хранил бы одну из двух моделей на оба написания, и обе строки файла уехали бы
    // к прочитанной последней. Точное совпадение так ошибиться не может.
    expect('Weiß 200'.toUpperCase()).toBe('WEISS 200');
    expect(rowFrom({ Модель: 'Weiß 200' }).cells['Модель']).toBe('Weiß 200');
    expect(rowFrom({ Модель: 'WEISS 200' }).cells['Модель']).toBe('WEISS 200');
    expect(rowFrom({ Модель: 'Weiß 200' }).ctx.problems).toEqual([]);
    expect(rowFrom({ Модель: 'WEISS 200' }).ctx.problems).toEqual([]);
  });

  it('файл справочными написаниями базу о ключах не спрашивает', async () => {
    execute.mockClear();
    const env = makeEquipmentEnv();
    const models = [{ Модель: 'HP LaserJet M428' }, { Модель: 'Weiß 200' }].map((patch) => {
      const model = equipmentDir.blank();
      applyCells(equipmentDir, env, model, { ...BASE, ...patch }, testContext());
      return model;
    });
    await equipmentDir.resolveRows?.(models, env);
    expect(execute).not.toHaveBeenCalled();
  });

  it('два присланных написания одной модели привязываются к ней обоим, а не спорят', async () => {
    const env = makeEquipmentEnv();
    const first = 'Kyocera  ECOSYS M3145';
    const second = 'kyocera ecosys m3145';
    // База ответила про оба написания одной и той же моделью — так и должно быть: в справочнике
    // двух таких строк нет, их не пропустит уникальный индекс.
    await resolveIn(
      env,
      [answerFor(first, MODELS[1]!), answerFor(second, MODELS[1]!)],
      [{ Модель: first }, { Модель: second }],
    );
    expect(rowIn(env, { Модель: first }).cells['Модель']).toBe('Kyocera ECOSYS M3145');
    expect(rowIn(env, { Модель: second }).cells['Модель']).toBe('Kyocera ECOSYS M3145');
    expect(rowIn(env, { Модель: first }).ctx.problems).toEqual([]);
    expect(rowIn(env, { Модель: second }).ctx.problems).toEqual([]);
  });

  it('погашенная модель загрузку не отменяет, но и молча не проходит', () => {
    const { ctx } = rowFrom({ Модель: 'Ricoh Aficio MP 201SPF' });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('погашена'));
  });

  it('выгрузка печатает имя модели по ссылке, а не зеркало из карточки', () => {
    // Зеркало держит триггер, и разойтись эти две строки не должны; но читает колонка именно
    // справочник, и это видно ровно на карточке с разошедшимся `name`.
    const drifted = { ...equipmentRow, name: 'KYOCERA  ECOSYS M3145' };
    const cells = cellsOf(equipmentDir, equipmentEnv, equipmentDir.model(drifted, equipmentEnv));
    expect(cells['Модель']).toBe('Kyocera ECOSYS M3145');
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

// ── Модели аппаратов ──────────────────────────────────────────────────────────────────────────

/** Разделитель составных ключей словарей — тот же нулевой байт, что в описании. */
const SEP = String.fromCharCode(0);

const COLOR_SPEC_ID = '9a3e0f60-1111-4d0a-9c3b-0f2f7d1c0001';
const COLOR_VALUE_ID = '9a3e0f60-1111-4d0a-9c3b-0f2f7d1c0002';
const MONO_VALUE_ID = '9a3e0f60-1111-4d0a-9c3b-0f2f7d1c0003';

/**
 * Окружение листа моделей. Ключи написаний здесь заданы руками — это ОТВЕТ базы, а не правило:
 * правило живёт в `office_equipment_model_key`, и повторять его тесту нечем и незачем. Пара
 * «Weiß 200» / «WEISS 200» показывает, почему это важно: у них разные ключи, хотя `toUpperCase()`
 * делает из них одну строку.
 */
function makeApparatusEnv() {
  return {
    types: new Map([
      ['mfp', { id: MFP_ID, name: 'МФУ', isActive: true }],
      ['plotter', { id: OTHER_TYPE_ID, name: 'Плоттер', isActive: false }],
    ]),
    typeCodeById: new Map([
      [MFP_ID, 'mfp'],
      [OTHER_TYPE_ID, 'plotter'],
    ]),
    askedKeys: new Map(MODELS.map((m) => [m.name, { key: m.key, spelling: m.name }])),
    takenByKey: new Map(
      MODELS.map((m) => [`${m.typeId}${SEP}${m.key}`, { id: m.id, name: m.name }]),
    ),
    // Сколько карточек у модели: числом в предупреждении о переименовании.
    cardsByModelId: new Map([[KYOCERA_MODEL_ID, 68]]),
    // Цветность печати (план `docs/office-equipment-specs-plan.md`, Р12). Значения заданы так же,
    // как их вернула бы база: полное имя и сокращение — два ключа одной строки.
    colorSpecId: COLOR_SPEC_ID,
    colorTypeIds: new Set([MFP_ID]),
    colorValuesByKey: new Map([
      ['цветная', { id: COLOR_VALUE_ID, name: 'Цветная' }],
      ['цв.', { id: COLOR_VALUE_ID, name: 'Цветная' }],
      ['чёрно-белая', { id: MONO_VALUE_ID, name: 'Чёрно-белая' }],
      ['ч/б', { id: MONO_VALUE_ID, name: 'Чёрно-белая' }],
    ]),
    colorNameByModelId: new Map([[KYOCERA_MODEL_ID, 'Чёрно-белая']]),
    twins: new Map<string, string>(),
  };
}

const apparatusEnv = makeApparatusEnv();

/** Заведённая модель в том виде, в каком её отдаёт `load()`. */
const modelRow = {
  id: KYOCERA_MODEL_ID,
  equipmentTypeId: MFP_ID,
  name: 'Kyocera ECOSYS M3145',
  manufacturer: 'Kyocera',
  comment: 'самая ходовая',
  isActive: true,
};

const MODEL_BASE: Cells = {
  'Тип (код)': 'mfp',
  Наименование: 'Kyocera ECOSYS M4132',
  Производитель: 'Kyocera',
  Комментарий: '',
  Активна: 'да',
};

/** Строка листа моделей поверх заданного окружения. */
function modelRowIn(env: unknown, patch: Cells): { ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = modelsDir.blank();
  applyCells(modelsDir, env, model, { ...MODEL_BASE, ...patch }, ctx);
  modelsDir.check?.(model, ctx, env);
  return { ctx, cells: cellsOf(modelsDir, env, model) };
}

/** Правка заведённой модели: строка собирается из записи справочника, как это делает движок. */
function modelEditIn(env: unknown, row: unknown, patch: Cells): { ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = modelsDir.model(row, env);
  applyCells(modelsDir, env, model, patch, ctx);
  modelsDir.check?.(model, ctx, env);
  return { ctx, cells: cellsOf(modelsDir, env, model) };
}

/**
 * Догрузка ключей: то же, что делает движок перед проверками. Ответ базы задаётся здесь — ключ и
 * свёрнутое написание присланной строки.
 */
async function resolveModelsIn(
  env: unknown,
  rows: { asked: string; key: string; spelling: string }[],
  patches: Cells[],
): Promise<void> {
  execute.mockResolvedValueOnce({ rows });
  const models = patches.map((patch) => {
    const model = modelsDir.blank();
    applyCells(modelsDir, env, model, { ...MODEL_BASE, ...patch }, testContext());
    return model;
  });
  await modelsDir.resolveRows?.(models, env);
}

describe('модели аппаратов в обмене файлом', () => {
  it('лист стоит между типами и техникой: связанное идёт после того, на что ссылается', () => {
    expect(officeDirectories.map((d) => d.key)).toEqual([
      'office-equipment-types',
      'office-equipment-models',
      'office-equipment',
      // Расходник ссылается на модель — значит, идёт после неё; техника между ними стоит потому,
      // что так модуль и читается: типы, модели, парк, а расходники к нему в придачу.
      'office-equipment-consumables',
    ]);
  });

  it('строка переживает выгрузку и загрузку без единой правки', () => {
    const { before, after, ctx } = roundTrip(modelsDir, apparatusEnv, modelRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before['Тип (код)']).toBe('mfp');
    expect(before['Наименование']).toBe('Kyocera ECOSYS M3145');
  });

  it('новая модель заводится: ключ и написание приходят от базы', async () => {
    const env = makeApparatusEnv();
    const asked = '  Ricoh   IM 350 ';
    await resolveModelsIn(
      env,
      [{ asked: asked.trim(), key: 'RICOH IM 350', spelling: 'Ricoh IM 350' }],
      [{ Наименование: asked }],
    );
    const { ctx, cells } = modelRowIn(env, { Наименование: asked });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    // В справочник уедет свёрнутое написание, и человек видит в отчёте именно его.
    expect(cells['Наименование']).toBe('Ricoh IM 350');
  });

  it('наименование заведённой модели занято: строка без идентификатора её не переименовывает', async () => {
    const env = makeApparatusEnv();
    const asked = 'kyocera ecosys m3145';
    await resolveModelsIn(
      env,
      [{ asked, key: 'KYOCERA ECOSYS M3145', spelling: 'kyocera ecosys m3145' }],
      [{ Наименование: asked }],
    );
    const { ctx } = modelRowIn(env, { Наименование: asked });
    expect(ctx.problems).toEqual([
      'наименование «kyocera ecosys m3145» уже занято моделью «Kyocera ECOSYS M3145» того же типа: чтобы поправить написание, правьте её строкой из выгрузки — в ней заполнена колонка «Идентификатор»',
    ]);
  });

  it('два написания одной новой модели в одном файле: вторая строка отвергается словами', async () => {
    const env = makeApparatusEnv();
    // Обе строки — про модель, которой в справочнике ещё нет: ключ у них общий, и завести её
    // дважды нельзя. Одинаковые написания поймал бы сам движок, разные — только ключ базы.
    await resolveModelsIn(
      env,
      [
        { asked: 'Ricoh IM 350', key: 'RICOH IM 350', spelling: 'Ricoh IM 350' },
        { asked: 'RICOH IM 350', key: 'RICOH IM 350', spelling: 'RICOH IM 350' },
      ],
      [{ Наименование: 'Ricoh IM 350' }, { Наименование: 'RICOH IM 350' }],
    );
    expect(modelRowIn(env, { Наименование: 'Ricoh IM 350' }).ctx.problems).toEqual([]);
    expect(modelRowIn(env, { Наименование: 'RICOH IM 350' }).ctx.problems).toEqual([
      'в файле это та же модель, что и строка с написанием «Ricoh IM 350»: регистр и лишние пробелы наименование не различают, и завести её дважды нельзя',
    ]);
  });

  it('переименование строкой из выгрузки проходит, но называет число карточек', async () => {
    const env = makeApparatusEnv();
    const asked = 'Kyocera ECOSYS M3145 (2-я серия)';
    await resolveModelsIn(
      env,
      [{ asked, key: 'KYOCERA ECOSYS M3145 (2-Я СЕРИЯ)', spelling: asked }],
      [{ Наименование: asked }],
    );
    const { ctx, cells } = modelEditIn(env, modelRow, { Наименование: asked });
    expect(ctx.problems).toEqual([]);
    expect(cells['Наименование']).toBe(asked);
    expect(ctx.warnings).toEqual([
      'переименование «Kyocera ECOSYS M3145» → «Kyocera ECOSYS M3145 (2-я серия)» перепишет наименование во всех карточках модели, включая архивные; сейчас их: 68',
    ]);
  });

  it('своё же наименование занятым не считается: строка не спорит сама с собой', () => {
    const { ctx } = modelEditIn(apparatusEnv, modelRow, { Производитель: 'Kyocera Document' });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('тип у заведённой модели не меняется — отказ словами, а не ошибкой целостности', () => {
    const { ctx } = modelEditIn(apparatusEnv, modelRow, { 'Тип (код)': 'plotter' });
    expect(ctx.problems).toEqual([
      'тип модели не меняется: «mfp» → «plotter». Заведите модель нужного типа и перецепите карточки — у заведённой модели тип остаётся навсегда',
    ]);
  });

  it('незнакомый код типа называет порядок загрузки справочников', () => {
    const { ctx } = modelRowIn(apparatusEnv, { 'Тип (код)': 'coffee' });
    expect(ctx.problems).toEqual([
      'тип оргтехники «coffee» не найден — сначала загрузите справочник типов оргтехники',
    ]);
  });

  it('погашенный тип загрузку не отменяет, но и молча не проходит', async () => {
    const env = makeApparatusEnv();
    const asked = 'HP DesignJet T650';
    await resolveModelsIn(
      env,
      [{ asked, key: 'HP DESIGNJET T650', spelling: asked }],
      [{ 'Тип (код)': 'plotter', Наименование: asked }],
    );
    const { ctx } = modelRowIn(env, { 'Тип (код)': 'plotter', Наименование: asked });
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('погашен'));
  });

  it('строка без кода типа и без наименования не заводится', () => {
    const { ctx } = modelRowIn(apparatusEnv, { 'Тип (код)': '', Наименование: '' });
    expect(ctx.problems).toEqual([
      'строка без кода типа не заводится: модель принадлежит типу',
      'строка без наименования не заводится: по нему модель и опознают',
    ]);
  });

  it('наименование в один знак отвергается: по такому модель не опознать', () => {
    const { ctx } = modelRowIn(apparatusEnv, { Наименование: 'X' });
    expect(ctx.problems).toEqual([
      'наименование «X» короче 2 знаков — по такому модель не опознать',
    ]);
  });

  it('файл справочными написаниями базу о ключах не спрашивает', async () => {
    execute.mockClear();
    const env = makeApparatusEnv();
    const models = [{ Наименование: 'Kyocera ECOSYS M3145' }, { Наименование: 'Weiß 200' }].map(
      (patch) => {
        const model = modelsDir.blank();
        applyCells(modelsDir, env, model, { ...MODEL_BASE, ...patch }, testContext());
        return model;
      },
    );
    await modelsDir.resolveRows?.(models, env);
    expect(execute).not.toHaveBeenCalled();
  });

  it('переименование строкой без колонки «Тип (код)» проходит: ключ спрошен и без типа', async () => {
    // Человек вправе оставить в файле только то, что правит, — идентификатор и наименование. Тип
    // тогда придёт из заведённой записи, и строка обязана дойти до проверок с ключом написания:
    // спрашивай догрузка только про строки с видимым типом, здесь была бы внутренняя ошибка.
    execute.mockClear();
    const env = makeApparatusEnv();
    const asked = 'Kyocera ECOSYS M3145 SE';
    execute.mockResolvedValueOnce({
      rows: [{ asked, key: 'KYOCERA ECOSYS M3145 SE', spelling: asked }],
    });
    const probe = modelsDir.blank();
    applyCells(modelsDir, env, probe, { Наименование: asked }, testContext());
    await modelsDir.resolveRows?.([probe], env);
    expect(execute).toHaveBeenCalledTimes(1);

    const { ctx, cells } = modelEditIn(env, modelRow, { Наименование: asked });
    expect(ctx.problems).toEqual([]);
    expect(cells['Наименование']).toBe(asked);
    expect(ctx.warnings).toContainEqual(expect.stringContaining('перепишет наименование'));
  });

  it('пустая ячейка производителя не стирает, а комментарий — стирает', () => {
    const { cells, ctx } = modelEditIn(apparatusEnv, modelRow, {
      Производитель: '',
      Комментарий: '',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells['Производитель']).toBe('Kyocera');
    expect(cells['Комментарий']).toBe('');
  });

  // ── Цветность печати (план `docs/office-equipment-specs-plan.md`, Р12) ──

  it('выгрузка пишет заведённую цветность полным словом', () => {
    // Полным, а не сокращением: в файле человек читает и правит значение, а «цв.» — форма для
    // строки списка, где за место борются восемь колонок.
    expect(cellsOf(modelsDir, apparatusEnv, modelsDir.model(modelRow, apparatusEnv))['Цветность'])
      .toBe('Чёрно-белая');
  });

  it('модель без значения выгружается пустой ячейкой', () => {
    // «Н/д» хранится отсутствием строки (Р3), и в файле это пустая ячейка — не слово «н/д»:
    // иначе загрузка того же файла обратно потребовала бы понимать «н/д» как значение.
    const other = { ...modelRow, id: '9a3e0f60-1111-4d0a-9c3b-0f2f7d1c0009' };
    expect(cellsOf(modelsDir, apparatusEnv, modelsDir.model(other, apparatusEnv))['Цветность'])
      .toBe('');
  });

  it('пустая ячейка цветности не стирает заведённое', () => {
    // Главное правило колонки (Р12): файл, собранный в Excel ради другой колонки, не должен
    // обезличивать справочник. Убрать значение можно только в портале.
    const { cells, ctx } = modelEditIn(apparatusEnv, modelRow, { Цветность: '' });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цветность']).toBe('Чёрно-белая');
  });

  it('сокращение принимается и подменяется справочным написанием', () => {
    // В отчёте человек обязан видеть то, что действительно запишется, — тот же приём, что с
    // наименованием модели.
    const { cells, ctx } = modelEditIn(apparatusEnv, modelRow, { Цветность: 'ЦВ.' });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цветность']).toBe('Цветная');
  });

  it('незнакомое написание — отказ строки с перечнем допустимого', () => {
    const { ctx } = modelEditIn(apparatusEnv, modelRow, { Цветность: 'полноцвет' });
    expect(ctx.problems).toEqual([
      expect.stringContaining('цветность «полноцвет» не распознана'),
    ]);
  });

  it('цветность у типа, где её не спрашивают, — отказ, а не молчаливый пропуск', async () => {
    // Замок базы (`office_equipment_model_specs_type_spec_fk`) сказал бы то же самое именем
    // ограничения и уже на записи, отменив весь файл. Здесь названо и что не так, и что делать.
    const env = makeApparatusEnv();
    const asked = 'HP DesignJet T650';
    await resolveModelsIn(
      env,
      [{ asked, key: 'HP DESIGNJET T650', spelling: asked }],
      [{ 'Тип (код)': 'plotter', Наименование: asked, Цветность: 'Цветная' }],
    );
    const { ctx } = modelRowIn(env, {
      'Тип (код)': 'plotter',
      Наименование: asked,
      Цветность: 'Цветная',
    });
    expect(ctx.problems).toContainEqual(expect.stringContaining('цветность печати у типа'));
  });
});

// ── Расходники ────────────────────────────────────────────────────────────────────────────────

const TONER_ID = '77777777-7777-4777-8777-777777777771';

/**
 * Окружение листа расходников. Ключи — и кода, и наименования модели — заданы руками: это ОТВЕТЫ
 * базы, а не правила. Правила разные и живут в Postgres: у кода пробелы удаляются
 * (`office_equipment_consumable_code_key`), у наименования модели схлопываются
 * (`office_equipment_model_key`), — и повторять их тесту нечем.
 */
function makeConsumableEnv() {
  const refs = [
    {
      id: KYOCERA_MODEL_ID,
      typeCode: 'mfp',
      name: 'Kyocera ECOSYS M3145',
      label: 'Kyocera ECOSYS M3145',
    },
    { id: HP_MODEL_ID, typeCode: 'mfp', name: 'HP LaserJet M428', label: 'HP LaserJet M428' },
    // Одноимённые модели двух типов: подпись у них с типом, иначе ячейка означала бы обе сразу.
    {
      id: PLOTTER_MODEL_ID,
      typeCode: 'plotter',
      name: 'HP DesignJet T230',
      label: 'plotter: HP DesignJet T230',
    },
    {
      id: LENOVO_MODEL_ID,
      typeCode: 'mfp',
      name: 'HP DesignJet T230',
      label: 'mfp: HP DesignJet T230',
    },
  ];
  return {
    types: new Map([
      ['mfp', { id: MFP_ID, code: 'mfp' }],
      ['plotter', { id: OTHER_TYPE_ID, code: 'plotter' }],
    ]),
    modelKeyByName: new Map([
      ['Kyocera ECOSYS M3145', 'KYOCERA ECOSYS M3145'],
      ['HP LaserJet M428', 'HP LASERJET M428'],
      ['HP DesignJet T230', 'HP DESIGNJET T230'],
    ]),
    modelsByKey: new Map([
      ['KYOCERA ECOSYS M3145', [refs[0]!]],
      ['HP LASERJET M428', [refs[1]!]],
      ['HP DESIGNJET T230', [refs[3]!, refs[2]!]],
    ]),
    modelById: new Map(refs.map((r) => [r.id, r])),
    modelIdsByConsumable: new Map([[TONER_ID, [KYOCERA_MODEL_ID, HP_MODEL_ID]]]),
    codeKeyByCode: new Map([['Д0000337741', 'Д0000337741']]),
    takenByCodeKey: new Map([
      ['Д0000337741', { id: TONER_ID, title: 'Тонер Kyocera TK-3190 (шт)' }],
    ]),
    codeTwins: new Map<string, string>(),
  };
}

const consumableEnv = makeConsumableEnv();

/** Заведённая карточка расходника в том виде, в каком её отдаёт `load()`. */
const consumableRow = {
  id: TONER_ID,
  code: 'Д0000337741',
  name: 'Тонер Kyocera TK-3190 (шт)',
  quantity: 12,
  color: 'чёрный',
  comment: 'берут по две',
  isActive: true,
};

const CONSUMABLE_BASE: Cells = {
  Код: 'Б0000014256',
  Наименование: 'Драм-картридж Kyocera DK-3190 (шт)',
  Цвет: '',
  'Подходит к': 'Kyocera ECOSYS M3145',
  Наличие: '0',
  Комментарий: '',
  Активен: 'да',
};

function consumableRowIn(env: unknown, patch: Cells): { ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = consumablesDir.blank();
  applyCells(consumablesDir, env, model, { ...CONSUMABLE_BASE, ...patch }, ctx);
  consumablesDir.check?.(model, ctx, env);
  return { ctx, cells: cellsOf(consumablesDir, env, model) };
}

function consumableEditIn(
  env: unknown,
  row: unknown,
  patch: Cells,
): { model: unknown; ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = consumablesDir.model(row, env);
  applyCells(consumablesDir, env, model, patch, ctx);
  consumablesDir.check?.(model, ctx, env);
  return { model, ctx, cells: cellsOf(consumablesDir, env, model) };
}

/** Догрузка ключей: два вопроса к базе на файл — коды и наименования моделей. */
async function resolveConsumablesIn(
  env: unknown,
  answer: { codes?: { asked: string; key: string }[]; names?: { asked: string; key: string }[] },
  patches: Cells[],
): Promise<void> {
  execute.mockImplementation((query: unknown) => {
    const text = JSON.stringify(query);
    const rows = text.includes('office_equipment_consumable_code_key')
      ? (answer.codes ?? [])
      : (answer.names ?? []);
    return Promise.resolve({ rows });
  });
  const models = patches.map((patch) => {
    const model = consumablesDir.blank();
    applyCells(consumablesDir, env, model, { ...CONSUMABLE_BASE, ...patch }, testContext());
    return model;
  });
  await consumablesDir.resolveRows?.(models, env);
  execute.mockReset();
}

describe('расходники в обмене файлом', () => {
  it('лист идёт после моделей: расходник на них ссылается', () => {
    expect(officeDirectories.map((d) => d.key)).toContain('office-equipment-consumables');
    const keys = officeDirectories.map((d) => d.key);
    expect(keys.indexOf('office-equipment-consumables')).toBeGreaterThan(
      keys.indexOf('office-equipment-models'),
    );
  });

  it('карточка переживает круг без правок — всеми колонками, которые загрузка читает', () => {
    const { before, after, ctx } = roundTrip(consumablesDir, consumableEnv, consumableRow);
    expect(ctx.problems).toEqual([]);
    for (const column of consumablesDir.columns(consumableEnv)) {
      if (!column.set) continue;
      expect(after[column.header], column.header).toBe(before[column.header]);
    }
    expect(before['Подходит к']).toBe('HP LaserJet M428; Kyocera ECOSYS M3145');

    // А «Наличие» круга не переживает — и это ровно то, ради чего колонка сделана справочной:
    // разбор её не читает. Движок такую колонку и не сравнивает (`planRows` берёт только те, у
    // которых есть `set`), поэтому в отчёте загрузки правки не появится.
    expect(before['Наличие']).toBe('12');
    expect(after['Наличие']).toBe('0');
  });

  // ГЛАВНЫЙ СЛУЧАЙ ЛИСТА: остаток файлом не грузится (Р7).
  it('колонка «Наличие» при заливке не читается вовсе', () => {
    const column = consumablesDir.columns(consumableEnv).find((c) => c.header === 'Наличие');
    expect(column, 'колонка «Наличие» пропала из выгрузки').toBeDefined();
    // Нет `set` — движок колонку не разбирает и в сравнение «что изменится» не берёт.
    expect(column!.set).toBeUndefined();
    expect(column!.hint).toMatch(/не читает/u);

    // И то же самое с той стороны, с какой это видит человек: вписанное число ничего не меняет.
    const { ctx, cells } = consumableEditIn(consumableEnv, consumableRow, { Наличие: '999' });
    expect(ctx.problems).toEqual([]);
    expect(cells['Наличие']).toBe('12');
  });

  it('новая позиция заводится: ключ кода приходит от базы', async () => {
    const env = makeConsumableEnv();
    await resolveConsumablesIn(env, { codes: [{ asked: 'Б0000014256', key: 'Б0000014256' }] }, [
      {},
    ]);
    const { ctx, cells } = consumableRowIn(env, {});
    expect(ctx.problems).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(cells['Код']).toBe('Б0000014256');
    expect(cells['Подходит к']).toBe('Kyocera ECOSYS M3145');
    expect(consumablesDir.titleOf(consumablesDir.blank())).toBe('');
  });

  it('повторная загрузка выгруженного файла ничего не меняет', () => {
    const { ctx, cells } = consumableEditIn(consumableEnv, consumableRow, {
      'Подходит к': 'HP LaserJet M428; Kyocera ECOSYS M3145',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells).toEqual(
      cellsOf(consumablesDir, consumableEnv, consumablesDir.model(consumableRow, consumableEnv)),
    );
  });

  it('модели привязываются и снимаются набором, порядок в ячейке значения не имеет', () => {
    const added = consumableEditIn(consumableEnv, consumableRow, {
      'Подходит к': 'Kyocera ECOSYS M3145; HP LaserJet M428; plotter: HP DesignJet T230',
    });
    expect(added.ctx.problems).toEqual([]);
    expect(added.cells['Подходит к']).toBe(
      'HP LaserJet M428; Kyocera ECOSYS M3145; plotter: HP DesignJet T230',
    );

    const dropped = consumableEditIn(consumableEnv, consumableRow, {
      'Подходит к': 'Kyocera ECOSYS M3145',
    });
    expect(dropped.ctx.problems).toEqual([]);
    expect(dropped.cells['Подходит к']).toBe('Kyocera ECOSYS M3145');
  });

  it('пустая ячейка «Подходит к» привязки не снимает', () => {
    const { ctx, cells } = consumableEditIn(consumableEnv, consumableRow, { 'Подходит к': '' });
    expect(ctx.problems).toEqual([]);
    expect(cells['Подходит к']).toBe('HP LaserJet M428; Kyocera ECOSYS M3145');
  });

  it('незнакомая модель отвергает строку, а не заводится молча', async () => {
    const env = makeConsumableEnv();
    await resolveConsumablesIn(
      env,
      {
        codes: [{ asked: 'Б0000014256', key: 'Б0000014256' }],
        names: [{ asked: 'Kyocera ECOSYS M3146', key: 'KYOCERA ECOSYS M3146' }],
      },
      [{ 'Подходит к': 'Kyocera ECOSYS M3146' }],
    );
    const { ctx } = consumableRowIn(env, { 'Подходит к': 'Kyocera ECOSYS M3146' });
    expect(ctx.problems).toEqual([
      'модель «Kyocera ECOSYS M3146» не заведена: заведите её листом «Модели аппаратов» или в портале, либо исправьте написание',
    ]);
  });

  it('одноимённые модели разных типов требуют уточнения типа', async () => {
    const env = makeConsumableEnv();
    await resolveConsumablesIn(env, { codes: [{ asked: 'Б0000014256', key: 'Б0000014256' }] }, [
      { 'Подходит к': 'HP DesignJet T230' },
    ]);
    const { ctx } = consumableRowIn(env, { 'Подходит к': 'HP DesignJet T230' });
    expect(ctx.problems).toEqual([
      'модель «HP DesignJet T230» заведена у нескольких типов (mfp, plotter) — уточните тип: «mfp: HP DesignJet T230»',
    ]);
  });

  it('код в другом регистре и с пробелом — та же карточка: отказ словами, а не второй строкой', async () => {
    const env = makeConsumableEnv();
    await resolveConsumablesIn(
      env,
      // Ответ базы: у «д000 0337741» ключ тот же, что у заведённого «Д0000337741».
      { codes: [{ asked: 'д000 0337741', key: 'Д0000337741' }] },
      [{ Код: 'д000 0337741' }],
    );
    const { ctx } = consumableRowIn(env, { Код: 'д000 0337741' });
    expect(ctx.problems).toEqual([
      'код «д000 0337741» уже занят карточкой «Тонер Kyocera TK-3190 (шт)»: регистр и пробелы в коде не различаются — правьте её строкой из выгрузки, где заполнена колонка «Идентификатор»',
    ]);
  });

  it('два написания одного кода в одном файле: вторая строка отвергается словами', async () => {
    const env = makeConsumableEnv();
    await resolveConsumablesIn(
      env,
      {
        codes: [
          { asked: 'Б0000014256', key: 'Б0000014256' },
          { asked: 'б000 0014256', key: 'Б0000014256' },
        ],
      },
      [{ Код: 'Б0000014256' }, { Код: 'б000 0014256' }],
    );
    expect(consumableRowIn(env, { Код: 'Б0000014256' }).ctx.problems).toEqual([]);
    expect(consumableRowIn(env, { Код: 'б000 0014256' }).ctx.problems).toEqual([
      'в файле это тот же код, что и в строке с написанием «Б0000014256»: регистр и пробелы код не различают, и завести его дважды нельзя',
    ]);
  });

  it('своя же карточка занятой не считается', () => {
    const { ctx } = consumableEditIn(consumableEnv, consumableRow, { Комментарий: 'по две' });
    expect(ctx.problems).toEqual([]);
  });

  it('строка без кода и без наименования не заводится', () => {
    const { ctx } = consumableRowIn(consumableEnv, { Код: '', Наименование: '' });
    expect(ctx.problems).toEqual([
      'строка без кода не заводится: по нему она и ищется в справочнике',
      'строка без наименования не заводится: по нему позицию и находят',
    ]);
  });

  it('наименование не нормализуется: дословно как в счёте', async () => {
    const env = makeConsumableEnv();
    const verbose = 'Тонер-картридж  Ricoh  MP 2014 (шт)';
    await resolveConsumablesIn(env, { codes: [{ asked: 'Б0000014256', key: 'Б0000014256' }] }, [
      { Наименование: verbose },
    ]);
    const { ctx, cells } = consumableRowIn(env, { Наименование: verbose });
    expect(ctx.problems).toEqual([]);
    // Двойные пробелы остаются: у расходника имя сверяют глазами со счётом (Р5), в отличие от
    // наименования модели, которое сворачивает база.
    expect(cells['Наименование']).toBe(verbose);
  });

  it('пустая ячейка цвета не стирает, а комментарий — стирает', () => {
    const { cells, ctx } = consumableEditIn(consumableEnv, consumableRow, {
      Цвет: '',
      Комментарий: '',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цвет']).toBe('чёрный');
    expect(cells['Комментарий']).toBe('');
  });

  it('на листе «Справка» сказано, что остаток файлом не грузится', () => {
    const help = consumablesDir.help(consumableEnv).join('\n');
    expect(help).toMatch(/ОСТАТОК ФАЙЛОМ НЕ ГРУЗИТСЯ/u);
  });
});
