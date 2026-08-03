import { useEffect } from 'react';
import { App, DatePicker, Form, Input, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routePurposeLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { FormGrid } from '../../components/FormGrid';
import { FormModal } from '../../components/FormModal';
import { useIsMobile } from '../../hooks/useIsMobile';
import { errorMessage } from '../../utils/format';

/**
 * Перегон техники по заявке: доставка на объект или вывоз с него (миграция 0082).
 *
 * Спецтехника доезжает до площадки по городу своим ходом, и на эту поездку выписывается 4-П.
 * Заводится он по желанию: ту же машину могут привезти тралом, и тогда листа не бывает вовсе —
 * способ доставки портал не ведёт и спрашивать его не должен.
 *
 * Доставку предлагает и форма перевода в работу, а вывоз бывает только здесь: в момент, когда
 * заявку берут в работу, дату вывоза ещё не знают — она выясняется к концу работ, в том числе
 * досрочному (ADR 0044). Сам лист выписывается не тут, а в карточке рейса: документ рождается
 * там же, где и у грузоперевозки, и второй схемы его рождения быть не должно.
 */

interface Props {
  /** null — окно закрыто. Заявка должна быть в работе и с назначенной машиной. */
  request: VehicleRequestDto | null;
  /** Что заводим: доставку на объект или вывоз с него. */
  purpose: 'delivery' | 'pickup';
  onClose: () => void;
  onDone: (route: VehicleRouteDto) => void;
}

interface FormValues {
  routeDate?: Dayjs | null;
  driverPersonId?: string;
  moveFrom?: string;
  moveTo?: string;
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

  /*
   * Подставляется то, что и так известно: доставку везут к началу работ на площадку, вывоз —
   * с площадки в день окончания. Правится всё: техника приезжает и накануне, а уходит она не
   * обязательно на базу.
   */
  useEffect(() => {
    if (!request) return;
    const period =
      request.requestType === 'special_equipment'
        ? { from: request.dateFrom, to: request.dateTo ?? request.dateFrom }
        : null;
    form.setFieldsValue({
      routeDate: period ? dayjs(purpose === 'delivery' ? period.from : period.to) : null,
      driverPersonId: undefined,
      moveFrom: purpose === 'pickup' ? objectPlace : '',
      moveTo: purpose === 'delivery' ? objectPlace : '',
    });
  }, [request, purpose, objectPlace, form]);

  const routeDate = Form.useWatch('routeDate', form);
  const vehicleId = request?.assignment?.vehicleId;
  const on = routeDate?.format('YYYY-MM-DD');

  // Тот же отбор, что проверит сервер при выписке листа: у кого полный комплект документов на
  // день перегона. Дата именно перегона, а не начала работ: удостоверение может истечь между ними.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, on, false],
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
        // Перегон по городу: вид сообщения печатается в шапке бланка, и от рейса к рейсу он тот же.
        trip: { communicationKind: 'городское' },
      }),
    onSuccess: async (route) => {
      message.success(`${routePurposeLabels[purpose]}: маршрут ${route.displayNumber}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['vehicle-routes'] }),
        qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
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

          {/* Водитель необязателен: рейс планируют заранее, человека ставят утром — так же, как
            у грузового маршрута. Без него лист не выпишется, и об этом скажет карточка рейса. */}
          <Form.Item
            name="driverPersonId"
            label="Водитель"
            extra={
              driverOptions.length === 0 && !driversLoading
                ? 'Нет водителей с полным комплектом документов на эту дату'
                : 'Можно назначить позже, в карточке маршрута'
            }
          >
            <AutoSelect
              options={driverOptions}
              showSearch
              optionFilterProp="label"
              loading={driversLoading}
              allowClear
              placeholder="Выберите водителя"
            />
          </Form.Item>

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
        </FormGrid>
      </Form>
    </FormModal>
  );
}
