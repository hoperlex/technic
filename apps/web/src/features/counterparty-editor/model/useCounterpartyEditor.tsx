import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CounterpartyDto } from '@technic/contracts';
import {
  counterpartiesApi,
  counterpartyErrorMessage as errorMessage,
  counterpartyKeys,
} from '@entities/counterparty';
import { objectKeys, objectRecordsQuery } from '@entities/object';
import { vehicleKeys } from '@entities/vehicle';
import { vehicleClassificationKeys } from '@entities/vehicle-type';
import { warehouseKeys } from '@entities/warehouse';
import { wasteTariffKeys } from '@entities/waste-tariff';
import { userAccountKeys } from '@entities/user-account';
import {
  CounterpartyEditorModal,
  type CounterpartyFormValues,
  counterpartyCreatePayload,
  counterpartyUpdatePayload,
} from '../ui/CounterpartyEditorModal';

export interface CounterpartyEditorController {
  actions: {
    create: () => void;
    edit: (record: CounterpartyDto) => void;
  };
  node: ReactNode;
}

/** Own the counterparty card, its command and every cache effect of that command. */
export function useCounterpartyEditor(): CounterpartyEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<CounterpartyDto | null>(null);
  const [form] = Form.useForm<CounterpartyFormValues>();

  // Inactive construction sites remain readable in an existing operator card; filtering them
  // would leave raw ids in the form while live waste requests still refer to those bindings.
  const { data: objectsData } = useQuery({
    ...objectRecordsQuery(false),
  });
  const objectOptions = (objectsData?.items ?? []).map((object) => ({
    value: object.id,
    label: `${object.code} — ${object.name}`,
  }));

  const create = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true, synonyms: [], objectIds: [] });
    setOpen(true);
  };

  const edit = (next: CounterpartyDto) => {
    setRecord(next);
    form.resetFields();
    form.setFieldsValue({
      type: next.type,
      name: next.name,
      inn: next.inn,
      synonyms: next.synonyms,
      objectIds: next.objects.map((object) => object.id),
      email: next.email,
      comment: next.comment,
      isActive: next.isActive,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: CounterpartyFormValues) => {
      // The field module owns the request body because create and update intentionally differ:
      // changing a non-service card must not overwrite a service address hidden from this form.
      return record
        ? counterpartiesApi.update(record.id, counterpartyUpdatePayload(values))
        : counterpartiesApi.create(counterpartyCreatePayload(values));
    },
    onSuccess: () => {
      message.success('Сохранено');
      void queryClient.invalidateQueries({ queryKey: counterpartyKeys.root });
      // Operator bindings are embedded in the object directory.
      void queryClient.invalidateQueries({ queryKey: objectKeys.root });
      // Deactivating a lessor deactivates its rental offers as a server-side effect, and
      // reactivating it brings back those switched off with it. The classifier's average prices
      // are taken over active vehicles of every ownership, so they move too — and they are a
      // 30-minute dictionary that nothing else would refresh.
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
      // Supplier, operator and account names are embedded in other directory responses.
      void queryClient.invalidateQueries({ queryKey: warehouseKeys.root });
      void queryClient.invalidateQueries({ queryKey: wasteTariffKeys.root });
      void queryClient.invalidateQueries({ queryKey: userAccountKeys.root });
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return {
    actions: { create, edit },
    node: (
      <CounterpartyEditorModal
        open={open}
        record={record}
        form={form}
        objectOptions={objectOptions}
        pending={save.isPending}
        onCancel={() => setOpen(false)}
        onSubmit={(values) => save.mutate(values)}
      />
    ),
  };
}
