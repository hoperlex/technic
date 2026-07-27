import { useState } from 'react';
import { App, Button, Dropdown, Form, List, Popover, Select, Tag, Typography, Upload } from 'antd';
import { DownOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  type FileDto,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  requestStatusTransitions,
} from '@technic/contracts';
import { filesApi, objectsApi, vehicleKindsApi, vehicleTypesApi } from '../../api/resources';
import { errorMessage, formatBytes } from '../../utils/format';

export const FILE_MAX_COUNT = 20;
export const FILE_MAX_SIZE = 52_428_800; // 50 МБ

export interface EditorFile {
  id: string;
  filename: string;
  size: number;
  isNew: boolean;
}

/** Опции активных объектов для Select (грузятся разом, pageSize=500). */
export function useObjectOptions() {
  const { data } = useQuery({
    queryKey: ['objects', 'for-select'],
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return (data?.items ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }));
}

/** Редактор прикреплённых файлов (загрузка в S3 + список add/remove). */
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
      setFiles((p) => [...p, { id: dto.id, filename: dto.filename, size: dto.size, isNew: true }]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    setFiles((p) => p.filter((x) => x.id !== id));
    if (!f) return;
    if (f.isNew) void filesApi.remove(id).catch(() => undefined);
    else setRemovedIds((p) => [...p, id]);
  };
  const newFileIds = () => files.filter((f) => f.isNew).map((f) => f.id);

  return { files, removedIds, uploading, reset, upload, remove, newFileIds };
}

export function FileEditor({ editor }: { editor: ReturnType<typeof useFileEditor> }) {
  return (
    <div>
      <Upload
        multiple
        showUploadList={false}
        beforeUpload={(f) => {
          void editor.upload(f);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={editor.uploading}>
          Прикрепить файлы
        </Button>
      </Upload>
      <List
        size="small"
        style={{ marginTop: 8 }}
        dataSource={editor.files}
        locale={{ emptyText: 'Нет файлов' }}
        renderItem={(f) => (
          <List.Item
            actions={[
              <Button type="link" danger size="small" key="d" onClick={() => editor.remove(f.id)}>
                Удалить
              </Button>,
            ]}
          >
            <span style={{ marginRight: 8 }}>{f.filename}</span>
            <Typography.Text type="secondary">{formatBytes(f.size)}</Typography.Text>
          </List.Item>
        )}
      />
    </div>
  );
}

/** Ячейка статуса: дропдаун переходов (для управляющих ролей) либо тег. */
export function StatusCell({
  status,
  deleted,
  canChange,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  canChange: boolean;
  pending: boolean;
  onChange: (s: RequestStatus) => void;
}) {
  const transitions = requestStatusTransitions[status];
  const tag = <Tag color={requestStatusColors[status]}>{requestStatusLabels[status]}</Tag>;
  if (!canChange || deleted || transitions.length === 0) return tag;
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: transitions.map((s) => ({ key: s, label: requestStatusLabels[s] })),
        onClick: ({ key }) => onChange(key as RequestStatus),
      }}
    >
      <Button size="small" type="text" loading={pending}>
        {tag}
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}

/** Ячейка файлов: поповер со списком и скачиванием. */
export function FilesCell({ files }: { files: FileDto[] }) {
  if (files.length === 0) return <span>—</span>;
  return (
    <Popover
      content={
        <List
          size="small"
          dataSource={files}
          renderItem={(f) => (
            <List.Item
              actions={[
                <Button
                  type="link"
                  size="small"
                  key="dl"
                  onClick={() => void filesApi.download(f.id)}
                >
                  Скачать
                </Button>,
              ]}
            >
              {f.filename}
            </List.Item>
          )}
        />
      }
    >
      <a>{files.length} файл(ов)</a>
    </Popover>
  );
}

/**
 * Выбор типа ТС (плоская модель, ADR 0005). Активные типы фильтруются по виду
 * вкладки (kindCode). В API уходит vehicleTypeId.
 */
export function VehicleTypeSelect({ kindCode }: { kindCode: string }) {
  const { data: kindsData } = useQuery({
    queryKey: ['vehicle-kinds'],
    queryFn: () => vehicleKindsApi.list({ pageSize: 500 }),
  });
  const kindId = kindsData?.items.find((k) => k.code === kindCode)?.id;

  const { data: typesData, isFetching } = useQuery({
    queryKey: ['vehicle-types', 'flat', kindId],
    queryFn: () =>
      vehicleTypesApi.list({
        kindId,
        isActive: 'true',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    enabled: !!kindId,
  });
  const typeOptions = (typesData?.items ?? []).map((t) => ({ value: t.id, label: t.name }));

  return (
    <Form.Item
      name="vehicleTypeId"
      label="Тип ТС"
      rules={[{ required: true, message: 'Выберите тип' }]}
    >
      <Select
        options={typeOptions}
        showSearch
        optionFilterProp="label"
        loading={isFetching}
        placeholder="Выберите тип"
      />
    </Form.Item>
  );
}
