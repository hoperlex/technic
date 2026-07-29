import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  type TableColumnType,
} from 'antd';
import { EditOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  type CreateVehicleTypeInput,
  type UpdateVehicleTypeInput,
  type VehicleClassificationDto,
  type VehicleTypeDto,
} from '@technic/contracts';
import {
  vehicleCategoriesApi,
  vehicleClassificationsApi,
  vehicleKindsApi,
  vehicleTypesApi,
} from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { DataTable, type TableChange } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { PageTableLayout } from '../../components/PageTableLayout';
import { actionsColumn, textColumn } from '../../components/columns';
import { errorMessage } from '../../utils/format';
import { VehicleTypeCardDrawer } from './VehicleTypeCardDrawer';

interface VtParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  kindId?: string;
  isActive?: string;
  // объект параметров пригоден как query для apiFetch
  [key: string]: unknown;
}

interface VtFormValues {
  kindId?: string;
  code?: string;
  name?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

// Справочник классификации ТС. Уровней два — тип (ADR 0005) и категория (ADR 0016), — но
// показываются они одним списком (ADR 0028): у типа с категориями строками идут категории, сам
// тип отдельной строкой не выводится, а тип без ТТХ остаётся собой. Состав ТТХ и заведение
// категорий — по-прежнему в карточке типа (VehicleTypeCardDrawer): там это один инвариант.
export function VehicleTypesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [card, setCard] = useState<VehicleTypeDto | null>(null);

  // pageSize берём из контракта: сервер принимает только PAGE_SIZES (100/200/500),
  // произвольное значение отклоняется валидацией querystring и список не грузится.
  const [params, setParams] = useState<VtParams>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<VtParams>) => setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-classifications', params],
    queryFn: () => vehicleClassificationsApi.list(params),
  });

  // Сами типы — для правки и карточки: в строке классификатора лежит только то, что показывают,
  // а форме нужен тип целиком (код, вид, описание, порядок). Типов десятки — грузим разом.
  const { data: typesData } = useQuery({
    queryKey: ['vehicle-types', 'full'],
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const typeById = new Map((typesData?.items ?? []).map((t) => [t.id, t]));

  const { data: kindsData, isLoading: kindsLoading } = useQuery({
    queryKey: ['vehicle-kinds'],
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const kindOptions = (kindsData?.items ?? []).map((k) => ({ value: k.id, label: k.name }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleTypeDto | null>(null);
  const [form] = Form.useForm<VtFormValues>();
  const isEdit = !!record;

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ sortOrder: 100, isActive: true });
    setOpen(true);
  };
  const openEdit = (r: VehicleTypeDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      kindId: r.kindId,
      code: r.code,
      name: r.name,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (
      arg: { create: CreateVehicleTypeInput } | { id: string; body: UpdateVehicleTypeInput },
    ) =>
      'create' in arg
        ? vehicleTypesApi.create(arg.create)
        : vehicleTypesApi.update(arg.id, arg.body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
      // Наименование типа — это и подпись его строк в классификаторе (ADR 0028).
      void qc.invalidateQueries({ queryKey: ['vehicle-classifications'] });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: VtFormValues) => {
    if (isEdit) {
      const body: UpdateVehicleTypeInput = {
        name: v.name,
        description: v.description ?? '',
        sortOrder: v.sortOrder,
        isActive: v.isActive,
      };
      saveMut.mutate({ id: record!.id, body });
      return;
    }
    const create: CreateVehicleTypeInput = {
      kindId: v.kindId!,
      code: v.code!,
      name: v.name!,
      description: v.description ?? '',
      sortOrder: v.sortOrder ?? 100,
      isActive: v.isActive ?? true,
    };
    saveMut.mutate({ create });
  };

  // Активация/деактивация — инлайн; деактивация с подтверждением. Строка классификатора может
  // быть и типом, и категорией: выключают ровно то, что в строке, — иначе выключение «Автокрана,
  // г/п 25 т» уносило бы с собой все остальные автокраны.
  const toggleMut = useMutation({
    mutationFn: async (r: { row: VehicleClassificationDto; isActive: boolean }) => {
      if (r.row.vehicleCategoryId) {
        await vehicleCategoriesApi.update(r.row.vehicleCategoryId, { isActive: r.isActive });
        return;
      }
      await vehicleTypesApi.update(r.row.vehicleTypeId, { isActive: r.isActive });
    },
    onSuccess: (_d, v) => {
      const what = v.row.vehicleCategoryId ? 'Категория' : 'Тип';
      message.success(`${what} ${v.isActive ? 'активирован' : 'деактивирован'}${v.row.vehicleCategoryId ? 'а' : ''}`);
      void qc.invalidateQueries({ queryKey: ['vehicle-classifications'] });
      void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
      void qc.invalidateQueries({ queryKey: ['vehicle-categories'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const onToggleActive = (row: VehicleClassificationDto, next: boolean) => {
    if (next) {
      toggleMut.mutate({ row, isActive: true });
      return;
    }
    modal.confirm({
      title: `Деактивировать «${row.label}»?`,
      content: row.vehicleCategoryId
        ? 'Заказать эту категорию будет нельзя; остальные категории типа останутся доступны.'
        : 'Заказать этот тип и любую его категорию будет нельзя.',
      okText: 'Деактивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ row, isActive: false }),
    });
  };

  // Сортировка серверная; снятая сортировка возвращает справочник к его собственному порядку.
  const onTableChange = (c: TableChange) =>
    setParams((p) => ({
      ...p,
      page: c.page,
      pageSize: c.pageSize,
      sortBy: c.sortBy ?? 'sortOrder',
      sortOrder: c.sortOrder ?? 'asc',
    }));

  // Колонки: Вид → Тип/категория → ТТХ → Активен → Действия. Отдельного счётчика категорий
  // больше нет — категории и есть строки списка.
  const columns: TableColumnType<VehicleClassificationDto>[] = [
    textColumn<VehicleClassificationDto>({
      key: 'kindName',
      title: 'Вид',
      dataIndex: 'kindName',
      searchable: false,
      width: 200,
    }),
    {
      key: 'label',
      title: 'Тип/категория',
      dataIndex: 'label',
      sorter: true,
      ellipsis: true,
      // Наименование категории уже начинается с типа («Автокраны, г/п 25 т»), поэтому тип рядом
      // не повторяется. Тег отличает категорию от типа, который выбирается целиком.
      render: (v: string, r) => (
        <Space size={6}>
          <span>{v}</span>
          {r.vehicleCategoryId ? null : <Tag>тип целиком</Tag>}
        </Space>
      ),
    },
    {
      key: 'specCount',
      title: 'ТТХ',
      dataIndex: 'specCount',
      width: 90,
      sorter: false,
      render: (v: number) => (v > 0 ? <Tag color="blue">{v}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      // У категории показываем её доступность целиком: у выключенного типа не бывает доступных
      // категорий, и включать их по одной бессмысленно — сперва нужно включить сам тип.
      render: (v: boolean, r) => {
        const blocked = !!r.vehicleCategoryId && !r.typeIsActive;
        const control = (
          <Switch
            size="small"
            checked={v}
            disabled={blocked}
            loading={toggleMut.isPending}
            onChange={(n) => onToggleActive(r, n)}
          />
        );
        return blocked ? (
          <Tooltip title={`Тип «${r.typeName}» неактивен — активируйте сначала его`}>
            {control}
          </Tooltip>
        ) : (
          control
        );
      },
    },
    actionsColumn<VehicleClassificationDto>((r) => {
      const type = typeById.get(r.vehicleTypeId);
      return (
        <Space size={4}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            title="ТТХ и категории типа"
            disabled={!type}
            onClick={() => type && setCard(type)}
          />
          {/* Правится всегда тип: наименование категории собирается из его ТТХ и значений
              (ADR 0016) и правится там же, в карточке. */}
          <Button
            size="small"
            icon={<EditOutlined />}
            title={`Редактировать тип «${r.typeName}»`}
            disabled={!type}
            onClick={() => type && openEdit(type)}
          />
        </Space>
      );
    }),
  ];

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код, тип, категория)"
        style={{ width: 220 }}
        value={params.search}
        onChange={(e) => patchParams({ search: e.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Вид"
        style={{ width: 200 }}
        options={kindOptions}
        value={params.kindId}
        onChange={(v) => patchParams({ kindId: v })}
      />
      <Select
        allowClear
        placeholder="Активность"
        style={{ width: 150 }}
        options={[
          { value: 'true', label: 'Активные' },
          { value: 'false', label: 'Неактивные' },
        ]}
        value={params.isActive}
        onChange={(v) => patchParams({ isActive: v })}
      />
    </Space>
  );

  const codeRules = isEdit
    ? []
    : [
        { required: true, message: 'Укажите код' },
        {
          pattern: CODE_PATTERN,
          message: 'Только строчные латинские, цифры и _, первый символ — буква',
        },
      ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить
        </Button>
      }
    >
      <DataTable<VehicleClassificationDto>
        columns={columns}
        rowKey="key"
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <FormModal
        title={isEdit ? 'Редактирование типа' : 'Новый тип ТС'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          {isEdit ? (
            <Form.Item label="Вид">
              <Input value={record!.kindName} disabled />
            </Form.Item>
          ) : (
            <Form.Item
              name="kindId"
              label="Вид"
              rules={[{ required: true, message: 'Выберите вид' }]}
            >
              <AutoSelect options={kindOptions} loading={kindsLoading} placeholder="Выберите вид" />
            </Form.Item>
          )}

          <Form.Item name="code" label="Код" rules={codeRules}>
            {/* Код — стабильный системный идентификатор, неизменяем после создания. */}
            <Input disabled={isEdit} placeholder="например truck_cranes" />
          </Form.Item>

          <Form.Item
            name="name"
            label="Наименование типа"
            rules={[{ required: true, message: 'Укажите наименование' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item name="description" label="Описание">
            <Input.TextArea rows={2} />
          </Form.Item>

          <Form.Item name="sortOrder" label="Порядок сортировки">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>

          <Form.Item name="isActive" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
      <VehicleTypeCardDrawer type={card} onClose={() => setCard(null)} />
    </PageTableLayout>
  );
}
