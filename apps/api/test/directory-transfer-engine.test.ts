import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_ID_COLUMN } from '@technic/contracts';

/**
 * Механика обмена справочником (ADR 0073) на выдуманном справочнике.
 *
 * Проверяется здесь то, что одинаково во всех восемнадцати: что считается заведением, а что
 * правкой; почему пустая ячейка ничего не стирает; когда файл не применяется вовсе. Настоящий
 * справочник для этого не нужен и даже мешает — его собственные правила заслонили бы общие,
 * а разойтись с ними движок может незаметно для всех.
 *
 * База подменена: до неё доходит только применение, и тесту важно, что именно оно позвало.
 */

const applied: string[] = [];

vi.mock('../src/db/client', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}),
  },
}));

const { exportDirectory, importDirectory, DirectoryFileError } =
  await import('../src/services/directory-transfer/engine');
const { directory } = await import('../src/services/directory-transfer/types');
const { readWorkbook, writeWorkbook } = await import('../src/lib/xlsx');
const { boolCell, parseBool, parseRequired } =
  await import('../src/services/directory-transfer/cells');

interface Row {
  id: string;
  code: string;
  name: string;
  note: string;
  isActive: boolean;
}

interface Model {
  code: string;
  name: string;
  note: string;
  isActive: boolean;
}

/** Заведённые записи выдуманного справочника: две штуки, обе живые. */
const stored: Row[] = [
  { id: 'id-1', code: 'msk', name: 'Москва', note: 'столица', isActive: true },
  { id: 'id-2', code: 'spb', name: 'Санкт-Петербург', note: '', isActive: true },
];

const def = directory<Row, Model, Record<string, never>>({
  key: 'objects',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        const v = parseRequired(text, ctx, 'Код', m.code);
        if (v !== undefined) m.code = v.toLowerCase();
      },
    },
    {
      header: 'Наименование',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseRequired(text, ctx, 'Наименование', m.name);
        if (v !== undefined) m.name = v;
      },
    },
    {
      // Примечание — колонка, где пусто законно значит «стереть»: у неё нет другого способа
      // опустеть, а у наименования есть карточка.
      header: 'Примечание',
      get: (m) => m.note,
      set: (m, text) => {
        m.note = text;
      },
    },
    {
      header: 'Активен',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => ['Выдуманный справочник для проверки механики.'],
  load: async () => stored,
  id: (row) => row.id,
  model: (row) => ({ code: row.code, name: row.name, note: row.note, isActive: row.isActive }),
  blank: () => ({ code: '', name: '', note: '', isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx) => {
    if (m.code === 'zzz') ctx.fail('код «zzz» зарезервирован');
  },
  create: async (_tx, m) => {
    applied.push(`создать ${(m as Model).code}`);
  },
  update: async (_tx, row, m) => {
    applied.push(`править ${(row as Row).code} → ${(m as Model).code}`);
  },
});

/** Книга из одного листа «Данные»: ровно то, что портал ждёт от загрузки. */
function book(rows: string[][]): Uint8Array {
  return writeWorkbook([{ name: 'Данные', rows }]);
}

const HEADER = [DIRECTORY_ID_COLUMN, 'Код', 'Наименование', 'Примечание', 'Активен'];

beforeEach(() => {
  applied.length = 0;
});

describe('выгрузка', () => {
  it('кладёт справочник на лист «Данные» и подсказку на «Справка»', async () => {
    const { bytes, rows } = await exportDirectory(def);
    const sheets = readWorkbook(bytes);
    expect(rows).toBe(2);
    expect(sheets.map((s) => s.name)).toEqual(['Данные', 'Справка']);
    expect(sheets[0]!.rows[0]).toEqual(HEADER);
    expect(sheets[0]!.rows[1]).toEqual(['id-1', 'msk', 'Москва', 'столица', 'да']);
  });

  it('выгруженный файл загружается без единой правки — иначе обмен был бы бессмысленным', async () => {
    const { bytes } = await exportDirectory(def);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.unchanged).toBe(2);
    expect(report.created).toHaveLength(0);
    expect(report.updated).toHaveLength(0);
    expect(report.problems).toEqual([]);
  });
});

describe('разбор файла', () => {
  it('новая строка заводится, а совпавшая по коду — правится', async () => {
    const bytes = book([
      HEADER,
      ['', 'ekb', 'Екатеринбург', '', 'да'],
      ['', 'msk', 'Москва', 'столица', 'нет'],
    ]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.created.map((r) => r.title)).toEqual(['Екатеринбург']);
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]!.changes).toEqual([{ column: 'Активен', from: 'да', to: 'нет' }]);
  });

  it('строка находится по идентификатору, даже если код в файле переписали', async () => {
    const bytes = book([HEADER, ['id-1', 'moscow', 'Москва', 'столица', 'да']]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.created).toHaveLength(0);
    expect(report.updated[0]!.changes).toEqual([{ column: 'Код', from: 'msk', to: 'moscow' }]);
  });

  it('идентификатор, которого в справочнике нет, — отказ, а не тихое заведение', async () => {
    const bytes = book([HEADER, ['id-404', 'msk', 'Москва', '', 'да']]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.problems.join(' ')).toMatch(/id-404/u);
  });

  it('колонки, которой нет в файле, загрузка не касается', async () => {
    // Человек оставил только код и наименование: примечание «столица» обязано уцелеть.
    const bytes = writeWorkbook([
      {
        name: 'Данные',
        rows: [
          ['Код', 'Наименование'],
          ['msk', 'Москва'],
        ],
      },
    ]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.unchanged).toBe(1);
  });

  it('пустая ячейка примечания стирает его, пустая ячейка наименования — нет', async () => {
    const bytes = book([HEADER, ['', 'msk', '', '', 'да']]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.problems).toEqual([]);
    expect(report.updated[0]!.changes).toEqual([{ column: 'Примечание', from: 'столица', to: '' }]);
  });

  it('одна и та же запись дважды в файле — отказ: какая из двух верна, неизвестно', async () => {
    const bytes = book([
      HEADER,
      ['', 'msk', 'Москва', '', 'да'],
      ['', 'msk', 'Москва-2', '', 'нет'],
    ]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.problems.join(' ')).toMatch(/строка 3.*строкой 2/u);
  });

  it('собственная проверка справочника попадает в отчёт с номером строки', async () => {
    const bytes = book([HEADER, ['', 'zzz', 'Что-то', '', 'да']]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.problems).toEqual(['строка 2: код «zzz» зарезервирован']);
  });

  it('пустые строки в середине файла пропускаются, а не считаются записями', async () => {
    const bytes = book([HEADER, ['', '', '', '', ''], ['', 'ekb', 'Екатеринбург', '', 'да']]);
    const report = await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(report.totalRows).toBe(1);
    expect(report.created).toHaveLength(1);
  });

  it('незнакомая колонка — отказ: это файл по другому шаблону', async () => {
    const bytes = book([
      [...HEADER, 'Широта'],
      ['', 'msk', 'Москва', '', 'да'],
    ]);
    await expect(importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' })).rejects.toThrow(
      DirectoryFileError,
    );
  });

  it('книга без листа «Данные» отвергается с объяснением', async () => {
    const bytes = writeWorkbook([
      { name: 'Лист1', rows: [['a']] },
      { name: 'Лист2', rows: [['b']] },
    ]);
    await expect(importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' })).rejects.toThrow(
      /Данные/u,
    );
  });

  it('не книга вовсе — отказ с человеческим текстом, а не падение', async () => {
    const bytes = new TextEncoder().encode('это просто текст');
    await expect(importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' })).rejects.toThrow(
      DirectoryFileError,
    );
  });
});

describe('применение', () => {
  it('предпросмотр не трогает базу', async () => {
    const bytes = book([HEADER, ['', 'ekb', 'Екатеринбург', '', 'да']]);
    await importDirectory(def, bytes, { dryRun: true, actorUserId: 'u' });
    expect(applied).toEqual([]);
  });

  it('применение заводит и правит ровно то, что показал предпросмотр', async () => {
    const bytes = book([
      HEADER,
      ['', 'ekb', 'Екатеринбург', '', 'да'],
      ['', 'msk', 'Москва', 'столица', 'нет'],
    ]);
    const report = await importDirectory(def, bytes, { dryRun: false, actorUserId: 'u' });
    expect(report.dryRun).toBe(false);
    expect(applied).toEqual(['создать ekb', 'править msk → msk']);
  });

  it('одна негодная строка отменяет весь файл: половина справочника хуже невыполненной загрузки', async () => {
    const bytes = book([
      HEADER,
      ['', 'ekb', 'Екатеринбург', '', 'да'],
      ['', 'zzz', 'Запрещённый', '', 'да'],
    ]);
    await expect(importDirectory(def, bytes, { dryRun: false, actorUserId: 'u' })).rejects.toThrow(
      /строка 3/u,
    );
    expect(applied).toEqual([]);
  });
});
