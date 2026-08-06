import { useCallback, useEffect } from 'react';
import { App } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';

/** Имя параметра адреса, которым названа открытая карточка: `?tab=routes&open=<id>`. */
export const OPEN_PARAM = 'open';

interface Options<T> {
  /**
   * Открыта ли сейчас та вкладка, которая спрашивает. Скрытые вкладки остаются смонтированными,
   * и без этого признака соседние списки открыли бы карточку по чужому идентификатору.
   */
  active: boolean;
  /** Ключ запроса записи. Тот же, которым её грузят остальные — тогда запрос будет один. */
  queryKey: (id: string) => readonly unknown[];
  fetch: (id: string) => Promise<T>;
}

/**
 * Карточка, названная в адресе страницы. Ею сделан переход по номеру сущности из соседнего
 * раздела: ссылка переключает вкладку и говорит, что на ней открыть.
 *
 * Запись спрашивается по идентификатору, а не берётся из строки списка: заявка, на которую
 * ведёт маршрут, может лежать на другой странице списка, под другим фильтром или вовсе в другой
 * вкладке — и требовать, чтобы она нашлась в загруженном списке, значило бы открывать карточку
 * через раз. Не нашлась на сервере — адрес чистится, иначе он открывал бы пустоту при каждом
 * возвращении.
 */
export function useOpenedRecord<T>({ active, queryKey, fetch }: Options<T>): {
  /**
   * Идентификатор из адреса — он известен раньше самой записи. Им открывают окна, умеющие
   * грузить себя сами (карточка рейса): ждать ответа, чтобы показать окно, которое всё равно
   * покажет ожидание, значит задержать открытие на пустом месте.
   */
  id: string | null;
  record: T | null;
  clear: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const id = active ? searchParams.get(OPEN_PARAM) : null;

  /**
   * Закрытие карточки убирает параметр заменой записи в истории, а не новым переходом: «назад»
   * после этого возвращает туда, откуда пришли по ссылке, а не открывает карточку заново.
   */
  const clear = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(OPEN_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const { data, error } = useQuery({
    queryKey: queryKey(id ?? ''),
    queryFn: () => fetch(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (!error) return;
    message.error('Запись не найдена');
    clear();
  }, [error, message, clear]);

  return { id, record: id ? (data ?? null) : null, clear };
}
