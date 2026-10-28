import { describe, expect, it } from 'vitest';
import type { CompleteVehicleRequestInput } from '@technic/contracts';
import {
  resolveCompletion,
  type CompletionRates,
} from '../src/services/vehicle-request-completion';

/**
 * The rental facts of a closing (plan `docs/vehicle-rental-completion-documents-plan.md` §4.3), as
 * the one resolver all three closing ways call computes them: the status door of a freight request,
 * the completion door of an on-site order and its lessor branch. The doors on the live schema are
 * in `vehicle-rental-completion.db.test.ts`.
 */

const ACTOR = { id: 'user-1', name: 'Диспетчеров Д. П.' };
const RENTAL: CompletionRates = { ownership: 'rental', pricePerHour: 1500, pricePerShift: 12000 };
const OWN: CompletionRates = { ownership: 'own', pricePerHour: null, pricePerShift: null };

function resolve(
  assignment: CompletionRates | null,
  input: CompleteVehicleRequestInput,
  previous: { deliveryCost: number | null } | null = null,
) {
  return resolveCompletion(assignment, input, ACTOR, undefined, previous);
}

function refusal(fn: () => unknown): { statusCode: number; fields?: Record<string, string> } {
  try {
    fn();
  } catch (e) {
    return e as { statusCode: number; fields?: Record<string, string> };
  }
  throw new Error('expected a refusal');
}

describe('rental facts of a closing', () => {
  it('stores both counts and the delivery apart from the cost', () => {
    const fact = resolve(RENTAL, {
      workedUnit: 'hours',
      workedAmount: 27,
      workedHours: 27,
      workedShifts: 3,
      deliveryCost: 12000,
    });
    expect(fact).toMatchObject({
      workedHours: 27,
      workedShifts: 3,
      deliveryCost: 12000,
      // The cost is rate × billed count; the delivery is not in it.
      totalCost: 40500,
    });
  });

  it('takes the billed count from workedAmount even when the body omits it', () => {
    const fact = resolve(RENTAL, { workedUnit: 'shifts', workedAmount: 3, workedHours: 26 });
    expect(fact).toMatchObject({ workedShifts: 3, workedHours: 26, totalCost: 36000 });
  });

  it('refuses a billed count that contradicts workedAmount', () => {
    const e = refusal(() =>
      resolve(RENTAL, { workedUnit: 'hours', workedAmount: 27, workedHours: 20 }),
    );
    expect(e.statusCode).toBe(422);
    expect(e.fields).toHaveProperty('workedHours');
  });

  it('keeps the stored delivery for an old tab and clears it on an explicit null', () => {
    const old = { workedUnit: 'shifts', workedAmount: 2 } as const;
    expect(resolve(RENTAL, old, { deliveryCost: 9000 })).toMatchObject({
      deliveryCost: 9000,
      workedShifts: 2,
      // The old tab re-stated the work: the paired count of the previous closing is gone.
      workedHours: null,
    });
    expect(resolve(RENTAL, { ...old, deliveryCost: null }, { deliveryCost: 9000 })).toMatchObject({
      deliveryCost: null,
    });
  });

  it('refuses the rental fields on a closing that is not a rental, by name', () => {
    const own = refusal(() =>
      resolve(OWN, { workedUnit: 'shifts', workedAmount: 1, deliveryCost: 5000 }),
    );
    expect(own.statusCode).toBe(422);
    expect(own.fields).toEqual({ deliveryCost: 'Только для арендованной техники' });
    const none = refusal(() =>
      resolve(null, { workedUnit: 'shifts', workedAmount: 1, workedHours: 8 }),
    );
    expect(none.fields).toHaveProperty('workedHours');
  });

  it('stores nothing new on a non-rental closing sent without the fields', () => {
    expect(resolve(OWN, { workedUnit: 'shifts', workedAmount: 1 })).toMatchObject({
      workedHours: null,
      workedShifts: null,
      deliveryCost: null,
    });
  });
});
