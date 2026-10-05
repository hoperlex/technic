import { useMemo, useState } from 'react';
import { App, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLANK_WAYBILL_CONFIRM,
  canCancelWaybill,
  canCorrectRoute,
  canIssueWaybill,
  driverDocumentGapsWarning,
  isRelocationPurpose,
  isRouteEditable,
  moscowDateKeyOf,
  routeRequestCapacity,
  type VehicleRequestDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  waybillFormShortLabels,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import {
  assembleRoute,
  vehicleRouteErrorMessage as errorMessage,
  vehicleRouteKeys,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { waybillKeys, waybillsApi } from '@entities/waybill';
import { ackRequiredDetails, confirmWaybillWarnings } from '@features/waybill-issue';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';

interface Args {
  routeId: string | null;
  onChanged: () => void;
}

type IssueAttempt = {
  backdate?: { reason: string; operationId: string };
  acknowledge?: { fingerprint: string };
};

/** Own route-card queries, commands and child-window state without owning its presentation. */
export function useVehicleRouteWindow({ routeId, onChanged }: Args) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | undefined>();
  const [correcting, setCorrecting] = useState(false);
  const [transferring, setTransferring] = useState<VehicleRouteRequestDto | null>(null);

  // A request edit may raise the route version, so a reopened card must not trust stale data.
  const { data: route, isFetching } = useQuery({
    queryKey: vehicleRouteKeys.detail(routeId),
    queryFn: () => vehicleRoutesApi.get(routeId!),
    enabled: !!routeId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  const { data: candidates } = useQuery({
    queryKey: vehicleRequestKeys.forRoute(route?.routeDate),
    queryFn: () =>
      vehicleRequestsApi.list({
        status: 'confirmed',
        requestType: 'freight_transport',
        dateFrom: route!.routeDate,
        dateTo: route!.routeDate,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!route && !frozen,
  });
  const free = (candidates?.items ?? []).filter(
    (request: VehicleRequestDto) =>
      request.assignment?.ownership === 'own' &&
      request.route?.id !== route?.id &&
      !(request.route && request.route.hasWaybill),
  );

  const afterChange = (updated: VehicleRouteDto) => {
    qc.setQueryData(vehicleRouteKeys.detail(updated.id), updated);
    onChanged();
  };
  const fail = (error: unknown) => {
    message.error(errorMessage(error));
    // A conflict means either a stale version or a newly frozen route; both invalidate its family.
    if (isApiError(error) && error.status === 409) {
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
    }
  };

  const candidate = free.find((request) => request.id === adding) ?? null;
  const attach = useMutation({
    mutationFn: (requestId: string) => {
      const source = free.find((request) => request.id === requestId)?.route ?? null;
      return vehicleRoutesApi.attach(route!.id, {
        requestId,
        version: route!.version,
        source: source ? { routeId: source.id, version: source.version } : undefined,
      });
    },
    onSuccess: (updated) => {
      setAdding(undefined);
      afterChange(updated);
    },
    onError: fail,
  });
  const detach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.detach(route!.id, requestId, route!.version),
    onSuccess: afterChange,
    onError: fail,
  });

  const issue = useMutation({
    mutationFn: (attempt: IssueAttempt) =>
      vehicleRoutesApi.issueWaybill(route!.id, {
        version: route!.version,
        ...(attempt.backdate ?? {}),
        ...(attempt.acknowledge ? { acknowledge: attempt.acknowledge } : {}),
      }),
    onSuccess: (updated) => {
      message.success(`Путевой лист ${updated.waybill?.number ?? ''} выписан`);
      afterChange(updated);
    },
    onError: (error, attempt) => {
      const details = ackRequiredDetails(error);
      if (details) {
        confirmWaybillWarnings(modal, details, (acknowledge) =>
          issue.mutateAsync({ ...attempt, acknowledge }),
        );
      } else fail(error);
    },
  });

  const formLabel = route?.formCode ? waybillFormShortLabels[route.formCode] : null;
  const driverGaps = route
    ? driverDocumentGapsWarning(route.driverGaps, 'driver_license', formLabel)
    : null;
  const blank = !!route && !isRelocationPurpose(route.purpose) && route.requests.length === 0;
  const past = !!route && route.routeDate < moscowDateKeyOf(new Date());

  const confirmBackdatedIssue = () => {
    let reason = '';
    const operationId = crypto.randomUUID();
    modal.confirm({
      title: `Выписать лист за ${route ? formatDateOnly(route.routeDate) : 'прошедший день'}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            День уже прошёл: лист уйдёт в журнал с меткой коррекции, вашим именем и этой причиной.
            {blank ? ` ${BLANK_WAYBILL_CONFIRM}` : ''}
            {driverGaps ? ` ${driverGaps}` : ''}
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            aria-label="Причина выписки задним числом"
            placeholder="Например: бумагу выписали в тот день на месте, в портал вносим сегодня"
            onChange={(event) => {
              reason = event.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Выписать задним числом',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await issue.mutateAsync({ backdate: { reason, operationId } });
      },
    });
  };

  const confirmIssue = () => {
    if (past) return confirmBackdatedIssue();
    if (!driverGaps && !blank) return issue.mutate({});
    modal.confirm({
      title: blank ? 'Выписать пустой лист?' : 'Выписать лист с незаполненными графами?',
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {blank ? BLANK_WAYBILL_CONFIRM : driverGaps} {blank && driverGaps ? `${driverGaps} ` : ''}
          Номер бланка израсходуется: чтобы переписать лист, его придётся аннулировать.
        </Typography.Paragraph>
      ),
      okText: 'Всё равно выписать',
      cancelText: 'Отмена',
      onOk: () => issue.mutateAsync({}),
    });
  };

  const cancelWaybill = useMutation({
    mutationFn: (reason: string) => waybillsApi.cancel(route!.waybill!.id, { reason }),
    onSuccess: async () => {
      message.success('Лист аннулирован — маршрут снова можно править');
      await qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      await qc.invalidateQueries({ queryKey: waybillKeys.root });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onChanged();
    },
    onError: fail,
  });
  const confirmCancelWaybill = () => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${route?.waybill?.number}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: после правки рейса выпишется новый.
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            placeholder="Причина: испорчен при печати, сменился водитель…"
            onChange={(event) => {
              reason = event.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelWaybill.mutateAsync(reason);
      },
    });
  };

  const readiness = route
    ? canIssueWaybill({
        purpose: route.purpose,
        driverPersonId: route.driverPersonId,
        blankAllowed: can('waybills.issueBlank'),
        formCode: route.formCode,
        requests: route.requests,
        sourceRequest: route.sourceRequest,
        waybillStatus: route.waybill?.status ?? null,
      })
    : null;
  const relocation = !!route && isRelocationPurpose(route.purpose);
  const sourceRequest = route?.sourceRequest ?? null;
  const assembly = useMemo(() => (route ? assembleRoute(route) : null), [route]);
  const blocking = assembly?.blockers.find((item) => item.code !== 'no_driver') ?? null;
  const canAddRequest =
    !!route &&
    !relocation &&
    !frozen &&
    route.requests.length < routeRequestCapacity(route.formCode);
  const waybillEditable =
    !!route?.waybill &&
    route.waybill.status === 'issued' &&
    canCancelWaybill(route.waybill, moscowDateKeyOf(new Date()));
  const correction =
    route && past && can('waybills.correct')
      ? canCorrectRoute(route, moscowDateKeyOf(new Date()), {
          unlimited: can('waybills.correctBeyondLimit'),
        })
      : null;

  return {
    adding,
    afterChange,
    assembly,
    attach,
    blocking,
    canAddRequest,
    candidate,
    confirmCancelWaybill,
    confirmIssue,
    correcting,
    correction,
    detach,
    driverGaps,
    fail,
    free,
    frozen,
    isFetching,
    issue,
    readiness,
    relocation,
    route,
    setAdding,
    setCorrecting,
    setTransferring,
    sourceRequest,
    transferring,
    waybillEditable,
  };
}

export type VehicleRouteWindowController = ReturnType<typeof useVehicleRouteWindow>;
