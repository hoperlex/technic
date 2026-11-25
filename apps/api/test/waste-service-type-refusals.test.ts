import { describe, expect, it } from 'vitest';
import { SNOW_COST_AT_COMPLETION_MESSAGE } from '@technic/contracts';
import { AppError } from '../src/lib/errors';
import {
  asServiceWasteTypeRefusal,
  SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
} from '../src/services/waste-types';

/**
 * The guards of migration 0429 translated into field refusals (snow-removal plan, §3.2). The entry
 * points refuse first; this is what a request meets if a write still reaches the database, and it
 * must be a 4xx with words, not a 500. The live constraint names are checked against the database
 * in `waste-service-type.db.test.ts`; here — the translation itself and what it leaves alone.
 */

/** drizzle wraps the driver error: the code and constraint sit in `cause`. */
function wrapped(code: string, constraint?: string): Error {
  return Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('pg'), { code, constraint }),
  });
}

function refusal(e: unknown): AppError {
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

describe('отказы базы о служебном типе «Снег» переводятся в слова', () => {
  it('CHECK служебной строки — отказ поля с объяснением', () => {
    const e = refusal(
      asServiceWasteTypeRefusal(wrapped('23514', 'waste_types_service_snow_check'), 'name'),
    );
    expect(e.statusCode).toBe(400);
    expect(e.fields).toEqual({ name: SERVICE_WASTE_TYPE_LOCKED_MESSAGE });
  });

  it('CHECK прайса — отказ поля «стоимость вносится при закрытии»', () => {
    const e = refusal(
      asServiceWasteTypeRefusal(
        wrapped('23514', 'waste_tariffs_not_service_type_check'),
        'wasteTypeId',
      ),
    );
    expect(e.statusCode).toBe(400);
    expect(e.fields).toEqual({ wasteTypeId: SNOW_COST_AT_COMPLETION_MESSAGE });
  });

  it('триггер запрета удаления (23001) — конфликт с объяснением', () => {
    const e = refusal(asServiceWasteTypeRefusal(wrapped('23001'), 'id'));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe(SERVICE_WASTE_TYPE_LOCKED_MESSAGE);
  });

  it('чужие отказы проходят дальше нетронутыми', () => {
    const others = [
      wrapped('23514', 'waste_types_code_format_check'),
      wrapped('23505', 'waste_types_name_key_unique'),
      wrapped('23503'),
      new Error('boom'),
    ];
    for (const other of others) {
      expect(asServiceWasteTypeRefusal(other, 'name')).toBe(other);
    }
  });
});
