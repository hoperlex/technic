import { useQuery } from '@tanstack/react-query';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { EquipmentMoveModal } from './EquipmentMoveModal';

/**
 * Перемещение, начатое из карточки заявки (план модернизации, Р61): «технику увезли в сервис» и
 * «техника вернулась».
 *
 * Ход заявки состояние единицы **не меняет автоматически**: чинят и на месте, а «в ремонте» бывает
 * и без заявки в портале. Но предлагать записать переезд там, где о нём как раз узнают, — правильно:
 * иначе состояние обновляют «когда вспомнят», то есть никогда.
 *
 * Карточка единицы догружается по идентификатору: заявка хранит снимок реквизитов (Р10), а окну
 * перемещения нужно текущее место — снимок годовой давности отправил бы технику обратно в кабинет,
 * из которого её увезли.
 */
export function EquipmentMoveFromRequest({
  equipmentId,
  serviceRequestId,
  open,
  onClose,
}: {
  equipmentId: string;
  serviceRequestId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data } = useQuery({
    queryKey: officeEquipmentKeys.detail(equipmentId),
    queryFn: () => officeEquipmentApi.get(equipmentId),
    enabled: open,
  });

  return (
    <EquipmentMoveModal
      equipment={open ? (data ?? null) : null}
      serviceRequestId={serviceRequestId}
      onClose={onClose}
    />
  );
}
