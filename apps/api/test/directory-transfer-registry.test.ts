import { describe, expect, it, vi } from 'vitest';
import { DIRECTORY_ID_COLUMN, DIRECTORY_KEYS, directoryTitles } from '@technic/contracts';

/**
 * Реестр справочников обмена (ADR 0073): договорённость между порталом и сервером.
 *
 * Список ключей живёт в общем пакете — по нему портал рисует вкладку. Ключ без описания на
 * сервере означает кнопку, ведущую в 404, а описание без ключа — справочник, о котором знает
 * только сервер и до которого никто не доберётся. Ни то ни другое не видно ни типами, ни линтом,
 * поэтому проверяется здесь.
 *
 * База подменена: реестр только собирается, запросов на этом не делает.
 */

vi.mock('../src/db/client', () => ({ db: {} }));

const { directories, directoryFor } = await import('../src/services/directory-transfer/registry');

describe('реестр справочников', () => {
  it('на каждый ключ портала есть описание на сервере', () => {
    const missing = DIRECTORY_KEYS.filter((key) => directoryFor(key) === undefined);
    expect(missing).toEqual([]);
  });

  it('лишних описаний нет: каждое отвечает своему ключу из общего списка', () => {
    for (const def of directories) {
      expect(DIRECTORY_KEYS, def.key).toContain(def.key);
      expect(directoryTitles[def.key], def.key).toBeTruthy();
    }
  });

  it('ключ у каждого описания свой — иначе один справочник заслонил бы другой', () => {
    const keys = directories.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('порядок описаний совпадает с порядком показа', () => {
    expect(directories.map((d) => d.key)).toEqual([...DIRECTORY_KEYS]);
  });
});

/**
 * Справочники, у которых состав колонок задаёт содержимое базы. Такой один: у категорий типов ТС
 * колонка появляется на каждый заведённый ТТХ (ADR 0016), и без настоящего окружения их не
 * построить. Список перечислен явно, а не выведен, чтобы следующий такой справочник появился
 * здесь строкой и вместе с ответом на вопрос «а его-то чем проверяют» — их проверяет
 * `directory-transfer.db.test.ts` на живой схеме.
 */
const NEEDS_ENV = new Set(['vehicle-categories']);

describe('колонки описаний', () => {
  /**
   * Колонки на пустом окружении. `undefined` — описанию нужно настоящее: сбор окружения ходит в
   * базу, а её здесь нет.
   */
  const columnsOf = (def: (typeof directories)[number]) => {
    try {
      return def.columns({} as never);
    } catch {
      return undefined;
    }
  };

  /** Справочники, которые проверяются здесь: остальные — только на живой схеме. */
  const plain = directories.filter((d) => !NEEDS_ENV.has(d.key));

  it('справочники с колонками из базы перечислены осознанно', () => {
    const needy = directories.filter((d) => columnsOf(d) === undefined).map((d) => d.key);
    expect(needy).toEqual([...NEEDS_ENV]);
  });

  it('заголовки внутри справочника не повторяются: иначе неизвестно, какую колонку читать', () => {
    for (const def of plain) {
      const headers = (columnsOf(def) ?? []).map((c) => c.header.trim().toLowerCase());
      expect(new Set(headers).size, def.key).toBe(headers.length);
    }
  });

  it('служебное имя колонки идентификатора никто не занял под своё поле', () => {
    for (const def of plain) {
      const headers = (columnsOf(def) ?? []).map((c) => c.header.trim().toLowerCase());
      expect(headers, def.key).not.toContain(DIRECTORY_ID_COLUMN.toLowerCase());
    }
  });

  it('у каждого справочника есть хотя бы одна колонка, которую загрузка читает', () => {
    for (const def of plain) {
      const writable = (columnsOf(def) ?? []).filter((c) => c.set !== undefined);
      expect(writable.length, def.key).toBeGreaterThan(0);
    }
  });

  it('пустая модель разбирается своими же колонками — с неё начинается новая строка файла', () => {
    for (const def of plain) {
      const blank = def.blank();
      for (const column of columnsOf(def) ?? []) {
        expect(typeof column.get(blank), def.key).toBe('string');
      }
    }
  });
});
