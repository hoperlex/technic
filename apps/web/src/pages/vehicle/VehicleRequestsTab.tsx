import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  type TableColumnType,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type AddressMeta,
  type AssignVehicleBody,
  type ConfirmScheduleBody,
  assignmentRateLabel,
  assignmentTitle,
  canReassignVehicle,
  canRequestEarlyEnd,
  canShortenWorkPeriodByEdit,
  type CompleteVehicleRequestInput,
  isAddressVerified,
  minRequestDateKey,
  isCargoAmountRequired,
  CARGO_AMOUNT_MESSAGE,
  isVehicleKindAllowedForRequest,
  normalizeTimeInput,
  parseVehicleClassificationKey,
  parseVehicleRequestNumberSearch,
  REQUEST_STATUSES,
  type RequestStatus,
  requestCustomerName,
  requestStatusLabels,
  type SpecialEquipmentRequestDto,
  statusChangeRequiresReason,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  vehicleClassificationLabel,
  type VehicleRequestDto,
  type VehicleRequestType,
  vehicleRequestTypeColors,
  allowedVehicleRequestTypes,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { CancelReasonModal } from '../../components/CancelReasonModal';
import { DataTable, type CardConfig } from '../../components/DataTable';
import { FormGrid } from '../../components/FormGrid';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { sortOptionsFrom, type FilterDefinition } from '../../components/listControls';
import { TabsExtra } from '../../components/PageTabs';
import { SummaryBar } from '../../components/SummaryBar';
import { actionsColumn, textColumn } from '../../components/columns';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { UserAvatar } from '../../components/UserAvatar';
import { ObjectCell } from '../../components/ObjectCell';
import { AddressAutoComplete } from '../../components/AddressAutoComplete';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useListParams } from '../../hooks/useListParams';
import {
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
} from '../../hooks/useVehicleClassifications';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTimeMaybe } from '../../utils/format';
import { withSavedOption } from '../../utils/selectOptions';
import {
  calendarDaysLabel,
  isBeforeMinRequestDate,
  isPastDate,
  minRequestDate,
} from '../../utils/date';
import { MOSCOW_TZ } from '../../theme';
import { FilesCell } from '../../components/FileLinks';
import { VehicleAssignModal } from './VehicleAssignModal';
import { VehicleCompleteModal } from './VehicleCompleteModal';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRelocationModal } from './VehicleRelocationModal';
import { VehicleRouteTransferModal } from './VehicleRouteTransferModal';
import { useObjectScope } from '../../hooks/useObjectScope';
import { useDepartmentScope } from '../../hooks/useDepartmentScope';
import {
  ApprovalCell,
  EarlyEndTag,
  FileEditor,
  formatDateOnly,
  useEarlyEnd,
  StatusCell,
  VehicleClassificationSelect,
  useDepartmentOptions,
  useFileEditor,
  useObjectOptions,
  useVehicleClassificationFilter,
  type EditorFile,
} from './shared';

/**
 * Единая форма заявки на автотехнику. Тип заявки выбирают явно — он задаёт и набор полей,
 * и список доступной техники: на объект заказывают технику любого вида, грузоперевозку —
 * только грузовым (`isVehicleKindAllowedForRequest`). Поля чужого типа скрыты вместе с
 * лейблами, пока тип заявки не выбран — не видно ни одного из двух блоков.
 */
interface FormValues {
  requestType: VehicleRequestType;
  /** Заказчик (ADR 0040): у роли отдела заполняется `departmentId`, у остальных — `objectId`. */
  objectId?: string;
  departmentId?: string;
  /** Ключ позиции классификатора «тип:категория» (ADR 0028); в API уходит парой полей. */
  classificationKey: string;
  // Техника на объект: период работы (date-only) и контакт встречающего.
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  responsibleName?: string;
  responsiblePhone?: string;
  // Грузоперевозка: дата + необязательное время `HH:mm`, объём/масса, адреса и контакт на
  // каждом конце маршрута — грузят и принимают разные люди в разных местах.
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  volumeM3?: number | null;
  weightTons?: number | null;
  loadingLocation?: string;
  unloadingLocation?: string;
  loadingResponsibleName?: string;
  loadingResponsiblePhone?: string;
  unloadingResponsibleName?: string;
  unloadingResponsiblePhone?: string;
  comment?: string;
}

/**
 * Комментарий — единственное место, где автор объясняет суть заказа, и объясняет он разное:
 * у грузоперевозки диспетчеру нужно знать груз (от него зависит машина и погрузка), у техники
 * на объект — какие работы её ждут. Поэтому заголовок уточняется типом заявки, а пример
 * заполнения стоит в самом поле: без него комментарий приходит пустым или бесполезным
 * («срочно»), и детали всё равно выясняются звонком.
 */
const COMMENT_HINTS: Record<VehicleRequestType, { label: string; placeholder: string }> = {
  special_equipment: {
    label: 'Комментарий (планируемые задачи)',
    placeholder:
      'Например: разработка котлована под фундамент, погрузка грунта в самосвалы; заезд с ул. Ленина, работы с 08:00',
  },
  freight_transport: {
    label: 'Комментарий (опишите груз)',
    placeholder:
      'Например: плиты перекрытия ПК 60-15, 12 шт, 14 т; погрузка краном поставщика, на объекте нужен манипулятор',
  },
};

const SPECIAL_FIELDS = ['dateFrom', 'dateTo', 'responsibleName', 'responsiblePhone'] as const;
const FREIGHT_FIELDS = [
  'scheduledDate',
  'scheduledTime',
  'volumeM3',
  'weightTons',
  'loadingLocation',
  'unloadingLocation',
  'loadingResponsibleName',
  'loadingResponsiblePhone',
  'unloadingResponsibleName',
  'unloadingResponsiblePhone',
] as const;

/** Колонка «Срок»: у спецтехники это период, у грузоперевозки — дата (и время, если задано). */
function termLabel(r: VehicleRequestDto): string {
  if (r.requestType === 'special_equipment') {
    return r.dateTo
      ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
      : formatDateOnly(r.dateFrom);
  }
  return formatDateTimeMaybe(r.scheduledAt, r.scheduledTimeUnspecified);
}

export function VehicleRequestsTab() {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  // Объектные роли — область видимости (свои объекты, заявка до «В работе»); действия — по
  // правам (ADR 0021). Виза — право руководителя строительства (ADR 0025).
  const { isObjectRole, soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  // Вторая ось заказчика (ADR 0040): отдел вместо объекта — у роли она ровно одна.
  const { isDepartmentRole, soleDepartmentId, departmentFieldDisabled, limitDepartmentOptions } =
    useDepartmentScope();
  // Отдел заказывает только грузоперевозки: перечень берётся из матрицы, а не из имени роли.
  const requestTypeOptions = allowedVehicleRequestTypes(user).map((t) => ({
    value: t,
    label: vehicleRequestTypeLabels[t],
  }));
  const canEdit = can('vehicleRequests.update');
  const canDelete = can('vehicleRequests.delete');
  const canCreate = can('vehicleRequests.create');
  const canApprove = can('vehicleRequests.approve');
  const canRestore = can('archive.restore');
  /** Ведение хода заявки: перевод в работу и, тем же правом, смена назначенной машины (ADR 0048). */
  const canChangeStatus = can('vehicleRequests.status');

  // С одним объектом он зафиксирован и в фильтре списка, и в форме заявки; с несколькими —
  // выбор сужен до своих (ADR 0039). Сервер всё равно отвечает 403 на чужой — assertObjectScope.
  const ownObjectId = soleObjectId ?? '';

  // requestType не задан — список обоих типов; фильтр в шапке сужает до одного.
  // Все фильтры собраны в панели над таблицей, а не в выпадашках столбцов: в заголовке их
  // не видно, а часть значений (объект, тип ТС) — списки справочников.
  const { params, setParams, setSort, onTableChange } = useListParams<{
    requestType?: string;
    status?: string;
    objectId?: string;
    departmentId?: string;
    /** Заказанная техника (ADR 0028): тип целиком либо одна его категория. */
    vehicleTypeId?: string;
    vehicleCategoryId?: string;
    num?: number;
    /** Виза (ADR 0025): 'false' — заявки, ждущие согласования. */
    approved?: string;
  }>(
    { objectId: ownObjectId || undefined, departmentId: soleDepartmentId ?? undefined },
    { searchKeys: ['comment'] },
  );

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    vehicleTypeId: params.vehicleTypeId,
    vehicleCategoryId: params.vehicleCategoryId,
    onChange: applyFilter,
  });

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'all', params],
    queryFn: () => vehicleRequestsApi.list(params),
  });
  const items = data?.items ?? [];

  // Сводка в шапке: сколько заявок ждёт обработки и сколько в работе. Ключ начинается с
  // 'vehicle-requests' — значит счётчики обновляются теми же инвалидациями, что и список.
  // Сужающие фильтры (объект, тип заявки, техника) в сводку идут: цифры относятся к тому же
  // списку, что человек видит перед собой. Статус и номер — нет, они свели бы её к самой себе.
  const summaryQuery = {
    objectId: params.objectId,
    requestType: params.requestType,
    vehicleTypeId: params.vehicleTypeId,
    vehicleCategoryId: params.vehicleCategoryId,
  };
  const { data: summary } = useQuery({
    queryKey: ['vehicle-requests', 'summary', summaryQuery],
    queryFn: () => vehicleRequestsApi.summary(summaryQuery),
  });
  const summaryItems = [
    { label: 'Не обработанных', value: summary?.new ?? 0 },
    // Заявка без визы не двинется дальше «Новой», и по статусам это не видно (ADR 0025).
    { label: 'Ждут визы', value: summary?.awaitingApproval ?? 0 },
    { label: requestStatusLabels.confirmed, value: summary?.confirmed ?? 0 },
  ];

  const { options: allObjectOptions, loading: objectsLoading } = useObjectOptions();
  const objectOptions = limitObjectOptions(allObjectOptions);
  const { options: allDepartmentOptions, loading: departmentsLoading } = useDepartmentOptions();
  const departmentOptions = limitDepartmentOptions(allDepartmentOptions);
  const { byKey: classificationByKey, groups, loading: typesLoading } = useVehicleClassifications();

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleRequestDto | null>(null);
  /** Открытая карточка заявки: поля только на чтение и история событий (ADR 0015). */
  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();
  // Метаданные верификации адресов держим вне формы (значение — объект, не строка).
  const [loadingMeta, setLoadingMeta] = useState<AddressMeta | null>(null);
  const [unloadingMeta, setUnloadingMeta] = useState<AddressMeta | null>(null);

  /**
   * Какой осью заказчика спрашивает форма (ADR 0040). У новой заявки её задаёт роль — отдел
   * заказывает от отдела, остальные от объекта; у заведённой — сама заявка.
   *
   * Именно `record`, а не одна лишь роль: у заявки заказчик уже выбран, и спрашивать вместо него
   * ось редактора значит показывать чужое пустое поле. Диспетчер, открыв правку грузоперевозки
   * отдела, видел бы обязательный пустой «Объект» — отдела в форме нет вовсе, — и сохранение
   * молча переносило бы заявку с отдела на площадку.
   */
  const departmentCustomer = record ? !!record.departmentId : isDepartmentRole;

  /**
   * Списки формы держат то, что выбрано у правимой заявки, даже если из действующего справочника
   * оно выпало: объект закрыли, отдел расформировали, а заявка на них заведена. Поле обязательное,
   * и без этого правка начиналась бы с пустого заказчика.
   */
  const formObjectOptions = withSavedOption(objectOptions, {
    id: record?.objectId,
    name: record ? `${record.objectCode} — ${record.objectName}` : null,
  });
  const formDepartmentOptions = withSavedOption(departmentOptions, {
    id: record?.departmentId,
    name: record ? `${record.departmentCode} — ${record.departmentName}` : null,
  });
  /**
   * Тип правимой заявки остаётся в списке, даже если роли он недоступен (ADR 0040). Поле заперто —
   * тип неизменяем, — но подписать значение вне списка `AutoSelect` нечем: показался бы код.
   */
  const formRequestTypeOptions = withSavedOption(requestTypeOptions, {
    id: record?.requestType,
    name: record ? vehicleRequestTypeLabels[record.requestType] : null,
  });

  // Тип заявки выбирают в форме первым — от него зависят и поля, и список типов ТС.
  const watchRequestType = Form.useWatch('requestType', form);
  const isSpecial = watchRequestType === 'special_equipment';
  const isFreight = watchRequestType === 'freight_transport';
  const commentHint = watchRequestType ? COMMENT_HINTS[watchRequestType] : null;

  /**
   * Нужен ли груз. У легковой машины (форма № 3) его не бывает: она возит людей, и требовать
   * «объём или массу» значило бы заставлять заявителя выдумывать число. Правило то же, которым
   * отвечает сервер, — и спрашивает оно бланк заказанного типа, а не его код.
   */
  const watchClassificationKey = Form.useWatch('classificationKey', form);
  const cargoRequired = isCargoAmountRequired(
    (watchClassificationKey
      ? classificationByKey.get(watchClassificationKey)?.waybillFormCode
      : null) ?? null,
  );

  // Подсказка о длине периода работы техники: пустая дата окончания — однодневный срок
  // (так же его понимает сервер). Та же подсказка стоит в карточке заявки.
  const watchDateFrom = Form.useWatch('dateFrom', form);
  const watchDateTo = Form.useWatch('dateTo', form);
  const periodHint = watchDateFrom
    ? calendarDaysLabel(watchDateFrom.format('YYYY-MM-DD'), watchDateTo?.format('YYYY-MM-DD'))
    : null;

  // Ограничение дат: новая заявка — не раньше сегодня по МСК (правило сервера), правка
  // заведённой — не в прошлое (её дата могла быть назначена и вчера).
  const minDateRule = record ? isPastDate : isBeforeMinRequestDate;

  // Срок работающей заявки правкой только продлевают: сокращение идёт досрочным завершением с
  // визой (ADR 0044), и сервер прямую правку отклоняет.
  const dateToLocked =
    !!record &&
    record.requestType === 'special_equipment' &&
    !canShortenWorkPeriodByEdit(record.status);
  const currentLastDay =
    record?.requestType === 'special_equipment' ? record.dateTo || record.dateFrom : null;
  const isBeforeCurrentDateTo = (d: Dayjs) =>
    !!currentLastDay && d.format('YYYY-MM-DD') < currentLastDay;

  // Заказ техники на объект допускает технику любого вида, грузоперевозка — только грузовую.
  // Позиция правимой заявки могла выйти из справочника (её выключили) или не существовать вовсе
  // (заявка старше категорий) — её добавляем отдельной заблокированной строкой, иначе поле
  // выглядит пустым и непонятно, что вообще заказывали.
  const typeGroups = watchRequestType
    ? withSavedClassification(
        groups.filter((g) => isVehicleKindAllowedForRequest(watchRequestType, g.kindCode)),
        record
          ? {
              vehicleTypeId: record.vehicleTypeId,
              vehicleCategoryId: record.vehicleCategoryId,
              typeName: record.vehicleTypeName,
              categoryName: record.vehicleCategoryName,
            }
          : null,
      )
    : [];

  /**
   * Смена типа заявки: поля чужого типа очищаем, своей дате подставляем сегодня — раньше
   * нельзя; выбранную технику сбрасываем, если новому типу заявки её вид не подходит.
   */
  const handleRequestTypeChange = (next: VehicleRequestType) => {
    const key: string | undefined = form.getFieldValue('classificationKey');
    const kindCode = key ? classificationByKey.get(key)?.kindCode : undefined;
    if (kindCode && !isVehicleKindAllowedForRequest(next, kindCode)) {
      form.resetFields(['classificationKey']);
    }
    if (next === 'special_equipment') {
      form.resetFields([...FREIGHT_FIELDS]);
      setLoadingMeta(null);
      setUnloadingMeta(null);
      if (!form.getFieldValue('dateFrom')) form.setFieldsValue({ dateFrom: minRequestDate() });
    } else {
      form.resetFields([...SPECIAL_FIELDS]);
      if (!form.getFieldValue('scheduledDate')) {
        form.setFieldsValue({ scheduledDate: minRequestDate() });
      }
    }
  };

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    // Штаб заводит заявку только на свой объект — подставляем его сразу, поле заперто.
    // Объект подставляется, только когда он у роли один: с несколькими выбирает человек.
    // Заказчик подставляется, только когда он у роли один: с несколькими выбирает человек.
    if (soleObjectId) form.setFieldsValue({ objectId: soleObjectId } as Partial<FormValues>);
    if (soleDepartmentId) {
      form.setFieldsValue({ departmentId: soleDepartmentId } as Partial<FormValues>);
    }
    // Отделу доступен один тип заявки — подставляем его, чтобы поле не спрашивало о выборе,
    // которого нет.
    if (requestTypeOptions.length === 1) {
      form.setFieldsValue({ requestType: requestTypeOptions[0]!.value } as Partial<FormValues>);
    }
    setLoadingMeta(null);
    setUnloadingMeta(null);
    editor.reset([]);
    setOpen(true);
  };

  const openEdit = (r: VehicleRequestDto) => {
    setRecord(r);
    form.resetFields();
    if (r.requestType === 'special_equipment') {
      setLoadingMeta(null);
      setUnloadingMeta(null);
      form.setFieldsValue({
        requestType: r.requestType,
        objectId: r.objectId ?? undefined,
        classificationKey: classificationKeyOf(r),
        dateFrom: dayjs(r.dateFrom),
        dateTo: r.dateTo ? dayjs(r.dateTo) : null,
        responsibleName: r.responsibleName,
        responsiblePhone: r.responsiblePhone,
        comment: r.comment,
      });
    } else {
      setLoadingMeta(r.loadingAddress);
      setUnloadingMeta(r.unloadingAddress);
      // Момент с сервера переводится в МСК, а не читается как московское время: `dayjs.tz(iso,
      // tz)` теряет пришедшее смещение и показывал бы подачу на три часа раньше — а правка
      // сохраняла бы этот сдвиг обратно в заявку. Так же читает подачу заявка на вывоз мусора.
      const at = dayjs(r.scheduledAt).tz(MOSCOW_TZ);
      form.setFieldsValue({
        requestType: r.requestType,
        objectId: r.objectId ?? undefined,
        departmentId: r.departmentId ?? undefined,
        classificationKey: classificationKeyOf(r),
        scheduledDate: at,
        // Время не задано — поле остаётся пустым (в scheduledAt лежит полночь МСК).
        scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
        volumeM3: r.volumeM3,
        weightTons: r.weightTons,
        loadingLocation: r.loadingLocation,
        unloadingLocation: r.unloadingLocation,
        loadingResponsibleName: r.loadingResponsibleName,
        loadingResponsiblePhone: r.loadingResponsiblePhone,
        unloadingResponsibleName: r.unloadingResponsibleName,
        unloadingResponsiblePhone: r.unloadingResponsiblePhone,
        comment: r.comment,
      });
    }
    editor.reset(
      r.files.map((f): EditorFile => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        isNew: false,
      })),
    );
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (v: FormValues) => {
      // Выбрана одна позиция классификатора (ADR 0028) — в API она уходит парой «тип +
      // категория»: категория пуста у типа, у которого её и не бывает.
      const picked = parseVehicleClassificationKey(v.classificationKey)!;
      const common = {
        vehicleTypeId: picked.vehicleTypeId,
        vehicleCategoryId: picked.vehicleCategoryId,
        comment: v.comment ?? '',
      };
      if (v.requestType === 'special_equipment') {
        // Спецтехнику заказывает только объект: она выходит на площадку, и отдела в такой заявке
        // нет вовсе (ADR 0040) — роль отдела до этой ветки не доходит, ей закрыт сам тип.
        const base = {
          requestType: 'special_equipment' as const,
          objectId: v.objectId!,
          ...common,
          dateFrom: v.dateFrom!.format('YYYY-MM-DD'),
          dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
          responsibleName: v.responsibleName!,
          responsiblePhone: v.responsiblePhone!,
        };
        return record
          ? vehicleRequestsApi.update(record.id, {
              ...base,
              version: record.version,
              addFileIds: editor.newFileIds(),
              removeFileIds: editor.removedIds,
            })
          : vehicleRequestsApi.create({ ...base, fileIds: editor.newFileIds() });
      }

      // Заказчик грузоперевозки — объект либо отдел, ровно один (ADR 0040): присылать обе оси
      // сервер не даст. Ось берётся та же, которую спрашивала форма (`departmentCustomer`), — у
      // заведённой заявки это её собственный заказчик, а не ось того, кто правит.
      const customer = departmentCustomer
        ? { departmentId: v.departmentId! }
        : { objectId: v.objectId! };

      // Время не задано → полночь МСК + признак: заявка «на дату», без конкретного часа.
      const time = normalizeTimeInput(v.scheduledTime ?? '');
      const scheduledAt = dayjs
        .tz(`${v.scheduledDate!.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        requestType: 'freight_transport' as const,
        ...customer,
        ...common,
        scheduledAt,
        scheduledTimeUnspecified: time === undefined,
        volumeM3: v.volumeM3 ?? null,
        weightTons: v.weightTons ?? null,
        loadingLocation: v.loadingLocation!,
        unloadingLocation: v.unloadingLocation!,
        // onFinish гарантирует, что оба адреса верифицированы (жёсткая модель, ADR 0006).
        loadingAddress: loadingMeta!,
        unloadingAddress: unloadingMeta!,
        loadingResponsibleName: v.loadingResponsibleName!,
        loadingResponsiblePhone: v.loadingResponsiblePhone!,
        unloadingResponsibleName: v.unloadingResponsibleName!,
        unloadingResponsiblePhone: v.unloadingResponsiblePhone!,
      };
      return record
        ? vehicleRequestsApi.update(record.id, {
            ...base,
            version: record.version,
            addFileIds: editor.newFileIds(),
            removeFileIds: editor.removedIds,
          })
        : vehicleRequestsApi.create({ ...base, fileIds: editor.newFileIds() });
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Доваливаем правила, которые зависят от типа заявки и не выражаются rules-ами полей. */
  const onFinish = (v: FormValues) => {
    if (v.requestType === 'special_equipment') {
      saveMut.mutate(v);
      return;
    }
    if (cargoRequired && v.volumeM3 == null && v.weightTons == null) {
      message.error(CARGO_AMOUNT_MESSAGE);
      return;
    }
    // Жёсткая модель (ADR 0006): адрес погрузки/разгрузки обязателен и должен быть выбран
    // из подсказок DaData (верифицирован). Неверифицированный ввод сохранять нельзя.
    const fields: { name: keyof FormValues; errors: string[] }[] = [];
    if (!isAddressVerified(loadingMeta)) {
      fields.push({ name: 'loadingLocation', errors: ['Выберите адрес из подсказок'] });
    }
    if (!isAddressVerified(unloadingMeta)) {
      fields.push({ name: 'unloadingLocation', errors: ['Выберите адрес из подсказок'] });
    }
    if (fields.length) {
      form.setFields(fields);
      message.error('Адрес погрузки и разгрузки нужно выбрать из подсказок DaData');
      return;
    }
    saveMut.mutate(v);
  };

  // Отмена заявки требует причины — она вводится в отдельном окне.
  const [cancelTarget, setCancelTarget] = useState<VehicleRequestDto | null>(null);
  // Перевод в работу — выбор техники и ставок (ADR 0027): назначение уходит вместе со статусом.
  const [assignTarget, setAssignTarget] = useState<VehicleRequestDto | null>(null);
  // Выполнение — отработанное время и стоимость (ADR 0029): факт тоже уходит со статусом.
  const [completeTarget, setCompleteTarget] = useState<VehicleRequestDto | null>(null);
  // Смена машины у работающей заявки (ADR 0048) — своим запросом: статус при ней не меняется.
  const [reassignTarget, setReassignTarget] = useState<VehicleRequestDto | null>(null);
  /** Заявка, которую переносят в другой рейс (ADR 0052); null — окно переноса закрыто. */
  /** Заведение перегона: заявка и что именно заводим — доставку или вывоз. */
  const [relocation, setRelocation] = useState<{
    request: VehicleRequestDto;
    purpose: 'delivery' | 'pickup';
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<VehicleRequestDto | null>(null);

  const reassignMut = useMutation({
    mutationFn: (v: { id: string; version: number; assignment: AssignVehicleBody }) =>
      vehicleRequestsApi.changeAssignment(v.id, { ...v.assignment, version: v.version }),
    onSuccess: () => {
      message.success('Техника изменена');
      setReassignTarget(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      // Заявка переезжает в рейс новой машины — списки маршрутов после этого не те же.
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const statusMut = useMutation({
    mutationFn: (v: {
      id: string;
      status: RequestStatus;
      version: number;
      comment?: string;
      assignment?: AssignVehicleBody;
      /** Фактический срок, уточнённый при переводе в работу: заказывали на одно время, вышли на другое. */
      schedule?: ConfirmScheduleBody;
      completion?: CompleteVehicleRequestInput;
    }) =>
      vehicleRequestsApi.changeStatus(v.id, v.status, v.version, {
        comment: v.comment,
        assignment: v.assignment,
        schedule: v.schedule,
        completion: v.completion,
      }),
    onSuccess: () => {
      message.success('Статус изменён');
      setCancelTarget(null);
      setAssignTarget(null);
      setCompleteTarget(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const requestStatusChange = (r: VehicleRequestDto, status: RequestStatus) => {
    if (statusChangeRequiresReason(status)) {
      setCancelTarget(r);
      return;
    }
    // «В работе» без машины не бывает: заявку берут конкретной единицей и по конкретной ставке.
    if (transitionRequiresAssignment(status)) {
      setAssignTarget(r);
      return;
    }
    // Закрытие спрашивает факт — но только там, где есть чем считать: у заявки, взятой в работу
    // до ADR 0027, машины и ставки нет, и просить отработанное время не у чего. Так же решает
    // и сервер: факт обязателен при назначенной технике.
    if (transitionRequiresCompletion(status) && r.assignment) {
      setCompleteTarget(r);
      return;
    }
    statusMut.mutate({ id: r.id, status, version: r.version });
  };

  const approvalMut = useMutation({
    mutationFn: (v: { id: string; approved: boolean; version: number }) =>
      vehicleRequestsApi.setApproval(v.id, v.approved, v.version),
    onSuccess: (_res, v) => {
      message.success(v.approved ? 'Заявка завизирована' : 'Виза снята');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Снятие визы спрашиваем: заявка после этого перестаёт годиться в работу. */
  const requestApprovalChange = (r: VehicleRequestDto, approved: boolean) => {
    if (approved) {
      approvalMut.mutate({ id: r.id, approved, version: r.version });
      return;
    }
    modal.confirm({
      title: `Снять визу с заявки ${r.displayNumber}?`,
      content: 'Пока визы нет, заявку нельзя взять в работу.',
      okText: 'Снять визу',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => approvalMut.mutateAsync({ id: r.id, approved: false, version: r.version }),
    });
  };

  // Досрочное завершение (ADR 0044): запрос сокращения срока, решение по нему и отзыв. Действия
  // общие со срезом «На объекте» — там их и вызывают чаще, — поэтому живут одним хуком.
  const earlyEnd = useEarlyEnd();
  /** «Сегодня» по Москве: тем же днём применимость считает сервер (`earlyEndBlocker`). */
  const today = minRequestDateKey();
  /** Предикаты-сужения: досрочно завершают только заказ спецтехники, и окно ждёт именно его. */
  const earlyEndAllowed = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canEdit &&
    r.requestType === 'special_equipment' &&
    canRequestEarlyEnd(r, today) &&
    r.earlyEnd?.status !== 'pending';
  const decidableEarlyEnd = (r: VehicleRequestDto): r is SpecialEquipmentRequestDto =>
    canApprove && r.requestType === 'special_equipment' && r.earlyEnd?.status === 'pending';

  /**
   * Сменить назначенную машину (ADR 0048). Право — то же, которым заявку берут в работу: подбор
   * техники решает диспетчер, а не автор заявки. Состояние спрашивается предикатом из контрактов —
   * тем же, которым отвечает сервер, чтобы кнопка не предлагала отказ.
   */
  const reassignAllowed = (r: VehicleRequestDto) => canChangeStatus && canReassignVehicle(r);

  /** Кнопка смены техники — одна на обе ветки «Действий»: у арендодателя своя короткая. */
  const reassignButton = (r: VehicleRequestDto) => (
    <Tooltip title="Сменить технику">
      <Button
        size="small"
        icon={<SwapOutlined />}
        aria-label="Сменить технику"
        onClick={() => setReassignTarget(r)}
      />
    </Tooltip>
  );

  const removeMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.remove(id),
    onSuccess: (res) => {
      message.success(res.mode === 'hard' ? 'Удалено' : 'Перемещено в архив');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const canModify = (r: VehicleRequestDto) =>
    !r.deletedAt && (canEdit || canDelete) && (!isObjectRole || r.status === 'new');

  const confirmDelete = (r: VehicleRequestDto) =>
    modal.confirm({
      title:
        r.status === 'new'
          ? `Удалить заявку ${r.displayNumber} безвозвратно?`
          : `Переместить заявку ${r.displayNumber} в архив?`,
      okText: r.status === 'new' ? 'Удалить' : 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  // Единая таблица обоих типов: колонки чужого типа остаются пустыми.
  // Ключ колонки — он же поле сортировки на сервере (VEHICLE_REQUEST_SORT_FIELDS).
  //
  // Объём/массы и адресов погрузки-разгрузки в строке нет: они есть только у грузоперевозки, а
  // список читают по номеру, объекту и сроку. Всё это — в карточке заявки. Автор и тип заявки
  // тоже своих колонок не занимают: они уточняют номер и тип ТС и стоят вторыми строками к ним.
  const columns: TableColumnType<VehicleRequestDto>[] = [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 190,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Space size={6}>
            <UserAvatar name={r.createdByName} size={18} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.createdByName}
            </Typography.Text>
          </Space>
        </div>
      ),
    },
    // Ширина задана всем колонкам: при scroll.x='max-content' колонка без ширины тянется по
    // содержимому, и один длинный комментарий возвращал бы горизонтальный скролл всей таблице.
    // Заказчик заявки: объект или отдел (ADR 0040). Одна колонка на обе оси — у заявки заказчик
    // один, и вторая стояла бы пустой в каждой строке. Сортировка осталась по `objectName`:
    // ключ колонки — он же поле сортировки на сервере.
    textColumn({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: 230,
      render: (_v, r) => <ObjectCell name={requestCustomerName(r)} address={r.objectAddress} />,
    }),
    {
      key: 'vehicleTypeName',
      title: 'Тип/категория',
      dataIndex: 'vehicleTypeName',
      width: 200,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          {/* Заказанная позиция классификатора (ADR 0028): категория, а без неё — сам тип.
              Наименование категории уже начинается с типа, повторять его незачем. */}
          <div>
            {vehicleClassificationLabel({
              typeName: r.vehicleTypeName,
              categoryName: r.vehicleCategoryName,
            })}
          </div>
          {/* Подписи типов развёрнутые («Техника для работы на объекте») — тег переносится
              на вторую строку, иначе колонка растянулась бы на них одну строку в пол-экрана. */}
          <Tag
            color={vehicleRequestTypeColors[r.requestType]}
            style={{
              whiteSpace: 'normal',
              lineHeight: 1.25,
              maxWidth: '100%',
              wordBreak: 'break-word',
              marginTop: 2,
            }}
          >
            {vehicleRequestTypeLabels[r.requestType]}
          </Tag>
        </div>
      ),
    },
    {
      key: 'term',
      title: 'Срок',
      width: 170,
      // Срок у типов заявки лежит в разных полях — сортировку сводит сервер.
      sorter: true,
      // Досрочное завершение (ADR 0044) читается тут же: запрошенное — тегом «ждёт визы»,
      // состоявшееся — припиской, с какого числа срок сократили. Иначе заказ на две недели,
      // кончающийся послезавтра, выглядит опечаткой.
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{termLabel(r)}</div>
          {r.requestType === 'special_equipment' && <EarlyEndTag earlyEnd={r.earlyEnd} />}
        </div>
      ),
    },
    {
      // Назначенная техника (ADR 0027): у «Новой» заявки пусто, дальше — чем её взяли и почём.
      // Ставка второй строкой: без неё в списке видно «кто поехал», но не «во сколько встало».
      key: 'assignment',
      title: 'Техника',
      width: 200,
      render: (_v, r) =>
        r.assignment ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{assignmentTitle(r.assignment)}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {assignmentRateLabel(r.assignment) || r.assignment.lessorName || '—'}
            </Typography.Text>
          </div>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      /*
       * Рейс, в котором заявка едет. Пустая ячейка сама по себе ничего не значит — рейса нет ни у
       * «Новой», ни у аренды, ни у заказа техники на объект, — но грузоперевозка в работе на
       * собственной машине без рейса это потерянная заявка: лист по ней не выпишется, и в дне
       * машины её никто не увидит. Такую помечаем предупреждением.
       */
      key: 'route',
      title: 'Маршрут',
      width: 150,
      render: (_v, r) => {
        if (r.route) {
          return (
            <div style={{ lineHeight: 1.35 }}>
              <div>{r.route.displayNumber}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                талон {r.route.position}
                {r.route.hasWaybill ? ' · лист выписан' : ''}
              </Typography.Text>
            </div>
          );
        }
        const lost =
          r.status === 'confirmed' &&
          r.requestType === 'freight_transport' &&
          r.assignment?.ownership === 'own';
        return lost ? (
          <Tag color="orange">Без маршрута</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 150,
      sorter: true,
      render: (_v, r) => (
        <StatusCell
          status={r.status}
          deleted={!!r.deletedAt}
          approved={!!r.approvedAt}
          cancelReason={r.cancelReason}
          pending={statusMut.isPending && statusMut.variables?.id === r.id}
          onChange={(status) => requestStatusChange(r, status)}
        />
      ),
    },
    {
      // Виза руководителя строительства (ADR 0025): без неё диспетчер не берёт заявку в работу.
      key: 'approval',
      title: 'Согласование',
      width: 160,
      sorter: true,
      render: (_v, r) => (
        <ApprovalCell
          status={r.status}
          deleted={!!r.deletedAt}
          approved={!!r.approvedAt}
          approvedByName={r.approvedByName}
          approvedAt={r.approvedAt}
          canApprove={canApprove}
          pending={approvalMut.isPending && approvalMut.variables?.id === r.id}
          onChange={(approved) => requestApprovalChange(r, approved)}
        />
      ),
    },
    textColumn({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 230,
      ellipsis: true,
    }),
    {
      key: 'files',
      title: 'Файлы',
      width: 110,
      render: (_v, r) => <FilesCell files={r.files} />,
    },
    actionsColumn<VehicleRequestDto>((r) => {
      // Карточка открывается и у архивной заявки: понять, что и почему в ней было, можно
      // только там — в строке таблицы ни истории, ни адресов целиком нет.
      const view = (
        <Tooltip title="Открыть карточку">
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label="Открыть карточку"
            onClick={() => setViewRecord(r)}
          />
        </Tooltip>
      );
      if (r.deletedAt) {
        return (
          <Space size={4}>
            {view}
            {canRestore ? (
              <Tooltip title="Восстановить">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => restoreMut.mutate(r.id)}
                />
              </Tooltip>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>в архиве</Tag>
            )}
          </Space>
        );
      }
      // Роль без права вести заявки (наблюдатель) кнопок не видит: «выключено» читается как
      // «сейчас нельзя», а нельзя ей всегда. Смена техники живёт на своём праве (ADR 0048) и
      // спрашивается отдельно: у арендодателя правки заявки нет, а машину он подменяет свою.
      if (!canEdit && !canDelete) {
        return reassignAllowed(r) ? (
          <Space size={4}>
            {view}
            {reassignButton(r)}
          </Space>
        ) : (
          view
        );
      }
      const allowed = canModify(r);
      return (
        <Space size={4}>
          {view}
          {reassignAllowed(r) && reassignButton(r)}
          {/* Досрочное завершение (ADR 0044): у ожидающего визы запроса кнопка ведёт в карточку —
            решают, прочитав причину, а она там. Пока запроса нет — просят сокращение отсюда. */}
          {decidableEarlyEnd(r) ? (
            <Tooltip title="Ждёт визы на досрочное завершение">
              <Button
                size="small"
                icon={<FieldTimeOutlined />}
                onClick={() => setViewRecord(r)}
                aria-label="Досрочное завершение ждёт визы"
              />
            </Tooltip>
          ) : (
            earlyEndAllowed(r) && (
              <Tooltip title="Завершить досрочно">
                <Button
                  size="small"
                  icon={<FieldTimeOutlined />}
                  onClick={() => earlyEnd.open(r)}
                  aria-label="Завершить досрочно"
                />
              </Tooltip>
            )
          )}
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!allowed}
            onClick={() => openEdit(r)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!allowed}
            onClick={() => confirmDelete(r)}
          />
        </Space>
      );
    }, 150),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={requestTypeOptions}
        value={params.requestType as VehicleRequestType | undefined}
        onChange={(v: VehicleRequestType | undefined) => applyFilter({ requestType: v })}
      />
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 150 }}
        options={REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }))}
        value={params.status as RequestStatus | undefined}
        onChange={(v: RequestStatus | undefined) => applyFilter({ status: v })}
      />
      <Select
        allowClear
        placeholder="Любое согласование"
        style={{ width: 190 }}
        options={[
          { value: 'false', label: 'Ждут визы' },
          { value: 'true', label: 'Завизированные' },
        ]}
        value={params.approved}
        onChange={(v: string | undefined) => applyFilter({ approved: v })}
      />
      {/* Фильтр заказчика: роль отдела ищет по отделам, остальные — по объектам (ADR 0040).
          Обоих сразу не бывает — у заявки заказчик один, и второй фильтр всегда давал бы пусто. */}
      {isDepartmentRole ? (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все отделы"
          style={{ width: 240 }}
          options={departmentOptions}
          disabled={departmentFieldDisabled}
          value={params.departmentId}
          onChange={(v: string | undefined) => applyFilter({ departmentId: v })}
        />
      ) : (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все объекты"
          style={{ width: 240 }}
          options={objectOptions}
          disabled={objectFieldDisabled}
          value={params.objectId}
          onChange={(v: string | undefined) => applyFilter({ objectId: v })}
        />
      )}
      {/* Заказанная техника: тип целиком либо одна его категория (ADR 0028). */}
      {classificationFilter.controls}
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123)"
        style={{ width: 180 }}
        onSearch={(val) => applyFilter({ num: parseVehicleRequestNumberSearch(val) })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: params.requestType,
      options: requestTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: (v) => applyFilter({ requestType: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] })),
      placeholder: 'Все статусы',
      onChange: (v) => applyFilter({ status: v }),
    },
    {
      kind: 'select',
      key: 'approved',
      label: 'Согласование',
      value: params.approved,
      options: [
        { value: 'false', label: 'Ждут визы' },
        { value: 'true', label: 'Завизированные' },
      ],
      placeholder: 'Любое согласование',
      onChange: (v) => applyFilter({ approved: v }),
    },
    // Тот же фильтр заказчика, что в панели над таблицей: отдел либо объект (ADR 0040).
    isDepartmentRole
      ? ({
          kind: 'select',
          key: 'departmentId',
          label: 'Отдел',
          value: params.departmentId,
          options: departmentOptions,
          placeholder: 'Все отделы',
          disabled: departmentFieldDisabled,
          onChange: (v) => applyFilter({ departmentId: v }),
        } as const)
      : ({
          kind: 'select',
          key: 'objectId',
          label: 'Объект',
          value: params.objectId,
          options: objectOptions,
          // С одним объектом он зафиксирован; с несколькими выбор сужен до своих.
          placeholder: 'Все объекты',
          disabled: objectFieldDisabled,
          onChange: (v) => applyFilter({ objectId: v }),
        } as const),
    classificationFilter.mobileFilter,
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, ТС-123',
      onChange: (v) => applyFilter({ num: parseVehicleRequestNumberSearch(v ?? '') }),
    },
  ];

  /**
   * Строка списка на телефоне (ADR 0030): номер и статус, объект, что заказано и на когда, чем
   * взяли и во сколько встало. Виза — кнопкой прямо в карточке: у руководителя строительства это
   * главное действие списка, и прятать его в меню значило бы добавить к нему два касания.
   */
  const card: CardConfig<VehicleRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => (
      <StatusCell
        status={r.status}
        deleted={!!r.deletedAt}
        approved={!!r.approvedAt}
        cancelReason={r.cancelReason}
        pending={statusMut.isPending && statusMut.variables?.id === r.id}
        onChange={(status) => requestStatusChange(r, status)}
      />
    ),
    primary: (r) => requestCustomerName(r),
    lines: [
      (r) =>
        `${vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        })} · ${vehicleRequestTypeLabels[r.requestType]}`,
      (r) => `Срок: ${termLabel(r)}`,
      (r) =>
        r.assignment
          ? `${assignmentTitle(r.assignment)} · ${assignmentRateLabel(r.assignment) || r.assignment.lessorName || 'без ставки'}`
          : null,
      // Рейс и та же потерянная заявка, что помечена в таблице колонкой «Маршрут».
      (r) =>
        r.route ? (
          `Маршрут ${r.route.displayNumber} · талон ${r.route.position}`
        ) : r.status === 'confirmed' &&
          r.requestType === 'freight_transport' &&
          r.assignment?.ownership === 'own' ? (
          <Tag color="orange">Без маршрута</Tag>
        ) : null,
      (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
      (r) => r.comment || null,
      (r) => (
        <ApprovalCell
          status={r.status}
          deleted={!!r.deletedAt}
          approved={!!r.approvedAt}
          approvedByName={r.approvedByName}
          approvedAt={r.approvedAt}
          canApprove={canApprove}
          pending={approvalMut.isPending && approvalMut.variables?.id === r.id}
          onChange={(approved) => requestApprovalChange(r, approved)}
        />
      ),
      (r) => (r.files.length > 0 ? <FilesCell files={r.files} /> : null),
      (r) => (r.deletedAt ? <Tag>в архиве</Tag> : null),
    ],
    onOpen: (r) => setViewRecord(r),
    actions: (r) => {
      const view = {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      };
      if (r.deletedAt) {
        return canRestore
          ? [
              view,
              {
                key: 'restore',
                label: 'Восстановить',
                icon: <ReloadOutlined />,
                onClick: () => restoreMut.mutate(r.id),
              },
            ]
          : [view];
      }
      /** Смена техники (ADR 0048) — на своём праве, поэтому и в короткой ветке арендодателя. */
      const reassign = reassignAllowed(r)
        ? [
            {
              key: 'reassign',
              label: 'Сменить технику',
              icon: <SwapOutlined />,
              onClick: () => setReassignTarget(r),
            },
          ]
        : [];
      if (!canEdit && !canDelete) return [view, ...reassign];
      const allowed = canModify(r);
      return [
        view,
        ...reassign,
        ...(decidableEarlyEnd(r)
          ? [
              {
                key: 'approve-early-end',
                label: 'Согласовать досрочное завершение',
                icon: <FieldTimeOutlined />,
                onClick: () => earlyEnd.approve(r),
              },
              {
                key: 'reject-early-end',
                label: 'Отклонить досрочное завершение',
                danger: true,
                onClick: () => earlyEnd.reject(r),
              },
            ]
          : []),
        ...(earlyEndAllowed(r)
          ? [
              {
                key: 'early-end',
                label: 'Завершить досрочно',
                icon: <FieldTimeOutlined />,
                onClick: () => earlyEnd.open(r),
              },
            ]
          : []),
        {
          key: 'edit',
          label: 'Редактировать',
          icon: <EditOutlined />,
          disabled: !allowed,
          onClick: () => openEdit(r),
        },
        {
          key: 'delete',
          label: r.status === 'new' ? 'Удалить' : 'Переместить в архив',
          icon: <DeleteOutlined />,
          danger: true,
          disabled: !allowed,
          onClick: () => confirmDelete(r),
        },
      ];
    },
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        canCreate ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Создать заявку
          </Button>
        ) : null
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
      }}
    >
      {/* Сводка — на уровне вкладок, над фильтрами и кнопкой: она относится ко всему списку. */}
      <TabsExtra tabKey="requests">
        <SummaryBar title="Заявок" items={summaryItems} />
      </TabsExtra>

      <DataTable<VehicleRequestDto>
        columns={columns}
        card={card}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? `Заявка ${record.displayNumber}` : 'Новая заявка на автотехнику'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={880}
      >
        {/* Поля парами (FormGrid): в одну колонку форма заявки не помещается в экран и половину
            полей прячет под прокрутку. На телефоне колонка одна, порядок полей тот же. */}
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <FormGrid>
            {/* Заказчик заявки (ADR 0040): у новой ось задаёт роль — отдел заказывает от отдела,
              остальные от объекта, — у заведённой сама заявка (`departmentCustomer`). Два поля
              рядом не показываются никогда: заказчик у заявки один. */}
            {departmentCustomer ? (
              <Form.Item
                name="departmentId"
                label="Отдел"
                rules={[{ required: true, message: 'Выберите отдел' }]}
              >
                <AutoSelect
                  options={formDepartmentOptions}
                  loading={departmentsLoading}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Отдел"
                  disabled={departmentFieldDisabled}
                />
              </Form.Item>
            ) : (
              <Form.Item
                name="objectId"
                label="Объект"
                rules={[{ required: true, message: 'Выберите объект' }]}
              >
                <AutoSelect
                  options={formObjectOptions}
                  loading={objectsLoading}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Объект"
                  disabled={objectFieldDisabled}
                />
              </Form.Item>
            )}
            {/* Тип заявки неизменяем после создания (сервер отдаёт 422) — при правке поле заперто. */}
            <Form.Item
              name="requestType"
              label="Тип заявки"
              tooltip="Заказ техники на объект — техника любого вида; грузоперевозка — только грузовая"
              rules={[{ required: true, message: 'Выберите тип заявки' }]}
            >
              <AutoSelect
                options={formRequestTypeOptions}
                placeholder="Выберите тип заявки"
                // Заперто и при правке (тип неизменяем), и когда роли доступен один тип: выбор,
                // которого нет, поле обещать не должно.
                disabled={!!record || requestTypeOptions.length === 1}
                onChange={handleRequestTypeChange}
              />
            </Form.Item>
            {/* Позиция классификатора — во всю ширину: подписи вроде «Автокраны, г/п 130 т» в
              половине окна обрезаются там, где начинается отличие одной от другой. */}
            <FormGrid.Full>
              <VehicleClassificationSelect
                groups={typeGroups}
                loading={typesLoading}
                disabled={!watchRequestType}
                placeholder={
                  watchRequestType ? 'Выберите тип или категорию' : 'Сначала выберите тип заявки'
                }
              />
            </FormGrid.Full>

            {/* Техника на объект: период работы. Новую заявку назначают не раньше чем на сегодня
              (по МСК); у заведённой дата правится свободно, лишь бы не в прошлое. */}
            {isSpecial && (
              // Даты — соседними ячейками сетки: пара «начало — окончание» читается вместе.
              <>
                <Form.Item
                  name="dateFrom"
                  label="Дата начала"
                  rules={[{ required: true, message: 'Укажите дату начала' }]}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    disabledDate={minDateRule}
                  />
                </Form.Item>
                <Form.Item
                  name="dateTo"
                  label="Дата окончания"
                  // Число дней (столько техника занята на объекте) — подписью под полем: в сетке из
                  // двух колонок отдельной колонки под него уже нет. У работающей заявки здесь же
                  // сказано, чем сокращают срок: правкой его сократить нельзя (ADR 0044).
                  extra={
                    dateToLocked
                      ? 'Срок работающей техники сокращают досрочным завершением — с визой'
                      : periodHint
                  }
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    // Продление правкой остаётся, сокращение — нет: то же правило проверяет
                    // сервер, и предлагать дату, которую он отклонит, портал не должен.
                    disabledDate={dateToLocked ? isBeforeCurrentDateTo : minDateRule}
                  />
                </Form.Item>
                {/* Кто встречает технику на объекте: без контакта заезд и место работ выясняются
                  звонками через диспетчера уже на воротах. */}
                <FormGrid.Full>
                  <ResponsibleFields
                    nameField="responsibleName"
                    phoneField="responsiblePhone"
                    nameLabel="Ответственный на объекте"
                    phoneLabel="Контактный телефон"
                  />
                </FormGrid.Full>
              </>
            )}

            {/* Грузоперевозка: дата/время, объём или масса, адреса. */}
            {isFreight && (
              <>
                <Form.Item
                  name="scheduledDate"
                  label="Дата подачи"
                  rules={[{ required: true, message: 'Укажите дату' }]}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
                    inputReadOnly={isMobile}
                    disabledDate={minDateRule}
                  />
                </Form.Item>
                <Form.Item
                  name="scheduledTime"
                  label="Время (МСК)"
                  tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
                  rules={[optionalWorkTimeRule]}
                >
                  <TimeInput />
                </Form.Item>
                {/* Груз: одного из двух достаточно. У легковой машины его не спрашивают вовсе —
                  в её бланке (форма № 3) графа «Груз» заполняется от руки в те редкие рейсы,
                  когда что-то везут. */}
                <Form.Item
                  name="volumeM3"
                  label="Объём, м³"
                  tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
                >
                  <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
                </Form.Item>
                <Form.Item
                  name="weightTons"
                  label="Масса, т"
                  tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
                >
                  <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
                </Form.Item>
                {/* Адреса и контакты — во всю ширину: подсказка DaData приходит одной длинной
                  строкой, и в половине окна выбирать пришлось бы из обрезанных вариантов. */}
                <FormGrid.Full>
                  <Form.Item
                    name="loadingLocation"
                    label="Место погрузки"
                    rules={[{ required: true, message: 'Укажите место погрузки' }]}
                  >
                    <AddressAutoComplete
                      placeholder="Начните вводить адрес"
                      onMetaChange={setLoadingMeta}
                    />
                  </Form.Item>
                  {/* Контакт стоит под своим адресом, а не общим блоком в конце формы: погрузка и
                    разгрузка — два разных места, и водитель ищет того, кто откроет ворота здесь. */}
                  <ResponsibleFields
                    nameField="loadingResponsibleName"
                    phoneField="loadingResponsiblePhone"
                    nameLabel="Ответственный за погрузку"
                    phoneLabel="Телефон"
                  />
                  <Form.Item
                    name="unloadingLocation"
                    label="Место разгрузки"
                    rules={[{ required: true, message: 'Укажите место разгрузки' }]}
                  >
                    <AddressAutoComplete
                      placeholder="Начните вводить адрес"
                      onMetaChange={setUnloadingMeta}
                    />
                  </Form.Item>
                  <ResponsibleFields
                    nameField="unloadingResponsibleName"
                    phoneField="unloadingResponsiblePhone"
                    nameLabel="Ответственный за разгрузку"
                    phoneLabel="Телефон"
                  />
                </FormGrid.Full>
              </>
            )}

            {/* Заголовок и пример заполнения зависят от типа заявки (COMMENT_HINTS). */}
            <FormGrid.Full>
              <Form.Item name="comment" label={commentHint?.label ?? 'Комментарий'}>
                <Input.TextArea rows={3} maxLength={2000} placeholder={commentHint?.placeholder} />
              </Form.Item>
              <Form.Item label="Файлы">
                <FileEditor editor={editor} />
              </Form.Item>
            </FormGrid.Full>
          </FormGrid>
        </Form>
      </FormModal>

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <VehicleRequestViewModal
        request={viewRecord}
        onClose={() => setViewRecord(null)}
        // Решение по досрочному завершению принимают, прочитав причину, — а она в карточке.
        // Решённый запрос кнопок не получает: согласованный уже сократил срок, отклонённый
        // объясняет, почему этого не случилось.
        earlyEndActions={(r) => {
          if (r.requestType !== 'special_equipment' || r.earlyEnd?.status !== 'pending') {
            return null;
          }
          return (
            <Space size={8} wrap>
              {canApprove && (
                <>
                  <Button size="small" type="primary" onClick={() => earlyEnd.approve(r)}>
                    Согласовать
                  </Button>
                  <Button size="small" danger onClick={() => earlyEnd.reject(r)}>
                    Отклонить
                  </Button>
                </>
              )}
              {/* Отзывает тот, кто мог и подать: отбой приходит и диспетчеру, и площадке. */}
              {canEdit && (
                <Button size="small" onClick={() => earlyEnd.withdraw(r)}>
                  Отозвать запрос
                </Button>
              )}
            </Space>
          );
        }}
        onEdit={
          viewRecord && canModify(viewRecord)
            ? (r) => {
                setViewRecord(null);
                openEdit(r);
              }
            : undefined
        }
        // Смена машины прямо из карточки (ADR 0048): поле «Техника» видно здесь, и менять его
        // логично здесь же, а не возвращаясь в строку списка.
        onReassign={
          viewRecord && reassignAllowed(viewRecord)
            ? (r) => {
                setViewRecord(null);
                setReassignTarget(r);
              }
            : undefined
        }
        // Перенос заявки в другой рейс (ADR 0052) — тем же правом, что и ход заявки: рейс это
        // ход работы по ней. Карточка закрывается, потому что после переноса её поля устареют —
        // заявка уедет в другой рейс, а с ним, возможно, и на другую машину.
        onTransfer={
          viewRecord && canChangeStatus && viewRecord.route && !viewRecord.route.hasWaybill
            ? (r) => {
                setViewRecord(null);
                setTransferTarget(r);
              }
            : undefined
        }
        // Перегон техники (миграция 0082) — тем же правом, что и ход заявки: рейс это ход работы
        // по ней. Предлагается у заказа техники на объект в работе: доставку и вывоз выписывают
        // на назначенную машину, а её нет ни у новой заявки, ни у арендной.
        onRelocate={
          viewRecord &&
          canChangeStatus &&
          viewRecord.requestType === 'special_equipment' &&
          viewRecord.status === 'confirmed' &&
          viewRecord.assignment?.ownership === 'own'
            ? (r, purpose) => {
                setViewRecord(null);
                setRelocation({ request: r, purpose });
              }
            : undefined
        }
      />

      {/* Доставка техники на объект и вывоз с него: рейс перемещения, по которому выписывается
        4-П. Заводится по желанию — технику могут привезти тралом. */}
      <VehicleRelocationModal
        request={relocation?.request ?? null}
        purpose={relocation?.purpose ?? 'delivery'}
        onClose={() => setRelocation(null)}
        onDone={() => setRelocation(null)}
      />

      {/* Перенос заявки из рейса в рейс: подходящие рейсы того же дня и того же типа техники. */}
      <VehicleRouteTransferModal
        request={transferTarget}
        onClose={() => setTransferTarget(null)}
        onDone={() => setTransferTarget(null)}
      />

      {/* Перевод в работу: техника, ставки (ADR 0027) и фактический срок. Всё уходит тем же
          запросом, что и смена статуса, — заявка не бывает «в работе» ни на чём и не бывает
          взятой на одно время с путевым листом на другое. */}
      <VehicleAssignModal
        request={assignTarget}
        confirmLoading={statusMut.isPending}
        onCancel={() => setAssignTarget(null)}
        onSubmit={({ assignment, schedule }) =>
          assignTarget &&
          statusMut.mutate({
            id: assignTarget.id,
            status: 'confirmed',
            version: assignTarget.version,
            assignment,
            // Срок при переводе в работу окно спрашивает всегда — `null` сюда не приходит.
            schedule: schedule ?? undefined,
          })
        }
      />

      {/* Смена техники у заявки в работе (ADR 0048): то же окно подбора, но без фактического
          срока — он уже согласован, и меняется только чем заявку выполняют. */}
      <VehicleAssignModal
        request={reassignTarget}
        mode="reassign"
        confirmLoading={reassignMut.isPending}
        onCancel={() => setReassignTarget(null)}
        onSubmit={({ assignment }) =>
          reassignTarget &&
          reassignMut.mutate({
            id: reassignTarget.id,
            version: reassignTarget.version,
            assignment,
          })
        }
      />

      {/* Выполнение: отработанное время и стоимость (ADR 0029). Факт уходит тем же запросом,
          что и статус, — заявка не бывает выполненной без ответа «сколько стоило». */}
      {/* Досрочное завершение — то же окно, что и на вкладке «На объекте» (ADR 0044). */}
      <VehicleEarlyEndModal
        request={earlyEnd.target}
        onDate={today}
        approvesOwn={earlyEnd.approvesOwn}
        confirmLoading={earlyEnd.pending}
        onCancel={earlyEnd.close}
        onSubmit={earlyEnd.submit}
      />

      <VehicleCompleteModal
        request={completeTarget}
        confirmLoading={statusMut.isPending}
        onCancel={() => setCompleteTarget(null)}
        onSubmit={({ completion, comment }) =>
          completeTarget &&
          statusMut.mutate({
            id: completeTarget.id,
            status: 'done',
            version: completeTarget.version,
            comment,
            completion,
          })
        }
      />

      <CancelReasonModal
        open={!!cancelTarget}
        subject={cancelTarget ? `№ ${cancelTarget.displayNumber}` : ''}
        confirmLoading={statusMut.isPending}
        onCancel={() => setCancelTarget(null)}
        onSubmit={(reason) =>
          cancelTarget &&
          statusMut.mutate({
            id: cancelTarget.id,
            status: 'cancelled',
            version: cancelTarget.version,
            comment: reason,
          })
        }
      />
    </PageTableLayout>
  );
}
