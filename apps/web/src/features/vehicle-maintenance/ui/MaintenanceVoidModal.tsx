import { useEffect } from 'react';
import { Alert, App, Form, Input } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VehicleMaintenanceDto } from '@technic/contracts';
import { vehicleMaintenanceApi, vehicleMaintenanceKeys } from '@entities/vehicle-maintenance';
import { FormModal } from '@shared/ui';
import {
  VERSION_CONFLICT_MESSAGE,
  isVersionConflict,
  maintenanceErrorText,
} from '../model/conflict';
import { SHOWN_DATE } from '../model/maintenanceText';

/**
 * Аннулирование акта обслуживания (план `docs/auto-parts-plan.md`, Р6).
 *
 * Ошибочный акт, по которому прошли движения, не удаляют: на него ссылаются, и документ, на
 * который ссылаются, не стирают. Но и оставить его как есть нельзя — он остался бы последним
 * обслуживанием машины и сдвинул «пробег с ТО» на ложный якорь. Поэтому третий выход: акт
 * закрывается с причиной, из расчёта выпадает и остаётся в истории с пометкой.
 *
 * Два обещания окна:
 *
 *   1. **Причина обязательна.** Аннулированный акт читают через месяц, и «аннулировали и не
 *      сказали зачем» — это документ, который нечем прочитать. Того же требует база.
 *   2. **Последствие названо до нажатия.** Аннулирование необратимо, и человек обязан знать, что
 *      именно случится с актом, а не узнавать это по журналу постфактум.
 *
 * Строк акта окно больше не перечисляет (план `docs/auto-part-receipts-plan.md`, Р2): портал их не
 * читает вовсе — купленное живёт чеками, а не расходом со склада. Пообещать возврат позиций окно
 * не может и не обещает: до заморозки (выпуск 2) складской возврат делает сервер, и это его дело,
 * а не сказанное человеку слово.
 *
 * Повторить аннулирование нельзя, и правку аннулированного сервер отбивает 409 — прошлое не
 * подчищают, его объясняют: исправление вводится новым актом.
 */

interface Values {
  reason: string;
}

export function MaintenanceVoidModal({
  record,
  onClose,
}: {
  /** `null` — окно закрыто. */
  record: VehicleMaintenanceDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();

  useEffect(() => {
    if (record) form.resetFields();
  }, [record, form]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: vehicleMaintenanceKeys.root });
  };

  const voidAct = useMutation({
    mutationFn: (v: Values) =>
      vehicleMaintenanceApi.void(record!.id, {
        version: record!.version,
        reason: v.reason.trim(),
      }),
    onSuccess: () => {
      message.success('Акт аннулирован');
      invalidate();
      onClose();
    },
    onError: (e) => {
      // Версия уехала либо акт успели закрыть из другого окна: и то, и другое лечится перечиткой,
      // а не повторным нажатием той же кнопки.
      message.error(isVersionConflict(e) ? VERSION_CONFLICT_MESSAGE : maintenanceErrorText(e));
      invalidate();
      onClose();
    },
  });

  if (!record) return null;

  return (
    <FormModal
      title={`Аннулировать акт от ${dayjs(record.performedOn).format(SHOWN_DATE)}`}
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={voidAct.isPending}
      okText="Аннулировать"
      okDanger
    >
      <Form form={form} layout="vertical" onFinish={(v) => voidAct.mutate(v)}>
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="Акт останется в истории с пометкой"
          description="Из расчёта «пробег с ТО» он выйдет, и править его будет нельзя: исправление вводится новым актом."
        />
        <Form.Item
          name="reason"
          label="Причина аннулирования"
          rules={[
            { required: true, message: 'Укажите причину аннулирования' },
            { min: 3, message: 'Причина слишком короткая — её будут читать через месяц' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={1000} showCount placeholder="Акт заведён по ошибке" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
