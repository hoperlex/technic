/**
 * Domain transformations of the vehicle-request editor. The visual host lives in a widget because
 * it composes the existing address and request-customer features; this slice owns the command
 * values, trip bodies and copy semantics without reaching sideways into those features.
 */
export {
  copyFormValues,
  copyScheduledPlan,
  copyTermPlan,
  editFormValues,
  scheduledMoment,
  tripsNeedExpanding,
} from './model/requestFormValues';
export type { CopySource, FormValues } from './model/requestFormValues';
export {
  blankTrip,
  copyTrip,
  editTripBody,
  newTripBody,
  repeatTrip,
  tripNeedsList,
  tripToForm,
} from './model/requestTripsForm';
export type { TripFormValue } from './model/requestTripsForm';
export type { VehiclePeriodCommand } from './model/types';
export {
  draftValues,
  isBackdatedCreateAttempt,
  isLegacyOrdinaryCreateAttempt,
  listLocalDrafts,
  newDraftId,
  removeLocalDraft,
  restoreDraftValues,
  writeLocalDraft,
} from './model/localDraft';
export type {
  DraftTarget,
  VehicleCreateAttempt,
  VehicleCreateProtocol,
  VehicleRequestLocalDraft,
} from './model/localDraft';
export {
  silentTermApplyBody,
  termCommandOf,
  termPreviewIsSilent,
  termRidesWideEdit,
} from './model/termEdit';
export type { EditorTerm } from './model/termEdit';
export { retypeErases } from './model/retypeErases';
export { copyNotice } from './ui/copyNotice';
