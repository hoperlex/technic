import { useState } from 'react';
import { Alert, App, Button, Space, Tag, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  DIRECTORY_ID_COLUMN,
  DIRECTORY_IMPORT_MAX_BYTES,
  type DirectoryImportBody,
  type DirectoryImportReportDto,
  type DirectoryInfoDto,
  type DirectoryKey,
  type DirectoryRowReportDto,
} from '@technic/contracts';
import { directoriesApi } from '../../api/resources';
import { ViewModal } from '@shared/ui';
import { errorMessage, formatBytes } from '../../utils/format';

/**
 * Загрузка правленого справочника файлом Excel (ADR 0073).
 *
 * Два шага, а не кнопка «загрузить»: файл возвращается из чужого редактора таблиц, одно нажатие
 * меняет сотни строк справочника, и обратной операции у этого нет. Первым делом показывается, что
 * произойдёт, — построчно и с точностью до ячейки; второй шаг применяет ровно показанное.
 *
 * Окно одно на все справочники: отчёт у них общий (`DirectoryImportReportDto`), а что именно
 * значит строка — знает сервер. Восемнадцать похожих окон разошлись бы текстами предупреждений и
 * тем, где у них заблокирована кнопка.
 */

interface Props {
  /** Какой справочник грузим. `null` — окно закрыто: грузить нечего и заголовок писать не о чем. */
  directory: DirectoryInfoDto | null;
  onClose: () => void;
  /** Справочник изменён — счётчики строк на вкладке пересчитываются. */
  onImported: () => void;
}

/** Куски по 8 КБ: `String.fromCharCode(...)` разворачивает массив в аргументы, и файл целиком переполняет стек. */
const CHUNK = 8192;

/**
 * Байты файла в base64. Через `btoa(await file.text())` не выйдет вовсе: xlsx — это zip, его байты
 * не складываются в текст, и чтение строкой портит книгу ещё до кодирования. Поэтому читаются
 * именно байты, и каждый переводится в свой знак сам.
 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** Пустая ячейка в отчёте о правках: «стало пусто» и «стало пробел» человеку неразличимы. */
const cellText = (value: string) => (value.trim() === '' ? '(пусто)' : `«${value}»`);

/**
 * Строки отчёта: номер строки и чем она называется. Номер первым — по нему строку и находят в
 * файле, а название нужно, чтобы убедиться, что нашли ту самую.
 */
function RowList({ rows }: { rows: DirectoryRowReportDto[] }) {
  return (
    <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
      {rows.map((r) => (
        <div key={r.row} style={{ marginBottom: 4 }}>
          <div>
            · строка {r.row} — {r.title}
          </div>
          {/* Правка показывается «с чего на что»: без прежнего значения отчёт сообщает только
              факт правки, а сверять человек будет как раз то, что уедет взамен. */}
          {r.changes?.map((c) => (
            <div key={c.column} style={{ marginLeft: 16 }}>
              <Typography.Text type="secondary">
                {c.column}: {cellText(c.from)} → {cellText(c.to)}
              </Typography.Text>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DirectoryImportModal({ directory, onClose, onImported }: Props) {
  const { message } = App.useApp();
  const [fileName, setFileName] = useState('');
  /** Прочитанный файл: тем же содержимым уходит и предпросмотр, и применение. */
  const [content, setContent] = useState('');
  const [report, setReport] = useState<DirectoryImportReportDto | null>(null);
  /** Ошибка разбора — это про содержимое файла, поэтому она живёт в окне, а не всплывашкой. */
  const [error, setError] = useState('');

  const reset = () => {
    setFileName('');
    setContent('');
    setReport(null);
    setError('');
  };

  const close = () => {
    reset();
    onClose();
  };

  /**
   * И справочник, и содержимое файла едут переменными мутации, а не берутся из состояния:
   * предпросмотр запускается тем же обработчиком, что прочитал файл, — а состояние к этому моменту
   * ещё не закоммичено, и замыкание отдало бы пустое содержимое предыдущего рендера. Сервер на это
   * отвечает ошибкой разбора, которая читается как негодный файл, хотя файл цел.
   */
  const importMut = useMutation({
    mutationFn: (v: { key: DirectoryKey; body: DirectoryImportBody }) =>
      directoriesApi.import(v.key, v.body),
    onSuccess: (r) => {
      setError('');
      setReport(r);
      if (!r.dryRun) {
        message.success(`Справочник «${r.title}» загружен`);
        onImported();
      }
    },
    onError: (e) => {
      setReport(null);
      setError(errorMessage(e));
    },
  });

  /**
   * Выбор файла сразу уходит в предпросмотр: отдельная кнопка «проверить» ничего не решает —
   * ответ на неё нужен всегда, а лишний шаг между выбором и отчётом только удлиняет путь.
   */
  const pick = async (f: File) => {
    if (!directory) return;
    reset();
    setFileName(f.name);
    // Заведомо великий файл не отправляется вовсе: тело в мегабайты уедет на сервер целиком и
    // вернётся тем же отказом по размеру — сказать об этом можно сразу и дешевле.
    if (f.size > DIRECTORY_IMPORT_MAX_BYTES) {
      setError(
        `«${f.name}» весит ${formatBytes(f.size)}, а принимается не больше ` +
          `${formatBytes(DIRECTORY_IMPORT_MAX_BYTES)}. Справочник столько не весит — ` +
          'проверьте, тот ли это файл.',
      );
      return;
    }
    const base64 = encodeBase64(new Uint8Array(await f.arrayBuffer()));
    setContent(base64);
    importMut.mutate({
      key: directory.key,
      body: { dryRun: true, filename: f.name, contentBase64: base64 },
    });
  };

  const apply = () => {
    if (!directory || !content) return;
    importMut.mutate({
      key: directory.key,
      body: { dryRun: false, filename: fileName, contentBase64: content },
    });
  };

  // Отчёт предпросмотра и отчёт применения различаются только `dryRun`, поэтому и разбираются
  // сужением: так подписи «будет заведено» и «заведено» берутся из одного и того же места.
  const preview = report?.dryRun === true ? report : null;
  const done = report?.dryRun === false ? report : null;
  const changes = report ? report.created.length + report.updated.length : 0;

  const footer = done ? (
    <Button type="primary" onClick={close}>
      Готово
    </Button>
  ) : (
    <Space>
      <Button onClick={close}>Отмена</Button>
      {/* Пока в отчёте есть негодные строки, применения нет: половина заведённого справочника
          хуже невыполненной загрузки — её потом сверять построчно. */}
      <Button
        type="primary"
        disabled={!preview || preview.problems.length > 0 || changes === 0}
        loading={importMut.isPending}
        onClick={apply}
      >
        Применить
      </Button>
    </Space>
  );

  return (
    <ViewModal
      title={`Загрузка справочника${directory ? `: ${directory.title}` : ''}`}
      open={!!directory}
      onClose={close}
      width={640}
      footer={footer}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {!done && (
          <Space wrap>
            <Upload
              accept=".xlsx"
              showUploadList={false}
              beforeUpload={(f) => {
                void pick(f);
                // Загрузку ведёт само окно: antd иначе отправил бы файл своим запросом, мимо
                // заголовков API и мимо предпросмотра.
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={importMut.isPending}>
                Выбрать файл
              </Button>
            </Upload>
            {fileName && <Typography.Text type="secondary">{fileName}</Typography.Text>}
          </Space>
        )}

        {error && (
          <Alert
            type="error"
            showIcon
            message="Файл не разобран"
            // Сервер перечисляет негодные строки списком: переносы здесь и есть отчёт, а собранные
            // в абзац они читаются как одна длинная фраза.
            description={
              <div style={{ whiteSpace: 'pre-line', maxHeight: 260, overflowY: 'auto' }}>
                {error}
              </div>
            }
          />
        )}

        {!report && !error && (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Файл .xlsx, выгруженный этой же вкладкой и поправленный в редакторе таблиц. Сначала
            портал покажет, что изменится, — база при этом не меняется. Загрузка ничего не удаляет:
            чтобы погасить строку, поставьте «нет» в колонке «Активен». Колонку «
            {DIRECTORY_ID_COLUMN}» не трогайте — по ней портал узнаёт, какую запись правит.
          </Typography.Paragraph>
        )}

        {report && (
          <>
            {done && (
              <Alert
                type="success"
                showIcon
                message={`Заведено ${done.created.length}, изменено ${done.updated.length}`}
              />
            )}

            <div>
              <Typography.Text strong>
                {preview ? 'Будет заведено' : 'Заведено'}: {report.created.length}
                {preview && (
                  <Tag color="blue" style={{ marginLeft: 8 }}>
                    база ещё не изменена
                  </Tag>
                )}
              </Typography.Text>
              {report.created.length > 0 && <RowList rows={report.created} />}
            </div>

            <div>
              <Typography.Text strong>
                {preview ? 'Будет изменено' : 'Изменено'}: {report.updated.length}
              </Typography.Text>
              {report.updated.length > 0 && <RowList rows={report.updated} />}
            </div>

            {/* Совпавшие до знака строки перечислять незачем — их считают, чтобы сойтись с числом
                строк в файле и увидеть, что лишнего портал не заметил. */}
            <Typography.Text type="secondary">
              Без изменений: {report.unchanged}. Всего строк в файле: {report.totalRows}.
            </Typography.Text>

            {report.problems.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="Пока это не исправлено, файл не применяется — ни одной строкой"
                description={
                  <div style={{ whiteSpace: 'pre-line', maxHeight: 260, overflowY: 'auto' }}>
                    {report.problems.join('\n')}
                  </div>
                }
              />
            )}

            {report.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Прочитайте перед применением — загрузке это не мешает"
                description={
                  <div style={{ whiteSpace: 'pre-line', maxHeight: 200, overflowY: 'auto' }}>
                    {report.warnings.join('\n')}
                  </div>
                }
              />
            )}
          </>
        )}
      </Space>
    </ViewModal>
  );
}
