import { z } from 'zod';
import { archiveFilterSchema, baseListQuery, dateOnlySchema, uuidSchema } from './common';
import type { ServiceRequestStatus } from './service-requests';

// ── Справочник оргтехники (ADR 0085) ──
// Единица: тип, модель, номера, место (объект и уточнение внутри него), отдел-владелец, гарантия
// поставщика. Заявки на обслуживание ссылаются на единицу и хранят снимок её реквизитов, поэтому
// правка карточки прошлое не переписывает.

// ── Тип оргтехники ──
// Перечень, как типы контейнеров: код, название, порядок. Ведётся в окне из вкладки справочника —
// сам по себе тип ничего не значит, и отдельная вкладка ради десяти строк не заводится.

export const OFFICE_EQUIPMENT_TYPE_SORT_FIELDS = ['name', 'code', 'sortOrder', 'isActive'] as const;

const typeCodeSchema = z
  .string()
  .trim()
  .min(2, 'Код типа — минимум 2 символа')
  .max(50)
  .regex(/^[a-z0-9_]+$/, 'Код типа — латиница, цифры и подчёркивание');

const typeNameSchema = z.string().trim().min(2, 'Укажите название типа').max(255);

export const officeEquipmentTypeListQuerySchema = baseListQuery(
  OFFICE_EQUIPMENT_TYPE_SORT_FIELDS,
).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createOfficeEquipmentTypeSchema = z.object({
  code: typeCodeSchema,
  name: typeNameSchema,
  sortOrder: z.number().int().min(0).max(9999).optional().default(100),
  isActive: z.boolean().optional().default(true),
});
export type CreateOfficeEquipmentTypeInput = z.infer<typeof createOfficeEquipmentTypeSchema>;

// `.partial()` снимает обязательность, но не `.default()` — поля со значением по умолчанию
// объявляются заново, иначе PATCH без поля затирал бы значение (тот же подвох, что у складов).
export const updateOfficeEquipmentTypeSchema = createOfficeEquipmentTypeSchema.partial().extend({
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateOfficeEquipmentTypeInput = z.infer<typeof updateOfficeEquipmentTypeSchema>;

export interface OfficeEquipmentTypeDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Местонахождение единицы (план модернизации, Р61) ──
//
// Не «статус жизненного цикла»: списание и ввод в эксплуатацию модуль не ведёт (§12 плана модуля),
// а `isActive` отвечает на другой вопрос — «эксплуатируется ли». Здесь только физическое место, и
// меняется оно перемещением, а не правкой карточки.

export const OFFICE_EQUIPMENT_STATES = [
  'on_site',
  'at_service',
  'in_stock',
  'with_employee',
] as const;
export const officeEquipmentStateSchema = z.enum(OFFICE_EQUIPMENT_STATES);
export type OfficeEquipmentState = (typeof OFFICE_EQUIPMENT_STATES)[number];

export const officeEquipmentStateLabels: Record<OfficeEquipmentState, string> = {
  on_site: 'На объекте',
  at_service: 'В ремонте',
  in_stock: 'На складе',
  with_employee: 'У сотрудника',
};

export const officeEquipmentStateColors: Record<OfficeEquipmentState, string | undefined> = {
  // «На объекте» — рабочее состояние, и цветом его не выделяют: иначе в списке горит каждая строка.
  on_site: undefined,
  at_service: 'orange',
  in_stock: 'blue',
  with_employee: 'geekblue',
};

/**
 * Состояния, которые обязаны быть уточнены (то же держит CHECK в БД): «на складе» и «у сотрудника»
 * без уточнения — потерянная техника, искать её по такой записи негде. У «на объекте» место уже
 * есть колонкой `location`, у «в ремонте» — сервисная компания в заявке.
 */
export function officeEquipmentStateNeedsNote(state: OfficeEquipmentState): boolean {
  return state === 'in_stock' || state === 'with_employee';
}

// ── Единица оргтехники ──

export const OFFICE_EQUIPMENT_SORT_FIELDS = [
  'name',
  'type',
  'object',
  'inventoryNumber',
  'serialNumber',
  'warrantyUntil',
  'isActive',
  'createdAt',
] as const;

const nameSchema = z.string().trim().min(2, 'Укажите модель').max(255);
/** Номера свободного вида: их печатает производитель и клеит бухгалтерия, формата у них нет. */
const numberSchema = z.string().trim().max(100);
const locationSchema = z.string().trim().max(255);
const commentSchema = z.string().trim().max(2000);

/**
 * Фильтр по гарантии: три вопроса, которые задают этому справочнику. `expiring` — «что продлевать в
 * ближайший месяц», и порог у него общий с подсветкой (`WARRANTY_EXPIRING_DAYS`).
 */
export const OFFICE_EQUIPMENT_WARRANTY_FILTERS = ['active', 'expiring', 'expired'] as const;
export type OfficeEquipmentWarrantyFilter = (typeof OFFICE_EQUIPMENT_WARRANTY_FILTERS)[number];

export const officeEquipmentListQuerySchema = baseListQuery(OFFICE_EQUIPMENT_SORT_FIELDS).extend({
  objectId: uuidSchema.optional(),
  equipmentTypeId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  state: officeEquipmentStateSchema.optional(),
  /**
   * «В ремонте, а открытых заявок нет» — срез «Требуют внимания» (Р61). Портал не знает, вернули
   * ли аппарат: он знает только то, что ему сказали, — поэтому это отчёт, а не запрет.
   */
  strandedAtService: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** «Не закреплена ни за кем» — срез для разметки парка; с `departmentId` не сочетается. */
  unassignedDepartment: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  warranty: z.enum(OFFICE_EQUIPMENT_WARRANTY_FILTERS).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  archive: archiveFilterSchema,
});

const stateNoteSchema = z.string().trim().max(255);

const equipmentFields = {
  equipmentTypeId: uuidSchema,
  name: nameSchema,
  serialNumber: numberSchema.optional().default(''),
  inventoryNumber: numberSchema.optional().default(''),
  objectId: uuidSchema,
  departmentId: uuidSchema.nullish(),
  location: locationSchema.optional().default(''),
  purchasedOn: dateOnlySchema.nullish(),
  warrantyUntil: dateOnlySchema.nullish(),
  comment: commentSchema.optional().default(''),
  isActive: z.boolean().optional().default(true),
};

/**
 * Хотя бы один номер обязателен (тот же CHECK держит и БД): единицу опознают при приёмке из
 * ремонта, и «МФУ без номеров» в акте ничем не отличается от соседнего такого же.
 */
const IDENTITY_MESSAGE = 'Укажите серийный или инвентарный номер';

export const createOfficeEquipmentSchema = z
  .object(equipmentFields)
  .refine((v) => !!v.serialNumber || !!v.inventoryNumber, {
    message: IDENTITY_MESSAGE,
    path: ['inventoryNumber'],
  });
export type CreateOfficeEquipmentInput = z.infer<typeof createOfficeEquipmentSchema>;

/**
 * Правка карточки объект больше не меняет (Р59): переезд — событие с датой, причиной и обеими
 * сторонами, и тихая смена площадки в форме оставляла бы вопрос «где этот аппарат стоял в мае» без
 * ответа. Поле уезжает в свою ручку `POST /office-equipment/:id/move`.
 *
 * Отдел-владелец при этом остаётся здесь: разметка парка (кто за что отвечает) — не переезд, и
 * писать перемещение там, где технику никуда не везли, значило бы засорять журнал.
 */
export const updateOfficeEquipmentSchema = z
  .object({
    ...equipmentFields,
    objectId: z.never().optional(),
    serialNumber: numberSchema.optional(),
    inventoryNumber: numberSchema.optional(),
    location: locationSchema.optional(),
    comment: commentSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .partial()
  // Правку в «оба номера пусты» ловит сервер: в PATCH приходит только изменённое, и схема одна из
  // двух колонок не видит. Здесь отсекается лишь явная попытка стереть оба разом.
  .refine((v) => v.serialNumber !== '' || v.inventoryNumber !== '', {
    message: IDENTITY_MESSAGE,
    path: ['inventoryNumber'],
  });
export type UpdateOfficeEquipmentInput = z.infer<typeof updateOfficeEquipmentSchema>;

/** Тип в строке единицы: столько, сколько нужно для показа и повторного выбора. */
export interface OfficeEquipmentTypeRefDto {
  id: string;
  name: string;
  isActive: boolean;
}

/** Объект в строке единицы: код различает одноимённые корпуса. */
export interface OfficeEquipmentObjectRefDto {
  id: string;
  code: string;
  name: string;
}

export interface OfficeEquipmentDepartmentRefDto {
  id: string;
  code: string;
  name: string;
}

/** Действующая гарантия на выполненную позицию ремонта — строка в истории обслуживания. */
export interface OfficeEquipmentItemWarrantyDto {
  itemId: string;
  name: string;
  warrantyUntil: string;
}

/**
 * Заявка на обслуживание в карточке единицы (§8.2): что с этим аппаратом уже делали.
 *
 * Не ссылка на список, а короткий срез: оператор смотрит карточку перед назначением сервиса, и
 * вопрос у него один — чинили ли уже и что именно меняли. Итог приходит только у закрытых заявок,
 * гарантии — только по выполненным позициям (Р12).
 */
export interface OfficeEquipmentServiceEntryDto {
  id: string;
  displayNumber: string;
  status: ServiceRequestStatus;
  createdAt: string;
  completedAt: string | null;
  serviceName: string | null;
  totalAmount: number | null;
  warranties: OfficeEquipmentItemWarrantyDto[];
}

/** Одно перемещение единицы: откуда, куда, когда и почему (Р59). */
export interface OfficeEquipmentMovementDto {
  id: string;
  movedOn: string;
  fromObject: OfficeEquipmentObjectRefDto;
  toObject: OfficeEquipmentObjectRefDto;
  fromDepartment: OfficeEquipmentDepartmentRefDto | null;
  toDepartment: OfficeEquipmentDepartmentRefDto | null;
  fromLocation: string;
  toLocation: string;
  fromState: OfficeEquipmentState;
  toState: OfficeEquipmentState;
  reason: string;
  comment: string;
  /** Заявка, из-за которой единицу увезли или вернули; `null` — переезд сам по себе. */
  serviceRequestId: string | null;
  serviceRequestNum: number | null;
  movedByName: string;
  createdAt: string;
}

/**
 * Перемещение (Р59, Р60). Область проверяется по **исходной** стороне: перемещение — утрата, а не
 * захват, и требование «обе стороны в области» сделало бы штатный перенос между площадками
 * невозможным именно для того, кто технику отдаёт.
 */
export const moveOfficeEquipmentSchema = z
  .object({
    objectId: uuidSchema,
    departmentId: uuidSchema.nullish(),
    location: locationSchema.optional().default(''),
    state: officeEquipmentStateSchema.optional().default('on_site'),
    stateNote: stateNoteSchema.optional().default(''),
    movedOn: dateOnlySchema,
    reason: z.string().trim().min(3, 'Укажите причину перемещения').max(1000),
    comment: z.string().trim().max(1000).optional().default(''),
    /** Переезд из-за ремонта: «увезли в сервис» и «вернулась» заводятся из карточки заявки. */
    serviceRequestId: uuidSchema.nullish(),
  })
  .refine((v) => !officeEquipmentStateNeedsNote(v.state) || !!v.stateNote, {
    message: 'Уточните, где именно находится техника',
    path: ['stateNote'],
  });
export type MoveOfficeEquipmentInput = z.infer<typeof moveOfficeEquipmentSchema>;

export interface OfficeEquipmentDto {
  id: string;
  type: OfficeEquipmentTypeRefDto;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  object: OfficeEquipmentObjectRefDto;
  /** Отдел-владелец; `null` — не закреплена (такую единицу и надо разметить). */
  department: OfficeEquipmentDepartmentRefDto | null;
  location: string;
  /** Где единица находится физически и уточнение к этому (Р61). */
  state: OfficeEquipmentState;
  stateNote: string;
  purchasedOn: string | null;
  warrantyUntil: string | null;
  comment: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /**
   * История обслуживания и гарантии ремонтов (§8.2). Поле необязательное, и это содержательно:
   * его отсутствие означает «не положено видеть» (у смотрящего нет `serviceRequests.read`), а не
   * «ремонтов не было» — последнее выражается пустым массивом. Пустой массив вместо отсутствия
   * заставил бы портал рисовать раздел «Обслуживание — ничего» тому, кому модуль вообще закрыт.
   *
   * Приходит только в карточке (`GET /office-equipment/:id`): в списке справочника этот срез
   * означал бы подзапрос на каждую строку ради данных, которых в списке не видно.
   */
  serviceHistory?: OfficeEquipmentServiceEntryDto[];
}

/**
 * Как единица называется в списке и в подсказках: модель плюс номер, которым её опознают. Функция
 * общая для портала и писем — «Kyocera M3145 · инв. 0012345» должно читаться одинаково везде.
 */
export function officeEquipmentTitle(
  item: Pick<OfficeEquipmentDto, 'name' | 'inventoryNumber' | 'serialNumber'>,
): string {
  const num = item.inventoryNumber
    ? `инв. ${item.inventoryNumber}`
    : item.serialNumber
      ? `SN ${item.serialNumber}`
      : '';
  return num ? `${item.name} · ${num}` : item.name;
}
