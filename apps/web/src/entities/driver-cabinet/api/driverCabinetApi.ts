import {
  DRIVER_DRAFT_FORMAT,
  DRIVER_DRAFT_FORMAT_HEADER,
  type DriverAssignmentDto,
  type DriverReportDto,
  type ReportSubmitBody,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Запросы кабинета водителя (ADR 0102, ADR 0103).
 *
 * Кабинет — второй контур портала: у роли `driver` нет ни одного права основного портала, поэтому
 * своих справочников он не спрашивает вовсе — все подписи приходят готовыми в задании. Отсюда
 * четыре ручки и ни одной больше.
 *
 * `personId` в запросах не встречается намеренно: область видимости роли — «свой человек», и
 * держится она не предикатом, а отсутствием параметра — сервер берёт человека из принципала.
 */
export const driverCabinetApi = {
  assignment: (date: string) =>
    apiFetch<DriverAssignmentDto>('/driver/assignment', { query: { date } }),
  /** Отчёта может не быть вовсе: день, за который ещё не открывали оверлей, — законное состояние. */
  report: (date: string) => apiFetch<DriverReportDto | null>(`/driver/reports/${date}`),
  /**
   * Открытие отчёта: сервер заводит черновик и строки ожидания по источникам дня и возвращает их
   * с идентификаторами. До этого записывать некуда — `itemId` появляется только здесь.
   *
   * Формат черновика объявляется заголовком (Р13): ключи записей черновика рождаются из `itemId`,
   * а `itemId` приходит только отсюда. Сборке, не умеющей нынешний формат, сервер отвечает отказом
   * `client_outdated` — так поток новых записей прежнего формата и прекращается. Submit declares
   * it as well (below).
   */
  open: (date: string) =>
    apiFetch<DriverReportDto>(`/driver/reports/${date}/open`, {
      method: 'POST',
      headers: { [DRIVER_DRAFT_FORMAT_HEADER]: DRIVER_DRAFT_FORMAT },
    }),
  /**
   * Отправка. Ключ идемпотентности — заголовком: плохая связь не должна порождать ни дублей, ни
   * потерянных отправок, а повтор того же ключа с другим телом сервер обязан отличить от повтора
   * той же попытки (Р25).
   *
   * The draft format goes here too (ADR 0234): the server compares it with the report's STORED
   * format after the idempotency lookup, and refuses a `v3` report to a build that declares nothing
   * — that build knows no shift times and would submit a day without them.
   */
  submit: (date: string, body: ReportSubmitBody, idempotencyKey: string) =>
    apiFetch<DriverReportDto>(`/driver/reports/${date}/submit`, {
      method: 'POST',
      body,
      headers: {
        'Idempotency-Key': idempotencyKey,
        [DRIVER_DRAFT_FORMAT_HEADER]: DRIVER_DRAFT_FORMAT,
      },
    }),
};
