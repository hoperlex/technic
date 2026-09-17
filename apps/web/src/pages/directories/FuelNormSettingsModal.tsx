import { useEffect } from 'react';
import { App, Alert, Form, InputNumber, Select, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { FuelNormSettingsDto } from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { fuelNormKeys, fuelNormsApi } from '@entities/fuel-norm';
import { vehicleReadingKeys } from '@entities/vehicle-reading';

/**
 * Настройки сверки: границы зимнего сезона и допуск в процентах (план `docs/fuel-norms-plan.md`,
 * §2.3).
 *
 * **Версий у настроек нет, и это осознанное исключение** (Р8а): в отличие от самих норм, правка
 * здесь меняет и уже показанные отчёты — граница сезона переставляет ставку, допуск переставляет
 * границу превышения. Поэтому окно говорит об этом прямо и спрашивает подтверждение, а внизу
 * показывает, кто менял в последний раз: другого следа истории у настроек нет.
 *
 * День-месяц выбирается двумя списками, а не датой: у сезона нет года, и календарь предлагал бы
 * выбрать его — с неизбежным вопросом «а что будет в следующем».
 */

interface Props {
  open: boolean;
  onCancel: () => void;
  settings: FuelNormSettingsDto | null;
}

interface Values {
  winterFromMonth: number;
  winterFromDay: number;
  winterToMonth: number;
  winterToDay: number;
  tolerancePercent: number;
}

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: dayjs().month(i).format('MMMM'),
}));

/** Дней в месяце без года: февраль — 29, потому что сезон високосность не различает. */
const daysIn = (month: number): number => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

const pad = (value: number): string => String(value).padStart(2, '0');

export function FuelNormSettingsModal({ open, onCancel, settings }: Props) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<Values>();
  const qc = useQueryClient();

  useEffect(() => {
    if (!open || !settings) return;
    const [fromMonth, fromDay] = settings.winterFromMd.split('-').map(Number);
    const [toMonth, toDay] = settings.winterToMd.split('-').map(Number);
    form.setFieldsValue({
      winterFromMonth: fromMonth,
      winterFromDay: fromDay,
      winterToMonth: toMonth,
      winterToDay: toDay,
      tolerancePercent: settings.tolerancePercent,
    } as Values);
  }, [open, settings, form]);

  const save = useMutation({
    mutationFn: (values: Values) =>
      fuelNormsApi.saveSettings({
        winterFromMd: `${pad(values.winterFromMonth)}-${pad(values.winterFromDay)}`,
        winterToMd: `${pad(values.winterToMonth)}-${pad(values.winterToDay)}`,
        tolerancePercent: values.tolerancePercent,
      }),
    onSuccess: async () => {
      message.success('Настройки сверки сохранены');
      await qc.invalidateQueries({ queryKey: fuelNormKeys.root });
      // Сверка считается сервером: без сброса кэша сводка осталась бы с прежним допуском.
      await qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
      onCancel();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = async () => {
    const values = await form.validateFields();
    modal.confirm({
      title: 'Изменить настройки сверки?',
      content:
        'Границы сезона и допуск действуют на все периоды сразу, включая уже показанные отчёты: норма за прошлые месяцы пересчитается по новым границам, а превышения — по новому допуску.',
      okText: 'Изменить',
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync(values),
    });
  };

  return (
    <FormModal
      title="Настройки сверки"
      open={open}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      confirmLoading={save.isPending}
      okText="Сохранить"
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Настройки одни на весь портал"
        description="Они не версионируются: правка меняет и прошлые отчёты. Сами нормы, наоборот, живут версиями — приказ прошлого месяца остаётся в силе для своего периода."
      />
      <Form<Values> form={form} layout="vertical">
        <Typography.Text strong>Зимний период</Typography.Text>
        <Form.Item label="С" style={{ marginBottom: 8 }} required>
          <Form.Item name="winterFromMonth" noStyle rules={[{ required: true }]}>
            <Select options={MONTHS} style={{ width: '60%' }} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.winterFromMonth !== next.winterFromMonth}
          >
            {({ getFieldValue }) => (
              <Form.Item name="winterFromDay" noStyle rules={[{ required: true }]}>
                <InputNumber
                  min={1}
                  max={daysIn(getFieldValue('winterFromMonth') ?? 1)}
                  style={{ width: '40%' }}
                />
              </Form.Item>
            )}
          </Form.Item>
        </Form.Item>
        <Form.Item label="По" required>
          <Form.Item name="winterToMonth" noStyle rules={[{ required: true }]}>
            <Select options={MONTHS} style={{ width: '60%' }} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.winterToMonth !== next.winterToMonth}
          >
            {({ getFieldValue }) => (
              <Form.Item name="winterToDay" noStyle rules={[{ required: true }]}>
                <InputNumber
                  min={1}
                  max={daysIn(getFieldValue('winterToMonth') ?? 12)}
                  style={{ width: '40%' }}
                />
              </Form.Item>
            )}
          </Form.Item>
        </Form.Item>
        <Form.Item
          name="tolerancePercent"
          label="Допуск, %"
          extra="Отклонение в пределах допуска превышением не считается"
          rules={[{ required: true, message: 'Укажите допуск' }]}
        >
          <InputNumber min={0} max={100} step={0.5} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
      {settings && settings.updatedByName && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Последняя правка: {settings.updatedByName},{' '}
          {dayjs(settings.updatedAt).format('DD.MM.YYYY HH:mm')}
        </Typography.Text>
      )}
    </FormModal>
  );
}
