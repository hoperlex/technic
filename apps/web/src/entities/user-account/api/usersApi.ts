import type {
  ChangeEmailResult,
  ChangeUserEmailBody,
  CreateUserBody,
  ListResult,
  RejectUserBody,
  RejectUserResult,
  UpdateUserBody,
  UserAccountDto,
  UserMutationResult,
  UserPersonRefDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Ручки учётных записей (ADR 0092, ADR 0102): заведение и правка учётки, привязка работника,
 * архив и возврат из него, отказ по нерассмотренной заявке, смена адреса-логина.
 *
 * Учётка — не такой же справочник, как типы ТС: у неё своя пачка тел запроса, и каждое из них
 * описано здесь же, рядом со своей ручкой. В контрактах этих тел нет, ни одно их поле не читается
 * никем, кроме ручки и формы, которая её зовёт, а порознь тело и ручка разошлись бы молча —
 * компилятор смолчал бы, а сервер ответил бы отказом на экране.
 *
 * Карточка учётки (`UserAccountDto`) и ссылка на её работника (`UserPersonRefDto`) отсюда не
 * раздаются: они живут в контрактах (ADR 0102), и страницы берут их оттуда напрямую. Реэкспорт,
 * который вёл эти типы вторым адресом, при переезде в слайс снят — половина экранов уже
 * спрашивала их у контрактов, и две двери к одному описанию расходятся при первой же правке
 * импортов.
 */

/** Чем кандидат совпал с заявкой (Р30): точный номер и адрес надёжнее похожего ФИО. */
export type PersonCandidateMatch = 'phone' | 'email' | 'name';

/**
 * Кандидат на привязку. Должность — не украшение: однофамильцев в справочнике различают по ней и
 * по телефону, а идентификатора администратор не знает.
 */
export interface PersonCandidateDto extends Omit<UserPersonRefDto, 'deletedAt'> {
  jobTitle: string;
  matchedBy: PersonCandidateMatch[];
}

/**
 * Работник в теле запроса. `null` снимает связь, отсутствие поля её не трогает — различать
 * обязательно: отвязки живой учётки водителя не бывает (Р6), и «поле не прислали» не должно
 * читаться как «отвяжите».
 */
export interface DriverPersonBody {
  personId?: string | null;
  /** Подтверждение расхождения ФИО (Р30): «это один человек», факт уходит в аудит. */
  confirmNameMismatch?: boolean;
}

/** Восстановление из архива (Р8): у водителя без работника оно требует выбрать человека. */
export interface RestoreUserBody {
  personId?: string;
  confirmNameMismatch?: boolean;
}

/** Исход мутации учётки вместе с карточкой: письмо о доступе уходит не всякий раз. */
export interface UserAccountMutationResult extends Omit<UserMutationResult, 'user'> {
  user: UserAccountDto;
}

export const usersApi = {
  list: (q: Query) => apiFetch<ListResult<UserAccountDto>>('/users', { query: q }),
  /**
   * Карточка одной учётки — для панели пути в журнале изменений (ADR 0109): она показывает, чем
   * учётка стала к сегодняшнему дню. Списком её не заменить: путь спрашивают и у архивной учётки,
   * которой в списке по умолчанию нет.
   */
  get: (id: string) => apiFetch<{ user: UserAccountDto }>(`/users/${id}`),
  /**
   * Заведение и правка учётки отвечают не голой карточкой, а карточкой с исходом письма о выданном
   * доступе: письмо уходит не всякий раз, и портал обязан сказать, ушло ли оно.
   */
  create: (body: CreateUserBody & DriverPersonBody) =>
    apiFetch<UserAccountMutationResult>('/users', { method: 'POST', body }),
  update: (id: string, body: UpdateUserBody & DriverPersonBody) =>
    apiFetch<UserAccountMutationResult>(`/users/${id}`, { method: 'PATCH', body }),
  setPassword: (id: string, newPassword: string) =>
    apiFetch<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
  /**
   * Смена адреса — он же логин (ADR 0092). Ответ говорит про оба письма отдельно: сообщить
   * человеку новый адрес и предупредить прежний ящик — разные новости, и одна из них может не
   * уйти. `shadowsArchived` предупреждает, что адрес принадлежал архивной учётке и восстановить
   * её теперь нельзя.
   */
  changeEmail: (id: string, body: ChangeUserEmailBody) =>
    apiFetch<ChangeEmailResult>(`/users/${id}/email`, { method: 'POST', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  /**
   * Отказ по нерассмотренной заявке на регистрацию. Причин две, и они не дублируют друг друга:
   * `reason` уходит в аудит и заявителю не показывается, `applicantMessage` — это и есть письмо,
   * которое он прочитает. Уйдёт ли оно, говорит `notified`: почта бывает выключена, а отметку об
   * отправке — снята.
   */
  reject: (id: string, body: RejectUserBody) =>
    apiFetch<RejectUserResult>(`/users/${id}/reject`, { method: 'POST', body }),
  /**
   * Возврат из архива (ADR 0063): учётка остаётся неактивной, отказ снова становится заявкой.
   *
   * Тело — только у водителя без работника (Р8): архивная учётка `person_id` иметь не обязана, а
   * живая обязана, и человек ставится той же транзакцией, что и снятие признака архива.
   */
  restore: (id: string, body?: RestoreUserBody) =>
    apiFetch<UserAccountDto>(`/users/${id}/restore`, { method: 'POST', body: body ?? {} }),
  /**
   * Кандидаты на привязку к учётке водителя (Р30). Без `query` подсказка идёт по приметам самой
   * заявки — телефону, адресу и ФИО; занятые работники в неё не попадают.
   */
  personCandidates: (q: { query?: string; userId?: string }) =>
    apiFetch<{ items: PersonCandidateDto[] }>('/users/person-candidates', { query: q }),
  /** Удаление насовсем (ADR 0063) — только из архива и только администратором. */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/users/${id}/purge`, { method: 'DELETE' }),
  pendingCount: () => apiFetch<{ count: number }>('/users/pending-count'),
};
