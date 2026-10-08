import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ManualDto } from '@technic/contracts';
import { json, mockHttp, type MockResponse } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from './viewport';
import { ManualsTab } from '../src/pages/admin/ManualsTab';

const manual = (id: string, title: string): ManualDto => ({
  id,
  title,
  description: '',
  url: `https://example.test/${id}`,
  sortOrder: 100,
  isActive: true,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
});

describe.each([
  ['desktop', DESKTOP_VIEWPORT],
  ['phone', MOBILE_VIEWPORT],
] as const)('manuals list on %s', (_name, viewport) => {
  it('keeps rows and total until the next page arrives', async () => {
    let answerNext: (response: MockResponse) => void = () => {};
    const nextPage = new Promise<MockResponse>((resolve) => {
      answerNext = resolve;
    });
    const http = mockHttp({
      'GET /manuals': ({ query }) =>
        query.get('page') === '2'
          ? nextPage
          : json(list([manual('first', 'First manual')], { total: 150 })),
    });
    renderWithUser(<ManualsTab />, { viewport });
    expect(await screen.findByText('First manual')).toBeDefined();

    const nextButton = document.querySelector('.ant-pagination-next button');
    expect(nextButton).not.toBeNull();
    fireEvent.click(nextButton!);
    await waitFor(() => expect(http.lastCall('GET /manuals')?.query.get('page')).toBe('2'));
    expect(screen.getByText('First manual')).toBeDefined();
    expect(screen.getByText('Всего: 150')).toBeDefined();

    await act(async () =>
      answerNext(json(list([manual('second', 'Second manual')], { total: 150, page: 2 }))),
    );
    expect(await screen.findByText('Second manual')).toBeDefined();
    expect(screen.queryByText('First manual')).toBeNull();
  });
});
