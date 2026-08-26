import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { TicketAuditPeriod } from '@technic/contracts';
import { PAGE_PARAM } from './eventFilters';
import { AUDIT_PARAM, AUDIT_PARAMS, FROM_PARAM, TO_PARAM, readTicketAuditPeriod } from './period';
import {
  DEFAULT_TICKET_AUDIT_VIEW,
  VIEW_PARAM,
  readTicketAuditView,
  type TicketAuditView,
} from './view';

export interface TicketAuditApi {
  /** Окно открыто: параметр стоит в адресе. */
  opened: boolean;
  /** Период из адреса; его нет или он испорчен — умолчание в тридцать дней. */
  period: TicketAuditPeriod;
  /** Экран из адреса; его нет или он незнаком — сводка. */
  view: TicketAuditView;
  open: () => void;
  close: () => void;
  setPeriod: (period: TicketAuditPeriod) => void;
  setView: (view: TicketAuditView) => void;
}

/**
 * Состояние окна аудита — сам адрес, и ничего кроме (ADR 0120).
 *
 * Продублируй мы его React-состоянием, «назад» разошлась бы с экраном на первом же переходе, а
 * ссылку «вот эти числа за эти дни», которую пересылают и кладут в закладку, было бы неоткуда
 * взять. Период там же и по той же причине: отчёт без периода — не отчёт, и ссылка, открывающая
 * окно на других тридцати днях, показала бы собеседнику не то, о чём речь.
 */
export function useTicketAudit(): TicketAuditApi {
  const [searchParams, setSearchParams] = useSearchParams();

  const opened = searchParams.get(AUDIT_PARAM) !== null;
  // Период пересчитывается только при смене самих границ: объект уходит в ключ запроса, и новая
  // ссылка на те же даты гасила бы кэш на каждой перерисовке страницы под окном.
  const from = searchParams.get(FROM_PARAM);
  const to = searchParams.get(TO_PARAM);
  const period = useMemo(() => readTicketAuditPeriod(from, to), [from, to]);
  const view = readTicketAuditView(searchParams.get(VIEW_PARAM));

  /**
   * Открытие — обычная запись в историю: от «назад» здесь ждут закрытия окна, а не ухода с
   * реестра. Период в адрес не пишется: умолчание не выбор человека, и записанное, оно
   * состарилось бы в первой же пересланной ссылке — «последние 30 дней» превратились бы в
   * «те тридцать дней, когда её отправили».
   */
  const open = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(AUDIT_PARAM, '1');
      return next;
    });
  }, [setSearchParams]);

  /**
   * Закрытие убирает только свои ключи: под окном остался реестр со своей вкладкой, открытой
   * карточкой и фильтрами. Заменой записи в истории — «назад» после крестика или Esc возвращает
   * туда, откуда пришли, а не открывает окно заново.
   */
  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const name of AUDIT_PARAMS) next.delete(name);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  /**
   * Смена периода — замена записи: перебор дат кнопками календаря иначе раздул бы историю так,
   * что «назад» перестала бы выводить из окна.
   *
   * Страница ленты при этом сбрасывается: период — такое же сужение выборки, как фильтр, и пятая
   * страница прежних дней в новых показывает другие события, а чаще пустоту. Ключ снимается здесь,
   * а не внутри ленты: период меняют полосой, общей для всех трёх экранов, и лента о её нажатии не
   * узнаёт вовсе.
   */
  const setPeriod = useCallback(
    (next: TicketAuditPeriod) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set(AUDIT_PARAM, '1');
          params.set(FROM_PARAM, next.from);
          params.set(TO_PARAM, next.to);
          params.delete(PAGE_PARAM);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /**
   * Смена экрана — тоже замена записи, и по той же причине, что смена периода: экраны перебирают
   * глазами, а не решением, и десяток нажатий переключателя иначе завалил бы «назад» так, что
   * выйти из окна ею стало бы нельзя.
   *
   * Период при этом сохраняется целиком: это один отчёт, показанный с двух сторон, и уехавшие при
   * переключении даты означали бы, что рядом стоят числа за разное время.
   *
   * Умолчание в адрес не пишется: `view=summary` — не выбор человека, а состояние по умолчанию, и
   * записанное оно застыло бы в пересланной ссылке. Поменяй мы умолчание позже (экранов будет
   * пять), старые ссылки открывались бы не тем, чем открывается портал сегодня.
   */
  const setView = useCallback(
    (next: TicketAuditView) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set(AUDIT_PARAM, '1');
          if (next === DEFAULT_TICKET_AUDIT_VIEW) params.delete(VIEW_PARAM);
          else params.set(VIEW_PARAM, next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { opened, period, view, open, close, setPeriod, setView };
}
