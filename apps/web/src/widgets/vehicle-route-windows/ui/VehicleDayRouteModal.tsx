import { useEffect, useEffectEvent, useRef } from 'react';
import { App, Form, Typography } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  isRelocationPurpose,
  isRouteEditable,
  type PlanVehicleRequestDayBody,
  routeRequestCapacity,
} from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import {
  emptyTrailerGraphs,
  inheritedTrailerGraphs,
  vehicleRouteKeys,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { AutoSelect, FormGrid, FormModal, useFormBlockers } from '@shared/ui';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { formatDateOnly } from '@shared/lib';
import { trailerTripBody } from '@entities/vehicle-route';
import { TrailerFields } from '@features/vehicle-route-trailer';
import { BackdateReasonField } from '@features/backdated-operation';
import { NEW_ROUTE } from '@features/vehicle-assignment';
import { useDayRouteDrivers, useDayRouteFleet } from '../model/useDayRouteOptions';
import type {
  DayRouteFormValues as FormValues,
  VehicleDayRouteModalProps as Props,
} from '../model/dayRouteTypes';

/**
 * Put a day of an on-site equipment order into a route (ADR 0100 decision 8, amended by ADR 0207
 * section 1: linearity no longer turns the day door away).
 *
 * The day and the site are known before the window opens: the day is a row of the "Work days"
 * table, the site is the order itself. Exactly two things are asked, the ones days differ by: WHICH
 * vehicle goes out and WHO drives it. A "plan the week" batch can only repeat one choice, while
 * different units and different people go out on different days.
 *
 * An existing route of this vehicle on this day is offered first and preselected (plan item U13).
 * Without that a second site of the same day would leave on a new route and a new form, whereas 4-P
 * has seven task rows (ADR 0068) precisely so that a vehicle's day fits one waybill.
 *
 * Its own file rather than a block of the day table: a window with a form, three queries and a
 * mutation is a standalone thing, like the neighbouring on-demand ESM-2 issue.
 */

export function VehicleDayRouteModal({ target, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);
  const request = target?.request ?? null;
  const date = target?.date ?? '';

  const vehicleId = Form.useWatch('vehicleId', form);
  const routeId = Form.useWatch('routeId', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;

  /**
   * The route was picked by hand, so the default no longer touches it. The flag is raised by the
   * first change of the field and reset by a change of day or vehicle: another unit has its own
   * routes.
   */
  const routeTouched = useRef(false);

  /**
   * Fields are reset on a day change, not on unmount: the window is reused for neighbouring days of
   * the term, and a driver left over from Tuesday would read as Wednesday's decision.
   *
   * The assigned vehicle is preselected: for an on-site order it is the default vehicle (ADR 0100
   * decision 4) and closes most days. The driver is never preselected (ADR 0083).
   */
  const resetForDay = useEffectEvent((_id?: string, _day?: string) => {
    if (!target) return;
    routeTouched.current = false;
    form.setFieldsValue({
      vehicleId: target.request.assignment?.vehicleId,
      routeId: NEW_ROUTE,
      driverPersonId: undefined,
      ...emptyTrailerGraphs(),
      reason: undefined,
    });
  });
  useEffect(() => resetForDay(request?.id, target?.date), [request?.id, target?.date]);

  /*
   * A past day (ADR 0101 item 4, plan gap 1). The day rule allows the past (a departure is recorded
   * retroactively too, planDayBlocker), but the server asks for a right and a reason: a route
   * created by this window is no different from one created from the route side, where the reason
   * has long been asked.
   *
   * The boundary is the server's cut-off day, not the browser's new Date(): the endpoint computes
   * it in the same time zone.
   */
  const past = !!target && date < target.onDate;

  const { fleet, fleetLoading, vehicleOptions } = useDayRouteFleet({
    enabled: !!target,
    assignment: request?.assignment ?? null,
  });

  /**
   * Routes of this vehicle on this day, header fields of its previous route and its pinned
   * trailers.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, date),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date }),
    enabled: !!target && !!vehicleId,
  });

  /**
   * Trailer fields are inherited from the previous route, as they were before stage E4, only now
   * they are visible and editable. Pinning overrides them and labels itself (TrailerFields).
   */
  useEffect(() => {
    const graphs = inheritedTrailerGraphs(suggestion?.trip, suggestion?.hitched);
    if (graphs) form.setFieldsValue(graphs);
  }, [suggestion?.trip, suggestion?.hitched, form]);

  /**
   * Where the day can go: a route with a free task row, not frozen by an issued waybill and not a
   * relocation (a relocation rides on its own base request and takes no work days). The selection
   * mirrors what the server checks, otherwise the list would offer routes it rejects.
   */
  const routeOptions = (suggestion?.routes ?? []).filter(
    (r) =>
      !isRelocationPurpose(r.purpose) &&
      r.requests.length < routeRequestCapacity(r.formCode) &&
      isRouteEditable(r.waybill?.status ?? null),
  );

  /**
   * Default of the "Route" field: the vehicle's existing route, if any. A server answer arriving
   * later does not overwrite a hand-made choice; routeTouched guards that.
   */
  const applyRouteDefault = useEffectEvent((_routes: unknown) => {
    if (routeTouched.current) return;
    form.setFieldsValue({ routeId: routeOptions[0]?.id ?? NEW_ROUTE });
  });
  useEffect(() => applyRouteDefault(suggestion?.routes), [suggestion?.routes]);

  /**
   * An existing route is chosen: it already has its own driver and departure details, no need to
   * ask them.
   */
  const joined = routeOptions.find((r) => r.id === routeId) ?? null;

  /**
   * The chosen unit: its form decides whether the trailer is asked, its type whether the checkbox
   * sets itself.
   */
  const selectedVehicle = (fleet?.items ?? []).find((v) => v.id === vehicleId) ?? null;

  const { driverOptions, driversLoading } = useDayRouteDrivers({
    vehicleId,
    date,
    withTrailer,
    enabled: !!target && !!vehicleId && !joined,
  });

  const plan = useMutation({
    mutationFn: (v: FormValues) => {
      // The reason is sent only for a past day: for today and tomorrow the server does not ask for
      // it.
      const backdate = past ? { reason: v.reason } : {};
      const body: PlanVehicleRequestDayBody =
        v.routeId && v.routeId !== NEW_ROUTE
          ? { routeId: v.routeId, ...backdate }
          : {
              newRoute: {
                vehicleId: v.vehicleId!,
                driverPersonId: v.driverPersonId ?? null,
                // Header fields are inherited from the vehicle's previous route: garage number and
                // the kinds of communication and transportation describe the vehicle itself and
                // change once a season, not every route. Asking them per day would ask the same
                // question once a day. The trailer is excluded from this rule: the window now shows
                // and asks it, and it leaves from the form, not from the suggestion.
                trip: {
                  garageNumber: '',
                  communicationKind: '',
                  transportationKind: '',
                  ...suggestion?.trip,
                  ...trailerTripBody(v),
                },
              },
              ...backdate,
            };
      return vehicleRequestsApi.planDay(request!.id, date, body);
    },
    onSuccess: (days) => {
      message.success(`День ${formatDateOnly(date)} поставлен в рейс`);
      onDone(days);
    },
    // Server refusals here are named ("day outside the request term", "day already in a route") and
    // land on their field (ADR 0094). The toast remains for what has no field: a race between two
    // dispatchers and a route frozen by its waybill.
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={target ? `День ${formatDateOnly(date)} в рейс` : 'День в рейс'}
      open={!!target}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={plan.isPending}
      okText="Поставить в рейс"
      width={640}
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        onFinish={(v) => plan.mutate(v)}
        {...blockers.formProps}
      >
        <FormGrid>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary">
              {request ? `Заявка ${request.displayNumber} · ${request.objectName}. ` : ''}
              День и объект уже известны — остаётся сказать, какая машина выходит и кто на ней.
              Работа дня напечатается строкой задания в путевом листе рейса.
            </Typography.Paragraph>
          </FormGrid.Full>

          {/* The vehicle is asked rather than silently taken from the assignment: for an
              on-site order the assignment is the default vehicle (ADR 0100 decision 4), and on
              a given day the one whose route closes the day goes out. The assigned one is
              preselected: it works most often. */}
          <Form.Item
            name="vehicleId"
            label="Машина"
            rules={[{ required: true, message: 'Выберите машину' }]}
            extra="Подставлена машина заявки; на разные дни срока выходят разные единицы"
          >
            <AutoSelect
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={fleetLoading}
              placeholder="Выберите машину"
              notFoundContent="Собственной техники в работе нет"
              onChange={() => {
                // Another unit has its own routes: the chosen one is reset, and the default will
                // pick the new vehicle's existing route as soon as the suggestion arrives.
                routeTouched.current = false;
                form.setFieldsValue({ routeId: NEW_ROUTE, driverPersonId: undefined });
              }}
            />
          </Form.Item>

          {/* The vehicle's existing route for this day comes first and preselected: a second
              site of the same day must get into the same waybill while it has task rows left
              (ADR 0068), instead of creating a second form for the same vehicle and day. */}
          <Form.Item
            name="routeId"
            label="Рейс"
            extra={
              routeOptions.length > 0
                ? 'У машины уже есть рейс на этот день — день встанет его строкой задания'
                : 'Рейсов этой машины на этот день нет — день заведёт новый маршрут'
            }
          >
            <AutoSelect
              options={[
                ...routeOptions.map((r) => ({
                  value: r.id,
                  label: [
                    r.displayNumber,
                    r.driverName || 'водитель не назначен',
                    `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                  ].join(' · '),
                })),
                { value: NEW_ROUTE, label: 'Новый маршрут' },
              ]}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите рейс"
              onChange={() => {
                routeTouched.current = true;
              }}
            />
          </Form.Item>

          {/* The driver is an empty optional field, and that is not the portal forgetting:
              routes are assembled in advance, the person is set in the morning, and different
              people go out on different days (ADR 0083). An existing route already has its
              driver, which is shown; there is no need to ask for a second one. */}
          <FormGrid.Full>
            {joined ? (
              <Form.Item label="Водитель">
                <Typography.Text type="secondary">
                  {joined.driverName
                    ? `Водитель рейса ${joined.displayNumber} — ${joined.driverName}`
                    : `В рейсе ${joined.displayNumber} водитель ещё не назначен: его ставят в карточке маршрута`}
                </Typography.Text>
              </Form.Item>
            ) : (
              <Form.Item
                name="driverPersonId"
                label="Водитель"
                extra="Необязательно: рейс собирают заранее, человека ставят утром — портал вчерашнего не подставляет"
              >
                <AutoSelect
                  autoSelectSole={false}
                  allowClear
                  options={driverOptions}
                  showSearch
                  optionFilterProp="label"
                  loading={driversLoading}
                  placeholder="Кто выходит в этот день"
                  notFoundContent="Подходящих водителей на этот день нет"
                />
              </Form.Item>
            )}
          </FormGrid.Full>

          {/* Trailer of a new route: an existing route has its own departure details, and form
              No. 3 has no trailer fields at all (ADR 0071). The checkbox raises the requirement
              to CE and rebuilds the list above. */}
          <TrailerFields
            key={`${request?.id}:${date}`}
            withTrailer={withTrailer}
            checkboxLabel="Рейс с прицепом"
            checkboxFullWidth
            modelPlaceholder="СЗАП-8551"
            regNumberPlaceholder="АВ1234 77"
            secondPlaceholder="Если прицепов два"
            hitched={suggestion?.hitched}
            vehicleId={vehicleId}
            vehicleTypeId={selectedVehicle?.vehicleTypeId}
            // Visibility goes through the asks prop instead of unmounting: an unmounted block
            // removed the question but kept its answer (section 14, R20).
            asks={!joined && selectedVehicle?.waybillFormCode !== 'leg3'}
          />

          {/* A past day requires the right and a reason (ADR 0101 item 4). Placing a day
              creates no correction-log row: it spends no strict-accounting number, and the
              explanation goes into the event audit. The reason for the paper is asked by
              issuing the route's waybill. */}
          {past && (
            <FormGrid.Full>
              <BackdateReasonField
                effectiveDate={date}
                consequence="день встанет в рейс задним числом — с вашим именем и этой причиной в журнале событий"
                placeholder="Например: машина отработала день, в портал вносим по факту"
              />
            </FormGrid.Full>
          )}
        </FormGrid>
      </Form>
    </FormModal>
  );
}
