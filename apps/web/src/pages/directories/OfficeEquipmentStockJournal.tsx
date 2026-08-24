import { Empty, Space, Spin, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import type { OfficeEquipmentConsumableStockEntryDto } from '@technic/contracts';
import { formatDateTime } from '../../utils/format';

/**
 * Лента журнала остатка в карточке расходника (план
 * `docs/office-equipment-consumables-plan.md`, Р7, §6): было → стало, причина, кто и когда.
 *
 * Только чтение, и это свойство самой записи, а не скупость экрана: строки журнала неизменяемы —
 * правку и удаление отбивает триггер базы (Р11). Ошибку исправляют следующим событием («ошиблись,
 * вернули 15» с причиной), поэтому лента читается как рассказ, а не как таблица с карандашом.
 *
 * Порядок задаёт сервер (`seq`, а не время: две правки одной секунды по `createdAt`
 * неразличимы) — на портале строки не пересортировываются вовсе.
 *
 * Данные приходят пропсом, а не своим запросом: ленту приносит карточка расходника вместе с самой
 * записью (`GET /:id`), и второй запрос за тем же ответом означал бы две версии одного числа на
 * одном экране. Отдельной ручки под журнал нет намеренно (§8): вторая дверь к тем же данным — это
 * второе место, где решают, что показывать и в каком порядке.
 */

/**
 * Чем было движение. Выдачу и возврат по заявке журнал различает с первой миграции (Р7), и лента
 * обязана называть их, а не показывать «−2» без ответа «почему». Ручную правку не подписываем: она
 * здесь по умолчанию, и тег у каждой строки стал бы шумом.
 */
const ENTRY_KIND_LABELS: Record<
  OfficeEquipmentConsumableStockEntryDto['entryKind'],
  string | null
> = {
  // Перечень полный, а не «что знаем»: новый вид события в контракте обязан сломать сборку здесь,
  // а не тихо приехать в ленту безымянным.
  manual: null,
  issue: 'Выдача',
  return: 'Возврат',
};

/**
 * Номер заявки ссылкой (Р10): «−2, выдано по СО-1234».
 *
 * Ссылка ведёт в раздел и открывает ту самую заявку (ADR 0074, приём истории обслуживания в
 * карточке аппарата) — «кому и зачем выдали» читают в ней, а не в справочнике. Куда именно ушли
 * картриджи, журнал склада не знает и знать не должен: это вопрос к заявке.
 *
 * Номер приходит с сервера готовым, а не склеивается здесь из идентификатора: в причине события
 * стоит тот же самый номер, написанный сервером, и второе место, где его собирают, разошлось бы с
 * первым на первой же смене префикса.
 *
 * Строка без ссылки бывает: это ручная правка кладовщика, у неё заявки нет вовсе.
 */
function RequestLink({ entry }: { entry: OfficeEquipmentConsumableStockEntryDto }) {
  if (!entry.serviceRequestId || !entry.serviceRequestNumber) return null;
  return (
    <Link to={`/office-equipment?tab=requests&open=${entry.serviceRequestId}`}>
      {entry.serviceRequestNumber}
    </Link>
  );
}

/**
 * Насколько сдвинулся остаток — знаком и числом («−2», «+1»).
 *
 * Знак важнее пары «было → стало» ровно в одном месте — при беглом чтении ленты: «12 → 10» и
 * «2 → 0» отвечают на вопрос «сколько ушло» вычитанием в уме, а вопрос этот в журнале главный.
 * Пара остаётся рядом: по ней сверяют цепочку.
 */
function deltaOf(entry: OfficeEquipmentConsumableStockEntryDto): string {
  const delta = entry.quantityAfter - entry.quantityBefore;
  return delta > 0 ? `+${delta}` : String(delta);
}

export function OfficeEquipmentStockJournal({
  entries,
  loading,
}: {
  entries: OfficeEquipmentConsumableStockEntryDto[] | undefined;
  loading?: boolean;
}) {
  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Журнал остатка
      </Typography.Title>
      {loading && !entries ? (
        <Spin size="small" />
      ) : !entries || entries.length === 0 ? (
        // «Движений не было» — это и ответ на «почему карточку ещё можно удалить» (Р11).
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Остаток ещё не меняли" />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {entries.map((entry) => (
            <div key={entry.id}>
              <Space size={8} wrap>
                <Typography.Text type="secondary">
                  {formatDateTime(entry.createdAt)}
                </Typography.Text>
                <Typography.Text>{entry.changedByName}</Typography.Text>
                {ENTRY_KIND_LABELS[entry.entryKind] && (
                  <Tag color="blue">{ENTRY_KIND_LABELS[entry.entryKind]}</Tag>
                )}
                <RequestLink entry={entry} />
                <Typography.Text strong>{deltaOf(entry)}</Typography.Text>
                <Typography.Text type="secondary">
                  {entry.quantityBefore} → {entry.quantityAfter}
                </Typography.Text>
              </Space>
              {/* Причина — половина смысла строки: «12 → 4» без неё через месяц читать нечем. */}
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {entry.reason}
                </Typography.Text>
              </div>
            </div>
          ))}
        </Space>
      )}
    </>
  );
}
