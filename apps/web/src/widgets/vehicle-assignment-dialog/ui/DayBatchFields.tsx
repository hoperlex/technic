import { useEffect } from 'react';
import { Alert, Checkbox, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleStatusLabels } from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { AutoSelect, FormGrid } from '@shared/ui';
import {
  dayBatchModel,
  driverOption,
  type DayBatchFormValues,
  type DayBatchMachinist,
  type DayBatchTerm,
} from '@features/vehicle-assignment';
import { formatDateOnly } from '@shared/lib';

/**
 * Fields of the "4-P for the whole period" batch (ADR 0207): who drives for the whole term and how
 * past days are explained.
 *
 * Separate from both dialogs that show it, on the same border that keeps `TrailerFields` apart from
 * the route form: the dialogs differ — one takes the request into work, the other collects missed
 * days of a running order — but the question is the same and must not diverge. If the two blocks
 * differed even by a field label, the dispatcher would read two stories about one action in
 * neighbouring dialogs.
 *
 * **There is no vehicle here, and that is a decision, not an omission** (ADR 0207 decision 5). The
 * batch takes it from the request's assignment: a free choice would spread the paper over two
 * vehicles in a way that neither the garage, the "On site" view nor ESM-2 would show. Another unit
 * for a single day is set through the per-day door, where the divergence from the assignment is
 * marked right in the table.
 *
 * The driver, on the contrary, is asked and required: no waybill is issued without a person. One
 * person for the whole period is a named concession of
 * [ADR 0083](../../../../../../docs/adr/0083-no-autofill-dates-and-drivers.md): asking for a person
 * one by one for fifty days means having no batch. A Saturday substitute stays legal and is set
 * through the per-day door.
 */

/**
 * The driver's category warning must reflect the trailer state that the batch prints. The query
 * key and request must agree so the two batch dialogs share one selection.
 */
const driversKey = (vehicleId: string | undefined, date: string, withTrailer: boolean) =>
  driverKeys.available({ vehicleId, on: date, withTrailer });

interface Props {
  /**
   * The term the batch runs on, exactly as it goes to the server. In the take-into-work dialog this
   * is the **actual** term from the form, not the ordered one: it is edited right there, and
   * counting days by the ordered term would promise paper for the wrong dates.
   */
  term: DayBatchTerm;
  /**
   * The cut-off day: it decides whether the term has past days and hence whether to ask for a
   * reason (ADR 0101 item 4). For the days table the server computes it (`onDate`); the
   * take-into-work dialog has nowhere to take it from — the request day does not exist yet there —
   * so the portal computes the cut-off by the Moscow calendar itself. `backdateGuard` has the final
   * word: the server asks for a reason itself if the portal missed midnight.
   */
  onDate: string;
  /** The vehicle of the waybills: drivers are selected by it — exactly as in the per-day dialog. */
  vehicleId: string | undefined;
  /**
   * The request machinist: the field's default (ADR 0207 decision 6) and the side the choice is
   * compared with. `null` — the portal does not know them: there is nobody to fill in and nothing
   * to name a divergence against.
   */
  machinist: DayBatchMachinist | null;
  /**
   * Whether the block is asked now: in the take-into-work dialog by the checkbox, in the batch
   * dialog always.
   */
  enabled: boolean;
  /**
   * The checkbox that enables the block; `null` — the dialog is the batch itself ("Plan the period"
   * button), and there is nothing to enable. The label comes from outside: in the take-into-work
   * dialog the checkbox is about the whole period at once, in the batch dialog only about paper.
   */
  toggleLabel: string | null;
}

export function DayBatchFields({
  term,
  onDate,
  vehicleId,
  machinist,
  enabled,
  toggleLabel,
}: Props) {
  const form = Form.useFormInstance<DayBatchFormValues>();
  const driverId = Form.useWatch('dayBatchDriverId', form);
  const hasCurrentDays = !term.dateTo || term.dateTo >= onDate;
  const trailerDate = term.dateFrom < onDate ? onDate : term.dateFrom;
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, trailerDate),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: trailerDate }),
    enabled: enabled && hasCurrentDays && !!vehicleId && !!trailerDate,
  });
  const hitched = suggestion?.hitched ?? [];
  const withTrailer = hasCurrentDays && hitched.length > 0;
  const unavailableTrailers = hitched.filter((trailer) => trailer.status !== 'active');
  const trailerWarning = unavailableTrailers.length
    ? ` Проверьте состояние: ${unavailableTrailers
        .map(
          (trailer) =>
            `${trailer.registrationNumber} — «${vehicleStatusLabels[trailer.status].toLowerCase()}»`,
        )
        .join(', ')}.`
    : '';

  /**
   * Drivers — with the same query and selection as the per-day dialog: an order day is printed on
   * an ordinary 4-P with the same licence and SNILS boxes. The selection date is the first day of
   * the term: document validity is checked for one day, while the batch has one person; a licence
   * expiring inside the period will be shown by the waybill itself. The trailer flag describes the
   * current and future days that receive the registry hitch.
   */
  const { data: selection, isFetching } = useQuery({
    queryKey: driversKey(vehicleId, term.dateFrom, withTrailer),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: term.dateFrom, withTrailer }),
    enabled: enabled && !!vehicleId && !!term.dateFrom,
  });
  const options = (selection?.drivers ?? []).map(driverOption);

  /**
   * Whether this list names the request machinist. The lists differ: machinists come from the whole
   * directory (ESM-2 has no licence boxes), while day drivers are selected for the vehicle on the
   * first day of the term, and a person whose driver specialization was not active that day, or
   * whose card was removed, is not in it at all.
   */
  const model = dayBatchModel({
    term,
    onDate,
    machinist,
    driverOptions: options,
    driverSelectionReady: !!selection,
    driverId,
  });

  // ADR 0207 explicitly allows one autofill here: the request machinist is the batch driver only
  // when the date-specific selection still contains that person. A manual choice always wins.
  useEffect(() => {
    if (!enabled || !model.defaultDriverId) return;
    if (form.getFieldValue('dayBatchDriverId')) return;
    form.setFieldsValue({ dayBatchDriverId: model.defaultDriverId });
  }, [enabled, model.defaultDriverId, form]);

  return (
    <>
      {toggleLabel ? (
        <FormGrid.Full>
          <Form.Item name="dayBatchEnabled" valuePropName="checked" noStyle>
            <Checkbox>{toggleLabel}</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {/* The tail about skipped days is shared by both cases: the batch skips the same way
              whether the term fits one portion or goes in parts. */}
            {model.portionHint ??
              `Каждый день срока (${model.days.length} дн.) встанет в рейс назначенной машины, и по рейсу выпишется путевой лист.`}{' '}
            Дни, которые уже заняты своим рейсом или закрыты бумагой, пачка пропустит и назовёт в
            отчёте.
          </Typography.Paragraph>
        </FormGrid.Full>
      ) : (
        // The batch dialog has no checkbox, but the portion still has to be named: otherwise the
        // dispatcher would learn about the uncollected tail of the term only from the report.
        model.portionHint && (
          <FormGrid.Full>
            <Alert type="info" showIcon title={model.portionHint} />
          </FormGrid.Full>
        )
      )}

      {enabled && (
        <>
          {withTrailer && (
            <FormGrid.Full>
              <Alert
                type={unavailableTrailers.length ? 'warning' : 'info'}
                showIcon
                title="Закреплённые прицепы попадут в новые рейсы"
                description={`${hitched.map((trailer) => `${trailer.model} ${trailer.registrationNumber}`).join(' · ')}. Пачка возьмёт привязку из справочника для сегодняшних и будущих дней; для прошедших дней её восстановить нельзя.${trailerWarning}`}
              />
            </FormGrid.Full>
          )}
          <FormGrid.Full>
            <Form.Item
              name="dayBatchDriverId"
              label="Водитель на весь период"
              rules={[{ required: true, message: 'Выберите водителя — без него лист не выписать' }]}
              extra={
                vehicleId
                  ? 'Один человек на все дни срока: пачка выписывает бумаги, а не ведёт график смен. Подмену на отдельный день ставят в таблице «Дни работ».'
                  : 'Сначала выберите технику: годность документов считается под машину'
              }
            >
              <AutoSelect
                autoSelectSole={false}
                options={options}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={!vehicleId}
                placeholder="Кто поедет весь срок"
                notFoundContent="Подходящих водителей на этот день нет"
              />
            </Form.Item>
          </FormGrid.Full>

          {model.machinistNote && (
            <FormGrid.Full>
              <Alert type="info" showIcon title={model.machinistNote} />
            </FormGrid.Full>
          )}

          {/* Past days go as one corrections-journal operation (ADR 0207 §9), so the reason is one:
            it explains the decision to paper the past period, not each day separately. The same
            reason is printed on every such waybill. */}
          {model.pastDays.length > 0 && (
            <FormGrid.Full>
              <Form.Item
                name="dayBatchReason"
                label="Причина заднего числа"
                // Required by the server (`backdateGuard` answers 422), so required here too: the
                // form must not send a body that is bound to be refused. `whitespace` matters
                // because `useDayBatch` trims the reason and drops it when empty — a reason of
                // spaces would pass a bare `required` and reach the server as no reason at all.
                rules={[{ required: true, whitespace: true, message: 'Укажите причину' }]}
                extra={`В сроке ${model.pastDays.length} дн. до ${formatDateOnly(onDate)}: они пройдут одной операцией журнала коррекций — с вашим именем и этой причиной в каждом листе`}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Например: техника отработала период, документы оформляем по факту"
                />
              </Form.Item>
            </FormGrid.Full>
          )}
        </>
      )}
    </>
  );
}
