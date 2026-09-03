import type {
  ModuleMailEvent,
  ModuleMailEventSettingDto,
  UpdateModuleMailEventSettingBody,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Соседний путь с адресатами копий (`/admin/mail/recipients`), а не свой префикс: настройки одного
 * модуля живут одним плагином, и второй адрес развёл бы их по двум местам без всякой причины.
 */
const PATH = '/admin/mail/events';

/**
 * Рубильники событий: уходит ли письмо по событию вообще (план
 * `docs/office-equipment-mail-expansion-plan.md`, §5.1).
 *
 * Отдельный клиент рядом с `moduleMailApi`, а не его метод: адресаты и рубильники — разные ручки
 * над разными таблицами, и пути у них соседние, но разные. Свести их в один объект значило бы
 * завести общий `PATH`, которого нет.
 *
 * Заведения и удаления здесь нет намеренно: строка рубильника появляется миграцией вместе с
 * событием и живёт, пока событие есть в реестре. Кнопка «добавить рубильник» означала бы, что
 * реестр событий редактируется из портала, — а он закрыт `Record` в контрактах.
 */
export const moduleMailEventsApi = {
  list: () => apiFetch<ModuleMailEventSettingDto[]>(PATH),
  /**
   * Ключ строки — само событие: второго рубильника у события не бывает, поэтому и `id` ей не нужен.
   * Правка уходит с `version`: несовпавшая версия — 409, рубильником уже щёлкнули в другом окне.
   */
  update: (event: ModuleMailEvent, body: UpdateModuleMailEventSettingBody) =>
    apiFetch<ModuleMailEventSettingDto>(`${PATH}/${event}`, { method: 'PATCH', body }),
};
