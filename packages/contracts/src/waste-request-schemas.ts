import { z } from 'zod';
import {
  MIN_WASTE_VOLUME_M3,
  containerKindSchema,
  requestStatusSchema,
  requestTypeSchema,
  statusChangeRequiresReason,
} from './enums';
import {
  archiveFilterSchema,
  baseListQuery,
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  uuidSchema,
} from './common';
import {
  MIN_REQUEST_DATE_MESSAGE,
  WORK_TIME_MESSAGE,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
} from './time';
import {
  MAX_CONTAINERS_PER_REQUEST,
  MAX_ORDERED_VOLUME_M3,
  MAX_TICKETS_PER_REQUEST,
  WASTE_REQUEST_SORT_FIELDS,
  requesterSelectsWasteType,
  requiresOrderedVolume,
  usesContainerGroup,
  wasteTransitionRequiresFact,
} from './waste-requests';

/*
 * Request-validation schemas of the waste requests: the bodies and queries the API parses.
 *
 * They live apart from `waste-requests.ts` on purpose. The portal never calls them (it sends
 * typed payloads and the server validates), but a bundler cannot prove that a top-level `z.object`
 * chain is free of side effects, so every schema kept in a module the portal imports from ships to
 * the browser, used or not. This file is reached only through the pure barrel `index.ts`; the
 * portal imports none of its values, so its whole body drops out of the portal bundle. Predicates,
 * constants, labels and DTOs that both sides ask stay in `waste-requests.ts`: do not move them
 * here, and do not import this file from there (the portal would then carry it again).
 * The inferred input types are declared next to their schemas and are free in the bundle.
 */

export const wasteRequestListQuerySchema = baseListQuery(WASTE_REQUEST_SORT_FIELDS).extend({
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  /**
   * Весь вид разом — «все контейнеры» или «все самосвалы», — вместо одной позиции справочника.
   * Спрашивают именно так: «что везли самосвалами за неделю», а перечислять типы поимённо значит
   * промахнуться мимо заведённого вчера. Отдельным параметром, а не значением `containerTypeId`:
   * тот — идентификатор строки справочника, и подмешанное в него слово перестало бы им быть.
   *
   * Задаются оба — сужают вместе: тип уже принадлежит одному виду, и пара «контейнер X + все
   * самосвалы» даёт пустую выдачу честно, а не молчаливым игнорированием одного из них.
   */
  containerKind: containerKindSchema.optional(),
  requestType: requestTypeSchema.optional(),
  /** Заявки, назначенные конкретному оператору вывоза (ADR 0010). */
  operatorCounterpartyId: uuidSchema.optional(),
  // поиск по сквозному номеру заявки (точное совпадение)
  num: z.coerce.number().int().positive().optional(),
  deliveryFrom: z.coerce.date().optional(),
  deliveryTo: z.coerce.date().optional(),
  /** Архив (ADR 0070): `only` — вкладка «Архив», остальное сервер отдаёт только праву `archive.read`. */
  archive: archiveFilterSchema,
  /**
   * Реестр разбора талонов (ADR 0114, Р24): `pending` — «требуют разбора». Отбор шире, чем «есть
   * замечания»: корректно распознанный талон без единого расхождения иначе никогда не попал бы к
   * проверяющему и остался бы неподтверждённым навсегда — а неподтверждённый талон не занимает
   * номер и не входит в сверку.
   *
   * Без права `wasteRequests.ticketReview` параметр **отклоняется**, а не игнорируется: сам состав
   * выдачи отвечает на вопрос «есть ли по этой заявке замечания» не хуже самой сверки, а
   * молчаливое игнорирование вернуло бы полный список и читалось бы как «замечаний нет».
   */
  ticketReview: z.literal('pending').optional(),
});

/**
 * Журнал закрытых заявок вывоза (ADR 0135) — те же фильтры, что и у списка, кроме двух. Реестра
 * разбора здесь нет: разбирать в завершённой заявке нечего. Архива тоже нет: удалённые заявки
 * живут своей вкладкой (ADR 0070), и журнал их не показывает — он про состоявшееся, а не про
 * снесённое. `status` сужает журнал до одного из двух закрытых; остальные сервер отклоняет.
 */
export const wasteRequestHistoryQuerySchema = baseListQuery(WASTE_REQUEST_SORT_FIELDS).extend({
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  requestType: requestTypeSchema.optional(),
  operatorCounterpartyId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
  deliveryFrom: z.coerce.date().optional(),
  deliveryTo: z.coerce.date().optional(),
});

export type WasteRequestHistoryQuery = z.infer<typeof wasteRequestHistoryQuerySchema>;

/**
 * Сводка по статусам для виджета над списком. Из фильтров таблицы учитывается только объект:
 * фильтр по статусу свёл бы сводку к самой себе, а по номеру — к одной заявке.
 */
export const wasteRequestSummaryQuerySchema = z.object({
  objectId: uuidSchema.optional(),
});

export type WasteRequestSummaryQuery = z.infer<typeof wasteRequestSummaryQuerySchema>;

const volumeSchema = z.coerce
  .number()
  .int()
  .min(MIN_WASTE_VOLUME_M3)
  .max(MAX_ORDERED_VOLUME_M3, 'Слишком большой объём');

/**
 * What the person confirmed when deleting (snow-removal plan, §3.2). The server compares it with
 * the locked row and answers 409 on drift before any write: a confirmation to archive must not
 * become a hard delete because the request was rolled back to «Новая» in between. Required for a
 * snow request; optional for the older types so that tabs built before it keep working, and
 * checked whenever it is sent.
 */
export const deleteWasteRequestQuerySchema = z
  .object({
    version: z.coerce.number().int().nonnegative().optional(),
    mode: z.enum(['hard', 'soft']).optional(),
  })
  .strict();

export type DeleteWasteRequestQuery = z.infer<typeof deleteWasteRequestQuerySchema>;

/** Purge confirmation: the archived version the person saw. Required for snow, as above. */
export const purgeWasteRequestQuerySchema = z
  .object({ version: z.coerce.number().int().nonnegative().optional() })
  .strict();

export type PurgeWasteRequestQuery = z.infer<typeof purgeWasteRequestQuerySchema>;

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
 * Фактически вывезенный вес металлолома, т — то, что стоит в приёмо-сдаточном акте (ADR 0067).
 * Дробный той же точностью, что и объём (numeric(12,3) в БД): лом взвешивают, а весы дают
 * килограммы.
 */
export const factWeightSchema = z.coerce
  .number()
  .positive('Укажите фактический вес')
  .max(999_999.999, 'Слишком большой вес')
  .multipleOf(0.001, 'Не более 3 знаков после запятой');

/**
 * Стоимость закрытия, ₽ (numeric(14,2)). Ноль допустим: вывоз бывает и в счёт другой работы, а
 * запретить нулевую сумму значило бы требовать выдумать цифру.
 */
export const MAX_FACT_COST = 999_999_999;

/** Decimal text of a cost: digits, an optional dot and at most two fraction digits. */
const COST_TEXT = /^\d+(?:\.\d{1,2})?$/;

/**
 * Parses a cost exactly or returns the refusal text. Numbers are checked as numbers; strings are
 * checked as decimal TEXT before any conversion: `z.coerce` turned `""`, `true` and `[]` into 0 or 1
 * and `"1e-400"` into a false zero, all of which then saved as a known amount (snow-removal plan, §2).
 */
function parseFactCost(v: unknown): number | string {
  let n: number;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'Укажите сумму числом';
    n = v;
  } else if (typeof v === 'string') {
    const text = v.trim();
    if (!COST_TEXT.test(text)) {
      return /^\d+\.\d{3,}$/.test(text)
        ? 'Не более 2 знаков после запятой'
        : 'Укажите сумму числом';
    }
    const [whole] = text.split('.');
    if (whole!.replace(/^0+(?=\d)/, '').length > String(MAX_FACT_COST).length) {
      return 'Слишком большая сумма';
    }
    n = Number(text);
  } else {
    return 'Укажите сумму числом';
  }
  if (n < 0) return 'Стоимость не может быть отрицательной';
  if (n > MAX_FACT_COST) return 'Слишком большая сумма';
  // Kopecks: the number must round-trip through two fraction digits. A tolerance of a millionth of
  // a kopeck absorbs binary representation (0.1 + 0.2), not real third digits.
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'Не более 2 знаков после запятой';
  return Math.round(n * 100) / 100;
}

export const factCostSchema = z.unknown().transform((v, ctx): number => {
  const parsed = parseFactCost(v);
  if (typeof parsed === 'string') {
    ctx.addIssue({ code: 'custom', message: parsed });
    return z.NEVER;
  }
  return parsed;
});

/**
 * Заявку закрывают фактом: сколько вывезли и во сколько это обошлось (ADR 0035). Состав техники
 * при этом не спрашивается — вывоз тарифицируется самосвалами (ADR 0022), и какими машинами
 * увезли объём, к расчёту отношения не имеет.
 *
 * Величина одна на закрытие, и какая именно — решает тип заявки (`wasteFactUnit`): мусор меряют
 * объёмом, металлолом — весом (ADR 0067). Оба поля порознь необязательны, потому что схема типа
 * заявки не знает; что прислано ровно одно — проверяется здесь, а что прислано именно то —
 * сервером, у которого заявка перед глазами.
 *
 * Сумма приходит от клиента — он её и показывал человеку перед нажатием, — но подставляется
 * расчётом по прайсу: счёт оператора включает и подачу, и недогруз, и сходиться сумма должна со
 * счётом, а не с формулой. Не прислана — сервер посчитает сам; цены в прайсе нет — закрытие
 * проходит и без суммы: мусор вывезен, талон на руках, а прайс правят отдельно. У металлолома
 * суммы нет вовсе: прайс задан в ₽/м³ по паре «тип мусора × техника», а у лома нет ни того, ни
 * другого — считать нечем, и выдуманное число здесь хуже пустого места.
 */
export const completeWasteRequestSchema = z
  .object({
    volumeM3: factVolumeSchema.optional(),
    weightTons: factWeightSchema.optional(),
    totalCost: factCostSchema.nullable().optional(),
    /**
     * День фактического вывоза (ADR 0114, Р19). До распознавания талонов его в модели не было
     * вовсе: `delivery_at` — это план подачи, а `completed_at` — момент, когда бухгалтер нажал
     * «Выполнена», и он законно отстаёт на дни, потому что бумаги привозят пачкой в конце недели.
     * Сверять дату талона было не с чем.
     *
     * Вводит его человек, и **распознанным он не предзаполняется**: цифра, скопированная из
     * талона, сверялась бы сама с собой. Необязателен ради старых закрытий и заявок, где день
     * вывоза никто не помнит: пусто означает «неизвестно», а не «сегодня».
     */
    removedOn: dateOnlySchema.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.volumeM3 == null && v.weightTons == null) {
      ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите вывезенное' });
    }
    if (v.volumeM3 != null && v.weightTons != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['weightTons'],
        message: 'Вывезенное предъявляется одной величиной — объёмом либо весом',
      });
    }
    if (v.weightTons != null && v.totalCost !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCost'],
        message: 'У вывоза металлолома стоимость не считается',
      });
    }
  });

export type CompleteWasteRequestInput = z.infer<typeof completeWasteRequestSchema>;

export const containersCountSchema = z.coerce
  .number()
  .int()
  .min(1, 'Не меньше одного контейнера')
  .max(MAX_CONTAINERS_PER_REQUEST, `Не больше ${MAX_CONTAINERS_PER_REQUEST} контейнеров за раз`);

export const presentContainerGroupsQuerySchema = z.object({ objectId: uuidSchema });

export type PresentContainerGroupsQuery = z.infer<typeof presentContainerGroupsQuerySchema>;

/**
 * Причина вывоза чужого контейнера. Присутствие причины и есть подтверждение: отдельный флаг
 * «я подтверждаю» рядом с ней означал бы, что подтвердить можно молча — а молча оно и так
 * происходило до этой правки.
 *
 * Хранить причину колонкой заявки не нужно: это не свойство заявки, а факт «человек согласился и
 * объяснил», и место таких фактов — история (ADR 0012).
 */
export const ownerMismatchReasonSchema = z
  .string()
  .trim()
  .min(1, 'Укажите причину')
  .max(500, 'Слишком длинная причина');

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип контейнера из справочника, type='cont');
 *  - container_replace → containerTypeId + владелец + количество (группа присутствия);
 *  - container_removal → containerTypeId + владелец + количество (группа присутствия);
 *  - waste_removal     → wasteTypeId + volumeM3, техника не указывается (ADR 0022);
 *  - snow_removal      → volumeM3 only: the server sets the service waste type «Снег», and there
 *                        is no price list, tariff or estimate (snow-removal plan, S2, S6);
 *  - metal_removal     → ничего сверх общего: ни предмета, ни объёма, ни цены (ADR 0067).
 * Тип мусора, объём и цена есть только у вывоза мусора (ADR 0019). Кросс-полевые требования
 * проверяет superRefine; тариф и сумму считает сервер — кратность объёма известна только ему.
 */
export const createWasteRequestStableSchema = z
  .object({
    objectId: uuidSchema,
    requestType: requestTypeSchema,
    containerTypeId: uuidSchema.optional(),
    /** Чей контейнер снимаем/меняем: владелец выбранной группы присутствия. */
    containerOwnerCounterpartyId: uuidSchema.optional(),
    /** Сколько контейнеров снимает/меняет заявка; у остальных типов всегда один. */
    containersCount: containersCountSchema.optional().default(1),
    /** Подтверждение вывоза чужого контейнера — причиной (см. ownerMismatchReasonSchema). */
    ownerMismatchReason: ownerMismatchReasonSchema.optional(),
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
    /**
     * Кто на площадке принимает машину и по какому телефону. Обязателен: оператор приезжает к
     * человеку, а не к адресу — без контакта место установки и подъезд выясняются на месте.
     */
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    /** Комментарий площадки; строку исполнителя он пишет сам, своей ручкой (ADR 0053). */
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
    // Количество и владелец бывают только у операций над стоящим контейнером. Молча отбросить
    // их (как отбрасывается техника у вывоза) здесь нельзя: это числа, которые вводил человек.
    if (!usesContainerGroup(v.requestType)) {
      if (v.containersCount > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['containersCount'],
          message: 'Несколько контейнеров бывает только у замены и снятия',
        });
      }
      if (v.containerOwnerCounterpartyId) {
        ctx.addIssue({
          code: 'custom',
          path: ['containerOwnerCounterpartyId'],
          message: 'Владелец контейнера указывается при замене и снятии',
        });
      }
    }
    // Garbage and snow are ordered by volume, not by machines (ADR 0022): the operator decides
    // how to remove it and presents the removed volume at completion (ADR 0035). Only garbage asks
    // the requester for a waste type; snow gets the service type from the server, and a waste type
    // sent with it is discarded there rather than refused (snow-removal plan, S2).
    if (requesterSelectsWasteType(v.requestType) && !v.wasteTypeId) {
      ctx.addIssue({ code: 'custom', path: ['wasteTypeId'], message: 'Выберите тип мусора' });
    }
    if (requiresOrderedVolume(v.requestType) && v.volumeM3 == null) {
      ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём' });
    }
  });

/** A receipt replay keeps its original date after Moscow midnight; only a new command uses today's gate. */
export const createWasteRequestSchema = createWasteRequestStableSchema.superRefine((v, ctx) => {
  if (!isAllowedRequestDateAt(v.deliveryAt)) {
    ctx.addIssue({ code: 'custom', path: ['deliveryAt'], message: MIN_REQUEST_DATE_MESSAGE });
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
    // Владелец и количество: значимы только у замены и снятия — при смене типа заявки сервер
    // приводит их к «один контейнер, владельца нет» тем же порядком, что тип мусора и объём.
    containerOwnerCounterpartyId: uuidSchema.nullable().optional(),
    containersCount: containersCountSchema.optional(),
    ownerMismatchReason: ownerMismatchReasonSchema.optional(),
    wasteTypeId: uuidSchema.nullable().optional(),
    /** Значим только у вывоза мусора: у контейнерных операций объёма нет (ADR 0019). */
    volumeM3: volumeSchema.nullable().optional(),
    operatorCounterpartyId: uuidSchema.nullable().optional(),
    deliveryAt: z.coerce.date().optional(),
    deliveryTimeUnspecified: z.boolean().optional(),
    // Не переданный контакт — «не трогали»; непустоту итогового значения проверяет backend.
    responsibleName: contactNameSchema.optional(),
    responsiblePhone: contactPhoneSchema.optional(),
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
 * Примечание исполнителя (ADR 0053) — отдельная операция, как и назначение оператора: общий
 * PATCH исполнителю недоступен вовсе (заявку он не редактирует, ADR 0038), а вдобавок
 * пересчитывает предмет заявки и подбирает тариф, к примечанию отношения не имеющие.
 *
 * Предел тот же, что у комментария площадки: строки равноправны, и разная длина у них означала бы,
 * что одной стороне есть что сказать, а другой — вдвое меньше.
 */
export const updateWasteOperatorCommentSchema = z
  .object({
    operatorComment: z.string().trim().max(2000),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateWasteOperatorCommentInput = z.infer<typeof updateWasteOperatorCommentSchema>;

/**
 * Назначение оператора вывоза — отдельная операция (ADR 0010): предмет заявки при ней не
 * пересчитывается. Через общий PATCH это было бы невозможно — он заново проверяет наличие
 * контейнера на объекте и подбирает тариф, а к смене исполнителя это отношения не имеет.
 */
export const assignWasteOperatorSchema = z.object({
  /** null — снять назначение (заявка снова «без оператора»). */
  operatorCounterpartyId: uuidSchema.nullable(),
  /**
   * Причина вывоза чужого контейнера. Назначение — тот самый момент, когда расхождение и
   * возникает: заявку заводит площадка, а исполнителя ей выбирает диспетчер.
   */
  ownerMismatchReason: ownerMismatchReasonSchema.optional(),
  version: z.number().int().nonnegative(),
});

export type AssignWasteOperatorInput = z.infer<typeof assignWasteOperatorSchema>;

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

/**
 * Добавочные талоны к уже выполненной заявке (ADR 0189) — своей операцией, отдельно от закрытия.
 *
 * Закрытие предъявляет бумагу разом, но бумага разом и не приходит: заявку везут несколькими
 * ходками, талон второй машины подписывают на площадке позже, весовую квитанцию привозят к вечеру.
 * До этого решения донести их было нечем — единственная дверь к `kind = 'ticket'` открывалась
 * переходом в «Выполнена», — и исполнителю оставалось просить откат заявки, который стирает и
 * факт, и уже приложенные талоны (ADR 0020, ADR 0035).
 *
 * Статуса в теле нет намеренно: операция не двигает заявку по циклу, она дополняет её бумагу.
 * Факта нет по той же причине — сколько вывезли, сказано закрытием, и добавочный талон этого
 * ответа не меняет; разойдутся цифры — расхождение посчитает сверка и покажет тому, кто
 * разбирает (ADR 0114). Пустой список отклоняется схемой: «приложить ноль талонов» — не событие,
 * а лишняя запись в истории заявки.
 */
export const addWasteTicketsSchema = z
  .object({
    ticketFileIds: z
      .array(uuidSchema)
      .min(1, 'Приложите талон')
      .max(MAX_TICKETS_PER_REQUEST, `Не более ${MAX_TICKETS_PER_REQUEST} талонов`),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type AddWasteTicketsInput = z.infer<typeof addWasteTicketsSchema>;
