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

// Конфиг ставится до импортов: описание отделов с ADR 0144 пишет журнал доступа (`lib/audit`), а
// тот тянет логгер, читающий конфиг при загрузке модуля. Подменять ради этого сам журнал было бы
// хуже — проверяется здесь состав реестра, и чем меньше в нём подменено, тем ближе он к рабочему
// (приём остальных проверок обмена: `directory-transfer-org.test.ts`).
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

vi.mock('../src/db/client', () => ({ db: {} }));
// Модуль сессий подменён по той же причине и тем же приёмом. `user-scopes` с ADR 0144 гасит сессии
// сам, в своей транзакции, поэтому импортирует `auth/sessions`, а тот читает конфиг при загрузке —
// и валится на пустом окружении, куда бы его ни притащили. Проверяемого здесь он не касается вовсе.
vi.mock('../src/auth/sessions', () => ({ revokeAllForUsersTx: async () => {} }));

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
