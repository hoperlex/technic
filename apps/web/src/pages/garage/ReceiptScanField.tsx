import { useState } from 'react';
import { App, Button, Form, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { RECEIPT_MAX_FILES, RECEIPT_NO_FILES_MESSAGE, type ReceiptDraft } from '@technic/contracts';
import { filesApi } from '@entities/file';
import { errorMessage } from '@shared/lib';
import { FileLinkList } from '../../components/FileLinks';
import { ReceiptRecognitionPanel } from './ReceiptRecognitionPanel';

/**
 * Скан чека — первое поле окна «Принять чек» (план `docs/auto-part-receipts-plan.md`, Р6).
 *
 * Вынесено из `AutoPartReceiptFormModal.tsx` по границе предмета: там шапка и строки чека — поля
 * формы, её правила и отправка, — а здесь работа с хранилищем (загрузка, снятие, снос ничейного
 * файла) и чтение скана моделью, к вводу реквизитов не относящееся вовсе. Ратчет качества
 * (`scripts/quality.mjs`) считает строки у окна, и блок тянул его вверх, ничего не добавляя форме.
 *
 * ФАЙЛ ЗДЕСЬ НЕ НЕОБЯЗАТЕЛЬНОЕ ВЛОЖЕНИЕ: **без бумаги чека не существует** (Р6). Запись без скана
 * это ведомость — перепроверить её не по чему, и распознаванию не к чему приложиться. Отсюда
 * поведение крестика у последнего файла: он не прячется, а отказывает словами. Спрятанная кнопка
 * оставляет человека гадать, почему у одного файла крестик есть, а у другого нет.
 *
 * Отказ приходит пометкой поля, а не тостом в углу (ADR 0094): причина встаёт ровно под тем
 * блоком, в котором нажали. То же правило держит и схема на сервере, но услышать его надо до
 * отправки.
 */

/** Скан в форме. `isNew` — загружен в этом окне и до сохранения ничей: снимают его сразу. */
export interface ScanFile {
  id: string;
  filename: string;
  contentType?: string;
  size?: number;
  isNew?: boolean;
}

interface Props {
  files: ScanFile[];
  /** Набор сканов живёт у окна: он уходит в тело сохранения вместе с шапкой и строками. */
  onChange: (next: (prev: ScanFile[]) => ScanFile[]) => void;
  /** Причина под полем: своя проверка окна либо путь `fileIds` из отказа сервера. */
  error?: string;
  onError: (text: string | undefined) => void;
  /** Идёт сохранение: трогать набор сканов в это время нельзя. */
  disabled: boolean;
  /** Есть ли в форме набранное: от этого зависит, спрашивать ли перед заменой строк. */
  formFilled: boolean;
  onApplyDraft: (draft: ReceiptDraft) => void;
}

export function ReceiptScanField({
  files,
  onChange,
  error,
  onError,
  disabled,
  formFilled,
  onApplyDraft,
}: Props) {
  const { message } = App.useApp();
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      onChange((prev) => [...prev, { ...dto, isNew: true }]);
      onError(undefined);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  /**
   * Снятый скан. Загруженный в этом окне сносится сразу — до сохранения он ничей, и в хранилище
   * иначе копится мусор от передуманных чеков; уже подшитый отвяжет сервер.
   */
  const removeFile = (file: ScanFile) => {
    if (files.length === 1) {
      onError(`${RECEIPT_NO_FILES_MESSAGE}: прикрепите новый, а этот снимите после`);
      return;
    }
    onChange((prev) => prev.filter((f) => f.id !== file.id));
    if (file.isNew) void filesApi.remove(file.id).catch(() => undefined);
  };

  const full = disabled || files.length >= RECEIPT_MAX_FILES;

  return (
    <Form.Item
      label="Скан чека"
      required
      validateStatus={error ? 'error' : undefined}
      help={error ?? 'Длинный чек фотографируют в два кадра — сканов может быть несколько'}
    >
      <Upload
        multiple
        showUploadList={false}
        disabled={full}
        beforeUpload={(file) => {
          void upload(file);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploading} disabled={full}>
          Прикрепить скан
        </Button>
      </Upload>
      {files.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <FileLinkList files={files} onRemove={removeFile} />
        </div>
      )}
      {/* Чтение скана моделью (план `docs/auto-part-receipt-ocr-plan.md`): читается ПОСЛЕДНИЙ
          добавленный — тот, который человек только что положил и на который смотрит. */}
      <div style={{ marginTop: 8 }}>
        <ReceiptRecognitionPanel
          fileId={files.at(-1)?.id ?? null}
          formFilled={formFilled}
          disabled={disabled}
          onApply={onApplyDraft}
        />
      </div>
    </Form.Item>
  );
}
