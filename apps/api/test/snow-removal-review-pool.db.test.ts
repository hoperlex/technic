import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WasteRequestDto } from '@technic/contracts';
import {
  addUser,
  buildScene,
  card,
  current,
  inject,
  insertRequest,
  linkTicket,
  REQUESTS,
  type Scene,
} from './snow-removal-harness';

/**
 * The status corridor for the ticket reviewer, on an API whose pool holds ONE connection
 * (snow-removal plan, §3.2; §4 «Close and review»: «Exercise terminal review with an API pool size
 * of one»).
 *
 * Why the pool of one proves something. The terminal move runs in a transaction that holds the
 * only connection and the request lock; the review check must load the request and its evidence
 * through that transaction. A check that read through the pool would wait for a second connection
 * that never comes and fail after `DB_CONNECT_TIMEOUT_MS` — so «200» here means «read under the
 * lock, by the same transaction», not merely «the check ran».
 */

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;

beforeAll(async () => {
  const built = await buildScene('pool1', {
    env: { DB_POOL_MAX: '1', DB_CONNECT_TIMEOUT_MS: '3000' },
  });
  if (built) s = built;
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

function move(id: string, auth: { authorization: string }, status: string, version: number) {
  // A reason is sent always: a cancellation without one would stop at validation, before the
  // corridor is asked at all.
  return inject('PATCH', `${REQUESTS}/${id}/status`, auth, {
    status,
    version,
    comment: 'проверка коридора',
  });
}

describe.skipIf(!RUN_DB)('ticket reviewer without the ordinary status right', () => {
  it('places «Завершена» on settled paper through the locked transaction', async () => {
    const id = await insertRequest({ status: 'done' });
    const dto = await card(id, s.users.reviewer.auth);
    const res = await move(id, s.users.reviewer.auth, 'completed', dto.version);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as WasteRequestDto).status).toBe('completed');
  });

  it('is refused «Завершена» while the paper is unsettled — read through the same transaction', async () => {
    // Garbage with attached but never recognized paper: the badge counts it as unreviewed.
    const id = await insertRequest({ type: 'waste_removal', status: 'done' });
    await linkTicket(id, s.users.dispatcher);
    const dto = await card(id, s.users.reviewer.auth);
    const res = await move(id, s.users.reviewer.auth, 'completed', dto.version);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.status).toBeTruthy();
    expect((await card(id, s.users.reviewer.auth)).status).toBe('done');
  });

  it.each([
    ['done', 'confirmed'],
    ['confirmed', 'done'],
    ['new', 'confirmed'],
    ['new', 'cancelled'],
  ] as const)('cannot make any other move (%s → %s)', async (from, to) => {
    const id = await insertRequest({ status: from });
    const dto = await card(id, s.users.reviewer.auth);
    const res = await move(id, s.users.reviewer.auth, to, dto.version);
    expect(res.statusCode, res.body).toBe(403);
    expect((await card(id, s.users.dispatcher.auth)).status).toBe(from);
  });

  it('keeps the site scope: a site reviewer cannot complete a request of another site', async () => {
    const siteReviewer = await addUser({
      tag: 'srev',
      role: 'shtab',
      objects: [s.objectId],
      grant: ['wasteRequests.ticketReview'],
    });
    const foreign = await insertRequest({ status: 'done', objectId: current().otherObjectId });
    const dto = await card(foreign, s.users.dispatcher.auth);
    const res = await move(foreign, siteReviewer.auth, 'completed', dto.version);
    expect(res.statusCode, res.body).toBe(403);
    const own = await insertRequest({ status: 'done' });
    const ownDto = await card(own, s.users.dispatcher.auth);
    const ok = await move(own, siteReviewer.auth, 'completed', ownDto.version);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('keeps the operator scope on the same door', async () => {
    const operatorReviewer = await addUser({
      tag: 'orev',
      role: 'operator',
      counterpartyId: s.operatorA,
      grant: ['wasteRequests.ticketReview'],
    });
    const foreign = await insertRequest({ status: 'done', operator: s.operatorB });
    const dto = await card(foreign, s.users.dispatcher.auth);
    const res = await move(foreign, operatorReviewer.auth, 'completed', dto.version);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('the ordinary closer still drives the cycle on the pool of one', async () => {
    const id = await insertRequest({ status: 'new' });
    let dto = await card(id, s.users.dispatcher.auth);
    const res = await move(id, s.users.dispatcher.auth, 'confirmed', dto.version);
    expect(res.statusCode, res.body).toBe(200);
    dto = res.json() as WasteRequestDto;
    expect(dto.status).toBe('confirmed');
  });
});
