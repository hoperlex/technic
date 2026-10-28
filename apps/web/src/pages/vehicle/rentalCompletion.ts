import type {
  CompleteVehicleRequestInput,
  VehicleRequestDto,
  VehicleWorkUnit,
} from '@technic/contracts';
import type { CompletionFormValues } from './CompletionFields';

/**
 * The rental half of the closing window (plan `docs/vehicle-rental-completion-documents-plan.md`,
 * D1–D4): both counts, the billed one chosen by the unit switch, and the delivery apart from the
 * cost.
 *
 * A file of its own beside `completionCommand` by the same boundary: the window asks and shows, the
 * rules of what a rental closing sends live here, once — the body is built from them for the
 * preview and for the command alike, and a second copy would part with the fingerprint.
 */

/** The count the cost is rate × of: the one the unit switch names. */
export function billedCount(
  v: Pick<CompletionFormValues, 'workedHours' | 'workedShifts'>,
  unit: VehicleWorkUnit,
): number | null {
  return (unit === 'hours' ? v.workedHours : v.workedShifts) ?? null;
}

/**
 * The rental fields a window opens with. A repeated closing opens on the previous fact — it is
 * corrected, not typed again; a fact closed by an old tab knows only its billed count, and the
 * other one comes from the defaults. Shifts default to the days of the actual period
 * (`plannedShifts`, computed by the caller's `plannedAmount`), hours to the basis the window already
 * has (signed shift hours or the route share — «the total over the shifts»); without a basis the
 * hours stay empty and are typed by hand.
 */
export function rentalPrefill(
  request: VehicleRequestDto,
  basisHours: number,
  plannedShifts: number | null,
): Pick<CompletionFormValues, 'workedShifts' | 'workedHours' | 'delivery' | 'deliveryCost'> {
  const previous = request.completion;
  const previousCount = (unit: VehicleWorkUnit): number | null => {
    if (!previous) return null;
    if (previous.workedUnit === unit) return previous.workedAmount;
    return (unit === 'hours' ? previous.workedHours : previous.workedShifts) ?? null;
  };
  const deliveryCost = previous?.deliveryCost ?? null;
  return {
    workedShifts: previousCount('shifts') ?? plannedShifts,
    workedHours: previousCount('hours') ?? (basisHours > 0 ? basisHours : null),
    // The box is never ticked by a guess (P3): a route by its own wheels costs nothing extra.
    delivery: deliveryCost != null,
    deliveryCost,
  };
}

/**
 * The fact of a rental closing as the doors take it: the billed count as `workedAmount`, both counts
 * and the delivery — `null` when the box is not ticked, which clears a delivery of a previous
 * closing on purpose.
 */
export function rentalFactOf(
  v: CompletionFormValues,
  unit: VehicleWorkUnit,
): Pick<
  CompleteVehicleRequestInput,
  'workedAmount' | 'workedHours' | 'workedShifts' | 'deliveryCost'
> {
  return {
    workedAmount: billedCount(v, unit)!,
    workedHours: v.workedHours ?? null,
    workedShifts: v.workedShifts ?? null,
    deliveryCost: v.delivery ? (v.deliveryCost ?? null) : null,
  };
}

/**
 * Why the closing cannot be sent, by field (`useFormBlockers`); all false — it can. The server
 * answers the same: a rental is not closed without a sum, it is the counterparty's invoice (ADR
 * 0027), and a rental is closed with both counts.
 */
export function completionBlockers(
  v: CompletionFormValues,
  rental: boolean,
): Record<string, string | false> {
  return {
    ...(rental
      ? rentalBlockers(v)
      : {
          workedAmount:
            (v.workedAmount == null || v.workedAmount <= 0) &&
            'Укажите, сколько отработала техника',
        }),
    totalCost:
      rental &&
      v.totalCost == null &&
      'Укажите стоимость — по арендованной технике заявка закрывается со счётом',
  };
}

/** The rental half of `completionBlockers`. */
function rentalBlockers(v: CompletionFormValues): Record<string, string | false> {
  return {
    workedShifts:
      (v.workedShifts == null || v.workedShifts <= 0) && 'Укажите, сколько смен отработала техника',
    workedHours:
      (v.workedHours == null || v.workedHours <= 0) && 'Укажите фактическое количество часов',
    deliveryCost:
      !!v.delivery &&
      (v.deliveryCost == null || v.deliveryCost <= 0) &&
      'Укажите стоимость привоза и увоза техники',
  };
}
