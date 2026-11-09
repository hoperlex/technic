import { useState } from 'react';
import { Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { moscowDateKeyOf, type MechLessorRentalDto } from '@technic/contracts';
import { mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { useAuth } from '@entities/session';
import { listQueryOptions } from '@shared/api';
import { usePruneMissingFilters, useListParams } from '@shared/lib';
import {
  DataTable,
  DeferredSearchInput,
  FilterReset,
  PageTableLayout,
  sortOptionsFrom,
} from '@shared/ui';
import { renderMechFilter } from '../MechFilterBar';
import {
  LESSOR_RECEIPT_OPTIONS,
  LESSOR_RENTAL_FILTER_FIELDS,
  lessorRentalCard,
  lessorRentalColumns,
  lessorRentalFilters,
  type LessorRentalFilters,
} from './lessorRentalGrid';
import { MechLessorRentalCard } from './MechLessorRentalCard';

const SEARCH_PLACEHOLDER = 'Модель, площадка, адрес';

/**
 * «Механизация» for a mechanization lessor (lessor receipt plan, §2, P12): his rentals «В работе»,
 * one list and a narrow card, where he attaches the receipts. His only section, so his start page.
 *
 * One page, no tabs: the office's tabs call doors that refuse him (every mechanization door but his
 * three answers a lessor 403, P11), and none of their questions — what to take into work, what it
 * cost, what was deleted — is his. No create button: the requests are the company's.
 *
 * Soonest return first, like the server's default: he reads the list as «what comes back next».
 * The search looks only at what his card shows (the server's choice, P12).
 */
export function MechLessorRentalsPage() {
  const { user } = useAuth();
  const today = moscowDateKeyOf(new Date());

  const { params, setParams, setSort, onTableChange, filtersActive, resetFilters } = useListParams<
    LessorRentalFilters & { search?: string }
  >(
    {},
    {
      searchKeys: [],
      filterKeys: LESSOR_RENTAL_FILTER_FIELDS,
      persist: { scope: 'mech-lessor-rentals', userId: user?.id },
    },
  );
  const apply = (patch: LessorRentalFilters) => setParams((p) => ({ ...p, ...patch, page: 1 }));
  const filters = lessorRentalFilters(params, apply);
  const search = (value: string | undefined) =>
    setParams((p) => ({ ...p, search: value || undefined, page: 1 }));

  // A remembered value the contracts no longer know would come back from the server as a 400.
  usePruneMissingFilters(
    [
      {
        key: 'lessorReceipt',
        value: params.lessorReceipt,
        options: LESSOR_RECEIPT_OPTIONS,
        ready: true,
      },
    ],
    (keys) => apply(Object.fromEntries(keys.map((key) => [key, undefined]))),
  );

  const sortBy = params.sortBy ?? 'plannedTo';
  const sortOrder = params.sortBy ? params.sortOrder : 'asc';
  const query = { ...params, sortBy, sortOrder };
  const { data, isFetching } = useQuery(
    listQueryOptions({
      queryKey: mechRequestKeys.lessorList(query),
      queryFn: () => mechRequestsApi.lessorRentals(query),
    }),
  );

  const [opened, setOpened] = useState<MechLessorRentalDto | null>(null);
  const grid = { today, onOpen: setOpened };
  const columns = lessorRentalColumns(grid);

  return (
    <div style={{ height: '100%' }}>
      <PageTableLayout
        filters={
          <Space wrap>
            {filters.map(renderMechFilter)}
            <DeferredSearchInput
              style={{ width: 240 }}
              allowClear
              placeholder={SEARCH_PLACEHOLDER}
              value={params.search}
              onChange={search}
            />
            <FilterReset active={filtersActive} onClick={resetFilters} />
          </Space>
        }
        mobile={{
          search: { value: params.search, placeholder: SEARCH_PLACEHOLDER, onChange: search },
          filters,
          sort: {
            options: sortOptionsFrom(columns, { plannedTo: 'Дата возврата' }),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          },
        }}
      >
        <DataTable<MechLessorRentalDto>
          columns={columns}
          card={lessorRentalCard(grid)}
          data={data?.items ?? []}
          total={data?.total ?? 0}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onRowClick={setOpened}
          onChange={onTableChange}
        />
      </PageTableLayout>

      <MechLessorRentalCard rental={opened} today={today} onClose={() => setOpened(null)} />
    </div>
  );
}
