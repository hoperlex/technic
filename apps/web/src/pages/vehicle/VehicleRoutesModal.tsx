import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  isRouteEditable,
  minRequestDateKey,
  moscowDateKeyOf,
  ROUTE_FROZEN_MESSAGE,
  routeRequestCapacity,
  routePurposeShortLabels,
  type VehicleRouteDto,
  vehicleLabel,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi, vehiclesApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { DataTable, type CardConfig } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { ListToolbar } from '@shared/ui';
import { ViewModal } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useListParams } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { vehicleRequestViewLink, waybillLink } from '../../utils/links';
import { useAuth } from '../../auth/AuthContext';
import { useRouteModal } from './routeModal';
import { formatDateOnly, useDriverOptions, useOwnVehicleOptions } from './shared';

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

interface CreateValues {
  vehicleId?: string;
  routeDate?: dayjs.Dayjs;
  driverPersonId?: string;
  /** Причина заведения задним числом (ADR 0101, дыра 1): спрашивается только на прошедшем дне. */
  reason?: string;
}

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
    queryKey: ['vehicle-routes', query],
    queryFn: () => vehicleRoutesApi.list(query),
  });

  const { options: vehicleOptions, loading: vehiclesLoading } = useOwnVehicleOptions();
  const { options: driverOptions, loading: driversLoading } = useDriverOptions();

  const columns = [
    textColumn<VehicleRouteDto>({
      key: 'num',
      title: 'Маршрут',
      dataIndex: 'displayNumber',
      width: 140,
      // Поиск ушёл в панель над таблицей: он один на номер рейса, госномер и фамилию водителя, и
      // лупа в заголовке одного столбца обещала бы поиск только по нему.
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <span>{r.displayNumber}</span>
            {/* Перегон техники стоит в том же списке, что и грузовые рейсы: это тот же рейс той
              же машины на тот же день, и искать его в отдельном окне было бы негде. Отличает
              его пометка — и другое содержимое колонки «Заявки». */}
            {isRelocationPurpose(r.purpose) && (
              <Tag color={r.purpose === 'delivery' ? 'blue' : 'gold'}>
                {routePurposeShortLabels[r.purpose]}
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateOnly(r.routeDate)}
          </Typography.Text>
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.vehicleLabel}</span>
          {r.withTrailer && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              с прицепом {r.trailerLabel}
            </Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<VehicleRouteDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      searchable: false,
      width: 220,
      // Пустой водитель — не поломка, а состояние: рейс собрали заранее, человека ставят утром.
      // Но лист без него не выписать, и молчать об этом нельзя.
      render: (_v, r) => r.driverName || <Tag color="orange">не назначен</Tag>,
    }),
    textColumn<VehicleRouteDto>({
      key: 'requests',
      title: 'Заявки',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 280,
      render: (_v, r) => {
        // Заявка перегона достаётся из строки заранее: внутри `onActivate` сужение типа уже не
        // живёт — обработчик зовут потом, и TS о непустоте поля больше ничего не знает.
        const source = r.sourceRequest;
        // У перегона состава нет: он едет по одной заявке, а «откуда — куда» и есть его задание.
        return isRelocationPurpose(r.purpose) ? (
          <Space direction="vertical" size={0}>
            <span>
              {source ? (
                <EntityLink
                  to={vehicleRequestViewLink(can, source.requestId)}
                  title="Открыть заявку"
                  onActivate={() => openRequest(source.requestId)}
                >
                  {source.displayNumber}
                </EntityLink>
              ) : (
                '—'
              )}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.moveFrom} → {r.moveTo}
            </Typography.Text>
          </Space>
        ) : r.requests.length === 0 ? (
          <Typography.Text type="secondary">рейс пуст</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {/* Номер заявки открывает её карточку окном поверх списка: состав рейса читают
                вопросом «а что там за заявка», и до сих пор на него отвечали переключением вкладки
                и поиском номера. Ссылка при этом остаётся настоящей — её открывают Ctrl'ом
                соседней вкладкой, — а без права на заявки `vehicleRequestViewLink` вернёт `null`,
                и номер останется текстом (см. `EntityLink`). */}
            {r.requests.map((item) => (
              <span key={item.requestId}>
                {item.position}.{' '}
                <EntityLink
                  to={vehicleRequestViewLink(can, item.requestId)}
                  title="Открыть заявку"
                  onActivate={() => openRequest(item.requestId)}
                >
                  {item.displayNumber}
                </EntityLink>{' '}
                — {item.customerName}
              </span>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.requests.length} из {routeRequestCapacity(r.formCode)} заявок
            </Typography.Text>
          </Space>
        );
      },
    }),
    textColumn<VehicleRouteDto>({
      key: 'waybill',
      title: 'Путевой лист',
      dataIndex: 'waybill',
      sortable: false,
      searchable: false,
      width: 240,
      render: (_v, r) =>
        r.waybill ? (
          <Space direction="vertical" size={0}>
            {/* Номер ведёт в журнал учёта с этим же номером в поиске: карточки у листа нет —
                строка журнала и отвечает, что с бланком стало и чем он подшит (ADR 0037). */}
            <span>
              <EntityLink to={waybillLink(can, r.waybill.number)} title="Открыть в журнале листов">
                {r.waybill.number}
              </EntityLink>
            </span>
            <Tag color={waybillStatusColors[r.waybill.status]}>
              {waybillStatusLabels[r.waybill.status]}
            </Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">не выписан</Typography.Text>
        ),
    }),
    actionsColumn<VehicleRouteDto>(
      // Состав рейса и выписка листа — в карточке; отсюда рейс открывают и правят его реквизиты:
      // «переставить день» и «сменить водителя» это утренние действия, ради которых открывать
      // карточку незачем. Оба окна держит провайдер: карточку — потому что её зовут из гаража и
      // журнала листов, где списка нет вовсе, правку — потому что она обязана умереть вместе с
      // тем окном, из которого её позвали.
      (r) => {
        const frozen = !isRouteEditable(r.waybill?.status ?? null);
        return (
          <Space>
            <RowActionButton
              title="Открыть маршрут"
              icon={<EyeOutlined />}
              onClick={() => openRoute(r.id)}
            />
            {/* Выключенная кнопка объясняется обёрткой: подсказку antd на ней не показывает. */}
            <span title={frozen ? ROUTE_FROZEN_MESSAGE : undefined}>
              <RowActionButton
                title="Редактировать маршрут"
                icon={<EditOutlined />}
                disabled={frozen}
                onClick={() => editRoute(r)}
              />
            </span>
          </Space>
        );
      },
      110,
    ),
  ];

  // Карточка телефона (ADR 0030): номер рейса и дата в шапке, машина и водитель — строками;
  // касание открывает тот же рейс, что и кнопка «Открыть» на десктопе.
  const card: CardConfig<VehicleRouteDto> = {
    title: (r) => `${r.displayNumber} · ${formatDateOnly(r.routeDate)}`,
    badge: (r) =>
      r.waybill ? (
        <Tag color={waybillStatusColors[r.waybill.status]}>
          {waybillStatusLabels[r.waybill.status]}
        </Tag>
      ) : (
        <Tag>без листа</Tag>
      ),
    primary: (r) => r.vehicleLabel,
    lines: [
      (r) => r.driverName || 'водитель не назначен',
      (r) =>
        r.requests.length === 0
          ? 'рейс пуст'
          : `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок: ${r.requests
              .map((item) => item.displayNumber)
              .join(', ')}`,
    ],
    onOpen: (r) => openRoute(r.id),
  };

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

/**
 * Новый рейс: машина, дата и — если уже известно — водитель. Реквизиты выезда сюда не вынесены:
 * их наследует сам сервер от прошлого рейса этой машины, а правят их в карточке.
 *
 * Прошедший день (ADR 0101 п. 4, дыра 1 плана) до сих пор заводился здесь молча — ни права, ни
 * причины, ни следа. Теперь календарь заперт тем же правилом, что и у форм заявок, — три режима
 * (`minRequestDateKey`, Р37): без права коррекции прошлого нет вовсе, с `waybills.correct` открыты
 * тридцать дней, с `waybills.correctBeyondLimit` границы нет. Причина спрашивается ровно тогда,
 * когда выбранный день уже прошёл: сервер потребует её тем же условием.
 */
function CreateRouteModal({
  open,
  onCancel,
  onCreated,
}: {
  open: boolean;
  onCancel: () => void;
  /** Отдаём заведённый рейс целиком: список ставит период на его день и открывает карточку. */
  onCreated: (route: VehicleRouteDto) => void;
}) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const [form] = Form.useForm<CreateValues>();
  const vehicleId = Form.useWatch('vehicleId', form);
  const routeDate = Form.useWatch('routeDate', form);

  const today = moscowDateKeyOf(new Date());
  /** Нижняя граница календаря; `null` — границы нет вовсе (`waybills.correctBeyondLimit`). */
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  /** Выбран прошедший день: причина обязательна и здесь, и на сервере. */
  const backdated = !!routeDate && routeDate.format(DATE) < today;

  // Рейс ведётся только на собственной технике: у арендной лист выписывает арендодатель.
  const { data: vehicles, isFetching } = useQuery({
    queryKey: ['vehicles', 'for-routes'],
    queryFn: () => vehiclesApi.list({ ownership: 'own', status: 'active', page: 1, pageSize: 500 }),
    enabled: open,
  });

  // Водитель — весь справочник (ADR 0064): категория и полнота документов никого не убирают, они
  // помечают строку. Чем это грозит бланку, скажет карточка рейса — там, где лист выписывают.
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, routeDate?.format(DATE)],
    queryFn: () =>
      driversApi.available({
        vehicleId: vehicleId!,
        on: routeDate!.format(DATE),
        withTrailer: false,
      }),
    enabled: open && !!vehicleId && !!routeDate,
  });

  const create = useMutation({
    mutationFn: (v: CreateValues) =>
      vehicleRoutesApi.create({
        vehicleId: v.vehicleId!,
        routeDate: v.routeDate!.format(DATE),
        driverPersonId: v.driverPersonId ?? null,
        // Причина уходит только с прошедшим днём: на сегодняшнем рейсе сервер её не спрашивает, и
        // отправленная «на всякий случай» она означала бы коррекцию там, где её нет.
        ...(v.routeDate!.format(DATE) < today ? { reason: v.reason } : {}),
      }),
    onSuccess: (route) => {
      form.resetFields();
      onCreated(route);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title="Новый маршрут"
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={create.isPending}
      okText="Завести"
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
        <FormGrid>
          <Form.Item
            name="vehicleId"
            label="Техника"
            rules={[{ required: true, message: 'Выберите технику' }]}
          >
            <AutoSelect
              options={(vehicles?.items ?? []).map((v) => ({
                value: v.id,
                label: vehicleLabel(v),
              }))}
              showSearch
              optionFilterProp="label"
              loading={isFetching}
              placeholder="Выберите машину"
            />
          </Form.Item>
          {/* Дата спрашивается пустым полем: рейс заводят и на завтра, и на послезавтра, а
            подставленное «сегодня» проскакивают не глядя — и рейс оказывается не в том дне, где
            его потом ищут. */}
          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            extra={
              backdateFloor === null || backdateFloor < today
                ? 'Прошедший день заводится с причиной: рейс уйдёт в журнал коррекций'
                : undefined
            }
          >
            <DatePicker
              format="DD.MM.YYYY"
              style={{ width: '100%' }}
              inputReadOnly={isMobile}
              // Правило одно с сервером (`backdateGuard`): портал не предлагает того, что ручка
              // отклонит, и не запирает того, что она примет.
              disabledDate={(d) => backdateFloor !== null && d.format(DATE) < backdateFloor}
            />
          </Form.Item>
          {/* Причина появляется вместе с прошедшим днём — там же, где выбрали дату: она уходит в
            запись аудита и объясняет через месяцы, почему рейс заведён вчерашним числом. */}
          {backdated && (
            <FormGrid.Full>
              <Form.Item
                name="reason"
                label="Причина заднего числа"
                rules={[{ required: true, message: 'Укажите причину' }]}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Например: рейс состоялся во вторник, в портал вносим сегодня"
                />
              </Form.Item>
            </FormGrid.Full>
          )}
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Водитель"
              extra="Необязательно: рейс собирают заранее, а человека ставят утром. Без водителя лист не выписать."
            >
              {/* Порядок задал сервер: пригодные первыми — комплект документов, затем категория
                (ADR 0064, ADR 0055), внутри них работавшие на этой машине (ADR 0056). Пометки в
                строке объясняют почему — но выбирает человек: сам собой водитель в поле не
                встаёт даже тогда, когда пригоден он один. */}
              <AutoSelect
                autoSelectSole={false}
                options={(selection?.drivers ?? []).map((d) => ({
                  value: d.personId,
                  label: [
                    d.fullName,
                    d.categories.join(', '),
                    driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
                    d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
                    driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                showSearch
                allowClear
                optionFilterProp="label"
                loading={driversLoading}
                disabled={!vehicleId || !routeDate}
                placeholder={vehicleId ? 'Выберите водителя' : 'Сначала выберите машину'}
              />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
