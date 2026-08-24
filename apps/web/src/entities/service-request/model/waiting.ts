import {
  type AccessSubject,
  isServiceRequestClosed,
  isWaitingOn,
  type ServiceRequestDto,
  serviceStepLabelFor,
  serviceWaitingOnLabels,
} from '@technic/contracts';
import { isAwaitingDocuments } from './documents';

/**
 * Возраст ожидания и подпись состояния — то, чем список заявок на обслуживание отличается от
 * соседних модулей (Р36). Заявка здесь не «висит вообще», а висит **в текущем статусе**: три
 * стороны передают её друг другу, и вопрос «кто тянет» — это вопрос «сколько дней заявка стоит
 * там, где стоит», а не «сколько прошло с заведения».
 *
 * Считается по `statusChangedAt`, который сервер обновляет и при переназначении исполнителя без
 * смены статуса: новый сервис не наследует чужое ожидание.
 */

const DAY = 86_400_000;

/** Сколько полных суток заявка стоит в текущем статусе. */
export function statusAgeDays(statusChangedAt: string, now: Date = new Date()): number {
  const at = Date.parse(statusChangedAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY));
}

/**
 * Возраст словами: «сегодня», «3 дня», «12 дней». Русское склонение — 1 день, 2–4 дня, 5–20
 * дней; 11–14 всегда «дней».
 */
export function statusAgeLabel(statusChangedAt: string, now: Date = new Date()): string {
  const days = statusAgeDays(statusChangedAt, now);
  if (days === 0) return 'сегодня';
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'дней'
      : last === 1
        ? 'день'
        : last >= 2 && last <= 4
          ? 'дня'
          : 'дней';
  return `${days} ${form}`;
}

/** Вторая строка столбца состояния: что написать и чьим это выглядит — своим или чужим. */
export interface ServiceStatusLine {
  text: string;
  /** Ход за смотрящим: строка заметная и, где есть куда вести, кликабельная (Р117). */
  mine: boolean;
}

/**
 * Подпись состояния заявки — вторая строка объединённого столбца «Статус» (Р100, §4 плана).
 *
 * Одна функция на три прежних вопроса («где заявка», «кого ждут», «что требуется от меня»):
 * лицо здесь меняет подписи только префикс, а сам шаг берётся из `serviceStepLabels` — единого
 * словаря контрактов (Р101). Двумя словарями это и разъезжалось: прежний `serviceTodoLabel` знал
 * три статуса из девяти и про заморозку не узнал бы вовсе.
 *
 * Учётка приходит параметром, а не берётся из портала: слой сущностей не знает ни `useAuth`, ни
 * правил доступа — сторону считает `isWaitingOn` контрактов, одинаково на портале и на сервере.
 *
 * `null` — в столбце прочерк: у принятой и отменённой заявки хода нет и ждать в них нечего.
 */
export function serviceStatusLine(
  request: Pick<
    ServiceRequestDto,
    'status' | 'waitingOn' | 'holdReason' | 'files' | 'kind' | 'service'
  >,
  subject: AccessSubject | null | undefined,
): ServiceStatusLine | null {
  if (isServiceRequestClosed(request.status)) return null;

  // Заморозку не ждёт никто (Р111): подпись у неё одна на всех и объясняет остановку причиной —
  // «Отложена» без неё сообщала бы факт, не отвечая, чего ждать и сколько (Р107).
  if (request.status === 'on_hold') {
    return {
      text: request.holdReason ? `Отложена: ${request.holdReason}` : 'Отложена',
      mine: false,
    };
  }

  const mine = isWaitingOn(subject, request.waitingOn);

  /*
   * Предъявленная работа без единой закрывающей бумаги — это и есть очередь «Ожидаются документы»,
   * видимая прямо в столбце (Р112, Р114).
   *
   * Спрашивается **тот же предикат**, что у вкладки документов и у сервера (`isAwaitingDocuments`
   * → `serviceRequestNeedsClosingDocument`), а не один статус: после Н8 бумага обязательна только
   * сервисному ремонту, и «Ждёт документов» у заявки на картриджи или у инхаус-ремонта — подпись
   * про обязанность, которой нет. Столбец и вкладка обязаны отвечать одно и то же.
   */
  if (isAwaitingDocuments(request)) {
    return mine
      ? { text: 'Вам: нужен закрывающий документ', mine: true }
      : { text: 'Ждёт документов', mine: false };
  }

  /*
   * Подпись «Вам: …» берётся по паре «статус + кого ждут», а не по одному статусу (волна В6). В
   * «Смете на согласовании» сторон две: сперва виза ИТ, потом деньги, — и `waitingOn` их различает,
   * потому что сервер считает его по строке заявки (`serviceRequestWaitingOn`), сверяя ревизию
   * подписи с текущей. Подпись по статусу звала бы согласующего от ИТ «согласовать смету», то есть
   * не туда: сумму подписывает «Ведение».
   *
   * Чужой ход подписан стороной (`serviceWaitingOnLabels`) — там шаг называть незачем: смотрящему
   * важно, кого ждут, а не что именно тот сделает.
   */
  return mine
    ? { text: `Вам: ${serviceStepLabelFor(request.status, request.waitingOn)}`, mine: true }
    : { text: serviceWaitingOnLabels[request.waitingOn], mine: false };
}
