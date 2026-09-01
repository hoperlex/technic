import { queryOptions } from '@tanstack/react-query';
import { counterpartyTypeLabels, type CounterpartyDto } from '@technic/contracts';
import { apiFetch, type ListResult } from '@shared/api';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { mechRequestsApi } from './mechRequestsApi';
import { mechLessorKeys, mechRequestKeys } from './keys';

/**
 * Арендодатели, у которых берут механизацию (Р6): контрагенты типа «Арендодатель механизации»
 * **и** «Арендодатель (ТС)».
 *
 * Два запроса, а не один: тип у контрагента один, фильтр справочника принимает тоже один, — а
 * компания, уже заведённая арендодателем ТС, сдаёт виброплиты под своим типом, и менять его ей
 * нельзя (сломались бы права её учёток и её техника). Спрашивать весь справочник вместо двух
 * отборов было бы хуже: в нём сотни подрядчиков и поставщиков, и выбор арендодателя превратился
 * бы в поиск по всему реестру.
 *
 * Ключ при этом один: для потребителя это **один** перечень, и порознь эти половины никому не
 * нужны — ни форме договорённости, ни фильтру списка.
 *
 * Тип арендодателя ТС назван прямо в подписи, а не оставлен цветом или порядком: два одинаковых
 * названия подряд («ТрансСтрой» и «ТрансСтрой») означали бы для человека ошибку справочника, а не
 * две записи с разными ИНН. Подпись берётся из общего словаря типов — своей копии слов «(ТС)» в
 * портале быть не должно.
 *
 * Только действующие: сдать аренду через приостановленного контрагента сервер не даст, а у уже
 * назначенных наименование приходит снимком в самой заявке (`lessorName`).
 */
export const mechLessorOptionsQuery = () =>
  queryOptions({
    queryKey: mechLessorKeys.options(),
    queryFn: async () => {
      const ask = (type: 'mech_lessor' | 'vehicle_lessor') =>
        apiFetch<ListResult<CounterpartyDto>>('/counterparties', {
          query: {
            page: 1,
            pageSize: DICTIONARY_PAGE_SIZE,
            type,
            isActive: 'true',
            sortBy: 'name',
            sortOrder: 'asc',
          },
        });
      const [mech, vehicle] = await Promise.all([ask('mech_lessor'), ask('vehicle_lessor')]);
      return [...mech.items, ...vehicle.items];
    },
    /*
     * Порядок — по названию через оба типа сразу, а не «сначала свои, потом чужие»: человек ищет
     * арендодателя по имени, а не по тому, чем тот ещё торгует. Плоским списком, а не группами:
     * снятие отбора, указывающего на исчезнувшего контрагента (`usePruneMissingFilters`, ADR 0139),
     * читает перечень листьями и группу не раскрывает — сгруппированный список тихо перестал бы
     * чиститься.
     */
    select: (items) =>
      items
        .map((c) => ({
          value: c.id,
          label:
            c.type === 'mech_lessor'
              ? c.name
              : `${c.name} — ${counterpartyTypeLabels[c.type].toLowerCase()}`,
          name: c.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  });

/**
 * Подсказка видов техники (Р5): что уже арендовали в своей области.
 *
 * Справочника видов нет — заказчик его отложил, — и поле остаётся свободной строкой. Подсказка
 * нужна ровно затем, чтобы «Виброплита реверсивная» не превратилась в пять написаний одного и того
 * же: сравнение идёт по нормализованному ключу (`mechKindKey`), и портал предлагает уже
 * существующие позиции раньше, чем человек допишет своё.
 *
 * Ввод уходит на сервер, а не отбирается на клиенте: перечень строится по области смотрящего и
 * по частоте внутри неё, и «показать первые двадцать и искать среди них» отвечало бы на другой
 * вопрос — «что чаще всего», а не «что похоже на набранное».
 */
export const mechKindOptionsQuery = (search: string) =>
  queryOptions({
    queryKey: mechRequestKeys.kinds(search),
    queryFn: () => mechRequestsApi.kinds(search),
    select: (r) => r.items.map((kind) => ({ value: kind, label: kind })),
  });
