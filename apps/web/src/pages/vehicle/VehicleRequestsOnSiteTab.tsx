import { useState } from 'react';
import { Button, Input, Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  PlusOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentTitle,
  canRequestEarlyEnd,
  onSiteDayLabel,
  onSitePresence,
  shiftDaysOf,
  parseVehicleRequestNumberSearch,
  type SpecialEquipmentRequestDto,
  vehicleClassificationLabel,
  vehicleOnSitePresenceColors,
  vehicleOnSitePresenceLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { TabsExtra } from '../../components/PageTabs';
import { SummaryBar } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { UserAvatar } from '../../components/UserAvatar';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { useListParams } from '@shared/lib';
import { calendarDayCount } from '../../utils/date';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleShiftsModal } from './VehicleShiftsModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import {
  EarlyEndTag,
  formatDateOnly,
  useEarlyEnd,
  useObjectOptions,
  useVehicleClassificationFilter,
} from './shared';
import { useAuth } from '../../auth/AuthContext';
import { useObjectScope } from '../../hooks/useObjectScope';
import { useWeeklyRequestCreate } from './weeklyShared';

/**
 * Техника, которая работает на объектах прямо сейчас (ADR 0036). Первая вкладка отвечает на «что
 * заказали и что с этим делают», эта — на один вопрос сегодняшнего дня: что и где стоит.
 *
 * Отбор целиком ведёт сервер: заказ спецтехники в статусе «В работе», чей срок накрывает
 * сегодняшний день по Москве. Поэтому здесь нет ни фильтра статуса, ни фильтра дат — они этот
 * список определяют, а не сужают, — и нет действий: срез только на чтение. Статусы ведут в списке
 * заявок, факт выполнения предъявляют её закрытием (ADR 0029).
 */

/** Строка «Сегодня»: чем этот день является для заявки и который он по счёту в её сроке. */
function presenceCell(r: SpecialEquipmentRequestDto, onDate: string) {
  const presence = onSitePresence(r, onDate);
  const dayLabel = onSiteDayLabel(r, onDate);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <Tag color={vehicleOnSitePresenceColors[presence]} style={{ marginInlineEnd: 0 }}>
        {vehicleOnSitePresenceLabels[presence]}
      </Tag>
      {dayLabel && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayLabel}
          </Typography.Text>
        </div>
      )}
      {/* Запрошенный досрочный отъезд (ADR 0044) — здесь же: до визы срок заявки прежний, и
        без тега площадка узнала бы об отъезде техники в день отъезда. */}
      {r.earlyEnd?.status === 'pending' && (
        <div style={{ marginTop: 2 }}>
          <EarlyEndTag earlyEnd={r.earlyEnd} />
        </div>
      )}
    </div>
  );
}

/**
 * Срок работ: период заказа и сколько дней заказано — тем же счётом, что в форме и карточке.
 * Согласованное сокращение (ADR 0044) уже сидит в самом сроке, поэтому рядом стоит приписка «с
 * какого числа сократили»: без неё непонятно, почему заказ на две недели кончается послезавтра.
 */
function termCell(r: SpecialEquipmentRequestDto) {
  const days = calendarDayCount(r.dateFrom, r.dateTo);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        {r.dateTo
          ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
          : formatDateOnly(r.dateFrom)}
      </div>
      {days != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          заказано {days} дн.
        </Typography.Text>
      )}
      {r.earlyEnd?.status === 'approved' && (
        <div>
          <EarlyEndTag earlyEnd={r.earlyEnd} />
        </div>
      )}
    </div>
  );
}

/**
 * Приёмка работы по дням: сколько смен объект подтвердил из заказанных и сколько наступивших
 * дней ещё ждёт подписи. Долг выделен красным — пока он есть, машину у заявки не сменить, а её
 * закрытие предупреждает, что работу принимают без подписи площадки.
 */
function shiftsCell(r: SpecialEquipmentRequestDto) {
  const total = shiftDaysOf(r).length;
  const pending = r.shifts.unapprovedPastDays;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        согласовано {r.shifts.approvedDays} из {total}
      </div>
      {pending > 0 && (
        <Tag color="red" style={{ marginInlineEnd: 0 }}>
          не согласовано дней: {pending}
        </Tag>
      )}
    </div>
  );
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export function VehicleRequestsOnSiteTab() {
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  // С одним объектом фильтр зафиксирован на нём — как и в списке заявок; с несколькими выбор
  // сужен до своих (ADR 0039). Сервер всё равно отдаёт только свои (requestVisibilityWhere).
  const ownObjectId = soleObjectId ?? '';

  const { params, setParams, setSort, onTableChange } = useListParams<{
    objectId?: string;
    /** Заказанная техника (ADR 0028): тип целиком либо одна его категория. */
    vehicleTypeId?: string;
    vehicleCategoryId?: string;
    num?: number;
    /**
     * Порядок задан явно, а не оставлен на сервер: срез читают площадкой, и по объекту он идёт
     * по возрастанию. Иначе первый запрос ушёл бы с общим для списков «по убыванию», и шит
     * сортировки на телефоне показывал бы пустое поле там, где порядок уже выбран.
     */
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>(
    { objectId: ownObjectId || undefined, sortBy: 'objectName', sortOrder: 'asc' },
    { searchKeys: ['objectName'] },
  );

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    vehicleTypeId: params.vehicleTypeId,
    vehicleCategoryId: params.vehicleCategoryId,
    onChange: applyFilter,
  });

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'on-site', params],
    queryFn: () => vehicleRequestsApi.onSite(params),
  });

  // День среза считает сервер (ADR 0036): до ответа подписи присутствия не строятся — считать их
  // по часам браузера значило бы отвечать про другой день, чем отобранные строки. От него же
  // считается доступность досрочного завершения — правило одно с сервером (ADR 0044).
  const onDate = data?.onDate;

  // Итог считается по тем же фильтрам, что и таблица: сводка, отвечающая не про то, что человек
  // видит перед собой, вводит в заблуждение вернее, чем её отсутствие.
  const { data: summary } = useQuery({
    queryKey: ['vehicle-requests', 'on-site-summary', params],
    queryFn: () => vehicleRequestsApi.onSiteSummary(params),
  });

  const { options: allObjectOptions } = useObjectOptions();
  const objectOptions = limitObjectOptions(allObjectOptions);

  const [viewRecord, setViewRecord] = useState<SpecialEquipmentRequestDto | null>(null);
  // Подтверждение смен ведут здесь же: вкладка отвечает, что стоит на площадке, — и на ней же
  // принимают работу по дням. В карточке заявки смены только читают.
  const [shiftsRecord, setShiftsRecord] = useState<SpecialEquipmentRequestDto | null>(null);

  // Досрочное завершение (ADR 0044) — единственное действие среза: он отвечает, что стоит на
  // площадке, и здесь же говорят, что машина уезжает раньше. Всё остальное по-прежнему ведут в
  // списке заявок.
  const { can } = useAuth();
  const earlyEnd = useEarlyEnd();
  /**
   * Второй вход в недельную заявку (ADR 0085, §5 шаг 1) — и он важнее первого: неделю собирают,
   * глядя именно на этот срез, а не открыв пустой список недельных заявок.
   */
  const weeklyCreate = useWeeklyRequestCreate();
  const canOrderWeek = can('weeklyRequests.create');
  const canRequest = can('vehicleRequests.update');
  const canDecide = can('vehicleRequests.approve');
  // Часы вносит тот, кто ведёт заявку; подпись ставит тот, кто мог бы её завести. Область
  // (свой объект) сервер проверяет сам — здесь только право.
  const canFillShifts = can('vehicleRequests.update');
  const canApproveShifts = can('vehicleRequests.create');
  /** Действие доступно тем же условием, что проверяет сервер, — и по дню среза, а не по часам браузера. */
  const earlyEndAllowed = (r: SpecialEquipmentRequestDto) =>
    canRequest && !!onDate && canRequestEarlyEnd(r, onDate) && r.earlyEnd?.status !== 'pending';
  const decidable = (r: SpecialEquipmentRequestDto) =>
    canDecide && r.earlyEnd?.status === 'pending';

  const summaryItems = [
    { label: 'Единиц техники', value: summary?.total ?? 0 },
    { label: 'Объектов', value: summary?.objects ?? 0 },
    // Две цифры, ради которых вкладку открывают утром: одну машину принимают, другую провожают.
    { label: 'Вышли сегодня', value: summary?.arrivedToday ?? 0 },
    { label: 'Уезжают сегодня', value: summary?.leavingToday ?? 0 },
    // Пятая — про завтра: эти машины уедут раньше срока, если визу поставят (ADR 0044).
    { label: 'Ждут визы на отъезд', value: summary?.earlyEndPending ?? 0 },
    // Шестая — про долг: по этим заявкам работа ещё не принята, и закрыть их нельзя.
    { label: 'Ждут согласования смен', value: summary?.shiftsPending ?? 0 },
  ];

  // Ключ колонки — он же поле сортировки на сервере (VEHICLE_ON_SITE_SORT_FIELDS).
  const columns: TableColumnType<SpecialEquipmentRequestDto>[] = [
    {
      ...textColumn<SpecialEquipmentRequestDto>({
        key: 'objectName',
        title: 'Объект',
        dataIndex: 'objectName',
        width: OBJECT_COLUMN_WIDTH,
        render: (_v, r) => <ObjectCell name={r.objectName ?? '—'} address={r.objectAddress} />,
      }),
      defaultSortOrder: 'ascend',
    },
    {
      key: 'vehicleTypeName',
      title: 'Заказано',
      dataIndex: 'vehicleTypeName',
      width: 200,
      sorter: true,
      // Заказанная позиция классификатора (ADR 0028): категория, а без неё — сам тип.
      render: (_v, r) =>
        vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        }),
    },
    {
      // Что именно стоит на площадке: машина из назначения (ADR 0027), а не заказанная позиция.
      // Арендодатель второй строкой — к нему обращаются и по простою, и по замене машины.
      key: 'assignment',
      title: 'Техника',
      width: 220,
      render: (_v, r) =>
        r.assignment ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{assignmentTitle(r.assignment)}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.assignment.lessorName ?? 'Своя техника'}
            </Typography.Text>
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'presence',
      title: 'Сегодня',
      width: 150,
      render: (_v, r) => (onDate ? presenceCell(r, onDate) : dash),
    },
    {
      key: 'term',
      title: 'Срок',
      width: 175,
      sorter: true,
      render: (_v, r) => termCell(r),
    },
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 170,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Space size={6}>
            <UserAvatar name={r.createdByName} size={18} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.createdByName}
            </Typography.Text>
          </Space>
        </div>
      ),
    },
    {
      // Приёмка работы по дням: сколько смен объект уже подтвердил и сколько наступивших дней
      // ещё ждёт подписи. Долг решает, примут ли работу подписью или её закроют со слов
      // закрывающего, — поэтому цифра стоит рядом со сроком, а не прячется в карточке.
      key: 'shifts',
      title: 'Согласование смен',
      width: 190,
      render: (_v, r) => shiftsCell(r),
    },
    textColumn<SpecialEquipmentRequestDto>({
      // Планируемые работы: по ним на объекте и понимают, чем машина занята сегодня.
      key: 'comment',
      title: 'Работы',
      dataIndex: 'comment',
      sortable: false,
      searchable: false,
      width: 260,
      ellipsis: true,
    }),
    actionsColumn<SpecialEquipmentRequestDto>(
      // Срез читают, а не ведут: статусы, виза и правка остаются в списке заявок. Своё действие
      // у него ровно одно — досрочное завершение (ADR 0044): решение об отъезде техники
      // принимают, глядя именно на этот список. Карточка — единственное место, где видны файлы,
      // ставки и вся хронология заявки (ADR 0015).
      (r) => (
        <Space size={4}>
          <RowActionButton
            title="Открыть карточку"
            icon={<EyeOutlined />}
            onClick={() => setViewRecord(r)}
          />
          <RowActionButton
            title="Смены"
            icon={<ScheduleOutlined />}
            onClick={() => setShiftsRecord(r)}
          />
          {decidable(r) ? (
            <>
              <RowActionButton
                title="Согласовать досрочное завершение"
                icon={<CheckOutlined />}
                onClick={() => earlyEnd.approve(r)}
              />
              <RowActionButton
                title="Отклонить досрочное завершение"
                icon={<CloseOutlined />}
                danger
                onClick={() => earlyEnd.reject(r)}
              />
            </>
          ) : (
            earlyEndAllowed(r) && (
              <RowActionButton
                title="Завершить досрочно"
                icon={<FieldTimeOutlined />}
                onClick={() => earlyEnd.open(r)}
              />
            )
          )}
        </Space>
      ),
      110,
    ),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        disabled={objectFieldDisabled}
        value={params.objectId}
        onChange={(v: string | undefined) => applyFilter({ objectId: v })}
      />
      {/* Заказанная техника: тип целиком либо одна его категория (ADR 0028). */}
      {classificationFilter.controls}
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123)"
        style={{ width: 180 }}
        onSearch={(val) => applyFilter({ num: parseVehicleRequestNumberSearch(val) })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      disabled: objectFieldDisabled,
      onChange: (v) => applyFilter({ objectId: v }),
    },
    classificationFilter.mobileFilter,
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, ТС-123',
      onChange: (v) => applyFilter({ num: parseVehicleRequestNumberSearch(v ?? '') }),
    },
  ];

  /**
   * Карточка среза на телефоне (ADR 0030): объект и машина — то, ради чего вкладку открывают на
   * ходу, а тег присутствия отвечает, приехала она сегодня или уезжает.
   */
  const card: CardConfig<SpecialEquipmentRequestDto> = {
    title: (r) => r.objectName,
    badge: (r) => (onDate ? presenceCell(r, onDate) : null),
    primary: (r) => (r.assignment ? assignmentTitle(r.assignment) : '—'),
    lines: [
      (r) =>
        vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        }),
      (r) => (r.assignment?.lessorName ? r.assignment.lessorName : 'Своя техника'),
      (r) => termCell(r),
      (r) => shiftsCell(r),
      (r) => r.comment || null,
      (r) => `${r.displayNumber} · ${r.createdByName}`,
    ],
    onOpen: (r) => setViewRecord(r),
    // Подписи в шите остаются словами (ADR 0030): подсказка на иконке по касанию не открывается.
    // Иконки идут рядом с ними — те же, что в колонке действий на десктопе.
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      },
      {
        key: 'shifts',
        label: 'Смены',
        icon: <ScheduleOutlined />,
        onClick: () => setShiftsRecord(r),
      },
      ...(decidable(r)
        ? [
            {
              key: 'approve-early-end',
              label: 'Согласовать досрочное завершение',
              icon: <CheckOutlined />,
              onClick: () => earlyEnd.approve(r),
            },
            {
              key: 'reject-early-end',
              label: 'Отклонить досрочное завершение',
              icon: <CloseOutlined />,
              danger: true,
              onClick: () => earlyEnd.reject(r),
            },
          ]
        : []),
      ...(earlyEndAllowed(r)
        ? [
            {
              key: 'early-end',
              label: 'Завершить досрочно',
              icon: <FieldTimeOutlined />,
              onClick: () => earlyEnd.open(r),
            },
          ]
        : []),
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        canOrderWeek ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={weeklyCreate.open}>
            Заявка на неделю
          </Button>
        ) : null
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки', term: 'Срок работ' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canOrderWeek
          ? { label: 'Заявка на неделю', icon: <PlusOutlined />, onClick: weeklyCreate.open }
          : undefined,
      }}
    >
      {/* Сводка — на уровне вкладок, над фильтрами: она относится ко всему срезу. */}
      <TabsExtra tabKey="on-site">
        <SummaryBar title="На объектах" items={summaryItems} />
      </TabsExtra>

      <DataTable<SpecialEquipmentRequestDto>
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

      {/* Правка отсюда не предлагается: заявку ведут в списке заказов, здесь — только смотрят. */}
      <VehicleRequestViewModal
        request={viewRecord}
        onClose={() => setViewRecord(null)}
        // Решают по запросу здесь же: причина сокращения видна только в карточке.
        earlyEndActions={(r) =>
          r.requestType === 'special_equipment' && r.earlyEnd?.status === 'pending' ? (
            <Space size={8} wrap>
              {canDecide && (
                <>
                  <Button size="small" type="primary" onClick={() => earlyEnd.approve(r)}>
                    Согласовать
                  </Button>
                  <Button size="small" danger onClick={() => earlyEnd.reject(r)}>
                    Отклонить
                  </Button>
                </>
              )}
              {canRequest && (
                <Button size="small" onClick={() => earlyEnd.withdraw(r)}>
                  Отозвать запрос
                </Button>
              )}
            </Space>
          ) : null
        }
      />

      {/* Подтверждение смен: правят их только здесь, в карточке заявки таблицу читают. */}
      <VehicleShiftsModal
        request={shiftsRecord}
        canEdit={canFillShifts}
        canApprove={canApproveShifts}
        onClose={() => setShiftsRecord(null)}
      />

      {/* Окно недельной заявки: спрашивает площадку и неделю, дальше уводит на страницу сборки. */}
      {weeklyCreate.node}

      {/* Отказ по запросу досрочного завершения: причина спрашивается окном хука. */}
      {earlyEnd.node}

      {/* Досрочное завершение — окно то же, что и в списке заявок: спрашивают в нём одно и то же. */}
      <VehicleEarlyEndModal
        request={earlyEnd.target}
        onDate={onDate ?? ''}
        approvesOwn={earlyEnd.approvesOwn}
        confirmLoading={earlyEnd.pending}
        onCancel={earlyEnd.close}
        onSubmit={earlyEnd.submit}
      />
    </PageTableLayout>
  );
}
