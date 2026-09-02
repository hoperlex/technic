import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  counterpartyTypeLabels,
  EMAIL_FORMAT_MESSAGE,
  formatPhone,
  INN_CHECKSUM_MESSAGE,
  INN_MESSAGE,
  isValidInn,
  normalizeEmail,
  normalizePhone,
  optionalEmailSchema,
  PHONE_FORMAT_MESSAGE,
  warehouseTitle,
  type CounterpartyType,
} from '@technic/contracts';
import { db } from '../../../db/client';
import {
  constructionObjects,
  counterparties,
  counterpartySynonyms,
  departmentConstructionObjects,
  departments,
  organizations,
  warehouses,
  type CounterpartyRow,
  type DepartmentRow,
  type ObjectRow,
  type WarehouseRow,
} from '../../../db/schema';
import { writeAuditTx } from '../../../lib/audit';
import { err } from '../../../lib/errors';
import { replaceDepartmentObjects } from '../../user-scopes';
import {
  boolCell,
  listCell,
  parseBool,
  parseChoice,
  parseList,
  parseSemicolonList,
} from '../cells';
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

/**
 * Порог набора площадок (ADR 0144, Р5). Число живёт в трёх местах, и это осознанно: контракт
 * (`departmentObjectIdsSchema`) отвечает за тело запроса, `replaceDepartmentObjects` — за
 * единственного писателя, а здесь стоит ради ТЕКСТА отказа. Служебный 400 от сервиса не назвал бы
 * строку файла, а человек с книгой на сотню отделов ищет именно её: «строка 47» он поправит, а
 * «Площадок у отдела не больше 50» без номера строки заставит пересматривать файл целиком.
 * Меняют порог — меняют все три.
 */
const DEPARTMENT_OBJECTS_LIMIT = 50;

/** Как колонка площадок называется сейчас; вынесена, чтобы отказ выгрузки называл её дословно. */
const DEPARTMENT_OBJECTS_HEADER = 'Площадки (коды объектов)';

interface DepartmentModel {
  code: string;
  name: string;
  /**
   * Площадки отдела кодами объектов (ADR 0144, развивает ADR 0062); пустой список — отдел без
   * площадок, рабочее состояние большинства отделов.
   *
   * Хранится КАНОНИЧЕСКИ — без повторов и по коду (§6 п. 3 плана). Иначе перестановка кодов в
   * ячейке («СЕВ; АЛ13» вместо «АЛ13; СЕВ») сравнилась бы с заведённым набором как правка:
   * предпросмотр показал бы изменение, которого человек не делал, загрузка погасила бы сессии
   * всему отделу, а в журнал доступа ушло бы событие с пустой разницей — «область меняли, но
   * ничего не изменилось».
   */
  objectCodes: string[];
  isActive: boolean;
}

interface DepartmentEnv {
  objectIdByCode: Map<string, string>;
  /**
   * Набор площадок каждого отдела кодами — источником служит таблица связи, а не колонка
   * `departments.construction_object_id`: колонка живёт один релиз совместимой ПРОЕКЦИЕЙ набора
   * (ADR 0144, решение 4) и при наборе из нескольких площадок стоит в `NULL`. Читай мы её,
   * выгрузка показывала бы пустую ячейку у отдела с тремя площадками, а загрузка того же файла
   * ничего бы не заметила — пустая ячейка набор не трогает.
   */
  objectCodesByDepartmentId: Map<string, string[]>;
}

/**
 * Канонический вид набора: без повторов и по коду. Один и тот же порядок обязан получаться и из
 * базы (`env`), и из ячейки (`set`) — сравнение «что изменится» идёт по тексту ячейки, и разойдись
 * эти два пути хоть порядком, файл показывал бы правку сам себе.
 *
 * Сортировка русской раскладкой — та же, что у разницы набора в `replaceDepartmentObjects`: коды
 * заведены кириллицей, и порядок кодовых точек поставил бы «Ё» после «Я».
 */
function canonicalObjectCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Набор площадок в ячейку — с предполётной проверкой (§6 п. 2 плана).
 *
 * Разделитель списка — «;», и экранирования у него нет намеренно: неявные правила разбора дают
 * молчаливые потери — файл, собранный по одному правилу и прочитанный по другому, теряет половину
 * значения, ничего об этом не сказав. Поэтому код объекта с «;» внутри — не задача разбора, а
 * состояние справочника объектов, при котором набор в одну ячейку не записывается вовсе. Обмен
 * отказывается, и отказывается ДО того, как соберётся книга: `exportDirectory` собирает все ячейки
 * и лишь потом пишет файл, а событие журнала «справочник выгружен» ставится и вовсе после
 * возврата, — то есть ни файла, ни записи о выгрузке не появится.
 *
 * Проверка стоит здесь, а не в `env()`, по одной причине: `env()` зовёт ещё и `countDirectory` —
 * то самое, чем портал рисует список справочников со счётчиками. Отказ оттуда закрыл бы всю
 * вкладку обмена из-за одного кода в одном объекте.
 *
 * `AppError`, а не `DirectoryFileError`: тот переводится в человеческий текст только на загрузке
 * (`routes/directory-transfer.ts`), и выгрузка отдала бы 500 со стек-трейсом в логах вместо
 * объяснения. `AppError` обрабатывает общий обработчик, и человек читает сообщение целиком.
 */
function objectCodesCell(m: DepartmentModel): string {
  const broken = m.objectCodes.find((code) => code.includes(';'));
  if (broken !== undefined) {
    throw err.unprocessable(
      `Обмен справочником отделов невозможен: у отдела «${m.name || m.code}» код площадки «${broken}» содержит точку с запятой, а ею в колонке «${DEPARTMENT_OBJECTS_HEADER}» разделяются коды набора. Экранирования нет намеренно — переименуйте объект в справочнике объектов и повторите.`,
    );
  }
  return listCell(m.objectCodes);
}

/**
 * Коды набора в идентификаторы. Неизвестный код сюда не доходит: его завернула `check()` — она
 * зовётся до записи и на предпросмотре, поэтому человек читает «площадка «ХХ» не найдена» с
 * номером строки, а не общий отказ внешнего ключа на половине файла.
 */
function departmentObjectIds(m: DepartmentModel, env: DepartmentEnv): string[] {
  return m.objectCodes
    .map((code) => env.objectIdByCode.get(code))
    .filter((id): id is string => id !== undefined);
}

const departmentsDirectory = directory<DepartmentRow, DepartmentModel, DepartmentEnv>({
  key: 'departments',
  // Справочник объектов и привязки площадок читаются один раз на файл: ссылка в нём указана
  // кодом, а записать нужно идентификатор — запрос на каждую строку означал бы сотню запросов на
  // сотню отделов.
  env: async () => {
    const [objects, links] = await Promise.all([
      db
        .select({ id: constructionObjects.id, code: constructionObjects.code })
        .from(constructionObjects),
      db
        .select({
          departmentId: departmentConstructionObjects.departmentId,
          code: constructionObjects.code,
        })
        .from(departmentConstructionObjects)
        .innerJoin(
          constructionObjects,
          eq(departmentConstructionObjects.constructionObjectId, constructionObjects.id),
        ),
    ]);
    const objectCodesByDepartmentId = new Map<string, string[]>();
    for (const link of links) {
      const list = objectCodesByDepartmentId.get(link.departmentId);
      if (list) list.push(link.code);
      else objectCodesByDepartmentId.set(link.departmentId, [link.code]);
    }
    for (const [departmentId, list] of objectCodesByDepartmentId) {
      objectCodesByDepartmentId.set(departmentId, canonicalObjectCodes(list));
    }
    return {
      objectIdByCode: new Map(objects.map((r) => [r.code, r.id])),
      objectCodesByDepartmentId,
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
      header: DEPARTMENT_OBJECTS_HEADER,
      /*
       * Прежнее имя колонки — «Площадка (код объекта)», когда площадка у отдела была одна
       * (ADR 0062). Псевдоним обязателен: незнакомый заголовок отвергает файл целиком, и без него
       * всякая книга, выгруженная до выката набора, перестала бы грузиться — а выгружают их
       * заранее и правят неделями.
       *
       * Старый файл несёт в этой колонке ОДИН код, и прочитан он будет как набор из одного, то
       * есть у отдела с тремя площадками загрузка оставит одну. Молчаливой потерей это не станет:
       * в отличие от старой формы карточки (там тот же случай отвечает 409 — ADR 0144, решение 5),
       * загрузка сначала показывает предпросмотр, и человек видит строкой отчёта
       * «АЛ13; СЕВ → АЛ13» до того, как что-либо записано.
       */
      aliases: ['Площадка (код объекта)'],
      width: 34,
      hint: 'Коды объектов через «;»: «АЛ13; СЕВ». Запятая разделителем не считается — она бывает частью кода. Порядок не важен: портал пишет набор по алфавиту. Пусто — набор не меняется; снимают площадки в карточке отдела.',
      get: objectCodesCell,
      /*
       * Пустая ячейка набор не трогает, хотя пустой набор законен. Причина та же, по которой это
       * правило стояло у одной площадки, и с набором она только весомее: снятие площадок меняет
       * область видимости всему отделу разом, гасит выданные токены и отзывает сессии его
       * сотрудникам (ADR 0144, решение 6). «В файле ячейку не заполнили» — а её не заполняют, когда
       * правят одно наименование, и колонку вообще вправе удалить, — не должно означать того же,
       * что осознанное снятие площадок в карточке отдела.
       *
       * Непустая ячейка задаёт набор ЦЕЛИКОМ, а не добавляет к заведённому: файл показывает
       * человеку то, что будет, и «в ячейке три кода, а в портале станет пять» читалось бы как
       * ошибка портала.
       */
      set: (m, text) => {
        const v = text.trim();
        if (v !== '') m.objectCodes = canonicalObjectCodes(parseSemicolonList(v));
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
    'Ключ строки — код. Площадки указываются кодами объектов через «;» и чаще всего их нет вовсе: площадок нет у большинства отделов (ADR 0144, развивает ADR 0062).',
    'Заполненная ячейка задаёт набор площадок целиком: чего в ней нет, то будет снято. Пустая ячейка набор не меняет — снимают площадки в карточке отдела.',
    'Смена набора площадок меняет область видимости сотрудников отдела: выданные им токены после загрузки перестают действовать, вход в портал придётся повторить.',
    'Руководители отдела файлом не правятся — это привязка учётной записи, а не поле справочника.',
  ],
  load: () => db.select().from(departments).orderBy(departments.code),
  id: (row) => row.id,
  model: (row, env) => ({
    code: row.code,
    name: row.name,
    // Копия, а не сам список из окружения: одну и ту же строку `model()` собирает дважды — «как
    // было» и «что станет», — и общий массив у двух моделей означал бы, что правка одной видна в
    // другой. Сегодня `set` список заменяет целиком и вреда бы не было; копия стоит здесь, чтобы
    // его не было и завтра.
    objectCodes: [...(env.objectCodesByDepartmentId.get(row.id) ?? [])],
    isActive: row.isActive,
  }),
  blank: () => ({ code: '', name: '', objectCodes: [], isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx, env) => {
    if (m.code === '') ctx.fail('строка без кода не заводится: по нему она и ищется в справочнике');
    if (m.name === '') ctx.fail('строка без наименования не заводится');
    /*
     * Порог спрашивается ПЕРВЫМ и здесь, а не только в сервисе: сервис проверяет его тоже (он
     * единственный писатель и обязан держать правило при любом вызывающем), но отвечает служебным
     * 400 без номера строки. Строку файла человеку и нужно назвать — иначе он ищет её в книге
     * сам. Порядок тот же, что в сервисе: длинный список из неизвестных кодов ответил бы сотней
     * жалоб «площадка не найдена», из которых не поймёшь, что дело в длине.
     */
    if (m.objectCodes.length > DEPARTMENT_OBJECTS_LIMIT) {
      ctx.fail(
        `площадок у отдела не больше ${DEPARTMENT_OBJECTS_LIMIT}, а в строке их ${m.objectCodes.length}`,
      );
      return;
    }
    for (const code of m.objectCodes) {
      if (!env.objectIdByCode.has(code)) {
        ctx.fail(`площадка «${code}» не найдена — сначала загрузите справочник объектов`);
      }
    }
  },
  /*
   * Набор площадок пишется ТОЛЬКО через `replaceDepartmentObjects` — единственного писателя
   * (ADR 0144, Р3). Своей записи в таблицу связи и в колонку совместимости у обмена нет, и это не
   * стилистика: писателей два — карточка справочника и этот файл, — а на смене области отдела
   * висит ещё пять обязательств (блокировка отдела, проверка объектов, порог, проекция в колонку
   * под триггером совместимости, `authVersion + 1` с отзывом сессий в той же транзакции).
   * Обязательство, оставленное вызывающему, второму вызывающему не достаётся: первый же импорт
   * сменил бы область молча, не погасив ни одной сессии.
   *
   * Отсюда же и запись в журнал доступа. Событие предметное — `department.create` /
   * `department.update` с разницей набора кодами (ADR 0144, решение 8): сводное `directory.import`
   * (`routes/directory-transfer.ts`) считает строки файла и на вопрос «кто и когда снял отделу эту
   * площадку» не отвечает — а больше нигде разница не хранится, карточка показывает только
   * «сейчас». Одно другого не заменяет: сводное остаётся.
   *
   * `writeAuditTx`, а не `writeAudit`: сбой записи обязан откатить саму правку. Область, изменённая
   * без события, — ровно то состояние, ради которого журнал заведён; отказ же виден сразу, и
   * загрузку повторят.
   */
  create: async (tx, m, env, actorUserId) => {
    // Отдел заводится без площадок, набор ставится следом: колонку `construction_object_id` пишет
    // проекцией сам сервис, и вписать её здесь значило бы завести второй источник одного значения.
    const [row] = await tx
      .insert(departments)
      .values({ code: m.code, name: m.name, isActive: m.isActive })
      .returning({ id: departments.id });
    const objects = await replaceDepartmentObjects(
      tx,
      row!.id,
      departmentObjectIds(m, env),
      actorUserId,
    );
    await writeAuditTx(tx, {
      actorUserId,
      action: 'department.create',
      entityType: 'department',
      entityId: row!.id,
      metadata: { objects },
    });
  },
  update: async (tx, row, m, env, actorUserId) => {
    await tx
      .update(departments)
      .set({ code: m.code, name: m.name, isActive: m.isActive, updatedAt: new Date() })
      .where(eq(departments.id, row.id));
    /*
     * Набор передаётся всегда, даже когда файл его не трогал: у заведённой записи модель собрана
     * из базы, пустая ячейка её не меняет, — и сервис на совпавшем наборе не пишет ничего, не
     * поднимает `authVersion` и не гасит сессий. Отдельного «менялись ли площадки» здесь поэтому
     * нет: сравнивать набор второй раз своими руками значило бы завести вторую редакцию того же
     * сравнения, расходящуюся с первой при первой же правке.
     *
     * `markDepartmentScopeChanged` отсюда убран: версию доступа поднимает и сессии отзывает сам
     * сервис, в этой же транзакции. Прежний довод «чистка сессий живёт вне транзакции, потому что
     * откату не подлежит» пересмотрен (ADR 0144, решение 6): он верен для вызова мимо транзакции,
     * а `refresh_sessions` — обычная таблица, и откат правки обязан откатывать отзыв.
     */
    const objects = await replaceDepartmentObjects(
      tx,
      row.id,
      departmentObjectIds(m, env),
      actorUserId,
    );
    await writeAuditTx(tx, {
      actorUserId,
      action: 'department.update',
      entityType: 'department',
      entityId: row.id,
      // `headsChanged` стоит и здесь, всегда ложью: событие обязано читаться одинаково, кто бы его
      // ни записал, а руководителей файл не правит вовсе — это привязка учётной записи.
      metadata: { headsChanged: false, objects },
    });
  },
});

// ── Контрагенты ──

interface CounterpartyModel {
  /** Пустая строка — тип не задан: так выглядит дописанная строка, которую завернёт `check()`. */
  type: CounterpartyType | '';
  name: string;
  inn: string;
  /** Общий ящик организации; сервисной компании на него уходят задания и отмены. */
  email: string;
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
      header: 'Email для заявок',
      width: 30,
      hint: 'Общий ящик организации. Сервисной компании на него уходят назначения и отмены; пустая ячейка заведённый адрес не стирает.',
      get: (m) => m.email,
      set: (m, text, ctx) => {
        const v = normalizeEmail(text);
        if (v === '' || v === m.email) return;
        if (!optionalEmailSchema.safeParse(v).success) {
          ctx.fail(`Email для заявок — ${EMAIL_FORMAT_MESSAGE}: «${text.trim()}»`);
          return;
        }
        m.email = v;
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
    // Старые снимки и тестовые строки до миграции поля не содержат: в модели это тот же пустой
    // адрес, иначе выгрузка и обратная загрузка расходятся на `undefined` против `''`.
    email: row.email ?? '',
    synonyms: env.synonymsById.get(row.id) ?? [],
    comment: row.comment,
    isActive: row.isActive,
  }),
  blank: () => ({
    type: '',
    name: '',
    inn: '',
    email: '',
    synonyms: [],
    comment: '',
    isActive: true,
  }),
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
        email: m.email,
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
        email: m.email,
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
