import { useCallback, useState } from 'react';
import { App, Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { FileLinkList } from '../../components/FileLinks';
import { filesApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';

/** Файл, уже загруженный формой: он ничей, пока заявка не заведена. */
export interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Фото неисправности и прочие вложения при заведении заявки (план модернизации, Р50).
 *
 * Обязательным вложение не делается: «не включается» и «не видит сеть» не фотографируются, и
 * требование обернулось бы снимком стены ради кнопки «Отправить». Отдельного вида файла у фото
 * тоже нет — вид заводится тогда, когда по нему собирают срез (акт и счёт собирают очередь
 * «Ожидаются документы»), а среза «заявки без фото» никто не спрашивал.
 *
 * Файлы загружаются до создания заявки и до неё же остаются ничьими: снятый файл сносится сразу,
 * иначе в хранилище копится мусор от передуманных заявок.
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
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        Фото неисправности
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

/**
 * Вложения формы заявки: загрузка, снятие и список идентификаторов для тела запроса.
 *
 * Хуком, а не состоянием формы: файл уходит на сервер **до** заявки и до неё же остаётся ничьим —
 * это своя маленькая жизнь со своим отказом («не загрузилось») и своей уборкой (снятый файл
 * сносится сразу, иначе в хранилище копится мусор от передуманных заявок). Форме от неё нужны три
 * значения и две функции, и держать их у себя она не обязана.
 */
export function useServiceRequestAttachments(): {
  files: UploadedFile[];
  uploading: boolean;
  upload: (file: File) => Promise<void>;
  remove: (file: UploadedFile) => void;
  /** Идентификаторы для тела заведения: заявка забирает файлы себе. */
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

  const remove = useCallback((file: UploadedFile) => {
    const id = file.id;
    setFiles((prev) => prev.filter((f) => f.id !== id));
    // Файл ещё ничей: заявки, к которой он привязан, нет — сносим его сразу.
    void filesApi.remove(id).catch(() => undefined);
  }, []);

  return {
    files,
    uploading,
    upload,
    remove,
    ids: files.map((file) => file.id),
    reset: useCallback(() => setFiles([]), []),
  };
}
