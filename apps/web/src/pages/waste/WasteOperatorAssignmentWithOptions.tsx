import { actsForCounterparty } from '@technic/contracts';
import {
  counterpartyActiveOperatorOptionsQuery,
  operatorOptionsForObject,
} from '@entities/counterparty';
import { objectRecordsQuery } from '@entities/object';
import { useAuth } from '@entities/session';
import { WasteOperatorAssignmentModal } from '@features/waste-operator-assignment';
import type { WasteRequestOperatorModalProps } from '@features/waste-request-lifecycle';
import { useDeferredOptions } from '@shared/lib';

/** The assignment window observes the directory only while it is open. */
export function WasteOperatorAssignmentWithOptions({
  canAssignOperator,
  ...props
}: WasteRequestOperatorModalProps & { canAssignOperator: boolean }) {
  const { user } = useAuth();
  const active = !!props.request && canAssignOperator;
  const operators = useDeferredOptions(
    counterpartyActiveOperatorOptionsQuery(),
    active,
    (data) => data.items,
    'pick',
  );
  // The binding rule counts EVERY link of the site, whatever the operator's state (snow-removal
  // plan, §3.2): the window asks the same question as the server and the create form do, from the
  // site card, instead of falling back to «all active operators» for a configured site.
  const objects = useDeferredOptions(
    objectRecordsQuery(true),
    active,
    (data) => data.items,
    'pick',
  );
  const site = objects.options?.find((object) => object.id === props.request?.objectId);
  const options = operatorOptionsForObject(
    operators.options ?? [],
    props.request?.objectId,
    {
      id: props.request?.operatorCounterpartyId ?? null,
      name: props.request?.operatorName ?? null,
    },
    site ? site.operators.length + (site.hiddenOperatorLinks ?? 0) : undefined,
  );
  // A counterparty-scoped actor assigns only their own organisation; the server refuses the rest.
  const ownOperatorId =
    actsForCounterparty(user, 'operator') && user?.counterpartyId ? user.counterpartyId : null;
  return (
    <WasteOperatorAssignmentModal
      {...props}
      loading={operators.loading || objects.loading}
      options={ownOperatorId ? options.filter((option) => option.value === ownOperatorId) : options}
    />
  );
}
