import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  requestStatusLabels,
  shiftDaysDroppedByTerm,
  type AssignmentShiftDay,
  type RequestStatus,
  type ShiftDayRange,
} from '@technic/contracts';
import type * as schema from '../db/schema';
import { vehicleRequestShifts } from '../db/schema';
import { err } from '../lib/errors';
import { dateKeyRu } from './request-diff';

/**
 * Смены заявки глазами дверей истории назначения: чтение дней, разделение их на два множества
 * предпросмотра и диапазонное снятие (`docs/vehicle-request-actual-end-date-plan.md`, Р10; этап Э7).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Работа со сменами у дверей была ровно одна — предпросмотр смены техники, —
 * и жила она приватной функцией внутри самой двери (`assignment-reassign.ts`). Дверей, которым те
 * же строки нужны, становится две: закрытие фактической датой снимает дни за границей факта, и
 * написанное внутри одной двери чтение стало бы **второй редакцией** того же расчёта — а
 * расходятся такие пары молча: окно показало бы один состав дней, а боевая ручка стёрла бы другой.
 * Поэтому чтение, разделение и удаление стоят здесь, а двери их называют, а не переписывают.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. **Политики**: кто из двух множеств чем становится и что дверь с ними делает —
 * дело двери. Смена техники сегодня запирается **любым** подписанным днём заявки, а не днём
 * диапазона, и снимает подписи коррекцией; закрытие фактической датой отказывает 422 по
 * подписанному дню **за границей факта** и стирает по нему заполненные без подписи часы. Общими
 * их делает форма ответа (`AssignmentShiftDay`), а не правило. Нет здесь и правил «какой день
 * можно вести» — они одни на портал и сервер и лежат в контрактах (`shiftDayBlocker`), — и нет
 * самого расчёта диапазона: он контрактный (`shiftRangeAfterActualEnd`), потому что окно обязано
 * назвать те же дни, что снимет сервер.
 *
 * ONE POLICY DOES LIVE HERE: the refusal of a term edit that drops a filled day
 * (`assertTermKeepsFilledShifts`, ADR 0184 of 2026-10-12). It is not one door's choice but the same
 * answer of both term doors — the wide edit and the term command — and written at each door it would
 * be two texts and two reads that drift apart.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ — ВТОРЫМ СЕРВИСОМ СМЕН. Предметный сервис смен
 * ([vehicle-request-shifts.ts](./vehicle-request-shifts.ts)) обслуживает таблицу смен в карточке:
 * заполнение дня, подпись объекта, сводка, снятие **всех** смен при откате в «Новую»
 * (`dropRequestShifts`). Здесь — только то, что нужно каноническим командам §8: чтение под уже
 * взятыми блокировками и снятие по диапазону дат. Граница проходит по вызывающему, а не по
 * таблице: маршрут смен ходит туда, дверь истории — сюда.
 *
 * СОЕДИНЕНИЕ ПРИХОДИТ АРГУМЕНТОМ, ПУЛ НЕ ИМПОРТИРУЕТСЯ (урок Ю23, как в `assignment-write.ts`):
 * `src/db/client` тянет `src/config`, а тот валидирует весь env приложения при загрузке, — и
 * модуль, импортировавший пул, требовал бы JWT и S3 от любого, кто его загрузил, включая чистые
 * тесты и maintenance-скрипты. Тип транзакции берётся у drizzle.
 *
 * ЧТО ОБЯЗАН ДЕРЖАТЬ ВЫЗЫВАЮЩИЙ. Строку заявки под `FOR UPDATE` (шаг 3 канона): читать смены,
 * решать по прочитанному и удалять по тому же решению можно только под одной блокировкой, иначе
 * между чтением и удалением объект успевает подписать день — и стёрт он будет уже подписанным.
 */

type AppDatabase = NodePgDatabase<typeof schema>;

/** Транзакция двери. Тип берётся у drizzle — прикладной пул модуль не импортирует (Ю23). */
export type ShiftsTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * День работы заявки, как его читают двери: дата, часы и состояние подписи.
 *
 * Пустых заготовок среди этих строк не бывает: строка появляется при первом заполнении (`filled_by`
 * объявлен `NOT NULL`), а дни заказа без часов существуют только в таблице портала. Поэтому
 * «неподписанная строка» и «заполненные без подписи часы» — одно и то же множество, и второго
 * признака заполненности читать не нужно.
 */
export interface RequestShiftDay {
  date: string;
  hours: number;
  approved: boolean;
}

/**
 * The request's work days with hours and sign-off state — the common input of every shift
 * computation of the doors.
 *
 * The whole request is read, not a range: the reassignment preview names days across the whole
 * request (which of them lock or are cleared is `shift-approval-scope.ts`'s answer, ADR 0210), the
 * closing door takes the range beyond the actual end, and a second read of the same rows for a
 * second question would give two pictures of the state inside one transaction. The range is cut
 * from what was read (`splitShiftDaysByRange`).
 *
 * Ordered by date on purpose: the window names these days to a person as the price of confirming,
 * a list that reorders between two identical requests would read as a different list — and it is
 * hashed into the fingerprint as well.
 */
export async function readShiftDays(tx: ShiftsTx, requestId: string): Promise<RequestShiftDay[]> {
  const rows = await tx
    .select({
      date: vehicleRequestShifts.shiftDate,
      hours: vehicleRequestShifts.machineHours,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .where(eq(vehicleRequestShifts.requestId, requestId))
    .orderBy(vehicleRequestShifts.shiftDate);
  return rows.map((row) => ({
    date: row.date,
    hours: Number(row.hours),
    approved: row.approvedAt !== null,
  }));
}

/** День в форме предпросмотра: наружу идут дата и часы — состояние подписи выражено множеством. */
export function toAssignmentShiftDay(row: { date: string; hours: number }): AssignmentShiftDay {
  return { date: row.date, hours: row.hours };
}

/**
 * Два множества смен диапазона — «из-за чего команда невозможна» и «что она сотрёт».
 *
 * Имена полей те же, что у `AssignmentPreviewDto`, и это не совпадение: множества считаются
 * ровно для него, а переименование по дороге заставило бы каждую дверь помнить соответствие.
 */
export interface ShiftDaysSplit {
  /** Подписанные объектом дни диапазона: подпись снимает только коррекция, дверь отвечает 422. */
  blockedShiftDays: AssignmentShiftDay[];
  /** Заполненные без подписи дни диапазона: их дверь удалит после подтверждения отпечатка. */
  clearedShiftDays: AssignmentShiftDay[];
}

/**
 * Разложить прочитанные дни на два множества по диапазону.
 *
 * Два списка, а не один с флагом: «нельзя» и «будет стёрто» — разные ответы человеку, и слитые в
 * один они дали бы окно, которое либо пугает лишним, либо молчит о потере (та же причина, по
 * которой поля раздельны в самом DTO).
 *
 * `range === null` — снимать нечего, и оба множества пусты: закрытие ровно по концу срока (а с
 * однодневным заказом — единственным днём) не выходит за факт ни одним днём. Пустой ответ здесь
 * законен и не отличается от «в диапазоне нет строк»: и то и другое означает, что дверь не
 * спрашивает подтверждения и ничего не удаляет.
 *
 * Дни за пределами диапазона не попадают **ни в одно** из множеств, даже подписанные: работу
 * внутри факта закрытие не трогает, и подписанный день внутри срока запирать закрытие не вправе —
 * иначе ни один нормально отработанный заказ не закрылся бы вовсе.
 */
export function splitShiftDaysByRange(
  days: readonly RequestShiftDay[],
  range: ShiftDayRange | null,
): ShiftDaysSplit {
  if (!range) return { blockedShiftDays: [], clearedShiftDays: [] };
  const inRange = days.filter((day) => day.date >= range.from && day.date <= range.to);
  return {
    blockedShiftDays: inRange.filter((day) => day.approved).map(toAssignmentShiftDay),
    clearedShiftDays: inRange.filter((day) => !day.approved).map(toAssignmentShiftDay),
  };
}

/** A request term as the shift rules read it: an empty `dateTo` is a one-day term. */
export interface ShiftTermBounds {
  dateFrom: string;
  dateTo: string | null;
}

/**
 * Refuse a term edit that drops a filled shift day (ADR 0184, section of 2026-10-12) — the single
 * refusal of both term doors: the wide edit `PATCH /vehicle-requests/:id` and the term command
 * (`assignment-period.ts`). Which days count is the contract's rule (`shiftDaysDroppedByTerm`);
 * this helper reads the rows, words the refusal and is the only place that does, so the two doors
 * cannot drift apart in what they refuse or in how they say it.
 *
 * WHY A REFUSAL AND NOT A DELETE. The neighbouring doors that shorten a term decided their own
 * policy, and each names the days it touches: closing by the actual date erases unsigned hours by a
 * confirmed list and refuses signed ones (ADR 0178), the weekly annulment refuses signed days
 * (ADR 0218). A plain term edit has no such list, and the old behaviour — the row stays but falls
 * out of every reader — lost the hours and the object's sign-off silently. Deleting a day's hours
 * is the shift window's own action, so the person does it there, consciously, or keeps the day in
 * the term.
 *
 * Both signed and unsigned rows count: a row exists only once a day has been filled (`filled_by`
 * is NOT NULL), and its hours are the record whether signed or not.
 *
 * The caller holds the request row `FOR UPDATE` when it is about to write (step 3 of the canon, or
 * `lockRequestRow` of the wide edit): the shift handlers take the same lock, so no day can be filled
 * between this read and the term write. The term door's preview reads without the lock, as every
 * preview does, and its apply re-asks under it.
 */
export async function assertTermKeepsFilledShifts(
  tx: ShiftsTx,
  params: {
    requestId: string;
    status: RequestStatus;
    termBefore: ShiftTermBounds;
    termAfter: ShiftTermBounds;
  },
): Promise<void> {
  const { requestId, status, termBefore, termAfter } = params;
  // A term that only grows drops nothing, and most edits are that: no read for them.
  const lastBefore = termBefore.dateTo || termBefore.dateFrom;
  const lastAfter = termAfter.dateTo || termAfter.dateFrom;
  if (termAfter.dateFrom <= termBefore.dateFrom && lastAfter >= lastBefore) return;

  const days = await readShiftDays(tx, requestId);
  const dropped = shiftDaysDroppedByTerm(
    termBefore,
    termAfter,
    days.map((day) => day.date),
  );
  if (dropped.length === 0) return;
  const droppedSet = new Set(dropped);
  // The field the person must change: the start when a day falls before it, otherwise the end.
  const field = dropped.some((day) => day < termAfter.dateFrom) ? 'dateFrom' : 'dateTo';
  // In work the shift window can delete the rows; in any other status it is closed (`shiftsBlocker`),
  // and naming it there would send the person to a button that is not offered.
  const way =
    status === 'confirmed'
      ? 'Оставьте эти дни в сроке или сначала удалите их смены в окне смен на вкладке «На объекте» (подписанную — сняв согласование)'
      : `Оставьте эти дни в сроке: смены удаляют только у заявки в статусе «${requestStatusLabels.confirmed}»`;
  throw err.unprocessable(
    `Новый срок выбрасывает дни с заполненными сменами (${dropped
      .map(dateKeyRu)
      .join(', ')}): их часы и подпись объекта выпали бы из учёта заявки. ${way}`,
    { [field]: 'Выбрасывает день с заполненной сменой' },
    {
      blockedShiftDays: days.filter((day) => droppedSet.has(day.date)).map(toAssignmentShiftDay),
    },
  );
}

/**
 * Снять заполненные без подписи смены диапазона; возвращает удалённые даты по возрастанию.
 *
 * ПОЧЕМУ ДИАПАЗОН, А НЕ ЗАЯВКА ЦЕЛИКОМ. `dropRequestShifts` стирает все смены заказа и годится
 * ровно откату в «Новую», где работы больше нет вовсе. Закрытие фактической датой снимает **хвост**
 * за границей факта, а часы внутри факта предъявляются самим фактом выполнения — и общий
 * исполнитель здесь стёр бы отчётную работу заодно с несостоявшейся.
 *
 * ПОЧЕМУ ПОДПИСАННЫЕ ДНИ ИСКЛЮЧЕНЫ УСЛОВИЕМ, А НЕ ТОЛЬКО ПРОВЕРКОЙ ДВЕРИ. Подпись объекта снимает
 * одна коррекция; исполнитель, физически способный удалить подписанный день, однажды это и сделает —
 * дверью, которая забыла спросить `blockedShiftDays`, или гонкой с подписью между предпросмотром и
 * командой. Правило «подписанный день за границей факта — 422, и ни одна строка не удалена»
 * держится дверью, а здесь стоит вторым замком: потеря подписи необратима, а лишний уцелевший день
 * виден и чинится.
 *
 * ПОЧЕМУ ВОЗВРАЩАЮТСЯ ДАТЫ. Вызывающий сверяет их с тем, что показал человеку (`clearedShiftDays`):
 * расхождение означает, что состояние между предпросмотром и командой изменилось, — и молчаливого
 * «удалили не то» не остаётся. Тем же перечнем закрытие пишет в аудит, какие именно дни сняты.
 */
export async function dropUnapprovedShiftsInRange(
  tx: ShiftsTx,
  params: { requestId: string; range: ShiftDayRange },
): Promise<string[]> {
  const { requestId, range } = params;
  const removed = await tx
    .delete(vehicleRequestShifts)
    .where(
      and(
        eq(vehicleRequestShifts.requestId, requestId),
        gte(vehicleRequestShifts.shiftDate, range.from),
        lte(vehicleRequestShifts.shiftDate, range.to),
        isNull(vehicleRequestShifts.approvedAt),
      ),
    )
    .returning({ date: vehicleRequestShifts.shiftDate });
  // `DELETE` не сортирует; порядок задаётся здесь — им же сверяются с планом и пишут в аудит.
  return removed.map((row) => row.date).sort();
}
