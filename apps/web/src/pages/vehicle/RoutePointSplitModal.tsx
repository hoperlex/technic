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
import { vehicleRoutesApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { actionLabel, pointRoleInputOf } from './routeAssembly';

/**
 * Разнести остановку надвое (Р9а): отмеченные роли уходят в новую точку сразу за исходной.
 *
 * Обратное действие «совместить» стоит в самом списке и окна не требует — там выбирать нечего:
 * точки одного адреса известны, и сводятся они все сразу. Здесь выбор есть, и он единственное, о
 * чём окно спрашивает: «этих грузим на первом корпусе, тех на третьем» — это решение человека, и
 * угадать его нечем.
 *
 * Адрес новая точка берёт у исходной: разносят не место, а работу. Время прибытия и комментарий у
 * неё свои и пустые — они описывают заезд, а заездов теперь два.
 */

interface Props {
  /** `null` — окно закрыто; версия для запроса берётся у рейса, а не у точки (Р16). */
  route: VehicleRouteDto | null;
  point: VehicleRoutePointDto | null;
  onClose: () => void;
  onSaved: (route: VehicleRouteDto) => void;
}

/** Ключ роли внутри точки: пара «строка задания + роль» — тем же ключом её опознаёт сервер. */
function roleKey(action: RoutePointAction): string {
  return `${taskRefKey(action.ref)}:${action.role}`;
}

/** Чего не хватает разнесению: ничего не отмечено либо отмечено всё. */
const HINTS = [
  'Отметьте, что уходит в новую точку',
  'Что-то должно остаться здесь: точка без задания не остаётся',
] as const;

export function RoutePointSplitModal({ route, point, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [picked, setPicked] = useState<string[]>([]);

  // Выбор сбрасывается вместе со сменой точки: окно открывают из разных строк подряд, и роли,
  // отмеченные на прошлой остановке, к этой отношения не имеют.
  useEffect(() => setPicked([]), [point?.id]);

  const actions = point?.actions ?? [];
  const moving = actions.filter((action) => picked.includes(roleKey(action)));
  /** Исходная точка не должна опустеть (Р13) — это же проверит сервер под блокировкой. */
  const ready = moving.length > 0 && moving.length < actions.length;

  const split = useMutation({
    mutationFn: () => {
      /*
       * Отмеченное сверяется с **сегодняшним** составом точки, а не с тем, что было при открытии
       * окна: карточка перечитывает рейс сама (Р18), и пока человек выбирал, роль могли увести
       * совмещением. Разошлось — отказ словами: разнести «то, что осталось» значило бы сделать не
       * то действие, которое человек отметил, и молча.
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
      // Кнопка не выключается, а отвечает причиной: `FormModal` держит один вид подвала на все
      // формы портала, и выключенная кнопка в нём объяснить себя ничем не может.
      onSubmit={() => (ready ? split.mutate() : message.error(HINTS[moving.length === 0 ? 0 : 1]))}
      confirmLoading={split.isPending}
      okText="Разнести"
      width={560}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Отмеченное уедет в новую остановку — сразу за этой, с тем же адресом. Остальное останется
          здесь.
        </Typography.Text>
        <Checkbox.Group value={picked} onChange={(v) => setPicked(v as string[])}>
          <Space direction="vertical" size={6}>
            {actions.map((action) => (
              <Checkbox key={roleKey(action)} value={roleKey(action)}>
                {actionLabel(action)}
                {action.customerName ? ` · ${action.customerName}` : ''}
              </Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
        {/* Чего не хватает — видно рядом со списком, а не только после нажатия: отметить «всё»
          это не разнесение, а переезд остановки на место самой себя. */}
        {!ready && (
          <Typography.Text type="warning">{HINTS[moving.length === 0 ? 0 : 1]}</Typography.Text>
        )}
      </Space>
    </FormModal>
  );
}
