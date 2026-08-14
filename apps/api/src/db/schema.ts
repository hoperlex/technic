import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import type { AddressMeta } from '@technic/contracts';

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
 * Отсюда же берутся руководители в карточке отдела: это учётки с ролью «Руководитель отдела»,
 * привязанные к отделу, — своего хранилища у той связи нет.
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
    // Виза отдела ИТ (миграция 0119): решение о том, звать ли внешний сервис. Снимок из двух
    // полей, как виза заказа ТС (ADR 0025); третий флаг отличает автоматическую — заявку завёл
    // сам обладатель права, и подписывать её вторым действием было бы ритуалом.
    itApprovedBy: uuid('it_approved_by').references(() => users.id, { onDelete: 'set null' }),
    itApprovedAt: timestamp('it_approved_at', { withTimezone: true }),
    itApprovedAuto: boolean('it_approved_auto').notNull().default(false),
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
    descriptionNotBlank: check(
      'service_requests_description_not_blank_check',
      sql`btrim(${t.description}) <> ''`,
    ),
    amounts: check(
      'service_requests_amounts_check',
      sql`(${t.estimatedTotalAmount} IS NULL OR ${t.estimatedTotalAmount} >= 0)
          AND (${t.finalTotalAmount} IS NULL OR ${t.finalTotalAmount} >= 0)`,
    ),
    // Без исполнителя заявку никто не ведёт; исключение — три статуса до его назначения:
    // «Новая», «Согласована ИТ» (виза есть, сервис ещё не выбран) и «Отменена».
    executor: check(
      'service_requests_executor_check',
      sql`${t.status} IN ('new','it_approved','cancelled') OR ${t.serviceCounterpartyId} IS NOT NULL`,
    ),
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
    accepted: check(
      'service_requests_accepted_check',
      sql`(${t.acceptedBy} IS NULL) = (${t.acceptedAt} IS NULL)`,
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
    // Срочность — такая же неразрывная пара, как корректировка акта выше: флаг без причины
    // отбирает заявки, ничего про них не объясняя, причина без флага ничего не объявляет.
    urgency: check(
      'service_requests_urgency_check',
      sql`(NOT ${t.isUrgent} AND btrim(${t.urgencyReason}) = '')
          OR (${t.isUrgent} AND btrim(${t.urgencyReason}) <> '')`,
    ),
    numUnique: uniqueIndex('service_requests_num_unique').on(t.num),
    // Одна открытая заявка на единицу: две параллельные означали бы два сервиса, два акта и две
    // гарантии на одну работу. Индекс сторожит и заведение, и восстановление из архива — сервер
    // обязан отвечать на оба случая понятным 409 со ссылкой на открытую заявку, а не ошибкой БД.
    openPerEquipmentUnique: uniqueIndex('service_requests_open_per_equipment_unique')
      .on(t.officeEquipmentId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} NOT IN ('accepted','cancelled')`),
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
    // Очередь «что срочное ждёт дольше всех»: закрытые и удалённые заявки в ней не участвуют,
    // поэтому индекс частичный — он остаётся размером с очередь, а не с таблицей.
    urgentIdx: index('service_requests_urgent_idx')
      .on(t.statusChangedAt)
      .where(
        sql`${t.isUrgent} AND ${t.deletedAt} IS NULL AND ${t.status} NOT IN ('accepted','cancelled')`,
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
    // «У каких закрытых заявок нет акта» — вопрос очереди «Ожидаются документы».
    docIdx: index('service_request_files_doc_idx')
      .on(t.requestId)
      .where(sql`${t.kind} IN ('act','invoice')`),
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
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment').notNull().default(''),
  },
  (t) => ({
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
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numUnique: uniqueIndex('vehicle_requests_num_unique').on(t.num),
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
      .$type<'route' | 'transfer' | 'esm2' | 'cancel' | 'issue' | 'request_date'>(),
    reason: text('reason').notNull(),
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
    kindCheck: check(
      'waybill_corrections_kind_check',
      sql`${t.kind} IN ('route', 'transfer', 'esm2', 'cancel', 'issue', 'request_date')`,
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
  },
  (t) => ({
    roleCheck: check('route_point_trips_role_check', sql`${t.role} IN ('load', 'unload', 'work')`),
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

// ── Аудитория ролевой сводки (ADR 0078, миграция 0100; отбор вместо исключений — ADR 0093, 0124) ──
//
// Роль в расписании — фильтр получателей, а не выдача прав: что человек увидит в письме, решает его
// собственная область видимости. Отдельными таблицами, а не массивами в строке расписания: по ним
// идут выборки получателей, и массив в `WHERE` означал бы разворачивание на каждом запуске.
//
// Все три оси — выбор, а не исключение. Прежние «исключённые» таблицы описывали ту же аудиторию
// наизнанку: по форме нельзя было прочитать, кому уйдёт письмо, не вычитая в уме одно из другого.

/** Роли-получатели сводки. */
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
export type VehicleRequestRow = typeof vehicleRequests.$inferSelect;
export type SpecialEquipmentRequestDetailsRow = typeof specialEquipmentRequestDetails.$inferSelect;
export type FreightTransportRequestDetailsRow = typeof freightTransportRequestDetails.$inferSelect;
export type WasteRequestVehicleRow = typeof wasteRequestVehicles.$inferSelect;
export type CounterpartyRow = typeof counterparties.$inferSelect;
export type CounterpartySynonymRow = typeof counterpartySynonyms.$inferSelect;
export type WarehouseRow = typeof warehouses.$inferSelect;
export type OfficeEquipmentTypeRow = typeof officeEquipmentTypes.$inferSelect;
export type OfficeEquipmentRow = typeof officeEquipment.$inferSelect;
export type ServiceRequestRow = typeof serviceRequests.$inferSelect;
export type ServiceRequestItemRow = typeof serviceRequestItems.$inferSelect;
export type ServiceRequestFileRow = typeof serviceRequestFiles.$inferSelect;
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
