import { useEffect } from 'react';
import { App, DatePicker, Form, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routePurposeLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useObjectScope } from '../../hooks/useObjectScope';
import { AddressField } from '@features/address-input';
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

  /** Первыми в списке мест — площадка заявки и площадки учётки (ADR 0069). */
  const { ownObjectIds } = useObjectScope();
  const suggestObjectIds = [request?.objectId, ...ownObjectIds].filter((id): id is string => !!id);

  /*
   * Подставляется место, а не дата: доставку везут на площадку заявки, вывоз — с неё, и другого
   * конца у перегона не бывает. Правится и это: техника уходит не обязательно на базу.
   *
   * День перегона спрашивается пустым полем. Начало и конец срока работ — не он: технику
   * привозят накануне, а забирают через день-другой после закрытия, и подставленная граница
   * срока молча уезжала бы в путевой лист датой выезда.
   */
  useEffect(() => {
    if (!request) return;
    form.setFieldsValue({
      routeDate: null,
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
            у грузового маршрута. Без него лист не выпишется, и об этом скажет карточка рейса.
            Сам собой в поле он не встаёт даже единственным в справочнике: за руль сажает
            диспетчер. */}
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

          {/* Адрес перегона (ADR 0069): подсказки DaData либо выбор площадки из справочника.
            Верификации не требуется — база, стоянка и ремонтный бокс адресами не описываются. */}
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
        </FormGrid>
      </Form>
    </FormModal>
  );
}
