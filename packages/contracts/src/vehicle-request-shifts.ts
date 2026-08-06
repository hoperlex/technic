import { z } from 'zod';
import { requestStatusLabels, type RequestStatus, type VehicleRequestType } from './enums';
import { dateKeySpan, dateKeysBetween, TIME_FORMAT_MESSAGE, TIME_PATTERN } from './time';

// ── Подтверждение смен по заказу спецтехники ──
// Техника стоит на объекте неделями, а работа считается по дням: за каждый день заказа — время
// смены, машиночасы, заправка и подпись объекта, что этот день был именно таким. Пока подписи по
// прошедшим дням нет, заявка не уходит из среза «На объекте», а её закрытие предупреждает, что
// закрывают неподтверждённую работу.
//
// Правила живут здесь, а не на сервере, по той же причине, что и правила досрочного завершения
// (ADR 0044): портал обязан не предлагать действий, которые сервер отклонит, — и объяснять
// недоступное теми же словами, которыми откажет API.

/** Максимум машиночасов за день: сутки длиннее суток не бывают. */
export const MAX_MACHINE_HOURS = 24;

/**
 * Заявка глазами правил смен. Структурный тип, а не `Pick` от DTO: модуль стоит в импортах
 * раньше самих заявок (их DTO ссылается на здешнюю сводку), и обратная ссылка замкнула бы круг.
 */
export interface ShiftSubject {
  requestType: VehicleRequestType;
  status: RequestStatus;
  deletedAt: string | null;
  dateFrom?: string;
  dateTo?: string | null;
  shifts?: VehicleRequestShiftsSummaryDto | null;
}

/**
 * Сводка смен заявки: сколько дней подтверждено и сколько прошедших дней ещё ждут подписи.
 *
 * Двумя числами, а не списком дат: сводка едет в каждой строке списка и обслуживает три правила
 * — предупреждение при закрытии, запрет смены машины и предупреждение в срезе. Конкретные даты
 * нужны только в самой таблице смен, и там их отдаёт сервер.
 */
export interface VehicleRequestShiftsSummaryDto {
  approvedDays: number;
  /** Дни заказа, которые уже наступили, но не подтверждены. Ими и предупреждают о закрытии. */
  unapprovedPastDays: number;
}

/** Смена одного дня. Пустая (`filledAt === null`) — день заказа, за который ещё ничего не внесли. */
export interface VehicleRequestShiftDto {
  date: string;
  /** Время смены `HH:mm`; пусто — не проставили (машина работала, но часы записали одним числом). */
  startedAt: string | null;
  endedAt: string | null;
  machineHours: number;
  /** Заправка свободным текстом: «120 л», «залили полный», «по талону». */
  refuel: string;
  comment: string;
  filledBy: string | null;
  filledByName: string | null;
  filledAt: string | null;
  /** Подпись объекта: кто и когда подтвердил этот день. `null` — день ещё не согласован. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
}

/** Таблица смен заявки: дни заказа целиком, включая пустые, и день, по которому считался срез. */
export interface VehicleRequestShiftsDto {
  items: VehicleRequestShiftDto[];
  /** День среза (`YYYY-MM-DD`) по Москве: по нему решается, какой день ещё в будущем. */
  onDate: string;
}

/** Последний день работ: пустая дата окончания — однодневный срок (так же читает его весь модуль). */
function lastDayOf(r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>): string {
  return r.dateTo || r.dateFrom || '';
}

/**
 * Дни заказа — по ним и строится таблица смен. Строк в базе на эти дни может не быть вовсе:
 * смену заводит первое заполнение (иначе заготовку было бы не отличить от «не заполнили»).
 */
export function shiftDaysOf(r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>): string[] {
  if (!r.dateFrom) return [];
  return dateKeysBetween(r.dateFrom, lastDayOf(r));
}

/**
 * Сколько дней заказа уже наступило на `onDate` (сегодняшний — считается). Ровно столько подписей
 * и должно стоять к этому дню; разницу с подтверждёнными и показывает сводка.
 */
export function pastShiftDaysCount(
  r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  onDate: string,
): number {
  if (!r.dateFrom || r.dateFrom > onDate) return 0;
  const last = lastDayOf(r);
  return dateKeySpan(r.dateFrom, last < onDate ? last : onDate);
}

/** День принадлежит сроку заявки. */
export function isShiftDayInTerm(
  r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  day: string,
): boolean {
  return !!r.dateFrom && day >= r.dateFrom && day <= lastDayOf(r);
}

/**
 * Почему по этой заявке нельзя вести смены — текстом, либо `null`, если можно. Одна функция на
 * портал и API: сервер отвечает этой строкой (422), портал ею же объясняет неактивную строку
 * таблицы.
 *
 * Условие то же, при котором техника считается работающей: заказ спецтехники в работе. У «Новой»
 * на объект ещё никто не выходил, у закрытой день работы уже предъявлен фактом (ADR 0029).
 */
export function shiftsBlocker(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') {
    return 'Смены ведут по заказу техники на объект: у грузоперевозки срока работ нет';
  }
  if (r.deletedAt) return 'Заявка в архиве';
  if (r.status !== 'confirmed') {
    return `Смены ведут у заявки в статусе «${requestStatusLabels.confirmed}»`;
  }
  return null;
}

/**
 * Почему нельзя вести смену конкретного дня. Сверх общего запрета — две границы дня: он должен
 * принадлежать сроку заявки и не лежать в будущем.
 *
 * Будущий день не подтверждают и не заполняют: смену пишут по факту, а подпись под днём, который
 * ещё не наступил, — это подпись под тем, чего не было. `onDate` считает сервер и отдаёт в ответе:
 * часы клиента бывают сбиты, а браузер восточнее Москвы начинает сутки раньше.
 */
export function shiftDayBlocker(r: ShiftSubject, day: string, onDate: string): string | null {
  const blocker = shiftsBlocker(r);
  if (blocker) return blocker;
  if (!isShiftDayInTerm(r, day)) return 'День вне срока заявки';
  if (day > onDate) return 'День ещё не наступил — смену подтверждают по факту';
  return null;
}

/** Можно ли вести смену этого дня — тот же разбор, что и `shiftDayBlocker`. */
export function canEditShiftDay(r: ShiftSubject, day: string, onDate: string): boolean {
  return shiftDayBlocker(r, day, onDate) === null;
}

/**
 * Чем рискует закрытие заявки прямо сейчас: остались дни, за которые никто не расписался. Работу
 * принимает объект — по дням, а не одним итогом в момент закрытия, — и незакрытый день означает,
 * что о машиночасах этого дня ещё не договорились.
 *
 * Предупреждение, а не запрет (Р9 плана смен пересмотрен): флоу заявки прогоняют целиком — заказ,
 * работа, закрытие, — и отказ закрыть упирал бы каждый прогон в тринадцать подписей, которых на
 * этом этапе никто не ставит. Незамеченным закрытие не проходит: портал показывает этот текст в
 * окне закрытия, а сервер оставляет пометку в истории заявки — сводка смен после закрытия
 * обнуляется, и другого следа не осталось бы. Вернуть запрет — одна проверка в маршруте статуса.
 */
export function shiftsCompletionWarning(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') return null;
  const pending = r.shifts?.unapprovedPastDays ?? 0;
  if (pending <= 0) return null;
  return `${pendingDaysLabel(pending)} без согласования — заявка закрывается без подписи объекта`;
}

/**
 * Почему нельзя сменить назначенную машину или откатить заявку в «Новую»: за подтверждёнными
 * днями стоит работа конкретной техники, и подмена задним числом превратила бы подпись объекта в
 * подпись под чужими часами. Откат заперт тем же условием не для строгости: он стирает
 * назначение, и без него запрет обходился бы в один шаг.
 */
export function approvedShiftsBlocker(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') return null;
  const approved = r.shifts?.approvedDays ?? 0;
  if (approved <= 0) return null;
  return `По заявке согласовано смен: ${approved} — сначала снимите согласование`;
}

/** «3 смены», «11 смен» — количество с русским склонением. */
function pendingDaysLabel(days: number): string {
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'смен'
      : last === 1
        ? 'смена'
        : last >= 2 && last <= 4
          ? 'смены'
          : 'смен';
  return `${days} ${form}`;
}

/**
 * Продолжительность смены в часах по её времени; `null` — время не проставлено. Смена через
 * полночь («20:00 – 08:00») считается перешедшей в следующие сутки: день здесь — заказанный день
 * заявки, а не астрономические сутки.
 *
 * Машиночасы этим числом не подменяются — техника внутри смены простаивает, — но расхождение
 * видно человеку, и форма показывает его подсказкой.
 */
export function shiftSpanHours(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const from = TIME_PATTERN.exec(startedAt);
  const to = TIME_PATTERN.exec(endedAt);
  if (!from || !to) return null;
  const start = Number(from[1]) * 60 + Number(from[2]);
  const end = Number(to[1]) * 60 + Number(to[2]);
  const minutes = end > start ? end - start : end + 24 * 60 - start;
  return Math.round((minutes / 60) * 100) / 100;
}

/** Итог подтверждённых машиночасов — им подставляется факт выполнения при закрытии (ADR 0029). */
export function approvedMachineHours(shifts: VehicleRequestShiftDto[]): number {
  const total = shifts.reduce((sum, s) => (s.approvedAt ? sum + s.machineHours : sum), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Наступившие дни заказа без подписи объекта — их перечисляет предупреждение при закрытии. Считается
 * по самой таблице смен, а не по сводке: сводка отвечает числом, а закрывающему нужно знать, какие
 * именно дни он закрывает неподтверждёнными. Будущие дни сюда не попадают — их и не подписывают.
 */
export function unapprovedPastShiftDays(
  shifts: VehicleRequestShiftDto[],
  onDate: string,
): string[] {
  return shifts.filter((s) => s.date <= onDate && !s.approvedAt).map((s) => s.date);
}

// ── Схемы ──

/** Время смены — тот же канонический `HH:mm`, что и во всех заявках. */
export const shiftTimeSchema = z.string().trim().regex(TIME_PATTERN, TIME_FORMAT_MESSAGE);

/** Машиночасы: до суток, с точностью до сотой. Ноль — законное значение (простой, Р7). */
export const machineHoursSchema = z
  .number()
  .min(0, 'Машиночасы не бывают отрицательными')
  .max(MAX_MACHINE_HOURS, `Машиночасов за день не больше ${MAX_MACHINE_HOURS}`)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Не более 2 знаков после запятой');

export const SHIFT_IDLE_COMMENT_MESSAGE = 'Опишите, почему техника не работала';

/**
 * Смена одного дня. Дата в теле не передаётся: день — часть адреса (`/shifts/:date`), и второй
 * ответ на «за какой это день» расходился бы с первым.
 *
 * Нулевые машиночасы требуют комментария: простой, дождь, не открыли фронт работ — это часть
 * учёта, а не пропуск в нём, и за такой день с арендодателем разговаривают отдельно. Ту же пару
 * держит `CHECK` в базе.
 */
export const saveVehicleRequestShiftSchema = z
  .object({
    startedAt: shiftTimeSchema.nullable().optional(),
    endedAt: shiftTimeSchema.nullable().optional(),
    machineHours: machineHoursSchema,
    refuel: z.string().trim().max(200).optional().default(''),
    comment: z.string().trim().max(2000).optional().default(''),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Половина смены не описывает ничего: «с 08:00» без конца — это не время работы.
    if ((v.startedAt == null) !== (v.endedAt == null)) {
      ctx.addIssue({
        code: 'custom',
        path: [v.startedAt == null ? 'startedAt' : 'endedAt'],
        message: 'Укажите начало и конец смены',
      });
    }
    if (v.machineHours === 0 && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: SHIFT_IDLE_COMMENT_MESSAGE });
    }
  });
export type SaveVehicleRequestShiftInput = z.infer<typeof saveVehicleRequestShiftSchema>;
export type SaveVehicleRequestShiftBody = z.input<typeof saveVehicleRequestShiftSchema>;

/**
 * Согласование смены и его снятие — одним телом, как виза заявки (ADR 0025 п. 6): у них одно
 * право, одна область и один инвариант; раздельные маршруты разошлись бы в проверках.
 */
export const approveVehicleRequestShiftSchema = z.object({ approved: z.boolean() }).strict();
export type ApproveVehicleRequestShiftInput = z.infer<typeof approveVehicleRequestShiftSchema>;
