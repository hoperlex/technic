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
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { vehicleRoutesApi } from '../../api/resources';
import { TimeInput } from '../../components/TimeInput';
import { errorMessage } from '../../utils/format';
import { pointRoleInputOf } from './routeAssembly';

/**
 * Правка остановки: адрес, план прибытия и записка водителю (§4.3 плана
 * `docs/route-trips-plan.md`).
 *
 * Состав ролей здесь не правится, хотя ручка принимает его целиком. Роли переезжают между точками
 * своими действиями — «совместить» и «разнести» (Р9а), — и они же отвечают на вопрос, который
 * человек на самом деле задаёт: «это один заезд или два». Список чекбоксов «что здесь делаем»
 * рядом с адресом позволял бы снять с точки последнюю роль, то есть удалить остановку правкой
 * адреса, — а точка без задания не заводится и не остаётся (Р13). Поэтому роли уходят на сервер
 * теми же, что пришли: правка адреса — это правка адреса.
 *
 * Адрес требуется верифицированным (ADR 0006, Р11б): именно он печатается в бланк и именно по нему
 * поедет машина. Легаси-строка, доставшаяся точке от бэкфила, при этом остаётся читаемой — жёсткая
 * модель действует на запись, а не на чтение, — но сохранить её обратно нельзя, и это намеренно.
 */

interface PointValues {
  location?: string;
  address?: AddressMeta | null;
  arrivalTime?: string;
  comment?: string;
}

interface Props {
  /** `null` — окно закрыто; рейс нужен целиком: у правки точки версия рейса, а не точки (Р16). */
  route: VehicleRouteDto | null;
  point: VehicleRoutePointDto | null;
  onClose: () => void;
  onSaved: (route: VehicleRouteDto) => void;
}

/**
 * Время остановки необязательно (`arrivalTimeSchema`), но заполненное обязано быть временем.
 *
 * Своим правилом, а не `optionalWorkTimeRule`: та вдобавок запирает время в рабочее окно, а
 * остановка в маршруте бывает и до его начала — машина выходит из гаража затемно, и ночная погрузка
 * на карьере это не ошибка ввода. Сервер рабочего окна у точки тоже не спрашивает, и запретить
 * здесь то, что он примет, значило бы врать человеку о правилах.
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

  // Форма живёт дольше одной точки: окно открывают из разных строк списка подряд, а `FormModal`
  // разметку между открытиями не сбрасывает. Поэтому поля перезаряжаются самой точкой — иначе во
  // второй остановке оказался бы адрес первой.
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
       * Роли берутся из **сегодняшнего** состояния точки, а не из того снимка, с которым окно
       * открывали: карточка перечитывает рейс сама (правка заявки поднимает его версию, Р18), и
       * пока форма заполнена, состав точки мог измениться. Отправь снимок — и «поправил время»
       * молча отменило бы чужое совмещение, потому что состав ролей уходит целиком.
       */
      const current = (route!.points ?? []).find((p) => p.id === point!.id) ?? point!;
      return vehicleRoutesApi.points.update(route!.id, point!.id, {
        location: (v.location ?? '').trim(),
        address: v.address!,
        arrivalTime: v.arrivalTime ?? '',
        comment: (v.comment ?? '').trim(),
        // Роли уходят прежними: правка адреса не распоряжается тем, что на точке происходит.
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
            {/* Адрес точки — снимок, а не ссылка на ездку (Р10): на остановке сходятся ездки разных
              заявок, и «адрес ездки» у неё неоднозначен. Правка здесь не трогает заявку — и
              наоборот: заявка, у которой адрес поправили после сборки, помечает свою роль
              расхождением. */}
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
            {/* Записка про эту остановку, а не про заявку: «звонить с ворот», «пропуск у
              весовщика». В бланк она не идёт — там графы под неё нет, — но доезжает до водителя
              заданием: письмом и кабинетом `/driver` (§8 плана). */}
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
