import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  isVehicleSubstitution,
  requestCargoTotal,
  type RequestHistoryEntryDto,
  type VehicleRequestDto,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
} from '@technic/contracts';
import { useRouteModal } from '@features/route-modal';
import { useAuth } from '@entities/session';
import {
  tripsCountLabel,
  vehicleRequestKeys,
  vehicleRequestLink,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { canOpenRoute } from '@entities/vehicle-route';
import type { HistoryRow } from '@entities/request-history';
import { useIsMobile } from '@shared/lib';

function toRows(history: RequestHistoryEntryDto[] | undefined): HistoryRow[] {
  return (history ?? []).map((entry) => ({ key: entry.id, entry }));
}

/** Load and derive every auxiliary value consumed by the request card presentation. */
export function useVehicleRequestViewData(
  request: VehicleRequestDto | null,
  readOnly: boolean | undefined,
  hasTransferAction: boolean,
) {
  const { can } = useAuth();
  const isMobile = useIsMobile();
  const { openRoute, openRoutesList } = useRouteModal();
  const [params] = useSearchParams();
  const openedRouteId = readOnly ? params.get('route') : null;
  const canTransfer = hasTransferAction && can('waybills.read') && can('vehicleRequests.status');
  const showAllRoutes = !readOnly && canOpenRoute(can);
  const requestListHref =
    request && readOnly
      ? vehicleRequestLink(can, {
          id: request.id,
          status: request.status,
          deleted: !!request.deletedAt,
        })
      : null;

  const { data: history, isPending } = useQuery({
    queryKey: vehicleRequestKeys.events(request?.id),
    queryFn: () => vehicleRequestsApi.history(request!.id),
    enabled: !!request,
  });
  const asksDriver = !!request?.assignment;
  const { data: driver, isPending: isDriverPending } = useQuery({
    queryKey: vehicleRequestKeys.driver(request?.id),
    queryFn: () => vehicleRequestsApi.driver(request!.id),
    enabled: asksDriver,
  });
  const asksWaybill = !!request && can('waybills.read');
  const { data: waybills } = useQuery({
    queryKey: vehicleRequestKeys.waybills(request?.id),
    queryFn: () => vehicleRequestsApi.waybills(request!.id),
    enabled: asksWaybill,
  });
  const asksRelocations =
    !!request && request.requestType === 'special_equipment' && can('waybills.read');
  const { data: relocations } = useQuery({
    queryKey: vehicleRequestKeys.relocations(request?.id),
    queryFn: () => vehicleRequestsApi.relocations(request!.id),
    enabled: asksRelocations,
  });

  const rows = useMemo(() => toRows(history), [history]);
  const weekly =
    request?.requestType === 'special_equipment' && can('weeklyRequests.read')
      ? {
          origin: request.weeklyOrigin ?? null,
          extensions: request.weeklyExtensions ?? [],
        }
      : null;
  const assignmentHint = useMemo(() => {
    const assignment = request?.assignment;
    if (!request || !assignment) return null;
    const substitution = vehicleSubstitutionOf(
      {
        vehicleKindId: request.vehicleKindId,
        vehicleTypeId: request.vehicleTypeId,
        vehicleCategoryId: request.vehicleCategoryId,
        categorySpecs: request.vehicleCategorySpecs,
      },
      {
        vehicleKindId: assignment.vehicleKindId,
        vehicleTypeId: assignment.vehicleTypeId,
        vehicleCategoryId: assignment.vehicleCategoryId,
        categorySpecs: assignment.categorySpecs,
      },
    );
    if (!isVehicleSubstitution(substitution)) return null;
    const hint = vehicleSubstitutionHint(substitution);
    return {
      label: [assignment.categoryName ?? assignment.typeName, hint].filter(Boolean).join(' · '),
      level:
        substitution.kindMismatch ||
        substitution.relation === 'smaller' ||
        substitution.relation === 'mixed'
          ? 'warning'
          : 'info',
    };
  }, [request]);

  const trips = request?.requestType === 'freight_transport' ? request.trips : null;
  const total = trips ? requestCargoTotal(trips) : null;
  const singleTrip =
    trips && trips.length === 1 && !trips[0]?.scheduledAt && !trips[0]?.comment
      ? (trips[0] ?? null)
      : null;
  const amountText = total
    ? [
        [
          total.volumeM3 != null ? `${total.volumeM3} м³` : null,
          total.weightTons != null ? `${total.weightTons} т` : null,
        ]
          .filter(Boolean)
          .join(' / ') || '—',
        total.trips > 1 ? tripsCountLabel(total.trips) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return {
    amountText,
    asksDriver,
    asksRelocations,
    assignmentHint,
    can,
    canTransfer,
    driver,
    isDriverPending,
    isMobile,
    isPending,
    openedRouteId,
    openRoute,
    openRoutesList,
    relocations,
    requestListHref,
    rows,
    showAllRoutes,
    singleTrip,
    trips,
    waybills,
    weekly,
  };
}
