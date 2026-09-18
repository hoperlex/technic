import { useState } from 'react';
import { Button, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  DEVICE_TELEMETRY_MAX_PAGE_SIZE,
  deviceIdentityLabels,
  officeEquipmentTitle,
  type DeviceIdentityDto,
  type OfficeEquipmentDto,
} from '@technic/contracts';
import { deviceIdentityApi, deviceMailKeys } from '@entities/device-mail';
import { useAuth } from '../../../auth/AuthContext';
import { formatDateTime } from '../../../utils/format';
import { DeviceIdentityAddModal } from './DeviceIdentityAddModal';

/**
 * КЛЮЧИ ОПОЗНАНИЯ В КАРТОЧКЕ АППАРАТА (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §7).
 *
 * ГЛАВНАЯ ДВЕРЬ ДЛЯ ПАРКА В ТРИ СОТНИ КАРТОЧЕК: ИТ-служба вносит серийник или имя устройства, НЕ
 * ДОЖИДАЯСЬ ПИСЬМА. До этого блока единственным входом была очередь, то есть «сначала аппарат
 * должен написать».
 *
 * СНЯТЫЕ КЛЮЧИ ЗДЕСЬ НЕ ПОКАЗЫВАЮТСЯ: карточка отвечает на вопрос «чем опознаётся этот аппарат
 * сейчас». Историю снятий держит реестр, и там она видна целиком.
 *
 * ПРАВО БЛОК СПРАШИВАЕТ САМ (`officeEquipment.telemetry`), и это не размывание слоёв: у блока есть
 * своё пустое состояние, и «нет права» с «ключей не заводили» обязаны различаться в одном месте —
 * иначе карточка показывала бы пустой заголовок тому, кому весь блок закрыт.
 */
export function DeviceIdentityCardBlock({ equipment }: { equipment: OfficeEquipmentDto }) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const equipmentId = equipment.id;
  const params = { equipmentId, pageSize: DEVICE_TELEMETRY_MAX_PAGE_SIZE };
  const { data, isLoading } = useQuery({
    queryKey: deviceMailKeys.identities(params),
    queryFn: () => deviceIdentityApi.list(params),
  });

  const items: DeviceIdentityDto[] = data?.items ?? [];
  if (!can('officeEquipment.telemetry')) return null;

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Ключи опознания
      </Typography.Title>
      {isLoading ? (
        <Spin size="small" />
      ) : (
        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
          {items.length === 0 ? (
            <Typography.Text type="secondary">{IDENTITY_EMPTY_TEXT}</Typography.Text>
          ) : (
            items.map((row) => (
              <div key={row.id}>
                <Tag>{deviceIdentityLabels[row.kind]}</Tag>
                {row.value}{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(row.confirmedAt)}
                  {row.confirmedByName ? ` · ${row.confirmedByName}` : ''}
                </Typography.Text>
              </div>
            ))
          )}
          <Button type="link" style={{ paddingInline: 0 }} onClick={() => setAdding(true)}>
            Добавить ключ
          </Button>
        </Space>
      )}

      <DeviceIdentityAddModal
        open={adding}
        equipmentId={equipmentId}
        equipmentTitle={officeEquipmentTitle(equipment)}
        onClose={() => setAdding(false)}
      />
    </>
  );
}

/**
 * «Опознаётся только по серийному номеру карточки» — и это правда, а не заглушка: резолв сравнивает
 * серийник письма с номером карточки сам. Ключи нужны там, где письмо серийника не пишет.
 */
export const IDENTITY_EMPTY_TEXT =
  'Ключей не заведено: письма опознаются только по серийному номеру из карточки';
