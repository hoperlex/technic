import type { FormInstance } from 'antd';
import type { Dayjs } from 'dayjs';
import { isVehicleKindAllowedForRequest, type VehicleRequestType } from '@technic/contracts';
import type { RequestCustomerOptions } from '@features/request-customer';
import { blankTrip, type FormValues, type TripFormValue } from '@features/vehicle-request-editor';

const SPECIAL_FIELDS = ['dateFrom', 'dateTo', 'responsibleName', 'responsiblePhone'] as const;
// Addresses, cargo and contacts live inside `trips` (R2), so they are reset together with the list
// under one name: listing trip fields here would need row indexes the form does not know upfront.
const FREIGHT_FIELDS = ['scheduledDate', 'scheduledTime', 'trips'] as const;

interface Input {
  classificationByKey: ReadonlyMap<string, { kindCode: string }>;
  customer: Pick<RequestCustomerOptions, 'customerPairOf'>;
  form: FormInstance<FormValues>;
  minDate: Dayjs;
}

/**
 * Request type change: fields of the other type are cleared, the own date defaults to the
 * earliest allowed day, and the selected equipment is reset if its kind does not fit the new type.
 *
 * What can be carried over is carried over rather than asked again (ADR 0091). Two things are
 * unambiguous: the day (the ordered delivery becomes the first work day and vice versa) and the
 * on-site contact — on-site equipment goes to whoever meets it, and on a trip the same person
 * stands at unloading. Addresses, cargo and the end date are not carried: the other type either
 * lacks them or gives them a different meaning.
 */
export function requestTypeChangeHandler({ classificationByKey, customer, form, minDate }: Input) {
  return (next: VehicleRequestType) => {
    const key: string | undefined = form.getFieldValue('classificationKey');
    const kindCode = key ? classificationByKey.get(key)?.kindCode : undefined;
    if (kindCode && !isVehicleKindAllowedForRequest(next, kindCode)) {
      form.resetFields(['classificationKey']);
    }
    // The unloading contact lives on the **first** trip (R2): it becomes the single one for the
    // whole order if the request is converted to on-site equipment; other trips have their own
    // ends.
    const trips: TripFormValue[] | undefined = form.getFieldValue('trips');
    if (next === 'special_equipment') {
      // On-site equipment has no department customer (R4): the form, not the picker, removes a
      // department already in the field (K8) — otherwise the field would show emptiness while the
      // request left with the previous customer.
      if (customer.customerPairOf(form.getFieldValue('customerKey')).departmentId) {
        form.resetFields(['customerKey']);
      }
      const previousDate: Dayjs | undefined = form.getFieldValue('scheduledDate');
      const name = trips?.[0]?.toResponsibleName;
      const phone = trips?.[0]?.toResponsiblePhone;
      // Trips live in `FREIGHT_FIELDS` and are reset with the delivery: on-site orders have none.
      form.resetFields([...FREIGHT_FIELDS]);
      form.setFieldsValue({
        dateFrom: form.getFieldValue('dateFrom') ?? previousDate ?? minDate,
        responsibleName: form.getFieldValue('responsibleName') || name,
        responsiblePhone: form.getFieldValue('responsiblePhone') || phone,
      });
      return;
    }
    const previousDate: Dayjs | undefined = form.getFieldValue('dateFrom');
    const name: string | undefined = form.getFieldValue('responsibleName');
    const phone: string | undefined = form.getFieldValue('responsiblePhone');
    form.resetFields([...SPECIAL_FIELDS]);
    // There are never zero trips: freight without one does not say what to carry and where. An
    // empty list happens when an on-site order is converted to freight — then the first row is
    // created, and the receiving contact becomes the unloading contact.
    const [first = blankTrip(), ...rest] = trips ?? [];
    form.setFieldsValue({
      scheduledDate: form.getFieldValue('scheduledDate') ?? previousDate ?? minDate,
      trips: [
        {
          ...first,
          toResponsibleName: first.toResponsibleName || name,
          toResponsiblePhone: first.toResponsiblePhone || phone,
        },
        ...rest,
      ],
    });
  };
}
