import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

interface Options {
  /** Что удаляем — подставляется в заголовок подтверждения: «объект „Восток“». */
  subject: string;
  /** Ручка справочника: `…Api.purge`. */
  purge: (id: string) => Promise<unknown>;
  /**
   * Ключи запросов, которые после удаления устарели. Принимается `readonly`: ключи приходят из
   * реестра сущности, где заморожены намеренно — случайная запись в общий массив испортила бы
   * ключи всей сущности разом.
   */
  invalidate: readonly unknown[];
}

interface PurgeAction {
  /** Есть ли у учётки право `records.purge`: без него кнопку не показывают. */
  allowed: boolean;
  pending: boolean;
  /** Спрашивает подтверждение и удаляет запись насовсем. */
  confirm: (id: string, name: string) => void;
}

/**
 * Окончательное удаление записи справочника (ADR 0060) — одинаково во всех вкладках.
 *
 * Хук, а не девять копий: подтверждение необратимого действия должно звучать одним текстом. Разойдись
 * формулировки по вкладкам — и «Удалить» в одной начнёт означать не то же, что в другой, а цена
 * ошибки здесь ровно одна и та же: восстановить нечем.
 *
 * Показывать кнопку решает `allowed`, а не сам хук: кнопка живёт в разметке вкладки, и там же
 * проверяется второе условие — что запись погашена. Право без него открыло бы удаление активной
 * строки, на которой сервер всё равно откажет.
 */
export function usePurgeAction({ subject, purge, invalidate }: Options): PurgeAction {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (id: string) => purge(id),
    onSuccess: () => {
      message.success('Запись удалена окончательно');
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: [key] });
    },
    // Отказ сервера — обычный ответ, а не сбой: чаще всего он называет, кто ещё ссылается
    // на запись, и это единственный способ узнать, что мешает.
    onError: (e) => message.error(errorMessage(e)),
  });

  return {
    allowed: can('records.purge'),
    pending: mutation.isPending,
    confirm: (id, name) =>
      modal.confirm({
        title: `Удалить ${subject} «${name}» окончательно?`,
        content: 'Запись исчезнет из базы: восстановить её будет нечем.',
        okText: 'Удалить окончательно',
        okButtonProps: { danger: true },
        cancelText: 'Отмена',
        onOk: () => mutation.mutateAsync(id),
      }),
  };
}
