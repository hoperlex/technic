import { useEffect } from 'react';
import { App, Form, Input, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import {
  ARRIVAL_TIME_MESSAGE,
  type AddressMeta,
  normalizeTimeInput,
  TIME_PATTERN,
  type VehicleRoutePointDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { AddressField } from '@features/address-input';
import { FormGrid, FormModal } from '@shared/ui';
import { vehicleRoutesApi } from '@entities/vehicle-route';
import { TimeInput } from '@entities/request';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { pointRoleInputOf } from '@entities/vehicle-route';

/**
 * Stop editing: address, planned arrival and a note for the driver (section 4.3 of
 * `docs/route-trips-plan.md`).
 *
 * The role set is not edited here, even though the endpoint accepts it in full. Roles move between
 * points through their own actions — «совместить» (merge) and «разнести» (split) (R9a) — and those
 * actions answer the question people actually ask: "is this one visit or two". A "what we do here"
 * checkbox list next to the address would let someone remove a point's last role, i.e. delete the
 * stop through an address edit — and a point without a task is neither created nor kept (R13).
 * So roles go back to the server exactly as they came: an address edit is just an address edit.
 *
 * The address must be verified (ADR 0006, R11b): it is what gets printed on the form and where the
 * vehicle will actually go. A legacy string the point inherited from the backfill stays readable —
 * the strict model applies to writes, not reads — but it cannot be saved back, deliberately.
 */

interface PointValues {
  location?: string;
  address?: AddressMeta | null;
  arrivalTime?: string;
  comment?: string;
}

interface Props {
  /** `null` — window closed; the whole route is needed: point edits use the route version (R16). */
  route: VehicleRouteDto | null;
  point: VehicleRoutePointDto | null;
  onClose: () => void;
  onSaved: (route: VehicleRouteDto) => void;
}

/**
 * Stop time is optional (`arrivalTimeSchema`), but when filled in it must be a valid time.
 *
 * A rule of its own rather than `optionalWorkTimeRule`: that one also locks the time into the
 * working-hours window, while a route stop can come before it starts — the vehicle leaves the
 * garage before dawn, and a night loading at the quarry is not an input error. The server does not
 * check the working window for a point either, and forbidding here what it accepts would lie to
 * the person about the rules.
 */
const arrivalTimeRule = {
  validator(_rule: unknown, value: string | undefined) {
    const raw = (value ?? '').trim();
    if (raw === '') return Promise.resolve();
    const normalized = TIME_PATTERN.test(raw) ? raw : normalizeTimeInput(raw);
    return normalized ? Promise.resolve() : Promise.reject(new Error(ARRIVAL_TIME_MESSAGE));
  },
};

export function RoutePointEditModal({ route, point, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PointValues>();

  // The form outlives a single point: the window is opened from different list rows in a row, and
  // `FormModal` does not reset its markup between openings. So the fields are reloaded from the
  // point itself — otherwise the second stop would show the first stop's address.
  useEffect(() => {
    if (!point) return;
    form.setFieldsValue({
      location: point.location,
      address: point.address,
      arrivalTime: point.arrivalTime,
      comment: point.comment,
    });
  }, [point, form]);

  const save = useMutation({
    mutationFn: (v: PointValues) => {
      /*
       * Roles are taken from the point's **current** state, not from the snapshot the window was
       * opened with: the card re-reads the route by itself (a request edit bumps its version, R18),
       * and while the form was being filled in, the point's roles may have changed. Sending the
       * snapshot would make "fixed the time" silently undo someone else's merge, because the role
       * set is sent in full.
       */
      const current = (route!.points ?? []).find((p) => p.id === point!.id) ?? point!;
      return vehicleRoutesApi.points.update(route!.id, point!.id, {
        location: (v.location ?? '').trim(),
        address: v.address!,
        arrivalTime: v.arrivalTime ?? '',
        comment: (v.comment ?? '').trim(),
        // Roles are sent unchanged: an address edit has no say over what happens at the point.
        roles: current.actions.map(pointRoleInputOf),
        version: route!.version,
      });
    },
    onSuccess: (updated) => {
      message.success('Точка сохранена');
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={point ? `Точка ${point.position}` : 'Точка маршрута'}
      open={!!point && !!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      okText="Сохранить"
      width={560}
    >
      <Form<PointValues> form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <FormGrid>
          <FormGrid.Full>
            {/* The point's address is a snapshot, not a reference to a trip (R10): trips of
              different requests meet at a stop, so "the trip's address" is ambiguous there. An
              edit here does not touch the request — and vice versa: a request whose address was
              edited after assembly marks its role with a mismatch. */}
            <AddressField
              name="location"
              label="Адрес остановки"
              required
              requiredMessage="Укажите адрес точки"
              verified
              metaField="address"
              directory
              placeholder="Карьер Сычёво, Волоколамское шоссе"
            />
          </FormGrid.Full>
          <Form.Item
            name="arrivalTime"
            label="План прибытия"
            rules={[arrivalTimeRule]}
            extra="Необязательно: час остановки знают не всегда"
          >
            <TimeInput />
          </Form.Item>
          <FormGrid.Full>
            {/* A note about this stop, not about the request: «звонить с ворот» (call from the
              gate), «пропуск у весовщика» (pass is with the weigher). It does not go on the form —
              there is no column for it — but it reaches the driver as part of the task: by email
              and in the `/driver` cabinet (plan section 8). */}
            <Form.Item name="comment" label="Записка водителю">
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Звонить с ворот, пропуск у весовщика"
              />
            </Form.Item>
          </FormGrid.Full>
          <FormGrid.Full>
            <Typography.Text type="secondary">
              Что делается на этой остановке, правят действия «совместить» и «разнести»: адрес и
              время — про заезд, а не про задание.
            </Typography.Text>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
