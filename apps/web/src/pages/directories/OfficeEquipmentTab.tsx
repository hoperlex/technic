import { useState } from 'react';
import { App, Button, Checkbox, Form, Select, Space } from 'antd';
import { PlusOutlined, TagsOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OFFICE_EQUIPMENT_WARRANTY_FILTERS,
  type OfficeEquipmentDto,
  type OfficeEquipmentWarrantyFilter,
  officeEquipmentTitle,
  WARRANTY_EXPIRING_DAYS,
} from '@technic/contracts';
import { DataTable } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  OfficeEquipmentFields,
  type OfficeEquipmentFormValues,
  officeEquipmentApi,
  officeEquipmentPayload,
  officeEquipmentUpdatePayload,
  officeEquipmentKeys,
  officeEquipmentTypeOptionsQuery,
  officeEquipmentCard,
  officeEquipmentColumns,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { OfficeEquipmentTypesModal } from './OfficeEquipmentTypesModal';
import { OfficeEquipmentServiceHistory } from './OfficeEquipmentServiceHistory';
import { EquipmentMoveModal } from '@features/equipment-move';
import { EquipmentHistoryModal } from '@features/equipment-history';

/**
 * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам, за каким отделом
 * закреплено и до какого числа действует гарантия поставщика.
 *
 * Вкладка живёт в «Справочниках», а не в разделе заявок на обслуживание (Р7): её ведёт тот же
 * человек, который заводит объекты и контрагентов, а сервису справочник закрыт вовсе — реквизиты
 * нужной ему единицы приходят снимком в самой заявке.
 *
 * Гарантия показана тегом состояния, а не датой (§9.6): справочник открывают с вопросом «что
 * продлевать», и ответ на него — не число, а цвет. Считает состояние общая функция контрактов —
 * подсветка обязана совпадать со списком заявок и реестром гарантий.
 */

/** Три вопроса, которые задают справочнику про гарантию. Порог — общий с подсветкой (Р25). */
const warrantyFilterLabels: Record<OfficeEquipmentWarrantyFilter, string> = {
  active: 'Действует',
  expiring: `Истекает (${WARRANTY_EXPIRING_DAYS} дней)`,
  expired: 'Истекла',
};

const warrantyOptions = OFFICE_EQUIPMENT_WARRANTY_FILTERS.map((value) => ({
  value,
  label: warrantyFilterLabels[value],
}));

export function OfficeEquipmentTab() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canWrite = can('officeEquipment.write');
  const qc = useQueryClient();

  const { params, setParams, setSort, onTableChange } = useListParams<{
    objectId?: string;
    equipmentTypeId?: string;
    departmentId?: string;
    unassignedDepartment?: string;
    warranty?: string;
    isActive?: string;
  }>(
    {},
    {
      // Поиск живёт лупой в заголовке «Модели» — единственного столбца с поисковой выпадашкой;
      // сервер ищет по нему же и по обоим номерам.
      searchKeys: ['name'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentKeys.list(params),
    queryFn: () => officeEquipmentApi.list(params),
  });

  const { data: typeOptions = [], isLoading: typesLoading } = useQuery(
    officeEquipmentTypeOptionsQuery(),
  );
  // Закрытые площадки из списка не убираем: техника на них заведена, и в форме правки привязка
  // осталась бы без наименования — та же оговорка, что у складов приостановленного поставщика.
  const { data: objectOptions = [] } = useQuery(objectOptionsQuery({ activeOnly: false }));
  const { data: departmentOptions = [] } = useQuery(departmentOptionsQuery());

  const [typesOpen, setTypesOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<OfficeEquipmentDto | null>(null);
  const [form] = Form.useForm<OfficeEquipmentFormValues>();
  const blockers = useFormBlockers(form);

  /**
   * Отдел и «без владельца» — один вопрос с двумя ответами, а не два фильтра: сервер их вместе не
   * принимает, да и смысла в «отдел АХО и при этом ничей» нет. Поэтому каждый гасит другой.
   */
  const applyDepartment = (v: string | undefined) =>
    setParams((p) => ({ ...p, departmentId: v, unassignedDepartment: undefined, page: 1 }));
  const applyUnassigned = (checked: boolean) =>
    setParams((p) => ({
      ...p,
      unassignedDepartment: checked ? 'true' : undefined,
      departmentId: undefined,
      page: 1,
    }));

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    // Фильтры площадки и типа — они же ответ на «что заводим»: справочник наполняют кабинет за
    // кабинетом, а не вперемешку.
    form.setFieldsValue({
      isActive: true,
      objectId: params.objectId,
      equipmentTypeId: params.equipmentTypeId,
    } as OfficeEquipmentFormValues);
    setOpen(true);
  };

  const openEdit = (r: OfficeEquipmentDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      equipmentTypeId: r.type.id,
      name: r.name,
      serialNumber: r.serialNumber,
      inventoryNumber: r.inventoryNumber,
      objectId: r.object.id,
      departmentId: r.department?.id,
      location: r.location,
      // Календарный день без времени: `dayjs('2026-08-07')` разбирается в полночь по месту, и
      // обратный `format` возвращает ровно тот же день — пересчёта поясов здесь быть не должно.
      purchasedOn: r.purchasedOn ? dayjs(r.purchasedOn) : undefined,
      warrantyUntil: r.warrantyUntil ? dayjs(r.warrantyUntil) : undefined,
      comment: r.comment,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: OfficeEquipmentFormValues) =>
      record
        ? officeEquipmentApi.update(record.id, officeEquipmentUpdatePayload(values))
        : officeEquipmentApi.create(officeEquipmentPayload(values)),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      setOpen(false);
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => officeEquipmentApi.remove(id),
    onSuccess: () => {
      message.success('Карточка удалена');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
    },
    // «По технике есть незакрытые заявки» — обычный ответ сервера, а не сбой: он и объясняет,
    // почему карточку не убрать.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (r: OfficeEquipmentDto) =>
    modal.confirm({
      title: `Удалить «${officeEquipmentTitle(r)}»?`,
      content:
        'Карточка уходит в архив: заявки на обслуживание по этой технике остаются на месте. Чтобы просто убрать её из выбора, снимите «Активна».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  /** Что открыто в окне перемещения и в ленте истории; `null` — окно закрыто (Р59, Р62). */
  const [moving, setMoving] = useState<OfficeEquipmentDto | null>(null);
  const [historyOf, setHistoryOf] = useState<OfficeEquipmentDto | null>(null);

  const grid = {
    canWrite,
    onEdit: openEdit,
    onDelete: confirmDelete,
    onMove: setMoving,
    onHistory: setHistoryOf,
  };
  const columns = officeEquipmentColumns(grid);

  const filters = (
    <Space wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        value={params.objectId}
        onChange={(v) => setParams((p) => ({ ...p, objectId: v, page: 1 }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 180 }}
        loading={typesLoading}
        options={typeOptions}
        value={params.equipmentTypeId}
        onChange={(v) => setParams((p) => ({ ...p, equipmentTypeId: v, page: 1 }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все отделы"
        style={{ width: 220 }}
        options={departmentOptions}
        disabled={params.unassignedDepartment === 'true'}
        value={params.departmentId}
        onChange={applyDepartment}
      />
      <Checkbox
        checked={params.unassignedDepartment === 'true'}
        onChange={(e) => applyUnassigned(e.target.checked)}
      >
        Без владельца
      </Checkbox>
      <Select
        allowClear
        placeholder="Любая гарантия"
        style={{ width: 200 }}
        options={warrantyOptions}
        value={params.warranty}
        onChange={(v) => setParams((p) => ({ ...p, warranty: v, page: 1 }))}
      />
    </Space>
  );

  /** Те же фильтры описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      onChange: (v) => setParams((p) => ({ ...p, objectId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'equipmentTypeId',
      label: 'Тип',
      value: params.equipmentTypeId,
      options: typeOptions,
      loading: typesLoading,
      placeholder: 'Все типы',
      onChange: (v) => setParams((p) => ({ ...p, equipmentTypeId: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'departmentId',
      label: 'Отдел',
      value: params.departmentId,
      options: departmentOptions,
      placeholder: 'Все отделы',
      disabled: params.unassignedDepartment === 'true',
      onChange: applyDepartment,
    },
    {
      kind: 'toggle',
      key: 'unassignedDepartment',
      label: 'Без владельца',
      value: params.unassignedDepartment === 'true',
      onChange: applyUnassigned,
    },
    {
      kind: 'select',
      key: 'warranty',
      label: 'Гарантия',
      value: params.warranty,
      options: warrantyOptions,
      placeholder: 'Любая',
      onChange: (v) => setParams((p) => ({ ...p, warranty: v, page: 1 })),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Неактивные' },
      ],
      placeholder: 'Все',
      onChange: (v) => setParams((p) => ({ ...p, isActive: v, page: 1 })),
    },
  ];

  const card = officeEquipmentCard(grid);

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Модель, серийный или инвентарный номер',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canWrite
          ? { label: 'Добавить технику', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
      }}
      extra={
        canWrite ? (
          <Space>
            {/* Перечень типов ведут здесь же: отдельной вкладки ради десяти строк не заводят (Р34). */}
            <Button icon={<TagsOutlined />} onClick={() => setTypesOpen(true)}>
              Типы оргтехники
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Добавить технику
            </Button>
          </Space>
        ) : undefined
      }
    >
      <DataTable<OfficeEquipmentDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />

      <OfficeEquipmentTypesModal open={typesOpen} onClose={() => setTypesOpen(false)} />

      <FormModal
        title={record ? 'Редактирование карточки' : 'Новая единица оргтехники'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          {...blockers.formProps}
        >
          <OfficeEquipmentFields
            typeOptions={typeOptions}
            typesLoading={typesLoading}
            objectOptions={objectOptions}
            departmentOptions={departmentOptions}
          />
        </Form>
        {/* Только у заведённой карточки: у новой единицы истории нет по определению, и раздел
            «Обслуживание — ничего» в форме заведения был бы шумом. */}
        {record && <OfficeEquipmentServiceHistory equipmentId={record.id} />}
      </FormModal>

      <EquipmentMoveModal equipment={moving} onClose={() => setMoving(null)} />
      <EquipmentHistoryModal equipment={historyOf} onClose={() => setHistoryOf(null)} />
    </PageTableLayout>
  );
}
