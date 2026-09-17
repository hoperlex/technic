import { useState } from 'react';
import { App, Button, Space, Switch, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { fuelNormUnitLabels, type VehicleFuelNormDto } from '@technic/contracts';
import { DataTable, ViewModal } from '@shared/ui';
import { errorMessage, useIsMobile, useListParams } from '@shared/lib';
import { fuelNormKeys, fuelNormsApi } from '@entities/fuel-norm';
import { useAuth } from '../../auth/AuthContext';
import { FuelNormFormModal } from './FuelNormFormModal';
import { FuelNormSettingsModal } from './FuelNormSettingsModal';

/**
 * Справочник норм расхода топлива — окном из вкладки «Техника» (план `docs/fuel-norms-plan.md`,
 * §2 и §5; приём тот же, что у моделей оргтехники, ADR 0120).
 *
 * Почему окно, а не вкладка. Норма — не раздел портала, а свойство карточки техники: её заводят,
 * стоя в реестре парка, и читают, разбираясь с одной машиной. Вкладка ради справочника, который
 * открывают из строки, стоила бы места в шапке «Справочников» и увела бы человека от машины.
 *
 * **Окно показывает версии, а не строки.** У машины их столько, сколько было приказов, и это не
 * дубли: правка заводит новую версию, старая остаётся действовать на свои периоды (Р6). Поэтому
 * умолчание — «только действующие»: справочник открывают вопросом «какая норма сейчас», а историю
 * разворачивают переключателем.
 *
 * Кнопок обмена файлом здесь нет намеренно (Р21): выгрузка уносит справочник целиком, загрузка
 * меняет сотни строк одним нажатием, и права на это выданы не тем, кто ведёт справочник по строке.
 * Обмен живёт на своей вкладке в «Администрировании» — решение 10 ADR 0073 остаётся в силе.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Окно, открытое из строки реестра, сужено до одной машины: у неё и спрашивали. */
  vehicleId?: string | null;
  vehicleLabel?: string;
}

const SHOWN_DATE = 'DD.MM.YYYY';

export function FuelNormsModal({ open, onClose, vehicleId = null, vehicleLabel }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  // Ведение справочника — общим правом модуля (Р19): своего права у норм нет.
  const canWrite = can('directories.write');
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [record, setRecord] = useState<VehicleFuelNormDto | null>(null);
  /** История приказов по умолчанию свёрнута: см. шапку файла. */
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
   * Снятие спрашивают подтверждением, и текст у него длиннее обычного не для солидности: снятие
   * переписывает уже показанные отчёты (смены возвращаются к предыдущей версии) и необратимо —
   * на ту же дату можно завести новую запись, а снятую вернуть уже нечем (Р7б).
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
      // Справочно (Р4): в сверке вид топлива не участвует — расход считается в литрах.
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
      // Тело обязано иметь высоту: `DataTable` меряет контейнер и считает по нему прокрутку.
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

      {/* Форма внутри окна списка: antd поднимает z-index вложенного окна по контексту, а соседнее
          на телефоне оказалось бы под шторкой списка. */}
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
