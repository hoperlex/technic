import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Segmented, Select, Space, Tag } from 'antd';
import { DashboardOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RENTAL_STATUSES,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type UpdateVehicleResult,
  type VehicleDto,
  type VehicleOwnership,
  type VehicleStatus,
  VEHICLE_STATUSES,
  parseVehicleClassificationKey,
  rentalActivationBlockReason,
  vehicleOwnershipLabels,
  assignmentRateLabel,
  vehicleClassificationLabel,
  vehicleLabel,
  vehicleStatusColors,
  vehicleStatusLabels,
  vehicleTitle,
} from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { vehicleKeys, vehicleModelKeys, vehicleModelsApi, vehiclesApi } from '@entities/vehicle';
import { vehicleTypeKeys, vehicleTypesApi } from '@entities/vehicle-type';
import {
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
} from '../../hooks/useVehicleClassifications';
import { garageKeys } from '@entities/garage';
import { FuelNormsModal } from './FuelNormsModal';
import { unhitchedNotice, VehicleTrailersField } from '@entities/vehicle-trailer';
import { useVehicleMaintenanceAction } from '@features/vehicle-maintenance';
import { AutoSelect, DataTable, FormModal, PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import type { CardConfig } from '@shared/ui';
import { useIsMobile, useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { useVehicleFilters, type VehicleFilterParams } from './VehicleFilters';
import { vehicleRegistryColumns } from './vehicleRegistryColumns';

// Справочник техники (ADR 0007) с двумя ветками принадлежности (ADR 0018). Один список, а не две
// вкладки: сравнивать своё и аренду нужно рядом. Переключатель принадлежности не только фильтрует,
// но и убирает неприменимые колонки — у аренды нет госномера и марки, у своей нет цен.

interface FormValues {
  ownership: VehicleOwnership;
  /** Ключ позиции классификатора «тип:категория» (ADR 0028); в API уходит парой полей. */
  classificationKey: string;
  vehicleModelId?: string;
  registrationNumber?: string;
  passportNumber?: string;
  lessorId?: string;
  description?: string;
  pricePerHour?: number;
  pricePerShift?: number;
  shiftHours?: number;
  status: VehicleStatus;
  note?: string;
}

const statusOptions = VEHICLE_STATUSES.map((s) => ({ value: s, label: vehicleStatusLabels[s] }));
const rentalStatusOptions = RENTAL_STATUSES.map((s) => ({
  value: s,
  label: vehicleStatusLabels[s],
}));

/**
 * Заведение отвечает голой карточкой — к форме ответа правки его приводит одно место. Снимать
 * привязки заведению не с чего: у новой машины их ещё нет, и ноль здесь — факт, а не заглушка.
 */
const created = (vehicle: VehicleDto): UpdateVehicleResult => ({ vehicle, unhitchedTrailers: 0 });

export function VehiclesTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  // Архив справочника виден тем, кто его ведёт, но возвращает запись из архива администратор
  // (ADR 0021) — кнопка следует за правом, иначе она ведёт в 403.
  const { can } = useAuth();
  const canRestore = can('archive.restore');
  // Обслуживание (Р14в, Р15): своё право, своё окно и та же форма, что в карточке машины.
  const maintenance = useVehicleMaintenanceAction();

  const { params, setParams, setSort, onTableChange } = useListParams<VehicleFilterParams>(
    {},
    { searchKeys: [] },
  );

  const ownershipFilter = params.ownership;
  const showOwnColumns = ownershipFilter !== 'rental';
  const showRentalColumns = ownershipFilter !== 'own';

  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.list(params),
    queryFn: () => vehiclesApi.list(params),
  });

  // Классификатор для селекта (ADR 0028): позиции — категории типа, а у типа без ТТХ сам тип.
  const { groups: classificationGroups, loading: typesLoading } = useVehicleClassifications();

  // Фильтр по типу остаётся типовым: в списке техники сравнивают весь тип целиком — сколько
  // автокранов и чьи они, — а не одну его категорию.
  const { data: typesData } = useQuery({
    queryKey: vehicleTypeKeys.forSelect(),
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const typeOptions = (typesData?.items ?? [])
    .filter((t) => t.isActive)
    .map((t) => ({ value: t.id, label: t.name }));

  // Арендодатели — контрагенты роли «Арендодатель (ТС)»; учёток за ними нет, это чистый справочник.
  const { data: lessorsData, isLoading: lessorsLoading } = useQuery({
    queryKey: counterpartyKeys.activeVehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const activeLessorOptions = (lessorsData?.items ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleDto | null>(null);
  const [form] = Form.useForm<FormValues>();
  const watchOwnership = Form.useWatch('ownership', form) ?? 'own';
  // Выбирают одну позицию классификатора (ADR 0028), а марки/модели грузятся по типу — его
  // достаём из ключа позиции.
  const watchClassificationKey = Form.useWatch('classificationKey', form);
  const picked = parseVehicleClassificationKey(watchClassificationKey);
  const watchTypeId = picked?.vehicleTypeId;
  const isRental = watchOwnership === 'rental';

  // Почему это предложение нельзя включить (ADR 0018 §15). Текст общий с ответом сервера.
  const blockReason = record ? rentalActivationBlockReason(record) : null;
  // Неактивного арендодателя в списке выбора нет — но у правимой записи он может быть именно им.
  // Без этой добавки Select показал бы сырой uuid вместо наименования.
  const lessorOptions =
    record?.lessorId && !activeLessorOptions.some((o) => o.value === record.lessorId)
      ? [
          ...activeLessorOptions,
          { value: record.lessorId, label: `${record.lessorName ?? '—'} (неактивен)` },
        ]
      : activeLessorOptions;

  // Марки/модели выбранного типа (могут быть пусты, пока не засидированы — ADR 0007).
  const { data: modelsData } = useQuery({
    queryKey: vehicleModelKeys.forSelect(watchTypeId),
    queryFn: () =>
      vehicleModelsApi.list({
        page: 1,
        pageSize: 500,
        vehicleTypeId: watchTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!watchTypeId && !isRental,
  });
  const modelOptions = (modelsData?.items ?? []).map((m) => ({ value: m.id, label: m.name }));

  // У правимой записи позиция могла выйти из справочника — или её не быть вовсе: машину завели
  // до появления категорий у её типа. Такую позицию показываем отдельной заблокированной
  // строкой, иначе поле выглядит пустым, будто классификацию потеряли.
  const classificationOptions = withSavedClassification(
    classificationGroups,
    record
      ? {
          vehicleTypeId: record.vehicleTypeId,
          vehicleCategoryId: record.vehicleCategoryId,
          typeName: record.typeName,
          categoryName: record.categoryName,
        }
      : null,
  );

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      ownership: ownershipFilter ?? 'own',
      status: 'active',
    } as Partial<FormValues>);
    setOpen(true);
  };
  const openEdit = (r: VehicleDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      ownership: r.ownership,
      classificationKey: classificationKeyOf(r),
      vehicleModelId: r.vehicleModelId ?? undefined,
      registrationNumber: r.registrationNumber ?? undefined,
      passportNumber: r.passportNumber ?? undefined,
      lessorId: r.lessorId ?? undefined,
      description: r.description || undefined,
      pricePerHour: r.pricePerHour ?? undefined,
      pricePerShift: r.pricePerShift ?? undefined,
      shiftHours: r.shiftHours ?? undefined,
      status: r.status,
      note: r.note,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: async (v: FormValues): Promise<UpdateVehicleResult> => {
      // Выбрана одна позиция классификатора (ADR 0028) — в API она уходит парой «тип +
      // категория»: категория пуста у типа, у которого её и не бывает.
      const chosen = parseVehicleClassificationKey(v.classificationKey)!;
      const common = {
        vehicleTypeId: chosen.vehicleTypeId,
        vehicleCategoryId: chosen.vehicleCategoryId,
        status: v.status,
        note: v.note ?? '',
      };
      if (v.ownership === 'rental') {
        const body = {
          ...common,
          lessorId: v.lessorId!,
          description: v.description ?? '',
          pricePerHour: v.pricePerHour ?? null,
          pricePerShift: v.pricePerShift ?? null,
          shiftHours: v.shiftHours ?? null,
        };
        // Принадлежность неизменяема — в PATCH её не отправляем.
        return record
          ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
          : created(
              await vehiclesApi.create({ ownership: 'rental', ...body } as CreateVehicleInput),
            );
      }
      const body = {
        ...common,
        vehicleModelId: v.vehicleModelId ?? null,
        registrationNumber: v.registrationNumber ?? null,
        passportNumber: v.passportNumber ?? null,
      };
      return record
        ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
        : created(await vehiclesApi.create({ ownership: 'own', ...body } as CreateVehicleInput));
    },
    onSuccess: ({ unhitchedTrailers: unhitched }) => {
      message.success('Сохранено');
      // Снятые привязки — второе изменение в базе, о котором не просили: списание машины и
      // перевод её на бланк «форма № 3» отцепляют закреплённые прицепы (план §4.2.3). Говорим
      // отдельным тостом и дольше обычного — иначе о нём узнают из чужой жалобы. Ноль — молчим:
      // сообщать не о чем, а «отцеплено 0» читалось бы как сбой.
      if (unhitched) message.warning(unhitchedNotice(unhitched, 'этой правкой'), 8);
      void qc.invalidateQueries({ queryKey: vehicleKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => vehiclesApi.remove(id),
    onSuccess: ({ unhitchedTrailers: unhitched }) => {
      message.success('Перемещено в архив');
      // Та же дверь §4.2.3, и молчать ей не разрешено тем более: архивная машина исчезает из
      // списков совсем — о сошедшем с неё прицепе сказать больше будет некому.
      if (unhitched) message.warning(unhitchedNotice(unhitched, 'уходом в архив'), 8);
      void qc.invalidateQueries({ queryKey: vehicleKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => vehiclesApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void qc.invalidateQueries({ queryKey: vehicleKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — из архива и только администратору: обычное удаление здесь и
  // так лишь перекладывает запись в архив.
  const purge = usePurgeAction({
    subject: 'технику',
    purge: vehiclesApi.purge,
    invalidate: [vehicleKeys.root],
  });

  const confirmDelete = (r: VehicleDto) =>
    modal.confirm({
      title: `Переместить в архив «${vehicleTitle(r)}»?`,
      okText: 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const columns = vehicleRegistryColumns({
    ownershipFilter,
    showOwnColumns,
    showRentalColumns,
    canRestore,
    restore: (id) => restoreMut.mutate(id),
    purge,
    maintenanceButton: maintenance.button,
    onFuelNorms: (target) => setNormsFor(target),
    onEdit: openEdit,
    onDelete: confirmDelete,
  });

  /**
   * Справочник норм расхода топлива — окном (план `docs/fuel-norms-plan.md`, §5). Открывается двумя
   * входами: кнопкой в шапке со всеми нормами и действием строки, суженным до одной машины, —
   * вопрос «какая норма у этой» задают, стоя в её строке.
   */
  const [normsFor, setNormsFor] = useState<{ id: string | null; label?: string } | null>(null);

  const { filters, mobileFilters } = useVehicleFilters({
    params,
    setParams,
    typeOptions,
    lessorOptions,
    lessorsLoading,
    statusOptions,
    rentalStatusOptions,
  });

  /**
   * Карточка единицы техники на телефоне (ADR 0042). Заголовок — то, чем машину зовут: у своей
   * это госномер, у аренды — описание предложения («Автокран 70 тн»). Дальше классификация,
   * владелец и ставки: по ним предложения аренды и различают между собой.
   */
  const card: CardConfig<VehicleDto> = {
    title: (r) => vehicleLabel(r),
    badge: (r) => <Tag color={vehicleStatusColors[r.status]}>{vehicleStatusLabels[r.status]}</Tag>,
    primary: (r) =>
      vehicleClassificationLabel({ typeName: r.typeName, categoryName: r.categoryName }),
    lines: [
      (r) => (r.ownership === 'own' ? r.modelName : r.lessorName),
      (r) => assignmentRateLabel(r) || null,
      // Причина, по которой предложение нельзя включить, — строкой: подсказки на касании нет.
      (r) => rentalActivationBlockReason(r),
      (r) => (r.deletedAt ? 'В архиве' : null),
    ],
    onOpen: (r) => (r.deletedAt ? undefined : openEdit(r)),
    actions: (r) =>
      r.deletedAt
        ? [
            ...(canRestore
              ? [{ key: 'restore', label: 'Восстановить', onClick: () => restoreMut.mutate(r.id) }]
              : []),
            ...(purge.allowed
              ? [
                  {
                    key: 'purge',
                    label: 'Удалить окончательно',
                    danger: true,
                    onClick: () => purge.confirm(r.id, vehicleTitle(r)),
                  },
                ]
              : []),
          ]
        : [
            ...maintenance.items({ id: r.id, label: vehicleTitle(r) }),
            {
              key: 'fuel-norms',
              label: 'Нормы расхода',
              onClick: () => setNormsFor({ id: r.id, label: vehicleTitle(r) }),
            },
            { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
            { key: 'delete', label: 'В архив', danger: true, onClick: () => confirmDelete(r) },
          ],
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Space>
          <Button icon={<DashboardOutlined />} onClick={() => setNormsFor({ id: null })}>
            Нормы расхода
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить технику
          </Button>
        </Space>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Госномер, марка, арендодатель',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: { label: 'Добавить технику', icon: <PlusOutlined />, onClick: openCreate },
        // Главное действие на телефоне одно и занято заведением, поэтому справочник норм идёт
        // вторичным: список вторичных у вкладки заводится этой волной впервые.
        secondaryActions: [
          {
            label: 'Нормы расхода',
            icon: <DashboardOutlined />,
            onClick: () => setNormsFor({ id: null }),
          },
        ],
      }}
    >
      <DataTable<VehicleDto>
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
      {/* Справочник норм расхода: одно окно на оба входа — из шапки и из строки машины. */}
      <FuelNormsModal
        open={normsFor !== null}
        vehicleId={normsFor?.id ?? null}
        vehicleLabel={normsFor?.label}
        onClose={() => setNormsFor(null)}
      />

      <FormModal
        title={
          record
            ? `Редактирование: ${vehicleOwnershipLabels[record.ownership].toLowerCase()}`
            : 'Новая единица техники'
        }
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
          onValuesChange={(changed) => {
            // Смена позиции сбрасывает марку/модель: она принадлежит типу, а тип мог смениться.
            if ('classificationKey' in changed) {
              form.setFieldValue('vehicleModelId', undefined);
            }
            // У аренды состояний машины нет — статус приводим к допустимому.
            if (changed.ownership === 'rental' && form.getFieldValue('status') !== 'inactive') {
              form.setFieldValue('status', 'active');
            }
          }}
        >
          <Form.Item
            name="ownership"
            label="Принадлежность"
            extra={
              record ? 'Принадлежность неизменяема: это другая сущность, а не правка' : undefined
            }
          >
            <Segmented<VehicleOwnership>
              disabled={!!record}
              options={[
                { value: 'own', label: vehicleOwnershipLabels.own },
                { value: 'rental', label: vehicleOwnershipLabels.rental },
              ]}
            />
          </Form.Item>

          {/* Одна позиция классификатора вместо пары полей (ADR 0028): у типа с ТТХ выбирают
              категорию — ей же заявка адресована, — а тип без ТТХ выбирается целиком. */}
          <Form.Item
            name="classificationKey"
            label="Тип/категория ТС"
            rules={[{ required: true, message: 'Выберите тип или категорию' }]}
            extra={
              isRental
                ? 'Категория — то, по чему предложение сопоставляется с заявкой: «Автокран, г/п 130 т»'
                : undefined
            }
          >
            <AutoSelect
              options={classificationOptions}
              loading={typesLoading}
              showSearch
              optionFilterProp="label"
              placeholder="Тип или категория"
            />
          </Form.Item>

          {isRental ? (
            <>
              <Form.Item
                name="lessorId"
                label="Арендодатель"
                rules={[{ required: true, message: 'Выберите арендодателя' }]}
              >
                <AutoSelect
                  options={lessorOptions}
                  loading={lessorsLoading}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Контрагент роли «Арендодатель (ТС)»"
                  notFoundContent="Арендодателей нет — заведите их в справочнике контрагентов"
                />
              </Form.Item>
              <Form.Item
                name="description"
                label="Описание"
                extra="Короткий срез вида «Автокран 70 тн» — им различаются предложения одного арендодателя"
              >
                <Input maxLength={120} placeholder="Автокран 70 тн" />
              </Form.Item>
              <Space
                style={{ width: '100%' }}
                size="middle"
                orientation={isMobile ? 'vertical' : 'horizontal'}
              >
                <Form.Item
                  name="pricePerHour"
                  label="₽ / час"
                  style={{ flex: 1 }}
                  rules={[
                    {
                      validator: (_rule, value) =>
                        value != null || form.getFieldValue('pricePerShift') != null
                          ? Promise.resolve()
                          : Promise.reject(new Error('Укажите цену за час или за смену')),
                    },
                  ]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} />
                </Form.Item>
                <Form.Item name="pricePerShift" label="₽ / смена" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} />
                </Form.Item>
                <Form.Item name="shiftHours" label="Часов в смене" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} min={1} max={24} placeholder="8" />
                </Form.Item>
              </Space>
              {/* Активное предложение у неактивного арендодателя невозможно — вариант «Активна»
                  выключен, а причина написана рядом, чтобы не гадать после отказа сервера. */}
              <Form.Item name="status" label="Статус" extra={blockReason ?? undefined}>
                <Select
                  options={rentalStatusOptions.map((o) => ({
                    ...o,
                    disabled: !!blockReason && o.value === 'active',
                  }))}
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="vehicleModelId" label="Марка/модель">
                <Select
                  options={modelOptions}
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  disabled={!watchTypeId}
                  placeholder={watchTypeId ? 'Марка/модель (опционально)' : 'Сначала выберите тип'}
                  notFoundContent="Нет марок для этого типа"
                />
              </Form.Item>
              <Space
                style={{ width: '100%' }}
                size="middle"
                orientation={isMobile ? 'vertical' : 'horizontal'}
              >
                <Form.Item name="registrationNumber" label="Госномер" style={{ flex: 1 }}>
                  <Input maxLength={50} />
                </Form.Item>
                <Form.Item name="status" label="Статус" style={{ flex: 1 }}>
                  <Select options={statusOptions} />
                </Form.Item>
              </Space>
              <Form.Item name="passportNumber" label="ПТС / ПСМ">
                <Input maxLength={100} />
              </Form.Item>
              {/* Закреплённые прицепы — показом (план §7, шаг 4). Место выбрано ручкой: она
                  отбирает по одной машине (`hitchedVehicleId`), поэтому колонка в списке стоила бы
                  запроса на строку, а карточка обходится одним на открытие. Кому блок положен,
                  решает он сам — это правило §4.2.3, и живёт оно в слайсе прицепа. */}
              <VehicleTrailersField vehicle={record} />
            </>
          )}

          <Form.Item name="note" label="Примечание">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </FormModal>
      {maintenance.modal}
    </PageTableLayout>
  );
}
