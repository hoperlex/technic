import { App, Spin, Switch, Table, Tooltip, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { canSetWorkingSunday, type WorkingSundayDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { errorMessage, formatDateOnly } from '@shared/lib';

/**
 * The term's Sundays and their «Рабочая смена» switch (ADR 0246, D2).
 *
 * Sunday is a rest day by default: the driver owes no reading for it, and the garage does not wait
 * for one. The switch makes one Sunday a working day of this request — its weekly sheet and its
 * site-day paper are asked for again. Who may switch is the contracts' predicate over the server's
 * permission list (ADR 0223); when a date may be switched is the server's answer per row
 * (`blocker`), the same rule the door applies.
 */
export function WorkingSundaysView({
  requestId,
  readOnly = false,
}: {
  requestId: string;
  readOnly?: boolean;
}) {
  const { user, can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const key = vehicleRequestKeys.workingDays(requestId);
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => vehicleRequestsApi.workingDays(requestId),
  });
  const set = useMutation({
    mutationFn: (row: { date: string; working: boolean }) =>
      vehicleRequestsApi.setWorkingDay(requestId, row.date, row.working),
    onSuccess: (res, row) => {
      qc.setQueryData(key, res);
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.events(requestId) });
      message.success(
        row.working ? 'Воскресенье отмечено рабочей сменой' : 'Отметка рабочей смены снята',
      );
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const mayEdit = !readOnly && canSetWorkingSunday(user, can);

  if (isLoading) return <Spin />;
  const rows = data?.sundays ?? [];
  if (rows.length === 0) {
    return <Typography.Text type="secondary">В сроке заявки нет воскресений</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography.Text type="secondary">
        Воскресенье — выходной: показаний за него не ждут. Рабочая смена делает воскресенье обычным
        рабочим днём заявки — водителя попросят передать показания.
      </Typography.Text>
      <Table<WorkingSundayDto>
        size="small"
        pagination={false}
        rowKey="date"
        dataSource={rows}
        columns={[
          {
            key: 'date',
            title: 'Воскресенье',
            width: 160,
            render: (_value, row) => formatDateOnly(row.date),
          },
          {
            key: 'working',
            title: 'Рабочая смена',
            render: (_value, row) => {
              const disabled = !mayEdit || row.blocker !== null || set.isPending;
              const control = (
                <Switch
                  checked={row.working}
                  disabled={disabled}
                  aria-label={`Рабочая смена ${formatDateOnly(row.date)}`}
                  onChange={(working) => set.mutate({ date: row.date, working })}
                />
              );
              return mayEdit && row.blocker ? (
                <Tooltip title={row.blocker}>
                  <span>{control}</span>
                </Tooltip>
              ) : (
                control
              );
            },
          },
        ]}
      />
    </div>
  );
}
