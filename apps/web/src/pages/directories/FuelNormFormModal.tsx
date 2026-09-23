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
 * Версия нормы: машина, дата начала действия, две ставки и единица (план `docs/fuel-norms-plan.md`,
 * §2.2).
 *
 * **Дата — главное поле формы, а не реквизит.** Правка ставки заводит НОВУЮ версию, и та действует
 * с указанного дня; прошлые периоды считаются прежней (Р6). Умолчание — начало текущего месяца
 * (Р7): приказ приходит в середине месяца, а действует с его начала, и подставлять сегодняшний
 * день значило бы резать месяц пополам на ровном месте.
 *
 * **Совпадение даты перезаписывает версию этого дня** (Р7а): человек, поправивший опечатку через
 * час, обязан получить сохранение, а не отказ базы. Форма предупреждает об этом словами, когда
 * дата уже прошла: перезапись прошлой версии меняет уже показанные отчёты.
 *
 * Будущая дата запрещена (Р7): файл обмена возит срез действующего, и версия, заведённая вперёд,
 * вступала бы в силу молча.
 */

interface Props {
  open: boolean;
  onCancel: () => void;
  onSaved: () => void;
  /** Правка заведённой версии; `null` — заведение новой. */
  record?: VehicleFuelNormDto | null;
  /** Окно открыто из строки машины: выбор техники заперт — спрашивали про неё. */
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
       * Правка версии идёт PATCH'ем только когда дата не менялась. Сменили дату — это уже другая
       * версия, и заводить её должен POST: он же и перезапишет запись того дня, если она есть.
       */
      if (record && record.effectiveFrom === body.effectiveFrom) {
        return fuelNormsApi.update(record.id, body);
      }
      return fuelNormsApi.create({ ...body, vehicleId: values.vehicleId });
    },
    onSuccess: async () => {
      message.success('Норма сохранена');
      await qc.invalidateQueries({ queryKey: fuelNormKeys.root });
      // Сводка гаража считает сверку сервером: без сброса её кэша экран показывал бы старые числа.
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
            // Будущее закрыто: срез обмена возит действующее, и версия вперёд вступала бы в силу
            // молча, без чьего-либо ведома.
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
