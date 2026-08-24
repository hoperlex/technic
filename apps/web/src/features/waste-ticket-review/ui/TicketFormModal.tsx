import { useEffect } from 'react';
import { App, DatePicker, Form, Input, InputNumber, Modal, Radio, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WasteTicketDto, WasteTicketWorkKind } from '@technic/contracts';
import { wasteTicketKeys, wasteTicketsApi } from '@entities/waste-ticket';
import { errorMessage } from '../../../utils/format';

/**
 * Талон руками: заведение и правка одним окном (ADR 0114, Р15, Р27).
 *
 * Ручной путь не запасной, а равноправный: машина читает не всё, а два талона на кадре видит как
 * один. Поэтому окно одно и то же — меняется лишь то, чем оно заполнено и куда уходит.
 *
 * Разница между режимами ровно в двух вещах. Заведённый руками талон создаётся **сразу
 * подтверждённым**: человек и есть тот, кто подтверждает, — и сразу занимает номер. Правка же
 * пишет `edited_at` и снимает спорность с исправленного поля: ответ человека и есть то, чего
 * машина сказать не смогла.
 *
 * Конфликт номера приходит 409 и требует причины «это разные бумаги». Спрашивается она **тем же
 * действием**, а не отдельной кнопкой: клапан ставится только на конфликтующую строку, и отдельная
 * ручка «снять ограничение» позволила бы снять его со старшей бумаги, открыв её номер всем
 * следующим дублям (Р28).
 */
interface Values {
  number: string;
  issuedOn: Dayjs | null;
  volumeM3: number | null;
  workKind: WasteTicketWorkKind;
  addressRaw: string;
  duplicateOverrideReason?: string;
}

export function TicketFormModal({
  requestId,
  ticket,
  pageId,
  open,
  onClose,
}: {
  requestId: string;
  /** `null` — заводим новый талон; иначе правим этот. */
  ticket: WasteTicketDto | null;
  /** Страница, к которой привязать новый талон: «на кадре два талона, распознан один». */
  pageId?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const editing = !!ticket;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      number: ticket?.number ?? '',
      issuedOn: ticket?.issuedOn ? dayjs(ticket.issuedOn) : null,
      volumeM3: ticket?.volumeM3 ?? null,
      workKind: ticket?.workKind ?? 'removal',
      addressRaw: ticket?.addressRaw ?? '',
      duplicateOverrideReason: undefined,
    });
  }, [open, ticket, form]);

  const save = useMutation<void, Error, Values>({
    mutationFn: async (v: Values) => {
      const body = {
        number: v.number.trim(),
        issuedOn: v.issuedOn ? v.issuedOn.format('YYYY-MM-DD') : null,
        // Простой объёма не несёт: в сумму вывезенного он не входит, и принятая цифра означала бы
        // форму, совравшую человеку (Р18).
        volumeM3: v.workKind === 'idle' ? null : (v.volumeM3 ?? null),
        workKind: v.workKind,
        addressRaw: v.addressRaw?.trim() ?? '',
        duplicateOverrideReason: v.duplicateOverrideReason?.trim() || undefined,
      };
      if (editing) await wasteTicketsApi.update(requestId, ticket!.id, body);
      else await wasteTicketsApi.create(requestId, { ...body, pageId: pageId ?? undefined });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: wasteTicketKeys.list(requestId) });
      message.success(editing ? 'Талон исправлен' : 'Талон заведён и подтверждён');
      onClose();
    },
    onError: (e) => {
      const text = errorMessage(e);
      // 409 про номер — не отказ, а вопрос: та же бумага или другая с тем же номером. Поле причины
      // появляется прямо в этом окне, и следующая отправка уходит вместе с ней.
      if (text.includes('уже предъявлен')) {
        form.setFields([{ name: 'duplicateOverrideReason', errors: [text] }]);
        message.warning('Номер уже занят. Если это другая бумага — опишите почему');
      } else {
        message.error(text);
      }
    },
  });

  return (
    <Modal
      open={open}
      title={editing ? 'Исправить талон' : 'Талон вручную'}
      okText={editing ? 'Сохранить' : 'Завести и подтвердить'}
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        {!editing && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Заведённый вручную талон сразу считается подтверждённым и занимает номер.
          </Typography.Paragraph>
        )}
        <Form.Item
          name="number"
          label="№ талона"
          rules={[{ required: true, message: 'Номер стоит на бланке — впишите его как есть' }]}
        >
          <Input maxLength={64} placeholder="30476" />
        </Form.Item>
        <Form.Item name="issuedOn" label="Дата талона">
          <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" allowClear />
        </Form.Item>
        <Form.Item name="workKind" label="Что было">
          <Radio.Group
            options={[
              { value: 'removal', label: 'Вывоз' },
              { value: 'idle', label: 'Простой' },
              { value: 'other', label: 'Иное' },
            ]}
            optionType="button"
          />
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(prev: Values, next: Values) => prev.workKind !== next.workKind}
        >
          {({ getFieldValue }) =>
            getFieldValue('workKind') === 'idle' ? (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                У простоя объёма нет: в сумму вывезенного он не входит.
              </Typography.Paragraph>
            ) : (
              <Form.Item
                name="volumeM3"
                label="Объём, м³"
                rules={[
                  {
                    required: getFieldValue('workKind') === 'removal',
                    message: 'Укажите объём с талона',
                  },
                ]}
              >
                <InputNumber style={{ width: '100%' }} min={0} step={1} />
              </Form.Item>
            )
          }
        </Form.Item>
        <Form.Item name="addressRaw" label="Адрес с талона">
          <Input maxLength={512} placeholder="как написано на бланке" />
        </Form.Item>
        {/* Появляется только после 409: причина объясняет конфликт, а не меняет талон. */}
        <Form.Item
          name="duplicateOverrideReason"
          label="Это разные бумаги — почему"
          extra="Заполняется, только если номер уже занят другой заявкой"
        >
          <Input.TextArea rows={2} maxLength={512} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
