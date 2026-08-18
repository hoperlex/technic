import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { manualsApi } from './manualsApi';
import { manualKeys } from './keys';

/**
 * Опубликованные руководства для окна служебного меню.
 *
 * `isActive: 'true'` стоит **всегда**, независимо от прав смотрящего: снятое с публикации
 * руководство — это документ, которым пользоваться перестали, и держателю `manuals.manage` он в
 * окне так же не нужен, как всем остальным (план §3.3). Своим ключом — по той же причине: под
 * общим с вкладкой ведения окно администратора получало бы её отфильтрованную страницу.
 *
 * Страница одна и большая: список короткий по замыслу (план §6), и пролистывать руководства
 * постранично было бы страннее, чем привезти их разом.
 *
 * Порядок не задаётся: его назначает сервер (`sortOrder ASC, title ASC, id ASC`) — тем самым,
 * который администратор и расставляет на вкладке.
 */
export const activeManualsQuery = () =>
  queryOptions({
    queryKey: manualKeys.active(),
    queryFn: () => manualsApi.list({ page: 1, pageSize: DICTIONARY_PAGE_SIZE, isActive: 'true' }),
  });
