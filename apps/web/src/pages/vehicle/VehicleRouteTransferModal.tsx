import { useState } from 'react';
import { Alert, App, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isRouteEditable,
  MAX_ROUTE_REQUESTS,
  type VehicleRequestDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { FormModal } from '../../components/FormModal';
import { errorMessage } from '../../utils/format';

/**
 * Перенос заявки в другой рейс из её карточки (ADR 0052).
 *
 * Второй вход в ту же операцию: собирают рейс в его карточке, но день читают по заявкам — и когда
 * выясняется, что ТС-501 должна ехать не с утренним рейсом, а с дневным, идти за ней во вкладку
 * «Маршруты» незачем. Перенос — одно действие над двумя рейсами: заявка уходит из исходного,
 * приходит в целевой, талоны исходного уплотняются. Двумя действиями («вынуть» и «положить»)
 * между ними оставалась бы заявка в работе без маршрута.
 *
 * Новый рейс отсюда не заводится: рейс — это машина, дата и реквизиты выезда, и заводят его там,
 * где эти вопросы задают, — формой перевода в работу либо кнопкой «Новый маршрут» во вкладке
 * «Маршруты». Третьего места, где рождается рейс, быть не должно.
 */

interface Props {
  /** null — окно закрыто. Заявка должна стоять в рейсе: перенос без исходного не бывает. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  /** Перенос удался: списки заявок и рейсов устарели, а карточку закрывает вызывающий. */
  onDone: (route: VehicleRouteDto) => void;
}

export function VehicleRouteTransferModal({ request, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState<string | undefined>();

  /**
   * Куда можно перенести: рейсы того же дня и того же типа ТС, что заказан в заявке. Подсказку
   * собирает сервер (`route-prefill` без машины) — тем же отбором, каким форма перевода в работу
   * предлагает рейс до выбора техники.
   */
  const { data: prefill, isFetching } = useQuery({
    queryKey: ['route-prefill', request?.id, 'by-type'],
    queryFn: () => vehicleRequestsApi.routePrefill(request!.id),
    enabled: !!request,
  });

  /*
   * Из подсказки убираются три вида рейсов: свой (переносить некуда), заполненный (в бланке
   * четыре талона) и замороженный выписанным листом (из бумаги, которая у водителя, состав не
   * меняют — сначала лист аннулируют). Правило заморозки берётся из контрактов: сервер проверит
   * его же.
   */
  const options = (prefill?.routes ?? []).filter(
    (r) =>
      r.id !== request?.route?.id &&
      r.requests.length < MAX_ROUTE_REQUESTS &&
      isRouteEditable(r.waybill?.status ?? null),
  );
  const target = options.find((r) => r.id === targetId) ?? null;

  const transfer = useMutation({
    mutationFn: () =>
      vehicleRoutesApi.attach(targetId!, {
        requestId: request!.id,
        version: target!.version,
        // Исходный рейс — парой «кто + версия»: версии нумеруются в каждом рейсе отдельно, и
        // сервер проверяет, что заявка сейчас лежит именно там, откуда её забирают.
        source: { routeId: request!.route!.id, version: request!.route!.version },
      }),
    onSuccess: async (updated) => {
      message.success(`${request!.displayNumber} перенесена в ${updated.displayNumber}`);
      setTargetId(undefined);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['vehicle-routes'] }),
        qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
      ]);
      onDone(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const close = () => {
    setTargetId(undefined);
    onClose();
  };

  return (
    <FormModal
      title={request ? `Перенести ${request.displayNumber} в другой рейс` : 'Перенос заявки'}
      open={!!request}
      onCancel={close}
      onSubmit={() => targetId && transfer.mutate()}
      confirmLoading={transfer.isPending}
      okText="Перенести"
      width={520}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Рейсы {request?.route ? `на ту же дату, что и ${request.route.displayNumber},` : 'дня'} с
          машиной заказанного типа и свободным талоном.
        </Typography.Text>

        <AutoSelect
          style={{ width: '100%' }}
          value={targetId}
          onChange={(v) => setTargetId(v as string)}
          options={options.map((r) => ({
            value: r.id,
            label: [
              r.displayNumber,
              r.vehicleLabel,
              r.driverName || 'водитель не назначен',
              `${r.requests.length} из ${MAX_ROUTE_REQUESTS} талонов`,
            ].join(' · '),
          }))}
          showSearch
          optionFilterProp="label"
          loading={isFetching}
          disabled={options.length === 0}
          placeholder={options.length > 0 ? 'Выберите рейс' : 'Подходящих рейсов на эту дату нет'}
        />

        {/* Рейс — источник истины о том, чем едут: заявка, переехавшая на другую машину, меняет
            назначение вместе с рейсом. Ставки не трогаются — о них договариваются по заявке. */}
        {target && target.vehicleId !== request?.assignment?.vehicleId && (
          <Alert
            type="warning"
            showIcon
            message="Заявка поедет машиной выбранного рейса"
            description={`Назначенная техника сменится на ${target.vehicleLabel}. Ставка останется прежней — о ней договариваются по заявке.`}
          />
        )}
      </Space>
    </FormModal>
  );
}
