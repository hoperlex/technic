import { useState } from 'react';
import { App, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CARGO_AMOUNT_MESSAGE,
  moscowDateKeyOf,
  normalizeTimeInput,
  parseVehicleClassificationKey,
  routeDateMismatch,
  type VehicleRequestDto,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
  type VehicleRequestPeriodResultDto,
} from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRouteLink } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import {
  editTripBody,
  newTripBody,
  retypeErases,
  type FormValues,
  type VehiclePeriodCommand,
} from '@features/vehicle-request-editor';
import { MOSCOW_TZ } from '@shared/config';
import type { PendingPeriodSave, VehicleRequestEditorPeriodModalProps } from './types';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

interface SaveInput {
  period?: VehicleRequestPeriodResultDto;
  values: FormValues;
}

interface Input {
  openRoute: (routeId: string) => void;
  state: VehicleRequestEditorState;
}

export function useVehicleRequestEditorSave({ openRoute, state }: Input) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canApprove = can('vehicleRequests.approve');
  const [periodSave, setPeriodSave] = useState<PendingPeriodSave | null>(null);

  const warnRouteDateMismatch = (saved: VehicleRequestDto) => {
    if (saved.requestType !== 'freight_transport' || !saved.route) return;
    const route = saved.route;
    const routeLink = vehicleRouteLink(can, route.id);
    const mismatch = routeDateMismatch(
      { tripDate: moscowDateKeyOf(new Date(saved.scheduledAt)) },
      { displayNumber: route.displayNumber, routeDate: route.routeDate },
    );
    if (!mismatch) return;
    modal.warning({
      title: 'Дата заявки разошлась с днём маршрута',
      content: mismatch,
      okText: 'Понятно',
      ...(routeLink
        ? {
            cancelText: `Открыть маршрут ${route.displayNumber}`,
            okCancel: true,
            onCancel: () => openRoute(route.id),
          }
        : {}),
    });
  };

  const save = useMutation({
    mutationFn: ({ values, period }: SaveInput) => {
      const picked = parseVehicleClassificationKey(values.classificationKey)!;
      // The period door already recorded the correction; the broad update must not duplicate it.
      const backdate =
        state.backdated && !period
          ? {
              backdateReason: values.backdateReason?.trim(),
              operationId: state.operationId,
            }
          : {};
      const pair = state.customer.customerPairOf(values.customerKey);
      const common = {
        vehicleTypeId: picked.vehicleTypeId,
        vehicleCategoryId: picked.vehicleCategoryId,
        comment: values.comment ?? '',
        ...backdate,
      };
      const retyping = !!state.record && state.record.requestType !== values.requestType;
      const edit = state.record
        ? {
            version: period?.version ?? state.record.version,
            addFileIds: state.editor.newFileIds(),
            removeFileIds: state.editor.removedIds,
          }
        : null;

      if (values.requestType === 'special_equipment') {
        const base = {
          requestType: 'special_equipment' as const,
          objectId: pair.objectId!,
          ...common,
          dateFrom: values.dateFrom!.format('YYYY-MM-DD'),
          dateTo: values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null,
          responsibleName: values.responsibleName!,
          responsiblePhone: values.responsiblePhone!,
        };
        if (!state.record || !edit) {
          return vehicleRequestsApi.create({ ...base, fileIds: state.editor.newFileIds() });
        }
        return retyping
          ? vehicleRequestsApi.changeRequestType(state.record.id, { ...base, ...edit })
          : vehicleRequestsApi.update(state.record.id, { ...base, ...edit });
      }

      const customerBody = pair.departmentId
        ? { departmentId: pair.departmentId }
        : { objectId: pair.objectId! };
      const time = normalizeTimeInput(values.scheduledTime ?? '');
      const scheduledAt = dayjs
        .tz(`${values.scheduledDate!.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        requestType: 'freight_transport' as const,
        ...customerBody,
        ...common,
        scheduledAt,
        scheduledTimeUnspecified: time === undefined,
      };
      const requestDay = values.scheduledDate!.format('YYYY-MM-DD');
      const formTrips = values.trips ?? [];
      const created = formTrips.map((trip) => newTripBody(trip, requestDay));
      if (!state.record || !edit) {
        return vehicleRequestsApi.create({
          ...base,
          trips: created,
          fileIds: state.editor.newFileIds(),
        });
      }
      if (retyping) {
        return vehicleRequestsApi.changeRequestType(state.record.id, {
          ...base,
          trips: created,
          ...edit,
        });
      }
      return vehicleRequestsApi.update(state.record.id, {
        ...base,
        trips: formTrips.map((trip) => editTripBody(trip, requestDay)),
        ...edit,
      });
    },
    onSuccess: (saved) => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      state.setOpen(false);
      warnRouteDateMismatch(saved);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const periodDoorCommand = (values: FormValues): VehiclePeriodCommand | null => {
    const { record } = state;
    if (!record || record.requestType !== 'special_equipment') return null;
    if (values.requestType !== 'special_equipment') return null;
    if (record.status === 'new' || !can('waybills.read')) return null;
    const dateFrom = values.dateFrom!.format('YYYY-MM-DD');
    const dateTo = values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null;
    if (dateFrom === record.dateFrom && dateTo === record.dateTo) return null;
    return { dateFrom, dateTo };
  };

  const submit = (values: FormValues) => {
    const { record } = state;
    if (!record || record.requestType === values.requestType) {
      const command = periodDoorCommand(values);
      if (command && record?.requestType === 'special_equipment') {
        setPeriodSave({ request: record, command, values });
        return;
      }
      save.mutate({ values });
      return;
    }
    const erased = retypeErases(record, !!record.approvedAt && !canApprove);
    modal.confirm({
      title: `Переоформить заявку ${record.displayNumber} в «${vehicleRequestTypeLabels[values.requestType]}»?`,
      content: (
        <>
          <div>У заявки не станет:</div>
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
            {erased.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Typography.Text type="secondary">
            Номер, вложения и история остаются за заявкой.
          </Typography.Text>
        </>
      ),
      okText: 'Переоформить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync({ values }),
    });
  };

  const onFinish = (values: FormValues) => {
    if (values.requestType === 'special_equipment') {
      submit(values);
      return;
    }
    const emptyCargo = state.cargoRequired
      ? (values.trips ?? []).findIndex((trip) => trip.volumeM3 == null && trip.weightTons == null)
      : -1;
    if (emptyCargo >= 0) {
      const trips = values.trips ?? [];
      message.error(
        trips.length > 1
          ? `Строка ${emptyCargo + 1}: ${CARGO_AMOUNT_MESSAGE}`
          : CARGO_AMOUNT_MESSAGE,
      );
      return;
    }
    submit(values);
  };

  const periodModalProps: VehicleRequestEditorPeriodModalProps = {
    request: periodSave?.request ?? null,
    command: periodSave?.command ?? null,
    reason: periodSave?.values.backdateReason,
    operationId: state.operationId,
    onCancel: () => setPeriodSave(null),
    onApplied: (result) => {
      const pending = periodSave;
      setPeriodSave(null);
      if (pending) save.mutate({ values: pending.values, period: result });
    },
  };

  return { confirmLoading: save.isPending, onFinish, periodModalProps };
}
