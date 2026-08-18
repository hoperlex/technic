/**
 * Руководство пользователя — строка со ссылкой на документ во внешнем хранилище
 * (`docs/manuals-plan.md`). Снаружи берут `@entities/manual`: внутренние модули слайса не видны, и
 * перестроить его можно, не трогая потребителей.
 */
export { manualsApi } from './api/manualsApi';
export { manualKeys } from './api/keys';
export { activeManualsQuery } from './api/queries';
