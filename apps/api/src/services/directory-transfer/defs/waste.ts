import {
  containerKindLabels,
  INN_MESSAGE,
  innSchema,
  pricePerM3FromContainer,
  wasteTypeNameKey,
  type ContainerKind,
} from '@technic/contracts';
import { eq, isNull } from 'drizzle-orm';
import { db } from '../../../db/client';
import {
  containerTypes,
  counterparties,
  wasteTariffs,
  wasteTypes,
  type ContainerTypeRow,
  type WasteTypeRow,
} from '../../../db/schema';
import {
  boolCell,
  decimalCell,
  intCell,
  parseBool,
  parseChoice,
  parseDecimal,
  parseInt10,
  parseRequired,
} from '../cells';
import { directory, type AnyDirectory, type RowContext } from '../types';

/**
 * Справочники вывоза мусора в обмене файлом (ADR 0073): типы контейнеров, типы мусора и прайс.
 *
 * Три описания в одном файле не для экономии: прайс ссылается на оба соседних справочника кодами,
 * и правила этих ссылок обязаны стоять рядом с колонками, которые их печатают, — иначе «код типа
 * контейнера» в одном месте окажется наименованием, а в другом идентификатором.
 *
 * Правила прайса здесь не изобретаются заново: это те же инварианты, что держат CHECK-и
 * `waste_tariffs` (ADR 0009) и форма прайса (`validateWasteTariff` в контрактах). Проверяются они
 * до записи и человеческими словами: база на ту же ошибку отвечает именем ограничения, по которому
 * непонятно, какую из девяти колонок строки править.
 */

/** Предел наименования — тот же, что в формах справочников: файл не заводит непроходимое формой. */
const NAME_MAX = 255;
const CODE_MAX = 50;
const NOTE_MAX = 500;
const DESCRIPTION_MAX = 2000;

/** Копейка: numeric(12,2) мельче не хранит, а CHECK требует цену строго больше нуля. */
const PRICE_MIN = 0.01;
/** Потолок цены — тот же, что в форме прайса: выше начинается опечатка в разряде, а не цена. */
const PRICE_MAX = 100_000_000;

/** Формат кода типа мусора — CHECK `waste_types_code_format_check`; сказать о нём больше некому. */
const WASTE_TYPE_CODE = /^[a-z][a-z0-9_]*$/u;

/**
 * Предел длины колонки. Само преобразование ячейки — из `cells.ts`; здесь только предел, потому
 * что в базе его нет: колонки текстовые, и вставить в них можно роман, а форма справочника длину
 * ограничивает — файл, обходящий форму, обязан ограничивать тоже.
 */
function tooLong(value: string, ctx: RowContext, label: string, max: number): boolean {
  if (value.length <= max) return false;
  ctx.fail(`${label} — не длиннее ${max} знаков, получено ${value.length}`);
  return true;
}

/** Обязательный текст с пределом длины: пустая ячейка заведённое значение не трогает. */
function parseText(
  text: string,
  ctx: RowContext,
  label: string,
  current: string,
  max = NAME_MAX,
): string | undefined {
  const v = parseRequired(text, ctx, label, current);
  if (v === undefined || tooLong(v, ctx, label, max)) return undefined;
  return v;
}

/**
 * Цена из ячейки. Округление до копейки — не придирка: numeric(12,2) третий знак отбросит сам, и
 * сохранённая цена разошлась бы с той, что стоит в файле, — правка показывалась бы при каждой
 * следующей загрузке того же файла. Тем же округлением цену принимает форма прайса.
 */
function parsePrice(text: string, ctx: RowContext, label: string): string | undefined {
  const v = parseDecimal(text, ctx, label, { min: PRICE_MIN, max: PRICE_MAX });
  if (v === undefined) return undefined;
  return decimalCell(String(Math.round(Number(v) * 100) / 100));
}

// ── Типы контейнеров ──────────────────────────────────────────────────────────────────────────

/** Строка справочника типов контейнеров глазами человека. */
interface ContainerTypeModel {
  code: string;
  name: string;
  /** Контейнер или самосвал: тем же словом вид назван в портале (`containerKindLabels`). */
  kind: ContainerKind;
  /** Вместимость, м³; null — не задана. */
  volumeM3: number | null;
  sortOrder: number;
  isActive: boolean;
}

const containerTypesDirectory = directory<
  ContainerTypeRow,
  ContainerTypeModel,
  Record<string, never>
>({
  key: 'container-types',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      width: 20,
      hint: 'Ключ записи: по нему строка ищется в справочнике. Переименовать код заведённой строки можно только вместе с заполненной колонкой «Идентификатор».',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        // Регистр не приводится: формата кода у `container_types` в базе нет, и приведение к
        // строчным переименовало бы заведённые коды, набранные как угодно.
        const v = parseText(text, ctx, 'Код', m.code, CODE_MAX);
        if (v !== undefined) m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 30,
      hint: 'Как тип называют в заявке: «Контейнер 8 м³», «Самосвал 25 м³».',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', m.name);
        if (v !== undefined) m.name = v;
      },
    },
    {
      header: 'Вид',
      width: 14,
      hint: `Что это: ${Object.values(containerKindLabels).join(' или ')}. Контейнер ставят на площадку, самосвалом вывозят.`,
      get: (m) => containerKindLabels[m.kind],
      set: (m, text, ctx) => {
        const v = parseChoice(text, containerKindLabels, ctx, 'Вид');
        if (v !== undefined) m.kind = v;
      },
    },
    {
      header: 'Объём, м³',
      width: 12,
      hint: 'Вместимость целым числом. Нужна тарифу «за контейнер» и объёму рейса; очистить её файлом нельзя — пустая ячейка ничего не меняет.',
      get: (m) => intCell(m.volumeM3),
      set: (m, text, ctx) => {
        // Ноль и отрицательное отсекаются здесь, а не CHECK-ом в базе: там отказ безымянный и
        // отменяет весь файл вместо одной строки.
        const v = parseInt10(text, ctx, 'Объём, м³', { min: 1 });
        if (v !== undefined) m.volumeM3 = v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше строка в списках портала.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок', { min: 0 });
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» гасит запись; удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Типы контейнеров и самосвалов — «чем вывозим»: на них ссылаются заявки на вывоз и позиции прайса.',
    'Загрузка заводит новые строки и правит заведённые. Удаления нет: лишний тип гасят колонкой «Активен» — на него ссылаются оформленные заявки.',
    'Вместимость нужна тарифу «за контейнер»: из неё выводится цена за 1 м³ и кратность объёма в заявке.',
  ],
  load: () =>
    db.select().from(containerTypes).orderBy(containerTypes.sortOrder, containerTypes.code),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    kind: row.type,
    volumeM3: row.volumeM3,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  blank: () => ({
    code: '',
    name: '',
    // Умолчания те же, что у колонок в базе: строка, дописанная человеком, заводится так же, как
    // строка, заведённая формой.
    kind: 'cont',
    volumeM3: null,
    sortOrder: 100,
    isActive: true,
  }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  create: async (tx, m) => {
    await tx.insert(containerTypes).values({
      code: m.code,
      name: m.name,
      type: m.kind,
      volumeM3: m.volumeM3,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(containerTypes)
      .set({
        code: m.code,
        name: m.name,
        type: m.kind,
        volumeM3: m.volumeM3,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(containerTypes.id, row.id));
  },
});

// ── Типы мусора ───────────────────────────────────────────────────────────────────────────────

/** Строка справочника типов мусора глазами человека. `name_key` считает БД — его здесь нет. */
interface WasteTypeModel {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

const wasteTypesDirectory = directory<WasteTypeRow, WasteTypeModel, Record<string, never>>({
  key: 'waste-types',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      width: 24,
      hint: 'Ключ записи: латиница строчными, цифры и подчёркивание, первый знак — буква (bet_boy). По нему тип находит прайс.',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Код', m.code, CODE_MAX);
        if (v === undefined) return;
        // Регистр приводится, потому что формат кода задан CHECK-ом: в базе прописных не бывает,
        // и переименовать этим заведённую строку нельзя.
        const code = v.toLowerCase();
        if (!WASTE_TYPE_CODE.test(code)) {
          ctx.fail(
            `Код — латинские строчные буквы, цифры и подчёркивание, первый знак — буква; получено «${v}»`,
          );
          return;
        }
        m.code = code;
      },
    },
    {
      header: 'Наименование',
      width: 34,
      hint: 'Как тип называют в заявке. Уникально с точностью до написания: «Бетонный бой» и «бетонный-бой» — один и тот же тип.',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', m.name);
        if (v === undefined) return;
        // Пустой ключ названия отвергает CHECK `waste_types_name_key_not_blank_check`: название
        // из одних знаков препинания не отличает один тип от другого.
        if (wasteTypeNameKey(v) === '') {
          ctx.fail(`Наименование — должно содержать буквы или цифры; получено «${v}»`);
          return;
        }
        m.name = v;
      },
    },
    {
      header: 'Описание',
      width: 44,
      hint: 'Пояснение для тех, кто заводит заявку. Пустая ячейка стирает заведённое описание.',
      get: (m) => m.description,
      set: (m, text, ctx) => {
        // Единственная колонка справочника, где пусто означает «стереть»: описание — свободный
        // текст, и человек, очистивший ячейку, именно это и имел в виду. Поэтому значение
        // присваивается напрямую, минуя разбор `cells.ts` с его «пусто — ничего не менять».
        const v = text.trim();
        if (!tooLong(v, ctx, 'Описание', DESCRIPTION_MAX)) m.description = v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше строка в списках портала.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок', { min: 0 });
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» гасит запись; удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Типы мусора — «что вывозим»: строительный мусор, бетонный бой, грунт, древесные отходы.',
    'Загрузка заводит новые типы и правит заведённые. Удаления нет: лишний тип гасят колонкой «Активен» — на него ссылаются заявки и позиции прайса.',
    'Цену типу задают в справочнике «Стоимость вывоза мусора»: тип без цены в форме заявки не выбрать.',
  ],
  load: () => db.select().from(wasteTypes).orderBy(wasteTypes.sortOrder, wasteTypes.code),
  id: (row) => row.id,
  // `nameKey` в модель не берётся и в базу не пишется: его считает БД (GENERATED), и второй
  // источник правды у него завёлся бы ровно на одну загрузку.
  model: (row) => ({
    code: row.code,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  blank: () => ({ code: '', name: '', description: '', sortOrder: 100, isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  create: async (tx, m) => {
    await tx.insert(wasteTypes).values({
      code: m.code,
      name: m.name,
      description: m.description,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(wasteTypes)
      .set({
        code: m.code,
        name: m.name,
        description: m.description,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(wasteTypes.id, row.id));
  },
});

// ── Стоимость вывоза мусора ───────────────────────────────────────────────────────────────────

/**
 * Позиция прайса глазами человека: ссылки — ИНН и кодами, цены — строками.
 *
 * Цены строками не по лени: numeric приходит из pg строкой, и перевод «1875.50» в число и обратно
 * даёт «1875.5» — правку цены там, где её никто не делал.
 */
interface WasteTariffModel {
  operatorInn: string;
  wasteTypeCode: string;
  /** Код типа контейнера; пусто — тариф задан на вид техники целиком. */
  containerTypeCode: string;
  /** Вид техники; null — тариф задан на конкретный тип контейнера. */
  containerKind: ContainerKind | null;
  pricePerM3: string;
  /** Цена за контейнер целиком; пусто — позиция задана ценой за м³. */
  pricePerContainer: string;
  isPerContainer: boolean;
  note: string;
  isActive: boolean;
}

/**
 * Строка прайса в том виде, в каком её отдаёт выгрузка: ссылки уже разрешены в ИНН и коды.
 * Развернуть их запросом дешевле, чем держать вторые, обратные словари рядом с прямыми из `env`.
 */
interface WasteTariffFileRow {
  id: string;
  operatorInn: string;
  wasteTypeCode: string;
  containerTypeCode: string | null;
  containerKind: ContainerKind | null;
  pricePerM3: string;
  pricePerContainer: string | null;
  isPerContainer: boolean;
  note: string;
  isActive: boolean;
}

/**
 * Что нужно знать про остальной портал, чтобы разобрать строку прайса: по ИНН и кодам из файла
 * находятся идентификаторы. Читается один раз на файл — иначе на каждую строку пришлось бы по три
 * запроса в базу.
 */
interface WasteTariffEnv {
  /** Контрагенты по ИНН — все, а не только операторы: «не оператор» и «не найден» разные ответы. */
  operators: Map<string, { id: string; isOperator: boolean }>;
  wasteTypeIds: Map<string, string>;
  containers: Map<string, { id: string; volumeM3: number | null }>;
}

/**
 * Ссылки строки, разобранные в идентификаторы. Сюда строка доходит только после `check()`:
 * незнакомый ИНН или код отменяют весь файл до записи. Промах словаря здесь — не ошибка человека,
 * а расхождение проверки и записи, и падать оно должно громко, а не тихой строкой в прайсе.
 */
function tariffValues(m: WasteTariffModel, env: WasteTariffEnv) {
  const operator = env.operators.get(m.operatorInn);
  const wasteTypeId = env.wasteTypeIds.get(m.wasteTypeCode);
  const container = m.containerTypeCode === '' ? null : env.containers.get(m.containerTypeCode);
  if (!operator || wasteTypeId === undefined || container === undefined || m.pricePerM3 === '') {
    throw new Error('позиция прайса дошла до записи неразобранной');
  }
  return {
    operatorCounterpartyId: operator.id,
    wasteTypeId,
    containerTypeId: container?.id ?? null,
    // Цель у позиции ровно одна (CHECK `waste_tariffs_target_check`): задан тип — вида быть не
    // может, и наоборот.
    containerKind: container ? null : m.containerKind,
    pricePerM3: m.pricePerM3,
    // Цена за контейнер хранится только у позиции «за контейнер» — так же её пишет форма прайса.
    pricePerContainer: m.isPerContainer && m.pricePerContainer !== '' ? m.pricePerContainer : null,
    isPerContainer: m.isPerContainer,
    note: m.note,
    isActive: m.isActive,
  };
}

const wasteTariffsDirectory = directory<WasteTariffFileRow, WasteTariffModel, WasteTariffEnv>({
  key: 'waste-tariffs',
  env: async () => {
    const [parties, types, containers] = await Promise.all([
      // Только неудалённые: ИНН уникален среди них, и удалённый контрагент подрался бы за ключ
      // словаря с живым однофамильцем по ИНН.
      db
        .select({ id: counterparties.id, inn: counterparties.inn, type: counterparties.type })
        .from(counterparties)
        .where(isNull(counterparties.deletedAt)),
      db.select({ id: wasteTypes.id, code: wasteTypes.code }).from(wasteTypes),
      db
        .select({
          id: containerTypes.id,
          code: containerTypes.code,
          volumeM3: containerTypes.volumeM3,
        })
        .from(containerTypes),
    ]);
    return {
      operators: new Map(
        parties.map((p) => [p.inn, { id: p.id, isOperator: p.type === 'operator' }]),
      ),
      wasteTypeIds: new Map(types.map((t) => [t.code, t.id])),
      containers: new Map(containers.map((c) => [c.code, { id: c.id, volumeM3: c.volumeM3 }])),
    };
  },
  columns: () => [
    {
      header: 'Оператор (ИНН)',
      width: 18,
      hint: 'Чья это цена: ИНН контрагента типа «Оператор» из справочника контрагентов. Один и тот же вывоз операторы возят по разным ставкам.',
      get: (m) => m.operatorInn,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Оператор (ИНН)', m.operatorInn, CODE_MAX);
        if (v === undefined) return;
        // Пробелы внутри номера — оформление, а не часть ИНН: их ставит копирование из документа.
        const inn = v.replace(/\s/gu, '');
        // Формат проверяется тем же правилом, что у контрагента: без него наименование, набранное
        // в этой колонке, дало бы «оператор с ИНН ООО «Ромашка» не найден» — совет невпопад.
        if (!innSchema.safeParse(inn).success) {
          ctx.fail(`Оператор (ИНН) — ${INN_MESSAGE}; получено «${v}»`);
          return;
        }
        m.operatorInn = inn;
      },
    },
    {
      header: 'Тип мусора (код)',
      width: 22,
      hint: 'Код из справочника «Типы мусора». Тип с таким кодом должен быть заведён — прайс типов не заводит.',
      get: (m) => m.wasteTypeCode,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Тип мусора (код)', m.wasteTypeCode, CODE_MAX);
        if (v !== undefined) m.wasteTypeCode = v.toLowerCase();
      },
    },
    {
      header: 'Тип контейнера (код)',
      width: 22,
      hint: 'Код из справочника «Типы контейнеров» — цена на конкретный контейнер. Заполняют либо её, либо «Вид техники».',
      get: (m) => m.containerTypeCode,
      set: (m, text, ctx) => {
        // Колонка необязательная сама по себе: обязательна пара «тип контейнера ИЛИ вид техники»,
        // и проверяет её `check()`. Пустая ячейка цель тарифа не снимает — цель входит в ключ
        // строки, и очистка означала бы не правку цены, а другую позицию прайса: цену переводят
        // на вид техники новой строкой, а прежнюю гасят колонкой «Активен».
        const v = text.trim();
        if (v === '' || tooLong(v, ctx, 'Тип контейнера (код)', CODE_MAX)) return;
        m.containerTypeCode = v;
      },
    },
    {
      header: 'Вид техники',
      width: 16,
      hint: `Цена на весь вид сразу (${Object.values(containerKindLabels).join(' или ')}) — её и применяет вывоз мусора, который машину не называет. Заполняют вместо «Тип контейнера (код)».`,
      get: (m) => (m.containerKind === null ? '' : containerKindLabels[m.containerKind]),
      set: (m, text, ctx) => {
        const v = parseChoice(text, containerKindLabels, ctx, 'Вид техники');
        if (v !== undefined) m.containerKind = v;
      },
    },
    {
      header: 'Цена за м³',
      width: 14,
      hint: 'Рублей за 1 м³ — цена, по которой считается заявка. У позиции «за контейнер» её выводит портал, и править её вручную незачем.',
      get: (m) => decimalCell(m.pricePerM3),
      set: (m, text, ctx) => {
        const v = parsePrice(text, ctx, 'Цена за м³');
        if (v !== undefined) m.pricePerM3 = v;
      },
    },
    {
      header: 'Цена за контейнер',
      width: 18,
      hint: 'Рублей за контейнер целиком. Заполняют вместе с «Считать за контейнер» = «да» и только для конкретного типа контейнера.',
      get: (m) => decimalCell(m.pricePerContainer),
      set: (m, text, ctx) => {
        const v = parsePrice(text, ctx, 'Цена за контейнер');
        if (v !== undefined) m.pricePerContainer = v;
      },
    },
    {
      header: 'Считать за контейнер',
      width: 20,
      hint: '«да» — цена в прайсе объявлена за контейнер целиком: объём заявки тогда обязан быть кратен его вместимости.',
      get: (m) => boolCell(m.isPerContainer),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Считать за контейнер');
        if (v !== undefined) m.isPerContainer = v;
      },
    },
    {
      header: 'Примечание',
      width: 40,
      hint: 'Условия позиции своими словами. Пустая ячейка стирает заведённое примечание.',
      get: (m) => m.note,
      set: (m, text, ctx) => {
        // Здесь пусто законно означает «убрать»: примечание — свободный текст, и очищенную
        // ячейку человек очистил намеренно. Отсюда и присваивание напрямую, минуя разбор
        // `cells.ts`, где пустая ячейка означает «ничего не менять».
        const v = text.trim();
        if (!tooLong(v, ctx, 'Примечание', NOTE_MAX)) m.note = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» убирает цену из подбора; удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Прайс вывоза мусора: цена оператора на пару «тип мусора × техника». У каждого оператора она своя, поэтому ИНН входит в ключ строки.',
    'Цена в портале всегда за 1 м³. «Считать за контейнер» — это способ задания, а не вторая цена: вводится цена за контейнер целиком, а цену за м³ портал выводит сам из вместимости типа (15 000 ₽ за контейнер 8 м³ → 1875 ₽/м³) и требует кратности объёма в заявке.',
    'Цель тарифа одна: либо конкретный тип контейнера, либо вид техники целиком. Точная цена на тип побеждает цену на вид.',
    'Оператор, тип мусора и тип контейнера ищутся по ИНН и кодам: их справочники загружают раньше прайса — сам прайс ничего из них не заводит.',
  ],
  load: async () => {
    const rows: WasteTariffFileRow[] = await db
      .select({
        id: wasteTariffs.id,
        operatorInn: counterparties.inn,
        wasteTypeCode: wasteTypes.code,
        containerTypeCode: containerTypes.code,
        containerKind: wasteTariffs.containerKind,
        pricePerM3: wasteTariffs.pricePerM3,
        pricePerContainer: wasteTariffs.pricePerContainer,
        isPerContainer: wasteTariffs.isPerContainer,
        note: wasteTariffs.note,
        isActive: wasteTariffs.isActive,
      })
      .from(wasteTariffs)
      .innerJoin(counterparties, eq(wasteTariffs.operatorCounterpartyId, counterparties.id))
      .innerJoin(wasteTypes, eq(wasteTariffs.wasteTypeId, wasteTypes.id))
      .leftJoin(containerTypes, eq(wasteTariffs.containerTypeId, containerTypes.id))
      .orderBy(counterparties.name, wasteTypes.name, wasteTariffs.pricePerM3);
    return rows;
  },
  id: (row) => row.id,
  model: (row) => ({
    operatorInn: row.operatorInn,
    wasteTypeCode: row.wasteTypeCode,
    containerTypeCode: row.containerTypeCode ?? '',
    containerKind: row.containerKind,
    pricePerM3: row.pricePerM3,
    pricePerContainer: row.pricePerContainer ?? '',
    isPerContainer: row.isPerContainer,
    note: row.note,
    isActive: row.isActive,
  }),
  blank: () => ({
    operatorInn: '',
    wasteTypeCode: '',
    containerTypeCode: '',
    containerKind: null,
    pricePerM3: '',
    pricePerContainer: '',
    isPerContainer: false,
    note: '',
    isActive: true,
  }),
  /**
   * Ключ — тройка «оператор × тип мусора × цель». Цель помечается, а не подставляется как есть:
   * код типа контейнера и вид техники живут в разных пространствах имён, и без пометки цена на
   * тип `truck` совпала бы ключом с ценой на вид «Самосвал».
   */
  keyOf: (m) => {
    const target =
      m.containerTypeCode !== ''
        ? `c:${m.containerTypeCode}`
        : m.containerKind !== null
          ? `k:${m.containerKind}`
          : '';
    if (m.operatorInn === '' || m.wasteTypeCode === '' || target === '') return '';
    return `${m.operatorInn}/${m.wasteTypeCode}/${target}`;
  },
  titleOf: (m) => {
    const target =
      m.containerTypeCode !== ''
        ? m.containerTypeCode
        : m.containerKind !== null
          ? containerKindLabels[m.containerKind]
          : '—';
    return `${m.wasteTypeCode || '—'} × ${target} (ИНН ${m.operatorInn || '—'})`;
  },
  check: (m, ctx, env) => {
    // Чья цена. Тип контрагента проверяется здесь, а не внешним ключом: составной FK потребовал
    // бы дублировать тип в самой таблице — то же решение, что у исполнителя заявки (ADR 0026).
    const operator = m.operatorInn === '' ? undefined : env.operators.get(m.operatorInn);
    if (m.operatorInn === '') {
      ctx.fail('оператор (ИНН) не указан — цена в прайсе всегда чья-то');
    } else if (!operator) {
      ctx.fail(
        `оператор с ИНН ${m.operatorInn} не найден — сначала загрузите справочник контрагентов`,
      );
    } else if (!operator.isOperator) {
      ctx.fail(
        `контрагент с ИНН ${m.operatorInn} заведён не оператором вывоза — цену вывоза задают оператору`,
      );
    }

    if (m.wasteTypeCode === '') {
      ctx.fail('тип мусора (код) не указан');
    } else if (!env.wasteTypeIds.has(m.wasteTypeCode)) {
      ctx.fail(
        `тип мусора «${m.wasteTypeCode}» не найден — сначала загрузите справочник типов мусора`,
      );
    }

    const container =
      m.containerTypeCode === '' ? undefined : env.containers.get(m.containerTypeCode);
    if (m.containerTypeCode !== '' && !container) {
      ctx.fail(
        `тип контейнера «${m.containerTypeCode}» не найден — сначала загрузите справочник типов контейнеров`,
      );
    }

    // Цель ровно одна (CHECK `waste_tariffs_target_check`).
    if (m.containerTypeCode !== '' && m.containerKind !== null) {
      ctx.fail(
        'заполнены и тип контейнера, и вид техники — цель у цены одна: либо конкретный тип, либо вид целиком',
      );
    } else if (m.containerTypeCode === '' && m.containerKind === null) {
      ctx.fail('не указаны ни тип контейнера, ни вид техники — цену не к чему привязать');
    }

    if (!m.isPerContainer) {
      if (m.pricePerContainer !== '') {
        // Позиция, заданная ценой за м³, цену за контейнер не хранит вовсе — так пишет её и форма
        // прайса. Молча оставить её значило бы показать в файле цену, которой в базе нет.
        ctx.warn(
          '«считать за контейнер» — «нет»: цена за контейнер у такой позиции не хранится и будет очищена',
        );
        m.pricePerContainer = '';
      }
      if (m.pricePerM3 === '') ctx.fail('цена за м³ не задана');
      return;
    }

    // Дальше — позиция «за контейнер» (CHECK `waste_tariffs_per_container_check`).
    if (m.containerTypeCode === '') {
      ctx.fail(
        'цена за контейнер задана, а тип контейнера не указан: за контейнер считают только конкретный тип',
      );
    }
    if (m.pricePerContainer === '') {
      ctx.fail('«считать за контейнер» — «да», а цена за контейнер не задана');
    }
    if (container && container.volumeM3 === null) {
      ctx.fail(
        `у типа контейнера «${m.containerTypeCode}» не задана вместимость — из неё выводится цена за 1 м³`,
      );
    }
    if (container?.volumeM3 == null || m.pricePerContainer === '') return;

    // Цену за м³ у такой позиции выводит портал, а не файл (ADR 0009): вводится одна цена, вторая
    // производна, и разойтись им негде. Пересчёт стоит до сравнения строк — иначе предпросмотр
    // показал бы правку одной цены, а в базу уехали бы две.
    const perM3 = pricePerM3FromContainer(Number(m.pricePerContainer), container.volumeM3);
    if (perM3 < PRICE_MIN) {
      ctx.fail(
        `цена за контейнер ${m.pricePerContainer} ₽ при вместимости ${container.volumeM3} м³ даёт меньше копейки за 1 м³`,
      );
      return;
    }
    const derived = decimalCell(String(perM3));
    if (m.pricePerM3 !== '' && decimalCell(m.pricePerM3) !== derived) {
      ctx.warn(
        `цена за м³ выведена из цены за контейнер и вместимости: ${derived} вместо ${decimalCell(m.pricePerM3)}`,
      );
    }
    m.pricePerM3 = derived;
  },
  create: async (tx, m, env) => {
    await tx.insert(wasteTariffs).values(tariffValues(m, env));
  },
  update: async (tx, row, m, env) => {
    await tx
      .update(wasteTariffs)
      .set({ ...tariffValues(m, env), updatedAt: new Date() })
      .where(eq(wasteTariffs.id, row.id));
  },
});

/**
 * Справочники вывоза мусора (ADR 0073): типы контейнеров, типы мусора и прайс.
 * Порядок — тот же, что в `DIRECTORY_KEYS`: связанное идёт после того, на что ссылается.
 */
export const wasteDirectories: AnyDirectory[] = [
  containerTypesDirectory,
  wasteTypesDirectory,
  wasteTariffsDirectory,
];
