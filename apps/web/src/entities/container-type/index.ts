/**
 * Тип контейнера/машины вывоза — предмет заявки на контейнерную операцию и одна из осей прайса.
 * Снаружи берут `@entities/container-type`: внутренние модули слайса не видны, и перестроить его
 * можно, не трогая потребителей.
 */
export { containerTypesApi } from './api/containerTypesApi';
export { containerTypeKeys } from './api/keys';
export { containerTypeOptionsQuery } from './api/queries';
