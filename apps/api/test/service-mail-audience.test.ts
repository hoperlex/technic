import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  collectServiceMailRecipients,
  sideRecipients,
  type ServiceMailRecipient,
} from '../src/services/service-request-mail-audience';

vi.mock('../src/config', () => ({ config: { serviceRequests: { mailExtraRecipients: [] } } }));
vi.mock('../src/logger', () => ({ logger: {} }));
vi.mock('../src/db/client', () => ({ db: {} }));

const PRIMARY = 'repair@example.invalid';
const EXTRA = 'repair-new@example.invalid';
const actor = { id: 'actor', email: EXTRA, counterpartyId: null };
const ctx = { channelEmail: PRIMARY, internalReplyTo: 'author@example.invalid', actor };
const side = { serviceCounterpartyId: null, executorUserIds: [] };
// Office recipients come from trusted configuration, so touching the database is an error.
const tx = new Proxy(
  {},
  {
    get: () => {
      throw new Error('Unexpected database access');
    },
  },
) as Parameters<typeof sideRecipients>[0];

afterEach(() => {
  config.serviceRequests.mailExtraRecipients = [];
});

async function recipients() {
  return collectServiceMailRecipients(await sideRecipients(tx, side, 'office', ctx), actor);
}

describe('trusted service mailbox destinations', () => {
  it('preserves the legacy destination and key without extra configuration', async () => {
    expect(await recipients()).toEqual([
      expect.objectContaining({
        key: 'channel',
        email: PRIMARY,
        source: 'channel',
        audience: 'internal',
      }),
    ]);
  });

  it('keeps both trusted destinations even when the actor has the extra address', async () => {
    config.serviceRequests.mailExtraRecipients = [EXTRA];
    const rows = await recipients();
    expect(rows.map((row) => row.email)).toEqual([PRIMARY, EXTRA]);
    expect(rows.every((row) => row.audience === 'internal' && row.source === 'channel')).toBe(true);
    expect(rows.every((row) => row.replyTo === ctx.internalReplyTo)).toBe(true);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.every((row) => !row.key.includes(':'))).toBe(true);
  });

  it('normalizes duplicate destinations and keeps the legacy key for the primary address', async () => {
    config.serviceRequests.mailExtraRecipients = [
      PRIMARY.toUpperCase(),
      EXTRA,
      ` ${EXTRA.toUpperCase()} `,
    ];
    const rows = await recipients();
    expect(rows.map((row) => row.email)).toEqual([PRIMARY, EXTRA]);
    expect(rows[0]!.key).toBe('channel');
  });

  it('keeps recipient keys stable when configuration order changes', async () => {
    config.serviceRequests.mailExtraRecipients = [EXTRA, 'other@example.invalid'];
    const before = await recipients();
    config.serviceRequests.mailExtraRecipients.reverse();
    expect(await recipients()).toEqual(before);
  });

  it('keeps the full trusted body when the address is also configured as a redacted copy', async () => {
    config.serviceRequests.mailExtraRecipients = [EXTRA];
    const copy: ServiceMailRecipient = {
      key: 'copy',
      email: EXTRA,
      replyTo: PRIMARY,
      audience: 'copy',
      source: 'copy',
      sortId: 'copy',
      counterpartyId: null,
    };
    const rows = collectServiceMailRecipients([copy, ...(await recipients())], actor);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.email === EXTRA)?.audience).toBe('internal');
  });

  it('does not turn extra destinations into a configured channel when the primary is missing', async () => {
    config.serviceRequests.mailExtraRecipients = [EXTRA];
    expect(await sideRecipients(tx, side, 'office', { ...ctx, channelEmail: '' })).toEqual([]);
  });

  it('keeps the legacy mailbox receiving notices when the new mailbox becomes primary', async () => {
    config.serviceRequests.mailExtraRecipients = ['repair@mstroy.pro'];
    const rows = collectServiceMailRecipients(
      await sideRecipients(tx, side, 'office', { ...ctx, channelEmail: 'repair@su-10.ru' }),
      actor,
    );
    expect(rows.map((row) => row.email)).toEqual(['repair@su-10.ru', 'repair@mstroy.pro']);
    expect(rows[0]!.key).toBe('channel');
    expect(rows.every((row) => row.audience === 'internal')).toBe(true);
  });
});
