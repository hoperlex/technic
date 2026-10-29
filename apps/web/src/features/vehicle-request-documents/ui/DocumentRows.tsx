import { useRef, type CSSProperties } from 'react';
import { AutoComplete, Button, DatePicker, Form, type FormRule } from 'antd';
import { DeleteOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { VEHICLE_REQUEST_DOCUMENT_TYPE_MAX } from '@technic/contracts';
import { FILE_MAX_SIZE } from '@shared/config';
import { useIsMobile } from '@shared/lib';

export interface DocumentRow {
  file?: File;
  docType?: string;
  docDate?: Dayjs;
}

/** A row with nothing chosen: what the window opens with and what «Прикрепить ещё» appends. */
export const EMPTY_DOCUMENT_ROW: DocumentRow = {};

/**
 * The rules sit on the fields, not in the submit handler: a fault is then named under its own row
 * and the scroll of ADR 0094 lands on that row. The size is a rule too, so a file over the limit
 * stays in the row with the reason under it instead of vanishing from the picker.
 */
const fileRule: FormRule = {
  validator: async (_rule, file?: File) => {
    if (!file) throw new Error('Выберите файл');
    if (file.size > FILE_MAX_SIZE) throw new Error('Файл больше 50 МБ');
  },
};
const typeRule: FormRule = { required: true, whitespace: true, message: 'Укажите тип документа' };
const dateRule: FormRule = { required: true, message: 'Укажите дату документа' };

const ELLIPSIS: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/**
 * The rows of the window, one document each: file, type and date in a line, the way a table row
 * reads. No column captions — the button, the placeholders and the filled value say what a field is,
 * and the same row stacks on a phone without a caption of its own to carry.
 *
 * The delete column is always reserved, and the button is drawn only while there is more than one
 * row: the window must never be left without a row to fill, and the fields must not jump sideways
 * when the second row appears.
 */
export function DocumentRows({ typeOptions }: { typeOptions: { value: string }[] }) {
  const isMobile = useIsMobile();
  return (
    <Form.List name="rows">
      {(fields, { add, remove }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {fields.map((field, index) => (
            <div
              key={field.key}
              style={
                isMobile
                  ? { display: 'flex', flexDirection: 'column', gap: 8 }
                  : {
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr) 150px 32px',
                      gap: 8,
                      alignItems: 'start',
                    }
              }
            >
              <Form.Item name={[field.name, 'file']} rules={[fileRule]} style={{ marginBottom: 0 }}>
                <FileField label={`Файл, строка ${index + 1}`} />
              </Form.Item>
              <Form.Item
                name={[field.name, 'docType']}
                rules={[typeRule]}
                style={{ marginBottom: 0 }}
              >
                <AutoComplete
                  options={typeOptions}
                  maxLength={VEHICLE_REQUEST_DOCUMENT_TYPE_MAX}
                  placeholder="Тип, например УПД"
                  aria-label={`Тип документа, строка ${index + 1}`}
                  filterOption={(input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                />
              </Form.Item>
              <Form.Item
                name={[field.name, 'docDate']}
                rules={[dateRule]}
                style={{ marginBottom: 0 }}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  format="DD.MM.YYYY"
                  placeholder="Дата"
                  aria-label={`Дата документа, строка ${index + 1}`}
                />
              </Form.Item>
              {fields.length > 1 && (
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`Убрать строку ${index + 1}`}
                  onClick={() => remove(field.name)}
                >
                  {isMobile ? 'Убрать' : null}
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => add({ ...EMPTY_DOCUMENT_ROW })}
            >
              Прикрепить ещё документ
            </Button>
          </div>
        </div>
      )}
    </Form.List>
  );
}

/**
 * The file of a row as a form control: `Form.Item` hands it `value`, `onChange` and `id`. The
 * button shows the chosen name and cuts a long one, so a row keeps its height; the real input is
 * hidden, because the picker widget would not let the button fill its column. The `id` goes on the
 * wrapper — `scrollToField` finds a control without an input ref by it.
 */
function FileField({
  id,
  value,
  onChange,
  label,
}: {
  id?: string;
  value?: File;
  onChange?: (file: File) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div id={id} style={{ minWidth: 0 }}>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          // Cleared so the same file can be chosen again after a row was fixed or emptied.
          event.target.value = '';
          if (picked) onChange?.(picked);
        }}
      />
      <Button
        block
        icon={<UploadOutlined />}
        title={value?.name}
        style={{ justifyContent: 'flex-start' }}
        onClick={() => input.current?.click()}
      >
        <span style={ELLIPSIS}>{value ? value.name : 'Выбрать файл'}</span>
      </Button>
    </div>
  );
}
