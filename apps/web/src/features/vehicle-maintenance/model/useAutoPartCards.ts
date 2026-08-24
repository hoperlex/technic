import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { AutoPartDto } from '@technic/contracts';
import { autoPartApi, autoPartKeys } from '@entities/auto-part';

/**
 * Карточки автозапчастей, нужные форме акта: подбор под машину и позиции, уже стоящие строками
 * (план `docs/auto-parts-plan.md`, Р20, Р21, Р24).
 *
 * Запросов два вида, и они отвечают на разные вопросы. **Подбор** приходит списком, отсортированным
 * сервером по рангу применимости: сначала размеченные моделью машины, затем её типом, затем
 * остальные. Погашенные в него не идут — новой строкой их не добавляют (Р24).
 *
 * **Карточки уже стоящих строк** спрашиваются поимённо, но только те, которых в подборе нет:
 * подбор их не гарантирует — акт месячной давности ссылается и на погашенную позицию, и на ту, что
 * в алфавите ушла со страницы. Без её остатка нечем показать «12 → 11», без даты заведения —
 * предупредить о двойном списании. Позиция, пришедшая в подборе, второй раз не спрашивается: её
 * карточка уже в руках.
 *
 * Клиент и ключи берутся из слайса склада (`@entities/auto-part`), а не заводятся свои: остаток
 * меняют оба экрана — вкладка «Автозапчасти» и эта форма, — и два корня ключей означали бы, что
 * списание из акта не гасит перечень, а вкладка показывает прежнее число до перезагрузки страницы
 * (Р16).
 *
 * Ничего не спрашивается вовсе, пока блок не в работе (`enabled`): без права `autoParts.stock` он
 * показывает строки акта на чтение, и остатки склада ему не нужны — они пришли бы ради подписи,
 * которой нет.
 */

/** Сколько позиций тянет подбор: страница списка, дальше человек уточняет поиском. */
const PICK_PAGE_SIZE = 50;

export function useAutoPartCards({
  vehicleId,
  search,
  ids,
  enabled,
}: {
  vehicleId: string;
  /** Что набрано в открытом подборе: отбор идёт на сервере, своего фильтра у портала нет. */
  search: string;
  /** Позиции, названные строками формы: их карточки нужны независимо от подбора. */
  ids: readonly string[];
  enabled: boolean;
}): { options: AutoPartDto[]; cards: Map<string, AutoPartDto>; loading: boolean } {
  const params = useMemo(
    () => ({
      vehicleId,
      search: search.trim() || undefined,
      // Погашенные в подбор не попадают (Р24): добавить такую строку нельзя, и показывать её в
      // списке значило бы обещать отказ сервера.
      isActive: true,
      pageSize: PICK_PAGE_SIZE,
      sortBy: 'name',
    }),
    [vehicleId, search],
  );

  const pick = useQuery({
    queryKey: autoPartKeys.list(params),
    queryFn: () => autoPartApi.list(params),
    enabled,
  });

  const options = useMemo(() => pick.data?.items ?? [], [pick.data]);

  /*
   * Спрашиваем поимённо только то, чего в подборе нет. Список меняется вместе с набранным поиском,
   * поэтому позиция может выпасть из него и вернуться — но не мигнёт: её карточку кэш уже держит и
   * отдаёт сразу, а перечитка идёт фоном.
   */
  const missing = ids.filter((id) => !options.some((option) => option.id === id));
  const cardQueries = useQueries({
    queries: missing.map((id) => ({
      queryKey: autoPartKeys.detail(id),
      queryFn: () => autoPartApi.get(id),
      enabled,
    })),
  });

  /*
   * Карта собирается каждый раз заново, без `useMemo`: позиций здесь полсотни, а зависимостью
   * пришлось бы объявить результат `useQueries` — массив, который приходит новым на каждый ответ,
   * то есть память не сберегла бы ничего и только скрыла бы момент обновления остатка.
   */
  const cards = new Map<string, AutoPartDto>();
  for (const query of cardQueries) if (query.data) cards.set(query.data.id, query.data);
  // Свежая выдача подбора кладётся последней: остаток в ней новее того, что лежал в кэше.
  for (const item of options) cards.set(item.id, item);

  return { options, cards, loading: pick.isFetching };
}
