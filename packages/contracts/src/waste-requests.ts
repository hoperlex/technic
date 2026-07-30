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
import { calcWasteAmount, isPricedRequestType } from './waste-tariffs';

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

// ── Факт вывоза и талоны (ADR 0035, ADR 0013) ──

/**
 * Факт предъявляется только при вывозе мусора: там объём заказан заявкой, а сколько увезли —
 * видно лишь по закрытию. Контейнерные операции (установка, замена, снятие) считаются по самим
 * контейнерам: объёма у них нет, и закрываются они одним талоном.
 */
export function requiresWasteFact(t: RequestType): boolean {
  return t === 'waste_removal';
}

/**
 * Талоны на одно закрытие: их несколько (талон с двух сторон, весовая квитанция рядом), но
 * список общий на заявку — к отдельной машине талон больше не крепится (ADR 0024).
 */
export const MAX_TICKETS_PER_REQUEST = 20;

/**
 * Фактически вывезенный объём, м³ — то, что стоит в талоне и весовой квитанции. Дробный: объём
 * взвешивают, а не считают по вместимости кузова (numeric(12,3) в БД).
 */
export const factVolumeSchema = z.coerce
  .number()
  .positive('Укажите фактический объём')
  .max(999_999.999, 'Слишком большой объём')
  .multipleOf(0.001, 'Не более 3 знаков после запятой');

/**
 * Стоимость закрытия, ₽ (numeric(14,2)). Ноль допустим: вывоз бывает и в счёт другой работы, а
 * запретить нулевую сумму значило бы требовать выдумать цифру.
 */
export const factCostSchema = z.coerce
  .number()
  .min(0, 'Стоимость не может быть отрицательной')
  .max(999_999_999, 'Слишком большая сумма')
  .multipleOf(0.01, 'Не более 2 знаков после запятой');

/**
 * Расчёт стоимости по факту: объём × цена прайса. `null` — цены нет, и считать нечем: тогда
 * сумму вводят руками, а закрытие всё равно проходит (ADR 0035).
 */
export function calcWasteFactCost(volumeM3: number, pricePerM3: number | null): number | null {
  return pricePerM3 == null ? null : calcWasteAmount(volumeM3, pricePerM3);
}

/**
 * Заявку закрывают фактом: сколько вывезли и во сколько это обошлось (ADR 0035). Состав техники
 * при этом не спрашивается — вывоз тарифицируется самосвалами (ADR 0022), и какими машинами
 * увезли объём, к расчёту отношения не имеет.
 *
 * Сумма приходит от клиента — он её и показывал человеку перед нажатием, — но подставляется
 * расчётом по прайсу: счёт оператора включает и подачу, и недогруз, и сходиться сумма должна со
 * счётом, а не с формулой. Не прислана — сервер посчитает сам; цены в прайсе нет — закрытие
 * проходит и без суммы: мусор вывезен, талон на руках, а прайс правят отдельно.
 */
export const completeWasteRequestSchema = z
  .object({
    volumeM3: factVolumeSchema,
    totalCost: factCostSchema.nullable().optional(),
  })
  .strict();
export type CompleteWasteRequestInput = z.infer<typeof completeWasteRequestSchema>;

/**
 * Переход, требующий факта: «Выполнена» отвечает на «сколько вывезли и сколько стоило».
 * Отмена факта не требует — по отменённой заявке никто не выезжал.
 */
export function wasteTransitionRequiresFact(to: RequestStatus): boolean {
  return to === 'done';
}

/**
 * Факт выполнения заявки (ADR 0035): объём, цена-основание и итог. Цена — снимок прайса на
 * момент закрытия, а не текущий тариф: сумма обязана объясняться сама, а прайс могли переписать.
 */
export interface WasteRequestCompletionDto {
  /** Фактически вывезено, м³. */
  volumeM3: number;
  /** Цена за м³ на момент закрытия; `null` — в прайсе её не было, сумму вводили руками. */
  pricePerM3: number | null;
  /** Итоговая стоимость; `null` — считать было нечем и руками не ввели. */
  totalCost: number | null;
  completedBy: string;
  completedByName: string;
  completedAt: string;
}

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
    // оператор, а при закрытии предъявляет фактический объём (ADR 0035).
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
    // Факта выполнения здесь нет: он предъявляется закрытием заявки и правится повторным
    // закрытием (ADR 0035) — тем же порядком, что у заявок ТС (ADR 0029).
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

/**
 * Строка состава техники прошлых закрытий (миграции 0029, 0042). Только чтение: с ADR 0035
 * закрытие предъявляет объём и стоимость, а не перечень машин, и новых строк не появляется —
 * заведённые остаются в истории заявки, по ним её принимали.
 */
export interface WasteRequestVehicleDto {
  id: string;
  containerTypeId: string;
  containerTypeName: string;
  /** Вид техники: вывоз оформлялся и самосвалами, и контейнерами (ADR 0024). */
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
  /** Сумма строки = вместимость × количество × цена (считала БД); null — цены нет. */
  amount: number | null;
  /** Была помечена на удаление: в факт вывоза такая строка не входила. */
  isDeleted: boolean;
  createdAt: string;
}

/** Объём строки: вместимость одной машины × количество. */
export function vehicleVolume(v: Pick<WasteRequestVehicleDto, 'volumeM3' | 'count'>): number {
  return Math.round(v.volumeM3 * v.count * 1000) / 1000;
}

/** Объём по составу техники: сумма строк без помеченных на удаление. */
export function sumVehicleVolume(vehicles: readonly WasteRequestVehicleDto[]): number {
  const sum = vehicles.reduce((acc, v) => (v.isDeleted ? acc : acc + vehicleVolume(v)), 0);
  return Math.round(sum * 1000) / 1000;
}

// Комментарий к смене статуса пишется в историю (request_status_history.comment).
// При отмене он обязателен и играет роль причины — см. statusChangeRequiresReason.
// Факт и талоны передаются вместе с закрытием заявки: «Выполнена» без предъявленного факта
// бессмысленна, а отдельным запросом его пришлось бы проводить не атомарно со сменой статуса
// (ADR 0035). Талоны идут одним списком заявки у любого типа (ADR 0024): оператор отдаёт их
// пачкой за всё закрытие. Обязательность талона проверяет сервер: она считается по состоянию
// заявки, а не по телу запроса — талоны могли быть приложены при прошлом закрытии (ADR 0020).
// Обязательность самого факта — тоже за сервером: её решает тип заявки, а при повторном
// закрытии (после отката) хватает уже предъявленного.
export const changeWasteRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: z.string().trim().max(2000).optional().default(''),
    /** Факт выполнения (ADR 0035): фактический объём и стоимость. */
    completion: completeWasteRequestSchema.optional(),
    /** Талоны закрытия — общий пул заявки (request_files, kind='ticket'). */
    ticketFileIds: z.array(uuidSchema).max(MAX_TICKETS_PER_REQUEST).optional().default([]),
    version: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
    }
    if (v.completion && !wasteTransitionRequiresFact(v.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion'],
        message: 'Фактический объём указывают при выполнении заявки',
      });
    }
    if (v.status !== 'done' && v.ticketFileIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ticketFileIds'],
        message: 'Талоны прикладываются только при закрытии заявки',
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
   * Факт выполнения (ADR 0035): сколько вывезли и во сколько это обошлось. После закрытия его
   * сумма и есть то, что заявка стоила: `amount` выше — план по заявленному объёму.
   * null — заявка не закрыта либо закрыта контейнерной операцией (у неё факта нет).
   */
  completion: WasteRequestCompletionDto | null;
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
   * Состав техники прошлых закрытий: строки «тип × количество» (ADR 0024). Только у заявок,
   * закрытых до ADR 0035 — новых строк не появляется, а прежние остаются в истории заявки.
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
  // Факт выполнения (ADR 0035): своё событие истории — «выполнена» и «вывезено столько-то на
  // такую-то сумму» отвечают на разные вопросы.
  factVolume: 'Вывезено',
  factPrice: 'Цена по факту',
  factCost: 'Стоимость по факту',
  // Состав техники прошлых закрытий: события больше не появляются, но в истории остаются.
  vehiclesAdded: 'Добавлены машины',
  vehiclesMarkedDeleted: 'Машины помечены на удаление',
  vehiclesRestored: 'Машины возвращены',
  vehiclesRemoved: 'Машины удалены',
};
