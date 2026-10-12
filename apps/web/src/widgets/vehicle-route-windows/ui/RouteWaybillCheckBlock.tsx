import { useState } from 'react';
import { Collapse, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { WaybillIssueCheck, waybillKeys, waybillsApi } from '@entities/waybill';

interface Props {
  /** The route's live sheet; the block is shown only while one is issued. */
  waybillId: string;
  number: string;
}

/**
 * What the route's live sheet was issued under (ADR 0108 item 21) — the answer to «did anybody see
 * the gaps before the number was spent», asked from the card where the sheet was issued.
 *
 * Collapsed, and the sheet is read only when the block opens: the question is rare (a dispute, an
 * inspection), and the card is opened many times a day for its composition. The read is the
 * journal's own (`waybillKeys.detail`), the cell the correction window already shares: one answer
 * to «what is on this sheet», invalidated with the journal by every command that touches paper.
 *
 * The printed rows by trip are not repeated here: an issued sheet freezes the route's points and
 * trips (R15), so the «Задание листа» block below shows exactly what went on paper; the journal's
 * view window names them by trip for sheets whose route has moved on.
 */
export function RouteWaybillCheckBlock({ waybillId, number }: Props) {
  const [open, setOpen] = useState(false);
  const { data, isError } = useQuery({
    queryKey: waybillKeys.detail(waybillId),
    queryFn: () => waybillsApi.get(waybillId),
    enabled: open,
  });

  return (
    <Collapse
      size="small"
      activeKey={open ? ['check'] : []}
      onChange={(keys) => setOpen(keys.includes('check'))}
      items={[
        {
          key: 'check',
          label: `Проверка при выписке листа ${number}`,
          children: data ? (
            <WaybillIssueCheck check={data.issueWarnings} />
          ) : (
            <Typography.Text type="secondary">
              {isError ? 'Лист не прочитался — его запись есть в журнале листов' : 'Загружаем…'}
            </Typography.Text>
          ),
        },
      ]}
    />
  );
}
