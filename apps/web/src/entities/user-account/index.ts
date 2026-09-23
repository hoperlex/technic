/**
 * Учётная запись портала (ADR 0092, ADR 0102): кто входит, с какой ролью и областью, к какому
 * работнику привязан и что с учёткой можно сделать — завести, поправить, сдать в архив, вернуть
 * оттуда, отказать по заявке на регистрацию. Снаружи берут `@entities/user-account` — внутренние
 * модули слайса не видны, и перестроить его можно, не трогая потребителей.
 *
 * Карточки учётки здесь нет и не будет: `UserAccountDto` живёт в контрактах (ADR 0102), и страницы
 * берут её там же, где берут остальной словарь портала. Отсюда раздаются только те типы, которых
 * в контрактах нет, — тела запроса и кандидаты на привязку.
 */
export { userAccountKeys } from './api/keys';
export { usersApi } from './api/usersApi';
export type {
  DriverPersonBody,
  PersonCandidateDto,
  PersonCandidateMatch,
  RestoreUserBody,
  UserAccountMutationResult,
} from './api/usersApi';
