import { z } from 'zod';
import {
  mechRateUnitSchema,
  requestStatusSchema,
  statusChangeRequiresReason,
  type MechRateUnit,
  type RequestStatus,
} from './enums';
import {
  archiveFilterSchema,
  baseListQuery,
  booleanFlagSchema,
  contactNameSchema,
  contactPhoneSchema,
  dateOnlySchema,
  uuidSchema,
} from './common';
import {
  costTargetKey,
  parseCostTargetKey,
  type CostTarget,
  type CostTargetKey,
  type CostTargetRef,
  type CostTargetSource,
} from './cost-target';
import type { CounterpartyType } from './counterparties';
import type { FileDto } from './files';
import { dateKeySpan, moscowDateKeyOf } from './time';
import { isClosedRequestStatus, workedAmountLabel } from './vehicle-requests';

/**
 * Аренда малой механизации (план `docs/mechanization-module-plan.md`): виброплиты, компрессоры,
 * генераторы, тепловые пушки — всё, что стоит на площадке неделями и стоит денег каждый день.
 *
 * **Заявка и есть аренда** (Р1): одна строка описывает просьбу, договорённость, саму аренду и её
 * итог. Отдельной записи состояния нет, потому что одна заявка порождает ровно одну аренду и
 * пережить её не может.
 *
 * Отсюда главная особенность модуля, о которой спотыкается всякий, кто читает его цикл: статусы
 * названы заказчиком, четвёртого выдумывать нельзя, и «договорились» с «техника стоит на объекте»
 * разведены **полями**, а не статусом (Р2). Всё, что ниже написано про состояния, — про предикаты
 * над `status`, `actualFrom` и `actualTo`, а не про новые значения `request_status`.
 */

// ── Номер (Р4) ──

/**
 * Префикс номера заявки на механизацию. Заняты «М-» (вывоз), «ТС-» (техника), «НЗ» (недельная),
 * «СО-» (оргтехника), «ЗК-» (закупка) — отсюда две буквы.
 */
const MECH_REQUEST_NUM_PREFIX = 'МХ';

/** Отображаемый номер заявки: «МХ-42» (в БД хранится только число). */
export function formatMechRequestNumber(num: number): string {
  return `${MECH_REQUEST_NUM_PREFIX}-${num}`;
}

/**
 * Разбор пользовательского ввода поиска: «42» / «МХ-42» / «мх42» → 42. Ищут по числу — префикс
 * только отображение, и требовать его от того, кто копирует номер из переписки, значило бы
 * возвращать пустой список на верно набранный номер.
 */
export function parseMechRequestNumberSearch(input: string): number | undefined {
  const digits = input.match(/\d+/)?.[0];
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ── Вид техники свободной строкой (Р5) ──

/**
 * Вид техники — свободная строка: справочник видов отложен решением заказчика, а не отменён.
 * Длина как у наименований справочников — 255 знаков: «Виброплита реверсивная 90 кг» помещается,
 * абзац описания работ — нет, и это правильно, вид не описание.
 */
export const mechKindNameSchema = z
  .string()
  .trim()
  .min(2, 'Укажите вид техники')
  .max(255, 'Слишком длинное наименование');

/**
 * Нормализованный ключ вида — **та же формула, что у генерируемой колонки `kind_key`**:
 * `lower(btrim(regexp_replace(kind_name,'\s+',' ','g')))`. Повторена здесь потому, что по ключу
 * портал схлопывает подсказку и сравнивает введённое с уже существующим; разойдись формулы — и
 * подсказка предлагала бы «Виброплита» как новую позицию рядом с той же самой из базы.
 *
 * Ключ схлопывает **регистр и повторные пробелы**, и только их: «Виброплита» и «Вибро плита»
 * останутся разными позициями. Разделять слова — работа справочника, а справочника пока нет.
 */
export function mechKindKey(kindName: string): string {
  return kindName.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Подсказка ранее вводившихся видов (`GET /mech-requests/kinds`). Строится **по той же области**,
 * что и список заявок, и без сквозных счётчиков: иначе площадка читала бы по подсказке, что
 * арендуют соседние объекты. Порядок — частота внутри собственной области, поэтому ответ приходит
 * списком строк, а не набором с числами.
 */
export const mechKindsQuerySchema = z.object({
  /** Ввод человека: подсказка сужается по вхождению, сравнение — по нормализованному ключу. */
  search: z.string().trim().max(255).optional(),
});
export type MechKindsQuery = z.infer<typeof mechKindsQuerySchema>;

// ── Состояния аренды (Р2) ──

/**
 * Три поля, которыми различаются состояния аренды. Отдельный узкий тип, а не `MechRequestDto`:
 * предикаты спрашивают ровно их, и просить у вызывающего всю заявку значило бы, что строка сводки
 * или частичная выборка сервера предикатом воспользоваться не может.
 */
export interface MechRentalState {
  status: RequestStatus;
  /** День фактической выдачи; пусто — техника ещё не подана. */
  actualFrom: string | null;
  /** День фактического возврата; пусто — техника ещё у нас. */
  actualTo: string | null;
}

/**
 * **Аренда идёт** — выданное и не возвращённое. Все три условия сразу, и это не педантизм.
 *
 * Откат «Выполнена» → «В работе» факт бережёт, то есть `actual_to` остаётся заполненным. Спроси
 * присутствие по одному `actual_from IS NOT NULL` — и возвращённая техника снова показалась бы
 * действующей арендой: попала бы во вкладку «В аренде», в сводку, в расчёт просрочки, и её можно
 * было бы продлить.
 *
 * Тот же предикат стоит в пяти местах — вкладка, сводка, просрочка, частичный индекс базы и право
 * на продление, — и написан он здесь один раз именно поэтому.
 */
export function isMechRentalRunning(row: MechRentalState): boolean {
  return row.status === 'confirmed' && row.actualFrom !== null && row.actualTo === null;
}

/**
 * **Ждёт подачи** — договорились, техники на объекте ещё нет. Заявку в этом состоянии ещё можно
 * отменить: за неё никто ничего не выставит.
 *
 * Тег с этим смыслом и число таких заявок в сводке — единственная мера против забытой отметки
 * выдачи (риск 4 плана): отметка ручная, и без видимости вкладка «В аренде» врала бы в меньшую
 * сторону, показывая пустоту там, где техника уже работает.
 */
export function isMechAwaitingIssue(row: MechRentalState): boolean {
  return row.status === 'confirmed' && row.actualFrom === null;
}

/**
 * **Коррекция завершения** — «В работе» с заполненным возвратом, то есть строка после отката
 * «Выполнена» → «В работе». Арендой она уже не является (техника возвращена), но требует действия
 * человека: её нужно завершить заново.
 *
 * Своё состояние, а не «частный случай аренды», потому что отвечает иначе на три вопроса сразу: во
 * вкладке «В аренде» не показывается, продлевать в ней нечего, а `purge` её не трогает — удалить
 * насовсем строку с фактом аренды нельзя (Р15).
 */
export function isMechCompletionCorrection(row: MechRentalState): boolean {
  return row.status === 'confirmed' && row.actualTo !== null;
}

/**
 * Тег состояния для строки списка: `null` — состояние читается по самому статусу, и второй ярлык
 * рядом с ним был бы шумом.
 *
 * Собирается здесь, а не в вёрстке: тегов два, показываются они в трёх местах (таблица, карточка
 * на телефоне, окно заявки), и разойтись подписи не должны.
 */
export function mechStateTag(row: MechRentalState): 'awaitingIssue' | 'correction' | null {
  if (isMechAwaitingIssue(row)) return 'awaitingIssue';
  if (isMechCompletionCorrection(row)) return 'correction';
  return null;
}

export const mechStateTagLabels: Record<'awaitingIssue' | 'correction', string> = {
  awaitingIssue: 'ждёт подачи',
  correction: 'коррекция завершения',
};

// ── Просрочка и остаток срока (Р12) ──

/**
 * Сколько дней осталось до планового возврата: 0 — возвращать сегодня, отрицательное — просрочено
 * на столько дней. Считается календарём (`dateKeySpan`), а не вычитанием моментов: срок аренды —
 * это сутки, а не часы, и переход через месяц с високосным февралём готовая функция знает сама.
 *
 * «Сегодня» приходит **параметром**, а не берётся здесь из часов: день у портала и у сервера один
 * и тот же — московский (`moscowDateKeyOf`), — но вычислен он должен быть один раз на запрос,
 * иначе список, отрисованный в 00:00, показал бы часть строк по вчерашнему дню.
 */
export function mechDaysLeft(plannedTo: string, today: string): number {
  return plannedTo >= today
    ? dateKeySpan(today, plannedTo) - 1
    : -(dateKeySpan(plannedTo, today) - 1);
}

/**
 * Просрочен ли возврат: плановая дата позади, а техника не возвращена (Р12).
 *
 * Хранимого признака нет намеренно — его пришлось бы кому-то переводить, и он разошёлся бы с датой
 * в первую же ночь. Бизнес-сутки — `Europe/Moscow`: сервер живёт в UTC, а человек нет, и с 00:00
 * до 03:00 МСК эти два календаря показывают разные дни.
 *
 * Сравнение строк, а не дат: ключ `YYYY-MM-DD` сравнивается лексикографически ровно так же, как
 * хронологически, и пересчёт в моменты времени вернул бы часовой пояс туда, откуда его убрали.
 */
export function isMechOverdue(
  row: MechRentalState & { plannedTo: string },
  today = moscowDateKeyOf(new Date()),
): boolean {
  return isMechRentalRunning(row) && row.plannedTo < today;
}

/**
 * Календарный день человеку: `2026-09-04` → «04.09.2026». Не `moscowDateOf` — тот берёт момент
 * времени и пересчитывает пояс, а здесь день уже календарный, и второй пересчёт сдвинул бы его.
 */
function formatDay(dateKey: string): string {
  const [yyyy, mm, dd] = dateKey.split('-');
  return dd && mm && yyyy ? `${dd}.${mm}.${yyyy}` : dateKey;
}

/** Фактические даты не бывают в будущем (Р2): выдача и возврат — записи о случившемся. */
export const MECH_FUTURE_DATE_MESSAGE = 'Фактическая дата не может быть в будущем';

/**
 * Проверка «не позже сегодняшнего дня по МСК» — одна на форму и на сервер.
 *
 * В базе этого правила нет и не будет, и причина точная: `CURRENT_DATE` считает день по часовому
 * поясу сессии, а сессии приложения живут в UTC. Запись «выдана сегодня», сделанная в 00:30 МСК,
 * CHECK отверг бы как будущую — в Москве уже новый день, а по UTC ещё вчерашний. Значит это
 * правило момента записи, и считать день обязан тот, кто знает бизнес-зону.
 */
export function isAllowedMechFactDate(dateKey: string, now = new Date()): boolean {
  return dateKey <= moscowDateKeyOf(now);
}

// ── Заявитель и площадка (Р17, Р20) ──

/**
 * Заявитель заявки на механизацию: отдел, если он заполнен, иначе площадка.
 *
 * Свой вывод, а не `costTargetOf` из «Заказа ТС», и это не дублирование (Р20). Там колонки
 * взаимоисключающие (`num_nonnulls(object_id, department_id) = 1`), и `costTargetOf` проверяет
 * объект **первым**; здесь объект заполнен всегда — это место эксплуатации, — и тот же порядок
 * назвал бы заявку отдела заявкой площадки, то есть отнёс бы расходы не на того.
 *
 * `null` — заказчика не видно ни одного: строка собрана запросом без обеих половин. Значение, а не
 * исключение, по той же причине, что у соседа: ронять список заявок из-за подписи одной строки
 * нельзя.
 */
export function mechRequesterOf(source: CostTargetSource): CostTarget | null {
  if (source.departmentId) {
    return {
      kind: 'department',
      id: source.departmentId,
      // Код в справочнике `NOT NULL`; пустая строка здесь означает «колонку не выбрали запросом» и
      // видна на экране как пропуск — в отличие от выдуманного значения.
      code: source.departmentCode ?? '',
      name: source.departmentName ?? '',
    };
  }
  if (source.objectId) {
    return {
      kind: 'object',
      id: source.objectId,
      code: source.objectCode ?? '',
      name: source.objectName ?? '',
    };
  }
  return null;
}

/** Ключ заявителя `object:<id>` / `department:<id>` — тот же формат, что у подбора «Объект/отдел». */
export function mechRequesterKeyOf(source: CostTargetSource): CostTargetKey | null {
  const requester = mechRequesterOf(source);
  return requester ? costTargetKey(requester) : null;
}

/**
 * Параметр фильтра «Заявитель» — ключ вместо пары `{ objectId, departmentId }` (Р20).
 *
 * Пара здесь не годится: `objectId` уже занят фильтром «Площадка», и на одной площадке живут и
 * заявка самой площадки, и заявка отдела. Один параметр не может быть одновременно фильтром места
 * и половиной фильтра заявителя, поэтому фильтров два и они независимы: площадка возвращает обе
 * заявки, заявитель — по одной.
 */
export const mechRequesterFilterSchema = z
  .string()
  .refine(
    (value) => parseCostTargetKey(value) !== null,
    'Заявитель задаётся ключом «род:идентификатор»',
  );

/** Разбор ключа фильтра обратно — общий с подбором заказчика, второго формата у портала нет. */
export function parseMechRequesterFilter(value: string): CostTargetRef | null {
  return parseCostTargetKey(value);
}

// ── Список, фильтры и сводка (Р20, §7) ──

/** Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки. */
export const MECH_REQUEST_SORT_FIELDS = [
  'num',
  /** Заявитель — отдел либо площадка: сервер сортирует по выведенному имени, а не по двум колонкам. */
  'requesterName',
  'objectName',
  'kindName',
  // Срок — две колонки одной подписи: «с» и «по» отвечают на разные вопросы («когда начали»,
  // «когда возвращать»), и сортировка по ним нужна разная.
  'plannedFrom',
  'plannedTo',
  'status',
  'lessorName',
  'rate',
  'responsibleName',
  'comment',
  'createdByName',
  'createdAt',
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили.
  'deletedAt',
] as const;

export const mechRequestListQuerySchema = baseListQuery(MECH_REQUEST_SORT_FIELDS).extend({
  status: requestStatusSchema.optional(),
  /**
   * Площадка — **место эксплуатации**, а не заказчик (Р17). Своё имя, а не общий `objectId`:
   * колонка одна на оба смысла, и одинаковое имя параметра однажды сделало бы фильтр места
   * фильтром заявителя.
   */
  placeObjectId: uuidSchema.optional(),
  /** Заявитель ключом — независимо от площадки (Р20). */
  requester: mechRequesterFilterSchema.optional(),
  /** Вид техники: сравнение по нормализованному ключу, а не по введённой строке (Р5). */
  kind: z.string().trim().max(255).optional(),
  /** Арендодатель: контрагент, у которого взяли единицу (Р6). Имя колонки — `lessor_id`. */
  lessorId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
  /**
   * Период: заявки, чей срок пересекается с этими днями, — «что стояло на площадке в эти дни».
   * Имена свои, а не `plannedFrom`/`plannedTo` самой заявки: там это границы одного срока, здесь —
   * окно вопроса, и совпади имена, фильтр «с 1 сентября» читался бы как «подача ровно 1 сентября».
   */
  periodFrom: dateOnlySchema.optional(),
  periodTo: dateOnlySchema.optional(),
  /**
   * Только действующие аренды (все три условия Р2) — этим отбором и живёт вкладка «В аренде».
   * Отдельный параметр, а не `status=confirmed`: статус не отличает выданное от «ждёт подачи» и от
   * коррекции завершения, а вкладка обязана показывать ровно то, что сейчас стоит на площадках.
   */
  rental: booleanFlagSchema,
  /** Просрочен возврат: действующая аренда с плановой датой в прошлом (Р12). */
  overdue: booleanFlagSchema,
  /** Архив (ADR 0070): без права `archive.read` любое значение означает «без архива» (Р15). */
  archive: archiveFilterSchema,
});
export type MechRequestListQuery = z.infer<typeof mechRequestListQuerySchema>;

/**
 * Сводка над списком (§7). Из фильтров учитывается только площадка: фильтр по статусу свёл бы
 * сводку к самой себе, а по номеру — к одной заявке.
 */
export const mechRequestSummaryQuerySchema = z.object({
  placeObjectId: uuidSchema.optional(),
});
export type MechRequestSummaryQuery = z.infer<typeof mechRequestSummaryQuerySchema>;

/**
 * Четыре числа сводки, и все четыре — про действие, а не про статус: «не обработано» ждёт офиса,
 * «ждут подачи» ждут арендодателя, «в аренде» стоит денег каждый день, «просрочено» стоит денег и
 * требует звонка. Считаются предикатами Р2 — теми же, что и вкладки.
 */
export interface MechRequestSummaryDto {
  /** «Новая»: заявку ещё не взяли в работу. */
  pending: number;
  awaitingIssue: number;
  rental: number;
  overdue: number;
}

// ── Заведение и правка (Р17, Р19) ──

const commentSchema = z.string().trim().max(2000);
const fileIdsSchema = z.array(uuidSchema).max(20);

/**
 * Заведение заявки. Площадка обязательна **всегда** — это место эксплуатации и ось области (Р17), —
 * а отдел заполнен только у заявки отдела: колонки не взаимоисключающие, в отличие от «Заказа ТС»,
 * и это осознанное расхождение. Там объект и отдел — два разных заказчика; здесь объект это место,
 * а отдел — тот, кто просит и на кого относятся расходы.
 *
 * Чего схема не проверяет и проверить не может: **принадлежит ли площадка отделу**. Состав
 * площадок отдела меняется (ADR 0144), живёт он в базе, и ответ на этот вопрос знает только
 * сервер — он же проверяет активность обеих половин пары.
 */
export const createMechRequestSchema = z
  .object({
    objectId: uuidSchema,
    /** Заявитель-отдел; отсутствует — заявку завела сама площадка. */
    departmentId: uuidSchema.optional(),
    kindName: mechKindNameSchema,
    plannedFrom: dateOnlySchema,
    plannedTo: dateOnlySchema,
    /** Кто принимает технику на площадке: арендодатель везёт к человеку, а не к адресу. */
    responsibleName: contactNameSchema,
    responsiblePhone: contactPhoneSchema,
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
  })
  .superRefine((v, ctx) => {
    if (v.plannedTo < v.plannedFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['plannedTo'],
        message: 'Дата возврата не может быть раньше даты подачи',
      });
    }
  });
export type CreateMechRequestInput = z.infer<typeof createMechRequestSchema>;

/**
 * Правка заявки. Схема принимает все поля формы, а **что из них разрешено сейчас** — решает барьер
 * состояния (Б1, Р19) на сервере: он смотрит на саму строку, которой у схемы нет. Выразить его
 * здесь нечем, и попытка была бы хуже отсутствия — форма запрещала бы то, что сервер разрешает,
 * либо наоборот.
 *
 * Срока среди «правимого после Новой» нет намеренно: `plannedTo` после «Новой» двигает только
 * продление (`.extend`, причина, своё событие истории). Схема поле принимает — у «Новой» оно
 * правится, — а барьер отклоняет его у всех прочих состояний.
 */
export const updateMechRequestSchema = z
  .object({
    objectId: uuidSchema.optional(),
    /** `null` — заявка перестаёт быть отдельской и становится заявкой самой площадки. */
    departmentId: uuidSchema.nullable().optional(),
    kindName: mechKindNameSchema.optional(),
    plannedFrom: dateOnlySchema.optional(),
    plannedTo: dateOnlySchema.optional(),
    responsibleName: contactNameSchema.optional(),
    responsiblePhone: contactPhoneSchema.optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
    /**
     * Версия обязательна у всякой мутации существующей строки (Р21): она отвечает на вопрос
     * «карточку открыли час назад, за это время её поменял кто-то ещё», на который замок
     * `FOR UPDATE` не отвечает вовсе.
     */
    version: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    // Схеме есть что сказать про срок, только когда пришли обе даты: прислали одну — вторая лежит
    // в строке, которой у схемы нет, и сравнивает их сервер.
    if (v.plannedFrom && v.plannedTo && v.plannedTo < v.plannedFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['plannedTo'],
        message: 'Дата возврата не может быть раньше даты подачи',
      });
    }
  });
export type UpdateMechRequestInput = z.infer<typeof updateMechRequestSchema>;

/**
 * Дублирование (Р3): «нужны две виброплиты» — две заявки, потому что ставка задаётся за единицу, а
 * две единицы возвращают в разные дни и отрабатывают разное число часов.
 *
 * Своего тела у кнопки нет — копируются значения исходной заявки, — но пара «отдел + площадка»
 * проверяется заново: это заведение новой заявки, а не копия строки, и площадку у отдела могли
 * снять после того, как исходную завели.
 */
export const duplicateMechRequestSchema = z.object({}).strict();

// ── Договорённость: арендодатель, ставка, единица (Р6, Р7) ──

/**
 * Ставка, ₽ (numeric(12,2)). Строго положительная: аренда за ноль — это не аренда, а ошибка ввода,
 * и допустить её значило бы получить расчёт, который ничего не считает.
 */
export const mechRateSchema = z.coerce
  .number()
  .positive('Укажите ставку')
  .max(9_999_999.99, 'Слишком большая ставка')
  .multipleOf(0.01, 'Не более 2 знаков после запятой');

/**
 * Договорённость с арендодателем — неделимая тройка: кто сдаёт, почём и за что. Порознь эти поля
 * не имеют смысла (цена без арендодателя, арендодатель без цены), и база держит это одним
 * инвариантом `num_nonnulls(...) IN (0, 5)`.
 *
 * Арендодателем бывает контрагент типа «Арендодатель механизации» **или** «Арендодатель (ТС)»
 * (Р6): тип у контрагента один, и компания, уже заведённая арендодателем ТС, сдаёт механизацию под
 * своим типом — смена типа сломала бы права её учёток и её технику. Что выбранный контрагент
 * существует, активен и нужного типа, проверяет сервер: FK отвечает «такое сочетание существует»,
 * сервис — «его можно выбрать сегодня».
 */
export const mechDealSchema = z.object({
  lessorId: uuidSchema,
  rate: mechRateSchema,
  rateUnit: mechRateUnitSchema,
});
export type MechDealInput = z.infer<typeof mechDealSchema>;

/**
 * Правка договорённости отдельной ручкой правом `.status` — тем же, которым её и поставили
 * (Р19). Через общий `PATCH` это было бы неверно: там барьер роли пускает площадку, а
 * договорённость — работа офиса.
 *
 * После выдачи договорённость не правится вовсе: техника уже работает по этой ставке. Лечение —
 * снять отметку выдачи, поправить, отметить заново.
 */
export const updateMechDealSchema = mechDealSchema.extend({
  version: z.number().int().nonnegative(),
});
export type UpdateMechDealInput = z.infer<typeof updateMechDealSchema>;

// ── Выдача, снятие отметки, продление, завершение ──

const factDateSchema = dateOnlySchema.refine(
  (value) => isAllowedMechFactDate(value),
  MECH_FUTURE_DATE_MESSAGE,
);

/** Отметка выдачи: с этого дня пошли деньги, и в истории он виден своим событием (Р11). */
export const issueMechRequestSchema = z.object({
  actualFrom: factDateSchema,
  version: z.number().int().nonnegative(),
});
export type IssueMechRequestInput = z.infer<typeof issueMechRequestSchema>;

/**
 * Снятие ошибочной отметки выдачи (Р2). Причина обязательна: без неё в истории осталась бы пара
 * событий, по которой не понять, отменили выдачу или техника уезжала и вернулась.
 *
 * Доступно ровно при действующей аренде — всём предикате целиком (`isMechRentalRunning`), а не при
 * одном пустом `actual_to`. Иначе снятие прошло бы там, где снимать нечего: у заявки без выдачи, у
 * отменённой и вторым нажатием подряд.
 */
export const revokeMechIssueSchema = z.object({
  reason: z.string().trim().min(1, 'Укажите причину').max(500, 'Слишком длинная причина'),
  version: z.number().int().nonnegative(),
});
export type RevokeMechIssueInput = z.infer<typeof revokeMechIssueSchema>;

/** Дата продления строго позже прежней — один текст на отказ сервера и на проверку формы. */
export const MECH_EXTEND_NOT_LATER_MESSAGE =
  'Новая дата возврата должна быть позже прежней: сокращение срока оформляется завершением с фактической датой';

/**
 * Продление аренды (Р9, Р11): право своё (`.extend`, у диспетчера), причина обязательна, событие
 * истории своё. Причину нельзя положить в комментарий заявки — она перезаписала бы его.
 *
 * Продлевается только действующая аренда: у коррекции завершения и у заявки, которую ещё не
 * подали, продлевать нечего. Что новая дата позже прежней, проверяет сервер — прежней у схемы нет.
 */
export const extendMechRequestSchema = z.object({
  plannedTo: dateOnlySchema,
  reason: z.string().trim().min(1, 'Укажите причину продления').max(500, 'Слишком длинная причина'),
  version: z.number().int().nonnegative(),
});
export type ExtendMechRequestInput = z.infer<typeof extendMechRequestSchema>;

/**
 * Отработанное количество в единицах ставки: часы либо смены (Р7). Обязательно при завершении и
 * строго положительно — тогда расчёт `actual_units × rate` есть всегда, расхождение с введённой
 * суммой видно всегда, а данные годятся для отчёта «во что обходится час виброплиты у разных
 * арендодателей».
 */
export const mechUnitsSchema = z.coerce
  .number()
  .positive('Укажите отработанное количество')
  .max(99_999_999.99, 'Слишком большое значение')
  .multipleOf(0.01, 'Не более 2 знаков после запятой');

/** Итоговая стоимость, ₽ (numeric(14,2)). Ноль допустим: аренда бывает и в счёт другой работы. */
export const mechCostSchema = z.coerce
  .number()
  .min(0, 'Стоимость не может быть отрицательной')
  .max(999_999_999, 'Слишком большая сумма')
  .multipleOf(0.01, 'Не более 2 знаков после запятой');

/**
 * Завершение аренды — только вручную (решение заказчика): портал не закрывает её по плановой дате,
 * потому что дата возврата и есть то, ради чего заявку закрывают человеком.
 *
 * Обе фактические даты, а не одна: выдачу могли отметить не тем днём, и завершение — последний
 * момент, когда это исправляют. Стоимость приходит от человека, а не считается порталом:
 * `actual_units × rate` показывается рядом и подсвечивает расхождение, но в счёте арендодателя
 * бывают подача, простой и округление, а сходиться сумма должна со счётом.
 *
 * Повторное завершение (после отката «Выполнена» → «В работе») перезаписывает все четыре значения,
 * и прежние сохранит только история — ради этого у завершения и заведено своё событие (Р11).
 */
export const completeMechRequestSchema = z
  .object({
    actualFrom: factDateSchema,
    actualTo: factDateSchema,
    actualUnits: mechUnitsSchema,
    finalCost: mechCostSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.actualTo < v.actualFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['actualTo'],
        message: 'Дата возврата не может быть раньше даты выдачи',
      });
    }
  });
export type CompleteMechRequestInput = z.infer<typeof completeMechRequestSchema>;

/**
 * Расчёт стоимости: ставка на отработанное, с округлением до копейки. Своя функция, а не общая с
 * заказом ТС: там считается стоимость выполненного заказа по ставкам назначенной машины, здесь —
 * аренда единицы по договорной ставке, и совпадение формулы сегодня не делает вопрос одним.
 *
 * `null` — договорённости ещё нет, и считать нечем; выдуманный ноль читался бы как «бесплатно».
 */
export function calcMechCost(rate: number | null, units: number): number | null {
  return rate == null ? null : Math.round(rate * units * 100) / 100;
}

/**
 * Отработанное строкой с единицей: «26 ч», «3 смены», «2,5 смены».
 *
 * Через `workedAmountLabel` заказа ТС, а не своей копией: русское склонение «смена / смены / смен»
 * — это правило языка, а не модуля, и вторая его копия разошлась бы с первой на первом же «11
 * смен». Единицы переименовываются здесь ровно потому, что у соседа они отвечают на другой вопрос
 * («чем меряют отработанное», отсюда множественное число), а у механизации одна колонка служит и
 * ставке, и факту.
 */
export function mechUnitsLabel(unit: MechRateUnit, amount: number): string {
  return workedAmountLabel(unit === 'hour' ? 'hours' : 'shifts', amount);
}

// ── Переходы статусов (Р2, Р8) ──

/**
 * Смена статуса. Договорённость приезжает вместе с переходом в «В работе», а факт — вместе с
 * переходом в «Выполнена»: то же устройство, что у закрытия заявки вывоза, и по той же причине —
 * отдельным запросом их пришлось бы проводить не атомарно со сменой статуса.
 *
 * Дата выдачи здесь необязательна: «Взять в работу» ставит её только тогда, когда техника уже на
 * объекте. Не поставили — заявка получает тег «ждёт подачи», и отметить выдачу можно позже своей
 * ручкой.
 */
export const changeMechRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: commentSchema.optional().default(''),
    /** Договорённость: обязательна при переходе в «В работе» — её требует и CHECK базы (Р8). */
    deal: mechDealSchema.optional(),
    /** Фактическая выдача сразу, если техника уже на объекте. */
    actualFrom: factDateSchema.optional(),
    /** Факт возврата: обязателен при завершении (Р7) — проверяет сервер, у него заявка перед глазами. */
    completion: completeMechRequestSchema.optional(),
    version: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
    }
    /*
     * «Завершена» у механизации не бывает вовсе (Р8): перехода в неё нет ни в одном коридоре, а
     * база держит это отдельным `CHECK (status <> 'completed')`. Схема отвечает тем же, и раньше:
     * иначе отказ пришёл бы из ограничения базы, то есть пятисотым вместо внятного «такого статуса
     * у аренды нет».
     */
    if (v.status === 'completed') {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'У аренды механизации нет статуса «Завершена»',
      });
    }
    if (v.deal && v.status !== 'confirmed') {
      ctx.addIssue({
        code: 'custom',
        path: ['deal'],
        message: 'Арендодатель и ставка указываются при переводе заявки в работу',
      });
    }
    if (v.actualFrom && v.status !== 'confirmed') {
      ctx.addIssue({
        code: 'custom',
        path: ['actualFrom'],
        message: 'Дата выдачи отмечается у заявки в работе',
      });
    }
    if (v.completion && v.status !== 'done') {
      ctx.addIssue({
        code: 'custom',
        path: ['completion'],
        message: 'Фактические даты и стоимость указывают при завершении аренды',
      });
    }
  });
export type ChangeMechRequestStatusInput = z.infer<typeof changeMechRequestStatusSchema>;

/**
 * Почему переход запрещён состоянием строки — текстом, либо `null`, если разрешён. Один ответ на
 * отказ сервера (422) и на портал, который такой ход просто не предлагает: разойдись они, человек
 * нажимал бы кнопку, кончающуюся отказом.
 *
 * Барьеров два, и оба про **выданную технику**:
 *
 * 1. **отмена после выдачи** — за выданную технику выставят счёт, и отмена означала бы, что аренды
 *    не было. Лечится завершением с фактическими датами, а не отменой;
 * 2. **откат в «Новую» после выдачи** — отдельный барьер, а не следствие первого. `confirmed → new`
 *    стирает договорённость и факт по построению (`new_empty_check`), и без запрета получалась бы
 *    дверь из трёх шагов в обход запрета на удаление действующей аренды: откат → всё стёрлось →
 *    физическое удаление «Новой». Тем же путём уходила бы и коррекция завершения.
 *
 * Порядок лечения ошибочной выдачи один и остаётся единственным: сначала снять отметку, потом
 * откатывать. Два шага здесь не бюрократия — это то, что отличает исправление опечатки от стирания
 * состоявшейся аренды.
 */
export function mechTransitionBlocker(row: MechRentalState, to: RequestStatus): string | null {
  if (row.actualFrom === null) return null;
  if (to === 'cancelled') {
    return `Техника выдана ${formatDay(row.actualFrom)}: заявку нужно завершить, а не отменять`;
  }
  if (to === 'new') {
    return 'Сначала снимите отметку выдачи: возврат в «Новую» стёр бы договорённость и факт аренды';
  }
  return null;
}

// ── Барьер состояния для правки и удаления (Р19, Б1) ──

/**
 * Что у заявки правится формой в её нынешнем состоянии:
 *
 * - `all` — «Новая»: любое поле, включая срок, площадку и заявителя;
 * - `contact` — комментарий, ответственный, телефон и вложения. Всё, за чем стоит договорённость с
 *   арендодателем (срок, вид, место), после «Новой» неизменяемо **для всех**, включая офис и
 *   администратора: срок двигает только продление, и обойти его штатной формой нельзя;
 * - `comment` — закрытая заявка: комментарий и вложения. Ответственного здесь уже не правят —
 *   принимать технику некому, и правка этого поля переписывала бы историю, а не контакты; акт же
 *   приходит позже, и подшить его надо;
 * - `none` — архивная строка: у неё нет ни правки, ни повторного удаления, только восстановление и
 *   удаление насовсем.
 *
 * Барьер роли (Б2, `assertObjectRoleEditable`) этим **не заменяется**, а дополняется: здесь ответ
 * на «что вообще можно делать с записью в таком состоянии», а «кому из ролей это разрешено» —
 * отдельный вопрос, и площадка с отделом по-прежнему правят заявку только в «Новой».
 */
export type MechEditScope = 'all' | 'contact' | 'comment' | 'none';

export function mechEditScope(row: MechRentalState & { deletedAt: string | null }): MechEditScope {
  if (row.deletedAt) return 'none';
  if (row.status === 'new') return 'all';
  return isClosedRequestStatus(row.status) ? 'comment' : 'contact';
}

/**
 * Что делает с заявкой удаление в её нынешнем состоянии:
 *
 * - `hard` — «Новая» стирается физически вместе с вложениями (ADR 0070): просьба, о которой
 *   передумали, историей не является;
 * - `archive` — обычное архивирование строки, обратимое восстановлением;
 * - `none` — **действующая аренда и коррекция завершения не удаляются никем**. Удаление уводит
 *   строку из всех выборок, а техника стоит на площадке и стоит денег; у коррекции завершения то
 *   же самое с другого конца — вместе со строкой исчезла бы стоимость состоявшейся аренды. Сюда же
 *   попадает уже удалённая строка (Б3): второго удаления у неё нет, только восстановление и
 *   удаление насовсем.
 *
 * Тот же ответ спрашивает и `purge` (Р15): право открывает действие, состояние его разрешает, и у
 * удаления насовсем не может быть исключения из этого — после него восстанавливать нечего. Права
 * функция не знает вовсе: `hard` не означает «этому человеку можно», он означает «так это
 * устроено», а кому можно — отвечает барьер роли (Б2) на сервере.
 */
export type MechDeleteScope = 'hard' | 'archive' | 'none';

export function mechDeleteScope(
  row: MechRentalState & { deletedAt: string | null },
): MechDeleteScope {
  if (row.deletedAt) return 'none';
  if (isMechRentalRunning(row) || isMechCompletionCorrection(row)) return 'none';
  return row.status === 'new' ? 'hard' : 'archive';
}

/** Один текст на отказ сервера и на подсказку в портале — см. `mechDeleteScope`. */
export const MECH_DELETE_RUNNING_MESSAGE =
  'Аренда идёт: сначала завершите её — удалённая заявка унесла бы из журнала стоимость аренды';

// ── DTO ──

export interface MechRequestDto {
  id: string;
  /** Сквозной номер: по нему ищут и сортируют. Показывают `displayNumber`. */
  num: number;
  /** Номер как его показывают: «МХ-42». */
  displayNumber: string;
  /** Площадка — место эксплуатации и ось области (Р17); у заявки она есть всегда. */
  objectId: string;
  objectCode: string;
  objectName: string;
  /**
   * Адрес площадки; пустая строка — адрес у объекта не заполнен. Показывается во вкладке «В
   * аренде» второй строкой к наименованию: «куда ехать забирать» спрашивают у неё чаще всего.
   */
  objectAddress: string;
  /** Заявитель-отдел; `null` — заявку завела сама площадка. */
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  kindName: string;
  plannedFrom: string;
  plannedTo: string;
  responsibleName: string;
  responsiblePhone: string;
  comment: string;
  status: RequestStatus;
  /** Причина отмены из истории статусов; заполнена только у отменённых заявок. */
  cancelReason: string | null;
  /** Арендодатель; `null` — договорённости ещё нет (заявка «Новая» либо отменённая). */
  lessorId: string | null;
  lessorName: string | null;
  /**
   * Тип контрагента-арендодателя: механизации либо ТС (Р6). В DTO он есть потому, что одна и та же
   * компания бывает арендодателем ТС, и в списке аренд это объясняет, почему её нет в фильтре
   * «Арендодатель механизации».
   */
  lessorType: CounterpartyType | null;
  rate: number | null;
  rateUnit: MechRateUnit | null;
  /** День фактической выдачи; `null` — техника ещё не подана. */
  actualFrom: string | null;
  /** День фактического возврата; `null` — техника ещё у нас либо не подавалась. */
  actualTo: string | null;
  /** Отработанные часы или смены — в единицах ставки (Р7). */
  actualUnits: number | null;
  /** Итоговая стоимость: то, что ввёл человек, а не расчёт портала. */
  finalCost: number | null;
  files: FileDto[];
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Кто отправил заявку в архив (ADR 0070); пусто у живой и у той, чей автор удаления не сохранился. */
  deletedByName: string | null;
}

// ── История заявки (ADR 0012, Р11) ──
// Сами события описаны в `request-history.ts` — их форма общая для всех модулей заявок. Здесь
// остаётся своё: как называются поля этого модуля в перечне изменений.

/**
 * Подписи полей в истории; ключи проставляет сервер при вычислении изменений.
 *
 * В `changes.field` идут **технические ключи**, а не подписи, и это правило всего протокола:
 * переименование колонки в интерфейсе иначе переписывало бы историю задним числом, а старые записи
 * остались бы с прежними словами.
 */
export const mechRequestChangeLabels: Record<string, string> = {
  // Поля формы (`mech_request.update`).
  object: 'Площадка',
  department: 'Заявитель',
  kindName: 'Вид техники',
  plannedFrom: 'Подача',
  plannedTo: 'Возврат',
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  comment: 'Комментарий',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Откреплены файлы',
  // Договорённость (`mech_request.deal`): назначена, исправлена или стёрта входом в «Новую». Без
  // своего события «была ставка 1200/час, стала 1500» не осталось бы нигде.
  lessor: 'Арендодатель',
  rate: 'Ставка',
  rateUnit: 'Единица ставки',
  // Выдача и её снятие (`mech_request.issue`, `mech_request.issue_revoke`). Причина идёт строкой
  // вида «список» (`from === null`): у неё нет «было», и пара «— → текст» читалась бы как потеря.
  actualFrom: 'Выдана',
  issueRevokeReason: 'Причина снятия отметки',
  // Продление (`mech_request.extend`): обе даты приходят обычной парой «было → стало», причина —
  // списком. Ключ `plannedTo` тот же, что у правки формы: поле одно, а событий два, и различает их
  // вид истории, а не имя ключа.
  extendReason: 'Причина продления',
  // Завершение (`mech_request.complete`), в том числе повторное после отката: прежние числа не
  // сохранит ничто, кроме этой записи, а именно их спрашивают, разбирая счёт.
  actualTo: 'Возвращена',
  actualUnits: 'Отработано',
  finalCost: 'Итоговая стоимость',
};
