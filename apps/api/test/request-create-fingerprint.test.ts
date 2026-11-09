import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/db/client', () => ({ db: {} }));
vi.mock('../src/db/schema', () => ({ requestCreateAttempts: {} }));

import {
  KEY_MODE_FINGERPRINT,
  createAttemptFingerprint,
  parseOriginalAttempt,
} from '../src/services/request-create-attempt';

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

describe('original attempt parsing for reconciliation', () => {
  const schema = z.object({
    name: z.string().trim().min(1),
    items: z.array(z.object({ amount: z.number().positive() })),
    tag: z.string().optional().default('none'),
  });

  it('hands over the parsed form, so the fingerprint equals the one create computed', () => {
    const raw = { name: '  Иванов ', items: [{ amount: 1 }] };
    const original = parseOriginalAttempt(schema, raw);
    expect(original.parsed).toBe(true);
    if (!original.parsed) return;
    expect(original.body).toEqual({ name: 'Иванов', items: [{ amount: 1 }], tag: 'none' });
    expect(createAttemptFingerprint(original.body)).not.toBe(createAttemptFingerprint(raw));
  });

  it('reports only the paths of failing issues, never messages or values', () => {
    const original = parseOriginalAttempt(schema, {
      name: 'secret-value',
      items: [{ amount: 0 }, { amount: -5 }, { amount: 'text' }],
    });
    expect(original.parsed).toBe(false);
    if (original.parsed) return;
    expect(original.issuePaths).toEqual(['items.0.amount', 'items.1.amount', 'items.2.amount']);
    expect(JSON.stringify(original)).not.toContain('secret-value');
  });

  it('names a failure of the whole body root and bounds the list', () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, z.string()])),
    );
    const original = parseOriginalAttempt(wide, {});
    expect(original.parsed).toBe(false);
    if (original.parsed) return;
    expect(original.issuePaths).toHaveLength(20);
    const refined = z.object({}).superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', message: 'whole body' });
    });
    expect(parseOriginalAttempt(refined, {})).toEqual({ parsed: false, issuePaths: ['root'] });
  });

  it('keeps the key-mode marker out of the SHA-256 fingerprint space', () => {
    expect(KEY_MODE_FINGERPRINT).not.toMatch(/^[0-9a-f]{64}$/);
    expect(createAttemptFingerprint({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
