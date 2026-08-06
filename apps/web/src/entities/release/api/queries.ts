import { queryOptions } from '@tanstack/react-query';
import { releasesApi } from './releasesApi';
import { releaseKeys } from './keys';

/**
 * Полчаса — плата за то, что журнал спрашивают на каждой загрузке вкладки, а не при открытии окна:
 * список нужен раньше окна, точке в меню (ADR 0077).
 *
 * Содержимое меняется раз в несколько дней и только миграцией, так что получасовая задержка ничего
 * не стоит: выпуск доезжает до пользователя вместе с новой сборкой, а её перезагрузка (`useVersionCheck`
 * и `AppUpdateBanner`) обнуляет кэш целиком и без нашего участия.
 */
const RELEASES_STALE_TIME = 30 * 60_000;

/** Последние выпуски, новейший первым: порядок задаёт сервер по `seq`, на клиенте не пересортировываем. */
export const releasesQuery = () =>
  queryOptions({
    queryKey: releaseKeys.list(),
    queryFn: () => releasesApi.list(),
    staleTime: RELEASES_STALE_TIME,
  });
