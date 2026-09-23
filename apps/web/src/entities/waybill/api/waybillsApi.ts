import type { CancelWaybillInput, FileDto, ListResult, WaybillDto } from '@technic/contracts';
import { apiDownload, apiFetch, apiFetchBlob, type Query } from '@shared/api';

/**
 * Журнал учёта путевых листов (ADR 0037). Выдачи здесь нет, и своей ручки «выписать» у журнала не
 * существует: лист рождается там, где собрано то, что в нём печатается, — иначе появился бы бланк
 * строгой отчётности, не привязанный ни к работе, ни к машине.
 *
 * Дверей рождения три, и все они снаружи журнала:
 *
 *   - выписка с собранного рейса — 4-П, отдельное действие человека
 *     (`vehicleRoutesApi.issueWaybill`, `@entities/vehicle-route`);
 *   - перевод заявки в работу и прочие решения по ней: за ними сверка ведёт недельные ЭСМ-2 сама
 *     (`docs/adr/0060-esm2-weekly-waybill.md`), портал их не заказывает;
 *   - выписка недельного ЭСМ-2 по требованию — ею живёт линейный заказ, которому сверка новых
 *     недель не заводит (`vehicleRequestsApi.issueEsm2`, ADR 0100).
 *
 * Журнал выписанное показывает, печатает, аннулирует и подшивает к нему сканы.
 */
export const waybillsApi = {
  list: (q: Query) => apiFetch<ListResult<WaybillDto>>('/waybills', { query: q }),
  get: (id: string) => apiFetch<WaybillDto>(`/waybills/${id}`),
  cancel: (id: string, body: CancelWaybillInput) =>
    apiFetch<WaybillDto>(`/waybills/${id}/cancel`, { method: 'POST', body }),
  /**
   * Выгрузка бланка файлом. Раньше стояла ссылкой на адрес API — и не работала ни разу: маршрут
   * закрыт `app.authenticate`, а переход по `href` браузер делает без заголовка `Authorization`,
   * и вместо xlsx открывалась вкладка с 401 «Требуется авторизация». Вложения заявок так качать
   * можно (там presigned-ссылка на S3), бланк — нет: он собирается на лету.
   */
  exportFile: (id: string, number: string) =>
    apiDownload(`/waybills/${id}/export`, `Путевой лист ${number}.xlsx`),
  /**
   * Бланк, готовый к печати (ADR 0041): PDF показывается фреймом и печатается диалогом браузера,
   * не оседая файлом на машине. Не ссылкой, а телом ответа — фрейму его отдают из памяти вкладки.
   */
  printPdf: (id: string, signal?: AbortSignal) => apiFetchBlob(`/waybills/${id}/print`, { signal }),
  /**
   * Пачка листов одним документом: сервер собирает бланки подряд в один PDF, диалог печати один на
   * всю пачку, порядок задаёт портал. Сигнал отмены обязателен (ADR 0148) — см. `office-pdf.ts`.
   */
  printBatch: (ids: string[], signal?: AbortSignal) =>
    apiFetchBlob('/waybills/print-batch', { method: 'POST', body: { ids }, signal }),
  /**
   * Вложения к бланку: скан заполненного заказчиком оборота ЭСМ-2, отметки 4-П, акт. Файл сначала
   * уезжает в хранилище (`filesApi.upload`), сюда приходит только его идентификатор — тем же
   * порядком, что у вложений заявок.
   */
  attachFiles: (id: string, addFileIds: string[]) =>
    apiFetch<FileDto[]>(`/waybills/${id}/files`, { method: 'POST', body: { addFileIds } }),
  detachFile: (id: string, fileId: string) =>
    apiFetch<FileDto[]>(`/waybills/${id}/files/${fileId}`, { method: 'DELETE' }),
};
