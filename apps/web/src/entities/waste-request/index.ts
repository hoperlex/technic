/**
 * Waste requests cover container operations, removal, the assigned operator and completion facts
 * (ADR 0010, ADR 0035, ADR 0054). Consumers use this public entry so internal modules can move
 * without changing every import.
 *
 * The slice owns its API, query keys and pure presentation rules. Features own request commands
 * and forms, widgets compose the working registry and detail view, and the page only connects
 * those public entries.
 */
export { wasteRequestKeys } from './api/keys';
export { wasteRequestsApi } from './api/wasteRequestsApi';
export type { WasteRequestPayload, WasteRequestUpdatePayload } from './api/wasteRequestsApi';

/*
 * Request calendar boundaries: "not earlier than today" on creation and "not back into the past" on
 * edit. They use Moscow time and the same contract helper the API validates creation with. A local
 * browser date would make "today" disagree with the server for dispatchers in other time zones.
 */
export { isBeforeMinRequestDate, isPastDate, minRequestDate } from './model/requestDates';
/**
 * Build a waste-request link with the contract-owned section permission: the right is taken from
 * the request slice, with no copy of it here.
 */
export { wasteRequestLink } from './model/links';
export { wasteRequestErrorMessage } from './model/errorMessage';
export {
  containerGroupKey,
  containerGroupOptions,
  findContainerGroup,
  parseContainerGroupKey,
  presentGroupsHint,
  type ParsedGroupKey,
} from './model/containerGroups';
export {
  wasteAmountLine,
  wastePricingHint,
  wasteRollbackErases,
  wasteWeightFactLine,
  type WastePricingHint,
} from './model/presentation';
