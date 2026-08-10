import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CounterpartyType, Role } from '@technic/contracts';
import type { Principal } from '../src/auth/principal';
import {
  files as filesTable,
  requestFiles,
  serviceRequestFiles,
  vehicleRequestFiles,
  waybillFiles,
} from '../src/db/schema';

/**
 * Что лежит в таблицах привязки: таблица drizzle → идентификаторы файлов в ней. Задаётся каждым
 * тестом и заменяет базу целиком.
 *
 * Ключ — сама таблица, а не её имя: подмена ничего не знает ни про колонки, ни про условия
 * запроса, и потому отвечает ровно на тот вопрос, который здесь и проверяется, — **в какие
 * таблицы код вообще заглянул**. Забытая в перечислении таблица так и выглядит: строка в ней
 * есть, а ответ «не привязан».
 */
const stored = vi.hoisted(() => new Map<unknown, string[]>());

// Модуль маршрутов тянет S3-клиент и конфиг — для правила доступа нужен только сам файл.
vi.mock('../src/db/client', () => {
  const rowsOf = (table: unknown) =>
    (stored.get(table) ?? []).map((id) => ({ id, f: id, fileId: id }));
  /** Шаг цепочки drizzle: результат и ждут (`await`), и продолжают `.limit()` / `.for('update')`. */
  const result = (rows: unknown[]) => ({
    then: (ok: (v: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, fail),
    limit: (n: number) => result(rows.slice(0, n)),
    for: () => result(rows),
  });
  const query = {
    select: () => ({ from: (table: unknown) => ({ where: () => result(rowsOf(table)) }) }),
  };
  return { db: query, pingDb: async () => {} };
});
vi.mock('../src/lib/s3', () => ({
  buildObjectKey: () => 'key',
  deleteObject: async () => {},
  headObject: async () => null,
  presignGet: async () => 'url',
  presignPut: async () => 'url',
}));
vi.mock('../src/config', () => ({
  config: {
    files: { maxSize: 1, maxPerRequest: 10 },
    s3: { bucket: 'b', uploadUrlTtl: 1, downloadUrlTtl: 1 },
  },
}));

const { decideFileAccess } = await import('../src/routes/files');
const { assertFilesAttachable, isFileLinked } = await import('../src/services/request-files');

/** `assertFilesAttachable` берёт из транзакции только `select` — подмена клиента ей и подходит. */
const tx = (await import('../src/db/client')).db as unknown as Parameters<
  typeof assertFilesAttachable
>[0];

/**
 * Доступ к файлу — единственное место, где право выводится не из роли, а из связанной записи
 * (ADR 0021). Два обхода, которые здесь и закрыты: авторство загрузки как бессрочный ключ и
 * ветка «вывоз мусора», проходимая ролью без права на этот модуль.
 */

const UPLOADER = 'uploader-1';

function principal(
  role: Role | null,
  id = UPLOADER,
  counterpartyType: CounterpartyType | null = null,
): Principal {
  return {
    id,
    email: 'user@test.local',
    lastName: 'Пользователь',
    firstName: 'Тестовый',
    middleName: '',
    fullName: 'Пользователь Тестовый',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    counterpartyId: null,
    counterpartyType,
    authVersion: 1,
  };
}

/** Внешний исполнитель: модуль ему открывает тип контрагента, а не роль (ADR 0038). */
const wasteOperator = (id = 'other') => principal('operator', id, 'operator');
const vehicleLessor = (id = 'other') => principal('operator', id, 'vehicle_lessor');
/** Сервисная компания (ADR 0085): её модуль — заявки на обслуживание оргтехники. */
const serviceExecutor = (id = 'other') => principal('operator', id, 'service');

const NOWHERE = {
  visibleWaste: false,
  visibleVehicle: false,
  visibleService: false,
  linkedAnywhere: false,
};
const IN_WASTE = {
  visibleWaste: true,
  visibleVehicle: false,
  visibleService: false,
  linkedAnywhere: true,
};
const IN_VEHICLE = {
  visibleWaste: false,
  visibleVehicle: true,
  visibleService: false,
  linkedAnywhere: true,
};
const IN_SERVICE = {
  visibleWaste: false,
  visibleVehicle: false,
  visibleService: true,
  linkedAnywhere: true,
};
/** Файл лежит в заявке, которую этот пользователь не видит (чужой объект, чужой контрагент). */
const IN_INVISIBLE_REQUEST = {
  visibleWaste: false,
  visibleVehicle: false,
  visibleService: false,
  linkedAnywhere: true,
};

describe('файл, ещё не привязанный к заявке', () => {
  it('виден тому, кто его загрузил: иначе не заполнить форму', () => {
    expect(decideFileAccess(principal('shtab'), UPLOADER, NOWHERE)).toBe(true);
  });

  it('чужому не виден, какой бы ни была роль', () => {
    expect(decideFileAccess(principal('admin', 'other-user'), UPLOADER, NOWHERE)).toBe(false);
  });

  it('файл без автора не виден никому', () => {
    expect(decideFileAccess(principal('admin'), null, NOWHERE)).toBe(false);
  });
});

describe('привязанный файл живёт по правилам своей заявки', () => {
  it('автор теряет доступ, когда заявка перестала быть ему видна', () => {
    // Тот же человек, тот же файл: заявку перенесли на другой объект (или сменилась роль) —
    // видимости нет, и прежняя загрузка больше ничего не даёт.
    expect(decideFileAccess(principal('shtab'), UPLOADER, IN_INVISIBLE_REQUEST)).toBe(false);
  });

  it('видимая заявка вывоза открывает файл тому, кто вправе её читать', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy'] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_WASTE), role).toBe(true);
    }
    expect(decideFileAccess(wasteOperator(), UPLOADER, IN_WASTE)).toBe(true);
  });

  it('исполнителю доступны вложения только своего модуля (ADR 0010, 0038)', () => {
    // Оператор вывоза не видит вложений заказа ТС, арендодатель — вложений вывоза мусора:
    // у каждого открыт ровно тот модуль, который назван типом его контрагента.
    expect(decideFileAccess(wasteOperator(), UPLOADER, IN_VEHICLE)).toBe(false);
    expect(decideFileAccess(vehicleLessor(), UPLOADER, IN_WASTE)).toBe(false);
    expect(decideFileAccess(vehicleLessor(), UPLOADER, IN_VEHICLE)).toBe(true);
    expect(decideFileAccess(principal('dispatcher', 'other'), UPLOADER, IN_VEHICLE)).toBe(true);
  });

  it('документ заявки на обслуживание открыт тому, кто читает этот модуль (ADR 0085)', () => {
    // Заказчик заявки — площадка и отделы, наблюдатель — сквозной просмотр, сервисная компания —
    // исполнитель. Область самой заявки посчитана до этого места (`canAccessFile`), здесь решается
    // только «положен ли модуль вообще».
    for (const role of [
      'admin',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'observer',
    ] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_SERVICE), role).toBe(true);
    }
    expect(decideFileAccess(serviceExecutor(), UPLOADER, IN_SERVICE)).toBe(true);
  });

  it('роль без модуля обслуживания документа не получает, даже ведя справочник оргтехники', () => {
    // У менеджера и диспетчера есть `officeEquipment.read` — они ведут карточки техники, — но
    // заявок с суммами, актами и счетами не ведут вовсе (Р7). Комендант закрыт и от справочника.
    for (const role of ['manager', 'dispatcher', 'commandant'] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_SERVICE), role).toBe(false);
    }
    // И наоборот: сервисная компания не добирается до вложений двух чужих модулей.
    expect(decideFileAccess(serviceExecutor(), UPLOADER, IN_WASTE)).toBe(false);
    expect(decideFileAccess(serviceExecutor(), UPLOADER, IN_VEHICLE)).toBe(false);
    expect(decideFileAccess(wasteOperator(), UPLOADER, IN_SERVICE)).toBe(false);
    expect(decideFileAccess(vehicleLessor(), UPLOADER, IN_SERVICE)).toBe(false);
  });
});

describe('учётка без роли', () => {
  it('не получает файл ни одной заявки, даже зная её связь', () => {
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_WASTE)).toBe(false);
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_VEHICLE)).toBe(false);
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_INVISIBLE_REQUEST)).toBe(false);
  });

  it('её собственный неприкреплённый файл ей доступен — он больше ничей', () => {
    expect(decideFileAccess(principal(null), UPLOADER, NOWHERE)).toBe(true);
  });
});

/**
 * Второе и третье места файлового контура (план оргтехники Р28). Первое — `decideFileAccess` выше:
 * оно только **применяет** признак «файл ещё никуда не привязан». Считают этот признак две
 * отдельные функции с двумя отдельными перечислениями таблиц, и пропуск таблицы в них не выглядит
 * поломкой — привязка работает, вложение видно, а два правила портала молча перестают действовать.
 *
 * Проверяется здесь именно перечисление: в таблицу кладётся один файл, и от кода требуется, чтобы
 * он в неё заглянул. Уберите `service_request_files` из `isFileLinked` — и загрузивший акт
 * сохранит доступ к нему по прямой ссылке навсегда, в том числе после того, как сама заявка
 * перестанет быть ему видна; уберите из `linkedFileIds` — и один файл ляжет в две заявки, а
 * снятие его из одной унесёт документ у второй.
 */
const FILE_ID = 'file-1';

describe('привязка документа сервисной заявки (Р28)', () => {
  beforeEach(() => {
    stored.clear();
    // Сам файл существует, принадлежит загрузившему и не удалён: `assertFilesAttachable` начинает
    // с этой проверки, и без строки в `files` до перечисления таблиц привязки дело не дойдёт.
    stored.set(filesTable, [FILE_ID]);
  });

  it('`isFileLinked` знает про документы заявок на обслуживание', async () => {
    expect(await isFileLinked(FILE_ID)).toBe(false);
    stored.set(serviceRequestFiles, [FILE_ID]);
    expect(await isFileLinked(FILE_ID)).toBe(true);
  });

  it('и про вложения двух прежних модулей — перечисление не сузилось', async () => {
    for (const table of [requestFiles, vehicleRequestFiles]) {
      stored.set(table, [FILE_ID]);
      expect(await isFileLinked(FILE_ID)).toBe(true);
      stored.delete(table);
    }
  });

  it('загрузивший теряет прямой доступ, как только документ лёг в заявку', async () => {
    // Та самая ловушка Р28, собранная целиком: до привязки ветка авторства файл открывает, после —
    // нет, и «после» она узнаёт только из `isFileLinked`.
    const uploader = principal('shtab');
    const linkage = async () => ({
      visibleWaste: false,
      visibleVehicle: false,
      // Заявку он больше не видит: сменились роль, объект, отдел или контрагент.
      visibleService: false,
      linkedAnywhere: await isFileLinked(FILE_ID),
    });
    expect(decideFileAccess(uploader, UPLOADER, await linkage())).toBe(true);

    stored.set(serviceRequestFiles, [FILE_ID]);
    expect(decideFileAccess(uploader, UPLOADER, await linkage())).toBe(false);
  });

  it('файл, лежащий в сервисной заявке, во вторую заявку не привязывается', async () => {
    stored.set(serviceRequestFiles, [FILE_ID]);
    await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).rejects.toThrow(
      'Файл уже прикреплён к заявке',
    );
  });

  it('свободный файл привязывается — отказ приходит от связи, а не от самой проверки', async () => {
    await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).resolves.toBeUndefined();
  });

  it('и не привязывается вторым — к заявке вывоза, к заказу ТС, к путевому листу', async () => {
    for (const table of [requestFiles, vehicleRequestFiles, waybillFiles]) {
      stored.set(table, [FILE_ID]);
      await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).rejects.toThrow(
        'Файл уже прикреплён к заявке',
      );
      stored.delete(table);
    }
  });
});
