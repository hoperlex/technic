import type {
  CounterpartyDto,
  CreateCounterpartyInput,
  ListResult,
  UpdateCounterpartyInput,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Справочник контрагентов (ADR 0010, ADR 0038): карточка организации, с которой портал имеет дело
 * в любой из её ролей — заказчик работ, оператор вывоза, арендодатель, поставщик, сервисная
 * компания. Ручки общие на все роли сразу, потому что запись одна: роль задаётся типом карточки, а
 * не отдельным справочником на модуль, и почему тип у записи ровно один — в
 * `packages/contracts/src/counterparties.ts`.
 */
export const counterpartiesApi = {
  list: (q: Query) => apiFetch<ListResult<CounterpartyDto>>('/counterparties', { query: q }),
  create: (body: CreateCounterpartyInput) =>
    apiFetch<CounterpartyDto>('/counterparties', { method: 'POST', body }),
  update: (id: string, body: UpdateCounterpartyInput) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/counterparties/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива (ADR 0060). */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/counterparties/${id}/purge`, { method: 'DELETE' }),
};
