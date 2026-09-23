import { App, Button, Space, Typography, Upload } from 'antd';
import { CameraOutlined, UploadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { type FileDto, MAX_TICKETS_PER_REQUEST, type WasteRequestDto } from '@technic/contracts';
import { FILE_MAX_SIZE } from '@shared/config';
import { useIsMobile } from '@shared/lib';
import { filesApi } from '@entities/file';
import { FileLinkList } from '../../../components/FileLinks';
import { errorMessage } from '../../../utils/format';

/**
 * Догрузка талонов к выполненной заявке (ADR 0189): бумага, не поспевшая к закрытию, — талон
 * второй ходки, весовая квитанция, подписанный на площадке оборот.
 *
 * Файлы уезжают в хранилище сразу, а к заявке привязываются кнопкой: пока их не отправили, список
 * правится — ошибочный скан снимается, а не остаётся приложенным навсегда (талон с заявки не
 * откалывают: ADR 0155 знает лишь «это не талон» в разборе). Не дошедшие до заявки файлы
 * удаляются, иначе повиснут в хранилище ничьими — тем же порядком, что в окне закрытия.
 */
export function AddTicketsBlock({
  request,
  onAdd,
  adding,
}: {
  request: WasteRequestDto;
  onAdd: (r: WasteRequestDto, ticketFileIds: string[]) => void;
  adding?: boolean;
}) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [pending, setPending] = useState<FileDto[]>([]);
  const [uploading, setUploading] = useState(false);
  // Отправленное окно переоткрывают на соседней заявке, а список обновляется после успеха —
  // черновик следует за самой заявкой и за её талонами: иначе отправленные файлы остались бы
  // в «ждут отправки» вторым экземпляром.
  useEffect(() => setPending([]), [request.id, request.tickets.length]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setPending((prev) => [...prev, uploaded]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  // Предел тот же, что у закрытия, и считается так же — по бумаге, уже числящейся за заявкой:
  // сервер проверяет его тем же числом (ADR 0189), и разойтись они не должны.
  const beforeUpload = (file: File) => {
    if (request.tickets.length + pending.length >= MAX_TICKETS_PER_REQUEST) {
      message.warning(`Не более ${MAX_TICKETS_PER_REQUEST} талонов`);
      return Upload.LIST_IGNORE;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.warning('Файл больше 50 МБ');
      return Upload.LIST_IGNORE;
    }
    void upload(file);
    return false;
  };

  const discard = (f: FileDto) => {
    void filesApi.remove(f.id).catch(() => {});
    setPending((prev) => prev.filter((t) => t.id !== f.id));
  };

  return (
    <div style={{ marginTop: 12 }}>
      <Space size={8} wrap>
        {/* Снимок камерой — только на телефоне (ADR 0030): доложенный талон фотографируют там же,
            где и основной, — на площадке. */}
        {isMobile && (
          <Upload
            showUploadList={false}
            accept="image/*"
            capture="environment"
            beforeUpload={beforeUpload}
          >
            <Button icon={<CameraOutlined />} loading={uploading}>
              Снять камерой
            </Button>
          </Upload>
        )}
        <Upload multiple showUploadList={false} beforeUpload={beforeUpload}>
          <Button icon={<UploadOutlined />} loading={uploading}>
            Добавить талон
          </Button>
        </Upload>
        {pending.length > 0 && (
          <Button
            type="primary"
            loading={adding}
            onClick={() => onAdd(request, pending.map((f) => f.id))}
          >
            Приложить к заявке ({pending.length})
          </Button>
        )}
      </Space>
      {pending.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Ждут отправки
          </Typography.Text>
          <FileLinkList files={pending} maxNameWidth={420} onRemove={discard} />
        </div>
      )}
      {/* Факт закрытия доложенная бумага не трогает, и сказать об этом надо до нажатия: объём
          правят повторным закрытием (ADR 0035), а расхождение с талонами посчитает сверка. */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
        Вывезенное в закрытии не меняется: талоны дополняют бумагу, а не переписывают факт.
      </Typography.Paragraph>
    </div>
  );
}
