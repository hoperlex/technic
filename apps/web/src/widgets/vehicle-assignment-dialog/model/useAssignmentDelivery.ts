import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { Form } from 'antd';
import type { VehicleOwnership, VehicleRequestDto } from '@technic/contracts';
import { canOfferAssignmentDelivery } from '@features/vehicle-assignment';
import { useObjectScope } from '@entities/session';
import type { VehicleAssignmentForm } from './types';

/** Own delivery availability and the weekly-request prefill without leaking page state. */
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
  const { ownObjectIds } = useObjectScope();
  const suggestObjectIds = useMemo(
    () => [request?.objectId, ...ownObjectIds].filter((id): id is string => !!id),
    [request?.objectId, ownObjectIds],
  );
  const deliveryEnabled = Form.useWatch('deliveryEnabled', form) ?? false;
  const deliveryDate = Form.useWatch('deliveryDate', form);
  const canOffer = canOfferAssignmentDelivery({ request, reassign, ownership });
  const wants = canOffer && deliveryEnabled;
  const weekly =
    !reassign &&
    !isLinear &&
    request?.requestType === 'special_equipment' &&
    request.weeklyOrigin?.deliveryNeeded
      ? request.weeklyOrigin
      : null;

  const toggle = (enabled: boolean) => {
    if (!enabled) return;
    const values = form.getFieldsValue();
    form.setFieldsValue({
      deliveryTo: values.deliveryTo || request?.objectAddress || request?.objectName || '',
    });
  };

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
    if (!weekly || ownership !== 'own' || weeklyApplied.current) return;
    weeklyApplied.current = true;
    form.setFieldsValue({ deliveryEnabled: true, deliveryFrom: weekly.deliveryFrom });
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
