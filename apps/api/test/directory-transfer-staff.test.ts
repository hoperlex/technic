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
 * нет, не вызываются вовсе, а проверки строки идут последними.
 */
function applyCells(
  def: AnyDirectory,
  env: unknown,
  model: unknown,
  cells: Readonly<Record<string, string>>,
  ctx: RowContext,
): void {
  for (const column of def.columns(env)) {
    const text = cells[column.header];
    if (text === undefined || !column.set) continue;
    column.set(model, text, ctx);
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

  /** Категории водительского удостоверения по миграции 0058 — кодами, как их знает справочник. */
  const env = {
    specializationId: 'sp-1',
    licenseTypeId: 'ct-1',
    categoryIdByCode: new Map(
      ['a', 'a1', 'b', 'b1', 'c', 'c1', 'd', 'd1', 'be', 'ce', 'c1e', 'de', 'd1e', 'm'].map((c) => [
        c,
        `qc-${c}`,
      ]),
    ),
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
    license: {
      id: 'cr-1',
      series: '99 39',
      number: '482645',
      issuedOn: '2024-11-29',
      expiresOn: '2027-07-12',
      issuedBy: 'ГИБДД 7711',
      categories: ['b', 'c', 'ce'],
    },
  };

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
      Выдано: '29.11.2024',
    });
  });

  it('водитель без удостоверения выгружается и загружается так же', () => {
    const { before, after, problems } = roundTrip(def, env, { ...row, license: null });
    expect(problems).toEqual([]);
    expect(after).toEqual(before);
    expect(before['Категории ВУ']).toBe('');
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
        Выдано: '',
        'Действительно до': '',
        'Кем выдано': '',
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
      Выдано: '29.11.2024',
      'Действительно до': '12.07.2027',
      'Кем выдано': 'ГИБДД 7711',
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

  it('у не водительской должности категории в ВУ не заводятся, и об этом сказано (ADR 0049)', () => {
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
    expect(warnings[0]).toMatch(/не водительская/u);
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
        Выдано: '29.11.2024',
        'Действительно до': '12.07.2019',
      }),
      ctx,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/раньше даты выдачи/u);
  });

  it('первая строка справки предупреждает о персональных данных', () => {
    expect(def.help(env)[0]).toMatch(/персональные данные/u);
  });
});
