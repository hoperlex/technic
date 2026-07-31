import { useState } from 'react';
import { App, Button, DatePicker, Input, Space, Typography } from 'antd';
import { DownloadOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isWaybillEditable,
  WAYBILL_LOCKED_MESSAGE,
  type WaybillDto,
  waybillFormLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { waybillsApi } from '../api/resources';
import { DataTable } from '../components/DataTable';
import { PageTableLayout } from '../components/PageTableLayout';
import { actionsColumn, badgeColumn, textColumn } from '../components/columns';
import { PrintWaybillButton } from '../components/WaybillPrint';
import { useListParams } from '../hooks/useListParams';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Выписки здесь нет: лист рождается переводом заявки в работу, и журнал только отвечает, какие
 * номера выданы, на какие машины и что с ними стало. Аннулированные из списка не исчезают —
 * пропуск в нумерации означает утраченный бланк, а не отменённый рейс.
 */

const DATE = 'YYYY-MM-DD';
const today = () => dayjs().format(DATE);

export function WaybillsPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canCancel = can('waybills.cancel');
  const qc = useQueryClient();

  // Период — единственный фильтр, который журнал спрашивает сам: его читают по дням, а не по
  // всей истории сразу. Остальное сужают столбцами таблицы.
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const { params, onTableChange } = useListParams<{ status?: string }>(
    {},
    {
      searchKeys: ['number'],
      mapFilters: (f) => ({ status: f.status?.[0] as string | undefined }),
    },
  );
  const query = {
    ...params,
    dateFrom: range?.[0].format(DATE),
    dateTo: range?.[1].format(DATE),
  };
  const { data, isFetching } = useQuery({
    queryKey: ['waybills', query],
    queryFn: () => waybillsApi.list(query),
  });

  const cancelMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      waybillsApi.cancel(id, { reason }),
    onSuccess: () => {
      message.success('Лист аннулирован');
      void qc.invalidateQueries({ queryKey: ['waybills'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmCancel = (w: WaybillDto) => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${w.number}?`,
      // Номер сгорает — для бланка строгой отчётности это норма, но человек должен знать заранее.
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: заявке выпишется новый лист при следующем переводе в работу.
          </Typography.Text>
          <Input.TextArea
            rows={2}
            placeholder="Причина: испорчен при печати, ошибка в реквизитах…"
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelMut.mutateAsync({ id: w.id, reason });
      },
    });
  };

  const columns = [
    textColumn<WaybillDto>({ key: 'number', title: 'Номер', dataIndex: 'number', width: 200 }),
    textColumn<WaybillDto>({
      key: 'issuedForDate',
      title: 'На дату',
      dataIndex: 'issuedForDate',
      width: 120,
      render: (_v, r) => dayjs(r.issuedForDate).format('DD.MM.YYYY'),
    }),
    textColumn<WaybillDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.vehicleLabel}</span>
          {r.withTrailer && (
            <Typography.Text type="secondary">с прицепом {r.trailerLabel}</Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<WaybillDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      width: 220,
    }),
    textColumn<WaybillDto>({
      key: 'requests',
      title: 'Талоны заказчиков',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) =>
        r.requests.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {r.requests.map((link) => (
              <span key={link.requestId}>
                {link.slot}. {link.displayNumber} — {link.objectName}
              </span>
            ))}
          </Space>
        ),
    }),
    badgeColumn<WaybillDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 130,
      labels: waybillStatusLabels,
      colors: waybillStatusColors,
      filters: true,
    }),
    // Причина отдельной колонкой, а не подписью к статусу: аннулированный лист объясняют, и
    // читают это объяснение вместе с номером, а не вместо него.
    textColumn<WaybillDto>({
      key: 'cancelReason',
      title: 'Причина аннулирования',
      dataIndex: 'cancelReason',
      sortable: false,
      searchable: false,
      width: 200,
      ellipsis: true,
    }),
    actionsColumn<WaybillDto>((r) => {
      const editable = r.status === 'issued' && isWaybillEditable(r.issuedForDate, today());
      return (
        <Space>
          {/* Печать и выгрузка доступны и у аннулированного листа: испорченный бланк подшивают
              к журналу. Печать первой — ради неё лист и открывают (ADR 0041), а файл забирают
              тогда, когда бланк дополняют от руки в редакторе таблиц. */}
          <PrintWaybillButton waybillId={r.id} number={r.number} />
          <Button
            size="small"
            icon={<DownloadOutlined />}
            title="Скачать бланк (xlsx)"
            href={waybillsApi.exportUrl(r.id)}
            target="_blank"
          />
          {canCancel && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={!editable}
              // Причина запрета проговаривается подсказкой: выключенная кнопка без объяснения
              // читается как поломка.
              title={
                r.status === 'cancelled'
                  ? 'Лист уже аннулирован'
                  : editable
                    ? 'Аннулировать'
                    : WAYBILL_LOCKED_MESSAGE
              }
              onClick={() => confirmCancel(r)}
            />
          )}
        </Space>
      );
    }),
  ];

  return (
    <PageTableLayout
      extra={
        <Space>
          <DatePicker.RangePicker
            format="DD.MM.YYYY"
            value={range}
            onChange={(v) => setRange(v as [dayjs.Dayjs, dayjs.Dayjs] | null)}
            allowClear
          />
        </Space>
      }
    >
      <DataTable<WaybillDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        Листы выписываются при переводе заявки в работу. Формы:{' '}
        {Object.values(waybillFormLabels).join(', ')}.
      </Typography.Paragraph>
    </PageTableLayout>
  );
}
