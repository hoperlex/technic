import { useState } from 'react';
import { Button, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SpecialEquipmentRequestDto } from '@technic/contracts';
import { useWaybillFormFilter } from '@features/waybill-form-filter';
import { vehicleRequestsApi } from '../../api/resources';
import { DataTable } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { TabsExtra } from '../../components/PageTabs';
import { SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleShiftsModal } from './VehicleShiftsModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { useEarlyEnd, useObjectOptions, useVehicleClassificationFilter } from './shared';
import { onSiteCard } from './onSiteCard';
import { onSiteColumns } from './onSiteColumns';
import { onSiteFilters } from './onSiteFilters';
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
 *
 * Строка вкладки собрана отдельными файлами: ячейки и правила — `onSiteCells.tsx`, колонки и
 * карточка телефона — `onSiteColumns.tsx` и `onSiteCard.tsx`, отбор — `onSiteFilters.tsx`. Здесь
 * остаётся то, чем вкладка и является: параметры списка, запросы, сводка и окна.
 */
export function VehicleRequestsOnSiteTab() {
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  // С одним объектом фильтр зафиксирован на нём — как и в списке заявок; с несколькими выбор
  // сужен до своих (ADR 0039). Сервер всё равно отдаёт только свои (requestVisibilityWhere).
  const ownObjectId = soleObjectId ?? '';

  const { params, setParams, setSort, onTableChange } = useListParams<{
    objectId?: string;
    /** Заказанная техника (ADR 0028) набором: `t<uuid>` — весь тип, `c<uuid>` — его категория. */
    classifications?: string;
    /**
     * Бланк работы дня набором — `forms=4p,esm2` (Р6): чем закрывается сегодняшний день заявки, а
     * не какой это тип машины. Ключ уходит и в список, и в сводку одними и теми же `params`:
     * сервер сужает им обе выдачи, и сводка, посчитанная не по видимым строкам, вводила бы в
     * заблуждение вернее, чем её отсутствие.
     */
    forms?: string;
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
    classifications: params.classifications,
    onChange: applyFilter,
  });
  // Бланк спрашивают тем же слайсом, что и гараж (`features/waybill-form-filter`): вопрос «чем
  // закрывается этот день» на обоих экранах один, и второй его разбор разошёлся бы с первым на
  // первой же правке справочника бланков.
  const formFilter = useWaybillFormFilter({ forms: params.forms, onChange: applyFilter });

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

  // Таблица и карточка телефона рисуют одну и ту же строку — и кормятся одним набором: разойтись
  // составом действий им нечем.
  const rowArgs = {
    onDate,
    canRequest,
    canDecide,
    earlyEnd,
    onView: setViewRecord,
    onShifts: setShiftsRecord,
  };
  const columns = onSiteColumns(rowArgs);
  const card = onSiteCard(rowArgs);

  const { filters, mobileFilters } = onSiteFilters({
    objectOptions,
    objectFieldDisabled,
    objectId: params.objectId,
    num: params.num,
    onChange: applyFilter,
    classificationFilter,
    formFilter,
  });

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
