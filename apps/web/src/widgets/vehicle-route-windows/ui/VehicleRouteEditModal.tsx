import { useEffect } from 'react';
import { App, DatePicker, Form, Input, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  communicationKindOptions,
  DEFAULT_COMMUNICATION_KIND,
  isRelocationPurpose,
  isRouteEditable,
  minRequestDateKey,
  moscowDateKeyOf,
  movedRouteDateKey,
  ROUTE_FROZEN_MESSAGE,
  routePurposeLabels,
  type VehicleRouteDto,
  WAYBILL_CORRECTION_DAYS,
} from '@technic/contracts';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '@entities/session';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { trailerTripBody } from '@entities/vehicle-route';
import { TrailerFields } from '@features/vehicle-route-trailer';
import { BackdateReasonField } from '@features/backdated-operation';
import { useRouteEditDrivers } from '../model/useRouteEditDrivers';

/**
 * Route edit: day, driver, departure details, comment and, for a relocation, "from -> to".
 *
 * The route card used to change only the composition: the driver was set when a request was taken
 * into work, and a wrong day was fixed by rebuilding the route. Meanwhile routes are edited every
 * morning: someone fell ill, a vehicle did not go out, departure moved by a day.
 *
 * The date moves the route together with its requests (server, moveRouteToDate): the route day and
 * the delivery day are one event seen from two sides. The window names what will move before the
 * click: the dispatcher must see they move more than the route row.
 *
 * An issued waybill forbids editing entirely (isRouteEditable): the paper is with the driver, and a
 * record diverging from it is worse than no record (ADR 0037 item 9).
 *
 * Retroactively (ADR 0101 items 4 and 6, R29) the window asks a reason ONLY for the date. Driver,
 * details and comment of a past route are edited as before: until there is a waybill the route is a
 * planning record, and the server asks no right for editing it either. Moving the day is different:
 * the delivery of its requests moves with the route, i.e. the customer's calendar moves. The rule
 * is shared with the server (movedRouteDateKey plus minRequestDateKey) because they must not
 * diverge: the form must neither ask a reason where the endpoint does not expect one nor send what
 * will be answered with 403.
 */

const DATE = 'YYYY-MM-DD';

interface FormValues {
  routeDate: dayjs.Dayjs;
  driverPersonId?: string | null;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  comment: string;
  moveFrom?: string;
  moveTo?: string;
  /** Reason for moving the day into the past: asked exactly when the server will ask it. */
  reason?: string;
}

interface Props {
  /** null means the window is closed. */
  route: VehicleRouteDto | null;
  onClose: () => void;
  /** The route changed: route and request lists are stale after this. */
  onSaved: (route: VehicleRouteDto) => void;
}

export function VehicleRouteEditModal({ route, onClose, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const relocation = !!route && isRelocationPurpose(route.purpose);

  useEffect(() => {
    if (!route) return;
    form.setFieldsValue({
      reason: '',
      routeDate: dayjs(route.routeDate),
      driverPersonId: route.driverPersonId ?? undefined,
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      trailer2Model: route.trailer2Model,
      trailer2RegNumber: route.trailer2RegNumber,
      garageNumber: route.garageNumber,
      // An empty route field opens with the default: the field became mandatory, and a route
      // created before the list existed would otherwise block saving both a driver change and a day
      // move until someone picks the communication kind by hand. Defaulting here risks nothing: an
      // editable route has no waybill at all (isRouteEditable), so there is no paper with an empty
      // column to rewrite.
      communicationKind: route.communicationKind || DEFAULT_COMMUNICATION_KIND,
      transportationKind: route.transportationKind,
      comment: route.comment,
      moveFrom: route.moveFrom,
      moveTo: route.moveTo,
    });
    // The dependency is the route itself: a re-render after saving brings a new object with new
    // values, and the fields must follow them.
  }, [route, form]);

  const routeDate = Form.useWatch('routeDate', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const communicationKind = Form.useWatch('communicationKind', form);
  const on = (routeDate ?? (route ? dayjs(route.routeDate) : null))?.format(DATE);

  const today = moscowDateKeyOf(new Date());
  /** Lower calendar bound in three modes (R37); null means no bound (correctBeyondLimit). */
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  /**
   * Effective date of the move: the earlier of the two, by which the server checks the right. null
   * means the day is not moved and the edit has no backdating.
   */
  const movedKey = route ? movedRouteDateKey(route.routeDate, routeDate?.format(DATE)) : null;
  /** The move touches a past day: the reason is mandatory here and on the server. */
  const backdated = movedKey !== null && movedKey < today;
  /**
   * The date is locked entirely: the route's own day is already beyond the depth limit and will
   * stay the earlier of the two dates, so the server rejects any move (403 without the right, 422
   * beyond the limit). Other fields stay editable: a route without a waybill is a planning record
   * (ADR 0101 item 6).
   */
  const moveLocked = !!route && backdateFloor !== null && route.routeDate < backdateFloor;

  /**
   * Trailers pinned to the route's vehicle (docs/vehicle-trailers-plan.md, section 4.2.2). The
   * window takes the route's own fields from the route, while only the server knows the pinning, so
   * it is fetched by the same suggestion the create windows use. Routes and previous-route fields
   * of the answer are not needed: the edit describes a route that already exists.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(route?.vehicleId, on),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: route!.vehicleId, date: on! }),
    enabled: !!route && !!on,
  });

  const { driverOptions, driversLoading } = useRouteEditDrivers({
    vehicleId: route?.vehicleId,
    on,
    withTrailer,
  });

  /** An issued waybill freezes the route entirely: the portal and the server both reject edits. */
  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRoutesApi.update(route!.id, {
        version: route!.version,
        routeDate: v.routeDate.format(DATE),
        driverPersonId: v.driverPersonId ?? null,
        trip: {
          ...trailerTripBody(v),
          garageNumber: v.garageNumber ?? '',
          communicationKind: v.communicationKind ?? '',
          transportationKind: v.transportationKind ?? '',
        },
        comment: v.comment ?? '',
        ...(relocation ? { moveFrom: v.moveFrom, moveTo: v.moveTo } : {}),
        // The reason is sent only with a move into the past: a regular edit is not asked for it by
        // the server, and one sent "just in case" would mean backdating where there is none.
        ...(backdated ? { reason: v.reason } : {}),
      }),
    onSuccess: (updated) => {
      message.success('Маршрут изменён');
      qc.setQueryData(vehicleRouteKeys.detail(updated.id), updated);
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * A day move is confirmed separately: the delivery of its requests moves with the route, which is
   * no longer a plan entry but a change of when the customer expects the vehicle. Requests are
   * named one by one: "move the route" and "move four other people's orders" are different
   * decisions.
   */
  const submit = (v: FormValues) => {
    // The freeze is checked here too: the window opens from two places, and the waybill may have
    // been issued while it hung open. The server refuses by the same rule, but it is better said
    // before the request.
    if (frozen) {
      message.error(ROUTE_FROZEN_MESSAGE);
      return;
    }
    const moving = !!route && v.routeDate.format(DATE) !== route.routeDate;
    const affected = route?.requests ?? [];
    if (!moving || affected.length === 0) {
      save.mutate(v);
      return;
    }
    modal.confirm({
      title: `Перенести маршрут на ${v.routeDate.format('DD.MM.YYYY')}?`,
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Вместе с рейсом переедет подача заявок:{' '}
          {affected.map((item) => item.displayNumber).join(', ')}. Время подачи у каждой останется
          прежним.
        </Typography.Paragraph>
      ),
      okText: 'Перенести',
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync(v),
    });
  };

  return (
    <FormModal
      title={route ? `Маршрут ${route.displayNumber} · правка` : 'Маршрут'}
      open={!!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      okText="Сохранить"
      width={640}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit} disabled={frozen}>
        <FormGrid>
          {frozen && (
            <FormGrid.Full>
              <Typography.Text type="warning">{ROUTE_FROZEN_MESSAGE}</Typography.Text>
            </FormGrid.Full>
          )}

          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            extra={
              // A locked date is explained by the reason the server would refuse with: without the
              // right, "no right"; with the right but beyond the limit, "ask an administrator"
              // (R37).
              moveLocked
                ? can('waybills.correct')
                  ? `Рейс старше ${WAYBILL_CORRECTION_DAYS} дней — его дату переносит администратор`
                  : 'Дату прошедшего рейса двигает тот, у кого есть право коррекции задним числом'
                : route && route.requests.length > 0
                  ? `Вместе с рейсом переедет подача ${route.requests.length} заявок`
                  : undefined
            }
          >
            <DatePicker
              format="DD.MM.YYYY"
              style={{ width: '100%' }}
              inputReadOnly={isMobile}
              disabled={moveLocked}
              // One rule with the server (backdateGuard): the portal neither offers what the
              // endpoint rejects nor locks what it accepts.
              disabledDate={(d) => backdateFloor !== null && d.format(DATE) < backdateFloor}
            />
          </Form.Item>

          {/* The reason appears together with a past day, next to where the date is chosen. The
              field is shared with other backdating doors that have no price to list: a move
              burns no form numbers (an active waybill would block it anyway); its only
              consequence is the moved delivery of requests, which the move confirmation names.
              The explanation goes into the edit audit: a move has no correction-log row of its
              own. */}
          {backdated && (
            <FormGrid.Full>
              <BackdateReasonField
                effectiveDate={movedKey}
                consequence="перенос уйдёт в аудит с вашим именем и этой причиной"
                placeholder="Например: рейс состоялся во вторник, в портал внесли средой"
              />
            </FormGrid.Full>
          )}

          <Form.Item
            name="driverPersonId"
            label="Водитель"
            extra="Без водителя лист не выписать; поставить его можно и позже"
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              allowClear
              optionFilterProp="label"
              loading={driversLoading}
              placeholder="Выберите водителя"
            />
          </Form.Item>

          {/* The relocation task: a freight route gets it from its composition, and the server
              rejects these fields for it. */}
          {relocation && (
            <>
              <Form.Item
                name="moveFrom"
                label="Откуда"
                rules={[{ required: true, message: 'Укажите, откуда идёт техника' }]}
              >
                <Input placeholder="База, ул. Автомобильная, 3" />
              </Form.Item>
              <Form.Item
                name="moveTo"
                label="Куда"
                rules={[{ required: true, message: 'Укажите, куда идёт техника' }]}
              >
                <Input placeholder="Объект, адрес площадки" />
              </Form.Item>
              <FormGrid.Full>
                <Typography.Text type="secondary">
                  {routePurposeLabels[route!.purpose]}
                  {route?.sourceRequest ? ` · по заявке ${route.sourceRequest.displayNumber}` : ''}
                </Typography.Text>
              </FormGrid.Full>
            </>
          )}

          {/* Departure details are the same route after route and change once a season, but
              they are edited here rather than by rebuilding the route. Form No. 3 has no
              trailer fields at all (ADR 0071), so the trailer is asked only where it is
              printed. */}
          {route?.formCode !== 'leg3' && (
            <TrailerFields
              key={route?.id}
              withTrailer={withTrailer}
              checkboxLabel="Рейс с прицепом"
              checkboxFullWidth
              modelPlaceholder="СЗАП-8551"
              regNumberPlaceholder="АВ1234 77"
              secondPlaceholder="Если прицепов два"
              hitched={suggestion?.hitched}
              vehicleId={route?.vehicleId}
              vehicleTypeId={route?.vehicleTypeId}
              // Pinning does not override the route's own fields: the route already described its
              // trailer, and rewriting it would replace the record opened for editing. Empty fields
              // with the checkbox set are filled: the route said "with trailer" but not which one
              // (R20).
              keepOwnGraphs
              // Form readiness barrier (R21): the route fields the block compares the form with.
              record={route}
            />
          )}

          <Form.Item name="garageNumber" label="Гаражный номер">
            <Input placeholder="Из справочника техники, если пусто" />
          </Form.Item>
          {/* A list, not free text: the value is printed in a column of the 4-P and form No. 3,
              and three spellings of one word make the waybill journal impossible to reconcile.
              No clear button and no "not chosen" item: the field was requested as mandatory at
              UI level, and the window cannot empty it. An old route's value outside the set
              stays in the list as its own item (communicationKindOptions): editing a route's
              day must not wipe someone else's column. */}
          <Form.Item
            name="communicationKind"
            label="Вид сообщения"
            rules={[{ required: true, message: 'Выберите вид сообщения' }]}
          >
            <Select options={communicationKindOptions(communicationKind)} />
          </Form.Item>
          <Form.Item name="transportationKind" label="Вид перевозки">
            <Input placeholder="коммерческая" />
          </Form.Item>

          <FormGrid.Full>
            <Form.Item name="comment" label="Комментарий к рейсу">
              <Input.TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
