import { useEffect, useState } from 'react';
import { App, Checkbox, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import {
  type RoutePointAction,
  taskRefKey,
  type VehicleRoutePointDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { vehicleRoutesApi } from '@entities/vehicle-route';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { actionLabel, pointRoleInputOf } from '@entities/vehicle-route';

/**
 * Split a stop in two (R9a): the checked roles move to a new point right after the original one.
 *
 * The reverse action, «совместить» (merge), lives in the list itself and needs no window — there is
 * nothing to choose: same-address points are known and are all combined at once. Here there is a
 * choice, and it is the only thing the window asks: "these are loaded at building one, those at
 * building three" — that is the person's decision, and there is nothing to guess it from.
 *
 * The new point takes the original's address: what is split is the work, not the place. Its
 * arrival time and comment are its own and empty — they describe a visit, and now there are two.
 */

interface Props {
  /** `null` — window closed; the request version comes from the route, not the point (R16). */
  route: VehicleRouteDto | null;
  point: VehicleRoutePointDto | null;
  onClose: () => void;
  onSaved: (route: VehicleRouteDto) => void;
}

/** A role's key within a point: the "task row + role" pair — the server identifies it likewise. */
function roleKey(action: RoutePointAction): string {
  return `${taskRefKey(action.ref)}:${action.role}`;
}

/** What the split is missing: either nothing is checked or everything is. */
const HINTS = [
  'Отметьте, что уходит в новую точку',
  'Что-то должно остаться здесь: точка без задания не остаётся',
] as const;

export function RoutePointSplitModal({ route, point, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [picked, setPicked] = useState<string[]>([]);

  // The selection resets when the point changes: the window is opened from different rows in a
  // row, and roles checked on the previous stop have nothing to do with this one.
  useEffect(() => setPicked([]), [point?.id]);

  const actions = point?.actions ?? [];
  const moving = actions.filter((action) => picked.includes(roleKey(action)));
  /** The original point must not become empty (R13) — the server checks the same under a lock. */
  const ready = moving.length > 0 && moving.length < actions.length;

  const split = useMutation({
    mutationFn: () => {
      /*
       * The selection is checked against the point's **current** roles, not those present when
       * the window opened: the card re-reads the route by itself (R18), and while the person was
       * choosing, a role may have been taken away by a merge. On mismatch — a refusal in words:
       * splitting off "whatever is left" would silently perform an action other than the one the
       * person checked.
       */
      const current = (route!.points ?? []).find((p) => p.id === point!.id);
      const roles = current?.actions.filter((action) => picked.includes(roleKey(action))) ?? [];
      if (!current || roles.length !== picked.length || roles.length === current.actions.length) {
        throw new Error('Состав точки изменился — отметьте заново, что уходит в новую остановку');
      }
      return vehicleRoutesApi.points.split(route!.id, point!.id, {
        roles: roles.map(pointRoleInputOf),
        version: route!.version,
      });
    },
    onSuccess: (updated) => {
      message.success('Точка разнесена: новая остановка встала следом');
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={point ? `Разнести точку ${point.position}` : 'Разнести точку'}
      open={!!point && !!route}
      onCancel={onClose}
      // The button is not disabled but answers with the reason: `FormModal` keeps one footer layout
      // for every form in the portal, and a disabled button there has no way to explain itself.
      onSubmit={() => (ready ? split.mutate() : message.error(HINTS[moving.length === 0 ? 0 : 1]))}
      confirmLoading={split.isPending}
      okText="Разнести"
      width={560}
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Отмеченное уедет в новую остановку — сразу за этой, с тем же адресом. Остальное останется
          здесь.
        </Typography.Text>
        <Checkbox.Group value={picked} onChange={(v) => setPicked(v as string[])}>
          <Space orientation="vertical" size={6}>
            {actions.map((action) => (
              <Checkbox key={roleKey(action)} value={roleKey(action)}>
                {actionLabel(action)}
                {action.customerName ? ` · ${action.customerName}` : ''}
              </Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
        {/* What is missing is shown next to the list, not only after clicking: checking
          "everything" is not a split but moving the stop onto its own place. */}
        {!ready && (
          <Typography.Text type="warning">{HINTS[moving.length === 0 ? 0 : 1]}</Typography.Text>
        )}
      </Space>
    </FormModal>
  );
}
