import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Form, Input, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routeRequestCapacity,
  shiftDateKey,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  WAYBILL_CORRECTION_CONFIRM,
} from '@technic/contracts';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { garageKeys } from '@entities/garage';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { formatDateOnly } from '@shared/lib';

/**
 * Moving a request between routes of past days (ADR 0101 item 14, R30): "filed for Wednesday, but
 * driven on Tuesday".
 *
 * A window separate from the regular transfer (`VehicleRouteTransferModal`), not for convenience
 * but because the actions cost different things. A regular transfer moves the **plan**: the routes
 * are not documents yet, and it costs nothing. Here both routes have already been driven and both
 * have issued paper: the transfer cancels **two** strict-reporting numbers and issues two new ones
 * from the tail of the series instead (R10). So the window must name both numbers that will burn
 * **before** the press (plan section 5 item 2), ask for a reason and explain that the request will
 * travel by the target route's vehicle.
 *
 * Consequences and blockers are computed by the server with the same read the route correction
 * window uses (`GET /vehicle-routes/:id/correction`), once per side. A second calculation in the
 * portal would drift from the first, and the window would promise something other than what
 * actually happens.
 */

/** How many days around the source day to offer as targets. */
const NEIGHBOURHOOD_DAYS = 7;

interface Props {
  /** Source route; `null` means the window is closed. */
  route: VehicleRouteDto | null;
  /** The source's ticket being transferred. */
  request: VehicleRouteRequestDto | null;
  onClose: () => void;
  /**
   * The transfer succeeded: both sides come from the response, and lists and cards are no longer
   * the same after this.
   *
   * Both come with route points: the transfer lays out the request's trips in the target and
   * cleans up emptied stops in the source (section 7), and the card puts the response into the
   * cache as is.
   */
  onDone: (result: { target: VehicleRouteDto; source: VehicleRouteDto }) => void;
}

export function VehicleRouteTransferCorrectionModal({ route, request, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ routeId?: string; reason: string }>();
  const targetId = Form.useWatch('routeId', form);

  /**
   * The idempotency key (R31) and the versions of both routes are fixed when the window **opens**,
   * not on each submission attempt. The server computes the command fingerprint over the whole
   * body, versions included: a retry after a dropped connection must send exactly what was sent
   * the first time. A body rebuilt with a fresh version is a different command, and the answer to
   * it is 409 rather than the earlier result.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!route) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ routeId: undefined, reason: '' });
    // The only dependencies are the route and request ids: if the effect tracked the whole
    // objects, the operation key would reset on every card refresh, while it must stay unchanged
    // for as long as the window is open (otherwise a retry would go out under a new key and burn
    // a second pair of numbers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, request?.requestId, form]);

  /**
   * Where to transfer: routes of neighbouring days. A one-week window on each side is exactly the
   * subject of the operation ("driven on a different day than filed"), while the whole route
   * journal in a dropdown would be not a hint but a second route list. A free task line is not
   * filtered by the server: how many lines a blank has is decided by its form (ADR 0068), and the
   * portal counts it with the same rule.
   */
  const { data: candidates, isFetching } = useQuery({
    queryKey: vehicleRouteKeys.transferCandidates(route?.id),
    queryFn: () =>
      vehicleRoutesApi.list({
        dateFrom: shiftDateKey(route!.routeDate, -NEIGHBOURHOOD_DAYS),
        dateTo: shiftDateKey(route!.routeDate, NEIGHBOURHOOD_DAYS),
        page: 1,
        pageSize: 200,
        sortBy: 'routeDate',
        sortOrder: 'asc',
      }),
    enabled: !!route,
  });

  const options = useMemo(
    () =>
      (candidates?.items ?? []).filter(
        (r: VehicleRouteDto) =>
          r.id !== route?.id &&
          // A relocation carries no customer tickets: only its single basis request rides on it
          // (ADR 0057).
          r.purpose === 'freight' &&
          r.requests.length < routeRequestCapacity(r.formCode),
      ),
    [candidates, route?.id],
  );
  const target = options.find((r) => r.id === targetId) ?? null;

  /*
   * The cost of the operation, on both sides and with the same read as the route correction
   * window. It is requested per route rather than with one request per pair: correction rules are
   * evaluated for each route separately (they have different days and therefore different depth,
   * R37), and a single endpoint for both sides would mean a third copy of the same rules.
   */
  const sourcePreview = useQuery({
    queryKey: vehicleRouteKeys.correctionPreview(route?.id),
    queryFn: () => vehicleRoutesApi.correctionPreview(route!.id),
    enabled: !!route,
  });
  const targetPreview = useQuery({
    queryKey: vehicleRouteKeys.correctionPreview(targetId),
    queryFn: () => vehicleRoutesApi.correctionPreview(targetId!),
    enabled: !!targetId,
  });

  /** What blocks the transfer right now: either side may refuse (R3, R13, R37). */
  const blocking = sourcePreview.data?.blocking ?? targetPreview.data?.blocking ?? null;
  /** The source will become empty and gets no second sheet (R22); say so before the press. */
  const emptiesSource = (sourcePreview.data?.requests.length ?? 0) <= 1;

  const transfer = useMutation({
    mutationFn: (reason: string) =>
      vehicleRoutesApi.transferCorrection(target!.id, {
        operationId,
        version: target!.version,
        // The source is sent as an "id + version" pair: versions are numbered per route, and the
        // server checks both because it burns both numbers.
        source: { routeId: route!.id, version: route!.version },
        requestId: request!.requestId,
        reason,
      }),
    onSuccess: async (result) => {
      message.success(
        `${request!.displayNumber} перенесена в ${result.target.displayNumber}: выписан лист ${
          result.target.waybill?.number ?? ''
        }`,
      );
      qc.setQueryData(vehicleRouteKeys.detail(result.target.id), result.target);
      qc.setQueryData(vehicleRouteKeys.detail(result.source.id), result.source);
      // After a transfer the sheet journal, requests and the garage show something else: two
      // cancelled numbers, new numbers and a different vehicle for the day.
      await Promise.all([
        qc.invalidateQueries({ queryKey: waybillKeys.root }),
        qc.invalidateQueries({ queryKey: vehicleRequestKeys.root }),
        qc.invalidateQueries({ queryKey: garageKeys.root }),
      ]);
      onDone(result);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: { routeId?: string; reason: string }) => {
    if (!v.routeId) {
      message.error('Выберите рейс-приёмник');
      return;
    }
    if (blocking) {
      message.error(blocking.reason);
      return;
    }
    transfer.mutate(v.reason);
  };

  return (
    <FormModal
      title={
        request && route
          ? `${request.displayNumber} · перенести из ${route.displayNumber} задним числом`
          : 'Перенос между рейсами'
      }
      open={!!route && !!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={transfer.isPending}
      okText="Перенести и перевыписать листы"
      okDanger
      width={640}
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <FormGrid>
          {/* A refusal from either side (R3, R13): the composition of both routes must be in
            progress, because the new sheets print the task for the whole composition. Someone else
            has to fix that; the window names who. */}
          {blocking && (
            <FormGrid.Full>
              <Alert
                type="error"
                showIcon
                title="Перенести сейчас нельзя"
                description={
                  <>
                    {blocking.reason}
                    {blocking.requests.length > 0 && (
                      <div>Заявки: {blocking.requests.join(', ')}</div>
                    )}
                  </>
                }
              />
            </FormGrid.Full>
          )}

          <FormGrid.Full>
            <Form.Item
              name="routeId"
              label="Рейс-приёмник"
              rules={[{ required: true, message: 'Выберите рейс' }]}
              extra={`Рейсы за ${NEIGHBOURHOOD_DAYS} дней вокруг ${
                route ? formatDateOnly(route.routeDate) : 'дня источника'
              } со свободной строкой задания`}
            >
              <AutoSelect
                autoSelectSole={false}
                options={options.map((r) => ({
                  value: r.id,
                  label: [
                    formatDateOnly(r.routeDate),
                    r.displayNumber,
                    r.vehicleLabel,
                    r.driverName || 'водитель не назначен',
                    `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                    // The target's sheet number is part of the cost: it burns together with the
                    // source's number.
                    r.waybill && r.waybill.status !== 'cancelled'
                      ? `лист ${r.waybill.number}`
                      : 'листа нет',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={options.length === 0}
                placeholder={
                  options.length > 0 ? 'Куда ехала на самом деле' : 'Подходящих рейсов рядом нет'
                }
              />
            </Form.Item>
          </FormGrid.Full>

          {/* Both burning numbers are shown before the press (plan section 5 item 2). Until a
            target is chosen, half of the cost is named, which is more honest than silence: the
            source's number burns in any case. */}
          <FormGrid.Full>
            <Alert
              type="warning"
              showIcon
              title="Что произойдёт с двумя рейсами"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  <li>
                    {sourcePreview.data?.waybill
                      ? `Номер ${sourcePreview.data.waybill.number} рейса ${route?.displayNumber} будет аннулирован.`
                      : `У рейса ${route?.displayNumber ?? ''} действующего листа нет — аннулировать нечего.`}{' '}
                    {emptiesSource
                      ? 'Этот талон в нём последний: рейс останется пустым, и второй лист на него не выпишется.'
                      : 'Взамен выпишется следующий по серии — уже без этого талона.'}
                  </li>
                  <li>
                    {target
                      ? targetPreview.data?.waybill
                        ? `Номер ${targetPreview.data.waybill.number} рейса ${target.displayNumber} будет аннулирован, взамен выпишется следующий по серии — с этим талоном.`
                        : `У рейса ${target.displayNumber} действующего листа нет — коррекция выпишет новый номер с этим талоном.`
                      : 'Выберите приёмник — его номер сгорит вторым.'}
                  </li>
                  {target && target.vehicleId !== route?.vehicleId && (
                    <li>
                      {request?.displayNumber} поедет машиной приёмника — {target.vehicleLabel}:
                      рейс источник истины о том, чем едут. Ставка останется прежней, о ней
                      договариваются по заявке.
                    </li>
                  )}
                  {target && target.routeDate !== route?.routeDate && (
                    <li>
                      День рейса сменится с {formatDateOnly(route!.routeDate)} на{' '}
                      {formatDateOnly(target.routeDate)}. Дата подачи самой заявки останется прежней
                      — её правят в карточке заявки, отдельной причиной.
                    </li>
                  )}
                  <li>{WAYBILL_CORRECTION_CONFIRM}</li>
                </ul>
              }
            />
          </FormGrid.Full>

          {/* The reason is mandatory: it goes into the operation record and is printed on all four
            sheets: on both cancelled ones as the cancellation reason, on both new ones as the
            correction reason (R16, R35). */}
          <FormGrid.Full>
            <Form.Item
              name="reason"
              label="Причина переноса"
              rules={[{ required: true, message: 'Укажите причину' }]}
              extra="Останется в журнале коррекций и в листах обоих рейсов"
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Например: заявку оформили средой, а машина отработала её во вторник"
              />
            </Form.Item>
          </FormGrid.Full>

          <FormGrid.Full>
            <Typography.Text type="secondary">
              Талон встанет в приёмнике последним. Порядок строк задания правится коррекцией самого
              рейса — «Исправить исполнение».
            </Typography.Text>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
