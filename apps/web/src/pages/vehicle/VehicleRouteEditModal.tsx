import { useEffect } from 'react';
import { App, Checkbox, DatePicker, Form, Input, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  isRouteEditable,
  ROUTE_FROZEN_MESSAGE,
  routePurposeLabels,
  type VehicleRouteDto,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../utils/format';

/**
 * Правка рейса: день, водитель, реквизиты выезда, комментарий, а у перегона — «откуда — куда».
 *
 * До сих пор в карточке рейса менялся только состав: водителя ставили при переводе заявки в
 * работу, а перепутанный день чинили пересборкой рейса заново. Между тем правят рейс каждое утро —
 * человек заболел, машина не вышла, выезд сдвинулся на день.
 *
 * Дата переносит рейс вместе с заявками (сервер, `moveRouteToDate`): день рейса и день подачи —
 * одно и то же событие с двух сторон. Что именно переедет, окно называет до нажатия: диспетчер
 * должен видеть, что двигает не только строку рейса.
 *
 * Выписанный лист правку запрещает целиком (`isRouteEditable`): бумага уже у водителя, и запись,
 * разошедшаяся с ней, хуже отсутствия записи (ADR 0037 п. 9).
 */

const DATE = 'YYYY-MM-DD';

interface FormValues {
  routeDate: dayjs.Dayjs;
  driverPersonId?: string | null;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  comment: string;
  moveFrom?: string;
  moveTo?: string;
}

interface Props {
  /** null — окно закрыто. */
  route: VehicleRouteDto | null;
  onClose: () => void;
  /** Рейс изменился: списки маршрутов и заявок после этого не те же. */
  onSaved: (route: VehicleRouteDto) => void;
}

export function VehicleRouteEditModal({ route, onClose, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const relocation = !!route && isRelocationPurpose(route.purpose);

  useEffect(() => {
    if (!route) return;
    form.setFieldsValue({
      routeDate: dayjs(route.routeDate),
      driverPersonId: route.driverPersonId ?? undefined,
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      garageNumber: route.garageNumber,
      communicationKind: route.communicationKind,
      transportationKind: route.transportationKind,
      comment: route.comment,
      moveFrom: route.moveFrom,
      moveTo: route.moveTo,
    });
    // Зависимость — сам рейс: перерисовка после сохранения приходит новым объектом с новыми
    // значениями, и поля обязаны встать на них.
  }, [route, form]);

  const routeDate = Form.useWatch('routeDate', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const on = (routeDate ?? (route ? dayjs(route.routeDate) : null))?.format(DATE);

  /**
   * Кто может сесть за эту машину в этот день. Список подсказывает — пригодные первыми, с
   * пометками о категории и документах (ADR 0064), — но сам никого не выбирает: за руль человека
   * сажает диспетчер.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', route?.vehicleId, on, withTrailer],
    queryFn: () => driversApi.available({ vehicleId: route!.vehicleId, on: on!, withTrailer }),
    enabled: !!route && !!on,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      driverDocumentGapsHint(d.gaps),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  /** Выписанный лист замораживает рейс целиком: правки отклоняет и портал, и сервер. */
  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRoutesApi.update(route!.id, {
        version: route!.version,
        routeDate: v.routeDate.format(DATE),
        driverPersonId: v.driverPersonId ?? null,
        trip: {
          withTrailer: v.withTrailer,
          // Реквизиты прицепа уходят только вместе с самим прицепом: без него сервер их не примет
          // («реквизиты прицепа без прицепа в рейсе не печатаются»), а у рейса они могли остаться
          // с прошлого раза — снятый прицеп забирает их с собой.
          trailer1Model: v.withTrailer ? (v.trailer1Model ?? '') : '',
          trailer1RegNumber: v.withTrailer ? (v.trailer1RegNumber ?? '') : '',
          trailer2Model: '',
          trailer2RegNumber: '',
          garageNumber: v.garageNumber ?? '',
          communicationKind: v.communicationKind ?? '',
          transportationKind: v.transportationKind ?? '',
        },
        comment: v.comment ?? '',
        ...(relocation ? { moveFrom: v.moveFrom, moveTo: v.moveTo } : {}),
      }),
    onSuccess: (updated) => {
      message.success('Маршрут изменён');
      qc.setQueryData(['vehicle-routes', updated.id], updated);
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Перенос дня спрашивается отдельно: вместе с рейсом переедет подача его заявок, а это уже не
   * запись в плане, а изменение того, на когда заказчик ждёт машину. Заявки называются поимённо —
   * «двигаю рейс» и «двигаю четыре чужих заказа» это разные решения.
   */
  const submit = (v: FormValues) => {
    // Заморозку проверяем и здесь: окно открывают из двух мест, и лист мог быть выписан, пока оно
    // висело открытым. Сервер откажет тем же правилом — но сказать об этом лучше до запроса.
    if (frozen) {
      message.error(ROUTE_FROZEN_MESSAGE);
      return;
    }
    const moving = !!route && v.routeDate.format(DATE) !== route.routeDate;
    const affected = route?.requests ?? [];
    if (!moving || affected.length === 0) {
      save.mutate(v);
      return;
    }
    modal.confirm({
      title: `Перенести маршрут на ${v.routeDate.format('DD.MM.YYYY')}?`,
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Вместе с рейсом переедет подача заявок:{' '}
          {affected.map((item) => item.displayNumber).join(', ')}. Время подачи у каждой останется
          прежним.
        </Typography.Paragraph>
      ),
      okText: 'Перенести',
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync(v),
    });
  };

  return (
    <FormModal
      title={route ? `Маршрут ${route.displayNumber} · правка` : 'Маршрут'}
      open={!!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      okText="Сохранить"
      width={640}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit} disabled={frozen}>
        <FormGrid>
          {frozen && (
            <FormGrid.Full>
              <Typography.Text type="warning">{ROUTE_FROZEN_MESSAGE}</Typography.Text>
            </FormGrid.Full>
          )}

          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            extra={
              route && route.requests.length > 0
                ? `Вместе с рейсом переедет подача ${route.requests.length} заявок`
                : undefined
            }
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>

          <Form.Item
            name="driverPersonId"
            label="Водитель"
            extra="Без водителя лист не выписать; поставить его можно и позже"
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              allowClear
              optionFilterProp="label"
              loading={driversLoading}
              placeholder="Выберите водителя"
            />
          </Form.Item>

          {/* Задание перегона: у грузового рейса его собирает состав, и сервер такие поля не
            примет. */}
          {relocation && (
            <>
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
              <FormGrid.Full>
                <Typography.Text type="secondary">
                  {routePurposeLabels[route!.purpose]}
                  {route?.sourceRequest ? ` · по заявке ${route.sourceRequest.displayNumber}` : ''}
                </Typography.Text>
              </FormGrid.Full>
            </>
          )}

          {/* Реквизиты выезда: от рейса к рейсу они те же и правятся раз в сезон — но правятся
            здесь, а не пересборкой рейса. У формы № 3 граф прицепа нет вовсе (ADR 0071), поэтому
            прицеп спрашивается только там, где он печатается. */}
          {route?.formCode !== 'leg3' && (
            <>
              <FormGrid.Full>
                <Form.Item name="withTrailer" valuePropName="checked">
                  <Checkbox>Рейс с прицепом</Checkbox>
                </Form.Item>
              </FormGrid.Full>
              {withTrailer && (
                <>
                  <Form.Item name="trailer1Model" label="Прицеп: марка">
                    <Input placeholder="СЗАП-8551" />
                  </Form.Item>
                  <Form.Item name="trailer1RegNumber" label="Прицеп: госномер">
                    <Input placeholder="АВ1234 77" />
                  </Form.Item>
                </>
              )}
            </>
          )}

          <Form.Item name="garageNumber" label="Гаражный номер">
            <Input placeholder="Из справочника техники, если пусто" />
          </Form.Item>
          <Form.Item name="communicationKind" label="Вид сообщения">
            <Input placeholder="городское" />
          </Form.Item>
          <Form.Item name="transportationKind" label="Вид перевозки">
            <Input placeholder="коммерческая" />
          </Form.Item>

          <FormGrid.Full>
            <Form.Item name="comment" label="Комментарий к рейсу">
              <Input.TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
