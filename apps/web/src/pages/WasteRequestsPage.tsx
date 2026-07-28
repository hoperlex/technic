import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Dropdown,
  Form,
  Input,
  InputNumber,
  List,
  Popover,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  allowedStatusTransitions,
  MIN_WASTE_VOLUME_M3,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  requestStatusColors,
  requestStatusLabels,
  statusChangeRequiresReason,
  requestTypeColors,
  requestTypeLabels,
  requestTypeShort,
  normalizeTimeInput,
  calcWasteAmount,
  isPricedRequestType,
  requiresWasteVehicles,
  isVolumeAllowed,
  volumeStepMessage,
  type WasteRequestDto,
  type WasteRequestVehicleDto,
} from '@technic/contracts';
import {
  containerTypesApi,
  counterpartiesApi,
  filesApi,
  objectsApi,
  wasteRequestsApi,
  wasteTariffsApi,
  wasteTypesApi,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '../api/resources';
import { CancelReasonModal } from '../components/CancelReasonModal';
import {
  emptyVehicleDraft,
  draftsToInput,
  sumDraftVolume,
  validateVehicleDrafts,
  VolumeSummary,
  WasteVehiclesEditor,
  type VehicleDraft,
} from '../components/WasteVehiclesEditor';
import { DataTable } from '../components/DataTable';
import { FormModal } from '../components/FormModal';
import { PageTableLayout } from '../components/PageTableLayout';
import { SummaryBar } from '../components/SummaryBar';
import { actionsColumn, badgeColumn, textColumn } from '../components/columns';
import { TimeInput, optionalWorkTimeRule } from '../components/TimeInput';
import { useListParams } from '../hooks/useListParams';
import { useAuth } from '../auth/AuthContext';
import { MOSCOW_TZ } from '../theme';
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatDateTimeMaybe,
  formatMoney,
} from '../utils/format';
import { applyApiFieldErrors } from '../utils/formErrors';
import { isPastDate, startOfToday } from '../utils/date';
import { OnSiteTab } from './waste/OnSiteTab';
import { WasteRequestViewModal } from './waste/WasteRequestViewModal';

const FILE_MAX_SIZE = 52_428_800; // 50 МБ
const FILE_MAX_COUNT = 20;

interface EditorFile {
  id: string;
  filename: string;
  size: number;
  isNew: boolean;
}

interface RequestFormValues {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  wasteTypeId?: string;
  volumeM3?: number;
  /** Оператор вывоза (контрагент); можно не выбирать — назначается при переводе в работу. */
  operatorCounterpartyId?: string;
  deliveryDate: Dayjs;
  /** Необязательное время в виде `HH:mm`; пусто — «на эту дату, время не важно». */
  deliveryTime?: string;
  comment?: string;
}

/** Человекочитаемое описание предмета заявки для колонки списка. */
function requestSubject(r: WasteRequestDto): string {
  // У тарифицируемых операций объём — часть предмета заявки: он определяет сумму (ADR 0009).
  if (isPricedRequestType(r.requestType)) {
    const parts = [r.containerTypeName, r.volumeM3 != null ? `${r.volumeM3} м³` : null].filter(
      Boolean,
    );
    return parts.length ? parts.join(', ') : '—';
  }
  // container_install — только тип контейнера
  return r.containerTypeName ?? '—';
}

export function WasteRequestsPage() {
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="requests"
        items={[
          { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
          { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
        ]}
      />
    </div>
  );
}

function RequestsTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { user, hasRole } = useAuth();
  const isShtab = hasRole('shtab');
  const isAdmin = hasRole('admin');
  // Оператор вывоза видит только свои заявки и только закрывает их: заводить, править и
  // удалять заявки, как и назначать исполнителя, он не может (ADR 0010).
  const isOperator = hasRole('operator');
  const canAssignOperator = hasRole('admin', 'manager', 'dispatcher');

  // Для штаба фильтр по объекту зафиксирован на его объекте.
  const shtabObjectId = isShtab ? (user?.constructionObjectId ?? '') : '';

  const { params, setParams, onTableChange } = useListParams<{
    status?: string;
    requestType?: string;
    objectId?: string;
    num?: number;
  }>(
    { objectId: shtabObjectId || undefined },
    {
      searchKeys: ['comment'],
      mapFilters: (f) => ({
        status: f.status?.[0] as string | undefined,
        requestType: f.requestType?.[0] as string | undefined,
      }),
    },
  );

  // Внешние фильтры над таблицей (только на вкладке «Заявки»).
  const [objectFilter, setObjectFilter] = useState(shtabObjectId);
  const [numInput, setNumInput] = useState('');
  const applyObjectFilter = (v: string) => {
    setObjectFilter(v);
    setParams((p) => ({ ...p, page: 1, objectId: v || undefined }));
  };
  const applyNumFilter = (raw: string) => {
    setNumInput(raw);
    // из «123-У» берём числовую часть (num уникален; суффикс — только отображение)
    const digits = raw.match(/\d+/)?.[0];
    setParams((p) => ({ ...p, page: 1, num: digits ? Number(digits) : undefined }));
  };

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', params],
    queryFn: () => wasteRequestsApi.list(params),
  });

  // Сводка в шапке: сколько заявок ждёт обработки и сколько в работе. Ключ начинается с
  // 'waste-requests' — значит счётчики обновляются теми же инвалидациями, что и список.
  const { data: summary } = useQuery({
    queryKey: ['waste-requests', 'summary', params.objectId],
    queryFn: () => wasteRequestsApi.summary({ objectId: params.objectId }),
  });
  // Оператор заявки не обрабатывает — он их выполняет (ADR 0010): «Новых» у него не бывает,
  // они появляются в его списке уже переведёнными в работу.
  const summaryItems = [
    ...(isOperator ? [] : [{ label: 'Не обработанных', value: summary?.new ?? 0 }]),
    { label: requestStatusLabels.confirmed, value: summary?.confirmed ?? 0 },
  ];

  const { data: objects } = useQuery({
    queryKey: ['objects', 'for-select'],
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const { data: types } = useQuery({
    queryKey: ['container-types', 'for-select'],
    queryFn: () =>
      containerTypesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const objectOptions = (objects?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));
  const allTypes = types?.items ?? [];
  // Установка — только контейнеры (type='cont').
  const contTypeOptions = allTypes
    .filter((t) => t.type === 'cont')
    .map((t) => ({ value: t.id, label: t.name }));
  // Вывоз мусора выполняется самосвалами: контейнерные типы относятся к замене и снятию.
  const truckTypes = allTypes.filter((t) => t.type === 'truck');
  const truckTypeOptions = truckTypes.map((t) => ({ value: t.id, label: t.name }));
  // Машины при закрытии заявки — те же самосвалы, но с вместимостью: она и есть объём рейса
  // (ADR 0011), поэтому нужна клиенту для подстановки и сверки.
  const vehicleTypeOptions = truckTypes.map((t) => ({
    value: t.id,
    label: t.name,
    volumeM3: t.volumeM3,
  }));
  const requestTypeOptions = REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] }));

  // Типы мусора — для тарифицируемых операций (замена / снятие / вывоз), ADR 0009.
  const { data: wasteTypes } = useQuery({
    queryKey: ['waste-types', 'for-select'],
    queryFn: () =>
      wasteTypesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const wasteTypeOptions = (wasteTypes?.items ?? []).map((w) => ({ value: w.id, label: w.name }));

  // Операторы вывоза — контрагенты соответствующего типа (ADR 0010). Оператору этот список
  // не нужен: исполнителя он не выбирает.
  const { data: operatorsData } = useQuery({
    queryKey: ['counterparties', 'operators-for-select'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: canAssignOperator,
  });
  /**
   * Исполнителя выбираем среди операторов, привязанных к объекту заявки (ADR 0010). Правило
   * повторяет серверное: объект, у которого операторы не заведены, список не сужает — иначе на
   * новом объекте выбрать было бы некого. Уже назначенный оператор остаётся в списке, даже если
   * привязку сняли: иначе форма показала бы вместо него идентификатор.
   */
  const operatorOptionsFor = (
    objectId: string | undefined,
    assigned?: { id: string | null; name: string | null },
  ) => {
    const all = operatorsData?.items ?? [];
    const linked = objectId ? all.filter((c) => c.objects.some((o) => o.id === objectId)) : [];
    const options = (linked.length > 0 ? linked : all).map((c) => ({ value: c.id, label: c.name }));
    if (assigned?.id && !options.some((o) => o.value === assigned.id)) {
      options.unshift({ value: assigned.id, label: assigned.name ?? assigned.id });
    }
    return options;
  };

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  // Просмотр заявки — отдельное окно, только чтение: в таблице нет места ни автору, ни цене за
  // м³, ни машинам, а разбирать конкретную заявку без них нельзя (ADR 0012).
  const [viewRecord, setViewRecord] = useState<WasteRequestDto | null>(null);
  const [form] = Form.useForm<RequestFormValues>();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const watchObjectId = Form.useWatch('objectId', form);
  const watchRequestType = Form.useWatch('requestType', form);
  const watchContainerTypeId = Form.useWatch('containerTypeId', form);
  const watchWasteTypeId = Form.useWatch('wasteTypeId', form);
  const watchVolumeM3 = Form.useWatch('volumeM3', form);

  // Тарифицируемые операции: замена, снятие, вывоз. Установка нового контейнера цены не имеет.
  const isPriced = watchRequestType ? isPricedRequestType(watchRequestType) : false;

  // Машины заявки в форме редактирования (ADR 0011): новые строки и действия над заведёнными.
  // Пометку ставит любой, кто правит заявку; удалить насовсем может только администратор.
  const [vehicleDrafts, setVehicleDrafts] = useState<VehicleDraft[]>([]);
  const [vehicleMarks, setVehicleMarks] = useState<
    Record<string, 'marked' | 'restored' | 'deleted'>
  >({});
  const isVehicleDeleted = (v: WasteRequestVehicleDto): boolean => {
    const mark = vehicleMarks[v.id];
    if (mark === 'marked') return true;
    if (mark === 'restored') return false;
    return v.isDeleted;
  };
  const setVehicleMark = (id: string, mark: 'marked' | 'restored' | 'deleted' | null) =>
    setVehicleMarks((prev) => {
      const next = { ...prev };
      if (mark === null) delete next[id];
      else next[id] = mark;
      return next;
    });
  // В сверке участвуют только те, что останутся активными после сохранения.
  const editVehiclesVolume =
    (record?.vehicles ?? []).reduce(
      (acc, v) =>
        vehicleMarks[v.id] === 'deleted' || isVehicleDeleted(v) ? acc : acc + v.volumeM3,
      0,
    ) + sumDraftVolume(vehicleDrafts, vehicleTypeOptions);

  // Выбор исполнителя в форме следует за выбранным объектом: сменили объект — сменился список.
  const formOperatorOptions = operatorOptionsFor(watchObjectId, {
    id: record?.operatorCounterpartyId ?? null,
    name: record?.operatorName ?? null,
  });

  // Предпросмотр цены: тариф подбирает сервер по паре «тип мусора × техника», чтобы форма и
  // расчёт при сохранении не разошлись. 404 (тарифа нет) — штатный ответ, не ошибка ввода.
  const { data: tariff, isError: tariffMissing } = useQuery({
    queryKey: ['waste-tariffs', 'resolve', watchWasteTypeId, watchContainerTypeId],
    queryFn: () => wasteTariffsApi.resolve(watchWasteTypeId!, watchContainerTypeId!),
    enabled: isPriced && !!watchWasteTypeId && !!watchContainerTypeId,
    retry: false,
  });
  const volumeStepM3 = tariff?.volumeStepM3 ?? null;
  const amountPreview =
    tariff && watchVolumeM3 != null && isVolumeAllowed(watchVolumeM3, volumeStepM3)
      ? calcWasteAmount(watchVolumeM3, tariff.pricePerM3)
      : null;

  // Наличие контейнеров на объекте (view: установки − снятия). Для «Замены» и «Снятия».
  const { data: presentData } = useQuery({
    queryKey: ['waste-requests', 'present-for-object', watchObjectId],
    queryFn: () => wasteRequestsApi.present({ objectId: watchObjectId, pageSize: 500 }),
    enabled: !!watchObjectId,
  });
  // Уникальные присутствующие типы контейнеров на объекте.
  const presentTypeMap = new Map<string, string>();
  for (const r of presentData?.items ?? []) {
    if (!r.containerTypeId) continue;
    if (!presentTypeMap.has(r.containerTypeId)) {
      presentTypeMap.set(r.containerTypeId, r.containerTypeName ?? 'Контейнер');
    }
  }
  const presentTypeOptions = [...presentTypeMap].map(([value, label]) => ({ value, label }));
  const objectHasPresent = presentTypeOptions.length > 0;

  // Первое поле тарифицируемой строки: для замены и снятия выбор ограничен контейнерами,
  // которые сейчас стоят на объекте; для вывоза — самосвалы из справочника.
  const fromObjectField = {
    options: presentTypeOptions,
    placeholder: 'Тип, присутствующий на объекте',
    fromObject: true,
  };
  const subjectFieldByType = {
    container_replace: {
      label: 'Тип заменяемого контейнера',
      message: 'Выберите тип контейнера для замены',
      ...fromObjectField,
    },
    container_removal: {
      label: 'Тип снимаемого контейнера',
      message: 'Выберите тип контейнера для снятия',
      ...fromObjectField,
    },
    waste_removal: {
      label: 'Тип самосвала',
      message: 'Выберите тип самосвала',
      options: truckTypeOptions,
      placeholder: 'Чем вывозим',
      fromObject: false,
    },
  } as const;
  const subjectField =
    watchRequestType && watchRequestType !== 'container_install'
      ? subjectFieldByType[watchRequestType]
      : null;

  const openCreate = () => {
    setRecord(null);
    setFiles([]);
    setRemovedIds([]);
    setVehicleDrafts([]);
    setVehicleMarks({});
    form.resetFields();
    // Дата доставки по умолчанию — сегодня.
    form.setFieldsValue({ deliveryDate: startOfToday() } as Partial<RequestFormValues>);
    if (isShtab && user?.constructionObjectId) {
      form.setFieldsValue({ objectId: user.constructionObjectId } as Partial<RequestFormValues>);
    }
    setOpen(true);
  };
  const openEdit = (r: WasteRequestDto) => {
    setRecord(r);
    setFiles(r.files.map((f) => ({ id: f.id, filename: f.filename, size: f.size, isNew: false })));
    setRemovedIds([]);
    setVehicleDrafts([]);
    setVehicleMarks({});
    form.resetFields();
    form.setFieldsValue({
      objectId: r.objectId,
      requestType: r.requestType,
      containerTypeId: r.containerTypeId ?? undefined,
      wasteTypeId: r.wasteTypeId ?? undefined,
      volumeM3: r.volumeM3 ?? undefined,
      operatorCounterpartyId: r.operatorCounterpartyId ?? undefined,
      deliveryDate: dayjs(r.deliveryAt).tz(MOSCOW_TZ),
      // Время не задано — поле остаётся пустым (в deliveryAt лежит полночь МСК).
      deliveryTime: r.deliveryTimeUnspecified
        ? undefined
        : dayjs(r.deliveryAt).tz(MOSCOW_TZ).format('HH:mm'),
      comment: r.comment,
    });
    setOpen(true);
  };

  // Смена типа заявки очищает поля предыдущего варианта.
  const handleRequestTypeChange = () => {
    form.setFieldsValue({
      containerTypeId: undefined,
      wasteTypeId: undefined,
      volumeM3: undefined,
    });
  };
  // Смена объекта сбрасывает тип: для «Замены» список зависит от установок объекта.
  const handleObjectChange = () => {
    form.setFieldsValue({ containerTypeId: undefined });
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setFiles((prev) => [
        ...prev,
        { id: uploaded.id, filename: uploaded.filename, size: uploaded.size, isNew: true },
      ]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (item: EditorFile) => {
    if (item.isNew) {
      await filesApi.remove(item.id).catch(() => {});
    } else {
      setRemovedIds((prev) => [...prev, item.id]);
    }
    setFiles((prev) => prev.filter((f) => f.id !== item.id));
  };

  const saveMut = useMutation({
    mutationFn: (values: RequestFormValues) => {
      // Дата и время собираются в МСК — в этом же поясе сервер проверяет рабочее окно.
      // Время не задано → полночь МСК + признак: заявка «на дату», без конкретного часа.
      const time = normalizeTimeInput(values.deliveryTime ?? '');
      const deliveryAt = dayjs.tz(
        `${values.deliveryDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`,
        MOSCOW_TZ,
      );
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        // все четыре типа заявки ссылаются на тип из справочника
        containerTypeId: values.containerTypeId,
        // Тип мусора и объём — только у тарифицируемых операций (ADR 0009).
        wasteTypeId: isPricedRequestType(values.requestType) ? values.wasteTypeId : undefined,
        volumeM3: isPricedRequestType(values.requestType) ? values.volumeM3 : undefined,
        // Исполнителя назначает диспетчер; у остальных ролей поля в форме нет (ADR 0010).
        operatorCounterpartyId: canAssignOperator ? values.operatorCounterpartyId : undefined,
        deliveryAt: deliveryAt.toISOString(),
        deliveryTimeUnspecified: time === undefined,
        comment: values.comment ?? '',
      };
      if (record) {
        const marked = (id: string, mark: string) => vehicleMarks[id] === mark;
        const ids = record.vehicles.map((v) => v.id);
        const payload: WasteRequestUpdatePayload = {
          ...base,
          // Пустое поле у диспетчера означает «снять исполнителя» — это null, а не «не менять».
          operatorCounterpartyId: canAssignOperator
            ? (values.operatorCounterpartyId ?? null)
            : undefined,
          addFileIds: files.filter((f) => f.isNew).map((f) => f.id),
          removeFileIds: removedIds,
          addVehicles: vehicleDrafts.length > 0 ? draftsToInput(vehicleDrafts) : undefined,
          markDeletedVehicleIds: ids.filter((id) => marked(id, 'marked')),
          restoreVehicleIds: ids.filter((id) => marked(id, 'restored')),
          deleteVehicleIds: ids.filter((id) => marked(id, 'deleted')),
          version: record.version,
        };
        return wasteRequestsApi.update(record.id, payload);
      }
      const payload: WasteRequestPayload = {
        ...base,
        fileIds: files.filter((f) => f.isNew).map((f) => f.id),
      };
      return wasteRequestsApi.create(payload);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
      setOpen(false);
    },
    onError: (e) => {
      // Ошибку валидации показываем на самом поле: тост «Ошибка валидации данных» не говорит,
      // что именно править. `deliveryAt` в форме разложен на дату и время — правим дату.
      applyApiFieldErrors(form, e, { deliveryAt: 'deliveryDate' });
      message.error(errorMessage(e));
    },
  });

  // Переход в работу и отмена проходят через модальные окна — оба требуют ввода
  // (оператор вывоза, причина отмены), поэтому целевая заявка хранится в состоянии.
  const [operatorTarget, setOperatorTarget] = useState<WasteRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WasteRequestDto | null>(null);
  const [operatorForm] = Form.useForm<{ operatorCounterpartyId: string }>();
  // Список в модальном окне назначения сужается по объекту той заявки, которую переводят в работу.
  const assignOperatorOptions = operatorOptionsFor(operatorTarget?.objectId, {
    id: operatorTarget?.operatorCounterpartyId ?? null,
    name: operatorTarget?.operatorName ?? null,
  });

  // Закрытие заявки: машины с талонами вводятся в отдельном окне и уходят вместе со статусом.
  const [doneTarget, setDoneTarget] = useState<WasteRequestDto | null>(null);
  const [doneDrafts, setDoneDrafts] = useState<VehicleDraft[]>([]);

  const statusMut = useMutation({
    mutationFn: (v: {
      id: string;
      status: RequestStatus;
      version: number;
      comment?: string;
      vehicles?: VehicleDraft[];
    }) =>
      wasteRequestsApi.changeStatus(
        v.id,
        v.status,
        v.version,
        v.comment,
        v.vehicles ? draftsToInput(v.vehicles) : [],
      ),
    onSuccess: () => {
      setOperatorTarget(null);
      setCancelTarget(null);
      setDoneTarget(null);
      setDoneDrafts([]);
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

  /**
   * Перевод в работу назначает исполнителя: с этого момента заявку видит оператор, который её
   * выполняет (ADR 0010). Два запроса подряд — назначение меняет версию заявки, поэтому статус
   * переводится уже по обновлённой версии.
   */
  const startWorkMut = useMutation({
    mutationFn: async (v: { r: WasteRequestDto; operatorCounterpartyId: string }) => {
      const assigned = await wasteRequestsApi.assignOperator(
        v.r.id,
        v.operatorCounterpartyId,
        v.r.version,
      );
      return wasteRequestsApi.changeStatus(assigned.id, 'confirmed', assigned.version);
    },
    onSuccess: () => {
      setOperatorTarget(null);
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

  /**
   * Перевод в работу — через назначение оператора вывоза; закрытие — через машины с талонами;
   * отмена — через обязательную причину. Остальные переходы (откаты) выполняются сразу.
   */
  const requestStatusChange = (r: WasteRequestDto, status: RequestStatus) => {
    if (statusChangeRequiresReason(status)) {
      setCancelTarget(r);
      return;
    }
    if (r.status === 'new' && status === 'confirmed') {
      operatorForm.resetFields();
      // Исполнитель мог быть выбран заранее в самой заявке — тогда окно только подтверждает его.
      operatorForm.setFieldsValue({
        operatorCounterpartyId: r.operatorCounterpartyId ?? undefined,
      });
      setOperatorTarget(r);
      return;
    }
    // Талоны предъявляет только вывоз самосвалами; контейнерные операции закрываются сразу.
    if (status === 'done' && requiresWasteVehicles(r.requestType)) {
      // Уже заведённых машин хватает (повторное закрытие после отката) — тогда окно открывается
      // пустым и просто подтверждает факт; иначе первая строка предлагается сразу.
      const hasVehicles = r.vehicles.some((v) => !v.isDeleted);
      setDoneDrafts(hasVehicles ? [] : [emptyVehicleDraft(r.containerTypeId ?? undefined)]);
      setDoneTarget(r);
      return;
    }
    statusMut.mutate({ id: r.id, status, version: r.version });
  };

  const submitDone = () => {
    if (!doneTarget) return;
    const error = validateVehicleDrafts(doneDrafts);
    if (error) {
      message.warning(error);
      return;
    }
    const activeExisting = doneTarget.vehicles.filter((v) => !v.isDeleted).length;
    if (activeExisting + doneDrafts.length === 0) {
      message.warning('Добавьте хотя бы одну машину');
      return;
    }
    statusMut.mutate({
      id: doneTarget.id,
      status: 'done',
      version: doneTarget.version,
      vehicles: doneDrafts,
    });
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.remove(id),
    onSuccess: (res) => {
      message.success(res.mode === 'hard' ? 'Заявка удалена' : 'Заявка перемещена в архив');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const canModify = (r: WasteRequestDto): boolean => {
    if (r.deletedAt) return false;
    // Оператор — исполнитель: заявку он только читает и закрывает (ADR 0010).
    if (isOperator) return false;
    if (isShtab) return r.status === 'new';
    return true;
  };

  const confirmDelete = (r: WasteRequestDto) =>
    modal.confirm({
      title: r.status === 'new' ? 'Удалить заявку?' : 'Переместить заявку в архив?',
      content:
        r.status === 'new'
          ? 'Заявка в статусе «Новая» будет удалена безвозвратно вместе с файлами.'
          : 'Заявка будет помечена удалённой (soft-delete) и может быть восстановлена администратором.',
      okText: 'Подтвердить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const StatusCell = ({ r }: { r: WasteRequestDto }) => {
    // Набор переходов зависит от роли: линейный цикл для всех, откаты — только администратору.
    const transitions = user?.role ? allowedStatusTransitions(r.status, user.role) : [];
    const tag = (
      <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
        {requestStatusLabels[r.status]}
      </Tag>
    );
    // Причина отмены — в подсказке на теге: в таблице для неё нет колонки, а знать её нужно.
    const badge = r.cancelReason ? (
      <Tooltip title={`Причина отмены: ${r.cancelReason}`}>{tag}</Tooltip>
    ) : (
      tag
    );
    if (r.deletedAt || transitions.length === 0) {
      return badge;
    }
    const pending = statusMut.isPending && statusMut.variables?.id === r.id;
    return (
      <Dropdown
        trigger={['click']}
        disabled={pending}
        menu={{
          items: transitions.map((s) => ({ key: s, label: requestStatusLabels[s] })),
          onClick: ({ key }) => requestStatusChange(r, key as RequestStatus),
        }}
      >
        <Button
          type="text"
          size="small"
          loading={pending}
          aria-label="Изменить статус"
          style={{ padding: 0, height: 'auto', border: 'none' }}
        >
          <Space size={4}>
            {badge}
            <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
          </Space>
        </Button>
      </Dropdown>
    );
  };

  const FilesCell = ({ r }: { r: WasteRequestDto }) => {
    if (r.files.length === 0) return <>—</>;
    return (
      <Popover
        trigger="click"
        content={
          <List
            size="small"
            style={{ minWidth: 240 }}
            dataSource={r.files}
            renderItem={(f) => (
              <List.Item
                actions={[
                  <Button
                    key="dl"
                    type="link"
                    size="small"
                    onClick={() => void filesApi.download(f.id)}
                  >
                    Скачать
                  </Button>,
                ]}
              >
                <Typography.Text ellipsis style={{ maxWidth: 180 }}>
                  {f.filename}
                </Typography.Text>
              </List.Item>
            )}
          />
        }
      >
        <Button size="small" icon={<PaperClipOutlined />}>
          {r.files.length}
        </Button>
      </Popover>
    );
  };

  const columns = [
    {
      key: 'no',
      title: '№',
      dataIndex: 'num',
      width: 90,
      // Номер — вход в карточку заявки: остальные поля в строке не помещаются.
      render: (_v: unknown, r: WasteRequestDto) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: 'auto' }}
          onClick={() => setViewRecord(r)}
        >
          {r.num}-{requestTypeShort[r.requestType]}
        </Button>
      ),
    },
    // Ширина задана всем колонкам: при scroll.x='max-content' колонка без ширины тянется по
    // содержимому, и один длинный комментарий возвращал бы горизонтальный скролл всей таблице.
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Объект',
      dataIndex: 'objectName',
      searchable: false,
      width: 230,
      ellipsis: true,
    }),
    {
      key: 'containerTypeName',
      title: 'Контейнер / машина',
      dataIndex: 'containerTypeName',
      width: 230,
      // Стоимость — второй строкой к предмету заявки: своей колонки она стоила дороже, чем
      // помогала, а цена за м³ рядом с суммой объясняет, почему одинаковый объём стоит по-разному.
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{requestSubject(r)}</div>
          {r.amount != null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatMoney(r.amount)} · {formatMoney(r.pricePerM3)}/м³
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      key: 'wasteTypeName',
      title: 'Тип мусора',
      dataIndex: 'wasteTypeName',
      width: 150,
      render: (_v: unknown, r: WasteRequestDto) => r.wasteTypeName ?? '—',
    },
    badgeColumn<WasteRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: requestTypeLabels,
      colors: requestTypeColors,
      filters: true,
      // Названия типов развёрнутые («Замена полного контейнера на пустой»); тег переносится
      // на вторую строку — на одну строку такая колонка забирала бы пол-экрана.
      width: 160,
      multiline: true,
    }),
    {
      key: 'createdAt',
      title: (
        <div style={{ lineHeight: 1.2 }}>
          <div>Дата созд.</div>
          <div>Доставки</div>
        </div>
      ),
      dataIndex: 'createdAt',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35, whiteSpace: 'nowrap' }}>
          <div>{formatDate(r.createdAt)}</div>
          <Typography.Text style={{ color: '#1677ff' }}>
            {formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified)}
          </Typography.Text>
        </div>
      ),
    },
    // Оператор вывоза видит только свои заявки (ADR 0010) — колонка повторяла бы ему одно и то
    // же значение во всех строках.
    ...(isOperator
      ? []
      : [
          {
            key: 'operatorName',
            title: 'Оператор',
            dataIndex: 'operatorName',
            width: 170,
            sorter: true,
            render: (_v: unknown, r: WasteRequestDto) => r.operatorName ?? '—',
          },
        ]),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 160,
      sorter: true,
      filters: Object.entries(requestStatusLabels).map(([value, text]) => ({ text, value })),
      filterMultiple: false,
      render: (_v: unknown, r: WasteRequestDto) => <StatusCell r={r} />,
    },
    textColumn<WasteRequestDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      sortable: false,
      width: 230,
      ellipsis: true,
    }),
    {
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      width: 80,
      render: (_v: unknown, r: WasteRequestDto) => <FilesCell r={r} />,
    },
    actionsColumn<WasteRequestDto>((r) => {
      if (r.deletedAt) {
        return isAdmin ? (
          <Tooltip title="Восстановить">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => restoreMut.mutate(r.id)}
            />
          </Tooltip>
        ) : (
          <Tag>в архиве</Tag>
        );
      }
      const allowed = canModify(r);
      return (
        <Space size={4}>
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
    }, 90),
  ];

  const filters = (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Select
        style={{ width: 260 }}
        value={objectFilter}
        onChange={applyObjectFilter}
        options={[{ value: '', label: 'Все объекты' }, ...objectOptions]}
        showSearch
        optionFilterProp="label"
        disabled={isShtab}
      />
      <Input
        style={{ width: 180 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={numInput}
        onChange={(e) => applyNumFilter(e.target.value)}
      />
    </div>
  );

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Space size={16}>
          <SummaryBar title="Заявок" items={summaryItems} />
          {isOperator ? null : (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Создать заявку
            </Button>
          )}
        </Space>
      }
    >
      <DataTable<WasteRequestDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <WasteRequestViewModal
        request={viewRecord}
        onClose={() => setViewRecord(null)}
        onEdit={
          viewRecord && canModify(viewRecord)
            ? (r) => {
                setViewRecord(null);
                openEdit(r);
              }
            : undefined
        }
      />

      {/* Назначение оператора вывоза при переводе заявки в работу: исполнитель обязателен —
          именно по нему заявка попадает в список своего оператора (ADR 0010). */}
      <FormModal
        title="Назначение оператора вывоза мусора"
        open={!!operatorTarget}
        onCancel={() => setOperatorTarget(null)}
        onSubmit={() => operatorForm.submit()}
        confirmLoading={startWorkMut.isPending}
        okText="В работу"
        width={480}
      >
        <Form
          form={operatorForm}
          layout="vertical"
          onFinish={(v: { operatorCounterpartyId: string }) =>
            operatorTarget &&
            startWorkMut.mutate({
              r: operatorTarget,
              operatorCounterpartyId: v.operatorCounterpartyId,
            })
          }
        >
          <Form.Item
            name="operatorCounterpartyId"
            label="Оператор вывоза"
            rules={[{ required: true, message: 'Выберите оператора' }]}
            extra={
              assignOperatorOptions.length === 0
                ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                : 'Оператор увидит заявку в своём списке и сможет отметить её выполненной'
            }
          >
            <Select options={assignOperatorOptions} showSearch optionFilterProp="label" />
          </Form.Item>
        </Form>
      </FormModal>

      {/* Закрытие вывоза самосвалами: факт предъявляется машинами и талонами (ADR 0011). Сверка
          с заявленным объёмом — подсказка, расхождение сохранению не мешает. Контейнерные
          операции окна не открывают — они закрываются одним действием. */}
      <FormModal
        title="Прикрепление талона(ов)"
        open={!!doneTarget}
        onCancel={() => {
          setDoneTarget(null);
          setDoneDrafts([]);
        }}
        onSubmit={submitDone}
        confirmLoading={statusMut.isPending}
        okText="Выполнена"
        width={720}
      >
        {doneTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Typography.Text type="secondary">
              Заявка № {doneTarget.num}-{requestTypeShort[doneTarget.requestType]},{' '}
              {doneTarget.objectName}
              {doneTarget.volumeM3 != null ? ` · заявлено ${doneTarget.volumeM3} м³` : ''}
            </Typography.Text>
            {doneTarget.vehicles.filter((v) => !v.isDeleted).length > 0 && (
              <List
                size="small"
                header={<Typography.Text strong>Уже заведённые машины</Typography.Text>}
                dataSource={doneTarget.vehicles.filter((v) => !v.isDeleted)}
                renderItem={(v) => (
                  <List.Item>
                    <span>
                      {v.containerTypeName} — {v.volumeM3} м³
                    </span>
                    <Typography.Text type="secondary">
                      {v.files.length > 0 ? `талонов: ${v.files.length}` : 'без талона'}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            )}
            <WasteVehiclesEditor
              value={doneDrafts}
              onChange={setDoneDrafts}
              typeOptions={vehicleTypeOptions}
              defaultContainerTypeId={doneTarget.containerTypeId ?? undefined}
              existingCount={doneTarget.vehicles.filter((v) => !v.isDeleted).length}
            />
            <VolumeSummary
              planned={doneTarget.volumeM3}
              actual={
                sumDraftVolume(doneDrafts, vehicleTypeOptions) +
                doneTarget.vehicles.reduce((acc, v) => (v.isDeleted ? acc : acc + v.volumeM3), 0)
              }
            />
          </div>
        )}
      </FormModal>

      <CancelReasonModal
        open={!!cancelTarget}
        subject={
          cancelTarget ? `№ ${cancelTarget.num}-${requestTypeShort[cancelTarget.requestType]}` : ''
        }
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

      <FormModal
        title={record ? 'Редактирование заявки' : 'Новая заявка'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            // Незаполненная строка машины — не повод отправлять запрос: сервер отвергнет её
            // целиком, а человеку нужно знать, в какой именно строке пробел.
            const vehicleError = validateVehicleDrafts(vehicleDrafts);
            if (vehicleError) {
              message.warning(vehicleError);
              return;
            }
            saveMut.mutate(v);
          }}
          // Смена объекта может сделать выбранного исполнителя недопустимым — снимаем его сразу,
          // а не отказом сервера при сохранении.
          onValuesChange={(changed: Partial<RequestFormValues>) => {
            if (!changed.objectId) return;
            const selected = form.getFieldValue('operatorCounterpartyId') as string | undefined;
            const allowed = operatorOptionsFor(changed.objectId);
            if (selected && !allowed.some((o) => o.value === selected)) {
              form.setFieldValue('operatorCounterpartyId', undefined);
            }
          }}
        >
          <Form.Item
            name="objectId"
            label="Объект строительства"
            rules={[{ required: true, message: 'Выберите объект' }]}
          >
            <Select
              options={objectOptions}
              showSearch
              optionFilterProp="label"
              disabled={isShtab}
              onChange={handleObjectChange}
            />
          </Form.Item>
          <Form.Item
            name="requestType"
            label="Тип заявки"
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <Select
              options={requestTypeOptions}
              placeholder={watchObjectId ? 'Выберите тип заявки' : 'Сначала выберите объект'}
              disabled={!watchObjectId}
              onChange={handleRequestTypeChange}
            />
          </Form.Item>

          {watchRequestType === 'container_install' && (
            <Form.Item
              name="containerTypeId"
              label="Тип контейнера"
              rules={[{ required: true, message: 'Выберите тип контейнера' }]}
            >
              <Select options={contTypeOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          )}

          {/* Тарифицируемые операции: техника, что вывозим, сколько и почём — одной строкой,
              потому что цена осмысленна только как произведение этих полей (ADR 0009). */}
          {isPriced && subjectField && (
            <div style={{ display: 'flex', gap: 12 }}>
              <Form.Item
                name="containerTypeId"
                label={subjectField.label}
                rules={[{ required: true, message: subjectField.message }]}
                extra={
                  subjectField.fromObject && !objectHasPresent
                    ? 'На объекте нет контейнеров'
                    : undefined
                }
                style={{ flex: 3, minWidth: 0 }}
              >
                <Select
                  options={subjectField.options}
                  showSearch
                  optionFilterProp="label"
                  placeholder={subjectField.placeholder}
                  notFoundContent={
                    subjectField.fromObject ? 'Нет контейнеров на объекте' : undefined
                  }
                />
              </Form.Item>
              <Form.Item
                name="wasteTypeId"
                label="Тип мусора"
                rules={[{ required: true, message: 'Выберите тип мусора' }]}
                style={{ flex: 3, minWidth: 0 }}
              >
                <Select
                  options={wasteTypeOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Что вывозим"
                />
              </Form.Item>
              <Form.Item
                name="volumeM3"
                label="Объём, м³"
                rules={[
                  { required: true, message: 'Укажите объём' },
                  {
                    type: 'number',
                    min: MIN_WASTE_VOLUME_M3,
                    message: `Не менее ${MIN_WASTE_VOLUME_M3} м³`,
                  },
                  {
                    // Тариф «за контейнер» тарифицирует контейнер целиком: половину не вывозят.
                    validator: (_rule, v: number | undefined) =>
                      v == null || isVolumeAllowed(v, volumeStepM3)
                        ? Promise.resolve()
                        : Promise.reject(new Error(volumeStepMessage(volumeStepM3!))),
                  },
                ]}
                style={{ flex: 2, minWidth: 0 }}
              >
                <InputNumber
                  min={MIN_WASTE_VOLUME_M3}
                  step={volumeStepM3 ?? 1}
                  // Заявленный объём — целое (в БД integer): дробное значение сервер отвергал бы
                  // валидацией уже после отправки формы.
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder={volumeStepM3 ? `Кратно ${volumeStepM3}` : 'Например, 20'}
                />
              </Form.Item>
              <Form.Item
                label="Стоимость"
                extra={
                  tariffMissing
                    ? 'Тариф не задан'
                    : tariff
                      ? `${formatMoney(tariff.pricePerM3)}/м³`
                      : undefined
                }
                style={{ flex: 2, minWidth: 0 }}
              >
                <Input readOnly value={amountPreview == null ? '—' : formatMoney(amountPreview)} />
              </Form.Item>
            </div>
          )}
          {/* Исполнителя можно выбрать заранее; если нет — его спросят при переводе в работу. */}
          {canAssignOperator && (
            <Form.Item
              name="operatorCounterpartyId"
              label="Оператор вывоза"
              tooltip="Контрагент, который выполняет заявку; он увидит её в своём списке"
              extra={
                formOperatorOptions.length === 0
                  ? 'Нет активных контрагентов типа «Оператор» — заведите его в справочнике'
                  : undefined
              }
            >
              <Select
                options={formOperatorOptions}
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Можно назначить позже"
              />
            </Form.Item>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              name="deliveryDate"
              label="Дата доставки"
              rules={[{ required: true, message: 'Укажите дату' }]}
              style={{ flex: 1 }}
            >
              <DatePicker
                format="DD.MM.YYYY"
                style={{ width: '100%' }}
                placeholder="дд.мм.гггг"
                disabledDate={isPastDate}
              />
            </Form.Item>
            <Form.Item
              name="deliveryTime"
              label="Время"
              tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
              rules={[optionalWorkTimeRule]}
              style={{ width: 130 }}
            >
              <TimeInput />
            </Form.Item>
          </div>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>

          {/* Машины и талоны (ADR 0011). Заведённые строки удаляет только администратор,
              остальным доступна пометка: ошибочно снятый талон иначе не заметить.
              Блок есть только у вывоза самосвалами — контейнерные операции по машинам
              не отчитываются. */}
          {record && watchRequestType && requiresWasteVehicles(watchRequestType) && (
            <Form.Item label="Машины и талоны">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {record.vehicles.length > 0 && (
                  <List
                    size="small"
                    dataSource={record.vehicles}
                    renderItem={(v) => {
                      const willDelete = vehicleMarks[v.id] === 'deleted';
                      const inactive = willDelete || isVehicleDeleted(v);
                      return (
                        <List.Item
                          actions={
                            willDelete
                              ? [
                                  <Button
                                    key="undo"
                                    type="link"
                                    size="small"
                                    onClick={() => setVehicleMark(v.id, null)}
                                  >
                                    Отменить удаление
                                  </Button>,
                                ]
                              : [
                                  <Button
                                    key="mark"
                                    type="link"
                                    size="small"
                                    onClick={() =>
                                      setVehicleMark(
                                        v.id,
                                        isVehicleDeleted(v)
                                          ? v.isDeleted
                                            ? 'restored'
                                            : null
                                          : v.isDeleted
                                            ? null
                                            : 'marked',
                                      )
                                    }
                                  >
                                    {isVehicleDeleted(v) ? 'Вернуть' : 'Пометить на удаление'}
                                  </Button>,
                                  ...(isAdmin
                                    ? [
                                        <Button
                                          key="del"
                                          type="link"
                                          danger
                                          size="small"
                                          onClick={() => setVehicleMark(v.id, 'deleted')}
                                        >
                                          Удалить
                                        </Button>,
                                      ]
                                    : []),
                                ]
                          }
                        >
                          <Typography.Text
                            delete={inactive}
                            type={inactive ? 'secondary' : undefined}
                          >
                            {v.containerTypeName} — {v.volumeM3} м³
                            {v.files.length > 0 ? ` · талонов: ${v.files.length}` : ' · без талона'}
                            {willDelete ? ' · будет удалена' : ''}
                          </Typography.Text>
                        </List.Item>
                      );
                    }}
                  />
                )}
                <WasteVehiclesEditor
                  value={vehicleDrafts}
                  onChange={setVehicleDrafts}
                  typeOptions={vehicleTypeOptions}
                  defaultContainerTypeId={record.containerTypeId ?? undefined}
                  existingCount={record.vehicles.filter((v) => !isVehicleDeleted(v)).length}
                />
                <VolumeSummary
                  planned={watchVolumeM3 ?? record.volumeM3}
                  actual={editVehiclesVolume}
                />
              </div>
            </Form.Item>
          )}

          <Form.Item label={`Файлы (до ${FILE_MAX_COUNT}, до 50 МБ каждый)`}>
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={(file) => {
                if (files.length >= FILE_MAX_COUNT) {
                  message.warning(`Не более ${FILE_MAX_COUNT} файлов`);
                  return Upload.LIST_IGNORE;
                }
                if (file.size > FILE_MAX_SIZE) {
                  message.warning('Файл больше 50 МБ');
                  return Upload.LIST_IGNORE;
                }
                void handleUpload(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploading}>
                Прикрепить файл
              </Button>
            </Upload>
            <List
              size="small"
              style={{ marginTop: 8 }}
              locale={{ emptyText: 'Файлы не прикреплены' }}
              dataSource={files}
              renderItem={(f) => (
                <List.Item
                  actions={[
                    <Button
                      key="rm"
                      type="link"
                      danger
                      size="small"
                      onClick={() => void removeFile(f)}
                    >
                      Удалить
                    </Button>,
                  ]}
                >
                  <Typography.Text ellipsis style={{ maxWidth: 300 }}>
                    {f.filename}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                    {formatBytes(f.size)}
                  </Typography.Text>
                </List.Item>
              )}
            />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
