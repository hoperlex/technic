import { useState } from 'react';
import { App } from 'antd';
import { filesApi } from '@entities/file';
import { errorMessage } from '@shared/lib';

const FILE_MAX_COUNT = 20;
const FILE_MAX_SIZE = 52_428_800;

export interface EditorFile {
  /** Needed by the list link: images and PDFs open in the viewer, other files download. */
  contentType: string;
  filename: string;
  id: string;
  isNew: boolean;
  size: number;
}

/** Tracks uploaded and detached files until the request command commits their identifiers. */
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
      setFiles((current) => [
        ...current,
        {
          id: dto.id,
          filename: dto.filename,
          contentType: dto.contentType,
          size: dto.size,
          isNew: true,
        },
      ]);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string) => {
    const file = files.find((item) => item.id === id);
    setFiles((current) => current.filter((item) => item.id !== id));
    if (!file) return;
    if (file.isNew) void filesApi.remove(id).catch(() => undefined);
    else setRemovedIds((current) => [...current, id]);
  };
  const newFileIds = () => files.filter((file) => file.isNew).map((file) => file.id);

  return { files, removedIds, uploading, reset, upload, remove, newFileIds };
}

export type FileEditorController = ReturnType<typeof useFileEditor>;
