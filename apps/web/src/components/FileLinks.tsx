import { App, Button, List, Modal, Popover, Tooltip, Typography } from 'antd';
import { DownloadOutlined, EyeOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { isInlineViewable } from '@technic/contracts';
import { filesApi } from '../api/resources';
import { errorMessage, formatBytes } from '../utils/format';

/**
 * Минимум, которым описывается прикреплённый файл. `contentType` есть не везде (черновики
 * формы хранят только имя и размер) — без него файл считается нечитаемым в браузере и просто
 * скачивается.
 */
export interface FileRef {
  id: string;
  filename: string;
  contentType?: string;
  size?: number;
}

/**
 * Имя файла ссылкой. Фото талона и PDF открываются во вкладке — их смотрят, а не хранят;
 * остальные типы скачиваются: показать их браузер всё равно не может.
 */
export function FileLink({ file, maxWidth = 320 }: { file: FileRef; maxWidth?: number }) {
  const { message } = App.useApp();
  const inline = isInlineViewable(file.contentType ?? '');
  const open = async () => {
    try {
      await (inline ? filesApi.openInline(file.id) : filesApi.download(file.id));
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <Tooltip title={inline ? `Открыть «${file.filename}»` : `Скачать «${file.filename}»`}>
      <Typography.Link ellipsis style={{ maxWidth }} onClick={() => void open()}>
        {file.filename}
      </Typography.Link>
    </Tooltip>
  );
}

/** Кнопка «Скачать» рядом со ссылкой: просмотр во вкладке файл на диск не сохраняет. */
export function FileDownloadButton({ file }: { file: FileRef }) {
  const { message } = App.useApp();
  const download = async () => {
    try {
      await filesApi.download(file.id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <Tooltip title="Скачать">
      <Button
        type="text"
        size="small"
        icon={<DownloadOutlined />}
        aria-label={`Скачать ${file.filename}`}
        onClick={() => void download()}
      />
    </Tooltip>
  );
}

/**
 * Кнопка «Посмотреть»: открывает файл во вкладке. У типов, которые браузер не покажет (архив,
 * документ), она недоступна — «просмотр», молча сохраняющий файл на диск, вводил бы в заблуждение.
 */
export function FileViewButton({ file }: { file: FileRef }) {
  const { message } = App.useApp();
  const inline = isInlineViewable(file.contentType ?? '');
  const open = async () => {
    try {
      await filesApi.openInline(file.id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <Tooltip title={inline ? 'Посмотреть' : 'Браузер не покажет этот тип — скачайте файл'}>
      {/* Отключённая кнопка событий мыши не получает — подсказку держит обёртка. */}
      <span>
        <Button
          type="text"
          size="small"
          icon={<EyeOutlined />}
          disabled={!inline}
          aria-label={`Посмотреть ${file.filename}`}
          onClick={() => void open()}
        />
      </span>
    </Tooltip>
  );
}

interface FileListProps<T extends FileRef> {
  files: T[];
  /** Кнопка «Удалить» у каждой строки; без него список только на чтение. */
  onRemove?: (file: T) => void;
  emptyText?: string;
  maxNameWidth?: number;
  /** Иконка «Посмотреть» рядом со скачиванием — для окон, где вложения разбирают, а не правят. */
  showView?: boolean;
}

/** Список вложений: имя ссылкой, размер и действия. Общий для заявок всех модулей. */
export function FileLinkList<T extends FileRef>({
  files,
  onRemove,
  emptyText,
  maxNameWidth = 320,
  showView = false,
}: FileListProps<T>) {
  return (
    <List
      size="small"
      dataSource={files}
      locale={emptyText ? { emptyText } : undefined}
      renderItem={(f) => (
        <List.Item
          actions={[
            ...(showView ? [<FileViewButton key="view" file={f} />] : []),
            <FileDownloadButton key="dl" file={f} />,
            ...(onRemove
              ? [
                  <Button key="rm" type="link" danger size="small" onClick={() => onRemove(f)}>
                    Удалить
                  </Button>,
                ]
              : []),
          ]}
        >
          <FileLink file={f} maxWidth={maxNameWidth} />
          {f.size != null && (
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              {formatBytes(f.size)}
            </Typography.Text>
          )}
        </List.Item>
      )}
    />
  );
}

/**
 * Окно со списком вложений: имя ссылкой, размер, просмотр и скачивание. Нужно там, где файлы
 * приложены не к самой записи, а к её части (талоны машины): в строку они не помещаются, а
 * разбирают их по одному — открыть, посмотреть, при надобности сохранить.
 */
export function FileListModal({
  title,
  files,
  open,
  onClose,
}: {
  title: string;
  files: FileRef[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      centered
      width={520}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <FileLinkList files={files} showView emptyText="Файлы не прикреплены" maxNameWidth={320} />
    </Modal>
  );
}

/**
 * Вложения кнопкой со счётчиком: по клику — окно со списком. Пустой список кнопки не заслуживает
 * и показывается текстом, иначе строка обрастала бы кнопками, за которыми ничего нет.
 */
export function FilesButton({
  files,
  title,
  label,
  emptyText = '—',
}: {
  files: FileRef[];
  /** Заголовок окна: чьи это вложения («Талоны — Самосвал 20 м³»). */
  title: string;
  /** Подпись кнопки; по умолчанию — число файлов. */
  label?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return <Typography.Text type="secondary">{emptyText}</Typography.Text>;
  return (
    <>
      <Button
        size="small"
        icon={<PaperClipOutlined />}
        // Кнопка живёт и в строках, у которых свой обработчик клика (раскрытие истории).
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {label ?? files.length}
      </Button>
      <FileListModal title={title} files={files} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Ячейка таблицы: скрепка с числом файлов, по клику — список со ссылками. */
export function FilesCell({ files }: { files: FileRef[] }) {
  if (files.length === 0) return <>—</>;
  return (
    <Popover
      trigger="click"
      content={
        <div style={{ minWidth: 260 }}>
          <FileLinkList files={files} maxNameWidth={220} />
        </div>
      }
    >
      <Button size="small" icon={<PaperClipOutlined />}>
        {files.length}
      </Button>
    </Popover>
  );
}
