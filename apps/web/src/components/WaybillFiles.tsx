import { App, Button, Popover, Space, Typography, Upload } from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FileDto } from '@technic/contracts';
import { filesApi, waybillsApi } from '../api/resources';
import { FILE_MAX_COUNT, FILE_MAX_SIZE } from '@shared/config';
import { FileLinkList } from './FileLinks';
import { errorMessage } from '../utils/format';

/**
 * Вложения путевого листа (миграция 0087).
 *
 * Лист уходит на объект бумагой и возвращается заполненным: у ЭСМ-2 заказчик пишет на обороте
 * часы, простои и стоимость машино-часа и ставит штамп, у 4-П — отметки о выполнении. Портал
 * этих значений не разбирает: журнал учёта отвечает, чем кончился выданный номер, — и скан
 * подшивается к номеру.
 *
 * Файл крепится сразу, а не «по кнопке Сохранить»: журнал — не форма, черновика у строки нет.
 * Поэтому загрузка и открепление идут отдельными запросами, а список перечитывается страницей.
 */
export function WaybillFilesCell({
  waybillId,
  files,
  canEdit,
}: {
  waybillId: string;
  files: FileDto[];
  /** Право `waybills.files`: смотреть журнал может и тот, кто документы к нему не подшивает. */
  canEdit: boolean;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['waybills'] });

  const detach = useMutation({
    mutationFn: (fileId: string) => waybillsApi.detachFile(waybillId, fileId),
    onSuccess: () => {
      message.success('Файл откреплён');
      void refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

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
      // Файл сначала уезжает в хранилище и только потом привязывается к листу — тем же порядком,
      // что и вложения заявок: сервер видит идентификатор уже загруженного объекта.
      const dto = await filesApi.upload(file);
      await waybillsApi.attachFiles(waybillId, [dto.id]);
      void refresh();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  // Пустая ячейка без права правки — прочерк: кнопка, за которой ничего нет и ничего не будет,
  // только загромождает строку.
  if (files.length === 0 && !canEdit) return <>—</>;

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      content={
        <Space direction="vertical" style={{ minWidth: 280 }}>
          <FileLinkList
            files={files}
            maxNameWidth={220}
            emptyText="Файлы не прикреплены"
            onRemove={canEdit ? (f) => detach.mutate(f.id) : undefined}
          />
          {canEdit && (
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={(f) => {
                void upload(f);
                return false;
              }}
            >
              <Button size="small" icon={<UploadOutlined />} loading={uploading}>
                Прикрепить
              </Button>
            </Upload>
          )}
        </Space>
      }
    >
      <Button size="small" icon={<PaperClipOutlined />}>
        {files.length > 0 ? files.length : <Typography.Text type="secondary">нет</Typography.Text>}
      </Button>
    </Popover>
  );
}
