import { DatePicker, Form, Input } from 'antd';
import { FormGrid } from '@shared/ui';

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** Receipt header is kept inside the parent Form so validation and draft restoration share its state. */
export function ReceiptHeaderFields({ today, busy }: { today: string; busy: boolean }) {
  return (
    <FormGrid>
      <Form.Item
        name="purchasedOn"
        label="Дата чека"
        rules={[{ required: true, message: 'Укажите дату чека' }]}
        extra="Дата документа: по ней считаются суммы и периоды"
      >
        <DatePicker
          format={SHOWN_DATE}
          style={{ width: '100%' }}
          allowClear={false}
          disabled={busy}
          // The API uses the same Moscow date boundary; future dates cannot be saved.
          disabledDate={(date) => date.format(DATE) > today}
        />
      </Form.Item>

      <Form.Item
        name="documentNumber"
        label="Номер чека"
        rules={[{ required: true, message: 'Номер чека обязателен' }]}
        extra="Номер с бумаги; своей нумерации у портала нет"
      >
        <Input maxLength={100} placeholder="0001" disabled={busy} />
      </Form.Item>

      <Form.Item
        name="sellerName"
        label="Продавец"
        extra="Необязательно: на ленте название бывает нечитаемо"
      >
        <Input maxLength={200} placeholder="Автозапчасти на Ленина" disabled={busy} />
      </Form.Item>

      <FormGrid.Full>
        <Form.Item name="note" label="Примечание">
          <Input.TextArea rows={2} maxLength={1000} showCount disabled={busy} />
        </Form.Item>
      </FormGrid.Full>
    </FormGrid>
  );
}
