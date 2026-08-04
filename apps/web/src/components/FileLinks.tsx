import { App, Alert, Button, List, Popover, Spin, Tooltip, Typography } from 'antd';
import { DownloadOutlined, EyeOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { isInlineViewable } from '@technic/contracts';
import { filesApi } from '../api/resources';
import { useIsMobile } from '@shared/lib';
import { errorMessage, formatBytes } from '../utils/format';
import { ViewModal } from './ViewModal';

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
 * Просмотр файла окном поверх страницы: содержимое показывается фреймом (PDF, текст) или
 * картинкой прямо в портале. Вкладка для этого не открывается — заявку разбирают, не отрываясь
 * от неё, а вернуться к списку после ухода на домен хранилища было бы лишним шагом.
 *
 * Ссылка на объект подписана и живёт минуты, поэтому запрашивается при открытии окна, а не
 * заранее на весь список вложений.
 */
export function FilePreviewModal({
  file,
  open,
  onClose,
}: {
  file: FileRef;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = (file.contentType ?? '').toLowerCase().startsWith('image/');
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open) {
      // Ссылку не держим закрытым окном: она протухнет, и следующий показ всё равно берёт новую.
      setUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void filesApi
      .downloadUrl(file.id, 'inline')
      .then(({ url: u }) => {
        if (!cancelled) setUrl(u);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, file.id]);

  const download = async () => {
    try {
      await filesApi.download(file.id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <ViewModal
      title={file.filename}
      open={open}
      onClose={onClose}
      width="90vw"
      footer={[
        <Button key="dl" icon={<DownloadOutlined />} onClick={() => void download()}>
          Скачать
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
      // На телефоне окно и так во весь экран: фиксированная высота тела оставила бы под фото
      // полосу в 80% высоты окна, а не экрана.
      bodyStyle={{
        ...(isMobile ? { height: '100%', padding: 8 } : { height: '80vh' }),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {error ? (
        <Alert type="error" message="Не удалось открыть файл" description={error} showIcon />
      ) : !url ? (
        <Spin />
      ) : isImage ? (
        <img
          src={url}
          alt={file.filename}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          onError={() => setError('Файл не загрузился — скачайте его')}
        />
      ) : (
        <iframe
          src={url}
          title={file.filename}
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      )}
    </ViewModal>
  );
}

/**
 * Имя файла ссылкой. Фото талона и PDF открываются окном просмотра — их смотрят, а не хранят;
 * остальные типы скачиваются: показать их браузер всё равно не может.
 */
export function FileLink({ file, maxWidth = 320 }: { file: FileRef; maxWidth?: number }) {
  const { message } = App.useApp();
  const [preview, setPreview] = useState(false);
  const inline = isInlineViewable(file.contentType ?? '');
  // Ширина имени задана в пикселях под колонку десктопа; на телефоне ограничением служит
  // сама строка — 420 px там шире экрана (ADR 0030).
  const isMobile = useIsMobile();
  const open = async () => {
    if (inline) {
      setPreview(true);
      return;
    }
    try {
      await filesApi.download(file.id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <>
      <Tooltip title={inline ? `Открыть «${file.filename}»` : `Скачать «${file.filename}»`}>
        <Typography.Link
          ellipsis
          style={{ maxWidth: isMobile ? '100%' : maxWidth }}
          onClick={() => void open()}
        >
          {file.filename}
        </Typography.Link>
      </Tooltip>
      {inline && <FilePreviewModal file={file} open={preview} onClose={() => setPreview(false)} />}
    </>
  );
}

/** Кнопка «Скачать» рядом со ссылкой: просмотр окном файл на диск не сохраняет. */
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
 * Кнопка «Посмотреть»: открывает файл окном просмотра. У типов, которые браузер не покажет
 * (архив, документ), она недоступна — «просмотр», молча сохраняющий файл на диск, вводил бы
 * в заблуждение.
 */
export function FileViewButton({ file }: { file: FileRef }) {
  const [preview, setPreview] = useState(false);
  const inline = isInlineViewable(file.contentType ?? '');
  return (
    <>
      <Tooltip title={inline ? 'Посмотреть' : 'Браузер не покажет этот тип — скачайте файл'}>
        {/* Отключённая кнопка событий мыши не получает — подсказку держит обёртка. */}
        <span>
          <Button
            type="text"
            size="small"
            icon={<EyeOutlined />}
            disabled={!inline}
            aria-label={`Посмотреть ${file.filename}`}
            onClick={() => setPreview(true)}
          />
        </span>
      </Tooltip>
      {inline && <FilePreviewModal file={file} open={preview} onClose={() => setPreview(false)} />}
    </>
  );
}

interface FileListProps<T extends FileRef> {
  files: T[];
  /** Кнопка «Удалить» у каждой строки; без него список только на чтение. */
  onRemove?: (file: T) => void;
  emptyText?: string;
  maxNameWidth?: number;
}

/**
 * Список вложений: имя ссылкой, размер и действия. Общий для заявок всех модулей.
 * Просмотр и скачивание стоят иконками у каждой строки — это разные действия (посмотреть
 * окном против сохранить на диск), и выбирать между ними приходится в любом списке.
 */
export function FileLinkList<T extends FileRef>({
  files,
  onRemove,
  emptyText,
  maxNameWidth = 320,
}: FileListProps<T>) {
  return (
    <List
      size="small"
      dataSource={files}
      locale={emptyText ? { emptyText } : undefined}
      renderItem={(f) => (
        <List.Item
          actions={[
            <FileViewButton key="view" file={f} />,
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
    <ViewModal
      title={title}
      open={open}
      onClose={onClose}
      width={520}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <FileLinkList files={files} emptyText="Файлы не прикреплены" maxNameWidth={320} />
    </ViewModal>
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
