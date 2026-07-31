import { useState } from 'react';
import { App, Alert, Button, Space, Tag, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  DRIVERS_IMPORT_LICENSE_HINT,
  type DriversImportBody,
  type DriversImportReportDto,
} from '@technic/contracts';
import { driversApi } from '../../api/resources';
import { ViewModal } from '../../components/ViewModal';
import { errorMessage } from '../../utils/format';

/**
 * Загрузка кадровой выгрузки в справочник водителей (ADR 0047).
 *
 * Два шага, а не кнопка «загрузить»: файл приходит от кадровика, заведение живых людей необратимо
 * (обратной операции у наполнения нет), и первым делом показывается, что произойдёт, — поимённо.
 * Второй шаг заводит ровно то, что показал первый.
 *
 * Разбор идёт на сервере, а не здесь: правила, по которым строка выгрузки превращается в водителя
 * (форматы дат, контрольная сумма СНИЛС, неизвестные категории), обязаны быть одни и те же для
 * портала и для наполнения из командной строки.
 */

type ImportFile = DriversImportBody['file'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Справочник наполнен — список обновляется у того, кто его открыл. */
  onImported: () => void;
}

/** Строки отчёта: список ФИО под заголовком, с прокруткой — выгрузка бывает на сотню человек. */
function NameList({ items }: { items: string[] }) {
  return (
    <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 4 }}>
      {items.map((who) => (
        <div key={who}>· {who}</div>
      ))}
    </div>
  );
}

export function DriversImportModal({ open, onClose, onImported }: Props) {
  const { message } = App.useApp();
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<ImportFile | null>(null);
  const [report, setReport] = useState<DriversImportReportDto | null>(null);
  /** Ошибка разбора — это про содержимое файла, поэтому она живёт в окне, а не всплывашкой. */
  const [error, setError] = useState('');

  const reset = () => {
    setFileName('');
    setFile(null);
    setReport(null);
    setError('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const importMut = useMutation({
    mutationFn: (dryRun: boolean) => driversApi.import({ dryRun, file: file! }),
    onSuccess: (r) => {
      setError('');
      setReport(r);
      if (!r.dryRun) {
        message.success(`Заведено водителей: ${r.created.length}`);
        onImported();
      }
    },
    onError: (e) => {
      setReport(null);
      setError(errorMessage(e));
    },
  });

  /** Чтение файла: сервер принимает разобранный JSON, поэтому синтаксис проверяется здесь. */
  const pick = async (f: File) => {
    reset();
    setFileName(f.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      setError(`«${f.name}» — не JSON. Кадровая выгрузка приходит файлом .json.`);
      return;
    }
    setFile(parsed as ImportFile);
    importMut.mutate(true);
  };

  const preview = report?.dryRun === true;
  const done = report?.dryRun === false;

  const footer = done ? (
    <Button type="primary" onClick={close}>
      Готово
    </Button>
  ) : (
    <Space>
      <Button onClick={close}>Отмена</Button>
      <Button
        type="primary"
        disabled={!preview || report.created.length === 0}
        loading={importMut.isPending}
        onClick={() => importMut.mutate(false)}
      >
        {preview && report.created.length > 0
          ? `Завести водителей: ${report.created.length}`
          : 'Завести'}
      </Button>
    </Space>
  );

  return (
    <ViewModal
      title="Кадровая выгрузка водителей"
      open={open}
      onClose={close}
      width={620}
      footer={footer}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {!done && (
          <Space wrap>
            <Upload
              accept=".json,application/json"
              showUploadList={false}
              beforeUpload={(f) => {
                void pick(f);
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
          <Alert type="error" showIcon message="Выгрузка не разобрана" description={error} />
        )}

        {!report && !error && (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Файл .json от кадровой службы: ФИО, СНИЛС, табельный номер, дата приёма и категории
            удостоверения. Сначала портал покажет, кого заведёт, — база при этом не меняется.
          </Typography.Paragraph>
        )}

        {report && (
          <>
            <Typography.Text strong>
              {preview ? 'Будет заведено' : 'Заведено'} водителей: {report.created.length}
              {report.created.length > 0 && preview && (
                <Tag color="blue" style={{ marginLeft: 8 }}>
                  база ещё не изменена
                </Tag>
              )}
            </Typography.Text>
            {report.created.length > 0 && <NameList items={report.created} />}

            {report.skipped.length > 0 && (
              <div>
                <Typography.Text>
                  Уже в справочнике (совпал СНИЛС), пропущено: {report.skipped.length}
                </Typography.Text>
                <NameList items={report.skipped} />
              </div>
            )}

            {report.withoutLicense.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Без удостоверения — в отбор под машину не попадут"
                description={
                  <div>
                    {report.withoutLicense.map((w) => (
                      <div key={w.who}>
                        · {w.who}: {w.why}
                      </div>
                    ))}
                  </div>
                }
              />
            )}

            {report.unknownCategories.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Категорий нет в справочнике — не заведены, уточнить по оригиналу"
                description={
                  <div>
                    {report.unknownCategories.map((u) => (
                      <div key={u.who}>
                        · {u.who}: {u.codes.map((c) => c.toUpperCase()).join(', ')}
                      </div>
                    ))}
                  </div>
                }
              />
            )}

            {report.nameCollisions.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Однофамильцы среди заведённых раньше — проверьте, не один ли это человек"
                description={
                  <div>
                    {report.nameCollisions.map((c) => (
                      <div key={c.who}>
                        · {c.who}: уже есть с СНИЛС {c.existing}
                      </div>
                    ))}
                  </div>
                }
              />
            )}

            {report.created.length > 0 && (
              <Alert type="info" showIcon message={DRIVERS_IMPORT_LICENSE_HINT} />
            )}
          </>
        )}
      </Space>
    </ViewModal>
  );
}
