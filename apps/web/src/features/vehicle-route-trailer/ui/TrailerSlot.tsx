import { Checkbox, Form, Input } from 'antd';
import { FormGrid } from '@shared/ui';
import type { TrailerSlotMode } from '@entities/vehicle-route';
import { TrailerPicker } from './TrailerPicker';

/**
 * One pair of form boxes: the "From directory" checkbox above it and two input modes below (R17).
 *
 * The slots are identical except for the number, so they are one component: otherwise the rule
 * "the box pair switches as a whole" would exist in two copies, and the second trailer would repeat
 * the story of §2 — what was made by copying drifted from the original.
 */
export function TrailerSlot({
  slot,
  mode,
  onMode,
  modelPlaceholder,
  regNumberPlaceholder,
  vehicleId,
  excludeRegNumber,
}: {
  slot: 1 | 2;
  mode: TrailerSlotMode;
  onMode: (mode: TrailerSlotMode) => void;
  modelPlaceholder: string;
  regNumberPlaceholder: string;
  vehicleId?: string | null;
  excludeRegNumber?: string;
}) {
  return (
    <>
      {/* The checkbox stands ABOVE the boxes in its own block, not in the field label: a `<label>`
        inside a `<label>` sends the click into the field — the list would open instead of the
        switch. Same technique for the same reason as the address picker
        (`features/address-input/ui/AddressField.tsx`). */}
      <FormGrid.Full>
        <Checkbox
          checked={mode === 'directory'}
          onChange={(e) => onMode(e.target.checked ? 'directory' : 'manual')}
        >
          Из справочника
        </Checkbox>
      </FormGrid.Full>
      {mode === 'directory' && (
        /* The list takes the whole row: the row label is make, plate and state mark, and at half
           width it is cut exactly at the plate it is read for. */
        <FormGrid.Full>
          <TrailerPicker slot={slot} vehicleId={vehicleId} excludeRegNumber={excludeRegNumber} />
        </FormGrid.Full>
      )}
      {/* The boxes stay form fields in both modes and are only hidden in directory mode — removing
        them from the page would remove them from submission: `onFinish` receives values of
        **registered** fields, not the whole form store (rc-field-form: `validateFields` collects
        `getFieldEntities`). That is exactly how a route once left with half its trailers (§2,
        discrepancy 1), and it must not repeat under a new pretext. Hence also "switching loses
        nothing typed": the field is not replaced by the list, the list fills it. */}
      <Form.Item
        name={`trailer${slot}Model`}
        label={`Прицеп ${slot}: марка`}
        hidden={mode === 'directory'}
      >
        <Input placeholder={modelPlaceholder} />
      </Form.Item>
      <Form.Item
        name={`trailer${slot}RegNumber`}
        label={`Прицеп ${slot}: госномер`}
        hidden={mode === 'directory'}
      >
        <Input placeholder={regNumberPlaceholder} />
      </Form.Item>
    </>
  );
}
