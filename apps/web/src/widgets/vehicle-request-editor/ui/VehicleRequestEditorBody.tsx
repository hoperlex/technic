import { Alert, DatePicker, Form, Input } from 'antd';
import { REQUEST_CUSTOMER_LOCKED_MESSAGE } from '@technic/contracts';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields, TimeInput, optionalWorkTimeRule } from '@entities/request';
import { RequestCustomerSelect } from '@features/request-customer';
import { copyNotice, type FormValues } from '@features/vehicle-request-editor';
import { useIsMobile } from '@shared/lib';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { VehicleRequestEditorState } from '../model/useVehicleRequestEditorState';
import { FileEditor, VehicleClassificationSelect } from './editorFields';
import { RequestRelocationsField } from './RequestRelocationsField';
import { RequestTripsBlock } from './RequestTripsBlock';
import { VehicleBackdateFields } from './VehicleBackdateFields';

interface Props {
  onFinish: (values: FormValues) => void;
  state: VehicleRequestEditorState;
}

export function VehicleRequestEditorBody({ onFinish, state }: Props) {
  const isMobile = useIsMobile();
  return (
    <>
      {/* The copy (ADR 0173, ADR 0206) is announced in the form itself: "по образцу" in the title,
          not "копия", because for a completed request "copy" would promise inherited state the new
          request will not have; the notice says what stays with the source and which term is
          proposed. */}
      {state.copy && !state.record && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          description={copyNotice(state.copy.source, state.copy.minDate, state.copy.today)}
        />
      )}
      <Form form={state.form} layout="vertical" onFinish={onFinish}>
        {/* Fields in pairs (FormGrid): in one column the request form does not fit the screen and
            hides half its fields below the scroll. On a phone there is one column, same order. */}
        <FormGrid>
          {/* Request customer (ADR 0040, R2): sites and departments in one picker, by the account's
              visibility rather than each axis separately. Two fields side by side would mean one
              is empty and nobody knows why; a request has exactly one customer. */}
          <Form.Item
            name="customerKey"
            label="Объект/отдел"
            // The customer changes only while "new" (R7): once in work the cost target has gone as
            // a snapshot into the waybill task, and the server answers such an edit with 422. The
            // text is the server's own, so the field and the refusal say the same thing.
            extra={state.customerLocked ? REQUEST_CUSTOMER_LOCKED_MESSAGE : undefined}
            rules={[{ required: true, message: 'Выберите объект или отдел' }]}
          >
            <RequestCustomerSelect
              options={state.customer.options}
              loading={state.customer.loading}
              disabled={state.customerLocked || state.customer.disabled}
            />
          </Form.Item>
          {/* An existing request changes type by conversion (ADR 0091), where the ordered
              position suits both types. Where it does not, the field is locked and says why. */}
          <Form.Item
            name="requestType"
            label="Тип заявки"
            tooltip="Заказ техники на объект — техника любого вида; грузоперевозка — только грузовая"
            extra={
              state.record ? (state.retypeBlocker ?? 'Смена типа переоформит заявку') : undefined
            }
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <AutoSelect
              options={state.formRequestTypeOptions}
              placeholder="Выберите тип заявки"
              // Locked when conversion is impossible and when the role has a single type: the field
              // must not promise a choice that does not exist.
              disabled={
                (!!state.record && !state.canRetype) || state.requestTypeOptions.length === 1
              }
              onChange={state.handleRequestTypeChange}
            />
          </Form.Item>
          {/* The classifier position spans the full width: labels like "Truck cranes, 130 t" get
              truncated in half the dialog exactly where one differs from another. */}
          <FormGrid.Full>
            <VehicleClassificationSelect
              groups={state.typeGroups}
              loading={state.typesLoading}
              disabled={!state.requestType}
              placeholder={
                state.requestType ? 'Выберите тип или категорию' : 'Сначала выберите тип заявки'
              }
            />
          </FormGrid.Full>

          {/* On-site equipment: the work term. The earliest available day depends on who creates
              the request (ADR 0104): a requester gets tomorrow, after 15:00 the day after; whoever
              runs the orders gets today in Moscow time. The dates are adjacent grid cells: the
              "start — end" pair reads together. */}
          {state.isSpecial && (
            <>
              <Form.Item
                name="dateFrom"
                label="Дата начала"
                tooltip={state.leadTimeHint}
                rules={[{ required: true, message: 'Укажите дату начала' }]}
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  disabledDate={state.minDateRule}
                />
              </Form.Item>
              <Form.Item
                name="dateTo"
                label="Дата окончания"
                // The day count (how long the equipment is busy on site) is the hint under the
                // field: the two-column grid has no room for a separate column. For a running
                // request the same place says how the term is shortened: not by an edit (ADR 0044).
                extra={
                  state.dateToLocked
                    ? 'Срок работающей техники сокращают досрочным завершением — с визой'
                    : state.periodHint
                }
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  // Extending by an edit stays, shortening does not: the server checks the same
                  // rule, and the portal must not offer a date it will reject.
                  disabledDate={
                    state.dateToLocked ? state.isBeforeCurrentDateTo : state.minDateRule
                  }
                />
              </Form.Item>
              {/* Backdating (ADR 0101): the reason and the cost of the edit right under the dates
                  that caused it, not at the end of the form. No block until the term goes into
                  the past. */}
              {state.backdated && state.effectiveDateKey && (
                <FormGrid.Full>
                  <VehicleBackdateFields
                    record={state.record}
                    next={state.formCalendar}
                    effectiveDate={state.effectiveDateKey}
                  />
                </FormGrid.Full>
              )}
              {/* Who meets the equipment on site: without a contact, the entry and work spot are
                  sorted out by calls through the dispatcher already at the gate. */}
              <FormGrid.Full>
                <ResponsibleFields
                  nameField="responsibleName"
                  phoneField="responsiblePhone"
                  nameLabel="Ответственный на объекте"
                  phoneLabel="Контактный телефон"
                  phoneInput={PhoneInput}
                />
              </FormGrid.Full>
              {/* 4-P relocations of a running request: delivery to the site and pickup from it.
                  Edited here because this is where they are remembered — on opening the request
                  whose equipment was moved differently than planned. A new request has no block:
                  the relocation drives the assigned vehicle, which is not chosen yet. */}
              {state.relocationsEditable && state.record && (
                <FormGrid.Full>
                  <Form.Item label="Перегон техники (4-П)">
                    <RequestRelocationsField request={state.record} />
                  </Form.Item>
                </FormGrid.Full>
              )}
            </>
          )}

          {state.isFreight && (
            <>
              <Form.Item
                name="scheduledDate"
                label="Дата подачи"
                tooltip={state.leadTimeHint}
                rules={[{ required: true, message: 'Укажите дату' }]}
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  disabledDate={state.minDateRule}
                />
              </Form.Item>
              <Form.Item
                name="scheduledTime"
                label="Время (МСК)"
                tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
                rules={[optionalWorkTimeRule]}
              >
                <TimeInput />
              </Form.Item>
              {/* Backdating (ADR 0101) with the same block as the on-site order: the rule is one
                  for both request types, only the date it is computed by differs. */}
              {state.backdated && state.effectiveDateKey && (
                <FormGrid.Full>
                  <VehicleBackdateFields
                    record={state.record}
                    next={state.formCalendar}
                    effectiveDate={state.effectiveDateKey}
                  />
                </FormGrid.Full>
              )}
              {/* Request trips (§4.1): cargo, addresses and contacts of both ends. With one trip
                  the block looks and fills exactly like the pre-plan form — same fields in the same
                  grid cells; it expands into a list with "+ trip" and "repeat N times" when
                  asked. */}
              <RequestTripsBlock
                savedTrips={state.recordTrips}
                expanded={state.tripsExpanded}
                onExpand={() => state.setTripsExpanded(true)}
                suggestObjectIds={state.suggestObjectIds}
                cargoRequired={state.cargoRequired}
              />
            </>
          )}

          <FormGrid.Full>
            <Form.Item name="comment" label={state.commentHint?.label ?? 'Комментарий'}>
              <Input.TextArea
                rows={3}
                maxLength={2000}
                placeholder={state.commentHint?.placeholder}
              />
            </Form.Item>
            <Form.Item label="Файлы">
              <FileEditor editor={state.editor} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </>
  );
}
