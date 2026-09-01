import type { ReactNode } from 'react';
import { Empty, Space, Spin, Table, Typography, type TableColumnsType } from 'antd';
import type { AutoPartStockEntryDto } from '@technic/contracts';
import { EntityLink } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { formatDate, formatDateTime } from '../../utils/format';
import { maintenanceRecordHref } from './autoPartsAddress';

/**
 * «Движение остатка» в карточке автозапчасти (план `docs/auto-parts-plan.md`, Р3, §8; концепт
 * с. 3): было → стало, причина, автор, время и документ.
 *
 * Только чтение, и это свойство самой записи, а не скупость экрана: строки журнала неизменяемы —
 * правку и удаление отбивает триггер базы (Р3). Ошибку исправляют следующим событием («ошиблись,
 * вернули 15» с причиной), поэтому лента читается как рассказ, а не как таблица с карандашом.
 *
 * Порядок задаёт сервер (`seq`, а не время: две правки одной секунды по `createdAt`
 * неразличимы) — на портале строки не пересортировываются вовсе.
 *
 * Данные приходят пропсом, а не своим запросом: ленту приносит карточка позиции вместе с самой
 * записью (`GET /:id`), и второй запрос за тем же ответом означал бы две версии одного числа на
 * одном экране.
 */

/**
 * Стрелка «было → стало» цветом направления: вниз — расход, вверх — приход. Цвет здесь не
 * украшение: в ленте из десятка строк вопрос «когда мы это тратили» читается им одним, а числа
 * приходится сравнивать глазами.
 */
function changeCell(entry: AutoPartStockEntryDto): ReactNode {
  const spent = entry.quantityAfter < entry.quantityBefore;
  return (
    <Typography.Text type={spent ? 'danger' : 'success'} strong>
      {entry.quantityBefore} → {entry.quantityAfter}
    </Typography.Text>
  );
}

/**
 * Документ движения — ссылкой на **тот самый** акт (Р14): `?tab=vehicles&maintenance=…&record=…`.
 * Ответ на «почему стало 11» и ответ на «что поставили на машину» — одна и та же запись,
 * прочитанная с двух сторон, и ссылка есть переход между ними.
 *
 * Подпись собирается из даты акта и подписи машины, а номера документа в ней нет: `AutoPartStockEntryDto`
 * его не несёт, и выдумывать «Акт № 128» из того, чего в ответе нет, значило бы показать номер,
 * которого может не быть вовсе — бумажный акт в портале живёт и без него.
 *
 * У ручной правки документа нет по построению (`CHECK` связок в базе), и прочерк здесь — ответ,
 * а не пустота: причину такого движения писал человек, и она стоит в соседней колонке.
 */
function documentCell(entry: AutoPartStockEntryDto): ReactNode {
  if (!entry.maintenanceId || !entry.maintenanceVehicleId) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const when = entry.maintenancePerformedOn ? formatDate(entry.maintenancePerformedOn) : '';
  return (
    <EntityLink
      to={maintenanceRecordHref(entry.maintenanceVehicleId, entry.maintenanceId)}
      title="Открыть акт обслуживания"
    >
      {[`Акт${when ? ` от ${when}` : ''}`, entry.maintenanceVehicleLabel]
        .filter(Boolean)
        .join(' · ')}
    </EntityLink>
  );
}

const columns: TableColumnsType<AutoPartStockEntryDto> = [
  {
    key: 'createdAt',
    title: 'Дата',
    width: 150,
    /*
     * Дата **складского** учёта — когда движение отражено в портале (Р20). У актов задним числом
     * она расходится с датой самого акта, и это норма, а не дефект: вторая дата стоит рядом, в
     * подписи документа, и обе названы своими словами.
     */
    render: (_v, r: AutoPartStockEntryDto) => formatDateTime(r.createdAt),
  },
  {
    key: 'change',
    title: 'Было → стало',
    width: 130,
    render: (_v, r: AutoPartStockEntryDto) => changeCell(r),
  },
  {
    key: 'reason',
    title: 'Причина',
    /*
     * Половина смысла строки: «12 → 4» без объяснения через месяц читать нечем. У движений по акту
     * причина нейтральная и неизменяемая («Списание по акту обслуживания»), реквизиты документа в
     * неё не вписываются намеренно — их правят после движения (Р5).
     */
    render: (_v, r: AutoPartStockEntryDto) => r.reason,
  },
  { key: 'changedByName', title: 'Автор', dataIndex: 'changedByName', width: 170 },
  {
    key: 'document',
    title: 'Документ',
    width: 210,
    render: (_v, r: AutoPartStockEntryDto) => documentCell(r),
  },
];

/** Та же строка на телефоне: пять колонок на 360 px не помещаются, а сравнивать их незачем. */
function entryCard(entry: AutoPartStockEntryDto): ReactNode {
  return (
    <div key={entry.id}>
      <Space size={8} wrap>
        <Typography.Text type="secondary">{formatDateTime(entry.createdAt)}</Typography.Text>
        {changeCell(entry)}
        <Typography.Text>{entry.changedByName}</Typography.Text>
      </Space>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.reason}
        </Typography.Text>
      </div>
      {entry.maintenanceId && <div>{documentCell(entry)}</div>}
    </div>
  );
}

export function AutoPartStockJournal({
  entries,
  loading,
}: {
  entries: AutoPartStockEntryDto[] | undefined;
  loading?: boolean;
}) {
  const isMobile = useIsMobile();

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Движение остатка
      </Typography.Title>
      {loading && !entries ? (
        <Spin size="small" />
      ) : !entries || entries.length === 0 ? (
        // «Движений не было» — это и ответ на «почему позицию ещё можно удалить» (Р11).
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Остаток ещё не меняли" />
      ) : isMobile ? (
        <Space orientation="vertical" size={10} style={{ width: '100%' }}>
          {entries.map(entryCard)}
        </Space>
      ) : (
        <Table<AutoPartStockEntryDto>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={entries}
          // Страниц у ленты нет: её приносит карточка целиком, и листать историю одной позиции
          // незачем — её читают сверху вниз, как рассказ.
          pagination={false}
        />
      )}
    </>
  );
}
