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
  /*
   * The route open underneath: the request is read over the card of its own route
   * (?route=X&request=Y), and then that route's number is rendered as text in all three places the
   * card names it, because a link would open what already lies under the window (ADR 0120 item 3).
   * In every other case going to a route displaces the request, which the URL host handles.
   *
   * Taken from the URL rather than React state because the URL is the window state: the host keeps
   * no second copy on purpose, or Back and the screen would diverge on the first navigation. Only
   * asked in the overlay: in a list card a route in the URL is a foreign route opened under the
   * list and has nothing to do with this request.
   *
   * 'route' is ROUTE_PARAM of useRouteModalState in @features/route-modal, which is not exported;
   * both must match vehicleRoutePath in packages/contracts/src/links.ts. Rename one and a request
   * opened over its route would offer a link to the window already underneath.
   */
  const [params] = useSearchParams();
  const openedRouteId = readOnly ? params.get('route') : null;
  /*
   * Transfer needs both permissions at once, like every route operation: an external lessor also
   * has vehicleRequests.status (ADR 0038), while the picker lists foreign routes and the names of
   * own-fleet drivers.
   */
  const canTransfer = hasTransferAction && can('waybills.read') && can('vehicleRequests.status');
  /*
   * "All routes" is one of three doors to the route list (next to the route row, in the section
   * toolbar and in the route card). It is here because people go to the list from here: to see what
   * the vehicle is busy with that day and to find a route to put the request in. The right is the
   * one that opens a route: the list shows the same foreign vehicles and own-fleet driver names.
   * The overlay has no button: a window over a window over a window is unreadable, and the reader
   * already has the list where they opened the request from.
   */
  const showAllRoutes = !readOnly && canOpenRoute(can);
  /*
   * Target of the footer's "Open in request list": the section tab with this request's card open.
   * Computed from the loaded DTO, not the status alone: deletedAt picks the tab too (a deleted
   * request lives in the archive), and the archive is closed by archive.read. For a role without it
   * the function returns null and the footer shows no button at all.
   */
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
  /*
   * Everyone who opened the request sees the driver contact (ADR 0122): the customer receives the
   * vehicle and must be able to call. The row has no permission of its own; the request permission
   * that guards the endpoint replaces it. A separate query because the contact is not a DTO field.
   */
  const asksDriver = !!request?.assignment;
  const { data: driver, isPending: isDriverPending } = useQuery({
    queryKey: vehicleRequestKeys.driver(request?.id),
    queryFn: () => vehicleRequestsApi.driver(request!.id),
    enabled: asksDriver,
  });
  /*
   * Waybills issued for the request (ADR 0041) are printed from here without going to the journal:
   * the dispatcher takes the request into work and hands over the form right away. Without
   * waybills.read the role is not shown the driver's personal data (ADR 0037 item 13).
   *
   * Asked for both request kinds: an on-site equipment order has documents too, weekly ESM-2, one
   * per week of the term (migration 0087), hence a list.
   */
  const asksWaybill = !!request && can('waybills.read');
  const { data: waybills } = useQuery({
    queryKey: vehicleRequestKeys.waybills(request?.id),
    queryFn: () => vehicleRequestsApi.waybills(request!.id),
    enabled: asksWaybill,
  });
  /*
   * Relocations (migration 0082) exist only for on-site equipment orders; for freight the route
   * itself is the work. Empty means none was created: a low-loader delivery is a legitimate path,
   * not a gap.
   */
  const asksRelocations =
    !!request && request.requestType === 'special_equipment' && can('waybills.read');
  const { data: relocations } = useQuery({
    queryKey: vehicleRequestKeys.relocations(request?.id),
    queryFn: () => vehicleRequestsApi.relocations(request!.id),
    enabled: asksRelocations,
  });

  const rows = useMemo(() => toRows(history), [history]);
  /*
   * Where the order came from and how it was extended (docs/adr/0085-weekly-vehicle-request.md, R11
   * and R16). Arrives in the DTO itself. Only for those with access to the weekly section (a link
   * ending in a refusal is worse than a plain number) and only for on-site equipment: weekly
   * requests have nothing to do with freight, which has a delivery moment rather than a work
   * period.
   */
  const weekly =
    request?.requestType === 'special_equipment' && can('weeklyRequests.read')
      ? {
          origin: request.weeklyOrigin ?? null,
          extensions: request.weeklyExtensions ?? [],
        }
      : null;
  /*
   * How the assigned vehicle differs from what was ordered (ADR 0045, ADR 0059, ADR 0064), shown as
   * a tag next to the vehicle. The rule is the one of the assignment window: one wording for the
   * choice, the card and the history.
   */
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
        // A foreign kind is the largest mismatch and gets the warning tag regardless of specs: a
        // dump truck and a truck crane have nothing comparable.
        substitution.kindMismatch ||
        substitution.relation === 'smaller' ||
        substitution.relation === 'mixed'
          ? 'warning'
          : 'info',
    };
  }, [request]);

  // Request trips (R1, R2); null for an on-site equipment order, which never has them.
  const trips = request?.requestType === 'freight_transport' ? request.trips : null;
  const total = trips ? requestCargoTotal(trips) : null;
  /*
   * A trip the card may show as the familiar field pair instead of a table: the only one, and
   * carrying nothing the pair has no place for. Its own delivery time (R3) and note are exactly
   * what the pair cannot say, and hiding them is not allowed ("at what time exactly", "sand, call
   * an hour ahead" are why they were filled). Backfilled trips have both empty (migration 0136 does
   * not fill them), so a request created before multi-trip requests looks exactly as it did.
   */
  const singleTrip =
    trips && trips.length === 1 && !trips[0]?.scheduledAt && !trips[0]?.comment
      ? (trips[0] ?? null)
      : null;
  /*
   * "60 m3 / 5 t · 6 trips": the quantity for the whole request. Both units are printed side by
   * side rather than via tripCargoLabel, which returns what fits the waybill column (volume, else
   * mass): a mixed request, part in cubic metres and part in tonnes, would lose half the order in
   * the card. The trip count is attached because "60 m3" alone is indistinguishable from one trip
   * of sixty cubic metres.
   */
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
