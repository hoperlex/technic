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
 * The "Weekly request" entry shared by both buttons (weekly requests tab and "On site" tab). A
 * request is never created blindly: the composition suggestion is asked first, and if a draft for
 * this "object + week" pair already exists the portal opens it (R3). UNIQUE would not allow a
 * second request anyway, and an "already exists" refusal with no way to open it is a dead end
 * resolved only through an administrator.
 *
 * The composition is not carried over at creation: the draft is created empty and the page
 * recomputes the suggestion itself, so what arrives checked is what really stands on site today.
 */
export function useWeeklyRequestCreate(): {
  open: () => void;
  /** Create (or open) a request for the named week without asking: "create for next week". */
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
  /*
   * The past goes ABOVE the future as a separate group with a telling title: the list is read top
   * to bottom like a calendar, and a past week must look like a different kind of action, not an
   * adjacent row. There is no group at all when there is no past: an empty "past" header would tell
   * the site about a right it will not have.
   */
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
        // A race of two assemblers: while the suggestion was asked, a neighbour created the
        // request. The refusal here means "open that one", not an error, so the suggestion is asked
        // again for exactly that.
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
        {/* Weeks are future ones (R2); past weeks only for someone with the past right (ADR 0101):
            the equipment worked a week while the extension has no base document, and fixing that
            belongs to the same dispatcher who corrects paperwork retroactively. The past is never
            the default: the portal does not make for a person a decision that costs a burnt form
            (ADR 0083). */}
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
