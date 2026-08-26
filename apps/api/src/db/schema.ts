import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AddressMeta,
  AssignmentChangeOrigin,
  AssignmentDimension,
  AssignmentHistoryState,
  AssignmentSupersedeKind,
  DriverStateKind,
  MailAccount,
  ModuleMailEvent,
  ReplyToMode,
  WaybillCorrectionAuthorizationScope,
  WasteTicketBlindCheckField,
  WasteTicketField,
} from '@technic/contracts';

/** case-insensitive text (расширение citext включается ops-ом до миграций). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ── Enums ──
export const roleEnum = pgEnum('role', [
  'admin',
  'manager',
  'dispatcher',
  'shtab',
  'rukstroy',
  // Комендант (миграция 0067) — заказчик на объекте по одному модулю: вывоз мусора.
  'commandant',
  // Площадка (ADR 0112, миграция 0152) — целевая объектная роль реформы доступа: одна вместо трёх.
  // Заведена раньше перевода учёток, потому что на неё ссылается каталог полномочий (`grant_roles`
  // у наборов «Заказ техники» и «Виза объекта»), а строку с несуществующим значением enum база не
  // примет. До этапа 8 роль не назначена ни одной учётке.
  'site',
  // Роли отдела (ADR 0040, миграция 0065) — заказчик со стороны офиса.
  'department',
  'department_head',
  'operator',
  'observer',
  // Водитель (ADR 0102, миграция 0130): работник справочника, получивший вход в свой кабинет.
  // Прав основного портала у роли нет вовсе — она открывает `/driver` и ничего больше.
  'driver',
  // Служба главного механика (миграция 0138): парк целиком, без своей оси области. Механик
  // смотрит, главный механик ведёт водителей и списывает бланки.
  'mechanic',
  'chief_mechanic',
]);
export const requestStatusEnum = pgEnum('request_status', [
  'new',
  'confirmed',
  'done',
  // Вывоз мусора (ADR 0135, миграция 0194): бумага разобрана и принята — заявка стала документом.
  // Значение добавлено `BEFORE 'cancelled'`, чтобы порядок enum'а совпал с порядком цикла: по нему
  // сортируется столбец «Статус». У заказа техники перехода в него нет вовсе — держит CHECK
  // `vehicle_requests_status_check` (миграция 0195).
  'completed',
  'cancelled',
]);
export const requestTypeEnum = pgEnum('request_type', [
  'container_install',
  'container_replace',
  'container_removal',
  'waste_removal',
  // Вывоз металлолома (ADR 0067, миграция 0090): заявка без предмета и цены, факт — весом.
  'metal_removal',
]);
export const containerKindEnum = pgEnum('container_kind', ['cont', 'truck']);
export const fileStatusEnum = pgEnum('file_status', ['pending', 'active', 'deleted']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'running', 'done', 'failed', 'dead']);
/**
 * Виды писем портала (миграция 0097): по нему же строится дедупликация и разбор в журнале.
 * `registration_rejected`, `registration_approved`, `account_created` — миграция 0114.
 */
export const mailKindEnum = pgEnum('mail_kind', [
  'verify_email',
  'password_reset',
  'password_changed',
  'driver_routes',
  'role_digest',
  'registration_rejected',
  'registration_approved',
  'account_created',
  /** Смена адреса учётки администратором (ADR 0092, миграция 0122) — письма на оба адреса. */
  'email_changed',
  /**
   * Письма модуля «Орг.техника» служебным адресатам (миграция 0142): заявка встала в очередь на
   * визу ИТ и заявка отменена. Событие, а не ручка: в «Новую» заявка входит и при заведении, и
   * откатом, и служба ждёт её в обоих случаях.
   */
  'service_request_waiting_it',
  'service_request_cancelled',
  /**
   * Заявка назначена исполнителю (миграция 0180). Первое письмо модуля, адресованное людям, а не
   * ящику службы: его получают назначенные поимённо и оператор сервисной компании.
   */
  'service_request_assigned',
]);
export const mailStatusEnum = pgEnum('mail_status', ['pending', 'sent', 'failed']);
/** Расписания рассылок (ADR 0075, миграция 0099). */
export const mailingTypeEnum = pgEnum('mailing_type', ['driver_routes', 'role_digest']);
export const mailingRunStatusEnum = pgEnum('mailing_run_status', [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
]);
export const mailingExcludedDateKindEnum = pgEnum('mailing_excluded_date_kind', ['run', 'route']);
/** Назначение одноразовой ссылки из письма (ADR 0072, миграция 0098). */
export const emailTokenPurposeEnum = pgEnum('email_token_purpose', [
  'verify_email',
  'password_reset',
]);
// Тип заявки на технику: заказ спецтехники / грузоперевозка (отдельно от request_type мусора).
export const vehicleRequestTypeEnum = pgEnum('vehicle_request_type', [
  'special_equipment',
  'freight_transport',
]);
// Принадлежность техники (ADR 0018): собственный парк и предложения аренды в одной таблице.
export const vehicleOwnershipEnum = pgEnum('vehicle_ownership', ['own', 'rental']);
// Чем мерят отработанное при закрытии заявки ТС (ADR 0029) — теми же единицами, в которых
// заведены ставки: за час и за смену.
export const vehicleWorkUnitEnum = pgEnum('vehicle_work_unit', ['hours', 'shifts']);
// Состояние запроса на досрочное завершение заказа спецтехники (ADR 0044): сокращение срока
// согласуется тем же руководителем строительства, что визировал заказ, — отсюда три состояния.
export const vehicleEarlyEndStatusEnum = pgEnum('vehicle_early_end_status', [
  'pending',
  'approved',
  'rejected',
]);
// Состояние путевого листа (ADR 0037). Черновика нет: лист рождается переводом заявки в работу
// сразу выданным, а испорченный бланк аннулируют с причиной — стереть его нельзя.
export const waybillStatusEnum = pgEnum('waybill_status', ['issued', 'cancelled']);
// Тип трудовых отношений физлица с организацией (ADR 0008).
export const employmentTypeEnum = pgEnum('employment_type', ['staff', 'contractor', 'temporary']);
// Статус проверки документа работника (ADR 0008); отделён от срока действия документа.
export const credentialVerificationStatusEnum = pgEnum('credential_verification_status', [
  'unverified',
  'verified',
  'rejected',
]);
// Состояние конкретного ТС (ADR 0007).
export const vehicleStatusEnum = pgEnum('vehicle_status', [
  'active',
  'inactive',
  'maintenance',
  'retired',
]);
// Роль контрагента в проекте (ADR 0010): у записи он один.
export const counterpartyTypeEnum = pgEnum('counterparty_type', [
  'general_contractor',
  'contractor',
  'operator',
  'vehicle_lessor',
  // Поставщик (ADR 0051, миграция 0076): сторона договора поставки, к которой привязаны склады.
  'supplier',
  // Сервисная компания (ADR 0085, миграция 0103): исполнитель заявок на обслуживание оргтехники.
  'service',
]);
// Кем человек назвал себя при регистрации (ADR 0034). Это пожелание, не роль: права даёт
// только `users.role`, назначаемая администратором. Двум значениям роли в портале не
// соответствуют вовсе — арендодателю техники и «другому».
export const registrationRoleRequestEnum = pgEnum('registration_role_request', [
  'dispatcher',
  'rukstroy',
  'site_staff',
  'commandant',
  'waste_operator',
  'vehicle_lessor',
  // Водитель (ADR 0102, миграция 0130): единственное пожелание, чья роль совпадает с ним
  // буквально. Отдельной кнопки на экране входа нет — человек выбирает себя в общем списке.
  'driver',
  'other',
]);

// ── Справочник: объекты строительства ──
export const constructionObjects = pgTable(
  'construction_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('construction_objects_code_unique').on(t.code),
    nameTrgm: index('construction_objects_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  }),
);

/**
 * Справочник отделов (ADR 0040) — офисные подразделения: снабжение, ПТО, АХО. Заведён по образцу
 * объектов строительства и отвечает на тот же вопрос с другой стороны: от чьего имени идёт
 * заявка. Как заказчик заявки на технику отдел объекту не родня — это вторая ось, а не её
 * продолжение (ADR 0040).
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /**
     * Площадка отдела (ADR 0062, миграция 0092): на ней его сотрудники заказывают вывоз мусора
     * наравне со штабом. NULL — рабочее состояние, а не незаполненность: отдел без площадки
     * (ПТО, АХО) объектных прав не даёт вовсе.
     *
     * Колонка у отдела, а не набор у учётки: у объекта отделов несколько, у отдела объект — один.
     */
    constructionObjectId: uuid('construction_object_id').references(() => constructionObjects.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('departments_code_unique').on(t.code),
    nameTrgm: index('departments_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    // «Какие отделы у объекта» — вопрос карточки объекта и производной области учётки.
    // Частичный: отделы без площадки в этот запрос не входят никогда.
    objectIdx: index('departments_construction_object_idx')
      .on(t.constructionObjectId)
      .where(sql`${t.constructionObjectId} IS NOT NULL`),
  }),
);

// ── Справочник: типы контейнеров и машин (различаются колонкой type) ──
export const containerTypes = pgTable(
  'container_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: containerKindEnum('type').notNull().default('cont'),
    // Вместимость (ADR 0009): база расчёта стоимости и проверки кратности объёма для тарифов,
    // объявленных «за контейнер». Nullable — у новых записей справочника может быть не задана.
    volumeM3: integer('volume_m3'),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('container_types_code_unique').on(t.code),
    volumePositive: check(
      'container_types_volume_positive_check',
      sql`${t.volumeM3} IS NULL OR ${t.volumeM3} > 0`,
    ),
  }),
);

// ── Типы мусора (ADR 0009, ведение — ADR 0017) ──
// «Что вывозим»: строительный мусор, бетонный бой, грунт, Тринити, древесные отходы.
// «Чем вывозим» — container_types; цена задаётся на пару (см. wasteTariffs). Отдельного
// справочника в интерфейсе нет: тип заводится вместе с первой ценой и правится в строке тарифа.
export const wasteTypes = pgTable(
  'waste_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Нормализованное название (GENERATED, миграция 0036): под ним живёт UNIQUE, ловящий
    // вариации написания одного типа. Значение считает БД — вставлять и обновлять его нельзя.
    nameKey: text('name_key').generatedAlwaysAs(sql`waste_type_name_key(name)`),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('waste_types_code_unique').on(t.code),
    codeFormat: check('waste_types_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('waste_types_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    nameKeyUnique: uniqueIndex('waste_types_name_key_unique').on(t.nameKey),
    nameKeyNotBlank: check('waste_types_name_key_not_blank_check', sql`${t.nameKey} <> ''`),
  }),
);

// ── Прайс вывоза мусора (ADR 0009) ──
// Тариф задаётся либо для конкретного типа контейнера/машины, либо для вида техники целиком;
// при расчёте точное совпадение по типу побеждает тариф вида. Цена всегда за 1 м³: позиция
// «15 000 ₽ за контейнер 8 м³» хранится как 1875 ₽/м³ + isPerContainer (кратность объёма).
// Позиция принадлежит оператору (ADR 0026): одну и ту же пару «мусор × техника» операторы возят
// по разным ставкам, поэтому оператор входит в ключ уникальности.
export const wasteTariffs = pgTable(
  'waste_tariffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Чья это цена. Требование «тип контрагента = operator» держит сервис — как и у
    // wasteRequests.operatorCounterpartyId (составной FK потребовал бы дублировать тип здесь).
    operatorCounterpartyId: uuid('operator_counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'restrict' }),
    wasteTypeId: uuid('waste_type_id')
      .notNull()
      .references(() => wasteTypes.id, { onDelete: 'restrict' }),
    containerTypeId: uuid('container_type_id').references(() => containerTypes.id, {
      onDelete: 'restrict',
    }),
    containerKind: containerKindEnum('container_kind'),
    pricePerM3: numeric('price_per_m3', { precision: 12, scale: 2 }).notNull(),
    pricePerContainer: numeric('price_per_container', { precision: 12, scale: 2 }),
    isPerContainer: boolean('is_per_container').notNull().default(false),
    note: text('note').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    target: check(
      'waste_tariffs_target_check',
      sql`(${t.containerTypeId} IS NOT NULL AND ${t.containerKind} IS NULL)
          OR (${t.containerTypeId} IS NULL AND ${t.containerKind} IS NOT NULL)`,
    ),
    pricePositive: check('waste_tariffs_price_positive_check', sql`${t.pricePerM3} > 0`),
    perContainer: check(
      'waste_tariffs_per_container_check',
      sql`NOT ${t.isPerContainer}
          OR (${t.containerTypeId} IS NOT NULL AND ${t.pricePerContainer} IS NOT NULL)`,
    ),
    operatorTypeContainerUnique: uniqueIndex('waste_tariffs_operator_type_container_unique')
      .on(t.operatorCounterpartyId, t.wasteTypeId, t.containerTypeId)
      .where(sql`${t.containerTypeId} IS NOT NULL`),
    operatorTypeKindUnique: uniqueIndex('waste_tariffs_operator_type_kind_unique')
      .on(t.operatorCounterpartyId, t.wasteTypeId, t.containerKind)
      .where(sql`${t.containerKind} IS NOT NULL`),
    wasteTypeIdx: index('waste_tariffs_waste_type_idx').on(t.wasteTypeId),
    operatorIdx: index('waste_tariffs_operator_idx').on(t.operatorCounterpartyId),
  }),
);

// ── Классификатор ТС: виды (справочник) ──
export const vehicleKinds = pgTable(
  'vehicle_kinds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('vehicle_kinds_code_unique').on(t.code),
    codeNotBlank: check('vehicle_kinds_code_not_blank', sql`btrim(${t.code}) <> ''`),
    nameNotBlank: check('vehicle_kinds_name_not_blank', sql`btrim(${t.name}) <> ''`),
  }),
);

// ── Классификатор ТС: плоский справочник типов (ADR 0005) ──
// Один уровень: тип ссылается на вид (kind_id). Иерархия/подтипы/source-mappings сняты (0014).

/**
 * По чему считается техобслуживание машин типа (миграция 0147, Р13). Объявлен здесь, а не рядом с
 * журналом ТО в конце файла: его колонка живёт у типа техники, а Drizzle требует перечисление до
 * первого использования.
 */
export const maintenanceBasisEnum = pgEnum('maintenance_basis', ['none', 'odometer']);

export const vehicleTypes = pgTable(
  'vehicle_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kindId: uuid('kind_id')
      .notNull()
      .references(() => vehicleKinds.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    // Категория прав по умолчанию для машин этого типа (ADR 0037, миграция 0059): подставляется
    // при заведении машины и отбор не сужает — отбирают по требованию самой машины.
    defaultQualificationCategoryId: uuid('default_qualification_category_id').references(
      () => qualificationCategories.id,
      { onDelete: 'restrict' },
    ),
    /**
     * Каким бланком выписывается лист на машины этого типа (ADR 0037, миграции 0060 и 0094).
     *
     * Код формы, а не флаг: легковым отвечает 'leg3', и второй схемы для них не понадобилось.
     * Пустым не бывает с 0094 (ADR 0065): «лист не выписывается» — это про принадлежность машины,
     * а не про её тип, и NULL здесь означал бы, что тип отвечает на вопрос, которого ему не
     * задавали. У собственной техники лист есть всегда, по умолчанию 4-П.
     */
    waybillFormCode: text('waybill_form_code')
      .$type<'4p' | 'leg3' | 'esm2'>()
      .notNull()
      .default('4p'),
    /**
     * Линейная техника (миграция 0127): вечером возвращается на базу и за день работает на
     * нескольких объектах. Заказ такого типа на объект ведётся по дням — 4-П на каждый день, а
     * ЭСМ-2 выписывается только по требованию, а не на каждую неделю срока (иначе — миграция 0087).
     *
     * Признак у типа, а не у машины: как ведётся заявка, решает заказ — какую технику просили, — а
     * не то, какую единицу под него потом нашли; тип известен с подачи, машина появляется только
     * при переводе в работу. Соседний `waybillFormCode` живёт здесь же по той же причине.
     *
     * Читается живым join'ом `vehicle_requests → vehicle_types`, снимка в заявке нет: тип заявки
     * неизменяем под назначенной машиной (ADR 0028 §9), значит справочник и есть то место, где на
     * вопрос отвечают. Плата — переключение признака меняет режим живых заявок на ходу, поэтому
     * смену запрещает сервер при заявках в работе; ключом в справочнике это состояние не выразить.
     */
    isLinear: boolean('is_linear').notNull().default(false),
    /**
     * Ведётся ли по машинам этого типа техобслуживание и по чему считается срок (миграция 0147,
     * Р13). `none` — не ведётся, `odometer` — по пробегу.
     *
     * Признак у типа и заводится явно, а не выводится из истории показаний: новая машина показаний
     * ещё не имеет, а временно пустой одометр не означает, что прибора нет, — вывод по данным
     * подсвечивал бы «пробег с ТО неизвестен» у каждой единицы в первый же день работы.
     *
     * Умолчание безопасное: пока справочник не размечен, ТО не требуется ни с кого.
     */
    maintenanceBasis: maintenanceBasisEnum('maintenance_basis').notNull().default('none'),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('vehicle_types_code_unique').on(t.code),
    codeFormat: check('vehicle_types_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    waybillForm: check(
      'vehicle_types_waybill_form_check',
      sql`${t.waybillFormCode} IN ('4p', 'leg3', 'esm2')`,
    ),
    codeNotBlank: check('vehicle_types_code_not_blank', sql`btrim(${t.code}) <> ''`),
    nameNotBlank: check('vehicle_types_name_not_blank', sql`btrim(${t.name}) <> ''`),
    kindActiveSortIdx: index('vehicle_types_kind_active_sort_idx').on(
      t.kindId,
      t.isActive,
      t.sortOrder,
    ),
  }),
);

// ── ТТХ: справочник характеристик (ADR 0016) ──
// Глобальный, а не «поле типа»: «Грузоподъёмность, т» — одна запись, общая для автокранов и
// самосвалов. unit/decimals входят в смысл канонизации значения и замораживаются после первого
// значения (проверяет сервис).
export const vehicleSpecs = pgTable(
  'vehicle_specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull().default(''),
    unit: text('unit').notNull().default(''),
    valueKind: text('value_kind').notNull().default('number').$type<'number'>(),
    decimals: smallint('decimals').notNull().default(0),
    minValue: numeric('min_value', { precision: 14, scale: 4 }),
    maxValue: numeric('max_value', { precision: 14, scale: 4 }),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('vehicle_specs_code_unique').on(t.code),
    nameUnitUnique: uniqueIndex('vehicle_specs_name_unit_unique').on(
      sql`lower(btrim(${t.name}))`,
      sql`lower(btrim(${t.unit}))`,
    ),
    activeSortIdx: index('vehicle_specs_active_sort_idx').on(t.isActive, t.sortOrder),
    codeFormat: check('vehicle_specs_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('vehicle_specs_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    valueKindCheck: check('vehicle_specs_value_kind_check', sql`${t.valueKind} IN ('number')`),
    decimalsRange: check('vehicle_specs_decimals_range_check', sql`${t.decimals} BETWEEN 0 AND 3`),
    bounds: check(
      'vehicle_specs_bounds_check',
      sql`${t.minValue} IS NULL OR ${t.maxValue} IS NULL OR ${t.minValue} <= ${t.maxValue}`,
    ),
  }),
);

// ── ТТХ: привязка к типу (ADR 0016) ──
// Привязка = обязательность: is_required нет намеренно — раз ТТХ привязан к типу, каждая категория
// типа обязана иметь по нему значение. PK — цель составного FK из значений категорий.
export const vehicleTypeSpecs = pgTable(
  'vehicle_type_specs',
  {
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    specId: uuid('spec_id')
      .notNull()
      .references(() => vehicleSpecs.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vehicleTypeId, t.specId] }),
    specIdx: index('vehicle_type_specs_spec_idx').on(t.specId),
  }),
);

// ── Категории типа ТС: условные подтипы (ADR 0016) ──
// Идентичность категории — набор значений ТТХ, а не наименование; её материализует spec_signature
// (см. SQL-функцию vehicle_category_signature) под уникальным индексом по (тип, сигнатура).
export const vehicleCategories = pgTable(
  'vehicle_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    isAutoName: boolean('is_auto_name').notNull().default(true),
    specSignature: text('spec_signature').notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Цель составного FK из значений — см. vehicleCategorySpecValues.categoryTypeFk.
    idTypeUnique: unique('vehicle_categories_id_type_unique').on(t.id, t.vehicleTypeId),
    typeSignatureUnique: uniqueIndex('vehicle_categories_type_signature_unique').on(
      t.vehicleTypeId,
      t.specSignature,
    ),
    typeActiveSortIdx: index('vehicle_categories_type_active_sort_idx').on(
      t.vehicleTypeId,
      t.isActive,
      t.sortOrder,
    ),
    nameNotBlank: check('vehicle_categories_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    // Пустая сигнатура запрещена: у типа без ТТХ категорий нет вовсе.
    signatureNotBlank: check(
      'vehicle_categories_signature_not_blank_check',
      sql`btrim(${t.specSignature}) <> ''`,
    ),
  }),
);

// ── Значения ТТХ у категории (ADR 0016) ──
// Пара составных FK запрещает значение по непривязанному ТТХ, значение у категории чужого типа и
// отвязку ТТХ, по которому есть значения. Полноту набора (нет пропущенных ТТХ) ключами не выразить —
// её держат сервис и отложенные constraint-триггеры из миграции 0035.
export const vehicleCategorySpecValues = pgTable(
  'vehicle_category_spec_values',
  {
    categoryId: uuid('category_id').notNull(),
    vehicleTypeId: uuid('vehicle_type_id').notNull(),
    specId: uuid('spec_id').notNull(),
    valueNum: numeric('value_num', { precision: 14, scale: 4 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.categoryId, t.specId] }),
    categoryTypeFk: foreignKey({
      columns: [t.categoryId, t.vehicleTypeId],
      foreignColumns: [vehicleCategories.id, vehicleCategories.vehicleTypeId],
      name: 'vehicle_category_spec_values_category_fk',
    }).onDelete('cascade'),
    typeSpecFk: foreignKey({
      columns: [t.vehicleTypeId, t.specId],
      foreignColumns: [vehicleTypeSpecs.vehicleTypeId, vehicleTypeSpecs.specId],
      name: 'vehicle_category_spec_values_type_spec_fk',
    }).onDelete('restrict'),
    specValueIdx: index('vehicle_category_spec_values_spec_value_idx').on(t.specId, t.valueNum),
  }),
);

// ── Справочник «Марка/модель» (ADR 0007) ──
// Одна запись = одно наименование марки/модели («Mustang 2700V», «МАЗ 6501В5»). Отдельной сущности
// марки (vehicle_makes) нет: изготовитель — текст. Модель принадлежит плоскому типу ТС.
// normalized_name считает БД (vehicle_model_normalize); поиск идёт через ту же функцию, чтобы
// нормализация не расходилась между приложением и индексом.
export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').generatedAlwaysAs(sql`vehicle_model_normalize(name)`),
    description: text('description').notNull().default(''),
    manufacturerName: text('manufacturer_name').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    nameNotBlank: check(
      'vehicle_models_name_not_blank_check',
      sql`vehicle_model_normalize(${t.name}) <> ''`,
    ),
    // Цель составного FK из vehicles — см. vehicles.modelTypeFk.
    idTypeUnique: unique('vehicle_models_id_type_unique').on(t.id, t.vehicleTypeId),
    typeNameUnique: uniqueIndex('vehicle_models_type_name_unique').on(
      t.vehicleTypeId,
      t.normalizedName,
    ),
    typeActiveIdx: index('vehicle_models_type_active_idx').on(t.vehicleTypeId, t.isActive),
    normalizedNameIdx: index('vehicle_models_normalized_name_idx').on(t.normalizedName),
  }),
);

// ── Конкретные ТС (ADR 0007) и предложения аренды (ADR 0018) ──
// Тип хранится явно (известен всегда), марка/модель — опциональна (в источнике есть машины без марки).
// Согласованность обеспечивает составной FK на (vehicle_models.id, vehicle_models.vehicle_type_id):
// при NULL-модели он не проверяется (MATCH SIMPLE), при заполненной — запрещает расхождение типов.
//
// Принадлежность (ownership) делит таблицу на две ветки: собственную машину описывают её реквизиты,
// аренду — арендодатель, цены и короткий срез-идентификатор. Ветки различают CHECK'и, а не
// detail-таблицы: на ветку приходится по три поля, а ссылаться на технику (назначение на заявку)
// нужно одной колонкой (ADR 0018 §1–2).
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownership: vehicleOwnershipEnum('ownership').notNull().default('own'),
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    // Категория (ADR 0016). У аренды — основной классификатор, у своей машины заполняется по мере
    // разнесения парка; NULL допустим у обеих веток.
    vehicleCategoryId: uuid('vehicle_category_id'),
    vehicleModelId: uuid('vehicle_model_id'),
    registrationNumber: text('registration_number'),
    registrationNumberNormalized: text('registration_number_normalized').generatedAlwaysAs(
      sql`vehicle_reg_normalize(registration_number)`,
    ),
    inventoryNumber: text('inventory_number'),
    // Гаражный номер (ADR 0037, миграция 0060) — своя графа бланка, отдельная от инвентарного:
    // тот из 1С и печатается в форме № 3 отдельной строкой.
    garageNumber: text('garage_number'),
    // Юрлицо, за которым числится машина (ADR 0037). NULL — за основной организацией портала:
    // пока юрлицо одно, ссылку не заполняют вовсе.
    ownerOrganizationId: uuid('owner_organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    serialNumber: text('serial_number'),
    passportNumber: text('passport_number'),
    manufacturerName: text('manufacturer_name').notNull().default(''),
    manufacturedOn: date('manufactured_on'),
    // Какая категория прав нужна, чтобы сесть за эту машину (ADR 0037, миграция 0059). Стоит у
    // машины, а не у типа: категорию определяет разрешённая максимальная масса, и в «Грузовых
    // малотоннажных» живут и ГАЗель под B, и HINO 300 под C. NULL — требование не заведено, и
    // отбор водителей по нему не сужается: пустое требование безопаснее неверного.
    requiredQualificationCategoryId: uuid('required_qualification_category_id').references(
      () => qualificationCategories.id,
      { onDelete: 'restrict' },
    ),
    // ── Аренда ──
    lessorId: uuid('lessor_id'),
    // Служебная: приложение всегда пишет 'vehicle_lessor'. Существует ради составного FK
    // на (counterparties.id, type) — им инвариант «арендодатель именно арендодатель» физический.
    lessorType: counterpartyTypeEnum('lessor_type'),
    // Активность арендодателя (ADR 0018 §15). Пишет не приложение, а каскад FK: у неактивного
    // арендодателя не может быть активной аренды, и держит это обычный CHECK по строке.
    lessorIsActive: boolean('lessor_is_active'),
    // Почему предложение выключено: каскадом от арендодателя (ADR 0018 §14) или отдельным
    // решением человека. Метка нужна, чтобы активация арендодателя вернула ровно то, что погасила.
    deactivatedWithLessor: boolean('deactivated_with_lessor').notNull().default(false),
    // Короткий срез вида «Автокран 70 тн» — то, чем человек различает два предложения одного
    // арендодателя, пока категории не заведены. Входит в ключ уникальности предложения.
    description: text('description').notNull().default(''),
    pricePerHour: numeric('price_per_hour', { precision: 12, scale: 2 }),
    pricePerShift: numeric('price_per_shift', { precision: 12, scale: 2 }),
    shiftHours: smallint('shift_hours'),
    status: vehicleStatusEnum('status').notNull().default('active'),
    sourceName: text('source_name').notNull().default(''),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    modelTypeFk: foreignKey({
      columns: [t.vehicleModelId, t.vehicleTypeId],
      foreignColumns: [vehicleModels.id, vehicleModels.vehicleTypeId],
      name: 'vehicles_model_type_fk',
    }).onDelete('restrict'),
    // Категория не может разойтись с типом — тот же приём, что и с моделью.
    categoryTypeFk: foreignKey({
      columns: [t.vehicleCategoryId, t.vehicleTypeId],
      foreignColumns: [vehicleCategories.id, vehicleCategories.vehicleTypeId],
      name: 'vehicles_category_type_fk',
    }).onDelete('restrict'),
    lessorFk: foreignKey({
      columns: [t.lessorId, t.lessorType, t.lessorIsActive],
      foreignColumns: [counterparties.id, counterparties.type, counterparties.isActive],
      name: 'vehicles_lessor_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    ownFields: check(
      'vehicles_own_fields_check',
      sql`${t.ownership} <> 'own' OR (
        ${t.lessorId} IS NULL AND ${t.lessorType} IS NULL
        AND ${t.pricePerHour} IS NULL AND ${t.pricePerShift} IS NULL AND ${t.shiftHours} IS NULL
        AND ${t.description} = ''
      )`,
    ),
    rentalFields: check(
      'vehicles_rental_fields_check',
      sql`${t.ownership} <> 'rental' OR (
        ${t.lessorId} IS NOT NULL
        AND (${t.pricePerHour} IS NOT NULL OR ${t.pricePerShift} IS NOT NULL)
        AND ${t.vehicleModelId} IS NULL
        AND ${t.registrationNumber} IS NULL
        AND ${t.passportNumber} IS NULL
      )`,
    ),
    rentalStatus: check(
      'vehicles_rental_status_check',
      sql`${t.ownership} <> 'rental' OR ${t.status} IN ('active', 'inactive')`,
    ),
    pricesPositive: check(
      'vehicles_prices_positive_check',
      sql`(${t.pricePerHour} IS NULL OR ${t.pricePerHour} > 0)
          AND (${t.pricePerShift} IS NULL OR ${t.pricePerShift} > 0)`,
    ),
    shiftHoursRange: check(
      'vehicles_shift_hours_range_check',
      sql`${t.shiftHours} IS NULL OR ${t.shiftHours} BETWEEN 1 AND 24`,
    ),
    lessorTypeCheck: check(
      'vehicles_lessor_type_check',
      sql`${t.lessorType} IS NULL OR ${t.lessorType} = 'vehicle_lessor'`,
    ),
    lessorPair: check(
      'vehicles_lessor_pair_check',
      sql`(${t.lessorId} IS NULL) = (${t.lessorType} IS NULL)`,
    ),
    deactivatedWithLessorOwn: check(
      'vehicles_deactivated_with_lessor_own_check',
      sql`${t.ownership} = 'rental' OR NOT ${t.deactivatedWithLessor}`,
    ),
    deactivatedWithLessorStatus: check(
      'vehicles_deactivated_with_lessor_status_check',
      sql`NOT ${t.deactivatedWithLessor} OR ${t.status} <> 'active'`,
    ),
    registrationNumberNotBlank: check(
      'vehicles_registration_number_not_blank_check',
      sql`${t.registrationNumber} IS NULL OR btrim(${t.registrationNumber}) <> ''`,
    ),
    inventoryNumberNotBlank: check(
      'vehicles_inventory_number_not_blank_check',
      sql`${t.inventoryNumber} IS NULL OR btrim(${t.inventoryNumber}) <> ''`,
    ),
    garageNumberNotBlank: check(
      'vehicles_garage_number_not_blank_check',
      sql`${t.garageNumber} IS NULL OR btrim(${t.garageNumber}) <> ''`,
    ),
    serialNumberNotBlank: check(
      'vehicles_serial_number_not_blank_check',
      sql`${t.serialNumber} IS NULL OR btrim(${t.serialNumber}) <> ''`,
    ),
    passportNumberNotBlank: check(
      'vehicles_passport_number_not_blank_check',
      sql`${t.passportNumber} IS NULL OR btrim(${t.passportNumber}) <> ''`,
    ),
    registrationNumberUnique: uniqueIndex('vehicles_registration_number_unique')
      .on(t.registrationNumberNormalized)
      .where(sql`${t.registrationNumberNormalized} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Одно предложение = (арендодатель, тип, категория, описание). В БД индекс объявлен
    // с NULLS NOT DISTINCT (миграция 0037) — без этого два предложения одного арендодателя
    // на тип без категории оба прошли бы, потому что NULL <> NULL. Драйвер этот модификатор
    // не выражает, поэтому здесь индекс описан без него: источник истины — SQL миграции.
    rentalOfferUnique: uniqueIndex('vehicles_rental_offer_unique')
      .on(t.lessorId, t.vehicleTypeId, t.vehicleCategoryId, t.description)
      .where(sql`${t.ownership} = 'rental' AND ${t.deletedAt} IS NULL`),
    deactivatedWithLessorIdx: index('vehicles_deactivated_with_lessor_idx')
      .on(t.lessorId)
      .where(sql`${t.deactivatedWithLessor}`),
    lessorIdx: index('vehicles_lessor_idx')
      .on(t.lessorId)
      .where(sql`${t.ownership} = 'rental'`),
    categoryIdx: index('vehicles_category_idx')
      .on(t.vehicleCategoryId)
      .where(sql`${t.vehicleCategoryId} IS NOT NULL`),
    ownerOrganizationIdx: index('vehicles_owner_organization_idx')
      .on(t.ownerOrganizationId)
      .where(sql`${t.ownerOrganizationId} IS NOT NULL`),
    // «Кто может сесть за эту машину» спрашивают при каждом переводе заявки в работу (ADR 0037).
    requiredCategoryIdx: index('vehicles_required_category_idx')
      .on(t.requiredQualificationCategoryId)
      .where(sql`${t.requiredQualificationCategoryId} IS NOT NULL`),
    // Цель составного FK из vehicle_request_assignments: назначенная машина должна быть того же
    // типа, что заказан заявкой (ADR 0027) — тем же приёмом, что «модель того же типа» выше.
    idTypeUnique: unique('vehicles_id_type_unique').on(t.id, t.vehicleTypeId),
    ownershipTypeIdx: index('vehicles_ownership_type_idx').on(t.ownership, t.vehicleTypeId),
    typeStatusIdx: index('vehicles_type_status_idx').on(t.vehicleTypeId, t.status),
    modelIdx: index('vehicles_model_idx').on(t.vehicleModelId),
    inventoryNumberIdx: index('vehicles_inventory_number_idx').on(t.inventoryNumber),
    serialNumberIdx: index('vehicles_serial_number_idx').on(t.serialNumber),
    deletedAtIdx: index('vehicles_deleted_at_idx').on(t.deletedAt),
  }),
);

// ── Прицепы и полуприцепы (план `docs/vehicle-trailers-plan.md`, миграция 0208) ──
// Прицеп НЕ единица техники и в `vehicles` не лежит (§4.1). Причина не в чистоте модели: `vehicles`
// читают 74 запроса в 37 файлах, и прицепная строка означала бы прицеп в списке заказываемой
// техники — его предложат назначить на заявку и спросят одометр. Довод предъявлен боевой базой:
// на проде уже есть заведённый руками тип «полуприцеп низкорамный», и в нём лежит настоящий тягач,
// потерявший при переносе марку (`vehicles_model_type_fk` снял модель вместе со сменой типа).
//
// Марка — текстовая колонка, а не ссылка на `vehicle_models`: та принадлежит `vehicle_type_id`, и
// ссылка вернула бы прицепные типы в классификатор техники. Состояние — существующий
// `vehicle_status`, своего enum у прицепа нет.
//
// Привязка к тягачу живёт здесь, а не на машине (§4.2): инвариант «полуприцеп стоит за одним
// тягачом» получается физическим — одна строка, одно значение, записать второго тягача некуда.
// Обратная раскладка (`vehicles.default_trailer_id`) допускала бы один прицеп за двумя машинами.
export const vehicleTrailers = pgTable(
  'vehicle_trailers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Графа «Тип ТС» из СТС. Тип объявлен здесь литералами, а не импортом `TrailerKind`: схема БД
    // не должна зависеть от контрактов, значения держит CHECK ниже.
    kind: text('kind').$type<'trailer' | 'semi_trailer'>().notNull().default('semi_trailer'),
    /** «ШМИТЦ SPR-24» — печатается в графе «(марка)» бланка целиком, строкой. */
    model: text('model').notNull(),
    registrationNumber: text('registration_number').notNull(),
    // Той же функцией, что у техники: правило написания госномера в портале одно, иначе номер из
    // реестра и номер из бланка перестанут быть одним номером.
    registrationNumberNormalized: text('registration_number_normalized').generatedAlwaysAs(
      sql`vehicle_reg_normalize(registration_number)`,
    ),
    vin: text('vin').notNull().default(''),
    passportNumber: text('passport_number').notNull().default(''),
    manufacturedYear: smallint('manufactured_year'),
    color: text('color').notNull().default(''),
    // Массы переносятся со СТС, хотя сегодня ни на что не влияют: ими когда-нибудь заменится
    // галочка прицепа проверкой «свыше 750 кг нужна E-категория» (ADR 0037 п. 8).
    maxMassKg: integer('max_mass_kg'),
    curbMassKg: integer('curb_mass_kg'),
    // Юрлицо, за которым числится прицеп. NULL — за основной организацией портала, как у техники.
    ownerOrganizationId: uuid('owner_organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    status: vehicleStatusEnum('status').notNull().default('active'),
    note: text('note').notNull().default(''),
    sourceName: text('source_name').notNull().default(''),
    hitchedVehicleId: uuid('hitched_vehicle_id').references(() => vehicles.id, {
      onDelete: 'restrict',
    }),
    /** 1|2 — слот бланка 4-П: тот же порядок, в каком графы печатаются. */
    hitchPosition: smallint('hitch_position').$type<1 | 2>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    kindCheck: check('vehicle_trailers_kind_check', sql`${t.kind} IN ('trailer', 'semi_trailer')`),
    // Марка и госномер печатаются в бланке: пустые дали бы графу, по которой прицеп не опознать.
    modelNotBlank: check('vehicle_trailers_model_not_blank', sql`btrim(${t.model}) <> ''`),
    regNotBlank: check('vehicle_trailers_reg_not_blank', sql`btrim(${t.registrationNumber}) <> ''`),
    yearRange: check(
      'vehicle_trailers_year_range',
      sql`${t.manufacturedYear} IS NULL OR ${t.manufacturedYear} BETWEEN 1900 AND 2100`,
    ),
    massPositive: check(
      'vehicle_trailers_mass_positive',
      sql`(${t.maxMassKg} IS NULL OR ${t.maxMassKg} > 0)
        AND (${t.curbMassKg} IS NULL OR ${t.curbMassKg} > 0)`,
    ),
    massOrder: check(
      'vehicle_trailers_mass_order',
      sql`${t.maxMassKg} IS NULL OR ${t.curbMassKg} IS NULL OR ${t.curbMassKg} <= ${t.maxMassKg}`,
    ),
    // Половина привязки бессмысленна: машина без слота не скажет, какую графу заполнять, а слот
    // без машины не скажет, чей он.
    hitchPair: check(
      'vehicle_trailers_hitch_pair',
      sql`(${t.hitchedVehicleId} IS NULL) = (${t.hitchPosition} IS NULL)`,
    ),
    hitchPositionCheck: check(
      'vehicle_trailers_hitch_position_check',
      sql`${t.hitchPosition} IS NULL OR ${t.hitchPosition} IN (1, 2)`,
    ),
    // Списанный и удалённый за машиной не стоят. Снятие держит сервис (списание и мягкое удаление
    // снимают привязку той же транзакцией), а это — физический запрет, чтобы забытая привязка не
    // пережила списание и не подставилась в рейс из архива.
    hitchStatusCheck: check(
      'vehicle_trailers_hitch_status_check',
      sql`${t.hitchedVehicleId} IS NULL OR ${t.status} <> 'retired'`,
    ),
    hitchAliveCheck: check(
      'vehicle_trailers_hitch_alive_check',
      sql`${t.hitchedVehicleId} IS NULL OR ${t.deletedAt} IS NULL`,
    ),
    // Удалённый освобождает номер — тот же приём, что у техники (`vehicles_registration_number_unique`).
    regUnique: uniqueIndex('vehicle_trailers_reg_unique')
      .on(t.registrationNumberNormalized)
      .where(sql`${t.deletedAt} IS NULL`),
    // «Слот занят один раз»: два прицепа не претендуют на графу «прицеп 1» одной машины. Обратное
    // — «прицеп стоит за одним тягачом» — индекса не требует, оно следует из того, что строка одна.
    hitchSlotUnique: uniqueIndex('vehicle_trailers_hitch_slot_unique')
      .on(t.hitchedVehicleId, t.hitchPosition)
      .where(sql`${t.hitchedVehicleId} IS NOT NULL`),
    // «Что закреплено за этой машиной» спрашивают при каждой сборке рейса — ради подстановки граф.
    hitchedVehicleIdx: index('vehicle_trailers_hitched_vehicle_idx')
      .on(t.hitchedVehicleId)
      .where(sql`${t.hitchedVehicleId} IS NOT NULL`),
    statusIdx: index('vehicle_trailers_status_idx')
      .on(t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── Пользователи ──
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    // ФИО по частям (ADR 0034), как у persons. Имя без CHECK на непустоту: учётки, заведённые
    // одним словом до миграции 0055, легальны — требование имени живёт в контрактах.
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    middleName: text('middle_name').notNull().default(''),
    // Считает БД (STORED): второй точки правды по ФИО нет, чтение и поиск идут по этой колонке.
    // Пробелы схлопываются, а не только обрезаются по краям (в отличие от persons): имя здесь
    // может быть пустым, и простой btrim оставил бы двойной пробел внутри строки.
    fullName: text('full_name')
      .notNull()
      .generatedAlwaysAs(
        sql`btrim(regexp_replace(last_name || ' ' || first_name || ' ' || middle_name, '\s+', ' ', 'g'))`,
      ),
    // Контактный телефон (ADR 0043, миграция 0070). Необязателен: пустая строка — «не указан».
    // Хранятся десять цифр без кода страны (ADR 0066, миграция 0095) — регион в портале всегда
    // +7, а вид «+7 (900) 000-00-00» даёт `formatPhone` на выводе. CHECK нет: записи, заведённые
    // до нормализации и к десяти цифрам не сводившиеся, остались как есть, и условие роняло бы
    // на них каждую правку строки. Формат держат контракты — `optionalPhoneSchema`.
    phone: text('phone').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role'), // назначается администратором; до активации может быть null
    // Объекты учётки — в user_construction_objects (миграция 0063): объектная роль работает
    // сразу на нескольких площадках, и колонкой такой набор не выражается.
    isActive: boolean('is_active').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    authVersion: integer('auth_version').notNull().default(0),
    // Контрагент учётки (ADR 0010): для роли «Оператор» задаёт область видимости — заявки,
    // назначенные этому контрагенту. Обязателен при role='operator' (CHECK, миграция 0023).
    // FK → counterparties.id ON DELETE RESTRICT объявлен миграцией 0022; здесь ссылка не
    // типизирована, чтобы не создавать цикл users ↔ counterparties (у контрагента поля аудита
    // ссылаются на users) — тот же приём, что и с personId.
    counterpartyId: uuid('counterparty_id'),
    // Физлицо, которому принадлежит учётка (ADR 0008). FK → persons.id ON DELETE SET NULL
    // объявлен миграцией 0018; здесь ссылка не типизирована, чтобы не создавать цикл
    // users ↔ persons (persons ссылается на users в полях аудита). Аналогично
    // refreshSessions.replacedBy. Пока связь не установлена, ФИО учётки живёт в users.fullName.
    personId: uuid('person_id'),
    // Кем человек назвал себя при регистрации и что уточнил (ADR 0034, миграция 0057). Роль
    // отсюда не выводится — она назначается администратором; объект и компания хранятся текстом,
    // потому что справочники неаутентифицированному не отдаются. У учёток, заведённых
    // администратором, пожелания нет: requestedRole = null.
    requestedRole: registrationRoleRequestEnum('requested_role'),
    requestedObject: text('requested_object').notNull().default(''),
    requestedCompany: text('requested_company').notNull().default(''),
    /**
     * Объяснение своими словами — у пожелания «Другое» (миграция 0139). Ему единственному не
     * соответствует роль портала, и без объяснения заявка не содержит ничего, по чему её можно
     * рассмотреть.
     *
     * CHECK на непустоту нет — в отличие от объекта и компании: заявки «Другое» в базе уже есть, и
     * заполнить их задним числом нечем, а условие сделало бы такую учётку неправимой — сорвалась
     * бы и активация, и привязка человека, и смена адреса. Требование живёт в `registerSchema`
     * (тот же приём, что с телефоном по ADR 0066 и контактом заявки в миграции 0118).
     */
    requestedComment: text('requested_comment').notNull().default(''),
    /**
     * Когда человек подтвердил, что этот ящик его (ADR 0072, миграция 0098). `null` — не
     * подтверждён: такую заявку нельзя активировать, потому что за адресом может не быть никого.
     * Учёткам, заведённым администратором, ставится сразу — адрес ввёл и проверил он сам.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Адрес занимает действующая учётка, а не архивная (ADR 0063, миграция 0095): отказ по заявке
    // иначе выжигал бы email навсегда. Отсюда обязанность всех выборок по адресу — вход,
    // регистрация, админское создание, сид — отбрасывать архив: одинаковых адресов в таблице
    // теперь бывает несколько, и первый попавшийся не тот, кого искали.
    emailUnique: uniqueIndex('users_email_unique')
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
    lastNameNotBlank: check('users_last_name_not_blank', sql`btrim(${t.lastName}) <> ''`),
    // Пожелание без уточнения там, где оно решает дело, бессмысленно: объектную роль без объекта
    // и оператора без компании всё равно не активировать (миграция 0057).
    requestedObjectPresent: check(
      'users_requested_object_check',
      sql`${t.requestedRole} IS NULL OR ${t.requestedRole} NOT IN ('rukstroy', 'site_staff', 'commandant') OR btrim(${t.requestedObject}) <> ''`,
    ),
    requestedCompanyPresent: check(
      'users_requested_company_check',
      sql`${t.requestedRole} IS NULL OR ${t.requestedRole} NOT IN ('waste_operator', 'vehicle_lessor') OR btrim(${t.requestedCompany}) <> ''`,
    ),
    /**
     * Живая учётка водителя без карточки человека невозможна (ADR 0102, миграция 0131): кабинет
     * без неё не ответит ни на один вопрос — ни какое у человека задание, ни на какой машине он
     * работал, — а выяснится это в шесть утра, когда он полез смотреть рейс.
     *
     * Условие про архив — не украшение: учётки уходят в архив мягко (ADR 0063), а `person_id`
     * архивной может обнулиться при удалении человека (`ON DELETE SET NULL`), и без этой ветки
     * архив стал бы неудаляемым и непочинимым.
     */
    driverPersonRequired: check(
      'users_driver_person_check',
      sql`${t.role} <> 'driver' OR ${t.personId} IS NOT NULL OR ${t.deletedAt} IS NOT NULL`,
    ),
    pendingRegistration: index('users_pending_registration_idx')
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isActive} = false AND ${t.role} IS NULL`),
    fullNameTrgm: index('users_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    // Одна действующая учётная запись на человека (ADR 0063, миграция 0095): архивная физлицо не
    // занимает — иначе вернувшийся сотрудник обошёл бы блокировку по адресу и упёрся в эту.
    personUnique: uniqueIndex('users_person_unique')
      .on(t.personId)
      .where(sql`${t.personId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  }),
);

/**
 * Объекты учётки (миграция 0063): область видимости объектной роли — набор, а не один объект.
 * Один штаб ведёт несколько площадок, руководитель строительства отвечает за куст объектов.
 *
 * Обязательность набора у объектной роли держит API (`routes/users.ts`), а не БД: CHECK читает
 * только колонки своей строки, а набор лежит здесь. Цена перехода с колонки, ADR 0039.
 */
export const userConstructionObjects = pgTable(
  'user_construction_objects',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    constructionObjectId: uuid('construction_object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.constructionObjectId] }),
    // «Кто работает на объекте» — вопрос с обратной стороны; PK покрывает только проход от учётки.
    objectIdx: index('user_construction_objects_object_idx').on(t.constructionObjectId),
  }),
);

/**
 * Отделы учётки (ADR 0040, миграция 0066) — вторая ось области, устроенная как объекты. Заполнена
 * всегда одна из двух: отдел — офис, объект — площадка, и одновременно учётка не работает там и
 * там. Инвариант держит API (`routes/users.ts`): он кросс-табличный, и CHECK его не выражает.
 *
 * Отсюда же берутся руководители в карточке отдела — но не ролью, а признаком связи `is_head`
 * (миграция 0149, план реструктуризации §11.1). «Руководитель этого отдела» — свойство связи
 * «человек ↔ отдел», а не человека вообще: в одном отделе он руководитель, в другом сотрудник, и
 * роль такого различить не может. До миграции 0149 карточка отдела спрашивала `users.role =
 * 'department_head'`; слияние ролей опустошило бы её молча, не тронув ни одного права.
 */
export const userDepartments = pgTable(
  'user_departments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    /**
     * Руководитель этого отдела. Прав не даёт и в расчёте доступа не участвует вовсе: доступ
     * считается ролью и наборами полномочий, а признак отвечает на вопрос справочника — «кто здесь
     * главный». Умолчание `false`: привязка из карточки учётки заводит сотрудника, а руководителя
     * назначают из карточки отдела (`replaceDepartmentHeads`).
     */
    isHead: boolean('is_head').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.departmentId] }),
    // «Кто в отделе» — вопрос карточки отдела; PK покрывает только проход от учётки.
    departmentIdx: index('user_departments_department_idx').on(t.departmentId),
  }),
);

/**
 * Надстройки роли (ADR 0086, миграция 0106) — третья ось субъекта доступа рядом с ролью и типом
 * контрагента. Хранится набором, как объекты и отделы учётки: одному человеку ничто не мешает
 * отвечать и за оргтехнику, и за то, что появится следующим.
 *
 * Совместимость надстройки с базовой ролью держит API (`ROLE_ADDON_BASE_ROLES` в контрактах), а не
 * CHECK: условие читало бы колонку соседней таблицы — тот же случай, из-за которого миграция 0063
 * сняла `users_rukstroy_object_check`.
 */
export const roleAddonEnum = pgEnum('role_addon', [
  'office_equipment_operator',
  // Согласование ИТ (миграция 0117): вторая надстройка и первая, которая меняет область — в
  // пределах модуля оргтехники (`ADDON_MODULE_WIDE_SCOPE` в контрактах).
  'office_equipment_it_approver',
]);

export const userRoleAddons = pgTable(
  'user_role_addons',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addon: roleAddonEnum('addon').notNull(),
    // Кто и когда выдал: надстройка расширяет доступ, и в журнале учёток это должно читаться так
    // же ясно, как смена роли. Отсюда и имена, отличные от `created_by`/`created_at` соседних
    // связей: там привязка описывает область, здесь — выданное полномочие.
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.addon] }),
  }),
);

/**
 * Назначаемые полномочия (ADR 0106, миграция 0145) — надстройка роли, переставшая быть значением
 * enum. Свободная сборка означает, что набор заводится в проде, а значение `role_addon` нельзя ни
 * создать из интерфейса, ни удалить вовсе.
 *
 * Шаг 1d перехода expand/contract: `user_role_addons` не пишется и не читается больше нигде — и
 * права (шаг 1c), и разница правки карточки считаются отсюда. Старая таблица стоит рядом мёртвой до
 * шага 1e, который снимет её вместе с полем `addons`; вернуть чтение к ней уже нельзя — выданное
 * после прекращения записи в ней не выражается вовсе, и такой откат был бы тихим снятием доступа.
 *
 * Совместимость набора с ролью и состав прав держит сервер, а не CHECK: оба условия кросс-табличные
 * — тот же случай, из-за которого миграция 0063 сняла `users_rukstroy_object_check`.
 */
export const grants = pgTable(
  'grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Стабильный код: по нему набор находят код приложения (`GRANT_MODULE_WIDE_SCOPE` — сквозная
    // область системного набора объявляется в контрактах), миграции каталога и журнал действий.
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    // Системный набор заводится миграцией, не правится и не удаляется из интерфейса; только он
    // может нести scope-эффект (ADR 0106, решение 2). Пользовательская копия его не наследует.
    isSystem: boolean('is_system').notNull().default(false),
    // Версия состава — слагаемое отпечатка последствий, которым проверяется подтверждение правки
    // (решение 7). Счёт с единицы: набор без единой правки — это состояние, а не его отсутствие.
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Мягкое удаление: удалить набор можно только после отзыва у всех держателей, но строка
    // остаётся — реестр выдач и журнал обязаны объяснять прошлые назначения.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    // Код держится за набором навсегда, а не освобождается после удаления, — в отличие от номеров
    // в справочниках с мягким удалением (`office_equipment_serial_unique`): на код ссылаются код,
    // журнал и реестр, и новый набор под кодом удалённого рассказывал бы историю за него. Поэтому
    // и частичного индекса `WHERE deleted_at IS NULL` рядом нет: он не добавил бы уникальности к
    // более сильной общей, а как путь доступа повторил бы тот же индекс по тому же столбцу.
    codeUnique: uniqueIndex('grants_code_unique').on(t.code),
    codeNotBlank: check('grants_code_not_blank_check', sql`btrim(${t.code}) <> ''`),
    nameNotBlank: check('grants_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
  }),
);

export const grantPermissions = pgTable(
  'grant_permissions',
  {
    grantId: uuid('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    // Право хранится текстом и сверяется со словарём `PERMISSIONS` при чтении; справочника прав в
    // базе нет намеренно — он был бы второй копией закрытого словаря контрактов и разъехался бы с
    // ним в первый же выкат, переименовавший право.
    //
    // Тип здесь не сужается до `Permission` тем же приёмом, что `ModuleMailEvent` у адресатов: у
    // тех строк реестр открыт, а у этих он закрыт, но строка может его пережить. После выката,
    // снявшего право, здесь остаются сироты; читатель обязан их отфильтровать (доступа они не
    // дают), а `$type<Permission>` пообещал бы, что фильтровать нечего.
    permission: text('permission').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.grantId, t.permission] }),
    // «В каких наборах есть это право» — обратный проход: предпросмотр последствий и пересмотр
    // словаря. PK покрывает только проход от набора.
    permissionIdx: index('grant_permissions_permission_idx').on(t.permission),
  }),
);

/**
 * Кому набор разрешено назначать. Своей таблицей, а не массивом внутри `grants`: роль убирают из
 * списка чаще, чем правят состав, и жизненный цикл различает «нельзя назначать впредь» и «уже
 * выданное сохраняется». Инвариант «ось роли × модуль» к тому же проверяется на декартовом
 * произведении `grant_roles × grant_permissions` — соединением, а не разбором массива.
 */
export const grantRoles = pgTable(
  'grant_roles',
  {
    grantId: uuid('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    // Роль — enum: её перечень закрыт и меняется только выкатом, в отличие от набора прав.
    role: roleEnum('role').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.grantId, t.role] }),
  }),
);

/**
 * Снимок перевода ролей (план §13, §13.2; ADR 0113, миграция 0154) — «кем человек был, что ему
 * выдали вместо этого и что вернуть при откате».
 *
 * Объявлена **до** `user_grants`, хотя по смыслу идёт после: на неё ссылается `migration_id`, и
 * прямой порядок избавляет от ссылки вперёд ради одной колонки.
 *
 * Пишется шагом prepare — тем же, что создаёт назначения: снимок без них отвечал бы только на
 * половину вопросов, а назначение без снимка не прошло бы CHECK происхождения. Перевод дописывает
 * `migrated_at`, откат сравнивает роль учётки с `role_after` и возвращает `role_before` — но только
 * той, у которой роль с тех пор не меняли руками.
 */
export const userRoleMigration = pgTable(
  'user_role_migration',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Номер этапа плана: 8 — три роли площадки, 9 — руководитель отдела. */
    stage: smallint('stage').notNull(),
    roleBefore: roleEnum('role_before').notNull(),
    roleAfter: roleEnum('role_after').notNull(),
    /** Когда выданы замещающие наборы. Между этим моментом и переводом проходит целый релиз. */
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
    /** Когда учётка переведена; `null` — наборы выданы, роль ещё прежняя. */
    migratedAt: timestamp('migrated_at', { withTimezone: true }),
  },
  (t) => ({
    // Один снимок на учётку и этап: повторный накат prepare безвреден, а второго снимка того же
    // перевода, по которому непонятно, какую роль возвращать, не бывает.
    userStageUnique: unique('user_role_migration_user_stage_unique').on(t.userId, t.stage),
  }),
);

export const userGrants = pgTable(
  'user_grants',
  {
    // Собственная идентичность назначения, а не PK «учётка + набор»: на неизменяемый `id` опирается
    // откат будущего перевода ролей — он снимает свои строки и не трогает выданное позже вручную.
    // Отзыв удаляет строку, повторная выдача создаёт новую; переиспользование прежней запрещено.
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // RESTRICT, а не CASCADE: каскад снимал бы доступ у живых учёток мимо пересчёта эффективных
    // прав, `authVersion` и журнала. Удаление выданного набора — это 409 со списком держателей.
    grantId: uuid('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'restrict' }),
    // Кто и когда выдал — как у надстройки роли. Перенос старых надстроек сохранит эти значения, а
    // не проставит момент переноса: меняется способ хранения, а не причина выдачи.
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    // Происхождение назначения: выдал администратор или создал перевод роли. Неизменяемо — на нём
    // держится откат перевода, который выданное вручную не трогает никогда.
    origin: text('origin').notNull().default('manual').$type<'manual' | 'migration'>(),
    // Каким переводом ролей выдано. Ключ и CHECK согласованности пришли шагом prepare этапа 8
    // (миграция 0154, ADR 0113) — в 1a колонка стояла без них, потому что таблицы, на которую они
    // указывают, ещё не существовало (ADR 0106, решение 3).
    migrationId: uuid('migration_id').references(() => userRoleMigration.id),
  },
  (t) => ({
    // Одно живое назначение на пару. Без него переносу назначений не на что опереть свой
    // `ON CONFLICT DO NOTHING`, а у учётки заводятся две строки одного набора.
    userGrantUnique: unique('user_grants_user_grant_unique').on(t.userId, t.grantId),
    // Держатели набора: правка блокирует и пересчитывает их всех одной транзакцией, удаление
    // отвечает их списком, и этот же индекс обслуживает проверку RESTRICT. Обратный проход —
    // «полномочия учётки» — закрывает префикс `user_id` уникального ограничения.
    grantIdx: index('user_grants_grant_idx').on(t.grantId),
    // Перечень закрыт поведением, а не реестром, — здесь CHECK уместен, в отличие от списка прав.
    originCheck: check('user_grants_origin_check', sql`${t.origin} in ('manual', 'migration')`),
    // «Выдано переводом» и «известно, каким переводом» — одно утверждение (миграция 0154):
    // `origin = 'migration'` без ссылки откат не найдёт и не снимет, а ссылка при `manual` означала
    // бы, что откат снимет выданное администратором своей рукой.
    migrationOriginCheck: check(
      'user_grants_migration_origin_check',
      sql`(${t.origin} = 'migration') = (${t.migrationId} IS NOT NULL)`,
    ),
  }),
);

// ── Refresh-сессии (ротация + reuse detection) ──
export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('refresh_sessions_token_hash_unique').on(t.tokenHash),
    userIdx: index('refresh_sessions_user_idx').on(t.userId),
    familyIdx: index('refresh_sessions_family_idx').on(t.familyId),
  }),
);

// ── Одноразовые ссылки из писем (ADR 0072, миграция 0098) ──
//
// Хранится только SHA-256 от значения из ссылки — тем же приёмом, что refresh-сессия: утечка дампа
// не должна давать ни входа в портал, ни возможности подтвердить чужой адрес. Одноразовость держит
// условие обновления (`used_at IS NULL` в WHERE), а не проверка в коде: два одновременных перехода
// по одной ссылке иначе оба сочли бы токен живым.
export const userEmailTokens = pgTable(
  'user_email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurposeEnum('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** С какого адреса запросили: расследование злоупотреблений — единственная причина хранить. */
    requestedIp: text('requested_ip').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('user_email_tokens_hash_unique').on(t.tokenHash),
    liveIdx: index('user_email_tokens_live_idx')
      .on(t.userId, t.purpose, sql`${t.createdAt} DESC`)
      .where(sql`${t.usedAt} IS NULL`),
    hashFormat: check('user_email_tokens_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    expiresAfterCreated: check(
      'user_email_tokens_expires_after_created',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
  }),
);

// ── Контрагенты (ADR 0010, миграция 0022) ──
// Генподрядчики, подрядчики, операторы вывоза мусора и арендодатели ТС в одной таблице: различает
// их только тип, набор полей одинаков. Идентичность — ИНН (одна живая запись на ИНН), поэтому тип
// у записи один: организация в другой роли — это смена типа, а не вторая запись.
// normalizedName считает БД (counterparty_name_normalize); поиск идёт через ту же функцию —
// приём из vehicleModels, чтобы нормализация не расходилась между приложением и индексом.
export const counterparties = pgTable(
  'counterparties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: counterpartyTypeEnum('type').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').generatedAlwaysAs(
      sql`counterparty_name_normalize(name)`,
    ),
    inn: text('inn').notNull(),
    comment: text('comment').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    nameNotBlank: check(
      'counterparties_name_not_blank_check',
      sql`counterparty_name_normalize(${t.name}) <> ''`,
    ),
    // 10 знаков у организации, 12 — у ИП/физлица. Контрольную сумму проверяет сервис.
    innFormat: check('counterparties_inn_format_check', sql`${t.inn} ~ '^([0-9]{10}|[0-9]{12})$'`),
    // Цель составного FK из vehicles.lessor_fk (ADR 0018 §10, §15): арендодателем можно указать
    // только контрагента роли vehicle_lessor, роль нельзя переписать, пока на него ссылается
    // аренда, а его активность каскадом доезжает до техники.
    idTypeActiveUnique: unique('counterparties_id_type_active_unique').on(t.id, t.type, t.isActive),
    innUnique: uniqueIndex('counterparties_inn_unique')
      .on(t.inn)
      .where(sql`${t.deletedAt} IS NULL`),
    typeActiveIdx: index('counterparties_type_active_idx')
      .on(t.type, t.isActive)
      .where(sql`${t.deletedAt} IS NULL`),
    nameTrgm: index('counterparties_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    normalizedNameIdx: index('counterparties_normalized_name_idx').on(t.normalizedName),
    deletedAtIdx: index('counterparties_deleted_at_idx').on(t.deletedAt),
  }),
);

// ── Синонимы наименования контрагента ──
// «Как пишут в накладных и выгрузках»: под одним ИНН организация встречается под разными
// наименованиями. Основное наименование здесь не дублируется — поиск объединяет два источника.
// Нормализованный синоним уникален глобально: он существует ради однозначного ответа
// «чьё это наименование», и один текст не может указывать на двух контрагентов.
export const counterpartySynonyms = pgTable(
  'counterparty_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    counterpartyId: uuid('counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').generatedAlwaysAs(
      sql`counterparty_name_normalize(name)`,
    ),
    createdAt: createdAt(),
  },
  (t) => ({
    nameNotBlank: check(
      'counterparty_synonyms_name_not_blank_check',
      sql`counterparty_name_normalize(${t.name}) <> ''`,
    ),
    nameUnique: uniqueIndex('counterparty_synonyms_name_unique').on(t.normalizedName),
    counterpartyIdx: index('counterparty_synonyms_counterparty_idx').on(t.counterpartyId),
    nameTrgm: index('counterparty_synonyms_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  }),
);

// ── Склады поставщиков (ADR 0051, миграция 0077) ──
// Склад — адрес, по которому работают с поставщиком; складов у поставщика много, поэтому связь
// не выражается колонкой в `counterparties`. Идентичность склада — пара «поставщик + адрес»,
// нормализацию адреса считает БД той же функцией, что и наименования контрагентов.
// Требование «тип контрагента = supplier» держит сервис — то же решение, что у
// `waste_requests.operator_counterparty_id` (ADR 0010 §6).
export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierCounterpartyId: uuid('supplier_counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'restrict' }),
    address: text('address').notNull(),
    normalizedAddress: text('normalized_address').generatedAlwaysAs(
      sql`counterparty_name_normalize(address)`,
    ),
    // Метка склада: пустая строка — «не задана», узнают склад по адресу.
    name: text('name').notNull().default(''),
    // Контакт склада: пустая строка — «не указан». Обязательности нет ни здесь, ни в CHECK.
    // Телефон — десять цифр без кода страны, как у остальных номеров портала (ADR 0066).
    contactPerson: text('contact_person').notNull().default(''),
    contactPhone: text('contact_phone').notNull().default(''),
    comment: text('comment').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    addressNotBlank: check(
      'warehouses_address_not_blank_check',
      sql`counterparty_name_normalize(${t.address}) <> ''`,
    ),
    // Пара «поставщик + адрес» уникальна; индекс покрывает и проход «склады этого поставщика».
    supplierAddressUnique: uniqueIndex('warehouses_supplier_address_unique').on(
      t.supplierCounterpartyId,
      t.normalizedAddress,
    ),
    addressTrgm: index('warehouses_address_trgm').using('gin', sql`${t.address} gin_trgm_ops`),
  }),
);

// ── Справочник оргтехники (ADR 0085, миграция 0104) ──
// Что стоит по кабинетам и площадкам: МФУ, ноутбуки, мониторы. Две таблицы — перечень типов и сами
// единицы; заявки на обслуживание ссылаются на единицу и хранят снимок её реквизитов.
export const officeEquipmentTypes = pgTable(
  'office_equipment_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('office_equipment_types_code_unique').on(t.code),
    nameNotBlank: check('office_equipment_types_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
  }),
);

/**
 * Перечень моделей аппаратов (план `docs/office-equipment-consumables-plan.md`, Р1; выпуск A).
 *
 * Картридж подходит **модели**, а не конкретной единице: «Тонер Ricoh 201» одинаково годится всем
 * карточкам Ricoh Aficio MP 201SPF и любой следующей, которую заведут завтра. Пока модель была
 * просто текстом в карточке, на вопрос «чем заправить этот аппарат» отвечал бы поиск по подстроке —
 * и промахивался на каждом «Ricon», кириллической «Н» в «НР» и «301SP» против «301SPF». Разнописание
 * в этом парке уже случалось: сид 0143 отдельно выправлял кириллические двойники.
 *
 * Модель существует независимо от парка: картриджи лежат на складе и для аппаратов, которых в
 * портале нет вовсе, и требование «сначала заведите технику» было бы отказом внести то, что есть.
 */
export const officeEquipmentModels = pgTable(
  'office_equipment_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    equipmentTypeId: uuid('equipment_type_id')
      .notNull()
      .references(() => officeEquipmentTypes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    // Производитель отдельной колонкой, а не первым словом имени: по нему группируют перечень, а
    // разбирать «Ricoh Aficio MP 201SPF» на части каждому читателю пришлось бы по-своему.
    manufacturer: text('manufacturer').notNull().default(''),
    // Гашение вместо удаления (Р11): погашенная модель не предлагается при заведении техники, но
    // остаётся у тех, кто на неё уже ссылается.
    isActive: boolean('is_active').notNull().default(true),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Правило написания живёт двумя IMMUTABLE-функциями базы (миграция 0171), а не выражением на
    // месте: как модель ПИШЕТСЯ — `office_equipment_model_name_normalize` (череда пробельных
    // схлопнута в один пробел, ПОТОМ обрезаны края; регистр не тронут — «ECOSYS» и «i-Sensys»
    // фирменные написания), по чему ОПОЗНАЁТСЯ — `office_equipment_model_key` (то же в верхнем
    // регистре). Звать их обязаны все двери разом: посчитай одно место ключ иначе — и оно
    // перестанет находить заведённое соседним, а выражение здесь было бы ровно такой копией.
    //
    // Порядок внутри функции обратному не равен: `btrim` снимает только пробелы, и краевой таб
    // после него стал бы краевым пробелом, убирать который уже некому, — функция перестала бы быть
    // идемпотентной, а `nameNormalized` ниже отверг бы её собственный результат.
    //
    // Класс шире `\s`: неразрывные U+00A0 и U+202F Postgres пробелами не считает, а приезжают они
    // из Word и Excel постоянно и дают в справочнике двойника, неотличимого на экране. Символы
    // нулевой ширины и мягкий перенос в класс намеренно не входят — они отмечают перенос ВНУТРИ
    // слова, и схлопывание превратило бы «Ricoh<U+00AD>IM» в «Ricoh IM», то есть испортило бы имя.
    nameNotBlank: check(
      'office_equipment_models_name_not_blank_check',
      sql`office_equipment_model_key(${t.name}) <> ''`,
    ),
    // В справочнике имя лежит уже свёрнутым. Без этой проверки правило держал бы только индекс, то
    // есть ключ, — а маршрут завёл бы «Ricoh␣␣IM 350» с двойным пробелом в самом наименовании, и
    // оно уехало бы зеркалом во все карточки модели: тот же дефект, только другой дверью.
    nameNormalized: check(
      'office_equipment_models_name_normalized_check',
      sql`${t.name} = office_equipment_model_name_normalize(${t.name})`,
    ),
    // Цель составного ключа из карточки техники — см. officeEquipment.modelTypeFk.
    idTypeUnique: unique('office_equipment_models_type_unique').on(t.id, t.equipmentTypeId),
    // Уникальность по паре «тип + ключ написания», а не по одному имени: пара разводит одинаково
    // названные принтер и МФУ, а ключ не даёт завести ту же модель вторым написанием — «Ricoh IM
    // 350», «RICOH IM 350» и «Ricoh␣␣IM 350» это одна строка. На этот же индекс опирается резолв в
    // триггере (Р3): недостающую модель он заводит через
    // `ON CONFLICT (equipment_type_id, office_equipment_model_key(name))`.
    typeNameUnique: uniqueIndex('office_equipment_models_name_unique').on(
      t.equipmentTypeId,
      sql`office_equipment_model_key(${t.name})`,
    ),
  }),
);

/**
 * Где физически находится единица (миграция 0120). Не «статус жизненного цикла»: списание и ввод
 * в эксплуатацию модулем не ведутся (§12 плана модуля), а `is_active` отвечает на другой вопрос —
 * «эксплуатируется ли». Здесь только местонахождение, и меняет его перемещение.
 */
export const officeEquipmentStateEnum = pgEnum('office_equipment_state', [
  'on_site',
  'at_service',
  'in_stock',
  'with_employee',
]);

export const officeEquipment = pgTable(
  'office_equipment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    equipmentTypeId: uuid('equipment_type_id')
      .notNull()
      .references(() => officeEquipmentTypes.id, { onDelete: 'restrict' }),
    // Наименование модели: «Kyocera ECOSYS M3145». Опознают единицу номерами, но выбирают глазами
    // по модели — поэтому поле обязательное.
    name: text('name').notNull(),
    // Модель записью справочника (Р1). Колонка nullable — это выпуск A (Р2): миграции
    // накатываются до перезапуска, и в окне выката живой старый код заводит карточку, ничего не
    // зная о колонке. `NOT NULL` ставит следующий выпуск, когда ссылку пишет уже весь код.
    // Заполняет её не маршрут, а триггер зеркала (Р3): заливка файлом и скрипты пишут мимо
    // маршрута, а `name` с этого момента — копия имени модели, а не то, что ввели руками.
    modelId: uuid('model_id'),
    serialNumber: text('serial_number').notNull().default(''),
    inventoryNumber: text('inventory_number').notNull().default(''),
    // Где стоит. Офис заводится таким же объектом строительства: площадка у техники есть всегда.
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    // За каким отделом числится. NULL — не закреплена: на область заявок это не влияет (у заявки
    // свой заказчик), но от разметки зависит, увидит ли отдел «заявки по нашей технике».
    ownerDepartmentId: uuid('owner_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    // Место внутри объекта: «кабинет 214», «прорабская». Свободный текст — планировок в портале нет.
    location: text('location').notNull().default(''),
    // Местонахождение и уточнение к нему (миграция 0120): меняются только перемещением, не правкой
    // карточки — переезд обязан оставлять след в журнале.
    state: officeEquipmentStateEnum('state').notNull().default('on_site'),
    stateNote: text('state_note').notNull().default(''),
    purchasedOn: date('purchased_on'),
    // Гарантия поставщика на саму единицу; гарантии на запчасти и работы живут в заявках.
    warrantyUntil: date('warranty_until'),
    comment: text('comment').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    nameNotBlank: check('office_equipment_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    // Модель обязана быть своего типа: приписать МФУ модель принтера нельзя (Р1). Межтабличной
    // проверки в Postgres нет, и держит это составной ключ — вторая колонка пары и есть проверка.
    // Режим «замок» (`ON UPDATE` умолчанием): тип модели неизменяем, а отказ обязан быть словами
    // маршрута, а не ошибкой целостности — род ключа назван в schema-copy-keys.test.ts.
    // `restrict` на удаление: модель, на которую ссылается хоть одна карточка — живая или
    // архивная, — не удаляют, а гасят (Р11), и держит это схема, а не вежливость маршрута.
    modelTypeFk: foreignKey({
      columns: [t.modelId, t.equipmentTypeId],
      foreignColumns: [officeEquipmentModels.id, officeEquipmentModels.equipmentTypeId],
      name: 'office_equipment_model_type_fk',
    }).onDelete('restrict'),
    // Единицу нужно чем-то опознать при приёмке из ремонта: хотя бы один номер обязателен.
    identity: check(
      'office_equipment_identity_check',
      sql`btrim(${t.serialNumber}) <> '' OR btrim(${t.inventoryNumber}) <> ''`,
    ),
    // Номера уникальны среди живых записей: удалённая карточка номер не держит.
    serialUnique: uniqueIndex('office_equipment_serial_unique')
      .on(sql`upper(btrim(${t.serialNumber}))`)
      .where(sql`${t.deletedAt} IS NULL AND btrim(${t.serialNumber}) <> ''`),
    inventoryUnique: uniqueIndex('office_equipment_inventory_unique')
      .on(sql`upper(btrim(${t.inventoryNumber}))`)
      .where(sql`${t.deletedAt} IS NULL AND btrim(${t.inventoryNumber}) <> ''`),
    objectIdx: index('office_equipment_object_idx')
      .on(t.objectId)
      .where(sql`${t.deletedAt} IS NULL`),
    departmentIdx: index('office_equipment_department_idx')
      .on(t.ownerDepartmentId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.ownerDepartmentId} IS NOT NULL`),
    typeIdx: index('office_equipment_type_idx').on(t.equipmentTypeId),
    // Индекс нужен обеим сторонам связи: по нему раскладывается новое имя модели по её карточкам
    // (Р3) и проверяется запрет удаления. `deleted_at` в условие не идёт — архивные карточки
    // участвуют и в раскладке имени, и в запрете.
    modelIdx: index('office_equipment_model_idx').on(t.modelId),
    nameTrgm: index('office_equipment_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    warrantyIdx: index('office_equipment_warranty_idx')
      .on(t.warrantyUntil)
      .where(sql`${t.deletedAt} IS NULL AND ${t.warrantyUntil} IS NOT NULL`),
    // «На складе» и «у сотрудника» без уточнения — потерянная техника: искать её негде.
    stateNote: check(
      'office_equipment_state_note_check',
      sql`${t.state} IN ('on_site','at_service') OR btrim(${t.stateNote}) <> ''`,
    ),
  }),
);

/**
 * Журнал перемещений (миграция 0120, Р59): куда, когда и почему уехала единица.
 *
 * Своя таблица, а не аудит: перемещение — предмет отчёта («что приехало на площадку за месяц»), а
 * не след действия, и у него есть дата переезда, отличная от даты записи. Обе стороны хранятся
 * ссылками: по целевому объекту строится срез принимающей стороны, а строка журнала должна
 * оставаться читаемой после переименования площадок.
 */
export const officeEquipmentMovements = pgTable(
  'office_equipment_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => officeEquipment.id, { onDelete: 'cascade' }),
    fromObjectId: uuid('from_object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    toObjectId: uuid('to_object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    fromDepartmentId: uuid('from_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    toDepartmentId: uuid('to_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    fromLocation: text('from_location').notNull().default(''),
    toLocation: text('to_location').notNull().default(''),
    fromState: officeEquipmentStateEnum('from_state').notNull(),
    toState: officeEquipmentStateEnum('to_state').notNull(),
    // Дата переезда, а не момент записи: технику увозят в пятницу, а заносят в понедельник.
    movedOn: date('moved_on').notNull(),
    reason: text('reason').notNull(),
    comment: text('comment').notNull().default(''),
    // Переезд, вызванный ремонтом: «увезли в сервис» и «вернулась». SET NULL — заявку могут снести
    // насовсем, а факт переезда от этого не отменяется.
    serviceRequestId: uuid('service_request_id').references(() => serviceRequests.id, {
      onDelete: 'set null',
    }),
    movedBy: uuid('moved_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => ({
    reasonNotBlank: check(
      'office_equipment_movements_reason_not_blank_check',
      sql`btrim(${t.reason}) <> ''`,
    ),
    // Перемещение, которое ничего не переместило, — запись ни о чём.
    change: check(
      'office_equipment_movements_change_check',
      sql`${t.fromObjectId} <> ${t.toObjectId}
          OR ${t.fromState} <> ${t.toState}
          OR ${t.fromLocation} <> ${t.toLocation}
          OR ${t.fromDepartmentId} IS DISTINCT FROM ${t.toDepartmentId}`,
    ),
    equipmentIdx: index('office_equipment_movements_equipment_idx').on(t.equipmentId, t.movedOn),
    toObjectIdx: index('office_equipment_movements_to_object_idx').on(t.toObjectId, t.movedOn),
  }),
);

// ── Расходники оргтехники: картриджи и тонеры (план `docs/office-equipment-consumables-plan.md`,
// Р5–Р7; миграция расходников, волна В5) ──
//
// Три таблицы: сама номенклатура, разметка совместимости «расходник — модель» и журнал остатка.
// Остаток лежит в карточке числом, а меняется только событием журнала — складского учёта у
// ИТ-службы нет, приход и выдачу операциями никто оформлять не станет, и число вводит человек.
// Держат порядок при этом не маршрут и не его аккуратность, а ограничения и триггеры: журнал
// сверяет оба конца цепочки, отложенная проверка на карточке не даёт остатку измениться без
// события, а сами строки журнала неизменяемы (Р7, Р11).

/**
 * Номенклатура расходников (Р5): код учётной системы, наименование как в ней же, остаток.
 *
 * Наименование хранится ровно как в источнике, вместе с хвостом «(шт)»: справочник сверяют глазами
 * со счётом и выгрузкой, и «причёсанное» наименование эту сверку ломает. Отдельного поля «единица
 * измерения» нет — штуки единственная.
 *
 * Цвет прошёл полный круг и вернулся: 20.08.2026 его сняли (во всей присланной таблице он упомянут
 * дважды и оба раза означал «комплект всех цветов»), а решением от 21.08 завели снова — но не
 * перечнем из пяти значений, который тогда и не окупался, а свободной строкой рядом. Подробности —
 * у самой колонки ниже.
 *
 * Вид расходника (картридж, тонер, принт-тонер) отдельным перечнем не заводится: это часть
 * наименования поставщика, а не ось, по которой считают.
 */
export const officeEquipmentConsumables = pgTable(
  'office_equipment_consumables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Код номенклатуры учётной системы: «Б0000014256», «Д0000337741». По нему сверяют со счётом. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /**
     * Сколько штук на складе. Правится не формой карточки, а своей ручкой (Р7) — и это не
     * соглашение маршрута: `updateOfficeEquipmentConsumableSchema` количества не принимает вовсе,
     * а `UPDATE` мимо журнала отбивает отложенный триггер на этой таблице.
     */
    quantity: integer('quantity').notNull().default(0),
    /** Гашение вместо удаления (Р11): то, что больше не покупают, из перечня не исчезает. */
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Цвет позиции (Р5) — свойство карточки, а не строки заявки: складская позиция определяется
     * кодом, и четыре цвета с четырьмя кодами — это четыре позиции с четырьмя остатками. Код на
     * комплект заводится позицией с цветом «комплект».
     *
     * Текстом, а не перечнем: источник приносит и CMYK, и «комплект», и поставщицкие названия.
     * «Нет цвета» — это `null`; пустую строку отбивает `CHECK`, иначе у одного состояния было бы
     * два представления.
     */
    color: text('color'),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Правило написания кода живёт IMMUTABLE-функцией базы `office_equipment_consumable_code_key`,
    // а не выражением на месте, — по той же причине, что у моделей (Р4): двери в справочник
    // разные (форма, обмен файлом, скрипт), и посчитай одна из них ключ иначе — она перестанет
    // находить заведённое соседней. Сегодняшний урок моделей прямой: правило там меняли дважды за
    // одну волну, и копия на TypeScript разошлась бы с базой молча.
    //
    // Правило у кода **своё**, и от имени модели оно отличается не мелочью: пробельные символы,
    // включая неразрывные из Word и Excel, **удаляются**, а не схлопываются в один. В коде учётной
    // системы пробелов не бывает вовсе — «Д0000337741» с прилипшим неразрывным пробелом это тот же
    // код, а не соседний, — тогда как «Ricoh␣IM 350» без пробела стало бы другим именем. Регистр,
    // наоборот, поднимается прямо в написании, поэтому функция здесь одна, а не пара «как пишется
    // + по чему опознаётся»: фирменных строчных букв в коде номенклатуры нет.
    codeNotBlank: check(
      'office_equipment_consumables_code_not_blank_check',
      sql`office_equipment_consumable_code_key(${t.code}) <> ''`,
    ),
    // Код лежит в справочнике уже нормализованным. Без этой проверки правило держал бы только
    // индекс, то есть ключ, — а в карточке и в выгрузке остался бы «д0000337741 » с хвостом
    // пробела, который человек глазами со счётом уже не сведёт.
    codeNormalized: check(
      'office_equipment_consumables_code_normalized_check',
      sql`${t.code} = office_equipment_consumable_code_key(${t.code})`,
    ),
    // Пустоту имени меряет тот же класс пробельных символов, что и код: `btrim` неразрывный пробел
    // не снимает, и наименование из одних U+00A0 — а приезжают они из Word и Excel постоянно —
    // прошло бы в справочник как непустое, заняв строку, которую на экране не отличить от пустой.
    //
    // Класс общий, а правила разные, и это не оговорка: у кода спрашивают «один ли это код»
    // (отсюда функция и хранение в нормализованном виде), у имени — «есть ли в строке хоть один
    // настоящий знак». Имя хранится дословно, вместе с хвостом «(шт)» и внутренними пробелами
    // (Р5), сравнивать и нормализовать его негде, поэтому правило стоит выражением на месте, а не
    // функцией: функция обещала бы нормализацию и напрашивалась бы в маршрут.
    //
    // Обратные слэши удвоены, и это не стиль: в шаблонной строке JS `\s` съедается до буквы «s», а
    // `\u00a0` — до самого неразрывного пробела, и в базу уехал бы класс `[s ...]+`,
    // считающий пустым имя из одних «s». В базе лежит ровно `[\s\u00a0\u202f]+`, и записан
    // он escape-последовательностями, как в миграции 0172: невидимый байт в исходнике нельзя
    // вычитать на ревью, а любой редактор способен его потерять.
    nameNotBlank: check(
      'office_equipment_consumables_name_not_blank_check',
      sql`regexp_replace(${t.name}, '[\\s\\u00a0\\u202f]+', '', 'g') <> ''`,
    ),
    // Остаток неотрицателен: «минус два картриджа» не бывает ни на складе, ни в отчёте.
    colorNotBlank: check(
      'office_equipment_consumables_color_not_blank_check',
      sql`${t.color} IS NULL OR btrim(${t.color}) <> ''`,
    ),
    quantityNonNegative: check(
      'office_equipment_consumables_quantity_check',
      sql`${t.quantity} >= 0`,
    ),
    // Занятость кода маршрут проверяет заранее и отвечает словами «расходник с таким кодом уже
    // заведён» (как у типов оргтехники), но последнее слово за индексом: две вкладки, обмен файлом
    // и скрипт мимо маршрута приходят к одной и той же строке.
    codeUnique: uniqueIndex('office_equipment_consumables_code_unique').on(
      sql`office_equipment_consumable_code_key(${t.code})`,
    ),
    // Поиск идёт по наименованию и коду (Р9); индекс — под наименование, по нему спрашивают
    // подстрокой («Pantum», «PC-211»), а код чаще вставляют целиком.
    nameTrgm: index('office_equipment_consumables_name_trgm').using(
      'gin',
      sql`${t.name} gin_trgm_ops`,
    ),
  }),
);

/**
 * Совместимость «расходник — модель» (Р6): к чему подходит картридж.
 *
 * Связь много-ко-многим, и обе стороны нужны по-настоящему: PC-211EV годится трём Pantum, а у
 * Ricoh Aficio MP C2011SP расходников два — чёрный и цветной. Любая односторонняя связь списывала
 * бы половину случаев из присланной таблицы (§7).
 *
 * Это разметка, а не история: строка снимается свободно с обеих сторон, поэтому удаление расходника
 * уносит привязки каскадом. Модель каскаду не подлежит — на неё ссылаются, значит её гасят (Р11).
 */
export const officeEquipmentConsumableModels = pgTable(
  'office_equipment_consumable_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    consumableId: uuid('consumable_id')
      .notNull()
      .references(() => officeEquipmentConsumables.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id')
      .notNull()
      .references(() => officeEquipmentModels.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => ({
    // Пара уникальна: «подходит» — это да или нет, и вторая такая же строка ничего не добавляет,
    // зато удвоила бы счётчик моделей в списке расходников.
    pairUnique: unique('office_equipment_consumable_models_unique').on(t.consumableId, t.modelId),
    // Индекс со стороны модели: по нему идут оба вопроса, которые задают справочнику с этого конца
    // — «чем заправлять этот аппарат» (Р15) и «удаляема ли модель» (Р11). Уникальный ключ выше
    // читается только слева направо и ни одному из них не помогает.
    modelIdx: index('office_equipment_consumable_models_model_idx').on(t.modelId),
  }),
);

/**
 * Журнал остатка (Р7): каждое изменение количества — событие с обоими концами, причиной и автором.
 *
 * Журнал здесь не след действия (для этого есть аудит), а сам предмет: на вопрос «куда делись
 * двенадцать картриджей» отвечает только он. Поэтому он неизменяем — правку и удаление строки
 * отбивает триггер, как у переходов режима назначений, — а исправляют ошибку следующим событием
 * («ошиблись, вернули 15»), а не подчисткой прошлого.
 */
export const officeEquipmentConsumableStockEntries = pgTable(
  'office_equipment_consumable_stock_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Порядок в цепочке держит счётчик, а не время: две правки одной секунды по `created_at`
     * неразличимы, а «предыдущая строка этого расходника» обязана определяться однозначно —
     * на этом стоит проверка цепочки. Тот же приём, что у `app_releases.seq`.
     */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    /**
     * `restrict`, а не `cascade`: правило «есть движение — только гашение» (Р11) держит схема.
     * Маршрут проверяет то же самое заранее, но лишь затем, чтобы человек прочитал «по расходнику
     * есть движение, снимите „Активен“», а не имя ограничения; унести историю вместе с карточкой
     * не может ни он, ни скрипт, ни ручной `DELETE`.
     */
    consumableId: uuid('consumable_id')
      .notNull()
      .references(() => officeEquipmentConsumables.id, { onDelete: 'restrict' }),
    /**
     * Вид события (план переработки заявок, §2.1): `manual` — ручная правка кладовщика, `issue` —
     * выдача по заявке, `return` — возврат выданного. Умолчание сохраняет контракт ручной ручки:
     * вид она проставляет сама, клиент его не выбирает.
     */
    entryKind: text('entry_kind')
      .$type<'manual' | 'issue' | 'return'>()
      .notNull()
      .default('manual'),
    /**
     * Заявка, по которой прошло движение, и её строка. Обе ссылки **не типизированы** здесь
     * намеренно — тот же приём, что у `warrantyClaimItemId`: расходники объявлены выше заявок, и
     * стрелка `() => serviceRequests.id` тянула бы значение, которого в этот момент ещё нет. Сами
     * ключи стоят в базе: `service_request_id` → `service_requests` с `RESTRICT` уже в миграции
     * `0172`, а составной ключ на строку заявки достраивает M12 плана переработки — до неё таблицы
     * строк не существует вовсе.
     */
    serviceRequestId: uuid('service_request_id'),
    serviceRequestConsumableId: uuid('service_request_consumable_id'),
    /** Оба конца, а не одна «дельта»: цепочку проверяют по «было», а читают по «стало». */
    quantityBefore: integer('quantity_before').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    reason: text('reason').notNull(),
    /**
     * `restrict`, как `moved_by` у перемещений: запись «кто изменил остаток», теряющая автора
     * вместе с увольнением, отвечает на свой единственный вопрос словом «неизвестно».
     */
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => ({
    // Причина обязательна: «12 → 4» без объяснения через месяц не отличить от опечатки.
    reasonNotBlank: check(
      'office_equipment_consumable_stock_reason_check',
      sql`btrim(${t.reason}) <> ''`,
    ),
    // Событие, ничего не изменившее, — запись ни о чём; повторное нажатие кнопки не должно пухнуть
    // журналом. Отсюда следствие для заведения карточки: первая строка пишется только при
    // ненулевом остатке, потому что «0 → 0» это ограничение не пропустит (Р7).
    change: check(
      'office_equipment_consumable_stock_change_check',
      sql`${t.quantityAfter} <> ${t.quantityBefore}`,
    ),
    // Оба конца неотрицательны: «было −1» не бывает так же, как «стало −1».
    amounts: check(
      'office_equipment_consumable_stock_amount_check',
      sql`${t.quantityAfter} >= 0 AND ${t.quantityBefore} >= 0`,
    ),
    // Ключ цепочки: по нему проверка находит предыдущую строку расходника (`max(seq)`) и по нему же
    // лента журнала читается с конца. Уникальность — заодно и запрет двух событий с одним номером
    // у одной карточки.
    kindCheck: check(
      'office_equipment_consumable_stock_kind_check',
      sql`${t.entryKind} IN ('manual','issue','return')`,
    ),
    // Вид события и ссылки на заявку — одно утверждение: «ручная правка» и «списано по заявке» не
    // бывают наполовину. Ручное событие имеет обе ссылки пустыми, событие по заявке — обе
    // заполненными.
    requestLinks: check(
      'office_equipment_consumable_stock_request_links_check',
      sql`(${t.entryKind} = 'manual'
             AND ${t.serviceRequestId} IS NULL
             AND ${t.serviceRequestConsumableId} IS NULL)
          OR (${t.entryKind} IN ('issue','return')
             AND ${t.serviceRequestId} IS NOT NULL
             AND ${t.serviceRequestConsumableId} IS NOT NULL)`,
    ),
    // Направление задаёт вид: «возврат», уменьшающий остаток, сделал бы отчёт по расходу неверным
    // при верной цепочке — расход считается по видам, а не по знаку разницы.
    direction: check(
      'office_equipment_consumable_stock_direction_check',
      sql`${t.entryKind} = 'manual'
          OR (${t.entryKind} = 'issue' AND ${t.quantityAfter} < ${t.quantityBefore})
          OR (${t.entryKind} = 'return' AND ${t.quantityAfter} > ${t.quantityBefore})`,
    ),
    seqIdx: uniqueIndex('office_equipment_consumable_stock_seq_idx').on(
      t.consumableId,
      t.seq.desc(),
    ),
    // «Что списали по этой заявке» — второй вопрос журнала; частичный, потому что у ручных событий
    // ссылка пуста и держать их в индексе незачем.
    requestIdx: index('office_equipment_consumable_stock_request_idx')
      .on(t.serviceRequestId)
      .where(sql`${t.serviceRequestId} IS NOT NULL`),
    /**
     * Строка заявки, из которой выдали, — ключом на ТРОЙКУ «строка + заявка + позиция» (M12).
     * Ключ на одну колонку проверял бы только существование строки, то есть разрешал бы событию по
     * заявке СО-1234 указывать на строку заявки СО-5678 или на строку с другим расходником: отчёт
     * «сколько выдано по заявке» считал бы чужое, а сторно правило бы не ту строку. Копии
     * реквизитов родителя в дочерней строке — приём ADR 0007 §2.
     *
     * MATCH SIMPLE (умолчание) здесь обязателен: у ручной правки остатка `consumableId` заполнен, а
     * обе ссылки на заявку пусты, и составной ключ при NULL в любой своей части не проверяется
     * вовсе. `MATCH FULL` означал бы обратное — «либо все три пусты, либо все три заполнены», — и
     * первая же правка кладовщика упёрлась бы в него.
     *
     * `restrict`: строку заявки, за которой числится движение, не удаляет ни маршрут, ни каскад от
     * заявки, ни скрипт — журнал не должен уметь показывать на пустоту.
     *
     * Ссылка объявлена ЗДЕСЬ, а не колонкой выше, потому что `foreignKey` в конфигурации таблицы
     * вычисляется лениво, а `.references(() => …)` — сразу при объявлении: расходники стоят в этом
     * файле выше заявок, и колоночная стрелка тянула бы значение, которого в тот момент ещё нет.
     */
    requestRowFk: foreignKey({
      columns: [t.serviceRequestConsumableId, t.serviceRequestId, t.consumableId],
      foreignColumns: [
        serviceRequestConsumables.id,
        serviceRequestConsumables.requestId,
        serviceRequestConsumables.consumableId,
      ],
      name: 'office_equipment_consumable_stock_row_fk',
    }).onDelete('restrict'),
  }),
);

// ── Заявки на обслуживание оргтехники (ADR 0085, миграция 0105) ──
// Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
// которую согласует заказчик, а после работ — приёмка. Отсюда собственный набор статусов:
// дописать диагностику, согласование и приёмку в общий `request_status` значило бы поменять
// смысл статусов сразу в двух работающих модулях.
export const serviceRequestStatusEnum = pgEnum('service_request_status', [
  'new',
  // Порядок значений здесь тот же, что в типе БД (миграция 0117 добавила значение `AFTER 'new'`):
  // список заявок сортируется по колонке статуса, и порядок сортировки задаёт объявление типа.
  'it_approved',
  'assigned',
  'diagnostics',
  'estimate_review',
  'in_work',
  // Заморозка (миграция 0161 добавила значение `AFTER 'in_work'`, Р103): состояние, из которого
  // нет обычных ходов — только возврат в `held_from_status` или отмена. Место в перечислении по
  // той же причине, что и у визы ИТ: сортировка по статусу идёт порядком объявления, и заморозка
  // должна читаться среди рабочих статусов, а не после «Отменена».
  'on_hold',
  'done',
  'accepted',
  'cancelled',
]);

export const serviceRequests = pgTable(
  'service_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Сквозной человекочитаемый номер (отображается как «СО-<num>»).
    num: integer('num').generatedAlwaysAsIdentity(),
    // Вид заявки (Н1, миграция M3 плана переработки заявок оргтехники): `repair` — ремонт или
    // обслуживание единицы, `consumable` — выдача расходников со склада. Одной таблицей на два
    // вида, а не второй рядом: статусный словарь, визы, история, вложения и права у них общие, а
    // различает их предмет строки.
    //
    // `DEFAULT 'repair'` остаётся навсегда. Умолчание заведено ради окна выката (протокол §1:
    // миграции накатываются до перезапуска сервисов) — старый код вставляет заявку, не зная про
    // колонку, и без умолчания вставка падала бы, — но снимать его потом незачем: «вид по
    // умолчанию — ремонт» верно и после окна, а снятие вернуло бы ту же поломку при откате релиза.
    //
    // Схема разрешает `consumable` с этой миграции, а API — только с выпуском 3: до того у такой
    // заявки нет ни строк номенклатуры, ни формы, ни списания, и заведённая раньше времени она
    // была бы заявкой без предмета.
    kind: text('kind').$type<'repair' | 'consumable'>().notNull().default('repair'),
    officeEquipmentId: uuid('office_equipment_id')
      .notNull()
      .references(() => officeEquipment.id, { onDelete: 'restrict' }),
    // Чья это заявка — тремя снимками на момент заведения: единицу могут закрепить за отделом
    // позже, и прошлогодняя заявка не должна от этого менять область видимости. NULL у отделов
    // означает «к отделам не относится», а не «видна всем».
    equipmentObjectId: uuid('equipment_object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    // Отдел, от имени которого заведена заявка. Подсказывается владельцем техники, но выбирается
    // человеком: сотрудник соседнего отдела чинит «чужой» принтер чаще, чем кажется.
    customerDepartmentId: uuid('customer_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    // За каким отделом числилась единица. Вместе с заказчиком задаёт область роли отдела: заявку
    // видит и тот, кто её подал, и тот, за кем закреплена техника.
    equipmentDepartmentId: uuid('equipment_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    // Подразделение заявителя (Н11, миграция M5): от кого пришла заявка — отдел, а если отделов у
    // учётки нет, площадка. Проставляет его сервер из привязок `created_by`, а не клиент: иначе
    // заявку можно было бы подать от имени чужого отдела. Это не заказчик выше: заказчика выбирает
    // человек (сотрудник соседнего отдела чинит «чужой» принтер), а здесь — где числится он сам.
    //
    // `restrict`, как у остальных ссылок заявки: удаление отдела, за которым есть заявки, — не
    // уборка справочника, а потеря половины ответа «от кого это пришло»; портал отвечает на такое
    // словами. Ссылка и снимок названия ходят парой (`service_requests_requester_place_check`):
    // идентификатор без названия — снимок, который ничего не помнит, а название без ссылки нечем
    // связать со справочником. Обе пары пустые тоже законны — так выглядят заявки, заведённые до
    // этого выпуска и в его окне выката, и заявки учёток вовсе без привязок (администратор).
    requesterDepartmentId: uuid('requester_department_id').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    requesterObjectId: uuid('requester_object_id').references(() => constructionObjects.id, {
      onDelete: 'restrict',
    }),
    requesterDepartmentName: text('requester_department_name').notNull().default(''),
    requesterObjectName: text('requester_object_name').notNull().default(''),
    // Снимок предмета: карточку переименуют, перенесут и перезакрепят, а заявка должна остаться
    // рассказом о том, что чинили тогда.
    equipmentName: text('equipment_name').notNull(),
    equipmentSerialNumber: text('equipment_serial_number').notNull().default(''),
    equipmentInventoryNumber: text('equipment_inventory_number').notNull().default(''),
    // Место внутри объекта — часть того же снимка (миграция 0118): сервис едет по адресу
    // «Корпус 3, каб. 214», и читать его из карточки нельзя — она к тому времени переехала.
    equipmentLocation: text('equipment_location').notNull().default(''),
    description: text('description').notNull(),
    dueDate: date('due_date'),
    responsibleName: text('responsible_name').notNull().default(''),
    // Десять цифр без кода страны, как все номера портала (ADR 0066).
    responsiblePhone: text('responsible_phone').notNull().default(''),
    // Срочность — пара «флаг + причина», и порознь они не бывают (CHECK в миграции 0118): чекбокс
    // без объяснения через месяц стоит у всех заявок, и отбирать им становится нечего.
    isUrgent: boolean('is_urgent').notNull().default(false),
    urgencyReason: text('urgency_reason').notNull().default(''),
    status: serviceRequestStatusEnum('status').notNull().default('new'),
    // Заморозка (миграция 0162): куда вернуть заявку и почему её остановили. Возврат — одна дуга
    // назад, в записанный статус (Р104): разреши мы выбирать цель, «Отложена» стала бы вторым
    // входом в цикл — в обход виз, сметы и назначения. NULL означает «не отложена».
    heldFromStatus: serviceRequestStatusEnum('held_from_status'),
    // Причина обязательна, как у отмены и отказа (Р107): даты «отложена до» нет вовсе, и «когда
    // ждать» отвечает эта строка, а «сколько ждут уже» — возраст в статусе. На выходе из
    // заморозки поле чистится вместе с `held_from_status` (Р118).
    holdReason: text('hold_reason').notNull().default(''),
    // Виза отдела ИТ (миграция 0119): решение о том, звать ли внешний сервис. Снимок из двух
    // полей, как виза заказа ТС (ADR 0025); третий флаг отличает автоматическую — заявку завёл
    // сам обладатель права, и подписывать её вторым действием было бы ритуалом.
    itApprovedBy: uuid('it_approved_by').references(() => users.id, { onDelete: 'set null' }),
    itApprovedAt: timestamp('it_approved_at', { withTimezone: true }),
    itApprovedAuto: boolean('it_approved_auto').notNull().default(false),
    // Ревизия сметы, к которой относится виза ИТ (Н3, миграция M1). Виза переехала со входа на
    // смету, и без номера ревизии «согласовано ИТ» перестаёт отвечать, что именно согласовали:
    // смету предъявляют заново, а подпись осталась бы от прошлой. Пусто у виз старого образца —
    // входных, поставленных до сметы вовсе, — и это законно: требование ревизии у каждой подписи
    // уронило бы визирование старым кодом в окне выката. Связку «подпись есть ⇒ ревизия есть»
    // ставит триггер выпуска 2 (M10 того же плана), когда старого кода в проде уже нет.
    itApprovedEstimateRevision: integer('it_approved_estimate_revision'),
    // Возраст в текущем статусе — колонкой, а не latest-подзапросом по истории: «кто ждёт дольше
    // всех» спрашивает каждый список, и признак зависшей заявки читается отсюда же.
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    // Обращение по гарантии хранится источником, а не флагом: 'equipment' — гарантия поставщика
    // на саму единицу, 'item' — гарантия на запчасть или работу прошлой заявки (ссылка ниже).
    // Без источника «гарантийная заявка» не отвечает на главный вопрос спора с сервисом.
    warrantyClaimSource: text('warranty_claim_source').$type<'equipment' | 'item'>(),
    // FK → service_request_items.id ON DELETE RESTRICT ставится отдельным ALTER в миграции 0105:
    // обе таблицы создаются одной миграцией, и раньше строк ссылку объявить нельзя. Здесь она не
    // типизирована, чтобы не замыкать цикл service_requests ↔ service_request_items, — тот же
    // приём, что у users.counterpartyId и users.personId.
    warrantyClaimItemId: uuid('warranty_claim_item_id'),
    serviceCounterpartyId: uuid('service_counterparty_id').references(() => counterparties.id, {
      onDelete: 'restrict',
    }),
    // Смета версионируется: ревизия растёт при каждом предъявлении, согласована та, чей номер
    // записан в соседней колонке. Закрытие требует их совпадения — иначе правка проходила бы
    // между открытием окна согласования и нажатием кнопки.
    estimateRevision: integer('estimate_revision').notNull().default(0),
    approvedEstimateRevision: integer('approved_estimate_revision'),
    estimateSubmittedAt: timestamp('estimate_submitted_at', { withTimezone: true }),
    estimateApprovedBy: uuid('estimate_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    estimateApprovedAt: timestamp('estimate_approved_at', { withTimezone: true }),
    // Согласованная сумма и сумма по акту разведены: одной колонкой после закрытия уже не
    // ответить, ту ли сумму согласовывали. Итоги считает сервер из строк сметы; корректировка
    // акта (скидка, округление) — только вниз и только с причиной.
    estimatedTotalAmount: numeric('estimated_total_amount', { precision: 14, scale: 2 }),
    finalTotalAmount: numeric('final_total_amount', { precision: 14, scale: 2 }),
    finalAdjustmentAmount: numeric('final_adjustment_amount', { precision: 14, scale: 2 }),
    finalAdjustmentReason: text('final_adjustment_reason').notNull().default(''),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    // Кто закрыл заявку (Н7, миграция M2): `human` — человек нажал «Принять», `auto` — портал
    // закрыл сам, не дождавшись ответа заказчика. Отдельным полем, а не выводом из пустого автора:
    // автор теряется вместе с уволенной учёткой (ссылка выше — `set null`), и «принято
    // автоматически» перестало бы отличаться от «принято тем, кого уже нет».
    //
    // В выпуске 1 колонка НЕ связана с `accepted_at`, и это не забывчивость (§3 плана, п. 2): в
    // окне выката старый код и принимает заявку, и откатывает приёмку, ничего не зная про
    // источник, — связка «источник есть ровно у принятой» уронила бы обе операции. Она встаёт
    // отдельной миграцией выпуска 2 (M9), а до неё пустой источник у принятой заявки читается как
    // `human` — этого обязан держаться весь код выпуска 1.
    acceptanceSource: text('acceptance_source').$type<'human' | 'auto'>(),
    // «Ремонт нецелесообразен, аппарат под замену» (Н3, В21, миграция M5): пометка объясняет,
    // почему заявку закрыли, ничего не починив, и потому существует только у отменённой
    // (`service_requests_replacement_check`). Возврат отменённой в «Новую» её снимает — это делает
    // матрица сброса `serviceResetOnTransition`, и без неё откат упрётся в ограничение.
    replacementRecommended: boolean('replacement_recommended').notNull().default(false),
    comment: text('comment').notNull().default(''),
    serviceComment: text('service_comment').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Оптимистическая блокировка: согласование и закрытие нажимают из окна, простоявшего минуту.
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    kindCheck: check('service_requests_kind_check', sql`${t.kind} IN ('repair','consumable')`),
    descriptionNotBlank: check(
      'service_requests_description_not_blank_check',
      sql`btrim(${t.description}) <> ''`,
    ),
    amounts: check(
      'service_requests_amounts_check',
      sql`(${t.estimatedTotalAmount} IS NULL OR ${t.estimatedTotalAmount} >= 0)
          AND (${t.finalTotalAmount} IS NULL OR ${t.finalTotalAmount} >= 0)`,
    ),
    // Заморозка — неразрывная тройка «статус + откуда + причина». Статус без исходного некуда
    // вернуть, исходный без статуса означал бы заморозку, которой нет, а причина обязана исчезать
    // вместе с ней: выход из `on_hold` чистит оба поля централизованно (Р118), и этот CHECK —
    // то, что заставляет чистить их и при возобновлении, и при отмене отложенной.
    hold: check(
      'service_requests_hold_check',
      sql`(${t.status} = 'on_hold') = (${t.heldFromStatus} IS NOT NULL)
          AND (${t.status} <> 'on_hold' OR btrim(${t.holdReason}) <> '')
          AND (${t.status} = 'on_hold' OR btrim(${t.holdReason}) = '')`,
    ),
    // Заморозка не вкладывается в себя и не ведёт назад в закрытые статусы: возврат в `on_hold`
    // означал бы заморозку без выхода, а в «Принята» или «Отменена» — воскрешение закрытой
    // заявки возобновлением.
    heldFrom: check(
      'service_requests_held_from_check',
      sql`${t.heldFromStatus} IS NULL
          OR ${t.heldFromStatus} NOT IN ('on_hold','accepted','cancelled')`,
    ),
    // `service_requests_executor_check` здесь больше нет: миграция M4 плана переработки заявок
    // его снимает. Он требовал КОНТРАГЕНТА, а исполнителем теперь бывает и свой сотрудник —
    // строкой `service_request_executors`, которой `CHECK` не видит: он читает только собственную
    // строку. Сам инвариант «в рабочем статусе у заявки есть исполнитель — контрагент или
    // поимённый» не пропал, а переехал в отложенные constraint-триггеры
    // `service_requests_executor_present` и `service_request_executors_present` той же миграции
    // (прецедент приёма — 0035). Отложенные, а не немедленные: «сняли последнего исполнителя и
    // вернули заявку в „Новую“» — законная пара шагов, и немедленная проверка отбила бы её на
    // первом. Исключения по статусам остались прежними («Новая», «Согласована ИТ», «Отменена») и
    // считаются по «эффективному» статусу (миграция 0162) — отложенная из «Новой» исполнителя не
    // имеет и иметь не должна.
    // Согласование — снимок из трёх полей: кто, когда и что именно. Любое поле по отдельности на
    // вопрос «что согласовали» не отвечает.
    approval: check(
      'service_requests_approval_check',
      sql`(${t.estimateApprovedBy} IS NULL) = (${t.estimateApprovedAt} IS NULL)
          AND (${t.estimateApprovedBy} IS NULL) = (${t.approvedEstimateRevision} IS NULL)`,
    ),
    approvedRevision: check(
      'service_requests_approved_revision_check',
      sql`${t.approvedEstimateRevision} IS NULL
          OR ${t.approvedEstimateRevision} <= ${t.estimateRevision}`,
    ),
    // Парного `service_requests_accepted_check` («автор и дата приёмки заполнены вместе или
    // никак») здесь больше нет: его снимает миграция M2. Автоматическое закрытие приезжает уже в
    // выпуске 1 и пишет `accepted_at` без автора — при живом ограничении первая же закрытая
    // порталом заявка упёрлась бы в него. Старому коду снятие не мешает: он по-прежнему пишет пару
    // целиком. Уцелевшее направление («автор без даты — бессмыслица») возвращается в выпуске 2
    // вместе со связкой источника (M9).
    //
    // Мягкая редакция выпуска 1: перечень значений и запрет автора у автоматической приёмки — всё,
    // что можно потребовать, пока старый код в окне выката пишет и откатывает приёмку, не зная про
    // источник (§3 плана, п. 2). «Человек» непустого `accepted_by` не требует: ссылка объявлена
    // `set null`, и удаление уволенного сотрудника обнулило бы её — с таким требованием удаление
    // упёрлось бы в это ограничение, а источник отвечает на вопрос «человек или портал», не «кто
    // именно».
    acceptanceSource: check(
      'service_requests_acceptance_source_check',
      sql`${t.acceptanceSource} IS NULL
          OR (${t.acceptanceSource} IN ('human','auto')
              AND (${t.acceptanceSource} <> 'auto' OR ${t.acceptedBy} IS NULL))`,
    ),
    // Корректировка акта — неразрывная пара «сумма + причина»: причина без суммы ничего не
    // корректирует, сумма без причины делает итог необъяснимым. Только вниз — наценка это
    // удорожание, и её путь один, через пересогласование сметы.
    finalAdjustment: check(
      'service_requests_final_adjustment_check',
      sql`(${t.finalAdjustmentAmount} IS NULL AND btrim(${t.finalAdjustmentReason}) = '')
          OR (${t.finalAdjustmentAmount} < 0 AND btrim(${t.finalAdjustmentReason}) <> '')`,
    ),
    warrantyClaim: check(
      'service_requests_warranty_claim_check',
      sql`${t.warrantyClaimSource} IS NULL
          OR (${t.warrantyClaimSource} = 'equipment' AND ${t.warrantyClaimItemId} IS NULL)
          OR (${t.warrantyClaimSource} = 'item' AND ${t.warrantyClaimItemId} IS NOT NULL)`,
    ),
    // Виза ИТ — снимок из двух полей: «кто» без «когда» согласованием не является.
    itApproval: check(
      'service_requests_it_approval_check',
      sql`(${t.itApprovedBy} IS NULL) = (${t.itApprovedAt} IS NULL)`,
    ),
    itAuto: check(
      'service_requests_it_auto_check',
      sql`NOT ${t.itApprovedAuto} OR ${t.itApprovedBy} IS NOT NULL`,
    ),
    // Ревизия без подписи не значит ничего, и согласовать можно только то, что уже предъявлено, —
    // опережать смету ревизия визы не может. Обратное («подпись без ревизии») здесь ЗАКОННО: так
    // выглядит входная виза старого образца, и запрет на неё встаёт триггером выпуска 2 (M10).
    itRevision: check(
      'service_requests_it_revision_check',
      sql`${t.itApprovedEstimateRevision} IS NULL
          OR (${t.itApprovedBy} IS NOT NULL
              AND ${t.itApprovedEstimateRevision} <= ${t.estimateRevision})`,
    ),
    // Срочность — такая же неразрывная пара, как корректировка акта выше: флаг без причины
    // отбирает заявки, ничего про них не объясняя, причина без флага ничего не объявляет.
    urgency: check(
      'service_requests_urgency_check',
      sql`(NOT ${t.isUrgent} AND btrim(${t.urgencyReason}) = '')
          OR (${t.isUrgent} AND btrim(${t.urgencyReason}) <> '')`,
    ),
    // Подразделение заявителя — ЛИБО отдел, ЛИБО площадка, и ссылка со снимком названия ходят
    // парой в обе стороны (Н11). Обе пары пустые законны: заявки до этого выпуска, заявки его окна
    // выката и заявки учёток без единой привязки выглядят именно так, и запрет на них закрыл бы
    // подачу администратору портала.
    requesterPlace: check(
      'service_requests_requester_place_check',
      sql`NOT (${t.requesterDepartmentId} IS NOT NULL AND ${t.requesterObjectId} IS NOT NULL)
          AND (${t.requesterDepartmentId} IS NOT NULL) = (btrim(${t.requesterDepartmentName}) <> '')
          AND (${t.requesterObjectId} IS NOT NULL) = (btrim(${t.requesterObjectName}) <> '')`,
    ),
    // «Рекомендована замена» — объяснение отмены, а не свойство заявки: у живой заявки такая
    // пометка означала бы «чиним то, что решили не чинить». Отсюда обязанность матрицы сброса
    // `serviceResetOnTransition` гасить её при возврате отменённой в работу.
    replacement: check(
      'service_requests_replacement_check',
      sql`NOT ${t.replacementRecommended} OR ${t.status} = 'cancelled'`,
    ),
    numUnique: uniqueIndex('service_requests_num_unique').on(t.num),
    // Одна открытая заявка на единицу — но НА ВИД (В12, миграция M3): ремонт и расходники по
    // одному аппарату не мешают друг другу (картридж просят и тому принтеру, который сейчас в
    // ремонте), а два открытых ремонта или две открытых заявки на картриджи по-прежнему означали
    // бы два сервиса, два акта и две гарантии на одну работу. Прежний общий
    // `service_requests_open_per_equipment_unique` снят там же и заменён этой парой.
    //
    // Оба индекса сторожат и заведение, и восстановление из архива — сервер обязан отвечать на оба
    // случая понятным 409 со ссылкой на открытую заявку, а не ошибкой БД. Отложенная заявка
    // считается открытой (Р109) и потому из условия не исключается: техника ждёт этого же ремонта,
    // и второй заявке на неё взяться неоткуда.
    openRepairUnique: uniqueIndex('service_requests_open_repair_unique')
      .on(t.officeEquipmentId)
      .where(
        sql`${t.deletedAt} IS NULL AND ${t.kind} = 'repair'
            AND ${t.status} NOT IN ('accepted','cancelled')`,
      ),
    openConsumableUnique: uniqueIndex('service_requests_open_consumable_unique')
      .on(t.officeEquipmentId)
      .where(
        sql`${t.deletedAt} IS NULL AND ${t.kind} = 'consumable'
            AND ${t.status} NOT IN ('accepted','cancelled')`,
      ),
    // Очереди спрашивают «что в этом статусе ждёт дольше всех» — статус и возраст читаются
    // вместе; отдельного индекса по одному статусу нет, этот покрывает его префиксом.
    statusChangedIdx: index('service_requests_status_changed_idx').on(t.status, t.statusChangedAt),
    objectIdx: index('service_requests_object_idx').on(t.equipmentObjectId),
    customerDeptIdx: index('service_requests_customer_dept_idx')
      .on(t.customerDepartmentId)
      .where(sql`${t.customerDepartmentId} IS NOT NULL`),
    equipmentDeptIdx: index('service_requests_equipment_dept_idx')
      .on(t.equipmentDepartmentId)
      .where(sql`${t.equipmentDepartmentId} IS NOT NULL`),
    equipmentIdx: index('service_requests_equipment_idx').on(t.officeEquipmentId),
    serviceIdx: index('service_requests_service_idx')
      .on(t.serviceCounterpartyId)
      .where(sql`${t.serviceCounterpartyId} IS NOT NULL`),
    // Очередь «что срочное ждёт дольше всех»: закрытые, удалённые и отложенные заявки в ней не
    // участвуют, поэтому индекс частичный — он остаётся размером с очередь, а не с таблицей.
    // Отложенные ушли из условия вместе с фильтром срочных и сортировкой `urgentFirst`
    // (миграция 0162, Р119): флаг срочности заморозка не гасит, но первой строкой списка стоит
    // то, за что берутся сейчас, а отложенная ждёт решения, а не рук. Условие обязано совпадать с
    // самой очередью — иначе индекс перестаёт её покрывать.
    urgentIdx: index('service_requests_urgent_idx')
      .on(t.statusChangedAt)
      .where(
        sql`${t.isUrgent} AND ${t.deletedAt} IS NULL
            AND ${t.status} NOT IN ('accepted','cancelled','on_hold')`,
      ),
    createdAtIdx: index('service_requests_created_at_idx').on(t.createdAt),
  }),
);

// Смета: запчасти и услуги строками одной таблицы — набор полей у них общий (наименование,
// количество, цена, сумма, гарантия), различает строку её вид. План и факт разведены: иначе
// «запчасть не понадобилась» оставляло бы в реестре гарантию на деталь, которую не ставили.
export const serviceRequestItems = pgTable(
  'service_request_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => serviceRequests.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<'part' | 'service'>(),
    name: text('name').notNull(),
    // План: сколько согласовали и по какой цене.
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    // Сумму считает БД (GENERATED): производная не может разойтись со слагаемыми.
    amount: numeric('amount', { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`round(quantity * unit_price, 2)`,
    ),
    // Факт: NULL — «не заполнено», до закрытия работ факта у строки нет вовсе. Ни NOT NULL, ни
    // DEFAULT здесь быть не должно — иначе план читался бы как факт.
    performed: boolean('performed'),
    actualQuantity: numeric('actual_quantity', { precision: 12, scale: 3 }),
    // Три ветки по состоянию факта: не заполнен — суммы нет, сделали — по фактическому
    // количеству (плановому, если его не уточняли), не делали — ноль.
    actualAmount: numeric('actual_amount', { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`CASE
      WHEN performed IS NULL THEN NULL
      WHEN performed THEN round(coalesce(actual_quantity, quantity) * unit_price, 2)
      ELSE 0
    END`,
    ),
    // Гарантия строки: сколько обещали и до какой даты действует. Дата ставится при закрытии как
    // «дата выполнения + N месяцев», но правится руками — в талоне может стоять своя.
    warrantyMonths: smallint('warranty_months'),
    warrantyUntil: date('warranty_until'),
    warrantyUntilManual: boolean('warranty_until_manual').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    kindCheck: check('service_request_items_kind_check', sql`${t.kind} IN ('part','service')`),
    nameNotBlank: check('service_request_items_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    quantityPositive: check('service_request_items_quantity_check', sql`${t.quantity} > 0`),
    priceNonNegative: check('service_request_items_price_check', sql`${t.unitPrice} >= 0`),
    actualQuantityPositive: check(
      'service_request_items_actual_quantity_check',
      sql`${t.actualQuantity} IS NULL OR ${t.actualQuantity} > 0`,
    ),
    // Количество факта бывает только у явно выполненной строки: и «не ставили, но две штуки», и
    // «факта ещё нет, а количество уже есть» — испорченные строки. Условие написано от
    // количества: `performed IS NOT FALSE` в Postgres истинно и для NULL и такую пару пропустило
    // бы.
    actualAbsent: check(
      'service_request_items_actual_absent_check',
      sql`${t.actualQuantity} IS NULL OR ${t.performed} IS TRUE`,
    ),
    // Вверх факт не идёт: рост объёма — удорожание, и его путь один, через пересогласование.
    actualLePlan: check(
      'service_request_items_actual_le_plan_check',
      sql`${t.actualQuantity} IS NULL OR ${t.actualQuantity} <= ${t.quantity}`,
    ),
    warrantyMonthsRange: check(
      'service_request_items_warranty_months_check',
      sql`${t.warrantyMonths} IS NULL OR ${t.warrantyMonths} BETWEEN 1 AND 120`,
    ),
    warrantyManual: check(
      'service_request_items_warranty_manual_check',
      sql`NOT ${t.warrantyUntilManual} OR ${t.warrantyUntil} IS NOT NULL`,
    ),
    // Гарантии на то, чего не делали, не бывает; до закрытия (performed IS NULL) её тоже нет.
    warrantyPerformed: check(
      'service_request_items_warranty_performed_check',
      sql`${t.performed} IS TRUE OR ${t.warrantyUntil} IS NULL`,
    ),
    requestIdx: index('service_request_items_request_idx').on(t.requestId),
    // Реестр действующих гарантий: интересны только сделанные строки с непустым сроком.
    warrantyIdx: index('service_request_items_warranty_idx')
      .on(t.warrantyUntil)
      .where(sql`${t.warrantyUntil} IS NOT NULL AND ${t.performed}`),
  }),
);

// Вложения. Вид называет документ, а не «прочее»: по нему собирается срез «ожидаются документы»,
// без которого «акт подошью завтра» превращается в потерянную бумагу.
export const serviceRequestFiles = pgTable(
  'service_request_files',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => serviceRequests.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .notNull()
      .default('attachment')
      .$type<'attachment' | 'estimate' | 'act' | 'invoice' | 'warranty_card'>(),
    attachedBy: uuid('attached_by').references(() => users.id, { onDelete: 'set null' }),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.fileId] }),
    kindCheck: check(
      'service_request_files_kind_check',
      sql`${t.kind} IN ('attachment','estimate','act','invoice','warranty_card')`,
    ),
    fileIdx: index('service_request_files_file_idx').on(t.fileId),
    // «У каких предъявленных заявок нет ни одной закрывающей бумаги» — вопрос очереди «Ожидаются
    // документы» и условие приёмки (Р112, Р114, миграция 0162). Виды перечислены все три: частичный
    // индекс покрывает лишь запрос не шире собственного условия, и пара `act`/`invoice` оставила бы
    // очередь читать таблицу целиком.
    docIdx: index('service_request_files_doc_idx')
      .on(t.requestId)
      .where(sql`${t.kind} IN ('act','invoice','warranty_card')`),
  }),
);

/**
 * Поимённые исполнители заявки (Н5, миграция M4 плана переработки заявок оргтехники): свои
 * сотрудники, которые ведут ремонт руками. Исполнитель-контрагент остаётся колонкой
 * `service_counterparty_id` в самой заявке — сервисная компания назначается целиком, её людей
 * портал не знает и выбирать не может.
 *
 * Отсюда разное правило отказа у двух слоёв: свой сотрудник снимает отказом СВОЮ строку и остальные
 * назначенные продолжают вести заявку, а оператор сервиса — ВСЮ компанию (обнуляется контрагент),
 * потому что назначена была она, а не человек. Если не осталось ни строк, ни контрагента, заявка
 * возвращается в «Новую».
 *
 * Ключ — пара «заявка + учётка», без суррогатного id: второе назначение того же человека на ту же
 * заявку ничего не добавляет, а с id таких строк стало бы две и список исполнителей удвоился бы.
 *
 * Инвариант «в рабочем статусе исполнитель есть — контрагент или поимённый» держат отложенные
 * constraint-триггеры `service_request_executors_present` (эта таблица) и
 * `service_requests_executor_present` (сама заявка), заведённые той же миграцией: межтабличную
 * проверку `CHECK` выразить не может, и снятый `service_requests_executor_check` заменён именно
 * ими. Триггер этой таблицы слушает и `UPDATE`: прямой перевод строки на другую заявку оставил бы
 * прежнюю без единого исполнителя, и проверяются обе стороны.
 */
export const serviceRequestExecutors = pgTable(
  'service_request_executors',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => serviceRequests.id, { onDelete: 'cascade' }),
    /**
     * `restrict`, как `created_by` у самой заявки: «кто вёл этот ремонт» — часть её истории, и
     * удаление учётки, за которой есть назначения, портал обязан отклонить словами, а не унести
     * их молча. Снятие исполнителя — отдельное действие, у которого есть автор и след в аудите.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Кто назначил — `set null`, а не `restrict`: назначение остаётся в силе и без имени
     * назначившего (оно про исполнителя, а не про диспетчера), и удаление уволенной учётки не
     * должно упираться в чужие назначения. Само событие назначения остаётся в аудите с автором.
     */
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.userId] }),
    // Со стороны учётки спрашивают «что висит на мне» — очередь исполнителя в его разделе;
    // первичный ключ читается только слева направо, от заявки, и на этот вопрос не отвечает.
    userIdx: index('service_request_executors_user_idx').on(t.userId),
  }),
);

/**
 * Строки заявки на расходники (Н9, миграция M12 плана переработки заявок оргтехники): что просили,
 * что выдали и почему разошлось.
 *
 * Своей таблицей, а не в `serviceRequestItems`: там цена, сумма, скидка акта и гарантия — то есть
 * смета ремонта, которую согласует заказчик и по которой платят подрядчику. У строки расходника нет
 * ни одного из этих полей: картридж берут со своего склада, и согласовывать по нему сумму не у
 * кого. Слить их в одну таблицу значило бы завести строку, у которой половина колонок обязана быть
 * пустой по виду заявки.
 *
 * Списание идёт не отсюда, а событиями журнала остатка (Р1): у остатка один источник истины —
 * цепочка событий, и второго счётчика «выдано по заявкам» не заводится. Согласованность двух
 * половин держат отложенные constraint-триггеры `service_request_consumables_issued_covered` (эта
 * таблица) и `office_equipment_consumable_stock_issued_covered` (журнал), заведённые той же
 * миграцией: «выдано по строке равно сумме `issue` минус `return` по её событиям». Односторонней
 * проверки не хватило бы — транзакция может подвинуть склад законным событием и не тронуть строку.
 */
export const serviceRequestConsumables = pgTable(
  'service_request_consumables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `cascade`, как у поимённых исполнителей: строки — состав самой заявки, а не её история.
     * Заявку с движением склада каскад при этом не уносит — ссылки журнала объявлены `restrict`.
     */
    requestId: uuid('request_id')
      .notNull()
      .references(() => serviceRequests.id, { onDelete: 'cascade' }),
    /**
     * `restrict`: позиция, которую просили, не имеет права исчезнуть из-под заявки — иначе «выдано
     * 2» осталось бы без ответа на вопрос «чего именно 2», а отчёт по расходу — с дырой на месте
     * удалённой номенклатуры.
     */
    consumableId: uuid('consumable_id')
      .notNull()
      .references(() => officeEquipmentConsumables.id, { onDelete: 'restrict' }),
    requestedQuantity: integer('requested_quantity').notNull(),
    /**
     * Сколько числится выданным. Три состояния, и они разные (В9б): `null` — работу ещё не
     * закрывали, `0` — закрыли, но не выдали («съездили, тонер оказался цел»), `N` — выдали и
     * ровно столько списано со склада. Ни `notNull`, ни `default` здесь быть не должно — иначе
     * просимое читалось бы как выданное (тот же приём, что у `performed` в строке сметы).
     */
    issuedQuantity: integer('issued_quantity'),
    /**
     * Причина любого расхождения факта с запрошенным. Живёт в строке заявки, а не только в событии
     * журнала: её читают в карточке и в отчёте, а событие журнала — это склад. Пустая строка
     * означает «объяснять нечего»; `null` рядом с ней был бы вторым именем того же состояния.
     */
    issueNote: text('issue_note').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Просят хотя бы штуку: «прошу ноль картриджей» — это отсутствие строки, а не строка.
    requestedPositive: check(
      'service_request_consumables_requested_check',
      sql`${t.requestedQuantity} > 0`,
    ),
    // Факт неотрицателен, но ноль законен — в отличие от запрошенного.
    issuedNonNegative: check(
      'service_request_consumables_issued_check',
      sql`${t.issuedQuantity} IS NULL OR ${t.issuedQuantity} >= 0`,
    ),
    // Любое расхождение объясняется причиной — и выдача сверх заявки (В9а), и недодача, и ноль
    // (В9б). Совпал факт с заявкой — объяснять нечего, и требовать текст значило бы заставлять
    // писать «всё как просили» две тысячи раз в год.
    noteOnMismatch: check(
      'service_request_consumables_note_check',
      sql`${t.issuedQuantity} IS NULL
          OR ${t.issuedQuantity} = ${t.requestedQuantity}
          OR btrim(${t.issueNote}) <> ''`,
    ),
    // Одна строка на позицию: две строки «Тонер Ricoh 201» — не два расходника, а ошибка формы.
    pairUnique: unique('service_request_consumables_unique').on(t.requestId, t.consumableId),
    // Ключ существует только затем, чтобы быть адресатом составного ключа журнала: Postgres требует
    // уникального ограничения ровно на тот набор колонок, на который ссылается FOREIGN KEY, а
    // первичный ключ по `id` тройку не накрывает. Читать по нему ничего не читают.
    rowUnique: unique('service_request_consumables_row_unique').on(
      t.id,
      t.requestId,
      t.consumableId,
    ),
    // Индекс со стороны позиции, а не заявки: по заявке спрашивает сам `pairUnique` (он начинается
    // с `request_id`), а по позиции спрашивают отчёт по расходу и `restrict` при попытке удалить
    // номенклатуру.
    consumableIdx: index('service_request_consumables_consumable_idx').on(t.consumableId),
  }),
);

// История статусов. Ревизия сметы на момент события: по истории должно читаться, что именно
// согласовали и что поменялось между двумя согласованиями.
export const serviceRequestStatusHistory = pgTable(
  'service_request_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => serviceRequests.id, { onDelete: 'cascade' }),
    fromStatus: serviceRequestStatusEnum('from_status'),
    toStatus: serviceRequestStatusEnum('to_status').notNull(),
    estimateRevision: integer('estimate_revision'),
    /**
     * Автор перехода. `NOT NULL` снят миграцией M2 плана переработки заявок оргтехники: переход
     * «Решена» → «Закрыта» портал делает сам, по истечении срока молчания заказчика (Н7), и автора
     * у такой строки нет вовсе. Служебная учётка вместо пустоты была бы хуже пустоты: она
     * появлялась бы в журнале наравне с людьми, и «кто закрыл заявку» отвечалось бы именем,
     * которого не существует. Кто именно поставил строку без автора, говорит `actor_source`.
     *
     * `restrict` остаётся: у строки с автором автор обязан быть читаемым и через год, поэтому
     * пустой `changed_by` означает ровно одно — «сделал портал», а не «сотрудник уволился».
     */
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Кто двигал заявку: `user` — человек, `system` — портал сам. Умолчание `user` сохраняет
     * контракт для всего существующего кода и всех существующих строк — автор у них есть, — а
     * ограничение ниже держит эти две колонки согласованными в обе стороны.
     */
    actorSource: text('actor_source').$type<'user' | 'system'>().notNull().default('user'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment').notNull().default(''),
  },
  (t) => ({
    // Равенство, а не «одно из двух»: `system` с автором означало бы приписанное порталу действие
    // человека, `user` без автора — потерянного автора там, где его обязаны знать. Обе стороны
    // ошибочны одинаково, и обе закрываются одной строкой.
    actorCheck: check(
      'service_request_status_history_actor_check',
      sql`${t.actorSource} IN ('user','system')
          AND (${t.actorSource} = 'user') = (${t.changedBy} IS NOT NULL)`,
    ),
    requestIdx: index('service_request_status_history_request_idx').on(t.requestId, t.changedAt),
  }),
);

// ── Организации-владельцы транспорта (ADR 0037, миграция 0060) ──
// Реквизиты для шапки путевого листа: наименование, адрес, телефон и коды. Отдельно от
// `counterparties`: там внешние стороны (операторы вывоза, арендодатели, подрядчики), здесь —
// свои юрлица, от чьего имени выписывается документ. Таблица, а не строка настроек: техника
// может числиться за разными юрлицами, и лист выписывает то, за которым числится машина.
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    // Телефон шапки бланка. Правится SQL по runbook'у, а не формой, и в реквизите бухгалтерии
    // бывает не один номер («(495) …, +7-985-…» у основной организации): нормализация (ADR 0066,
    // миграция 0095) такие записи не тронула, и печатаются они как заведены.
    phone: text('phone').notNull().default(''),
    // Коды из правого верхнего угла бланка. Пусто — реквизит не заполнен: лист печатается и без
    // него, а требовать то, чего у бухгалтерии сейчас нет, значит не дать завести организацию.
    okpo: text('okpo').notNull().default(''),
    ogrn: text('ogrn').notNull().default(''),
    inn: text('inn').notNull().default(''),
    /** Ею подписан лист на машину, за которой юрлицо не закреплено. Такая ровно одна. */
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    nameNotBlank: check('organizations_name_not_blank', sql`btrim(${t.name}) <> ''`),
    // Контрольные суммы проверяет сервис — приём ИНН контрагента: формат ловит длину,
    // контрольная сумма ловит опечатку в одной цифре, и в CHECK её не выразить.
    innFormat: check(
      'organizations_inn_format_check',
      sql`${t.inn} = '' OR ${t.inn} ~ '^([0-9]{10}|[0-9]{12})$'`,
    ),
    okpoFormat: check(
      'organizations_okpo_format_check',
      sql`${t.okpo} = '' OR ${t.okpo} ~ '^([0-9]{8}|[0-9]{10})$'`,
    ),
    ogrnFormat: check(
      'organizations_ogrn_format_check',
      sql`${t.ogrn} = '' OR ${t.ogrn} ~ '^([0-9]{13}|[0-9]{15})$'`,
    ),
    // «Чей это лист по умолчанию» обязано иметь единственный ответ.
    primaryUnique: uniqueIndex('organizations_primary_unique')
      .on(t.isPrimary)
      .where(sql`${t.isPrimary}`),
    innUnique: uniqueIndex('organizations_inn_unique')
      .on(t.inn)
      .where(sql`${t.inn} <> ''`),
  }),
);

/**
 * Заказчик путевых листов — одна строка на портал (миграция 0164).
 *
 * Отвечает на вопрос «в чьё распоряжение выписан лист»: графа «В чьё распоряжение (наименование и
 * адрес заказчика)» в 4-П и графа «Заказчик» в ЭСМ-2. Рядом с `organizations` и по той же причине,
 * по какой та отдельна от `counterparties`: это реквизиты бумаги, а не карточка внешней стороны, и
 * правка контрагента не вправе менять шапку будущих бланков.
 *
 * Одиночка, а не справочник: пока генподрядчик один, у вопроса один ответ, и выбирать сборщику
 * снимка не из чего — вторую строку запрещает первичный ключ с CHECK. Появится второй генподрядчик
 * — реквизит переезжает к объекту строительства; это отдельная работа.
 *
 * Экрана у настройки нет — как и у справочника юрлиц (бэклог ADR 0037): правится SQL по runbook'у,
 * а заведена сидом миграции, потому что «шаг настройки администратора» без ручки и формы кончился
 * бы пустой графой на каждом бланке (тем же рассуждением, что и организация в миграции 0075).
 */
export const waybillCustomer = pgTable(
  'waybill_customer',
  {
    /** Ключ-одиночка: значение всегда `true`, и вторая строка в таблицу не встаёт. */
    id: boolean('id').primaryKey().default(true),
    name: text('name').notNull().default(''),
    address: text('address').notNull().default(''),
    /** Печатается через `formatPhone` (ADR 0066) — единым видом с телефоном организации в шапке. */
    phone: text('phone').notNull().default(''),
    /** Кто правил шапку: реквизит переживает человека, поэтому гасится ссылка, а не строка. */
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Второй строке взяться неоткуда: единственное значение ключа — `true`, и `false` отсекает
    // CHECK. Схемой, а не договорённостью: сборщику снимка выбирать не из чего по устройству.
    single: check('waybill_customer_id_check', sql`${t.id}`),
  }),
);

// ── Операторы вывоза на объекте (ADR 0010, миграция 0027) ──
// Многие-ко-многим: на объекте работает несколько операторов, оператор обслуживает несколько
// объектов. Связь сужает выбор исполнителя заявки вывоза; требование «тип контрагента =
// operator» держит сервис (как и у wasteRequests.operatorCounterpartyId).
export const constructionObjectOperators = pgTable(
  'construction_object_operators',
  {
    constructionObjectId: uuid('construction_object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'cascade' }),
    counterpartyId: uuid('counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.constructionObjectId, t.counterpartyId] }),
    counterpartyIdx: index('construction_object_operators_counterparty_idx').on(t.counterpartyId),
  }),
);

// ── Файлы ──
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    status: fileStatusEnum('status').notNull().default('pending'),
    scanStatus: text('scan_status').notNull().default('pending'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    objectKeyIdx: uniqueIndex('files_object_key_unique').on(t.objectKey),
    statusIdx: index('files_status_idx').on(t.status),
  }),
);

// ── Заявки на вывоз мусора ──
export const wasteRequests = pgTable(
  'waste_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Сквозной человекочитаемый номер (отображается как «М-<num>», миграция 0064).
    num: integer('num').generatedAlwaysAsIdentity(),
    // Заявка заведена до префикса «М-» и показывается прежним номером «<num>-<буква типа>»:
    // её номер уже разошёлся по талонам и переписке (миграция 0064). Новые строки — false.
    legacyNumFormat: boolean('legacy_num_format').notNull().default(false),
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    requestType: requestTypeEnum('request_type').notNull(),
    // container_install → тип контейнера (type='cont'); container_replace → тип, установленный
    // на объекте; waste_removal → тип машины/контейнера
    containerTypeId: uuid('container_type_id').references(() => containerTypes.id, {
      onDelete: 'restrict',
    }),
    // Сколько контейнеров снимает или меняет одна заявка (миграция 0080). У остальных типов
    // всегда 1: у установки остаётся «одна заявка — один контейнер», иначе строка присутствия
    // перестала бы быть одним контейнером.
    containersCount: integer('containers_count').notNull().default(1),
    // Чей контейнер снимаем/меняем: оператор его заявки установки (миграция 0080). Не выводится
    // из оператора самой заявки — вывоз чужого контейнера бывает и разрешается подтверждением,
    // но погасить он обязан единицу настоящего владельца. NULL — владелец не известен
    // (установку завели без оператора либо заявка старше миграции).
    containerOwnerCounterpartyId: uuid('container_owner_counterparty_id').references(
      () => counterparties.id,
      { onDelete: 'restrict' },
    ),
    // Объём вывоза: только у waste_removal — контейнерные операции его не несут (ADR 0019).
    // У заявок на замену и снятие, заведённых до этого решения, объём остался в истории.
    volumeM3: integer('volume_m3'),
    // Что вывозим и по какой цене — только у вывоза самосвалами (ADR 0019). Тариф и цена —
    // снимок на момент сохранения заявки: изменение прайса не переписывает суммы уже
    // оформленных заявок.
    wasteTypeId: uuid('waste_type_id').references(() => wasteTypes.id, { onDelete: 'restrict' }),
    wasteTariffId: uuid('waste_tariff_id').references(() => wasteTariffs.id, {
      onDelete: 'restrict',
    }),
    pricePerM3: numeric('price_per_m3', { precision: 12, scale: 2 }),
    // Сумма считается БД (GENERATED): производная от объёма и цены не может с ними разойтись.
    amount: numeric('amount', { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`round(volume_m3 * price_per_m3, 2)`,
    ),
    deliveryAt: timestamp('delivery_at', { withTimezone: true }).notNull(),
    // Время не задано — в deliveryAt значима только дата (00:00 МСК). Инвариант держит
    // приложение: CHECK невозможен, приведение timestamptz к времени суток не IMMUTABLE (0020).
    deliveryTimeUnspecified: boolean('delivery_time_unspecified').notNull().default(false),
    // Кто принимает машину на площадке (миграция 0062). Пусто — заявка заведена до этой колонки:
    // CHECK на непустоту сделал бы прежние строки невалидными, поэтому требование держит сервер.
    // Телефон — десять цифр без кода страны (ADR 0066, миграция 0095).
    responsibleName: text('responsible_name').notNull().default(''),
    responsiblePhone: text('responsible_phone').notNull().default(''),
    // Комментарий площадки — стороны заказчика: штаб, комендант, руководитель строительства, а
    // также ведущие заявку менеджер и диспетчер.
    comment: text('comment').notNull().default(''),
    // Комментарий исполнителя (миграция 0078): вторая сторона заявки. Пишется отдельной ручкой —
    // правкой заявки исполнитель не занимается (ADR 0038), а комментарий смены статуса живёт в
    // истории и в списке не виден.
    operatorComment: text('operator_comment').notNull().default(''),
    status: requestStatusEnum('status').notNull().default('new'),
    // Кто вывозит (ADR 0010): контрагент-оператор, назначенный менеджером/диспетчером. NULL —
    // оператор ещё не выбран. Он же определяет, кто из операторов видит заявку. Тип контрагента
    // (operator) проверяет сервис: составной FK потребовал бы хранить тип в самой заявке.
    operatorCounterpartyId: uuid('operator_counterparty_id').references(() => counterparties.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numUnique: uniqueIndex('waste_requests_num_unique').on(t.num),
    statusIdx: index('waste_requests_status_idx').on(t.status),
    operatorIdx: index('waste_requests_operator_idx')
      .on(t.operatorCounterpartyId)
      .where(sql`${t.operatorCounterpartyId} IS NOT NULL`),
    objectIdx: index('waste_requests_object_idx').on(t.objectId),
    deliveryIdx: index('waste_requests_delivery_idx').on(t.deliveryAt),
    createdAtIdx: index('waste_requests_created_at_idx').on(t.createdAt),
    wasteTypeIdx: index('waste_requests_waste_type_idx').on(t.wasteTypeId),
    // По этой тройке считает группы присутствия view present_container_groups (миграция 0080).
    containerOwnerIdx: index('waste_requests_container_owner_idx')
      .on(t.objectId, t.containerTypeId, t.containerOwnerCounterpartyId)
      .where(sql`${t.requestType} IN ('container_replace', 'container_removal')`),
    // Установка нового контейнера не тарифицируется: вывоза мусора в этой операции нет.
    // Замена и снятие тарификацию тоже потеряли (ADR 0019), но CHECK на них не расширен —
    // у заведённых до этого заявок тип мусора и цена сохранены как есть; новые их не пишут.
    installNoPricing: check(
      'waste_requests_install_no_pricing_check',
      sql`${t.requestType} <> 'container_install'
          OR (${t.wasteTypeId} IS NULL AND ${t.wasteTariffId} IS NULL AND ${t.pricePerM3} IS NULL)`,
    ),
    priceSnapshot: check(
      'waste_requests_price_snapshot_check',
      sql`(${t.wasteTariffId} IS NULL) = (${t.pricePerM3} IS NULL)`,
    ),
    pricePositive: check(
      'waste_requests_price_positive_check',
      sql`${t.pricePerM3} IS NULL OR ${t.pricePerM3} > 0`,
    ),
    // Количество и владелец бывают только у операций над стоящим контейнером (миграция 0080).
    // Потолок — защита от опечатки: сколько снять можно на самом деле, ограничено присутствием
    // на объекте, и это проверяет сервер по view.
    containersCountRange: check(
      'waste_requests_containers_count_check',
      sql`${t.containersCount} BETWEEN 1 AND 20`,
    ),
    containersCountType: check(
      'waste_requests_containers_count_type_check',
      sql`${t.containersCount} = 1
          OR ${t.requestType} IN ('container_replace', 'container_removal')`,
    ),
    containerOwnerType: check(
      'waste_requests_container_owner_type_check',
      sql`${t.containerOwnerCounterpartyId} IS NULL
          OR ${t.requestType} IN ('container_replace', 'container_removal')`,
    ),
    // У вывоза металлолома предмета нет вовсе (ADR 0067, миграция 0091). Запрет строгий, в
    // отличие от мягкого `install_no_pricing_check` у замены и снятия: заявок этого типа,
    // заведённых до решения, не бывает — тип и решение появились вместе.
    metalNoSubject: check(
      'waste_requests_metal_no_subject_check',
      sql`${t.requestType} <> 'metal_removal'
          OR (${t.containerTypeId} IS NULL AND ${t.wasteTypeId} IS NULL
              AND ${t.wasteTariffId} IS NULL AND ${t.pricePerM3} IS NULL
              AND ${t.volumeM3} IS NULL)`,
    ),
  }),
);

// ── Наличие контейнеров на площадках (view, создаётся миграцией 0007, переписан в 0080) ──
// Возвращает id «присутствующих» заявок установки: установки минус снятия внутри тройки
// «объект + тип + владелец» (FIFO по num). Владелец единицы — оператор её заявки установки.
export const presentContainers = pgView('present_containers', {
  id: uuid('id'),
  objectId: uuid('object_id'),
  containerTypeId: uuid('container_type_id'),
  ownerCounterpartyId: uuid('owner_counterparty_id'),
}).existing();

// Группы присутствия (миграция 0080): «что и чьё стоит на объекте, сколько штук». Одна выборка
// отвечает и на «из чего выбирать контейнер в заявке», и на «сколько максимум можно снять»,
// и на «кого звать на этот объект».
export const presentContainerGroups = pgView('present_container_groups', {
  objectId: uuid('object_id'),
  containerTypeId: uuid('container_type_id'),
  ownerCounterpartyId: uuid('owner_counterparty_id'),
  quantity: integer('quantity'),
}).existing();

// ── Связь заявка ↔ файлы (ссылочная целостность) ──
export const requestFiles = pgTable(
  'request_files',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    // Документ заявки или талон, приложенный при её закрытии (миграция 0031). С ADR 0024 сюда
    // попадают талоны любой заявки: у вывоза они тоже общий пул, а не бумага отдельной машины
    // (миграция 0042 перенесла их с машин сюда).
    kind: text('kind').notNull().default('attachment').$type<'attachment' | 'ticket'>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.fileId] }),
    fileIdx: index('request_files_file_idx').on(t.fileId),
    kindCheck: check('request_files_kind_check', sql`${t.kind} IN ('attachment', 'ticket')`),
  }),
);

// ── Чем вывезли заявку: состав техники прошлых закрытий (миграции 0029, 0042, 0056) ──
// ТОЛЬКО ЧТЕНИЕ. С ADR 0035 закрытие предъявляет фактический объём и стоимость
// (waste_request_completions), а не перечень машин: вывоз тарифицируется самосвалами, и какими
// именно машинами увезли объём, к расчёту отношения не имеет. Новых строк здесь не появляется,
// заведённые остаются историей заявки — по ним её принимали, и объём с суммой перенесены в факт
// миграцией 0056. Форма строки прежняя (ADR 0011, ADR 0024): «тип техники × количество» со
// снимком вместимости и цены, `deletedAt` — пометка на удаление, выводившая строку из сверки.
export const wasteRequestVehicles = pgTable(
  'waste_request_vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    containerTypeId: uuid('container_type_id')
      .notNull()
      .references(() => containerTypes.id, { onDelete: 'restrict' }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }).notNull(),
    /** Сколько машин этого типа; колонка названа не `count`, чтобы не спорить с агрегатом. */
    count: integer('vehicle_count').notNull().default(1),
    wasteTariffId: uuid('waste_tariff_id').references(() => wasteTariffs.id, {
      onDelete: 'restrict',
    }),
    pricePerM3: numeric('price_per_m3', { precision: 12, scale: 2 }),
    // Сумма строки считается БД (GENERATED) — производная от вместимости, количества и цены.
    amount: numeric('amount', { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`round(volume_m3 * vehicle_count * price_per_m3, 2)`,
    ),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    volumePositive: check('waste_request_vehicles_volume_positive_check', sql`${t.volumeM3} > 0`),
    countCheck: check('waste_request_vehicles_count_check', sql`${t.count} BETWEEN 1 AND 99`),
    priceSnapshot: check(
      'waste_request_vehicles_price_snapshot_check',
      sql`(${t.wasteTariffId} IS NULL) = (${t.pricePerM3} IS NULL)`,
    ),
    pricePositive: check(
      'waste_request_vehicles_price_positive_check',
      sql`${t.pricePerM3} IS NULL OR ${t.pricePerM3} > 0`,
    ),
    requestIdx: index('waste_request_vehicles_request_idx').on(t.requestId),
    activeIdx: index('waste_request_vehicles_active_idx')
      .on(t.requestId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── Факт вывоза: сколько вывезли и во сколько это обошлось (ADR 0035, миграция 0056) ──
// Одна заявка — одно закрытие (PK=FK): повторное после отката администратором переписывает
// строку. Величина одна, но колонки под неё две (миграция 0091): мусор меряют объёмом,
// металлолом принимают по весу и без денег (ADR 0067).
// Объём вводится руками — он стоит в талоне и весовой квитанции, — и с заявленным
// (waste_requests.volumeM3) расходится законно: заявка это план, а платят за вывезенное.
// Сумма подставляется расчётом «объём × цена», но правится свободно: счёт оператора включает и
// подачу, и недогруз, и сходиться сумма должна со счётом, а не с формулой. Цена нужна как
// основание расчёта, а не как условие закрытия: нет её в прайсе — сумму вводят руками.
export const wasteRequestCompletions = pgTable(
  'waste_request_completions',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    // Вывезенное лежит в одной из двух колонок — какой, решает тип заявки (миграция 0091).
    // Мусор меряют объёмом, металлолом принимают по весу (ADR 0067); общей колонки «сколько» с
    // единицей рядом нет намеренно: объём умножается на цену прайса, а вес — ни на что.
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    weightTons: numeric('weight_tons', { precision: 12, scale: 3 }),
    // Снимок цены по виду «Самосвал» на момент закрытия (ADR 0022, ADR 0026): сумма обязана
    // объясняться сама, а правка прайса не переписывает уже закрытые заявки.
    pricePerM3: numeric('price_per_m3', { precision: 12, scale: 2 }),
    wasteTariffId: uuid('waste_tariff_id').references(() => wasteTariffs.id, {
      onDelete: 'restrict',
    }),
    totalCost: numeric('total_cost', { precision: 14, scale: 2 }),
    completedBy: uuid('completed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * День фактического вывоза (ADR 0114, Р19, миграция 0181). Ни `deliveryAt`, ни `completedAt`
     * его не заменяют: первое — план, а вывозят и раньше, и позже; второе — когда заявку закрыли,
     * а закрывают её задним числом. Сверять дату талона надо с фактом, и до этой колонки факта не
     * было вовсе.
     *
     * Пусто у закрытий старше колонки: backfill не выполнялся сознательно — подстановка плановой
     * даты выдала бы предположение за факт и при первой же прогонке архива нарисовала бы
     * расхождения там, где их никто не совершал.
     */
    removedOn: date('removed_on', { mode: 'string' }),
    /**
     * `entered` — дату ввёл человек, `unknown` — закрытие старше колонки. Значение `inferred` из
     * ранних редакций плана убрано: у строки без даты оно означало бы «выведено», хотя не выведено
     * ничего. Жёсткая сверка с датой талона идёт только против `entered`.
     */
    removedOnSource: text('removed_on_source')
      .notNull()
      .default('unknown')
      .$type<'entered' | 'unknown'>(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    volumePositive: check(
      'waste_request_completions_volume_positive_check',
      sql`${t.volumeM3} > 0`,
    ),
    weightPositive: check(
      'waste_request_completions_weight_positive_check',
      sql`${t.weightTons} IS NULL OR ${t.weightTons} > 0`,
    ),
    // Ровно одна величина на закрытие (миграция 0091): «ни одной» — закрытие, которое ничего не
    // предъявило, «обе» — два ответа на вопрос, сколько увезли.
    measure: check(
      'waste_request_completions_measure_check',
      sql`(${t.volumeM3} IS NOT NULL) <> (${t.weightTons} IS NOT NULL)`,
    ),
    // Вес идёт без денег: цена прайса задана за м³, и приложить её к тоннам нечем (ADR 0067).
    weightNoPricing: check(
      'waste_request_completions_weight_no_pricing_check',
      sql`${t.weightTons} IS NULL
          OR (${t.pricePerM3} IS NULL AND ${t.wasteTariffId} IS NULL AND ${t.totalCost} IS NULL)`,
    ),
    pricePositive: check(
      'waste_request_completions_price_positive_check',
      sql`${t.pricePerM3} IS NULL OR ${t.pricePerM3} > 0`,
    ),
    totalCostPositive: check(
      'waste_request_completions_total_cost_positive_check',
      sql`${t.totalCost} IS NULL OR ${t.totalCost} >= 0`,
    ),
    // Тариф без цены — ссылка на прайс, которая ничего не объясняет. Обратное законно: цена без
    // тарифа означает «взяли не из прайса», потому что там её нет.
    priceSnapshot: check(
      'waste_request_completions_price_snapshot_check',
      sql`${t.wasteTariffId} IS NULL OR ${t.pricePerM3} IS NOT NULL`,
    ),
    completedAtIdx: index('waste_request_completions_completed_at_idx').on(t.completedAt.desc()),
    removedOnSourceCheck: check(
      'waste_request_completions_removed_on_source_check',
      sql`${t.removedOnSource} IN ('entered', 'unknown')`,
    ),
    // Дата и её источник связаны намертво в обе стороны: дата без источника и `entered` без даты —
    // это два способа соврать о том, откуда взялся день вывоза.
    removedOnCheck: check(
      'waste_request_completions_removed_on_check',
      sql`(${t.removedOn} IS NULL) = (${t.removedOnSource} = 'unknown')`,
    ),
  }),
);

// ── Распознавание талонов вывоза (ADR 0114, миграция 0181) ──
//
// Талон до этого модуля был файлом и больше ничем: скан висел строкой `requestFiles` с
// `kind = 'ticket'` (ADR 0024), и три вопроса, ради которых бумагу собирают, задать было некому —
// не предъявлялся ли этот лист раньше, сходится ли объём, сходится ли дата.
//
// ЗАМЕЧАНИЯ ЗДЕСЬ НЕ ХРАНЯТСЯ: они считаются функцией от (заявка, факт, талоны) в
// `services/waste-ticket-checks.ts`. Материализованная таблица замечаний разошлась бы с талонами
// на первой же правке, и разошлась бы молча. Материализуется только РЕШЕНИЕ человека — принятие
// расхождения, и оно хранится с отпечатком входа (`wasteTicketCheckResolutions`).
//
// СОСТАВНЫЕ КЛЮЧИ. Заявка хранится своей колонкой у файловой строки, страницы и талона — иначе
// каждый отбор «талоны заявки» шёл бы тремя джойнами; цена такого хранения известна, три копии
// одного факта расходятся, поэтому пары `(requestId, fileId)` и `(requestId, pageId)` замкнуты
// внешними ключами на соседа. Без них схема допускает страницу, сославшуюся на файл одной заявки
// с `requestId` другой, и талон на странице чужой заявки: ошибка кода превращалась бы в тихо
// неверную сверку — то есть ровно в то, от чего модуль и заводится.

/**
 * Обработка файла-скана: единственное место, где живёт «файл отвергнут» (Р10).
 *
 * Файл отвечает за обработку, страница — за распознавание. Отвергнутый файл страниц не порождает
 * вовсе, и пометить «это не изображение и не PDF» больше негде; без этой строки недоступное
 * распознавание неотличимо от «талоны в порядке» (Р29).
 */
export const wasteTicketFiles = pgTable(
  'waste_ticket_files',
  {
    /**
     * PK = FK: у файла ровно одна строка обработки. Отдельный `id` означал бы, что один и тот же
     * скан можно обработать дважды с разным исходом, и «какой из них показывать» стало бы вопросом.
     */
    fileId: uuid('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** Колонка ради отборов; согласованность с привязкой держит составной ключ `linkFk`. */
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    /**
     * `unsupported` отделён от `failed` намеренно: первое — приговор бумаге (повтор не поможет,
     * нужен человек), второе — приговор попытке (повтор будет). Человеку это две разные фразы,
     * воркеру — два разных решения о ретрае.
     */
    status: text('status').notNull().$type<'pending' | 'done' | 'unsupported' | 'failed'>(),
    /** Причина человеческими словами: собрать её заново из кодов нельзя. */
    reason: text('reason').notNull().default(''),
    /**
     * Дубль классификации ПОСЛЕДНЕЙ неуспешной попытки (Р29). Источник истины — попытки: за час их
     * бывает несколько с разной природой, и доля ошибок для баннера считается по ним. Здесь она
     * лежит затем, чтобы строка в списке показывала своё состояние без запроса по попыткам.
     */
    errorClass: text('error_class').notNull().default('').$type<'' | 'transient' | 'terminal'>(),
    errorScope: text('error_scope').notNull().default('').$type<'' | 'subsystem' | 'item'>(),
    /**
     * «В файле 6 страниц, обработано 5». Две колонки, а не одна: сверх лимита
     * `TICKET_OCR_MAX_PAGES` страницы не теряются молча, и разница между «всего» и «обработано» —
     * это то, что человек обязан увидеть.
     */
    totalPages: smallint('total_pages').notNull().default(0),
    processedPages: smallint('processed_pages').notNull().default(0),
    /**
     * По ней считается «попытка 3 из 5, следующая в 14:32»: очередь уже умеет и попытки, и паузу,
     * и переспрашивать её дешевле второй копии счётчика. `SET NULL` — задачу вычищают как
     * отработавшую, и надпись к этому времени уже неинтересна.
     */
    activeJobId: uuid('active_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * Поддерживает составной ключ страницы. Ведущим `requestId` он же обслуживает каскад от
     * заявки, поэтому отдельного индекса по ней нет.
     */
    requestFileUnique: unique('waste_ticket_files_request_file_unique').on(t.requestId, t.fileId),
    /**
     * Обработка идёт следом за привязкой: откат заявки в «Новую» отвязывает файлы, и этим же
     * движением обязано исчезнуть распознанное (Р22). Каскадом, а не уборкой в коде — отвязка идёт
     * из маршрута статуса, который о распознавании знать не обязан.
     */
    linkFk: foreignKey({
      columns: [t.requestId, t.fileId],
      foreignColumns: [requestFiles.requestId, requestFiles.fileId],
      name: 'waste_ticket_files_link_fk',
    }).onDelete('cascade'),
    statusCheck: check(
      'waste_ticket_files_status_check',
      sql`${t.status} IN ('pending', 'done', 'unsupported', 'failed')`,
    ),
    /**
     * Набор значений закрыт с обеих осей: опечатка в `errorScope` не сломала бы ничего видимого,
     * но молча вывела бы строку из числителя health-метрики — погасила бы баннер ровно тогда,
     * когда он нужен.
     */
    errorClassCheck: check(
      'waste_ticket_files_error_class_check',
      sql`${t.errorClass} IN ('', 'transient', 'terminal')`,
    ),
    errorScopeCheck: check(
      'waste_ticket_files_error_scope_check',
      sql`${t.errorScope} IN ('', 'subsystem', 'item')`,
    ),
    /** «Обработано больше, чем есть» — не редкий случай, а рассинхрон, выглядящий готовой работой. */
    pagesCheck: check(
      'waste_ticket_files_pages_check',
      sql`${t.totalPages} >= 0 AND ${t.processedPages} >= 0
          AND ${t.processedPages} <= ${t.totalPages}`,
    ),
  }),
);

/**
 * Страница файла — единица распознавания (Р10).
 *
 * Хэш считается по РАСТРУ СТРАНИЦЫ, а не по файлу, и это главное в таблице: хэш всего PDF не
 * узнает страницу, вложенную в другой PDF, — а именно так выглядит повторное предъявление бумаги,
 * когда бухгалтерия сканирует пачкой. Точный повтор виден до всякого чтения, даже когда номер не
 * прочитался вовсе (Р17).
 */
export const wasteTicketPages = pgTable(
  'waste_ticket_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').notNull(),
    pageNo: smallint('page_no').notNull(),
    /** sha256 растра после предобработки, нижним регистром (`CHECK` в миграции). */
    pageSha256: char('page_sha256', { length: 64 }).notNull(),
    /**
     * Страница провалилась — файл при этом мог обработаться: пять страниц из шести прочитаны,
     * шестая не далась, и это состояние обязано быть выразимым.
     */
    status: text('status').notNull().$type<'pending' | 'done' | 'failed'>(),
    /**
     * Треть снимков несёт по два талона (замер 18.08.2026), поэтому ноль здесь — законный ответ
     * «страница есть, талонов на ней нет», а не ошибка.
     */
    ticketsFound: smallint('tickets_found').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    fileFk: foreignKey({
      columns: [t.requestId, t.fileId],
      foreignColumns: [wasteTicketFiles.requestId, wasteTicketFiles.fileId],
      name: 'waste_ticket_pages_file_fk',
    }).onDelete('cascade'),
    /** Вторая «страница 3» означала бы, что лист разобран дважды, и сумма по талонам удвоилась бы. */
    filePageUnique: unique('waste_ticket_pages_file_page_unique').on(t.fileId, t.pageNo),
    /**
     * Поддерживает составной ключ талона. Ведущим `requestId` он же обслуживает каскад от заявки,
     * поэтому отдельного индекса по ней нет.
     */
    requestIdUnique: unique('waste_ticket_pages_request_id_unique').on(t.requestId, t.id),
    statusCheck: check(
      'waste_ticket_pages_status_check',
      sql`${t.status} IN ('pending', 'done', 'failed')`,
    ),
    pageNoCheck: check('waste_ticket_pages_page_no_check', sql`${t.pageNo} >= 1`),
    ticketsFoundCheck: check('waste_ticket_pages_tickets_found_check', sql`${t.ticketsFound} >= 0`),
    /**
     * Форма хэша проверяется схемой, потому что на нём стоит обнаружение дубля бумаги: тот же лист
     * в верхнем регистре и в нижнем — это два разных ключа и молча пропущенный повтор.
     */
    sha256Check: check('waste_ticket_pages_sha256_check', sql`${t.pageSha256} ~ '^[0-9a-f]{64}$'`),
    /** «Этот растр уже видели» — вопрос о повторе бумаги, отдельный от кэша распознавания. */
    sha256Idx: index('waste_ticket_pages_sha256_idx').on(t.pageSha256),
  }),
);

/**
 * Вызов модели по растру страницы (Р12).
 *
 * Таблица НЕ знает ни о заявке, ни о файле, и это её главное свойство: попытка отвечает на вопрос
 * «что такая-то модель такой-то версии промпта прочитала на таком-то растре». Ответ не меняется от
 * того, к какой заявке приложили бумагу, поэтому строки переживают откат заявки (Р22) и служат
 * кэшем: повторное закрытие тем же листом не стоит ни копейки.
 */
export const wasteTicketRecognitionAttempts = pgTable(
  'waste_ticket_recognition_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Ссылки на страницу здесь нет намеренно: страницу удаляет откат заявки, а попытка обязана его
     * пережить — иначе кэш терял бы смысл ровно в том случае, ради которого заведён.
     */
    pageSha256: char('page_sha256', { length: 64 }).notNull(),
    /** Наружу портал ходит только через прокси (Р3); `stub` — тесты и разработка без сети. */
    engine: text('engine').notNull().$type<'stub' | 'proxy' | 'ocr'>(),
    /**
     * ЗАКАЗАННАЯ модель — та, что в ключе кэша; прокси вправе отдать запрос другой (Р7), и
     * фактическая пишется рядом. Одной колонкой их не свести: по заказанной ищется кэш, по
     * фактической сверяется биллинг, и разойтись они обязаны видимо.
     */
    model: text('model').notNull().default(''),
    modelReported: text('model_reported').notNull().default(''),
    /** Обе версии в ключе кэша: сменился промпт или предобработка — это другое чтение. */
    promptVersion: integer('prompt_version').notNull(),
    preprocessingVersion: integer('preprocessing_version').notNull(),
    /** Неуспешная хранится наравне с успешной: по ней считается доля ошибок (Р29). */
    status: text('status').notNull().$type<'done' | 'failed'>(),
    /**
     * Принудительный проход мимо кэша (Р13): «перераспознать» при тех же версиях. Флаг выводит
     * строку из уникального ключа — иначе ограничение не дало бы завести вторую успешную попытку,
     * и кнопка молча возвращала бы старый результат.
     */
    forced: boolean('forced').notNull().default(false),
    /**
     * ТОЛЬКО нормализованный ответ, прошедший схему: `tickets[]` и `unreadable`. Ни служебных полей
     * провайдера, ни полного текста ответа, ни тем более изображения — это данные, попадающие под
     * вопрос о передаче сканов вовне (В1), и держать их «на всякий случай» нельзя.
     */
    raw: jsonb('raw')
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    /** Свой — найти вызов в журнале прокси; апстримовый — сверить счёт. Владельцы разные. */
    proxyRequestId: text('proxy_request_id').notNull().default(''),
    upstreamRequestId: text('upstream_request_id').notNull().default(''),
    /** Код как приехал: множество открыто — чужая подсистема не обязана отвечать нашим словарём. */
    errorCode: text('error_code').notNull().default(''),
    /**
     * А классификация закрыта, потому что по ней принимаются решения: `transient` — повтор будет,
     * `terminal` — не будет; `subsystem` поднимает баннер, `item` не поднимает (Р29).
     */
    errorClass: text('error_class').notNull().default('').$type<'' | 'transient' | 'terminal'>(),
    errorScope: text('error_scope').notNull().default('').$type<'' | 'subsystem' | 'item'>(),
    error: text('error').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({
    engineCheck: check(
      'waste_ticket_recognition_attempts_engine_check',
      sql`${t.engine} IN ('stub', 'proxy', 'ocr')`,
    ),
    statusCheck: check(
      'waste_ticket_recognition_attempts_status_check',
      sql`${t.status} IN ('done', 'failed')`,
    ),
    errorClassCheck: check(
      'waste_ticket_recognition_attempts_error_class_check',
      sql`${t.errorClass} IN ('', 'transient', 'terminal')`,
    ),
    errorScopeCheck: check(
      'waste_ticket_recognition_attempts_error_scope_check',
      sql`${t.errorScope} IN ('', 'subsystem', 'item')`,
    ),
    /**
     * Неклассифицированный сбой = слепая метрика: строка попадёт в знаменатель health-метрики и не
     * попадёт ни в один числитель, то есть УЛУЧШИТ картину самим фактом того, что её не разобрали.
     */
    classificationCheck: check(
      'waste_ticket_recognition_attempts_classification_check',
      sql`${t.status} <> 'failed' OR (${t.errorClass} IN ('transient', 'terminal')
                                  AND ${t.errorScope} IN ('subsystem', 'item'))`,
    ),
    sha256Check: check(
      'waste_ticket_recognition_attempts_sha256_check',
      sql`${t.pageSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    rawCheck: check(
      'waste_ticket_recognition_attempts_raw_check',
      sql`jsonb_typeof(${t.raw}) = 'object'`,
    ),
    /**
     * КЛЮЧ КЭША, он же ключ идемпотентности прокси: оба отвечают на вопрос «это та же работа?».
     * Только для успешных — ограничение без этого условия запирало бы повтор после разрыва сети,
     * то есть делало бы неудачу окончательной. И мимо принудительных проходов (Р13).
     */
    cacheUnique: uniqueIndex('waste_ticket_recognition_attempts_cache_unique')
      .on(t.pageSha256, t.engine, t.model, t.promptVersion, t.preprocessingVersion)
      // `model <> 'proxy'` — вариант A (Р7, миграция 0191): за заглушкой «выбирает прокси» в разное
      // время стоит разная модель, поэтому такие попытки не участвуют в кэше ни чтением, ни
      // уникальностью. Без этого условия выключенный на чтение кэш оставался включённым на запись:
      // второй проход по той же странице падал бы нарушением уникальности.
      .where(sql`${t.status} = 'done' AND NOT ${t.forced} AND ${t.model} <> 'proxy'`),
    pageCreatedIdx: index('waste_ticket_recognition_attempts_page_created_idx').on(
      t.pageSha256,
      t.createdAt.desc(),
    ),
    /**
     * Два частичных индекса под health-метрику (Р29): знаменатель — попытки, действительно
     * ходившие в прокси, числитель — неуспешные. Окно у метрики короткое, а таблица растёт всем,
     * что когда-либо читали.
     */
    proxyIdx: index('waste_ticket_recognition_attempts_proxy_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.engine} = 'proxy'`),
    failedIdx: index('waste_ticket_recognition_attempts_failed_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'failed'`),
  }),
);

/**
 * Талон вывоза (Р15–Р17).
 *
 * Распознанное — предложение, но проверка считается сразу. Считать её только по подтверждённым
 * нельзя: тогда человек, ещё не разобравший талоны, не видел бы ни одного замечания — сверка
 * появлялась бы уже ПОСЛЕ того, как он принял решение. Поэтому проверки считаются по всем
 * неотклонённым, а ограничения БД — только по подтверждённым: занять номер может лишь бумага,
 * которую человек признал.
 */
export const wasteTickets = pgTable(
  'waste_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    /** Пусто у ручного талона и у машинного, чья страница убрана (см. `pageFk`). */
    pageId: uuid('page_id'),
    /** Позиция талона на странице: их бывает по два на снимке. */
    seq: smallint('seq').notNull().default(1),
    /**
     * Обе попытки каскада (Р14): дешёвая читает всё, старшая перечитывает спорное. Хранятся обе,
     * потому что «чем прочитана эта цифра» — вопрос к живому значению, а не к истории вызовов.
     * `SET NULL` — страховка от рассинхрона с уборкой попыток по TTL: пока талон на попытку
     * ссылается, уборка её не трогает (Р31).
     */
    primaryAttemptId: uuid('primary_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    escalationAttemptId: uuid('escalation_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    /**
     * СНИМОК оператора-исполнителя, взятый в момент подтверждения и дальше замороженный: область
     * уникальности номера — перевозчик, потому что талон выдаёт он, а у двух перевозчиков нумерация
     * независима. Не ссылка на заявку: исполнителя выполненной заявки законно меняют, и вместе с
     * ним поехала бы область уникальности уже занятого номера. `NULL` законен — оператор у заявки
     * необязателен, и `NOT NULL` означал бы выдуманного контрагента.
     */
    operatorCounterpartyId: uuid('operator_counterparty_id').references(() => counterparties.id),
    /**
     * Номер в трёх видах, и каждый нужен отдельно (Р16): дословно — человеку, консервативный ключ —
     * ограничению БД, поисковый — предупреждению о похожем. Агрессивная нормализация в ключе
     * склеила бы `12-34` и `123-4`, поэтому дефисы и ведущие нули в нём сохраняются.
     */
    numberRaw: text('number_raw').notNull().default(''),
    numberKey: text('number_key').notNull().default(''),
    numberFuzzy: text('number_fuzzy').notNull().default(''),
    /** Пусто — не прочиталось или проходы разошлись (Р14): расхождение оставляет поле пустым. */
    issuedOn: date('issued_on', { mode: 'string' }),
    /**
     * `NULL` законен дважды: у простоя объёма нет вовсе, и у обычного талона он бывает не прочитан.
     * Поэтому «объём обязателен у вывоза» не проверяется — такой `CHECK` запретил бы записать
     * честно нераспознанное и отправил бы весь талон в ручной ввод.
     */
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    /**
     * Талон бывает про простой («Простой с 9:10 по 10:10»), и в сумму объёма он не входит (Р18);
     * без этого поля такой талон выглядел бы вывозом на ноль кубов.
     */
    workKind: text('work_kind').notNull().default('removal').$type<'removal' | 'idle' | 'other'>(),
    /**
     * Адрес выполнения — он же объект; графа «Заказчик» несёт название компании и бесполезна.
     * Дословно: адрес пишут от руки и сокращают как придётся, сравнение нестрогое.
     */
    addressRaw: text('address_raw').notNull().default(''),
    /**
     * Неизменяемо. Правка машинного талона `origin` НЕ меняет — иначе метрика «доля правок»
     * переставала бы его видеть ровно тогда, когда он для неё интереснее всего.
     */
    origin: text('origin').notNull().$type<'ocr' | 'manual'>(),
    status: text('status')
      .notNull()
      .default('unconfirmed')
      .$type<'unconfirmed' | 'confirmed' | 'dismissed'>(),
    /**
     * Какие поля модель просит посмотреть (Р14). Набор значений намеренно НЕ закрыт `CHECK`, в
     * отличие от `resolvedFields` слепой проверки: там имена полей несут ограничения целостности,
     * здесь это подсказка интерфейсу, и новый повод присмотреться не должен стоить миграции.
     */
    needsReviewFields: text('needs_review_fields')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /**
     * Что прочитал каждый проход по спорному полю (Р14): `[{ field, value, model }]`. Снимком
     * рядом с талоном, а не ссылкой на попытки: сопоставление талонов между проходами делает
     * воркер, повторять его в API значило бы завести второй расходящийся алгоритм, — а сырьё
     * попыток убирается по сроку (Р31), тогда как спорное поле живёт до разбора.
     */
    candidates: jsonb('candidates')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<{ field: string; value: string; model: string }[]>(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editedBy: uuid('edited_by').references(() => users.id),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /**
     * Клапан уникальности (Р17): ставится ТОЛЬКО на конфликтующую строку — заводимую или
     * подтверждаемую сейчас, и только если конфликт под блокировкой действительно нашёлся.
     * Отдельной ручки «снять ограничение» нет вовсе: сняв его со старшей строки, она открыла бы её
     * номер всем следующим дублям — починила бы один случай, отключив проверку навсегда.
     */
    duplicateOverrideAt: timestamp('duplicate_override_at', { withTimezone: true }),
    duplicateOverrideBy: uuid('duplicate_override_by').references(() => users.id),
    duplicateOverrideReason: text('duplicate_override_reason').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * В базе объявлено `ON DELETE SET NULL (page_id)` (PostgreSQL 15+, миграция 0181): обнуляется
     * ТОЛЬКО `pageId`, потому что `requestId` у талона `NOT NULL` — обычный `SET NULL` уронил бы
     * удаление страницы ошибкой вместо того, чтобы отвязать талон. Drizzle список колонок не
     * выражает, источник истины — миграция. Отвязать, а не удалить: подтверждённый человеком талон
     * переживает уборку страницы.
     */
    pageFk: foreignKey({
      columns: [t.requestId, t.pageId],
      foreignColumns: [wasteTicketPages.requestId, wasteTicketPages.id],
      name: 'waste_tickets_page_fk',
    }).onDelete('set null'),
    originCheck: check('waste_tickets_origin_check', sql`${t.origin} IN ('ocr', 'manual')`),
    statusCheck: check(
      'waste_tickets_status_check',
      sql`${t.status} IN ('unconfirmed', 'confirmed', 'dismissed')`,
    ),
    workKindCheck: check(
      'waste_tickets_work_kind_check',
      sql`${t.workKind} IN ('removal', 'idle', 'other')`,
    ),
    seqCheck: check('waste_tickets_seq_check', sql`${t.seq} >= 1`),
    /**
     * Отрицательный объём — не расхождение, а бессмыслица. Ноль допущен намеренно: он всего лишь
     * неправдоподобен, а строку нужно суметь записать, чтобы человеку было что исправить.
     */
    volumeCheck: check(
      'waste_tickets_volume_check',
      sql`${t.volumeM3} IS NULL OR ${t.volumeM3} >= 0`,
    ),
    /** «Кто и когда» ходят парой: половина ответа хуже его отсутствия — она выглядит ответом. */
    editedCheck: check(
      'waste_tickets_edited_check',
      sql`(${t.editedAt} IS NULL) = (${t.editedBy} IS NULL)`,
    ),
    confirmedCheck: check(
      'waste_tickets_confirmed_check',
      sql`(${t.confirmedAt} IS NULL) = (${t.confirmedBy} IS NULL)`,
    ),
    /**
     * Ручной талон создаётся сразу подтверждённым (Р15): его ввёл человек, и ждать, пока он
     * подтвердит сам себя, не за чем. Отклонить его потом можно — `dismissed` здесь законен.
     */
    manualConfirmedCheck: check(
      'waste_tickets_manual_confirmed_check',
      sql`${t.origin} <> 'manual' OR ${t.status} <> 'unconfirmed'`,
    ),
    /**
     * Все три колонки клапана вместе или ни одной. Снятый клапан — это отсутствие причины, а не
     * пустая причина: иначе «почему этот дубль разрешён» имело бы два представления, и отбор
     * «строки с клапаном» разошёлся бы с частичными индексами ниже.
     */
    duplicateOverrideCheck: check(
      'waste_tickets_duplicate_override_check',
      sql`(${t.duplicateOverrideAt} IS NULL) = (${t.duplicateOverrideBy} IS NULL)
          AND (${t.duplicateOverrideAt} IS NULL) = (${t.duplicateOverrideReason} = '')`,
    ),
    /**
     * Один талон на позицию страницы: повторный разбор той же страницы не должен раздваивать
     * бумагу. Только машинные — ручной талон `seq` ничего не занимает.
     */
    pageSeqUnique: uniqueIndex('waste_tickets_page_seq_unique')
      .on(t.pageId, t.seq)
      .where(sql`${t.pageId} IS NOT NULL AND ${t.origin} = 'ocr'`),
    /**
     * ГЛАВНОЕ ОГРАНИЧЕНИЕ МОДУЛЯ: один лист не закрывает две заявки. Индексов два, потому что
     * «ничьи» заявки надо свести в одну область, а `NULL` в PostgreSQL не равен `NULL` — с одним
     * индексом по паре талоны заявок без исполнителя не конфликтовали бы вообще ни с чем, то есть
     * проверка молча выключалась бы там, где оператор не проставлен.
     */
    operatorNumberUnique: uniqueIndex('waste_tickets_operator_number_unique')
      .on(t.operatorCounterpartyId, t.numberKey)
      .where(
        sql`${t.operatorCounterpartyId} IS NOT NULL AND ${t.numberKey} <> ''
            AND ${t.status} = 'confirmed' AND ${t.duplicateOverrideAt} IS NULL`,
      ),
    numberUnique: uniqueIndex('waste_tickets_number_unique')
      .on(t.numberKey)
      .where(
        sql`${t.operatorCounterpartyId} IS NULL AND ${t.numberKey} <> ''
            AND ${t.status} = 'confirmed' AND ${t.duplicateOverrideAt} IS NULL`,
      ),
    requestIdx: index('waste_tickets_request_idx').on(t.requestId),
    /**
     * Поиск похожего номера (Р16). Результат такого поиска всегда предупреждение, а не запрет:
     * сведение `О`/`0` и `A`/`А` — догадка, и запрещать по догадке нельзя.
     */
    numberFuzzyIdx: index('waste_tickets_number_fuzzy_idx').on(t.numberFuzzy),
  }),
);

/**
 * Предложение перераспознавания (Р13).
 *
 * Кнопка «перераспознать» не переписывает работу человека: `unconfirmed` без правки замещается
 * новыми значениями прямо в талоне, а подтверждённое, ручное и правленое не трогается — новое
 * чтение живёт здесь, пока человек не примет или не отклонит его.
 *
 * Хранится МАТЕРИАЛИЗОВАННЫЙ СНИМОК значений, а не одни ссылки на попытки: попытки, на которые не
 * ссылается талон, убираются по TTL, и предложение, собираемое из `raw`, в этот день молча
 * обнулилось бы. Ссылки на обе попытки каскада объявлены `SET NULL` намеренно — иначе непринятое
 * предложение держало бы сырьё вечно.
 */
export const wasteTicketProposals = pgTable(
  'waste_ticket_proposals',
  {
    /**
     * PK = FK: одно активное предложение на талон. Второе означало бы очередь предложений, а
     * человеку в ней пришлось бы разбирать не бумагу, а историю кнопки.
     */
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => wasteTickets.id, { onDelete: 'cascade' }),
    /**
     * Нормализованного ключа номера здесь нет намеренно: предложение номера не занимает. Принятие,
     * меняющее номер, идёт тем же путём, что обычная правка (Р27) — с блокировкой по
     * `(оператор, numberKey)` и повторной проверкой конфликта, а не в обход уникальности.
     */
    numberRaw: text('number_raw').notNull().default(''),
    issuedOn: date('issued_on', { mode: 'string' }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    workKind: text('work_kind').notNull().default('removal').$type<'removal' | 'idle' | 'other'>(),
    addressRaw: text('address_raw').notNull().default(''),
    primaryAttemptId: uuid('primary_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    escalationAttemptId: uuid('escalation_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    createdAt: createdAt(),
  },
  (t) => ({
    workKindCheck: check(
      'waste_ticket_proposals_work_kind_check',
      sql`${t.workKind} IN ('removal', 'idle', 'other')`,
    ),
    volumeCheck: check(
      'waste_ticket_proposals_volume_check',
      sql`${t.volumeM3} IS NULL OR ${t.volumeM3} >= 0`,
    ),
  }),
);

/**
 * Слепая перепроверка талона и арбитраж (Р31).
 *
 * Признак `confidence` метрикой не считается: модель уверена и когда ошибается. Разметка из работы
 * тоже неравноценна — правка сильный сигнал, подтверждение слабый. Поэтому второй человек читает
 * талон, НЕ ВИДЯ ни распознанного, ни подтверждённого, и его чтение сравнивается со снимком
 * машинного.
 *
 * Сама перепроверка не измеряет уверенные ошибки: она показывает, что два чтения разошлись, но не
 * говорит, кто прав. Атрибуция требует третьего разбора — арбитража, и в метрику идёт только
 * разобранное. Отсюда почти все ограничения ниже: они не дают объявить разобранным то, что не
 * разобрано, и не дают засчитать разбор там, где расхождения не было.
 */
export const wasteTicketBlindChecks = pgTable(
  'waste_ticket_blind_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => wasteTickets.id, { onDelete: 'cascade' }),
    /**
     * Пусто, пока задание не взято: строка заводится в момент попадания талона в выборку, иначе
     * состояния `pending` в реестре не существовало бы вовсе. Взятие атомарно проставляет
     * `checkerId` (`UPDATE … WHERE checker_id IS NULL RETURNING`), поэтому гонка двух проверяющих
     * разрешается в пользу первого, а второму реестр отдаёт следующий талон.
     */
    checkerId: uuid('checker_id').references(() => users.id),
    reviewNumberRaw: text('review_number_raw').notNull().default(''),
    /**
     * Ключ по Р16: номера сравниваются нормализованными, иначе «№ 12-34» и «12-34» уходили бы в
     * расхождение, и метрика ошибок OCR наполнялась бы разницей в пробелах.
     */
    reviewNumberKey: text('review_number_key').notNull().default(''),
    reviewIssuedOn: date('review_issued_on', { mode: 'string' }),
    reviewVolumeM3: numeric('review_volume_m3', { precision: 12, scale: 3 }),
    /**
     * СНИМОК машинного чтения на момент попадания в выборку, а не чтение талона по ссылке: талон
     * правят, и сравнение поехало бы задним числом — вчерашнее расхождение превратилось бы в
     * совпадение просто потому, что кто-то исправил цифру.
     */
    baselineNumberRaw: text('baseline_number_raw').notNull().default(''),
    baselineNumberKey: text('baseline_number_key').notNull().default(''),
    baselineIssuedOn: date('baseline_issued_on', { mode: 'string' }),
    baselineVolumeM3: numeric('baseline_volume_m3', { precision: 12, scale: 3 }),
    baselineFingerprint: char('baseline_fingerprint', { length: 64 }).notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'match' | 'mismatch' | 'arbitrated'>(),
    /**
     * Вердикта одним словом нет: правота бывает разной по полям — номер за машиной, дата за
     * человеком, объём мимо у обоих. Хранятся итоговые ЗНАЧЕНИЯ, а «кто прав» считается сравнением
     * с `review*` и `baseline*` по каждому полю отдельно.
     */
    finalNumberRaw: text('final_number_raw'),
    finalNumberKey: text('final_number_key'),
    finalIssuedOn: date('final_issued_on', { mode: 'string' }),
    finalVolumeM3: numeric('final_volume_m3', { precision: 12, scale: 3 }),
    /**
     * Какие поля арбитр разобрал. Отдельно от значений, потому что «верного значения нет» (объёма
     * на талоне не было вовсе) и «поле не разобрано» — разные вещи, а `NULL` их не различает.
     */
    resolvedFields: text('resolved_fields')
      .array()
      .notNull()
      .default(sql`'{}'`)
      .$type<('number' | 'issuedOn' | 'volumeM3')[]>(),
    arbiterId: uuid('arbiter_id').references(() => users.id),
    arbitratedAt: timestamp('arbitrated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    /**
     * Одна перепроверка на талон, а не по одной на человека: иначе «доля расхождений» зависела бы
     * от того, сколько людей позвали смотреть на один и тот же лист.
     */
    ticketUnique: unique('waste_ticket_blind_checks_ticket_unique').on(t.ticketId),
    statusCheck: check(
      'waste_ticket_blind_checks_status_check',
      sql`${t.status} IN ('pending', 'match', 'mismatch', 'arbitrated')`,
    ),
    /** Без проверяющего строка может быть только ожидающей: «совпало» с пустотой не совпадает. */
    pendingCheck: check(
      'waste_ticket_blind_checks_pending_check',
      sql`${t.checkerId} IS NOT NULL OR ${t.status} = 'pending'`,
    ),
    /**
     * Арбитр не проверяет сам себя: третий разбор затем и нужен, что двое уже высказались.
     * «Арбитр ≠ подтвердивший талон» держит сервис — подзапрос в `CHECK` невозможен.
     */
    arbiterCheck: check(
      'waste_ticket_blind_checks_arbiter_check',
      sql`${t.arbiterId} IS NULL OR ${t.arbiterId} <> ${t.checkerId}`,
    ),
    /**
     * Статус обязан соответствовать ФАКТИЧЕСКОМУ сравнению. Иначе совпавшую строку можно объявить
     * разобранной и подмешать в метрику разбор, которого не было, — а метрика для того и заведена,
     * чтобы ей верили без пересчёта.
     */
    matchCheck: check(
      'waste_ticket_blind_checks_match_check',
      sql`${t.status} <> 'match' OR (
            ${t.baselineNumberKey} IS NOT DISTINCT FROM ${t.reviewNumberKey}
        AND ${t.baselineIssuedOn} IS NOT DISTINCT FROM ${t.reviewIssuedOn}
        AND ${t.baselineVolumeM3} IS NOT DISTINCT FROM ${t.reviewVolumeM3})`,
    ),
    mismatchCheck: check(
      'waste_ticket_blind_checks_mismatch_check',
      sql`${t.status} NOT IN ('mismatch', 'arbitrated') OR (
            ${t.baselineNumberKey} IS DISTINCT FROM ${t.reviewNumberKey}
         OR ${t.baselineIssuedOn} IS DISTINCT FROM ${t.reviewIssuedOn}
         OR ${t.baselineVolumeM3} IS DISTINCT FROM ${t.reviewVolumeM3})`,
    ),
    /**
     * Разобрать можно только то, что разошлось. `<> ALL`, а не `<> ANY`: нужно «этого имени нет в
     * массиве», а `ANY` означало бы «отличается хотя бы от одного его элемента» — и совпавшее поле
     * проходило бы проверку за счёт соседнего, разошедшегося.
     */
    resolvedDiffCheck: check(
      'waste_ticket_blind_checks_resolved_diff_check',
      sql`('number' <> ALL(${t.resolvedFields})
             OR ${t.baselineNumberKey} IS DISTINCT FROM ${t.reviewNumberKey})
      AND ('issuedOn' <> ALL(${t.resolvedFields})
             OR ${t.baselineIssuedOn} IS DISTINCT FROM ${t.reviewIssuedOn})
      AND ('volumeM3' <> ALL(${t.resolvedFields})
             OR ${t.baselineVolumeM3} IS DISTINCT FROM ${t.reviewVolumeM3})`,
    ),
    /** «Кто разобрал» и «когда» появляются ровно вместе со статусом разбора, в обе стороны. */
    arbitrationCheck: check(
      'waste_ticket_blind_checks_arbitration_check',
      sql`(${t.status} = 'arbitrated') = (${t.arbiterId} IS NOT NULL)
          AND (${t.status} = 'arbitrated') = (${t.arbitratedAt} IS NOT NULL)`,
    ),
    /**
     * До арбитража итогов нет вовсе: значение, вписанное в неразобранную строку, — это чужое
     * мнение, выданное за решение.
     */
    noFinalCheck: check(
      'waste_ticket_blind_checks_no_final_check',
      sql`${t.status} = 'arbitrated' OR (${t.resolvedFields} = '{}'
          AND ${t.finalNumberRaw} IS NULL AND ${t.finalIssuedOn} IS NULL
          AND ${t.finalVolumeM3} IS NULL)`,
    ),
    /**
     * В массив попадают только имена полей талона: опечатка тихо вывела бы поле из всех проверок
     * ниже, потому что ни одна из них про несуществующее имя ничего не утверждает.
     */
    resolvedDomainCheck: check(
      'waste_ticket_blind_checks_resolved_domain_check',
      sql`${t.resolvedFields} <@ ARRAY['number', 'issuedOn', 'volumeM3']::text[]`,
    ),
    /** Итог пишется только для разобранного поля: значение без разбора — тихая выдумка. */
    finalResolvedCheck: check(
      'waste_ticket_blind_checks_final_resolved_check',
      sql`(${t.finalNumberRaw} IS NULL OR 'number' = ANY(${t.resolvedFields}))
      AND (${t.finalIssuedOn} IS NULL OR 'issuedOn' = ANY(${t.resolvedFields}))
      AND (${t.finalVolumeM3} IS NULL OR 'volumeM3' = ANY(${t.resolvedFields}))`,
    ),
    /**
     * Дословный итог и его ключ ходят парой: по ключу считается «кто прав по номеру», и итог без
     * ключа выпал бы из метрики, оставшись видимым в интерфейсе.
     */
    finalKeyCheck: check(
      'waste_ticket_blind_checks_final_key_check',
      sql`(${t.finalNumberKey} IS NULL) = (${t.finalNumberRaw} IS NULL)`,
    ),
    /**
     * Разобрано должно быть КАЖДОЕ разошедшееся поле: частично закрытая строка хуже неразобранной,
     * потому что выглядит законченной и уходит из реестра разбора.
     */
    arbitratedCompleteCheck: check(
      'waste_ticket_blind_checks_arbitrated_complete_check',
      sql`${t.status} <> 'arbitrated' OR (
            (${t.baselineNumberKey} IS NOT DISTINCT FROM ${t.reviewNumberKey}
               OR 'number' = ANY(${t.resolvedFields}))
        AND (${t.baselineIssuedOn} IS NOT DISTINCT FROM ${t.reviewIssuedOn}
               OR 'issuedOn' = ANY(${t.resolvedFields}))
        AND (${t.baselineVolumeM3} IS NOT DISTINCT FROM ${t.reviewVolumeM3}
               OR 'volumeM3' = ANY(${t.resolvedFields})))`,
    ),
    fingerprintCheck: check(
      'waste_ticket_blind_checks_fingerprint_check',
      sql`${t.baselineFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    /** Реестры: «что ждёт проверяющего» и «что ждёт арбитра» — два вопроса к одной колонке. */
    statusIdx: index('waste_ticket_blind_checks_status_idx').on(t.status, t.createdAt),
  }),
);

/**
 * Принятое расхождение (Р21).
 *
 * Материализуется РЕШЕНИЕ, а не замечание. Само замечание остаётся вычисляемым — иначе разойдётся
 * с талонами на первой же правке. А «принимаю расхождение» хранится с ОТПЕЧАТКОМ ВХОДА: код
 * проверки, набор подтверждённых талонов, фактический объём, `removedOn`, заявленный объём,
 * `deliveryAt`, область оператора, действующие допуски и версия алгоритма проверок. Изменилась
 * любая из величин — принятие перестаёт действовать само, и замечание возвращается.
 *
 * Без отпечатка «принято» означало бы «замолчать навсегда» — в том числе про расхождение, которого
 * в момент принятия не было и которое появилось потом.
 */
/**
 * Журнал распознавания и разбора: событие на ПОЛЕ (ADR 0114, Р30/Р31, миграция 0206).
 *
 * Отвечает на вопрос, которого не знает ни одна соседняя таблица: что стало с тем, что прочитала
 * модель. Попытка помнит ответ, но не знает, приняли его или переписали; талон помнит только
 * последнее значение — прежнее затирается правкой; общий `audit_log` фиксирует факт («правили
 * объём»), но не значения, и по нему нельзя ответить, как часто модель путает 38 с 3.
 *
 * Подтверждение здесь не пишется намеренно: человек смотрит на подставленное значение и склонен
 * согласиться, так что «подтверждено» не значит «прочитано верно» (Р31). Знаменатель берётся по
 * `recognized`.
 */
export const wasteTicketFieldEvents = pgTable(
  'waste_ticket_field_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Обнуляемые ссылки: строка живёт дольше и заявки, и талона — качество модели свойство листа. */
    ticketId: uuid('ticket_id').references(() => wasteTickets.id, { onDelete: 'set null' }),
    requestId: uuid('request_id').references(() => wasteRequests.id, { onDelete: 'set null' }),
    /** Хэш растра: единственная связь, переживающая уборку заявки, — по нему находится попытка. */
    pageSha256: char('page_sha256', { length: 64 }).notNull().default(''),
    event: text('event')
      .notNull()
      .$type<
        | 'recognized'
        | 'disputed'
        | 'edited'
        | 'proposal'
        | 'proposal_dismissed'
        | 'arbitrated'
        | 'dismissed'
      >(),
    field: text('field').notNull().$type<WasteTicketField>(),
    /** Значения текстом, как показаны человеку: «3» и «38» различимы, `null` и «» — тоже. */
    oldValue: text('old_value'),
    newValue: text('new_value'),
    model: text('model').notNull().default(''),
    modelReported: text('model_reported').notNull().default(''),
    promptVersion: integer('prompt_version'),
    preprocessingVersion: integer('preprocessing_version'),
    /** Проходов каскада по странице: 1 — только дешёвая, 2 — с эскалацией (Р14). */
    passes: smallint('passes').notNull().default(0),
    escalated: boolean('escalated').notNull().default(false),
    /**
     * Наблюдение, к которому адресовано человеческое событие: одно машинное чтение одного поля.
     * `RESTRICT` — удаление основания метрики отдельное решение, а не следствие чужой уборки.
     */
    observationId: uuid('observation_id').references((): AnyPgColumn => wasteTicketFieldEvents.id, {
      onDelete: 'restrict',
    }),
    /** Прочитано, не прочитано или неприменимо — считается ПОСЛЕ слияния проходов. */
    readState: text('read_state').$type<'read' | 'unreadable' | 'not_applicable'>(),
    /** Откуда итоговое значение: `merged` — оба прохода сошлись, у спора ступени нет. */
    sourceStage: text('source_stage').$type<'primary' | 'escalation' | 'merged'>(),
    /*
     * Три ссылки: у спора и слияния участвуют две попытки. Все `SET NULL` — попытки убираются по
     * сроку, и `RESTRICT` сломал бы уборку; поэтому рядом снимки моделей, иначе когорта прошлого
     * года осталась бы без имени модели.
     */
    primaryAttemptId: uuid('primary_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    escalationAttemptId: uuid('escalation_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    /** Попытка, давшая итог; пусто у `merged` и спора — там ступень не одна. */
    selectedAttemptId: uuid('selected_attempt_id').references(
      () => wasteTicketRecognitionAttempts.id,
      { onDelete: 'set null' },
    ),
    primaryModelReported: text('primary_model_reported').notNull().default(''),
    escalationModelReported: text('escalation_model_reported').notNull().default(''),
    /** Оба кандидата: без них не сказать, какая ступень была права. */
    primaryValue: text('primary_value'),
    escalationValue: text('escalation_value'),
    /** Куда смотреть человеку: ссылка переживает обнуление `ticketId`, разбор без скана бессмыслен. */
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    pageNo: smallint('page_no'),
    /** Разбор как единица работы и признак, что вызова к прокси не было. */
    recognitionRunId: uuid('recognition_run_id'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    /** Отличалось ли поле предложения от талона В МОМЕНТ ЧТЕНИЯ (план, §1.2.2). */
    proposalDiffers: boolean('proposal_differs'),
    /** Версия сбора: собранное до словаря метрик остаётся единицей и в метрики не идёт. */
    collectionVersion: smallint('collection_version').notNull().default(2),
    /** `null` у машинных событий: их совершила модель, а не человек. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    idFieldUnique: unique('waste_ticket_field_events_id_field_key').on(t.id, t.field),
    observationIdx: index('waste_ticket_field_events_observation_idx')
      .on(t.observationId)
      .where(sql`${t.observationId} IS NOT NULL`),
    editedIdx: index('waste_ticket_field_events_edited_idx')
      .on(t.field, t.createdAt.desc())
      .where(sql`${t.event} = 'edited'`),
    modelIdx: index('waste_ticket_field_events_model_idx').on(
      t.modelReported,
      t.field,
      t.createdAt.desc(),
    ),
    ticketIdx: index('waste_ticket_field_events_ticket_idx')
      .on(t.ticketId, t.createdAt)
      .where(sql`${t.ticketId} IS NOT NULL`),
    createdIdx: index('waste_ticket_field_events_created_idx').on(t.createdAt),
    eventCheck: check(
      'waste_ticket_field_events_event_check',
      sql`${t.event} IN ('recognized', 'disputed', 'edited', 'proposal', 'proposal_dismissed', 'arbitrated', 'dismissed')`,
    ),
    readStateCheck: check(
      'waste_ticket_field_events_read_state_check',
      sql`${t.readState} IS NULL OR ${t.readState} IN ('read', 'unreadable', 'not_applicable')`,
    ),
    sourceStageCheck: check(
      'waste_ticket_field_events_source_stage_check',
      sql`${t.sourceStage} IS NULL OR ${t.sourceStage} IN ('primary', 'escalation', 'merged')`,
    ),
    collectionVersionCheck: check(
      'waste_ticket_field_events_collection_version_check',
      sql`${t.collectionVersion} >= 1`,
    ),
    /*
     * Инварианты второй версии. Условие по версии — не оговорка ради удобства: прежние события
     * собраны другим кодом, и требуй мы от них признака прочтения, ограничение упало бы на
     * собственной истории, а починить её задним числом нечем.
     */
    v2ReadStateCheck: check(
      'waste_ticket_field_events_v2_read_state_check',
      sql`${t.collectionVersion} < 2 OR ${t.event} NOT IN ('recognized', 'disputed') OR ${t.readState} IS NOT NULL`,
    ),
    v2ProposalCheck: check(
      'waste_ticket_field_events_v2_proposal_check',
      sql`${t.collectionVersion} < 2 OR (${t.event} IN ('proposal', 'proposal_dismissed')) = (${t.proposalDiffers} IS NOT NULL)`,
    ),
    /** Наблюдение — только машинное чтение: человеческое событие основанием метрики не бывает. */
    observationSelfCheck: check(
      'waste_ticket_field_events_observation_self_check',
      sql`${t.observationId} IS NULL OR ${t.event} NOT IN ('recognized', 'disputed')`,
    ),
    fieldCheck: check(
      'waste_ticket_field_events_field_check',
      sql`${t.field} IN ('number', 'issuedOn', 'volumeM3', 'workKind', 'addressRaw')`,
    ),
    /*
     * Очистка поля — тоже правка: талон простоя объёма не несёт, и «стало пусто» здесь законный
     * исход. Запрещено только событие, пустое с обеих сторон: это строка ни о чём (0210).
     */
    editCheck: check(
      'waste_ticket_field_events_edit_check',
      sql`${t.event} <> 'edited' OR ${t.oldValue} IS NOT NULL OR ${t.newValue} IS NOT NULL`,
    ),
    /*
     * Только одна сторона: машинное событие человека не называет. Обратное проверять нельзя —
     * ссылка обнуляется при удалении учётки, и двусторонний `CHECK` запрещал бы кадровые действия
     * ради журнала качества.
     */
    actorCheck: check(
      'waste_ticket_field_events_actor_check',
      sql`${t.event} NOT IN ('recognized', 'disputed') OR ${t.actorId} IS NULL`,
    ),
    passesCheck: check(
      'waste_ticket_field_events_passes_check',
      sql`${t.passes} BETWEEN 0 AND 2`,
    ),
    shaCheck: check(
      'waste_ticket_field_events_sha_check',
      sql`${t.pageSha256} = '' OR ${t.pageSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

/*
 * Связи наблюдений: чем адресовано решение человека, когда чтения в талоне уже нет.
 *
 * Правило «последнее наблюдение по талону и полю» годится для правки и снятия, но не для этих
 * двух: предложение живёт отдельной строкой со своими попытками, а перепроверка сравнивает
 * `baseline_*`, снятый в момент отбора. Между отбором и арбитражем талон мог смениться дважды —
 * и «последнее» приписало бы ошибку не той модели.
 *
 * Обе таблицы временные по природе: живут, пока живы владельцы. Исход к моменту удаления уже
 * закреплён событием, поэтому `CASCADE` на владельце безопасен, а `RESTRICT` на наблюдении
 * обязателен.
 */
export const wasteTicketProposalObservations = pgTable(
  'waste_ticket_proposal_observations',
  {
    proposalTicketId: uuid('proposal_ticket_id')
      .notNull()
      .references(() => wasteTicketProposals.ticketId, { onDelete: 'cascade' }),
    field: text('field').notNull().$type<WasteTicketField>(),
    observationId: uuid('observation_id').notNull(),
    /**
     * Отличалось ли поле от талона в момент чтения. Пять строк на предложение, а не только
     * отличавшиеся: без строки на совпавшее поле его нечем будет назвать `uninformative`.
     */
    differs: boolean('differs').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.proposalTicketId, t.field] }),
    fieldCheck: check(
      'waste_ticket_proposal_observations_field_check',
      sql`${t.field} IN ('number', 'issuedOn', 'volumeM3', 'workKind', 'addressRaw')`,
    ),
    /** Составной ключ доказывает, что связь указывает на наблюдение ТОГО ЖЕ поля. */
    observationFk: foreignKey({
      columns: [t.observationId, t.field],
      foreignColumns: [wasteTicketFieldEvents.id, wasteTicketFieldEvents.field],
      name: 'waste_ticket_proposal_observations_observation_fk',
    }).onDelete('restrict'),
    observationIdx: index('waste_ticket_proposal_observations_observation_idx').on(t.observationId),
  }),
);

export const wasteTicketBlindCheckObservations = pgTable(
  'waste_ticket_blind_check_observations',
  {
    blindCheckId: uuid('blind_check_id')
      .notNull()
      .references(() => wasteTicketBlindChecks.id, { onDelete: 'cascade' }),
    field: text('field').notNull().$type<WasteTicketBlindCheckField>(),
    observationId: uuid('observation_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blindCheckId, t.field] }),
    /** Перепроверка меряет чтение рукописи, а не разметку бланка: вида работ и адреса в ней нет. */
    fieldCheck: check(
      'waste_ticket_blind_check_observations_field_check',
      sql`${t.field} IN ('number', 'issuedOn', 'volumeM3')`,
    ),
    observationFk: foreignKey({
      columns: [t.observationId, t.field],
      foreignColumns: [wasteTicketFieldEvents.id, wasteTicketFieldEvents.field],
      name: 'waste_ticket_blind_check_observations_observation_fk',
    }).onDelete('restrict'),
    observationIdx: index('waste_ticket_blind_check_observations_observation_idx').on(
      t.observationId,
    ),
  }),
);

export const wasteTicketCheckResolutions = pgTable(
  'waste_ticket_check_resolutions',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => wasteRequests.id, { onDelete: 'cascade' }),
    /**
     * `duplicate_number`, `volume_mismatch`, `date_mismatch`, `address_mismatch`, … Набор НЕ закрыт
     * `CHECK` намеренно: проверки заводятся кодом, и каждая новая стоила бы миграции — притом что
     * закрытый набор здесь ничего не защищает, принятие с неизвестным кодом просто ни к чему не
     * привяжется и ничего не погасит.
     */
    checkCode: text('check_code').notNull(),
    /**
     * Id талона для построчных проверок, `''` — для заявочных. Пустая строка, а не `NULL`, потому
     * что колонка входит в первичный ключ: `NULL` в нём означал бы, что заявочное принятие можно
     * записать дважды.
     */
    subjectKey: text('subject_key').notNull().default(''),
    inputFingerprint: char('input_fingerprint', { length: 64 }).notNull(),
    /**
     * Удаление учётки запрещено умолчанием (`NO ACTION`): «кто принял расхождение» обязано пережить
     * увольнение — иначе принятие осталось бы решением без принявшего, а это и есть та самая
     * тишина, от которой отпечаток защищает.
     */
    acceptedBy: uuid('accepted_by')
      .notNull()
      .references(() => users.id),
    comment: text('comment').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Одно принятие на «заявка + проверка + предмет»: повторное принятие того же расхождения
     * переписывает строку вместе с отпечатком, а не копится историей молчания.
     */
    pk: primaryKey({
      name: 'waste_ticket_check_resolutions_pk',
      columns: [t.requestId, t.checkCode, t.subjectKey],
    }),
    checkCodeCheck: check(
      'waste_ticket_check_resolutions_check_code_check',
      sql`btrim(${t.checkCode}) <> ''`,
    ),
    /**
     * Причина обязательна и непуста: принятие расхождения — ответ человека на вопрос «почему цифры
     * не сходятся», и пустая строка означала бы, что вопрос закрыли, не ответив.
     */
    commentCheck: check(
      'waste_ticket_check_resolutions_comment_check',
      sql`btrim(${t.comment}) <> ''`,
    ),
    fingerprintCheck: check(
      'waste_ticket_check_resolutions_fingerprint_check',
      sql`${t.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

// ── История статусов заявки ──
export const requestStatusHistory = pgTable('request_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => wasteRequests.id, { onDelete: 'cascade' }),
  fromStatus: requestStatusEnum('from_status'),
  toStatus: requestStatusEnum('to_status').notNull(),
  changedBy: uuid('changed_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  // Комментарий к переходу; при отмене — обязательная причина (миграция 0024).
  comment: text('comment').notNull().default(''),
});

// ── Заявки на технику (заказ спецтехники / грузоперевозки) ──
// Единая base-таблица + две detail-таблицы (по типу). «Ровно одна деталь нужного
// типа» на этапе каркаса обеспечивается сервисной транзакцией; constraint-триггер —
// в бэклоге (аддитивная миграция, форму таблиц не меняет).
export const vehicleRequests = pgTable(
  'vehicle_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Сквозной человекочитаемый номер (отображается как «ТС-123»).
    num: integer('num').generatedAlwaysAsIdentity(),
    requestType: vehicleRequestTypeEnum('request_type').notNull(),
    // Заказчик заявки (ADR 0040, миграция 0069): объект строительства **или** отдел, ровно один
    // (CHECK `vehicle_requests_customer_check`). Отдел с объектами не пересекается — снабжение
    // везёт материалы на склад, площадки у такой заявки нет вовсе, — поэтому вторая колонка
    // вместо первой, а не рядом с ней.
    objectId: uuid('object_id').references(() => constructionObjects.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    // Заказанный тип ТС (плоская модель, ADR 0005).
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    // Категория заказанного типа (ADR 0028, миграция 0052): «Автокраны, г/п 130 т». Пусто —
    // у типа категорий нет («Ямобур») либо заявка заведена до появления колонки. Обязательность
    // решает сервер: есть ли у типа активные категории, видно только ему.
    vehicleCategoryId: uuid('vehicle_category_id'),
    status: requestStatusEnum('status').notNull().default('new'),
    comment: text('comment').notNull().default(''),
    // Виза руководителя строительства (ADR 0025, миграция 0049): без неё заявку не берут в
    // работу. Заполнены обе колонки или ни одной (CHECK vehicle_requests_approval_check).
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /*
     * Снимок режима, застигнутого переключением признака «Линейная техника» у заказанного типа
     * (миграция 0137). NULL — норма ADR 0100 §1: признак читается живым из справочника.
     * Заполнено — заявка была в работе, когда признак типа переключили, и дорабатывает по
     * записанному значению; снимается уходом из «В работе».
     *
     * Читать напрямую нельзя: режим заявки — это `requestIsLinearSql` / `requestIsLinear`
     * (`src/db/linear-mode.ts`), и второе место, решающее «днями или неделями», разойдётся с
     * первым на первой же правке. Колонки временные — условие их смерти в комментарии миграции.
     */
    isLinearFrozen: boolean('is_linear_frozen'),
    linearFrozenAt: timestamp('linear_frozen_at', { withTimezone: true }),
    /**
     * Готовность истории назначения (миграция 0166, план `docs/assignment-periods-plan.md` §6).
     *
     * Три состояния, а не флаг (Р26): `materialized` означает «строки истории есть, но валидности
     * нет», и ленивый пересчёт в нём ничего не пересобирает. Предикат cutover читает именно эту
     * колонку. Пишет их этап 3 — сегодня у всех заявок `empty`.
     */
    assignmentHistoryState: text('assignment_history_state')
      .$type<AssignmentHistoryState>()
      .notNull()
      .default('empty'),
    /**
     * День, на который состояние считалось. Это не `asOf` запроса: календарь двигает валидность
     * истории сам, без всякой двери (З1), и «посчитано сегодня» — единственное, что делает
     * состояние пригодным для решения о бумаге. Пусто тогда и только тогда, когда состояние
     * `empty` (CHECK `vehicle_requests_history_state_check`, добавлен `NOT VALID` по Р2).
     */
    assignmentHistoryValidatedOn: date('assignment_history_validated_on', { mode: 'string' }),
    /**
     * Загрязнение внутри дня (К4): двери, разрешённые в `history_frozen`, меняют отменяемость
     * бумаги, а `validated_on` при этом остаётся сегодняшним и ленивое правило устаревания молчит.
     */
    assignmentHistoryDirty: boolean('assignment_history_dirty').notNull().default(false),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numUnique: uniqueIndex('vehicle_requests_num_unique').on(t.num),
    // Состояние `empty` и день расчёта — одно и то же утверждение с двух сторон (миграция 0166).
    assignmentHistoryStateValues: check(
      'vehicle_requests_assignment_history_state_check',
      sql`${t.assignmentHistoryState} IN ('empty', 'materialized', 'ready')`,
    ),
    assignmentHistoryStatePresence: check(
      'vehicle_requests_history_state_check',
      sql`(${t.assignmentHistoryState} = 'empty') = (${t.assignmentHistoryValidatedOn} is null)`,
    ),
    // Пара честна или пуста целиком (миграция 0137): половина снимка не отвечает ни на «как
    // ведётся», ни на «с какого числа».
    linearFrozenPresence: check(
      'vehicle_requests_linear_frozen_check',
      sql`(${t.isLinearFrozen} is null) = (${t.linearFrozenAt} is null)`,
    ),
    linearFrozenIdx: index('vehicle_requests_linear_frozen_idx')
      .on(t.vehicleTypeId)
      .where(sql`${t.isLinearFrozen} is not null`),
    // Цель составного FK из vehicle_request_assignments (ADR 0027): пока на заявке стоит машина,
    // тип ТС у неё не уедет в сторону от назначенного.
    idTypeUnique: unique('vehicle_requests_id_type_unique').on(t.id, t.vehicleTypeId),
    // Категория чужого типа невозможна физически (ADR 0028) — тем же приёмом, что и у машины.
    // RESTRICT: пока на категорию ссылается заявка, из справочника её не удалить.
    categoryTypeFk: foreignKey({
      columns: [t.vehicleCategoryId, t.vehicleTypeId],
      foreignColumns: [vehicleCategories.id, vehicleCategories.vehicleTypeId],
      name: 'vehicle_requests_category_type_fk',
    }).onDelete('restrict'),
    approvalPresence: check(
      'vehicle_requests_approval_check',
      sql`(${t.approvedBy} is null) = (${t.approvedAt} is null)`,
    ),
    // Заказчик ровно один (ADR 0040): двое дали бы два ответа на «кто визирует», ноль — ничью
    // заявку.
    customerPresence: check(
      'vehicle_requests_customer_check',
      sql`num_nonnulls(${t.objectId}, ${t.departmentId}) = 1`,
    ),
    // У отдела бывают только грузоперевозки: спецтехника выходит на площадку, а её у отдела нет.
    departmentFreightOnly: check(
      'vehicle_requests_department_freight_check',
      sql`${t.departmentId} is null or ${t.requestType} = 'freight_transport'`,
    ),
    departmentIdx: index('vehicle_requests_department_idx')
      .on(t.departmentId)
      .where(sql`${t.departmentId} is not null`),
    departmentAwaitingApprovalIdx: index('vehicle_requests_department_awaiting_approval_idx')
      .on(t.departmentId)
      .where(
        sql`${t.approvedAt} is null and ${t.deletedAt} is null and ${t.departmentId} is not null`,
      ),
    // «Что ждёт визы» — главный вопрос к таблице после её появления (миграция 0049).
    awaitingApprovalIdx: index('vehicle_requests_awaiting_approval_idx')
      .on(t.objectId)
      .where(sql`${t.approvedAt} is null and ${t.deletedAt} is null`),
    objectIdx: index('vehicle_requests_object_idx').on(t.objectId),
    typeIdx: index('vehicle_requests_request_type_idx').on(t.requestType),
    statusIdx: index('vehicle_requests_status_idx').on(t.status),
    vehicleTypeIdx: index('vehicle_requests_vehicle_type_idx').on(t.vehicleTypeId),
    // «Какие заявки на эту категорию» — вопрос со стороны справочника (ADR 0028).
    vehicleCategoryIdx: index('vehicle_requests_vehicle_category_idx')
      .on(t.vehicleCategoryId)
      .where(sql`${t.vehicleCategoryId} is not null`),
    createdAtIdx: index('vehicle_requests_created_at_idx').on(t.createdAt),
    deletedAtIdx: index('vehicle_requests_deleted_at_idx').on(t.deletedAt),
    objectStatusIdx: index('vehicle_requests_object_status_idx').on(t.objectId, t.status),
    typeStatusIdx: index('vehicle_requests_type_status_idx').on(t.requestType, t.status),
  }),
);

// Детали заказа спецтехники: период date-only (без времени; date_to пусто = один день).
export const specialEquipmentRequestDetails = pgTable(
  'special_equipment_request_details',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    dateFrom: date('date_from', { mode: 'string' }).notNull(),
    dateTo: date('date_to', { mode: 'string' }),
    // Кто встречает технику на объекте (миграция 0062); пусто — заявка старше колонки. Телефон —
    // десять цифр без кода страны (ADR 0066, миграция 0095).
    responsibleName: text('responsible_name').notNull().default(''),
    responsiblePhone: text('responsible_phone').notNull().default(''),
  },
  (t) => ({
    dateOrder: check(
      'special_equipment_date_order_check',
      sql`${t.dateTo} is null or ${t.dateTo} >= ${t.dateFrom}`,
    ),
    dateFromIdx: index('special_equipment_date_from_idx').on(t.dateFrom),
    dateToIdx: index('special_equipment_date_to_idx').on(t.dateTo),
  }),
);

/**
 * Детали грузоперевозки: то, что описывает ЗАКАЗ ЦЕЛИКОМ, — и только оно.
 *
 * Адреса, количество и контакты уехали отсюда на ездку (миграция 0136): держать их здесь стало
 * нечем — у заявки с ездками A→B и A→C «адрес разгрузки заявки» не существует. Осталось время
 * подачи: им считается дата маршрута, им отбираются списки, по нему проверяются рабочее окно и
 * минимальная дата.
 */
export const freightTransportRequestDetails = pgTable(
  'freight_transport_request_details',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    // Время не задано — в scheduledAt значима только дата (00:00 МСК). См. 0020.
    scheduledTimeUnspecified: boolean('scheduled_time_unspecified').notNull().default(false),
  },
  (t) => ({
    scheduledIdx: index('freight_scheduled_at_idx').on(t.scheduledAt),
  }),
);

/**
 * Ездка заявки на грузоперевозку (миграция 0136, план `docs/route-trips-plan.md` Р1): пара
 * адресов, количество и контакты ОДНОЙ поездки.
 *
 * Строка заявки, а не маршрута: «ТС-40/2» существует и до того, как заявку положили в рейс, и
 * после того, как рейс пересобрали. `requestId` колонкой, а не связкой — у ездки ровно одна
 * заявка, и второй у неё не бывает.
 */
export const vehicleRequestTrips = pgTable(
  'vehicle_request_trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    /**
     * Номер внутри заявки: «ТС-40/2». Неизменяем и НЕ переиспользуется после мягкого удаления
     * (Р13а) — иначе «ТС-40/2» в старом листе и «ТС-40/2» в новом означали бы разное.
     */
    num: smallint('num').notNull(),
    fromLocation: text('from_location').notNull(),
    toLocation: text('to_location').notNull(),
    /** Метаданные верификации адреса (ADR 0006, ADR 0069); NULL = введён вручную. */
    fromAddress: jsonb('from_address').$type<AddressMeta>(),
    toAddress: jsonb('to_address').$type<AddressMeta>(),
    /**
     * Количество ЭТОЙ ездки, а не всей заявки: у заявки с ездками A→B и A→C общего количества не
     * существует, итог по ней считается суммой. CHECK «объём или масса заполнены» здесь не стоит:
     * у легкового количества может не быть вовсе, и обязательность остаётся условной, серверной.
     */
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    weightTons: numeric('weight_tons', { precision: 12, scale: 3 }),
    /**
     * Контакт на каждом конце: грузят и принимают разные люди в разных местах (приём миграции
     * 0062). Пусто — законное состояние: у заявок старше 0062 контакта нет вовсе. Телефон —
     * десять цифр без кода страны (ADR 0066).
     */
    fromResponsibleName: text('from_responsible_name').notNull().default(''),
    fromResponsiblePhone: text('from_responsible_phone').notNull().default(''),
    toResponsibleName: text('to_responsible_name').notNull().default(''),
    toResponsiblePhone: text('to_responsible_phone').notNull().default(''),
    /**
     * Своё время подачи; NULL — «как у заявки» (Р3): шесть ездок за смену едут по графику, а не
     * одновременно. Отвечать на «когда» списком и фильтрами продолжает заявка.
     */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    comment: text('comment').notNull().default(''),
    /**
     * Мягкое удаление (Р13а). Ездку, побывавшую в выданном листе, снести нельзя — на неё
     * ссылается `waybillTrips` с RESTRICT, — но аннулирование листа размораживает маршрут, и
     * диспетчер вправе пересобрать день, в том числе убрав ездку. Удалённая не участвует в
     * раскладке, не печатается и не считается в ёмкость, но видна из журнала листов и истории.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    // Номер в заявке единственный. Он же и есть индекс «ездки этой заявки по порядку»: отдельного
    // индекса `(request_id, num)` не нужно — уникальное ограничение создаёт ровно его.
    numUnique: unique('vehicle_request_trips_num_unique').on(t.requestId, t.num),
    // Цель составного FK из связки точки (`vehicleRoutePointTrips`): «ездка из своей заявки» —
    // физический факт. Индекс под ним дублирует первичный ключ, и иначе нельзя: PostgreSQL
    // требует, чтобы цель составного FK была уникальна именно этим набором колонок.
    idRequestUnique: unique('vehicle_request_trips_id_request_unique').on(t.id, t.requestId),
    fromNotBlank: check(
      'vehicle_request_trips_from_not_blank_check',
      sql`btrim(${t.fromLocation}) <> ''`,
    ),
    toNotBlank: check(
      'vehicle_request_trips_to_not_blank_check',
      sql`btrim(${t.toLocation}) <> ''`,
    ),
    volumePositive: check(
      'vehicle_request_trips_volume_positive_check',
      sql`${t.volumeM3} is null or ${t.volumeM3} > 0`,
    ),
    weightPositive: check(
      'vehicle_request_trips_weight_positive_check',
      sql`${t.weightTons} is null or ${t.weightTons} > 0`,
    ),
    // Форма метаданных адреса — та же, что держали снятые миграцией 0136 `freight_*_address_shape_check`
    // (0013): объект с обязательным ключом `source`, структуру внутри проверяет Zod.
    fromAddressShape: check(
      'vehicle_request_trips_from_address_shape_check',
      sql`${t.fromAddress} is null or (jsonb_typeof(${t.fromAddress}) = 'object' and ${t.fromAddress} ? 'source')`,
    ),
    toAddressShape: check(
      'vehicle_request_trips_to_address_shape_check',
      sql`${t.toAddress} is null or (jsonb_typeof(${t.toAddress}) = 'object' and ${t.toAddress} ? 'source')`,
    ),
  }),
);

// Техника, которой заявку взяли в работу (ADR 0027, миграция 0051). Одна заявка — одна машина,
// поэтому request_id и есть первичный ключ: заявка заказывает один тип ТС на один срок, и второй
// машины в ней нет. Ставки — снимок договорённости по этой заявке: их подставляют из предложения
// аренды, но правят свободно, и прайс справочника их потом не переписывает.
export const vehicleRequestAssignments = pgTable(
  'vehicle_request_assignments',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id').notNull(),
    // Служебная: копия типа ТС **машины** (миграция 0083). Существует ради составного FK на
    // технику — им «в назначении записан тип той машины, которая назначена» становится
    // физическим. С заказанным типом заявки совпадать не обязана: заявку закрывают тем, что есть
    // в парке, а расхождение портал помечает (ADR 0059). Не читается ни одним запросом: тип
    // назначенной машины выбирается из самой `vehicles`, здесь он только цель ключа.
    vehicleTypeId: uuid('vehicle_type_id').notNull(),
    // Копия ЗАКАЗАННОГО типа — цель второго составного FK: пока на заявке стоит машина, сменить
    // заказанный тип нельзя (ADR 0028 §9). Nullable до contract-миграции: строки, созданные
    // откатанным на предыдущий релиз кодом, её не заполняют.
    orderedVehicleTypeId: uuid('ordered_vehicle_type_id'),
    pricePerHour: numeric('price_per_hour', { precision: 12, scale: 2 }),
    pricePerShift: numeric('price_per_shift', { precision: 12, scale: 2 }),
    shiftHours: smallint('shift_hours'),
    // Водителя здесь нет: за рулём человек сидит не в заявке, а в рейсе — колонка уехала в
    // `vehicle_routes.driver_person_id` и удалена миграцией 0074. Три заявки одного дня едут
    // одной машиной с одним водителем, и держать его копию в каждой значило бы иметь три ответа
    // на один вопрос.
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Заказ заявки: каскад — назначение живёт ровно столько же, сколько сама заявка. ON UPDATE не
    // задан намеренно: смена типа ТС у заявки с назначенной машиной должна отклоняться, а не
    // тянуть за собой строку назначения (сервер отвечает на это 422 с объяснением).
    orderedTypeFk: foreignKey({
      columns: [t.requestId, t.orderedVehicleTypeId],
      foreignColumns: [vehicleRequests.id, vehicleRequests.vehicleTypeId],
      name: 'vehicle_request_assignments_ordered_type_fk',
    }).onDelete('cascade'),
    // Машина: restrict — назначенную технику из справочника не удаляют, на неё ссылается работа.
    // ON UPDATE CASCADE (миграция 0088, ADR 0061) — копия типа едет за машиной: переклассификация
    // машины в справочнике обычное дело, а копии нечем следовать за оригиналом, кроме каскада.
    // Прецедент тот же, что у `vehicles_lessor_fk` (ADR 0018). Заказанный тип заявки каскадом
    // НЕ ходит: у него свой ключ ниже, и смена заказа под назначением отклоняется словами.
    vehicleTypeFk: foreignKey({
      columns: [t.vehicleId, t.vehicleTypeId],
      foreignColumns: [vehicles.id, vehicles.vehicleTypeId],
      name: 'vehicle_request_assignments_vehicle_type_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    pricesPositive: check(
      'vehicle_request_assignments_prices_positive_check',
      sql`(${t.pricePerHour} IS NULL OR ${t.pricePerHour} > 0)
          AND (${t.pricePerShift} IS NULL OR ${t.pricePerShift} > 0)`,
    ),
    shiftHoursRange: check(
      'vehicle_request_assignments_shift_hours_range_check',
      sql`${t.shiftHours} IS NULL OR ${t.shiftHours} BETWEEN 1 AND 24`,
    ),
    // «Где сейчас эта машина» — вопрос к таблице со стороны справочника техники.
    vehicleIdx: index('vehicle_request_assignments_vehicle_idx').on(t.vehicleId),
  }),
);

// ── Факт выполнения заявки ТС (ADR 0029, миграция 0053) ──
// Назначение отвечает «чем и почём», закрытие — «сколько отработали и сколько это стоило».
// Одна заявка — одно закрытие: повторное (после отката администратором) переписывает строку.
export const vehicleRequestCompletions = pgTable(
  'vehicle_request_completions',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    workedUnit: vehicleWorkUnitEnum('worked_unit').notNull(),
    workedAmount: numeric('worked_amount', { precision: 10, scale: 2 }).notNull(),
    // Снимок ставки на момент закрытия: сумма обязана объясняться сама («26 ч × 2 500 ₽»),
    // а ставку назначения повторный перевод в работу может переписать.
    rate: numeric('rate', { precision: 12, scale: 2 }),
    totalCost: numeric('total_cost', { precision: 14, scale: 2 }),
    completedBy: uuid('completed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    workedAmountPositive: check(
      'vehicle_request_completions_worked_amount_positive_check',
      sql`${t.workedAmount} > 0`,
    ),
    ratePositive: check(
      'vehicle_request_completions_rate_positive_check',
      sql`${t.rate} IS NULL OR ${t.rate} > 0`,
    ),
    totalCostPositive: check(
      'vehicle_request_completions_total_cost_positive_check',
      sql`${t.totalCost} IS NULL OR ${t.totalCost} >= 0`,
    ),
    // «Что закрыли за период и на какую сумму» — вопрос вкладки «История» ко всем закрытиям.
    completedAtIdx: index('vehicle_request_completions_completed_at_idx').on(t.completedAt.desc()),
  }),
);

// ── Досрочное завершение заказа спецтехники (ADR 0044, миграция 0071) ──
// Техника освободилась раньше срока: сокращение периода заявки согласуется тем же руководителем
// строительства, что визировал заказ. Одна заявка — одна строка: повторный запрос переписывает её,
// а цепочка решений остаётся событиями истории (как у закрытия заявки, ADR 0029).
export const vehicleRequestEarlyEndings = pgTable(
  'vehicle_request_early_endings',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    status: vehicleEarlyEndStatusEnum('status').notNull(),
    newDateTo: date('new_date_to', { mode: 'string' }).notNull(),
    // Снимок срока на момент запроса: по нему считаются освобождённые дни и видно, что заявку
    // правили после запроса. Текущий date_to к моменту визы отвечает уже на другой вопрос.
    previousDateTo: date('previous_date_to', { mode: 'string' }).notNull(),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (t) => ({
    decision: check(
      'vehicle_request_early_endings_decision_check',
      sql`(${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    pendingState: check(
      'vehicle_request_early_endings_pending_check',
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    // Досрочное завершение только сокращает срок: равный и больший — уже продление.
    earlier: check(
      'vehicle_request_early_endings_earlier_check',
      sql`${t.newDateTo} < ${t.previousDateTo}`,
    ),
    reasonFilled: check(
      'vehicle_request_early_endings_reason_check',
      sql`btrim(${t.reason}) <> ''`,
    ),
    rejectionReason: check(
      'vehicle_request_early_endings_rejection_reason_check',
      sql`${t.status} <> 'rejected' OR btrim(${t.decisionComment}) <> ''`,
    ),
    // «Что ждёт визы на досрочный отъезд» — вопрос, с которого начинают день.
    pendingIdx: index('vehicle_request_early_endings_pending_idx')
      .on(t.requestedAt.desc())
      .where(sql`${t.status} = 'pending'`),
  }),
);

// ── Подтверждение смен по заказу спецтехники ──
// Техника стоит на объекте неделями, а работа считается по дням: за каждый день заказа — время
// смены, машиночасы, заправка и подпись объекта. Строка появляется при первом заполнении: заказ
// правят, сокращают досрочно (ADR 0044) и откатывают в «Новую» (ADR 0058), и заготовки на весь
// период пришлось бы синхронизировать с каждым из этих действий — а пустую заготовку потом не
// отличить от «день не заполнили», на чём держится и запрет закрытия, и предупреждение в срезе.
export const vehicleRequestShifts = pgTable(
  'vehicle_request_shifts',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    shiftDate: date('shift_date', { mode: 'string' }).notNull(),
    // Время смены: «08:00 – 20:00». Ночная переходит через полночь и относится к дню начала —
    // день здесь заказанный день заявки, а не астрономические сутки. Пусто — часы записали одним
    // числом, не проставляя границ; обе колонки при этом пусты (CHECK ниже).
    startedAt: time('started_at'),
    endedAt: time('ended_at'),
    machineHours: numeric('machine_hours', { precision: 5, scale: 2 }).notNull(),
    // Заправка свободным текстом: «120 л», «залили полный», «по талону». Числом станет, когда
    // формат устоится, — аддитивной миграцией, не переписывая уже записанное.
    refuel: text('refuel').notNull().default(''),
    comment: text('comment').notNull().default(''),
    filledBy: uuid('filled_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Подпись объекта: кто принял этот день работы. Пусто — день ещё не согласован.
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.shiftDate] }),
    // Сутки длиннее суток не бывают, а опечатка в разряде («115» вместо «11,5») иначе уезжает
    // прямиком в счёт. Ноль — законное значение: простой тоже часть учёта.
    hoursRange: check(
      'vehicle_request_shifts_hours_check',
      sql`${t.machineHours} >= 0 AND ${t.machineHours} <= 24`,
    ),
    // Нулевой день объясняется: «дождь», «не открыли фронт работ», «сломалась». Молчание портала
    // здесь хуже нуля — за такой день с арендодателем разговаривают отдельно.
    idleComment: check(
      'vehicle_request_shifts_idle_comment_check',
      sql`${t.machineHours} > 0 OR btrim(${t.comment}) <> ''`,
    ),
    // Половина смены не описывает ничего: «с 08:00» без конца — это не время работы.
    timePresence: check(
      'vehicle_request_shifts_time_check',
      sql`(${t.startedAt} IS NULL) = (${t.endedAt} IS NULL)`,
    ),
    // «Кто» без «когда» — не подпись (тем же CHECK устроена виза заявки, миграция 0049).
    approvalPresence: check(
      'vehicle_request_shifts_approval_check',
      sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`,
    ),
    // «Что по этой заявке не подтверждено» — главный вопрос к таблице: по нему считается сводка
    // строки списка, и он же не даёт заявке закрыться.
    unapprovedIdx: index('vehicle_request_shifts_unapproved_idx')
      .on(t.requestId)
      .where(sql`${t.approvedAt} IS NULL`),
  }),
);

// Связь заявка ТС ↔ файлы. UNIQUE(file_id) — файл не в двух заявках ТС; кросс-модульную
// уникальность с «Вывозом мусора» обеспечивает общий файловый сервис.
export const vehicleRequestFiles = pgTable(
  'vehicle_request_files',
  {
    vehicleRequestId: uuid('vehicle_request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vehicleRequestId, t.fileId] }),
    fileUnique: uniqueIndex('vehicle_request_files_file_unique').on(t.fileId),
  }),
);

// История статусов заявки ТС.
export const vehicleRequestStatusHistory = pgTable(
  'vehicle_request_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleRequestId: uuid('vehicle_request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    fromStatus: requestStatusEnum('from_status'),
    toStatus: requestStatusEnum('to_status').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment').notNull().default(''),
  },
  (t) => ({
    requestIdx: index('vehicle_request_status_history_request_idx').on(t.vehicleRequestId),
  }),
);

// ── Физические лица (ADR 0008, миграция 0018) ──
// Базовая сущность человека: только универсальные сведения. Должность, специализация,
// работодатель и категории прав здесь НЕ хранятся — для них отдельные таблицы ниже.
// Учётная запись (users) отделена: человек без доступа в портал — норма.
export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    middleName: text('middle_name').notNull().default(''),
    // Считает БД (STORED): второй точки правды по ФИО нет, поиск идёт по этой же колонке.
    fullName: text('full_name')
      .notNull()
      .generatedAlwaysAs(sql`btrim(last_name || ' ' || first_name || ' ' || middle_name)`),
    birthDate: date('birth_date', { mode: 'string' }),
    // Десять цифр без кода страны (ADR 0066): по номеру звонят перед рейсом, и хранить его иначе,
    // чем телефон учётки или контакт по заявке, было бы вторым правилом на то же самое.
    phone: text('phone').notNull().default(''),
    email: citext('email').notNull().default(''),
    // СНИЛС (ADR 0037, миграция 0058): обязательный реквизит путевого листа. Хранятся 11 цифр,
    // форматирование «XXX-XXX-XXX YY» — на выводе. Пусто — не заполнен: таблица рассчитана не на
    // одних водителей, и обязательность держит сервис. Контрольную сумму тоже проверяет он —
    // приём ИНН контрагента: формат ловит длину, контрольная сумма — опечатку в одной цифре.
    snils: text('snils').notNull().default(''),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    lastNameNotBlank: check('persons_last_name_not_blank', sql`btrim(${t.lastName}) <> ''`),
    firstNameNotBlank: check('persons_first_name_not_blank', sql`btrim(${t.firstName}) <> ''`),
    // Верхняя граница даты рождения — на уровне сервиса: CURRENT_DATE не IMMUTABLE и в CHECK запрещён.
    birthDateSane: check(
      'persons_birth_date_sane_check',
      sql`${t.birthDate} IS NULL OR ${t.birthDate} >= DATE '1900-01-01'`,
    ),
    snilsFormat: check(
      'persons_snils_format_check',
      sql`${t.snils} = '' OR ${t.snils} ~ '^[0-9]{11}$'`,
    ),
    // Ключ человека (ADR 0037): один СНИЛС — один живой person. Удалённых условие не касается —
    // после soft-delete человека заводят заново, и номер освобождается вместе с ним.
    snilsUnique: uniqueIndex('persons_snils_unique')
      .on(t.snils)
      .where(sql`${t.snils} <> '' AND ${t.deletedAt} IS NULL`),
    // Поиск по ФИО и предупреждение о вероятных дублях; жёсткого UNIQUE по ФИО нет: бывают
    // однофамильцы-ровесники. Надёжно человека различает СНИЛС, но он есть не у всех —
    // обязателен только водителю (ADR 0037).
    fullNameTrgm: index('persons_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    deletedAtIdx: index('persons_deleted_at_idx').on(t.deletedAt),
    phoneIdx: index('persons_phone_idx')
      .on(t.phone)
      .where(sql`${t.phone} <> ''`),
  }),
);

// ── Трудовые отношения (история) ──
// Активность работника выводится отсюда (ended_on IS NULL); отдельного флага в persons нет.
// Работодатель — строкой: справочник организаций появится вместе с подрядной техникой.
export const personEmployments = pgTable(
  'person_employments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    employmentType: employmentTypeEnum('employment_type').notNull().default('staff'),
    employerName: text('employer_name').notNull().default(''),
    personnelNo: text('personnel_no').notNull().default(''),
    jobTitle: text('job_title').notNull().default(''),
    startedOn: date('started_on', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_DATE`),
    endedOn: date('ended_on', { mode: 'string' }),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    dateOrder: check(
      'person_employments_date_order_check',
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`,
    ),
    personIdx: index('person_employments_person_idx').on(t.personId),
    activeIdx: index('person_employments_active_idx')
      .on(t.personId)
      .where(sql`${t.endedOn} IS NULL`),
    // Табельный уникален среди действующих отношений работодателя (после увольнения переиспользуем).
    personnelNoUnique: uniqueIndex('person_employments_personnel_no_unique')
      .on(t.employerName, t.personnelNo)
      .where(sql`${t.personnelNo} <> '' AND ${t.endedOn} IS NULL`),
  }),
);

// ── Справочник специализаций ──
// Какую работу человек может выполнять. Это НЕ право по документу: категории — ниже.
// Таблица создаётся пустой (миграция 0018 без сида).
export const specializations = pgTable(
  'specializations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('specializations_code_unique').on(t.code),
    codeFormat: check('specializations_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('specializations_name_not_blank', sql`btrim(${t.name}) <> ''`),
  }),
);

// ── Специализации человека ──
// Несколько одновременно, с периодом действия. Водитель — это выборка по code='driver'
// с ended_on IS NULL; отдельных таблиц drivers/driver_profiles нет.
export const personSpecializations = pgTable(
  'person_specializations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    specializationId: uuid('specialization_id')
      .notNull()
      .references(() => specializations.id, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    startedOn: date('started_on', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_DATE`),
    endedOn: date('ended_on', { mode: 'string' }),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    dateOrder: check(
      'person_specializations_date_order_check',
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`,
    ),
    activeUnique: uniqueIndex('person_specializations_active_unique')
      .on(t.personId, t.specializationId)
      .where(sql`${t.endedOn} IS NULL`),
    // Не более одной действующей основной специализации на человека.
    primaryUnique: uniqueIndex('person_specializations_primary_unique')
      .on(t.personId)
      .where(sql`${t.isPrimary} AND ${t.endedOn} IS NULL`),
    specializationIdx: index('person_specializations_specialization_idx')
      .on(t.specializationId)
      .where(sql`${t.endedOn} IS NULL`),
  }),
);

// ── Справочник видов документов (ADR 0008, миграция 0019) ──
// Уровень «система квалификации» не заводится: «C» водительского и «C» тракториста разводятся
// принадлежностью категории к виду документа. Таблица создаётся пустой.
export const credentialTypes = pgTable(
  'credential_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    // false — документ без категорий (медзаключение, свидетельство об обучении).
    hasCategories: boolean('has_categories').notNull().default(true),
    // false — бессрочный документ.
    expiryRequired: boolean('expiry_required').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('credential_types_code_unique').on(t.code),
    codeFormat: check('credential_types_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('credential_types_name_not_blank', sql`btrim(${t.name}) <> ''`),
  }),
);

// ── Справочник категорий (квалификаций) ──
// Категория принадлежит виду документа; код уникален внутри вида, но не глобально.
export const qualificationCategories = pgTable(
  'qualification_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialTypeId: uuid('credential_type_id')
      .notNull()
      .references(() => credentialTypes.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Цель составного FK из personCredentialCategories — см. categoryFk там.
    idTypeUnique: unique('qualification_categories_id_type_unique').on(t.id, t.credentialTypeId),
    codeUnique: uniqueIndex('qualification_categories_code_unique').on(t.credentialTypeId, t.code),
    codeFormat: check(
      'qualification_categories_code_format_check',
      sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    nameNotBlank: check('qualification_categories_name_not_blank', sql`btrim(${t.name}) <> ''`),
  }),
);

// ── Документы конкретных людей ──
// Новый документ не перезаписывает старый — история сохраняется. Проверка (verificationStatus)
// отделена от срока действия, аннулирование (revokedAt) — от удаления записи (deletedAt).
export const personCredentials = pgTable(
  'person_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    credentialTypeId: uuid('credential_type_id')
      .notNull()
      .references(() => credentialTypes.id, { onDelete: 'restrict' }),
    series: text('series').notNull().default(''),
    number: text('number').notNull().default(''),
    issuedOn: date('issued_on', { mode: 'string' }),
    expiresOn: date('expires_on', { mode: 'string' }),
    issuedBy: text('issued_by').notNull().default(''),
    verificationStatus: credentialVerificationStatusEnum('verification_status')
      .notNull()
      .default('unverified'),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationComment: text('verification_comment').notNull().default(''),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason').notNull().default(''),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Цель составного FK из personCredentialCategories — см. credentialFk там.
    idTypeUnique: unique('person_credentials_id_type_unique').on(t.id, t.credentialTypeId),
    dateOrder: check(
      'person_credentials_date_order_check',
      sql`${t.expiresOn} IS NULL OR ${t.issuedOn} IS NULL OR ${t.expiresOn} >= ${t.issuedOn}`,
    ),
    // Проверка — учётное действие: у проверенного/отклонённого известно, когда это было.
    verifiedAtCheck: check(
      'person_credentials_verified_at_check',
      sql`(${t.verificationStatus} = 'unverified') = (${t.verifiedAt} IS NULL)`,
    ),
    personIdx: index('person_credentials_person_idx')
      .on(t.personId)
      .where(sql`${t.deletedAt} IS NULL`),
    typeIdx: index('person_credentials_type_idx').on(t.credentialTypeId),
    verificationIdx: index('person_credentials_verification_idx')
      .on(t.verificationStatus)
      .where(sql`${t.deletedAt} IS NULL`),
    // Под отчёт по истекающим документам и напоминания через outbox jobs.
    expiresIdx: index('person_credentials_expires_idx')
      .on(t.expiresOn)
      .where(sql`${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    numberUnique: uniqueIndex('person_credentials_number_unique')
      .on(t.credentialTypeId, t.series, t.number)
      .where(sql`${t.number} <> '' AND ${t.deletedAt} IS NULL`),
  }),
);

// ── Категории, открытые конкретным документом ──
// credentialTypeId денормализован ради двух составных FK: категория обязана принадлежать тому же
// виду документа, что и сам документ («C» тракториста не встанет в водительское удостоверение).
// Собственные сроки категории сужают срок документа, но не продлевают его.
export const personCredentialCategories = pgTable(
  'person_credential_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialId: uuid('credential_id').notNull(),
    qualificationCategoryId: uuid('qualification_category_id').notNull(),
    credentialTypeId: uuid('credential_type_id').notNull(),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    restrictions: text('restrictions').notNull().default(''),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    credentialFk: foreignKey({
      columns: [t.credentialId, t.credentialTypeId],
      foreignColumns: [personCredentials.id, personCredentials.credentialTypeId],
      name: 'person_credential_categories_credential_fk',
    }).onDelete('cascade'),
    categoryFk: foreignKey({
      columns: [t.qualificationCategoryId, t.credentialTypeId],
      foreignColumns: [qualificationCategories.id, qualificationCategories.credentialTypeId],
      name: 'person_credential_categories_category_fk',
    }).onDelete('restrict'),
    dateOrder: check(
      'person_credential_categories_date_order_check',
      sql`${t.validTo} IS NULL OR ${t.validFrom} IS NULL OR ${t.validTo} >= ${t.validFrom}`,
    ),
    credentialCategoryUnique: uniqueIndex('person_credential_categories_unique').on(
      t.credentialId,
      t.qualificationCategoryId,
    ),
    categoryIdx: index('person_credential_categories_category_idx').on(t.qualificationCategoryId),
  }),
);

// ── Сканы документа ──
// У одного документа может быть несколько файлов. UNIQUE(file_id) — файл не в двух документах
// (паттерн vehicleRequestFiles).
export const personCredentialFiles = pgTable(
  'person_credential_files',
  {
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => personCredentials.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.credentialId, t.fileId] }),
    fileUnique: uniqueIndex('person_credential_files_file_unique').on(t.fileId),
  }),
);

// ── Путевые листы (ADR 0037, миграция 0061) ──
// Серия бланков: номер сквозной внутри серии, ширина — сколько знаков печатать с ведущими нулями.
// Счётчик в строке, а не sequence: sequence не откатывается вместе с транзакцией и оставляет
// дыры, а журнал учёта строгой отчётности читают как непрерывный.
export const waybillSeries = pgTable(
  'waybill_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Печатается в графе «серия»: в образцах это «260604-646-». */
    prefix: text('prefix').notNull().default(''),
    nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
    numberWidth: smallint('number_width').notNull().default(8),
    /** Чья серия: у каждого юрлица своя нумерация. NULL — серия основной организации. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('waybill_series_code_unique').on(t.code),
    codeFormat: check('waybill_series_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('waybill_series_name_not_blank', sql`btrim(${t.name}) <> ''`),
    nextNumberCheck: check('waybill_series_next_number_check', sql`${t.nextNumber} >= 1`),
    numberWidthCheck: check(
      'waybill_series_number_width_check',
      sql`${t.numberWidth} BETWEEN 1 AND 12`,
    ),
  }),
);

// Сам документ. Рождается переводом заявки в работу в той же транзакции и сразу выданным:
// состояния «в работе, а листа нет» не существует (ADR 0037 п. 2).
export const waybills = pgTable(
  'waybills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => waybillSeries.id, { onDelete: 'restrict' }),
    number: bigint('number', { mode: 'number' }).notNull(),
    /** Бланк снимком, а не join'ом: тип машины могут переклассифицировать, а лист уже выдан. */
    formCode: text('form_code').notNull().$type<'4p' | 'leg3' | 'esm2'>(),
    status: waybillStatusEnum('status').notNull().default('issued'),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    driverPersonId: uuid('driver_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    /**
     * День, на который выписан лист, и он же граница правки: до этой даты лист аннулируют и
     * выписывают заново, начиная с неё — нет (ADR 0037 п. 9). У ЭСМ-2 это первый рабочий день
     * недели, а граница считается по `periodTo`. Держит это сервис: CURRENT_DATE не IMMUTABLE и
     * в CHECK запрещён.
     */
    issuedForDate: date('issued_for_date', { mode: 'string' }).notNull(),
    /**
     * Рейс, по которому выписан лист (маршруты, миграции 0072 и 0074). NULL — лист ЭСМ-2
     * (миграция 0087): у недели работы машины на площадке рейса нет, есть заявка и период.
     * Инвариант «листа без рейса не бывает» этим и отменён — согласованность держит
     * `waybills_form_source_check`.
     */
    routeId: uuid('route_id').references(() => vehicleRoutes.id, { onDelete: 'restrict' }),
    /**
     * Заявка-основание листа ЭСМ-2 (миграция 0087). Тем же приёмом заявку держит рейс-перегон
     * (`vehicle_routes.source_request_id`, ADR 0057).
     */
    sourceRequestId: uuid('source_request_id').references(() => vehicleRequests.id, {
      onDelete: 'restrict',
    }),
    /**
     * Неделя работы машины: фактические рабочие дни, а не понедельник с воскресеньем — именно они
     * печатаются в графе «Период работы: с __ по __». Обе даты внутри одной календарной недели
     * (`waybills_period_check`); границей месяца неделя не режется.
     */
    periodFrom: date('period_from', { mode: 'string' }),
    periodTo: date('period_to', { mode: 'string' }),
    /** Прицеп — признак рейса: в реестре техники его нет, а категорию водителя он поднимает. */
    withTrailer: boolean('with_trailer').notNull().default(false),
    trailer1Model: text('trailer1_model').notNull().default(''),
    trailer1RegNumber: text('trailer1_reg_number').notNull().default(''),
    trailer2Model: text('trailer2_model').notNull().default(''),
    trailer2RegNumber: text('trailer2_reg_number').notNull().default(''),
    // Графы шапки, которых нет ни в заявке, ни в справочниках: наследуются от прошлого листа
    // этой машины и правятся раз в сезон.
    garageNumber: text('garage_number').notNull().default(''),
    communicationKind: text('communication_kind').notNull().default(''),
    transportationKind: text('transportation_kind').notNull().default(''),
    /** Снимок значений бланка: лист печатается из него, а не из справочников. */
    data: jsonb('data').notNull().default({}),
    issuedBy: uuid('issued_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Под какими предупреждениями выдан лист (миграция 0136, Р21). Конверт, а не голый массив:
     * различать нужно ТРИ состояния — `not_checked` (лист выдан до колонки либо мимо рукопожатия:
     * повтором запроса из истории, старой вкладкой, `curl`), `clean` (проверено, предупреждений не
     * было) и `acknowledged` (были и подтверждены, с отпечатком и списком). Пустой массив первых
     * двух не различал бы, а через полгода «не проверяли» не должно читаться как «всё чисто».
     */
    issueWarnings: jsonb('issue_warnings')
      .notNull()
      .default(sql`'{"schemaVersion":1,"status":"not_checked"}'::jsonb`),
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason').notNull().default(''),
    // ── След коррекции задним числом (ADR 0101, миграция 0129) ──
    /**
     * Операция, **породившая** этот лист: перевыписка взамен аннулированного или выписка задним
     * числом без замены. К ней же относится `correctionReason`.
     */
    correctionId: uuid('correction_id').references(() => waybillCorrections.id, {
      onDelete: 'restrict',
    }),
    /**
     * Операция, **списавшая** этот лист, — рядом с `cancelledBy`/`cancelReason`, отвечающими на тот
     * же вопрос для обычного списания.
     *
     * Отдельно от `correctionId`, потому что у листа бывают обе сразу: рождён перевыпиской, через
     * неделю списан следующей коррекцией. Одна колонка заставила бы выбирать, какую операцию
     * забыть, и забывалась бы та, к которой относится `correctionReason`, — строка журнала стала
     * бы называть причину одной операции со ссылкой на другую.
     *
     * Признак коррекции для фильтра журнала (Р28) — любая из двух: списание без перевыписки
     * заполняет только эту, выписка задним числом без замены — только первую.
     */
    cancelCorrectionId: uuid('cancel_correction_id').references(() => waybillCorrections.id, {
      onDelete: 'restrict',
    }),
    /**
     * Причина в самом листе, поверх записи операции. Дублирование симметрично существующему: у
     * аннулированного листа причина уже лежит своей колонкой (`cancelReason`), и держать причину
     * перевыписки в другом месте значило бы завести два разных ответа на вопрос «почему этот номер
     * такой».
     */
    correctionReason: text('correction_reason').notNull().default(''),
    /**
     * Заменённый номер. Хронология журнала при коррекции рвётся неизбежно — номер берётся из хвоста
     * серии, вставить его в середину нельзя, — и ссылка единственное, чем разрыв объясняется.
     */
    correctsWaybillId: uuid('corrects_waybill_id'),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    formCodeCheck: check('waybills_form_code_check', sql`${t.formCode} IN ('4p', 'leg3', 'esm2')`),
    // Аннулирование — учётное действие: известно, когда и почему. Испорченный бланк списывают.
    cancelledCheck: check(
      'waybills_cancelled_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`,
    ),
    cancelReasonCheck: check(
      'waybills_cancel_reason_check',
      sql`${t.status} <> 'cancelled' OR btrim(${t.cancelReason}) <> ''`,
    ),
    trailerFieldsCheck: check(
      'waybills_trailer_fields_check',
      sql`${t.withTrailer} OR (
        ${t.trailer1Model} = '' AND ${t.trailer1RegNumber} = ''
        AND ${t.trailer2Model} = '' AND ${t.trailer2RegNumber} = ''
      )`,
    ),
    // Источник документа ровно один (миграция 0087): у 4-П и формы № 3 — рейс, у ЭСМ-2 — заявка
    // с периодом. Третьего сочетания не бывает, и без CHECK лист оказался бы сразу и рейсовым,
    // и недельным.
    formSourceCheck: check(
      'waybills_form_source_check',
      sql`(${t.formCode} = 'esm2'
        AND ${t.routeId} IS NULL
        AND ${t.sourceRequestId} IS NOT NULL
        AND ${t.periodFrom} IS NOT NULL
        AND ${t.periodTo} IS NOT NULL)
      OR (${t.formCode} <> 'esm2'
        AND ${t.routeId} IS NOT NULL
        AND ${t.sourceRequestId} IS NULL
        AND ${t.periodFrom} IS NULL
        AND ${t.periodTo} IS NULL)`,
    ),
    // Лист не выходит за календарную неделю: в бланке семь строк, пн…вс, и восьмой день печатать
    // некуда. Границей месяца неделя при этом не режется — графа «месяца» принимает «08–09».
    periodCheck: check(
      'waybills_period_check',
      sql`${t.periodFrom} IS NULL OR (
        ${t.periodTo} >= ${t.periodFrom}
        AND date_trunc('week', ${t.periodFrom}::timestamp) = date_trunc('week', ${t.periodTo}::timestamp)
      )`,
    ),
    seriesNumberUnique: uniqueIndex('waybills_series_number_unique').on(t.seriesId, t.number),
    // Один действующий лист на рейс (миграция 0074). Аннулированные не мешают: испорченный бланк
    // списывают и выписывают новый по тому же рейсу — на этом держится пересборка состава.
    // Прежнее «один лист на машину и дату» снято: день и ночь на одной машине — это два рейса.
    routeUnique: uniqueIndex('waybills_route_unique')
      .on(t.routeId)
      .where(sql`${t.status} <> 'cancelled'`),
    // Одна неделя — один действующий лист на машину (миграции 0087 и 0127). Аннулированные не
    // мешают: сверка списывает испорченный бланк и выписывает на ту же неделю новый номер.
    //
    // Машина в ключе появилась с линейной техникой. Прежнее «одна неделя — один лист» молчаливо
    // опиралось на то, что машина у заявки одна: назначение одномашинное по построению
    // (`request_id` в первичном ключе). У линейного заказа неделю на объекте закрывают две разные
    // единицы, у каждой свои моточасы и свой машинист, и один лист на двоих нечем заполнить. Там,
    // где машина по-прежнему одна, тройка вырождается в пару и правило совпадает со старым.
    sourceRequestPeriodUnique: uniqueIndex('waybills_source_request_period_unique')
      .on(t.sourceRequestId, t.periodFrom, t.vehicleId)
      .where(sql`${t.status} <> 'cancelled'`),
    issuedForDateIdx: index('waybills_issued_for_date_idx').on(t.issuedForDate.desc()),
    routeIdx: index('waybills_route_idx')
      .on(t.routeId)
      .where(sql`${t.routeId} IS NOT NULL`),
    // «Какие листы у этой заявки» — вопрос карточки заявки и сверки, читающей их при каждом
    // изменении срока.
    sourceRequestIdx: index('waybills_source_request_idx')
      .on(t.sourceRequestId)
      .where(sql`${t.sourceRequestId} IS NOT NULL`),
    driverIdx: index('waybills_driver_idx').on(t.driverPersonId),
    // «На чём человек ездил в прошлый раз» — этим сортируется список водителей и наследуются
    // графы шапки.
    vehicleIssuedIdx: index('waybills_vehicle_issued_idx').on(t.vehicleId, t.issuedForDate.desc()),
    // Самоссылка именованным ограничением, а не инлайном: имя `..._fkey` от PostgreSQL ничего не
    // сказало бы в тексте ошибки, а разбирать эту связь придётся — цепочку коррекций собирают и
    // портал, и выгрузка. RESTRICT: листы портал не удаляет вовсе (испорченный аннулируют), но
    // рвать цепь A → B → C посередине нельзя ни при каких обстоятельствах.
    correctsFk: foreignKey({
      columns: [t.correctsWaybillId],
      foreignColumns: [t.id],
      name: 'waybills_corrects_waybill_fk',
    }).onDelete('restrict'),
    // Лист не заменяет сам себя: цикл длиной один FK самоссылки не ловит.
    correctsSelfCheck: check(
      'waybills_corrects_self_check',
      sql`${t.correctsWaybillId} IS NULL OR ${t.correctsWaybillId} <> ${t.id}`,
    ),
    // Замена всегда объяснена. Сервисом этого мало: перевыписка идёт из нескольких входов
    // (коррекция рейса, перенос между рейсами, сверка ЭСМ-2), и достаточно одному забыть причину,
    // чтобы в журнале появился номер, заменивший другой номер неизвестно почему.
    correctionReasonCheck: check(
      'waybills_correction_reason_check',
      sql`${t.correctsWaybillId} IS NULL OR btrim(${t.correctionReason}) <> ''`,
    ),
    // Всякий лист, рождённый операцией, объяснён — включая тот, у которого замены нет: выписка на
    // прошедший день по существующему рейсу и неделя ЭСМ-2 задним числом. Оговорки про
    // аннулированный не нужно: списавшая операция живёт в своей колонке, и лист, родившийся
    // обычным порядком, эту проверку не задевает вовсе.
    correctionIssueReasonCheck: check(
      'waybills_correction_issue_reason_check',
      sql`${t.correctionId} IS NULL OR btrim(${t.correctionReason}) <> ''`,
    ),
    // Замена номера рождается только операцией: иначе «кто заменил, когда и в рамках чего» —
    // без ответа, а связать замену со вторым рейсом переноса нечем. Держит схема, а не сервис:
    // входов у коррекции несколько, и достаточно одному забыть про запись операции.
    correctsOperationCheck: check(
      'waybills_corrects_operation_check',
      sql`${t.correctsWaybillId} IS NULL OR ${t.correctionId} IS NOT NULL`,
    ),
    // Каждый номер заменён не более одного раза. Цепочка A → B → C этим не запрещена — у каждого
    // звена свой предшественник, — запрещено разветвление: два листа, объявивших себя заменой
    // одному номеру, сделали бы вопрос «чем в итоге закрыт день» неразрешимым.
    correctsUnique: uniqueIndex('waybills_corrects_unique')
      .on(t.correctsWaybillId)
      .where(sql`${t.correctsWaybillId} IS NOT NULL`),
    // «Какие листы родила эта операция» — вопрос карточки коррекции и ответа на повтор запроса.
    correctionIdx: index('waybills_correction_idx')
      .on(t.correctionId)
      .where(sql`${t.correctionId} IS NOT NULL`),
    // То же со стороны списания: фильтр «только коррекции» спрашивает обе колонки.
    cancelCorrectionIdx: index('waybills_cancel_correction_idx')
      .on(t.cancelCorrectionId)
      .where(sql`${t.cancelCorrectionId} IS NOT NULL`),
  }),
);

// Задание листа: заявки, которые машина выполняет по этому бланку. Строк задания в 4-П семь —
// четыре талона заказчиков и три строки доп. задания, — а в форме № 3 десять (ADR 0068); вторая
// заявка на ту же машину в тот же день дописывается строкой задания, а не поднимает второй лист.
export const waybillRequests = pgTable(
  'waybill_requests',
  {
    waybillId: uuid('waybill_id')
      .notNull()
      .references(() => waybills.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'restrict' }),
    slot: smallint('slot').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.waybillId, t.requestId] }),
    slotCheck: check('waybill_requests_slot_check', sql`${t.slot} BETWEEN 1 AND 10`),
    slotUnique: uniqueIndex('waybill_requests_slot_unique').on(t.waybillId, t.slot),
    // Заявка в одном листе, но UNIQUE здесь нельзя: аннулированный лист сохраняет свою строку, а
    // заявку после него выписывают заново. Условие «лист не аннулирован» — в соседней таблице,
    // и держит его сервис.
    requestIdx: index('waybill_requests_request_idx').on(t.requestId),
  }),
);

/**
 * Лист ↔ ездка (миграция 0136, Р20): какая ездка какой строкой задания напечатана.
 *
 * Вторая связь рядом с `waybillRequests`, а не вместо неё: та отвечает на «в каких листах эта
 * заявка» — на неё смотрят `activeWaybillOfRequest`, откат статуса и легаси-проверки, — а эта на
 * «в каком листе уехала эта ездка». Покрывает только грузовые строки: у линейного дня ездки нет, и
 * его строка задания опознаётся парой «заявка + `workDate`», которая уже лежит в `waybillRequests`
 * и в составе рейса.
 */
export const waybillTrips = pgTable(
  'waybill_trips',
  {
    waybillId: uuid('waybill_id')
      .notNull()
      .references(() => waybills.id, { onDelete: 'cascade' }),
    /**
     * RESTRICT: журнал бланков строгой отчётности обязан помнить, что именно печаталось. Ровно так
     * же сегодня держит заявку `waybillRequests.requestId`, и поведение «удалить насовсем» от
     * новой таблицы не меняется — без листа заявка удаляется вместе с ездками, с листом не
     * удаляется и сейчас. Как ездка при этом снимается с задания — мягко, `deletedAt` (Р13а).
     */
    tripId: uuid('trip_id')
      .notNull()
      .references(() => vehicleRequestTrips.id, { onDelete: 'restrict' }),
    slot: smallint('slot').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.waybillId, t.tripId] }),
    slotCheck: check('waybill_trips_slot_check', sql`${t.slot} BETWEEN 1 AND 10`),
    slotUnique: unique('waybill_trips_slot_unique').on(t.waybillId, t.slot),
    // «В каком листе уехала эта ездка» — вопрос карточки ездки; он же покрывает проверку RESTRICT
    // при удалении ездки. Приём `waybill_requests_request_idx`.
    tripIdx: index('waybill_trips_trip_idx').on(t.tripId),
  }),
);

// Вложения к бланку (миграция 0087): скан заполненного заказчиком оборота ЭСМ-2, отметки 4-П,
// акт. Крепятся к листу, а не к заявке: заявок у листа бывает до десяти, а неделя работ распадается
// на несколько листов — «чей это скан» отвечает только номер бланка.
export const waybillFiles = pgTable(
  'waybill_files',
  {
    waybillId: uuid('waybill_id')
      .notNull()
      .references(() => waybills.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.waybillId, t.fileId] }),
    // Файл живёт максимум в одном месте (ADR 0024); кросс-модульную часть держит `linkedFileIds`.
    fileUnique: uniqueIndex('waybill_files_file_unique').on(t.fileId),
  }),
);

// ── Коррекция задним числом (ADR 0101, миграция 0129) ──
// Выданный лист не правится (ADR 0037 п. 10): коррекция — это «аннулировать и выписать заново»,
// два номера вместо одного. Строка на операцию, а не на изменённую сущность: «на рейс выехала
// другая машина с другим водителем, и это переписало назначения семи заявок» — одно событие с
// одной причиной и одним автором; разложив его по затронутым строкам, мы получили бы семь копий
// причины и ни одного места, где видно, что это была одна команда.
//
// Почему таблица, а не событие аудита: `writeAudit` пишет глобальным `db`, то есть отдельным
// соединением — вне транзакции коррекции, — и гасит ошибку в лог. Запись аудита может не появиться
// при успешной операции и остаться после отката; для единственного носителя обоснования правки
// бланка строгой отчётности обе стороны расхождения одинаково недопустимы. Аудит пишется
// по-прежнему, но как дополнение.
export const waybillCorrections = pgTable(
  'waybill_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Ключ идемпотентности от клиента: коррекция сжигает номер серии, а сеть рвётся — повтор после
     * таймаута обязан вернуть прежний результат, а не выписать второй лист взамен уже выписанного.
     * Ключ приходит снаружи, потому что только клиент знает, что это ретрай той же кнопки.
     */
    operationId: uuid('operation_id').notNull(),
    /**
     * Отпечаток нормализованного тела (цель, значения, причина). Одного ключа мало: он отвечает
     * лишь на «тот же запрос?», и клиент, переиспользовавший uuid, молча получил бы чужой результат
     * вместо выполнения своей команды. Тот же ключ с другим телом — не повтор, а ошибка (409).
     */
    fingerprint: text('fingerprint').notNull(),
    /**
     * Текст, а не enum, по той же причине, что и разделы дайджеста (миграция 0100): список входов
     * заднего числа прирастает этапами, и добавление нового не должно требовать ALTER TYPE. Реестр
     * значений живёт в контрактах, CHECK держит нижнюю границу от опечатки.
     */
    kind: text('kind')
      .notNull()
      .$type<
        | 'route'
        | 'transfer'
        | 'esm2'
        | 'cancel'
        | 'issue'
        | 'request_date'
        | 'weekly'
        | 'crew'
        | 'assignment_tail'
      >(),
    reason: text('reason').notNull(),
    /**
     * Снимок авторизации (Р9): какие права требовались, когда операцию разрешили. Повтор спустя
     * недели проверяет **сохранённые требования**, а глубину и архивный статус заново не считает —
     * пересчёт и есть та дыра, ради которой снимок заведён. У старых семи видов пусто: они
     * авторизуются прежним, своим для каждого входа путём.
     */
    authorizationScope: jsonb('authorization_scope').$type<WaybillCorrectionAuthorizationScope>(),
    /**
     * RESTRICT: учётку автора коррекции не удалить, пока за ней числятся правки бланков. Право у
     * диспетчера и администратора, увольнение диспетчера — обычное дело, а «кто это сделал» обязано
     * пережить его уход.
     */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    /**
     * «Было → стало» снимком: справочники живут своей жизнью — машину переклассифицируют, водителя
     * переводят, — а объяснять операцию придётся через месяцы. Сюда же уходят снятые подписи смен с
     * прежними `approvedBy`/`approvedAt`: в `vehicleRequestShifts` их после снятия уже нет.
     *
     * Ответ HTTP отсюда не собирается: снимок DTO протух бы при первой правке контракта — повтор
     * пересобирает ответ из текущего состояния листов, рейса и заявок.
     */
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => ({
    // `weekly` (миграция 0157) — проведение недельной заявки на просроченную неделю. Свой вид, а не
    // `esm2`: у той операции предмет — бумага одной заявки, а здесь одним решением двигаются сроки
    // целого состава, и в журнале эти две команды обязаны различаться — иначе «что делали задним
    // числом» отвечается одним словом на два разных события.
    kindCheck: check(
      'waybill_corrections_kind_check',
      sql`${t.kind} IN ('route', 'transfer', 'esm2', 'cancel', 'issue', 'request_date', 'weekly', 'crew', 'assignment_tail')`,
    ),
    // Снимок обязателен ровно у тех видов, что заведены историей назначения: у остальных его нет и
    // быть не может — миграция их не переписывала.
    authorizationScopeCheck: check(
      'waybill_corrections_authorization_scope_check',
      sql`${t.kind} NOT IN ('crew', 'assignment_tail') OR ${t.authorizationScope} IS NOT NULL`,
    ),
    // Причина обязательна и непуста — ради неё таблица и заведена. Пустая строка означала бы
    // «номер сгорел, объяснения нет», то есть ровно то состояние, которое фича закрывает.
    reasonCheck: check('waybill_corrections_reason_check', sql`btrim(${t.reason}) <> ''`),
    // Уникальность ключа — единственное, что делает повтор безопасным: две параллельные попытки
    // одного ретрая упрутся здесь, а не выпишут по номеру каждая.
    operationUnique: uniqueIndex('waybill_corrections_operation_unique').on(t.operationId),
  }),
);

// Какие заявки задела операция. Многие-ко-многим, потому что у коррекции рейса это весь его состав
// — до десяти заявок в форме № 3 (ADR 0068), — а у переноса между рейсами ровно одна, зато сама
// операция одна на два рейса. Ссылкой из заявки это не выражается: заявку корректируют не один раз
// за жизнь.
export const vehicleRequestCorrections = pgTable(
  'vehicle_request_corrections',
  {
    correctionId: uuid('correction_id')
      .notNull()
      .references(() => waybillCorrections.id, { onDelete: 'cascade' }),
    /**
     * CASCADE, как у прочих спутников заявки (смены, факт закрытия, досрочное завершение): строка
     * здесь — указатель «операция задела эту заявку», а не носитель обоснования. Обоснование лежит
     * в `waybillCorrections` вместе со снимком и переживает уборку заявки целиком; RESTRICT сделал
     * бы неудаляемой саму заявку ради указателя, который без неё ни на что не указывает.
     */
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.correctionId, t.requestId] }),
    // Обратный вопрос — «что делали с этой заявкой задним числом» — задаёт её карточка при каждом
    // открытии, и по ведущей колонке первичного ключа на него не ответить.
    requestIdx: index('vehicle_request_corrections_request_idx').on(t.requestId),
  }),
);

// ── Маршруты: рейс одной машины на дату (миграция 0072) ──
// Планировочный слой между заявкой и листом. Заявку кладут в рейс переводом в работу, лист
// выписывают с рейса отдельным действием — когда состав собран. До выписки рейс правится
// свободно; выписанный лист его замораживает, потому что бланк уже у водителя (ADR 0037 п. 9).
export const vehicleRoutes = pgTable(
  'vehicle_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Сквозной человекочитаемый номер: «Р-12». */
    num: integer('num').generatedAlwaysAsIdentity(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    /** День рейса по МСК: все заявки маршрута подаются в этот день. */
    routeDate: date('route_date', { mode: 'string' }).notNull(),
    /**
     * Зачем этот рейс (миграция 0082). `freight` — маршрут грузоперевозки: состав из заявок и
     * талоны заказчиков. `delivery` и `pickup` — перегон одной единицы спецтехники на объект и
     * обратно: состава нет, есть заявка-основание и две строки «откуда — куда».
     */
    purpose: text('purpose')
      .$type<'freight' | 'delivery' | 'pickup'>()
      .notNull()
      .default('freight'),
    /**
     * Заявка, ради которой едет перегон. Колонкой, а не составом рейса: состав держит
     * `UNIQUE (request_id)` — «заявка ровно в одном рейсе», — а доставка и вывоз это два рейса
     * одной заявки. У грузового рейса пусто.
     */
    sourceRequestId: uuid('source_request_id').references(() => vehicleRequests.id, {
      onDelete: 'restrict',
    }),
    /** Откуда и куда едет техника — задание водителю перегона. У грузового рейса пусто. */
    moveFrom: text('move_from').notNull().default(''),
    moveTo: text('move_to').notNull().default(''),
    /**
     * Кто за рулём. NULL — водителя ещё не назначили: рейс собирают заранее, человека ставят
     * утром. Один на маршрут: бланк 4-П держит одного, а вторая смена — это второй маршрут.
     */
    driverPersonId: uuid('driver_person_id').references(() => persons.id, {
      onDelete: 'restrict',
    }),
    // Реквизиты рейса: описывают выезд, а не заявку, — до маршрутов они лежали в назначении.
    withTrailer: boolean('with_trailer').notNull().default(false),
    trailer1Model: text('trailer1_model').notNull().default(''),
    trailer1RegNumber: text('trailer1_reg_number').notNull().default(''),
    trailer2Model: text('trailer2_model').notNull().default(''),
    trailer2RegNumber: text('trailer2_reg_number').notNull().default(''),
    garageNumber: text('garage_number').notNull().default(''),
    communicationKind: text('communication_kind').notNull().default(''),
    transportationKind: text('transportation_kind').notNull().default(''),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numUnique: uniqueIndex('vehicle_routes_num_unique').on(t.num),
    // «Что у этой машины на этот день»: им форма перевода в работу предлагает готовый рейс.
    // UNIQUE нет намеренно — день и ночь на одной машине это два маршрута с двумя листами.
    vehicleDateIdx: index('vehicle_routes_vehicle_date_idx').on(t.vehicleId, t.routeDate),
    dateIdx: index('vehicle_routes_date_idx').on(t.routeDate.desc()),
    driverIdx: index('vehicle_routes_driver_idx')
      .on(t.driverPersonId)
      .where(sql`${t.driverPersonId} IS NOT NULL`),
    trailerFieldsCheck: check(
      'vehicle_routes_trailer_fields_check',
      sql`${t.withTrailer} OR (
        ${t.trailer1Model} = '' AND ${t.trailer1RegNumber} = ''
        AND ${t.trailer2Model} = '' AND ${t.trailer2RegNumber} = ''
      )`,
    ),
    // Второй слот при пустом первом — графа, которую негде напечатать: бланк печатает слоты по
    // порядку (миграция 0208). Парного ограничения на `waybills` НЕТ намеренно: лист помнит
    // выданную бумагу, сдвинуть в нём графы нельзя, а `NOT VALID` проверял бы старую строку при
    // каждом `UPDATE` — и аннулирование отказало бы именно в тот день, когда бумагу надо списать.
    // Порядок слотов проверяет рейс — там, где его правят; лист принимает то, что ему передали.
    trailerOrderCheck: check(
      'vehicle_routes_trailer_order_check',
      sql`${t.trailer1Model} <> '' OR ${t.trailer1RegNumber} <> ''
        OR (${t.trailer2Model} = '' AND ${t.trailer2RegNumber} = '')`,
    ),
    purposeCheck: check(
      'vehicle_routes_purpose_check',
      sql`${t.purpose} IN ('freight', 'delivery', 'pickup')`,
    ),
    // Состав и основание не смешиваются: у грузового рейса заявки лежат в составе, у перегона
    // заявка одна и стоит колонкой.
    sourceRequestCheck: check(
      'vehicle_routes_source_request_check',
      sql`(${t.purpose} = 'freight' AND ${t.sourceRequestId} IS NULL)
        OR (${t.purpose} <> 'freight' AND ${t.sourceRequestId} IS NOT NULL)`,
    ),
    // Перегон едет откуда-то куда-то: пустые графы — это лист, по которому нельзя ехать.
    moveFieldsCheck: check(
      'vehicle_routes_move_fields_check',
      sql`${t.purpose} = 'freight'
        OR (btrim(${t.moveFrom}) <> '' AND btrim(${t.moveTo}) <> '')`,
    ),
    // Одна доставка и один вывоз на заявку. Аннулированный лист рейс не отменяет — уникальность
    // держится на рейсе, а не на его документе.
    sourceRequestUnique: uniqueIndex('vehicle_routes_source_request_unique')
      .on(t.sourceRequestId, t.purpose)
      .where(sql`${t.purpose} <> 'freight'`),
    sourceRequestIdx: index('vehicle_routes_source_request_idx')
      .on(t.sourceRequestId)
      .where(sql`${t.sourceRequestId} IS NOT NULL`),
    // Цель составного FK из состава (миграция 0127): день строки состава физически не может
    // разойтись с днём рейса. Держать это сервисом нельзя — рейс переносят на другую дату
    // отдельным действием, и день переезжает вместе с заявками (ADR 0082); забытый `work_date`
    // остался бы вчерашним молча. Приём тот же, что у `weekly_requests_id_week_unique`.
    idDateUnique: unique('vehicle_routes_id_date_unique').on(t.id, t.routeDate),
  }),
);

// Состав рейса: заявки в порядке строк задания бланка. Позиция и есть slot будущего листа.
export const vehicleRouteRequests = pgTable(
  'vehicle_route_requests',
  {
    routeId: uuid('route_id')
      .notNull()
      .references(() => vehicleRoutes.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'restrict' }),
    position: smallint('position').notNull(),
    /**
     * День линейного заказа, ради которого строка стоит в рейсе (миграция 0127).
     *
     * NULL — грузоперевозка, как было: день несёт сам рейс, и заявка стоит ровно в одном рейсе.
     * Заполнен — день линейного заказа: заявка стоит в стольких рейсах, сколько дней
     * распланировано, но в каждый день — ровно в одном.
     *
     * Своей таблицы у дня нет: он существует ровно постольку, поскольку существует срок заявки, —
     * тем же способом, каким выводятся дни смен (`vehicleRequestShifts`). Материализуется не день,
     * а факт «этот день поставлен в такой-то рейс», и строка задания рейса остаётся тем же
     * объектом, что и была: второй источник состава заставил бы считать позицию, ёмкость и снимок
     * листа двумя запросами вместо одного.
     */
    workDate: date('work_date', { mode: 'string' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.routeId, t.requestId] }),
    // Потолок по бланкам (ADR 0068, миграция 0096): у 4-П семь строк задания, у формы № 3 —
    // десять. Сколько влезет в конкретный маршрут, решает его бланк, и держит это сервер
    // (`ROUTE_REQUEST_CAPACITY`): в этой таблице бланка нет, он у типа машины рейса.
    positionCheck: check(
      'vehicle_route_requests_position_check',
      sql`${t.position} BETWEEN 1 AND 10`,
    ),
    /**
     * День строки равен дню рейса физически (миграция 0127). MATCH SIMPLE — умолчание PostgreSQL:
     * при NULL в `workDate` ключ не проверяется вовсе, ровно то, что нужно грузовым строкам, у
     * которых дня нет. `onUpdate('cascade')` тянет день за рейсом при переносе на другую дату
     * (ADR 0082); каскад способен упереться в `requestDayUnique` ниже, поэтому переносимость
     * сервер проверяет заранее и отвечает словами, а не 23505 из глубины транзакции.
     * `onDelete('cascade')` повторяет каскад обычного FK по `routeId` — два ключа к одному
     * родителю обязаны быть согласованы, иначе рейс перестал бы удаляться.
     */
    routeDateFk: foreignKey({
      columns: [t.routeId, t.workDate],
      foreignColumns: [vehicleRoutes.id, vehicleRoutes.routeDate],
      name: 'vehicle_route_requests_route_date_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // Заявка ровно в одном рейсе: «в работе и без маршрута» — законное состояние, «в двух сразу»
    // — нет. С миграции 0127 правило действует только на грузоперевозки — там, где дня у строки
    // нет; у линейного заказа оно звучит как «в один день — ровно один рейс» и держится соседним
    // индексом. Два частичных вместо одного ограничения: третьего состояния у строки не бывает, и
    // оба правила читаются глазом. Имя прежнего ограничения сохранено — правило то же, у него
    // сузилась область, и упавшая на нём вставка обязана называться в логе так же, как раньше.
    requestUnique: uniqueIndex('vehicle_route_requests_request_unique')
      .on(t.requestId)
      .where(sql`${t.workDate} IS NULL`),
    // Он же отвечает на вопрос «какие дни этой заявки распланированы», которым карточка заявки
    // рисует таблицу дней: отдельного индекса под чтение не потребовалось.
    requestDayUnique: uniqueIndex('vehicle_route_requests_request_day_unique')
      .on(t.requestId, t.workDate)
      .where(sql`${t.workDate} IS NOT NULL`),
    /**
     * Порядок талонов. В базе ограничение объявлено `DEFERRABLE INITIALLY IMMEDIATE` (миграция
     * 0072): перестановка переписывает позиции одним запросом, и построчная проверка упала бы на
     * первой же строке — транзакция перестановки откладывает её через `SET CONSTRAINTS`. Drizzle
     * отложенность не выражает, поэтому здесь ограничение объявлено обычным; источник истины —
     * миграция.
     */
    positionUnique: unique('vehicle_route_requests_position_unique').on(t.routeId, t.position),
    requestIdx: index('vehicle_route_requests_request_idx').on(t.requestId),
  }),
);

/**
 * Точка маршрута (миграция 0136, Р4): адрес остановки и её место в порядке объезда.
 *
 * Один и тот же адрес может стоять в маршруте НЕСКОЛЬКИМИ точками — это два заезда, и модель
 * обязана уметь их различать (`A B D A C`).
 *
 * Колонок ответственного у точки нет, хотя её тождество его включает (Р9), — и это осознанно.
 * Ответственный приходит от строки задания: у роли `load` это контакт погрузки ездки, у `unload` —
 * контакт разгрузки, у `work` — ответственный заявки спецтехники. Значит ответственные точки это
 * множество контактов её ролей, и вычислять его дешевле, чем поддерживать копию, которая
 * разойдётся с заявкой при первой же правке контакта (Р9в). Адрес при этом ХРАНИТСЯ снимком
 * (Р10): у точки с двумя ездками разных адресов «адрес» не определён без выбора, а «ответственные»
 * определены всегда — их просто двое.
 */
export const vehicleRoutePoints = pgTable(
  'vehicle_route_points',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => vehicleRoutes.id, { onDelete: 'cascade' }),
    /**
     * Порядок объезда. До двадцати: две точки на ездку, а строк задания в бланке максимум десять
     * (ADR 0068). Верхняя граница здесь — защита от переполнения, а сколько строк влезет в
     * конкретный маршрут, решает его бланк, и держит это сервер (`ROUTE_REQUEST_CAPACITY`).
     */
    position: smallint('position').notNull(),
    location: text('location').notNull(),
    address: jsonb('address').$type<AddressMeta>(),
    /**
     * План прибытия; NULL — не задан. `time`, а не `timestamptz`: день у точки тот же, что у
     * рейса, и второй копией даты она разошлась бы с ним при переносе (ADR 0082).
     */
    arrivalTime: time('arrival_time'),
    comment: text('comment').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => ({
    positionCheck: check(
      'vehicle_route_points_position_check',
      sql`${t.position} BETWEEN 1 AND 20`,
    ),
    locationNotBlank: check(
      'vehicle_route_points_location_not_blank_check',
      sql`btrim(${t.location}) <> ''`,
    ),
    addressShape: check(
      'vehicle_route_points_address_shape_check',
      sql`${t.address} is null or (jsonb_typeof(${t.address}) = 'object' and ${t.address} ? 'source')`,
    ),
    /**
     * Порядок объезда. В базе ограничение объявлено `DEFERRABLE INITIALLY IMMEDIATE` (миграция
     * 0136) — тем же приёмом, что порядок строк состава (0072): перестановка переписывает позиции
     * одним запросом, и построчная проверка упала бы на первой же строке; транзакция перестановки
     * откладывает её через `SET CONSTRAINTS`. Drizzle отложенность не выражает, поэтому здесь
     * ограничение объявлено обычным; источник истины — миграция.
     */
    positionUnique: unique('vehicle_route_points_position_unique').on(t.routeId, t.position),
    // Цель составного FK из связки: «точка из своего маршрута» — физический факт, а не проверка.
    idRouteUnique: unique('vehicle_route_points_id_route_unique').on(t.id, t.routeId),
  }),
);

/**
 * Что делают на точке (миграция 0136, Р5, Р5а): погрузка или разгрузка ездки — либо работа
 * линейного дня.
 *
 * Связка, а не колонка в точке, потому что на одной остановке законно сходятся две ездки разных
 * заявок: «в двух заявках одно и то же место погрузки, ехать дважды незачем» — это две строки
 * `load` у одной точки.
 *
 * КЛЮЧ СУРРОГАТНЫЙ, И ИНАЧЕ НЕЛЬЗЯ. Колонки первичного ключа PostgreSQL делает `NOT NULL`, а
 * `tripId` у линейной строки обязан быть пустым — «`role = 'work'` и `tripId IS NULL`» с `tripId` в
 * PK невыполнимо в принципе. Пара `(pointId, requestId, role)` тоже не годится: две ездки одной
 * заявки законно грузятся на одной точке. Отсюда `id` и уникальности ЧАСТИЧНЫМИ ИНДЕКСАМИ —
 * табличными ограничениями `UNIQUE … WHERE` в PostgreSQL не объявляются вовсе, и Drizzle их здесь
 * выражает ровно так же (`uniqueIndex().where()`).
 *
 * Чего база НЕ держит: соответствия роли виду строки состава. `role = 'work'` у грузовой строки и
 * `load` у линейного дня схема примет — третий ключ смотрит только на пару «маршрут + заявка».
 * Выразить это можно было бы копией `workDate` в связке и тройным ключом, но копию дня мы
 * отвергли: она разошлась бы с составом при переносе рейса (ADR 0082). Правило серверное и стоит в
 * верификаторе `backfill:trips --check`. Там же и «погрузка раньше разгрузки» (Р6): он про две
 * строки сразу, и CHECK его не выражает.
 */
export const vehicleRoutePointTrips = pgTable(
  'vehicle_route_point_trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pointId: uuid('point_id').notNull(),
    routeId: uuid('route_id').notNull(),
    requestId: uuid('request_id').notNull(),
    /**
     * Ездка грузоперевозки; NULL — строка линейного дня, у него ездок нет (Р5а): машина приезжает
     * на объект и работает там. Какой именно это день, отдельно не хранится — он лежит в
     * `workDate` той строки состава, на которую смотрит `compositionFk`.
     */
    tripId: uuid('trip_id'),
    role: text('role').$type<'load' | 'unload' | 'work'>().notNull(),
    /**
     * Порядок роли ВНУТРИ своей точки, 1..N (миграция 0146): «на карьере сначала грузим эту ездку,
     * потом ту».
     *
     * Заведена не ради вида списка. Две строки задания, стоящие на ОДНОЙ И ТОЙ ЖЕ паре точек
     * (автосборка переиспользовала точку по Р8), порядком объезда неразличимы, а порядок строк
     * задания — это порядок талонов заказчиков (Р12, Р20, ADR 0068 п. 2). Прежде их разводил номер
     * заявки, то есть порядок заведения записей; теперь их разводит человек, отвечая на вопрос,
     * имеющий физический смысл: чью ездку на этой остановке грузят первой.
     */
    position: smallint('position').notNull(),
  },
  (t) => ({
    roleCheck: check('route_point_trips_role_check', sql`${t.role} IN ('load', 'unload', 'work')`),
    /**
     * Ролей на точке не больше, чем их всего в маршруте: десять строк задания (ADR 0068) по две
     * роли — предельный случай, когда весь день грузится и разгружается в одном месте.
     */
    positionCheck: check('route_point_trips_position_check', sql`${t.position} BETWEEN 1 AND 20`),
    /**
     * Порядок ролей на точке. В базе объявлено `DEFERRABLE INITIALLY IMMEDIATE` (миграция 0146) —
     * тем же приёмом, что порядок точек (0136) и порядок строк состава (0072): перестановка
     * переписывает позиции одним запросом, и построчная проверка упала бы на первой же строке.
     * Drizzle отложенность не выражает — источник истины миграция.
     */
    positionUnique: unique('route_point_trips_position_unique').on(t.pointId, t.position),
    // Роль и наличие ездки согласованы: `work` без ездки, `load`/`unload` — только с ней.
    roleTripCheck: check(
      'route_point_trips_role_trip_check',
      sql`(${t.role} = 'work' AND ${t.tripId} IS NULL)
        OR (${t.role} <> 'work' AND ${t.tripId} IS NOT NULL)`,
    ),
    pointFk: foreignKey({
      columns: [t.pointId, t.routeId],
      foreignColumns: [vehicleRoutePoints.id, vehicleRoutePoints.routeId],
      name: 'route_point_trips_point_fk',
    }).onDelete('cascade'),
    /**
     * MATCH SIMPLE (умолчание): при NULL в `tripId` ключ не проверяется вовсе — ровно то, что
     * нужно линейной строке; тем же приёмом устроен `routeDateFk` состава (0127). RESTRICT, а не
     * CASCADE: ездку, побывавшую в маршруте, нельзя снести из-под задания.
     */
    tripFk: foreignKey({
      columns: [t.tripId, t.requestId],
      foreignColumns: [vehicleRequestTrips.id, vehicleRequestTrips.requestId],
      name: 'route_point_trips_trip_fk',
    }).onDelete('restrict'),
    /**
     * Строка обслуживается только там, где её заявка стоит в составе маршрута, — физически, а не
     * проверкой. Изъятие заявки из состава каскадом снимает все её роли, а опустевшие точки
     * доудаляет сервис (Р13).
     */
    compositionFk: foreignKey({
      columns: [t.routeId, t.requestId],
      foreignColumns: [vehicleRouteRequests.routeId, vehicleRouteRequests.requestId],
      name: 'route_point_trips_composition_fk',
    }).onDelete('cascade'),
    // Ездка обслуживается ровно одной погрузкой и одной разгрузкой (Р5). Совмещение двух ездок на
    // одном заезде — это две строки `load` у одной точки, и оно этим индексом не задевается.
    tripRoleUnique: uniqueIndex('route_point_trips_trip_role_unique')
      .on(t.tripId, t.role)
      .where(sql`${t.tripId} IS NOT NULL`),
    // Линейный день занимает ровно одну точку своего маршрута (Р5а).
    linearUnique: uniqueIndex('route_point_trips_linear_unique')
      .on(t.routeId, t.requestId)
      .where(sql`${t.role} = 'work'`),
    // «Что делают на этой точке» — главный вопрос к таблице; он же покрывает каскад от точки.
    pointIdx: index('route_point_trips_point_idx').on(t.pointId),
    // Под каскад от состава маршрута: частичный индекс линейных строк его не закрывает — у
    // грузовых ролей `role <> 'work'`, и изъятие заявки сканировало бы таблицу целиком.
    compositionIdx: index('route_point_trips_composition_idx').on(t.routeId, t.requestId),
  }),
);

// ── Фоновые задачи (outbox, §16) ──
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    dueIdx: index('jobs_due_idx').on(t.status, t.nextRunAt),
    // Под возврат просроченных задач (миграция 0182): аренда спрашивается по `locked_until`
    // у строк в `running`, а `jobs_due_idx` внутри статуса упорядочен по `next_run_at` — величине,
    // к аренде отношения не имеющей. Частичный: `running` в очереди всегда меньшинство.
    leaseIdx: index('jobs_lease_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
  }),
);

// ── Журнал исходящих писем (миграция 0097) ──
//
// Отдельно от `jobs`: задача отвечает за выполнение и живёт до `done`, а журнал — за содержание,
// адресата и результат доставки, и его спрашивают через месяцы. Письмо и задача `send_email`
// создаются одной транзакцией, причём в таком порядке: сначала строка сюда (с дедупликацией по
// `(kind, dedupe_key)`), и только если она вставилась — задача. Иначе сработавшая дедупликация
// оставляла бы задачу без письма.
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: mailKindEnum('kind').notNull(),
    /** Ключ бизнес-события: «это письмо уже составлено» — пара «запуск + получатель» или событие. */
    dedupeKey: text('dedupe_key').notNull(),
    /** Снимок адреса: смена email после отправки не переписывает журнал. */
    toEmail: citext('to_email').notNull(),
    /**
     * Куда отвечать на это письмо (миграция 0141). Пусто — общий `MAIL_REPLY_TO`, как было до
     * появления колонки: письма, лежащие в очереди с прошлых выпусков, своего поведения не меняют.
     *
     * Адрес принадлежит письму, а не порталу, потому что «кому отвечать» зависит от события: на
     * заявку, ждущую визы, отвечают заявителю, на отмену — тому, кто отменил.
     */
    replyTo: citext('reply_to').notNull().default(''),
    /**
     * Каким каналом уходит письмо (миграция 0144): у службы ремонта свой ящик на своём сервере, и
     * отправить от него через провайдерский транспорт нельзя — чужой `From` отвергают.
     *
     * Выбирает канал API, который письмо и составляет; воркер по колонке берёт транспорт. Реестр
     * ключей — в контрактах, здесь только тип: третий канал не должен стоить миграции.
     */
    account: text('account').notNull().default('default').$type<MailAccount>(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Водитель: задание на рейс получает физлицо, учётной записи у него может не быть вовсе. */
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    /** Запуск расписания; `null` — письмо вызвано действием человека. FK добавит этап планировщика. */
    mailingRunId: uuid('mailing_run_id'),
    /** Отладочная отправка администратору: мимо статистики запусков и мимо алертов. */
    isTest: boolean('is_test').notNull().default(false),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** Готовое тело: worker отправляет составленное, а не пересобранное по изменившимся данным. */
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html').notNull().default(''),
    status: mailStatusEnum('status').notNull().default('pending'),
    providerId: text('provider_id').notNull().default(''),
    lastError: text('last_error').notNull().default(''),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    dedupeUnique: uniqueIndex('mail_messages_dedupe_unique').on(t.kind, t.dedupeKey),
    statusIdx: index('mail_messages_status_idx').on(t.status, t.createdAt),
    userIdx: index('mail_messages_user_idx')
      .on(t.userId, sql`${t.createdAt} DESC`)
      .where(sql`${t.userId} IS NOT NULL`),
    personIdx: index('mail_messages_person_idx')
      .on(t.personId, sql`${t.createdAt} DESC`)
      .where(sql`${t.personId} IS NOT NULL`),
    runIdx: index('mail_messages_run_idx')
      .on(t.mailingRunId)
      .where(sql`${t.mailingRunId} IS NOT NULL`),
    // Отправленное письмо обязано знать, когда оно ушло: иначе «отправлено» ничем не подтверждено.
    sentAtCheck: check(
      'mail_messages_sent_at_check',
      sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`,
    ),
    dedupeKeyNotBlank: check(
      'mail_messages_dedupe_key_not_blank',
      sql`btrim(${t.dedupeKey}) <> ''`,
    ),
    subjectNotBlank: check('mail_messages_subject_not_blank', sql`btrim(${t.subject}) <> ''`),
    bodyNotBlank: check('mail_messages_body_not_blank', sql`btrim(${t.bodyText}) <> ''`),
  }),
);

// ── Расписания рассылок и их запуски (ADR 0075, миграция 0099) ──
//
// Настройки в БД, а не в `env`: время, окно дат и исключения меняет администратор, а правка `env` —
// это перезапуск сервиса руками. Запуск отделён от расписания: расписание отвечает «когда и что
// рассылать», запуск — «что произошло в 18:00 такого-то числа», и без него история рассылки жила
// бы только в логах.
export const mailingSchedules = pgTable(
  'mailing_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: mailingTypeEnum('type').notNull(),
    name: text('name').notNull(),
    /** Выключенное расписание сохраняет настройки: «до понедельника не рассылаем» — не «завести заново». */
    isEnabled: boolean('is_enabled').notNull().default(false),
    /** Местное время в часовом поясе портала: «в 18:00 каждый день» не зависит от даты. */
    sendAt: time('send_at').notNull(),
    /**
     * По каким дням выполняется рассылка. Недельная — это набор из одного дня: периодичности
     * отдельным полем больше нет, потому что она сливала в одно слово три независимых числа.
     */
    runWeekdays: smallint('run_weekdays')
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5,6,7}'`),
    /**
     * Окно данных: с какого дня относительно дня рассылки (0 — сегодняшний, 1 — завтрашний) и
     * сколько дней в нём, считая первый. В днях, а не датами, потому что «завтра» у каждого
     * запуска своё; началом и длительностью, а не парой границ, потому что «конец раньше начала»
     * длительностью невыразимо.
     */
    windowFromDays: smallint('window_from_days').notNull().default(1),
    windowDays: smallint('window_days').notNull().default(1),
    /** Чьи заявки показывать в сводке: `author` — свои, `scope` — своей области, `all` — отмеченных. */
    requestScope: text('request_scope')
      .notNull()
      .default('scope')
      .$type<'author' | 'scope' | 'all'>(),
    /** Какие таблицы печатает сводка: перевозки (4-П, № 3) и техника на объектах (ЭСМ-2). */
    showTrips: boolean('show_trips').notNull().default(true),
    showOnsite: boolean('show_onsite').notNull().default(true),
    /**
     * Как задан набор у осей аудитории. `all` — «все и будущие», перечень при этом пуст;
     * `selected` — перечисленные в своей таблице. Без режима отбор молча терял бы каждую новую
     * площадку и каждую новую учётку: их не было в списке, когда его отмечали.
     */
    scopeMode: text('scope_mode').notNull().default('all').$type<'all' | 'selected'>(),
    recipientMode: text('recipient_mode').notNull().default('all').$type<'all' | 'selected'>(),
    /** Считает и хранит планировщик: просроченные расписания ищутся индексом, а не перебором. */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    dueIdx: index('mailing_schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.isEnabled} AND ${t.nextRunAt} IS NOT NULL`),
    nameNotBlank: check('mailing_schedules_name_not_blank', sql`btrim(${t.name}) <> ''`),
    runWeekdaysCheck: check(
      'mailing_schedules_run_weekdays_check',
      sql`array_length(${t.runWeekdays}, 1) BETWEEN 1 AND 7
          AND ${t.runWeekdays} <@ ARRAY[1,2,3,4,5,6,7]::smallint[]`,
    ),
    // Окно одинаково у обоих типов рассылки: и задание водителю, и сводка отвечают на вопрос «что
    // будет в эти дни», и считать его двумя способами не из чего.
    windowCheck: check(
      'mailing_schedules_window_check',
      sql`${t.windowFromDays} BETWEEN 0 AND 30 AND ${t.windowDays} BETWEEN 1 AND 31`,
    ),
    requestScopeCheck: check(
      'mailing_schedules_request_scope_check',
      sql`${t.requestScope} IN ('author', 'scope', 'all')`,
    ),
    modeCheck: check(
      'mailing_schedules_mode_check',
      sql`${t.scopeMode} IN ('all', 'selected') AND ${t.recipientMode} IN ('all', 'selected')`,
    ),
    // Сводка без единой таблицы собрала бы пустое письмо, которое всё равно не отправится:
    // выключается такая рассылка флагом, а не снятием обеих галочек.
    digestContentCheck: check(
      'mailing_schedules_digest_content_check',
      sql`${t.type} <> 'role_digest' OR ${t.showTrips} OR ${t.showOnsite}`,
    ),
  }),
);

/** Даты-исключения: «в этот день не рассылаем» и «рейсы этого дня не включаем» — разные вопросы. */
export const mailingScheduleExcludedDates = pgTable(
  'mailing_schedule_excluded_dates',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    kind: mailingExcludedDateKindEnum('kind').notNull(),
    excludedOn: date('excluded_on', { mode: 'string' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.scheduleId, t.kind, t.excludedOn] }) }),
);

/** Исключённые водители: `persons`, потому что учётной записи у водителя может не быть вовсе. */
export const mailingScheduleExcludedPersons = pgTable(
  'mailing_schedule_excluded_persons',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.scheduleId, t.personId] }) }),
);

// ── Аудитория ролевой сводки (ADR 0078, миграция 0100; отбор вместо исключений — ADR 0093, 0124;
//    адресация правом вместо роли — ADR 0111, миграция 0151) ──
//
// Адрес в расписании — фильтр получателей, а не выдача прав: письмо уходит тому, у кого право уже
// есть, а что он в нём увидит, решает его собственная область видимости. Отдельными таблицами, а не
// массивами в строке расписания: по ним идут выборки получателей, и массив в `WHERE` означал бы
// разворачивание на каждом запуске.
//
// Все три оси — выбор, а не исключение. Прежние «исключённые» таблицы описывали ту же аудиторию
// наизнанку: по форме нельзя было прочитать, кому уйдёт письмо, не вычитая в уме одно из другого.

/**
 * Права-адресаты сводки (ADR 0111, миграция 0151) — то, чем расписание отвечает на вопрос «кому
 * отправлять».
 *
 * **Право, а не роль**, потому что вопрос этот — о работе, а не о названии должности: сводку по
 * заказам техники получает тот, кто их ведёт (решение заказчика №3 от 17.08.2026, §11.1 плана
 * реструктуризации прав). Несколько прав означают «любое из» — тем же объединением, каким работал
 * набор ролей.
 *
 * `text`, а не enum, — по той же причине, что у `grant_permissions` (ADR 0106): словарь прав живёт
 * в коде и меняется выкатом, а значение enum'а в базе снимается миграцией, то есть каждое новое
 * право требовало бы своей. Право, снятое из словаря, остаётся здесь строкой-сиротой; отбор её
 * попросту никому не сопоставит, а увидеть её должен человек — этим занят `digest-role-audience`.
 *
 * Отбор считает **эффективное** право: роль его даёт (`ROLE_PERMISSIONS`), тип контрагента или
 * назначенный набор — для адресации разницы нет (`permissionAudienceWhere`).
 */
export const mailingSchedulePermissions = pgTable(
  'mailing_schedule_permissions',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scheduleId, t.permission] }),
    permissionNotBlank: check(
      'mailing_schedule_permissions_not_blank',
      sql`btrim(${t.permission}) <> ''`,
    ),
  }),
);

/**
 * Роли-получатели сводки — **прежняя адресация, оставленная до следующего релиза** (ADR 0111).
 *
 * С выката этапа 7 таблица не читается и не пишется: адресацию задают права
 * (`mailing_schedule_permissions`). Строки при этом сохранены намеренно и удаляются отдельной
 * миграцией релизом позже (§13 плана: между «перестали писать» и «удалили» обязан пройти релиз) —
 * пока они на месте, откат этапа сводится к откату кода, а `backfill:mailing-audience --check`
 * умеет сверить обе адресации между собой и сказать, совпадает ли аудитория поимённо.
 *
 * Заодно снимается прежняя головная боль перевода ролей: роль входила в первичный ключ, и наивный
 * `UPDATE … SET role = 'site'` упирался в дубль у расписания, где отмечены обе сливаемые роли, а
 * забытый перевод оставлял расписание с ролью, которой ни у кого нет, — рассылка не падала и не
 * жаловалась, она просто переставала приходить. Права такого свойства не имеют: слияние ролей их
 * не касается вовсе.
 */
export const mailingScheduleRoles = pgTable(
  'mailing_schedule_roles',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.scheduleId, t.role] }) }),
);

/**
 * Отмеченные получатели-учётки: не путать с водителями, которым уходит задание на рейс. Пусто при
 * `recipient_mode = 'all'` — тогда отбор идёт только ролями и областями.
 */
export const mailingScheduleRecipients = pgTable(
  'mailing_schedule_recipients',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.scheduleId, t.userId] }) }),
);

/**
 * Отмеченные площадки и отделы рассылки. Работают дважды: отбирают получателей, у которых эта ось
 * есть, и — при охвате заявок `all` — ограничивают данные. Расширить область получателя не могут
 * ни в одном из двух случаев: условие всегда пересекается с его собственной областью.
 */
export const mailingScheduleScopes = pgTable(
  'mailing_schedule_scopes',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id').references(() => constructionObjects.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    objectUnique: uniqueIndex('mailing_schedule_scopes_object_unique')
      .on(t.scheduleId, t.objectId)
      .where(sql`${t.objectId} IS NOT NULL`),
    departmentUnique: uniqueIndex('mailing_schedule_scopes_department_unique')
      .on(t.scheduleId, t.departmentId)
      .where(sql`${t.departmentId} IS NOT NULL`),
    // Ровно одно из двух: строка описывает либо площадку, либо отдел — как и заказчик заявки.
    oneCheck: check(
      'mailing_schedule_scopes_one_check',
      sql`num_nonnulls(${t.objectId}, ${t.departmentId}) = 1`,
    ),
  }),
);

export const mailingRuns = pgTable(
  'mailing_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => mailingSchedules.id, { onDelete: 'cascade' }),
    /** На какое время назначен: вместе с расписанием — ключ запуска против двойной рассылки. */
    plannedAt: timestamp('planned_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Границы данных фиксируются при создании: повтор не пересчитывает их от текущего времени. */
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    status: mailingRunStatusEnum('status').notNull().default('pending'),
    /** Итоги запуска: набор причин пропуска у каждого вида рассылки свой и будет меняться. */
    stats: jsonb('stats')
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error').notNull().default(''),
    /** Запуск «сейчас» из админки: в истории он виден отдельно от расписанных. */
    isManual: boolean('is_manual').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    plannedUnique: uniqueIndex('mailing_runs_planned_unique').on(t.scheduleId, t.plannedAt),
    historyIdx: index('mailing_runs_history_idx').on(t.scheduleId, sql`${t.createdAt} DESC`),
    periodCheck: check(
      'mailing_runs_period_check',
      sql`(${t.periodStart} IS NULL AND ${t.periodEnd} IS NULL)
          OR (${t.periodStart} IS NOT NULL AND ${t.periodEnd} IS NOT NULL
              AND ${t.periodEnd} >= ${t.periodStart})`,
    ),
  }),
);

// ── Служебные адресаты писем модулей (план office-equipment-mail-and-history-plan.md, миграция 0141) ──
//
// Расписания выше отвечают на вопрос «кому из учётных записей и когда уходит сводка». Здесь другое:
// письмо по событию на служебный ящик, за которым нет ни учётки, ни области видимости, — отдел ИТ
// читает почту, а не портал.
//
// Строка — это пара «событие + адрес», а не словарь настроек: у неё есть форма, которую проверяют
// и схема, и CHECK, и есть ответ на вопрос «кто это включил и когда». Несколько адресов на событие
// разрешены (копия завхозу), и каждому уходит своё письмо со своим ключом дедупликации — иначе
// уникальность `mail_messages (kind, dedupe_key)` подавила бы всё, кроме первого.
export const moduleMailRecipients = pgTable(
  'module_mail_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Реестр открытый и живёт в контрактах (`MODULE_MAIL_EVENTS`) — текстом, как
     * `mailing_schedule_sections.section`, и без CHECK по перечню: новое событие не должно стоить
     * миграции. Тип берётся оттуда же, чтобы перечень не переписывался вторым списком здесь.
     */
    event: text('event').notNull().$type<ModuleMailEvent>(),
    toEmail: citext('to_email').notNull(),
    /** Выключенный адресат сохраняет настройку: «до понедельника не шлём» — не «завести заново». */
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Куда отвечать: фиксированный адрес, автор заявки, вызвавший событие или общий адрес портала. */
    replyToMode: text('reply_to_mode').notNull().default('fixed').$type<ReplyToMode>(),
    /** Обязателен при `fixed`, запасной при `author`/`actor`, пуст при `portal` — см. CHECK ниже. */
    replyToEmail: citext('reply_to_email').notNull().default(''),
    /** «Кому и зачем»: ящик без объяснения через год никто не решится выключить. */
    comment: text('comment').notNull().default(''),
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Один адрес на событие: вторая строка с тем же ящиком означала бы два одинаковых письма.
    eventEmailUnique: uniqueIndex('module_mail_recipients_event_email_unique').on(
      t.event,
      t.toEmail,
    ),
    // Отбор при постановке письма идёт ровно этой парой.
    liveIdx: index('module_mail_recipients_live_idx')
      .on(t.event)
      .where(sql`${t.isEnabled}`),
    // CHECK по перечню событий не ставится: реестр открытый (см. комментарий у колонки). У режима
    // обратного адреса — ставится: это закрытое поведение, от которого зависит соседняя колонка.
    replyToModeCheck: check(
      'module_mail_recipients_reply_to_mode_check',
      sql`${t.replyToMode} IN ('fixed', 'author', 'actor', 'portal')`,
    ),
    // Режим и адрес — пара: у `fixed` без адреса отвечать некуда, у `portal` свой адрес означал бы
    // настройку, которой никто не пользуется. У `author`/`actor` адрес необязателен: он запасной.
    replyToEmailCheck: check(
      'module_mail_recipients_reply_to_email_check',
      sql`(${t.replyToMode} = 'fixed' AND ${t.replyToEmail} <> '')
          OR (${t.replyToMode} = 'portal' AND ${t.replyToEmail} = '')
          OR ${t.replyToMode} IN ('author', 'actor')`,
    ),
  }),
);

// ── Аудит (append-only, §22) ──
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => ({
    // История одной сущности (карточка заявки) — выборка по паре «тип + id», свежие сначала.
    entityIdx: index('audit_log_entity_idx').on(t.entityType, t.entityId, t.createdAt),
  }),
);

/**
 * Журнал обновлений портала (ADR 0077). Наполняется миграциями: выпуск заводит тот, кто его
 * выкатывает, — экрана редактирования нет, поэтому здесь только чтение.
 *
 * `seq` первичным ключом и он же порядок: дата выпуски не упорядочивает (несколько блоков доезжают
 * в один день), строка версии — тем более ('0.1.10' меньше '0.1.9' как текст). `adrs` хранит
 * номера решений, наружу из них идёт только их количество.
 */
export const appReleases = pgTable(
  'app_releases',
  {
    seq: integer('seq').primaryKey(),
    version: text('version').notNull().unique(),
    /** Дата выкладки: справочная, порядок задаёт `seq`. */
    releasedOn: date('released_on', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
    adrs: smallint('adrs').array().notNull(),
    /** Пункты выпуска: читаются целиком вместе с ним, разбирает их `releaseItemsSchema`. */
    items: jsonb('items').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    titleNotBlank: check('app_releases_title_not_blank', sql`btrim(${t.title}) <> ''`),
    itemsIsArray: check('app_releases_items_is_array', sql`jsonb_typeof(${t.items}) = 'array'`),
    adrsNotEmpty: check('app_releases_adrs_not_empty', sql`array_length(${t.adrs}, 1) >= 1`),
  }),
);

/**
 * Руководства пользователя (`docs/manuals-plan.md`, миграция 0158) — список ссылок на документы во
 * внешнем хранилище. Соседняя таблица тому же служебному углу меню, что и `app_releases`, но ведут
 * её иначе: журнал выпусков заводит миграция, а руководства — держатель `manuals.manage` на своей
 * вкладке, без правки кода и выката.
 *
 * Файла у портала нет и не будет: он хранит строку, а документ живёт в Яндекс.Диске. Поэтому
 * единственная проверка адреса — `https://`, и она про то, что документ откроется у всех, а не про
 * безопасность ссылки: правило «`/i/` — просмотр, `/edit/` — правка» принадлежит Яндексу и,
 * зашитое в CHECK, сломалось бы на первой же смене их адресов.
 *
 * `is_active` и `sort_order` разводят «что показывать» и «в каком порядке»: снятое с публикации
 * руководство видит только держатель права, а порядок задаётся числом, чтобы переставить строку
 * можно было, не трогая соседей. Отбора по ролям нет намеренно (§6 плана) — схема к нему готова,
 * но сегодня список у всех вошедших один.
 */
export const appManuals = pgTable(
  'app_manuals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    /** Вторая строка пункта в окне. Пусто, а не NULL: «без пояснения» — одно состояние, не два. */
    description: text('description').notNull().default(''),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    titleNotBlank: check('app_manuals_title_not_blank', sql`btrim(${t.title}) <> ''`),
    urlHttps: check('app_manuals_url_https', sql`${t.url} ~ '^https://'`),
    // Тот же порядок, каким список отдаёт ручка: сперва отбор по публикации, затем порядок показа.
    listIdx: index('app_manuals_list_idx').on(t.isActive, t.sortOrder, t.title),
  }),
);

// ── Недельная заявка на технику (план docs/weekly-vehicle-request-plan.md, миграция 0107) ──
// Документ-основание над заказами ТС, а не третий их тип: заявка ТС физически одномашинная
// (`vehicle_request_assignments` — одна строка на заявку), ЭСМ-2 привязан к паре «заявка + неделя»
// (ADR 0060), срок у каждой единицы свой. Виза недельной заявки порождает и продлевает обычные
// заказы, и дальше всё работает как раньше.
export const weeklyRequestStatusEnum = pgEnum('weekly_request_status', [
  'draft',
  'pending',
  'applied',
  'cancelled',
]);
// Три вида строки: «остаётся», «нужна дополнительно» и «уезжает». Третий заведён потому, что
// решение об отъезде — часть недельного документа: снятая галка не «отсутствие строки».
export const weeklyRequestItemKindEnum = pgEnum('weekly_request_item_kind', [
  'extend',
  'new',
  'leave',
]);
export const weeklyRequestItemResultEnum = pgEnum('weekly_request_item_result', [
  'pending',
  'extended',
  'created',
  'left',
  'skipped',
]);
export const weeklyRequestEventEnum = pgEnum('weekly_request_event', [
  'status',
  'items_changed',
  'item_dropped',
]);

export const weeklyVehicleRequests = pgTable(
  'weekly_vehicle_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Свой сквозной номер, на экране — «НЗ-12»: на пакет ссылаются («продлено по НЗ-12» в истории
    // заказа, «НЗ-12 ждёт визы» в списке руководителя).
    num: integer('num').generatedAlwaysAsIdentity(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    // Единица — будущая календарная неделя пн–вс. Хранится один ключ, понедельник; конец недели
    // вычисляется прибавлением шести дней и в базе не лежит: две колонки на одно значение рано или
    // поздно разойдутся. Неделя — та же, которой режет свои периоды ЭСМ-2 (`weekStartKey`).
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    status: weeklyRequestStatusEnum('status').notNull().default('draft'),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    // Виза руководителя строительства. Отдельного действия «применить» нет: оно создавало бы
    // состояние «завизировано, но ничего не произошло».
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    cancelReason: text('cancel_reason').notNull().default(''),
    // Токен оптимистичной блокировки: состав правят несколько человек, а виза применяет ровно тот
    // состав, который видел визирующий.
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Неделя начинается с понедельника — иначе `week_start + 6` перестаёт быть неделей, а границы
    // дат строки проверяли бы произвольный семидневный отрезок.
    weekMonday: check(
      'weekly_requests_week_monday_check',
      sql`extract(isodow from ${t.weekStart}) = 1`,
    ),
    approvalPair: check(
      'weekly_requests_approval_pair_check',
      sql`(${t.approvedBy} is null) = (${t.approvedAt} is null)`,
    ),
    // Виза и применение — одно событие, поэтому инвариант жизненного цикла записывается двумя
    // равенствами, а не тремя «или»: завизированная — это ровно применённая.
    appliedStatus: check(
      'weekly_requests_applied_check',
      sql`(${t.status} = 'applied') = (${t.appliedAt} is not null)`,
    ),
    approvedStatus: check(
      'weekly_requests_approved_status_check',
      sql`(${t.status} = 'applied') = (${t.approvedBy} is not null)`,
    ),
    cancelReasonRequired: check(
      'weekly_requests_cancel_check',
      sql`${t.status} <> 'cancelled' or btrim(${t.cancelReason}) <> ''`,
    ),
    // Цель составного FK из строк: неделя строки физически не может разойтись с неделей шапки —
    // тем же приёмом, что `vehicle_requests.id_type_unique` у назначения.
    idWeekUnique: unique('weekly_requests_id_week_unique').on(t.id, t.weekStart),
    // Одна заявка на пару «объект + неделя»: две означали бы два состава, которые при согласовании
    // подерутся за один и тот же заказ. Отменённые из ограничения выпадают.
    objectWeekUniq: uniqueIndex('weekly_requests_object_week_uniq')
      .on(t.objectId, t.weekStart)
      .where(sql`${t.status} <> 'cancelled'`),
    numUniq: uniqueIndex('weekly_requests_num_uniq').on(t.num),
    // «Что ждёт визы»: в очередь руководителя попадает только `pending` — черновик виден, но не
    // отвлекает.
    pendingIdx: index('weekly_requests_pending_idx')
      .on(t.weekStart, t.objectId)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const weeklyVehicleRequestItems = pgTable(
  'weekly_vehicle_request_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Ссылка на шапку — только составным ключом ниже: одиночный FK к тому же родителю дублировал
    // бы его и требовал бы держать два каскада согласованными.
    weeklyRequestId: uuid('weekly_request_id').notNull(),
    // Денормализованная неделя шапки: только она даёт проверить границы дат строки внутри CHECK.
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    position: integer('position').notNull(),
    kind: weeklyRequestItemKindEnum('kind').notNull(),
    // Заказ-основание у строк `extend` и `leave`. RESTRICT: применённая заявка не должна терять
    // свои следствия; брошенный черновик развязывает `purge`, убирая свои строки.
    sourceRequestId: uuid('source_request_id').references(() => vehicleRequests.id, {
      onDelete: 'restrict',
    }),
    // Позиция классификатора у строки `new` (ADR 0028). Конкретную машину строка не называет — её
    // подбирает диспетчер при переводе в работу: площадка не видит парка и не знает занятости.
    vehicleTypeId: uuid('vehicle_type_id').references(() => vehicleTypes.id, {
      onDelete: 'restrict',
    }),
    vehicleCategoryId: uuid('vehicle_category_id'),
    dateFrom: date('date_from', { mode: 'string' }),
    dateTo: date('date_to', { mode: 'string' }),
    responsibleName: text('responsible_name').notNull().default(''),
    responsiblePhone: text('responsible_phone').notNull().default(''),
    deliveryNeeded: boolean('delivery_needed').notNull().default(false),
    deliveryFrom: text('delivery_from').notNull().default(''),
    comment: text('comment').notNull().default(''),
    // Что видел составитель при подаче: эффективный конец срока заказа (`coalesce(date_to,
    // date_from)`). Им сверяется применимость строки, и он же объясняет отказ словами «было 11.08,
    // стало 15.08». Сверяется срок, а не версия: версия растёт от любой правки, включая телефон
    // ответственного, и выбрасывала бы строки по поводам, к решению не относящимся.
    expectedDateTo: date('expected_date_to', { mode: 'string' }),
    // Снимок момента применения. Разведён с ожиданием намеренно: одно поле под обе задачи не
    // работает — ожидание и снимок расходятся ровно тогда, когда это важнее всего.
    previousDateTo: date('previous_date_to', { mode: 'string' }),
    appliedSourceVersion: integer('applied_source_version'),
    // Хранится идентичность машины, а не её подпись: вопрос снимка — «та же ли это физическая
    // машина»; госномер и модель берутся join'ом, чтобы карточка показывала их сегодняшними.
    snapshotVehicleId: uuid('snapshot_vehicle_id').references(() => vehicles.id, {
      onDelete: 'restrict',
    }),
    // Номер порождённого заказа рядом не хранится: пара «идентификатор + номер» проверяема на
    // полноту, но не на принадлежность одному заказу, а номер и так приходит join'ом.
    createdRequestId: uuid('created_request_id').references(() => vehicleRequests.id, {
      onDelete: 'restrict',
    }),
    result: weeklyRequestItemResultEnum('result').notNull().default('pending'),
    skipReason: text('skip_reason').notNull().default(''),
    // Явное согласие снять ожидающий досрочный отъезд. **Больше не заполняется**: единица с
    // нерешённым запросом на отъезд в состав не идёт вовсе, и второго — недостижимого — способа
    // отменить чужое решение у модуля быть не должно. Новые строки всегда `false`.
    //
    // Колонка при этом остаётся вместе со своим CHECK: она хранит историю уже применённых заявок,
    // где согласие давали, и стереть её значит потерять объяснение, почему запрос на отъезд тогда
    // исчез. Миграции здесь нет — колонка просто перестала заполняться.
    earlyEndOverride: boolean('early_end_override').notNull().default(false),
  },
  (t) => ({
    weekFk: foreignKey({
      columns: [t.weeklyRequestId, t.weekStart],
      foreignColumns: [weeklyVehicleRequests.id, weeklyVehicleRequests.weekStart],
      name: 'weekly_items_week_fk',
    }).onDelete('cascade'),
    // Категория чужого типа невозможна физически (ADR 0028) — тем же приёмом, что у заявки ТС.
    categoryTypeFk: foreignKey({
      columns: [t.vehicleCategoryId, t.vehicleTypeId],
      foreignColumns: [vehicleCategories.id, vehicleCategories.vehicleTypeId],
      name: 'weekly_items_category_type_fk',
    }).onDelete('restrict'),
    // Форма строки задана её видом целиком: у продления есть заказ и дата, по которую продлить, у
    // новой — позиция классификатора и срок, у отъезда — только заказ.
    kindShape: check(
      'weekly_items_kind_shape_check',
      sql`(${t.kind} = 'extend' and ${t.sourceRequestId} is not null and ${t.vehicleTypeId} is null
       and ${t.vehicleCategoryId} is null and ${t.dateFrom} is null and ${t.dateTo} is not null
       and ${t.expectedDateTo} is not null)
    or (${t.kind} = 'new' and ${t.sourceRequestId} is null and ${t.vehicleTypeId} is not null
       and ${t.dateFrom} is not null and ${t.dateTo} is not null and ${t.dateFrom} <= ${t.dateTo}
       and ${t.expectedDateTo} is null)
    or (${t.kind} = 'leave' and ${t.sourceRequestId} is not null and ${t.vehicleTypeId} is null
       and ${t.vehicleCategoryId} is null and ${t.dateFrom} is null and ${t.dateTo} is null
       and ${t.expectedDateTo} is not null)`,
    ),
    // Поля, значимые только у своего вида строки: контакт и доставка — принадлежность `new`,
    // согласие на снятие досрочного отъезда — принадлежность `extend`. Без этих проверок в базе
    // заводится строка «уезжает с запрошенной доставкой», которую никто не собирался разрешать.
    newFields: check(
      'weekly_items_new_fields_check',
      sql`${t.kind} = 'new'
    or (btrim(${t.responsibleName}) = '' and ${t.responsiblePhone} = ''
        and not ${t.deliveryNeeded} and btrim(${t.deliveryFrom}) = '')`,
    ),
    overrideKind: check(
      'weekly_items_override_kind_check',
      sql`${t.kind} = 'extend' or not ${t.earlyEndOverride}`,
    ),
    // Границы недели: строка не выходит за пн–вс своей заявки.
    weekBounds: check(
      'weekly_items_week_bounds_check',
      sql`(${t.dateFrom} is null or (${t.dateFrom} >= ${t.weekStart} and ${t.dateFrom} <= ${t.weekStart} + 6))
    and (${t.dateTo} is null or (${t.dateTo} >= ${t.weekStart} and ${t.dateTo} <= ${t.weekStart} + 6))`,
    ),
    resultKind: check(
      'weekly_items_result_kind_check',
      sql`${t.result} = 'pending'
    or (${t.kind} = 'extend' and ${t.result} in ('extended', 'skipped'))
    or (${t.kind} = 'new' and ${t.result} in ('created', 'skipped'))
    or (${t.kind} = 'leave' and ${t.result} in ('left', 'skipped'))`,
    ),
    // Развилка, а не равенство: порождённый заказ есть ровно у применённой строки `new`, и у любой
    // другой его быть не может — ссылка на чужой заказ читалась бы как «этот заказ создан неделей».
    createdShape: check(
      'weekly_items_created_check',
      sql`(${t.result} = 'created' and ${t.kind} = 'new' and ${t.createdRequestId} is not null)
    or (${t.result} <> 'created' and ${t.createdRequestId} is null)`,
    ),
    // Снимок обязателен у обеих строк, ссылающихся на заказ: «уезжает» — такое же согласованное
    // решение, и через месяц вопрос к нему тот же — какая машина и до какого числа стояла. Развилка
    // симметричная по той же причине: полуснимок у `pending` или `skipped` — это мусор, который
    // однажды прочитают как факт.
    sourceSnapshot: check(
      'weekly_items_source_snapshot_check',
      sql`(${t.result} in ('extended', 'left')
      and ${t.previousDateTo} is not null and ${t.appliedSourceVersion} is not null
      and ${t.snapshotVehicleId} is not null)
    or (${t.result} not in ('extended', 'left')
      and ${t.previousDateTo} is null and ${t.appliedSourceVersion} is null
      and ${t.snapshotVehicleId} is null)`,
    ),
    skipReasonRequired: check(
      'weekly_items_skip_check',
      sql`${t.result} <> 'skipped' or btrim(${t.skipReason}) <> ''`,
    ),
    positionNonNegative: check('weekly_items_position_check', sql`${t.position} >= 0`),
    // Контакт встречающего у новой строки обязателен, как в обычной заявке; телефон — десять цифр
    // без кода страны (ADR 0066).
    contact: check(
      'weekly_items_contact_check',
      sql`${t.kind} <> 'new' or (btrim(${t.responsibleName}) <> '' and ${t.responsiblePhone} ~ '^[0-9]{10}$')`,
    ),
    deliveryFromRequired: check(
      'weekly_items_delivery_from_check',
      sql`not ${t.deliveryNeeded} or btrim(${t.deliveryFrom}) <> ''`,
    ),
    positionUniq: uniqueIndex('weekly_items_position_uniq').on(t.weeklyRequestId, t.position),
    // Один заказ — одна строка в неделе: два решения об одной машине на одну неделю противоречивы
    // по определению. Между разными неделями запрета нет — планировать через неделю нормально.
    sourceUniq: uniqueIndex('weekly_items_source_uniq')
      .on(t.weeklyRequestId, t.sourceRequestId)
      .where(sql`${t.sourceRequestId} is not null`),
    // Порождённый заказ имеет ровно одно основание: «Создан по НЗ-12» — одна ссылка, а
    // «Продления: НЗ-15, НЗ-18» — список, и он идёт по `source_request_id`.
    createdUniq: uniqueIndex('weekly_items_created_uniq')
      .on(t.createdRequestId)
      .where(sql`${t.createdRequestId} is not null`),
    sourceIdx: index('weekly_items_source_idx').on(t.sourceRequestId),
  }),
);

// История заявки: и статусы, и изменения состава — одной транзакционной таблицей. Узкой «истории
// статусов» не хватает: состав правится и без перехода (в том числе не человеком — уборкой при
// `purge`), а `writeAudit` такую запись может потерять, потому что намеренно не роняет операцию
// при сбое.
export const weeklyVehicleRequestHistory = pgTable(
  'weekly_vehicle_request_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    weeklyRequestId: uuid('weekly_request_id')
      .notNull()
      .references(() => weeklyVehicleRequests.id, { onDelete: 'cascade' }),
    event: weeklyRequestEventEnum('event').notNull(),
    fromStatus: weeklyRequestStatusEnum('from_status'),
    toStatus: weeklyRequestStatusEnum('to_status'),
    /** Что именно изменилось: снятые строки с номерами заказов, состав до и после. */
    payload: jsonb('payload').notNull().default({}),
    // Событий без автора здесь не бывает: состав меняет человек, и уборку при `purge` тоже делает
    // администратор осознанным действием.
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment').notNull().default(''),
  },
  (t) => ({
    // Развилка полная: равенство по `to_status` оставляло бы у не-статусного события заполненный
    // `from_status` — строку, которая читается как несостоявшийся переход.
    statusShape: check(
      'weekly_history_status_check',
      sql`(${t.event} = 'status' and ${t.toStatus} is not null)
    or (${t.event} <> 'status' and ${t.fromStatus} is null and ${t.toStatus} is null)`,
    ),
    requestIdx: index('weekly_history_request_idx').on(t.weeklyRequestId, t.changedAt),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type UserConstructionObjectRow = typeof userConstructionObjects.$inferSelect;
export type DepartmentRow = typeof departments.$inferSelect;
export type UserDepartmentRow = typeof userDepartments.$inferSelect;
export type UserRoleAddonRow = typeof userRoleAddons.$inferSelect;
export type GrantRow = typeof grants.$inferSelect;
export type GrantPermissionRow = typeof grantPermissions.$inferSelect;
export type GrantRoleRow = typeof grantRoles.$inferSelect;
export type UserGrantRow = typeof userGrants.$inferSelect;
export type UserRoleMigrationRow = typeof userRoleMigration.$inferSelect;
export type WasteRequestRow = typeof wasteRequests.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ObjectRow = typeof constructionObjects.$inferSelect;
export type ContainerTypeRow = typeof containerTypes.$inferSelect;
export type WasteTypeRow = typeof wasteTypes.$inferSelect;
export type WasteTariffRow = typeof wasteTariffs.$inferSelect;
export type VehicleKindRow = typeof vehicleKinds.$inferSelect;
export type VehicleTypeRow = typeof vehicleTypes.$inferSelect;
export type VehicleSpecRow = typeof vehicleSpecs.$inferSelect;
export type VehicleTypeSpecRow = typeof vehicleTypeSpecs.$inferSelect;
export type VehicleCategoryRow = typeof vehicleCategories.$inferSelect;
export type VehicleCategorySpecValueRow = typeof vehicleCategorySpecValues.$inferSelect;
export type VehicleModelRow = typeof vehicleModels.$inferSelect;
export type VehicleRow = typeof vehicles.$inferSelect;
export type VehicleTrailerRow = typeof vehicleTrailers.$inferSelect;
export type VehicleRequestRow = typeof vehicleRequests.$inferSelect;
export type SpecialEquipmentRequestDetailsRow = typeof specialEquipmentRequestDetails.$inferSelect;
export type FreightTransportRequestDetailsRow = typeof freightTransportRequestDetails.$inferSelect;
export type WasteRequestVehicleRow = typeof wasteRequestVehicles.$inferSelect;
export type CounterpartyRow = typeof counterparties.$inferSelect;
export type CounterpartySynonymRow = typeof counterpartySynonyms.$inferSelect;
export type WarehouseRow = typeof warehouses.$inferSelect;
export type OfficeEquipmentTypeRow = typeof officeEquipmentTypes.$inferSelect;
export type OfficeEquipmentModelRow = typeof officeEquipmentModels.$inferSelect;
export type OfficeEquipmentRow = typeof officeEquipment.$inferSelect;
export type OfficeEquipmentConsumableRow = typeof officeEquipmentConsumables.$inferSelect;
export type OfficeEquipmentConsumableModelRow = typeof officeEquipmentConsumableModels.$inferSelect;
export type OfficeEquipmentConsumableStockEntryRow =
  typeof officeEquipmentConsumableStockEntries.$inferSelect;
export type ServiceRequestRow = typeof serviceRequests.$inferSelect;
export type ServiceRequestItemRow = typeof serviceRequestItems.$inferSelect;
export type ServiceRequestFileRow = typeof serviceRequestFiles.$inferSelect;
export type ServiceRequestExecutorRow = typeof serviceRequestExecutors.$inferSelect;
export type ServiceRequestConsumableRow = typeof serviceRequestConsumables.$inferSelect;
export type ServiceRequestStatusHistoryRow = typeof serviceRequestStatusHistory.$inferSelect;
export type ObjectOperatorRow = typeof constructionObjectOperators.$inferSelect;
export type PersonRow = typeof persons.$inferSelect;
export type PersonEmploymentRow = typeof personEmployments.$inferSelect;
export type SpecializationRow = typeof specializations.$inferSelect;
export type PersonSpecializationRow = typeof personSpecializations.$inferSelect;
export type CredentialTypeRow = typeof credentialTypes.$inferSelect;
export type QualificationCategoryRow = typeof qualificationCategories.$inferSelect;
export type PersonCredentialRow = typeof personCredentials.$inferSelect;
export type PersonCredentialCategoryRow = typeof personCredentialCategories.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type AppReleaseRow = typeof appReleases.$inferSelect;
export type ManualRow = typeof appManuals.$inferSelect;
export type WeeklyVehicleRequestRow = typeof weeklyVehicleRequests.$inferSelect;
export type WeeklyVehicleRequestItemRow = typeof weeklyVehicleRequestItems.$inferSelect;
export type WeeklyVehicleRequestHistoryRow = typeof weeklyVehicleRequestHistory.$inferSelect;

// ── Показания техники (ADR 0103, миграция 0132) ──
//
// Модуль второго контура: кабинет водителя передаёт сюда одометр, моточасы и заправленное за
// смену, а гараж эти строки только показывает — своих таблиц у него по-прежнему нет (ADR 0076).
//
// Три утверждения держат всю модель, и каждое выражено ключом, а не соглашением:
//
//  1. Показание принадлежит ВЫЕЗДУ, а не дню: строка ожидания ссылается на рейс или недельный
//     ЭСМ-2, и только источник отвечает, в каком порядке шли смены и кому относится разница.
//  2. Состав дня ФИКСИРУЕТСЯ отправкой: строки ожидания — снимок задания, и появившийся позже
//     рейс не меняет полноту принятого отчёта, а становится расхождением.
//  3. Снимок НЕ РАСХОДИТСЯ с показанием: копии машины, дня и позиции скреплены составным внешним
//     ключом, и подменить их в обход строки ожидания нельзя.

/**
 * Состояние отчёта дня. `needs_reacceptance` — принятый отчёт, который после этого правили;
 * `voided` — отчёт, из которого перенос (`rebase`) унёс последнюю строку: приёмке не подлежит,
 * историю хранит.
 */
export const driverReportStateEnum = pgEnum('driver_report_state', [
  'draft',
  'submitted',
  'accepted',
  'needs_reacceptance',
  'voided',
]);
/** Чем задан выезд. Третьего не бывает: у 4-П и формы № 3 источник — сам рейс. */
export const readingSourceKindEnum = pgEnum('reading_source_kind', ['route', 'esm2']);
/** `no_data` — «работали, но снять нечего»: это закрытие строки с причиной, а не пропуск. */
export const readingKindEnum = pgEnum('reading_kind', ['values', 'no_data']);
export const readingSourceEnum = pgEnum('reading_source', ['driver', 'staff']);
/** Начала ряда здесь нет: «предшественника не было» — состояние, а не отклонение. */
export const readingAnomalyEnum = pgEnum('reading_anomaly', ['counter_reset', 'implausible_jump']);
export const readingEventEnum = pgEnum('reading_event', [
  'created',
  'updated',
  'anomaly_confirmed',
  'chain_relinked',
]);
export const reportEventEnum = pgEnum('report_event', [
  'created',
  'submitted',
  'accepted',
  'reopened',
  'voided',
  'item_added',
  'item_removed',
  'shift_order_changed',
  'discrepancy_resolved',
]);
export const discrepancyKindEnum = pgEnum('discrepancy_kind', [
  'driver',
  'vehicle',
  'date',
  'source_state',
  'missing_source',
]);
/** `revoked` отменяет прежнее решение при неизменном отпечатке — иначе отменить его нечем. */
export const discrepancyResolutionEnum = pgEnum('discrepancy_resolution', [
  'accepted_as_is',
  'source_added',
  'revoked',
]);

/**
 * Отчёт дня: шапка, без которой отсутствие строки не является фактом. Только с ней различимы
 * «машину пропустили намеренно», «не дозаполнили» и «строка не сохранилась», и только к ней
 * относится приёмка.
 */
export const driverDailyReports = pgTable(
  'driver_daily_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    state: driverReportStateEnum('state').notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'restrict' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** Редакция содержимого, которую подтвердил принимающий: приём фиксирует данные, а не нажатие. */
    acceptedContentVersion: integer('accepted_content_version'),
    /** Числа, вид строки, причины, комментарии, состав строк ожидания и порядок смен. */
    contentVersion: integer('content_version').notNull().default(0),
    /** Оптимистическая блокировка: растёт при любом изменении шапки, включая смену состояния. */
    version: integer('version').notNull().default(0),
    /** Идемпотентность отправки: ключ клиента и отпечаток принятого тела. */
    submitIdempotencyKey: uuid('submit_idempotency_key'),
    submitFingerprint: text('submit_fingerprint').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    personDateUnique: uniqueIndex('driver_daily_reports_key').on(t.personId, t.reportDate),
    // Цель составного внешнего ключа из строк ожидания: день строки равен дню своего отчёта.
    idDateUnique: unique('driver_daily_reports_date_unique').on(t.id, t.reportDate),
    openIdx: index('driver_daily_reports_open_idx')
      .on(t.reportDate.desc())
      .where(sql`${t.state} IN ('submitted', 'needs_reacceptance')`),
    versionsNonNegative: check(
      'driver_daily_reports_versions_check',
      sql`${t.contentVersion} >= 0 AND ${t.version} >= 0
        AND (${t.acceptedContentVersion} IS NULL
          OR (${t.acceptedContentVersion} >= 0 AND ${t.acceptedContentVersion} <= ${t.contentVersion}))`,
    ),
    /**
     * Полная матрица состояний одним условием, а не поля по одному: иначе `draft` с заполненной
     * приёмкой и `accepted` с разошедшимися версиями остаются формально законными. Две последние
     * ветки и есть определение принятых состояний: `accepted` — «подтверждённая редакция равна
     * текущей», `needs_reacceptance` — «подтверждали редакцию младше».
     */
    stateShape: check(
      'driver_daily_reports_state_check',
      sql`(${t.state} = 'draft' AND ${t.submittedAt} IS NULL AND ${t.acceptedAt} IS NULL
            AND ${t.acceptedBy} IS NULL AND ${t.acceptedContentVersion} IS NULL)
        OR (${t.state} = 'submitted' AND ${t.submittedAt} IS NOT NULL AND ${t.acceptedAt} IS NULL
            AND ${t.acceptedBy} IS NULL AND ${t.acceptedContentVersion} IS NULL)
        OR (${t.state} = 'accepted' AND ${t.submittedAt} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL
            AND ${t.acceptedBy} IS NOT NULL AND ${t.acceptedContentVersion} = ${t.contentVersion})
        OR (${t.state} = 'needs_reacceptance' AND ${t.submittedAt} IS NOT NULL
            AND ${t.acceptedAt} IS NOT NULL AND ${t.acceptedBy} IS NOT NULL
            AND ${t.acceptedContentVersion} < ${t.contentVersion})
        OR (${t.state} = 'voided' AND ${t.submittedAt} IS NOT NULL
            AND ((${t.acceptedAt} IS NULL AND ${t.acceptedBy} IS NULL
                  AND ${t.acceptedContentVersion} IS NULL)
              OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptedBy} IS NOT NULL
                  AND ${t.acceptedContentVersion} < ${t.contentVersion})))`,
    ),
    idempotencyShape: check(
      'driver_daily_reports_idempotency_check',
      sql`(${t.submitIdempotencyKey} IS NULL) = (${t.submitFingerprint} = '')`,
    ),
  }),
);

/**
 * Строка ожидания — снимок источника на момент заведения. Состояния у неё нет намеренно: оно
 * выводится из наличия и вида показания, и хранимое «сдано» дублировало бы факт, допуская
 * расхождение с ним.
 */
export const driverDailyReportItems = pgTable(
  'driver_daily_report_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => driverDailyReports.id, { onDelete: 'cascade' }),
    sourceKind: readingSourceKindEnum('source_kind').notNull(),
    routeId: uuid('route_id').references(() => vehicleRoutes.id, { onDelete: 'restrict' }),
    waybillId: uuid('waybill_id').references(() => waybills.id, { onDelete: 'restrict' }),
    /** Снимок машины: по нему считаются расхождение и цепочка, а не по живому источнику. */
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    /** Копия дня отчёта: входит в ключ снимка и скреплена с шапкой внешним ключом. */
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    /**
     * Позиция смены машины в дне. Начальное значение назначает сервер (листы, затем рейсы), но
     * оно приближение: `vehicle_routes.num` говорит, когда рейс завели, а не когда машина выехала.
     * Поэтому позиция исправляется человеком — с причиной, историей и перестройкой цепочки.
     */
    shiftOrder: smallint('shift_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Источник занят ГЛОБАЛЬНО, а не внутри отчёта: рейс — один на портал, недельный лист — один
    // на день. Ограничение внутри отчёта пропускало бы тот же рейс во второй отчёт после
    // переназначения водителя, и один выезд закрывали бы двое.
    routeUnique: uniqueIndex('report_items_route_key')
      .on(t.routeId)
      .where(sql`${t.routeId} IS NOT NULL`),
    waybillUnique: uniqueIndex('report_items_waybill_key')
      .on(t.waybillId, t.reportDate)
      .where(sql`${t.waybillId} IS NOT NULL`),
    // Точка цепочки одна на машину, день и позицию смены. Ограничением, а не индексом: на время
    // перестановки позиций проверка откладывается до конца транзакции.
    chainUnique: unique('report_items_chain_key').on(t.vehicleId, t.reportDate, t.shiftOrder),
    // Цель составного внешнего ключа из показаний: копии снимка не должны расходиться.
    snapshotUnique: unique('report_items_snapshot_unique').on(
      t.id,
      t.reportId,
      t.vehicleId,
      t.reportDate,
      t.shiftOrder,
    ),
    // Цель ключа из журнала решений: решение отчёта A не ссылается на строку отчёта B.
    reportUnique: unique('report_items_report_unique').on(t.id, t.reportId),
    /**
     * День строки равен дню своего отчёта. Копия дня живёт здесь не ради чтения, а ради ключа
     * цепочки («машина + день + позиция») и составного ключа снимка: без неё строка ожидания
     * могла бы уехать в чужой день, а показание — сослаться на несуществующую пару.
     *
     * Зеркало, а не замок: копия обязана следовать за оригиналом, если день шапки когда-нибудь
     * изменится. Сегодня такой операции нет вовсе — отчёт заводится на дату и живёт с ней, а
     * перенос строки в другой день это `rebase`, то есть смена строки, а не даты, — но запрещать
     * правку ключом значило бы поручить ключу то, что уже обеспечено отсутствием операции.
     */
    reportDateFk: foreignKey({
      columns: [t.reportId, t.reportDate],
      foreignColumns: [driverDailyReports.id, driverDailyReports.reportDate],
      name: 'report_items_report_date_fk',
    }).onUpdate('cascade'),
    reportIdx: index('report_items_report_idx').on(t.reportId),
    /**
     * День всего парка (миграция 0148, Р22): «кто и что сдал 14 августа» — запрос, из которого
     * растёт реестр приёма. Ведущая колонка у `report_items_chain_key` другая (машина), и на этот
     * вопрос он не ложится. Заведён по замеру и вместе со своим потребителем: статистике он не
     * нужен вовсе (годовому запросу 0 %, месячному 3 %), а запросу одного дня даёт 20,5 → 7,3 мс.
     */
    dateIdx: index('report_items_date_idx').on(t.reportDate, t.vehicleId),
    sourceShape: check(
      'report_items_source_check',
      sql`(${t.sourceKind} = 'route') = (${t.routeId} IS NOT NULL)
        AND (${t.sourceKind} = 'esm2') = (${t.waybillId} IS NOT NULL)`,
    ),
    shiftOrderPositive: check('report_items_shift_order_check', sql`${t.shiftOrder} > 0`),
  }),
);

/**
 * Показание — одна строка на строку ожидания. Хранится снимок счётчика, а не работа за смену:
 * водитель списывает цифру с прибора, а не вычитает, и вычитание на его стороне — это ошибки,
 * которых потом не восстановить.
 */
export const vehicleReadings = pgTable(
  'vehicle_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => driverDailyReportItems.id, { onDelete: 'cascade' }),
    // Копии снимка: по ним идут цепочка и индексы. Составной ключ ниже не даёт им разойтись.
    reportId: uuid('report_id').notNull(),
    vehicleId: uuid('vehicle_id').notNull(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    shiftOrder: smallint('shift_order').notNull(),
    kind: readingKindEnum('kind').notNull(),
    odometerKm: integer('odometer_km'),
    engineHours: numeric('engine_hours', { precision: 9, scale: 1 }),
    /** ЗАПРАВЛЕНО за смену, не остаток в баке: расхода портал по этому полю не считает. */
    fuelFilledLiters: numeric('fuel_filled_liters', { precision: 7, scale: 1 }),
    noDataReason: text('no_data_reason').notNull().default(''),
    comment: text('comment').notNull().default(''),
    // Две независимые цепочки: строка с одними моточасами не разрывает ряд одометра.
    previousOdometerId: uuid('previous_odometer_id'),
    previousEngineHoursId: uuid('previous_engine_hours_id'),
    odometerAnomaly: readingAnomalyEnum('odometer_anomaly'),
    odometerAnomalyConfirmedBy: uuid('odometer_anomaly_confirmed_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    odometerAnomalyConfirmedAt: timestamp('odometer_anomaly_confirmed_at', { withTimezone: true }),
    engineHoursAnomaly: readingAnomalyEnum('engine_hours_anomaly'),
    engineHoursAnomalyConfirmedBy: uuid('engine_hours_anomaly_confirmed_by').references(
      () => users.id,
      { onDelete: 'restrict' },
    ),
    engineHoursAnomalyConfirmedAt: timestamp('engine_hours_anomaly_confirmed_at', {
      withTimezone: true,
    }),
    source: readingSourceEnum('source').notNull(),
    /** Когда нажали кнопку. Служебное: порядок задаёт `shift_order`, а не этот момент. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    itemUnique: uniqueIndex('vehicle_readings_item_key').on(t.itemId),
    chainIdx: index('vehicle_readings_chain_idx').on(
      t.vehicleId,
      t.reportDate.desc(),
      t.shiftOrder.desc(),
    ),
    reportIdx: index('vehicle_readings_report_idx').on(t.reportId),
    // Снимок один на двоих: подменить машину, отчёт, день или позицию в обход строки ожидания
    // нельзя, а исправленный порядок смены уезжает в показание сам (ON UPDATE CASCADE).
    snapshotFk: foreignKey({
      columns: [t.itemId, t.reportId, t.vehicleId, t.reportDate, t.shiftOrder],
      foreignColumns: [
        driverDailyReportItems.id,
        driverDailyReportItems.reportId,
        driverDailyReportItems.vehicleId,
        driverDailyReportItems.reportDate,
        driverDailyReportItems.shiftOrder,
      ],
      name: 'vehicle_readings_snapshot_fk',
    }).onUpdate('cascade'),
    valuesShape: check(
      'vehicle_readings_values_check',
      sql`(${t.kind} = 'values' AND ${t.noDataReason} = ''
            AND (${t.odometerKm} IS NOT NULL OR ${t.engineHours} IS NOT NULL
                 OR ${t.fuelFilledLiters} IS NOT NULL))
        OR (${t.kind} = 'no_data' AND ${t.odometerKm} IS NULL AND ${t.engineHours} IS NULL
            AND ${t.fuelFilledLiters} IS NULL AND btrim(${t.noDataReason}) <> '')`,
    ),
    nonNegative: check(
      'vehicle_readings_non_negative_check',
      sql`(${t.odometerKm} IS NULL OR ${t.odometerKm} >= 0)
        AND (${t.engineHours} IS NULL OR ${t.engineHours} >= 0)
        AND (${t.fuelFilledLiters} IS NULL OR ${t.fuelFilledLiters} >= 0)`,
    ),
    // Подтверждение бывает только у проставленной аномалии, и «кто» без «когда» подписью не
    // является — тот же приём, что у визы заявки и подписи смены.
    odometerAnomalyShape: check(
      'vehicle_readings_odometer_anomaly_check',
      sql`(${t.odometerAnomalyConfirmedBy} IS NULL) = (${t.odometerAnomalyConfirmedAt} IS NULL)
        AND (${t.odometerAnomaly} IS NOT NULL OR ${t.odometerAnomalyConfirmedAt} IS NULL)`,
    ),
    engineHoursAnomalyShape: check(
      'vehicle_readings_engine_hours_anomaly_check',
      sql`(${t.engineHoursAnomalyConfirmedBy} IS NULL) = (${t.engineHoursAnomalyConfirmedAt} IS NULL)
        AND (${t.engineHoursAnomaly} IS NOT NULL OR ${t.engineHoursAnomalyConfirmedAt} IS NULL)`,
    ),
  }),
);

/** Файлы показания: фото приборной панели и чеки. Как во всех модулях — файл не в двух местах. */
export const vehicleReadingFiles = pgTable(
  'vehicle_reading_files',
  {
    readingId: uuid('reading_id')
      .notNull()
      .references(() => vehicleReadings.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.readingId, t.fileId] }),
    fileUnique: uniqueIndex('vehicle_reading_files_file_unique').on(t.fileId),
  }),
);

/**
 * Журнал решений по расхождениям — append-only. Уникальности здесь нет вовсе: диспетчер вправе
 * передумать и на неизменном расхождении, а действует последнее событие по предмету.
 *
 * Последнее — по `reportVersionAfter`, а не по времени: всякая запись берёт отчёт `FOR UPDATE` и
 * двигает его версию, поэтому порядок причинный. `now()` для этого не годится — это время начала
 * транзакции.
 */
export const driverReportDiscrepancyResolutions = pgTable(
  'driver_report_discrepancy_resolutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => driverDailyReports.id, { onDelete: 'cascade' }),
    kind: discrepancyKindEnum('kind').notNull(),
    /**
     * Предмет: строка ожидания либо (у `missing_source`) сам источник, строки у которого нет.
     * Ссылка историческая: после переноса строки (`rebase`) она законно расходится с текущей
     * принадлежностью — решение остаётся там, где его приняли.
     */
    itemId: uuid('item_id').references(() => driverDailyReportItems.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id').references(() => vehicleRoutes.id, { onDelete: 'restrict' }),
    waybillId: uuid('waybill_id').references(() => waybills.id, { onDelete: 'restrict' }),
    /** `v1:<hash>` — с версией алгоритма: смена канонизации обесценивает решения заметно. */
    fingerprint: text('fingerprint').notNull(),
    resolution: discrepancyResolutionEnum('resolution').notNull(),
    reason: text('reason').notNull(),
    reportVersionAfter: integer('report_version_after').notNull(),
    resolvedBy: uuid('resolved_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemIdx: index('discrepancy_resolutions_item_idx')
      .on(t.reportId, t.kind, t.itemId, t.reportVersionAfter.desc())
      .where(sql`${t.itemId} IS NOT NULL`),
    routeIdx: index('discrepancy_resolutions_route_idx')
      .on(t.reportId, t.routeId, t.reportVersionAfter.desc())
      .where(sql`${t.itemId} IS NULL AND ${t.routeId} IS NOT NULL`),
    waybillIdx: index('discrepancy_resolutions_waybill_idx')
      .on(t.reportId, t.waybillId, t.reportVersionAfter.desc())
      .where(sql`${t.itemId} IS NULL AND ${t.waybillId} IS NOT NULL`),
    subjectShape: check(
      'discrepancy_resolutions_subject_check',
      sql`(${t.kind} = 'missing_source') = (${t.itemId} IS NULL)
        AND (${t.kind} = 'missing_source'
             OR (${t.routeId} IS NULL AND ${t.waybillId} IS NULL))
        AND (${t.kind} <> 'missing_source'
             OR ((${t.routeId} IS NULL) <> (${t.waybillId} IS NULL)))`,
    ),
    // Добавить источник можно только там, где его не хватает.
    resolutionShape: check(
      'discrepancy_resolutions_resolution_check',
      sql`(${t.resolution} <> 'source_added' OR ${t.kind} = 'missing_source')
        AND btrim(${t.reason}) <> '' AND ${t.reportVersionAfter} > 0`,
    ),
  }),
);

/**
 * История отчёта. Пишется той же транзакцией, что и правка: `writeAudit` намеренно проглатывает
 * сбой записи, и учётное число изменилось бы без следа.
 */
export const driverDailyReportHistory = pgTable(
  'driver_daily_report_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => driverDailyReports.id, { onDelete: 'cascade' }),
    event: reportEventEnum('event').notNull(),
    payload: jsonb('payload').notNull().default({}),
    reason: text('reason').notNull().default(''),
    /** Обе версии: содержательная — «что изменилось», версия отчёта — «в каком порядке». */
    contentVersion: integer('content_version').notNull(),
    reportVersion: integer('report_version').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reportIdx: index('driver_daily_report_history_idx').on(t.reportId, t.changedAt),
  }),
);

/** История показания: before/after, причина и версия после события. */
export const vehicleReadingHistory = pgTable(
  'vehicle_reading_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    readingId: uuid('reading_id')
      .notNull()
      .references(() => vehicleReadings.id, { onDelete: 'cascade' }),
    event: readingEventEnum('event').notNull(),
    before: jsonb('before').notNull().default({}),
    after: jsonb('after').notNull().default({}),
    /** Обязательна при правке персоналом: чужое число меняют с объяснением. */
    reason: text('reason').notNull().default(''),
    version: integer('version').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    readingIdx: index('vehicle_reading_history_idx').on(t.readingId, t.changedAt),
  }),
);

export type DriverDailyReportRow = typeof driverDailyReports.$inferSelect;
export type DriverDailyReportItemRow = typeof driverDailyReportItems.$inferSelect;
export type VehicleReadingRow = typeof vehicleReadings.$inferSelect;
export type DriverReportDiscrepancyResolutionRow =
  typeof driverReportDiscrepancyResolutions.$inferSelect;
export type DriverDailyReportHistoryRow = typeof driverDailyReportHistory.$inferSelect;
export type VehicleReadingHistoryRow = typeof vehicleReadingHistory.$inferSelect;

// ── Техобслуживание по пробегу (миграция 0147) ──

/**
 * Запись ТО — акт обслуживания машины (Р10). Хранится история целиком, а не «дата последнего ТО» у
 * карточки: одно поле не отвечает ни на один вопрос, ради которого журнал заводят, — с каким
 * пробегом обслуживали, по какому документу и что было до этого.
 *
 * `odometerKm` допускает NULL: акт бывает без пробега (прибор не работал), и это отсутствие якоря
 * расчёта, а не ноль (Р11а). Ноль в учёте счётчика — ложь, и посчитанный от него «пробег с ТО»
 * равнялся бы всему пробегу машины за её жизнь.
 *
 * Уникальности по `(vehicleId, performedOn)` нет намеренно: два ТО в один день — редкость, но
 * запрет означал бы, что ошибку ввода даты исправляют только удалением записи, то есть потерей
 * скана и истории. Порядок задаёт индекс (Р30).
 */
export const vehicleMaintenance = pgTable(
  'vehicle_maintenance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // RESTRICT, как у всех учётных ссылок на технику: акт переживает вывод машины из парка.
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    /** Дата без времени: у акта его нет — отсюда правило расчёта Р11б (день ТО в сумму не идёт). */
    performedOn: date('performed_on', { mode: 'string' }).notNull(),
    /** Реквизит акта и граничный якорь расчёта (Р11а); NULL — «пробега в акте нет». */
    odometerKm: integer('odometer_km'),
    documentNumber: text('document_number').notNull().default(''),
    note: text('note').notNull().default(''),
    /** Оптимистическая блокировка правки и удаления (Р30). */
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Аннулирование акта (`docs/auto-parts-plan.md` Р6, миграция 0188). Появилось вместе с
     * расходом автозапчастей и решает не вопрос интерфейса, а вопрос РАСЧЁТА: ошибочный акт,
     * который нельзя удалить (по нему прошло движение склада), оставался бы последним
     * обслуживанием машины, и «пробег с ТО» считался бы от ложного якоря — машина, которую пора
     * обслуживать, показывала бы «в норме».
     *
     * `null` — акт действующий. Аннулированный выпадает из «последнего ТО», `kmSince`, состояния и
     * снапшота гаража, не правится и повторно не аннулируется (409), но в истории виден: на него
     * ссылается журнал склада, и спрятать документ нельзя.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    /** `restrict`, как остальные авторы акта: «кто аннулировал» обязано пережить увольнение. */
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Причина аннулирования. Пустая строка, а не `null`, у действующего акта: поле заполнено
     * всегда, и второе представление «причины нет» пришлось бы отличать в каждом чтении.
     */
    voidReason: text('void_reason').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * Порядок истории машины (Р30). Три колонки после машины, а не одна дата: два ТО в один день
     * ключом `performedOn` неразличимы, и «последнее» зависело бы от порядка чтения строк. `id`
     * замыкает порядок — `createdAt` у двух записей одной транзакции совпадает.
     */
    vehicleIdx: index('vehicle_maintenance_vehicle_idx').on(
      t.vehicleId,
      t.performedOn.desc(),
      t.createdAt.desc(),
      t.id.desc(),
    ),
    /**
     * Порядок ДЕЙСТВУЮЩЕЙ истории. Колонки те же, что у `vehicleIdx`, и это не дубликат: тот
     * обслуживает историю целиком, где аннулированные акты обязаны быть видны, а этот — три
     * вопроса расчёта («последнее ТО», пробег с обслуживания, снапшот гаража), в которых они не
     * участвуют вовсе (Р6). Условие `voidedAt IS NULL` стоит в трёх запросах сразу, и разойдись
     * хоть один — расчёт молча вернулся бы к ложному якорю.
     */
    activeIdx: index('vehicle_maintenance_active_idx')
      .on(t.vehicleId, t.performedOn.desc(), t.createdAt.desc(), t.id.desc())
      .where(sql`${t.voidedAt} IS NULL`),
    // Отрицательный пробег — единственное, что база про одометр акта знает наверняка: монотонности
    // не требуется, замена прибора законна (Р11а).
    odometerNonNegative: check(
      'vehicle_maintenance_odometer_check',
      sql`${t.odometerKm} IS NULL OR ${t.odometerKm} >= 0`,
    ),
    versionNonNegative: check('vehicle_maintenance_version_check', sql`${t.version} >= 0`),
    // Три поля аннулирования — одно состояние: «аннулирован, но неизвестно кем» стало бы законной
    // записью, а спросить с неё было бы некого.
    voidedPair: check(
      'vehicle_maintenance_voided_pair_check',
      sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL)`,
    ),
    // Причина есть ровно у аннулированного: пустая у него — «аннулировали и не сказали зачем», а
    // непустая у действующего — текст, который никто не прочитает и который через год примут за
    // признак аннулирования.
    voidReasonPresence: check(
      'vehicle_maintenance_void_reason_check',
      sql`(${t.voidedAt} IS NULL AND btrim(${t.voidReason}) = '')
          OR (${t.voidedAt} IS NOT NULL AND btrim(${t.voidReason}) <> '')`,
    ),
  }),
);

/**
 * Скан акта. По образцу `vehicleReadingFiles` — файл живёт максимум в одном месте, а сама связь
 * названа в `file_is_linked` той же миграцией (0147): не названная там таблица означает, что
 * уборка сочтёт подшитый акт сиротой и снесёт его из хранилища.
 */
export const vehicleMaintenanceFiles = pgTable(
  'vehicle_maintenance_files',
  {
    maintenanceId: uuid('maintenance_id')
      .notNull()
      .references(() => vehicleMaintenance.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.maintenanceId, t.fileId] }),
    fileUnique: uniqueIndex('vehicle_maintenance_files_file_unique').on(t.fileId),
  }),
);

export type VehicleMaintenanceRow = typeof vehicleMaintenance.$inferSelect;

// ── История назначения заявки (миграции 0166 и 0167, план `docs/assignment-periods-plan.md` §6) ──
//
// Вторая шкала рядом с назначением (`vehicle_request_assignments`). Снимок назначения отвечает
// только на «что стоит сейчас»: смена машины посреди срока переписывает его, и прошлое становится
// неотличимо от настоящего — а бумага прошлого выписана на прежнюю машину и прежнего человека.
// Здесь же строка появляется в день, с которого изменение действует, и прежние строки не
// переписываются никогда: правка гасит старую строку и вставляет новую (Р3).
//
// Пишет и читает эти таблицы этап 3; на момент миграций 0166/0167 в них не ходит никто — схема
// уезжает в прод раньше кода, который её использует.

/**
 * Изменение назначения: «с этого числа на заявке эта машина» либо «с этого числа этот машинист».
 *
 * Конца у строки нет — его задаёт следующая строка той же шкалы либо конец срока работ. Пара
 * «с — по» держала бы два источника правды об одной границе и требовала чинить их согласованность
 * руками при каждой вставке в середину.
 */
export const vehicleRequestAssignmentChanges = pgTable(
  'vehicle_request_assignment_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    /** Дата, С КОТОРОЙ изменение действует. */
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    /** Шкала: техника и машинист меняются независимо друг от друга (Р16). */
    dimension: text('dimension').$type<AssignmentDimension>().notNull(),
    /**
     * RESTRICT у обеих ссылок: «кем и на чём работали» обязано пережить вывод машины из парка и
     * увольнение человека — ровно так же держит их снимок листа.
     */
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'restrict' }),
    driverPersonId: uuid('driver_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    /**
     * Состояние шкалы машиниста (Р19): `set` — назначен, `cleared` — снят осознанно (арендный
     * отрезок), `unknown` — история не знает. «Не менялось» выражается отсутствием строки, а не
     * состоянием: иначе у одного факта было бы два представления.
     */
    driverState: text('driver_state').$type<DriverStateKind>(),
    /**
     * Происхождение строки — признак, по которому команды находят свои строки: отмена заполнения
     * ищет группу по `known_fill`, решение хвоста — по `tail_resolution`. Тот же список выписан в
     * контрактах (`ASSIGNMENT_CHANGE_ORIGINS`) и в CHECK'е таблицы.
     */
    origin: text('origin').$type<AssignmentChangeOrigin>().notNull(),
    /**
     * Строки, рождённые ОДНИМ решением: vehicle-изменение и порождённые им driver-строки, решение
     * хвоста целиком, пара заполнения. Гашение всегда групповое (В2): погасив одну строку, мы
     * оставили бы её спутника, который оживёт при следующем продлении срока.
     */
    changeGroupId: uuid('change_group_id').notNull().defaultRandom(),
    /** Операция журнала коррекций, породившая строку; NULL — обычная работа без бумаги задним числом. */
    correctionId: uuid('correction_id').references(() => waybillCorrections.id, {
      onDelete: 'restrict',
    }),
    /**
     * NULL — строку написал бэкфилл: у восстановленной по бумаге истории автора нет, и приписывать
     * её запустившему скрипт значило бы называть автором решения того, кто его не принимал.
     */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    /**
     * Строка, которую эта заменила (Р3). Ссылка обратная: прямую «старая → новая» нельзя записать
     * ни в каком порядке, пока частичный UNIQUE держит одну актуальную строку на шкалу и дату.
     */
    supersedesChangeId: uuid('supersedes_change_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededByUser: uuid('superseded_by_user').references(() => users.id, {
      onDelete: 'restrict',
    }),
    supersededKind: text('superseded_kind').$type<AssignmentSupersedeKind>(),
  },
  (t) => ({
    dimensionValues: check(
      'vehicle_request_assignment_changes_dimension_check',
      sql`${t.dimension} IN ('vehicle', 'driver')`,
    ),
    driverStateValues: check(
      'vehicle_request_assignment_changes_driver_state_check',
      sql`${t.driverState} IN ('set', 'cleared', 'unknown')`,
    ),
    originValues: check(
      'vehicle_request_assignment_changes_origin_check',
      sql`${t.origin} IN ('assignment', 'reassignment', 'machinist_change', 'backfill',
                          'tail_resolution', 'known_fill', 'unknown_remainder')`,
    ),
    supersededKindValues: check(
      'vehicle_request_assignment_changes_superseded_kind_check',
      sql`${t.supersededKind} IN ('replaced', 'cancelled')`,
    ),
    // Состав строки задаётся шкалой целиком, и человек назван тогда и только тогда, когда
    // состояние `set`. Четвёртого сочетания («не знаем, но человек назван») не существует: именно
    // оно превратило бы `unknown` из признания неполноты в мнение.
    valueCheck: check(
      'vehicle_request_assignment_changes_value_check',
      sql`(${t.dimension} = 'vehicle' and ${t.vehicleId} is not null
            and ${t.driverPersonId} is null and ${t.driverState} is null)
          or (${t.dimension} = 'driver' and ${t.vehicleId} is null
            and ${t.driverState} is not null
            and (${t.driverState} = 'set') = (${t.driverPersonId} is not null))`,
    ),
    // Строка либо актуальна, либо погашена, названа кем и как: все три колонки идут вместе.
    supersedeCheck: check(
      'vehicle_request_assignment_changes_supersede_check',
      sql`(${t.supersededAt} is null and ${t.supersededByUser} is null
            and ${t.supersededKind} is null)
          or (${t.supersededAt} is not null and ${t.supersededByUser} is not null
            and ${t.supersededKind} is not null)`,
    ),
    selfCheck: check(
      'vehicle_request_assignment_changes_self_check',
      sql`${t.supersedesChangeId} is null or ${t.supersedesChangeId} <> ${t.id}`,
    ),
    // `unknown` — признание неполноты, и завести его человеку нечем (Р19). Источников два: бэкфилл
    // и производный остаток заполнения (Ш4), у которого `correction_id`, наоборот, обязателен —
    // граница рождается внутри коррекции и без автора появиться не может.
    unknownCheck: check(
      'vehicle_request_assignment_changes_unknown_check',
      sql`${t.driverState} <> 'unknown'
          or (${t.origin} = 'backfill' and ${t.correctionId} is null)
          or (${t.origin} = 'unknown_remainder' and ${t.correctionId} is not null)`,
    ),
    // Обратное направление (Щ3): origin остатка не встречается нигде, кроме `unknown`. Без него
    // `set` или vehicle-строка надели бы его и проскользнули мимо ослабленного индекса группы.
    remainderCheck: check(
      'vehicle_request_assignment_changes_remainder_check',
      sql`${t.origin} <> 'unknown_remainder'
          or (${t.dimension} = 'driver' and ${t.driverState} = 'unknown'
              and ${t.correctionId} is not null)`,
    ),
    // Провенанс заполнения (Ю2): по составу строк группу заполнения не отличить от обычной смены
    // машиниста, и отмена «по составу» превратила бы известного человека обратно в `unknown`.
    knownFillCheck: check(
      'vehicle_request_assignment_changes_known_fill_check',
      sql`${t.origin} <> 'known_fill'
          or (${t.dimension} = 'driver' and ${t.driverState} = 'set'
              and ${t.driverPersonId} is not null and ${t.correctionId} is not null)`,
    ),
    /**
     * Цель составного FK ниже: замена физически привязана к той же заявке, шкале и дате. Без этих
     * трёх колонок в ключе строка могла бы объявить заменённой чужую — соседней заявки или другой
     * шкалы. Перенос даты выражается парой «cancel + set» (Р13).
     */
    identityUnique: unique('vehicle_request_assignment_changes_identity_unique').on(
      t.id,
      t.requestId,
      t.dimension,
      t.effectiveDate,
    ),
    supersedesFk: foreignKey({
      columns: [t.supersedesChangeId, t.requestId, t.dimension, t.effectiveDate],
      foreignColumns: [t.id, t.requestId, t.dimension, t.effectiveDate],
      name: 'vehicle_request_assignment_changes_supersedes_fk',
    }),
    /**
     * Главный инвариант модели: одна действующая строка на шкалу и дату. Свёртка читает «последнюю
     * строку не позже даты», и две актуальные строки на одну дату дали бы два ответа на вопрос, на
     * который бумага отвечает однозначно.
     */
    actualUnique: uniqueIndex('vehicle_request_assignment_changes_actual_unique')
      .on(t.requestId, t.dimension, t.effectiveDate)
      .where(sql`${t.supersededAt} is null`),
    // Замена достаётся ровно одной наследнице: иначе цепочка правок ветвится и «что действует»
    // теряется.
    supersedesUnique: uniqueIndex('vehicle_request_assignment_changes_supersedes_unique')
      .on(t.supersedesChangeId)
      .where(sql`${t.supersedesChangeId} is not null`),
    /**
     * Группа решения (Р31): её читают гашение при сокращении срока, отмена заполнения и решение
     * хвоста. Он же покрывает выборки по заявке — ведёт по `request_id` первой колонкой. Отдельного
     * индекса `(request_id, effective_date)` нет: замер волны 2.1 на 240 тысячах строк не нашёл
     * разницы (причина выписана в миграции `0166`).
     */
    groupIdx: index('vehicle_request_assignment_changes_group_idx').on(
      t.requestId,
      t.changeGroupId,
    ),
    /**
     * Одна актуальная строка на шкалу внутри группы **этой заявки**. Заявка в ключе не для
     * скорости: без неё ограничение читалось бы как «одна строка на шкалу в группе во всём
     * портале», а группа принадлежит заявке (найдено волной 3.1). Исключение по `origin` — для
     * заполнения `unknown` (Щ1): его группа это ДВЕ driver-строки, `set` на начале отрезка и
     * граница `unknown` за его концом.
     */
    groupDimensionUnique: uniqueIndex('vehicle_request_assignment_changes_group_dimension_unique')
      .on(t.requestId, t.changeGroupId, t.dimension)
      .where(sql`${t.supersededAt} is null and ${t.origin} <> 'unknown_remainder'`),
    // Исключённые строки не остаются вовсе без счёта (Э3): остаток нормативно один на группу.
    groupRemainderUnique: uniqueIndex('vehicle_request_assignment_changes_group_remainder_unique')
      .on(t.requestId, t.changeGroupId)
      .where(sql`${t.supersededAt} is null and ${t.origin} = 'unknown_remainder'`),
  }),
);

export type VehicleRequestAssignmentChangeRow = typeof vehicleRequestAssignmentChanges.$inferSelect;

// ── Управляющий контур модуля (миграция 0167) ──

/**
 * Поколение теневого сравнения: `building` → seal → `running` → finalize → `completed` | `failed`.
 *
 * Печать (seal) существует ради того, чтобы поколение с наполовину построенным manifest'ом не
 * объявило себя завершённым: 90 целей из ста, все сошлись, `pending` нет.
 */
export const assignmentShadowRuns = pgTable(
  'assignment_shadow_runs',
  {
    runId: uuid('run_id').primaryKey().defaultRandom(),
    status: text('status').$type<'building' | 'running' | 'completed' | 'failed'>().notNull(),
    /** Прогон, переживший полночь, начинается заново (О3): календарь двигает валидность сам. */
    asOf: date('as_of', { mode: 'string' }).notNull(),
    /** Чем именно получен результат: без этого доказательство cutover ничего не доказывает. */
    algoVersion: text('algo_version').notNull(),
    buildVersion: text('build_version').notNull(),
    expectedChecks: integer('expected_checks').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    statusValues: check(
      'assignment_shadow_runs_status_check',
      sql`${t.status} IN ('building', 'running', 'completed', 'failed')`,
    ),
    expectedNonNegative: check(
      'assignment_shadow_runs_expected_checks_check',
      sql`${t.expectedChecks} >= 0`,
    ),
    // Завершённое поколение обязано иметь время конца, работающее — не иметь.
    finishCheck: check(
      'assignment_shadow_runs_finish_check',
      sql`(${t.status} in ('building', 'running')) = (${t.finishedAt} is null)`,
    ),
  }),
);

/**
 * Режимы модуля: строка ровно одна, и через неё проходит весь автомат — заморозка, разморозка,
 * включение и выключение чтения истории.
 *
 * Правит её только административная дверь (maintenance-сервис своими кредами); приложение получает
 * `SELECT` и `UPDATE (lock_tick)` — и второе не ради записи, а ради права взять
 * `SELECT ... FOR SHARE`: PostgreSQL требует `UPDATE` хотя бы на одну колонку для любой
 * блокирующей формы SELECT (Ц1). Саму запись в `lock_tick` запрещает триггер.
 */
export const assignmentPeriodsControl = pgTable(
  'assignment_periods_control',
  {
    /** Одиночка: строка ровно одна, вторую запрещает первичный ключ с CHECK. */
    id: boolean('id').primaryKey().default(true),
    /**
     * Режим записи, а не булев freeze (И1): `history_frozen` останавливает двери, меняющие
     * историю, `all_frozen` — всё пишущее, и только под ним разрешены cutover и возврат.
     */
    writeMode: text('write_mode')
      .$type<'normal' | 'history_frozen' | 'all_frozen'>()
      .notNull()
      .default('normal'),
    /** Откуда читатели берут «кто и на чём работал». Переключается отдельно от записи и позже неё. */
    readMode: text('read_mode').$type<'legacy' | 'history'>().notNull().default('legacy'),
    /** Каким поколением теневого сравнения разрешено переключение (М1). */
    cutoverRunId: uuid('cutover_run_id').references(() => assignmentShadowRuns.runId, {
      onDelete: 'restrict',
    }),
    /** Техническая колонка блокировки (Ц1, Ш1): не читается никем и не меняется никогда. */
    lockTick: smallint('lock_tick').notNull().default(0),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: updatedAt(),
  },
  (t) => ({
    singleton: check('assignment_periods_control_id_check', sql`${t.id}`),
    writeModeValues: check(
      'assignment_periods_control_write_mode_check',
      sql`${t.writeMode} IN ('normal', 'history_frozen', 'all_frozen')`,
    ),
    readModeValues: check(
      'assignment_periods_control_read_mode_check',
      sql`${t.readMode} IN ('legacy', 'history')`,
    ),
    // Условие одностороннее: возврат в `legacy` не обязан стирать ссылку и уничтожать аудит того,
    // чем история была включена.
    cutoverCheck: check(
      'assignment_periods_control_cutover_check',
      sql`${t.readMode} <> 'history' or ${t.cutoverRunId} is not null`,
    ),
  }),
);

/**
 * Manifest целей поколения (К1): строки заводятся ЗАРАНЕЕ, по одной на каждую ожидаемую цель, и
 * worker только переводит их в `match`/`mismatch`. Лишнюю область записать некуда — строки нет, а
 * пропущенная останется `pending` и не даст завершить поколение.
 */
export const assignmentShadowChecks = pgTable(
  'assignment_shadow_checks',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => assignmentShadowRuns.runId, { onDelete: 'cascade' }),
    /**
     * Значение, а не внешний ключ (Н3-узкое): удаление заявки не вправе менять завершённое
     * поколение — доказательство cutover обязано быть неизменяемым.
     */
    requestId: uuid('request_id').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    /**
     * Результат одной строкой (К2): раздельные «факт проверки» и «расхождение» расходились, если
     * worker падал между двумя вставками, — поколение выглядело зелёным.
     */
    status: text('status').$type<'pending' | 'match' | 'mismatch'>().notNull().default('pending'),
    evaluationFingerprint: text('evaluation_fingerprint'),
    details: jsonb('details'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.requestId, t.scopeFingerprint] }),
    statusValues: check(
      'assignment_shadow_checks_status_check',
      sql`${t.status} IN ('pending', 'match', 'mismatch')`,
    ),
    resultCheck: check(
      'assignment_shadow_checks_result_check',
      sql`case ${t.status}
            when 'pending'  then ${t.checkedAt} is null and ${t.evaluationFingerprint} is null
                                 and ${t.details} is null
            when 'match'    then ${t.checkedAt} is not null
                                 and ${t.evaluationFingerprint} is not null
            when 'mismatch' then ${t.checkedAt} is not null
                                 and ${t.evaluationFingerprint} is not null
                                 and ${t.details} is not null
          end`,
    ),
  }),
);

/**
 * Аттестация деплоя (О4, Р3): что именно раскатано на момент cutover — со стороны деплоя, а не со
 * слов нажимающего кнопку.
 *
 * SQL-функция не знает ни `BUILD_SHA` вызывающего процесса, ни инвентаря, ни метрики старых
 * клиентов. Строку пишет job деплоя, потребляет job cutover: одна кнопка, которая и подтверждает,
 * и использует, возвращает круговую проверку Н3.
 */
export const assignmentDeployAttestations = pgTable(
  'assignment_deploy_attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attestedAt: timestamp('attested_at', { withTimezone: true }).notNull().defaultNow(),
    /** Во время раската сборок законно две — переключаться можно, когда обе умеют читать историю. */
    activeBuildShas: text('active_build_shas').array().notNull(),
    algoVersion: text('algo_version').notNull(),
    /** Вызовы старого широкого маршрута с датами (И5): ноль — условие перехода. */
    legacyClientCalls: integer('legacy_client_calls').notNull(),
    /** Связь односторонняя (П3): «каким переходом потреблена» читается из журнала переходов. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    buildsNotEmpty: check(
      'assignment_deploy_attestations_active_build_shas_check',
      sql`array_length(${t.activeBuildShas}, 1) >= 1`,
    ),
    callsNonNegative: check(
      'assignment_deploy_attestations_legacy_client_calls_check',
      sql`${t.legacyClientCalls} >= 0`,
    ),
  }),
);

/**
 * Журнал переходов режима (Н2, О5) — append-only физически: правку и удаление отклоняет триггер.
 *
 * Соглашения тут мало: журнал и есть доказательство «чем и когда разрешён переход», а
 * доказательство, которое можно поправить, ничего не доказывает.
 */
export const assignmentPeriodsModeTransitions = pgTable(
  'assignment_periods_mode_transitions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** RESTRICT: «кто разрешил» обязано пережить увольнение. */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Обе стороны обоих режимов: журнал восстанавливает автомат целиком, а не «чем кончилось». */
    fromReadMode: text('from_read_mode').notNull(),
    toReadMode: text('to_read_mode').notNull(),
    fromWriteMode: text('from_write_mode').notNull(),
    toWriteMode: text('to_write_mode').notNull(),
    runId: uuid('run_id').references(() => assignmentShadowRuns.runId, { onDelete: 'restrict' }),
    attestationId: uuid('attestation_id').references(() => assignmentDeployAttestations.id, {
      onDelete: 'restrict',
    }),
    /** Те же значения, что в аттестации: её потребляют однажды, а журнал читают годами. */
    buildSha: text('build_sha').notNull(),
    algoVersion: text('algo_version').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => ({
    reasonNotBlank: check(
      'assignment_periods_mode_transitions_reason_check',
      sql`btrim(${t.reason}) <> ''`,
    ),
    /**
     * Активация истории обязана опираться на поколение и аттестацию (О4). Обратный переход в
     * `legacy` — нет: возврат бывает аварийным, и требовать от него поколения значило бы запирать
     * откат ровно тогда, когда он нужен.
     *
     * Условие проверяет **переход**, а не состояние после него (миграция `0201`). Прежняя редакция
     * смотрела на одно `to_read_mode` — и запирала разморозку после cutover: к третьему шагу
     * чтение уже `history`, а поколения у перехода записи нет и быть не может. Портал оставался
     * замороженным, и снять заморозку было нечем. Нашла репетиция на копии базы.
     */
    historyCheck: check(
      'assignment_periods_mode_transitions_history_check',
      sql`${t.fromReadMode} = ${t.toReadMode}
          or ${t.toReadMode} <> 'history'
          or (${t.runId} is not null and ${t.attestationId} is not null)`,
    ),
    /**
     * Одна аттестация — один переход, физически. Однократность держали `consumed_at` и `FOR UPDATE`
     * в двери, но дверь — код, который меняют; смысл же аттестации в том, что переключение чтения
     * разрешено ОДНИМ проверенным раскатом, и второй переход по той же бумаге означал бы, что
     * вторую проверку заменили ссылкой на первую.
     */
    attestationUnique: uniqueIndex('assignment_periods_mode_transitions_attestation_unique')
      .on(t.attestationId)
      .where(sql`${t.attestationId} is not null`),
  }),
);

export type AssignmentPeriodsControlRow = typeof assignmentPeriodsControl.$inferSelect;
export type AssignmentShadowRunRow = typeof assignmentShadowRuns.$inferSelect;
export type AssignmentShadowCheckRow = typeof assignmentShadowChecks.$inferSelect;
export type AssignmentDeployAttestationRow = typeof assignmentDeployAttestations.$inferSelect;
export type AssignmentPeriodsModeTransitionRow =
  typeof assignmentPeriodsModeTransitions.$inferSelect;

// ── Автозапчасти: склад гаража и расход по обслуживанию (миграции 0187 и 0188) ──
//
// План — `docs/auto-parts-plan.md`. Приём «остаток не врёт» перенесён целиком с расходников
// оргтехники (Р3): событие вместо поля формы, неизменяемый журнал, три триггера. Предмет назван
// «автозапчастью», а не «запчастью», потому что слово уже занято сметой заявок оргтехники
// (`serviceRequestItems.kind = 'part'`), а вопрос «сколько ушло запчастей» задают одинаковыми
// словами про разные вещи (Р1).

/**
 * Складская позиция гаража (Р2, Р9, Р12): что лежит на складе и сколько.
 *
 * Склад ВИРТУАЛЬНЫЙ — остаток одно число, мест хранения нет: заказчик сказал прямо, что наличие
 * есть, если есть штуки, и таблица `warehouses` в портале описывает склады поставщиков (ADR 0051),
 * а не свой. Переезд к местам хранения, если однажды понадобится, будет расширением журнала (у
 * события появится место), а не переделкой карточки.
 *
 * Идентичность держит ПАРА «наименование + артикул», и обе половины по отдельности не годятся
 * (Р12): «Фильтр масляный» разных производителей с разными артикулами — законные разные позиции, а
 * два «Ремня генератора» без артикула — двойник, которого надо отбить. Артикул при этом
 * необязателен: требовать его значило бы запретить механику завести позицию до того, как
 * бухгалтерия пришлёт номенклатуру.
 */
export const autoParts = pgTable(
  'auto_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Артикул: «21126-1006040», «MANNW914/2». Необязателен (Р12) — главное отличие от расходников
     * оргтехники, где код приезжает выгрузкой из учётной системы и потому обязателен. Хранится
     * уже нормализованным: в верхнем регистре и без пробелов, включая неразрывные.
     */
    code: text('code'),
    /**
     * Наименование ДОСЛОВНО, как его написал механик. Нормализуется только ключ (`auto_part_name_key`),
     * по которому ищут двойника, а не хранимое значение: поднятый регистр на экране был бы криком.
     */
    name: text('name').notNull(),
    /**
     * Единица измерения (Р9). У расходников оргтехники её нет вовсе — «(шт)» живёт внутри
     * наименования, потому что оно дословно из учётной системы. Здесь так нельзя: на складе гаража
     * лежат штуки, литры, комплекты и метры, и «5» без единицы — не число, а загадка. Текстом, а не
     * перечнем: набор единиц заранее неизвестен, а на счёт единица не влияет — она подписывает
     * число, а не участвует в нём.
     */
    unit: text('unit').notNull().default('шт'),
    /**
     * Остаток. Правится не формой карточки, а своей ручкой `POST /auto-parts/:id/stock` с
     * `expectedQuantity` (Р3) и разницей строк акта (Р5) — и это не соглашение маршрута: прямой
     * `UPDATE` мимо журнала отбивает отложенный триггер `auto_part_stock_covered` на этой таблице.
     * Количество ЦЕЛОЕ, подтверждено заказчиком: канистры и литры считают целыми (Р9).
     */
    quantity: integer('quantity').notNull().default(0),
    /**
     * Гашение вместо удаления (Р11). Погашенная позиция в подбор не попадает и новой строкой акта
     * не добавляется, но уже стоящую строку можно уменьшить или снять (Р24) — это возврат на склад,
     * и запрещать его незачем.
     */
    isActive: boolean('is_active').notNull().default(true),
    comment: text('comment').notNull().default(''),
    /** `set null`, как у карточек техники: справочник переживает увольнение своего автора. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Не только реквизит: это ориентир предупреждения о двойном списании (Р20). Открывающий
     * остаток вводят числом «сколько лежит сейчас», и в нём уже учтено установленное раньше;
     * значит строка в акте, датированном РАНЬШЕ заведения позиции, может списать одну и ту же
     * деталь дважды. Портал предупреждает — не запрещает: заказчик выбрал свободу ввода задним
     * числом.
     */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Правила написания живут IMMUTABLE-функциями базы, а не выражениями на месте и не копией на
    // TypeScript: ключ нужен уникальному индексу, `CHECK` и маршруту, который обязан ответить
    // «позиция с таким артикулом уже заведена», а не 500 с именем индекса. Разойдись они хоть на
    // символ — маршрут перестанет находить то, что отвергает индекс.
    //
    // Функции СВОИ, а не общие с расходниками оргтехники (Р12): правила сегодня совпадают, но
    // хозяева разные, и первая же правка чужого модуля ради дословного регистра из выгрузки молча
    // изменила бы уникальность здесь — причём построенный индекс продолжил бы считать по-старому.
    codeNotBlank: check(
      'auto_parts_code_not_blank_check',
      sql`${t.code} IS NULL OR auto_part_code_key(${t.code}) <> ''`,
    ),
    // Артикул лежит уже нормализованным. Без этой проверки правило держал бы только индекс, то есть
    // ключ, — а в карточке остался бы «mann w914 /2 » с хвостом и внутренним пробелом: уникальность
    // соблюдена, дефект тихий, и ломает он сверку глазами с прайсом.
    codeNormalized: check(
      'auto_parts_code_normalized_check',
      sql`${t.code} IS NULL OR ${t.code} = auto_part_code_key(${t.code})`,
    ),
    // Пустоту имени меряет КЛЮЧ, а не `btrim`: `btrim` неразрывный пробел не снимает, и имя из
    // одних U+00A0 — а приезжают они из Word и Excel постоянно — встало бы в справочник строкой,
    // которую на экране не отличить от пустой: с артикулом, остатком и разметкой, но без имени.
    nameNotBlank: check(
      'auto_parts_name_not_blank_check',
      sql`auto_part_name_key(${t.name}) <> ''`,
    ),
    // Единице `btrim` достаточен: от неё не требуется ни ключа, ни уникальности, и вопрос к ней
    // ровно один — «написано ли хоть что-нибудь».
    unitNotBlank: check('auto_parts_unit_not_blank_check', sql`btrim(${t.unit}) <> ''`),
    // Отрицательный остаток не бывает даже промежуточно (Р7): «минус два фильтра» — не долг, а
    // ошибка ввода. Маршрут отвечает 409 «на складе 3, списываете 5» до того, как это сработает.
    quantityNonNegative: check('auto_parts_quantity_check', sql`${t.quantity} >= 0`),
    // Артикул уникален, КОГДА ОН ЕСТЬ. Частичность здесь говорит словами то, что иначе держалось бы
    // на знании тонкости про неконфликтующие `NULL`.
    codeUnique: uniqueIndex('auto_parts_code_unique')
      .on(sql`auto_part_code_key(${t.code})`)
      .where(sql`${t.code} IS NOT NULL`),
    // `coalesce(..., '')` превращает «артикула нет» в значение, которое индекс умеет сравнивать:
    // без него безартикульные строки снова перестали бы конфликтовать, и правило пары не работало
    // бы ровно там, ради чего заведено. Пустая строка на месте артикула безопасна — в саму колонку
    // её не пускает `codeNotBlank`.
    nameCodeUnique: uniqueIndex('auto_parts_name_code_unique').on(
      sql`auto_part_name_key(${t.name})`,
      sql`coalesce(auto_part_code_key(${t.code}), '')`,
    ),
    // Поиск идёт по наименованию подстрокой («фильтр масл»); артикул ищут целиком, и на это
    // работает уникальный индекс выше.
    nameTrgm: index('auto_parts_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  }),
);

/**
 * Применимость: к чему подходит деталь (Р8).
 *
 * Ссылок ДВЕ, и это не запас. Привязки к модели недостаточно: `vehicles.vehicleModelId`
 * необязателен (в источнике есть машины без марки), и машина без модели осталась бы без ответа
 * вовсе. Кроме того, половина расходуемого — масло, антифриз, фильтры общего применения —
 * применима к ТИПУ, а не к модели: «всем самосвалам» это утверждение о типе.
 *
 * Одна таблица, а не две: разметка одна и ведётся одним экраном, а два места ведения одного
 * свойства расходятся при первой же правке. Пустая разметка законна — ждать ответа «к чему
 * подходит», не заводя позицию, значит потерять её совсем.
 */
export const autoPartApplicability = pgTable(
  'auto_part_applicability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `cascade`: разметка — свойство живой позиции, а не история (позицию с движением не удалить). */
    autoPartId: uuid('auto_part_id')
      .notNull()
      .references(() => autoParts.id, { onDelete: 'cascade' }),
    /**
     * `restrict` у обеих сторон (Р11): модель или тип, на которые ссылается разметка, не удаляются.
     * Иначе деталь молча потеряла бы половину ответа «к чему подходит» — строка просто исчезла бы.
     */
    vehicleModelId: uuid('vehicle_model_id').references(() => vehicleModels.id, {
      onDelete: 'restrict',
    }),
    vehicleTypeId: uuid('vehicle_type_id').references(() => vehicleTypes.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (t) => ({
    // РОВНО ОДНА ссылка, записанная через `<>` булевых: «одна из двух» и «не обе и не ни одной» —
    // одно утверждение. Обе ссылки означали бы «подходит этой модели И всем машинам её типа», где
    // второе поглощает первое; ни одной — разметку, не размечающую ничего.
    target: check(
      'auto_part_applicability_target_check',
      sql`(${t.vehicleModelId} IS NULL) <> (${t.vehicleTypeId} IS NULL)`,
    ),
    // Пара уникальна на каждой оси: «подходит» — это да или нет, а вторая такая же строка удвоила
    // бы позицию в подборе по машине (ранг Р21 считается через `EXISTS` именно поэтому).
    modelUnique: uniqueIndex('auto_part_applicability_model_unique')
      .on(t.autoPartId, t.vehicleModelId)
      .where(sql`${t.vehicleModelId} IS NOT NULL`),
    typeUnique: uniqueIndex('auto_part_applicability_type_unique')
      .on(t.autoPartId, t.vehicleTypeId)
      .where(sql`${t.vehicleTypeId} IS NOT NULL`),
    // Обратная сторона связи: ранг подбора «что подходит этой машине» (Р21) и проверка `restrict`
    // при попытке удалить модель или тип. Ключи выше читаются слева направо, от позиции, и на эти
    // вопросы не работают.
    modelIdx: index('auto_part_applicability_model_idx')
      .on(t.vehicleModelId)
      .where(sql`${t.vehicleModelId} IS NOT NULL`),
    typeIdx: index('auto_part_applicability_type_idx')
      .on(t.vehicleTypeId)
      .where(sql`${t.vehicleTypeId} IS NOT NULL`),
  }),
);

/**
 * Журнал движения остатка (Р3): каждое изменение количества — событие с обоими концами, причиной,
 * автором и, если движение прошло по обслуживанию, ссылкой на акт.
 *
 * Журнал здесь не след действия (для этого есть аудит), а сам предмет: на вопрос «куда делись
 * двенадцать фильтров» отвечает только он. Поэтому он неизменяем — правку и удаление строки
 * отбивает триггер, — а исправляют ошибку следующим событием, а не подчисткой прошлого.
 */
export const autoPartStockEntries = pgTable(
  'auto_part_stock_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Порядок в цепочке держит счётчик, а не время: две правки одной секунды по `createdAt`
     * неразличимы, а «предыдущее событие этой позиции» обязано определяться однозначно — на этом
     * стоит проверка цепочки. Тот же приём, что у `appReleases.seq`.
     */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    /**
     * `restrict`, а не `cascade`: правило «есть движение — только гашение» (Р11) держит схема.
     * Маршрут проверяет то же самое заранее, но лишь затем, чтобы человек прочитал «по позиции есть
     * движение, снимите „Активна“», а не имя ограничения.
     */
    autoPartId: uuid('auto_part_id')
      .notNull()
      .references(() => autoParts.id, { onDelete: 'restrict' }),
    /**
     * Вид события: `manual` — ручная корректировка механика, `issue` — списание по акту
     * обслуживания, `return` — возврат (снятие строки, уменьшение количества, аннулирование акта).
     * Умолчание сохраняет контракт ручной ручки: вид она проставляет сама, клиент его не выбирает и
     * выдать корректировку за расход не может.
     */
    entryKind: text('entry_kind')
      .$type<'manual' | 'issue' | 'return'>()
      .notNull()
      .default('manual'),
    /** Оба конца, а не одна «дельта»: цепочку проверяют по «было», а читают по «стало». */
    quantityBefore: integer('quantity_before').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    /**
     * Причина обязательна: журнал без неё отвечает «стало 8» на вопрос «почему стало 8». У движений
     * по акту она НЕЙТРАЛЬНАЯ и пишется сервером («Списание по акту обслуживания»): реквизиты акта
     * в текст не вписываются намеренно (Р5) — дату, номер и машину правят после движения, и снимок
     * разошёлся бы с документом, на который сам же и ссылается.
     */
    reason: text('reason').notNull(),
    /**
     * Акт обслуживания, по которому прошло движение (миграция 0188). Пусто у ручной корректировки и
     * заполнено у `issue`/`return` — держит `links`. Связь ссылкой, а не разбором текста причины:
     * по тексту не построить ни отчёт, ни адресный возврат при аннулировании, ни запрет удалить
     * акт, за которым числится движение. `restrict` и делает правило Р6 («акт с движением
     * аннулируют, а не удаляют») свойством схемы.
     */
    maintenanceId: uuid('maintenance_id').references(() => vehicleMaintenance.id, {
      onDelete: 'restrict',
    }),
    /**
     * `restrict`: запись «кто изменил остаток», теряющая автора вместе с увольнением, отвечает на
     * свой единственный вопрос словом «неизвестно».
     */
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Дата СКЛАДСКОГО учёта — когда движение отражено в портале (Р20). Сознательно отличается от
     * `vehicleMaintenance.performedOn`, даты ХОЗЯЙСТВЕННОЙ: акт задним числом законен, и
     * расхождение этих двух дат — норма, а не дефект. Всякий будущий отчёт обязан назвать, какую из
     * них берёт: склад считается по дате движения, обслуживание — по дате акта.
     */
    createdAt: createdAt(),
  },
  (t) => ({
    reasonNotBlank: check('auto_part_stock_reason_check', sql`btrim(${t.reason}) <> ''`),
    // Событие обязано что-то менять. Отсюда следствие для заведения позиции: первая строка журнала
    // пишется только при ненулевом начальном остатке, потому что «0 → 0» это не пропустит (Р3).
    change: check('auto_part_stock_change_check', sql`${t.quantityAfter} <> ${t.quantityBefore}`),
    // Оба конца неотрицательны: «было −1» не бывает так же, как «стало −1».
    amounts: check(
      'auto_part_stock_amount_check',
      sql`${t.quantityAfter} >= 0 AND ${t.quantityBefore} >= 0`,
    ),
    kindCheck: check(
      'auto_part_stock_kind_check',
      sql`${t.entryKind} IN ('manual','issue','return')`,
    ),
    // Вид события и ссылка на акт — ОДНО утверждение: «ручная корректировка» и «списано по акту» не
    // бывают наполовину. Иначе в журнале появилось бы списание, не знающее своего документа, — и
    // инвариант расхода его бы не увидел вовсе: искать движения он умеет только по паре.
    links: check(
      'auto_part_stock_links_check',
      sql`(${t.entryKind} = 'manual' AND ${t.maintenanceId} IS NULL)
          OR (${t.entryKind} IN ('issue','return') AND ${t.maintenanceId} IS NOT NULL)`,
    ),
    // Направление задаёт ВИД, а не знак разницы: «возврат», уменьшающий остаток, сделал бы отчёт по
    // расходу неверным при верной цепочке.
    direction: check(
      'auto_part_stock_direction_check',
      sql`${t.entryKind} = 'manual'
          OR (${t.entryKind} = 'issue' AND ${t.quantityAfter} < ${t.quantityBefore})
          OR (${t.entryKind} = 'return' AND ${t.quantityAfter} > ${t.quantityBefore})`,
    ),
    // Ключ цепочки: по нему проверки находят предыдущее событие позиции (`max(seq)`) и по нему же
    // лента журнала читается с конца. Уникальность — заодно запрет двух событий с одним номером у
    // одной позиции, то есть цепочка ветвиться не может. Он же обслуживает `restrict` при удалении.
    seqIdx: uniqueIndex('auto_part_stock_seq_idx').on(t.autoPartId, t.seq.desc()),
    // Под сам инвариант расхода: обе половины проверки отбирают движения ровно по этой паре, она же
    // отвечает «что списано по этому акту». Частичный — у ручных корректировок ссылка пуста.
    maintenanceIdx: index('auto_part_stock_maintenance_idx')
      .on(t.maintenanceId, t.autoPartId)
      .where(sql`${t.maintenanceId} IS NOT NULL`),
  }),
);

/**
 * Строки акта обслуживания — что поставили на машину (Р5).
 *
 * Пара «акт + позиция» УНИКАЛЬНА, и это решение, а не удобство: две одинаковых детали в одном акте
 * — это количество 2, а не две строки. Из уникальности следует всё остальное: журнал адресуется
 * парой, а не ссылкой на строку, и инвариант «количество строки равно Σ issue − Σ return по паре»
 * формулируется по паре. Держат его два отложенных constraint-триггера — со стороны строк и со
 * стороны журнала, потому что войти в расхождение можно с обеих сторон.
 *
 * Ссылки на строку акта в журнале нет намеренно (отличие от расходников оргтехники, где событие
 * ссылается на строку заявки): строка приходит и уходит, а акт остаётся, и движения после снятия
 * строки продолжают отвечать, по какому документу они прошли.
 */
export const vehicleMaintenanceParts = pgTable(
  'vehicle_maintenance_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `cascade` безвреден и выбран нарочно: акт С ДВИЖЕНИЯМИ удалить всё равно не даст `restrict`
     * журнала (Р6) — такой акт аннулируют, — а у акта БЕЗ движений строк нет вовсе, потому что
     * строка без движения не проходит инвариант. Каскад срабатывает ровно в одном случае: удаляют
     * пустой акт, и уносить ему нечего.
     */
    maintenanceId: uuid('maintenance_id')
      .notNull()
      .references(() => vehicleMaintenance.id, { onDelete: 'cascade' }),
    /** `restrict`: строка акта — документ, а не разметка, и позицию из-под неё не убирают. */
    autoPartId: uuid('auto_part_id')
      .notNull()
      .references(() => autoParts.id, { onDelete: 'restrict' }),
    /**
     * Целое и строго положительное (Р9). Ноль не бывает: «поставили ноль фильтров» — это отсутствие
     * строки, а не строка. Отрицательное тем более: возврат — уменьшение строки, а не минус в ней.
     */
    quantity: integer('quantity').notNull(),
    /** Пометка механика к строке: «поставлен передний левый», «б/у, со списанной машины». */
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    quantityPositive: check('vehicle_maintenance_parts_quantity_check', sql`${t.quantity} > 0`),
    pairUnique: unique('vehicle_maintenance_parts_unique').on(t.maintenanceId, t.autoPartId),
    // Обратная сторона: «в каких актах стоит эта позиция». Ключ уникальности читается слева
    // направо, от акта, и на этот вопрос не работает; он же нужен `restrict` при удалении позиции.
    partIdx: index('vehicle_maintenance_parts_part_idx').on(t.autoPartId),
  }),
);

export type AutoPartRow = typeof autoParts.$inferSelect;
export type AutoPartApplicabilityRow = typeof autoPartApplicability.$inferSelect;
export type AutoPartStockEntryRow = typeof autoPartStockEntries.$inferSelect;
export type VehicleMaintenancePartRow = typeof vehicleMaintenanceParts.$inferSelect;
