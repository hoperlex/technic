import { eq, isNull } from 'drizzle-orm';
import { officeEquipmentTitle } from '@technic/contracts';
import { db } from '../../../db/client';
import {
  constructionObjects,
  departments,
  officeEquipment,
  officeEquipmentTypes,
  type OfficeEquipmentRow,
  type OfficeEquipmentTypeRow,
} from '../../../db/schema';
import { boolCell, dateCell, intCell, parseBool, parseDate, parseInt10 } from '../cells';
import { directory, type AnyDirectory, type RowContext } from '../types';

/**
 * Справочники оргтехники в обмене файлом (ADR 0073, ADR 0085): перечень типов и сами единицы.
 *
 * Два описания в одном файле потому, что единица ссылается на тип кодом: правило этой ссылки
 * обязано стоять рядом с колонкой, которая код печатает, — иначе «код типа» в одном месте окажется
 * наименованием, а в другом идентификатором.
 *
 * Ничего своего файл не изобретает: он повторяет то, чем уже живут маршруты справочника
 * (`routes/office-equipment.ts`, `routes/office-equipment-types.ts`), схемы контрактов и
 * ограничения таблиц. Хотя бы один номер (CHECK `office_equipment_identity_check`), уникальность
 * номеров среди неудалённых карточек (частичные индексы по `upper(btrim(...))`), формат кода типа —
 * всё это проверяется здесь заново и человеческими словами: база на ту же ошибку отвечает именем
 * ограничения, по которому непонятно, какую из одиннадцати колонок строки править, и отменяет весь
 * файл вместо одной строки.
 *
 * Обязательность полей живёт в `check()`, а не в разборе ячейки (приём `defs/org.ts`): колонки в
 * файле может не быть вовсе — человек вправе удалить то, чего не правит, — и тогда `set` не
 * вызовется ни разу, а новая строка молча завелась бы без модели и без объекта.
 */

/** Пределы длины — те же, что в схемах контрактов: файл не заводит непроходимого формой. */
const NAME_MAX = 255;
const CODE_MAX = 50;
const NUMBER_MAX = 100;
const LOCATION_MAX = 255;
const COMMENT_MAX = 2000;
/** Порядок сортировки — как в форме типа: больше четырёх знаков это уже не порядок, а опечатка. */
const SORT_ORDER_MAX = 9999;

/** Формат кода типа — тот же, что в `createOfficeEquipmentTypeSchema`; сказать о нём больше некому. */
const TYPE_CODE = /^[a-z0-9_]{2,}$/u;

/**
 * Предел длины колонки. В базе его нет: колонки текстовые, и вставить в них можно роман, а форма
 * справочника длину ограничивает — файл, обходящий форму, обязан ограничивать тоже.
 */
function tooLong(value: string, ctx: RowContext, label: string, max: number): boolean {
  if (value.length <= max) return false;
  ctx.fail(`${label} — не длиннее ${max} знаков, получено ${value.length}`);
  return true;
}

/** Текст с пределом длины. `undefined` — ячейка пуста или негодна: заведённое значение не трогаем. */
function parseText(text: string, ctx: RowContext, label: string, max: number): string | undefined {
  const v = text.trim();
  if (v === '' || tooLong(v, ctx, label, max)) return undefined;
  return v;
}

/**
 * Номер так, как его сравнивают частичные уникальные индексы: `upper(btrim(...))`. Внутренние
 * пробелы не трогаются — индекс их тоже не трогает, и «SN 12 34» с «SN 1234» база считает разными
 * номерами. Расходиться с ней здесь нельзя: файл ищет строку этим ключом, а записывает база.
 */
function numberKey(text: string): string {
  return text.trim().toUpperCase();
}

// ── Типы оргтехники ───────────────────────────────────────────────────────────────────────────

/** Строка перечня типов глазами человека: МФУ, принтер, ноутбук. */
interface EquipmentTypeModel {
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

const officeEquipmentTypesDirectory = directory<
  OfficeEquipmentTypeRow,
  EquipmentTypeModel,
  Record<string, never>
>({
  key: 'office-equipment-types',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      width: 18,
      hint: 'Ключ записи: латиница строчными, цифры и подчёркивание, не короче двух знаков (mfp, laptop). По нему тип находит файл оргтехники.',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Код', CODE_MAX);
        if (v === undefined) return;
        // Регистр приводится, потому что формат кода задан схемой формы: прописных в справочнике
        // не бывает, и переименовать этим заведённую строку нельзя.
        const code = v.toLowerCase();
        if (!TYPE_CODE.test(code)) {
          ctx.fail(
            `Код — латинские строчные буквы, цифры и подчёркивание, не короче двух знаков; получено «${v}»`,
          );
          return;
        }
        m.code = code;
      },
    },
    {
      header: 'Наименование',
      width: 30,
      hint: 'Как тип называют в разговоре и в выпадающем списке: «МФУ», «Системный блок».',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', NAME_MAX);
        if (v !== undefined) m.name = v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше строка в выпадающем списке: МФУ и принтер должны стоять выше «Прочего», а алфавит поставил бы их как придётся.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок', { min: 0, max: SORT_ORDER_MAX });
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» — тип остаётся у заведённых карточек, но новую единицу на него уже не заведёшь. Удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Типы оргтехники — перечень «что это»: МФУ, принтер, сканер, ноутбук, монитор. На них ссылаются карточки единиц.',
    'Ключ строки — код: строка с известным кодом обновляет запись, с новым — заводит новую.',
    'Загрузка заводит новые типы и правит заведённые. Удаления нет: лишний тип гасят колонкой «Активен» — на него ссылаются заведённые карточки, в том числе из архива.',
    'Порядок в списке задают числом: перечень короткий, и алфавит в нём читается хуже, чем «сначала то, что чинят чаще».',
  ],
  load: () =>
    db
      .select()
      .from(officeEquipmentTypes)
      .orderBy(officeEquipmentTypes.sortOrder, officeEquipmentTypes.code),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  // Умолчания те же, что у колонок в базе: строка, дописанная человеком, заводится так же, как
  // заведённая окном перечня.
  blank: () => ({ code: '', name: '', sortOrder: 100, isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
  },
  create: async (tx, m) => {
    await tx.insert(officeEquipmentTypes).values({
      code: m.code,
      name: m.name,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(officeEquipmentTypes)
      .set({
        code: m.code,
        name: m.name,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(officeEquipmentTypes.id, row.id));
  },
});

// ── Оргтехника ────────────────────────────────────────────────────────────────────────────────

/**
 * Карточка единицы глазами человека: ссылки — кодами, даты — текстом «ДД.ММ.ГГГГ».
 *
 * Даты хранятся здесь в виде «ГГГГ-ММ-ДД», как их отдаёт и принимает база; в ячейку их переводит
 * `dateCell`. Пустая строка — «не заведена»: у покупки и гарантии это законное состояние.
 */
interface EquipmentModel {
  typeCode: string;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  objectCode: string;
  /** Код отдела-владельца; пустая строка — единица ни за кем не закреплена. */
  departmentCode: string;
  location: string;
  purchasedOn: string;
  warrantyUntil: string;
  comment: string;
  isActive: boolean;
  /**
   * Идентификатор заведённой карточки. Нужен одной проверке — «номер занят»: без него карточка,
   * пришедшая в файле со своим же номером, сообщала бы человеку, что он занят ею самой. У новой
   * строки его нет, и это ровно то же различие, что делает `assertNumbersFree` своим `exceptId`.
   */
  savedId?: string;
}

/** Живая карточка, держащая номер: чем она называется человеку и чтобы отличить её от себя самой. */
interface NumberOwner {
  id: string;
  title: string;
}

/**
 * Что нужно знать про остальной портал, чтобы разобрать строку оргтехники. Читается один раз на
 * файл — иначе на каждую строку пришлось бы по четыре запроса в базу.
 */
interface EquipmentEnv {
  /** Типы по коду; активность нужна предупреждению, а не отказу — см. `check()`. */
  types: Map<string, { id: string; name: string; isActive: boolean }>;
  typeCodeById: Map<string, string>;
  objectIdByCode: Map<string, string>;
  objectCodeById: Map<string, string>;
  departmentIdByCode: Map<string, string>;
  departmentCodeById: Map<string, string>;
  /** Номера неудалённых карточек — теми же ключами, какими их сравнивают частичные индексы. */
  bySerial: Map<string, NumberOwner>;
  byInventory: Map<string, NumberOwner>;
}

/**
 * Ссылки строки, разобранные в идентификаторы. Сюда строка доходит только после `check()`:
 * незнакомый код отменяет весь файл до записи. Промах словаря здесь — не ошибка человека, а
 * расхождение проверки и записи, и падать оно должно громко, а не тихой карточкой в справочнике.
 */
function equipmentValues(
  m: EquipmentModel,
  env: EquipmentEnv,
): typeof officeEquipment.$inferInsert {
  const type = env.types.get(m.typeCode);
  const objectId = env.objectIdByCode.get(m.objectCode);
  if (!type || objectId === undefined || m.name === '') {
    throw new Error('карточка оргтехники дошла до записи неразобранной');
  }
  return {
    equipmentTypeId: type.id,
    name: m.name,
    serialNumber: m.serialNumber,
    inventoryNumber: m.inventoryNumber,
    objectId,
    ownerDepartmentId:
      m.departmentCode === '' ? null : (env.departmentIdByCode.get(m.departmentCode) ?? null),
    location: m.location,
    // Пустая строка — не дата: у `date` в базе «не заведено» выражается NULL.
    purchasedOn: m.purchasedOn === '' ? null : m.purchasedOn,
    warrantyUntil: m.warrantyUntil === '' ? null : m.warrantyUntil,
    comment: m.comment,
    isActive: m.isActive,
  };
}

const officeEquipmentDirectory = directory<OfficeEquipmentRow, EquipmentModel, EquipmentEnv>({
  key: 'office-equipment',
  env: async () => {
    const [types, objects, departmentRows, live] = await Promise.all([
      db
        .select({
          id: officeEquipmentTypes.id,
          code: officeEquipmentTypes.code,
          name: officeEquipmentTypes.name,
          isActive: officeEquipmentTypes.isActive,
        })
        .from(officeEquipmentTypes),
      db
        .select({ id: constructionObjects.id, code: constructionObjects.code })
        .from(constructionObjects),
      db.select({ id: departments.id, code: departments.code }).from(departments),
      // Только неудалённые: номер держит живая карточка, тем же условием ограничены и сами индексы.
      db
        .select({
          id: officeEquipment.id,
          name: officeEquipment.name,
          serialNumber: officeEquipment.serialNumber,
          inventoryNumber: officeEquipment.inventoryNumber,
        })
        .from(officeEquipment)
        .where(isNull(officeEquipment.deletedAt)),
    ]);

    const bySerial = new Map<string, NumberOwner>();
    const byInventory = new Map<string, NumberOwner>();
    for (const row of live) {
      const owner = { id: row.id, title: officeEquipmentTitle(row) };
      if (row.serialNumber.trim() !== '') bySerial.set(numberKey(row.serialNumber), owner);
      if (row.inventoryNumber.trim() !== '') byInventory.set(numberKey(row.inventoryNumber), owner);
    }

    return {
      types: new Map(types.map((t) => [t.code, { id: t.id, name: t.name, isActive: t.isActive }])),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
      objectIdByCode: new Map(objects.map((o) => [o.code, o.id])),
      objectCodeById: new Map(objects.map((o) => [o.id, o.code])),
      departmentIdByCode: new Map(departmentRows.map((d) => [d.code, d.id])),
      departmentCodeById: new Map(departmentRows.map((d) => [d.id, d.code])),
      bySerial,
      byInventory,
    };
  },
  columns: () => [
    {
      header: 'Тип (код)',
      width: 16,
      hint: 'Код из справочника «Типы оргтехники» (mfp, laptop). Тип должен быть заведён заранее — файл оргтехники типов не заводит.',
      get: (m) => m.typeCode,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Тип (код)', CODE_MAX);
        // Регистр снимается по той же причине, что и в перечне типов: прописных кодов там не бывает.
        if (v !== undefined) m.typeCode = v.toLowerCase();
      },
    },
    {
      header: 'Модель',
      width: 30,
      hint: 'Наименование модели: «Kyocera ECOSYS M3145». Опознают единицу номерами, но выбирают её глазами по модели — колонка обязательная.',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Модель', NAME_MAX);
        if (v !== undefined) m.name = v;
      },
    },
    {
      header: 'Серийный номер',
      width: 24,
      hint: 'Номер производителя — им технику называет сервис. Уникален среди неудалённых карточек; регистр и крайние пробелы при сравнении не различаются. Пустая ячейка заведённый номер не стирает.',
      get: (m) => m.serialNumber,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Серийный номер', NUMBER_MAX);
        if (v !== undefined) m.serialNumber = v;
      },
    },
    {
      header: 'Инвентарный номер',
      width: 24,
      hint: 'Номер бухгалтерии. Ключ строки: по нему она и ищется в справочнике, а если его нет — по серийному. Уникален среди неудалённых карточек.',
      get: (m) => m.inventoryNumber,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Инвентарный номер', NUMBER_MAX);
        if (v !== undefined) m.inventoryNumber = v;
      },
    },
    {
      header: 'Объект (код)',
      width: 16,
      hint: 'Код объекта из справочника объектов — где единица стоит. Обязателен: площадка у техники есть всегда, а офис заводят таким же объектом.',
      // Регистр не снимается: код объекта — данные, а не идентификатор из латиницы, и «АЛ13» с
      // «ал13» справочник различает так же, как уникальный индекс в базе (тот же довод в `defs/org.ts`).
      get: (m) => m.objectCode,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Объект (код)', CODE_MAX);
        if (v !== undefined) m.objectCode = v;
      },
    },
    {
      header: 'Отдел-владелец (код)',
      width: 22,
      hint: 'Код отдела из справочника отделов — за кем числится единица. Пусто — не закреплена, и это рабочее состояние; снять заведённое закрепление файлом нельзя, это делают в карточке.',
      get: (m) => m.departmentCode,
      // Пустая ячейка владельца не снимает, хотя пустой владелец законен: от разметки зависит, чьи
      // это «заявки по нашей технике», и «в файле ячейку не заполнили» не должно означать того же,
      // что осознанное снятие в карточке (то же решение, что у площадки отдела).
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Отдел-владелец (код)', CODE_MAX);
        if (v !== undefined) m.departmentCode = v;
      },
    },
    {
      header: 'Место',
      width: 26,
      hint: 'Где именно внутри объекта: «кабинет 214», «прорабская». По этой подписи технику и ищут. Пустая ячейка заведённое место не стирает.',
      // Пусто здесь не значит «стереть»: место — данные о том, где аппарат стоит, а не пометка, и
      // выгрузка из учётной системы без этой графы не должна обезличивать весь парк.
      get: (m) => m.location,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Место', LOCATION_MAX);
        if (v !== undefined) m.location = v;
      },
    },
    {
      header: 'Дата покупки',
      width: 14,
      hint: 'Дата «ДД.ММ.ГГГГ». Пусто — не заведена; очистить заведённую дату файлом нельзя.',
      get: (m) => dateCell(m.purchasedOn),
      set: (m, text, ctx) => {
        const v = parseDate(text, ctx, 'Дата покупки');
        if (v !== undefined) m.purchasedOn = v;
      },
    },
    {
      header: 'Гарантия до',
      width: 14,
      hint: 'Последний день гарантии поставщика — он в неё входит. Гарантии на запчасти и работы живут в заявках на обслуживание и файлом не правятся.',
      get: (m) => dateCell(m.warrantyUntil),
      set: (m, text, ctx) => {
        const v = parseDate(text, ctx, 'Гарантия до');
        if (v !== undefined) m.warrantyUntil = v;
      },
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка о единице. Пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      // Пометка ничего не идентифицирует и ни на что не ссылается, а убрать её человеку больше
      // нечем: сказать «сотри» в файле можно только пустой ячейкой.
      set: (m, text, ctx) => {
        const v = text.trim();
        if (!tooLong(v, ctx, 'Комментарий', COMMENT_MAX)) m.comment = v;
      },
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» убирает единицу из выбора в заявке на обслуживание; заведённые заявки остаются. Удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Оргтехника (ADR 0085) — что стоит по кабинетам и площадкам: МФУ, ноутбуки, мониторы. На единицу ссылаются заявки на обслуживание.',
    'Хотя бы один номер обязателен — серийный или инвентарный: им технику опознают при приёмке из ремонта, и «МФУ без номеров» в акте ничем не отличается от соседнего такого же.',
    'Ключ строки — инвентарный номер, а если его нет — серийный. Поправить номер, входящий в ключ, можно только вместе с заполненной колонкой «Идентификатор»: иначе строка заведёт вторую карточку рядом с прежней.',
    'Номера уникальны среди неудалённых карточек и сравниваются без регистра и крайних пробелов: один «инв. 0012345» на весь портал.',
    'Ссылки — кодами: тип оргтехники, объект и отдел-владелец должны быть заведены заранее. Порядок загрузки: объекты → отделы → типы оргтехники → оргтехника.',
    'Удаления файлом нет: строку гасят колонкой «Активна», а в архив её убирают из карточки. Удалённая техника в файл не попадает — её восстанавливают из архива, а не загрузкой.',
  ],
  load: () =>
    db
      .select()
      .from(officeEquipment)
      .where(isNull(officeEquipment.deletedAt))
      .orderBy(officeEquipment.inventoryNumber, officeEquipment.serialNumber, officeEquipment.name),
  id: (row) => row.id,
  model: (row, env) => ({
    typeCode: env.typeCodeById.get(row.equipmentTypeId) ?? '',
    name: row.name,
    serialNumber: row.serialNumber,
    inventoryNumber: row.inventoryNumber,
    objectCode: env.objectCodeById.get(row.objectId) ?? '',
    departmentCode:
      row.ownerDepartmentId === null
        ? ''
        : (env.departmentCodeById.get(row.ownerDepartmentId) ?? ''),
    location: row.location,
    purchasedOn: row.purchasedOn ?? '',
    warrantyUntil: row.warrantyUntil ?? '',
    comment: row.comment,
    isActive: row.isActive,
    savedId: row.id,
  }),
  blank: () => ({
    typeCode: '',
    name: '',
    serialNumber: '',
    inventoryNumber: '',
    objectCode: '',
    departmentCode: '',
    location: '',
    purchasedOn: '',
    warrantyUntil: '',
    comment: '',
    isActive: true,
  }),
  /**
   * Ключ — инвентарный номер, а без него серийный, и оба помечены тем, чем они являются: номера
   * живут в разных пространствах имён, и инвентарный «0012345» одной карточки иначе совпал бы
   * ключом с серийным «0012345» другой.
   *
   * Инвентарный впереди не по старшинству, а по порядку наполнения: парк грузят из бухгалтерской
   * ведомости, где инвентарный есть у всех, а серийные сервис дописывает потом. Считай ключом
   * серийный — дописанная колонка превратила бы весь файл в новые карточки.
   */
  keyOf: (m) => {
    const inventory = numberKey(m.inventoryNumber);
    if (inventory !== '') return `инв ${inventory}`;
    const serial = numberKey(m.serialNumber);
    return serial === '' ? '' : `sn ${serial}`;
  },
  titleOf: (m) => officeEquipmentTitle(m) || m.typeCode,
  check: (m, ctx, env) => {
    if (m.typeCode === '') {
      ctx.fail('строка без кода типа не заводится: тип есть у каждой единицы');
    } else {
      const type = env.types.get(m.typeCode);
      if (!type) {
        ctx.fail(
          `тип оргтехники «${m.typeCode}» не найден — сначала загрузите справочник типов оргтехники`,
        );
      } else if (!type.isActive) {
        // Замечание, а не отказ: неактивный тип остаётся у заведённых карточек (это и значит
        // «выключен»), и отказ отменял бы файл на строках, которых никто не менял.
        ctx.warn(`тип «${type.name}» погашен — новой технике его в портале уже не выбрать`);
      }
    }

    if (m.name === '') {
      ctx.fail('строка без модели не заводится: по ней технику и выбирают в заявке');
    }

    if (m.objectCode === '') {
      ctx.fail('строка без объекта не заводится: техника всегда где-то стоит');
    } else if (!env.objectIdByCode.has(m.objectCode)) {
      ctx.fail(`объект «${m.objectCode}» не найден — сначала загрузите справочник объектов`);
    }

    if (m.departmentCode !== '' && !env.departmentIdByCode.has(m.departmentCode)) {
      ctx.fail(`отдел «${m.departmentCode}» не найден — сначала загрузите справочник отделов`);
    }

    // CHECK `office_equipment_identity_check` — словами: единицу нужно чем-то опознать, когда её
    // привезут из ремонта.
    const serial = numberKey(m.serialNumber);
    const inventory = numberKey(m.inventoryNumber);
    if (serial === '' && inventory === '') {
      ctx.fail(
        'нужен хотя бы один номер — серийный или инвентарный: по нему единицу и опознают при приёмке из ремонта',
      );
    }

    // Частичные уникальные индексы среди неудалённых карточек. Проверяем до записи, потому что
    // отказ индекса отменил бы весь файл одной фразой про «совпадение по другому признаку», а
    // человеку нужно знать, какой именно номер занят и кем.
    const takenSerial = serial === '' ? undefined : env.bySerial.get(serial);
    if (takenSerial && takenSerial.id !== m.savedId) {
      ctx.fail(
        `серийный номер ${m.serialNumber.trim()} уже заведён карточкой «${takenSerial.title}»`,
      );
    }
    const takenInventory = inventory === '' ? undefined : env.byInventory.get(inventory);
    if (takenInventory && takenInventory.id !== m.savedId) {
      ctx.fail(
        `инвентарный номер ${m.inventoryNumber.trim()} уже заведён карточкой «${takenInventory.title}»`,
      );
    }

    // Замечание, а не отказ: порядок дат ничем в портале не закреплён, но гарантия, истёкшая до
    // покупки, — это почти всегда перепутанные местами колонки.
    if (m.purchasedOn !== '' && m.warrantyUntil !== '' && m.warrantyUntil < m.purchasedOn) {
      ctx.warn(
        `гарантия до ${dateCell(m.warrantyUntil)} кончается раньше покупки ${dateCell(m.purchasedOn)} — проверьте, не перепутаны ли колонки`,
      );
    }
  },
  create: async (tx, m, env, actorUserId) => {
    await tx.insert(officeEquipment).values({
      ...equipmentValues(m, env),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  },
  update: async (tx, row, m, env, actorUserId) => {
    await tx
      .update(officeEquipment)
      .set({ ...equipmentValues(m, env), updatedBy: actorUserId, updatedAt: new Date() })
      .where(eq(officeEquipment.id, row.id));
  },
});

/**
 * Справочники оргтехники (ADR 0073): перечень типов и сами единицы. Порядок — тот же, что в
 * `DIRECTORY_KEYS`: связанное идёт после того, на что ссылается.
 */
export const officeDirectories: AnyDirectory[] = [
  officeEquipmentTypesDirectory,
  officeEquipmentDirectory,
];
