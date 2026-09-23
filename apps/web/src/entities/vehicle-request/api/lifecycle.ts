import type {
  AssignVehicleBody,
  ChangeVehicleRequestTypeBody,
  CompleteVehicleRequestInput,
  ConfirmScheduleBody,
  CreateVehicleRequestInput,
  RequestHistoryEntryDto,
  RequestStatus,
  UpdateVehicleRequestInput,
  VehicleRequestDriverDto,
  VehicleRequestDto,
  VehicleRequestStatusPreviewDto,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Сама заявка: её карточка и то, как она живёт, — создание, правка, переоформление в другой тип,
 * смена статуса с предпросмотром, виза руководителя строительства, удаление и восстановление.
 *
 * Отделено от дверей (`doors`) предметом: здесь правят саму заявку — её поля, статус, визу и
 * существование, — а там ведут сцепку из срока, бумаги строгой отчётности, решений истории и часов
 * смен. Рукопожатие у здешних ручек соответственно одно: версия заявки, обычная оптимистическая
 * блокировка. Лежи оба порядка вперемешку, они читались бы как один, и следующая ручка попадала бы
 * не в ту половину молча — а замечают такое на экране, а не на типах.
 *
 * Одно исключение названо нарочно, чтобы его не приняли за недосмотр: у смены статуса есть свой
 * предпросмотр и отпечаток последствий — но ровно на одном переходе, откате «Выполнена» → «В
 * работе», и спрашивает его сервер, а не схема. Дверью она от этого не становится: тело у неё
 * статусное, коридор переходов один на все виды заявок, и уехать в `doors` она может только вместе
 * с ними. Закрытие заказа техники на объект туда как раз и уехало — «Выполнена» здесь это закрытие
 * отвергает сама (ADR 0178, см. комментарий у `changeStatus`).
 *
 * `VehicleRequestStatusExtra` экспортируется ради имени в сигнатуре: `changeStatus` уезжает в общий
 * объект спредом, и безымянный тип пришлось бы переписывать в каждом месте, где заявку переводят.
 */

/**
 * Что предъявляется вместе со статусом заявки. Тип один на смену статуса и её предпросмотр
 * намеренно: предпросмотр обязан считать последствия по тем же входам, по которым их потом
 * исполнит боевая ручка, — разойдись эти тела, диалог начал бы обещать не то.
 */
export interface VehicleRequestStatusExtra {
  comment?: string;
  /** Техника и ставки при переводе в работу (ADR 0027). */
  assignment?: AssignVehicleBody;
  /** Фактический срок, о котором договорились при том же переводе. */
  schedule?: ConfirmScheduleBody;
  /** Отработанное время и стоимость при выполнении (ADR 0029). */
  completion?: CompleteVehicleRequestInput;
  /**
   * Отпечаток последствий, показанных предпросмотром. Обязателен на одном переходе — откате
   * «Выполнена» → «В работе» у заказа техники на объект, — и спрашивает его сервер: только он
   * знает, чем эта заявка пойдёт дальше.
   */
  previewFingerprint?: string;
}

export const vehicleRequestLifecycle = {
  /** Контакт водителя защищён правом на путевые листы и поэтому не входит в основной DTO. */
  driver: (id: string) =>
    apiFetch<VehicleRequestDriverDto | null>(`/vehicle-requests/${id}/driver`),
  get: (id: string) => apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0015). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/vehicle-requests/${id}/history`),
  create: (body: CreateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>('/vehicle-requests', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`, { method: 'PATCH', body }),
  /**
   * Переоформить заявку в другой тип (ADR 0091): заказ завели работой на объекте, а нужен рейс —
   * или наоборот. Номер, вложения и история остаются за заявкой; тело — полный состав нового типа,
   * потому что деталь прежнего снимается целиком, а взять её значения новому типу неоткуда.
   */
  changeRequestType: (id: string, body: ChangeVehicleRequestTypeBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/request-type`, { method: 'PATCH', body }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина. Остальное
   * предъявляется вместе со статусом и потому собрано в объект: `assignment` — техника и ставки
   * при переводе в работу (ADR 0027), `schedule` — фактический срок, о котором договорились при
   * том же переводе, `completion` — отработанное время и стоимость при выполнении (ADR 0029).
   * Всё это проводится тем же запросом, что и смена статуса: заявка не бывает «в работе» ни на
   * чём, взятой на одно время с листом на другое и «выполненной» без факта.
   *
   * ЗАКРЫТИЕ ЗАКАЗА ТЕХНИКИ НА ОБЪЕКТ ЭТОЙ РУЧКОЙ БОЛЬШЕ НЕ ПРОХОДИТ (Р1 плана
   * `docs/vehicle-request-actual-end-date-plan.md`, ADR 0178): «Выполнена» у него отвечает 422 и
   * называет правильный вход — окно закрытия, у которого своя дверь (`completion` ниже).
   * Грузоперевозка закрывается здесь по-прежнему: срока работ и недельной бумаги у неё нет, и
   * фактическая дата окончания ей ничего не значит.
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    extra: VehicleRequestStatusExtra = {},
  ) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/status`, {
      method: 'PATCH',
      body: {
        status,
        comment: extra.comment ?? '',
        version,
        ...(extra.assignment ? { assignment: extra.assignment } : {}),
        ...(extra.schedule ? { schedule: extra.schedule } : {}),
        ...(extra.completion ? { completion: extra.completion } : {}),
        ...(extra.previewFingerprint ? { previewFingerprint: extra.previewFingerprint } : {}),
      },
    }),
  /**
   * Последствия перехода до его совершения: каким режимом заявка пойдёт дальше, что сделает сверка
   * ЭСМ-2 и как будет считаться занятость машины. Ничего не пишет.
   *
   * Тело — то же самое, что у смены статуса: план считается по машине, машинисту и сроку, которые
   * приходят из окна назначения, и своя схема разошлась бы с боевой на первом же новом поле.
   * Заведён под откат «Выполнена» → «В работе» — на прочих переходах сервер отвечает 422.
   */
  statusPreview: (
    id: string,
    body: VehicleRequestStatusExtra & { status: RequestStatus; version: number },
  ) =>
    apiFetch<VehicleRequestStatusPreviewDto>(`/vehicle-requests/${id}/status/preview`, {
      method: 'POST',
      body: { ...body, comment: body.comment ?? '' },
    }),
  /** Виза руководителя строительства: `approved: false` — отзыв (ADR 0025). */
  setApproval: (id: string, approved: boolean, version: number) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/approval`, {
      method: 'PATCH',
      body: { approved, version },
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/vehicle-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0070) — только из архива и только администратором. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-requests/${id}/purge`, { method: 'DELETE' }),
};
