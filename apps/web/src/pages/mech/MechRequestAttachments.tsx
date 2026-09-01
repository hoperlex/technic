import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { FileDto, MechRequestDto } from '@technic/contracts';
import { mechFailureText } from '@entities/mech-request';
import { FileLinkList } from '../../components/FileLinks';
import { filesApi } from '../../api/resources';

/** Файл, загруженный формой прямо сейчас: он ничей, пока заявка его не забрала. */
interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MechAttachments {
  /** Что показать списком: уже прикреплённое минус снятое плюс только что загруженное. */
  shown: (FileDto | UploadedFile)[];
  uploading: boolean;
  upload: (file: File) => Promise<void>;
  remove: (file: { id: string }) => void;
  /** Идентификаторы для тела заведения. */
  ids: string[];
  /** Пара списков для тела правки: что прибавилось и что сняли. */
  patch: { addFileIds: string[]; removeFileIds: string[] };
}

/**
 * Вложения заявки на аренду (Р14): фото площадки, счёт, акт приёма-передачи.
 *
 * Хуком, а не состоянием формы: файл уходит на сервер **до** заявки и до неё же остаётся ничьим —
 * это своя маленькая жизнь со своим отказом («не загрузилось») и своей уборкой.
 *
 * Снятие вложения различается по тому, чей файл. Только что загруженный и передуманный сносится
 * сразу: заявки, к которой он привязан, нет, и в хранилище копился бы мусор. Уже прикреплённый
 * снимается **правкой заявки** — списком `removeFileIds`, — и удаляет его сервер отложенно
 * (`scheduleFilesDeletion`): человек мог снять его по ошибке и приложить обратно. Снести его
 * отсюда напрямую было бы прямой дырой: связь осталась бы, а файла нет.
 */
export function useMechAttachments(request: MechRequestDto | null, open: boolean): MechAttachments {
  const { message } = App.useApp();
  const [added, setAdded] = useState<UploadedFile[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // Окно переоткрывают на соседней заявке: набор прошлой к ней отношения не имеет.
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
      if (added.some((f) => f.id === id)) {
        setAdded((prev) => prev.filter((f) => f.id !== id));
        // Файл ещё ничей: заявки, к которой он привязан, нет — сносим его сразу.
        void filesApi.remove(id).catch(() => undefined);
        return;
      }
      setRemoved((prev) => (prev.includes(id) ? prev : [...prev, id]));
    },
    [added],
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

/**
 * Вложения в форме: кнопка загрузки и список того, что уже приложено.
 *
 * Показывается и при заведении, и при правке — в отличие от соседних модулей, где вложения живут
 * отдельной вкладкой карточки. Причина в том, что видов у файла здесь нет: акт и счёт приходят
 * позже и подшиваются той же правкой, а разделять их на «фото» и «документ» никто не просил.
 */
export function MechRequestAttachments({
  attachments,
  disabled,
}: {
  attachments: MechAttachments;
  /** Правка закрыта состоянием записи: список остаётся видимым, кнопки снятия нет. */
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
