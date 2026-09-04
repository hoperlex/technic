import type {
  ConfirmOfficeEquipmentCandidateInput,
  MergeOfficeEquipmentCandidateInput,
  OfficeEquipmentCandidateDto,
  RejectOfficeEquipmentCandidateInput,
  UpdateOfficeEquipmentCandidateInput,
} from '@technic/contracts';
import { apiFetch, createGetApi, createListApi } from '@shared/api';

const PATH = '/office-equipment-candidates';

/**
 * Сообщения о технике, которой нет в справочнике (план кандидата, §8).
 *
 * `createWriteApi` здесь НЕ разворачивается, и это не экономия: заведения у кандидата нет вовсе —
 * он рождается вместе с заявкой одним `POST /service-requests` (Р2). Фабрика дала бы `create`,
 * который компилируется и всегда отвечает 404, то есть ошибку, обнаруживаемую на экране.
 *
 * Правка — `PATCH` с полным набором шести реквизитов и `expectedVersion`: поля присылаются целиком,
 * потому что «стереть комментарий» и «не трогать комментарий» частичным телом не различить.
 *
 * Три решения — тремя явными ручками, а не одной с полем «исход». Это слова портала, а не HTTP, и
 * тела у них разные по существу: подтверждение несёт полную форму карточки парка, объединение —
 * идентификатор существующей единицы, отказ — причину. Общая ручка приняла бы любую комбинацию
 * этих полей и разбиралась бы с ней на сервере.
 *
 * Все три возвращают свежий DTO кандидата — тот же, что придёт и в 409: окно после решения
 * показывает состояние, а не догадку о нём.
 */
export const officeEquipmentCandidatesApi = {
  ...createListApi<OfficeEquipmentCandidateDto>(PATH),
  ...createGetApi<OfficeEquipmentCandidateDto>(PATH),
  update: (id: string, body: UpdateOfficeEquipmentCandidateInput) =>
    apiFetch<OfficeEquipmentCandidateDto>(`${PATH}/${id}`, { method: 'PATCH', body }),
  /** «Завести карточку»: по сообщению заводится единица парка (Р13). */
  confirm: (id: string, body: ConfirmOfficeEquipmentCandidateInput) =>
    apiFetch<OfficeEquipmentCandidateDto>(`${PATH}/${id}/confirm`, { method: 'POST', body }),
  /** «Это уже заведённый аппарат»: кандидат объединяется с существующей карточкой (Р15). */
  merge: (id: string, body: MergeOfficeEquipmentCandidateInput) =>
    apiFetch<OfficeEquipmentCandidateDto>(`${PATH}/${id}/merge`, { method: 'POST', body }),
  /** «Отклонить» с причиной, которую дословно прочитает заявитель (Р15). */
  reject: (id: string, body: RejectOfficeEquipmentCandidateInput) =>
    apiFetch<OfficeEquipmentCandidateDto>(`${PATH}/${id}/reject`, { method: 'POST', body }),
};
