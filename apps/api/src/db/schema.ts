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
export const roleEnum = pgEnum('role', ['admin', 'manager', 'dispatcher', 'shtab', 'operator']);
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

// ── Справочник типов мусора (ADR 0009) ──
// «Что вывозим»: строительные отходы, бетонный бой, грунт, ОССиГ, древесные отходы.
// «Чем вывозим» — container_types; цена задаётся на пару (см. wasteTariffs).
export const wasteTypes = pgTable(
  'waste_types',
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
    codeUnique: uniqueIndex('waste_types_code_unique').on(t.code),
    codeFormat: check('waste_types_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    nameNotBlank: check('waste_types_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
  }),
);

// ── Прайс вывоза мусора (ADR 0009) ──
// Тариф задаётся либо для конкретного типа контейнера/машины, либо для вида техники целиком;
// при расчёте точное совпадение по типу побеждает тариф вида. Цена всегда за 1 м³: позиция
// «15 000 ₽ за контейнер 8 м³» хранится как 1875 ₽/м³ + isPerContainer (кратность объёма).
export const wasteTariffs = pgTable(
  'waste_tariffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
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
    typeContainerUnique: uniqueIndex('waste_tariffs_type_container_unique')
      .on(t.wasteTypeId, t.containerTypeId)
      .where(sql`${t.containerTypeId} IS NOT NULL`),
    typeKindUnique: uniqueIndex('waste_tariffs_type_kind_unique')
      .on(t.wasteTypeId, t.containerKind)
      .where(sql`${t.containerKind} IS NOT NULL`),
    wasteTypeIdx: index('waste_tariffs_waste_type_idx').on(t.wasteTypeId),
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
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('vehicle_types_code_unique').on(t.code),
    codeFormat: check('vehicle_types_code_format_check', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    codeNotBlank: check('vehicle_types_code_not_blank', sql`btrim(${t.code}) <> ''`),
    nameNotBlank: check('vehicle_types_name_not_blank', sql`btrim(${t.name}) <> ''`),
    kindActiveSortIdx: index('vehicle_types_kind_active_sort_idx').on(
      t.kindId,
      t.isActive,
      t.sortOrder,
    ),
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

// ── Конкретные ТС (ADR 0007) ──
// Тип хранится явно (известен всегда), марка/модель — опциональна (в источнике есть машины без марки).
// Согласованность обеспечивает составной FK на (vehicle_models.id, vehicle_models.vehicle_type_id):
// при NULL-модели он не проверяется (MATCH SIMPLE), при заполненной — запрещает расхождение типов.
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    vehicleModelId: uuid('vehicle_model_id'),
    registrationNumber: text('registration_number'),
    registrationNumberNormalized: text('registration_number_normalized').generatedAlwaysAs(
      sql`vehicle_reg_normalize(registration_number)`,
    ),
    inventoryNumber: text('inventory_number'),
    serialNumber: text('serial_number'),
    passportNumber: text('passport_number'),
    manufacturerName: text('manufacturer_name').notNull().default(''),
    manufacturedOn: date('manufactured_on'),
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
    registrationNumberNotBlank: check(
      'vehicles_registration_number_not_blank_check',
      sql`${t.registrationNumber} IS NULL OR btrim(${t.registrationNumber}) <> ''`,
    ),
    inventoryNumberNotBlank: check(
      'vehicles_inventory_number_not_blank_check',
      sql`${t.inventoryNumber} IS NULL OR btrim(${t.inventoryNumber}) <> ''`,
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
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role'), // назначается администратором; до активации может быть null
    constructionObjectId: uuid('construction_object_id').references(() => constructionObjects.id, {
      onDelete: 'set null',
    }),
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    fullNameTrgm: index('users_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    // Одна учётная запись на человека.
    personUnique: uniqueIndex('users_person_unique')
      .on(t.personId)
      .where(sql`${t.personId} IS NOT NULL`),
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
    // Сквозной человекочитаемый номер (отображается как «<num>-<буква типа>»).
    num: integer('num').generatedAlwaysAsIdentity(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    requestType: requestTypeEnum('request_type').notNull(),
    // container_install → тип контейнера (type='cont'); container_replace → тип, установленный
    // на объекте; waste_removal → тип машины/контейнера
    containerTypeId: uuid('container_type_id').references(() => containerTypes.id, {
      onDelete: 'restrict',
    }),
    // Объём вывоза (ADR 0009): waste_removal, container_replace, container_removal.
    volumeM3: integer('volume_m3'),
    // Что вывозим и по какой цене. Тариф и цена — снимок на момент сохранения заявки:
    // изменение прайса не переписывает суммы уже оформленных заявок.
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
    // Документ заявки или талон, приложенный при её закрытии (миграция 0031). Талоны вывоза
    // самосвалами сюда не попадают — они висят на машинах (ADR 0011).
    kind: text('kind').notNull().default('attachment').$type<'attachment' | 'ticket'>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.fileId] }),
    fileIdx: index('request_files_file_idx').on(t.fileId),
    kindCheck: check('request_files_kind_check', sql`${t.kind} IN ('attachment', 'ticket')`),
  }),
);

// ── Машины, вывезшие заявку (ADR 0011, миграция 0029) ──
// Факт вывоза — список машин, а не одно число: заявленный объём увозят несколькими рейсами,
// у каждого свой талон. Машина описывается типом из общего справочника — техника принадлежит
// оператору, в справочнике конкретных ТС (vehicles) её нет. Объём проставляется руками и с
// вместимостью типа совпадать не обязан. Пометка на удаление (deletedAt) выводит строку из
// сверки объёма, но оставляет в истории; удалить запись насовсем может только администратор.
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
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    volumePositive: check('waste_request_vehicles_volume_positive_check', sql`${t.volumeM3} > 0`),
    requestIdx: index('waste_request_vehicles_request_idx').on(t.requestId),
    activeIdx: index('waste_request_vehicles_active_idx')
      .on(t.requestId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// Талоны машины (сканы). UNIQUE(file_id) — файл не в двух машинах (паттерн vehicleRequestFiles).
export const wasteRequestVehicleFiles = pgTable(
  'waste_request_vehicle_files',
  {
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => wasteRequestVehicles.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vehicleId, t.fileId] }),
    fileUnique: uniqueIndex('waste_request_vehicle_files_file_unique').on(t.fileId),
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
    // Сквозной человекочитаемый номер (отображается как «ТС-000123»).
    num: integer('num').generatedAlwaysAsIdentity(),
    requestType: vehicleRequestTypeEnum('request_type').notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => constructionObjects.id, { onDelete: 'restrict' }),
    // Конечный выбираемый подтип ТС (level=subtype). В API — vehicleSubtypeId.
    vehicleTypeId: uuid('vehicle_type_id')
      .notNull()
      .references(() => vehicleTypes.id, { onDelete: 'restrict' }),
    status: requestStatusEnum('status').notNull().default('new'),
    comment: text('comment').notNull().default(''),
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
    objectIdx: index('vehicle_requests_object_idx').on(t.objectId),
    typeIdx: index('vehicle_requests_request_type_idx').on(t.requestType),
    statusIdx: index('vehicle_requests_status_idx').on(t.status),
    vehicleTypeIdx: index('vehicle_requests_vehicle_type_idx').on(t.vehicleTypeId),
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
    // Поиск по ФИО и предупреждение о вероятных дублях; жёсткого UNIQUE на человека нет.
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
export type WasteRequestRow = typeof wasteRequests.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ObjectRow = typeof constructionObjects.$inferSelect;
export type ContainerTypeRow = typeof containerTypes.$inferSelect;
export type WasteTypeRow = typeof wasteTypes.$inferSelect;
export type WasteTariffRow = typeof wasteTariffs.$inferSelect;
export type VehicleKindRow = typeof vehicleKinds.$inferSelect;
export type VehicleTypeRow = typeof vehicleTypes.$inferSelect;
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
