import { useState } from 'react';
import { App, Button, Checkbox, Input, Select, Space, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutoPartDto } from '@technic/contracts';
import { autoPartApi, autoPartKeys } from '@entities/auto-part';
import {
  DataTable,
  PageTableLayout,
  sortOptionsFrom,
  type FilterDefinition,
} from '@shared/ui';
import { errorMessage, useListParams } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { AutoPartCardModal } from './AutoPartCardModal';
import { AutoPartFormModal } from './AutoPartFormModal';
import {
  modelValue,
  typeValue,
  useApplicabilityOptions,
} from './autoPartApplicability';
import { autoPartCard, autoPartColumns, STOCK_HINT } from './autoPartColumns';
import { useAutoPartAddress } from './autoPartsAddress';

/**
 * Гараж → «Автозапчасти»: склад механиков — что лежит, сколько и к чему подходит (план
 * `docs/auto-parts-plan.md`, Р13, Р14, §8; концепт «Автозапчасти в гараже»).
 *
 * **Дня среза у вкладки нет.** Соседние вкладки отвечают про сутки («чем занята машина 24 июля»),
 * а склад — про сейчас: остаток это текущее число, а не состояние на дату. Поэтому органы
 * управления днём сюда не едут (Р14), и ключ `?date=` вкладка не читает вовсе — страница гаража
 * хранит его сама, чтобы возврат на «Технику» показал тот же день.
 *
 * **Отбор, порядок и страницы считает сервер** (Р13): поиск идёт сразу по наименованию и коду,
 * фильтры — наличие, применимость и активность. Досортировать пришедшую страницу на клиенте
 * нечем: в справочнике полторы тысячи строк, и «что заказывать» читается снизу, с нулей.
 *
 * **Действия разведены двумя правами** (Р10). Ведение справочника — `autoParts.manage`
 * («Добавить», «Изменить», «Удалить»), движение склада — `autoParts.stock` («Изменить остаток»).
 * Менеджер и диспетчер вкладку видят целиком, но не имеют ни того, ни другого: склад ведут
 * механики, и читателю кнопки не показываются вовсе — обещать действие, кончающееся 403, нельзя.
 */

/** Что вкладка спрашивает сверх базовых параметров списка (Р13). */
interface AutoPartParams {
  stock?: 'in_stock' | 'out_of_stock';
  isActive?: 'true' | 'false';
  vehicleModelId?: string;
  vehicleTypeId?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Размер страницы у счётного запроса. Единицей его не спросить: сервер принимает только
 * `PAGE_SIZES` (50, 100, 200, 500), и 50 здесь — наименьшее из возможного. Считаем мы `total`, а
 * строки в ответе не смотрим вовсе.
 */
const COUNT_PAGE_SIZE = 50;

/** Русское склонение счётного слова: 1 позиция, 2 позиции, 5 позиций. */
function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

export function AutoPartsTab() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();

  /*
   * Права раздельные (Р10) и спрашиваются независимо: завести позицию номенклатуры и пересчитать
   * полку — разные работы, и делают их не обязательно одни и те же руки. Чтение не спрашивается
   * вовсе: сюда приходят с вкладки, которая уже открыта по `garage.read`.
   */
  const canManage = can('autoParts.manage');
  const canStock = can('autoParts.stock');

  const { params, setParams, setSort, onTableChange } = useListParams<AutoPartParams>(
    // Алфавит просится явно: умолчание списочной схемы — «последняя заведённая сверху»
    // (`sortOrder: 'desc'`), и справочник открывался бы задом наперёд.
    { sortBy: 'name', sortOrder: 'asc' },
    // Поиск живёт в панели над таблицей, а не лупой в заголовке: сервер ищет сразу по двум полям —
    // наименованию и коду, — и лупа у одного столбца обещала бы поиск только по нему.
    { searchKeys: [] },
  );

  const { data, isFetching } = useQuery({
    queryKey: autoPartKeys.list(params),
    queryFn: () => autoPartApi.list(params),
  });

  /**
   * Счётчик «Нет в наличии» (§8, концепт с. 1): тот же отбор, но с наличием, выкрученным в ноль.
   *
   * Своей ручки под счётчики нет, и заводить её ради двух чисел не за что: ответ считает сам
   * список — `total` при `stock=out_of_stock`. Когда этот отбор уже включён, второй запрос не
   * уходит вовсе: число уже пришло первым.
   */
  const zeroFilterOn = params.stock === 'out_of_stock';
  const { data: zeroData } = useQuery({
    queryKey: autoPartKeys.list({
      ...params,
      stock: 'out_of_stock',
      page: 1,
      pageSize: COUNT_PAGE_SIZE,
    }),
    queryFn: () =>
      autoPartApi.list({ ...params, stock: 'out_of_stock', page: 1, pageSize: COUNT_PAGE_SIZE }),
    enabled: !zeroFilterOn,
  });
  const total = data?.total ?? 0;
  const zeroTotal = zeroFilterOn ? total : (zeroData?.total ?? 0);

  const { options, loading: optionsLoading } = useApplicabilityOptions();

  /** Заведение новой позиции; правку открывает карточка — там же, где виден журнал. */
  const [createOpen, setCreateOpen] = useState(false);

  /*
   * Открытая карточка названа в адресе (`?part=<id>`, Р14). Активная вкладка спрашивается не ради
   * права — склад читают все, кому виден гараж (Р10), — а ради единственности окна: скрытые
   * вкладки остаются смонтированными, а окно рисуется порталом в тело документа.
   */
  const address = useAutoPartAddress(useActiveTabKey() === 'parts');

  const removeMut = useMutation({
    mutationFn: (id: string) => autoPartApi.remove(id),
    onSuccess: () => {
      message.success('Автозапчасть удалена');
      // Матрица Р16, первая строка: удаление меняет и список, и карточку — обе под корнем склада.
      void qc.invalidateQueries({ queryKey: autoPartKeys.root });
    },
    // «По позиции есть движение» — обычный ответ сервера, а не сбой: он объясняет, почему строку
    // не убрать, и подсказывает, что делать вместо этого.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (part: AutoPartDto) =>
    modal.confirm({
      title: `Удалить «${part.name}»?`,
      content:
        'Запись удаляется насовсем вместе с применимостью. Позицию, по которой уже было движение остатка, удалить нельзя — журнал не подчищают; чтобы её перестали предлагать в акте, снимите «Активна».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(part.id),
    });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  /** Применимость — одно поле на две ссылки (Р8): значение несёт вид ссылки в самом себе. */
  const applicabilityValueOf = params.vehicleModelId
    ? modelValue(params.vehicleModelId)
    : params.vehicleTypeId
      ? typeValue(params.vehicleTypeId)
      : undefined;
  const applyApplicability = (value: string | undefined) =>
    applyFilter({
      vehicleModelId: value?.startsWith('m:') ? value.slice(2) : undefined,
      vehicleTypeId: value?.startsWith('t:') ? value.slice(2) : undefined,
    });

  const grid = { canManage, onOpen: (p: AutoPartDto) => address.open(p.id), onDelete: confirmDelete };
  const columns = autoPartColumns(grid);
  const card = autoPartCard(grid);

  const stockOptions = [
    { value: 'in_stock', label: 'Есть в наличии' },
    { value: 'out_of_stock', label: 'Нет в наличии' },
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Сервер ищет по наименованию и коду сразу: спрашивают и «фильтр масляный», и артикул, и
        // обе половины карточки обязаны находить одну строку (Р13).
        placeholder="Наименование или код"
        style={{ width: 260 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        placeholder="Наличие: все"
        style={{ width: 180 }}
        options={stockOptions}
        value={params.stock}
        onChange={(v: AutoPartParams['stock']) => applyFilter({ stock: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Применимость"
        style={{ width: 280 }}
        loading={optionsLoading}
        options={options}
        value={applicabilityValueOf}
        onChange={applyApplicability}
      />
      <Checkbox
        checked={params.isActive === 'true'}
        onChange={(e) => applyFilter({ isActive: e.target.checked ? 'true' : undefined })}
      >
        Только активные
      </Checkbox>
    </Space>
  );

  /** Те же отборы описанием — для шита на телефоне (ADR 0030, ADR 0042). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'stock',
      label: 'Наличие',
      value: params.stock,
      options: stockOptions,
      placeholder: 'Все',
      onChange: (v) => applyFilter({ stock: v as AutoPartParams['stock'] }),
    },
    {
      kind: 'select',
      key: 'applicability',
      label: 'Применимость',
      value: applicabilityValueOf,
      options,
      loading: optionsLoading,
      placeholder: 'Любая',
      onChange: applyApplicability,
    },
    {
      kind: 'toggle',
      key: 'isActive',
      label: 'Только активные',
      value: params.isActive === 'true',
      onChange: (v) => applyFilter({ isActive: v ? 'true' : undefined }),
    },
  ];

  /**
   * Счётчики над таблицей (концепт с. 1). Красный — не украшение и не сводка: это тот самый срез
   * «что заказывать», и он же кнопка, которая его включает. Ноль в нём — хорошая новость, и
   * нажимать там не на что, поэтому фильтром он становится, только когда позиции есть.
   */
  const counters = (
    <Space size={12} wrap>
      <Typography.Text type="secondary">
        Всего {total} {plural(total, 'позиция', 'позиции', 'позиций')}
      </Typography.Text>
      <Tag
        color={zeroTotal > 0 ? 'red' : 'default'}
        style={{ cursor: zeroTotal > 0 ? 'pointer' : 'default', marginInlineEnd: 0 }}
        onClick={
          zeroTotal > 0
            ? () => applyFilter({ stock: zeroFilterOn ? undefined : 'out_of_stock' })
            : undefined
        }
      >
        Нет в наличии: {zeroTotal}
        {zeroFilterOn ? ' — показаны только они' : ''}
      </Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {STOCK_HINT}
      </Typography.Text>
    </Space>
  );

  return (
    <PageTableLayout
      filters={filters}
      toolbar={counters}
      extra={
        canManage ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Добавить
          </Button>
        ) : null
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Наименование или код',
          onChange: (v) => applyFilter({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        // Заведение — главное действие вкладки, и на телефоне ему место круглой кнопкой у нижней
        // навигации: полоса фильтров десктопа там занимает весь экран.
        primaryAction: canManage
          ? { label: 'Добавить', icon: <PlusOutlined />, onClick: () => setCreateOpen(true) }
          : undefined,
      }}
    >
      <DataTable<AutoPartDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={total}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        // Нажатие по строке открывает карточку — там реквизиты, остаток и журнал (концепт с. 2).
        onRowClick={(r) => address.open(r.id)}
        onChange={onTableChange}
      />

      <AutoPartCardModal
        partId={address.id}
        onClose={address.close}
        canManage={canManage}
        canStock={canStock}
        options={options}
        optionsLoading={optionsLoading}
      />

      {/* Заведение — рядом со списком, а не в карточке: карточки у новой позиции ещё нет. */}
      <AutoPartFormModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        canStock={canStock}
        options={options}
        optionsLoading={optionsLoading}
      />
    </PageTableLayout>
  );
}
