import { Space, Typography } from 'antd';
import {
  vehicleVolume,
  wasteFactLabel,
  type FileDto,
  type RequestHistoryEntryDto,
  type WasteRequestCompletionDto,
  type WasteRequestVehicleDto,
} from '@technic/contracts';
import { FilesButton } from '@entities/file';
import type { HistoryRow } from '@entities/request-history';
import { formatMoney } from '@shared/lib';

const secondary = { fontSize: 12 } as const;

/**
 * What confirmed completion, shown at the closing event rather than in the card body: both the
 * removal fact (ADR 0035) and the tickets (ADR 0013) are presented on the move to "Done", so they
 * attach to it. Vehicle composition is shown for requests closed before ADR 0035: no new rows
 * appear, but those requests were accepted on them, so they cannot be silently dropped.
 */
function ClosingFact({
  completion,
  vehicles,
  tickets,
}: {
  completion: WasteRequestCompletionDto | null;
  vehicles: WasteRequestVehicleDto[];
  tickets: FileDto[];
}) {
  return (
    <>
      {completion && (
        <Space size={8} wrap>
          <Typography.Text>
            {/* The unit comes from the fact itself (ADR 0067): waste is measured by volume, scrap
                by weight, and a hard-coded "m3" would be wrong in half of the cards. */}
            Вывезено {wasteFactLabel(completion)}
            {completion.totalCost != null ? ` · ${formatMoney(completion.totalCost)}` : ''}
          </Typography.Text>
          {completion.pricePerM3 != null && (
            <Typography.Text type="secondary" style={secondary}>
              по {formatMoney(completion.pricePerM3)}/м³
            </Typography.Text>
          )}
        </Space>
      )}
      {/* Vehicles marked for deletion stay listed, struck through: otherwise a removed vehicle
          could not be noticed. */}
      {vehicles.map((vehicle) => (
        <Space key={vehicle.id} size={8} wrap>
          <Typography.Text
            delete={vehicle.isDeleted}
            type={vehicle.isDeleted ? 'secondary' : undefined}
          >
            {vehicle.containerTypeName}
            {vehicle.count > 1 ? ` × ${vehicle.count}` : ''} — {vehicleVolume(vehicle)} м³
            {vehicle.amount != null ? ` · ${formatMoney(vehicle.amount)}` : ''}
          </Typography.Text>
          {vehicle.isDeleted && (
            <Typography.Text type="secondary" style={secondary}>
              помечена на удаление
            </Typography.Text>
          )}
        </Space>
      ))}
      {/* Tickets are the request-wide pool (ADR 0024), paper for the whole completion without a
          per-vehicle split. A button opens them in a modal, files are viewed one by one. */}
      {tickets.length > 0 && (
        <Space size={8} wrap>
          <Typography.Text>Талоны заявки</Typography.Text>
          <FilesButton files={tickets} title="Талоны заявки" label={`талонов: ${tickets.length}`} />
        </Space>
      )}
    </>
  );
}

/**
 * How completion was evidenced: the hauled fact (ADR 0035, ADR 0067) and the request tickets
 * (ADR 0013, ADR 0024).
 */
function factOf(
  completion: WasteRequestCompletionDto | null,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): string {
  return [
    completion ? wasteFactLabel(completion) : null,
    completion?.totalCost != null ? formatMoney(completion.totalCost) : null,
    // Vehicle composition exists only on completions before ADR 0035, which had no volume fact.
    !completion && vehicles.length > 0
      ? `машин: ${vehicles.reduce((sum, vehicle) => sum + vehicle.count, 0)}`
      : null,
    tickets.length > 0 ? `талонов: ${tickets.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Attach completion evidence to the latest closing event in the immutable history. */
export function buildWasteRequestHistoryRows(
  history: RequestHistoryEntryDto[] | undefined,
  completion: WasteRequestCompletionDto | null,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): HistoryRow[] {
  const entries = history ?? [];
  // A repeated completion (after a rollback) is the last word on the fact, so the fact attaches
  // to it.
  const closingIndex = entries.findLastIndex(
    (entry) => entry.kind === 'status' && entry.toStatus === 'done',
  );
  // A completion without fact or ticket (a container operation whose ticket comes later) must not
  // expand into emptiness: such a row simply has no fact.
  const hasFact = completion != null || vehicles.length > 0 || tickets.length > 0;
  const fact: Partial<HistoryRow> = hasFact
    ? {
        fact: factOf(completion, vehicles, tickets),
        details: <ClosingFact completion={completion} vehicles={vehicles} tickets={tickets} />,
      }
    : {};
  const rows = entries.map<HistoryRow>((entry, index) => ({
    key: entry.id,
    entry,
    ...(index === closingIndex ? fact : {}),
  }));
  // Tickets without a closing event mean truncated history, and vehicles on an unclosed request are
  // left from the old flow (they were also added by editing). Without this row both would vanish.
  if (closingIndex < 0 && hasFact) {
    rows.push({
      key: 'fact',
      entry: null,
      tag: vehicles.length > 0 ? 'Машины' : 'Талоны',
      ...fact,
    });
  }
  return rows;
}
