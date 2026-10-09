import {
  counterpartyActiveOperatorOptionsQuery,
  operatorOptionsForObject,
} from '@entities/counterparty';
import { WasteOperatorAssignmentModal } from '@features/waste-operator-assignment';
import type { WasteRequestOperatorModalProps } from '@features/waste-request-lifecycle';
import { useDeferredOptions } from '@shared/lib';

/** The assignment window observes the directory only while it is open. */
export function WasteOperatorAssignmentWithOptions({
  canAssignOperator,
  ...props
}: WasteRequestOperatorModalProps & { canAssignOperator: boolean }) {
  const operators = useDeferredOptions(
    counterpartyActiveOperatorOptionsQuery(),
    !!props.request && canAssignOperator,
    (data) => data.items,
    'pick',
  );
  return (
    <WasteOperatorAssignmentModal
      {...props}
      loading={operators.loading}
      options={operatorOptionsForObject(operators.options ?? [], props.request?.objectId, {
        id: props.request?.operatorCounterpartyId ?? null,
        name: props.request?.operatorName ?? null,
      })}
    />
  );
}
