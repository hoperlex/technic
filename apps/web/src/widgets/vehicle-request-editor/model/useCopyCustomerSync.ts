import { useEffect } from 'react';
import type { FormInstance } from 'antd';
import { costTargetKeyOf } from '@technic/contracts';
import type { RequestCustomerOptions } from '@features/request-customer';
import type { CopySource, FormValues } from '@features/vehicle-request-editor';

interface Input {
  copy: CopySource | null;
  /** The form's picker — the same one whose composition decides what the save may carry. */
  customer: RequestCustomerOptions;
  form: FormInstance<FormValues>;
}

/**
 * The customer of a copy is offered one render later than the rest of its values, and that delay
 * is the whole point: the composition of the picker follows the request kind standing in the FORM
 * (place axis for on-site equipment, scope plus departments for freight), and inside the click
 * that opens the copy the form still holds the kind of the previous opening. Asked there, the
 * question "is this customer on offer to me" is answered about the wrong kind — a department with
 * its own places (ADR 0201) copying an equipment order was told it had no objects at all, and the
 * place it is entitled to never reached the required field.
 *
 * Here the picker has already switched to the source kind, so one and the same rule answers for
 * the form and for the copy; the directory may also still have been loading at the click, and that
 * wait no longer counts as "not on offer" either.
 *
 * A customer outside the account's offer stays empty on purpose (ADR 0173 §3): the field then asks
 * the person instead of submitting a value the server would refuse.
 *
 * A hook of its own next to `useCopyClassificationSync`: both fill a copied value only once the
 * form can answer whether it is still acceptable, and neither belongs to the click that opens the
 * copy.
 */
export function useCopyCustomerSync({ copy, customer, form }: Input) {
  const copyCustomerKey = copy ? costTargetKeyOf(copy.source) : null;
  const copyCustomerPair = customer.customerPairOf(copyCustomerKey);
  const copyCustomerOffered = !!copyCustomerPair.objectId || !!copyCustomerPair.departmentId;
  /*
   * `copy` stands in the dependencies next to the key: reopening a copy of the SAME order gives
   * the same key, and keyed by it alone the fill would skip the second opening, whose form has
   * just been reset.
   */
  useEffect(() => {
    if (!copy || !copyCustomerKey || !copyCustomerOffered) return;
    // A value already chosen by hand wins: the directory may have arrived after the person gave up
    // waiting and picked a customer themselves.
    if (form.getFieldValue('customerKey')) return;
    form.setFieldsValue({ customerKey: copyCustomerKey });
  }, [copy, copyCustomerKey, copyCustomerOffered, form]);
}
