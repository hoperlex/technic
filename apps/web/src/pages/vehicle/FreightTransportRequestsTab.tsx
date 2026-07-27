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
  TimePicker,
  type TableColumnType,
} from 'antd';
import { EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type FreightTransportRequestDto,
  parseVehicleRequestNumberSearch,
  type RequestStatus,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
import { UserAvatar } from '../../components/UserAvatar';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { MOSCOW_TZ } from '../../theme';
import {
  FileEditor,
  FilesCell,
  StatusCell,
  VehicleTypeSelect,
  useFileEditor,
  useObjectOptions,
  useOpenCreateFromQuery,
  type EditorFile,
} from './shared';
import { CreateRequestButton } from './CreateRequestButton';

interface FormValues {
  objectId: string;
  vehicleTypeId: string;
  scheduledDate: Dayjs;
  scheduledTime: Dayjs;
  volumeM3?: number | null;
  weightTons?: number | null;
  loadingLocation: string;
  unloadingLocation: string;
  comment?: string;
}

function amountLabel(volume: number | null, weight: number | null): string {
  const parts = [volume != null ? `${volume} м³` : null, weight != null ? `${weight} т` : null];
  return parts.filter(Boolean).join(' / ') || '—';
}

export function FreightTransportRequestsTab() {
  const { message, modal } = App.useApp();
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const canChangeStatus = hasRole('admin', 'manager', 'dispatcher');
  const isAdmin = hasRole('admin');
  const isShtab = hasRole('shtab');

  const { params, setParams, onTableChange } = useListParams<{
    requestType: 'freight_transport';
    status?: string;
  }>(
    { requestType: 'freight_transport' },
    {
      searchKeys: ['comment'],
      mapFilters: (f) => ({ status: f.status?.[0] as string | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'freight-transport', params],
    queryFn: () => vehicleRequestsApi.list(params),
  });
  const items = (data?.items ?? []) as FreightTransportRequestDto[];

  const objectOptions = useObjectOptions();

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<FreightTransportRequestDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    editor.reset([]);
    setOpen(true);
  };
  useOpenCreateFromQuery('freight-transport', openCreate);

  const openEdit = (r: FreightTransportRequestDto) => {
    setRecord(r);
    form.resetFields();
    const at = dayjs.tz(r.scheduledAt, MOSCOW_TZ);
    form.setFieldsValue({
      objectId: r.objectId,
      vehicleTypeId: r.vehicleTypeId,
      scheduledDate: at,
      scheduledTime: at,
      volumeM3: r.volumeM3,
      weightTons: r.weightTons,
      loadingLocation: r.loadingLocation,
      unloadingLocation: r.unloadingLocation,
      comment: r.comment,
    });
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
      const scheduledAt = dayjs
        .tz(`${v.scheduledDate.format('YYYY-MM-DD')} ${v.scheduledTime.format('HH:mm')}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        objectId: v.objectId,
        vehicleTypeId: v.vehicleTypeId,
        scheduledAt,
        volumeM3: v.volumeM3 ?? null,
        weightTons: v.weightTons ?? null,
        loadingLocation: v.loadingLocation,
        unloadingLocation: v.unloadingLocation,
        comment: v.comment ?? '',
      };
      return record
        ? vehicleRequestsApi.update(record.id, {
            requestType: 'freight_transport',
            version: record.version,
            ...base,
            addFileIds: editor.newFileIds(),
            removeFileIds: editor.removedIds,
          })
        : vehicleRequestsApi.create({
            requestType: 'freight_transport',
            ...base,
            fileIds: editor.newFileIds(),
          });
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onFinish = (v: FormValues) => {
    if (v.volumeM3 == null && v.weightTons == null) {
      message.error('Укажите объём или массу');
      return;
    }
    saveMut.mutate(v);
  };

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: RequestStatus; version: number }) =>
      vehicleRequestsApi.changeStatus(v.id, v.status, v.version),
    onSuccess: () => {
      message.success('Статус изменён');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

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

  const canModify = (r: FreightTransportRequestDto) =>
    !r.deletedAt && (!isShtab || r.status === 'new');

  const confirmDelete = (r: FreightTransportRequestDto) =>
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

  const columns: TableColumnType<FreightTransportRequestDto>[] = [
    textColumn({
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      sortable: false,
      searchable: false,
      width: 120,
    }),
    textColumn({ key: 'objectName', title: 'Объект', dataIndex: 'objectName', searchable: false }),
    textColumn<FreightTransportRequestDto>({
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
      key: 'scheduledAt',
      title: 'Дата и время',
      width: 160,
      render: (_v, r) => formatDateTime(r.scheduledAt),
    },
    {
      key: 'amount',
      title: 'Объём / масса',
      width: 140,
      render: (_v, r) => amountLabel(r.volumeM3, r.weightTons),
    },
    textColumn({
      key: 'loadingLocation',
      title: 'Погрузка',
      dataIndex: 'loadingLocation',
      sortable: false,
      searchable: false,
      ellipsis: true,
    }),
    textColumn({
      key: 'unloadingLocation',
      title: 'Разгрузка',
      dataIndex: 'unloadingLocation',
      sortable: false,
      searchable: false,
      ellipsis: true,
    }),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 150,
      render: (_v, r) => (
        <StatusCell
          status={r.status}
          deleted={!!r.deletedAt}
          canChange={canChangeStatus}
          pending={statusMut.isPending && statusMut.variables?.id === r.id}
          onChange={(status) => statusMut.mutate({ id: r.id, status, version: r.version })}
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
    actionsColumn<FreightTransportRequestDto>((r) =>
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
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 260 }}
        options={objectOptions}
        disabled={isShtab}
        value={params.objectId as string | undefined}
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
      extra={<CreateRequestButton current="freight-transport" onCreateHere={openCreate} />}
    >
      <DataTable<FreightTransportRequestDto>
        columns={columns}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? `Заявка ${record.displayNumber}` : 'Новая заявка на грузоперевозку'}
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
          <VehicleTypeSelect kindCode="freight_transport" />
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="volumeM3" label="Объём, м³" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
            </Form.Item>
            <Form.Item name="weightTons" label="Масса, т" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item
              name="scheduledDate"
              label="Дата"
              rules={[{ required: true, message: 'Укажите дату' }]}
            >
              <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="scheduledTime"
              label="Время (МСК)"
              rules={[{ required: true, message: 'Укажите время' }]}
            >
              <TimePicker
                format="HH:mm"
                minuteStep={5}
                needConfirm={false}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Space>
          <Form.Item
            name="loadingLocation"
            label="Место погрузки"
            rules={[{ required: true, message: 'Укажите место погрузки' }]}
          >
            <Input maxLength={1000} />
          </Form.Item>
          <Form.Item
            name="unloadingLocation"
            label="Место разгрузки"
            rules={[{ required: true, message: 'Укажите место разгрузки' }]}
          >
            <Input maxLength={1000} />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item label="Файлы">
            <FileEditor editor={editor} />
          </Form.Item>
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
