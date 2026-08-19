import { Space, Tag, Tooltip, Typography } from 'antd';
import {
  serviceFileKindLabels,
  type ServiceRequestDto,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import { isAwaitingDocuments, serviceDocumentCounts } from '@entities/service-request';
import { WarrantyTag } from '@entities/office-equipment';

/**
 * Ячейки списка заявок, которые собирают несколько признаков в одну колонку: реквизиты техники с
 * двумя разными гарантиями и состояние документов.
 *
 * Отдельным модулем от самих колонок: обе отвечают на вопрос «что здесь на самом деле показано», и
 * путают их постоянно — гарантию техники с пометкой «заявка по гарантии», подшитый акт с
 * недостающим. Объяснения к ним длиннее самой разметки, и в файле колонок они тонули.
 */

/** Реквизиты единицы: модель сверху, номер и тип — подписью. Ими технику и опознают. */
/** Реквизиты единицы: модель сверху, номер и тип — подписью. Ими технику и опознают. */
export function EquipmentCell({
  request,
  warrantyUntil,
}: {
  request: ServiceRequestDto;
  warrantyUntil: string | null | undefined;
}) {
  const equipment = request.equipment;
  const number = equipment.inventoryNumber
    ? `инв. ${equipment.inventoryNumber}`
    : equipment.serialNumber
      ? `SN ${equipment.serialNumber}`
      : '';
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{equipment.name}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {[number, equipment.typeName].filter(Boolean).join(' · ')}
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
