import { useCallback, useEffect, useMemo, useState } from 'react';
import { App } from 'antd';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { VehicleRequestDto, VehicleRouteDto } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { canOpenRoute, vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { useOpenedRecord } from '@shared/lib';
import type { RouteModalApi, RouteModalWindowsState } from './context';

/*
 * A route, the route list and a request open as windows over whatever page asked about them
 * (ADR 0120, plan docs/vehicle-routes-modal-plan.md). There is no "Routes" tab any more: the
 * question "what is that route" is asked from a request row, the garage day view or the waybill
 * journal, and answering it used to cost leaving the screen, losing its filters and finding the way
 * back. That is why the host sits above every portal page (App.tsx) and callers know it only through
 * the commands of RouteModalApi.
 *
 * The URL is the only window state: openRoute is a parameter write and nothing more. Mirror it in
 * React state and Back would diverge from the screen on the first navigation, and the route link
 * that is mailed out and bookmarked would have nowhere to come from.
 */

/*
 * These names must match what vehicleRoutePath, VEHICLE_ROUTES_PATH and vehicleRequestViewPath
 * print in packages/contracts/src/links.ts. The address is built there (mail digests print it too)
 * and parsed here; if the two sides drift, a link from a letter opens an empty page.
 */
const ROUTE_PARAM = 'route';
const LIST_PARAM = 'routes';
const REQUEST_PARAM = 'request';

/** Own the three URL-backed record windows and their non-addressable edit child. */
export function useRouteModalState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  /*
   * A route belongs to whoever runs requests and sees the driver: the same condition guards the
   * route endpoints and every link leading here (canOpenRoute in @entities/vehicle-route). The
   * request is checked separately because mechanics have the waybill journal and the garage but no
   * requests at all.
   */
  const mayOpenRoute = canOpenRoute(can);
  const mayOpenRequest = can('vehicleRequests.read');

  const openedRoute = useOpenedRecord<VehicleRouteDto>({
    /*
     * Without the right the record cannot be shown anyway, but the request would still reach the
     * server and fail: a second message, "route not found", would land over the access message and
     * explain the wrong thing.
     */
    active: mayOpenRoute,
    param: ROUTE_PARAM,
    notFoundMessage: 'Маршрут не найден',
    // Shared with the route card so react-query issues one request for both.
    queryKey: (id) => vehicleRouteKeys.detail(id),
    fetch: (id) => vehicleRoutesApi.get(id),
  });
  /*
   * "Not found OR unavailable": the server answers the same 404 for a request outside the caller's
   * visibility scope and for a deleted request without archive.read. Plain "not found" on an
   * existing request would read as data loss.
   */
  const openedRequest = useOpenedRecord<VehicleRequestDto>({
    active: mayOpenRequest,
    param: REQUEST_PARAM,
    notFoundMessage: 'Заявка не найдена или недоступна',
    queryKey: (id) => vehicleRequestKeys.detail(id),
    fetch: (id) => vehicleRequestsApi.get(id),
  });
  const routeParam = searchParams.get(ROUTE_PARAM);
  const listParam = searchParams.get(LIST_PARAM);
  const requestParam = searchParams.get(REQUEST_PARAM);

  /*
   * Remove only our own keys: the page under the window keeps its tab, its opened card (open), its
   * page number and its filters, and all of them must survive opening and closing the window. Hence
   * the functional form, the same technique useOpenedRecord.clear uses.
   *
   * replace: true so that Back after closing with the cross or Esc returns to where the user came
   * from instead of reopening the window.
   */
  const dropParams = useCallback(
    (names: readonly string[]) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const name of names) next.delete(name);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /*
   * Normalization, first gate: route and routes are mutually exclusive. A hand-built URL or an old
   * bookmark may carry both; route wins as the more specific ask. The extra key is dropped here, in
   * one branch, instead of being checked at every call site.
   */
  useEffect(() => {
    if (routeParam && listParam !== null) dropParams([LIST_PARAM]);
  }, [routeParam, listParam, dropParams]);

  /*
   * Second gate: the right. The parameter is dropped, the window does not open and a message is
   * shown, because a key silently vanishing from the URL reads as a broken portal. The same path
   * handles losing the right on the fly: a new grant set arrives with a session refresh, and a
   * window opened before it must close by itself.
   */
  useEffect(() => {
    if (mayOpenRoute || (!routeParam && listParam === null)) return;
    message.error('Маршруты вам недоступны');
    dropParams([ROUTE_PARAM, LIST_PARAM]);
  }, [mayOpenRoute, routeParam, listParam, message, dropParams]);

  useEffect(() => {
    if (mayOpenRequest || !requestParam) return;
    message.error('Заявки на технику вам недоступны');
    dropParams([REQUEST_PARAM]);
  }, [mayOpenRequest, requestParam, message, dropParams]);

  /*
   * The list is open only when no route card is in the URL: the same exclusivity as the first gate,
   * but computed during render. Waiting for the effect to clean the URL is not enough: the user
   * would see a frame with both windows before normalization.
   */
  const listOpen = mayOpenRoute && !routeParam && listParam !== null;
  /*
   * Where the list should land when opened. Deliberately not written to the URL: it is a one-off
   * request, not state, and in a bookmark it would mean "always jump to this day".
   *
   * The token is a call counter rather than the date itself: the list sets its period in an effect
   * keyed by it, and a repeated "All routes" with the same day must bring the period back after the
   * user moved it to another month. Keyed by the date value, the second call would not fire at all.
   */
  const [focus, setFocus] = useState<{ date?: string; token: number }>({ token: 0 });
  /*
   * The route opened for header edit and the window that asked for it (ownerRouteId === null means
   * the list). Like the other child windows (correction, ticket transfer, creation) the edit is not
   * reflected in the URL: it is a step inside a window, not a place people link to. The owner is
   * stored with the route because the edit has two doors that close differently (see the reset
   * effect below).
   */
  const [editing, setEditing] = useState<{
    route: VehicleRouteDto;
    ownerRouteId: string | null;
  } | null>(null);

  /*
   * After a route edit the whole screen under the window is stale, because routes are now edited
   * from the waybill journal and the garage day view, not only from the route list. The request list
   * shows the route number and the "no route" warning; the waybill journal because a waybill is born
   * by the route endpoint and an edit of composition or date rewrites an issued one; the garage
   * because a vehicle's and driver's daily occupancy is exactly the routes.
   */
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void qc.invalidateQueries({ queryKey: waybillKeys.root });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  }, [qc]);

  /*
   * A route over the current page. A request overlay yields to the route: placing the route under it
   * would open an invisible window. Both edits go in ONE setSearchParams write: two calls in a row
   * would produce an intermediate frame with both parameters and an extra history entry, and Back
   * would return to that frame instead of the request the user left.
   *
   * History policy: replace only on list -> card, otherwise the "list <-> card" cycle grows history
   * without bound. Displacing a request is a single push: Back must bring the request back. A click on
   * a number on a regular page is a push too: there Back is expected to close the window.
   */
  const openRoute = useCallback(
    (routeId: string) => {
      const replace = !requestParam && listParam !== null;
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(LIST_PARAM);
          next.delete(REQUEST_PARAM);
          next.set(ROUTE_PARAM, routeId);
          return next;
        },
        { replace },
      );
    },
    [listParam, requestParam, setSearchParams],
  );

  /*
   * The route list displaces a request for the same reason as the card: "All routes" is offered from
   * the read-only request card too, and a request left on top would hide the list.
   *
   * History policy: replace on card -> list (the same cycle) and on a repeated focus while the list
   * is already open, where the URL does not change and a new entry would be empty. push when opening
   * from a regular page and when displacing a request.
   */
  const openRoutesList = useCallback(
    (options?: { focusDate?: string }) => {
      setFocus((previous) => ({ date: options?.focusDate, token: previous.token + 1 }));
      const replace = !requestParam && (!!routeParam || listParam !== null);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(ROUTE_PARAM);
          next.delete(REQUEST_PARAM);
          next.set(LIST_PARAM, '1');
          return next;
        },
        { replace },
      );
    },
    [listParam, requestParam, routeParam, setSearchParams],
  );

  // A request overlays a route/list without touching their keys, so Back reveals the exact record
  // underneath it rather than the bare page.
  const openRequest = useCallback(
    (requestId: string) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set(REQUEST_PARAM, requestId);
        return next;
      });
    },
    [setSearchParams],
  );

  /*
   * Header edit of a route: day, driver, header fields. It has two doors: the route card, and the
   * list row directly, because "move the day" and "change the driver" are the dispatcher's morning
   * actions that do not justify opening the card. The second door is why edit is part of the
   * contract: the window lives here and is called from outside.
   *
   * A route frozen by an issued waybill never gets here and is deliberately not re-checked: both
   * call sites ask isRouteEditable and disable the button with ROUTE_FROZEN_MESSAGE, and the form
   * itself refuses to save such a route. A third copy of the rule would give a third answer to "is
   * this route editable" and drift from the others on the first model change.
   *
   * The owner is the window open right now: the card names itself by id, the list (no route in the
   * URL) stays null.
   */
  const editRoute = useCallback(
    (route: VehicleRouteDto) => setEditing({ route, ownerRouteId: openedRoute.id }),
    [openedRoute.id],
  );
  const api = useMemo<RouteModalApi>(
    () => ({ openRoute, openRoutesList, openRequest, editRoute }),
    [openRoute, openRoutesList, openRequest, editRoute],
  );

  /*
   * When the window that opened the edit goes away, the edit goes too. The card's own child windows
   * die with it (they live in its state and unmount with it), but the edit lives here, outside both
   * windows: Back with the form open would leave it hanging over an empty page, and with the fields
   * of a foreign route if the user then opens the neighbouring one. Unsaved fields are lost exactly
   * as when the window is closed with the cross.
   *
   * The owner must be compared by identity, and that is the point of this effect. An edit opened from
   * a list row has no route in the URL at all, so comparing with it would close the form in the same
   * frame it opened. The list is therefore checked by its own flag (listOpen) and the card by its id,
   * which also catches switching to a neighbouring route.
   */
  useEffect(() => {
    if (!editing) return;
    const ownerAlive =
      editing.ownerRouteId === null ? listOpen : editing.ownerRouteId === openedRoute.id;
    if (!ownerAlive) setEditing(null);
  }, [editing, listOpen, openedRoute.id]);

  const finishEdit = useCallback(
    (updated: VehicleRouteDto) => {
      setEditing(null);
      refresh();
      /*
       * A route moved to another date drops out of the list period, and the user must see it where
       * it was moved instead of guessing where it went. Only with the list open: the edit is also
       * called from the route card, which is mutually exclusive with the list, and the focus would
       * replace the very window the user is standing in with the list.
       */
      if (listOpen) openRoutesList({ focusDate: updated.routeDate });
    },
    [listOpen, openRoutesList, refresh],
  );

  const windows = useMemo<RouteModalWindowsState>(
    () => ({
      listOpen,
      focus,
      routeId: openedRoute.id,
      editing: editing?.route ?? null,
      refresh,
      closeRoutesList: () => dropParams([LIST_PARAM]),
      closeRoute: openedRoute.clear,
      editRoute,
      closeEdit: () => setEditing(null),
      finishEdit,
    }),
    [
      listOpen,
      focus,
      openedRoute.id,
      openedRoute.clear,
      editing,
      refresh,
      dropParams,
      editRoute,
      finishEdit,
    ],
  );

  return {
    api,
    openedRequest,
    windows,
  };
}

export type RouteModalState = ReturnType<typeof useRouteModalState>;
