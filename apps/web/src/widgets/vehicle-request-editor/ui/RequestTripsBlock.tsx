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
 * Freight-request trip list (`docs/route-trips-plan.md`, section 4.1).
 *
 * Single-trip requests retain the compact field layout. The list expands only when needed so the
 * common case does not pay the interaction cost of multi-trip ordering.
 *
 * Trips live directly in form values because nested address and contact controls need full paths;
 * `Form.List` prefixes only its own `Form.Item` descendants.
 */

interface Props {
  /**
   * Persisted trips for edit mode; `null` means create mode. Rows use them for stable display
   * numbers and narrowly scoped legacy validation exemptions.
   */
  savedTrips: readonly VehicleRequestTripDto[] | null;
  /**
   * Expanded mode is selected for multiple trips or details compact mode would hide, and remains
   * enabled after the user adds a trip.
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
          // Explain the reset here: repeated trips should not claim identical delivery times.
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
   * Subscribe only to list composition. Rendering reads the current form value because the watch
   * notification arrives later and its snapshot could briefly show stale rows.
   *
   * Selecting keys avoids rerendering the whole block for every character typed into a trip.
   *
   * `preserve` includes client keys that have no rendered field. Without them a new row would not
   * be observable until rendered, while rendering itself depends on observing the row.
   */
  Form.useWatch(tripKeys, { form, preserve: true });
  /** Row being repeated; `null` means the modal is closed. */
  const [repeatAt, setRepeatAt] = useState<number | null>(null);

  const savedById = new Map((savedTrips ?? []).map((t) => [t.id, t]));
  /**
   * Read trips from the form at action time.
   *
   * The block rerenders only for composition changes, so handlers must not capture field values
   * from an older render and overwrite text entered since then.
   */
  const readTrips = () => (form.getFieldValue('trips') ?? []) as TripFormValue[];
  /** Render snapshot; only field contents can change before the next composition rerender. */
  const rows = readTrips();
  const full = rows.length >= MAX_ROUTE_REQUESTS;

  /**
   * Replace list composition atomically.
   *
   * Removing a row shifts all following field paths. Clear path-bound errors at the same time so
   * they cannot become attached to a different trip; submission validates the new list again.
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

  // Compact mode preserves the established single-trip form.
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
                    {/* Only persisted trips have display numbers; numbers are never reused, so a
                        new row must wait for the server-assigned value. */}
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
                    {/* Persisted trips are soft-deleted because issued forms may reference them.
                        Confirm the action and explain that the display number remains reserved. */}
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
                        // A freight request must retain at least one origin-destination pair.
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
            {/* Row order is not route order; routing owns the actual visit sequence. */}
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
