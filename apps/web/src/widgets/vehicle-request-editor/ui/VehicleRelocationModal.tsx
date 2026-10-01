import { useEffect } from 'react';
import { App, DatePicker, Form, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  RELOCATION_COMMUNICATION_KIND,
  routePurposeLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { garageKeys } from '@entities/garage';
import { useObjectScope } from '@entities/session';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { AddressField } from '@features/address-input';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { BackdateReasonField } from './VehicleBackdateFields';

/**
 * Equipment relocation for a request: delivery to or pickup from the site (migration 0082).
 *
 * A self-driven city trip can receive a 4-P waybill. It remains optional because equipment may
 * arrive on a carrier, and the portal does not model transport method.
 *
 * Delivery is also offered during confirmation, while pickup is planned only when the work end is
 * known (ADR 0044). Waybill issuance stays in the route card so all routes use one document flow.
 */

interface Props {
  /** `null` closes the dialog; an open request must be confirmed and assigned. */
  request: VehicleRequestDto | null;
  /** Relocation purpose: delivery to or pickup from the site. */
  purpose: 'delivery' | 'pickup';
  onClose: () => void;
  onDone: (route: VehicleRouteDto) => void;
}

interface FormValues {
  routeDate?: Dayjs | null;
  driverPersonId?: string;
  moveFrom?: string;
  moveTo?: string;
  /** Backdate reason, required only for a past relocation date (ADR 0101). */
  reason?: string;
}

export function VehicleRelocationModal({ request, purpose, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<FormValues>();

  const objectPlace =
    request?.requestType === 'special_equipment'
      ? request.objectAddress || request.objectName || ''
      : '';

  /** Suggest the request site and account-scoped sites first (ADR 0069). */
  const { ownObjectIds } = useObjectScope();
  const suggestObjectIds = [request?.objectId, ...ownObjectIds].filter((id): id is string => !!id);

  /*
   * Pre-fill the request site as destination for delivery and origin for pickup. The opposite end
   * remains editable because equipment does not always return to the base.
   *
   * Do not infer the route date from the work term: delivery may happen earlier and pickup later,
   * and a guessed boundary would silently become the waybill departure date.
   */
  useEffect(() => {
    if (!request) return;
    form.setFieldsValue({
      routeDate: null,
      driverPersonId: undefined,
      moveFrom: purpose === 'pickup' ? objectPlace : '',
      moveTo: purpose === 'delivery' ? objectPlace : '',
      reason: undefined,
    });
  }, [request, purpose, objectPlace, form]);

  const routeDate = Form.useWatch('routeDate', form);
  const vehicleId = request?.assignment?.vehicleId;
  const on = routeDate?.format('YYYY-MM-DD');

  /*
   * Past relocation dates are legitimate operationally, but ADR 0101 requires both permission and
   * an explanation, matching route-side creation.
   */
  const past = !!on && on < moscowDateKeyOf(new Date());

  // Match waybill issuance: driver documents must be valid on the relocation date, not work start.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on, withTrailer: false }),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: on! }),
    enabled: !!request && !!vehicleId && !!on,
  });
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [d.fullName, d.categories.join(', '), d.personnelNo && `таб. ${d.personnelNo}`]
      .filter(Boolean)
      .join(' · '),
  }));

  const create = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRequestsApi.createRelocation(request!.id, {
        purpose,
        routeDate: v.routeDate!.format('YYYY-MM-DD'),
        driverPersonId: v.driverPersonId,
        moveFrom: v.moveFrom!.trim(),
        moveTo: v.moveTo!.trim(),
        // Use the shared constant because communication kind is printed on the form but is not a
        // user choice for city relocations.
        trip: { communicationKind: RELOCATION_COMMUNICATION_KIND },
        // Send a reason only for past dates, matching the server guard and visible form fields.
        ...(past ? { reason: v.reason } : {}),
      }),
    onSuccess: async (route) => {
      message.success(`${routePurposeLabels[purpose]}: маршрут ${route.displayNumber}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: vehicleRouteKeys.root }),
        qc.invalidateQueries({ queryKey: vehicleRequestKeys.root }),
        qc.invalidateQueries({ queryKey: garageKeys.root }),
      ]);
      onDone(route);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={request ? `${routePurposeLabels[purpose]} · ${request.displayNumber}` : 'Перегон'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={create.isPending}
      okText="Завести перегон"
      width={640}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
        <FormGrid>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary">
              Перегон станет отдельным рейсом на выбранную дату; путевой лист 4-П выписывают в
              карточке маршрута, когда водитель известен окончательно.
            </Typography.Paragraph>
          </FormGrid.Full>

          <Form.Item
            name="routeDate"
            label="Дата перегона"
            rules={[{ required: true, message: 'Укажите дату перегона' }]}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>

          {/* Driver assignment is optional while planning, but waybill issuance will require it.
              Never auto-select the sole candidate because dispatch must make that decision. */}
          <Form.Item
            name="driverPersonId"
            label="Водитель"
            extra={
              !routeDate
                ? 'Сначала укажите дату: годность удостоверения считается на день перегона'
                : driverOptions.length === 0 && !driversLoading
                  ? 'Нет водителей с полным комплектом документов на эту дату'
                  : 'Можно назначить позже, в карточке маршрута'
            }
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              optionFilterProp="label"
              loading={driversLoading}
              allowClear
              disabled={!routeDate}
              placeholder={routeDate ? 'Выберите водителя' : 'Сначала укажите дату перегона'}
            />
          </Form.Item>

          {/* Relocation places use suggestions or known sites (ADR 0069), without strict
              verification because bases, parking lots, and repair bays may not have postal addresses. */}
          <AddressField
            name="moveFrom"
            label="Откуда"
            required
            requiredMessage="Укажите, откуда идёт техника"
            directory
            suggestObjectIds={suggestObjectIds}
            placeholder="База, ул. Автомобильная, 3"
          />
          <AddressField
            name="moveTo"
            label="Куда"
            required
            requiredMessage="Укажите, куда идёт техника"
            directory
            suggestObjectIds={suggestObjectIds}
            placeholder="Объект, адрес площадки"
          />

          {/* A past date requires permission and a reason (ADR 0101). Route creation records the
              explanation in its audit trail; later waybill issuance guards its own backdating. */}
          {past && (
            <FormGrid.Full>
              <BackdateReasonField
                effectiveDate={on!}
                consequence="перегон заведётся задним числом — с вашим именем и этой причиной в журнале событий"
                placeholder="Например: технику увезли в пятницу, в портал вносим в понедельник"
              />
            </FormGrid.Full>
          )}
        </FormGrid>
      </Form>
    </FormModal>
  );
}
