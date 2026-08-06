import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Input, Space, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  canCancelWaybill,
  WAYBILL_LOCKED_MESSAGE,
  type WaybillDto,
  waybillFormLabels,
  waybillFormShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { waybillsApi } from '../api/resources';
import { WaybillFilesCell } from '../components/WaybillFiles';
import { DataTable } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';
import { ExportWaybillButton, PrintWaybillButton } from '../components/WaybillPrint';
import { useListParams } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';
import { vehicleRequestLink } from '../utils/links';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Выписки здесь нет: лист выписывают с маршрута (ADR 0050), а журнал только отвечает, какие номера
 * выданы, на какие машины и что с ними стало. Аннулированные из списка не исчезают — пропуск в
 * нумерации означает утраченный бланк, а не отменённый рейс.
 */

const DATE = 'YYYY-MM-DD';
const today = () => dayjs().format(DATE);

export function WaybillsPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canCancel = can('waybills.cancel');
  const canAttach = can('waybills.files');
  const qc = useQueryClient();

  // Период — единственный фильтр, который журнал спрашивает сам: его читают по дням, а не по
  // всей истории сразу. Остальное сужают столбцами таблицы — в том числе бланк: журнал у трёх
  // форм один, а читают их разные люди по разным поводам.
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const { params, setParams, onTableChange } = useListParams<{
    status?: string;
    formCode?: string;
  }>(
    {},
    {
      searchKeys: ['number'],
      mapFilters: (f) => ({
        status: f.status?.[0] as string | undefined,
        formCode: f.formCode?.[0] as string | undefined,
      }),
    },
  );

  /**
   * Номер из адреса: сюда приходят по ссылке из маршрута и из карточки заявки — «что стало с этим
   * листом». Карточки у листа нет, журнал и есть карточка, поэтому вместо открытия окна список
   * сужается до одной строки. Поиск остаётся обычным — его видно в заголовке столбца и оттуда же
   * сбрасывают.
   */
  const [searchParams] = useSearchParams();
  const numberParam = searchParams.get('number');
  useEffect(() => {
    if (!numberParam) return;
    setParams((p) => ({ ...p, search: numberParam, page: 1 }));
  }, [numberParam, setParams]);
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
            Номер бланка сгорит, а маршрут разморозится: новый лист выписывают с него, когда состав
            рейса пересобран.
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
    textColumn<WaybillDto>({
      key: 'number',
      title: 'Номер',
      dataIndex: 'number',
      width: 200,
      filteredValue: params.search ? [params.search] : null,
    }),
    // Бланк — колонкой с фильтром, как и статус: полная подпись сюда не влезает, а на вопрос
    // «какой это лист» отвечает и короткая.
    badgeColumn<WaybillDto>({
      key: 'formCode',
      title: 'Форма',
      dataIndex: 'formCode',
      width: 110,
      labels: waybillFormShortLabels,
      filters: true,
    }),
    textColumn<WaybillDto>({
      key: 'issuedForDate',
      title: 'На дату',
      dataIndex: 'issuedForDate',
      width: 150,
      // У ЭСМ-2 в этой графе не день, а неделя работ: лист выписан на период, и одна дата в нём
      // ничего не значит — по ней не понять, какую неделю держит бланк.
      render: (_v, r) =>
        r.periodFrom && r.periodTo
          ? `${dayjs(r.periodFrom).format('DD.MM')} — ${dayjs(r.periodTo).format('DD.MM.YYYY')}`
          : dayjs(r.issuedForDate).format('DD.MM.YYYY'),
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
            {/* Номер талона ведёт к самой заявке: журнал отвечает, что за бланк выдан, а «что в
                нём за работа» спрашивают у заявки — и до сих пор искали её номер руками. */}
            {r.requests.map((link) => (
              <span key={link.requestId}>
                {link.slot}.{' '}
                <EntityLink
                  to={vehicleRequestLink(can, { id: link.requestId, status: link.status })}
                  title="Открыть заявку"
                >
                  {link.displayNumber}
                </EntityLink>{' '}
                — {link.objectName}
              </span>
            ))}
          </Space>
        ),
    }),
    // Скан заполненного бланка: у ЭСМ-2 оборот заполняет заказчик, у 4-П — отметки о выполнении.
    // Портал этих значений не разбирает, но журнал обязан отвечать, чем кончился выданный номер.
    textColumn<WaybillDto>({
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      sortable: false,
      searchable: false,
      width: 100,
      render: (_v, r) => <WaybillFilesCell waybillId={r.id} files={r.files} canEdit={canAttach} />,
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
      const editable = r.status === 'issued' && canCancelWaybill(r, today());
      return (
        <Space>
          {/* Печать и выгрузка доступны и у аннулированного листа: испорченный бланк подшивают
              к журналу. Печать первой — ради неё лист и открывают (ADR 0041), а файл забирают
              тогда, когда бланк дополняют от руки в редакторе таблиц. */}
          <PrintWaybillButton waybillId={r.id} number={r.number} />
          <ExportWaybillButton waybillId={r.id} number={r.number} />
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
        Листы на рейс ({waybillFormLabels['4p']}, {waybillFormLabels.leg3}) выписываются с маршрута
        — во вкладке «Маршруты» раздела «Заказ ТС», когда состав рейса собран.{' '}
        {waybillFormLabels.esm2} портал выписывает сам: заявку на технику берут в работу, и лист
        рождается на каждую неделю её срока.
      </Typography.Paragraph>
    </PageTableLayout>
  );
}
