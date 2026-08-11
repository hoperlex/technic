import { z } from 'zod';
import {
  MIN_WASTE_VOLUME_M3,
  requestStatusSchema,
  requestTypeSchema,
  requestTypeShort,
  statusChangeRequiresReason,
} from './enums';
import type { ContainerKind, RequestStatus, RequestType } from './enums';
import {
  archiveFilterSchema,
  baseListQuery,
  contactNameSchema,
  contactPhoneSchema,
  uuidSchema,
} from './common';
import type { FileDto } from './files';
import {
  MIN_REQUEST_DATE_MESSAGE,
  WORK_TIME_MESSAGE,
  isAllowedRequestDateAt,
  isWithinWorkTimeAt,
} from './time';
import { calcWasteAmount, isPricedRequestType } from './waste-tariffs';

/** Префикс номера заявки на мусор — как «ТС-» у заявок на технику (миграция 0064). */
const WASTE_REQUEST_NUM_PREFIX = 'М';

/**
 * Отображаемый номер заявки: «М-128» (в БД хранится только число).
 *
 * `legacyNumFormat` — заявка заведена до префикса и показывается прежним номером «128-ВМ»:
 * число плюс буква типа. Перерисовать его задним числом нельзя, он уже в талонах и переписке.
 */
export function formatWasteRequestNumber(
  num: number,
  requestType: RequestType,
  legacyNumFormat: boolean,
): string {
  return legacyNumFormat
    ? `${num}-${requestTypeShort[requestType]}`
    : `${WASTE_REQUEST_NUM_PREFIX}-${num}`;
}

/**
 * Разбор пользовательского ввода поиска: «128» / «М-128» / «128-ВМ» → 128. Ищут по числу: оно
 * уникально в обоих форматах, а префикс и буква типа — только отображение.
 */
export function parseWasteRequestNumberSearch(input: string): number | undefined {
  const digits = input.match(/\d+/)?.[0];
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

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
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили. Порядок по нему там умолчанием —
  // архив открывают вопросом «что снесли последним».
  'deletedAt',
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
  /** Архив (ADR 0070): `only` — вкладка «Архив», остальное сервер отдаёт только праву `archive.read`. */
  archive: archiveFilterSchema,
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
 * В чём меряется вывезенное. Единица — свойство типа заявки, а не поле формы: мусор возят
 * объёмом (ADR 0035), металлолом сдают по весу (ADR 0067), и одной колонкой их не описать —
 * «3,2» без единицы не отвечает, кубометры это или тонны.
 */
export type WasteFactUnit = 'volume_m3' | 'weight_tons';

/** Подпись единицы факта — для полей формы, карточки заявки и истории. */
export const wasteFactUnitLabels: Record<WasteFactUnit, string> = {
  volume_m3: 'м³',
  weight_tons: 'т',
};

/**
 * Чем предъявляется закрытие заявки:
 *  - `volume_m3` — вывоз мусора: объём заказан заявкой, а сколько увезли, видно лишь по закрытию;
 *  - `weight_tons` — вывоз металлолома: заявка объёма не несёт вовсе, лом принимают по весу;
 *  - `null` — контейнерные операции: они считаются по самим контейнерам и закрываются талоном.
 */
export function wasteFactUnit(t: RequestType): WasteFactUnit | null {
  if (t === 'waste_removal') return 'volume_m3';
  if (t === 'metal_removal') return 'weight_tons';
  return null;
}

/**
 * Требует ли тип заявки предъявленного факта. Производная от `wasteFactUnit`: вопрос «нужен ли
 * факт» задают чаще, чем «в чём он», и раздваивать правило между двумя предикатами нельзя.
 */
export function requiresWasteFact(t: RequestType): boolean {
  return wasteFactUnit(t) !== null;
}

/**
 * Тип контейнера — предмет только контейнерных операций. У вывоза мусора техника не указывается
 * (ADR 0022), у вывоза металлолома нет и её (ADR 0067): заявка говорит «приезжайте забрать», а
 * чем забирать, решает исполнитель.
 */
export function usesContainerType(t: RequestType): boolean {
  return t === 'container_install' || t === 'container_replace' || t === 'container_removal';
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

/** Один текст на отказ сервера и на проверку формы — единица факта задана типом заявки. */
export const FACT_UNIT_MISMATCH_MESSAGE =
  'Закрытие предъявляет не ту величину, которой меряется этот тип заявки';

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

/**
 * Переход, требующий факта: «Выполнена» отвечает на «сколько вывезли и сколько стоило».
 * Отмена факта не требует — по отменённой заявке никто не выезжал.
 */
export function wasteTransitionRequiresFact(to: RequestStatus): boolean {
  return to === 'done';
}

/**
 * Вывезенное: величина вместе со своей единицей, одним неразделимым значением.
 *
 * Размеченное объединение, а не пара необязательных чисел, — и это не стилистика. Пара
 * `volumeM3: number | null` + `weightTons: number | null` разъезжается молча: `null` легален и в
 * шаблонной строке, и в JSX, поэтому `Вывезено {c.volumeM3} м³` в заявке на металлолом
 * компилируется и печатает «Вывезено null м³». Объединение такую строку не пропускает: поля
 * `volumeM3` у ветки веса нет вовсе, и добраться до числа можно, только назвав единицу.
 *
 * Единицу несёт сам факт, а не тип заявки рядом: печатают факт в четырёх местах (карточка, список,
 * окно отката, история), и в трёх из них типа заявки под рукой нет.
 */
export type WasteFactAmount =
  { unit: 'volume_m3'; volumeM3: number } | { unit: 'weight_tons'; weightTons: number };

/**
 * Факт выполнения заявки (ADR 0035): вывезенное, цена-основание и итог. Цена — снимок прайса на
 * момент закрытия, а не текущий тариф: сумма обязана объясняться сама, а прайс могли переписать.
 *
 * Вывезенное приходит `WasteFactAmount`-ом — величиной со своей единицей. Общего поля «сколько» с
 * единицей в соседней колонке нет намеренно: объём умножается на цену прайса, а вес — ни на что,
 * и единое поле предлагало бы считать тонны по ₽/м³.
 */
export type WasteRequestCompletionDto = WasteFactAmount & {
  /** Цена за м³ на момент закрытия; `null` — в прайсе её не было либо заявка не тарифицируется. */
  pricePerM3: number | null;
  /** Итоговая стоимость; `null` — считать было нечем и руками не ввели. */
  totalCost: number | null;
  completedBy: string;
  completedByName: string;
  completedAt: string;
};

/**
 * Вывезенное строкой с единицей: «48 м³», «3,2 т». Собирается здесь, а не в вёрстке: единица не
 * должна потеряться ни в одном месте показа.
 *
 * `switch` с проверкой на `never` вместо цепочки `if`: третья единица (примут лом по штукам,
 * грунт по тоннам) обязана сломать сборку здесь, а не тихо напечатать прочерк.
 */
export function wasteFactLabel(c: WasteFactAmount): string {
  switch (c.unit) {
    case 'volume_m3':
      return `${c.volumeM3} ${wasteFactUnitLabels.volume_m3}`;
    case 'weight_tons':
      return `${c.weightTons} ${wasteFactUnitLabels.weight_tons}`;
    default: {
      const unhandled: never = c;
      return unhandled;
    }
  }
}

/**
 * Объём закрытия — только у закрытия, меряемого объёмом. Отдельной ручкой, потому что объём здесь
 * нужен для счёта (сверка с заявленным, расчёт по прайсу), а не для показа: показ идёт через
 * `wasteFactLabel`, и подставлять единицу вызывающему нечего.
 */
export function factVolumeOf(c: WasteFactAmount | null | undefined): number | null {
  return c?.unit === 'volume_m3' ? c.volumeM3 : null;
}

/** Вес закрытия — только у закрытия, меряемого весом (ADR 0067). Тем же порядком, что и объём. */
export function factWeightOf(c: WasteFactAmount | null | undefined): number | null {
  return c?.unit === 'weight_tons' ? c.weightTons : null;
}

// ── Контейнеры на объекте: владелец и количество (миграция 0080) ──

/**
 * Операции над контейнером, который уже стоит на площадке. У них, и только у них, есть владелец
 * (чей контейнер трогаем) и количество: установка привозит свой контейнер, а вывоз мусора
 * контейнеров не касается вовсе (ADR 0022).
 */
export function usesContainerGroup(t: RequestType): boolean {
  return t === 'container_replace' || t === 'container_removal';
}

/** Потолок количества — защита от опечатки: сколько снять можно, ограничено присутствием. */
export const MAX_CONTAINERS_PER_REQUEST = 20;

export const containersCountSchema = z.coerce
  .number()
  .int()
  .min(1, 'Не меньше одного контейнера')
  .max(MAX_CONTAINERS_PER_REQUEST, `Не больше ${MAX_CONTAINERS_PER_REQUEST} контейнеров за раз`);

/**
 * Группа присутствия: что и чьё стоит на объекте, сколько штук. Единицы внутри группы
 * взаимозаменяемы — какую именно из двух одинаковых бочек одного оператора увезут, вопрос не
 * учёта, а водителя.
 */
export interface PresentContainerGroupDto {
  objectId: string;
  containerTypeId: string;
  containerTypeName: string;
  /** Оператор, установивший контейнеры; null — установку завели без оператора. */
  ownerCounterpartyId: string | null;
  ownerName: string | null;
  quantity: number;
}

export const presentContainerGroupsQuerySchema = z.object({ objectId: uuidSchema });
export type PresentContainerGroupsQuery = z.infer<typeof presentContainerGroupsQuerySchema>;

/**
 * Подпись группы: «Контейнер 8 м³ — Оператор А (2 шт.)». Показывается в четырёх местах — выбор
 * контейнера в форме, подсказка под полем оператора, окно назначения при переводе в работу и
 * вкладка «На объекте», — поэтому собирается здесь, а не в вёрстке каждого из них.
 */
export function presentGroupLabel(
  g: Pick<PresentContainerGroupDto, 'containerTypeName' | 'ownerName' | 'quantity'>,
): string {
  return `${g.containerTypeName} — ${g.ownerName ?? 'оператор не указан'} (${g.quantity} шт.)`;
}

/**
 * Вывозит ли заявку не тот, кто контейнер привёз. Считается, а не хранится: это отношение двух
 * колонок, и хранимый признак разошёлся бы с ними при первой же смене оператора.
 *
 * Молчит в двух случаях, и оба — «данных нет», а не «всё в порядке»: оператор ещё не назначен
 * (заявку завела площадка) и владелец не известен (установку завели без оператора).
 */
export function containerOwnerMismatch(
  r: Pick<
    WasteRequestDto,
    'requestType' | 'operatorCounterpartyId' | 'containerOwnerCounterpartyId'
  >,
): boolean {
  if (!usesContainerGroup(r.requestType)) return false;
  if (!r.operatorCounterpartyId || !r.containerOwnerCounterpartyId) return false;
  return r.operatorCounterpartyId !== r.containerOwnerCounterpartyId;
}

/**
 * Чем кончается расхождение «вывозит не тот, кто привёз»:
 *  - `ok` — расхождения нет либо о нём нечего сказать (оператор или владелец не известны);
 *  - `reasonRequired` — снятие чужого контейнера: пройдёт, если объяснить причину;
 *  - `reasonGiven` — то же снятие с объяснённой причиной: проходит и попадает в историю;
 *  - `splitRequired` — замена чужого контейнера: не проходит вовсе.
 *
 * У замены обхода нет намеренно. Заменить чужой контейнер — значит увезти контейнер одного
 * оператора и оставить контейнер другого, то есть сменить владельца единицы на площадке. Одной
 * заявкой это описать нечем: либо учёт соврёт (единица останется числиться за прежним), либо в
 * присутствие придётся заводить перенос владельца — третий механизм ради редкого случая. Две
 * заявки — снятие чужого и установка своего — описывают ровно то, что произошло.
 *
 * Политика одна на сервер и на форму: сервер ею отказывает, форма — предупреждает заранее, и
 * расходиться им нельзя.
 */
export type ContainerOwnerVerdict = 'ok' | 'reasonRequired' | 'reasonGiven' | 'splitRequired';

export function checkContainerOwner(
  r: Pick<
    WasteRequestDto,
    'requestType' | 'operatorCounterpartyId' | 'containerOwnerCounterpartyId'
  >,
  reasonGiven = false,
): ContainerOwnerVerdict {
  if (!containerOwnerMismatch(r)) return 'ok';
  if (r.requestType === 'container_replace') return 'splitRequired';
  return reasonGiven ? 'reasonGiven' : 'reasonRequired';
}

/** Один текст на отказ сервера и на объяснение в форме — см. `checkContainerOwner`. */
export const FOREIGN_CONTAINER_SPLIT_MESSAGE =
  'Замена чужого контейнера оформляется двумя заявками: снятие чужого и установка своего';

/**
 * Предмет заявки строкой — для колонки списка и мобильной карточки. Объём есть там, где он
 * определяет сумму (ADR 0019); количество показывается только когда контейнер не один: «× 1»
 * читателю ничего не сообщает. Техники у вывоза нет вовсе (ADR 0022) — у заявок, заведённых до
 * этого решения, тип в базе остался, но предметом заявки уже не является. У вывоза металлолома
 * предмета нет и подавно (ADR 0067): строка выходит пустой, и это правда — заявка говорит
 * «приезжайте забрать», а сколько увезли, отвечает уже закрытие.
 */
export function wasteSubjectLabel(
  r: Pick<WasteRequestDto, 'requestType' | 'containerTypeName' | 'containersCount' | 'volumeM3'>,
): string {
  const container = usesContainerType(r.requestType) ? r.containerTypeName : null;
  const parts = [
    container && r.containersCount > 1 ? `${container} × ${r.containersCount}` : container,
    r.volumeM3 != null ? `${r.volumeM3} м³` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

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
 *  - metal_removal     → ничего сверх общего: ни предмета, ни объёма, ни цены (ADR 0067).
 * Тип мусора, объём и цена есть только у вывоза мусора (ADR 0019). Кросс-полевые требования
 * проверяет superRefine; тариф и сумму считает сервер — кратность объёма известна только ему.
 */
export const createWasteRequestSchema = z
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
  /** Сквозной человекочитаемый номер: по нему ищут и сортируют. Показывают `displayNumber`. */
  num: number;
  /** Номер как его показывают: «М-128», а у заявок до префикса — «128-ВМ» (миграция 0064). */
  displayNumber: string;
  objectId: string;
  objectCode: string;
  objectName: string;
  /**
   * Адрес площадки; пустая строка — адрес у объекта не заполнен (колонка справочника
   * необязательная). Показывают второй строкой к наименованию — «куда ехать» спрашивают у
   * списка заявок чаще всего, а своей колонки адрес не стоит.
   */
  objectAddress: string;
  requestType: RequestType;
  // Только контейнерные операции: тип контейнера. У вывоза мусора техника не указывается
  // (ADR 0022) — поле остаётся заполненным лишь у заявок, заведённых до этого решения.
  containerTypeId: string | null;
  containerTypeName: string | null;
  /**
   * Сколько контейнеров снимает или меняет заявка (миграция 0080). У остальных типов всегда 1:
   * установка привозит один контейнер, вывоза мусора контейнеры не касаются.
   */
  containersCount: number;
  /**
   * Чей контейнер снимаем/меняем: оператор его заявки установки. null — владелец не известен
   * (установку завели без оператора либо заявка старше миграции 0080), и тогда правило
   * совпадения молчит: запрет там, где нет данных, — не запрет ошибки.
   */
  containerOwnerCounterpartyId: string | null;
  containerOwnerName: string | null;
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
  /** Кто принимает машину на площадке; пусто — заявка заведена до миграции 0062. */
  responsibleName: string;
  responsiblePhone: string;
  /** Комментарий площадки — стороны заказчика; пишется формой заявки. */
  comment: string;
  /**
   * Комментарий исполнителя (ADR 0053): что о заявке сказал оператор. Пишется своей ручкой —
   * заявку исполнитель не редактирует. Показывается второй строкой там же, где комментарий
   * площадки: обе стороны собирает `wasteRequestCommentLines`.
   */
  operatorComment: string;
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
  /**
   * Кто отправил заявку в архив (ADR 0070). Пусто у живой заявки и у архивной, чей автор удаления
   * не сохранился (`deleted_by` объявлен `ON DELETE SET NULL` — учётку могли снести насовсем).
   * Именем, а не только идентификатором: «кто удалил» — первый вопрос к строке архива, и ответ на
   * него не должен требовать второго запроса.
   */
  deletedByName: string | null;
}

// ── Комментарий заявки: две стороны (ADR 0053) ──

/** Строка комментария с подписью стороны. */
export interface WasteCommentLine {
  key: 'site' | 'operator';
  /** Подпись строки: «Площадка» либо название контрагента-исполнителя. */
  label: string;
  text: string;
}

/**
 * Комментарий заявки двумя подписанными строками (ADR 0053). Пустая сторона строкой не
 * показывается: «Площадка: —» — шум, а не сведения.
 *
 * Подпись площадки — слово, а не название объекта: объект виден и в своей колонке списка, и в
 * шапке карточки. Подпись исполнителя — наоборот, название контрагента: в списке оператора
 * колонки «Оператор» нет вовсе (ADR 0010), а площадке, у которой операторов несколько, слово
 * «Оператор» ничего не сообщает. Назначение сняли, а текст остался — подписываем словом: имя
 * контрагента, которого у заявки уже нет, было бы неправдой.
 *
 * Собирается здесь, а не в верстке экрана: мест показа три (таблица, карточка на телефоне,
 * карточка заявки), и разойтись подписи не должны.
 */
export function wasteRequestCommentLines(
  r: Pick<WasteRequestDto, 'comment' | 'operatorComment' | 'operatorName'>,
): WasteCommentLine[] {
  const lines: WasteCommentLine[] = [];
  if (r.comment) lines.push({ key: 'site', label: 'Площадка', text: r.comment });
  if (r.operatorComment) {
    lines.push({ key: 'operator', label: r.operatorName || 'Оператор', text: r.operatorComment });
  }
  return lines;
}

/**
 * Пишется ли ещё примечание исполнителя. У закрытой заявки — нет: «Выполнена» и «Отменена»
 * терминальны, заявка стала документом, и дописывать в неё нечего. Понадобилась правка —
 * администратор откатывает статус, тем же порядком, что и с фактом вывоза (ADR 0035).
 */
export function wasteOperatorCommentEditable(status: RequestStatus): boolean {
  return status !== 'done' && status !== 'cancelled';
}

// ── История заявки (ADR 0012) ──
// Сами события описаны в `request-history.ts` — их форма общая для всех модулей заявок.
// Здесь остаётся своё: как называются поля этого модуля в перечне изменений.

/** Подписи полей в истории; ключи проставляет сервер при вычислении изменений. */
export const wasteRequestChangeLabels: Record<string, string> = {
  object: 'Объект',
  requestType: 'Тип заявки',
  containerType: 'Контейнер / машина',
  // Контейнеры на объекте (миграция 0080): чей контейнер трогаем и сколько штук.
  containerOwner: 'Владелец контейнера',
  containersCount: 'Количество контейнеров',
  // Подтверждённый вывоз чужого контейнера: событие-список — значима только правая часть.
  ownerMismatch: 'Вывоз чужого контейнера',
  wasteType: 'Тип мусора',
  volumeM3: 'Объём',
  pricePerM3: 'Цена за м³',
  amount: 'Стоимость',
  operator: 'Оператор вывоза',
  deliveryAt: 'Доставка',
  // Контакт ответственного на площадке (миграция 0062).
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  // Комментарий разведён по сторонам (ADR 0053): в истории они названы порознь — иначе «изменён
  // комментарий» не отвечает, чей.
  comment: 'Комментарий площадки',
  operatorComment: 'Комментарий оператора',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Откреплены файлы',
  // Факт выполнения (ADR 0035): своё событие истории — «выполнена» и «вывезено столько-то на
  // такую-то сумму» отвечают на разные вопросы. Вес назван отдельной строкой, а не общим
  // «Вывезено»: у металлолома это другая величина (ADR 0067), и одна подпись на обе означала бы,
  // что «48» и «3,2» в истории про одно и то же.
  factVolume: 'Вывезено',
  factWeight: 'Сдано металлолома',
  factPrice: 'Цена по факту',
  factCost: 'Стоимость по факту',
  // Состав техники прошлых закрытий: события больше не появляются, но в истории остаются.
  vehiclesAdded: 'Добавлены машины',
  vehiclesMarkedDeleted: 'Машины помечены на удаление',
  vehiclesRestored: 'Машины возвращены',
  vehiclesRemoved: 'Машины удалены',
};
