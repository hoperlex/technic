import type { ReactNode } from 'react';
import { Button, Empty, Spin } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { EquipmentBlockPageDto } from '@technic/contracts';

/**
 * Общая механика трёх бизнес-блоков истории (план
 * `docs/office-equipment-history-blocks-plan.md`, Р11): страница с курсором и кнопка «Показать
 * ещё».
 *
 * Общего у блоков ровно столько — строки, признак «есть ещё» и курсор продолжения (форма
 * `EquipmentBlockPageDto`). Ни колонок, ни подписи пустоты здесь нет намеренно: они у каждого
 * блока свои, и «универсальная таблица блока» через месяц обросла бы флагами на каждое отличие.
 *
 * Порядок и курсор считает сервер, портал только просит следующую страницу и складывает
 * полученное — второй сортировки на клиенте у блоков нет вовсе (Р8).
 */
export interface EquipmentBlockPages<T> {
  items: T[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

export function useEquipmentBlockPages<T>({
  queryKey,
  load,
  pageSize,
  enabled = true,
}: {
  queryKey: readonly unknown[];
  load: (query: { cursor?: string; pageSize: number }) => Promise<EquipmentBlockPageDto<T>>;
  /** Сколько строк просить: у вкладки окна — страница, у секции карточки — первые пять (Р7). */
  pageSize: number;
  /**
   * Спрашивать ли вообще. Нужно там, где право решает судьбу целого блока: секция карточки стоит
   * у человека без `serviceRequests.read` тоже, и её запрос ушёл бы за `403` (Р1). Вкладке окна
   * этот признак не нужен — её у такого читателя нет вовсе.
   */
  enabled?: boolean;
}): EquipmentBlockPages<T> {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => load(pageParam ? { cursor: pageParam, pageSize } : { pageSize }),
    initialPageParam: '',
    // `nextCursor: null` — дальше ничего нет; `undefined` для react-query значит то же самое.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });

  return {
    items: (data?.pages ?? []).flatMap((page) => page.items),
    isLoading,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  };
}

/**
 * Оболочка вкладки: ожидание, объяснённая пустота и «Показать ещё» под содержимым.
 *
 * Подпись пустоты приходит снаружи и обязана быть словами, а не прочерком: «заявок не было» и
 * «заявки есть, но их не положено видеть» — разные утверждения (Р11). Второе портал не показывает
 * вовсе — вкладки у такого читателя нет, — а первое обязано звучать именно так, иначе пустая
 * таблица читается как поломка.
 */
export function EquipmentBlockView({
  pages,
  empty,
  children,
}: {
  pages: EquipmentBlockPages<unknown>;
  empty: ReactNode;
  children: ReactNode;
}) {
  if (pages.isLoading) return <Spin />;
  if (pages.items.length === 0)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />;

  return (
    <>
      {children}
      {pages.hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button onClick={pages.loadMore} loading={pages.isLoadingMore}>
            Показать ещё
          </Button>
        </div>
      )}
    </>
  );
}
