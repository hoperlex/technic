import { App, Button } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { serviceRequestsApi } from '@entities/service-request';
import type { Query } from '@shared/api';
import { useServiceChatInvalidate } from '../model/invalidate';
import { errorMessage } from '../../../utils/format';

/**
 * «Отметить все прочитанными» по заявкам ТЕКУЩЕГО ОТБОРА (§3.4).
 *
 * Кнопка заведена под редкий, но неустранимый случай: стороны разговора считаются динамически, и
 * человеку, которому сегодня выдали набор «Ведение», открытые заявки загорелись разом. Отсечка по
 * дате заведения учётки этот случай не ловит — учётка старая, новые у неё права, — а гасить
 * подсветку заявка за заявкой значило бы открыть полсотни окон подряд.
 *
 * Отбор уходит тот же, что показывает список: кнопка обязана гасить ровно то, что человек видит.
 * Погаси она всё подряд, единственный способ узнать о непрочитанном исчез бы вместе с чужими
 * заявками, которых человек и не открывал.
 */
export function MarkAllChatReadButton({ filters }: { filters: Query }) {
  const { message } = App.useApp();
  const invalidate = useServiceChatInvalidate();

  const mutation = useMutation({
    mutationFn: () => serviceRequestsApi.markAllChatRead(filters),
    onSuccess: (result) => {
      // Число заявок, а не реплик: курсор ставится по заявке целиком, и «прочитано 3 заявки»
      // отвечает на вопрос «что сейчас погасло», а «12 реплик» — ни на какой.
      message.success(
        result.count > 0
          ? `Отмечено прочитанными заявок: ${result.count}`
          : 'Непрочитанного в этом отборе не было',
      );
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Button icon={<CheckOutlined />} loading={mutation.isPending} onClick={() => mutation.mutate()}>
      Отметить все прочитанными
    </Button>
  );
}
