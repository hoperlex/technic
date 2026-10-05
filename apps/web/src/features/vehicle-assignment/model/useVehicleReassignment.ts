import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VehicleRequestDto } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { reassignRequestBody, type AssignCommand } from './command';
import { assignmentRecheckReason } from './recheck';

export function useVehicleReassignment() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  // A vehicle change of a running request (ADR 0048) is its own command: status does not change.
  const [target, setTarget] = useState<VehicleRequestDto | null>(null);
  const mutation = useMutation({
    mutationFn: (value: { id: string; version: number; command: AssignCommand }) =>
      vehicleRequestsApi.changeAssignment(
        value.id,
        reassignRequestBody(value.command, value.version),
      ),
    onSuccess: (_updated, value) => {
      message.success(
        value.command.correction ? 'Назначение исправлено задним числом' : 'Техника изменена',
      );
      setTarget(null);
      void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // The request moves to the new vehicle's route — route lists are stale afterwards.
      void queryClient.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // A vehicle change rewrites waybills too: the server reconciles the route's ESM-2 (ADR 0037).
      void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
    },
    // A stale consequence preview is a question handled inside the assignment dialog, not a
    // second toast. Other failures still use the entity-owned field labels.
    onError: (error) => {
      if (assignmentRecheckReason(error)) return;
      message.error(errorMessage(error));
    },
  });

  return {
    target,
    open: setTarget,
    close: () => setTarget(null),
    pending: mutation.isPending,
    // `mutateAsync`, not `mutate`: the dialog awaits the server answer — a 409 "consequences
    // changed" is cured by showing them again, and it is the dialog that must learn of the
    // refusal (wave 4a).
    submit: (command: AssignCommand) =>
      target
        ? mutation.mutateAsync({ id: target.id, version: target.version, command })
        : undefined,
  };
}
