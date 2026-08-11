import { Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { FileLinkList } from '../../components/FileLinks';

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
