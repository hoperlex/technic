import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { manualsApi } from './manualsApi';
import { manualKeys } from './keys';

/**
 * The service menu lists only published manuals for every role, including manual administrators.
 * Its own key prevents this all-active response from sharing an administrator's filtered page.
 * The short list arrives in one page; the server preserves the administrator's configured order.
 */
export const activeManualsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: manualKeys.active(),
    queryFn: () => manualsApi.list({ page: 1, pageSize: DICTIONARY_PAGE_SIZE, isActive: 'true' }),
  });
