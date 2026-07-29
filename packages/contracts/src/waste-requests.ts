import { z } from 'zod';
import {
  MIN_WASTE_VOLUME_M3,
  requestStatusSchema,
  requestTypeSchema,
  statusChangeRequiresReason,
} from './enums';
import type { ContainerKind, RequestStatus, RequestType } from './enums';
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

// ── Машины и талоны (ADR 0011, ADR 0024) ──

/**
 * Машины предъявляются только при вывозе мусора: там объём заказан заявкой, а чем его увезли —
 * видно лишь по факту. Контейнерные операции (установка, замена, снятие) считаются по самим
 * контейнерам: машина там одна и в состав факта не входит.
 */
export function requiresWasteVehicles(t: RequestType): boolean {
  return t === 'waste_removal';
}

/**
 * Талоны на одно закрытие: их несколько (талон с двух сторон, весовая квитанция рядом), но
 * список общий на заявку — к отдельной машине талон больше не крепится (ADR 0024).
 */
export const MAX_TICKETS_PER_REQUEST = 20;

/**
 * Строка факта вывоза: тип техники из справочника и сколько таких машин вывезло заявку
 * (ADR 0024). Раньше строка была одним рейсом, и каждая требовала своего талона — на деле
 * оператор отчитывается «два самосвала 25 м³ и контейнер 8 м³», а бумаги отдаёт пачкой.
 * Объём не вводится: он равен вместимости типа × количество («Самосвал 25 м³» × 2 → 50 м³) —
 * машина уезжает гружёной целиком, а ручной ввод давал бы разнобой там, где цифра однозначна.
 * Вместимость и цена сохраняются снимком: тип потом могут пересчитать, а прайс — переписать.
 */
export const MAX_VEHICLE_COUNT_PER_ROW = 99;

export const wasteRequestVehicleInputSchema = z.object({
  containerTypeId: uuidSchema,
  count: z.coerce.number().int().min(1).max(MAX_VEHICLE_COUNT_PER_ROW).optional().default(1),
});
export type WasteRequestVehicleInput = z.infer<typeof wasteRequestVehicleInputSchema>;

/** Строк «тип × количество» на заявку; сами машины считаются количеством внутри строки. */
export const MAX_VEHICLE_ROWS_PER_REQUEST = 50;
const vehiclesArraySchema = z
  .array(wasteRequestVehicleInputSchema)
  .max(MAX_VEHICLE_ROWS_PER_REQUEST);

/**
 * Правка количества у заведённой машины. Нужна при повторном закрытии (после отката) и при
 * правке заявки: тип в заявке встречается один раз, поэтому «ещё один такой же самосвал» —
 * это +1 к количеству существующей строки, а не вторая строка того же типа.
 */
export const wasteVehicleCountInputSchema = z.object({
  vehicleId: uuidSchema,
  count: z.coerce.number().int().min(1).max(MAX_VEHICLE_COUNT_PER_ROW),
});
export type WasteVehicleCountInput = z.infer<typeof wasteVehicleCountInputSchema>;
const vehicleCountsArraySchema = z
  .array(wasteVehicleCountInputSchema)
  .max(MAX_VEHICLE_ROWS_PER_REQUEST);

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип контейнера из справочника, type='cont');
 *  - container_replace → containerTypeId (присутствующий на объекте);
 *  - container_removal → containerTypeId (присутствующий на объекте);
 *  - waste_removal     → wasteTypeId + volumeM3, техника не указывается (ADR 0022).
 * Тип мусора, объём и цена есть только у вывоза (ADR 0019). Кросс-полевые требования
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
    // Новую заявку заводят не раньше чем на сегодня (по МСК); правка даты этим не связана.
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
    // Вывоз мусора заказывается объёмом, а не техникой (ADR 0022): чем вывозить, решает
    // оператор, и предъявляет он это машинами при закрытии заявки (ADR 0011).
    // Тарифицируемая операция (вывоз): нужны и тип мусора, и объём — вдвоём с
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
    /** Значим только у вывоза мусора: у контейнерных операций объёма нет (ADR 0019). */
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
    /** Правка количества у заведённых строк (ADR 0024). */
    vehicleCounts: vehicleCountsArraySchema.optional(),
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
  /** Вид техники: вывоз оформляется и самосвалами, и контейнерами (ADR 0024). */
  containerKind: ContainerKind;
  /** Вместимость одной машины, м³ — снимок справочника на момент заведения строки. */
  volumeM3: number;
  /** Сколько таких машин вывезло заявку. */
  count: number;
  /**
   * Цена за м³ по прайсу на момент заведения строки — снимок, как и у самой заявки.
   * null — у строк, заведённых до ADR 0024: тарифа им тогда не подбирали.
   */
  pricePerM3: number | null;
  /** Сумма строки = вместимость × количество × цена (считает БД); null — цены нет. */
  amount: number | null;
  /** Помечена на удаление: в сверке объёма не участвует, в списке показывается неактивной. */
  isDeleted: boolean;
  createdAt: string;
}

/** Объём строки: вместимость одной машины × количество. */
export function vehicleVolume(v: Pick<WasteRequestVehicleDto, 'volumeM3' | 'count'>): number {
  return Math.round(v.volumeM3 * v.count * 1000) / 1000;
}

/** Фактически вывезенный объём: сумма по машинам без помеченных на удаление. */
export function sumVehicleVolume(vehicles: readonly WasteRequestVehicleDto[]): number {
  const sum = vehicles.reduce((acc, v) => (v.isDeleted ? acc : acc + vehicleVolume(v)), 0);
  return Math.round(sum * 1000) / 1000;
}

/**
 * Стоимость по факту вывоза: сумма строк без помеченных на удаление (ADR 0024). Ею и считается
 * сумма закрытой заявки — заявленный объём был планом, а платят за то, что увезли.
 * null — если хоть у одной активной строки нет снимка цены: неполная сумма выглядела бы как
 * полная, а расходятся они молча.
 */
export function sumVehicleAmount(vehicles: readonly WasteRequestVehicleDto[]): number | null {
  const active = vehicles.filter((v) => !v.isDeleted);
  if (active.length === 0) return null;
  if (active.some((v) => v.amount == null)) return null;
  const sum = active.reduce((acc, v) => acc + v.amount!, 0);
  return Math.round(sum * 100) / 100;
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

// Комментарий к смене статуса пишется в историю (request_status_history.comment).
// При отмене он обязателен и играет роль причины — см. statusChangeRequiresReason.
// Машины и талоны передаются вместе с закрытием заявки: «Выполнена» без предъявленного факта
// бессмысленна, а отдельным запросом его пришлось бы проводить не атомарно со сменой статуса
// (ADR 0011). Талоны идут одним списком заявки у любого типа (ADR 0024): к машине бумага
// больше не привязывается — оператор отдаёт её пачкой за всё закрытие, а какая из них про
// какой рейс, из самого талона всё равно не следует. Обязательность талона проверяет сервер:
// она считается по состоянию заявки, а не по телу запроса — талоны могли быть приложены при
// прошлом закрытии (ADR 0020). Машины принимает только вывоз мусора — это тоже решает сервер.
export const changeWasteRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    vehicles: vehiclesArraySchema.optional().default([]),
    /** Правка количества у машин, заведённых прошлым закрытием (ADR 0024). */
    vehicleCounts: vehicleCountsArraySchema.optional().default([]),
    /** Талоны закрытия — общий пул заявки (request_files, kind='ticket'). */
    ticketFileIds: z.array(uuidSchema).max(MAX_TICKETS_PER_REQUEST).optional().default([]),
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
    if (v.status !== 'done' && v.vehicleCounts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleCounts'],
        message: 'Машины прикладываются только при закрытии заявки',
      });
    }
    // Один тип — одна строка: две строки на тот же тип разошлись бы с расчётом по прайсу
    // («×2» и «×1» вместо «×3») и превратили бы факт в перечень рейсов, от которого уходим.
    const typeIds = new Set(v.vehicles.map((r) => r.containerTypeId));
    if (typeIds.size !== v.vehicles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicles'],
        message: 'Машины одного типа указываются одной строкой с количеством',
      });
    }
    // То же и у правок количества: два значения на одну строку разошлись бы молча.
    const countedIds = new Set(v.vehicleCounts.map((c) => c.vehicleId));
    if (countedIds.size !== v.vehicleCounts.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleCounts'],
        message: 'Количество машины передаётся один раз',
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
  // Только контейнерные операции: тип контейнера. У вывоза мусора техника не указывается
  // (ADR 0022) — поле остаётся заполненным лишь у заявок, заведённых до этого решения.
  containerTypeId: string | null;
  containerTypeName: string | null;
  // Тарифицируемые операции (замена / снятие / вывоз): что вывозим, сколько и почём.
  wasteTypeId: string | null;
  wasteTypeName: string | null;
  volumeM3: number | null;
  /** Снимок цены за м³ на момент сохранения заявки; прайс мог измениться позже. */
  pricePerM3: number | null;
  /** Плановая сумма = заявленный объём × цена (считает БД). */
  amount: number | null;
  /**
   * Фактический объём по машинам, м³ — сумма строк без помеченных на удаление (ADR 0024).
   * null — машин у заявки нет (не закрыта или закрыта контейнерной операцией).
   */
  factVolumeM3: number | null;
  /**
   * Сумма по факту: считается по снимкам цен в строках машин и после закрытия заменяет
   * плановую в списке и карточке — заявленный объём был планом, платят за вывезенное.
   * null — машин нет либо у какой-то строки нет снимка цены (записи до ADR 0024).
   */
  factAmount: number | null;
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
   * Талоны, приложенные при закрытии заявки (ADR 0013). Общий пул на заявку у любого типа:
   * с ADR 0024 бумага не делится по машинам.
   */
  tickets: FileDto[];
  /**
   * Чем вывезли: строки «тип × количество» (ADR 0024); помеченные на удаление входят в список.
   * Есть только у вывоза мусора.
   */
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
