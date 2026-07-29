import { useState } from 'react';
import {
  App,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  type TableColumnType,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatSpecNumber,
  specLabel,
  type CreateVehicleCategoryInput,
  type UpdateVehicleCategoryInput,
  type VehicleCategoryDto,
  type VehicleTypeDto,
  type VehicleTypeSpecDto,
} from '@technic/contracts';
import { vehicleCategoriesApi, vehicleSpecsApi, vehicleTypesApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { FormModal } from '../../components/FormModal';
import { errorMessage } from '../../utils/format';

// Карточка типа ТС (ADR 0016): состав ТТХ и категории — комбинации их значений. Живут в одной
// карточке, потому что это один инвариант: привязка ТТХ обязывает каждую категорию иметь по нему
// значение, а отвязка меняет их все разом.

interface Props {
  type: VehicleTypeDto | null;
  onClose: () => void;
}

interface AttachFormValues {
  specId?: string;
  sortOrder?: number;
  backfillValue?: number;
}

interface CategoryFormValues {
  values?: Record<string, number | undefined>;
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export function VehicleTypeCardDrawer({ type, onClose }: Props) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const typeId = type?.id ?? '';

  const specsQuery = useQuery({
    queryKey: ['vehicle-type-specs', typeId],
    queryFn: () => vehicleTypesApi.specs(typeId),
    enabled: !!typeId,
  });
  const specs = specsQuery.data ?? [];

  const categoriesQuery = useQuery({
    queryKey: ['vehicle-categories', typeId],
    queryFn: () =>
      vehicleCategoriesApi.list({
        vehicleTypeId: typeId,
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!typeId,
  });
  const categories = categoriesQuery.data?.items ?? [];

  // Список для выбора при привязке: активные ТТХ, ещё не привязанные к этому типу.
  const allSpecsQuery = useQuery({
    queryKey: ['vehicle-specs', 'active'],
    queryFn: () =>
      vehicleSpecsApi.list({
        isActive: 'true',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!typeId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['vehicle-type-specs', typeId] });
    void qc.invalidateQueries({ queryKey: ['vehicle-categories'] });
    void qc.invalidateQueries({ queryKey: ['vehicle-types'] });
    void qc.invalidateQueries({ queryKey: ['vehicle-specs'] });
  };

  // ── ТТХ типа ──

  const [attachOpen, setAttachOpen] = useState(false);
  const [attachForm] = Form.useForm<AttachFormValues>();

  const attachMut = useMutation({
    mutationFn: (v: AttachFormValues) =>
      vehicleTypesApi.attachSpec(typeId, {
        specId: v.specId!,
        sortOrder: v.sortOrder ?? (specs.length + 1) * 10,
        backfillValue: v.backfillValue,
      }),
    onSuccess: () => {
      message.success('ТТХ добавлен типу');
      invalidate();
      setAttachOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const detachMut = useMutation({
    mutationFn: (specId: string) => vehicleTypesApi.detachSpec(typeId, specId),
    onSuccess: () => {
      message.success('ТТХ отвязан от типа');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const reorderMut = useMutation({
    mutationFn: async (ordered: VehicleTypeSpecDto[]) => {
      // Порядок ТТХ задаёт и порядок полей в форме категории, и порядок частей в её
      // наименовании, поэтому перенумеровываем только реально сдвинувшиеся строки.
      for (const [i, s] of ordered.entries()) {
        const next = (i + 1) * 10;
        if (s.sortOrder !== next) {
          await vehicleTypesApi.updateSpec(typeId, s.specId, { sortOrder: next });
        }
      }
    },
    onSuccess: () => invalidate(),
    onError: (e) => message.error(errorMessage(e)),
  });

  const moveSpec = (index: number, dir: -1 | 1) => {
    const next = [...specs];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index]!, next[target]!] = [next[target]!, next[index]!];
    reorderMut.mutate(next);
  };

  const onDetach = (s: VehicleTypeSpecDto) => {
    modal.confirm({
      title: `Отвязать ТТХ «${s.name}» от типа?`,
      content:
        categories.length > 0
          ? `Значения этого ТТХ будут удалены у всех категорий (${categories.length}). Если без него категории станут неразличимы, отвязка не пройдёт.`
          : 'У типа нет категорий — отвязка ничего не затронет.',
      okText: 'Отвязать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => detachMut.mutateAsync(s.specId),
    });
  };

  const attachedIds = new Set(specs.map((s) => s.specId));
  const attachOptions = (allSpecsQuery.data?.items ?? [])
    .filter((s) => !attachedIds.has(s.id))
    .map((s) => ({ value: s.id, label: s.unit ? `${s.name}, ${s.unit}` : s.name }));

  const specColumns: TableColumnType<VehicleTypeSpecDto>[] = [
    { key: 'name', title: 'Характеристика', dataIndex: 'name' },
    {
      key: 'unit',
      title: 'Ед. изм.',
      dataIndex: 'unit',
      width: 100,
      render: (v: string) => v || '—',
    },
    {
      key: 'bounds',
      title: 'Границы',
      width: 130,
      render: (_v, r) =>
        r.minValue == null && r.maxValue == null
          ? '—'
          : `${r.minValue ?? '…'} — ${r.maxValue ?? '…'}`,
    },
    {
      key: 'order',
      title: 'Порядок',
      width: 110,
      render: (_v, _r, i) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={i === 0 || reorderMut.isPending}
            onClick={() => moveSpec(i, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            disabled={i === specs.length - 1 || reorderMut.isPending}
            onClick={() => moveSpec(i, 1)}
          />
        </Space>
      ),
    },
    {
      key: 'actions',
      title: '',
      width: 60,
      render: (_v, r) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          loading={detachMut.isPending}
          onClick={() => onDetach(r)}
        />
      ),
    },
  ];

  // ── Категории ──

  const [categoryOpen, setCategoryOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleCategoryDto | null>(null);
  const [categoryForm] = Form.useForm<CategoryFormValues>();

  const openCreateCategory = () => {
    setEditing(null);
    categoryForm.resetFields();
    categoryForm.setFieldsValue({ sortOrder: (categories.length + 1) * 10, isActive: true });
    setCategoryOpen(true);
  };

  const openEditCategory = (c: VehicleCategoryDto) => {
    setEditing(c);
    categoryForm.resetFields();
    const values: Record<string, number> = {};
    for (const v of c.values) values[v.specId] = v.value;
    categoryForm.setFieldsValue({
      values,
      // Автоматическое наименование в поле не подставляем: пустое поле = «оставить авто».
      name: c.isAutoName ? '' : c.name,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
    });
    setCategoryOpen(true);
  };

  const saveCategoryMut = useMutation({
    mutationFn: (v: CategoryFormValues) => {
      const values = specs.map((s) => ({
        specId: s.specId,
        value: v.values?.[s.specId] as number,
      }));
      if (editing) {
        const body: UpdateVehicleCategoryInput = {
          values,
          name: v.name ?? '',
          sortOrder: v.sortOrder,
          isActive: v.isActive,
        };
        return vehicleCategoriesApi.update(editing.id, body);
      }
      const body: CreateVehicleCategoryInput = {
        vehicleTypeId: typeId,
        values,
        name: v.name ? v.name : undefined,
        sortOrder: v.sortOrder ?? 100,
        isActive: v.isActive ?? true,
      };
      return vehicleCategoriesApi.create(body);
    },
    onSuccess: () => {
      message.success('Сохранено');
      invalidate();
      setCategoryOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const toggleCategoryMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleCategoriesApi.update(id, { isActive }),
    onSuccess: () => invalidate(),
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeCategoryMut = useMutation({
    mutationFn: (id: string) => vehicleCategoriesApi.remove(id),
    onSuccess: () => {
      message.success('Категория удалена');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const onRemoveCategory = (c: VehicleCategoryDto) => {
    modal.confirm({
      title: `Удалить категорию «${c.name}»?`,
      content: 'Ошибочно заведённую категорию лучше удалить, чем держать неактивной в списках.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeCategoryMut.mutateAsync(c.id),
    });
  };

  const categoryColumns: TableColumnType<VehicleCategoryDto>[] = [
    {
      key: 'name',
      title: 'Категория',
      dataIndex: 'name',
      render: (v: string, r) => (
        <Space size={6}>
          <span>{v}</span>
          {r.isAutoName ? null : <Tag>имя вручную</Tag>}
        </Space>
      ),
    },
    ...specs.map<TableColumnType<VehicleCategoryDto>>((s) => ({
      key: `spec_${s.specId}`,
      title: s.unit ? `${specLabel(s)}, ${s.unit}` : specLabel(s),
      width: 130,
      render: (_v, r) => {
        const val = r.values.find((x) => x.specId === s.specId);
        return val ? formatSpecNumber(val.value, val.decimals) : '—';
      },
    })),
    {
      key: 'isActive',
      title: 'Активна',
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean, r) => (
        <Switch
          size="small"
          checked={v}
          loading={toggleCategoryMut.isPending}
          onChange={(n) => toggleCategoryMut.mutate({ id: r.id, isActive: n })}
        />
      ),
    },
    {
      key: 'actions',
      title: '',
      width: 100,
      render: (_v, r) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditCategory(r)} />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onRemoveCategory(r)}
          />
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      title={type ? `Тип ТС: ${type.name}` : ''}
      open={!!type}
      onClose={onClose}
      width={960}
      destroyOnHidden
    >
      <Space direction="vertical" size="large" style={{ display: 'flex' }}>
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              ТТХ типа
            </Typography.Title>
            <Button
              icon={<PlusOutlined />}
              onClick={() => {
                attachForm.resetFields();
                attachForm.setFieldsValue({ sortOrder: (specs.length + 1) * 10 });
                setAttachOpen(true);
              }}
            >
              Добавить ТТХ
            </Button>
          </div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Каждая категория типа обязана иметь значение по каждому ТТХ из этого списка.
          </Typography.Paragraph>
          <Table<VehicleTypeSpecDto>
            rowKey="specId"
            size="small"
            columns={specColumns}
            dataSource={specs}
            loading={specsQuery.isFetching}
            pagination={false}
            locale={{ emptyText: <Empty description="ТТХ не заданы — у типа нет категорий" /> }}
          />
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              Категории
            </Typography.Title>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={specs.length === 0}
              onClick={openCreateCategory}
            >
              Добавить категорию
            </Button>
          </div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Категория — это набор значений ТТХ. Двух категорий с одинаковым набором быть не может.
          </Typography.Paragraph>
          <Table<VehicleCategoryDto>
            rowKey="id"
            size="small"
            columns={categoryColumns}
            dataSource={categories}
            loading={categoriesQuery.isFetching}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  description={
                    specs.length === 0
                      ? 'Категории появляются после добавления ТТХ'
                      : 'Категорий пока нет'
                  }
                />
              ),
            }}
          />
        </div>
      </Space>

      <FormModal
        title="Добавить ТТХ типу"
        open={attachOpen}
        onCancel={() => setAttachOpen(false)}
        onSubmit={() => attachForm.submit()}
        confirmLoading={attachMut.isPending}
        okText="Добавить"
      >
        <Form
          form={attachForm}
          layout="vertical"
          onFinish={(v: AttachFormValues) => attachMut.mutate(v)}
        >
          <Form.Item
            name="specId"
            label="Характеристика"
            rules={[{ required: true, message: 'Выберите ТТХ' }]}
          >
            <AutoSelect
              showSearch
              optionFilterProp="label"
              options={attachOptions}
              loading={allSpecsQuery.isLoading}
              placeholder="Выберите ТТХ"
              notFoundContent="Свободных активных ТТХ нет"
            />
          </Form.Item>
          {categories.length > 0 ? (
            <Form.Item
              name="backfillValue"
              label="Значение для существующих категорий"
              extra={`Будет проставлено всем категориям типа (${categories.length}) — без него они окажутся неполными`}
              rules={[{ required: true, message: 'Укажите значение' }]}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
          ) : null}
          <Form.Item name="sortOrder" label="Порядок">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal
        title={editing ? 'Редактирование категории' : 'Новая категория'}
        open={categoryOpen}
        onCancel={() => setCategoryOpen(false)}
        onSubmit={() => categoryForm.submit()}
        confirmLoading={saveCategoryMut.isPending}
        width={520}
      >
        <Form
          form={categoryForm}
          layout="vertical"
          onFinish={(v: CategoryFormValues) => saveCategoryMut.mutate(v)}
        >
          {specs.map((s) => (
            <Form.Item
              key={s.specId}
              name={['values', s.specId]}
              label={s.unit ? `${s.name}, ${s.unit}` : s.name}
              rules={[{ required: true, message: 'Укажите значение' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={s.minValue ?? undefined}
                max={s.maxValue ?? undefined}
                precision={s.decimals}
              />
            </Form.Item>
          ))}
          <Form.Item
            name="name"
            label="Наименование"
            extra="Пусто — наименование собирается из типа и значений автоматически"
          >
            <Input placeholder="авто" />
          </Form.Item>
          <Form.Item name="sortOrder" label="Порядок">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="isActive" label="Активна" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </Drawer>
  );
}
