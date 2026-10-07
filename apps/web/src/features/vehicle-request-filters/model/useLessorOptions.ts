import { useQuery } from '@tanstack/react-query';
import { counterpartyVehicleLessorOptionsQuery } from '@entities/counterparty';

/**
 * Lessors for the journal filter: counterparties with the "vehicle lessor" role, which rental costs
 * are grouped by. Inactive ones stay in the list because the journal is read about partners the
 * company no longer works with.
 */
export function useLessorOptions() {
  const { data, isFetching } = useQuery({
    ...counterpartyVehicleLessorOptionsQuery(),
  });
  return {
    options: (data?.items ?? []).map((counterparty) => ({
      value: counterparty.id,
      label: counterparty.name,
    })),
    loading: isFetching,
  };
}
