import { z } from 'zod';
import { archiveFilterSchema, baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { contactNameSchema, contactPhoneSchema } from './common';
import { actsForCounterparty, can, type AccessSubject, type Permission } from './permissions';
import type { ModuleMailOutcome } from './module-mail';

// ── Заявки на обслуживание оргтехники (ADR 0085) ──
// Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
// которую согласует заказчик, а после работ — приёмка. Здесь живут статусы, коридоры переходов и
// схемы всех ручек модуля; кто и что может — в permissions.ts, область — в lib/access.ts на сервере.

// ── Статусы ──

export const SERVICE_REQUEST_STATUSES = [
  'new',
  'it_approved',
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
  // Подпись говорит о состоявшемся решении, а не об ожидании: «На согласовании ИТ» пришлось бы
  // ставить «Новой», в которой заявка и ждёт визы. Здесь виза уже есть, и ждут оператора.
  it_approved: 'Согласована ИТ',
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
  it_approved: 'purple',
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
// Их четыре, а не один общий: у надстройки «Оператор (оргтехника)» есть право
// `serviceRequests.status`, и по общей таблице она смогла бы выполнить шаги сервиса — взять заявку
// в диагностику, предъявить смету, закрыть работы. Портал скрывает кнопки, сервер отказывает, и
// второе не зависит от первого.

/** Исполнитель: только то, что делает сам. */
export const SERVICE_EXECUTOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  it_approved: [],
  // Отказ возвращает заявку оператору, а не в «Новую»: виза ИТ уже дана, и решение «внешний
  // ремонт нужен» отказом исполнителя не отменяется — менять надо исполнителя, а не решение.
  assigned: ['diagnostics', 'it_approved'], // взять в диагностику · отказаться (причина)
  diagnostics: ['estimate_review'], // предъявить смету
  estimate_review: [],
  in_work: ['done', 'diagnostics'], // закрыть · переоткрыть смету (причина)
  done: [],
  accepted: [],
  cancelled: [],
};

/**
 * Отдел ИТ (план модернизации, Р51): решение одно — нужен ли внешний ремонт вообще. Отказ — это
 * отмена с причиной, а не свой терминальный статус: «закрыта без результата» у модуля уже есть, и
 * второе имя для того же состояния только делило бы отчёты пополам (Р53).
 */
export const SERVICE_IT_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: ['it_approved', 'cancelled'],
  it_approved: [],
  assigned: [],
  diagnostics: [],
  estimate_review: [],
  in_work: [],
  done: [],
  accepted: [],
  cancelled: [],
};

/** Оператор оргтехники: назначение, согласование сметы, приёмка, отмена. */
export const SERVICE_OPERATOR_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  // Назначить сервис из «Новой» больше нельзя: сначала виза ИТ (Р51). Отменить — можно: заявку,
  // которую отзывает сам заказчик, незачем гонять через согласование.
  new: ['cancelled'],
  it_approved: ['assigned', 'cancelled'],
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
 *
 * Откат назначения ведёт в «Согласована ИТ», а не в «Новую»: виза — состоявшееся решение, и
 * отматывать её заодно с назначением значило бы отправлять заявку к ИТ второй раз без причины.
 */
export const SERVICE_ADMIN_ROLLBACKS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  new: [],
  it_approved: ['new'],
  assigned: ['it_approved'],
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
  // Виза ИТ — единственный шаг, который не требует права хода: согласующий заявки не ведёт, он
  // отвечает на один вопрос. Требуй мы здесь `serviceRequests.status`, полномочие пришлось бы
  // выдавать вместе с правом двигать заявку по всему циклу.
  const allowed = new Set<ServiceRequestStatus>(
    can(subject, 'serviceRequests.approveIt') ? SERVICE_IT_TRANSITIONS[from] : [],
  );
  if (!can(subject, 'serviceRequests.status')) return [...allowed];
  for (const to of SERVICE_OPERATOR_TRANSITIONS[from]) allowed.add(to);
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
  if (from === 'assigned' && to === 'it_approved') return true; // отказ исполнителя и откат назначения
  if (from === 'it_approved' && to === 'new') return true; // откат визы ИТ
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
  /** Снять визу отдела ИТ (кто и когда). */
  itApproval: boolean;
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
  itApproval: false,
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
  // Отказ исполнителя и откат назначения: заявка снова ничья, но виза ИТ остаётся — решение
  // «внешний ремонт нужен» отказом подрядчика не отменяется.
  if (from === 'assigned' && to === 'it_approved') return { ...NO_RESET, executor: true };
  // Откат самой визы: заявка возвращается к отделу ИТ, и подпись под ней держаться не должна.
  if (from === 'it_approved' && to === 'new') return { ...NO_RESET, itApproval: true };
  // Отмена возвращает заявку в состояние «ничего не делали»: она остаётся историей того, что
  // собирались чинить, но ни исполнителя, ни согласованной сметы у неё больше нет.
  if (to === 'cancelled') return { ...NO_RESET, executor: true, approval: true };
  if (from === 'cancelled' && to === 'new') {
    // Возвращённая отменённая заявка проходит цикл заново — в том числе визу ИТ: отклонить её мог
    // как раз он, и сохранённая подпись означала бы согласие, которого не было.
    return { ...NO_RESET, itApproval: true, executor: true, estimate: true, approval: true };
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
export const SERVICE_WAITING_ON = ['it', 'operator', 'service', 'nobody'] as const;
export type ServiceWaitingOn = (typeof SERVICE_WAITING_ON)[number];

export const serviceWaitingOnLabels: Record<ServiceWaitingOn, string> = {
  it: 'Ждёт ИТ',
  operator: 'Ждёт оператора',
  service: 'Ждёт сервис',
  nobody: 'Закрыта',
};

export function serviceWaitingOn(status: ServiceRequestStatus): ServiceWaitingOn {
  switch (status) {
    // «Новая» ждёт не оператора, а отдел ИТ: до визы назначать сервис нечем (Р51).
    case 'new':
      return 'it';
    case 'it_approved':
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
  if (waiting === 'it') return can(subject, 'serviceRequests.approveIt');
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
  /** Только срочные: очередь, с которой начинают день оператор и ИТ. */
  urgent: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  archive: archiveFilterSchema,
});

/**
 * Срочность: флаг и объяснение неразрывны (то же CHECK держит и БД). Чекбокс без причины через
 * месяц стоит у всех заявок — отбирать им становится нечего, а очередь, отсортированная по
 * признаку, который есть у каждого, ничем не отличается от несортированной.
 *
 * Проверка вынесена функцией, а не написана схемой на месте: срочность ставят в трёх местах
 * (заведение, правка, своя ручка), и в правке пара приходит наполовину — `PATCH` присылает только
 * изменившееся. Там условие считается по «склеенному» состоянию на сервере, а не по телу запроса.
 */
export const urgencyReasonSchema = z.string().trim().max(500);

export function urgencyIssue(value: { isUrgent: boolean; urgencyReason: string }): string | null {
  const reason = value.urgencyReason.trim();
  if (value.isUrgent && !reason) return 'Объясните, почему заявка срочная';
  if (!value.isUrgent && reason) return 'Причина без отметки «Срочная» ничего не объявляет';
  return null;
}

/** Схема с полной парой: заведение и своя ручка присылают оба поля разом. */
const withUrgency = <T extends z.ZodType<{ isUrgent: boolean; urgencyReason: string }>>(
  schema: T,
): T =>
  schema.superRefine((value, ctx) => {
    const issue = urgencyIssue(value);
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ['urgencyReason'] });
    }
  }) as unknown as T;

export const createServiceRequestSchema = withUrgency(
  z.object({
    officeEquipmentId: uuidSchema,
    description: descriptionSchema,
    dueDate: dateOnlySchema.nullish(),
    /**
     * Отдел, от имени которого заявка (ADR 0085 §8). Подсказывается владельцем техники либо
     * единственным отделом автора, но выбирается человеком: сотрудник соседнего отдела чинит «чужой»
     * принтер чаще, чем кажется. `null` — заявка объектная, от площадки.
     */
    customerDepartmentId: uuidSchema.nullish(),
    /**
     * Заявитель и его телефон — обязательны (план модернизации, Р49). До этого обязательность жила
     * только в форме портала (`ResponsibleFields`), а схема принимала пустые строки: заявка без
     * контакта заводилась любым клиентом мимо формы, и именно её сервис получал первой — ехать по
     * адресу, не зная, к кому.
     */
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    warrantyClaim: warrantyClaimSchema.optional(),
    isUrgent: z.boolean().optional().default(false),
    urgencyReason: urgencyReasonSchema.optional().default(''),
    fileIds: z.array(uuidSchema).max(20).optional().default([]),
  }),
);
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;

/**
 * Правка присылает только изменившееся, поэтому у срочности здесь **нет значения по умолчанию**:
 * `default(false)` означал бы, что правка телефона молча снимает срочность — тот же подвох, из-за
 * которого поля со значением по умолчанию переобъявляются в `updateOfficeEquipmentTypeSchema`.
 * Пару сверяет сервер по склеенному состоянию (`urgencyIssue`), потому что схема видит половину.
 */
export const updateServiceRequestSchema = z.object({
  description: descriptionSchema.optional(),
  dueDate: dateOnlySchema.nullish(),
  customerDepartmentId: uuidSchema.nullish(),
  responsibleName: contactNameSchema.optional(),
  responsiblePhone: contactPhoneSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  warrantyClaim: warrantyClaimSchema.optional(),
  isUrgent: z.boolean().optional(),
  urgencyReason: urgencyReasonSchema.optional(),
  version: z.number().int().nonnegative(),
});
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;

/**
 * Срочность отдельной ручкой: её ставят и снимают не только при правке заявки. Заказчик правит
 * только «Новую» (ADR 0085 §8), а «сломался единственный принтер на площадке» выясняется и когда
 * заявка уже у сервиса, — поэтому оператор меняет признак в любой момент до закрытия.
 */
export const setServiceUrgencySchema = withUrgency(
  z.object({
    isUrgent: z.boolean(),
    urgencyReason: urgencyReasonSchema.default(''),
    version: z.number().int().nonnegative(),
  }),
);
export type SetServiceUrgencyInput = z.infer<typeof setServiceUrgencySchema>;

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

/**
 * Виза отдела ИТ (Р51): одна ручка на «да» и «нет» — у них одно право, одна область и один момент
 * решения, тот же приём, что у согласования сметы. Отказ закрывает заявку, поэтому причина
 * обязательна: «ИТ отказал» без объяснения заказчик прочитает как молчание.
 */
export const approveServiceItSchema = z
  .object({
    approved: z.boolean(),
    reason: reasonSchema.optional(),
    version: z.number().int().nonnegative(),
  })
  .refine((v) => v.approved || !!v.reason, {
    message: 'Укажите причину отказа',
    path: ['reason'],
  });
export type ApproveServiceItInput = z.infer<typeof approveServiceItSchema>;

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
  /** Место внутри объекта на момент заведения: «Корпус 3, каб. 214». Тот же снимок (Р57). */
  location: string;
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

/**
 * Виза отдела ИТ: кто и когда решил, что внешний ремонт нужен (Р51). Имя — снимком, как у
 * согласования сметы: подпись должна читаться и после того, как учётку закрыли.
 */
export interface ServiceRequestItApprovalDto {
  by: string | null;
  byName: string;
  at: string;
  /** Виза проставлена самим заведением: заявку завёл обладатель права (Р52). */
  auto: boolean;
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
  /** Заявитель: кто обратился и по какому номеру с ним связываться (Р49). */
  responsibleName: string;
  responsiblePhone: string;
  /** Срочность и её объяснение: без второго первое не показывается — их и не бывает порознь. */
  isUrgent: boolean;
  urgencyReason: string;
  service: ServiceRequestCounterpartyDto | null;
  /** Виза ИТ; `null` — заявка ещё ждёт решения отдела (Р51). */
  itApproval: ServiceRequestItApprovalDto | null;
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
 * Ответ действия, которое сопровождается письмом службе (план
 * `office-equipment-mail-and-history-plan.md`, Р67): заявка плюс исход почтовой части.
 *
 * Отдельный тип, а не поле карточки: исход относится к **действию**, а не к заявке — в списке и
 * при повторном открытии его нет и быть не может. И он обязан дойти до человека сразу: «заявка
 * заведена, но служба не оповещена» узнаётся в момент заведения, а не когда за ней не приехали.
 */
export interface ServiceRequestWithMailDto {
  request: ServiceRequestDto;
  mail: ModuleMailOutcome;
}

/**
 * Повторная отправка письма службе (Р70). Ключ идемпотентности генерирует портал — один на открытие
 * диалога, а не на нажатие: два одновременных клика и повтор HTTP обязаны дать одно письмо.
 *
 * Порядкового номера попытки здесь нет намеренно: его пришлось бы считать чтением, а между чтением
 * и вставкой помещается второе нажатие.
 */
export const notifyServiceRequestSchema = z.object({ idempotencyKey: uuidSchema }).strict();
export type NotifyServiceRequestInput = z.infer<typeof notifyServiceRequestSchema>;

export interface ServiceRequestNotifyResultDto {
  mail: ModuleMailOutcome;
  /** Куда ушло письмо — адреса без секретов: по ним видно, что настройка та самая. */
  recipients: string[];
}

/**
 * Есть ли у статуса письмо, которое можно повторить. Одна функция на сервер и портал: разойдись
 * они — кнопка вела бы в 422 либо повтор оставался бы недоступным там, где сервер его позволяет.
 *
 * Событие письма привязано к **входу в статус**, поэтому повторяются ровно два: «Новая» (заявка
 * ждёт визы ИТ) и «Отменена» (чтобы не выезжали зря).
 */
export function serviceMailRepeatable(status: ServiceRequestStatus): boolean {
  return status === 'new' || status === 'cancelled';
}

/**
 * Правит ли субъект саму заявку: заказчик — пока её никому не отдали. После назначения сервиса за
 * заявкой стоят договорённости с исполнителем, и менять её предмет задним числом нельзя.
 *
 * Статуса два, а не один: виза ИТ (Р51) стоит между заведением и назначением, и запирать правку
 * ею значило бы заводить новую заявку из-за опечатки в описании. Виза отвечает на «нужен ли
 * внешний ремонт», а не на «как он описан»; деньги стережёт вторая подпись — согласие оператора
 * со сметой.
 */
export function isServiceRequestEditable(status: ServiceRequestStatus): boolean {
  return status === 'new' || status === 'it_approved';
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
  'serviceRequests.approveIt',
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
  responsibleName: 'Заявитель',
  responsiblePhone: 'Телефон',
  isUrgent: 'Срочная',
  urgencyReason: 'Причина срочности',
  itApproval: 'Виза ИТ',
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
