/**
 * Vehicle-request editor host. A widget is the composition boundary because the form combines
 * address input and request-customer features; command/value semantics stay in
 * `@features/vehicle-request-editor`.
 */
export { useVehicleRequestEditor } from './model/useVehicleRequestEditor';
export type {
  VehicleRequestEditorController,
  VehicleRequestEditorPeriodModalProps,
} from './model/types';
export { BackdateReasonField } from './ui/VehicleBackdateFields';
export { RequestRelocationsField } from './ui/RequestRelocationsField';
export { VehicleRelocationModal } from './ui/VehicleRelocationModal';
