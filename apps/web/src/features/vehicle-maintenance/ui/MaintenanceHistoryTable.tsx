import { Alert, Button, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { DeleteOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { VehicleMaintenanceDto } from '@technic/contracts';
import { FilesCell } from '../../../components/FileLinks';
import { SHOWN_DATE, kmText } from '../model/maintenanceText';

/**
 * Журнал обслуживания машины (Р10, Р30): история хранится целиком, и показывается она тоже целиком.
 *
 * Порядок — серверный (свежие сверху), и сортировки у таблицы нет намеренно: записи упорядочены по
 * дате обслуживания, а при совпадении — по времени заведения, и переставить их местами на портале
 * значило бы получить второй ответ на вопрос «какая запись предыдущая» — тот самый, по которому
 * считается пробег с ТО.
 *
 * Страниц нет по той же причине, по какой их нет в ответе: записей ТО у машины десятки за всю
 * жизнь.
 *
 * Раскрытие строки осталось от выпуска автозапчастей, но говорит теперь об одном: **почему акт
 * аннулирован** (Р6). Строк расхода портал не читает вовсе (план `docs/auto-part-receipts-plan.md`,
 * Р2) — купленное живёт чеками во вкладке «Автозапчасти», а не строками акта. Раскрытие даётся
 * только тем актам, которым есть что сказать: пустой раскрыватель обещает содержимое, которого нет.
 *
 * **Аннулированный акт остаётся в журнале** (Р6) — на него ссылаются, и спрятать документ нельзя.
 * Он помечен, объяснён причиной и автором, не правится и в расчёт не входит.
 */

/**
 * Объяснение аннулирования: кто закрыл акт, когда и почему.
 *
 * Содержимое липнет к левому краю и не шире экрана: журнал прокручивается вбок (`scroll.x`), а
 * раскрытая строка живёт в ячейке во всю ширину таблицы — без этого на телефоне объяснение уезжало
 * бы вправо, и раскрытие пришлось бы «догонять» горизонтальной прокруткой.
 */
function MaintenanceRowDetails({ record }: { record: VehicleMaintenanceDto }) {
  return (
    <Space
      orientation="vertical"
      size={8}
      style={{
        display: 'flex',
        position: 'sticky',
        insetInlineStart: 0,
        maxWidth: 'min(100%, 92vw)',
      }}
    >
      {record.voidedAt && (
        <Alert
          type="warning"
          showIcon
          title={`Акт аннулирован — ${record.voidedByName || 'без подписи'}, ${dayjs(
            record.voidedAt,
          ).format(`${SHOWN_DATE} HH:mm`)}`}
          description={`Причина: ${record.voidReason}. В расчёт «пробег с ТО» акт не входит.`}
        />
      )}
    </Space>
  );
}

export function MaintenanceHistoryTable({
  items,
  canWrite,
  expandedIds,
  onExpandedChange,
  highlightId,
  onEdit,
  onRemove,
  onVoid,
}: {
  items: VehicleMaintenanceDto[];
  canWrite: boolean;
  /** Раскрытые строки: держит их блок — по адресу акта раскрывается ровно одна (Р14). */
  expandedIds: readonly string[];
  onExpandedChange: (ids: readonly string[]) => void;
  /** Акт, названный ссылкой из ленты склада: подсвечивается, чтобы его было видно среди десятков. */
  highlightId?: string | null;
  onEdit: (record: VehicleMaintenanceDto) => void;
  onRemove: (record: VehicleMaintenanceDto) => void;
  /** Аннулирование — замена удаления у акта с движениями склада (Р6). */
  onVoid: (record: VehicleMaintenanceDto) => void;
}) {
  const columns: TableColumnsType<VehicleMaintenanceDto> = [
    {
      key: 'performedOn',
      title: 'Дата ТО',
      width: 140,
      render: (_v, r) => (
        <Space orientation="vertical" size={0}>
          <span>{dayjs(r.performedOn).format(SHOWN_DATE)}</span>
          {/* Пометка стоит первой колонкой, а не в раскрытии: аннулированный акт обязан читаться
              как аннулированный до того, как по нему начнут считать. */}
          {r.voidedAt && (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              Аннулирован
            </Tag>
          )}
        </Space>
      ),
    },
    {
      key: 'odometerKm',
      title: 'Пробег в акте',
      width: 140,
      align: 'right',
      // Прочерк — это «прибор не работал, якоря расчёта нет», а не ноль на счётчике (Р11а).
      render: (_v, r) =>
        r.odometerKm === null ? (
          <Tooltip title="В акте пробега нет: пробег с этого ТО известен только снизу">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          kmText(r.odometerKm)
        ),
    },
    {
      key: 'documentNumber',
      title: 'Документ',
      width: 160,
      ellipsis: true,
      render: (_v, r) => r.documentNumber || '—',
    },
    {
      key: 'note',
      title: 'Примечание',
      ellipsis: true,
      render: (_v, r) => r.note || '—',
    },
    {
      key: 'files',
      title: 'Скан',
      width: 80,
      align: 'center',
      // Скрепка с числом, по нажатию — список со ссылками: акт подшивают, чтобы потом его
      // прочитать, и счётчик без ссылки заставлял бы открывать запись на правку ради просмотра.
      render: (_v, r) => <FilesCell files={r.files} />,
    },
    {
      key: 'author',
      title: 'Кто внёс',
      width: 190,
      render: (_v, r) => (
        <Space orientation="vertical" size={0}>
          <span>{r.createdByName}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(r.createdAt).format(`${SHOWN_DATE} HH:mm`)}
            {/* Правку показываем отдельной строкой: акт правят задним числом, и «кто внёс» с
                «кто правил» — разные ответы. */}
            {r.updatedByName ? ` · правил ${r.updatedByName}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            title: 'Действия',
            width: 100,
            render: (_v: unknown, r: VehicleMaintenanceDto) => (
              <Space>
                <Tooltip
                  title={
                    r.voidedAt
                      ? 'Аннулированный акт не правится — исправление вводится новым актом'
                      : undefined
                  }
                >
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    aria-label="Изменить запись ТО"
                    disabled={!!r.voidedAt}
                    onClick={() => onEdit(r)}
                  />
                </Tooltip>
                {r.voidedAt ? null : r.hasPartMovements ? (
                  /* Правило известно порталу заранее (Р6) и держится на признаке DTO
                     `hasPartMovements`, а не на строках акта: строки снимали правкой, а движения по
                     ним оставались навсегда. Узнавать это из 409 после нажатия «Удалить» человек не
                     должен. */
                  <Tooltip title="По акту прошли движения — такой акт аннулируют с причиной">
                    <Button
                      size="small"
                      danger
                      icon={<StopOutlined />}
                      aria-label="Аннулировать запись ТО"
                      onClick={() => onVoid(r)}
                    />
                  </Tooltip>
                ) : (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="Удалить запись ТО"
                    onClick={() => onRemove(r)}
                  />
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Table<VehicleMaintenanceDto>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={items}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: 'Записей о ТО ещё нет' }}
      rowClassName={(r) => (r.id === highlightId ? 'ant-table-row-selected' : '')}
      expandable={{
        // Раскрывается только то, у чего есть содержимое: объяснение аннулирования. Пустой
        // раскрыватель обещал бы ответ, которого у акта нет.
        rowExpandable: (r) => r.voidedAt !== null,
        expandedRowKeys: [...expandedIds],
        // Ключи строк у таблицы — `Key`, а у актов они всегда uuid: приводим на границе, чтобы
        // тип «раскрытых» наверху остался честным списком идентификаторов.
        onExpandedRowsChange: (keys) => onExpandedChange(keys.map(String)),
        expandedRowRender: (r) => <MaintenanceRowDetails record={r} />,
      }}
    />
  );
}
