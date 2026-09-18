import { useEffect, useState } from 'react';
import { Alert, Form, Input, Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  DEVICE_MANUAL_IDENTITY_KINDS,
  deviceIdentityLabels,
  type DeviceManualIdentityKind,
} from '@technic/contracts';
import { deviceIdentityApi, deviceMailKeys } from '@entities/device-mail';
import { officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { AutoSelect, FormModal } from '@shared/ui';
import { useDeviceIdentityCreate } from '../model/actions';

/**
 * «Добавить ключ» — заведение привязки БЕЗ ПИСЬМА (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.1 и §7).
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ОКНО, ЕСЛИ ЕСТЬ «ПРИВЯЗАТЬ» В ОЧЕРЕДИ. Там привязку заводят ОТ ПИСЬМА: сначала
 * аппарат должен написать. Здесь — от карточки: ИТ-служба знает серийники заранее, и три сотни
 * аппаратов заводятся до того, как в ящик придёт первое письмо.
 *
 * АДРЕСОВ СРЕДИ РОДОВ НЕТ. Адрес — свойство конверта, а не аппарата: служебный ящик прописан парку
 * целиком, и ключ по адресу, заведённый заранее, увёл бы к одной карточке письма всего парка. Из
 * очереди привязать по адресу по-прежнему можно — там он применяется к одной строке.
 *
 * ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ СЧИТАЕТ СЕРВЕР тем же отбором, что и применение: своя оценка показала бы
 * одно число, а применилось бы другое.
 */

const kindOptions = DEVICE_MANUAL_IDENTITY_KINDS.map((value) => ({
  value,
  label: deviceIdentityLabels[value],
}));

interface Values {
  kind: DeviceManualIdentityKind;
  value: string;
  equipmentId: string;
  note?: string;
}

export const TARGETS_PREFIX = 'Непривязанных писем с этим ключом: ';

export function DeviceIdentityAddModal({
  open,
  equipmentId,
  equipmentTitle,
  onClose,
}: {
  open: boolean;
  /** Задан — окно открыто из карточки: аппарат выбран и не спрашивается. */
  equipmentId?: string;
  equipmentTitle?: string;
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const [search, setSearch] = useState('');
  const kind = Form.useWatch('kind', form);
  const value = Form.useWatch('value', form);

  // Поля заполняются при КАЖДОМ открытии: форма antd держит прежние значения до явного сброса, а
  // окно открывают подряд для разных аппаратов.
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      kind: 'serial',
      value: '',
      equipmentId: equipmentId ?? undefined!,
      note: '',
    });
  }, [open, equipmentId, form]);

  const create = useDeviceIdentityCreate(onClose);

  const { data: options = [], isFetching: loadingOptions } = useQuery({
    ...officeEquipmentOptionsQuery(search),
    enabled: open && !equipmentId,
  });

  const trimmed = (value ?? '').trim();
  const { data: targets } = useQuery({
    queryKey: deviceMailKeys.identityTargets(kind ?? '', trimmed),
    queryFn: () => deviceIdentityApi.targets({ kind: kind!, value: trimmed }),
    enabled: open && Boolean(kind) && trimmed !== '',
  });

  return (
    <FormModal
      open={open}
      title="Добавить ключ опознания"
      okText="Добавить"
      confirmLoading={create.isPending}
      onCancel={onClose}
      onSubmit={() => form.submit()}
    >
      {equipmentTitle && (
        <Alert type="info" showIcon title={equipmentTitle} style={{ marginBottom: 12 }} />
      )}
      <Form<Values>
        form={form}
        layout="vertical"
        onFinish={(values) =>
          create.mutate({
            equipmentId: equipmentId ?? values.equipmentId,
            kind: values.kind,
            value: values.value.trim(),
            note: values.note ?? '',
          })
        }
      >
        <Form.Item name="kind" label="Чем связываем" rules={[{ required: true }]}>
          <Select options={kindOptions} />
        </Form.Item>
        <Form.Item
          name="value"
          label="Значение ключа"
          rules={[{ required: true, message: 'Введите значение' }]}
        >
          <Input placeholder="Серийный номер или имя устройства так, как его пишет аппарат" />
        </Form.Item>
        {!equipmentId && (
          <Form.Item name="equipmentId" label="Какая карточка" rules={[{ required: true }]}>
            <AutoSelect
              options={options}
              loading={loadingOptions}
              onSearch={setSearch}
              placeholder="Модель, инвентарный или серийный номер"
            />
          </Form.Item>
        )}
        <Form.Item name="note" label="Примечание">
          <Input placeholder="Откуда взяли значение" />
        </Form.Item>
        {targets && targets.messages > 0 && (
          <Alert
            type="info"
            showIcon
            title={`${TARGETS_PREFIX}${targets.messages}`}
            description={
              targets.batch
                ? 'Все они применятся к этой карточке сразу'
                : 'Этот род ключа пачкой не применяется'
            }
          />
        )}
      </Form>
    </FormModal>
  );
}
