import { useState } from 'react';
import { Alert, App, Button, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  maintenanceStateColors,
  maintenanceStateHint,
  maintenanceStateLabels,
  type VehicleMaintenanceDto,
} from '@technic/contracts';
import { vehicleMaintenanceApi, vehicleMaintenanceKeys } from '@entities/vehicle-maintenance';
import { errorMessage } from '@shared/lib';
import { ViewFields } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { VERSION_CONFLICT_MESSAGE, isVersionConflict } from '../model/conflict';
import { SHOWN_DATE, isLowerBound, kmSinceText, kmText } from '../model/maintenanceText';
import { MaintenanceFormModal } from './MaintenanceFormModal';
import { MaintenanceHistoryTable } from './MaintenanceHistoryTable';

/**
 * Блок обслуживания машины (план «Показания техники», Р14а): когда обслуживали, сколько прошла с
 * тех пор и чем это подтверждено.
 *
 * Блок собран из **своего** ответа и о статистике показаний не знает ничего — в этом весь смысл
 * решения Р14а. Карточка машины в сводке показаний живёт под `vehicleReadings.read` и отдаёт
 * только статистику; сводка ТО приходит под `vehicleMaintenance.read` своей ручкой, и полную
 * карточку диспетчера портал собирает композицией двух ответов. Поэтому один и тот же блок
 * обслуживает оба входа: карточку машины и окно сводки механика, которому вкладка «Показания» не
 * видна вовсе (Р14в).
 *
 * **Без права `vehicleMaintenance.read` блока нет и запроса нет.** Не «блок с пустотой» и не
 * «ответ, из которого сервер вырезал поля»: право, влияющее на состав чужого DTO, — то же
 * смешение, только спрятанное в сериализатор. Права на ТО и на показания независимы, и независимы
 * они ровно настолько, насколько независимы запросы.
 *
 * Состояние приходит посчитанным (Р24): второй формулы на портале нет, и `maintenanceState` здесь
 * не зовётся вовсе — сервер посчитал её же. Портал берёт готовое `state`, красит его общим
 * словарём и объясняет общим текстом: «неизвестно» без объяснения читается как поломка портала,
 * хотя означает ровно две разные вещи — счётчик меняли либо известно не всё (Р11в).
 */

const secondary = { fontSize: 12 } as const;

export function VehicleMaintenanceBlock({
  vehicleId,
  vehicleLabel,
  on,
}: {
  vehicleId: string;
  /** Подпись машины на время загрузки: своё имя приходит в ответе сводки. */
  vehicleLabel?: string;
  /**
   * День среза (Р16): и записи ТО, и последний одометр берутся не позже него. В карточке машины это
   * конец её периода — срез марта не должен показывать майское обслуживание. Пусто — сервер сам
   * возьмёт сегодняшний московский день: часы браузера бывают сбиты.
   */
  on?: string;
}) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const canRead = can('vehicleMaintenance.read');
  const canWrite = can('vehicleMaintenance.write');

  /** Открытая форма: `null` в `record` — заводят новую запись, иначе правят эту (Р15). */
  const [editing, setEditing] = useState<{ record: VehicleMaintenanceDto | null } | null>(null);

  const query = on ? { on } : {};
  const summaryQuery = useQuery({
    queryKey: vehicleMaintenanceKeys.summary(vehicleId, query),
    queryFn: () => vehicleMaintenanceApi.summary(vehicleId, query),
    enabled: canRead,
  });
  const historyQuery = useQuery({
    queryKey: vehicleMaintenanceKeys.history(vehicleId),
    queryFn: () => vehicleMaintenanceApi.history(vehicleId),
    enabled: canRead,
  });

  const remove = useMutation({
    mutationFn: (r: VehicleMaintenanceDto) => vehicleMaintenanceApi.remove(r.id, r.version),
    onSuccess: () => {
      message.success('Запись ТО удалена');
      void qc.invalidateQueries({ queryKey: vehicleMaintenanceKeys.root });
    },
    onError: (e) => {
      // Версия уехала (Р30): запись успели изменить, и удалять вслепую то, чего человек не видел,
      // нельзя. Журнал перечитывается тут же — сначала нужно увидеть чужую правку.
      if (isVersionConflict(e)) {
        message.error(VERSION_CONFLICT_MESSAGE);
        void qc.invalidateQueries({ queryKey: vehicleMaintenanceKeys.root });
        return;
      }
      message.error(errorMessage(e));
    },
  });

  if (!canRead) return null;

  const summary = summaryQuery.data;
  const history = historyQuery.data?.items ?? [];

  if (summaryQuery.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Сводку обслуживания загрузить не удалось"
        description={errorMessage(summaryQuery.error)}
      />
    );
  }
  if (!summary) return <Skeleton active paragraph={{ rows: 3 }} />;

  const label = summary.vehicleLabel || vehicleLabel || 'машина';
  const tracked = summary.maintenanceBasis !== 'none';
  const lowerBound = isLowerBound(summary);
  const hint = maintenanceStateHint(summary);

  const confirmRemove = (r: VehicleMaintenanceDto) =>
    modal.confirm({
      title: `Удалить запись ТО от ${dayjs(r.performedOn).format(SHOWN_DATE)}?`,
      content:
        'Запись удаляется насовсем — архива у актов нет. Пробег с обслуживания пересчитается по ' +
        'предыдущей записи.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(r),
    });

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Space size={8} wrap>
        <Typography.Text strong>Обслуживание</Typography.Text>
        <Tag color={maintenanceStateColors[summary.state]} style={{ marginInlineEnd: 0 }}>
          {maintenanceStateLabels[summary.state]}
        </Tag>
        {canWrite && (
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setEditing({ record: null })}
            disabled={remove.isPending}
          >
            Добавить ТО
          </Button>
        )}
      </Space>

      <ViewFields
        items={[
          {
            key: 'last',
            label: 'Последнее ТО',
            children: summary.lastMaintenance ? (
              <Space direction="vertical" size={0}>
                <span>{dayjs(summary.lastMaintenance.performedOn).format(SHOWN_DATE)}</span>
                {summary.lastMaintenance.documentNumber && (
                  <Typography.Text type="secondary" style={secondary}>
                    {summary.lastMaintenance.documentNumber}
                  </Typography.Text>
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary">записей нет</Typography.Text>
            ),
          },
          {
            key: 'actOdometer',
            label: 'Пробег в акте',
            children:
              summary.lastMaintenance?.odometerKm != null ? (
                kmText(summary.lastMaintenance.odometerKm)
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            key: 'kmSince',
            label: 'Пробег с ТО',
            children: !tracked ? (
              // ТО по пробегу этот тип техники не ведёт (Р13) — числа тут не бывает вовсе, и
              // прочерк без слов читался бы как «потеряли показания».
              <Typography.Text type="secondary">не ведётся</Typography.Text>
            ) : lowerBound ? (
              <Tooltip title={hint}>
                <span>{kmSinceText(summary.kmSince, true)}</span>
              </Tooltip>
            ) : (
              kmSinceText(summary.kmSince, false)
            ),
          },
          {
            key: 'lastOdometer',
            // Единственное показание, видимое под правом ТО (Р14б): без него «8 340 км с ТО»
            // нечем проверить.
            label: on ? 'Одометр на конец периода' : 'Последний одометр',
            children: summary.lastOdometer ? (
              <Space direction="vertical" size={0}>
                <span>{kmText(summary.lastOdometer.km)}</span>
                <Typography.Text type="secondary" style={secondary}>
                  снято {dayjs(summary.lastOdometer.measuredOn).format(SHOWN_DATE)}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text type="secondary">— снимков нет</Typography.Text>
            ),
          },
        ]}
      />

      {/* Объяснение стоит текстом, а не подсказкой на наведении: «неизвестно» и «не ведётся» — это
          и есть ответ блока, и прятать его за курсором значит не ответить вовсе (Р11в, Р13). */}
      <Typography.Text type="secondary" style={secondary}>
        {hint}
      </Typography.Text>

      <MaintenanceHistoryTable
        items={history}
        canWrite={canWrite}
        onEdit={(record) => setEditing({ record })}
        onRemove={confirmRemove}
      />

      {editing && (
        <MaintenanceFormModal
          vehicleId={vehicleId}
          vehicleLabel={label}
          record={editing.record}
          history={history}
          lastOdometer={summary.lastOdometer}
          defaultOn={on}
          open
          onClose={() => setEditing(null)}
        />
      )}
    </Space>
  );
}
