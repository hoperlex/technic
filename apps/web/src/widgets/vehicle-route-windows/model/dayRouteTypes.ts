import type { SpecialEquipmentRequestDto, VehicleRequestDaysDto } from '@technic/contracts';

export interface VehicleDayRouteModalProps {
  /**
   * The request and the day being put into a route; null means the window is closed. The day table
   * has already checked the request with canPlanDay (on-site equipment order, in work, own vehicle),
   * so the window does not repeat that pre-check.
   *
   * onDate is the cut-off day computed by the server (VehicleRequestDaysDto.onDate), and only it
   * decides whether the day is in the past. The browser clock may be wrong, and the form must not
   * diverge from backdateGuard: it would either skip the reason where the endpoint requires one or
   * demand it where the server does not.
   */
  target: { request: SpecialEquipmentRequestDto; date: string; onDate: string } | null;
  onClose: () => void;
  /** The plan after scheduling: the caller runs the day table and owns its cache. */
  onDone: (days: VehicleRequestDaysDto) => void;
}

export interface DayRouteFormValues {
  vehicleId?: string;
  /** Existing route id or the NEW_ROUTE sentinel. */
  routeId?: string;
  driverPersonId?: string;
  /**
   * Trailer fields of a new route. Before stage E4 the window did not ask for them and forwarded
   * them blindly, so a route left with a trailer the user never saw
   * (docs/vehicle-trailers-plan.md, section 4.2.2).
   */
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  /** Backdate reason, asked only for a past day (ADR 0101 item 4). */
  reason?: string;
}
