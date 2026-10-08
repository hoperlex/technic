import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { focusManager, useQuery } from '@tanstack/react-query';
import { QUERY_PROFILE } from '@shared/config';
import { PageTabs } from '@shared/ui';
import { pendingUsersCountQuery } from '@entities/user-account';
import { objectAddressOptionsQuery, objectRecordsQuery } from '@entities/object';
import {
  officeEquipmentCandidateListQuery,
  officeEquipmentCandidatePendingCountQuery,
} from '@entities/office-equipment-candidate';
import { trailerListQuery, trailerPickerQuery } from '@entities/vehicle-trailer';
import { licenseCategoriesQuery } from '@entities/driver';
import { json, mockHttp } from './http';
import { createTestQueryClient, renderWithUser } from './render';
import { advanceClock, freezeClock, restoreClock, settle } from './query';

function PendingBadge() {
  const { data } = useQuery(pendingUsersCountQuery());
  return <span>{data?.count ?? 0}</span>;
}

async function returnToBrowserTab(queryClient: ReturnType<typeof createTestQueryClient>) {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle(queryClient);
}

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  restoreClock();
});

describe('query profiles', () => {
  it('refreshes SIGNAL on browser return only after its freshness term', async () => {
    freezeClock('2026-10-08T09:00:00.000Z');
    const http = mockHttp({ 'GET /users/pending-count': () => json({ count: 2 }) });
    const { queryClient } = renderWithUser(<PendingBadge />);
    await settle(queryClient);
    expect(http.countOf('GET /users/pending-count')).toBe(1);

    advanceClock(QUERY_PROFILE.SIGNAL.staleTime - 1_000);
    await returnToBrowserTab(queryClient);
    expect(http.countOf('GET /users/pending-count')).toBe(1);

    advanceClock(2_000);
    await returnToBrowserTab(queryClient);
    expect(http.countOf('GET /users/pending-count')).toBe(2);
  });

  it('carries the owner profile through projections and keeps STATIC offline', () => {
    for (const name of ['SIGNAL', 'DICTIONARY', 'STATIC'] as const)
      expect(QUERY_PROFILE[name].meta.profile).toBe(name);
    for (const options of [
      objectAddressOptionsQuery(),
      objectRecordsQuery(true),
      trailerPickerQuery(),
    ]) {
      expect(options.meta).toEqual(QUERY_PROFILE.DICTIONARY.meta);
      expect(options.staleTime).toBe(QUERY_PROFILE.DICTIONARY.staleTime);
      expect(options.gcTime).toBe(QUERY_PROFILE.DICTIONARY.gcTime);
      expect(options.refetchOnWindowFocus).toBe(false);
    }
    expect(officeEquipmentCandidatePendingCountQuery().meta).toEqual(QUERY_PROFILE.SIGNAL.meta);
    expect(
      officeEquipmentCandidateListQuery({ page: 1, pageSize: 20, status: 'pending' }).meta,
    ).toBeUndefined();
    expect(trailerListQuery({ page: 1, pageSize: 50 }).meta).toBeUndefined();
    expect(licenseCategoriesQuery('driver_license').meta).toEqual(QUERY_PROFILE.STATIC.meta);
    expect(licenseCategoriesQuery('driver_license').refetchOnReconnect).toBe(false);
  });

  it('PageTabs refreshes section data while leaving SIGNAL to its focus policy', async () => {
    const queryClient = createTestQueryClient();
    const liveKey = ['service-requests', 'test-live'];
    const signalKey = ['service-requests', 'test-signal'];
    await queryClient.fetchQuery({ queryKey: liveKey, queryFn: () => 1 });
    await queryClient.fetchQuery({
      queryKey: signalKey,
      queryFn: () => 2,
      ...QUERY_PROFILE.SIGNAL,
    });
    const { queryClient: mountedClient } = renderWithUser(
      <PageTabs
        activeKey="first"
        refreshQueryKey={['service-requests']}
        items={[
          { key: 'first', label: 'Первый', children: <span>Первый экран</span> },
          { key: 'second', label: 'Второй', children: <span>Второй экран</span> },
        ]}
      />,
      { queryClient },
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Второй' }));
    await settle(mountedClient);
    expect(queryClient.getQueryState(liveKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(signalKey)?.isInvalidated).toBe(false);
  });
});
