import { useState } from 'react';
import { App, Button, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DirectoryInfoDto } from '@technic/contracts';
import { directoriesApi } from '../../api/resources';
import { DirectoryImportModal } from './DirectoryImportModal';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/**
 * Обмен справочниками через файл Excel (ADR 0073).
 *
 * Вкладка администрирования, а не кнопки на самих справочниках: выгрузка уносит из портала весь
 * справочник разом, загрузка меняет сотни строк одним нажатием — и права на это (`directories
 * .export`, `directories.import`) выданы не тем, кто ведёт справочник по строке (ADR 0021).
 *
 * Список справочников приходит с сервера, а не собирается здесь из `DIRECTORY_KEYS`: рядом с
 * названием стоит счётчик строк, а он же и есть ответ на вопрос «тот ли файл я потом загружаю».
 */

/** Ключ списка: рядом с названием справочника стоит счётчик строк, и после загрузки он другой. */
const LIST_KEY = ['directories', 'transfer'];

export function DirectoryTransferTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const isMobile = useIsMobile();
  /** Какой справочник грузим: он же заголовок окна и адрес запроса. */
  const [importing, setImporting] = useState<DirectoryInfoDto | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => directoriesApi.list(),
  });

  /**
   * Выгрузка идёт мутацией, а не ссылкой: файл забирается запросом с токеном и уже из памяти
   * вкладки ложится на диск (`apiDownload`). Имя ему даёт сервер — в нём дата выгрузки, и портал
   * своего названия не придумывает.
   */
  const exportMut = useMutation({
    mutationFn: (d: DirectoryInfoDto) => directoriesApi.exportFile(d.key, d.title),
    onError: (e) => message.error(errorMessage(e)),
  });

  // Загрузка идёт по праву, а выгрузка — по тому, которым открыта сама вкладка: разведены они
  // намеренно (ADR 0073), и «Загрузить» у того, кому её не выдали, быть не должно.
  const canImport = can('directories.import');

  const columns: TableColumnsType<DirectoryInfoDto> = [
    {
      key: 'title',
      title: 'Справочник',
      dataIndex: 'title',
      render: (_v: unknown, r) => (
        <Space size={8} wrap>
          <span>{r.title}</span>
          {/* Водители — единственный справочник с персональными данными (ADR 0037): выгруженный
              файл живёт уже вне портала, и предупредить об этом надо до нажатия, а не в инструкции. */}
          {r.key === 'drivers' && (
            <Tooltip title="В файле ФИО, СНИЛС и номера удостоверений. Не пересылайте его почтой и не оставляйте на общем диске">
              <Tag color="orange">персональные данные</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      key: 'count',
      title: 'Записей',
      dataIndex: 'count',
      width: 110,
      align: 'right',
    },
    {
      key: 'actions',
      title: '',
      width: canImport ? 240 : 140,
      render: (_v: unknown, r) => (
        <Space size={8} wrap>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            // Загружается один справочник за раз, но кнопка ждёт только своя: остальные строки
            // при этом остаются рабочими.
            loading={exportMut.isPending && exportMut.variables?.key === r.key}
            onClick={() => exportMut.mutate(r)}
          >
            Выгрузить
          </Button>
          {canImport && (
            <Button
              size="small"
              icon={<UploadOutlined />}
              onClick={() => setImporting(r)}
              disabled={exportMut.isPending}
            >
              Загрузить
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0, maxWidth: 900 }}>
        Справочник выгружается файлом .xlsx, правится в редакторе таблиц и загружается обратно.
        Загрузка ничего не удаляет: она заводит новые строки и меняет существующие, а погасить
        строку можно колонкой «Активен». Перед записью портал показывает, что изменится.
      </Typography.Paragraph>
      {/* Таблица прокручивается сама: полоса вкладок отдана содержимому целиком
          (`.full-height-tabs` прячет переполнение), и без своей прокрутки последние справочники
          просто обрезались бы низом экрана. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <Table<DirectoryInfoDto>
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          // Список фиксирован — восемнадцать справочников, и листать его нечем. На телефоне
          // таблица прокручивается вбок внутри своей рамки: две кнопки на 360 px иначе ужимаются
          // до нечитаемого (ADR 0030).
          pagination={false}
          scroll={isMobile ? { x: 'max-content' } : undefined}
        />
      </div>

      <DirectoryImportModal
        directory={importing}
        onClose={() => setImporting(null)}
        onImported={() => {
          // Загрузка пишет в справочник, названный в адресе, и следом в связанные с ним: типы ТС
          // перестраивают классификатор, отделы меняют области видимости учёток, водители тянут
          // свои квалификации. Карта «ключ обмена → корни кэша» на двадцать справочников
          // разошлась бы с описаниями обмена молча, а загрузка — редкое разовое действие
          // администратора: точность здесь дешевле не окупается.
          void qc.invalidateQueries();
        }}
      />
    </div>
  );
}
