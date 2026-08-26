import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  FIRST_PAGE,
  PAGE_PARAM,
  readTicketAuditEventFilters,
  readTicketAuditEventsPage,
  writeTicketAuditEventFilters,
  type TicketAuditEventFilters,
} from './eventFilters';
import { AUDIT_PARAM } from './period';

export interface TicketAuditEventsApi {
  /** Отбор из адреса; испорченные значения кончаются отсутствием фильтра, а не пустой лентой. */
  filters: TicketAuditEventFilters;
  page: number;
  setFilters: (filters: TicketAuditEventFilters) => void;
  setPage: (page: number) => void;
}

/**
 * Отбор ленты — сам адрес, как период и экран у окна (ADR 0120).
 *
 * Отдельным хуком от `useTicketAudit`, а не полем в нём: период и экран есть у всего окна, а
 * фильтры принадлежат одному экрану из трёх. Живи они в общем хуке, каждая правка фильтра
 * перерисовывала бы сводку и когорты, а сам хук знал бы про экран, которого может и не быть
 * открыто.
 */
export function useTicketAuditEvents(): TicketAuditEventsApi {
  const [searchParams, setSearchParams] = useSearchParams();

  // Объект отбора уходит в ключ запроса: новая ссылка на те же значения гасила бы кэш при каждой
  // перерисовке страницы под окном.
  const filters = useMemo(() => readTicketAuditEventFilters(searchParams), [searchParams]);
  const page = readTicketAuditEventsPage(searchParams.get(PAGE_PARAM));

  /**
   * Смена отбора — замена записи в истории: фильтры перебирают глазами, и десяток нажатий иначе
   * завалил бы «назад» так, что выйти ею из окна стало бы нельзя (то же решение у периода и
   * переключателя экранов).
   *
   * Страница при этом сбрасывается. Пятая страница прежней выборки в новом отборе показывает уже
   * другие события, а чаще — пустоту, и читается она как «ничего не нашлось», хотя нашлось.
   */
  const setFilters = useCallback(
    (next: TicketAuditEventFilters) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set(AUDIT_PARAM, '1');
          writeTicketAuditEventFilters(params, next);
          params.delete(PAGE_PARAM);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /**
   * Листание — тоже замена записи. Первая страница из адреса убирается: `page=1` не выбор
   * человека, а состояние по умолчанию, и записанное оно только удлиняет пересылаемую ссылку.
   */
  const setPage = useCallback(
    (next: number) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set(AUDIT_PARAM, '1');
          if (next <= FIRST_PAGE) params.delete(PAGE_PARAM);
          else params.set(PAGE_PARAM, String(next));
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { filters, page, setFilters, setPage };
}
