import type { SpecialEquipmentRequestDto, VehicleRequestDaysDto } from '@technic/contracts';

export interface VehicleDayRouteModalProps {
  /** Server `onDate` is the only clock used to decide whether the reason is required. */
  target: { request: SpecialEquipmentRequestDto; date: string; onDate: string } | null;
  onClose: () => void;
  onDone: (days: VehicleRequestDaysDto) => void;
}

export interface DayRouteFormValues {
  vehicleId?: string;
  /** Existing route id or the `NEW_ROUTE` sentinel. */
  routeId?: string;
  driverPersonId?: string;
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  reason?: string;
}
