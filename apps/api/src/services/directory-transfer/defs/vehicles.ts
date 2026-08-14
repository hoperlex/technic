import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  buildVehicleCategoryName,
  LINEAR_VEHICLE_TYPE_HINT,
  vehicleOwnershipLabels,
  vehicleStatusLabels,
  type VehicleCategoryValueInput,
  type VehicleOwnership,
  type VehicleStatus,
  type VehicleTypeSpecDto,
  type WaybillFormCode,
} from '@technic/contracts';
import { db } from '../../../db/client';
import {
  counterparties,
  credentialTypes,
  organizations,
  qualificationCategories,
  vehicleCategories,
  vehicleCategorySpecValues,
  vehicleKinds,
  vehicleModels,
  vehicles,
  vehicleSpecs,
  vehicleTypeSpecs,
  vehicleTypes,
  type VehicleKindRow,
  type VehicleRow,
  type VehicleSpecRow,
  type VehicleTypeRow,
} from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import {
  assertSignatureFree,
  checkedValues,
  lockType,
  loadTypeSpecs,
  refreshTypeCategories,
  signatureOf,
  valueDtos,
  valueToColumn,
} from '../../vehicle-categories';
import {
  boolCell,
  dateCell,
  decimalCell,
  intCell,
  listCell,
  parseBool,
  parseChoice,
  parseDate,
  parseDecimal,
  parseInt10,
  parseList,
} from '../cells';
import { directory, type AnyDirectory, type RowContext, type Tx } from '../types';

/**
 * Справочники техники (ADR 0073): виды и типы ТС, ТТХ и их привязки, категории со значениями,
 * модели и сама техника.
 *
 * Порядок описаний здесь — порядок загрузки: каждое следующее ссылается на предыдущие кодами, а
 * портал не угадывает (ADR 0073 п. 8). Незнакомый код вида ТС — это ошибка строки, а не тихо
 * заведённый вид: молчание здесь раздвоило бы классификатор, и половина парка уехала бы в вид
 * «Спецтехника», а половина — в «Спецтехнику» с опечаткой.
 *
 * Самое неочевидное место — категории (ADR 0016). Категория опознаётся набором значений ТТХ, а не
 * наименованием, поэтому её колонки в файле динамические (по одной на каждый заведённый ТТХ), а
 * ключом строки служит тип плюс сам набор значений. Правка значения — это другая категория, и
 * строка без «Идентификатора» с новым набором заведёт её, а не изменит прежнюю.
 */

// ── Общее для всех шести описаний ──

/**
 * Составной ключ строки. Разделитель — вертикальная черта: её нет ни в кодах (`^[a-z][a-z0-9_]*$`),
 * ни в ИНН, ни в нормализованном госномере, а значит склейка однозначна. Пустая часть означает
 * «ключ не собрался»: об этом уже сказала ошибка разбора, и подсовывать движку огрызок незачем.
 */
function compositeKey(...parts: readonly string[]): string {
  return parts.some((p) => p.trim() === '') ? '' : parts.map((p) => p.trim()).join('|');
}

/**
 * Чем закончился поиск ссылки в справочнике: `null` — ячейка пуста, `{ id }` — нашлось,
 * `{ fail }` — не нашлось, и вот что об этом сказать человеку. Один тип на все ссылки, потому что
 * искать их приходится дважды: в `check()` — чтобы объяснить, и в `create()`/`update()` — чтобы
 * записать. Две отдельные функции на каждую ссылку однажды разошлись бы, и запись пошла бы туда,
 * куда проверка не смотрела.
 */
type Lookup = { id: string } | { fail: string } | null;

function idOf(found: Lookup): string | null {
  return found && 'id' in found ? found.id : null;
}

function report(found: Lookup, ctx: RowContext): void {
  if (found && 'fail' in found) ctx.fail(found.fail);
}

/** Код справочника из ячейки: регистр человеку не подсказывают, а коды в портале строчные. */
function codeCell(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Наименование модели так, как его сравнивает БД (`vehicle_model_normalize`, миграция 0015):
 * регистр, ё→е, любые разделители — в один пробел.
 *
 * Повторено здесь ровно потому, что ключ строки собирается без обращения к базе: строки файла
 * сверяются в том числе между собой, до единой транзакции. Источником истины остаётся БД —
 * уникальность держит индекс по generated-колонке, а не эта функция.
 */
function normalizeModelName(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^a-z0-9а-я]+/gu, ' ')
    .trim();
}

/** Кириллические двойники букв регистрационного знака — те же, что в `vehicle_reg_normalize`. */
const REG_LOOKALIKES: Readonly<Record<string, string>> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

/**
 * Госномер так, как его сравнивает БД (`vehicle_reg_normalize`, миграция 0015): разделители
 * выброшены, регистр верхний, кириллица заменена латиницей. «В 094 ЕТ 77» и «B094ET77» — один
 * номер, и одна и та же машина, дважды набранная в разных раскладках, не должна заводиться дважды.
 */
function normalizeRegistration(text: string): string {
  return text
    .replace(/[^0-9A-Za-zА-Яа-яЁё]+/gu, '')
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/gu, (c) => REG_LOOKALIKES[c] ?? c);
}

/** Пустая строка → NULL: этого требуют CHECK'и not-blank и частичные уникальные индексы. */
function nullable(text: string): string | null {
  const v = text.trim();
  return v === '' ? null : v;
}

/**
 * Отказ сервиса категорий (`vehicle-categories.ts`) — в замечание по строке файла. Правила полноты
 * набора, границ и масштаба значений живут там, и повторять их здесь значило бы завести вторую
 * редакцию тех же требований: карточка типа проверяла бы одно, файл — другое.
 */
function collectServiceError(ctx: RowContext, run: () => void): void {
  try {
    run();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    ctx.fail(e.message);
  }
}

// ── Категории прав: ссылка видом документа и кодом ──

/**
 * Категории квалификаций (ADR 0008) уникальны внутри вида документа, а не глобально: «C» есть и у
 * водительского удостоверения, и у удостоверения машиниста. Поэтому в файле они пишутся парой
 * «код вида документа: код категории», а короткая запись принимается, пока код однозначен.
 */
interface QualificationIndex {
  /** «вид:категория» без пробелов и в нижнем регистре → идентификатор. */
  byPair: Map<string, string>;
  /** Код категории → все виды документов, где он встречается. */
  byCode: Map<string, { id: string; typeCode: string }[]>;
  /** Идентификатор → то, что уедет в файл. */
  label: Map<string, string>;
}

async function loadQualifications(): Promise<QualificationIndex> {
  const rows = await db
    .select({
      id: qualificationCategories.id,
      code: qualificationCategories.code,
      typeCode: credentialTypes.code,
    })
    .from(qualificationCategories)
    .innerJoin(credentialTypes, eq(qualificationCategories.credentialTypeId, credentialTypes.id))
    .orderBy(asc(credentialTypes.code), asc(qualificationCategories.code));

  const index: QualificationIndex = { byPair: new Map(), byCode: new Map(), label: new Map() };
  for (const r of rows) {
    const label = `${r.typeCode}: ${r.code}`;
    index.byPair.set(`${r.typeCode}:${r.code}`, r.id);
    index.byCode.set(r.code, [
      ...(index.byCode.get(r.code) ?? []),
      { id: r.id, typeCode: r.typeCode },
    ]);
    index.label.set(r.id, label);
  }
  return index;
}

function qualificationCell(id: string | null, index: QualificationIndex): string {
  return id === null ? '' : (index.label.get(id) ?? '');
}

function findQualification(text: string, index: QualificationIndex): Lookup {
  const v = text.trim();
  if (v === '') return null;
  const pair = v.toLowerCase().replace(/\s+/gu, '');
  const byPair = index.byPair.get(pair);
  if (byPair) return { id: byPair };
  if (pair.includes(':')) {
    return {
      fail: `категория прав «${v}» не найдена — сначала загрузите справочники видов документов и категорий квалификаций`,
    };
  }
  const found = index.byCode.get(pair) ?? [];
  if (found.length === 1) return { id: found[0]!.id };
  if (found.length === 0) {
    return {
      fail: `категория прав «${v}» не найдена — сначала загрузите справочник категорий квалификаций`,
    };
  }
  const variants = found.map((f) => `${f.typeCode}: ${pair}`).join(', ');
  return {
    fail: `категория прав «${v}» есть у нескольких видов документов — напишите, какая именно: ${variants}`,
  };
}

// ── Виды ТС ──

interface KindModel {
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

const vehicleKindsDirectory = directory<VehicleKindRow, KindModel, Record<string, never>>({
  key: 'vehicle-kinds',
  env: async () => ({}),
  columns: () => [
    {
      header: 'Код',
      width: 18,
      hint: 'Ключ записи: по нему строка ищется в справочнике. Латиница строчными, цифры, подчёркивание.',
      get: (m) => m.code,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 34,
      hint: 'Как вид называется в портале: «Спецтехника», «Грузоперевозки».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше строка в списках портала. По умолчанию 100.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок');
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
    'Виды ТС — верхний уровень классификатора техники: «Спецтехника», «Грузоперевозки».',
    'Ключ строки — код. Чтобы переименовать код, правьте его, не трогая «Идентификатор».',
    'Вид — граница замены техники в заявке (ADR 0059), поэтому новых видов заводят мало.',
    'Порядок загрузки справочников техники: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db.select().from(vehicleKinds).orderBy(asc(vehicleKinds.sortOrder), asc(vehicleKinds.code)),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  blank: () => ({ code: '', name: '', sortOrder: 100, isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  // Обязательность проверяется по собранной модели, а не ячейкой: колонки в файле может не быть
  // вовсе — человек вправе удалить то, чего не правит, — и тогда `set` не вызовется ни разу.
  check: (m, ctx) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
  },
  create: async (tx, m) => {
    await tx.insert(vehicleKinds).values({
      code: m.code,
      name: m.name,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(vehicleKinds)
      .set({
        code: m.code,
        name: m.name,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(vehicleKinds.id, row.id));
  },
});

// ── ТТХ ──

interface SpecModel {
  code: string;
  name: string;
  shortName: string;
  unit: string;
  decimals: number;
  /** Границы — numeric в базе, а значит строки: перевод в число портит «0.50» и хвостовые нули. */
  minValue: string;
  maxValue: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  /**
   * Код, под которым ТТХ заведён сейчас. Хранится в модели, потому что искать запись по новому коду
   * бессмысленно — код и есть ключ, а правка ячейки как раз его и меняет. У новой строки поля нет.
   */
  savedCode?: string;
}

interface SpecsEnv {
  /** Что уже заведено по каждому коду ТТХ — этим проверяется заморозка единицы и масштаба. */
  saved: Map<string, { unit: string; decimals: number; usedInTypes: number }>;
}

const vehicleSpecsDirectory = directory<VehicleSpecRow, SpecModel, SpecsEnv>({
  key: 'vehicle-specs',
  env: async () => {
    const rows = await db
      .select({
        code: vehicleSpecs.code,
        unit: vehicleSpecs.unit,
        decimals: vehicleSpecs.decimals,
        usedInTypes: sql<number>`(
          SELECT count(*) FROM ${vehicleTypeSpecs} WHERE ${vehicleTypeSpecs.specId} = ${vehicleSpecs.id}
        )`,
      })
      .from(vehicleSpecs);
    return {
      saved: new Map(
        rows.map((r) => [
          r.code,
          {
            unit: r.unit,
            decimals: Number(r.decimals),
            usedInTypes: Number(r.usedInTypes),
          },
        ]),
      ),
    };
  },
  columns: () => [
    {
      header: 'Код',
      width: 20,
      hint: 'Ключ записи. Латиница строчными, цифры, подчёркивание. Код входит в подпись набора значений категорий — у ТТХ со значениями его не меняют.',
      get: (m) => m.code,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.code = v;
      },
    },
    {
      header: 'Наименование',
      width: 30,
      hint: 'Как характеристика называется целиком: «Грузоподъёмность». Пара «наименование + единица» в справочнике одна.',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Краткое имя',
      width: 14,
      hint: 'Чем ТТХ подписан в наименовании категории: «г/п», «стрела». Пусто — берётся полное наименование.',
      get: (m) => m.shortName,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.shortName = v;
      },
    },
    {
      header: 'Единица измерения',
      width: 16,
      hint: '«т», «м», «м³». Пусто — характеристика безразмерная. У ТТХ, привязанного к типам, единицу изменить нельзя: в ней уже заданы значения категорий.',
      get: (m) => m.unit,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.unit = v;
      },
    },
    {
      header: 'Знаков после запятой',
      width: 12,
      hint: 'От 0 до 3. Входит в канонизацию значений, поэтому у привязанного к типам ТТХ не меняется.',
      get: (m) => intCell(m.decimals),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Знаков после запятой', { min: 0, max: 3 });
        if (v !== undefined) m.decimals = v;
      },
    },
    {
      header: 'Минимум',
      width: 12,
      hint: 'Нижняя граница значения. Пусто — не задана; убирают границу в карточке ТТХ.',
      get: (m) => decimalCell(m.minValue),
      set: (m, text, ctx) => {
        const v = parseDecimal(text, ctx, 'Минимум');
        if (v !== undefined) m.minValue = v;
      },
    },
    {
      header: 'Максимум',
      width: 12,
      hint: 'Верхняя граница значения. Пусто — не задана.',
      get: (m) => decimalCell(m.maxValue),
      set: (m, text, ctx) => {
        const v = parseDecimal(text, ctx, 'Максимум');
        if (v !== undefined) m.maxValue = v;
      },
    },
    {
      header: 'Описание',
      width: 40,
      // Пусто здесь законно значит «стереть»: описание — свободный текст, и очищают его тем же
      // способом, каким заполняли, — самой ячейкой.
      hint: 'Пояснение для того, кто заводит категории. Пустая ячейка стирает заведённое описание.',
      get: (m) => m.description,
      set: (m, text) => {
        m.description = text.trim();
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше ТТХ в списках. По умолчанию 100.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок');
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» гасит ТТХ; погасить привязанный к типам нельзя — сначала отвяжите его.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'ТТХ — характеристики техники («Грузоподъёмность, т»), из значений которых складываются категории типов ТС.',
    'Справочник общий на весь портал: «Грузоподъёмность, т» — одна запись и у автокранов, и у самосвалов.',
    'Единица измерения и число знаков после запятой замораживаются, как только ТТХ привязан к типу: в них уже заданы значения категорий.',
    'Привязка ТТХ к типу задаётся не здесь, а колонкой «ТТХ (коды)» в справочнике типов ТС.',
    'Порядок загрузки: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db.select().from(vehicleSpecs).orderBy(asc(vehicleSpecs.sortOrder), asc(vehicleSpecs.code)),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    shortName: row.shortName,
    unit: row.unit,
    decimals: Number(row.decimals),
    minValue: decimalCell(row.minValue),
    maxValue: decimalCell(row.maxValue),
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    savedCode: row.code,
  }),
  blank: () => ({
    code: '',
    name: '',
    shortName: '',
    unit: '',
    decimals: 0,
    minValue: '',
    maxValue: '',
    description: '',
    sortOrder: 100,
    isActive: true,
  }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx, env) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
    if (m.minValue !== '' && m.maxValue !== '' && Number(m.minValue) > Number(m.maxValue)) {
      ctx.fail('минимум больше максимума — границы ТТХ заданы наоборот');
    }
    // Заведённая запись ищется по прежнему коду: правка ячейки «Код» — это переименование, и
    // спрашивать окружение про новый код значило бы не найти ничего и промолчать про заморозку.
    const saved = m.savedCode === undefined ? undefined : env.saved.get(m.savedCode);
    if (!saved || saved.usedInTypes === 0) return;
    // Единица, масштаб и код входят в смысл канонизации значений: сменив их, файл молча
    // переопределил бы уже заведённые категории — «25» стало бы означать другое, а подпись набора
    // осталась бы прежней. Те же отказы даёт карточка ТТХ (routes/vehicle-specs.ts).
    if (m.savedCode !== m.code) {
      ctx.fail(
        `код ТТХ «${m.savedCode}» изменить нельзя: он привязан к типам ТС и входит в подпись набора значений их категорий`,
      );
    }
    if (m.unit !== saved.unit) {
      ctx.fail(
        `единицу измерения ТТХ «${m.savedCode}» изменить нельзя: он привязан к типам ТС, и значения категорий заданы в «${saved.unit || 'без единицы'}»`,
      );
    }
    if (m.decimals !== saved.decimals) {
      ctx.fail(
        `число знаков после запятой у ТТХ «${m.savedCode}» изменить нельзя: он привязан к типам ТС, и оно входит в канонизацию значений`,
      );
    }
  },
  create: async (tx, m) => {
    await tx.insert(vehicleSpecs).values({
      code: m.code,
      name: m.name,
      shortName: m.shortName,
      unit: m.unit,
      decimals: m.decimals,
      minValue: nullable(m.minValue),
      maxValue: nullable(m.maxValue),
      description: m.description,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(vehicleSpecs)
      .set({
        code: m.code,
        name: m.name,
        shortName: m.shortName,
        unit: m.unit,
        decimals: m.decimals,
        minValue: nullable(m.minValue),
        maxValue: nullable(m.maxValue),
        description: m.description,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(vehicleSpecs.id, row.id));
  },
});

// ── Типы ТС и привязки ТТХ ──

/**
 * Бланк путевого листа словом. Не `waybillFormLabels` — там подписи с пояснением в скобках
 * («Форма 4-П (грузовой автомобиль)»), для ячейки это слишком длинно; и не
 * `waybillFormShortLabels` — «№ 3» в отрыве от столбца журнала не читается. `parseChoice`
 * принимает и сам код ('leg3'), так что выгрузка из другой системы тоже пройдёт.
 */
const WAYBILL_FORM_CELLS: Record<WaybillFormCode, string> = {
  '4p': '4-П',
  leg3: 'Форма № 3',
  esm2: 'ЭСМ-2',
};

interface TypeModel {
  code: string;
  kindCode: string;
  name: string;
  description: string;
  waybillFormCode: WaybillFormCode;
  /** Линейная ли техника (ADR 0100): заказ такого типа ведётся днями, а не неделями. */
  isLinear: boolean;
  /** «вид документа: категория» либо пусто. В идентификатор превращается при записи. */
  defaultQualification: string;
  /** Коды привязанных ТТХ. Привязка = обязательность значения у каждой категории типа. */
  specCodes: string[];
  sortOrder: number;
  isActive: boolean;
  /**
   * Код, под которым тип заведён сейчас. По нему в окружении и находится прежнее состояние: код —
   * ключ строки, и после правки ячейки искать по новому значило бы не найти ничего и промолчать
   * там, где состав ТТХ трогать нельзя. У новой строки поля нет.
   */
  savedCode?: string;
}

interface TypeState {
  id: string;
  kindCode: string;
  specCodes: string[];
  /** Сколько у типа категорий: от этого зависит, можно ли трогать состав ТТХ. */
  categories: number;
  /** Линейность, заведённая сейчас: сравнением с ячейкой ловится попытка переключить её файлом. */
  isLinear: boolean;
}

interface TypesEnv {
  kinds: Map<string, { id: string; isActive: boolean }>;
  specs: Map<string, { id: string; name: string; isActive: boolean }>;
  /** Состояние уже заведённых типов по коду — им проверяются правки состава ТТХ. */
  saved: Map<string, TypeState>;
  kindCodeById: Map<string, string>;
  specCodesByTypeId: Map<string, string[]>;
  qualifications: QualificationIndex;
}

/**
 * Привязки ТТХ к типу приводятся к тому, что перечислено в ячейке. Порядок в ячейке — это порядок
 * полей в карточке категории и частей в её наименовании, поэтому он проставляется целиком, а
 * авто-имена категорий после этого пересобирает сервис (тот же приём, что в маршруте типов).
 */
async function syncTypeSpecs(
  tx: Tx,
  typeId: string,
  typeName: string,
  wanted: readonly string[],
  env: TypesEnv,
): Promise<void> {
  const current = await tx
    .select({ specId: vehicleTypeSpecs.specId, sortOrder: vehicleTypeSpecs.sortOrder })
    .from(vehicleTypeSpecs)
    .where(eq(vehicleTypeSpecs.vehicleTypeId, typeId));
  // Коды уже подтверждены `check()` — иначе строка до записи не дошла бы.
  const wantedIds = wanted.map((code) => env.specs.get(code)!.id);
  let changed = false;

  for (const row of current) {
    if (wantedIds.includes(row.specId)) continue;
    // Значения категорий по этому ТТХ отвязку запрещают (составной FK), и `check()` такую строку
    // уже отверг: сюда доходит только тип без категорий, у которого значений нет вовсе.
    await tx
      .delete(vehicleTypeSpecs)
      .where(
        and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, row.specId)),
      );
    changed = true;
  }

  for (const [index, specId] of wantedIds.entries()) {
    const sortOrder = (index + 1) * 10;
    const existing = current.find((c) => c.specId === specId);
    if (!existing) {
      await tx.insert(vehicleTypeSpecs).values({ vehicleTypeId: typeId, specId, sortOrder });
      changed = true;
    } else if (existing.sortOrder !== sortOrder) {
      await tx
        .update(vehicleTypeSpecs)
        .set({ sortOrder })
        .where(
          and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, specId)),
        );
      changed = true;
    }
  }

  if (changed) await refreshTypeCategories(tx, typeId, typeName);
}

const vehicleTypesDirectory = directory<VehicleTypeRow, TypeModel, TypesEnv>({
  key: 'vehicle-types',
  env: async () => {
    const [kinds, specs, types, bindings, categoryCounts, qualifications] = await Promise.all([
      db
        .select({ id: vehicleKinds.id, code: vehicleKinds.code, isActive: vehicleKinds.isActive })
        .from(vehicleKinds),
      db
        .select({
          id: vehicleSpecs.id,
          code: vehicleSpecs.code,
          name: vehicleSpecs.name,
          isActive: vehicleSpecs.isActive,
        })
        .from(vehicleSpecs),
      db
        .select({
          id: vehicleTypes.id,
          code: vehicleTypes.code,
          kindId: vehicleTypes.kindId,
          isLinear: vehicleTypes.isLinear,
        })
        .from(vehicleTypes),
      db
        .select({
          vehicleTypeId: vehicleTypeSpecs.vehicleTypeId,
          code: vehicleSpecs.code,
          sortOrder: vehicleTypeSpecs.sortOrder,
          name: vehicleSpecs.name,
        })
        .from(vehicleTypeSpecs)
        .innerJoin(vehicleSpecs, eq(vehicleTypeSpecs.specId, vehicleSpecs.id))
        .orderBy(asc(vehicleTypeSpecs.sortOrder), asc(vehicleSpecs.name)),
      db
        .select({ vehicleTypeId: vehicleCategories.vehicleTypeId, count: sql<number>`count(*)` })
        .from(vehicleCategories)
        .groupBy(vehicleCategories.vehicleTypeId),
      loadQualifications(),
    ]);

    const kindCodeById = new Map(kinds.map((k) => [k.id, k.code]));
    const specCodesByTypeId = new Map<string, string[]>();
    for (const b of bindings) {
      specCodesByTypeId.set(b.vehicleTypeId, [
        ...(specCodesByTypeId.get(b.vehicleTypeId) ?? []),
        b.code,
      ]);
    }
    const counts = new Map(categoryCounts.map((c) => [c.vehicleTypeId, Number(c.count)]));

    return {
      kinds: new Map(kinds.map((k) => [k.code, { id: k.id, isActive: k.isActive }])),
      specs: new Map(specs.map((s) => [s.code, { id: s.id, name: s.name, isActive: s.isActive }])),
      saved: new Map(
        types.map((t) => [
          t.code,
          {
            id: t.id,
            kindCode: kindCodeById.get(t.kindId) ?? '',
            specCodes: specCodesByTypeId.get(t.id) ?? [],
            categories: counts.get(t.id) ?? 0,
            isLinear: t.isLinear,
          },
        ]),
      ),
      kindCodeById,
      specCodesByTypeId,
      qualifications,
    };
  },
  columns: () => [
    {
      header: 'Код',
      width: 20,
      hint: 'Ключ записи. Латиница строчными, цифры, подчёркивание.',
      get: (m) => m.code,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.code = v;
      },
    },
    {
      header: 'Вид ТС (код)',
      width: 18,
      hint: 'Код из справочника видов ТС. Незнакомый код — ошибка строки: виды загружают раньше типов.',
      get: (m) => m.kindCode,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.kindCode = v;
      },
    },
    {
      header: 'Наименование',
      width: 34,
      hint: 'Как тип называется в портале: «Автокраны», «Самосвалы».',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Описание',
      width: 40,
      hint: 'Свободный текст. Пустая ячейка стирает заведённое описание.',
      get: (m) => m.description,
      set: (m, text) => {
        m.description = text.trim();
      },
    },
    {
      header: 'Бланк путевого листа',
      width: 18,
      hint: `Каким бланком выписывается лист на машины этого типа: ${Object.values(WAYBILL_FORM_CELLS).join(', ')}. По умолчанию 4-П.`,
      get: (m) => WAYBILL_FORM_CELLS[m.waybillFormCode],
      set: (m, text, ctx) => {
        const v = parseChoice(text, WAYBILL_FORM_CELLS, ctx, 'Бланк путевого листа');
        if (v !== undefined) m.waybillFormCode = v;
      },
    },
    {
      // Рядом с бланком: оба поля отвечают на вопрос «какими документами живёт этот тип», и
      // читают их вместе. Без колонки перенос справочника между установками потерял бы признак
      // молча — тип приехал бы недельным, а заявки по нему уже ведутся днями.
      header: 'Линейная техника',
      width: 16,
      hint: `«да» ставят типу, который вечером возвращается на базу. ${LINEAR_VEHICLE_TYPE_HINT}. По умолчанию «нет». У заведённого типа признак файлом не меняют — только в карточке типа.`,
      get: (m) => boolCell(m.isLinear),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Линейная техника');
        if (v !== undefined) m.isLinear = v;
      },
    },
    {
      header: 'Категория прав по умолчанию',
      width: 26,
      hint: 'Пара «код вида документа: код категории» («driver_license: c»); одного кода категории достаточно, пока он заведён у одного вида документа. Подставляется при заведении машины и отбор не сужает.',
      get: (m) => m.defaultQualification,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.defaultQualification = v;
      },
    },
    {
      header: 'ТТХ (коды)',
      width: 34,
      hint: 'Коды привязанных ТТХ через «;». Привязка означает обязательность: у каждой категории типа будет значение по каждому из них. Пустая ячейка ничего не меняет; снимают ТТХ, убрав его код из перечня.',
      get: (m) => listCell(m.specCodes),
      set: (m, text) => {
        const list = parseList(text).map(codeCell);
        if (list.length > 0) m.specCodes = list;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше тип в списках. По умолчанию 100.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок');
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активен',
      width: 10,
      hint: '«нет» гасит тип: заявок и техники по нему больше не заводят. Удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активен');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Типы ТС — плоский классификатор техники: «Автокраны», «Самосвалы». Тип принадлежит виду ТС и задаёт бланк путевого листа.',
    'Колонка «ТТХ (коды)» — это и есть привязки характеристик: перечисленные ТТХ обязаны иметь значение у каждой категории типа.',
    'Пока у типа есть категории, состав ТТХ файлом не меняют: новому ТТХ нужно значение для каждой заведённой категории, а снятому — согласие потерять значения.',
    'Ссылки — кодами: незнакомый код вида ТС или ТТХ отменяет загрузку целиком, портал ничего не заводит «на лету».',
    'Порядок загрузки: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db.select().from(vehicleTypes).orderBy(asc(vehicleTypes.sortOrder), asc(vehicleTypes.code)),
  id: (row) => row.id,
  model: (row, env) => ({
    code: row.code,
    kindCode: env.kindCodeById.get(row.kindId) ?? '',
    name: row.name,
    description: row.description,
    waybillFormCode: row.waybillFormCode,
    isLinear: row.isLinear,
    defaultQualification: qualificationCell(row.defaultQualificationCategoryId, env.qualifications),
    specCodes: env.specCodesByTypeId.get(row.id) ?? [],
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    savedCode: row.code,
  }),
  blank: () => ({
    code: '',
    kindCode: '',
    name: '',
    description: '',
    waybillFormCode: '4p',
    isLinear: false,
    defaultQualification: '',
    specCodes: [],
    sortOrder: 100,
    isActive: true,
  }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx, env) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');

    const kind = env.kinds.get(m.kindCode);
    if (m.kindCode === '') {
      ctx.fail('строка без вида ТС не заводится: тип принадлежит виду');
    } else if (!kind) {
      ctx.fail(`вид ТС «${m.kindCode}» не найден — сначала загрузите справочник видов ТС`);
    } else if (!kind.isActive && m.isActive) {
      ctx.warn(
        `вид ТС «${m.kindCode}» погашен, а тип активен — в списках портала такой тип не появится`,
      );
    }

    report(findQualification(m.defaultQualification, env.qualifications), ctx);

    for (const code of m.specCodes) {
      if (!env.specs.has(code)) {
        ctx.fail(`ТТХ «${code}» не найден — сначала загрузите справочник ТТХ`);
      }
    }

    const saved = env.saved.get(m.savedCode ?? m.code);
    if (!saved) return;
    if (saved.kindCode !== m.kindCode && env.kinds.has(m.kindCode)) {
      ctx.warn(
        `вид ТС меняется с «${saved.kindCode}» на «${m.kindCode}» — вместе с типом переезжает вся его техника`,
      );
    }
    // Файлом признак не переключают вовсе — даже у типа, за которым сейчас не числится ни одной
    // работающей заявки. Строк в файле сотни, и переключение прошло бы незамеченным, а последствия
    // у него теперь есть: заявки, застигнутые в работе, дорабатывают по прежнему режиму
    // (миграция 0137). Такое решают, глядя на перечень этих заявок в карточке типа, а не пакетом.
    if (saved.isLinear !== m.isLinear) {
      ctx.fail(
        'Признак «Линейная техника» файлом не переключают: его меняют в карточке типа, где портал называет заявки, которые останутся на прежнем режиме',
      );
    }

    if (saved.categories === 0) return;
    // Состав ТТХ и категории типа — один инвариант (ADR 0016). Новый ТТХ мгновенно сделал бы все
    // категории неполными, а снятому нужно удалить значения: и то и другое делают в карточке типа,
    // где спрашивают значение для заполнения и показывают, какие категории станут неразличимы.
    for (const code of saved.specCodes) {
      if (!m.specCodes.includes(code)) {
        ctx.fail(
          `ТТХ «${code}» отвязать нельзя: по нему заданы значения категорий типа (${saved.categories}) — снимают его в карточке типа`,
        );
      }
    }
    for (const code of m.specCodes) {
      if (!saved.specCodes.includes(code) && env.specs.has(code)) {
        ctx.fail(
          `ТТХ «${code}» добавить нельзя: у типа уже есть категории (${saved.categories}), и каждой нужно значение по нему — добавляют такой ТТХ в карточке типа`,
        );
      }
    }
  },
  create: async (tx, m, env) => {
    const [created] = await tx
      .insert(vehicleTypes)
      .values({
        kindId: env.kinds.get(m.kindCode)!.id,
        code: m.code,
        name: m.name,
        description: m.description,
        waybillFormCode: m.waybillFormCode,
        isLinear: m.isLinear,
        defaultQualificationCategoryId: idOf(
          findQualification(m.defaultQualification, env.qualifications),
        ),
        sortOrder: m.sortOrder,
        isActive: m.isActive,
      })
      .returning({ id: vehicleTypes.id });
    await syncTypeSpecs(tx, created!.id, m.name, m.specCodes, env);
  },
  update: async (tx, row, m, env) => {
    // Блокировка строки типа сериализует правки его ТТХ и категорий — та же идиома, что в карточке.
    await lockType(tx, row.id);
    await tx
      .update(vehicleTypes)
      .set({
        kindId: env.kinds.get(m.kindCode)!.id,
        code: m.code,
        name: m.name,
        description: m.description,
        waybillFormCode: m.waybillFormCode,
        isLinear: m.isLinear,
        defaultQualificationCategoryId: idOf(
          findQualification(m.defaultQualification, env.qualifications),
        ),
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(vehicleTypes.id, row.id));
    await syncTypeSpecs(tx, row.id, m.name, m.specCodes, env);
  },
});

// ── Категории типов ТС ──

interface CategoryRow {
  id: string;
  vehicleTypeId: string;
  name: string;
  isAutoName: boolean;
  sortOrder: number;
  isActive: boolean;
}

interface CategoryModel {
  typeCode: string;
  name: string;
  isAutoName: boolean;
  sortOrder: number;
  isActive: boolean;
  /** Значения ТТХ по коду характеристики. Числа — строками: это numeric в базе. */
  values: Map<string, string>;
  /**
   * Чем строка была до правки. Хранится в модели, а не берётся из окружения, потому что искать
   * запись по её же новому набору значений бессмысленно: набор — это и есть ключ, и правка
   * значения меняет именно его. У новой строки поля нет.
   */
  saved?: { typeCode: string; values: string };
}

/** ТТХ в разрезе типа — та же форма, что отдаёт `loadTypeSpecs`, чтобы её принимали функции сервиса. */
type TypeSpec = VehicleTypeSpecDto & { specId: string };

interface CategoriesEnv {
  /** Все заведённые ТТХ: ими задан состав динамических колонок файла. */
  allSpecs: { code: string; name: string; unit: string }[];
  specIdByCode: Map<string, string>;
  types: Map<string, { id: string; name: string; specs: TypeSpec[] }>;
  typeCodeById: Map<string, string>;
  /** Значения заведённых категорий: идентификатор категории → код ТТХ → значение. */
  values: Map<string, Map<string, string>>;
}

/** Заголовок динамической колонки. Пара «наименование + единица» в справочнике ТТХ одна — значит, и заголовок один. */
function specHeader(spec: { name: string; unit: string }): string {
  return spec.unit ? `ТТХ: ${spec.name}, ${spec.unit}` : `ТТХ: ${spec.name}`;
}

/**
 * Набор значений одной строкой — «boom_length=21;lift_capacity=25». Той же формы, что подпись
 * категории в базе (`vehicle_category_signature`), и по той же причине: отсортировано по коду,
 * хвостовые нули убраны, поэтому «21.0» и «21» — один набор.
 *
 * Считается здесь, а не запросом к базе, потому что ключ строки нужен ещё до транзакции — им
 * строки файла сверяются и между собой. В саму колонку `spec_signature` при записи всегда попадает
 * то, что посчитала SQL-функция (`signatureOf`): у неё это обязанность, здесь — только сравнение.
 */
function valuesKey(values: ReadonlyMap<string, string>): string {
  return [...values.entries()]
    .filter(([, v]) => v.trim() !== '')
    .map(([code, v]) => `${code}=${decimalCell(v)}`)
    .sort()
    .join(';');
}

/** Значения модели в том виде, в каком их принимают функции сервиса категорий. */
function valueInputs(m: CategoryModel, env: CategoriesEnv): VehicleCategoryValueInput[] {
  const out: VehicleCategoryValueInput[] = [];
  for (const [code, text] of m.values) {
    const specId = env.specIdByCode.get(code);
    if (specId && text.trim() !== '') out.push({ specId, value: Number(text) });
  }
  return out;
}

const vehicleCategoriesDirectory = directory<CategoryRow, CategoryModel, CategoriesEnv>({
  key: 'vehicle-categories',
  env: async () => {
    const [allSpecs, bindings, types, values] = await Promise.all([
      db
        .select({
          id: vehicleSpecs.id,
          code: vehicleSpecs.code,
          name: vehicleSpecs.name,
          unit: vehicleSpecs.unit,
        })
        .from(vehicleSpecs)
        .orderBy(asc(vehicleSpecs.sortOrder), asc(vehicleSpecs.name)),
      // Тот же запрос, что `loadTypeSpecs`, но сразу по всем типам: на файл в сотню строк иначе
      // пришлось бы по запросу на тип.
      db
        .select({
          vehicleTypeId: vehicleTypeSpecs.vehicleTypeId,
          specId: vehicleSpecs.id,
          code: vehicleSpecs.code,
          name: vehicleSpecs.name,
          shortName: vehicleSpecs.shortName,
          unit: vehicleSpecs.unit,
          decimals: vehicleSpecs.decimals,
          minValue: vehicleSpecs.minValue,
          maxValue: vehicleSpecs.maxValue,
          sortOrder: vehicleTypeSpecs.sortOrder,
          isActive: vehicleSpecs.isActive,
        })
        .from(vehicleTypeSpecs)
        .innerJoin(vehicleSpecs, eq(vehicleTypeSpecs.specId, vehicleSpecs.id))
        .orderBy(asc(vehicleTypeSpecs.sortOrder), asc(vehicleSpecs.name)),
      db
        .select({ id: vehicleTypes.id, code: vehicleTypes.code, name: vehicleTypes.name })
        .from(vehicleTypes),
      db
        .select({
          categoryId: vehicleCategorySpecValues.categoryId,
          code: vehicleSpecs.code,
          value: vehicleCategorySpecValues.valueNum,
        })
        .from(vehicleCategorySpecValues)
        .innerJoin(vehicleSpecs, eq(vehicleCategorySpecValues.specId, vehicleSpecs.id)),
    ]);

    const specsByTypeId = new Map<string, TypeSpec[]>();
    for (const b of bindings) {
      const list = specsByTypeId.get(b.vehicleTypeId) ?? [];
      list.push({
        specId: b.specId,
        code: b.code,
        name: b.name,
        shortName: b.shortName,
        unit: b.unit,
        decimals: Number(b.decimals),
        minValue: b.minValue == null ? null : Number(b.minValue),
        maxValue: b.maxValue == null ? null : Number(b.maxValue),
        sortOrder: b.sortOrder,
        isActive: b.isActive,
      });
      specsByTypeId.set(b.vehicleTypeId, list);
    }

    const byCategory = new Map<string, Map<string, string>>();
    for (const v of values) {
      const map = byCategory.get(v.categoryId) ?? new Map<string, string>();
      map.set(v.code, decimalCell(v.value));
      byCategory.set(v.categoryId, map);
    }

    return {
      allSpecs: allSpecs.map((s) => ({ code: s.code, name: s.name, unit: s.unit })),
      specIdByCode: new Map(allSpecs.map((s) => [s.code, s.id])),
      types: new Map(
        types.map((t) => [
          t.code,
          { id: t.id, name: t.name, specs: specsByTypeId.get(t.id) ?? [] },
        ]),
      ),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
      values: byCategory,
    };
  },
  columns: (env) => [
    {
      header: 'Тип ТС (код)',
      width: 20,
      hint: 'Код из справочника типов ТС. Категория принадлежит типу навсегда: категория другого типа — другая запись.',
      get: (m) => m.typeCode,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.typeCode = v;
      },
    },
    {
      header: 'Название',
      width: 40,
      hint: 'Пусто — портал соберёт название из типа и значений («Автокраны, г/п 25 т»). Заполнено вместе с «Имя задано вручную» = «нет» — тоже соберёт: своё название держится флагом.',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Имя задано вручную',
      width: 12,
      hint: '«да» — название остаётся таким, как написано, и портал его не перезаписывает. «нет» — собирается из типа и значений ТТХ при каждой правке состава характеристик.',
      get: (m) => boolCell(!m.isAutoName),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Имя задано вручную');
        if (v !== undefined) m.isAutoName = !v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше категория в списках. По умолчанию 100.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок');
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» гасит категорию: новой технике её не выбрать, у заведённой она остаётся.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
    // Динамические колонки: по одной на каждый ТТХ портала. Состав берётся из справочника, а не
    // задан списком, потому что категория — это и есть набор значений ТТХ: появился ТТХ — появилась
    // координата, по которой категории различаются.
    ...env.allSpecs.map((spec) => ({
      header: specHeader(spec),
      width: 14,
      hint: `Значение ТТХ «${spec.code}». Пусто — у этого типа такого ТТХ нет. Набор значений и есть категория: строка без «Идентификатора» с другим набором заведёт новую категорию, а не изменит прежнюю.`,
      get: (m: CategoryModel) => decimalCell(m.values.get(spec.code) ?? ''),
      set: (m: CategoryModel, text: string, ctx: RowContext) => {
        const v = parseDecimal(text, ctx, `ТТХ «${spec.code}»`);
        if (v !== undefined) m.values.set(spec.code, v);
      },
    })),
  ],
  help: (env) => [
    'Категории типов ТС — условные подтипы, заданные набором значений ТТХ: «Автокраны, г/п 25 т, стрела 21 м».',
    'Категорию опознаёт набор значений, а не название (ADR 0016). Правка значения — это другая категория: строка без «Идентификатора» с новым набором заведёт её, а прежняя останется.',
    'Набор обязан быть полным: значение нужно по каждому ТТХ, привязанному к типу, и только по ним. Пустая ячейка ТТХ означает, что у этого типа такой характеристики нет.',
    `Колонки «ТТХ: …» — по одной на каждый заведённый ТТХ (сейчас их ${env.allSpecs.length}). Появится новый ТТХ — появится и колонка.`,
    'Порядок загрузки: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db
      .select({
        id: vehicleCategories.id,
        vehicleTypeId: vehicleCategories.vehicleTypeId,
        name: vehicleCategories.name,
        isAutoName: vehicleCategories.isAutoName,
        sortOrder: vehicleCategories.sortOrder,
        isActive: vehicleCategories.isActive,
      })
      .from(vehicleCategories)
      .innerJoin(vehicleTypes, eq(vehicleCategories.vehicleTypeId, vehicleTypes.id))
      .orderBy(
        asc(vehicleTypes.sortOrder),
        asc(vehicleTypes.code),
        asc(vehicleCategories.sortOrder),
        asc(vehicleCategories.name),
      ),
  id: (row) => row.id,
  model: (row, env) => {
    const typeCode = env.typeCodeById.get(row.vehicleTypeId) ?? '';
    const values = new Map(env.values.get(row.id) ?? []);
    return {
      typeCode,
      name: row.name,
      isAutoName: row.isAutoName,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      values,
      saved: { typeCode, values: valuesKey(values) },
    };
  },
  blank: () => ({
    typeCode: '',
    name: '',
    // У дописанной строки название решает само за себя: заполнено — останется как написано, пусто —
    // портал соберёт его из типа и значений. Иначе набранное вручную имя молча потерялось бы.
    isAutoName: false,
    sortOrder: 100,
    isActive: true,
    values: new Map<string, string>(),
  }),
  // Ключ — тип плюс набор значений: именно этим категория и отличается от соседней. Название в
  // ключ не входит вовсе — две категории с одинаковыми значениями и разными именами невозможны.
  keyOf: (m) => compositeKey(m.typeCode, valuesKey(m.values)),
  titleOf: (m) => m.name || `${m.typeCode}: ${valuesKey(m.values)}`,
  check: (m, ctx, env) => {
    if (m.typeCode === '') {
      ctx.fail('строка без кода типа ТС не заводится: категория существует только внутри типа');
      return;
    }
    const type = env.types.get(m.typeCode);
    if (!type) {
      ctx.fail(`тип ТС «${m.typeCode}» не найден — сначала загрузите справочник типов ТС`);
      return;
    }
    if (m.saved && m.saved.typeCode !== m.typeCode) {
      ctx.fail(
        `тип категории изменить нельзя: категория другого типа — другая запись. Заведите её строкой с пустым «Идентификатором»`,
      );
      return;
    }
    // Полнота набора, границы и масштаб значений — правила сервиса категорий, а не файла.
    collectServiceError(ctx, () => checkedValues(valueInputs(m, env), type.specs));
    if (m.saved && m.saved.values !== valuesKey(m.values)) {
      ctx.warn(
        'набор значений ТТХ — это и есть категория: правка меняет смысл записи для всей техники и заявок, которые на неё ссылаются. Чтобы завести соседнюю категорию, очистите «Идентификатор» в этой строке',
      );
    }
  },
  create: async (tx, m, env) => {
    const type = await lockType(tx, env.types.get(m.typeCode)!.id);
    // Состав ТТХ перечитывается под блокировкой типа: окружение читалось до транзакции, и за это
    // время карточка типа могла добавить характеристику — тогда файл завёл бы категорию с неполным
    // набором, а отложенный триггер отменил бы всю загрузку на COMMIT.
    const specs = await loadTypeSpecs(tx, type.id);
    const values = checkedValues(valueInputs(m, env), specs);
    const signature = await signatureOf(tx, specs, values);
    await assertSignatureFree(tx, type.id, signature);

    const auto = m.isAutoName || m.name.trim() === '';
    const name = auto
      ? buildVehicleCategoryName(type.name, valueDtos(specs, values))
      : m.name.trim();

    const [created] = await tx
      .insert(vehicleCategories)
      .values({
        vehicleTypeId: type.id,
        name,
        isAutoName: auto,
        specSignature: signature,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
      })
      .returning({ id: vehicleCategories.id });
    // Значения вставляются следом за категорией: полноту набора проверяет отложенный триггер на
    // COMMIT, поэтому промежуточное состояние внутри транзакции допустимо.
    await tx.insert(vehicleCategorySpecValues).values(
      specs.map((s) => ({
        categoryId: created!.id,
        vehicleTypeId: type.id,
        specId: s.specId,
        valueNum: valueToColumn(values.get(s.specId)!, s),
      })),
    );
  },
  update: async (tx, row, m, env) => {
    const type = await lockType(tx, row.vehicleTypeId);
    const specs = await loadTypeSpecs(tx, type.id);
    const values = checkedValues(valueInputs(m, env), specs);
    const signature = await signatureOf(tx, specs, values);
    await assertSignatureFree(tx, type.id, signature, row.id);

    for (const s of specs) {
      await tx
        .update(vehicleCategorySpecValues)
        .set({ valueNum: valueToColumn(values.get(s.specId)!, s) })
        .where(
          and(
            eq(vehicleCategorySpecValues.categoryId, row.id),
            eq(vehicleCategorySpecValues.specId, s.specId),
          ),
        );
    }

    const auto = m.isAutoName || m.name.trim() === '';
    const name = auto
      ? buildVehicleCategoryName(type.name, valueDtos(specs, values))
      : m.name.trim();
    await tx
      .update(vehicleCategories)
      .set({
        name,
        isAutoName: auto,
        specSignature: signature,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(vehicleCategories.id, row.id));
  },
});

// ── Модели техники ──

interface ModelRow {
  id: string;
  vehicleTypeId: string;
  name: string;
  manufacturerName: string;
  description: string;
  isActive: boolean;
}

interface ModelModel {
  typeCode: string;
  name: string;
  manufacturerName: string;
  description: string;
  isActive: boolean;
}

interface ModelsEnv {
  types: Map<string, { id: string }>;
  typeCodeById: Map<string, string>;
}

const vehicleModelsDirectory = directory<ModelRow, ModelModel, ModelsEnv>({
  key: 'vehicle-models',
  env: async () => {
    const types = await db
      .select({ id: vehicleTypes.id, code: vehicleTypes.code })
      .from(vehicleTypes);
    return {
      types: new Map(types.map((t) => [t.code, { id: t.id }])),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
    };
  },
  columns: () => [
    {
      header: 'Тип ТС (код)',
      width: 20,
      hint: 'Код из справочника типов ТС. Одинаковое наименование в разных типах — разные записи: модель принадлежит типу.',
      get: (m) => m.typeCode,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.typeCode = v;
      },
    },
    {
      header: 'Наименование',
      width: 30,
      hint: 'Марка и модель одной строкой: «КС-45717А-1Р», «HINO 300 XZU730L». Вторая часть ключа: регистр, дефисы и пробелы при сравнении не различаются.',
      get: (m) => m.name,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.name = v;
      },
    },
    {
      header: 'Изготовитель',
      width: 30,
      hint: 'Завод-изготовитель текстом: «ОАО «Автокран»». Отдельного справочника изготовителей нет.',
      get: (m) => m.manufacturerName,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.manufacturerName = v;
      },
    },
    {
      header: 'Описание',
      width: 40,
      hint: 'Свободный текст. Пустая ячейка стирает заведённое описание.',
      get: (m) => m.description,
      set: (m, text) => {
        m.description = text.trim();
      },
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» гасит модель: новой технике её не выбрать, у заведённой она остаётся.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Модели техники — марка и модель одной записью: «Mustang 2700V», «МАЗ 6501В5».',
    'Модель принадлежит типу ТС: ключ строки — тип плюс наименование, и одно и то же имя в двух типах даёт две записи.',
    'Наименования сравниваются без учёта регистра, дефисов и пробелов: «КС 45719-5А» и «КС-45719 5А» — одна модель.',
    'Транслитерация не делается: «Мустанг» и «Mustang» — разные наименования, и выбирает между ними человек.',
    'Порядок загрузки: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db
      .select({
        id: vehicleModels.id,
        vehicleTypeId: vehicleModels.vehicleTypeId,
        name: vehicleModels.name,
        manufacturerName: vehicleModels.manufacturerName,
        description: vehicleModels.description,
        isActive: vehicleModels.isActive,
      })
      .from(vehicleModels)
      .innerJoin(vehicleTypes, eq(vehicleModels.vehicleTypeId, vehicleTypes.id))
      .orderBy(asc(vehicleTypes.code), asc(vehicleModels.name)),
  id: (row) => row.id,
  model: (row, env) => ({
    typeCode: env.typeCodeById.get(row.vehicleTypeId) ?? '',
    name: row.name,
    manufacturerName: row.manufacturerName,
    description: row.description,
    isActive: row.isActive,
  }),
  blank: () => ({
    typeCode: '',
    name: '',
    manufacturerName: '',
    description: '',
    isActive: true,
  }),
  keyOf: (m) => compositeKey(m.typeCode, normalizeModelName(m.name)),
  titleOf: (m) => m.name || m.typeCode,
  check: (m, ctx, env) => {
    if (m.typeCode === '') {
      ctx.fail('строка без кода типа ТС не заводится: модель принадлежит типу');
    } else if (!env.types.has(m.typeCode)) {
      ctx.fail(`тип ТС «${m.typeCode}» не найден — сначала загрузите справочник типов ТС`);
    }
    if (m.name === '') ctx.fail('строка без наименования не заводится');
    if (m.name !== '' && normalizeModelName(m.name) === '') {
      ctx.fail(
        `наименование «${m.name}» состоит из одних разделителей — по нему модель не опознать`,
      );
    }
  },
  create: async (tx, m, env) => {
    await tx.insert(vehicleModels).values({
      vehicleTypeId: env.types.get(m.typeCode)!.id,
      name: m.name,
      manufacturerName: m.manufacturerName,
      description: m.description,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m, env) => {
    await tx
      .update(vehicleModels)
      .set({
        vehicleTypeId: env.types.get(m.typeCode)!.id,
        name: m.name,
        manufacturerName: m.manufacturerName,
        description: m.description,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(vehicleModels.id, row.id));
  },
});

// ── Техника ──

interface VehicleModel {
  ownership: VehicleOwnership;
  typeCode: string;
  categoryName: string;
  modelName: string;
  registrationNumber: string;
  inventoryNumber: string;
  garageNumber: string;
  serialNumber: string;
  passportNumber: string;
  manufacturerName: string;
  /** «ГГГГ-ММ-ДД» либо пусто: в файле — «ДД.ММ.ГГГГ», как её читает человек. */
  manufacturedOn: string;
  requiredQualification: string;
  ownerOrganization: string;
  lessorInn: string;
  description: string;
  pricePerHour: string;
  pricePerShift: string;
  shiftHours: number | null;
  status: VehicleStatus;
  sourceName: string;
  note: string;
  /**
   * Принадлежность заведённой записи. Ветку меняет только заведение новой записи (ADR 0018), а
   * узнать прежнюю по модели неоткуда: ключ у веток разный, и после правки ячейки строка искалась
   * бы уже не там, где заведена.
   */
  savedOwnership?: VehicleOwnership;
}

interface VehiclesEnv {
  types: Map<string, { id: string }>;
  typeCodeById: Map<string, string>;
  /** Категория ищется внутри типа: одноимённые категории разных типов — разные записи. */
  categories: Map<string, { id: string; isActive: boolean }>;
  categoryNameById: Map<string, string>;
  models: Map<string, { id: string }>;
  modelNameById: Map<string, string>;
  lessors: Map<string, { id: string; name: string; isActive: boolean }>;
  lessorInnById: Map<string, string>;
  organizations: Map<string, { id: string }>;
  organizationNameById: Map<string, string>;
  qualifications: QualificationIndex;
}

function findType(code: string, env: VehiclesEnv): Lookup {
  if (code.trim() === '') return null;
  const type = env.types.get(code);
  return type
    ? { id: type.id }
    : { fail: `тип ТС «${code}» не найден — сначала загрузите справочник типов ТС` };
}

function findCategory(m: VehicleModel, env: VehiclesEnv): Lookup {
  if (m.categoryName.trim() === '') return null;
  const found = env.categories.get(compositeKey(m.typeCode, m.categoryName.toLowerCase()));
  return found
    ? { id: found.id }
    : {
        fail: `категория «${m.categoryName}» не найдена у типа «${m.typeCode}» — сначала загрузите справочник категорий типов ТС`,
      };
}

function findModel(m: VehicleModel, env: VehiclesEnv): Lookup {
  if (m.modelName.trim() === '') return null;
  const found = env.models.get(compositeKey(m.typeCode, normalizeModelName(m.modelName)));
  return found
    ? { id: found.id }
    : {
        fail: `марка/модель «${m.modelName}» не найдена у типа «${m.typeCode}» — сначала загрузите справочник моделей техники`,
      };
}

function findLessor(inn: string, env: VehiclesEnv): Lookup {
  if (inn.trim() === '') return null;
  const found = env.lessors.get(inn.trim());
  return found
    ? { id: found.id }
    : {
        fail: `арендодатель с ИНН ${inn.trim()} не найден — сначала загрузите справочник контрагентов; арендодателем может быть только контрагент роли «Арендодатель (ТС)»`,
      };
}

function findOrganization(text: string, env: VehiclesEnv): Lookup {
  const v = text.trim();
  if (v === '') return null;
  const found = env.organizations.get(v.toLowerCase());
  return found
    ? { id: found.id }
    : { fail: `организация «${v}» не найдена — сначала загрузите справочник организаций` };
}

const vehiclesDirectory = directory<VehicleRow, VehicleModel, VehiclesEnv>({
  key: 'vehicles',
  env: async () => {
    const [types, categories, models, lessors, orgs, qualifications] = await Promise.all([
      db.select({ id: vehicleTypes.id, code: vehicleTypes.code }).from(vehicleTypes),
      db
        .select({
          id: vehicleCategories.id,
          name: vehicleCategories.name,
          isActive: vehicleCategories.isActive,
          typeCode: vehicleTypes.code,
        })
        .from(vehicleCategories)
        .innerJoin(vehicleTypes, eq(vehicleCategories.vehicleTypeId, vehicleTypes.id)),
      db
        .select({ id: vehicleModels.id, name: vehicleModels.name, typeCode: vehicleTypes.code })
        .from(vehicleModels)
        .innerJoin(vehicleTypes, eq(vehicleModels.vehicleTypeId, vehicleTypes.id)),
      db
        .select({
          id: counterparties.id,
          inn: counterparties.inn,
          name: counterparties.name,
          isActive: counterparties.isActive,
        })
        .from(counterparties)
        .where(and(eq(counterparties.type, 'vehicle_lessor'), isNull(counterparties.deletedAt))),
      db
        .select({ id: organizations.id, name: organizations.name, inn: organizations.inn })
        .from(organizations),
      loadQualifications(),
    ]);

    // Организация ищется наименованием, а ИНН принимается вторым ключом: в выгрузках из учётной
    // системы юрлицо называют по-разному, а ИНН у него один.
    const organizationsByKey = new Map<string, { id: string }>();
    for (const o of orgs) {
      organizationsByKey.set(o.name.trim().toLowerCase(), { id: o.id });
      if (o.inn !== '') organizationsByKey.set(o.inn, { id: o.id });
    }

    return {
      types: new Map(types.map((t) => [t.code, { id: t.id }])),
      typeCodeById: new Map(types.map((t) => [t.id, t.code])),
      categories: new Map(
        categories.map((c) => [
          compositeKey(c.typeCode, c.name.toLowerCase()),
          { id: c.id, isActive: c.isActive },
        ]),
      ),
      categoryNameById: new Map(categories.map((c) => [c.id, c.name])),
      models: new Map(
        models.map((m) => [compositeKey(m.typeCode, normalizeModelName(m.name)), { id: m.id }]),
      ),
      modelNameById: new Map(models.map((m) => [m.id, m.name])),
      lessors: new Map(
        lessors.map((l) => [l.inn, { id: l.id, name: l.name, isActive: l.isActive }]),
      ),
      lessorInnById: new Map(lessors.map((l) => [l.id, l.inn])),
      organizations: organizationsByKey,
      organizationNameById: new Map(orgs.map((o) => [o.id, o.name])),
      qualifications,
    };
  },
  columns: () => [
    {
      header: 'Принадлежность',
      width: 14,
      hint: `«${vehicleOwnershipLabels.own}» — машина портала, «${vehicleOwnershipLabels.rental}» — предложение арендодателя. У веток не пересекается ни один реквизит, и сменить её у заведённой записи нельзя: это другая запись.`,
      get: (m) => vehicleOwnershipLabels[m.ownership],
      set: (m, text, ctx) => {
        const v = parseChoice(text, vehicleOwnershipLabels, ctx, 'Принадлежность');
        if (v !== undefined) m.ownership = v;
      },
    },
    {
      header: 'Тип ТС (код)',
      width: 18,
      hint: 'Код из справочника типов ТС. Обязателен у обеих веток.',
      get: (m) => m.typeCode,
      set: (m, text) => {
        const v = codeCell(text);
        if (v !== '') m.typeCode = v;
      },
    },
    {
      header: 'Категория (название)',
      width: 40,
      hint: 'Название категории этого же типа ТС. Пусто — категория не проставлена; убирают её в карточке техники.',
      get: (m) => m.categoryName,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.categoryName = v;
      },
    },
    {
      header: 'Марка/модель',
      width: 28,
      hint: 'Наименование из справочника моделей — того же типа ТС. Только у собственной машины: у предложения аренды марки нет.',
      get: (m) => m.modelName,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.modelName = v;
      },
    },
    {
      header: 'Госномер',
      width: 14,
      hint: 'Ключ собственной машины. Разделители и раскладка при сравнении не различаются: «В 094 ЕТ 77» и «B094ET77» — один номер. У аренды не заполняется.',
      get: (m) => m.registrationNumber,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.registrationNumber = v;
      },
    },
    {
      header: 'Инвентарный номер',
      width: 16,
      hint: 'Инвентарный номер из учётной системы.',
      get: (m) => m.inventoryNumber,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.inventoryNumber = v;
      },
    },
    {
      header: 'Гаражный номер',
      width: 16,
      hint: 'Своя графа бланка путевого листа, отдельная от инвентарного.',
      get: (m) => m.garageNumber,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.garageNumber = v;
      },
    },
    {
      header: 'Заводской номер',
      width: 20,
      hint: 'VIN либо заводской номер машины.',
      get: (m) => m.serialNumber,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.serialNumber = v;
      },
    },
    {
      header: 'Паспорт',
      width: 16,
      hint: 'Номер ПТС или ПСМ. Только у собственной машины.',
      get: (m) => m.passportNumber,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.passportNumber = v;
      },
    },
    {
      header: 'Изготовитель',
      width: 28,
      hint: 'Завод-изготовитель текстом — как в паспорте машины.',
      get: (m) => m.manufacturerName,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.manufacturerName = v;
      },
    },
    {
      header: 'Год выпуска (дата)',
      width: 14,
      hint: 'Дата выпуска «ДД.ММ.ГГГГ». В учётных выгрузках у неё часто известен только год — тогда пишут 01.01.ГГГГ.',
      get: (m) => dateCell(m.manufacturedOn),
      set: (m, text, ctx) => {
        const v = parseDate(text, ctx, 'Год выпуска');
        if (v !== undefined) m.manufacturedOn = v;
      },
    },
    {
      header: 'Требуемая категория прав',
      width: 24,
      hint: 'Пара «код вида документа: код категории» («driver_license: c»). Стоит у машины, а не у типа: категорию определяет разрешённая максимальная масса. Пусто — требование не заведено, и отбор водителей не сужается.',
      get: (m) => m.requiredQualification,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.requiredQualification = v;
      },
    },
    {
      header: 'Владелец (организация)',
      width: 30,
      hint: 'Наименование юрлица из справочника организаций (принимается и ИНН) — за ним числится машина и от его имени выписывается путевой лист. Пусто — за основной организацией.',
      get: (m) => m.ownerOrganization,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.ownerOrganization = v;
      },
    },
    {
      header: 'Арендодатель (ИНН)',
      width: 16,
      hint: 'ИНН контрагента роли «Арендодатель (ТС)». Обязателен у аренды и не заполняется у своей машины.',
      get: (m) => m.lessorInn,
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.lessorInn = v;
      },
    },
    {
      header: 'Описание предложения',
      width: 34,
      // Пусто здесь законно значит «стереть»: у собственной машины описание обязано быть пустым,
      // и та же ячейка, которой его заполняли, должна уметь его убрать.
      hint: 'Короткий срез предложения аренды: «Автокран 70 тн». Вместе с ИНН арендодателя и типом ТС — ключ строки, поэтому у одного арендодателя по одному типу описания не повторяются. У своей машины не заполняется.',
      get: (m) => m.description,
      set: (m, text) => {
        m.description = text.trim();
      },
    },
    {
      header: 'Цена за час',
      width: 12,
      hint: 'Рубли за машино-час. Только у аренды; хотя бы одна из двух цен обязательна.',
      get: (m) => decimalCell(m.pricePerHour),
      set: (m, text, ctx) => {
        const v = parseDecimal(text, ctx, 'Цена за час', { min: 0 });
        if (v !== undefined) m.pricePerHour = v;
      },
    },
    {
      header: 'Цена за смену',
      width: 12,
      hint: 'Рубли за машино-смену. Только у аренды.',
      get: (m) => decimalCell(m.pricePerShift),
      set: (m, text, ctx) => {
        const v = parseDecimal(text, ctx, 'Цена за смену', { min: 0 });
        if (v !== undefined) m.pricePerShift = v;
      },
    },
    {
      header: 'Часов в смене',
      width: 10,
      hint: 'От 1 до 24. Только у аренды: им считается смена в акте.',
      get: (m) => intCell(m.shiftHours),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Часов в смене', { min: 1, max: 24 });
        if (v !== undefined) m.shiftHours = v;
      },
    },
    {
      header: 'Статус',
      width: 16,
      hint: `${Object.values(vehicleStatusLabels).join(', ')}. У предложения аренды — только «${vehicleStatusLabels.active}» и «${vehicleStatusLabels.inactive}»: состояний машины у него нет.`,
      get: (m) => vehicleStatusLabels[m.status],
      set: (m, text, ctx) => {
        const v = parseChoice(text, vehicleStatusLabels, ctx, 'Статус');
        if (v !== undefined) m.status = v;
      },
    },
    {
      header: 'Источник',
      width: 30,
      hint: 'Откуда взята строка: «Список автотехники на 23.07.26». Пустая ячейка стирает заведённое значение.',
      get: (m) => m.sourceName,
      set: (m, text) => {
        m.sourceName = text.trim();
      },
    },
    {
      header: 'Примечание',
      width: 40,
      hint: 'Свободный текст. Пустая ячейка стирает заведённое примечание.',
      get: (m) => m.note,
      set: (m, text) => {
        m.note = text.trim();
      },
    },
  ],
  help: () => [
    'Техника — собственные машины портала и предложения аренды в одном справочнике (ADR 0018). Ветку задаёт колонка «Принадлежность», и наборы полей у веток не пересекаются.',
    'Ключ собственной машины — госномер; ключ предложения аренды — ИНН арендодателя, код типа ТС и описание предложения.',
    'Удалённая техника в файл не попадает: её восстанавливают из архива, а не загрузкой.',
    'Ссылки — кодами, наименованиями и ИНН: тип ТС, категория и марка/модель должны быть заведены заранее, арендодатель — контрагентом роли «Арендодатель (ТС)».',
    'Порядок загрузки: виды → ТТХ → типы → категории → модели → техника.',
  ],
  load: () =>
    db
      .select()
      .from(vehicles)
      .where(isNull(vehicles.deletedAt))
      .orderBy(
        asc(vehicles.ownership),
        asc(vehicles.registrationNumberNormalized),
        asc(vehicles.description),
      ),
  id: (row) => row.id,
  model: (row, env) => ({
    ownership: row.ownership,
    typeCode: env.typeCodeById.get(row.vehicleTypeId) ?? '',
    categoryName: row.vehicleCategoryId
      ? (env.categoryNameById.get(row.vehicleCategoryId) ?? '')
      : '',
    modelName: row.vehicleModelId ? (env.modelNameById.get(row.vehicleModelId) ?? '') : '',
    registrationNumber: row.registrationNumber ?? '',
    inventoryNumber: row.inventoryNumber ?? '',
    garageNumber: row.garageNumber ?? '',
    serialNumber: row.serialNumber ?? '',
    passportNumber: row.passportNumber ?? '',
    manufacturerName: row.manufacturerName,
    manufacturedOn: row.manufacturedOn ?? '',
    requiredQualification: qualificationCell(
      row.requiredQualificationCategoryId,
      env.qualifications,
    ),
    ownerOrganization: row.ownerOrganizationId
      ? (env.organizationNameById.get(row.ownerOrganizationId) ?? '')
      : '',
    lessorInn: row.lessorId ? (env.lessorInnById.get(row.lessorId) ?? '') : '',
    description: row.description,
    pricePerHour: decimalCell(row.pricePerHour),
    pricePerShift: decimalCell(row.pricePerShift),
    shiftHours: row.shiftHours === null ? null : Number(row.shiftHours),
    status: row.status,
    sourceName: row.sourceName,
    note: row.note,
    savedOwnership: row.ownership,
  }),
  blank: () => ({
    ownership: 'own',
    typeCode: '',
    categoryName: '',
    modelName: '',
    registrationNumber: '',
    inventoryNumber: '',
    garageNumber: '',
    serialNumber: '',
    passportNumber: '',
    manufacturerName: '',
    manufacturedOn: '',
    requiredQualification: '',
    ownerOrganization: '',
    lessorInn: '',
    description: '',
    pricePerHour: '',
    pricePerShift: '',
    shiftHours: null,
    status: 'active',
    sourceName: '',
    note: '',
  }),
  keyOf: (m) =>
    m.ownership === 'own'
      ? normalizeRegistration(m.registrationNumber)
      : compositeKey(m.lessorInn, m.typeCode, m.description),
  titleOf: (m) =>
    m.registrationNumber ||
    (m.description ? `${m.description} (${m.lessorInn})` : '') ||
    m.inventoryNumber ||
    m.typeCode,
  check: (m, ctx, env) => {
    if (m.savedOwnership !== undefined && m.savedOwnership !== m.ownership) {
      ctx.fail(
        'принадлежность заведённой записи изменить нельзя: собственная машина и предложение аренды — разные записи с непересекающимися реквизитами',
      );
      return;
    }

    if (m.typeCode === '') ctx.fail('строка без кода типа ТС не заводится: тип есть у обеих веток');
    report(findType(m.typeCode, env), ctx);
    report(findCategory(m, env), ctx);
    report(findQualification(m.requiredQualification, env.qualifications), ctx);
    report(findOrganization(m.ownerOrganization, env), ctx);

    const category = env.categories.get(compositeKey(m.typeCode, m.categoryName.toLowerCase()));
    if (category && !category.isActive) {
      ctx.warn(
        `категория «${m.categoryName}» погашена — новой технике её в портале уже не выбрать`,
      );
    }

    // Ветки различают CHECK'и в базе (ADR 0018 §1–2). Здесь они проверяются заранее и словами:
    // отказ базы назвал бы имя ограничения, а не то, какую ячейку человеку чистить.
    if (m.ownership === 'own') {
      report(findModel(m, env), ctx);
      const rental: [string, string][] = [
        ['Арендодатель (ИНН)', m.lessorInn],
        ['Описание предложения', m.description],
        ['Цена за час', m.pricePerHour],
        ['Цена за смену', m.pricePerShift],
        ['Часов в смене', m.shiftHours === null ? '' : String(m.shiftHours)],
      ];
      const filled = rental.filter(([, v]) => v.trim() !== '').map(([name]) => name);
      if (filled.length > 0) {
        ctx.fail(
          `у собственной машины не заполняют реквизиты аренды: ${filled.join(', ')}. Если это предложение арендодателя, поставьте «${vehicleOwnershipLabels.rental}» в колонке «Принадлежность»`,
        );
      }
      if (m.registrationNumber.trim() === '') {
        ctx.warn(
          'госномер не заполнен — по нему собственная машина и ищется в справочнике. Строку без номера повторная загрузка опознает только по «Идентификатору»',
        );
      }
      return;
    }

    const lessor = findLessor(m.lessorInn, env);
    if (lessor === null) {
      ctx.fail('у предложения аренды обязателен ИНН арендодателя');
    } else {
      report(lessor, ctx);
    }
    const own: [string, string][] = [
      ['Марка/модель', m.modelName],
      ['Госномер', m.registrationNumber],
      ['Паспорт', m.passportNumber],
    ];
    const filled = own.filter(([, v]) => v.trim() !== '').map(([name]) => name);
    if (filled.length > 0) {
      ctx.fail(
        `у предложения аренды не заполняют реквизиты машины: ${filled.join(', ')}. Предложение описывает не конкретную машину, а то, что арендодатель готов подать`,
      );
    }
    if (m.pricePerHour.trim() === '' && m.pricePerShift.trim() === '') {
      ctx.fail('у предложения аренды нужна хотя бы одна цена — за час или за смену');
    }
    // Ноль ценой не бывает: договорную цену в прайсе оставляют пустой, а не нулём (ADR 0018), и в
    // базе это отдельный CHECK — здесь он объясняется словами.
    for (const [label, price] of [
      ['Цена за час', m.pricePerHour],
      ['Цена за смену', m.pricePerShift],
    ] as const) {
      if (price.trim() !== '' && Number(price) <= 0) {
        ctx.fail(
          `${label} — цена аренды должна быть больше нуля; договорную цену оставляют пустой`,
        );
      }
    }
    if (m.description.trim() === '') {
      ctx.warn(
        'описание предложения не заполнено — вместе с арендодателем и типом ТС оно и опознаёт строку. Предложение без описания повторная загрузка узнает только по «Идентификатору»',
      );
    }
    if (m.status !== 'active' && m.status !== 'inactive') {
      ctx.fail(
        `статус «${vehicleStatusLabels[m.status]}» бывает только у собственной машины: у предложения аренды состояний машины нет`,
      );
    }
    const found = env.lessors.get(m.lessorInn.trim());
    if (found && !found.isActive && m.status === 'active') {
      ctx.fail(
        `арендодатель «${found.name}» неактивен — активного предложения у него быть не может; поставьте статус «${vehicleStatusLabels.inactive}»`,
      );
    }
  },
  create: async (tx, m, env) => {
    await tx.insert(vehicles).values(vehicleValues(m, env));
  },
  update: async (tx, row, m, env) => {
    await tx
      .update(vehicles)
      .set({ ...vehicleValues(m, env), updatedAt: new Date() })
      .where(eq(vehicles.id, row.id));
  },
});

/**
 * Строка техники для записи. Одна сборка на заведение и обновление: у веток разные наборы полей, и
 * собери их два раза — они разошлись бы ровно там, где ветка меняет смысл колонки.
 */
function vehicleValues(m: VehicleModel, env: VehiclesEnv): typeof vehicles.$inferInsert {
  const common = {
    ownership: m.ownership,
    vehicleTypeId: env.types.get(m.typeCode)!.id,
    vehicleCategoryId: idOf(findCategory(m, env)),
    inventoryNumber: nullable(m.inventoryNumber),
    garageNumber: nullable(m.garageNumber),
    serialNumber: nullable(m.serialNumber),
    manufacturerName: m.manufacturerName,
    manufacturedOn: nullable(m.manufacturedOn),
    requiredQualificationCategoryId: idOf(
      findQualification(m.requiredQualification, env.qualifications),
    ),
    ownerOrganizationId: idOf(findOrganization(m.ownerOrganization, env)),
    status: m.status,
    sourceName: m.sourceName,
    note: m.note,
  };

  if (m.ownership === 'own') {
    return {
      ...common,
      vehicleModelId: idOf(findModel(m, env)),
      registrationNumber: nullable(m.registrationNumber),
      passportNumber: nullable(m.passportNumber),
      // Реквизиты аренды у своей машины обязаны быть пустыми (vehicles_own_fields_check).
      lessorId: null,
      lessorType: null,
      lessorIsActive: null,
      description: '',
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
    };
  }

  const lessor = env.lessors.get(m.lessorInn.trim())!;
  return {
    ...common,
    vehicleModelId: null,
    registrationNumber: null,
    passportNumber: null,
    lessorId: lessor.id,
    // Служебные поля — цель составного FK на (id, тип, активность) контрагента; человек их не
    // задаёт, а активность дальше ведёт каскад самого ключа.
    lessorType: 'vehicle_lessor',
    lessorIsActive: lessor.isActive,
    description: m.description,
    pricePerHour: nullable(m.pricePerHour),
    pricePerShift: nullable(m.pricePerShift),
    shiftHours: m.shiftHours,
  };
}

export const vehicleDirectories: AnyDirectory[] = [
  vehicleKindsDirectory,
  vehicleSpecsDirectory,
  vehicleTypesDirectory,
  vehicleCategoriesDirectory,
  vehicleModelsDirectory,
  vehiclesDirectory,
];
