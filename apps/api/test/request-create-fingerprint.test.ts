import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client', () => ({ db: {} }));
vi.mock('../src/db/schema', () => ({ requestCreateAttempts: {} }));

import { createAttemptFingerprint } from '../src/services/request-create-attempt';

describe('request creation fingerprint', () => {
  it('includes a Zod-coerced delivery date and matches its JSON representation', () => {
    const first = '2026-10-15T07:00:00.000Z';
    const next = '2026-10-16T07:00:00.000Z';
    expect(createAttemptFingerprint({ deliveryAt: new Date(first) })).toBe(
      createAttemptFingerprint({ deliveryAt: first }),
    );
    expect(createAttemptFingerprint({ deliveryAt: new Date(first) })).not.toBe(
      createAttemptFingerprint({ deliveryAt: new Date(next) }),
    );
  });
});
