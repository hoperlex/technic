import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WasteTariffDto } from '@technic/contracts';
import {
  wasteTariffErrorMessage as errorMessage,
  wasteTariffKeys,
  wasteTariffsApi,
} from '@entities/waste-tariff';

export interface WasteTariffLifecycleController {
  toggle: (tariff: WasteTariffDto, next: boolean) => void;
  pending: boolean;
}

/** Own guarded tariff activation/deactivation and its cache effect. */
export function useWasteTariffLifecycle(): WasteTariffLifecycleController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  // Tariff rows are historical price anchors, so removal is not a lifecycle transition: normal
  // withdrawal is an isActive update and permanent purge remains a separate guarded feature.
  const mutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      wasteTariffsApi.update(id, { isActive }),
    onSuccess: (_data, values) => {
      message.success(values.isActive ? 'Цена включена' : 'Цена отключена');
      void queryClient.invalidateQueries({ queryKey: wasteTariffKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const toggle = (tariff: WasteTariffDto, next: boolean) => {
    if (next) {
      mutation.mutate({ id: tariff.id, isActive: true });
      return;
    }
    modal.confirm({
      title: `Отключить цену «${tariff.wasteTypeName}» у оператора «${tariff.operatorName}»?`,
      content:
        'Новые заявки этого оператора на такую пару «мусор × техника» перестанут тарифицироваться. Суммы уже оформленных заявок не изменятся.',
      okText: 'Отключить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => mutation.mutateAsync({ id: tariff.id, isActive: false }),
    });
  };

  return { toggle, pending: mutation.isPending };
}
