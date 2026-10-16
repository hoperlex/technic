import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { FileDto, MechRequestDto } from '@technic/contracts';
import { mechFailureText } from '@entities/mech-request';
import { FileLinkList, filesApi } from '@entities/file';
import { isFileInPendingCreate, PENDING_CREATE_FILE_MESSAGE } from '@shared/lib';

/** A completed upload remains unowned until a request accepts its ID. */
interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MechAttachments {
  /** Existing attachments after local removals, plus completed uploads. */
  shown: (FileDto | UploadedFile)[];
  uploading: boolean;
  upload: (file: File) => Promise<void>;
  remove: (file: { id: string }) => void;
  /** Completed uploads claimed by the create command. */
  ids: string[];
  /** Attachment changes committed by an edit. */
  patch: { addFileIds: string[]; removeFileIds: string[] };
}

/**
 * A completed upload can be cleaned up immediately until an uncertain create refers to its ID.
 * Existing attachments are detached through request editing so their links and delayed deletion
 * stay consistent; deleting them directly would leave a broken request link.
 */
export function useMechAttachments(
  request: MechRequestDto | null,
  open: boolean,
  attempt?: { body: unknown },
): MechAttachments {
  const { message } = App.useApp();
  const [added, setAdded] = useState<UploadedFile[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // Reopening another request must not inherit the previous opening's file changes.
  useEffect(() => {
    if (!open) return;
    setAdded([]);
    setRemoved([]);
  }, [open, request?.id]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const dto = await filesApi.upload(file);
        setAdded((prev) => [
          ...prev,
          { id: dto.id, filename: dto.filename, contentType: dto.contentType, size: dto.size },
        ]);
      } catch (e) {
        message.error(mechFailureText(e));
      } finally {
        setUploading(false);
      }
    },
    [message],
  );

  const remove = useCallback(
    (file: { id: string }) => {
      const id = file.id;
      // A pending receipt may still claim its original file ID even after the form has changed.
      if (!request && isFileInPendingCreate(attempt, id)) {
        message.warning(PENDING_CREATE_FILE_MESSAGE);
        return;
      }
      if (added.some((f) => f.id === id)) {
        setAdded((prev) => prev.filter((f) => f.id !== id));
        void filesApi.remove(id).catch(() => undefined);
        return;
      }
      setRemoved((prev) => (prev.includes(id) ? prev : [...prev, id]));
    },
    [added, attempt, message, request],
  );

  const shown = useMemo(
    () => [...(request?.files ?? []).filter((f) => !removed.includes(f.id)), ...added],
    [request?.files, removed, added],
  );

  return {
    shown,
    uploading,
    upload,
    remove,
    ids: added.map((f) => f.id),
    patch: { addFileIds: added.map((f) => f.id), removeFileIds: removed },
  };
}

/** Mechanization uses the same attachment field for creation and later invoices or acceptance acts. */
export function MechRequestAttachments({
  attachments,
  disabled,
}: {
  attachments: MechAttachments;
  /** A closed edit scope still shows files without offering removal. */
  disabled?: boolean;
}) {
  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        Файлы
      </Typography.Text>
      {!disabled && (
        <Upload
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            void attachments.upload(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={attachments.uploading}>
            Прикрепить файл
          </Button>
        </Upload>
      )}
      <div style={{ marginTop: 8 }}>
        <FileLinkList
          files={attachments.shown}
          emptyText="Файлов нет"
          onRemove={disabled ? undefined : attachments.remove}
        />
      </div>
    </div>
  );
}
