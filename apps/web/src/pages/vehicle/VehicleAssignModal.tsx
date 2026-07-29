import { useEffect, useMemo, useState } from 'react';
import { App, Form, InputNumber, Segmented, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  type AssignVehicleInput,
  assignmentRateLabel,
  VEHICLE_OWNERSHIPS,
  vehicleClassificationLabel,
  type VehicleDto,
  type VehicleOwnership,
  vehicleLabel,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
} from '@technic/contracts';
import { vehiclesApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { FormModal } from '../../components/FormModal';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatMoney } from '../../utils/format';

/**
 * Выбор техники и ставок при переводе заявки в работу (ADR 0027).
 *
 * Выбор идёт тремя шагами — так его и держат в голове: сначала «своей машиной или арендой»,
 * у аренды — «у кого», и только потом конкретная единица. Обратный порядок (список всей
 * подходящей техники сразу) на реальном парке нечитаем: у одного типа десятки предложений от
 * разных арендодателей, и различать их приходится по хвосту строки.
 *
 * Список сужен заказанной позицией классификатора (ADR 0028): заказывали «Автокран, г/п 130 т» —
 * машины на 25 т в списке нет, её и сервер не примет. Техника с незаполненной категорией
 * остаётся с пометкой: в справочнике категория необязательна, и «неизвестно» — не то же самое,
 * что «не подходит».
 *
 * Ставки подставляются из предложения аренды и правятся свободно: договариваются по конкретной
 * заявке, и прайс справочника такой договорённости не начальник. Расхождение с прайсом видно
 * подсказкой — чтобы правка была видимой, а не тихой.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: VehicleRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: AssignVehicleInput) => void;
}

interface FormValues {
  lessorId?: string;
  vehicleId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  shiftHours?: number | null;
}

/**
 * Строка выбора: подпись машины плюс то, чем одна единица отличается от другой. Незаполненная
 * категория проговаривается прямо в строке: заявка заказана по ТТХ, и подходит ли эта машина,
 * решает человек — по названию модели и по тому, что он о ней знает.
 */
function vehicleOptionLabel(v: VehicleDto, requestHasCategory: boolean): string {
  const title = vehicleLabel(v);
  const extra = [
    v.ownership === 'own' ? v.modelName : v.categoryName,
    requestHasCategory && !v.vehicleCategoryId ? 'категория не указана' : null,
    assignmentRateLabel(v) || null,
  ].filter((s): s is string => !!s && s !== title);
  return extra.length > 0 ? `${title} — ${extra.join(' · ')}` : title;
}

export function VehicleAssignModal({ request, confirmLoading, onCancel, onSubmit }: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<FormValues>();
  const [ownership, setOwnership] = useState<VehicleOwnership>('own');

  // Вся подходящая техника одним запросом: обе ветки принадлежности нужны сразу — по их
  // наполнению подписан сам переключатель («Аренда — 12»), а списки невелики (сужены типом ТС).
  // Запрашивается тип, а не категория: машина с незаполненной категорией заявке подходит, и
  // фильтр по категории на сервере отсёк бы её вместе с чужими.
  const vehicleTypeId = request?.vehicleTypeId ?? null;
  const categoryId = request?.vehicleCategoryId ?? null;
  const { data, isFetching } = useQuery({
    queryKey: ['vehicles', 'for-assignment', vehicleTypeId],
    queryFn: () =>
      vehiclesApi.list({
        vehicleTypeId: vehicleTypeId!,
        status: 'active',
        page: 1,
        pageSize: 500,
        sortBy: 'lessorName',
        sortOrder: 'asc',
      }),
    enabled: !!vehicleTypeId,
  });
  // Машина другой категории в список не попадает: заказанная категория — это ТТХ (ADR 0028),
  // и сервер такое назначение отклонит. Пустая категория у машины — «не разнесена», не «другая».
  const vehicles = useMemo(
    () =>
      (data?.items ?? []).filter(
        (v) => !categoryId || !v.vehicleCategoryId || v.vehicleCategoryId === categoryId,
      ),
    [data, categoryId],
  );
  const byOwnership = useMemo(
    () => ({
      own: vehicles.filter((v) => v.ownership === 'own'),
      rental: vehicles.filter((v) => v.ownership === 'rental'),
    }),
    [vehicles],
  );

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели, а не при
  // размонтировании. Уже назначенная машина (повторный перевод в работу после отката) открывает
  // окно на себе: обычно её и подтверждают, а не выбирают заново.
  const targetId = request?.id ?? null;
  const assignment = request?.assignment ?? null;
  useEffect(() => {
    if (!request) return;
    const start: VehicleOwnership = assignment?.ownership ?? 'own';
    setOwnership(start);
    form.setFieldsValue({
      lessorId: assignment?.lessorId ?? undefined,
      vehicleId: assignment?.vehicleId,
      pricePerHour: assignment?.pricePerHour ?? null,
      pricePerShift: assignment?.pricePerShift ?? null,
      shiftHours: assignment?.shiftHours ?? null,
    });
    // Зависимость — идентификатор заявки: перерисовка той же заявки (инвалидация списка после
    // соседнего действия) приходит новым объектом и стёрла бы уже выбранное.
  }, [targetId]);

  const lessorId = Form.useWatch('lessorId', form);
  const vehicleId = Form.useWatch('vehicleId', form);
  const pricePerHour = Form.useWatch('pricePerHour', form);
  const pricePerShift = Form.useWatch('pricePerShift', form);

  /** Арендодатели — только те, у кого есть подходящая техника: пустой пункт выбирать незачем. */
  const lessorOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const v of byOwnership.rental) {
      if (v.lessorId) byId.set(v.lessorId, v.lessorName ?? '—');
    }
    return [...byId]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [byOwnership.rental]);

  const vehicleOptions = useMemo(() => {
    const list =
      ownership === 'own'
        ? byOwnership.own
        : byOwnership.rental.filter((v) => !lessorId || v.lessorId === lessorId);
    return list.map((v) => ({ value: v.id, label: vehicleOptionLabel(v, !!categoryId) }));
  }, [ownership, lessorId, byOwnership, categoryId]);

  const selected = vehicles.find((v) => v.id === vehicleId) ?? null;
  const isRental = ownership === 'rental';

  /** Ставки предложения аренды: по ним подставляются поля и видно, что цену изменили вручную. */
  const listedRate = selected?.ownership === 'rental' ? selected : null;
  const priceChanged =
    !!listedRate &&
    ((pricePerHour ?? null) !== (listedRate.pricePerHour ?? null) ||
      (pricePerShift ?? null) !== (listedRate.pricePerShift ?? null));

  /** Смена ветки: чужие поля сбрасываются — арендодатель у своей машины смысла не имеет. */
  const changeOwnership = (next: VehicleOwnership) => {
    setOwnership(next);
    form.setFieldsValue({
      lessorId: undefined,
      vehicleId: undefined,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
    });
  };

  /** Выбор машины подставляет её ставки из справочника; у собственной их нет — поля пустые. */
  const changeVehicle = (id: string) => {
    const v = vehicles.find((x) => x.id === id);
    form.setFieldsValue({
      vehicleId: id,
      pricePerHour: v?.pricePerHour ?? null,
      pricePerShift: v?.pricePerShift ?? null,
      shiftHours: v?.shiftHours ?? null,
    });
  };

  const submit = (v: FormValues) => {
    if (!v.vehicleId) {
      message.warning('Выберите технику');
      return;
    }
    // Аренда — это счёт от контрагента: без ставки заявка в работе означала бы, что цену
    // выяснят потом. Тем же правилом отвечает сервер.
    if (isRental && v.pricePerHour == null && v.pricePerShift == null) {
      message.warning('Укажите стоимость аренды — за час или за смену');
      return;
    }
    onSubmit({
      vehicleId: v.vehicleId,
      pricePerHour: v.pricePerHour ?? null,
      pricePerShift: v.pricePerShift ?? null,
      shiftHours: v.shiftHours ?? null,
    });
  };

  const emptyText = isFetching
    ? 'Загружаем технику…'
    : ownership === 'own'
      ? 'Собственной техники под этот заказ нет — возьмите её в аренду'
      : lessorId
        ? 'У этого арендодателя нет подходящих предложений'
        : 'Предложений аренды под этот заказ нет';

  return (
    <FormModal
      title={request ? `В работу: заявка ${request.displayNumber}` : 'В работу'}
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Взять в работу"
      width={620}
    >
      {request && (
        <Form form={form} layout="vertical" onFinish={submit}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            {request.objectCode} — {request.objectName} · заказано «
            {vehicleClassificationLabel({
              typeName: request.vehicleTypeName,
              categoryName: request.vehicleCategoryName,
            })}
            »
          </Typography.Paragraph>

          {/* Шаг 1: чья машина. Количество подходящих единиц — в самой подписи: пустая ветка
              видна до того, как в неё зайдут. */}
          {/* Не поле формы: принадлежность в назначение не уходит — она у самой машины, а
              здесь только сужает список. */}
          <Form.Item label="Техника">
            <Segmented<VehicleOwnership>
              block
              value={ownership}
              onChange={changeOwnership}
              options={VEHICLE_OWNERSHIPS.map((o) => ({
                value: o,
                label: `${vehicleOwnershipLabels[o]} · ${byOwnership[o].length}`,
                disabled: byOwnership[o].length === 0,
              }))}
            />
          </Form.Item>

          {/* Шаг 2 (только аренда): у кого берём. */}
          {isRental && (
            <Form.Item
              name="lessorId"
              label="Арендодатель"
              rules={[{ required: true, message: 'Выберите арендодателя' }]}
            >
              <AutoSelect
                options={lessorOptions}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                placeholder="Выберите арендодателя"
                onChange={() =>
                  form.setFieldsValue({
                    vehicleId: undefined,
                    pricePerHour: null,
                    pricePerShift: null,
                    shiftHours: null,
                  })
                }
              />
            </Form.Item>
          )}

          {/* Шаг 3: конкретная единица. */}
          <Form.Item
            name="vehicleId"
            label="Конкретная техника"
            rules={[{ required: true, message: 'Выберите технику' }]}
            extra={vehicleOptions.length === 0 ? emptyText : undefined}
          >
            <AutoSelect
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={isFetching}
              disabled={isRental && !lessorId}
              placeholder={isRental && !lessorId ? 'Сначала выберите арендодателя' : 'Выберите ТС'}
              onChange={changeVehicle}
            />
          </Form.Item>

          {selected && (
            <Space size={8} wrap style={{ marginBottom: 16 }}>
              {selected.categoryName && <Tag color="blue">{selected.categoryName}</Tag>}
              {selected.registrationNumber && <Tag>{selected.registrationNumber}</Tag>}
              {selected.lessorName && <Tag color="purple">{selected.lessorName}</Tag>}
            </Space>
          )}

          {/* Ставки: подставлены из справочника, но это поля ввода — цену по заявке
              согласовывают отдельно от прайса. */}
          <Space
            style={{ width: '100%' }}
            size="middle"
            align="start"
            direction={isMobile ? 'vertical' : 'horizontal'}
          >
            <Form.Item
              name="pricePerHour"
              label="Стоимость за час, ₽"
              extra={
                listedRate?.pricePerHour != null
                  ? `В справочнике: ${formatMoney(listedRate.pricePerHour)}`
                  : undefined
              }
            >
              <InputNumber style={{ width: '100%' }} min={0} step={100} precision={2} />
            </Form.Item>
            <Form.Item
              name="pricePerShift"
              label="Стоимость за смену, ₽"
              extra={
                listedRate?.pricePerShift != null
                  ? `В справочнике: ${formatMoney(listedRate.pricePerShift)}`
                  : undefined
              }
            >
              <InputNumber style={{ width: '100%' }} min={0} step={1000} precision={2} />
            </Form.Item>
            <Form.Item name="shiftHours" label="Часов в смене">
              <InputNumber style={{ width: '100%' }} min={1} max={24} precision={0} />
            </Form.Item>
          </Space>

          {priceChanged && (
            <Typography.Text type="warning">
              Ставка отличается от справочника — в заявке сохранится договорная
            </Typography.Text>
          )}
          {!isRental && (
            <Typography.Text type="secondary">
              У собственной техники ставка необязательна: её указывают, если работу считают в
              деньгах
            </Typography.Text>
          )}
        </Form>
      )}
    </FormModal>
  );
}
