import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  EMAIL_FORMAT_MESSAGE,
  emailSchema,
  formatFullName,
  formatPhone,
  formatSnils,
  isDriverJobTitle,
  isValidSnils,
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
  LICENSE_WITH_REQUISITES_COMMENT,
} from '../../driver-import-apply';
import { DRIVER_LICENSE_CODE, DRIVER_SPECIALIZATION_CODE } from '../../drivers';
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
import { directory, type AnyDirectory, type DirectoryColumn, type Tx } from '../types';

/**
 * Кадровые справочники обмена (ADR 0073): специализации, виды документов, категории квалификаций
 * и водители.
 *
 * Самая чувствительная часть обмена: в строке водителя лежат ФИО, СНИЛС и реквизиты
 * удостоверения живого человека. Отсюда два правила, которых нет у остальных справочников.
 *
 * Первое: правила разбора кадровой строки не переписываются. Контрольная сумма СНИЛС, разбор ФИО,
 * коды категорий и распознавание «водительское ли это удостоверение» (ADR 0049) остаются там, где
 * их уже проверяет тест, — в `driver-import.ts` и общем пакете; здесь они только вызываются.
 * Второй набор тех же правил означал бы, что через файл в справочник попадает то, чего не
 * принимает форма, — и наоборот.
 *
 * Второе: файл добавляет и уточняет, но не отнимает. Категории удостоверения строкой таблицы не
 * снимаются (см. колонку «Категории ВУ»), заведённые реквизиты пустой ячейкой не стираются, а
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
): DirectoryColumn<M> {
  return {
    header,
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
): DirectoryColumn<M> {
  return {
    header,
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
    'Код «driver_license» менять нельзя: по нему портал находит водительские удостоверения.',
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
 * Строка справочника водителей: человек, его действующее трудовое отношение и водительское
 * удостоверение вместе. Отдельной таблицы водителей нет (ADR 0008), поэтому строку собирает
 * `load()` — тремя запросами на весь файл, а не запросом на человека.
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
  /** Действующее удостоверение; `null` — его нет, и загрузка вправе его завести. */
  license: {
    id: string;
    series: string;
    number: string;
    issuedOn: string | null;
    expiresOn: string | null;
    issuedBy: string;
    /** Коды открытых категорий в порядке справочника. */
    categories: string[];
  } | null;
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
  /** Коды открытых категорий в нижнем регистре. */
  categories: string[];
  licenseSeries: string;
  licenseNumber: string;
  licenseIssuedOn: string | null;
  licenseExpiresOn: string | null;
  licenseIssuedBy: string;
  comment: string;
  /**
   * Заведено ли у человека действующее удостоверение. Колонки у поля нет — в файле его не правят:
   * оно отвечает на вопрос «завести документ или дополнить заведённый», от которого зависят и
   * запись, и предупреждение по ADR 0049.
   */
  hasLicense: boolean;
}

interface DriversEnv {
  /** Специализация «driver»; `null` — справочники не наполнены (миграция 0058). */
  specializationId: string | null;
  licenseTypeId: string | null;
  /** Категории водительского удостоверения кодами: кода достаточно — он уникален внутри вида. */
  categoryIdByCode: Map<string, string>;
}

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
 * Водительское ли это удостоверение — то же правило, что у кадровой выгрузки (ADR 0049,
 * `prepareDriverImport`). У водителя колонка категорий про ВУ; у машиниста в ней стоят категории
 * удостоверения тракториста-машиниста, где те же буквы означают другие машины, и завести по ним ВУ
 * значит молча выдать человеку допуск к автобусу.
 *
 * Условие выгрузки «и ни одного незнакомого кода» здесь выполняется само: незнакомый код — ошибка
 * строки, и до записи такая строка не доходит.
 */
function looksLikeDriverDocument(m: DriverModel): boolean {
  return (
    m.licenseSeries !== '' ||
    m.licenseNumber !== '' ||
    isDriverJobTitle(m.jobTitle) ||
    looksLikeDriverLicense(m.categories)
  );
}

/** Почему удостоверение не заводится, хотя категории в строке есть; пусто — заводится. */
function licenseSkipReason(m: DriverModel): string {
  if (m.hasLicense || m.categories.length === 0 || looksLikeDriverDocument(m)) return '';
  return (
    `должность «${m.jobTitle}» не водительская: категории ` +
    `${m.categories.map((c) => c.toUpperCase()).join(', ')} относятся к другому удостоверению и ` +
    'не заведены'
  );
}

/**
 * Завести удостоверение с категориями. Документа без категорий не бывает: он не открывает ничего,
 * и водителя по нему не отобрать ни под одну машину — такой человек остаётся карточкой без ВУ.
 */
async function insertLicense(
  tx: Tx,
  personId: string,
  m: DriverModel,
  env: DriversEnv,
  actorUserId: string,
): Promise<void> {
  const licenseTypeId = env.licenseTypeId;
  if (licenseTypeId === null) throw new DirectoriesNotSeededError();
  if (m.categories.length === 0 || licenseSkipReason(m) !== '') return;

  const withRequisites = m.licenseSeries !== '' || m.licenseNumber !== '';
  const [credential] = await tx
    .insert(personCredentials)
    .values({
      personId,
      credentialTypeId: licenseTypeId,
      series: m.licenseSeries,
      number: m.licenseNumber,
      issuedOn: m.licenseIssuedOn,
      expiresOn: m.licenseExpiresOn,
      issuedBy: m.licenseIssuedBy,
      // Бумагу никто не сверял: файл её не заменяет, и допуска эта отметка не отменяет (ADR 0047).
      verificationStatus: 'unverified',
      comment: withRequisites ? LICENSE_WITH_REQUISITES_COMMENT : LICENSE_COMMENT,
      createdBy: actorUserId,
    })
    .returning({ id: personCredentials.id });

  await tx.insert(personCredentialCategories).values(
    m.categories.map((code) => ({
      credentialId: credential!.id,
      qualificationCategoryId: env.categoryIdByCode.get(code)!,
      credentialTypeId: licenseTypeId,
    })),
  );
}

const driversDirectory = directory<DriverRow, DriverModel, DriversEnv>({
  key: 'drivers',
  env: async () => {
    const [specialization] = await db
      .select({ id: specializations.id })
      .from(specializations)
      .where(eq(specializations.code, DRIVER_SPECIALIZATION_CODE));
    const [licenseType] = await db
      .select({ id: credentialTypes.id })
      .from(credentialTypes)
      .where(eq(credentialTypes.code, DRIVER_LICENSE_CODE));
    const categories = licenseType
      ? await db
          .select({ id: qualificationCategories.id, code: qualificationCategories.code })
          .from(qualificationCategories)
          .where(eq(qualificationCategories.credentialTypeId, licenseType.id))
      : [];
    return {
      specializationId: specialization?.id ?? null,
      licenseTypeId: licenseType?.id ?? null,
      categoryIdByCode: new Map(categories.map((c) => [c.code, c.id])),
    };
  },
  columns: (env) => [
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
      'Как должность записана в кадрах. Слово «Водитель» в начале означает, что колонка категорий ' +
        'про водительское удостоверение (ADR 0049).',
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
    {
      header: 'Категории ВУ',
      width: 22,
      hint:
        'Коды открытых категорий через «;»: «B; C; CE». Файлом их только добавляют — снять ' +
        'допуск строкой таблицы нельзя.',
      get: (m) => listCell(m.categories.map((c) => c.toUpperCase())),
      set: (m, text, ctx) => {
        // Справочник не наполнен — об этом скажет `check()` один раз, а не по коду на строку.
        if (env.licenseTypeId === null) return;
        // Разделитель ячейки общий (`parseList`: «;» и «,»), приведение кодов — то же, что у
        // кадровой выгрузки: нижний регистр, без пустых элементов и без повторов.
        const codes = parseCategoryCodes(parseList(text).join(','));
        if (codes.length === 0) return;

        const unknown = codes.filter((c) => !env.categoryIdByCode.has(c));
        if (unknown.length > 0) {
          ctx.fail(
            `Категории ВУ — ${unknown.map((c) => `«${c.toUpperCase()}»`).join(', ')} нет в ` +
              'справочнике категорий водительского удостоверения — сначала загрузите справочник ' +
              'категорий квалификаций',
          );
          return;
        }

        /**
         * Категории только добавляются. Меньший набор в файле — не снятие допуска: допуск к машине
         * снимают документом — заменой удостоверения или его аннулированием, — а не строкой
         * таблицы, которую кто-то сократил, потому что в его выгрузке этой колонки не было. Ошибкой
         * это тоже не считается: файл собирают из кадровой системы, где категорий может не быть
         * вовсе. Поэтому — предупреждение, а заведённое остаётся на месте.
         */
        const missing = m.categories.filter((c) => !codes.includes(c));
        if (missing.length > 0) {
          ctx.warn(
            `Категории ВУ — у водителя открыты ${missing
              .map((c) => c.toUpperCase())
              .join(', ')}, а в файле их нет: файлом допуск не снимают, заведённое осталось`,
          );
        }
        m.categories = [...m.categories, ...codes.filter((c) => !m.categories.includes(c))];
      },
    },
    keepColumn<DriverModel>(
      'Серия ВУ',
      12,
      'Как напечатана в удостоверении: «99 39». Пустая ячейка заведённую серию не стирает.',
      (m) => m.licenseSeries,
      (m, v) => {
        m.licenseSeries = v;
      },
    ),
    keepColumn<DriverModel>(
      'Номер ВУ',
      14,
      'Без номера путевой лист печатается недействительным (ADR 0055).',
      (m) => m.licenseNumber,
      (m, v) => {
        m.licenseNumber = v;
      },
    ),
    dateColumn<DriverModel>(
      'Выдано',
      13,
      'Дата выдачи удостоверения, ДД.ММ.ГГГГ: её печатает путевой лист.',
      (m) => m.licenseIssuedOn,
      (m, v) => {
        m.licenseIssuedOn = v;
      },
    ),
    dateColumn<DriverModel>(
      'Действительно до',
      18,
      'Срок действия удостоверения, ДД.ММ.ГГГГ; пусто — срок не внесён.',
      (m) => m.licenseExpiresOn,
      (m, v) => {
        m.licenseExpiresOn = v;
      },
    ),
    keepColumn<DriverModel>(
      'Кем выдано',
      26,
      'Подразделение ГИБДД из удостоверения.',
      (m) => m.licenseIssuedBy,
      (m, v) => {
        m.licenseIssuedBy = v;
      },
    ),
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
    'ВНИМАНИЕ: файл содержит персональные данные — ФИО, СНИЛС, дату рождения и реквизиты ' +
      'водительского удостоверения. Его не пересылают почтой и мессенджерами, не кладут в общие ' +
      'папки и удаляют с рабочей станции, когда он больше не нужен.',
    'Справочник водителей — человек, его трудовое отношение и водительское удостоверение одной ' +
      'строкой: отдельной таблицы водителей в портале нет (ADR 0008).',
    'Ключ строки — СНИЛС. Он принимается в любом написании, но контрольная сумма проверяется ' +
      'всегда: опечатка в одной цифре — это другой человек.',
    'Категории ВУ файлом только добавляются. Если в строке их меньше, чем открыто у водителя, ' +
      'заведённое остаётся, а расхождение попадает в предупреждения: допуск к машине снимают ' +
      'документом, а не строкой таблицы.',
    'Реквизиты удостоверения (серия, номер, даты, кем выдано) заводятся вместе с документом и ' +
      'уточняются из файла. Пустая ячейка заведённое не стирает — так же ведут себя все колонки ' +
      'человека, кроме «Комментарий».',
    'Если должность не водительская, а категории в строке есть, удостоверение не заводится: в той ' +
      'же колонке у машиниста стоят категории удостоверения тракториста-машиниста, где те же буквы ' +
      'означают другие машины (ADR 0049). Строка при этом заведёт человека, а расхождение уйдёт в ' +
      'предупреждения.',
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
        license: null,
      });
    }
    if (env.licenseTypeId === null) return [...rows.values()];

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
      .where(eq(personCredentialCategories.credentialTypeId, env.licenseTypeId))
      .orderBy(asc(qualificationCategories.sortOrder), asc(qualificationCategories.code));
    const codesByCredential = new Map<string, string[]>();
    for (const c of categories) {
      const list = codesByCredential.get(c.credentialId) ?? [];
      list.push(c.code);
      codesByCredential.set(c.credentialId, list);
    }

    const licenses = await db
      .select({
        id: personCredentials.id,
        personId: personCredentials.personId,
        series: personCredentials.series,
        number: personCredentials.number,
        issuedOn: personCredentials.issuedOn,
        expiresOn: personCredentials.expiresOn,
        issuedBy: personCredentials.issuedBy,
      })
      .from(personCredentials)
      .where(
        and(
          eq(personCredentials.credentialTypeId, env.licenseTypeId),
          isNull(personCredentials.deletedAt),
          // Аннулированный документ допуска не даёт: выгружать его реквизиты значило бы предлагать
          // их правку, тогда как заменяют такой документ новым — в карточке водителя.
          isNull(personCredentials.revokedAt),
        ),
      )
      // Свежий документ первым: им человек и ездит, старые остаются историей.
      .orderBy(desc(personCredentials.issuedOn), desc(personCredentials.createdAt));

    for (const l of licenses) {
      const row = rows.get(l.personId);
      if (!row || row.license !== null) continue;
      row.license = {
        id: l.id,
        series: l.series,
        number: l.number,
        issuedOn: l.issuedOn,
        expiresOn: l.expiresOn,
        issuedBy: l.issuedBy,
        categories: codesByCredential.get(l.id) ?? [],
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
    categories: row.license?.categories ?? [],
    licenseSeries: row.license?.series ?? '',
    licenseNumber: row.license?.number ?? '',
    licenseIssuedOn: row.license?.issuedOn ?? null,
    licenseExpiresOn: row.license?.expiresOn ?? null,
    licenseIssuedBy: row.license?.issuedBy ?? '',
    comment: row.comment,
    hasLicense: row.license !== null,
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
    categories: [],
    licenseSeries: '',
    licenseNumber: '',
    licenseIssuedOn: null,
    licenseExpiresOn: null,
    licenseIssuedBy: '',
    comment: '',
    hasLicense: false,
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

    if (m.licenseIssuedOn && m.licenseExpiresOn && m.licenseExpiresOn < m.licenseIssuedOn) {
      ctx.fail('Действительно до — срок действия ВУ не может быть раньше даты выдачи');
    }

    if (env.specializationId === null || env.licenseTypeId === null) {
      ctx.fail(
        'справочники не наполнены: примените миграцию 0058 (специализация «driver» и вид ' +
          'документа «driver_license»)',
      );
    }

    const skip = licenseSkipReason(m);
    if (skip !== '') ctx.warn(`удостоверение не заводится — ${skip}`);
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

    await insertLicense(tx, personId, m, env, actorUserId);
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

    const license = row.license;
    if (license === null) {
      await insertLicense(tx, row.personId, m, env, actorUserId);
      return;
    }

    // Реквизиты пишутся из модели целиком, и стереть заведённое это не может: пустую ячейку
    // колонка в модель не переносит, так что в ней остаётся то, что уже заведено.
    await tx
      .update(personCredentials)
      .set({
        series: m.licenseSeries,
        number: m.licenseNumber,
        issuedOn: m.licenseIssuedOn,
        expiresOn: m.licenseExpiresOn,
        issuedBy: m.licenseIssuedBy,
        updatedBy: actorUserId,
        updatedAt: new Date(),
        version: sql`${personCredentials.version} + 1`,
      })
      .where(eq(personCredentials.id, license.id));

    // Категории только добавляются — см. колонку «Категории ВУ»: снятие допуска документом, а не
    // файлом. Модель к этому месту уже собрана так, что заведённое из неё не пропало.
    const added = m.categories.filter((c) => !license.categories.includes(c));
    if (added.length > 0) {
      await tx.insert(personCredentialCategories).values(
        added.map((code) => ({
          credentialId: license.id,
          qualificationCategoryId: env.categoryIdByCode.get(code)!,
          credentialTypeId: env.licenseTypeId!,
        })),
      );
    }
  },
});

export const staffDirectories: AnyDirectory[] = [
  specializationsDirectory,
  credentialTypesDirectory,
  qualificationCategoriesDirectory,
  driversDirectory,
];
