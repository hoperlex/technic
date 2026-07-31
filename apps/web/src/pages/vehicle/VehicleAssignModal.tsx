import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  type AssignVehicleBody,
  assignmentRateLabel,
  type ConfirmScheduleBody,
  formatMoscowDateTime,
  LICENSE_REQUISITES_MISSING_HINT,
  LICENSE_REQUISITES_MISSING_WARNING,
  licenseRequisitesMissing,
  MAX_ROUTE_REQUESTS,
  normalizeTimeInput,
  VEHICLE_CATEGORY_MISMATCH_HINT,
  VEHICLE_OWNERSHIPS,
  requestCustomerName,
  vehicleCategoryMismatch,
  vehicleCategoryMismatchWarning,
  vehicleClassificationLabel,
  type VehicleDto,
  type VehicleOwnership,
  vehicleLabel,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi, vehiclesApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { FormGrid } from '../../components/FormGrid';
import { FormModal } from '../../components/FormModal';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { useIsMobile } from '../../hooks/useIsMobile';
import { MOSCOW_TZ } from '../../theme';
import { formatMoney } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Выбор техники, срока и ставок при переводе заявки в работу (ADR 0027).
 *
 * Первым спрашивается фактический срок: заказанное время планируемое — заявку заводят заранее, а
 * когда машина выйдет на самом деле, выясняется в разговоре с исполнителем, то есть ровно здесь.
 * Поля подставлены заказанным, под ними — что просили изначально: правка должна быть видимой, а не
 * незаметной подменой. Стоит блок до выбора техники не для порядка: от даты рейса зависит, кто из
 * водителей годен, и список ниже пересобирается по ней.
 *
 * Выбор идёт тремя шагами — так его и держат в голове: сначала «своей машиной или арендой»,
 * у аренды — «у кого», и только потом конкретная единица. Обратный порядок (список всей
 * подходящей техники сразу) на реальном парке нечитаем: у одного типа десятки предложений от
 * разных арендодателей, и различать их приходится по хвосту строки.
 *
 * Список сужен типом ТС, но не заказанной категорией (ADR 0045): заказывали «Автокран, г/п 130 т» —
 * в списке будут все автокраны, включая 25-тонный. Подходит ли соседняя позиция классификатора,
 * решает диспетчер: он знает и парк, и то, о чём договорились с заказчиком. Расхождение
 * называется прямо — пометкой в строке и предупреждением под полем, — но выбор не отнимает.
 *
 * Ставки подставляются из предложения аренды и правятся свободно: договариваются по конкретной
 * заявке, и прайс справочника такой договорённости не начальник. Расхождение с прайсом видно
 * подсказкой — чтобы правка была видимой, а не тихой.
 *
 * Этим же окном меняют машину у заявки, которая уже в работе (ADR 0048): подбор устроен одинаково
 * в обоих случаях, и второе окно с тем же содержимым разошлось бы с первым при первой же правке.
 * Отличается блок фактического срока — при смене техники его не спрашивают: срок уже согласован,
 * меняется только чем заявку выполняют.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: VehicleRequestDto | null;
  /**
   * Зачем открыто окно: `confirm` — перевод заявки в работу (ADR 0027), `reassign` — смена машины
   * у той, что уже работает (ADR 0048). Режим задаёт заголовок, надпись на кнопке и наличие блока
   * фактического срока, но не сам подбор техники — он один на оба случая.
   */
  mode?: 'confirm' | 'reassign';
  confirmLoading: boolean;
  onCancel: () => void;
  /** `schedule: null` — срок не спрашивали (режим `reassign`). */
  onSubmit: (v: { assignment: AssignVehicleBody; schedule: ConfirmScheduleBody | null }) => void;
}

/** Значение селекта «завести новый рейс»: пустая строка неотличима от «ещё не выбрали». */
const NEW_ROUTE = 'new';

interface FormValues {
  // ── Фактический срок ──
  /** Спецтехника: период работ. */
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  /** Грузоперевозка: дата подачи и время («чч:мм»); пустое время — подача без точного часа. */
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  lessorId?: string;
  vehicleId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  shiftHours?: number | null;
  // ── Маршрут: готовый рейс либо новый вместе с водителем и реквизитами выезда ──
  routeId?: string;
  driverPersonId?: string;
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  garageNumber?: string;
  communicationKind?: string;
  transportationKind?: string;
}

/**
 * Строка выбора: подпись машины плюс то, чем одна единица отличается от другой. Категория —
 * первое, чем они различаются в списке одного типа, поэтому у собственной машины она стоит рядом
 * с моделью, а не вместо неё. Расхождение с заказанным и незаполненная категория проговариваются
 * прямо в строке: подходит ли эта машина, решает человек — по названию модели и по тому, что он
 * о ней знает.
 */
function vehicleOptionLabel(v: VehicleDto, requestCategoryId: string | null): string {
  const title = vehicleLabel(v);
  const extra = [
    v.ownership === 'own' ? v.modelName : null,
    v.categoryName,
    vehicleCategoryMismatch(requestCategoryId, v.vehicleCategoryId)
      ? VEHICLE_CATEGORY_MISMATCH_HINT
      : requestCategoryId && !v.vehicleCategoryId
        ? 'категория не указана'
        : null,
    assignmentRateLabel(v) || null,
  ].filter((s): s is string => !!s && s !== title);
  return extra.length > 0 ? `${title} — ${extra.join(' · ')}` : title;
}

export function VehicleAssignModal({
  request,
  mode = 'confirm',
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<FormValues>();
  const [ownership, setOwnership] = useState<VehicleOwnership>('own');
  /** Смена машины у работающей заявки (ADR 0048): срок не спрашивается — он уже согласован. */
  const reassign = mode === 'reassign';

  // Вся техника заказанного типа одним запросом: обе ветки принадлежности нужны сразу — по их
  // наполнению подписан сам переключатель («Аренда — 12»), а списки невелики (сужены типом ТС).
  // Запрашивается тип, и только тип: категория заявки (ADR 0028) списка не сужает (ADR 0045).
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
  const vehicles = useMemo(() => data?.items ?? [], [data]);
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
    // Срок подставляется заказанным: обычно на него и выходят, а правят его в меньшинстве случаев.
    // Подача переводится в МСК: в браузере восточнее Москвы «09:00 по Москве» иначе стало бы
    // «12:00». Именно `dayjs(iso).tz(...)`, а не `dayjs.tz(iso, ...)`: второй читает строку как
    // время уже в этой зоне и молча теряет смещение, приехавшее с сервера.
    const scheduled =
      request.requestType === 'freight_transport' ? dayjs(request.scheduledAt).tz(MOSCOW_TZ) : null;
    form.setFieldsValue({
      dateFrom: request.requestType === 'special_equipment' ? dayjs(request.dateFrom) : null,
      dateTo:
        request.requestType === 'special_equipment' && request.dateTo
          ? dayjs(request.dateTo)
          : null,
      scheduledDate: scheduled,
      // Заявка «на дату» открывается с пустым временем: здесь его и назначают.
      scheduledTime:
        request.requestType === 'freight_transport' && !request.scheduledTimeUnspecified
          ? scheduled!.format('HH:mm')
          : undefined,
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
  const scheduledDate = Form.useWatch('scheduledDate', form);
  const driverPersonId = Form.useWatch('driverPersonId', form);

  const isFreight = request?.requestType === 'freight_transport';

  /** Арендодатели — только те, у кого есть техника этого типа: пустой пункт выбирать незачем. */
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
    return list.map((v) => ({ value: v.id, label: vehicleOptionLabel(v, categoryId) }));
  }, [ownership, lessorId, byOwnership, categoryId]);

  const selected = vehicles.find((v) => v.id === vehicleId) ?? null;
  const isRental = ownership === 'rental';

  /** Заказанная позиция классификатора (ADR 0028) — ею подписано окно и с ней сверяют выбор. */
  const orderedLabel = request
    ? vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      })
    : '';

  /**
   * Взяли машину не заказанной категории (ADR 0045). Не запрет: заявку закрывают тем, что есть в
   * парке. Но пометки в строке списка мало — её читают при выборе и забывают, а предупреждение
   * под полем остаётся на виду до самого нажатия «Взять в работу».
   */
  const categoryMismatch =
    selected && vehicleCategoryMismatch(categoryId, selected.vehicleCategoryId)
      ? vehicleCategoryMismatchWarning(orderedLabel, selected.categoryName ?? '')
      : null;

  // ── Маршрут (рейс машины на дату) ──
  // Перевод в работу не выписывает документ: он кладёт заявку в рейс — в готовый рейс этой машины
  // на эту дату либо в новый, заведённый тут же. Лист выписывают с рейса, когда состав собран.
  //
  // Спрашивается по машине: у аренды рейса нет — лист на неё выписывает арендодатель. У заказа
  // техники на объект не спрашивается вовсе (ADR 0041): там нет рейса, есть период работы машины
  // на площадке, и объяснять отсутствие блока нечем — документа в этом процессе не существует.
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const routeId = Form.useWatch('routeId', form);
  const { data: prefill } = useQuery({
    queryKey: ['route-prefill', targetId, vehicleId],
    queryFn: () => vehicleRequestsApi.routePrefill(targetId!, vehicleId!),
    enabled: isFreight && !!targetId && !!vehicleId,
  });
  const needsRoute = prefill?.required ?? false;
  /** Рейсы этой машины на эту дату, где ещё остался свободный талон. */
  const routeOptions = (prefill?.routes ?? []).filter(
    (r) => r.requests.length < MAX_ROUTE_REQUESTS,
  );
  /** Выбран готовый рейс: водитель и реквизиты выезда в нём уже свои, спрашивать их незачем. */
  const joiningRoute = !!routeId && routeId !== NEW_ROUTE;

  /**
   * Дата рейса для отбора водителей и подписи листа. У грузоперевозки её несёт подача — и берётся
   * она из формы, а не из ответа сервера: время правят прямо здесь, и годность удостоверения
   * обязана проверяться на тот день, на который машина выйдет. У прочих заявок дата листа — день
   * перевода в работу (ADR 0037), его и считает сервер.
   */
  // При смене техники (ADR 0048) срок не правят, и дату рейса целиком считает сервер: в форме
  // поля подачи нет, а брать её из невидимого значения значило бы зависеть от того, что осталось
  // в форме от прошлого открытия.
  const tripDate =
    isFreight && !reassign
      ? (scheduledDate?.format('YYYY-MM-DD') ?? prefill?.tripDate)
      : prefill?.tripDate;

  // Список водителей — тот же отбор, что проверит сервер: годные к этой машине на дату рейса.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, tripDate, withTrailer],
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: tripDate!, withTrailer }),
    enabled: needsRoute && !joiningRoute && !!vehicleId && !!tripDate,
  });
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      d.personnelNo && `таб. ${d.personnelNo}`,
      d.verificationStatus === 'unverified' ? 'документ не проверен' : null,
      licenseRequisitesMissing(d.licenseNumber) ? LICENSE_REQUISITES_MISSING_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  /**
   * Выбран водитель без серии и номера удостоверения. Пометки в строке списка мало: её читают
   * при выборе и забывают, а последствие наступает у того, кто возьмёт напечатанный лист.
   */
  const driverRequisitesMissing = selection?.drivers.some(
    (d) => d.personId === driverPersonId && licenseRequisitesMissing(d.licenseNumber),
  );

  /**
   * Рейс подставляется сам: если у машины на этот день уже есть рейс со свободным талоном, заявка
   * поедет в него — так диспетчер и работает, собирая день машины. Пусто — заводится новый.
   */
  useEffect(() => {
    if (!needsRoute) return;
    form.setFieldsValue({ routeId: routeOptions[0]?.id ?? NEW_ROUTE });
  }, [needsRoute, prefill?.routes]);

  /** Графы шапки наследуются от прошлого рейса этой машины — их правят раз в сезон, а не в рейс. */
  useEffect(() => {
    if (!prefill?.trip) return;
    form.setFieldsValue({
      withTrailer: prefill.trip.withTrailer,
      trailer1Model: prefill.trip.trailer1Model,
      trailer1RegNumber: prefill.trip.trailer1RegNumber,
      garageNumber: prefill.trip.garageNumber,
      communicationKind: prefill.trip.communicationKind,
      transportationKind: prefill.trip.transportationKind,
    });
  }, [prefill?.trip]);

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

  /**
   * Фактический срок в том виде, в каком его принимает API. Время подачи собирается по МСК — в
   * этом поясе живут и заявка, и путевой лист; пустое время означает подачу «на дату», как и при
   * заведении заявки.
   */
  const scheduleOf = (v: FormValues): ConfirmScheduleBody | null => {
    if (!request) return null;
    if (request.requestType === 'special_equipment') {
      if (!v.dateFrom) return null;
      return {
        requestType: 'special_equipment',
        dateFrom: v.dateFrom.format('YYYY-MM-DD'),
        dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
      };
    }
    if (!v.scheduledDate) return null;
    const time = normalizeTimeInput(v.scheduledTime ?? '');
    return {
      requestType: 'freight_transport',
      scheduledAt: dayjs
        .tz(`${v.scheduledDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ'),
      scheduledTimeUnspecified: time === undefined,
    };
  };

  const submit = (v: FormValues) => {
    // Срок уточняют только при переводе в работу: у работающей заявки он уже согласован, и
    // смена машины его не трогает (ADR 0048) — сервер `schedule` вне перевода и не примет.
    const schedule = reassign ? null : scheduleOf(v);
    if (!reassign && !schedule) {
      message.warning('Укажите фактическую дату');
      return;
    }
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
    if (needsRoute && v.routeId === NEW_ROUTE && !v.driverPersonId) {
      message.warning('Выберите водителя — на рейс выписывается путевой лист');
      return;
    }
    onSubmit({
      assignment: {
        vehicleId: v.vehicleId,
        pricePerHour: v.pricePerHour ?? null,
        pricePerShift: v.pricePerShift ?? null,
        shiftHours: v.shiftHours ?? null,
        // Рейс: готовый — одним идентификатором, новый — вместе с водителем и реквизитами выезда.
        ...(needsRoute
          ? {
              route:
                v.routeId && v.routeId !== NEW_ROUTE
                  ? { routeId: v.routeId }
                  : {
                      newRoute: {
                        driverPersonId: v.driverPersonId,
                        trip: {
                          withTrailer: v.withTrailer ?? false,
                          trailer1Model: v.withTrailer ? (v.trailer1Model ?? '') : '',
                          trailer1RegNumber: v.withTrailer ? (v.trailer1RegNumber ?? '') : '',
                          garageNumber: v.garageNumber ?? '',
                          communicationKind: v.communicationKind ?? '',
                          transportationKind: v.transportationKind ?? '',
                        },
                      },
                    },
            }
          : {}),
      },
      schedule,
    });
  };

  // Пусто — значит пусто по типу ТС: категория список не сужает (ADR 0045), и обещать, что
  // техника найдётся в соседней категории, нечем.
  const emptyText = isFetching
    ? 'Загружаем технику…'
    : ownership === 'own'
      ? 'Собственной техники этого типа нет — возьмите её в аренду'
      : lessorId
        ? 'У этого арендодателя нет предложений этого типа'
        : 'Предложений аренды этого типа нет';

  return (
    <FormModal
      title={request ? `В работу: заявка ${request.displayNumber}` : 'В работу'}
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Взять в работу"
      width={880}
    >
      {request && (
        // Поля парами (FormGrid): окно спрашивает срок, технику, ставки и графы путевого листа —
        // в одну колонку половина из них уходила под прокрутку. На телефоне колонка одна.
        <Form form={form} layout="vertical" onFinish={submit}>
          <FormGrid>
            <FormGrid.Full>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                {requestCustomerName(request)} · заказано «{orderedLabel}»
              </Typography.Paragraph>
            </FormGrid.Full>

            {/* Фактический срок: подставлен заказанным, под полями — что просили изначально.
              Спрашивается первым, потому что от даты рейса зависит отбор водителей ниже. */}
            {request.requestType === 'special_equipment' ? (
              <>
                <Form.Item
                  name="dateFrom"
                  label="Фактическая дата начала"
                  rules={[{ required: true, message: 'Укажите дату начала' }]}
                  extra={`Заказано: ${formatDateOnly(request.dateFrom)}`}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                  />
                </Form.Item>
                <Form.Item
                  name="dateTo"
                  label="Фактическая дата окончания"
                  extra={
                    request.dateTo
                      ? `Заказано: ${formatDateOnly(request.dateTo)}`
                      : 'Заказан один день'
                  }
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                  />
                </Form.Item>
              </>
            ) : (
              <>
                <Form.Item
                  name="scheduledDate"
                  label="Фактическая дата подачи"
                  rules={[{ required: true, message: 'Укажите дату подачи' }]}
                  extra={`Заказано: ${formatMoscowDateTime(
                    new Date(request.scheduledAt),
                    request.scheduledTimeUnspecified,
                  )}`}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                  />
                </Form.Item>
                <Form.Item
                  name="scheduledTime"
                  label="Фактическое время (МСК)"
                  tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
                  rules={[optionalWorkTimeRule]}
                >
                  <TimeInput />
                </Form.Item>
              </>
            )}

            {/* Шаг 1: чья машина. Количество единиц этого типа — в самой подписи: пустая ветка
              видна до того, как в неё зайдут. */}
            {/* Не поле формы: принадлежность в назначение не уходит — она у самой машины, а
              здесь только сужает список. */}
            <FormGrid.Full>
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
            </FormGrid.Full>

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

            {/* Шаг 3: конкретная единица. Расхождение с заказанной категорией — подстрочным
              предупреждением (ADR 0045): назначение оно не отменяет, но и незамеченным не
              проходит. */}
            <Form.Item
              name="vehicleId"
              label="Конкретная техника"
              rules={[{ required: true, message: 'Выберите технику' }]}
              extra={
                categoryMismatch ? (
                  <Typography.Text type="warning">{categoryMismatch}</Typography.Text>
                ) : vehicleOptions.length === 0 ? (
                  emptyText
                ) : undefined
              }
            >
              <AutoSelect
                options={vehicleOptions}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={isRental && !lessorId}
                placeholder={
                  isRental && !lessorId ? 'Сначала выберите арендодателя' : 'Выберите ТС'
                }
                onChange={changeVehicle}
              />
            </Form.Item>

            {selected && (
              <FormGrid.Full>
                <Space size={8} wrap style={{ marginBottom: 16 }}>
                  {selected.categoryName && (
                    <Tag color={categoryMismatch ? 'orange' : 'blue'}>{selected.categoryName}</Tag>
                  )}
                  {selected.registrationNumber && <Tag>{selected.registrationNumber}</Tag>}
                  {selected.lessorName && <Tag color="purple">{selected.lessorName}</Tag>}
                </Space>
              </FormGrid.Full>
            )}

            {/* Ставки: подставлены из справочника, но это поля ввода — цену по заявке
              согласовывают отдельно от прайса. */}
            <>
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
            </>

            <FormGrid.Full>
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
            </FormGrid.Full>

            {/* Маршрут: заявка едет рейсом, а не документом. Причина, по которой рейс не ведётся,
              показывается текстом — отсутствие блока читалось бы как поломка. У заказа техники на
              объект блока нет и текста нет: `prefill` для такой заявки не запрашивается вовсе, и
              упоминать рейс, которого в этом процессе не существует, не о чем (ADR 0041). */}
            {selected && prefill && !prefill.required && prefill.reason && (
              <FormGrid.Full>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 16 }}
                  message="Маршрут не ведётся"
                  description={prefill.reason}
                />
              </FormGrid.Full>
            )}

            {needsRoute && (
              <>
                <FormGrid.Full>
                  <Typography.Title level={5} style={{ marginTop: 16 }}>
                    Маршрут
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
                    Рейс на {tripDate}. Путевой лист выписывается с маршрута, когда состав собран —
                    {prefill?.formLabel
                      ? ` ${prefill.formLabel.toLowerCase()}`
                      : ' по бланку рейса'}
                    .
                  </Typography.Paragraph>
                </FormGrid.Full>

                {/* Готовый рейс этой машины на эту дату — обычный ход дня: машина уже вышла, и
                  вторая заявка дописывается к тому же рейсу талоном. Новый заводится, когда рейса
                  ещё нет или свободных талонов не осталось. */}
                <FormGrid.Full>
                  <Form.Item name="routeId" label="Рейс">
                    <AutoSelect
                      options={[
                        ...routeOptions.map((r) => ({
                          value: r.id,
                          label: [
                            r.displayNumber,
                            r.driverName || 'водитель не назначен',
                            `${r.requests.length} из ${MAX_ROUTE_REQUESTS} талонов`,
                          ].join(' · '),
                        })),
                        { value: NEW_ROUTE, label: 'Новый маршрут' },
                      ]}
                      placeholder="Выберите рейс"
                    />
                  </Form.Item>
                </FormGrid.Full>

                {joiningRoute && (
                  <FormGrid.Full>
                    <Typography.Text type="secondary">
                      Водитель и реквизиты выезда берутся из выбранного рейса — их правят в карточке
                      маршрута.
                    </Typography.Text>
                  </FormGrid.Full>
                )}

                {!joiningRoute && (
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
                )}

                {!joiningRoute && driverRequisitesMissing && (
                  <FormGrid.Full>
                    <Alert
                      type="warning"
                      showIcon
                      message="Лист напечатается без номера удостоверения"
                      description={LICENSE_REQUISITES_MISSING_WARNING}
                    />
                  </FormGrid.Full>
                )}

                {/* Реквизиты выезда — свойства рейса: у готового они уже свои, и переспрашивать их
                  здесь значило бы молча переписать чужой рейс. Прицеп поднимает требуемую
                  категорию водителя, поэтому список выше пересобирается при его включении. */}
                {!joiningRoute && (
                  <>
                    <Form.Item name="withTrailer" valuePropName="checked">
                      <Checkbox>Рейс с прицепом</Checkbox>
                    </Form.Item>
                    {withTrailer && (
                      <>
                        <Form.Item name="trailer1Model" label="Марка прицепа">
                          <Input placeholder="МАЗ-8926" />
                        </Form.Item>
                        <Form.Item name="trailer1RegNumber" label="Госномер прицепа">
                          <Input placeholder="8062 ЕН 77" />
                        </Form.Item>
                      </>
                    )}

                    <Form.Item name="garageNumber" label="Гаражный номер">
                      <Input placeholder="00000389" />
                    </Form.Item>
                    <Form.Item name="communicationKind" label="Вид сообщения">
                      <Input placeholder="пригородное" />
                    </Form.Item>
                    <Form.Item name="transportationKind" label="Вид перевозки">
                      <Input placeholder="коммерческая" />
                    </Form.Item>
                  </>
                )}
              </>
            )}
          </FormGrid>
        </Form>
      )}
    </FormModal>
  );
}
