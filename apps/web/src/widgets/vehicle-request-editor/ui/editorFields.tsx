import { useState } from 'react';
import { App, Button, Form, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type {
  VehicleClassificationGroup,
  VehicleClassificationOption,
} from '@entities/vehicle-type';
import { FileLinkList, filesApi } from '@entities/file';
import { errorMessage } from '@shared/lib';
import { AutoSelect } from '@shared/ui';

const FILE_MAX_COUNT = 20;
const FILE_MAX_SIZE = 52_428_800;

export interface EditorFile {
  contentType: string;
  filename: string;
  id: string;
  isNew: boolean;
  size: number;
}

/** Tracks uploaded and detached files until the request command commits their identifiers. */
export function useFileEditor() {
  const { message } = App.useApp();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const reset = (initial: EditorFile[] = []) => {
    setFiles(initial);
    setRemovedIds([]);
  };
  const upload = async (file: File) => {
    if (files.length >= FILE_MAX_COUNT) {
      message.error(`Не более ${FILE_MAX_COUNT} файлов`);
      return;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.error('Файл больше 50 МБ');
      return;
    }
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      setFiles((current) => [
        ...current,
        {
          id: dto.id,
          filename: dto.filename,
          contentType: dto.contentType,
          size: dto.size,
          isNew: true,
        },
      ]);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string) => {
    const file = files.find((item) => item.id === id);
    setFiles((current) => current.filter((item) => item.id !== id));
    if (!file) return;
    if (file.isNew) void filesApi.remove(id).catch(() => undefined);
    else setRemovedIds((current) => [...current, id]);
  };
  const newFileIds = () => files.filter((file) => file.isNew).map((file) => file.id);

  return { files, removedIds, uploading, reset, upload, remove, newFileIds };
}

export type FileEditorController = ReturnType<typeof useFileEditor>;

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

/** One classification position: a category, or the type itself when it has no categories. */
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
