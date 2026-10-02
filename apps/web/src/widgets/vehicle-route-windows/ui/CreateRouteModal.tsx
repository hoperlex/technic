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
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  reason?: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  onCreated: (route: VehicleRouteDto) => void;
}

/** Create a route while the list owns the resulting focus and record transition. */
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
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  const backdated = !!routeDate && routeDate.format(DATE) < today;

  const { data: vehicles, isFetching } = useQuery({
    queryKey: vehicleKeys.forRoutes(),
    queryFn: () => vehiclesApi.list({ ownership: 'own', status: 'active', page: 1, pageSize: 500 }),
    enabled: open,
  });
  const selectedVehicle =
    (vehicles?.items ?? []).find((vehicle) => vehicle.id === vehicleId) ?? null;

  // A pinned trailer is the only default here; header values from an earlier route stay explicit.
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, on),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: on! }),
    enabled: open && !!vehicleId && !!on,
  });

  // Driver gaps annotate the full directory rather than removing a person from the choice.
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
        trip: {
          ...trailerTripBody(values),
          garageNumber: '',
          communicationKind: '',
          transportationKind: '',
        },
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
              disabledDate={(date) => backdateFloor !== null && date.format(DATE) < backdateFloor}
            />
          </Form.Item>
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
            asks={selectedVehicle?.waybillFormCode !== 'leg3'}
          />
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Водитель"
              extra="Необязательно: рейс собирают заранее, а человека ставят утром. Без водителя лист не выписать."
            >
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
