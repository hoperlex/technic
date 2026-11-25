import { Form, type FormInstance } from 'antd';
import {
  REQUEST_TYPES,
  requestTypeLabels,
  SNOW_TYPE_CHANGE_MESSAGE,
  wasteRequestTypeChangeAllowed,
  type RequestType,
  type WasteRequestDto,
} from '@technic/contracts';
import { offeredRequestTypes } from '@entities/waste-request';
import { AutoSelect } from '@shared/ui';
import type { WasteRequestFormValues } from '../model/types';

interface Props {
  form: FormInstance<WasteRequestFormValues>;
  objectId: string | undefined;
  record: WasteRequestDto | null;
  requestType: RequestType | undefined;
  snowSupported: boolean;
}

/**
 * Which types the field offers.
 *
 * A filed request may change only within the contract corridor (S12): a snow request is offered
 * nothing but snow, and snow is never offered to another type. The server answers a forbidden
 * change with the same `SNOW_TYPE_CHANGE_MESSAGE`, so the field explains the narrowing in those
 * words up front instead of letting the person discover it as a refusal.
 *
 * A new request is offered snow only after the serving API confirmed it (§3.5); a value already in
 * the form — a restored draft — stays listed so the field never shows a bare enum value.
 */
function typeOptions(
  record: WasteRequestDto | null,
  requestType: RequestType | undefined,
  snowSupported: boolean,
) {
  const types = record
    ? REQUEST_TYPES.filter((type) => wasteRequestTypeChangeAllowed(record.requestType, type))
    : offeredRequestTypes(REQUEST_TYPES, snowSupported, requestType);
  return types.map((type) => ({ value: type, label: requestTypeLabels[type] }));
}

/** The request type, with the subject fields of the previous type cleared on every switch. */
export function WasteRequestEditorTypeField({
  form,
  objectId,
  record,
  requestType,
  snowSupported,
}: Props) {
  const snowRecord = record?.requestType === 'snow_removal';
  return (
    <Form.Item
      name="requestType"
      label="Тип заявки"
      rules={[{ required: true, message: 'Выберите тип заявки' }]}
      // A snow request has a single option, and the reason must be visible next to it; other
      // filed requests only lack snow, which the label hint explains without taking a line.
      extra={snowRecord ? SNOW_TYPE_CHANGE_MESSAGE : undefined}
      tooltip={record && !snowRecord ? SNOW_TYPE_CHANGE_MESSAGE : undefined}
    >
      <AutoSelect
        options={typeOptions(record, requestType, snowSupported)}
        placeholder={objectId ? 'Выберите тип заявки' : 'Сначала выберите объект'}
        disabled={!objectId}
        onChange={() =>
          form.setFieldsValue({
            containerTypeId: undefined,
            containerGroupKey: undefined,
            // The count returns to one container: "3" from the previous request type means
            // nothing for the new one, and installation and removal have no count at all.
            containersCount: 1,
            ownerMismatchReason: undefined,
            wasteTypeId: undefined,
            volumeM3: undefined,
          })
        }
      />
    </Form.Item>
  );
}
