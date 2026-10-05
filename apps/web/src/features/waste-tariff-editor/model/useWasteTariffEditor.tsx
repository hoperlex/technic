import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWasteTariffInput, WasteTariffDto } from '@technic/contracts';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { counterpartyOperatorGridQuery } from '@entities/counterparty';
import {
  type WasteTariffGridRow,
  wasteTariffErrorMessage as errorMessage,
  wasteTariffKeys,
  wasteTariffsApi,
} from '@entities/waste-tariff';
import { wasteTypeKeys, wasteTypeOptionsQuery } from '@entities/waste-type';
import { useFormBlockers } from '@shared/ui';
import {
  type PurgeControl,
  WasteTariffEditorModal,
  type WasteTariffFormValues,
} from '../ui/WasteTariffEditorModal';

export interface WasteTariffEditorController {
  actions: {
    create: () => void;
    createFor: (row: WasteTariffGridRow, operatorCounterpartyId: string) => void;
    edit: (tariff: WasteTariffDto) => void;
  };
  node: ReactNode;
}

/** Own tariff creation/editing and every cache effect of those commands. */
export function useWasteTariffEditor(purge: PurgeControl): WasteTariffEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteTariffDto | null>(null);
  const [form] = Form.useForm<WasteTariffFormValues>();
  // Form option lists include inactive records on purpose: a price may predate a deactivation, and
  // editing it must show the saved waste or container type, not an empty field or a raw id.
  const { data: wasteTypesData, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: false }),
  );
  const { data: containerTypesData, isLoading: containerTypesLoading } = useQuery(
    containerTypeOptionsQuery({ activeOnly: false }),
  );
  const { data: operatorsData, isLoading: operatorsLoading } = useQuery(
    counterpartyOperatorGridQuery(),
  );
  const containerTypes = containerTypesData?.items ?? [];

  const blockers = useFormBlockers(form, {
    onValuesChange: (changed: Partial<WasteTariffFormValues>) => {
      // Switching the source clears the other branch; otherwise both id and name reach the API.
      if ('wasteTypeSource' in changed) {
        form.setFieldsValue({ wasteTypeId: undefined, wasteTypeName: '' });
      }
      // Target and pricing are coupled: per-container pricing exists only for a concrete type
      // whose capacity is known.
      if ('target' in changed) {
        form.setFieldsValue({ containerTypeId: undefined, containerKind: undefined });
        if (changed.target !== 'container_type') form.setFieldValue('pricing', 'per_m3');
      }
      if ('containerTypeId' in changed) {
        const volume =
          containerTypes.find((type) => type.id === changed.containerTypeId)?.volumeM3 ?? null;
        if (volume == null && form.getFieldValue('pricing') === 'per_container') {
          form.setFieldValue('pricing', 'per_m3');
        }
      }
    },
  });

  const create = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      wasteTypeSource: 'existing',
      target: 'container_type',
      pricing: 'per_m3',
      isActive: true,
      note: '',
    });
    setOpen(true);
  };

  /** An empty matrix cell already identifies the pair and operator; only the price remains. */
  const createFor = (row: WasteTariffGridRow, operatorCounterpartyId: string) => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      operatorCounterpartyId,
      wasteTypeSource: 'existing',
      wasteTypeId: row.wasteTypeId,
      target: row.containerTypeId ? 'container_type' : 'container_kind',
      containerTypeId: row.containerTypeId ?? undefined,
      containerKind: row.containerKind ?? undefined,
      pricing: 'per_m3',
      isActive: true,
      note: '',
    });
    setOpen(true);
  };

  const edit = (tariff: WasteTariffDto) => {
    setRecord(tariff);
    form.resetFields();
    form.setFieldsValue({
      operatorCounterpartyId: tariff.operatorCounterpartyId,
      wasteTypeSource: 'existing',
      wasteTypeId: tariff.wasteTypeId,
      target: tariff.containerTypeId ? 'container_type' : 'container_kind',
      containerTypeId: tariff.containerTypeId ?? undefined,
      containerKind: tariff.containerKind ?? undefined,
      pricing: tariff.isPerContainer ? 'per_container' : 'per_m3',
      pricePerM3: tariff.isPerContainer ? undefined : tariff.pricePerM3,
      pricePerContainer: tariff.pricePerContainer ?? undefined,
      note: tariff.note,
      isActive: tariff.isActive,
    });
    setOpen(true);
  };

  // Saving a price never reprices issued requests: each request keeps a snapshot of the tariff it
  // was priced with (ADR 0009), so only new requests see the change.
  const save = useMutation({
    mutationFn: (values: WasteTariffFormValues) => {
      const common = {
        operatorCounterpartyId: values.operatorCounterpartyId!,
        containerTypeId:
          values.target === 'container_type' ? (values.containerTypeId ?? null) : null,
        containerKind: values.target === 'container_kind' ? (values.containerKind ?? null) : null,
        isPerContainer: values.pricing === 'per_container',
        // Exactly one price is submitted; the server derives the other from container capacity.
        pricePerM3: values.pricing === 'per_m3' ? (values.pricePerM3 ?? null) : null,
        pricePerContainer:
          values.pricing === 'per_container' ? (values.pricePerContainer ?? null) : null,
        note: values.note ?? '',
        isActive: values.isActive,
      };
      if (record) {
        return wasteTariffsApi.update(record.id, {
          ...common,
          wasteTypeId: values.wasteTypeId,
        });
      }
      // A new waste type is created atomically with its first tariff position.
      const payload: CreateWasteTariffInput = {
        ...common,
        wasteTypeId: values.wasteTypeSource === 'new' ? null : (values.wasteTypeId ?? null),
        wasteTypeName: values.wasteTypeSource === 'new' ? (values.wasteTypeName ?? null) : null,
      };
      return wasteTariffsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void queryClient.invalidateQueries({ queryKey: wasteTariffKeys.root });
      // The same command may have created a waste type, so the selection directory is stale too.
      void queryClient.invalidateQueries({ queryKey: wasteTypeKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      if (!blockers.fromApi(error)) message.error(errorMessage(error));
    },
  });

  const operators = operatorsData?.items ?? [];
  return {
    actions: { create, createFor, edit },
    node: (
      <WasteTariffEditorModal
        open={open}
        record={record}
        form={form}
        formProps={blockers.formProps}
        pending={save.isPending}
        wasteTypes={wasteTypesData?.items ?? []}
        wasteTypesLoading={wasteTypesLoading}
        containerTypes={containerTypes}
        containerTypesLoading={containerTypesLoading}
        operatorOptions={operators.map((operator) => ({
          value: operator.id,
          label: operator.isActive ? operator.name : `${operator.name} (неактивен)`,
        }))}
        operatorsLoading={operatorsLoading}
        purge={purge}
        onCancel={() => setOpen(false)}
        onSubmit={(values) => save.mutate(values)}
      />
    ),
  };
}
