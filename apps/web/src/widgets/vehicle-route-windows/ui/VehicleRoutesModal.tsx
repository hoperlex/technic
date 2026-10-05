import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Input, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { VehicleRouteDto } from '@technic/contracts';
import { useDriverOptions } from '@entities/driver';
import { useAuth } from '@entities/session';
import { useOwnVehicleOptions } from '@entities/vehicle';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { DataTable } from '@shared/ui';
import { ListToolbar } from '@shared/ui';
import { ViewModal } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useIsMobile, useListParams } from '@shared/lib';
import { useRouteModal } from '@features/route-modal';
import { CreateRouteModal } from './CreateRouteModal';
import { routeListView } from './routeListView';

/**
 * Список рейсов — окном поверх той страницы, где о рейсах спросили
 * (план `docs/vehicle-routes-modal-plan.md`; сами рейсы — `docs/vehicle-routes-plan.md`, ADR 0050).
 *
 * Почему окно, а не вкладка, какой список был раньше. Рейс — не раздел портала, а сопровождающая
 * запись: вопрос «чем занята машина» задают, стоя в заявке, в гараже и в журнале путевых листов.
 * Вкладка отвечала на него уходом с экрана — с потерей фильтров той страницы, откуда спросили, и
 * поиском обратной дороги. Список при этом нужен одному человеку — диспетчеру, собирающему день, —
 * и ради него раздел держал вкладку, мимо которой ходили все остальные.
 *
 * Отвечает окно на вопрос дня диспетчера: чем занята машина, кто за рулём и выписан ли бланк.
 * Заявки попадают сюда переводом в работу, но собирают рейс здесь: порядок заявок, водитель и
 * реквизиты выезда — свойства рейса, а не заявки.
 *
 * Открывается день сегодняшний: рейс планируют накануне и правят утром, а история рейсов читается
 * журналом путевых листов. Просьба показать другой день приходит извне — `focusDate`/`focusToken`.
 *
 * Чего в окне нет. Адреса оно не знает вовсе: `?routes=1`, `?route=…` и `?request=…` разбирает
 * провайдер окон (`routeModal.tsx`), он же держит карточку рейса и окно правки — список их только
 * просит открыться (`openRoute`, `editRoute`). Собственное действие у него одно — завести рейс.
 */

const DATE = 'YYYY-MM-DD';

/** Состояние документа — им диспетчер закрывает день: «что ещё без листа». */
const WAYBILL_FILTERS = [
  { value: 'none', label: 'Без листа' },
  { value: 'issued', label: 'Лист выписан' },
] as const;
type WaybillFilter = (typeof WAYBILL_FILTERS)[number]['value'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** День, на который встаёт период списка; 'YYYY-MM-DD'. */
  focusDate?: string;
  /** Счётчик просьб сфокусироваться: растёт на каждый вызов openRoutesList. */
  focusToken: number;
  /** Списки портала устарели после правки рейса — инвалидацию делает провайдер. */
  onChanged: () => void;
}

export function VehicleRoutesModal({ open, onClose, focusDate, focusToken, onChanged }: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const { can } = useAuth();
  /** Карточка рейса и карточка заявки — окна провайдера: список только просит их открыть. */
  const { openRoute, openRequest, editRoute } = useRouteModal();
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs(), dayjs()]);
  const [creating, setCreating] = useState(false);

  /**
   * Просьба показать конкретный день (`openRoutesList({ focusDate })`): её шлют карточка рейса
   * кнопкой «Все маршруты» и правка рейса — новым днём, на который его переставили. Иначе список
   * открывался бы сегодняшним числом, а рейс, ради которого его открыли, лежал бы в позавчера — и
   * человек решал бы, что рейс пропал.
   *
   * Зависимость — счётчик, а не сама дата, и это главное в эффекте. Повторная просьба про тот же
   * день обязана вернуть период на место, если его руками увели в другой месяц; по значению даты
   * второй такой эффект не сработал бы вовсе — дата ведь не изменилась.
   */
  useEffect(() => {
    if (!focusDate) return;
    const day = dayjs(focusDate);
    setRange([day, day]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  /**
   * Фильтры живут полосой над таблицей, а не выпадашками столбцов: в заголовке их не видно, а
   * часть значений — списки справочников (техника, водители), которым в выпадашке столбца места
   * нет. Тем же порядком собраны «Заявки ТС» и «Пользователи» — списки портала фильтруются
   * одинаково.
   */
  const { params, setParams, setSort, onTableChange } = useListParams<{
    vehicleId?: string;
    driverPersonId?: string;
    waybill?: WaybillFilter;
  }>({}, { searchKeys: [] });

  /** Смена любого фильтра возвращает список на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = {
    ...params,
    dateFrom: range[0].format(DATE),
    dateTo: range[1].format(DATE),
  };
  const { data, isFetching } = useQuery({
    queryKey: vehicleRouteKeys.list(query),
    queryFn: () => vehicleRoutesApi.list(query),
  });

  const { options: vehicleOptions, loading: vehiclesLoading } = useOwnVehicleOptions();
  const { options: driverOptions, loading: driversLoading } = useDriverOptions();

  const { columns, card } = routeListView({ can, openRequest, openRoute, editRoute });

  /** Полоса фильтров над таблицей: поиск, техника, водитель, состояние листа и период рейсов. */
  const filters = (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Ищет сервер сразу по трём приметам рейса: номер («Р-12»), госномер машины и фамилия
        // водителя — рейс запоминают то одним, то другим.
        placeholder="Р-12, госномер или водитель"
        style={{ width: 240 }}
        defaultValue={params.search}
        onSearch={(v) => applyFilter({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Вся техника"
        style={{ width: 220 }}
        options={vehicleOptions}
        loading={vehiclesLoading}
        value={params.vehicleId}
        onChange={(v: string | undefined) => applyFilter({ vehicleId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все водители"
        style={{ width: 220 }}
        options={driverOptions}
        loading={driversLoading}
        value={params.driverPersonId}
        onChange={(v: string | undefined) => applyFilter({ driverPersonId: v })}
      />
      <Select
        allowClear
        placeholder="Лист: любой"
        style={{ width: 170 }}
        options={[...WAYBILL_FILTERS]}
        value={params.waybill}
        onChange={(v: WaybillFilter | undefined) => applyFilter({ waybill: v })}
      />
      {/* Период рейсов остаётся обязательным: маршруты читают по дням, и «вся история сразу» —
        не тот вопрос, который здесь задают. Поэтому без крестика. */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        value={range}
        allowClear={false}
        inputReadOnly={isMobile}
        onChange={(v) => {
          if (!v) return;
          setRange(v as [dayjs.Dayjs, dayjs.Dayjs]);
          applyFilter({});
        }}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'vehicleId',
      label: 'Техника',
      value: params.vehicleId,
      options: vehicleOptions,
      placeholder: 'Вся техника',
      loading: vehiclesLoading,
      onChange: (v) => applyFilter({ vehicleId: v }),
    },
    {
      kind: 'select',
      key: 'driverPersonId',
      label: 'Водитель',
      value: params.driverPersonId,
      options: driverOptions,
      placeholder: 'Все водители',
      loading: driversLoading,
      onChange: (v) => applyFilter({ driverPersonId: v }),
    },
    {
      kind: 'select',
      key: 'waybill',
      label: 'Путевой лист',
      value: params.waybill,
      options: [...WAYBILL_FILTERS],
      placeholder: 'Лист: любой',
      onChange: (v) => applyFilter({ waybill: v as WaybillFilter | undefined }),
    },
    {
      kind: 'dateRange',
      key: 'range',
      label: 'Период рейсов',
      from: range[0].format(DATE),
      to: range[1].format(DATE),
      isActive: false,
      onChange: (from, to) => {
        setRange([from ? dayjs(from) : dayjs(), to ? dayjs(to) : dayjs()]);
        applyFilter({});
      },
    },
  ];

  return (
    <ViewModal
      title="Маршруты"
      open={open}
      onClose={onClose}
      width={1080}
      // Список переоткрывают на другом дне и из другого места портала: пересобрать его дешевле,
      // чем тащить за собой фильтры прошлого захода.
      destroyOnHidden
      // Создание — единственное собственное действие списка, и на телефоне ему место в футере
      // окна, а не круглой кнопкой: `Fab` живёт у нижней навигации страницы, которой под окном
      // нет вовсе. Одна кнопка работает в обоих видах — окном на десктопе и шитом на телефоне.
      footer={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          Новый маршрут
        </Button>
      }
      // Тело обязано иметь высоту: `DataTable` меряет свой контейнер (`useElementSize`) и считает
      // по нему `scroll.y`, а в теле, растущем по содержимому, он намерил бы ноль и схлопнулся.
      // На телефоне окно и так во весь экран — там высота своя, а не доля от неё.
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '70vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      {/* Полосу фильтров десктопа и панель телефона рисуем сами: `PageTableLayout` остался
          страницам, а в окне у списка своя оболочка. Шесть выпадашек фиксированной ширины на
          360 px заняли бы экран целиком (ADR 0030), поэтому на телефоне — `ListToolbar` с шитами.
          Главного действия ему не передаём: «Новый маршрут» стоит в футере окна. */}
      {isMobile ? (
        <ListToolbar
          search={{
            value: params.search,
            placeholder: 'Р-12, госномер или водитель',
            onChange: (v) => applyFilter({ search: v }),
          }}
          filters={mobileFilters}
          sort={{
            options: sortOptionsFrom(columns, { num: 'Маршрут' }),
            sortBy: params.sortBy,
            sortOrder: params.sortOrder,
            onChange: setSort,
          }}
        />
      ) : (
        <div style={{ flex: '0 0 auto' }}>{filters}</div>
      )}

      {/* Прокрутку на телефоне держит эта обёртка: карточки списка растут по содержимому, и без
          неё они уехали бы за нижний край окна. На десктопе прокручивается сама таблица. */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: isMobile ? 'auto' : undefined,
        }}
      >
        <DataTable<VehicleRouteDto>
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

      {/* Окно создания стоит внутри окна списка намеренно: antd поднимает z-index вложенных
          окон над родительским по контексту, а соседнее — на телефоне оказалось бы под шторкой
          списка. В адресе оно не отражается: это шаг внутри списка, а не место портала. */}
      <CreateRouteModal
        open={creating}
        onCancel={() => setCreating(false)}
        onCreated={(route) => {
          setCreating(false);
          onChanged();
          message.success('Маршрут заведён');
          // Период встаёт на день заведённого рейса: рейс заводят и на завтра, и на послезавтра, а
          // список остался бы на сегодняшнем дне — и, закрыв карточку, человек не нашёл бы в нём
          // только что созданного рейса.
          const day = dayjs(route.routeDate);
          setRange([day, day]);
          openRoute(route.id);
        }}
      />
    </ViewModal>
  );
}
