import { afterEach, describe, expect, it, vi } from 'vitest';
import { WASTE_REQUEST_CAPABILITY_HEADER, WASTE_REQUEST_CAPABILITY_SNOW } from '@technic/contracts';
import {
  confirmsSnowSupport,
  offeredRequestTypes,
  wasteRequestsApi,
} from '@entities/waste-request';

/**
 * The waste request client speaks to the API as a snow-capable portal (snow-removal plan, §3.5).
 *
 * The header is the whole negotiation: without it the API hides snow from lists and answers a
 * snow request with 426, so a single handle that forgot it would silently drop snow rows from its
 * screen. The test therefore calls EVERY handle of the client, not a sample, and fails when a new
 * handle is added without the header.
 */

interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

function spyFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url: new URL(raw, window.location.origin),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return sent;
}

afterEach(() => vi.restoreAllMocks());

const ID = '11111111-1111-4111-8111-111111111111';

/** One call per handle; the map is typed by the client, so a new handle breaks compilation here. */
const CALLS: Record<keyof typeof wasteRequestsApi, () => Promise<unknown>> = {
  capabilities: () => wasteRequestsApi.capabilities(),
  list: () => wasteRequestsApi.list({ page: 1 }),
  present: () => wasteRequestsApi.present({ page: 1 }),
  presentGroups: () => wasteRequestsApi.presentGroups(ID),
  summary: () => wasteRequestsApi.summary({}),
  historyList: () => wasteRequestsApi.historyList({ page: 1 }),
  historySummary: () => wasteRequestsApi.historySummary({}),
  stats: () => wasteRequestsApi.stats('2026-12', 'snow'),
  get: () => wasteRequestsApi.get(ID),
  history: () => wasteRequestsApi.history(ID),
  create: () => wasteRequestsApi.create({} as never, 'key-1'),
  reconcileCreate: () => wasteRequestsApi.reconcileCreate({} as never, 'key-1'),
  update: () => wasteRequestsApi.update(ID, { version: 1 }),
  assignOperator: () => wasteRequestsApi.assignOperator(ID, null, 1),
  setOperatorComment: () => wasteRequestsApi.setOperatorComment(ID, '', 1),
  changeStatus: () => wasteRequestsApi.changeStatus(ID, 'done', 1),
  addTickets: () => wasteRequestsApi.addTickets(ID, [], 1),
  remove: () => wasteRequestsApi.remove(ID, { version: 3, mode: 'soft' }),
  restore: () => wasteRequestsApi.restore(ID),
  purge: () => wasteRequestsApi.purge(ID, 4),
};

describe('клиент заявок на вывоз как портал, знающий снег', () => {
  it.each(Object.keys(CALLS))('%s несёт заголовок возможности snow-removal-v1', async (name) => {
    const sent = spyFetch();
    await CALLS[name as keyof typeof CALLS]();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers[WASTE_REQUEST_CAPABILITY_HEADER]).toBe(WASTE_REQUEST_CAPABILITY_SNOW);
  });

  it('ключ создания идёт рядом с заголовком возможности, а не вместо него', async () => {
    const sent = spyFetch();
    await wasteRequestsApi.create({} as never, 'key-7');
    expect(sent[0]!.headers['Idempotency-Key']).toBe('key-7');
    expect(sent[0]!.url.pathname).toBe('/api/v1/waste-requests/_create-with-receipt');
  });

  it('статистика мусора спрашивает голым ?month=, снега — с видом', async () => {
    const sent = spyFetch();
    await wasteRequestsApi.stats('2026-12', 'waste');
    await wasteRequestsApi.stats('2026-12', 'snow');
    // An API from before snow knows only `month`: garbage must keep working against it.
    expect([...sent[0]!.url.searchParams]).toEqual([['month', '2026-12']]);
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({
      month: '2026-12',
      kind: 'snow',
    });
  });

  it('удаление несёт подтверждённые версию и режим, окончательное — архивную версию', async () => {
    const sent = spyFetch();
    await wasteRequestsApi.remove(ID, { version: 3, mode: 'hard' });
    await wasteRequestsApi.purge(ID, 9);
    expect(sent[0]!.method).toBe('DELETE');
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({ version: '3', mode: 'hard' });
    expect(sent[1]!.url.pathname).toBe(`/api/v1/waste-requests/${ID}/purge`);
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({ version: '9' });
  });
});

describe('подтверждение поддержки снега', () => {
  it('верит только ответу нужной формы со своим токеном', () => {
    expect(confirmsSnowSupport({ capabilities: [WASTE_REQUEST_CAPABILITY_SNOW] })).toBe(true);
    expect(confirmsSnowSupport({ capabilities: ['something-else'] })).toBe(false);
    // An older API routes the path into the request card: a request DTO is not a confirmation.
    expect(confirmsSnowSupport({ id: 'capabilities', requestType: 'waste_removal' })).toBe(false);
    expect(confirmsSnowSupport({ capabilities: WASTE_REQUEST_CAPABILITY_SNOW })).toBe(false);
    expect(confirmsSnowSupport(null)).toBe(false);
  });

  it('снег предлагается только при подтверждённой поддержке, сохранённый тип остаётся', () => {
    const types = ['waste_removal', 'snow_removal', 'metal_removal'] as const;
    expect(offeredRequestTypes(types, true)).toEqual(types);
    expect(offeredRequestTypes(types, false)).toEqual(['waste_removal', 'metal_removal']);
    expect(offeredRequestTypes(types, false, 'snow_removal')).toEqual(types);
  });
});
