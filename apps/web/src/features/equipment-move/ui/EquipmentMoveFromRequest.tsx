import { useQuery } from '@tanstack/react-query';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { EquipmentMoveModal } from './EquipmentMoveModal';

/**
 * Перемещение, начатое из карточки заявки (план модернизации, Р61): «технику увезли в сервис»,
 * «техника вернулась» и — с плана `docs/office-equipment-move-from-request-plan.md` — «заявитель
 * сказал, что аппарат стоит не там».
 *
 * Ход заявки состояние единицы **не меняет автоматически**: чинят и на месте, а «в ремонте» бывает
 * и без заявки в портале. Но предлагать записать переезд там, где о нём как раз узнают, — правильно:
 * иначе состояние обновляют «когда вспомнят», то есть никогда.
 *
 * ОБЕ СТОРОНЫ ДОГРУЖАЮТСЯ ПО ИДЕНТИФИКАТОРУ, и по одной и той же причине — показанное должно быть
 * свежим, а не снимком:
 *
 * - карточка единицы: заявка хранит снимок реквизитов (Р10), а окну перемещения нужно текущее
 *   место — снимок годовой давности отправил бы технику обратно в кабинет, из которого её увезли;
 * - сама заявка: признак расхождения (`objectMismatch`) сервер ВЫЧИСЛЯЕТ соединением с карточкой
 *   техники (Р16 ADR 0145) и гасит подтверждающим перемещением (Р8), — то есть строка списка,
 *   открытая полчаса назад, предложила бы подтвердить место по заявлению, разобранному соседом.
 *
 * Второго запроса это обычно не стоит: карточка заявки спрашивает её тем же ключом
 * (`serviceRequestKeys.detail`), и окно, открытое из неё, берёт готовый ответ из кэша.
 *
 * Окно открывается, когда доехали обе стороны (`isFetched`, а не `data`: отказ по заявке —
 * не повод не дать записать переезд, у него просто не будет баннера). Иначе подстановка
 * заявленного места приехала бы ПОСЛЕ того, как человек начал заполнять форму, и переписала бы
 * введённое.
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
  const { data: request, isFetched } = useQuery({
    queryKey: serviceRequestKeys.detail(serviceRequestId),
    queryFn: () => serviceRequestsApi.get(serviceRequestId),
    enabled: open,
  });

  const ready = open && !!data && isFetched;

  return (
    <EquipmentMoveModal
      equipment={ready ? data : null}
      serviceRequestId={serviceRequestId}
      request={request ?? null}
      onClose={onClose}
    />
  );
}
