import { Form, Select } from 'antd';
import { warrantyClaimSourceLabels, type WarrantyClaimSource } from '@technic/contracts';
import type { WarrantyClaimPreset } from './ServiceRequestForm';

/**
 * Источник гарантийного обращения в форме заявки (ADR 0085, Р26): по чьей именно гарантии
 * обращаются — поставщика на саму технику или прошлого ремонта.
 *
 * Не флажок «гарантийная»: без источника спор с сервисом не разрешить, а «гарантийная заявка»
 * ничего не подтверждает. Поле показывается только там, где обращаться есть по чему: гарантия
 * техники действует либо обращение уже начато из реестра.
 *
 * Гарантия на прошлый ремонт выбирается **в реестре**, а не здесь: она требует ссылки на позицию
 * закрытой заявки, и взять этот идентификатор человеку в форме неоткуда — поэтому пункт выключен,
 * пока источник не пришёл извне.
 */
export function ServiceRequestWarrantyClaim({
  active,
  claim,
  source,
}: {
  /** Гарантия выбранной единицы действует. */
  active: boolean;
  /** Обращение начато из реестра: источник задан и не правится. */
  claim?: WarrantyClaimPreset | null;
  /** Что выбрано сейчас — для подсказки под полем. */
  source?: WarrantyClaimSource;
}) {
  if (!active && !claim) return null;
  return (
    <Form.Item
      name="warrantySource"
      label="Обращение по гарантии"
      extra={
        claim
          ? `Источник: ${claim.subject}`
          : source
            ? 'Источник уйдёт в заявку: по нему сервис и разбирает, чинить бесплатно или за деньги'
            : 'Не выбрано — заявка обычная, платная'
      }
    >
      <Select
        allowClear={!claim}
        // Источник, пришедший из реестра, не правится: позиция прошлого ремонта опознаётся
        // идентификатором, и «переключить» её на другую строку в форме нечем.
        disabled={!!claim}
        placeholder="Обычная заявка"
        options={[
          { value: 'equipment', label: warrantyClaimSourceLabels.equipment },
          {
            value: 'item',
            label: claim?.itemId
              ? warrantyClaimSourceLabels.item
              : `${warrantyClaimSourceLabels.item} — выбирается в реестре гарантий`,
            disabled: !claim?.itemId,
          },
        ]}
      />
    </Form.Item>
  );
}
