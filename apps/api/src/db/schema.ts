import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** case-insensitive text (расширение citext включается ops-ом до миграций). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ── Enums ──
export const roleEnum = pgEnum('role', ['admin', 'manager', 'dispatcher', 'shtab']);
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
    nameTrgm: index('construction_objects_name_trgm')
      .using('gin', sql`${t.name} gin_trgm_ops`),
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
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    codeUnique: uniqueIndex('container_types_code_unique').on(t.code),
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
    constructionObjectId: uuid('construction_object_id').references(
      () => constructionObjects.id,
      { onDelete: 'set null' },
    ),
    isActive: boolean('is_active').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    authVersion: integer('auth_version').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    fullNameTrgm: index('users_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
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
    // waste_removal: объём
    volumeM3: integer('volume_m3'),
    deliveryAt: timestamp('delivery_at', { withTimezone: true }).notNull(),
    comment: text('comment').notNull().default(''),
    status: requestStatusEnum('status').notNull().default('new'),
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
    objectIdx: index('waste_requests_object_idx').on(t.objectId),
    deliveryIdx: index('waste_requests_delivery_idx').on(t.deliveryAt),
    createdAtIdx: index('waste_requests_created_at_idx').on(t.createdAt),
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
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.fileId] }),
    fileIdx: index('request_files_file_idx').on(t.fileId),
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
});

// ── Фоновые задачи (outbox, §16) ──
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
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
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export type UserRow = typeof users.$inferSelect;
export type WasteRequestRow = typeof wasteRequests.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ObjectRow = typeof constructionObjects.$inferSelect;
export type ContainerTypeRow = typeof containerTypes.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
