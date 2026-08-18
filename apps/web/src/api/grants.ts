import type {
  AssignGrantInput,
  CreateGrantInput,
  GrantAssignmentPreviewInput,
  GrantAssignmentResultDto,
  GrantCardDto,
  GrantDto,
  GrantImpactDto,
  GrantUpdatePreviewInput,
  ListResult,
  UpdateGrantInput,
} from '@technic/contracts';
import { apiFetch, createQueryKeys } from '@shared/api';

/**
 * Ручки назначаемых полномочий (ADR 0106): каталог наборов, их выдача учётке и предпросмотр
 * последствий.
 *
 * Домен отделён от реестра ресурсов, потому что связан внутри себя жёстче, чем с чем-либо снаружи:
 * ключи кэша, обе ручки предпросмотра и обе боевые операции держатся одного правила — правка идёт
 * только с отпечатком того расчёта, который показали человеку. Правило это неочевидное, и
 * объяснено оно ровно один раз, здесь; разложенное по чужим соседям, оно объяснялось бы в каждом
 * втором комментарии заново.
 *
 * Адрес выдачи при этом принадлежит учётке (`/users/:id/grants`), а не каталогу, — и это тоже
 * причина держать оба конца рядом: разъедься они по файлам, вторая половина домена читалась бы как
 * чужая ручка учёток.
 *
 * Импорт через `api/resources` остаётся рабочим: реестр реэкспортирует всё, что здесь объявлено.
 */

/** Строка запроса: набор ключей у каждой ручки свой, общего в них — только форма. */
type Query = Record<string, unknown>;

/**
 * Ключи каталога полномочий. Карточка отдельным семейством от списка: реестр выдач перечитывается
 * после каждой выдачи и отзыва, а каталог — только когда меняется состав или число держателей, и
 * гасить его целиком ради одной строки реестра незачем. Корень при этом накрывает и то, и другое:
 * правка набора меняет обе выборки сразу.
 */
export const grantKeys = createQueryKeys('grants', {
  list: (params: Query) => ['list', params],
  card: (id: string) => ['card', id],
});

/**
 * Каталог назначаемых полномочий (ADR 0106, этап 3; план §12) — именованные наборы прав, которые
 * выдаются учётке поверх её роли.
 *
 * Предпросмотр стоит рядом с правкой, а не спрятан в неё: он отвечает на «кого это затронет и что у
 * них изменится» до нажатия и выдаёт `expectedImpactHash` — отпечаток того, из чего расчёт посчитан.
 * Правка без отпечатка невозможна по схеме сервера, и это не формальность: между показом
 * предпросмотра и сохранением набор могли выдать ещё одному человеку либо сменить роль держателю, и
 * тогда применится не то, что подтверждали (решение 7).
 */
export const grantsApi = {
  list: (q: Query) => apiFetch<ListResult<GrantDto>>('/grants', { query: q }),
  /** Карточка вместе с реестром выдач: кому выдано, кем, когда и на чём. */
  get: (id: string) => apiFetch<GrantCardDto>(`/grants/${id}`),
  create: (body: CreateGrantInput) => apiFetch<GrantCardDto>('/grants', { method: 'POST', body }),
  /**
   * Что даст правка: дельта по каждому держателю, нарушения барьеров **в теле** и отпечаток.
   * Нарушения приходят ответом, а не отказом, — иначе экран потерял бы разом и дельту, и причину.
   */
  preview: (id: string, body: GrantUpdatePreviewInput) =>
    apiFetch<GrantImpactDto>(`/grants/${id}/preview`, { method: 'POST', body }),
  update: (id: string, body: UpdateGrantInput) =>
    apiFetch<GrantCardDto>(`/grants/${id}`, { method: 'PATCH', body }),
  /** Мягкое удаление: выданный набор сервер не отдаёт (409) — сначала отзыв выдач. */
  remove: (id: string) =>
    apiFetch<{ id: string; deleted: boolean }>(`/grants/${id}`, { method: 'DELETE' }),
};

/**
 * Выдача и отзыв набора учётке. Адрес — учётки, а не каталога: цель операции она, ей поднимается
 * `authVersion`, на неё пишется журнал. Отпечаток предъявляют обе операции, и у отзыва он уходит
 * строкой запроса: тело у `DELETE` доходит не через каждый прокси, а подтверждение обязано доходить
 * всегда.
 */
export const userGrantsApi = {
  preview: (userId: string, body: GrantAssignmentPreviewInput) =>
    apiFetch<GrantImpactDto>(`/users/${userId}/grants/preview`, { method: 'POST', body }),
  assign: (userId: string, body: AssignGrantInput) =>
    apiFetch<GrantAssignmentResultDto>(`/users/${userId}/grants`, { method: 'POST', body }),
  revoke: (userId: string, grantId: string, expectedImpactHash: string) =>
    apiFetch<GrantAssignmentResultDto>(`/users/${userId}/grants/${grantId}`, {
      method: 'DELETE',
      query: { expectedImpactHash },
    }),
};
