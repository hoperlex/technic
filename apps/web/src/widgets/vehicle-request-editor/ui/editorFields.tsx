import { Button, Form, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type {
  VehicleClassificationGroup,
  VehicleClassificationOption,
} from '@entities/vehicle-type';
import { FileLinkList } from '@entities/file';
import { AutoSelect } from '@shared/ui';

import type { FileEditorController } from '../model/useFileEditor';

export function FileEditor({ editor }: { editor: FileEditorController }) {
  return (
    <div>
      <Upload
        multiple
        showUploadList={false}
        beforeUpload={(file) => {
          void editor.upload(file);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={editor.uploading}>
          Прикрепить файлы
        </Button>
      </Upload>
      <div style={{ marginTop: 8 }}>
        <FileLinkList
          files={editor.files}
          emptyText="Нет файлов"
          onRemove={(file) => editor.remove(file.id)}
        />
      </div>
    </div>
  );
}

/**
 * Choice of the ordered equipment (ADR 0028): one classifier position — a type category ("Truck
 * cranes, 130 t") or the type itself when it has no specs ("Auger"). The list is grouped by vehicle
 * kind and narrowed by the request type, so the field is disabled until that is chosen. The form
 * holds the position key; the API receives the "type + category" pair.
 *
 * The position's price level (the average rate of its vehicles) is shown on the right only in the
 * open list (`optionRender`): search runs by name and the selected value shows the name too — a
 * price in the closed field would read as an agreed rate, while it is only a reference.
 */
export function VehicleClassificationSelect({
  groups,
  loading,
  disabled,
  placeholder = 'Выберите тип или категорию',
}: {
  disabled?: boolean;
  groups: VehicleClassificationGroup[];
  loading: boolean;
  placeholder?: string;
}) {
  return (
    <Form.Item
      name="classificationKey"
      label="Тип/категория ТС"
      tooltip="У типа с характеристиками выбирают категорию — «Автокран, г/п 130 т»; тип без характеристик выбирается целиком. Список сужен типом заявки: грузоперевозку выполняет только грузовая техника"
      rules={[{ required: true, message: 'Выберите тип или категорию' }]}
    >
      <AutoSelect
        options={groups}
        showSearch
        optionFilterProp="label"
        loading={loading}
        disabled={disabled}
        placeholder={placeholder}
        optionRender={(option) => {
          const hint = (option.data as VehicleClassificationOption).priceHint;
          if (!hint) return option.label;
          return (
            <div className="option-row">
              <span className="option-row__label">{option.label}</span>
              <Typography.Text type="secondary" className="option-row__hint">
                {hint}
              </Typography.Text>
            </div>
          );
        }}
      />
    </Form.Item>
  );
}
