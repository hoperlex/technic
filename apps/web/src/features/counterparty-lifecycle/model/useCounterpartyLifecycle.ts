import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CounterpartyDto } from '@technic/contracts';
import {
  counterpartiesApi,
  counterpartyErrorMessage as errorMessage,
  counterpartyKeys,
} from '@entities/counterparty';
import { vehicleKeys } from '@entities/vehicle';

/** Own archive and restore commands for counterparty cards. */
export function useCounterpartyLifecycle() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) => counterpartiesApi.remove(id),
    onSuccess: () => {
      message.success('Контрагент удалён');
      void queryClient.invalidateQueries({ queryKey: counterpartyKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const restore = useMutation({
    mutationFn: (id: string) => counterpartiesApi.restore(id),
    onSuccess: () => {
      message.success('Контрагент восстановлен');
      void queryClient.invalidateQueries({ queryKey: counterpartyKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmRemove = (record: CounterpartyDto) =>
    modal.confirm({
      title: `Удалить контрагента «${record.name}»?`,
      content:
        record.type === 'vehicle_lessor'
          ? 'Вся техника этого арендодателя будет выключена. Заявки, где он указан, сохранятся; восстановить запись может администратор.'
          : 'Заявки и учётные записи, где он указан, сохранятся; восстановить запись может администратор.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(record.id),
    });

  return {
    remove: confirmRemove,
    restore: (id: string) => restore.mutate(id),
  };
}
