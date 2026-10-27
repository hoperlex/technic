/*
 * What the person types, and the idempotency key of a submit attempt. The cabinet's handles, keys
 * and read freshness live in `@entities/driver-cabinet`.
 */

/**
 * Здесь остались только форма введённого и ключ идемпотентности — то, из чего собирается тело
 * запроса. Хранилище черновика уехало в [draftStore.ts](draftStore.ts), и разведены они не по
 * вкусу: у ячейки прежнего формата было два писателя — здешние `saveDraft`/`clearDraft` и вкладка
 * соседней сборки, — и уцелевала последняя запись целиком (Р11б). У нынешнего формата писатель
 * ровно один, и держится это тем, что писать отсюда больше нечем: обеих функций тут нет.
 */

/** Файл, уже загруженный в хранилище и ещё ни к чему не привязанный. */
export interface DraftFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Введённое по одной строке ожидания. Числа хранятся строками, а не числами: черновик обязан
 * пережить «145 3» — недонабранное значение, которое числом не является, но потерять его при
 * сворачивании браузера человек не простит.
 *
 * Вида `no_data` здесь нет: строку без показаний закрывает персонал с причиной (план кабинета,
 * Р4), а у водителя поля, которым можно отписаться от ввода, больше нет. Старые черновики с этими
 * ключами читаются как обычные — лишние поля просто не смотрят.
 */
export interface DraftItem {
  odometerKm: string;
  engineHours: string;
  /**
   * Три числа топлива в порядке смены (ADR 0163): остаток на начало, заправленное за неё, остаток
   * на конец. Порядок полей здесь не оформление — по нему же выстроена форма, и человек заполняет
   * её сверху вниз тем, что у него уже есть: утром — первое, днём — второе, вечером — третье.
   *
   * Записи, сделанные до релиза, этих ключей физически не содержат. Дефолты интерфейса их не
   * добавляют: за это отвечает нормализатор на границе чтения хранилища — без него `undefined`
   * доехал бы до разбора числа и уронил форму.
   */
  fuelStartLiters: string;
  fuelFilledLiters: string;
  fuelEndLiters: string;
  /**
   * The ESM-2 shift pair as typed (ADR 0234): `HH:mm`, or a half-typed «73» the field normalizes on
   * blur — a string for the same reason the numbers are strings. Empty means "not recorded".
   */
  startedAt: string;
  endedAt: string;
  /**
   * Stop times of a route item by stop key (`stopKey`: the live route point id, or the saved stop's
   * position when its point was rebuilt away). By key, not by order: a route rebuilt between typing
   * and sending must not move a typed time onto another stop.
   */
  stops: Record<string, DraftStopTimes>;
  comment: string;
  files: DraftFile[];
  /**
   * Подтверждение аномалии, показанной порталом по прошлой отправке (Р20). Живёт вместе с
   * введённым, а не отдельным состоянием: аномалию показывают над теми же числами, и решение
   * «цифра верная» относится к ним же.
   */
  confirmAnomaly: boolean;
}

/** Times typed at one stop. Only stop 1 has an arrival; its key stays empty elsewhere (D6). */
export interface DraftStopTimes {
  arrivedAt: string;
  departedAt: string;
}

/**
 * Ключ идемпотентности — из общего механизма (`@shared/lib`): пара «ключ + отпечаток тела» стоит
 * теперь у двух ручек портала (ADR 0103 и ADR 0146), и второй генератор рядом с первым различался
 * бы ровно тем, чем различаться не должен, — запасным путём для незащищённого контекста.
 *
 * Здесь он переэкспортирован, а не позван по месту, потому что политика жизни ключа — здешняя:
 * заводится он на попытку отправки, а не на день (Р12а). После слияния веток черновика ключей
 * столько же, сколько веток, а повторить нужно ровно ту пару «ключ + версия», которая ушла на
 * сервер, — держит её `draftStore`, а не эта функция.
 */
export { newIdempotencyKey } from '@shared/lib';
