import { z } from 'zod';
import { dateOnlySchema } from './common';

/**
 * Кабинет водителя (ADR 0102): задание работника на дату и передача показаний.
 *
 * Второй контур портала. Учётка роли `driver` не имеет ни одного права основного портала —
 * включая `directories.read`, который есть у всех остальных ролей, — и отсюда главное свойство
 * этих типов: **все подписи приходят готовыми**. Идентификаторов типов ТС, контрагентов и
 * объектов кабинет не знает и знать не должен; он рисует строки, собранные сервером.
 *
 * Второе свойство, столь же существенное: **`personId` в запросах кабинета не встречается**.
 * Область видимости роли — четвёртая ось «свой человек», и она держится не предикатом, а
 * отсутствием параметра: сервер берёт человека из принципала, и проверять нечего.
 */

// ── Окна дат ──

/**
 * Чтение задания шире записи показаний, и это не удобство, а граница области: без верхней
 * границы кабинет становится выгрузкой всей истории поездок человека, а планы на месяц вперёд
 * водителю показывать незачем — их ещё правят.
 */
export const DRIVER_ASSIGNMENT_PAST_DAYS = 30;
export const DRIVER_ASSIGNMENT_FUTURE_DAYS = 14;

/**
 * Окно записи — восемь дней, считая сегодняшний: столько нужно, чтобы закрыть всю прошедшую
 * неделю самому («в пятницу вспомнил, что не сдавал с понедельника»). Будущее закрыто вовсе:
 * показание счётчика, которого ещё не сняли, — это не данные.
 */
export const DRIVER_SUBMIT_PAST_DAYS = 7;

/** Персонал вносит показания за водителя в пределах окна чтения прошлого (ADR 0103). */
export const STAFF_SUBMIT_PAST_DAYS = DRIVER_ASSIGNMENT_PAST_DAYS;

// ── Состав задания ──

/**
 * Чем задан выезд: рейсом или недельным листом ЭСМ-2. Третьего не бывает — у 4-П и формы № 3
 * источник сам ссылается на рейс (`waybills_form_source_check`), и лист таких форм отдельной
 * карточки не даёт: его выезд уже представлен рейсом.
 */
export const READING_SOURCE_KINDS = ['route', 'esm2'] as const;
export type ReadingSourceKind = (typeof READING_SOURCE_KINDS)[number];
export const readingSourceKindSchema = z.enum(READING_SOURCE_KINDS);

/** Контакт по заявке: кому звонить и где этого человека ждать. */
export interface DriverAssignmentContact {
  label: string;
  name: string;
  phone: string;
}

/** Одна заявка в составе рейса — то же, что печатается в письме с заданием. */
export interface DriverAssignmentRequest {
  displayNumber: string;
  customerName: string;
  loadingLocation: string;
  unloadingLocation: string;
  /** «08:30» или пусто, если у заявки время не задано: тогда значима только дата. */
  time: string;
  cargoLabel: string;
  comment: string;
  contacts: DriverAssignmentContact[];
}

/**
 * Строка задания — она же будущая строка ожидания показаний (`itemId`, ADR 0103).
 *
 * `itemId` появляется только после открытия отчёта (`POST /driver/reports/:date/open`): до этого
 * строка описывает задание, но записывать в неё нечего.
 */
export interface DriverAssignmentEntry {
  sourceKind: ReadingSourceKind;
  /** Идентификатор источника: рейса или листа. Нужен серверу, портал им ничего не решает. */
  sourceId: string;
  /** `Р-142` у рейса, `4-П № 000123` у листа — подпись, готовая к показу. */
  sourceLabel: string;
  /** Зачем этот выезд: «Грузоперевозка», «Перегон техники», «Работа на объекте». */
  purposeLabel: string;
  vehicleLabel: string;
  garageNumber: string;
  trailerLabel: string;
  /** Строка ожидания показаний, если отчёт дня уже открыт. */
  itemId: string | null;
  /** Позиция смены в дне машины (ADR 0103): по ней идёт порядок показаний. */
  shiftOrder: number | null;
  /** Состав рейса; у перегона и листа пуст. */
  requests: DriverAssignmentRequest[];
  /** Перегон: откуда и куда едет техника. */
  moveFrom: string;
  moveTo: string;
  /** Комментарий диспетчера — то, что он написал водителю, а не заказчику. */
  comment: string;
  /**
   * Предыдущий снимок счётчиков этой машины. `null` — начало ряда: показаний по машине ещё не
   * сдавали, и сравнивать не с чем.
   *
   * Едет в задание ради подписи под полем и предупреждений во время ввода: водитель сверяет два
   * числа глазами ДО отправки, а не узнаёт об аномалии из ответа сервера. Аномалии при этом
   * никуда не деваются — сервер по-прежнему решает сам (ADR 0103, Р20); здесь подсказка, а не
   * второе правило.
   */
  previous: DriverPreviousReading | null;
}

/** Снимок счётчиков, с которым водитель сверяет свой ввод. */
export interface DriverPreviousReading {
  odometerKm: number | null;
  engineHours: number | null;
  /** День, за который сняли предыдущее показание: «предыдущее: 145 320 (10.08)». */
  measuredOn: string;
  /** Сколько суток прошло — по нему масштабируется порог невероятного прироста. */
  daysAgo: number;
}

/** Задание работника на дату. Пустой список — законное состояние экрана. */
export interface DriverAssignmentDto {
  date: string;
  /** Можно ли передавать показания за этот день (окно записи). */
  canSubmit: boolean;
  entries: DriverAssignmentEntry[];
}

export const driverAssignmentQuerySchema = z.object({ date: dateOnlySchema.optional() }).strict();
export type DriverAssignmentQuery = z.infer<typeof driverAssignmentQuerySchema>;
