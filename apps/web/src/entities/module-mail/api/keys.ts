import { createQueryKeys } from '@shared/api';

/**
 * Ключи служебных адресатов писем (план `docs/office-equipment-mail-and-history-plan.md`, Р64).
 *
 * Семейство одно: список приходит целиком — строк здесь единицы, и вкладку открывают, чтобы
 * увидеть настройку полностью. Страниц и фильтров у него нет, поэтому и параметров в ключе нет:
 * добавь их «на будущее» — и первый же запрос без параметров промахнулся бы мимо кэша.
 */
export const moduleMailKeys = createQueryKeys('module-mail-recipients', {
  list: () => ['list'],
});
