import { Tag, Typography } from 'antd';
import {
  vehicleClassificationLabel,
  weeklyItemKindLabels,
  type WeeklyRequestItemDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { ExpandableCell } from '@shared/ui';
import { formatDateOnly } from '../../utils/date';
import { formatDateTime } from '../../utils/format';

/**
 * Ячейки недельной заявки в общем списке «Заказ автотехники».
 *
 * Отдельным модулем, а не ветками внутри колонок: список заказов и без того самый большой файл
 * раздела, и десяток `if (row.kind === 'weekly')` размазал бы документ по нему целиком. Здесь
 * собрано всё, чем недельная строка отличается от строки заказа, — и видно, что отличий ровно
 * столько, сколько у документа своих полей.
 *
 * Чего здесь нет: тега вида документа. Номер «НЗ-12» и так называет документ, а колонка «Тип ТС»
 * у недели остаётся пустой намеренно — позиции классификатора у недельного документа не бывает,
 * и заполнить её нечем.
 */

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Строка состава одной фразой: чья единица, что с ней решили и до какого числа. */
function itemLine(item: WeeklyRequestItemDto): string {
  const vehicle =
    item.currentVehicleLabel ??
    vehicleClassificationLabel({
      typeName: item.vehicleTypeName ?? '',
      categoryName: item.vehicleCategoryName,
    });
  const head = [item.sourceDisplayNumber, vehicle].filter(Boolean).join(' · ');
  // Дата есть у продления («остаётся до 23.08») и у новой единицы (срок внутри недели); у отъезда
  // её нет — там дату называет сам заказ, и повторять её здесь значило бы обещать решение,
  // которого документ не принимал.
  const tail = item.dateTo
    ? `${weeklyItemKindLabels[item.kind]} до ${formatDateOnly(item.dateTo)}`
    : weeklyItemKindLabels[item.kind];
  return head ? `${head} · ${tail}` : tail;
}

/**
 * Колонка «Техника» у недельной строки — состав документа целиком.
 *
 * Ради неё колонка и стала сворачиваемой (`ExpandableCell`): у заказа тут две строки, у недели их
 * бывает и десять, и пустить их в высоту значило бы растянуть каждую строку списка под самый
 * многословный документ. Свёрнутой видно две единицы — этого хватает, чтобы узнать неделю в
 * списке, а разворот открывает состав, не открывая карточку.
 *
 * Состав приходит с сервера уже суженным по области учётки (арендодатель видит свои строки, и
 * `counts` считаются по ним же), поэтому здесь фильтра нет: второе место, где живёт то же
 * условие, разошлось бы с первым.
 */
export function WeeklyCompositionCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  if (weekly.items.length === 0) return dash;
  return (
    <ExpandableCell>
      <div>
        {weekly.items.map((item) => (
          <div key={item.id}>{itemLine(item)}</div>
        ))}
      </div>
    </ExpandableCell>
  );
}

/**
 * Контакты недельной заявки — только у строк «нужна дополнительно»: у них есть встречающий на
 * площадке, как у обычного заказа. У продления и отъезда контакта своего нет — он остался в самом
 * заказе, и показывать его здесь значило бы дублировать чужое поле.
 */
export function WeeklyContactsCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  const contacts = weekly.items.filter((i) => i.kind === 'new' && i.responsibleName.trim());
  if (contacts.length === 0) return dash;
  return (
    <ExpandableCell>
      <div>
        {contacts.map((item) => (
          <div key={item.id}>
            {item.responsibleName}
            {item.responsiblePhone ? ` · +7${item.responsiblePhone}` : ''}
          </div>
        ))}
      </div>
    </ExpandableCell>
  );
}

/**
 * Виза недели в колонке «Согласование» — на том же месте, где виза заказа.
 *
 * Кнопки здесь нет намеренно, хотя у заказа она есть: виза недельной заявки той же транзакцией
 * двигает сроки заказов и выписывает бланки (ADR 0085 Р6), и ставить её из строки списка значило
 * бы применять документ, не увидев состава, который применяешь. Решают на странице недели — там,
 * где видно, под чем подписываются.
 */
export function WeeklyApprovalCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  if (weekly.status === 'pending') {
    return (
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
  }
  if (!weekly.approvedAt) return dash;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{weekly.approvedByName ?? '—'}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {formatDateTime(weekly.approvedAt)}
      </Typography.Text>
    </div>
  );
}

/** Комментарий документа и причина снятия — там же, где у заказа его комментарий. */
export function WeeklyCommentCell({ weekly }: { weekly: WeeklyVehicleRequestDto }) {
  const text = weekly.comment.trim();
  if (!text && !weekly.cancelReason) return dash;
  return (
    <ExpandableCell>
      <div>
        {text && <div style={{ whiteSpace: 'pre-line' }}>{text}</div>}
        {!!weekly.cancelReason && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Причина снятия: {weekly.cancelReason}
          </Typography.Text>
        )}
      </div>
    </ExpandableCell>
  );
}
