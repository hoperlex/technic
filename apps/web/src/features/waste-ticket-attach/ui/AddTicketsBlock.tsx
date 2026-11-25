import { App, Button, Space, Typography, Upload } from 'antd';
import { CameraOutlined, UploadOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { type FileDto, MAX_TICKETS_PER_REQUEST, type WasteRequestDto } from '@technic/contracts';
import { FILE_MAX_SIZE } from '@shared/config';
import { errorMessage, useIsMobile } from '@shared/lib';
import { FileLinkList, filesApi } from '@entities/file';

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
  /**
   * The opening of this block: it moves on when the card switches to another request and when the
   * card closes. An upload that finishes in a later opening is deleted instead of joining the
   * pending list of the request shown now — it was chosen for another one (snow-removal plan, §3.3).
   */
  const opening = useRef(0);
  useEffect(() => {
    opening.current += 1;
    setPending([]);
    return () => {
      opening.current += 1;
    };
  }, [request.id]);
  // Attached files leave the list as soon as the request lists them as its tickets; the rest stay.
  // A reload after a refusal (409) must not drop uploads the person may still attach or discard.
  useEffect(
    () => setPending((prev) => prev.filter((f) => !request.tickets.some((t) => t.id === f.id))),
    [request.tickets],
  );

  const upload = async (file: File) => {
    const startedIn = opening.current;
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      if (startedIn !== opening.current) {
        void filesApi.remove(uploaded.id).catch(() => {});
        return;
      }
      setPending((prev) => [...prev, uploaded]);
    } catch (e) {
      if (startedIn !== opening.current) return;
      /*
       * No field dictionary here, and that is an answer rather than an omission: the only refusal
       * this screen can get is from the upload itself (`POST /files/upload-session`), whose fields
       * are `filename`, `contentType` and `size` — the browser fills all three from the chosen file.
       * A rejection on them is a portal defect, not a mistake in a form, so the person reporting it
       * needs the server's own word, not a caption; the ticket labels next door name blank fields,
       * and none of them can ever come back from this call.
       */
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
    // The file travels with the attach in flight; deleting it could strip committed paper.
    if (adding) {
      message.warning('Талоны отправляются — дождитесь ответа');
      return;
    }
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
            onClick={() =>
              onAdd(
                request,
                pending.map((f) => f.id),
              )
            }
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
