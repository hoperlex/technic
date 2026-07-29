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
  type TableColumnType,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type AddressMeta,
  isAddressVerified,
  isVehicleKindAllowedForRequest,
  normalizeTimeInput,
  parseVehicleRequestNumberSearch,
  REQUEST_STATUSES,
  type RequestStatus,
  requestStatusLabels,
  statusChangeRequiresReason,
  VEHICLE_REQUEST_TYPES,
  type VehicleRequestDto,
  type VehicleRequestType,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { CancelReasonModal } from '../../components/CancelReasonModal';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { TabsExtra } from '../../components/PageTabs';
import { SummaryBar } from '../../components/SummaryBar';
import { actionsColumn, badgeColumn, textColumn } from '../../components/columns';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { UserAvatar } from '../../components/UserAvatar';
import { AddressAutoComplete, AddressCell } from '../../components/AddressAutoComplete';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTimeMaybe } from '../../utils/format';
import { isBeforeMinRequestDate, isPastDate, minRequestDate } from '../../utils/date';
import { MOSCOW_TZ } from '../../theme';
import { FilesCell } from '../../components/FileLinks';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import {
  FileEditor,
  formatDateOnly,
  StatusCell,
  VehicleTypeSelect,
  useFileEditor,
  useObjectOptions,
  useVehicleTypes,
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
  objectId: string;
  vehicleTypeId: string;
  // Техника на объект: период работы (date-only).
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  // Грузоперевозка: дата + необязательное время `HH:mm`, объём/масса, адреса.
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  volumeM3?: number | null;
  weightTons?: number | null;
  loadingLocation?: string;
  unloadingLocation?: string;
  comment?: string;
}

const SPECIAL_FIELDS = ['dateFrom', 'dateTo'] as const;
const FREIGHT_FIELDS = [
  'scheduledDate',
  'scheduledTime',
  'volumeM3',
  'weightTons',
  'loadingLocation',
  'unloadingLocation',
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

function amountLabel(r: VehicleRequestDto): string {
  if (r.requestType !== 'freight_transport') return '—';
  const parts = [
    r.volumeM3 != null ? `${r.volumeM3} м³` : null,
    r.weightTons != null ? `${r.weightTons} т` : null,
  ];
  return parts.filter(Boolean).join(' / ') || '—';
}

export function VehicleRequestsTab() {
  const { message, modal } = App.useApp();
  const { user, hasRole, can } = useAuth();
  const qc = useQueryClient();
  // Штаб — область видимости (свой объект, заявка до «В работе»); действия — по правам (ADR 0021).
  const isShtab = hasRole('shtab');
  const canEdit = can('vehicleRequests.update');
  const canDelete = can('vehicleRequests.delete');
  const canCreate = can('vehicleRequests.create');
  const canRestore = can('archive.restore');

  // Для штаба объект зафиксирован на его собственном: и в фильтре списка, и в форме заявки
  // (сервер всё равно отвечает 403 на чужой объект — assertShtabScope).
  const shtabObjectId = isShtab ? (user?.constructionObjectId ?? '') : '';

  // requestType не задан — список обоих типов; фильтр в шапке сужает до одного.
  // Все фильтры собраны в панели над таблицей, а не в выпадашках столбцов: в заголовке их
  // не видно, а часть значений (объект, тип ТС) — списки справочников.
  const { params, setParams, onTableChange } = useListParams<{
    requestType?: string;
    status?: string;
    objectId?: string;
    num?: number;
  }>({ objectId: shtabObjectId || undefined }, { searchKeys: ['comment'] });

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'all', params],
    queryFn: () => vehicleRequestsApi.list(params),
  });
  const items = data?.items ?? [];

  // Сводка в шапке: сколько заявок ждёт обработки и сколько в работе. Ключ начинается с
  // 'vehicle-requests' — значит счётчики обновляются теми же инвалидациями, что и список.
  const { data: summary } = useQuery({
    queryKey: ['vehicle-requests', 'summary', params.objectId, params.requestType],
    queryFn: () =>
      vehicleRequestsApi.summary({ objectId: params.objectId, requestType: params.requestType }),
  });
  const summaryItems = [
    { label: 'Не обработанных', value: summary?.new ?? 0 },
    { label: requestStatusLabels.confirmed, value: summary?.confirmed ?? 0 },
  ];

  const objectOptions = useObjectOptions();
  const { kindByTypeId, groups, loading: typesLoading } = useVehicleTypes();

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleRequestDto | null>(null);
  /** Открытая карточка заявки: поля только на чтение и история событий (ADR 0015). */
  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();
  // Метаданные верификации адресов держим вне формы (значение — объект, не строка).
  const [loadingMeta, setLoadingMeta] = useState<AddressMeta | null>(null);
  const [unloadingMeta, setUnloadingMeta] = useState<AddressMeta | null>(null);

  // Тип заявки выбирают в форме первым — от него зависят и поля, и список типов ТС.
  const watchRequestType = Form.useWatch('requestType', form);
  const isSpecial = watchRequestType === 'special_equipment';
  const isFreight = watchRequestType === 'freight_transport';

  // Ограничение дат: новая заявка — не раньше завтра по МСК (правило сервера), правка
  // заведённой — не в прошлое (её дата могла быть назначена и вчера).
  const minDateRule = record ? isPastDate : isBeforeMinRequestDate;

  // Заказ техники на объект допускает технику любого вида, грузоперевозка — только грузовую.
  const typeGroups = watchRequestType
    ? groups.filter((g) => isVehicleKindAllowedForRequest(watchRequestType, g.kindCode))
    : [];

  /**
   * Смена типа заявки: поля чужого типа очищаем, своей дате подставляем завтра — раньше
   * нельзя; выбранный тип ТС сбрасываем, если новому типу заявки он не подходит.
   */
  const handleRequestTypeChange = (next: VehicleRequestType) => {
    const typeId: string | undefined = form.getFieldValue('vehicleTypeId');
    const kindCode = typeId ? kindByTypeId.get(typeId) : undefined;
    if (kindCode && !isVehicleKindAllowedForRequest(next, kindCode)) {
      form.resetFields(['vehicleTypeId']);
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
    if (shtabObjectId) form.setFieldsValue({ objectId: shtabObjectId } as Partial<FormValues>);
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
        objectId: r.objectId,
        vehicleTypeId: r.vehicleTypeId,
        dateFrom: dayjs(r.dateFrom),
        dateTo: r.dateTo ? dayjs(r.dateTo) : null,
        comment: r.comment,
      });
    } else {
      setLoadingMeta(r.loadingAddress);
      setUnloadingMeta(r.unloadingAddress);
      const at = dayjs.tz(r.scheduledAt, MOSCOW_TZ);
      form.setFieldsValue({
        requestType: r.requestType,
        objectId: r.objectId,
        vehicleTypeId: r.vehicleTypeId,
        scheduledDate: at,
        // Время не задано — поле остаётся пустым (в scheduledAt лежит полночь МСК).
        scheduledTime: r.scheduledTimeUnspecified ? undefined : at.format('HH:mm'),
        volumeM3: r.volumeM3,
        weightTons: r.weightTons,
        loadingLocation: r.loadingLocation,
        unloadingLocation: r.unloadingLocation,
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
      const common = {
        objectId: v.objectId,
        vehicleTypeId: v.vehicleTypeId,
        comment: v.comment ?? '',
      };
      if (v.requestType === 'special_equipment') {
        const base = {
          requestType: 'special_equipment' as const,
          ...common,
          dateFrom: v.dateFrom!.format('YYYY-MM-DD'),
          dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
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

      // Время не задано → полночь МСК + признак: заявка «на дату», без конкретного часа.
      const time = normalizeTimeInput(v.scheduledTime ?? '');
      const scheduledAt = dayjs
        .tz(`${v.scheduledDate!.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        requestType: 'freight_transport' as const,
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
    if (v.volumeM3 == null && v.weightTons == null) {
      message.error('Укажите объём или массу');
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

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: RequestStatus; version: number; comment?: string }) =>
      vehicleRequestsApi.changeStatus(v.id, v.status, v.version, v.comment),
    onSuccess: () => {
      message.success('Статус изменён');
      setCancelTarget(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const requestStatusChange = (r: VehicleRequestDto, status: RequestStatus) => {
    if (statusChangeRequiresReason(status)) {
      setCancelTarget(r);
      return;
    }
    statusMut.mutate({ id: r.id, status, version: r.version });
  };

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
    !r.deletedAt && (canEdit || canDelete) && (!isShtab || r.status === 'new');

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
  const columns: TableColumnType<VehicleRequestDto>[] = [
    textColumn({
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      searchable: false,
      width: 120,
    }),
    badgeColumn<VehicleRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: vehicleRequestTypeLabels,
      colors: vehicleRequestTypeColors,
      width: 180,
    }),
    textColumn({ key: 'objectName', title: 'Объект', dataIndex: 'objectName', searchable: false }),
    textColumn<VehicleRequestDto>({
      key: 'createdByName',
      title: 'Автор',
      dataIndex: 'createdByName',
      searchable: false,
      width: 170,
      render: (_v, r) => (
        <Space size={8}>
          <UserAvatar name={r.createdByName} size="small" />
          <span>{r.createdByName}</span>
        </Space>
      ),
    }),
    textColumn({
      key: 'vehicleTypeName',
      title: 'Тип ТС',
      dataIndex: 'vehicleTypeName',
      searchable: false,
    }),
    {
      key: 'term',
      title: 'Срок',
      width: 190,
      // Срок и «объём/масса» у типов заявки лежат в разных полях — сортировку сводит сервер.
      sorter: true,
      render: (_v, r) => termLabel(r),
    },
    {
      key: 'amount',
      title: 'Объём / масса',
      width: 140,
      sorter: true,
      render: (_v, r) => amountLabel(r),
    },
    {
      key: 'loadingLocation',
      title: 'Погрузка',
      ellipsis: true,
      sorter: true,
      render: (_v, r) =>
        r.requestType === 'freight_transport' ? (
          <AddressCell text={r.loadingLocation} meta={r.loadingAddress} />
        ) : (
          '—'
        ),
    },
    {
      key: 'unloadingLocation',
      title: 'Разгрузка',
      ellipsis: true,
      sorter: true,
      render: (_v, r) =>
        r.requestType === 'freight_transport' ? (
          <AddressCell text={r.unloadingLocation} meta={r.unloadingAddress} />
        ) : (
          '—'
        ),
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
          cancelReason={r.cancelReason}
          pending={statusMut.isPending && statusMut.variables?.id === r.id}
          onChange={(status) => requestStatusChange(r, status)}
        />
      ),
    },
    textColumn({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
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
      const allowed = canModify(r);
      return (
        <Space size={4}>
          {view}
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
    }, 120),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={VEHICLE_REQUEST_TYPES.map((t) => ({
          value: t,
          label: vehicleRequestTypeLabels[t],
        }))}
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
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        disabled={isShtab}
        value={params.objectId}
        onChange={(v: string | undefined) => applyFilter({ objectId: v })}
      />
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-000123)"
        style={{ width: 180 }}
        onSearch={(val) => applyFilter({ num: parseVehicleRequestNumberSearch(val) })}
      />
    </Space>
  );

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
    >
      {/* Сводка — на уровне вкладок, над фильтрами и кнопкой: она относится ко всему списку. */}
      <TabsExtra tabKey="requests">
        <SummaryBar title="Заявок" items={summaryItems} />
      </TabsExtra>

      <DataTable<VehicleRequestDto>
        columns={columns}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? `Заявка ${record.displayNumber}` : 'Новая заявка на автотехнику'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item
            name="objectId"
            label="Объект"
            rules={[{ required: true, message: 'Выберите объект' }]}
          >
            <Select
              options={objectOptions}
              showSearch
              optionFilterProp="label"
              placeholder="Объект"
              disabled={isShtab}
            />
          </Form.Item>
          {/* Тип заявки неизменяем после создания (сервер отдаёт 422) — при правке поле заперто. */}
          <Form.Item
            name="requestType"
            label="Тип заявки"
            tooltip="Заказ техники на объект — техника любого вида; грузоперевозка — только грузовая"
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <Select
              options={VEHICLE_REQUEST_TYPES.map((t) => ({
                value: t,
                label: vehicleRequestTypeLabels[t],
              }))}
              placeholder="Выберите тип заявки"
              disabled={!!record}
              onChange={handleRequestTypeChange}
            />
          </Form.Item>
          <VehicleTypeSelect
            groups={typeGroups}
            loading={typesLoading}
            disabled={!watchRequestType}
            placeholder={watchRequestType ? 'Выберите тип' : 'Сначала выберите тип заявки'}
          />

          {/* Техника на объект: период работы. Новую заявку назначают не раньше чем на завтра
              (по МСК); у заведённой дата правится свободно, лишь бы не в прошлое. */}
          {isSpecial && (
            <Space style={{ width: '100%' }} size="middle">
              <Form.Item
                name="dateFrom"
                label="Дата начала"
                rules={[{ required: true, message: 'Укажите дату начала' }]}
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  disabledDate={minDateRule}
                />
              </Form.Item>
              <Form.Item name="dateTo" label="Дата окончания">
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  disabledDate={minDateRule}
                />
              </Form.Item>
            </Space>
          )}

          {/* Грузоперевозка: дата/время, объём или масса, адреса. */}
          {isFreight && (
            <>
              <Space style={{ width: '100%' }} size="middle">
                <Form.Item
                  name="scheduledDate"
                  label="Дата подачи"
                  rules={[{ required: true, message: 'Укажите дату' }]}
                >
                  <DatePicker
                    format="DD.MM.YYYY"
                    style={{ width: '100%' }}
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
              </Space>
              <Space style={{ width: '100%' }} size="middle">
                <Form.Item name="volumeM3" label="Объём, м³" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
                </Form.Item>
                <Form.Item name="weightTons" label="Масса, т" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
                </Form.Item>
              </Space>
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
            </>
          )}

          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item label="Файлы">
            <FileEditor editor={editor} />
          </Form.Item>
        </Form>
      </FormModal>

      {/* Карточка заявки: поля только на чтение плюс история событий. Правка — той же формой,
          что и из таблицы, и только если она этой роли доступна. */}
      <VehicleRequestViewModal
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
