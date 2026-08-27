import { useEffect, useRef } from 'react';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';

/**
 * Снятие отборов, указывающих на то, чего в списке выбора больше нет (ADR 0139).
 *
 * Понадобилось вместе с памятью отборов. Пока отбор жил один сеанс, сослаться на исчезнувшее он
 * не мог: значение бралось из того же перечня, что и рисовалось. Сохранённый набор живёт дольше
 * справочника — объект закрывают, отдел выключают, подрядчика приостанавливают, — и восстановленный
 * отбор оставляет человека с пустым списком, а в поле показывает сырой идентификатор: прочитать
 * его нельзя, догадаться о причине пустоты — тем более.
 *
 * Поэтому «нет в перечне выбора» здесь означает «снять», а не только «удалено». Отдел, выбывший
 * из списка действующих, для этого поля неотличим от удалённого: выбрать его заново нельзя, и
 * держать в отборе значение, которого человек не видит, — худший из двух вариантов.
 */
export interface FilterOptionsCheck {
  /** Ключ параметра списка — его же снимет `clear`. */
  key: string;
  value: string | undefined;
  options: readonly { value: string }[];
  /**
   * Перечень получен. До ответа сервера он пуст, и без этого признака первый же рендер снёс бы
   * все восстановленные отборы разом. Закрытый правом перечень (типы техники у сервисной
   * компании) не приходит вовсе — значит и судить по нему нельзя.
   */
  ready: boolean;
}

export function usePruneMissingFilters(
  checks: readonly FilterOptionsCheck[],
  clear: (keys: string[]) => void,
): void {
  const missing = checks
    .filter((check) => {
      if (!check.ready || check.value === undefined) return false;
      // Перечень пришёл целой страницей: справочник в него не поместился, и «не нашлось» здесь
      // означает «не показали», а не «не существует».
      if (check.options.length >= DICTIONARY_PAGE_SIZE) return false;
      return !check.options.some((option) => option.value === check.value);
    })
    .map((check) => check.key);

  /** Строкой, а не массивом: массив пересобирается на каждый рендер, и эффект шёл бы по кругу. */
  const signature = missing.join(',');
  const clearRef = useRef(clear);
  clearRef.current = clear;

  useEffect(() => {
    if (!signature) return;
    clearRef.current(signature.split(','));
  }, [signature]);
}
