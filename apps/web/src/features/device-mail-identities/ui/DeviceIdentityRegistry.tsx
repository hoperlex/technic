import { useState, type ReactNode } from 'react';
import { Button, Empty, Input, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  DEVICE_IDENTITY_KINDS,
  DEVICE_TELEMETRY_PAGE_SIZE,
  deviceIdentityLabels,
  isIdentifyingKind,
  type DeviceIdentityDto,
  type DeviceIdentityKind,
} from '@technic/contracts';
import { deviceIdentityApi, deviceMailKeys } from '@entities/device-mail';
import { PageTableLayout } from '@shared/ui';
import { formatDateTime } from '../../../utils/format';
import { useDeviceIdentityApply, useDeviceIdentityRevoke } from '../model/actions';
import { DeviceIdentityAddModal } from './DeviceIdentityAddModal';
import { RevokeIdentityModal } from './RevokeIdentityModal';

/**
 * РЕЕСТР КЛЮЧЕЙ ОПОЗНАНИЯ — режим вкладки «Техника» рядом с очередью писем (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §7).
 *
 * РЯДОМ С ОЧЕРЕДЬЮ, А НЕ ОТДЕЛЬНОЙ ВКЛАДКОЙ: человек разбирает письмо и тут же смотрит, чем этот
 * аппарат уже опознаётся, — это одна работа, разведённая по двум входам она стала бы двумя.
 *
 * ПОРЯДОК — СВЕЖИЕ СВЕРХУ, в отличие от очереди. У очереди вопрос «чья очередь», и там старые
 * сверху; здесь вопрос «что заведено», а заводят пачками — и свежая пачка сверху отвечает на «не
 * пропало ли то, что я только что залил».
 *
 * СНЯТЫЕ ПРИВЯЗКИ ПОКАЗЫВАЮТСЯ ПО ПРОСЬБЕ. Они ничего не опознают, но объясняют прошлое: «почему
 * полгода назад эти письма легли в эту карточку» спрашивают именно тогда, когда привязку уже сняли.
 */
export function DeviceIdentityRegistry({ toolbar }: { toolbar?: ReactNode }) {
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<DeviceIdentityDto | null>(null);
  const [kind, setKind] = useState<DeviceIdentityKind | undefined>();
  const [search, setSearch] = useState('');
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const apply = useDeviceIdentityApply();
  const revoke = useDeviceIdentityRevoke(() => setRevoking(null));

  const params = {
    pageSize: DEVICE_TELEMETRY_PAGE_SIZE,
    ...(kind ? { kind } : {}),
    ...(search ? { search } : {}),
    ...(includeRevoked ? { includeRevoked: true } : {}),
  };

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: deviceMailKeys.identities(params),
    queryFn: ({ pageParam }) =>
      deviceIdentityApi.list(pageParam ? { ...params, cursor: pageParam } : params),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = (data?.pages ?? []).flatMap((page) => page.items);

  const columns: TableColumnsType<DeviceIdentityDto> = [
    {
      title: 'Ключ',
      dataIndex: 'value',
      render: (_: string, row) => (
        <>
          <div>{row.value}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {deviceIdentityLabels[row.kind]}
            {isIdentifyingKind(row.kind) ? '' : ' · пачкой не применяется'}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Аппарат',
      dataIndex: 'equipmentTitle',
      render: (_: string, row) => (
        <>
          <div>{row.equipmentTitle}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.objectName || 'площадка не указана'}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Завёл',
      dataIndex: 'confirmedAt',
      width: 220,
      render: (_: string, row) => (
        <>
          <div>{formatDateTime(row.confirmedAt)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.confirmedByName || 'разбор очереди'}
            {row.note ? ` · ${row.note}` : ''}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Состояние',
      dataIndex: 'revokedAt',
      width: 230,
      render: (_: string | null, row) =>
        row.revokedAt ? (
          <>
            <Tag>{`Снята ${formatDateTime(row.revokedAt)}`}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.revokeNote}
              {row.revokedByName ? ` · ${row.revokedByName}` : ''}
            </Typography.Text>
          </>
        ) : (
          <Tag color="green">Опознаёт</Tag>
        ),
    },
    {
      title: '',
      dataIndex: 'id',
      width: 220,
      render: (_: string, row) =>
        row.revokedAt ? null : (
          <Space size={4} wrap>
            <Button size="small" type="link" onClick={() => apply.mutate(row.id)}>
              Применить к очереди
            </Button>
            <Button size="small" type="link" danger onClick={() => setRevoking(row)}>
              Снять
            </Button>
          </Space>
        ),
    },
  ];

  return (
    <>
      <PageTableLayout
        toolbar={
          <Space wrap>
            {toolbar}
            <Input.Search
              allowClear
              placeholder="Значение ключа"
              onSearch={setSearch}
              style={{ width: 240 }}
            />
            <Select<DeviceIdentityKind | undefined>
              allowClear
              placeholder="Род ключа"
              value={kind}
              onChange={setKind}
              style={{ width: 200 }}
              options={DEVICE_IDENTITY_KINDS.map((value) => ({
                value,
                label: deviceIdentityLabels[value],
              }))}
            />
            <Button
              type={includeRevoked ? 'primary' : 'default'}
              onClick={() => setIncludeRevoked((on) => !on)}
            >
              Показывать снятые
            </Button>
            <Button type="primary" onClick={() => setAdding(true)}>
              Добавить ключ
            </Button>
          </Space>
        }
      >
        {isLoading ? (
          <Spin size="small" />
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={REGISTRY_EMPTY_TEXT} />
        ) : (
          <>
            <Table<DeviceIdentityDto>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={items}
              pagination={false}
            />
            {hasNextPage ? (
              <Button
                type="link"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                style={{ marginTop: 8 }}
              >
                Показать ещё
              </Button>
            ) : null}
          </>
        )}
      </PageTableLayout>

      <DeviceIdentityAddModal open={adding} onClose={() => setAdding(false)} />
      <RevokeIdentityModal
        item={revoking}
        pending={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onSubmit={(note) => revoke.mutate({ id: revoking!.id, note })}
      />
    </>
  );
}

/**
 * «Ключей ещё не заводили», а не «данных нет»: пустой реестр — это начало работы, а не поломка, и
 * из подписи должно быть понятно, что делать.
 */
export const REGISTRY_EMPTY_TEXT =
  'Ключей ещё не заводили — добавьте серийный номер или имя устройства';
