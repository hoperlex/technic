import { Alert, App, Form, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isRouteEditable,
  routeRequestCapacity,
  vehicleClassificationLabel,
  type VehicleRequestDto,
  type VehicleRouteDto,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
  vehicleSubstitutionRank,
  vehicleSubstitutionWarning,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { AutoSelect } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
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
  const [form] = Form.useForm<{ routeId?: string }>();
  const blockers = useFormBlockers(form);
  // Выбранный рейс живёт формой: раньше кнопка «Перенести» при пустом выборе молча ничего не
  // делала — теперь отказ виден на самом поле (ADR 0094).
  const targetId = Form.useWatch('routeId', form);

  /**
   * Куда можно перенести: рейсы того же дня — все (ADR 0064). Подсказку собирает сервер
   * (`route-prefill` без машины) — тем же запросом, каким форма перевода в работу предлагает рейс
   * до выбора техники.
   */
  const { data: prefill, isFetching } = useQuery({
    queryKey: ['route-prefill', request?.id, 'by-kind'],
    queryFn: () => vehicleRequestsApi.routePrefill(request!.id),
    enabled: !!request,
  });

  /*
   * Из подсказки убираются три вида рейсов: свой (переносить некуда), заполненный (в бланке семь
   * строк задания) и замороженный выписанным листом (из бумаги, которая у водителя, состав не
   * меняют — сначала лист аннулируют). Правило заморозки берётся из контрактов: сервер проверит
   * его же.
   *
   * Порядок — по пригодности машины рейса: сначала заказанный тип, потом крупнее, в конце то, что
   * мельче заказанного, и совсем внизу — другой вид техники. Отбрасывать дальние рейсы нельзя:
   * это вернуло бы запреты, снятые ADR 0059 и ADR 0064; но и предлагать их первыми не следует.
   */
  const ordered = request
    ? {
        vehicleKindId: request.vehicleKindId,
        vehicleTypeId: request.vehicleTypeId,
        vehicleCategoryId: request.vehicleCategoryId,
        categorySpecs: request.vehicleCategorySpecs,
      }
    : null;
  const substitutionOf = (route: VehicleRouteDto) =>
    // Машина рейса сравнивается с заказом тем же правилом, что и машина в окне назначения:
    // одна формулировка на оба места, расходиться нечему.
    vehicleSubstitutionOf(ordered!, {
      vehicleKindId: route.vehicleKindId,
      vehicleTypeId: route.vehicleTypeId,
      vehicleCategoryId: route.vehicleCategoryId,
      categorySpecs: route.vehicleCategorySpecs,
    });
  const options = (prefill?.routes ?? [])
    .filter(
      (r) =>
        r.id !== request?.route?.id &&
        r.requests.length < routeRequestCapacity(r.formCode) &&
        isRouteEditable(r.waybill?.status ?? null),
    )
    .sort((a, b) =>
      ordered
        ? vehicleSubstitutionRank(substitutionOf(a)) - vehicleSubstitutionRank(substitutionOf(b))
        : 0,
    );
  const target = options.find((r) => r.id === targetId) ?? null;
  /** Чем машина выбранного рейса разошлась с заказом — тем же текстом, что в окне назначения. */
  const targetSubstitution =
    ordered && target && request
      ? vehicleSubstitutionWarning({
          substitution: substitutionOf(target),
          orderedLabel: vehicleClassificationLabel({
            typeName: request.vehicleTypeName,
            categoryName: request.vehicleCategoryName,
          }),
          actualTypeName: target.vehicleTypeName,
          actualCategoryName: null,
        })
      : null;

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
      form.resetFields();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['vehicle-routes'] }),
        qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
        qc.invalidateQueries({ queryKey: garageKeys.root }),
      ]);
      onDone(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const close = () => {
    form.resetFields();
    onClose();
  };

  return (
    <FormModal
      title={request ? `Перенести ${request.displayNumber} в другой рейс` : 'Перенос заявки'}
      open={!!request}
      onCancel={close}
      onSubmit={() => form.submit()}
      confirmLoading={transfer.isPending}
      okText="Перенести"
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={() => {
          if (blockers.raise({ routeId: !targetId && 'Выберите рейс' })) return;
          transfer.mutate();
        }}
        {...blockers.formProps}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Рейсы {request?.route ? `на ту же дату, что и ${request.route.displayNumber},` : 'дня'}{' '}
            со свободной строкой задания — все, без отбора по технике. Сначала заказанный тип, потом
            крупнее, в конце другой вид.
          </Typography.Text>

          <Form.Item name="routeId" style={{ marginBottom: 0 }}>
            <AutoSelect
              style={{ width: '100%' }}
              options={options.map((r) => ({
                value: r.id,
                label: [
                  r.displayNumber,
                  r.vehicleLabel,
                  // Чем рейс отличается от заказанного — прямо в строке: тип машины и направление
                  // («крупнее», «меньше заказанного»). Без этого рейсы вида читались бы вперемешку.
                  ordered ? (vehicleSubstitutionHint(substitutionOf(r)) ?? undefined) : undefined,
                  r.driverName || 'водитель не назначен',
                  `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                ]
                  .filter(Boolean)
                  .join(' · '),
              }))}
              showSearch
              optionFilterProp="label"
              loading={isFetching}
              disabled={options.length === 0}
              placeholder={
                options.length > 0 ? 'Выберите рейс' : 'Подходящих рейсов на эту дату нет'
              }
            />
          </Form.Item>

          {/* Рейс — источник истины о том, чем едут: заявка, переехавшая на другую машину, меняет
            назначение вместе с рейсом. Ставки не трогаются — о них договариваются по заявке.
            Если машина рейса разошлась с заказанным (ADR 0059), это сказано здесь же: перенос —
            то самое место, где заявка молча меняет технику. */}
          {target && target.vehicleId !== request?.assignment?.vehicleId && (
            <Alert
              type={targetSubstitution?.level === 'warning' ? 'warning' : 'info'}
              showIcon
              title="Заявка поедет машиной выбранного рейса"
              description={
                `Назначенная техника сменится на ${target.vehicleLabel}. ` +
                (targetSubstitution ? `${targetSubstitution.text} ` : '') +
                'Ставка останется прежней — о ней договариваются по заявке.'
              }
            />
          )}
        </Space>
      </Form>
    </FormModal>
  );
}
