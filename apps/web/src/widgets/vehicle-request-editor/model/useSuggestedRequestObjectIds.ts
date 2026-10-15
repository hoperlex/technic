import { useMemo } from 'react';
import { Form, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { departmentPlatformQuery } from '@entities/department';
import type { RequestCustomerOptions } from '@features/request-customer';
import type { FormValues } from '@features/vehicle-request-editor';
import { QUERY_PROFILE } from '@shared/config';

interface Input {
  form: FormInstance<FormValues>;
  customer: RequestCustomerOptions;
  ownPlaceObjectIds: readonly string[];
  open: boolean;
}

export function useSuggestedRequestObjectIds({ form, customer, ownPlaceObjectIds, open }: Input) {
  const formCustomer = customer.customerPairOf(Form.useWatch('customerKey', form));
  const { data: departmentPlatforms } = useQuery({
    ...departmentPlatformQuery(),
    ...QUERY_PROFILE.PICK,
    enabled: open,
  });
  return useMemo(() => {
    // Suggestions reorder addresses; they do not widen access or the object directory.
    const departmentObjectIds = formCustomer.departmentId
      ? (departmentPlatforms?.get(formCustomer.departmentId) ?? [])
      : [];
    const ids = [formCustomer.objectId, ...departmentObjectIds, ...ownPlaceObjectIds];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }, [formCustomer.objectId, formCustomer.departmentId, departmentPlatforms, ownPlaceObjectIds]);
}
