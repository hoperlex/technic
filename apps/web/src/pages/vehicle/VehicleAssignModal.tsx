import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  type AssignVehicleBody,
  assignmentRateLabel,
  VEHICLE_OWNERSHIPS,
  vehicleClassificationLabel,
  type VehicleDto,
  type VehicleOwnership,
  vehicleLabel,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi, vehiclesApi } from '../../api/resources';
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
  onSubmit: (v: AssignVehicleBody) => void;
}

interface FormValues {
  lessorId?: string;
  vehicleId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  shiftHours?: number | null;
  // ── Путевой лист (ADR 0037) ──
  driverPersonId?: string;
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  garageNumber?: string;
  communicationKind?: string;
  transportationKind?: string;
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

  // ── Путевой лист (ADR 0037) ──
  // Выписывается ли лист на выбранную машину, на какую дату и чем заполнены графы шапки в прошлый
  // раз. Спрашивается по машине: на аренду лист не выписывается, и полей у неё быть не должно.
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const { data: prefill } = useQuery({
    queryKey: ['waybill-prefill', targetId, vehicleId],
    queryFn: () => vehicleRequestsApi.waybillPrefill(targetId!, vehicleId!),
    enabled: !!targetId && !!vehicleId,
  });
  const needsWaybill = prefill?.required ?? false;

  // Список водителей — тот же отбор, что проверит сервер: годные к этой машине на дату рейса.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, prefill?.tripDate, withTrailer],
    queryFn: () =>
      driversApi.available({ vehicleId: vehicleId!, on: prefill!.tripDate, withTrailer }),
    enabled: needsWaybill && !!vehicleId && !!prefill?.tripDate,
  });
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      d.personnelNo && `таб. ${d.personnelNo}`,
      d.verificationStatus === 'unverified' ? 'документ не проверен' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  /** Графы шапки наследуются от прошлого листа этой машины — их правят раз в сезон, а не в рейс. */
  useEffect(() => {
    if (!prefill?.fields) return;
    form.setFieldsValue({
      withTrailer: prefill.fields.withTrailer,
      trailer1Model: prefill.fields.trailer1Model,
      trailer1RegNumber: prefill.fields.trailer1RegNumber,
      garageNumber: prefill.fields.garageNumber,
      communicationKind: prefill.fields.communicationKind,
      transportationKind: prefill.fields.transportationKind,
    });
  }, [prefill?.fields]);

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
    // Водитель обязателен ровно там, где выписывается лист: у аренды он чужой, и портал его
    // не ведёт. Тем же правилом отвечает сервер.
    if (needsWaybill && !v.driverPersonId) {
      message.warning('Выберите водителя — на рейс выписывается путевой лист');
      return;
    }
    onSubmit({
      vehicleId: v.vehicleId,
      pricePerHour: v.pricePerHour ?? null,
      pricePerShift: v.pricePerShift ?? null,
      shiftHours: v.shiftHours ?? null,
      ...(needsWaybill
        ? {
            driverPersonId: v.driverPersonId,
            waybill: {
              withTrailer: v.withTrailer ?? false,
              trailer1Model: v.withTrailer ? (v.trailer1Model ?? '') : '',
              trailer1RegNumber: v.withTrailer ? (v.trailer1RegNumber ?? '') : '',
              garageNumber: v.garageNumber ?? '',
              communicationKind: v.communicationKind ?? '',
              transportationKind: v.transportationKind ?? '',
            },
          }
        : {}),
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

          {/* Путевой лист (ADR 0037): выписывается тут же, вместе с переводом в работу. Причина,
              по которой лист не нужен, показывается текстом — отсутствие блока читалось бы как
              поломка. */}
          {selected && prefill && !prefill.required && prefill.reason && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 16 }}
              message="Путевой лист не выписывается"
              description={prefill.reason}
            />
          )}

          {needsWaybill && (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                Путевой лист
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
                {prefill?.formLabel} · на {prefill?.tripDate}
              </Typography.Paragraph>

              <Form.Item
                name="driverPersonId"
                label="Водитель"
                rules={[{ required: true, message: 'Выберите водителя' }]}
                extra={
                  driverOptions.length === 0 && !driversLoading
                    ? selection?.requiredCategory
                      ? `Нет водителей с действующей категорией ${selection.requiredCategory} на эту дату`
                      : 'Нет водителей с действующим удостоверением на эту дату'
                    : undefined
                }
              >
                <AutoSelect
                  options={driverOptions}
                  showSearch
                  optionFilterProp="label"
                  loading={driversLoading}
                  placeholder="Выберите водителя"
                />
              </Form.Item>

              {/* Прицеп — признак рейса, а не свойство машины: он поднимает требуемую категорию
                  водителя, поэтому список выше пересобирается при его включении. */}
              <Form.Item name="withTrailer" valuePropName="checked">
                <Checkbox>Рейс с прицепом</Checkbox>
              </Form.Item>
              {withTrailer && (
                <Space
                  style={{ width: '100%' }}
                  size="middle"
                  direction={isMobile ? 'vertical' : 'horizontal'}
                >
                  <Form.Item name="trailer1Model" label="Марка прицепа">
                    <Input placeholder="МАЗ-8926" />
                  </Form.Item>
                  <Form.Item name="trailer1RegNumber" label="Госномер прицепа">
                    <Input placeholder="8062 ЕН 77" />
                  </Form.Item>
                </Space>
              )}

              <Space
                style={{ width: '100%' }}
                size="middle"
                direction={isMobile ? 'vertical' : 'horizontal'}
              >
                <Form.Item name="garageNumber" label="Гаражный номер">
                  <Input placeholder="00000389" />
                </Form.Item>
                <Form.Item name="communicationKind" label="Вид сообщения">
                  <Input placeholder="пригородное" />
                </Form.Item>
                <Form.Item name="transportationKind" label="Вид перевозки">
                  <Input placeholder="коммерческая" />
                </Form.Item>
              </Space>
            </>
          )}
        </Form>
      )}
    </FormModal>
  );
}
