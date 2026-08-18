import type { CreateManualInput, ManualDto, UpdateManualInput } from '@technic/contracts';
import { createListApi, createRemoveApi, createWriteApi } from '@shared/api';

/**
 * Руководства пользователя (`docs/manuals-plan.md`): портал хранит не документ, а строку со
 * ссылкой на него во внешнем хранилище.
 *
 * Список читают все вошедшие, а ведёт его держатель `manuals.manage` — маршрут при этом один, и
 * режима у него два: без права `isActive` в запросе не слушается вовсе (ADR 0021, план §3.2).
 *
 * Удаление настоящее и отвечает `{ ok }`, а не карточкой: возвращать после `DELETE` нечего, и
 * второго шага вроде `purge` у руководства нет — ссылок на строку не бывает, восстанавливать
 * нечего, ошибочно вставленную ссылку убирает тот же, кто её вставил (план §3.4).
 */
export const manualsApi = {
  ...createListApi<ManualDto>('/manuals'),
  ...createWriteApi<ManualDto, CreateManualInput, UpdateManualInput>('/manuals'),
  ...createRemoveApi<{ ok: boolean }>('/manuals'),
};
