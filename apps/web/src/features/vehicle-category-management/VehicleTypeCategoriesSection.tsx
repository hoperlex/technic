import { useState } from 'react';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  formatSpecNumber,
  specLabel,
  type CreateVehicleCategoryInput,
  type UpdateVehicleCategoryInput,
  type VehicleCategoryDto,
  type VehicleTypeSpecDto,
} from '@technic/contracts';
import {
  vehicleCategoriesApi,
  vehicleCategoryKeys,
  vehicleClassificationKeys,
  vehicleSpecKeys,
  vehicleTypeErrorMessage as errorMessage,
  vehicleTypeKeys,
  vehicleTypeSpecKeys,
} from '@entities/vehicle-type';
import { weeklyRequestKeys } from '@entities/weekly-request';
import { useIsMobile } from '@shared/lib';
import { FormModal } from '@shared/ui';

interface CategoryFormValues {
  values?: Record<string, number | undefined>;
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

interface Props {
  typeId: string;
  specs: VehicleTypeSpecDto[];
  categories: VehicleCategoryDto[];
  loading: boolean;
}

const sectionHeadStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
};

/** Edit complete, unique spec tuples that form orderable vehicle categories (ADR 0016). */
export function VehicleTypeCategoriesSection({ typeId, specs, categories, loading }: Props) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleCategoryDto | null>(null);
  const [form] = Form.useForm<CategoryFormValues>();

  // Specs and category tuples are one invariant (ADR 0016): a spec change rewrites every category
  // of the type, and a category change is read through the type, the spec directory and the
  // classifier. Every mutation of the type card therefore drops the same five caches; the set is
  // kept identical to the one in vehicle-type-spec-management on purpose. The classifier
  // (ADR 0028) is assembled from types and categories, so a new category changes both what the
  // directory shows and what the pickers offer.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: vehicleTypeSpecKeys.byType(typeId) });
    void queryClient.invalidateQueries({ queryKey: vehicleCategoryKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleTypeKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleSpecKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ sortOrder: (categories.length + 1) * 10, isActive: true });
    setOpen(true);
  };
  const openEdit = (category: VehicleCategoryDto) => {
    setEditing(category);
    form.resetFields();
    const values: Record<string, number> = {};
    for (const value of category.values) values[value.specId] = value.value;
    form.setFieldsValue({
      values,
      // The automatic name is not put into the field: an empty field means «keep the auto name».
      name: category.isAutoName ? '' : category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: CategoryFormValues) => {
      const tuple = specs.map((spec) => ({
        specId: spec.specId,
        value: values.values?.[spec.specId] as number,
      }));
      if (editing) {
        const body: UpdateVehicleCategoryInput = {
          values: tuple,
          name: values.name ?? '',
          sortOrder: values.sortOrder,
          isActive: values.isActive,
        };
        return vehicleCategoriesApi.update(editing.id, body);
      }
      const body: CreateVehicleCategoryInput = {
        vehicleTypeId: typeId,
        values: tuple,
        name: values.name || undefined,
        sortOrder: values.sortOrder ?? 100,
        isActive: values.isActive ?? true,
      };
      return vehicleCategoriesApi.create(body);
    },
    onSuccess: () => {
      message.success('Сохранено');
      invalidate();
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      vehicleCategoriesApi.update(id, { isActive }),
    onSuccess: invalidate,
    onError: (error) => message.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => vehicleCategoriesApi.remove(id),
    onSuccess: () => {
      message.success('Категория удалена');
      invalidate();
      // The same removal makes the server drop rows of unapplied weekly requests that ordered this
      // category: the week's composition is different now (docs/adr/0085-weekly-vehicle-request.md,
      // R15).
      void queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmRemove = (category: VehicleCategoryDto) =>
    modal.confirm({
      title: `Удалить категорию «${category.name}»?`,
      content: 'Ошибочно заведённую категорию лучше удалить, чем держать неактивной в списках.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(category.id),
    });

  return (
    <div>
      <div style={sectionHeadStyle}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Категории
        </Typography.Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!specs.length}
          onClick={openCreate}
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
        columns={[
          {
            key: 'name',
            title: 'Категория',
            dataIndex: 'name',
            // On a phone the table slides sideways; the name stays as the row anchor (ADR 0030).
            width: isMobile ? 150 : undefined,
            fixed: isMobile ? 'left' : undefined,
            render: (value: string, category) => (
              <Space size={6}>
                <span>{value}</span>
                {category.isAutoName ? null : <Tag>имя вручную</Tag>}
              </Space>
            ),
          },
          ...specs.map((spec) => ({
            key: `spec_${spec.specId}`,
            title: spec.unit ? `${specLabel(spec)}, ${spec.unit}` : specLabel(spec),
            width: 130,
            render: (_value: unknown, category: VehicleCategoryDto) => {
              const value = category.values.find((item) => item.specId === spec.specId);
              return value ? formatSpecNumber(value.value, value.decimals) : '—';
            },
          })),
          {
            key: 'isActive',
            title: 'Активна',
            dataIndex: 'isActive',
            width: 100,
            render: (value: boolean, category: VehicleCategoryDto) => (
              <Switch
                size="small"
                checked={value}
                loading={toggle.isPending}
                onChange={(isActive) => toggle.mutate({ id: category.id, isActive })}
              />
            ),
          },
          {
            key: 'actions',
            title: '',
            width: 100,
            render: (_value: unknown, category: VehicleCategoryDto) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(category)} />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => confirmRemove(category)}
                />
              </Space>
            ),
          },
        ]}
        dataSource={categories}
        loading={loading}
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
      <FormModal
        title={editing ? 'Редактирование категории' : 'Новая категория'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={save.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          {specs.map((spec) => (
            <Form.Item
              key={spec.specId}
              name={['values', spec.specId]}
              label={spec.unit ? `${spec.name}, ${spec.unit}` : spec.name}
              rules={[{ required: true, message: 'Укажите значение' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={spec.minValue ?? undefined}
                max={spec.maxValue ?? undefined}
                precision={spec.decimals}
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
    </div>
  );
}
