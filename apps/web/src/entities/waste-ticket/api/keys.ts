import { createQueryKeys } from '@shared/api';

/**
 * Ключи запросов разбора талонов.
 *
 * Список талонов держится за заявкой: экран разбора открывается из карточки, и обновиться после
 * подтверждения обязан именно он. Состояние подсистемы, наоборот, общее на портал — баннер один и
 * тот же над карточкой и над реестром, и спрашивать его дважды незачем.
 */
export const wasteTicketKeys = createQueryKeys('waste-tickets', {
  list: (requestId: string) => ['list', requestId],
  health: () => ['health'],
});
