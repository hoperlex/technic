import { useState } from 'react';
import { App, Button, Dropdown, Form, Select, Tag, Tooltip, Upload } from 'antd';
import { DownOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  allowedStatusTransitions,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
} from '@technic/contracts';
import { filesApi, objectsApi, vehicleTypesApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

export const FILE_MAX_COUNT = 20;
export const FILE_MAX_SIZE = 52_428_800; // 50 МБ

/**
 * Дата без времени (`YYYY-MM-DD`) — как есть, без пересчёта часовых поясов: часа в ней нет,
 * а перевод в МСК из браузера восточнее Москвы сдвинул бы срок спецтехники на день назад.
 */
export function formatDateOnly(value: string): string {
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

export interface EditorFile {
  id: string;
  filename: string;
  /** Нужен ссылке в списке: фото и PDF открываются окном просмотра, остальное скачивается. */
  contentType: string;
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
      setFiles((p) => [
        ...p,
        {
          id: dto.id,
          filename: dto.filename,
          contentType: dto.contentType,
          size: dto.size,
          isNew: true,
        },
      ]);
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
      <div style={{ marginTop: 8 }}>
        <FileLinkList
          files={editor.files}
          emptyText="Нет файлов"
          onRemove={(f) => editor.remove(f.id)}
        />
      </div>
    </div>
  );
}

/** Ячейка статуса: дропдаун доступных роли переходов либо тег. */
export function StatusCell({
  status,
  deleted,
  cancelReason,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  /** Причина отмены — подсказкой на теге (колонки под неё в таблице нет). */
  cancelReason?: string | null;
  pending: boolean;
  onChange: (s: RequestStatus) => void;
}) {
  const { user } = useAuth();
  // Линейный цикл доступен ведущим заявки ролям, откаты закрытых заявок — только админу.
  const transitions = user?.role ? allowedStatusTransitions(status, user.role) : [];
  const plain = <Tag color={requestStatusColors[status]}>{requestStatusLabels[status]}</Tag>;
  const tag = cancelReason ? (
    <Tooltip title={`Причина отмены: ${cancelReason}`}>{plain}</Tooltip>
  ) : (
    plain
  );
  if (deleted || transitions.length === 0) return tag;
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

/** Типы ТС одного вида — группа в Select. `kindCode` нужен, чтобы сузить список типом заявки. */
export interface VehicleTypeGroup {
  label: string;
  kindCode: string;
  options: { value: string; label: string }[];
}

/**
 * Все активные типы ТС (плоская модель, ADR 0005), сгруппированные по виду.
 *
 * Вид ТС не задаёт тип заявки — его выбирают в форме явно: техникой любого вида работают
 * на объекте, а грузоперевозку выполняют только грузовым видом
 * (`isVehicleKindAllowedForRequest`).
 */
export function useVehicleTypes() {
  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-types', 'flat', 'all-kinds'],
    queryFn: () =>
      vehicleTypesApi.list({
        isActive: 'true',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const items = data?.items ?? [];

  const kindByTypeId = new Map(items.map((t) => [t.id, t.kindCode]));
  const groups: VehicleTypeGroup[] = [];
  for (const t of items) {
    let group = groups.find((g) => g.kindCode === t.kindCode);
    if (!group) {
      group = { label: t.kindName, kindCode: t.kindCode, options: [] };
      groups.push(group);
    }
    group.options.push({ value: t.id, label: t.name });
  }

  return { kindByTypeId, groups, loading: isFetching };
}

/**
 * Выбор типа ТС: список сгруппирован по виду, в API уходит vehicleTypeId. Набор групп сужен
 * типом заявки, поэтому до его выбора поле недоступно.
 */
export function VehicleTypeSelect({
  groups,
  loading,
  disabled,
  placeholder = 'Выберите тип',
}: {
  groups: VehicleTypeGroup[];
  loading: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Form.Item
      name="vehicleTypeId"
      label="Тип ТС"
      tooltip="Список сужен типом заявки: грузоперевозку выполняет только грузовая техника"
      rules={[{ required: true, message: 'Выберите тип' }]}
    >
      <Select
        options={groups}
        showSearch
        optionFilterProp="label"
        loading={loading}
        disabled={disabled}
        placeholder={placeholder}
      />
    </Form.Item>
  );
}
