import { useState } from 'react';
import {
  Button,
  Card,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { MAX_ROUTE_REQUESTS, type VehicleRequestTripDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { RequestTripFields } from './RequestTripFields';
import { blankTrip, repeatTrip, type TripFormValue } from '@features/vehicle-request-editor';
import { tripsCountLabel } from '@entities/vehicle-request';

/**
 * Freight-request trip list (`docs/route-trips-plan.md`, section 4.1, stage 6).
 *
 * A one-trip request looks and is filled **exactly as before**: same fields, same order, same grid
 * cells, plus one button below. The list expands on demand because one-trip requests are the
 * majority, and their input must not get harder for the sake of "six from the quarry".
 *
 * Trips live directly in form values (`trips`), not in `Form.List`: nested address and contact
 * controls call the form with full paths, while `Form.List` prefixes only its own `Form.Item`
 * descendants — a nested component knows nothing about that prefix.
 */

interface Props {
  /**
   * Persisted trips for edit mode; `null` means create mode. Rows learn their previous state from
   * them: the display number ("ТС-40/2") and the R2a exemptions for an unverified address and an
   * empty contact.
   */
  savedTrips: readonly VehicleRequestTripDto[] | null;
  /**
   * Whether to show the list. The form decides when the dialog opens: yes for several trips, and
   * for a single trip carrying its own time or note (compact mode does not show them). After that
   * the "+ trip" button raises the flag itself.
   */
  expanded: boolean;
  onExpand: () => void;
  suggestObjectIds: readonly string[];
  cargoRequired: boolean;
}

/** Select stable row keys so list composition can be observed without every field value. */
function tripKeys(values: { trips?: (TripFormValue | undefined)[] }): string[] {
  return (values?.trips ?? []).map((t) => t?.key ?? '');
}

/**
 * Ask how many copies to add in one modal instead of repeating a quantity control in every card,
 * where it could be confused with cargo quantity.
 */
function RepeatModal({
  open,
  max,
  onCancel,
  onOk,
}: {
  open: boolean;
  /** Remaining capacity under `MAX_ROUTE_REQUESTS`. */
  max: number;
  onCancel: () => void;
  onOk: (times: number) => void;
}) {
  const [times, setTimes] = useState(1);
  return (
    <Modal
      title="Повторить ездку"
      open={open}
      okText="Повторить"
      cancelText="Отмена"
      onCancel={onCancel}
      onOk={() => onOk(Math.min(Math.max(times, 1), max))}
      afterClose={() => setTimes(1)}
      width={420}
    >
      <Form layout="vertical">
        <Form.Item
          label="Сколько копий добавить"
          // What a copy carries is said here, not in history: copies have an empty delivery time on
          // purpose (R3) — six trips in a shift follow a schedule, not one moment.
          extra="Адреса, контакты и груз копируются; время подачи у копий остаётся «как у заявки»"
        >
          <InputNumber
            min={1}
            max={max}
            value={times}
            onChange={(v) => setTimes(v ?? 1)}
            style={{ width: '100%' }}
            autoFocus
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function RequestTripsBlock({
  savedTrips,
  expanded,
  onExpand,
  suggestObjectIds,
  cargoRequired,
}: Props) {
  const form = Form.useFormInstance();
  /*
   * Subscribe only to list composition: the returned value is unused, the rerender signal is what
   * matters. Rendering reads the current form value (`rows` below), not the subscription snapshot:
   * it arrives a macrotask later, and in the frame between them the list would show stale rows.
   *
   * A selector over keys rather than watching all of `trips`: `useWatch` compares results by
   * serialization, so the block rerenders on add, repeat and remove — not on every character typed
   * into the sixth trip's address.
   *
   * `preserve` is mandatory: without it the watch sees values of **registered fields only**
   * (`getFieldsValue()` vs `getFieldsValue(true)`), and the row key has no field — nobody shows or
   * edits it. That would loop: a new row is not rendered, so its fields do not exist, so it is
   * absent from the composition, so it never appears.
   */
  Form.useWatch(tripKeys, { form, preserve: true });
  /** Row being repeated; `null` means the modal is closed. */
  const [repeatAt, setRepeatAt] = useState<number | null>(null);

  const savedById = new Map((savedTrips ?? []).map((t) => [t.id, t]));
  /**
   * Read trips from the form at action time.
   *
   * A function, not a render value: the block rerenders only on composition changes, while typing
   * changes form values between rerenders. A handler holding a render snapshot would make "+ trip"
   * pressed after typing an address save the composition together with the erased address.
   */
  const readTrips = () => (form.getFieldValue('trips') ?? []) as TripFormValue[];
  /** Render snapshot; only field contents can change before the next composition rerender. */
  const rows = readTrips();
  const full = rows.length >= MAX_ROUTE_REQUESTS;

  /**
   * Replace list composition atomically.
   *
   * Edited whole, not row by row: removal shifts the neighbours, and their fields move to other
   * paths. Row errors are cleared together with the composition — they would stay on the old paths,
   * i.e. on other rows now, and the person would look for a missing address where it is filled.
   * The rules re-check the list on submit.
   */
  const setTrips = (next: TripFormValue[]) => {
    form.setFieldsValue({ trips: next });
    form.setFields(
      next.flatMap((_row, i) =>
        [
          'fromLocation',
          'toLocation',
          'fromResponsibleName',
          'fromResponsiblePhone',
          'toResponsibleName',
          'toResponsiblePhone',
          'volumeM3',
          'weightTons',
          'scheduledTime',
        ].map((field) => ({ name: ['trips', i, field], errors: [] })),
      ),
    );
  };

  const addTrip = () => {
    setTrips([...readTrips(), blankTrip()]);
    onExpand();
  };

  const removeTrip = (index: number) => {
    setTrips(readTrips().filter((_row, i) => i !== index));
  };

  /** Insert copies next to their source so repeated work remains readable as one group. */
  const applyRepeat = (index: number, times: number) => {
    const current = readTrips();
    const source = current[index];
    if (!source) return;
    setTrips([
      ...current.slice(0, index + 1),
      ...repeatTrip(source, times),
      ...current.slice(index + 1),
    ]);
    setRepeatAt(null);
  };

  // Compact mode: a one-trip request is yesterday's request (R24), with the very same fields.
  if (!expanded && rows.length <= 1) {
    return (
      <>
        <RequestTripFields
          index={0}
          saved={rows[0]?.id ? savedById.get(rows[0].id) : undefined}
          suggestObjectIds={suggestObjectIds}
          cargoRequired={cargoRequired}
          detailed={false}
        />
        <FormGrid.Full>
          <Form.Item>
            <Button icon={<PlusOutlined />} onClick={addTrip}>
              Ездка
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              Одной заявкой можно заказать несколько ездок — например, шесть раз с карьера на объект
            </Typography.Text>
          </Form.Item>
        </FormGrid.Full>
      </>
    );
  }

  return (
    <FormGrid.Full>
      <Form.Item label="Ездки заявки">
        <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
          {rows.map((row, index) => {
            const saved = row.id ? savedById.get(row.id) : undefined;
            return (
              <Card
                key={row.key}
                size="small"
                title={
                  <Space size={8} wrap>
                    {/* Only persisted trips show a number: numbers are never reused (R13a), and
                        "ТС-40/2" on a new row after removing the second would promise what the
                        server will not do. A new row gets its number on save. */}
                    <span>{saved ? saved.displayNumber : 'Новая ездка'}</span>
                    <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
                      строка {index + 1} из {rows.length}
                    </Typography.Text>
                  </Space>
                }
                extra={
                  <Space size={4}>
                    <Tooltip title={full ? `Ездок в заявке не больше ${MAX_ROUTE_REQUESTS}` : null}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        disabled={full}
                        onClick={() => setRepeatAt(index)}
                      >
                        Повторить
                      </Button>
                    </Tooltip>
                    {/* A removed persisted trip is soft-deleted (R13a): an issued waybill may refer
                        to it, and the strict-reporting form journal must remember what was printed.
                        Hence the confirmation, naming the number that will not come back. */}
                    <Popconfirm
                      title={saved ? `Убрать ездку ${saved.displayNumber}?` : 'Убрать ездку?'}
                      description="Она перестанет ехать и печататься, но останется в истории и в журнале листов. Номер за ней сохранится: следующая ездка получит следующий свободный."
                      okText="Убрать"
                      cancelText="Отмена"
                      // An unsaved row has no history to protect, so it needs no confirmation.
                      disabled={!saved}
                      onConfirm={() => removeTrip(index)}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        // At least one trip: a request without trips is an order that does not say
                        // what to carry and where.
                        disabled={rows.length <= 1}
                        onClick={saved ? undefined : () => removeTrip(index)}
                      />
                    </Popconfirm>
                  </Space>
                }
              >
                <FormGrid>
                  <RequestTripFields
                    index={index}
                    saved={saved}
                    suggestObjectIds={suggestObjectIds}
                    cargoRequired={cargoRequired}
                    detailed
                  />
                </FormGrid>
              </Card>
            );
          })}
          <Space size={8} wrap>
            <Button icon={<PlusOutlined />} onClick={addTrip} disabled={full}>
              Ездка
            </Button>
            {/* Row order means nothing: trips are ordered by number, and the visit order belongs
                to the route (R1). Without this line the list reads as a route. */}
            <Typography.Text type="secondary">
              {full
                ? `Ездок в заявке не больше ${MAX_ROUTE_REQUESTS}: заявка едет одним маршрутом целиком`
                : `${tripsCountLabel(rows.length)} · порядок объезда задаёт рейс, здесь — что и куда везти`}
            </Typography.Text>
          </Space>
        </Space>
      </Form.Item>
      <RepeatModal
        open={repeatAt !== null}
        max={MAX_ROUTE_REQUESTS - rows.length}
        onCancel={() => setRepeatAt(null)}
        onOk={(times) => applyRepeat(repeatAt!, times)}
      />
    </FormGrid.Full>
  );
}
