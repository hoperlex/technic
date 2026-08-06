/**
 * Выпуск портала: что в нём появилось, словами того, кто в портале работает (ADR 0077). Снаружи
 * берут `@entities/release` — внутренние модули слайса не видны.
 *
 * Прав у сущности нет и не будет: право, закрывающее «что нового в портале», пришлось бы выдать
 * всем — то есть оно не различало бы никого.
 */
export { releasesApi } from './api/releasesApi';
export { releaseKeys } from './api/keys';
export { releasesQuery } from './api/queries';
export { useReleases, type ReleaseNews } from './model/useReleases';
