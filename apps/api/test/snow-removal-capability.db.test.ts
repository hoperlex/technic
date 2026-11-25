import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  WasteRequestDto,
  WasteRequestHistorySummaryDto,
  WasteRequestSummaryDto,
} from '@technic/contracts';
import {
  type Auth,
  buildScene,
  card,
  current,
  garbageWasteType,
  inject,
  insertRequest,
  newFile,
  newSite,
  nextAddress,
  REQUESTS,
  type Scene,
  scalar,
  SNOW,
  snowBody,
} from './snow-removal-harness';

/**
 * Capability negotiation for snow (snow-removal plan, §3.5; §4 «Rollout»: «old web gets a
 * coherent legacy list, history summary and 426 on direct snow»).
 *
 * «Old web» is a request WITHOUT `X-Waste-Request-Capability`; «new web» sends `snow-removal-v1`.
 * Each listing case runs on its own site so that totals are exact, not «at least».
 */

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;
const OLD: Record<string, string> = {};

beforeAll(async () => {
  const built = await buildScene('capability');
  if (built) s = built;
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

function get(url: string, auth: Auth, headers: Record<string, string>) {
  return inject('GET', url, auth, undefined, headers);
}

/** A site with one snow and one garbage request in each of the given states. */
async function mixedSite(
  statuses: readonly ('new' | 'confirmed' | 'completed' | 'cancelled')[],
): Promise<{ site: string; snow: string[]; garbage: string[] }> {
  const site = await newSite();
  const wasteTypeId = await garbageWasteType();
  const snow: string[] = [];
  const garbage: string[] = [];
  for (const status of statuses) {
    snow.push(await insertRequest({ objectId: site, status, operator: null }));
    garbage.push(
      await insertRequest({
        objectId: site,
        status,
        operator: null,
        type: 'waste_removal',
        wasteTypeId,
      }),
    );
  }
  return { site, snow, garbage };
}

describe.skipIf(!RUN_DB)('capabilities endpoint', () => {
  it('confirms snow support to a reader, with or without the header', async () => {
    for (const headers of [OLD, SNOW]) {
      const res = await get(`${REQUESTS}/capabilities`, s.users.site.auth, headers);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ capabilities: ['snow-removal-v1'] });
    }
  });
});

describe.skipIf(!RUN_DB)('legacy filter for a tab without the capability', () => {
  it('feed and its total hide snow; the new tab sees it', async () => {
    const { site, snow, garbage } = await mixedSite(['new', 'confirmed']);
    const old = await get(`${REQUESTS}?objectId=${site}&pageSize=50`, s.users.dispatcher.auth, OLD);
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json().total).toBe(2);
    expect((old.json().items as WasteRequestDto[]).map((r) => r.id).sort()).toEqual(
      [...garbage].sort(),
    );
    const fresh = await get(
      `${REQUESTS}?objectId=${site}&pageSize=50`,
      s.users.dispatcher.auth,
      SNOW,
    );
    expect(fresh.json().total).toBe(4);
    expect((fresh.json().items as WasteRequestDto[]).map((r) => r.id)).toEqual(
      expect.arrayContaining(snow),
    );
  });

  it('archive hides snow for the old tab', async () => {
    const site = await newSite();
    const snow = await insertRequest({ objectId: site, status: 'confirmed', deleted: true });
    const garbage = await insertRequest({
      objectId: site,
      status: 'confirmed',
      deleted: true,
      type: 'metal_removal',
    });
    const url = `${REQUESTS}?objectId=${site}&archive=only&pageSize=50`;
    const old = await get(url, s.users.admin.auth, OLD);
    expect(old.statusCode, old.body).toBe(200);
    expect((old.json().items as WasteRequestDto[]).map((r) => r.id)).toEqual([garbage]);
    expect(old.json().total).toBe(1);
    const fresh = await get(url, s.users.admin.auth, SNOW);
    expect((fresh.json().items as WasteRequestDto[]).map((r) => r.id).sort()).toEqual(
      [snow, garbage].sort(),
    );
  });

  it('status counts hide snow for the old tab', async () => {
    const { site } = await mixedSite(['new', 'confirmed']);
    const old = await get(`${REQUESTS}/summary?objectId=${site}`, s.users.dispatcher.auth, OLD);
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json()).toMatchObject({
      new: 1,
      confirmed: 1,
    } satisfies Partial<WasteRequestSummaryDto>);
    const fresh = await get(`${REQUESTS}/summary?objectId=${site}`, s.users.dispatcher.auth, SNOW);
    expect(fresh.json()).toMatchObject({ new: 2, confirmed: 2 });
  });

  it('history list and history summary hide snow before totals for the old tab', async () => {
    const { site, snow } = await mixedSite(['completed', 'cancelled']);
    // The completed snow request carries 12 m³ and no cost: hidden from the old tab entirely,
    // counted as «without a cost» for the new one.
    await current().db.execute(sql`
      INSERT INTO waste_request_completions (request_id, volume_m3, total_cost, completed_by,
                                             removed_on_source)
      VALUES (${snow[0]!}, 12, NULL, ${s.adminId}, 'unknown')`);
    const old = await get(
      `${REQUESTS}/history?objectId=${site}&pageSize=50`,
      s.users.dispatcher.auth,
      OLD,
    );
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json().total).toBe(2);
    expect(
      (old.json().items as WasteRequestDto[]).every((r) => r.requestType !== 'snow_removal'),
    ).toBe(true);
    const oldSummary = await get(
      `${REQUESTS}/history/summary?objectId=${site}`,
      s.users.dispatcher.auth,
      OLD,
    );
    expect(oldSummary.json()).toMatchObject({
      total: 2,
      completed: 1,
      cancelled: 1,
      volumeM3: 0,
      snowCompletedWithCost: 0,
      snowCompletedWithoutCost: 0,
    } satisfies Partial<WasteRequestHistorySummaryDto>);
    expect(typeof oldSummary.json().totalCost).toBe('number');
    const freshSummary = await get(
      `${REQUESTS}/history/summary?objectId=${site}`,
      s.users.dispatcher.auth,
      SNOW,
    );
    expect(freshSummary.json()).toMatchObject({
      total: 4,
      completed: 2,
      volumeM3: 12,
      totalCost: 0,
      snowCompletedWithCost: 0,
      snowCompletedWithoutCost: 1,
    });
  });

  it('an explicit snow filter needs the capability', async () => {
    for (const url of [
      `${REQUESTS}?requestType=snow_removal`,
      `${REQUESTS}/history?requestType=snow_removal`,
      `${REQUESTS}/history/summary?requestType=snow_removal`,
    ]) {
      const old = await get(url, s.users.dispatcher.auth, OLD);
      expect(old.statusCode, `${url}: ${old.body}`).toBe(426);
      expect(old.json().code).toBe('client_upgrade_required');
      const fresh = await get(url, s.users.dispatcher.auth, SNOW);
      expect(fresh.statusCode, `${url}: ${fresh.body}`).toBe(200);
    }
  });
});

describe.skipIf(!RUN_DB)('direct snow requests from an old tab', () => {
  it('detail and request history answer 426 — after the scope checks', async () => {
    const id = await insertRequest({ status: 'new' });
    for (const url of [`${REQUESTS}/${id}`, `${REQUESTS}/${id}/history`]) {
      const res = await get(url, s.users.dispatcher.auth, OLD);
      expect(res.statusCode, res.body).toBe(426);
    }
    // Outside the site user's area the answer is the scope refusal, not the type.
    const foreign = await insertRequest({ status: 'new', objectId: current().otherObjectId });
    for (const url of [`${REQUESTS}/${foreign}`, `${REQUESTS}/${foreign}/history`]) {
      const res = await get(url, s.users.site.auth, OLD);
      expect(res.statusCode, res.body).toBe(403);
    }
    // An archived row stays 404 for an account without the archive.
    const archived = await insertRequest({ status: 'confirmed', deleted: true });
    expect((await get(`${REQUESTS}/${archived}`, s.users.site.auth, OLD)).statusCode).toBe(404);
  });

  it('every mutation answers 426 and changes nothing', async () => {
    const id = await insertRequest({ status: 'done' });
    const before = await card(id, s.users.dispatcher.auth);
    const ticket = await newFile(s.users.dispatcher);
    const calls: [string, string, unknown][] = [
      ['PATCH', `${REQUESTS}/${id}`, { comment: 'старая вкладка', version: before.version }],
      ['PATCH', `${REQUESTS}/${id}/status`, { status: 'completed', version: before.version }],
      [
        'PATCH',
        `${REQUESTS}/${id}/operator`,
        { operatorCounterpartyId: s.operatorB, version: before.version },
      ],
      ['PATCH', `${REQUESTS}/${id}/comment`, { operatorComment: 'x', version: before.version }],
      [
        'POST',
        `${REQUESTS}/${id}/ticket-files`,
        { ticketFileIds: [ticket.id], version: before.version },
      ],
      ['DELETE', `${REQUESTS}/${id}`, undefined],
    ];
    for (const [method, url, payload] of calls) {
      const res = await inject(
        method as 'PATCH' | 'POST' | 'DELETE',
        url,
        s.users.dispatcher.auth,
        payload,
        OLD,
      );
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(426);
    }
    const after = await card(id, s.users.dispatcher.auth);
    expect(after).toEqual(before);
    expect(
      await scalar<number>(
        sql`SELECT count(*)::int AS v FROM request_files WHERE file_id = ${ticket.id}`,
      ),
    ).toBe(0);
  });

  it('restore and purge answer 426 after their own checks', async () => {
    const id = await insertRequest({ status: 'confirmed', deleted: true });
    const restore = await inject(
      'POST',
      `${REQUESTS}/${id}/restore`,
      s.users.admin.auth,
      undefined,
      OLD,
    );
    expect(restore.statusCode, restore.body).toBe(426);
    const purge = await inject(
      'DELETE',
      `${REQUESTS}/${id}/purge?version=1`,
      s.users.admin.auth,
      undefined,
      OLD,
    );
    expect(purge.statusCode, purge.body).toBe(426);
    expect(
      await scalar<boolean>(
        sql`SELECT deleted_at IS NOT NULL AS v FROM waste_requests WHERE id = ${id}`,
      ),
    ).toBe(true);
    // Without the purge right the old tab still reads 403 first.
    const denied = await inject(
      'DELETE',
      `${REQUESTS}/${id}/purge`,
      s.users.dispatcher.auth,
      undefined,
      OLD,
    );
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it('snow creation needs the capability; garbage does not', async () => {
    const snow = await inject('POST', REQUESTS, s.users.site.auth, snowBody(), OLD);
    expect(snow.statusCode, snow.body).toBe(426);
    const garbage = await inject(
      'POST',
      REQUESTS,
      s.users.site.auth,
      snowBody({ requestType: 'waste_removal', wasteTypeId: await garbageWasteType() }),
      OLD,
    );
    expect(garbage.statusCode, garbage.body).toBe(201);
  });

  it('a snow receipt replays only for the capable tab; reconciliation by key keeps working', async () => {
    const key = randomUUID();
    const body = snowBody();
    const send = (headers: Record<string, string>) =>
      current().app.inject({
        method: 'POST',
        url: `${REQUESTS}/_create-with-receipt`,
        headers: { ...s.users.site.auth, ...headers, 'idempotency-key': key },
        payload: body,
        remoteAddress: nextAddress(),
      });
    const first = await send(SNOW);
    expect(first.statusCode, first.body).toBe(201);
    const old = await send(OLD);
    expect(old.statusCode, old.body).toBe(426);
    const fresh = await send(SNOW);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json()).toEqual(first.json());
    const reconcile = await current().app.inject({
      method: 'POST',
      url: `${REQUESTS}/_create-attempts/reconcile`,
      headers: { ...s.users.site.auth, 'idempotency-key': key },
      payload: { originalBody: body },
      remoteAddress: nextAddress(),
    });
    expect(reconcile.statusCode, reconcile.body).toBe(200);
    expect(reconcile.json()).toEqual({
      state: 'created',
      requestId: (first.json() as WasteRequestDto).id,
    });
  });

  it('garbage stays fully usable by the old tab', async () => {
    const id = await insertRequest({ type: 'metal_removal', status: 'new' });
    const dto = (
      await get(`${REQUESTS}/${id}`, s.users.dispatcher.auth, OLD)
    ).json() as WasteRequestDto;
    const res = await inject(
      'PATCH',
      `${REQUESTS}/${id}`,
      s.users.dispatcher.auth,
      { comment: 'старая вкладка', version: dto.version },
      OLD,
    );
    expect(res.statusCode, res.body).toBe(200);
  });
});
