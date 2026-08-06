import { describe, expect, it, vi } from 'vitest';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Описания справочников вывоза мусора для обмена файлом (ADR 0073).
 *
 * Проверяется здесь то, ради чего описание и существует: файл, который портал только что отдал,
 * он же обязан принять без единой правки, а строка, которую в базу пускать нельзя, обязана
 * отвергаться человеческими словами и до записи — иначе вместо «строка 12: цена за контейнер
 * задана, а тип контейнера не указан» человек получит имя ограничения БД.
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

const { wasteDirectories } = await import('../src/services/directory-transfer/defs/waste');

function directoryFor(key: string): AnyDirectory {
  const found = wasteDirectories.find((d) => d.key === key);
  if (!found) throw new Error(`описания справочника «${key}» нет в списке`);
  return found;
}

const containerTypesDir = directoryFor('container-types');
const wasteTypesDir = directoryFor('waste-types');
const wasteTariffsDir = directoryFor('waste-tariffs');

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

const AT = new Date('2026-08-01T10:00:00.000Z');

// ── Типы контейнеров ──────────────────────────────────────────────────────────────────────────

const containerTypeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'container_8',
  name: 'Контейнер 8 м³',
  type: 'cont',
  volumeM3: 8,
  sortOrder: 10,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};

describe('типы контейнеров в обмене файлом', () => {
  it('строка переживает выгрузку и загрузку без единой правки', () => {
    const { before, after, ctx } = roundTrip(containerTypesDir, {}, containerTypeRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
  });

  it('вид записи стоит в файле словом, а не кодом перечисления', () => {
    const cells = cellsOf(containerTypesDir, {}, containerTypesDir.model(containerTypeRow, {}));
    expect(cells['Вид']).toBe('Контейнер');

    const ctx = testContext();
    const model = containerTypesDir.blank();
    applyCells(containerTypesDir, {}, model, { ...cells, Вид: 'Самосвал' }, ctx);
    expect(ctx.problems).toEqual([]);
    expect(cellsOf(containerTypesDir, {}, model)['Вид']).toBe('Самосвал');
  });

  it('пустая ячейка заведённое не стирает', () => {
    const model = containerTypesDir.model(containerTypeRow, {});
    const ctx = testContext();
    applyCells(
      containerTypesDir,
      {},
      model,
      { Наименование: '', 'Объём, м³': '', Порядок: '', Активен: '' },
      ctx,
    );
    expect(ctx.problems).toEqual([]);
    expect(cellsOf(containerTypesDir, {}, model)).toEqual(
      cellsOf(containerTypesDir, {}, containerTypesDir.model(containerTypeRow, {})),
    );
  });

  it('нулевую вместимость отвергает описание, а не CHECK в базе', () => {
    const ctx = testContext();
    const model = containerTypesDir.blank();
    applyCells(containerTypesDir, {}, model, { 'Объём, м³': '0' }, ctx);
    expect(ctx.problems).toHaveLength(1);
    expect(ctx.problems[0]).toMatch(/Объём/u);
  });
});

// ── Типы мусора ───────────────────────────────────────────────────────────────────────────────

const wasteTypeRow = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'beton_boy',
  name: 'Бетонный бой',
  nameKey: 'бетонныйбой',
  description: 'Куски бетона и железобетона',
  sortOrder: 20,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};

describe('типы мусора в обмене файлом', () => {
  it('строка переживает выгрузку и загрузку без единой правки', () => {
    const { before, after, ctx } = roundTrip(wasteTypesDir, {}, wasteTypeRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
  });

  it('в файл не попадает вычисляемый ключ названия', () => {
    const headers = wasteTypesDir.columns({}).map((c) => c.header);
    expect(headers).toEqual(['Код', 'Наименование', 'Описание', 'Порядок', 'Активен']);
  });

  it('код кириллицей отвергается с объяснением формата', () => {
    const ctx = testContext();
    const model = wasteTypesDir.blank();
    applyCells(
      wasteTypesDir,
      {},
      model,
      { Код: 'Бетонный бой', Наименование: 'Бетонный бой' },
      ctx,
    );
    expect(ctx.problems).toHaveLength(1);
    expect(ctx.problems[0]).toMatch(/латинские строчные буквы/u);
  });

  it('пустое наименование заведённое не стирает, а пустое описание — стирает', () => {
    const model = wasteTypesDir.model(wasteTypeRow, {});
    const ctx = testContext();
    applyCells(wasteTypesDir, {}, model, { Наименование: '', Описание: '' }, ctx);
    expect(ctx.problems).toEqual([]);
    const cells = cellsOf(wasteTypesDir, {}, model);
    expect(cells['Наименование']).toBe('Бетонный бой');
    expect(cells['Описание']).toBe('');
  });
});

// ── Стоимость вывоза мусора ───────────────────────────────────────────────────────────────────

const OPERATOR_INN = '7701234567';
const CLIENT_INN = '7811111111';

/** Соседние справочники в том виде, в каком их читает описание прайса. */
const tariffEnv = {
  operators: new Map([
    [OPERATOR_INN, { id: '33333333-3333-4333-8333-333333333333', isOperator: true }],
    [CLIENT_INN, { id: '44444444-4444-4444-8444-444444444444', isOperator: false }],
  ]),
  wasteTypeIds: new Map([
    ['beton_boy', '22222222-2222-4222-8222-222222222222'],
    ['stroy_musor', '55555555-5555-4555-8555-555555555555'],
  ]),
  containers: new Map([
    ['container_8', { id: '11111111-1111-4111-8111-111111111111', volumeM3: 8 }],
    ['bunker', { id: '66666666-6666-4666-8666-666666666666', volumeM3: null }],
  ]),
};

/** Цена оператора на конкретный контейнер, объявленная за контейнер целиком. */
const perContainerRow = {
  id: '77777777-7777-4777-8777-777777777777',
  operatorInn: OPERATOR_INN,
  wasteTypeCode: 'beton_boy',
  containerTypeCode: 'container_8',
  containerKind: null,
  pricePerM3: '1875.00',
  pricePerContainer: '15000.00',
  isPerContainer: true,
  note: 'до 10 тонн',
  isActive: true,
};

/** Цена того же оператора на вид техники целиком — по ней и считается вывоз мусора (ADR 0022). */
const perKindRow = {
  id: '88888888-8888-4888-8888-888888888888',
  operatorInn: OPERATOR_INN,
  wasteTypeCode: 'stroy_musor',
  containerTypeCode: null,
  containerKind: 'truck',
  pricePerM3: '1875.50',
  pricePerContainer: null,
  isPerContainer: false,
  note: '',
  isActive: true,
};

const BASE_TARIFF: Cells = {
  'Оператор (ИНН)': OPERATOR_INN,
  'Тип мусора (код)': 'beton_boy',
  'Тип контейнера (код)': 'container_8',
  'Вид техники': '',
  'Цена за м³': '1500',
  'Цена за контейнер': '',
  'Считать за контейнер': 'нет',
  Примечание: '',
  Активен: 'да',
};

/** Новая строка прайса из ячеек файла: разбор и проверки — ровно в том же порядке, что в движке. */
function tariffFrom(patch: Cells): { model: unknown; ctx: TestContext; cells: Cells } {
  const ctx = testContext();
  const model = wasteTariffsDir.blank();
  applyCells(wasteTariffsDir, tariffEnv, model, { ...BASE_TARIFF, ...patch }, ctx);
  wasteTariffsDir.check?.(model, ctx, tariffEnv);
  return { model, ctx, cells: cellsOf(wasteTariffsDir, tariffEnv, model) };
}

describe('стоимость вывоза мусора в обмене файлом', () => {
  it('цена на тип контейнера переживает выгрузку и загрузку без правок', () => {
    const { before, after, ctx } = roundTrip(wasteTariffsDir, tariffEnv, perContainerRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
  });

  it('цена на вид техники переживает выгрузку и загрузку без правок', () => {
    const { before, after, ctx } = roundTrip(wasteTariffsDir, tariffEnv, perKindRow);
    expect(ctx.problems).toEqual([]);
    expect(after).toEqual(before);
    // Копейки не теряются по дороге: в файл и обратно цена едет строкой.
    expect(after['Цена за м³']).toBe('1875.5');
  });

  it('пустая ячейка цену не стирает, а примечание — стирает', () => {
    const model = wasteTariffsDir.model(perContainerRow, tariffEnv);
    const ctx = testContext();
    applyCells(
      wasteTariffsDir,
      tariffEnv,
      model,
      { 'Цена за м³': '', 'Цена за контейнер': '', Примечание: '' },
      ctx,
    );
    expect(ctx.problems).toEqual([]);
    const cells = cellsOf(wasteTariffsDir, tariffEnv, model);
    expect(cells['Цена за контейнер']).toBe('15000');
    expect(cells['Примечание']).toBe('');
  });

  it('ключ строки собирается из тройки и различает цель тарифа', () => {
    const onContainer = tariffFrom({});
    const onKind = tariffFrom({ 'Тип контейнера (код)': '', 'Вид техники': 'Самосвал' });
    expect(onContainer.ctx.problems).toEqual([]);
    expect(onKind.ctx.problems).toEqual([]);

    const keyOnContainer = wasteTariffsDir.keyOf(onContainer.model);
    const keyOnKind = wasteTariffsDir.keyOf(onKind.model);
    expect(keyOnContainer).toContain(OPERATOR_INN);
    expect(keyOnContainer).toContain('beton_boy');
    expect(keyOnContainer).not.toBe(keyOnKind);
    // Ключ строки без оператора не собрался: об этом уже сказала ошибка разбора.
    expect(wasteTariffsDir.keyOf(tariffFrom({ 'Оператор (ИНН)': '' }).model)).toBe('');
  });

  it('цена с запятой принимается, отрицательная — нет', () => {
    expect(tariffFrom({ 'Цена за м³': '1 875,50' }).cells['Цена за м³']).toBe('1875.5');

    // Отрицательная цена не читается вовсе, поэтому строка получает и вторую жалобу — «цены нет».
    const negative = tariffFrom({ 'Цена за м³': '-5' });
    expect(negative.ctx.problems[0]).toMatch(/Цена за м³ — не меньше/u);
    expect(negative.cells['Цена за м³']).toBe('');
  });

  it('«считать за контейнер» без типа контейнера отвергается', () => {
    const { ctx } = tariffFrom({
      'Тип контейнера (код)': '',
      'Вид техники': 'Самосвал',
      'Считать за контейнер': 'да',
      'Цена за контейнер': '15000',
    });
    expect(ctx.problems).toContainEqual(
      expect.stringContaining('цена за контейнер задана, а тип контейнера не указан'),
    );
  });

  it('«считать за контейнер» без цены за контейнер отвергается', () => {
    const { ctx } = tariffFrom({ 'Считать за контейнер': 'да' });
    expect(ctx.problems).toContainEqual(expect.stringContaining('цена за контейнер не задана'));
  });

  it('цена за контейнер пересчитывается в цену за 1 м³ по вместимости типа', () => {
    const { cells, ctx } = tariffFrom({
      'Считать за контейнер': 'да',
      'Цена за контейнер': '15000',
      'Цена за м³': '',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цена за м³']).toBe('1875');
  });

  it('цену за м³ у позиции «за контейнер» выводит портал, а набранная вручную не молчит', () => {
    const { cells, ctx } = tariffFrom({
      'Считать за контейнер': 'да',
      'Цена за контейнер': '15000',
      'Цена за м³': '1000',
    });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цена за м³']).toBe('1875');
    expect(ctx.warnings).toContainEqual(expect.stringContaining('выведена из цены за контейнер'));
  });

  it('тип контейнера без вместимости за контейнер не тарифицируется', () => {
    const { ctx } = tariffFrom({
      'Тип контейнера (код)': 'bunker',
      'Считать за контейнер': 'да',
      'Цена за контейнер': '15000',
    });
    expect(ctx.problems).toContainEqual(expect.stringContaining('не задана вместимость'));
  });

  it('заполненные разом тип контейнера и вид техники отвергаются', () => {
    const { ctx } = tariffFrom({ 'Вид техники': 'Самосвал' });
    expect(ctx.problems).toContainEqual(
      expect.stringContaining('заполнены и тип контейнера, и вид техники'),
    );
  });

  it('строка без типа контейнера и без вида техники отвергается', () => {
    const { ctx } = tariffFrom({ 'Тип контейнера (код)': '', 'Вид техники': '' });
    expect(ctx.problems).toContainEqual(
      expect.stringContaining('не указаны ни тип контейнера, ни вид техники'),
    );
  });

  it('неизвестный код типа мусора называет порядок загрузки справочников', () => {
    const { ctx } = tariffFrom({ 'Тип мусора (код)': 'grunt' });
    expect(ctx.problems).toEqual([
      'тип мусора «grunt» не найден — сначала загрузите справочник типов мусора',
    ]);
  });

  it('неизвестный код типа контейнера называет порядок загрузки справочников', () => {
    const { ctx } = tariffFrom({ 'Тип контейнера (код)': 'container_99' });
    expect(ctx.problems).toContainEqual(
      expect.stringContaining('сначала загрузите справочник типов контейнеров'),
    );
  });

  it('неизвестный ИНН оператора называет порядок загрузки справочников', () => {
    const { ctx } = tariffFrom({ 'Оператор (ИНН)': '7712345678' });
    expect(ctx.problems).toEqual([
      'оператор с ИНН 7712345678 не найден — сначала загрузите справочник контрагентов',
    ]);
  });

  it('наименование вместо ИНН оператора не выдаётся за ненайденную запись', () => {
    const { ctx } = tariffFrom({ 'Оператор (ИНН)': 'ООО «Ромашка»' });
    expect(ctx.problems[0]).toMatch(/Оператор \(ИНН\)/u);
    expect(ctx.problems.join(' ')).not.toMatch(/не найден/u);
  });

  it('контрагент не того типа оператором не считается', () => {
    const { ctx } = tariffFrom({ 'Оператор (ИНН)': CLIENT_INN });
    expect(ctx.problems).toContainEqual(expect.stringContaining('не оператором вывоза'));
  });

  it('цена за контейнер при «считать за контейнер» = «нет» не сохраняется молча', () => {
    const { cells, ctx } = tariffFrom({ 'Цена за контейнер': '15000' });
    expect(ctx.problems).toEqual([]);
    expect(cells['Цена за контейнер']).toBe('');
    expect(ctx.warnings).toHaveLength(1);
  });
});
