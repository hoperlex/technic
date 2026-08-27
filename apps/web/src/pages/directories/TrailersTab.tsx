import { useState } from 'react';
import { App, Button, Checkbox, Form, Input, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type TrailerKind,
  trailerTitle,
  type VehicleStatus,
  type VehicleTrailerDto,
} from '@technic/contracts';
import { trailerKeys, vehicleTrailersApi } from '@entities/vehicle-trailer';
import { DataTable, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import type { FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { TrailerFormModal, type TrailerFormValues } from './TrailerFormModal';
import { type HitchFormValues, TrailerHitchModal } from './TrailerHitchModal';
import {
  hitchedVehicleLabel,
  kindOptions,
  statusOptions,
  trailerCard,
  trailerColumns,
} from './trailerGrid';

// Справочник прицепов (план `docs/vehicle-trailers-plan.md`). Соседняя вкладка с техникой, но не
// её ветка: прицеп не лежит в `vehicles` (Р7), и потому у него свой список, своя карточка и своя
// пара команд привязки. Заказать прицеп заявкой, назначить его на работу или спросить с него
// показания нельзя — это и есть «особый статус» из просьбы заказчика, и держится он тем, что
// прицепа нет ни в одном списке техники.
//
// Вкладка ведёт данные: запрос списка, отборы, архив и подтверждения. Как строка выглядит —
// `trailerGrid`, что спрашивает карточка — `TrailerFormModal`, привязка — `TrailerHitchModal`.

export function TrailersTab() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  // Архив справочника виден тем, кто его ведёт, а возвращает запись администратор (ADR 0021) —
  // кнопка следует за правом, иначе она ведёт в 403.
  const { can } = useAuth();
  const canRestore = can('archive.restore');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    kind?: TrailerKind;
    status?: VehicleStatus;
    includeDeleted?: string;
    // Отборы и поиск задаются только панелью над таблицей: продублируй их выпадашкой столбца —
    // и любая сортировка сбрасывала бы выбранное (в onChange таблицы приходит пустой фильтр).
  }>({}, { searchKeys: [] });

  const { data, isFetching } = useQuery({
    queryKey: trailerKeys.list(params),
    queryFn: () => vehicleTrailersApi.list(params),
  });

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleTrailerDto | null>(null);
  const [form] = Form.useForm<TrailerFormValues>();

  /** Прицеп, для которого открыто окно привязки; `null` — окно закрыто. */
  const [hitchFor, setHitchFor] = useState<VehicleTrailerDto | null>(null);
  const [hitchForm] = Form.useForm<HitchFormValues>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      // В парке шесть полуприцепов и ни одного прицепа — умолчание совпадает с почти всяким вводом.
      kind: 'semi_trailer',
      status: 'active',
    } as Partial<TrailerFormValues>);
    setOpen(true);
  };
  const openEdit = (r: VehicleTrailerDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      kind: r.kind,
      model: r.model,
      registrationNumber: r.registrationNumber,
      vin: r.vin,
      passportNumber: r.passportNumber,
      manufacturedYear: r.manufacturedYear,
      color: r.color,
      maxMassKg: r.maxMassKg,
      curbMassKg: r.curbMassKg,
      status: r.status,
      note: r.note,
    });
    setOpen(true);
  };

  const openHitch = (r: VehicleTrailerDto) => {
    hitchForm.resetFields();
    // Окно открывается там, где прицеп стоит сейчас: переназначение — одна команда (§4.2.1), и
    // человеку остаётся сменить машину или слот, а не отцеплять и цеплять двумя шагами, между
    // которыми можно застрять.
    hitchForm.setFieldsValue({
      vehicleId: r.hitchedVehicle?.id,
      position: r.hitchPosition ?? 1,
    } as Partial<HitchFormValues>);
    setHitchFor(r);
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => vehicleTrailersApi.remove(id),
    onSuccess: () => {
      message.success('Перемещено в архив');
      void qc.invalidateQueries({ queryKey: trailerKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => vehicleTrailersApi.restore(id),
    onSuccess: () => {
      // Привязку восстановление не возвращает (§4.2.3): пока прицеп лежал в архиве, слот мог
      // занять другой. Говорим об этом сразу — иначе пустая графа «за машиной» читается сбоем.
      message.success('Восстановлено. Привязку к машине восстановление не возвращает');
      void qc.invalidateQueries({ queryKey: trailerKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const unhitchMut = useMutation({
    mutationFn: (id: string) => vehicleTrailersApi.unhitch(id),
    onSuccess: () => {
      message.success('Прицеп отцеплен');
      void qc.invalidateQueries({ queryKey: trailerKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060) — из архива и только администратору: обычное удаление здесь и
  // так лишь перекладывает запись в архив.
  const purge = usePurgeAction({
    subject: 'прицеп',
    purge: vehicleTrailersApi.purge,
    invalidate: [trailerKeys.root],
  });

  const confirmDelete = (r: VehicleTrailerDto) =>
    modal.confirm({
      title: `Переместить в архив «${trailerTitle(r)}»?`,
      // Удаление снимает привязку в той же транзакции, а не отказывает из-за неё (§4.2.3):
      // восстановление её не вернёт, и об этой цене надо сказать до нажатия.
      content: r.hitchedVehicle
        ? `Прицеп сойдёт с машины ${hitchedVehicleLabel(r.hitchedVehicle)}; восстановление привязку не вернёт.`
        : undefined,
      okText: 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  const confirmUnhitch = (r: VehicleTrailerDto) =>
    modal.confirm({
      title: `Отцепить «${trailerTitle(r)}»?`,
      content: r.hitchedVehicle
        ? `Слот «Прицеп ${r.hitchPosition}» машины ${hitchedVehicleLabel(r.hitchedVehicle)} освободится.`
        : undefined,
      okText: 'Отцепить',
      cancelText: 'Отмена',
      onOk: () => unhitchMut.mutateAsync(r.id),
    });

  /** Строка одна и та же в таблице и в карточке телефона — набор действий у них общий. */
  const rowActions = {
    canRestore,
    purge,
    onEdit: openEdit,
    onHitch: openHitch,
    onUnhitch: confirmUnhitch,
    onDelete: confirmDelete,
    onRestore: (r: VehicleTrailerDto) => restoreMut.mutate(r.id),
  };
  const columns = trailerColumns(rowActions);
  const card = trailerCard(rowActions);

  const filters = (
    <Space wrap>
      <Select<TrailerKind | undefined>
        allowClear
        placeholder="Все типы"
        style={{ width: 170 }}
        options={kindOptions}
        value={params.kind}
        onChange={(v) => setParams((p) => ({ ...p, kind: v, page: 1 }))}
      />
      <Select<VehicleStatus | undefined>
        allowClear
        placeholder="Все состояния"
        style={{ width: 180 }}
        options={statusOptions}
        value={params.status}
        onChange={(v) => setParams((p) => ({ ...p, status: v, page: 1 }))}
      />
      <Input.Search
        allowClear
        placeholder="Госномер / марка / VIN / ПТС"
        style={{ width: 280 }}
        onSearch={(val) => setParams((p) => ({ ...p, search: val || undefined, page: 1 }))}
      />
      <Checkbox
        checked={params.includeDeleted === 'true'}
        onChange={(e) =>
          setParams((p) => ({
            ...p,
            includeDeleted: e.target.checked ? 'true' : undefined,
            page: 1,
          }))
        }
      >
        Показать архив
      </Checkbox>
    </Space>
  );

  /** Те же отборы описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'kind',
      label: 'Тип ТС',
      value: params.kind,
      options: kindOptions,
      placeholder: 'Все типы',
      onChange: (v) => setParams((p) => ({ ...p, kind: v as TrailerKind | undefined, page: 1 })),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Состояние',
      value: params.status,
      options: statusOptions,
      placeholder: 'Все состояния',
      onChange: (v) =>
        setParams((p) => ({ ...p, status: v as VehicleStatus | undefined, page: 1 })),
    },
    {
      kind: 'toggle',
      key: 'includeDeleted',
      label: 'Показывать архив',
      value: params.includeDeleted === 'true',
      onChange: (checked) =>
        setParams((p) => ({ ...p, includeDeleted: checked ? 'true' : undefined, page: 1 })),
    },
  ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Добавить прицеп
        </Button>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Госномер, марка, ПТС',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: { label: 'Добавить прицеп', icon: <PlusOutlined />, onClick: openCreate },
      }}
    >
      <DataTable<VehicleTrailerDto>
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
      <TrailerFormModal open={open} record={record} form={form} onClose={() => setOpen(false)} />
      <TrailerHitchModal trailer={hitchFor} form={hitchForm} onClose={() => setHitchFor(null)} />
    </PageTableLayout>
  );
}
