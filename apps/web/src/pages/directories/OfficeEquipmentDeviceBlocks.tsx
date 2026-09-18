import type { OfficeEquipmentDto } from '@technic/contracts';
import { DeviceTelemetryBlock } from '@features/device-telemetry';
import { DeviceIdentityCardBlock } from '@features/device-mail-identities';

/**
 * Что аппарат рассказал о себе письмами — две части карточки, стоящие рядом (планы
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, и
 * `docs/office-equipment-mail-identity-ui-plan.md`, §7).
 *
 * СВОИМ ФАЙЛОМ, А НЕ ДВУМЯ СТРОКАМИ В КАРТОЧКЕ. Причина в бюджете длины файла: карточка
 * справочника и без того на границе, и каждая новая часть выталкивала бы её за неё. Заодно обе
 * части оказались рядом с объяснением, почему они здесь:
 *
 * - показания и события стоят в карточке, а не внутри истории обслуживания: та возвращает `null`
 *   без права на заявки, и телеметрия исчезла бы у читателя справочника;
 * - ключи опознания вносятся, не дожидаясь письма, — это главная дверь для парка в три сотни
 *   карточек; своё право блок спрашивает сам.
 */
export function OfficeEquipmentDeviceBlocks({ equipment }: { equipment: OfficeEquipmentDto }) {
  return (
    <>
      <DeviceTelemetryBlock equipmentId={equipment.id} />
      <DeviceIdentityCardBlock equipment={equipment} />
    </>
  );
}
