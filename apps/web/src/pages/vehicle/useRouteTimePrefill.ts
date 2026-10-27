import { useQuery } from '@tanstack/react-query';
import {
  routeTimePrefill,
  type RouteTimePrefill,
  type VehicleRequestDto,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';

/**
 * What the completion window of a freight request starts from (readings-shifts-merge plan §8, D7,
 * D12): the request's share of the recorded route time, rounded up to a whole hour, or the reason
 * there is none. `null` — not a freight request, or the answer has not arrived yet.
 *
 * The same key as the card's «Факт по точкам»: a card opened before the window hands its answer
 * over from the cache, and both read one number. The rounding and the reasons are the contracts'
 * (`routeTimePrefill`), so the window cannot propose a figure the card does not explain.
 */
export function useRouteTimePrefill(request: VehicleRequestDto | null): RouteTimePrefill | null {
  const freight = !!request && request.requestType === 'freight_transport';
  const { data } = useQuery({
    queryKey: vehicleRequestKeys.routeTime(request?.id),
    queryFn: () => vehicleRequestsApi.routeTime(request!.id),
    enabled: freight,
  });
  return freight && data ? routeTimePrefill(data) : null;
}
