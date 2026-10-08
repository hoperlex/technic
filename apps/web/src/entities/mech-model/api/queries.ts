import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { mechModelsApi } from './mechModelsApi';
import { mechModelKeys } from './keys';

/**
 * Mechanization model choices fit in one page and are searched locally. Explicit name order avoids
 * the server's default newest-first order, which is unsuitable for a picker. Only active models
 * may be selected for new requests; an old request keeps its model name in its own snapshot, so
 * the form can add a saved inactive value without fetching a second directory page.
 */
export const mechModelOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: mechModelKeys.options(),
    queryFn: () =>
      mechModelsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'name',
        sortOrder: 'asc',
        isActive: 'true',
      }),
    // The request form and its filter must project the same option labels from this one response.
    select: (r) => r.items.map((m) => ({ value: m.id, label: m.name })),
  });
