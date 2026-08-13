import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CounterpartyType, Role } from '@technic/contracts';
import type { Principal } from '../src/auth/principal';
import { files as filesTable } from '../src/db/schema';

/**
 * База, какой её видят обе файловые функции. Перечня таблиц привязки здесь больше нет: он уехал в
 * функцию БД `file_is_linked(uuid)` (миграция 0133), и код о таблицах связи больше не знает вовсе.
 *
 * Отсюда и устройство подмены. `files` — строки, которые «есть в базе» (с их статусом загрузки);
 * `linked` — ответ самой функции БД, то есть множество файлов, привязанных хоть к чему-нибудь.
 * Подмена не разбирает условий запроса, кроме одного: содержит ли `WHERE` вызов `file_is_linked`.
 * Именно это и проверяется на новом контракте — что обе функции **спрашивают базу**, а не носят
 * свой список модулей; какие таблицы функция перечисляет, проверяет `file-linkage.db.test.ts` на
 * живой схеме, потому что проверить это можно только там, где функция существует.
 *
 * `from` — журнал таблиц, от которых код строил запросы: перечень уехал, и вернуться он может
 * только новым `select ... from <таблица связи>` в этих двух функциях.
 */
const stored = vi.hoisted(() => ({
  files: new Map<string, { status: string }>(),
  linked: new Set<string>(),
  from: [] as unknown[],
}));

// Модуль маршрутов тянет S3-клиент и конфиг — для правила доступа нужен только сам файл.
vi.mock('../src/db/client', () => {
  /**
   * Есть ли в условии вызов `file_is_linked`. Обход по значениям: drizzle собирает `sql`-шаблон в
   * дерево кусков, и текст функции лежит в нём строкой. `seen` — из-за ссылок колонок на свою
   * таблицу и обратно.
   */
  const asksLinkFunction = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (typeof node === 'string') return node.includes('file_is_linked');
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    return Object.values(node).some((v) => asksLinkFunction(v, seen));
  };
  const rowsOf = (table: unknown, where: unknown) => {
    stored.from.push(table);
    const rows = [...stored.files].map(([id, f]) => ({ id, fileId: id, status: f.status }));
    return asksLinkFunction(where) ? rows.filter((r) => stored.linked.has(r.id)) : rows;
  };
  /** Шаг цепочки drizzle: результат и ждут (`await`), и продолжают `.limit()` / `.for('update')`. */
  const result = (rows: unknown[]) => ({
    then: (ok: (v: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, fail),
    limit: (n: number) => result(rows.slice(0, n)),
    for: () => result(rows),
  });
  const query = {
    select: () => ({
      from: (table: unknown) => ({ where: (w: unknown) => result(rowsOf(table, w)) }),
    }),
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
 * (ADR 0021). Три обхода, которые здесь и закрыты: авторство загрузки как бессрочный ключ, ветка
 * «вывоз мусора», проходимая ролью без права на этот модуль, и фотография показаний, которую
 * водитель открывал бы по чужому отчёту (Р34).
 */

const UPLOADER = 'uploader-1';
const PERSON = 'person-1';

function principal(
  role: Role | null,
  id = UPLOADER,
  counterpartyType: CounterpartyType | null = null,
  personId: string | null = null,
): Principal {
  return {
    id,
    email: 'user@test.local',
    lastName: 'Пользователь',
    firstName: 'Тестовый',
    middleName: '',
    fullName: 'Пользователь Тестовый',
    phone: '',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyId: null,
    personId,
    counterpartyType,
    addons: [],
    authVersion: 1,
  };
}

/** Внешний исполнитель: модуль ему открывает тип контрагента, а не роль (ADR 0038). */
const wasteOperator = (id = 'other') => principal('operator', id, 'operator');
const vehicleLessor = (id = 'other') => principal('operator', id, 'vehicle_lessor');
/** Сервисная компания (ADR 0085): её модуль — заявки на обслуживание оргтехники. */
const serviceExecutor = (id = 'other') => principal('operator', id, 'service');
/** Водитель (ADR 0102): роль второго контура, её область — сам человек, а не объект. */
const driver = (id = 'driver-user', personId: string | null = PERSON) =>
  principal('driver', id, null, personId);

const NOWHERE = {
  visibleWaste: false,
  visibleVehicle: false,
  visibleService: false,
  visibleWaybill: false,
  visibleReading: false,
  ownDriverReading: false,
  linkedAnywhere: false,
};
const IN_WASTE = { ...NOWHERE, visibleWaste: true, linkedAnywhere: true };
const IN_VEHICLE = { ...NOWHERE, visibleVehicle: true, linkedAnywhere: true };
const IN_SERVICE = { ...NOWHERE, visibleService: true, linkedAnywhere: true };
/** Скан, подшитый к путевому листу (миграция 0087): у журнала листов своей области нет. */
const IN_WAYBILL = { ...NOWHERE, visibleWaybill: true, linkedAnywhere: true };
/** Фотография показания: связь нашлась, и это показание парка, а не отчёт самого принципала. */
const IN_READING = { ...NOWHERE, visibleReading: true, linkedAnywhere: true };
/** Фотография показания из отчёта самого принципала (Р34): четвёртая ось области сошлась. */
const IN_OWN_READING = { ...NOWHERE, ownDriverReading: true, linkedAnywhere: true };
/** Файл лежит в заявке, которую этот пользователь не видит (чужой объект, чужой контрагент). */
const IN_INVISIBLE_REQUEST = { ...NOWHERE, linkedAnywhere: true };

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
 * Фотографии показаний (Р34) — две ветки доступа вместо одной, и это не удвоение правила, а два
 * разных вопроса.
 *
 * Персонал видит снимок по праву на модуль показаний (`vehicleReadings.read`): область у показаний
 * своя не заводится по той же причине, что у журнала листов, — список не сужается ни объектом, ни
 * контрагентом, и прятать файл, который портал в строке показывает, было бы враньём.
 *
 * Водитель видит **свой** снимок, и права на модуль у него нет вовсе: `driverCabinet.read` — это
 * весь его портал. Поэтому вторая ветка требует не права на показания, а совпадения человека
 * (`ownDriverReading` считает `canAccessFile` сравнением `person_id` отчёта с `personId`
 * принципала). Открой её одним лишь `driverCabinet.read` — и водитель получил бы любую фотографию
 * парка по угаданному идентификатору: чужой одометр, чужой чек с заправки, чужая машина.
 */
describe('фотография показаний техники (Р34)', () => {
  it('персонал открывает снимок по праву на показания парка', () => {
    for (const role of ['admin', 'manager', 'dispatcher'] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_READING), role).toBe(true);
    }
  });

  it('роль без модуля показаний снимка не получает, даже читая заявки и листы', () => {
    // У штаба и коменданта показаний нет вовсе; у наблюдателя сквозной просмотр заявок, но не
    // парка; у внешних исполнителей — свой модуль и ничего сверх него.
    for (const role of ['shtab', 'rukstroy', 'commandant', 'observer', 'department'] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_READING), role).toBe(false);
    }
    expect(decideFileAccess(vehicleLessor(), UPLOADER, IN_READING)).toBe(false);
    expect(decideFileAccess(serviceExecutor(), UPLOADER, IN_READING)).toBe(false);
  });

  it('водитель открывает свою фотографию — из своего же отчёта', () => {
    expect(decideFileAccess(driver(), UPLOADER, IN_OWN_READING)).toBe(true);
  });

  it('чужую фотографию водитель не открывает: у него нет права на показания парка', () => {
    // Тот же файл, та же связь с показанием — и единственная разница в том, что отчёт не его.
    // Это и есть вся защита от перебора идентификаторов в кабинете.
    expect(decideFileAccess(driver(), UPLOADER, IN_READING)).toBe(false);
  });

  it('своя фотография остаётся видна после привязки — уже по отчёту, а не по авторству', () => {
    const d = driver(UPLOADER);
    // До отправки отчёта снимок открыт как свежая загрузка (`linkedAnywhere: false`)...
    expect(decideFileAccess(d, UPLOADER, NOWHERE)).toBe(true);
    // ...после — ветка авторства уже закрыта, и держит доступ только совпадение человека.
    expect(decideFileAccess(d, UPLOADER, IN_OWN_READING)).toBe(true);
    expect(decideFileAccess(d, UPLOADER, IN_INVISIBLE_REQUEST)).toBe(false);
  });

  it('водитель не добирается до вложений заявок и путевых листов', () => {
    // Кабинет — второй контур портала: ни заявок, ни журнала БСО в нём нет.
    for (const linkage of [IN_WASTE, IN_VEHICLE, IN_SERVICE, IN_WAYBILL]) {
      expect(decideFileAccess(driver(), UPLOADER, linkage)).toBe(false);
    }
  });

  it('снимок показания не открывается ветками чужих модулей', () => {
    // Обратная сторона того же: право на заявки и листы к фотографиям парка не ведёт.
    expect(decideFileAccess(principal('shtab', 'other'), UPLOADER, IN_READING)).toBe(false);
    expect(decideFileAccess(wasteOperator(), UPLOADER, IN_READING)).toBe(false);
  });
});

/**
 * Второе и третье места файлового контура (план оргтехники Р28, план кабинета Р18). Первое —
 * `decideFileAccess` выше: оно только **применяет** признак «файл ещё никуда не привязан».
 *
 * Считали этот признак две функции с двумя копиями перечня таблиц, и пропуск модуля в одной из них
 * не выглядел поломкой: привязка работает, вложение видно, — а два правила портала молча
 * переставали действовать. Так и случилось с `waybill_files`. С приходом уборки в воркере читателей
 * стало трое, а цена забытой строки выросла с лишнего доступа до безвозвратно удалённого документа
 * — и перечень уехал в функцию БД `file_is_linked(uuid)` (миграция 0133).
 *
 * Отсюда предмет проверки здесь: обе функции **спрашивают базу** и подчиняются её ответу, а таблиц
 * связи не перечисляют вовсе. Полнота самого перечня проверяется на живой схеме
 * (`file-linkage.db.test.ts`): здесь функции БД не существует, и подтвердить про неё нечего.
 */
const FILE_ID = 'file-1';

describe('признак привязки спрашивается у базы (миграция 0133)', () => {
  beforeEach(() => {
    stored.files.clear();
    stored.linked.clear();
    stored.from.length = 0;
    // Сам файл существует, принадлежит загрузившему и не удалён: `assertFilesAttachable` начинает
    // с этой проверки, и без строки в `files` до вопроса о привязке дело не дойдёт.
    stored.files.set(FILE_ID, { status: 'active' });
  });

  it('`isFileLinked` отвечает ответом `file_is_linked`, а не своим списком модулей', async () => {
    expect(await isFileLinked(FILE_ID)).toBe(false);
    stored.linked.add(FILE_ID);
    expect(await isFileLinked(FILE_ID)).toBe(true);
  });

  it('и спрашивает её от `files`: таблиц связи в запросе нет ни одной', async () => {
    await isFileLinked(FILE_ID);
    expect(stored.from).toEqual([filesTable]);
  });

  it('привязка тоже спрашивает базу — и от неё же получает отказ', async () => {
    await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).resolves.toBeUndefined();
    stored.linked.add(FILE_ID);
    await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).rejects.toThrow(
      'Файл уже прикреплён к заявке',
    );
    // Оба запроса привязки идут от `files`: перечень модулей ушёл отсюда целиком, и вернуться он
    // может только новым `select ... from <таблица связи>` — вот его и ловит журнал.
    expect(new Set(stored.from)).toEqual(new Set([filesTable]));
  });

  it('загрузивший теряет прямой доступ, как только файл лёг в заявку', async () => {
    // Ловушка Р28, собранная целиком: до привязки ветка авторства файл открывает, после — нет, и
    // «после» она узнаёт только из `isFileLinked`.
    const uploader = principal('shtab');
    const linkage = async () => ({ ...NOWHERE, linkedAnywhere: await isFileLinked(FILE_ID) });
    expect(decideFileAccess(uploader, UPLOADER, await linkage())).toBe(true);

    stored.linked.add(FILE_ID);
    expect(decideFileAccess(uploader, UPLOADER, await linkage())).toBe(false);
  });

  /**
   * Незавершённая загрузка (Р18). У заявок проверки статуса нет исторически — форма грузит файл и
   * сохраняет заявку одним движением, и `pending` там означает «вот-вот дозагрузится». Показаниям
   * этого мало: фотографии приезжают вместе с числами при отправке отчёта, а `pending` — это файл,
   * объекта которого в хранилище может не быть вовсе, и через сутки его заберёт уборка. Отчёт со
   * ссылкой на несуществующий объект внешне неотличим от отчёта с фотографией — до дня, когда её
   * попробуют открыть.
   */
  it('`requireActive` не пускает в отчёт незавершённую загрузку', async () => {
    stored.files.set(FILE_ID, { status: 'pending' });
    await expect(
      assertFilesAttachable(tx, [FILE_ID], UPLOADER, { requireActive: true }),
    ).rejects.toThrow('Загрузка файла не завершена');
    // Без флага тот же файл проходит: у заявок правило прежнее и не ужесточается задним числом.
    await expect(assertFilesAttachable(tx, [FILE_ID], UPLOADER)).resolves.toBeUndefined();
  });

  it('завершённая загрузка проходит и с `requireActive`', async () => {
    await expect(
      assertFilesAttachable(tx, [FILE_ID], UPLOADER, { requireActive: true }),
    ).resolves.toBeUndefined();
  });
});
