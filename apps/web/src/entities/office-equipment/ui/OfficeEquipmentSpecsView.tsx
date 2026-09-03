import { Typography } from 'antd';
import {
  OFFICE_EQUIPMENT_SPEC_UNKNOWN,
  type OfficeEquipmentModelSpecDto,
} from '@technic/contracts';

/**
 * Характеристики модели в карточке единицы (план `docs/office-equipment-specs-plan.md`, Р8):
 * «Цветность печати: Цветная».
 *
 * Полным словом, а не сокращением списка, и это не непоследовательность: в списке за место борются
 * восемь колонок, а карточку открывают, чтобы прочитать про один аппарат. «цв.» там, где узнают, —
 * «Цветная» там, где разбираются.
 *
 * Показываются ВСЕ характеристики типа, а не только помеченные для списка: `showInList` отвечает на
 * вопрос «что помещается в строку таблицы», а карточка — место, где помещается всё.
 *
 * Пустой набор — не «нет данных», а «у этого типа таких вопросов не задают» (Р4): у монитора блока
 * нет вовсе. Незаполненное значение, наоборот, называется вслух — «н/д»: вопрос законен, и по
 * пустому месту его не задать.
 */
export function OfficeEquipmentSpecsView({ specs }: { specs: OfficeEquipmentModelSpecDto[] }) {
  if (specs.length === 0) return null;
  return (
    <>
      {specs.map((spec) => (
        <div key={spec.specId}>
          <Typography.Text type="secondary">{spec.name}: </Typography.Text>
          {spec.value ? (
            <Typography.Text>{spec.value.name}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">{OFFICE_EQUIPMENT_SPEC_UNKNOWN}</Typography.Text>
          )}
        </div>
      ))}
    </>
  );
}
