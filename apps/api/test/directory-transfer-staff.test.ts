import { describe, expect, it, vi } from 'vitest';
import type { DirectoryKey } from '@technic/contracts';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Описания кадровых справочников обмена (ADR 0073): специализации, виды документов, категории
 * квалификаций и водители.
 *
 * Проверяется здесь то же, что и в разборе кадровой выгрузки (`driver-import.test.ts`), и по той
 * же причине: этим кодом в справочник попадают ФИО, СНИЛС и допуски живых людей, а запускают его
 * файлом — сразу на сотню строк. Ошибку такого разбора некому заметить по нарастающим жалобам: она
 * становится записью, которую потом сверяют глазами по бумаге.
 *
 * База не нужна: описание справочника — это набор правил «строка файла ↔ строка портала», и
 * проверяются именно они. Строки базы и окружение собираются здесь фикстурами.
 */

// Описания лежат рядом с клиентом БД, а тот при импорте читает конфиг: без переменных окружения
// модуль не загрузится вовсе. Приём `directory-purge.test.ts` — значения ставятся до импорта.
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

const { staffDirectories } = await import('../src/services/directory-transfer/defs/staff');

const byKey = new Map<DirectoryKey, AnyDirectory>(staffDirectories.map((d) => [d.key, d]));

function directoryOf(key: DirectoryKey): AnyDirectory {
  const found = byKey.get(key);
  if (!found) throw new Error(`Описание справочника «${key}» не собрано`);
  return found;
}

/** Копилка замечаний одной строки — тот же интерфейс, что даёт строке файла движок. */
function rowContext(): { ctx: RowContext; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  return {
    ctx: {
      row: 2,
      fail: (message) => problems.push(message),
      warn: (message) => warnings.push(message),
    },
    problems,
    warnings,
  };
}

/** Строка файла: что выгрузка написала бы по этой модели. */
function cellsOf(def: AnyDirectory, env: unknown, model: unknown): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const column of def.columns(env)) cells[column.header] = column.get(model);
  return cells;
}

/**
 * Разбор строки файла поверх модели — ровно так, как это делает движок: колонки, которых в файле
 * нет, не вызываются вовсе, колонка отзывается и на прежние свои имена (`aliases`), а проверки
 * строки идут последними. Последнее существенно: у водителей `check()` не только проверяет, но и
 * раскладывает категории по документам — решение зависит от всей строки сразу.
 */
function applyCells(
  def: AnyDirectory,
  env: unknown,
  model: unknown,
  cells: Readonly<Record<string, string>>,
  ctx: RowContext,
): void {
  for (const column of def.columns(env)) {
    const named = [column.header, ...(column.aliases ?? [])].find((h) => cells[h] !== undefined);
    if (named === undefined || !column.set) continue;
    column.set(model, cells[named]!, ctx);
  }
  def.check?.(model, ctx, env);
}

/** Выгрузили строку и загрузили обратно: файл, который портал только что отдал, он же и примет. */
function roundTrip(
  def: AnyDirectory,
  env: unknown,
  row: unknown,
): { before: Record<string, string>; after: Record<string, string>; problems: string[] } {
  const before = cellsOf(def, env, def.model(row, env));
  const model = def.blank();
  const { ctx, problems } = rowContext();
  applyCells(def, env, model, before, ctx);
  return { before, after: cellsOf(def, env, model), problems };
}

describe('состав кадровых справочников', () => {
  it('описаны все четыре: без описания справочник не попадёт ни в список, ни в выгрузку', () => {
    expect([...byKey.keys()]).toEqual([
      'specializations',
      'credential-types',
      'qualification-categories',
      'drivers',
    ]);
  });
});

describe('специализации', () => {
  const def = directoryOf('specializations');
  const row = {
    id: 'sp-1',
    code: 'driver',
    name: 'Водитель',
    description: 'Управление транспортным средством',
    sortOrder: 10,
    isActive: true,
  };

  it('выгрузка и загрузка сходятся: повторная загрузка того же файла ничего не меняет', () => {
    const { before, after, problems } = roundTrip(def, {}, row);
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before).toMatchObject({ Код: 'driver', Наименование: 'Водитель', Активна: 'да' });
  });

  it('ключ строки — код; регистр в файле кода не меняет', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, {}, model, { Код: 'DRIVER', Наименование: 'Водитель' }, ctx);
    expect(problems).toEqual([]);
    expect(def.keyOf(model)).toBe('driver');
  });

  it('код не латиницей отвергается: иначе человек прочитал бы про нарушенный constraint', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, {}, model, { Код: 'водитель', Наименование: 'Водитель' }, ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Код/u);
  });

  it('пустое описание стирает заведённое, а пустое наименование — не трогает', () => {
    const model = def.model(row, {});
    const { ctx, problems } = rowContext();
    applyCells(def, {}, model, { Описание: '', Наименование: '' }, ctx);
    expect(problems).toEqual([]);
    expect(cellsOf(def, {}, model)).toMatchObject({ Описание: '', Наименование: 'Водитель' });
  });
});

describe('виды документов', () => {
  const def = directoryOf('credential-types');
  const row = {
    id: 'ct-1',
    code: 'driver_license',
    name: 'Водительское удостоверение',
    description: '',
    hasCategories: true,
    expiryRequired: true,
    sortOrder: 10,
    isActive: true,
  };

  it('выгрузка и загрузка сходятся, включая оба признака документа', () => {
    const { before, after, problems } = roundTrip(
      def,
      {},
      {
        ...row,
        code: 'medical',
        name: 'Медицинское заключение',
        hasCategories: false,
        expiryRequired: false,
      },
    );
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before).toMatchObject({ 'С категориями': 'нет', 'Срок обязателен': 'нет' });
  });

  it('признак читается словом человека, а не только «да»', () => {
    const model = def.model(row, {});
    const { ctx, problems } = rowContext();
    applyCells(def, {}, model, { 'С категориями': 'нет', 'Срок обязателен': '0' }, ctx);
    expect(problems).toEqual([]);
    expect(cellsOf(def, {}, model)).toMatchObject({
      'С категориями': 'нет',
      'Срок обязателен': 'нет',
    });
  });
});

describe('категории квалификаций', () => {
  const def = directoryOf('qualification-categories');
  const env = {
    typeIdByCode: new Map([
      ['driver_license', 'ct-1'],
      ['tractor_license', 'ct-2'],
    ]),
  };
  const row = {
    id: 'qc-1',
    credentialTypeCode: 'driver_license',
    code: 'ce',
    name: 'CE',
    description: 'Автопоезд категории C',
    sortOrder: 60,
    isActive: true,
  };

  it('выгрузка и загрузка сходятся', () => {
    const { before, after, problems } = roundTrip(def, env, row);
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before).toMatchObject({ 'Вид документа (код)': 'driver_license', Код: 'ce' });
  });

  it('одинаковый код в разных видах документов — разные записи: ключ различает их', () => {
    const driver = def.model(row, env);
    const tractor = def.model({ ...row, id: 'qc-2', credentialTypeCode: 'tractor_license' }, env);
    expect(def.keyOf(driver)).not.toBe(def.keyOf(tractor));
    expect(def.keyOf(driver)).toBe('driver_license/ce');
  });

  it('незнакомый вид документа — ошибка строки, а не заведение вида «на лету»', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(
      def,
      env,
      model,
      { 'Вид документа (код)': 'crane_license', Код: 'c', Наименование: 'C' },
      ctx,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/вид документа «crane_license» не найден/u);
  });

  it('без вида документа ключ не собирается: одним кодом строку не найти', () => {
    const model = def.blank();
    const { ctx } = rowContext();
    applyCells(def, env, model, { Код: 'ce', Наименование: 'CE' }, ctx);
    expect(def.keyOf(model)).toBe('');
  });
});

describe('водители', () => {
  const def = directoryOf('drivers');

  /**
   * Категории по видам документов — кодами, как их знает справочник: водительские завела миграция
   * 0058, тракторные 0123. Словари врозь не для красоты: код уникален внутри вида, и «C» в них
   * означает разные машины (ADR 0008).
   */
  const env = {
    specializationId: 'sp-1',
    typeIds: { driver_license: 'ct-1', tractor_license: 'ct-2' },
    categoryIds: {
      driver_license: new Map(
        ['a', 'a1', 'b', 'b1', 'c', 'c1', 'd', 'd1', 'be', 'ce', 'c1e', 'de', 'd1e', 'm'].map(
          (c) => [c, `qc-${c}`],
        ),
      ),
      tractor_license: new Map(
        ['a1', 'a2', 'a3', 'a4', 'b', 'c', 'd', 'e', 'f'].map((c) => [c, `tc-${c}`]),
      ),
    },
  };

  /** Настоящий СНИЛС с верной контрольной суммой — из тестового набора кадровой выгрузки. */
  const SNILS = '11111111145';

  const row = {
    personId: 'p-1',
    fullName: 'Иванов Иван Иванович',
    snils: SNILS,
    birthDate: '1968-07-27',
    phone: '9001234567',
    email: 'ivanov@example.com',
    comment: 'Работает по сменам',
    employmentId: 'e-1',
    personnelNo: '0042',
    jobTitle: 'Водитель',
    department: 'СУ-10',
    employedSince: '2020-03-01',
    documents: {
      driver_license: {
        id: 'cr-1',
        series: '99 39',
        number: '482645',
        issuedOn: '2024-11-29',
        expiresOn: '2027-07-12',
        issuedBy: 'ГИБДД 7711',
        categories: ['b', 'c', 'ce'],
      },
    },
  };

  /**
   * Круг «выгрузили — загрузили» поверх заведённой строки. Именно так его делает движок: строку он
   * находит по идентификатору из файла и кладёт ячейки на её модель, а не на пустую. Для водителей
   * разница предметная — заведённый документ сам говорит, чьи категории стоят в колонке.
   */
  function roundTripOnExisting(source: unknown): {
    before: Record<string, string>;
    after: Record<string, string>;
    problems: string[];
    warnings: string[];
  } {
    const before = cellsOf(def, env, def.model(source, env));
    const model = def.model(source, env);
    const { ctx, problems, warnings } = rowContext();
    applyCells(def, env, model, before, ctx);
    return { before, after: cellsOf(def, env, model), problems, warnings };
  }

  /** Строка файла на нового человека: минимум, которым водитель заводится. */
  function newDriverCells(over: Record<string, string> = {}): Record<string, string> {
    return { ФИО: 'Петров Пётр Петрович', СНИЛС: SNILS, ...over };
  }

  it('выгрузка и загрузка сходятся: даты, телефон, СНИЛС и категории возвращаются как были', () => {
    const { before, after, problems } = roundTrip(def, env, row);
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before).toMatchObject({
      СНИЛС: '111-111-111 45',
      'Дата рождения': '27.07.1968',
      Телефон: '+7 (900) 123 45 67',
      'Категории ВУ': 'B; C; CE',
      'Выдано ВУ': '29.11.2024',
      // Колонки второго документа у водителя пусты, но в файле они есть: справочник для того и
      // открывают, чтобы увидеть, у кого чего нет.
      'Категории УТМ': '',
      'Выдано УТМ': '',
    });
  });

  it('водитель без удостоверения выгружается и загружается так же', () => {
    const { before, after, problems } = roundTrip(def, env, { ...row, documents: {} });
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before['Категории ВУ']).toBe('');
  });

  it('оба документа выгружаются и загружаются, не путаясь буквами категорий', () => {
    const { before, after, problems } = roundTripOnExisting({
      ...row,
      jobTitle: 'Машинист экскаватора',
      documents: {
        ...row.documents,
        tractor_license: {
          id: 'cr-2',
          series: '',
          number: '112233',
          issuedOn: '2023-04-05',
          expiresOn: '2033-04-05',
          issuedBy: 'Гостехнадзор',
          categories: ['c', 'd'],
        },
      },
    });
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before).toMatchObject({
      'Категории ВУ': 'B; C; CE',
      'Категории УТМ': 'C; D',
      'Номер УТМ': '112233',
      'Выдано УТМ': '05.04.2023',
    });
  });

  it('порядок колонок: человек, кадровые поля, блок ВУ, блок УТМ', () => {
    const headers = def.columns(env).map((c) => c.header);
    expect(headers.slice(headers.indexOf('Дата приёма'))).toEqual([
      'Дата приёма',
      'Категории ВУ',
      'Серия ВУ',
      'Номер ВУ',
      'Выдано ВУ',
      'Действительно до ВУ',
      'Кем выдано ВУ',
      'Категории УТМ',
      'Серия УТМ',
      'Номер УТМ',
      'Выдано УТМ',
      'Действительно до УТМ',
      'Кем выдано УТМ',
      'Комментарий',
    ]);
  });

  it('прежние заголовки блока ВУ остались псевдонимами: файл до разделения колонок грузится', () => {
    const aliases = new Map(def.columns(env).map((c) => [c.header, c.aliases ?? []]));
    expect(aliases.get('Выдано ВУ')).toEqual(['Выдано']);
    expect(aliases.get('Действительно до ВУ')).toEqual(['Действительно до']);
    expect(aliases.get('Кем выдано ВУ')).toEqual(['Кем выдано']);
    // У тракторного блока прежних имён нет: до ADR 0095 таких колонок не существовало.
    expect(aliases.get('Выдано УТМ')).toEqual([]);
  });

  it('файл с прежним заголовком «Выдано» правит водительское удостоверение', () => {
    const model = def.model(row, env);
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, { Выдано: '01.02.2025', 'Кем выдано': 'ГИБДД 5005' }, ctx);
    expect(problems).toEqual([]);
    expect(cellsOf(def, env, model)).toMatchObject({
      'Выдано ВУ': '01.02.2025',
      'Кем выдано ВУ': 'ГИБДД 5005',
      // Тракторного документа прежний файл не касается вовсе.
      'Выдано УТМ': '',
    });
  });

  it('СНИЛС с неверной контрольной суммой отвергается: опечатка в цифре — другой человек', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, newDriverCells({ СНИЛС: '11111111144' }), ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/контрольной суммы/u);
  });

  it('форматированный и «сырой» СНИЛС — один и тот же ключ строки', () => {
    const formatted = def.blank();
    const raw = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, formatted, newDriverCells({ СНИЛС: '111-111-111 45' }), ctx);
    applyCells(def, env, raw, newDriverCells({ СНИЛС: SNILS }), ctx);
    expect(problems).toEqual([]);
    expect(def.keyOf(formatted)).toBe(SNILS);
    expect(def.keyOf(raw)).toBe(SNILS);
  });

  it('без СНИЛС строка негодна: он ключ человека', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, { ФИО: 'Петров Пётр Петрович' }, ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/СНИЛС/u);
    expect(def.keyOf(model)).toBe('');
  });

  it('ФИО без отчества принимается, а из одного слова — отвергается', () => {
    const withoutMiddle = def.blank();
    const single = def.blank();
    const two = rowContext();
    const one = rowContext();
    applyCells(def, env, withoutMiddle, newDriverCells({ ФИО: 'Петров Пётр' }), two.ctx);
    applyCells(def, env, single, newDriverCells({ ФИО: 'Петров' }), one.ctx);
    expect(two.problems).toEqual([]);
    expect(cellsOf(def, env, withoutMiddle)['ФИО']).toBe('Петров Пётр');
    expect(one.problems).toHaveLength(1);
    expect(one.problems[0]).toMatch(/Фамилия Имя Отчество/u);
  });

  it('«31.02.2026» отвергается: формату дата соответствует, а календарю нет', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, newDriverCells({ 'Дата рождения': '31.02.2026' }), ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/календаре/u);
  });

  it('неизвестный код категории — ошибка строки, а не тихое заведение категории', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, newDriverCells({ 'Категории ВУ': 'B; X9' }), ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/«X9»/u);
  });

  it('меньший набор категорий не снимает заведённые, а даёт предупреждение', () => {
    const model = def.model(row, env);
    const { ctx, problems, warnings } = rowContext();
    applyCells(def, env, model, { 'Категории ВУ': 'B' }, ctx);
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/допуск не снимают/u);
    // Допуск к машине снимают документом, а не строкой таблицы: заведённое осталось на месте.
    expect(cellsOf(def, env, model)['Категории ВУ']).toBe('B; C; CE');
  });

  it('новая категория добавляется к заведённым', () => {
    const model = def.model(row, env);
    const { ctx, problems, warnings } = rowContext();
    applyCells(def, env, model, { 'Категории ВУ': 'B; C; CE; C1E' }, ctx);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(cellsOf(def, env, model)['Категории ВУ']).toBe('B; C; CE; C1E');
  });

  it('пустая ячейка не стирает заведённое: ни адрес, ни реквизиты удостоверения', () => {
    const model = def.model(row, env);
    const { ctx, problems } = rowContext();
    applyCells(
      def,
      env,
      model,
      {
        Email: '',
        'Серия ВУ': '',
        'Номер ВУ': '',
        'Выдано ВУ': '',
        'Действительно до ВУ': '',
        'Кем выдано ВУ': '',
        'Категории ВУ': '',
        Телефон: '',
      },
      ctx,
    );
    expect(problems).toEqual([]);
    expect(cellsOf(def, env, model)).toMatchObject({
      Email: 'ivanov@example.com',
      'Серия ВУ': '99 39',
      'Номер ВУ': '482645',
      'Выдано ВУ': '29.11.2024',
      'Действительно до ВУ': '12.07.2027',
      'Кем выдано ВУ': 'ГИБДД 7711',
      'Категории ВУ': 'B; C; CE',
      Телефон: '+7 (900) 123 45 67',
    });
  });

  it('комментарий пустой ячейкой стирается: он единственная такая колонка у водителя', () => {
    const model = def.model(row, env);
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, { Комментарий: '' }, ctx);
    expect(problems).toEqual([]);
    expect(cellsOf(def, env, model)['Комментарий']).toBe('');
  });

  it('негодный адрес отвергается, а не заводится молча', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(def, env, model, newDriverCells({ Email: 'нет' }), ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Email/u);
  });

  it('у незнакомой должности категории в ВУ не заводятся, и об этом сказано (ADR 0049)', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({ Должность: 'Машинист крана', 'Категории ВУ': 'B; C' }),
      ctx,
    );
    // Строка не отбрасывается: человек заводится, а категории ждут своего вида документа.
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/должность «Машинист крана» порталу незнакома/u);
    expect(cellsOf(def, env, model)).toMatchObject({ 'Категории ВУ': '', 'Категории УТМ': '' });
  });

  it('категории машиниста экскаватора заводятся в тракторное удостоверение, а не в ВУ (ADR 0095)', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(
      def,
      env,
      model,
      // Так их присылает кадровая выгрузка: колонка категорий в ней одна на всех.
      newDriverCells({ Должность: 'Машинист экскаватора', 'Категории ВУ': 'B; C' }),
      ctx,
    );
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(cellsOf(def, env, model)).toMatchObject({
      // «C» тракториста и «C» водительского — разные машины: приписать их к ВУ значило бы молча
      // выдать допуск к грузовику.
      'Категории УТМ': 'B; C',
      'Категории ВУ': '',
    });
  });

  it('категория, которой нет у тракторного удостоверения, — ошибка строки, а не запись в ВУ', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({ Должность: 'Машинист погрузчика', 'Категории ВУ': 'B; CE' }),
      ctx,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/«CE».*тракториста-машиниста/u);
  });

  it('колонка УТМ в водительское удостоверение не попадает ни при какой должности', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(def, env, model, newDriverCells({ 'Категории УТМ': 'C; F' }), ctx);
    // Должность по умолчанию водительская, но колонка названа своим документом — и он же её примет.
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(cellsOf(def, env, model)).toMatchObject({
      'Категории УТМ': 'C; F',
      'Категории ВУ': '',
    });
  });

  it('заведённое ВУ машиниста экскаватора остаётся своим: выгрузка возвращается без правок', () => {
    // Машинист с водительским, заведённым до ADR 0049: колонку «Категории ВУ» ему заполнил сам
    // портал, и загрузка того же файла не вправе перенести её в тракторное.
    const { before, after, problems } = roundTripOnExisting({
      ...row,
      jobTitle: 'Машинист экскаватора',
    });
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(after['Категории ВУ']).toBe('B; C; CE');
    expect(after['Категории УТМ']).toBe('');
  });

  it('у машиниста с настоящим ВУ удостоверение заводится: набор бывает только у водительского', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({ Должность: 'Машинист крана', 'Категории ВУ': 'C; CE' }),
      ctx,
    );
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('срок действия раньше даты выдачи — ошибка строки', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({
        'Категории ВУ': 'B',
        'Номер ВУ': '482645',
        'Выдано ВУ': '29.11.2024',
        'Действительно до ВУ': '12.07.2019',
      }),
      ctx,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/раньше даты выдачи/u);
  });

  it('срок тракторного удостоверения проверяется так же, как срок ВУ', () => {
    const model = def.blank();
    const { ctx, problems } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({
        Должность: 'Машинист погрузчика',
        'Категории УТМ': 'C',
        'Выдано УТМ': '29.11.2024',
        'Действительно до УТМ': '12.07.2019',
      }),
      ctx,
    );
    expect(problems).toEqual([
      'Действительно до УТМ — срок действия УТМ не может быть раньше даты выдачи',
    ]);
  });

  it('реквизиты без категорий документ заводят, но о пустом наборе предупреждают', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(def, env, model, newDriverCells({ 'Номер ВУ': '482645' }), ctx);
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/документ заводится, но открытых категорий у него не будет/u);
  });

  // Тот самый случай, ради которого правило и менялось: УТМ машиниста заводят по документу в
  // руках, а категории самоходных машин в кадровой выгрузке не приходят вовсе.
  it('УТМ по одним реквизитам, без категорий, заводится и попадает в изменения строки', () => {
    const model = def.blank();
    const { ctx, problems, warnings } = rowContext();
    applyCells(
      def,
      env,
      model,
      newDriverCells({
        Должность: 'Машинист экскаватора',
        'Серия УТМ': '99 39',
        'Номер УТМ': '112233',
        'Выдано УТМ': '05.04.2023',
      }),
      ctx,
    );
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(cellsOf(def, env, model)).toMatchObject({
      'Номер УТМ': '112233',
      'Категории УТМ': '',
    });
  });

  it('первая строка справки предупреждает о персональных данных', () => {
    expect(def.help(env)[0]).toMatch(/персональные данные/u);
  });
});
