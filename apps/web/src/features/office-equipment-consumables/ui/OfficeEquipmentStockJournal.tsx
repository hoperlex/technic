import { Space, Tag, Tooltip, Typography } from 'antd';
import { Link } from 'react-router';
import type { OfficeEquipmentConsumableStockEntryDto } from '@technic/contracts';
import { formatDateTime } from '../../../utils/format';

/**
 * Лента журнала остатка строками: насколько сдвинулся остаток, было → стало, причина, кто и когда
 * (план `docs/office-equipment-consumables-plan.md`, Р7; план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р4).
 *
 * ТОЛЬКО ПРЕДСТАВЛЕНИЕ, БЕЗ ЗАПРОСА. Страницу приносит окно «История остатка» — оно же держит
 * отбор по виду события и постраничность, — а здесь остаётся то, как строка читается. Разделение
 * то же самое, что у перечня позиций (`officeEquipmentConsumableGrid` отдельно от окна): описание
 * строки читается целиком, не пролистывая мутации и состояния загрузки.
 *
 * Только чтение, и это свойство самой записи, а не скупость экрана: строки журнала неизменяемы —
 * правку и удаление отбивает триггер базы (Р11). Ошибку исправляют следующим событием («ошиблись,
 * вернули 15» с причиной), поэтому лента читается как рассказ, а не как таблица с карандашом.
 *
 * Порядок задаёт сервер (`seq`, а не время: две правки одной секунды по `createdAt`
 * неразличимы) — на портале строки не пересортировываются вовсе.
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

/** Почему номер заявки бывает не ссылкой — словами, а не молчанием (Р4). */
const NO_ACCESS_HINT =
  'Эта заявка вам не открыта: журнал склада один на компанию, а видимость заявок складывается из области роли и назначенной сервисной компании. Номер оставлен, чтобы было с чем прийти к ИТ-службе.';

/**
 * Номер заявки: ссылкой тому, кто её откроет, и обычным текстом всем остальным (Р4).
 *
 * ПРИЗНАК ПРИХОДИТ С СЕРВЕРА (`requestAccessible`), И СЧИТАТЬ ЕГО ЗДЕСЬ НЕЛЬЗЯ. Остаток на складе
 * глобален — он один на компанию, — а заявки нет: их видимость складывается из области роли и
 * назначения сервисной компании, и ни того ни другого на портале нет вовсе. Отсюда два разных
 * отказа, которые признак и закрывает: у менеджера есть `officeEquipment.read` и нет
 * `serviceRequests.read` — ссылка вела бы в 403; у роли площадки право есть, но событие может быть
 * по заявке чужой площадки — ссылка вела бы туда же. До Р4 лента рисовала ссылку всегда, и это был
 * существующий дефект, а не новое требование.
 *
 * НОМЕР ПРИ ЭТОМ НЕ ПРЯЧЕТСЯ. Журнал склада один на компанию, и «−2, выдано по СО-1234» — это и
 * есть ответ на вопрос, ради которого сюда пришли: куда делись картриджи. Скрыв номер, лента
 * оставила бы человека с «−2» и без единой зацепки, хотя спрятать всё равно нечего — та же строка
 * причины, написанная сервером, называет тот же номер.
 *
 * Номер приходит с сервера готовым, а не склеивается здесь из идентификатора: в причине события
 * стоит тот же самый номер, и второе место, где его собирают, разошлось бы с первым на первой же
 * смене префикса.
 *
 * Строка без заявки бывает: это ручная правка кладовщика, у неё заявки нет вовсе.
 */
function RequestRef({ entry }: { entry: OfficeEquipmentConsumableStockEntryDto }) {
  if (!entry.serviceRequestId || !entry.serviceRequestNumber) return null;
  if (!entry.requestAccessible)
    return (
      <Tooltip title={NO_ACCESS_HINT}>
        <Typography.Text type="secondary">{entry.serviceRequestNumber}</Typography.Text>
      </Tooltip>
    );
  // Ссылка ведёт в раздел и открывает ту самую заявку (ADR 0074, приём истории обслуживания в
  // карточке аппарата): «кому и зачем выдали» читают в ней, а не в справочнике склада.
  return (
    <Link to={`/office-equipment?tab=requests&open=${entry.serviceRequestId}`}>
      {entry.serviceRequestNumber}
    </Link>
  );
}

/**
 * Подпись автора: имя, роль и наборы полномочий модуля перечнем — «Иванов И. И. · Штаб ·
 * Оргтехника: ведение» (Р4).
 *
 * НАБОРЫ ПЕРЕЧНЕМ, БЕЗ ПРИОРИТЕТА: их у учётки бывает несколько («Оргтехника: ведение» вместе с
 * «Оргтехника: номенклатура» — обычная пара), выбор «главного» был бы выдумкой портала, а роль
 * одна и есть всегда. Пустой перечень наборов — обычное дело: остаток правит и тот, кому права
 * пришли ролью, и лишних разделителей в такой подписи быть не должно.
 *
 * Прочерк вместо имени нарисован на случай правки базы руками: `changed_by` стоит на
 * `ON DELETE RESTRICT`, и в работе портала автор события исчезнуть не может.
 */
function authorLine(entry: OfficeEquipmentConsumableStockEntryDto): string {
  return [entry.changedByName || '—', entry.changedByRoleLabel, ...entry.changedByGrants]
    .filter(Boolean)
    .join(' · ');
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
}: {
  entries: OfficeEquipmentConsumableStockEntryDto[];
}) {
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {entries.map((entry) => (
        <div key={entry.id}>
          <Space size={8} wrap>
            <Typography.Text type="secondary">{formatDateTime(entry.createdAt)}</Typography.Text>
            {ENTRY_KIND_LABELS[entry.entryKind] && (
              <Tag color="blue">{ENTRY_KIND_LABELS[entry.entryKind]}</Tag>
            )}
            <RequestRef entry={entry} />
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
          {/* Автор отдельной строкой, а не в одном ряду с числами: с ролью и наборами подпись
              длиннее самого события, и в общем ряду она вытесняла бы «было → стало» на перенос. */}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {authorLine(entry)}
            </Typography.Text>
          </div>
        </div>
      ))}
    </Space>
  );
}
