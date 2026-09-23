import type {
  CreateDriverBody,
  CredentialTypeCode,
  DriverDto,
  DriverJobTitleDto,
  DriverLicenseBody,
  DriverRemovalInput,
  DriverSelectionDto,
  ListResult,
  MachinistSelectionDto,
  RevokeDriverLicenseInput,
  UpdateDriverInput,
  VerifyDriverLicenseBody,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Справочник водителей (ADR 0037). Отдельно от справочников не только маршрутом, но и правом:
 * в карточке персональные данные, и открыта она не всем, кому доступен список типов ТС.
 *
 * Двери «карточка по идентификатору» здесь нет намеренно: карточку правит единственный экран —
 * вкладка справочника, — и строку он держит из уже загруженного списка. Запрос на одну карточку
 * завёл бы вторую ячейку кэша с теми же персональными данными, гасить её пришлось бы отдельно от
 * списка, и разойтись с таблицей она могла бы молча.
 */
export const driversApi = {
  list: (q: Query) => apiFetch<ListResult<DriverDto>>('/drivers', { query: q }),
  create: (body: CreateDriverBody) => apiFetch<DriverDto>('/drivers', { method: 'POST', body }),
  update: (id: string, body: UpdateDriverInput) =>
    apiFetch<DriverDto>(`/drivers/${id}`, { method: 'PATCH', body }),
  /**
   * Снять карточку. Тело обязательно, когда портал уже показал перечень последствий: сервер
   * отвечает `409 driver_removal_ack_required` и ждёт отпечаток **того самого** перечня
   * (план `machinist-card-removal`, Э2). Карточка без связей снимается без тела, как и раньше.
   */
  remove: (id: string, body?: DriverRemovalInput) =>
    apiFetch<void>(`/drivers/${id}`, { method: 'DELETE', ...(body ? { body } : {}) }),
  /** Удаление насовсем из архива (ADR 0060): вместе с человеком уходят его документы и сканы. */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/drivers/${id}/purge`, { method: 'DELETE' }),
  addLicense: (id: string, body: DriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses`, { method: 'POST', body }),
  verifyLicense: (id: string, licenseId: string, body: VerifyDriverLicenseBody) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/verify`, { method: 'POST', body }),
  revokeLicense: (id: string, licenseId: string, body: RevokeDriverLicenseInput) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}/revoke`, { method: 'POST', body }),
  /**
   * Убрать документ из карточки (право `records.purge`): не учётное действие, а исправление —
   * аннулирование для «перестал действовать», это для «его тут быть не должно».
   */
  deleteLicense: (id: string, licenseId: string) =>
    apiFetch<DriverDto>(`/drivers/${id}/licenses/${licenseId}`, { method: 'DELETE' }),
  /**
   * Категории одного вида документа для формы: справочник наполнен миграцией и на чтение. Вид —
   * обязательным параметром (ADR 0095): «C» водительского и «C» тракториста это разные машины, и
   * общий список молча предложил бы приписать документу чужую букву.
   */
  licenseCategories: (type: CredentialTypeCode) =>
    apiFetch<{ id: string; code: string; name: string; description: string }[]>(
      '/drivers/license-categories',
      { query: { type } },
    ),
  /**
   * Должности справочника с числом людей — значения фильтра. Списком с сервера, а не константой:
   * должность приходит из кадров свободным текстом, и перечислить её наперёд портал не может.
   */
  jobTitles: () => apiFetch<DriverJobTitleDto[]>('/drivers/job-titles'),
  /**
   * Кого предложить машинистом листа ЭСМ-2 на эти периоды (Э6). Периодов бывает два — неделя на
   * стыке месяцев режется на два бланка, — и отбор отвечает пересечением: человек, годный только
   * одному, выписку развалил бы целиком.
   */
  machinists: (periods: readonly { from: string; to: string }[]) =>
    apiFetch<MachinistSelectionDto>('/drivers/machinists', {
      query: { periods: periods.map((p) => `${p.from}..${p.to}`).join(',') },
    }),
  /** Кто может сесть за эту машину в эту дату — список выбора при переводе заявки в работу. */
  available: (q: { vehicleId: string; on: string; withTrailer?: boolean }) =>
    apiFetch<DriverSelectionDto>('/drivers/available', {
      query: { ...q, withTrailer: q.withTrailer ? 'true' : undefined },
    }),
};
