import { useCallback, useState } from 'react';
import { App, Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { FileLinkList, filesApi } from '@entities/file';
import { serviceRequestErrorMessage as errorMessage } from '@entities/service-request';
import { isFileInPendingCreate, PENDING_CREATE_FILE_MESSAGE } from '@shared/lib';

/** A completed upload remains unowned until a request accepts its ID. */
export interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Attachments are optional because many service problems have nothing useful to photograph.
 * An unowned upload is deleted when removed, except while an uncertain create still refers to it.
 */
export function ServiceRequestAttachments({
  files,
  uploading,
  onUpload,
  onRemove,
}: {
  files: UploadedFile[];
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemove: (file: UploadedFile) => void;
}) {
  return (
    <div>
      {/* Repair and consumables share this field, and invoices and warranty scans belong here too. */}
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        Фото и документы
      </Typography.Text>
      <Upload
        multiple
        showUploadList={false}
        beforeUpload={(file) => {
          onUpload(file);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploading}>
          Прикрепить фото и документы
        </Button>
      </Upload>
      <div style={{ marginTop: 8 }}>
        <FileLinkList files={files} emptyText="Файлов нет" onRemove={onRemove} />
      </div>
    </div>
  );
}

/** Uploads have their own failure and cleanup cycle before the request owns them. */
export function useServiceRequestAttachments(attempt?: { body: unknown }): {
  files: UploadedFile[];
  uploading: boolean;
  upload: (file: File) => Promise<void>;
  remove: (file: UploadedFile) => void;
  /** The create command claims these completed uploads. */
  ids: string[];
  reset: () => void;
} {
  const { message } = App.useApp();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const dto = await filesApi.upload(file);
        setFiles((prev) => [
          ...prev,
          { id: dto.id, filename: dto.filename, contentType: dto.contentType, size: dto.size },
        ]);
      } catch (e) {
        message.error(errorMessage(e));
      } finally {
        setUploading(false);
      }
    },
    [message],
  );

  const remove = useCallback(
    (file: UploadedFile) => {
      const id = file.id;
      // A pending receipt may still claim its original file ID even after the form has changed.
      if (isFileInPendingCreate(attempt, id)) {
        message.warning(PENDING_CREATE_FILE_MESSAGE);
        return;
      }
      setFiles((prev) => prev.filter((f) => f.id !== id));
      void filesApi.remove(id).catch(() => undefined);
    },
    [attempt, message],
  );

  return {
    files,
    uploading,
    upload,
    remove,
    ids: files.map((file) => file.id),
    reset: useCallback(() => setFiles([]), []),
  };
}
