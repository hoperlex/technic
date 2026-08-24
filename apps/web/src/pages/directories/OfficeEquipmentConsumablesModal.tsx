import { useState } from 'react';
import { App, Button, Checkbox, Input, Select, Space, Typography } from 'antd';
import { BarChartOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
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
  officeEquipmentConsumablesApi,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentModelPickerQuery,
} from '@entities/office-equipment';
import { useAuth } from '../../auth/AuthContext';
import { OfficeEquipmentConsumableFormModal } from './OfficeEquipmentConsumableFormModal';
import { OfficeEquipmentStockModal } from './OfficeEquipmentStockModal';
import { OfficeEquipmentConsumableUsageModal } from './OfficeEquipmentConsumableUsageModal';
import {
  officeEquipmentConsumableCard,
  officeEquipmentConsumableColumns,
  PARK_COUNT_HINT,
  STOCK_HINT,
} from './officeEquipmentConsumableGrid';

/**
 * Ведение картриджей и тонеров — окном из вкладки «Оргтехника» (план
 * `docs/office-equipment-consumables-plan.md`, Р8; приём ADR 0120).
 *
 * Почему окно, а не вкладка «Справочников». Расходник существует только при технике: спрашивают о
 * нём всегда вместе с аппаратом — «что подходит к Ricoh IM 350» и «чем заправлять эту машину», — и
 * разведённые вкладки заставляли бы ходить между ними при каждом таком вопросе.
 *
 * Устройство то же, что у соседнего окна моделей: таблица с серверными поиском, сортировкой и
 * страницами, форма поверх окна. Список короткий (пятнадцать строк на старте), но растёт он с
 * каждым новым аппаратом парка, и «список без страниц» пришлось бы переделывать в таблицу через
 * полгода.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Что спрашивает окно сверх базовых параметров списка (Р9). */
interface ConsumableParams {
  modelId?: string;
  stock?: 'out_of_stock';
  isActive?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export function OfficeEquipmentConsumablesModal({ open, onClose }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  /*
   * Права раздельные (Р10) и проверяются независимо.
   *
   * Ведение номенклатуры — своё право, отдельное от `officeEquipment.write`: то открывает весь
   * парк техники, а здесь нужен один справочник, и человеку, который ведёт коды картриджей, парк
   * выдавать незачем. Без него окно остаётся перечнем: карточка открывается на чтение, «Добавить»
   * и «Удалить» не показываются вовсе.
   *
   * Правка остатка — третье право: пересчитать коробки на полке и завести позицию номенклатуры
   * это разные работы. Кладовщик без `manage` карточку не правит, но остаток правит — поэтому
   * окно остатка открывается и прямо из строки, а не только из карточки.
   *
   * Чтение списка и журнала не спрашивается вовсе: сюда приходят из вкладки, которая уже открыта
   * по `officeEquipment.read`.
   */
  const canManage = can('officeEquipmentConsumables.manage');
  const canStock = can('officeEquipmentConsumables.stock');
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const { params, setParams, setSort, onTableChange } = useListParams<ConsumableParams>(
    // Алфавит просится явно: умолчание `baseListQuery` — «последняя заведённая сверху»
    // (`sortOrder: 'desc'`), и справочник, который сверяют со счётом глазами, открывался бы задом
    // наперёд. Поле по умолчанию — наименование: код читают, когда уже нашли строку.
    { sortBy: 'name', sortOrder: 'asc' },
    // Поиск живёт в панели над таблицей, а не лупой в заголовке: сервер ищет сразу по двум полям —
    // наименованию и коду, — и лупа у одного столбца обещала бы поиск только по нему (Р9).
    { searchKeys: [] },
  );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentConsumableKeys.list(params),
    queryFn: () => officeEquipmentConsumablesApi.list(params),
    // Перечень нужен, только пока окно открыто: ради кнопки в шапке вкладки его не запрашивают.
    enabled: open,
  });

  const { data: modelOptions = [], isFetching: modelsLoading } = useQuery({
    ...officeEquipmentModelPickerQuery(),
    enabled: open,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [record, setRecord] = useState<OfficeEquipmentConsumableDto | null>(null);

  /** Расходник, которому правят остаток; `null` — окно остатка закрыто. */
  const [stockOf, setStockOf] = useState<OfficeEquipmentConsumableDto | null>(null);

  /** Отчёт по расходу за период (Р10): состояние, а не адрес — окно и так открыто поверх вкладки. */
  const [usageOpen, setUsageOpen] = useState(false);

  const openCreate = () => {
    setRecord(null);
    setFormOpen(true);
  };
  const openCard = (c: OfficeEquipmentConsumableDto) => {
    setRecord(c);
    setFormOpen(true);
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => officeEquipmentConsumablesApi.remove(id),
    onSuccess: () => {
      message.success('Расходник удалён');
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      // Матрица Р14: перечень расходников стоит в карточке единицы оргтехники (Р15).
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // И у моделей: удаление уносит привязки каскадом, а на них стоят и «удаляема ли модель», и
      // срез «без расходника» — модель, освободившаяся этим удалением, обязана освободиться и там.
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
    },
    // «По расходнику есть движение» — обычный ответ сервера, а не сбой: он и объясняет, почему
    // строку не убрать, и подсказывает, что делать вместо этого.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (c: OfficeEquipmentConsumableDto) =>
    modal.confirm({
      title: `Удалить «${c.name}»?`,
      content:
        'Запись удаляется насовсем вместе с привязками к моделям. Расходник, у которого уже менялся остаток, удалить нельзя — журнал не подчищают; чтобы его перестали предлагать, снимите «Активен».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(c.id),
    });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const grid = {
    canManage,
    canStock,
    onOpen: openCard,
    onStock: setStockOf,
    onDelete: confirmDelete,
  };
  const columns = officeEquipmentConsumableColumns(grid);
  const card = officeEquipmentConsumableCard(grid);

  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Сервер ищет по наименованию и коду сразу: спрашивают и «Pantum», и «Д0000337733», и обе
        // половины карточки обязаны находить одну и ту же строку (Р9).
        placeholder="Наименование или код"
        style={{ width: 260 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все модели"
        style={{ width: 260 }}
        loading={modelsLoading}
        options={modelOptions}
        value={params.modelId}
        onChange={(v: string | undefined) => applyFilter({ modelId: v })}
      />
      {/* Тот срез, ради которого в справочник и заходят перед заказом (Р9). */}
      <Checkbox
        checked={params.stock === 'out_of_stock'}
        onChange={(e) => applyFilter({ stock: e.target.checked ? 'out_of_stock' : undefined })}
      >
        Нет в наличии
      </Checkbox>
      <Checkbox
        checked={params.isActive === 'true'}
        onChange={(e) => applyFilter({ isActive: e.target.checked ? 'true' : undefined })}
      >
        Только активные
      </Checkbox>
    </Space>
  );

  /** Те же отборы описанием — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'modelId',
      label: 'Модель',
      value: params.modelId,
      options: modelOptions,
      loading: modelsLoading,
      placeholder: 'Все модели',
      onChange: (v) => applyFilter({ modelId: v }),
    },
    {
      kind: 'toggle',
      key: 'stock',
      label: 'Нет в наличии',
      value: params.stock === 'out_of_stock',
      onChange: (v) => applyFilter({ stock: v ? 'out_of_stock' : undefined }),
    },
    {
      kind: 'toggle',
      key: 'isActive',
      label: 'Только активные',
      value: params.isActive === 'true',
      onChange: (v) => applyFilter({ isActive: v ? 'true' : undefined }),
    },
  ];

  return (
    <ViewModal
      title="Картриджи и тонеры"
      open={open}
      onClose={onClose}
      width={1000}
      // Окно открывают, чтобы найти одну строку, и в следующий раз — уже другую: пересобрать
      // список дешевле, чем тащить за собой отбор прошлого захода.
      destroyOnHidden
      /*
       * Действий у окна два, и оба живут в футере: круглая кнопка `Fab` стоит у нижней навигации
       * страницы, которой под окном нет вовсе.
       *
       * «Расход за период» — не под правом на номенклатуру (Р10, опрос В18): отчёт собирает те же
       * события, что видны в ленте журнала, и открыт всякому, кому открыт сам перечень. Стоит он в
       * футере, а не в полосе отборов, по той же причине, что и заведение: на телефоне отборы
       * уезжают в шторку `ListToolbar`, и кнопка, положенная к ним, там просто пропала бы.
       */
      footer={
        <Space>
          <Button icon={<BarChartOutlined />} onClick={() => setUsageOpen(true)}>
            Расход за период
          </Button>
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Добавить расходник
            </Button>
          )}
        </Space>
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
            placeholder: 'Наименование или код',
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
      {/* Две подписи одной строкой: обе объясняют колонки, которые иначе прочитают неверно —
          остаток («почему не правится прямо здесь») и счётчик парка («чей это парк»). */}
      <Typography.Text type="secondary" style={{ flex: '0 0 auto', fontSize: 12 }}>
        {STOCK_HINT} {PARK_COUNT_HINT}
      </Typography.Text>

      {/* Прокрутку на телефоне держит эта обёртка: карточки растут по содержимому и без неё
          уехали бы за нижний край окна. На десктопе прокручивается сама таблица. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: isMobile ? 'auto' : undefined }}>
        <DataTable<OfficeEquipmentConsumableDto>
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
      <OfficeEquipmentConsumableFormModal
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        canManage={canManage}
        // Кнопка остатка в карточке зовёт то же самое окно, что и действие строки: два окна на
        // одно действие разошлись бы — одно перечитывало бы карточку после 409, другое нет.
        onEditStock={canStock && record ? () => setStockOf(record) : undefined}
        /*
         * Строка списка снимком, а не свежей записью из ответа: поля формы заполняются один раз,
         * при открытии, и перечень под окном перечитывается сам — от правки остатка, от чужого
         * сохранения, просто по сроку годности. Подставляя каждую новую копию строки, окно
         * стирало бы набранное человеком ровно в тот момент, когда список обновился. Свежесть
         * нужна только показанному, а не вводимому: остаток и ленту журнала карточка перечитывает
         * по идентификатору сама.
         */
        record={record}
      />

      {/* Окно остатка — соседом формы, а не внутри неё: у права `stock` без `manage` карточка
          открывается только на чтение, а остаток правится из строки таблицы. */}
      <OfficeEquipmentStockModal consumable={stockOf} onClose={() => setStockOf(null)} />

      {/* Отчёт — тем же соседством и по той же причине, что и остальные окна списка: antd поднимает
          z-index вложенного окна над родительским по контексту. */}
      <OfficeEquipmentConsumableUsageModal open={usageOpen} onClose={() => setUsageOpen(false)} />
    </ViewModal>
  );
}
