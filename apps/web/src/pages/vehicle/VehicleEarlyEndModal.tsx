import { useEffect } from 'react';
import { App, DatePicker, Form, Input, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  earlyEndDateBounds,
  earlyEndDaysSaved,
  type RequestVehicleEarlyEndInput,
  requestCustomerName,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { calendarDaysLabel } from '../../utils/date';
import { formatDateOnly } from './shared';

/**
 * Досрочное завершение заказа спецтехники (ADR 0044): техника освободилась раньше срока.
 *
 * Заявку заказывали периодом — «автокран на две недели», — а фронт работ закрылся раньше, и
 * машина простаивает на площадке за деньги. Окно просит одно: до какого числа техника нужна
 * на самом деле и почему срок сокращается. Решает не тот, кто просит: запрос уходит на визу
 * руководителя строительства — того же, кто визировал сам заказ.
 *
 * Границы даты приходят из контрактов (`earlyEndDateBounds`) — теми же их проверяет сервер: не
 * раньше сегодня (задним числом период не переписывается) и строго раньше нынешнего конца.
 */
interface Props {
  /** null — окно закрыто. Только заказ спецтехники: у грузоперевозки срока работ нет. */
  request: SpecialEquipmentRequestDto | null;
  /** День среза по Москве: его считает сервер, часы браузера тут не годятся (ADR 0036). */
  onDate: string;
  /** Запрос применится сразу: окно открыл тот, кто эту заявку и визирует. */
  approvesOwn: boolean;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: RequestVehicleEarlyEndInput) => void;
}

interface FormValues {
  newDateTo?: Dayjs;
  reason?: string;
}

export function VehicleEarlyEndModal({
  request,
  onDate,
  approvesOwn,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();

  const bounds = request ? earlyEndDateBounds(request, onDate) : null;

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели. Дата
  // по умолчанию — сегодня: чаще всего именно им и заканчивают, «машина уезжает сегодня».
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    form.setFieldsValue({ newDateTo: bounds ? dayjs(bounds.min) : undefined, reason: '' });
    // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
    // стёрла бы уже набранное.
  }, [targetId]);

  const newDateTo = Form.useWatch('newDateTo', form);
  const newDateKey = newDateTo?.format('YYYY-MM-DD');
  // Сколько дней освобождается — то, ради чего сокращение и делают: по ним считают и площадку,
  // и аренду. Считает контракт, чтобы подпись не разошлась с тем, что запишет сервер.
  const daysSaved =
    request?.dateTo && newDateKey ? earlyEndDaysSaved(request.dateTo, newDateKey) : null;

  const submit = (v: FormValues) => {
    const dateKey = v.newDateTo?.format('YYYY-MM-DD');
    if (!dateKey || !bounds || dateKey < bounds.min || dateKey > bounds.max) {
      message.warning('Выберите дату внутри срока заявки');
      return;
    }
    onSubmit({ newDateTo: dateKey, reason: (v.reason ?? '').trim(), version: request!.version });
  };

  return (
    <FormModal
      title={
        request ? `Досрочное завершение ${request.displayNumber}` : 'Досрочное завершение заявки'
      }
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      // Кнопка называет то, что произойдёт: у визирующего срок изменится сразу, у остальных
      // запрос уйдёт на визу. Обещать «завершено» тому, чей запрос ещё будут смотреть, нельзя.
      okText={approvesOwn ? 'Завершить досрочно' : 'Отправить на визу'}
      width={720}
    >
      {request && (
        <Form form={form} layout="vertical" onFinish={submit}>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {requestCustomerName(request)}
            </Typography.Paragraph>

            {/* Заказанный срок — основание решения: сокращают именно его, и видеть его нужно
              там же, где выбирают новую дату. */}
            <div style={{ marginBottom: 16, lineHeight: 1.5 }}>
              <Typography.Text strong>
                {/* Дата окончания у сокращаемой заявки есть всегда: без неё срок однодневный,
                  а однодневную сокращать нечем (`earlyEndBlocker`). */}
                Заказано: {formatDateOnly(request.dateFrom)} –{' '}
                {formatDateOnly(request.dateTo ?? request.dateFrom)}
              </Typography.Text>
              <div>
                <Typography.Text type="secondary">
                  {calendarDaysLabel(request.dateFrom, request.dateTo)}
                </Typography.Text>
              </div>
            </div>
          </FormGrid.Full>

          <FormGrid>
            <Form.Item
              name="newDateTo"
              label="Последний день работ"
              rules={[{ required: true, message: 'Выберите дату' }]}
              extra={
                daysSaved != null
                  ? `Освободится ${daysSaved} дн. из заказанных`
                  : 'Не раньше сегодняшнего дня и раньше нынешнего окончания'
              }
            >
              <DatePicker
                style={{ width: '100%' }}
                format="DD.MM.YYYY"
                allowClear={false}
                // Те же границы проверяет сервер: портал не должен предлагать дату, которую он
                // отклонит, — ни вчерашнюю, ни нынешний конец срока.
                disabledDate={(d) => {
                  if (!bounds) return true;
                  const key = d.format('YYYY-MM-DD');
                  return key < bounds.min || key > bounds.max;
                }}
              />
            </Form.Item>

            <FormGrid.Full>
              {/* Причина обязательна: руководителю строительства решать нечего, если ему не
                сказали, что произошло на объекте, — площадку он в этот момент не видит. */}
              <Form.Item
                name="reason"
                label="Причина"
                rules={[{ required: true, message: 'Укажите причину' }]}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Например: работы на фундаменте закончены, техника больше не нужна"
                />
              </Form.Item>

              <Typography.Text type="secondary">
                {approvesOwn
                  ? 'Срок заявки изменится сразу — вы её и визируете.'
                  : 'Запрос уйдёт на визу руководителя строительства; до визы срок заявки прежний.'}
              </Typography.Text>
            </FormGrid.Full>
          </FormGrid>
        </Form>
      )}
    </FormModal>
  );
}
