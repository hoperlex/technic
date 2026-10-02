import type { ReactNode } from 'react';
import type { VehicleRouteDto } from '@technic/contracts';

export interface RouteListRenderProps {
  focusDate?: string;
  focusToken: number;
  onChanged: () => void;
  onClose: () => void;
}

export interface RouteCardRenderProps {
  routeId: string;
  onChanged: () => void;
  onClose: () => void;
  onEdit: (route: VehicleRouteDto) => void;
}

export interface RouteEditRenderProps {
  route: VehicleRouteDto;
  onClose: () => void;
  onSaved: (route: VehicleRouteDto) => void;
}

export interface RequestCardRenderProps {
  requestId: string;
  onClose: () => void;
}

export interface RouteModalHostProps {
  renderRouteList: (props: RouteListRenderProps) => ReactNode;
  renderRouteCard: (props: RouteCardRenderProps) => ReactNode;
  renderRouteEdit: (props: RouteEditRenderProps) => ReactNode;
  renderRequestCard: (props: RequestCardRenderProps) => ReactNode;
}
