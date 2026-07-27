import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Tag,
  type TableColumnType,
} from 'antd';
import { EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  parseVehicleRequestNumberSearch,
  type RequestStatus,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
import { UserAvatar } from '../../components/UserAvatar';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
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
  dateFrom: Dayjs;
  dateTo?: Dayjs | null;
  comment?: string;
}

const fmtDate = (s: string) => dayjs(s).format('DD.MM.YYYY');

export function SpecialEquipmentRequestsTab() {
  const { message, modal } = App.useApp();
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const canChangeStatus = hasRole('admin', 'manager', 'dispatcher');
  const isAdmin = hasRole('admin');
  const isShtab = hasRole('shtab');

  const { params, setParams, onTableChange } = useListParams<{
    requestType: 'special_equipment';
    status?: string;
  }>(
    { requestType: 'special_equipment' },
    {
      searchKeys: ['comment'],
      mapFilters: (f) => ({ status: f.status?.[0] as string | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'special-equipment', params],
    queryFn: () => vehicleRequestsApi.list(params),
  });
  const items = (data?.items ?? []) as SpecialEquipmentRequestDto[];

  const objectOptions = useObjectOptions();

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<SpecialEquipmentRequestDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const editor = useFileEditor();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    editor.reset([]);
    setOpen(true);
  };
  useOpenCreateFromQuery('special-equipment', openCreate);

  const openEdit = (r: SpecialEquipmentRequestDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      objectId: r.objectId,
      vehicleTypeId: r.vehicleTypeId,
      dateFrom: dayjs(r.dateFrom),
      dateTo: r.dateTo ? dayjs(r.dateTo) : null,
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
      const base = {
        objectId: v.objectId,
        vehicleTypeId: v.vehicleTypeId,
        dateFrom: v.dateFrom.format('YYYY-MM-DD'),
        dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
        comment: v.comment ?? '',
      };
      return record
        ? vehicleRequestsApi.update(record.id, {
            requestType: 'special_equipment',
            version: record.version,
            ...base,
            addFileIds: editor.newFileIds(),
            removeFileIds: editor.removedIds,
          })
        : vehicleRequestsApi.create({
            requestType: 'special_equipment',
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

  const canModify = (r: SpecialEquipmentRequestDto) =>
    !r.deletedAt && (!isShtab || r.status === 'new');

  const confirmDelete = (r: SpecialEquipmentRequestDto) =>
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

  const columns: TableColumnType<SpecialEquipmentRequestDto>[] = [
    textColumn({
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      sortable: false,
      searchable: false,
      width: 120,
    }),
    textColumn({ key: 'objectName', title: 'Объект', dataIndex: 'objectName', searchable: false }),
    textColumn<SpecialEquipmentRequestDto>({
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
      key: 'period',
      title: 'Период',
      width: 190,
      render: (_v, r) =>
        r.dateTo ? `${fmtDate(r.dateFrom)} – ${fmtDate(r.dateTo)}` : fmtDate(r.dateFrom),
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
    actionsColumn<SpecialEquipmentRequestDto>((r) =>
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
      extra={<CreateRequestButton current="special-equipment" onCreateHere={openCreate} />}
    >
      <DataTable<SpecialEquipmentRequestDto>
        columns={columns}
        data={items}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={record ? `Заявка ${record.displayNumber}` : 'Новая заявка на спецтехнику'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
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
          <VehicleTypeSelect kindCode="special_equipment" />
          <Form.Item
            name="dateFrom"
            label="Дата начала"
            rules={[{ required: true, message: 'Укажите дату начала' }]}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="dateTo" label="Дата окончания (необязательно)">
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
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
