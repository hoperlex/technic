/**
 * Публичный вход сегмента запросов: снаружи берут `@shared/api`, а не отдельные модули внутри.
 * Так линт границ отличает «слой пользуется тем, что ему разрешено» от «кто-то залез внутрь».
 */
export { createQueryKeys } from './createQueryKeys';
export type { QueryKeyDefinitions, QueryKeys } from './createQueryKeys';
export * from './http';
export * from './resource';
export * from './session';
export * from './dadata';
