import { describe, expect, it, vi } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  DIRECTORY_ID_COLUMN,
  DIRECTORY_KEYS,
  directoryTitles,
  type DirectoryKey,
} from '@technic/contracts';
import * as schema from '../src/db/schema';

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

/**
 * ТАБЛИЦЫ МОДУЛЯ «ОРГ.ТЕХНИКА»: у каждой названо решение об обмене.
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ. Реестр выше сверяет две стороны одной договорённости — ключи портала и описания
 * сервера, — и обе они о том, что в обмене ЕСТЬ. Обратной стороны у него нет вовсе: таблица, в
 * обмене не участвующая, не значится нигде, и «решили не выгружать» неотличимо от «забыли завести
 * описание». Пока модуль состоял из справочников, разница была невелика. С сообщениями об
 * отсутствующей технике (`office_equipment_candidates`; план
 * `docs/office-equipment-candidate-plan.md`, Р1, Р17, §12) она стала предметом: у кандидата ДРУГАЯ
 * область видимости и другие правила жизни, а выгрузка — единственная дверь, ведущая из портала
 * наружу, в чужую систему. Попади он в файл — непроверенные данные уехали бы туда, минуя решение
 * человека с `officeEquipment.write`, и заметить это было бы нечем: в обмене нет ни отбора по
 * области, ни следа о том, чего в файле не хватает.
 *
 * Поэтому «кандидат в обмен не входит» перестаёт быть молчаливым свойством и записывается строкой.
 * Строка — не про кандидата одного: перечислен ВЕСЬ модуль, и новая его таблица роняет прогон,
 * пока автор не назовёт её род. Страж, знающий об одном исключении, ловит ровно то, о чём уже
 * подумали.
 *
 * ПОЧЕМУ ОБЪЯВЛЕНИЕ ЖИВЁТ В ТЕСТЕ, А НЕ В `registry.ts`. Реестр — рабочий код: он собирает
 * описания и по ним отдаёт файлы, и таблица, которая в обмене не участвует, ему не нужна ни для
 * чего — строка о ней стала бы данными, которые никто не читает, то есть третьим списком, молча
 * расходящимся с первыми двумя. Здесь же она и ЕСТЬ проверка. Приём не новый: тем же способом
 * рядом ведётся `NEEDS_ENV`, а составные ключи схемы перечислены поимённо в
 * `schema-copy-keys.test.ts` — «новый ключ требует решения, а не умолчания» сказано там дословно.
 *
 * ГРАНИЦА МОДУЛЯ — ПРЕФИКС ИМЕНИ ТАБЛИЦЫ, и это выбор, а не единственный возможный. Имена модуля
 * начинаются с `office_equipment` все до одной, и правило проверяемо глазами; таблицы соседей
 * (`service_requests` и её родня) живут в модуле заявок и своим стражем меряются отдельно. Цена
 * границы названа вслух: таблица модуля, названная иначе, сюда не попадёт — и потому имя нового
 * предмета модуля тоже решение, а не оформление.
 *
 * ПЕРЕЧЕНЬ БЕРЁТСЯ ИЗ СХЕМЫ DRIZZLE, а не из базы, и это не упрощение: описания обмена читают
 * ровно эти объекты (`defs/office.ts` импортирует таблицы отсюда), и таблица, которой в схеме нет,
 * недоступна обмену физически. То есть проверяется тот самый список, из которого обмен и может
 * что-либо взять.
 */
const OFFICE_MODULE_TABLES: Record<string, { directory: DirectoryKey | null; why: string }> = {
  office_equipment_types: {
    directory: 'office-equipment-types',
    why: 'перечень типов — сам справочник обмена',
  },
  office_equipment_models: {
    directory: 'office-equipment-models',
    why: 'справочник моделей аппаратов',
  },
  office_equipment: { directory: 'office-equipment', why: 'карточки парка' },
  office_equipment_consumables: {
    directory: 'office-equipment-consumables',
    why: 'перечень расходников',
  },
  // Привязка «расходник ↔ модель» едет колонкой «Модели» в файле расходников: отдельным
  // справочником связь не выгружают — человек ведёт её списком в строке, а не второй вкладкой.
  office_equipment_consumable_models: {
    directory: 'office-equipment-consumables',
    why: 'колонка «Модели» в файле расходников (`linkConsumableModels`)',
  },
  // Значения характеристик модели: тоже колонки файла моделей (`applyModelSpecs`), а не свой лист.
  office_equipment_model_specs: {
    directory: 'office-equipment-models',
    why: 'колонки характеристик в файле моделей (`applyModelSpecs`)',
  },
  // Словарь характеристик и его значения ведут МИГРАЦИИ (ADR 0158): это состав формы, а не данные
  // площадок. Отдай их файлу — и загруженная строка меняла бы смысл колонок у всех моделей разом.
  office_equipment_specs: {
    directory: null,
    why: 'словарь характеристик ведут миграции (ADR 0158), файлом его не правят',
  },
  office_equipment_spec_values: {
    directory: null,
    why: 'значения характеристик ведут миграции (ADR 0158)',
  },
  office_equipment_type_specs: {
    directory: null,
    why: 'какие характеристики положены типу — тоже состав формы, а не справочник',
  },
  // Дальше — не справочники вовсе: журналы и документы. Обмен файлом правит справочники (ADR 0073),
  // а событие, уже случившееся, загрузкой файла не переписывают.
  office_equipment_movements: {
    directory: null,
    why: 'журнал перемещений: событие, а не строка справочника',
  },
  office_equipment_consumable_stock_entries: {
    directory: null,
    why: 'журнал остатка: неизменяем физически (триггер `…_stock_immutable`)',
  },
  office_equipment_purchases: {
    directory: null,
    why: 'документ закупки со своим циклом (ADR 0146)',
  },
  office_equipment_purchase_items: { directory: null, why: 'строки того же документа' },
  /*
   * СООБЩЕНИЕ ОБ ОТСУТСТВУЮЩЕЙ ТЕХНИКЕ — та самая строка, ради которой заведён весь перечень
   * (план кандидатов, Р17): предмет НА ПРОВЕРКЕ, а не запись справочника. В парк он попадает
   * решением человека и только им; выгрузи его файл — и непроверенные реквизиты уехали бы наружу
   * раньше этого решения, а загрузка файла стала бы вторым способом завести карточку в обход
   * `officeEquipment.write`.
   */
  office_equipment_candidates: {
    directory: null,
    why: 'предмет на проверке, а не справочник: в парк попадает решением (план кандидатов, Р17)',
  },
};

/** Имена таблиц модуля в схеме: граница — префикс, представления и прочие объекты не в счёт. */
function officeModuleTables(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    if (name === 'office_equipment' || name.startsWith('office_equipment_')) names.push(name);
  }
  return names.sort();
}

describe('таблицы оргтехники и обмен файлом', () => {
  it('перечислены все до одной — новая таблица модуля требует решения, а не умолчания', () => {
    expect(officeModuleTables()).toEqual(Object.keys(OFFICE_MODULE_TABLES).sort());
  });

  it('названный справочник существует: строка не может ссылаться на ключ, которого нет', () => {
    for (const [table, decision] of Object.entries(OFFICE_MODULE_TABLES)) {
      if (decision.directory === null) continue;
      expect(directoryFor(decision.directory), table).toBeDefined();
    }
  });

  it('у каждого справочника оргтехники в обмене есть таблица, которая за него отвечает', () => {
    // Обратная сторона: заведи кто-нибудь новое описание — и оно обязано быть названо здесь, иначе
    // перечень модуля рассказывал бы про обмен неправду.
    const covered = new Set(
      Object.values(OFFICE_MODULE_TABLES)
        .map((d) => d.directory)
        .filter((key): key is DirectoryKey => key !== null),
    );
    const office = DIRECTORY_KEYS.filter((key) => key.startsWith('office-equipment'));
    expect(office.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('сообщение об отсутствующей технике в обмен не входит — и это записано, а не подразумевается', () => {
    // Именная строка поверх общей проверки: общая поймала бы и «кандидата дописали в выгрузку»
    // молча — перечень остался бы полным. Здесь названо само решение плана (Р17).
    expect(OFFICE_MODULE_TABLES.office_equipment_candidates!.directory).toBeNull();
    expect(DIRECTORY_KEYS).not.toContain('office-equipment-candidates');
  });
});
