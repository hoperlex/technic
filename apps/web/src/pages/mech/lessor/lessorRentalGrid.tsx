import { Button, Tooltip, Typography, type TableColumnsType } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import {
  MECH_LESSOR_RECEIPT_FILTERS,
  mechLessorReceiptFilterLabels,
  mechLessorReceiptStatusLabels,
  type MechLessorRentalDto,
} from '@technic/contracts';
import {
  mechDaysLeftLabel,
  mechModelLabel,
  mechRateLabel,
  mechTermLabel,
  MechLessorReceiptMarkTag,
  MechPlaceCell,
  MechRateCell,
} from '@entities/mech-request';
import { actionsColumn, type CardConfig, type FilterDefinition } from '@shared/ui';
import { lessorRentalMark } from './lessorRental';

/*
 * The mechanization lessor's list (lessor receipt plan, P12): his rentals «В работе», one page, no
 * tabs. The columns are the fields of his card and nothing else — a column over a field he is not
 * shown would be a leak, and a sort by one would leak its order (the server sorts only by the
 * planned return).
 *
 * No state column: every row is «В работе» by construction (O12), so a state tag would repeat one
 * word. The receipt is the column that tells his rows apart, and his work in this section.
 */

export interface LessorRentalGridOptions {
  /** The Moscow day `YYYY-MM-DD`, counted once per render of the page (R12). */
  today: string;
  onOpen: (rental: MechLessorRentalDto) => void;
}

/**
 * The receipt of a row: a mark while something waits — for the visa or for him — and the decision's
 * own word once it is settled. Without the second half an approved receipt would read as an empty
 * cell, and the lessor would wonder whether it reached anyone.
 */
export function LessorReceiptCell({ rental }: { rental: MechLessorRentalDto }) {
  const mark = lessorRentalMark(rental);
  if (mark) return <MechLessorReceiptMarkTag mark={mark} />;
  const current = rental.lessorReceipt.current;
  if (!current) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Typography.Text type={current.status === 'approved' ? 'success' : 'secondary'}>
      чек {mechLessorReceiptStatusLabels[current.status]}
    </Typography.Text>
  );
}

/** The term with the days left under it: «what comes back next» is how he reads the list. */
function TermCell({ rental, today }: { rental: MechLessorRentalDto; today: string }) {
  const left = mechDaysLeftLabel(rental, today);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{mechTermLabel(rental)}</div>
      {left && (
        <Typography.Text
          type={left.overdue ? 'danger' : 'secondary'}
          style={{ fontSize: 12, display: 'block' }}
        >
          {left.text}
        </Typography.Text>
      )}
    </div>
  );
}

export function lessorRentalColumns(
  opts: LessorRentalGridOptions,
): TableColumnsType<MechLessorRentalDto> {
  return [
    {
      key: 'num',
      title: '№ заявки',
      dataIndex: 'displayNumber',
      width: 110,
      render: (_v: unknown, r: MechLessorRentalDto) => r.displayNumber,
    },
    {
      key: 'model',
      title: 'Модель',
      dataIndex: 'mechModelName',
      width: 220,
      render: (_v: unknown, r: MechLessorRentalDto) => mechModelLabel(r),
    },
    {
      key: 'object',
      title: 'Площадка',
      dataIndex: 'objectName',
      width: 260,
      render: (_v: unknown, r: MechLessorRentalDto) => <MechPlaceCell row={r} />,
    },
    {
      // The column key is the sort field: the server sorts the lessor's list by it alone.
      key: 'plannedTo',
      title: 'Срок аренды',
      dataIndex: 'plannedTo',
      width: 220,
      sorter: true,
      render: (_v: unknown, r: MechLessorRentalDto) => <TermCell rental={r} today={opts.today} />,
    },
    {
      key: 'rate',
      title: 'Ставка',
      dataIndex: 'rate',
      width: 140,
      align: 'right' as const,
      render: (_v: unknown, r: MechLessorRentalDto) => (
        <MechRateCell rate={r.rate} rateUnit={r.rateUnit} />
      ),
    },
    {
      key: 'lessorReceipt',
      title: 'Чек',
      width: 150,
      render: (_v: unknown, r: MechLessorRentalDto) => <LessorReceiptCell rental={r} />,
    },
    actionsColumn<MechLessorRentalDto>(
      (r) => (
        <Tooltip title="Открыть аренду">
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label="Открыть аренду"
            onClick={() => opts.onOpen(r)}
          />
        </Tooltip>
      ),
      90,
    ),
  ];
}

/**
 * His rental on the phone (ADR 0030): the site in the head — he drives there — and the receipt as
 * the badge, the one thing a row may ask him to do. The card opens on a tap; it has no actions
 * sheet, because the only action lives inside the card.
 */
export function lessorRentalCard(opts: LessorRentalGridOptions): CardConfig<MechLessorRentalDto> {
  return {
    title: (r) => r.objectName,
    badge: (r) => <LessorReceiptCell rental={r} />,
    primary: (r) => mechModelLabel(r),
    lines: [
      (r) => r.objectAddress.trim() || null,
      (r) => mechRateLabel(r.rate, r.rateUnit),
      (r) => `${mechTermLabel(r)} · ${r.displayNumber}`,
      (r) => {
        const left = mechDaysLeftLabel(r, opts.today);
        return left ? (
          <Typography.Text type={left.overdue ? 'danger' : 'secondary'}>
            {left.text}
          </Typography.Text>
        ) : null;
      },
    ],
    onOpen: opts.onOpen,
  };
}

/** The receipt states of the filter, in the order of the contracts' question. */
export const LESSOR_RECEIPT_OPTIONS = MECH_LESSOR_RECEIPT_FILTERS.map((value) => ({
  value,
  label: mechLessorReceiptFilterLabels[value],
}));

export interface LessorRentalFilters {
  periodFrom?: string;
  periodTo?: string;
  lessorReceipt?: string;
}

/** The filter keys: remembered between sessions (ADR 0139) and cleared by «Сбросить». */
export const LESSOR_RENTAL_FILTER_FIELDS = [
  'periodFrom',
  'periodTo',
  'lessorReceipt',
] as const satisfies readonly (keyof LessorRentalFilters)[];

/**
 * His two filters (P12), one description for the desktop bar and the phone sheet (ADR 0030). Not
 * the office's filter set: that one asks the site, model, lessor and requester dictionaries, every
 * one a door that refuses him.
 */
export function lessorRentalFilters(
  params: LessorRentalFilters,
  apply: (patch: LessorRentalFilters) => void,
): FilterDefinition[] {
  return [
    {
      // Rentals whose term crosses these days, as in the office list.
      kind: 'dateRange',
      key: 'period',
      label: 'Период аренды',
      from: params.periodFrom,
      to: params.periodTo,
      onChange: (periodFrom, periodTo) => apply({ periodFrom, periodTo }),
    },
    {
      kind: 'select',
      key: 'lessorReceipt',
      label: 'Чек',
      value: params.lessorReceipt,
      options: LESSOR_RECEIPT_OPTIONS,
      placeholder: 'Чек: любой',
      onChange: (value) => apply({ lessorReceipt: value }),
    },
  ];
}
