import { z } from 'zod';
import {
  MIN_WASTE_VOLUME_M3,
  requestStatusSchema,
  requestTypeSchema,
  statusChangeRequiresReason,
} from './enums';
import type { RequestStatus, RequestType } from './enums';
import { baseListQuery, uuidSchema } from './common';
import type { FileDto } from './files';
import {
  MIN_REQUEST_DATE_MESSAGE,
  WORK_TIME_MESSAGE,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
} from './time';
import { isPricedRequestType } from './waste-tariffs';

// Сортировка доступна во всех столбцах таблицы заявок; ключ поля совпадает с ключом колонки.
export const WASTE_REQUEST_SORT_FIELDS = [
  'num',
  'objectName',
  'containerTypeName',
  'wasteTypeName',
  'requestType',
  'deliveryAt',
  'status',
  'operatorName',
  'comment',
  'createdByName',
  'createdAt',
] as const;

export const wasteRequestListQuerySchema = baseListQuery(WASTE_REQUEST_SORT_FIELDS).extend({
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  requestType: requestTypeSchema.optional(),
  /** Заявки, назначенные конкретному оператору вывоза (ADR 0010). */
  operatorCounterpartyId: uuidSchema.optional(),
  // поиск по сквозному номеру заявки (точное совпадение)
  num: z.coerce.number().int().positive().optional(),
  deliveryFrom: z.coerce.date().optional(),
  deliveryTo: z.coerce.date().optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * Сводка по статусам для виджета над списком. Из фильтров таблицы учитывается только объект:
 * фильтр по статусу свёл бы сводку к самой себе, а по номеру — к одной заявке.
 */
export const wasteRequestSummaryQuerySchema = z.object({
  objectId: uuidSchema.optional(),
});
export type WasteRequestSummaryQuery = z.infer<typeof wasteRequestSummaryQuerySchema>;

/** Количество видимых заявок в каждом статусе (удалённые не считаются). */
export type WasteRequestSummaryDto = Record<RequestStatus, number>;

const volumeSchema = z.coerce.number().int().min(MIN_WASTE_VOLUME_M3);

// ── Машины и талоны (ADR 0011) ──

/**
 * Машины с талонами предъявляются только при вывозе самосвалами: там рейсов несколько и на
 * каждый есть талон. Контейнерные операции (установка, замена, снятие) считаются по самим
 * контейнерам — машина там одна и по талонам не разбивается, поэтому закрываются они без окна.
 */
export function requiresWasteVehicles(t: RequestType): boolean {
  return t === 'waste_removal';
}

/** Сканов на один рейс бывает несколько (талон с двух сторон, весовая квитанция рядом). */
export const MAX_TICKETS_PER_VEHICLE = 20;

/**
 * Машина, вывезшая часть заявки: тип техники из справочника и талоны. Объём не вводится —
 * он равен вместимости выбранного типа («Самосвал 25 м³» → 25 м³): машина уезжает гружёной
 * целиком, а разнобой в ручном вводе давал бы расхождение там, где его нет. В строке машины
 * объём сохраняется снимком (тип потом могут переименовать или пересчитать).
 * Талон в самой схеме не требуется: машину заводят и до закрытия (правка заявки в работе), а
 * обязателен он к моменту «Выполнена» — там проверяется состояние всех машин заявки (ADR 0020).
 */
export const wasteRequestVehicleInputSchema = z.object({
  containerTypeId: uuidSchema,
  fileIds: z.array(uuidSchema).max(MAX_TICKETS_PER_VEHICLE).optional().default([]),
});
export type WasteRequestVehicleInput = z.infer<typeof wasteRequestVehicleInputSchema>;

/**
 * Талоны к уже заведённой машине. Нужны при повторном закрытии: после отката администратором
 * машины у заявки уже есть, и если талона у какой-то из них нет, приложить его иначе было бы
 * некуда — пришлось бы удалять рейс и заводить заново (ADR 0020).
 */
export const wasteVehicleTicketsInputSchema = z.object({
  vehicleId: uuidSchema,
  fileIds: z.array(uuidSchema).min(1).max(MAX_TICKETS_PER_VEHICLE),
});
export type WasteVehicleTicketsInput = z.infer<typeof wasteVehicleTicketsInputSchema>;

export const MAX_VEHICLES_PER_REQUEST = 50;
const vehiclesArraySchema = z.array(wasteRequestVehicleInputSchema).max(MAX_VEHICLES_PER_REQUEST);

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип контейнера из справочника, type='cont');
 *  - container_replace → containerTypeId (присутствующий на объекте);
 *  - container_removal → containerTypeId (присутствующий на объекте);
 *  - waste_removal     → containerTypeId (тип самосвала) + wasteTypeId + volumeM3.
 * Тип мусора, объём и цена есть только у вывоза самосвалами (ADR 0019). Кросс-полевые требования
 * проверяет superRefine; тариф и сумму считает сервер — кратность объёма известна только ему.
 */
export const createWasteRequestSchema = z
  .object({
    objectId: uuidSchema,
    requestType: requestTypeSchema,
    containerTypeId: uuidSchema.optional(),
    wasteTypeId: uuidSchema.optional(),
    volumeM3: volumeSchema.optional(),
    /** Кто вывозит: контрагент с типом «Оператор». Можно назначить позже (ADR 0010). */
    operatorCounterpartyId: uuidSchema.optional(),
    deliveryAt: z.coerce.date(),
    /**
     * Время доставки не задано: `deliveryAt` несёт только дату (00:00 МСК), а рабочее окно
     * не проверяется. Отдельного поля времени нет — дата и время в БД остаются одним timestamptz.
     */
    deliveryTimeUnspecified: z.boolean().optional().default(false),
    comment: z.string().trim().max(2000).optional().default(''),
    fileIds: z.array(uuidSchema).max(20).optional().default([]),
  })
  .superRefine((v, ctx) => {
    if (!v.deliveryTimeUnspecified && !isWithinWorkTimeAt(v.deliveryAt)) {
      ctx.addIssue({ code: 'custom', path: ['deliveryAt'], message: WORK_TIME_MESSAGE });
    }
    // Новую заявку заводят не раньше чем на завтра (по МСК); правка даты этим не связана.
    if (!isAllowedRequestDateAt(v.deliveryAt)) {
      ctx.addIssue({ code: 'custom', path: ['deliveryAt'], message: MIN_REQUEST_DATE_MESSAGE });
    }
    if (v.requestType === 'container_install' && !v.containerTypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['containerTypeId'],
        message: 'Выберите тип контейнера',
      });
    }
    if (v.requestType === 'container_replace' && !v.containerTypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['containerTypeId'],
        message: 'Выберите тип контейнера для замены',
      });
    }
    if (v.requestType === 'container_removal' && !v.containerTypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['containerTypeId'],
        message: 'Выберите тип контейнера для снятия',
      });
    }
    if (v.requestType === 'waste_removal' && !v.containerTypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['containerTypeId'],
        message: 'Выберите тип машины/контейнера',
      });
    }
    // Тарифицируемая операция (вывоз самосвалами): нужны и тип мусора, и объём — вдвоём с
    // прайсом они дают сумму заявки (ADR 0019). У контейнерных операций обоих полей нет.
    if (isPricedRequestType(v.requestType)) {
      if (!v.wasteTypeId) {
        ctx.addIssue({ code: 'custom', path: ['wasteTypeId'], message: 'Выберите тип мусора' });
      }
      if (v.volumeM3 == null) {
        ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём' });
      }
    }
  });
export type CreateWasteRequestInput = z.infer<typeof createWasteRequestSchema>;

// Признак «время не задано» передаётся вместе с `deliveryAt`: клиент шлёт оба поля разом,
// поэтому рабочее окно проверяется только когда время действительно задано.
export const updateWasteRequestSchema = z
  .object({
    objectId: uuidSchema.optional(),
    requestType: requestTypeSchema.optional(),
    containerTypeId: uuidSchema.nullable().optional(),
    wasteTypeId: uuidSchema.nullable().optional(),
    /** Значим только у вывоза самосвалами: у контейнерных операций объёма нет (ADR 0019). */
    volumeM3: volumeSchema.nullable().optional(),
    operatorCounterpartyId: uuidSchema.nullable().optional(),
    deliveryAt: z.coerce.date().optional(),
    deliveryTimeUnspecified: z.boolean().optional(),
    comment: z.string().trim().max(2000).optional(),
    addFileIds: z.array(uuidSchema).max(20).optional(),
    removeFileIds: z.array(uuidSchema).optional(),
    // Машины заявки (ADR 0011). Пометка на удаление доступна всем, кто правит заявку;
    // удалить запись насовсем может только администратор — сервер сверяет роль.
    addVehicles: vehiclesArraySchema.optional(),
    markDeletedVehicleIds: z.array(uuidSchema).optional(),
    restoreVehicleIds: z.array(uuidSchema).optional(),
    deleteVehicleIds: z.array(uuidSchema).optional(),
    version: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    if (v.deliveryAt && v.deliveryTimeUnspecified !== true && !isWithinWorkTimeAt(v.deliveryAt)) {
      ctx.addIssue({ code: 'custom', path: ['deliveryAt'], message: WORK_TIME_MESSAGE });
    }
  });
export type UpdateWasteRequestInput = z.infer<typeof updateWasteRequestSchema>;

/**
 * Назначение оператора вывоза — отдельная операция (ADR 0010): предмет заявки при ней не
 * пересчитывается. Через общий PATCH это было бы невозможно — он заново проверяет наличие
 * контейнера на объекте и подбирает тариф, а к смене исполнителя это отношения не имеет.
 */
export const assignWasteOperatorSchema = z.object({
  /** null — снять назначение (заявка снова «без оператора»). */
  operatorCounterpartyId: uuidSchema.nullable(),
  version: z.number().int().nonnegative(),
});
export type AssignWasteOperatorInput = z.infer<typeof assignWasteOperatorSchema>;

export interface WasteRequestVehicleDto {
  id: string;
  containerTypeId: string;
  containerTypeName: string;
  volumeM3: number;
  /**
   * Талоны рейса. С ADR 0020 закрытая заявка без талона у машины невозможна; пустой список
   * встречается у заявок, закрытых раньше, и у машин, заведённых до закрытия.
   */
  files: FileDto[];
  /** Помечена на удаление: в сверке объёма не участвует, в списке показывается неактивной. */
  isDeleted: boolean;
  createdAt: string;
}

/** Фактически вывезенный объём: сумма по машинам без помеченных на удаление. */
export function sumVehicleVolume(vehicles: readonly WasteRequestVehicleDto[]): number {
  const sum = vehicles.reduce((acc, v) => (v.isDeleted ? acc : acc + v.volumeM3), 0);
  return Math.round(sum * 1000) / 1000;
}

export interface VolumeCheck {
  /** Сумма по активным машинам. */
  actual: number;
  /** Объём из заявки; null — заявка объёма не несёт (контейнерные операции). */
  planned: number | null;
  /** Факт − план; null, если сравнивать не с чем. */
  diff: number | null;
  matches: boolean;
}

/**
 * Сверка «заявлено ↔ вывезено». Расхождение — не ошибка: заявка это план, машины — факт
 * (недогруз, лишний рейс). Результат показывается человеку и ничего не блокирует (ADR 0011).
 */
export function checkVehicleVolume(
  plannedVolumeM3: number | null,
  vehicles: readonly WasteRequestVehicleDto[],
): VolumeCheck {
  const actual = sumVehicleVolume(vehicles);
  if (plannedVolumeM3 == null) return { actual, planned: null, diff: null, matches: true };
  const diff = Math.round((actual - plannedVolumeM3) * 1000) / 1000;
  return { actual, planned: plannedVolumeM3, diff, matches: diff === 0 };
}

/** Активные машины, к которым талон ещё не приложен: закрывать заявку с ними нельзя (ADR 0020). */
export function vehiclesWithoutTickets(
  vehicles: readonly WasteRequestVehicleDto[],
): WasteRequestVehicleDto[] {
  return vehicles.filter((v) => !v.isDeleted && v.files.length === 0);
}

// Комментарий к смене статуса пишется в историю (request_status_history.comment).
// При отмене он обязателен и играет роль причины — см. statusChangeRequiresReason.
// Машины и талоны передаются вместе с закрытием заявки: «Выполнена» без предъявленного факта
// бессмысленна, а отдельным запросом его пришлось бы проводить не атомарно со сменой статуса
// (ADR 0011). Какой из двух способов предъявления в ходу, решает тип заявки:
// вывоз самосвалами — `vehicles` (+ `vehicleTickets` к уже заведённым машинам), контейнерные
// операции — `ticketFileIds` (ADR 0013). Талон обязателен в обоих случаях, но обязательность
// проверяет сервер: она считается по состоянию заявки, а не по одному лишь телу запроса —
// талоны могли быть приложены при прошлом закрытии (ADR 0020).
export const changeWasteRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    vehicles: vehiclesArraySchema.optional().default([]),
    /** Талоны заявок без машин: крепятся к самой заявке (request_files, kind='ticket'). */
    ticketFileIds: z.array(uuidSchema).max(MAX_TICKETS_PER_VEHICLE).optional().default([]),
    /** Догрузка талонов к машинам, заведённым раньше (повторное закрытие). */
    vehicleTickets: z
      .array(wasteVehicleTicketsInputSchema)
      .max(MAX_VEHICLES_PER_REQUEST)
      .optional()
      .default([]),
    version: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
    }
    if (v.status !== 'done' && v.vehicles.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicles'],
        message: 'Машины прикладываются только при закрытии заявки',
      });
    }
    if (v.status !== 'done' && v.ticketFileIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ticketFileIds'],
        message: 'Талоны прикладываются только при закрытии заявки',
      });
    }
    if (v.status !== 'done' && v.vehicleTickets.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleTickets'],
        message: 'Талоны прикладываются только при закрытии заявки',
      });
    }
    // Одна машина — одна запись: два блока талонов на неё разошлись бы с проверкой лимита.
    const ids = new Set(v.vehicleTickets.map((t) => t.vehicleId));
    if (ids.size !== v.vehicleTickets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleTickets'],
        message: 'Талоны одной машины передаются одним списком',
      });
    }
  });
export type ChangeWasteRequestStatusInput = z.infer<typeof changeWasteRequestStatusSchema>;

export interface WasteRequestDto {
  id: string;
  /** Сквозной человекочитаемый номер (отображается как «<num>-<буква типа>»). */
  num: number;
  objectId: string;
  objectCode: string;
  objectName: string;
  requestType: RequestType;
  // container_install / container_replace → тип контейнера; waste_removal → тип машины/контейнера
  containerTypeId: string | null;
  containerTypeName: string | null;
  // Тарифицируемые операции (замена / снятие / вывоз): что вывозим, сколько и почём.
  wasteTypeId: string | null;
  wasteTypeName: string | null;
  volumeM3: number | null;
  /** Снимок цены за м³ на момент сохранения заявки; прайс мог измениться позже. */
  pricePerM3: number | null;
  /** Сумма = объём × цена (считает БД). */
  amount: number | null;
  /** Оператор вывоза (контрагент): кто выполняет заявку. NULL — ещё не назначен (ADR 0010). */
  operatorCounterpartyId: string | null;
  operatorName: string | null;
  deliveryAt: string;
  /** Время доставки не задано — в `deliveryAt` значима только дата (00:00 МСК). */
  deliveryTimeUnspecified: boolean;
  comment: string;
  status: RequestStatus;
  /** Причина отмены из истории статусов; заполнена только у отменённых заявок. */
  cancelReason: string | null;
  /** Документы заявки: прикладываются при заведении и правятся свободно. Талонов здесь нет. */
  files: FileDto[];
  /**
   * Талоны, приложенные при закрытии заявки без машин (ADR 0013). У вывоза самосвалами список
   * пуст — там талоны висят на машинах и лежат в `vehicles[].files`.
   */
  tickets: FileDto[];
  /** Машины, вывезшие заявку, с талонами (ADR 0011); помеченные на удаление входят в список. */
  vehicles: WasteRequestVehicleDto[];
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── История заявки (ADR 0012) ──
// Сами события описаны в `request-history.ts` — их форма общая для всех модулей заявок.
// Здесь остаётся своё: как называются поля этого модуля в перечне изменений.

/** Подписи полей в истории; ключи проставляет сервер при вычислении изменений. */
export const wasteRequestChangeLabels: Record<string, string> = {
  object: 'Объект',
  requestType: 'Тип заявки',
  containerType: 'Контейнер / машина',
  wasteType: 'Тип мусора',
  volumeM3: 'Объём',
  pricePerM3: 'Цена за м³',
  amount: 'Стоимость',
  operator: 'Оператор вывоза',
  deliveryAt: 'Доставка',
  comment: 'Комментарий',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Откреплены файлы',
  vehiclesAdded: 'Добавлены машины',
  vehiclesMarkedDeleted: 'Машины помечены на удаление',
  vehiclesRestored: 'Машины возвращены',
  vehiclesRemoved: 'Машины удалены',
};
