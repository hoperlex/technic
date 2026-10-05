import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type CreateVehicleSpecInput,
  type UpdateVehicleSpecInput,
  type VehicleSpecDto,
} from '@technic/contracts';
import {
  vehicleSpecKeys,
  vehicleSpecsApi,
  vehicleTypeErrorMessage as errorMessage,
} from '@entities/vehicle-type';
import { VehicleSpecEditorModal, type SpecFormValues } from '../ui/VehicleSpecEditorModal';

export interface VehicleSpecEditorController {
  actions: {
    create: () => void;
    edit: (spec: VehicleSpecDto) => void;
    toggle: (spec: VehicleSpecDto, next: boolean) => void;
    togglePending: boolean;
  };
  node: ReactNode;
}

/** Own specification create, edit, and guarded activation commands. */
export function useVehicleSpecEditor(): VehicleSpecEditorController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleSpecDto | null>(null);
  const [form] = Form.useForm<SpecFormValues>();
  // An attached spec already takes part in value canonicalisation: unit and precision are frozen.
  const isUsed = (record?.usedInTypes ?? 0) > 0;

  const create = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ decimals: 0, sortOrder: 100, isActive: true });
    setOpen(true);
  };
  const edit = (spec: VehicleSpecDto) => {
    setRecord(spec);
    form.resetFields();
    form.setFieldsValue({
      code: spec.code,
      name: spec.name,
      shortName: spec.shortName,
      unit: spec.unit,
      decimals: spec.decimals,
      minValue: spec.minValue,
      maxValue: spec.maxValue,
      description: spec.description,
      sortOrder: spec.sortOrder,
      isActive: spec.isActive,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (
      arg: { create: CreateVehicleSpecInput } | { id: string; body: UpdateVehicleSpecInput },
    ) =>
      'create' in arg
        ? vehicleSpecsApi.create(arg.create)
        : vehicleSpecsApi.update(arg.id, arg.body),
    onSuccess: () => {
      message.success('Сохранено');
      void queryClient.invalidateQueries({ queryKey: vehicleSpecKeys.root });
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const submit = (values: SpecFormValues) => {
    if (record) {
      save.mutate({
        id: record.id,
        body: {
          name: values.name,
          shortName: values.shortName ?? '',
          description: values.description ?? '',
          minValue: values.minValue ?? null,
          maxValue: values.maxValue ?? null,
          sortOrder: values.sortOrder,
          isActive: values.isActive,
          // Frozen fields are sent only for a spec not yet attached to any type: unit and precision
          // are part of the meaning of categories already built on it.
          ...(isUsed ? {} : { unit: values.unit ?? '', decimals: values.decimals }),
        },
      });
      return;
    }
    save.mutate({
      create: {
        code: values.code!,
        name: values.name!,
        shortName: values.shortName ?? '',
        unit: values.unit ?? '',
        decimals: values.decimals ?? 0,
        minValue: values.minValue ?? null,
        maxValue: values.maxValue ?? null,
        description: values.description ?? '',
        sortOrder: values.sortOrder ?? 100,
        isActive: values.isActive ?? true,
      },
    });
  };

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleSpecsApi.update(id, { isActive }),
    onSuccess: (_data, values) => {
      message.success(values.isActive ? 'ТТХ активирован' : 'ТТХ деактивирован');
      void queryClient.invalidateQueries({ queryKey: vehicleSpecKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const toggle = (spec: VehicleSpecDto, next: boolean) => {
    if (next) {
      toggleMutation.mutate({ id: spec.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать ТТХ «${spec.name}»?`,
      content: 'Деактивированный ТТХ нельзя привязать к новым типам.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMutation.mutateAsync({ id: spec.id, isActive: false }),
    });
  };

  return {
    actions: { create, edit, toggle, togglePending: toggleMutation.isPending },
    node: (
      <VehicleSpecEditorModal
        open={open}
        record={record}
        form={form}
        pending={save.isPending}
        onCancel={() => setOpen(false)}
        onSubmit={submit}
      />
    ),
  };
}
