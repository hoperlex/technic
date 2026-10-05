import { useState } from 'react';
import { App, Button, Space, Switch, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { fuelNormUnitLabels, type VehicleFuelNormDto } from '@technic/contracts';
import { DataTable, ViewModal } from '@shared/ui';
import { errorMessage, useIsMobile, useListParams } from '@shared/lib';
import { fuelNormKeys, fuelNormsApi } from '@entities/fuel-norm';
import { useAuth } from '@entities/session';
import { FuelNormFormModal } from './FuelNormFormModal';
import { FuelNormSettingsModal } from './FuelNormSettingsModal';

/**
 * Fuel-norm directory opened as a modal from the fleet registry (`docs/fuel-norms-plan.md` §2, §5;
 * the same navigation pattern as office-equipment models in ADR 0120).
 *
 * A norm is a vehicle-card property, not a portal section: users open it while inspecting one
 * vehicle. A separate tab would consume directory navigation and pull them away from that context.
 *
 * Rows are versions, not duplicates. Each order creates a new version while the old one remains
 * valid for its periods (R6). The default therefore shows current versions; history is explicit.
 *
 * File exchange is deliberately absent here (R21). Export affects the whole directory and import
 * changes hundreds of records, under permissions different from row maintenance. That workflow
 * remains in Administration as required by ADR 0073 decision 10.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** A row-opened modal is narrowed to the vehicle the user was asking about. */
  vehicleId?: string | null;
  vehicleLabel?: string;
}

const SHOWN_DATE = 'DD.MM.YYYY';

export function FuelNormsModal({ open, onClose, vehicleId = null, vehicleLabel }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  // Norm maintenance uses the directory-wide write permission (R19), not a separate grant.
  const canWrite = can('directories.write');
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [record, setRecord] = useState<VehicleFuelNormDto | null>(null);
  /** Order history starts collapsed; the default answers which norm applies now. */
  const [currentOnly, setCurrentOnly] = useState(true);

  const { params, onTableChange } = useListParams<{ sortBy?: string; sortOrder?: 'asc' | 'desc' }>(
    { sortBy: 'registrationNumber', sortOrder: 'asc' },
    { searchKeys: [] },
  );

  const query = {
    ...params,
    ...(vehicleId ? { vehicleId } : {}),
    currentOnly: currentOnly ? 'true' : 'false',
  };
  const { data, isFetching } = useQuery({
    queryKey: fuelNormKeys.list(query),
    queryFn: () => fuelNormsApi.list(query),
    enabled: open,
  });

  const settings = useQuery({
    queryKey: fuelNormKeys.settings(),
    queryFn: () => fuelNormsApi.settings(),
    enabled: open,
  });

  const remove = useMutation({
    mutationFn: (id: string) => fuelNormsApi.remove(id),
    onSuccess: async () => {
      message.success('Версия нормы снята');
      await qc.invalidateQueries({ queryKey: fuelNormKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Removal needs an explicit consequence: reports already seen may fall back to the preceding
   * version, and removal is irreversible. A new version may reuse the date, but the removed record
   * itself cannot be restored (R7b).
   */
  const confirmRemove = (row: VehicleFuelNormDto) => {
    modal.confirm({
      title: 'Снять версию нормы?',
      content: `Норма ${row.vehicleLabel} с ${dayjs(row.effectiveFrom).format(SHOWN_DATE)} перестанет действовать. Отчёты периодов, где она действовала, пересчитаются по предыдущей версии. Вернуть снятую версию нельзя.`,
      okText: 'Снять',
      cancelText: 'Отмена',
      okButtonProps: { danger: true },
      onOk: () => remove.mutateAsync(row.id),
    });
  };

  const columns: TableColumnType<VehicleFuelNormDto>[] = [
    { key: 'vehicleLabel', title: 'Техника', dataIndex: 'vehicleLabel', width: 280 },
    {
      key: 'effectiveFrom',
      title: 'Действует с',
      width: 150,
      sorter: true,
      render: (_v, r) => (
        <Space size={6}>
          <span>{dayjs(r.effectiveFrom).format(SHOWN_DATE)}</span>
          {r.isCurrent && (
            <Tooltip title="Эта версия действует сегодня: её и берёт сверка за текущий период">
              <Typography.Text type="success" style={{ fontSize: 12 }}>
                действует
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      key: 'winterRate',
      title: 'Зимняя',
      width: 110,
      align: 'right',
      sorter: true,
      render: (_v, r) => r.winterRate,
    },
    {
      key: 'summerRate',
      title: 'Летняя',
      width: 110,
      align: 'right',
      sorter: true,
      render: (_v, r) => r.summerRate,
    },
    {
      key: 'unit',
      title: 'Единица',
      width: 120,
      render: (_v, r) => fuelNormUnitLabels[r.unit],
    },
    {
      key: 'fuelType',
      title: 'Топливо',
      width: 110,
      // Fuel type is descriptive only (R4); reconciliation compares quantities in litres.
      render: (_v, r) => r.fuelType || <Typography.Text type="secondary">—</Typography.Text>,
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            title: '',
            width: 100,
            render: (_v: unknown, r: VehicleFuelNormDto) => (
              <Space size={4}>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setRecord(r);
                    setFormOpen(true);
                  }}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => confirmRemove(r)}
                />
              </Space>
            ),
          } satisfies TableColumnType<VehicleFuelNormDto>,
        ]
      : []),
  ];

  const seasonText = settings.data
    ? `Зима с ${settings.data.winterFromMd.replace('-', '.')} по ${settings.data.winterToMd.replace('-', '.')}, допуск ${settings.data.tolerancePercent}%`
    : 'Настройки сверки загружаются…';

  return (
    <ViewModal
      title={vehicleLabel ? `Нормы расхода: ${vehicleLabel}` : 'Нормы расхода топлива'}
      open={open}
      onClose={onClose}
      width={1000}
      destroyOnHidden
      footer={
        canWrite ? (
          <Space>
            <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              Настройки сверки
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setRecord(null);
                setFormOpen(true);
              }}
            >
              Добавить норму
            </Button>
          </Space>
        ) : null
      }
      // DataTable measures its container to derive scrolling, so the body needs an explicit height.
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '70vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <Space size={12} wrap style={{ flex: '0 0 auto' }}>
        <Space size={6}>
          <Switch checked={currentOnly} onChange={setCurrentOnly} size="small" />
          <Typography.Text>Только действующие</Typography.Text>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {seasonText}
        </Typography.Text>
      </Space>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: isMobile ? 'auto' : undefined }}>
        <DataTable<VehicleFuelNormDto>
          rowKey="id"
          columns={columns}
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

      {/* Nest forms under the list modal so Ant raises their z-index; a sibling modal sits behind
          the full-screen list sheet on phones. */}
      <FuelNormFormModal
        open={formOpen}
        record={record}
        lockedVehicleId={vehicleId}
        onCancel={() => setFormOpen(false)}
        onSaved={() => setFormOpen(false)}
      />
      <FuelNormSettingsModal
        open={settingsOpen}
        settings={settings.data ?? null}
        onCancel={() => setSettingsOpen(false)}
      />
    </ViewModal>
  );
}
