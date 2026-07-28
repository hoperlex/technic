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
  type TableColumnType,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type AddressMeta,
  isAddressVerified,
  normalizeTimeInput,
  parseVehicleRequestNumberSearch,
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
import { SummaryBar } from '../../components/SummaryBar';
import { actionsColumn, badgeColumn, textColumn } from '../../components/columns';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';
import { UserAvatar } from '../../components/UserAvatar';
import { AddressAutoComplete, AddressCell } from '../../components/AddressAutoComplete';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTimeMaybe } from '../../utils/format';
import { isPastDate, startOfToday } from '../../utils/date';
import { MOSCOW_TZ } from '../../theme';
import {
  FileEditor,
  FilesCell,
  StatusCell,
  VehicleTypeSelect,
  useFileEditor,
  useObjectOptions,
  useVehicleTypes,
  type EditorFile,
} from './shared';

/**
 * Единая форма заявки на автотехнику. Тип заявки не выбирается отдельно — его задаёт
 * вид выбранного типа ТС (коды vehicle_kinds совпадают с vehicle_request_type).
 * Поля обоих типов видны всегда; неприменимые к выбранному виду выключены и не заполняются.
 */
interface FormValues {
  objectId: string;
  vehicleTypeId: string;
  // Спецтехника: период работы (date-only).
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

const fmtDate = (s: string) => dayjs(s).format('DD.MM.YYYY');

/** Колонка «Срок»: у спецтехники это период, у грузоперевозки — дата (и время, если задано). */
function termLabel(r: VehicleRequestDto): string {
  if (r.requestType === 'special_equipment') {
    return r.dateTo ? `${fmtDate(r.dateFrom)} – ${fmtDate(r.dateTo)}` : fmtDate(r.dateFrom);
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
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const isAdmin = hasRole('admin');
  const isShtab = hasRole('shtab');

  // requestType не задан — список обоих типов; фильтр в шапке сужает до одного.
  const { params, setParams, onTableChange } = useListParams<{
    requestType?: string;
    status?: string;
    objectId?: string;
  }>(
    {},
    {
      searchKeys: ['comment'],
      mapFilters: (f) => ({
        status: f.status?.[0] as string | undefined,
        requestType: f.requestType?.[0] as string | undefined,
      }),
    },
  );

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
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();
  // Метаданные верификации адресов держим вне формы (значение — объект, не строка).
  const [loadingMeta, setLoadingMeta] = useState<AddressMeta | null>(null);
  const [unloadingMeta, setUnloadingMeta] = useState<AddressMeta | null>(null);

  // Тип заявки выводится из вида выбранного ТС.
  const watchTypeId = Form.useWatch('vehicleTypeId', form);
  const kind = watchTypeId ? kindByTypeId.get(watchTypeId) : undefined;
  const isSpecial = kind === 'special_equipment';
  const isFreight = kind === 'freight_transport';

  // Тип заявки менять нельзя (сервер отклонит) — при редактировании оставляем только свой вид.
  const typeGroups = record
    ? groups.filter((g) => g.options.some((o) => kindByTypeId.get(o.value) === record.requestType))
    : groups;

  /** Смена типа ТС: поля чужого вида очищаем, своей дате подставляем сегодня. */
  const handleTypeChange = (typeId: string) => {
    const next = kindByTypeId.get(typeId);
    if (next === 'special_equipment') {
      form.resetFields([...FREIGHT_FIELDS]);
      setLoadingMeta(null);
      setUnloadingMeta(null);
      if (!form.getFieldValue('dateFrom')) form.setFieldsValue({ dateFrom: startOfToday() });
    } else if (next === 'freight_transport') {
      form.resetFields([...SPECIAL_FIELDS]);
      if (!form.getFieldValue('scheduledDate')) {
        form.setFieldsValue({ scheduledDate: startOfToday() });
      }
    }
  };

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
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
      if (isSpecial) {
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

  /** Доваливаем правила, которые зависят от вида ТС и не выражаются rules-ами полей. */
  const onFinish = (v: FormValues) => {
    if (isSpecial) {
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

  const canModify = (r: VehicleRequestDto) => !r.deletedAt && (!isShtab || r.status === 'new');

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
  const columns: TableColumnType<VehicleRequestDto>[] = [
    textColumn({
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      sortable: false,
      searchable: false,
      width: 120,
    }),
    badgeColumn<VehicleRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: vehicleRequestTypeLabels,
      colors: vehicleRequestTypeColors,
      filters: true,
      sortable: false,
      width: 180,
    }),
    textColumn({ key: 'objectName', title: 'Объект', dataIndex: 'objectName', searchable: false }),
    textColumn<VehicleRequestDto>({
      key: 'createdByName',
      title: 'Автор',
      dataIndex: 'createdByName',
      sortable: false,
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
      sortable: false,
      searchable: false,
    }),
    {
      key: 'term',
      title: 'Срок',
      width: 190,
      render: (_v, r) => termLabel(r),
    },
    {
      key: 'amount',
      title: 'Объём / масса',
      width: 140,
      render: (_v, r) => amountLabel(r),
    },
    {
      key: 'loadingLocation',
      title: 'Погрузка',
      ellipsis: true,
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
      sortable: false,
      ellipsis: true,
    }),
    {
      key: 'files',
      title: 'Файлы',
      width: 110,
      render: (_v, r) => <FilesCell files={r.files} />,
    },
    actionsColumn<VehicleRequestDto>((r) =>
      r.deletedAt ? (
        isAdmin ? (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => restoreMut.mutate(r.id)}
            title="Восстановить"
          />
        ) : (
          <Tag>в архиве</Tag>
        )
      ) : (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!canModify(r)}
            onClick={() => openEdit(r)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!canModify(r)}
            onClick={() => confirmDelete(r)}
          />
        </Space>
      ),
    ),
  ];

  const filters = (
    <Space wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={VEHICLE_REQUEST_TYPES.map((t) => ({ value: t, label: vehicleRequestTypeLabels[t] }))}
        value={params.requestType as VehicleRequestType | undefined}
        onChange={(v) => setParams((p) => ({ ...p, requestType: v, page: 1 }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 260 }}
        options={objectOptions}
        disabled={isShtab}
        value={params.objectId}
        onChange={(v) => setParams((p) => ({ ...p, objectId: v, page: 1 }))}
      />
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-000123)"
        style={{ width: 200 }}
        onSearch={(val) =>
          setParams((p) => ({ ...p, num: parseVehicleRequestNumberSearch(val), page: 1 }))
        }
      />
    </Space>
  );

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Space size={16}>
          <SummaryBar title="Заявок" items={summaryItems} />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Создать заявку
          </Button>
        </Space>
      }
    >
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
            />
          </Form.Item>
          <VehicleTypeSelect
            groups={typeGroups}
            loading={typesLoading}
            onChange={handleTypeChange}
          />

          {/* Спецтехника: период работы. Для грузоперевозки поля выключены. */}
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item
              name="dateFrom"
              label="Дата начала"
              rules={[{ required: isSpecial, message: 'Укажите дату начала' }]}
            >
              <DatePicker
                format="DD.MM.YYYY"
                style={{ width: '100%' }}
                disabled={!isSpecial}
                disabledDate={isPastDate}
              />
            </Form.Item>
            <Form.Item name="dateTo" label="Дата окончания">
              <DatePicker
                format="DD.MM.YYYY"
                style={{ width: '100%' }}
                disabled={!isSpecial}
                disabledDate={isPastDate}
              />
            </Form.Item>
          </Space>

          {/* Грузоперевозка: дата/время, объём или масса, адреса. Для спецтехники выключены. */}
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item
              name="scheduledDate"
              label="Дата подачи"
              rules={[{ required: isFreight, message: 'Укажите дату' }]}
            >
              <DatePicker
                format="DD.MM.YYYY"
                style={{ width: '100%' }}
                disabled={!isFreight}
                disabledDate={isPastDate}
              />
            </Form.Item>
            <Form.Item
              name="scheduledTime"
              label="Время (МСК)"
              tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
              rules={[optionalWorkTimeRule]}
            >
              <TimeInput disabled={!isFreight} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="volumeM3" label="Объём, м³" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} step={0.1} disabled={!isFreight} />
            </Form.Item>
            <Form.Item name="weightTons" label="Масса, т" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} step={0.1} disabled={!isFreight} />
            </Form.Item>
          </Space>
          <Form.Item
            name="loadingLocation"
            label="Место погрузки"
            rules={[{ required: isFreight, message: 'Укажите место погрузки' }]}
          >
            <AddressAutoComplete
              placeholder="Начните вводить адрес"
              disabled={!isFreight}
              onMetaChange={setLoadingMeta}
            />
          </Form.Item>
          <Form.Item
            name="unloadingLocation"
            label="Место разгрузки"
            rules={[{ required: isFreight, message: 'Укажите место разгрузки' }]}
          >
            <AddressAutoComplete
              placeholder="Начните вводить адрес"
              disabled={!isFreight}
              onMetaChange={setUnloadingMeta}
            />
          </Form.Item>

          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item label="Файлы">
            <FileEditor editor={editor} />
          </Form.Item>
        </Form>
      </FormModal>

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
