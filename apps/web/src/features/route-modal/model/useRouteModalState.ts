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
import type { RouteModalApi } from './context';

const ROUTE_PARAM = 'route';
const LIST_PARAM = 'routes';
const REQUEST_PARAM = 'request';

/** Own the three URL-backed record windows and their non-addressable edit child. */
export function useRouteModalState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayOpenRoute = canOpenRoute(can);
  const mayOpenRequest = can('vehicleRequests.read');

  const openedRoute = useOpenedRecord<VehicleRouteDto>({
    active: mayOpenRoute,
    param: ROUTE_PARAM,
    notFoundMessage: 'Маршрут не найден',
    queryKey: (id) => vehicleRouteKeys.detail(id),
    fetch: (id) => vehicleRoutesApi.get(id),
  });
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

  // Only these three keys belong to this feature; page filters must survive every window action.
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

  // A concrete route wins over the list when an old or hand-built URL contains both.
  useEffect(() => {
    if (routeParam && listParam !== null) dropParams([LIST_PARAM]);
  }, [routeParam, listParam, dropParams]);

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

  const listOpen = mayOpenRoute && !routeParam && listParam !== null;
  // The token lets a repeated request refocus the same date after the user moved the period.
  const [focus, setFocus] = useState<{ date?: string; token: number }>({ token: 0 });
  const [editing, setEditing] = useState<{
    route: VehicleRouteDto;
    ownerRouteId: string | null;
  } | null>(null);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void qc.invalidateQueries({ queryKey: waybillKeys.root });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  }, [qc]);

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

  // A request overlays a route/list, so Back can reveal the exact record underneath it.
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

  const editRoute = useCallback(
    (route: VehicleRouteDto) => setEditing({ route, ownerRouteId: openedRoute.id }),
    [openedRoute.id],
  );
  const api = useMemo<RouteModalApi>(
    () => ({ openRoute, openRoutesList, openRequest, editRoute }),
    [openRoute, openRoutesList, openRequest, editRoute],
  );

  // An edit child cannot outlive the route card/list that opened it.
  useEffect(() => {
    if (!editing) return;
    const ownerAlive =
      editing.ownerRouteId === null ? listOpen : editing.ownerRouteId === openedRoute.id;
    if (!ownerAlive) setEditing(null);
  }, [editing, listOpen, openedRoute.id]);

  const finishEdit = (updated: VehicleRouteDto) => {
    setEditing(null);
    refresh();
    // A moved route must remain visible in the list at its new date.
    if (listOpen) openRoutesList({ focusDate: updated.routeDate });
  };

  return {
    api,
    closeEdit: () => setEditing(null),
    closeRoutesList: () => dropParams([LIST_PARAM]),
    editing,
    finishEdit,
    focus,
    listOpen,
    openedRequest,
    openedRoute,
    refresh,
  };
}

export type RouteModalState = ReturnType<typeof useRouteModalState>;
