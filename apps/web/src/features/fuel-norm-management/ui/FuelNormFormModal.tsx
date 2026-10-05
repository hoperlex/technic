import { useEffect } from 'react';
import { App, DatePicker, Form, Input, InputNumber, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  vehicleTitle,
  FUEL_NORM_UNITS,
  fuelNormUnitLabels,
  type FuelNormUnit,
  type VehicleFuelNormDto,
} from '@technic/contracts';
import { AutoSelect, FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { fuelNormKeys, fuelNormVehiclePickerKey, fuelNormsApi } from '@entities/fuel-norm';
import { vehicleReadingKeys } from '@entities/vehicle-reading';
import { vehiclesApi } from '@entities/vehicle';

/**
 * A fuel-norm version: vehicle, effective date, two seasonal rates and a unit
 * (`docs/fuel-norms-plan.md` §2.2).
 *
 * The date is the form's primary rule, not metadata. Editing a rate creates a new version from
 * that day while earlier periods retain the old one (R6). New records default to the month's start
 * (R7), because an order arriving mid-month normally applies from its first day.
 *
 * Reusing a date replaces that day's version (R7a), so correcting a recent typo succeeds instead
 * of hitting a uniqueness error. A past replacement can change reports already seen by users, and
 * the form states that consequence. Future dates are forbidden (R7): exchange exports only the
 * current snapshot, so a scheduled version would become effective without appearing there.
 */

interface Props {
  open: boolean;
  onCancel: () => void;
  onSaved: () => void;
  /** Existing version to edit; null starts a new one. */
  record?: VehicleFuelNormDto | null;
  /** A vehicle-row entry locks the picker to the vehicle that opened it. */
  lockedVehicleId?: string | null;
}

interface Values {
  vehicleId: string;
  effectiveFrom: dayjs.Dayjs;
  unit: FuelNormUnit;
  winterRate: number;
  summerRate: number;
  fuelType: string;
  note: string;
}

const MONTH_START = () => dayjs().startOf('month');

export function FuelNormFormModal({ open, onCancel, onSaved, record, lockedVehicleId }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      vehicleId: record?.vehicleId ?? lockedVehicleId ?? undefined,
      effectiveFrom: record ? dayjs(record.effectiveFrom) : MONTH_START(),
      unit: record?.unit ?? 'l_per_100km',
      winterRate: record?.winterRate,
      summerRate: record?.summerRate,
      fuelType: record?.fuelType ?? '',
      note: record?.note ?? '',
    } as Partial<Values>);
  }, [open, record, lockedVehicleId, form]);

  const vehicles = useQuery({
    queryKey: fuelNormVehiclePickerKey,
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, status: 'active' }),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: async (values: Values) => {
      const body = {
        effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
        unit: values.unit,
        winterRate: values.winterRate,
        summerRate: values.summerRate,
        fuelType: values.fuelType ?? '',
        note: values.note ?? '',
      };
      /*
       * PATCH applies only while the effective date is unchanged. A different date is a different
       * version and therefore uses POST, which also replaces an existing version on that day.
       */
      if (record && record.effectiveFrom === body.effectiveFrom) {
        return fuelNormsApi.update(record.id, body);
      }
      return fuelNormsApi.create({ ...body, vehicleId: values.vehicleId });
    },
    onSuccess: async () => {
      message.success('Норма сохранена');
      await qc.invalidateQueries({ queryKey: fuelNormKeys.root });
      // Garage reconciliation is server-derived and otherwise keeps displaying stale totals.
      await qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
      onSaved();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={record ? 'Правка нормы расхода' : 'Норма расхода топлива'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => {
        void (async () => {
          const values = await form.validateFields();
          await save.mutateAsync(values);
        })();
      }}
      confirmLoading={save.isPending}
      okText="Сохранить"
    >
      <Form<Values> form={form} layout="vertical">
        <Form.Item
          name="vehicleId"
          label="Техника"
          rules={[{ required: true, message: 'Выберите машину' }]}
        >
          <AutoSelect
            disabled={Boolean(lockedVehicleId) || Boolean(record)}
            loading={vehicles.isFetching}
            options={(vehicles.data?.items ?? []).map((v) => ({
              value: v.id,
              label: vehicleTitle(v),
            }))}
            placeholder="Госномер или описание"
          />
        </Form.Item>
        <Form.Item
          name="effectiveFrom"
          label="Действует с"
          extra="Приказ действует с этого дня. Периоды до него считаются прежней версией нормы, а если её нет — не сверяются вовсе."
          rules={[{ required: true, message: 'Укажите дату начала действия' }]}
        >
          <DatePicker
            format="DD.MM.YYYY"
            style={{ width: '100%' }}
            // Exchange carries only current values; a future version would activate silently.
            disabledDate={(d) => d.isAfter(dayjs(), 'day')}
          />
        </Form.Item>
        <Form.Item
          name="unit"
          label="Единица нормы"
          extra="Она же выбирает счётчик: километры сверяются по одометру, часы — по моточасам"
          rules={[{ required: true }]}
        >
          <Select
            options={FUEL_NORM_UNITS.map((unit) => ({
              value: unit,
              label: fuelNormUnitLabels[unit],
            }))}
          />
        </Form.Item>
        <Form.Item
          name="winterRate"
          label="Зимняя ставка"
          rules={[{ required: true, message: 'Укажите зимнюю ставку' }]}
        >
          <InputNumber min={0.01} max={999} step={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="summerRate"
          label="Летняя ставка"
          rules={[{ required: true, message: 'Укажите летнюю ставку' }]}
        >
          <InputNumber min={0.01} max={999} step={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="fuelType" label="Вид топлива" extra="Справочно: в сверке не участвует">
          <Input maxLength={50} placeholder="ДТ, АИ-92, АИ-95" />
        </Form.Item>
        <Form.Item name="note" label="Примечание">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Норма того же дня перезаписывается: сохранение с уже занятой датой правит её версию, а не
          заводит вторую.
        </Typography.Text>
      </Form>
    </FormModal>
  );
}
