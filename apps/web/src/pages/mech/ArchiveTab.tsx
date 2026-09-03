import { useState } from 'react';
import { App, Input, Space, Typography } from 'antd';
import { DeleteFilled, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  parseMechRequestNumberSearch,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechDayLabel,
  mechFailureText,
  mechModelLabel,
  mechRequesterLabel,
  mechRequestKeys,
  mechRequestsApi,
  MechStateTag,
} from '@entities/mech-request';
import {
  actionsColumn,
  DataTable,
  PageTableLayout,
  RowActionButton,
  sortOptionsFrom,
  type CardConfig,
} from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { useAuth } from '../../auth/AuthContext';
import { formatDateTime } from '../../utils/format';
import { MechRequestViewModal } from './MechRequestViewModal';

/**
 * Архив заявок на аренду (ADR 0070, Р15): удалённые строки и два действия над ними — вернуть в
 * работу и снести насовсем.
 *
 * Своя вкладка, а не флажок «показать удалённые» в списке: в рабочем списке архивная строка —
 * помеха (её нельзя ни вести, ни закрыть), а вопросы к ней другие — когда удалили и что в ней
 * было. Вкладку показывает страница по `archive.read`, того же права требует и сама выдача: без
 * него любое значение параметра `archive` означает «без архива», а не отказ.
 *
 * Обе ручки несут версию строки (Р21) — как и всё в модуле. У `purge` это особенно важно: строку
 * могли восстановить, пока архив был открыт, и удаление насовсем без сверки версии снесло бы живую
 * заявку.
 */
export function MechArchiveTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canRestore = can('archive.restore');
  const today = moscowDateKeyOf(new Date());
  const [viewRecord, setViewRecord] = useState<MechRequestDto | null>(null);

  /** Удалённая заявка, названная в адресе: ссылки на неё ведут в архив, а не в список. */
  const opened = useOpenedRecord<MechRequestDto>({
    active: useActiveTabKey() === 'archive',
    queryKey: (id) => mechRequestKeys.detail(id),
    fetch: (id) => mechRequestsApi.get(id),
  });

  /*
   * Отборов у архива нет — только поиск по номеру, — но порядок и размер страницы вкладка помнит
   * наравне с соседями (ADR 0139): архив открывают разбором «что было», и заново переставлять
   * сортировку при каждом заходе так же лишне, как заново выставлять отборы в списке.
   */
  const { params, setParams, setSort, onTableChange } = useListParams<{ num?: number }>(
    {},
    { searchKeys: [], persist: { scope: 'mech-archive', userId: user?.id } },
  );

  const [numInput, setNumInput] = useState('');
  const applyNum = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseMechRequestNumberSearch(raw), page: 1 }));
  };

  const query = {
    ...params,
    // Архив открывают вопросом «что снесли последним» — по нему и порядок по умолчанию.
    sortBy: params.sortBy ?? 'deletedAt',
    archive: 'only',
  };
  const { data, isFetching } = useQuery({
    queryKey: mechRequestKeys.list(query),
    queryFn: () => mechRequestsApi.list(query),
  });

  const restoreMutation = useMutation({
    mutationFn: (request: MechRequestDto) => mechRequestsApi.restore(request.id, request.version),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      setViewRecord(null);
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
    },
    onError: (e) => message.error(mechFailureText(e)),
  });

  /**
   * Версия для удаления насовсем берётся из уже показанной строки: общий хук подтверждения
   * (ADR 0060, ADR 0063) знает только идентификатор — он написан для справочников, где у записи ни
   * версии, ни состояния. Заводить второе подтверждение ради одного параметра нельзя: текст
   * необратимого действия обязан звучать во всём портале одинаково, а разойдясь, «Удалить» в одном
   * месте начнёт означать не то же, что в другом.
   */
  const versionOf = (id: string) => data?.items.find((r) => r.id === id)?.version ?? 0;
  const purge = usePurgeAction({
    subject: 'заявку',
    purge: (id) => mechRequestsApi.purge(id, versionOf(id)),
    invalidate: [mechRequestKeys.root],
  });

  const removePermanently = (r: MechRequestDto) => {
    setViewRecord(null);
    purge.confirm(r.id, r.displayNumber);
  };

  const columns = [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'kindName',
      title: 'Модель',
      dataIndex: 'mechModelName',
      width: 220,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{mechModelLabel(r)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.objectName}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'requesterName',
      title: 'Заявитель',
      dataIndex: 'departmentName',
      width: 200,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechRequesterLabel(r),
    },
    {
      // Состояние на момент удаления: по нему видно, докуда заявку успели довести.
      key: 'status',
      title: 'Состояние',
      dataIndex: 'status',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechStateTag row={r} />,
    },
    {
      key: 'plannedTo',
      title: 'План возврата',
      dataIndex: 'plannedTo',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechDayLabel(r.plannedTo),
    },
    {
      key: 'deletedAt',
      title: 'Удалена',
      dataIndex: 'deletedAt',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{formatDateTime(r.deletedAt)}</div>
          {r.deletedByName && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.deletedByName}
            </Typography.Text>
          )}
        </div>
      ),
    },
    actionsColumn<MechRequestDto>(
      (r) => (
        <Space size={4}>
          {/* Карточка — единственное место, где видно, что в заявке было: строка архива несёт
              номер и вид, а решают по договорённости, факту и истории. */}
          <RowActionButton
            title="Открыть карточку"
            icon={<EyeOutlined />}
            onClick={() => setViewRecord(r)}
          />
          {canRestore ? (
            <RowActionButton
              title="Восстановить"
              icon={<ReloadOutlined />}
              onClick={() => restoreMutation.mutate(r)}
            />
          ) : null}
          {purge.allowed ? (
            <RowActionButton
              title="Удалить окончательно"
              icon={<DeleteFilled />}
              danger
              onClick={() => removePermanently(r)}
            />
          ) : null}
        </Space>
      ),
      140,
    ),
  ];

  const card: CardConfig<MechRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => <MechStateTag row={r} />,
    primary: (r) => mechModelLabel(r),
    lines: [
      (r) => r.objectName,
      (r) => `Заявитель: ${mechRequesterLabel(r)}`,
      (r) => `Удалена: ${formatDateTime(r.deletedAt)}`,
    ],
    onOpen: (r) => setViewRecord(r),
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      },
      ...(canRestore
        ? [
            {
              key: 'restore',
              label: 'Восстановить',
              icon: <ReloadOutlined />,
              onClick: () => restoreMutation.mutate(r),
            },
          ]
        : []),
      ...(purge.allowed
        ? [
            {
              key: 'purge',
              label: 'Удалить окончательно',
              icon: <DeleteFilled />,
              danger: true,
              onClick: () => removePermanently(r),
            },
          ]
        : []),
    ],
  };

  return (
    <PageTableLayout
      filters={
        <Space wrap>
          <Input
            allowClear
            style={{ width: 260 }}
            placeholder="Поиск по № заявки, например МХ-42"
            value={numInput}
            onChange={(e) => applyNum(e.target.value)}
          />
        </Space>
      }
      mobile={{
        search: {
          value: numInput,
          placeholder: 'Например, МХ-42',
          onChange: (v) => applyNum(v ?? ''),
        },
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<MechRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching || restoreMutation.isPending || purge.pending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={query.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      {/* Карточка архивной заявки только на чтение: править её нечем (барьер Б3), а вернуть и
          снести — действия строки. Правку карточка и не предлагает — обработчик ей не передан. */}
      <MechRequestViewModal
        request={viewRecord ?? opened.record}
        today={today}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />
    </PageTableLayout>
  );
}
