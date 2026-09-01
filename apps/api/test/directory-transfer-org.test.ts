import { describe, expect, it, vi } from 'vitest';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Организационные справочники обмена файлом (ADR 0073): объекты, отделы, контрагенты, склады и
 * организации-владельцы транспорта.
 *
 * Проверяется чистая часть описаний — та, что не ходит в базу: разбор ячейки, сборка ключа строки
 * и проверки `check()`. Главное свойство здесь одно и то же у всех пяти: выгруженная строка,
 * загруженная обратно, даёт те же ячейки. Разойдись `get` и `set` хоть в одной колонке — портал
 * начал бы показывать правку в файле, который сам же и отдал, а человек искал бы, что он изменил.
 */

// Описания лежат рядом с клиентом БД и тянут за собой конфиг: в проверках ниже ни то, ни другое не
// участвует, и значения ставятся до импорта, чтобы модуль вообще загрузился (приём
// `directory-purge.test.ts`).
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

const { organizationalDirectories } = await import('../src/services/directory-transfer/defs/org');

/** Ячейки одной строки листа «Данные»: заголовок колонки → её текст. */
type Cells = Record<string, string>;

function def(key: string): AnyDirectory {
  const found = organizationalDirectories.find((d) => d.key === key);
  if (!found) throw new Error(`описание справочника «${key}» не заведено`);
  return found;
}

/** Строка в файле: все колонки описания. */
function cellsOf(d: AnyDirectory, env: unknown, model: unknown): Cells {
  return Object.fromEntries(d.columns(env).map((c) => [c.header, c.get(model)]));
}

/**
 * То же без справочных колонок. Колонку без `set` загрузка не читает вовсе, поэтому после разбора
 * в ней стоит значение пустой модели — сверять его с выгруженным нечего.
 */
function readableCellsOf(d: AnyDirectory, env: unknown, model: unknown): Cells {
  return Object.fromEntries(
    d
      .columns(env)
      .filter((c) => c.set)
      .map((c) => [c.header, c.get(model)]),
  );
}

interface Applied {
  cells: Cells;
  key: string;
  title: string;
  problems: string[];
  warnings: string[];
}

/**
 * Что загрузка сделает со строкой: разбирает ячейки поверх модели — заведённой записи или пустой,
 * если строка дописана человеком, — прогоняет `check()` и показывает получившееся теми же `get`,
 * которыми пишется файл. Ровно этот порядок вызовов делает движок.
 */
function apply(d: AnyDirectory, env: unknown, model: unknown, cells: Cells): Applied {
  const problems: string[] = [];
  const warnings: string[] = [];
  const ctx: RowContext = {
    row: 2,
    fail: (message) => problems.push(message),
    warn: (message) => warnings.push(message),
  };
  for (const column of d.columns(env)) {
    // Колонка отзывается и на прежние свои имена (`aliases`) — так её ищет движок (`mapHeader`),
    // и без этого файл, выгруженный до переименования колонки, здесь бы не проверялся.
    const named = [column.header, ...(column.aliases ?? [])].find((h) => cells[h] !== undefined);
    if (named === undefined || !column.set) continue;
    column.set(model, cells[named]!, ctx);
  }
  d.check?.(model, ctx, env);
  return {
    cells: cellsOf(d, env, model),
    key: d.keyOf(model),
    title: d.titleOf(model),
    problems,
    warnings,
  };
}

/** Выгрузили строку — загрузили обратно поверх пустой модели: ячейки обязаны совпасть. */
function roundTrip(d: AnyDirectory, env: unknown, row: unknown): void {
  const exported = cellsOf(d, env, d.model(row, env));
  const rebuilt = d.blank();
  const back = apply(d, env, rebuilt, exported);
  expect(back.problems).toEqual([]);
  expect(readableCellsOf(d, env, rebuilt)).toEqual(readableCellsOf(d, env, d.model(row, env)));
  expect(back.cells['Идентификатор']).toBeUndefined();
}

// ── Фикстуры ──
// ИНН настоящие по контрольной сумме и вымышленные по принадлежности: проверка ловит опечатку в
// одной цифре, и набранный наугад номер её не прошёл бы.
const SUPPLIER_INN = '7707083893';
const LESSOR_INN = '7736050003';
const ENTREPRENEUR_INN = '500100732259';

const objectRow = {
  id: 'obj-1',
  code: 'АЛ13',
  name: 'ЖК ALIA, БЛОКИ 13А, 13В',
  address: 'ЛЁТНАЯ УЛ., ЖК «ÁLIA», БЛОКИ 13А, 13В',
  isActive: true,
};

/** Заголовок колонки площадок — он же ключ ячейки в проверках ниже. */
const OBJECTS_HEADER = 'Площадки (коды объектов)';

/**
 * Окружение справочника отделов (ADR 0144). Набор площадок приходит отдельной картой, а не из
 * колонки строки: колонка `construction_object_id` живёт совместимой проекцией и при наборе из
 * нескольких площадок стоит в `NULL`.
 *
 * Коды нарочно разные по устройству: «МЫТ, К2» с запятой внутри — тот случай, ради которого
 * разделителем взята только точка с запятой, «ПЛОХ;ОЙ» — тот, который выгрузка обязана отвергнуть.
 */
const departmentEnv = {
  objectIdByCode: new Map([
    ['АЛ13', 'obj-1'],
    ['СЕВ', 'obj-2'],
    ['МЫТ, К2', 'obj-3'],
    ['ПЛОХ;ОЙ', 'obj-4'],
  ]),
  objectCodesByDepartmentId: new Map([
    ['dep-1', ['АЛ13', 'СЕВ']],
    ['dep-3', ['ПЛОХ;ОЙ']],
  ]),
};

const departmentRow = {
  id: 'dep-1',
  code: 'ПТО',
  name: 'Производственно-технический отдел',
  // При наборе из нескольких площадок проекция пуста — и модель обязана собираться не из неё.
  constructionObjectId: null,
  isActive: true,
};

const counterpartyEnv = {
  synonymsById: new Map([['cp-1', ['РОМАШКА', 'Ромашка ООО']]]),
  storedByInn: new Map([
    [SUPPLIER_INN, { name: 'ООО «Ромашка»', type: 'supplier', isActive: true }],
    [LESSOR_INN, { name: 'ООО «Аренда-Строй»', type: 'vehicle_lessor', isActive: true }],
  ]),
};

const counterpartyRow = {
  id: 'cp-1',
  type: 'supplier',
  name: 'ООО «Ромашка»',
  inn: SUPPLIER_INN,
  comment: 'отгружает по доверенности',
  isActive: true,
  deletedAt: null,
};

const warehouseEnv = {
  byInn: new Map([
    [SUPPLIER_INN, { id: 'cp-1', name: 'ООО «Ромашка»', type: 'supplier' }],
    [LESSOR_INN, { id: 'cp-2', name: 'ООО «Аренда-Строй»', type: 'vehicle_lessor' }],
  ]),
  innById: new Map([
    ['cp-1', SUPPLIER_INN],
    ['cp-2', LESSOR_INN],
  ]),
};

const warehouseRow = {
  id: 'wh-1',
  supplierCounterpartyId: 'cp-1',
  address: 'г. Мытищи, Олимпийский пр-т, 10',
  name: 'Основной',
  contactPerson: 'Иванов И. И.',
  contactPhone: '9261234567',
  comment: 'пропуск заказывают за сутки',
  isActive: true,
};

const organizationRow = {
  id: 'org-1',
  name: 'АО «Служба механизации»',
  inn: LESSOR_INN,
  address: 'г. Москва, Лётная ул., 1',
  phone: '(495) 123-45-67, +7 985 000 00 00',
  okpo: '12345678',
  ogrn: '1234567890123',
  isPrimary: true,
  isActive: true,
  comment: '',
};

describe('организационные справочники обмена', () => {
  it('описаны все пять: без описания справочник не попадёт ни в список, ни в выгрузку', () => {
    expect(organizationalDirectories.map((d) => d.key)).toEqual([
      'objects',
      'departments',
      'counterparties',
      'warehouses',
      'organizations',
    ]);
  });
});

describe('объекты строительства', () => {
  const d = def('objects');

  it('выгруженная строка загружается обратно без единой правки', () => {
    roundTrip(d, {}, objectRow);
  });

  it('ключ строки — код, и по нему же её называют в отчёте', () => {
    const applied = apply(d, {}, d.model(objectRow, {}), {});
    expect(applied.key).toBe('АЛ13');
    expect(applied.title).toBe('ЖК ALIA, БЛОКИ 13А, 13В');
  });

  it('пустая ячейка заведённое наименование и адрес не стирает', () => {
    const applied = apply(d, {}, d.model(objectRow, {}), {
      Наименование: '   ',
      Адрес: '',
      Активен: 'нет',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells['Наименование']).toBe('ЖК ALIA, БЛОКИ 13А, 13В');
    expect(applied.cells['Адрес']).toBe('ЛЁТНАЯ УЛ., ЖК «ÁLIA», БЛОКИ 13А, 13В');
    // Погасить объект файлом можно: это правка поля, а не удаление строки.
    expect(applied.cells['Активен']).toBe('нет');
  });

  it('«да» и «нет» принимаются в любом привычном написании, мусор — нет', () => {
    expect(apply(d, {}, d.model(objectRow, {}), { Активен: '+' }).cells['Активен']).toBe('да');
    expect(apply(d, {}, d.model(objectRow, {}), { Активен: 'ЛОЖЬ' }).cells['Активен']).toBe('нет');
    const applied = apply(d, {}, d.model(objectRow, {}), { Активен: 'наверное' });
    expect(applied.problems).toEqual(['Активен — ожидается «да» или «нет», получено «наверное»']);
    // Негодная ячейка поле не трогает: строка отвергнута целиком, а не применена наполовину.
    expect(applied.cells['Активен']).toBe('да');
  });

  it('дописанная строка без кода и наименования не заводится', () => {
    const applied = apply(d, {}, d.blank(), { Адрес: 'Мытищи, 10' });
    expect(applied.problems).toEqual([
      'строка без кода не заводится: по нему она и ищется в справочнике',
      'строка без наименования не заводится',
    ]);
    // Ключ не собрался — движку повторять эту ошибку незачем.
    expect(applied.key).toBe('');
  });
});

describe('отделы', () => {
  const d = def('departments');

  it('выгруженная строка загружается обратно без единой правки', () => {
    roundTrip(d, departmentEnv, departmentRow);
  });

  it('набор выгружается кодами объектов через «;», а не идентификаторами', () => {
    const cells = cellsOf(d, departmentEnv, d.model(departmentRow, departmentEnv));
    expect(cells[OBJECTS_HEADER]).toBe('АЛ13; СЕВ');
    // Колонка-проекция у этого отдела пуста (набор из двух), а ячейка полна: модель собрана из
    // набора, а не из `construction_object_id`.
    expect(departmentRow.constructionObjectId).toBeNull();
    expect(Object.values(cells)).not.toContain('obj-1');
  });

  it('прежний заголовок остался псевдонимом: файл, выгруженный до набора, читается', () => {
    const aliases = new Map(d.columns(departmentEnv).map((c) => [c.header, c.aliases ?? []]));
    expect(aliases.get(OBJECTS_HEADER)).toEqual(['Площадка (код объекта)']);

    // Старый файл несёт один код, и он читается как набор из одного: у отдела с двумя площадками
    // останется названная. Молчаливой потерей это не станет — правку показывает предпросмотр.
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      'Площадка (код объекта)': 'СЕВ',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells[OBJECTS_HEADER]).toBe('СЕВ');
  });

  it('неизвестный код площадки — ошибка со ссылкой на справочник объектов', () => {
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      [OBJECTS_HEADER]: 'АЛ13; obj7',
    });
    expect(applied.problems).toEqual([
      'площадка «obj7» не найдена — сначала загрузите справочник объектов',
    ]);
  });

  it('пустая ячейка заведённый набор не снимает', () => {
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      [OBJECTS_HEADER]: '',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells[OBJECTS_HEADER]).toBe('АЛ13; СЕВ');
  });

  it('отдел без площадок — рабочее состояние, а не ошибка строки', () => {
    const office = { ...departmentRow, id: 'dep-2', code: 'АХО' };
    roundTrip(d, departmentEnv, office);
    const applied = apply(d, departmentEnv, d.model(office, departmentEnv), {});
    expect(applied.problems).toEqual([]);
    expect(applied.cells[OBJECTS_HEADER]).toBe('');
  });

  it('перестановка и повтор кодов в ячейке изменением не считаются', () => {
    const before = d.model(departmentRow, departmentEnv);
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      [OBJECTS_HEADER]: ' СЕВ ;АЛ13; АЛ13 ',
    });
    expect(applied.problems).toEqual([]);
    // Сравнение движка идёт по тексту ячейки: совпал — правки в отчёте нет, сессии отдела живы, а
    // в журнал доступа не уходит события с пустой разницей.
    expect(applied.cells[OBJECTS_HEADER]).toBe(cellsOf(d, departmentEnv, before)[OBJECTS_HEADER]);
  });

  it('запятая внутри кода объекта разделителем не считается', () => {
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      [OBJECTS_HEADER]: 'МЫТ, К2',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells[OBJECTS_HEADER]).toBe('МЫТ, К2');
  });

  it('порог в 50 площадок называет строку файла, а не падает служебным отказом', () => {
    const codes = Array.from({ length: 51 }, (_, i) => `К${i + 1}`);
    const applied = apply(d, departmentEnv, d.model(departmentRow, departmentEnv), {
      [OBJECTS_HEADER]: codes.join('; '),
    });
    // Ровно одна жалоба: о длине. Полсотни «площадка не найдена» рядом с ней скрыли бы причину.
    expect(applied.problems).toEqual(['площадок у отдела не больше 50, а в строке их 51']);
  });

  it('код объекта с «;» внутри останавливает выгрузку внятным текстом', () => {
    const broken = { ...departmentRow, id: 'dep-3', code: 'ГАР', name: 'Гарантийный отдел' };
    // Экранирования нет намеренно: файл, собранный по одному правилу и прочитанный по другому,
    // потерял бы половину кода молча. Отказ приходит до того, как соберётся книга.
    expect(() => cellsOf(d, departmentEnv, d.model(broken, departmentEnv))).toThrow(
      /точку с запятой/u,
    );
  });
});

describe('контрагенты', () => {
  const d = def('counterparties');

  it('выгруженная строка загружается обратно без единой правки', () => {
    roundTrip(d, counterpartyEnv, counterpartyRow);
  });

  it('ключ строки — ИНН; тип и синонимы выгружаются словами, а не кодами', () => {
    const model = d.model(counterpartyRow, counterpartyEnv);
    const cells = cellsOf(d, counterpartyEnv, model);
    expect(d.keyOf(model)).toBe(SUPPLIER_INN);
    expect(cells['Тип']).toBe('Поставщик');
    expect(cells['Синонимы']).toBe('РОМАШКА; Ромашка ООО');
  });

  it('ИНН с опечаткой в одной цифре не проходит контрольную сумму', () => {
    const applied = apply(d, counterpartyEnv, d.blank(), {
      Тип: 'Поставщик',
      Наименование: 'ООО «Василёк»',
      ИНН: '7707083894',
    });
    // Второе сообщение — не повтор, а следствие: негодный номер в модель не попал, и строка
    // осталась без ключа, по которому её ищут в справочнике.
    expect(applied.problems).toEqual([
      'ИНН — ИНН не проходит проверку контрольной суммы: «7707083894»',
      'строка без ИНН не заводится: им контрагент и опознаётся',
    ]);
    expect(applied.key).toBe('');
  });

  it('ИНН не той длины отвергается до контрольной суммы', () => {
    const applied = apply(d, counterpartyEnv, d.blank(), { ИНН: '77070838' });
    expect(applied.problems[0]).toBe(
      'ИНН — ИНН — 10 цифр (организация) или 12 (ИП, физлицо); получено «77070838»',
    );
  });

  it('ИНН предпринимателя из двенадцати цифр принимается', () => {
    const applied = apply(d, counterpartyEnv, d.blank(), {
      Тип: 'Подрядчик',
      Наименование: 'ИП Петров П. П.',
      ИНН: ' 5001 0073 2259 ',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.key).toBe(ENTREPRENEUR_INN);
  });

  it('тип пишется словом; незнакомое слово — ошибка со списком допустимых', () => {
    const applied = apply(d, counterpartyEnv, d.blank(), { Тип: 'заказчик' });
    expect(applied.problems[0]).toContain('Тип — допустимые значения:');
    expect(applied.problems[0]).toContain('Поставщик');
    expect(applied.problems[0]).toContain('получено «заказчик»');
  });

  it('дописанная строка без типа не заводится: роль контрагента не угадывают', () => {
    const applied = apply(d, counterpartyEnv, d.blank(), {
      Наименование: 'ООО «Василёк»',
      ИНН: SUPPLIER_INN,
    });
    expect(applied.problems).toContain(
      'строка без типа не заводится: неизвестно, оператор это, поставщик или арендодатель',
    );
  });

  it('тип заведённой записи файлом не меняется', () => {
    const applied = apply(d, counterpartyEnv, d.model(counterpartyRow, counterpartyEnv), {
      Тип: 'Подрядчик',
    });
    expect(applied.problems).toEqual([
      'тип контрагента «ООО «Ромашка»» файлом не меняется: от него зависят права учётных записей, склады и прайс — смените его в карточке контрагента',
    ]);
  });

  it('активность арендодателя файлом не переключается: с ним гаснет его аренда', () => {
    const lessorRow = {
      ...counterpartyRow,
      id: 'cp-2',
      type: 'vehicle_lessor',
      name: 'ООО «Аренда-Строй»',
      inn: LESSOR_INN,
    };
    const applied = apply(d, counterpartyEnv, d.model(lessorRow, counterpartyEnv), {
      Активен: 'нет',
    });
    expect(applied.problems).toEqual([
      'активность арендодателя «ООО «Аренда-Строй»» файлом не переключается: вместе с ним гаснут и поднимаются его предложения аренды — это делают в карточке контрагента',
    ]);
    // У остальных типов та же правка — обычная деактивация.
    expect(
      apply(d, counterpartyEnv, d.model(counterpartyRow, counterpartyEnv), { Активен: 'нет' })
        .problems,
    ).toEqual([]);
  });

  it('набор синонимов приводится к тому, что в ячейке, а пустая ячейка его не трогает', () => {
    const replaced = apply(d, counterpartyEnv, d.model(counterpartyRow, counterpartyEnv), {
      Синонимы: 'Ромашка ООО; ромашка мск',
    });
    expect(replaced.cells['Синонимы']).toBe('Ромашка ООО; ромашка мск');
    const untouched = apply(d, counterpartyEnv, d.model(counterpartyRow, counterpartyEnv), {
      Синонимы: '   ',
    });
    expect(untouched.cells['Синонимы']).toBe('РОМАШКА; Ромашка ООО');
  });

  it('пустая ячейка комментария его стирает — этим пометка и отличается от данных', () => {
    const applied = apply(d, counterpartyEnv, d.model(counterpartyRow, counterpartyEnv), {
      Комментарий: '',
      Наименование: '',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells['Комментарий']).toBe('');
    expect(applied.cells['Наименование']).toBe('ООО «Ромашка»');
  });
});

describe('склады поставщиков', () => {
  const d = def('warehouses');

  it('выгруженная строка загружается обратно без единой правки', () => {
    roundTrip(d, warehouseEnv, warehouseRow);
  });

  it('ключ строки — ИНН поставщика и адрес; регистр и лишние пробелы адреса его не меняют', () => {
    const model = d.model(warehouseRow, warehouseEnv);
    expect(d.keyOf(model)).toBe(`${SUPPLIER_INN} г. мытищи, олимпийский пр-т, 10`);
    const spaced = apply(d, warehouseEnv, d.blank(), {
      'Поставщик (ИНН)': SUPPLIER_INN,
      Адрес: 'Г. Мытищи,  Олимпийский   пр-т, 10',
    });
    expect(spaced.key).toBe(d.keyOf(model));
    expect(d.titleOf(model)).toBe('г. Мытищи, Олимпийский пр-т, 10 (Основной)');
  });

  it('поставщик указывается ИНН, и неизвестный ИНН отправляет за справочником контрагентов', () => {
    const applied = apply(d, warehouseEnv, d.blank(), {
      'Поставщик (ИНН)': ENTREPRENEUR_INN,
      Адрес: 'г. Мытищи, Олимпийский пр-т, 12',
    });
    expect(applied.problems).toEqual([
      `поставщик с ИНН «${ENTREPRENEUR_INN}» не найден — сначала загрузите справочник контрагентов`,
    ]);
  });

  it('контрагент не того типа поставщиком не становится', () => {
    const applied = apply(d, warehouseEnv, d.blank(), {
      'Поставщик (ИНН)': LESSOR_INN,
      Адрес: 'г. Мытищи, Олимпийский пр-т, 12',
    });
    expect(applied.problems).toEqual([
      `контрагент «ООО «Аренда-Строй»» (ИНН ${LESSOR_INN}) заведён как «Арендодатель (ТС)» — склад заводится только у контрагента типа «Поставщик»`,
    ]);
  });

  it('строка без поставщика и без адреса не заводится', () => {
    const applied = apply(d, warehouseEnv, d.blank(), { Название: 'Основной' });
    expect(applied.problems).toEqual([
      'строка без адреса не заводится: адресом склад и опознаётся',
      'строка без поставщика не заводится: склад существует только у поставщика',
    ]);
    expect(applied.key).toBe('');
  });

  it('телефон принимается любым написанием и выгружается одним', () => {
    const applied = apply(d, warehouseEnv, d.model(warehouseRow, warehouseEnv), {
      Телефон: '8 (926) 765-43-21',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells['Телефон']).toBe('+7 (926) 765 43 21');
    const junk = apply(d, warehouseEnv, d.model(warehouseRow, warehouseEnv), { Телефон: '-' });
    expect(junk.problems).toEqual(['Телефон — Телефон в формате +7 (900) 000 00 00; получено «-»']);
    expect(junk.cells['Телефон']).toBe('+7 (926) 123 45 67');
  });

  it('метка стирается пустой ячейкой, а контактное лицо — нет', () => {
    const applied = apply(d, warehouseEnv, d.model(warehouseRow, warehouseEnv), {
      Название: '',
      Комментарий: '',
      'Контактное лицо': '',
    });
    expect(applied.problems).toEqual([]);
    expect(applied.cells['Название']).toBe('');
    expect(applied.cells['Комментарий']).toBe('');
    expect(applied.cells['Контактное лицо']).toBe('Иванов И. И.');
  });
});

describe('организации-владельцы транспорта', () => {
  const d = def('organizations');

  it('выгруженная строка загружается обратно без единой правки', () => {
    roundTrip(d, {}, organizationRow);
  });

  it('ключ строки — ИНН, а у организации без ИНН — наименование', () => {
    expect(d.keyOf(d.model(organizationRow, {}))).toBe(`инн ${LESSOR_INN}`);
    const noInn = { ...organizationRow, id: 'org-2', inn: '', isPrimary: false };
    expect(d.keyOf(d.model(noInn, {}))).toBe('наименование ао «служба механизации»');
    expect(d.keyOf(d.blank())).toBe('');
  });

  it('телефон шапки бланка остаётся тем, что дала бухгалтерия', () => {
    const cells = cellsOf(d, {}, d.model(organizationRow, {}));
    // Единственный телефон портала, который не сводится к десяти цифрам: в реквизите их два.
    expect(cells['Телефон']).toBe('(495) 123-45-67, +7 985 000 00 00');
  });

  it('ОКПО и ОГРН проверяются по длине — тем же правилом, что и ограничение таблицы', () => {
    const okpo = apply(d, {}, d.model(organizationRow, {}), { ОКПО: '1234567' });
    expect(okpo.problems).toEqual(['ОКПО — ожидается 8 или 10 цифр, получено «1234567»']);
    expect(okpo.cells['ОКПО']).toBe('12345678');
    const ogrn = apply(d, {}, d.model(organizationRow, {}), { ОГРН: '12345678901234' });
    expect(ogrn.problems).toEqual(['ОГРН — ожидается 13 или 15 цифр, получено «12345678901234»']);
    const ip = apply(d, {}, d.model(organizationRow, {}), { ОГРН: '123456789012345' });
    expect(ip.problems).toEqual([]);
    expect(ip.cells['ОГРН']).toBe('123456789012345');
  });

  it('ИНН организации необязателен, но набранный проверяется контрольной суммой', () => {
    const applied = apply(d, {}, d.blank(), { Наименование: 'ООО «Перевозчик»' });
    expect(applied.problems).toEqual([]);
    const wrong = apply(d, {}, d.blank(), {
      Наименование: 'ООО «Перевозчик»',
      ИНН: '7736050004',
    });
    expect(wrong.problems).toEqual([
      'ИНН — ИНН не проходит проверку контрольной суммы: «7736050004»',
    ]);
  });

  it('признак «Основная» загрузка не читает: колонка справочная', () => {
    const column = d.columns({}).find((c) => c.header === 'Основная');
    expect(column?.set).toBeUndefined();
    const applied = apply(d, {}, d.model({ ...organizationRow, isPrimary: false }, {}), {
      Основная: 'да',
    });
    expect(applied.cells['Основная']).toBe('нет');
    expect(applied.problems).toEqual([]);
  });

  it('строка без наименования не заводится: им организация и подписывает лист', () => {
    const applied = apply(d, {}, d.blank(), { ИНН: LESSOR_INN });
    expect(applied.problems).toEqual([
      'строка без наименования не заводится: им организация и подписывает путевой лист',
    ]);
  });
});
