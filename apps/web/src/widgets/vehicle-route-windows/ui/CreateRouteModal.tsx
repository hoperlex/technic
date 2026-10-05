import { App, DatePicker, Form, Input } from 'antd';
import type dayjs from 'dayjs';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  minRequestDateKey,
  moscowDateKeyOf,
  type VehicleRouteDto,
  vehicleLabel,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { useAuth } from '@entities/session';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import {
  trailerTripBody,
  vehicleRouteErrorMessage as errorMessage,
  vehicleRouteKeys,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import { TrailerFields } from '@features/vehicle-route-trailer';
import { useIsMobile } from '@shared/lib';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface CreateValues {
  vehicleId?: string;
  routeDate?: dayjs.Dayjs;
  driverPersonId?: string;
  /*
   * Trailer fields: before stage E4 the window did not ask about a trailer at all and silently
   * created the route without one (docs/vehicle-trailers-plan.md, section 4.2.2); it was added
   * later in the route card.
   */
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  /** Reason for creating on a past day (ADR 0101, gap 1): asked only for an elapsed day. */
  reason?: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** The whole created route: the list moves its period to that day and opens the card. */
  onCreated: (route: VehicleRouteDto) => void;
}

/**
 * New route: vehicle, date, trailer and, if already known, the driver. Other departure details are
 * not here; they are edited in the route card.
 *
 * The trailer is asked since stage E4 (docs/vehicle-trailers-plan.md, section 4.2.2). Before that the
 * window did not ask at all and requested drivers with a hard-coded withTrailer: false, i.e. measured
 * their licence category against a trailer-less route whatever the route turned out to be. For a
 * vehicle with a pinned semi-trailer the fields and the checkbox fill themselves and name their
 * source; for a vehicle without one the fields stay empty and the portal stays as silent as before:
 * there is no trailer history here and there will be none (ADR 0083).
 *
 * A past day (ADR 0101 item 4, plan gap 1) used to be created here silently: no right, no reason, no
 * trace. Now the calendar is locked by the same rule as request forms, three modes
 * (minRequestDateKey, R37): without the correction right the past is closed, with waybills.correct
 * thirty days are open, with waybills.correctBeyondLimit there is no limit. The reason is asked
 * exactly when the chosen day has passed, the same condition the server uses to require it.
 */
export function CreateRouteModal({ open, onCancel, onCreated }: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const [form] = Form.useForm<CreateValues>();
  const vehicleId = Form.useWatch('vehicleId', form);
  const routeDate = Form.useWatch('routeDate', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const on = routeDate?.format(DATE);
  const today = moscowDateKeyOf(new Date());
  // Lower calendar bound; null means no bound at all (waybills.correctBeyondLimit).
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  // A past day is chosen: the reason is mandatory here and on the server alike.
  const backdated = !!routeDate && routeDate.format(DATE) < today;

  // Routes run only on own vehicles: for a rented one the lessor issues the waybill.
  const { data: vehicles, isFetching } = useQuery({
    queryKey: vehicleKeys.forRoutes(),
    queryFn: () => vehiclesApi.list({ ownership: 'own', status: 'active', page: 1, pageSize: 500 }),
    enabled: open,
  });
  // The chosen unit: its form decides whether the trailer is asked, its type whether the checkbox
  // sets itself.
  const selectedVehicle =
    (vehicles?.items ?? []).find((vehicle) => vehicle.id === vehicleId) ?? null;

  /*
   * Trailers pinned to the vehicle. The window needs only this field of the answer: it does not
   * offer routes (a new one is created), and it does not inherit, and must not start inheriting,
   * header fields from a previous route; the only new default is a pinned trailer (section 4.2.2,
   * point 2). The date in the query is the endpoint's own requirement: pinning does not depend on the
   * day, but the suggestion key is shared portal-wide.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, on),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: on! }),
    enabled: open && !!vehicleId && !!on,
  });

  /*
   * The driver choice is the whole directory (ADR 0064): category and document completeness remove
   * nobody, they annotate the row. What that means for the form is said by the route card, where the
   * waybill is issued.
   *
   * The trailer in the query is not "false just in case" as before E4: with it the vehicle's
   * requirement grows from C to CE, and a hard-coded false would show as fit someone who must not be
   * trusted with a combination (ADR 0055, ADR 0064).
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on, withTrailer }),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: on!, withTrailer }),
    enabled: open && !!vehicleId && !!on,
  });

  const create = useMutation({
    mutationFn: (values: CreateValues) =>
      vehicleRoutesApi.create({
        vehicleId: values.vehicleId!,
        routeDate: values.routeDate!.format(DATE),
        driverPersonId: values.driverPersonId ?? null,
        // Other header fields go empty, as they did without the trip body: they are edited in the card.
        trip: {
          ...trailerTripBody(values),
          garageNumber: '',
          communicationKind: '',
          transportationKind: '',
        },
        // The reason goes only with a past day: the server does not ask it for today's route, and
        // one sent "just in case" would mean a correction where there is none.
        ...(values.routeDate!.format(DATE) < today ? { reason: values.reason } : {}),
      }),
    onSuccess: (route) => {
      form.resetFields();
      onCreated(route);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <FormModal
      title="Новый маршрут"
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={create.isPending}
      okText="Завести"
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}>
        <FormGrid>
          <Form.Item
            name="vehicleId"
            label="Техника"
            rules={[{ required: true, message: 'Выберите технику' }]}
          >
            <AutoSelect
              options={(vehicles?.items ?? []).map((vehicle) => ({
                value: vehicle.id,
                label: vehicleLabel(vehicle),
              }))}
              showSearch
              optionFilterProp="label"
              loading={isFetching}
              placeholder="Выберите машину"
            />
          </Form.Item>
          {/* The date starts empty: routes are created for tomorrow and later, and a prefilled "today"
              gets accepted without looking, putting the route on the wrong day. */}
          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            extra={
              backdateFloor === null || backdateFloor < today
                ? 'Прошедший день заводится с причиной: рейс уйдёт в журнал коррекций'
                : undefined
            }
          >
            <DatePicker
              format="DD.MM.YYYY"
              style={{ width: '100%' }}
              inputReadOnly={isMobile}
              // One rule with the server (backdateGuard): the portal neither offers what the endpoint
              // rejects nor locks what it accepts.
              disabledDate={(date) => backdateFloor !== null && date.format(DATE) < backdateFloor}
            />
          </Form.Item>
          {/* The reason appears together with a past day, next to the date: it goes into the audit
              record and explains months later why the route carries yesterday's date. */}
          {backdated && (
            <FormGrid.Full>
              <Form.Item
                name="reason"
                label="Причина заднего числа"
                rules={[{ required: true, message: 'Укажите причину' }]}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Например: рейс состоялся во вторник, в портал вносим сегодня"
                />
              </Form.Item>
            </FormGrid.Full>
          )}
          {/* Form No. 3 has no trailer fields at all (ADR 0071). The block precedes the driver on
              purpose: the checkbox changes the required category, and the list below is rebuilt. */}
          <TrailerFields
            withTrailer={withTrailer}
            checkboxLabel="Рейс с прицепом"
            checkboxFullWidth
            modelPlaceholder="СЗАП-8551"
            regNumberPlaceholder="АВ1234 77"
            secondPlaceholder="Если прицепов два"
            hitched={suggestion?.hitched}
            vehicleId={vehicleId}
            vehicleTypeId={selectedVehicle?.vehicleTypeId}
            // Visibility goes through the asks prop instead of unmounting: an unmounted block removed
            // the question but kept its answer in the form values (section 14, R20).
            asks={selectedVehicle?.waybillFormCode !== 'leg3'}
          />
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Водитель"
              extra="Необязательно: рейс собирают заранее, а человека ставят утром. Без водителя лист не выписать."
            >
              {/* The server set the order: fit drivers first by documents, then by category
                  (ADR 0064, ADR 0055), within them those who worked on this vehicle (ADR 0056). The
                  row marks explain why, but the person chooses: a driver never fills the field by
                  itself, even when only one is fit. */}
              <AutoSelect
                autoSelectSole={false}
                options={(selection?.drivers ?? []).map((driver) => ({
                  value: driver.personId,
                  label: [
                    driver.fullName,
                    driver.categories.join(', '),
                    driverDocumentGapsHint(driver.gaps, driver.credentialTypeCode),
                    driver.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
                    driverWorkedOnVehicle(driver) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                showSearch
                allowClear
                optionFilterProp="label"
                loading={driversLoading}
                disabled={!vehicleId || !routeDate}
                placeholder={vehicleId ? 'Выберите водителя' : 'Сначала выберите машину'}
              />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
