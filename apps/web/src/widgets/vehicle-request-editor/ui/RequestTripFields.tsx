import { Form, Input, InputNumber } from 'antd';
import { isAddressVerified, type VehicleRequestTripDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { AddressField } from '@features/address-input';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields } from '@entities/request';
import { TimeInput, optionalWorkTimeRule } from '@entities/request';

/**
 * Fields for one request trip (`docs/route-trips-plan.md`, section 4.1).
 *
 * `RequestTripsBlock` owns list composition; this component owns a row's fields and validation.
 * The compact one-trip editor reuses it so compact and expanded modes cannot drift.
 *
 * Field names use full array paths because address and contact controls call the form directly;
 * `Form.List` prefixes only its own `Form.Item` descendants.
 */

/** A trip has independent endpoints because loading and receiving contacts can differ. */
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
  /** Persisted trip for this row; `undefined` means a new row with no legacy exemptions. */
  saved: VehicleRequestTripDto | undefined;
  suggestObjectIds: readonly string[];
}

/**
 * One trip endpoint, with its contact adjacent to its address.
 *
 * Keeping them together makes it clear who can grant access at this specific location.
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
   * Strict address verification (ADR 0006) applies to changed values. Legacy backfilled trips may
   * lack metadata, and editing another field must not force users to invent historical address
   * data. `updateRequestTripSchema` grants the same exemption.
   *
   * The exemption is per endpoint and lasts only while its original address string is unchanged.
   *
   * The client compares the visible string while `assertAddressWritable` compares the full pair.
   * Reimplementing the server's private metadata comparison here would create a second rule; the
   * server remains authoritative for the rare edit-and-restore case.
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
      {/* Legacy empty or non-normalizable contacts do not block unrelated edits. Normal validation
          resumes as soon as the value changes. */}
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
   * Whether cargo quantity is required. Passenger vehicles have no cargo, so the shared contract
   * derives this from the requested vehicle form.
   */
  cargoRequired: boolean;
  /**
   * Whether to show trip-specific delivery time and note, which compact mode cannot represent.
   *
   * These fields appear with expanded list mode, where distinguishing individual trips matters.
   */
  detailed: boolean;
}

/**
 * Trip fields in reading order: quantity, time, origin, and destination.
 *
 * A fragment lets compact mode place fields directly in `FormGrid`; expanded mode supplies its
 * own trip-card wrapper.
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
      {/* Either cargo measure is sufficient. The server owns conditional enforcement. */}
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
        // A trip refines only its delivery time; the request continues to own the calendar day.
        <Form.Item
          name={['trips', index, 'scheduledTime']}
          label="Время подачи (МСК)"
          tooltip="Необязательно: пусто — время заявки. Рабочее окно — с 07:00 до 21:00"
          rules={[optionalWorkTimeRule]}
        >
          <TimeInput />
        </Form.Item>
      )}
      {/* Full width keeps long address suggestions readable. */}
      <FormGrid.Full>
        <TripEnd index={index} side="from" saved={saved} suggestObjectIds={suggestObjectIds} />
        <TripEnd index={index} side="to" saved={saved} suggestObjectIds={suggestObjectIds} />
        {detailed && (
          // A trip note carries driver-specific detail that the request-level comment cannot replace.
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
