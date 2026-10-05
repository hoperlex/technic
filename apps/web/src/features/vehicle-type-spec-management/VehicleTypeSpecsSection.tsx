import { useState } from 'react';
import { App, Button, Empty, Form, InputNumber, Space, Table, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VehicleTypeSpecDto } from '@technic/contracts';
import {
  vehicleCategoryKeys,
  vehicleClassificationKeys,
  vehicleSpecKeys,
  vehicleSpecsApi,
  vehicleTypeErrorMessage as errorMessage,
  vehicleTypeKeys,
  vehicleTypeSpecKeys,
  vehicleTypesApi,
} from '@entities/vehicle-type';
import { useIsMobile } from '@shared/lib';
import { AutoSelect, FormModal } from '@shared/ui';

interface AttachFormValues {
  specId?: string;
  sortOrder?: number;
  backfillValue?: number;
}

interface Props {
  typeId: string;
  specs: VehicleTypeSpecDto[];
  categoriesCount: number;
  loading: boolean;
}

const sectionHeadStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
};

/** Manage the required spec set whose completeness every category must preserve (ADR 0016). */
export function VehicleTypeSpecsSection({ typeId, specs, categoriesCount, loading }: Props) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<AttachFormValues>();
  const availableQuery = useQuery({
    queryKey: vehicleSpecKeys.active(),
    queryFn: () =>
      vehicleSpecsApi.list({
        isActive: 'true',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!typeId,
  });

  // Specs and category tuples are one invariant (ADR 0016): a spec change rewrites every category
  // of the type, and a category change is read through the type, the spec directory and the
  // classifier. Every mutation of the type card therefore drops the same five caches; the set is
  // kept identical to the one in vehicle-category-management on purpose. The classifier
  // (ADR 0028) is assembled from types and categories, so a new category changes both what the
  // directory shows and what the pickers offer.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: vehicleTypeSpecKeys.byType(typeId) });
    void queryClient.invalidateQueries({ queryKey: vehicleCategoryKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleTypeKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleSpecKeys.root });
    void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
  };

  const attach = useMutation({
    mutationFn: (values: AttachFormValues) =>
      vehicleTypesApi.attachSpec(typeId, {
        specId: values.specId!,
        sortOrder: values.sortOrder ?? (specs.length + 1) * 10,
        backfillValue: values.backfillValue,
      }),
    onSuccess: () => {
      message.success('ТТХ добавлен типу');
      invalidate();
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const detach = useMutation({
    mutationFn: (specId: string) => vehicleTypesApi.detachSpec(typeId, specId),
    onSuccess: () => {
      message.success('ТТХ отвязан от типа');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const reorder = useMutation({
    mutationFn: async (ordered: VehicleTypeSpecDto[]) => {
      // Spec order also sets the field order of the category form and the order of parts in its
      // generated name, so only rows that actually moved are renumbered.
      for (const [index, spec] of ordered.entries()) {
        const sortOrder = (index + 1) * 10;
        if (spec.sortOrder !== sortOrder)
          await vehicleTypesApi.updateSpec(typeId, spec.specId, { sortOrder });
      }
    },
    onSuccess: invalidate,
    onError: (error) => message.error(errorMessage(error)),
  });

  const move = (index: number, direction: -1 | 1) => {
    const ordered = [...specs];
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index]!, ordered[target]!] = [ordered[target]!, ordered[index]!];
    reorder.mutate(ordered);
  };
  const confirmDetach = (spec: VehicleTypeSpecDto) =>
    modal.confirm({
      title: `Отвязать ТТХ «${spec.name}» от типа?`,
      content:
        categoriesCount > 0
          ? `Значения этого ТТХ будут удалены у всех категорий (${categoriesCount}). Если без него категории станут неразличимы, отвязка не пройдёт.`
          : 'У типа нет категорий — отвязка ничего не затронет.',
      okText: 'Отвязать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => detach.mutateAsync(spec.specId),
    });

  const attached = new Set(specs.map((spec) => spec.specId));
  const options = (availableQuery.data?.items ?? [])
    .filter((spec) => !attached.has(spec.id))
    .map((spec) => ({
      value: spec.id,
      label: spec.unit ? `${spec.name}, ${spec.unit}` : spec.name,
    }));

  return (
    <div>
      <div style={sectionHeadStyle}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          ТТХ типа
        </Typography.Title>
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ sortOrder: (specs.length + 1) * 10 });
            setOpen(true);
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
        columns={[
          {
            key: 'name',
            title: 'Характеристика',
            dataIndex: 'name',
            width: isMobile ? 150 : undefined,
            fixed: isMobile ? 'left' : undefined,
          },
          {
            key: 'unit',
            title: 'Ед. изм.',
            dataIndex: 'unit',
            width: 100,
            render: (v) => v || '—',
          },
          {
            key: 'bounds',
            title: 'Границы',
            width: 130,
            render: (_value, spec) =>
              spec.minValue == null && spec.maxValue == null
                ? '—'
                : `${spec.minValue ?? '…'} — ${spec.maxValue ?? '…'}`,
          },
          {
            key: 'order',
            title: 'Порядок',
            width: 110,
            render: (_value, _spec, index) => (
              <Space size={4}>
                <Button
                  size="small"
                  icon={<ArrowUpOutlined />}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                />
                <Button
                  size="small"
                  icon={<ArrowDownOutlined />}
                  disabled={index === specs.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                />
              </Space>
            ),
          },
          {
            key: 'actions',
            title: '',
            width: 60,
            render: (_value, spec) => (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={detach.isPending}
                onClick={() => confirmDetach(spec)}
              />
            ),
          },
        ]}
        dataSource={specs}
        loading={loading}
        pagination={false}
        // On a phone the table scrolls sideways inside its frame: five columns with order buttons
        // would otherwise shrink to unreadable at 360 px (ADR 0030).
        scroll={isMobile ? { x: 'max-content' } : undefined}
        locale={{ emptyText: <Empty description="ТТХ не заданы — у типа нет категорий" /> }}
      />
      <FormModal
        title="Добавить ТТХ типу"
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={attach.isPending}
        okText="Добавить"
      >
        <Form form={form} layout="vertical" onFinish={(values) => attach.mutate(values)}>
          <Form.Item
            name="specId"
            label="Характеристика"
            rules={[{ required: true, message: 'Выберите ТТХ' }]}
          >
            <AutoSelect
              showSearch
              optionFilterProp="label"
              options={options}
              loading={availableQuery.isLoading}
              placeholder="Выберите ТТХ"
              notFoundContent="Свободных активных ТТХ нет"
            />
          </Form.Item>
          {categoriesCount > 0 ? (
            <Form.Item
              name="backfillValue"
              label="Значение для существующих категорий"
              extra={`Будет проставлено всем категориям типа (${categoriesCount}) — без него они окажутся неполными`}
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
    </div>
  );
}
