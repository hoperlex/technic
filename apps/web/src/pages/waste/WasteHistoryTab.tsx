import { useState } from 'react';
import { App, DatePicker, Input, Select, Space } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  actsForCounterparty,
  allowedStatusTransitions,
  CLOSED_WASTE_STATUSES,
  parseWasteRequestNumberSearch,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  requestStatusLabels,
  requestTypeLabels,
  type WasteRequestDto,
} from '@technic/contracts';
import { counterpartiesApi, wasteRequestsApi } from '../../api/resources';
import { DataTable } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { dayEnd, dayStart } from '@shared/lib';
import { useListParams } from '@shared/lib';
import { useOpenedRecord } from '@shared/lib';
import { useWasteObjectScope } from '../../hooks/useWasteObjectScope';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatMoney } from '../../utils/format';
import { objectFilterOptionLabel, objectsApi, objectKeys } from '@entities/object';
import { wasteHistoryCard, wasteHistoryColumns } from './wasteHistoryColumns';
import { WasteRequestViewModal } from './WasteRequestViewModal';

const DATE = 'YYYY-MM-DD';

/**
 * Журнал закрытых заявок на вывоз (ADR 0135). Первая вкладка отвечает на «что сейчас везём», эта —
 * на вопросы, которые задают потом: что за месяц вывезли с этой площадки, кто вывозил, сколько
 * кубов вышло и во сколько это обошлось.
 *
 * Поэтому строка журнала — не строка списка заявок: вместо кнопки статуса и действий правки в ней
 * стоит факт вывоза, а сам статус читается тегом. Работающих заявок здесь нет — «Выполнена» в том
 * числе: по ней ещё разбирают талоны, и итога у неё пока не бывает.
 */
export function WasteHistoryTab() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { soleObjectId, limitObjectOptions } = useWasteObjectScope();
  // Исполнителю фильтр «кто вывозил» повторял бы единственный вариант — свою же компанию
  // (ADR 0038): чужие заявки сервер ему всё равно не отдаёт.
  const isOperator = actsForCounterparty(user, 'operator');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    status?: string;
    requestType?: string;
    objectId?: string;
    operatorCounterpartyId?: string;
    num?: number;
    deliveryFrom?: string;
    deliveryTo?: string;
  }>(
    // Умолчание — единственный объект учётки (ADR 0039): сервер и без фильтра отдаёт только свои
    // заявки, а журнал не заставляет выбирать предрешённое.
    { objectId: soleObjectId ?? undefined },
    { searchKeys: ['comment'] },
  );

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const [numInput, setNumInput] = useState('');
  const applyNumFilter = (raw: string) => {
    setNumInput(raw);
    applyFilter({ num: parseWasteRequestNumberSearch(raw) });
  };

  /**
   * Параметры запроса: период разложен на моменты в поясе портала. В самих параметрах он живёт
   * датами — тот же вид приходит и из шита фильтров на телефоне, — а `deliveryAt` хранится со
   * временем, и дата без границы дня отрезала бы последние сутки периода.
   */
  const query = {
    ...params,
    deliveryFrom: dayStart(params.deliveryFrom),
    deliveryTo: dayEnd(params.deliveryTo),
  };
  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'history', query],
    queryFn: () => wasteRequestsApi.historyList(query),
  });

  // Итог считается по тем же фильтрам, что и таблица: сводка, отвечающая не про то, что человек
  // видит перед собой, вводит в заблуждение вернее, чем её отсутствие.
  const { data: summary } = useQuery({
    queryKey: ['waste-requests', 'history-summary', query],
    queryFn: () => wasteRequestsApi.historySummary(query),
  });

  const { data: objects } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  // Площадка называется и адресом: журнал открывают вопросом «что вывезли с Ленина, 14», и по
  // адресу же ищут в поле — подпись у варианта одна, поиск идёт по ней.
  const objectOptions = limitObjectOptions(
    (objects?.items ?? []).map((o) => ({ value: o.id, label: objectFilterOptionLabel(o) })),
  );

  const { data: operatorsData } = useQuery({
    queryKey: ['counterparties', 'operators-for-select'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !isOperator,
  });
  const operatorOptions = (operatorsData?.items ?? []).map((c) => ({
    value: c.id,
    label: c.name,
  }));

  const [viewRecord, setViewRecord] = useState<WasteRequestDto | null>(null);

  /**
   * Закрытая заявка, названная в адресе: ссылка из соседнего раздела ведёт именно сюда — в списке
   * заявок завершённой и отменённой больше нет.
   */
  /**
   * Возврат завершённой заявки в «Выполнена» (ADR 0135 §6). Факт закрытия при этом не спрашивается:
   * он у заявки уже предъявлен, и сервер повторного не требует. Причина тоже не спрашивается —
   * возврат ничего не стирает, в отличие от отката в «Новую».
   */
  const rollbackMut = useMutation({
    mutationFn: (r: WasteRequestDto) => wasteRequestsApi.changeStatus(r.id, 'done', r.version),
    onSuccess: () => {
      setViewRecord(null);
      opened.clear();
      // Заявка уходит из журнала в рабочий список, и сказать об этом обязательно: иначе она
      // выглядит просто исчезнувшей со страницы.
      message.success('Заявка вернулась в «Выполнена» — талоны снова открыты для разбора');
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => {
      message.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
  });

  /**
   * Кому показывать возврат: тому, у кого этот ход есть в коридоре, — то есть праву отката
   * (`requests.rollbackStatus`) вместе с ведением статусов. Одна и та же функция и здесь, и на
   * сервере: разойдись они, кнопка предлагала бы то, что кончается ошибкой. Заявка из архива
   * возврата не получает — удалённой заявке сервер статуса не меняет вовсе.
   */
  const rollbackHandler = (
    r: WasteRequestDto | null,
  ): ((r: WasteRequestDto) => void) | undefined =>
    r && user && !r.deletedAt && allowedStatusTransitions(r.status, user, 'waste').includes('done')
      ? (target) => rollbackMut.mutate(target)
      : undefined;

  const opened = useOpenedRecord<WasteRequestDto>({
    active: useActiveTabKey() === 'history',
    queryKey: (id) => ['waste-requests', id],
    fetch: (id) => wasteRequestsApi.get(id),
  });

  const summaryItems = [
    { label: 'Закрыто', value: summary?.total ?? 0 },
    { label: requestStatusLabels.completed, value: summary?.completed ?? 0 },
    { label: requestStatusLabels.cancelled, value: summary?.cancelled ?? 0 },
    // Вывезенное двумя числами: мусор меряют объёмом, лом принимают по весу (ADR 0067), и одной
    // цифрой их не сложить. Пустая величина не показывается вовсе — «0 т» в журнале, где лома не
    // было ни разу, читается как «привезли ноль».
    ...(summary?.volumeM3 ? [{ label: 'Вывезено', value: `${summary.volumeM3} м³` }] : []),
    ...(summary?.weightTons ? [{ label: 'Сдано лома', value: `${summary.weightTons} т` }] : []),
    { label: 'Стоимость', value: formatMoney(summary?.totalCost ?? 0) },
  ];

  const columns = wasteHistoryColumns(setViewRecord);

  const filters = (
    <Space size={[12, 8]} wrap>
      {/* Раскрытый список шире поля: подпись с адресом длиннее любого разумного фильтра, и
          обрезанная в многоточие она перестаёт отвечать на «та ли это площадка». Ширина задана не
          здесь — правило одно на портал и живёт в корневом провайдере (ADR 0136). */}
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все площадки"
        style={{ width: 240 }}
        options={objectOptions}
        value={params.objectId}
        onChange={(v: string | undefined) => applyFilter({ objectId: v })}
      />
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 220 }}
        options={REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] }))}
        value={params.requestType as RequestType | undefined}
        onChange={(v: RequestType | undefined) => applyFilter({ requestType: v })}
      />
      <Select
        allowClear
        placeholder="Завершённые и отменённые"
        style={{ width: 215 }}
        options={CLOSED_WASTE_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }))}
        value={params.status as RequestStatus | undefined}
        onChange={(v: RequestStatus | undefined) => applyFilter({ status: v })}
      />
      {isOperator ? null : (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все исполнители"
          style={{ width: 220 }}
          options={operatorOptions}
          value={params.operatorCounterpartyId}
          onChange={(v: string | undefined) => applyFilter({ operatorCounterpartyId: v })}
        />
      )}
      {/* Период — по дате подачи: журнал за месяц это «что вывозили в этом месяце», а не «что в
          нём успели закрыть». */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Подача с', 'по']}
        value={[
          params.deliveryFrom ? dayjs(params.deliveryFrom) : null,
          params.deliveryTo ? dayjs(params.deliveryTo) : null,
        ]}
        onChange={(range) =>
          applyFilter({
            deliveryFrom: range?.[0]?.format(DATE),
            deliveryTo: range?.[1]?.format(DATE),
          })
        }
      />
      <Input
        allowClear
        style={{ width: 180 }}
        placeholder="№ заявки"
        value={numInput}
        onChange={(e) => applyNumFilter(e.target.value)}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Площадка',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все площадки',
      onChange: (v) => applyFilter({ objectId: v }),
    },
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: params.requestType,
      options: REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] })),
      placeholder: 'Все типы заявок',
      onChange: (v) => applyFilter({ requestType: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Чем закончилась',
      value: params.status,
      options: CLOSED_WASTE_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] })),
      placeholder: 'Завершённые и отменённые',
      onChange: (v) => applyFilter({ status: v }),
    },
    ...(isOperator
      ? []
      : [
          {
            kind: 'select' as const,
            key: 'operatorCounterpartyId',
            label: 'Исполнитель',
            value: params.operatorCounterpartyId,
            options: operatorOptions,
            placeholder: 'Все исполнители',
            onChange: (v: string | undefined) => applyFilter({ operatorCounterpartyId: v }),
          },
        ]),
    {
      kind: 'dateRange',
      key: 'period',
      label: 'Период подачи',
      from: params.deliveryFrom,
      to: params.deliveryTo,
      onChange: (deliveryFrom, deliveryTo) => applyFilter({ deliveryFrom, deliveryTo }),
    },
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, М-128',
      onChange: (v) => applyNumFilter(v ?? ''),
    },
  ];

  const card = wasteHistoryCard(setViewRecord);

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки', deliveryAt: 'Дата подачи' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      {/* Итог живёт в строке вкладок — там же, где сводка рабочего списка: два виджета на одном
          месте читаются как один, переключаемый вкладкой. */}
      <TabsExtra tabKey="history">
        <SummaryBar title="Журнал" items={summaryItems} />
      </TabsExtra>

      <DataTable<WasteRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      {/* Карточка закрытой заявки на чтение: править в ней нечего — обработчик правки окну не
          передан. Единственное действие — возврат завершённой заявки в работу, и только у того,
          кому этот ход открыт правом. */}
      <WasteRequestViewModal
        request={viewRecord ?? opened.record}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
        onRollbackToDone={rollbackHandler(viewRecord ?? opened.record)}
        rollingBack={rollbackMut.isPending}
      />
    </PageTableLayout>
  );
}
