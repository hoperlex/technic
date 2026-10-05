import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VehicleClassificationDto } from '@technic/contracts';
import {
  vehicleCategoriesApi,
  vehicleCategoryKeys,
  vehicleClassificationKeys,
  vehicleTypeErrorMessage as errorMessage,
  vehicleTypeKeys,
  vehicleTypesApi,
} from '@entities/vehicle-type';

export interface VehicleClassificationLifecycleController {
  toggle: (row: VehicleClassificationDto, next: boolean) => void;
  pending: boolean;
}

/** Activate exactly the category or type represented by a flat classifier row. */
export function useVehicleClassificationLifecycle(): VehicleClassificationLifecycleController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ row, isActive }: { row: VehicleClassificationDto; isActive: boolean }) => {
      if (row.vehicleCategoryId) {
        await vehicleCategoriesApi.update(row.vehicleCategoryId, { isActive });
        return;
      }
      await vehicleTypesApi.update(row.vehicleTypeId, { isActive });
    },
    onSuccess: (_data, values) => {
      const subject = values.row.vehicleCategoryId ? 'Категория' : 'Тип';
      message.success(
        `${subject} ${values.isActive ? 'активирован' : 'деактивирован'}${values.row.vehicleCategoryId ? 'а' : ''}`,
      );
      void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleTypeKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleCategoryKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const toggle = (row: VehicleClassificationDto, next: boolean) => {
    if (next) {
      mutation.mutate({ row, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать «${row.label}»?`,
      content: row.vehicleCategoryId
        ? 'Заказать эту категорию будет нельзя; остальные категории типа останутся доступны.'
        : 'Заказать этот тип и любую его категорию будет нельзя.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => mutation.mutateAsync({ row, isActive: false }),
    });
  };

  return { toggle, pending: mutation.isPending };
}
