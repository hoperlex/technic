import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ServiceChatMessageDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { useServiceChatInvalidate } from './invalidate';

/** Как часто открытое окно спрашивает новое (§3.6): опрос инкрементальный, по `afterSeq`. */
const POLL_MS = 20_000;

export interface ServiceChatFeedState {
  /** Лента по возрастанию номера: `seq` детерминирован, `createdAt` совпадает до микросекунды. */
  items: ServiceChatMessageDto[];
  /** Есть ли что подгружать вверх. */
  hasMore: boolean;
  loadOlder: () => void;
  loadingOlder: boolean;
  /**
   * Докуда было дочитано на МОМЕНТ ОТКРЫТИЯ окна: по этой границе рисуется полоса «Новые».
   * Заморожена намеренно — курсор сдвигается сразу после показа, и живое значение утащило бы
   * полосу вниз прямо на глазах у читателя.
   */
  newFromSeq: number;
  isPending: boolean;
  isError: boolean;
  /** Своя отправленная реплика: показывается сразу, не дожидаясь следующего опроса. */
  append: (message: ServiceChatMessageDto, lastSeq: number) => void;
}

/** Слияние по номеру: страницы перекрываются (опрос + инвалидация головы), дубль в ленте недопустим. */
function mergeBySeq(...parts: readonly ServiceChatMessageDto[][]): ServiceChatMessageDto[] {
  const by = new Map<number, ServiceChatMessageDto>();
  for (const part of parts) for (const item of part) by.set(item.seq, item);
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Лента обсуждения одной заявки: загрузка, подгрузка вверх, инкрементальный опрос и курсор
 * прочтения (ADR 0141, §3.4 и §3.6 плана).
 *
 * **Курсор двигается только после успешного показа и только у видимой вкладки.** Это не
 * осторожность, а два случая, каждый из которых теряет сообщение молча: отметка при открытии
 * гасит разговор, которого человек не увидел (загрузка упала), а открытое в соседней вкладке окно
 * гасило бы метку у того, кто на него не смотрит. Отсюда `head.isSuccess` и `visibilityState`
 * в условии — и подписка на `visibilitychange`: вернувшись к вкладке, человек её и прочитал.
 *
 * **Подтверждается `lastSeq`, а не «последняя показанная реплика».** Прочтение здесь — «открыл
 * окно, прочитал заявку» (решение опроса), и сервер сам сторожит границу `0 ≤ throughSeq ≤ lastSeq`,
 * отвечая 422 на попытку загнать курсор в будущее.
 */
export function useServiceChatFeed(requestId: string): ServiceChatFeedState {
  const invalidate = useServiceChatInvalidate();

  /**
   * Голова ленты — последние 50 реплик. Через `useQuery`, а не эффектом: её гасит инвалидация
   * после отправки (в том числе чужой — из соседнего окна той же вкладки), и перезапрос обязан
   * идти тем же путём, что и у прочих запросов портала.
   */
  const head = useQuery({
    queryKey: serviceRequestKeys.chat(requestId),
    queryFn: () => serviceRequestsApi.chatPage(requestId),
  });

  /** Подгруженное вверх и пришедшее опросом — своим состоянием: в кэше головы их не место. */
  const [older, setOlder] = useState<ServiceChatMessageDto[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [newer, setNewer] = useState<ServiceChatMessageDto[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [readThroughSeq, setReadThroughSeq] = useState(0);
  /** Граница «Новых», снятая с первого успешного ответа и больше не меняющаяся. */
  const newFrom = useRef<number | null>(null);
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const page = head.data;
  /*
   * Граница «Новых» снимается ПРЯМО ПРИ ПОКАЗЕ, а не эффектом после него: запись в ref
   * перерисовки не вызывает, и первый кадр ленты нарисовался бы с границей «ничего не прочитано» —
   * полоса стояла бы над самой старой репликой и прыгала на глазах у читателя. Присваивание
   * идемпотентно (`null` → значение один раз), поэтому повторный рендер его не сдвинет.
   */
  if (page && newFrom.current === null) newFrom.current = page.readThroughSeq;
  useEffect(() => {
    if (!page) return;
    setLastSeq((prev) => Math.max(prev, page.lastSeq));
    setReadThroughSeq((prev) => Math.max(prev, page.readThroughSeq));
  }, [page]);

  const items = useMemo(
    () => mergeBySeq(older, page?.items ?? [], newer),
    [older, page, newer],
  );

  // ── Подгрузка вверх ──
  /*
   * Мутацией, а не вторым `useQuery`: страница «до самой старой показанной» — это действие
   * человека, а не состояние экрана. Запрос с ключом-курсором завёл бы в кэше по записи на каждое
   * нажатие, и гасить их после отправки пришлось бы перебором; ответ же нужен ровно один раз —
   * дальше он живёт в ленте.
   */
  const oldestSeq = items[0]?.seq;
  const olderQuery = useMutation({
    mutationFn: () => serviceRequestsApi.chatPage(requestId, { beforeSeq: oldestSeq }),
    onSuccess: (loaded) => {
      setOlder((prev) => mergeBySeq(prev, loaded.items));
      setOlderHasMore(loaded.hasMore);
    },
  });
  const loadOlderMutate = olderQuery.mutate;
  const loadOlder = useCallback(() => loadOlderMutate(), [loadOlderMutate]);

  // ── Инкрементальный опрос ──
  /**
   * Номер читается через ref, а не из замыкания: иначе таймер пересоздавался бы на каждую
   * пришедшую реплику, и отсчёт двадцати секунд начинался бы заново — при живой переписке опрос
   * не случился бы ни разу.
   */
  const lastSeqRef = useRef(lastSeq);
  lastSeqRef.current = lastSeq;
  useEffect(() => {
    const timer = setInterval(() => {
      void serviceRequestsApi
        .chatPage(requestId, { afterSeq: lastSeqRef.current || undefined })
        .then((fresh) => {
          if (fresh.items.length > 0) setNewer((prev) => mergeBySeq(prev, fresh.items));
          setLastSeq((prev) => Math.max(prev, fresh.lastSeq));
        })
        // Провалившийся опрос — не событие для человека: следующий придёт через двадцать секунд, а
        // тост об этом сыпался бы поверх открытой переписки при первом же обрыве сети.
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [requestId]);

  // ── Курсор прочтения ──
  const markRead = useMutation({
    mutationFn: (throughSeq: number) =>
      serviceRequestsApi.markChatRead(requestId, { throughSeq }),
    onSuccess: (result) => {
      setReadThroughSeq((prev) => Math.max(prev, result.readThroughSeq));
      // Метка строки, счётчик кнопки и бейдж раздела считаются по курсору — все трое устарели.
      invalidate(requestId);
    },
  });

  /** Что уже подтверждено этим окном: повторный `POST` на тот же номер не несёт ничего нового. */
  const confirmed = useRef(0);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (!head.isSuccess || !visible) return;
    if (lastSeq <= 0 || lastSeq <= readThroughSeq || lastSeq <= confirmed.current) return;
    confirmed.current = lastSeq;
    markReadMutate(lastSeq);
  }, [head.isSuccess, visible, lastSeq, readThroughSeq, markReadMutate]);

  const append = useCallback((message: ServiceChatMessageDto, freshLastSeq: number) => {
    setNewer((prev) => mergeBySeq(prev, [message]));
    setLastSeq((prev) => Math.max(prev, freshLastSeq));
  }, []);

  return {
    items,
    hasMore: olderHasMore ?? page?.hasMore ?? false,
    loadOlder,
    loadingOlder: olderQuery.isPending,
    newFromSeq: newFrom.current ?? 0,
    isPending: head.isPending,
    isError: head.isError,
    append,
  };
}
