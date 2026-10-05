import type { ReactNode } from 'react';
import type { SpecialEquipmentRequestDto, VehicleRequestDto } from '@technic/contracts';

/**
 * Every action is an optional prop: not passing it is how the action is hidden (role, status or
 * archive forbid it), and that is also what makes the URL-backed overlay read-only.
 */
export interface VehicleRequestViewModalProps {
  /** null means the window is closed; fields come from the list row, no extra request is needed. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  onEdit?: (request: VehicleRequestDto) => void;
  /**
   * Create a new request with the same composition (ADR 0173; any status since ADR 0206). Offered
   * for a non-deleted request to someone allowed to create requests of this type. The button lives
   * in the card, not the row, for the same reason as vehicle change: whether to repeat an order is
   * decided after reading all of it (addresses, cargo, contact, note), and the row shows half of
   * that.
   */
  onCopy?: (request: VehicleRequestDto) => void;
  /**
   * Change the assigned vehicle (ADR 0048). Absent when unavailable: a "New" request gets its
   * vehicle by being taken into work, a closed one no longer changes it, and not everyone who reads
   * the request picks equipment.
   */
  onReassign?: (request: VehicleRequestDto) => void;
  /**
   * Change the machinist within the request term and view the crew by date
   * (docs/assignment-periods-plan.md, section 9). Absent when unavailable: a linear order names the
   * machinist when each waybill is issued, not on the request (ADR 0100 section 6); on a rented
   * vehicle the lessor keeps the form; a closed request has already been invoiced.
   */
  onChangeMachinist?: (request: VehicleRequestDto) => void;
  /**
   * Move the request to another route (ADR 0052). Absent when unavailable: routes are run by
   * whoever runs dispatch, while many people read the card. The card additionally requires both
   * route permissions before showing the button (see useVehicleRequestViewData).
   */
  onTransfer?: (request: VehicleRequestDto) => void;
  /**
   * Create a relocation: delivery to the site or pickup from it (migration 0082). Absent when there
   * is nothing to create it with: the request is not in work, has no vehicle, or the role has no
   * route rights.
   */
  onRelocate?: (request: VehicleRequestDto, purpose: 'delivery' | 'pickup') => void;
  /**
   * Issue a weekly ESM-2 on demand (ADR 0100 decision 6). Absent when unavailable: for a regular
   * order the portal issues waybills itself, for a linear one only while it is in work on an own
   * vehicle, and not everyone who reads the card manages forms.
   */
  onIssueEsm2?: (request: VehicleRequestDto) => void;
  /**
   * Early-end decision buttons (ADR 0044). A function, not a flag: availability depends on both the
   * role and the request state, which the tab knows and the card does not. Absent: the early-end
   * request is shown read-only like everything else.
   */
  earlyEndActions?: (request: VehicleRequestDto) => ReactNode;
  /**
   * Read-only overlay: the card was opened over a foreign screen (route composition, waybill task,
   * waybill journal, garage), ADR 0120 item 7. Actions are not offered there: each pulls its own
   * request-tab window (assignment and five more), and a host taking them over would become half of
   * that tab. The footer's "Open in request list" leads to them instead.
   *
   * A separate flag rather than just "pass no actions", because props do not close everything: the
   * card mounts the "Work days" tab itself, and day planning and removing a day from a route live
   * inside it with their own mutations, gated by exactly the right that opens a route
   * (vehicleRequests.status && waybills.read). A dispatcher looking into the request from a route
   * would otherwise get a working planner without doing anything.
   *
   * What the mode does NOT hide is decided explicitly: the "Work days" tab stays (it answers "which
   * route carries which day", the reason to open the request from a route), and waybill printing
   * stays (printing is reading, and whoever opened the route has waybills.read).
   */
  readOnly?: boolean;
  /**
   * The "Work days" tab. Injected because VehicleRequestDays still lives in pages/vehicle, and
   * widgets may not import pages; it must honour readOnly (see above).
   */
  renderDays: (request: SpecialEquipmentRequestDto, readOnly: boolean | undefined) => ReactNode;
  /**
   * Path of the weekly request page. Still injected by the page adapter, although weeklyRequestPath
   * now lives in @entities/weekly-request and could be imported here directly.
   */
  weeklyRequestPath: (id: string) => string;
}
