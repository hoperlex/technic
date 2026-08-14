import type {
  CreateModuleMailRecipientBody,
  ModuleMailRecipientDto,
  UpdateModuleMailRecipientBody,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

const PATH = '/admin/mail/recipients';

/**
 * Служебные адресаты писем модулей: на какой ящик уходит письмо по событию (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р64).
 *
 * Фабрики списка здесь нет намеренно: `createListApi` отдаёт страницу с `total` и `page`, а строк
 * настройки единицы — вкладку открывают, чтобы увидеть их все разом. Страничный ответ пришлось бы
 * разворачивать на каждом экране, притом что второй страницы у него не бывает.
 */
export const moduleMailApi = {
  list: () => apiFetch<ModuleMailRecipientDto[]>(PATH),
  create: (body: CreateModuleMailRecipientBody) =>
    apiFetch<ModuleMailRecipientDto>(PATH, { method: 'POST', body }),
  /** Правка уходит целиком и вместе с `version`: несовпавшая версия — 409, строку успели изменить. */
  update: (id: string, body: UpdateModuleMailRecipientBody) =>
    apiFetch<ModuleMailRecipientDto>(`${PATH}/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<void>(`${PATH}/${id}`, { method: 'DELETE' }),
};
