import { useEffect, useState } from 'react';
import { Alert, App, Form, Input, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  communicationKindOptions,
  isRelocationPurpose,
  type VehicleRouteDto,
} from '@technic/contracts';
import { sameTrailerGraphs, vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { waybillKeys, waybillsApi } from '@entities/waybill';
import { garageKeys } from '@entities/garage';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { RouteCorrectionConsequences } from './RouteCorrectionConsequences';
import { useRouteCorrectionChoices } from '../model/routeCorrectionChoices';
import { trailerTripBody } from '@entities/vehicle-route';
import { TrailerFields } from '@features/vehicle-route-trailer';

/**
 * Backdated correction of how a route was actually executed (ADR 0101, R2).
 *
 * The edit window and the correction window are separate windows, and not for convenience: the
 * actions cost different things. An edit changes the plan: the route is not a document yet, and
 * the edit costs nothing. A correction rewrites **a day that has already happened**: the current
 * blank number is burned and the next one in the series is issued instead (R10), request
 * assignments follow the route's vehicle, the site's sign-offs under the days are removed (R5), and
 * files attached to the old sheet do not move to the new one (R34). That is why a reason is
 * mandatory here, and why the person reads all of the above **before** pressing the button rather
 * than finding out afterwards (R18, R36).
 *
 * The consequences are computed by the server with the same code that will execute them
 * (`GET /vehicle-routes/:id/correction`): a second calculation in the portal would drift from the
 * first, and the window would promise something other than what actually happens.
 */

interface FormValues {
  vehicleId: string;
  driverPersonId: string;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  reason: string;
}

interface Props {
  /** null means the window is closed. */
  route: VehicleRouteDto | null;
  onClose: () => void;
  /**
   * The route was rewritten: route lists, request lists and the sheet journal are no longer the
   * same after this.
   *
   * Comes with route points: a correction rebuilds the whole route, and the card puts the response
   * into the cache as is; without the stop order it would show an empty stop list until the next
   * refetch.
   */
  onSaved: (route: VehicleRouteDto) => void;
}

export function VehicleRouteCorrectionModal({ route, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  /**
   * Idempotency key (R31): generated **before** submission and kept for as long as the window is
   * open. A retry after a network timeout must return the result of the earlier operation instead
   * of burning a second number in the series; for the same reason the retry sends the same body:
   * the fingerprint is computed over the whole command, and the server will not recognise a body
   * rebuilt with a fresh version as a retry.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!route) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({
      vehicleId: route.vehicleId,
      driverPersonId: route.driverPersonId ?? undefined,
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      trailer2Model: route.trailer2Model,
      trailer2RegNumber: route.trailer2RegNumber,
      garageNumber: route.garageNumber,
      // Unlike the edit window, an empty field is not filled with a default here: a substituted
      // value would by itself make the form differ from the route, and the "a correction must
      // change something" check (R31) would let through a press in which the person changed
      // nothing, burning a blank number for a word the portal added. The field is required, and
      // the communication kind of an old route is picked by hand: a deliberate decision, not a
      // substitution.
      communicationKind: route.communicationKind,
      transportationKind: route.transportationKind,
      reason: '',
    });
    // The only dependency is the route id: if the effect tracked the whole `route`, the operation
    // key and the form draft would reset under the user's hand on every card refresh, while the
    // key must stay unchanged for as long as the window is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, form]);

  const vehicleId = Form.useWatch('vehicleId', form) ?? route?.vehicleId;
  const driverPersonId = Form.useWatch('driverPersonId', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const communicationKind = Form.useWatch('communicationKind', form);

  /** Consequences and blockers come from the server, by the same rules it will execute them. */
  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: vehicleRouteKeys.correctionPreview(route?.id),
    queryFn: () => vehicleRoutesApi.correctionPreview(route!.id),
    enabled: !!route,
  });

  /**
   * Card of the current sheet: print and export marks (R18) and files attached to the number
   * (R34). Taken from the journal rather than recomputed: "has the paper left the building" is the
   * journal's question, and two different answers to it are worse than one.
   */
  const { data: sheet } = useQuery({
    queryKey: waybillKeys.detail(preview?.waybill?.id),
    queryFn: () => waybillsApi.get(preview!.waybill!.id),
    enabled: !!preview?.waybill,
  });

  /** Choice lists live in a separate module: their selection is historical, see its header. */
  const { vehicleOptions, fleetLoading, driverOptions, driversLoading, suggestion, vehicleTypeId } =
    useRouteCorrectionChoices({ route, vehicleId, withTrailer });

  const correct = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRoutesApi.correct(route!.id, {
        operationId,
        version: route!.version,
        vehicleId: v.vehicleId,
        driverPersonId: v.driverPersonId,
        trip: {
          ...trailerTripBody(v),
          garageNumber: v.garageNumber ?? '',
          communicationKind: v.communicationKind ?? '',
          transportationKind: v.transportationKind ?? '',
        },
        reason: v.reason,
      }),
    onSuccess: async (updated) => {
      message.success(`Рейс исправлен, выписан лист ${updated.waybill?.number ?? ''}`);
      qc.setQueryData(vehicleRouteKeys.detail(updated.id), updated);
      // After a correction the sheet journal and the garage show something else: a cancelled
      // number, a new number and a different vehicle for the day.
      await qc.invalidateQueries({ queryKey: waybillKeys.root });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Whether the form changes anything (R31): a body repeating the route would waste a number. */
  const changed =
    !!route &&
    (vehicleId !== route.vehicleId ||
      (driverPersonId ?? null) !== route.driverPersonId ||
      !sameTrailerGraphs(trailerTripBody(form.getFieldsValue()), route) ||
      (form.getFieldValue('garageNumber') ?? '') !== route.garageNumber ||
      (form.getFieldValue('communicationKind') ?? '') !== route.communicationKind ||
      (form.getFieldValue('transportationKind') ?? '') !== route.transportationKind);

  const submit = (v: FormValues) => {
    if (preview?.blocking) {
      message.error(preview.blocking.reason);
      return;
    }
    if (!changed) {
      message.error('Коррекция должна что-то менять: иначе номер бланка сгорит впустую');
      return;
    }
    correct.mutate(v);
  };

  return (
    <FormModal
      title={route ? `Маршрут ${route.displayNumber} · исправить исполнение` : 'Коррекция рейса'}
      open={!!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={correct.isPending}
      okText="Исправить и выписать лист"
      okDanger
      width={720}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit}>
        <FormGrid>
          {/* The composition blocker (R3, R13) is read first: with a closed or new request in the
            route a correction is impossible, and someone else has to fix that; the window names
            who exactly. */}
          {preview?.blocking && (
            <FormGrid.Full>
              <Alert
                type="error"
                showIcon
                title="Рейс сейчас не исправить"
                description={
                  <>
                    {preview.blocking.reason}
                    {preview.blocking.requests.length > 0 && (
                      <div>Заявки: {preview.blocking.requests.join(', ')}</div>
                    )}
                  </>
                }
              />
            </FormGrid.Full>
          )}

          <FormGrid.Full>
            <RouteCorrectionConsequences
              route={route}
              preview={preview}
              sheet={sheet}
              vehicleId={vehicleId}
            />
          </FormGrid.Full>

          {/* The vehicle is edited only here (ADR 0082 item 5 as amended by ADR 0101): "will go by
            another vehicle" in the future is a different assignment, while in a past day only one
            route actually took place. */}
          <Form.Item
            name="vehicleId"
            label="Машина рейса"
            rules={[{ required: true, message: 'Выберите машину' }]}
            extra="Списанная и стоящая в ремонте техника в списке есть: она могла работать в тот день"
          >
            <AutoSelect
              autoSelectSole={false}
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={fleetLoading}
              placeholder="Чем ехали на самом деле"
            />
          </Form.Item>

          <Form.Item
            name="driverPersonId"
            label="Водитель"
            rules={[{ required: true, message: 'Выберите водителя' }]}
            extra="Список — на день рейса: уволившийся после него из выбора не пропадает"
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              optionFilterProp="label"
              loading={driversLoading}
              placeholder="Кто вёл на самом деле"
            />
          </Form.Item>

          {/* Form No. 3 has no trailer fields at all (ADR 0071): the trailer is asked only where
            it is printed. */}
          {/* The second pair of fields matters here more than anywhere: a correction rewrites
            what has already gone out on paper, and until now a route with two trailers could
            only be described by forgetting half of it. */}
          {route?.formCode !== 'leg3' && (
            <TrailerFields
              key={route?.id}
              withTrailer={withTrailer}
              checkboxLabel="Рейс был с прицепом"
              checkboxFullWidth
              modelPlaceholder="СЗАП-8551"
              regNumberPlaceholder="АВ1234 77"
              secondPlaceholder="Если прицепов было два"
              hitched={suggestion?.hitched}
              vehicleId={vehicleId}
              vehicleTypeId={vehicleTypeId}
              // The day already happened: the trailer binding knows the current vehicle, not last
              // Tuesday.
              substituteOnOpen={false}
            />
          )}

          <Form.Item name="garageNumber" label="Гаражный номер">
            <Input placeholder="Из справочника техники, если пусто" />
          </Form.Item>
          {/* A list rather than free text: the value goes into a field of the new blank, and its
            spelling must be the same on every sheet. There is no clear button and no "not
            selected" option, so the window cannot empty the field. A value inherited from an old
            route that is outside the set is shown as selected and stays an option of the list
            (`communicationKindOptions`): it is already printed on the issued sheet, and a vehicle
            correction must not silently rewrite a field it did not touch. */}
          <Form.Item
            name="communicationKind"
            label="Вид сообщения"
            rules={[{ required: true, message: 'Выберите вид сообщения' }]}
          >
            <Select
              options={communicationKindOptions(communicationKind)}
              placeholder="Выберите вид сообщения"
            />
          </Form.Item>
          <Form.Item name="transportationKind" label="Вид перевозки">
            <Input placeholder="коммерческая" />
          </Form.Item>

          {/* The reason is mandatory: it goes into the operation record, into the cancellation
            reason of the old sheet and into the new sheet (R16, R35), and two months later it
            answers why the journal has two numbers for one day. */}
          <FormGrid.Full>
            <Form.Item
              name="reason"
              label="Причина коррекции"
              rules={[{ required: true, message: 'Укажите причину' }]}
              extra="Останется в журнале, в аннулированном листе и в новом"
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                placeholder="На рейс выехала другая машина: ТС-341 в ремонте"
              />
            </Form.Item>
          </FormGrid.Full>

          {route && isRelocationPurpose(route.purpose) && (
            <FormGrid.Full>
              <Typography.Text type="secondary">
                Это перегон техники: состава у него нет, и назначение заявки коррекция не трогает —
                машину заказа правят в его карточке.
              </Typography.Text>
            </FormGrid.Full>
          )}
          {previewLoading && (
            <FormGrid.Full>
              <Typography.Text type="secondary">Считаем последствия…</Typography.Text>
            </FormGrid.Full>
          )}
        </FormGrid>
      </Form>
    </FormModal>
  );
}
