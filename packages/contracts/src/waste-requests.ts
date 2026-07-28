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
import { WORK_TIME_MESSAGE, isWithinWorkTimeAt } from './time';
import { isPricedRequestType } from './waste-tariffs';

export const WASTE_REQUEST_SORT_FIELDS = [
  'objectName',
  'containerTypeName',
  'requestType',
  'deliveryAt',
  'status',
  'operatorName',
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

/**
 * Машина, вывезшая часть заявки: тип техники из справочника и талоны. Объём не вводится —
 * он равен вместимости выбранного типа («Самосвал 25 м³» → 25 м³): машина уезжает гружёной
 * целиком, а разнобой в ручном вводе давал бы расхождение там, где его нет. В строке машины
 * объём сохраняется снимком (тип потом могут переименовать или пересчитать).
 * Талоны необязательны: загрузка файлов ещё не работает, а факт вывоза фиксировать нужно сейчас.
 */
export const wasteRequestVehicleInputSchema = z.object({
  containerTypeId: uuidSchema,
  fileIds: z.array(uuidSchema).max(20).optional().default([]),
});
export type WasteRequestVehicleInput = z.infer<typeof wasteRequestVehicleInputSchema>;

export const MAX_VEHICLES_PER_REQUEST = 50;
const vehiclesArraySchema = z.array(wasteRequestVehicleInputSchema).max(MAX_VEHICLES_PER_REQUEST);

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип контейнера из справочника, type='cont');
 *  - container_replace → containerTypeId (присутствующий на объекте) + wasteTypeId + volumeM3;
 *  - container_removal → containerTypeId (присутствующий на объекте) + wasteTypeId + volumeM3;
 *  - waste_removal     → containerTypeId (тип машины или контейнера) + wasteTypeId + volumeM3.
 * Кросс-полевые требования проверяет superRefine; тариф и сумму считает сервер (ADR 0009) —
 * кратность объёма зависит от подобранного тарифа и здесь проверена быть не может.
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
    // Тарифицируемые операции: мусор реально вывозится, значит нужны его тип и объём (ADR 0009).
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
  /** Талоны рейса; пустой список — талон ещё не приложен. */
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
  /** Объём из заявки; null — заявка объёма не несёт (установка контейнера). */
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

// Комментарий к смене статуса пишется в историю (request_status_history.comment).
// При отмене он обязателен и играет роль причины — см. statusChangeRequiresReason.
// Машины передаются вместе с закрытием заявки: «Выполнена» без единой машины бессмысленна,
// а отдельным запросом её пришлось бы проводить не атомарно со сменой статуса (ADR 0011).
export const changeWasteRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    vehicles: vehiclesArraySchema.optional().default([]),
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
  files: FileDto[];
  /** Машины, вывезшие заявку, с талонами (ADR 0011); помеченные на удаление входят в список. */
  vehicles: WasteRequestVehicleDto[];
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── История заявки ──
// Что с заявкой происходило: кто и когда её завёл, правил, менял статус. Собирается из двух
// источников — истории статусов (request_status_history) и аудита (audit_log); третьей таблицы
// не заводим, обе уже пишутся.

/**
 * Изменение одного поля при правке. Значения — готовый текст на момент правки, а не ссылки:
 * переименование справочника не должно переписывать прошлое. `from === null` — событие-список
 * («прикреплены файлы»), у него значима только правая часть.
 */
export interface WasteRequestChangeDto {
  field: string;
  from: string | null;
  to: string | null;
}

export type WasteRequestHistoryKind =
  'created' | 'updated' | 'status' | 'operator' | 'deleted' | 'restored';

export interface WasteRequestHistoryEntryDto {
  id: string;
  kind: WasteRequestHistoryKind;
  /** Момент события (ISO). */
  at: string;
  /** Автор события; null — учётная запись удалена или действие выполнено системой. */
  actorId: string | null;
  actorName: string | null;
  /** Смена статуса: откуда и куда. У остальных событий — null. */
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  /** Комментарий к переходу; при отмене — причина. */
  comment: string;
  /** Изменённые поля у правок; у остальных событий список пуст. */
  changes: WasteRequestChangeDto[];
}

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
