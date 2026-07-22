import { useState } from 'react';
import {
  Alert,
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
  Tag,
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
  MIN_WASTE_VOLUME_M3,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  requestStatusColors,
  requestStatusLabels,
  requestStatusTransitions,
  requestTypeColors,
  requestTypeLabels,
  type WasteRequestDto,
} from '@technic/contracts';
import {
  containerTypesApi,
  containersApi,
  filesApi,
  machineTypesApi,
  objectsApi,
  wasteRequestsApi,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '../api/resources';
import { DataTable } from '../components/DataTable';
import { FormModal } from '../components/FormModal';
import { PageTableLayout } from '../components/PageTableLayout';
import { actionsColumn, badgeColumn, textColumn } from '../components/columns';
import { useListParams } from '../hooks/useListParams';
import { useAuth } from '../auth/AuthContext';
import { errorMessage, formatBytes, formatDateTime } from '../utils/format';

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
  containerId?: string;
  machineTypeId?: string;
  volumeM3?: number;
  deliveryAt: Dayjs;
  comment?: string;
}

/** Человекочитаемое описание предмета заявки для колонки списка. */
function requestSubject(r: WasteRequestDto): string {
  if (r.requestType === 'waste_removal') {
    const parts = [r.machineTypeName, r.volumeM3 != null ? `${r.volumeM3} м³` : null].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }
  if (r.requestType === 'container_replace') {
    if (!r.containerTypeName) return '—';
    return r.containerLabel ? `${r.containerTypeName} — ${r.containerLabel}` : r.containerTypeName;
  }
  return r.containerTypeName ?? '—';
}

export function WasteRequestsPage() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { user, hasRole } = useAuth();
  const canChangeStatus = hasRole('admin', 'manager', 'dispatcher');
  const isShtab = hasRole('shtab');
  const isAdmin = hasRole('admin');

  const { params, onTableChange } = useListParams<{
    status?: string;
    requestType?: string;
  }>(
    {},
    {
      searchKeys: ['objectName', 'comment'],
      mapFilters: (f) => ({
        status: f.status?.[0] as string | undefined,
        requestType: f.requestType?.[0] as string | undefined,
      }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', params],
    queryFn: () => wasteRequestsApi.list(params),
  });

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
  const { data: machines } = useQuery({
    queryKey: ['machine-types', 'for-select'],
    queryFn: () =>
      machineTypesApi.list({
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
  const typeOptions = (types?.items ?? []).map((t) => ({ value: t.id, label: t.name }));
  const machineOptions = (machines?.items ?? []).map((m) => ({ value: m.id, label: m.name }));
  const requestTypeOptions = REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<WasteRequestDto | null>(null);
  const [form] = Form.useForm<RequestFormValues>();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const watchObjectId = Form.useWatch('objectId', form);
  const watchRequestType = Form.useWatch('requestType', form);

  // Контейнеры выбранного объекта — для «Замены» и проверки площадки при «Вывозе».
  const { data: objectContainers } = useQuery({
    queryKey: ['containers', 'for-object', watchObjectId],
    queryFn: () =>
      containersApi.list({
        objectId: watchObjectId,
        isActive: 'true',
        pageSize: 500,
        sortBy: 'containerTypeName',
        sortOrder: 'asc',
      }),
    enabled: !!watchObjectId,
  });
  const containerInstanceOptions = (objectContainers?.items ?? []).map((c) => ({
    value: c.id,
    label: c.label ? `${c.containerTypeName} — ${c.label}` : c.containerTypeName,
  }));
  const objectHasContainers = (objectContainers?.items?.length ?? 0) > 0;

  const openCreate = () => {
    setRecord(null);
    setFiles([]);
    setRemovedIds([]);
    form.resetFields();
    if (isShtab && user?.constructionObjectId) {
      form.setFieldsValue({ objectId: user.constructionObjectId } as Partial<RequestFormValues>);
    }
    setOpen(true);
  };
  const openEdit = (r: WasteRequestDto) => {
    setRecord(r);
    setFiles(r.files.map((f) => ({ id: f.id, filename: f.filename, size: f.size, isNew: false })));
    setRemovedIds([]);
    form.resetFields();
    form.setFieldsValue({
      objectId: r.objectId,
      requestType: r.requestType,
      containerTypeId: r.containerTypeId ?? undefined,
      containerId: r.containerId ?? undefined,
      machineTypeId: r.machineTypeId ?? undefined,
      volumeM3: r.volumeM3 ?? undefined,
      deliveryAt: dayjs(r.deliveryAt),
      comment: r.comment,
    });
    setOpen(true);
  };

  // Смена типа заявки очищает поля предыдущего варианта.
  const handleRequestTypeChange = () => {
    form.setFieldsValue({
      containerTypeId: undefined,
      containerId: undefined,
      machineTypeId: undefined,
      volumeM3: undefined,
    });
  };
  // Смена объекта сбрасывает выбранный контейнер (он принадлежит прежнему объекту).
  const handleObjectChange = () => {
    form.setFieldsValue({ containerId: undefined });
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
      const base = {
        objectId: values.objectId,
        requestType: values.requestType,
        containerTypeId:
          values.requestType === 'container_install' ? values.containerTypeId : undefined,
        containerId: values.requestType === 'container_replace' ? values.containerId : undefined,
        machineTypeId: values.requestType === 'waste_removal' ? values.machineTypeId : undefined,
        volumeM3: values.requestType === 'waste_removal' ? values.volumeM3 : undefined,
        deliveryAt: values.deliveryAt.toISOString(),
        comment: values.comment ?? '',
      };
      if (record) {
        const payload: WasteRequestUpdatePayload = {
          ...base,
          addFileIds: files.filter((f) => f.isNew).map((f) => f.id),
          removeFileIds: removedIds,
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
    onError: (e) => message.error(errorMessage(e)),
  });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: RequestStatus; version: number }) =>
      wasteRequestsApi.changeStatus(v.id, v.status, v.version),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['waste-requests'] }),
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

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
    const transitions = requestStatusTransitions[r.status];
    const badge = (
      <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
        {requestStatusLabels[r.status]}
      </Tag>
    );
    if (!canChangeStatus || r.deletedAt || transitions.length === 0) {
      return badge;
    }
    const pending = statusMut.isPending && statusMut.variables?.id === r.id;
    return (
      <Dropdown
        trigger={['click']}
        disabled={pending}
        menu={{
          items: transitions.map((s) => ({ key: s, label: requestStatusLabels[s] })),
          onClick: ({ key }) =>
            statusMut.mutate({ id: r.id, status: key as RequestStatus, version: r.version }),
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
    textColumn<WasteRequestDto>({ key: 'objectName', title: 'Объект', dataIndex: 'objectName' }),
    {
      key: 'containerTypeName',
      title: 'Контейнер / машина',
      dataIndex: 'containerTypeName',
      width: 240,
      render: (_v: unknown, r: WasteRequestDto) => requestSubject(r),
    },
    badgeColumn<WasteRequestDto>({
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      labels: requestTypeLabels,
      colors: requestTypeColors,
      filters: true,
      width: 140,
    }),
    textColumn<WasteRequestDto>({
      key: 'deliveryAt',
      title: 'Дата и время доставки',
      dataIndex: 'deliveryAt',
      searchable: false,
      width: 190,
      render: (v) => formatDateTime(v as string),
    }),
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 170,
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
      ellipsis: true,
    }),
    {
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      width: 100,
      render: (_v: unknown, r: WasteRequestDto) => <FilesCell r={r} />,
    },
    actionsColumn<WasteRequestDto>((r) => {
      if (r.deletedAt) {
        return isAdmin ? (
          <Button size="small" icon={<ReloadOutlined />} onClick={() => restoreMut.mutate(r.id)}>
            Восстановить
          </Button>
        ) : (
          <Tag>в архиве</Tag>
        );
      }
      const allowed = canModify(r);
      return (
        <Space>
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

  return (
    <PageTableLayout
      title="Вывоз мусора"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Создать заявку
        </Button>
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

      <FormModal
        title={record ? 'Редактирование заявки' : 'Новая заявка'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
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
              <Select options={typeOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          )}

          {watchRequestType === 'container_replace' && (
            <Form.Item
              name="containerId"
              label="Тип контейнера"
              rules={[{ required: true, message: 'Выберите контейнер' }]}
              extra={!objectHasContainers ? 'На объекте нет привязанных контейнеров' : undefined}
            >
              <Select
                options={containerInstanceOptions}
                showSearch
                optionFilterProp="label"
                placeholder="Контейнер на объекте"
                notFoundContent="На объекте нет контейнеров"
              />
            </Form.Item>
          )}

          {watchRequestType === 'waste_removal' && (
            <>
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
                ]}
              >
                <InputNumber
                  min={MIN_WASTE_VOLUME_M3}
                  style={{ width: '100%' }}
                  placeholder="Например, 20"
                />
              </Form.Item>
              <Form.Item
                name="machineTypeId"
                label="Тип машины"
                rules={[{ required: true, message: 'Выберите тип машины' }]}
              >
                <Select options={machineOptions} showSearch optionFilterProp="label" />
              </Form.Item>
              {!objectHasContainers && (
                <Alert
                  type="warning"
                  showIcon
                  message="На объекте нет привязанных контейнеров"
                  style={{ marginBottom: 16 }}
                />
              )}
            </>
          )}
          <Form.Item
            name="deliveryAt"
            label="Дата и время доставки"
            rules={[{ required: true, message: 'Укажите дату и время' }]}
          >
            <DatePicker
              showTime
              format="DD.MM.YYYY HH:mm"
              style={{ width: '100%' }}
              placeholder="Выберите дату и время"
            />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
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
