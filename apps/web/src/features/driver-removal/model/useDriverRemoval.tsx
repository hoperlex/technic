import { useRef } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DriverDto } from '@technic/contracts';
import { driverErrorMessage as errorMessage, driverKeys, driversApi } from '@entities/driver';
import { garageKeys } from '@entities/garage';
import {
  confirmDriverRemoval,
  confirmDriverRemovalStart,
  driverRemovalDetails,
} from '../ui/driverRemovalConfirm';

export interface DriverRemovalController {
  remove: (record: DriverDto) => void;
}

/**
 * Own the two-step soft-removal handshake and its affected cache roots. The first attempt goes
 * without a body: a person without orders is removed in one click. With links the server answers
 * 409 with the consequence list; the portal shows it and retries with the fingerprint of that very
 * list.
 */
export function useDriverRemoval(): DriverRemovalController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  // The acknowledgement must be sent for the same person whose consequences were displayed.
  const targetId = useRef('');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: driverKeys.root });
    void queryClient.invalidateQueries({ queryKey: garageKeys.root });
  };

  const mutation = useMutation({
    mutationFn: ({ id, fingerprint }: { id: string; fingerprint?: string }) =>
      driversApi.remove(id, fingerprint ? { acknowledge: { fingerprint } } : undefined),
    onSuccess: () => {
      message.success('Водитель удалён');
      invalidate();
    },
    onError: (error) => {
      const details = driverRemovalDetails(error);
      if (!details) {
        message.error(errorMessage(error));
        return;
      }
      // The list may change while the dialog is open: the retry carries the new fingerprint, the
      // server checks it again, and the dialog simply re-renders.
      confirmDriverRemoval(modal, details, ({ fingerprint }) =>
        mutation.mutateAsync({ id: targetId.current, fingerprint }),
      );
    },
  });

  return {
    remove: (record) =>
      confirmDriverRemovalStart(modal, record, () => {
        targetId.current = record.id;
        return mutation.mutateAsync({ id: record.id });
      }),
  };
}
