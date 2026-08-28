import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { serviceRequestKeys } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';

/**
 * Что устаревает от реплики и от сдвига курсора — явным списком (§3.7 плана).
 *
 * Без этого списка кнопка карточки, метка строки и бейдж раздела показывают три разных числа:
 * блок `chat` приходит и в списке, и в карточке, счётчик бейджа — своей ручкой, а лента — третьей.
 *
 * Лента и счётчик — семейства того же корня заявок, и `serviceRequestKeys.root` их уже накрывает.
 * Названы они всё равно: этот список — ответ на вопрос «что перестало быть правдой», и переехав
 * лента в свой корень (обсуждение, открытое вне списка заявок), молчание здесь стоило бы окну
 * обновления, которого никто не хватится до жалобы.
 *
 * `officeEquipmentKeys.root` — не лишний: карточка единицы собирает заявки join-ом на лету
 * (`entities/service-request/api/keys.ts`), и её содержимое меняется от каждого действия по заявке.
 * Тот же набор гасят все прочие мутации заявки.
 */
export function useServiceChatInvalidate(): (requestId?: string) => void {
  const qc = useQueryClient();
  return useCallback(
    /** Без заявки — «прочитано всё по отбору»: там устарела каждая лента, и её накрывает корень. */
    (requestId?: string) => {
      if (requestId) void qc.invalidateQueries({ queryKey: serviceRequestKeys.chat(requestId) });
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.chatUnreadCount() });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
    },
    [qc],
  );
}
