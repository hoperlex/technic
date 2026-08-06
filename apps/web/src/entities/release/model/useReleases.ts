import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReleaseDto } from '@technic/contracts';
import { releasesQuery } from '../api/queries';

/**
 * Отметка прочитанного — в браузере, а не в БД (ADR 0077): хранится `seq` последнего открытого
 * выпуска, «есть новое» — сравнение двух чисел. Цена решения честная: на другом устройстве точка
 * загорится снова.
 *
 * Имя ключа той же формы, что у свёрнутости панели (`technic:sider-collapsed`): префикс портала
 * отделяет наши ключи от чужих, если домен когда-нибудь придётся делить.
 */
const SEEN_STORAGE_KEY = 'technic:changelog-seen';

/**
 * localStorage недоступен в приватном режиме части браузеров, а число в нём набрано не нами —
 * пережить оба случая должен один ответ: «не видел ничего». Лишняя точка в меню — вся цена ошибки.
 */
function readSeen(): number {
  try {
    const stored = Number(localStorage.getItem(SEEN_STORAGE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

function writeSeen(seq: number): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, String(seq));
  } catch {
    /* отметка не переживёт перезагрузку — точка загорится снова */
  }
}

/**
 * Отметка, какой она была на загрузке вкладки. Снимается один раз на модуль, а не внутри хука, и
 * это не микрооптимизация: отметка ставится при ОТКРЫТИИ окна, и любое чтение хранилища после
 * этого вернуло бы уже новое значение — теги «новое» погасли бы ровно в тот момент, когда выпуск
 * начали читать. Заморозив её здесь, мы не зависим от того, когда смонтировался очередной
 * потребитель хука.
 */
const unseenSince = readSeen();

export interface ReleaseNews {
  /** Выпуски, новейший первым; пустой массив — и пока список не доехал, и когда журнал пуст. */
  releases: ReleaseDto[];
  isLoading: boolean;
  isError: boolean;
  /** Есть непрочитанное — точка в меню. Гаснет сразу, как окно открыли. */
  hasNews: boolean;
  /** Граница новизны для тега в окне: выпуски новее уже виденного на момент загрузки вкладки. */
  unseenSince: number;
  /** Поставить отметку. Зовёт тот, кто открывает окно, — не само окно. */
  markSeen: () => void;
}

/**
 * Журнал обновлений и отметка прочитанного одним хуком: иначе каркас и окно считали бы «есть
 * новое» каждый по-своему, а разошедшиеся правила видно только тогда, когда точка перестаёт
 * гаснуть.
 *
 * Запрос у всех потребителей общий — ключ один, и TanStack Query сводит их к одному обращению;
 * состояние отметки у каждого своё, но живому значению верит только `hasNews`, а `unseenSince`
 * заморожен на модуле и у всех одинаков.
 */
export function useReleases(): ReleaseNews {
  const { data, isLoading, isError } = useQuery(releasesQuery());
  const releases = data ?? [];
  const [seen, setSeen] = useState(unseenSince);
  const latestSeq = releases[0]?.seq ?? 0;

  const markSeen = useCallback(() => {
    // Пока список не доехал, отмечать нечего: запись нуля стёрла бы прежнюю отметку, и на
    // следующем входе портал заново предложил бы прочитать всё.
    if (latestSeq === 0) return;
    writeSeen(latestSeq);
    setSeen(latestSeq);
  }, [latestSeq]);

  return {
    releases,
    isLoading,
    isError,
    hasNews: latestSeq > seen,
    unseenSince,
    markSeen,
  };
}
