import { z } from 'zod';
import { archiveFilterSchema, baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { contactNameSchema, optionalPhoneSchema } from './common';
import { actsForCounterparty, can, type AccessSubject, type Permission } from './permissions';

// ── Заявки на обслуживание оргтехники (ADR 0085) ──
// Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
// которую согласует заказчик, а после работ — приёмка. Здесь живут статусы, коридоры переходов и
// схемы всех ручек модуля; кто и что может — в permissions.ts, область — в lib/access.ts на сервере.

// ── Статусы ──

export const SERVICE_REQUEST_STATUSES = [
  'new',
  'assigned',
  'diagnostics',
  'estimate_review',
  'in_work',
  'done',
  'accepted',
  'cancelled',
] as const;
export const serviceRequestStatusSchema = z.enum(SERVICE_REQUEST_STATUSES);
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export const serviceRequestStatusLabels: Record<ServiceRequestStatus, string> = {
  new: 'Новая',
  assigned: 'Назначен сервис',
  diagnostics: 'Диагностика',
  estimate_review: 'Смета на согласовании',
  in_work: 'В работе',
  // Не «Выполнена»: в списке этот статус стоит рядом с «Принята», и терминальным выглядеть не
  // должен — работа предъявлена, но её ещё не приняли.
  done: 'Ожидает приёмки',
  accepted: 'Принята',
  cancelled: 'Отменена',
};

export const serviceRequestStatusColors: Record<ServiceRequestStatus, string> = {
  new: 'blue',
  assigned: 'cyan',
  diagnostics: 'geekblue',
  estimate_review: 'gold',
  in_work: 'orange',
  done: 'lime',
  accepted: 'green',
  cancelled: 'red',
};

/** Закрытая заявка: ни ход, ни правка ей больше не положены. */
export function isServiceRequestClosed(status: ServiceRequestStatus): boolean {
  return status === 'accepted' || status === 'cancelled';
}

// ── Коридоры переходов ──
// Их три, а не один общий: у надстройки «Оператор (оргтехника)» есть право `serviceRequests.status`,
// и по общей таблице она смогла бы выполнить шаги сервиса — взять заявку в диагностику, предъявить
// смету, закрыть работы. Портал скрывает кнопки, сервер отказывает, и второе не зависит от первого.

/** Исполнитель: только то, что делает сам. */
export const SERVICE_EXECUTOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  assigned: ['diagnostics', 'new'], // взять в диагностику · отказаться (причина)
  diagnostics: ['estimate_review'], // предъявить смету
  estimate_review: [],
  in_work: ['done', 'diagnostics'], // закрыть · переоткрыть смету (причина)
  done: [],
  accepted: [],
  cancelled: [],
};

/** Оператор оргтехники: назначение, согласование, приёмка, отмена. */
export const SERVICE_OPERATOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: ['assigned', 'cancelled'],
  // Переназначение — тот же статус, другой исполнитель: заявка не откатывается назад, но её
  // возраст в статусе обнуляется, иначе новый сервис наследовал бы чужое ожидание.
  assigned: ['assigned', 'cancelled'],
  diagnostics: ['assigned', 'cancelled'],
  estimate_review: ['in_work', 'diagnostics', 'cancelled'], // согласовать · отклонить
  in_work: ['cancelled'],
  done: ['accepted', 'in_work'], // принять · вернуть на доработку
  accepted: [],
  cancelled: [],
};

/**
 * Откаты администратора. Дуги `in_work → estimate_review` здесь намеренно нет: единственный путь
 * изменить согласованную смету — переоткрытие в «Диагностику», и второй путь назад сделал бы этот
 * инвариант необязательным.
 */
export const SERVICE_ADMIN_ROLLBACKS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  assigned: ['new'],
  diagnostics: ['assigned'],
  estimate_review: ['diagnostics'],
  in_work: [],
  done: ['in_work'],
  accepted: ['done'],
  cancelled: ['new'],
};

/**
 * Что субъекту доступно из текущего статуса. Одна функция на сервер и портал: разойдись они —
 * кнопка вела бы в 403 либо действие оставалось бы недоступным при разрешающем сервере.
 *
 * Администратор получает **объединение** коридоров: он разбирает ошибки и доводит заявку за любую
 * сторону. Спрашивается право сметы, а не имя роли — вне контрагента-сервиса оно есть только у
 * администратора, и следующий субъект с этим правом обязан получить те же дуги, а не остаться без
 * них.
 */
export function allowedServiceStatusTransitions(
  from: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
): ServiceRequestStatus[] {
  if (!subject) return [];
  if (actsForCounterparty(subject, 'service')) return [...SERVICE_EXECUTOR_TRANSITIONS[from]];
  if (!can(subject, 'serviceRequests.status')) return [];
  const allowed = new Set<ServiceRequestStatus>(SERVICE_OPERATOR_TRANSITIONS[from]);
  if (can(subject, 'serviceRequests.estimate')) {
    for (const to of SERVICE_EXECUTOR_TRANSITIONS[from]) allowed.add(to);
  }
  if (can(subject, 'requests.rollbackStatus')) {
    for (const to of SERVICE_ADMIN_ROLLBACKS[from]) allowed.add(to);
  }
  return [...allowed];
}

export function canTransitionServiceStatus(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
  subject: AccessSubject | null | undefined,
): boolean {
  return allowedServiceStatusTransitions(from, subject).includes(to);
}

/**
 * Переход, отменяющий чужую работу, требует объяснения: без него в истории останется пара строк, по
 * которой не понять, ошиблись сервисом, отказался исполнитель или смета оказалась вдвое дороже.
 */
export function serviceStatusChangeRequiresReason(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): boolean {
  if (to === 'cancelled') return true;
  if (from === 'assigned' && to === 'new') return true; // отказ исполнителя и откат назначения
  if (from === 'estimate_review' && to === 'diagnostics') return true; // отклонение сметы
  if (from === 'in_work' && to === 'diagnostics') return true; // переоткрытие сметы
  if (from === 'done' && to === 'in_work') return true; // возврат на доработку
  return false;
}

/**
 * Что заявка теряет, возвращаясь назад. Заявка после возврата не должна выглядеть так, будто её и
 * не двигали: снимок согласования под чужой ревизией сметы или факт закрытия у заявки «в работе»
 * означали бы решение, которого никто не принимал.
 *
 * Гарантия при возврате снимается целиком — и посчитанная, и введённая руками. Причина в том, что
 * возврат отменяет само выполнение: гарантия не начиналась, отсчитывать её не от чего, а строка без
 * выполнения гарантии и не держит (CHECK в БД). Талон при этом никуда не делся — дату введут заново
 * при повторном закрытии, той же ручкой; `warranty_until_manual` отличает её от посчитанной, чтобы
 * повторное закрытие не перетёрло дату из талона своим расчётом.
 */
export interface ServiceTransitionReset {
  /** Снять назначенного исполнителя. */
  executor: boolean;
  /** Стереть смету целиком вместе с её ревизией и снимком предъявления. */
  estimate: boolean;
  /** Стереть снимок согласования (кто, когда, какая ревизия). */
  approval: boolean;
  /** Стереть факт закрытия: дату, итог, корректировку и отметки выполнения по строкам. */
  completion: boolean;
  /** Стереть снимок приёмки. */
  acceptance: boolean;
}

const NO_RESET: ServiceTransitionReset = {
  executor: false,
  estimate: false,
  approval: false,
  completion: false,
  acceptance: false,
};

export function serviceResetOnTransition(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): ServiceTransitionReset {
  // Отказ исполнителя и откат назначения: заявка снова ничья.
  if (from === 'assigned' && to === 'new') return { ...NO_RESET, executor: true };
  // Отмена возвращает заявку в состояние «ничего не делали»: она остаётся историей того, что
  // собирались чинить, но ни исполнителя, ни согласованной сметы у неё больше нет.
  if (to === 'cancelled') return { ...NO_RESET, executor: true, approval: true };
  if (from === 'cancelled' && to === 'new') {
    return { ...NO_RESET, executor: true, estimate: true, approval: true };
  }
  // Отклонение сметы, её переоткрытие и откат согласования — снимок согласования недействителен.
  if (to === 'diagnostics') return { ...NO_RESET, approval: true };
  // Возврат на доработку и одноимённый откат: факт закрытия предъявлен заново.
  if (from === 'done' && to === 'in_work') return { ...NO_RESET, completion: true };
  if (from === 'accepted' && to === 'done') return { ...NO_RESET, acceptance: true };
  return NO_RESET;
}

// ── Кого ждут ──

/**
 * От кого сейчас ждут шага. Значения только те, у кого шаг в цикле есть: заказчик решений не
 * принимает — приёмку делает оператор, — поэтому `customer` здесь не заводится. Появится шаг
 * заказчика (например, подтверждение стоимости площадкой) — появится и значение вместе с веткой
 * предиката.
 */
export const SERVICE_WAITING_ON = ['operator', 'service', 'nobody'] as const;
export type ServiceWaitingOn = (typeof SERVICE_WAITING_ON)[number];

export const serviceWaitingOnLabels: Record<ServiceWaitingOn, string> = {
  operator: 'Ждёт оператора',
  service: 'Ждёт сервис',
  nobody: 'Закрыта',
};

export function serviceWaitingOn(status: ServiceRequestStatus): ServiceWaitingOn {
  switch (status) {
    case 'new':
    case 'estimate_review':
    case 'done':
      return 'operator';
    case 'assigned':
    case 'diagnostics':
    case 'in_work':
      return 'service';
    case 'accepted':
    case 'cancelled':
      return 'nobody';
  }
}

/**
 * Ждут ли сейчас этого субъекта. Сравнивать `waitingOn` с ролью напрямую нельзя: у оператора
 * оргтехники роль — «Штаб» или «Отдел» (сторону задаёт надстройка), а у сервиса роль — «Оператор
 * (внешний исполнитель)» (сторону задаёт тип контрагента). Поэтому сторона определяется правами.
 */
export function isWaitingOn(
  subject: AccessSubject | null | undefined,
  waiting: ServiceWaitingOn,
): boolean {
  if (!subject || waiting === 'nobody') return false;
  if (waiting === 'service') return actsForCounterparty(subject, 'service');
  return can(subject, 'serviceRequests.assign');
}

// ── Номер заявки ──

/** Префикс сквозного номера: «М-» у мусора, «ТС-» у техники, «СО-» у сервисного обслуживания. */
export const SERVICE_REQUEST_NUMBER_PREFIX = 'СО-';

export function formatServiceRequestNumber(num: number): string {
  return `${SERVICE_REQUEST_NUMBER_PREFIX}${num}`;
}

/**
 * Номер из строки поиска: человек ищет и «СО-14», и «со-14», и просто «14». Возвращает `null`,
 * если это не номер, — тогда поиск идёт обычным текстом по модели и номерам техники.
 */
export function parseServiceRequestNumberSearch(search: string): number | null {
  const trimmed = search.trim().replace(/^со-?/i, '');
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return num > 0 ? num : null;
}

// ── Смета ──

export const SERVICE_ITEM_KINDS = ['part', 'service'] as const;
export const serviceItemKindSchema = z.enum(SERVICE_ITEM_KINDS);
export type ServiceItemKind = (typeof SERVICE_ITEM_KINDS)[number];

export const serviceItemKindLabels: Record<ServiceItemKind, string> = {
  part: 'Запчасть',
  service: 'Услуга',
};

/** Служебная строка гарантийного ремонта (Р27): её не набирают руками, но она должна быть узнаваема. */
export const WARRANTY_REPAIR_ITEM_NAME = 'Гарантийный ремонт';

const itemNameSchema = z.string().trim().min(2, 'Укажите наименование').max(255);
const quantitySchema = z.number().positive('Количество больше нуля').max(9999);
const priceSchema = z.number().min(0, 'Цена не может быть отрицательной').max(99_999_999);

export const serviceEstimateItemSchema = z.object({
  kind: serviceItemKindSchema,
  name: itemNameSchema,
  quantity: quantitySchema.default(1),
  unitPrice: priceSchema,
  /** Что обещали: срок гарантии в месяцах. Дата считается при закрытии от даты выполнения работ. */
  warrantyMonths: z.number().int().min(1).max(120).nullish(),
});
export type ServiceEstimateItemInput = z.infer<typeof serviceEstimateItemSchema>;

/**
 * Состав сметы передаётся целиком, а не построчно: смета — документ, и «добавить строку» без
 * остальных строк не имеет смысла. Пустой список разрешён (черновик), а вот предъявить пустую
 * смету нельзя — это проверяет сервер при переходе.
 */
export const putServiceEstimateSchema = z.object({
  items: z.array(serviceEstimateItemSchema).max(200),
  version: z.number().int().nonnegative(),
});
export type PutServiceEstimateInput = z.infer<typeof putServiceEstimateSchema>;

// ── Гарантийное обращение ──

export const WARRANTY_CLAIM_SOURCES = ['equipment', 'item'] as const;
export const warrantyClaimSourceSchema = z.enum(WARRANTY_CLAIM_SOURCES);
export type WarrantyClaimSource = (typeof WARRANTY_CLAIM_SOURCES)[number];

export const warrantyClaimSourceLabels: Record<WarrantyClaimSource, string> = {
  equipment: 'Гарантия на технику',
  item: 'Гарантия на прошлый ремонт',
};

/**
 * Источник гарантийного обращения: не флаг «гарантийная», а ответ на вопрос, по чьей гарантии
 * обращаются. Без него спор с сервисом не разрешить — «гарантийная заявка» ничего не подтверждает.
 *
 * У источника `item` обязательна ссылка на строку сметы прошлой заявки, у `equipment` её быть не
 * должно: гарантия поставщика висит на самой единице.
 */
export const warrantyClaimSchema = z
  .object({
    source: warrantyClaimSourceSchema.nullish(),
    itemId: uuidSchema.nullish(),
  })
  .refine((v) => v.source !== 'item' || !!v.itemId, {
    message: 'Укажите, по какой позиции прошлого ремонта обращаетесь',
    path: ['itemId'],
  })
  .refine((v) => v.source !== 'equipment' || !v.itemId, {
    message: 'У гарантии на технику позиции ремонта не бывает',
    path: ['itemId'],
  });

// ── Заявка ──

export const SERVICE_REQUEST_SORT_FIELDS = [
  'num',
  'status',
  'equipment',
  'object',
  'service',
  'dueDate',
  'statusChangedAt',
  'createdAt',
] as const;

const descriptionSchema = z.string().trim().min(5, 'Опишите неисправность').max(4000);

export const serviceRequestListQuerySchema = baseListQuery(SERVICE_REQUEST_SORT_FIELDS).extend({
  status: serviceRequestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  equipmentId: uuidSchema.optional(),
  equipmentTypeId: uuidSchema.optional(),
  serviceCounterpartyId: uuidSchema.optional(),
  /** «Ждёт меня» — очередь, из которой оператор и сервис начинают работу. */
  waitingOnMe: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Заявки, заведённые самим пользователем: «где мои». */
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Срок вышел, а заявка не закрыта. */
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Закрыта, но акта или счёта нет — из-за них и заведён вид файла (Р16). */
  awaitingDocuments: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  warrantyClaim: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  archive: archiveFilterSchema,
});

export const createServiceRequestSchema = z.object({
  officeEquipmentId: uuidSchema,
  description: descriptionSchema,
  dueDate: dateOnlySchema.nullish(),
  /**
   * Отдел, от имени которого заявка (ADR 0085 §8). Подсказывается владельцем техники либо
   * единственным отделом автора, но выбирается человеком: сотрудник соседнего отдела чинит «чужой»
   * принтер чаще, чем кажется. `null` — заявка объектная, от площадки.
   */
  customerDepartmentId: uuidSchema.nullish(),
  responsibleName: contactNameSchema.optional().default(''),
  responsiblePhone: optionalPhoneSchema.optional().default(''),
  comment: z.string().trim().max(2000).optional().default(''),
  warrantyClaim: warrantyClaimSchema.optional(),
  fileIds: z.array(uuidSchema).max(20).optional().default([]),
});
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = z.object({
  description: descriptionSchema.optional(),
  dueDate: dateOnlySchema.nullish(),
  customerDepartmentId: uuidSchema.nullish(),
  responsibleName: contactNameSchema.optional(),
  responsiblePhone: optionalPhoneSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  warrantyClaim: warrantyClaimSchema.optional(),
  version: z.number().int().nonnegative(),
});
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;

// ── Ход заявки ──
// Каждый переход с содержанием — своя ручка со своей схемой (ADR 0085 §18): так проверка условия
// перехода не может разъехаться с проверкой данных этого перехода. `/status` остаётся отмене и
// административным откатам, у которых из данных только причина.

const reasonSchema = z.string().trim().min(3, 'Укажите причину').max(1000);

export const assignServiceSchema = z.object({
  serviceCounterpartyId: uuidSchema,
  /** Причина обязательна при переназначении: у прежнего сервиса отбирают работу. */
  reason: reasonSchema.optional(),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type AssignServiceInput = z.infer<typeof assignServiceSchema>;

export const declineServiceRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});
export type DeclineServiceRequestInput = z.infer<typeof declineServiceRequestSchema>;

export const startServiceRequestSchema = z.object({
  version: z.number().int().nonnegative(),
});

/**
 * Предъявление сметы. `warrantyRepair` — отдельный режим (Р27): смета из одной служебной строки с
 * нулевой суммой. Он не «пустая смета», а осознанное «чиним по гарантии, денег нет», и требует
 * источника гарантии в самой заявке.
 */
export const submitServiceEstimateSchema = z.object({
  warrantyRepair: z.boolean().optional().default(false),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type SubmitServiceEstimateInput = z.infer<typeof submitServiceEstimateSchema>;

/** Согласование сметы: одна ручка на «да» и «нет» — у них одно право, одна область и один момент. */
export const approveServiceEstimateSchema = z
  .object({
    approved: z.boolean(),
    reason: reasonSchema.optional(),
    version: z.number().int().nonnegative(),
  })
  .refine((v) => v.approved || !!v.reason, {
    message: 'Укажите причину отклонения',
    path: ['reason'],
  });
export type ApproveServiceEstimateInput = z.infer<typeof approveServiceEstimateSchema>;

export const reopenServiceEstimateSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});

/**
 * Закрытие работ. Итог **не принимается**: его считает сервер из строк, иначе сумма строк и итог
 * разошлись бы молча. Клиент присылает отметки факта по каждой строке и, если нужно, скидку акта.
 */
export const completeServiceRequestSchema = z.object({
  completedOn: dateOnlySchema,
  items: z
    .array(
      z.object({
        id: uuidSchema,
        performed: z.boolean(),
        /** Фактическое количество; больше согласованного не бывает — это удорожание. */
        actualQuantity: quantitySchema.nullish(),
        /** Дата гарантии из талона; пусто — сервер посчитает её от даты выполнения. */
        warrantyUntil: dateOnlySchema.nullish(),
      }),
    )
    .max(200),
  /** Скидка по акту: строго отрицательная сумма и обязательная причина — порознь не бывают. */
  adjustmentAmount: z.number().negative('Скидка — отрицательная сумма').nullish(),
  adjustmentReason: z.string().trim().max(500).optional().default(''),
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type CompleteServiceRequestInput = z.infer<typeof completeServiceRequestSchema>;

export const acceptServiceRequestSchema = z.object({
  comment: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});

export const reworkServiceRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().nonnegative(),
});

/** Отмена и административные откаты: причина — единственное содержание такого перехода. */
export const serviceStatusChangeSchema = z.object({
  status: serviceRequestStatusSchema,
  reason: z.string().trim().max(1000).optional().default(''),
  version: z.number().int().nonnegative(),
});
export type ServiceStatusChangeInput = z.infer<typeof serviceStatusChangeSchema>;

export const serviceCommentSchema = z.object({
  serviceComment: z.string().trim().max(2000),
  version: z.number().int().nonnegative(),
});

// ── Файлы ──

export const SERVICE_FILE_KINDS = [
  'attachment',
  'estimate',
  'act',
  'invoice',
  'warranty_card',
] as const;
export const serviceFileKindSchema = z.enum(SERVICE_FILE_KINDS);
export type ServiceFileKind = (typeof SERVICE_FILE_KINDS)[number];

export const serviceFileKindLabels: Record<ServiceFileKind, string> = {
  attachment: 'Вложение',
  estimate: 'Смета',
  act: 'Акт',
  invoice: 'Счёт',
  warranty_card: 'Гарантийный талон',
};

/**
 * Виды документов, которыми подтверждают работу. Их можно подшивать и после приёмки — «акт пришлю
 * завтра» иначе означало бы потерянную бумагу (Р16, Р29); удалять их после приёмки нельзя.
 */
export const SERVICE_CLOSING_DOCUMENT_KINDS: readonly ServiceFileKind[] = [
  'act',
  'invoice',
  'warranty_card',
];

export function isServiceClosingDocument(kind: ServiceFileKind): boolean {
  return SERVICE_CLOSING_DOCUMENT_KINDS.includes(kind);
}

export const attachServiceFilesSchema = z.object({
  fileIds: z.array(uuidSchema).min(1).max(20),
  kind: serviceFileKindSchema.optional().default('attachment'),
});

// ── DTO ──

export interface ServiceRequestEquipmentDto {
  id: string;
  /** Реквизиты — снимок на момент заведения: карточку могли переименовать и перезакрепить. */
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  typeName: string;
}

export interface ServiceRequestObjectDto {
  id: string;
  code: string;
  name: string;
}

export interface ServiceRequestDepartmentDto {
  id: string;
  code: string;
  name: string;
}

export interface ServiceRequestCounterpartyDto {
  id: string;
  name: string;
}

export interface ServiceRequestItemDto {
  id: string;
  kind: ServiceItemKind;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** Факт: `null` — работы ещё не закрывали, и у строки нет ни выполнения, ни суммы факта. */
  performed: boolean | null;
  actualQuantity: number | null;
  actualAmount: number | null;
  warrantyMonths: number | null;
  warrantyUntil: string | null;
  warrantyUntilManual: boolean;
}

export interface ServiceRequestFileDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  kind: ServiceFileKind;
  attachedAt: string;
}

export interface ServiceRequestApprovalDto {
  by: string | null;
  byName: string;
  at: string;
  /** Какая именно ревизия согласована: по ней сервер и пускает работы к закрытию. */
  revision: number;
}

export interface ServiceRequestCompletionDto {
  completedAt: string;
  /** Итог по акту: сумма выполненных строк плюс скидка. Считает сервер. */
  totalAmount: number | null;
  adjustmentAmount: number | null;
  adjustmentReason: string;
}

export interface ServiceRequestWarrantyClaimDto {
  source: WarrantyClaimSource;
  /** Позиция прошлого ремонта — только у источника `item`. */
  itemId: string | null;
  itemName: string;
  /** Номер заявки, по гарантии которой обращаются: спор ведут именно по нему. */
  sourceRequestNum: number | null;
}

export interface ServiceRequestDto {
  id: string;
  num: number;
  displayNumber: string;
  status: ServiceRequestStatus;
  statusChangedAt: string;
  waitingOn: ServiceWaitingOn;
  equipment: ServiceRequestEquipmentDto;
  object: ServiceRequestObjectDto;
  /** Отдел-заказчик и отдел-владелец: по ним считается область роли отдела. */
  customerDepartment: ServiceRequestDepartmentDto | null;
  equipmentDepartment: ServiceRequestDepartmentDto | null;
  description: string;
  dueDate: string | null;
  responsibleName: string;
  responsiblePhone: string;
  service: ServiceRequestCounterpartyDto | null;
  warrantyClaim: ServiceRequestWarrantyClaimDto | null;
  /** Смета: текущая ревизия и её строки. */
  estimateRevision: number;
  estimateSubmittedAt: string | null;
  estimatedTotalAmount: number | null;
  approval: ServiceRequestApprovalDto | null;
  items: ServiceRequestItemDto[];
  completion: ServiceRequestCompletionDto | null;
  acceptedByName: string;
  acceptedAt: string | null;
  comment: string;
  serviceComment: string;
  files: ServiceRequestFileDto[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}

/**
 * Правит ли субъект саму заявку: заказчик — только пока она «Новая». После назначения за заявкой
 * стоят договорённости с исполнителем, и менять её предмет задним числом нельзя.
 */
export function isServiceRequestEditable(status: ServiceRequestStatus): boolean {
  return status === 'new';
}

/** Права модуля — одним списком: он нужен и матрице, и проверке «открыт ли раздел». */
export const SERVICE_REQUEST_PERMISSIONS: readonly Permission[] = [
  'serviceRequests.read',
  'serviceRequests.create',
  'serviceRequests.update',
  'serviceRequests.delete',
  'serviceRequests.assign',
  'serviceRequests.estimate',
  'serviceRequests.approveEstimate',
  'serviceRequests.status',
  'serviceRequests.files',
];

/**
 * Подписи полей в истории заявки; ключи проставляет сервер при вычислении изменений
 * (`service-request-diff.ts`). Словарь один на правку заявки, правку сметы и закрытие: читателю
 * истории всё равно, какая ручка породила строку, — ему важно, что именно изменилось.
 */
export const serviceRequestChangeLabels: Record<string, string> = {
  description: 'Неисправность',
  dueDate: 'Желаемый срок',
  customerDepartment: 'Отдел-заказчик',
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон',
  comment: 'Комментарий',
  warrantyClaim: 'Обращение по гарантии',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Удалены файлы',
  estimateItemsAdded: 'Добавлено в смету',
  estimateItemsRemoved: 'Убрано из сметы',
  // Что предъявил исполнитель при закрытии: без этих двух строк «закрыли дешевле» осталось бы
  // необъяснённым, а гарантию на неустановленную деталь искали бы годом позже.
  itemsNotPerformed: 'Не выполнено',
  itemsPartial: 'Выполнено частично',
};
