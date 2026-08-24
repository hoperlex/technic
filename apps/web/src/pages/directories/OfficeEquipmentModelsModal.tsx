import { useState } from 'react';
import { App, Button, Checkbox, Input, Select, Space, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentModelDto } from '@technic/contracts';
import {
  DataTable,
  ListToolbar,
  sortOptionsFrom,
  ViewModal,
  type FilterDefinition,
} from '@shared/ui';
import { errorMessage, useIsMobile, useListParams } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentModelsApi,
  OfficeEquipmentModelFormModal,
} from '@entities/office-equipment';
import { useAuth } from '../../auth/AuthContext';
import {
  MODEL_COUNT_HINT,
  officeEquipmentModelCard,
  officeEquipmentModelColumns,
  UNCOVERED_HINT,
} from './officeEquipmentModelGrid';

/**
 * Ведение моделей аппаратов — окном из вкладки «Оргтехника»
 * (план `docs/office-equipment-consumables-plan.md`, Р8; приём ADR 0120).
 *
 * Почему окно, а не вкладка. Модель — не раздел портала, а то, из чего выбирают, стоя в карточке
 * техники и (со следующим выпуском) в карточке расходника. Разведённые вкладки заставляли бы
 * ходить между ними при каждом вопросе «к чему это подходит», а вкладка ради справочника, который
 * читают выпадающим списком, стоила бы места в шапке «Справочников».
 *
 * Почему таблица, а не список, как у типов. Типов десяток, моделей сорок пять и будет больше:
 * список без страниц, поиска и сортировки на такой длине превращается в прокрутку. Устройство
 * таблицы внутри окна — по образцу окна маршрутов (`VehicleRoutesModal`).
 */

interface Option {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Типы приходят готовыми: вкладка их уже запросила ради своего фильтра и формы карточки. */
  typeOptions: Option[];
  typesLoading: boolean;
}

export function OfficeEquipmentModelsModal({ open, onClose, typeOptions, typesLoading }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  // Ведение справочника: без права окно остаётся перечнем — ни строки действий, ни «Добавить».
  const canWrite = can('officeEquipment.write');
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const { params, setParams, setSort, onTableChange } = useListParams<{
    equipmentTypeId?: string;
    isActive?: string;
    /** Срез «чем заправлять — неизвестно» (Р15); значение у параметра одно. */
    coverage?: 'uncovered';
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>(
    // Алфавит просится явно: умолчание `baseListQuery` — «последняя заведённая сверху»
    // (`sortOrder: 'desc'`), и справочник, который читают глазами, открывался бы задом наперёд.
    { sortBy: 'name', sortOrder: 'asc' },
    // Поиск живёт в панели над таблицей, а не лупой в заголовке: сервер ищет сразу по двум полям —
    // наименованию и производителю, — и лупа у одного столбца обещала бы поиск только по нему.
    { searchKeys: [] },
  );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentModelKeys.list(params),
    queryFn: () => officeEquipmentModelsApi.list(params),
    // Перечень нужен, только пока окно открыто: ради кнопки в шапке вкладки его не запрашивают.
    enabled: open,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [record, setRecord] = useState<OfficeEquipmentModelDto | null>(null);

  const openCreate = () => {
    setRecord(null);
    setFormOpen(true);
  };
  const openEdit = (m: OfficeEquipmentModelDto) => {
    setRecord(m);
    setFormOpen(true);
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => officeEquipmentModelsApi.remove(id),
    onSuccess: () => {
      message.success('Модель удалена');
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      // Матрица Р14: имя модели стоит зеркалом в строке справочника техники.
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // И в карточке расходника — перечнем «Подходит к»: удалённая модель обязана уйти и оттуда.
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
    },
    // «На модель ссылается техника» — обычный ответ сервера, а не сбой: он и объясняет, почему
    // строку не убрать, и подсказывает, что делать вместо этого.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (m: OfficeEquipmentModelDto) =>
    modal.confirm({
      title: `Удалить модель «${m.name}»?`,
      content:
        'Запись удаляется насовсем. Модель, которой уже названа техника, удалить нельзя — чтобы её перестали предлагать при заведении карточек, снимите «Активна».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(m.id),
    });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const grid = { canWrite, onEdit: openEdit, onDelete: confirmDelete };
  const columns = officeEquipmentModelColumns(grid);
  const card = officeEquipmentModelCard(grid);

  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Сервер ищет по наименованию и производителю сразу: спрашивают и «Ricoh», и «IM 350», и
        // обе половины названия обязаны находить одну строку (Р9).
        placeholder="Наименование или производитель"
        style={{ width: 260 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы"
        style={{ width: 200 }}
        loading={typesLoading}
        options={typeOptions}
        value={params.equipmentTypeId}
        onChange={(v: string | undefined) => applyFilter({ equipmentTypeId: v })}
      />
      <Select
        allowClear
        placeholder="Любая активность"
        style={{ width: 180 }}
        options={[
          { value: 'true', label: 'Активные' },
          { value: 'false', label: 'Погашенные' },
        ]}
        value={params.isActive}
        onChange={(v: string | undefined) => applyFilter({ isActive: v })}
      />
      {/* Срез, по которому дозаполняют номенклатуру (Р15): его пустота и означает «покрыли всё».
          Переключателем, а не парой значений: обратный вопрос «покрытые» это весь перечень минус
          срез, и решений по такому списку никто не принимает — контракт его и не принимает. */}
      <Tooltip title={UNCOVERED_HINT}>
        <Checkbox
          checked={params.coverage === 'uncovered'}
          onChange={(e) => applyFilter({ coverage: e.target.checked ? 'uncovered' : undefined })}
        >
          Без расходника
        </Checkbox>
      </Tooltip>
    </Space>
  );

  /** Те же отборы описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'equipmentTypeId',
      label: 'Тип',
      value: params.equipmentTypeId,
      options: typeOptions,
      loading: typesLoading,
      placeholder: 'Все типы',
      onChange: (v) => applyFilter({ equipmentTypeId: v }),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Погашенные' },
      ],
      placeholder: 'Любая',
      onChange: (v) => applyFilter({ isActive: v }),
    },
    {
      kind: 'toggle',
      key: 'coverage',
      label: 'Без расходника',
      value: params.coverage === 'uncovered',
      onChange: (v) => applyFilter({ coverage: v ? 'uncovered' : undefined }),
    },
  ];

  return (
    <ViewModal
      title="Модели аппаратов"
      open={open}
      onClose={onClose}
      width={1000}
      // Окно открывают, чтобы найти одну строку, и в следующий раз — уже другую: пересобрать список
      // дешевле, чем тащить за собой отбор прошлого захода.
      destroyOnHidden
      // Заведение — единственное собственное действие окна, и на телефоне ему место в футере:
      // круглая кнопка `Fab` живёт у нижней навигации страницы, которой под окном нет вовсе.
      footer={
        canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить модель
          </Button>
        ) : null
      }
      // Тело обязано иметь высоту: `DataTable` меряет свой контейнер и считает по нему `scroll.y`,
      // а в теле, растущем по содержимому, намерил бы ноль и схлопнулся.
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '70vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      {isMobile ? (
        <ListToolbar
          search={{
            value: params.search,
            placeholder: 'Наименование или производитель',
            onChange: (v) => applyFilter({ search: v }),
          }}
          filters={mobileFilters}
          sort={{
            options: sortOptionsFrom(columns),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          }}
        />
      ) : (
        <div style={{ flex: '0 0 auto' }}>{filters}</div>
      )}
      <Typography.Text type="secondary" style={{ flex: '0 0 auto', fontSize: 12 }}>
        {MODEL_COUNT_HINT}
      </Typography.Text>

      {/* Прокрутку на телефоне держит эта обёртка: карточки растут по содержимому и без неё
          уехали бы за нижний край окна. На десктопе прокручивается сама таблица. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: isMobile ? 'auto' : undefined }}>
        <DataTable<OfficeEquipmentModelDto>
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
      </div>

      {/* Форма стоит внутри окна списка намеренно: antd поднимает z-index вложенного окна над
          родительским по контексту, а соседнее на телефоне оказалось бы под шторкой списка. */}
      <OfficeEquipmentModelFormModal
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        record={record}
        typeOptions={typeOptions}
        typesLoading={typesLoading}
        // Тип заведённой модели неизменяем (Р1): при правке поле заперто, при заведении — открыто.
        lockedTypeId={record?.type.id}
      />
    </ViewModal>
  );
}
