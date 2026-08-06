import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  counterpartyTypeLabels,
  formatPhone,
  INN_CHECKSUM_MESSAGE,
  INN_MESSAGE,
  isValidInn,
  normalizePhone,
  PHONE_FORMAT_MESSAGE,
  warehouseTitle,
  type CounterpartyType,
} from '@technic/contracts';
import { db } from '../../../db/client';
import {
  constructionObjects,
  counterparties,
  counterpartySynonyms,
  departments,
  organizations,
  warehouses,
  type CounterpartyRow,
  type DepartmentRow,
  type ObjectRow,
  type WarehouseRow,
} from '../../../db/schema';
import { markDepartmentScopeChanged } from '../../user-scopes';
import { boolCell, listCell, parseBool, parseChoice, parseList } from '../cells';
import { directory, type AnyDirectory, type RowContext, type Tx } from '../types';

/**
 * Организационные справочники обмена (ADR 0073): объекты, отделы, контрагенты, склады и
 * организации-владельцы транспорта. Это верх портала — на него ссылается почти всё остальное,
 * поэтому и в списке справочников они идут первыми: файл склада бесполезен, пока в портале нет
 * поставщика, на которого склад сошлётся.
 *
 * Правила проверки здесь не заводятся заново, а берутся оттуда, где они уже приняты: контрольная
 * сумма ИНН — `isValidInn` из общего пакета (та же, что в форме контрагента), телефон склада —
 * `normalizePhone` (ADR 0066), «склад только у поставщика» — правило `routes/warehouses.ts`.
 * Разойдись файл с формой хоть на знак, портал начал бы отвергать то, что сам же и выгрузил.
 *
 * Обязательность полей проверяется в `check()`, а не `parseRequired()` в самой ячейке. Причина в
 * том, что колонки в файле может не быть вовсе — человек вправе удалить то, чего не правит, — и
 * тогда `set` не вызовется ни разу, а новая строка молча заведётся без наименования. `check()`
 * смотрит на собранную модель и потому отвечает одинаково и на пустую ячейку, и на отсутствующую
 * колонку. Говорит он поэтому не про ячейку, а про строку («строка без ИНН не заводится»): рядом
 * может стоять и сообщение разбора — негодный номер в модель не попал, и поле осталось пустым.
 * Строк, найденных по «Идентификатору», это не касается: их модель собрана из записи.
 */

/**
 * ИНН из ячейки: длина, цифры и контрольная сумма — той же проверкой, что и форма контрагента
 * (`isValidInn`, веса из приказа ФНС). Пробелы снимаются: их оставляет копирование из документа,
 * частью номера они не являются.
 *
 * `undefined` — ячейка пуста или номер негоден (о втором уже сказано в `ctx`): поле модели
 * остаётся прежним, а «а был ли ИНН вообще» решает `check()`.
 */
function parseInn(text: string, ctx: RowContext, label: string): string | undefined {
  const v = text.trim().replace(/\s/gu, '');
  if (v === '') return undefined;
  if (!/^(\d{10}|\d{12})$/u.test(v)) {
    ctx.fail(`${label} — ${INN_MESSAGE}; получено «${text.trim()}»`);
    return undefined;
  }
  if (!isValidInn(v)) {
    ctx.fail(`${label} — ${INN_CHECKSUM_MESSAGE}: «${v}»`);
    return undefined;
  }
  return v;
}

/**
 * Числовой реквизит организации: ОКПО и ОГРН различаются только длиной. Проверка повторяет CHECK
 * таблицы не ради надёжности, а ради текста: отказ ограничения человек прочитал бы как поломку
 * сервера, а здесь он читает, сколько цифр в номере ждут.
 */
function parseDigits(
  text: string,
  ctx: RowContext,
  label: string,
  lengths: readonly number[],
): string | undefined {
  const v = text.trim().replace(/\s/gu, '');
  if (v === '') return undefined;
  if (!/^\d+$/u.test(v) || !lengths.includes(v.length)) {
    ctx.fail(`${label} — ожидается ${lengths.join(' или ')} цифр, получено «${text.trim()}»`);
    return undefined;
  }
  return v;
}

/** Справочнику, у которого нет ссылок на другие, знать про остальной портал нечего. */
type NoEnv = Record<string, never>;

// ── Объекты строительства ──

interface ObjectModel {
  code: string;
  name: string;
  address: string;
  isActive: boolean;
}

const objectsDirectory = directory<ObjectRow, ObjectModel, NoEnv>({
  key: 'objects',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      width: 14,
      hint: 'Ключ записи: по нему строка ищется в справочнике. Регистр важен — коды заведены прописными («АЛ13»).',
      get: (m) => m.code,
      // Регистр не снимается: код объекта — данные, а не идентификатор из латиницы, и «АЛ13» с
      // «ал13» справочник различает так же, как уникальный индекс в базе.
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 40,
      hint: 'Как объект называют в заявке и в разговоре: «ЖК ALIA, блоки 13А, 13В».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Адрес',
      width: 56,
      hint: 'Почтовый адрес площадки — по нему водитель ищет въезд. Пустая ячейка адрес не стирает.',
      get: (m) => m.address,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.address = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» убирает объект из выбора в заявке; заведённые заявки остаются. Удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Объекты строительства — площадки, на которые заказывают технику и вывоз мусора.',
    'Ключ строки — код: строка с известным кодом обновляет запись, с новым — заводит новую.',
    'Операторы вывоза, обслуживающие объект, файлом не правятся: их набор ведут в карточке объекта и в карточке контрагента.',
    'Удаления файлом нет: строку гасят колонкой «Активен», а сносят из карточки — на объект ссылаются заявки.',
  ],
  load: () => db.select().from(constructionObjects).orderBy(constructionObjects.code),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    address: row.address,
    isActive: row.isActive,
  }),
  blank: () => ({ code: '', name: '', address: '', isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
  },
  create: async (tx, m) => {
    await tx
      .insert(constructionObjects)
      .values({ code: m.code, name: m.name, address: m.address, isActive: m.isActive });
  },
  update: async (tx, row, m) => {
    await tx
      .update(constructionObjects)
      .set({
        code: m.code,
        name: m.name,
        address: m.address,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(constructionObjects.id, row.id));
  },
});

// ── Отделы ──

interface DepartmentModel {
  code: string;
  name: string;
  /** Площадка отдела кодом объекта (ADR 0062); пустая строка — отдел без площадки. */
  objectCode: string;
  isActive: boolean;
}

interface DepartmentEnv {
  objectIdByCode: Map<string, string>;
  objectCodeById: Map<string, string>;
}

const departmentsDirectory = directory<DepartmentRow, DepartmentModel, DepartmentEnv>({
  key: 'departments',
  // Справочник объектов читается один раз на файл: ссылка в нём указана кодом, а записать нужно
  // идентификатор — запрос на каждую строку означал бы сотню запросов на сотню отделов.
  env: async () => {
    const rows = await db
      .select({ id: constructionObjects.id, code: constructionObjects.code })
      .from(constructionObjects);
    return {
      objectIdByCode: new Map(rows.map((r) => [r.code, r.id])),
      objectCodeById: new Map(rows.map((r) => [r.id, r.code])),
    };
  },
  columns: () => [
    {
      header: 'Код',
      width: 14,
      hint: 'Ключ записи: по нему строка ищется в справочнике.',
      get: (m) => m.code,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 40,
      hint: 'Как отдел называют в заявке: «Производственно-технический отдел».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Площадка (код объекта)',
      width: 22,
      hint: 'Код объекта из справочника объектов; пусто — у отдела площадки нет, и это рабочее состояние. Снять заведённую площадку файлом нельзя — это делают в карточке отдела.',
      get: (m) => m.objectCode,
      // Пустая ячейка площадку не снимает, хотя пустая площадка законна: снятие меняет область
      // видимости всем сотрудникам отдела (ADR 0062), и «в файле ячейку не заполнили» не должно
      // означать того же, что осознанное решение в карточке.
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.objectCode = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» убирает отдел из выбора в заявке; привязки учётных записей при этом остаются.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Отделы — офисные подразделения (ПТО, АХО, снабжение): от их имени заводят заявки.',
    'Ключ строки — код. Площадка указывается кодом объекта и чаще всего пуста: площадки нет у большинства отделов (ADR 0062).',
    'Смена площадки меняет область видимости сотрудников отдела: выданные им токены после загрузки перестают действовать, и портал выдаёт новые.',
    'Руководители отдела файлом не правятся — это привязка учётной записи, а не поле справочника.',
  ],
  load: () => db.select().from(departments).orderBy(departments.code),
  id: (row) => row.id,
  model: (row, env) => ({
    code: row.code,
    name: row.name,
    objectCode:
      row.constructionObjectId === null
        ? ''
        : (env.objectCodeById.get(row.constructionObjectId) ?? ''),
    isActive: row.isActive,
  }),
  blank: () => ({ code: '', name: '', objectCode: '', isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx, env) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
    if (m.objectCode !== '' && !env.objectIdByCode.has(m.objectCode)) {
      ctx.fail(`площадка «${m.objectCode}» не найдена — сначала загрузите справочник объектов`);
    }
  },
  create: async (tx, m, env) => {
    await tx.insert(departments).values({
      code: m.code,
      name: m.name,
      constructionObjectId:
        m.objectCode === '' ? null : (env.objectIdByCode.get(m.objectCode) ?? null),
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m, env) => {
    const objectId = m.objectCode === '' ? null : (env.objectIdByCode.get(m.objectCode) ?? null);
    await tx
      .update(departments)
      .set({
        code: m.code,
        name: m.name,
        constructionObjectId: objectId,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(departments.id, row.id));
    // Площадка сменилась — область сотрудников отдела стала другой (ADR 0062), и выданный им
    // токен обещал бы прежнюю до самого истечения. Тот же приём, что в карточке отдела: счётчик
    // версии учётки, а не чистка сессий, — она живёт вне транзакции и откату не подлежит.
    if (objectId !== row.constructionObjectId) await markDepartmentScopeChanged(tx, row.id);
  },
});

// ── Контрагенты ──

interface CounterpartyModel {
  /** Пустая строка — тип не задан: так выглядит дописанная строка, которую завернёт `check()`. */
  type: CounterpartyType | '';
  name: string;
  inn: string;
  /** Как ту же организацию пишут в накладных; порядок — тот, что в ячейке файла. */
  synonyms: string[];
  comment: string;
  isActive: boolean;
}

interface CounterpartyStored {
  name: string;
  type: CounterpartyType;
  isActive: boolean;
}

interface CounterpartyEnv {
  /** Синонимы заведённых записей: без них модель строки не собрать и правку не сверить. */
  synonymsById: Map<string, string[]>;
  /** Заведённые контрагенты по ИНН — по ним `check()` видит, что именно строка меняет. */
  storedByInn: Map<string, CounterpartyStored>;
}

/**
 * Синонимы контрагента приводятся к тому, что стоит в ячейке: лишние удаляются, недостающие
 * добавляются. Это подчинённый список самой записи, а не ссылка на чужой справочник — «как эту
 * организацию пишут в накладных» ведут вместе с ней, и файл здесь источник правды.
 *
 * Сравнение — по тексту синонима: в базу едет ровно то написание, которое стоит в ячейке.
 * Нормализованная форма уникальна глобально, поэтому чужой синоним сюда не пройдёт — его
 * завернёт уникальный индекс, а движок переведёт отказ в человеческий текст.
 */
async function replaceSynonyms(
  tx: Tx,
  counterpartyId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  const wanted = new Set(after);
  const gone = before.filter((name) => !wanted.has(name));
  if (gone.length > 0) {
    await tx
      .delete(counterpartySynonyms)
      .where(
        and(
          eq(counterpartySynonyms.counterpartyId, counterpartyId),
          inArray(counterpartySynonyms.name, gone),
        ),
      );
  }
  const had = new Set(before);
  const added = after.filter((name) => !had.has(name));
  if (added.length > 0) {
    await tx.insert(counterpartySynonyms).values(added.map((name) => ({ counterpartyId, name })));
  }
}

const counterpartiesDirectory = directory<CounterpartyRow, CounterpartyModel, CounterpartyEnv>({
  key: 'counterparties',
  env: async () => {
    const synonymRows = await db
      .select({
        counterpartyId: counterpartySynonyms.counterpartyId,
        name: counterpartySynonyms.name,
      })
      .from(counterpartySynonyms)
      .orderBy(counterpartySynonyms.name);
    const synonymsById = new Map<string, string[]>();
    for (const row of synonymRows) {
      const list = synonymsById.get(row.counterpartyId) ?? [];
      list.push(row.name);
      synonymsById.set(row.counterpartyId, list);
    }
    const live = await db
      .select({
        inn: counterparties.inn,
        name: counterparties.name,
        type: counterparties.type,
        isActive: counterparties.isActive,
      })
      .from(counterparties)
      .where(isNull(counterparties.deletedAt));
    return {
      synonymsById,
      storedByInn: new Map(
        live.map((r) => [r.inn, { name: r.name, type: r.type, isActive: r.isActive }]),
      ),
    };
  },
  columns: () => [
    {
      header: 'Тип',
      width: 26,
      hint: 'Роль организации в проекте, словом: «Поставщик», «Оператор (вывоз мусора)», «Арендодатель (ТС)», «Подрядчик», «Генеральный подрядчик». У заведённой записи файлом не меняется.',
      get: (m) => (m.type === '' ? '' : counterpartyTypeLabels[m.type]),
      set: (m, text, ctx) => {
        const v = parseChoice(text, counterpartyTypeLabels, ctx, 'Тип');
        if (v !== undefined) m.type = v;
      },
    },
    {
      header: 'Наименование',
      width: 44,
      hint: 'Основное наименование — как пишем сами. Прочие написания идут в «Синонимы».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'ИНН',
      width: 16,
      hint: 'Ключ записи: 10 цифр у организации, 12 у ИП. Проверяется контрольной суммой — опечатку в одной цифре файл не пропустит.',
      get: (m) => m.inn,
      set: (m, text, ctx) => {
        const v = parseInn(text, ctx, 'ИНН');
        if (v !== undefined) m.inn = v;
      },
    },
    {
      header: 'Синонимы',
      width: 46,
      hint: 'Прочие написания того же наименования через «;». Набор приводится к тому, что в ячейке; пустая ячейка синонимы не убирает — это делают в карточке контрагента.',
      get: (m) => listCell(m.synonyms),
      // Пустая ячейка набор не трогает: файл могли собрать не выгрузкой портала, и «колонку не
      // заполнили» не означает «синонимов нет». Убрать лишний синоним можно и так — перечислив
      // в ячейке остальные.
      set: (m, text) => {
        if (text.trim() !== '') m.synonyms = parseList(text);
      },
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка о контрагенте. Единственная колонка, где пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      // Пометка ничего не идентифицирует и ни на что не ссылается, а убрать её человеку больше
      // нечем: сказать «сотри» в файле можно только пустой ячейкой. Данные так себя не ведут —
      // там пусто означает «источник об этом не знает».
      set: (m, text) => {
        m.comment = text.trim();
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» убирает контрагента из выбора; заведённые заявки и учётные записи остаются.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Контрагенты — генподрядчики, подрядчики, операторы вывоза мусора, арендодатели техники и поставщики.',
    'Ключ строки — ИНН: им контрагент и опознаётся, поэтому проверяется он контрольной суммой, а не только длиной.',
    'Тип заведённой записи файлом не меняется: от него зависят права учётных записей, склады и позиции прайса — это решение принимают в карточке.',
    'Удалённые контрагенты в файл не попадают: они в архиве, и возвращают их восстановлением, а не загрузкой.',
  ],
  load: () =>
    db
      .select()
      .from(counterparties)
      .where(isNull(counterparties.deletedAt))
      .orderBy(counterparties.name),
  id: (row) => row.id,
  model: (row, env) => ({
    type: row.type,
    name: row.name,
    inn: row.inn,
    synonyms: env.synonymsById.get(row.id) ?? [],
    comment: row.comment,
    isActive: row.isActive,
  }),
  blank: () => ({ type: '', name: '', inn: '', synonyms: [], comment: '', isActive: true }),
  keyOf: (m) => m.inn,
  titleOf: (m) => m.name || m.inn,
  check: (m, ctx, env) => {
    if (m.inn === '') ctx.fail('строка без ИНН не заводится: им контрагент и опознаётся');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
    if (m.type === '') {
      ctx.fail(
        'строка без типа не заводится: неизвестно, оператор это, поставщик или арендодатель',
      );
    }
    const stored = env.storedByInn.get(m.inn);
    if (!stored) return;
    // Смена типа переписала бы права учётных записей контрагента (ADR 0038) и оставила бы без
    // хозяина его склады, позиции прайса и предложения аренды. В карточке она поэтому и обвешана
    // проверками; файлу, который правят пачкой, такое решение не по силам.
    if (m.type !== '' && m.type !== stored.type) {
      ctx.fail(
        `тип контрагента «${stored.name}» файлом не меняется: от него зависят права учётных записей, склады и прайс — смените его в карточке контрагента`,
      );
    }
    // Активность арендодателя доезжает до его предложений аренды каскадом (ADR 0018 §14–15):
    // деактивация гасит их, активация возвращает погашенные. Файл техники не касается, поэтому
    // переключение здесь либо упёрлось бы в ограничение базы, либо оставило бы парк выключенным.
    if (stored.type === 'vehicle_lessor' && m.isActive !== stored.isActive) {
      ctx.fail(
        `активность арендодателя «${stored.name}» файлом не переключается: вместе с ним гаснут и поднимаются его предложения аренды — это делают в карточке контрагента`,
      );
    }
  },
  create: async (tx, m, _env, actorUserId) => {
    // Тип здесь заведомо задан — строку без него завернул `check()`. В модели он всё же
    // необязателен: `blank()` иначе пришлось бы придумывать роль за человека.
    const type = m.type === '' ? undefined : m.type;
    const [row] = await tx
      .insert(counterparties)
      .values({
        type: type!,
        name: m.name,
        inn: m.inn,
        comment: m.comment,
        isActive: m.isActive,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })
      .returning({ id: counterparties.id });
    await replaceSynonyms(tx, row!.id, [], m.synonyms);
  },
  update: async (tx, row, m, env, actorUserId) => {
    // Тип в UPDATE не входит: строку, где он отличается от заведённого, `check()` уже отверг, а
    // лишняя запись того же значения ушла бы каскадом в денормализованный `vehicles.lessor_type`.
    await tx
      .update(counterparties)
      .set({
        name: m.name,
        inn: m.inn,
        comment: m.comment,
        isActive: m.isActive,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(counterparties.id, row.id));
    await replaceSynonyms(tx, row.id, env.synonymsById.get(row.id) ?? [], m.synonyms);
  },
});

// ── Склады поставщиков ──

interface WarehouseModel {
  /** Поставщик — ИНН: идентификатор человеку ничего не говорит, а ИНН стоит в договоре. */
  supplierInn: string;
  address: string;
  name: string;
  contactPerson: string;
  /** Десять цифр без кода страны, как во всём портале (ADR 0066). */
  contactPhone: string;
  comment: string;
  isActive: boolean;
}

interface WarehouseSupplier {
  id: string;
  name: string;
  type: CounterpartyType;
}

interface WarehouseEnv {
  /** Живые контрагенты по ИНН — все, а не только поставщики: иначе «не тот тип» не отличить от «нет такого». */
  byInn: Map<string, WarehouseSupplier>;
  innById: Map<string, string>;
}

const warehousesDirectory = directory<WarehouseRow, WarehouseModel, WarehouseEnv>({
  key: 'warehouses',
  env: async () => {
    const rows = await db
      .select({
        id: counterparties.id,
        inn: counterparties.inn,
        name: counterparties.name,
        type: counterparties.type,
      })
      .from(counterparties)
      .where(isNull(counterparties.deletedAt));
    return {
      byInn: new Map(rows.map((r) => [r.inn, { id: r.id, name: r.name, type: r.type }])),
      innById: new Map(rows.map((r) => [r.id, r.inn])),
    };
  },
  columns: () => [
    {
      header: 'Поставщик (ИНН)',
      width: 18,
      hint: 'ИНН контрагента типа «Поставщик» из справочника контрагентов. Вместе с адресом — ключ записи.',
      // Контрольная сумма здесь не проверяется намеренно: это ссылка, а не реквизит. Опечатка в
      // ней означает «поставщик не найден», и два сообщения об одной ошибке человеку не нужны.
      get: (m) => m.supplierInn,
      set: (m, text) => {
        const v = text.trim().replace(/\s/gu, '');
        if (v !== '') m.supplierInn = v;
      },
    },
    {
      header: 'Адрес',
      width: 56,
      hint: 'Адрес склада — им склад и опознаётся. Вместе с поставщиком образует ключ записи: второго склада по тому же адресу у поставщика не бывает.',
      get: (m) => m.address,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.address = v;
      },
    },
    {
      header: 'Название',
      width: 24,
      hint: 'Метка склада («Основной», «Склад №2») — как его называют между собой. Пустая ячейка метку стирает.',
      get: (m) => m.name,
      // Тот же довод, что у комментария контрагента: метка — пометка, а не данные. Она ничего не
      // идентифицирует (склад узнают по адресу), и убрать её человеку больше нечем.
      set: (m, text) => {
        m.name = text.trim();
      },
    },
    {
      header: 'Контактное лицо',
      width: 26,
      hint: 'Кто принимает машину на складе. Пустая ячейка заведённый контакт не стирает — его убирают в карточке склада.',
      get: (m) => m.contactPerson,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.contactPerson = v;
      },
    },
    {
      header: 'Телефон',
      width: 22,
      hint: 'Телефон склада в любом написании — портал сводит его к одному виду. «-» и «нет» номером не считаются.',
      // Наружу номер идёт человеческим написанием, а хранится десятью цифрами (ADR 0066): в файле
      // человек читает и правит «+7 (926) 123 45 67», а не «9261234567».
      get: (m) => formatPhone(m.contactPhone),
      set: (m, text, ctx) => {
        const v = text.trim();
        if (v === '') return;
        const local = normalizePhone(v);
        if (local === null) {
          ctx.fail(`Телефон — ${PHONE_FORMAT_MESSAGE}; получено «${v}»`);
          return;
        }
        m.contactPhone = local;
      },
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка о складе: пропуск, часы приёмки. Пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      set: (m, text) => {
        m.comment = text.trim();
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» — со складом сейчас не работают. Деактивация поставщика склады не гасит.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Склады поставщиков (ADR 0051) — адреса, по которым работают с поставщиком: забирают материалы или привозят их ему.',
    'Ключ строки — поставщик и адрес: второго склада по тому же адресу у одного поставщика не бывает.',
    'Поставщик указывается ИНН и обязан быть заведён контрагентом типа «Поставщик» — иначе строка не применяется.',
    'Метку и комментарий пустая ячейка стирает; остальные колонки пустой ячейкой не трогаются.',
  ],
  // Порядок выгрузки — по поставщику: склады читают списком «чьи они», а адрес внутри поставщика
  // это только уточняет.
  load: async () => {
    const rows = await db
      .select({ w: warehouses })
      .from(warehouses)
      .innerJoin(counterparties, eq(warehouses.supplierCounterpartyId, counterparties.id))
      .orderBy(counterparties.name, warehouses.address);
    return rows.map((r) => r.w);
  },
  id: (row) => row.id,
  model: (row, env) => ({
    supplierInn: env.innById.get(row.supplierCounterpartyId) ?? '',
    address: row.address,
    name: row.name,
    contactPerson: row.contactPerson,
    contactPhone: row.contactPhone,
    comment: row.comment,
    isActive: row.isActive,
  }),
  blank: () => ({
    supplierInn: '',
    address: '',
    name: '',
    contactPerson: '',
    contactPhone: '',
    comment: '',
    isActive: true,
  }),
  /**
   * Ключ — поставщик и адрес. Регистр и лишние пробелы в адресе снимаются, чтобы «Мытищи,  10» и
   * «мытищи, 10» не считались двумя складами; полную нормализацию адреса считает база той же
   * функцией, что и наименования контрагентов, — и если файл разойдётся с ней сильнее, строка
   * уйдёт в «заведём» и упрётся в уникальный индекс, а движок переведёт отказ в человеческий текст.
   */
  keyOf: (m) =>
    m.supplierInn === '' || m.address === ''
      ? ''
      : `${m.supplierInn} ${m.address.toLowerCase().replace(/\s+/gu, ' ')}`,
  titleOf: (m) => warehouseTitle(m),
  check: (m, ctx, env) => {
    if (m.address === '') ctx.fail('строка без адреса не заводится: адресом склад и опознаётся');
    if (m.supplierInn === '') {
      ctx.fail('строка без поставщика не заводится: склад существует только у поставщика');
      return;
    }
    const supplier = env.byInn.get(m.supplierInn);
    if (!supplier) {
      ctx.fail(
        `поставщик с ИНН «${m.supplierInn}» не найден — сначала загрузите справочник контрагентов`,
      );
      return;
    }
    // То же правило, что в карточке склада: тип контрагента и задаёт смысл строки (ADR 0051).
    if (supplier.type !== 'supplier') {
      ctx.fail(
        `контрагент «${supplier.name}» (ИНН ${m.supplierInn}) заведён как «${counterpartyTypeLabels[supplier.type]}» — склад заводится только у контрагента типа «Поставщик»`,
      );
    }
  },
  create: async (tx, m, env, actorUserId) => {
    // Поставщик здесь заведомо найден и заведомо поставщик: обе проверки сделал `check()`.
    const supplierId = env.byInn.get(m.supplierInn)?.id;
    await tx.insert(warehouses).values({
      supplierCounterpartyId: supplierId!,
      address: m.address,
      name: m.name,
      contactPerson: m.contactPerson,
      contactPhone: m.contactPhone,
      comment: m.comment,
      isActive: m.isActive,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  },
  update: async (tx, row, m, env, actorUserId) => {
    // Поставщика у склада можно сменить — это исправление ошибки ввода, а не переезд склада
    // (то же решение, что в карточке).
    const supplierId = env.byInn.get(m.supplierInn)?.id;
    await tx
      .update(warehouses)
      .set({
        supplierCounterpartyId: supplierId!,
        address: m.address,
        name: m.name,
        contactPerson: m.contactPerson,
        contactPhone: m.contactPhone,
        comment: m.comment,
        isActive: m.isActive,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(warehouses.id, row.id));
  },
});

// ── Организации-владельцы транспорта ──

type OrganizationRow = typeof organizations.$inferSelect;

interface OrganizationModel {
  name: string;
  inn: string;
  address: string;
  phone: string;
  okpo: string;
  ogrn: string;
  isPrimary: boolean;
  isActive: boolean;
  comment: string;
}

const organizationsDirectory = directory<OrganizationRow, OrganizationModel, NoEnv>({
  key: 'organizations',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Наименование',
      width: 44,
      hint: 'Как юрлицо называется в шапке путевого листа: «АО «Служба механизации»».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'ИНН',
      width: 16,
      hint: 'Ключ записи; у организации без ИНН ключом становится наименование. Проверяется контрольной суммой.',
      get: (m) => m.inn,
      set: (m, text, ctx) => {
        const v = parseInn(text, ctx, 'ИНН');
        if (v !== undefined) m.inn = v;
      },
    },
    {
      header: 'Адрес',
      width: 56,
      hint: 'Адрес из шапки бланка. Пустая ячейка заведённый адрес не стирает.',
      get: (m) => m.address,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.address = v;
      },
    },
    {
      header: 'Телефон',
      width: 26,
      hint: 'Телефон шапки бланка — как его печатают в документе; в реквизите бухгалтерии бывает и не один номер.',
      // Единственный телефон портала, который не сводится к десяти цифрам: в шапке бланка стоит
      // то, что дала бухгалтерия («(495) …, +7-985-…»), нормализация (ADR 0066, миграция 0095)
      // такие записи не тронула, и печатаются они как заведены.
      get: (m) => m.phone,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.phone = v;
      },
    },
    {
      header: 'ОКПО',
      width: 14,
      hint: 'Код из правого верхнего угла бланка: 8 или 10 цифр. Пусто — реквизит не заведён, лист печатается и без него.',
      get: (m) => m.okpo,
      set: (m, text, ctx) => {
        const v = parseDigits(text, ctx, 'ОКПО', [8, 10]);
        if (v !== undefined) m.okpo = v;
      },
    },
    {
      header: 'ОГРН',
      width: 18,
      hint: 'Номер записи в реестре: 13 цифр у юрлица, 15 у ИП. Пусто — реквизит не заведён.',
      get: (m) => m.ogrn,
      set: (m, text, ctx) => {
        const v = parseDigits(text, ctx, 'ОГРН', [13, 15]);
        if (v !== undefined) m.ogrn = v;
      },
    },
    {
      header: 'Основная',
      width: 10,
      // Колонка справочная — без `set`. «Чьим именем подписан лист на машину, за которой юрлицо не
      // закреплено» — одно решение на весь портал, и такая организация ровно одна. Файл, где
      // признак стоит в каждой строке, а порядок применения строк случаен, переносил бы его
      // опечаткой в одной ячейке; переносят его отдельно, по руководству эксплуатации.
      hint: 'Ею подписан путевой лист на машину, за которой юрлицо не закреплено; такая ровно одна. Колонка только показывает признак — загрузка его не переносит.',
      get: (m) => boolCell(m.isPrimary),
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» убирает организацию из выбора; выданные листы остаются с теми реквизитами, с какими напечатаны.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка об организации. Пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      set: (m, text) => {
        m.comment = text.trim();
      },
    },
  ],
  help: () => [
    'Организации-владельцы транспорта (ADR 0037) — свои юрлица, от чьего имени выписывается путевой лист: реквизиты его шапки.',
    'Ключ строки — ИНН; у организации без ИНН ключом становится наименование.',
    'Правка меняет шапку будущих листов: выданные печатаются из собственного снимка и задним числом не переписываются.',
    'Признак «Основная» колонка только показывает: чем подписан лист на машину без своего юрлица — одно решение на портал, и загрузка его не переносит.',
  ],
  load: () => db.select().from(organizations).orderBy(organizations.name),
  id: (row) => row.id,
  model: (row) => ({
    name: row.name,
    inn: row.inn,
    address: row.address,
    phone: row.phone,
    okpo: row.okpo,
    ogrn: row.ogrn,
    isPrimary: row.isPrimary,
    isActive: row.isActive,
    comment: row.comment,
  }),
  blank: () => ({
    name: '',
    inn: '',
    address: '',
    phone: '',
    okpo: '',
    ogrn: '',
    isPrimary: false,
    isActive: true,
    comment: '',
  }),
  // Ключ помечен, чем он является: организация с наименованием из одних цифр иначе совпала бы с
  // чужим ИНН, и файл переписал бы не ту запись.
  keyOf: (m) =>
    m.inn !== '' ? `инн ${m.inn}` : m.name === '' ? '' : `наименование ${m.name.toLowerCase()}`,
  titleOf: (m) => m.name || m.inn,
  check: (m, ctx) => {
    if (m.name === '') {
      ctx.fail('строка без наименования не заводится: им организация и подписывает путевой лист');
    }
  },
  create: async (tx, m, _env, actorUserId) => {
    await tx.insert(organizations).values({
      name: m.name,
      inn: m.inn,
      address: m.address,
      phone: m.phone,
      okpo: m.okpo,
      ogrn: m.ogrn,
      isActive: m.isActive,
      comment: m.comment,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  },
  update: async (tx, row, m, _env, actorUserId) => {
    // `isPrimary` в UPDATE не входит: признак основной организации файлом не переносится.
    await tx
      .update(organizations)
      .set({
        name: m.name,
        inn: m.inn,
        address: m.address,
        phone: m.phone,
        okpo: m.okpo,
        ogrn: m.ogrn,
        isActive: m.isActive,
        comment: m.comment,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, row.id));
  },
});

/**
 * Организационные справочники обмена (ADR 0073): объекты, отделы, контрагенты, склады,
 * организации-владельцы транспорта. Порядок здесь не важен — список показа собирает реестр по
 * `DIRECTORY_KEYS`, — но перечислены они в том же порядке: связанное после того, на что ссылается.
 */
export const organizationalDirectories: AnyDirectory[] = [
  objectsDirectory,
  departmentsDirectory,
  counterpartiesDirectory,
  warehousesDirectory,
  organizationsDirectory,
];
