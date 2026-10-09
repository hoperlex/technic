import { useDeferredOptions } from '@shared/lib';
import { driverOptionsQuery } from '../api/queries';

/**
 * Active drivers in alphabetical order for list filters.
 *
 * `enabled` is part of the access boundary, not a loading optimization. Pages without
 * `drivers.read` must not request personal data merely to render an empty selector after a 403.
 * Document categories do not narrow this list because it is a history filter, not an assignment
 * eligibility check (ADR 0037, ADR 0064, ADR 0192).
 */
export function useDriverOptions(enabled = true) {
  const { options, loading } = useDeferredOptions(driverOptionsQuery(), enabled, (data) =>
    data.items.map((driver) => ({ value: driver.id, label: driver.fullName })),
  );

  return {
    options: options ?? [],
    loading,
  };
}
