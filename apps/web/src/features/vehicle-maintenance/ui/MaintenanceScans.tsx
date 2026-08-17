import { Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { FileLinkList } from '../../../components/FileLinks';

/**
 * Скан акта в форме записи ТО (Р10). Файлов может не быть вовсе — запись ведут и по бумажному
 * документу, и обязательным вложение не делается.
 *
 * Список **один на подшитое и на только что загруженное**, и это не упрощение оформления. Раньше
 * их было два: свежий файл портал знал целиком (имя, тип, размер), а подшитый приходил одним
 * идентификатором — сочинить ему подпись «Скан 1» было можно, а обещать, что за ней откроется
 * документ, нет. Теперь `VehicleMaintenanceDto.files` несёт имя, тип и размер у обоих, и делить
 * список стало нечем: акт, подшитый неделю назад, открывается тем же нажатием, что и сегодняшний.
 *
 * Разница между ними осталась ровно одна и живёт не здесь, а в обработчике снятия (`isNew`):
 * загруженный в этом окне файл до сохранения ничей и сносится сразу, подшитый отвязывает сервер.
 */

/** Файл формы. `isNew` — загружен в этом окне и до сохранения записи ничей. */
export interface ScanFile {
  id: string;
  filename: string;
  contentType?: string;
  size?: number;
  isNew?: boolean;
}

export function MaintenanceScans({
  files,
  uploading,
  onUpload,
  onRemove,
}: {
  files: ScanFile[];
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemove: (file: ScanFile) => void;
}) {
  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        Скан акта
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
          Прикрепить скан
        </Button>
      </Upload>

      {files.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <FileLinkList files={files} onRemove={onRemove} />
        </div>
      )}

      {files.length === 0 && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          Файлов нет — запись ведут и по бумажному акту
        </Typography.Text>
      )}
    </div>
  );
}
