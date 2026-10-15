import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechRequestDto } from '@technic/contracts';
import { listLocalFormDrafts } from '@shared/lib';
import { useMechDuplicate } from '../src/pages/mech/useMechDuplicate';
import { mechRequest } from './factories/mech';
import { apiError, json, mockHttp } from './http';
import { renderWithUser } from './render';

const source = mechRequest();
const otherSource = mechRequest({ id: 'mech-2', displayNumber: 'МХ-44' });

function Harness({ request = source }: { request?: MechRequestDto }) {
  const duplicate = useMechDuplicate();
  return (
    <>
      <button onClick={() => duplicate.open(request)}>Open source</button>
      <button onClick={() => duplicate.open(otherSource)}>Open other source</button>
      {duplicate.notice}
      {duplicate.modal}
    </>
  );
}

function attempts() {
  return listLocalFormDrafts(
    'user-1',
    'mech-duplicate',
    source.id,
    (value): { id: string; displayNumber: string } | null =>
      value && typeof value === 'object' && 'id' in value && 'displayNumber' in value
        ? (value as { id: string; displayNumber: string })
        : null,
  ).drafts;
}

function installLocks() {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() },
  });
}

beforeEach(() => {
  localStorage.clear();
  installLocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

describe('Mechanization duplicate receipt in the portal', () => {
  it('blocks the POST when browser cross-tab locking is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const http = mockHttp({});
    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() =>
      expect(screen.getByText(/Браузер не поддерживает безопасное дублирование/)).toBeTruthy(),
    );
    expect(http.calls).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
  });

  it('restores a lost response and sends the same key through the versioned route', async () => {
    let sends = 0;
    const http = mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => {
        sends += 1;
        return sends === 1
          ? apiError(503, { code: 'unavailable', message: 'Response lost' })
          : json({ requestId: 'copy-1' });
      },
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-1', displayNumber: 'МХ-43' })),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const firstTab = renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() => expect(sends).toBe(1));
    await waitFor(() => expect(attempts()[0]?.createAttempt?.key).toBeTypeOf('string'));
    const originalKey = attempts()[0]!.createAttempt!.key;
    firstTab.unmount();

    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Проверить копию МХ-42/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить прежнюю отправку' }));
    await waitFor(() => expect(sends).toBe(2));
    await waitFor(() => expect(attempts()).toHaveLength(0));
    expect(http.countOf('POST /mech-requests/:id/_duplicate-with-receipt')).toBe(2);
    const keys = fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('/_duplicate-with-receipt'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual([originalKey, originalKey]);
  });

  it('keeps a restored tab on its old key after another tab confirms and clears it', async () => {
    let sends = 0;
    mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => {
        sends += 1;
        return json({ requestId: 'copy-1' }, sends === 1 ? 201 : 200);
      },
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-1', displayNumber: 'МХ-43' })),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const firstTab = renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    // Prepare an uncertain first attempt, then restore it into another mounted tab.
    const key = crypto.randomUUID();
    localStorage.setItem(
      'technic:form-draft:v1:first',
      JSON.stringify({
        schema: 1,
        id: 'first',
        userId: 'user-1',
        form: 'mech-duplicate',
        target: source.id,
        savedAt: Date.now(),
        payload: { id: source.id, displayNumber: source.displayNumber },
        createAttempt: { key, body: {}, protocol: 'receipt-v1' },
      }),
    );
    firstTab.unmount();
    const tabA = renderWithUser(<Harness />);
    const tabB = renderWithUser(<Harness />);
    const notices = screen.getAllByRole('button', { name: /Проверить копию МХ-42/ });
    fireEvent.click(notices[0]!);
    fireEvent.click(notices[1]!);
    const retries = screen.getAllByRole('button', { name: 'Повторить прежнюю отправку' });
    fireEvent.click(retries[0]!);
    await waitFor(() => expect(attempts()).toHaveLength(0));
    fireEvent.click(retries[1]!);
    await waitFor(() => expect(screen.getByText(/Копия уже создана/)).toBeTruthy());
    expect(sends).toBe(1);
    const keys = fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('/_duplicate-with-receipt'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual([key]);
    tabA.unmount();
    tabB.unmount();
  });

  it('keeps a confirmed ID visible when local cleanup fails, then permits cleanup retry', async () => {
    const http = mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => json({ requestId: 'copy-1' }, 201),
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-1', displayNumber: 'МХ-43' })),
    });
    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    const removal = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() => expect(screen.getByText(/ID заявки: copy-1/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Закрыть' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Дублировать' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open other source' }));
    expect(screen.getByText('Дублировать заявку МХ-42')).toBeTruthy();
    expect(http.countOf('POST /mech-requests/:id/_duplicate-with-receipt')).toBe(1);
    removal.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить очистку' }));
    await waitFor(() => expect(attempts()).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    expect(screen.getByRole('button', { name: /Создать ещё одну копию/ })).toBeTruthy();
  });

  it('does not switch the active draft while a delayed response is pending', async () => {
    let answer!: (value: ReturnType<typeof json>) => void;
    const pending = new Promise<ReturnType<typeof json>>((resolve) => {
      answer = resolve;
    });
    mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => pending,
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-1', displayNumber: 'МХ-43' })),
    });
    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() => expect(attempts()[0]?.createAttempt).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Open other source' }));
    expect(screen.getByText('Дублировать заявку МХ-42')).toBeTruthy();
    answer(json({ requestId: 'copy-1' }, 201));
    await waitFor(() => expect(attempts()).toHaveLength(0));
    const other = listLocalFormDrafts(
      'user-1',
      'mech-duplicate',
      otherSource.id,
      () => otherSource,
    );
    expect(other.drafts).toHaveLength(0);
  });

  it('requires a fresh explicit intent and ignores a late answer for the older key', async () => {
    let answerA!: (value: ReturnType<typeof json>) => void;
    let answerB!: (value: ReturnType<typeof json>) => void;
    const first = new Promise<ReturnType<typeof json>>((resolve) => {
      answerA = resolve;
    });
    const late = new Promise<ReturnType<typeof json>>((resolve) => {
      answerB = resolve;
    });
    let sends = 0;
    mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => {
        sends += 1;
        return sends === 1 ? first : sends === 2 ? late : json({ requestId: 'copy-2' }, 201);
      },
      'GET /mech-requests/:id': ({ params }) =>
        json(
          mechRequest({ id: params.id, displayNumber: params.id === 'copy-1' ? 'МХ-43' : 'МХ-44' }),
        ),
    });
    const oldKey = crypto.randomUUID();
    localStorage.setItem(
      'technic:form-draft:v1:old',
      JSON.stringify({
        schema: 1,
        id: 'old',
        userId: 'user-1',
        form: 'mech-duplicate',
        target: source.id,
        savedAt: Date.now(),
        payload: { id: source.id, displayNumber: source.displayNumber },
        createAttempt: { key: oldKey, body: {}, protocol: 'receipt-v1' },
      }),
    );
    const tabA = renderWithUser(<Harness />);
    const tabB = renderWithUser(<Harness />);
    const notices = screen.getAllByRole('button', { name: /Проверить копию МХ-42/ });
    fireEvent.click(notices[0]!);
    fireEvent.click(notices[1]!);
    const retries = screen.getAllByRole('button', { name: 'Повторить прежнюю отправку' });
    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);
    await waitFor(() => expect(sends).toBe(2));

    answerA(json({ requestId: 'copy-1' }, 201));
    await waitFor(() => expect(attempts()).toHaveLength(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Open source' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Создать ещё одну копию/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Дублировать' }));
    await waitFor(() => expect(sends).toBe(3));
    const markerKey = `technic:mech-duplicate-completed:v1:user-1:${source.id}`;
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(markerKey) ?? '{}').requestId).toBe('copy-2'),
    );
    const markerBefore = localStorage.getItem(markerKey);
    answerB(json({ requestId: 'copy-1' }, 200));
    await waitFor(() => expect(screen.getByText('Заведена копия: МХ-43')).toBeTruthy());
    expect(localStorage.getItem(markerKey)).toBe(markerBefore);
    expect(JSON.parse(markerBefore!).key).not.toBe(oldKey);
    tabA.unmount();
    tabB.unmount();
  });

  it('recovers a reserved next key when completion-marker removal fails', async () => {
    mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => json({ requestId: 'copy-1' }, 201),
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-1', displayNumber: 'МХ-43' })),
    });
    const firstTab = renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() => expect(attempts()).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    const originalRemove = Storage.prototype.removeItem;
    const removal = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (key.startsWith('technic:mech-duplicate-completed:v1:')) throw new Error('blocked');
      return originalRemove.call(this, key);
    });
    fireEvent.click(screen.getByRole('button', { name: /Создать ещё одну копию/ }));
    await waitFor(() => expect(attempts()[0]?.nextCreateKey).toBeTypeOf('string'));
    const reserved = attempts()[0]!.nextCreateKey;
    removal.mockRestore();
    firstTab.unmount();

    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Продолжить дублирование МХ-42/ }));
    fireEvent.click(screen.getByRole('button', { name: /Создать ещё одну копию/ }));
    await waitFor(() => expect(attempts()[0]?.nextCreateKey).toBe(reserved));
    expect(
      localStorage.getItem(`technic:mech-duplicate-completed:v1:user-1:${source.id}`),
    ).toBeNull();
  });

  it('confirms a replacement key even when an older tombstoned fork remains', async () => {
    const oldKey = crypto.randomUUID();
    const replacementKey = crypto.randomUUID();
    for (const [id, key, previousCreateKeys] of [
      ['replacement', replacementKey, [oldKey]],
      ['old-fork', oldKey, []],
    ] as const) {
      localStorage.setItem(
        `technic:form-draft:v1:${id}`,
        JSON.stringify({
          schema: 1,
          id,
          userId: 'user-1',
          form: 'mech-duplicate',
          target: source.id,
          savedAt: Date.now() + (id === 'replacement' ? 1 : 0),
          payload: { id: source.id, displayNumber: source.displayNumber },
          previousCreateKeys,
          createAttempt: { key, body: {}, protocol: 'receipt-v1' },
        }),
      );
    }
    mockHttp({
      'POST /mech-requests/:id/_duplicate-with-receipt': () => json({ requestId: 'copy-2' }, 201),
      'GET /mech-requests/:id': () => json(mechRequest({ id: 'copy-2', displayNumber: 'МХ-44' })),
    });
    renderWithUser(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: /Проверить копию МХ-42/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить прежнюю отправку' }));
    const markerKey = `technic:mech-duplicate-completed:v1:user-1:${source.id}`;
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(markerKey) ?? '{}')).toEqual({
        requestId: 'copy-2',
        key: replacementKey,
      }),
    );
    expect(attempts()).toHaveLength(0);
  });

  it('leaves a newer in-flight replacement untouched by a late reconciliation', async () => {
    const oldKey = crypto.randomUUID();
    const nextKey = crypto.randomUUID();
    const draftKey = 'technic:form-draft:v1:first';
    const base = {
      schema: 1,
      id: 'first',
      userId: 'user-1',
      form: 'mech-duplicate',
      target: source.id,
      savedAt: Date.now(),
      payload: { id: source.id, displayNumber: source.displayNumber },
    };
    localStorage.setItem(
      draftKey,
      JSON.stringify({ ...base, createAttempt: { key: oldKey, body: {}, protocol: 'receipt-v1' } }),
    );
    let answer!: (value: ReturnType<typeof json>) => void;
    const pending = new Promise<ReturnType<typeof json>>((resolve) => {
      answer = resolve;
    });
    mockHttp({ 'POST /mech-requests/:id/_duplicate-attempts/reconcile': () => pending });
    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Проверить копию МХ-42/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить результат' }));
    localStorage.setItem(
      draftKey,
      JSON.stringify({
        ...base,
        previousCreateKeys: [oldKey],
        createAttempt: { key: nextKey, body: {}, protocol: 'receipt-v1' },
      }),
    );
    answer(json({ state: 'not-created', nextOperationId: nextKey }));
    await waitFor(() => expect(screen.getByText(/Сохранённая попытка изменилась/)).toBeTruthy());
    expect(attempts().some((item) => item.createAttempt?.key === nextKey)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Отменить копирование' })).toBeNull();
  });

  it('reconciles a replacement while an ancestor tombstoned fork remains', async () => {
    const oldKey = crypto.randomUUID();
    const currentKey = crypto.randomUUID();
    const nextKey = crypto.randomUUID();
    for (const [id, key, previousCreateKeys] of [
      ['replacement', currentKey, [oldKey]],
      ['old-fork', oldKey, []],
    ] as const) {
      localStorage.setItem(
        `technic:form-draft:v1:${id}`,
        JSON.stringify({
          schema: 1,
          id,
          userId: 'user-1',
          form: 'mech-duplicate',
          target: source.id,
          savedAt: Date.now() + (id === 'replacement' ? 1 : 0),
          payload: { id: source.id, displayNumber: source.displayNumber },
          previousCreateKeys,
          createAttempt: { key, body: {}, protocol: 'receipt-v1' },
        }),
      );
    }
    mockHttp({
      'POST /mech-requests/:id/_duplicate-attempts/reconcile': () =>
        json({ state: 'not-created', nextOperationId: nextKey }),
    });
    renderWithUser(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: /Проверить копию МХ-42/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить результат' }));
    await waitFor(() =>
      expect(attempts().some((item) => item.nextCreateKey === nextKey)).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Дублировать' })).toBeTruthy();
  });

  it('does not replace a newer completion marker from a stale confirmed modal', async () => {
    const oldKey = crypto.randomUUID();
    const newerKey = crypto.randomUUID();
    const markerKey = `technic:mech-duplicate-completed:v1:user-1:${source.id}`;
    localStorage.setItem(markerKey, JSON.stringify({ requestId: 'copy-1', key: oldKey }));
    mockHttp({});
    renderWithUser(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    localStorage.setItem(markerKey, JSON.stringify({ requestId: 'copy-2', key: newerKey }));
    fireEvent.click(screen.getByRole('button', { name: 'Создать ещё одну копию' }));
    await waitFor(() =>
      expect(screen.getByText(/В другой вкладке уже создана следующая копия/)).toBeTruthy(),
    );
    expect(JSON.parse(localStorage.getItem(markerKey) ?? '{}')).toEqual({
      requestId: 'copy-2',
      key: newerKey,
    });
    expect(attempts()).toHaveLength(0);
    expect(screen.getByText(/ID заявки: copy-2/)).toBeTruthy();
  });
});
