import { Form, Input, InputNumber } from 'antd';
import { isAddressVerified, type VehicleRequestTripDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { AddressField } from '@features/address-input';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields } from '@entities/request';
import { TimeInput, optionalWorkTimeRule } from '@entities/request';

/**
 * Fields for one request trip (`docs/route-trips-plan.md`, section 4.1, stage 6).
 *
 * Separate from the list by substance, not file length: `RequestTripsBlock` owns list composition
 * (how many rows, which to repeat or remove); this component owns a row's fields and their rules.
 * The compact one-trip editor is drawn by this same component, and that is its key property: if
 * they diverged, "as today" and "as a list" would become two forms with two rule sets.
 *
 * Field names use full array paths (`trips.3.fromLocation`), not paths relative to `Form.List`:
 * address and contact controls call the form directly (`getFieldValue`, `setFieldValue`,
 * `useWatch`) and need the whole path, so the trip list is kept as plain values, not `Form.List`.
 */

/** A trip is a pair of endpoints, each with its own address and contact: different people load and receive. */
type Side = 'from' | 'to';

const SIDE_LABELS: Record<Side, { address: string; required: string; responsible: string }> = {
  from: {
    address: 'Место погрузки',
    required: 'Укажите место погрузки',
    responsible: 'Ответственный за погрузку',
  },
  to: {
    address: 'Место разгрузки',
    required: 'Укажите место разгрузки',
    responsible: 'Ответственный за разгрузку',
  },
};

interface EndProps {
  /** Row position used to construct full form paths. */
  index: number;
  side: Side;
  /** Persisted trip for this row; `undefined` means a new row with no legacy exemptions (R2a). */
  saved: VehicleRequestTripDto | undefined;
  suggestObjectIds: readonly string[];
}

/**
 * One trip endpoint, with its contact under its own address rather than in a shared block at the
 * end of the form: loading and unloading are two places, and the driver looks for whoever opens
 * the gate exactly here.
 */
function TripEnd({ index, side, saved, suggestObjectIds }: EndProps) {
  const form = Form.useFormInstance();
  const labels = SIDE_LABELS[side];
  const locationField = ['trips', index, `${side}Location`];
  const metaField = ['trips', index, `${side}Address`];
  const nameField = ['trips', index, `${side}ResponsibleName`];
  const phoneField = ['trips', index, `${side}ResponsiblePhone`];

  const savedLocation = side === 'from' ? saved?.fromLocation : saved?.toLocation;
  const savedMeta = (side === 'from' ? saved?.fromAddress : saved?.toAddress) ?? null;
  const savedName = side === 'from' ? saved?.fromResponsibleName : saved?.toResponsibleName;
  const savedPhone = side === 'from' ? saved?.fromResponsiblePhone : saved?.toResponsiblePhone;

  /*
   * Strict address verification (ADR 0006) applies to a **new** value, not to rewriting the old
   * one (R2a). A trip backfilled from a request older than ADR 0006 has no metadata at all, and the
   * field rule would block editing such a request until someone re-picked its address — i.e.
   * invented data for the past. The server accepts it with the same exemption
   * (`updateRequestTripSchema`), and they must not diverge: a form that refuses to send what the
   * handler accepts is a prohibition nobody decided on.
   *
   * The exemption is per row, not one per form: in a six-trip request only the third may be old,
   * and a global switch would lift the requirement from all rows or from none. It lasts exactly
   * until the address is edited — then the requirement returns.
   *
   * The client compares the visible string while the server checks the whole pair, string and
   * metadata (`assertAddressWritable`). The field condition is therefore slightly wider, and one
   * case falls into the gap: the string was edited and then typed back to its original form — the
   * metadata became `manual`, the form lets the submit through, and the handler answers 422 with
   * an error on that very field. It cannot be narrowed while the metadata comparison is a private
   * function of the handler: a frontend copy of the rule would drift from it on the next change.
   */
  const location = Form.useWatch(locationField, form) as string | undefined;
  const keepsAddress = !!saved && !isAddressVerified(savedMeta) && location === savedLocation;

  return (
    <>
      <AddressField
        name={locationField}
        label={labels.address}
        required
        requiredMessage={labels.required}
        verified={!keepsAddress}
        metaField={metaField}
        directory
        suggestObjectIds={suggestObjectIds}
        placeholder="Начните вводить адрес"
      />
      {/* The old contact does not block an edit, by the same rule as the old address (R2a): for a
          trip from a request older than migration 0062 it is empty, and for one older than ADR
          0066 it cannot be reduced to ten digits. Normal rules return once the value changes. */}
      <ResponsibleFields
        nameField={nameField}
        phoneField={phoneField}
        nameLabel={labels.responsible}
        phoneLabel="Телефон"
        kept={saved ? { name: savedName ?? '', phone: savedPhone ?? '' } : undefined}
        phoneInput={PhoneInput}
      />
    </>
  );
}

interface Props {
  index: number;
  saved: VehicleRequestTripDto | undefined;
  suggestObjectIds: readonly string[];
  /**
   * Whether cargo quantity is required. A passenger car (form No. 3) carries no cargo, and
   * demanding "volume or weight" would make the requester invent a number. The rule is the one the
   * server answers with, and it asks the waybill form of the ordered vehicle type.
   */
  cargoRequired: boolean;
  /**
   * Whether to show trip-specific delivery time and note, which compact mode cannot represent.
   *
   * A one-trip request is filled exactly as before the plan (§4.1), which had no such fields. They
   * appear with the list, where there are several trips and "the sixth arrives at 14:00" matters.
   */
  detailed: boolean;
}

/**
 * Trip fields in reading order: quantity, time, origin, and destination.
 *
 * Returned as a fragment, not a block: in compact mode these fields are direct cells of the form
 * grid (`FormGrid`), and a wrapper would turn them into one cell spanning both columns. Expanded
 * mode wraps them itself, in a trip card.
 */
export function RequestTripFields({
  index,
  saved,
  suggestObjectIds,
  cargoRequired,
  detailed,
}: Props) {
  return (
    <>
      {/* Either cargo measure is sufficient. Whether it is required at all is conditional and
          decided by the server; here it is only a hint of what the field expects. */}
      <Form.Item
        name={['trips', index, 'volumeM3']}
        label="Объём, м³"
        tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
      >
        <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
      </Form.Item>
      <Form.Item
        name={['trips', index, 'weightTons']}
        label="Масса, т"
        tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
      >
        <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
      </Form.Item>
      {detailed && (
        // The trip's own time only refines (R3): the request delivery owns the day, filters and the
        // work window, and the trip answers "what time exactly for this one". Empty reads as "same
        // as the request"; only the time is asked because the trip day must stay the request day.
        <Form.Item
          name={['trips', index, 'scheduledTime']}
          label="Время подачи (МСК)"
          tooltip="Необязательно: пусто — время заявки. Рабочее окно — с 07:00 до 21:00"
          rules={[optionalWorkTimeRule]}
        >
          <TimeInput />
        </Form.Item>
      )}
      {/* Addresses and contacts span the full width: a DaData suggestion is one long line, and in
          half the dialog the choice would be among truncated variants. */}
      <FormGrid.Full>
        <TripEnd index={index} side="from" saved={saved} suggestObjectIds={suggestObjectIds} />
        <TripEnd index={index} side="to" saved={saved} suggestObjectIds={suggestObjectIds} />
        {detailed && (
          // The trip note is the first thing the printed form drops (R11a), yet the driver needs it:
          // "sand, call an hour ahead". The request comment about the whole order cannot replace it.
          <Form.Item name={['trips', index, 'comment']} label="Примечание к ездке">
            <Input.TextArea
              rows={2}
              maxLength={2000}
              placeholder="Например: песок, звонить за час"
            />
          </Form.Item>
        )}
      </FormGrid.Full>
    </>
  );
}
