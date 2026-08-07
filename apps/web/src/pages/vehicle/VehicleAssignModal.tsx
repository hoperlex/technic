import { useEffect, useMemo, useRef, useState } from 'react';
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
  assignmentTitle,
  type ConfirmScheduleBody,
  DRIVER_CATEGORY_MISMATCH_HINT,
  driverCategoryMismatchWarning,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverWorkedOnVehicle,
  formatMoscowDateTime,
  isRouteEditable,
  routeRequestCapacity,
  normalizeTimeInput,
  VEHICLE_OWNERSHIPS,
  requestCustomerName,
  vehicleClassificationLabel,
  type VehicleDto,
  type VehicleOwnership,
  vehicleLabel,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
  type VehicleSubstitution,
  vehicleSubstitutionGroup,
  vehicleSubstitutionGroupLabels,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
  esm2Periods,
  vehicleSubstitutionRank,
  vehicleSubstitutionWarning,
  driverDocumentGapsHint,
  driverDocumentGapsWarning,
  waybillFormLabels,
  waybillFormShortLabels,
  waybillRequirement,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi, vehicleRoutesApi, vehiclesApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { useIsMobile } from '@shared/lib';
import { useObjectScope } from '../../hooks/useObjectScope';
import { AddressField } from '@features/address-input';

import { formatMoney } from '../../utils/format';
import { formatDateOnly } from './shared';
import { MOSCOW_TZ } from '@shared/config';

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
 * Список не сужен ничем: ни заказанной категорией (ADR 0045), ни типом (ADR 0059), ни видом ТС
 * (ADR 0064). Заказывали «Автокран, г/п 130 т» — в списке будут и 25-тонный автокран, и самоходный
 * кран на 200 т, и, ниже всех, самосвал. Подходит ли соседняя позиция классификатора, решает
 * диспетчер: он знает и парк, и то, о чём договорились с заказчиком, — а справочник заполнен
 * неровно, и запрет по нему прятал бы машину, которой работу и делают. Расхождение называется
 * прямо — группой в списке («Крупнее заказанного», «Другой вид техники»), пометкой в строке и
 * предупреждением под полем, — но выбор не отнимает.
 *
 * Так же устроен и выбор водителя (ADR 0064): в списке весь справочник, включая тех, у кого не
 * внесены СНИЛС или реквизиты удостоверения. Такой водитель стоит ниже, помечен в строке, а под
 * полем сказано, какие графы бланка из-за этого останутся пустыми.
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
  /**
   * Машинист заказа техники на объект: на него выписываются недельные листы ЭСМ-2 (миграция
   * 0087). Отдельное поле, а не `driverPersonId`: тот — водитель рейса грузоперевозки, отобранный
   * по документам и категории под машину, а здесь годится любой водитель справочника.
   */
  machinistId?: string;
  // ── Доставка техники на объект: перегон по желанию (миграция 0082) ──
  /** Спецтехника едет на площадку своим ходом — на эту поездку выписывается 4-П. */
  deliveryEnabled?: boolean;
  deliveryDate?: Dayjs | null;
  deliveryDriverId?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
}

/**
 * Строка выбора: подпись машины плюс то, чем одна единица отличается от другой. Тип и категория —
 * первое, чем они различаются в списке вида, поэтому у собственной машины позиция классификатора
 * стоит рядом с моделью, а не вместо неё. Расхождение с заказанным проговаривается прямо в строке
 * и с направлением («крупнее», «меньше заказанного»): подходит ли эта машина, решает человек — по
 * названию модели и по тому, что он о ней знает.
 */
function vehicleOptionLabel(v: VehicleDto, substitution: VehicleSubstitution): string {
  const title = vehicleLabel(v);
  const extra = [
    v.ownership === 'own' ? v.modelName : null,
    // Наименование категории уже содержит тип (ADR 0016 §11); без категории тип называется сам.
    v.categoryName ?? v.typeName,
    vehicleSubstitutionHint(substitution),
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

  /** Первыми в списке мест перегона — площадка заявки и площадки учётки (ADR 0069). */
  const { ownObjectIds } = useObjectScope();
  const suggestObjectIds = useMemo(
    () => [request?.objectId, ...ownObjectIds].filter((id): id is string => !!id),
    [request?.objectId, ownObjectIds],
  );

  // Весь активный парк, а не техника заказанного вида (ADR 0064): классификация список больше не
  // сужает — ни категорией (ADR 0045), ни типом (ADR 0059), ни видом. Обе ветки принадлежности
  // нужны сразу — по их наполнению подписан сам переключатель («Аренда — 12»).
  //
  // Двумя запросами, а не одним: страница списка ограничена 500 строками, и в парке, который в неё
  // не помещается, обрезалось бы как раз заказанное. Первый запрос берёт заказанный вид целиком —
  // это то, чем заявку закрывают в девяти случаях из десяти; второй добирает остальное, и его
  // неполнота названа под полем прямо.
  const vehicleTypeId = request?.vehicleTypeId ?? null;
  const vehicleKindId = request?.vehicleKindId ?? null;
  const categoryId = request?.vehicleCategoryId ?? null;
  /** Заказанная позиция — левая сторона всех сравнений в этом окне. */
  const ordered = useMemo(
    () =>
      request
        ? {
            vehicleKindId: request.vehicleKindId,
            vehicleTypeId: request.vehicleTypeId,
            vehicleCategoryId: request.vehicleCategoryId,
            categorySpecs: request.vehicleCategorySpecs,
          }
        : null,
    [request?.id, vehicleTypeId, categoryId],
  );
  const listParams = {
    status: 'active',
    page: 1,
    pageSize: 500,
    sortBy: 'lessorName',
    sortOrder: 'asc',
  } as const;
  const ofKind = useQuery({
    queryKey: ['vehicles', 'for-assignment', vehicleKindId],
    queryFn: () => vehiclesApi.list({ ...listParams, vehicleKindId: vehicleKindId! }),
    enabled: !!vehicleKindId,
  });
  const wholeFleet = useQuery({
    queryKey: ['vehicles', 'for-assignment', 'all'],
    queryFn: () => vehiclesApi.list(listParams),
    enabled: !!request,
  });
  const isFetching = ofKind.isFetching || wholeFleet.isFetching;
  const vehicles = useMemo(() => {
    const byId = new Map<string, VehicleDto>();
    for (const v of [...(ofKind.data?.items ?? []), ...(wholeFleet.data?.items ?? [])]) {
      byId.set(v.id, v);
    }
    return [...byId.values()];
  }, [ofKind.data, wholeFleet.data]);
  /**
   * Сколько машин чужих видов в страницу не поместилось. Молчать об этом нельзя: поиск в поле
   * ищет по загруженным строкам, и ненайденная машина выглядела бы отсутствующей в парке.
   */
  const hiddenVehicles = Math.max(
    0,
    (wholeFleet.data?.total ?? 0) - (wholeFleet.data?.items.length ?? 0),
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
  // Срок работ спецтехники: по нему считаются недели, на которые выпишутся листы ЭСМ-2.
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);

  const isFreight = request?.requestType === 'freight_transport';

  /** Арендодатели — только те, у кого есть техника этого вида: пустой пункт выбирать незачем. */
  const lessorOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const v of byOwnership.rental) {
      if (v.lessorId) byId.set(v.lessorId, v.lessorName ?? '—');
    }
    return [...byId]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [byOwnership.rental]);

  /**
   * Список техники группами: заказанный тип → крупнее → другие типы вида → меньше заказанного →
   * другой вид техники (ADR 0059, ADR 0064). Порядок и есть ответ на «чем закрыть заявку»: наверху
   * соответствие, ниже близкое к нему, в самом низу далёкое. Внутри группы — по алфавиту: строки
   * там равноценны, и всякий другой порядок пришлось бы объяснять.
   *
   * Переключателя «показать другие виды» нет — лишнее состояние формы там, где хватает порядка
   * строк, а поиск по строке идёт по всем группам сразу.
   */
  const vehicleOptions = useMemo(() => {
    if (!ordered) return [];
    const list =
      ownership === 'own'
        ? byOwnership.own
        : byOwnership.rental.filter((v) => !lessorId || v.lessorId === lessorId);
    const groups = new Map<
      number,
      { label: string; options: { value: string; label: string }[] }
    >();
    for (const v of list) {
      const substitution = vehicleSubstitutionOf(ordered, v);
      const rank = vehicleSubstitutionRank(substitution);
      const group = groups.get(rank) ?? {
        label: vehicleSubstitutionGroupLabels[vehicleSubstitutionGroup(substitution)],
        options: [],
      };
      group.options.push({ value: v.id, label: vehicleOptionLabel(v, substitution) });
      groups.set(rank, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, group]) => ({
        ...group,
        options: group.options.sort((a, b) => a.label.localeCompare(b.label, 'ru')),
      }));
  }, [ownership, lessorId, byOwnership, ordered]);

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
   * Взяли не то, что заказывали, — другой тип или другую категорию (ADR 0045, ADR 0059). Не
   * запрет: заявку закрывают тем, что есть в парке. Но пометки в строке списка мало — её читают
   * при выборе и забывают, а предупреждение под полем остаётся на виду до самого нажатия «Взять в
   * работу». Уровень зависит от направления: техника меньше заказанной — жёлтое предупреждение,
   * крупнее или «сравнить нечем» — нейтральная справка.
   */
  const substitution =
    ordered && selected
      ? vehicleSubstitutionWarning({
          substitution: vehicleSubstitutionOf(ordered, selected),
          orderedLabel,
          actualTypeName: selected.typeName,
          actualCategoryName: selected.categoryName,
        })
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

  /**
   * Доставка техники на объект (миграция 0082). Спецтехника доезжает до площадки по городу своим
   * ходом, и на эту поездку выписывается 4-П — но повезти её могут и тралом, поэтому перегон
   * предлагается, а не требуется. Способ доставки портал не ведёт: он ни на что здесь не влияет.
   *
   * Только своя техника: перегон арендной — забота арендодателя, он же выписывает на неё лист.
   */
  const deliveryEnabled = Form.useWatch('deliveryEnabled', form) ?? false;
  const deliveryDate = Form.useWatch('deliveryDate', form);
  const canOfferDelivery = !reassign && request?.requestType === 'special_equipment' && !isRental;
  const wantsDelivery = canOfferDelivery && deliveryEnabled;

  /**
   * Включение подставляет площадку заявки — место, а не дату: адрес объекта у заявки один, и
   * другого «куда» у доставки не бывает.
   *
   * Дата перегона не подставляется: техника приезжает и накануне, и через день после начала
   * работ, а подставленное начало срока читается как уже принятое решение — его пролистывают, и
   * в путевой лист уходит день, в который никто никуда не ехал.
   */
  const toggleDelivery = (on: boolean) => {
    if (!on) return;
    const v = form.getFieldsValue();
    form.setFieldsValue({
      deliveryTo: v.deliveryTo || request?.objectAddress || request?.objectName || '',
    });
  };

  /**
   * Дата рейса для подсказки, отбора водителей и подписи листа. У грузоперевозки её несёт подача —
   * и берётся она из формы, а не из ответа сервера: время правят прямо здесь, и годность
   * удостоверения обязана проверяться на тот день, на который машина выйдет. У прочих заявок дата
   * листа — день перевода в работу (ADR 0037), его и считает сервер.
   */
  // При смене техники (ADR 0048) срок не правят, и дату рейса целиком считает сервер: в форме
  // поля подачи нет, а брать её из невидимого значения значило бы зависеть от того, что осталось
  // в форме от прошлого открытия.
  const formTripDate = isFreight && !reassign ? scheduledDate?.format('YYYY-MM-DD') : undefined;

  /**
   * Подсказка рейсов — по типу заказанной техники и без машины (ADR 0052): день планируют с
   * вопроса «каким рейсом заявка поедет», а машину задаёт сам рейс. Ответ не зависит от выбранной
   * единицы, поэтому список не пересобирается под каждый клик и не спорит с уже выбранным рейсом.
   */
  const { data: prefill } = useQuery({
    queryKey: ['route-prefill', targetId, formTripDate],
    queryFn: () => vehicleRequestsApi.routePrefill(targetId!, { date: formTripDate }),
    enabled: isFreight && !!targetId,
  });
  const tripDate = formTripDate ?? prefill?.tripDate;

  /**
   * Ведётся ли рейс — правилом из контрактов, а не вторым запросом: бланк закреплён за типом ТС,
   * а принадлежность известна из выбранной машины. Так причина «маршрут не ведётся» появляется в
   * тот же миг, когда выбрана арендная единица.
   *
   * Бланк спрашивается у **выбранной машины**, а не у заказанного типа (ADR 0059): лист выпишется
   * по той единице, которая поедет, и у легковой это форма № 3 там, где у самосвала 4-П. Пока
   * машина не выбрана, отвечает заказанный тип — его бланк и принёс `prefill`.
   *
   * До ответа `prefill` блок маршрута не поднимается, даже если бланк уже известен по машине:
   * поле «Рейс» подставляет единственный доступный вариант (`AutoSelect`), и на пустой подсказке
   * этим вариантом оказался бы «Новый маршрут» — выбор считался бы сделанным вручную, а
   * приехавший следом готовый рейс машины его уже не перебил бы.
   */
  // Бланк известен всегда, когда машина выбрана: у типа он обязателен. Пустым он остаётся у
  // заказанного типа, который листа не знает вовсе, — тогда и спрашивать правило не о чем.
  const formCode = selected?.waybillFormCode ?? prefill?.formCode ?? null;
  const requirement =
    request && isFreight && prefill && formCode
      ? waybillRequirement({
          requestType: request.requestType,
          ownership: selected?.ownership ?? ownership,
          formCode,
        })
      : { formCode: null, reason: null };
  const needsRoute = !!requirement.formCode;

  /**
   * Машина другого типа печатает другой бланк. Называется отдельной строкой: смена документа —
   * не мелочь оформления, у формы № 3 нет ни талонов заказчиков, ни граф прицепа, и диспетчер
   * должен узнать об этом до нажатия, а не при выписке листа.
   */
  const formChange =
    isFreight && selected && prefill?.formCode && requirement.formCode !== prefill.formCode
      ? `Лист выпишется по бланку ${waybillFormLabels[requirement.formCode!]} — по типу выбранной машины, а не заказанного`
      : null;

  /**
   * Рейсы, куда заявку можно положить: со свободной строкой задания и не замороженные выписанным
   * листом.
   * Заморозка проверяется тем же правилом, что и на сервере, — иначе список предлагал бы рейсы,
   * которые он отклонит.
   */
  const routeOptions = (prefill?.routes ?? []).filter(
    (r) =>
      r.requests.length < routeRequestCapacity(r.formCode) &&
      isRouteEditable(r.waybill?.status ?? null),
  );
  /** Выбран готовый рейс: водитель и реквизиты выезда в нём уже свои, спрашивать их незачем. */
  const joiningRoute = !!routeId && routeId !== NEW_ROUTE;
  const joinedRoute = routeOptions.find((r) => r.id === routeId) ?? null;

  /** Графы шапки от прошлого рейса выбранной машины — они нужны только новому рейсу. */
  const { data: suggestion } = useQuery({
    queryKey: ['vehicle-routes', 'suggest', vehicleId, tripDate],
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: tripDate! }),
    enabled: needsRoute && !joiningRoute && !!vehicleId && !!tripDate,
  });

  // Список водителей — весь справочник (ADR 0064): ни категория, ни полнота документов из него
  // никого не убирают, обе помечают строку и объясняются предупреждением под полем.
  // Дата, на которую считается годность: у рейса — день подачи, у перегона — день, когда технику
  // повезут. Даты разные, и водитель, годный сегодня, завтра может быть с истёкшим удостоверением.
  const driverDate = needsRoute
    ? tripDate
    : wantsDelivery
      ? deliveryDate?.format('YYYY-MM-DD')
      : undefined;
  const driversNeeded = (needsRoute && !joiningRoute) || wantsDelivery;
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, driverDate, withTrailer],
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: driverDate!, withTrailer }),
    enabled: driversNeeded && !!vehicleId && !!driverDate,
  });
  // Порядок задал сервер: пригодные первыми — сперва комплект документов, затем категория
  // (ADR 0064, ADR 0055), внутри них работавшие на этой машине (ADR 0056). Пометки в строке
  // объясняют, почему человек там, — без них список выглядел бы сбитым алфавитом.
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      d.personnelNo && `таб. ${d.personnelNo}`,
      driverDocumentGapsHint(d.gaps),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
      d.verificationStatus === 'unverified' ? 'документ не проверен' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  /**
   * Машинисты для листов ЭСМ-2 (миграция 0087) — весь справочник водителей, без единого отбора.
   *
   * Это не тот же список, что выше, и намеренно. `drivers/available` требует непустой СНИЛС,
   * годное на дату удостоверение и смотрит на категорию под машину — всё это графы 4-П, без
   * которых тот лист недействителен. В бланке ЭСМ-2 их нет вовсе: экскаваторщик работает по
   * удостоверению тракториста-машиниста, которого портал не ведёт (ADR 0055). Поэтому годится
   * любой действующий водитель, и ни машина, ни дата на список не влияют.
   */
  const needsMachinist = !reassign && request?.requestType === 'special_equipment' && !isRental;
  const { data: machinists, isFetching: machinistsLoading } = useQuery({
    queryKey: ['drivers', 'machinists'],
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortDir: 'asc' }),
    enabled: needsMachinist,
  });
  const machinistOptions = (machinists?.items ?? []).map((d) => ({
    value: d.id,
    label: [d.fullName, d.personnelNo && `таб. ${d.personnelNo}`].filter(Boolean).join(' · '),
  }));

  /**
   * Сколько бланков израсходует перевод в работу и на какие недели: лист ЭСМ-2 выписывается на
   * каждую неделю срока (миграция 0087), и человек должен видеть это до нажатия, а не узнавать
   * из журнала. Считается тем же `esm2Periods`, которым выписывает сервер.
   */
  const esm2Weeks = useMemo(() => {
    if (!needsMachinist) return [];
    const from = dateFrom?.format('YYYY-MM-DD');
    if (!from) return [];
    return esm2Periods(from, dateTo?.format('YYYY-MM-DD') ?? null);
  }, [needsMachinist, dateFrom, dateTo]);

  /**
   * Что не так с выбранным водителем: нет категории, которой требует машина, и/или не внесены
   * документы, которые печатает бланк. Пометки в строке списка мало — её читают при выборе и
   * забывают, — а решение садить человека остаётся за диспетчером (ADR 0055, ADR 0064): портал
   * ничего не запрещает, но обе стороны расхождения обязан назвать.
   *
   * Пробелы документов названы вместе с бланком: пустая графа в 4-П и пустая графа в форме № 3 —
   * разные графы, и «касается ли это меня» человек должен понять не выходя из окна.
   */
  const selectedDriver = selection?.drivers.find((d) => d.personId === driverPersonId);
  const driverCategoryMismatch =
    selection?.requiredCategory && selectedDriver && !selectedDriver.matchesRequiredCategory
      ? driverCategoryMismatchWarning(selection.requiredCategory, selectedDriver.categories)
      : null;
  const driverGaps = selectedDriver
    ? driverDocumentGapsWarning(
        selectedDriver.gaps,
        requirement.formCode ? waybillFormShortLabels[requirement.formCode] : null,
      )
    : null;
  /** Тот же вопрос про водителя перегона: лист по нему — всегда 4-П (миграция 0082). */
  const deliveryDriverId = Form.useWatch('deliveryDriverId', form);
  const deliveryDriver = selection?.drivers.find((d) => d.personId === deliveryDriverId);
  const deliveryDriverGaps =
    wantsDelivery && deliveryDriver
      ? driverDocumentGapsWarning(deliveryDriver.gaps, waybillFormShortLabels['4p'])
      : null;

  /**
   * Рейс подставляется сам только под уже известную машину: у назначенной единицы (повторный
   * перевод в работу после отката, смена техники) заявка поедет её сегодняшним рейсом. Пока
   * машина не выбрана, поле стоит на «Новом маршруте»: подставленный рейс выбрал бы и машину, а
   * её выбирает человек (ADR 0052).
   *
   * Ручной выбор рейса подстановка не трогает: `routeTouched` взводится первым же изменением
   * поля, и пришедший позже ответ сервера не переписывает выбранное.
   */
  const routeTouched = useRef(false);
  useEffect(() => {
    routeTouched.current = false;
  }, [targetId]);

  useEffect(() => {
    if (!needsRoute) return;
    // Выбранный рейс пропал из подсказки — правили дату подачи, и рейсы теперь другого дня.
    // Молча оставить его нельзя: поле показывало бы рейс, которого сервер в этот день не знает.
    const current = form.getFieldValue('routeId');
    if (current && current !== NEW_ROUTE && !routeOptions.some((r) => r.id === current)) {
      form.setFieldsValue({ routeId: NEW_ROUTE });
      return;
    }
    if (routeTouched.current) return;
    const own = vehicleId ? routeOptions.find((r) => r.vehicleId === vehicleId) : null;
    form.setFieldsValue({ routeId: own?.id ?? NEW_ROUTE });
  }, [needsRoute, vehicleId, prefill?.routes]);

  /** Графы шапки наследуются от прошлого рейса этой машины — их правят раз в сезон, а не в рейс. */
  useEffect(() => {
    const trip = suggestion?.trip;
    if (!trip) return;
    form.setFieldsValue({
      withTrailer: trip.withTrailer,
      trailer1Model: trip.trailer1Model,
      trailer1RegNumber: trip.trailer1RegNumber,
      garageNumber: trip.garageNumber,
      communicationKind: trip.communicationKind,
      transportationKind: trip.transportationKind,
    });
  }, [suggestion?.trip]);

  /** Ставки предложения аренды: по ним подставляются поля и видно, что цену изменили вручную. */
  const listedRate = selected?.ownership === 'rental' ? selected : null;
  const priceChanged =
    !!listedRate &&
    ((pricePerHour ?? null) !== (listedRate.pricePerHour ?? null) ||
      (pricePerShift ?? null) !== (listedRate.pricePerShift ?? null));

  /**
   * Смена ветки: чужие поля сбрасываются — арендодатель у своей машины смысла не имеет. Рейс
   * сбрасывается вместе с машиной: арендную единицу ведёт арендодатель, и рейса у неё нет.
   */
  const changeOwnership = (next: VehicleOwnership) => {
    setOwnership(next);
    form.setFieldsValue({
      lessorId: undefined,
      vehicleId: undefined,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      routeId: NEW_ROUTE,
    });
  };

  /** Машина и её ставки из справочника: у собственной их нет — поля остаются пустыми. */
  const vehicleValues = (id: string) => {
    const v = vehicles.find((x) => x.id === id);
    return {
      vehicleId: id,
      pricePerHour: v?.pricePerHour ?? null,
      pricePerShift: v?.pricePerShift ?? null,
      shiftHours: v?.shiftHours ?? null,
    };
  };

  /**
   * Выбор машины подставляет её ставки и её сегодняшний рейс: так диспетчер и работает, собирая
   * день машины. Свободного рейса нет — заводится новый.
   */
  const changeVehicle = (id: string) => {
    const own = routeOptions.find((r) => r.vehicleId === id);
    form.setFieldsValue({
      ...vehicleValues(id),
      ...(needsRoute ? { routeId: own?.id ?? NEW_ROUTE } : {}),
    });
  };

  /**
   * Выбор рейса задаёт машину: рейс заведён на конкретную единицу, и «поедет рейсом Р-12, но
   * другой машиной» — не состояние, а расхождение, на которое сервер ответил бы «маршрут заведён
   * на другую машину». Поле «Техника» при выбранном рейсе заблокировано; «Новый маршрут» его
   * освобождает, оставляя выбранное значение.
   */
  const changeRoute = (id: string) => {
    routeTouched.current = true;
    const target = routeOptions.find((r) => r.id === id) ?? null;
    form.setFieldsValue({ routeId: id, ...(target ? vehicleValues(target.vehicleId) : {}) });
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
    // Машинист обязателен там, где выписываются недельные листы ЭСМ-2: без него бланк
    // недействителен. Тем же правилом отвечает сервер — он же видит, чья это машина.
    if (needsMachinist && !v.machinistId) {
      message.warning('Выберите машиниста — на него выписываются путевые листы ЭСМ-2');
      return;
    }
    // Перегон едет откуда-то куда-то и кем-то: пустые графы — это лист, по которому нельзя ехать.
    // Тем же правилом отвечает сервер, а незаполненный перегон здесь означал бы, что галочку
    // включили и забыли.
    if (
      wantsDelivery &&
      (!v.deliveryDate || !v.deliveryDriverId || !v.deliveryFrom?.trim() || !v.deliveryTo?.trim())
    ) {
      message.warning('Заполните перегон: дату, водителя и откуда — куда');
      return;
    }
    onSubmit({
      assignment: {
        vehicleId: v.vehicleId,
        pricePerHour: v.pricePerHour ?? null,
        pricePerShift: v.pricePerShift ?? null,
        shiftHours: v.shiftHours ?? null,
        // Машинист заказа техники на объект: на него выписываются листы ЭСМ-2 за каждую неделю
        // срока. У грузоперевозки поля нет — там водитель принадлежит рейсу.
        ...(needsMachinist ? { driverPersonId: v.machinistId } : {}),
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
        // Доставка техники на объект — отдельный рейс на дату перегона, а не часть маршрута
        // заявки: у спецтехники маршрута нет вовсе, есть период работы машины на площадке.
        ...(wantsDelivery
          ? {
              delivery: {
                routeDate: v.deliveryDate!.format('YYYY-MM-DD'),
                driverPersonId: v.deliveryDriverId,
                moveFrom: v.deliveryFrom!.trim(),
                moveTo: v.deliveryTo!.trim(),
                trip: { communicationKind: 'городское' },
              },
            }
          : {}),
      },
      schedule,
    });
  };

  // Пусто — значит пусто в парке целиком: список не сужен ни типом, ни видом (ADR 0064), и
  // обещать, что техника найдётся где-то ещё, нечем.
  const emptyText = isFetching
    ? 'Загружаем технику…'
    : ownership === 'own'
      ? 'Собственной техники в работе нет — возьмите её в аренду'
      : lessorId
        ? 'У этого арендодателя нет активных предложений'
        : 'Активных предложений аренды нет';

  return (
    <FormModal
      title={
        request
          ? `${reassign ? 'Смена техники' : 'В работу'}: заявка ${request.displayNumber}`
          : reassign
            ? 'Смена техники'
            : 'В работу'
      }
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText={reassign ? 'Сменить технику' : 'Взять в работу'}
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

            {/* Чем заявку выполняют сейчас — строкой над выбором: смена техники начинается с
              вопроса «на что меняем», и ответ на «с чего» должен стоять перед глазами. При
              переводе в работу этой строки нет: менять там нечего. */}
            {reassign && request.assignment && (
              <FormGrid.Full>
                <Typography.Paragraph style={{ marginBottom: 16 }}>
                  Сейчас назначена: {assignmentTitle(request.assignment)}
                  {assignmentRateLabel(request.assignment)
                    ? ` · ${assignmentRateLabel(request.assignment)}`
                    : ''}
                </Typography.Paragraph>
              </FormGrid.Full>
            )}

            {/* Фактический срок: подставлен заказанным, под полями — что просили изначально.
              Спрашивается первым, потому что от даты рейса зависит отбор водителей ниже. При смене
              техники срок не спрашивают — он согласован при переводе в работу (ADR 0048). */}
            {reassign ? null : request.requestType === 'special_equipment' ? (
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
                {/* Машинист: на него выписываются недельные листы ЭСМ-2, и без него бланк
                  недействителен. Список — весь справочник водителей: граф СНИЛС и удостоверения
                  в этом бланке нет, и отбирать по ним некого (ADR 0055). */}
                {needsMachinist && (
                  <Form.Item
                    name="machinistId"
                    label="Машинист"
                    rules={[{ required: true, message: 'Выберите машиниста' }]}
                    extra={
                      esm2Weeks.length > 0
                        ? `Будет выписано листов ЭСМ-2: ${esm2Weeks.length} — ${esm2Weeks
                            .map(
                              (w) =>
                                `${formatDateOnly(w.from).slice(0, 5)}–${formatDateOnly(w.to).slice(0, 5)}`,
                            )
                            .join(', ')}`
                        : 'На каждую неделю срока работ выписывается свой путевой лист'
                    }
                  >
                    {/* Человека за технику портал не назначает сам: даже когда в справочнике один
                      водитель, за руль его сажает диспетчер. Подсказки в строках списка остаются —
                      они помогают выбрать, а не выбирают. */}
                    <AutoSelect
                      autoSelectSole={false}
                      options={machinistOptions}
                      loading={machinistsLoading}
                      placeholder="Кто сядет за технику"
                      notFoundContent="В справочнике нет действующих водителей"
                    />
                  </Form.Item>
                )}
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

            {/* Шаг 1: каким рейсом заявка поедет. Вопрос стоит до техники, потому что так и
              планируют день: у машины этого типа уже собран рейс, и заявка дописывается в него
              строкой задания — а машину задаёт сам рейс (ADR 0052). «Новый маршрут» возвращает прежний
              порядок: выбирают машину, а рейс заводится под неё.

              Рейсы показываются на дату из формы: подачу правят здесь же, а рейс печатает задание
              на день — подсказка соседнего дня предлагала бы рейсы, в которые заявка не встанет. */}
            {needsRoute && (
              <FormGrid.Full>
                <Typography.Title level={5} style={{ marginTop: 8 }}>
                  Маршрут
                </Typography.Title>
                <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
                  Рейс на {tripDate}. Путевой лист выписывается с маршрута, когда состав собран —
                  {prefill?.formLabel ? ` ${prefill.formLabel.toLowerCase()}` : ' по бланку рейса'}.
                </Typography.Paragraph>
                <Form.Item name="routeId" label="Рейс">
                  <AutoSelect
                    options={[
                      ...routeOptions.map((r) => ({
                        value: r.id,
                        label: [
                          r.displayNumber,
                          r.vehicleLabel,
                          r.driverName || 'водитель не назначен',
                          `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                        ].join(' · '),
                      })),
                      { value: NEW_ROUTE, label: 'Новый маршрут' },
                    ]}
                    showSearch
                    optionFilterProp="label"
                    placeholder="Выберите рейс"
                    onChange={changeRoute}
                  />
                </Form.Item>
              </FormGrid.Full>
            )}

            {/* Шаг 2: чья машина. Количество единиц этого типа — в самой подписи: пустая ветка
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

            {/* Шаг 3 (только аренда): у кого берём. */}
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

            {/* Шаг 4: конкретная единица. Расхождение с заказанной позицией — подстрочным
              предупреждением (ADR 0045, ADR 0059, ADR 0064): назначение оно не отменяет, но и
              незамеченным не проходит. Выбранный рейс поле запирает: машину задаёт он (ADR 0052).

              Обрезанный парк назван там же: поиск в поле ищет по загруженным строкам, и машина,
              не поместившаяся в страницу, выглядела бы отсутствующей. */}
            <Form.Item
              name="vehicleId"
              label="Конкретная техника"
              rules={[{ required: true, message: 'Выберите технику' }]}
              extra={
                joinedRoute ? (
                  <Typography.Text type="secondary">
                    Машину задал рейс {joinedRoute.displayNumber} — выберите «Новый маршрут», чтобы
                    сменить её
                  </Typography.Text>
                ) : substitution ? (
                  <Typography.Text
                    type={substitution.level === 'warning' ? 'warning' : 'secondary'}
                  >
                    {substitution.text}
                    {formChange ? ` ${formChange}.` : ''}
                  </Typography.Text>
                ) : vehicleOptions.length === 0 ? (
                  emptyText
                ) : hiddenVehicles > 0 ? (
                  <Typography.Text type="secondary">
                    Заказанный вид техники показан целиком; машин других видов в списке не все —
                    ещё {hiddenVehicles} в парке
                  </Typography.Text>
                ) : undefined
              }
            >
              <AutoSelect
                options={vehicleOptions}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={joiningRoute || (isRental && !lessorId)}
                placeholder={
                  isRental && !lessorId ? 'Сначала выберите арендодателя' : 'Выберите ТС'
                }
                onChange={changeVehicle}
              />
            </Form.Item>

            {selected && (
              <FormGrid.Full>
                <Space size={8} wrap style={{ marginBottom: 16 }}>
                  {/* Позиция классификатора выбранной машины: цвет меняется, когда она разошлась с
                    заказом, — тег и предупреждение говорят об одном и том же разными способами. */}
                  <Tag
                    color={
                      substitution ? (substitution.level === 'warning' ? 'orange' : 'gold') : 'blue'
                    }
                  >
                    {selected.categoryName ?? selected.typeName}
                  </Tag>
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

            {/* Доставка техники на объект: перегон по городу своим ходом — это рейс, и на него
              выписывается 4-П. Предлагается, а не требуется: ту же машину могут привезти тралом,
              и тогда листа не бывает вовсе. Вывоз заводят позже, из карточки заявки: в этот
              момент его дату ещё не знают. */}
            {canOfferDelivery && selected && (
              <>
                <FormGrid.Full>
                  <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 0 }}>
                    Доставка на объект
                  </Typography.Title>
                  <Form.Item name="deliveryEnabled" valuePropName="checked" noStyle>
                    <Checkbox onChange={(e) => toggleDelivery(e.target.checked)}>
                      Техника едет своим ходом — выписать путевой лист 4-П
                    </Checkbox>
                  </Form.Item>
                  <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                    Перегон станет отдельным рейсом; лист по нему выписывают в карточке маршрута.
                    Если технику везут тралом, оставьте выключенным.
                  </Typography.Paragraph>
                </FormGrid.Full>

                {wantsDelivery && (
                  <>
                    <Form.Item
                      name="deliveryDate"
                      label="Дата перегона"
                      rules={[{ required: true, message: 'Укажите дату перегона' }]}
                    >
                      <DatePicker
                        format="DD.MM.YYYY"
                        style={{ width: '100%' }}
                        inputReadOnly={isMobile}
                      />
                    </Form.Item>
                    <Form.Item
                      name="deliveryDriverId"
                      label="Водитель перегона"
                      rules={[{ required: true, message: 'Выберите водителя' }]}
                      extra={
                        !deliveryDate
                          ? 'Сначала укажите дату: годность удостоверения считается на день перегона'
                          : driverOptions.length === 0 && !driversLoading
                            ? 'В справочнике нет действующих водителей'
                            : undefined
                      }
                    >
                      {/* Единственный водитель справочника сам в поле не встаёт: кто поедет,
                        решает диспетчер (см. поле водителя нового рейса ниже). */}
                      <AutoSelect
                        autoSelectSole={false}
                        options={driverOptions}
                        showSearch
                        optionFilterProp="label"
                        loading={driversLoading}
                        disabled={!deliveryDate}
                        placeholder={
                          deliveryDate ? 'Выберите водителя' : 'Сначала укажите дату перегона'
                        }
                      />
                    </Form.Item>
                    {/* Перегон печатает тот же 4-П, и пустая графа в нём такая же пустая: о ней
                      говорят здесь, у своего поля, а не одним предупреждением на всё окно. */}
                    {deliveryDriverGaps && (
                      <FormGrid.Full>
                        <Alert
                          type="warning"
                          showIcon
                          message="Документы водителя перегона неполные"
                          description={deliveryDriverGaps}
                        />
                      </FormGrid.Full>
                    )}
                    {/* Адрес перегона (ADR 0069): подсказки DaData либо выбор площадки из
                      справочника; свободная строка остаётся допустимой — база и стоянка адресами
                      не описываются. */}
                    <AddressField
                      name="deliveryFrom"
                      label="Откуда"
                      required
                      requiredMessage="Укажите, откуда идёт техника"
                      directory
                      suggestObjectIds={suggestObjectIds}
                      placeholder="База, ул. Автомобильная, 3"
                    />
                    <AddressField
                      name="deliveryTo"
                      label="Куда"
                      required
                      requiredMessage="Укажите, куда идёт техника"
                      directory
                      suggestObjectIds={suggestObjectIds}
                      placeholder="Объект, адрес площадки"
                    />
                  </>
                )}
              </>
            )}

            {/* Причина, по которой рейс не ведётся: аренду ведёт арендодатель, у типа может не
              быть бланка. Показывается текстом — исчезнувший блок «Маршрут» читался бы как
              поломка. У заказа техники на объект ни блока, ни текста: рейса в этом процессе не
              существует, и объяснять нечего (ADR 0041). */}
            {selected && !needsRoute && requirement.reason && (
              <FormGrid.Full>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 16 }}
                  message="Маршрут не ведётся"
                  description={requirement.reason}
                />
              </FormGrid.Full>
            )}

            {needsRoute && (
              <>
                {joiningRoute && (
                  <FormGrid.Full>
                    <Typography.Text type="secondary">
                      Заявка встанет строкой задания в рейс {joinedRoute?.displayNumber}: водитель и
                      реквизиты выезда там уже свои, и правят их в карточке маршрута.
                    </Typography.Text>
                  </FormGrid.Full>
                )}

                {/* Новый рейс спрашивает то, чего у готового уже спрашивать не надо: кто за рулём
                  и чем заполнены графы шапки бланка. Заголовок здесь, а не наверху у выбора
                  рейса: наверху решают, куда заявка едет, а тут заводят сам рейс. */}
                {!joiningRoute && (
                  <FormGrid.Full>
                    <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 0 }}>
                      Новый рейс
                    </Typography.Title>
                  </FormGrid.Full>
                )}

                {!joiningRoute && (
                  <Form.Item
                    name="driverPersonId"
                    label="Водитель"
                    rules={[{ required: true, message: 'Выберите водителя' }]}
                    extra={
                      driverOptions.length === 0 && !driversLoading
                        ? 'В справочнике нет действующих водителей: заведите карточку или ' +
                          'откройте специализацию «водитель» у существующей.'
                        : undefined
                    }
                  >
                    {/* Водитель не подставляется никогда — ни единственным в справочнике, ни
                      вчерашним на этой машине. За руль человека сажает диспетчер, и подставленная
                      фамилия читается как уже принятое решение: её пролистывают, а в бланк она
                      попадает настоящей. Список остаётся подсказывающим — пригодные первыми, с
                      пометками о категории и документах (ADR 0055, ADR 0064). */}
                    <AutoSelect
                      autoSelectSole={false}
                      options={driverOptions}
                      showSearch
                      optionFilterProp="label"
                      loading={driversLoading}
                      placeholder="Выберите водителя"
                    />
                  </Form.Item>
                )}

                {/* Два предупреждения, а не одно: пустая графа бланка и чужая категория — разные
                  вещи, и первое проверяют по справочнику водителей, а второе по документу в
                  руках. Оба ничего не запрещают (ADR 0055, ADR 0064). */}
                {!joiningRoute && driverGaps && (
                  <FormGrid.Full>
                    <Alert
                      type="warning"
                      showIcon
                      message="Документы водителя внесены не полностью"
                      description={driverGaps}
                    />
                  </FormGrid.Full>
                )}

                {!joiningRoute && driverCategoryMismatch && (
                  <FormGrid.Full>
                    <Alert
                      type="warning"
                      showIcon
                      message="Категория прав не совпадает с требованием машины"
                      description={driverCategoryMismatch}
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
