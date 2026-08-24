import { and, count, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { officeEquipmentTitle } from '@technic/contracts';
import { db } from '../../../db/client';
import {
  constructionObjects,
  departments,
  officeEquipment,
  officeEquipmentConsumableModels,
  officeEquipmentConsumables,
  officeEquipmentModels,
  officeEquipmentTypes,
  type OfficeEquipmentRow,
  type OfficeEquipmentTypeRow,
} from '../../../db/schema';
import {
  boolCell,
  dateCell,
  intCell,
  listCell,
  parseBool,
  parseDate,
  parseInt10,
  parseList,
} from '../cells';
import { directory, type AnyDirectory, type RowContext, type Tx } from '../types';

/**
 * Справочники оргтехники в обмене файлом (ADR 0073, ADR 0085): перечень типов, модели аппаратов и
 * сами единицы.
 *
 * Три описания в одном файле потому, что они ссылаются друг на друга кодом и наименованием: правило
 * ссылки обязано стоять рядом с колонкой, которая её печатает, — иначе «код типа» в одном месте
 * окажется наименованием, а в другом идентификатором.
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
 *
 * Колонка «Модель» с миграции 0171 — ссылка на справочник моделей аппаратов, а не свободный текст
 * (план `docs/office-equipment-consumables-plan.md`, Р1): расходник подходит модели, и разнописание
 * в этой колонке ломает не одну карточку, а весь ответ на вопрос «чем заправить вот этот аппарат».
 * Незнакомая модель отвергает строку техники, а не заводится молча (см. `check()`), — и ровно
 * поэтому у моделей есть свой лист: без него партию новой техники нельзя было бы залить файлом,
 * пока каждую модель не заведут в портале руками. Такой двери до перехода на справочник не было, и
 * лист её возвращает.
 *
 * Порядок листов в обмене — тип → модель → техника: связанное идёт после того, на что ссылается.
 * Книга у каждого справочника своя (ADR 0073: лист «Данные» в файле один), поэтому «в один проход»
 * означает три загрузки подряд, а не три листа в одной книге; окружение читается на каждую
 * загрузку заново, и модель, заведённая вторым файлом, третьему уже видна.
 */

/** Пределы длины — те же, что в схемах контрактов: файл не заводит непроходимого формой. */
const NAME_MAX = 255;
/**
 * Нижний предел наименования модели — тот же, что в `createOfficeEquipmentModelSchema`. В базе его
 * нет (там только «не пусто»), но модель из одного знака не опознает никто, а форма справочника
 * такую не заводит: файл, обходящий форму, обязан требовать того же.
 */
const MODEL_NAME_MIN = 2;
/** Производитель — отдельная колонка справочника, предел тот же, что у наименования. */
const MANUFACTURER_MAX = 255;
/** Цвет позиции расходника — предел `consumableColorSchema`. */
const COLOR_MAX = 60;
/** Нижние пределы кода и наименования расходника — те же, что в форме карточки. */
const CONSUMABLE_CODE_MIN = 2;
const CONSUMABLE_NAME_MIN = 2;
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

/**
 * Разделитель составных ключей словарей. Нулевой байт: в `text` Postgres его не бывает вовсе, и
 * склеить им две части в чужой ключ нельзя — обычный «|» в наименовании модели встретиться может.
 */
const REF_SEP = String.fromCharCode(0);

/**
 * Ключ поиска модели — «тип карточки + написание, как оно встретилось». Пара, а не одно имя:
 * одинаково названные принтер и МФУ это разные модели, и разводит их тот же составной ключ, что
 * стоит в базе (`office_equipment_model_type_fk`).
 *
 * Сравнение здесь ТОЧНОЕ, по строке. Правило «по чему модель опознаётся» живёт в базе
 * (`office_equipment_model_key`, миграция 0171), и повторять его тут нельзя: `upper()` в Postgres и
 * `toUpperCase()` в JS расходятся по своей природе — `office_equipment_model_key('Straße 1')` и
 * `office_equipment_model_key('STRASSE 1')` РАЗНЫЕ, а в JS эти строки после `toUpperCase()`
 * совпадают. Копия правила, нормализующая сильнее оригинала, схлопнула бы две законные модели
 * справочника в один ключ словаря, и строка файла молча привязалась бы не к той — отказа при этом
 * не было бы вовсе. Точное равенство строк безопасно при любом правиле: одинаковые строки остаются
 * одинаковыми и после нормализации, какой бы она ни была.
 *
 * Всё, что точным совпадением не разрешилось, разбирает база — `resolveEquipmentModels()`.
 */
function modelRef(equipmentTypeId: string, name: string): string {
  return equipmentTypeId === '' || name === '' ? '' : `${equipmentTypeId}${REF_SEP}${name}`;
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

// ── Модели аппаратов ──────────────────────────────────────────────────────────────────────────

/**
 * Модель аппарата глазами человека: «Kyocera ECOSYS M3145» у типа `mfp`.
 *
 * «Аппарат» здесь — не карточка, а модель: карточек одной модели в парке шестьдесят восемь, и
 * расходник подходит всем им сразу (Р1). Поэтому у модели своя запись справочника, а `name`
 * карточки — её копия, которую держит триггер базы.
 */
interface ApparatusModel {
  typeCode: string;
  name: string;
  manufacturer: string;
  comment: string;
  isActive: boolean;
  /** Идентификатор заведённой модели: им «наименование занято» отличают от «занято мной же». */
  savedId?: string;
  /** Тип, под которым модель заведена сейчас: сменить его нельзя, и сказать об этом надо словами. */
  savedTypeCode?: string;
  /** Наименование, под которым модель заведена сейчас: по нему узнаётся переименование. */
  savedName?: string;
}

/** Что база ответила про присланное написание: по чему оно опознаётся и как будет записано. */
interface AskedName {
  key: string;
  spelling: string;
}

/**
 * Что нужно знать про портал, чтобы разобрать строку модели. Читается один раз на файл; ключи
 * присланных написаний дочитывает `resolveApparatusModels()` — тоже один раз на файл.
 */
interface ApparatusEnv {
  types: Map<string, { id: string; name: string; isActive: boolean }>;
  typeCodeById: Map<string, string>;
  /**
   * Ключ и свёрнутое написание — по присланной строке. Заполняется дважды: наименованиями
   * справочника при чтении окружения и присланными — ответом базы. Обе половины берут ответ у базы:
   * правило написания живёт в её функциях, и копии этого правила в TypeScript нет нигде (см.
   * `modelRef`).
   */
  askedKeys: Map<string, AskedName>;
  /** Кто уже занимает пару «тип + ключ». Ключи посчитаны базой при чтении окружения. */
  takenByKey: Map<string, { id: string; name: string }>;
  /** Сколько карточек у модели — включая архивные: переименование перепишет и их. */
  cardsByModelId: Map<string, number>;
  /**
   * Второе и последующие написания одной модели в одном файле: «Ricoh IM 350» строкой выше и
   * «RICOH IM 350» строкой ниже — это одна запись справочника, и завести её дважды нельзя.
   * Одинаковые написания ловит сам движок ключом строки, разные — только ключ базы.
   */
  twins: Map<string, string>;
}

/** Пара «тип + ключ написания» — то, чем справочник разводит модели (уникальный индекс 0171). */
function typeKeyRef(equipmentTypeId: string, key: string): string {
  return `${equipmentTypeId}${REF_SEP}${key}`;
}

/**
 * Догрузка ключей присланных наименований (`resolveRows` в `types.ts`). Спрашиваем только про то,
 * чего нет в справочнике дословно: файл, выгруженный порталом, приходит его же написаниями, и
 * запроса не будет вовсе.
 *
 * Ответ базы — три вещи сразу: ключ (по нему видно, занято ли наименование), свёрнутое написание (в
 * таком виде оно ляжет в справочник — `office_equipment_models_name_normalized_check`) и, из
 * сопоставления ключей между собой, близнецы внутри файла.
 */
async function resolveApparatusModels(
  models: readonly ApparatusModel[],
  env: ApparatusEnv,
): Promise<void> {
  const asked: string[] = [];
  for (const m of models) {
    // Пустое наименование — не вопрос к базе: про него скажет `check()`. А вот тип здесь НЕ
    // спрашивается намеренно: ключ зависит только от написания, зато строки разобраны начисто, и
    // тип у них виден лишь тогда, когда колонка «Тип (код)» в файле есть. Человек вправе её
    // удалить — он правит одно наименование, — и тип тогда придёт из заведённой записи уже в
    // `planRows`. Спроси мы только про строки с известным типом, у такой строки не оказалось бы
    // ключа к моменту проверок.
    if (m.name === '') continue;
    if (!env.askedKeys.has(m.name) && !asked.includes(m.name)) asked.push(m.name);
  }

  if (asked.length > 0) {
    const found = await db.execute<{ asked: string; key: string; spelling: string }>(sql`
      SELECT a.asked,
             office_equipment_model_key(a.asked)            AS key,
             office_equipment_model_name_normalize(a.asked) AS spelling
        FROM (VALUES ${sql.join(
          asked.map((name) => sql`(${name}::text)`),
          sql`, `,
        )}) AS a(asked)
    `);
    for (const row of found.rows) {
      env.askedKeys.set(row.asked, { key: row.key, spelling: row.spelling });
    }
  }

  // Близнецы: первое написание пары «тип + ключ» остаётся за строкой, которая его назвала, остальные
  // отвергаются словами. Порядок здесь — порядок строк файла, он же порядок разбора, поэтому
  // «первым» всегда оказывается тот, кто стоит в файле выше. Строки без видимого типа в счёт не
  // идут: они правят заведённую запись, а не заводят вторую, — и повтор у них ловит ключ строки.
  const firstSpelling = new Map<string, string>();
  for (const m of models) {
    const type = env.types.get(m.typeCode);
    const askedName = env.askedKeys.get(m.name);
    if (!type || !askedName) continue;
    const group = typeKeyRef(type.id, askedName.key);
    const first = firstSpelling.get(group);
    if (first === undefined) firstSpelling.set(group, askedName.spelling);
    else if (first !== askedName.spelling) env.twins.set(modelRef(m.typeCode, m.name), first);
  }
}

const officeEquipmentModelsDirectory = directory<
  {
    id: string;
    equipmentTypeId: string;
    name: string;
    manufacturer: string;
    comment: string;
    isActive: boolean;
  },
  ApparatusModel,
  ApparatusEnv
>({
  key: 'office-equipment-models',
  env: async () => {
    const [types, models, cards] = await Promise.all([
      db
        .select({
          id: officeEquipmentTypes.id,
          code: officeEquipmentTypes.code,
          name: officeEquipmentTypes.name,
          isActive: officeEquipmentTypes.isActive,
        })
        .from(officeEquipmentTypes),
      // Ключ считает база — тем же выражением, каким построен уникальный индекс справочника.
      db
        .select({
          id: officeEquipmentModels.id,
          equipmentTypeId: officeEquipmentModels.equipmentTypeId,
          name: officeEquipmentModels.name,
          key: sql<string>`office_equipment_model_key(${officeEquipmentModels.name})`,
        })
        .from(officeEquipmentModels),
      // Карточки считаются вместе с архивными: переименование раскладывается и по ним (Р3), и
      // предупреждение обязано называть настоящее число, а не число видимых.
      db
        .select({ modelId: officeEquipment.modelId, cards: count() })
        .from(officeEquipment)
        .groupBy(officeEquipment.modelId),
    ]);

    const askedKeys = new Map<string, AskedName>();
    const takenByKey = new Map<string, { id: string; name: string }>();
    for (const model of models) {
      // Написание справочника кладётся сразу и с ключом, посчитанным базой: на файле, выгруженном
      // порталом, догрузка не спросит её ни о чём.
      askedKeys.set(model.name, { key: model.key, spelling: model.name });
      takenByKey.set(typeKeyRef(model.equipmentTypeId, model.key), {
        id: model.id,
        name: model.name,
      });
    }

    const cardsByModelId = new Map<string, number>();
    for (const row of cards) {
      if (row.modelId !== null) cardsByModelId.set(row.modelId, row.cards);
    }

    return {
      types: new Map(types.map((t) => [t.code, { id: t.id, name: t.name, isActive: t.isActive }])),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
      askedKeys,
      takenByKey,
      cardsByModelId,
      twins: new Map(),
    };
  },
  columns: () => [
    {
      header: 'Тип (код)',
      width: 16,
      hint: 'Код из справочника «Типы оргтехники» (mfp, laptop). Тип задаётся при заведении и потом не меняется: на паре «тип + наименование» держится и уникальность модели, и связь с карточками.',
      get: (m) => m.typeCode,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Тип (код)', CODE_MAX);
        // Регистр снимается по той же причине, что в перечне типов: прописных кодов там не бывает.
        if (v !== undefined) m.typeCode = v.toLowerCase();
      },
    },
    {
      header: 'Наименование',
      width: 34,
      hint: 'Как модель называется: «Kyocera ECOSYS M3145». Это же написание стоит в колонке «Модель» у всех её карточек, поэтому правка наименования — переименование по всему парку, включая архивные карточки. Регистр и лишние пробелы при поиске не различаются: «RICOH IM 350» — та же модель, что «Ricoh IM 350», а не вторая.',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', NAME_MAX);
        if (v !== undefined) m.name = v;
      },
    },
    {
      header: 'Производитель',
      width: 22,
      hint: 'Ricoh, Kyocera, HP. Отдельной колонкой, потому что спрашивают о нём отдельно («все Ricoh»), а первым словом наименования его не вытащить: «HP LaserJet» и «Hewlett-Packard» первым словом не совпадают. Пустая ячейка заведённого производителя не стирает.',
      // Пусто здесь не значит «стереть»: производитель — данные, а выгрузка из учётной системы без
      // этой графы не должна обезличивать весь справочник (то же решение, что у места в карточке).
      get: (m) => m.manufacturer,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Производитель', MANUFACTURER_MAX);
        if (v !== undefined) m.manufacturer = v;
      },
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка о модели: чем заправляется, где ещё встречается. Пустая ячейка означает «стереть».',
      // Пометка ничего не идентифицирует и ни на что не ссылается, а убрать её человеку больше
      // нечем: сказать «сотри» в файле можно только пустой ячейкой.
      get: (m) => m.comment,
      set: (m, text, ctx) => {
        const v = text.trim();
        if (!tooLong(v, ctx, 'Комментарий', COMMENT_MAX)) m.comment = v;
      },
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» гасит модель: новой технике её уже не выбрать, у заведённых карточек и у расходников она остаётся. Удалить модель файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Модели аппаратов — то, чем аппарат является: «Kyocera ECOSYS M3145», «Ricoh Aficio MP 201SPF». К модели, а не к отдельной карточке, привязаны расходники: картридж подходит всем аппаратам модели сразу.',
    'Ключ строки — пара «тип + наименование»: одинаково названные принтер и МФУ это две разные модели. Регистр и лишние пробелы наименование не различают — «RICOH IM 350» и «Ricoh IM 350» одна модель, и завести её дважды нельзя.',
    'Загрузка заводит новые модели и правит заведённые. Порядок загрузки: типы оргтехники → модели аппаратов → оргтехника; модель, заведённую этим файлом, файл оргтехники уже видит.',
    'Наименование заведённой модели правится только строкой из выгрузки — той, где заполнена колонка «Идентификатор». Это переименование: новое написание уходит во все карточки модели, включая архивные, и в отчёте загрузки оно показано отдельным замечанием с числом карточек.',
    'Тип у заведённой модели не меняется: карточки связаны с моделью парой «модель + тип». Нужен другой тип — заведите модель заново и перецепите карточки в портале.',
    'Удаления файлом нет: лишнюю модель гасят колонкой «Активна». Совсем удалить можно только модель без карточек и без расходников — и только в портале.',
  ],
  load: () =>
    db
      .select({
        id: officeEquipmentModels.id,
        equipmentTypeId: officeEquipmentModels.equipmentTypeId,
        name: officeEquipmentModels.name,
        manufacturer: officeEquipmentModels.manufacturer,
        comment: officeEquipmentModels.comment,
        isActive: officeEquipmentModels.isActive,
      })
      .from(officeEquipmentModels)
      .innerJoin(
        officeEquipmentTypes,
        eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
      )
      .orderBy(
        officeEquipmentTypes.sortOrder,
        officeEquipmentTypes.code,
        officeEquipmentModels.name,
      ),
  id: (row) => row.id,
  model: (row, env) => {
    const typeCode = env.typeCodeById.get(row.equipmentTypeId) ?? '';
    return {
      typeCode,
      name: row.name,
      manufacturer: row.manufacturer,
      comment: row.comment,
      isActive: row.isActive,
      savedId: row.id,
      savedTypeCode: typeCode,
      savedName: row.name,
    };
  },
  blank: () => ({ typeCode: '', name: '', manufacturer: '', comment: '', isActive: true }),
  /**
   * Ключ строки — «тип + наименование», и сравнение в нём ТОЧНОЕ: правило написания живёт в базе, а
   * ключ строки движок считает до всякого запроса (`planRows`, первый проход). Своей копии правила
   * тут быть не должно (см. `modelRef`), поэтому строка, назвавшая ту же модель другим написанием,
   * ключом не совпадёт — её ловит `check()` ответом базы и отвергает словами, а не заводит второй
   * записью и не переименовывает парк молча.
   */
  keyOf: (m) => modelRef(m.typeCode, m.name),
  titleOf: (m) => m.name || m.typeCode,
  resolveRows: resolveApparatusModels,
  check: (m, ctx, env) => {
    const type = env.types.get(m.typeCode);
    if (m.typeCode === '') {
      ctx.fail('строка без кода типа не заводится: модель принадлежит типу');
    } else if (!type) {
      ctx.fail(
        `тип оргтехники «${m.typeCode}» не найден — сначала загрузите справочник типов оргтехники`,
      );
    } else if (!type.isActive) {
      // Замечание, а не отказ: погашенный тип остаётся у заведённых моделей и карточек, и отказ
      // отменял бы файл на строках, которых никто не менял.
      ctx.warn(`тип «${type.name}» погашен — новой модели его в портале уже не выбрать`);
    }

    // Тип неизменяем (Р1): карточки связаны с моделью парой «модель + тип», и составной ключ отбил
    // бы такую правку именем ограничения — уже после того, как файл начали применять.
    if (m.savedTypeCode !== undefined && m.typeCode !== '' && m.typeCode !== m.savedTypeCode) {
      ctx.fail(
        `тип модели не меняется: «${m.savedTypeCode}» → «${m.typeCode}». Заведите модель нужного типа и перецепите карточки — у заведённой модели тип остаётся навсегда`,
      );
      return;
    }

    if (m.name === '') {
      ctx.fail('строка без наименования не заводится: по нему модель и опознают');
      return;
    }
    if (m.name.length < MODEL_NAME_MIN) {
      ctx.fail(
        `наименование «${m.name}» короче ${MODEL_NAME_MIN} знаков — по такому модель не опознать`,
      );
      return;
    }
    if (!type) return;

    const askedName = env.askedKeys.get(m.name);
    if (!askedName) {
      // Ключа нет только там, где догрузка не состоялась вовсе, а `check()` зовут после неё.
      throw new Error('строка модели аппарата дошла до проверок без ключа написания');
    }

    const twin = env.twins.get(modelRef(m.typeCode, m.name));
    if (twin !== undefined) {
      ctx.fail(
        `в файле это та же модель, что и строка с написанием «${twin}»: регистр и лишние пробелы наименование не различают, и завести её дважды нельзя`,
      );
      return;
    }

    // Написание подменяется тем, каким его свернёт база: в справочнике оно хранится нормализованным
    // (`office_equipment_models_name_normalized_check`), и показать человеку в отчёте надо то, что
    // действительно запишется, а не текст ячейки с двойным пробелом.
    m.name = askedName.spelling;

    const taken = env.takenByKey.get(typeKeyRef(type.id, askedName.key));
    if (taken && taken.id !== m.savedId) {
      // Уникальный индекс сказал бы то же самое, но именем ограничения и уже на записи — отменив
      // весь файл. Здесь названо и кем занято, и что делать: правку написания заведённой модели
      // разрешает только строка из выгрузки, где стоит идентификатор. Иначе строка, набранная от
      // руки с другим регистром, молча переименовала бы модель во всём парке.
      ctx.fail(
        `наименование «${m.name}» уже занято моделью «${taken.name}» того же типа: чтобы поправить написание, правьте её строкой из выгрузки — в ней заполнена колонка «Идентификатор»`,
      );
      return;
    }

    if (m.savedName !== undefined && m.name !== m.savedName) {
      // Переименование разрешено — иначе лист не смог бы исправить и опечатку в справочнике, — но
      // молчаливым оно быть не должно: новое написание уходит зеркалом во все карточки модели,
      // включая архивные (Р3). Отчёт предпросмотра показывает и саму правку ячейки, и это
      // замечание с числом карточек, которые перепишутся.
      const cards = env.cardsByModelId.get(m.savedId ?? '') ?? 0;
      // Число отдельным хвостом, а не внутри фразы: склонять «карточку/карточки/карточек» ради
      // одного замечания значило бы завести здесь седьмую копию `plural` из портала.
      ctx.warn(
        `переименование «${m.savedName}» → «${m.name}» перепишет наименование во всех карточках модели, включая архивные; сейчас их: ${cards}`,
      );
    }
  },
  create: async (tx, m, env) => {
    const type = env.types.get(m.typeCode);
    if (!type || m.name === '') throw new Error('модель аппарата дошла до записи неразобранной');
    await tx.insert(officeEquipmentModels).values({
      equipmentTypeId: type.id,
      // Свёртку написания делает база и на записи тоже: правило её, а идемпотентность функции
      // означает, что второй проход по уже свёрнутому имени ничего не меняет. Так отказ проверки
      // `office_equipment_models_name_normalized_check` невозможен в принципе — а он был бы 500.
      name: sql`office_equipment_model_name_normalize(${m.name})`,
      manufacturer: m.manufacturer,
      comment: m.comment,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    if (m.name !== row.name) {
      // Порядок блокировок при переименовании задан планом (Р3) и обязателен: сначала таблица
      // карточек, потом сама модель. Переименование через `AFTER`-триггер идёт за строками
      // карточек, а правка карточки наоборот — от строки карточки к модели (`FOR KEY SHARE` в
      // зеркале). Без этой блокировки порядок захвата у двух транзакций встречный, и одна из них
      // умирает с `40P01` — с равной вероятностью и заливка файла, и правка оператора.
      await tx.execute(sql`LOCK TABLE office_equipment IN SHARE ROW EXCLUSIVE MODE`);
    }
    await tx
      .update(officeEquipmentModels)
      .set({
        name: sql`office_equipment_model_name_normalize(${m.name})`,
        manufacturer: m.manufacturer,
        comment: m.comment,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(officeEquipmentModels.id, row.id));
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
  /**
   * Наименование модели из справочника моделей аппаратов. Хранится текстом, потому что текстом оно
   * и стоит в файле; в идентификатор его переводит `check()` — там же, где неизвестное написание
   * становится отказом. После `check()` здесь лежит написание СПРАВОЧНИКА, а не ячейки: иначе
   * повторная загрузка выгруженного файла показывала бы правку регистра, которой никто не делал.
   */
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

/** Модель аппарата из справочника: ссылка, написание каноном и гашение. */
interface ModelRef {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * Что нужно знать про остальной портал, чтобы разобрать строку оргтехники. Читается один раз на
 * файл — иначе на каждую строку пришлось бы по четыре запроса в базу.
 */
interface EquipmentEnv {
  /** Типы по коду; активность нужна предупреждению, а не отказу — см. `check()`. */
  types: Map<string, { id: string; name: string; isActive: boolean }>;
  typeCodeById: Map<string, string>;
  /**
   * Модели по паре «тип + написание». Наполняется дважды: справочными написаниями — при чтении
   * окружения, присланными — ответом базы в `resolveEquipmentModels()`. Обе половины кладут строку
   * ровно так, как она пишется; ключ по ней никто не считает.
   */
  models: Map<string, ModelRef>;
  /** Имя модели по ссылке: им печатается колонка «Модель» на выгрузке. */
  modelNameById: Map<string, string>;
  /**
   * У каких типов нашлась модель с присланным написанием. Заполняет только ответ базы — это её
   * правило, а не наше. Нужно одному сообщению: «модель есть, но не у этого типа». Составной ключ
   * отбил бы такую строку именем ограничения, а человеку надо знать, что менять — тип карточки или
   * колонку модели.
   */
  modelTypesByName: Map<string, string[]>;
  objectIdByCode: Map<string, string>;
  objectCodeById: Map<string, string>;
  departmentIdByCode: Map<string, string>;
  departmentCodeById: Map<string, string>;
  /** Номера неудалённых карточек — теми же ключами, какими их сравнивают частичные индексы. */
  bySerial: Map<string, NumberOwner>;
  byInventory: Map<string, NumberOwner>;
}

/**
 * Модель по типу карточки и написанию из ячейки. Ищут её дважды — в `check()`, чтобы объяснить, и
 * в записи, чтобы проставить ссылку, — и обе стороны обязаны искать одинаково (приём `defs/vehicles.ts`).
 */
function findModel(equipmentTypeId: string, name: string, env: EquipmentEnv): ModelRef | undefined {
  const ref = modelRef(equipmentTypeId, name);
  return ref === '' ? undefined : env.models.get(ref);
}

/** Строка ответа базы. Псевдоним, а не `interface`: `db.execute` требует индексную сигнатуру. */
type ResolvedModelRow = {
  asked: string;
  id: string;
  name: string;
  equipment_type_id: string;
  type_code: string;
  is_active: boolean;
};

/**
 * Догрузка моделей по присланным написаниям (`resolveRows` в `types.ts`): ключи считает база, и
 * только она. Правило опознания — `office_equipment_model_key`, IMMUTABLE-функция Postgres; её
 * копия в TypeScript расходилась бы с оригиналом молча и в опасную сторону (см. `modelRef`).
 *
 * Спрашиваем только о том, чего не решило точное совпадение со справочником. Файл, выгруженный
 * порталом, приходит справочными написаниями — на нём запроса не будет вовсе; спросить придётся про
 * то, что человек набрал руками, а таких написаний в файле десятки, а не сотни. Запрос при этом
 * один на файл: построчный обошёлся бы в сотни обращений.
 *
 * Ответ кладётся в словарь КАК ЕСТЬ — по присланному написанию, а не по вычисленному ключу. Отсюда
 * же и определённость там, где два присланных написания оказались одной моделью (в справочнике
 * такого быть не может — не даст уникальный индекс, — а в файле две строки вполне могут отличаться
 * пробелами): каждое написание спрошено отдельно и получило один и тот же ответ, обе строки
 * привяжутся к одной модели. Это не ошибка, а тот же ответ, который дал бы триггер базы.
 */
async function resolveEquipmentModels(
  models: readonly EquipmentModel[],
  env: EquipmentEnv,
): Promise<void> {
  const asked = new Set<string>();
  for (const m of models) {
    const type = env.types.get(m.typeCode);
    // Незнакомый тип и пустая ячейка — не вопрос к базе: про них `check()` скажет своими словами.
    if (!type || m.name === '') continue;
    if (!env.models.has(modelRef(type.id, m.name))) asked.add(m.name);
  }
  if (asked.size === 0) return;

  // Соединение идёт по ВСЕМ типам сразу, а не только по типу строки: «модель есть, но у другого
  // типа» — половина сообщения об отказе, и вторым запросом за ней ходить незачем.
  //
  // `ORDER BY` не украшение: без него порядок строк ответа не определён, и перечень типов в
  // сообщении менялся бы от запуска к запуску.
  const found = await db.execute<ResolvedModelRow>(sql`
    SELECT a.asked, m.id, m.name, m.equipment_type_id, m.is_active, t.code AS type_code
      FROM (VALUES ${sql.join(
        [...asked].map((name) => sql`(${name}::text)`),
        sql`, `,
      )}) AS a(asked)
      JOIN office_equipment_models m
        ON office_equipment_model_key(m.name) = office_equipment_model_key(a.asked)
      JOIN office_equipment_types t ON t.id = m.equipment_type_id
     ORDER BY a.asked, t.code
  `);

  for (const row of found.rows) {
    env.models.set(modelRef(row.equipment_type_id, row.asked), {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
    });
    const codes = env.modelTypesByName.get(row.asked);
    if (codes) codes.push(row.type_code);
    else env.modelTypesByName.set(row.asked, [row.type_code]);
  }
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
  const model = type === undefined ? undefined : findModel(type.id, m.name, env);
  if (!type || objectId === undefined || !model) {
    throw new Error('карточка оргтехники дошла до записи неразобранной');
  }
  return {
    equipmentTypeId: type.id,
    modelId: model.id,
    // Имя пишется рядом со ссылкой и написанием СПРАВОЧНИКА, а не ячейки. Рядом — потому что
    // колонка `NOT NULL` без умолчания; написанием справочника — потому что при неизменной ссылке и
    // другом написании `office_equipment_model_mirror` ушёл бы в legacy-ветку и стал бы искать
    // модель по тексту ячейки заново, хотя её уже нашли здесь. Что бы туда ни попало, база всё
    // равно перепишет `name` из модели: с миграции 0171 это зеркало, а не вводимое поле (Р3).
    name: model.name,
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
    const [types, models, objects, departmentRows, live] = await Promise.all([
      db
        .select({
          id: officeEquipmentTypes.id,
          code: officeEquipmentTypes.code,
          name: officeEquipmentTypes.name,
          isActive: officeEquipmentTypes.isActive,
        })
        .from(officeEquipmentTypes),
      // Справочник моделей целиком, включая погашенные: они остаются у заведённых карточек, и файл,
      // который их не видит, отверг бы строку, которую никто не менял. Тип берётся ссылкой, а не
      // соединением с типами: коды типов в этом же окружении уже есть.
      db
        .select({
          id: officeEquipmentModels.id,
          equipmentTypeId: officeEquipmentModels.equipmentTypeId,
          name: officeEquipmentModels.name,
          isActive: officeEquipmentModels.isActive,
        })
        .from(officeEquipmentModels),
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

    const modelsByRef = new Map<string, ModelRef>();
    const modelNameById = new Map<string, string>();
    for (const model of models) {
      // Справочное написание кладётся сразу: с ним приходит файл, выгруженный порталом, и на таком
      // файле догрузка не спросит базу ни о чём. Двух одинаковых ключей здесь быть не может —
      // уникальный индекс не даст завести в одном типе два написания даже с разным регистром,
      // а точное совпадение строк тем более.
      modelsByRef.set(modelRef(model.equipmentTypeId, model.name), {
        id: model.id,
        name: model.name,
        isActive: model.isActive,
      });
      modelNameById.set(model.id, model.name);
    }

    return {
      types: new Map(types.map((t) => [t.code, { id: t.id, name: t.name, isActive: t.isActive }])),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
      models: modelsByRef,
      modelNameById,
      // Пустым: заполнять его написаниями справочника незачем — сообщение про чужой тип нужно
      // ровно там, где точное совпадение не сработало, а это случай догрузки.
      modelTypesByName: new Map(),
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
      hint: 'Наименование из справочника моделей аппаратов: «Kyocera ECOSYS M3145». Модель должна быть заведена заранее — этим же обменом, листом «Модели аппаратов», или в портале; файл техники моделей не заводит. Регистр и лишние пробелы при поиске не различаются, а написание встанет то, что в справочнике. Колонка обязательная.',
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
    'Ссылки — кодами: тип оргтехники, объект и отдел-владелец должны быть заведены заранее. Порядок загрузки: объекты → отделы → типы оргтехники → модели аппаратов → оргтехника.',
    'Модель — наименованием из справочника моделей аппаратов, и модель должна быть того же типа, что и карточка: расходники привязаны к модели, а не к отдельному аппарату.',
    'Незнакомая модель отвергает строку, а не заводится сама: в файле сотни строк, и опечатка в одной ячейке иначе завела бы в справочнике вторую «Ricon» рядом с «Ricoh» — найти её потом некому. Новые модели заводят листом «Модели аппаратов» — его грузят перед этим файлом — или окном справочника в портале.',
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
    // Имя берётся у модели по ссылке, а не из `name` карточки, хотя сегодня это одна и та же
    // строка — зеркало держит триггер (Р3). Через ссылку потому, что словарь моделей окружению всё
    // равно нужен для заливки: лишнего запроса нет, а читателем зеркала эта колонка быть перестаёт
    // — снятие `name` вынесено планом в отдельную работу «перевести читателей на связь» (§10), и
    // одним читателем в том списке меньше.
    // `?? row.name` — окно выпуска A: `model_id` пока nullable (Р2), и карточке без ссылки печатать
    // пусто нельзя. Ветка нужна и типу колонки, и карточке, заведённой до наката 0171.
    name: (row.modelId === null ? undefined : env.modelNameById.get(row.modelId)) ?? row.name,
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
  resolveRows: resolveEquipmentModels,
  check: (m, ctx, env) => {
    const type = env.types.get(m.typeCode);
    if (m.typeCode === '') {
      ctx.fail('строка без кода типа не заводится: тип есть у каждой единицы');
    } else if (!type) {
      ctx.fail(
        `тип оргтехники «${m.typeCode}» не найден — сначала загрузите справочник типов оргтехники`,
      );
    } else if (!type.isActive) {
      // Замечание, а не отказ: неактивный тип остаётся у заведённых карточек (это и значит
      // «выключен»), и отказ отменял бы файл на строках, которых никто не менял.
      ctx.warn(`тип «${type.name}» погашен — новой технике его в портале уже не выбрать`);
    }

    if (m.name === '') {
      ctx.fail('строка без модели не заводится: по ней технику и выбирают в заявке');
    } else if (type) {
      // Модель ищется только у известного типа: у незнакомого искать негде, и вторая жалоба про
      // модель сказала бы человеку чинить не ту колонку.
      const model = findModel(type.id, m.name, env);
      if (!model) {
        // Отказ, а не молчаливое заведение, — и это сознательное отличие от базы: триггер
        // `office_equipment_model_mirror` ради старого кода недостающую модель заводит сам (Р3).
        // Файл заливают пачкой в сотни строк, и одна опечатка в ячейке тихо родила бы в справочнике
        // мусорную модель — с одной карточкой, без расходников и без шанса, что её кто-то заметит.
        // Человек, заливающий файл, сверяет строки глазами один раз; справочник моделей после этого
        // читают все.
        const elsewhere = env.modelTypesByName.get(m.name) ?? [];
        ctx.fail(
          elsewhere.length > 0
            ? // Составной ключ «тип модели равен типу карточки» словами: база отбила бы эту строку
              // именем ограничения, по которому непонятно, что менять — тип или модель.
              `модель «${m.name}» заведена у типа «${elsewhere.join('», «')}», а карточка типа «${m.typeCode}» — тип модели обязан совпадать с типом карточки`
            : `модель «${m.name}» не заведена: заведите её в справочнике моделей аппаратов или исправьте написание`,
        );
      } else {
        // Написание подменяется справочным: файл мог прийти с «RICOH IM 350» там, где заведено
        // «Ricoh IM 350». Правка отсюда попадает и в отчёт предпросмотра, и в запись (`types.ts`),
        // поэтому человек видит, каким имя станет, а разнописание в файл не просачивается.
        m.name = model.name;
        if (!model.isActive) {
          // Замечание, а не отказ, — по тому же доводу, что и у погашенного типа: погашенная модель
          // остаётся у заведённых карточек (Р11), и отказ отменял бы файл на строках без правок.
          ctx.warn(`модель «${model.name}» погашена — новой технике её в портале уже не выбрать`);
        }
      }
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

// ── Расходники ────────────────────────────────────────────────────────────────────────────────

/**
 * Расходник глазами человека: код номенклатуры, дословное наименование, цвет и набор моделей, к
 * которым он подходит.
 *
 * Остатка здесь нет НЕ по забывчивости — см. колонку «Наличие» и `help()`: остаток меняется только
 * событием журнала (Р7), у которого есть автор и причина, а строка Excel ни тем, ни другим не
 * является.
 */
interface ConsumableModel {
  code: string;
  name: string;
  color: string;
  comment: string;
  isActive: boolean;
  /** К чему подходит: подписи моделей, как они печатаются в ячейку. */
  models: string[];
  /** Остаток — только для печати: загрузка колонку «Наличие» не читает вовсе. */
  quantity: number;
  /** Идентификатор заведённой карточки: им «код занят» отличают от «занят мной же». */
  savedId?: string;
}

/** Модель справочника глазами листа расходников: чем её называют в ячейке и чем она является. */
interface ConsumableModelRef {
  id: string;
  typeCode: string;
  name: string;
  /** Подпись в ячейке: имя, а у одноимённых моделей разных типов — «тип: имя». */
  label: string;
}

interface ConsumableEnv {
  types: Map<string, { id: string; code: string }>;
  /** Ключ написания модели по присланному имени — ответ базы; своей копии правила нет. */
  modelKeyByName: Map<string, string>;
  /** Модели по ключу написания: у одного ключа их столько, сколько типов, где он заведён. */
  modelsByKey: Map<string, ConsumableModelRef[]>;
  /** Модели по ссылке: ими печатается ячейка «Подходит к». */
  modelById: Map<string, ConsumableModelRef>;
  /** Привязки заведённых карточек: расходник → модели. */
  modelIdsByConsumable: Map<string, string[]>;
  /** Ключ кода по присланной строке — тоже ответ базы (`office_equipment_consumable_code_key`). */
  codeKeyByCode: Map<string, string>;
  /** Кто уже занимает ключ кода. */
  takenByCodeKey: Map<string, { id: string; title: string }>;
  /** Второе и последующие написания одного кода в одном файле. */
  codeTwins: Map<string, string>;
}

/**
 * Подпись модели в ячейке. Обычно это просто наименование — «Ricoh IM 350»: так модель зовут и в
 * листе моделей, и в карточке техники. Тип приписывается только там, где одно и то же наименование
 * заведено у нескольких типов: модель опознаётся парой «тип + наименование», и без приписки такая
 * ячейка означала бы сразу две разные записи справочника.
 */
function consumableModelLabel(typeCode: string, name: string, ambiguous: boolean): string {
  return ambiguous ? `${typeCode}: ${name}` : name;
}

/**
 * Разбор подписи в ячейке. Тип отделяется первым двоеточием — но только если слева от него стоит
 * КОД ЗАВЕДЁННОГО типа: двоеточие внутри наименования («Ricoh: IM 350») тогда остаётся частью
 * имени, а не превращает половину строки в несуществующий тип.
 */
function parseConsumableModelLabel(
  text: string,
  env: ConsumableEnv,
): { typeCode?: string; name: string } {
  const at = text.indexOf(':');
  if (at > 0) {
    const head = text.slice(0, at).trim().toLowerCase();
    const tail = text.slice(at + 1).trim();
    if (tail !== '' && env.types.has(head)) return { typeCode: head, name: tail };
  }
  return { name: text.trim() };
}

/** Порядок подписей в ячейке — один и на выгрузке, и после разбора: иначе перестановка выглядела бы правкой. */
function sortLabels(labels: readonly string[]): string[] {
  return [...labels].sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Догрузка ключей (`resolveRows` в `types.ts`) — двумя вопросами к базе на весь файл: ключи
 * присланных кодов и ключи присланных наименований моделей. Оба правила живут функциями Postgres, и
 * копий их в TypeScript нет (см. `modelRef` и миграцию 0172).
 *
 * Правила эти РАЗНЫЕ, и путать их нельзя: у кода пробельные символы **удаляются** (в коде учётной
 * системы пробелов не бывает вовсе, а неразрывный из Excel приезжает регулярно), у наименования
 * модели — схлопываются в один. Поэтому и вопросов два, а не один общий.
 */
async function resolveConsumables(
  models: readonly ConsumableModel[],
  env: ConsumableEnv,
): Promise<void> {
  const askedCodes: string[] = [];
  const askedNames: string[] = [];
  for (const m of models) {
    if (m.code !== '' && !env.codeKeyByCode.has(m.code) && !askedCodes.includes(m.code)) {
      askedCodes.push(m.code);
    }
    for (const label of m.models) {
      const { name } = parseConsumableModelLabel(label, env);
      if (name !== '' && !env.modelKeyByName.has(name) && !askedNames.includes(name)) {
        askedNames.push(name);
      }
    }
  }

  const [codes, names] = await Promise.all([
    askedCodes.length === 0
      ? undefined
      : db.execute<{ asked: string; key: string }>(sql`
          SELECT a.asked, office_equipment_consumable_code_key(a.asked) AS key
            FROM (VALUES ${sql.join(
              askedCodes.map((code) => sql`(${code}::text)`),
              sql`, `,
            )}) AS a(asked)
        `),
    askedNames.length === 0
      ? undefined
      : db.execute<{ asked: string; key: string }>(sql`
          SELECT a.asked, office_equipment_model_key(a.asked) AS key
            FROM (VALUES ${sql.join(
              askedNames.map((name) => sql`(${name}::text)`),
              sql`, `,
            )}) AS a(asked)
        `),
  ]);

  for (const row of codes?.rows ?? []) env.codeKeyByCode.set(row.asked, row.key);
  for (const row of names?.rows ?? []) env.modelKeyByName.set(row.asked, row.key);

  // Близнецы кода внутри файла: «Д0000337741» строкой выше и «д000 0337741» строкой ниже — это одна
  // карточка, и завести её дважды нельзя. Одинаковые написания ловит сам движок ключом строки.
  const firstCode = new Map<string, string>();
  for (const m of models) {
    const key = env.codeKeyByCode.get(m.code);
    if (m.code === '' || key === undefined) continue;
    const first = firstCode.get(key);
    if (first === undefined) firstCode.set(key, m.code);
    else if (first !== m.code) env.codeTwins.set(m.code, first);
  }
}

/** Модели строки в идентификаторы. Промах здесь — расхождение проверки и записи, а не ошибка файла. */
function consumableModelIds(m: ConsumableModel, env: ConsumableEnv): string[] {
  const ids: string[] = [];
  for (const label of m.models) {
    const { typeCode, name } = parseConsumableModelLabel(label, env);
    const key = env.modelKeyByName.get(name);
    const found = (key === undefined ? [] : (env.modelsByKey.get(key) ?? [])).filter(
      (candidate) => typeCode === undefined || candidate.typeCode === typeCode,
    );
    if (found.length !== 1) throw new Error('расходник дошёл до записи с неразобранной моделью');
    if (!ids.includes(found[0]!.id)) ids.push(found[0]!.id);
  }
  return ids;
}

const officeEquipmentConsumablesDirectory = directory<
  {
    id: string;
    code: string;
    name: string;
    quantity: number;
    color: string | null;
    comment: string;
    isActive: boolean;
  },
  ConsumableModel,
  ConsumableEnv
>({
  key: 'office-equipment-consumables',
  env: async () => {
    const [types, models, links] = await Promise.all([
      db
        .select({ id: officeEquipmentTypes.id, code: officeEquipmentTypes.code })
        .from(officeEquipmentTypes),
      // Ключи считает база — тем же выражением, каким построен уникальный индекс справочника.
      db
        .select({
          id: officeEquipmentModels.id,
          typeCode: officeEquipmentTypes.code,
          name: officeEquipmentModels.name,
          key: sql<string>`office_equipment_model_key(${officeEquipmentModels.name})`,
        })
        .from(officeEquipmentModels)
        .innerJoin(
          officeEquipmentTypes,
          eq(officeEquipmentModels.equipmentTypeId, officeEquipmentTypes.id),
        ),
      db
        .select({
          consumableId: officeEquipmentConsumableModels.consumableId,
          modelId: officeEquipmentConsumableModels.modelId,
        })
        .from(officeEquipmentConsumableModels),
    ]);

    const modelKeyByName = new Map<string, string>();
    const byKey = new Map<string, { id: string; typeCode: string; name: string }[]>();
    for (const model of models) {
      // Написание справочника кладётся сразу и с ключом базы: файл, выгруженный порталом, приходит
      // им же, и догрузка не спросит базу ни о чём.
      modelKeyByName.set(model.name, model.key);
      const same = byKey.get(model.key);
      if (same) same.push(model);
      else byKey.set(model.key, [model]);
    }

    const modelsByKey = new Map<string, ConsumableModelRef[]>();
    const modelById = new Map<string, ConsumableModelRef>();
    for (const [key, group] of byKey) {
      // Подпись зависит от всей группы: одноимённые модели разных типов обязаны различаться в
      // ячейке, а единственная — называться просто именем.
      const refs = group.map((model) => ({
        id: model.id,
        typeCode: model.typeCode,
        name: model.name,
        label: consumableModelLabel(model.typeCode, model.name, group.length > 1),
      }));
      modelsByKey.set(key, refs);
      for (const ref of refs) modelById.set(ref.id, ref);
    }

    const modelIdsByConsumable = new Map<string, string[]>();
    for (const link of links) {
      const list = modelIdsByConsumable.get(link.consumableId);
      if (list) list.push(link.modelId);
      else modelIdsByConsumable.set(link.consumableId, [link.modelId]);
    }

    const consumables = await db
      .select({
        id: officeEquipmentConsumables.id,
        code: officeEquipmentConsumables.code,
        name: officeEquipmentConsumables.name,
        key: sql<string>`office_equipment_consumable_code_key(${officeEquipmentConsumables.code})`,
      })
      .from(officeEquipmentConsumables);

    const codeKeyByCode = new Map<string, string>();
    const takenByCodeKey = new Map<string, { id: string; title: string }>();
    for (const row of consumables) {
      codeKeyByCode.set(row.code, row.key);
      takenByCodeKey.set(row.key, { id: row.id, title: row.name });
    }

    return {
      types: new Map(types.map((t) => [t.code, t])),
      modelKeyByName,
      modelsByKey,
      modelById,
      modelIdsByConsumable,
      codeKeyByCode,
      takenByCodeKey,
      codeTwins: new Map(),
    };
  },
  columns: () => [
    {
      header: 'Код',
      width: 18,
      hint: 'Код номенклатуры учётной системы: «Д0000337741». Ключ строки: по нему она и ищется в справочнике. Регистр и пробелы в коде не различаются — «д000 0337741» это тот же код, а не второй.',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Код', CODE_MAX);
        if (v !== undefined) m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 44,
      hint: 'Наименование ДОСЛОВНО как в учётной системе, вместе с хвостом «(шт)»: по нему справочник сверяют со счётом и выгрузкой поставщика.',
      // Наименование не нормализуется вовсе, кроме краёв ячейки (Р5), — и это осознанное отличие от
      // моделей аппаратов, где написание сворачивает база. Причина: имя расходника сверяют глазами
      // с бумажным счётом, и «причёсанное» имя ломает ровно ту сверку, ради которой оно и хранится.
      // Не «унифицировать» с моделями: правила у них разные не по недосмотру.
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', NAME_MAX);
        if (v !== undefined) m.name = v;
      },
    },
    {
      header: 'Цвет',
      width: 16,
      hint: 'Цвет позиции: «чёрный», «голубой», «комплект». Пусто — цвета нет, и это рабочее состояние у чёрно-белой техники; снять заведённый цвет файлом нельзя, это делают в карточке.',
      // Пустая ячейка цвет не снимает, хотя пустой цвет законен: у выгрузки из учётной системы этой
      // графы может не быть вовсе, и «не заполнили» не должно означать «обесцветить справочник»
      // (то же решение, что у отдела-владельца в карточке техники).
      get: (m) => m.color,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Цвет', COLOR_MAX);
        if (v !== undefined) m.color = v;
      },
    },
    {
      header: 'Подходит к',
      width: 46,
      hint: 'Модели аппаратов через «;»: «Ricoh IM 350; Ricoh IM 430». Модель должна быть заведена — листом «Модели аппаратов» или в портале. Одноимённые модели разных типов уточняются кодом типа: «mfp: Ricoh IM 350». Пустая ячейка привязки не снимает — снимают их, перечислив оставшиеся, или в карточке.',
      get: (m) => listCell(m.models),
      // Пусто — «не трогать», как у синонимов контрагента: набор моделей это разметка, и пустая
      // графа в присланном файле не должна означать «отвязать всё». Снять одну модель можно,
      // перечислив оставшиеся, а снять все — в карточке.
      set: (m, text) => {
        if (text.trim() !== '') m.models = parseList(text);
      },
    },
    {
      header: 'Наличие',
      width: 12,
      hint: 'Сколько штук на складе — СПРАВОЧНО. Загрузка эту колонку не читает: остаток меняется только через карточку, где спрашивают причину и пишут строку журнала. Число, вписанное сюда, будет молча пропущено.',
      /*
       * Колонка без `set`, и это главное решение листа (Р7). Остаток меняется только событием
       * журнала — с автором, причиной и непрерывной цепочкой, — а строка Excel ни автором, ни
       * причиной не является: «кто и почему списал шесть картриджей» из файла не узнать никогда.
       *
       * Отсутствие `set` означает, что движок колонку не читает вовсе и в сравнение «что изменится»
       * её не берёт (`types.ts`). Это сильнее любой проверки: писать остаток попросту нечем.
       *
       * Печатать её при этом стоит: человек, правящий номенклатуру в Excel, видит текущее число и
       * не идёт за ним в портал. Цена — риск, что кто-то впишет туда своё: поэтому и подсказка
       * колонки, и лист «Справка» говорят об этом прямо. Молчаливое «загружено успешно» при
       * неизменившемся остатке было бы худшим из исходов.
       *
       * И последнее: заливка не смогла бы записать остаток, даже если бы захотела. Отложенный
       * триггер `office_equipment_consumable_stock_covered` сверяет остаток с журналом на коммите и
       * отменил бы весь файл — с текстом про расходник, которого человек не трогал.
       */
      get: (m) => intCell(m.quantity),
    },
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Пометка о позиции: особенности, которых нет в номенклатуре поставщика. Пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      set: (m, text, ctx) => {
        const v = text.trim();
        if (!tooLong(v, ctx, 'Комментарий', COMMENT_MAX)) m.comment = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» гасит позицию: её не предложат в заявке, но она остаётся в перечне с остатком и привязками. Удалить расходник файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Расходники оргтехники — картриджи и тонеры: код номенклатуры учётной системы, наименование дословно как в счёте, цвет и перечень моделей, к которым позиция подходит.',
    'ОСТАТОК ФАЙЛОМ НЕ ГРУЗИТСЯ. Колонка «Наличие» выгружается справочно и при загрузке пропускается: остаток меняют только в карточке расходника, где спрашивают причину и пишут строку журнала с автором. Число, вписанное в эту колонку файла, ни на что не повлияет.',
    'Ключ строки — код номенклатуры. Регистр и пробелы в нём не различаются: «д000 0337741» и «Д0000337741» — одна и та же карточка, и завести её дважды нельзя.',
    'Наименование хранится дословно, вместе с хвостом «(шт)»: по нему справочник сверяют со счётом, и портал его не «причёсывает» — ни регистр, ни пробелы.',
    'Модели через «;»: «Ricoh IM 350; Ricoh IM 430». Модель должна быть заведена заранее — листом «Модели аппаратов» или в портале. Одноимённые модели разных типов уточняют кодом типа: «mfp: Ricoh IM 350».',
    'Порядок загрузки: типы оргтехники → модели аппаратов → расходники. Пустая ячейка «Подходит к» привязки не снимает: чтобы убрать одну модель, перечислите оставшиеся.',
    'Удаления файлом нет: позицию гасят колонкой «Активен». Совсем удалить можно только позицию без движения по журналу — и только в портале.',
  ],
  load: () =>
    db
      .select({
        id: officeEquipmentConsumables.id,
        code: officeEquipmentConsumables.code,
        name: officeEquipmentConsumables.name,
        quantity: officeEquipmentConsumables.quantity,
        color: officeEquipmentConsumables.color,
        comment: officeEquipmentConsumables.comment,
        isActive: officeEquipmentConsumables.isActive,
      })
      .from(officeEquipmentConsumables)
      .orderBy(officeEquipmentConsumables.name, officeEquipmentConsumables.code),
  id: (row) => row.id,
  model: (row, env) => ({
    code: row.code,
    name: row.name,
    color: row.color ?? '',
    comment: row.comment,
    isActive: row.isActive,
    models: sortLabels(
      (env.modelIdsByConsumable.get(row.id) ?? []).map(
        (modelId) => env.modelById.get(modelId)?.label ?? '',
      ),
    ),
    quantity: row.quantity,
    savedId: row.id,
  }),
  // Остаток у новой строки — ноль, и другого он быть не может: ненулевой остаток без события
  // журнала отменит вся транзакцию отложенным триггером (Р7).
  blank: () => ({
    code: '',
    name: '',
    color: '',
    comment: '',
    isActive: true,
    models: [],
    quantity: 0,
  }),
  /**
   * Ключ строки — код КАК НАПИСАН: правило кода живёт в базе, а ключ строки движок считает до
   * всякого запроса. Строку, назвавшую заведённый код другим написанием, ловит `check()` ответом
   * базы и отвергает словами — тот же приём, что у листа моделей.
   */
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  resolveRows: resolveConsumables,
  check: (m, ctx, env) => {
    if (m.code === '') {
      ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    } else if (m.code.length < CONSUMABLE_CODE_MIN) {
      ctx.fail(`код «${m.code}» короче ${CONSUMABLE_CODE_MIN} знаков — это не код номенклатуры`);
    } else {
      const key = env.codeKeyByCode.get(m.code);
      if (key === undefined) {
        // Ключа нет только там, где догрузка не состоялась вовсе, а `check()` зовут после неё.
        throw new Error('строка расходника дошла до проверок без ключа кода');
      }
      const twin = env.codeTwins.get(m.code);
      const taken = env.takenByCodeKey.get(key);
      if (twin !== undefined) {
        ctx.fail(
          `в файле это тот же код, что и в строке с написанием «${twin}»: регистр и пробелы код не различают, и завести его дважды нельзя`,
        );
      } else if (taken && taken.id !== m.savedId) {
        // Уникальный индекс сказал бы то же самое именем ограничения и уже на записи, отменив весь
        // файл. Здесь названо, кем занят код и что делать дальше.
        ctx.fail(
          `код «${m.code}» уже занят карточкой «${taken.title}»: регистр и пробелы в коде не различаются — правьте её строкой из выгрузки, где заполнена колонка «Идентификатор»`,
        );
      }
    }

    if (m.name === '') {
      ctx.fail('строка без наименования не заводится: по нему позицию и находят');
    } else if (m.name.length < CONSUMABLE_NAME_MIN) {
      ctx.fail(`наименование «${m.name}» короче ${CONSUMABLE_NAME_MIN} знаков`);
    }

    // Модели разбираются по одной: неизвестная — отказ строки словами, а не молчаливое заведение.
    // Завести модель отсюда было бы вдвойне неверно: справочник моделей ведёт свой лист, а
    // опечатка в ячейке набора не видна вовсе — она прячется среди других подписей.
    const labels: string[] = [];
    for (const label of m.models) {
      const { typeCode, name } = parseConsumableModelLabel(label, env);
      const key = name === '' ? undefined : env.modelKeyByName.get(name);
      const candidates = (key === undefined ? [] : (env.modelsByKey.get(key) ?? [])).filter(
        (candidate) => typeCode === undefined || candidate.typeCode === typeCode,
      );
      if (candidates.length === 0) {
        ctx.fail(
          `модель «${label}» не заведена: заведите её листом «Модели аппаратов» или в портале, либо исправьте написание`,
        );
        continue;
      }
      if (candidates.length > 1) {
        // Пара «тип + наименование» — это и есть модель (Р1); одного имени здесь не хватает.
        ctx.fail(
          `модель «${label}» заведена у нескольких типов (${candidates.map((c) => c.typeCode).join(', ')}) — уточните тип: «${candidates[0]!.typeCode}: ${candidates[0]!.name}»`,
        );
        continue;
      }
      // Подпись подменяется справочной: файл мог прийти с «RICOH IM 350» или с лишним уточнением
      // типа. Правка отсюда попадает и в отчёт предпросмотра, и в запись (`types.ts`), поэтому
      // перестановка и разнописание в ячейке не выглядят правкой набора.
      if (!labels.includes(candidates[0]!.label)) labels.push(candidates[0]!.label);
    }
    m.models = sortLabels(labels);
  },
  create: async (tx, m, env, actorUserId) => {
    const [row] = await tx
      .insert(officeEquipmentConsumables)
      .values({
        // Написание кода сворачивает база: правило её (`office_equipment_consumable_code_key`), и
        // прогон через функцию делает отказ `..._code_normalized_check` невозможным в принципе.
        code: sql`office_equipment_consumable_code_key(${m.code})`,
        // Наименование — дословно (Р5): ни свёртки пробелов, ни регистра.
        name: m.name,
        color: m.color === '' ? null : m.color,
        comment: m.comment,
        isActive: m.isActive,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })
      // Остаток не задаётся вовсе: умолчание — ноль, а ненулевой без события журнала отменил бы
      // транзакцию отложенным триггером (Р7).
      .returning({ id: officeEquipmentConsumables.id });
    await linkConsumableModels(tx, row!.id, consumableModelIds(m, env));
  },
  update: async (tx, row, m, env, actorUserId) => {
    await tx
      .update(officeEquipmentConsumables)
      .set({
        code: sql`office_equipment_consumable_code_key(${m.code})`,
        name: m.name,
        color: m.color === '' ? null : m.color,
        comment: m.comment,
        isActive: m.isActive,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      // Количества здесь нет и быть не может (Р7): его правит только ручка остатка, пишущая журнал.
      .where(eq(officeEquipmentConsumables.id, row.id));
    await linkConsumableModels(tx, row.id, consumableModelIds(m, env));
  },
});

/**
 * Привязки расходника приводятся к присланному набору. Разметка, а не история (Р6): лишние строки
 * снимаются, недостающие заводятся, а совпавшие не трогаются — иначе каждая загрузка переписывала
 * бы `created_at` у связей, которых никто не менял.
 */
async function linkConsumableModels(
  tx: Tx,
  consumableId: string,
  modelIds: string[],
): Promise<void> {
  await tx
    .delete(officeEquipmentConsumableModels)
    .where(
      and(
        eq(officeEquipmentConsumableModels.consumableId, consumableId),
        modelIds.length === 0
          ? undefined
          : notInArray(officeEquipmentConsumableModels.modelId, modelIds),
      ),
    );
  if (modelIds.length === 0) return;
  await tx
    .insert(officeEquipmentConsumableModels)
    .values(modelIds.map((modelId) => ({ consumableId, modelId })))
    .onConflictDoNothing();
}

/**
 * Справочники оргтехники (ADR 0073): перечень типов, модели аппаратов, сами единицы и расходники.
 * Порядок — тот же, что в `DIRECTORY_KEYS`: связанное идёт после того, на что ссылается. Тип раньше
 * модели, модель раньше техники и расходников — в этом же порядке их и загружают.
 */
export const officeDirectories: AnyDirectory[] = [
  officeEquipmentTypesDirectory,
  officeEquipmentModelsDirectory,
  officeEquipmentDirectory,
  officeEquipmentConsumablesDirectory,
];
