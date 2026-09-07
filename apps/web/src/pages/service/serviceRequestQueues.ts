import type { Dispatch, SetStateAction } from 'react';
import type { BaseParams } from '@shared/lib';
import type { ServiceListFilters } from './serviceRequestFilters';
import { useAuth } from '../../auth/AuthContext';

/**
 * Очереди-пресеты над таблицей заявок (§9.2): с них начинают работу оператор и сервис.
 *
 * ОБЕ ПОЛОВИНЫ ПРЕСЕТА — В ОДНОМ МЕСТЕ, и в этом весь модуль. Половин у него две: какие очереди
 * бывают и кому какая положена — раз, и как выбранная очередь ложится в параметры запроса — два.
 * Жили они порознь: перечень — рядом с отборами (те же параметры `waitingOnMe`, `urgent`,
 * `awaitingDocuments`, то же правило «кому положено»), а раскладка — в самой странице. Связь между
 * ними держалась на внимательности: добавленная очередь без своей строки в раскладке становится
 * кнопкой, которая переключается, ничего не меняя, — и заметить это можно только глазами.
 *
 * Соседство с отборами при этом не потеряно: перечень по-прежнему не в странице, а рядом с
 * `serviceRequestFilters` — файлом, который отвечает на тот же вопрос про отборы.
 */

/** Готовый переключатель очередей: перечень, выбранное и запись выбора в параметры списка. */
export interface ServiceQueueControl {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string | number) => void;
}

export function useServiceQueue({
  params,
  setParams,
}: {
  params: BaseParams & ServiceListFilters;
  setParams: Dispatch<SetStateAction<BaseParams & ServiceListFilters>>;
}): ServiceQueueControl {
  const { can } = useAuth();
  const options = [
    { value: 'all', label: 'Все заявки' },
    { value: 'waiting', label: 'Требуют решения' },
    // Срочные — вход, а не фильтр: с них начинают день, и прятать их в шит значило бы прятать саму
    // работу (план модернизации, Р56).
    { value: 'urgent', label: 'Срочные' },
    // Та же дверь, что и у одноимённого отбора, и по той же причине (ADR 0160, решение 9): без
    // субъектного `serviceRequests.finance` сервер параметр молча игнорирует, и пресет был бы
    // кнопкой, которая переключается, ничего не меняя.
    ...(can('serviceRequests.finance')
      ? [{ value: 'documents', label: 'Ожидаются документы' }]
      : []),
  ];

  /**
   * Выбранная очередь читается ИЗ ПАРАМЕТРОВ, а не хранится рядом с ними: второе состояние для
   * того же факта разошлось бы с первым — набор переживает перезагрузку (ADR 0139), и после неё
   * переключатель показывал бы «Все заявки» над списком, отобранным вчерашней очередью.
   */
  const value =
    params.waitingOnMe === 'true'
      ? 'waiting'
      : params.urgent === 'true'
        ? 'urgent'
        : params.awaitingDocuments === 'true'
          ? 'documents'
          : 'all';

  // Очередь ровно одна: выбор пресета снимает два соседних параметра, а не дописывает третий —
  // иначе «Срочные» поверх «Требуют решения» дали бы конъюнкцию, о которой никто не просил.
  const onChange = (next: string | number) =>
    setParams((p) => ({
      ...p,
      waitingOnMe: next === 'waiting' ? 'true' : undefined,
      urgent: next === 'urgent' ? 'true' : undefined,
      awaitingDocuments: next === 'documents' ? 'true' : undefined,
      page: 1,
    }));

  return { options, value, onChange };
}
