import { createQueryKeys, type Query } from '@shared/api';

/**
 * Ключи запросов объектов.
 *
 * Ключ описывает **запрос**, а не сущность: справочник спрашивают в двух видах — только
 * действующие площадки (формы и фильтры заявок) и вообще все (форма контрагентов, где привязка к
 * выключенному объекту иначе показалась бы чужим идентификатором). Слить их в один ключ значит
 * показать в одном из мест не то, что нужно.
 */
export const objectKeys = createQueryKeys('objects', {
  list: (params: Query) => ['list', params],
  options: (params: { activeOnly: boolean }) => ['options', params],
});
