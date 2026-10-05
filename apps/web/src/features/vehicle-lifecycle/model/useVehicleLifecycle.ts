import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VehicleDto } from '@technic/contracts';
import { vehicleTitle } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { vehicleErrorMessage as errorMessage, vehicleKeys, vehiclesApi } from '@entities/vehicle';
import { unhitchedNotice } from '@entities/vehicle-trailer';

/** Own recoverable vehicle archival and restore commands. */
export function useVehicleLifecycle() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) => vehiclesApi.remove(id),
    onSuccess: ({ unhitchedTrailers }) => {
      message.success('Перемещено в архив');
      // Archival removes the vehicle from every normal list, so this is the last place where a
      // released trailer can be explained to the operator (plan §4.2.3).
      if (unhitchedTrailers) {
        message.warning(unhitchedNotice(unhitchedTrailers, 'уходом в архив'), 8);
      }
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const restore = useMutation({
    mutationFn: (id: string) => vehiclesApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmRemove = (record: VehicleDto) =>
    modal.confirm({
      title: `Переместить в архив «${vehicleTitle(record)}»?`,
      okText: 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(record.id),
    });

  return {
    remove: confirmRemove,
    restore: (id: string) => restore.mutate(id),
  };
}
