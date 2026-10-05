import type { FormInstance } from 'antd';
import type { CounterpartyDto } from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { CounterpartyFormFields, type CounterpartyFormValues } from './CounterpartyFormFields';

interface Props {
  open: boolean;
  record: CounterpartyDto | null;
  form: FormInstance<CounterpartyFormValues>;
  objectOptions: { value: string; label: string }[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: CounterpartyFormValues) => void;
}

/** Counterparty fields stay mounted in one modal for both create and update commands. */
export function CounterpartyEditorModal({
  open,
  record,
  form,
  objectOptions,
  pending,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <FormModal
      title={record ? 'Редактирование контрагента' : 'Новый контрагент'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={560}
    >
      <CounterpartyFormFields form={form} objectOptions={objectOptions} onFinish={onSubmit} />
    </FormModal>
  );
}

export {
  CounterpartyFormFields,
  counterpartyCreatePayload,
  counterpartyUpdatePayload,
  type CounterpartyFormValues,
} from './CounterpartyFormFields';
