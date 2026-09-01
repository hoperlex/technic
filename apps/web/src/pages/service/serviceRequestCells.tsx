import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import {
  serviceFileKindLabels,
  type ServiceRequestDto,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import {
  isAwaitingDocuments,
  serviceDocumentCounts,
  serviceRequestEquipmentName,
  serviceRequestObjectLabel,
} from '@entities/service-request';
import { WarrantyTag } from '@entities/office-equipment';
import type { ActionSheetItem } from '@shared/ui';
import { formatMoney } from '../../utils/format';

/**
 * Ячейки списка заявок, которые собирают несколько признаков в одну колонку: реквизиты техники с
 * двумя разными гарантиями, «где стоит» и состояние документов.
 *
 * Отдельным модулем от самих колонок: обе отвечают на вопрос «что здесь на самом деле показано», и
 * путают их постоянно — гарантию техники с пометкой «заявка по гарантии», подшитый акт с
 * недостающим. Объяснения к ним длиннее самой разметки, и в файле колонок они тонули.
 */

/**
 * Неразрывный пробел вместо пустой подписи (Р8). Обе ячейки списка двухстрочные, и у заявки без
 * аппарата второй строке взяться неоткуда: ни номеров, ни типа, ни места внутри объекта у неё нет.
 * Схлопнись строка — ячейка стала бы на строку ниже соседних, и в списке это читается не как «тут
 * пусто», а как недорисованная таблица. Пробел держит высоту, ничего при этом не утверждая:
 * прочерк на его месте означал бы «данные потерялись».
 */
const KEEP_LINE = '\u00A0';

/**
 * Итог заявки: пока работы не закрыты — предъявленный объём работ, после — то, что по акту.
 *
 * Здесь, а не в модуле колонок: ответ нужен и столбцу «Сумма», и строке мобильной карточки, а сам
 * файл колонок упирается в предел длины.
 */
export function amountLabel(request: ServiceRequestDto): { value: string; hint: string } {
  if (request.completion?.totalAmount != null) {
    return { value: formatMoney(request.completion.totalAmount), hint: 'по акту' };
  }
  if (request.estimatedTotalAmount != null) {
    return { value: formatMoney(request.estimatedTotalAmount), hint: 'по объёму работ' };
  }
  return { value: '—', hint: '' };
}

/** Реквизиты единицы: модель сверху, номер и тип — подписью. Ими технику и опознают. */
export function EquipmentCell({
  request,
  warrantyUntil,
}: {
  request: ServiceRequestDto;
  warrantyUntil: string | null | undefined;
}) {
  const equipment = request.equipment;
  const number = equipment?.inventoryNumber
    ? `инв. ${equipment.inventoryNumber}`
    : equipment?.serialNumber
      ? `SN ${equipment.serialNumber}`
      : '';
  return (
    <div style={{ lineHeight: 1.35 }}>
      {/* «Без аппарата» словами: заявка без предмета — законное состояние, а не пробел в ответе. */}
      <div>{serviceRequestEquipmentName(request)}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {[number, equipment?.typeName].filter(Boolean).join(' · ') || KEEP_LINE}
      </Typography.Text>
      <div style={{ marginTop: 2 }}>
        <Space size={4} wrap>
          {/* Два разных признака гарантии (§9.2): слева — состояние гарантии самой техники,
              справа — пометка «эта заявка заявлена по гарантии». Их путают постоянно: техника
              может быть на гарантии, а заявка заведена обычной, и наоборот.
              `undefined` — справочник этой роли не виден (сервису он закрыт), и молчание честнее
              прочерка: портал про гарантию единицы попросту не знает. */}
          {warrantyUntil !== undefined && <WarrantyTag until={warrantyUntil} />}
          {request.warrantyClaim && (
            <Tooltip
              title={`${warrantyClaimSourceLabels[request.warrantyClaim.source]}${
                request.warrantyClaim.itemName ? `: ${request.warrantyClaim.itemName}` : ''
              }${
                request.warrantyClaim.sourceRequestNum
                  ? ` · заявка СО-${request.warrantyClaim.sourceRequestNum}`
                  : ''
              }`}
            >
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                Гарантийная
              </Tag>
            </Tooltip>
          )}
        </Space>
      </div>
    </div>
  );
}

/**
 * Где заявка «стоит»: площадка сверху, место внутри неё и отдел-заказчик — подписью.
 *
 * У заявки без аппарата площадки может не быть вовсе (заявка «от отдела», Р8), и верхняя строка
 * тогда достаётся отделу-заказчику: он и есть область такой заявки, а заказчик у неё ровно один —
 * площадка либо отдел (`CHECK` предмета, Р7). Пустая верхняя строка над подписью читалась бы как
 * непрогрузившаяся ячейка, а прочерк — как «объект потеряли», хотя объекта у такой заявки не
 * бывает по устройству.
 *
 * Отдел в подписи при этом не повторяется: поднявшись наверх, он уходит из нижней строки — иначе
 * ячейка называла бы его дважды подряд.
 */
export function PlaceCell({ request }: { request: ServiceRequestDto }) {
  const objectLabel = serviceRequestObjectLabel(request);
  const department = request.customerDepartment?.name;
  const hint = [request.equipment?.location, objectLabel && department].filter(Boolean).join(' · ');
  return (
    <div style={{ lineHeight: 1.35 }}>
      {/* Ни площадки, ни отдела не бывает (`CHECK` предмета): держать высоту здесь — не запасной
          ответ, а отказ гадать, если база когда-нибудь скажет иначе. */}
      <div>{objectLabel ?? department ?? KEEP_LINE}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {hint || KEEP_LINE}
      </Typography.Text>
    </div>
  );
}

/** Что подшито и хватает ли этого (Р16): по этой ячейке и собирают очередь «Ожидаются документы». */
export function DocumentsCell({ request }: { request: ServiceRequestDto }) {
  const counts = serviceDocumentCounts(request.files);
  const awaiting = isAwaitingDocuments(request);
  if (request.files.length === 0 && !awaiting) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  return (
    <Space size={4} wrap>
      {(['act', 'invoice', 'warranty_card'] as const)
        .filter((kind) => counts[kind])
        .map((kind) => (
          <Tag key={kind} color="green" style={{ marginInlineEnd: 0 }}>
            {serviceFileKindLabels[kind]}
          </Tag>
        ))}
      {/* Один тег вместо трёх «нет: акт / нет: счёт / нет: талон» (Р112): перечень недостающих
          видов читался бы как «нужны все три», хотя приёмку запирает отсутствие сразу всех — и
          снимает её любой один. */}
      {awaiting && (
        <Tag color="red" style={{ marginInlineEnd: 0 }}>
          нет закрывающих
        </Tag>
      )}
    </Space>
  );
}

/**
 * «Принять в работу» прямо из строки списка (Р6) — первое из трёх мест, где заявка попадается на
 * глаза; два других — шапка карточки и меню «Действия».
 *
 * Быстрой кнопкой, потому что ход этот без содержания: подтверждать нечего, есть только версия
 * заявки. Прежде он требовал открыть меню строки ради одного нажатия — и очередь «назначено, но
 * никто не взялся» жила ровно на том, что это нажатие откладывали.
 *
 * Видна кнопка только назначенному, и решает это не она: пункт `start` набор действий отдаёт лишь
 * тому, за кем ход, — коридор исполнителя открывает факт назначения, а не право (Р6). Нет пункта —
 * нет и кнопки; спроси ячейка сама, кому «принять» положено, это была бы вторая карта правил.
 */
export function StartWorkButton({ item }: { item: ActionSheetItem | undefined }) {
  if (!item) return null;
  return (
    <Tooltip title={item.label}>
      <Button
        size="small"
        type="primary"
        icon={<PlayCircleOutlined />}
        aria-label={item.label}
        // Клик не всплывает: по строке списка нажимают, чтобы открыть карточку, и второй смысл у
        // того же жеста означал бы «взял в работу вместо того, чтобы посмотреть».
        onClick={(e) => {
          e.stopPropagation();
          item.onClick();
        }}
      />
    </Tooltip>
  );
}
