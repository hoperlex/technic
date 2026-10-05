import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WasteTypeDto } from '@technic/contracts';
import { wasteTariffKeys } from '@entities/waste-tariff';
import {
  wasteTypeErrorMessage,
  wasteTypeKeys,
  wasteTypeOptionsQuery,
  wasteTypesApi,
} from '@entities/waste-type';
import { useFormBlockers } from '@shared/ui';
import {
  type WasteTypeFormValues,
  WasteTypeEditorModal,
  type WasteTypePurgeControl,
} from '../ui/WasteTypeEditorModal';

export interface WasteTypeEditorController {
  actions: { edit: (wasteType: WasteTypeDto) => void };
  node: ReactNode;
}

/** Own waste-type editing and invalidate every view that embeds its name or state. */
export function useWasteTypeEditor(purge: WasteTypePurgeControl): WasteTypeEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteTypeDto | null>(null);
  const [form] = Form.useForm<WasteTypeFormValues>();
  const blockers = useFormBlockers(form);
  const { data: wasteTypesData } = useQuery(wasteTypeOptionsQuery({ pricedOnly: false }));

  const edit = (wasteType: WasteTypeDto) => {
    setRecord(wasteType);
    form.resetFields();
    form.setFieldsValue({ name: wasteType.name, isActive: wasteType.isActive });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: WasteTypeFormValues) => wasteTypesApi.update(record!.id, values),
    onSuccess: () => {
      message.success('Сохранено');
      void queryClient.invalidateQueries({ queryKey: wasteTypeKeys.root });
      // The type name is embedded in every tariff grid row and therefore changes that view too.
      void queryClient.invalidateQueries({ queryKey: wasteTariffKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      if (!blockers.fromApi(error)) message.error(wasteTypeErrorMessage(error));
    },
  });

  return {
    actions: { edit },
    node: (
      <WasteTypeEditorModal
        open={open}
        record={record}
        wasteTypes={wasteTypesData?.items ?? []}
        form={form}
        formProps={blockers.formProps}
        pending={save.isPending}
        purge={purge}
        onCancel={() => setOpen(false)}
        onSubmit={(values) => save.mutate(values)}
      />
    ),
  };
}
