import { useMemo, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canCancelWaybill,
  canCorrectRoute,
  canIssueWaybill,
  driverDocumentGapsWarning,
  isRelocationPurpose,
  isRouteEditable,
  moscowDateKeyOf,
  routeRequestCapacity,
  type VehicleRequestDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  waybillFormShortLabels,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import {
  assembleRoute,
  vehicleRouteErrorMessage as errorMessage,
  vehicleRouteKeys,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { useAuth } from '@entities/session';
import { isApiError } from '@shared/api';
import { useRouteWaybillCommands } from './useRouteWaybillCommands';

interface Args {
  /** null means the window is closed. */
  routeId: string | null;
  /** Invalidate every screen whose route-derived data can be visible below this window. */
  onChanged: () => void;
}

/**
 * Route card controller: who drives, with whom and in which order.
 *
 * The heart of the card is the visit order (RoutePointsBlock, section 4.3 of
 * docs/route-trips-plan.md): stops with arrows, roles and responsible people. The request list is
 * still there but with a different role: it adds and removes work rather than setting the order,
 * because print order is set by the points (R11), and arrows on the composition would no longer
 * move the document. What will be printed on the form is shown by the collapsed "Waybill task"
 * block.
 *
 * An issued waybill freezes the card: composition, points and driver are editable only before it,
 * because the form is already with the driver, and a record diverging from the paper in hand is
 * worse than no record (ADR 0037 item 9). To rebuild a route the waybill is cancelled, with the
 * same right and reason as in the journal.
 *
 * The child windows (correction, ticket transfer) live in this state, not in the host, because they
 * are opened only from the card and must die with it.
 */
export function useVehicleRouteWindow({ routeId, onChanged }: Args) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | undefined>();
  const [correcting, setCorrecting] = useState(false);
  /** The ticket being moved to another day's route retroactively (R30); null means closed. */
  const [transferring, setTransferring] = useState<VehicleRouteRequestDto | null>(null);

  /*
   * The route is always refetched when the card opens instead of being taken from cache (R18).
   *
   * The route version is raised not only by its own doors: a request edit redistributes its trips
   * across points and raises the ROUTE version, so a card left in cache with yesterday's version
   * would get 409 on the first action, and the person would see "route changed" where they changed
   * nothing. The shared ten-second freshness (staleTime in main.tsx) is not enough: a second passes
   * between editing the request and returning to the card.
   */
  const { data: route, isFetching } = useQuery({
    queryKey: vehicleRouteKeys.detail(routeId),
    queryFn: () => vehicleRoutesApi.get(routeId!),
    enabled: !!routeId,
    staleTime: 0,
    refetchOnMount: 'always',
    // A neighbouring portal browser tab is the same case: the request is edited there, the action
    // is done here.
    refetchOnWindowFocus: true,
  });
  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  /*
   * What can be put into this route: freight requests in work on own vehicles, delivered on the
   * same day. The selection mirrors what the server checks, otherwise the list would offer requests
   * it rejects.
   *
   * The ordered vehicle type does not narrow the list (ADR 0059): a vehicle's day is assembled by
   * sites, and sites order different things, a dump truck and a flatbed. Such a request used to be
   * refused, and the second site had to be served by a separate route. A mismatch with the route's
   * vehicle is marked in the option row.
   *
   * Requests of other routes are included alongside free ones: moving a request from R-7 to R-9 is
   * one transfer action, not "remove and add" in two steps between which the request hangs without
   * a route. Excluded are only requests whose route is frozen by an issued waybill: a request
   * cannot vanish from the paper the driver holds.
   */
  const { data: candidates } = useQuery({
    queryKey: vehicleRequestKeys.forRoute(route?.routeDate),
    queryFn: () =>
      vehicleRequestsApi.list({
        status: 'confirmed',
        requestType: 'freight_transport',
        dateFrom: route!.routeDate,
        dateTo: route!.routeDate,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!route && !frozen,
  });
  const free = (candidates?.items ?? []).filter(
    (request: VehicleRequestDto) =>
      request.assignment?.ownership === 'own' &&
      request.route?.id !== route?.id &&
      !(request.route && request.route.hasWaybill),
  );

  const afterChange = (updated: VehicleRouteDto) => {
    qc.setQueryData(vehicleRouteKeys.detail(updated.id), updated);
    onChanged();
  };
  /*
   * A refusal in words, plus a refetch when it is about the version. A route 409 means one of two
   * things: the version moved (someone edited the route or a request, R18) or the waybill has just
   * been issued (ROUTE_FROZEN_MESSAGE). Either way the screen is stale, and leaving it would doom
   * the person to the same refusal again with the same version. The whole key family is
   * invalidated: the card, the route list and route suggestions read the same data.
   */
  const fail = (error: unknown) => {
    message.error(errorMessage(error));
    if (isApiError(error) && error.status === 409) {
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    }
  };

  // The request picked in the add list: its route tells "add" from "move".
  const candidate = free.find((request) => request.id === adding) ?? null;
  const attach = useMutation({
    mutationFn: (requestId: string) => {
      const source = free.find((request) => request.id === requestId)?.route ?? null;
      return vehicleRoutesApi.attach(route!.id, {
        requestId,
        version: route!.version,
        // A transfer touches two routes, and the source is identified by the pair "id + version":
        // versions are numbered per route, and a lone version could match by accident.
        source: source ? { routeId: source.id, version: source.version } : undefined,
      });
    },
    onSuccess: (updated) => {
      setAdding(undefined);
      afterChange(updated);
    },
    onError: fail,
  });
  const detach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.detach(route!.id, requestId, route!.version),
    onSuccess: afterChange,
    onError: fail,
  });

  /*
   * What the route's driver lacks for the form (ADR 0064): issuing is not stopped, but the SNILS or
   * licence-number column will stay empty, and a waybill with an empty column is invalid. The
   * document kind is hard-wired to the driver's licence: driverGaps does not carry it, and 4-P and
   * form No. 3 are driven by a driver (ADR 0095).
   */
  const formLabel = route?.formCode ? waybillFormShortLabels[route.formCode] : null;
  const driverGaps = route
    ? driverDocumentGapsWarning(route.driverGaps, 'driver_license', formLabel)
    : null;
  // A route without requests: its waybill is issued as an empty form (ADR 0071).
  const blank = !!route && !isRelocationPurpose(route.purpose) && route.requests.length === 0;
  const past = !!route && route.routeDate < moscowDateKeyOf(new Date());

  const { issue, confirmIssue, confirmCancelWaybill } = useRouteWaybillCommands({
    route,
    blank,
    driverGaps,
    past,
    afterChange,
    fail,
    onChanged,
  });

  const readiness = route
    ? canIssueWaybill({
        purpose: route.purpose,
        driverPersonId: route.driverPersonId,
        // An empty form is an administrator right (ADR 0071), asked by the same rule as on the
        // server: otherwise the button would promise what the endpoint will not do.
        blankAllowed: can('waybills.issueBlank'),
        formCode: route.formCode,
        requests: route.requests,
        sourceRequest: route.sourceRequest,
        waybillStatus: route.waybill?.status ?? null,
      })
    : null;
  // A relocation has no composition; its task is printed from the route itself.
  const relocation = !!route && isRelocationPurpose(route.purpose);
  // A separate variable because type narrowing does not survive into onActivate: the handler runs
  // later, and TS no longer knows the field is non-null.
  const sourceRequest = route?.sourceRequest ?? null;
  /*
   * The assembled day: task rows, issue blockers and merge hints come from one read of the points
   * (section 4.3, R11a), computed by the same contracts code the server answers with: two
   * computations of one rule would drift on the first edit, and the card would promise something
   * other than what goes on paper.
   *
   * useMemo is not about speed: the visit list, the "Waybill task" block and point labels read the
   * same result, and recomputing it three times per render would lay rows out on the form thrice.
   */
  const assembly = useMemo(() => (route ? assembleRoute(route) : null), [route]);
  /*
   * The first assembly refusal issuing cannot survive: broken order, an unplaced row, an overfilled
   * form, a row that does not fit (R11a). They disable the issue button: the server answers them
   * with 422, and a button promising a waybill would promise a refusal.
   *
   * no_driver is excluded: canIssueWaybill answers about the driver with its first refusal and the
   * same words the button tooltip shows. One gap must not get two wordings.
   */
  const blocking = assembly?.blockers.find((item) => item.code !== 'no_driver') ?? null;
  /*
   * Whether there is room for one more request. How many task rows a route has is decided by its
   * form (ADR 0068): seven on 4-P, ten on form No. 3.
   */
  const canAddRequest =
    !!route &&
    !relocation &&
    !frozen &&
    route.requests.length < routeRequestCapacity(route.formCode);
  const waybillEditable =
    !!route?.waybill &&
    route.waybill.status === 'issued' &&
    // A route waybill has no period; its boundary is the departure day (ESM-2 never gets here:
    // a week of a vehicle on site has no route at all).
    canCancelWaybill(route.waybill, moscowDateKeyOf(new Date()));
  /*
   * Retroactive correction (ADR 0101, R2) is the button of a past day.
   *
   * Today's route does not need it: until the day ends the waybill is cancelled the normal way, the
   * route unfreezes and is edited with the neighbouring button. A past day cannot be fixed that
   * way; that is where correction starts: its own right, a mandatory reason, a burnt number.
   *
   * Readiness uses the server's rule (canCorrectRoute), otherwise the button would promise what the
   * endpoint will not do. When disabled it explains itself: with a closed request in the
   * composition correction becomes a joint job (R38), and the person must know whom to go to.
   */
  const correction =
    route && past && can('waybills.correct')
      ? canCorrectRoute(route, moscowDateKeyOf(new Date()), {
          unlimited: can('waybills.correctBeyondLimit'),
        })
      : null;

  return {
    adding,
    afterChange,
    assembly,
    attach,
    blocking,
    canAddRequest,
    candidate,
    confirmCancelWaybill,
    confirmIssue,
    correcting,
    correction,
    detach,
    driverGaps,
    fail,
    free,
    frozen,
    isFetching,
    issue,
    readiness,
    relocation,
    route,
    setAdding,
    setCorrecting,
    setTransferring,
    sourceRequest,
    transferring,
    waybillEditable,
  };
}

export type VehicleRouteWindowController = ReturnType<typeof useVehicleRouteWindow>;
