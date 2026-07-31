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
]);
export const containerKindEnum = pgEnum('container_kind', ['cont', 'truck']);
export const fileStatusEnum = pgEnum('file_status', ['pending', 'active', 'deleted']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'running', 'done', 'failed', 'dead']);
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
 * заявка. С объектами отделы не пересекаются — это вторая ось области, а не её продолжение.
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('departments_code_unique').on(t.code),
    nameTrgm: index('departments_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
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
    // Какой бланк путевого листа выписывается на машины этого типа (ADR 0037, миграция 0060).
    // Код формы, а не флаг: легковые ('leg3') и спецтехника ('esm2') добавятся значением, а не
    // второй схемой. NULL — лист не выписывается.
    waybillFormCode: text('waybill_form_code').$type<'4p' | 'leg3' | 'esm2'>(),
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
      sql`${t.waybillFormCode} IS NULL OR ${t.waybillFormCode} IN ('4p', 'leg3', 'esm2')`,
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
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
    pendingRegistration: index('users_pending_registration_idx')
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isActive} = false AND ${t.role} IS NULL`),
    fullNameTrgm: index('users_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    // Одна учётная запись на человека.
    personUnique: uniqueIndex('users_person_unique')
      .on(t.personId)
      .where(sql`${t.personId} IS NOT NULL`),
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
    responsibleName: text('responsible_name').notNull().default(''),
    responsiblePhone: text('responsible_phone').notNull().default(''),
    comment: text('comment').notNull().default(''),
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
  }),
);

// ── Наличие контейнеров на площадках (view, создаётся миграцией 0007) ──
// Возвращает id «присутствующих» заявок установки: установки минус снятия по типу (FIFO по num).
export const presentContainers = pgView('present_containers', {
  id: uuid('id'),
  objectId: uuid('object_id'),
  containerTypeId: uuid('container_type_id'),
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
// строку. Объём вводится руками — он стоит в талоне и весовой квитанции, — и с заявленным
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
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }).notNull(),
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
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
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
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numUnique: uniqueIndex('vehicle_requests_num_unique').on(t.num),
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
    // Кто встречает технику на объекте (миграция 0062); пусто — заявка старше колонки.
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

// Детали грузоперевозки: дата-время (timestamptz) + объём/масса (numeric) + места.
export const freightTransportRequestDetails = pgTable(
  'freight_transport_request_details',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => vehicleRequests.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    // Время не задано — в scheduledAt значима только дата (00:00 МСК). См. 0020.
    scheduledTimeUnspecified: boolean('scheduled_time_unspecified').notNull().default(false),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    weightTons: numeric('weight_tons', { precision: 12, scale: 3 }),
    loadingLocation: text('loading_location').notNull(),
    unloadingLocation: text('unloading_location').notNull(),
    // Метаданные верификации адреса (DaData «Подсказки», ADR 0006); NULL = введён вручную.
    loadingAddress: jsonb('loading_address').$type<AddressMeta>(),
    unloadingAddress: jsonb('unloading_address').$type<AddressMeta>(),
    // Контакт на каждом конце маршрута (миграция 0062): грузят и принимают разные люди в разных
    // местах. Пусто — заявка заведена до появления колонок.
    loadingResponsibleName: text('loading_responsible_name').notNull().default(''),
    loadingResponsiblePhone: text('loading_responsible_phone').notNull().default(''),
    unloadingResponsibleName: text('unloading_responsible_name').notNull().default(''),
    unloadingResponsiblePhone: text('unloading_responsible_phone').notNull().default(''),
  },
  (t) => ({
    volumePositive: check(
      'freight_volume_positive_check',
      sql`${t.volumeM3} is null or ${t.volumeM3} > 0`,
    ),
    weightPositive: check(
      'freight_weight_positive_check',
      sql`${t.weightTons} is null or ${t.weightTons} > 0`,
    ),
    volumeOrWeight: check(
      'freight_volume_or_weight_check',
      sql`${t.volumeM3} is not null or ${t.weightTons} is not null`,
    ),
    loadingNotBlank: check(
      'freight_loading_not_blank_check',
      sql`btrim(${t.loadingLocation}) <> ''`,
    ),
    unloadingNotBlank: check(
      'freight_unloading_not_blank_check',
      sql`btrim(${t.unloadingLocation}) <> ''`,
    ),
    scheduledIdx: index('freight_scheduled_at_idx').on(t.scheduledAt),
  }),
);

// Техника, которой заявку взяли в работу (ADR 0027, миграция 0051). Одна заявка — одна машина,
// поэтому request_id и есть первичный ключ: заявка заказывает один тип ТС на один срок, и второй
// машины в ней нет. Ставки — снимок договорённости по этой заявке: их подставляют из предложения
// аренды, но правят свободно, и прайс справочника их потом не переписывает.
export const vehicleRequestAssignments = pgTable(
  'vehicle_request_assignments',
  {
    requestId: uuid('request_id').primaryKey(),
    vehicleId: uuid('vehicle_id').notNull(),
    // Служебная: копия типа ТС заявки. Существует ради двух составных FK — ими инвариант
    // «назначенная машина того же типа, что заказан» становится физическим, а не проверкой.
    vehicleTypeId: uuid('vehicle_type_id').notNull(),
    pricePerHour: numeric('price_per_hour', { precision: 12, scale: 2 }),
    pricePerShift: numeric('price_per_shift', { precision: 12, scale: 2 }),
    shiftHours: smallint('shift_hours'),
    // Кто за рулём (ADR 0037, миграция 0061): «чем взяли в работу» дополняется тем, кем.
    // Колонкой, а не таблицей `vehicle_request_operators` из бэклога ADR 0008 — ADR 0027 уже
    // выбрал форму «одна заявка — одно назначение», и второго водителя в ней не бывает.
    // NULL — назначения до появления путевых листов и аренда, где водитель чужой.
    driverPersonId: uuid('driver_person_id').references(() => persons.id, {
      onDelete: 'restrict',
    }),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Заявка: каскад — назначение живёт ровно столько же, сколько сама заявка. ON UPDATE не
    // задан намеренно: смена типа ТС у заявки с назначенной машиной должна отклоняться, а не
    // тянуть за собой строку назначения (сервер отвечает на это 422 с объяснением).
    requestTypeFk: foreignKey({
      columns: [t.requestId, t.vehicleTypeId],
      foreignColumns: [vehicleRequests.id, vehicleRequests.vehicleTypeId],
      name: 'vehicle_request_assignments_request_type_fk',
    }).onDelete('cascade'),
    // Машина: restrict — назначенную технику из справочника не удаляют, на неё ссылается работа.
    vehicleTypeFk: foreignKey({
      columns: [t.vehicleId, t.vehicleTypeId],
      foreignColumns: [vehicles.id, vehicles.vehicleTypeId],
      name: 'vehicle_request_assignments_vehicle_type_fk',
    }).onDelete('restrict'),
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
    driverIdx: index('vehicle_request_assignments_driver_idx')
      .on(t.driverPersonId)
      .where(sql`${t.driverPersonId} IS NOT NULL`),
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
     * выписывают заново, начиная с неё — нет (ADR 0037 п. 9). Держит это сервис: CURRENT_DATE
     * не IMMUTABLE и в CHECK запрещён.
     */
    issuedForDate: date('issued_for_date', { mode: 'string' }).notNull(),
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
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason').notNull().default(''),
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
    seriesNumberUnique: uniqueIndex('waybills_series_number_unique').on(t.seriesId, t.number),
    // Один лист на машину и дату (ADR 0037 п. 3); аннулированные не мешают — испорченный бланк
    // заменяют новым на ту же дату.
    vehicleDateUnique: uniqueIndex('waybills_vehicle_date_unique')
      .on(t.vehicleId, t.issuedForDate)
      .where(sql`${t.status} <> 'cancelled'`),
    issuedForDateIdx: index('waybills_issued_for_date_idx').on(t.issuedForDate.desc()),
    driverIdx: index('waybills_driver_idx').on(t.driverPersonId),
    // «На чём человек ездил в прошлый раз» — этим сортируется список водителей и наследуются
    // графы шапки.
    vehicleIssuedIdx: index('waybills_vehicle_issued_idx').on(t.vehicleId, t.issuedForDate.desc()),
  }),
);

// Талоны заказчиков: заявки, которые машина выполняет по этому листу. Форма 4-П держит до
// четырёх, и вторая заявка на ту же машину в тот же день дописывается талоном, а не поднимает
// второй лист.
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
    slotCheck: check('waybill_requests_slot_check', sql`${t.slot} BETWEEN 1 AND 4`),
    slotUnique: uniqueIndex('waybill_requests_slot_unique').on(t.waybillId, t.slot),
    // Заявка в одном листе, но UNIQUE здесь нельзя: аннулированный лист сохраняет свою строку, а
    // заявку после него выписывают заново. Условие «лист не аннулирован» — в соседней таблице,
    // и держит его сервис.
    requestIdx: index('waybill_requests_request_idx').on(t.requestId),
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

export type UserRow = typeof users.$inferSelect;
export type UserConstructionObjectRow = typeof userConstructionObjects.$inferSelect;
export type DepartmentRow = typeof departments.$inferSelect;
export type UserDepartmentRow = typeof userDepartments.$inferSelect;
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
