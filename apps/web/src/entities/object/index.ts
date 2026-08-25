/**
 * Объект строительства: площадка, на которую заказывают технику и вывоз мусора. Снаружи берут
 * `@entities/object` — внутренние модули слайса не видны, и перестроить его можно, не трогая
 * потребителей.
 */
export { objectsApi } from './api/objectsApi';
export { objectKeys } from './api/keys';
export { objectAddressOptionsQuery, objectOptionsQuery } from './api/queries';
export { objectFilterOptionLabel } from './model/optionLabel';
