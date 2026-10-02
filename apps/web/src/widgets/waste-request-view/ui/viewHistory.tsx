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

/** Show evidence attached to the closing event, including legacy vehicle rows. */
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
      {tickets.length > 0 && (
        <Space size={8} wrap>
          <Typography.Text>Талоны заявки</Typography.Text>
          <FilesButton files={tickets} title="Талоны заявки" label={`талонов: ${tickets.length}`} />
        </Space>
      )}
    </>
  );
}

function factOf(
  completion: WasteRequestCompletionDto | null,
  vehicles: WasteRequestVehicleDto[],
  tickets: FileDto[],
): string {
  return [
    completion ? wasteFactLabel(completion) : null,
    completion?.totalCost != null ? formatMoney(completion.totalCost) : null,
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
  const closingIndex = entries.findLastIndex(
    (entry) => entry.kind === 'status' && entry.toStatus === 'done',
  );
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
  // Old requests can have evidence without a closing event because their history was truncated.
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
