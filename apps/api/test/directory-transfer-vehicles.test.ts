import { describe, expect, it, vi } from 'vitest';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Описания справочников техники для обмена файлом (ADR 0073).
 *
 * Проверяется то, что описание решает само, а не то, что за него сделает база: собирается ли строка
 * файла обратно в ту же строку, что из неё выгрузили; не стирает ли пустая ячейка заведённое;
 * ловятся ли заранее ссылки, которых нет, и наборы полей, которые в базе запрещены CHECK'ом.
 *
 * Без базы: описания читают из неё только `env()` и `load()`, а колонки, ключи и проверки —
 * чистые функции от модели и окружения. Окружение здесь собирается руками, как его собрал бы
 * портал на живом справочнике.
 */

// Модуль описаний тянет клиент БД (соединение не открывается, но конфиг читается при импорте),
// поэтому переменные окружения ставятся до импорта — приём `directory-purge.test.ts`.
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

const { vehicleDirectories } = await import('../src/services/directory-transfer/defs/vehicles');

// ── Опоры ──

const KIND = '11111111-1111-4111-8111-111111111111';
const TYPE = '22222222-2222-4222-8222-222222222222';
const SPEC_CAPACITY = '33333333-3333-4333-8333-333333333333';
const SPEC_BOOM = '44444444-4444-4444-8444-444444444444';
const SPEC_BUCKET = '44444444-4444-4444-8444-444444444445';
const CATEGORY = '55555555-5555-4555-8555-555555555555';
const MODEL = '66666666-6666-4666-8666-666666666666';
const LESSOR = '77777777-7777-4777-8777-777777777777';
const ORGANIZATION = '88888888-8888-4888-8888-888888888888';
const QUALIFICATION = '99999999-9999-4999-8999-999999999999';
const VEHICLE_OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VEHICLE_RENTAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Составной ключ окружения — той же формы, что склеивает описание. */
const key = (...parts: string[]): string => parts.join('|');

function directoryFor(name: string): AnyDirectory {
  const def = vehicleDirectories.find((d) => d.key === name);
  if (!def) throw new Error(`описание справочника «${name}» не заведено`);
  return def;
}

interface Notes {
  problems: string[];
  warnings: string[];
  ctx: RowContext;
}

/** Копилка замечаний по строке — то же, что движок собирает с листа «Данные». */
function notes(row = 2): Notes {
  const problems: string[] = [];
  const warnings: string[] = [];
  return {
    problems,
    warnings,
    ctx: { row, fail: (m) => problems.push(m), warn: (m) => warnings.push(m) },
  };
}

/** Строка файла: что окажется в ячейках при выгрузке модели. */
function cellsOf(def: AnyDirectory, env: unknown, model: unknown): Record<string, string> {
  return Object.fromEntries(def.columns(env).map((c) => [c.header, c.get(model)]));
}

function applyCells(
  def: AnyDirectory,
  env: unknown,
  model: unknown,
  cells: Record<string, string>,
  ctx: RowContext,
): void {
  for (const column of def.columns(env)) {
    const text = cells[column.header];
    if (text === undefined || !column.set) continue;
    column.set(model, text, ctx);
  }
}

/** Разбор строки файла поверх пустой модели — вместе с проверками, которые не помещаются в ячейку. */
function parseRow(
  def: AnyDirectory,
  env: unknown,
  cells: Record<string, string>,
): Notes & { model: unknown } {
  return applyOver(def, env, def.blank(), cells);
}

/**
 * Разбор строки файла поверх заведённой записи — так же, как это делает движок, когда строка
 * нашлась по ключу или по «Идентификатору». Правки, которые видны только в сравнении с прежним
 * состоянием (переименование кода, смена принадлежности), ловятся именно здесь.
 */
function editRow(
  def: AnyDirectory,
  env: unknown,
  row: unknown,
  cells: Record<string, string>,
): Notes & { model: unknown } {
  return applyOver(def, env, def.model(row, env), cells);
}

function applyOver(
  def: AnyDirectory,
  env: unknown,
  model: unknown,
  cells: Record<string, string>,
): Notes & { model: unknown } {
  const n = notes();
  applyCells(def, env, model, cells, n.ctx);
  def.check?.(model, n.ctx, env);
  return { ...n, model };
}

// ── Окружение и строки справочников ──

const qualifications = {
  byPair: new Map([['driver_license:c', QUALIFICATION]]),
  byCode: new Map([['c', [{ id: QUALIFICATION, typeCode: 'driver_license' }]]]),
  label: new Map([[QUALIFICATION, 'driver_license: c']]),
};

const capacitySpec = {
  specId: SPEC_CAPACITY,
  code: 'lift_capacity',
  name: 'Грузоподъёмность',
  shortName: 'г/п',
  unit: 'т',
  decimals: 1,
  minValue: 0,
  maxValue: 100,
  sortOrder: 10,
  isActive: true,
};

const boomSpec = {
  specId: SPEC_BOOM,
  code: 'boom_length',
  name: 'Длина стрелы',
  shortName: 'стрела',
  unit: 'м',
  decimals: 0,
  minValue: null,
  maxValue: null,
  sortOrder: 20,
  isActive: true,
};

const CATEGORY_NAME = 'Автокраны, г/п 25 т, стрела 21 м';

const kindsEnv = {};
const kindRow = {
  id: KIND,
  code: 'special',
  name: 'Спецтехника',
  sortOrder: 10,
  isActive: true,
};

const specsEnv = {
  saved: new Map([['lift_capacity', { unit: 'т', decimals: 1, usedInTypes: 2 }]]),
};
const specRow = {
  id: SPEC_CAPACITY,
  code: 'lift_capacity',
  name: 'Грузоподъёмность',
  shortName: 'г/п',
  unit: 'т',
  decimals: 1,
  minValue: '0.0000',
  maxValue: '100.0000',
  description: 'Паспортная грузоподъёмность крана',
  sortOrder: 10,
  isActive: true,
};

const typesEnv = {
  kinds: new Map([['special', { id: KIND, isActive: true }]]),
  specs: new Map([
    ['lift_capacity', { id: SPEC_CAPACITY, name: 'Грузоподъёмность', isActive: true }],
    ['boom_length', { id: SPEC_BOOM, name: 'Длина стрелы', isActive: true }],
    // Заведён, но к автокранам не привязан — им проверяется добавление ТТХ типу с категориями.
    ['bucket_volume', { id: SPEC_BUCKET, name: 'Объём ковша', isActive: true }],
  ]),
  saved: new Map([
    [
      'truck_cranes',
      {
        id: TYPE,
        kindCode: 'special',
        specCodes: ['lift_capacity', 'boom_length'],
        categories: 2,
        isLinear: false,
        maintenanceBasis: 'odometer',
      },
    ],
  ]),
  kindCodeById: new Map([[KIND, 'special']]),
  specCodesByTypeId: new Map([[TYPE, ['lift_capacity', 'boom_length']]]),
  qualifications,
};
const typeRow = {
  id: TYPE,
  kindId: KIND,
  code: 'truck_cranes',
  name: 'Автокраны',
  description: 'Краны на автомобильном шасси',
  waybillFormCode: '4p',
  isLinear: false,
  // Размеченный тип: круговой разбор снимается с «да», а не с умолчания, — иначе колонка,
  // печатающая «нет» при любом значении, прошла бы проверку.
  maintenanceBasis: 'odometer',
  defaultQualificationCategoryId: QUALIFICATION,
  sortOrder: 10,
  isActive: true,
};

const categoriesEnv = {
  allSpecs: [
    { code: 'lift_capacity', name: 'Грузоподъёмность', unit: 'т' },
    { code: 'boom_length', name: 'Длина стрелы', unit: 'м' },
  ],
  specIdByCode: new Map([
    ['lift_capacity', SPEC_CAPACITY],
    ['boom_length', SPEC_BOOM],
  ]),
  types: new Map([
    ['truck_cranes', { id: TYPE, name: 'Автокраны', specs: [capacitySpec, boomSpec] }],
  ]),
  typeCodeById: new Map([[TYPE, 'truck_cranes']]),
  // Значения приезжают из numeric(14,4) — с хвостовыми нулями, как их отдаёт база.
  values: new Map([
    [
      CATEGORY,
      new Map([
        ['lift_capacity', '25.0000'],
        ['boom_length', '21.0000'],
      ]),
    ],
  ]),
};
const categoryRow = {
  id: CATEGORY,
  vehicleTypeId: TYPE,
  name: CATEGORY_NAME,
  isAutoName: true,
  sortOrder: 100,
  isActive: true,
};

const modelsEnv = {
  types: new Map([['truck_cranes', { id: TYPE }]]),
  typeCodeById: new Map([[TYPE, 'truck_cranes']]),
};
const modelRow = {
  id: MODEL,
  vehicleTypeId: TYPE,
  name: 'КС-45717А-1Р',
  manufacturerName: 'ОАО «Автокран»',
  description: '',
  isActive: true,
};

const vehiclesEnv = {
  types: new Map([['truck_cranes', { id: TYPE }]]),
  typeCodeById: new Map([[TYPE, 'truck_cranes']]),
  categories: new Map([
    [key('truck_cranes', CATEGORY_NAME.toLowerCase()), { id: CATEGORY, isActive: true }],
  ]),
  categoryNameById: new Map([[CATEGORY, CATEGORY_NAME]]),
  models: new Map([[key('truck_cranes', 'кс 45717а 1р'), { id: MODEL }]]),
  modelNameById: new Map([[MODEL, 'КС-45717А-1Р']]),
  lessors: new Map([['7701234567', { id: LESSOR, name: 'ООО «Спецпорт»', isActive: true }]]),
  lessorInnById: new Map([[LESSOR, '7701234567']]),
  organizations: new Map([
    ['ооо «су-10»', { id: ORGANIZATION }],
    ['7712345678', { id: ORGANIZATION }],
  ]),
  organizationNameById: new Map([[ORGANIZATION, 'ООО «СУ-10»']]),
  qualifications,
};

const ownVehicleRow = {
  id: VEHICLE_OWN,
  ownership: 'own',
  vehicleTypeId: TYPE,
  vehicleCategoryId: CATEGORY,
  vehicleModelId: MODEL,
  registrationNumber: 'О263ВО777',
  inventoryNumber: '00000987',
  garageNumber: '412',
  serialNumber: 'Y3M6312B3D0000575',
  passportNumber: '37 НУ 697096',
  manufacturerName: 'ОАО «Автокран»',
  manufacturedOn: '2013-01-01',
  requiredQualificationCategoryId: QUALIFICATION,
  ownerOrganizationId: ORGANIZATION,
  lessorId: null,
  description: '',
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  status: 'active',
  sourceName: 'Список автотехники на 23.07.26',
  note: '',
};

const rentalVehicleRow = {
  id: VEHICLE_RENTAL,
  ownership: 'rental',
  vehicleTypeId: TYPE,
  vehicleCategoryId: CATEGORY,
  vehicleModelId: null,
  registrationNumber: null,
  inventoryNumber: null,
  garageNumber: null,
  serialNumber: null,
  passportNumber: null,
  manufacturerName: '',
  manufacturedOn: null,
  requiredQualificationCategoryId: null,
  ownerOrganizationId: null,
  lessorId: LESSOR,
  description: 'Автокран г/п 25 т',
  pricePerHour: '3400.00',
  pricePerShift: '27200.00',
  shiftHours: 8,
  status: 'active',
  sourceName: 'Протокол договорной цены',
  note: 'Смена — 8 часов',
};

/** По одной заведённой строке на каждое описание: с них снимаются круговой разбор и пустые ячейки. */
const FIXTURES = [
  { title: 'Виды ТС', name: 'vehicle-kinds', env: kindsEnv, row: kindRow, erasable: [] },
  { title: 'ТТХ', name: 'vehicle-specs', env: specsEnv, row: specRow, erasable: ['Описание'] },
  { title: 'Типы ТС', name: 'vehicle-types', env: typesEnv, row: typeRow, erasable: ['Описание'] },
  {
    title: 'Категории типов ТС',
    name: 'vehicle-categories',
    env: categoriesEnv,
    row: categoryRow,
    erasable: [],
  },
  {
    title: 'Модели техники',
    name: 'vehicle-models',
    env: modelsEnv,
    row: modelRow,
    erasable: ['Описание'],
  },
  {
    title: 'Техника (своя)',
    name: 'vehicles',
    env: vehiclesEnv,
    row: ownVehicleRow,
    erasable: ['Описание предложения', 'Источник', 'Примечание'],
  },
  {
    title: 'Техника (аренда)',
    name: 'vehicles',
    env: vehiclesEnv,
    row: rentalVehicleRow,
    erasable: ['Описание предложения', 'Источник', 'Примечание'],
  },
];

describe('обмен справочниками техники: выгрузка и разбор', () => {
  it.each(FIXTURES)(
    '$title: строка файла собирается обратно в ту же запись',
    ({ name, env, row }) => {
      const def = directoryFor(name);
      const saved = def.model(row, env);
      const cells = cellsOf(def, env, saved);

      const parsed = parseRow(def, env, cells);
      expect(parsed.problems).toEqual([]);
      expect(cellsOf(def, env, parsed.model)).toEqual(cells);
      // Ключ обязан совпасть: иначе загрузка выгруженного файла завела бы вторую такую же запись.
      expect(def.keyOf(parsed.model)).toBe(def.keyOf(saved));
    },
  );

  it.each(FIXTURES)(
    '$title: пустая ячейка не стирает заполненное',
    ({ name, env, row, erasable }) => {
      const def = directoryFor(name);
      const model = def.model(row, env);
      const before = cellsOf(def, env, model);

      const n = notes();
      applyCells(
        def,
        env,
        model,
        Object.fromEntries(Object.keys(before).map((header) => [header, ''])),
        n.ctx,
      );

      expect(n.problems).toEqual([]);
      const after = cellsOf(def, env, model);
      for (const [header, value] of Object.entries(before)) {
        // Комментарий, описание и источник — единственные колонки, где пусто законно значит «стереть».
        expect([header, after[header]]).toEqual([header, erasable.includes(header) ? '' : value]);
      }
    },
  );

  // Колонку в файле человек вправе удалить, и тогда `set` не вызовется ни разу: обязательность
  // проверяется по собранной модели, иначе новая строка молча завелась бы без кода и наименования.
  it.each(FIXTURES)('$title: строка без обязательных колонок не заводится', ({ name, env }) => {
    const def = directoryFor(name);
    expect(parseRow(def, env, {}).problems.length).toBeGreaterThan(0);
  });
});

describe('типы ТС', () => {
  const def = directoryFor('vehicle-types');
  const filled = {
    Код: 'dump_trucks',
    'Вид ТС (код)': 'special',
    Наименование: 'Самосвалы',
    'ТТХ (коды)': 'lift_capacity',
  };

  it('незнакомый вид ТС называет порядок загрузки справочников', () => {
    const { problems } = parseRow(def, typesEnv, { ...filled, 'Вид ТС (код)': 'spec' });
    expect(problems).toEqual(['вид ТС «spec» не найден — сначала загрузите справочник видов ТС']);
  });

  it('незнакомый код ТТХ отвергается — привязки не заводятся «на лету»', () => {
    const { problems } = parseRow(def, typesEnv, {
      ...filled,
      'ТТХ (коды)': 'lift_capacity; axle_count',
    });
    expect(problems).toEqual(['ТТХ «axle_count» не найден — сначала загрузите справочник ТТХ']);
  });

  it('у типа с категориями ТТХ файлом не отвязывается', () => {
    const { problems } = editRow(def, typesEnv, typeRow, { 'ТТХ (коды)': 'lift_capacity' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ТТХ «boom_length» отвязать нельзя');
  });

  it('у типа с категориями ТТХ файлом и не добавляется: каждой категории нужно значение', () => {
    // Переименование кода в той же строке проверку не снимает: заведённая запись помнит, чем была.
    const { problems } = editRow(def, typesEnv, typeRow, {
      Код: 'cranes',
      'ТТХ (коды)': 'lift_capacity; boom_length; bucket_volume',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ТТХ «bucket_volume» добавить нельзя');
  });

  it('бланк путевого листа пишется словом', () => {
    const { model, problems } = parseRow(def, typesEnv, {
      ...filled,
      'Бланк путевого листа': 'Форма № 3',
    });
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['Бланк путевого листа']).toBe('Форма № 3');
  });

  /*
   * Признак линейности (ADR 0100) ездит файлом наравне с бланком: без колонки перенос справочника
   * между установками терял бы его молча — тип приезжал бы недельным, а заказы по нему уже ведутся
   * днями.
   */
  it('линейная техника ставится «да» и не сбрасывается пустой ячейкой', () => {
    const { model, problems } = parseRow(def, typesEnv, {
      ...filled,
      'Линейная техника': 'да',
    });
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['Линейная техника']).toBe('да');

    const untouched = editRow(
      def,
      typesEnv,
      { ...typeRow, isLinear: true },
      {
        'Линейная техника': '',
      },
    );
    expect(cellsOf(def, typesEnv, untouched.model)['Линейная техника']).toBe('да');
  });

  it('признак у заведённого типа файлом не переключается — даже без единой заявки', () => {
    // Заявок в работе у этого типа нет вовсе, и раньше файл его переключал молча: отказ смотрел
    // на их число (ADR 0107, решение 13). Теперь запрет безусловен — решение о переключении
    // принимают, глядя на перечень заявок, которые останутся на прежнем режиме, а строка файла
    // такого перечня не показывает и показать не может.
    const { problems } = editRow(def, typesEnv, typeRow, { 'Линейная техника': 'да' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      'Признак «Линейная техника» файлом не переключают: его меняют в карточке типа, где портал называет заявки, которые останутся на прежнем режиме',
    );

    // Та же строка без смены признака проходит: запрет держит поле, а не всю запись.
    const rename = editRow(def, typesEnv, typeRow, { Наименование: 'Автокраны и краны' });
    expect(rename.problems).toEqual([]);
  });

  /*
   * Признак «ТО по пробегу» (Р13) ездит файлом по той же причине, что и линейность: без колонки
   * тип, перенесённый выгрузкой-загрузкой, приезжал бы неразмеченным, и обслуживание его машин
   * портал молча не считал бы.
   */
  it('«ТО по пробегу» ставится «да» и читается обратно', () => {
    const { model, problems } = parseRow(def, typesEnv, { ...filled, 'ТО по пробегу': 'да' });
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['ТО по пробегу']).toBe('да');
  });

  it('файл без колонки заводит тип неразмеченным, а не отменяет строку', () => {
    // Ровно старая выгрузка: колонки в ней не было вовсе, и `set` не позовётся ни разу.
    const { model, problems } = parseRow(def, typesEnv, filled);
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['ТО по пробегу']).toBe('нет');
  });

  it('пустая ячейка не снимает признак у заведённого типа', () => {
    const { model, problems } = editRow(def, typesEnv, typeRow, { 'ТО по пробегу': '' });
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['ТО по пробегу']).toBe('да');
  });

  it('снятие признака файлом проходит, но говорит о себе вслух', () => {
    // В отличие от линейности, признак ТО переключается файлом: у заявок в работе он ничего не
    // переписывает. Молча исчезнуть расчёт при этом не вправе — отсюда замечание в отчёте.
    const { model, problems, warnings } = editRow(def, typesEnv, typeRow, {
      'ТО по пробегу': 'нет',
    });
    expect(problems).toEqual([]);
    expect(cellsOf(def, typesEnv, model)['ТО по пробегу']).toBe('нет');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('«ТО по пробегу» снимается');
  });
});

describe('ТТХ', () => {
  const def = directoryFor('vehicle-specs');

  it('единицу измерения у ТТХ со значениями сменить нельзя', () => {
    const { problems } = editRow(def, specsEnv, specRow, { 'Единица измерения': 'кг' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('единицу измерения ТТХ «lift_capacity» изменить нельзя');
  });

  it('число знаков после запятой у такого ТТХ тоже заморожено', () => {
    const { problems } = editRow(def, specsEnv, specRow, { 'Знаков после запятой': '2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('число знаков после запятой');
  });

  it('код такого ТТХ не переименовывается: он входит в подпись набора значений категорий', () => {
    const { problems } = editRow(def, specsEnv, specRow, { Код: 'capacity' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('код ТТХ «lift_capacity» изменить нельзя');
  });

  it('наименование и границы у ТТХ со значениями правятся свободно', () => {
    const { problems } = editRow(def, specsEnv, specRow, {
      Наименование: 'Грузоподъёмность крана',
      Максимум: '130',
    });
    expect(problems).toEqual([]);
  });

  it('новый ТТХ заводится с любой единицей измерения', () => {
    const { problems } = parseRow(def, specsEnv, {
      Код: 'bucket_volume',
      Наименование: 'Объём ковша',
      'Единица измерения': 'м³',
    });
    expect(problems).toEqual([]);
  });
});

describe('категории типов ТС', () => {
  const def = directoryFor('vehicle-categories');
  const CAPACITY_COLUMN = 'ТТХ: Грузоподъёмность, т';
  const BOOM_COLUMN = 'ТТХ: Длина стрелы, м';

  it('колонки ТТХ берутся из справочника характеристик', () => {
    expect(def.columns(categoriesEnv).map((c) => c.header)).toEqual([
      'Тип ТС (код)',
      'Название',
      'Имя задано вручную',
      'Порядок',
      'Активна',
      CAPACITY_COLUMN,
      BOOM_COLUMN,
    ]);
  });

  it('неполный набор значений ТТХ отвергается', () => {
    const { problems } = parseRow(def, categoriesEnv, {
      'Тип ТС (код)': 'truck_cranes',
      [CAPACITY_COLUMN]: '30',
    });
    expect(problems).toEqual(['Не заданы значения ТТХ: Длина стрелы']);
  });

  it('значение по ТТХ, к типу не привязанному, отвергается', () => {
    const env = {
      ...categoriesEnv,
      types: new Map([['truck_cranes', { id: TYPE, name: 'Автокраны', specs: [capacitySpec] }]]),
    };
    const { problems } = parseRow(def, env, {
      'Тип ТС (код)': 'truck_cranes',
      [CAPACITY_COLUMN]: '30',
      [BOOM_COLUMN]: '21',
    });
    expect(problems).toEqual(['Передано значение по ТТХ, не привязанному к этому типу']);
  });

  it('другой набор значений — другая категория, тот же набор — та же', () => {
    const same = parseRow(def, categoriesEnv, {
      'Тип ТС (код)': 'truck_cranes',
      [CAPACITY_COLUMN]: '25',
      [BOOM_COLUMN]: '21',
    });
    const other = parseRow(def, categoriesEnv, {
      'Тип ТС (код)': 'truck_cranes',
      [CAPACITY_COLUMN]: '32',
      [BOOM_COLUMN]: '21',
    });
    const renamed = parseRow(def, categoriesEnv, {
      'Тип ТС (код)': 'truck_cranes',
      Название: 'Кран потяжелее',
      'Имя задано вручную': 'да',
      [CAPACITY_COLUMN]: '25',
      [BOOM_COLUMN]: '21',
    });

    expect(same.problems).toEqual([]);
    expect(other.problems).toEqual([]);
    // Ключ — тип и набор значений: заведённая категория узнаётся по нему, а не по названию.
    expect(def.keyOf(same.model)).toBe(def.keyOf(def.model(categoryRow, categoriesEnv)));
    expect(def.keyOf(renamed.model)).toBe(def.keyOf(same.model));
    expect(def.keyOf(other.model)).not.toBe(def.keyOf(same.model));
  });

  it('правка значения у заведённой категории объясняется в отчёте', () => {
    const { problems, warnings } = editRow(def, categoriesEnv, categoryRow, {
      [CAPACITY_COLUMN]: '32',
    });
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('набор значений ТТХ — это и есть категория');
  });

  it('значение сверх допустимого масштаба отвергается правилами справочника ТТХ', () => {
    const { problems } = parseRow(def, categoriesEnv, {
      'Тип ТС (код)': 'truck_cranes',
      [CAPACITY_COLUMN]: '25,25',
      [BOOM_COLUMN]: '21',
    });
    expect(problems).toEqual([
      '«Грузоподъёмность»: знаков после запятой допустимо 1, получено больше',
    ]);
  });
});

describe('модели техники', () => {
  const def = directoryFor('vehicle-models');

  it('наименование сравнивается так же, как его нормализует база', () => {
    const saved = def.model(modelRow, modelsEnv);
    const written = parseRow(def, modelsEnv, {
      'Тип ТС (код)': 'truck_cranes',
      Наименование: 'КС 45717А  1Р',
    });
    expect(written.problems).toEqual([]);
    expect(def.keyOf(written.model)).toBe(def.keyOf(saved));
  });

  it('незнакомый тип ТС называет порядок загрузки', () => {
    const { problems } = parseRow(def, modelsEnv, {
      'Тип ТС (код)': 'dump_trucks',
      Наименование: 'МАЗ 6501В5',
    });
    expect(problems).toEqual([
      'тип ТС «dump_trucks» не найден — сначала загрузите справочник типов ТС',
    ]);
  });
});

describe('техника', () => {
  const def = directoryFor('vehicles');

  const ownCells = {
    Принадлежность: 'Собственная',
    'Тип ТС (код)': 'truck_cranes',
    Госномер: 'О263ВО777',
  };
  const rentalCells = {
    Принадлежность: 'Аренда',
    'Тип ТС (код)': 'truck_cranes',
    'Арендодатель (ИНН)': '7701234567',
    'Описание предложения': 'Автокран г/п 25 т',
    'Цена за час': '3400',
  };

  it('ключ собственной машины — госномер, и раскладка на него не влияет', () => {
    const saved = def.model(ownVehicleRow, vehiclesEnv);
    const latin = parseRow(def, vehiclesEnv, { ...ownCells, Госномер: 'O 263 BO 777' });
    expect(latin.problems).toEqual([]);
    expect(def.keyOf(latin.model)).toBe(def.keyOf(saved));
  });

  it('ключ предложения аренды — арендодатель, тип и описание', () => {
    const saved = def.model(rentalVehicleRow, vehiclesEnv);
    const written = parseRow(def, vehiclesEnv, rentalCells);
    expect(written.problems).toEqual([]);
    expect(def.keyOf(written.model)).toBe(def.keyOf(saved));
    expect(def.keyOf(written.model)).toBe('7701234567|truck_cranes|Автокран г/п 25 т');
  });

  it('арендная машина с госномером отвергается', () => {
    const { problems } = parseRow(def, vehiclesEnv, { ...rentalCells, Госномер: 'О263ВО777' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('у предложения аренды не заполняют реквизиты машины: Госномер');
  });

  it('своя машина с ценой аренды отвергается', () => {
    const { problems } = parseRow(def, vehiclesEnv, { ...ownCells, 'Цена за час': '3400' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'у собственной машины не заполняют реквизиты аренды: Цена за час',
    );
  });

  it('предложение аренды без цены отвергается', () => {
    const { problems } = parseRow(def, vehiclesEnv, { ...rentalCells, 'Цена за час': '' });
    expect(problems).toEqual([
      'у предложения аренды нужна хотя бы одна цена — за час или за смену',
    ]);
  });

  it('неизвестный арендодатель называет порядок загрузки справочников', () => {
    const { problems } = parseRow(def, vehiclesEnv, {
      ...rentalCells,
      'Арендодатель (ИНН)': '7799999999',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('арендодатель с ИНН 7799999999 не найден');
  });

  it('категория чужого типа не доезжает до отказа базы', () => {
    const { problems } = parseRow(def, vehiclesEnv, {
      ...ownCells,
      'Категория (название)': 'Самосвалы, объём 20 м³',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('не найдена у типа «truck_cranes»');
  });

  it('принадлежность заведённой записи не меняется', () => {
    const { problems } = editRow(def, vehiclesEnv, ownVehicleRow, { Принадлежность: 'Аренда' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('принадлежность заведённой записи изменить нельзя');
  });

  it('нулевая цена аренды отвергается: договорную оставляют пустой', () => {
    const { problems } = parseRow(def, vehiclesEnv, { ...rentalCells, 'Цена за час': '0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('цена аренды должна быть больше нуля');
  });
});
