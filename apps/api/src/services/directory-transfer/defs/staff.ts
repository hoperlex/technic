import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  CREDENTIAL_TYPE_CODES,
  type CredentialTypeCode,
  credentialTypeShortLabels,
  EMAIL_FORMAT_MESSAGE,
  emailSchema,
  formatFullName,
  formatPhone,
  formatSnils,
  isValidSnils,
  jobTitleCredentialType,
  looksLikeDriverLicense,
  normalizePhone,
  normalizeSnils,
  PHONE_FORMAT_MESSAGE,
  splitFullName,
} from '@technic/contracts';
import { db } from '../../../db/client';
import {
  credentialTypes,
  type CredentialTypeRow,
  personCredentialCategories,
  personCredentials,
  personEmployments,
  persons,
  personSpecializations,
  qualificationCategories,
  specializations,
  type SpecializationRow,
} from '../../../db/schema';
import { parseCategoryCodes } from '../../driver-import';
import {
  DirectoriesNotSeededError,
  LICENSE_COMMENT,
  licenseWithRequisitesComment,
} from '../../driver-import-apply';
import { DRIVER_SPECIALIZATION_CODE } from '../../drivers';
import {
  boolCell,
  dateCell,
  intCell,
  listCell,
  parseBool,
  parseDate,
  parseInt10,
  parseList,
  parseRequired,
} from '../cells';
import {
  directory,
  type AnyDirectory,
  type DirectoryColumn,
  type RowContext,
  type Tx,
} from '../types';

/**
 * Кадровые справочники обмена (ADR 0073): специализации, виды документов, категории квалификаций
 * и водители.
 *
 * Самая чувствительная часть обмена: в строке водителя лежат ФИО, СНИЛС и реквизиты двух
 * документов живого человека. Отсюда два правила, которых нет у остальных справочников.
 *
 * Первое: правила разбора кадровой строки не переписываются. Контрольная сумма СНИЛС, разбор ФИО,
 * коды категорий и правило «должность называет документ» (ADR 0049, ADR 0095) остаются там, где их
 * уже проверяет тест, — в `driver-import.ts` и общем пакете; здесь они только вызываются. Второй
 * набор тех же правил означал бы, что через файл в справочник попадает то, чего не принимает
 * форма, — и наоборот.
 *
 * Второе: файл добавляет и уточняет, но не отнимает. Категории документа строкой таблицы не
 * снимаются (см. `distributeCategories`), заведённые реквизиты пустой ячейкой не стираются, а
 * удалённых людей в выгрузке нет вовсе.
 */

/** Окружение справочника, которому не на что ссылаться. */
type NoEnv = Record<string, never>;

// ── Общее у трёх классификаторов ──

/**
 * Специализации, виды документов и категории квалификаций устроены одинаково: код, наименование,
 * описание, порядок, признак «действует». Колонки им собирают общие функции, а не три копии одного
 * кода: разойдись у них разбор или подсказка — человек, заполнивший один файл по образцу соседнего,
 * получил бы отказ на ровном месте.
 */
interface RefModel {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Формат кода. Проверяется здесь, а не только ограничением БД (`^[a-z][a-z0-9_]*$` стоит на всех
 * трёх таблицах): иначе одна строка с кириллическим кодом отменяла бы загрузку целиком, а человек
 * читал бы про нарушенный constraint вместо того, что от него хотят.
 */
const CODE_FORMAT = /^[a-z][a-z0-9_]*$/u;

function codeColumn<M extends RefModel>(hint: string): DirectoryColumn<M> {
  return {
    header: 'Код',
    width: 18,
    hint,
    get: (m) => m.code,
    set: (m, text, ctx) => {
      const v = parseRequired(text, ctx, 'Код', m.code);
      if (v === undefined) return;
      // Регистр снимается, а не отвергается: «DRIVER» в таблице — привычка Excel к заглавным, а не
      // другой код, и заводить по ней вторую запись рядом с заведённой незачем.
      const code = v.toLowerCase();
      if (!CODE_FORMAT.test(code)) {
        ctx.fail(
          `Код — латиница строчными, цифры и подчёркивание, начиная с буквы; получено «${v}»`,
        );
        return;
      }
      m.code = code;
    },
  };
}

function nameColumn<M extends RefModel>(hint: string): DirectoryColumn<M> {
  return {
    header: 'Наименование',
    width: 38,
    hint,
    get: (m) => m.name,
    set: (m, text, ctx) => {
      const v = parseRequired(text, ctx, 'Наименование', m.name);
      if (v !== undefined) m.name = v;
    },
  };
}

function descriptionColumn<M extends RefModel>(hint: string): DirectoryColumn<M> {
  return {
    header: 'Описание',
    width: 48,
    hint,
    get: (m) => m.description,
    // Присваивание напрямую, мимо `cells.ts`: у описания пустая ячейка законно означает «стереть» —
    // пояснение убирают тем же способом, каким его писали, и другого места для этого нет.
    set: (m, text) => {
      m.description = text.trim();
    },
  };
}

function sortOrderColumn<M extends RefModel>(hint: string): DirectoryColumn<M> {
  return {
    header: 'Порядок',
    width: 10,
    hint,
    get: (m) => intCell(m.sortOrder),
    set: (m, text, ctx) => {
      const v = parseInt10(text, ctx, 'Порядок', { min: 0, max: 10_000 });
      if (v !== undefined) m.sortOrder = v;
    },
  };
}

function activeColumn<M extends RefModel>(header: string, hint: string): DirectoryColumn<M> {
  return {
    header,
    width: 10,
    hint,
    get: (m) => boolCell(m.isActive),
    set: (m, text, ctx) => {
      const v = parseBool(text, ctx, header);
      if (v !== undefined) m.isActive = v;
    },
  };
}

/**
 * Текстовая колонка, у которой пустая ячейка ничего не меняет. Так ведут себя все поля человека,
 * кроме комментария: файл собирают в кадровой службе, и она знает не про всё — молчание её таблицы
 * означает «нет данных», а не «сотрите заведённое» (приём адреса в кадровой выгрузке, ADR 0047).
 */
function keepColumn<M>(
  header: string,
  width: number,
  hint: string,
  get: (m: M) => string,
  put: (m: M, value: string) => void,
  /** Прежние имена колонки: файл, скачанный до переименования, обязан грузиться (`types.ts`). */
  aliases?: string[],
): DirectoryColumn<M> {
  return {
    header,
    ...(aliases ? { aliases } : {}),
    width,
    hint,
    get,
    set: (m, text) => {
      const v = text.trim();
      if (v !== '') put(m, v);
    },
  };
}

/** Колонка-дата с тем же правилом: пустая ячейка заведённую дату не стирает. */
function dateColumn<M>(
  header: string,
  width: number,
  hint: string,
  get: (m: M) => string | null,
  put: (m: M, value: string) => void,
  aliases?: string[],
): DirectoryColumn<M> {
  return {
    header,
    ...(aliases ? { aliases } : {}),
    width,
    hint,
    get: (m) => dateCell(get(m)),
    set: (m, text, ctx) => {
      // Общий разбор из `cells.ts`, а не `parseImportDate` кадровой выгрузки: форматы он принимает
      // те же оба, но вдобавок сверяет календарь — «31.02.2026» формату соответствует, а дате нет.
      const v = parseDate(text, ctx, header);
      if (v !== undefined) put(m, v);
    },
  };
}

// ── Специализации ──

const specializationsDirectory = directory<SpecializationRow, RefModel, NoEnv>({
  key: 'specializations',
  env: async () => ({}),
  columns: () => [
    codeColumn(
      'Ключ записи: по нему строка ищется в справочнике. Латиница строчными, цифры, подчёркивание.',
    ),
    nameColumn('Как специализация называется в карточке человека: «Водитель», «Машинист крана».'),
    descriptionColumn('Пояснение для того, кто ведёт справочник; пустая ячейка его стирает.'),
    sortOrderColumn('Порядок в списках: меньше — выше.'),
    activeColumn('Активна', '«нет» гасит запись; удалить строку файлом нельзя.'),
  ],
  help: () => [
    'Специализации — какую работу человек может выполнять: водитель, машинист крана, стропальщик.',
    'Это не допуск по документу: категории удостоверения ведёт справочник «Категории квалификаций».',
    'Код «driver» менять нельзя: по нему портал отбирает водителей и собирает справочник водителей.',
    'Ключ строки — код. Загрузка заводит новые записи и правит заведённые; удалять строки файлом ' +
      'нельзя — ненужную гасят колонкой «Активна».',
  ],
  load: () =>
    db
      .select()
      .from(specializations)
      .orderBy(asc(specializations.sortOrder), asc(specializations.code)),
  id: (row) => row.id,
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
    await tx.insert(specializations).values({
      code: m.code,
      name: m.name,
      description: m.description,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(specializations)
      .set({
        code: m.code,
        name: m.name,
        description: m.description,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(specializations.id, row.id));
  },
});

// ── Виды документов ──

interface CredentialTypeModel extends RefModel {
  hasCategories: boolean;
  expiryRequired: boolean;
}

const credentialTypesDirectory = directory<CredentialTypeRow, CredentialTypeModel, NoEnv>({
  key: 'credential-types',
  env: async () => ({}),
  columns: () => [
    codeColumn(
      'Ключ записи: по нему строка ищется в справочнике. Латиница строчными, цифры, подчёркивание.',
    ),
    nameColumn('Как документ называется в карточке: «Водительское удостоверение».'),
    descriptionColumn('Пояснение для того, кто ведёт справочник; пустая ячейка его стирает.'),
    {
      header: 'С категориями',
      width: 15,
      hint: '«да» — документ открывает категории (удостоверение); «нет» — документ без них (медсправка).',
      get: (m) => boolCell(m.hasCategories),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'С категориями');
        if (v !== undefined) m.hasCategories = v;
      },
    },
    {
      header: 'Срок обязателен',
      width: 17,
      hint: '«нет» — документ бессрочный: срок действия у него не спрашивают.',
      get: (m) => boolCell(m.expiryRequired),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Срок обязателен');
        if (v !== undefined) m.expiryRequired = v;
      },
    },
    sortOrderColumn('Порядок в списках: меньше — выше.'),
    activeColumn('Активен', '«нет» гасит запись; удалить строку файлом нельзя.'),
  ],
  help: () => [
    'Виды документов — чем подтверждается допуск: водительское удостоверение, удостоверение ' +
      'тракториста-машиниста, медицинское заключение.',
    'Категории принадлежат виду документа, а не человеку: «C» водительского и «C» тракториста — ' +
      'разные допуски, и разводятся они именно здесь (ADR 0008).',
    'Коды «driver_license» и «tractor_license» менять нельзя: по ним портал находит документы ' +
      'допуска и по должности решает, каким из двух человек допущен (ADR 0095).',
    'Ключ строки — код. Загрузка заводит новые записи и правит заведённые; удалять строки файлом ' +
      'нельзя — ненужную гасят колонкой «Активен».',
  ],
  load: () =>
    db
      .select()
      .from(credentialTypes)
      .orderBy(asc(credentialTypes.sortOrder), asc(credentialTypes.code)),
  id: (row) => row.id,
  model: (row) => ({
    code: row.code,
    name: row.name,
    description: row.description,
    hasCategories: row.hasCategories,
    expiryRequired: row.expiryRequired,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  blank: () => ({
    code: '',
    name: '',
    description: '',
    hasCategories: true,
    expiryRequired: true,
    sortOrder: 100,
    isActive: true,
  }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  create: async (tx, m) => {
    await tx.insert(credentialTypes).values({
      code: m.code,
      name: m.name,
      description: m.description,
      hasCategories: m.hasCategories,
      expiryRequired: m.expiryRequired,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(credentialTypes)
      .set({
        code: m.code,
        name: m.name,
        description: m.description,
        hasCategories: m.hasCategories,
        expiryRequired: m.expiryRequired,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(credentialTypes.id, row.id));
  },
});

// ── Категории квалификаций ──

/** Строка справочника вместе с кодом своего вида документа: ссылки в файле ходят кодами. */
interface QualificationCategoryRow {
  id: string;
  credentialTypeCode: string;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

interface QualificationCategoryModel extends RefModel {
  /** Вид документа кодом: код категории уникален внутри вида, но не глобально. */
  credentialTypeCode: string;
}

/** Виды документов кодами: ими строка файла ссылается на справочник видов. */
interface CredentialTypeEnv {
  typeIdByCode: Map<string, string>;
}

const qualificationCategoriesDirectory = directory<
  QualificationCategoryRow,
  QualificationCategoryModel,
  CredentialTypeEnv
>({
  key: 'qualification-categories',
  env: async () => {
    const rows = await db
      .select({ id: credentialTypes.id, code: credentialTypes.code })
      .from(credentialTypes);
    return { typeIdByCode: new Map(rows.map((r) => [r.code, r.id])) };
  },
  columns: () => [
    {
      header: 'Вид документа (код)',
      width: 22,
      hint: 'Код из справочника «Виды документов»: часть ключа строки. Вид документа заводят до категорий.',
      get: (m) => m.credentialTypeCode,
      set: (m, text, ctx) => {
        const v = parseRequired(text, ctx, 'Вид документа (код)', m.credentialTypeCode);
        if (v !== undefined) m.credentialTypeCode = v.toLowerCase();
      },
    },
    codeColumn(
      'Вторая половина ключа: код уникален внутри вида документа, но не глобально — «c» есть и у ' +
        'водительского удостоверения, и у тракториста.',
    ),
    nameColumn('Буква, как она напечатана в документе: «CE».'),
    descriptionColumn('Что открывает категория; пустая ячейка стирает заведённое пояснение.'),
    sortOrderColumn('Порядок в списках: меньше — выше.'),
    activeColumn('Активна', '«нет» гасит запись; удалить строку файлом нельзя.'),
  ],
  help: () => [
    'Категории квалификаций — что открывает документ: «B», «C», «CE» водительского удостоверения.',
    'Категория принадлежит виду документа. Ключ строки составной — вид документа плюс код: «C» ' +
      'водительского и «C» тракториста-машиниста это разные записи, и путать их нельзя (ADR 0008).',
    'Вид документа портал не заводит сам: неизвестный код — ошибка строки. Сначала загрузите ' +
      'справочник «Виды документов».',
    'Загрузка заводит новые записи и правит заведённые; удалять строки файлом нельзя — ненужную ' +
      'гасят колонкой «Активна».',
  ],
  load: () =>
    db
      .select({
        id: qualificationCategories.id,
        credentialTypeCode: credentialTypes.code,
        code: qualificationCategories.code,
        name: qualificationCategories.name,
        description: qualificationCategories.description,
        sortOrder: qualificationCategories.sortOrder,
        isActive: qualificationCategories.isActive,
      })
      .from(qualificationCategories)
      .innerJoin(credentialTypes, eq(credentialTypes.id, qualificationCategories.credentialTypeId))
      .orderBy(
        asc(credentialTypes.sortOrder),
        asc(credentialTypes.code),
        asc(qualificationCategories.sortOrder),
        asc(qualificationCategories.code),
      ),
  id: (row) => row.id,
  model: (row) => ({
    credentialTypeCode: row.credentialTypeCode,
    code: row.code,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
  blank: () => ({
    credentialTypeCode: '',
    code: '',
    name: '',
    description: '',
    sortOrder: 100,
    isActive: true,
  }),
  // Ключ составной: код категории уникален внутри вида документа, и одним кодом строку не найти.
  // Косая черта — разделитель служебный: в кодах её нет, оба ограничения формата её не пропускают.
  keyOf: (m) =>
    m.credentialTypeCode !== '' && m.code !== '' ? `${m.credentialTypeCode}/${m.code}` : '',
  titleOf: (m) =>
    m.credentialTypeCode !== ''
      ? `${m.credentialTypeCode} · ${m.name || m.code}`
      : m.name || m.code,
  check: (m, ctx, env) => {
    if (m.credentialTypeCode === '') return;
    if (!env.typeIdByCode.has(m.credentialTypeCode)) {
      ctx.fail(
        `вид документа «${m.credentialTypeCode}» не найден — сначала загрузите справочник видов документов`,
      );
    }
  },
  create: async (tx, m, env) => {
    // Вид документа проверен в `check()`: до записи доходят только строки без ошибок.
    const credentialTypeId = env.typeIdByCode.get(m.credentialTypeCode)!;
    await tx.insert(qualificationCategories).values({
      credentialTypeId,
      code: m.code,
      name: m.name,
      description: m.description,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m, env) => {
    const credentialTypeId = env.typeIdByCode.get(m.credentialTypeCode)!;
    await tx
      .update(qualificationCategories)
      .set({
        // Вид документа тоже правится: категорию заводят не туда, и переносить её вручную негде.
        // Ту, что уже открыта чьим-то документом, не пустит составной внешний ключ — и правильно:
        // это была бы смена допуска у живого человека.
        credentialTypeId,
        code: m.code,
        name: m.name,
        description: m.description,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(qualificationCategories.id, row.id));
  },
});

// ── Водители ──

/**
 * Документ допуска в строке справочника. Видов документа два — водительское удостоверение и
 * удостоверение тракториста-машиниста (ADR 0095), — и устроены они одинаково: реквизиты плюс
 * открытые категории. Поэтому у них общие колонки, общий разбор и общая запись: разойдись правила
 * у двух половин одной строки, человек с файлом в руках объяснения этому не найдёт.
 */
interface DriverDocumentRow {
  id: string;
  series: string;
  number: string;
  issuedOn: string | null;
  expiresOn: string | null;
  issuedBy: string;
  /** Коды открытых категорий в порядке справочника. */
  categories: string[];
}

/**
 * Строка справочника водителей: человек, его действующее трудовое отношение и документы допуска
 * вместе. Отдельной таблицы водителей нет (ADR 0008), поэтому строку собирает `load()` — тремя
 * запросами на весь файл, а не запросом на человека.
 */
interface DriverRow {
  personId: string;
  fullName: string;
  snils: string;
  birthDate: string | null;
  phone: string;
  email: string;
  comment: string;
  /** `null` — трудовое отношение не заведено: такое приходит из старых записей. */
  employmentId: string | null;
  personnelNo: string;
  jobTitle: string;
  department: string;
  employedSince: string | null;
  /** Действующие документы по видам; вида нет в ключах — документа нет, и загрузка вправе завести. */
  documents: Partial<Record<CredentialTypeCode, DriverDocumentRow>>;
}

/** Тот же документ глазами человека: колонки правят его поля, а не строку базы. */
interface DriverDocumentModel {
  /** Коды открытых категорий в нижнем регистре. */
  categories: string[];
  series: string;
  number: string;
  issuedOn: string | null;
  expiresOn: string | null;
  issuedBy: string;
  /**
   * Заведён ли документ этого вида. Колонки у поля нет — в файле его не правят: оно отвечает на
   * вопрос «завести документ или дополнить заведённый», от которого зависят и запись, и то, куда
   * лягут категории строки (`categoryTarget`).
   */
  exists: boolean;
}

interface DriverModel {
  /** ФИО одной строкой, как его показывает портал; на части его разбирает `splitFullName`. */
  fullName: string;
  /** 11 цифр: разделители — оформление номера, а не его часть. */
  snils: string;
  birthDate: string | null;
  /** Десять цифр без кода страны (ADR 0066). */
  phone: string;
  email: string;
  personnelNo: string;
  jobTitle: string;
  /** Обособленное подразделение — комментарий трудового отношения, как в кадровой выгрузке. */
  department: string;
  employedSince: string | null;
  /** Реквизиты по видам документов: у человека их бывает два сразу. */
  documents: Record<CredentialTypeCode, DriverDocumentModel>;
  /**
   * Коды из колонок категорий, ещё не разложенные по документам; ключ — вид самой колонки.
   *
   * Колонка их только собирает: куда они лягут, зависит от всей строки — от должности, от уже
   * заведённого документа, от реквизитов, — а колонки в файле стоят в любом порядке, и любой из
   * них может не быть вовсе. Раскладывает их `distributeCategories`, когда строка собрана целиком.
   */
  pendingCategories: Record<CredentialTypeCode, string[]>;
  comment: string;
}

interface DriversEnv {
  /** Специализация «driver»; `null` — справочники не наполнены (миграция 0058). */
  specializationId: string | null;
  /** Виды документов; `null` — вид не заведён (миграции 0058 и 0123). */
  typeIds: Record<CredentialTypeCode, string | null>;
  /**
   * Категории кодами — свой словарь на каждый вид документа. Общего быть не может: код уникален
   * внутри вида, а не глобально, и «C» тракториста нашлась бы среди водительских — молча выданный
   * допуск к грузовику (ADR 0008).
   */
  categoryIds: Record<CredentialTypeCode, Map<string, string>>;
}

/**
 * Значение на каждый вид документа. Через эту функцию собираются и окружение, и модель: перечень
 * видов один (`CREDENTIAL_TYPE_CODES`), и забыть вид, заводя третий, здесь негде.
 */
function byCredentialType<T>(make: (type: CredentialTypeCode) => T): Record<CredentialTypeCode, T> {
  return Object.fromEntries(CREDENTIAL_TYPE_CODES.map((t) => [t, make(t)])) as Record<
    CredentialTypeCode,
    T
  >;
}

/** Родительный падеж названия документа: им подписаны сообщения «нет в справочнике категорий …». */
const credentialTypeGenitive: Record<CredentialTypeCode, string> = {
  driver_license: 'водительского удостоверения',
  tractor_license: 'удостоверения тракториста-машиниста',
};

/** Водитель — человек с действующей специализацией «driver»: своей таблицы у него нет. */
function driverSpecializationExists() {
  return sql`EXISTS (
    SELECT 1 FROM ${personSpecializations} ps
    JOIN ${specializations} s ON s.id = ps.specialization_id
    WHERE ps.person_id = ${persons.id}
      AND ps.ended_on IS NULL
      AND s.code = ${DRIVER_SPECIALIZATION_CODE}
  )`;
}

/**
 * В какой документ лягут категории из колонки; `null` — этого из строки не видно.
 *
 * Колонка «Категории УТМ» однозначна: человек написал коды там, где написано «УТМ». Приписать их
 * к водительскому нельзя ни при каких условиях — это молча выданный допуск к автобусу.
 *
 * Колонка «Категории ВУ» такой однозначности не имеет и иметь не может: именно её приносит кадровая
 * выгрузка, где колонка категорий одна на всех, а в ней вперемешку категории водительского и
 * тракторного (ADR 0049). Кому они принадлежат, называет должность (ADR 0095, решение Р2): у
 * водителя и машиниста автокрана — водительскому, у машиниста погрузчика и экскаватора —
 * тракторному. Прежде такие категории терялись в предупреждении; теперь у них есть свой дом.
 *
 * Порядок проверок — от самого достоверного признака к догадке.
 */
function categoryTarget(m: DriverModel, column: CredentialTypeCode): CredentialTypeCode | null {
  if (column !== 'driver_license') return column;
  // Заведённый документ портал сам и выгрузил: колонка описывает его, а не чужой. Иначе выгрузка
  // машиниста с настоящим ВУ вернулась бы загрузкой, переносящей его категории в тракторное.
  if (m.documents.driver_license.exists) return 'driver_license';
  const byJobTitle = jobTitleCredentialType(m.jobTitle);
  if (byJobTitle !== null) return byJobTitle;
  // Должность порталу незнакома — остаётся прежнее правило ADR 0049: водительское заводится только
  // по явным признакам. Реквизиты в строке — признак прямой: у тракторного они стояли бы в своих
  // колонках. Коды-маркеры (подкатегории и составы с прицепом) у тракторного невозможны.
  const document = m.documents.driver_license;
  return document.series !== '' ||
    document.number !== '' ||
    looksLikeDriverLicense(m.pendingCategories.driver_license)
    ? 'driver_license'
    : null;
}

/**
 * Разложить категории строки по документам — по одному разу на всю строку, а не в разборе ячейки.
 *
 * Здесь, а не в `set()`, потому что решение зависит от всей строки: от должности (её колонка может
 * стоять после категорий и может отсутствовать вовсе), от уже заведённого документа и от реквизитов
 * соседних колонок. И проверять коды по справочнику раньше этого решения нельзя: словарь категорий
 * у каждого вида свой, а «CE» водительского и «F» тракторного друг у друга неизвестны.
 *
 * Вызывается из `check()` — то есть после разбора всех колонок и до сравнения «что изменится» и
 * записи. Поэтому раскладка видна в отчёте предпросмотра: человек читает «Категории УТМ: пусто →
 * B; C», а не узнаёт о переносе из базы.
 */
function distributeCategories(m: DriverModel, ctx: RowContext, env: DriversEnv): void {
  for (const column of CREDENTIAL_TYPE_CODES) {
    const codes = m.pendingCategories[column];
    if (codes.length === 0) continue;
    const label = `Категории ${credentialTypeShortLabels[column]}`;

    const target = categoryTarget(m, column);
    if (target === null) {
      ctx.warn(
        `удостоверение не заводится — должность «${m.jobTitle}» порталу незнакома, и вид документа ` +
          `по ней не определён: ${codes.map((c) => c.toUpperCase()).join(', ')} могут быть ` +
          'категориями и водительского удостоверения, и тракторного, а те же буквы означают у них ' +
          'разные машины (ADR 0049). Категории не заведены, человек заведён',
      );
      continue;
    }
    // Вид не заведён вовсе: об этом уже сказала одна ошибка строки, и разбирать по нему коды
    // означало бы вторую — про каждый код, которого «нет в пустом справочнике».
    if (env.typeIds[target] === null) continue;

    const known = env.categoryIds[target];
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      ctx.fail(
        `${label} — ${unknown.map((c) => `«${c.toUpperCase()}»`).join(', ')} нет в справочнике ` +
          `категорий ${credentialTypeGenitive[target]} — сначала загрузите справочник категорий ` +
          'квалификаций',
      );
      continue;
    }

    /**
     * Категории только добавляются. Меньший набор в файле — не снятие допуска: допуск к машине
     * снимают документом — заменой удостоверения или его аннулированием, — а не строкой таблицы,
     * которую кто-то сократил, потому что в его выгрузке этой колонки не было. Ошибкой это тоже не
     * считается: файл собирают из кадровой системы, где категорий может не быть вовсе. Поэтому —
     * предупреждение, а заведённое остаётся на месте.
     */
    const document = m.documents[target];
    const missing = document.categories.filter((c) => !codes.includes(c));
    if (missing.length > 0) {
      ctx.warn(
        `${label} — по ${credentialTypeShortLabels[target]} открыты ${missing
          .map((c) => c.toUpperCase())
          .join(', ')}, а в файле их нет: файлом допуск не снимают, заведённое осталось`,
      );
    }
    document.categories = [
      ...document.categories,
      ...codes.filter((c) => !document.categories.includes(c)),
    ];
  }
}

/**
 * Есть ли в строке хоть что-нибудь про этот документ: категории или любой реквизит. Пустой блок
 * колонок документа не заводит — иначе первая же загрузка выдала бы всем по пустому УТМ.
 */
function documentFilled(document: DriverDocumentModel): boolean {
  return (
    document.categories.length > 0 ||
    document.series !== '' ||
    document.number !== '' ||
    document.issuedOn !== null ||
    document.expiresOn !== null ||
    document.issuedBy !== ''
  );
}

/**
 * Завести документ по строке файла. Категории к этому месту уже разложены по видам
 * (`distributeCategories`), и решать здесь нечего.
 *
 * Документ без категорий заводится наравне с полным: категории говорят, к каким машинам человек
 * допущен, но лист выписывается не по ним, а по номеру, дате выдачи и сроку (ADR 0055), и в отборе
 * под машину пустой набор никого не убирает (ADR 0064) — он только не закрывает требование
 * категории. Карточка водителя такой документ заводить позволяла всегда, и файл, молча терявший
 * заведённое УТМ машиниста, расходился с ней на ровном месте.
 */
async function insertDocument(
  tx: Tx,
  personId: string,
  type: CredentialTypeCode,
  m: DriverModel,
  env: DriversEnv,
  actorUserId: string,
): Promise<void> {
  const document = m.documents[type];
  if (!documentFilled(document)) return;
  const typeId = env.typeIds[type];
  if (typeId === null) throw new DirectoriesNotSeededError();

  const withRequisites = document.series !== '' || document.number !== '';
  const [credential] = await tx
    .insert(personCredentials)
    .values({
      personId,
      credentialTypeId: typeId,
      series: document.series,
      number: document.number,
      issuedOn: document.issuedOn,
      expiresOn: document.expiresOn,
      issuedBy: document.issuedBy,
      // Бумагу никто не сверял: файл её не заменяет, и допуска эта отметка не отменяет (ADR 0047).
      verificationStatus: 'unverified',
      comment: withRequisites
        ? licenseWithRequisitesComment(credentialTypeShortLabels[type])
        : LICENSE_COMMENT,
      createdBy: actorUserId,
    })
    .returning({ id: personCredentials.id });

  // Пустой набор — не строка с нулём значений: `INSERT ... VALUES ()` драйвер не соберёт вовсе.
  if (document.categories.length === 0) return;
  await tx.insert(personCredentialCategories).values(
    document.categories.map((code) => ({
      credentialId: credential!.id,
      qualificationCategoryId: env.categoryIds[type].get(code)!,
      credentialTypeId: typeId,
    })),
  );
}

/** Чем заполняют колонки блока документа: правила у двух видов одни, слова разные. */
interface DocumentHints {
  categories: string;
  series: string;
  number: string;
  issuedOn: string;
  expiresOn: string;
  issuedBy: string;
}

const documentHints: Record<CredentialTypeCode, DocumentHints> = {
  driver_license: {
    categories:
      'Коды открытых категорий через «;»: «B; C; CE». Файлом их только добавляют — снять допуск ' +
      'строкой таблицы нельзя. Если должность требует тракторного удостоверения, коды из этой ' +
      'колонки заводятся в него: кадровая выгрузка присылает категории одной колонкой (ADR 0095).',
    series: 'Как напечатана в удостоверении: «99 39». Пустая ячейка заведённую серию не стирает.',
    number: 'Без номера путевой лист печатается недействительным (ADR 0055).',
    issuedOn: 'Дата выдачи водительского удостоверения, ДД.ММ.ГГГГ: её печатает путевой лист.',
    expiresOn: 'Срок действия водительского удостоверения, ДД.ММ.ГГГГ; пусто — срок не внесён.',
    issuedBy: 'Подразделение ГИБДД из удостоверения.',
  },
  tractor_license: {
    categories:
      'Коды открытых категорий самоходных машин через «;»: «A1; B; C». Те же буквы, что у ' +
      'водительского удостоверения, означают здесь другие машины, и в водительское коды из этой ' +
      'колонки не попадают никогда (ADR 0008).',
    series: 'Как напечатана в удостоверении тракториста-машиниста; пустая ячейка её не стирает.',
    number: 'Номер удостоверения тракториста-машиниста.',
    issuedOn: 'Дата выдачи удостоверения тракториста-машиниста, ДД.ММ.ГГГГ.',
    expiresOn:
      'Срок действия удостоверения тракториста-машиниста, ДД.ММ.ГГГГ; пусто — срок не внесён.',
    issuedBy: 'Инспекция гостехнадзора, выдавшая удостоверение.',
  },
};

/**
 * Как колонки водительского блока назывались до ADR 0095. Пока документ был один, вида они не
 * называли, и файл, скачанный до разделения колонок, обязан грузиться — псевдонимами он и грузится
 * (`types.ts`, `aliases`). Категории, серия и номер переименования не требовали: «ВУ» в их
 * заголовках стояло и раньше.
 */
const DRIVER_LICENSE_LEGACY_HEADERS: Partial<Record<keyof DocumentHints, string>> = {
  issuedOn: 'Выдано',
  expiresOn: 'Действительно до',
  issuedBy: 'Кем выдано',
};

function legacyAliases(type: CredentialTypeCode, field: keyof DocumentHints): string[] | undefined {
  if (type !== 'driver_license') return undefined;
  const was = DRIVER_LICENSE_LEGACY_HEADERS[field];
  return was === undefined ? undefined : [was];
}

/**
 * Шесть колонок одного документа. Два блока собираются одной функцией, а не двумя списками: разойдись
 * у них правило «пустая ячейка не стирает» или разбор даты — и один и тот же файл вёл бы себя
 * по-разному в двух половинах одной строки.
 */
function documentColumns(type: CredentialTypeCode): DirectoryColumn<DriverModel>[] {
  const short = credentialTypeShortLabels[type];
  const hints = documentHints[type];
  const document = (m: DriverModel): DriverDocumentModel => m.documents[type];
  return [
    {
      header: `Категории ${short}`,
      width: 22,
      hint: hints.categories,
      get: (m) => listCell(document(m).categories.map((c) => c.toUpperCase())),
      set: (m, text) => {
        // Разделитель ячейки общий (`parseList`: «;» и «,»), приведение кодов — то же, что у
        // кадровой выгрузки: нижний регистр, без пустых элементов и без повторов. Дальше коды
        // ждут всей строки: чей это документ, решает `distributeCategories`.
        const codes = parseCategoryCodes(parseList(text).join(','));
        if (codes.length > 0) m.pendingCategories[type] = codes;
      },
    },
    keepColumn<DriverModel>(
      `Серия ${short}`,
      12,
      hints.series,
      (m) => document(m).series,
      (m, v) => {
        document(m).series = v;
      },
      legacyAliases(type, 'series'),
    ),
    keepColumn<DriverModel>(
      `Номер ${short}`,
      14,
      hints.number,
      (m) => document(m).number,
      (m, v) => {
        document(m).number = v;
      },
      legacyAliases(type, 'number'),
    ),
    dateColumn<DriverModel>(
      `Выдано ${short}`,
      15,
      hints.issuedOn,
      (m) => document(m).issuedOn,
      (m, v) => {
        document(m).issuedOn = v;
      },
      legacyAliases(type, 'issuedOn'),
    ),
    dateColumn<DriverModel>(
      `Действительно до ${short}`,
      21,
      hints.expiresOn,
      (m) => document(m).expiresOn,
      (m, v) => {
        document(m).expiresOn = v;
      },
      legacyAliases(type, 'expiresOn'),
    ),
    keepColumn<DriverModel>(
      `Кем выдано ${short}`,
      26,
      hints.issuedBy,
      (m) => document(m).issuedBy,
      (m, v) => {
        document(m).issuedBy = v;
      },
      legacyAliases(type, 'issuedBy'),
    ),
  ];
}

const driversDirectory = directory<DriverRow, DriverModel, DriversEnv>({
  key: 'drivers',
  env: async () => {
    const [specialization] = await db
      .select({ id: specializations.id })
      .from(specializations)
      .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
    const types = await db
      .select({ id: credentialTypes.id, code: credentialTypes.code })
      .from(credentialTypes)
      .where(inArray(credentialTypes.code, [...CREDENTIAL_TYPE_CODES]));
    const idByCode = new Map(types.map((t) => [t.code, t.id]));
    // Категории обоих видов одним запросом, но словарями врозь: код уникален внутри вида, и общий
    // словарь нашёл бы «C» тракториста по требованию «C» водительского (ADR 0008).
    const categories =
      types.length > 0
        ? await db
            .select({
              id: qualificationCategories.id,
              code: qualificationCategories.code,
              credentialTypeId: qualificationCategories.credentialTypeId,
            })
            .from(qualificationCategories)
            .where(
              inArray(
                qualificationCategories.credentialTypeId,
                types.map((t) => t.id),
              ),
            )
        : [];
    return {
      specializationId: specialization?.id ?? null,
      typeIds: byCredentialType((type) => idByCode.get(type) ?? null),
      categoryIds: byCredentialType(
        (type) =>
          new Map(
            categories
              .filter((c) => c.credentialTypeId === idByCode.get(type))
              .map((c) => [c.code, c.id]),
          ),
      ),
    };
  },
  columns: () => [
    {
      header: 'ФИО',
      width: 32,
      hint: '«Фамилия Имя Отчество» одной ячейкой; отчество — если оно есть.',
      get: (m) => m.fullName,
      set: (m, text) => {
        const v = text.trim();
        // Разбор и склейка — общими функциями портала: так строка файла и карточка водителя
        // понимают «Иванов  Иван» одинаково, а сверка не показывает правку там, где её не делали.
        if (v !== '') m.fullName = formatFullName(splitFullName(v));
      },
    },
    {
      header: 'СНИЛС',
      width: 18,
      hint: 'Ключ строки. Принимается в любом виде: «112-233-445 95» и «11223344595» — один номер.',
      get: (m) => formatSnils(m.snils),
      set: (m, text) => {
        // Разделители снимаются, а проверка — в `check()`: об одной ошибке говорят один раз, и
        // сказать о ней надо даже тогда, когда колонки в файле нет вовсе.
        const v = normalizeSnils(text.trim());
        if (v !== '') m.snils = v;
      },
    },
    dateColumn<DriverModel>(
      'Дата рождения',
      15,
      'ДД.ММ.ГГГГ; пустая ячейка заведённую дату не стирает.',
      (m) => m.birthDate,
      (m, v) => {
        m.birthDate = v;
      },
    ),
    {
      header: 'Телефон',
      width: 20,
      hint: 'Любое написание российского номера: хранится он всё равно одним видом (ADR 0066).',
      get: (m) => formatPhone(m.phone),
      set: (m, text, ctx) => {
        const v = text.trim();
        if (v === '') return;
        // Номер, заведённый до нормализации, выгружается как есть и таким же возвращается: считать
        // его ошибкой значило бы отменять загрузку из-за строки, которую человек не трогал.
        if (v === formatPhone(m.phone)) return;
        const local = normalizePhone(v);
        if (local === null) {
          ctx.fail(`Телефон — ${PHONE_FORMAT_MESSAGE}, получено «${v}»`);
          return;
        }
        m.phone = local;
      },
    },
    {
      header: 'Email',
      width: 28,
      hint: 'Адрес, на который уходит задание на рейс; пустая ячейка заведённый адрес не стирает.',
      get: (m) => m.email,
      set: (m, text, ctx) => {
        const v = text.trim();
        if (v === '') return;
        if (!emailSchema.safeParse(v).success) {
          ctx.fail(`Email — ${EMAIL_FORMAT_MESSAGE}: «${v}»`);
          return;
        }
        m.email = v;
      },
    },
    keepColumn<DriverModel>(
      'Табельный номер',
      17,
      'Табельный номер работодателя; печатается в путевом листе.',
      (m) => m.personnelNo,
      (m, v) => {
        m.personnelNo = v;
      },
    ),
    keepColumn<DriverModel>(
      'Должность',
      26,
      'Как должность записана в кадрах. Ею решается, каким документом человек допущен: водитель и ' +
        'машинист автокрана — водительским удостоверением, машинист погрузчика и экскаватора — ' +
        'тракторным (ADR 0095). В незнакомой должности портал документа не угадывает.',
      (m) => m.jobTitle,
      (m, v) => {
        m.jobTitle = v;
      },
    ),
    keepColumn<DriverModel>(
      'Подразделение',
      26,
      'Обособленное подразделение работника; хранится комментарием трудового отношения.',
      (m) => m.department,
      (m, v) => {
        m.department = v;
      },
    ),
    dateColumn<DriverModel>(
      'Дата приёма',
      14,
      'ДД.ММ.ГГГГ: с неё считается и трудовое отношение, и специализация.',
      (m) => m.employedSince,
      (m, v) => {
        m.employedSince = v;
      },
    ),
    // Блоки документов — после человека и кадровых полей и в порядке `CREDENTIAL_TYPE_CODES`:
    // сначала водительское удостоверение, потом тракторное. Так файл и читают глазами — сверяя
    // левую половину строки с кадровой выгрузкой, а правую с документом в руках.
    ...CREDENTIAL_TYPE_CODES.flatMap((type) => documentColumns(type)),
    {
      header: 'Комментарий',
      width: 40,
      hint: 'Заметка о водителе. Единственная колонка, где пустая ячейка означает «стереть».',
      get: (m) => m.comment,
      // Присваивание напрямую, мимо `cells.ts`: заметку убирают тем же способом, каким её писали.
      set: (m, text) => {
        m.comment = text.trim();
      },
    },
  ],
  help: () => [
    'ВНИМАНИЕ: файл содержит персональные данные — ФИО, СНИЛС, дату рождения и реквизиты сразу ' +
      'двух документов: водительского удостоверения и удостоверения тракториста-машиниста. Его не ' +
      'пересылают почтой и мессенджерами, не кладут в общие папки и удаляют с рабочей станции, ' +
      'когда он больше не нужен.',
    'Справочник водителей — человек, его трудовое отношение и документы допуска одной строкой: ' +
      'отдельной таблицы водителей в портале нет (ADR 0008).',
    'Документов два, и колонки у них свои: «ВУ» — водительское удостоверение, «УТМ» — ' +
      'удостоверение тракториста-машиниста. Одна и та же буква означает у них разные машины, ' +
      'поэтому категории из колонок «УТМ» в водительское удостоверение не попадают никогда.',
    'Каким документом человек допущен, говорит должность: водитель и машинист автокрана — ' +
      'водительским, машинист погрузчика и экскаватора — тракторным (ADR 0095). Ею же портал ' +
      'решает, к какому документу отнести категории из колонки «Категории ВУ»: кадровая выгрузка ' +
      'присылает их одной колонкой на всех, и у машиниста экскаватора в ней стоят тракторные.',
    'Если должность порталу незнакома, а категории в строке есть, удостоверение не заводится: по ' +
      'одной букве не видно, водительская она или тракторная (ADR 0049). Строка при этом заведёт ' +
      'человека, а расхождение уйдёт в предупреждения — там незнакомую должность и замечают.',
    'Ключ строки — СНИЛС. Он принимается в любом написании, но контрольная сумма проверяется ' +
      'всегда: опечатка в одной цифре — это другой человек.',
    'Категории файлом только добавляются. Если в строке их меньше, чем открыто у человека, ' +
      'заведённое остаётся, а расхождение попадает в предупреждения: допуск к машине снимают ' +
      'документом, а не строкой таблицы.',
    'Реквизиты удостоверений (серия, номер, даты, кем выдано) заводятся вместе с документом и ' +
      'уточняются из файла. Пустая ячейка заведённое не стирает — так же ведут себя все колонки ' +
      'человека, кроме «Комментарий».',
    'Документ заводится и по одним реквизитам, без категорий: по нему выпишется путевой лист, а ' +
      'категории добавят потом — файлом или в карточке. Под машину, которая требует категорию, ' +
      'такой человек не подберётся, и строка уходит в предупреждения.',
    'Прежние заголовки «Выдано», «Действительно до» и «Кем выдано» по-прежнему принимаются: файл, ' +
      'скачанный до разделения колонок по документам, грузится как раньше — он про водительское ' +
      'удостоверение. Ставить в одном файле и прежний заголовок, и нынешний нельзя: какой из двух ' +
      'читать, неизвестно.',
    'Удалённых водителей в файле нет, и удалить человека загрузкой нельзя: это учётное действие ' +
      'с аудитом, а не побочный эффект повторной загрузки.',
  ],
  load: async (env) => {
    const people = await db
      .select({
        personId: persons.id,
        fullName: persons.fullName,
        snils: persons.snils,
        birthDate: persons.birthDate,
        phone: persons.phone,
        email: persons.email,
        comment: persons.comment,
        employmentId: personEmployments.id,
        personnelNo: personEmployments.personnelNo,
        jobTitle: personEmployments.jobTitle,
        department: personEmployments.comment,
        employedSince: personEmployments.startedOn,
      })
      .from(persons)
      .leftJoin(
        personEmployments,
        and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
      )
      // Удалённых в файле нет: выгрузка персональных данных и так уносит из портала лишнее, а
      // строка архивного человека вернула бы его в справочник загрузкой (ADR 0073, решение 5).
      .where(and(isNull(persons.deletedAt), driverSpecializationExists()))
      .orderBy(asc(persons.fullName));

    const rows = new Map<string, DriverRow>();
    for (const p of people) {
      // Действующих трудовых отношений у человека бывает несколько; в файл он попадает одной
      // строкой — иначе загрузка этого же файла отвергла бы её как задвоенный ключ.
      if (rows.has(p.personId)) continue;
      rows.set(p.personId, {
        personId: p.personId,
        fullName: p.fullName,
        snils: p.snils,
        birthDate: p.birthDate,
        phone: p.phone,
        email: p.email,
        comment: p.comment,
        employmentId: p.employmentId,
        personnelNo: p.personnelNo ?? '',
        jobTitle: p.jobTitle ?? '',
        department: p.department ?? '',
        employedSince: p.employedSince,
        documents: {},
      });
    }

    // Виды документов идентификаторами и обратно кодами: строка `person_credentials` называет вид
    // ссылкой, а модель — кодом, и переводить одно в другое незачем дважды.
    const typeByCode = new Map<string, CredentialTypeCode>();
    for (const type of CREDENTIAL_TYPE_CODES) {
      const id = env.typeIds[type];
      if (id !== null) typeByCode.set(id, type);
    }
    const typeIds = [...typeByCode.keys()];
    if (typeIds.length === 0) return [...rows.values()];

    const categories = await db
      .select({
        credentialId: personCredentialCategories.credentialId,
        code: qualificationCategories.code,
      })
      .from(personCredentialCategories)
      .innerJoin(
        qualificationCategories,
        eq(qualificationCategories.id, personCredentialCategories.qualificationCategoryId),
      )
      .where(inArray(personCredentialCategories.credentialTypeId, typeIds))
      .orderBy(asc(qualificationCategories.sortOrder), asc(qualificationCategories.code));
    // Ключ — документ, а не вид: у документа вид один, и коды двух видов в одном списке не сойдутся.
    const codesByCredential = new Map<string, string[]>();
    for (const c of categories) {
      const list = codesByCredential.get(c.credentialId) ?? [];
      list.push(c.code);
      codesByCredential.set(c.credentialId, list);
    }

    const credentials = await db
      .select({
        id: personCredentials.id,
        personId: personCredentials.personId,
        credentialTypeId: personCredentials.credentialTypeId,
        series: personCredentials.series,
        number: personCredentials.number,
        issuedOn: personCredentials.issuedOn,
        expiresOn: personCredentials.expiresOn,
        issuedBy: personCredentials.issuedBy,
      })
      .from(personCredentials)
      .where(
        and(
          inArray(personCredentials.credentialTypeId, typeIds),
          isNull(personCredentials.deletedAt),
          // Аннулированный документ допуска не даёт: выгружать его реквизиты значило бы предлагать
          // их правку, тогда как заменяют такой документ новым — в карточке водителя.
          isNull(personCredentials.revokedAt),
        ),
      )
      // Свежий документ первым: им человек и ездит, старые остаются историей.
      .orderBy(desc(personCredentials.issuedOn), desc(personCredentials.createdAt));

    for (const c of credentials) {
      const row = rows.get(c.personId);
      const type = typeByCode.get(c.credentialTypeId);
      // Свежий по своему виду уже взят: у человека бывает и ВУ, и УТМ, и по два каждого.
      if (!row || type === undefined || row.documents[type] !== undefined) continue;
      row.documents[type] = {
        id: c.id,
        series: c.series,
        number: c.number,
        issuedOn: c.issuedOn,
        expiresOn: c.expiresOn,
        issuedBy: c.issuedBy,
        categories: codesByCredential.get(c.id) ?? [],
      };
    }
    return [...rows.values()];
  },
  id: (row) => row.personId,
  model: (row) => ({
    fullName: row.fullName,
    snils: row.snils,
    birthDate: row.birthDate,
    phone: row.phone,
    email: row.email,
    personnelNo: row.personnelNo,
    jobTitle: row.jobTitle,
    department: row.department,
    employedSince: row.employedSince,
    documents: byCredentialType((type) => {
      const document = row.documents[type];
      return {
        categories: document?.categories ?? [],
        series: document?.series ?? '',
        number: document?.number ?? '',
        issuedOn: document?.issuedOn ?? null,
        expiresOn: document?.expiresOn ?? null,
        issuedBy: document?.issuedBy ?? '',
        exists: document !== undefined,
      };
    }),
    pendingCategories: byCredentialType(() => []),
    comment: row.comment,
  }),
  blank: () => ({
    fullName: '',
    snils: '',
    birthDate: null,
    phone: '',
    email: '',
    personnelNo: '',
    // Та же должность по умолчанию, что подставляет форма водителя (`createDriverSchema`).
    jobTitle: 'Водитель',
    department: '',
    employedSince: null,
    documents: byCredentialType(() => ({
      categories: [],
      series: '',
      number: '',
      issuedOn: null,
      expiresOn: null,
      issuedBy: '',
      exists: false,
    })),
    pendingCategories: byCredentialType(() => []),
    comment: '',
  }),
  // Ключ человека — СНИЛС (ADR 0037). Негодный номер ключом не притворяется: об этом уже сказала
  // ошибка разбора, а искать по нему значило бы найти не того или завести второго.
  keyOf: (m) => (/^\d{11}$/u.test(m.snils) ? m.snils : ''),
  titleOf: (m) => m.fullName || formatSnils(m.snils),
  check: (m, ctx, env) => {
    // ФИО и СНИЛС проверяются здесь, а не в своих колонках: колонки в файле может не быть вовсе,
    // а человек без фамилии и без ключа — не строка справочника. Заодно об одной ошибке говорится
    // один раз: разбор ячейки её не повторяет.
    if (m.fullName === '') {
      ctx.fail('ФИО — обязательная колонка, а ячейка пуста');
    } else {
      const name = splitFullName(m.fullName);
      if (name.lastName === '' || name.firstName === '') {
        ctx.fail(`ФИО — ожидается «Фамилия Имя Отчество», получено «${m.fullName}»`);
      }
    }

    if (m.snils === '') {
      ctx.fail('СНИЛС — обязательная колонка: это ключ строки, по нему человек и ищется');
    } else if (!/^\d{11}$/u.test(m.snils)) {
      ctx.fail(`СНИЛС — 11 цифр, получено «${m.snils}»`);
    } else if (!isValidSnils(m.snils)) {
      // Контрольная сумма ловит опечатку в одной цифре — то, чего формат не видит. Пропустить её
      // значило бы завести номер, который потом отвергнет форма правки карточки.
      ctx.fail(`СНИЛС ${formatSnils(m.snils)} не проходит проверку контрольной суммы`);
    }

    for (const type of CREDENTIAL_TYPE_CODES) {
      const document = m.documents[type];
      const short = credentialTypeShortLabels[type];
      if (document.issuedOn && document.expiresOn && document.expiresOn < document.issuedOn) {
        ctx.fail(
          `Действительно до ${short} — срок действия ${short} не может быть раньше даты выдачи`,
        );
      }
    }

    if (
      env.specializationId === null ||
      CREDENTIAL_TYPE_CODES.some((type) => env.typeIds[type] === null)
    ) {
      ctx.fail(
        'справочники не наполнены: примените миграции 0058 (специализация «driver» и вид ' +
          'документа «driver_license») и 0123 (вид документа «tractor_license»)',
      );
    }

    distributeCategories(m, ctx, env);

    // После раскладки видно и обратное: реквизиты есть, а категорий нет. Документ по такой строке
    // заводится (`insertDocument`) — лист по нему выпишется, — но под машину с требованием
    // категории такого человека не подберут, и об этом говорится тут же: в файле колонка рядом.
    for (const type of CREDENTIAL_TYPE_CODES) {
      const document = m.documents[type];
      if (document.exists || document.categories.length > 0) continue;
      if (!documentFilled(document)) continue;
      const short = credentialTypeShortLabels[type];
      ctx.warn(
        `${short}: реквизиты в строке есть, а категорий нет — документ заводится, но открытых ` +
          `категорий у него не будет: под машину с требованием категории такой человек не ` +
          `подберётся. Категории вносят колонкой «Категории ${short}» или в карточке водителя`,
      );
    }
  },
  create: async (tx, m, env, actorUserId) => {
    const specializationId = env.specializationId;
    if (specializationId === null) throw new DirectoriesNotSeededError();

    const [person] = await tx
      .insert(persons)
      .values({
        ...splitFullName(m.fullName),
        snils: m.snils,
        birthDate: m.birthDate,
        phone: m.phone,
        email: m.email,
        comment: m.comment,
        createdBy: actorUserId,
      })
      .returning({ id: persons.id });
    const personId = person!.id;

    // Специализация начинается с приёма на работу: до него человек водителем не числился.
    await tx.insert(personSpecializations).values({
      personId,
      specializationId,
      isPrimary: true,
      ...(m.employedSince ? { startedOn: m.employedSince } : {}),
    });

    // Трудовое отношение заводится всегда: из него берётся табельный номер для бланка, а «водитель
    // без работодателя» — состояние, которого в справочнике не бывает.
    await tx.insert(personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: m.personnelNo,
      jobTitle: m.jobTitle,
      comment: m.department,
      ...(m.employedSince ? { startedOn: m.employedSince } : {}),
    });

    // Оба документа: категории к этому месту уже разложены по видам, и заводится ровно то, для
    // чего они есть. У машиниста экскаватора это тракторное удостоверение, у водителя — ВУ.
    for (const type of CREDENTIAL_TYPE_CODES) {
      await insertDocument(tx, personId, type, m, env, actorUserId);
    }
  },
  update: async (tx, row, m, env, actorUserId) => {
    await tx
      .update(persons)
      .set({
        ...splitFullName(m.fullName),
        snils: m.snils,
        birthDate: m.birthDate,
        phone: m.phone,
        email: m.email,
        comment: m.comment,
        updatedBy: actorUserId,
        updatedAt: new Date(),
        // Версия растёт, как при правке карточки: иначе открытая у кого-то форма сохранилась бы
        // поверх загрузки и вернула прежние значения, ничего никому не сказав.
        version: sql`${persons.version} + 1`,
      })
      .where(eq(persons.id, row.personId));

    const employment = {
      personnelNo: m.personnelNo,
      jobTitle: m.jobTitle,
      comment: m.department,
      ...(m.employedSince ? { startedOn: m.employedSince } : {}),
    };
    if (row.employmentId === null) {
      await tx
        .insert(personEmployments)
        .values({ personId: row.personId, employmentType: 'staff', ...employment });
    } else {
      await tx
        .update(personEmployments)
        .set({ ...employment, updatedAt: new Date() })
        .where(eq(personEmployments.id, row.employmentId));
    }

    for (const type of CREDENTIAL_TYPE_CODES) {
      const existing = row.documents[type];
      if (existing === undefined) {
        await insertDocument(tx, row.personId, type, m, env, actorUserId);
        continue;
      }
      const document = m.documents[type];

      // Реквизиты пишутся из модели целиком, и стереть заведённое это не может: пустую ячейку
      // колонка в модель не переносит, так что в ней остаётся то, что уже заведено.
      await tx
        .update(personCredentials)
        .set({
          series: document.series,
          number: document.number,
          issuedOn: document.issuedOn,
          expiresOn: document.expiresOn,
          issuedBy: document.issuedBy,
          updatedBy: actorUserId,
          updatedAt: new Date(),
          version: sql`${personCredentials.version} + 1`,
        })
        .where(eq(personCredentials.id, existing.id));

      // Категории только добавляются — см. `distributeCategories`: снятие допуска документом, а не
      // файлом. Модель к этому месту уже собрана так, что заведённое из неё не пропало.
      const added = document.categories.filter((c) => !existing.categories.includes(c));
      if (added.length > 0) {
        await tx.insert(personCredentialCategories).values(
          added.map((code) => ({
            credentialId: existing.id,
            qualificationCategoryId: env.categoryIds[type].get(code)!,
            // Вид заведённого документа известен: по нему он и найден в `load()`.
            credentialTypeId: env.typeIds[type]!,
          })),
        );
      }
    }
  },
});

export const staffDirectories: AnyDirectory[] = [
  specializationsDirectory,
  credentialTypesDirectory,
  qualificationCategoriesDirectory,
  driversDirectory,
];
