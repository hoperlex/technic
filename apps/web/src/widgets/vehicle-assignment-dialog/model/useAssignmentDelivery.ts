import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { Form } from 'antd';
import type { VehicleOwnership, VehicleRequestDto } from '@technic/contracts';
import { canOfferAssignmentDelivery } from '@features/vehicle-assignment';
import { useObjectScope } from '@entities/session';
import type { VehicleAssignmentForm } from './types';

/**
 * Delivery to the site (migration 0082). On-site equipment drives to the site through the city on
 * its own wheels and a 4-P is issued for that trip — but it may also go on a carrier, so the
 * relocation is offered, not required. The portal does not track the delivery method.
 *
 * Own equipment only: a rental's relocation is the lessor's business, and the lessor issues its
 * waybill. And not linear equipment (ADR 0100 decision 9): `delivery`/`pickup` are about a machine
 * that came to the site and stayed; a linear one goes home in the evening, its departure is an
 * ordinary day route, and the block would offer a document for a trip that does not exist.
 */
export function useAssignmentDelivery({
  request,
  reassign,
  isLinear,
  ownership,
  form,
}: {
  request: VehicleRequestDto | null;
  reassign: boolean;
  isLinear: boolean;
  ownership: VehicleOwnership;
  form: VehicleAssignmentForm;
}) {
  const targetId = request?.id ?? null;
  // The request site and the account's sites come first in the relocation places (ADR 0069).
  const { ownObjectIds } = useObjectScope();
  const suggestObjectIds = useMemo(
    () => [request?.objectId, ...ownObjectIds].filter((id): id is string => !!id),
    [request?.objectId, ownObjectIds],
  );
  const deliveryEnabled = Form.useWatch('deliveryEnabled', form) ?? false;
  const deliveryDate = Form.useWatch('deliveryDate', form);
  const canOffer = canOfferAssignmentDelivery({ request, reassign, ownership });
  const wants = canOffer && deliveryEnabled;
  /*
   * Delivery asked for by a weekly request (ADR 0085 R11): its composition row carried "delivery to
   * the site needed" and the departure place, so the form opens with the relocation on and "From"
   * filled. Values stay editable: a hint, not a decision for the dispatcher. Nothing is filled for
   * rentals — by the same rule as the whole block (`canOffer`): the lessor moves them, and a ticked
   * box would promise a waybill the portal will not issue. Nor for linear equipment: it has no
   * relocation at all (ADR 0100 decision 9).
   */
  const weekly =
    !reassign &&
    !isLinear &&
    request?.requestType === 'special_equipment' &&
    request.weeklyOrigin?.deliveryNeeded
      ? request.weeklyOrigin
      : null;

  /*
   * Enabling fills the request site — the place, not the date: the request has one object address,
   * and delivery has no other "to". The relocation date is never filled: equipment arrives the day
   * before or a day after work starts, and a filled-in term start reads as a decision already
   * taken — it gets skimmed, and the waybill gets a day on which nobody drove anywhere.
   */
  const toggle = (enabled: boolean) => {
    if (!enabled) return;
    const values = form.getFieldsValue();
    form.setFieldsValue({
      deliveryTo: values.deliveryTo || request?.objectAddress || request?.objectName || '',
    });
  };

  // The weekly prefill happens once per request. Repeating it would overwrite a box unticked by
  // hand, and relocation fields left from the previous target would read as a decision about this
  // one: the dialog is reused, so the delivery fields are cleared when the request changes.
  const weeklyApplied = useRef(false);
  useEffect(() => {
    weeklyApplied.current = false;
    form.setFieldsValue({
      deliveryEnabled: false,
      deliveryDate: null,
      deliveryDriverId: undefined,
      deliveryFrom: '',
      deliveryTo: '',
    });
  }, [targetId, form]);

  const applyWeekly = useEffectEvent((_id: string | null, _ownership: string, _weekly: unknown) => {
    // The ownership branch decides whether a relocation is offered at all: rentals have none, and
    // the prefill waits for the switch back to own equipment instead of being lost for good.
    if (!weekly || ownership !== 'own' || weeklyApplied.current) return;
    weeklyApplied.current = true;
    form.setFieldsValue({ deliveryEnabled: true, deliveryFrom: weekly.deliveryFrom });
    // "To" is filled the same way as when the box is ticked by hand.
    toggle(true);
  });
  useEffect(() => applyWeekly(targetId, ownership, weekly), [targetId, ownership, weekly]);

  return {
    canOffer,
    date: deliveryDate,
    suggestObjectIds,
    toggle,
    wants,
    weekly,
  };
}

export type AssignmentDeliveryController = ReturnType<typeof useAssignmentDelivery>;
