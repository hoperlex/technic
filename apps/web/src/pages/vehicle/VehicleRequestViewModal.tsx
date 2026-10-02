import type { SpecialEquipmentRequestDto } from '@technic/contracts';
import {
  VehicleRequestViewModal as VehicleRequestView,
  type VehicleRequestViewModalProps,
} from '@widgets/vehicle-request-view';
import { weeklyRequestPath } from '@entities/weekly-request';
import { VehicleRequestDays } from './VehicleRequestDays';

type Props = Omit<VehicleRequestViewModalProps, 'renderDays' | 'weeklyRequestPath'>;

function renderDays(request: SpecialEquipmentRequestDto, readOnly: boolean | undefined) {
  return <VehicleRequestDays request={request} readOnly={readOnly} />;
}

/** Bind the reusable request card to vehicle-page work-day and weekly-request routes. */
export function VehicleRequestViewModal(props: Props) {
  return (
    <VehicleRequestView {...props} renderDays={renderDays} weeklyRequestPath={weeklyRequestPath} />
  );
}
