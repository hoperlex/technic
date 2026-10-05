import type { ReactNode } from 'react';
import { Form, Select, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  trailerTitle,
  type VehicleTrailerDto,
  vehicleStatusColors,
  vehicleStatusLabels,
} from '@technic/contracts';
import { foreignHitchWarning, TRAILER_DIRECTORY_HINT } from '@entities/vehicle-route';
import { trailerPickerQuery } from '@entities/vehicle-trailer';

/**
 * Choosing a trailer from the registry for one pair of route boxes
 * (`docs/vehicle-trailers-plan.md`, §13).
 *
 * **Choosing is not hitching (R18).** The list puts make and plate into the same text boxes a
 * person would type, and does nothing else: the directory does not change from a route. Hitching
 * lives in the trailer card and means "stands with this vehicle permanently", while a route choice
 * means "today we go with this one". Otherwise one trip with someone else's semi-trailer would
 * silently rewrite the registry.
 *
 * Hence the field's design: it has no value of its own in the form — the value is **derived** from
 * the boxes by matching the plate with the registry (R17, item 3). So switching modes loses
 * nothing, and editing the boxes by hand cannot diverge from the shown choice: there is nothing to
 * show but what the boxes hold.
 *
 * A file of its own, not inside `TrailerFields`: the box block is shared by five dialogs, and a
 * searchable list with state marks and a warning is a separate concern from the boxes themselves.
 */
export function TrailerPicker({
  slot,
  vehicleId,
  excludeRegNumber,
}: {
  /**
   * Box pair of the 4-P form: 1 — first, 2 — second. It also names the form fields and the label.
   */
  slot: 1 | 2;
  /**
   * The route's vehicle: the chosen trailer's hitch is checked against it. Someone else's — a
   * warning (R19); its own — the ordinary case, exactly what the portal fills in.
   */
  vehicleId?: string | null;
  /**
   * The trailer plate from the neighbouring box: one unit does not stand in two slots at once, and
   * the second slot does not offer what is already chosen in the first (§13.6).
   */
  excludeRegNumber?: string;
}) {
  const form = Form.useFormInstance();
  const modelField = `trailer${slot}Model`;
  const regField = `trailer${slot}RegNumber`;
  // An ordinary watch: the boxes stay form fields in this mode too — `TrailerFields` hides them
  // rather than removing them, otherwise the choice would reach neither this display nor the body.
  const model = Form.useWatch<string | undefined>(modelField, form);
  const regNumber = Form.useWatch<string | undefined>(regField, form);

  const { data, isFetching, isError } = useQuery(trailerPickerQuery());
  const trailers = data ?? [];

  /**
   * What the boxes hold — as a list row. The plate is compared without spaces and case: the form
   * prints it in different ways ("АВ1234 77" and "ав123477" are one trailer), and the boxes are
   * filled both by hand and by defaults.
   */
  const regKey = squash(regNumber);
  const picked = regKey ? trailers.find((t) => squash(t.registrationNumber) === regKey) : undefined;
  const typedTitle = trailerTitle({
    model: model ?? '',
    registrationNumber: regNumber ?? '',
  });

  const excluded = squash(excludeRegNumber);
  const options: PickerEntry[] = trailers
    // An own choice does not fall out of the selection: if both boxes hold the same (inheritance or
    // someone's edit), the field must show what is there, not go empty.
    .filter((t) => !excluded || t.id === picked?.id || squash(t.registrationNumber) !== excluded)
    .map((t) => ({ value: t.id, label: rowOf(t), search: squash(trailerTitle(t)) }));

  /*
   * Boxes with no registry record are shown by the field as they are — in their own group.
   * Otherwise a ticked checkbox would look as if it erased what was typed: text stays in the boxes
   * while the field is empty. A written-off trailer lands here too — absent from the list, yet
   * legal in the route boxes (R11).
   */
  if (!picked && typedTitle) {
    options.push({
      label: TYPED_GROUP_LABEL,
      options: [{ value: TYPED_VALUE, label: typedTitle, search: squash(typedTitle) }],
    });
  }

  const warning = foreignHitchWarning(picked, vehicleId);

  /*
   * The label is bound to the field by hand: `Form.Item` sets `htmlFor` itself from `name`, and the
   * list has no `name` and cannot have one (it holds no value of its own, see above). Without this
   * pair a click on the label leads nowhere and a screen reader reads the field as unnamed.
   */
  const controlId = `trailer${slot}Picker`;

  return (
    <Form.Item
      label={`Прицеп ${slot}`}
      htmlFor={controlId}
      // The hint explains what is in the list and what choosing from it does not do — the same way
      // the address directory picker explains itself (ADR 0069). The warning stands below it: it
      // concerns the chosen row, not the list, and the field may not stay silent about it (R19).
      extra={
        <>
          {TRAILER_DIRECTORY_HINT}
          {warning && (
            <div>
              <Typography.Text type="warning">{warning}</Typography.Text>
            </div>
          )}
        </>
      }
    >
      <Select
        id={controlId}
        value={picked?.id ?? (typedTitle ? TYPED_VALUE : undefined)}
        options={options}
        showSearch
        // The row label is a node with a state mark, and filtering by it would compare markup. So
        // the search runs over its own string: make and plate together, without spaces and case.
        filterOption={(input, option) => {
          const needle = squash(input);
          return !needle || (option?.search ?? '').includes(needle);
        }}
        onChange={(id: string) => {
          const t = trailers.find((x) => x.id === id);
          // "Typed into the boxes" is pointless to choose: it is exactly what the boxes hold.
          if (!t) return;
          form.setFieldsValue({ [modelField]: t.model, [regField]: t.registrationNumber });
        }}
        loading={isFetching}
        style={{ width: '100%' }}
        placeholder="Выберите прицеп из реестра"
        // An empty list and a failed request are different answers: "nothing found" in place of the
        // second would read as an empty registry, and the person would untick the box instead of
        // retrying.
        notFoundContent={
          isError
            ? 'Не удалось загрузить реестр прицепов'
            : isFetching
              ? 'Загружаем реестр…'
              : 'Ничего не нашлось'
        }
      />
    </Form.Item>
  );
}

/**
 * Value of the "typed into the boxes" row: it cannot be an id — the registry has no such record.
 */
const TYPED_VALUE = '__typed__';

/** Group label for hand-typed values — it also explains why the row stands apart. */
const TYPED_GROUP_LABEL = 'Вписано в графы';

interface PickerOption {
  value: string;
  label: ReactNode;
  /** What is searched: make and plate as one string, normalised for comparison. */
  search: string;
}

/**
 * A list group — today there is one: the row typed into the boxes by hand. `search` is declared
 * here too because the list filter receives the item as is: without a shared field, accessing it in
 * `filterOption` would need a type cast, i.e. a promise nobody checks.
 */
interface PickerGroup {
  label: string;
  options: PickerOption[];
  search?: undefined;
}

type PickerEntry = PickerOption | PickerGroup;

/** Plate and make for comparison: case and spaces in a form box mean nothing. */
function squash(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * A list row: the same label the trailer has in the registry and under the boxes (`trailerTitle`),
 * plus its state if not operational.
 *
 * A trailer under maintenance is offered **with a mark** (§4.2.3): it is hitched and legally goes
 * out, but such a trip is planned consciously. The operational state stays silent — with a mark on
 * every row, the one under repair would go unnoticed.
 */
function rowOf(t: VehicleTrailerDto): ReactNode {
  return (
    <Space size={8} wrap>
      <span>{trailerTitle(t)}</span>
      {t.status !== 'active' && (
        <Tag color={vehicleStatusColors[t.status]} style={{ marginInlineEnd: 0 }}>
          {vehicleStatusLabels[t.status]}
        </Tag>
      )}
    </Space>
  );
}
