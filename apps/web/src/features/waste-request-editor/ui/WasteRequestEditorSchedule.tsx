import { App, Button, DatePicker, Form, Input, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { WasteRequestDto } from '@technic/contracts';
import { FileLinkList } from '@entities/file';
import { isBeforeMinRequestDate, isPastDate } from '@entities/waste-request';
import { ResponsibleFields, TimeInput, optionalWorkTimeRule } from '@entities/request';
import { PhoneInput } from '@entities/user-account';
import { FILE_MAX_COUNT, FILE_MAX_SIZE } from '@shared/config';
import { useIsMobile } from '@shared/lib';
import { FormGrid } from '@shared/ui';
import type { WasteRequestEditorFile } from '../model/types';

interface Props {
  files: WasteRequestEditorFile[];
  onRemoveFile: (file: WasteRequestEditorFile) => void;
  onUpload: (file: File) => void;
  record: WasteRequestDto | null;
  uploading: boolean;
}

/** Contact, schedule and attachments form one stable lower section of the editor. */
export function WasteRequestEditorSchedule({
  files,
  onRemoveFile,
  onUpload,
  record,
  uploading,
}: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  return (
    <>
      <Form.Item
        name="deliveryDate"
        label="Дата доставки"
        rules={[{ required: true, message: 'Укажите дату' }]}
      >
        {/* A new request starts no earlier than today in Moscow time; an existing one may move
            freely as long as it does not go into the past. */}
        <DatePicker
          format="DD.MM.YYYY"
          style={{ width: '100%' }}
          placeholder="дд.мм.гггг"
          // On a phone the keyboard opens with the calendar and hides it: dates are picked there,
          // not typed.
          inputReadOnly={isMobile}
          disabledDate={record ? isPastDate : isBeforeMinRequestDate}
        />
      </Form.Item>
      <Form.Item
        name="deliveryTime"
        label="Время"
        tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
        rules={[optionalWorkTimeRule]}
      >
        <TimeInput />
      </Form.Item>
      {/* Who receives the truck on site: the operator drives to a person, not to an address, and
          without a contact the drop point and access are sorted out only on arrival. */}
      <FormGrid.Full>
        <ResponsibleFields
          nameField="responsibleName"
          phoneField="responsiblePhone"
          nameLabel="Ответственный на площадке"
          phoneLabel="Контактный телефон"
          phoneInput={PhoneInput}
        />
        {/* The site comment only: the executor writes its own line in the request card (ADR 0053),
            and the request form never touches it. */}
        <Form.Item name="comment" label="Комментарий площадки">
          <Input.TextArea rows={3} maxLength={2000} showCount />
        </Form.Item>
      </FormGrid.Full>
      <FormGrid.Full>
        <Form.Item label={`Файлы (до ${FILE_MAX_COUNT}, до 50 МБ каждый)`}>
          <Upload
            multiple
            showUploadList={false}
            beforeUpload={(file) => {
              if (files.length >= FILE_MAX_COUNT) {
                message.warning(`Не более ${FILE_MAX_COUNT} файлов`);
                return Upload.LIST_IGNORE;
              }
              if (file.size > FILE_MAX_SIZE) {
                message.warning('Файл больше 50 МБ');
                return Upload.LIST_IGNORE;
              }
              onUpload(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              Прикрепить файл
            </Button>
          </Upload>
          <div style={{ marginTop: 8 }}>
            <FileLinkList
              files={files}
              emptyText="Файлы не прикреплены"
              maxNameWidth={300}
              onRemove={onRemoveFile}
            />
          </div>
        </Form.Item>
      </FormGrid.Full>
    </>
  );
}
