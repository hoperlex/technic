import { useState, type ReactNode } from 'react';
import { App, Form, Select, type SelectProps } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { formatWeeklyRequestNumber } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import { useAuth, useObjectScope } from '@entities/session';
import {
  pastWeekSelectOptions,
  weeklyBackdateAccess,
  weeklyRequestErrorMessage,
  weeklyRequestPath,
  weeklyRequestsApi,
  weekSelectOptions,
} from '@entities/weekly-request';
import { isApiError } from '@shared/api';
import { FormModal } from '@shared/ui';

function hasStatus(error: unknown, status: number): boolean {
  return isApiError(error) && error.status === status;
}

/**
 * Open an existing draft or create an empty weekly request before navigating to its workspace.
 * Both entry points use this command so a uniqueness race never strands the user on an error.
 */
export function useWeeklyRequestCreate(): {
  open: () => void;
  openWeek: (objectId: string, weekStart: string) => void;
  pending: boolean;
  node: ReactNode;
} {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [form] = Form.useForm<{ objectId: string; weekStart: string }>();
  const [open, setOpen] = useState(false);
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  const objects = useQuery(objectOptionsQuery());
  const objectOptions = limitObjectOptions(objects.data ?? []);
  const weeks = weekSelectOptions();
  const backdate = weeklyBackdateAccess(can);
  const pastWeeks = pastWeekSelectOptions(backdate);
  // Past weeks are deliberately separated and shown first: choosing one consumes correction
  // authority and may burn waybill numbers, so it must not look like an adjacent future week.
  const weekOptions: SelectProps['options'] =
    pastWeeks.length === 0
      ? weeks
      : [
          { label: 'Прошедшие — заявку придётся проводить задним числом', options: pastWeeks },
          { label: 'Будущие', options: weeks },
        ];

  const mutation = useMutation({
    mutationFn: async (values: { objectId: string; weekStart: string }) => {
      const suggestion = await weeklyRequestsApi.suggestion(values);
      if (suggestion.existingRequestId) {
        return { id: suggestion.existingRequestId, existed: true };
      }
      try {
        const created = await weeklyRequestsApi.create({ ...values, items: [] });
        return { id: created.id, existed: false, num: created.num };
      } catch (error) {
        // A competing creator may win after the suggestion request. Resolve that conflict to the
        // winner's document instead of presenting a dead-end uniqueness error.
        if (!hasStatus(error, 409)) throw error;
        const current = await weeklyRequestsApi.suggestion(values);
        if (!current.existingRequestId) throw error;
        return { id: current.existingRequestId, existed: true };
      }
    },
    onSuccess: (result) => {
      setOpen(false);
      if (result.existed) message.info('Заявка на эту неделю уже собирается — открываем её');
      else if (result.num) {
        message.success(`Заведена заявка ${formatWeeklyRequestNumber(result.num)}`);
      }
      void navigate(weeklyRequestPath(result.id));
    },
    onError: (error) => message.error(weeklyRequestErrorMessage(error)),
  });

  const node = (
    <FormModal
      title="Заявка на неделю"
      open={open}
      okText="Собрать состав"
      confirmLoading={mutation.isPending}
      onCancel={() => setOpen(false)}
      onSubmit={() => form.submit()}
    >
      <Form form={form} layout="vertical" onFinish={(values) => mutation.mutate(values)}>
        <Form.Item
          name="objectId"
          label="Объект"
          rules={[{ required: true, message: 'Выберите объект' }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="Выберите объект"
            loading={objects.isFetching}
            disabled={objectFieldDisabled}
            options={objectOptions}
          />
        </Form.Item>
        {/* Past weeks are available only through the contract-owned backdate permission pair.
            No past week is selected by default because that choice requires an explicit audit
            reason and can invalidate issued waybill numbers. */}
        <Form.Item
          name="weekStart"
          label="Неделя"
          tooltip={
            backdate.correct
              ? 'Будущую неделю визирует руководитель строительства. Прошедшую проводят задним числом: виза по ней спросит причину и уйдёт в журнал коррекций'
              : 'Заявку заводят на будущую неделю: продление задним числом означало бы согласовать уже отработанные дни'
          }
          rules={[{ required: true, message: 'Выберите неделю' }]}
        >
          <Select options={weekOptions} placeholder="Выберите неделю" />
        </Form.Item>
      </Form>
    </FormModal>
  );

  return {
    open: () => {
      form.setFieldsValue({ objectId: soleObjectId ?? undefined, weekStart: weeks[0]?.value });
      setOpen(true);
    },
    openWeek: (objectId, weekStart) => mutation.mutate({ objectId, weekStart }),
    pending: mutation.isPending,
    node,
  };
}
